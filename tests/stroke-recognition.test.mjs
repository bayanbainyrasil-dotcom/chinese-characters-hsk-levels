import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startServer, launch, serveStrokeData, stubBackend, STROKE_DATA_DIR } from "./helpers.mjs";

let browser, server, base;

before(async () => {
  ({ server, url: base } = await startServer());
  browser = await launch();
});

after(async () => {
  await browser?.close();
  server?.close();
});

function getStrokeMedians(char) {
  const file = path.join(STROKE_DATA_DIR, `${char}.json`);
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  return data.medians;
}

function calculateScreenPoints(box, median, { jitterX = 0, jitterY = 0, reverse = false, truncateFactor = 1.0 } = {}) {
  const size = box.width;
  const padding = Math.max(10, Math.round(size * 0.045));
  const scale = (size - padding * 2) / 1024;
  let points = median.length > 6 ? median.filter((_, i) => i % 2 === 0 || i === median.length - 1) : median;
  if (truncateFactor < 1.0) {
    const keepCount = Math.max(2, Math.floor(points.length * truncateFactor));
    points = points.slice(0, keepCount);
  }
  if (reverse) points = points.slice().reverse();
  return points.map(([x, y]) => ({
    x: box.x + padding + x * scale + jitterX,
    y: box.y + size - padding - (y + 124) * scale + jitterY,
  }));
}

async function strokePath(page, points, { steps = 3 } = {}) {
  await page.mouse.move(points[0].x, points[0].y);
  await page.mouse.down();
  for (const pt of points.slice(1)) {
    await page.mouse.move(pt.x, pt.y, { steps });
  }
  await page.mouse.up();
  await page.waitForTimeout(100);
}

test("natural slight deviations and tremor are accepted without false rejection", async () => {
  const context = await browser.newContext();
  await serveStrokeData(context);
  await stubBackend(context);
  const page = await context.newPage();

  await page.goto(base);
  await page.waitForFunction(() => window.__hsk);
  await page.evaluate(() => window.__hsk.startSingleCharacter("一"));
  await page.locator("#writingBoard #hanziTarget svg").waitFor({ state: "visible" });

  const box = await page.locator("#writingBoard #hanziTarget svg").boundingBox();
  const medians = getStrokeMedians("一");

  // Чертим с естественным вертикальным дрожанием (jitter) в правильном направлении
  const pointsWithJitter = calculateScreenPoints(box, medians[0], { jitterY: 4 });
  await strokePath(page, pointsWithJitter);

  // Должен появиться класс feedback.success ("Чисто, без ошибок" или "Готово")
  await page.waitForFunction(() => document.querySelector("#feedback").classList.contains("success"), { timeout: 5000 });
  assert.match(await page.locator("#feedback").textContent(), /(Чисто, без ошибок|Готово)/);

  await context.close();
});

test("wrong stroke direction (reverse drawing) is rejected as mistake", async () => {
  const context = await browser.newContext();
  await serveStrokeData(context);
  await stubBackend(context);
  const page = await context.newPage();

  await page.goto(base);
  await page.waitForFunction(() => window.__hsk);
  await page.evaluate(() => window.__hsk.startSingleCharacter("一"));
  await page.locator("#writingBoard #hanziTarget svg").waitFor({ state: "visible" });

  const box = await page.locator("#writingBoard #hanziTarget svg").boundingBox();
  const medians = getStrokeMedians("一");

  // Чертим горизонталь справа налево (реверс)
  const reversePoints = calculateScreenPoints(box, medians[0], { reverse: true });
  await strokePath(page, reversePoints);

  // Должна зафиксироваться ошибка
  await page.waitForFunction(() => document.querySelector("#feedback").classList.contains("error"), { timeout: 5000 });
  assert.match(await page.locator("#feedback").textContent(), /Не та черта/);

  await context.close();
});

