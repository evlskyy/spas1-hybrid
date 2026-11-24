const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('site content admin only exposes beneficiary, team, and WhatsApp controls', function() {
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
    'adminSocialLinks'
  ]) {
    assert.doesNotMatch(section, new RegExp('id="' + id + '"'));
  }
  for (const id of [
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

test('saving remaining site content preserves non-editable public content', function() {
  const start = html.indexOf('function saveAdminSiteContent()');
  const end = html.indexOf('\nlet currentSiteSettings', start);
  const source = html.slice(start, end);
  const nodes = {
    siteContentSubmit: { disabled: false, innerHTML: '' },
    contentBeneficiariesTitle: { value: 'Rincian Baru' },
    contentBeneficiariesNote: { value: 'Catatan baru' },
    contentTeamTitle: { value: 'Tim Baru' },
    contentTeamNote: { value: 'Persetujuan foto' },
    contentWhatsappEnabled: { checked: true },
    contentWhatsappPhone: { value: '6281234567890' }
  };
  const existingContent = {
    aboutTitle: 'Tentang Kami Lama',
    aboutDescription: 'Deskripsi publik lama',
    projectTitle: 'Proyek Lama',
    projectSummary: 'Ringkasan publik lama',
    projectUpdateTitle: 'Pembaruan Lama',
    projectUpdateSummary: 'Detail lama',
    socials: [{ key: 'email', url: 'mailto:info@example.com', enabled: true }]
  };
  let savedPayload;
  const context = {
    window: { SPAS1_AUTH_ROLE: 'admin', SPAS1_AUTH_TOKEN: 'session' },
    document: { getElementById: function(id) { return nodes[id]; } },
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

  assert.equal(savedPayload.beneficiariesTitle, 'Rincian Baru');
  assert.equal(savedPayload.whatsappPhone, '6281234567890');
  for (const key of ['aboutTitle', 'aboutDescription', 'projectTitle', 'projectSummary', 'socials']) {
    assert.deepEqual(savedPayload[key], existingContent[key]);
  }
});
