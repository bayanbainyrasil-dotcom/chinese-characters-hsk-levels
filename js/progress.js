// Состояние обучения: форма данных, слияние и миграция старого ключа.
// Правило номер один: старый прогресс не удаляется и не обнуляется никогда.

import { KEYS, readJson, writeJson, readRaw, writeRaw, uuid } from "./storage.js";

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

export function loadProgress() {
  ensureMigration();
  return normalize(readJson(KEYS.progress, null));
}

export function saveProgress(progress) {
  progress.updatedAt = Date.now();
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
