const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const sourceHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const navigationStart = sourceHtml.indexOf('function toggleAdminSettingsMenu(');
const navigationEnd = sourceHtml.indexOf('\nfunction renderAdminTextRows', navigationStart);
const navigationSource = sourceHtml.slice(navigationStart, navigationEnd);
const entryStart = sourceHtml.indexOf('function enterSuperAdminPortal(');
const entryEnd = sourceHtml.indexOf('\nfunction verifikasiAdmin()', entryStart);
const entrySource = sourceHtml.slice(entryStart, entryEnd);

function createClassList(initialClasses) {
  const classes = new Set(initialClasses || []);
  return {
    add: function(name) { classes.add(name); },
    remove: function(name) { classes.delete(name); },
    contains: function(name) { return classes.has(name); },
    toggle: function(name, force) {
      const shouldAdd = typeof force === 'boolean' ? force : !classes.has(name);
      if (shouldAdd) classes.add(name);
      else classes.delete(name);
      return shouldAdd;
    }
  };
}

function createElement(classes) {
  return {
    classList: createClassList(classes),
    style: { backgroundColor: 'rgb(79, 70, 229)', color: 'rgb(255, 255, 255)' },
    attributes: { 'aria-expanded': 'true' },
    setAttribute: function(name, value) { this.attributes[name] = value; }
  };
}

test('opening SUPER ADMIN leaves tabs unselected and all navigation groups collapsed', function() {
  const tabs = [createElement([]), createElement([])];
  const links = [createElement(['active']), createElement(['active'])];
  const groups = {
    adminSettingsSubnav: createElement([]),
    'nav-settings-toggle': createElement(['is-current']),
    adminSettingsChevron: createElement(['rotate-180']),
    superAksesSubnav: createElement([]),
    'nav-super-akses-toggle': createElement(['is-current']),
    superAksesChevron: createElement(['rotate-180']),
    akuntanSubnav: createElement([]),
    'nav-akuntan-toggle': createElement(['is-current']),
    akuntanChevron: createElement(['rotate-180']),
    superGiziSubnav: createElement([]),
    'nav-super-gizi-toggle': createElement(['is-current']),
    superGiziChevron: createElement(['rotate-180'])
  };
  const context = {
    document: {
      querySelectorAll: function(selector) {
        if (selector === '.admin-tab') return tabs;
        if (selector === '.sidebar-link') return links;
        return [];
      },
      getElementById: function(id) { return groups[id] || null; }
    }
  };
  vm.runInNewContext(navigationSource, context);
  context.resetAdminNavigationState();

  tabs.forEach(function(tab) { assert.equal(tab.classList.contains('hidden'), true); });
  links.forEach(function(link) {
    assert.equal(link.classList.contains('active'), false);
    assert.equal(link.style.backgroundColor, '');
    assert.equal(link.style.color, '');
  });
  ['adminSettingsSubnav', 'superAksesSubnav', 'akuntanSubnav', 'superGiziSubnav'].forEach(function(id) {
    assert.equal(groups[id].classList.contains('hidden'), true);
  });
  ['nav-settings-toggle', 'nav-super-akses-toggle', 'nav-akuntan-toggle', 'nav-super-gizi-toggle'].forEach(function(id) {
    assert.equal(groups[id].attributes['aria-expanded'], 'false');
    assert.equal(groups[id].classList.contains('is-current'), false);
  });
  ['adminSettingsChevron', 'superAksesChevron', 'akuntanChevron', 'superGiziChevron'].forEach(function(id) {
    assert.equal(groups[id].classList.contains('rotate-180'), false);
  });
});

test('SUPER ADMIN entry resets navigation instead of opening the stock audit tab', function() {
  assert.match(entrySource, /resetAdminNavigationState\(\)/);
  assert.doesNotMatch(entrySource, /switchAdminTab\(/);
  for (const relativePath of ['index.html', 'dist/index.html']) {
    const html = fs.readFileSync(path.join(root, relativePath), 'utf8');
    const start = html.indexOf('function enterSuperAdminPortal(');
    const end = html.indexOf('\nfunction verifikasiAdmin()', start);
    const entry = html.slice(start, end);
    assert.match(entry, /resetAdminNavigationState\(\)/, `${relativePath} should reset navigation on entry`);
    assert.doesNotMatch(entry, /switchAdminTab\(/, `${relativePath} should not auto-open a tab`);
  }
});
