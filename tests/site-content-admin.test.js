const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('site content admin exposes About, project, social, beneficiary, team, and WhatsApp controls', function() {
  const start = html.indexOf('<section id="tab-content"');
  const end = html.indexOf('</section>', start);
  const section = html.slice(start, end);

  for (const id of [
    'contentAboutTitle',
    'contentAboutDescription',
    'contentProjectTitle',
    'contentProjectSummary',
    'contentProjectUpdateTitle',
    'contentProjectUpdateSummary',
    'adminSocialLinks',
    'contentBeneficiariesTitle',
    'contentBeneficiariesNote',
    'contentTeamTitle',
    'contentTeamNote',
    'contentWhatsappEnabled',
    'contentWhatsappPhone'
  ]) {
    assert.match(section, new RegExp('id="' + id + '"'));
  }
});

test('saving site content persists restored editors and retains other public fields', function() {
  const start = html.indexOf('function saveAdminSiteContent()');
  const end = html.indexOf('\nlet currentSiteSettings', start);
  const source = html.slice(start, end);
  const nodes = {
    siteContentSubmit: { disabled: false, innerHTML: '' },
    contentAboutTitle: { value: 'Tentang Yayasan Baru' },
    contentAboutDescription: { value: 'Deskripsi baru' },
    contentBeneficiariesTitle: { value: 'Rincian Baru' },
    contentBeneficiariesNote: { value: 'Catatan baru' },
    contentTeamTitle: { value: 'Tim Baru' },
    contentTeamNote: { value: 'Persetujuan foto' },
    contentProjectTitle: { value: 'Proyek Baru' },
    contentProjectSummary: { value: 'Ringkasan baru' },
    contentProjectUpdateTitle: { value: 'Pembaruan Baru' },
    contentProjectUpdateSummary: { value: 'Detail baru' },
    contentWhatsappEnabled: { checked: true },
    contentWhatsappPhone: { value: '6281234567890' }
  };
  const socialFields = {
    label: { value: 'Email baru' },
    url: { value: 'mailto:baru@example.com' },
    iconUrl: { value: '' },
    enabled: { checked: true }
  };
  const existingContent = {
    aboutTitle: 'Tentang Kami Lama',
    projectTitle: 'Proyek Lama',
    beneficiaries: [{ name: 'Sekolah lama' }],
    socials: [{ key: 'email', label: 'Email lama', url: 'mailto:info@example.com', enabled: false }]
  };
  let savedPayload;
  const context = {
    window: { SPAS1_AUTH_ROLE: 'admin', SPAS1_AUTH_TOKEN: 'session' },
    document: {
      getElementById: function(id) { return nodes[id]; },
      querySelector: function(selector) {
        const match = selector.match(/data-social-field="([^"]+)"/);
        return match ? socialFields[match[1]] : null;
      }
    },
    currentSiteContent: existingContent,
    callSupabaseAction: function(action, payload, onSuccess) {
      assert.equal(action, 'saveSiteContent');
      savedPayload = payload;
      onSuccess({ status: 'success' });
    },
    applySiteContent: function() {},
    showAdminSiteContentMessage: function() {}
  };
  vm.runInNewContext(source + '\nthis.run = saveAdminSiteContent;', context);

  context.run();

  assert.equal(savedPayload.aboutTitle, 'Tentang Yayasan Baru');
  assert.equal(savedPayload.aboutDescription, 'Deskripsi baru');
  assert.equal(savedPayload.projectTitle, 'Proyek Baru');
  assert.equal(savedPayload.projectSummary, 'Ringkasan baru');
  assert.equal(savedPayload.whatsappPhone, '6281234567890');
  assert.deepEqual(savedPayload.beneficiaries, existingContent.beneficiaries);
  assert.equal(savedPayload.socials[0].label, 'Email baru');
  assert.equal(savedPayload.socials[0].url, 'mailto:baru@example.com');
  assert.equal(savedPayload.socials[0].enabled, true);
});

test('social link editor safely renders its editable fields', function() {
  const start = html.indexOf('function renderAdminSocialLinks()');
  const end = html.indexOf('\nfunction loadAdminSiteContent()', start);
  const source = html.slice(start, end);
  const tbody = { innerHTML: '' };
  const context = {
    currentSiteContent: {
      socials: [{ key: 'email', label: '<b>Email</b>', url: 'mailto:info@example.com', iconUrl: '', enabled: true }]
    },
    document: { getElementById: function() { return tbody; } },
    escapeHtml: function(value) {
      return String(value).replace(/[&<>"']/g, function(char) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
      });
    }
  };
  vm.runInNewContext(source + '\nthis.run = renderAdminSocialLinks;', context);

  context.run();

  assert.match(tbody.innerHTML, /<td class="p-2 font-semibold">email<\/td>/);
  assert.match(tbody.innerHTML, /data-social-field="url"/);
  assert.match(tbody.innerHTML, /&lt;b&gt;Email&lt;\/b&gt;/);
  assert.doesNotMatch(tbody.innerHTML, /<b>Email<\/b>/);
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
    applyModuleLoginLogo: function() {},
    state: null
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
