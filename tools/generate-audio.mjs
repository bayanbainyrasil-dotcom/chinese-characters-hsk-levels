#!/usr/bin/env node
/**
 * Генератор статического аудиопака.
 *
 * Складывает mp3 в audio/n (обычная скорость) и audio/s (медленная),
 * имя файла — hex от слова в UTF-8, ровно как считает js/audio.js.
 * Уже готовые файлы пропускаются, поэтому запуск можно прерывать и повторять.
 *
 * Движки:
 *   edge    — нейронные голоса Microsoft Edge, бесплатно и без ключа.
 *             Нужен CLI: pip install edge-tts
 *   azure   — Azure Speech. AZURE_SPEECH_KEY, AZURE_SPEECH_REGION
 *   openai  — OpenAI TTS. OPENAI_API_KEY
 *   google  — Google Cloud TTS. GOOGLE_TTS_KEY
 *
 * Примеры:
 *   node tools/generate-audio.mjs --engine edge                 # знаки и примеры
 *   node tools/generate-audio.mjs --engine edge --scope all     # плюс весь словарь
 *   node tools/generate-audio.mjs --engine azure --only-missing
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AUDIO = path.join(ROOT, "audio");

const args = parseArgs(process.argv.slice(2));
const ENGINE = args.engine ?? "edge";
const SCOPE = args.scope ?? "writing";          // writing | all
const VOICE = args.voice ?? defaultVoice(ENGINE);
const CONCURRENCY = Number(args.concurrency ?? 4);
const LIMIT = Number(args.limit ?? 0);          // 0 — без ограничения
const RATES = args.rates ? args.rates.split(",") : ["normal", "slow"];

function parseArgs(list) {
  const out = {};
  for (let index = 0; index < list.length; index += 1) {
    const token = list[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = list[index + 1];
    if (!next || next.startsWith("--")) out[key] = true;
    else { out[key] = next; index += 1; }
  }
  return out;
}

function defaultVoice(engine) {
  if (engine === "edge" || engine === "azure") return "zh-CN-XiaoxiaoNeural";
  if (engine === "google") return "cmn-CN-Wavenet-A";
  return "alloy";
}

export function audioId(text) {
  return [...Buffer.from(String(text).trim(), "utf8")].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function collectTexts() {
  const writing = JSON.parse(fs.readFileSync(path.join(ROOT, "data/writing.json"), "utf8"));
  const texts = new Set();
  for (const group of Object.values(writing.groups)) {
    for (const row of group) {
      texts.add(row.char);
      for (const example of row.examples ?? []) if (example[0]) texts.add(example[0]);
    }
  }
  if (SCOPE === "all") {
    const vocabulary = JSON.parse(fs.readFileSync(path.join(ROOT, "data/vocabulary.json"), "utf8"));
    for (const row of vocabulary.rows) texts.add(row[2]);
  }
  return [...texts].filter((text) => /^[㐀-䶿一-鿿豈-﫿]+$/u.test(text));
}

async function synthesize(text, slow) {
  if (ENGINE === "edge") return viaEdgeCli(text, slow);
  if (ENGINE === "azure") return viaAzure(text, slow);
  if (ENGINE === "openai") return viaOpenAI(text, slow);
  if (ENGINE === "google") return viaGoogle(text, slow);
  throw new Error(`неизвестный движок: ${ENGINE}`);
}

function viaEdgeCli(text, slow) {
  return new Promise((resolve, reject) => {
    const file = path.join(AUDIO, `.tmp-${process.pid}-${Math.random().toString(36).slice(2)}.mp3`);
    const child = spawn("edge-tts", [
      "--voice", VOICE,
      "--rate", slow ? "-40%" : "+0%",
      "--text", text,
      "--write-media", file,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => reject(new Error(
      error.code === "ENOENT" ? "edge-tts не найден. Установите: pip install edge-tts" : String(error),
    )));
    child.on("close", (code) => {
      if (code !== 0) { reject(new Error(stderr.trim() || `edge-tts вернул ${code}`)); return; }
      try {
        const buffer = fs.readFileSync(file);
        fs.unlinkSync(file);
        resolve(buffer);
      } catch (error) { reject(error); }
    });
  });
}

async function viaAzure(text, slow) {
  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;
  if (!key || !region) throw new Error("нужны AZURE_SPEECH_KEY и AZURE_SPEECH_REGION");
  const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN">`
    + `<voice name="${VOICE}"><prosody rate="${slow ? "-40%" : "0%"}">${text}</prosody></voice></speak>`;
  const response = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": key,
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
      "User-Agent": "chinese-characters-hsk-levels",
    },
    body: ssml,
  });
  if (!response.ok) throw new Error(`Azure ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function viaOpenAI(text, slow) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("нужен OPENAI_API_KEY");
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: process.env.OPENAI_TTS_MODEL ?? "gpt-4o-mini-tts",
      voice: VOICE, input: text, speed: slow ? 0.6 : 1.0, response_format: "mp3",
    }),
  });
  if (!response.ok) throw new Error(`OpenAI ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function viaGoogle(text, slow) {
  const key = process.env.GOOGLE_TTS_KEY;
  if (!key) throw new Error("нужен GOOGLE_TTS_KEY");
  const response = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${key}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: "cmn-CN", name: VOICE },
      audioConfig: { audioEncoding: "MP3", speakingRate: slow ? 0.6 : 1.0 },
    }),
  });
  if (!response.ok) throw new Error(`Google ${response.status}`);
  const payload = await response.json();
  return Buffer.from(payload.audioContent, "base64");
}

async function main() {
  fs.mkdirSync(path.join(AUDIO, "n"), { recursive: true });
  fs.mkdirSync(path.join(AUDIO, "s"), { recursive: true });

  let texts = collectTexts();
  if (LIMIT > 0) texts = texts.slice(0, LIMIT);
  const jobs = [];
  for (const text of texts) {
    for (const rate of RATES) {
      const slow = rate === "slow";
      const file = path.join(AUDIO, slow ? "s" : "n", `${audioId(text)}.mp3`);
      if (!fs.existsSync(file) || fs.statSync(file).size === 0) jobs.push({ text, slow, file });
    }
  }

  console.log(`Движок: ${ENGINE}, голос: ${VOICE}`);
  console.log(`Слов и знаков: ${texts.length}, файлов к созданию: ${jobs.length}`);
  if (!jobs.length) { writeManifest(texts); return; }

  let done = 0;
  let failed = 0;
  const queue = jobs.slice();
  const workers = Array.from({ length: Math.max(1, CONCURRENCY) }, async () => {
    while (queue.length) {
      const job = queue.shift();
      try {
        const buffer = await synthesize(job.text, job.slow);
        if (!buffer?.length) throw new Error("пустой ответ");
        fs.writeFileSync(job.file, buffer);
      } catch (error) {
        failed += 1;
        if (failed <= 5) console.warn(`  не вышло: ${job.text} (${job.slow ? "медленно" : "обычно"}) — ${error.message}`);
      }
      done += 1;
      if (done % 50 === 0 || done === jobs.length) {
        process.stdout.write(`\r  готово ${done}/${jobs.length}, ошибок ${failed}   `);
      }
    }
  });
  await Promise.all(workers);
  process.stdout.write("\n");
  writeManifest(texts);
  if (failed) console.log(`Не удалось создать файлов: ${failed}. Повторный запуск доберёт только их.`);
}

function writeManifest(texts) {
  const ready = texts.filter((text) => fs.existsSync(path.join(AUDIO, "n", `${audioId(text)}.mp3`)));
  const manifest = {
    note: "Список готовых записей. Создаётся скриптом tools/generate-audio.mjs.",
    voice: ready.length ? VOICE : null,
    generatedAt: ready.length ? new Date().toISOString() : null,
    ids: ready.map(audioId).sort(),
  };
  fs.writeFileSync(path.join(AUDIO, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const bytes = ready.reduce((total, text) => {
    for (const dir of ["n", "s"]) {
      const file = path.join(AUDIO, dir, `${audioId(text)}.mp3`);
      if (fs.existsSync(file)) total += fs.statSync(file).size;
    }
    return total;
  }, 0);
  console.log(`manifest.json: ${manifest.ids.length} записей, ${(bytes / 1048576).toFixed(1)} МБ`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(error); process.exit(1); });
}
