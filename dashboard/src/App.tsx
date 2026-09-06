import { useState } from "react";
import { useBot } from "./hooks/useBot";
import { Login } from "./views/Login";
import {
  Overview,
  Orders,
  Positions,
  Risk,
  Backtests,
} from "./views/Workspace";

type Page = "Resumen" | "Órdenes" | "Posiciones" | "Riesgo" | "Backtests";
const pages: Page[] = [
  "Resumen",
  "Órdenes",
  "Posiciones",
  "Riesgo",
  "Backtests",
];
export default function App() {
  const bot = useBot();
  const [page, setPage] = useState<Page>("Resumen");
  const [period, setPeriod] = useState("all");
  const [mode, setMode] = useState("all");
  const [strategy, setStrategy] = useState("all");
  if (bot.auth === "login") return <Login onLogin={bot.login} />;
  if (!bot.data)
    return (
      <main className="loading" aria-busy="true">
        <span className="brand">BOTPOLY</span>
        <h1>Conectando con tu bot</h1>
        <p role="status">{bot.message || "Cargando el estado de la sesión…"}</p>
        <button onClick={bot.retry}>Reintentar</button>
      </main>
    );
  const data = bot.data;
  const since =
    period === "day"
      ? Date.now() - 86400000
      : period === "week"
        ? Date.now() - 7 * 86400000
        : 0;
  const visible = (row: {
    timestamp: number;
    mode?: string;
    strategy?: string;
  }) =>
    row.timestamp >= since &&
    (mode === "all" || row.mode === mode) &&
    (strategy === "all" || row.strategy === strategy);
  const filtered = {
    ...data,
    orders: data.orders.filter(visible),
    events: data.events.filter(visible),
    equity: data.equity.filter((e) => e.timestamp >= since),
  };
  return (
    <div className="workspace">
      <aside className="sidebar">
        <a className="brand" href="#main">
          BOTPOLY<span>Control de operaciones</span>
        </a>
        <nav aria-label="Secciones">
          {pages.map((p) => (
            <button
              key={p}
              aria-current={page === p ? "page" : undefined}
              onClick={() => setPage(p)}
            >
              {p}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <span className="mode-tag">
            {data.mode === "paper" ? "SIMULACIÓN" : data.mode.toUpperCase()}
          </span>
          <p>
            Arbitraje YES/NO y fútbol
            <br />
            Riesgo compartido
          </p>
        </div>
        <button className="logout" onClick={bot.logout}>
          Cerrar sesión
        </button>
      </aside>
      <main id="main" className="main-content">
        <header className="page-header">
          <div>
            <p className="eyebrow">CENTRO DE CONTROL</p>
            <h1>{page}</h1>
          </div>
          <div className="connection">
            <span
              className={bot.connected ? "status-dot good" : "status-dot"}
            />
            {bot.connected ? "Dashboard conectado" : "Reconectando…"}
            <small>
              Mercado: {data.account.connected ? "conectado" : "sin conexión"}
            </small>
          </div>
        </header>
        <section
          className={"state-banner " + (data.account.stop ? "warning" : "")}
          aria-label="Estado del bot"
        >
          <div>
            <strong>
              {data.account.stop ? "Entradas pausadas" : "Bot en observación"}
            </strong>
            <p>
              {data.account.stop ??
                "Cada entrada debe superar los controles de riesgo, liquidez y costes."}
            </p>
          </div>
          <div className="actions">
            <button
              disabled={!bot.connected || bot.busy}
              onClick={() => bot.command("pause")}
            >
              Pausar
            </button>
            <button
              disabled={!bot.connected || bot.busy || !data.account.stop}
              onClick={() => bot.command("resume")}
            >
              Reanudar
            </button>
            <button
              className="quiet"
              disabled={!bot.connected || bot.busy}
              onClick={() => bot.command("cancel_orders")}
            >
              Cancelar órdenes
            </button>
          </div>
        </section>
        <p
          role="status"
          className={"command-result " + (bot.failed ? "error-text" : "")}
        >
          {bot.busy ? "Aplicando comando…" : bot.message}
        </p>
        <div className="filters" aria-label="Filtros de actividad">
          <label>
            Periodo
            <select value={period} onChange={(e) => setPeriod(e.target.value)}>
              <option value="all">Todo el periodo disponible</option>
              <option value="day">Últimas 24 horas</option>
              <option value="week">Últimos 7 días</option>
            </select>
          </label>
          <label>
            Modo
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="all">Todos</option>
              <option value="paper">Simulación</option>
              <option value="backtest">Backtest</option>
              <option value="live">Live</option>
            </select>
          </label>
          <label>
            Estrategia
            <select
              value={strategy}
              onChange={(e) => setStrategy(e.target.value)}
            >
              <option value="all">Todas</option>
              <option value="yes-no">Arbitraje YES / NO</option>
              <option value="football-value">Fútbol automático</option>
            </select>
          </label>
        </div>
        {page === "Resumen" && <Overview data={filtered} />}
        {page === "Órdenes" && <Orders data={filtered} />}
        {page === "Posiciones" && <Positions data={data} />}
        {page === "Riesgo" && (
          <Risk
            data={data}
            busy={bot.busy || !bot.connected}
            onSave={(payload) => bot.command("set_config", payload)}
          />
        )}
        {page === "Backtests" && <Backtests data={data} />}
        <footer className="page-footer">
          {data.mode === "paper"
            ? "Simulación sin fondos reales."
            : "Consulta el modo activo antes de operar."}{" "}
          Las métricas de capital y riesgo abarcan toda la sesión; los filtros
          se aplican a las últimas 500 órdenes, 200 eventos y 1.000
          observaciones.
        </footer>
      </main>
    </div>
  );
}
