// ===== Account Mapping Data =====
const ACCOUNT_MAPPING_OPTIONS = [
  { account: "Media Buying", gsplNo: "PL35101000", gsplAccount: "Digital Media" },
  { account: "Media Buying", gsplNo: "PL35102000", gsplAccount: "Traditional Media" },
  { account: "Media Creative", gsplNo: "PL35104000", gsplAccount: "Media Agency Fees (Digital)" },
  { account: "Media Creative", gsplNo: "PL35104100", gsplAccount: "Media Agency Fees (Traditional)" },
  { account: "Media Creative", gsplNo: "PL35104200", gsplAccount: "Media Agency Fees (Common)" },
  { account: "Media Creative", gsplNo: "PL35105000", gsplAccount: "Media Production (Digital)" },
  { account: "Media Creative", gsplNo: "PL35105100", gsplAccount: "Media Production (Traditional)" },
  { account: "Media Creative", gsplNo: "PL35105200", gsplAccount: "Media Production (Common)" },
  { account: "Media Creative", gsplNo: "PL35106000", gsplAccount: "Models/Influencers (Digital)" },
  { account: "Media Creative", gsplNo: "PL35106100", gsplAccount: "Models/Influencers (Traditional)" },
  { account: "Media Creative", gsplNo: "PL35106200", gsplAccount: "Models/Influencers (Common)" },
  { account: "POSM", gsplNo: "PL35111000", gsplAccount: "Samples" },
  { account: "POSM", gsplNo: "PL35112000", gsplAccount: "Testers" },
  { account: "POSM", gsplNo: "PL35113000", gsplAccount: "Gift With Purchase" },
  { account: "POSM", gsplNo: "PL35115000", gsplAccount: "Other POSM" },
  { account: "Selling Enhancement Expenses", gsplNo: "PL35131000", gsplAccount: "Event/PR" },
  { account: "Selling Enhancement Expenses", gsplNo: "PL35132000", gsplAccount: "Education & Training" },
  { account: "Selling Enhancement Expenses", gsplNo: "PL35134000", gsplAccount: "Visual Merchandising" },
  { account: "Selling Enhancement Expenses", gsplNo: "PL35135000", gsplAccount: "Other Digital Expenses" },
  { account: "Selling Contribution Expenses", gsplNo: "PL35151000", gsplAccount: "Promotion Contribution" },
  { account: "Freight", gsplNo: "PL35701000", gsplAccount: "Freight" },
  { account: "Outsourced Expenses", gsplNo: "PL35702000", gsplAccount: "Outsourced Expenses" },
  { account: "Recharged Back Office Expenses", gsplNo: "PL35703000", gsplAccount: "Recharged Back Office Expenses" },
  { account: "Lease payments (short-term and small-amount leases)", gsplNo: "PL35705000", gsplAccount: "Lease payments" },
  { account: "Other SGA Expenses", gsplNo: "PL35706000", gsplAccount: "Other SGA Expenses" },
  { account: "Loss From Sale or Abandonment of Fixed Assets(SG&A)", gsplNo: "PL35708000", gsplAccount: "Loss From Sale or Abandonment of Fixed Assets(SG&A)" }
];

// ===== Auth Check =====
const token = localStorage.getItem('token');
const currentUser = JSON.parse(localStorage.getItem('user') || '{}');
if (!token) window.location.href = 'index.html';

function api(url, opts = {}) {
  opts.headers = { ...opts.headers, 'Authorization': 'Bearer ' + token };
  if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  return fetch(url, opts).then(async r => {
    if (r.status === 401) { localStorage.clear(); window.location.href = 'index.html'; }
    if (r.headers.get('content-type')?.includes('json')) return r.json();
    return r;
  });
}

function fmt(n) {
  if (n === 0) return '-';
  return (n < 0 ? '-' : '') + 'NT$ ' + Math.abs(n).toLocaleString('zh-TW', { maximumFractionDigits: 0 });
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function toast(msg, type = 'success') {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 2500);
}

// ===== Init =====
let treeData = {};
let expanded = new Set();
let selectedYear = 2026;
let chartPie = null, chartBar = null, chartLine = null;

