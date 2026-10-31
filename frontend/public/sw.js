// polycode service worker.
//
// Heavy files are downloaded once and then always served from the cache:
//   - the Python runtime (/pyodide/v<version>/…) and hashed build assets
//     (/assets/…, including Ruff's WASM and clang's 105 MB) — their URLs change when they change;
//   - C++ packages (jsDelivr, a release tag or commit SHA in the URL);
//   - Pyodide's packages (cdn.jsdelivr.net/pyodide/v<version>/…) and PyPI
//     wheels (files.pythonhosted.org) — immutable by URL as well.
// PyPI's package index is served from the cache and refreshed in the
// background. The page itself is network-first so updates arrive.
const CACHE = "polycode-v1"

// `owner/repo@<version>` in the path: a tag (v1.2.3, 3.11.3) or a full commit SHA.
const FIXED_VERSION = /^(v?\d+\.\d+\.\d+([-+].*)?|[0-9a-f]{40})$/
const fixedVersion = (url) => FIXED_VERSION.test(/@([^/]+)/.exec(url.pathname)?.[1] ?? "")

const IMMUTABLE = [
  (url) => url.origin === self.location.origin && (url.pathname.startsWith("/pyodide/") || url.pathname.startsWith("/assets/")),
  (url) => url.hostname === "cdn.jsdelivr.net" && url.pathname.startsWith("/pyodide/"),
  (url) => url.hostname === "files.pythonhosted.org",
  // C++ packages (GitHub through jsDelivr): only a release tag or a commit SHA is immutable, a branch is not.
  (url) => url.hostname === "cdn.jsdelivr.net" && url.pathname.startsWith("/gh/") && fixedVersion(url),
  (url) => url.hostname === "data.jsdelivr.com" && url.pathname.startsWith("/v1/packages/gh/") && fixedVersion(url),
]
const REVALIDATE = [(url) => url.hostname === "pypi.org"]

self.addEventListener("install", () => self.skipWaiting())
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key)
      await self.clients.claim()
    })(),
  )
})

async function cacheFirst(request) {
  const cache = await caches.open(CACHE)
  const hit = await cache.match(request, { ignoreVary: true })
  if (hit) return hit
  const response = await fetch(request)
  if (response.ok) await cache.put(request, response.clone())
  return response
}

async function staleWhileRevalidate(request, event) {
  const cache = await caches.open(CACHE)
  const hit = await cache.match(request, { ignoreVary: true })
  const refresh = fetch(request)
    .then((response) => {
      if (response.ok) return cache.put(request, response.clone()).then(() => response)
      return response
    })
    .catch(() => hit)
  if (hit) {
    event.waitUntil(refresh)
    return hit
  }
  return refresh
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE)
  try {
    const response = await fetch(request)
    if (response.ok) await cache.put(request, response.clone())
    return response
  } catch {
    const hit = await cache.match(request)
    if (hit) return hit
    throw new Error("offline")
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event
  if (request.method !== "GET") return
  const url = new URL(request.url)
  if (IMMUTABLE.some((test) => test(url))) event.respondWith(cacheFirst(request))
  else if (REVALIDATE.some((test) => test(url))) event.respondWith(staleWhileRevalidate(request, event))
  else if (request.mode === "navigate") event.respondWith(networkFirst(request))
})
