import { Engine } from "../engine/engine.js";
import { validateConfig } from "../engine/model.js";

export type CommandName = "pause" | "resume" | "cancel_orders" | "set_config";
export interface Command {
  id: string;
  command: CommandName;
  payload?: unknown;
}
export interface CommandResult {
  id: string;
  ok: boolean;
  message: string;
}
export function parseCommand(value: unknown): Command {
  if (!value || typeof value !== "object") throw new Error("Comando inválido");
  const c = value as Command;
  if (
    typeof c.id !== "string" ||
    !/^[a-zA-Z0-9:_-]{1,120}$/.test(c.id) ||
    !["pause", "resume", "cancel_orders", "set_config"].includes(c.command)
  )
    throw new Error("Comando no permitido");
  if (Object.keys(c).some((k) => !["id", "command", "payload"].includes(k)))
    throw new Error("Campo de comando desconocido");
  if (c.command !== "set_config" && c.payload !== undefined)
    throw new Error("Este comando no admite parámetros");
  if (c.command === "set_config" && (!c.payload || typeof c.payload !== "object" || Array.isArray(c.payload))) throw new Error("Configuración inválida");
  return c;
}
/** Serial control queue; entry blocking takes effect before any reconciliation wait. */
export class Controller {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly engine: Engine) {}
  execute(value: unknown): Promise<CommandResult> {
    const c = parseCommand(value);
    if (["pause", "cancel_orders"].includes(c.command) && !this.engine.ledger.store.get("commands", c.id)) this.engine.ledger.stop(c.command === "pause" ? "Pausa autorizada" : "Pausa para cancelar órdenes");
    const next = this.queue.then(() => this.apply(c));
    this.queue = next.catch(() => {});
    return next;
  }
  private async apply(c: Command): Promise<CommandResult> {
    const l = this.engine.ledger,
      s = l.store;
    const previous = s.get<{ command: Command; result: CommandResult }>(
      "commands",
      c.id,
    );
    if (previous) {
      if (JSON.stringify(previous.command) !== JSON.stringify(c))
        return {
          id: c.id,
          ok: false,
          message: "Identificador usado con otro comando",
        };
      return previous.result;
    }
    // Claim before side effects. A crash cannot execute the same control twice.
    s.put("commands", c.id, {
      command: c,
      result: {
        id: c.id,
        ok: false,
        message: "Comando recibido; comprobar estado tras reinicio",
      },
    });
    let result: CommandResult;
    try {
      if (c.command === "pause") l.stop("Pausa autorizada");
      if (c.command === "resume") {
        await this.engine.drain();
        await this.engine.reconcile();
        this.engine.resume();
      }
      if (c.command === "cancel_orders") {
        l.stop("Pausa para cancelar órdenes");
        await this.engine.drain();
        await this.engine.cancelOrders();
      }
      if (c.command === "set_config") {
        s.transaction(() => {
          const cfg = validateConfig({...l.config, ...c.payload as object});
          s.put("meta", "config", cfg);
          s.put("meta", "config:version", (s.get<number>("meta", "config:version") ?? 0) + 1);
          l.event("config", JSON.stringify(cfg));
          l.mark();
          if (
            l.metrics().exposure >
            l.metrics().operationalCapital * cfg.totalExposurePct
          )
            l.stop("Exposición supera el nuevo presupuesto");
        });
      }
      result = { id: c.id, ok: true, message: "Comando aplicado" };
    } catch (error) {
      // Only our controlled validation errors are returned, never SDK errors.
      result = {
        id: c.id,
        ok: false,
        message:
          c.command === "resume"
            ? "Reanudación denegada: revisar conexión, exposición, conciliación y pérdidas"
            : "No se pudo aplicar el comando; revisar estado",
      };
    }
    s.put("commands", c.id, { command: c, result });
    l.event("control", `${c.command}: ${result.message}`);
    return result;
  }
}
