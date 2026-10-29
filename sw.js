const CACHE_NAME = 'yolk-pwa-v1';
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/yolk-app.js',
    '/output.css',
    '/manifest.json',
    '/icon-256.png',
    '/apple-touch-icon.png',
    '/favicon.png',
    '/favicon.svg'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(STATIC_ASSETS);
        }).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
            );
        }).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Bypass caching for stream and API endpoints (handled dynamically or via IndexedDB offline storage)
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/music-api/')) {
        return;
    }

    // Static assets & navigation: Stale-While-Revalidate with offline fallback to /index.html
    event.respondWith(
        caches.match(event.request).then((cachedResponse) => {
            const fetchPromise = fetch(event.request).then((networkResponse) => {
                if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
                    const responseToCache = networkResponse.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(event.request, responseToCache);
                    });
                }
                return networkResponse;
            }).catch(() => {
                // If offline and navigating, return cached root/index.html
                if (event.request.mode === 'navigate') {
                    return caches.match('/index.html') || caches.match('/');
                }
            });

            return cachedResponse || fetchPromise;
        })
    );
});
