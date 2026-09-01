const SHELL_CACHE = "bishun-shell-v21";
const CHARACTER_CACHE = "bishun-characters-v1";
const AUDIO_CACHE = "bishun-audio-v1";
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
  "data/characters.json",
  "js/config.js",
  "js/storage.js",
  "js/progress.js",
  "js/pinyin.js",
  "js/dictionary.js",
  "js/motion.js",
  "js/audio.js",
  "js/wordcard.js",
  "js/admin.js",
  "js/sync.js"
];

self.addEventListener("install", (event) => {
  // Кладём файлы по одному: один недоступный файл не должен ронять всю установку.
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => Promise.all(SHELL.map((path) => cache.add(path).catch(() => null))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    // Пользовательские данные живут в localStorage, кэш чистим только свой и по имени.
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith("bishun-") && ![SHELL_CACHE, CHARACTER_CACHE, AUDIO_CACHE].includes(key))
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  // Аудио: сначала кэш, затем сеть. Записи не меняются, поэтому это безопасно.
  if (url.origin === self.location.origin && url.pathname.includes("/audio/")) {
    event.respondWith(
      caches.open(AUDIO_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        try {
          const response = await fetch(request);
          if (response.ok) cache.put(request, response.clone());
          return response;
        } catch (error) {
          return cached || Response.error();
        }
      }),
    );
    return;
  }

  // Запросы к Supabase через сервис-воркер не проходят: они всегда идут в сеть.
  if (url.origin !== self.location.origin && !url.hostname.endsWith("jsdelivr.net")) return;

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
