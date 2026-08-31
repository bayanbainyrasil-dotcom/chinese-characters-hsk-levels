// Тренажёр китайских иероглифов HSK 3.0.
// Модуль собирает вместе учебную логику, синхронизацию, озвучку и карточки слов.
// Ключи прогресса и правок словаря намеренно оставлены прежними.

import { CONFIG, backendReady } from "./js/config.js";
import {
  DEFAULT_SETTINGS, defaultProgress, loadProgress, saveProgress as persistProgress,
  merge as mergeProgress, normalize as normalizeProgress, todayKey,
  masteredHsk, completedCount, migrationInfo, restoreBackup,
} from "./js/progress.js";
import { KEYS, readJson, writeJson } from "./js/storage.js";
import { SyncEngine } from "./js/sync.js";
import * as audio from "./js/audio.js";
import * as motion from "./js/motion.js";
import * as admin from "./js/admin.js";
import { loadCharacters } from "./js/dictionary.js";
import { openWordCard, close as closeWordCard } from "./js/wordcard.js";

const $ = (id) => document.getElementById(id);
const VIEW_IDS = ["homeView", "verificationView", "rulesView", "radicalsView", "hskView", "practiceView", "progressView", "settingsView", "adminView"];
const DATA_VERSION = "hsk30-2026-official-pinyin-2";

const STROKES = [
  { id: "heng", char: "一", pinyin: "yī", meaning: "один", kicker: "横 héng", title: "Горизонталь", hint: "Слева направо. Одно спокойное движение." },
  { id: "shu", char: "十", pinyin: "shí", meaning: "десять", kicker: "竖 shù", title: "Вертикаль", hint: "Вертикальная черта идёт сверху вниз." },
  { id: "pie", char: "人", pinyin: "rén", meaning: "человек", kicker: "撇 piě", title: "Откидная влево", hint: "Начни увереннее и постепенно облегчай нажим." },
  { id: "na", char: "八", pinyin: "bā", meaning: "восемь", kicker: "捺 nà", title: "Откидная вправо", hint: "Движение раскрывается вправо и мягко заканчивается." },
  { id: "dian", char: "小", pinyin: "xiǎo", meaning: "маленький", kicker: "点 diǎn", title: "Точка", hint: "Короткое движение, а не неподвижный укол." },
  { id: "ti", char: "提", pinyin: "tí", meaning: "поднимать", kicker: "提 tí", title: "Восходящая", hint: "Снизу слева вверх вправо." },
  { id: "zhe", char: "口", pinyin: "kǒu", meaning: "рот", kicker: "折 zhé", title: "Излом", hint: "Поменяй направление, не отрывая руку." },
  { id: "gou", char: "九", pinyin: "jiǔ", meaning: "девять", kicker: "钩 gōu", title: "Крюк", hint: "Короткий резкий штрих завершает основную черту." },
];

const RULES = [
  { char: "三", title: "Сверху вниз", text: "Верхние элементы пишутся раньше нижних." },
  { char: "川", title: "Слева направо", text: "Левые части идут раньше правых." },
  { char: "十", title: "Горизонталь раньше вертикали", text: "Сначала 横, затем 竖." },
  { char: "人", title: "Влево раньше вправо", text: "Сначала 撇, затем 捺." },
  { char: "国", title: "Рамка, середина, дно", text: "Нижняя черта закрывает рамку последней." },
  { char: "小", title: "Центр раньше боков", text: "Для симметричных знаков сначала середина." },
];

const RULE_EXERCISES = ["三", "川", "十", "人", "国", "小", "木", "日", "田", "中"].map((char, index) => ({
  id: `rule-${char}`,
  char,
  kicker: `Правило ${Math.min(index + 1, 6)}`,
  title: RULES[Math.min(index, 5)].title,
  hint: RULES[Math.min(index, 5)].text,
}));

const RADICALS = [
  ["人", "亻", "человек", "你 · 他 · 们 · 住"], ["口", "", "рот", "吃 · 喝 · 叫 · 唱"], ["女", "", "женщина", "好 · 妈 · 姐 · 她"], ["子", "", "ребёнок", "字 · 学 · 孩"],
  ["木", "", "дерево", "校 · 桌 · 杯 · 林"], ["水", "氵", "вода", "洗 · 河 · 海 · 汉"], ["火", "灬", "огонь", "热 · 点 · 然"], ["心", "忄", "сердце", "想 · 忙 · 快 · 情"],
  ["手", "扌", "рука", "打 · 找 · 报 · 提"], ["言", "讠", "речь", "说 · 语 · 请 · 谢"], ["日", "", "солнце, день", "明 · 时 · 晚 · 星"], ["月", "", "луна, месяц", "月 · 期 · 朋"], ["目", "", "глаз", "看 · 眼 · 睛"],
  ["耳", "", "ухо", "聪 · 职 · 闻"], ["足", "𧾷", "нога", "跑 · 路 · 跳 · 踢"], ["辶", "", "движение", "这 · 过 · 还 · 近"], ["门", "", "дверь", "问 · 间 · 闻"], ["车", "", "машина", "轻 · 较 · 辆"],
  ["马", "", "лошадь", "妈 · 吗 · 骑"], ["食", "饣", "еда", "饭 · 饿 · 馆 · 饱"], ["金", "钅", "металл", "钱 · 钟 · 银 · 错"], ["土", "", "земля", "地 · 块 · 城 · 场"], ["山", "", "гора", "山 · 岁 · 出 · 岛"], ["石", "", "камень", "确 · 码 · 研 · 硬"], ["田", "", "поле", "男 · 界 · 留 · 画"],
  ["力", "", "сила", "男 · 动 · 办 · 加"], ["大", "", "большой", "天 · 太 · 头 · 夫"], ["小", "", "маленький", "少 · 尖 · 当"], ["宀", "", "крыша", "家 · 安 · 字 · 室"], ["艹", "", "трава", "花 · 茶 · 菜 · 药"], ["竹", "⺮", "бамбук", "笔 · 笑 · 第 · 答"], ["米", "", "рис", "粉 · 粒 · 糕 · 类"], ["贝", "", "деньги", "贵 · 费 · 货 · 购"],
  ["衣", "衤", "одежда", "被 · 裤 · 裙 · 装"], ["肉", "月", "тело", "腿 · 脚 · 脸 · 背"], ["疒", "", "болезнь", "病 · 疼 · 痛 · 瘦"], ["虫", "", "насекомое", "蛇 · 蚂 · 蚁 · 蛋"], ["犬", "犭", "животное", "狗 · 猫 · 猪 · 狼"], ["牛", "牜", "корова", "物 · 特 · 牧"],
  ["羊", "", "овца", "美 · 群 · 样"], ["鸟", "", "птица", "鸡 · 鸭 · 鸣"], ["鱼", "", "рыба", "鱼 · 鲜 · 鲸"], ["雨", "", "дождь", "雪 · 雷 · 零 · 需"], ["页", "", "голова", "题 · 颜 · 顶 · 顾"], ["刀", "刂", "нож", "到 · 别 · 剪 · 刘"], ["立", "", "стоять", "站 · 音 · 童 · 章"],
  ["广", "", "навес", "店 · 床 · 度"], ["厂", "", "утёс", "历 · 原 · 压 · 厚"], ["又", "", "правая рука", "对 · 双 · 欢 · 难"], ["糸", "纟", "шёлк", "级 · 纸 · 练 · 组"],
].map(([char, variant, meaning, examples], index) => ({ id: `rad-${index + 1}`, char, variant, meaning, examples, day: index < 13 ? 1 : index < 26 ? 2 : index < 38 ? 3 : 4 }));

