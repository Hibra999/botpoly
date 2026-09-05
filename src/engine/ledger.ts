import { randomUUID } from "node:crypto";
import {
  type Account,
  type AuditEvent,
  type Fill,
  type Frame,
  type Metrics,
  type Mode,
  type Order,
  type Position,
  type Reservation,
  type RiskConfig,
  money,
  quote,
} from "./model.js";
import { Store } from "./store.js";

export class Ledger {
  constructor(
    readonly store: Store,
    readonly mode: Mode,
    config: RiskConfig,
    readonly now: () => number = Date.now,
  ) {
    store.transaction(() => {
      const storedMode = store.get<Mode>("meta", "mode");
      if (storedMode && storedMode !== mode)
        throw new Error("Cada modo necesita una base de datos separada");
      store.put("meta", "mode", mode);
      if (!store.get("meta", "config")) store.put("meta", "config", config);
      if (!store.get("meta", "account"))
        store.put("meta", "account", {
          initialCapital: config.capitalUsd,
          cash: config.capitalUsd,
          realized: 0,
          fees: 0,
          gas: 0,
          deposits: config.capitalUsd,
          withdrawals: 0,
          peakPnl: 0,
          day: new Date(now()).toISOString().slice(0, 10),
          dayStartPnl: 0,
          stop: null,
          errors: 0,
          connected: false,
          lastDataAt: 0,
        } satisfies Account);
    });
  }
  get config(): RiskConfig {
    return this.store.get<RiskConfig>("meta", "config")!;
  }
  get account(): Account {
    return this.store.get<Account>("meta", "account")!;
  }
  save(a: Account): void {
    this.store.put("meta", "account", a);
  }
  cashflow(id: string, amount: number, kind: "deposit" | "withdrawal"): void {
    this.store.transaction(() => {
      if (!id || !Number.isFinite(amount) || amount <= 0)
        throw new Error("Movimiento de capital inválido");
      if (this.store.get("meta", `cashflow:${id}`)) return;
      if (kind === "withdrawal" && amount > this.metrics().available)
        throw new Error("Retirada excede saldo disponible");
      const a = this.account;
      a.cash = money(a.cash + (kind === "deposit" ? amount : -amount));
      if (kind === "deposit") a.deposits = money(a.deposits + amount);
      else a.withdrawals = money(a.withdrawals + amount);
      this.save(a);
      this.store.put("meta", `cashflow:${id}`, {
        kind,
        amount,
        timestamp: this.now(),
      });
      this.event(
        "cashflow",
        `${kind === "deposit" ? "Depósito" : "Retirada"} contabilizado: US$${amount}`,
      );
    });
  }
  gasExpense(id: string, amount: number): void {
    if (!Number.isFinite(amount) || amount < 0)
      throw new Error("Coste de gas inválido");
    if (this.store.get("meta", `gas:${id}`)) return;
    const a = this.account;
    a.cash = money(a.cash - amount);
    a.realized = money(a.realized - amount);
    a.gas = money(a.gas + amount);
    this.save(a);
    this.store.put("meta", `gas:${id}`, { amount, timestamp: this.now() });
    this.event("cost", `Gas de transacción fallida confirmado: US$${amount}`);
  }
  get positions(): Position[] {
    return this.store
      .all<Position>("positions")
      .filter((p) => p.quantity > 1e-7);
  }
  metrics(): Metrics {
    const a = this.account,
      cfg = this.config,
      positions = this.positions;
    const reserved = money(
      this.store
        .all<Reservation>("reservations")
        .reduce((s, r) => s + r.remaining, 0),
    );
    const exposure = money(
      positions.reduce((s, p) => s + p.cost, 0) + reserved,
    );
    const unrealized = money(
      positions.reduce((s, p) => s + p.mark - p.cost, 0),
    );
    const equity = money(a.cash + positions.reduce((s, p) => s + p.mark, 0));
    const netPnl = money(equity - a.deposits + a.withdrawals);
    // Budget edits and cash flows never rewrite the historical loss denominator.
    const drawdown = Math.max(
      0,
      (a.peakPnl - netPnl) / Math.max(a.initialCapital + a.peakPnl, 1e-6),
    );
    return {
      equity,
      available: money(a.cash - reserved),
      reserved,
      exposure,
      unrealized,
      netPnl,
      drawdown,
      dailyPnl: money(netPnl - a.dayStartPnl),
      operationalCapital: Math.max(0, Math.min(cfg.capitalUsd, equity)),
      sizeFactor: Math.max(0, 1 - drawdown / Math.min(0.1, cfg.maxDrawdownPct)),
    };
  }
  event(type: string, message: string, marketId?: string): void {
    const id = randomUUID();
    this.store.put("events", id, {
      id,
      timestamp: this.now(),
      type,
      message,
      mode: this.mode,
      strategy: "yes-no",
      marketId,
    } satisfies AuditEvent);
  }
  stop(reason: string): void {
    const a = this.account;
    if (!a.stop) {
      a.stop = reason;
      this.save(a);
      this.event("stop", reason);
    }
  }
  rollDay(): void {
    const a = this.account,
      day = new Date(this.now()).toISOString().slice(0, 10);
    if (day !== a.day) {
      a.day = day;
      a.dayStartPnl = this.metrics().netPnl;
      this.save(a);
    }
  }
  mark(frame?: Frame): void {
    this.rollDay();
    for (const p of this.positions) {
      if (frame && p.marketId === frame.marketId) {
        const b = p.outcome === "YES" ? frame.yes : frame.no;
        const exit = quote(b.bids, p.quantity, frame.feeRate, "SELL");
        // No executable depth means no assumed salvage value.
        p.mark = exit ? money(exit.gross - exit.fees) : 0;
        p.timestamp = b.timestamp;
      }
      if (this.now() - p.timestamp > this.config.maxDataAgeMs) p.mark = 0;
      this.store.put("positions", p.tokenId, p);
    }
    const a = this.account;
    a.peakPnl = Math.max(a.peakPnl, this.metrics().netPnl);
    this.save(a);
    const m = this.metrics();
    if (m.dailyPnl <= -a.initialCapital * this.config.dailyLossPct)
      this.stop("Límite de pérdida diaria");
    if (m.drawdown >= this.config.maxDrawdownPct)
      this.stop("Límite de drawdown");
  }
  /** Called inside the same transaction that updates order state. */
  fill(order: Order, fill: Fill): void {
    if (
      fill.orderId !== order.id ||
      !fill.id ||
      ![fill.quantity, fill.gross, fill.fees, fill.timestamp].every(
        Number.isFinite,
      ) ||
      fill.quantity <= 0 ||
      fill.gross <= 0 ||
      fill.fees < 0
    )
      throw new Error("Ejecución inválida");
    const existing = this.store.get<Fill>("fills", fill.id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(fill))
        throw new Error("Identificador de ejecución con datos contradictorios");
      return;
    }
    const prior = this.store
      .all<Fill>("fills")
      .filter((f) => f.orderId === order.id)
      .reduce((n, f) => n + f.quantity, 0);
    if (prior + fill.quantity > order.quantity + 1e-6)
      throw new Error("Ejecución excede la orden");
    const price = fill.gross / fill.quantity;
    if (
      (order.side === "BUY" && price > order.limit + 1e-6) ||
      (order.side === "SELL" && price < order.limit - 1e-6)
    )
      throw new Error("Ejecución fuera del límite");
    const a = this.account;
    const p = this.store.get<Position>("positions", order.tokenId) ?? {
      tokenId: order.tokenId,
      marketId: order.marketId,
      eventId: order.eventId,
      underlying: order.underlying,
      outcome: order.outcome,
      quantity: 0,
      cost: 0,
      mark: 0,
      timestamp: fill.timestamp,
    };
    if (order.side === "BUY") {
      const cost = money(fill.gross + fill.fees);
      if (cost > a.cash + 1e-6) throw new Error("Saldo inconsistente");
      a.cash = money(a.cash - cost);
      p.cost = money(p.cost + cost);
      p.quantity = money(p.quantity + fill.quantity);
      const r = this.store.get<Reservation>("reservations", order.pairId);
      if (!r || cost > r.remaining + 1e-6)
        throw new Error("Ejecución sin reserva suficiente");
      r.remaining = money(r.remaining - cost);
      this.store.put("reservations", r.id, r);
    } else {
      if (fill.quantity > p.quantity + 1e-6)
        throw new Error("Venta excede posición");
      const basis = (p.cost * fill.quantity) / p.quantity;
      a.cash = money(a.cash + fill.gross - fill.fees);
      a.realized = money(a.realized + fill.gross - fill.fees - basis);
      p.cost = money(p.cost - basis);
      p.mark = money(p.mark * (1 - fill.quantity / p.quantity));
      p.quantity = money(p.quantity - fill.quantity);
    }
    a.fees = money(a.fees + fill.fees);
    p.timestamp = fill.timestamp;
    this.store.put("positions", p.tokenId, p);
    this.store.insert("fills", fill.id, fill);
    this.save(a);
    this.event(
      "fill",
      `${order.side} ${fill.quantity} ${order.outcome} · US$${fill.gross.toFixed(4)}`,
      order.marketId,
    );
  }
  merge(id: string, frame: Frame, quantity: number, gas: number): void {
    if (this.store.get("settlements", id)) return;
    if (
      !Number.isFinite(gas) ||
      gas < 0 ||
      !Number.isFinite(quantity) ||
      quantity <= 0
    )
      throw new Error("Fusión inválida");
    const a = this.account;
    let basis = 0;
    for (const token of [frame.yes.tokenId, frame.no.tokenId]) {
      const p = this.store.get<Position>("positions", token);
      if (!p || p.quantity + 1e-6 < quantity)
        throw new Error("Fusión sin posiciones complementarias");
      const fraction = quantity / p.quantity;
      basis += p.cost * fraction;
      p.cost = money(p.cost * (1 - fraction));
      p.mark = money(p.mark * (1 - fraction));
      p.quantity = money(p.quantity - quantity);
      this.store.put("positions", token, p);
    }
    a.cash = money(a.cash + quantity - gas);
    a.realized = money(a.realized + quantity - basis - gas);
    a.gas = money(a.gas + gas);
    this.save(a);
    this.store.insert("settlements", id, {
      id,
      marketId: frame.marketId,
      quantity,
      gas,
      timestamp: this.now(),
    });
    this.event(
      "merge",
      `Fusión confirmada: ${quantity} pares · gas US$${gas.toFixed(4)}`,
      frame.marketId,
    );
  }
  snapshot() {
    return {
      mode: this.mode,
      strategy: "yes-no",
      config: this.config,
      account: this.account,
      metrics: this.metrics(),
      positions: this.positions,
      orders: this.store.recent<Order>("orders", 500),
      events: this.store.recent<AuditEvent>("events", 200),
      equity: this.store
        .recent<{
          timestamp: number;
          equity: number;
          drawdown: number;
        }>("equity", 1000)
        .reverse(),
      reports: this.store
        .all<{
          id: string;
          timestamp: number;
          label: string;
          netPnl: number;
          status: string;
        }>("reports")
        .reverse(),
      experimental: ["Copy trading", "DipArb", "Seguimiento de tendencia"],
    };
  }
}
