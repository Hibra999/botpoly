import {ObservedSizing,sizingPolicy} from "../engine/sizing.js";
import { Store } from "../engine/store.js";
import { Ledger } from "../engine/ledger.js";
import { Engine } from "../engine/engine.js";
import { PaperExecutor, simulationDefaults } from "../engine/paper.js";
import { bookTime, freshBook, type Executor, type Frame, type Reservation } from "../engine/model.js";
import type { LiveExecutor } from "../engine/live.js";
import { MarketData, retainMarkets, marketsToEvaluate, type ProcessingStats } from "../research/market-data.js";
import { Controller } from "./control.js";
import { Telegram } from "./telegram.js";
import { loadConfig, authorizeLive } from "./config.js";
import { PaperGas } from "../research/paper-gas.js";
import { statfsSync } from "node:fs";
import { dirname } from "node:path";

export async function main(): Promise<void> {
  if (process.versions.node !== "24.20.0")
    throw new Error("Se requiere Node 24.20.0");
  process.umask(0o077);
  const config = loadConfig();
  if (config.mode === "backtest")
    throw new Error("Usa pnpm backtest con periodo y datos explícitos");
  // Validate live gates before creating any client capable of signing.
  const store = new Store(config.database),
    ledger = new Ledger(store, config.mode, config.risk);
  const sizing=new ObservedSizing(store);
  if (config.mode === "paper" && store.get("meta","sizing:policy") !== sizingPolicy.version) store.transaction(()=>{store.put("meta","sizing:policy",sizingPolicy.version);ledger.event("migration",`Política experimental paper ${sizingPolicy.version}; historia ausente bloquea entradas y no altera pérdidas/parada`);});
  const approval = config.mode === "live" ? authorizeLive(process.env, ledger.config) : undefined;
  if (approval) store.put("meta", "live:strategies", approval.strategies);
  const runtime = ledger.startRuntime("botpoly-v5-headless");
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
          setTimeout(resolve, Math.max(0, time - Date.now()) + Number(market.trading.secondsDelay ?? 0) * 1000),
        );
        const frame = await data.frame(market);
        sizing.midpoint(frame);frame.sizing=sizing.evidence(frame.marketId,frame.timestamp);
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
  data.stream.onConnectionChange=connected=>{if (!connected) engine.health(false);};
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
  console.log(`Botpoly · ${config.mode} · control por Telegram`);
  const telegram = new Telegram(controller, config.telegramToken, config.telegramChat);
  telegram.enqueue(`deployment:${runtime.startedAt}`, `Despliegue ${config.mode.toUpperCase()} · cuenta persistente conservada · estado: ${ledger.account.stop ?? "entradas habilitadas"}`);
  const telegramLoop = telegram.run();
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
  const shutdown = new AbortController();
  const stop = () => {
    shutdown.abort();
    stopping = true;
    telegram?.stop();
    if (heartbeat) clearInterval(heartbeat);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let wasConnected = false;
  let refreshedAt = 0,
    equityAt = 0,
    diskAt = 0,
    resolutionAt = 0;
  let diskAvailable = true, evaluatedState = "", fullEvaluationAt = 0;
  const recordedAt = new Map<string, number>();
  const observation = {
    markets: 0,
    processing: undefined as ProcessingStats | undefined,
    coverage: data.coverage,
    feed: data.stream.status,
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
        if (!markets.length || Date.now() - refreshedAt >= 5 * 60000) {
          const selected = await data.markets(config.markets);
          if (!selected.length) throw new Error("Sin mercados compatibles");
          for (const m of selected) if (m.gammaCapturedAt && m.metrics.liquidity != null) sizing.gamma(m.conditionId!,Number(m.metrics.liquidity),m.gammaCapturedAt,`Polymarket Gamma · mercado ${m.id} · captura actual`);
          const reservations = store.all<Reservation>("reservations");
          const held = new Set([...ledger.positions.map(p=>p.marketId),...reservations.flatMap(r=>{
            const f=store.get<Frame>("meta",`signal:${r.id}`);return f ? [f.marketId] : [];
          })]);
          for (const id of held) if (!markets.some(m=>m.conditionId === id)) {
            const saved=store.get<(typeof markets)[number]>("meta",`market:${id}`);
            if (saved) markets.push(saved);
            else {
              const original=reservations.map(r=>store.get<Frame>("meta",`signal:${r.id}`)).find(f=>f?.marketId === id);
              const recovered=await data.restore(id,original?.football);
              if (recovered) markets.push(recovered); else ledger.stop("Mercado pendiente no reconstruido");
            }
          }
          markets = retainMarkets(selected, markets, held);
          for (const market of markets) store.put("meta",`market:${market.conditionId}`,market);
          data.coverage.retained=markets.length-selected.length;
          store.put("meta","football:status",{leagues:data.football.status,coverage:data.coverage,sources:[...data.football.datasets].map(([league,d])=>({league,checksum:d.checksum,verifiedAt:d.verifiedAt,sources:d.sources,matches:d.matches.length}))});
          refreshedAt = Date.now();
          recordedAt.clear();
          observation.markets = markets.length;
          observation.refreshedAt = refreshedAt;
          ledger.event(
            "markets",
            `${markets.length} mercados observados · ${data.coverage.football} fútbol · ${data.coverage.inspected} inspeccionados`,
          );
        }
        if (Date.now()-resolutionAt >= 60000) {
          for (const r of store.all<Reservation>("reservations").filter(r=>r.strategy === "football-value")) {
            const original=store.get<Frame>("meta",`signal:${r.id}`), market=markets.find(m=>m.conditionId === original?.marketId);
            if (!original || !market) continue;
            try { const resolved=await data.resolvedFrame(market,original); if (resolved) await engine.process(resolved); }
            catch { ledger.count("resolution_failed"); }
          }
          resolutionAt=Date.now();
        }
        const cycleAt = performance.now();
        await data.prepare(markets, ledger.config.maxDataAgeMs);
        const prepareMs = performance.now() - cycleAt;
        if (!data.coverage.ready) throw new Error("Sin libros frescos verificables");
        const reconnected = !wasConnected;
        if (reconnected) {
          await engine.reconcile();
          if (live) await live.checkBalances();
        }
        // Drain before any await: changes received while evaluating stay queued for the next pass.
        const changed = data.stream.takeChanges();
        const held = new Set([...ledger.positions.map(p=>p.marketId), ...store.all<Reservation>("reservations").flatMap(r=>{
          const original = store.get<Frame>("meta", `signal:${r.id}`);
          return original ? [original.marketId] : [];
        })]);
        const m = ledger.metrics(), a = ledger.account;
        const state = JSON.stringify([ledger.config,a.stop,a.cash,m.reserved,m.operationalCapital,m.sizeFactor,refreshedAt,new Date().toISOString().slice(0,10)]);
        const force = reconnected || state !== evaluatedState || Date.now() - fullEvaluationAt >= 60000;
        if (force) { fullEvaluationAt = Date.now(); evaluatedState = state; }
        const evaluate = marketsToEvaluate(markets,changed,held,force), frames: Frame[] = [];
        let framesRead = 0;
        for (let offset=0;offset<markets.length && !stopping;offset+=8) {
          const batch=markets.slice(offset,offset+8).filter(m=>evaluate.has(m.conditionId!) || (config.mode === "paper" && Date.now()-(recordedAt.get(m.conditionId!) ?? 0)>=10000));
          const prepared=await Promise.allSettled(batch.map(m=>data.frame(m,false)));
          for (const [index,item] of prepared.entries()) {
            if (item.status === "rejected") {ledger.count("fetch_failed");data.stream.changed.add(batch[index].conditionId!);continue;}
            const frame=item.value;framesRead++;
            sizing.midpoint(frame);frame.sizing=sizing.evidence(frame.marketId,frame.timestamp);
            const record=config.mode === "paper" && Date.now()-(recordedAt.get(frame.marketId) ?? 0)>=10000;
            if (record) {store.recordBook(frame);recordedAt.set(frame.marketId,Date.now());observation.recorded++;}
            if (frame.paperGas) {observation.gasUsd=frame.mergeGasUsd;observation.gasAt=frame.paperGas.timestamp;}
            if (evaluate.has(frame.marketId)) frames.push(frame);
          }
        }
        if (stopping) break;
        if (evaluate.size && !frames.length) throw new Error("Ninguna condición del lote pudo verificarse");
        const now = Date.now(), books = [...data.stream.books.values()];
        const verified = books.filter(b=>freshBook(b,now,ledger.config.maxDataAgeMs));
        if (!verified.length) throw new Error("Los libros caducaron durante la preparación");
        engine.health(true); wasConnected = true;
        const account = ledger.account;
        account.lastDataAt = Math.max(...verified.map(bookTime)); ledger.save(account);
        const evaluateAt = performance.now();
        if (frames.length) { await engine.processBatch(frames.filter(f=>f.connectionGeneration === data.stream.status.generation),shutdown.signal); runtime.lastEvaluationAt=Date.now(); }
        const evaluateMs = performance.now() - evaluateAt;
        if (Date.now() - equityAt >= 60000) { engine.recordEquity(); equityAt=Date.now(); }
        observation.coverage=data.coverage; observation.feed=data.stream.status;
        observation.processing={at:now,prepareMs,evaluateMs,cycleMs:performance.now()-cycleAt,changed:changed.size,evaluated:frames.length,skippedUnchanged:markets.length-evaluate.size,framesRead,sourceAgeMaxMs:Math.max(0,...books.map(b=>now-b.timestamp)),verificationAgeMaxMs:Math.max(0,...books.map(b=>now-bookTime(b))),receiveLagMaxMs:Math.max(0,...books.filter(b=>b.verifiedAt === undefined).map(b=>(b.receivedAt ?? b.timestamp)-b.timestamp)),backlog:data.stream.changed.size};
        store.put("meta", "paper:observation", observation); store.put("meta", "runtime", runtime);

      } catch {
        wasConnected = false;
        engine.health(false);
        ledger.event(
          "error",
          "No se pudieron verificar datos o saldos; entradas bloqueadas",
        );
      }
      if (!stopping)
        await data.stream.waitForChanges(Math.min(config.interval,ledger.config.maxDataAgeMs/2),shutdown.signal);
    }
  } finally {
    stop();
    ledger.stop("Proceso detenido; requiere reanudación autorizada");
    await engine.cancelOrders();
    await telegramLoop;
    await data.stream.close();
    await live?.close();
    store.close();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
