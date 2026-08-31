// Сквозные сценарии из раздела «Проверка готовности».
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer, launch, serveStrokeData, stubBackend, collectErrors, drawCharacter, LEGACY_PROGRESS } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROGRESS_KEY = "bishun_hsk30_progress_v1";
const BACKUP_KEY = "bishun_hsk30_progress_backup_v1";
const MIGRATION_KEY = "bishun_hsk30_migration_v2";

let server, base, browser;

before(async () => {
  ({ server, url: base } = await startServer());
  browser = await launch();
});

after(async () => {
  await browser?.close();
  server?.close();
});

async function open({ viewport = { width: 1280, height: 900 }, legacy = null, reducedMotion = null, isMobile = false, google = true } = {}) {
  const context = await browser.newContext({
    viewport, reducedMotion: reducedMotion || undefined,
    hasTouch: isMobile, isMobile,
    deviceScaleFactor: isMobile ? 2 : 1,
  });
  await serveStrokeData(context);
  await stubBackend(context, { google });
  const page = await context.newPage();
  const errors = collectErrors(page);
  if (legacy) {
    await page.addInitScript(([key, value]) => {
      localStorage.setItem(key, JSON.stringify(value));
    }, [PROGRESS_KEY, legacy]);
  }
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.__hsk));
  return { context, page, errors };
}

test("страница поднимается без ошибок в консоли", async () => {
  const { context, page, errors } = await open();
  await page.waitForTimeout(700);
  assert.equal(await page.locator(".stage-card").count(), 4);
  assert.deepEqual(errors, []);
  await context.close();
});

test("старый прогресс переживает обновление и попадает в резервную копию", async () => {
  const { context, page, errors } = await open({ legacy: LEGACY_PROGRESS });
  await page.waitForTimeout(400);
  const state = await page.evaluate(() => window.__hsk.progress);
  assert.equal(state.completed.hsk["3:安"], 5);
  assert.equal(state.completed.hsk["3:把"], 3);
  assert.equal(state.attempts, 42);
  assert.equal(state.cleanAttempts, 18);
  assert.deepEqual(state.days, ["2026-08-01", "2026-08-02", "2026-08-15"]);
  assert.equal(state.lastSession.level, "3");

  const backup = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), BACKUP_KEY);
  assert.equal(backup.progress.attempts, 42);
  const mark = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), MIGRATION_KEY);
  assert.equal(mark.hadLegacy, true);
  assert.equal(mark.backedUp, true);
  assert.equal(mark.legacyKey, PROGRESS_KEY);

  // Отметка о миграции не переписывается при следующем запуске.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.__hsk));
  const again = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), MIGRATION_KEY);
  assert.equal(again.id, mark.id);
  assert.deepEqual(errors, []);
  await context.close();
});

test("продолжение занятия видно на главной", async () => {
  const { context, page } = await open({ legacy: LEGACY_PROGRESS });
  await assert.doesNotReject(page.locator("#continueCard").waitFor({ state: "visible" }));
  assert.match(await page.locator("#continueTitle").textContent(), /HSK 3/);
  await context.close();
});

test("знак пишется указателем, повторение засчитывается и переживает перезагрузку", async () => {
  const { context, page, errors } = await open();
  await page.evaluate(() => window.__hsk.startHskLevel("1-2"));
  await page.locator("#writingBoard #hanziTarget svg").waitFor({ state: "visible", timeout: 15000 });
  await page.waitForTimeout(400);
  const character = await page.locator("#characterLabel").textContent();
  const before = await page.evaluate(() => window.__hsk.progress.attempts);

  await drawCharacter(page, character);
  await page.waitForFunction((count) => window.__hsk.progress.attempts > count, before, { timeout: 15000 });

  const state = await page.evaluate(() => window.__hsk.progress);
  assert.equal(state.attempts, before + 1);
  assert.equal(state.completed.hsk[`1-2:${character}`], 1);
  assert.equal(await page.locator(".repeat-dot.done").count(), 1);

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.__hsk));
  const after = await page.evaluate(() => window.__hsk.progress);
  assert.equal(after.completed.hsk[`1-2:${character}`], 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test("пять повторений закрывают знак и сохраняются после перезагрузки", async () => {
  const { context, page } = await open();
  await page.evaluate(() => window.__hsk.startHskLevel("3"));
  await page.locator("#hanziTarget svg").waitFor({ state: "visible", timeout: 15000 });
  const character = await page.locator("#characterLabel").textContent();
  for (let index = 0; index < 5; index += 1) {
    await page.evaluate(() => window.__hsk.completeCurrentItem(0));
  }
  assert.equal(await page.evaluate(() => window.__hsk.progress.completed.hsk[Object.keys(window.__hsk.progress.completed.hsk)[0]]), 5);
  assert.equal(await page.locator(".repeat-dot.done").count(), 5);

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.__hsk));
  const stored = await page.evaluate((char) => window.__hsk.progress.completed.hsk[`3:${char}`], character);
  assert.equal(stored, 5);
  await context.close();
});

