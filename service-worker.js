const CACHE = 'cartograph-v2';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

const TILE_CACHE = 'cartograph-tiles-v1';
const KEEP = [CACHE, TILE_CACHE];

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => !KEEP.includes(k)).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

const TILE_CACHE_LIMIT = 400; // roughly enough for a few explored neighborhoods

async function trimTileCache() {
  const cache = await caches.open(TILE_CACHE);
  const keys = await cache.keys();
  if (keys.length > TILE_CACHE_LIMIT) {
    await cache.delete(keys[0]);
  }
}

// App shell: cache-first. Map tiles: cache-first with background refresh (so explored
// chunks stay visible offline). Everything else (search/routing APIs): network-first.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  const isShell = SHELL.some((p) => url.pathname.endsWith(p.replace('./', '/')));
  const isTile = url.hostname.endsWith('basemaps.cartocdn.com');

  if (isShell) {
    e.respondWith(caches.match(e.request).then((cached) => cached || fetch(e.request)));
    return;
  }

  if (isTile) {
    e.respondWith(
      caches.open(TILE_CACHE).then(async (cache) => {
        const cached = await cache.match(e.request);
        const fetchPromise = fetch(e.request)
          .then((res) => { cache.put(e.request, res.clone()); trimTileCache(); return res; })
          .catch(() => cached);
        return cached || fetchPromise;
      })
    );
    return;
  }

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
