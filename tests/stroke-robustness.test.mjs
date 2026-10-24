// Распознавание письма на синтетических траекториях.
// Выводы относятся только к этой выборке знаков, сидов и моделей движения;
// это не доказательство правильной работы с любым почерком.
//
// Модель руки: срединная линия черты уплотняется до точек через ~6 px,
// к каждой точке добавляется своё отклонение — медленный «дрейф» (случайное
// блуждание с затуханием) плюс мелкая дрожь. Генератор с сидом, поэтому
// прогон воспроизводим. Каждое касание классифицируется по реакции
// приложения: принято (Верно/Готово), промах (Не та черта) или проигнорировано.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startServer, launch, serveStrokeData, stubBackend, STROKE_DATA_DIR } from "./helpers.mjs";

let server, base, browser;
before(async () => { ({ server, url: base } = await startServer()); browser = await launch(); });
after(async () => { await browser?.close(); server?.close(); });

// Знаки подобраны по типам черт: 横 竖 撇 捺 点, 折 (口), 横折弯钩 (九),
// 竖钩 (小), 卧钩 (心), 提 и 斜钩 (我).
const CHARS = ["一", "十", "人", "口", "九", "小", "心", "我"];
const SEEDS = (process.env.HSK_STROKE_SEEDS || "11,29,47").split(",").map(Number);

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const medians = (char) => JSON.parse(fs.readFileSync(path.join(STROKE_DATA_DIR, `${char}.json`), "utf8")).medians;

function toScreen(box, [x, y]) {
  const size = box.width;
  const padding = Math.max(10, Math.round(size * 0.045));
  const scale = (size - padding * 2) / 1024;
  return { x: box.x + padding + x * scale, y: box.y + size - padding - (y + 124) * scale };
}

function length(points) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  return total;
}

/** Уплотняет ломаную до точек примерно через step пикселей. */
function densify(points, step = 6) {
  const out = [points[0]];
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1], b = points[i];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let k = 1; k <= n; k += 1) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  return out;
}

/** Обрезает траекторию по доле её геометрической длины (а не числа точек). */
function truncateByLength(points, fraction) {
  const target = length(points) * fraction;
  const out = [points[0]];
  let run = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1], b = points[i];
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (run + seg >= target) {
      const t = (target - run) / seg;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      return out;
    }
    run += seg; out.push(b);
  }
  return out;
}

/** Своё отклонение у каждой точки: дрейф + дрожь (амплитуды в пикселях). */
function tremor(points, rand, { drift = 5, shake = 1.5 } = {}) {
  let dx = 0, dy = 0;
  return points.map((p, i) => {
    dx = dx * 0.85 + (rand() - 0.5) * drift * 0.6;
    dy = dy * 0.85 + (rand() - 0.5) * drift * 0.6;
    dx = Math.max(-drift, Math.min(drift, dx));
    dy = Math.max(-drift, Math.min(drift, dy));
    const edge = i === 0 || i === points.length - 1 ? 0.5 : 1; // концы руки дрожат меньше
    return { x: p.x + edge * (dx + (rand() - 0.5) * shake * 2), y: p.y + edge * (dy + (rand() - 0.5) * shake * 2) };
  });
}

async function open() {
  const context = await browser.newContext({ viewport: { width: 900, height: 1000 } });
  await serveStrokeData(context);
  await stubBackend(context);
  const page = await context.newPage();
  await page.goto(base);
  await page.waitForFunction(() => window.__hsk);
  return { context, page };
}

async function startChar(page, char) {
  await page.evaluate((c) => window.__hsk.startSingleCharacter(c), char);
  await page.locator("#writingBoard #hanziTarget svg").waitFor({ state: "visible" });
  await page.waitForFunction(() => !document.getElementById("retryButton").disabled);
  await page.locator("#hanziTarget").scrollIntoViewIfNeeded();
  // журнал реакций приложения на каждое касание
  await page.evaluate(() => {
    window.__fb = [];
    const el = document.getElementById("feedback");
    window.__fbObs?.disconnect();
    window.__fbObs = new MutationObserver(() => window.__fb.push(el.textContent));
    window.__fbObs.observe(el, { childList: true, characterData: true, subtree: true });
  });
  return page.locator("#writingBoard #hanziTarget svg").boundingBox();
}

