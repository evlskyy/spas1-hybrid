const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const importer = require('../bank-menu-spreadsheet-import.js');
const test = require('node:test');

const header = 'No,Kategori,Karbohidrat,Prohe / Protein Hewani,Prona / Protein Nabati,Sayuran / Serat,Buah / Pelengkap';

test('imports only SPPG-category rows and preserves incomplete components', function() {
  const csv = [
    header,
    '1,Menu SPPG Sungai Pasir1 Meral,Nasi Putih,Ayam,Tahu,"Tumis Jagung, Wortel",Apel',
    '2,Menu SPPG Sungai Pasir1 Meral,Roti,Telur,,,Pisang',
    '3,Menu BNSP,Nasi,Ayam,Tahu,Sayur,Buah',
    '4,,Nasi,,,,'
  ].join('\r\n');

  const records = importer.parseMenuSpreadsheetCsv(csv);

  assert.equal(records.length, 2);
  assert.equal(records[0].sayuran, 'Tumis Jagung, Wortel');
  assert.equal(records[1].proteinNabati, '');
  assert.equal(records[1].sayuran, '');
  assert.equal(importer.spreadsheetId, '1uybUy_wgbrDn5FeOqiheT1ntCT4TW8AM0mCKYi7ud-s');
});

test('rejects importing a SPPG spreadsheet into another active organization', function() {
  assert.equal(importer.matchesTenantOrganization('SPPG Sungai Pasir 1 Meral, Karimun'), true);
  assert.equal(importer.matchesTenantOrganization('SPPG Sungai Pasir 2 Meral, Karimun'), false);
});

test('rejects malformed or ambiguous SPPG source rows', function() {
  assert.throws(function() {
    importer.parseMenuSpreadsheetCsv(header + '\n1,Menu SPPG Sungai Pasir1 Meral,"unclosed');
  }, /tanda kutip belum ditutup/);

  assert.throws(function() {
    importer.parseMenuSpreadsheetCsv([
      header,
      '1,Menu SPPG Sungai Pasir1 Meral,Nasi,Ayam,Tahu,Sayur,Buah',
      '1,Menu SPPG Sungai Pasir1 Meral,Nasi,Ayam,Tahu,Sayur,Buah'
    ].join('\n'));
  }, /Nomor menu spreadsheet berulang/);

  assert.throws(function() {
    importer.parseMenuSpreadsheetCsv('No,Kategori\n1,Menu SPPG Sungai Pasir1 Meral');
  }, /Kolom wajib tidak ditemukan/);
});

test('source and deploy app import into the authenticated active SPPG only', function() {
  const root = path.join(__dirname, '..');
  for (const file of ['index.html', 'dist/index.html']) {
    const html = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(html, /bank-menu-spreadsheet-import\.js/);
    assert.match(html, /Unduh CSV Spreadsheet/);
    assert.match(html, /Impor Spreadsheet CSV/);
    assert.match(html, /action: 'tenantStatus'/);
    assert.match(html, /matchesTenantOrganization\(tenantStatus\.organizationName\)/);
    assert.match(html, /expectedSppgId: tenantId/);
    assert.match(html, /callSupabaseAction\('importBankMenuFromSpreadsheet'/);
    assert.match(html, /status: 'belum_diisi'/);
  }
  const migration = fs.readFileSync(path.join(root, 'supabase_multisppg_migration.sql'), 'utf8');
  assert.match(migration, /new\.sppg_id is distinct from current_sppg_id/);
});
