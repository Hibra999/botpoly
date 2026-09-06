import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { Market } from "@polymarket/client";
import { strategyBinding } from "../app/config.js";
import { PaperGas } from "./paper-gas.js";
import { MarketData, eligibleMarket } from "./market-data.js";
import { Store } from "../engine/store.js";
import { Ledger } from "../engine/ledger.js";
import { Engine } from "../engine/engine.js";
import { PaperExecutor, simulationDefaults } from "../engine/paper.js";
import { defaults, type Executor, validateFrame } from "../engine/model.js";
import { readDataset } from "./dataset.js";
import { writePaperReport } from "./paper-report.js";

const sample = readDataset("fixtures/demo.jsonl").frames[0];
const market = (id: string, negRisk = false) =>
  ({
    id,
    conditionId: id,
    tags: [],
    events: [],
    metrics: {},
    sports: {},
    trading: {},
    resolution: {},
    state: {
      active: true,
      closed: false,
      archived: false,
      negRisk,
      acceptingOrders: true,
      enableOrderBook: true,
    },
    outcomes: {
      yes: { label: "Yes", tokenId: "yes" },
      no: { label: "No", tokenId: "no" },
    },
  }) as unknown as Market;
const response = (now: number) =>
  vi.fn(
    async (url: string | URL | Request) =>
      new Response(
        JSON.stringify(
          String(url).includes("gasstation")
            ? { fast: { maxFee: 200 }, blockTimestamp: now / 1000 }
            : { data: { amount: "0.1", base: "POL", currency: "USD" } },
        ),
      ),
  ) as unknown as typeof fetch;

