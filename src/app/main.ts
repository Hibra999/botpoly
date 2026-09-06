import { Store } from "../engine/store.js";
import { Ledger } from "../engine/ledger.js";
import { Engine } from "../engine/engine.js";
import { PaperExecutor, simulationDefaults } from "../engine/paper.js";
import type { Executor, Frame } from "../engine/model.js";
import type { LiveExecutor } from "../engine/live.js";
import { MarketData } from "../research/market-data.js";
import { Controller } from "./control.js";
import { Telegram } from "./telegram.js";
import { loadConfig, authorizeLive } from "./config.js";
import { startDashboard, stopDashboard } from "../dashboard/server.js";
import { PaperGas } from "../research/paper-gas.js";
import { writePaperReport } from "../research/paper-report.js";
import { statfsSync } from "node:fs";
import { dirname, resolve } from "node:path";

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
  const runtime = { startedAt: Date.now(), experimentStartedAt: store.get<{ experimentStartedAt: number }>("meta", "runtime")?.experimentStartedAt ?? Date.now(), version: "botpoly-v2", lastEvaluationAt: 0 };
  store.put("meta", "runtime", runtime);
  let live: LiveExecutor | undefined, data: MarketData, executor: Executor;
  if (approval) {
    const { LiveExecutor } = await import("../engine/live.js");
    live = await LiveExecutor.create(ledger, approval.key, approval.rpc);
    data = new MarketData((market) => live!.estimateGas(market));
    executor = live;
  } else {
    const gas = new PaperGas(config.gasUnits, config.gasMultiplier);
    data = new MarketData(() => gas.quote());
    executor = new PaperExecutor(
      "paper",
      async (conditionId, time) => {
        const market = markets.find((m) => m.conditionId === conditionId);
        if (!market) return undefined;
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(0, time - Date.now())),
        );
        const frame = await data.frame(market);
        store.recordBook(frame);
        observation.recorded++;
        return frame;
      },
      Date.now,
      simulationDefaults,
      ledger.config.maxDataAgeMs,
      store,
    );
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
  let refreshedAt = 0,
    equityAt = 0,
    reportAt = 0,
    diskAt = 0;
  let diskAvailable = true;
  const recordedAt = new Map<string, number>();
  const observation = {
    markets: 0,
    refreshedAt: 0,
    recorded:
      store.get<{ recorded: number }>("meta", "paper:observation")?.recorded ??
      0,
    gasUnits: config.gasUnits,
    gasMultiplier: config.gasMultiplier,
    gasUsd: undefined as number | undefined,
    gasAt: undefined as number | undefined,
  };
  try {
    while (!stopping) {
      try {
        if (config.mode === "paper" && Date.now() - diskAt > 60000) {
          const disk = statfsSync(dirname(config.database));
          diskAt = Date.now();
          diskAvailable = disk.bavail * disk.bsize >= 512 * 1024 * 1024;
          if (!diskAvailable) {
            ledger.stop(
              "Espacio en disco insuficiente para conservar resultados",
            );
          }
        }
        if (!diskAvailable)
          throw new Error("Archivo de libros bloqueado por falta de espacio");
        if (!markets.length || Date.now() - refreshedAt >= 15 * 60000) {
          const selected = await data.markets(config.markets);
          if (!selected.length) throw new Error("Sin mercados compatibles");
          const held = new Set(ledger.positions.map((p) => p.marketId));
          markets = [
            ...selected,
            ...markets.filter(
              (m) =>
                held.has(m.conditionId!) &&
                !selected.some((s) => s.conditionId === m.conditionId),
            ),
          ];
          refreshedAt = Date.now();
          recordedAt.clear();
          observation.markets = markets.length;
          observation.refreshedAt = refreshedAt;
          ledger.event(
            "markets",
            `${markets.length} mercados binarios estándar seleccionados`,
          );
        }
        let successful = 0;
        for (const market of markets) {
          if (stopping) break;
          let frame: Frame;
          try {
            frame = await data.frame(market);
          } catch {
            ledger.count("fetch_failed");
            continue;
          }
          if (config.mode === "paper") {
            if (Date.now() - (recordedAt.get(frame.marketId) ?? 0) >= 10000) {
              store.recordBook(frame);
              recordedAt.set(frame.marketId, Date.now());
              observation.recorded++;
            }
            if (frame.paperGas) {
              observation.gasUsd = frame.mergeGasUsd;
              observation.gasAt = frame.paperGas.timestamp;
            }
            store.put("meta", "paper:observation", observation);
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
          runtime.lastEvaluationAt = Date.now();
          store.put("meta", "runtime", runtime);
          ledger.mark(frame);
          if (Date.now() - equityAt >= 60000) {
            engine.recordEquity();
            equityAt = Date.now();
          }
        }
        if (!successful) throw new Error();
        if (config.mode === "paper" && Date.now() - reportAt >= 300000) {
          writePaperReport(ledger, resolve(config.reports, "paper-actual"));
          reportAt = Date.now();
        }
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
    if (config.mode === "paper") {
      try {
        writePaperReport(ledger, resolve(config.reports, "paper-actual"));
      } catch {
        console.error("No se pudo actualizar el informe paper al cerrar");
      }
    }
    await stopDashboard();
    await telegramLoop;
    await live?.close();
    store.close();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
