const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('SUPER ADMIN site content editor is removed without deleting public content', function() {
  for (const fragment of [
    'id="nav-tab-content"',
    'id="tab-content"',
    'id="siteContentForm"',
    'saveAdminSiteContent',
    'renderAdminSocialLinks',
    'id="adminSocialLinks"'
  ]) {
    assert.doesNotMatch(html, new RegExp(fragment));
  }
  assert.match(html, /function applySiteContent\(content\)/);
  assert.match(html, /case 'fetchPublicSiteContent'/);

  const start = html.indexOf("const ABOUTSKY_PUBLIC_URL =");
  const end = html.indexOf('\nconst previousProjectContentPatterns', start);
  const defaultsSource = html.slice(start, end);
  const context = {};
  vm.runInNewContext(defaultsSource + '\nthis.publicDefaults = defaultSiteContent;', context);

  assert.ok(context.publicDefaults.aboutTitle);
  assert.ok(context.publicDefaults.projectTitle);
  assert.ok(context.publicDefaults.socials.length > 0);
});

test('WhatsApp editor appears in Pengaturan, not in a site content tab', function() {
  const start = html.indexOf('<section id="tab-settings"');
  const end = html.indexOf('</section>', start);
  const settingsSection = html.slice(start, end);
  assert.match(settingsSection, /id="siteWhatsappSettingsForm"/);
  assert.match(settingsSection, /id="settingsWhatsappEnabled"/);
  assert.match(settingsSection, /id="settingsWhatsappPhone"/);
  assert.doesNotMatch(html, /id="contentWhatsappEnabled"|id="contentWhatsappPhone"/);
});

test('loading WhatsApp settings only populates its Pengaturan controls', function() {
  const start = html.indexOf('function loadAdminWhatsappSettings()');
  const end = html.indexOf('\nfunction saveAdminWhatsappSettings()', start);
  const source = html.slice(start, end);
  const nodes = {
    siteWhatsappSettingsSubmit: { disabled: false },
    settingsWhatsappEnabled: { checked: false },
    settingsWhatsappPhone: { value: '' }
  };
  const context = {
    window: { SPAS1_AUTH_ROLE: 'admin', SPAS1_AUTH_TOKEN: 'session' },
    adminWhatsappSettingsLoaded: false,
    adminWhatsappSettingsLoading: false,
    document: { getElementById: function(id) { return nodes[id] || null; } },
    currentSiteContent: {},
    applySiteContent: function(content) { context.currentSiteContent = content; },
    callSupabaseAction: function(action, payload, onSuccess) {
      assert.equal(action, 'fetchAdminSiteContent');
      onSuccess({
        status: 'success',
        data: { aboutTitle: 'Tentang Kami', whatsappEnabled: true, whatsappPhone: '6281378004808' }
      });
    },
    showAdminWhatsappSettingsMessage: function() {}
  };
  vm.runInNewContext(source + '\nthis.run = loadAdminWhatsappSettings;', context);

  context.run();

  assert.equal(nodes.settingsWhatsappEnabled.checked, true);
  assert.equal(nodes.settingsWhatsappPhone.value, '6281378004808');
  assert.equal(nodes.siteWhatsappSettingsSubmit.disabled, false);
  assert.equal(context.currentSiteContent.aboutTitle, 'Tentang Kami');
  assert.equal(context.adminWhatsappSettingsLoaded, true);
});

test('saving WhatsApp settings preserves other site content', function() {
  const start = html.indexOf('function saveAdminWhatsappSettings()');
  const end = html.indexOf('\nlet currentSiteSettings', start);
  const source = html.slice(start, end);
  const nodes = {
    siteWhatsappSettingsForm: { reportValidity: function() { return true; } },
    siteWhatsappSettingsSubmit: { disabled: false, innerHTML: '' },
    settingsWhatsappEnabled: { checked: false },
    settingsWhatsappPhone: { value: '6281234567890' }
  };
  const existingContent = {
    aboutTitle: 'Tentang Kami',
    socials: [{ key: 'email', url: 'mailto:info@example.com' }]
  };
  let savedPayload;
  const context = {
    window: { SPAS1_AUTH_ROLE: 'admin', SPAS1_AUTH_TOKEN: 'session' },
    document: { getElementById: function(id) { return nodes[id]; } },
    currentSiteContent: existingContent,
    adminWhatsappSettingsLoaded: true,
    callSupabaseAction: function(action, payload, onSuccess) {
      assert.equal(action, 'saveSiteContent');
      savedPayload = payload;
      onSuccess({ status: 'success' });
    },
    applySiteContent: function() {},
    showAdminWhatsappSettingsMessage: function() {}
  };
  vm.runInNewContext(source + '\nthis.run = saveAdminWhatsappSettings;', context);

  context.run();

  assert.equal(savedPayload.whatsappEnabled, false);
  assert.equal(savedPayload.whatsappPhone, '6281234567890');
  assert.equal(savedPayload.aboutTitle, 'Tentang Kami');
  assert.equal(savedPayload.socials[0].url, 'mailto:info@example.com');
});

