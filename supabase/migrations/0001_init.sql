-- Chinese Characters · HSK Levels — схема синхронизации прогресса,
-- административных правок словаря и защиты админ-раздела.
--
-- Запуск: Supabase Studio → SQL Editor → вставить целиком → Run.
-- Скрипт идемпотентный: повторный запуск ничего не ломает.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- профили --

create table if not exists public.profiles (
  id          uuid primary key references auth.users on delete cascade,
  email       text,
  created_at  timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "профиль виден только владельцу" on public.profiles;
create policy "профиль виден только владельцу"
  on public.profiles for select using (auth.uid() = id);

drop policy if exists "профиль правит только владелец" on public.profiles;
create policy "профиль правит только владелец"
  on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "профиль создаёт только владелец" on public.profiles;
create policy "профиль создаёт только владелец"
  on public.profiles for insert with check (auth.uid() = id);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email)
  on conflict (id) do nothing;
  insert into public.progress_state (user_id) values (new.id)
  on conflict (user_id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- --------------------------------------------------------------- прогресс --

create table if not exists public.progress_state (
  user_id        uuid primary key references auth.users on delete cascade,
  completed      jsonb       not null default '{"strokes":{},"rules":{},"radicals":{},"hsk":{}}'::jsonb,
  attempts       integer     not null default 0,
  clean_attempts integer     not null default 0,
  days           text[]      not null default '{}',
  last_session   jsonb,
  last_level     text,
  last_char      text,
  settings       jsonb       not null default '{}'::jsonb,
  last_event_at  timestamptz,
  updated_at     timestamptz not null default now()
);

alter table public.progress_state enable row level security;

drop policy if exists "прогресс виден только владельцу" on public.progress_state;
create policy "прогресс виден только владельцу"
  on public.progress_state for select using (auth.uid() = user_id);

drop policy if exists "прогресс создаёт только владелец" on public.progress_state;
create policy "прогресс создаёт только владелец"
  on public.progress_state for insert with check (auth.uid() = user_id);

drop policy if exists "прогресс правит только владелец" on public.progress_state;
create policy "прогресс правит только владелец"
  on public.progress_state for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Журнал событий. Первичный ключ — идентификатор, созданный на устройстве:
-- повторная отправка того же события просто ничего не делает.
create table if not exists public.progress_events (
  id         uuid primary key,
  user_id    uuid        not null references auth.users on delete cascade,
  device     text,
  at         timestamptz not null,
  payload    jsonb       not null,
  applied_at timestamptz not null default now()
);

create index if not exists progress_events_user_at_idx on public.progress_events (user_id, at desc);

alter table public.progress_events enable row level security;

drop policy if exists "события видны только владельцу" on public.progress_events;
create policy "события видны только владельцу"
  on public.progress_events for select using (auth.uid() = user_id);

drop policy if exists "события пишет только владелец" on public.progress_events;
create policy "события пишет только владелец"
  on public.progress_events for insert with check (auth.uid() = user_id);

-- Поэлементное слияние карты повторений: по каждому знаку берём большее.
create or replace function public.completed_merge(base jsonb, patch jsonb)
returns jsonb language plpgsql immutable as $$
declare
  bucket text;
  item   text;
  result jsonb := coalesce(base, '{}'::jsonb);
  sub    jsonb;
  merged numeric;
begin
  if patch is null or jsonb_typeof(patch) <> 'object' then
    return result;
  end if;
  for bucket in select jsonb_object_keys(patch) loop
    if jsonb_typeof(patch -> bucket) <> 'object' then continue; end if;
    sub := coalesce(result -> bucket, '{}'::jsonb);
    for item in select jsonb_object_keys(patch -> bucket) loop
      merged := greatest(
        coalesce((sub ->> item)::numeric, 0),
        coalesce((patch -> bucket ->> item)::numeric, 0)
      );
      sub := jsonb_set(sub, array[item], to_jsonb(merged), true);
    end loop;
    result := jsonb_set(result, array[bucket], sub, true);
  end loop;
  return result;
end $$;

/*
  Применяет пачку событий и возвращает итоговое состояние.

  Правила слияния ровно те же, что и в браузере:
    · по каждому знаку берётся наибольшее число повторений;
    · счётчики написаний растут на дельту события (или подтягиваются
      до присланного итога для снимка);
    · дни занятий объединяются без дубликатов;
    · последняя сессия и настройки берутся из более свежего события.

  Повторная отправка того же события ничего не меняет: идентификатор — ключ.
*/
create or replace function public.apply_progress_events(p_events jsonb default '[]'::jsonb)
returns public.progress_state
language plpgsql security invoker set search_path = public as $$
declare
  uid     uuid := auth.uid();
  event   jsonb;
  payload jsonb;
  event_at timestamptz;
  inserted integer;
  state   public.progress_state;
begin
  if uid is null then
    raise exception 'нужен вход в аккаунт' using errcode = '28000';
  end if;

  insert into public.progress_state (user_id) values (uid)
  on conflict (user_id) do nothing;

  if p_events is not null and jsonb_typeof(p_events) = 'array' then
    for event in select * from jsonb_array_elements(p_events) loop
      payload  := coalesce(event -> 'payload', '{}'::jsonb);
      event_at := coalesce((event ->> 'at')::timestamptz, now());

      insert into public.progress_events (id, user_id, device, at, payload)
      values ((event ->> 'id')::uuid, uid, event ->> 'device', event_at, payload)
      on conflict (id) do nothing;

      get diagnostics inserted = row_count;
      if inserted > 0 then
        update public.progress_state s set
          completed = public.completed_merge(
            s.completed,
            case
              when payload ? 'completed' then payload -> 'completed'
              when payload ? 'bucket' then jsonb_build_object(
                payload ->> 'bucket',
                jsonb_build_object(payload ->> 'key', coalesce((payload ->> 'reps')::numeric, 0))
              )
              else '{}'::jsonb
            end
          ),
          attempts = greatest(
            s.attempts + coalesce((payload ->> 'attemptsDelta')::integer, 0),
            coalesce((payload ->> 'attemptsTotal')::integer, 0)
          ),
          clean_attempts = greatest(
            s.clean_attempts + coalesce((payload ->> 'cleanDelta')::integer, 0),
            coalesce((payload ->> 'cleanTotal')::integer, 0)
          ),
          days = (
            select coalesce(array_agg(distinct day order by day), '{}')
            from (
              select unnest(s.days) as day
              union
              select jsonb_array_elements_text(coalesce(payload -> 'days', '[]'::jsonb))
            ) merged_days
          ),
          last_session = case
            when payload ? 'lastSession' and (s.last_event_at is null or event_at >= s.last_event_at)
              then payload -> 'lastSession' else s.last_session end,
          last_level = case
            when payload ? 'lastLevel' and (s.last_event_at is null or event_at >= s.last_event_at)
              then payload ->> 'lastLevel' else s.last_level end,
          last_char = case
            when payload ? 'lastChar' and (s.last_event_at is null or event_at >= s.last_event_at)
              then payload ->> 'lastChar' else s.last_char end,
          settings = case
            when payload ? 'settings' and (s.last_event_at is null or event_at >= s.last_event_at)
              then s.settings || (payload -> 'settings') else s.settings end,
          last_event_at = greatest(coalesce(s.last_event_at, event_at), event_at),
          updated_at = now()
        where s.user_id = uid;
      end if;
    end loop;
  end if;

  select * into state from public.progress_state where user_id = uid;
  return state;
end $$;

grant execute on function public.apply_progress_events(jsonb) to authenticated;

-- --------------------------------------------- правки словаря и админ-роль --

create table if not exists public.dictionary_edits (
  id             text primary key,
  base_number    integer,
  level          text,
  word           text not null,
  pinyin         text,
  part_of_speech text,
  russian        text not null,
  deleted        boolean not null default false,
  updated_at     timestamptz not null default now(),
  updated_by     text
);

create index if not exists dictionary_edits_updated_idx on public.dictionary_edits (updated_at desc);

alter table public.dictionary_edits enable row level security;

-- Правки читают все: они должны одинаково отображаться каждому посетителю.
drop policy if exists "правки словаря читают все" on public.dictionary_edits;
create policy "правки словаря читают все"
  on public.dictionary_edits for select to anon, authenticated using (true);

-- Записи нет ни у кого: изменять словарь может только Edge Function
-- admin-edits, которая работает под service role и проверяет сессию админа.

create table if not exists public.admin_sessions (
  token      uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  fingerprint text
);

create index if not exists admin_sessions_expires_idx on public.admin_sessions (expires_at);

alter table public.admin_sessions enable row level security;
-- политик нет: строки доступны только service role

create table if not exists public.admin_attempts (
  id          bigserial primary key,
  fingerprint text not null,
  success     boolean not null,
  at          timestamptz not null default now()
);

create index if not exists admin_attempts_lookup_idx on public.admin_attempts (fingerprint, at desc);

alter table public.admin_attempts enable row level security;
-- политик нет: строки доступны только service role

-- Уборка просроченного: вызывается из Edge Function при каждом входе.
create or replace function public.prune_admin_records()
returns void language sql security definer set search_path = public as $$
  delete from public.admin_sessions where expires_at < now();
  delete from public.admin_attempts where at < now() - interval '1 day';
$$;

revoke execute on function public.prune_admin_records() from anon, authenticated;

-- ------------------------------------------------------------------ права --
-- Supabase выдаёт роли anon/authenticated права на новые таблицы через
-- default privileges, но пропишем их явно: политики RLS без grant не работают.

grant usage on schema public to anon, authenticated;

grant select, insert, update on public.profiles       to authenticated;
grant select, insert, update on public.progress_state to authenticated;
grant select, insert         on public.progress_events to authenticated;
grant select                 on public.dictionary_edits to anon, authenticated;

-- Служебные таблицы админки недоступны никому, кроме service role.
revoke all on public.admin_sessions from anon, authenticated;
revoke all on public.admin_attempts from anon, authenticated;
