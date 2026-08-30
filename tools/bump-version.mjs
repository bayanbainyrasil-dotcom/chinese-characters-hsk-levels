#!/usr/bin/env node
/**
 * Поднимает версию кэша сервис-воркера и параметры ?v= в index.html,
 * чтобы устройства получили новые файлы. Данные пользователей не трогает.
 *
 * Запуск: node tools/bump-version.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");

function read(file) { return fs.readFileSync(path.join(ROOT, file), "utf8"); }
function write(file, text) { fs.writeFileSync(path.join(ROOT, file), text); }

// 1. service-worker.js: bishun-shell-vN -> bishun-shell-v(N+1)
let sw = read("service-worker.js");
const current = Number(sw.match(/bishun-shell-v(\d+)/)?.[1] ?? 0);
const next = current + 1;
sw = sw.replace(/bishun-shell-v\d+/, `bishun-shell-v${next}`);
write("service-worker.js", sw);

// 2. index.html: ?v=... у стилей и скрипта
let html = read("index.html");
let revision = 1;
const previous = html.match(/styles\.css\?v=(\d{8})-(\d+)/);
if (previous && previous[1] === stamp) revision = Number(previous[2]) + 1;
const version = `${stamp}-${revision}`;
html = html.replace(/styles\.css\?v=[^"]+/, `styles.css?v=${version}`);
html = html.replace(/app\.js\?v=[^"]+/, `app.js?v=${version}`);
write("index.html", html);

// 3. js/config.js: appVersion
let config = read("js/config.js");
config = config.replace(/appVersion: "[^"]*"/, `appVersion: "${version}"`);
write("js/config.js", config);

console.log(`Кэш оболочки: bishun-shell-v${current} -> bishun-shell-v${next}`);
console.log(`Версия файлов: ${version}`);
console.log("Не забудьте закоммитить изменения.");
