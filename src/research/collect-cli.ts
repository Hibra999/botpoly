import "dotenv/config";
import { parseArgs } from "node:util";
import { MarketData } from "./market-data.js";
import { writeDataset } from "./dataset.js";
import type { Frame } from "../engine/model.js";

const { values } = parseArgs({
  options: {
    markets: { type: "string" },
    seconds: { type: "string", default: "60" },
    interval: { type: "string", default: "1000" },
    out: { type: "string" },
  },
});
const seconds = Number(values.seconds),
  interval = Number(values.interval);
if (
  !values.out ||
  !Number.isFinite(seconds) ||
  seconds < 1 ||
  seconds > 86400 ||
  !Number.isFinite(interval) ||
  interval < 250 ||
  interval > 60000
)
  throw new Error(
    "Uso: pnpm data:collect --out data/libros.jsonl --seconds 60 --interval 1000 [--markets ID,ID]",
  );
const data = new MarketData(),
  markets = await data.markets(values.markets?.split(","));
const frames: Frame[] = [],
  end = Date.now() + seconds * 1000;
let failures = 0;
while (Date.now() < end) {
  for (const market of markets) {
    try {
      frames.push(await data.frame(market));
    } catch {
      failures++;
    }
  }
  if (Date.now() < end)
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(interval, end - Date.now())),
    );
}
const manifest = writeDataset(values.out, frames, {
  source: "https://docs.polymarket.com/market-data/overview",
  license: "Datos públicos de Polymarket; sujetos a sus condiciones de uso",
  kind: "snapshots",
  limitations: [
    `${failures} consultas fallidas`,
    "Snapshots REST; no reconstruyen todos los cambios del libro ni la prioridad de cola.",
    "Gas no verificado: las entradas se rechazan hasta aportar estimaciones verificadas.",
    "Concentración por evento; subyacente desconocido se agrupa conservadoramente por evento.",
  ],
});
console.log(
  JSON.stringify({
    file: values.out,
    frames: frames.length,
    sha256: manifest.sha256,
    failures,
  }),
);
