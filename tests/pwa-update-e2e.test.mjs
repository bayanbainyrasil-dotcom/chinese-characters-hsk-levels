// Обновление PWA с настоящим Service Worker: старая опубликованная версия
// (116ac89) → текущее рабочее дерево на том же адресе. Несколько вкладок,
// незавершённое занятие, старый кэш, пропадание сети, сохранность прогресса,
// совместимость модулей после обновления. Профиль изолированный, Chromium.
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
const OLD = "116ac89";
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".mp3": "audio/mpeg", ".webmanifest": "application/manifest+json",
};

let server, base, browser, oldRoot, currentRoot;

before(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hsk-pwa-"));
  oldRoot = path.join(tmp, OLD);
  fs.mkdirSync(oldRoot);
  let archive;
  try { archive = execFileSync("git", ["-C", ROOT, "archive", "--format=tar", OLD], { maxBuffer: 512 * 1024 * 1024 }); }
  catch (error) { throw new Error(`Нет коммита ${OLD}: нужен полный клон (fetch-depth: 0). ${error.message}`); }
  execFileSync("tar", ["-x", "-C", oldRoot], { input: archive });
  currentRoot = oldRoot;
  server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    let file = path.join(currentRoot, decodeURIComponent(url.pathname));
    if (url.pathname.endsWith("/")) file = path.join(file, "index.html");
    if (!file.startsWith(currentRoot) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    // как GitHub Pages: короткий HTTP-кэш
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "max-age=600" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await launch();
});
after(async () => { await browser?.close(); server?.close(); });

async function controlled(page) {
  await page.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 15000 });
}

async function appInfo(page) {
  return page.evaluate(async () => ({
    hasNewApi: Boolean(document.getElementById("progressAlert")),
    marker: window.__marker || null,
    caches: (await caches.keys()).sort(),
    progress: JSON.parse(localStorage.getItem("bishun_hsk30_progress_v1") || "null"),
  }));
}

test(`обновление ${OLD} → рабочее дерево: открытое занятие не прерывается, офлайн-запуск согласован`, async () => {
  const context = await browser.newContext({ viewport: { width: 1000, height: 900 } });
  await serveStrokeData(context);
  await stubBackend(context);
  const tab1 = await context.newPage();
  const errors1 = collectErrors(tab1);

  // 1. Старая версия: SW установлен, кэш прогрет, есть прогресс.
  currentRoot = oldRoot;
  await tab1.goto(base);
  await tab1.waitForFunction(() => window.__hsk);
  await controlled(tab1);
  await tab1.reload(); // вторая загрузка проходит через SW и заполняет кэш
  await tab1.waitForFunction(() => window.__hsk);
  await tab1.evaluate(() => window.__hsk.startSingleCharacter("十"));
  await tab1.locator("#hanziTarget svg").waitFor();
  await drawCharacter(tab1, "十", "#hanziTarget");
  await tab1.waitForFunction(() => document.querySelector("#feedback")?.classList.contains("success"));
  const before = await appInfo(tab1);
  assert.equal(before.hasNewApi, false, "это действительно старая версия");
  assert.ok(before.progress.attempts >= 1);

  // 2. Начато новое занятие и написана одна черта из двух — не завершено.
  await tab1.evaluate(() => { window.__marker = "tab1-alive"; window.__hsk.startSingleCharacter("人"); });
  await tab1.locator("#hanziTarget svg").waitFor();
  await tab1.waitForTimeout(300);

  // 3. Сайт обновлён. Пользователь открывает вторую вкладку — она получает новую версию.
  currentRoot = ROOT;
  const tab2 = await context.newPage();
  const errors2 = collectErrors(tab2);
  await tab2.goto(base);
  await tab2.waitForFunction(() => window.__hsk);
  const inTab2 = await appInfo(tab2);
  assert.equal(inTab2.hasNewApi, true, "вторая вкладка — новая версия (сеть в приоритете)");
  assert.deepEqual(inTab2.progress.completed, before.progress.completed, "прогресс старой версии виден в новой");

  // 4. Первая вкладка не перезагружена посреди письма и дописывает знак.
  const tab1Now = await appInfo(tab1);
  assert.equal(tab1Now.marker, "tab1-alive", "вкладка с занятием не перезагружалась");
  await drawCharacter(tab1, "人", "#hanziTarget");
  await tab1.waitForFunction(() => document.querySelector("#feedback")?.classList.contains("success"));
  const afterFinish = await appInfo(tab1);
  assert.equal(afterFinish.progress.attempts, before.progress.attempts + 1, "занятие, начатое в старой версии, сохранено");

  // 5. Новая вкладка после обновления занимается и не затирает результат старой.
  await tab2.reload();
  await tab2.waitForFunction(() => window.__hsk);
  await tab2.evaluate(() => window.__hsk.startSingleCharacter("大"));
  await tab2.evaluate(() => window.__hsk.completeCurrentItem(0));
  const merged = await appInfo(tab2);
  assert.equal(merged.progress.attempts, before.progress.attempts + 2);

  // 6. Сеть пропала. Перезапуск из кэша должен поднять согласованную версию без ошибок модулей.
  await context.setOffline(true);
  for (const tab of [tab1, tab2]) {
    await tab.reload();
    await tab.waitForFunction(() => window.__hsk, null, { timeout: 15000 });
  }
  const offline1 = await appInfo(tab1);
  const offline2 = await appInfo(tab2);
  console.log(`# офлайн: вкладка 1 новая=${offline1.hasNewApi}, вкладка 2 новая=${offline2.hasNewApi}; кэши ${offline1.caches.join(",")}`);
  assert.equal(offline1.progress.attempts, before.progress.attempts + 2, "офлайн: прогресс на месте");
  const moduleErrors = [...errors1, ...errors2].filter((e) => /does not provide an export|Failed to fetch dynamically|SyntaxError|is not defined/.test(e));
  assert.deepEqual(moduleErrors, [], "нет смешения несовместимых модулей");
  assert.equal(offline1.hasNewApi, true, "офлайн поднимается та же (новая) версия, что была онлайн");
  assert.equal(offline2.hasNewApi, true);

  // 7. Офлайн-занятие сохраняется.
  await tab2.evaluate(() => window.__hsk.startSingleCharacter("十"));
  await tab2.locator("#hanziTarget svg").waitFor({ timeout: 15000 });
  await tab2.evaluate(() => window.__hsk.completeCurrentItem(0));
  assert.equal((await appInfo(tab2)).progress.attempts, before.progress.attempts + 3);
  await context.setOffline(false);
  await context.close();
});
