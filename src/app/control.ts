import { Engine } from "../engine/engine.js";
import { validateConfig, type RiskConfig } from "../engine/model.js";

export type CommandName = "pause" | "resume" | "cancel_orders" | "set_config";
export interface Command {
  id: string;
  command: CommandName;
  payload?: unknown;
  configVersion?: number;
  expiresAt?: number;
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
  if (Object.keys(c).some((k) => !["id", "command", "payload", "configVersion", "expiresAt"].includes(k)))
    throw new Error("Campo de comando desconocido");
  if (c.command !== "set_config" && c.payload !== undefined)
    throw new Error("Este comando no admite parámetros");
  if (c.command === "set_config" && (!c.payload || typeof c.payload !== "object" || Array.isArray(c.payload))) throw new Error("Configuración inválida");
  for (const n of [c.configVersion, c.expiresAt]) if (n !== undefined && (!Number.isSafeInteger(n) || n < 0)) throw new Error("Versión o caducidad inválida");
  return c;
}
export interface Proposal {
  id: string; chat: string; sender: string; command: Command;
  createdAt: number; status: "pending" | "confirmed" | "cancelled";
  preview: string;
}
/** Serial control queue; entry blocking takes effect before any reconciliation wait. */
export class Controller {
  private pauseGeneration = 0;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly engine: Engine) {}
  propose(id: string, chat: string, sender: string, command: "resume" | "set_config", patch?: Partial<RiskConfig>): Proposal {
    const l = this.engine.ledger, s = l.store;
    return s.transaction(() => {
      const previous = s.get<Proposal>("proposals", id);
      if (previous) return previous;
      const cfg = command === "set_config" ? validateConfig({...l.config, ...patch}) : undefined;
      const c = parseCommand({id, command, ...(patch ? {payload:patch} : {}), configVersion:s.get<number>("meta","config:version") ?? 0, expiresAt:l.now()+120000});
      const preview = cfg ? Object.keys(patch!).map(k => `${k}: ${l.config[k as keyof RiskConfig]} → ${cfg[k as keyof RiskConfig]}`).join("\n") : "Reanudar entradas tras comprobar pérdidas, frescura y conciliación.";
      const proposal: Proposal = {id,chat,sender,command:c,createdAt:l.now(),status:"pending",preview};
      s.put("proposals",id,proposal); l.event("control",`Propuesta ${command} · versión ${c.configVersion} · caduca ${new Date(c.expiresAt!).toISOString()}`);
      return proposal;
    });
  }
  async confirm(id: string, chat: string, sender: string, accept: boolean): Promise<CommandResult> {
    const l=this.engine.ledger, s=l.store;
    const proposal=s.transaction(() => {
      const p=s.get<Proposal>("proposals",id);
      if (!p || p.chat !== chat || p.sender !== sender) throw new Error("Propuesta no autorizada");
      if (p.status === "cancelled") throw new Error("Propuesta cancelada");
      if (p.status === "confirmed") return p;
      if (l.now() < p.createdAt || l.now() >= p.command.expiresAt! || (s.get<number>("meta","config:version") ?? 0) !== p.command.configVersion) throw new Error("Propuesta caducada o desactualizada; solicita otra");
      p.status=accept ? "confirmed" : "cancelled";
      s.put("proposals",id,p); l.event("control",`${p.command.command}: propuesta ${accept ? "confirmada" : "cancelada"}`);
      return p;
    });
    if (proposal.status === "cancelled") return {id,ok:true,message:"Propuesta cancelada"};
    return this.execute(proposal.command);
  }
  private validateVersion(c: Command): void {
    const l=this.engine.ledger;
    if ((c.configVersion !== undefined && c.configVersion !== (l.store.get<number>("meta","config:version") ?? 0)) || (c.expiresAt !== undefined && l.now() >= c.expiresAt)) throw new Error("Propuesta desactualizada");
  }
  execute(value: unknown): Promise<CommandResult> {
    const c = parseCommand(value);
    if (["pause", "cancel_orders"].includes(c.command) && !this.engine.ledger.store.get("commands", c.id)) { this.pauseGeneration++; this.engine.ledger.stop(c.command === "pause" ? "Pausa autorizada" : "Pausa para cancelar órdenes"); }
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
      this.validateVersion(c);
      if (c.command === "pause") l.stop("Pausa autorizada");
      if (c.command === "resume") {
        const generation=this.pauseGeneration;
        await this.engine.drain();
        await this.engine.reconcile();
        this.validateVersion(c);
        if (generation !== this.pauseGeneration) throw new Error("Pausa recibida durante conciliación");
        this.engine.resume();
      }
      if (c.command === "cancel_orders") {
        l.stop("Pausa para cancelar órdenes");
        await this.engine.drain();
        await this.engine.cancelOrders();
      }
      if (c.command === "set_config") {
        s.transaction(() => {
          this.validateVersion(c);
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
