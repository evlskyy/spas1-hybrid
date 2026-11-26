const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const mediaSource = fs.readFileSync(path.join(root, 'functions', 'api', 'media.js'), 'utf8')
  .replace('export async function onRequest', 'async function onRequest') +
  '\nthis.onRequest = onRequest;';
const middlewareSource = fs.readFileSync(path.join(root, 'functions', '_middleware.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const deployedHtml = fs.readFileSync(path.join(root, 'dist', 'index.html'), 'utf8');
const deployedMiddlewareSource = fs.readFileSync(path.join(root, 'dist', 'functions', '_middleware.js'), 'utf8');
const supabaseUrl = 'https://kgmmbjcpztioelowwdra.supabase.co';
const tenantId = '01234567-89ab-4cde-8abc-0123456789ab';
const anonKey = 'sb_publishable_Cs2hp-afSUSdalvJbH6PAw_wtTvMSnh';

function createMediaContext(fetcher) {
  const context = { fetch: fetcher, URL, Request, Response, Headers, Set, Number, JSON };
  vm.runInNewContext(mediaSource, context);
  return context;
}

function createClientContext(appHtml) {
  appHtml = appHtml || html;
  const publicUrlSource = appHtml.slice(
    appHtml.indexOf('function supabasePublicMediaUrl'),
    appHtml.indexOf('function requireSupabaseSession')
  );
  const safeImageSource = appHtml.slice(
    appHtml.indexOf('function aboutSafeImageUrl'),
    appHtml.indexOf('function loadPublicAboutPage')
  );
  const storageRequestSource = appHtml.slice(
    appHtml.indexOf('async function supabaseStorageRequest'),
    appHtml.indexOf('function clearSupabaseSession')
  );
  const context = {
    URL,
    window: {
      location: { origin: 'https://spas1.my.id' },
      SPAS1_SUPABASE_URL: supabaseUrl,
      SPAS1_SUPABASE_ANON_KEY: anonKey,
      SPAS1_SUPABASE_SESSION: 'user-token',
      SPAS1_SUPABASE_REFRESH_TOKEN: ''
    },
    supabaseHeaders: function() {
      return {
        apikey: anonKey,
        Authorization: 'Bearer user-token',
        Accept: 'application/json',
        'Content-Type': 'application/json'
      };
    },
    fetch: async function() { return new Response('ok'); },
    refreshSupabaseSession: async function() {}
  };
  vm.runInNewContext(
    publicUrlSource + safeImageSource + storageRequestSource +
      '\nthis.supabasePublicMediaUrl = supabasePublicMediaUrl;' +
      '\nthis.aboutSafeImageUrl = aboutSafeImageUrl;' +
      '\nthis.supabaseStorageRequest = supabaseStorageRequest;',
    context
  );
  return context;
}

test('public media requests stream from the allowlisted public bucket without exposing upstream headers', async function() {
  const calls = [];
  const context = createMediaContext(async function(url, options) {
    calls.push({ url: String(url), options: options });
    return new Response('image-data', {
      status: 200,
      headers: { 'Content-Type': 'image/png', 'Content-Length': '10', 'Cache-Control': 'private' }
    });
  });
  const response = await context.onRequest({
    request: new Request('https://spas1.my.id/api/media?bucket=spas1-media&path=' + encodeURIComponent(tenantId + '/team/photo.png'))
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'public, max-age=300');
  assert.equal(response.headers.get('Content-Length'), null);
  assert.equal(await response.text(), 'image-data');
  assert.equal(calls[0].url, supabaseUrl + '/storage/v1/object/public/spas1-media/' + tenantId + '/team/photo.png');
  assert.equal(calls[0].options.redirect, 'manual');
  assert.doesNotMatch(JSON.stringify(Array.from(response.headers)), /supabase\.co/i);
});

test('invalid buckets, traversal paths, and private requests without login are rejected before object fetch', async function() {
  const calls = [];
  const context = createMediaContext(async function(url) {
    calls.push(String(url));
    return new Response('{}');
  });

  const invalidBucket = await context.onRequest({
    request: new Request('https://spas1.my.id/api/media?bucket=other&path=' + encodeURIComponent(tenantId + '/photo.png'))
  });
  const traversal = await context.onRequest({
    request: new Request('https://spas1.my.id/api/media?bucket=spas1-media&path=' + encodeURIComponent(tenantId + '/../secret.png'))
  });
  const privateWithoutAuth = await context.onRequest({
    request: new Request('https://spas1.my.id/api/media?bucket=spas1-lpdh&access=authenticated&path=' + encodeURIComponent(tenantId + '/lpdh/receipt.pdf'))
  });

  assert.equal(invalidBucket.status, 400);
  assert.equal(traversal.status, 400);
  assert.equal(privateWithoutAuth.status, 401);
  assert.equal(calls.length, 0);
});

test('upstream redirects are never exposed to media clients', async function() {
  const context = createMediaContext(async function() {
    return new Response(null, {
      status: 302,
      headers: { Location: supabaseUrl + '/storage/v1/object/sign/spas1-media/file.png?token=secret' }
    });
  });
  const response = await context.onRequest({
    request: new Request('https://spas1.my.id/api/media?bucket=spas1-media&path=' + encodeURIComponent(tenantId + '/team/photo.png'))
  });
  const body = await response.text();

  assert.equal(response.status, 502);
  assert.equal(response.headers.get('Location'), null);
  assert.doesNotMatch(body, /supabase\.co|token=secret/i);
});

test('media responses reject content types outside the bucket allowlist', async function() {
  const context = createMediaContext(async function() {
    return new Response('<script>alert(1)</script>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' }
    });
  });
  const response = await context.onRequest({
    request: new Request('https://spas1.my.id/api/media?bucket=spas1-media&path=' + encodeURIComponent(tenantId + '/team/photo.png'))
  });

  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /<script>/);
});