test("wrong stroke order is rejected on compound character", async () => {
  const context = await browser.newContext();
  await serveStrokeData(context);
  await stubBackend(context);
  const page = await context.newPage();

  await page.goto(base);
  await page.waitForFunction(() => window.__hsk);
  // Знак 十: первая черта — горизонталь, вторая — вертикаль
  await page.evaluate(() => window.__hsk.startSingleCharacter("十"));
  await page.locator("#writingBoard #hanziTarget svg").waitFor({ state: "visible" });

  const box = await page.locator("#writingBoard #hanziTarget svg").boundingBox();
  const medians = getStrokeMedians("十");

  // Пытаемся нарисовать вертикаль (черта 1) раньше горизонтали (черта 0)
  const verticalFirst = calculateScreenPoints(box, medians[1]);
  await strokePath(page, verticalFirst);

  await page.waitForFunction(() => document.querySelector("#feedback").classList.contains("error"), { timeout: 5000 });
  assert.match(await page.locator("#feedback").textContent(), /Не та черта/);

  await context.close();
});

test("stationary click (tap) is not accepted as a stroke", async () => {
  const context = await browser.newContext();
  await serveStrokeData(context);
  await stubBackend(context);
  const page = await context.newPage();

  await page.goto(base);
  await page.waitForFunction(() => window.__hsk);
  await page.evaluate(() => window.__hsk.startSingleCharacter("一"));
  await page.locator("#writingBoard #hanziTarget svg").waitFor({ state: "visible" });

  const box = await page.locator("#writingBoard #hanziTarget svg").boundingBox();
  // Клик в центр холста без движения
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(300);

  // Знак не должен быть завершён
  assert.equal(await page.locator("#feedback").textContent(), "Напишите иероглиф");

  await context.close();
});

test("excessively short stroke (< 15% distance) is rejected as incomplete", async () => {
  const context = await browser.newContext();
  await serveStrokeData(context);
  await stubBackend(context);
  const page = await context.newPage();

  await page.goto(base);
  await page.waitForFunction(() => window.__hsk);
  await page.evaluate(() => window.__hsk.startSingleCharacter("一"));
  await page.locator("#writingBoard #hanziTarget svg").waitFor({ state: "visible" });

  const box = await page.locator("#writingBoard #hanziTarget svg").boundingBox();
  const medians = getStrokeMedians("一");

  // Чертим только первые 10% черты
  const shortPoints = calculateScreenPoints(box, medians[0], { truncateFactor: 0.1 });
  await strokePath(page, shortPoints);

  // Не должно зачесться как успешное завершение
  assert.doesNotMatch(await page.locator("#feedback").textContent(), /(Чисто, без ошибок|Готово)/);

  await context.close();
});

test("resizing canvas mid-exercise allows finishing remaining strokes cleanly", async () => {
  const context = await browser.newContext({ viewport: { width: 400, height: 800 } });
  await serveStrokeData(context);
  await stubBackend(context);
  const page = await context.newPage();

  await page.goto(base);
  await page.waitForFunction(() => window.__hsk);
  await page.evaluate(() => window.__hsk.startSingleCharacter("十"));
  await page.locator("#writingBoard #hanziTarget svg").waitFor({ state: "visible" });

  let box = await page.locator("#writingBoard #hanziTarget svg").boundingBox();
  const medians = getStrokeMedians("十");

  // Чертим первую черту (горизонталь)
  const stroke1 = calculateScreenPoints(box, medians[0]);
  await strokePath(page, stroke1);
  await page.waitForFunction(() => document.querySelector("#feedback").textContent.includes("осталось 1"), { timeout: 5000 });

  // Изменяем размер вьюпорта (эмуляция поворота планшета)
  await page.setViewportSize({ width: 700, height: 800 });
  await page.waitForTimeout(300);

  // Получаем новые координаты после ресайза
  box = await page.locator("#writingBoard #hanziTarget svg").boundingBox();
  const stroke2 = calculateScreenPoints(box, medians[1]);
  await strokePath(page, stroke2);

  // Знак успешно завершён
  await page.waitForFunction(() => /(Чисто, без ошибок|Готово)/.test(document.querySelector("#feedback").textContent), { timeout: 5000 });
  assert.match(await page.locator("#feedback").textContent(), /(Чисто, без ошибок|Готово)/);

  await context.close();
});
