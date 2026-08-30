// Безопасная обёртка над localStorage: в приватном режиме Safari запись бросает
// исключение, а терять прогресс из-за этого нельзя.

export const KEYS = {
  progress: "bishun_hsk30_progress_v1",        // боевой ключ, не переименовывается
  adminEdits: "bishun_hsk30_admin_edits_v1",   // правки словаря, не переименовываются
  adminPin: "bishun_hsk30_admin_pin_v1",       // наследие: чистится после миграции
  backup: "bishun_hsk30_progress_backup_v1",
  migration: "bishun_hsk30_migration_v2",
  queue: "bishun_hsk30_sync_queue_v1",
  device: "bishun_hsk30_device_v1",
  audioSettings: "bishun_hsk30_audio_v1",
};

let memoryFallback = new Map();
let warned = false;

export function readRaw(key) {
  try {
    const value = localStorage.getItem(key);
    return value === null && memoryFallback.has(key) ? memoryFallback.get(key) : value;
  } catch (_) {
    return memoryFallback.get(key) ?? null;
  }
}

export function writeRaw(key, value) {
  memoryFallback.set(key, value);
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (error) {
    if (!warned) {
      warned = true;
      console.warn("Локальное хранилище недоступно, прогресс держим в памяти сессии", error);
    }
    return false;
  }
}

export function removeRaw(key) {
  memoryFallback.delete(key);
  try { localStorage.removeItem(key); } catch (_) { /* приватный режим */ }
}

export function readJson(key, fallback) {
  try {
    const parsed = JSON.parse(readRaw(key));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}

export function writeJson(key, value) {
  return writeRaw(key, JSON.stringify(value));
}

export function uuid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  (globalThis.crypto || { getRandomValues: (a) => a.forEach((_, i) => (a[i] = Math.floor(Math.random() * 256))) })
    .getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function deviceId() {
  let id = readRaw(KEYS.device);
  if (!id) {
    id = uuid();
    writeRaw(KEYS.device, id);
  }
  return id;
}
