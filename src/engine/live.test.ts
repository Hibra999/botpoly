import { describe, expect, it, vi } from "vitest";
import { LiveExecutor } from "./live.js";
import { Store } from "./store.js";
import { Ledger } from "./ledger.js";
import { defaults, footballPolicy, type Order } from "./model.js";
import { authorizeLive, loadConfig, strategyBinding } from "../app/config.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BigNumber } from "ethers";
import { OrderType } from "@polymarket/client";
import { checksum } from "../research/dataset.js";

describe("frontera live", () => {
  it("no activa live con una clave solamente ni con el interruptor antiguo", () => {
    expect(() =>
      authorizeLive({ POLYMARKET_PRIVATE_KEY: "test-key" }),
    ).toThrow();
    expect(() =>
      loadConfig({ DRY_RUN: "false", TELEGRAM_BOT_TOKEN: "123456:test", TELEGRAM_CHAT_ID: "42" }),
    ).toThrow();
    expect(
      loadConfig({
        POLYMARKET_PRIVATE_KEY: "ignored-in-paper",
        TELEGRAM_BOT_TOKEN: "123456:test", TELEGRAM_CHAT_ID: "42",
      }).mode,
    ).toBe("paper");
  });
  it("fija FOK, persiste antes de enviar y no reenvía tras timeout", async () => {
    const store = new Store(":memory:"),
      ledger = new Ledger(store, "live", defaults);
    try {
      // Construct without authenticate/network; inject only the SDK request boundary.
      const live = Reflect.construct(LiveExecutor, [
        ledger,
        "0x" + "1".repeat(64),
        "http://127.0.0.1:1",
      ]) as LiveExecutor;
      const postOrder = vi.fn(async (signed: { orderType: string }) => {
        expect(signed.orderType).toBe(OrderType.FOK);
        expect(store.get("meta", "live:signed:order")).toBeDefined();
        throw new Error("timeout");
      });
      Object.assign(live, {
        client: {
          createLimitOrder: vi.fn(async () => ({ orderType: OrderType.GTC })),
          postOrder,
        },
        heartbeatAt: Date.now(),
      });
      const order: Order = {
        id: "order",
        pairId: "pair",
        marketId: "market",
        eventId: "event",
        underlying: "event",
        tokenId: "token",
        outcome: "YES",
        side: "BUY",
        quantity: 5,
        limit: 0.4,
        feeRate: 0.02,
        status: "submitted",
        timestamp: Date.now(),
        mode: "live",
        strategy: "yes-no",
      };
      store.put("meta", "live:strategies", [strategyBinding("yes-no", defaults)]);
      store.put("orders", order.id, order);
      await expect(live.execute(order)).rejects.toThrow("timeout");
      expect((await live.execute(order)).status).toBe("uncertain");
      expect(postOrder).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(ledger.snapshot())).not.toContain(
        "11111111111111111111",
      );
    } finally {
      store.close();
    }
  });
  it("una revisión YES/NO no habilita fútbol ni otra configuración", () => {
    const directory=mkdtempSync(join(tmpdir(),"botpoly-live-")),file=join(directory,"approval.json");
    writeFileSync(file,JSON.stringify({schema:1,outOfSampleReviewed:true,executionAndCostsReviewed:true,securityReviewed:true,approvedBy:"test",reportPath:"not-read",reportSha256:"test",strategies:[strategyBinding("yes-no",defaults)]}));
    expect(()=>authorizeLive({LIVE_ACK:"ACTIVAR_LIVE_CON_RIESGO_REAL",LIVE_EVIDENCE_FILE:file,POLYMARKET_PRIVATE_KEY:"test",POLYGON_RPC_URL:"http://127.0.0.1:1"})).toThrow("ambas estrategias");
    expect(strategyBinding("football-value",{...defaults,capitalUsd:500})).not.toEqual(strategyBinding("football-value",defaults));
  });
  it("rechaza evidencia ausente o malformada aunque su checksum sea correcto", () => {
    const directory = mkdtempSync(join(tmpdir(), "botpoly-live-evidence-"));
    const file = join(directory, "approval.json"), reportPath = join(directory, "result.json");
    const strategies = (["yes-no", "football-value"] as const).map(id => strategyBinding(id, defaults));
    const report = {
      strategies,
      manifest: { kind: "events", coverage: { maxGapMs: 1000, frames: 1000 } },
      trials: [{ label: "Riesgo mejorado", period: "evaluación", metrics: { netPnl: 10 }, bootstrap95: [1, 20],
        fills: Array.from({ length: 100 }, (_, i) => ({ id: `fill-${i}`, orderId: `order-${i}`, quantity: 1, gross: 0.4, fees: 0.01, timestamp: 1000 + i })) }],
      footballProspective: { strategy: "football-value", version: footballPolicy.version, configSha256: strategies[1].configSha256,
        kind: "prospective-paper", netPnl: 10, bootstrap95: [1, 20], confirmedFills: 100, officialSettlements: 1 },
    };
    const approval = { schema: 1, approvedBy: "test reviewer", outOfSampleReviewed: true, executionAndCostsReviewed: true,
      securityReviewed: true, footballProspectiveReviewed: true, strategies, reportPath };
    const env = { LIVE_ACK: "ACTIVAR_LIVE_CON_RIESGO_REAL", LIVE_EVIDENCE_FILE: file,
      POLYMARKET_PRIVATE_KEY: "test-only", POLYGON_RPC_URL: "http://127.0.0.1:1" };
    const write = (value: unknown, review: typeof approval | null = approval) => {
      const raw = JSON.stringify(value);
      writeFileSync(reportPath, raw);
      writeFileSync(file, JSON.stringify(review && { ...review, reportSha256: checksum(raw) }));
    };
    try {
      write(report);
      expect(authorizeLive(env).strategies).toEqual(strategies);
      const invalid: [string, unknown][] = [
        ["manifest.coverage", undefined], ["manifest.coverage.maxGapMs", undefined],
        ["manifest.coverage.maxGapMs", null], ["manifest.coverage.maxGapMs", -1],
        ["manifest.coverage.maxGapMs", "1000"], ["manifest.coverage.maxGapMs", 1001],
        ["manifest.coverage.frames", undefined], ["manifest.coverage.frames", "1000"],
        ["manifest.coverage.frames", 1000.5], ["manifest.coverage.frames", 999],
        ["manifest.coverage.frames", Number.MAX_SAFE_INTEGER + 1],
        ["trials", {}], ["trials", [null]], ["trials", [...report.trials, ...report.trials]],
        ["trials.0.metrics.netPnl", "10"], ["trials.0.metrics.netPnl", 0],
        ["trials.0.bootstrap95", { 0: 1, 1: 20 }], ["trials.0.bootstrap95", [1]],
        ["trials.0.bootstrap95", [2, 1]], ["trials.0.bootstrap95", [1, "20"]],
        ["trials.0.fills", undefined], ["trials.0.fills", { length: 100 }],
        ["trials.0.fills", report.trials[0].fills.slice(1)],
        ["trials.0.fills", Array(100).fill(null)], ["trials.0.fills", Array(100).fill(report.trials[0].fills[0])],
        ["trials.0.fills.0.quantity", "1"], ["trials.0.fills.0.gross", null],
        ["trials.0.fills.0.fees", -1], ["trials.0.fills.0.timestamp", "1000"],
        ["footballProspective", undefined], ["footballProspective.netPnl", "10"],
        ["footballProspective.bootstrap95", { 0: 1 }], ["footballProspective.bootstrap95", [1, null]],
        ["footballProspective.confirmedFills", "100"], ["footballProspective.confirmedFills", 100.5],
        ["footballProspective.confirmedFills", undefined], ["footballProspective.officialSettlements", "1"],
        ["footballProspective.officialSettlements", 0.5], ["footballProspective.officialSettlements", 0],
      ];
      for (const [path, value] of invalid) {
        const altered = JSON.parse(JSON.stringify(report)), keys = path.split("."), last = keys.pop()!;
        keys.reduce((parent, key) => parent[key], altered)[last] = value;
        write(altered);
        expect(() => authorizeLive(env), path).toThrow();
      }
      for (const value of [null, {}, []]) {
        write(value);
        expect(() => authorizeLive(env)).toThrow();
      }
      for (const review of [null, { ...approval, approvedBy: "  " }, { ...approval, footballProspectiveReviewed: false }]) {
        write(report, review);
        expect(() => authorizeLive(env)).toThrow();
      }
      // JSON permits finite-looking exponent syntax that parses to Infinity.
      write(report);
      const raw = JSON.stringify(report).replace('"netPnl":10', '"netPnl":1e400');
      writeFileSync(reportPath, raw);
      writeFileSync(file, JSON.stringify({ ...approval, reportSha256: checksum(raw) }));
      expect(() => authorizeLive(env)).toThrow();
      writeFileSync(reportPath, JSON.stringify(report));
      expect(() => authorizeLive(env)).toThrow(); // Changed bytes invalidate approval.
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("canje solo confirma tras recibo con dos confirmaciones y no reenvía", async () => {
    const store=new Store(":memory:"),ledger=new Ledger(store,"live",defaults);
    try {
      const live=Reflect.construct(LiveExecutor,[ledger,"0x"+"1".repeat(64),"http://127.0.0.1:1"]) as LiveExecutor;
      const receipt={status:1,confirmations:1,gasUsed:BigNumber.from(100000),effectiveGasPrice:BigNumber.from(1000000000)};
      Object.assign(live,{provider:{getTransactionReceipt:vi.fn(async()=>receipt)},nativeUsd:async()=>1});
      store.put("meta","live:tx:redeem:test",{hash:"test"});
      store.put("meta","live:strategies",[strategyBinding("football-value",defaults)]);
      const frame={marketId:"market",resolution:{payouts:[.5,.5],verifiedAt:Date.now(),source:"test",evidence:"mock-block"}} as import('./model.js').Frame;
      expect((await live.redeem("redeem:test",frame,5)).status).toBe("uncertain");
      receipt.confirmations=2;
      expect((await live.redeem("redeem:test",frame,5)).status).toBe("confirmed");
      receipt.status=0;expect((await live.reconcileRedeem("redeem:test",frame,5)).status).toBe("rejected");
    } finally {store.close();}
  });

});
