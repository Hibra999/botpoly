import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { Ledger } from "../engine/ledger.js";
import type { Fill, Order } from "../engine/model.js";
import { chart, csvCell, escapeHtml } from "./report.js";

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
  const to = ledger.now(),
    from =
      Date.parse(new Date(to).toISOString().slice(0, 10)) -
      (days - 1) * 86400000;
  const s = ledger.snapshot(),
    statistics = s.statistics.filter((d) => d.lastAt >= from);
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
  if (!curve.length) curve.push({ timestamp: to, ...s.metrics });
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
    "Se consultan hasta 20 mercados binarios estándar por ciclo, renovados cada 15 minutos; no se cubre todo Polymarket ni todos los cambios entre consultas.",
    "Se usan los mejores 20 niveles por lado. Se archivan libros comprimidos cada 10 segundos por mercado y los libros usados en ejecuciones.",
    "El PnL y los costes mostrados son acumulados de esta cuenta. Las observaciones, fills y motivos de rechazo corresponden a los días UTC seleccionados.",
    "Cero operaciones es un resultado posible; no se relajan los límites para fabricar actividad. No demuestra rentabilidad live.",
  ];
  const result = {
    schema: 1,
    kind: "paper",
    status: "exploratorio",
    from,
    to,
    startedAt: statistics[0]?.firstAt ?? null,
    account: s.account,
    config: s.config,
    metrics: s.metrics,
    observation: s.observation,
    totals,
    recordedBooks: Number(recorded),
    statistics,
    curve,
    fills,
    gasStress3xNetPnl: s.metrics.netPnl - 2 * s.account.gas,
    limitations: limits,
  };
  const usd = (n: number) => `US$${n.toFixed(4)}`;
  const html = `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Botpoly · Seguimiento paper</title><style>body{background:#101018;color:#eee;font:16px/1.6 system-ui;margin:0}main{max-width:1050px;margin:auto;padding:24px}table{border-collapse:collapse;width:100%}td,th{padding:8px;border-bottom:1px solid #454552;text-align:left}h1,h2,strong{color:#b9a9ff}svg{width:100%;height:auto}figure{margin:20px 0}.notice{padding:16px;background:#252132}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><main><h1>Seguimiento paper · YES / NO</h1><p class="notice">Resultados simulados sobre mercados observados. Gas modelado; no prueba rentabilidad real.</p><p>Informe generado: ${new Date(to).toISOString()}. Actividad desde ${new Date(from).toISOString()}.</p><p>Inicio de las observaciones incluidas: ${result.startedAt ? new Date(result.startedAt).toISOString() : "sin observaciones"}.</p><p><strong>PnL acumulado: ${usd(s.metrics.netPnl)}</strong> · Capital: ${usd(s.metrics.equity)} · Comisiones: ${usd(s.account.fees)} · Gas: ${usd(s.account.gas)}</p><p>Libros evaluados: ${totals.evaluated ?? 0} · Pares autorizados: ${totals.accepted ?? 0} · Fills del periodo: ${fills.length} · Libros archivados: ${recorded}</p><p>Estado: ${escapeHtml(s.account.stop ?? (s.account.connected ? "activo" : "sin conexión"))}</p>${chart(
    curve.map((v) => v.equity),
    "Capital (USD)",
  )}${chart(
    curve.map((v) => v.drawdown * 100),
    "Drawdown (%)",
  )}<h2>Motivos de rechazo</h2><table><thead><tr><th>Motivo</th><th>Cantidad</th></tr></thead><tbody>${
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
}
