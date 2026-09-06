import {createHash} from 'node:crypto';
import type { OrderBook, PublicClient } from '@polymarket/client';
import type { PublicRealtimeEvent, SubscriptionHandle } from '@polymarket/client/actions';
export type MarketEvent = Extract<PublicRealtimeEvent, {topic: 'market'}>;
import { type Book, type Level } from '../engine/model.js';

function levels(values: {price: string; size: string}[], side: 'BUY' | 'SELL'): Level[] {
  const result = values.map(l=>({price:Number(l.price),size:Number(l.size)}));
  if (result.length > 10000 || result.some(l=>!Number.isFinite(l.price) || l.price <= 0 || l.price >= 1 || !Number.isFinite(l.size) || l.size <= 0) || new Set(result.map(l=>l.price)).size !== result.length) throw new Error('Profundidad inválida');
  return result.sort((a,b)=>side === 'BUY' ? b.price-a.price : a.price-b.price);
}
/** One current full book/token. The consumer samples frames; no event archive is claimed. */
export class BookStream {
  books = new Map<string, Book>();
  identities = new Map<string,string>();
  changed = new Set<string>();
  status = {connected:false, updates:0, coalesced:0, invalid:0, reconnects:0, snapshots:0};
  private handle?: SubscriptionHandle<MarketEvent>;
  private reading?: Promise<void>;
  private generation = 0;
  constructor(private client: PublicClient, private now=Date.now) {}
  private invalid(condition: string): void {
    for (const [token,id] of this.identities) if (id === condition) this.books.delete(token);
    this.status.invalid++;
  }
  private changedMarket(id: string): void {
    if (this.changed.has(id)) this.status.coalesced++;
    this.changed.add(id); this.status.updates++;
  }
  snapshot(b: OrderBook, receivedAt=this.now()): void {
    const id=this.identities.get(b.assetId), timestamp=Number(b.timestamp);
    if (!id || id !== b.conditionId || !Number.isFinite(timestamp) || timestamp <= 0 || timestamp > receivedAt) throw new Error('Snapshot con identidad o tiempo inválido');
    const current=this.books.get(b.assetId);
    // A response may race a newer websocket update. Never roll depth backwards.
    if (current && timestamp < current.timestamp) return;
    const next:Book={tokenId:b.assetId,hash:b.hash,timestamp,receivedAt,verifiedAt:receivedAt,minSize:Number(b.minOrderSize),tickSize:Number(b.tickSize),bids:levels(b.bids,'BUY'),asks:levels(b.asks,'SELL')};
    if (!Number.isFinite(next.minSize) || next.minSize <= 0 || !Number.isFinite(next.tickSize) || next.tickSize <= 0 || next.tickSize > .1) throw new Error('Metadatos de snapshot inválidos');
    next.hash ||= createHash('sha256').update(JSON.stringify([next.bids,next.asks])).digest('hex');
    this.books.set(b.assetId,next); this.status.snapshots++; this.changedMarket(id);
  }
  ingest(event: MarketEvent): void {
    if (event.type === 'new_market') return;
    const p=event.payload, id=p.conditionId;
    if (![...this.identities.values()].includes(id)) return;
    if (event.type === 'market_resolved') { this.invalid(id); return; }
    if (event.type === 'last_trade_price' || event.type === 'best_bid_ask') return;
    const time=Number(p.timestamp), receivedAt=this.now();
    if (!Number.isFinite(time) || time <= 0 || time > receivedAt) { this.invalid(id); return; }
    try {
      if (event.type === 'price_change') {
        // Validate the entire message before applying any of its changes.
        const updates=new Map<string,Book>();
        for (const change of event.payload.priceChanges) {
          const prior=updates.get(change.assetId) ?? this.books.get(change.assetId);
          if (this.identities.get(change.assetId) !== id || !prior || time < prior.timestamp) throw new Error();
          const price=Number(change.price), size=Number(change.size);
          if (!Number.isFinite(price) || price <= 0 || price >= 1 || !Number.isFinite(size) || size < 0 || !['BUY','SELL'].includes(change.side)) throw new Error();
          const next=structuredClone(prior), side=change.side === 'BUY' ? 'bids' : 'asks';
          next[side]=next[side].filter(l=>l.price !== price);
          if (size > 0) next[side].push({price,size});
          next[side].sort((a,b)=>side === 'bids' ? b.price-a.price : a.price-b.price);
          if (next[side].length > 10000) throw new Error();
          next.hash=change.hash ?? undefined; next.timestamp=time; next.receivedAt=receivedAt; delete next.verifiedAt;
          next.hash ||= createHash('sha256').update(JSON.stringify([next.bids,next.asks])).digest('hex');
          updates.set(change.assetId,next);
        }
        for (const [token,b] of updates) this.books.set(token,b);
      } else if (event.type === 'book') {
        const p=event.payload, old=this.books.get(p.assetId);
        if (this.identities.get(p.assetId) !== id || !old || time < old.timestamp) throw new Error();
        this.books.set(p.assetId,{...old,hash:p.hash ?? undefined,timestamp:time,receivedAt,verifiedAt:undefined,bids:levels(p.bids,'BUY'),asks:levels(p.asks,'SELL')});
      } else if (event.type === 'tick_size_change') {
        // A tick message does not verify depth. Require a new complete snapshot.
        this.invalid(id); return;
      }
      this.changedMarket(id);
    } catch { this.invalid(id); }
  }
  async connect(identities: Map<string,string>): Promise<void> {
    if (this.status.connected && JSON.stringify([...identities]) === JSON.stringify([...this.identities])) return;
    await this.close(); this.identities=identities;
    if (!identities.size) return;
    const generation=++this.generation;
    this.handle=await this.client.subscribe([{topic:'market',assetIds:[...identities.keys()],customFeatureEnabled:true}]);
    const handle=this.handle; this.status.connected=true; this.status.reconnects++;
    this.reading=(async()=>{
      try { for await (const event of handle) { if (generation !== this.generation) break; this.ingest(event); } }
      catch { this.status.invalid++; }
      finally { if (generation === this.generation) { this.status.connected=false; this.books.clear(); } }
    })();
  }
  async sync(assetIds=[...this.identities.keys()]): Promise<void> {
    for (let i=0;i<assetIds.length;i+=100) {
      const batch=assetIds.slice(i,i+100);
      try {
        const snapshots=await this.client.fetchOrderBooks(batch.map(assetId=>({assetId})));
        if (new Set(snapshots.map(b=>b.assetId)).size !== batch.length || snapshots.some(b=>!batch.includes(b.assetId))) throw new Error();
        for (const b of snapshots) this.snapshot(b);
      } catch { for (const token of batch) this.books.delete(token); this.status.invalid++; }
    }
  }
  async close(): Promise<void> {
    this.generation++; this.status.connected=false;
    await this.handle?.close(); await this.reading;
    this.handle=undefined; this.reading=undefined; this.books.clear(); this.changed.clear();
  }
}
