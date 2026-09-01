#!/usr/bin/env node
/**
 * Список знаков, для которых запись уже лежит в Supabase Storage.
 *
 * Нужен, чтобы приложение не гадало: без него оно на каждый незнакомый знак
 * получало бы 404 и сорило в консоль. Со списком готовая запись забирается
 * одним запросом напрямую, а функция озвучки дёргается только для остального.
 *
 * Запуск: node tools/build-tts-manifest.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const writing = JSON.parse(fs.readFileSync(path.join(ROOT, "data/writing.json"), "utf8"));
const chars = [];
for (const group of Object.values(writing.groups ?? {})) {
  for (const item of group) if (item.char && !chars.includes(item.char)) chars.push(item.char);
}

const manifest = {
  note: "Знаки, озвучка которых уже создана и лежит в Supabase Storage.",
  bucket: "tts-audio",
  rates: ["n", "s"],
  builtAt: new Date().toISOString(),
  // Храним сами знаки, а не hex: втрое меньше веса, имя файла считает клиент.
  chars: chars.sort().join(""),
};

const out = path.join(ROOT, "data/tts-ready.json");
fs.writeFileSync(out, JSON.stringify(manifest) + "\n");
console.log(`Готово: ${[...manifest.chars].length} знаков -> data/tts-ready.json`);
