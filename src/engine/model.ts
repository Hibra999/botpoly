export type Mode = "paper" | "backtest" | "live";
export type Outcome = "YES" | "NO";
export interface Level {
  price: number;
  size: number;
}
export interface Book {
  tokenId: string;
  timestamp: number;
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
  source: string;
  depth: boolean;
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
    !Number.isInteger(cfg.maxErrors) ||
    cfg.maxErrors < 1 ||
    cfg.maxCostUsd <= 0
  )
    throw new Error("Parámetros de ejecución inválidos");
  return cfg;
}
export const money = (n: number): number => Math.round(n * 1e6) / 1e6;
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
  for (const key of [
    "binary",
    "negRisk",
    "feeVerified",
    "gasVerified",
    "depth",
  ] as const)
    if (typeof f[key] !== "boolean") throw new Error(`Dato inválido: ${key}`);
  for (const book of [f.yes, f.no]) {
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
  strategy: "yes-no";
  externalId?: string;
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
