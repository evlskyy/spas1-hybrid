const CACHE_NAME = 'spas1-hybrid-pwa-v1';
const OFFLINE_URL = '/offline';
const STATIC_ASSETS = [
  OFFLINE_URL,
  '/manifest.webmanifest',
  '/assets/pwa-icon-192.png',
  '/assets/pwa-icon-512.png',
  '/assets/pwa-icon-maskable-512.png'
];

self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function(cache) { return cache.addAll(STATIC_ASSETS); })
      .then(function() { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys()
      .then(function(cacheNames) {
        return Promise.all(cacheNames
          .filter(function(cacheName) {
            return cacheName.startsWith('spas1-hybrid-pwa-') && cacheName !== CACHE_NAME;
          })
          .map(function(cacheName) { return caches.delete(cacheName); }));
      })
      .then(function() { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(event) {
  const request = event.request;
  const requestUrl = new URL(request.url);
  if (request.method !== 'GET' || requestUrl.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(function() {
        return caches.match(OFFLINE_URL);
      })
    );
    return;
  }

  if (!STATIC_ASSETS.includes(requestUrl.pathname)) return;
  event.respondWith(
    fetch(request).then(function(response) {
      if (!response.ok || response.type !== 'basic') return response;
      return caches.open(CACHE_NAME)
        .then(function(cache) { return cache.put(request, response.clone()); })
        .catch(function(error) {
          console.error('PWA static asset cache failed:', error);
        })
        .then(function() { return response; });
    }).catch(function() {
      return caches.match(request);
    })
  );
});