test("пример открывает карточку с разбором по знакам", async () => {
  const { context, page, errors } = await open();
  await page.evaluate(() => window.__hsk.startHskLevel("3"));
  await page.locator(".example-pill").first().waitFor({ state: "visible", timeout: 15000 });
  await page.locator(".example-pill").nth(1).click();
  await page.locator("#wordSheet .word-sheet-panel").waitFor({ state: "visible" });

  const word = await page.locator("#wordSheetWord").textContent();
  const pinyin = await page.locator("#wordSheetPinyin").textContent();
  assert.ok(word.length >= 1);
  assert.ok(pinyin.length >= 1);
  assert.ok((await page.locator("#wordSheetTranslation").textContent()).length > 1);

  const rows = page.locator(".char-row");
  assert.equal(await rows.count(), [...word].length);
  // Ни у одного знака чтение не равно пиньиню всего слова.
  for (let index = 0; index < await rows.count(); index += 1) {
    const reading = await rows.nth(index).locator("strong").textContent();
    if ([...word].length > 1) assert.notEqual(reading.trim(), pinyin.trim());
    assert.ok(reading.trim().length > 0);
  }
  assert.equal(await page.locator("#wordSheet").getAttribute("hidden"), null);
  assert.equal(await page.locator(".word-sheet-panel").getAttribute("aria-modal"), "true");
  assert.deepEqual(errors, []);
  await context.close();
});

test("разбор 汉语 совпадает с эталоном из задания", async () => {
  const { context, page } = await open();
  await page.evaluate(() => window.__hsk.openWordCard(
    { word: "汉语", pinyin: "Hànyǔ", russian: "китайский язык", level: "1", partOfSpeech: "名" },
    {},
  ));
  await page.locator(".char-row").first().waitFor({ state: "visible" });
  const rows = await page.locator(".char-row").evaluateAll((nodes) => nodes.map((node) => ({
    char: node.querySelector(".char-row-char").textContent,
    pinyin: node.querySelector("strong").textContent,
    meaning: node.querySelector("small").textContent,
  })));
  assert.deepEqual(rows.map((row) => row.char), ["汉", "语"]);
  assert.equal(rows[0].pinyin, "hàn");
  assert.equal(rows[1].pinyin, "yǔ");
  assert.match(rows[0].meaning, /китайск/i);
  assert.match(rows[1].meaning, /язык/i);
  assert.equal(await page.locator(".level-badge").textContent(), "HSK 1");
  assert.equal(await page.locator(".pos-badge").textContent(), "名");
  await context.close();
});

test("карточка закрывается клавишей Escape, фоном, кнопкой и «Назад»", async () => {
  const { context, page } = await open();
  const openCard = () => page.evaluate(() => window.__hsk.openWordCard(
    { word: "汉字", pinyin: "Hànzì", russian: "китайские иероглифы", level: "1" }, {}));

  await openCard();
  await page.locator(".word-sheet-panel").waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await page.locator("#wordSheet").waitFor({ state: "hidden" });

  await openCard();
  await page.locator(".word-sheet-panel").waitFor({ state: "visible" });
  await page.locator(".word-sheet-backdrop").click({ position: { x: 5, y: 5 } });
  await page.locator("#wordSheet").waitFor({ state: "hidden" });

  await openCard();
  await page.locator(".word-sheet-panel").waitFor({ state: "visible" });
  await page.locator(".word-sheet-close").click();
  await page.locator("#wordSheet").waitFor({ state: "hidden" });

  await openCard();
  await page.locator(".word-sheet-panel").waitFor({ state: "visible" });
  await page.goBack();                                  // системная кнопка «Назад»
  await page.locator("#wordSheet").waitFor({ state: "hidden" });
  await context.close();
});

