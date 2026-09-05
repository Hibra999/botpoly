import { describe, expect, it } from "vitest";
import { readDataset } from "./dataset.js";
import { runBacktest, blockBootstrap } from "./backtest.js";
import { reportHtml } from "./report.js";
import { defaults } from "../engine/model.js";
const data = readDataset("fixtures/demo.jsonl");
const options = {
  from: Date.UTC(2026, 0, 1),
  split: Date.UTC(2026, 0, 1, 0, 1),
  to: Date.UTC(2026, 0, 1, 0, 2),
  capital: 1000,
  markets: ["demo-market"],
  config: defaults,
  seed: 42,
};
describe("backtest verificable", () => {
  it("reproduce fills y métricas, preserva todos los ensayos y separa periodos", async () => {
    const a = await runBacktest(data.frames, data.manifest, options),
      b = await runBacktest(data.frames, data.manifest, options);
    expect(a.trials.map((t) => t.metrics)).toEqual(
      b.trials.map((t) => t.metrics),
    );
    expect(a.trials.map((t) => t.fills)).toEqual(b.trials.map((t) => t.fills));
    expect(a.trials).toHaveLength(18);
    expect(a.validation.liveEligible).toBe(false);
    for (const t of a.trials)
      for (const f of t.fills) {
        expect(f.timestamp).toBeGreaterThanOrEqual(
          t.period === "ajuste" ? options.from : options.split,
        );
        expect(f.timestamp).toBeLessThan(
          t.period === "ajuste" ? options.split : options.to,
        );
      }
    expect(a.cash.netPnl).toBe(0);
  });
  it("no usa precios sin profundidad como prueba de ejecución", async () => {
    const frames = structuredClone(data.frames);
    frames.forEach((f) => {
      f.depth = false;
    });
    const r = await runBacktest(
      frames,
      { ...data.manifest, kind: "prices" },
      options,
    );
    expect(r.status).toBe("insuficiente");
    expect(r.trials.every((t) => t.fills.length === 0)).toBe(true);
  });
  it("no ejecuta con el libro anterior cuando la liquidez desaparece durante latencia", async () => {
    const frames = structuredClone(data.frames);
    frames.forEach((f, i) => {
      if (i % 2) {
        f.yes.asks = [];
        f.no.asks = [];
      }
    });
    const r = await runBacktest(frames, data.manifest, options);
    const normal = r.trials.find((t) => t.label === "Riesgo mejorado")!;
    expect(normal.fills).toHaveLength(0);
  });
  it("genera HTML sin internet, escapa contenido y muestra limitaciones", async () => {
    const r = await runBacktest(
      data.frames,
      { ...data.manifest, source: "<script>alert(1)</script>" },
      options,
    );
    const html = reportHtml(r);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("exploratorio");
    expect(html).not.toMatch(/(?:src|href)="https?:/);
  });
  it("remuestreo reproducible con bloques y semilla; rechaza corte inválido", async () => {
    expect(blockBootstrap([1, -2, 3, -4], 42)).toEqual(
      blockBootstrap([1, -2, 3, -4], 42),
    );
    await expect(
      runBacktest(data.frames, data.manifest, {
        ...options,
        split: options.to,
      }),
    ).rejects.toThrow();
  });
});