test('private reads verify the caller and constrain the object to their SPPG', async function() {
  const calls = [];
  const context = createMediaContext(async function(url, options) {
    calls.push({ url: String(url), options: options });
    if (String(url).endsWith('/auth/v1/user')) {
      return Response.json({ app_metadata: { sppg_id: tenantId } });
    }
    return new Response('private-receipt', { status: 200, headers: { 'Content-Type': 'application/pdf' } });
  });
  const wrongTenant = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const forbidden = await context.onRequest({
    request: new Request('https://spas1.my.id/api/media?bucket=spas1-lpdh&access=authenticated&path=' + encodeURIComponent(wrongTenant + '/lpdh/receipt.pdf'), {
      headers: { Authorization: 'Bearer user-token' }
    })
  });
  const response = await context.onRequest({
    request: new Request('https://spas1.my.id/api/media?bucket=spas1-lpdh&access=authenticated&path=' + encodeURIComponent(tenantId + '/lpdh/receipt.pdf'), {
      headers: { Authorization: 'Bearer user-token' }
    })
  });

  assert.equal(forbidden.status, 403);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'private-receipt');
  assert.equal(calls.filter(function(call) { return call.url.includes('/storage/v1/object/'); }).length, 1);
  assert.equal(calls[2].options.headers.get('Authorization'), 'Bearer user-token');
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
});

test('uploads enforce MIME and size limits and forward the authenticated tenant token', async function() {
  const calls = [];
  const context = createMediaContext(async function(url, options) {
    calls.push({ url: String(url), options: options });
    if (String(url).endsWith('/auth/v1/user')) {
      return Response.json({ app_metadata: { sppg_id: tenantId } });
    }
    return Response.json({ Key: tenantId + '/team/photo.png' });
  });
  const response = await context.onRequest({
    request: new Request('https://spas1.my.id/api/media?bucket=spas1-media&path=' + encodeURIComponent(tenantId + '/team/photo.png'), {
      method: 'POST',
      headers: {
        Authorization: 'Bearer user-token',
        'Content-Type': 'image/png',
        'Content-Length': '3',
        'x-upsert': 'true'
      },
      body: 'png'
    })
  });
  const oversized = await context.onRequest({
    request: new Request('https://spas1.my.id/api/media?bucket=spas1-media&path=' + encodeURIComponent(tenantId + '/team/large.png'), {
      method: 'POST',
      headers: {
        Authorization: 'Bearer user-token',
        'Content-Type': 'image/png',
        'Content-Length': String(10 * 1024 * 1024 + 1)
      },
      body: 'png'
    })
  });

  assert.equal(response.status, 200);
  assert.equal(calls[1].url, supabaseUrl + '/storage/v1/object/spas1-media/' + tenantId + '/team/photo.png');
  assert.equal(calls[1].options.headers.get('Authorization'), 'Bearer user-token');
  assert.equal(calls[1].options.headers.get('x-upsert'), 'true');
  assert.equal(oversized.status, 413);
  assert.equal(calls.filter(function(call) { return call.url.includes('/storage/v1/object/'); }).length, 1);
});

