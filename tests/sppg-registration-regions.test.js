const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const edgeFunction = fs.readFileSync(path.join(root, 'supabase/functions/volunteer-registration/index.ts'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'supabase/sppg_region_migration.sql'), 'utf8');
const routeSource = fs.readFileSync(path.join(root, 'functions/api/regions.js'), 'utf8');

function loadRegionsRoute(fetchImpl) {
  const module = { exports: {} };
  const source = routeSource.replace(
    'export async function onRequestGet',
    'async function onRequestGet'
  ) + '\nmodule.exports = { onRequestGet };';
  vm.runInNewContext(source, {
    AbortController,
    URL,
    URLSearchParams,
    Response,
    clearTimeout,
    console: { error() {} },
    fetch: fetchImpl,
    module,
    setTimeout
  });
  return module.exports.onRequestGet;
}

test('SPPG form offers required cascading administrative regions and a generated editable slug', function() {
  assert.match(html, /id="sppgApplicationProvince" required/);
  assert.match(html, /id="sppgApplicationRegency" required/);
  assert.match(html, /id="sppgApplicationDistrict" required/);
  assert.match(html, /function updateSppgApplicationSlug\(\)/);
  assert.match(html, /sppgApplicationSlugEdited = true/);
  assert.match(html, /submittedSlug\.slice\(0, 63\)/);
  assert.match(html, /provinceCode: province\.value/);
  assert.match(html, /districtName: district\.selectedOptions\[0\]\.textContent\.trim\(\)/);
});

test('same-origin region proxy rejects unsupported levels and malformed parent codes', async function() {
  let fetchCalls = 0;
  const onRequestGet = loadRegionsRoute(async function() {
    fetchCalls += 1;
    return new Response('{}');
  });
  const invalidLevel = await onRequestGet({
    request: new Request('https://spas1-hybrid.pages.dev/api/regions?level=other')
  });
  const invalidParent = await onRequestGet({
    request: new Request('https://spas1-hybrid.pages.dev/api/regions?level=districts&parentCode=31%2F71')
  });
  assert.equal(invalidLevel.status, 400);
  assert.equal(invalidParent.status, 400);
  assert.equal(fetchCalls, 0);
});

test('same-origin region proxy returns normalized child regions and rejects mismatched hierarchy data', async function() {
  let requestedUrl = '';
  const onRequestGet = loadRegionsRoute(async function(url) {
    requestedUrl = url;
    return new Response(JSON.stringify({
      data: [{ code: '31.74.01', name: ' Tebet ' }],
      meta: { updated_at: '2025-07-04' }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const response = await onRequestGet({
    request: new Request('https://spas1-hybrid.pages.dev/api/regions?level=districts&parentCode=31.74')
  });
  const result = await response.json();
  assert.equal(requestedUrl, 'https://wilayah.id/api/districts/31.74.json');
  assert.deepEqual(result.data, [{ code: '31.74.01', name: 'Tebet' }]);
  assert.equal(result.source, 'wilayah.id');
  assert.equal(result.updatedAt, '2025-07-04');

  const invalidHierarchyRoute = loadRegionsRoute(async function() {
    return new Response(JSON.stringify({ data: [{ code: '32.74.01', name: 'Tebet' }] }), { status: 200 });
  });
  const invalidHierarchy = await invalidHierarchyRoute({
    request: new Request('https://spas1-hybrid.pages.dev/api/regions?level=districts&parentCode=31.74')
  });
  assert.equal(invalidHierarchy.status, 502);
});

test('same-origin region proxy reports upstream HTTP status without exposing its response body', async function() {
  let fetchOptions;
  const onRequestGet = loadRegionsRoute(async function(url, options) {
    fetchOptions = options;
    return new Response('upstream details must remain private', {
      status: 302,
      headers: { Location: 'https://wilayah.id/redirected' }
    });
  });
  const response = await onRequestGet({
    request: new Request('https://spas1-hybrid.pages.dev/api/regions?level=provinces')
  });
  assert.equal(response.status, 502);
  assert.equal(fetchOptions.redirect, 'manual');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await response.json(), {
    error: 'Sumber data wilayah sementara tidak tersedia.',
    upstreamStatus: 302
  });
});

test('Edge Function validates and stores regions privately for the SPPG and its request', function() {
  for (const column of [
    'province_code', 'province_name', 'regency_code', 'regency_name', 'district_code', 'district_name'
  ]) {
    assert.match(migration, new RegExp('add column if not exists ' + column));
    assert.ok(edgeFunction.includes(column + ': '));
  }
  assert.match(edgeFunction, /regencyCode\.startsWith\(`\$\{provinceCode\}\.`\)/);
  assert.match(edgeFunction, /districtCode\.startsWith\(`\$\{regencyCode\}\.`\)/);
  assert.match(edgeFunction, /\.from\("spas1_organization_regions"\)\.insert\(/);
  assert.match(edgeFunction, /province_code: requestRow\.province_code/);
  assert.match(edgeFunction, /district_name: requestRow\.district_name/);
  assert.doesNotMatch(migration, /alter table public\.spas1_organizations[\s\S]*?add column if not exists province_code/);
  assert.match(migration, /enable row level security/);
  assert.match(migration, /revoke all on public\.spas1_organization_regions from public, anon, authenticated/);
  assert.match(migration, /grant all on public\.spas1_organization_regions to service_role/);
  assert.match(migration, /organization_id = public\.spas1_current_sppg_id\(\)/);
  assert.match(migration, /'platform_admin'\) = 'true'/);
});