const HSK_LEVELS = [
  { key: "1-2", label: "HSK 1–2", count: 100 }, { key: "3", label: "HSK 3", count: 150 }, { key: "4", label: "HSK 4", count: 150 },
  { key: "5", label: "HSK 5", count: 150 }, { key: "6", label: "HSK 6", count: 150 }, { key: "7-9", label: "HSK 7–9", count: 500 },
];

let progress = loadProgress();
let currentView = "homeView";
let previousView = "homeView";
let activeRadicalDay = 1;
let session = null;
let writer = null;
let writerToken = 0;
let currentMistakes = 0;
let writingDataPromise = null;
let vocabularyDataPromise = null;
let vocabularyRows = null;
let adminUnlocked = false;
let toastTimer = null;
let resizeTimer = null;
let lastBoardSize = 0;
let boardObserver = null;
let serverEdits = null;

const sync = new SyncEngine({
  getLocal: () => progress,
  applyRemote: (merged) => {
    progress = merged;
    persistProgress(progress);
    applySettings(progress.settings, { persist: false });
    renderHomeProgress();
    if (currentView === "progressView") renderProgressView();
    if (currentView === "hskView") renderHskLevels();
    if (session) renderRepeatDots();
  },
});

// --- общие мелочи ---------------------------------------------------------

function saveProgress({ silent = false } = {}) {
  persistProgress(progress);
  if (!silent) renderHomeProgress();
}

function showView(id) {
  if (!VIEW_IDS.includes(id)) return;
  previousView = currentView;
  currentView = id;
  VIEW_IDS.forEach((viewId) => $(viewId)?.classList.toggle("hidden", viewId !== id));
  document.body.dataset.view = id;
  document.body.classList.toggle("practice-mode", id === "practiceView");
  document.documentElement.classList.toggle("practice-mode", id === "practiceView");
  if (id === "practiceView") syncViewportHeight();
  window.scrollTo({ top: 0, behavior: "auto" });
  $("practiceScroll")?.scrollTo({ top: 0, behavior: "auto" });
  const view = $(id);
  if (view) {
    view.classList.remove("view-enter");
    void view.offsetWidth;
    if (!motion.reducedMotion()) view.classList.add("view-enter");
  }
  if (id === "homeView") renderHomeProgress();
  if (id === "progressView") renderProgressView();
  if (id === "settingsView") renderSettings();
}

function showToast(message) {
  clearTimeout(toastTimer);
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.remove("hidden");
  toastTimer = setTimeout(() => toast.classList.add("hidden"), 2600);
}

function officialHskCompletedCount() { return masteredHsk(progress); }

function renderHomeProgress() {
  const totals = { strokes: 8, rules: 10, radicals: 50, hsk: 1200 };
  const goals = { strokes: 1, rules: 1, radicals: 1, hsk: 5 };
  for (const [bucket, total] of Object.entries(totals)) {
    const count = bucket === "hsk" ? officialHskCompletedCount() : completedCount(progress, bucket, goals[bucket]);
    const label = document.querySelector(`[data-progress="${bucket}"]`);
    if (label) label.textContent = `${count}/${total}`;
    label?.closest(".stage-card")?.classList.toggle("complete", count >= total);
  }
  if (progress.lastSession) {
    $("continueCard").classList.remove("hidden");
    $("continueTitle").textContent = progress.lastSession.title || "Последнее занятие";
  } else {
    $("continueCard").classList.add("hidden");
  }
}

function renderVerification() {
  const official = { "1": 300, "2": 200, "3": 500, "4": 1000, "5": 1600, "6": 1800, "7-9": 5600 };
  const supplied = { "1": 300, "2": 197, "3": 491, "4": 990, "5": 1579, "6": 1777, "7-9": 6159 };
  const host = $("levelAudit");
  host.replaceChildren();
  Object.keys(official).forEach((level) => {
    const row = document.createElement("div");
    row.className = "audit-row";
    const ratio = Math.min(100, (supplied[level] / official[level]) * 100);
    row.innerHTML = `<strong>HSK ${level}</strong><div class="audit-track"><span style="transform:scaleX(${ratio / 100})"></span></div><small>${supplied[level]} / ${official[level]}</small>`;
    host.appendChild(row);
  });
}

function renderRules() {
  const host = $("ruleList");
  host.replaceChildren();
  RULES.forEach((rule) => {
    const card = document.createElement("article");
    card.className = "rule-card";
    card.innerHTML = `<div class="rule-char">${rule.char}</div><div><strong>${rule.title}</strong><p>${rule.text}</p></div>`;
    host.appendChild(card);
  });
  motion.stagger(host.children, 40);
}

function renderRadicalDays() {
  const host = $("radicalDays");
  host.replaceChildren();
  for (let day = 1; day <= 4; day += 1) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `chip${day === activeRadicalDay ? " active" : ""}`;
    button.textContent = `День ${day}`;
    button.setAttribute("aria-pressed", String(day === activeRadicalDay));
    button.addEventListener("click", () => { activeRadicalDay = day; renderRadicalDays(); renderRadicals(); });
    host.appendChild(button);
  }
}

function renderRadicals() {
  const list = RADICALS.filter((item) => item.day === activeRadicalDay);
  $("radicalDayTitle").textContent = `День ${activeRadicalDay}`;
  $("radicalDayCount").textContent = `${list.length} ключей`;
  const host = $("radicalList");
  host.replaceChildren();
  list.forEach((radical) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "radical-card";
    button.innerHTML = `<span class="radical-top"><span class="radical-char">${radical.char}</span><span class="radical-variant">${radical.variant}</span></span><strong>${radical.meaning}</strong><p>${radical.examples}</p>`;
    button.addEventListener("click", () => startRadicalSession([radical], `Ключ ${radical.char}`));
    host.appendChild(button);
  });
  motion.stagger(host.children, 35);
}

// --- данные ---------------------------------------------------------------

async function loadWritingData() {
  if (!writingDataPromise) {
    writingDataPromise = fetch(`data/writing.json?v=${DATA_VERSION}`).then((response) => {
      if (!response.ok) throw new Error("writing data unavailable");
      return response.json();
    });
  }
  return writingDataPromise;
}

async function loadVocabularyData() {
  if (!vocabularyDataPromise) {
    vocabularyDataPromise = fetch(`data/vocabulary.json?v=${DATA_VERSION}`).then((response) => {
      if (!response.ok) throw new Error("vocabulary unavailable");
      return response.json();
    }).then((payload) => {
      vocabularyRows = payload.rows;
      return payload;
    });
  }
  return vocabularyDataPromise;
}

