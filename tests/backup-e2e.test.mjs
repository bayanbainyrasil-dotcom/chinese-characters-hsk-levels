// Сквозные проверки переноса прогресса: скачивание копии через интерфейс,
// импорт именно скачанного файла в чистый профиль, повторный импорт,
// перезагрузка, отказ на повреждённых файлах без частичных изменений.
// Каждый профиль — отдельный BrowserContext со своим хранилищем; данные синтетические.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer, launch, serveStrokeData, stubBackend, collectErrors, drawCharacter } from "./helpers.mjs";

let server, base, browser, tmp;
before(async () => {
  ({ server, url: base } = await startServer());
  browser = await launch();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hsk-backup-"));
});
after(async () => {
  await browser?.close();
  server?.close();
});

const P = "bishun_hsk30_progress_v1";
const E = "bishun_hsk30_admin_edits_v1";

const SOURCE_PROGRESS = {
  version: 2,
  completed: {
    strokes: { heng: 3, shu: 1 },
    rules: { "rule-三": 1 },
    radicals: { "rad-1": 2 },
    hsk: { "1-2:一": 5, "3:安": 5, "3:把": 2 },
  },
  attempts: 41,
  cleanAttempts: 33,
  days: ["2026-10-01", "2026-10-02", "2026-10-20"],
  lastSession: { kind: "hsk", level: "3" },
  lastLevel: "3",
  lastChar: "把",
  settings: { autoSpeak: false, volume: 0.5, muted: false, slowRate: 0.6, theme: "light", motion: "auto" },
  updatedAt: 1792000000000,
};
const SOURCE_EDITS = [
  { id: "base:12", baseNumber: 12, level: "1", word: "爱", pinyin: "ài", partOfSpeech: "гл.", russian: "любить (правка)", updatedAt: "2026-10-10T10:00:00.000Z" },
  { id: "custom:1", level: "3", word: "汉字", pinyin: "hànzì", partOfSpeech: "сущ.", russian: "иероглиф", updatedAt: "2026-10-11T10:00:00.000Z" },
];

async function profile({ seed = null, viewport = { width: 1100, height: 900 } } = {}) {
  const context = await browser.newContext({ viewport, acceptDownloads: true });
  await serveStrokeData(context);
  await stubBackend(context);
  const page = await context.newPage();
  const errors = collectErrors(page);
  await page.goto(base);
  await page.waitForFunction(() => window.__hsk);
  if (seed) {
    await page.evaluate((s) => { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); }, seed);
    await page.reload();
    await page.waitForFunction(() => window.__hsk);
  }
  return { context, page, errors };
}

async function snapshot(page) {
  return page.evaluate(() => {
    const out = {};
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k.startsWith("bishun_hsk30_") && !k.endsWith("_device_v1")) out[k] = localStorage.getItem(k);
    }
    return out;
  });
}

async function openProgress(page) {
  await page.evaluate(() => window.__hsk.showView("progressView"));
  await page.locator("#exportProgressButton").waitFor({ state: "visible" });
}

async function downloadVia(page, selector, name) {
  const [download] = await Promise.all([page.waitForEvent("download"), page.locator(selector).click()]);
  const file = path.join(tmp, name);
  await download.saveAs(file);
  return file;
}

async function importProgress(page, file) {
  await page.locator("#importProgressInput").setInputFiles(file);
  await page.locator("#toast:not(.hidden)").waitFor();
  const text = await page.locator("#toast").textContent();
  await page.evaluate(() => document.getElementById("toast").classList.add("hidden"));
  return text;
}

function stripVolatile(progress) {
  const { updatedAt, ...rest } = progress;
  return rest;
}

