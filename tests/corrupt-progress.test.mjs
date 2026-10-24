// BUG-08: повреждённая запись прогресса не должна молча перезаписываться.
// Тесты работают с подменённым localStorage в памяти процесса; настоящее
// браузерное хранилище не используется.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Хранилище с управляемыми сбоями: quota — после N байт, broken — любая запись бросает. */
function makeStorage({ quotaBytes = Infinity, broken = false } = {}) {
  const map = new Map();
  const size = () => [...map].reduce((s, [k, v]) => s + k.length + v.length, 0);
  return {
    map,
    broken,
    quotaBytes,
    get length() { return map.size; },
    key(i) { return [...map.keys()][i] ?? null; },
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) {
      if (this.broken) throw new DOMException("denied", "SecurityError");
      const next = size() - (map.has(k) ? k.length + map.get(k).length : 0) + k.length + String(v).length;
      if (next > this.quotaBytes) throw new DOMException("quota", "QuotaExceededError");
      map.set(k, String(v));
    },
    removeItem(k) { map.delete(k); },
    clear() { map.clear(); },
  };
}

const storage = await import(path.join(ROOT, "js/storage.js"));
const progressMod = await import(path.join(ROOT, "js/progress.js"));
const { KEYS } = storage;

function fresh(options) {
  globalThis.localStorage = makeStorage(options);
  storage.__resetStorageForTests?.();
  progressMod.__resetProgressHealthForTests?.();
  return globalThis.localStorage;
}

const CORRUPT = '{"version":2,"completed":{"hsk":{"1-2:一":5,"3:安":5'; // обрыв записи
const CORRUPT_2 = '{"version":2,"completed":{"hsk":{"1-2:二":5}},"attempts":7,,}';

function quarantined(ls) {
  return [...ls.map.entries()]
    .filter(([k]) => k.startsWith(progressMod.CORRUPT_PREFIX))
    .map(([, v]) => JSON.parse(v));
}

test("BUG-08: первая порча — исходная строка сохраняется до перезаписи", () => {
  const ls = fresh();
  ls.setItem(KEYS.progress, CORRUPT);
  const loaded = progressMod.loadProgress();
  assert.deepEqual(loaded.completed.hsk, {}, "повреждённую запись приложение не пытается угадать");
  assert.equal(progressMod.progressHealth().status, "quarantined");

  loaded.completed.hsk["1-2:新"] = 1;
  progressMod.saveProgress(loaded);

  const copies = quarantined(ls);
  assert.equal(copies.length, 1, "аварийная копия ровно одна");
  assert.equal(copies[0].raw, CORRUPT, "аварийная копия байт-в-байт совпадает с исходной строкой");
  assert.equal(copies[0].sourceKey, KEYS.progress);
  assert.equal(JSON.parse(ls.getItem(KEYS.progress)).completed.hsk["1-2:新"], 1, "после карантина новое сохранение проходит");
});

test("BUG-08: повторная загрузка той же порчи не плодит копии", () => {
  const ls = fresh();
  ls.setItem(KEYS.progress, CORRUPT);
  progressMod.loadProgress();
  progressMod.__resetProgressHealthForTests();
  progressMod.loadProgress(); // вторая вкладка / перезагрузка до сохранения
  assert.equal(quarantined(ls).length, 1);
});

test("BUG-08: повторное повреждение не затирает предыдущую аварийную копию", () => {
  const ls = fresh();
  ls.setItem(KEYS.progress, CORRUPT);
  progressMod.saveProgress(progressMod.loadProgress());
  // позже запись снова портится, уже с другим содержимым
  ls.setItem(KEYS.progress, CORRUPT_2);
  progressMod.__resetProgressHealthForTests();
  progressMod.saveProgress(progressMod.loadProgress());
  const raws = quarantined(ls).map((c) => c.raw).sort();
  assert.deepEqual(raws, [CORRUPT, CORRUPT_2].sort(), "обе аварийные копии на месте");
});

