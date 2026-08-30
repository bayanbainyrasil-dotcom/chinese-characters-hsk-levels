# Настройка Supabase

Пошагово, примерно 20 минут. Всё, что здесь описано, делается один раз.
Пока эти шаги не выполнены, сайт работает как раньше — локально, без аккаунта.

---

## 1. Создать проект

1. Откройте <https://supabase.com>, войдите через GitHub.
2. **New project**. Имя — например `hsk-levels`. Регион берите ближе к себе
   (для Казахстана — `Central EU (Frankfurt)` или `Southeast Asia (Singapore)`).
3. Придумайте пароль базы данных и сохраните его в менеджере паролей.
4. Дождитесь, пока проект поднимется (2–3 минуты).

## 2. Прописать ключи в сайт

**Project Settings → API**:

| Что копируем | Куда вставляем |
|---|---|
| `Project URL` | `js/config.js` → `supabaseUrl` |
| `anon` `public` ключ | `js/config.js` → `supabaseAnonKey` |

```js
export const CONFIG = {
  supabaseUrl: "https://abcdefgh.supabase.co",
  supabaseAnonKey: "eyJhbGciOi...",
  ...
};
```

`anon key` публичен по замыслу Supabase: он лишь говорит, к какому проекту
обращаться. Доступ к данным ограничивают политики Row Level Security, которые
ставит миграция из шага 3. **`service_role` ключ во frontend не попадает
никогда** — он живёт только внутри Edge Functions.

## 3. Накатить схему базы

1. **SQL Editor → New query**.
2. Вставьте целиком `supabase/migrations/0001_init.sql` и нажмите **Run**.
3. Внизу должно быть `Success. No rows returned`.

Скрипт идемпотентный: повторный запуск ничего не сломает.

Что он создаёт:

| Таблица | Зачем | Кто видит |
|---|---|---|
| `profiles` | профиль пользователя | только владелец |
| `progress_state` | текущее состояние обучения | только владелец |
| `progress_events` | журнал написаний, ключ — UUID с устройства | только владелец |
| `dictionary_edits` | правки словаря администратором | читают все, пишет только сервер |
| `admin_sessions` | серверные сессии администратора | только service role |
| `admin_attempts` | попытки входа для лимита | только service role |

Плюс функция `apply_progress_events(jsonb)` — она принимает пачку событий,
пропускает уже применённые по идентификатору и сливает состояние.

## 4. Включить вход

**Authentication → Providers**:

* **Email** — включён по умолчанию. Если не хотите подтверждать почту вручную,
  оставьте `Confirm email` включённым: письмо приходит автоматически.
* **Google** — переключатель `Enable`. Нужны `Client ID` и `Client Secret`
  из Google Cloud Console:
  1. <https://console.cloud.google.com> → **APIs & Services → Credentials**.
  2. **Create credentials → OAuth client ID → Web application**.
  3. В `Authorized redirect URIs` добавьте строку, которую Supabase показывает
     под переключателем Google — она вида
     `https://abcdefgh.supabase.co/auth/v1/callback`.
  4. Скопируйте `Client ID` и `Client Secret` обратно в Supabase.

**Authentication → URL Configuration**:

* `Site URL`: `https://bayanbainyrasil-dotcom.github.io/chinese-characters-hsk-levels/`
* `Redirect URLs`: добавьте туда же и `http://localhost:8000/` — пригодится
  для локальной проверки.

## 5. Задать пароль администратора

Пароль хранится только как хеш, и только на сервере.

1. Придумайте соль — длинную случайную строку, например:

   ```bash
   openssl rand -hex 24
   ```

2. Посчитайте хеш от `пароль + соль` (пароль — ваш текущий, `2007`):

   ```bash
   printf '%s' "2007ВАША-СОЛЬ" | sha256sum
   ```

   На Windows в PowerShell:

   ```powershell
   $s = "2007ВАША-СОЛЬ"
   [BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().
     ComputeHash([Text.Encoding]::UTF8.GetBytes($s))).Replace("-","").ToLower()
   ```

3. **Project Settings → Edge Functions → Secrets** — добавьте:

   | Имя | Значение |
   |---|---|
   | `ADMIN_PIN_HASH` | 64 шестнадцатеричных символа из шага 2 |
   | `ADMIN_PIN_SALT` | ваша соль |
   | `ALLOWED_ORIGINS` | `https://bayanbainyrasil-dotcom.github.io` |

   Необязательно: `ADMIN_SESSION_HOURS` (по умолчанию 4),
   `ADMIN_MAX_ATTEMPTS` (5), `ADMIN_LOCK_MINUTES` (15).

Смена пароля — это просто новый `ADMIN_PIN_HASH`. Файлы сайта трогать не нужно.

## 6. Озвучка через сервер (необязательно)

Нужна, только если не хотите держать статический аудиопак в репозитории
или хотите озвучивать любое слово из словаря, а не только заранее собранные.

1. **Storage → New bucket**: имя `tts-audio`, галочка **Public bucket**.
2. **Edge Functions → Secrets** добавьте:

   | Имя | Значение |
   |---|---|
   | `TTS_PROVIDER` | `azure`, `google` или `openai` |
   | `TTS_VOICE` | например `zh-CN-XiaoxiaoNeural` |
   | `TTS_BUCKET` | `tts-audio` |
   | ключ провайдера | `AZURE_SPEECH_KEY` + `AZURE_SPEECH_REGION`, либо `GOOGLE_TTS_KEY`, либо `OPENAI_API_KEY` |

Полный список — в `.env.example`.

## 7. Выложить Edge Functions

Нужен Supabase CLI: <https://supabase.com/docs/guides/cli>.

```bash
npm install -g supabase
supabase login
supabase link --project-ref ВАШ-PROJECT-REF     # виден в Project Settings → General
supabase functions deploy admin-auth  --no-verify-jwt
supabase functions deploy admin-edits --no-verify-jwt
supabase functions deploy tts         --no-verify-jwt
```

`--no-verify-jwt` здесь обязателен: функции вызываются и без входа в аккаунт
(проверку прав они делают сами — по паролю администратора либо по типу запроса).

## 8. Проверить

1. Откройте сайт, зайдите в **Настройки** → войдите через Google или почту.
2. Напишите один знак. Индикатор в шапке должен показать
   «Синхронизация…», затем «Сохранено».
3. Откройте **Table Editor → progress_state** — там появилась ваша строка.
4. Войдите тем же аккаунтом на телефоне: прогресс уже на месте.
5. **Админ** → введите `2007`. Должно пустить. Введите неправильный —
   покажет, сколько попыток осталось; после пяти заблокирует на 15 минут.

## Если что-то не работает

| Симптом | Причина |
|---|---|
| Индикатор всё время «Сохранено», но на другом устройстве пусто | не заполнены `supabaseUrl` / `supabaseAnonKey` в `js/config.js` |
| «Ошибка синхронизации — повторить» | не накатана миграция, либо `apply_progress_events` не создалась — перезапустите SQL |
| Вход через Google возвращает на страницу без входа | в `URL Configuration` не указан адрес сайта, либо redirect URI не совпадает с тем, что в Google Cloud |
| В админку не пускает с верным паролем | не заданы `ADMIN_PIN_HASH` / `ADMIN_PIN_SALT`, либо хеш посчитан без соли |
| Озвучка молчит | нет статического пака и не настроен TTS — остаётся только голос браузера |
