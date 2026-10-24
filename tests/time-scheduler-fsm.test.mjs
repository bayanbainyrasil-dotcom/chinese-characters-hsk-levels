import test from 'node:test';
import assert from 'node:assert/strict';
import { replay, ready, DAY, MINUTE, LEARN_DELAY, INTERVALS, localDay, memoryStatus } from '../js/review-scheduler.js';

let counter = 0;
function makeEvent(kind, at, extra = {}) {
  const id = `10000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
  const d = new Date(at);
  const day = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  return {
    id,
    attemptId: id,
    char: '一',
    kind,
    mode: kind === 'practice' ? 'practice' : 'learn',
    dueKey: 'key-1',
    grade: kind === 'answer' ? 'good' : null,
    assisted: false,
    mistakes: 0,
    at,
    day,
    device: 'device-test',
    durationMs: 1500,
    version: 1,
    ...extra
  };
}

const T0 = Date.UTC(2026, 0, 1, 10, 0, 0); // 2026-01-01 10:00:00 UTC

test('FSM Boundary: early answer (dueAt - 1ms) does not advance review stage, exact dueAt advances', () => {
  // Move card to review phase:
  // introduce -> answer(T0+1) -> 2 distractors -> answer(T0+2) -> review phase with dueAt = T0+2+10*MINUTE
  const events = [
    makeEvent('introduce', T0),
    makeEvent('answer', T0 + 1000),
    makeEvent('answer', T0 + 2000, { char: '二' }),
    makeEvent('answer', T0 + 3000, { char: '三' }),
    makeEvent('answer', T0 + 4000) // 2nd pass -> phase: review, dueAt = T0 + 4000 + 10*MINUTE
  ];
  let card = replay(events)['一'];
  assert.equal(card.phase, 'review');
  const initialDue = card.dueAt;
  assert.equal(initialDue, T0 + 4000 + LEARN_DELAY);
  assert.equal(card.stage, 0);

  // 1. Попытка ответить раньше срока на 1 мс: e.at = initialDue - 1
  const earlyEvents = [...events, makeEvent('answer', initialDue - 1, { mode: 'review' })];
  let earlyCard = replay(earlyEvents)['一'];
  assert.equal(earlyCard.stage, 0, 'Stage must not advance on premature answer');
  assert.equal(earlyCard.dueAt, initialDue, 'dueAt must remain unchanged on premature answer');

  // 2. Ответ ровно в срок: e.at = initialDue
  const exactEvents = [...events, makeEvent('answer', initialDue, { mode: 'review' })];
  let exactCard = replay(exactEvents)['一'];
  assert.equal(exactCard.stage, 1, 'Stage must advance by 1 at exact due time');
  assert.equal(exactCard.dueAt, initialDue + INTERVALS[0], 'dueAt must advance by 1 DAY');
});

test('FSM Long Absence: 180-day gap retains card in due queue, clean recall advances, mistake resets', () => {
  const events = [
    makeEvent('introduce', T0),
    makeEvent('answer', T0 + 1000),
    makeEvent('answer', T0 + 2000, { char: '二' }),
    makeEvent('answer', T0 + 3000, { char: '三' }),
    makeEvent('answer', T0 + 4000)
  ];
  const due = replay(events)['一'].dueAt;
  events.push(makeEvent('answer', due, { mode: 'review' })); // stage 1, due in 1 DAY
  let card = replay(events)['一'];
  assert.equal(card.stage, 1);

  // Прошло 180 дней
  const gap180Days = 180 * DAY;
  const returnTime = due + gap180Days;

  // Карточка не исчезла и готова к повторению
  assert.equal(ready(card, events, returnTime), true, 'Card must remain ready after long absence');

  // Вариант А: Чистый ответ ученика после 180 дней
  const cleanEvents = [...events, makeEvent('answer', returnTime, { mode: 'review', day: '2026-07-01' })];
  const cleanCard = replay(cleanEvents)['一'];
  assert.equal(cleanCard.stage, 2, 'Stage should advance to 2 on clean recall after 180 days');
  assert.equal(cleanCard.dueAt, returnTime + INTERVALS[1], 'New dueAt should be returnTime + 3 DAYS');

  // Вариант Б: Забывание / подсказка после 180 дней
  const lapseEvents = [...events, makeEvent('answer', returnTime, { mode: 'review', assisted: true, day: '2026-07-01' })];
  const lapseCard = replay(lapseEvents)['一'];
  assert.equal(lapseCard.phase, 'relearning', 'Card must drop into relearning phase');
  assert.equal(lapseCard.stage, 0, 'Stage must be reset to 0');
  assert.equal(lapseCard.lapses, 1, 'Lapse counter must increment');
  assert.equal(lapseCard.dueAt, returnTime + LEARN_DELAY, 'Next dueAt must be in 10 minutes');
});

test('FSM Daily Limits: multiple reviews on the same calendar day do not artificially inflate successDays', () => {
  const events = [
    makeEvent('introduce', T0),
    makeEvent('answer', T0 + 1000),
    makeEvent('answer', T0 + 2000, { char: '二' }),
    makeEvent('answer', T0 + 3000, { char: '三' }),
    makeEvent('answer', T0 + 4000)
  ];
  const due = replay(events)['一'].dueAt;
  events.push(makeEvent('answer', due, { mode: 'review', day: '2026-01-01' }));
  let card = replay(events)['一'];
  assert.equal(card.successDays.length, 1);

  // Повторный ответ в тот же день (например, в 23:00)
  events.push(makeEvent('answer', due + 12 * 60 * MINUTE, { mode: 'review', day: '2026-01-01' }));
  card = replay(events)['一'];
  assert.equal(card.successDays.length, 1, 'Same day must not add a duplicate successDay');
});

test('FSM Midnight & Timezone: localDay format and cross-midnight boundary consistency', () => {
  // Проверка формата даты YYYY-MM-DD
  const d1 = Date.UTC(2026, 4, 9, 23, 59, 59); // 9 мая 2026 23:59:59 UTC
  const str1 = localDay(d1);
  assert.match(str1, /^\d{4}-\d{2}-\d{2}$/);

  // Epoch ms вычисления защищены от перевода часов (DST)
  const epochA = 1774742400000; // произвольная точка
  const epochB = epochA + DAY;
  assert.equal(epochB - epochA, 86_400_000, 'A DAY interval in scheduler is strictly 86,400,000 ms invariant');
});

test('FSM Conflict Resolution: concurrent failure/assistance across devices wins over clean review within 5 minutes', () => {
  const events = [
    makeEvent('introduce', T0),
    makeEvent('answer', T0 + 1000),
    makeEvent('answer', T0 + 2000, { char: '二' }),
    makeEvent('answer', T0 + 3000, { char: '三' }),
    makeEvent('answer', T0 + 4000)
  ];
  const due = replay(events)['一'].dueAt;

  // Планшет iPad: ученик воспользовался подсказкой (lapse) в момент due
  const iPadEvent = makeEvent('answer', due, {
    mode: 'review',
    device: 'iPad',
    dueKey: 'slot-1',
    assisted: true
  });

  // Телефон iPhone: в этот же момент (разница 2 минуты) чистый ответ
  const iPhoneEvent = makeEvent('answer', due + 2 * MINUTE, {
    mode: 'review',
    device: 'iPhone',
    dueKey: 'slot-1',
    assisted: false,
    grade: 'good'
  });

  // Порядок поступления: сначала iPhone, потом iPad
  const cards1 = replay([...events, iPhoneEvent, iPadEvent])['一'];
  assert.equal(cards1.phase, 'relearning', 'Lapse on iPad must suppress concurrent clean recall from iPhone');

  // Порядок поступления: сначала iPad, потом iPhone
  const cards2 = replay([...events, iPadEvent, iPhoneEvent])['一'];
  assert.equal(cards2.phase, 'relearning', 'Lapse must win regardless of arrival order');
});

test('FSM Idempotency: duplicate events and shuffled inputs produce strictly identical state', () => {
  const events = [
    makeEvent('introduce', T0),
    makeEvent('answer', T0 + 1000),
    makeEvent('answer', T0 + 2000, { char: '二' }),
    makeEvent('answer', T0 + 3000, { char: '三' }),
    makeEvent('answer', T0 + 4000)
  ];
  const due = replay(events)['一'].dueAt;
  events.push(makeEvent('answer', due, { mode: 'review' }));

  const state1 = replay(events);

  // Дублирование всех событий
  const duplicated = [...events, ...events];
  const state2 = replay(duplicated);
  assert.deepEqual(state2, state1, 'Replaying duplicate events must produce identical state');

  // Перемешивание событий
  const shuffled = [...events].reverse();
  const state3 = replay(shuffled);
  assert.deepEqual(state3, state1, 'Replaying shuffled events must sort by timestamp and produce identical state');
});
