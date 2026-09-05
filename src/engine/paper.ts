import {
  type Execution,
  type Executor,
  type Frame,
  type Order,
  type Settlement,
  quote,
  money,
} from "./model.js";

export interface SimulationConfig {
  latencyMs: number;
  rejectEvery: number;
  partialEvery: number;
  failNoEvery: number;
  gasMultiplier: number;
  depthMultiplier: number;
  resolutionDelayMs: number;
}
export const simulationDefaults: SimulationConfig = {
  latencyMs: 500,
  rejectEvery: 0,
  partialEvery: 0,
  failNoEvery: 0,
  gasMultiplier: 1,
  depthMultiplier: 1,
  resolutionDelayMs: 0,
};
/** Has no signing key, secure SDK client, RPC transport, or transaction methods. */
export class PaperExecutor implements Executor {
  private results = new Map<string, Execution>();
  private count = 0;
  constructor(
    readonly mode: "paper" | "backtest",
    private at: (market: string, time: number) => Promise<Frame | undefined>,
    readonly now: () => number = Date.now,
    readonly config: SimulationConfig = simulationDefaults,
  ) {}
  async execute(order: Order): Promise<Execution> {
    if (this.results.has(order.id)) return this.results.get(order.id)!;
    const reject: Execution = { status: "rejected", fills: [] };
    const count = ++this.count;
    const frame = await this.at(
      order.marketId,
      this.now() + this.config.latencyMs,
    );
    if (
      !frame ||
      (this.config.rejectEvery > 0 && count % this.config.rejectEvery === 0) ||
      (order.side === "BUY" &&
        order.outcome === "NO" &&
        this.config.failNoEvery > 0 &&
        count % this.config.failNoEvery === 0)
    ) {
      this.results.set(order.id, reject);
      return reject;
    }
    const book = order.outcome === "YES" ? frame.yes : frame.no;
    const levels = (order.side === "BUY" ? book.asks : book.bids).map((l) => ({
      ...l,
      size: l.size * this.config.depthMultiplier,
    }));
    // FOK is all-or-nothing under normal simulation. Partial fills are injected
    // only as an explicit abnormal-execution stress scenario.
    const q =
      this.config.partialEvery > 0 && count % this.config.partialEvery === 0
        ? money(order.quantity / 2)
        : order.quantity;
    const fill = quote(levels, q, frame.feeRate, order.side, order.limit);
    if (!fill) {
      this.results.set(order.id, reject);
      return reject;
    }
    // Consume this snapshot's liquidity; subsequent orders cannot reuse it.
    let remaining = q;
    const source = order.side === "BUY" ? book.asks : book.bids;
    source.sort((a, b) =>
      order.side === "BUY" ? a.price - b.price : b.price - a.price,
    );
    for (const level of source) {
      if (
        order.side === "BUY"
          ? level.price > order.limit
          : level.price < order.limit
      )
        continue;
      const take = Math.min(
        remaining,
        level.size * this.config.depthMultiplier,
      );
      level.size -= take / this.config.depthMultiplier;
      remaining -= take;
      if (remaining < 1e-7) break;
    }
    book.asks = book.asks.filter((l) => l.size > 1e-7);
    book.bids = book.bids.filter((l) => l.size > 1e-7);
    const result: Execution = {
      status: "confirmed",
      fills: [
        {
          id: `sim:${order.id}`,
          orderId: order.id,
          quantity: q,
          gross: fill.gross,
          fees: fill.fees,
          timestamp: this.now(),
        },
      ],
    };
    this.results.set(order.id, result);
    return result;
  }
  async reconcile(order: Order): Promise<Execution> {
    return this.results.get(order.id) ?? { status: "not_found", fills: [] };
  }
  async cancel(order: Order): Promise<Execution> {
    return this.reconcile(order);
  }
  async merge(
    id: string,
    frame: Frame,
    _quantity: number,
  ): Promise<Settlement> {
    if (this.config.resolutionDelayMs > 0) {
      const future = await this.at(
        frame.marketId,
        this.now() + this.config.resolutionDelayMs,
      );
      if (!future)
        return { id, status: "uncertain", gas: 0, timestamp: this.now() };
    }
    return {
      id,
      status: "confirmed",
      gas: money(frame.mergeGasUsd * this.config.gasMultiplier),
      timestamp: this.now(),
    };
  }
  async reconcileMerge(
    id: string,
    frame: Frame,
    quantity: number,
  ): Promise<Settlement> {
    // Simulation has no external side effect; the persisted intent is sufficient
    // to recover a local merge not yet committed to the ledger.
    return this.merge(id, frame, quantity);
  }
}
