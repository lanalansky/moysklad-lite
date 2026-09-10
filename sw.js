// Minimal service worker, only present so the browser considers kassa.html
// installable as a PWA. No offline caching: the app is useless without a
// live connection to the Google Sheet anyway, so there is nothing safe to
// serve from cache.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