test("в карточке фокус остаётся внутри окна", async () => {
  const { context, page } = await open();
  await page.evaluate(() => window.__hsk.openWordCard({ word: "汉语", pinyin: "Hànyǔ", russian: "китайский язык", level: "1" }, {}));
  await page.locator(".word-sheet-panel").waitFor({ state: "visible" });
  for (let index = 0; index < 12; index += 1) {
    await page.keyboard.press("Tab");
    const inside = await page.evaluate(() => Boolean(document.activeElement?.closest(".word-sheet-panel")));
    assert.equal(inside, true, `фокус ушёл из окна на шаге ${index}`);
  }
  await context.close();
});

test("нажатие на знак в разборе открывает его письмо", async () => {
  const { context, page } = await open();
  await page.evaluate(() => window.__hsk.startHskLevel("3"));
  await page.locator(".example-pill").first().waitFor({ state: "visible", timeout: 15000 });
  // Берём пример из нескольких знаков: у одиночного знака разбор не нужен.
  const multi = page.locator(".example-pill").filter({ has: page.locator(".example-word") }).nth(1);
  await multi.click();
  await page.locator(".char-row").first().waitFor({ state: "visible" });
  const target = await page.locator(".char-row").first().locator(".char-row-char").textContent();
  await page.locator(".char-row").first().click();
  await page.waitForFunction((char) => document.getElementById("characterLabel").textContent === char, target, { timeout: 15000 });
  assert.equal(await page.locator("#characterLabel").textContent(), target);
  await context.close();
});

test("на телефоне карточка приходит снизу как bottom sheet", async () => {
  const { context, page } = await open({ viewport: { width: 390, height: 844 }, isMobile: true });
  await page.evaluate(() => window.__hsk.openWordCard({ word: "汉服", pinyin: "Hànfú", russian: "ханьфу", level: "7-9" }, {}));
  await page.locator(".word-sheet-panel").waitFor({ state: "visible" });
  await page.waitForTimeout(400);
  const box = await page.locator(".word-sheet-panel").boundingBox();
  const viewport = page.viewportSize();
  assert.ok(box.y + box.height >= viewport.height - 2, "карточка прижата к нижнему краю");
  assert.ok(box.width >= viewport.width - 2, "карточка на всю ширину");
  await context.close();
});

test("поиск открывает подробную карточку слова", async () => {
  const { context, page } = await open();
  await page.evaluate(() => window.__hsk.showView("hskView"));
  await page.locator("#vocabularySearch").fill("汉语");
  await page.locator(".word-result").first().waitFor({ state: "visible", timeout: 15000 });
  await page.locator(".word-result").first().click();
  await page.locator(".word-sheet-panel").waitFor({ state: "visible" });
  assert.equal(await page.locator("#wordSheetWord").textContent(), "汉语");
  assert.ok(await page.locator("#wordSheetPractice").isVisible());
  await context.close();
});

test("очередь синхронизации копит события с уникальными идентификаторами", async () => {
  const { context, page } = await open();
  await page.evaluate(() => window.__hsk.startHskLevel("3"));
  await page.locator("#hanziTarget svg").waitFor({ state: "visible", timeout: 15000 });
  for (let index = 0; index < 3; index += 1) await page.evaluate(() => window.__hsk.completeCurrentItem(0));
  const queue = await page.evaluate(() => JSON.parse(localStorage.getItem("bishun_hsk30_sync_queue_v1") || "[]"));
  const writes = queue.filter((event) => event.payload.kind === "write");
  assert.equal(writes.length, 3);
  assert.equal(new Set(queue.map((event) => event.id)).size, queue.length, "идентификаторы событий уникальны");
  assert.ok(writes.every((event) => event.payload.attemptsDelta === 1));
  assert.ok(writes.every((event) => Array.isArray(event.payload.days) && event.payload.days.length === 1));
  await context.close();
});

test("без интернета работа продолжается, а индикатор честно об этом говорит", async () => {
  const { context, page } = await open();
  await page.evaluate(() => window.__hsk.startHskLevel("3"));
  await page.locator("#hanziTarget svg").waitFor({ state: "visible", timeout: 15000 });
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await page.waitForTimeout(200);
  assert.equal(await page.locator("#offlineBanner").isVisible(), true);
  await page.evaluate(() => window.__hsk.completeCurrentItem(0));
  const attempts = await page.evaluate(() => window.__hsk.progress.attempts);
  assert.equal(attempts, 1, "результат сохранён локально даже без сети");
  await context.setOffline(false);
  await context.close();
});

