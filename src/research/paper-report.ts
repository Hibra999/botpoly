import { mkdirSync, renameSync, writeFileSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import type { Ledger } from "../engine/ledger.js";
import type { Fill, Order } from "../engine/model.js";
import { chart, csvCell, escapeHtml } from "./report.js";
import { accountAnalysis, entryQuality, type PaperAnalysis } from "./account-analysis.js";

export function writePaperReport(
  ledger: Ledger,
  directory: string,
  days = 5,
): string {
  if (
    ledger.mode !== "paper" ||
    !Number.isInteger(days) ||
    days < 1 ||
    days > 30
  )
    throw new Error("Informe paper: periodo entre 1 y 30 días");
  return ledger.store.transaction(() => {
  const to = ledger.now(),
    from =
      Date.parse(new Date(to).toISOString().slice(0, 10)) -
      (days - 1) * 86400000;
  const s = ledger.snapshot(),
    statistics = s.statistics.filter((d) => d.lastAt >= from);
  const analysis: PaperAnalysis = {...accountAnalysis(ledger, to), entryQuality: entryQuality(ledger, to)};
  ledger.store.put("meta", "paper:analysis", analysis);
  const totals: Record<string, number> = {};
  for (const day of statistics)
    for (const [key, n] of Object.entries(day.counts))
      totals[key] = (totals[key] ?? 0) + n;
  const rows = ledger.store.db
    .prepare(
      "SELECT data FROM equity WHERE rowid IN (SELECT MAX(rowid) FROM equity WHERE CAST(json_extract(data,'$.timestamp') AS INTEGER) >= ? GROUP BY CAST(json_extract(data,'$.timestamp') AS INTEGER)/300000) ORDER BY rowid",
    )
    .all(from) as { data: string }[];
  const curve = rows.map((r) => JSON.parse(r.data));
  if (!curve.length || curve[curve.length-1].timestamp < to) curve.push({ timestamp: to, ...s.metrics });
  const fills = (
    ledger.store.db
      .prepare(
        "SELECT data FROM fills WHERE json_extract(data,'$.timestamp') >= ? ORDER BY rowid",
      )
      .all(from) as { data: string }[]
  ).map((r) => JSON.parse(r.data) as Fill);
  const orders = new Map(
    fills.map((f) => [
      f.orderId,
      ledger.store.get<Order>("orders", f.orderId)!,
    ]),
  );
  const recorded = ledger.store.db
    .prepare("SELECT count(*) AS n FROM recorded_books WHERE timestamp >= ?")
    .get(from)!.n;
  const limits = [
    "Evaluación prospectiva paper. Los fills son simulados sobre profundidad observada; no se enviaron órdenes reales.",
    "Gas: unidades supuestas × precio fast de Polygon Gas Station × POL/USD × margen. No es eth_estimateGas ni una confirmación on-chain.",
    "Descubrimiento de hasta 5.000 mercados y observación de hasta 200, hasta 100 de fútbol; renovación cada cinco minutos. Las posiciones pendientes conservan cobertura adicional.",
    "Snapshots completos REST y cambios WebSocket con coalescencia. Se archivan muestras cada 10 segundos por mercado y snapshots usados para ejecución; no es un archivo completo de eventos ni una prueba de prioridad de cola.",
    "Fútbol: Poisson con datos gratuitos por lotes, 1/4 Kelly, ventaja neta mínima 5 pp, 1% por partido y 10% agregado. Salida al 10% neto ejecutable o resolución oficial CTF. No hay nuevas apuestas durante el juego ni probabilidades in-play.",
    "El PnL y los costes mostrados son acumulados de esta cuenta. Las observaciones, fills y motivos de rechazo corresponden a los días UTC seleccionados.",
    "Cero operaciones es un resultado posible; no se relajan los límites para fabricar actividad. No demuestra rentabilidad live.",
  ];
  const result = {
    schema: 1,
    kind: "paper",
    analysis,
    status: "exploratorio",
    from,
    to,
    startedAt: statistics[0]?.firstAt ?? null,
    account: s.account,
    config: s.config,
    metrics: s.metrics,
    observation: s.observation,
    runtime: s.runtime,
    strategies: s.strategy,
    footballPolicy: s.footballPolicy,
    football: s.football,
    footballEvidence: s.footballEvidence,
    positions: s.positions,
    orders: [...orders.values()],
    settlements: ledger.store.all<{timestamp:number}>("settlements").filter(x=>x.timestamp >= from && x.timestamp <= to),
    activity: ledger.store.all<import("../engine/ledger.js").DailyStatistics>("activity").filter(h=>h.lastAt >= from && h.firstAt <= to),
    totals,
    recordedBooks: Number(recorded),
    statistics,
    curve,
    fills,
    gasStress3xNetPnl: s.metrics.netPnl - 2 * s.account.gas,
    limitations: limits,
  };
  const usd = (n: number) => `US$${n.toFixed(4)}`;
  const html = `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Botpoly · Seguimiento paper</title><style>body{background:#101018;color:#eee;font:16px/1.6 system-ui;margin:0}main{max-width:1050px;margin:auto;padding:24px}table{border-collapse:collapse;width:100%}td,th{padding:8px;border-bottom:1px solid #454552;text-align:left}h1,h2,strong{color:#b9a9ff}svg{width:100%;height:auto}figure{margin:20px 0}.notice{padding:16px;background:#252132}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><main><h1>Seguimiento paper · YES/NO y fútbol</h1><p class="notice">Resultados simulados sobre mercados observados. Gas modelado; no prueba rentabilidad real.</p><p>Informe generado: ${new Date(to).toISOString()}. Actividad desde ${new Date(from).toISOString()}.</p><p>Inicio de las observaciones incluidas: ${result.startedAt ? new Date(result.startedAt).toISOString() : "sin observaciones"}.</p><p><strong>PnL acumulado: ${usd(s.metrics.netPnl)}</strong> · Capital: ${usd(s.metrics.equity)} · Comisiones: ${usd(s.account.fees)} · Gas: ${usd(s.account.gas)}</p><p>Libros evaluados: ${totals.evaluated ?? 0} · Reservas autorizadas: ${totals.accepted ?? 0} · Fills del periodo: ${fills.length} · Libros archivados: ${recorded}</p><p>Estado: ${escapeHtml(s.account.stop ?? (s.account.connected ? "activo" : "sin conexión"))}</p>${chart(
    curve.map((v) => v.equity),
    "Capital (USD)",
  )}${chart(
    curve.map((v) => v.drawdown * 100),
    "Drawdown (%)",
  )}${analysisHtml(analysis)}<h2>Cobertura y estrategias</h2><pre>${escapeHtml(JSON.stringify({runtime:s.runtime,coverage:s.observation?.coverage,feed:s.observation?.feed,football:s.football?.leagues},null,2))}</pre><h2>Posiciones abiertas</h2><pre>${escapeHtml(s.positions.length ? JSON.stringify(s.positions,null,2) : "Sin posiciones abiertas.")}</pre><h2>Motivos de rechazo</h2><table><thead><tr><th>Motivo</th><th>Cantidad</th></tr></thead><tbody>${
    Object.entries(totals)
      .filter(([k]) => k.startsWith("rejected:"))
      .map(
        ([k, n]) => `<tr><td>${escapeHtml(k.slice(9))}</td><td>${n}</td></tr>`,
      )
      .join("") || "<tr><td>Sin rechazos registrados</td><td>0</td></tr>"
  }</tbody></table><h2>Coste de gas bajo estrés</h2><p>Con gas ×3 y las mismas ejecuciones, el PnL acumulado sería ${usd(result.gasStress3xNetPnl)}. Es un ajuste de costes; no vuelve a simular la selección de operaciones.</p><h2>Supuestos y límites</h2><ul>${limits.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul><details><summary>Configuración y observación</summary><pre>${escapeHtml(JSON.stringify({ config: s.config, observation: s.observation }, null, 2))}</pre></details></main></html>`;
  const csv =
    [
      [
        "fill_id",
        "order_id",
        "market",
        "strategy",
        "match",
        "side",
        "outcome",
        "quantity",
        "gross_usd",
        "fees_usd",
        "timestamp",
      ],
      ...fills.map((f) => {
        const o = orders.get(f.orderId);
        return [
          f.id,
          f.orderId,
          o?.marketId ?? "",
          o?.strategy ?? "yes-no",
          o?.football?.matchId ?? "",
          o?.side ?? "",
          o?.outcome ?? "",
          f.quantity,
          f.gross,
          f.fees,
          new Date(f.timestamp).toISOString(),
        ];
      }),
    ]
      .map((row) => row.map(csvCell).join(","))
      .join("\n") + "\n";
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const [name, body] of [
    ["report.html", html],
    ["result.json", JSON.stringify(result, null, 2) + "\n"],
    ["trades.csv", csv],
  ]) {
    const path = resolve(directory, name);
    writeFileSync(path + ".tmp", body, { mode: 0o600 });
    renameSync(path + ".tmp", path);
  }
  const files = ["report.html", "result.json", "trades.csv"];
  writeFileSync(resolve(directory, "manifest.json"), JSON.stringify({
    schema: 1, generatedAt: to, kind: "paper", from, to,
    source: "SQLite persistente: libros observados, órdenes, fills simulados y contabilidad",
    files: Object.fromEntries(files.map((name) => [name, createHash("sha256").update(readFileSync(resolve(directory, name))).digest("hex")])),
  }, null, 2), { mode: 0o600 });
  const id = basename(resolve(directory));
  if (
    /^[a-zA-Z0-9_-]+$/.test(id) &&
    resolve(directory, "..") === resolve("reports")
  )
    ledger.store.put("reports", id, {
      id,
      timestamp: to,
      label: "Seguimiento paper",
      status: "exploratorio",
      netPnl: s.metrics.netPnl,
    });
  return resolve(directory, "report.html");
  });
}