test("BUG-08: существующая исправная резервная копия не перезаписывается", () => {
  const ls = fresh();
  const good = { savedAt: "2026-10-20T10:00:00Z", progress: { completed: { hsk: { "3:安": 5 } }, attempts: 50 } };
  ls.setItem(KEYS.backup, JSON.stringify(good));
  ls.setItem(KEYS.progress, CORRUPT);
  const loaded = progressMod.loadProgress();
  progressMod.saveProgress(loaded);
  progressMod.saveProgress(loaded);
  assert.deepEqual(JSON.parse(ls.getItem(KEYS.backup)), good, "резервная копия байт-в-байт прежняя");
  assert.equal(progressMod.restoreBackup().completed.hsk["3:安"], 5, "из неё по-прежнему можно восстановиться");
  assert.equal(quarantined(ls)[0].raw, CORRUPT);
});

test("BUG-08: переполнение квоты — исходная строка не уничтожается", () => {
  const ls = fresh();
  ls.setItem(KEYS.progress, CORRUPT);
  ls.setItem("filler", "x".repeat(200));
  // места хватает на то, что уже лежит, но не на аварийную копию
  ls.quotaBytes = [...ls.map].reduce((s, [k, v]) => s + k.length + v.length, 0) + 20;

  const loaded = progressMod.loadProgress();
  assert.equal(progressMod.progressHealth().status, "unsaved", "приложение знает, что копию сохранить не удалось");
  assert.equal(progressMod.progressHealth().raw, CORRUPT, "исходная строка доступна для скачивания");
  loaded.completed.hsk["1-2:新"] = 1;
  progressMod.saveProgress(loaded);
  assert.equal(ls.getItem(KEYS.progress), CORRUPT, "повреждённая строка осталась на месте");
  assert.equal(progressMod.recoveryBundle().copies[0].raw, CORRUPT, "файл восстановления собирается из памяти");
});

test("BUG-08: хранилище запрещает запись — исходная строка остаётся", () => {
  const ls = fresh();
  ls.setItem(KEYS.progress, CORRUPT);
  ls.broken = true;
  const loaded = progressMod.loadProgress();
  assert.equal(progressMod.progressHealth().status, "unsaved");
  progressMod.saveProgress(loaded);
  assert.equal(ls.getItem(KEYS.progress), CORRUPT);
});

test("BUG-08: когда место освободилось, карантин повторяется и сохранение продолжается", () => {
  const ls = fresh();
  ls.setItem(KEYS.progress, CORRUPT);
  ls.broken = true;
  const loaded = progressMod.loadProgress();
  progressMod.saveProgress(loaded);
  assert.equal(ls.getItem(KEYS.progress), CORRUPT);
  ls.broken = false;
  loaded.completed.hsk["1-2:新"] = 2;
  progressMod.saveProgress(loaded);
  assert.equal(quarantined(ls)[0].raw, CORRUPT, "копия сделана до перезаписи");
  assert.equal(JSON.parse(ls.getItem(KEYS.progress)).completed.hsk["1-2:新"], 2);
  assert.equal(progressMod.progressHealth().status, "quarantined");
});

test("BUG-08: исправная запись и пустое хранилище карантин не создают", () => {
  let ls = fresh();
  progressMod.saveProgress(progressMod.loadProgress());
  assert.equal(quarantined(ls).length, 0);
  assert.equal(progressMod.progressHealth().status, "ok");

  ls = fresh();
  ls.setItem(KEYS.progress, JSON.stringify({ completed: { hsk: { "1-2:一": 5 } } }));
  assert.equal(progressMod.loadProgress().completed.hsk["1-2:一"], 5);
  assert.equal(quarantined(ls).length, 0);
});

test("BUG-08: JSON не того вида (число, массив, null) тоже считается повреждением", () => {
  for (const raw of ["42", "[1,2]", "null", '"text"']) {
    const ls = fresh();
    ls.setItem(KEYS.progress, raw);
    progressMod.saveProgress(progressMod.loadProgress());
    assert.equal(quarantined(ls)[0]?.raw, raw, `строка ${raw} сохранена`);
  }
});

test("BUG-08: файл восстановления содержит все аварийные копии без изменений", () => {
  const ls = fresh();
  ls.setItem(KEYS.progress, CORRUPT);
  progressMod.saveProgress(progressMod.loadProgress());
  ls.setItem(KEYS.progress, CORRUPT_2);
  progressMod.__resetProgressHealthForTests();
  progressMod.loadProgress();
  const file = progressMod.recoveryBundle();
  assert.equal(file.schema, "bishun-progress-recovery-v1");
  assert.deepEqual(file.copies.map((c) => c.raw).sort(), [CORRUPT, CORRUPT_2].sort());
});
