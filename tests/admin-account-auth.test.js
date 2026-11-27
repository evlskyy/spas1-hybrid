const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'supabase/admin_account_usernames_migration.sql'), 'utf8');
const edgeFunction = fs.readFileSync(path.join(root, 'supabase/functions/admin-account-auth/index.ts'), 'utf8');
const config = fs.readFileSync(path.join(root, 'supabase/config.toml'), 'utf8');

test('SUPER ADMIN login resolves usernames server-side and preserves Auth email login', function() {
  const start = html.indexOf("case 'verifyAdminLogin':");
  const end = html.indexOf("\ncase 'verifyModuleLogin':", start);
  const loginSource = html.slice(start, end);

  assert.match(loginSource, /callSupabaseFunction\('admin-account-auth'/);
  assert.match(loginSource, /action:\s*'login'/);
  assert.match(loginSource, /SPAS1_SUPABASE_REFRESH_TOKEN\s*=\s*result\.session\.refresh_token/);
  assert.match(edgeFunction, /if \(!identity\.includes\("@"\)\)/);
  assert.match(edgeFunction, /authClient\.auth\.signInWithPassword\(\{ email, password \}\)/);
  assert.match(edgeFunction, /spas1_admin_login_resolve_email/);
  assert.match(edgeFunction, /hashLoginKey\(userId\)/);
  assert.match(edgeFunction, /data\.user\.app_metadata\?\.role !== "admin"/);
});

test('username and password fields use accessible floating labels on login screens', function() {
  for (const id of ['mnLoginUser', 'mnLoginPass', 'slLoginUser', 'slLoginPass', 'adminUser', 'adminPass', 'loginUsername', 'loginPassword']) {
    assert.match(html, new RegExp('id="' + id + '"[^>]*placeholder=" "'));
    assert.match(html, new RegExp('<label[^>]*for="' + id + '"'));
  }
  assert.match(html, /\.floating-label-field > input:focus \+ label/);
  assert.match(html, /\.floating-label-field > input:not\(:placeholder-shown\) \+ label/);
  assert.match(html, /\.floating-label-field > \.password-toggle-wrap:focus-within \+ label/);
  assert.match(html, /\.password-toggle-wrap:has\(> input:not\(:placeholder-shown\)\) \+ label/);
  assert.match(html, /\.floating-label-field > \.password-toggle-wrap > input \{ padding-top:18px !important;/);
  assert.match(html, /\.floating-label-field > label \{[^}]*background:var\(--floating-label-bg\) !important/);
  assert.match(html, /body\.app-light-mode \.floating-label-field \{ --floating-label-bg:var\(--appearance-raised,#F9FAFB\); \}/);
  assert.match(html, /#spas1-webapp-root \.floating-label-field \{ --floating-label-bg:var\(--card-inner,#0F172A\); \}/);
  assert.match(html, /font-size:12px !important;font-weight:800/);
  assert.match(html, /body\.app-light-mode \.floating-label-field > label \{[^}]*color:#065F46 !important/);
  assert.match(html, /:not\(\.app-light-mode\) \.floating-label-field > label \{ color:var\(--appearance-text\) !important; \}/);
  assert.match(html, /transform:translateY\(-7px\) scale\(\.92\)/);
  assert.match(html, /transition:transform \.18s ease/);
});

test('username updates require the authenticated admin and do not change the Auth email', function() {
  assert.match(html, /id="adminUsernameNew"/);
  assert.match(html, /id="adminRecoveryEmailCurrent"/);
  assert.match(edgeFunction, /user\.app_metadata\?\.role !== "admin"/);
  assert.match(edgeFunction, /action === "set-username"/);
  assert.match(edgeFunction, /\.upsert\(\{[\s\S]*?user_id: user\.id,[\s\S]*?username,/);
  assert.match(edgeFunction, /Email pemulihan tidak berubah/);
  assert.match(migration, /user_id uuid primary key references auth\.users\(id\)/);
  assert.match(migration, /Auth email itself is never changed/i);
});

test('username update requires confirmation before sending the change request', async function() {
  const start = html.indexOf('async function saveAdminUsername()');
  const end = html.indexOf('\nasync function updateAdminRecoveryEmail()', start);
  assert.notEqual(start, -1, 'Missing username update handler');
  assert.notEqual(end, -1, 'Missing username update handler boundary');

  const input = { value: 'New.Admin', focus: function() {} };
  const message = { textContent: '', className: '' };
  const button = { disabled: false, textContent: 'Simpan Username' };
  const calls = [];
  const prompts = [];
  let confirmed = false;
  const context = {
    document: {
      getElementById: function(id) {
        return {
          adminUsernameNew: input,
          adminUsernameMessage: message,
          btnAdminUsernameSave: button
        }[id] || null;
      }
    },
    confirm: function(prompt) {
      prompts.push(prompt);
      return confirmed;
    },
    callSupabaseFunction: function() {
      calls.push(Array.from(arguments));
      return Promise.resolve({ message: 'Username berhasil diperbarui.' });
    }
  };
  vm.runInNewContext(html.slice(start, end), context);

  await context.saveAdminUsername();

  assert.deepEqual(prompts, ['Apakah Anda yakin ingin mengganti username menjadi "new.admin"?']);
  assert.deepEqual(calls, []);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, 'Simpan Username');

  confirmed = true;
  await context.saveAdminUsername();

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'admin-account-auth');
  assert.equal(calls[0][1].action, 'set-username');
  assert.equal(calls[0][1].username, 'new.admin');
  assert.equal(message.textContent, 'Username berhasil diperbarui.');
  assert.equal(button.disabled, false);
});

test('password recovery is available before login and rejects synthetic internal addresses', function() {
  assert.match(html, /id="adminLoginRecoveryEmail"/);
  assert.match(html, /requestAdminPasswordRecovery\('login'\)/);
  assert.match(html, /email\.toLowerCase\(\)\.endsWith\('@admin\.spas1\.local'\)/);
  assert.doesNotMatch(html, /email \+= '@admin\.spas1\.local'/);
});

test('recovery chat opens above the admin login dialog so outside clicks do not dismiss login underneath', function() {
  const loginModalZIndex = Number(html.match(/#modal-admin-login\s*\{\s*z-index:\s*(\d+)/)?.[1]);
  const recoveryChatZIndex = Number(html.match(/\.recovery-chat-overlay\s*\{[^}]*z-index:\s*(\d+)/)?.[1]);

  assert.ok(Number.isFinite(loginModalZIndex));
  assert.ok(Number.isFinite(recoveryChatZIndex));
  assert.ok(recoveryChatZIndex > loginModalZIndex);
  assert.match(html, /id="recoveryChatOverlay"[^>]*onclick="if\(event\.target===this\) closeRecoveryChat\(\)"/);
});

test('admin login dialog closes only through its explicit cancel button, not backdrop clicks', function() {
  const modal = html.match(/<div id="modal-admin-login"[^>]*>/);
  const cancel = html.match(/<button type="button" onclick="tutupAdminLogin\(\)"[^>]*>Batal<\/button>/);
  const closeFunctionStart = html.indexOf('function tutupAdminLogin()');
  const closeFunctionEnd = html.indexOf('\nconst SUPER_ADMIN_WELCOME_STORAGE_KEY', closeFunctionStart);
  const closeFunction = html.slice(closeFunctionStart, closeFunctionEnd);

  assert.ok(modal);
  assert.doesNotMatch(modal[0], /onclick=/);
  assert.ok(cancel);
  assert.match(closeFunction, /toggleAdminLoginRecovery\(false\)/);
  assert.match(closeFunction, /adminLoginRecoveryEmail'\)\.value = ''/);
  assert.match(closeFunction, /adminLoginRecoveryMessage'\);[\s\S]*?recoveryMessage\.textContent = ''/);
});

test('admin username migration keeps mappings private and throttles failed login attempts', function() {
  assert.match(migration, /alter table public\.spas1_admin_usernames enable row level security/i);
  assert.match(migration, /revoke all on public\.spas1_admin_usernames from public, anon, authenticated/i);
  assert.match(migration, /failed_attempts[\s\S]*>= 5/);
  assert.match(migration, /interval '15 minutes'/);
  assert.match(edgeFunction, /spas1_admin_login_is_locked/);
  assert.match(edgeFunction, /spas1_admin_login_record_failure/);
  assert.match(edgeFunction, /spas1_admin_login_clear/);
  assert.match(migration, /spas1_admin_login_resolve_email\(p_email text\)/);
  assert.match(migration, /grant execute on function public\.spas1_admin_login_resolve_email\(text\) to service_role/i);
  assert.match(config, /\[functions\.admin-account-auth\]\s+verify_jwt = false/);
});
