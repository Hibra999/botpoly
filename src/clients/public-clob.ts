import {
  createPublicClient,
  PriceHistoryInterval,
  type OrderBook as OfficialBook,
  type Market,
  type PaginationCursor,
} from "@polymarket/client";
import {
  fetchMarketInfo,
  fetchTickSize,
  fetchNegRisk,
} from "@polymarket/client/actions";
export { PriceHistoryInterval };
export const Side = { BUY: "BUY", SELL: "SELL" } as const;
export type Chain = number;
export type TickSize = string;
export interface OrderBookSummary {
  asset_id: string;
  market: string;
  timestamp: string;
  bids: { price: string; size: string }[];
  asks: { price: string; size: string }[];
  hash: string;
}
const normalizeBook = (b: OfficialBook): OrderBookSummary => ({
  asset_id: b.assetId,
  market: b.conditionId,
  timestamp: String(b.timestamp ?? 0),
  bids: b.bids,
  asks: b.asks,
  hash: b.hash,
});
/** Read-only compatibility boundary for the old analysis services. No signer. */
export class ClobClient {
  readonly public: ReturnType<typeof createPublicClient> = createPublicClient();
  constructor(..._unused: unknown[]) {}
  async getTickSize(tokenId: string): Promise<string> {
    return String(await fetchTickSize(this.public, { assetId: tokenId }));
  }
  async getNegRisk(tokenId: string): Promise<boolean> {
    return fetchNegRisk(this.public, { assetId: tokenId });
  }
  async getOrderBook(tokenId: string) {
    return normalizeBook(
      await this.public.fetchOrderBook({ assetId: tokenId }),
    );
  }
  async getOrderBooks(params: { token_id: string; side: string }[]) {
    return Promise.all(params.map((p) => this.getOrderBook(p.token_id)));
  }
  async getMidpoint(tokenId: string) {
    return this.public.fetchMidpoint({ assetId: tokenId });
  }
  async getSpread(tokenId: string) {
    return this.public.fetchSpread({ assetId: tokenId });
  }
  async getLastTradePrice(tokenId: string) {
    return (await this.public.fetchLastTradePrice({ assetId: tokenId }))?.price;
  }
  async getPricesHistory(p: {
    market: string;
    interval?: PriceHistoryInterval;
    startTs?: number;
    endTs?: number;
    fidelity?: number;
  }) {
    const data = await this.public.fetchPriceHistory({
      assetId: p.market,
      interval: p.interval,
      startTs: p.startTs,
      endTs: p.endTs,
      fidelity: p.fidelity,
    });
    return data;
  }
  private async normalizeMarket(m: Market) {
    if (!m.conditionId) throw new Error("Mercado sin condición");
    const info = await fetchMarketInfo(this.public, {
      conditionId: m.conditionId,
    });
    return {
      condition_id: m.conditionId,
      question_id: "",
      market_slug: m.slug ?? "",
      question: m.question ?? "",
      description: m.description ?? "",
      tokens: info.tokens.map((t) => ({
        token_id: t.assetId,
        outcome: t.outcome,
        price: 0,
        winner: false,
      })),
      active: m.state.active ?? false,
      closed: m.state.closed ?? false,
      accepting_orders: m.state.acceptingOrders ?? false,
      end_date_iso: m.state.endDate ?? "",
      neg_risk: info.negRisk,
      minimum_order_size: Number(m.trading.minimumOrderSize),
      minimum_tick_size: Number(info.tickSize),
    };
  }
  async getMarket(conditionId: string) {
    const page = await this.public
      .listMarkets({ conditionIds: [conditionId], pageSize: 1 })
      .firstPage();
    if (!page.items[0]) return null;
    return this.normalizeMarket(page.items[0]);
  }
  async getMarkets(cursor?: string) {
    const pages = this.public.listMarkets({ closed: false, pageSize: 20 });
    // from(undefined) represents an exhausted continuation in the new SDK.
    const page = await (cursor
      ? pages.from(cursor as PaginationCursor).firstPage()
      : pages.firstPage());
    return {
      data: await Promise.all(page.items.map((m) => this.normalizeMarket(m))),
      next_cursor: page.nextCursor ?? "",
    };
  }
}