test("bishun-backup-v1: скачанная копия переносится в чистый профиль без потерь и дубликатов", async () => {
  const src = await profile({ seed: { [P]: JSON.stringify(SOURCE_PROGRESS), [E]: JSON.stringify(SOURCE_EDITS) } });
  await openProgress(src.page);
  const file = await downloadVia(src.page, "#exportProgressButton", "progress-backup.json");
  const exported = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(exported.schema, "bishun-backup-v1");
  const sourceProgress = await src.page.evaluate(() => window.__hsk.progress);
  assert.deepEqual(stripVolatile(exported.progress), stripVolatile(sourceProgress), "в файле ровно то, что в приложении");

  const dst = await profile();
  await openProgress(dst.page);
  assert.match(await importProgress(dst.page, file), /импортирована/);
  assert.equal(await dst.page.locator("#importProgressInput").inputValue(), "", "поле сброшено — тот же файл можно выбрать снова");

  const check = async (label) => {
    const restored = await dst.page.evaluate(() => window.__hsk.progress);
    assert.deepEqual(restored.completed, sourceProgress.completed, `${label}: completed совпадает`);
    assert.equal(restored.attempts, sourceProgress.attempts, `${label}: attempts`);
    assert.equal(restored.cleanAttempts, sourceProgress.cleanAttempts, `${label}: cleanAttempts`);
    assert.deepEqual(restored.days, sourceProgress.days, `${label}: дни без дубликатов`);
    assert.deepEqual(restored.settings, sourceProgress.settings, `${label}: настройки`);
    const edits = await dst.page.evaluate((k) => JSON.parse(localStorage.getItem(k)), E);
    assert.deepEqual(edits.map((e) => e.id).sort(), SOURCE_EDITS.map((e) => e.id).sort(), `${label}: правки без дубликатов`);
    const stored = await dst.page.evaluate((k) => JSON.parse(localStorage.getItem(k)), P);
    assert.deepEqual(stored.completed, sourceProgress.completed, `${label}: записано в хранилище`);
  };
  await check("первый импорт");
  assert.match(await importProgress(dst.page, file), /импортирована/);
  await check("повторный импорт");
  await dst.page.reload();
  await dst.page.waitForFunction(() => window.__hsk);
  await check("после перезагрузки");

  assert.deepEqual(src.errors, []);
  assert.deepEqual(dst.errors, []);
  await src.context.close();
  await dst.context.close();
});

test("bishun-backup-v1: импорт объединяет, а не заменяет местный прогресс и местные правки словаря", async () => {
  const src = await profile({ seed: { [P]: JSON.stringify(SOURCE_PROGRESS), [E]: JSON.stringify(SOURCE_EDITS) } });
  await openProgress(src.page);
  const file = await downloadVia(src.page, "#exportProgressButton", "progress-merge.json");
  await src.context.close();

  const localEdit = { id: "custom:local", level: "2", word: "你好", pinyin: "nǐ hǎo", partOfSpeech: "фраза", russian: "привет", updatedAt: "2026-10-24T10:00:00.000Z" };
  const localProgress = { version: 2, completed: { hsk: { "1-2:二": 5, "3:把": 4 } }, attempts: 7, cleanAttempts: 5, days: ["2026-10-24"] };
  const dst = await profile({ seed: { [P]: JSON.stringify(localProgress), [E]: JSON.stringify([localEdit]) } });
  await openProgress(dst.page);
  await importProgress(dst.page, file);
  const restored = await dst.page.evaluate(() => window.__hsk.progress);
  assert.equal(restored.completed.hsk["1-2:二"], 5, "местный знак остался");
  assert.equal(restored.completed.hsk["3:把"], 4, "берётся наибольшее число повторений");
  assert.equal(restored.completed.hsk["3:安"], 5, "знак из копии добавлен");
  assert.deepEqual(restored.days, ["2026-10-01", "2026-10-02", "2026-10-20", "2026-10-24"]);
  const edits = await dst.page.evaluate((k) => JSON.parse(localStorage.getItem(k)), E);
  assert.deepEqual(edits.map((e) => e.id).sort(), ["base:12", "custom:1", "custom:local"], "местная правка словаря не потеряна");
  await dst.context.close();
});

