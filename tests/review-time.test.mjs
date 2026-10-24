// Время и повторения: границы срока, полночь, часовые пояса, перевод часов,
// дубли и порядок событий, длительный перерыв.
// Время задаётся явно (поле at), часовой пояс — переменной TZ в отдельном
// процессе Node; системные часы не меняются.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHED = pathToFileURL(path.join(ROOT, "js/review-scheduler.js")).href;
const { replay, ready, planQueue, memoryStatus, DAY, MINUTE, LEARN_DELAY, INTERVALS } = await import(SCHED);

/** Выполняет функцию в процессе с заданным TZ; функция получает модуль расписания. */
function inZone(tz, fn, arg) {
  const src = `const m = await import(${JSON.stringify(SCHED)}); const f = ${fn.toString()}; process.stdout.write(JSON.stringify(await f(m, ${JSON.stringify(arg)})));`;
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", src], { env: { ...process.env, TZ: tz } }).toString());
}

let n = 0;
function ev(kind, at, extra = {}) {
  const id = `40000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const d = new Date(at);
  const day = extra.day ?? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  return { id, attemptId: id, char: "一", kind, mode: kind === "practice" ? "practice" : "learn", dueKey: "", grade: kind === "answer" ? "good" : null, assisted: false, mistakes: 0, at, day, device: "dev-a", durationMs: 1000, version: 1, ...extra };
}

/** Доводит знак до фазы review: знакомство, отработка, два разнесённых ответа. */
function toReview(t0) {
  const list = [ev("introduce", t0), ev("practice", t0 + 1000)];
  list.push(ev("answer", t0 + LEARN_DELAY + 1000));
  list.push(ev("introduce", t0 + LEARN_DELAY + 2000, { char: "二" }), ev("answer", t0 + LEARN_DELAY + 3000, { char: "二" }));
  list.push(ev("introduce", t0 + LEARN_DELAY + 4000, { char: "三" }), ev("answer", t0 + LEARN_DELAY + 5000, { char: "三" }));
  list.push(ev("answer", t0 + 2 * LEARN_DELAY + 6000));
  const card = replay(list)["一"];
  assert.equal(card.phase, "review", "подготовка: знак в фазе review");
  assert.equal(card.stage, 0);
  return { list, card };
}

const review = (at, extra = {}) => ev("answer", at, { mode: "review", dueKey: `一:${extra.stage ?? 0}:${at}`, ...extra });

test("граница срока: за миллисекунду до срока ответ не продвигает ступень, в срок — продвигает", () => {
  const { list, card } = toReview(Date.UTC(2026, 9, 1, 8));
  assert.equal(ready(card, list, card.dueAt - 1), false);
  assert.equal(ready(card, list, card.dueAt), true);
  const early = replay([...list, review(card.dueAt - 1)])["一"];
  assert.equal(early.stage, 0, "ранний ответ не засчитан как разнесённый");
  assert.deepEqual(early.successDays, []);
  const onTime = replay([...list, review(card.dueAt)])["一"];
  assert.equal(onTime.stage, 1);
  assert.equal(onTime.dueAt, card.dueAt + INTERVALS[0]);
});

test("полночь: ответы в 23:59 и 00:01 — разные даты, но второй не засчитывается как новый день", () => {
  const { list, card } = toReview(Date.UTC(2026, 9, 1, 8));
  const t1 = card.dueAt + 15 * 3600 * 1000; // вечер
  const a = review(t1, { day: "2026-10-02" });
  const b = review(t1 + 2 * MINUTE, { day: "2026-10-03" }); // через 2 минуты, уже другая дата
  const c = replay([...list, a, b])["一"];
  assert.equal(c.stage, 1, "второй ответ раньше срока — ступень не растёт");
  assert.deepEqual(c.successDays, ["2026-10-02"]);
});

test("дата события берётся с устройства: localDay в разных часовых поясах", () => {
  const at = Date.UTC(2026, 9, 24, 16, 30); // 16:30 UTC
  const days = Object.fromEntries(["UTC", "Asia/Shanghai", "Asia/Almaty", "America/Los_Angeles", "Europe/Berlin"].map((tz) => [tz, inZone(tz, (m, a) => m.localDay(a), at)]));
  assert.deepEqual(days, {
    UTC: "2026-10-24",
    "Asia/Shanghai": "2026-10-25",
    "Asia/Almaty": "2026-10-24",
    "America/Los_Angeles": "2026-10-24",
    "Europe/Berlin": "2026-10-24",
  });
});

test("результат расписания не зависит от часового пояса процесса", () => {
  const { list } = toReview(Date.UTC(2026, 9, 1, 8));
  const first = replay(list)["一"];
  const extra = [review(first.dueAt, { day: "2026-10-02" }), review(first.dueAt + INTERVALS[0], { day: "2026-10-03", stage: 1 })];
  const all = [...list, ...extra];
  const results = ["UTC", "Asia/Shanghai", "America/Los_Angeles"].map((tz) => inZone(tz, (m, events) => {
    const c = m.replay(events)["一"];
    return { stage: c.stage, dueAt: c.dueAt, successDays: c.successDays };
  }, all));
  assert.deepEqual(results[1], results[0]);
  assert.deepEqual(results[2], results[0]);
});

test("перевод часов (Europe/Berlin, 29.03.2026): срок — через 24 физических часа, по часам на час позже", () => {
  const out = inZone("Europe/Berlin", (m) => {
    const local = (y, mo, d, h) => new Date(y, mo - 1, d, h, 0, 0).getTime();
    const t0 = local(2026, 3, 28, 10);           // 10:00 CET, суббота
    const due = t0 + m.DAY;                       // срок интервала «1 день»
    const sameClock = local(2026, 3, 29, 10);     // 10:00 CEST, воскресенье — прошло 23 часа
    return {
      elapsedHours: (sameClock - t0) / 3600000,
      dueLocal: new Date(due).toString().slice(16, 24),
      dueDay: m.localDay(due),
      sameClockDay: m.localDay(sameClock),
      readyAtSameClock: sameClock >= due,
    };
  });
  assert.equal(out.elapsedHours, 23, "в весенний переход сутки короче");
  assert.equal(out.dueLocal, "11:00:00", "срок наступает в 11:00 по новому времени");
  assert.equal(out.dueDay, out.sameClockDay, "но в тот же календарный день");
  assert.equal(out.readyAtSameClock, false);
  // Осенний переход (25.10.2026): сутки длиннее, срок наступает на час раньше по часам.
  const autumn = inZone("Europe/Berlin", (m) => {
    const t0 = new Date(2026, 9, 24, 10).getTime();
    return new Date(t0 + m.DAY).toString().slice(16, 24);
  });
  assert.equal(autumn, "09:00:00");
});

test("перевод часов в расписании: ответ «в то же время по часам» после 23 часов не продвигает, через 24 — продвигает", () => {
  // Подготовка в Берлине: последний ответ этапа обучения 28.03 в 10:00 CET.
  const t0 = Date.UTC(2026, 2, 28, 9) - 2 * LEARN_DELAY - 6000;
  const { list, card } = toReview(t0);
  const sameClock = card.dueAt - 3600 * 1000; // 23 часа спустя
  const tooEarly = replay([...list, review(sameClock, { day: "2026-03-29" })])["一"];
  assert.equal(tooEarly.stage, 0);
  assert.equal(ready(card, list, sameClock), false, "в очереди знак ещё не появляется — нечего «терять»");
  const later = replay([...list, review(card.dueAt, { day: "2026-03-29" })])["一"];
  assert.equal(later.stage, 1);
  assert.deepEqual(later.successDays, ["2026-03-29"]);
});

test("ограничение 24 ч в successDays не мешает продвижению: при ответе в срок оно всегда выполнено", () => {
  // Перебираем ступени и ответы ровно в срок: каждый ответ добавляет день успеха.
  const { list, card } = toReview(Date.UTC(2026, 0, 5, 8));
  let events = [...list];
  let c = card;
  for (let s = 0; s < 6; s += 1) {
    const at = c.dueAt;
    const d = new Date(at);
    events = [...events, review(at, { day: d.toISOString().slice(0, 10), stage: s })];
    const next = replay(events)["一"];
    assert.equal(next.stage, s + 1);
    assert.equal(next.successDays.length, s + 1, `ступень ${s}: день успеха учтён`);
    c = next;
  }
  assert.equal(memoryStatus(c), "Устойчиво помню");
});

test("смена часового пояса при перелёте: новый день по дате устройства, но не раньше суток", () => {
  const { list, card } = toReview(Date.UTC(2026, 9, 1, 8));
  // ответ в Алматы (UTC+5) вечером, следующий — в Шанхае (UTC+8)
  const a = review(card.dueAt, { day: "2026-10-02", device: "almaty" });
  const c1 = replay([...list, a])["一"];
  const early = review(c1.dueAt - 2 * 3600 * 1000, { day: "2026-10-04", device: "shanghai", stage: 1 }); // по часам Шанхая «уже послезавтра», но сутки не прошли
  assert.equal(replay([...list, a, early])["一"].stage, 1);
  const onTime = review(c1.dueAt, { day: "2026-10-04", device: "shanghai", stage: 1 });
  const c2 = replay([...list, a, onTime])["一"];
  assert.equal(c2.stage, 2);
  assert.deepEqual(c2.successDays, ["2026-10-02", "2026-10-04"]);
});

test("повторные события и любой порядок поступления дают одинаковый результат", () => {
  const { list, card } = toReview(Date.UTC(2026, 9, 1, 8));
  const r1 = review(card.dueAt, { day: "2026-10-02" });
  const r2 = review(card.dueAt + INTERVALS[0], { day: "2026-10-05", stage: 1 });
  const lapse = review(card.dueAt + INTERVALS[0] + INTERVALS[1], { day: "2026-10-09", stage: 2, grade: "again" });
  const all = [...list, r1, r2, lapse];
  const expected = replay(all)["一"];
  const rand = (() => { let s = 7; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
  for (let i = 0; i < 50; i += 1) {
    const shuffled = [...all, r1, r2, lapse].sort(() => rand() - 0.5); // плюс дубликаты
    assert.deepEqual(replay(shuffled)["一"], expected, `перестановка ${i}`);
  }
  assert.equal(expected.phase, "relearning");
  assert.equal(expected.lapses, 1, "дубликат забывания не считается дважды");
});

test("длительный перерыв: после 200 дней ответ продвигает ровно на одну ступень, срок — от момента ответа", () => {
  const { list, card } = toReview(Date.UTC(2026, 0, 1, 8));
  const late = card.dueAt + 200 * DAY;
  const c = replay([...list, review(late, { day: "2026-07-21" })])["一"];
  assert.equal(c.stage, 1);
  assert.equal(c.dueAt, late + INTERVALS[0]);
  const q = planQueue([{ char: "一", level: "1-2" }], list, { now: late });
  assert.deepEqual(q.due.map((r) => r.char), ["一"], "просроченный знак стоит в очереди");
});

test("подсказка вместе с ответом: попытка с assisted никогда не становится самостоятельным успехом", () => {
  const { list, card } = toReview(Date.UTC(2026, 9, 1, 8));
  const assisted = review(card.dueAt, { day: "2026-10-02", assisted: true, grade: "good" });
  const c = replay([...list, assisted])["一"];
  assert.equal(c.phase, "relearning");
  assert.equal(c.stage, 0);
  assert.deepEqual(c.successDays, []);
});

test("два устройства отвечают на один срок: забывание с другого устройства в пределах 5 минут отменяет успех", () => {
  const { list, card } = toReview(Date.UTC(2026, 9, 1, 8));
  const key = `一:0:${card.dueAt}`;
  const ok = review(card.dueAt, { day: "2026-10-02", device: "ipad", dueKey: key });
  const fail = review(card.dueAt + 2 * MINUTE, { day: "2026-10-02", device: "phone", dueKey: key, grade: "again" });
  for (const order of [[ok, fail], [fail, ok]]) {
    const c = replay([...list, ...order])["一"];
    assert.equal(c.phase, "relearning");
    assert.deepEqual(c.successDays, []);
  }
});
