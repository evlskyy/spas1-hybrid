const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function invoiceMarkup(invoice) {
  const start = html.indexOf('function buildStockInvoiceMarkup(');
  const end = html.indexOf('\nfunction printStockInvoice(', start);
  assert.notEqual(start, -1, 'Missing invoice renderer');
  assert.notEqual(end, -1, 'Missing invoice renderer boundary');
  const context = {
    document: {
      querySelector: function(selector) {
        if (selector === '[data-brand-field="sppg"]') return { textContent: 'SPPG Uji' };
        if (selector === '[data-brand-field="foundation"]') return { textContent: 'Yayasan Uji' };
        return null;
      }
    },
    escapeHtml: function(value) {
      return String(value).replace(/[&<>"']/g, function(char) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
      });
    }
  };
  vm.runInNewContext(html.slice(start, end), context);
  return context.buildStockInvoiceMarkup(invoice);
}

test('purchase invoice includes supplier, item totals, PO number, and escapes values', function() {
  const markup = invoiceMarkup({
    type: 'purchase',
    report: {
      'Nomor PO': 'PO-20261125-001',
      'Tanggal': '2026-11-25T02:00:00Z',
      'Supplier': '<CV Uji>',
      'Lokasi': 'Gudang',
      'Total Belanja': 30000,
      'Status': 'Aktif',
      'Catatan': 'nota & bukti'
    },
    items: [{ name: 'Beras', category: 'Bahan Baku', quantity: 2, unit: 'kg', unitPrice: 15000 }]
  });

  assert.match(markup, /INVOICE PEMBELIAN/);
  assert.match(markup, /PO-20261125-001/);
  assert.match(markup, /&lt;CV Uji&gt;/);
  assert.match(markup, /Beras/);
  assert.match(markup, /Rp 30\.000/);
  assert.match(markup, /nota &amp; bukti/);
  assert.doesNotMatch(markup, /<CV Uji>/);
});

test('outgoing invoice shows partial units, stock balance, destination, and cancelled status', function() {
  const markup = invoiceMarkup({
    type: 'outgoing',
    movement: {
      ID: 'movement-12345678',
      Tanggal: '2026-11-25T02:00:00Z',
      Tipe: 'Keluar',
      'Nama Item': 'Minyak',
      Kategori: 'Bahan Baku',
      'Jumlah Utama': 1,
      'Jumlah Pecahan': 2,
      Satuan: 'liter',
      'Satuan Pecahan': 'botol',
      'Stok Sebelum': 10,
      'Stok Sesudah': 8.5,
      Lokasi: 'Gudang utama',
      Catatan: '<Dapur>',
      Status: 'Dibatalkan'
    }
  });

  assert.match(markup, /BUKTI KELUAR GUDANG/);
  assert.match(markup, /1 liter \+ 2 botol/);
  assert.match(markup, /10 → 8,5/);
  assert.match(markup, /&lt;Dapur&gt;/);
  assert.match(markup, /Dibatalkan/);
  assert.doesNotMatch(markup, /Total Belanja/);
});

test('purchase and outgoing stock forms expose save-and-print and repeat-print actions', function() {
  assert.match(html, /id="slMovementSavePrint"/);
  assert.match(html, /printPurchaseTransactionFromButton/);
  assert.match(html, /printStockMovementFromAudit/);
  assert.match(html, /Cetak \/ Simpan PDF/);
});