test('global identity editor only exposes Yayasan branding and keeps SPAS1 mark fixed', function() {
  const start = html.indexOf('<section id="tab-settings"');
  const end = html.indexOf('</section>', start);
  const section = html.slice(start, end);
  assert.match(section, /id="foundationNameInput"/);
  assert.match(section, /id="sppgNameInput"/);
  assert.match(section, /Logo Yayasan/);
  assert.doesNotMatch(section, /siteMarkInput|siteMarkUpload|Upload Logo SPAS1/);
  assert.doesNotMatch(html, /markFileId|markUrl|uploadSiteMark|resetSiteMark/);

  const sourceStart = html.indexOf('let currentSiteSettings =');
  const sourceEnd = html.indexOf('\nfunction applyModuleLoginLogo', sourceStart);
  const source = html.slice(sourceStart, sourceEnd);
  const markImage = { src: '' };
  const brandImage = { src: '' };
  const context = {
    window: { SPAS1_MODULE_LOGO_OVERRIDE: '' },
    document: {
      title: '',
      querySelectorAll: function(selector) {
        if (selector === '[data-spas1-logo="true"]') return [markImage];
        if (selector === '[data-brand-logo="true"]') return [brandImage];
        return [];
      },
      getElementById: function() { return null; }
    },
    applyModuleLoginLogo: function() {}
  };
  vm.runInNewContext(source + '\nthis.run = applySiteSettings; this.getState = () => currentSiteSettings;', context);
  context.run({
    foundationName: 'Yayasan Baru',
    sppgName: 'SPPG Baru',
    logoUrl: 'https://example.com/yayasan.png',
    markFileId: 'legacy-file',
    markUrl: 'https://example.com/legacy-mark.png'
  });

  assert.equal(markImage.src, 'assets/spas1-mark.png');
  assert.equal(brandImage.src, 'https://example.com/yayasan.png');
  assert.equal(context.getState().markUrl, undefined);
});

test('global identity updates branded modules and ignores invalid names', function() {
  const start = html.indexOf('let currentSiteSettings =');
  const end = html.indexOf('\nfunction applyModuleLoginLogo', start);
  const source = html.slice(start, end);
  const foundation = [{ textContent: '' }];
  const sppg = [{ textContent: '' }, { textContent: '' }];
  const context = {
    window: { SPAS1_MODULE_LOGO_OVERRIDE: '' },
    document: {
      title: '',
      querySelectorAll: function(selector) {
        if (selector === '[data-brand-field="foundation"]') return foundation;
        if (selector === '[data-brand-field="sppg"]') return sppg;
        return [];
      },
      getElementById: function() { return null; }
    },
    applyModuleLoginLogo: function() {}
  };
  vm.runInNewContext(source + '\nthis.run = applySiteSettings; this.getState = () => currentSiteSettings;', context);

  context.run({ foundationName: '  Yayasan Baru  ', sppgName: 'undefined' });
  assert.equal(context.getState().foundationName, 'Yayasan Baru');
  assert.equal(context.getState().sppgName, 'Nama SPPG belum diatur');
  assert.deepEqual(sppg.map(function(element) { return element.textContent; }), [
    'Nama SPPG belum diatur',
    'Nama SPPG belum diatur'
  ]);

  context.run({ sppgName: 'SPPG Baru' });
  assert.deepEqual(sppg.map(function(element) { return element.textContent; }), ['SPPG Baru', 'SPPG Baru']);
  assert.match(html, /id="aboutSppgName" data-brand-field="sppg"/);
  assert.match(html, /Manajemen <span data-brand-field="sppg">/);
  assert.doesNotMatch(html, /id="aboutTeamTitle" data-content-key="teamTitle"/);
});

test('loading incomplete identity settings never puts undefined in the admin inputs', function() {
  const start = html.indexOf('let currentSiteSettings =');
  const end = html.indexOf('\nfunction deleteAnnouncement', start);
  const source = html.slice(start, end);
  const nodes = {
    adminSettingsMessage: {
      className: '',
      textContent: '',
      classList: { add: function() {} }
    },
    foundationNameInput: { value: '' },
    sppgNameInput: { value: '' }
  };
  const context = {
    window: { SPAS1_AUTH_ROLE: 'admin', SPAS1_AUTH_TOKEN: 'session' },
    document: {
      title: '',
      getElementById: function(id) { return nodes[id] || null; },
      querySelectorAll: function() { return []; }
    },
    loadAdminWhatsappSettings: function() {},
    callSupabaseAction: function(action, payload, onSuccess) {
      assert.equal(action, 'fetchAdminSettings');
      onSuccess({
        status: 'success',
        data: { foundationName: undefined, sppgName: 'undefined' }
      });
    },
    applyModuleLoginLogo: function() {}
  };
  vm.runInNewContext(source + '\nthis.run = loadAdminSiteSettings;', context);

  context.run();

  assert.equal(nodes.foundationNameInput.value, '');
  assert.equal(nodes.sppgNameInput.value, '');
});
