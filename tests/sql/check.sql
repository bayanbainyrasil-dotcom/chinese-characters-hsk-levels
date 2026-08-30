-- Проверка миграции: слияние прогресса, дедупликация событий и политики RLS.
-- Запуск (нужен локальный PostgreSQL):
--   createdb hsktest && psql -d hsktest -f tests/sql/stub.sql \
--     && psql -d hsktest -f supabase/migrations/0001_init.sql \
--     && psql -d hsktest -f tests/sql/check.sql
\set ON_ERROR_STOP on

create or replace function pg_temp.expect(condition boolean, label text)
returns void language plpgsql as $$
begin
  if condition then raise notice 'ok   %', label;
  else raise exception 'ПРОВАЛ: %', label;
  end if;
end $$;

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'phone@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'other@example.com');

set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

-- 1. Снимок старого локального прогресса
select public.apply_progress_events($$[
  {"id":"aaaaaaaa-0000-0000-0000-000000000001","at":"2026-08-29T10:00:00Z","device":"phone",
   "payload":{"kind":"snapshot","completed":{"hsk":{"3:安":5,"3:把":3}},"attemptsTotal":42,"cleanTotal":18,
              "days":["2026-08-01","2026-08-02"],"lastSession":{"kind":"hsk","level":"3"},"lastLevel":"3"}}
]$$::jsonb);
select pg_temp.expect((select attempts from public.progress_state where user_id = auth.uid()) = 42, 'снимок переносит 42 написания');

-- 2. Два написания
select public.apply_progress_events($$[
  {"id":"aaaaaaaa-0000-0000-0000-000000000002","at":"2026-08-29T10:05:00Z",
   "payload":{"kind":"write","bucket":"hsk","key":"3:把","reps":4,"attemptsDelta":1,"cleanDelta":1,"days":["2026-08-29"]}},
  {"id":"aaaaaaaa-0000-0000-0000-000000000003","at":"2026-08-29T10:06:00Z",
   "payload":{"kind":"write","bucket":"hsk","key":"3:把","reps":5,"attemptsDelta":1,"cleanDelta":0,"days":["2026-08-29"]}}
]$$::jsonb);
select pg_temp.expect((select attempts from public.progress_state where user_id = auth.uid()) = 44, 'два написания дают 44');

-- 3. Повторная отправка тех же событий не создаёт дубликатов
select public.apply_progress_events($$[
  {"id":"aaaaaaaa-0000-0000-0000-000000000002","at":"2026-08-29T10:05:00Z",
   "payload":{"kind":"write","bucket":"hsk","key":"3:把","reps":4,"attemptsDelta":1,"cleanDelta":1,"days":["2026-08-29"]}},
  {"id":"aaaaaaaa-0000-0000-0000-000000000003","at":"2026-08-29T10:06:00Z",
   "payload":{"kind":"write","bucket":"hsk","key":"3:把","reps":5,"attemptsDelta":1,"cleanDelta":0,"days":["2026-08-29"]}}
]$$::jsonb);
select pg_temp.expect((select attempts from public.progress_state where user_id = auth.uid()) = 44, 'повтор событий ничего не задваивает');
select pg_temp.expect((select clean_attempts from public.progress_state where user_id = auth.uid()) = 19, 'чистые написания не задваиваются');

-- 4. Более старое состояние с другого устройства не уменьшает повторения
select public.apply_progress_events($$[
  {"id":"bbbbbbbb-0000-0000-0000-000000000001","at":"2026-08-29T11:00:00Z","device":"laptop",
   "payload":{"kind":"snapshot","completed":{"hsk":{"3:安":2,"3:把":1,"4:书":1}},"attemptsTotal":5,
              "days":["2026-08-28"],"lastSession":{"kind":"hsk","level":"4"},"lastLevel":"4"}}
]$$::jsonb);
select pg_temp.expect((select (completed->'hsk'->>'3:安')::int from public.progress_state where user_id = auth.uid()) = 5, 'повторения не уменьшаются');
select pg_temp.expect((select (completed->'hsk'->>'4:书')::int from public.progress_state where user_id = auth.uid()) = 1, 'новый знак с другого устройства добавлен');
select pg_temp.expect((select array_length(days, 1) from public.progress_state where user_id = auth.uid()) = 4, 'дни объединены без дубликатов');
select pg_temp.expect((select last_level from public.progress_state where user_id = auth.uid()) = '4', 'последний уровень взят из свежего события');

-- 5. RLS: другой пользователь видит только свою строку
set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select pg_temp.expect(
  (select count(*) from public.progress_state where attempts = 44) = 0,
  'чужой прогресс недоступен');
select pg_temp.expect(
  (select count(*) from public.progress_state) = 1,
  'видна ровно одна собственная строка');
reset role;

-- 6. Правки словаря: читают все, пишет только service role
insert into public.dictionary_edits (id, word, russian) values ('base:1', '测试', 'тест');
set role anon;
select pg_temp.expect((select count(*) from public.dictionary_edits) = 1, 'правки словаря видны всем');
reset role;

\echo 'Все проверки SQL пройдены'
