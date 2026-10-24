// Совместимость данных с настоящими старыми версиями приложения.
// Старые версии берутся из истории git (git archive) и запускаются целиком в
// браузере на том же адресе, что и новая — так у них общее хранилище, как у
// пользователя после обновления сайта. Профиль изолированный, Service Worker
// здесь отключён: обновление через него проверяет pwa-update-e2e.test.mjs.
// Для CI нужен полный клон (actions/checkout с fetch-depth: 0).
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch, serveStrokeData, stubBackend, collectErrors, drawCharacter } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 292aa70 — версия, работавшая на сайте в сентябре–октябре 2026;
// 116ac89 — main на момент аудита (последняя опубликованная).
const OLD_VERSIONS = ["292aa70", "116ac89"];
const P = "bishun_hsk30_progress_v1";

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".mp3": "audio/mpeg", ".webmanifest": "application/manifest+json",
};

let server, base, browser, tmp;
const roots = {};
let currentRoot = ROOT;

function extract(sha) {
  const dir = path.join(tmp, sha);
  fs.mkdirSync(dir, { recursive: true });
  let archive;
  try {
    archive = execFileSync("git", ["-C", ROOT, "archive", "--format=tar", sha], { maxBuffer: 512 * 1024 * 1024 });
  } catch (error) {
    throw new Error(`Нет коммита ${sha} в истории: нужен полный клон (fetch-depth: 0). ${error.message}`);
  }
  execFileSync("tar", ["-x", "-C", dir], { input: archive });
  return dir;
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hsk-old-"));
  for (const sha of OLD_VERSIONS) roots[sha] = extract(sha);
  server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    let file = path.join(currentRoot, decodeURIComponent(url.pathname));
    if (url.pathname.endsWith("/")) file = path.join(file, "index.html");
    if (!file.startsWith(currentRoot) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await launch();
});
after(async () => { await browser?.close(); server?.close(); });

async function load(page, root) {
  currentRoot = root;
  await page.goto(base);
  await page.waitForFunction(() => window.__hsk);
}

async function writeChar(page, char) {
  await page.evaluate((c) => window.__hsk.startSingleCharacter(c), char);
  await page.locator("#hanziTarget svg").waitFor();
  await page.waitForTimeout(250);
  await drawCharacter(page, char, "#hanziTarget");
  await page.waitForFunction(() => document.querySelector("#feedback")?.classList.contains("success"), null, { timeout: 8000 });
  await page.waitForTimeout(200);
}

async function stored(page) {
  return page.evaluate(() => {
    const out = {};
    for (let i = 0; i < localStorage.length; i += 1) { const k = localStorage.key(i); out[k] = localStorage.getItem(k); }
    return out;
  });
}