describe("paper durante varios días", () => {
  it("no reutiliza liquidez del mismo libro ni repite fills después de reiniciar", async () => {
    const store = new Store(":memory:");
    try {
      const f = structuredClone(sample);
      f.yes.hash = "book-1";
      f.yes.asks = [{ price: 0.4, size: 5 }];
      const ledger = new Ledger(
        store,
        "paper",
        defaults,
        () => sample.timestamp,
      );
      const create = () =>
        new PaperExecutor(
          "paper",
          async () => structuredClone(f),
          () => sample.timestamp,
          simulationDefaults,
          5000,
          store,
        );
      const first = create(),
        engine = new Engine(ledger, first);
      engine.health(true);
      const order = engine.reserve(f)![0];
      const result = await first.execute(order);
      expect(result.fills).toHaveLength(1);
      const restarted = create();
      expect(await restarted.execute(order)).toEqual(result);
      expect(
        (await restarted.execute({ ...order, id: "next" })).fills,
      ).toHaveLength(0);
      f.yes.hash = "book-2";
      expect(
        (await restarted.execute({ ...order, id: "replenished" })).fills,
      ).toHaveLength(1);
    } finally {
      store.close();
    }
  });
  it("consulta gas dinámico, conserva su condición de supuesto y no usa una cotización caducada", async () => {
    let now = sample.timestamp;
    const request = response(now),
      gas = new PaperGas(300000, 1.5, request, () => now);
    const q = (await gas.quote())!;
    expect(q.mergeGasUsd).toBe(0.009);
    expect(q.verified).toBe(false);
    expect(q.paperGas?.units).toBe(300000);
    expect(await gas.quote()).toEqual(q);
    now += 120000;
    expect(await gas.quote()).toBeUndefined();
    expect(() => new PaperGas(0)).toThrow();
    expect(() =>
      validateFrame({
        ...sample,
        gasVerified: false,
        mergeGasUsd: 99,
        paperGas: q.paperGas,
      }),
    ).toThrow();
  });
  it("pagina más allá de mercados incompatibles y verifica los IDs explícitos", async () => {
    const data = new MarketData();
    vi.spyOn(data.football, "refresh").mockResolvedValue();
    const listMarkets = vi.fn(() => ({
      async *[Symbol.asyncIterator]() {
        yield { items: [market("bad", true)] };
        yield {
          items: Array.from({ length: 20 }, (_, i) => market(String(i))),
        };
      },
    }));
    Object.assign(data, {
      client: {
        listMarkets,
        listSports: async () => [],
        listEvents: async function* () {},
        fetchMarket: async ({ id }: { id: string }) => market(id, id === "bad"),
      },
    });
    expect(await data.markets()).toHaveLength(20);
    expect((await data.markets(["bad", "good"])).map((m) => m.id)).toEqual([
      "good",
    ]);
    expect(
      eligibleMarket({
        ...market("closed"),
        state: { ...market("closed").state, closed: true },
      }),
    ).toBe(false);
  });
  it("simula cinco días con fills, archivo comprimido, contadores persistentes e informe reproducible", async () => {
    const folder = mkdtempSync(join(tmpdir(), "botpoly-days-")),
      path = join(folder, "paper.sqlite");
    let now = sample.timestamp,
      current = structuredClone(sample);
    let store = new Store(path);
    try {
      const ledger = new Ledger(store, "paper", defaults, () => now);
      const executor = new PaperExecutor(
        "paper",
        async () => structuredClone(current),
        () => now,
        { ...simulationDefaults, latencyMs: 0 },
      );
      const engine = new Engine(ledger, executor);
      for (let day = 0; day < 5; day++) {
        now = sample.timestamp + day * 86400000;
        const q = (await new PaperGas(
          300000,
          1.5,
          response(now),
          () => now,
        ).quote())!;
        current = {
          ...structuredClone(sample),
          id: `day-${day}`,
          timestamp: now,
          gasVerified: false,
          mergeGasUsd: q.mergeGasUsd,
          paperGas: q.paperGas,
        };
        current.yes.timestamp = current.no.timestamp = now;
        store.recordBook(current);
        store.recordBook(current);
        engine.health(true);
        await engine.process(current);
      }
      expect(store.all("fills").length).toBeGreaterThan(0);
      expect(ledger.account.gas).toBeGreaterThan(0);
      expect(ledger.snapshot().statistics).toHaveLength(5);
      expect(
        ledger
          .snapshot()
          .statistics.reduce((n, d) => n + (d.counts.evaluated ?? 0), 0),
      ).toBe(5);
      const net = ledger.metrics().netPnl;
      const blob = store.db
        .prepare("SELECT data FROM recorded_books LIMIT 1")
        .get()!.data as Uint8Array;
      expect(JSON.parse(gunzipSync(blob).toString()).paperGas.units).toBe(
        300000,
      );
      store.close();
      store = new Store(path);
      const restarted = new Ledger(store, "paper", defaults, () => now);
      expect(restarted.metrics().netPnl).toBe(net);
      const html = writePaperReport(restarted, join(folder, "report"), 5);
      expect(readFileSync(html, "utf8")).toContain("unidades supuestas");
      const result = JSON.parse(
        readFileSync(join(folder, "report/result.json"), "utf8"),
      );
      expect(result.recordedBooks).toBe(5);
      expect(result.totals.evaluated).toBe(5);
      expect(result.status).toBe("exploratorio");
    } finally {
      store.close();
    }
  });
  it("un modelo paper no autoriza live y una ejecución no usa libros obsoletos", async () => {
    const q = (await new PaperGas(
      300000,
      1.5,
      response(sample.timestamp),
      () => sample.timestamp,
    ).quote())!;
    const f = {
      ...structuredClone(sample),
      gasVerified: false,
      mergeGasUsd: q.mergeGasUsd,
      paperGas: q.paperGas,
    };
    const store = new Store(":memory:");
    try {
      const ledger = new Ledger(
        store,
        "live",
        defaults,
        () => sample.timestamp,
      );
      const executor = Object.assign(
        new PaperExecutor("paper", async () => f),
        { mode: "live" },
      ) as unknown as Executor;
      const engine = new Engine(ledger, executor);
      engine.health(true);
      store.put("meta", "live:strategies", [strategyBinding("yes-no", ledger.config)]);
      expect(engine.reserve(f)).toBeNull();
      expect(store.all("orders")).toHaveLength(0);
      expect(ledger.snapshot().events[0].message).toBe("Costes sin verificar");
    } finally {
      store.close();
    }
    const paperStore = new Store(":memory:");
    try {
      const ledger = new Ledger(
        paperStore,
        "paper",
        defaults,
        () => sample.timestamp,
      );
      const executor = new PaperExecutor(
        "paper",
        async () => structuredClone(sample),
        () => sample.timestamp + 10000,
      );
      const engine = new Engine(ledger, executor);
      engine.health(true);
      const orders = engine.reserve(sample)!;
      expect((await executor.execute(orders[0])).fills).toHaveLength(0);
    } finally {
      paperStore.close();
    }
  });
});
