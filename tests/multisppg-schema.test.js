const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'supabase_multisppg_migration.sql'), 'utf8');
const stockMigration = fs.readFileSync(path.join(root, 'supabase_migration.sql'), 'utf8');
const stockConversionMigration = fs.readFileSync(path.join(root, 'supabase_stock_conversion_migration.sql'), 'utf8');
const volunteerFunction = fs.readFileSync(path.join(root, 'supabase/functions/volunteer-registration/index.ts'), 'utf8');
const emptyTenantMigration = fs.readFileSync(path.join(root, 'supabase/tenant_empty_defaults_migration.sql'), 'utf8');
const onboardingPermissionsMigration = fs.readFileSync(path.join(root, 'supabase/sppg_onboarding_permissions_migration.sql'), 'utf8');

function quotedNames(source) {
  return Array.from(source.matchAll(/'([^']+)'/g), function(match) { return match[1]; });
}

test('frontend and tenant migration cover the same operational tables', function() {
  const clientStart = html.indexOf('const SPAS1_TENANT_SCOPED_TABLES = new Set([');
  const clientEnd = html.indexOf(']);', clientStart);
  const migrationMatch = migration.match(/tenant_tables text\[\] := array\[([\s\S]*?)\];/);
  assert.notEqual(clientStart, -1, 'client tenant table list should exist');
  assert.notEqual(clientEnd, -1, 'client tenant table list should close');
  assert.ok(migrationMatch, 'migration tenant table list should exist');

  assert.deepEqual(
    quotedNames(html.slice(clientStart, clientEnd)).sort(),
    quotedNames(migrationMatch[1]).sort()
  );
});

test('tenant migration preserves existing rows and adds restrictive tenant checks', function() {
  assert.match(migration, /update public\.%I set sppg_id = %L::uuid where sppg_id is null/i);
  assert.match(migration, /rename column sppg_td to sppg_id/i);
  assert.match(migration, /drop column sppg_td/i);
  assert.match(migration, /as restrictive for all to anon, authenticated/i);
  assert.match(migration, /create trigger .*before insert or update or delete/i);
  assert.match(migration, /Cross-SPPG data access is not allowed/);
  assert.doesNotMatch(migration, /\btruncate\b|\bdelete\s+from\s+public\./i);
});

test('tenant-specific upsert indexes cover settings, reports, and state tables', function() {
  assert.match(migration, /SPAS1_SETTINGS_sppg_Pengaturan_key[\s\S]*?\(sppg_id, "Pengaturan"\)/);
  assert.match(migration, /spas1_lpdh_reports_sppg_date_key[\s\S]*?\(sppg_id, report_date\)/);
  assert.match(migration, /spas1_lpj_reports_sppg_date_key[\s\S]*?\(sppg_id, report_date\)/);
  assert.match(migration, /sppg_id, "AppKey"/);
});

