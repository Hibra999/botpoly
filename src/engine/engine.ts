import { createHash } from "node:crypto";
import { Ledger } from "./ledger.js";
import {
  type Execution,
  type Executor,
  type Frame,
  type Order,
  type Quote,
  type Reservation,
  money,
  quote,
  validateFrame,
} from "./model.js";

const terminal = (o: Order) =>
  ["filled", "rejected", "cancelled"].includes(o.status);
export class Engine {
  private queue: Promise<void> = Promise.resolve();
  private rejections = new Map<string, number>();
  constructor(
    readonly ledger: Ledger,
    readonly executor: Executor,
  ) {
    if (executor.mode !== ledger.mode)
      throw new Error("Ejecutor incompatible con el modo");
  }
  health(connected: boolean): void {
    this.ledger.store.transaction(() => {
      const a = this.ledger.account;
      a.connected = connected;
      if (!connected) a.errors++;
      else a.errors = 0;
      this.ledger.save(a);
      if (!connected && a.errors >= this.ledger.config.maxErrors)
        this.ledger.stop("Errores de conexión repetidos");
      this.ledger.mark();
    });
  }
  private rejection(reason: string, frame: Frame): null {
    this.ledger.count("rejected:" + reason);
    const key = `${frame.marketId}:${reason}`;
    // ponytail: retain one detailed rejection/minute/market; exact totals remain in daily counters.
    if (this.ledger.now() - (this.rejections.get(key) ?? -Infinity) >= 60000) {
      this.ledger.event("rejected", reason, frame.marketId);
      if (this.rejections.size >= 2000) this.rejections.clear();
      this.rejections.set(key, this.ledger.now());
    }
    return null;
  }
  reserve(frame: Frame): Order[] | null {
    validateFrame(frame);
    const l = this.ledger,
      s = l.store;
    return s.transaction(() => {
      l.count("evaluated");
      l.mark(frame);
      const a = l.account,
        c = l.config,
        m = l.metrics();
      const reject = (reason: string) => this.rejection(reason, frame);
      if (a.stop) return reject(a.stop);
      if (!a.connected) return reject("Sin conexión de mercado");
      if (
        s
          .all<Order>("orders")
          .some((o) => o.status === "uncertain" || o.status === "submitted")
      )
        return reject("Conciliación pendiente");
      if (!frame.binary || frame.negRisk)
        return reject("Solo mercados binarios complementarios estándar");
      if (!frame.depth) return reject("Sin profundidad ejecutable");
      if (
        !frame.feeVerified ||
        (!frame.gasVerified && !(l.mode !== "live" && frame.paperGas))
      )
        return reject("Costes sin verificar");
      if (
        [frame.timestamp, frame.yes.timestamp, frame.no.timestamp].some(
          (t) => l.now() < t || l.now() - t > c.maxDataAgeMs,
        )
      )
        return reject("Datos obsoletos o futuros");
      if (m.available < -1e-6 || !Number.isFinite(m.equity)) {
        l.stop("Saldo inconsistente");
        return reject("Saldo inconsistente");
      }
      const pairId = createHash("sha256")
        .update(`${l.mode}:${frame.id}`)
        .digest("hex")
        .slice(0, 32);
      if (s.get("meta", `signal:${pairId}`))
        return reject("Señal ya procesada");
      const allReservations = s.all<Reservation>("reservations");
      const concentration = Math.max(
        ...[frame.eventId, frame.underlying].map(
          (key, index) =>
            l.positions
              .filter((p) => (index ? p.underlying : p.eventId) === key)
              .reduce((n, p) => n + p.cost, 0) +
            allReservations
              .filter((r) => (index ? r.underlying : r.eventId) === key)
              .reduce((n, r) => n + r.remaining, 0),
        ),
      );
      const budget =
        Math.max(
          0,
          Math.min(
            m.available,
            m.operationalCapital * c.totalExposurePct - m.exposure,
            m.operationalCapital * c.eventExposurePct - concentration,
          ),
        ) * m.sizeFactor;
      const legBudget = m.operationalCapital * c.unhedgedLossPct * m.sizeFactor;
      const minimum = Math.max(frame.yes.minSize, frame.no.minSize);
      const gasReserve = Math.max(frame.mergeGasUsd, frame.recoveryGasUsd);
      const maxPrices = [frame.yes, frame.no].map(
        (b) =>
          Math.min(...b.asks.map((x) => x.price)) *
          (1 + c.maxSlippageBps / 10000),
      );
      const quotes = (q: number): [Quote, Quote] | null => {
        const yes = quote(
          frame.yes.asks,
          q,
          frame.feeRate,
          "BUY",
          maxPrices[0],
        );
        const no = quote(frame.no.asks, q, frame.feeRate, "BUY", maxPrices[1]);
        if (
          !yes ||
          !no ||
          yes.gross + no.gross + yes.fees + no.fees + gasReserve >
            budget + 1e-6 ||
          Math.max(yes.gross + yes.fees, no.gross + no.fees) +
            frame.recoveryGasUsd >
            legBudget + 1e-6 ||
          yes.fees + no.fees + gasReserve > c.maxCostUsd
        )
          return null;
        return [yes, no];
      };
      if (!quotes(minimum))
        return reject("Mínimo del mercado excede saldo, profundidad o límites");
      let lo = minimum,
        hi = Math.min(
          ...[frame.yes, frame.no].map((b) =>
            b.asks.reduce((n, x) => n + x.size, 0),
          ),
        );
      for (let i = 0; i < 45; i++) {
        const mid = (lo + hi) / 2;
        if (quotes(mid)) lo = mid;
        else hi = mid;
      }
      const quantity = Math.floor(lo * 100) / 100,
        q = quotes(quantity);
      if (!q || quantity < minimum) return reject("Tamaño inferior al mínimo");
      const cost = money(q[0].gross + q[1].gross + q[0].fees + q[1].fees);
      if (quantity - cost - frame.mergeGasUsd < c.minNetProfitUsd)
        return reject("Ventaja neta insuficiente después de costes");
      const orders: Order[] = (["YES", "NO"] as const).map((outcome, i) => ({
        id: `${pairId}:${outcome}`,
        pairId,
        marketId: frame.marketId,
        eventId: frame.eventId,
        underlying: frame.underlying,
        tokenId: i ? frame.no.tokenId : frame.yes.tokenId,
        outcome,
        side: "BUY",
        quantity,
        limit: q[i].limit,
        feeRate: frame.feeRate,
        status: "reserved",
        timestamp: l.now(),
        mode: l.mode,
        strategy: "yes-no",
      }));
      s.put("reservations", pairId, {
        id: pairId,
        eventId: frame.eventId,
        underlying: frame.underlying,
        remaining: money(cost + gasReserve),
        timestamp: l.now(),
      } satisfies Reservation);
      s.put("meta", `signal:${pairId}`, frame);
      orders.forEach((o) => s.put("orders", o.id, o));
      l.event(
        "reserved",
        `Reserva conjunta US$${money(cost + gasReserve)}`,
        frame.marketId,
      );
      return orders;
    });
    l.count("accepted");
  }
  private apply(order: Order, result: Execution): Order {
    const l = this.ledger;
    return l.store.transaction(() => {
      const current = l.store.get<Order>("orders", order.id)!;
      // Duplicate confirmations are harmless, but conflicting data fails closed.
      for (const fill of result.fills) l.fill(current, fill);
      current.externalId = result.externalId ?? current.externalId;
      current.status =
        result.status === "confirmed"
          ? "filled"
          : result.status === "uncertain"
            ? "uncertain"
            : "rejected";
      if (result.status === "confirmed" && result.fills.length === 0)
        current.status = "uncertain";
      l.store.put("orders", current.id, current);
      if (current.status === "uncertain")
        l.stop("Orden incierta: conciliación obligatoria");
      if (current.status === "rejected")
        l.event(
          "execution_failed",
          "Orden rechazada o inexistente tras conciliación",
          order.marketId,
        );
      return current;
    });
  }
  private async submit(order: Order): Promise<Order> {
    const l = this.ledger;
    l.store.transaction(() => {
      const existing = l.store.get<Order>("orders", order.id)!;
      if (existing.status !== "reserved") throw new Error("Orden ya enviada");
      existing.status = "submitted";
      l.store.put("orders", order.id, existing);
    });
    let result: Execution;
    try {
      result = await this.executor.execute(order);
    } catch {
      result = { status: "uncertain", fills: [] };
    }
    if (result.status === "uncertain") {
      try {
        result = await this.executor.reconcile({
          ...order,
          externalId: result.externalId,
        });
      } catch {
        /* Preserve uncertainty; never resend. */
      }
    }
    try {
      return this.apply(order, result);
    } catch {
      l.stop("Confirmación o saldo inconsistente");
      const uncertain = { ...order, status: "uncertain" as const };
      l.store.put("orders", order.id, uncertain);
      return uncertain;
    }
  }
  process(frame: Frame): Promise<void> {
    const next = this.queue.then(() => this.processFrame(frame));
    this.queue = next.catch(() => {});
    return next;
  }
  async drain(): Promise<void> {
    await this.queue;
  }
  private async processFrame(frame: Frame): Promise<void> {
    validateFrame(frame);
    // Fresh market data can reduce risk even while new entries are paused.
    for (const r of this.ledger.store.all<Reservation>("reservations")) {
      const original = this.ledger.store.get<Frame>("meta", `signal:${r.id}`);
      if (original?.marketId === frame.marketId)
        await this.finishPair(r.id, frame);
    }
    const orders = this.reserve(frame);
    if (!orders) return;
    const first = await this.submit(orders[0]);
    if (first.status === "filled") await this.submit(orders[1]);
    else if (first.status === "rejected") {
      orders[1].status = "cancelled";
      this.ledger.store.put("orders", orders[1].id, orders[1]);
    }
    await this.finishPair(orders[0].pairId, frame);
    this.recordEquity();
  }
  private async finishPair(pairId: string, frame: Frame): Promise<void> {
    const l = this.ledger,
      s = l.store;
    if (s.all<Order>("orders").some((o) => o.pairId === pairId && !terminal(o)))
      return;
    let ps = l.positions.filter((p) => p.marketId === frame.marketId);
    const paired = Math.min(
      ps.find((p) => p.outcome === "YES")?.quantity ?? 0,
      ps.find((p) => p.outcome === "NO")?.quantity ?? 0,
    );
    if (paired > 0) {
      const id = `merge:${pairId}`;
      // Persist intent BEFORE an external side effect. An unresolved intent is
      // never automatically submitted a second time after a crash.
      if (s.get("meta", id) && !s.get("settlements", id)) {
        try {
          const result = await this.executor.reconcileMerge?.(
            id,
            frame,
            paired,
          );
          if (result?.status === "rejected")
            s.transaction(() => l.gasExpense(id, result.gas));
          if (result?.status !== "confirmed") {
            l.stop("Fusión pendiente de conciliación");
            return;
          }
          s.transaction(() => l.merge(id, frame, paired, result.gas));
        } catch {
          l.stop("Fusión pendiente de conciliación");
          return;
        }
      }
      if (!s.get("settlements", id)) {
        s.put("meta", id, { frame, quantity: paired });
        try {
          const result = await this.executor.merge(id, frame, paired);
          if (result.status === "rejected")
            s.transaction(() => l.gasExpense(id, result.gas));
          if (result.status !== "confirmed") {
            l.stop("Fusión no confirmada");
            return;
          }
          s.transaction(() => l.merge(id, frame, paired, result.gas));
        } catch {
          l.stop("Fusión incierta: revisar antes de reintentar");
          return;
        }
      }
    }
    ps = l.positions.filter((p) => p.marketId === frame.marketId);
    for (const p of ps) {
      const book = p.outcome === "YES" ? frame.yes : frame.no;
      const exit = quote(book.bids, p.quantity, frame.feeRate, "SELL");
      const lossBudget =
        l.metrics().operationalCapital * l.config.unhedgedLossPct;
      if (
        !exit ||
        l.now() - book.timestamp > l.config.maxDataAgeMs ||
        p.cost - exit.gross + exit.fees + frame.recoveryGasUsd > lossBudget
      ) {
        l.stop("Pata sin cobertura: salida fuera del presupuesto");
        return;
      }
      const order: Order = {
        id: `${pairId}:exit:${p.outcome}:${createHash("sha256").update(frame.id).digest("hex").slice(0, 12)}`,
        pairId,
        marketId: p.marketId,
        eventId: p.eventId,
        underlying: p.underlying,
        tokenId: p.tokenId,
        outcome: p.outcome,
        side: "SELL",
        quantity: p.quantity,
        limit: exit.limit,
        feeRate: frame.feeRate,
        timestamp: l.now(),
        status: "reserved",
        mode: l.mode,
        strategy: "yes-no",
      };
      if (!s.insert("orders", order.id, order)) {
        l.stop("Recuperación ya intentada; requiere revisión");
        return;
      }
      if (
        (await this.submit(order)).status !== "filled" ||
        l.positions.some((x) => x.tokenId === p.tokenId)
      ) {
        l.stop("Salida incompleta de pata sin cobertura");
        return;
      }
      l.event(
        "recovery",
        "Pata fallida: salida confirmada dentro del presupuesto",
        p.marketId,
      );
    }
    s.transaction(() => {
      s.delete("reservations", pairId);
      l.mark(frame);
    });
  }
  /** Startup/reconnection: resolve pending orders first, then repair exposure. */
  async reconcile(): Promise<void> {
    const l = this.ledger,
      orders = l.store.all<Order>("orders");
    for (const o of orders.filter((o) => !terminal(o))) {
      if (o.status === "reserved") {
        o.status = "cancelled";
        l.store.put("orders", o.id, o);
        continue;
      }
      try {
        this.apply(o, await this.executor.reconcile(o));
      } catch {
        l.stop("Conciliación no disponible");
        return;
      }
    }
    for (const r of l.store.all<Reservation>("reservations")) {
      const f = l.store.get<Frame>("meta", `signal:${r.id}`);
      if (f) await this.finishPair(r.id, f);
    }
    l.mark();
  }
  async cancelOrders(): Promise<void> {
    const l = this.ledger;
    for (const o of l.store.all<Order>("orders").filter((o) => !terminal(o))) {
      if (o.status === "reserved") {
        o.status = "cancelled";
        l.store.put("orders", o.id, o);
      } else {
        try {
          this.apply(o, await this.executor.cancel(o));
        } catch {
          l.stop("Cancelación incierta");
        }
      }
    }
    await this.reconcile();
    l.event("control", "Cancelación y conciliación finalizadas");
  }
  resume(): void {
    const l = this.ledger;
    l.store.transaction(() => {
      l.mark();
      const a = l.account,
        m = l.metrics();
      if (
        !a.connected ||
        l.now() - a.lastDataAt > l.config.maxDataAgeMs ||
        a.errors ||
        m.drawdown >= l.config.maxDrawdownPct ||
        m.dailyPnl <= -a.initialCapital * l.config.dailyLossPct ||
        l.positions.length ||
        l.store.all<Reservation>("reservations").length ||
        l.store.all<Order>("orders").some((o) => !terminal(o))
      )
        throw new Error(
          "Reanudación denegada: revisar conexión, exposición, conciliación y pérdidas",
        );
      a.stop = null;
      l.save(a);
      l.event("control", "Reanudación autorizada");
    });
  }
  recordEquity(): void {
    const m = this.ledger.metrics(),
      timestamp = this.ledger.now();
    this.ledger.store.put("equity", String(timestamp), {
      timestamp,
      ...m,
      fees: this.ledger.account.fees,
      gas: this.ledger.account.gas,
    });
  }
}
