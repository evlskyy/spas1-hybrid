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
  const preview = { dataset: {} };
  const status = { textContent: '' };
  const stored = { spas1_main_theme: 'dark' };
  const context = {
    document: {
      body: {
        classList: {
          remove: function(...names) { names.forEach(function(name) { classes.delete(name); }); },
          add: function(...names) { names.forEach(function(name) { classes.add(name); }); },
          toggle: function(name, force) {
            const shouldAdd = force === undefined ? !classes.has(name) : force;
            if (shouldAdd) classes.add(name);
            else classes.delete(name);
            return shouldAdd;
          }
        }
      },
      getElementById: function(id) {
        if (id === 'adminAppearanceStatus') return status;
        return selects[id] || null;
      },
      querySelector: function(selector) {
        return selector === '.appearance-preview-window' ? preview : null;
      }
    },
    localStorage: {
      getItem: function(key) { return Object.prototype.hasOwnProperty.call(stored, key) ? stored[key] : null; },
      setItem: function(key, value) { stored[key] = value; }
    },
    syncAdminPortalTheme: function() {},
    updateThemeToggleControls: function() {}
  };
  const start = html.indexOf('function previewAdminAppearance(');
  const end = html.indexOf('\nfunction loadAdminAppearance(', start);
  assert.notEqual(start, -1, 'Missing appearance preference handler');
  assert.notEqual(end, -1, 'Missing appearance preference handler boundary');
  vm.runInNewContext(html.slice(start, end), context);
  return { context: context, classes: classes, selects: selects, preview: preview, status: status, stored: stored };
}

function mainThemeToggleContext() {
  const classes = new Set(['ui-theme-candy', 'app-light-mode']);
  const rootClasses = new Set(['light-mode', 'ocean-theme']);
  const stored = { spas1_main_theme: 'light', spas1m_custom_theme: 'ocean' };
  const controlStates = [];
  const body = {
    classList: {
      contains: function(name) { return classes.has(name); },
      toggle: function(name) {
        if (classes.has(name)) {
          classes.delete(name);
          return false;
        }
        classes.add(name);
        return true;
      }
    },
    matches: function(selector) {
      return selector.split(',').some(function(name) { return classes.has(name.trim().replace(/^\./, '')); });
    }
  };
  const root = {
    classList: {
      add: function(...names) { names.forEach(function(name) { rootClasses.add(name); }); },
      remove: function(...names) { names.forEach(function(name) { rootClasses.delete(name); }); }
    }
  };
  const themeSelector = { value: 'ocean' };
  const context = {
    document: {
      body: body,
      getElementById: function(id) {
        if (id === 'spas1-webapp-root') return root;
        if (id === 'themeSelector') return themeSelector;
        return null;
      }
    },
    localStorage: {
      setItem: function(key, value) { stored[key] = value; }
    },
    syncAdminPortalTheme: function() {},
    updateThemeToggleControls: function(isLight) { controlStates.push(isLight); }
  };
  const start = html.indexOf('function toggleMainAppTheme()');
  const end = html.indexOf('\nfunction syncAdminPortalTheme(', start);
  assert.notEqual(start, -1, 'Missing global theme toggle');
  assert.notEqual(end, -1, 'Missing global theme toggle boundary');
  vm.runInNewContext(html.slice(start, end), context);
  return { context: context, classes: classes, rootClasses: rootClasses, themeSelector: themeSelector, stored: stored, controlStates: controlStates };
}

