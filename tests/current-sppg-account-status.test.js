const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const functionStart = html.indexOf('async function loadCurrentSppgAccountStatus()');
const functionEnd = html.indexOf('\nfunction applySupabaseTenantScope', functionStart);
const source = html.slice(functionStart, functionEnd);
const sppgId = '74224e55-2ec7-4ab1-81ea-3d4d13e1d0bc';

function createClassList(initialClasses) {
  const classes = new Set(initialClasses || []);
  return {
    add: function(name) { classes.add(name); },
    remove: function(name) { classes.delete(name); },
    contains: function(name) { return classes.has(name); }
  };
}

function createHarness(options) {
  const status = {
    classList: createClassList(['hidden']),
    style: { color: '' },
    textContent: ''
  };
  const requests = [];
  const errors = [];
  const context = {
    window: {
      SPAS1_AUTH_ROLE: 'admin',
      SPAS1_SUPABASE_SESSION: 'signed-in-token',
      SPAS1_SUPABASE_URL: 'https://test.supabase.co'
    },
    document: {
      getElementById: function(id) {
        return id === 'currentSppgAccountStatus' ? status : null;
      }
    },
    fetch: async function(url, requestOptions) {
      assert.equal(url, 'https://test.supabase.co/auth/v1/user');
      assert.equal(requestOptions.method, 'GET');
      if (options.fetchError) throw options.fetchError;
      return {
        ok: true,
        json: async function() { return options.user; }
      };
    },
    supabaseHeaders: function() { return { Authorization: 'Bearer signed-in-token' }; },
    getSupabaseTenantId: function() { return sppgId; },
    supabaseRequest: async function(table, requestOptions) {
      requests.push({ table, requestOptions });
      if (table === 'spas1_memberships') return options.memberships;
      if (table === 'spas1_organizations') return options.organizations;
      throw new Error('Unexpected table: ' + table);
    },
    console: {
      error: function(message, error) { errors.push({ message, error }); }
    }
  };
  vm.runInNewContext(source, context);
  return { context, status, requests, errors };
}

function createUser(overrides) {
  return Object.assign({
    id: 'auth-user-id',
    email_confirmed_at: '2026-11-25T00:00:00.000Z',
    app_metadata: { role: 'admin', sppg_id: sppgId }
  }, overrides || {});
}

test('active current SPPG is shown only for a verified admin with active membership and organization', async function() {
  const harness = createHarness({
    user: createUser(),
    memberships: [{ sppg_id: sppgId, member_role: 'admin', status: 'active' }],
    organizations: [{ id: sppgId, name: 'SPPG Sungai Pasir 1', status: 'active' }]
  });

  await harness.context.loadCurrentSppgAccountStatus();

  assert.equal(harness.status.classList.contains('hidden'), false);
  assert.equal(harness.status.textContent, 'SPPG Sungai Pasir 1 aktif · email admin terverifikasi');
  assert.deepEqual(harness.requests.map(function(request) { return request.table; }), [
    'spas1_memberships',
    'spas1_organizations'
  ]);
});

test('unverified email and inactive membership or organization do not show an active SPPG status', async function() {
  const unverified = createHarness({
    user: createUser({ email_confirmed_at: null }),
    memberships: [{ sppg_id: sppgId, member_role: 'admin', status: 'active' }],
    organizations: [{ id: sppgId, name: 'SPPG', status: 'active' }]
  });
  await unverified.context.loadCurrentSppgAccountStatus();
  assert.equal(unverified.status.classList.contains('hidden'), true);
  assert.equal(unverified.requests.length, 0);

  const inactiveMembership = createHarness({
    user: createUser(),
    memberships: [{ sppg_id: sppgId, member_role: 'admin', status: 'suspended' }],
    organizations: [{ id: sppgId, name: 'SPPG', status: 'active' }]
  });
  await inactiveMembership.context.loadCurrentSppgAccountStatus();
  assert.equal(inactiveMembership.status.classList.contains('hidden'), true);
  assert.deepEqual(inactiveMembership.requests.map(function(request) { return request.table; }), [
    'spas1_memberships'
  ]);

  const inactiveOrganization = createHarness({
    user: createUser(),
    memberships: [{ sppg_id: sppgId, member_role: 'admin', status: 'active' }],
    organizations: [{ id: sppgId, name: 'SPPG', status: 'suspended' }]
  });
  await inactiveOrganization.context.loadCurrentSppgAccountStatus();
  assert.equal(inactiveOrganization.status.classList.contains('hidden'), true);
});

test('status lookup errors are shown without claiming the SPPG is active', async function() {
  const harness = createHarness({ fetchError: new Error('Network unavailable') });

  await harness.context.loadCurrentSppgAccountStatus();

  assert.equal(harness.status.classList.contains('hidden'), false);
  assert.match(harness.status.textContent, /tidak dapat diverifikasi/);
  assert.equal(harness.status.style.color, '#b45309');
  assert.equal(harness.errors.length, 1);
});

test('source and deployed HTML both contain the current SPPG status indicator', function() {
  for (const relativePath of ['index.html', 'dist/index.html']) {
    const deployedHtml = fs.readFileSync(path.join(root, relativePath), 'utf8');
    assert.match(deployedHtml, /id="currentSppgAccountStatus"/, relativePath);
    assert.match(deployedHtml, /loadCurrentSppgAccountStatus\(\)/, relativePath);
    const versionBadgeIndex = deployedHtml.indexOf('SPAS1 Version 2.2.2 Hybrid</span>');
    const statusIndex = deployedHtml.indexOf('id="currentSppgAccountStatus"');
    const adminSidebarIndex = deployedHtml.indexOf('<div id="view-admin"');
    assert.ok(versionBadgeIndex >= 0 && statusIndex > versionBadgeIndex, relativePath + ' should place status after the version badge');
    assert.ok(adminSidebarIndex < 0 || statusIndex < adminSidebarIndex, relativePath + ' should not place status in the SUPER ADMIN sidebar');
  }
});

test('public SUPER ADMIN card uses generic access text, not an account status', function() {
  const card = html.match(/<button id="btnSuperAdminLogin"[\s\S]*?<\/button>/);
  assert.ok(card, 'SUPER ADMIN card should exist');
  assert.match(card[0], /Akses khusus administrator/);
  assert.doesNotMatch(card[0], /SPPG|email admin terverifikasi/i);
});
