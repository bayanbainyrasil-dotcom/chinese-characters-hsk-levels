// Китайская озвучка: три источника, от лучшего к запасному.
//
//   1. Статический пак mp3 в репозитории — мгновенно, работает офлайн и в PWA.
//   2. Edge Function `tts` в Supabase — нейронный голос путунхуа, ключ живёт
//      только в переменных окружения функции и во frontend не попадает.
//   3. Голос браузера (speechSynthesis) — только как аварийный запас.
//
// Автовоспроизведение считается с ограничениями Safari/iOS: пока пользователь
// не коснулся тренажёра, звук не запускается; после первого касания один и тот
// же <audio> переиспользуется, и повторные вызовы play() уже разрешены.

import { CONFIG, functionUrl, backendReady } from "./config.js";
import { KEYS, readJson, writeJson } from "./storage.js";

const CACHE_NAME = "bishun-audio-v1";
const SILENCE = "data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4LjI5LjEwMAAAAAAAAAAAAAAA//tQxAADB8AhSmxhIIEVCSiJrDCQBTcu3UrAIwUdkRgQbFAZC1CQEwTJ9mjRvBA4UOLD8nKVOWfh+UlK3z/177OXrfOdKl7pyn3Xf//WreyTRUoAWgBgkOAGbZHBgG1OF6zM82DWbZaUmMBptgQhGjsyYqc9ae9XFz280948NMBWInljyzsNRFLPWdnZGWrddDsjK1unuSrVN9jJsK8KuQtQCtMBjCEtImISdNKJOopIpBFpNSMbIHCSRpRR5iakjTiyzLhchUUBwCgyKiweBv/7UsQbg8isVNJsPMBBGwqcTYeYCJKFOMkkiibokmk4pJJBhFDySRpRR5iakjTiyzLhchUUBwCgyKiweBqIskkiibokmk4pJJBhFDySRpRR5iakjTiyzLhchUUBwCgyKiweBqIskkiibokmk4pJJBhFDySRpRR5iakjTiyzLhchUUBwCgyKiweBqIskkiibokmk4pJJBhFDySRpRR5iakjTiyzLhchUUBwCgyKiweBqIskkiibokmk4pJJBhFDySRpRR5iakjTiyzLhchUUBwCgw=";

const state = {
  settings: null,
  unlocked: false,
  element: null,
  manifest: null,
  manifestPromise: null,
  serverUrls: new Map(),
  playing: false,
  token: 0,
};

const listeners = new Set();

export function onAudioState(handler) {
  listeners.add(handler);
  return () => listeners.delete(handler);
}

function emit(payload) {
  for (const handler of listeners) {
    try { handler(payload); } catch (error) { console.error(error); }
  }
}

export function loadAudioSettings() {
  if (!state.settings) {
    state.settings = {
      autoSpeak: true, volume: 0.9, muted: false, slowRate: 0.6,
      ...readJson(KEYS.audioSettings, {}),
    };
  }
  return state.settings;
}

export function updateAudioSettings(patch) {
  const next = { ...loadAudioSettings(), ...patch };
  state.settings = next;
  writeJson(KEYS.audioSettings, next);
  if (state.element) state.element.volume = next.muted ? 0 : clamp(next.volume);
  emit({ type: "settings", settings: next });
  return next;
}

function clamp(value) { return Math.min(1, Math.max(0, Number(value) || 0)); }

/** Стабильный идентификатор файла: hex от UTF-8. Так же считает tools/generate-audio.mjs. */
export function audioId(text) {
  const bytes = new TextEncoder().encode(String(text || "").trim());
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function element() {
  if (!state.element) {
    const audio = new Audio();
    audio.preload = "auto";
    audio.setAttribute("playsinline", "");
    audio.volume = state.settings?.muted ? 0 : clamp(state.settings?.volume ?? 0.9);
    audio.addEventListener("ended", () => { state.playing = false; emit({ type: "end" }); });
    audio.addEventListener("error", () => { state.playing = false; emit({ type: "end" }); });
    state.element = audio;
  }
  return state.element;
}

/**
 * Разблокировка звука первым касанием — требование Safari/iOS.
 * Вешается на реальное взаимодействие с тренажёром, а не на загрузку страницы.
 */
export function unlockAudio() {
  if (state.unlocked) return true;
  const audio = element();
  try {
    audio.src = SILENCE;
    const promise = audio.play();
    if (promise?.then) {
      promise.then(() => { audio.pause(); audio.currentTime = 0; }).catch(() => {});
    }
    state.unlocked = true;
  } catch (_) { /* браузер откажет — попробуем при следующем касании */ }
  return state.unlocked;
}

export function audioUnlocked() { return state.unlocked; }

async function manifest() {
  if (state.manifest) return state.manifest;
  if (!state.manifestPromise) {
    state.manifestPromise = fetch(`${CONFIG.audioBase}/manifest.json`, { cache: "force-cache" })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        state.manifest = payload && Array.isArray(payload.ids) ? new Set(payload.ids) : new Set();
        return state.manifest;
      })
      .catch(() => { state.manifest = new Set(); return state.manifest; });
  }
  return state.manifestPromise;
}

