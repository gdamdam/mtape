// mtape service worker.
//
// Adapted from the mspectr/mgrains suite service worker. mtape deploys at the
// domain root (base '/'), so APP_BASE is always '/'; the runtime strategy is
// split — hashed /assets/* are immutable (cache-first), while other same-origin
// shell resources (icons, manifest) use stale-while-revalidate so a redeploy can
// refresh them without blocking.
//
// Caching contract:
//   - navigations          → network-first, fall back to cached index.html offline
//   - /assets/* (hashed)   → cache-first (content-hashed, immutable)
//   - other same-origin    → stale-while-revalidate (icons, manifest, favicon)
//   - version.json         → bypass (always hit the network; never cache)
//   - cross-origin         → bypass (let the browser handle it)

// Bump this whenever the caching strategy changes; activate() purges older caches.
// Replaced with a hash of the emitted asset names by vite.config.ts.
const BUILD_FINGERPRINT = '__BUILD_FINGERPRINT__'
const SHELL_CACHE = `mtape-shell-${BUILD_FINGERPRINT}`
// Runtime cache is size-capped: hashed bundles from past deploys would otherwise
// accumulate forever (sw.js never changes between deploys, so the cache name
// alone can't evict them). Trimming to a fixed budget bounds disk usage.
const RUNTIME_CACHE = `mtape-runtime-${BUILD_FINGERPRINT}`
const RUNTIME_MAX_ENTRIES = 64

// Root deployment: scope is the origin root, so APP_BASE is '/'. Derived from the
// worker location so a subpath preview build still resolves correctly.
const APP_BASE = new URL('./', self.location.href).pathname
const SHELL_URLS = [APP_BASE, `${APP_BASE}manifest.webmanifest`, `${APP_BASE}favicon.svg`]

async function precache() {
  const cache = await caches.open(SHELL_CACHE)
  await cache.addAll(SHELL_URLS)
  // Precache the content-hashed build assets (JS/CSS/worklet) listed in the
  // generated manifest. The SW activates after the first visit's assets have
  // already loaded, so without this they would not be cached until re-requested,
  // leaving the first offline load broken. Best-effort: a missing manifest (dev
  // build) or fetch failure still leaves the shell cached and assets fall back to
  // the runtime handlers below.
  try {
    const response = await fetch(`${APP_BASE}precache-manifest.json`, { cache: 'no-store' })
    if (response.ok) {
      const assets = await response.json()
      if (Array.isArray(assets)) {
        await cache.addAll(assets.map((path) => `${APP_BASE}${path}`))
      }
    }
  } catch {
    // Offline precache of hashed assets is best-effort; ignore failures.
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache())
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  // Keep claim() inside waitUntil so the browser can't terminate the worker
  // before old caches are purged and clients are claimed.
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key !== SHELL_CACHE && key !== RUNTIME_CACHE)
          .map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  )
})

// Drop the oldest entries until the cache is within budget. cache.keys() returns
// requests in insertion order, so the front of the list is the least recently
// added — delete from there.
async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName)
  const keys = await cache.keys()
  for (let i = 0; i < keys.length - maxEntries; i += 1) {
    await cache.delete(keys[i])
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)

  // Cross-origin: never intercept — let the browser handle it.
  if (url.origin !== self.location.origin) return

  // version.json is the deploy/update probe; it must always be fresh, so bypass
  // the cache entirely and let the network handle it.
  if (url.pathname === `${APP_BASE}version.json`) return

  // Network-first for navigations: a stale cached index.html points at hashed
  // asset URLs that no longer exist after a deploy, which renders a blank page.
  // Always try the network, refresh the cached shell, and fall back to cache offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            // Attach the cache refresh to the event so it isn't cut short if the
            // worker is stopped right after the response is delivered.
            const copy = response.clone()
            event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy)))
          }
          return response
        })
        .catch(() => caches.match(request).then((cached) => cached ?? caches.match(APP_BASE))),
    )
    return
  }

  // Cache-first for hashed build assets under /assets/: they are content-hashed
  // and immutable, so a cache hit is always correct and avoids a network round
  // trip. Check the precache (shell) first, then the runtime cache; on a miss,
  // fetch and store into the runtime cache, trimming back to RUNTIME_MAX_ENTRIES
  // so past releases' obsolete bundles can't grow it without bound.
  if (url.pathname.startsWith(`${APP_BASE}assets/`)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached
        return fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone()
            event.waitUntil(
              caches.open(RUNTIME_CACHE)
                .then((cache) => cache.put(request, copy))
                .then(() => trimCache(RUNTIME_CACHE, RUNTIME_MAX_ENTRIES)),
            )
          }
          return response
        })
      }),
    )
    return
  }

  // Stale-while-revalidate for everything else same-origin (icons, manifest,
  // favicon): serve the cached copy immediately when present, while fetching a
  // fresh copy in the background to update the cache for next time. Falls back to
  // the network when nothing is cached yet.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone()
            event.waitUntil(caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy)))
          }
          return response
        })
        .catch(() => cached)
      return cached ?? network
    }),
  )
})
