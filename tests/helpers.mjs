// Общая обвязка для e2e: локальный сервер, браузер и подмена данных о чертах.
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const STROKE_DATA_DIR = process.env.HANZI_DATA || "/tmp/hwd/package";
export const CHROME = process.env.CHROME_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".mp3": "audio/mpeg", ".webmanifest": "application/manifest+json",
  ".xml": "application/xml", ".txt": "text/plain; charset=utf-8",
};

export function startServer(port = 0) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    let file = path.join(ROOT, decodeURIComponent(url.pathname));
    if (url.pathname.endsWith("/")) file = path.join(file, "index.html");
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      response.writeHead(404); response.end("not found"); return;
    }
    response.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(response);
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` }));
  });
}

export async function launch(options = {}) {
  return chromium.launch({ executablePath: CHROME, ...options });
}

/** Данные о чертах в контейнере недоступны из сети — отдаём их с диска. */
export async function serveStrokeData(context) {
  await context.route("**/hanzi-writer-data*/**", async (route) => {
    const name = decodeURIComponent(route.request().url().split("/").pop());
    const file = path.join(STROKE_DATA_DIR, name);
    if (fs.existsSync(file)) {
      await route.fulfill({ status: 200, contentType: "application/json", body: fs.readFileSync(file, "utf8") });
    } else {
      await route.fulfill({ status: 404, body: "{}" });
    }
  });
}

/**
 * Тесты не должны ходить в настоящий Supabase: сеть в CI недоступна, а результат
 * не должен зависеть от того, заполнен config.js или нет. Отвечаем как живой
 * сервер, но всегда отказом — так проверяется, что фронтенд ничего не решает сам.
 */
/**
 * Короткая тишина в mp3, собранная из кадров MPEG-1 Layer III (128 кбит/с,
 * 44,1 кГц). Держать в репозитории бинарник ради тестов незачем, а внешний
 * файл в /tmp делал бы прогон зависимым от машины.
 */
export function silentMp3(frames = 12) {
  const FRAME = 417;
  const out = Buff...alloc(FRAME * frames);
  for (let i = 0; i < frames; i += 1) {
    const at = i * FRAME;
    out[at] = 0xff; out[at + 1] = 0xfb; out[at + 2] = 0x90; out[at + 3] = 0x64;
  }
  return out;
}

export async function stubBackend(context, { adminStatus = 401, google = true } = {}) {
  const tone = silentMp3();
  await context.route("**://*.supabase.co/**", async (route) => {
    const url = route.request().url();
    if (url.includes("/storage/v1/object/public/")) {
      // Запись есть: приложение обращается сюда только за тем, что в списке готовых.
      return route.fulfill({ status: 200, contentType: "audio/mpeg", body: tone });
    }
    if (url.includes("/auth/v1/settings")) {
      return route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ external: { email: true, google }, disable_signup: false }) });
    }
    if (url.includes("/functions/v1/admin-auth")) {
      return route.fulfill({ status: adminStatus, contentType: "application/json",
        body: JSON.stringify({ error: "invalid", attemptsLeft: 4 }) });
    }
    if (url.includes("/functions/v1/admin-edits")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ edits: [] }) });
    }
    if (url.includes("/functions/v1/tts")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ url: null }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
}

export function collectErrors(page) {
  const errors = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

/**
 * Пишет знак по-настоящему: ведёт указателем по срединным линиям черт,
 * как это делает палец, Apple Pencil или мышка.
 */
export async function drawCharacter(page, character) {
  const data = JSON.parse(fs.readFileSync(path.join(STROKE_DATA_DIR, `${character}.json`), "utf8"));
  const box = await page.locator("#hanziTarget svg").boundingBox();
  if (!box) throw new Error("холст письма не найден");
  const size = box.width;
  const padding = Math.max(10, Math.round(size * 0.045));
  const scale = (size - padding * 2) / 1024;
  const toScreen = ([x, y]) => ({
    x: box.x + padding + x * scale,
    y: box.y + size - padding - y * scale,
  });
  for (const median of data.medians) {
    const points = median.length > 6 ? median.filter((_, index) => index % 2 === 0 || index === median.length - 1) : median;
    const first = toScreen(points[0]);
    await page.mouse.move(first.x, first.y);
    await page.mouse.down();
    for (const point of points.slice(1)) {
      const screen = toScreen(point);
      await page.mouse.move(screen.x, screen.y, { steps: 2 });
    }
    await page.mouse.up();
    await page.waitForTimeout(60);
  }
}

export const LEGACY_PROGRESS = {
  version: 1,
  completed: {
    strokes: { heng: 1, shu: 1 },
    rules: { "rule-三": 1 },
    radicals: { "rad-1": 1 },
    hsk: { "3:安": 5, "3:把": 3, "1-2:八": 2 },
  },
  attempts: 42,
  cleanAttempts: 18,
  days: ["2026-08-01", "2026-08-02", "2026-08-15"],
  lastSession: { kind: "hsk", level: "3", title: "Письмо HSK 3" },
};
