import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import type { Ledger } from '../engine/ledger.js';
import { freshBook, money, quote, validateFrame, type Fill, type FootballMarket, type Frame, type Order, type Strategy } from '../engine/model.js';
import { teamKey } from '../strategies/football.js';

interface Attribution {
  strategy: string; league: string; cash: number; basis: number; mark: number;
  realized: number; unrealized: number; netPnl: number; fees: number; gas: number; fills: number;
}
interface SettlementRow { marketId: string; strategy?: Strategy; quantity?: number; payout?: number; gas: number }
interface Exposure {
  kind: 'league' | 'team' | 'matchday'; key: string; cost: number; reserved: number;
  exposure: number; capitalPct: number; matches: string[]; stalePositions: number;
}
export interface EntryMarkout {
  fillId: string; marketId: string; strategy: string; league: string; outcome: string;
  horizonMinutes: number; targetAt: number; entryPrice: number; entryFees: number; quantity: number;
  status: 'pending' | 'missing' | 'invalid' | 'illiquid' | 'observed'; invalidSamples: number;
  observedAt?: number; delayMs?: number; bookTime?: number; verifiedAt?: number; sourceSha256?: string;
  frameId?: string; exitPrice?: number; exitFees?: number; modeledGas?: number; hypotheticalNetPnl?: number;
}
const leagueOf = (strategy?: string, football?: FootballMarket) => football?.league ?? (strategy === 'football-value' ? 'desconocida' : 'no-aplica');

/** Read-only attribution: cash movements and current marks reconcile to the authoritative Ledger. */
export function accountAnalysis(ledger: Ledger, now = ledger.now()) {
  const orders = new Map(ledger.store.all<Order>('orders').map(o => [o.id, o]));
  const fills = ledger.store.all<Fill>('fills'), positions = ledger.positions, metrics = ledger.metrics(), account = ledger.account;
  const buckets = new Map<string, Attribution>();
  const bucket = (strategy = 'yes-no', league = 'no-aplica') => {
    const key = `${strategy}:${league}`;
    if (!buckets.has(key)) buckets.set(key, {strategy, league, cash: 0, basis: 0, mark: 0, realized: 0, unrealized: 0, netPnl: 0, fees: 0, gas: 0, fills: 0});
    return buckets.get(key)!;
  };
  for (const fill of fills) {
    const order = orders.get(fill.orderId);
    if (!order) throw new Error('Análisis: fill sin orden; revisar contabilidad');
    const row = bucket(order.strategy, leagueOf(order.strategy, order.football));
    row.cash += (order.side === 'BUY' ? -fill.gross : fill.gross) - fill.fees;
    row.fees += fill.fees; row.fills++;
  }
  for (const settlement of ledger.store.all<SettlementRow>('settlements')) {
    const order = [...orders.values()].find(o => o.marketId === settlement.marketId && o.strategy === (settlement.strategy ?? 'yes-no'));
    const row = bucket(settlement.strategy, leagueOf(settlement.strategy, order?.football));
    // Zero is a real losing payout, never a missing value to replace with quantity.
    row.cash += (settlement.payout ?? settlement.quantity ?? 0) - settlement.gas;
    row.gas += settlement.gas;
  }
  for (const p of positions) {
    const row = bucket(p.strategy, leagueOf(p.strategy, p.football));
    row.basis += p.cost; row.mark += p.mark;
  }
  for (const row of buckets.values()) {
    row.realized = money(row.cash + row.basis);
    row.unrealized = money(row.mark - row.basis);
    row.netPnl = money(row.cash + row.mark);
    row.fees = money(row.fees); row.gas = money(row.gas);
  }
  const attributed = [...buckets.values()];
  const remainder = money(metrics.netPnl - attributed.reduce((sum, row) => sum + row.netPnl, 0));
  const missingGas = money(account.gas - attributed.reduce((sum, row) => sum + row.gas, 0));
  const missingFees = money(account.fees - attributed.reduce((sum, row) => sum + row.fees, 0));
  if (remainder || missingGas || missingFees) {
    const row = bucket('sin-atribuir', 'sin-atribuir');
    row.cash = row.realized = row.netPnl = remainder; row.gas = missingGas; row.fees = missingFees;
  }
  const aggregate = (key: 'strategy' | 'league') => {
    const result = new Map<string, Omit<Attribution, 'strategy' | 'league'> & {name: string}>();
    for (const row of buckets.values()) {
      const name = row[key], prior = result.get(name) ?? {name, cash:0, basis:0, mark:0, realized:0, unrealized:0, netPnl:0, fees:0, gas:0, fills:0};
      for (const field of ['cash','basis','mark','realized','unrealized','netPnl','fees','gas','fills'] as const) prior[field] = money(prior[field] + row[field]);
      result.set(name, prior);
    }
    return [...result.values()];
  };
  const exposure = new Map<string, Exposure>();
  const addExposure = (football: FootballMarket | undefined, cost: number, reserved: number, stale: boolean) => {
    if (!football) return;
    // ponytail: league + UTC date proxies a matchday; use an official round ID when the verified feed supplies one.
    const keys = [['league', football.league], ['team', `${football.league}:${teamKey(football.home)}`], ['team', `${football.league}:${teamKey(football.away)}`], ['matchday', `${football.league}:${new Date(football.startAt).toISOString().slice(0,10)}`]] as const;
    for (const [kind, key] of keys) {
      const id = `${kind}:${key}`, row = exposure.get(id) ?? {kind, key, cost:0, reserved:0, exposure:0, capitalPct:0, matches:[], stalePositions:0};
      row.cost = money(row.cost + cost); row.reserved = money(row.reserved + reserved);
      row.exposure = money(row.cost + row.reserved); row.capitalPct = row.exposure / account.initialCapital * 100;
      if (!row.matches.includes(football.matchId)) row.matches.push(football.matchId);
      if (stale) row.stalePositions++;
      exposure.set(id, row);
    }
  };
  for (const p of positions) addExposure(p.football, p.cost, 0, !!p.stale);
  for (const reservation of ledger.store.all<import('../engine/model.js').Reservation>('reservations')) {
    const frame = ledger.store.get<Frame>('meta', `signal:${reservation.id}`);
    addExposure(frame?.football, 0, reservation.remaining, false);
  }
  return {generatedAt: now, initialCapital: account.initialCapital, cashBenchmark: money(account.deposits - account.withdrawals), excessOverCash: metrics.netPnl, byStrategy: aggregate('strategy'), byLeague: aggregate('league'), concentration: [...exposure.values()].sort((a,b) => b.exposure - a.exposure), unallocatedNetPnl: remainder, limitations: [
    'PnL acumulado de toda la cuenta; realizado más valoración de posiciones abiertas. No son retornos de capital asignado a cada grupo.',
    'Efectivo sin operar: mismos depósitos y retiros, sin intereses ni comisiones externas.',
    'Costes sin vínculo suficiente y redondeos se muestran en sin-atribuir; nunca se reparten por intuición.',
    'Concentración de fútbol: coste más reservas. Un partido cuenta para ambos equipos; las filas de equipos se solapan.',
    'Jornada aproximada por liga y fecha UTC de inicio; no equivale al número oficial de ronda, ausente del feed verificado.',
  ]};
}