function init() {
  // User info
  document.getElementById('user-name').textContent = currentUser.displayName || '';

  // Role-based tabs
  if (currentUser.role === 'staff') {
    document.getElementById('tab-upload').style.display = 'none';
    document.getElementById('tab-admin').style.display = 'none';
  } else if (currentUser.role === 'manager') {
    document.getElementById('tab-admin').style.display = 'none';
  }

  // Set today
  document.getElementById('exp-date').value = new Date().toISOString().split('T')[0];

  setupTabs();
  setupListeners();
  loadDashboard();
}

// ===== Tabs =====
function setupTabs() {
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      const id = tab.dataset.tab;
      if (id === 'dashboard') { document.getElementById('tab-dashboard').classList.add('active'); loadDashboard(); }
      else if (id === 'expenses') { document.getElementById('tab-expenses').classList.add('active'); loadExpenseForm(); loadHistory(); }
      else if (id === 'upload') { document.getElementById('tab-upload-content').classList.add('active'); }
      else if (id === 'admin') { document.getElementById('tab-admin-content').classList.add('active'); loadUsers(); }
    });
  });
}

// ===== Dashboard =====
async function loadDashboard() {
  const year = selectedYear;
  const [summary, charts] = await Promise.all([
    api('/api/budgets/summary?year=' + year),
    api('/api/reports/charts?year=' + year)
  ]);

  // Summary cards
  document.getElementById('s-budget').textContent = fmt(summary.totalBudget);
  document.getElementById('s-used').textContent = fmt(summary.totalUsed);
  document.getElementById('s-remain').textContent = fmt(summary.remaining);
  document.getElementById('s-rate').textContent = summary.rate + '%';
  document.getElementById('s-bar').style.width = Math.min(summary.rate, 100) + '%';

  // Load tree
  treeData = await api('/api/budgets/tree?year=' + year);
  renderTree();
  populateDeptFilter();
  renderCharts(charts);
}

function populateDeptFilter() {
  const sel = document.getElementById('f-dept');
  const val = sel.value;
  sel.innerHTML = '<option value="ALL">全部部門</option>';
  for (const dept of Object.keys(treeData).sort()) {
    sel.innerHTML += `<option value="${esc(dept)}">${esc(dept)}</option>`;
  }
  sel.value = val || 'ALL';
}

// Return month indices (0-based) for the current filter value
function getFilterMonthIndices(filterMonth) {
  const quarterMap = { Q1: [0,1,2], Q2: [3,4,5], Q3: [6,7,8], Q4: [9,10,11] };
  if (quarterMap[filterMonth]) return quarterMap[filterMonth];
  if (filterMonth !== 'ALL') return [parseInt(filterMonth) - 1];
  return null; // ALL
}

// Sum budget & used from item.months for given indices, or use annual totals
function sumItemByFilter(item, indices) {
  if (!indices) return { budget: item.budget, used: item.used };
  let budget = 0, used = 0;
  for (const i of indices) {
    const m = item.months[i];
    if (m) { budget += m.budget + m.carryIn; used += m.used; }
  }
  return { budget, used };
}