test('stock RPCs scope protected table access and receipt paths to the active SPPG', function() {
  const stockFunctions = [
    'record_stok_logistik_movement',
    'record_stok_logistik_daily_purchase',
    'record_stok_logistik_kitchen_usage',
    'return_stok_logistik_kitchen_remainder',
    'void_stok_logistik_transaction'
  ];

  for (const name of stockFunctions) {
    const start = stockMigration.indexOf('create or replace function public.' + name + '(');
    assert.notEqual(start, -1, name + ' should exist in the full migration');
    const end = stockMigration.indexOf('\n$$;', start);
    assert.notEqual(end, -1, name + ' should have a closed function body');
    const body = stockMigration.slice(start, end);

    assert.match(body, /v_sppg_id uuid := public\.spas1_current_sppg_id\(\)/, name + ' should resolve the active SPPG');
    assert.match(body, /sppg_id\s*=\s*v_sppg_id/, name + ' should filter rows by SPPG');
    assert.doesNotMatch(body, /\^spas1\/stok-logistik\//, name + ' should not hard-code the legacy receipt folder');
  }

  for (const name of stockFunctions.slice(0, 4)) {
    const start = stockConversionMigration.indexOf('create or replace function public.' + name + '(');
    assert.notEqual(start, -1, name + ' should exist in the stock conversion migration');
    const end = stockConversionMigration.indexOf('\n$$;', start);
    assert.notEqual(end, -1, name + ' should have a closed conversion function body');
    const body = stockConversionMigration.slice(start, end);

    assert.match(body, /v_sppg_id uuid := public\.spas1_current_sppg_id\(\)/, name + ' should resolve the active SPPG');
    assert.match(body, /sppg_id\s*=\s*v_sppg_id/, name + ' should filter rows by SPPG');
    assert.doesNotMatch(body, /\^spas1\/stok-logistik\//, name + ' should not hard-code the legacy receipt folder');
  }
});

test('volunteer Edge Function authorizes and scopes service-role actions by active membership', function() {
  assert.match(volunteerFunction, /\.from\("spas1_memberships"\)[\s\S]*?\.eq\("user_id", user\.id\)/);
  assert.match(volunteerFunction, /membership\.status !== "active"/);
  assert.match(volunteerFunction, /claimedSppgId\.toLowerCase\(\) !== sppgId\.toLowerCase\(\)/);
  assert.match(volunteerFunction, /membership\.member_role !== "admin"/);
  assert.match(volunteerFunction, /recordAttendance\(input, user\.id, sppgId, adminClient, origin\)/);
  assert.match(volunteerFunction, /\.from\("MODUL1_DataRelawan"\)[\s\S]*?\.eq\("sppg_id", sppgId\)[\s\S]*?\.eq\("Auth User ID", authUserId\)/);
  assert.match(volunteerFunction, /member_role: "employee",\s+status: "suspended"/);
  assert.match(volunteerFunction, /const sppgId = String\(input\.sppgId \|\| ""\)/);
  assert.doesNotMatch(volunteerFunction, /legacySppgId/);
});

test('SPPG invite and recovery links open the password setup form', function() {
  assert.match(volunteerFunction, /submitOrganizationRequest[\s\S]*?reviewOrganizationRequest\([\s\S]*?decision: "approve"[\s\S]*?null,/);
  assert.match(volunteerFunction, /inviteUserByEmail\(/);
  assert.match(volunteerFunction, /member_role: "admin",\s+status: "active"/);
  assert.match(volunteerFunction, /SPPG berhasil diaktifkan/);
  assert.match(html, /SPPG akan langsung diaktifkan setelah verifikasi/);
  assert.match(html, /Pilih SPPG tempat Anda bertugas/);
  assert.match(html, /sppgId: document\.getElementById\('registrationSppgId'\)\.value/);
  assert.match(html, /const isInvite = type === 'invite';\s+const isRecovery = type === 'recovery';/);
  assert.match(html, /function initializeInvitePasswordSetup\(\)[\s\S]*?if \(!isInvite && !isRecovery && !linkError\) return;[\s\S]*?function saveInvitePassword\(\)[\s\S]*?\/auth\/v1\/user/);
  assert.match(html, /passwordSetupType === 'recovery'/);
});

test('SPPG onboarding grants database access only to the server role', function() {
  for (const table of [
    'spas1_organizations',
    'spas1_memberships',
    'spas1_organization_requests',
    'spas1_organization_regions'
  ]) {
    assert.match(onboardingPermissionsMigration, new RegExp(
      'grant select, insert, update, delete on public\\.' + table + ' to service_role;', 'i'
    ));
  }
  assert.doesNotMatch(onboardingPermissionsMigration, /to\s+(?:public|anon|authenticated)\b/i);
});

test('new tenant starts empty and local module data is isolated by authenticated SPPG', function() {
  assert.match(html, /globalTargetPorsi = 0;\s+porsiBesar = 0;\s+porsiKecil = 0;\s+defaultMenus = \{\};\s+defaultBudget = \{\};\s+defaultTasks = \[\];/);
  assert.match(html, /function module4StorageKey\(tenantId\)[\s\S]*?STORAGE_KEY \+ ':' \+ tenantId/);
  assert.match(html, /function loadAppDataFromCloud\(\)[\s\S]*?if \(!tenantId\) return;[\s\S]*?localStorage\.getItem\(key\)/);
  assert.doesNotMatch(html, /localStorage\.getItem\(STORAGE_KEY\)/);
});

test('empty-tenant migration refuses to remove legacy data and removes implicit defaults', function() {
  assert.match(emptyTenantMigration, /Legacy SPPG has users or memberships/);
  assert.match(emptyTenantMigration, /Legacy SPPG has operational rows/);
  assert.match(emptyTenantMigration, /Legacy SPPG has Storage files/);
  assert.match(emptyTenantMigration, /delete from public\.spas1_organizations/);
  assert.match(emptyTenantMigration, /alter column sppg_id set default public\.spas1_current_sppg_id\(\)/);
  assert.match(emptyTenantMigration, /auth\.uid\(\) is not null and sppg_id = public\.spas1_current_sppg_id\(\)/);
  assert.match(emptyTenantMigration, /select public\.spas1_current_sppg_id\(\)::text/);
});

test('organization approval controls are platform-admin-only and invoke the review workflow', function() {
  assert.match(html, /id="nav-tab-organization-requests" class="hidden/);
  assert.match(html, /function hasPlatformAdminClaim\(\)[\s\S]*?app_metadata\.platform_admin === true/);
  assert.match(html, /if \(tabId === 'tab-organization-requests' && !hasPlatformAdminClaim\(\)\)/);
  assert.match(html, /function loadOrganizationRequests\(btn\)[\s\S]*?fetchOrganizationRequests/);
  assert.match(html, /function reviewOrganizationRequest\(requestId, decision, approveButton, rejectButton\)[\s\S]*?reviewOrganizationRequest/);
  assert.match(volunteerFunction, /input\.action === "listOrganizationRequests" \|\| input\.action === "reviewOrganizationRequest"[\s\S]*?user\.app_metadata\?\.platform_admin !== true/);
  assert.match(volunteerFunction, /if \(input\.action === "listOrganizationRequests"\) return await listOrganizationRequests/);
});
