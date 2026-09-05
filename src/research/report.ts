import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BacktestResult } from "./backtest.js";
export const escapeHtml = (value: unknown) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const usd = (n: number) => `US$${n.toFixed(4)}`;
export const csvCell = (v: unknown) =>
  '"' +
  (typeof v === "string"
    ? v.replace(/^(\s*[=+\-@]|[\t\r])/, "'$&")
    : String(v)
  ).replace(/"/g, '""') +
  '"';
export function chart(values: number[], title: string): string {
  const min = Math.min(...values),
    max = Math.max(...values),
    span = Math.max(max - min, 0.01);
  const points = values
    .map(
      (v, i) =>
        `${20 + (i / Math.max(1, values.length - 1)) * 920},${160 - ((v - min) / span) * 130}`,
    )
    .join(" ");
  return `<figure><figcaption>${escapeHtml(title)} · mínimo ${min.toFixed(2)} / máximo ${max.toFixed(2)}</figcaption><svg viewBox="0 0 960 180" role="img" aria-label="${escapeHtml(title)}"><path d="M20 160H940" stroke="#657080"/><polyline fill="none" stroke="#83b7ff" stroke-width="3" points="${points}"/></svg></figure>`;
}
export function reportHtml(result: BacktestResult): string {
  const main = result.trials.find(
    (t) => t.label === "Riesgo mejorado" && t.period === "evaluación",
  )!;
  const rows = result.trials
    .map(
      (t) =>
        `<tr><th scope="row">${escapeHtml(t.label)}</th><td>${t.period}</td><td>${usd(t.metrics.netPnl)}</td><td>${usd(t.fees + t.gas)}</td><td>${(Math.max(...t.equity.map((e) => e.drawdown)) * 100).toFixed(2)}%</td><td>${t.fills.length}</td><td>${t.failures}</td><td>${t.bootstrap95.map(usd).join(" a ")}</td></tr>`,
    )
    .join("");
  return `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><title>Botpoly · Backtest ${escapeHtml(result.id)}</title><style>
  :root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#0f0f17;color:#eeeef5;font:16px/1.6 system-ui,sans-serif}main{max-width:1200px;margin:auto;padding:32px 20px}h1{font-size:32px}h2{font-size:23px;margin-top:40px}p,li{max-width:90ch}.muted{color:#b6b6c8}.notice{border-left:4px solid #e6b86c;padding:12px 20px;background:#24202a}.metrics{display:flex;flex-wrap:wrap;gap:32px;margin:32px 0}.metrics strong{display:block;font-size:25px;color:#a3c5ff}figure{margin:24px 0;background:#191923;padding:16px}svg{width:100%;height:auto}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:14px}td,th{padding:12px;text-align:left;border-bottom:1px solid #353545}th{font-weight:600}code{overflow-wrap:anywhere}a{color:#a3c5ff}details{padding:12px 0}summary{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere}footer{margin-top:48px;color:#b6b6c8}@media print{body{background:white;color:black}figure,.notice{background:#eee}strong,a{color:#234!important}td,th{border-color:#aaa}}
  </style><main><p class="muted">BOTPOLY / INVESTIGACIÓN REPRODUCIBLE</p><h1>Arbitraje YES / NO</h1><p class="notice"><strong>Resultado ${result.status}.</strong> No demuestra rentabilidad ni autoriza operaciones reales. Datos: ${escapeHtml(result.manifest.kind)}.</p>
  <p>${escapeHtml(new Date(result.options.from).toISOString())} → ${escapeHtml(new Date(result.options.to).toISOString())}<br>Corte fuera de muestra: ${escapeHtml(new Date(result.options.split).toISOString())}</p>
  <div class="metrics"><div>PnL neto de evaluación<strong>${usd(main.metrics.netPnl)}</strong></div><div>Costes<strong>${usd(main.fees + main.gas)}</strong></div><div>Capital final<strong>${usd(main.metrics.equity)}</strong></div><div>Mantener efectivo<strong>${usd(result.cash.capital)}</strong></div></div>
  ${chart(
    main.equity.map((e) => e.equity),
    "Curva de capital · evaluación",
  )}${chart(
    main.equity.map((e) => e.drawdown * 100),
    "Drawdown (%)",
  )}${chart(
    main.equity.map((e) => e.exposure),
    "Exposición con reservas (US$)",
  )}
  <h2>Comparación y sensibilidad</h2><div class="scroll"><table><thead><tr><th>Configuración</th><th>Periodo</th><th>PnL neto</th><th>Costes</th><th>Drawdown máx.</th><th>Fills</th><th>Fallos / paradas</th><th>Intervalo 95% por bloques</th></tr></thead><tbody>${rows}</tbody></table></div>
  <h2>Ejecuciones y rechazos</h2><div class="scroll"><table><thead><tr><th>Hora UTC</th><th>Tipo</th><th>Resultado</th></tr></thead><tbody>${main.events.map((e) => `<tr><td>${new Date(e.timestamp).toISOString()}</td><td>${escapeHtml(e.type)}</td><td>${escapeHtml(e.message)}</td></tr>`).join("") || '<tr><td colspan="3">Sin ejecuciones ni señales</td></tr>'}</tbody></table></div>
  <h2>Procedencia y limitaciones</h2><p>Fuente: ${escapeHtml(result.manifest.source)}<br>Licencia: ${escapeHtml(result.manifest.license)}<br>Checksum SHA-256: <code>${escapeHtml(result.manifest.sha256)}</code><br>Cobertura: ${result.manifest.coverage.frames} observaciones; separación máxima ${result.manifest.coverage.maxGapMs} ms.</p><ul>${result.limitations.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>
  <details><summary>Configuración completa de todos los ensayos</summary><pre>${escapeHtml(JSON.stringify({ options: result.options, trials: result.trials.map((t) => ({ id: t.id, label: t.label, period: t.period, config: t.config, simulation: t.simulation })) }, null, 2))}</pre></details>
  <footer>Informe autónomo · funciona sin internet · ID ${result.id} · semilla ${result.options.seed}. JSON y CSV acompañan este archivo.</footer></main></html>`;
}
export function writeReport(directory: string, result: BacktestResult): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(resolve(directory, "report.html"), reportHtml(result), {
    mode: 0o600,
  });
  writeFileSync(
    resolve(directory, "result.json"),
    JSON.stringify(result, null, 2) + "\n",
    { mode: 0o600 },
  );
  const rows: unknown[][] = [
    [
      "trial",
      "period",
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
  ];
  for (const t of result.trials)
    for (const f of t.fills) {
      const o = t.orders.find((o) => o.id === f.orderId)!;
      rows.push([
        t.id,
        t.period,
        f.id,
        o.id,
        o.marketId,
        o.side,
        o.outcome,
        f.quantity,
        f.gross,
        f.fees,
        new Date(f.timestamp).toISOString(),
      ]);
    }
  writeFileSync(
    resolve(directory, "trades.csv"),
    rows.map((row) => row.map(csvCell).join(",")).join("\n") + "\n",
    { mode: 0o600 },
  );
}
