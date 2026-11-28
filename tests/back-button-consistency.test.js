const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');

test('all application back buttons share a static, consistent style in source and deploy HTML', function() {
  for (const relativePath of ['index.html', 'dist/index.html']) {
    const html = fs.readFileSync(path.join(root, relativePath), 'utf8');
    const styleStart = html.indexOf('button:is(.app-back-button');
    const styleEnd = html.indexOf('/* ============================================= */', styleStart);
    assert.ok(styleStart >= 0 && styleEnd > styleStart, relativePath + ' should define the shared back button style');

    const styles = html.slice(styleStart, styleEnd);
    for (const selector of [
      '.btn-kembali-animated',
      '.mn-login-back',
      '.sl-login-back',
      '.accounting-folder-back',
      '.sl-purchase-detail-back',
      '[onclick="closePurchaseTransactionFolder()"]',
      '[onclick="kembaliKeHome()"]',
      '[onclick="kembaliKeInfoSPPG()"]',
      '[onclick="kembaliKeLoginRelawan()"]'
    ]) {
      assert.ok(styles.includes(selector), relativePath + ' should normalize ' + selector);
    }
    assert.match(styles, /min-height:\s*40px\s*!important/);
    assert.match(styles, /font-size:\s*12px\s*!important/);
    assert.match(styles, /font-weight:\s*600\s*!important/);
    assert.match(styles, /animation:\s*none\s*!important/);
    assert.match(styles, /transition:\s*none\s*!important/);
    assert.match(styles, /transform:\s*none\s*!important/);
    assert.match(styles, /:focus-visible/);
    assert.doesNotMatch(styles, /\.sl-purchase-archive-folder,/);
    assert.doesNotMatch(html, /@keyframes\s+moveGlow/);
  }
});
