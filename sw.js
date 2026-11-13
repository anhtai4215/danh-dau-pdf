/* Service worker: lưu toàn bộ app vào bộ nhớ đệm để chạy offline. Tăng VERSION khi cập nhật app. */
const VERSION = 'pdfmark-v2.0.0';
const ASSETS = [
  './', './index.html', './style.css', './app.js', './manifest.webmanifest',
  './lib/pdf.min.js', './lib/pdf.worker.min.js', './lib/pdf-lib.min.js', './lib/fontkit.umd.min.js',
  './fonts/BeVietnamPro-Regular.ttf', './fonts/BeVietnamPro-Bold.ttf',
  './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png', './icons/apple-touch-icon.png',
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
