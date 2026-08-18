// Service Worker for DSMNRU Academic Archive PWA
const CACHE_NAME = 'dsmnru-archive-v6';
const urlsToCache = [
  '/',
  '/index.html',
  '/paper.html',
  '/contributors.html',
  '/tools.html',
  '/links.html',
  '/styles.css',
  '/script.js',
  '/paper.js',
  '/courses.json',
  '/manifest.json'
];

// Install Service Worker
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        return cache.addAll(urlsToCache);
      })
  );
});

// Fetch Event - Serve from cache when offline.
// API calls (/api/* or the configured Worker URL) are ALWAYS fetched from the
// network — the Cloudflare Worker handles caching, so the SW must never serve
// stale API responses.
self.addEventListener('fetch', event => {
  const requestUrl = new URL(event.request.url);
  const isApiCall = requestUrl.pathname.startsWith('/api/') ||
    (typeof self.__DSMNRU_API_HOST === 'string' && requestUrl.hostname === self.__DSMNRU_API_HOST);

  if (isApiCall) {
    event.respondWith(fetch(event.request));
    return;
  }

  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // Return cached version or fetch from network
        return response || fetch(event.request);
      })
  );
});

// Activate Event - Clean up old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});