/** Reuses the report data and the system SVG renderer; no browser or network. */
export async function writePaperChart(directory: string): Promise<string> {
  const result = JSON.parse(readFileSync(resolve(directory, "result.json"), "utf8"));
  const curve = result.curve as { timestamp: number; equity: number; netPnl: number; drawdown: number }[];
  const panels: [string, number[], string, number[]][] = [
    ["Capital · USD", curve.map((p) => p.equity), "#b9a9ff",curve.map(p=>p.timestamp)],
    ["PnL neto acumulado · USD", curve.map((p) => p.netPnl), "#83b7ff",curve.map(p=>p.timestamp)],
    ["Drawdown · %", curve.map((p) => p.drawdown * 100), "#ffa884",curve.map(p=>p.timestamp)],
    ["Compras y ventas · por hora", (result.activity ?? []).map((p: DailyStatisticsForChart) => (p.counts.buys ?? 0) + (p.counts.sells ?? 0)), "#7fe0b1",(result.activity ?? []).map((p:DailyStatisticsForChart)=>Date.parse(p.day+":00:00.000Z"))],
  ];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1000" viewBox="0 0 1200 1000"><rect width="1200" height="1000" fill="#101018"/><g font-family="sans-serif" fill="#eee"><text x="40" y="48" font-size="28">Botpoly · seguimiento PAPER</text><text x="40" y="80" font-size="16">${new Date(result.to).toISOString()} · Ejecuciones simuladas · Gas modelado</text>${panels.map(([title, values, color, times], i) => {
    if (!values.length) { values = [0]; times=[result.to]; }
    const min = Math.min(...values), max = Math.max(...values), span = Math.max(max - min, 0.01);
    const from=curve[0].timestamp, to=result.to;
    const top = 115 + i * 195;
    const points = values.map((v, j) => `${60 + Math.max(0,Math.min(1,(times[j]-from)/Math.max(1,to-from))) * 1080},${top + 145 - (max === min ? 55 : (v - min) / span * 110)}`).join(" ");
    return `<text x="40" y="${top}" font-size="19">${title} · min ${min.toFixed(2)} / max ${max.toFixed(2)}</text><path d="M60 ${top + 145}H1140" stroke="#454552"/><polyline fill="none" stroke="${color}" stroke-width="3" points="${points}"/>${points.split(" ").map(p=>{const [x,y]=p.split(",");return `<circle cx="${x}" cy="${y}" r="2" fill="${color}"/>`;}).join("")}`;
  }).join("")}<text x="40" y="925" font-size="16">${escapeHtml(new Date(curve[0].timestamp).toISOString())} → ${escapeHtml(new Date(curve.at(-1)!.timestamp).toISOString())}</text><text x="40" y="955" font-size="16">Evaluaciones: ${result.totals.evaluated ?? 0} · Señales: ${result.totals.signals ?? 0} · Reservas: ${result.totals.accepted ?? 0} · Fills: ${result.fills.length} · Costes: US$${(result.account.fees+result.account.gas).toFixed(4)}</text></g></svg>`;
  const input = resolve(directory, "chart.svg"), output = resolve(directory, "chart.png");
  writeFileSync(input, svg, { mode: 0o600 });
  await promisify(execFile)("rsvg-convert", ["-o", output + ".tmp", input], { timeout: 15000 });
  renameSync(output + ".tmp", output);
  const manifestPath=resolve(directory,"manifest.json");
  const manifest=JSON.parse(readFileSync(manifestPath,"utf8"));
  for (const name of ["chart.svg","chart.png"]) manifest.files[name]=createHash("sha256").update(readFileSync(resolve(directory,name))).digest("hex");
  writeFileSync(manifestPath+".tmp",JSON.stringify(manifest,null,2),{mode:0o600});renameSync(manifestPath+".tmp",manifestPath);
  return output;
}
interface DailyStatisticsForChart { day:string; counts: Record<string, number> }

function analysisHtml(a: PaperAnalysis): string {
  const usd = (n: number) => `US$${n.toFixed(4)}`;
  return `<h2>Rendimiento atribuido y efectivo</h2><p>Efectivo sin operar: ${usd(a.cashBenchmark)} · diferencia neta: ${usd(a.excessOverCash)}. Acumulado de la cuenta, con los mismos flujos externos y sin intereses.</p>${[['Estrategia',a.byStrategy],['Liga',a.byLeague]].map(([title,rows])=>`<h3>${title}</h3><div style="overflow:auto"><table><tr><th>Grupo</th><th>Realizado</th><th>Abierto</th><th>PnL neto</th><th>Comisiones</th><th>Gas</th></tr>${(rows as PaperAnalysis['byStrategy']).map(r=>`<tr><td>${escapeHtml(r.name)}</td>${[r.realized,r.unrealized,r.netPnl,r.fees,r.gas].map(v=>`<td>${usd(v)}</td>`).join('')}</tr>`).join('') || '<tr><td colspan="6">Sin operaciones.</td></tr>'}</table></div>`).join('')}<h2>Calidad de entrada a 1, 5 y 30 minutos</h2><p>Salida hipotética del fill completo al primer libro verificado dentro de los 30 segundos posteriores al horizonte. Incluye comisión de compra, venta y gas de recuperación modelado. Una muestra sin profundidad o por debajo del mínimo no tiene PnL ejecutable. No son ventas ni beneficios contabilizados; no sumar estas alternativas entre sí.</p><pre>${escapeHtml(JSON.stringify(a.entryQuality,null,2))}</pre><h2>Concentración de fútbol</h2><pre>${escapeHtml(JSON.stringify(a.concentration,null,2))}</pre><ul>${a.limitations.map(x=>`<li>${escapeHtml(x)}</li>`).join('')}</ul>`;
}
