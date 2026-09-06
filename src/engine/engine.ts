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
  strategyBinding,
  quote,
  validateFrame,
  freshBook,
  footballPolicy,
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
      l.count(frame.football ? "evaluated:football-value" : "evaluated:yes-no");
      l.mark(frame);
      const a = l.account,
        c = l.config,
        m = l.metrics();
      const reject = (reason: string) => this.rejection(reason, frame);
      if (a.stop) return reject(a.stop);
      if (l.mode === "live" && !s.get<ReturnType<typeof strategyBinding>[]>("meta","live:strategies")?.some(b=>JSON.stringify(b) === JSON.stringify(strategyBinding(frame.football ? "football-value" : "yes-no",c)))) return reject("Estrategia live sin evidencia para esta configuración");
      if (!a.connected) return reject("Sin conexión de mercado");
      if (l.positions.some((p) => p.stale)) return reject("Valoración de posiciones obsoleta");
      if (
        s
          .all<Order>("orders")
          .some((o) => o.status === "uncertain" || o.status === "submitted")
      )
        return reject("Conciliación pendiente");
      if (frame.resolution) return reject("Mercado resuelto");
      if (!frame.binary || (frame.negRisk && !frame.football))
        return reject("Solo mercados binarios complementarios estándar");
      if (!frame.depth) return reject("Sin profundidad ejecutable");
      if (
        !frame.feeVerified ||
        (!frame.gasVerified && !(l.mode !== "live" && frame.paperGas))
      )
        return reject("Costes sin verificar");
      if (
        frame.timestamp > l.now() || l.now() - frame.timestamp > c.maxDataAgeMs ||
        [frame.yes, frame.no].some((b) => !freshBook(b, l.now(), c.maxDataAgeMs))
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
      if (frame.football) return this.reserveFootball(frame, budget);
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
      // Net return is piecewise linear between depth boundaries. Inspect these
      // boundaries as well as the maximum affordable size, not just the latter.
      const candidates = new Set([minimum, Math.floor(lo * 100) / 100]);
      for (const b of [frame.yes, frame.no]) {
        let depth = 0;
        for (const level of [...b.asks].sort((a, b) => a.price - b.price)) {
          depth += level.size;
          const size = Math.floor(Math.min(depth, lo) * 100) / 100;
          if (size >= minimum) candidates.add(size);
        }
      }
      let quantity = minimum, best = -Infinity;
      for (const size of candidates) {
        const pair = quotes(size);
        if (!pair) continue;
        const net = size - pair[0].gross - pair[1].gross - pair[0].fees - pair[1].fees - frame.mergeGasUsd;
        if (net > best) { best = net; quantity = size; }
      }
      const q = quotes(quantity);
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
      this.signal(frame, `${frame.yes.hash ?? frame.id}:${frame.no.hash ?? frame.id}`, `Arbitraje estimado neto US$${money(quantity - cost - frame.mergeGasUsd)}`);
      l.count("accepted");
      l.event(
        "reserved",
        `Reserva conjunta US$${money(cost + gasReserve)}`,
        frame.marketId,
        "yes-no",
      );
      return orders;
    });
  }
  private signal(frame: Frame, identity: string, message: string): void {
    const l = this.ledger, key = `opportunity:${frame.marketId}`;
    if (l.store.get<string>("meta", key) === identity) return;
    l.store.put("meta", key, identity);
    l.count("signals");
    l.event("signal", `${message} · ${frame.title}`, frame.marketId, frame.football ? "football-value" : "yes-no");
  }
  /** Runs inside reserve's transaction and shares all global checks and capital. */
  private reserveFootball(frame: Frame, globalBudget: number): Order[] | null {
    const l = this.ledger, s = l.store, m = l.metrics(), f = frame.football!, prediction = frame.forecast;
    const reject = (reason: string) => this.rejection(reason, frame);
    if (!prediction || l.now() - prediction.dataVerifiedAt > 7 * 86400000 || prediction.generatedAt < Date.parse(new Date(l.now()).toISOString().slice(0,10))) return reject("Fútbol: historial ausente, ambiguo, insuficiente o caducado");
    const until = f.startAt - l.now();
    if (until < 3600000 || until > 7 * 86400000) return reject("Fútbol: fuera de ventana previa de 1 hora a 7 días");
    const matchKey = `football:bet:${f.matchId}`;
    if (s.get("meta", matchKey)) return reject("Fútbol: partido ya reservado; no aumentar posición");
    if (l.positions.some((p) => p.marketId === frame.marketId) || s.all<Reservation>("reservations").some((r) => r.marketId === frame.marketId)) return reject("Condición ya expuesta");
    const footballExposure = l.positions.filter((p) => p.strategy === "football-value").reduce((n,p) => n+p.cost,0) + s.all<Reservation>("reservations").filter((r) => r.strategy === "football-value").reduce((n,r) => n+r.remaining,0);
    const budget = Math.max(0, Math.min(globalBudget, m.operationalCapital * footballPolicy.matchExposure * m.sizeFactor, (m.operationalCapital * footballPolicy.totalExposure - footballExposure) * m.sizeFactor));
    const gas = Math.max(frame.mergeGasUsd, frame.recoveryGasUsd);
    let best: {outcome: "YES" | "NO"; q: Quote; edge: number} | undefined;
    for (const outcome of ["YES","NO"] as const) {
      const book = outcome === "YES" ? frame.yes : frame.no;
      const probability = outcome === "YES" ? prediction.probability : 1 - prediction.probability;
      const limit = Math.min(...book.asks.map((x) => x.price)) * (1 + l.config.maxSlippageBps / 10000);
      const candidate = (quantity: number) => {
        const q = quote(book.asks, quantity, frame.feeRate, "BUY", limit);
        if (!q) return undefined;
        const cost = q.gross + q.fees + gas, price = cost / quantity;
        const edge = probability - price;
        const kelly = price < 1 ? Math.max(0, (probability - price) / (1 - price)) * footballPolicy.kelly : 0;
        if (edge < footballPolicy.minEdge || cost > Math.min(budget, m.operationalCapital * kelly * m.sizeFactor) + 1e-6 || q.fees + gas > l.config.maxCostUsd) return undefined;
        return {outcome, q, edge};
      };
      if (!candidate(book.minSize)) continue;
      let lo = book.minSize, hi = Math.min(book.asks.reduce((n,b) => n+b.size,0), budget / Math.max(limit,1e-6));
      for (let i=0; i<45; i++) { const mid=(lo+hi)/2; if (candidate(mid)) lo=mid; else hi=mid; }
      const possible = candidate(Math.floor(lo*100)/100);
      if (possible && (!best || possible.edge*possible.q.quantity > best.edge*best.q.quantity)) best = possible;
    }
    if (!best) return reject("Fútbol: ventaja neta <5 pp, mínimo, profundidad, Kelly o límites");
    const pairId = createHash("sha256").update(`${l.mode}:${matchKey}`).digest("hex").slice(0,32);
    const order: Order = {
      id: `${pairId}:BUY`, pairId, marketId: frame.marketId, eventId: f.matchId, underlying: f.matchId,
      tokenId: best.outcome === "YES" ? frame.yes.tokenId : frame.no.tokenId, outcome: best.outcome, side: "BUY", quantity: best.q.quantity, limit: best.q.limit, feeRate: frame.feeRate, status: "reserved", timestamp: l.now(), mode: l.mode,
      strategy: "football-value", football: f, forecast: prediction, takeProfit: footballPolicy.takeProfit, title: frame.title,
    };
    const remaining = money(best.q.gross + best.q.fees + gas);
    s.put("reservations", pairId, {id: pairId, eventId: f.matchId, underlying: f.matchId, marketId: frame.marketId, strategy: "football-value", remaining, timestamp: l.now()} satisfies Reservation);
    s.put("orders", order.id, order);
    s.put("meta", `signal:${pairId}`, frame);
    s.put("meta", matchKey, pairId);
    this.signal(frame, pairId, `${best.outcome}: ventaja estimada ${(best.edge*100).toFixed(2)} pp · modelo ${prediction.version}`);
    l.count("accepted");
    l.event("reserved", `Reserva fútbol US$${remaining} · ${best.outcome} · ${frame.title}`, frame.marketId, "football-value");
    return [order];
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
      if (original?.marketId === frame.marketId) {
        if (r.strategy === "football-value") await this.finishFootball(r.id, frame);
        else await this.finishPair(r.id, frame);
      }
    }
    const orders = this.reserve(frame);
    if (!orders) return;
    const first = await this.submit(orders[0]);
    if (orders[0].strategy === "football-value") {
      await this.finishFootball(orders[0].pairId, frame);
      this.recordEquity();
      return;
    }
    if (first.status === "filled") await this.submit(orders[1]);
    else if (first.status === "rejected") {
      orders[1].status = "cancelled";
      this.ledger.store.put("orders", orders[1].id, orders[1]);
    }
    await this.finishPair(orders[0].pairId, frame);
    this.recordEquity();
  }
  private async finishFootball(pairId: string, frame: Frame): Promise<void> {
    const l = this.ledger, s = l.store;
    if (s.all<Order>("orders").some((o) => o.pairId === pairId && !terminal(o))) return;
    const ps = l.positions.filter((p) => p.pairId === pairId && p.strategy === "football-value");
    if (!ps.length) { s.delete("reservations", pairId); return; }
    if (frame.resolution) {
      const id = `redeem:${pairId}`;
      if (!this.executor.redeem) { l.stop("Canje no disponible"); return; }
      const existing = s.get<Frame>("meta", id);
      const evidence = existing ?? frame;
      if (!existing) s.put("meta", id, frame);
      try {
        const quantity = ps.reduce((n,p) => n+p.quantity,0);
        const result = existing ? await this.executor.reconcileRedeem?.(id, evidence, quantity) : await this.executor.redeem(id, evidence, quantity);
        if (result?.status !== "confirmed") {
          if (result?.status === "rejected") s.transaction(() => l.gasExpense(id,result.gas));
          l.stop("Canje pendiente de conciliación"); return;
        }
        s.transaction(() => { l.settle(id, evidence, result.gas); s.delete("reservations",pairId); });
      } catch { l.stop("Canje incierto; conservar posición y reserva"); }
      return;
    }
    for (const p of ps) {
      const book = p.outcome === "YES" ? frame.yes : frame.no;
      if (!frame.feeVerified || !freshBook(book,l.now(),l.config.maxDataAgeMs)) continue;
      const q = quote(book.bids,p.quantity,frame.feeRate,"SELL");
      if (!q || q.gross-q.fees-frame.recoveryGasUsd < p.cost*(1+(p.takeProfit ?? footballPolicy.takeProfit))) continue;
      const suffix = createHash("sha256").update(`${book.hash ?? frame.id}:${p.quantity}`).digest("hex").slice(0,16);
      const order: Order = { id: `${pairId}:exit:${suffix}`, pairId, marketId:p.marketId, eventId:p.eventId, underlying:p.underlying, tokenId:p.tokenId, outcome:p.outcome, side:"SELL", quantity:p.quantity, limit:q.limit, feeRate:frame.feeRate, timestamp:l.now(), status:"reserved", mode:l.mode, strategy:"football-value", football:p.football, forecast:p.forecast, takeProfit:p.takeProfit, title:p.title };
      if (!s.transaction(() => s.insert("orders",order.id,order))) continue;
      const result = await this.submit(order);
      if (result.status === "uncertain") return;
      if (result.status === "filled" && l.positions.some((x) => x.tokenId === p.tokenId)) l.stop("Salida fútbol parcial: conciliar cantidad restante");
    }
    if (!l.positions.some((p) => p.pairId === pairId)) s.delete("reservations",pairId);
  }
  private async finishPair(pairId: string, frame: Frame): Promise<void> {
    const l = this.ledger,
      s = l.store;
    if (s.all<Order>("orders").some((o) => o.pairId === pairId && !terminal(o)))
      return;
    let ps = l.positions.filter((p) => p.marketId === frame.marketId && (p.strategy ?? "yes-no") === "yes-no");
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
    ps = l.positions.filter((p) => p.marketId === frame.marketId && (p.strategy ?? "yes-no") === "yes-no");
    for (const p of ps) {
      const book = p.outcome === "YES" ? frame.yes : frame.no;
      const exit = quote(book.bids, p.quantity, frame.feeRate, "SELL");
      const lossBudget =
        l.metrics().operationalCapital * l.config.unhedgedLossPct;
      if (
        !exit ||
        !freshBook(book, l.now(), l.config.maxDataAgeMs) ||
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
      if (f) {
        if (r.strategy === "football-value") await this.finishFootball(r.id, f);
        else await this.finishPair(r.id, f);
      }
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
        l.positions.some((p) => p.strategy !== "football-value" || p.stale || !p.pairId || !l.store.get("reservations", p.pairId) || !!l.store.get("meta", `redeem:${p.pairId}`)) ||
        l.store.all<Reservation>("reservations").some((r) => r.strategy !== "football-value" || !l.positions.some((p) => p.pairId === r.id)) ||
        m.available < 0 || m.exposure > m.operationalCapital * l.config.totalExposurePct ||
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
