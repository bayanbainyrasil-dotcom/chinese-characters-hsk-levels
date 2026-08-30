// Модульные тесты: разбор пиньиня, слияние прогресса, дедупликация очереди.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { splitPinyin, analyseWord, hanCharacters } = await import(path.join(ROOT, "js/pinyin.js"));
const { merge, normalize, defaultProgress, masteredHsk, completedCount } = await import(path.join(ROOT, "js/progress.js"));

test("пиньинь режется по одному слогу на иероглиф", () => {
  assert.deepEqual(splitPinyin("汉语", "Hànyǔ"), ["hàn", "yǔ"]);
  assert.deepEqual(splitPinyin("汉字", "Hànzì"), ["hàn", "zì"]);
  assert.deepEqual(splitPinyin("汉服", "Hànfú"), ["hàn", "fú"]);
});

test("апостроф официального пиньиня задаёт границу слога", () => {
  assert.deepEqual(splitPinyin("女儿", "nǚ’ér"), ["nǚ", "ér"]);
  assert.deepEqual(splitPinyin("幼儿园", "yòu’éryuán"), ["yòu", "ér", "yuán"]);
});

test("без апострофа слог не начинается с a/e/o", () => {
  assert.deepEqual(splitPinyin("可能", "kěnéng"), ["kě", "néng"]);
  assert.deepEqual(splitPinyin("蛋糕", "dàngāo"), ["dàn", "gāo"]);
  assert.deepEqual(splitPinyin("西南", "xīnán"), ["xī", "nán"]);
});

test("эризация не съедает иероглиф 儿", () => {
  assert.deepEqual(splitPinyin("一点儿", "yìdiǎnr"), ["yì", "diǎn", "r"]);
  assert.deepEqual(splitPinyin("哪儿", "nǎr"), ["nǎ", "r"]);
});

test("многозначные знаки читаются по слову, а не по умолчанию", () => {
  assert.deepEqual(splitPinyin("长效", "chángxiào"), ["cháng", "xiào"]);
  assert.deepEqual(splitPinyin("上行", "shàngxíng"), ["shàng", "xíng"]);
  assert.deepEqual(splitPinyin("流血", "liúxuè"), ["liú", "xuè"]);
});

test("разбор возвращает по записи на каждый иероглиф", () => {
  const parts = analyseWord("汉语", "Hànyǔ");
  assert.equal(parts.length, 2);
  assert.equal(parts[0].char, "汉");
  assert.equal(parts[0].pinyin, "hàn");
  assert.notEqual(parts[1].pinyin, "hànyǔ");   // не общий пиньинь слова
});

test("все слова словаря разбираются, и результат совпадает с эталоном Python", () => {
  const words = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/word-splits.json"), "utf8"));
  let checked = 0;
  for (const [word, [pinyin, expected]] of Object.entries(words)) {
    assert.deepEqual(splitPinyin(word, pinyin), expected, `${word} ${pinyin}`);
    checked += 1;
  }
  assert.ok(checked > 10000, `проверено слов: ${checked}`);
});

test("иероглифы отделяются от прочих символов", () => {
  assert.deepEqual(hanCharacters("汉语!"), ["汉", "语"]);
});

test("слияние берёт наибольшее число повторений по каждому знаку", () => {
  const local = { completed: { hsk: { "3:安": 5, "3:把": 2 } }, attempts: 10, cleanAttempts: 4, days: ["2026-08-01"], updatedAt: 100 };
  const remote = { completed: { hsk: { "3:安": 3, "3:把": 4, "4:书": 1 } }, attempts: 7, cleanAttempts: 6, days: ["2026-08-02"], updatedAt: 200 };
  const merged = merge(local, remote);
  assert.equal(merged.completed.hsk["3:安"], 5);
  assert.equal(merged.completed.hsk["3:把"], 4);
  assert.equal(merged.completed.hsk["4:书"], 1);
});

test("дни занятий объединяются без дубликатов и по порядку", () => {
  const merged = merge({ days: ["2026-08-02", "2026-08-01"] }, { days: ["2026-08-02", "2026-08-03"] });
  assert.deepEqual(merged.days, ["2026-08-01", "2026-08-02", "2026-08-03"]);
});

test("последняя сессия берётся из более свежего состояния", () => {
  const merged = merge(
    { lastSession: { kind: "hsk" }, updatedAt: 100 },
    { lastSession: { kind: "rules" }, updatedAt: 200 },
  );
  assert.equal(merged.lastSession.kind, "rules");
});

test("слияние никогда не уменьшает счётчики", () => {
  const merged = merge({ attempts: 40, cleanAttempts: 20 }, { attempts: 5, cleanAttempts: 1 });
  assert.equal(merged.attempts, 40);
  assert.equal(merged.cleanAttempts, 20);
});

test("нормализация не теряет старую форму прогресса версии 1", () => {
  const legacy = {
    version: 1,
    completed: { strokes: { heng: 1 }, rules: {}, radicals: {}, hsk: { "3:安": 5 } },
    attempts: 42, cleanAttempts: 18, days: ["2026-08-01"], lastSession: { kind: "hsk", level: "3" },
  };
  const out = normalize(legacy);
  assert.equal(out.completed.hsk["3:安"], 5);
  assert.equal(out.attempts, 42);
  assert.equal(out.lastSession.level, "3");
  assert.equal(out.settings.autoSpeak, true);
});

test("знак засчитывается только после пяти написаний", () => {
  const progress = normalize({ completed: { hsk: { "3:安": 5, "3:把": 4, "custom:x": 9 } } });
  assert.equal(masteredHsk(progress), 1);   // custom:x не входит в официальные 1200
  assert.equal(completedCount(progress, "hsk", 4), 3);
});

test("пустой прогресс имеет ожидаемую форму", () => {
  const empty = defaultProgress();
  assert.deepEqual(Object.keys(empty.completed).sort(), ["hsk", "radicals", "rules", "strokes"]);
  assert.equal(empty.attempts, 0);
});