/** Проводит касание и возвращает реакцию: accepted | mistake | ignored. */
async function touch(page, points) {
  const before = await page.evaluate(() => window.__fb.length);
  await page.mouse.move(points[0].x, points[0].y);
  await page.mouse.down();
  for (const p of points.slice(1)) await page.mouse.move(p.x, p.y);
  await page.mouse.up();
  await page.waitForTimeout(80);
  try {
    await page.waitForFunction((n) => window.__fb.length > n, before, { timeout: 450 });
  } catch (_) { return "ignored"; }
  await page.waitForTimeout(150); // итог знака приходит сразу после «Готово»
  const texts = await page.evaluate((n) => window.__fb.slice(n), before);
  if (texts.some((t) => /^Верно|^Готово|^Чисто, без ошибок|^Написано/.test(t))) return "accepted";
  if (texts.some((t) => /^Не та черта/.test(t))) return "mistake";
  return `other:${texts.join(" / ")}`;
}

test("синтетическая выборка: ложные отказы и ложные зачёты по типам черт", async () => {
  const { context, page } = await open();
  const stats = { correct: 0, falseReject: [], negative: 0, falseAccept: [] };

  for (const seed of SEEDS) {
    const rand = mulberry32(seed);
    for (const char of CHARS) {
      const box = await startChar(page, char);
      const strokes = medians(char).map((m) => densify(m.map((p) => toScreen(box, p))));
      for (let i = 0; i < strokes.length; i += 1) {
        const path = strokes[i];
        const long = length(path) > 40; // направление и обрезка осмысленны только у длинных черт
        const negatives = [];
        if (long) {
          negatives.push(["обратное направление", tremor([...path].reverse(), rand)]);
          negatives.push(["10% длины", truncateByLength(path, 0.1)]);
        }
        if (i + 1 < strokes.length && length(strokes[i + 1]) > 40) negatives.push(["нарушение порядка", tremor(strokes[i + 1], rand)]);
        const c = { x: box.x + box.width * (0.2 + rand() * 0.6), y: box.y + box.height * (0.2 + rand() * 0.6) };
        negatives.push(["касание на месте", [c, { x: c.x + 0.5, y: c.y }]]);
        negatives.push(["случайный мазок 3 px", [c, { x: c.x + 2, y: c.y + 2 }]]);
        for (const [kind, pts] of negatives) {
          stats.negative += 1;
          const result = await touch(page, pts);
          if (result === "accepted") stats.falseAccept.push(`${char}#${i + 1} ${kind} seed ${seed}`);
          if (result === "accepted") break; // знак сдвинулся — дальше этот штрих не проверить честно
        }
        if (stats.falseAccept.some((f) => f.startsWith(`${char}#${i + 1} `) && f.endsWith(`seed ${seed}`))) continue;
        stats.correct += 1;
        const result = await touch(page, tremor(path, rand));
        if (result !== "accepted") stats.falseReject.push(`${char}#${i + 1} → ${result} seed ${seed}`);
        if (result !== "accepted") break;
      }
    }
  }
  console.log(`# выборка: ${CHARS.length} знаков × ${SEEDS.length} сидов; верных черт ${stats.correct}, неверных касаний ${stats.negative}`);
  console.log(`# ложные отказы: ${stats.falseReject.length}; ложные зачёты: ${stats.falseAccept.length}`);
  assert.deepEqual(stats.falseReject, [], "верные черты с дрожанием руки не отклоняются");
  assert.deepEqual(stats.falseAccept, [], "неверные касания не засчитываются");
  await context.close();
});

test("обрезка по геометрической длине действительно даёт 10% длины", () => {
  // Самопроверка модели: на неравномерной ломаной обрезка по числу точек и по длине расходятся.
  const pts = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 100, y: 0 }];
  const cut = truncateByLength(pts, 0.1);
  assert.ok(Math.abs(length(cut) - 10) < 1e-9);
  const byCount = pts.slice(0, Math.max(2, Math.floor(pts.length * 0.1)));
  assert.notEqual(Math.round(length(byCount)), 10, "старый truncateFactor резал не по длине");
});

test("чистое письмо после серии промахов засчитывается с ошибками, а не как чистое", async () => {
  const { context, page } = await open();
  const box = await startChar(page, "十");
  const strokes = medians("十").map((m) => densify(m.map((p) => toScreen(box, p))));
  assert.equal(await touch(page, [...strokes[0]].reverse()), "mistake");
  assert.equal(await touch(page, strokes[0]), "accepted");
  assert.equal(await touch(page, strokes[1]), "accepted");
  await page.waitForFunction(() => /Написано · ошибок: 1/.test(document.getElementById("feedback").textContent), null, { timeout: 3000 });
  const progress = await page.evaluate(() => window.__hsk.progress);
  assert.equal(progress.attempts, 1);
  assert.equal(progress.cleanAttempts, 0, "попытка с промахом не считается чистой");
  await context.close();
});
