/*
 * sw.js — Service Worker
 *
 * 役割:
 *   1. 通知の表示先 (タブが裏に回っていても showNotification が使える)
 *   2. 通知タップでアプリを開く / 既に開いていればそのタブを前面に出す
 *   3. オフラインでも起動できるよう、アプリ本体をキャッシュする
 *
 * カード自体は localStorage / IndexedDB にあるので、
 * ここでキャッシュするのはアプリのファイルだけ。
 */

const CACHE = 'flashcards-v15';
const ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/srs.js',
  './js/media.js',
  './js/store.js',
  './js/sync.js',
  './js/notify.js',
  './js/app.js',
  './manifest.webmanifest',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS))
      .catch(() => {})           // 1 つでも失敗したらキャッシュ無しで続行
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ネットワーク優先 (更新をすぐ反映)、失敗時のみキャッシュを返す
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Firebase などは素通し
  event.respondWith(
    fetch(req)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
  );
});

// 通知をタップしたらアプリを開く
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow(target);
    })
  );
});

// アプリ側から通知の表示を依頼された場合
self.addEventListener('message', event => {
  const d = event.data || {};
  if (d.type === 'notify') {
    self.registration.showNotification(d.title || '復習の時間です', {
      body: d.body || '',
      tag: 'flashcards-review-reminder',
      renotify: true,
    });
  }
});