function writingItem(row, level) {
  return {
    id: `hsk-${level}-${row.char}`,
    char: row.char,
    pinyin: row.pinyin || row.examples?.[0]?.[1] || "",
    meaning: row.meaning || row.examples?.[0]?.[2] || "",
    kicker: `HSK ${level} · знак ${row.number}`,
    title: row.char,
    hint: row.examples?.length ? row.examples.map((example) => example[0]).join(" · ") : "Напиши знак пять раз по правильному порядку.",
    examples: row.examples || [],
  };
}

async function renderHskLevels() {
  const host = $("hskLevels");
  host.replaceChildren();
  HSK_LEVELS.forEach((level) => {
    const done = completedForHskLevel(level.key);
    const percent = Math.round((done / level.count) * 100);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "level-card";
    button.innerHTML = `<strong>${level.label}</strong><span>${level.count} знаков</span><small>${done} изучено</small><span class="level-percent">${percent}%</span><span class="level-track"><span style="transform:scaleX(${percent / 100})"></span></span>`;
    button.addEventListener("click", () => startHskLevel(level.key));
    host.appendChild(button);
  });
  motion.stagger(host.children, 45);
}

function completedForHskLevel(level) {
  const prefix = `${level}:`;
  return Object.entries(progress.completed.hsk || {}).reduce((total, [key, value]) => total + (key.startsWith(prefix) && Number(value) >= 5 ? 1 : 0), 0);
}

// --- занятие --------------------------------------------------------------

function startSession(config) {
  const items = config.items.filter((item) => item?.char);
  if (!items.length) { showToast("В этом наборе пока нет упражнений"); return; }
  session = { ...config, items, index: 0, repeatGoal: config.repeatGoal || 1 };
  const bucket = progress.completed[session.bucket] || (progress.completed[session.bucket] = {});
  const firstIncomplete = items.findIndex((item) => Number(bucket[progressKeyFor(item)] || 0) < session.repeatGoal);
  session.index = firstIncomplete >= 0 ? firstIncomplete : 0;
  progress.lastSession = config.lastSession || null;
  progress.lastLevel = config.level ?? null;
  if (!progress.days.includes(todayKey())) progress.days.push(todayKey());
  saveProgress();
  sync.enqueue({
    kind: "state",
    days: [todayKey()],
    lastSession: progress.lastSession,
    lastLevel: progress.lastLevel,
  });
  showView("practiceView");
  renderPracticeItem();
}

function progressKeyFor(item) {
  return session.bucket === "hsk" ? `${session.level || "custom"}:${item.char}` : item.id || item.char;
}

function startStrokeSession() {
  startSession({ kind: "strokes", bucket: "strokes", title: "Восемь базовых черт", items: STROKES, repeatGoal: 1, returnView: "homeView", lastSession: { kind: "strokes", title: "Восемь базовых черт" } });
}

function startRuleSession() {
  startSession({ kind: "rules", bucket: "rules", title: "Порядок черт", items: RULE_EXERCISES, repeatGoal: 1, returnView: "rulesView", lastSession: { kind: "rules", title: "Порядок черт" } });
}

function startRadicalSession(radicals, title) {
  const items = radicals.map((radical) => ({ id: radical.id, char: radical.char, meaning: radical.meaning, kicker: `部首 · день ${radical.day}`, title: `${radical.char}${radical.variant ? ` / ${radical.variant}` : ""}`, hint: radical.examples, examples: radical.examples.split(" · ").map((word) => [word, "", "", ""]) }));
  startSession({ kind: "radicals", bucket: "radicals", title, items, repeatGoal: 1, returnView: "radicalsView", radicalDay: activeRadicalDay, lastSession: { kind: "radicals", day: activeRadicalDay, title } });
}

async function startHskLevel(level) {
  showToast("Загружаю письменный минимум…");
  try {
    const data = await loadWritingData();
    const items = (data.groups[level] || []).map((row) => writingItem(row, level));
    startSession({ kind: "hsk", bucket: "hsk", level, title: `HSK ${level}`, items, repeatGoal: 5, returnView: "hskView", lastSession: { kind: "hsk", level, title: `Письмо HSK ${level}` } });
  } catch (_) {
    showToast("Не удалось загрузить список. Проверьте соединение.");
  }
}

function startWordSession(wordRow) {
  const chars = [...new Set(Array.from(wordRow.word).filter((char) => /[\p{Script=Han}]/u.test(char)))];
  const items = chars.map((char, index) => ({ id: `word-${wordRow.number || "custom"}-${index}-${char}`, char, pinyin: wordRow.pinyin, meaning: wordRow.russian, kicker: `Слово · HSK ${wordRow.level}`, title: wordRow.word, hint: `${wordRow.pinyin} · ${wordRow.russian}`, examples: [[wordRow.word, wordRow.pinyin, wordRow.russian, wordRow.level]] }));
  startSession({ kind: "word", bucket: "hsk", level: `word-${wordRow.number || "custom"}`, title: wordRow.word, items, repeatGoal: 5, returnView: "hskView", lastSession: null });
}

/** Открывает письмо одного знака — например, из разбора слова. */
async function startSingleCharacter(char) {
  try {
    const data = await loadWritingData();
    for (const [level, group] of Object.entries(data.groups)) {
      const row = group.find((entry) => entry.char === char);
      if (row) {
        startSession({
          kind: "hsk", bucket: "hsk", level, title: `HSK ${level}`,
          items: [writingItem(row, level)], repeatGoal: 5, returnView: previousView === "practiceView" ? "hskView" : previousView,
          lastSession: { kind: "hsk", level, title: `Письмо HSK ${level}` },
        });
        return;
      }
    }
  } catch (_) { /* данные подтянем позже */ }
  startSession({
    kind: "custom", bucket: "hsk", level: "custom", title: char,
    items: [{ id: `char-${char}`, char, kicker: "Знак из разбора слова", title: char, hint: "Напиши знак пять раз по правильному порядку.", examples: [] }],
    repeatGoal: 5, returnView: "hskView", lastSession: null,
  });
}

function currentItem() { return session?.items?.[session.index] || null; }

function currentRepetitions(item = currentItem()) {
  if (!item || !session) return 0;
  return Number(progress.completed[session.bucket]?.[progressKeyFor(item)] || 0);
}

function renderPracticeItem() {
  const item = currentItem();
  if (!item) { finishSession(); return; }
  currentMistakes = 0;
  $("practiceCount").textContent = `${session.index + 1} / ${session.items.length}`;
  motion.fillTrack($("progressFill"), session.index / session.items.length);
  $("lessonKicker").textContent = item.kicker || session.title;
  $("lessonTitle").textContent = item.title || item.char;
  $("lessonHint").textContent = item.hint || "Смотри порядок, затем напиши сам.";
  $("characterLabel").textContent = item.char;
  $("pinyinLabel").textContent = item.pinyin || "";
  $("meaningLabel").textContent = item.meaning || "";
  $("feedback").className = "feedback";
  $("feedback").textContent = "Напишите иероглиф";
  $("nextButton").classList.add("hidden");
  $("charSpeak").setAttribute("aria-label", `Произнести ${item.char}`);
  $("charSpeak").classList.toggle("hidden", !item.char);
  progress.lastChar = item.char;
  renderExamples(item.examples || []);
  renderRepeatDots();
  buildWriter(item.char);
  prefetchNeighbourAudio();
}

