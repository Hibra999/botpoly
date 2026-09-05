import { describe, expect, it, vi } from "vitest";
import { LiveExecutor } from "./live.js";
import { Store } from "./store.js";
import { Ledger } from "./ledger.js";
import { defaults, type Order } from "./model.js";
import { authorizeLive, loadConfig } from "../app/config.js";
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
});