test("переключатель темы меняет оформление и запоминается", async () => {
  const { context, page } = await open();
  await page.evaluate(() => window.__hsk.showView("settingsView"));
  await page.locator('[data-theme-option="light"]').click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "light");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.__hsk));
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "light");
  await page.evaluate(() => window.__hsk.showView("settingsView"));
  await page.locator('[data-theme-option="dark"]').click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");
  await context.close();
});

test("при prefers-reduced-motion переходы почти мгновенные", async () => {
  const { context, page } = await open({ reducedMotion: "reduce" });
  assert.equal(await page.evaluate(() => window.__hsk.motion.reducedMotion()), true);
  await page.evaluate(() => window.__hsk.openWordCard({ word: "汉语", pinyin: "Hànyǔ", russian: "китайский язык", level: "1" }, {}));
  await page.locator(".word-sheet-panel").waitFor({ state: "visible" });
  const duration = await page.evaluate(() => getComputedStyle(document.querySelector(".word-sheet-panel")).transitionDuration);
  assert.ok(parseFloat(duration) < 0.02, `длительность перехода: ${duration}`);
  await context.close();
});

test("настройки звука сохраняются и уходят в очередь синхронизации", async () => {
  const { context, page } = await open();
  await page.evaluate(() => window.__hsk.showView("settingsView"));
  await page.locator("#settingAutoSpeak").uncheck();
  await page.locator("#settingMuted").check();
  const settings = await page.evaluate(() => window.__hsk.progress.settings);
  assert.equal(settings.autoSpeak, false);
  assert.equal(settings.muted, true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.__hsk));
  assert.equal(await page.evaluate(() => window.__hsk.progress.settings.muted), true);
  await context.close();
});

test("гостевой режим не требует аккаунта", async () => {
  const { context, page } = await open();
  await page.evaluate(() => window.__hsk.showView("settingsView"));
  const configured = await page.evaluate(() => Boolean(window.__hsk.backendReady()));
  if (configured) {
    await page.locator("#authGuest").click();
  } else {
    // Без бэкенда аккаунта нет вовсе — «гость» это единственный режим.
    await page.locator("[data-back-home]").first().click();
  }
  assert.equal(await page.locator("#homeView").isVisible(), true);
  await context.close();
});

test("админ-раздел не проверяет пароль в браузере", async () => {
  const { context, page } = await open();
  await page.locator("#adminButton").click();
  await page.locator("#adminGate").waitFor({ state: "visible" });
  assert.match(await page.locator('label[for="adminPin"]').textContent(), /Пароль администратора/);

  const configured = await page.evaluate(() => Boolean(window.__hsk.backendReady()));
  if (!configured) {
    // Без бэкенда форма честно заблокирована, а не «проверяет» локально.
    assert.equal(await page.locator("#adminGateSubmit").isDisabled(), true);
    await context.close();
    return;
  }

  // Исторический PIN не должен открывать панель: решение принимает только сервер,
  // а сервер в тесте отвечает отказом.
  await page.locator("#adminPin").fill("2007");
  await page.locator("#adminGateSubmit").click();
  await page.locator("#adminGateMessage.error").waitFor({ state: "visible" });
  assert.equal(await page.locator("#adminPanel").isVisible(), false);
  assert.equal(await page.locator("#adminGate").isVisible(), true);
  await context.close();
});

test("ошибки входа показываются по-русски", async () => {
  const { context, page } = await open();
  await page.evaluate(() => window.__hsk.showView("settingsView"));
  const cases = [
    [{ message: "User already registered", code: "user_already_exists" }, /уже зарегистрирована/i],
    [{ message: "Invalid login credentials" }, /Неверная почта или пароль/i],
    [{ message: "Password should be at least 6 characters." }, /от 6 символов/i],
    [{ message: "Unable to validate email address: invalid format" }, /опечатка/i],
    [{ message: "Failed to fetch" }, /Нет связи с сервером/i],
    [{ message: "Unsupported provider: provider is not enabled" }, /не подключён/i],
  ];
  for (const [error, expected] of cases) {
    const text = await page.evaluate((e) => window.__hsk.authErrorText(e), error);
    assert.match(text, expected, `для «${error.message}» получили «${text}»`);
    assert.ok(!/[a-z]{4,}/i.test(text.replace(/[а-яё]/gi, "")), `в тексте осталась латиница: ${text}`);
  }
  await context.close();
});

