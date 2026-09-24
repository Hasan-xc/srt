/**
 * sw.js — Service Worker للموقع (تحت مسار فرعي: كل المسارات نسبية ./)
 *
 * القواعد:
 *  - نفس الأصل (GET): network-first مع fallback للكاش.
 *  - مكتبات CDN الثقيلة (ffmpeg/lamejs): cache-first.
 *  - لا يُعترض ولا يُخزَّن أبداً: api.groq.com و openrouter.ai و api.kie.ai
 *    وأي طلب غير GET (المفاتيح والصوت والترجمة لا تمر من هنا أبداً).
 */

const CACHE_VERSION = 'v1';
const CACHE_NAME = 'srt-shell-' + CACHE_VERSION;

const CDN_HOSTS = ['cdn.jsdelivr.net', 'esm.sh', 'unpkg.com'];
const NEVER_HOSTS = ['api.groq.com', 'openrouter.ai', 'api.kie.ai'];

const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './manifest.json',
  './icons/logo.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
  './js/main.js',
  './js/state.js',
  './js/ui.js',
  './js/core.js',
  './js/editor.js',
  './js/video.js',
  './js/styling.js',
  './js/transcribe.js',
  './js/translate.js',
  './js/apiClient.js',
  './js/autosave.js',
  './js/history.js',
  './js/glossary.js',
  './js/projects.js',
  './js/parsers.js',
  './js/time.js'
];

/* ── install: تخزين هيكل التطبيق ── */
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL))
  );
});

/* ── activate: تنظيف الكاش القديم + السيطرة الفورية ── */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* ── fetch ── */
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // لا اعتراض إطلاقاً لغير GET
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  // لا اعتراض إطلاقاً لنقاط الـAPI (المفاتيح والبيانات الخاصة)
  if (NEVER_HOSTS.includes(url.hostname)) return;

  // مكتبات CDN: cache-first (ffmpeg ثقيل لا يُعاد تنزيله)
  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy));
        }
        return res;
      }))
    );
    return;
  }

  // نفس الأصل: network-first مع fallback للكاش
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() =>
          caches.match(req).then((hit) =>
            hit || (req.mode === 'navigate' ? caches.match('./index.html') : undefined)
          )
        )
    );
  }
  // غير ذلك (أطراف خارجية أخرى): تمر عادي بلا اعتراض
});
