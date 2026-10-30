const CACHE = 'olbrygging-shell-v2';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/pwa.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key.startsWith('olbrygging-shell-') && key !== CACHE).map((key) => caches.delete(key)),
  )));
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !SHELL.includes(url.pathname)) return;
  // A worker version serves its matching shell; API responses are never cached.
  event.respondWith(caches.open(CACHE).then(async (cache) => {
    const cached = await cache.match(url.pathname);
    return cached || fetch(event.request);
  }));
});
