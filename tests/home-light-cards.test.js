const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const deployedHtml = fs.readFileSync(path.join(__dirname, '..', 'dist', 'index.html'), 'utf8');

function getCssRule(selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = html.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `Expected CSS rule for ${selector}`);
  return match[1];
}

test('SUPER ADMIN and Radar Info cards use white surfaces in light mode', function() {
  const superAdminRule = getCssRule('body.app-light-mode #view-home #btnSuperAdminLogin');
  const radarRule = getCssRule('body.app-light-mode .home-news-launcher');

  assert.match(superAdminRule, /background:\s*#FFFFFF\s*!important/);
  assert.match(superAdminRule, /border-color:\s*#D1D5DB\s*!important/);
  assert.match(radarRule, /background:\s*#FFFFFF/);
  assert.match(radarRule, /border-color:\s*#D1D5DB/);
});

test('all footer action cards share light-mode surfaces and high-contrast icons in source and deploy output', function() {
  for (const appHtml of [html, deployedHtml]) {
    const actionRule = appHtml.match(/body\.app-light-mode[^{}]*#view-home \.home-footer-layout :is\(([^)]*)\)\s*\{([^}]*)\}/);
    assert.ok(actionRule, 'Expected one shared light-mode footer action rule');
    assert.match(actionRule[1], /#btnProjectInfo,#btnApplySppg,#btnAboutUs/);
    assert.match(actionRule[1], /\.home-live-demo-button,\.trakteer-link,#btnSponsor/);
    assert.match(actionRule[2], /background:\s*#FFFFFF\s*!important/);
    assert.match(actionRule[2], /border-color:\s*#D1D5DB\s*!important/);
    assert.match(actionRule[2], /color:\s*#111827\s*!important/);
    assert.match(appHtml, /body\.app-light-mode[^{}]*#btnApplySppg[^{}]*>\s*i\s*\{\s*color:\s*#111827\s*!important;/);
    assert.match(appHtml, /body\.app-light-mode[^{}]*\.trakteer-icon[^{}]*\{\s*filter:\s*brightness\(0\)\s*!important;/);
  }
});