function renderTree() {
  const tbody = document.getElementById('tree-body');
  const filterDept = document.getElementById('f-dept').value;
  const filterMonth = document.getElementById('f-month').value;
  const monthIndices = getFilterMonthIndices(filterMonth);
  let html = '';

  for (const dept of Object.keys(treeData).sort()) {
    if (filterDept !== 'ALL' && dept !== filterDept) continue;
    const brands = treeData[dept];

    // Dept totals
    let dBudget = 0, dUsed = 0;
    for (const b of Object.keys(brands)) {
      for (const gl of Object.keys(brands[b])) {
        const { budget, used } = sumItemByFilter(brands[b][gl], monthIndices);
        dBudget += budget; dUsed += used;
      }
    }
    const dRemain = dBudget - dUsed;
    const dRate = dBudget > 0 ? Math.round((dUsed / dBudget) * 100) : 0;
    const dKey = dept;
    const dExp = expanded.has(dKey);

    html += treeRow(1, dKey, dept, dBudget, dUsed, dRemain, dRate, true, dExp);

    if (dExp) {
      for (const brand of Object.keys(brands).sort()) {
        const gls = brands[brand];
        let bBudget = 0, bUsed = 0;
        for (const gl of Object.keys(gls)) {
          const { budget, used } = sumItemByFilter(gls[gl], monthIndices);
          bBudget += budget; bUsed += used;
        }
        const bRemain = bBudget - bUsed;
        const bRate = bBudget > 0 ? Math.round((bUsed / bBudget) * 100) : 0;
        const bKey = dept + '|' + brand;
        const bExp = expanded.has(bKey);
        const label = brand || '(共通)';

        html += treeRow(2, bKey, label, bBudget, bUsed, bRemain, bRate, true, bExp);

        if (bExp) {
          for (const glCode of Object.keys(gls).sort()) {
            const item = gls[glCode];
            const { budget: gBudget, used: gUsed } = sumItemByFilter(item, monthIndices);
            const gRemain = gBudget - gUsed;
            const gRate = gBudget > 0 ? Math.round((gUsed / gBudget) * 100) : 0;
            html += treeRow(3, null, glCode + ' ' + item.glName, gBudget, gUsed, gRemain, gRate, false, false);
          }
        }
      }
    }
  }

  if (!html) {
    html = '<tr><td colspan="5" class="empty-state"><div class="empty-icon">📂</div><p>尚無預算資料，請先匯入</p></td></tr>';
  }
  tbody.innerHTML = html;
}

function treeRow(level, key, name, budget, used, remain, rate, hasChildren, isExpanded) {
  const rateClass = rate >= 90 ? 'red' : rate >= 70 ? 'yellow' : 'green';
  const toggle = hasChildren
    ? `<span class="toggle" onclick="toggleNode('${esc(key)}')">${isExpanded ? '▾' : '▸'}</span>`
    : '<span class="toggle"></span>';
  return `<tr class="tree-row lv-${level}">
    <td>${toggle}${esc(name)}</td>
    <td class="num-cell">${fmt(budget)}</td>
    <td class="num-cell">${fmt(used)}</td>
    <td class="num-cell ${remain < 0 ? 'negative' : 'positive'}">${fmt(remain)}</td>
    <td><div class="rate-cell"><span class="rate-text">${rate}%</span><div class="rate-bar-bg"><div class="rate-bar ${rateClass}" style="width:${Math.min(rate, 100)}%"></div></div></div></td>
  </tr>`;
}

window.toggleNode = function(key) {
  if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
  renderTree();
};

// ===== Charts =====
const COLORS = ['#1a56db','#0ea5e9','#059669','#d97706','#dc2626','#7c3aed','#db2777','#0891b2','#65a30d','#ea580c'];

function renderCharts(data) {
  // Pie
  if (chartPie) chartPie.destroy();
  chartPie = new Chart(document.getElementById('chart-pie'), {
    type: 'doughnut',
    data: { labels: data.pie.labels, datasets: [{ data: data.pie.data, backgroundColor: COLORS, borderWidth: 2, borderColor: '#fff' }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { font: { size: 11 }, boxWidth: 12 } } } }
  });

  // Bar
  if (chartBar) chartBar.destroy();
  chartBar = new Chart(document.getElementById('chart-bar'), {
    type: 'bar',
    data: {
      labels: data.bar.labels,
      datasets: [
        { label: '總預算', data: data.bar.budgets, backgroundColor: 'rgba(59,130,246,.25)', borderColor: '#3b82f6', borderWidth: 2, borderRadius: 4 },
        { label: '已使用', data: data.bar.used, backgroundColor: 'rgba(220,38,38,.7)', borderColor: '#dc2626', borderWidth: 1, borderRadius: 4 }
      ]
    },
    options: { responsive: true, maintainAspectRatio: false, scales: { y: { ticks: { callback: v => v >= 1e6 ? (v/1e6).toFixed(1)+'M' : v >= 1e3 ? (v/1e3).toFixed(0)+'K' : v } } } }
  });

  // Line
  if (chartLine) chartLine.destroy();
  chartLine = new Chart(document.getElementById('chart-line'), {
    type: 'line',
    data: {
      labels: data.line.labels,
      datasets: [
        { label: '月度預算', data: data.line.budgets, borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,.08)', borderWidth: 2, tension: .3, fill: true },
        { label: '實際費用', data: data.line.used, borderColor: '#dc2626', backgroundColor: 'rgba(220,38,38,.08)', borderWidth: 2, tension: .3, fill: true }
      ]
    },
    options: { responsive: true, maintainAspectRatio: false, scales: { y: { ticks: { callback: v => v >= 1e6 ? (v/1e6).toFixed(1)+'M' : v >= 1e3 ? (v/1e3).toFixed(0)+'K' : v } } } }
  });
}

