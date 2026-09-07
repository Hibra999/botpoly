import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve, sep, basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ReportWorker } from "../research/report-worker.js";
import { validateConfig, type RiskConfig, type AuditEvent } from "../engine/model.js";
import { Controller } from "./control.js";

type Keyboard = {inline_keyboard: {text:string; callback_data:string}[][]};
export const telegramCommands = ["start","status","pnl","positions","risk","config","setmaxops","setbudget","pause","resume","cancel_orders","report","audit"].map(command=>({command,description:({start:"Ayuda y estado",status:"Estado del motor",pnl:"Contabilidad y costes",positions:"Posiciones y valoración",risk:"Límites y cupos",config:"Consultar o proponer parámetros",setmaxops:"Proponer operaciones por hora",setbudget:"Proponer presupuesto",pause:"Bloquear entradas",resume:"Solicitar reanudación",cancel_orders:"Pausar y conciliar órdenes",report:"Generar informe",audit:"Últimos eventos"} as Record<string,string>)[command]}));
const navigation: Keyboard = {inline_keyboard:[["status","pnl","positions"],["risk","config","report"],["audit","start"]].map(row=>row.map(name=>({text:telegramCommands.find(c=>c.command===name)!.description,callback_data:`nav:${name}`})))};
interface Update {
  callback_query?: {id:string; data?:string; from:{id:number;is_bot?:boolean}; message?:{date:number;chat:{id:number;type:string}}};
  update_id: number;
  message?: {
    text?: string;
    date: number;
    chat: { id: number; type: string };
    from?: { id: number; is_bot?: boolean };
  };
}
interface Outgoing {
  id: string;
  text: string;
  document?: string;
  photo?: boolean;
  keyboard?: Keyboard;
  attempts: number;
  nextAt: number;
}
export class Telegram {
  private stopped = false;
  private abort = new AbortController();
  constructor(
    private controller: Controller,
    private token: string,
    private chatId: string,
    private request: typeof fetch = fetch,
    private now = Date.now,
    private reports = resolve("reports"),
    private worker: Pick<ReportWorker,"generate"|"stop"> = new ReportWorker(controller.engine.ledger,reports),
  ) {
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(token) || !/^\d+$/.test(chatId))
      throw new Error("Configura un bot y un chat privado de Telegram");
  }
  private get store() {
    return this.controller.engine.ledger.store;
  }
  enqueue(id: string, text: string, document?: string, photo = false, keyboard?: Keyboard): void {
    if (document && (!existsSync(document) || !realpathSync(document).startsWith(realpathSync(this.reports) + sep))) throw new Error("Documento fuera de informes o no disponible");
    if (this.store.get("meta", `telegram:sent:${id}`)) return;
    if (text.length > 3900 && !document) {
      const chunks=text.match(/[\s\S]{1,1700}/gu) ?? [];
      chunks.forEach((part,i)=>this.enqueue(`${id}:page:${i}`,`(${i+1}/${chunks.length}) ${part}`,undefined,false,i===chunks.length-1 ? keyboard : undefined));
      return;
    }
    this.store.insert("outbox", id, {
      id,
      text: text.slice(0, 3900),
      document,
      photo,
      keyboard,
      attempts: 0,
      nextAt: this.now(),
    } satisfies Outgoing);
  }
  private summary(kind: string): string {
    const l = this.controller.engine.ledger,
      m = l.metrics(),
      a = l.account;
    if (kind === "/positions")
      return l.positions.length
        ? l.positions
            .map(
              (p) =>
                `${p.strategy ?? "yes-no"} · ${p.title ?? p.marketId} · ${p.outcome}: ${p.quantity} · coste US$${p.cost.toFixed(2)} · salida US$${p.mark.toFixed(2)} · valoración ${p.stale ? "obsoleta" : "verificada"} · ${p.strategy === "football-value" ? "+10% neto o resolución oficial" : "fusión o recuperación"}`,
            )
            .join("\n")
        : "Sin posiciones abiertas.";
    const ops=l.operationUsage();
    const quota=`Cupo horario: ${ops.used}/${ops.limit} · pendientes ${ops.pending} · disponibles ${ops.available}\nPróxima disponibilidad: ${ops.available ? "ahora" : ops.nextAt ? new Date(ops.nextAt).toISOString() : "depende de finalizar entradas pendientes"}`;
    if (kind === "/config") return `Modo: ${l.mode} · versión ${this.store.get<number>("meta","config:version") ?? 0}\n${Object.entries(l.config).map(([k,v])=>`${k} = ${v}`).join("\n")}\nSintaxis: /config clave valor\n/setmaxops entero · /setbudget importe (US$50 mínimo)\nLos cambios requieren confirmación; presupuesto no crea saldo.`;
    if (kind === "/risk")
      return `Riesgo: ${a.stop ?? "activo"}\n${quota}\nDrawdown: ${(m.drawdown * 100).toFixed(2)}%\nExposición: US$${m.exposure.toFixed(2)}\nReservado: US$${m.reserved.toFixed(2)}\nLímite diario: ${(l.config.dailyLossPct * 100).toFixed(1)}%`;
    const snapshot = l.snapshot();
    const counts: Record<string, number> = {};
    for (const hour of snapshot.activity.filter((h) => h.lastAt >= this.now() - 3600000))
      for (const [key, n] of Object.entries(hour.counts)) counts[key] = (counts[key] ?? 0) + n;
    const reasons = Object.entries(counts).filter(([key]) => key.startsWith("rejected:")).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const uptime = Math.max(0, this.now() - (snapshot.runtime?.startedAt ?? this.now()));
    const detail = `\nTiempo ejecutándose: ${Math.floor(uptime / 3600000)} h ${Math.floor(uptime / 60000) % 60} min\nMercados: ${snapshot.observation?.markets ?? 0} · Fútbol: ${snapshot.observation?.coverage?.football ?? 0} · Con pronóstico: ${snapshot.observation?.coverage?.forecast ?? 0}\nÚltima evaluación: ${snapshot.runtime?.lastEvaluationAt ? new Date(snapshot.runtime.lastEvaluationAt).toISOString() : "pendiente"}\nÚltimos bloques horarios: ${counts.evaluated ?? 0} evaluaciones · ${counts.signals ?? 0} señales · ${counts.accepted ?? 0} reservas\nCompras: ${counts.buys ?? 0} · Ventas: ${counts.sells ?? 0} · Liquidaciones: ${counts.settled ?? 0}\nÚltimo dato: ${a.lastDataAt ? new Date(a.lastDataAt).toISOString() : "sin datos"}\n${reasons.map(([key, n]) => `${key.slice(9)}: ${n}`).join("\n")}`;
    return `Botpoly · ${l.mode}\n${quota}\nEstado: ${a.stop ?? (a.connected ? "activo" : "sin conexión")}\nCapital: US$${m.equity.toFixed(2)}\nPnL neto: US$${m.netPnl.toFixed(4)}\nRealizado: US$${a.realized.toFixed(4)}\nNo realizado: US$${m.unrealized.toFixed(4)}\nCostes: US$${(a.fees + a.gas).toFixed(4)}${detail}`;
  }
  async process(update: Update): Promise<void> {
    if (!Number.isSafeInteger(update.update_id) || update.update_id < 0) return;
    const done = `telegram:update:${update.update_id}`;
    if (this.store.get("meta", done)) return;
    const callback=update.callback_query;
    const m=callback?.message ? {...callback.message,from:callback.from,text:callback.data?.startsWith("nav:") ? "/"+callback.data.slice(4) : undefined} : update.message;
    if (m?.chat.type === "private" && String(m.chat.id) === this.chatId && String(m.from?.id) === this.chatId && !m.from?.is_bot) {
      const id=`telegram:${update.update_id}`;
      try {
        if (callback?.data?.startsWith("confirm:") || callback?.data?.startsWith("cancel:")) {
          const [action,...rest]=callback.data.split(":");
          const result=await this.controller.confirm(rest.join(":"),this.chatId,String(m.from!.id),action==="confirm");
          this.enqueue(id,result.message,undefined,false,navigation);
        } else if (typeof m.text === "string") {
          const [raw,...args]=m.text.trim().split(/\s+/), command=raw.toLowerCase().split("@")[0];
          const mutating=["/pause","/resume","/cancel_orders","/setmaxops","/setbudget"].includes(command) || (command === "/config" && args.length > 0);
          if (mutating && (callback || !Number.isFinite(m.date) || this.now()-m.date*1000 >= 120000 || m.date*1000 > this.now()+5000)) throw new Error("expired");
          if (["/pause","/cancel_orders"].includes(command) && !args.length) {
            this.enqueue(id,(await this.controller.execute({id,command:command.slice(1)})).message,undefined,false,navigation);
          } else if (command === "/resume" || command === "/setmaxops" || command === "/setbudget" || (command === "/config" && args.length)) {
            let patch: Partial<RiskConfig> | undefined;
            if (command !== "/resume") {
              const key=command === "/setmaxops" ? "max_oper_per_hour" : command === "/setbudget" ? "capitalUsd" : args[0];
              const value=args[command === "/config" ? 1 : 0];
              if (args.length !== (command === "/config" ? 2 : 1) || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value ?? "")) throw new Error("syntax");
              patch={[key]:Number(value)}; validateConfig({...this.controller.engine.ledger.config,...patch});
            } else if (args.length) throw new Error("syntax");
            const p=this.controller.propose(id,this.chatId,String(m.from!.id),command === "/resume" ? "resume" : "set_config",patch);
            this.enqueue(id,`Propuesta · ${this.controller.engine.ledger.mode}\n${p.preview}\nCaduca: ${new Date(p.command.expiresAt!).toISOString()}\nConfirmar no anula límites incumplidos.`,undefined,false,{inline_keyboard:[[{text:"Confirmar",callback_data:`confirm:${p.id}`},{text:"Cancelar",callback_data:`cancel:${p.id}`}]]});
          } else if (["/status","/pnl","/positions","/risk","/config"].includes(command) && !args.length) {
            this.enqueue(id,this.summary(command),undefined,false,navigation);
          } else if (command === "/audit") {
            const n=args.length ? Number(args[0]) : 20;
            if (args.length > 1 || !Number.isSafeInteger(n) || n < 1 || n > 100) throw new Error("syntax");
            const rows=this.store.recent<AuditEvent>("events",n);
            this.enqueue(id,rows.map(e=>`${new Date(e.timestamp).toISOString()} · ${e.mode} · ${e.type} · ${e.message}`).join("\n") || "Sin eventos contables o de control.",undefined,false,navigation);
          } else if (command === "/report" && !args.length) {
            this.store.put("meta",`telegram:report-request:${id}`,{id});
            this.enqueue(id+":queued","Informe solicitado. Se enviará con su gráfica al terminar de generarlo.",undefined,false,navigation);
          } else {
            this.enqueue(id,`Botpoly · ayuda\n${telegramCommands.map(c=>`/${c.command} — ${c.description}`).join("\n")}\n/config clave valor · /setMaxOps num · /setbudget amount · /audit [1–100]\n/start muestra estado. /resume requiere confirmación. Live solo se activa externamente con evidencia revisada.\n\n${this.summary("/status")}`,undefined,false,navigation);
          }
        }
      } catch {
        this.enqueue(id,"Solicitud rechazada: comprueba sintaxis, identidad, caducidad y versión de configuración. Solicita una nueva propuesta si corresponde.",undefined,false,navigation);
      }
      if (callback) await this.api("answerCallbackQuery",{callback_query_id:callback.id}).catch(()=>{});
    }
    this.store.transaction(() => {
      this.store.put("meta",done,true);
      this.store.put("meta","telegram:offset",Math.max(this.store.get<number>("meta","telegram:offset") ?? 0,update.update_id+1));
    });
  }
  private async api(method: string, body: unknown): Promise<void> {
    const response=await this.request(`https://api.telegram.org/bot${this.token}/${method}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.any([this.abort.signal,AbortSignal.timeout(15000)])});
    const data=await response.json() as {ok:boolean};
    if (!response.ok || !data.ok) throw new Error("Telegram no disponible");
  }
  async registerMenu(): Promise<void> { await this.api("setMyCommands",{commands:telegramCommands,scope:{type:"chat",chat_id:this.chatId},language_code:"es"}); }
  collectAlerts(): void {
    const last = this.store.get<number>("meta", "telegram:eventRow") ?? 0;
    const events = this.store.db
      .prepare(
        "SELECT rowid, data FROM events WHERE rowid > ? ORDER BY rowid LIMIT 1000",
      )
      .all(last) as { rowid: number; data: string }[];
    this.store.transaction(() => {
      for (const row of events) {
        const e = JSON.parse(row.data) as AuditEvent;
        if (
          [
            "signal",
            "reserved",
            "settled",
            "fill",
            "stop",
            "error",
            "execution_failed",
            "recovery",
            "merge",
          ].includes(e.type)
        )
          this.enqueue(`event:${e.id}`, `${e.mode} · ${e.strategy} · ${e.type}\n${e.message}`);
      }
      if (events.length)
        this.store.put("meta", "telegram:eventRow", events.at(-1)!.rowid);
    });
  }
  private async report(id: string, label: string, document: boolean): Promise<void> {
    const ledger = this.controller.engine.ledger;
    const safe = id.replace(/[^a-zA-Z0-9_-]/g, "-");
    const directory = resolve(this.reports, `${ledger.mode}-${safe}`);
    const result=await this.worker.generate(directory);
    this.enqueue(id,`${label}\n${readFileSync(resolve(directory,"summary.md"),"utf8")}`);
    if (result.png) this.enqueue(`${id}:photo`,`${label} · ${ledger.mode.toUpperCase()} · ${ledger.mode === "live" ? "Datos y costes reales confirmados" : "Resultados simulados"}`,result.png,true);
    if (result.chartError) this.enqueue(`${id}:chart-error`,"No se pudo generar la gráfica. HTML/JSON/CSV conservan el snapshot coherente.");
    if (document) for (const name of ["report.html","summary.md","result.json","trades.csv","manifest.json"]) this.enqueue(`${id}:document:${name}`,`${label} · ${name} · incluye costes, procedencia y limitaciones`,resolve(directory,name));
  }

  async scheduleReports(): Promise<void> {
    const hour = new Date(this.now()).toISOString().slice(0, 13);
    const job=this.store.db.prepare("SELECT id,data FROM meta WHERE id LIKE 'telegram:report-request:%' LIMIT 1").get() as {id:string;data:string}|undefined;
    if (job) { await this.report(JSON.parse(job.data).id,"Informe solicitado",true); this.store.delete("meta",job.id); }
    if (this.store.get<string>("meta", "telegram:hour") !== hour) {
      const daily = hour.endsWith("T00");
      await this.report(`hourly:${hour}`, `Estado horario UTC · ${hour}:00`, daily);
      this.store.put("meta", "telegram:hour", hour);
    }
    const runtime = this.store.get<{ experimentStartedAt: number }>("meta", "runtime");
    for (const hours of [24, 72]) {
      const id = `followup:${runtime?.experimentStartedAt}:${hours}`;
      if (runtime && this.now() - runtime.experimentStartedAt >= hours * 3600000 && !this.store.get("meta", id)) {
        await this.report(id, `Seguimiento a ${hours} horas`, true);
        this.store.put("meta", id, true);
      }
    }
    for (const r of this.store.all<{ id: string; status: string }>("reports")) {
      if (!/^[a-zA-Z0-9_-]+$/.test(r.id) || r.id.startsWith("paper-")) continue;
      const doc = resolve(this.reports, r.id, "report.html");
      if (existsSync(doc)) this.enqueue(`report:${r.id}`, `Evaluación ${r.id}: ${r.status}`, doc);
    }
  }

  async flush(): Promise<void> {
    const item = this.store
      .all<Outgoing>("outbox")
      .find((o) => o.nextAt <= this.now());
    if (!item) return;
    if (item.document && (!existsSync(item.document) || !realpathSync(item.document).startsWith(realpathSync(this.reports)+sep))) {
      this.store.delete("outbox",item.id);
      this.enqueue(item.id+":failed","No se pudo enviar el archivo: ruta de informe inválida o archivo ausente.");
      return;
    }
    let method = "sendMessage",
      body: string | FormData,
      headers: Record<string, string> = {};
    if (
      item.document &&
      item.document.startsWith(this.reports + sep) &&
      existsSync(item.document)
    ) {
      method = item.photo ? "sendPhoto" : "sendDocument";
      const form = new FormData();
      form.set("chat_id", this.chatId);
      form.set("caption", item.text.slice(0, 900));
      form.set(
        item.photo ? "photo" : "document",
        new Blob([readFileSync(item.document)], { type: item.photo ? "image/png" : "application/octet-stream" }),
        basename(item.document),
      );
      body = form;
    } else {
      headers = { "Content-Type": "application/json" };
      body = JSON.stringify({ chat_id: this.chatId, text: item.text, reply_markup:item.keyboard });
    }
    try {
      const response = await this.request(
        `https://api.telegram.org/bot${this.token}/${method}`,
        {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.any([
            this.abort.signal,
            AbortSignal.timeout(15000),
          ]),
        },
      );
      const data = (await response.json()) as {
        ok: boolean;
        parameters?: { retry_after?: number };
      };
      if (response.ok && data.ok) {
        this.store.transaction(() => {
          this.store.delete("outbox", item.id);
          this.store.put("meta", `telegram:sent:${item.id}`, true);
          if (item.document) this.controller.engine.ledger.event("report_sent",`Archivo enviado: ${basename(item.document)}`);
        });
        return;
      }
      item.nextAt =
        this.now() +
        Math.max(
          1000,
          (data.parameters?.retry_after ??
            2 ** Math.min(item.attempts + 1, 8)) * 1000,
        );
    } catch {
      item.nextAt =
        this.now() +
        Math.min(300000, 1000 * 2 ** Math.min(item.attempts + 1, 8));
    }
    item.attempts++;
    this.store.put("outbox", item.id, item);
  }
  async run(): Promise<void> {
    await Promise.all([this.receive(), this.send()]);
  }
  private async send(): Promise<void> {
    while (!this.stopped) {
      try {
        this.collectAlerts();
        await this.flush();
        await this.scheduleReports();
      } catch {
        const last=this.store.get<number>("meta","telegram:report-error") ?? 0;
        if (this.now()-last >= 60000) {
          this.store.put("meta","telegram:report-error",this.now());
          this.enqueue(`report-error:${Math.floor(this.now()/60000)}`,"Error al preparar informe; se reintentará. Los comandos siguen disponibles.");
        }
      }
      if (!this.stopped) await delay(1000, undefined, { signal: this.abort.signal }).catch(() => {});
    }
  }
  private async receive(): Promise<void> {
    let menu=false, menuRetryAt=0;
    while (!this.stopped) {
      let retryMs = 1000;
      if (!menu && this.now() >= menuRetryAt) {
        try { await this.registerMenu(); menu=true; } catch { menuRetryAt=this.now()+60000; }
      }
      try {
        const offset = this.store.get<number>("meta", "telegram:offset") ?? 0;
        const response = await this.request(
          `https://api.telegram.org/bot${this.token}/getUpdates`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              offset,
              timeout: 10,
              allowed_updates: ["message", "callback_query"],
            }),
            signal: AbortSignal.any([
              this.abort.signal,
              AbortSignal.timeout(15000),
            ]),
          },
        );
        const data = (await response.json()) as {
          ok: boolean;
          result?: Update[];
          parameters?: { retry_after?: number };
        };
        const retryAfter = data.parameters?.retry_after;
        if (
          typeof retryAfter === "number" &&
          Number.isFinite(retryAfter) &&
          retryAfter > 0
        )
          retryMs = Math.min(86400000, Math.max(1000, retryAfter * 1000));
        if (response.ok && data.ok && Array.isArray(data.result))
          for (const update of data.result) await this.process(update);
      } catch {
        /* Never log Telegram URLs: they contain credentials. */
      }
      if (!this.stopped)
        await delay(retryMs, undefined, { signal: this.abort.signal }).catch(
          () => {},
        );
    }
  }
  stop(): void {
    this.stopped = true;
    this.abort.abort();
    this.worker.stop();
  }
}
