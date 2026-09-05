import { parseArgs } from "node:util";
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { defaults, validateConfig } from "../engine/model.js";
import { Store } from "../engine/store.js";
import { readDataset } from "./dataset.js";
import { runBacktest } from "./backtest.js";
import { writeReport } from "./report.js";

const { values } = parseArgs({
  options: Object.fromEntries(
    [
      "input",
      "from",
      "split",
      "to",
      "capital",
      "markets",
      "config",
      "seed",
      "out",
      "register",
    ].map((k) => [k, { type: "string" as const }]),
  ),
});
if (
  !values.input ||
  !values.from ||
  !values.split ||
  !values.to ||
  !values.capital ||
  !values.markets ||
  !values.out
)
  throw new Error(
    "Uso: pnpm backtest --input data/libros.jsonl --from ISO --split ISO --to ISO --capital 1000 --markets CONDITION_ID --out reports/nombre [--config config.json] [--register .runtime/paper.sqlite]",
  );
if (existsSync(resolve(values.out, "result.json")))
  throw new Error(
    "El informe ya existe: usa otra carpeta para conservar todos los ensayos",
  );
const data = readDataset(values.input);
const result = await runBacktest(data.frames, data.manifest, {
  from: Date.parse(values.from),
  split: Date.parse(values.split),
  to: Date.parse(values.to),
  capital: Number(values.capital),
  markets: values.markets.split(","),
  config: validateConfig(
    values.config ? JSON.parse(readFileSync(values.config, "utf8")) : defaults,
  ),
  seed: Number(values.seed ?? 42),
});
writeReport(values.out, result);
appendFileSync(
  resolve(values.out, "..", "trials.jsonl"),
  JSON.stringify({
    id: result.id,
    inputChecksum: result.manifest.sha256,
    implementationSha256: result.implementationSha256,
    options: result.options,
    trials: result.trials.map((t) => ({
      id: t.id,
      label: t.label,
      period: t.period,
      config: t.config,
      simulation: t.simulation,
      netPnl: t.metrics.netPnl,
    })),
  }) + "\n",
  { mode: 0o600 },
);
if (values.register) {
  const store = new Store(values.register),
    id = basename(resolve(values.out));
  if (
    !/^[a-zA-Z0-9_-]+$/.test(id) ||
    resolve(values.out, "..") !== resolve("reports")
  )
    throw new Error("Para registrar, el informe debe estar en reports/NOMBRE");
  store.put("reports", id, {
    id,
    timestamp: Date.now(),
    label: "Arbitraje YES/NO",
    status: result.status,
    netPnl: result.trials.find(
      (t) => t.label === "Riesgo mejorado" && t.period === "evaluación",
    )!.metrics.netPnl,
  });
  store.close();
}
console.log(
  JSON.stringify({
    id: result.id,
    status: result.status,
    report: resolve(values.out, "report.html"),
    liveEligible: false,
  }),
);