function staticUrl(text, slow) {
  return `${CONFIG.audioBase}/${slow ? "s" : "n"}/${audioId(text)}.mp3`;
}

async function hasStatic(text, slow) {
  const ids = await manifest();
  return ids.has(audioId(text)) ? staticUrl(text, slow) : null;
}

async function serverUrl(text, slow) {
  if (!backendReady()) return null;
  const key = `${slow ? "s" : "n"}:${text}`;
  if (state.serverUrls.has(key)) return state.serverUrls.get(key);
  try {
    const response = await fetch(functionUrl(CONFIG.ttsFunction), {
      method: "POST",
      headers: { "content-type": "application/json", apikey: CONFIG.supabaseAnonKey },
      body: JSON.stringify({ text, rate: slow ? "slow" : "normal" }),
    });
    if (!response.ok) return null;
    const payload = await response.json();
    if (payload?.url) {
      state.serverUrls.set(key, payload.url);
      return payload.url;
    }
  } catch (error) {
    console.warn("Сервер озвучки недоступен", error);
  }
  return null;
}

async function resolveUrl(text, slow) {
  return (await hasStatic(text, slow)) || (await serverUrl(text, slow));
}

/** Заранее кладёт запись в кэш, чтобы следующий знак звучал без задержки. */
export async function prefetch(text, { slow = false } = {}) {
  if (!text) return;
  try {
    const url = await resolveUrl(text, slow);
    if (!url) return;
    const cache = await caches.open(CACHE_NAME);
    if (await cache.match(url)) return;
    const response = await fetch(url, { mode: "cors" });
    if (response.ok) await cache.put(url, response.clone());
  } catch (_) { /* предзагрузка необязательна */ }
}

async function cachedBlobUrl(url) {
  try {
    const cache = await caches.open(CACHE_NAME);
    let response = await cache.match(url);
    if (!response) {
      response = await fetch(url, { mode: "cors" });
      if (response.ok) await cache.put(url, response.clone());
    }
    if (!response?.ok) return url;
    return URL.createObjectURL(await response.blob());
  } catch (_) {
    return url;
  }
}

function speakWithBrowser(text, slow, auto = false) {
  if (!("speechSynthesis" in window)) return false;
  try {
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "zh-CN";
    utterance.rate = slow ? 0.55 : 0.95;
    utterance.volume = state.settings?.muted ? 0 : clamp(state.settings?.volume ?? 0.9);
    const voice = speechSynthesis.getVoices().find((v) => /^zh(-|_)?CN/i.test(v.lang) || /Chinese/i.test(v.name));
    if (voice) utterance.voice = voice;
    utterance.onend = () => { state.playing = false; emit({ type: "end" }); };
    utterance.onerror = () => { state.playing = false; emit({ type: "end" }); };
    state.playing = true;
    emit({ type: "start", text, slow, auto, source: "browser" });
    speechSynthesis.speak(utterance);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Произносит текст. Возвращает источник звука: static | server | browser | none.
 * `auto: true` — вызов из автоозвучки; такой вызов молча пропускается, пока
 * пользователь не коснулся тренажёра, и когда звук выключен в настройках.
 */
export async function speak(text, { slow = false, auto = false } = {}) {
  const settings = loadAudioSettings();
  if (!text) return "none";
  if (settings.muted) return "none";
  if (auto && !settings.autoSpeak) return "none";
  if (auto && !state.unlocked) return "none";

  // Сначала глушим предыдущее, и только потом берём номер запроса:
  // stop() тоже сдвигает счётчик, иначе новый вызов отменял бы сам себя.
  stop();
  const token = ++state.token;
  const url = await resolveUrl(text, slow);
  if (token !== state.token) return "none";

  if (url) {
    const audio = element();
    const source = await cachedBlobUrl(url);
    if (token !== state.token) return "none";
    audio.src = source;
    audio.volume = settings.muted ? 0 : clamp(settings.volume);
    audio.playbackRate = 1;
    try {
      state.playing = true;
      emit({ type: "start", text, slow, auto, source: url.startsWith(CONFIG.audioBase) ? "static" : "server" });
      await audio.play();
      return url.startsWith(CONFIG.audioBase) ? "static" : "server";
    } catch (error) {
      state.playing = false;
      emit({ type: "end" });
      if (!auto) console.warn("Не удалось воспроизвести запись", error);
    }
  }
  return speakWithBrowser(text, slow, auto) ? "browser" : "none";
}

export function stop() {
  state.token += 1;
  if (state.element) {
    try { state.element.pause(); state.element.currentTime = 0; } catch (_) { /* нет источника */ }
  }
  if ("speechSynthesis" in window) {
    try { speechSynthesis.cancel(); } catch (_) { /* не поддержано */ }
  }
  if (state.playing) { state.playing = false; emit({ type: "end" }); }
}

export function isPlaying() { return state.playing; }