test('source and deployed clients use same-origin media URLs and convert legacy public URLs', async function() {
  const path = tenantId + '/team/photo one.png';
  const legacyUrl = supabaseUrl + '/storage/v1/object/public/spas1-media/' + tenantId + '/team/photo%20one.png';

  for (const appHtml of [html, deployedHtml]) {
    const context = createClientContext(appHtml);
    const proxyUrl = context.supabasePublicMediaUrl(path);
    assert.match(proxyUrl, /^\/api\/media\?/);
    assert.equal(new URL(proxyUrl, 'https://spas1.my.id').searchParams.get('path'), path);
    assert.equal(context.aboutSafeImageUrl(legacyUrl), proxyUrl);
    assert.equal(context.aboutSafeImageUrl('https://example.com/image.png'), '');
    assert.equal(context.aboutSafeImageUrl(supabaseUrl + '/storage/v1/object/sign/spas1-media/file.png?token=secret'), '');
    const receiptStart = appHtml.indexOf('async function openLpdhReceipt');
    const receiptEnd = appHtml.indexOf('async function saveLpdhReport', receiptStart);
    const receiptHandler = appHtml.slice(receiptStart, receiptEnd);
    assert.doesNotMatch(receiptHandler, /storage\/v1\/object\/sign|SPAS1_SUPABASE_URL/);
    assert.match(receiptHandler, /openSupabaseMediaBlobInPopup/);
  }
});

test('the storage helper proxies media while preserving the existing RPC route', async function() {
  for (const appHtml of [html, deployedHtml]) {
    const context = createClientContext(appHtml);
    const calls = [];
    context.fetch = async function(url) {
      calls.push(String(url));
      return new Response('ok');
    };

    await context.supabaseStorageRequest('/storage/v1/object/spas1-media/' + tenantId + '/team/photo.png', { method: 'GET' });
    await context.supabaseStorageRequest('/rest/v1/rpc/update_settings', { method: 'POST', body: '{}' });

    assert.match(calls[0], /^\/api\/media\?/);
    assert.equal(new URL(calls[0], 'https://spas1.my.id').searchParams.get('path'), tenantId + '/team/photo.png');
    assert.equal(calls[1], supabaseUrl + '/rest/v1/rpc/update_settings');
  }
});

test('local static-server 404s explain how to run the Pages media function', async function() {
  for (const appHtml of [html, deployedHtml]) {
    const context = createClientContext(appHtml);
    context.window.location = { origin: 'http://127.0.0.1:5501', hostname: '127.0.0.1' };
    context.fetch = async function() {
      return new Response('<html><body>Cannot GET /api/media</body></html>', { status: 404 });
    };

    await assert.rejects(
      context.supabaseStorageRequest('/storage/v1/object/spas1-media/' + tenantId + '/team/photo.png', { method: 'GET' }),
      function(error) {
        assert.match(error.message, /Cloudflare Pages Functions tidak berjalan di Live Server/);
        assert.doesNotMatch(error.message, /<html>/);
        return true;
      }
    );
  }
});

test('the browser CSP permits proxied media without allowing the Supabase host as an image source', function() {
  for (const source of [middlewareSource, deployedMiddlewareSource]) {
    const imageSource = source.match(/"img-src ([^"]+)"/)[1];
    const connectSource = source.match(/"connect-src ([^"]+)"/)[1];
    assert.match(imageSource, /^'self'/);
    assert.doesNotMatch(imageSource, /supabase\.co/i);
    assert.match(connectSource, /kgmmbjcpztioelowwdra\.supabase\.co/);
  }
});

test('the deployed Pages function matches the source media proxy', function() {
  const deployedProxy = fs.readFileSync(path.join(root, 'dist', 'functions', 'api', 'media.js'), 'utf8');
  const sourceProxy = fs.readFileSync(path.join(root, 'functions', 'api', 'media.js'), 'utf8');
  assert.equal(deployedProxy, sourceProxy);
});