test("bishun-backup-v1: повреждённый, чужой или смешанный файл ничего не меняет", async () => {
  const dst = await profile({ seed: { [P]: JSON.stringify(SOURCE_PROGRESS), [E]: JSON.stringify(SOURCE_EDITS) } });
  await openProgress(dst.page);
  const before = await snapshot(dst.page);
  const cases = {
    "broken.json": '{"schema":"bishun-backup-v1","edits":[',
    "foreign.json": JSON.stringify({ schema: "something-else", edits: [], progress: { completed: { hsk: { "9:龍": 5 } } } }),
    "memory-in-progress-slot.json": JSON.stringify({ schema: "bishun-memory-backup-v1", schedulerVersion: 1, events: [], notes: {} }),
    "mixed-edits.json": JSON.stringify({ schema: "bishun-backup-v1", edits: [{ id: "custom:new", word: "新", updatedAt: "2026-10-25T00:00:00Z" }, "мусор", { word: "без id" }], progress: { completed: { hsk: { "3:新": 5 } } } }),
    "mixed-progress.json": JSON.stringify({ schema: "bishun-backup-v1", edits: [{ id: "custom:ok", word: "好", updatedAt: "2026-10-25T00:00:00Z" }], progress: { completed: { hsk: { "3:新": 5, "3:坏": "много" }, strokes: "не объект" } } }),
  };
  for (const [name, body] of Object.entries(cases)) {
    const file = path.join(tmp, name);
    fs.writeFileSync(file, body);
    const toast = await importProgress(dst.page, file);
    assert.doesNotMatch(toast, /импортирована/, `${name}: импорт отклонён`);
    assert.deepEqual(await snapshot(dst.page), before, `${name}: хранилище не изменилось`);
  }
  await dst.page.reload();
  await dst.page.waitForFunction(() => window.__hsk);
  assert.deepEqual(await snapshot(dst.page), before, "и после перезагрузки тоже");
  await dst.context.close();
});

// --- bishun-memory-backup-v1 ------------------------------------------------

async function openMemory(page) {
  await page.locator("#memoryOpen").click();
  await page.locator("#memoryStart").waitFor();
}

async function memoryState(page) {
  return page.evaluate(async () => {
    const store = window.__hsk.memory.store;
    const events = (await store.events()).sort((a, b) => a.id.localeCompare(b.id));
    return { events, notes: await store.notes() };
  });
}

async function importMemory(page, file) {
  await page.locator("#memoryImport").setInputFiles(file);
  await page.waitForFunction(() => document.getElementById("memoryImport").value === "");
  await page.waitForFunction(() => !document.getElementById("memoryStart").disabled);
  return page.locator("#memoryMessage").textContent();
}

test("bishun-memory-backup-v1: история попыток и личные заметки переносятся скачанным файлом", async () => {
  const src = await profile({ seed: { [P]: JSON.stringify({ completed: { hsk: { "1-2:十": 5 } } }) }, viewport: { width: 420, height: 860 } });
  src.page.on("dialog", (d) => d.accept());
  // известный непустой прогресс памяти: одно настоящее написание через интерфейс + личная заметка
  await openMemory(src.page);
  await src.page.locator("#memoryStart").click();
  await src.page.locator("#memoryHelp:not([disabled])").waitFor();
  const char = await src.page.evaluate(() => window.__hsk.memory.pending.char);
  await drawCharacter(src.page, char, "#memoryTarget");
  await src.page.locator("#memoryGrade:not(.hidden)").waitFor();
  if (await src.page.locator("#memoryGood").isEnabled()) await src.page.locator("#memoryGood").click();
  else await src.page.locator("#memoryAgain").click();
  await src.page.locator("#memoryNext").waitFor();
  await src.page.evaluate(async (c) => {
    await window.__hsk.memory.store.saveNote(c, "Моя заметка: крест на перекрёстке");
    await window.__hsk.memory.store.saveNote("安", "Женщина под крышей — спокойно");
  }, char);
  await src.page.locator("#memoryView [data-back-home]").click();
  await openMemory(src.page);
  const source = await memoryState(src.page);
  assert.ok(source.events.length >= 2, "в источнике есть события");
  assert.equal(Object.keys(source.notes).length, 2);
  const file = await downloadVia(src.page, "#memoryExport", "memory-backup.json");
  const exported = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(exported.schema, "bishun-memory-backup-v1");
  assert.deepEqual(exported.notes, source.notes, "заметки попали в файл");

  const dst = await profile({ viewport: { width: 420, height: 860 } });
  dst.page.on("dialog", (d) => d.accept());
  await openMemory(dst.page);
  assert.match(await importMemory(dst.page, file), /объединена/);
  let restored = await memoryState(dst.page);
  assert.deepEqual(restored, source, "события и заметки совпадают с источником");
  await importMemory(dst.page, file);
  restored = await memoryState(dst.page);
  assert.equal(restored.events.length, source.events.length, "повторный импорт не создаёт дубликатов");
  await dst.page.reload();
  await dst.page.waitForFunction(() => window.__hsk);
  await openMemory(dst.page);
  assert.deepEqual(await memoryState(dst.page), source, "после перезагрузки");
  assert.deepEqual(dst.errors, []);
  await src.context.close();
  await dst.context.close();
});

