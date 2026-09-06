import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.js";
import { Ledger } from "./ledger.js";
import { Engine } from "./engine.js";
import { PaperExecutor, simulationDefaults } from "./paper.js";
import {
  defaults,
  type Frame,
  type Order,
  type Executor,
  validateConfig,
} from "./model.js";
import { Controller } from "../app/control.js";

const stores: Store[] = [];
afterEach(() => {
  stores.splice(0).forEach((s) => s.close());
});
export function frame(timestamp = Date.UTC(2026, 0, 1)): Frame {
  return {
    id: `test:${timestamp}`,
    timestamp,
    marketId: "test",
    eventId: "event",
    underlying: "event",
    title: "Mercado de prueba",
    binary: true,
    negRisk: false,
    feeRate: 0.02,
    feeVerified: true,
    mergeGasUsd: 0.02,
    recoveryGasUsd: 0.02,
    gasVerified: true,
    source: "synthetic",
    depth: true,
    yes: {
      tokenId: "yes",
      timestamp,
      bids: [{ price: 0.43, size: 1000 }],
      asks: [{ price: 0.44, size: 1000 }],
      minSize: 5,
      tickSize: 0.01,
    },
    no: {
      tokenId: "no",
      timestamp,
      bids: [{ price: 0.48, size: 1000 }],
      asks: [{ price: 0.49, size: 1000 }],
      minSize: 5,
      tickSize: 0.01,
    },
  };
}
function setup(
  options: { capital?: number; path?: string; executor?: Executor } = {},
) {
  let time = Date.UTC(2026, 0, 1);
  const f = frame(time),
    s = new Store(options.path ?? ":memory:");
  stores.push(s);
  const l = new Ledger(
    s,
    "paper",
    { ...defaults, capitalUsd: options.capital ?? 1000 },
    () => time,
  );
  const executor =
    options.executor ??
    new PaperExecutor(
      "paper",
      async () => f,
      () => time,
      { ...simulationDefaults, latencyMs: 0 },
    );
  const engine = new Engine(l, executor);
  engine.health(true);
  const a = l.account;
  a.lastDataAt = time;
  l.save(a);
  return {
    f,
    s,
    l,
    engine,
    advance: (ms: number) => {
      time += ms;
    },
  };
}
describe("reservas, ejecuciones y contabilidad", () => {
  it("cuenta aceptaciones una sola vez dentro de la reserva", () => {
    const { f, engine, s } = setup();
    expect(engine.reserve(f)).toHaveLength(2);
    expect(engine.reserve(f)).toBeNull();
    expect(s.all<{ counts: Record<string, number> }>("statistics")[0].counts.accepted).toBe(1);
  });
  it("conserva un tamaño rentable aunque agotar el presupuesto pierda dinero", () => {
    const { f, engine, l, s } = setup();
    s.put("meta", "config", { ...l.config, maxSlippageBps: 1000 });
    f.feeRate = 0;
    for (const b of [f.yes, f.no]) b.asks = [{ price: 0.49, size: 5 }, { price: 0.51, size: 1000 }];
    expect(engine.reserve(f)?.map((o) => o.quantity)).toEqual([5, 5]);
  });
  it("conserva la última valoración obsoleta y bloquea nuevas entradas", () => {
    const { f, engine, l, advance } = setup();
    const order = engine.reserve(f)![0];
    l.store.transaction(() => l.fill(order, { id: "stale-fill", orderId: order.id, quantity: 5, gross: 2.2, fees: 0.01, timestamp: f.timestamp }));
    l.mark(f);
    const pnl = l.metrics().netPnl;
    advance(10000);
    l.mark();
    expect(l.metrics().netPnl).toBe(pnl);
    expect(l.positions[0].stale).toBe(true);
    expect(engine.reserve({ ...f, id: "later" })).toBeNull();
    f.timestamp += 10000;
    for (const book of [f.yes, f.no]) book.verifiedAt = f.timestamp;
    l.mark(f);
    expect(l.positions[0].stale).toBe(false);
  });
  it("no atribuye beneficios a una señal; contabiliza solo fills y fusión", async () => {
    const { f, l, engine } = setup();
    const orders = engine.reserve(f)!;
    expect(orders).toHaveLength(2);
    expect(l.account.realized).toBe(0);
    expect(l.metrics().reserved).toBeGreaterThan(0);
    await engine.cancelOrders();
    expect(l.metrics().reserved).toBe(0);
    await engine.process({ ...f, id: "next" });
    expect(l.account.realized).toBeGreaterThan(0);
    expect(l.account.fees).toBeGreaterThan(0);
    expect(l.account.gas).toBe(0.02);
    expect(l.metrics().netPnl).toBeCloseTo(l.account.realized, 6);
    expect(l.positions).toEqual([]);
  });
  it("omite el mínimo del mercado con US$50 y riesgo de una pata al 1%", () => {
    const { f, engine, l } = setup({ capital: 50 });
    expect(engine.reserve(f)).toBeNull();
    expect(l.metrics().reserved).toBe(0);
  });
  it("no duplica señales concurrentes ni compromete más capital del permitido", async () => {
    const { f, engine, l, s } = setup();
    await Promise.all(
      Array.from({ length: 12 }, () => engine.process(structuredClone(f))),
    );
    expect(s.all("fills")).toHaveLength(2);
    expect(l.metrics().available).toBeGreaterThan(0);
    expect(l.metrics().reserved).toBe(0);
  });
  it("serializa reservas desde dos conexiones SQLite", () => {
    const path = join(mkdtempSync(join(tmpdir(), "botpoly-")), "ledger.sqlite");
    const a = setup({ path }),
      b = setup({ path });
    for (let i = 0; i < 30; i++)
      (i % 2 ? a : b).engine.reserve({ ...frame(), id: String(i) });
    expect(a.l.metrics().exposure).toBeLessThanOrEqual(100.000001);
    expect(a.l.metrics().available).toBeGreaterThanOrEqual(0);
  });
  it("conserva paradas, reservas y configuración al reiniciar", () => {
    const path = join(mkdtempSync(join(tmpdir(), "botpoly-")), "ledger.sqlite");
    const a = setup({ path });
    a.engine.reserve(a.f);
    a.l.stop("Pausa autorizada");
    const b = setup({ path, capital: 5000 });
    expect(b.l.account.stop).toBe("Pausa autorizada");
    expect(b.l.metrics().reserved).toBe(a.l.metrics().reserved);
    expect(b.l.config.capitalUsd).toBe(1000);
  });
  it("incluye pérdidas no realizadas y no borra la parada al cambiar de día", () => {
    const { f, l, engine, advance } = setup();
    const orders = engine.reserve(f)!;
    l.store.transaction(() =>
      l.fill(orders[0], {
        id: "external-fill",
        orderId: orders[0].id,
        quantity: 5,
        gross: 2.2,
        fees: 0.02,
        timestamp: f.timestamp,
      }),
    );
    f.yes.bids = [];
    l.mark(f);
    expect(l.metrics().unrealized).toBe(-2.22);
    l.stop("Pérdida");
    advance(86400000);
    l.mark();
    expect(l.account.stop).toBe("Pérdida");
    expect(l.metrics().dailyPnl).toBe(0);
  });
  it("concilia timeout antes de salir y nunca reenvía la orden incierta", async () => {
    let executions = 0,
      reconciles = 0;
    const ex: Executor = {
      mode: "paper",
      execute: async () => {
        executions++;
        throw Error("timeout");
      },
      reconcile: async () => {
        reconciles++;
        return { status: "uncertain", fills: [] };
      },
      cancel: async () => ({ status: "uncertain", fills: [] }),
      merge: async () => {
        throw Error();
      },
    };
    const { f, l, engine } = setup({ executor: ex });
    await engine.process(f);
    await engine.process({ ...f, id: "again" });
    await engine.reconcile();
    expect(executions).toBe(1);
    expect(reconciles).toBe(2);
    expect(l.account.stop).toContain("incierta");
    expect(l.metrics().reserved).toBeGreaterThan(0);
  });
  it("reconcilia un timeout confirmado sin duplicar el fill", async () => {
    const ctx = setup();
    const paper = new PaperExecutor(
      "paper",
      async () => ctx.f,
      () => ctx.f.timestamp,
      { ...simulationDefaults, latencyMs: 0 },
    );
    const ex: Executor = {
      mode: "paper",
      execute: async (o) => {
        await paper.execute(o);
        throw Error("timeout");
      },
      reconcile: (o) => paper.reconcile(o),
      cancel: (o) => paper.cancel(o),
      merge: (id, f, q) => paper.merge(id, f, q),
    };
    const engine = new Engine(ctx.l, ex);
    await engine.process(ctx.f);
    await engine.reconcile();
    expect(ctx.s.all("fills")).toHaveLength(2);
    expect(ctx.l.metrics().reserved).toBe(0);
  });
  it("recupera una pata fallida mediante una salida limitada", async () => {
    const ctx = setup();
    const ex = new PaperExecutor(
      "paper",
      async () => ctx.f,
      () => ctx.f.timestamp,
      { ...simulationDefaults, latencyMs: 0, failNoEvery: 2 },
    );
    await new Engine(ctx.l, ex).process(ctx.f);
    expect(ctx.l.positions).toEqual([]);
    expect(ctx.l.account.realized).toBeLessThan(0);
    expect(ctx.l.metrics().reserved).toBe(0);
  });
  it.each(["confirmed", "rejected"] as const)(
    "concilia fusión %s tras timeout sin reenviar ni duplicar gas",
    async (status) => {
      const ctx = setup();
      const paper = new PaperExecutor(
        "paper",
        async () => ctx.f,
        () => ctx.f.timestamp,
        { ...simulationDefaults, latencyMs: 0 },
      );
      let submissions = 0;
      const executor: Executor = {
        mode: "paper",
        execute: (o) => paper.execute(o),
        reconcile: (o) => paper.reconcile(o),
        cancel: (o) => paper.cancel(o),
        merge: async () => {
          submissions++;
          throw Error("timeout");
        },
        reconcileMerge: async (id) => ({
          id,
          status,
          gas: 0.03,
          timestamp: ctx.f.timestamp,
        }),
      };
      const engine = new Engine(ctx.l, executor);
      await engine.process(ctx.f);
      expect(ctx.l.positions).toHaveLength(2);
      expect(ctx.l.metrics().reserved).toBeGreaterThan(0);
      await engine.process({ ...ctx.f, id: "reconcile-1" });
      await engine.process({ ...ctx.f, id: "reconcile-2" });
      expect(submissions).toBe(1);
      expect(ctx.l.account.gas).toBe(0.03);
      expect(ctx.l.positions).toHaveLength(status === "confirmed" ? 0 : 2);
      expect(ctx.s.all("settlements")).toHaveLength(
        status === "confirmed" ? 1 : 0,
      );
      expect(ctx.l.account.stop).toBeTruthy();
    },
  );
  it("para ante falta de liquidez en una pata sin cobertura", async () => {
    const ctx = setup();
    ctx.f.yes.bids = [];
    const ex = new PaperExecutor(
      "paper",
      async () => ctx.f,
      () => ctx.f.timestamp,
      { ...simulationDefaults, latencyMs: 0, failNoEvery: 2 },
    );
    await new Engine(ctx.l, ex).process(ctx.f);
    expect(ctx.l.account.stop).toContain("Pata");
    expect(ctx.l.positions).toHaveLength(1);
  });
  it("cambiar presupuesto no crea dinero ni PnL; comandos duplicados son idempotentes", async () => {
    const { engine, l } = setup();
    const controller = new Controller(engine);
    const c = {
      id: "config:1",
      command: "set_config",
      payload: { ...defaults, capitalUsd: 50 },
    };
    expect((await controller.execute(c)).ok).toBe(true);
    expect(await controller.execute(c)).toEqual({
      id: "config:1",
      ok: true,
      message: "Comando aplicado",
    });
    expect(l.account.cash).toBe(1000);
    expect(l.metrics().netPnl).toBe(0);
    expect(l.metrics().operationalCapital).toBe(50);
  });
  it("reduce tamaño al menos a la mitad con drawdown del 5% sin elevar límites por ganancias", () => {
    const { l } = setup();
    const a = l.account;
    a.cash = 950;
    l.save(a);
    expect(l.metrics().sizeFactor).toBeCloseTo(0.5);
    a.cash = 1100;
    l.save(a);
    expect(l.metrics().operationalCapital).toBe(1000);
  });
  it("rechaza datos obsoletos, coste desconocido y parámetros no finitos", () => {
    const { f, engine, advance } = setup();
    advance(10000);
    expect(engine.reserve(f)).toBeNull();
    expect(() => validateConfig({ capitalUsd: Infinity })).toThrow();
    expect(() => validateConfig({ dailyLossPct: 0 })).toThrow();
  });
  it("rechaza un fill que sobrepasa precio o tamaño y revierte la transacción", () => {
    const { f, l, engine } = setup();
    const o = engine.reserve(f)![0];
    expect(() =>
      l.store.transaction(() =>
        l.fill(o, {
          id: "bad",
          orderId: o.id,
          quantity: 2,
          gross: 9,
          fees: 0,
          timestamp: f.timestamp,
        }),
      ),
    ).toThrow();
    expect(l.store.all("fills")).toHaveLength(0);
    expect(l.account.cash).toBe(1000);
  });
  it("mantiene PnL y drawdown independientes de depósitos y retiradas", () => {
    const { l } = setup();
    const a = l.account;
    a.cash = 990;
    l.save(a);
    const before = l.metrics();
    l.cashflow("deposit-1", 500, "deposit");
    l.cashflow("deposit-1", 500, "deposit");
    l.cashflow("withdrawal-1", 100, "withdrawal");
    expect(l.account.cash).toBe(1390);
    expect(l.metrics().netPnl).toBe(before.netPnl);
    expect(l.metrics().drawdown).toBe(before.drawdown);
  });
  it("permite salida con liquidez recuperada durante una pausa", async () => {
    const ctx = setup();
    ctx.f.yes.bids = [];
    const ex = new PaperExecutor(
      "paper",
      async () => ctx.f,
      () => ctx.f.timestamp,
      { ...simulationDefaults, latencyMs: 0, failNoEvery: 2 },
    );
    const engine = new Engine(ctx.l, ex);
    await engine.process(ctx.f);
    expect(ctx.l.positions).toHaveLength(1);
    ctx.f.yes.bids = [{ price: 0.43, size: 100 }];
    ctx.f.id = "liquidity-returned";
    await engine.process(ctx.f);
    expect(ctx.l.positions).toHaveLength(0);
    expect(ctx.l.account.stop).not.toBeNull();
    expect(ctx.l.metrics().reserved).toBe(0);
  });
  it("recupera ejecuciones parciales sin fusionar cantidades inexistentes", async () => {
    const ctx = setup();
    const ex = new PaperExecutor(
      "paper",
      async () => ctx.f,
      () => ctx.f.timestamp,
      { ...simulationDefaults, latencyMs: 0, partialEvery: 2 },
    );
    await new Engine(ctx.l, ex).process(ctx.f);
    expect(ctx.l.positions).toHaveLength(0);
    expect(ctx.l.metrics().reserved).toBe(0);
    expect(ctx.l.metrics().netPnl).toBeCloseTo(ctx.l.account.realized, 6);
  });
  it("mantiene una parada diaria tras reiniciar en el mismo día UTC", () => {
    const path = join(mkdtempSync(join(tmpdir(), "botpoly-")), "ledger.sqlite"),
      a = setup({ path });
    const account = a.l.account;
    account.cash = 979;
    a.l.save(account);
    a.l.mark();
    const b = setup({ path });
    expect(b.l.account.stop).toBe("Límite de pérdida diaria");
    expect(b.l.metrics().dailyPnl).toBe(-21);
  });
});
