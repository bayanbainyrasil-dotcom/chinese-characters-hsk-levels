// Подробная карточка слова: модальное окно на компьютере и bottom sheet на
// телефоне и iPad. Закрывается кнопкой, нажатием вне карточки, клавишей Escape
// и системной кнопкой «Назад». Фокус остаётся внутри окна, пока оно открыто.

import { breakdown, loadCharacters } from "./dictionary.js";
import { speak, stop, onAudioState, isPlaying } from "./audio.js";
import { reducedMotion, stagger } from "./motion.js";

const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
const HISTORY_MARK = "word-card";

let root = null;
let panel = null;
let lastFocus = null;
let openState = null;
let onCharacter = null;
let onPractice = null;
let pushedHistory = false;
let audioUnsubscribe = null;

function build() {
  if (root) return root;
  root = document.createElement("div");
  root.className = "word-sheet";
  root.id = "wordSheet";
  root.hidden = true;
  root.innerHTML = `
    <div class="word-sheet-backdrop" data-close></div>
    <div class="word-sheet-panel" role="dialog" aria-modal="true" aria-labelledby="wordSheetWord" tabindex="-1">
      <div class="word-sheet-grab" aria-hidden="true"></div>
      <button class="word-sheet-close" type="button" data-close aria-label="Закрыть карточку слова">✕</button>
      <div class="word-sheet-scroll">
        <div class="word-sheet-head">
          <span class="word-sheet-word" id="wordSheetWord" lang="zh-Hans"></span>
          <span class="word-sheet-pinyin" id="wordSheetPinyin"></span>
          <p class="word-sheet-translation" id="wordSheetTranslation"></p>
          <div class="word-sheet-meta" id="wordSheetMeta"></div>
        </div>
        <div class="word-sheet-audio">
          <button class="speak-button" type="button" id="wordSheetPlay">
            <span class="speak-icon" aria-hidden="true"></span><span>Произнести</span>
          </button>
          <button class="speak-button ghost" type="button" id="wordSheetPlaySlow">
            <span class="speak-icon slow" aria-hidden="true"></span><span>Медленно</span>
          </button>
        </div>
        <div class="section-label" id="wordSheetBreakdownLabel"><span>Разбор по знакам</span><span id="wordSheetCount"></span></div>
        <div class="char-list" id="wordSheetChars"></div>
        <button class="primary-button hidden" type="button" id="wordSheetPractice">Писать это слово по знакам</button>
        <p class="source-note" id="wordSheetNote"></p>
      </div>
    </div>`;
  document.body.appendChild(root);
  panel = root.querySelector(".word-sheet-panel");

  root.addEventListener("click", (event) => {
    if (event.target.closest("[data-close]")) close();
  });
  root.querySelector("#wordSheetPlay").addEventListener("click", () => {
    if (isPlaying()) { stop(); return; }
    speak(openState?.word, { slow: false });
  });
  root.querySelector("#wordSheetPlaySlow").addEventListener("click", () => {
    speak(openState?.word, { slow: true });
  });
  root.querySelector("#wordSheetPractice").addEventListener("click", () => {
    const row = openState;
    if (!onPractice || !row) return;
    close();
    onPractice(row);
  });
  document.addEventListener("keydown", handleKeydown);
  window.addEventListener("popstate", handlePopState);
  enableSwipeToClose();
  return root;
}

