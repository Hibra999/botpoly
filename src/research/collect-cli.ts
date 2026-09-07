import "dotenv/config";
import {existsSync,readFileSync} from "node:fs";
import {basename} from "node:path";
import {Store} from "../engine/store.js";
import {ObservedSizing,sizingPolicy} from "../engine/sizing.js";
import { parseArgs } from "node:util";
import { MarketData } from "./market-data.js";
import { writeDataset,checksum } from "./dataset.js";
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
const observationPath=values.out+".observations.sqlite";
if (existsSync(values.out) || existsSync(observationPath)) throw new Error("El destino ya existe; conserva el dataset anterior");
const store=new Store(observationPath), sizing=new ObservedSizing(store),data = new MarketData();
let markets:Awaited<ReturnType<MarketData["markets"]>>=[], refreshedAt=0;
const frames: Frame[] = [],
  end = Date.now() + seconds * 1000;
let failures = 0;
while (Date.now() < end) {
  if (!markets.length || Date.now()-refreshedAt>=300000) {
    markets=await data.markets(values.markets?.split(","));refreshedAt=Date.now();
    for (const m of markets) if (m.gammaCapturedAt && m.metrics.liquidity != null) sizing.gamma(m.conditionId!,Number(m.metrics.liquidity),m.gammaCapturedAt,`Polymarket Gamma · ${m.id} · captura actual`);
  }
  for (const market of markets) {
    try {
      const frame=await data.frame(market);
      sizing.midpoint(frame);frame.sizing=sizing.evidence(frame.marketId,frame.timestamp);
      frames.push(frame);
    } catch {
      failures++;
    }
  }
  if (Date.now() < end)
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(interval, end - Date.now())),
    );
}
await data.stream.close();store.close();
const manifest = writeDataset(values.out, frames, {
  source: "https://docs.polymarket.com/market-data/overview",
  license: "Datos públicos de Polymarket; sujetos a sus condiciones de uso",
  kind: "snapshots",
  observations:{file:basename(observationPath),sha256:checksum(readFileSync(observationPath)),policy:sizingPolicy.version},
  limitations: [
    `${failures} consultas fallidas`,
    "Gamma observado cada cinco minutos y puntos medios por minuto desde la captura; una muestra breve no proporciona 60 variaciones ni 12 Gamma. La política experimental no inventa cobertura.",
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
