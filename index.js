// Сервер комнат дуэли «Пульса» — Cloudflare Workers + Durable Objects.
//
// Сервер только сводит двух игроков и пересылает ходы: бой считают оба
// телефона сами. Протокол — в scripts/duel_net.gd; такой же сервер для
// проверки у себя — tools/duel_relay.gd (держать их одинаковыми).
//
// Комната — один Durable Object на код вызова. Соединения принимаются
// через Hibernation API: пока игроки думают, комната спит и не тратит
// время работы. Всё, что должно пережить сон, лежит в хранилище комнаты,
// а у каждого соединения — пометка, чьё оно (serializeAttachment).

const AWAY_LIMIT_MS = 90 * 1000;
const ROOM_TTL_MS = 60 * 60 * 1000;

// Отчёты «чёрного ящика»: игра в Телеграме присылает журнал последних
// событий, если прошлый сеанс оборвался (вылет) или в нём были ошибки.
// Хранятся последние REPORTS_MAX; смотреть — /reports?key=… (ключ —
// секрет REPORTS_KEY в настройках воркера на Cloudflare).
const REPORT_MAX_BYTES = 40000;
const REPORTS_MAX = 300;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/report") {
      return handleReport(req, env);
    }
    if (url.pathname === "/reports") {
      const key = url.searchParams.get("key") || "";
      if (!env.REPORTS_KEY || key !== env.REPORTS_KEY) {
        return new Response("forbidden", { status: 403 });
      }
      const stub = env.REPORTS.get(env.REPORTS.idFromName("all"));
      const q = new URLSearchParams({
        format: url.searchParams.get("format") || "html",
        n: url.searchParams.get("n") || "100",
      });
      return stub.fetch("https://reports/list?" + q.toString());
    }
    const m = url.pathname.match(/^\/room\/([0-9A-Z]{4,8})$/);
    if (!m) {
      return new Response("pulse duel", { status: 200 });
    }
    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const stub = env.ROOMS.get(env.ROOMS.idFromName(m[1]));
    return stub.fetch(req);
  },
};

async function handleReport(req, env) {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (req.method !== "POST") {
    return new Response("post only", { status: 405, headers: CORS });
  }
  const text = await req.text();
  if (text.length > REPORT_MAX_BYTES) {
    return new Response("too big", { status: 413, headers: CORS });
  }
  let body;
  try { body = JSON.parse(text); } catch (e) {
    return new Response("bad json", { status: 400, headers: CORS });
  }
  if (!body || typeof body !== "object") {
    return new Response("bad json", { status: 400, headers: CORS });
  }
  const stub = env.REPORTS.get(env.REPORTS.idFromName("all"));
  await stub.fetch("https://reports/add", {
    method: "POST",
    body: JSON.stringify({ at: Date.now(), body }),
  });
  return new Response("ok", { headers: CORS });
}

// Все отчёты — в одном Durable Object: их мало, и так их проще листать.
export class Reports {
  constructor(state) {
    this.state = state;
  }

