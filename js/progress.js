// Состояние обучения: форма данных, слияние и миграция старого ключа.
// Правило номер один: старый прогресс не удаляется и не обнуляется никогда.

import { KEYS, readJson, writeJson, readRaw, writeRaw, writeRawDurable, listKeys, uuid } from "./storage.js";

export const BUCKETS = ["strokes", "rules", "radicals", "hsk"];

export const DEFAULT_SETTINGS = {
  autoSpeak: true,      // произносить знак после правильного написания
  volume: 0.9,
  muted: false,
  slowRate: 0.6,
  theme: "dark",        // dark | light | system
  motion: "auto",       // auto | reduced
};

export function defaultProgress() {
  return {
    version: 2,
    completed: { strokes: {}, rules: {}, radicals: {}, hsk: {} },
    attempts: 0,
    cleanAttempts: 0,
    days: [],
    lastSession: null,
    lastLevel: null,
    lastChar: null,
    settings: { ...DEFAULT_SETTINGS },
    updatedAt: 0,
  };
}

export function todayKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Приводит любой сохранённый вид прогресса к текущей форме, ничего не теряя. */
export function normalize(raw) {
  const base = defaultProgress();
  if (!raw || typeof raw !== "object") return base;
  const out = { ...base, ...raw };
  out.version = 2;
  out.completed = { ...base.completed, ...(raw.completed || {}) };
  for (const bucket of BUCKETS) {
    const source = out.completed[bucket];
    const clean = {};
    if (source && typeof source === "object") {
      for (const [key, value] of Object.entries(source)) {
        const count = Number(value);
        if (Number.isFinite(count) && count > 0) clean[key] = count;
      }
    }
    out.completed[bucket] = clean;
  }
  out.attempts = Math.max(0, Number(raw.attempts) || 0);
  out.cleanAttempts = Math.max(0, Number(raw.cleanAttempts) || 0);
  out.days = [...new Set((Array.isArray(raw.days) ? raw.days : []).filter((d) => typeof d === "string"))].sort();
  out.settings = { ...DEFAULT_SETTINGS, ...(raw.settings || {}) };
  out.updatedAt = Number(raw.updatedAt) || 0;
  return out;
}

/**
 * Слияние двух состояний. По каждому знаку берётся наибольшее число повторений,
 * дни занятий объединяются без дубликатов, последняя сессия — из более свежего.
 */
export function merge(a, b) {
  const left = normalize(a);
  const right = normalize(b);
  const out = defaultProgress();
  for (const bucket of BUCKETS) {
    const keys = new Set([...Object.keys(left.completed[bucket]), ...Object.keys(right.completed[bucket])]);
    for (const key of keys) {
      out.completed[bucket][key] = Math.max(
        Number(left.completed[bucket][key]) || 0,
        Number(right.completed[bucket][key]) || 0,
      );
    }
  }
  out.attempts = Math.max(left.attempts, right.attempts);
  out.cleanAttempts = Math.max(left.cleanAttempts, right.cleanAttempts);
  out.days = [...new Set([...left.days, ...right.days])].sort();
  const newer = right.updatedAt >= left.updatedAt ? right : left;
  const older = newer === right ? left : right;
  out.lastSession = newer.lastSession || older.lastSession;
  out.lastLevel = newer.lastLevel ?? older.lastLevel;
  out.lastChar = newer.lastChar ?? older.lastChar;
  out.settings = { ...older.settings, ...newer.settings };
  out.updatedAt = Math.max(left.updatedAt, right.updatedAt);
  return out;
}

/**
 * Первый запуск новой версии: снимаем резервную копию старого прогресса и
 * записываем отметку о миграции, чтобы импорт не повторялся. Боевой ключ
 * остаётся тем же самым, поэтому терять нечего физически.
 */
export function ensureMigration() {
  const legacy = readJson(KEYS.progress, null);
  let mark = readJson(KEYS.migration, null);
  if (!mark) {
    mark = {
      id: uuid(),
      at: new Date().toISOString(),
      backedUp: false,
      hadLegacy: Boolean(legacy),
      legacyKey: KEYS.progress,
      syncedToServer: false,
    };
    if (legacy && !readRaw(KEYS.backup)) {
      mark.backedUp = writeJson(KEYS.backup, { savedAt: mark.at, progress: legacy });
    }
    writeJson(KEYS.migration, mark);
  }
  return mark;
}

export function markServerSynced() {
  const mark = readJson(KEYS.migration, null);
  if (mark && !mark.syncedToServer) {
    mark.syncedToServer = true;
    mark.syncedAt = new Date().toISOString();
    writeJson(KEYS.migration, mark);
  }
}

export function migrationInfo() {
  return readJson(KEYS.migration, null);
}

