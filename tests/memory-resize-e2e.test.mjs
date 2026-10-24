// Письмо по памяти (memoryBoard, js/review-session.js) при повороте экрана.
// Отдельно от теста свободного письма (writingBoard) в stroke-recognition.test.mjs.
// Окно Chromium меняет размер — это эмуляция поворота, не настоящий iPad.
// Замечание: в Chromium HanziWriter учитывает CSS-масштаб холста, поэтому и без
// пересчёта размеров черты после поворота принимаются. Тест проверяет
// пересчёт (холст = полю) как заявленное поведение и всё остальное — как защиту.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startServer, launch, serveStrokeData, stubBackend, collectErrors, STROKE_DATA_DIR } from "./helpers.mjs";

const CHAR = "口"; // три черты, вторая — излом (横折)
const LANDSCAPE = { width: 844, height: 390 };
const PORTRAIT = { width: 320, height: 700 };

let server, base, browser;
const writing = JSON.parse(fs.readFileSync(new URL("../data/writing.json", import.meta.url)));
const row = Object.values(writing.groups).flat().find((r) => r.char === CHAR);
const medians = JSON.parse(fs.readFileSync(path.join(STROKE_DATA_DIR, `${CHAR}.json`), "utf8")).medians;

before(async () => { ({ server, url: base } = await startServer()); browser = await launch(); });
after(async () => { await browser?.close(); server?.close(); });

async function open(viewport) {
  const context = await browser.newContext({ viewport });
  await serveStrokeData(context);
  await stubBackend(context);
  await context.route("**/data/writing.json", (r) => r.fulfill({ json: { ...writing, groups: { "1-2": [row] } } }));
  const page = await context.newPage();
  const errors = collectErrors(page);
  // Учёт наблюдателей: сколько ResizeObserver создано и сколько раз наблюдают memoryBoard.
  await page.addInitScript(() => {
    const Native = window.ResizeObserver;
    window.__ro = { created: 0, memoryObserved: 0, memoryUnobserved: 0 };
    window.ResizeObserver = class extends Native {
      constructor(cb) { super(cb); window.__ro.created += 1; }
      observe(el, o) { if (el?.id === "memoryBoard") window.__ro.memoryObserved += 1; return super.observe(el, o); }
      unobserve(el) { if (el?.id === "memoryBoard") window.__ro.memoryUnobserved += 1; return super.unobserve(el); }
    };
    if (!localStorage.getItem("bishun_hsk30_progress_v1")) {
      // знак уже отрабатывался раньше — значит, сразу режим «вспомни»
      localStorage.setItem("bishun_hsk30_progress_v1", JSON.stringify({ completed: { hsk: { "1-2:口": 5 } } }));
    }
  });
  await page.goto(base);
  await page.waitForFunction(() => window.__hsk);
  await page.locator("#memoryOpen").click();
  await page.locator("#memoryStart").waitFor();
  return { context, page, errors };
}

async function startExercise(page) {
  await page.locator("#memoryStart").click();
  await page.locator("#memoryHelp:not([disabled])").waitFor();
  assert.equal(await page.evaluate(() => window.__hsk.memory.pending.char), CHAR);
  assert.notEqual(await page.evaluate(() => window.__hsk.memory.pending.mode), "practice");
}

async function svgBox(page) {
  const box = await page.locator("#memoryTarget svg").boundingBox();
  const attr = await page.locator("#memoryTarget svg").evaluate((s) => Number(s.getAttribute("width")));
  return { ...box, attr };
}

