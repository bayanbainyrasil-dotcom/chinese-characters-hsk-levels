import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';

// Настройка мока localStorage для node-окружения
const storageMock = new Map();
globalThis.localStorage = {
  getItem: (key) => storageMock.has(key) ? storageMock.get(key) : null,
  setItem: (key, val) => { storageMock.set(key, String(val)); },
  removeItem: (key) => { storageMock.delete(key); },
  clear: () => { storageMock.clear(); }
};

import { KEYS, readJson, writeJson, removeRaw } from '../js/storage.js';
import { loadProgress, saveProgress, defaultProgress, normalize, merge, ensureMigration, restoreBackup } from '../js/progress.js';
import { ReviewStore } from '../js/review-store.js';

function resetStorage() {
  storageMock.clear();
  for (const key of Object.values(KEYS)) {
    removeRaw(key);
  }
}

test('Migration 1: Reading legacy progress_v1 automatically creates backup before migration', () => {
  resetStorage();
  const legacyData = {
    completed: {
      hsk: { '1-2:一': 5, '1-2:二': 4, '3:安': 5 },
      radicals: { '1:一': 3 }
    },
    attempts: 42,
    cleanAttempts: 38,
    days: ['2026-01-01', '2026-01-02']
  };
  localStorage.setItem(KEYS.progress, JSON.stringify(legacyData));

  // Проверяем, что до вызова loadProgress бэкапа ещё нет
  assert.equal(localStorage.getItem(KEYS.backup), null);
  assert.equal(localStorage.getItem(KEYS.migration), null);

  // Выполняем загрузку прогресса
  const loaded = loadProgress();

  // 1. Прогресс успешно нормализован и не потерян
  assert.equal(loaded.version, 2);
  assert.equal(loaded.completed.hsk['1-2:一'], 5);
  assert.equal(loaded.completed.hsk['3:安'], 5);
  assert.equal(loaded.completed.radicals['1:一'], 3);
  assert.equal(loaded.attempts, 42);
  assert.equal(loaded.cleanAttempts, 38);
  assert.deepEqual(loaded.days, ['2026-01-01', '2026-01-02']);

  // 2. Создана резервная копия
  const backup = readJson(KEYS.backup, null);
  assert.ok(backup, 'Backup must exist');
  assert.deepEqual(backup.progress, legacyData, 'Backup must preserve raw legacy data');

  // 3. Создана метка миграции
  const migration = readJson(KEYS.migration, null);
  assert.ok(migration, 'Migration mark must exist');
  assert.equal(migration.hadLegacy, true);
  assert.equal(migration.backedUp, true);
});

test('Migration 2: Repeated migrations are idempotent and do not overwrite initial backup', () => {
  resetStorage();
  const initialLegacy = {
    completed: { hsk: { '1-2:一': 5 } },
    attempts: 10
  };
  localStorage.setItem(KEYS.progress, JSON.stringify(initialLegacy));

  // Первая миграция
  loadProgress();
  const firstBackup = readJson(KEYS.backup, null);
  const firstTimestamp = firstBackup.savedAt;
  const firstMigrationId = readJson(KEYS.migration, null).id;

  // Изменяем текущий прогресс (пользователь продолжил заниматься)
  const current = loadProgress();
  current.attempts = 100;
  saveProgress(current);

  // Повторные вызовы миграции
  ensureMigration();
  loadProgress();

  const secondBackup = readJson(KEYS.backup, null);
  const secondMigration = readJson(KEYS.migration, null);

  assert.equal(secondBackup.savedAt, firstTimestamp, 'Original backup timestamp must never be overwritten');
  assert.deepEqual(secondBackup.progress, initialLegacy, 'Original backup data must remain intact');
  assert.equal(secondMigration.id, firstMigrationId, 'Migration ID must remain unchanged');
});

