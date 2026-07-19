const CACHE = 'wc2026-v56';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './photos.json',
  './favicon.ico',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { title: 'World Cup', body: e.data ? e.data.text() : '' }; }
  const title = data.title || 'World Cup 2026';
  const body = data.body || '';
  const tag = data.type && data.eventId ? `${data.type}:${data.eventId}` : undefined;
  e.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      renotify: !!tag,
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      data: { eventId: data.eventId || null },
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  // Open the APP (registration scope), not the origin root — the app may live
  // at a sub-path (e.g. /world-cup-2026/). Deep-link to the match if we have
  // its id so the right game opens.
  const base = self.registration.scope;
  const eventId = e.notification.data && e.notification.data.eventId;
  const target = eventId ? `${base}?match=${encodeURIComponent(eventId)}` : base;
  e.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of all) {
        if (client.url && client.url.startsWith(base) && 'focus' in client) {
          await client.focus();
          if ('navigate' in client) { try { await client.navigate(target); } catch {} }
          return;
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(target);
    })()
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(e.request).then((cached) => cached || fetch(e.request))
    );
    return;
  }
  if (url.hostname.endsWith('espn.com')) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
  }
});