// ===== Expense Form =====
async function loadExpenseForm() {
  const depts = await api('/api/options/departments?year=' + selectedYear);
  const sel = document.getElementById('exp-dept');
  sel.innerHTML = '<option value="">-- 選擇部門 --</option>';
  for (const d of depts) sel.innerHTML += `<option value="${esc(d)}">${esc(d)}</option>`;

  // If staff, auto-select
  if (currentUser.role === 'staff' && currentUser.department) {
    sel.value = currentUser.department;
    sel.disabled = true;
    onExpDeptChange();
  }
}

async function onExpDeptChange() {
  const dept = document.getElementById('exp-dept').value;
  const brandSel = document.getElementById('exp-brand');
  const glSel = document.getElementById('exp-gl');
  brandSel.innerHTML = '<option value="">-- 選擇品牌 --</option>';
  glSel.innerHTML = '<option value="">-- 選擇科目 --</option>';
  glSel.disabled = true;
  document.getElementById('exp-balance').classList.add('hidden');
  document.getElementById('exp-submit').disabled = true;
  document.getElementById('exp-submit').textContent = '請先選擇科目';

  if (!dept) { brandSel.disabled = true; return; }
  const brands = await api('/api/options/brands?year=' + selectedYear + '&department=' + encodeURIComponent(dept));
  for (const b of brands) brandSel.innerHTML += `<option value="${esc(b)}">${esc(b) || '(共通)'}</option>`;
  brandSel.disabled = false;
  if (brands.length === 1) { brandSel.value = brands[0]; onExpBrandChange(); }
}

async function onExpBrandChange() {
  const dept = document.getElementById('exp-dept').value;
  const brand = document.getElementById('exp-brand').value;
  const glSel = document.getElementById('exp-gl');
  glSel.innerHTML = '<option value="">-- 選擇科目 --</option>';
  document.getElementById('exp-balance').classList.add('hidden');
  document.getElementById('exp-submit').disabled = true;
  document.getElementById('exp-submit').textContent = '請先選擇科目';

  if (brand === undefined || brand === null) { glSel.disabled = true; return; }
  const gls = await api('/api/options/gl?year=' + selectedYear + '&department=' + encodeURIComponent(dept) + '&brand=' + encodeURIComponent(brand));
  for (const g of gls) glSel.innerHTML += `<option value="${esc(g.glCode)}" data-name="${esc(g.glName)}">${esc(g.glCode)} ${esc(g.glName)}</option>`;
  glSel.disabled = false;
}

function onExpGlChange() {
  const glSel = document.getElementById('exp-gl');
  if (!glSel.value) return;

  // Show balance from treeData if available
  const dept = document.getElementById('exp-dept').value;
  const brand = document.getElementById('exp-brand').value;
  const glCode = glSel.value;
  const item = treeData[dept]?.[brand]?.[glCode];
  const bal = item ? item.budget - item.used : null;
  const hint = document.getElementById('exp-balance');
  if (bal !== null) {
    hint.classList.remove('hidden', 'over');
    if (bal <= 0) hint.classList.add('over');
    document.getElementById('exp-bal-val').textContent = fmt(bal);
  }
  document.getElementById('exp-submit').disabled = false;
  document.getElementById('exp-submit').textContent = '✅ 確認登記費用';
}

