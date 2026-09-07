import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../engine/store.js";
import { Ledger } from "../engine/ledger.js";
import { Engine } from "../engine/engine.js";
import { PaperExecutor } from "../engine/paper.js";
import { defaults } from "../engine/model.js";
import { Controller } from "./control.js";
import { Telegram } from "./telegram.js";

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
