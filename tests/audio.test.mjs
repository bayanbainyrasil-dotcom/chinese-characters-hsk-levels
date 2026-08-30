// Проверка озвучки: статический пак, автоозвучка после написания,
// правило Safari о первом касании и настройки звука.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer, launch, serveStrokeData, collectErrors, drawCharacter } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AUDIO = path.join(ROOT, "audio");
const TONE = process.env.TONE_MP3 || "/tmp/tone.mp3";

let server, base, browser, created = [];

const hex = (text) => [...Buffer.from(text, "utf8")].map((byte) => byte.toString(16).padStart(2, "0")).join("");

before(async () => {
  ({ server, url: base } = await startServer());
  browser = await launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  // Подкладываем настоящие mp3 для нескольких знаков, чтобы проверить статический путь.
  const sample = fs.readFileSync(TONE);
  const manifest = { note: "тестовый", voice: "test", generatedAt: new Date().toISOString(), ids: [] };
  for (const text of ["一", "十", "人", "安", "汉语"]) {
    for (const dir of ["n", "s"]) {
      const file = path.join(AUDIO, dir, `${hex(text)}.mp3`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, sample);
      created.push(file);
    }
    manifest.ids.push(hex(text));
  }
  fs.writeFileSync(path.join(AUDIO, "manifest.json"), JSON.stringify(manifest, null, 2));
});

after(async () => {
  await browser?.close();
  server?.close();
  for (const file of created) fs.rmSync(file, { force: true });
  fs.writeFileSync(path.join(AUDIO, "manifest.json"), JSON.stringify({
    note: "Список готовых записей. Создаётся скриптом tools/generate-audio.mjs.",
    voice: null, generatedAt: null, ids: [],
  }, null, 2) + "\n");
});

async function open() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await serveStrokeData(context);
  const page = await context.newPage();
  const errors = collectErrors(page);
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.__hsk));
  return { context, page, errors };
}

test("статический пак используется как основной источник", async () => {
  const { context, page, errors } = await open();
  await page.evaluate(() => window.__hsk.audio.unlockAudio());
  const source = await page.evaluate(() => window.__hsk.audio.speak("一"));
  assert.equal(source, "static");
  assert.deepEqual(errors, []);
  await context.close();
});

test("до первого касания автоозвучка молчит — правило Safari", async () => {
  const { context, page } = await open();
  const silent = await page.evaluate(() => window.__hsk.audio.speak("一", { auto: true }));
  assert.equal(silent, "none", "без взаимодействия звук не запускается");
  await page.evaluate(() => window.__hsk.audio.unlockAudio());
  const played = await page.evaluate(() => window.__hsk.audio.speak("一", { auto: true }));
  assert.equal(played, "static");
  await context.close();
});

test("выключенный звук молчит даже по кнопке", async () => {
  const { context, page } = await open();
  await page.evaluate(() => window.__hsk.audio.unlockAudio());
  await page.evaluate(() => window.__hsk.showView("settingsView"));
  await page.locator("#settingMuted").check();
  assert.equal(await page.evaluate(() => window.__hsk.audio.speak("一")), "none");
  await page.locator("#settingMuted").uncheck();
  assert.equal(await page.evaluate(() => window.__hsk.audio.speak("一")), "static");
  await context.close();
});

test("выключенная автоозвучка не мешает ручной кнопке", async () => {
  const { context, page } = await open();
  await page.evaluate(() => window.__hsk.audio.unlockAudio());
  await page.evaluate(() => window.__hsk.showView("settingsView"));
  await page.locator("#settingAutoSpeak").uncheck();
  assert.equal(await page.evaluate(() => window.__hsk.audio.speak("一", { auto: true })), "none");
  assert.equal(await page.evaluate(() => window.__hsk.audio.speak("一")), "static");
  await context.close();
});

test("после правильного написания знак звучит сам — один раз", async () => {
  const { context, page, errors } = await open();
  const played = [];
  await page.exposeFunction("__record", (payload) => played.push(payload));
  await page.evaluate(() => window.__hsk.audio.onAudioState?.((event) => window.__record(event)));
  await page.evaluate(() => window.__hsk.startHskLevel("1-2"));
  await page.locator("#hanziTarget svg").waitFor({ state: "visible", timeout: 15000 });
  const character = await page.locator("#characterLabel").textContent();

  await drawCharacter(page, character);                       // касание = разблокировка звука
  await page.waitForFunction(() => window.__hsk.progress.attempts > 0, null, { timeout: 15000 });
  await page.waitForTimeout(500);

  const starts = played.filter((event) => event.type === "start");
  assert.equal(starts.length, 1, `ожидали одно воспроизведение, получили ${starts.length}`);
  assert.equal(starts[0].text, character);
  assert.equal(starts[0].auto ?? true, true);
  assert.deepEqual(errors, []);
  await context.close();
});