async function submitExpense() {
  const dept = document.getElementById('exp-dept').value;
  const brand = document.getElementById('exp-brand').value;
  const glSel = document.getElementById('exp-gl');
  const glCode = glSel.value;
  const glName = glSel.selectedOptions[0]?.dataset.name || '';
  const amountExTax = parseFloat(document.getElementById('exp-amount-ex').value) || 0;
  const amountInTax = parseFloat(document.getElementById('exp-amount-in').value) || 0;
  const description = document.getElementById('exp-desc').value.trim();
  const migoNo = document.getElementById('exp-migo').value.trim();
  const prNo = document.getElementById('exp-pr').value.trim();
  const notes = document.getElementById('exp-notes').value.trim();
  const accountMapping = document.getElementById('exp-account-mapping').value;
  const date = document.getElementById('exp-date').value;

  if (!dept || !glCode || !amountInTax || !description || !date) {
    return toast('請填寫所有必填欄位（含稅金額必填）', 'error');
  }

  const res = await api('/api/expenses', {
    method: 'POST',
    body: { date, department: dept, brand, glCode, glName, amountExTax, amountInTax, description, migoNo, prNo, notes, accountMapping }
  });

  if (res.error) return toast(res.error, 'error');
  toast('已登記含稅 ' + fmt(amountInTax), 'success');
  document.getElementById('exp-amount-ex').value = '';
  document.getElementById('exp-amount-in').value = '';
  document.getElementById('exp-desc').value = '';
  document.getElementById('exp-migo').value = '';
  document.getElementById('exp-pr').value = '';
  document.getElementById('exp-notes').value = '';
  document.getElementById('exp-account-mapping').value = '';
  loadHistory();
  loadDashboard(); // refresh summary
}

// ===== Expense History =====
async function loadHistory() {
  const month = document.getElementById('hist-month').value;
  let url = '/api/expenses?year=' + selectedYear;
  if (month) url += '&month=' + month;
  const data = await api(url);
  const tbody = document.getElementById('hist-body');

  if (!data.expenses || data.expenses.length === 0) {
    tbody.innerHTML = '<tr><td colspan="13" class="empty-state">尚無紀錄</td></tr>';
    return;
  }

  tbody.innerHTML = data.expenses.map(e => `<tr>
    <td>${e.date ? new Date(e.date).toISOString().split('T')[0] : ''}</td>
    <td>${esc(e.department)}</td>
    <td>${esc(e.brand || '-')}</td>
    <td>${esc(e.glCode)} ${esc(e.glName)}</td>
    <td>${esc(e.accountMapping || '')}</td>
    <td class="num-cell" style="color:var(--danger);font-weight:600">-${fmt(e.amountExTax || 0)}</td>
    <td class="num-cell" style="color:var(--danger);font-weight:600">-${fmt(e.amountInTax || 0)}</td>
    <td>${esc(e.description)}</td>
    <td>${esc(e.migoNo || '')}</td>
    <td>${esc(e.prNo || '')}</td>
    <td>${esc(e.notes || '')}</td>
    <td>${esc(e.createdBy?.displayName || '')}</td>
    <td><button class="btn btn-sm btn-ghost" onclick="deleteExpense('${e._id}')" title="刪除">✕</button></td>
  </tr>`).join('');
}

window.deleteExpense = async function(id) {
  if (!confirm('確定要刪除這筆費用？')) return;
  const res = await api('/api/expenses/' + id, { method: 'DELETE' });
  if (res.error) return toast(res.error, 'error');
  toast('已刪除', 'success');
  loadHistory();
  loadDashboard();
};

// ===== Upload =====
async function handleUpload(file) {
  const resultEl = document.getElementById('upload-result');
  resultEl.classList.remove('hidden');
  resultEl.innerHTML = '⏳ 匯入中...';

  const formData = new FormData();
  formData.append('file', file);
  const res = await api('/api/budgets/upload?year=' + selectedYear, { method: 'POST', body: formData });

  if (res.error) {
    resultEl.innerHTML = `<span style="color:var(--danger)">❌ ${esc(res.error)}</span>`;
  } else {
    resultEl.innerHTML = `<span style="color:var(--success)">✅ ${esc(res.message)}</span>`;
    loadDashboard();
  }
}

