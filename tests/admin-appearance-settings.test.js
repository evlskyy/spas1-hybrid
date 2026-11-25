const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function appearanceFunctionContext() {
  const classes = new Set(['ui-theme-candy', 'ui-font-linux']);
  const selects = {
    adminAppearanceTheme: { value: '' },
    adminAppearanceFont: { value: '' }
  };
  const stored = {};
  const context = {
    document: {
      body: {
        classList: {
          remove: function(...names) { names.forEach(function(name) { classes.delete(name); }); },
          add: function(...names) { names.forEach(function(name) { classes.add(name); }); }
        }
      },
      getElementById: function(id) { return selects[id] || null; }
    },
    localStorage: {
      setItem: function(key, value) { stored[key] = value; }
    }
  };
  const start = html.indexOf('function applyAdminAppearance(');
  const end = html.indexOf('\nfunction loadAdminAppearance(', start);
  assert.notEqual(start, -1, 'Missing appearance preference handler');
  assert.notEqual(end, -1, 'Missing appearance preference handler boundary');
  vm.runInNewContext(html.slice(start, end), context);
  return { context: context, classes: classes, selects: selects, stored: stored };
}

test('SUPER ADMIN appearance panel offers requested themes and whole-app fonts', function() {
  assert.match(html, /id="nav-tab-appearance"[^>]*switchAdminTab\('tab-appearance'/);
  assert.match(html, /id="tab-appearance"/);
  assert.match(html, /<option value="candy">Candy Modern<\/option>/);
  assert.match(html, /<option value="linux">Classic Linux<\/option>/);
  assert.match(html, /<option value="windows">Classic Windows<\/option>/);
  assert.match(html, /<option value="macos">Mac OS/);
  assert.match(html, /<option value="linux">Linux Standar/);
  assert.match(html, /body\.ui-font-macos :not\(i\):not\(\[class\*="fa-"\]\)/);
});

test('appearance selections update global classes, controls, and browser preference', function() {
  const state = appearanceFunctionContext();

  state.context.applyAdminAppearance('windows', 'macos', true);

  assert.equal(state.classes.has('ui-theme-candy'), false);
  assert.equal(state.classes.has('ui-font-linux'), false);
  assert.equal(state.classes.has('ui-theme-windows'), true);
  assert.equal(state.classes.has('ui-font-macos'), true);
  assert.equal(state.selects.adminAppearanceTheme.value, 'windows');
  assert.equal(state.selects.adminAppearanceFont.value, 'macos');
  assert.deepEqual(JSON.parse(state.stored.spas1_admin_appearance), { theme: 'windows', font: 'macos' });
});

test('appearance handler rejects unsupported themes and fonts', function() {
  const state = appearanceFunctionContext();

  assert.throws(function() {
    state.context.applyAdminAppearance('unknown', 'macos', true);
  }, /tidak valid/);
});