test("bishun-memory-backup-v1: повреждённый и смешанный файл отклоняются целиком", async () => {
  const dst = await profile({ viewport: { width: 420, height: 860 } });
  dst.page.on("dialog", (d) => d.accept());
  await openMemory(dst.page);
  await dst.page.evaluate(() => window.__hsk.memory.store.saveNote("安", "старая заметка"));
  const before = await memoryState(dst.page);
  const good = {
    id: "11111111-1111-4111-8111-111111111111", attemptId: "11111111-1111-4111-8111-111111111111",
    char: "一", kind: "introduce", mode: "learn", dueKey: "k", grade: null, assisted: false, mistakes: 0,
    at: Date.UTC(2026, 9, 1, 10), day: "2026-10-01", device: "test", durationMs: 1000, version: 1,
  };
  const cases = {
    "m-broken.json": '{"schema":"bishun-memory-backup-v1","events":[',
    "m-progress-slot.json": JSON.stringify({ schema: "bishun-backup-v1", edits: [] }),
    "m-mixed.json": JSON.stringify({ schema: "bishun-memory-backup-v1", schedulerVersion: 1, events: [good, { ...good, id: "bad", char: 5 }], notes: { "一": "новая" } }),
    "m-bad-notes.json": JSON.stringify({ schema: "bishun-memory-backup-v1", schedulerVersion: 1, events: [good], notes: { "一": "x".repeat(5000) } }),
  };
  for (const [name, body] of Object.entries(cases)) {
    const file = path.join(tmp, name);
    fs.writeFileSync(file, body);
    await importMemory(dst.page, file);
    assert.deepEqual(await memoryState(dst.page), before, `${name}: ничего не изменилось`);
  }
  await dst.context.close();
});

test("bishun-memory-backup-v1: файл, выбранный пока раздел ещё загружается, не теряется", async () => {
  const context = await browser.newContext({ viewport: { width: 420, height: 860 } });
  await serveStrokeData(context);
  await stubBackend(context);
  // медленная сеть: данные раздела памяти приходят через 1,5 с
  await context.route("**/data/stroke-counts.json", async (route) => { await new Promise((r) => setTimeout(r, 1500)); await route.continue(); });
  const page = await context.newPage();
  page.on("dialog", (d) => d.accept());
  await page.goto(base);
  await page.waitForFunction(() => window.__hsk);
  const event = {
    id: "22222222-2222-4222-8222-222222222222", attemptId: "22222222-2222-4222-8222-222222222222",
    char: "一", kind: "introduce", mode: "learn", dueKey: "k", grade: null, assisted: false, mistakes: 0,
    at: Date.UTC(2026, 9, 1, 10), day: "2026-10-01", device: "test", durationMs: 1000, version: 1,
  };
  const file = path.join(tmp, "m-early.json");
  fs.writeFileSync(file, JSON.stringify({ schema: "bishun-memory-backup-v1", schedulerVersion: 1, events: [event], notes: { "一": "ранняя заметка" } }));
  await page.locator("#memoryOpen").click();
  await page.locator("#memoryImport").setInputFiles(file); // раздел ещё грузится
  await page.waitForFunction(() => document.getElementById("memoryImport").value === "", null, { timeout: 15000 });
  const state = await memoryState(page);
  assert.deepEqual(state.events.map((e) => e.id), [event.id], "импорт выполнен после загрузки раздела");
  assert.equal(state.notes["一"], "ранняя заметка");
  await context.close();
});