// ===== Admin: Users =====
async function loadUsers() {
  const data = await api('/api/users');
  const tbody = document.getElementById('users-body');
  tbody.innerHTML = data.map(u => `<tr>
    <td>${esc(u.username)}</td>
    <td>${esc(u.displayName)}</td>
    <td>${esc(u.email || '')}</td>
    <td>${esc(u.role)}</td>
    <td>${esc(u.department || '-')}</td>
    <td>${u.isActive ? '🟢 啟用' : '🔴 停用'}</td>
    <td><button class="btn btn-sm btn-ghost" onclick="viewUserExpenses('${u._id}','${esc(u.displayName)}')">查看紀錄</button></td>
    <td><button class="btn btn-sm btn-ghost" onclick="editUser('${u._id}','${esc(u.username)}','${esc(u.displayName)}','${esc(u.email || '')}','${esc(u.role)}','${esc(u.department || '')}')">編輯</button></td>
    <td>${u.isActive ? `<button class="btn btn-sm btn-ghost" style="color:var(--danger)" onclick="deactivateUser('${u._id}')">停用</button>` : ''}</td>
  </tr>`).join('');
}

window.viewUserExpenses = async function(userId, name) {
  const modal = document.getElementById('user-expenses-modal');
  const tbody = document.getElementById('uem-body');
  document.getElementById('uem-title').textContent = name + ' 的費用紀錄 (FY' + selectedYear + ')';
  document.getElementById('uem-total').textContent = '';
  tbody.innerHTML = '<tr><td colspan="10" class="empty-state">載入中...</td></tr>';
  modal.style.display = 'flex';
  const data = await api('/api/users/' + userId + '/expenses?year=' + selectedYear);
  if (!data.expenses || data.expenses.length === 0) {
    tbody.innerHTML = '<tr><td colspan="10" class="empty-state">尚無紀錄</td></tr>';
    document.getElementById('uem-total').textContent = '合計含稅：NT$ 0';
    return;
  }
  document.getElementById('uem-total').textContent = '合計含稅：NT$ ' + fmt(data.total);
  tbody.innerHTML = data.expenses.map(e => `<tr>
    <td>${e.date ? new Date(e.date).toISOString().split('T')[0] : ''}</td>
    <td>${esc(e.department)}</td>
    <td>${esc(e.brand || '-')}</td>
    <td>${esc(e.glCode)} ${esc(e.glName)}</td>
    <td class="num-cell">-${fmt(e.amountExTax || 0)}</td>
    <td class="num-cell">-${fmt(e.amountInTax || 0)}</td>
    <td>${esc(e.description)}</td>
    <td>${esc(e.migoNo || '')}</td>
    <td>${esc(e.prNo || '')}</td>
    <td>${esc(e.notes || '')}</td>
  </tr>`).join('');
};

let editingUserId = null;

window.editUser = function(id, username, displayName, email, role, department) {
  editingUserId = id;
  document.getElementById('u-username').value = username;
  document.getElementById('u-username').disabled = true;
  document.getElementById('u-password').value = '';
  document.getElementById('u-password').placeholder = '留空不修改密碼';
  document.getElementById('u-name').value = displayName;
  document.getElementById('u-email').value = email;
  document.getElementById('u-role').value = role;
  document.getElementById('u-dept').value = department;
  document.getElementById('u-submit').textContent = '更新使用者';
  document.getElementById('u-cancel').style.display = '';
};

window.cancelEditUser = function() {
  editingUserId = null;
  document.getElementById('u-username').value = '';
  document.getElementById('u-username').disabled = false;
  document.getElementById('u-password').value = '';
  document.getElementById('u-password').placeholder = '新建必填 / 修改留空不改';
  document.getElementById('u-name').value = '';
  document.getElementById('u-email').value = '';
  document.getElementById('u-role').value = 'staff';
  document.getElementById('u-dept').value = '';
  document.getElementById('u-submit').textContent = '新增使用者';
  document.getElementById('u-cancel').style.display = 'none';
};

window.deactivateUser = async function(id) {
  if (!confirm('確定要停用此使用者？')) return;
  await api('/api/users/' + id, { method: 'DELETE' });
  toast('已停用', 'success');
  loadUsers();
};

