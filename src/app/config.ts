import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defaults, footballPolicy, strategyBinding, validateConfig, type Mode, type RiskConfig } from "../engine/model.js";
import { checksum } from "../research/dataset.js";
import { PaperGas } from "../research/paper-gas.js";

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const mode = env.BOT_MODE ?? "paper";
  if (!["paper", "backtest", "live"].includes(mode))
    throw new Error("BOT_MODE inválido");
  if (env.DRY_RUN === "false" && mode !== "live")
    throw new Error(
      "DRY_RUN=false ya no activa live; usa la activación explícita documentada",
    );
  if (
    ["DIPARB_ENABLED", "SMARTMONEY_ENABLED", "TREND_ANALYSIS_ENABLED"].some(
      (k) => env[k] === "true",
    )
  )
    throw new Error("Las estrategias experimentales están desactivadas");
  const file = env.BOT_CONFIG
    ? JSON.parse(readFileSync(env.BOT_CONFIG, "utf8"))
    : defaults;
  const risk = validateConfig({
    ...file,
    capitalUsd: Number(env.CAPITAL_USD ?? file.capitalUsd ?? 1000),
  });
  const port = Number(env.DASHBOARD_PORT ?? 3001),
    interval = Number(env.POLL_INTERVAL_MS ?? 2000);
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !Number.isFinite(interval) ||
    interval < 500 ||
    interval > 60000
  )
    throw new Error("Puerto o intervalo inválido");
  if (!env.DASHBOARD_PASSWORD_HASH)
    throw new Error("Configura acceso con pnpm auth:setup");
  const gasUnits = Number(env.PAPER_GAS_UNITS ?? 300000),
    gasMultiplier = Number(env.PAPER_GAS_MULTIPLIER ?? 1.5);
  if (mode === "paper") new PaperGas(gasUnits, gasMultiplier);
  return {
    mode: mode as Mode,
    risk,
    port,
    interval,
    passwordHash: env.DASHBOARD_PASSWORD_HASH,
    origin: env.DASHBOARD_ORIGIN,
    database: resolve(env.BOT_DATABASE ?? `.runtime/${mode}.sqlite`),
    markets: env.MARKET_IDS?.split(",").filter(Boolean) ?? [],
    reports: resolve("reports"),
    telegramToken: env.TELEGRAM_BOT_TOKEN ?? "",
    telegramChat: env.TELEGRAM_CHAT_ID ?? "",
    gasUnits,
    gasMultiplier,
  };
}
export {strategyBinding} from "../engine/model.js";
export function authorizeLive(env: NodeJS.ProcessEnv = process.env, config: RiskConfig = defaults): {
  key: string;
  rpc: string;
  strategies: ReturnType<typeof strategyBinding>[];
} {
  if (
    env.LIVE_ACK !== "ACTIVAR_LIVE_CON_RIESGO_REAL" ||
    !env.LIVE_EVIDENCE_FILE ||
    !env.POLYMARKET_PRIVATE_KEY ||
    !env.POLYGON_RPC_URL
  )
    throw new Error(
      "Live requiere activación explícita, evidencia revisada, clave y RPC",
    );
  const approval = JSON.parse(
    readFileSync(env.LIVE_EVIDENCE_FILE, "utf8"),
  ) as Record<string, unknown>;
  if (
    approval.schema !== 1 ||
    approval.outOfSampleReviewed !== true ||
    approval.executionAndCostsReviewed !== true ||
    approval.securityReviewed !== true ||
    typeof approval.approvedBy !== "string" ||
    !approval.approvedBy ||
    typeof approval.reportPath !== "string" ||
    typeof approval.reportSha256 !== "string"
  )
    throw new Error("Revisión de live incompleta");
  const strategies = (["yes-no","football-value"] as const).map(id=>strategyBinding(id,config));
  if (JSON.stringify(approval.strategies) !== JSON.stringify(strategies)) throw new Error("La evidencia live debe vincular ambas estrategias, versiones y configuración exacta");
  const raw = readFileSync(approval.reportPath),
    result = JSON.parse(raw.toString());
  if (
    checksum(raw) !== approval.reportSha256 ||
    JSON.stringify(result.strategies) !== JSON.stringify(strategies) ||
    result.manifest?.kind !== "events" ||
    result.manifest?.coverage?.maxGapMs > 1000 ||
    result.manifest?.coverage?.frames < 1000
  )
    throw new Error(
      "Evidencia insuficiente: se requieren eventos del libro y cobertura revisada",
    );
  const validation = result.trials?.find(
    (t: { label: string; period: string }) =>
      t.label === "Riesgo mejorado" && t.period === "evaluación",
  );
  if (
    !(validation?.metrics?.netPnl > 0) ||
    !(validation?.bootstrap95?.[0] > 0) ||
    validation?.fills?.length < 100
  )
    throw new Error(
      "Evidencia fuera de muestra insuficiente después de costes",
    );
  const football = result.footballProspective;
  if (approval.footballProspectiveReviewed !== true || football?.strategy !== "football-value" || football?.version !== footballPolicy.version || football?.configSha256 !== strategies[1].configSha256 || !(football?.netPnl > 0) || !(football?.bootstrap95?.[0] > 0) || !(football?.confirmedFills >= 100) || !(football?.officialSettlements > 0) || football?.kind !== "prospective-paper") throw new Error("Fútbol live requiere evidencia prospectiva revisada propia, después de costes");
  return { key: env.POLYMARKET_PRIVATE_KEY, rpc: env.POLYGON_RPC_URL, strategies };
}