test('Migration 3: Gracefully handles corrupted JSON without crashing or losing storage', () => {
  resetStorage();
  // Помещаем в localStorage невалидный JSON
  localStorage.setItem(KEYS.progress, '{{{CORRUPTED_JSON_DATA::');

  // Не должно выбросить исключение (throw), должно вернуть чистую базовую структуру
  let loaded;
  assert.doesNotThrow(() => {
    loaded = loadProgress();
  });

  assert.equal(loaded.version, 2);
  assert.equal(loaded.attempts, 0);
  assert.deepEqual(loaded.completed.hsk, {});
});

test('Migration 4: Sanitizes malformed fields (negative values, strings in numbers, invalid types)', () => {
  resetStorage();
  const malformed = {
    completed: {
      hsk: {
        '1-2:一': 5,
        '1-2:二': -3,        // Отрицательное значение должно быть отфильтровано
        '1-2:三': 'five',    // Нечисловая строка должна быть отфильтрована
        '1-2:四': 0          // 0 повторений не имеет смысла хранить
      },
      unknownBucket: { 'x': 1 } // Неизвестный бакет не теряется (сохранение пользовательских данных)
    },
    attempts: -100,          // Отрицательные попытки
    cleanAttempts: 'bad',    // Нечисловые попытки
    days: ['2026-01-01', null, 123, '2026-01-01'] // Дубликаты и не-строки
  };

  const clean = normalize(malformed);

  assert.equal(clean.completed.hsk['1-2:一'], 5);
  assert.equal(clean.completed.hsk['1-2:二'], undefined);
  assert.equal(clean.completed.hsk['1-2:三'], undefined);
  assert.equal(clean.completed.hsk['1-2:四'], undefined);
  assert.equal(clean.attempts, 0);
  assert.equal(clean.cleanAttempts, 0);
  assert.deepEqual(clean.days, ['2026-01-01']);
  assert.deepEqual(clean.completed.unknownBucket, { 'x': 1 }, 'Custom/future buckets are preserved without data loss');
});

test('Migration 5: IndexedDB ReviewStore rollback and validation safety on corrupted import', async () => {
  const store = new ReviewStore(crypto.randomUUID());
  await store.open();

  // Добавляем одно валидное событие
  const validEvent = {
    id: crypto.randomUUID(),
    attemptId: null,
    char: '一',
    kind: 'answer',
    mode: 'learn',
    dueKey: 'k1',
    grade: 'good',
    assisted: false,
    mistakes: 0,
    at: Date.now(),
    day: '2026-10-18',
    device: 'test-device',
    durationMs: 1000,
    version: 1
  };
  validEvent.attemptId = validEvent.id;
  await store.finish(validEvent);
  assert.equal((await store.events()).length, 1);

  // Попытка импортировать некорректный файл (неверная схема)
  await assert.rejects(
    store.import({ schema: 'corrupted-schema-v0', events: [] }),
    /Нужна копия расписания памяти/
  );

  // Попытка импортировать повреждённые события (содержащие XSS или повреждённые поля)
  await assert.rejects(
    store.import({
      schema: 'bishun-memory-backup-v1',
      schedulerVersion: 1,
      events: [{ id: 'bad-id', char: '<script>' }]
    })
  );

  // Проверяем, что в базе по-прежнему ровно 1 исходное валидное событие (транзакция откатилась)
  const currentEvents = await store.events();
  assert.equal(currentEvents.length, 1);
  assert.equal(currentEvents[0].id, validEvent.id);
});

test('Migration 6: Backward compatibility for legacy clients reading progress_v1 key', () => {
  resetStorage();
  const current = defaultProgress();
  current.completed.hsk['1-2:一'] = 5;
  current.attempts = 15;
  current.cleanAttempts = 12;

  saveProgress(current);

  // Читаем ключ напрямую из localStorage как старый клиент
  const rawSaved = JSON.parse(localStorage.getItem(KEYS.progress));
  assert.equal(rawSaved.completed.hsk['1-2:一'], 5, 'Legacy client can directly read completed character');
  assert.equal(rawSaved.attempts, 15, 'Legacy client can directly read attempts count');
  assert.equal(rawSaved.cleanAttempts, 12, 'Legacy client can directly read clean attempts count');
});
