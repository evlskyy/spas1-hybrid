const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

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
