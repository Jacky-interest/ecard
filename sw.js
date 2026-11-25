'use strict';

// Only the public application shell is cached. User photos and form values never
// enter CacheStorage, and no requests outside this exact app scope are handled.
const APP_VERSION = 'ca91149f4f5705f6';
const SCOPE_URL = new URL(self.registration.scope);
const CACHE_PREFIX = 'ecard-offline-' + encodeURIComponent(self.registration.scope) + '-';
const CACHE_NAME = CACHE_PREFIX + APP_VERSION;
const SHELL_PATHS = [
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];
const SHELL_URLS = SHELL_PATHS.map(path => new URL(path, SCOPE_URL).href);
const INDEX_URL = SHELL_URLS[0];
const INDEX_PATH = new URL(INDEX_URL).pathname;
const SHELL_SET = new Set(SHELL_URLS);
const META_URL = new URL('./.offline-cache-meta', SCOPE_URL).href;
const VERSION_META = '<meta name="ecard-app-version" content="' + APP_VERSION + '">';

async function indexVersionMatches(response) {
  return Boolean(response && response.ok && (await response.text()).includes(VERSION_META));
}

function metadataResponse(installedAt, complete) {
  return new Response(JSON.stringify({ version:APP_VERSION, installedAt, complete }), {
    headers: { 'Content-Type':'application/json' }
  });
}

async function readMetadata(cache) {
  const response = await cache.match(META_URL);
  if (!response) return null;
  try {
    const data = await response.json();
    return Number.isFinite(data.installedAt) ? data : null;
  } catch (_) {
    return null;
  }
}

async function nextInstallationStamp() {
  let stamp = Date.now();
  const names = await caches.keys();
  for (const name of names.filter(name => name.startsWith(CACHE_PREFIX))) {
    const metadata = await readMetadata(await caches.open(name));
    if (metadata) stamp = Math.max(stamp, metadata.installedAt + 1);
  }
  // Device clock changes must not make a newer waiting cache look obsolete.
  // Concurrent installations can share a stamp; equal stamps are retained.
  return stamp;
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const installedAt = await nextInstallationStamp();
    // Stamp before fetching so another worker can distinguish an in-progress,
    // newer installation from an obsolete cache. An incomplete install is never
    // reported as ready, and addAll rejects if any shell resource fails.
    await cache.put(META_URL, metadataResponse(installedAt, false));
    await cache.addAll(SHELL_URLS.map(url => new Request(url, {
      cache:'reload', credentials:'same-origin'
    })));
    // GitHub Pages can briefly serve files from different deployment versions.
    // Never mark an old/mixed HTML shell as ready for this worker's version.
    if (!(await indexVersionMatches(await cache.match(INDEX_URL)))) throw new Error('Cached app version does not match service worker');
    await cache.put(META_URL, metadataResponse(installedAt, true));
    // Existing users retain their current worker until they choose the update
    // action. The first installation activates normally without skipWaiting.
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const current = await caches.open(CACHE_NAME);
    const currentMetadata = await readMetadata(current);
    if (currentMetadata && currentMetadata.complete) {
      const names = await caches.keys();
      await Promise.all(names.filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map(async name => {
        const cache = await caches.open(name);
        const metadata = await readMetadata(cache);
        // Do not delete a newer installed/waiting worker's cache or an unknown
        // cache which may be in the middle of being initialized.
        if (metadata && metadata.installedAt < currentMetadata.installedAt) await caches.delete(name);
      }));
    }
    await self.clients.claim();
  })());
});

async function cacheFirst(request, canonicalUrl) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(canonicalUrl);
  // A missing resource can be read online, but runtime responses are not added
  // to this immutable version's cache. Only install precaches application files.
  return cached || fetch(request);
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== SCOPE_URL.origin || !url.pathname.startsWith(SCOPE_URL.pathname)) return;

  if (request.mode === 'navigate') {
    if (url.pathname === SCOPE_URL.pathname || url.pathname === INDEX_PATH) {
      // Both the Pages directory URL and index.html are the same local shell.
      // Query strings must not defeat offline launch from an installed icon.
      event.respondWith(cacheFirst(request, INDEX_URL));
    }
    return;
  }
  if (SHELL_SET.has(url.href)) event.respondWith(cacheFirst(request, url.href));
});

async function offlineReady() {
  if (!(await caches.keys()).includes(CACHE_NAME)) return false;
  const cache = await caches.open(CACHE_NAME);
  const metadata = await readMetadata(cache);
  if (!metadata || !metadata.complete || metadata.version !== APP_VERSION) return false;
  const responses = await Promise.all(SHELL_URLS.map(url => cache.match(url)));
  return responses.every(response => response && response.ok) && await indexVersionMatches(responses[0]);
}

self.addEventListener('message', event => {
  if (!event.data) return;
  if (event.data.type === 'SKIP_WAITING') {
    event.waitUntil(self.skipWaiting());
  } else if (event.data.type === 'GET_STATUS' && event.ports && event.ports[0]) {
    event.waitUntil((async () => {
      let ready = false;
      try { ready = await offlineReady(); } catch (_) { /* Reply honestly if storage fails. */ }
      event.ports[0].postMessage({ type:'OFFLINE_STATUS', version:APP_VERSION, ready });
    })());
  }
});
