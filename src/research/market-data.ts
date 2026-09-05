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
  paperGas?: Frame["paperGas"];
}
const book = (b: OrderBook): Book => ({
  tokenId: b.assetId,
  hash: b.hash,
  timestamp: Number(b.timestamp ?? 0),
  minSize: Number(b.minOrderSize),
  tickSize: Number(b.tickSize),
  bids: b.bids
    .map((l) => ({ price: Number(l.price), size: Number(l.size) }))
    .sort((a, b) => b.price - a.price)
    .slice(0, 20),
  asks: b.asks
    .map((l) => ({ price: Number(l.price), size: Number(l.size) }))
    .sort((a, b) => a.price - b.price)
    .slice(0, 20),
});
export function eligibleMarket(m: Market): boolean {
  return (
    !!m.conditionId &&
    m.state.active === true &&
    m.state.closed === false &&
    !m.state.archived &&
    m.state.negRisk === false &&
    m.state.acceptingOrders === true &&
    m.state.enableOrderBook === true &&
    m.outcomes.yes?.label?.toLowerCase() === "yes" &&
    m.outcomes.no?.label?.toLowerCase() === "no" &&
    !!m.outcomes.yes.tokenId &&
    !!m.outcomes.no.tokenId
  );
}
export class MarketData {
  readonly client: ReturnType<typeof createPublicClient> = createPublicClient();
  private info = new Map<
    string,
    { at: number; data: Awaited<ReturnType<typeof fetchMarketInfo>> }
  >();
  constructor(
    private gas: (market: Market) => Promise<GasQuote | undefined> = async () =>
      undefined,
  ) {}
  async markets(ids: string[] = []): Promise<Market[]> {
    this.info.clear();
    if (ids.length) {
      const selected = await Promise.all(
        ids.map((id) => this.client.fetchMarket({ id })),
      );
      return selected.filter(eligibleMarket);
    }
    const selected: Market[] = [];
    let pages = 0;
    // ponytail: inspect at most 1,000 liquid markets; use a streaming feed if wider coverage is required.
    for await (const page of this.client.listMarkets({
      closed: false,
      pageSize: 100,
      order: "volume24hr",
      ascending: false,
    })) {
      for (const market of page.items)
        if (
          eligibleMarket(market) &&
          !selected.some((m) => m.conditionId === market.conditionId)
        )
          selected.push(market);
      if (selected.length >= 20 || ++pages >= 10) break;
    }
    return selected.slice(0, 20);
  }
  async frame(market: Market): Promise<Frame> {
    if (!market.conditionId) throw new Error("Mercado sin condición");
    let cached = this.info.get(market.conditionId);
    if (!cached || Date.now() - cached.at >= 60000) {
      cached = {
        at: Date.now(),
        data: await fetchMarketInfo(this.client, {
          conditionId: market.conditionId,
        }),
      };
      this.info.set(market.conditionId, cached);
    }
    const info = cached.data;
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
      paperGas: gas?.paperGas,
      source: "Polymarket SDK @polymarket/client 0.9.0",
      depth: true,
    });
  }
}
