const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8'));
const serviceWorker = fs.readFileSync(path.join(root, 'service-worker.js'), 'utf8');

function pngDimensions(filePath) {
  const image = fs.readFileSync(filePath);
  assert.equal(image.toString('hex', 0, 8), '89504e470d0a1a0a');
  return {
    width: image.readUInt32BE(16),
    height: image.readUInt32BE(20)
  };
}

test('main app advertises and registers the installable PWA', function() {
  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(html, /apple-mobile-web-app-capable/);
  assert.match(html, /serviceWorker\.register\('\/service-worker\.js'/);
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
});

test('manifest icons have the required dimensions and maskable safe area', function() {
  const iconSizes = new Map(manifest.icons.map(function(icon) {
    return [icon.src, icon.sizes];
  }));
  assert.equal(iconSizes.get('/assets/pwa-icon-192.png'), '192x192');
  assert.equal(iconSizes.get('/assets/pwa-icon-512.png'), '512x512');
  assert.equal(iconSizes.get('/assets/pwa-icon-maskable-512.png'), '512x512');
  assert.equal(pngDimensions(path.join(root, 'assets/pwa-icon-192.png')).width, 192);
  assert.equal(pngDimensions(path.join(root, 'assets/pwa-icon-192.png')).height, 192);
  assert.deepEqual(pngDimensions(path.join(root, 'assets/pwa-icon-512.png')), { width: 512, height: 512 });
  assert.deepEqual(pngDimensions(path.join(root, 'assets/pwa-icon-maskable-512.png')), { width: 512, height: 512 });
  assert.match(manifest.icons.find(function(icon) { return icon.purpose === 'maskable'; }).src, /maskable/);
});

test('service worker caches only static shell assets and uses an offline navigation fallback', function() {
  assert.match(serviceWorker, /const STATIC_ASSETS = \[[\s\S]*?OFFLINE_URL[\s\S]*?manifest\.webmanifest[\s\S]*?pwa-icon/);
  assert.match(serviceWorker, /if \(request\.mode === 'navigate'\)[\s\S]*?fetch\(request\)\.catch[\s\S]*?caches\.match\(OFFLINE_URL\)/);
  assert.match(serviceWorker, /if \(!STATIC_ASSETS\.includes\(requestUrl\.pathname\)\) return/);
  assert.match(serviceWorker, /caches\.open\(CACHE_NAME\)[\s\S]*?cache\.put\(request,\s*response\.clone\(\)\)/);
  assert.match(serviceWorker, /console\.error\('PWA static asset cache failed:'/);
});

