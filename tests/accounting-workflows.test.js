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
const obligationsMigration = fs.readFileSync(path.join(root, 'supabase/finance_obligations_and_purchase_payments_migration.sql'), 'utf8');

test('Akuntan submenu exposes stock opname and finance in source and deployed pages', function() {
  for (const html of [sourceHtml, deployedHtml]) {
    assert.match(html, /id="nav-tab-stock-opname"[^>]*switchAdminTab\('tab-stock-opname'/);
    assert.match(html, /id="nav-tab-finance"[^>]*switchAdminTab\('tab-finance'/);
    assert.match(html, /id="nav-tab-finance-obligations"[^>]*switchAdminTab\('tab-finance-obligations'/);
    assert.match(html, /id="tab-stock-opname"/);
    assert.match(html, /id="tab-finance"/);
    assert.match(html, /id="tab-finance-obligations"/);
    assert.match(html, /id="slPurchasePaymentType"/);
    assert.match(html, /id="financeLedgerRows"/);
    assert.match(html, /id="financeLedgerArea"/);
    assert.match(html, /id="financeObligationRows"/);
    assert.match(html, /id="financeOpeningBalance"/);
    assert.match(html, /onclick="loadFinanceAudit\(\)">Riwayat Audit/);
    assert.match(html, /id="financeAuditRows"/);
    assert.match(html, /#view-admin #tab-finance :is\(#financeTransactionForm,#financePrintArea,section\.no-print > div\.overflow-x-auto\)[\s\S]*?background-color:/);
    assert.match(html, /#view-admin #tab-finance :is\(input:not\(\[type="hidden"\]\),select,textarea\)[\s\S]*?background-color:/);
    assert.match(html, /#view-admin #tab-finance-obligations :is\(input:not\(\[type="hidden"\]\),select,textarea\)[\s\S]*?background-color:/);
    assert.match(html, /class="finance-transactions-table w-full min-w-\[1165px\]/);
    assert.match(html, /finance-transactions-table :is\(th,td\):nth-child\(1\) \{ width: 105px; white-space: nowrap; \}/);
    assert.match(html, /finance-description-cell \{\s*white-space: normal;\s*overflow-wrap: anywhere;/);
    assert.match(html, /finance-action-grid \{\s*display: grid;\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
    assert.match(html, /finance-action-button \{\s*display: inline-flex;[\s\S]*?height: 28px;/);
    assert.match(html, /src="\.\/accounting-features\.js" defer/);
    assert.match(html, /'spas1_finance_transactions'/);
    assert.match(html, /initializeStockOpnameDate\(\); loadStockOpnames\(\)/);
    assert.match(html, /initializeFinanceDate\(\); loadFinanceTransactions\(\)/);
    assert.match(html, /initializeFinanceDate\(\); loadFinanceObligations\(\)/);
  }
  assert.equal(fs.readFileSync(path.join(root, 'dist/accounting-features.js'), 'utf8'), featureScript);
  assert.match(featureScript, /finance-description-cell p-3/);
});

test('cash purchases, payables, receivables, and payment approvals use dedicated migration RPCs', function() {
  assert.match(obligationsMigration, /p_payment_type is null/);
  assert.match(obligationsMigration, /spas1_record_stock_purchase_with_payment/);
  assert.match(obligationsMigration, /spas1_edit_stock_purchase_with_payment/);
  assert.match(obligationsMigration, /spas1_create_finance_receivable/);
  assert.match(obligationsMigration, /spas1_record_finance_obligation_payment/);
  assert.match(obligationsMigration, /check \("Status Pembayaran" in \('Belum Dicatat', 'Cash\/Lunas', 'Hutang', 'Hutang Sebagian', 'Lunas', 'Dibatalkan'\)\)/);
  assert.match(obligationsMigration, /if p_payment_type is null or p_payment_type not in \('cash_lunas', 'hutang'\) then/);
  assert.match(obligationsMigration, /only applies to historical|nota lama/i);
  assert.match(obligationsMigration, /source_obligation_id/);
  assert.match(obligationsMigration, /transaction\.status = 'approved'/);
  assert.match(obligationsMigration, /transaction\.status in \('pending', 'approved'\)/);
  assert.match(obligationsMigration, /Finance obligation payments tenant admin read/);
  assert.match(sourceHtml, /Nota lama - belum diselaraskan/);
  assert.match(featureScript, /spas1_record_finance_obligation_payment/);
  assert.match(featureScript, /Rincian_Saldo/);
  assert.match(featureScript, /openStockReceiptByPath\(path\)/);
});

test('finance actions render as evenly sized two-column buttons', function() {
  const elements = {
    financeTransactionRows: { innerHTML: '' },
    financeFilterFrom: { value: '' },
    financeFilterTo: { value: '' },
    financeFilterType: { value: '' },
    financeFilterStatus: { value: '' }
  };
  const context = {
    document: { getElementById: function(id) { return elements[id]; } },
    financeTransactions: [{
      id: 'transaction-1',
      transaction_date: '2026-11-27',
      transaction_type: 'pemasukan',
      category: 'Top-up',
      description: 'Sumber saldo',
      amount: 300000000,
      payment_method: 'Transfer',
      status: 'pending'
    }],
    escapeHtml: function(value) { return String(value); }
  };
  vm.runInNewContext(featureScript, context);

  context.renderFinanceTransactions();

  const markup = elements.financeTransactionRows.innerHTML;
  assert.match(markup, /class="finance-action-grid"/);
  assert.equal((markup.match(/class="finance-action-button/g) || []).length, 4);
  assert.ok(markup.indexOf('>Setujui</button>') < markup.indexOf('>Tolak</button>'));
  assert.ok(markup.indexOf('>Tolak</button>') < markup.indexOf('>Edit</button>'));
  assert.ok(markup.indexOf('>Edit</button>') < markup.indexOf('>Hapus</button>'));
});

test('linked purchase and obligation transactions cannot be edited or deleted from the generic finance list', function() {
  const elements = {
    financeTransactionRows: { innerHTML: '' },
    financeFilterFrom: { value: '' },
    financeFilterTo: { value: '' },
    financeFilterType: { value: '' },
    financeFilterStatus: { value: '' }
  };
  const context = {
    document: { getElementById: function(id) { return elements[id]; } },
    financeTransactions: [{
      id: 'linked-transaction',
      transaction_date: '2026-11-27',
      transaction_type: 'pengeluaran',
      category: 'Pembelian Stok',
      description: 'Nota PO',
      amount: 125000,
      payment_method: 'Cash/Lunas',
      status: 'pending',
      source_purchase_id: 'purchase-1'
    }],
    escapeHtml: function(value) { return String(value); }
  };
  vm.runInNewContext(featureScript, context);

  context.renderFinanceTransactions();

  const markup = elements.financeTransactionRows.innerHTML;
  assert.match(markup, /Setujui/);
  assert.match(markup, /Tolak/);
  assert.match(markup, /Kelola melalui nota atau Hutang\/Piutang/);
  assert.doesNotMatch(markup, />Edit<\/button>/);
  assert.doesNotMatch(markup, />Hapus<\/button>/);
});

test('chronological balance ledger ignores pending and rejected transactions', function() {
  const context = {
    financeTransactions: [
      { id: 'late', transaction_date: '2026-01-03', transaction_type: 'pengeluaran', amount: 125, status: 'approved' },
      { id: 'pending', transaction_date: '2026-01-02', transaction_type: 'pemasukan', amount: 500, status: 'pending' },
      { id: 'opening', transaction_date: '2026-01-01', transaction_type: 'saldo_awal', amount: 1000, status: 'approved' },
      { id: 'income', transaction_date: '2026-01-02', transaction_type: 'pemasukan', amount: 300, status: 'approved' },
      { id: 'rejected', transaction_date: '2026-01-02', transaction_type: 'pengeluaran', amount: 75, status: 'rejected' }
    ]
  };
  vm.runInNewContext(featureScript, context);

  const rows = Array.from(context.getFinanceLedgerRows(), function(row) {
    return [row.transaction.id, row.change, row.balance];
  });

  assert.deepEqual(rows, [['opening', 1000, 1000], ['income', 300, 1300], ['late', -125, 1175]]);
});

test('obligation totals reserve pending installments without treating them as paid', function() {
  const context = {
    financeTransactions: [
      { id: 'paid-1', status: 'approved' },
      { id: 'pending-1', status: 'pending' },
      { id: 'rejected-1', status: 'rejected' }
    ],
    financeObligationPayments: [
      { obligation_id: 'obligation-1', finance_transaction_id: 'paid-1', amount: 200 },
      { obligation_id: 'obligation-1', finance_transaction_id: 'pending-1', amount: 150 },
      { obligation_id: 'obligation-1', finance_transaction_id: 'rejected-1', amount: 100 }
    ]
  };
  vm.runInNewContext(featureScript, context);
  context.financeObligationPayments = [
    { obligation_id: 'obligation-1', finance_transaction_id: 'paid-1', amount: 200 },
    { obligation_id: 'obligation-1', finance_transaction_id: 'pending-1', amount: 150 },
    { obligation_id: 'obligation-1', finance_transaction_id: 'rejected-1', amount: 100 }
  ];

  const amounts = context.getFinanceObligationAmounts({ id: 'obligation-1', total_amount: 1000 });

  assert.deepEqual(
    { approved: amounts.approved, pending: amounts.pending, outstanding: amounts.outstanding, available: amounts.available },
    { approved: 200, pending: 150, outstanding: 800, available: 650 }
  );
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