/** Hypothetical full liquidation at the first verifiable sample in a fixed window, never a fill or booked profit. */
export function entryQuality(ledger: Ledger, now = ledger.now()): {horizons: number[]; maxDelayMs: number; rows: EntryMarkout[]} {
  const horizons = [1,5,30], maxDelayMs = 30000;
  const orders = new Map(ledger.store.all<Order>('orders').map(o => [o.id,o]));
  const rows: EntryMarkout[] = [];
  const query = ledger.store.db.prepare('SELECT data FROM recorded_books WHERE timestamp >= ? AND timestamp <= ? AND market = ? ORDER BY timestamp, rowid');
  for (const fill of ledger.store.all<Fill>('fills')) {
    const order = orders.get(fill.orderId);
    if (!order) throw new Error('Calidad de entrada: fill sin orden');
    if (order.side !== 'BUY') continue;
    for (const horizonMinutes of horizons) {
      const targetAt = fill.timestamp + horizonMinutes * 60000;
      const row: EntryMarkout = {fillId:fill.id, marketId:order.marketId, strategy:order.strategy, league:leagueOf(order.strategy,order.football), outcome:order.outcome, horizonMinutes, targetAt, entryPrice:fill.gross/fill.quantity, entryFees:fill.fees, quantity:fill.quantity, status:now < targetAt + maxDelayMs ? 'pending' : 'missing', invalidSamples:0};
      for (const record of query.all(targetAt, Math.min(now,targetAt + maxDelayMs), order.marketId) as {data:Uint8Array}[]) {
        let frame: Frame;
        try { frame = validateFrame(JSON.parse(gunzipSync(record.data, {maxOutputLength: 8*1024*1024}).toString())); }
        catch { row.invalidSamples++; continue; }
        const book = order.outcome === 'YES' ? frame.yes : frame.no;
        const gasFresh = frame.gasVerified || (frame.paperGas && frame.timestamp >= frame.paperGas.timestamp && frame.timestamp - frame.paperGas.timestamp < 60000);
        if (frame.marketId !== order.marketId || book.tokenId !== order.tokenId || frame.timestamp < targetAt || frame.timestamp > now || frame.timestamp > targetAt + maxDelayMs || !frame.feeVerified || !gasFresh || !freshBook(book, frame.timestamp, ledger.config.maxDataAgeMs)) { row.invalidSamples++; continue; }
        Object.assign(row, {observedAt:frame.timestamp, delayMs:frame.timestamp-targetAt, bookTime:book.timestamp, verifiedAt:book.verifiedAt, frameId:frame.id, sourceSha256:createHash('sha256').update(record.data).digest('hex')});
        const exit = quote(book.bids, fill.quantity, frame.feeRate, 'SELL');
        if (!exit || fill.quantity < book.minSize) { row.status = 'illiquid'; break; }
        Object.assign(row, {status:'observed', exitPrice:exit.gross/fill.quantity, exitFees:exit.fees, modeledGas:frame.recoveryGasUsd, hypotheticalNetPnl:money(exit.gross-exit.fees-frame.recoveryGasUsd-fill.gross-fill.fees)});
        break;
      }
      if (row.status === 'missing' && row.invalidSamples) row.status = 'invalid';
      rows.push(row);
    }
  }
  return {horizons, maxDelayMs, rows};
}

export type PaperAnalysis = ReturnType<typeof accountAnalysis> & {entryQuality: ReturnType<typeof entryQuality>};