function handleKeydown(event) {
  if (root?.hidden) return;
  if (event.key === "Escape") { event.preventDefault(); close(); return; }
  if (event.key !== "Tab") return;
  const nodes = [...panel.querySelectorAll(FOCUSABLE)].filter((node) => node.offsetParent !== null);
  if (!nodes.length) return;
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

function handlePopState(event) {
  if (!root?.hidden && (!event.state || event.state.sheet !== HISTORY_MARK)) {
    pushedHistory = false;
    close({ skipHistory: true });
  }
}

function enableSwipeToClose() {
  let startY = 0;
  let delta = 0;
  let dragging = false;
  const start = (event) => {
    if (window.innerWidth > 900) return;
    if (!event.target.closest(".word-sheet-grab, .word-sheet-head")) return;
    dragging = true; startY = event.clientY; delta = 0;
    panel.style.transition = "none";
  };
  const move = (event) => {
    if (!dragging) return;
    delta = Math.max(0, event.clientY - startY);
    panel.style.transform = `translate3d(0, ${delta}px, 0)`;
  };
  const end = () => {
    if (!dragging) return;
    dragging = false;
    panel.style.transition = "";
    panel.style.transform = "";
    if (delta > 110) close();
  };
  panel.addEventListener("pointerdown", start, { passive: true });
  panel.addEventListener("pointermove", move, { passive: true });
  panel.addEventListener("pointerup", end);
  panel.addEventListener("pointercancel", end);
}

function renderAudioState() {
  if (!root) return;
  const button = root.querySelector("#wordSheetPlay");
  const playing = isPlaying();
  button?.classList.toggle("playing", playing);
  button?.setAttribute("aria-label", playing ? "Остановить произношение" : `Произнести ${openState?.word || "слово"}`);
}

/**
 * @param {{word:string, pinyin:string, russian:string, level?:string, partOfSpeech?:string}} row
 * @param {{onCharacter?:(char:string)=>void}} options
 */
export async function openWordCard(row, options = {}) {
  if (!row?.word) return;
  build();
  onCharacter = options.onCharacter || null;
  onPractice = options.onPractice || null;
  openState = row;
  lastFocus = document.activeElement;

  await loadCharacters();
  const parts = breakdown(row.word, row.pinyin);

  root.querySelector("#wordSheetWord").textContent = row.word;
  root.querySelector("#wordSheetPinyin").textContent = row.pinyin || "";
  root.querySelector("#wordSheetTranslation").textContent = row.russian || "Перевод пока не задан";

  const meta = root.querySelector("#wordSheetMeta");
  meta.replaceChildren();
  if (row.level) {
    const badge = document.createElement("span");
    badge.className = "level-badge";
    badge.textContent = `HSK ${row.level}`;
    meta.appendChild(badge);
  }
  if (row.partOfSpeech) {
    const badge = document.createElement("span");
    badge.className = "pos-badge";
    badge.textContent = row.partOfSpeech;
    badge.title = "Часть речи";
    meta.appendChild(badge);
  }

  root.querySelector("#wordSheetCount").textContent = parts.length ? `${parts.length}` : "";
  const host = root.querySelector("#wordSheetChars");
  host.replaceChildren();
  for (const part of parts) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "char-row";
    button.setAttribute("aria-label", `${part.char} — ${part.pinyin}${part.meaning ? `, ${part.meaning}` : ""}. Перейти к письму`);
    const char = document.createElement("span");
    char.className = "char-row-char";
    char.lang = "zh-Hans";
    char.textContent = part.char;
    const copy = document.createElement("span");
    copy.className = "char-row-copy";
    const reading = document.createElement("strong");
    reading.textContent = part.pinyin || "—";
    const meaning = document.createElement("small");
    meaning.textContent = part.meaning || "значение уточняется";
    copy.append(reading, meaning);
    const sound = document.createElement("span");
    sound.className = "char-row-sound";
    sound.setAttribute("aria-hidden", "true");
    const go = document.createElement("span");
    go.className = "char-row-go";
    go.setAttribute("aria-hidden", "true");
    go.textContent = "Писать →";
    button.append(char, copy, sound, go);
    button.addEventListener("click", () => {
      speak(part.char, { slow: false });
      if (onCharacter) { close(); onCharacter(part.char); }
    });
    host.appendChild(button);
  }

  // Для одного знака разбор дублировал бы карточку — прячем его.
  const single = parts.length < 2;
  root.querySelector("#wordSheetBreakdownLabel").classList.toggle("hidden", single);
  host.classList.toggle("hidden", single);

  const practice = root.querySelector("#wordSheetPractice");
  practice.classList.toggle("hidden", !onPractice);
  practice.textContent = single ? "Писать этот знак" : "Писать это слово по знакам";

  const note = root.querySelector("#wordSheetNote");
  note.textContent = single
    ? ""
    : parts.some((part) => !part.meaning)
      ? "Часть значений ещё не заполнена в словаре знаков."
      : "Чтение каждого знака взято из этого слова, а не из общего пиньиня.";

  root.hidden = false;
  document.body.classList.add("sheet-open");
  requestAnimationFrame(() => root.classList.add("open"));
  if (!reducedMotion()) stagger(host.querySelectorAll(".char-row"), 40);
  panel.focus({ preventScroll: true });

  if (!pushedHistory) {
    history.pushState({ sheet: HISTORY_MARK }, "", "");
    pushedHistory = true;
  }
  audioUnsubscribe?.();
  audioUnsubscribe = onAudioState(renderAudioState);
  renderAudioState();
}

export function close({ skipHistory = false } = {}) {
  if (!root || root.hidden) return;
  stop();
  audioUnsubscribe?.();
  audioUnsubscribe = null;
  root.classList.remove("open");
  document.body.classList.remove("sheet-open");
  const finish = () => { root.hidden = true; };
  if (reducedMotion()) finish();
  else setTimeout(finish, 200);
  openState = null;
  if (pushedHistory && !skipHistory) {
    pushedHistory = false;
    history.back();
  }
  pushedHistory = false;
  if (lastFocus?.isConnected) lastFocus.focus({ preventScroll: true });
}

export function isOpen() { return Boolean(root) && !root.hidden; }