// --- Повреждённая запись прогресса ------------------------------------------
// Если в боевом ключе лежит строка, которую нельзя разобрать, приложение не
// пытается её «починить», но и не имеет права затереть её следующим сохранением.
// Сначала исходная строка копируется в отдельный аварийный ключ (каждая новая
// порча — в свой ключ, прежние копии не трогаются). Если копию записать не
// удалось (квота, запрет записи), боевой ключ блокируется от перезаписи до тех
// пор, пока копия не ляжет, а строка остаётся доступной для скачивания.

export const CORRUPT_PREFIX = "bishun_hsk30_progress_corrupt_v1:";

let health = { status: "ok" };

function isUsableProgressRaw(raw) {
  if (raw === null || raw === undefined || raw === "") return true; // пусто — терять нечего
  try {
    const parsed = JSON.parse(raw);
    return Boolean(parsed) && typeof parsed === "object" && !Array.isArray(parsed);
  } catch (_) {
    return false;
  }
}

function quarantineCopies() {
  const copies = [];
  for (const key of listKeys(CORRUPT_PREFIX)) {
    try {
      const entry = JSON.parse(readRaw(key));
      if (entry && typeof entry.raw === "string") copies.push({ key, ...entry });
    } catch (_) { /* чужой мусор в ключе с нашим префиксом не трогаем */ }
  }
  return copies;
}

function quarantine(raw) {
  const existing = quarantineCopies().find((copy) => copy.raw === raw);
  if (existing) return existing.key;
  let key = `${CORRUPT_PREFIX}${Date.now()}`;
  for (let n = 1; readRaw(key) !== null; n += 1) key = `${CORRUPT_PREFIX}${Date.now()}-${n}`;
  const entry = JSON.stringify({ savedAt: new Date().toISOString(), sourceKey: KEYS.progress, raw });
  return writeRawDurable(key, entry) ? key : null;
}

/** Проверяет боевой ключ и при порче делает аварийную копию. Повторный вызов безопасен. */
function guardProgressKey() {
  const raw = readRaw(KEYS.progress);
  if (isUsableProgressRaw(raw)) {
    if (health.status === "unsaved") health = { status: "ok" };
    return true;
  }
  const key = quarantine(raw);
  health = key
    ? { status: "quarantined", key, raw, detectedAt: health.detectedAt || new Date().toISOString() }
    : { status: "unsaved", raw, detectedAt: health.detectedAt || new Date().toISOString() };
  return Boolean(key);
}

/**
 * Состояние записи прогресса для интерфейса:
 * ok — всё в порядке; quarantined — запись была повреждена, исходная строка
 * сохранена в аварийной копии; unsaved — копию сохранить не удалось, боевой
 * ключ не перезаписывается, данные этой сессии живут только в памяти.
 */
export function progressHealth() {
  const copies = quarantineCopies().length;
  if (health.status === "ok" && copies) return { status: "has-copies", copies };
  return { ...health, copies };
}

/** Файл для ручного восстановления: все аварийные копии как есть, без попытки разбора. */
export function recoveryBundle() {
  const copies = quarantineCopies().map(({ savedAt, sourceKey, raw }) => ({ savedAt, sourceKey, raw }));
  if (health.status === "unsaved" && !copies.some((c) => c.raw === health.raw)) {
    copies.push({ savedAt: health.detectedAt, sourceKey: KEYS.progress, raw: health.raw, notSavedInStorage: true });
  }
  return { schema: "bishun-progress-recovery-v1", createdAt: new Date().toISOString(), copies };
}

/** Только для автотестов. */
export function __resetProgressHealthForTests() {
  health = { status: "ok" };
}

export function loadProgress() {
  guardProgressKey();
  ensureMigration();
  if (health.status === "unsaved" || health.status === "quarantined") return defaultProgress();
  return normalize(readJson(KEYS.progress, null));
}

export function saveProgress(progress) {
  progress.updatedAt = Date.now();
  // Перед каждой записью: если в ключе всё ещё лежит неразобранная строка,
  // а копию сделать не удалось — не пишем, чтобы не уничтожить её.
  if (!guardProgressKey()) return progress;
  writeJson(KEYS.progress, progress);
  return progress;
}

export function restoreBackup() {
  const backup = readJson(KEYS.backup, null);
  return backup?.progress ? normalize(backup.progress) : null;
}

/** Считает изученные знаки: HSK-знак засчитывается после пяти написаний. */
export function masteredHsk(progress, goal = 5) {
  const official = /^(1-2|3|4|5|6|7-9):/;
  return Object.entries(progress.completed.hsk || {})
    .reduce((total, [key, value]) => total + (official.test(key) && Number(value) >= goal ? 1 : 0), 0);
}

export function completedCount(progress, bucket, goal = 1) {
  return Object.values(progress.completed[bucket] || {})
    .reduce((total, value) => total + (Number(value) >= goal ? 1 : 0), 0);
}
