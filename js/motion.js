// Анимации: короткие, только transform и opacity, с уважением к prefers-reduced-motion.

const query = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
let forced = null;   // 'reduced' | 'auto' | null

export function setMotionPreference(value) {
  forced = value === "reduced" ? "reduced" : value === "auto" ? "auto" : null;
  document.documentElement.dataset.motion = reducedMotion() ? "reduced" : "full";
}

export function reducedMotion() {
  if (forced === "reduced") return true;
  if (forced === "auto") return Boolean(query?.matches);
  return Boolean(query?.matches);
}

query?.addEventListener?.("change", () => {
  document.documentElement.dataset.motion = reducedMotion() ? "reduced" : "full";
});

/** Пошаговое появление карточек: задержка задаётся переменной, а не таймерами. */
export function stagger(nodes, step = 45, max = 10) {
  const list = [...nodes];
  list.forEach((node, index) => {
    node.style.setProperty("--stagger", `${Math.min(index, max) * (reducedMotion() ? 0 : step)}ms`);
    node.classList.add("will-enter");
  });
  requestAnimationFrame(() => requestAnimationFrame(() => {
    list.forEach((node) => node.classList.add("entered"));
  }));
}

/** Плавный счётчик. При сокращённом движении сразу ставит конечное значение. */
export function countTo(node, value, { duration = 320, format = (v) => String(Math.round(v)) } = {}) {
  if (!node) return;
  const target = Number(value) || 0;
  const from = Number(node.dataset.countValue ?? node.textContent.replace(/[^\d.-]/g, "")) || 0;
  node.dataset.countValue = String(target);
  if (reducedMotion() || from === target || duration <= 0) {
    node.textContent = format(target);
    return;
  }
  const start = performance.now();
  const tick = (now) => {
    const progress = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    node.textContent = format(from + (target - from) * eased);
    if (progress < 1 && node.dataset.countValue === String(target)) requestAnimationFrame(tick);
    else if (node.dataset.countValue === String(target)) node.textContent = format(target);
  };
  requestAnimationFrame(tick);
}

/** Заполнение полосы прогресса — через transform, без пересчёта раскладки. */
export function fillTrack(node, ratio) {
  if (!node) return;
  node.style.transform = `scaleX(${Math.max(0, Math.min(1, ratio))})`;
}

/** Кольцо прогресса: анимируем conic-gradient через собственное свойство. */
export function fillRing(node, percent) {
  if (!node) return;
  node.style.setProperty("--ring", `${Math.max(0, Math.min(100, percent))}%`);
}

/** Короткая волна «чернильной кисти» после правильного написания. */
export function inkPulse(host) {
  if (!host || reducedMotion()) return;
  const wave = document.createElement("span");
  wave.className = "ink-wave";
  wave.setAttribute("aria-hidden", "true");
  host.appendChild(wave);
  wave.addEventListener("animationend", () => wave.remove(), { once: true });
  setTimeout(() => wave.remove(), 900);
}

export function celebrate(host) {
  if (!host || reducedMotion()) return;
  host.classList.remove("celebrate");
  void host.offsetWidth;
  host.classList.add("celebrate");
  setTimeout(() => host.classList.remove("celebrate"), 900);
}
