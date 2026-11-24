const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'supabase/module_account_access_migration.sql'), 'utf8');
const edgeFunction = fs.readFileSync(path.join(root, 'supabase/functions/module-account-admin/index.ts'), 'utf8');

test('SUPER AKSES provides individual module accounts with explicit module selections', function() {
  assert.match(html, /id="nav-tab-module-access"/);
  assert.match(html, /id="tab-module-access"/);
  assert.match(html, /id="moduleAccountEmployee"/);
  assert.match(html, /id="moduleAccountUsername"/);
  assert.match(html, /name="moduleAccountPermission" value="stok"/);
  assert.match(html, /name="moduleAccountPermission" value="bank_menu"/);
  assert.match(html, /name="moduleAccountPermission" value="persiapan"/);
  assert.match(html, /Password tidak ditampilkan kembali atau disimpan sebagai teks biasa/);
});

test('module login is authorized by the server before entering a module', function() {
  const start = html.indexOf("case 'verifyModuleLogin':");
  const end = html.indexOf("\ncase 'verifySyncPassword':", start);
  const loginSource = html.slice(start, end);

  assert.match(loginSource, /callSupabaseFunction\('module-account-admin', \{ action: 'verifyLogin', module: module \}\)/);
  assert.match(loginSource, /clearSupabaseSession\(\)/);
  assert.match(loginSource, /window\.SPAS1_AUTH_ROLE = module/);
  assert.match(edgeFunction, /input\.action === "verifyLogin"/);
  assert.match(edgeFunction, /employee\["Status Akun"\] !== "Aktif"/);
});

test('module account provisioning uses Supabase Auth and does not store passwords in the account table', function() {
  assert.match(edgeFunction, /admin\.createUser\(\{/);
  assert.match(edgeFunction, /admin\.updateUserById\(/);
  assert.match(edgeFunction, /email_confirm: true/);
  assert.match(edgeFunction, /password,/);
  assert.doesNotMatch(edgeFunction, /password:\s*password\s*,\s*status:/);
  assert.match(edgeFunction, /\.from\("spas1_module_accounts"\)[\s\S]*?module_access:\s*modules/);
});

test('database policies enforce module-specific grants and active staff status', function() {
  assert.match(migration, /create or replace function public\.spas1_has_module_access\(p_module text\)/);
  assert.match(migration, /module_account\.module_access @> array\[p_module\]::text\[\]/);
  assert.match(migration, /employee\."Status Akun" = 'Aktif'/);
  assert.match(migration, /public\.spas1_has_module_access\('bank_menu'\)/);
  assert.match(migration, /public\.spas1_has_module_access\('stok'\)/);
  assert.match(migration, /public\.spas1_has_module_access\('persiapan'\)/);
  assert.match(migration, /Expected authorization guard was not found/);
});
