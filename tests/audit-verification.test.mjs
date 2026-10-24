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

test("deep verification: all hash routes, unknown hash fallback, reload, and outside touch scroll", async () => {
  const context = await browser.newContext();
  await serveStrokeData(context);
  await stubBackend(context);
  const page = await context.newPage();

  const hashes = ["#rules", "#radicals", "#hsk", "#progress", "#settings", "#admin", "#verification"];
  const viewMap = {
    "#rules": "#rulesView",
    "#radicals": "#radicalsView",
    "#hsk": "#hskView",
    "#progress": "#progressView",
    "#settings": "#settingsView",
    "#admin": "#adminView",
    "#verification": "#verificationView",
  };

  // 1. Прямое открытие каждого маршрута
  for (const hash of hashes) {
    await page.goto(`${base}${hash}`);
    await page.waitForFunction(() => window.__hsk);
    const viewSelector = viewMap[hash];
    assert.equal(await page.locator(viewSelector).isVisible(), true, `Direct open of ${hash} should show ${viewSelector}`);
    assert.equal(await page.locator("#homeView").isVisible(), false, `Direct open of ${hash} should hide homeView`);
  }

  // 2. Обновление страницы (reload) на #rulesView сохраняет #rulesView
  await page.goto(`${base}#rules`);
  await page.waitForFunction(() => window.__hsk);
  await page.reload();
  await page.waitForFunction(() => window.__hsk);
  assert.equal(await page.locator("#rulesView").isVisible(), true, "Page reload on #rules must keep rulesView visible");
  assert.equal(await page.locator("#homeView").isVisible(), false);

  // 3. Неизвестный хеш (#unknown-404) грациозно возвращает на homeView
  await page.evaluate(() => { window.location.hash = "#unknown-hash-404"; });
  await page.waitForFunction(() => !document.getElementById("homeView").classList.contains("hidden"));
  assert.equal(await page.locator("#homeView").isVisible(), true, "Unknown hash must fall back to homeView");
  assert.equal(await page.locator("#rulesView").isVisible(), false);

  // 4. Проверка скролла: вне холста touchmove НЕ блокируется, внутри холста touchmove блокируется
  const scrollResults = await page.evaluate(() => {
    const memoryBoard = document.getElementById("memoryBoard");
    const writingBoard = document.getElementById("writingBoard");
    const body = document.body;

    const mkTouch = () => new TouchEvent("touchmove", { cancelable: true, bubbles: true });

    const evBody = mkTouch();
    body.dispatchEvent(evBody);

    const evWriting = mkTouch();
    writingBoard.dispatchEvent(evWriting);

    const evMemory = mkTouch();
    memoryBoard.dispatchEvent(evMemory);

    return {
      bodyPrevented: evBody.defaultPrevented,
      writingPrevented: evWriting.defaultPrevented,
      memoryPrevented: evMemory.defaultPrevented
    };
  });

  assert.equal(scrollResults.bodyPrevented, false, "Outside touchmove must NOT be prevented (normal scroll allowed)");
  assert.equal(scrollResults.writingPrevented, true, "WritingBoard touchmove must be prevented");
  assert.equal(scrollResults.memoryPrevented, true, "MemoryBoard touchmove must be prevented");

  await context.close();
});