for (const sha of OLD_VERSIONS) {
  test(`старая версия ${sha} → новая → откат на ${sha}: прогресс сохраняется в обе стороны`, async () => {
    const context = await browser.newContext({ viewport: { width: 1000, height: 900 }, serviceWorkers: "block" });
    await serveStrokeData(context);
    await stubBackend(context);
    const page = await context.newPage();
    const errors = collectErrors(page);

    // 1. Пользователь занимается в старой версии: настоящее письмо указателем.
    await load(page, roots[sha]);
    await writeChar(page, "一");
    await writeChar(page, "人");
    await writeChar(page, "一");
    await page.evaluate(() => {
      // смена настройки через старое приложение
      document.querySelector('[data-theme-option="light"]')?.click();
    });
    const oldState = JSON.parse((await stored(page))[P]);
    assert.ok(oldState.attempts >= 3, `${sha}: старая версия записала попытки`);
    const oldHsk = oldState.completed.hsk;
    assert.ok(Object.keys(oldHsk).length >= 2, `${sha}: старая версия записала знаки: ${JSON.stringify(oldHsk)}`);

    // 2. Сайт обновился до новой версии.
    await load(page, ROOT);
    const fresh = await page.evaluate(() => window.__hsk.progress);
    assert.deepEqual(fresh.completed.hsk, oldHsk, "знаки на месте");
    assert.equal(fresh.attempts, oldState.attempts);
    assert.equal(fresh.cleanAttempts, oldState.cleanAttempts);
    assert.deepEqual(fresh.days, oldState.days);
    assert.equal(fresh.settings.theme, oldState.settings.theme, "настройки на месте");
    assert.equal(await page.locator("#progressAlert").isHidden(), true, "исправная запись не считается повреждённой");
    const afterUpgrade = await stored(page);
    assert.equal(Object.keys(afterUpgrade).some((k) => k.startsWith("bishun_hsk30_progress_corrupt_v1:")), false);
    assert.equal(JSON.parse(afterUpgrade[P]).attempts, oldState.attempts, "обновление само по себе ничего не переписало");

    // 3. Занятие в новой версии.
    await writeChar(page, "大");
    const newState = JSON.parse((await stored(page))[P]);
    assert.equal(newState.attempts, oldState.attempts + 1);

    // 4. Откат на старую версию (например, из кэша на другом устройстве) — она читает новые данные.
    await load(page, roots[sha]);
    const rolledBack = await page.evaluate(() => window.__hsk.progress);
    assert.deepEqual(rolledBack.completed.hsk, newState.completed.hsk, "старая версия видит знак, написанный в новой");
    assert.equal(rolledBack.attempts, newState.attempts);
    await writeChar(page, "人");
    const oldAgain = JSON.parse((await stored(page))[P]);

    // 5. Снова новая версия — ничего не потеряно.
    await load(page, ROOT);
    const final = await page.evaluate(() => window.__hsk.progress);
    assert.deepEqual(final.completed.hsk, oldAgain.completed.hsk);
    assert.equal(final.attempts, newState.attempts + 1);
    assert.deepEqual(errors, [], `${sha}: ошибки в консоли: ${errors.join(" | ")}`);
    await context.close();
  });
}

test("116ac89 → новая: история письма по памяти и личные заметки в IndexedDB сохраняются", async () => {
  const context = await browser.newContext({ viewport: { width: 420, height: 860 }, serviceWorkers: "block" });
  await serveStrokeData(context);
  await stubBackend(context);
  const page = await context.newPage();
  const errors = collectErrors(page);
  await load(page, roots["116ac89"]);
  await page.evaluate((k) => localStorage.setItem(k, JSON.stringify({ completed: { hsk: { "1-2:十": 5 } } })), P);
  await load(page, roots["116ac89"]);
  await page.locator("#memoryOpen").click();
  await page.locator("#memoryStart").click();
  await page.locator("#memoryHelp:not([disabled])").waitFor();
  const char = await page.evaluate(() => window.__hsk.memory.pending.char);
  await drawCharacter(page, char, "#memoryTarget");
  await page.locator("#memoryGrade:not(.hidden)").waitFor();
  await page.locator(await page.locator("#memoryGood").isEnabled() ? "#memoryGood" : "#memoryAgain").click();
  await page.locator("#memoryNext:not(.hidden)").waitFor();
  await page.evaluate(() => window.__hsk.memory.store.saveNote("安", "старая заметка"));
  const oldMemory = await page.evaluate(async () => ({ events: (await window.__hsk.memory.store.events()).sort((a, b) => a.id.localeCompare(b.id)), notes: await window.__hsk.memory.store.notes() }));
  assert.ok(oldMemory.events.length >= 2);

  await load(page, ROOT);
  await page.locator("#memoryOpen").click();
  await page.locator("#memoryStart").waitFor();
  const newMemory = await page.evaluate(async () => ({ events: (await window.__hsk.memory.store.events()).sort((a, b) => a.id.localeCompare(b.id)), notes: await window.__hsk.memory.store.notes() }));
  assert.deepEqual(newMemory, oldMemory);
  assert.deepEqual(errors, []);
  await context.close();
});
