/* Offline cache for the dashboard (design D11, Requirement 19.2).
 *
 * - Install: pre-cache the unhashed files. The list between the markers is replaced at build
 *   time by the `precacheListPlugin` in vite.config.ts; in dev it stays `["/"]`.
 * - After the page loads it posts the URLs it fetched (hashed build files); they are added too,
 *   because a worker installed during the first load does not see that load's requests.
 * - Same-origin GET of a cached file: cache first. `/config.json`: network first, cache fallback.
 * - Cross-origin requests (API, Cognito, S3) and non-GET requests are never touched.
 */
const PRECACHE_URLS = /*__PRECACHE_LIST__*/ ["/"] /*__END_PRECACHE_LIST__*/;
const CACHE_NAME = "warashi-dashboard-v1";
const CONFIG_PATH = "/config.json";

/** Returns the same-origin path (with search) of a URL, or null for anything else. */
function sameOriginPath(url) {
  try {
    const parsed = new URL(url, self.location.origin);
    if (parsed.origin !== self.location.origin) return null;
    return parsed.pathname + parsed.search;
  } catch {
    return null;
  }
}

async function addAllSettled(cache, paths) {
  await Promise.all(
    paths.map(async (path) => {
      try {
        const response = await fetch(path);
        if (response.ok) await cache.put(path, response);
      } catch {
        // One missing file must not break the others.
      }
    }),
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => addAllSettled(cache, PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "cache-urls" || !Array.isArray(data.urls)) return;
  const paths = [];
  for (const url of data.urls) {
    if (typeof url !== "string") continue;
    const path = sameOriginPath(url);
    if (path !== null && path !== CONFIG_PATH) paths.push(path);
  }
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      const missing = [];
      for (const path of paths) {
        if (!(await cache.match(path))) missing.push(path);
      }
      await addAllSettled(cache, missing);
    }),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname === CONFIG_PATH) {
    event.respondWith(networkFirst(request));
    return;
  }
  event.respondWith(cacheFirst(request));
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw error;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    return await fetch(request);
  } catch (error) {
    // Offline navigation: the hash router lives entirely on "/".
    if (request.mode === "navigate") {
      const shell = await cache.match("/");
      if (shell) return shell;
    }
    throw error;
  }
}
