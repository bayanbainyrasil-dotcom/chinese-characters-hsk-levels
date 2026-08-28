const SHELL_CACHE = "bishun-shell-v12";
const CHARACTER_CACHE = "bishun-characters-v1";
const SHELL = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "manifest.webmanifest",
  "assets/icon.svg",
  "assets/icon-180.png",
  "assets/icon-512.png",
  "assets/hanzi-writer.min.js",
  "data/verification.json",
  "data/writing.json",
  "data/vocabulary.json"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => ![SHELL_CACHE, CHARACTER_CACHE].includes(key)).map((key) => caches.delete(key)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  if (url.hostname === "cdn.jsdelivr.net" && url.pathname.includes("hanzi-writer-data")) {
    event.respondWith(
      caches.open(CHARACTER_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok || response.type === "opaque") cache.put(request, response.clone());
        return response;
      })
    );
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(request, { cache: "no-store" }).then((response) => {
        if (response.ok) caches.open(SHELL_CACHE).then((cache) => cache.put(request, response.clone()));
        return response;
      }).catch(async () => {
        const cached = await caches.match(request, { ignoreSearch: true });
        if (cached) return cached;
        if (request.mode === "navigate") return caches.match("./");
        return Response.error();
      })
    );
  }
});
