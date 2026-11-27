const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'supabase/module_account_access_migration.sql'), 'utf8');
const edgeFunction = fs.readFileSync(path.join(root, 'supabase/functions/module-account-admin/index.ts'), 'utf8');

test('SUPER AKSES provides individual module accounts with explicit module selections', function() {
  assert.match(html, /id="nav-tab-module-access"/);
  assert.match(html, /id="tab-module-access"/);
  assert.match(html, /id="moduleAccountEmployee"/);
  assert.match(html, /id="moduleAccountUsername"/);
  assert.match(html, /Username singkat untuk login[\s\S]*placeholder="contoh: iamsky"[\s\S]*Gunakan username saja, tanpa domain email/);
  assert.match(html, /name="moduleAccountPermission" value="stok"/);
  assert.match(html, /name="moduleAccountPermission" value="bank_menu"/);
  assert.match(html, /name="moduleAccountPermission" value="persiapan"/);
  assert.match(html, /Password tidak ditampilkan kembali atau disimpan sebagai teks biasa/);
});

test('module usernames are displayed without the internal Supabase Auth domain', function() {
  assert.match(html, /escapeHtml\(account\.username \|\| ''\) \+ '<\/td>'/);
  assert.doesNotMatch(html, /escapeHtml\(account\.username \|\| ''\) \+ '@module\.spas1\.local'/);
  assert.match(html, /supabaseLogin\(payload\.username, payload\.password, '@module\.spas1\.local'\)/);
  assert.match(edgeFunction, /const email = `\$\{username\}@module\.spas1\.local`;/);
});

test('SUPER ADMIN can enter every module using the existing authenticated account', function() {
  const start = html.indexOf('function bukaModul(modulId)');
  const end = html.indexOf('\nfunction kembaliKeHome()', start);
  const moduleAccess = html.slice(start, end);

  assert.match(html, /SUPER ADMIN yang sudah login dapat mengakses semua modul tanpa akun tambahan/);
  assert.match(html, /onclick="kembaliKeHome\(\)"[^>]*>[\s\S]*<span>Menu Utama<\/span>/);
  assert.match(moduleAccess, /\['admin', 'bank_menu'\]\.indexOf\(window\.SPAS1_AUTH_ROLE\) === -1/);
  assert.match(moduleAccess, /\['admin', 'stok', 'persiapan'\]\.indexOf\(window\.SPAS1_AUTH_ROLE\) === -1/);
  assert.match(moduleAccess, /\['admin', 'persiapan'\]\.indexOf\(window\.SPAS1_AUTH_ROLE\) !== -1/);
  assert.match(html, /id="mnLoginAdminSubmit"[^>]*onclick="verifyMnLogin\(true\)"/);
  assert.match(html, /id="slLoginAdminSubmit"[^>]*onclick="verifySlLogin\(true\)"/);
  assert.match(html, /id="portalAdminLoginSubmit"[^>]*onclick="handleLogin\(true\)"/);
  assert.match(html, /const loginAsAdmin = payload\.loginAsAdmin === true/);
  assert.match(html, /callSupabaseFunction\('admin-account-auth', \{\s*action: 'login',\s*username: payload\.username,\s*password: payload\.password/);
  assert.match(html, /window\.SPAS1_AUTH_ROLE = loginAsAdmin \? 'admin' : module/);
  assert.match(edgeFunction, /user\.app_metadata\?\.role === "admin" && membership\.member_role === "admin"/);
  assert.match(migration, /when auth\.jwt\(\) -> 'app_metadata' ->> 'role' = 'admin' then/);
});

test('returning home preserves the SUPER ADMIN session for switching modules', function() {
  const start = html.indexOf('function logoutMnPortal()');
  const end = html.indexOf('\nfunction generateMenuNusantara()', start);
  const logoutSource = html.slice(start, end);
  assert.notEqual(start, -1, 'Missing module logout handlers');
  assert.notEqual(end, -1, 'Missing module logout handler boundary');

  const adminCalls = [];
  const adminContext = {
    window: {
      SPAS1_AUTH_ROLE: 'admin',
      SPAS1_AUTH_TOKEN: 'admin-token',
      SPAS1_SUPABASE_SESSION: 'admin-session'
    },
    callSupabaseAction: function() { adminCalls.push(Array.from(arguments)); }
  };
  vm.runInNewContext(logoutSource, adminContext);
  adminContext.logoutMnPortal();
  adminContext.logoutSlPortal();
  assert.deepEqual(adminCalls, []);
  assert.equal(adminContext.window.SPAS1_AUTH_ROLE, 'admin');
  assert.equal(adminContext.window.SPAS1_AUTH_TOKEN, 'admin-token');

  const moduleCalls = [];
  const moduleContext = {
    window: {
      SPAS1_AUTH_ROLE: 'stok',
      SPAS1_AUTH_TOKEN: 'module-token',
      SPAS1_SUPABASE_SESSION: 'module-session'
    },
    callSupabaseAction: function() { moduleCalls.push(Array.from(arguments)); }
  };
  vm.runInNewContext(logoutSource, moduleContext);
  moduleContext.logoutMnPortal();
  assert.equal(moduleCalls.length, 1);
  assert.equal(moduleContext.window.SPAS1_AUTH_ROLE, '');
  assert.equal(moduleContext.window.SPAS1_AUTH_TOKEN, '');
});

test('SUPER ADMIN sync reauthentication uses the existing username login flow', function() {
  assert.match(html, /const isAdminSync = action === 'verifySyncPassword' && window\.SPAS1_AUTH_ROLE === 'admin'/);
  assert.match(html, /callSupabaseFunction\('admin-account-auth', \{\s*action: 'login',\s*username: identity,\s*password: password/);
  assert.match(html, /window\.SPAS1_AUTH_ROLE = isAdminSync \? 'admin' : requestedModule/);
});

test('module login is authorized by the server before entering a module', function() {
  const start = html.indexOf("case 'verifyModuleLogin':");
  const end = html.indexOf("\ncase 'verifySyncPassword':", start);
  const loginSource = html.slice(start, end);

  assert.match(loginSource, /callSupabaseFunction\('module-account-admin', \{ action: 'verifyLogin', module: module \}\)/);
  assert.match(loginSource, /clearSupabaseSession\(\)/);
  assert.match(loginSource, /window\.SPAS1_AUTH_ROLE = loginAsAdmin \? 'admin' : module/);
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
