/* Register only after the user explicitly chooses offline preparation.
 * Bump VERSION whenever any app/engine asset changes. No media is cached. */
const VERSION = 'songsam-audio-static-v1.2.1';
const PREFIX = 'songsam-audio-static-';
const FILES = [
  'index.html', 'style.css', 'theme.js', 'app.js', 'model.js', 'engine.js',
  'engine-worker.js', 'engine-capabilities.json',
  'vendor/ffmpeg-core.js', 'vendor/ffmpeg-core.wasm',
  'vendor/PretendardVariable.woff2',
];
const URLS = FILES.map(path => new URL(path, self.registration.scope).href);
const ALLOWED = new Set(URLS);
const INDEX = new URL('index.html', self.registration.scope).href;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    try {
      // addAll is atomic: a partial download never reports offline readiness.
      await cache.addAll(URLS.map(url => new Request(url, { cache: 'reload' })));
    } catch (error) {
      await caches.delete(VERSION);
      throw error;
    }
    // No skipWaiting: an update cannot replace resources during active work.
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith(PREFIX) && name !== VERSION) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.search) return;
  let target = url.href;
  if (request.mode === 'navigate' && target === self.registration.scope) target = INDEX;
  if (!ALLOWED.has(target)) return;
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(target);
    return hit || fetch(request); // Missing resources are never cached implicitly.
  })());
});

self.addEventListener('message', event => {
  const port = event.ports?.[0];
  if (!port || !event.data || typeof event.data.type !== 'string') return;
  if (event.data.type === 'CACHE_STATUS') {
    event.waitUntil((async () => {
      const cache = await caches.open(VERSION);
      const present = await Promise.all(URLS.map(url => cache.match(url)));
      const count = present.filter(Boolean).length;
      port.postMessage({ type: 'CACHE_STATUS', ready: count === URLS.length, count,
        total: URLS.length, version: VERSION });
    })());
  } else if (event.data.type === 'CLEAR_STATIC_CACHE') {
    event.waitUntil((async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith(PREFIX)) await caches.delete(name);
      }
      port.postMessage({ type: 'CLEAR_STATIC_CACHE', cleared: true });
    })());
  }
});
