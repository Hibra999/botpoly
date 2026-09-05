import type { Frame } from "../engine/model.js";
import { money } from "../engine/model.js";
import type { GasQuote } from "./market-data.js";

/** Public prices only. Gas UNITS are a simulation assumption, never an on-chain estimate. */
export class PaperGas {
  private cached?: GasQuote;
  private retryAt = 0;
  constructor(
    readonly units = 300000,
    readonly multiplier = 1.5,
    private request: typeof fetch = fetch,
    private now = Date.now,
  ) {
    if (
      !Number.isInteger(units) ||
      units < 21000 ||
      units > 5000000 ||
      !Number.isFinite(multiplier) ||
      multiplier < 1 ||
      multiplier > 10
    )
      throw new Error("Modelo de gas paper inválido");
  }
  async quote(): Promise<GasQuote | undefined> {
    if (this.cached && this.now() - this.cached.timestamp < 30000)
      return this.cached;
    if (this.now() < this.retryAt) return undefined;
    this.retryAt = this.now() + 10000;
    try {
      const [gas, price] = await Promise.all([
        this.request("https://gasstation.polygon.technology/v2", {
          signal: AbortSignal.timeout(5000),
        }),
        this.request("https://api.coinbase.com/v2/prices/POL-USD/spot", {
          signal: AbortSignal.timeout(5000),
        }),
      ]);
      if (!gas.ok || !price.ok) return undefined;
      const g = (await gas.json()) as {
        fast?: { maxFee?: number };
        blockTimestamp?: number;
      };
      const p = (await price.json()) as {
        data?: { amount?: string; currency?: string; base?: string };
      };
      const gwei = Number(g.fast?.maxFee),
        polUsd = Number(p.data?.amount),
        timestamp = this.now();
      if (
        !Number.isFinite(gwei) ||
        gwei <= 0 ||
        !Number.isFinite(polUsd) ||
        polUsd <= 0 ||
        p.data?.currency !== "USD" ||
        p.data.base !== "POL" ||
        !g.blockTimestamp ||
        Math.abs(timestamp - g.blockTimestamp * 1000) > 60000
      )
        return undefined;
      const paperGas: NonNullable<Frame["paperGas"]> = {
        units: this.units,
        multiplier: this.multiplier,
        gwei,
        polUsd,
        timestamp,
        source:
          "Polygon Gas Station fast + Coinbase POL/USD; unidades de gas supuestas para simulación",
      };
      return (this.cached = {
        mergeGasUsd: money(this.units * gwei * 1e-9 * polUsd * this.multiplier),
        recoveryGasUsd: 0,
        timestamp,
        verified: false,
        source: paperGas.source,
        paperGas,
      });
    } catch {
      return undefined;
    }
  }
}
