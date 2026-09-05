import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { resolve } from "node:path";
import { Store } from "../engine/store.js";
import { Ledger } from "../engine/ledger.js";
import { loadConfig } from "./config.js";
import { writePaperReport } from "../research/paper-report.js";

const { values } = parseArgs({
  options: {
    resume: { type: "boolean" },
    report: { type: "boolean" },
    days: { type: "string", default: "5" },
  },
});
const config = loadConfig();
if (config.mode !== "paper") throw new Error("Este comando solo admite paper");
if (!existsSync(config.database))
  throw new Error("Inicia botpoly.service antes de consultar el experimento");
if (values.resume) {
  const base = `http://127.0.0.1:${config.port}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Origin: config.origin ?? base,
  };
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      if (
        (
          await fetch(base + "/health", {
            headers,
            signal: AbortSignal.timeout(1000),
          })
        ).ok
      )
        break;
    } catch {
      /* systemd can return before the HTTP listener is ready. */
    }
    if (attempt === 29)
      throw new Error(
        "El servicio no responde; revisa systemctl status botpoly.service",
      );
    await delay(1000);
  }
  const login = await fetch(base + "/api/login", {
    method: "POST",
    headers,
    body: JSON.stringify({
      password: readFileSync(".dashboard-password", "utf8").trim(),
    }),
    signal: AbortSignal.timeout(5000),
  });
  if (!login.ok)
    throw new Error(
      "No se pudo autenticar; usa la contraseña actual del dashboard",
    );
  headers.Cookie = login.headers.get("set-cookie")!.split(";")[0];
  try {
    for (let attempt = 0; attempt < 30; attempt++) {
      const s = (await (
        await fetch(base + "/api/status", {
          headers,
          signal: AbortSignal.timeout(5000),
        })
      ).json()) as ReturnType<Ledger["snapshot"]>;
      if (s.mode !== "paper") throw new Error("El servidor no está en paper");
      if (
        s.account.connected &&
        Date.now() - s.account.lastDataAt < s.config.maxDataAgeMs
      )
        break;
      await delay(1000);
    }
    const r = await fetch(base + "/api/command", {
      method: "POST",
      headers,
      body: JSON.stringify({ id: "resume:" + randomUUID(), command: "resume" }),
      signal: AbortSignal.timeout(15000),
    });
    const result = (await r.json()) as { ok: boolean; message: string };
    if (!result.ok)
      throw new Error(
        "Reanudación denegada: revisa conexión, pérdidas y exposición en el dashboard",
      );
    console.log("Paper reanudado con los controles de riesgo comprobados.");
  } finally {
    await fetch(base + "/api/logout", {
      method: "POST",
      headers,
      body: "{}",
      signal: AbortSignal.timeout(5000),
    });
  }
}
const store = new Store(config.database);
try {
  const ledger = new Ledger(store, "paper", config.risk),
    s = ledger.snapshot();
  const counts: Record<string, number> = {};
  for (const day of s.statistics)
    for (const [key, n] of Object.entries(day.counts))
      counts[key] = (counts[key] ?? 0) + n;
  console.log(
    JSON.stringify(
      {
        mode: s.mode,
        state:
          s.account.stop ?? (s.account.connected ? "activo" : "sin conexión"),
        capital: s.metrics.equity,
        netPnl: s.metrics.netPnl,
        costs: s.account.fees + s.account.gas,
        observation: s.observation,
        counts,
      },
      null,
      2,
    ),
  );
  if (values.report)
    console.log(
      writePaperReport(
        ledger,
        resolve("reports", "paper-actual"),
        Number(values.days),
      ),
    );
} finally {
  store.close();
}
