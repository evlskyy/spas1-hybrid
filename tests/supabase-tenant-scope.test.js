const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const helperStart = html.indexOf('const SPAS1_TENANT_SCOPED_TABLES');
const helperEnd = html.indexOf('async function supabaseStorageRequest', helperStart);
assert.notEqual(helperStart, -1, 'tenant-scoping helpers should exist');
assert.notEqual(helperEnd, -1, 'tenant-scoping helper block should end');
const helperSource = html.slice(helperStart, helperEnd) + '\nthis.applySupabaseTenantScope = applySupabaseTenantScope;';
const storageStart = html.indexOf('function getSupabaseTenantStorageFolder');
const storageEnd = html.indexOf('async function uploadSupabaseMedia', storageStart);
assert.notEqual(storageStart, -1, 'tenant storage helpers should exist');
assert.notEqual(storageEnd, -1, 'tenant storage helper block should end');
const storageSource = html.slice(storageStart, storageEnd) +
  '\nthis.getSupabaseTenantStorageFolder = getSupabaseTenantStorageFolder;' +
  '\nthis.isSupabaseTenantStoragePath = isSupabaseTenantStoragePath;' +
  '\nthis.isSupabaseStockReceiptPath = isSupabaseStockReceiptPath;';

const tenantId = '01234567-89ab-4cde-8abc-0123456789ab';
const legacyTenantId = '00000000-0000-4000-8000-000000000001';

function createScope(sessionTenantId, hasSession) {
  const context = createTenantContext(sessionTenantId, hasSession);
  return context.applySupabaseTenantScope;
}

function createTenantContext(sessionTenantId, hasSession) {
  const payload = sessionTenantId ? { app_metadata: { sppg_id: sessionTenantId } } : {};
  const token = 'header.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.signature';
  const context = {
    window: { SPAS1_SUPABASE_SESSION: hasSession === false ? '' : token },
    TextDecoder,
    Uint8Array,
    atob
  };
  vm.runInNewContext(helperSource + storageSource, context);
  return context;
}

test('tenant-scoped reads are filtered by the authenticated SPPG without mutating caller options', function() {
  const scope = createScope(tenantId);
  const options = { query: { select: '*', order: 'Tanggal.desc' } };
  const scoped = scope('MODUL1_Absensi', options);

  assert.equal(scoped.query.sppg_id, 'eq.' + tenantId);
  assert.equal(options.query.sppg_id, undefined);
  assert.equal(scope('unscoped_table', options), options);
});

test('tenant-scoped writes add the authenticated SPPG to objects and upsert keys', function() {
  const scope = createScope(tenantId);
  const options = {
    method: 'POST',
    query: { on_conflict: 'Pengaturan' },
    body: [{ Pengaturan: 'logoUrl' }, { Pengaturan: 'sppgName' }]
  };
  const scoped = scope('SPAS1_SETTINGS', options);

  assert.equal(scoped.query.on_conflict, 'sppg_id,Pengaturan');
  assert.deepEqual(JSON.parse(JSON.stringify(scoped.body)), [
    { Pengaturan: 'logoUrl', sppg_id: tenantId },
    { Pengaturan: 'sppgName', sppg_id: tenantId }
  ]);
  assert.equal(options.body[0].sppg_id, undefined);
});

test('tenant-scoped requests reject caller-supplied cross-SPPG filters or rows', function() {
  const scope = createScope(tenantId);

  assert.throws(function() {
    scope('SPAS1_SETTINGS', { query: { sppg_id: 'eq.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } });
  }, /tidak sesuai/);
  assert.throws(function() {
    scope('SPAS1_SETTINGS', { method: 'POST', body: { sppg_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } });
  }, /SPPG lain/);
});

test('legacy authenticated sessions without a tenant claim stay on the original SPPG', function() {
  const scope = createScope(null, true);
  const options = { query: { select: '*' } };
  const scoped = scope('SPAS1_SETTINGS', options);

  assert.equal(scoped.query.sppg_id, 'eq.' + legacyTenantId);
});

test('anonymous requests are not assigned an authenticated tenant', function() {
  const scope = createScope(null, false);
  const options = { query: { select: '*' } };

  assert.equal(scope('SPAS1_SETTINGS', options), options);
});

test('Storage paths use the active SPPG prefix and reject another tenant path', function() {
  const context = createTenantContext(tenantId, true);

  assert.equal(context.getSupabaseTenantStorageFolder(), tenantId);
  assert.equal(
    context.isSupabaseTenantStoragePath(tenantId + '/lpdh/2026-11-22/receipt.pdf', 'lpdh/2026-11-22/'),
    true
  );
  assert.equal(
    context.isSupabaseTenantStoragePath('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/lpdh/2026-11-22/receipt.pdf', 'lpdh/2026-11-22/'),
    false
  );
});

test('stock receipt validation accepts only the active SPPG folder and expected path shape', function() {
  const context = createTenantContext(tenantId, true);

  assert.equal(context.isSupabaseStockReceiptPath(tenantId + '/stok-logistik/2026/11/22-Senin/receipt.webp'), true);
  assert.equal(context.isSupabaseStockReceiptPath('spas1/stok-logistik/2026/11/22-Senin/receipt.webp'), false);
  assert.equal(context.isSupabaseStockReceiptPath(tenantId + '/stok-logistik/2026/11/22-Senin/nested/receipt.webp'), false);
});

test('legacy SPPG retains its existing Storage prefix', function() {
  const context = createTenantContext(null, true);

  assert.equal(context.getSupabaseTenantStorageFolder(), 'spas1');
  assert.equal(context.isSupabaseTenantStoragePath('spas1/lpdh/2026-11-22/receipt.pdf', 'lpdh/2026-11-22/'), true);
  assert.equal(context.isSupabaseStockReceiptPath('spas1/stok-logistik/2026/11/22-Senin/receipt.webp'), true);
});

test('admin data reads use the shared authenticated Supabase request path', function() {
  const start = html.indexOf('function supabaseSelect(table, query)');
  const end = html.indexOf('\n}\n\nfunction fetchSupabaseAdminData', start);
  assert.notEqual(start, -1, 'supabaseSelect should exist');
  assert.notEqual(end, -1, 'supabaseSelect should end before the admin data loader');
  const calls = [];
  const context = {
    supabaseRequest: function(table, options) {
      calls.push({ table, options });
      return Promise.resolve([]);
    }
  };
  vm.runInNewContext(html.slice(start, end + 2) + '\nthis.supabaseSelect = supabaseSelect;', context);

  context.supabaseSelect('MODUL1_Absensi', { select: 'Timestamp' });
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    { table: 'MODUL1_Absensi', options: { query: { select: 'Timestamp' } } }
  ]);
});