function prefetchNeighbourAudio() {
  const item = currentItem();
  if (item?.char) audio.prefetch(item.char);
  const next = session?.items?.[session.index + 1];
  if (next?.char) audio.prefetch(next.char);
  for (const example of (item?.examples || []).slice(0, 3)) {
    if (example?.[0]) audio.prefetch(example[0]);
  }
}

/** Примеры под знаком — интерактивные кнопки, открывающие подробную карточку. */
function renderExamples(examples) {
  const host = $("exampleList");
  host.replaceChildren();
  examples.slice(0, 3).forEach((example) => {
    const [word, pinyin, russian, level] = example;
    if (!word) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "example-pill";
    button.setAttribute("aria-label", `Разобрать слово ${word}${pinyin ? `, ${pinyin}` : ""}${russian ? `, ${russian}` : ""}`);
    const wordSpan = document.createElement("span");
    wordSpan.className = "example-word";
    wordSpan.lang = "zh-Hans";
    wordSpan.textContent = word;
    button.appendChild(wordSpan);
    if (pinyin) {
      const pinyinSpan = document.createElement("span");
      pinyinSpan.className = "example-pinyin";
      pinyinSpan.textContent = pinyin;
      button.appendChild(pinyinSpan);
    }
    if (russian) {
      const meaningSpan = document.createElement("span");
      meaningSpan.className = "example-meaning";
      meaningSpan.textContent = russian;
      button.appendChild(meaningSpan);
    }
    button.addEventListener("click", () => {
      audio.unlockAudio();
      openWordCard(
        { word, pinyin, russian, level, partOfSpeech: "" },
        { onCharacter: (char) => startSingleCharacter(char), onPractice: (row) => startWordSession({ ...row, number: null }) },
      );
    });
    host.appendChild(button);
  });
  if (!motion.reducedMotion()) motion.stagger(host.children, 35);
}

function renderRepeatDots() {
  const host = $("repeatRow");
  const completed = currentRepetitions();
  if (!session || session.repeatGoal <= 1) { host.replaceChildren(); return; }
  if (host.children.length !== session.repeatGoal) {
    host.replaceChildren();
    for (let index = 0; index < session.repeatGoal; index += 1) {
      const dot = document.createElement("span");
      dot.className = "repeat-dot";
      host.appendChild(dot);
    }
  }
  [...host.children].forEach((dot, index) => {
    const done = index < completed;
    if (done && !dot.classList.contains("done")) {
      dot.classList.add("done");
      if (!motion.reducedMotion()) {
        dot.classList.remove("pop");
        void dot.offsetWidth;
        dot.classList.add("pop");
      }
    } else if (!done) {
      dot.classList.remove("done", "pop");
    }
  });
  host.setAttribute("aria-label", `Повторений: ${completed} из ${session.repeatGoal}`);
}

function boardSize() {
  const rect = $("writingBoard").getBoundingClientRect();
  return Math.max(200, Math.round(rect.width || 0));
}

function boardPadding(size) { return Math.max(10, Math.round(size * 0.045)); }

// Поворот и ресайз: меняем размер SVG у hanzi-writer, не пересоздавая его,
// чтобы уже написанные черты не сбрасывались и не съезжали.
function syncWriterSize() {
  if (!writer || currentView !== "practiceView") return;
  const size = boardSize();
  if (!size || Math.abs(size - lastBoardSize) < 2) return;
  lastBoardSize = size;
  try {
    writer.updateDimensions({ width: size, height: size, padding: boardPadding(size) });
  } catch (_) {
    if (currentItem()) renderPracticeItem();
  }
}

function syncViewportHeight() {
  const height = window.visualViewport?.height || window.innerHeight || 0;
  if (height > 0) {
    document.documentElement.style.setProperty("--vh", `${height / 100}px`);
    document.documentElement.style.setProperty("--app-h", `${height}px`);
  }
}

function handleViewportChange() {
  syncViewportHeight();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(syncWriterSize, 120);
}

function observeBoard() {
  const board = $("writingBoard");
  if (!board || boardObserver || typeof ResizeObserver !== "function") return;
  boardObserver = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(syncWriterSize, 60);
  });
  boardObserver.observe(board);
}

let hanziWriterPromise = null;

/** Библиотека письма нужна только в упражнении — грузим её при первом знаке. */
function loadHanziWriter() {
  if (window.HanziWriter) return Promise.resolve(window.HanziWriter);
  if (!hanziWriterPromise) {
    hanziWriterPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "assets/hanzi-writer.min.js?v=20260826-1";
      script.async = true;
      script.onload = () => resolve(window.HanziWriter);
      script.onerror = () => { hanziWriterPromise = null; reject(new Error("hanzi-writer не загрузился")); };
      document.head.appendChild(script);
    });
  }
  return hanziWriterPromise;
}

async function buildWriter(character) {
  writerToken += 1;
  const token = writerToken;
  try { writer?.cancelQuiz(); } catch (_) { /* нет активной проверки */ }
  writer = null;
  const target = $("hanziTarget");
  target.replaceChildren();
  $("boardLoading").textContent = "Загрузка иероглифа…";
  $("boardLoading").classList.remove("hidden");
  $("animateButton").disabled = true;
  $("retryButton").disabled = true;
  try {
    await loadHanziWriter();
  } catch (_) {
    $("boardLoading").textContent = "Библиотека письма не загрузилась";
    return;
  }
  if (token !== writerToken) return;
  const size = boardSize();
  lastBoardSize = size;
  const ink = getComputedStyle(document.documentElement);
  try {
    writer = HanziWriter.create(target, character, {
      width: size, height: size, padding: boardPadding(size),
      showCharacter: false, showOutline: true,
      strokeColor: ink.getPropertyValue("--ink-stroke").trim() || "#17191d",
      outlineColor: ink.getPropertyValue("--ink-outline").trim() || "#d8d0be",
      drawingColor: ink.getPropertyValue("--ink-draw").trim() || "#c74831",
      drawingWidth: Math.max(14, Math.round(size / 18)),
      highlightColor: "#3aa875", highlightCompleteColor: "#3aa875",
      strokeAnimationSpeed: .9, delayBetweenStrokes: 180,
      showHintAfterMisses: 2, highlightOnComplete: true,
      onLoadCharDataSuccess: () => {
        if (token !== writerToken) return;
        $("boardLoading").classList.add("hidden");
        $("animateButton").disabled = false;
        $("retryButton").disabled = false;
        beginQuiz(token);
      },
      onLoadCharDataError: () => {
        if (token !== writerToken) return;
        $("boardLoading").textContent = "Для этого знака нет данных о чертах";
        $("feedback").className = "feedback error";
        $("feedback").textContent = "Пропустите знак или откройте его позже";
      },
    });
  } catch (_) {
    $("boardLoading").textContent = "Не удалось открыть иероглиф";
  }
}