test("deep verification: hint disclosure protection and assisted attempt lock", async () => {
  const context = await browser.newContext();
  await serveStrokeData(context);
  await stubBackend(context);

  const data = JSON.parse(fs.readFileSync(new URL("../data/writing.json", import.meta.url)));
  const row = Object.values(data.groups).flat().find((r) => r.char === "安");
  await context.route("**/data/writing.json", (r) => r.fulfill({ json: { ...data, groups: { "1-2": [row] } } }));

  const page = await context.newPage();
  await page.addInitScript(() => {
    localStorage.setItem("bishun_hsk30_progress_v1", JSON.stringify({ completed: { hsk: { "1-2:安": 5 } } }));
  });

  await page.goto(base);
  await page.waitForFunction(() => window.__hsk);

  await page.locator("#memoryOpen").click();
  await page.locator("#memoryStart").click();
  await page.locator("#memoryHelp:not([disabled])").waitFor();

  // На этапе 0: целевой иероглиф скрыт из поля подсказок и контекста
  const cue = await page.locator("#memoryCue").textContent();
  const contextText = await page.locator("#memoryContext").textContent();
  const answerHidden = await page.locator("#memoryAnswer").isHidden();

  assert.doesNotMatch(cue, /安/, "Target character 安 must not be disclosed in cue");
  assert.doesNotMatch(contextText, /安/, "Target character 安 must not be disclosed in context");
  assert.equal(answerHidden, true, "Answer card must remain hidden at stage 0");

  // Запрашиваем подсказку 1 (сюжет)
  await page.locator("#memoryStoryHint").click();
  await page.waitForFunction(() => window.__hsk.memory.pending.hintStage >= 1);
  assert.equal(await page.evaluate(() => window.__hsk.memory.pending.assisted), true, "Requesting hint must mark assisted = true");

  // Запрашиваем подсказку 2 (компоненты)
  await page.locator("#memoryPartsHint").click();
  await page.waitForFunction(() => window.__hsk.memory.pending.hintStage >= 2);

  // Иероглиф 安 по-прежнему не раскрыт в #memoryAnswer
  assert.equal(await page.locator("#memoryAnswer").isHidden(), true, "Character answer must still be hidden at stage 2");

  await context.close();
});


test("sign-in sends exactly one request per click and per Enter", async () => {
  const context = await browser.newContext();
  await serveStrokeData(context);
  await stubBackend(context);
  const page = await context.newPage();
  const hits = [];
  page.on("request", (r) => { if (r.url().includes("/auth/v1/token")) hits.push(r.url()); });
  await page.goto(`${base}#settings`);
  await page.waitForFunction(() => window.__hsk);
  await page.fill("#authEmail", "test@example.com");
  await page.fill("#authPassword", "secret123");
  await page.locator("#authSignIn").click();
  await page.waitForFunction(() => document.getElementById("authMessage").textContent.length > 0);
  await page.waitForTimeout(500);
  assert.equal(hits.length, 1, "клик — один запрос");
  hits.length = 0;
  await page.locator("#authPassword").press("Enter");
  await page.waitForTimeout(800);
  assert.equal(hits.length, 1, "Enter — один запрос");
  await context.close();
});

test("Back/Forward: из упражнения — к списку уровней, из памяти — на главную; упражнение продолжается", async () => {
  const context = await browser.newContext();
  await serveStrokeData(context);
  await stubBackend(context);
  const page = await context.newPage();
  const state = () => page.evaluate(() => ({ hash: location.hash, view: document.body.dataset.view }));
  await page.goto(base);
  await page.waitForFunction(() => window.__hsk);
  await page.evaluate(() => window.__hsk.showView("hskView"));
  await page.evaluate(() => window.__hsk.startHskLevel("1-2"));
  await page.locator("#writingBoard #hanziTarget svg").waitFor();
  assert.deepEqual(await state(), { hash: "#hsk", view: "practiceView" });
  await page.goBack();
  await page.waitForFunction(() => document.body.dataset.view === "hskView");
  await page.goForward();
  await page.waitForFunction(() => document.body.dataset.view === "practiceView");
  // упражнение после «Вперёд» рабочее: знак дописывается и засчитывается
  await page.evaluate(() => window.__hsk.completeCurrentItem(0));
  assert.equal(await page.evaluate(() => window.__hsk.progress.attempts), 1);

  await page.evaluate(() => window.__hsk.showView("homeView"));
  await page.locator("#memoryOpen").click();
  await page.waitForFunction(() => document.body.dataset.view === "memoryView");
  await page.goBack();
  await page.waitForFunction(() => document.body.dataset.view === "homeView");
  assert.deepEqual(await state(), { hash: "", view: "homeView" });
  await page.goForward();
  await page.waitForFunction(() => document.body.dataset.view === "memoryView");
  await page.locator("#memoryStart").waitFor({ state: "visible" });
  await page.reload();
  await page.waitForFunction(() => window.__hsk);
  assert.equal((await state()).view, "homeView", "перезагрузка, как и раньше, ведёт на главную");
  await context.close();
});

