(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const VIEW_IDS = ["homeView", "verificationView", "rulesView", "radicalsView", "hskView", "practiceView", "progressView", "adminView"];
  const PROGRESS_KEY = "bishun_hsk30_progress_v1";
  const ADMIN_PIN_KEY = "bishun_hsk30_admin_pin_v1";
  const ADMIN_EDITS_KEY = "bishun_hsk30_admin_edits_v1";
  const DATA_VERSION = "hsk30-2026-official-pinyin-1";
  const DEFAULT_ADMIN_PIN_HASH = "42e5989796d0368b3b4eb79e65251d2c31610fd9b2d4f3aff5106445e94cb49f";

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

  const DEFAULT_PROGRESS = () => ({
    version: 1,
    completed: { strokes: {}, rules: {}, radicals: {}, hsk: {} },
    attempts: 0,
    cleanAttempts: 0,
    days: [],
    lastSession: null,
  });

  let progress = loadJson(PROGRESS_KEY, DEFAULT_PROGRESS());
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

  function loadJson(key, fallback) {
    try {
      const parsed = JSON.parse(localStorage.getItem(key));
      return parsed && typeof parsed === "object" ? parsed : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function saveProgress() {
    try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress)); } catch (_) { /* private mode */ }
    renderHomeProgress();
  }

  function todayKey() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  }

  function showView(id) {
    if (!VIEW_IDS.includes(id)) return;
    previousView = currentView;
    currentView = id;
    VIEW_IDS.forEach((viewId) => $(viewId).classList.toggle("hidden", viewId !== id));
    document.body.dataset.view = id;
    window.scrollTo({ top: 0, behavior: "auto" });
    if (id === "homeView") renderHomeProgress();
    if (id === "progressView") renderProgressView();
  }

  function showToast(message) {
    clearTimeout(toastTimer);
    $("toast").textContent = message;
    $("toast").classList.remove("hidden");
    toastTimer = setTimeout(() => $("toast").classList.add("hidden"), 2600);
  }

  function completedCount(bucket, goal = 1) {
    const values = Object.values(progress.completed[bucket] || {});
    return values.reduce((total, value) => total + (Number(value) >= goal ? 1 : 0), 0);
  }

  function officialHskCompletedCount() {
    const allowed = /^(1-2|3|4|5|6|7-9):/;
    return Object.entries(progress.completed.hsk || {}).reduce((total, [key, value]) => total + (allowed.test(key) && Number(value) >= 5 ? 1 : 0), 0);
  }

  function renderHomeProgress() {
    const totals = { strokes: 8, rules: 10, radicals: 50, hsk: 1200 };
    const goals = { strokes: 1, rules: 1, radicals: 1, hsk: 5 };
    for (const [bucket, total] of Object.entries(totals)) {
      const count = bucket === "hsk" ? officialHskCompletedCount() : completedCount(bucket, goals[bucket]);
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
      row.innerHTML = `<strong>HSK ${level}</strong><div class="audit-track"><span style="width:${ratio}%"></span></div><small>${supplied[level]} / ${official[level]}</small>`;
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
  }

  function renderRadicalDays() {
    const host = $("radicalDays");
    host.replaceChildren();
    for (let day = 1; day <= 4; day += 1) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `chip${day === activeRadicalDay ? " active" : ""}`;
      button.textContent = `День ${day}`;
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
  }

  async function loadWritingData() {
    if (!writingDataPromise) {
      writingDataPromise = fetch(`data/writing.json?v=${DATA_VERSION}`, { cache: "no-store" }).then((response) => {
        if (!response.ok) throw new Error("writing data unavailable");
        return response.json();
      });
    }
    return writingDataPromise;
  }

  async function loadVocabularyData() {
    if (!vocabularyDataPromise) {
      vocabularyDataPromise = fetch(`data/vocabulary.json?v=${DATA_VERSION}`, { cache: "no-store" }).then((response) => {
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
      const button = document.createElement("button");
      button.type = "button";
      button.className = "level-card";
      button.innerHTML = `<strong>${level.label}</strong><span>${level.count} знаков</span><small>${completedForHskLevel(level.key)} изучено</small><span class="level-percent">${Math.round(completedForHskLevel(level.key) / level.count * 100)}%</span>`;
      button.addEventListener("click", () => startHskLevel(level.key));
      host.appendChild(button);
    });
  }

  function completedForHskLevel(level) {
    const prefix = `${level}:`;
    return Object.entries(progress.completed.hsk || {}).reduce((total, [key, value]) => total + (key.startsWith(prefix) && Number(value) >= 5 ? 1 : 0), 0);
  }

  function startSession(config) {
    const items = config.items.filter((item) => item?.char);
    if (!items.length) { showToast("В этом наборе пока нет упражнений"); return; }
    session = { ...config, items, index: 0, repeatGoal: config.repeatGoal || 1 };
    const bucket = progress.completed[session.bucket] || (progress.completed[session.bucket] = {});
    const firstIncomplete = items.findIndex((item) => Number(bucket[progressKeyFor(item)] || 0) < session.repeatGoal);
    session.index = firstIncomplete >= 0 ? firstIncomplete : 0;
    progress.lastSession = config.lastSession || null;
    if (!progress.days.includes(todayKey())) progress.days.push(todayKey());
    saveProgress();
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
    $("progressFill").style.width = `${(session.index / session.items.length) * 100}%`;
    $("lessonKicker").textContent = item.kicker || session.title;
    $("lessonTitle").textContent = item.title || item.char;
    $("lessonHint").textContent = item.hint || "Смотри порядок, затем напиши сам.";
    $("characterLabel").textContent = item.char;
    $("pinyinLabel").textContent = item.pinyin || "";
    $("meaningLabel").textContent = item.meaning || "";
    $("feedback").className = "feedback";
    $("feedback").textContent = "Напишите иероглиф";
    $("nextButton").classList.add("hidden");
    renderExamples(item.examples || []);
    renderRepeatDots();
    buildWriter(item.char);
  }

  function renderExamples(examples) {
    const host = $("exampleList");
    host.replaceChildren();
    examples.slice(0, 3).forEach((example) => {
      const pill = document.createElement("span");
      pill.className = "example-pill";
      pill.textContent = example[2] ? `${example[0]} · ${example[2]}` : example[0];
      host.appendChild(pill);
    });
  }

  function renderRepeatDots() {
    const host = $("repeatRow");
    host.replaceChildren();
    if (!session || session.repeatGoal <= 1) return;
    const completed = currentRepetitions();
    for (let index = 0; index < session.repeatGoal; index += 1) {
      const dot = document.createElement("span");
      dot.className = `repeat-dot${index < completed ? " done" : ""}`;
      host.appendChild(dot);
    }
  }

  function boardSize() {
    const rect = $("writingBoard").getBoundingClientRect();
    return Math.max(200, Math.round(rect.width || 0));
  }

  function boardPadding(size) {
    return Math.max(10, Math.round(size * 0.045));
  }

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
    if (height > 0) document.documentElement.style.setProperty("--vh", `${height / 100}px`);
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

  function buildWriter(character) {
    writerToken += 1;
    const token = writerToken;
    try { writer?.cancelQuiz(); } catch (_) { /* no active quiz */ }
    writer = null;
    const target = $("hanziTarget");
    target.replaceChildren();
    $("boardLoading").textContent = "Загрузка иероглифа…";
    $("boardLoading").classList.remove("hidden");
    $("animateButton").disabled = true;
    $("retryButton").disabled = true;
    if (!window.HanziWriter) {
      $("boardLoading").textContent = "Библиотека письма не загрузилась";
      return;
    }
    const size = boardSize();
    lastBoardSize = size;
    try {
      writer = HanziWriter.create(target, character, {
        width: size, height: size, padding: boardPadding(size),
        showCharacter: false, showOutline: true,
        strokeColor: "#17191d", outlineColor: "#d8d0be",
        drawingColor: "#c74831", drawingWidth: Math.max(14, Math.round(size / 18)),
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
    saveProgress();
    renderRepeatDots();
    const repetitions = currentRepetitions(item);
    const finishedItem = repetitions >= session.repeatGoal;
    $("feedback").className = "feedback success";
    $("feedback").textContent = totalMistakes === 0 ? "Чисто, без ошибок" : `Написано · ошибок: ${totalMistakes}`;
    $("nextButton").textContent = finishedItem ? "Следующий знак" : `Повторить · ${repetitions}/${session.repeatGoal}`;
    $("nextButton").classList.remove("hidden");
    $("progressFill").style.width = `${((session.index + (finishedItem ? 1 : 0)) / session.items.length) * 100}%`;
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
    try { writer?.cancelQuiz(); } catch (_) { /* no quiz */ }
    writer = null;
    showView(destination);
    if (destination === "hskView") renderHskLevels();
    showToast(`${title}: занятие завершено`);
  }

  function animateCurrentCharacter() {
    if (!writer) return;
    const token = writerToken;
    try { writer.cancelQuiz(); } catch (_) { /* no quiz */ }
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

  function foldText(value) {
    return String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
  }

  function getAdminEdits() {
    const edits = loadJson(ADMIN_EDITS_KEY, []);
    return Array.isArray(edits) ? edits : [];
  }

  function saveAdminEdits(edits) {
    localStorage.setItem(ADMIN_EDITS_KEY, JSON.stringify(edits));
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
      const word = document.createElement("span"); word.className = "word"; word.textContent = row.word;
      const details = document.createElement("span"); details.className = "details";
      const pinyin = document.createElement("strong"); pinyin.textContent = row.pinyin || "";
      const meaning = document.createElement("small"); meaning.textContent = row.russian || "Без перевода";
      const level = document.createElement("span"); level.className = "level"; level.textContent = `HSK ${row.level}`;
      details.append(pinyin, meaning); button.append(word, details, level);
      button.addEventListener("click", () => onSelect(row));
      host.appendChild(button);
    });
  }

  async function handleVocabularySearch() {
    const query = $("vocabularySearch").value.trim();
    if (!query) { $("searchResults").replaceChildren(); $("searchMeta").textContent = "Поиск по 11 000 официальных слов"; return; }
    $("searchMeta").textContent = "Ищу…";
    try {
      await loadVocabularyData();
      const rows = searchVocabulary(query, 24);
      $("searchMeta").textContent = rows.length ? `Найдено: ${rows.length}${rows.length === 24 ? "+" : ""}` : "Ничего не найдено";
      renderWordResults($("searchResults"), rows, startWordSession);
    } catch (_) {
      $("searchMeta").textContent = "Не удалось загрузить словарь";
    }
  }

  function renderProgressView() {
    const mastered = officialHskCompletedCount();
    const percent = Math.round(mastered / 1200 * 100);
    $("totalMastered").textContent = mastered;
    $("progressPercent").textContent = `${percent}%`;
    $("progressRing").style.background = `conic-gradient(var(--green) ${percent}%, var(--surface-2) ${percent}%)`;
    $("totalAttempts").textContent = progress.attempts || 0;
    $("cleanAttempts").textContent = progress.cleanAttempts || 0;
    $("practiceDays").textContent = progress.days?.length || 0;
    const sections = [
      ["Черты", completedCount("strokes", 1), 8], ["Правила", completedCount("rules", 1), 10], ["Ключи", completedCount("radicals", 1), 50], ["HSK письмо", mastered, 1200],
    ];
    const host = $("progressList"); host.replaceChildren();
    sections.forEach(([label, value, total]) => {
      const item = document.createElement("div"); item.className = "progress-item";
      item.innerHTML = `<div class="progress-item-head"><strong>${label}</strong><span>${value} / ${total}</span></div><div class="mini-track"><span style="width:${Math.min(100, value / total * 100)}%"></span></div>`;
      host.appendChild(item);
    });
  }

  async function hashPin(pin) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${pin}:bishun-local-admin`));
    return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function configureAdminGate() {
    $("adminGateTitle").textContent = "Вход в управление";
    $("adminGateText").textContent = "Введите четырёхзначный PIN администратора.";
    $("adminPinConfirm").classList.add("hidden");
    $("adminPinConfirm").required = false;
    $("adminGateSubmit").textContent = "Войти";
    $("adminGate").classList.toggle("hidden", adminUnlocked);
    $("adminPanel").classList.toggle("hidden", !adminUnlocked);
    if (adminUnlocked) renderAdminChanges();
  }

  async function submitAdminGate(event) {
    event.preventDefault();
    const pin = $("adminPin").value;
    const stored = localStorage.getItem(ADMIN_PIN_KEY) || DEFAULT_ADMIN_PIN_HASH;
    $("adminGateMessage").textContent = "";
    if (pin.length < 4) { $("adminGateMessage").textContent = "Минимум 4 цифры"; return; }
    const hash = await hashPin(pin);
    if (stored === hash) {
      if (!localStorage.getItem(ADMIN_PIN_KEY)) localStorage.setItem(ADMIN_PIN_KEY, DEFAULT_ADMIN_PIN_HASH);
      adminUnlocked = true;
    } else {
      $("adminGateMessage").textContent = "Неверный PIN";
      return;
    }
    $("adminPin").value = ""; $("adminPinConfirm").value = "";
    configureAdminGate();
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
    $("wordEditor").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function submitWordEditor(event) {
    event.preventDefault();
    const reference = $("editorBaseNumber").value;
    const edits = getAdminEdits();
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
    vocabularyDataPromise && handleAdminSearch();
    showToast("Изменение сохранено");
  }

  function deleteCurrentEdit() {
    const reference = $("editorBaseNumber").value;
    if (!reference) return;
    const edits = getAdminEdits();
    const next = edits.filter((edit) => String(edit.id) !== reference && String(edit.baseNumber) !== reference);
    if (next.length === edits.length) { showToast("Для базового слова изменений ещё нет"); return; }
    saveAdminEdits(next);
    $("wordEditor").classList.add("hidden");
    showToast("Изменение отменено");
  }

  function renderAdminChanges() {
    const edits = getAdminEdits();
    $("adminChangeCount").textContent = edits.length;
    $("adminListCount").textContent = edits.length;
    const host = $("adminChangeList"); host.replaceChildren();
    edits.slice(0, 30).forEach((edit) => {
      const item = document.createElement("div"); item.className = "change-item";
      const copy = document.createElement("div");
      const word = document.createElement("strong"); word.textContent = edit.word;
      const meta = document.createElement("small"); meta.textContent = `HSK ${edit.level} · ${edit.russian}`;
      const button = document.createElement("button"); button.type = "button"; button.textContent = "Изменить"; button.addEventListener("click", () => openWordEditor({ ...edit, number: edit.baseNumber || edit.id, custom: !edit.baseNumber }));
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
      localStorage.setItem(ADMIN_EDITS_KEY, JSON.stringify(backup.edits));
      if (backup.progress?.completed) { progress = backup.progress; saveProgress(); }
      renderAdminChanges();
      showToast("Копия импортирована");
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

  function wireEvents() {
    $("homeButton").addEventListener("click", () => showView("homeView"));
    document.querySelectorAll("[data-back-home]").forEach((button) => button.addEventListener("click", () => showView("homeView")));
    $("verificationButton").addEventListener("click", () => { renderVerification(); showView("verificationView"); });
    $("continueCard").addEventListener("click", resumeLastSession);
    $("progressButton").addEventListener("click", () => showView("progressView"));
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
    let searchTimer = null;
    $("vocabularySearch").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(handleVocabularySearch, 180); });
    $("resetProgressButton").addEventListener("click", () => {
      if (!confirm("Сбросить весь учебный прогресс? Пользовательские слова останутся.")) return;
      progress = DEFAULT_PROGRESS(); saveProgress(); renderProgressView(); showToast("Прогресс сброшен");
    });
    $("adminGateForm").addEventListener("submit", submitAdminGate);
    $("adminLockButton").addEventListener("click", () => { adminUnlocked = false; configureAdminGate(); });
    $("newWordButton").addEventListener("click", () => openWordEditor());
    $("closeEditorButton").addEventListener("click", () => $("wordEditor").classList.add("hidden"));
    $("wordEditor").addEventListener("submit", submitWordEditor);
    $("deleteCustomButton").addEventListener("click", deleteCurrentEdit);
    $("exportAdminButton").addEventListener("click", exportBackup);
    $("importAdminInput").addEventListener("change", (event) => importBackup(event.target.files?.[0]));
    let adminSearchTimer = null;
    $("adminSearch").addEventListener("input", () => { clearTimeout(adminSearchTimer); adminSearchTimer = setTimeout(handleAdminSearch, 180); });
    $("writingBoard").addEventListener("pointerdown", (event) => {
      const label = event.pointerType === "pen" ? "Apple Pencil" : event.pointerType === "mouse" ? "Мышка" : "Палец";
      $("inputBadge").textContent = label;
    }, { passive: true });
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("orientationchange", () => setTimeout(handleViewportChange, 160));
    window.visualViewport?.addEventListener("resize", handleViewportChange);
    window.addEventListener("online", updateOfflineState);
    window.addEventListener("offline", updateOfflineState);
  }

  function updateOfflineState() {
    $("offlineBanner").classList.toggle("hidden", navigator.onLine);
  }

  async function init() {
    progress.completed ||= { strokes: {}, rules: {}, radicals: {}, hsk: {} };
    progress.completed.strokes ||= {}; progress.completed.rules ||= {}; progress.completed.radicals ||= {}; progress.completed.hsk ||= {};
    progress.days ||= [];
    syncViewportHeight();
    wireEvents();
    observeBoard();
    renderHomeProgress();
    renderRadicalDays();
    renderRadicals();
    renderRules();
    updateOfflineState();
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("service-worker.js").catch(() => {});
  }

  init();
})();
