const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const sourceHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const deployedHtml = fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8');
const featureScript = fs.readFileSync(path.join(root, 'accounting-features.js'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'supabase/accounting_inventory_finance_migration.sql'), 'utf8');

test('Akuntan submenu exposes stock opname and finance in source and deployed pages', function() {
  for (const html of [sourceHtml, deployedHtml]) {
    assert.match(html, /id="nav-tab-stock-opname"[^>]*switchAdminTab\('tab-stock-opname'/);
    assert.match(html, /id="nav-tab-finance"[^>]*switchAdminTab\('tab-finance'/);
    assert.match(html, /id="tab-stock-opname"/);
    assert.match(html, /id="tab-finance"/);
    assert.match(html, /id="financeOpeningBalance"/);
    assert.match(html, /onclick="loadFinanceAudit\(\)">Riwayat Audit/);
    assert.match(html, /id="financeAuditRows"/);
    assert.match(html, /src="\.\/accounting-features\.js" defer/);
    assert.match(html, /'spas1_finance_transactions'/);
    assert.match(html, /initializeStockOpnameDate\(\); loadStockOpnames\(\)/);
    assert.match(html, /initializeFinanceDate\(\); loadFinanceTransactions\(\)/);
  }
  assert.equal(fs.readFileSync(path.join(root, 'dist/accounting-features.js'), 'utf8'), featureScript);
});

test('stock opname approval is tenant-bound, snapshot-checked, and applies audited stock adjustments', function() {
  assert.match(migration, /create table if not exists public\.spas1_stock_opnames/);
  assert.match(migration, /create table if not exists public\.spas1_stock_opname_lines/);
  assert.match(migration, /sppg_id = public\.spas1_current_sppg_id\(\)/);
  assert.match(migration, /function public\.spas1_approve_stock_opname\(p_opname_id uuid\)/);
  assert.match(migration, /v_before <> v_line\.expected_quantity/);
  assert.match(migration, /insert into public\."modul3_stok_logistik_transaksi"/);
  assert.match(migration, /'Penyesuaian Stok Opname '/);
  assert.match(migration, /status = 'approved', approved_at = v_timestamp/);
});

test('finance approval protects the ledger and keeps evidence in private storage', function() {
  assert.match(migration, /create table if not exists public\.spas1_finance_transactions/);
  assert.match(migration, /create table if not exists public\.spas1_finance_transaction_audit/);
  assert.match(migration, /akuntan-keuangan/);
  assert.match(migration, /p_transaction_type <> 'saldo_awal' and p_receipt_path is null/);
  assert.match(migration, /v_transaction\.transaction_type = 'pengeluaran'[\s\S]*v_balance < v_transaction\.amount/);
  assert.match(migration, /spas1_finance_single_opening_balance_key/);
  assert.match(migration, /action, before_data, after_data/);
  assert.match(migration, /'spas1-finance'[\s\S]*public\.spas1_current_storage_folder\(\)[\s\S]*akuntan-keuangan/);
  assert.match(featureScript, /spas1-finance/);
  assert.match(sourceHtml, /\(spas1-media\|spas1-lpdh\|spas1-finance\)/);
  assert.doesNotMatch(featureScript, /uploadSupabaseMedia\(\{ dataUrl: dataUrl, folder: 'spas1\/akuntan-keuangan'/);
});

test('finance JPEG receipts retain the extension accepted by the database', async function() {
  const requests = [];
  const context = {
    getSupabaseTenantStorageFolder: function() { return 'tenant-123'; },
    supabaseStorageRequest: async function(path, options) {
      requests.push({ path: path, options: options });
    }
  };
  vm.runInNewContext(featureScript, context);

  const path = await context.uploadFinanceReceipt(new Blob(['jpeg'], { type: 'image/jpeg' }));

  assert.match(path, /^tenant-123\/akuntan-keuangan\/.+\.jpeg$/);
  assert.match(requests[0].path, /\.jpeg$/);
});

test('finance balance includes only approved opening balance, income, and expense', async function() {
  const elements = {
    financeTransactionRows: { innerHTML: '' },
    financeCurrentBalance: { textContent: '' },
    financeOpeningBalance: { textContent: '' },
    financeTotalIncome: { textContent: '' },
    financeTotalExpense: { textContent: '' },
    financeStatus: { textContent: '' },
    financeFilterFrom: { value: '' },
    financeFilterTo: { value: '' },
    financeFilterType: { value: '' },
    financeFilterStatus: { value: '' }
  };
  const context = {
    document: { getElementById: function(id) { return elements[id]; } },
    supabaseRequest: async function() {
      return [
        { transaction_type: 'saldo_awal', amount: 1000, status: 'approved' },
        { transaction_type: 'pemasukan', amount: 250, status: 'approved' },
        { transaction_type: 'pengeluaran', amount: 300, status: 'approved' },
        { transaction_type: 'pemasukan', amount: 500, status: 'pending' },
        { transaction_type: 'pengeluaran', amount: 75, status: 'rejected' }
      ];
    },
    escapeHtml: function(value) { return String(value); },
    showToast: function() {}
  };
  vm.runInNewContext(featureScript, context);
  await context.loadFinanceTransactions();
  const digitsOnly = function(value) { return value.replace(/\D/g, ''); };
  assert.equal(digitsOnly(elements.financeCurrentBalance.textContent), '950');
  assert.equal(digitsOnly(elements.financeOpeningBalance.textContent), '1000');
  assert.equal(digitsOnly(elements.financeTotalIncome.textContent), '250');
  assert.equal(digitsOnly(elements.financeTotalExpense.textContent), '300');
});

test('finance filters preserve the requested date, type, and approval status', function() {
  const controls = {
    financeFilterFrom: { value: '2025-01-01' },
    financeFilterTo: { value: '2025-01-31' },
    financeFilterType: { value: 'pengeluaran' },
    financeFilterStatus: { value: 'approved' }
  };
  const context = {
    document: { getElementById: function(id) { return controls[id]; } },
    financeTransactions: [
      { id: 'one', transaction_date: '2025-01-10', transaction_type: 'pengeluaran', status: 'approved' },
      { id: 'two', transaction_date: '2025-01-10', transaction_type: 'pemasukan', status: 'approved' },
      { id: 'three', transaction_date: '2025-01-10', transaction_type: 'pengeluaran', status: 'pending' },
      { id: 'four', transaction_date: '2025-02-01', transaction_type: 'pengeluaran', status: 'approved' }
    ]
  };
  vm.runInNewContext(featureScript, context);
  assert.deepEqual(Array.from(context.getFilteredFinanceTransactions(), function(row) { return row.id; }), ['one']);
});
