// Public-shell service worker. v9 — assets moved under /assets/ (css, js, icons). User data and live archive API responses are
// deliberately never cached here.
const CACHE_NAME = 'dsmnru-archive-v9';
const APP_SHELL = [
  '/', '/contributors.html', '/links.html', '/assets/css/styles.css', '/manifest.json',
  '/assets/icons/icon-192.png', '/assets/icons/icon-512.png', '/assets/icons/icon-maskable-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(names => Promise.all(names.filter(name => name !== CACHE_NAME).map(name => caches.delete(name)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  // Firestore/Worker requests may be authenticated or change frequently.
  if (url.pathname.startsWith('/api/') || url.hostname.endsWith('firebaseio.com') || url.hostname.endsWith('googleapis.com')) return;

  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match(event.request).then(hit => hit || caches.match('/'))));
    return;
  }

  // Cache only same-origin static assets after a successful network response.
  // Cache only same-origin static assets after a successful network response.
if (url.origin === self.location.origin && /\.(?:css|js|png|svg|woff2?)$/i.test(url.pathname)) {
  event.respondWith(
    caches.match(event.request).then(hit => {
      if (hit) return hit;

      return fetch(event.request).then(response => {
        if (response.ok) {
          const responseToCache = response.clone();

          event.waitUntil(
            caches.open(CACHE_NAME).then(cache =>
              cache.put(event.request, responseToCache)
            )
          );
        }

        return response;
      });
    })
  );
}
});