test("кнопки загрузки копии показывают фокус клавиатуры", async () => {
  const context = await browser.newContext();
  await stubBackend(context);
  const page = await context.newPage();
  await page.goto(`${base}#progress`);
  await page.waitForFunction(() => window.__hsk);
  for (const [view, id] of [["progressView", "importProgressInput"], ["memoryView", "memoryImport"]]) {
    await page.evaluate((v) => window.__hsk.showView(v), view);
    await page.locator(`#${id}`).waitFor({ state: "attached" });
    await page.waitForFunction((i) => document.getElementById(i).closest("label").offsetParent !== null, id);
    const outline = await page.evaluate((i) => { const el = document.getElementById(i); el.focus(); const s = getComputedStyle(el.closest("label")); return `${s.outlineStyle} ${s.outlineWidth}`; }, id);
    assert.notEqual(outline.split(" ")[0], "none", `${id}: виден фокус (${outline})`);
  }
  await context.close();
});

test("Назад после выхода кнопкой приложения не возвращает в закрытый раздел", async () => {
  const context = await browser.newContext();
  await serveStrokeData(context);
  await stubBackend(context);
  const page = await context.newPage();
  const view = () => page.evaluate(() => document.body.dataset.view);
  await page.goto(base);
  await page.waitForFunction(() => window.__hsk);
  // A: память → «← Главная» → #hsk → Назад = главная
  await page.locator("#memoryOpen").click();
  await page.locator("#memoryStart").waitFor({ state: "visible" });
  await page.locator("#memoryView [data-back-home]").click();
  await page.waitForFunction(() => document.body.dataset.view === "homeView");
  await page.evaluate(() => window.__hsk.showView("hskView"));
  await page.goBack();
  await page.waitForTimeout(300);
  assert.equal(await view(), "homeView", "A: назад с #hsk — на главную");
  // B: #hsk → упражнение → кнопка выхода → #progress → Назад = список уровней
  await page.evaluate(() => window.__hsk.showView("hskView"));
  await page.evaluate(() => window.__hsk.startHskLevel("1-2"));
  await page.locator("#writingBoard #hanziTarget svg").waitFor();
  await page.locator("#practiceBackButton").click();
  await page.waitForFunction(() => document.body.dataset.view !== "practiceView");
  const afterExit = await view();
  await page.evaluate(() => window.__hsk.showView("progressView"));
  await page.goBack();
  await page.waitForTimeout(300);
  assert.equal(await view(), afterExit, `B: назад с #progress — туда, куда вышли из упражнения (${afterExit})`);
  await context.close();
});

test("закрытое кнопкой упражнение не открывается снова через «Назад»", async () => {
  const context = await browser.newContext();
  await serveStrokeData(context);
  await stubBackend(context);
  const page = await context.newPage();
  await page.goto(base);
  await page.waitForFunction(() => window.__hsk);
  await page.evaluate(() => window.__hsk.showView("hskView"));
  await page.evaluate(() => window.__hsk.startHskLevel("1-2"));
  await page.locator("#writingBoard #hanziTarget svg").waitFor();
  await page.locator("#practiceBackButton").click();
  await page.waitForFunction(() => document.body.dataset.view === "hskView");
  for (let i = 0; i < 2; i += 1) { await page.goBack(); await page.waitForTimeout(250); }
  assert.notEqual(await page.evaluate(() => document.body.dataset.view), "practiceView");
  await context.close();
});

test("история без пустых шагов: повторный показ раздела и выход из упражнения кнопкой", async () => {
  const context = await browser.newContext();
  await serveStrokeData(context);
  await stubBackend(context);
  const page = await context.newPage();
  await page.goto(`${base}#progress`);
  await page.waitForFunction(() => window.__hsk);
  const len0 = await page.evaluate(() => history.length);
  await page.evaluate(() => window.__hsk.showView("progressView"));
  assert.equal(await page.evaluate(() => history.length), len0, "тот же раздел — без новой записи");
  await page.evaluate(() => window.__hsk.showView("hskView"));
  await page.evaluate(() => window.__hsk.startHskLevel("1-2"));
  await page.locator("#writingBoard #hanziTarget svg").waitFor();
  await page.locator("#practiceBackButton").click();
  await page.waitForFunction(() => document.body.dataset.view === "hskView");
  await page.goBack();
  await page.waitForFunction(() => document.body.dataset.view !== "hskView");
  assert.equal(await page.evaluate(() => document.body.dataset.view), "progressView", "один «Назад» — в предыдущий раздел");
  await context.close();
});
