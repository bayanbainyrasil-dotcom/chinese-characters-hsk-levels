// Прогон Lighthouse по локальной копии сайта.
// Запуск: node tests/lighthouse.mjs [--mobile]
import { startServer, CHROME } from "./helpers.mjs";
import { launch } from "chrome-launcher";
import lighthouse from "lighthouse";
import fs from "node:fs";

const mobile = process.argv.includes("--mobile");
const { server, url } = await startServer();
const chrome = await launch({
  chromePath: CHROME,
  chromeFlags: ["--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
});

const result = await lighthouse(url, {
  port: chrome.port,
  output: ["json", "html"],
  logLevel: "error",
  formFactor: mobile ? "mobile" : "desktop",
  screenEmulation: mobile
    ? { mobile: true, width: 390, height: 844, deviceScaleFactor: 2, disabled: false }
    : { mobile: false, width: 1440, height: 900, deviceScaleFactor: 1, disabled: false },
  onlyCategories: ["performance", "accessibility", "best-practices", "seo"],
});

const { lhr } = result;
const scores = Object.fromEntries(
  Object.entries(lhr.categories).map(([key, value]) => [key, Math.round((value.score ?? 0) * 100)]),
);
console.log(`Lighthouse (${mobile ? "мобильный" : "десктоп"}):`, JSON.stringify(scores));

const failed = Object.values(lhr.audits).filter((audit) =>
  audit.score !== null && audit.score < 0.9 && audit.scoreDisplayMode !== "informative");
for (const audit of failed) {
  console.log(`  · ${audit.id}: ${audit.title}${audit.displayValue ? ` — ${audit.displayValue}` : ""}`);
}
fs.writeFileSync(`/tmp/lh-${mobile ? "mobile" : "desktop"}.html`, result.report[1]);
await chrome.kill();
server.close();