function customModuleThemeContext(hasAppearancePreset) {
  const classes = new Set(hasAppearancePreset ? ['ui-theme-candy'] : []);
  const rootClasses = new Set();
  const stored = { spas1_main_theme: 'dark' };
  const controlStates = [];
  const body = {
    classList: {
      contains: function(name) { return classes.has(name); },
      toggle: function(name, force) {
        const shouldAdd = force === undefined ? !classes.has(name) : force;
        if (shouldAdd) classes.add(name);
        else classes.delete(name);
        return shouldAdd;
      }
    },
    matches: function(selector) {
      return selector.split(',').some(function(name) { return classes.has(name.trim().replace(/^\./, '')); });
    }
  };
  const root = {
    classList: {
      toggle: function(name, force) {
        const shouldAdd = force === undefined ? !rootClasses.has(name) : force;
        if (shouldAdd) rootClasses.add(name);
        else rootClasses.delete(name);
      }
    }
  };
  const themeSelector = { value: '' };
  const context = {
    document: {
      body: body,
      getElementById: function(id) {
        if (id === 'spas1-webapp-root') return root;
        if (id === 'themeSelector') return themeSelector;
        return null;
      }
    },
    localStorage: {
      setItem: function(key, value) { stored[key] = value; }
    },
    syncAdminPortalTheme: function() {},
    updateThemeToggleControls: function(isLight) { controlStates.push(isLight); }
  };
  const start = html.indexOf('function changeCustomTheme(');
  const end = html.indexOf('\nfunction setPortalLoginBusy(', start);
  assert.notEqual(start, -1, 'Missing module theme handler');
  assert.notEqual(end, -1, 'Missing module theme handler boundary');
  vm.runInNewContext(html.slice(start, end), context);
  return { context: context, classes: classes, rootClasses: rootClasses, themeSelector: themeSelector, stored: stored, controlStates: controlStates };
}