async function createUser() {
  const username = document.getElementById('u-username').value.trim();
  const password = document.getElementById('u-password').value;
  const displayName = document.getElementById('u-name').value.trim();
  const email = document.getElementById('u-email').value.trim();
  const role = document.getElementById('u-role').value;
  const department = document.getElementById('u-dept').value.trim();

  if (editingUserId) {
    // Update existing user
    if (!displayName) return toast('請填寫顯示名稱', 'error');
    const body = { displayName, email, role, department };
    if (password) body.password = password;
    const res = await api('/api/users/' + editingUserId, { method: 'PUT', body });
    if (res.error) return toast(res.error, 'error');
    toast('已更新 ' + displayName, 'success');
    cancelEditUser();
  } else {
    // Create new user
    if (!username || !password || !displayName) return toast('請填寫帳號、密碼和名稱', 'error');
    const res = await api('/api/users', {
      method: 'POST',
      body: { username, password, displayName, email, role, department }
    });
    if (res.error) return toast(res.error, 'error');
    toast('已建立 ' + displayName, 'success');
    document.getElementById('u-username').value = '';
    document.getElementById('u-password').value = '';
    document.getElementById('u-name').value = '';
    document.getElementById('u-email').value = '';
    document.getElementById('u-dept').value = '';
  }
  loadUsers();
}

// ===== Event Listeners =====
function setupListeners() {
  document.getElementById('logout-btn').addEventListener('click', () => { localStorage.clear(); window.location.href = 'index.html'; });
  document.getElementById('year-select').addEventListener('change', (e) => {
    selectedYear = parseInt(e.target.value);
    document.getElementById('fy-badge').textContent = 'FY' + selectedYear;
    loadDashboard();
  });

  // Dashboard filters
  document.getElementById('f-dept').addEventListener('change', renderTree);
  document.getElementById('f-month').addEventListener('change', renderTree);
  document.getElementById('btn-expand').addEventListener('click', () => {
    for (const dept of Object.keys(treeData)) {
      expanded.add(dept);
      for (const brand of Object.keys(treeData[dept])) expanded.add(dept + '|' + brand);
    }
    renderTree();
  });
  document.getElementById('btn-collapse').addEventListener('click', () => { expanded.clear(); renderTree(); });

  // Export
  document.getElementById('btn-export-budget').addEventListener('click', () => {
    window.open('/api/export/budget?year=' + selectedYear, '_blank');
  });
  document.getElementById('btn-export-expense').addEventListener('click', () => {
    window.open('/api/export/expenses?year=' + selectedYear, '_blank');
  });

  // Populate Account Mapping dropdown
  const amSel = document.getElementById('exp-account-mapping');
  ACCOUNT_MAPPING_OPTIONS.forEach(opt => {
    const o = document.createElement('option');
    o.value = opt.account + ' – ' + opt.gsplAccount + ' (' + opt.gsplNo + ')';
    o.textContent = opt.account + ' – ' + opt.gsplAccount;
    amSel.appendChild(o);
  });

  // Expense form
  document.getElementById('exp-dept').addEventListener('change', onExpDeptChange);
  document.getElementById('exp-brand').addEventListener('change', onExpBrandChange);
  document.getElementById('exp-gl').addEventListener('change', onExpGlChange);
  document.getElementById('exp-submit').addEventListener('click', submitExpense);
  document.getElementById('hist-month').addEventListener('change', loadHistory);

  // Upload
  const uploadArea = document.getElementById('upload-area');
  const uploadFile = document.getElementById('upload-file');
  uploadArea.addEventListener('click', () => uploadFile.click());
  uploadArea.addEventListener('dragover', e => { e.preventDefault(); uploadArea.style.borderColor = 'var(--primary)'; });
  uploadArea.addEventListener('dragleave', () => { uploadArea.style.borderColor = ''; });
  uploadArea.addEventListener('drop', e => { e.preventDefault(); uploadArea.style.borderColor = ''; if (e.dataTransfer.files[0]) handleUpload(e.dataTransfer.files[0]); });
  uploadFile.addEventListener('change', e => { if (e.target.files[0]) handleUpload(e.target.files[0]); e.target.value = ''; });

  // Admin
  document.getElementById('u-submit').addEventListener('click', createUser);
}

init();
