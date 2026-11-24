const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('home background does not render the children illustration', function() {
  assert.doesNotMatch(html, /#view-home::before/);
  assert.doesNotMatch(html, /maintenance-children\.jpg/);
});

test('SPPG application overlay has light-theme styles for its card and fields', function() {
  assert.match(html, /body\.app-light-mode #sppgApplicationOverlay > div \{[^}]*background-color: #FFFFFF !important;[^}]*color: #111827 !important;/);
  assert.match(html, /body\.app-light-mode #sppgApplicationOverlay input,\s*body\.app-light-mode #sppgApplicationOverlay select \{[^}]*background-color: #F9FAFB !important;[^}]*color: #111827 !important;/);
  assert.match(html, /body\.app-light-mode #sppgApplicationOverlay p\.text-slate-300 \{[^}]*color: #4B5563 !important;/);
});

test('organization Turnstile uses the active application theme', function() {
  const organizationWidget = html.slice(
    html.indexOf('function initializeOrganizationTurnstile()'),
    html.indexOf('\nfunction supabaseSelect(', html.indexOf('function initializeOrganizationTurnstile()'))
  );
  assert.match(organizationWidget, /theme: document\.body\.classList\.contains\('app-light-mode'\) \? 'light' : 'dark'/);
});

test('sponsor 404 keeps the 404 art and the generated hybrid art in the HTML footer', function() {
  assert.match(html, /\.sponsor-404-panel \{[^}]*width: min\(640px, 92%\);/);
  assert.match(html, /\.sponsor-404-ascii \{[^}]*font-size: clamp\(4px, 1\.25vw, 9\.2px\);/);
  assert.match(html, /<h1 class="sponsor-404-code" aria-label="ERROR 404 NOT FOUND"><span class="sponsor-404-ascii" aria-hidden="true">/);
  assert.ok(html.includes(String.raw`$$$$$$$\   $$$$$$\ $$$$$$\         $$ /  \__|$$$$$$\  $$\   $$\ $$$$$$$\   $$$$$$$ |`));
  assert.doesNotMatch(html, /class="sponsor-404-status"|class="sponsor-404-brand"|class="sponsor-404-message"|class="sponsor-404-name-art"|aria-label="spas1-hybrid"|Halaman Ini Sedang Dalam Pencarian/);
  const ending = html.match(/<\/body>\n<!--\n([\s\S]+?)\n-->\n<\/html>\s*$/);
  assert.ok(ending);
  const expectedLogo = String.raw`
                                          $$\         $$\                 $$\                 $$\       $$\
                                        $$$$ |        $$ |                $$ |                \__|      $$ |
 $$$$$$$\  $$$$$$\   $$$$$$\   $$$$$$$\ \_$$ |        $$$$$$$\  $$\   $$\ $$$$$$$\   $$$$$$\  $$\  $$$$$$$ |
$$  _____|$$  __$$\  \____$$\ $$  _____|  $$ |$$$$$$\ $$  __$$\ $$ |  $$ |$$  __$$\ $$  __$$\ $$ |$$  __$$ |
\$$$$$$\  $$ /  $$ | $$$$$$$ |\$$$$$$\    $$ |\______|$$ |  $$ |$$ |  $$ |$$ |  $$ |$$ |  \__|$$ |$$ /  $$ |
 \____$$\ $$ |  $$ |$$  __$$ | \____$$\   $$ |        $$ |  $$ |$$ |  $$ |$$ |  $$ |$$ |      $$ |$$ |  $$ |
$$$$$$$  |$$$$$$$  |\$$$$$$$ |$$$$$$$  |$$$$$$\       $$ |  $$ |\$$$$$$$ |$$$$$$$  |$$ |      $$ |\$$$$$$$ |
\_______/ $$  ____/  \_______|\_______/ \______|      \__|  \__| \____$$ |\_______/ \__|      \__| \_______|
          $$ |                                                  $$\   $$ |
          $$ |                                                  \$$$$$$  |
          \__|                                                   \______/
`.slice(1, -1);
  assert.equal(ending[1], expectedLogo);
});
