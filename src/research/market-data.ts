import {
  createPublicClient,
  type Market,
  type OrderBook,
} from "@polymarket/client";
import { fetchMarketInfo } from "@polymarket/client/actions";
import { type Book, type Frame, validateFrame } from "../engine/model.js";

export interface GasQuote {
  mergeGasUsd: number;
  recoveryGasUsd: number;
  timestamp: number;
  verified: boolean;
  source: string;
}
const book = (b: OrderBook): Book => ({
  tokenId: b.assetId,
  timestamp: Number(b.timestamp ?? 0),
  minSize: Number(b.minOrderSize),
  tickSize: Number(b.tickSize),
  bids: b.bids.map((l) => ({ price: Number(l.price), size: Number(l.size) })),
  asks: b.asks.map((l) => ({ price: Number(l.price), size: Number(l.size) })),
});
export class MarketData {
  readonly client: ReturnType<typeof createPublicClient> = createPublicClient();
  constructor(
    private gas: (market: Market) => Promise<GasQuote | undefined> = async () =>
      undefined,
  ) {}
  async markets(ids: string[] = []): Promise<Market[]> {
    if (ids.length)
      return Promise.all(ids.map((id) => this.client.fetchMarket({ id })));
    return (
      await this.client.listMarkets({ closed: false, pageSize: 20 }).firstPage()
    ).items;
  }
  async frame(market: Market): Promise<Frame> {
    if (!market.conditionId) throw new Error("Mercado sin condición");
    const info = await fetchMarketInfo(this.client, {
      conditionId: market.conditionId,
    });
    if (info.tokens.length !== 2) throw new Error("Mercado no binario");
    const yesToken = info.tokens.find((t) => t.outcome.toLowerCase() === "yes"),
      noToken = info.tokens.find((t) => t.outcome.toLowerCase() === "no");
    if (!yesToken || !noToken)
      throw new Error("Resultados no compatibles con YES/NO");
    const [yes, no, gas] = await Promise.all([
      this.client.fetchOrderBook({ assetId: yesToken.assetId }),
      this.client.fetchOrderBook({ assetId: noToken.assetId }),
      this.gas(market),
    ]);
    if (
      yes.conditionId !== market.conditionId ||
      no.conditionId !== market.conditionId
    )
      throw new Error("Libros de distinta condición");
    const timestamp = Date.now(),
      eventId = market.events[0]?.id ?? market.conditionId;
    // Known crypto underlyings share a conservative concentration bucket, even
    // across distinct expirations/events. Unknown assets stay grouped by event.
    const underlying =
      /\b(bitcoin|btc|ethereum|eth|solana|sol|xrp|dogecoin|doge)\b/i.test(
        market.question ?? "",
      )
        ? "CRYPTO"
        : eventId;
    return validateFrame({
      id: `${market.conditionId}:${yes.hash}:${no.hash}:${timestamp}`,
      timestamp,
      marketId: market.conditionId,
      eventId,
      underlying,
      title: market.question ?? market.conditionId,
      yes: book(yes),
      no: book(no),
      binary: true,
      negRisk: info.negRisk,
      feeRate: info.feeInfo.rate,
      feeVerified: info.feeInfo.exponent === 1 || info.feeInfo.rate === 0,
      mergeGasUsd: gas?.mergeGasUsd ?? 0,
      recoveryGasUsd: gas?.recoveryGasUsd ?? 0,
      gasVerified:
        !!gas?.verified &&
        timestamp - gas.timestamp < 60000 &&
        timestamp >= gas.timestamp,
      source: "Polymarket SDK @polymarket/client 0.9.0",
      depth: true,
    });
  }
}
