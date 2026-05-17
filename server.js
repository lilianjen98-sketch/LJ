const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const XLSX = require('xlsx');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ===== MongoDB Connection (serverless-friendly caching) =====
let isConnected = false;
async function connectDB() {
  if (isConnected && mongoose.connection.readyState === 1) return;
  await mongoose.connect(process.env.MONGODB_URI, { dbName: 'b26budget' });
  isConnected = true;
}
app.use(async (req, res, next) => {
  try { await connectDB(); next(); }
  catch (err) { res.status(500).json({ error: 'DB connection failed: ' + err.message }); }
});

// ===== MongoDB Models =====
const userSchema = new mongoose.Schema({
  username:    { type: String, required: true, unique: true },
  password:    { type: String, required: true },
  displayName: { type: String, required: true },
  email:       { type: String, default: '' },
  role:        { type: String, enum: ['admin', 'manager', 'staff'], default: 'staff' },
  department:  { type: String, default: '' },
  isActive:    { type: Boolean, default: true }
});
const User = mongoose.model('User', userSchema);

const budgetSchema = new mongoose.Schema({
  fiscalYear:  Number,
  department:  String,
  brand:       String,
  glCode:      String,
  glName:      String,
  month:       { type: Number, min: 1, max: 12 },
  amount:      { type: Number, default: 0 }
});
budgetSchema.index({ fiscalYear: 1, department: 1, brand: 1, glCode: 1, month: 1 }, { unique: true });
const Budget = mongoose.model('Budget', budgetSchema);

const expenseSchema = new mongoose.Schema({
  date:        Date,
  fiscalYear:  Number,
  department:  String,
  brand:       String,
  glCode:      String,
  glName:      String,
  month:       Number,
  quarter:     Number,
  amountExTax: { type: Number, default: 0 },
  amountInTax: { type: Number, default: 0 },
  description: { type: String, default: '' },
  migoNo:      { type: String, default: '' },
  prNo:        { type: String, default: '' },
  notes:       { type: String, default: '' },
  createdBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdAt:   { type: Date, default: Date.now }
});
const Expense = mongoose.model('Expense', expenseSchema);

// ===== Auth Middleware =====
function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: '請先登入' });
  try {
    req.user = jwt.verify(h.split(' ')[1], process.env.JWT_SECRET);
    next();
  } catch { return res.status(401).json({ error: '登入已過期' }); }
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '權限不足' });
  next();
}

function deptFilter(req) {
  if (req.user.role === 'staff') return { department: req.user.department };
  return {};
}

// ===== Upload Setup (memory storage for Vercel) =====
const upload = multer({ storage: multer.memoryStorage() });

