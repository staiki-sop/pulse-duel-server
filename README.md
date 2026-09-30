# Сервер дуэлей

Сводит двух игроков в комнату по коду вызова и пересылает их ходы. Бой
сервер не считает: это делают оба телефона сами (раздел «Дуэль» в
`scripts/game.gd`). Протокол описан в `scripts/duel_net.gd`.

- `index.js` — сервер для Cloudflare Workers; комната — Durable Object;
- `wrangler.toml` — настройки выкладки;
- `../tools/duel_relay.gd` — такой же сервер для проверки у себя, на
  Godot. **Меняя протокол, менять оба.**

Сейчас выложен из репозитория `staiki-sop/pulse-duel-server`.

Адрес после выкладки: `wss://pulse-duel.gunterhouse.workers.dev` — он
записан в `DUEL_SERVER` в `scripts/game.gd`.

## Выложить: через GitHub (ничего не устанавливая)

1. На GitHub создать репозиторий, например `pulse-duel-server`, и положить
   в его корень содержимое этой папки: `index.js`, `wrangler.toml`,
   `README.md` (все три — в корень, без подпапок: путь к `index.js`
   записан в `wrangler.toml`).
2. В панели Cloudflare: **Workers & Pages → Create application → Import a
   repository**, подключить GitHub, выбрать этот репозиторий.
3. Имя проекта — `pulse-duel` (то же, что в `wrangler.toml`), остальное по
   умолчанию. **Deploy**.
4. Дальше каждый push в репозиторий выкладывается сам.

## Выложить: из терминала

Нужен Node.js (nodejs.org). Из этой папки:

```
npx wrangler login
npx wrangler deploy
```

## Проверить у себя, без Cloudflare

Из корня проекта — сервер и две копии игры:

```
/Applications/Godot.app/Contents/MacOS/Godot --headless --path . -s tools/duel_relay.gd
/Applications/Godot.app/Contents/MacOS/Godot --path . -- --duel-server=ws://127.0.0.1:8787
/Applications/Godot.app/Contents/MacOS/Godot --path . -- --duel-server=ws://127.0.0.1:8787
```

В одной копии — «Дуэль → Вызвать друга», во второй — «Войти по коду».

## Отчёты о вылетах («чёрный ящик»)

Игра в Телеграме ведёт короткий журнал событий (код — в
`telegram_shell.html`, отметки из игры — `_box()` в `scripts/game.gd`).
Если прошлый сеанс оборвался без закрытия или в нём были ошибки, при
следующем запуске журнал уходит на `POST /report`. Хранятся последние
300 отчётов, в объекте `Reports` (второй Durable Object, миграция `v2`
в `wrangler.toml`).

Смотреть: `https://pulse-duel.gunterhouse.workers.dev/reports?key=КЛЮЧ`
(для разбора программой — `&format=json`, сколько — `&n=50`).

Ключ задаётся один раз в панели Cloudflare: **Workers & Pages →
pulse-duel → Settings → Variables and Secrets → Add**, тип **Secret**,
имя `REPORTS_KEY`, значение — любая длинная строка. Пока ключа нет,
страница отчётов закрыта для всех; отчёты при этом всё равно копятся.
Секрет переживает выкладки из репозитория.

В отчёте нет имён и прогресса: строка браузера (модель и версия
системы), размер экрана, журнал событий и случайный номер установки.

## Лимиты

Бесплатный тариф Cloudflare: 100 000 запросов в день. Дуэль — примерно
10–15 запросов; узкое место — время работы комнат (13 000 ГБ·с в день),
это примерно 300–500 дуэлей в день (оценка). Комната спит, пока игроки думают
(Hibernation API), — так она тратит меньше. Проверку связи (голое слово
`ping` каждые 20 секунд) отвечает сам Cloudflare, не будя комнату
(`setWebSocketAutoResponse`): иначе пинги не давали бы ей уснуть всю
дуэль, и предел был бы около 170 дуэлей в день. Больше — тариф Workers Paid
($5 в месяц).
