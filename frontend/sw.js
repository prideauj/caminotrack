// Service worker: lets the app open and keep working without a signal.
//   - the page, scripts and libraries are saved on first visit and used when offline
//   - map tiles are served from the saved ones (see offline.js) or from a small cache of tiles already seen
//   - /api/config and /api/town answers are kept, so town descriptions seen once (or saved with a stage) still open
// Bump VERSION whenever the scripts change, and keep PRECACHE in step with the ?v= numbers in index.html.
const VERSION = 'v10';
const SHELL = `shell-${VERSION}`;
const RUNTIME = `runtime-${VERSION}`;
const LIVE_TILES = 'tiles-live-v1';        // tiles seen while browsing: trimmed. (tiles-v1, saved on purpose, is never touched here)
const MAX_LIVE_TILES = 800;

const PRECACHE = [
    '/',
    '/static/app.js?v=10',
    '/static/walk.js?v=10',
    '/static/weather.js?v=10',
    '/static/offline.js?v=10',
    '/manifest.webmanifest',
    '/static/icons/icon-192.png',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
    'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js'
];

const TILE_PATH = /\/\d{1,2}\/\d+\/\d+\.(png|jpe?g|webp)$/;

self.addEventListener('install', event => {
    event.waitUntil((async () => {
        const cache = await caches.open(SHELL);
        // One missing file shouldn't stop the rest being saved
        await Promise.allSettled(PRECACHE.map(url => cache.add(new Request(url, { cache: 'reload' }))));
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const keep = new Set([SHELL, RUNTIME, LIVE_TILES, 'tiles-v1']);
        for (const name of await caches.keys()) if (!keep.has(name)) await caches.delete(name);
        await self.clients.claim();
    })());
});

async function networkFirst(request, cacheName, timeoutMs) {
    const cache = await caches.open(cacheName);
    try {
        const controller = new AbortController();
        const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
        const response = await fetch(request, { signal: controller.signal });
        if (timer) clearTimeout(timer);
        if (response.ok) cache.put(request, response.clone());
        return response;
    } catch (error) {
        const cached = await cache.match(request);
        if (cached) return cached;
        throw error;
    }
}

async function cacheFirst(request, cacheName) {
    const cached = await caches.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok) (await caches.open(cacheName)).put(request, response.clone());
    return response;
}

async function tile(request) {
    const cached = await caches.match(request.url);   // saved or already seen (any origin, whatever the request mode)
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok || response.type === 'opaque') {
        const cache = await caches.open(LIVE_TILES);
        await cache.put(request.url, response.clone());
        const keys = await cache.keys();
        if (keys.length > MAX_LIVE_TILES) await cache.delete(keys[0]);
    }
    return response;
}

self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);

    if (TILE_PATH.test(url.pathname)) {
        event.respondWith(tile(request));
    } else if (url.origin === self.location.origin) {
        if (request.mode === 'navigate' || url.pathname === '/') {
            event.respondWith(networkFirst(new Request('/'), SHELL, 4000));
        } else if (url.pathname === '/api/config' || url.pathname === '/api/town') {
            event.respondWith(networkFirst(request, RUNTIME, 6000));
        } else if (url.pathname.startsWith('/static/') || url.pathname === '/manifest.webmanifest') {
            // The app's own files: the fresh copy when there's a signal (so an update is never missed), the saved one when not
            event.respondWith(networkFirst(request, SHELL, 4000));
        }
        // anything else (sync, place lookups, health) goes straight to the network
    } else if (url.hostname === 'unpkg.com' || url.hostname === 'cdn.jsdelivr.net') {
        event.respondWith(cacheFirst(request, SHELL));
    }
});