test("кнопка Google появляется только если провайдер включён на сервере", async () => {
  const off = await open({ google: false });
  await off.page.evaluate(() => window.__hsk.showView("settingsView"));
  await off.page.waitForFunction(() => document.getElementById("authGoogle").classList.contains("hidden"));
  assert.equal(await off.page.locator("#authGoogle").isVisible(), false);
  assert.equal(await off.page.locator("#authSignIn").isVisible(), true, "вход по почте должен остаться");
  await off.context.close();

  const on = await open({ google: true });
  await on.page.evaluate(() => window.__hsk.showView("settingsView"));
  await on.page.waitForFunction(() => !document.getElementById("authGoogle").classList.contains("hidden"));
  assert.equal(await on.page.locator("#authGoogle").isVisible(), true);
  await on.context.close();
});

test("без бэкенда вместо нерабочих кнопок входа показывается пояснение", async () => {
  const { context, page } = await open();
  await page.evaluate(() => window.__hsk.showView("settingsView"));
  const configured = await page.evaluate(() => Boolean(window.__hsk.backendReady()));
  if (configured) {
    assert.equal(await page.locator("#signInBlock").isVisible(), true);
    assert.equal(await page.locator("#backendOffBlock").isVisible(), false);
  } else {
    assert.equal(await page.locator("#signInBlock").isVisible(), false);
    assert.equal(await page.locator("#backendOffBlock").isVisible(), true);
    for (const id of ["authGoogle", "authSignIn", "authSignUp", "authMagicLink"]) {
      assert.equal(await page.locator(`#${id}`).isVisible(), false, `${id} не должен быть виден без бэкенда`);
    }
  }
  await context.close();
});

test("во фронтенде нет ни PIN, ни его хеша", () => {
  const files = ["app.js", "index.html", "styles.css", "service-worker.js",
    ...fs.readdirSync(path.join(ROOT, "js")).map((name) => `js/${name}`)];
  const legacyHash = "42e5989796d0368b3b4eb79e65251d2c31610fd9b2d4f3aff5106445e94cb49f";
  for (const file of files) {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    assert.equal(source.includes(legacyHash), false, `в ${file} остался старый хеш PIN`);
    assert.equal(/\b2007\b/.test(source), false, `в ${file} встречается 2007`);
    assert.equal(/bishun-local-admin/.test(source), false, `в ${file} осталась соль старой проверки`);
  }
});

test("поле письма не прокручивает страницу пальцем", async () => {
  const { context, page } = await open({ viewport: { width: 390, height: 844 }, isMobile: true });
  await page.evaluate(() => window.__hsk.startHskLevel("3"));
  await page.locator("#hanziTarget svg").waitFor({ state: "visible", timeout: 15000 });
  const touchAction = await page.evaluate(() => getComputedStyle(document.getElementById("writingBoard")).touchAction);
  assert.equal(touchAction, "none");
  const box = await page.locator("#writingBoard").boundingBox();
  const before = await page.evaluate(() => window.scrollY);
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await page.evaluate(([x, y]) => {
    const board = document.getElementById("writingBoard");
    const touch = (clientY) => new Touch({ identifier: 1, target: board, clientX: x, clientY });
    board.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, cancelable: true, touches: [touch(y)] }));
    board.dispatchEvent(new TouchEvent("touchmove", { bubbles: true, cancelable: true, touches: [touch(y - 120)] }));
    board.dispatchEvent(new TouchEvent("touchend", { bubbles: true, cancelable: true, touches: [] }));
  }, [box.x + box.width / 2, box.y + box.height / 2]);
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => window.scrollY), before);
  await context.close();
});

test("сервис-воркер регистрируется и не трогает пользовательские данные", async () => {
  const { context, page } = await open();
  const registered = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return Boolean(registration);
  });
  assert.equal(registered, true);
  const source = fs.readFileSync(path.join(ROOT, "service-worker.js"), "utf8");
  assert.equal(/localStorage\s*\./.test(source), false, "сервис-воркер не должен трогать localStorage");
  // Версия кэша должна расти при каждом обновлении файлов.
  const version = Number(source.match(/bishun-shell-v(\d+)/)?.[1]);
  assert.ok(version >= 13, `версия кэша оболочки: ${version}`);
  await context.close();
});
