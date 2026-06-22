const CACHE = 'hrs-cache-v1';
const ASSETS = [
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.webmanifest',
  'https://unpkg.com/@ffmpeg/ffmpeg@0.12.6/dist/ffmpeg.min.js',
  'https://unpkg.com/@ffmpeg/core@0.12.6/dist/ffmpeg-core.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => k !== CACHE && caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Do not cache blob/object URLs or POSTs; only static GET requests
  if (e.request.method !== 'GET' || url.protocol === 'blob:') return;
  e.respondWith(
    caches.match(e.request).then(res => res || fetch(e.request).then(resp => {
      // Cache only same-origin static assets
      if (e.request.url.startsWith(self.location.origin)) {
        const copy = resp.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
      }
      return resp;
    }))
  );
});
