import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { Store } from "../engine/store.js";
import { Ledger } from "../engine/ledger.js";
import { Engine } from "../engine/engine.js";
import { PaperExecutor } from "../engine/paper.js";
import { defaults } from "../engine/model.js";
import { passwordHash, Sessions } from "./auth.js";
import { Controller } from "./control.js";
import { createDashboard } from "../dashboard/server.js";
import { Telegram } from "./telegram.js";

const password = "test-only-password-123456";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
});
function context() {
  const store = new Store(":memory:");
  cleanups.push(() => store.close());
  const l = new Ledger(store, "paper", defaults),
    engine = new Engine(l, new PaperExecutor("paper", async () => undefined));
  return { store, l, controller: new Controller(engine) };
}
async function server() {
  const ctx = context(),
    app = createDashboard(ctx.controller, {
      passwordHash: passwordHash(password),
      port: 0,
    });
  await app.start();
  cleanups.push(() => app.close());
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  return {
    ...ctx,
    app,
    origin,
    headers: { Origin: origin, "Content-Type": "application/json" },
  };
}
describe("autenticación y comandos", () => {
  it("protege HTTP, valida origen y no serializa secretos", async () => {
    const s = await server();
    expect((await fetch(s.origin + "/api/status")).status).toBe(401);
    expect(
      (
        await fetch(s.origin + "/api/login", {
          method: "POST",
          headers: { ...s.headers, Origin: "https://evil.invalid" },
          body: JSON.stringify({ password }),
        })
      ).status,
    ).toBe(403);
    const login = await fetch(s.origin + "/api/login", {
      method: "POST",
      headers: s.headers,
      body: JSON.stringify({ password }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    const response = await fetch(s.origin + "/api/status", {
      headers: { Cookie: cookie.split(";")[0] },
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain(password);
    expect(body).not.toContain("POLYMARKET_PRIVATE_KEY");
    const command = await fetch(s.origin + "/api/command", {
      method: "POST",
      headers: { ...s.headers, Cookie: cookie },
      body: JSON.stringify({ id: "x", command: "toggleDryRun" }),
    });
    expect(command.status).toBe(400);
  });
  it("deniega WebSocket anónimo o de otro origen", async () => {
    const s = await server();
    const status = await new Promise<number>((resolve) => {
      const ws = new WebSocket(s.origin.replace("http:", "ws:") + "/ws", {
        origin: s.origin,
      });
      ws.on("unexpected-response", (_req, res) => {
        res.resume();
        ws.terminate();
        resolve(res.statusCode!);
      });
      ws.on("error", () => {});
    });
    expect(status).toBe(403);
  });
  it("confirma comandos WebSocket autenticados y los conserva", async () => {
    const s = await server();
    const login = await fetch(s.origin + "/api/login", {
      method: "POST",
      headers: s.headers,
      body: JSON.stringify({ password }),
    });
    const result = await new Promise<{ ok: boolean }>((resolve, reject) => {
      const ws = new WebSocket(s.origin.replace("http:", "ws:") + "/ws", {
        origin: s.origin,
        headers: { Cookie: login.headers.get("set-cookie")! },
      });
      ws.on("open", () =>
        ws.send(JSON.stringify({ id: "ws:pause", command: "pause" })),
      );
      ws.on("message", (raw) => {
        const m = JSON.parse(String(raw));
        if (m.type === "result") {
          ws.close();
          resolve(m.payload);
        }
      });
      ws.on("error", reject);
    });
    expect(result.ok).toBe(true);
    expect(s.l.account.stop).toBe("Pausa autorizada");
    expect(s.store.get("commands", "ws:pause")).toBeDefined();
  });
  it("limita intentos y caduca sesiones", () => {
    let now = 0;
    const auth = new Sessions(passwordHash(password), () => now);
    for (let i = 0; i < 5; i++) expect(auth.login("incorrect")).toBeNull();
    expect(auth.login(password)).toBeNull();
    now = 61000;
    expect(auth.login(password)).toMatch(/^[a-f0-9]{64}$/);
  });
});
describe("Telegram privado y persistente", () => {
  it("ignora chats y remitentes ajenos, no repite comandos tras reinicio", async () => {
    const ctx = context(),
      token = "123456:test_token";
    const bot = new Telegram(ctx.controller, token, "42");
    const update = {
      update_id: 1,
      message: {
        date: Math.floor(Date.now() / 1000),
        text: "/pause",
        chat: { id: 42, type: "group" },
        from: { id: 42 },
      },
    };
    await bot.process(update);
    expect(ctx.l.account.stop).toBeNull();
    await bot.process({
      ...update,
      update_id: 2,
      message: {
        ...update.message,
        chat: { id: 42, type: "private" },
        from: { id: 17 },
      },
    });
    expect(ctx.l.account.stop).toBeNull();
    const allowed = {
      ...update,
      update_id: 3,
      message: { ...update.message, chat: { id: 42, type: "private" } },
    };
    await bot.process(allowed);
    const count = ctx.store.all("events").length;
    await new Telegram(ctx.controller, token, "42").process(allowed);
    expect(ctx.store.all("events")).toHaveLength(count);
    expect(ctx.store.get("meta", "telegram:offset")).toBe(4);
    expect(JSON.stringify(ctx.l.snapshot())).not.toContain(token);
  });
  it("conserva salida pendiente ante rate limit y reintenta después de retry_after", async () => {
    const ctx = context();
    let now = 1000,
      count = 0;
    const request: typeof fetch = async () => {
      count++;
      return new Response(
        JSON.stringify(
          count === 1
            ? { ok: false, parameters: { retry_after: 30 } }
            : { ok: true },
        ),
        { status: count === 1 ? 429 : 200 },
      );
    };
    const bot = new Telegram(
      ctx.controller,
      "123456:test",
      "42",
      request,
      () => now,
    );
    bot.enqueue("test", "hello");
    await bot.flush();
    await bot.flush();
    expect(count).toBe(1);
    now += 30001;
    await bot.flush();
    expect(count).toBe(2);
    expect(ctx.store.all("outbox")).toHaveLength(0);
  });
});
