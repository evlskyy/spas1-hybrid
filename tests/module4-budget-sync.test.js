const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const deployedHtml = fs.readFileSync(path.join(__dirname, '..', 'dist', 'index.html'), 'utf8');

test('saving Module 4 budget uses local normalization instead of undefined backup validation', function() {
  assert.match(html, /case 'saveModule4Budget':/);
  assert.match(html, /const normalizeBudgetMap = function\(budget\)/);
  assert.match(html, /const normalizedBudget = normalizeBudgetMap\(payload\.budget \|\| \{\}\)/);
  const budgetStart = html.indexOf("case 'saveModule4Budget':");
  const budgetEnd = html.indexOf("case 'saveModule4Schedule':", budgetStart);
  const budgetCase = html.slice(budgetStart, budgetEnd);
  assert.doesNotMatch(budgetCase, /validateBackupData\(/);
});

test('Module 4 state save can recover from missing replica identity', function() {
  assert.match(html, /550001\|cannot update table\|replica identity/);
  assert.match(html, /method: 'DELETE',[\s\S]*?AppKey: 'eq\.app-state'/);
  assert.match(html, /method: 'POST',[\s\S]*?prefer: 'return=minimal'/);
});

test('Module 4 uses global branding without a logo edit override', function() {
  for (const appHtml of [html, deployedHtml]) {
    assert.match(appHtml, /id="brandLogoImg" data-brand-logo="true"/);
    assert.match(appHtml, /data-spas1-logo="true"/);
    assert.doesNotMatch(appHtml, /Ubah Logo|openLogoModal|saveLogoModal|resetLogoToDefault|appLogoBase64|SPAS1_MODULE_LOGO_OVERRIDE/);
  }
});

test('Module 4 PO table can expand, close with Escape, and restore page scroll', function() {
  for (const appHtml of [html, deployedHtml]) {
    assert.match(appHtml, /id="budgetTableFullscreenToggle"[^>]*>[\s\S]*?Perluas Tabel/);
    assert.match(appHtml, /\.budget-table-fullscreen\.is-fullscreen/);
  }

  const classSet = function() {
    const values = new Set();
    return {
      contains: function(value) { return values.has(value); },
      toggle: function(value, force) {
        const shouldAdd = force === undefined ? !values.has(value) : force;
        if (shouldAdd) values.add(value);
        else values.delete(value);
        return shouldAdd;
      }
    };
  };
  const panel = { classList: classSet() };
  const button = {
    attributes: {},
    classList: classSet(),
    setAttribute: function(name, value) { this.attributes[name] = value; },
    focus: function() {}
  };
  const body = { classList: classSet() };
  let escapeHandler;
  const scrollCalls = [];
  const context = {
    window: {
      scrollY: 321,
      scrollTo: function(x, y) { scrollCalls.push([x, y]); }
    },
    document: {
      body: body,
      getElementById: function(id) {
        return id === 'budgetTableFullscreen' ? panel : button;
      },
      addEventListener: function(type, handler) {
        if (type === 'keydown') escapeHandler = handler;
      }
    }
  };
  const start = html.indexOf('let budgetTableFullscreenScrollY = 0;');
  const end = html.indexOf('\nfunction normalizeBudgetStockName', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  vm.runInNewContext(html.slice(start, end), context);

  context.window.toggleBudgetTableFullscreen();
  assert.equal(panel.classList.contains('is-fullscreen'), true);
  assert.equal(body.classList.contains('budget-table-fullscreen-open'), true);
  assert.equal(button.attributes['aria-expanded'], 'true');

  escapeHandler({ key: 'Escape' });
  assert.equal(panel.classList.contains('is-fullscreen'), false);
  assert.equal(body.classList.contains('budget-table-fullscreen-open'), false);
  assert.equal(button.attributes['aria-expanded'], 'false');
  assert.deepEqual(scrollCalls, [[0, 321]]);
});