function beginQuiz(token) {
  if (!writer || token !== writerToken) return;
  writer.quiz({
    showHintAfterMisses: 2,
    onMistake: ({ strokesRemaining }) => {
      if (token !== writerToken) return;
      currentMistakes += 1;
      $("feedback").className = "feedback error";
      $("feedback").textContent = `Не та черта · осталось ${strokesRemaining}`;
    },
    onCorrectStroke: ({ strokesRemaining }) => {
      if (token !== writerToken) return;
      $("feedback").className = "feedback success";
      $("feedback").textContent = strokesRemaining ? `Верно · осталось ${strokesRemaining}` : "Готово";
    },
    onComplete: ({ totalMistakes }) => completeCurrentItem(totalMistakes),
  });
}

function completeCurrentItem(totalMistakes) {
  const item = currentItem();
  if (!item) return;
  const key = progressKeyFor(item);
  const bucket = progress.completed[session.bucket] || (progress.completed[session.bucket] = {});
  bucket[key] = Math.min(session.repeatGoal, Number(bucket[key] || 0) + 1);
  progress.attempts += 1;
  if (totalMistakes === 0) progress.cleanAttempts += 1;
  if (!progress.days.includes(todayKey())) progress.days.push(todayKey());
  progress.lastChar = item.char;
  saveProgress();

  sync.enqueue({
    kind: "write",
    bucket: session.bucket,
    key,
    reps: bucket[key],
    attemptsDelta: 1,
    cleanDelta: totalMistakes === 0 ? 1 : 0,
    days: [todayKey()],
    lastSession: progress.lastSession,
    lastLevel: progress.lastLevel,
    lastChar: item.char,
  });

  renderRepeatDots();
  motion.inkPulse($("boardWrap"));
  const repetitions = currentRepetitions(item);
  const finishedItem = repetitions >= session.repeatGoal;
  if (finishedItem) motion.celebrate($("boardWrap"));
  $("feedback").className = "feedback success";
  $("feedback").textContent = totalMistakes === 0 ? "Чисто, без ошибок" : `Написано · ошибок: ${totalMistakes}`;
  $("nextButton").textContent = finishedItem ? "Следующий знак" : `Повторить · ${repetitions}/${session.repeatGoal}`;
  $("nextButton").classList.remove("hidden");
  motion.fillTrack($("progressFill"), (session.index + (finishedItem ? 1 : 0)) / session.items.length);

  // Озвучка после правильного написания — один раз, и только если это разрешено.
  audio.speak(item.char, { auto: true });
}

function nextPracticeStep() {
  if (!session) return;
  const finishedItem = currentRepetitions() >= session.repeatGoal;
  if (finishedItem) session.index += 1;
  renderPracticeItem();
}

function skipPracticeItem() {
  if (!session) return;
  session.index += 1;
  renderPracticeItem();
}

function finishSession() {
  const destination = session?.returnView || "homeView";
  const title = session?.title || "Занятие";
  session = null;
  try { writer?.cancelQuiz(); } catch (_) { /* нет проверки */ }
  writer = null;
  showView(destination);
  if (destination === "hskView") renderHskLevels();
  showToast(`${title}: занятие завершено`);
  sync.flush();
}

function animateCurrentCharacter() {
  if (!writer) return;
  const token = writerToken;
  try { writer.cancelQuiz(); } catch (_) { /* нет проверки */ }
  $("feedback").className = "feedback";
  $("feedback").textContent = "Смотри порядок черт";
  $("animateButton").disabled = true;
  writer.animateCharacter({
    onComplete: () => {
      if (token !== writerToken || !writer) return;
      writer.hideCharacter({
        duration: 180,
        onComplete: () => {
          if (token !== writerToken) return;
          $("animateButton").disabled = false;
          $("feedback").textContent = "Теперь напишите сами";
          beginQuiz(token);
        },
      });
    },
  });
}

// --- словарь и поиск ------------------------------------------------------

function foldText(value) {
  return String(value || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
}

function getAdminEdits() {
  return admin.mergeEdits(admin.localEdits(), serverEdits);
}

function saveAdminEdits(edits) {
  admin.saveLocalEdits(edits);
  renderAdminChanges();
}

function rowObject(row) {
  return { number: row[0], level: row[1], word: row[2], pinyin: row[3], partOfSpeech: row[4], russian: row[5], custom: false };
}

function mergedVocabulary() {
  const edits = getAdminEdits();
  const byBase = new Map(edits.filter((edit) => edit.baseNumber).map((edit) => [Number(edit.baseNumber), edit]));
  const base = (vocabularyRows || []).map((row) => {
    const item = rowObject(row);
    const edit = byBase.get(Number(item.number));
    return edit ? { ...item, ...edit, number: item.number, custom: false } : item;
  });
  const custom = edits.filter((edit) => !edit.baseNumber && !edit.deleted).map((edit) => ({ ...edit, number: edit.id, custom: true }));
  return base.concat(custom);
}

function searchVocabulary(query, limit = 30) {
  const needle = foldText(query);
  if (!needle) return [];
  const compactNeedle = needle.replace(/\s+/g, "");
  const results = [];
  for (const row of mergedVocabulary()) {
    const haystacks = [row.word, row.pinyin, row.russian, row.partOfSpeech].map(foldText);
    if (haystacks.some((value) => value.includes(needle) || value.replace(/\s+/g, "").includes(compactNeedle))) {
      results.push(row);
      if (results.length >= limit) break;
    }
  }
  return results;
}

function renderWordResults(host, rows, onSelect) {
  host.replaceChildren();
  rows.forEach((row) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "word-result";
    button.setAttribute("aria-label", `${row.word}${row.pinyin ? `, ${row.pinyin}` : ""}${row.russian ? `, ${row.russian}` : ""}`);
    const word = document.createElement("span"); word.className = "word"; word.lang = "zh-Hans"; word.textContent = row.word;
    const details = document.createElement("span"); details.className = "details";
    const pinyin = document.createElement("strong"); pinyin.textContent = row.pinyin || "";
    const meaning = document.createElement("small"); meaning.textContent = row.russian || "Без перевода";
    const level = document.createElement("span"); level.className = "level"; level.textContent = `HSK ${row.level}`;
    details.append(pinyin, meaning); button.append(word, details, level);
    button.addEventListener("click", () => onSelect(row));
    host.appendChild(button);
  });
  motion.stagger(host.children, 25);
}

async function handleVocabularySearch() {
  const query = $("vocabularySearch").value.trim();
  if (!query) { $("searchResults").replaceChildren(); $("searchMeta").textContent = "Поиск по 11 000 официальных слов"; return; }
  $("searchMeta").textContent = "Ищу…";
  try {
    await loadVocabularyData();
    const rows = searchVocabulary(query, 24);
    $("searchMeta").textContent = rows.length ? `Найдено: ${rows.length}${rows.length === 24 ? "+" : ""}` : "Ничего не найдено";
    renderWordResults($("searchResults"), rows, (row) => {
      audio.unlockAudio();
      openWordCard(row, {
        onCharacter: (char) => startSingleCharacter(char),
        onPractice: () => startWordSession(row),
      });
    });
  } catch (_) {
    $("searchMeta").textContent = "Не удалось загрузить словарь";
  }
}

// --- прогресс, настройки --------------------------------------------------

