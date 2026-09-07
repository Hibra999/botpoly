import {createHash} from "node:crypto";
import {sizingPolicy, type SizingEvidence} from "./sizing.js";
export type Mode = "paper" | "backtest" | "live";
export type Outcome = "YES" | "NO";
export type Strategy = "yes-no" | "football-value";
export const footballPolicy = Object.freeze({ version: "poisson-clubs-v1", selection: "best-net-executable-v1", minEdge: 0.05, kelly: 0.25, matchExposure: 0.01, totalExposure: 0.10, takeProfit: 0.10, minMatches: 10, shrinkMatches: 5, historyDays: 730 });
export interface FootballMarket {
  matchId: string;
  league: string;
  home: string;
  away: string;
  startAt: number;
  result: "home" | "draw" | "away";
}
export interface Forecast {
  probability: number;
  version: string;
  checksum: string;
  generatedAt: number;
  dataVerifiedAt: number;
  sampleSize: number;
}
export interface Level {
  price: number;
  size: number;
}
export interface Book {
  tokenId: string;
  hash?: string;
  timestamp: number;
  /** Time of a complete, validated REST snapshot. Does not replace source time. */
  verifiedAt?: number;
  receivedAt?: number;
  bids: Level[];
  asks: Level[];
  minSize: number;
  tickSize: number;
}
export interface Frame {
  id: string;
  timestamp: number;
  marketId: string;
  eventId: string;
  underlying: string;
  title: string;
  yes: Book;
  no: Book;
  binary: boolean;
  negRisk: boolean;
  feeRate: number;
  feeVerified: boolean;
  mergeGasUsd: number;
  recoveryGasUsd: number;
  gasVerified: boolean;
  paperGas?: {
    units: number;
    gwei: number;
    polUsd: number;
    multiplier: number;
    timestamp: number;
    source: string;
  };
  source: string;
  depth: boolean;
  football?: FootballMarket;
  forecast?: Forecast;
  resolution?: Resolution;
  secondsDelay?: number;
  sizing?: SizingEvidence;
  connectionGeneration?: number;
}
export interface Resolution {
  payouts: [number, number];
  verifiedAt: number;
  source: string;
  evidence: string;
}
export function validateResolution(r: Resolution, now: number): void {
  if (!Array.isArray(r.payouts) || r.payouts.length !== 2 || !r.payouts.every((p) => Number.isFinite(p) && p >= 0 && p <= 1) || Math.abs(r.payouts[0] + r.payouts[1] - 1) > 1e-9 || !Number.isFinite(r.verifiedAt) || r.verifiedAt > now || !r.source || !r.evidence)
    throw new Error("Resolución o vector de pagos inválido");
}
export interface RiskConfig {
  capitalUsd: number;
  dailyLossPct: number;
  maxDrawdownPct: number;
  eventExposurePct: number;
  totalExposurePct: number;
  unhedgedLossPct: number;
  minNetProfitUsd: number;
  maxSlippageBps: number;
  maxDataAgeMs: number;
  maxErrors: number;
  maxCostUsd: number;
  max_oper_per_hour: number;
}
export const defaults: RiskConfig = {
  capitalUsd: 1000,
  dailyLossPct: 0.02,
  maxDrawdownPct: 0.1,
  eventExposurePct: 0.1,
  totalExposurePct: 0.3,
  unhedgedLossPct: 0.01,
  minNetProfitUsd: 0.02,
  maxSlippageBps: 50,
  maxDataAgeMs: 5000,
  maxErrors: 3,
  maxCostUsd: 1,
  max_oper_per_hour: 15,
};
export function validateConfig(input: unknown): RiskConfig {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Configuración inválida");
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some(
      (k) => !Object.prototype.hasOwnProperty.call(defaults, k),
    )
  )
    throw new Error("Parámetro desconocido");
  const cfg = { ...defaults, ...value } as RiskConfig;
  for (const [key, n] of Object.entries(cfg))
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0)
      throw new Error(`Valor inválido: ${key}`);
  if (cfg.capitalUsd < 50 || cfg.capitalUsd > 1e9)
    throw new Error("Capital entre US$50 y US$1.000.000.000");
  for (const key of [
    "dailyLossPct",
    "maxDrawdownPct",
    "eventExposurePct",
    "totalExposurePct",
    "unhedgedLossPct",
  ] as const)
    if (cfg[key] <= 0 || cfg[key] > 1)
      throw new Error(`Límite inválido: ${key}`);
  if (
    cfg.eventExposurePct > cfg.totalExposurePct ||
    cfg.unhedgedLossPct > cfg.eventExposurePct
  )
    throw new Error("Concentración incompatible con exposición");
  if (
    cfg.maxSlippageBps > 1000 ||
    cfg.maxDataAgeMs < 100 ||
    cfg.maxDataAgeMs > 60000 ||
    !Number.isSafeInteger(cfg.maxErrors) ||
    !Number.isSafeInteger(cfg.max_oper_per_hour) || cfg.max_oper_per_hour < 1 ||
    cfg.maxErrors < 1 ||
    cfg.maxCostUsd <= 0
  )
    throw new Error("Parámetros de ejecución inválidos");
  return cfg;
}
export const money = (n: number): number => Math.round(n * 1e6) / 1e6;
export const bookTime = (book: Book): number => book.verifiedAt ?? book.timestamp;
export const freshBook = (book: Book, now: number, age: number): boolean =>
  book.timestamp <= now && bookTime(book) <= now && now - bookTime(book) <= age;