test("при простом открытии страницы звук не играет", async () => {
  const { context, page } = await open();
  const played = [];
  await page.exposeFunction("__record2", (payload) => played.push(payload));
  await page.evaluate(() => window.__hsk.audio.onAudioState?.((event) => window.__record2(event)));
  await page.evaluate(() => window.__hsk.startHskLevel("1-2"));
  await page.locator("#hanziTarget svg").waitFor({ state: "visible", timeout: 15000 });
  await page.waitForTimeout(700);
  assert.equal(played.filter((event) => event.type === "start").length, 0);
  await context.close();
});

test("кнопки обычной и медленной озвучки работают для знака", async () => {
  const { context, page } = await open();
  const requests = [];
  page.on("request", (request) => { if (request.url().includes("/audio/")) requests.push(request.url()); });
  // 安 есть в тестовом паке, поэтому запрос должен уйти именно в audio/
  await page.evaluate(() => window.__hsk.startSingleCharacter("安"));
  await page.locator("#hanziTarget svg").waitFor({ state: "visible", timeout: 15000 });
  await page.waitForFunction(() => document.getElementById("characterLabel").textContent === "安");
  await page.locator("#charSpeak").click();
  await page.waitForFunction(
    () => performance.getEntriesByType("resource").some((entry) => entry.name.includes("/audio/n/")),
    null, { timeout: 10000 },
  );
  await page.locator("#charSpeakSlow").click();
  await page.waitForFunction(
    () => performance.getEntriesByType("resource").some((entry) => entry.name.includes("/audio/s/")),
    null, { timeout: 10000 },
  );
  assert.ok(requests.some((url) => url.includes("/audio/n/")), "обычная скорость берётся из audio/n");
  assert.ok(requests.some((url) => url.includes("/audio/s/")), "медленная — из audio/s");
  await context.close();
});

test("в карточке слова озвучивается слово и каждый знак", async () => {
  const { context, page } = await open();
  await page.evaluate(() => window.__hsk.audio.unlockAudio());
  const requests = [];
  page.on("request", (request) => { if (request.url().includes("/audio/")) requests.push(request.url()); });
  await page.evaluate(() => window.__hsk.openWordCard({ word: "汉语", pinyin: "Hànyǔ", russian: "китайский язык", level: "1" }, {}));
  await page.locator(".word-sheet-panel").waitFor({ state: "visible" });
  await page.locator("#wordSheetPlay").click();
  await page.waitForTimeout(350);
  assert.ok(requests.some((url) => url.includes(`/audio/n/${[...Buffer.from("汉语","utf8")].map((b)=>b.toString(16).padStart(2,"0")).join("")}.mp3`)),
    "слово озвучивается целиком");
  await page.locator("#wordSheetPlaySlow").click();
  await page.waitForTimeout(350);
  assert.ok(requests.some((url) => url.includes("/audio/s/")), "есть медленное произношение слова");
  await context.close();
});

test("аудио следующего знака подгружается заранее", async () => {
  const { context, page } = await open();
  const requests = [];
  page.on("request", (request) => { if (request.url().includes("/audio/")) requests.push(request.url()); });
  await page.evaluate(() => window.__hsk.startHskLevel("1-2"));
  await page.locator("#hanziTarget svg").waitFor({ state: "visible", timeout: 15000 });
  await page.waitForTimeout(600);
  assert.ok(requests.length >= 1, "предзагрузка обращается к паку");
  await context.close();
});

test("генератор и браузер считают одинаковые имена файлов", async () => {
  const { audioId } = await import(path.join(ROOT, "tools/generate-audio.mjs"));
  const { context, page } = await open();
  for (const text of ["一", "汉语", "中华人民"]) {
    const inBrowser = await page.evaluate((value) => window.__hsk.audio.audioId(value), text);
    assert.equal(inBrowser, audioId(text), `идентификатор для ${text}`);
  }
  await context.close();
});
