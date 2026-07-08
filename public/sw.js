const CACHE = 'momiq-v3';
const STATIC = [
  '/',
  '/manifest.json',
  '/icon.svg',
  '/icon-maskable.svg',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(STATIC))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  // Delete ALL old caches immediately, then take control
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => {
        // Tell all open tabs to reload so they get the fresh build
        self.clients.matchAll({ type: 'window' }).then(clients => {
          clients.forEach(c => c.navigate(c.url));
        });
      })
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // API calls always go to the network — never cache AI responses
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(fetch(e.request));
    return;
  }

  // JS/CSS asset bundles: cache-first (Vite content-hashes them)
  if (url.pathname.match(/\.(js|css|woff2?|ttf)$/)) {
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
        if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        return res;
      }))
    );
    return;
  }

  // HTML navigation: network-first so deploys are picked up immediately
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        return res;
      })
      .catch(() => caches.match(e.request).then(c => c || caches.match('/')))
  );
});
