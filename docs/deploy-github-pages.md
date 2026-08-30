# Публикация на GitHub Pages

Сайт остаётся набором статических файлов: сборка не нужна, `node_modules`
в репозиторий не попадает.

## Обычное обновление

```bash
cd chinese-characters-hsk-levels
git status                 # посмотреть, что изменилось
git add -A
git commit -m "Синхронизация, озвучка, карточки слов и анимации"
git push
```

GitHub Pages пересоберёт сайт за 1–2 минуты.
Ветка и папка настраиваются в **Settings → Pages** (сейчас — ветка `main`,
корень репозитория; файл `.nojekyll` отключает обработку Jekyll).

## Что обязательно проверить перед пушем

1. **Версия кэша Service Worker.** В `service-worker.js` строка

   ```js
   const SHELL_CACHE = "bishun-shell-v14";
   ```

   При каждом изменении `index.html`, `styles.css`, `app.js` или файлов в `js/`
   увеличивайте номер: `v14` → `v15`. Без этого устройства продолжат отдавать
   старые файлы из кэша. Пользовательские данные при смене версии не страдают —
   чистятся только кэши, начинающиеся с `bishun-`.

2. **Параметр версии в `index.html`.** Там же обновите `?v=` у `styles.css`
   и `app.js`, а в `js/config.js` — `appVersion`. Проще всего одной командой:

   ```bash
   node tools/bump-version.mjs
   ```

3. **Тесты.**

   ```bash
   npm install          # один раз
   npm test
   ```

## Проверка перед публикацией локально

```bash
python3 -m http.server 8000
# затем откройте http://localhost:8000
```

Важно открывать именно через `http://`, а не двойным щелчком по файлу:
модули ES и Service Worker не работают по `file://`.

## Кэш на стороне GitHub Pages

GitHub Pages отдаёт статику с `Cache-Control: max-age=600`. Поэтому:

* HTML подхватится в течение 10 минут;
* `styles.css` и `app.js` подхватятся сразу, потому что у них меняется `?v=`;
* Service Worker перезапросится браузером и переустановится из-за нового
  `SHELL_CACHE`.

## Откат

```bash
git log --oneline -10
git revert <хеш-коммита>
git push
```

Прогресс пользователей при откате не страдает: он в localStorage и в Supabase,
а не в файлах сайта.
