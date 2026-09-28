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

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
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

export class Room {
  constructor(state, env) {
    this.state = state;
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
