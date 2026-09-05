import { Store } from "../engine/store.js";
import { Ledger } from "../engine/ledger.js";
import { Engine } from "../engine/engine.js";
import {
  PaperExecutor,
  simulationDefaults,
  type SimulationConfig,
} from "../engine/paper.js";
import {
  defaults,
  validateConfig,
  type Frame,
  type RiskConfig,
  type Metrics,
  type Order,
  type Fill,
  type AuditEvent,
} from "../engine/model.js";
import { checksum, type Manifest } from "./dataset.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface BacktestOptions {
  from: number;
  split: number;
  to: number;
  capital: number;
  markets: string[];
  config: RiskConfig;
  seed: number;
}
export interface Trial {
  id: string;
  label: string;
  period: "ajuste" | "evaluación";
  config: RiskConfig;
  simulation: SimulationConfig;
  metrics: Metrics;
  realized: number;
  fees: number;
  gas: number;
  orders: Order[];
  fills: Fill[];
  events: AuditEvent[];
  equity: (Metrics & { timestamp: number })[];
  failures: number;
  bootstrap95: [number, number];
}
export interface BacktestResult {
  id: string;
  timestamp: number;
  status: "exploratorio" | "insuficiente";
  manifest: Manifest;
  implementationSha256: string;
  options: BacktestOptions;
  trials: Trial[];
  cash: { capital: number; netPnl: 0 };
  limitations: string[];
  validation: { liveEligible: false; reason: string };
}
export function blockBootstrap(
  values: number[],
  seed: number,
  samples = 500,
): [number, number] {
  if (!values.length) return [0, 0];
  let state = seed >>> 0 || 1;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
  const block = Math.max(1, Math.round(Math.sqrt(values.length))),
    totals: number[] = [];
  for (let n = 0; n < samples; n++) {
    let count = 0,
      sum = 0;
    while (count < values.length) {
      const start = Math.floor(random() * values.length);
      for (let k = 0; k < block && count < values.length; k++, count++)
        sum += values[(start + k) % values.length];
    }
    totals.push(sum);
  }
  totals.sort((a, b) => a - b);
  return [
    totals[Math.floor(samples * 0.025)],
    totals[Math.min(samples - 1, Math.floor(samples * 0.975))],
  ];
}
async function trial(
  frames: Frame[],
  period: Trial["period"],
  label: string,
  config: RiskConfig,
  simulation: SimulationConfig,
  from: number,
  to: number,
  seed: number,
): Promise<Trial> {
  let time = from;
  const source = structuredClone(
    frames.filter((f) => f.timestamp >= from && f.timestamp < to),
  );
  const store = new Store(":memory:"),
    ledger = new Ledger(store, "backtest", config, () => time);
  const byMarket = new Map<string, Frame[]>();
  for (const f of source) {
    const list = byMarket.get(f.marketId) ?? [];
    list.push(f);
    byMarket.set(f.marketId, list);
  }
  const paper = new PaperExecutor(
    "backtest",
    async (market, target) => {
      const list = byMarket.get(market) ?? [];
      let lo = 0,
        hi = list.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (list[mid].timestamp < target) lo = mid + 1;
        else hi = mid;
      }
      const next = list[lo];
      if (
        !next ||
        next.timestamp >= to ||
        next.timestamp - target > config.maxDataAgeMs
      )
        return undefined;
      time = Math.max(time, next.timestamp);
      return next;
    },
    () => time,
    simulation,
    config.maxDataAgeMs,
    store,
  );
  const engine = new Engine(ledger, paper);
  engine.health(true);
  engine.recordEquity();
  for (const f of source) {
    if (f.timestamp < time) continue; // Execution latency advances the simulated clock.
    time = f.timestamp;
    const a = ledger.account;
    a.lastDataAt = time;
    ledger.save(a);
    // The strategy sees only the current snapshot; future books are private to the executor.
    await engine.process(structuredClone(f));
    ledger.mark(f);
    engine.recordEquity();
  }
  time = to;
  ledger.mark();
  engine.recordEquity();
  const snap = ledger.snapshot(),
    equity = store.all<Metrics & { timestamp: number }>("equity");
  const increments = equity.slice(1).map((v, i) => v.netPnl - equity[i].netPnl);
  const result: Trial = {
    id: checksum(
      JSON.stringify({ label, period, config, simulation, from, to, seed }),
    ).slice(0, 20),
    label,
    period,
    config,
    simulation,
    metrics: snap.metrics,
    realized: snap.account.realized,
    fees: snap.account.fees,
    gas: snap.account.gas,
    orders: store.all("orders"),
    fills: store.all("fills"),
    events: store.all("events"),
    equity,
    failures: snap.events.filter((e) =>
      ["execution_failed", "stop"].includes(e.type),
    ).length,
    bootstrap95: blockBootstrap(increments, seed),
  };
  store.close();
  return result;
}
export async function runBacktest(
  frames: Frame[],
  manifest: Manifest,
  options: BacktestOptions,
): Promise<BacktestResult> {
  const implementationSha256 = checksum(
    ["model", "store", "ledger", "engine", "paper"]
      .map((name) => readFileSync(resolve("src/engine", name + ".ts"), "utf8"))
      .join("\n") + readFileSync(resolve("src/research/backtest.ts"), "utf8"),
  );
  if (
    ![
      options.from,
      options.split,
      options.to,
      options.capital,
      options.seed,
    ].every(Number.isFinite) ||
    !(options.from < options.split && options.split < options.to) ||
    options.capital < 50 ||
    !options.markets.length
  )
    throw new Error(
      "Periodo, corte cronológico, mercados y capital explícitos requeridos",
    );
  const config = validateConfig({
    ...options.config,
    capitalUsd: options.capital,
  });
  const selected = frames.filter(
    (f) =>
      options.markets.includes(f.marketId) &&
      f.timestamp >= options.from &&
      f.timestamp < options.to,
  );
  if (
    !selected.some((f) => f.timestamp < options.split) ||
    !selected.some((f) => f.timestamp >= options.split)
  )
    throw new Error("Se necesitan observaciones en ajuste y evaluación");
  const original = validateConfig({
    ...defaults,
    capitalUsd: options.capital,
    dailyLossPct: 0.05,
    maxDrawdownPct: 0.25,
    unhedgedLossPct: 0.02,
    minNetProfitUsd: 0.5,
  });
  const variants = [
    {
      label: "Límites originales (aproximación)",
      config: original,
      simulation: simulationDefaults,
    },
    { label: "Riesgo mejorado", config, simulation: simulationDefaults },
    {
      label: "Latencia 2 segundos",
      config,
      simulation: { ...simulationDefaults, latencyMs: 2000 },
    },
    {
      label: "Gas ×3",
      config,
      simulation: { ...simulationDefaults, gasMultiplier: 3 },
    },
    {
      label: "Liquidez al 25%",
      config,
      simulation: { ...simulationDefaults, depthMultiplier: 0.25 },
    },
    {
      label: "Pata NO rechazada",
      config,
      simulation: { ...simulationDefaults, failNoEvery: 2 },
    },
    {
      label: "Ejecuciones parciales anómalas",
      config,
      simulation: { ...simulationDefaults, partialEvery: 3 },
    },
    {
      label: "Rechazos de órdenes",
      config,
      simulation: { ...simulationDefaults, rejectEvery: 3 },
    },
    {
      label: "Resolución retrasada",
      config,
      simulation: { ...simulationDefaults, resolutionDelayMs: 86400000 },
    },
  ];
  const trials: Trial[] = [];
  // All predeclared trials are retained, including failures. No winner is chosen
  // using evaluation data and no positions cross the chronological split.
  for (const v of variants) {
    trials.push(
      await trial(
        selected,
        "ajuste",
        v.label,
        v.config,
        v.simulation,
        options.from,
        options.split,
        options.seed,
      ),
    );
    trials.push(
      await trial(
        selected,
        "evaluación",
        v.label,
        v.config,
        v.simulation,
        options.split,
        options.to,
        options.seed,
      ),
    );
  }
  const anyFills = trials.some((t) => t.fills.length);
  return {
    id: checksum(
      JSON.stringify({
        checksum: manifest.sha256,
        options,
        implementationSha256,
      }),
    ).slice(0, 20),
    timestamp: options.to,
    implementationSha256,
    status: anyFills ? "exploratorio" : "insuficiente",
    manifest,
    options,
    trials,
    cash: { capital: options.capital, netPnl: 0 },
    limitations: [
      ...manifest.limitations,
      "Simulación de ejecución; nunca prueba fills reales.",
      "La comparación original aplica sus límites principales al mismo ejecutor; no reproduce el PnL ficticio, copy trading ni el incremento de riesgo por rachas del bot anterior.",
      "FOK por pata no hace atómico el par. Las ejecuciones parciales son un escenario anómalo explícito.",
      "No se modelan prioridad de cola ni todas las actualizaciones entre snapshots. El siguiente libro disponible después de la latencia aproxima el precio de ejecución.",
      "Intervalo por remuestreo de bloques sobre incrementos de PnL, con semilla fija; una muestra breve no permite inferir rentabilidad.",
      "El efectivo supone rendimiento cero. No se incluyen intereses ni riesgo de custodia.",
      "Las posiciones restantes al cierre se valoran a salida disponible; si el libro caducó, a cero.",
      "Todas las variantes se registran; la evaluación queda separada cronológicamente del ajuste.",
    ],
    validation: {
      liveEligible: false,
      reason:
        "Requiere revisión independiente de datos, ejecuciones, costes y evidencia fuera de muestra antes de activar live.",
    },
  };
}
