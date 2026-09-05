import { existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AuditEvent } from "../engine/model.js";
import { Controller, type CommandName } from "./control.js";

interface Update {
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
  ) {
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(token) || !/^\d+$/.test(chatId))
      throw new Error("Configura un bot y un chat privado de Telegram");
  }
  private get store() {
    return this.controller.engine.ledger.store;
  }
  enqueue(id: string, text: string, document?: string): void {
    if (this.store.get("meta", `telegram:sent:${id}`)) return;
    this.store.insert("outbox", id, {
      id,
      text: text.slice(0, 3900),
      document,
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
                `${p.outcome}: ${p.quantity} · coste US$${p.cost.toFixed(2)} · salida US$${p.mark.toFixed(2)}`,
            )
            .join("\n")
        : "Sin posiciones abiertas.";
    if (kind === "/risk")
      return `Riesgo: ${a.stop ?? "activo"}\nDrawdown: ${(m.drawdown * 100).toFixed(2)}%\nExposición: US$${m.exposure.toFixed(2)}\nReservado: US$${m.reserved.toFixed(2)}\nLímite diario: ${(l.config.dailyLossPct * 100).toFixed(1)}%`;
    return `Botpoly · ${l.mode}\nEstado: ${a.stop ?? (a.connected ? "activo" : "sin conexión")}\nCapital: US$${m.equity.toFixed(2)}\nPnL neto: US$${m.netPnl.toFixed(4)}\nRealizado: US$${a.realized.toFixed(4)}\nNo realizado: US$${m.unrealized.toFixed(4)}\nCostes: US$${(a.fees + a.gas).toFixed(4)}`;
  }
  async process(update: Update): Promise<void> {
    if (!Number.isSafeInteger(update.update_id) || update.update_id < 0) return;
    const done = `telegram:update:${update.update_id}`;
    if (this.store.get("meta", done)) return;
    const m = update.message;
    if (
      m?.chat.type === "private" &&
      String(m.chat.id) === this.chatId &&
      String(m.from?.id) === this.chatId &&
      !m.from?.is_bot &&
      typeof m.text === "string"
    ) {
      const command = m.text.trim();
      const id = `telegram:${update.update_id}`;
      if (["/pause", "/resume", "/cancel_orders"].includes(command)) {
        if (
          this.now() - m.date * 1000 > 120000 ||
          m.date * 1000 > this.now() + 5000
        )
          this.enqueue(id, "Comando caducado. Envíalo de nuevo.");
        else
          this.enqueue(
            id,
            (
              await this.controller.execute({
                id,
                command: command.slice(1) as CommandName,
              })
            ).message,
          );
      } else if (["/status", "/pnl", "/positions", "/risk"].includes(command))
        this.enqueue(id, this.summary(command));
      else if (command === "/report") {
        const report = this.store.all<{ id: string }>("reports").at(-1);
        const document =
          report && /^[a-zA-Z0-9_-]+$/.test(report.id)
            ? resolve(this.reports, report.id, "report.html")
            : undefined;
        this.enqueue(
          id,
          document && existsSync(document)
            ? "Informe del último backtest. Consulta sus limitaciones."
            : "Todavía no hay un informe de backtest disponible.",
          document && existsSync(document) ? document : undefined,
        );
      } else
        this.enqueue(
          id,
          "Comandos: /status /pnl /positions /risk /pause /resume /cancel_orders /report",
        );
    }
    this.store.transaction(() => {
      this.store.put("meta", done, true);
      this.store.put(
        "meta",
        "telegram:offset",
        Math.max(
          this.store.get<number>("meta", "telegram:offset") ?? 0,
          update.update_id + 1,
        ),
      );
    });
  }
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
            "fill",
            "stop",
            "error",
            "execution_failed",
            "recovery",
            "merge",
          ].includes(e.type)
        )
          this.enqueue(`event:${e.id}`, `${e.mode} · ${e.type}\n${e.message}`);
      }
      if (events.length)
        this.store.put("meta", "telegram:eventRow", events.at(-1)!.rowid);
    });
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const lastDay = this.store.get<string>("meta", "telegram:daily");
    if (lastDay && lastDay !== day)
      this.enqueue(
        `daily:${lastDay}`,
        `Resumen UTC al cierre de ${lastDay}\n${this.summary("/pnl")}`,
      );
    this.store.put("meta", "telegram:daily", day);
    for (const r of this.store.all<{ id: string; status: string }>("reports")) {
      if (!/^[a-zA-Z0-9_-]+$/.test(r.id)) continue;
      const doc = resolve(this.reports, r.id, "report.html");
      if (existsSync(doc))
        this.enqueue(`report:${r.id}`, `Backtest ${r.id}: ${r.status}`, doc);
    }
  }
  async flush(): Promise<void> {
    const item = this.store
      .all<Outgoing>("outbox")
      .find((o) => o.nextAt <= this.now());
    if (!item) return;
    let method = "sendMessage",
      body: string | FormData,
      headers: Record<string, string> = {};
    if (
      item.document &&
      item.document.startsWith(this.reports + sep) &&
      existsSync(item.document)
    ) {
      method = "sendDocument";
      const form = new FormData();
      form.set("chat_id", this.chatId);
      form.set("caption", item.text.slice(0, 900));
      form.set(
        "document",
        new Blob([readFileSync(item.document)], { type: "text/html" }),
        "botpoly-backtest.html",
      );
      body = form;
    } else {
      headers = { "Content-Type": "application/json" };
      body = JSON.stringify({ chat_id: this.chatId, text: item.text });
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
    while (!this.stopped) {
      let retryMs = 1000;
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
              allowed_updates: ["message"],
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
        if (!this.stopped) {
          this.collectAlerts();
          await this.flush();
        }
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
  }
}
