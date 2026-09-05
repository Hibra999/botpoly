import { Store } from "../engine/store.js";
import { Ledger } from "../engine/ledger.js";
import { Engine } from "../engine/engine.js";
import { PaperExecutor } from "../engine/paper.js";
import type { Executor, Frame } from "../engine/model.js";
import type { LiveExecutor } from "../engine/live.js";
import { MarketData } from "../research/market-data.js";
import { Controller } from "./control.js";
import { Telegram } from "./telegram.js";
import { loadConfig, authorizeLive } from "./config.js";
import { startDashboard, stopDashboard } from "../dashboard/server.js";

export async function main(): Promise<void> {
  if (Number(process.versions.node.split(".")[0]) !== 24)
    throw new Error("Se requiere Node 24 LTS");
  process.umask(0o077);
  const config = loadConfig();
  if (config.mode === "backtest")
    throw new Error("Usa pnpm backtest con periodo y datos explícitos");
  // Validate live gates before creating any client capable of signing.
  const approval = config.mode === "live" ? authorizeLive() : undefined;
  const store = new Store(config.database),
    ledger = new Ledger(store, config.mode, config.risk);
  let live: LiveExecutor | undefined, data: MarketData, executor: Executor;
  if (approval) {
    const { LiveExecutor } = await import("../engine/live.js");
    live = await LiveExecutor.create(ledger, approval.key, approval.rpc);
    data = new MarketData((market) => live!.estimateGas(market));
    executor = live;
  } else {
    data = new MarketData();
    executor = new PaperExecutor("paper", async (conditionId, time) => {
      const market = markets.find((m) => m.conditionId === conditionId);
      if (!market) return undefined;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, time - Date.now())),
      );
      return data.frame(market);
    });
  }
  const engine = new Engine(ledger, executor),
    controller = new Controller(engine);
  let markets: Awaited<ReturnType<MarketData["markets"]>> = [],
    stopping = false;
  // Persisted positions from a lost market feed must not be treated as healthy.
  engine.health(false);
  await engine.reconcile();
  if (live) {
    try {
      await live.checkBalances();
      await live.heartbeat();
    } catch {
      ledger.stop("Conciliación live incompleta");
    }
  }
  await startDashboard(controller, {
    passwordHash: config.passwordHash,
    port: config.port,
    origin: config.origin,
    reports: config.reports,
  });
  console.log(`Botpoly · ${config.mode} · http://127.0.0.1:${config.port}`);
  const telegram =
    config.telegramToken && config.telegramChat
      ? new Telegram(controller, config.telegramToken, config.telegramChat)
      : undefined;
  const telegramLoop = telegram?.run();
  let heartbeatBusy = false;
  const heartbeat = live
    ? setInterval(async () => {
        if (heartbeatBusy || stopping) return;
        heartbeatBusy = true;
        try {
          await live!.heartbeat();
        } catch {
          engine.health(false);
        } finally {
          heartbeatBusy = false;
        }
      }, 3000)
    : undefined;
  const stop = () => {
    stopping = true;
    telegram?.stop();
    if (heartbeat) clearInterval(heartbeat);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let wasConnected = false;
  try {
    while (!stopping) {
      try {
        if (!markets.length) markets = await data.markets(config.markets);
        let successful = 0;
        for (const market of markets) {
          if (stopping) break;
          let frame: Frame;
          try {
            frame = await data.frame(market);
          } catch {
            continue;
          }
          if (!wasConnected) {
            await engine.reconcile();
            if (live) await live.checkBalances();
          }
          successful++;
          wasConnected = true;
          engine.health(true);
          const a = ledger.account;
          a.lastDataAt = frame.timestamp;
          ledger.save(a);
          await engine.process(frame);
          ledger.mark(frame);
          engine.recordEquity();
        }
        if (!successful) throw new Error();
      } catch {
        wasConnected = false;
        engine.health(false);
        ledger.event(
          "error",
          "No se pudieron verificar datos o saldos; entradas bloqueadas",
        );
      }
      if (!stopping)
        await new Promise((resolve) => setTimeout(resolve, config.interval));
    }
  } finally {
    stop();
    ledger.stop("Proceso detenido; requiere reanudación autorizada");
    await engine.cancelOrders();
    await stopDashboard();
    await telegramLoop;
    await live?.close();
    store.close();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