function renderProgressView() {
  const mastered = officialHskCompletedCount();
  const percent = Math.round(mastered / 1200 * 100);
  motion.countTo($("totalMastered"), mastered);
  motion.countTo($("progressPercent"), percent, { format: (value) => `${Math.round(value)}%` });
  motion.fillRing($("progressRing"), percent);
  motion.countTo($("totalAttempts"), progress.attempts || 0);
  motion.countTo($("cleanAttempts"), progress.cleanAttempts || 0);
  motion.countTo($("practiceDays"), progress.days?.length || 0);
  const sections = [
    ["Черты", completedCount(progress, "strokes", 1), 8],
    ["Правила", completedCount(progress, "rules", 1), 10],
    ["Ключи", completedCount(progress, "radicals", 1), 50],
    ["HSK письмо", mastered, 1200],
  ];
  const host = $("progressList"); host.replaceChildren();
  sections.forEach(([label, value, total]) => {
    const item = document.createElement("div"); item.className = "progress-item";
    item.innerHTML = `<div class="progress-item-head"><strong>${label}</strong><span>${value} / ${total}</span></div><div class="mini-track"><span style="transform:scaleX(${Math.min(1, value / total)})"></span></div>`;
    host.appendChild(item);
  });
  motion.stagger(host.children, 40);
  const info = migrationInfo();
  $("migrationNote").textContent = info?.hadLegacy
    ? `Прежний прогресс найден и сохранён${info.backedUp ? ", резервная копия создана" : ""}${info.syncedToServer ? " и выгружен в аккаунт" : ""}.`
    : "Прогресс хранится на этом устройстве, а при входе в аккаунт — ещё и на сервере.";
}

function applySettings(settings, { persist = true } = {}) {
  const next = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  progress.settings = next;
  audio.updateAudioSettings({
    autoSpeak: next.autoSpeak, volume: next.volume, muted: next.muted, slowRate: next.slowRate,
  });
  applyTheme(next.theme);
  motion.setMotionPreference(next.motion);
  if (persist) saveProgress({ silent: true });
  return next;
}

