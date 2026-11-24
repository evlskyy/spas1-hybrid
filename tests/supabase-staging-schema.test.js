const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const baseline = fs.readFileSync(path.join(root, 'supabase/staging_schema_baseline.sql'), 'utf8');
const verifier = fs.readFileSync(path.join(root, 'supabase/staging_verify.sql'), 'utf8');
const tenantMigration = fs.readFileSync(path.join(root, 'supabase_multisppg_migration.sql'), 'utf8');
const emptyTenantMigration = fs.readFileSync(path.join(root, 'supabase/tenant_empty_defaults_migration.sql'), 'utf8');

function namesFrom(source, pattern) {
  return Array.from(source.matchAll(pattern), function(match) {
    return match[1] || match[2];
  });
}

test('staging baseline contains no row data and only standard SQL', function() {
  assert.doesNotMatch(baseline, /^COPY public\./m);
  assert.doesNotMatch(baseline, /^-- Data for Name:/m);
  assert.doesNotMatch(baseline, /^\\(?:restrict|unrestrict)\b/m);
  assert.doesNotMatch(baseline, /CREATE FUNCTION public\.rls_auto_enable\(/i);
  assert.doesNotMatch(baseline, /^ALTER DEFAULT PRIVILEGES/m);
  assert.match(baseline, /CREATE SCHEMA IF NOT EXISTS public;/);
});

test('staging baseline provides RLS for every table required by tenant migration', function() {
  const tenantTablesMatch = tenantMigration.match(/tenant_tables text\[\] := array\[([\s\S]*?)\];/);
  assert.ok(tenantTablesMatch, 'tenant migration table list should exist');

  const requiredTables = new Set(
    Array.from(tenantTablesMatch[1].matchAll(/'([^']+)'/g), function(match) { return match[1]; })
  );
  const createdTables = new Set(namesFrom(
    baseline,
    /CREATE TABLE public\.(?:"([^"]+)"|([a-zA-Z0-9_]+))/gi
  ));
  const rlsTables = new Set(namesFrom(
    baseline,
    /ALTER TABLE (?:ONLY )?public\.(?:"([^"]+)"|([a-zA-Z0-9_]+)) ENABLE ROW LEVEL SECURITY/gi
  ));

  for (const table of requiredTables) {
    assert.ok(createdTables.has(table), 'baseline should create public.' + table);
    assert.ok(rlsTables.has(table), 'baseline should enable RLS on public.' + table);
  }
});

test('staging verification script is read-only and checks tenant isolation', function() {
  assert.doesNotMatch(verifier, /^\s*(?:insert|update|delete|alter|create|drop|grant|revoke)\b/im);
  assert.match(verifier, /restrictive_tenant_policy/);
  assert.match(verifier, /spas1_current_sppg_id/);
  assert.match(verifier, /legacy_sppg_removed/);
  assert.match(verifier, /no_legacy_tenant_defaults/);
  assert.match(emptyTenantMigration, /Legacy SPPG has operational rows/);
  assert.match(verifier, /spas1-lpdh/);
});