export const fee = (q: number, p: number, rate: number): number =>
  Math.round(q * rate * p * (1 - p) * 1e5) / 1e5;
export interface Quote {
  quantity: number;
  gross: number;
  fees: number;
  limit: number;
}
export function quote(
  levels: Level[],
  quantity: number,
  rate: number,
  side: "BUY" | "SELL",
  limit?: number,
): Quote | null {
  if (!(quantity > 0)) return null;
  let remaining = quantity,
    gross = 0,
    fees = 0,
    worst = 0;
  const sorted = [...levels].sort((a, b) =>
    side === "BUY" ? a.price - b.price : b.price - a.price,
  );
  for (const l of sorted) {
    if (
      limit !== undefined &&
      (side === "BUY" ? l.price > limit + 1e-9 : l.price < limit - 1e-9)
    )
      continue;
    const q = Math.min(l.size, remaining);
    gross += q * l.price;
    fees += fee(q, l.price, rate);
    remaining -= q;
    worst = l.price;
    if (remaining < 1e-7)
      return { quantity, gross: money(gross), fees: money(fees), limit: worst };
  }
  return null;
}
export function validateFrame(input: unknown): Frame {
  const f = input as Frame;
  if (!f || typeof f !== "object") throw new Error("Libro inválido");
  for (const key of [
    "id",
    "marketId",
    "eventId",
    "underlying",
    "title",
    "source",
  ] as const)
    if (typeof f[key] !== "string" || !f[key] || f[key].length > 1000)
      throw new Error(`Identificador inválido: ${key}`);
  for (const key of [
    "timestamp",
    "feeRate",
    "mergeGasUsd",
    "recoveryGasUsd",
  ] as const)
    if (!Number.isFinite(f[key]) || f[key] < 0)
      throw new Error(`Dato inválido: ${key}`);
  if (f.feeRate > 1) throw new Error("Comisión inválida");
  if (f.paperGas) {
    const g = f.paperGas;
    if (
      ![g.units, g.gwei, g.polUsd, g.multiplier, g.timestamp].every(
        (n) => Number.isFinite(n) && n > 0,
      ) ||
      !Number.isInteger(g.units) ||
      g.units < 21000 ||
      g.units > 5000000 ||
      g.multiplier < 1 ||
      g.multiplier > 10 ||
      g.timestamp > f.timestamp ||
      f.timestamp - g.timestamp > 60000 ||
      typeof g.source !== "string" ||
      !g.source ||
      g.source.length > 500 ||
      f.gasVerified ||
      Math.abs(
        f.mergeGasUsd -
          money(g.units * g.gwei * 1e-9 * g.polUsd * g.multiplier),
      ) > 1e-6
    )
      throw new Error("Modelo de gas paper inválido");
  }
  for (const key of [
    "binary",
    "negRisk",
    "feeVerified",
    "gasVerified",
    "depth",
  ] as const)
    if (typeof f[key] !== "boolean") throw new Error(`Dato inválido: ${key}`);
  for (const book of [f.yes, f.no]) {
    if (book?.verifiedAt !== undefined &&
      (!Number.isFinite(book.verifiedAt) || book.verifiedAt < book.timestamp || book.verifiedAt > f.timestamp))
      throw new Error("Verificación de libro inválida");
    if (
      book?.hash !== undefined &&
      (typeof book.hash !== "string" || !book.hash || book.hash.length > 256)
    )
      throw new Error("Hash de libro inválido");
    if (
      !book ||
      typeof book.tokenId !== "string" ||
      !book.tokenId ||
      !Number.isFinite(book.timestamp) ||
      !Number.isFinite(book.minSize) ||
      book.minSize <= 0 ||
      !Number.isFinite(book.tickSize) ||
      book.tickSize <= 0 ||
      book.tickSize > 0.1
    )
      throw new Error("Metadatos de libro inválidos");
    for (const levels of [book.bids, book.asks]) {
      if (!Array.isArray(levels) || levels.length > 10000)
        throw new Error("Profundidad inválida");
      for (const l of levels)
        if (
          !Number.isFinite(l.price) ||
          l.price <= 0 ||
          l.price >= 1 ||
          !Number.isFinite(l.size) ||
          l.size <= 0
        )
          throw new Error("Nivel inválido");
    }
  }
  if (f.football) {
    const m = f.football;
    if (![m.matchId,m.league,m.home,m.away].every((v) => typeof v === "string" && v.length > 0 && v.length <= 500) || m.home === m.away || !["epl","lal","bun","sea","fl1","mex"].includes(m.league) || !["home","draw","away"].includes(m.result) || !Number.isFinite(m.startAt)) throw new Error("Partido inválido");
  }
  if (f.forecast) {
    const p = f.forecast;
    if (!f.football || !Number.isFinite(p.probability) || p.probability <= 0 || p.probability >= 1 || p.version !== footballPolicy.version || !/^[a-f0-9]{64}$/.test(p.checksum) || !Number.isFinite(p.generatedAt) || !Number.isFinite(p.dataVerifiedAt) || p.dataVerifiedAt > p.generatedAt || p.generatedAt > f.timestamp || !Number.isInteger(p.sampleSize) || p.sampleSize < footballPolicy.minMatches) throw new Error("Pronóstico inválido");
  }
  if (f.resolution) validateResolution(f.resolution, f.timestamp);
  if (f.secondsDelay !== undefined && (!Number.isFinite(f.secondsDelay) || f.secondsDelay < 0 || f.secondsDelay > 120)) throw new Error("Latencia deportiva inválida");
  if (f.connectionGeneration !== undefined && (!Number.isSafeInteger(f.connectionGeneration) || f.connectionGeneration < 1)) throw new Error("Generación de libro inválida");
  if (f.sizing) {
    const e=f.sizing;
    if (e.version !== sizingPolicy.version || !e.source || ![e.liquiditySha256,e.midpointsSha256].every(h=>typeof h === "string" && /^[a-f0-9]{64}$/.test(h)) || ![e.computedAt,e.gammaFrom,e.gammaTo,e.midpointFrom,e.midpointTo,e.gammaCount,e.recentGamma,e.returns].every(n=>Number.isSafeInteger(n)&&n>=0) || ![e.liquidityP10,e.volatilityYesBps,e.volatilityNoBps].every(n=>Number.isFinite(n)&&n>=0) || e.recentGamma>e.gammaCount || e.returns>60 || e.gammaFrom>e.gammaTo || e.midpointFrom>e.midpointTo || e.computedAt>f.timestamp) throw new Error("Evidencia de dimensionamiento inválida");
  }
  if (f.yes.tokenId === f.no.tokenId)
    throw new Error("Tokens complementarios inválidos");
  return f;
}
export interface Order {
  id: string;
  pairId: string;
  marketId: string;
  eventId: string;
  underlying: string;
  tokenId: string;
  outcome: Outcome;
  side: "BUY" | "SELL";
  quantity: number;
  limit: number;
  feeRate: number;
  status:
    | "reserved"
    | "submitted"
    | "uncertain"
    | "filled"
    | "rejected"
    | "cancelled";
  timestamp: number;
  mode: Mode;
  strategy: Strategy;
  forecast?: Forecast;
  football?: FootballMarket;
  takeProfit?: number;
  title?: string;
  externalId?: string;
  terminalAt?: number;
}
export interface Fill {
  id: string;
  orderId: string;
  quantity: number;
  gross: number;
  fees: number;
  timestamp: number;
}
export interface Position {
  tokenId: string;
  marketId: string;
  eventId: string;
  underlying: string;
  outcome: Outcome;
  quantity: number;
  cost: number;
  mark: number;
  timestamp: number;
  stale?: boolean;
  strategy?: Strategy;
  pairId?: string;
  football?: FootballMarket;
  forecast?: Forecast;
  takeProfit?: number;
  title?: string;
}
export interface Execution {
  status: "confirmed" | "rejected" | "uncertain" | "not_found";
  fills: Fill[];
  externalId?: string;
}
export interface Settlement {
  id: string;
  status: "confirmed" | "rejected" | "uncertain";
  gas: number;
  timestamp: number;
}
export interface Executor {
  readonly mode: Mode;
  execute(order: Order): Promise<Execution>;
  reconcile(order: Order): Promise<Execution>;
  cancel(order: Order): Promise<Execution>;
  merge(id: string, frame: Frame, quantity: number): Promise<Settlement>;
  reconcileMerge?(
    id: string,
    frame: Frame,
    quantity: number,
  ): Promise<Settlement>;
  redeem?(id: string, frame: Frame, quantity: number): Promise<Settlement>;
  reconcileRedeem?(id: string, frame: Frame, quantity: number): Promise<Settlement>;
}
export interface Account {
  initialCapital: number;
  cash: number;
  realized: number;
  fees: number;
  gas: number;
  deposits: number;
  withdrawals: number;
  peakPnl: number;
  day: string;
  dayStartPnl: number;
  stop: string | null;
  errors: number;
  connected: boolean;
  lastDataAt: number;
}
export interface Reservation {
  id: string;
  eventId: string;
  underlying: string;
  remaining: number;
  timestamp: number;
  strategy?: Strategy;
  marketId?: string;
}
export interface AuditEvent {
  id: string;
  timestamp: number;
  type: string;
  message: string;
  mode: Mode;
  strategy: string;
  marketId?: string;
}
export interface Metrics {
  equity: number;
  available: number;
  reserved: number;
  exposure: number;
  unrealized: number;
  netPnl: number;
  drawdown: number;
  dailyPnl: number;
  operationalCapital: number;
  sizeFactor: number;
}

export function strategyBinding(strategy: Strategy, config: RiskConfig) {
  return {id:strategy,version:strategy === "football-value" ? footballPolicy.version : "yes-no-depth-v2",configSha256:createHash("sha256").update(JSON.stringify({risk:validateConfig(config),sizingPolicy,...(strategy === "football-value" ? {footballPolicy} : {})})).digest("hex")};
}
