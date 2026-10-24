import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { startServer, launch, serveStrokeData, stubBackend } from "./helpers.mjs";

let browser, server, base;

before(async () => {
  ({ server, url: base } = await startServer());
  browser = await launch();
});

after(async () => {
  await browser?.close();
  server?.close();
});

test("direct hash routing opens nested views and popstate navigates cleanly", async () => {
  const context = await browser.newContext();
  await serveStrokeData(context);
  await stubBackend(context);
  const page = await context.newPage();

  // Прямое открытие #settings
  await page.goto(`${base}#settings`);
  await page.waitForFunction(() => window.__hsk);
  assert.equal(await page.locator("#settingsView").isVisible(), true);
  assert.equal(await page.locator("#homeView").isVisible(), false);

  // Возврат на главную через кнопку
  await page.locator('#settingsView [data-back-home]').click();
  await page.waitForFunction(() => !document.getElementById("homeView").classList.contains("hidden"));
  assert.equal(await page.locator("#homeView").isVisible(), true);
  assert.equal(await page.locator("#settingsView").isVisible(), false);

  // Прямой переход через showView в progress
  await page.evaluate(() => window.__hsk.showView("progressView"));
  assert.equal(await page.evaluate(() => window.location.hash), "#progress");
  assert.equal(await page.locator("#progressView").isVisible(), true);

  // Браузерный переход назад
  await page.goBack();
  await page.waitForFunction(() => !document.getElementById("homeView").classList.contains("hidden"));
  assert.equal(await page.locator("#homeView").isVisible(), true);

  // Браузерный переход вперёд
  await page.goForward();
  await page.waitForFunction(() => !document.getElementById("progressView").classList.contains("hidden"));
  assert.equal(await page.locator("#progressView").isVisible(), true);

  await context.close();
});

test("progressView has accessible export and import controls for regular learners", async () => {
  const context = await browser.newContext();
  await serveStrokeData(context);
  await stubBackend(context);
  const page = await context.newPage();

  await page.goto(`${base}#progress`);
  await page.waitForFunction(() => window.__hsk);

  assert.equal(await page.locator("#exportProgressButton").isVisible(), true);
  assert.equal(await page.locator("#importProgressInput").count(), 1);
  assert.equal(await page.locator("#restoreBackupButton").isVisible(), true);

  await context.close();
});

test("auth credentials are in a form and auth form submit triggers validation", async () => {
  const context = await browser.newContext();
  await serveStrokeData(context);
  await stubBackend(context);
  const page = await context.newPage();

  await page.goto(`${base}#settings`);
  await page.waitForFunction(() => window.__hsk);

  assert.equal(await page.locator("#authForm").isVisible(), true);
  assert.equal(await page.locator("#authForm #authEmail").isVisible(), true);
  assert.equal(await page.locator("#authForm #authPassword").isVisible(), true);

  // Нажатие enter в поле пароля отправляет форму
  await page.locator("#authPassword").focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.getElementById("authMessage").textContent.length > 0);
  assert.match(await page.locator("#authMessage").textContent(), /почт/i);

  await context.close();
});

test("memoryBoard prevents touch scrolling and mnemonic panel displays similar character distinctions", async () => {
  const context = await browser.newContext();
  await serveStrokeData(context);
  await stubBackend(context);

  const data = JSON.parse(fs.readFileSync(new URL("../data/writing.json", import.meta.url)));
  const row = Object.values(data.groups).flat().find((r) => r.char === "安");
  await context.route("**/data/writing.json", (r) => r.fulfill({ json: { ...data, groups: { "1-2": [row] } } }));

  // Предустанавливаем прогресс для знака 安, чтобы запустить режим проверки памяти с подсказками
  const page = await context.newPage();
  await page.addInitScript(() => {
    localStorage.setItem("bishun_hsk30_progress_v1", JSON.stringify({ completed: { hsk: { "1-2:安": 5 } } }));
  });

  await page.goto(base);
  await page.waitForFunction(() => window.__hsk);

  // Проверка touchmove на memoryBoard
  const touchPrevented = await page.evaluate(() => {
    const board = document.getElementById("memoryBoard");
    let prevented = false;
    const evt = new TouchEvent("touchmove", {
      cancelable: true,
      bubbles: true,
      touches: [],
      targetTouches: [],
      changedTouches: [],
    });
    board.dispatchEvent(evt);
    return evt.defaultPrevented;
  });
  assert.equal(touchPrevented, true);

  // Открываем память
  await page.locator("#memoryOpen").click();
  await page.locator("#memoryStart").click();
  await page.locator("#memoryHelp:not([disabled])").waitFor();

  // Раскрываем подсказку этапа 2 (детали компонентов)
  await page.locator("#memoryPartsHint").click();
  await page.waitForFunction(() => window.__hsk.memory.pending.hintStage >= 2);

  const observationText = await page.locator(".mnemonic-observation").textContent();
  assert.ok(observationText.length > 10, "Observation text should be rendered for component disambiguation");
  assert.match(observationText, /Расположение/);
  assert.match(observationText, /Не путать с 字/);

  await context.close();
});