test('SUPER ADMIN appearance panel offers requested themes and whole-app fonts', function() {
  assert.match(html, /id="nav-tab-appearance"[^>]*switchAdminTab\('tab-appearance'/);
  assert.match(html, /id="tab-appearance"/);
  assert.match(html, /<option value="candy">Candy Modern<\/option>/);
  assert.match(html, /<option value="linux">Classic Linux<\/option>/);
  assert.match(html, /<option value="windows">Classic Windows<\/option>/);
  assert.match(html, /<option value="retro">Retro Browser<\/option>/);
  assert.match(html, /appearance-preview-browserbar[\s\S]*aria-hidden="true"[\s\S]*spas1\.my\.id \/ dashboard/);
  assert.match(html, /\.appearance-preview-window\[data-theme="retro"\][\s\S]*display:flex/);
  assert.match(html, /<option value="macos">Mac OS/);
  assert.match(html, /<option value="linux">Linux Standar/);
  assert.match(html, /body\.ui-font-macos :not\(i\):not\(\[class\*="fa-"\]\)/);
  assert.match(html, /body\[class\*="printing-"\] tfoot \{\s*display: table-footer-group;\s*\}\s*\}\s*body\.ui-font-macos/);
  assert.match(html, /Pratinjau langsung[\s\S]*class="appearance-preview-window"/);
  assert.match(html, /data-theme="candy"[\s\S]*data-font="linux"/);
  assert.match(html, /appearance-preview-window\[data-theme="windows"\] \.appearance-preview-titlebar/);
  assert.match(html, /body\.ui-font-linux \.appearance-preview-window\[data-font="macos"\][\s\S]*font-family:"SF Pro Display"/);
  assert.match(html, /body\.ui-font-macos \.appearance-preview-window\[data-font="linux"\][\s\S]*font-family:system-ui/);
  assert.match(html, /id="adminAppearanceTheme" onchange="previewAdminAppearance\(\)"/);
  assert.match(html, /id="adminAppearanceFont" onchange="previewAdminAppearance\(\)"/);
  assert.match(html, /onclick="saveAdminAppearance\(\)"[^>]*>Terapkan<\/button>/);
  assert.match(html, /id="adminAppearanceApplyButton"/);
  assert.match(html, /body\.ui-theme-linux #view-admin \.sidebar-link\.active,[\s\S]*#adminAppearanceApplyButton/);
  assert.match(html, /body:is\(\.ui-theme-candy,\.ui-theme-linux,\.ui-theme-windows,\.ui-theme-retro\)[\s\S]*#modul-absensi,#modul-menu,#modul-stok/);
  assert.match(html, /body:is\(\.ui-theme-candy,\.ui-theme-linux,\.ui-theme-windows,\.ui-theme-retro\)[\s\S]*\.mn-header-card,\.sl-header-card/);
  assert.match(html, /body:is\(\.ui-theme-candy,\.ui-theme-linux,\.ui-theme-windows,\.ui-theme-retro\)[\s\S]*#spas1-webapp-root \.card/);
  assert.match(html, /body:is\(\.ui-theme-candy,\.ui-theme-linux,\.ui-theme-windows,\.ui-theme-retro\)[\s\S]*#view-admin,#spas1-webapp-root/);
  assert.match(html, /document\.body\.classList\.toggle\('app-light-mode', isLight\)/);
  assert.match(html, /body\.ui-theme-candy:not\(\.app-light-mode\)\s*\{[\s\S]*color-scheme: dark/);
  assert.match(html, /body\.ui-theme-linux:not\(\.app-light-mode\)\s*\{[\s\S]*color-scheme: dark/);
  assert.match(html, /body\.ui-theme-windows:not\(\.app-light-mode\)\s*\{[\s\S]*color-scheme: dark/);
});

test('global themes override home launcher styles and unify secondary home actions', function() {
  assert.match(html, /body:is\(\.ui-theme-candy,\.ui-theme-linux,\.ui-theme-windows,\.ui-theme-retro\) #view-home #btnSuperAdminLogin\s*\{[\s\S]*background: var\(--appearance-surface\) !important/);
  assert.match(html, /#view-home #btnSuperAdminLogin :is\(\.home-utility-description,\.home-admin-access\)\s*\{[\s\S]*color: var\(--appearance-subtle\) !important/);
  assert.match(html, /#view-home \.home-footer-layout :is\([\s\S]*#btnAboutUs,#btnProjectInfo,#btnApplySppg,#btnSponsor,[\s\S]*background: var\(--appearance-raised\) !important/);
});

test('retro theme persists, applies across modules, and does not affect white print output', function() {
  const state = appearanceFunctionContext();
  state.context.applyAdminAppearance('retro', 'linux', true);

  assert.equal(state.classes.has('ui-theme-candy'), false);
  assert.equal(state.classes.has('ui-theme-retro'), true);
  assert.equal(state.selects.adminAppearanceTheme.value, 'retro');
  assert.deepEqual(JSON.parse(state.stored.spas1_admin_appearance), { theme: 'retro', font: 'linux' });
  assert.match(html, /body\.ui-theme-retro\.app-light-mode\s*\{[\s\S]*#F3E9DC/);
  assert.match(html, /@media print \{\s*html body\[class\*="printing-"\]\[class\*="ui-theme-"\][\s\S]*font-family: Arial, Helvetica, sans-serif !important;[\s\S]*background: #FFFFFF !important;[\s\S]*background-color: #FFFFFF !important/);
  assert.match(html, /body\[class\*="printing-"\] #view-admin > \.admin-about-skyy-link \{\s*display: none !important;/);
});

test('all modules share readable text and consistent themed card surfaces', function() {
  assert.match(html, /@media screen \{\s*body \{\s*--appearance-page: #0B132B/);
  assert.match(html, /body :is\([\s\S]*#modul-absensi,#modul-menu,#modul-stok,[\s\S]*\) :is\(\.dark-card,\.light-card,\.card,\[class\*="-card"\]\) \{[\s\S]*background: var\(--appearance-surface\) !important;[\s\S]*border-radius: var\(--appearance-card-radius\) !important;[\s\S]*border-style: var\(--appearance-card-border-style\) !important/);
  assert.match(html, /body :is\([\s\S]*#modul-absensi,#modul-menu,#modul-stok,[\s\S]*\) :is\(h1,h2,h3,h4,h5,p,label,th,td\) \{\s*overflow-wrap: anywhere;/);
  assert.match(html, /:is\(\.text-gray-600,\.text-gray-500,\.text-gray-400,\.text-gray-300,[\s\S]*\.text-slate-400[\s\S]*color: var\(--appearance-subtle\) !important;/);
  assert.match(html, /--appearance-card-radius: 18px;\s*--appearance-card-border-style: solid;/);
  assert.match(html, /--appearance-card-radius: 2px;\s*--appearance-card-border-style: outset;/);
});

test('appearance selections update global classes, controls, and browser preference', function() {
  const state = appearanceFunctionContext();
  state.stored.spas1_main_theme = 'light';

  state.context.applyAdminAppearance('windows', 'macos', true);

  assert.equal(state.classes.has('ui-theme-candy'), false);
  assert.equal(state.classes.has('ui-font-linux'), false);
  assert.equal(state.classes.has('ui-theme-windows'), true);
  assert.equal(state.classes.has('ui-font-macos'), true);
  assert.equal(state.classes.has('app-light-mode'), true);
  assert.equal(state.selects.adminAppearanceTheme.value, 'windows');
  assert.equal(state.selects.adminAppearanceFont.value, 'macos');
  assert.equal(state.preview.dataset.theme, 'windows');
  assert.equal(state.preview.dataset.font, 'macos');
  assert.deepEqual(JSON.parse(state.stored.spas1_admin_appearance), { theme: 'windows', font: 'macos' });
});

test('light and dark toggle works without removing a selected UI preset', function() {
  const state = mainThemeToggleContext();

  state.context.toggleMainAppTheme();

  assert.equal(state.classes.has('ui-theme-candy'), true);
  assert.equal(state.classes.has('app-light-mode'), false);
  assert.equal(state.stored.spas1_main_theme, 'dark');
  assert.equal(state.themeSelector.value, 'ocean');
  assert.equal(state.rootClasses.has('ocean-theme'), true);
  assert.equal(state.rootClasses.has('light-mode'), false);
  assert.equal(state.stored.spas1m_custom_theme, 'ocean');
  assert.equal(state.controlStates.at(-1), false);

  state.context.toggleMainAppTheme();

  assert.equal(state.classes.has('ui-theme-candy'), true);
  assert.equal(state.classes.has('app-light-mode'), true);
  assert.equal(state.stored.spas1_main_theme, 'light');
  assert.equal(state.rootClasses.has('ocean-theme'), true);
  assert.equal(state.rootClasses.has('light-mode'), true);
  assert.equal(state.controlStates.at(-1), true);
});

test('custom appearance restores the previously selected light or dark mode', function() {
  const state = appearanceFunctionContext();

  state.context.applyAdminAppearance('candy', 'linux', false);
  assert.equal(state.classes.has('app-light-mode'), false);

  state.stored.spas1_main_theme = 'light';
  state.context.applyAdminAppearance('windows', 'linux', false);
  assert.equal(state.classes.has('app-light-mode'), true);
});

test('module theme changes do not override the global mode when a UI preset is active', function() {
  const state = customModuleThemeContext(true);

  state.context.changeCustomTheme('light');

  assert.equal(state.classes.has('app-light-mode'), false);
  assert.equal(state.rootClasses.has('light-mode'), false);
  assert.equal(state.stored.spas1_main_theme, 'dark');
  assert.equal(state.stored.spas1m_custom_theme, 'light');
  assert.equal(state.controlStates.at(-1), false);
});

test('module theme still controls global mode with the default UI preset', function() {
  const state = customModuleThemeContext(false);

  state.context.changeCustomTheme('light');

  assert.equal(state.classes.has('app-light-mode'), true);
  assert.equal(state.stored.spas1_main_theme, 'light');
  assert.equal(state.controlStates.at(-1), true);
});

test('returning to the default appearance restores the saved global light/dark mode', function() {
  const state = appearanceFunctionContext();
  state.context.applyAdminAppearance('candy', 'linux', false);
  state.context.applyAdminAppearance('spas', 'linux', false);

  assert.equal(state.classes.has('ui-theme-candy'), false);
  assert.equal(state.classes.has('app-light-mode'), false);
});

test('appearance selections update only the preview until applied', function() {
  const state = appearanceFunctionContext();
  state.selects.adminAppearanceTheme.value = 'windows';
  state.selects.adminAppearanceFont.value = 'macos';

  state.context.previewAdminAppearance();

  assert.equal(state.preview.dataset.theme, 'windows');
  assert.equal(state.preview.dataset.font, 'macos');
  assert.equal(state.classes.has('ui-theme-candy'), true);
  assert.equal(state.status.textContent, 'Pratinjau diperbarui. Tekan Terapkan untuk menggunakan pilihan ini.');
});

test('appearance handler rejects unsupported themes and fonts', function() {
  const state = appearanceFunctionContext();

  assert.throws(function() {
    state.context.applyAdminAppearance('unknown', 'macos', true);
  }, /tidak valid/);
});
