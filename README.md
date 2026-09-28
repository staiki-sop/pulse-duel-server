# Сервер дуэлей

Сводит двух игроков в комнату по коду вызова и пересылает их ходы. Бой
сервер не считает: это делают оба телефона сами (раздел «Дуэль» в
`scripts/game.gd`). Протокол описан в `scripts/duel_net.gd`.

- `src/index.js` — сервер для Cloudflare Workers; комната — Durable Object;
- `wrangler.toml` — настройки выкладки;
- `../tools/duel_relay.gd` — такой же сервер для проверки у себя, на
  Godot. **Меняя протокол, менять оба.**

Адрес после выкладки: `wss://pulse-duel.gunterhouse.workers.dev` — он
записан в `DUEL_SERVER` в `scripts/game.gd`.

## Выложить: через GitHub (ничего не устанавливая)

1. На GitHub создать репозиторий, например `pulse-duel-server`, и положить
   в его корень содержимое этой папки: `src/index.js`, `wrangler.toml`,
   `README.md`.
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

## Лимиты

Бесплатный тариф Cloudflare: 100 000 запросов в день. Дуэль — примерно
10–15 запросов; узкое место — время работы комнат (13 000 ГБ·с в день),
это примерно 200–400 дуэлей в день. Комната спит, пока игроки думают
(Hibernation API), — так она тратит меньше. Больше — тариф Workers Paid
($5 в месяц).
