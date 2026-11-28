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

function createStatusNode() {
  let statusText = '';
  return {
    children: [],
    classList: createClassList(['hidden']),
    style: { color: '' },
    set textContent(value) {
      statusText = String(value || '');
      this.children = [];
    },
    get textContent() {
      return this.children.length
        ? this.children.map(function(child) { return child.textContent; }).join(' · ')
        : statusText;
    },
    replaceChildren: function() {
      this.children = Array.from(arguments);
      statusText = '';
    }
  };
}

function createHarness(options) {
  const status = createStatusNode();
  const identityStatusIds = [
    'employeeSppgIdentityStatus',
    'mnSppgIdentityStatus',
    'slSppgIdentityStatus',
    'preparationSppgIdentityStatus'
  ];
  const identityStatuses = new Map(identityStatusIds.map(function(id) {
    return [id, createStatusNode()];
  }));
  let currentTenantId = sppgId;
  const functionCalls = [];
  const requests = [];
  const errors = [];
  let publicSiteSettingsLoads = 0;
  const context = {
    window: {
      SPAS1_AUTH_ROLE: 'admin',
      SPAS1_SUPABASE_SESSION: 'signed-in-token',
      SPAS1_SUPABASE_URL: 'https://test.supabase.co'
    },
    document: {
      createElement: function(tagName) { return { tagName: tagName, className: '', textContent: '' }; },
      getElementById: function(id) {
        if (id === 'currentSppgAccountStatus') return status;
        return identityStatuses.get(id) || null;
      }
    },
    loadPublicSiteSettings: function() { publicSiteSettingsLoads += 1; },
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
    getSupabaseTenantId: function() { return currentTenantId; },
    callSupabaseFunction: async function(functionName, payload) {
      functionCalls.push({ functionName: functionName, payload: payload });
      if (options.functionError) throw options.functionError;
      if (options.functionPromise) return options.functionPromise;
      return options.tenantStatusResult;
    },
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
  return {
    context,
    status,
    identityStatuses,
    functionCalls,
    requests,
    errors,
    publicSiteSettingsLoads: function() { return publicSiteSettingsLoads; },
    setTenantId: function(value) { currentTenantId = value; }
  };
}

function createUser(overrides) {
  return Object.assign({
    id: 'auth-user-id',
    email_confirmed_at: '2026-11-25T00:00:00.000Z',
    app_metadata: { role: 'admin', sppg_id: sppgId }
  }, overrides || {});
}

test('active current SPPG and verified email are shown as separate status labels', async function() {
  const harness = createHarness({
    user: createUser(),
    memberships: [{ sppg_id: sppgId, member_role: 'admin', status: 'active' }],
    organizations: [{ id: sppgId, name: 'SPPG Sungai Pasir 1', status: 'active' }]
  });

  await harness.context.loadCurrentSppgAccountStatus();

  assert.equal(harness.status.classList.contains('hidden'), false);
  assert.equal(harness.status.textContent, 'SPPG Sungai Pasir 1 · SPPG aktif · Email admin terverifikasi');
  assert.match(harness.status.children[1].className, /text-emerald-300/);
  assert.match(harness.status.children[2].className, /text-emerald-300/);
  assert.deepEqual(harness.requests.map(function(request) { return request.table; }), [
    'spas1_memberships',
    'spas1_organizations'
  ]);
});

test('unverified email is shown distinctly while inactive membership or organization remains hidden', async function() {
  const unverified = createHarness({
    user: createUser({ email_confirmed_at: null }),
    memberships: [{ sppg_id: sppgId, member_role: 'admin', status: 'active' }],
    organizations: [{ id: sppgId, name: 'SPPG', status: 'active' }]
  });
  await unverified.context.loadCurrentSppgAccountStatus();
  assert.equal(unverified.status.classList.contains('hidden'), false);
  assert.equal(unverified.status.children[1].textContent, 'SPPG aktif');
  assert.equal(unverified.status.children[2].textContent, 'Email admin belum terverifikasi');
  assert.match(unverified.status.children[2].className, /text-amber-200/);
  assert.deepEqual(unverified.requests.map(function(request) { return request.table; }), [
    'spas1_memberships',
    'spas1_organizations'
  ]);

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

test('module and relawan identity badges use the server-verified tenant status', async function() {
  const harness = createHarness({
    tenantStatusResult: {
      status: 'success',
      tenantStatus: {
        organizationName: 'SPPG Sungai Pasir 1 Meral, Karimun',
        organizationActive: true,
        adminEmailVerified: true
      }
    }
  });
  harness.context.window.SPAS1_AUTH_ROLE = 'employee';

  await harness.context.loadAuthenticatedSppgIdentityStatus();

  assert.equal(harness.publicSiteSettingsLoads(), 1);
  assert.equal(harness.functionCalls.length, 1);
  assert.equal(harness.functionCalls[0].functionName, 'module-account-admin');
  assert.equal(harness.functionCalls[0].payload.action, 'tenantStatus');
  for (const status of harness.identityStatuses.values()) {
    assert.equal(status.classList.contains('hidden'), false);
    assert.equal(status.children[0].textContent, 'SPPG Sungai Pasir 1 Meral, Karimun');
    assert.equal(status.children[1].textContent, 'SPPG aktif');
    assert.equal(status.children[2].textContent, 'Email admin terverifikasi');
    assert.match(status.children[1].className, /text-emerald-300/);
    assert.match(status.children[2].className, /text-emerald-300/);
  }
});

test('unverified admin email is shown distinctly and failed status lookups are not hidden', async function() {
  const unverified = createHarness({
    tenantStatusResult: {
      status: 'success',
      tenantStatus: {
        organizationName: 'SPPG',
        organizationActive: true,
        adminEmailVerified: false
      }
    }
  });
  unverified.context.window.SPAS1_AUTH_ROLE = 'stok';
  await unverified.context.loadAuthenticatedSppgIdentityStatus();
  const status = unverified.identityStatuses.get('slSppgIdentityStatus');
  assert.equal(status.children[1].textContent, 'SPPG aktif');
  assert.equal(status.children[2].textContent, 'Email admin belum terverifikasi');
  assert.match(status.children[2].className, /text-amber-200/);

  const failed = createHarness({ functionError: new Error('Function unavailable') });
  failed.context.window.SPAS1_AUTH_ROLE = 'persiapan';
  await failed.context.loadAuthenticatedSppgIdentityStatus();
  const failedStatus = failed.identityStatuses.get('preparationSppgIdentityStatus');
  assert.equal(failedStatus.classList.contains('hidden'), false);
  assert.match(failedStatus.textContent, /tidak dapat diverifikasi/);
  assert.equal(failed.errors.length, 1);

  const outdatedBackend = createHarness({
    functionError: new Error('Aksi tidak dikenal.')
  });
  outdatedBackend.context.window.SPAS1_AUTH_ROLE = 'admin';
  await outdatedBackend.context.loadAuthenticatedSppgIdentityStatus();
  assert.match(
    outdatedBackend.identityStatuses.get('preparationSppgIdentityStatus').textContent,
    /Fungsi status SPPG di server perlu diperbarui/
  );
});

test('a late identity response for a previous SPPG is discarded', async function() {
  let resolveStatus;
  const harness = createHarness({
    functionPromise: new Promise(function(resolve) { resolveStatus = resolve; })
  });
  harness.context.window.SPAS1_AUTH_ROLE = 'stok';
  const loading = harness.context.loadAuthenticatedSppgIdentityStatus();
  harness.setTenantId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  resolveStatus({
    status: 'success',
    tenantStatus: {
      organizationName: 'SPPG lama',
      organizationActive: true,
      adminEmailVerified: true
    }
  });
  await loading;

  for (const status of harness.identityStatuses.values()) {
    assert.equal(status.classList.contains('hidden'), true);
    assert.equal(status.textContent, '');
  }
});

test('source and deployed HTML both contain the current SPPG status indicator', function() {
  for (const relativePath of ['index.html', 'dist/index.html']) {
    const deployedHtml = fs.readFileSync(path.join(root, relativePath), 'utf8');
    assert.match(deployedHtml, /id="currentSppgAccountStatus"/, relativePath);
    assert.match(deployedHtml, /loadCurrentSppgAccountStatus\(\)/, relativePath);
    for (const id of ['employeeSppgIdentityStatus', 'mnSppgIdentityStatus', 'slSppgIdentityStatus', 'preparationSppgIdentityStatus']) {
      assert.match(deployedHtml, new RegExp('id="' + id + '"'), relativePath);
    }
    assert.match(deployedHtml, /loadAuthenticatedSppgIdentityStatus\(\)/, relativePath);
    assert.match(deployedHtml, /Fungsi status SPPG di server perlu diperbarui/, relativePath);
    const portalStart = deployedHtml.indexOf('function enterSuperAdminPortal(');
    const portalEnd = deployedHtml.indexOf('\nfunction verifikasiAdmin', portalStart);
    assert.ok(portalStart >= 0 && portalEnd > portalStart, relativePath + ' should define the SUPER ADMIN portal entry');
    assert.match(deployedHtml.slice(portalStart, portalEnd), /resetAdminNavigationState\(\);\s*loadAdminSiteSettings\(\);/);
    const adminLoginStart = deployedHtml.indexOf('window.handleAdminLogin = function()');
    const adminLoginEnd = deployedHtml.indexOf('\nwindow.fetchAllAdminData', adminLoginStart);
    assert.ok(adminLoginStart >= 0 && adminLoginEnd > adminLoginStart, relativePath + ' should define the direct admin login handler');
    assert.match(deployedHtml.slice(adminLoginStart, adminLoginEnd), /loadCurrentSppgAccountStatus\(\);\s*loadAdminSiteSettings\(\);/);
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