// ===== CSV/Excel Parser (accepts buffer for Vercel) =====
function parseFile(bufferOrPath) {
  const wb = Buffer.isBuffer(bufferOrPath)
    ? XLSX.read(bufferOrPath)
    : XLSX.readFile(bufferOrPath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  const results = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length < 5) continue;
    const dept = String(row[0]).trim();
    if (!dept || dept.includes('部門')) continue;

    const brand = String(row[1] || '').trim();
    const glRaw = String(row[2] || '').trim();
    const monthCell = row[3];
    const amtRaw = row[4];

    const spaceIdx = glRaw.indexOf(' ');
    const glCode = spaceIdx > 0 ? glRaw.substring(0, spaceIdx) : glRaw;
    const glName = spaceIdx > 0 ? glRaw.substring(spaceIdx + 1) : glRaw;

    let fiscalYear, month;
    if (typeof monthCell === 'number') {
      const d = new Date(Math.round((monthCell - 25569) * 86400000));
      fiscalYear = d.getUTCFullYear();
      month = d.getUTCMonth() + 1;
    } else {
      const mMatch = String(monthCell || '').trim().match(/(\d{4})\/(\d{1,2})/);
      if (!mMatch) continue;
      fiscalYear = parseInt(mMatch[1]);
      month = parseInt(mMatch[2]);
    }
    if (month < 1 || month > 12) continue;

    let amount = 0;
    if (typeof amtRaw === 'number') {
      amount = amtRaw;
    } else {
      const cleaned = String(amtRaw || '').replace(/[,\s"]/g, '').replace(/^-+$/, '0');
      amount = parseFloat(cleaned) || 0;
    }

    results.push({ fiscalYear, department: dept, brand, glCode, glName, month, amount });
  }
  return results;
}

// ===== Carryover Logic =====
function calcCarryover(budgetByMonth, usedByMonth) {
  const result = [];
  const quarters = [[1,2,3],[4,5,6],[7,8,9],[10,11,12]];
  for (const qMonths of quarters) {
    let carry = 0;
    for (const m of qMonths) {
      const budget = budgetByMonth[m] || 0;
      const used = usedByMonth[m] || 0;
      const available = budget + carry - used;
      result.push({ month: m, budget, carryIn: carry, used, available });
      carry = Math.max(0, available);
    }
  }
  return result;
}

// ===== Email Notifier =====
const notifiedSet = new Set();
async function checkAndNotify(fiscalYear, department, brand, glCode, glName, quarter) {
  if (!process.env.SMTP_USER) return;
  const qStart = (quarter - 1) * 3 + 1;
  const months = [qStart, qStart + 1, qStart + 2];
  const [budgetAgg, expenseAgg] = await Promise.all([
    Budget.aggregate([{ $match: { fiscalYear, department, brand, glCode, month: { $in: months } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    Expense.aggregate([{ $match: { fiscalYear, department, brand, glCode, month: { $in: months } } }, { $group: { _id: null, total: { $sum: '$amountInTax' } } }])
  ]);
  const totalBudget = budgetAgg[0]?.total || 0;
  const totalUsed = expenseAgg[0]?.total || 0;
  if (totalBudget <= 0) return;
  const rate = Math.round((totalUsed / totalBudget) * 1000) / 10;
  const levels = [];
  if (rate >= 100) levels.push('100');
  else if (rate >= 80) levels.push('80');
  for (const level of levels) {
    const key = `${fiscalYear}-${department}-${brand}-${glCode}-Q${quarter}-${level}`;
    if (notifiedSet.has(key)) continue;
    notifiedSet.add(key);
    try {
      const transporter = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: process.env.SMTP_PORT, secure: false, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
      const recipients = await User.find({ isActive: true, $or: [{ role: 'admin' }, { role: 'manager' }, { role: 'staff', department }] }).select('email');
      const emails = recipients.map(u => u.email).filter(Boolean).join(',');
      if (!emails) continue;
      const icon = level === '100' ? '🚨' : '⚠️';
      await transporter.sendMail({ from: process.env.SMTP_USER, to: emails, subject: `[B26預算系統] ${icon} ${department}/${brand} ${glCode} Q${quarter} 使用率 ${rate}%`, text: `部門：${department}\n品牌：${brand}\nGL科目：${glCode} ${glName}\n季度：${fiscalYear} Q${quarter}\n季度預算：${totalBudget.toLocaleString()}\n已使用：${totalUsed.toLocaleString()}\n使用率：${rate}%` });
    } catch (err) { console.error('Email error:', err.message); }
  }
}

// ==================== API Routes ====================

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username, isActive: true });
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: '帳號或密碼錯誤' });
    const token = jwt.sign({ userId: user._id, username: user.username, role: user.role, department: user.department, displayName: user.displayName }, process.env.JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, user: { displayName: user.displayName, role: user.role, department: user.department } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/change-password', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user || !(await bcrypt.compare(req.body.oldPassword, user.password))) return res.status(400).json({ error: '舊密碼不正確' });
    user.password = await bcrypt.hash(req.body.newPassword, 10);
    await user.save();
    res.json({ message: '密碼已更新' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/users', auth, adminOnly, async (req, res) => {
  const users = await User.find().select('-password').sort('username');
  res.json(users);
});

app.post('/api/users', auth, adminOnly, async (req, res) => {
  try {
    const { username, password, displayName, email, role, department } = req.body;
    const hash = await bcrypt.hash(password, 10);
    const user = await User.create({ username, password: hash, displayName, email, role, department });
    res.json({ message: '已建立使用者', user: { _id: user._id, username, displayName, role, department } });
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ error: '帳號已存在' });
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/users/:id', auth, adminOnly, async (req, res) => {
  try {
    const updates = { ...req.body };
    if (updates.password) updates.password = await bcrypt.hash(updates.password, 10);
    await User.findByIdAndUpdate(req.params.id, updates);
    res.json({ message: '已更新' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/users/:id', auth, adminOnly, async (req, res) => {
  await User.findByIdAndUpdate(req.params.id, { isActive: false });
  res.json({ message: '已停用' });
});

app.get('/api/users/:id/expenses', auth, adminOnly, async (req, res) => {
  try {
    const year = parseInt(req.query.year) || 2026;
    const expenses = await Expense.find({ createdBy: req.params.id, fiscalYear: year }).sort('-date -createdAt').limit(200).lean();
    const total = expenses.reduce((s, e) => s + (e.amountInTax || 0), 0);
    res.json({ expenses, total });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/budgets/upload', auth, upload.single('file'), async (req, res) => {
  if (req.user.role === 'staff') return res.status(403).json({ error: '權限不足' });
  try {
    const items = parseFile(req.file.buffer);
    const ops = items.map(item => ({ updateOne: { filter: { fiscalYear: item.fiscalYear, department: item.department, brand: item.brand, glCode: item.glCode, month: item.month }, update: { $set: item }, upsert: true } }));
    await Budget.bulkWrite(ops);
    res.json({ message: `成功匯入 ${items.length} 筆預算資料`, count: items.length });
  } catch (err) { res.status(500).json({ error: '匯入失敗: ' + err.message }); }
});

app.get('/api/budgets/tree', auth, async (req, res) => {
  try {
    const year = parseInt(req.query.year) || 2026;
    const filter = { fiscalYear: year, ...deptFilter(req) };
    const [budgets, expenses] = await Promise.all([Budget.find(filter).lean(), Expense.find(filter).lean()]);
    const bMap = {};
    for (const b of budgets) {
      const key = `${b.department}|${b.brand}|${b.glCode}`;
      if (!bMap[key]) bMap[key] = { department: b.department, brand: b.brand, glCode: b.glCode, glName: b.glName, months: {} };
      bMap[key].months[b.month] = (bMap[key].months[b.month] || 0) + b.amount;
    }
    const eMap = {};
    for (const e of expenses) {
      const key = `${e.department}|${e.brand}|${e.glCode}`;
      if (!eMap[key]) eMap[key] = {};
      eMap[key][e.month] = (eMap[key][e.month] || 0) + e.amountInTax;
    }
    const tree = {};
    for (const [key, item] of Object.entries(bMap)) {
      const usedByMonth = eMap[key] || {};
      const months = calcCarryover(item.months, usedByMonth);
      const totalBudget = months.reduce((s, m) => s + m.budget, 0);
      const totalUsed = months.reduce((s, m) => s + m.used, 0);
      const totalCarryIn = months.reduce((s, m) => s + m.carryIn, 0);
      if (!tree[item.department]) tree[item.department] = {};
      if (!tree[item.department][item.brand]) tree[item.department][item.brand] = {};
      tree[item.department][item.brand][item.glCode] = { glName: item.glName, months, budget: totalBudget, used: totalUsed, carryIn: totalCarryIn, available: totalBudget - totalUsed, rate: totalBudget > 0 ? Math.round((totalUsed / totalBudget) * 100) : 0 };
    }
    res.json(tree);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/budgets/summary', auth, async (req, res) => {
  try {
    const year = parseInt(req.query.year) || 2026;
    const filter = { fiscalYear: year, ...deptFilter(req) };
    const [bAgg, eAgg] = await Promise.all([
      Budget.aggregate([{ $match: filter }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
      Expense.aggregate([{ $match: filter }, { $group: { _id: null, total: { $sum: '$amountInTax' } } }])
    ]);
    const totalBudget = bAgg[0]?.total || 0;
    const totalUsed = eAgg[0]?.total || 0;
    res.json({ totalBudget, totalUsed, remaining: totalBudget - totalUsed, rate: totalBudget > 0 ? Math.round((totalUsed / totalBudget) * 100) : 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/expenses', auth, async (req, res) => {
  try {
    const year = parseInt(req.query.year) || 2026;
    const filter = { fiscalYear: year, ...deptFilter(req) };
    if (req.query.month) filter.month = parseInt(req.query.month);
    if (req.query.department && req.user.role !== 'staff') filter.department = req.query.department;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 100;
    const [expenses, total] = await Promise.all([
      Expense.find(filter).populate('createdBy', 'displayName').sort('-date -createdAt').skip((page - 1) * limit).limit(limit).lean(),
      Expense.countDocuments(filter)
    ]);
    res.json({ expenses, total, page, pages: Math.ceil(total / limit) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/expenses', auth, async (req, res) => {
  try {
    const { date, department, brand, glCode, glName, amountExTax, amountInTax, description, migoNo, prNo, notes } = req.body;
    const d = new Date(date);
    const month = d.getMonth() + 1;
    const quarter = Math.ceil(month / 3);
    const fiscalYear = d.getFullYear();
    const expense = await Expense.create({ date: d, fiscalYear, department, brand: brand || '', glCode, glName, month, quarter, amountExTax: amountExTax || 0, amountInTax: amountInTax || 0, description, migoNo: migoNo || '', prNo: prNo || '', notes, createdBy: req.user.userId });
    checkAndNotify(fiscalYear, department, brand || '', glCode, glName, quarter).catch(() => {});
    res.json({ message: '已登記費用', expense });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/expenses/:id', auth, async (req, res) => {
  try {
    const expense = await Expense.findById(req.params.id);
    if (!expense) return res.status(404).json({ error: '找不到此筆紀錄' });
    if (req.user.role !== 'admin' && req.user.role !== 'manager' && String(expense.createdBy) !== req.user.userId) return res.status(403).json({ error: '只能刪除自己的紀錄' });
    await expense.deleteOne();
    res.json({ message: '已刪除' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/reports/charts', auth, async (req, res) => {
  try {
    const year = parseInt(req.query.year) || 2026;
    const filter = { fiscalYear: year, ...deptFilter(req) };
    const [brandBudgets, deptBudgets, deptUsed, monthlyBudgets, monthlyUsed] = await Promise.all([
      Budget.aggregate([{ $match: filter }, { $group: { _id: '$brand', total: { $sum: '$amount' } } }, { $sort: { total: -1 } }]),
      Budget.aggregate([{ $match: filter }, { $group: { _id: '$department', total: { $sum: '$amount' } } }]),
      Expense.aggregate([{ $match: filter }, { $group: { _id: '$department', total: { $sum: '$amountInTax' } } }]),
      Budget.aggregate([{ $match: filter }, { $group: { _id: '$month', total: { $sum: '$amount' } } }, { $sort: { _id: 1 } }]),
      Expense.aggregate([{ $match: filter }, { $group: { _id: '$month', total: { $sum: '$amountInTax' } } }, { $sort: { _id: 1 } }])
    ]);
    const deptUsedMap = Object.fromEntries(deptUsed.map(d => [d._id, d.total]));
    const mBudgetMap = Object.fromEntries(monthlyBudgets.map(m => [m._id, m.total]));
    const mUsedMap = Object.fromEntries(monthlyUsed.map(m => [m._id, m.total]));
    res.json({ pie: { labels: brandBudgets.map(b => b._id || '(無品牌)'), data: brandBudgets.map(b => b.total) }, bar: { labels: deptBudgets.map(d => d._id), budgets: deptBudgets.map(d => d.total), used: deptBudgets.map(d => deptUsedMap[d._id] || 0) }, line: { labels: Array.from({ length: 12 }, (_, i) => (i + 1) + '月'), budgets: Array.from({ length: 12 }, (_, i) => mBudgetMap[i + 1] || 0), used: Array.from({ length: 12 }, (_, i) => mUsedMap[i + 1] || 0) } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/export/budget', auth, async (req, res) => {
  try {
    const year = parseInt(req.query.year) || 2026;
    const filter = { fiscalYear: year, ...deptFilter(req) };
    const [budgets, expenses] = await Promise.all([Budget.find(filter).lean(), Expense.find(filter).lean()]);
    const map = {};
    for (const b of budgets) { const key = `${b.department}|${b.brand}|${b.glCode}`; if (!map[key]) map[key] = { dept: b.department, brand: b.brand, glCode: b.glCode, glName: b.glName, budget: 0, used: 0 }; map[key].budget += b.amount; }
    for (const e of expenses) { const key = `${e.department}|${e.brand}|${e.glCode}`; if (map[key]) map[key].used += e.amountInTax; }
    const rows = [['部門', '品牌', 'GL代碼', 'GL名稱', '年度預算', '已使用', '剩餘', '使用率']];
    for (const item of Object.values(map)) { const remain = item.budget - item.used; const rate = item.budget > 0 ? Math.round((item.used / item.budget) * 100) + '%' : '0%'; rows.push([item.dept, item.brand, item.glCode, item.glName, item.budget, item.used, remain, rate]); }
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '預算總覽');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', `attachment; filename=budget_${year}.xlsx`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/export/expenses', auth, async (req, res) => {
  try {
    const year = parseInt(req.query.year) || 2026;
    const filter = { fiscalYear: year, ...deptFilter(req) };
    const expenses = await Expense.find(filter).populate('createdBy', 'displayName').sort('-date').lean();
    const rows = [['日期', '部門', '品牌', 'GL代碼', 'GL名稱', '費用未稅', '含稅', '費用說明', 'MIGO單號', '請購單PR', '備註', '登記人']];
    for (const e of expenses) { rows.push([e.date ? new Date(e.date).toISOString().split('T')[0] : '', e.department, e.brand, e.glCode, e.glName, e.amountExTax || 0, e.amountInTax || 0, e.description, e.migoNo || '', e.prNo || '', e.notes, e.createdBy?.displayName || '']); }
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '費用紀錄');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', `attachment; filename=expenses_${year}.xlsx`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/options/departments', auth, async (req, res) => {
  const year = parseInt(req.query.year) || 2026;
  if (req.user.role === 'staff') return res.json([req.user.department]);
  const depts = await Budget.distinct('department', { fiscalYear: year });
  res.json(depts.sort());
});

app.get('/api/options/brands', auth, async (req, res) => {
  const year = parseInt(req.query.year) || 2026;
  const brands = await Budget.distinct('brand', { fiscalYear: year, department: req.query.department });
  res.json(brands.sort());
});

app.get('/api/options/gl', auth, async (req, res) => {
  const year = parseInt(req.query.year) || 2026;
  const filter = { fiscalYear: year, department: req.query.department };
  if (req.query.brand !== undefined) filter.brand = req.query.brand;
  const items = await Budget.find(filter).distinct('glCode');
  const gls = await Budget.find({ ...filter, glCode: { $in: items } }).select('glCode glName').lean();
  const unique = {};
  for (const g of gls) unique[g.glCode] = g.glName;
  res.json(Object.entries(unique).map(([code, name]) => ({ glCode: code, glName: name })).sort((a, b) => a.glCode.localeCompare(b.glCode)));
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ===== Export for Vercel (serverless) =====
module.exports = app;

// ===== Local dev fallback =====
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  connectDB().then(() => {
    app.listen(PORT, () => console.log(`B26 Budget System → http://localhost:${PORT}`));
  }).catch(err => { console.error(err); process.exit(1); });
}
