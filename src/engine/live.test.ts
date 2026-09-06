import { describe, expect, it, vi } from "vitest";
import { LiveExecutor } from "./live.js";
import { Store } from "./store.js";
import { Ledger } from "./ledger.js";
import { defaults, type Order } from "./model.js";
import { authorizeLive, loadConfig, strategyBinding } from "../app/config.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BigNumber } from "ethers";
import { OrderType } from "@polymarket/client";

describe("frontera live", () => {
  it("no activa live con una clave solamente ni con el interruptor antiguo", () => {
    expect(() =>
      authorizeLive({ POLYMARKET_PRIVATE_KEY: "test-key" }),
    ).toThrow();
    expect(() =>
      loadConfig({ DRY_RUN: "false", DASHBOARD_PASSWORD_HASH: "test" }),
    ).toThrow();
    expect(
      loadConfig({
        POLYMARKET_PRIVATE_KEY: "ignored-in-paper",
        DASHBOARD_PASSWORD_HASH: "test",
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