/** Ведёт одну черту по срединной линии в текущих экранных координатах SVG. */
async function stroke(page, index) {
  await page.locator("#memoryTarget").scrollIntoViewIfNeeded();
  const box = await svgBox(page);
  const size = box.width;
  const padding = Math.max(10, Math.round(size * 0.045));
  const scale = (size - padding * 2) / 1024;
  const pts = medians[index].map(([x, y]) => ({ x: box.x + padding + x * scale, y: box.y + size - padding - (y + 124) * scale }));
  await page.mouse.move(pts[0].x, pts[0].y);
  await page.mouse.down();
  for (const p of pts.slice(1)) await page.mouse.move(p.x, p.y, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(450); // анимация принятой черты
}

/** Сколько черт знака сейчас видно на поле (квиз показывает только верно написанные). */
async function visibleStrokes(page) {
  return page.locator("#memoryTarget svg").evaluate((svg) => {
    // У HanziWriter: группа контура, группа основного знака, группа подсветки; черты — path внутри.
    const groups = [...svg.querySelectorAll(":scope > g > g")];
    const main = groups[1];
    if (!main) return -1;
    return [...main.querySelectorAll("path")].filter((p) => {
      let o = 1;
      for (let n = p; n && n !== svg; n = n.parentElement) o *= Number(getComputedStyle(n).opacity || 1);
      return o > 0.5;
    }).length;
  });
}

async function rotate(page, viewport) {
  await page.setViewportSize(viewport);
  // ResizeObserver срабатывает после раскладки
  await page.waitForFunction(() => {
    const board = document.getElementById("memoryBoard").getBoundingClientRect().width;
    const svg = document.querySelector("#memoryTarget svg");
    return svg && Math.abs(Number(svg.getAttribute("width")) - Math.max(220, Math.min(360, board))) < 2;
  });
  await page.waitForTimeout(100);
}

async function answers(page) {
  return page.evaluate(async () => (await window.__hsk.memory.store.events()).filter((e) => e.kind === "answer"));
}

test("memoryBoard: поворот посреди письма сохраняет написанное, попытку и точность координат", async () => {
  const { context, page, errors } = await open(LANDSCAPE);
  await startExercise(page);
  const before = await svgBox(page);
  const attemptId = await page.evaluate(() => window.__hsk.memory.pending.id);

  await stroke(page, 0);
  assert.equal(await visibleStrokes(page), 1, "первая черта принята");

  // поворот в узкий портрет: поле сжимается
  await rotate(page, PORTRAIT);
  const portrait = await svgBox(page);
  assert.ok(portrait.attr < before.attr - 20, `SVG пересчитан: ${before.attr} → ${portrait.attr}`);
  assert.ok(Math.abs(portrait.width - portrait.attr) < 1, "SVG не растянут CSS — экран и холст совпадают");
  const boardWidth = await page.locator("#memoryBoard").evaluate((b) => b.getBoundingClientRect().width);
  assert.ok(portrait.width <= boardWidth + 0.5, "холст не вылезает за поле");
  assert.equal(await visibleStrokes(page), 1, "написанная черта осталась после поворота");
  let pending = await page.evaluate(() => window.__hsk.memory.pending);
  assert.equal(pending.id, attemptId, "та же попытка");
  assert.equal(pending.mistakes, 0, "поворот не засчитан промахом");
  assert.equal(pending.assisted, false);

  // повторный ресайз туда-обратно
  await rotate(page, LANDSCAPE);
  await rotate(page, PORTRAIT);
  assert.equal(await visibleStrokes(page), 1, "после повторного поворота");

  // дописываем знак в новых координатах
  await stroke(page, 1);
  await stroke(page, 2);
  await page.locator("#memoryGrade:not(.hidden)").waitFor({ timeout: 5000 });
  pending = await page.evaluate(() => window.__hsk.memory.pending);
  assert.equal(pending.mistakes, 0, "черты после поворота попали точно — ни одного промаха");
  assert.equal(await page.locator("#memoryGood").isEnabled(), true);

  // двойной клик по оценке — результат сохраняется один раз
  await page.locator("#memoryGood").dblclick();
  await page.locator("#memoryNext:not(.hidden)").waitFor();
  let saved = await answers(page);
  assert.equal(saved.length, 1, "ровно одно сохранение");
  assert.equal(saved[0].id, attemptId);
  assert.equal(saved[0].grade, "good");
  assert.equal(saved[0].assisted, false);
  assert.equal(saved[0].mistakes, 0);

  await page.reload();
  await page.waitForFunction(() => window.__hsk);
  saved = await page.evaluate(async () => (await window.__hsk.memory.store.events()).filter((e) => e.kind === "answer"));
  assert.equal(saved.length, 1, "после перезагрузки тоже одно");
  assert.deepEqual(errors, []);
  await context.close();
});

test("memoryBoard: уход из упражнения и возвращение — подсказка не теряется, наблюдатели не множатся", async () => {
  const { context, page, errors } = await open(PORTRAIT);
  await startExercise(page);
  const attemptId = await page.evaluate(() => window.__hsk.memory.pending.id);

  // подсказка-история: попытка становится тренировкой
  await page.locator("#memoryStoryHint").click();
  await page.waitForFunction(() => window.__hsk.memory.pending.assisted === true);
  await stroke(page, 0);
  await rotate(page, LANDSCAPE);

  // уходим на главную посреди письма; поворот без активного упражнения не должен ничего ломать
  for (let i = 0; i < 3; i += 1) {
    await page.locator("#memoryView [data-back-home]").click();
    await page.waitForFunction(() => document.body.dataset.view === "homeView" || !document.getElementById("homeView").classList.contains("hidden"));
    await page.setViewportSize(i % 2 ? LANDSCAPE : PORTRAIT);
    await page.waitForTimeout(150);
    await page.locator("#memoryOpen").click();
    await page.locator("#memoryResume").click();
    await page.locator("#memoryHelp:not([disabled])").waitFor();
  }
  const ro = await page.evaluate(() => window.__ro);
  assert.equal(ro.memoryObserved, 1, `memoryBoard наблюдается одним наблюдателем: ${JSON.stringify(ro)}`);

  const pending = await page.evaluate(() => window.__hsk.memory.pending);
  assert.equal(pending.id, attemptId, "возвращение продолжает ту же попытку");
  assert.equal(pending.assisted, true, "признак подсказки сохранён");
  assert.ok(pending.hintStage >= 1);

  // после возвращения поле создаётся заново под текущий размер
  const box = await svgBox(page);
  const boardWidth = await page.locator("#memoryBoard").evaluate((b) => b.getBoundingClientRect().width);
  assert.ok(Math.abs(box.attr - Math.max(220, Math.min(360, boardWidth))) < 2);
  for (let i = 0; i < medians.length; i += 1) await stroke(page, i);
  await page.locator("#memoryGrade:not(.hidden)").waitFor({ timeout: 5000 });
  assert.equal(await page.locator("#memoryGood").isDisabled(), true, "с подсказкой «Вспомнил сам» недоступно");
  await page.locator("#memoryAgain").click();
  await page.locator("#memoryNext:not(.hidden)").waitFor();
  const saved = await answers(page);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].assisted, true, "в сохранённом ответе подсказка отмечена");
  assert.deepEqual(errors, []);
  await context.close();
});