test("bishun-memory-backup-v1: два файла, выбранные подряд во время загрузки, импортируются оба", async () => {
  const context = await browser.newContext({ viewport: { width: 420, height: 860 } });
  await serveStrokeData(context);
  await stubBackend(context);
  await context.route("**/data/stroke-counts.json", async (route) => { await new Promise((r) => setTimeout(r, 1500)); await route.continue(); });
  const page = await context.newPage();
  page.on("dialog", (d) => d.accept());
  await page.goto(base);
  await page.waitForFunction(() => window.__hsk);
  const mk = (n, char) => ({
    id: `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`, attemptId: `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`,
    char, kind: "introduce", mode: "learn", dueKey: "k", grade: null, assisted: false, mistakes: 0,
    at: Date.UTC(2026, 9, 1, 10, n), day: "2026-10-01", device: "test", durationMs: 1000, version: 1,
  });
  const a = path.join(tmp, "m-a.json"), b = path.join(tmp, "m-b.json");
  fs.writeFileSync(a, JSON.stringify({ schema: "bishun-memory-backup-v1", schedulerVersion: 1, events: [mk(1, "一")], notes: {} }));
  fs.writeFileSync(b, JSON.stringify({ schema: "bishun-memory-backup-v1", schedulerVersion: 1, events: [mk(2, "二")], notes: {} }));
  await page.locator("#memoryOpen").click();
  await page.locator("#memoryImport").setInputFiles(a);
  await page.locator("#memoryImport").setInputFiles(b);
  await page.waitForFunction(async () => (await window.__hsk.memory.store.events()).length === 2, null, { timeout: 15000 });
  await page.waitForFunction(() => !document.getElementById("memoryStart").disabled);
  assert.deepEqual((await memoryState(page)).events.map((e) => e.char).sort(), ["一", "二"]);
  await context.close();
});

// --- BUG-08 в настоящем браузере ---------------------------------------------

test("BUG-08 в браузере: повреждённая запись сохраняется, пользователь видит сообщение и может скачать её", async () => {
  const CORRUPT = '{"version":2,"completed":{"hsk":{"3:安":5,"3:把":';
  const page0 = await profile();
  await page0.page.evaluate(([k, v]) => localStorage.setItem(k, v), [P, CORRUPT]);
  await page0.page.reload();
  await page0.page.waitForFunction(() => window.__hsk);
  const { page, context, errors } = page0;
  await page.locator("#progressAlert:not(.hidden)").waitFor();
  assert.match(await page.locator("#progressAlert").textContent(), /не удалось прочитать/);
  assert.doesNotMatch(await page.locator("#progressAlert").textContent(), /восстановлен[оа]? автоматически/);

  // занятие продолжается и сохраняется
  await page.evaluate(() => window.__hsk.startSingleCharacter("一"));
  await page.evaluate(() => window.__hsk.completeCurrentItem(0));
  const stored = await snapshot(page);
  const copies = Object.entries(stored).filter(([k]) => k.startsWith("bishun_hsk30_progress_corrupt_v1:"));
  assert.equal(copies.length, 1);
  assert.equal(JSON.parse(copies[0][1]).raw, CORRUPT, "исходная строка сохранена байт-в-байт");
  assert.ok(JSON.parse(stored[P]).attempts >= 1, "новое занятие записано");

  const file = await downloadVia(page, "#progressRecoveryDownload", "recovery.json");
  const bundle = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(bundle.schema, "bishun-progress-recovery-v1");
  assert.equal(bundle.copies[0].raw, CORRUPT);

  // после перезагрузки сообщение о текущей аварии уходит, но копия доступна в «Прогрессе»
  await page.reload();
  await page.waitForFunction(() => window.__hsk);
  assert.equal(await page.locator("#progressAlert").isHidden(), true);
  await openProgress(page);
  assert.equal(await page.locator("#progressRecoveryBlock").isVisible(), true);
  assert.deepEqual(errors, []);
  await context.close();
});
