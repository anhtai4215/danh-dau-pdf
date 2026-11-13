/* Service worker: lưu toàn bộ app vào bộ nhớ đệm để chạy offline. Tăng VERSION khi cập nhật app. */
const VERSION = 'pdfmark-v2.1.0';
const ASSETS = [
  './', './index.html', './style.css', './app.js', './manifest.webmanifest',
  './pdf.min.js', './pdf.worker.min.js', './pdf-lib.min.js', './fontkit.umd.min.js',
  './BeVietnamPro-Regular.ttf', './BeVietnamPro-Bold.ttf',
  './icon-192.png', './icon-512.png', './maskable-512.png', './apple-touch-icon.png',
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => req.mode === 'navigate' ? caches.match('./index.html') : Response.error()))
  );
});
