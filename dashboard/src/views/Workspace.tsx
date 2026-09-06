import { type FormEvent } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import type { Snapshot } from "../hooks/useBot";
import type { RiskConfig } from "../../../src/engine/model";
const usd = (n: number) =>
  new Intl.NumberFormat("es", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(n);
const date = (n: number) =>
  new Date(n).toLocaleString("es", { timeZone: "UTC" });
const states: Record<string, string> = {
  reserved: "Reservada",
  submitted: "Enviada",
  uncertain: "Por conciliar",
  filled: "Ejecutada",
  rejected: "Rechazada",
  cancelled: "Cancelada",
};
function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="empty" role="status">
      {children}
    </p>
  );
}
export function Overview({ data }: { data: Snapshot }) {
  const m = data.metrics,
    a = data.account;
  const counts: Record<string, number> = {};
  for (const day of data.statistics ?? [])
    for (const [key, n] of Object.entries(day.counts))
      counts[key] = (counts[key] ?? 0) + n;
  const coverage=data.observation?.coverage;
  const uptime=Math.max(0,Date.now()-(data.runtime?.startedAt ?? Date.now()));
  return (
    <>
      <section className="panel" aria-label="Estado de estrategias">
        <h2>Cobertura y funcionamiento</h2>
        <p>Tiempo ejecutándose: {Math.floor(uptime/3600000)} h {Math.floor(uptime/60000)%60} min · Última evaluación: {data.runtime?.lastEvaluationAt ? date(data.runtime.lastEvaluationAt) + " UTC" : "Pendiente"}</p>
        <dl className="risk-facts">
          <div><dt>Arbitraje YES/NO</dt><dd>{Math.max(0,(coverage?.selected ?? 0)-(coverage?.football ?? 0))} mercados</dd></div>
          <div><dt>Fútbol · 90 minutos</dt><dd>{coverage?.football ?? 0} mercados · {coverage?.forecast ?? 0} con pronóstico</dd></div>
          <div><dt>Descubrimiento</dt><dd>{coverage?.inspected ?? 0} inspeccionados · cada 5 min</dd></div>
          <div><dt>Posiciones conservadas</dt><dd>{coverage?.retained ?? 0} mercados adicionales</dd></div>
        </dl>
        <p className="muted">Compras al precio disponible con profundidad. Una apuesta por partido, máximo 1% por partido y 10% agregado en fútbol. Sin Mundial ni apuestas durante el juego.</p>
        {data.football && <details><summary>Fuentes y disponibilidad de fútbol</summary><ul>{Object.entries(data.football.leagues).map(([league,status])=><li key={league}>{({epl:"Premier League",lal:"LaLiga",bun:"Bundesliga",sea:"Serie A",fl1:"Ligue 1",mex:"Liga MX"} as Record<string,string>)[league] ?? league}: {status}</li>)}</ul></details>}
        {data.footballEvidence && <p><a href={`/reports/${encodeURIComponent(data.footballEvidence.report)}/report.html`}>Evaluación cronológica del modelo de fútbol</a> · calidad predictiva, sin PnL ni prueba de ejecución.</p>}
        <p className="muted">Libros en tiempo real: {data.observation?.feed?.connected ? "conectados" : "pendientes de conexión"} · {data.observation?.feed?.invalid ?? 0} invalidaciones · {data.observation?.feed?.coalesced ?? 0} cambios agrupados. Se conserva el último libro completo; el archivo contiene muestras.</p>
      </section>
      {data.mode === "paper" && data.observation && (
        <section className="panel" aria-label="Seguimiento de simulación">
          <h2>Seguimiento paper</h2>
          <p>
            {data.observation.markets} mercados compatibles ·{" "}
            {counts.evaluated ?? 0} libros evaluados · {counts.accepted ?? 0}{" "}
            reservas autorizadas · {data.observation.recorded} libros archivados.
          </p>
          <p>Actividad acumulada: {counts.signals ?? 0} señales · {counts.buys ?? 0} compras · {counts.sells ?? 0} ventas · {counts.settled ?? 0} liquidaciones.</p>
          <p className="muted">
            Gas modelado: {data.observation.gasUnits.toLocaleString("es")}{" "}
            unidades supuestas × precios actuales ×{" "}
            {data.observation.gasMultiplier}.{" "}
            {data.observation.gasUsd !== undefined
              ? `Última estimación: US$${data.observation.gasUsd.toFixed(4)} por fusión.`
              : "Esperando precios verificables del gas."}{" "}
            Resultados simulados; no son ejecuciones reales.
          </p>
          {Object.entries(counts).filter(([key]) => key.startsWith("rejected:"))
            .length > 0 && (
            <ul>
              {Object.entries(counts)
                .filter(([key]) => key.startsWith("rejected:"))
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([key, n]) => (
                  <li key={key}>
                    {key.slice(9)}: {n}
                  </li>
                ))}
            </ul>
          )}
          <p>
            <a href="/reports/paper-actual/report.html">
              Abrir informe de seguimiento
            </a>{" "}
            · se actualiza cada 5 minutos.
          </p>
        </section>
      )}
      <section className="capital-strip" aria-label="Capital">
        <div className="capital-main">
          <span>Capital neto</span>
          <strong>{usd(m.equity)}</strong>
          <small>Presupuesto operativo: {usd(data.config.capitalUsd)}</small>
        </div>
        <div>
          <span>Disponible</span>
          <strong>{usd(m.available)}</strong>
          <small>Después de reservas</small>
        </div>
        <div>
          <span>Reservado</span>
          <strong>{usd(m.reserved)}</strong>
          <small>Órdenes y costes de liquidación</small>
        </div>
      </section>
      <section className="metrics-grid" aria-label="Resultados">
        <div>
          <span>PnL realizado</span>
          <strong>{usd(a.realized)}</strong>
        </div>
        <div>
          <span>PnL no realizado</span>
          <strong>{usd(m.unrealized)}</strong>
        </div>
        <div>
          <span>Comisiones + gas</span>
          <strong>{usd(a.fees + a.gas)}</strong>
        </div>
        <div>
          <span>Drawdown</span>
          <strong>{(m.drawdown * 100).toFixed(2)}%</strong>
        </div>
      </section>
      <section className="panel">
        <div className="section-heading">
          <h2>Evolución del capital</h2>
          <span className="muted">USD · UTC</span>
        </div>
        {data.equity.length > 1 ? (
          <div
            className="chart"
            role="img"
            aria-label="Curva histórica de capital neto"
          >
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data.equity}>
                <CartesianGrid stroke="var(--border-color)" vertical={false} />
                <XAxis
                  dataKey="timestamp"
                  tickFormatter={(t) =>
                    new Date(t).toLocaleTimeString("es", { timeZone: "UTC" })
                  }
                  minTickGap={80}
                  stroke="var(--text-secondary)"
                />
                <YAxis
                  domain={["auto", "auto"]}
                  width={65}
                  stroke="var(--text-secondary)"
                />
                <Tooltip
                  labelFormatter={(t) => date(Number(t))}
                  formatter={(n: number) => [usd(n), "Capital"]}
                  contentStyle={{
                    background: "var(--bg-card)",
                    border: "1px solid var(--border-color)",
                  }}
                />
                <Line
                  dataKey="equity"
                  type="linear"
                  stroke="var(--accent-blue)"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <Empty>
            La curva aparecerá cuando se registren observaciones del mercado.
          </Empty>
        )}
      </section>
      <section className="panel">
        <h2>Actividad reciente</h2>
        {data.events.length ? (
          <ol className="activity">
            {data.events.slice(0, 20).map((e) => (
              <li key={e.id}>
                <time>{date(e.timestamp)}</time>
                <span
                  className={
                    "event-kind " +
                    (e.type === "rejected" || e.type === "stop" ? "warn" : "")
                  }
                >
                  {(
                    {
                      signal: "Señal",
                      settled: "Liquidación",
                      markets: "Mercados",
                      rejected: "Omitida",
                      fill: "Ejecución",
                      stop: "Parada",
                      error: "Error",
                      config: "Límites",
                      control: "Control",
                      reserved: "Reserva",
                      merge: "Fusión",
                      recovery: "Salida",
                      execution_failed: "Fallo",
                    } as Record<string, string>
                  )[e.type] ?? e.type}
                </span>
                <p>{e.message}</p>
              </li>
            ))}
          </ol>
        ) : (
          <Empty>
            No hay actividad en este periodo. Las oportunidades omitidas también
            se registran.
          </Empty>
        )}
      </section>
    </>
  );
}
export function Orders({ data }: { data: Snapshot }) {
  return (
    <section className="panel">
      <h2>Historial de órdenes</h2>
      <p className="muted">
        Límite de precio por pata. Una orden enviada puede seguir pendiente de
        confirmación.
      </p>
      {!data.orders.length ? (
        <Empty>Sin órdenes para estos filtros.</Empty>
      ) : (
        <div className="table-scroll" tabIndex={0} aria-label="Tabla desplazable">
          <table>
            <thead>
              <tr>
                <th>Hora UTC</th>
                <th>Mercado</th>
                <th>Operación</th>
                <th>Cantidad</th>
                <th>Precio límite</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {data.orders.map((o) => (
                <tr key={o.id}>
                  <td>{date(o.timestamp)}</td>
                  <td className="identifier" title={o.marketId}>
                    {o.title ?? o.marketId}
                    <small>{o.strategy === "football-value" ? "Fútbol" : "Arbitraje YES/NO"}</small>
                  </td>
                  <td>
                    {o.side === "BUY" ? "Compra" : "Venta"} {o.outcome}
                  </td>
                  <td>{o.quantity}</td>
                  <td>{usd(o.limit)}</td>
                  <td>
                    <span className="pill">{states[o.status]}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
export function Positions({ data }: { data: Snapshot }) {
  return (
    <section className="panel">
      <h2>Posiciones abiertas</h2>
      <p className="muted">
        Valoradas con profundidad de salida. Si los datos caducan se conserva la última valoración y se bloquean nuevas entradas. Un libro verificado sin liquidez tiene valor de salida cero.
      </p>
      {!data.positions.length ? (
        <Empty>
          Sin posiciones abiertas. El capital permanece disponible hasta
          encontrar una operación admisible.
        </Empty>
      ) : (
        <div className="table-scroll" tabIndex={0} aria-label="Tabla desplazable">
          <table>
            <thead>
              <tr>
                <th>Mercado</th>
                <th>Resultado</th>
                <th>Cantidad</th>
                <th>Coste medio</th>
                <th>Coste total</th>
                <th>Valor de salida</th>
                <th>PnL abierto</th>
                <th>Estrategia y salida</th>
                <th>Antigüedad</th>
              </tr>
            </thead>
            <tbody>
              {data.positions.map((p) => (
                <tr key={p.tokenId}>
                  <td className="identifier" title={p.marketId}>
                    {p.title ?? p.marketId}
                    {p.football && <small>{p.football.home} — {p.football.away}</small>}
                  </td>
                  <td>{p.outcome}</td>
                  <td>{p.quantity}</td>
                  <td>{usd(p.cost / p.quantity)}</td>
                  <td>{usd(p.cost)}</td>
                  <td>{usd(p.mark)}</td>
                  <td>{usd(p.mark - p.cost)}</td>
                  <td>{p.strategy === "football-value" ? "Fútbol · +10% neto o resolución oficial" : "YES/NO · fusión o recuperación"}</td>
                  <td>{Math.max(0,Math.floor((Date.now()-p.timestamp)/1000))} s · {p.stale ? "Obsoleta" : "Verificada"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
const fields: {
  key: keyof RiskConfig;
  label: string;
  percent?: boolean;
  min: number;
  max: number;
  step: string;
}[] = [
  {
    key: "capitalUsd",
    label: "Capital operativo (USD)",
    min: 50,
    max: 1e9,
    step: ".01",
  },
  {
    key: "dailyLossPct",
    label: "Pérdida diaria (%)",
    percent: true,
    min: 0.01,
    max: 100,
    step: ".01",
  },
  {
    key: "maxDrawdownPct",
    label: "Parada por drawdown (%)",
    percent: true,
    min: 0.01,
    max: 100,
    step: ".01",
  },
  {
    key: "eventExposurePct",
    label: "Exposición por evento (%)",
    percent: true,
    min: 0.01,
    max: 100,
    step: ".01",
  },
  {
    key: "totalExposurePct",
    label: "Exposición total (%)",
    percent: true,
    min: 0.01,
    max: 100,
    step: ".01",
  },
  {
    key: "unhedgedLossPct",
    label: "Riesgo de una pata (%)",
    percent: true,
    min: 0.01,
    max: 100,
    step: ".01",
  },
  {
    key: "minNetProfitUsd",
    label: "Margen neto mínimo (USD)",
    min: 0,
    max: 10000,
    step: ".01",
  },
  {
    key: "maxCostUsd",
    label: "Costes máximos por par (USD)",
    min: 0.01,
    max: 10000,
    step: ".01",
  },
];
export function Risk({
  data,
  busy,
  onSave,
}: {
  data: Snapshot;
  busy: boolean;
  onSave: (config: RiskConfig) => Promise<void>;
}) {
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fd = new FormData(event.currentTarget),
      cfg = { ...data.config };
    for (const f of fields)
      cfg[f.key] = Number(fd.get(f.key)) / (f.percent ? 100 : 1);
    await onSave(cfg);
  };
  return (
    <>
      <section className="panel">
        <h2>Límites de riesgo</h2>
        <p className="muted">
          Cambiar el presupuesto modifica el tamaño permitido. El saldo, las
          pérdidas y el historial permanecen contabilizados.
        </p>
        <form
          className="risk-form"
          key={JSON.stringify(data.config)}
          onSubmit={submit}
        >
          {fields.map((f) => (
            <label key={f.key} htmlFor={f.key}>
              {f.label}
              <input
                id={f.key}
                name={f.key}
                type="number"
                defaultValue={Number(
                  (data.config[f.key] * (f.percent ? 100 : 1)).toFixed(4),
                )}
                min={f.min}
                max={f.max}
                step={f.step}
                required
              />
            </label>
          ))}
          <div className="form-submit">
            <button className="primary" disabled={busy}>
              Guardar límites
            </button>
            <span>Los cambios quedan registrados.</span>
          </div>
        </form>
      </section>
      <section className="panel">
        <h2>Controles activos</h2>
        <dl className="risk-facts">
          <div>
            <dt>Exposición con reservas</dt>
            <dd>{usd(data.metrics.exposure)}</dd>
          </div>
          <div>
            <dt>Factor de tamaño por drawdown</dt>
            <dd>{(data.metrics.sizeFactor * 100).toFixed(0)}%</dd>
          </div>
          <div>
            <dt>Antigüedad máxima de datos</dt>
            <dd>{data.config.maxDataAgeMs / 1000} s</dd>
          </div>
          <div>
            <dt>PnL del día UTC</dt>
            <dd>{usd(data.metrics.dailyPnl)}</dd>
          </div>
        </dl>
        <p className="muted">
          Estos límites son controles operativos; no garantizan una pérdida
          máxima.
        </p>
      </section>
      <section className="panel">
        <h2>Estrategias experimentales</h2>
        <p>{data.experimental.join(" · ")}</p>
        <span className="pill">Desactivadas</span>
      </section>
    </>
  );
}
export function Backtests({ data }: { data: Snapshot }) {
  return (
    <section className="panel">
      <h2>Informes reproducibles</h2>
      <p className="muted">
        Cada informe incluye costes, comparación con efectivo, sensibilidad y
        limitaciones. Los resultados exploratorios no habilitan operaciones
        reales.
      </p>
      {!data.reports.length ? (
        <Empty>
          Aún no hay backtests registrados. Los informes aparecerán cuando
          finalice una evaluación.
        </Empty>
      ) : (
        <ul className="report-list">
          {data.reports.map((r) => (
            <li key={r.id}>
              <div>
                <h3>{r.label}</h3>
                <p>
                  {date(r.timestamp)} · {r.status} ·{" "}
                  {r.label === "Seguimiento paper"
                    ? "PnL acumulado"
                    : "PnL de evaluación"}
                  : {usd(r.netPnl)}
                </p>
              </div>
              <div className="actions">
                <a href={`/reports/${encodeURIComponent(r.id)}/report.html`}>
                  Informe HTML
                </a>
                <a href={`/reports/${encodeURIComponent(r.id)}/trades.csv`}>
                  CSV
                </a>
                <a href={`/reports/${encodeURIComponent(r.id)}/result.json`}>
                  JSON
                </a>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