test("подсказка, нажатая перед последней чертой, не даёт засчитать самостоятельный успех", async () => {
  const { context, page, errors } = await open(PORTRAIT);
  await startExercise(page);
  for (let i = 0; i < medians.length - 1; i += 1) await stroke(page, i);
  // замедляем запись подсказки в IndexedDB, чтобы последняя черта и оценка успели раньше
  await page.evaluate(() => {
    const store = window.__hsk.memory.store;
    const original = store.patchPending.bind(store);
    store.patchPending = async (...args) => { await new Promise((r) => setTimeout(r, 800)); return original(...args); };
  });
  await page.locator("#memoryStoryHint").click();
  await stroke(page, medians.length - 1);
  await page.locator("#memoryGrade:not(.hidden)").waitFor({ timeout: 5000 });
  if (await page.locator("#memoryGood").isEnabled()) await page.locator("#memoryGood").click({ timeout: 1000 }).catch(() => {});
  await page.waitForFunction(() => window.__hsk.memory.pending?.assisted === true || document.getElementById("memoryNext").offsetParent !== null, null, { timeout: 5000 });
  await page.waitForTimeout(900);
  let saved = await answers(page);
  assert.ok(saved.every((e) => e.assisted === true), `ни одного чистого успеха после подсказки: ${JSON.stringify(saved)}`);
  if (!saved.length) {
    assert.equal(await page.evaluate(() => window.__hsk.memory.pending.assisted), true);
    assert.equal(await page.locator("#memoryGood").isDisabled(), true, "после записи подсказки «Вспомнил сам» заблокирована");
    await page.locator("#memoryAgain").click();
    await page.locator("#memoryNext:not(.hidden)").waitFor();
    saved = await answers(page);
  }
  assert.equal(saved.length, 1);
  assert.equal(saved[0].assisted, true);
  assert.deepEqual(errors, []);
  await context.close();
});
