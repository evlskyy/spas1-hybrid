const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'supabase', 'purchase_order_management_migration.sql'), 'utf8');
const financeMigration = fs.readFileSync(path.join(root, 'supabase', 'finance_obligations_and_purchase_payments_migration.sql'), 'utf8');

function sourceOf(name, nextName) {
  const start = html.indexOf('function ' + name + '(');
  const end = html.indexOf('\nfunction ' + nextName + '(', start);
  assert.notEqual(start, -1, 'Missing function ' + name);
  assert.notEqual(end, -1, 'Missing function boundary after ' + name);
  return html.slice(start, end);
}

test('barcode matching is trimmed and case-insensitive', function() {
  const context = {
    SL_STOK_DATA: [
      { nama: 'Beras', barcode: '8901234567890' },
      { nama: 'Minyak', barcode: '' }
    ]
  };
  vm.runInNewContext(sourceOf('findStockItemByBarcode', 'addPurchaseLineForBarcode'), context);

  assert.equal(context.findStockItemByBarcode(' 8901234567890 '), context.SL_STOK_DATA[0]);
  assert.equal(context.findStockItemByBarcode('unknown'), null);
});

test('purchase line subtotals and grand total update from quantity and unit price', function() {
  function makeLine(quantity, price) {
    const subtotal = { textContent: '' };
    const inputs = {
      '[data-purchase-field="quantity"]': { value: String(quantity) },
      '[data-purchase-field="unitPrice"]': { value: String(price) },
      '[data-purchase-subtotal]': subtotal
    };
    return {
      subtotal: subtotal,
      querySelector: function(selector) { return inputs[selector]; }
    };
  }
  const lines = [makeLine(2.5, 12000), makeLine(3, 5000)];
  const total = { textContent: '' };
  const context = {
    document: {
      querySelectorAll: function(selector) {
        return selector === '#slPurchaseLineList .sl-purchase-line' ? lines : [];
      },
      getElementById: function(id) { return id === 'slPurchaseTotal' ? total : null; }
    },
    Math: Math
  };
  vm.runInNewContext(sourceOf('updateDailyPurchaseTotal', 'generatePurchaseOrderNumber'), context);

  context.updateDailyPurchaseTotal();

  assert.equal(lines[0].subtotal.textContent, 'Subtotal: Rp 30.000');
  assert.equal(lines[1].subtotal.textContent, 'Subtotal: Rp 15.000');
  assert.equal(total.textContent, 'Rp 45.000');
});

test('purchase archive exposes date grouping and audited edit/cancel paths', function() {
  assert.match(html, /id="slPurchaseTransactionsModal"/);
  assert.match(html, /function openPurchaseTransactions\(\)/);
  assert.match(html, /case 'fetchPurchaseTransactions'/);
  assert.match(html, /case 'fetchPurchaseTransactionDetails'/);
  assert.match(html, /supabaseRpc\('spas1_edit_stock_purchase_with_payment'/);
  assert.match(financeMigration, /public\.edit_stok_logistik_purchase_order\(/);
  assert.match(html, /voidStockMovement', \{ movementId: movementId, reason: reason\.trim\(\) \}/);
  assert.match(migration, /perform public\.void_stok_logistik_transaction\(v_movement_id/);
  assert.match(migration, /v_result := public\.record_stok_logistik_purchase_order/);
  assert.match(migration, /"Status" = 'Aktif' and nullif\(btrim\("Nomor PO"\), ''\) is not null/);
});

test('purchase schema backfills suppliers and enforces tenant-scoped unique barcodes', function() {
  assert.match(migration, /insert into public\.spas1_stock_suppliers \(sppg_id, supplier_name\)/);
  assert.match(migration, /on public\.spas1_stock_suppliers \(sppg_id, lower\(btrim\(supplier_name\)\)\)/);
  assert.match(migration, /on public\."modul3_stok_logistik" \(sppg_id, lower\("Barcode"\)\)/);
  assert.match(migration, /public\.spas1_has_module_access\('stok'\)/);
});