  async fetch(req) {
    const url = new URL(req.url);
    const st = this.state.storage;
    if (url.pathname === "/add") {
      const r = await req.json();
      const key = "r:" + String(r.at).padStart(14, "0") + ":" +
        Math.random().toString(36).slice(2, 8);
      await st.put(key, r);
      const keys = [...(await st.list({ prefix: "r:" })).keys()];
      if (keys.length > REPORTS_MAX) {
        await st.delete(keys.slice(0, keys.length - REPORTS_MAX));
      }
      return new Response("ok");
    }
    if (url.pathname === "/list") {
      const n = Math.max(1, Math.min(REPORTS_MAX, Number(url.searchParams.get("n")) || 100));
      const rows = [...(await st.list({ prefix: "r:", reverse: true, limit: n })).values()];
      if (url.searchParams.get("format") === "json") {
        return new Response(JSON.stringify(rows), {
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      }
      return new Response(reportsHtml(rows), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    return new Response("not found", { status: 404 });
  }
}

function esc(v) {
  return String(v == null ? "" : v).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function msk(t) {
  try {
    return new Date(t).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" });
  } catch (e) {
    return new Date(t).toISOString();
  }
}

// Страница со списком: сверху новые. Вид отчёта — «вылет», если сеанс
// оборвался без закрытия (с перезапуском — если игру открыли снова
// через считаные секунды), или «ошибки», если сеанс закрылся сам.
function reportsHtml(rows) {
  const items = rows.map((r) => {
    const b = r.body || {};
    const s = b.ses || {};
    const d = s.dev || {};
    let kind = b.kind === "crash" ? "обрыв" : "ошибки";
    if (b.kind === "crash" && typeof b.gap === "number" && b.gap < 30) {
      kind = "вылет, перезапуск через " + b.gap + " с";
    }
    const flags = (s.flags || []).join(", ");
    const ev = (s.ev || []).map((e) =>
      "<tr><td>" + esc(e[0]) + " с</td><td>" + esc(e[1]) + "</td><td>" + esc(e[2]) +
      "</td><td>" + (e[3] ? esc(e[3]) + " МБ" : "") + "</td></tr>").join("");
    return "<section><h2>" + esc(kind) + " · " + esc(msk(r.at)) + "</h2>" +
      "<p>" + esc(d.ua) + "</p>" +
      "<p>Телеграм " + esc(d.tg) + " · экран " + esc(d.scr) + " · плотность " + esc(d.dpr) +
      (d.mem ? " · память устройства " + esc(d.mem) + " ГБ" : "") +
      " · игрок " + esc(b.id) + " · версия " + esc(b.ver) + "</p>" +
      (flags ? "<p><b>" + esc(flags) + "</b></p>" : "") +
      "<p>сеанс длился " + esc(s.dur) + " с</p>" +
      "<table>" + ev + "</table></section>";
  }).join("");
  return "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'>" +
    "<title>Отчёты Пульса</title><style>body{font:14px/1.4 system-ui;margin:16px;background:#141110;color:#eee}" +
    "section{border-top:1px solid #444;padding:8px 0}h2{font-size:16px;color:#f5b842;margin:4px 0}" +
    "p{margin:2px 0;color:#bbb}td{padding:1px 8px 1px 0;vertical-align:top}b{color:#f77}</style>" +
    "<h1>Отчёты: " + rows.length + "</h1>" + (items || "<p>пока пусто</p>");
}

export class Room {
  constructor(state, env) {
    this.state = state;
    // Проверку связи (игра шлёт «ping» каждые 20 секунд) Cloudflare
    // отвечает сам, не будя комнату: спящая комната не тратит время
    // работы, а без этого пинги не давали бы ей уснуть всю дуэль.
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(req) {
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ role: "" });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // --- хранилище комнаты ---

  async load() {
    return (await this.state.storage.get("room")) || {
      host: null, guest: null, started: false, v: 0,
      log: { host: [], guest: [] },
    };
  }

  // Сохранить комнату и завести будильник: ближайший из «отошедший
  // игрок ушёл насовсем» и «брошенную комнату пора стереть».
  async save(r) {
    await this.state.storage.put("room", r);
    let at = Date.now() + ROOM_TTL_MS;
    for (const role of ["host", "guest"]) {
      const pl = r[role];
      if (pl && pl.away) at = Math.min(at, pl.away + AWAY_LIMIT_MS + 1000);
    }
    await this.state.storage.setAlarm(at);
  }

  sockets(role) {
    return this.state.getWebSockets().filter((ws) => {
      const a = ws.deserializeAttachment() || {};
      return a.role === role;
    });
  }

  to(role, m) {
    const text = JSON.stringify(m);
    for (const ws of this.sockets(role)) {
      try { ws.send(text); } catch (e) {}
    }
  }

  send(ws, m) {
    try { ws.send(JSON.stringify(m)); } catch (e) {}
  }

  startMsg(r, role) {
    return {
      k: "start", seed: r.seed, first: r.first, you: role,
      host: { deck: r.host.deck, info: r.host.info },
      guest: { deck: r.guest.deck, info: r.guest.info },
    };
  }

  // --- сообщения ---

  async webSocketMessage(ws, raw) {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== "object") return;
    const k = String(m.k || "");
    if (k === "ping") return;
    const r = await this.load();

    if (k === "hello") {
      const token = String(m.token || "");
      // Вернулся после обрыва.
      for (const role of ["host", "guest"]) {
        const pl = r[role];
        if (pl && pl.token === token) {
          // Отсутствовал слишком долго — сопернику уже засчитан уход.
          if (pl.gone) {
            this.send(ws, { k: "err", m: "gone" });
            return;
          }
          // Старое соединение того же игрока — закрыть.
          for (const old of this.sockets(role)) {
            if (old !== ws) { try { old.close(1000, "replaced"); } catch (e) {} }
          }
          ws.serializeAttachment({ role });
          pl.away = 0;
          await this.save(r);
          if (r.started) {
            this.send(ws, this.startMsg(r, role));
            const other = role === "host" ? "guest" : "host";
            const from = Math.max(0, Number(m.recv) || 0);
            this.send(ws, { k: "resume", from, acts: r.log[other].slice(from) });
            this.to(other, { k: "back" });
          } else {
            this.send(ws, { k: "wait" });
          }
          return;
        }
      }
      const v = Number(m.v) || 0;
      if (r.host && v !== r.v) {
        this.send(ws, { k: "err", m: "version" });
        return;
      }
      const pl = {
        token,
        deck: Array.isArray(m.deck) ? m.deck.slice(0, 60) : [],
        info: typeof m.info === "object" && m.info ? m.info : {},
        away: 0,
      };
      if (!r.host) {
        r.host = pl;
        r.v = v;
        ws.serializeAttachment({ role: "host" });
        await this.save(r);
        this.send(ws, { k: "wait" });
      } else if (!r.guest) {
        r.guest = pl;
        ws.serializeAttachment({ role: "guest" });
        r.seed = Math.floor(Math.random() * 2000000000);
        r.first = Math.random() < 0.5 ? "host" : "guest";
        r.started = true;
        await this.save(r);
        this.to("host", this.startMsg(r, "host"));
        this.to("guest", this.startMsg(r, "guest"));
      } else {
        this.send(ws, { k: "err", m: "full" });
      }
      return;
    }

    const role = (ws.deserializeAttachment() || {}).role || "";
    if (!role || !r[role]) return;
    const other = role === "host" ? "guest" : "host";

    if (k === "act") {
      const mine = r.log[role];
      const n = Number.isInteger(m.n) ? m.n : mine.length;
      // Досылка после обрыва: этот ход уже есть.
      if (n < mine.length) return;
      mine.push(m.a || {});
      await this.save(r);
      this.to(other, { k: "act", a: m.a || {}, n: mine.length - 1 });
    } else if (k === "bye") {
      this.to(other, { k: "left" });
      await this.state.storage.deleteAll();
    }
  }

  async webSocketClose(ws) {
    await this.gone(ws);
  }

  async webSocketError(ws) {
    await this.gone(ws);
  }

  // Соединение пропало: до начала — комнаты больше нет; в бою —
  // сопернику «отошёл», и через AWAY_LIMIT_MS — «ушёл».
  async gone(ws) {
    const role = (ws.deserializeAttachment() || {}).role || "";
    if (!role) return;
    // У игрока уже новое соединение (переподключился) — не в счёт.
    if (this.sockets(role).some((s) => s !== ws)) return;
    const r = await this.load();
    if (!r[role]) return;
    if (!r.started) {
      await this.state.storage.deleteAll();
      return;
    }
    r[role].away = Date.now();
    await this.save(r);
    this.to(role === "host" ? "guest" : "host", { k: "away" });
  }

  async alarm() {
    const r = await this.state.storage.get("room");
    if (!r) return;
    const now = Date.now();
    let alive = false;
    for (const role of ["host", "guest"]) {
      const pl = r[role];
      if (!pl) continue;
      if (pl.away && now - pl.away >= AWAY_LIMIT_MS && this.sockets(role).length === 0) {
        this.to(role === "host" ? "guest" : "host", { k: "left" });
        pl.away = 0;
        pl.gone = true;
      }
      if (this.sockets(role).length > 0) alive = true;
    }
    if (!alive) {
      await this.state.storage.deleteAll();
      return;
    }
    await this.save(r);
  }
}