function applyTheme(theme) {
  const resolved = theme === "system"
    ? (window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark")
    : (theme === "light" ? "light" : "dark");
  document.documentElement.dataset.theme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", resolved === "light" ? "#f5f1e8" : "#101216");
}

function renderSettings() {
  const settings = { ...DEFAULT_SETTINGS, ...progress.settings };
  $("settingAutoSpeak").checked = Boolean(settings.autoSpeak);
  $("settingMuted").checked = Boolean(settings.muted);
  $("settingVolume").value = String(Math.round((settings.volume ?? 0.9) * 100));
  $("settingVolumeValue").textContent = `${Math.round((settings.volume ?? 0.9) * 100)}%`;
  $("settingMotion").checked = settings.motion === "reduced";
  document.querySelectorAll("[data-theme-option]").forEach((button) => {
    const active = button.dataset.themeOption === (settings.theme || "dark");
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  // Пока бэкенд не настроен, форма входа не показывается вообще: кнопка, которая
  // гарантированно падает с ошибкой, хуже, чем честная строка о том, что вход не подключён.
  const backendOn = backendReady();
  $("accountState").textContent = sync.signedIn
    ? `Вход выполнен: ${sync.user?.email || "аккаунт Google"}`
    : backendOn ? "Вы занимаетесь без аккаунта — прогресс хранится только на этом устройстве."
      : "Прогресс сохраняется на этом устройстве.";
  $("signInBlock").classList.toggle("hidden", sync.signedIn || !backendOn);
  $("backendOffBlock").classList.toggle("hidden", sync.signedIn || backendOn);
  $("signOutBlock").classList.toggle("hidden", !sync.signedIn);
}

function updateSyncBadge({ status }) {
  const badge = $("syncBadge");
  if (!badge) return;
  const labels = {
    idle: "Сохранено",
    saved: "Сохранено",
    syncing: "Синхронизация…",
    offline: "Нет интернета — сохраним позже",
    error: "Ошибка синхронизации — повторить",
  };
  badge.dataset.state = status;
  badge.textContent = labels[status] || labels.saved;
  badge.classList.toggle("actionable", status === "error");
  badge.setAttribute("aria-live", "polite");
}

// --- администрирование ----------------------------------------------------

function configureAdminGate() {
  const configured = admin.adminConfigured();
  adminUnlocked = adminUnlocked && Boolean(admin.adminSession());
  $("adminGateTitle").textContent = "Вход в управление";
  $("adminGateText").textContent = configured
    ? "Введите пароль администратора. Он проверяется на сервере."
    : "Управление станет доступно, когда к сайту подключат серверную часть.";
  $("adminGateSubmit").disabled = !configured;
  $("adminPin").disabled = !configured;
  $("adminGate").classList.toggle("hidden", adminUnlocked);
  $("adminPanel").classList.toggle("hidden", !adminUnlocked);
  if (adminUnlocked) renderAdminChanges();
}

async function submitAdminGate(event) {
  event.preventDefault();
  const pin = $("adminPin").value;
  const message = $("adminGateMessage");
  message.textContent = "";
  message.className = "form-message";
  if (!pin) { message.textContent = "Введите пароль"; return; }
  $("adminGateSubmit").disabled = true;
  try {
    await admin.unlockAdmin(pin);
    adminUnlocked = true;
    $("adminPin").value = "";
    serverEdits = await admin.fetchServerEdits();
    configureAdminGate();
  } catch (error) {
    message.className = "form-message error";
    if (error.status === 429) {
      const seconds = Number(error.retryAfter) || 60;
      message.textContent = `Слишком много попыток. Повторите через ${Math.ceil(seconds / 60)} мин.`;
    } else if (error.status === 401) {
      message.textContent = error.attemptsLeft != null
        ? `Неверный пароль. Осталось попыток: ${error.attemptsLeft}`
        : "Неверный пароль";
    } else {
      message.textContent = error.message || "Не удалось войти";
    }
  } finally {
    $("adminGateSubmit").disabled = !admin.adminConfigured();
  }
}

async function handleAdminSearch() {
  const query = $("adminSearch").value.trim();
  if (!query) { $("adminSearchResults").replaceChildren(); return; }
  try {
    await loadVocabularyData();
    renderWordResults($("adminSearchResults"), searchVocabulary(query, 18), openWordEditor);
  } catch (_) { showToast("Не удалось открыть словарь"); }
}

function openWordEditor(row = null) {
  $("wordEditor").classList.remove("hidden");
  $("editorMessage").textContent = "";
  $("editorTitle").textContent = row ? "Изменить слово" : "Новое слово";
  $("editorBaseNumber").value = row?.custom ? String(row.id) : row?.number ? String(row.number) : "";
  $("editorLevel").value = row?.level || "1";
  $("editorWord").value = row?.word || "";
  $("editorPinyin").value = row?.pinyin || "";
  $("editorPos").value = row?.partOfSpeech || "";
  $("editorRussian").value = row?.russian || "";
  $("deleteCustomButton").classList.toggle("hidden", !row);
  $("deleteCustomButton").textContent = row?.custom ? "Удалить пользовательскую запись" : "Отменить это изменение";
  $("wordEditor").scrollIntoView({ behavior: motion.reducedMotion() ? "auto" : "smooth", block: "start" });
}

async function submitWordEditor(event) {
  event.preventDefault();
  const reference = $("editorBaseNumber").value;
  const edits = admin.localEdits();
  const existing = edits.find((edit) => String(edit.id) === reference || String(edit.baseNumber) === reference);
  const isBase = reference && /^\d+$/.test(reference);
  const id = existing?.id || (isBase ? `base:${reference}` : reference || `custom:${Date.now()}`);
  const record = {
    id,
    ...(isBase ? { baseNumber: Number(reference) } : {}),
    level: $("editorLevel").value,
    word: $("editorWord").value.trim(),
    pinyin: $("editorPinyin").value.trim(),
    partOfSpeech: $("editorPos").value.trim(),
    russian: $("editorRussian").value.trim(),
    updatedAt: new Date().toISOString(),
  };
  if (!record.word || !record.russian) { $("editorMessage").textContent = "Заполните иероглифы и перевод"; return; }
  const next = edits.filter((edit) => edit.id !== id);
  next.unshift(record);
  saveAdminEdits(next);
  $("wordEditor").classList.add("hidden");
  if (vocabularyDataPromise) handleAdminSearch();
  try {
    if (admin.adminSession()) {
      await admin.saveServerEdit(record);
      serverEdits = await admin.fetchServerEdits();
      renderAdminChanges();
      showToast("Изменение сохранено на сервере");
      return;
    }
  } catch (error) {
    showToast(`Сервер не принял правку: ${error.message}`);
    return;
  }
  showToast("Изменение сохранено");
}

async function deleteCurrentEdit() {
  const reference = $("editorBaseNumber").value;
  if (!reference) return;
  const edits = admin.localEdits();
  const target = edits.find((edit) => String(edit.id) === reference || String(edit.baseNumber) === reference);
  const next = edits.filter((edit) => String(edit.id) !== reference && String(edit.baseNumber) !== reference);
  if (next.length === edits.length && !target) { showToast("Для базового слова изменений ещё нет"); return; }
  saveAdminEdits(next);
  $("wordEditor").classList.add("hidden");
  try {
    if (target && admin.adminSession()) {
      await admin.deleteServerEdit(target.id);
      serverEdits = await admin.fetchServerEdits();
      renderAdminChanges();
    }
  } catch (error) {
    showToast(`Сервер не принял отмену: ${error.message}`);
    return;
  }
  showToast("Изменение отменено");
}

function renderAdminChanges() {
  const edits = getAdminEdits();
  $("adminChangeCount").textContent = edits.length;
  $("adminListCount").textContent = edits.length;
  $("adminScope").textContent = serverEdits
    ? "Правки сохраняются на сервере и видны всем"
    : "Правки пока сохраняются только на этом устройстве";
  const host = $("adminChangeList"); host.replaceChildren();
  edits.slice(0, 30).forEach((edit) => {
    const item = document.createElement("div"); item.className = "change-item";
    const copy = document.createElement("div");
    const word = document.createElement("strong"); word.textContent = edit.word;
    const meta = document.createElement("small"); meta.textContent = `HSK ${edit.level} · ${edit.russian}`;
    const button = document.createElement("button"); button.type = "button"; button.textContent = "Изменить";
    button.addEventListener("click", () => openWordEditor({ ...edit, number: edit.baseNumber || edit.id, custom: !edit.baseNumber }));
    copy.append(word, meta); item.append(copy, button); host.appendChild(item);
  });
  if (!edits.length) {
    const empty = document.createElement("div"); empty.className = "source-note"; empty.textContent = "Пока нет пользовательских изменений."; host.appendChild(empty);
  }
}

function exportBackup() {
  const backup = { schema: "bishun-backup-v1", createdAt: new Date().toISOString(), dataVersion: DATA_VERSION, edits: getAdminEdits(), progress };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a"); link.href = url; link.download = `bishun-backup-${todayKey()}.json`; document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast("Резервная копия готова");
}

async function importBackup(file) {
  if (!file) return;
  try {
    const backup = JSON.parse(await file.text());
    if (backup.schema !== "bishun-backup-v1" || !Array.isArray(backup.edits)) throw new Error("bad schema");
    admin.saveLocalEdits(backup.edits);
    if (backup.progress?.completed) {
      // Импорт не затирает текущее: берём наибольшее по каждому знаку.
      progress = mergeProgress(progress, backup.progress);
      saveProgress();
      sync.enqueue({
        kind: "snapshot",
        completed: progress.completed,
        attemptsTotal: progress.attempts,
        cleanTotal: progress.cleanAttempts,
        days: progress.days,
        lastSession: progress.lastSession,
        lastLevel: progress.lastLevel,
        lastChar: progress.lastChar,
        settings: progress.settings,
      });
    }
    renderAdminChanges();
    showToast("Копия импортирована и объединена");
  } catch (_) {
    showToast("Это не резервная копия Chinese Characters · HSK Levels");
  } finally {
    $("importAdminInput").value = "";
  }
}

function resumeLastSession() {
  const last = progress.lastSession;
  if (!last) return;
  if (last.kind === "strokes") startStrokeSession();
  else if (last.kind === "rules") startRuleSession();
  else if (last.kind === "radicals") { activeRadicalDay = last.day || 1; startRadicalSession(RADICALS.filter((item) => item.day === activeRadicalDay), `Ключи · день ${activeRadicalDay}`); }
  else if (last.kind === "hsk") startHskLevel(last.level);
}

// --- вход в аккаунт -------------------------------------------------------

async function handleAuthAction(action) {
  const email = $("authEmail")?.value.trim();
  const password = $("authPassword")?.value;
  const message = $("authMessage");
  message.textContent = "";
  message.className = "form-message";
  try {
    if (action === "google") { await sync.signInWithGoogle(); return; }
    if (!email) { message.textContent = "Укажите электронную почту"; return; }
    if (action === "link") {
      await sync.sendMagicLink(email);
      message.textContent = "Ссылка для входа отправлена на почту";
      return;
    }
    if (!password || password.length < 6) { message.textContent = "Пароль от 6 символов"; return; }
    if (action === "signup") {
      await sync.signUpWithPassword(email, password);
      message.textContent = "Проверьте почту и подтвердите адрес";
      return;
    }
    await sync.signInWithPassword(email, password);
    message.textContent = "Вход выполнен";
  } catch (error) {
    message.className = "form-message error";
    message.textContent = error?.message || "Не удалось войти";
  }
}

// --- события --------------------------------------------------------------

function wireEvents() {
  $("homeButton").addEventListener("click", () => showView("homeView"));
  document.querySelectorAll("[data-back-home]").forEach((button) => button.addEventListener("click", () => showView("homeView")));
  $("verificationButton").addEventListener("click", () => { renderVerification(); showView("verificationView"); });
  $("continueCard").addEventListener("click", resumeLastSession);
  $("progressButton").addEventListener("click", () => showView("progressView"));
  $("settingsButton").addEventListener("click", () => showView("settingsView"));
  $("adminButton").addEventListener("click", () => { configureAdminGate(); showView("adminView"); });
  document.querySelectorAll("[data-stage]").forEach((button) => button.addEventListener("click", () => {
    const stage = button.dataset.stage;
    if (stage === "strokes") startStrokeSession();
    if (stage === "rules") { renderRules(); showView("rulesView"); }
    if (stage === "radicals") { renderRadicalDays(); renderRadicals(); showView("radicalsView"); }
    if (stage === "hsk") { renderHskLevels(); showView("hskView"); }
  }));
  $("startRulesButton").addEventListener("click", startRuleSession);
  $("startRadicalsButton").addEventListener("click", () => startRadicalSession(RADICALS.filter((item) => item.day === activeRadicalDay), `Ключи · день ${activeRadicalDay}`));
  $("practiceBackButton").addEventListener("click", () => { try { writer?.cancelQuiz(); } catch (_) {} showView(session?.returnView || "homeView"); if (session?.returnView === "hskView") renderHskLevels(); });
  $("animateButton").addEventListener("click", animateCurrentCharacter);
  $("retryButton").addEventListener("click", renderPracticeItem);
  $("skipButton").addEventListener("click", skipPracticeItem);
  $("nextButton").addEventListener("click", nextPracticeStep);
  $("charSpeak").addEventListener("click", () => { audio.unlockAudio(); audio.speak(currentItem()?.char); });
  $("charSpeakSlow").addEventListener("click", () => { audio.unlockAudio(); audio.speak(currentItem()?.char, { slow: true }); });

  let searchTimer = null;
  $("vocabularySearch").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(handleVocabularySearch, 180); });

  $("resetProgressButton").addEventListener("click", () => {
    if (!confirm("Сбросить весь учебный прогресс на этом устройстве? Резервная копия и правки словаря останутся.")) return;
    progress = { ...defaultProgress(), settings: progress.settings };
    saveProgress(); renderProgressView(); showToast("Прогресс сброшен");
  });
  $("restoreBackupButton").addEventListener("click", () => {
    const backup = restoreBackup();
    if (!backup) { showToast("Резервной копии нет"); return; }
    progress = mergeProgress(progress, backup);
    saveProgress(); renderProgressView(); showToast("Прогресс восстановлен из резервной копии");
  });

  $("adminGateForm").addEventListener("submit", submitAdminGate);
  $("adminLockButton").addEventListener("click", () => { admin.lockAdmin(); adminUnlocked = false; configureAdminGate(); });
  $("newWordButton").addEventListener("click", () => openWordEditor());
  $("closeEditorButton").addEventListener("click", () => $("wordEditor").classList.add("hidden"));
  $("wordEditor").addEventListener("submit", submitWordEditor);
  $("deleteCustomButton").addEventListener("click", deleteCurrentEdit);
  $("exportAdminButton").addEventListener("click", exportBackup);
  $("importAdminInput").addEventListener("change", (event) => importBackup(event.target.files?.[0]));
  let adminSearchTimer = null;
  $("adminSearch").addEventListener("input", () => { clearTimeout(adminSearchTimer); adminSearchTimer = setTimeout(handleAdminSearch, 180); });

  $("writingBoard").addEventListener("pointerdown", (event) => {
    audio.unlockAudio();
    const label = event.pointerType === "pen" ? "Apple Pencil" : event.pointerType === "mouse" ? "Мышка" : "Палец";
    $("inputBadge").textContent = label;
  }, { passive: true });
  // На iPhone и iPad рисование не должно прокручивать страницу.
  $("writingBoard").addEventListener("touchmove", (event) => event.preventDefault(), { passive: false });
  document.addEventListener("pointerdown", () => audio.unlockAudio(), { once: true, passive: true });

  document.querySelectorAll("[data-theme-option]").forEach((button) => {
    button.addEventListener("click", () => {
      applySettings({ ...progress.settings, theme: button.dataset.themeOption });
      renderSettings();
      pushSettings();
    });
  });
  $("settingAutoSpeak").addEventListener("change", (event) => {
    applySettings({ ...progress.settings, autoSpeak: event.target.checked }); pushSettings();
  });
  $("settingMuted").addEventListener("change", (event) => {
    applySettings({ ...progress.settings, muted: event.target.checked }); pushSettings();
  });
  $("settingVolume").addEventListener("input", (event) => {
    const volume = Number(event.target.value) / 100;
    $("settingVolumeValue").textContent = `${event.target.value}%`;
    applySettings({ ...progress.settings, volume });
  });
  $("settingVolume").addEventListener("change", pushSettings);
  $("settingMotion").addEventListener("change", (event) => {
    applySettings({ ...progress.settings, motion: event.target.checked ? "reduced" : "auto" }); pushSettings();
  });
  $("settingVolumeTest").addEventListener("click", () => { audio.unlockAudio(); audio.speak("你好"); });

  $("authGoogle").addEventListener("click", () => handleAuthAction("google"));
  $("authSignIn").addEventListener("click", () => handleAuthAction("signin"));
  $("authSignUp").addEventListener("click", () => handleAuthAction("signup"));
  $("authMagicLink").addEventListener("click", () => handleAuthAction("link"));
  $("authGuest").addEventListener("click", () => { showToast("Занимаемся без аккаунта — прогресс останется на этом устройстве"); showView("homeView"); });
  $("signOutButton").addEventListener("click", async () => { await sync.signOut(); renderSettings(); showToast("Выход выполнен, локальный прогресс на месте"); });
  $("syncBadge").addEventListener("click", () => { if (sync.status === "error") sync.syncNow(); });

  window.addEventListener("resize", handleViewportChange);
  window.addEventListener("orientationchange", () => setTimeout(handleViewportChange, 160));
  window.visualViewport?.addEventListener("resize", handleViewportChange);
  window.addEventListener("online", updateOfflineState);
  window.addEventListener("offline", updateOfflineState);
  window.matchMedia?.("(prefers-color-scheme: light)").addEventListener?.("change", () => {
    if ((progress.settings?.theme || "dark") === "system") applyTheme("system");
  });
}

function pushSettings() {
  sync.enqueue({ kind: "settings", settings: progress.settings });
}

function updateOfflineState() {
  $("offlineBanner").classList.toggle("hidden", navigator.onLine);
}

async function init() {
  progress = normalizeProgress(progress);
  applySettings(progress.settings, { persist: false });
  syncViewportHeight();
  wireEvents();
  observeBoard();
  renderHomeProgress();
  renderRadicalDays();
  renderRadicals();
  renderRules();
  updateOfflineState();
  renderSettings();

  sync.on("status", updateSyncBadge);
  sync.on("auth", () => { renderSettings(); renderHomeProgress(); });
  updateSyncBadge({ status: navigator.onLine ? "saved" : "offline" });
  sync.start();

  loadCharacters();
  admin.fetchServerEdits().then((edits) => {
    if (edits) { serverEdits = edits; renderAdminChanges(); }
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register(`service-worker.js?v=${CONFIG.appVersion}`).catch(() => {});
  }
}

init();

// Для автотестов: без этого e2e пришлось бы кликать по внутренним состояниям.
window.__hsk = {
  get progress() { return progress; },
  get session() { return session; },
  sync, audio, motion,
  openWordCard, closeWordCard,
  startHskLevel, startSingleCharacter,
  completeCurrentItem: (mistakes = 0) => completeCurrentItem(mistakes),
  showView,
  backendReady,
};
