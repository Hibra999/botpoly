import {createHash} from 'node:crypto';
import type { OrderBook, PublicClient } from '@polymarket/client';
import type { PublicRealtimeEvent, SubscriptionHandle } from '@polymarket/client/actions';
export type MarketEvent = Extract<PublicRealtimeEvent, {topic: 'market'}>;
import { type Book, type Level, freshBook } from '../engine/model.js';

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
  status = {connected:false, updates:0, coalesced:0, invalid:0, reconnects:0, snapshots:0, unchangedSnapshots:0};
  readonly restVerifiedAt = new Map<string, number>();
  maxDataAgeMs = 5000;
  private handle?: SubscriptionHandle<MarketEvent>;
  private unwatch?: () => void;
  private wake?: () => void;
  onConnectionChange?: (connected:boolean) => void;
  private reading?: Promise<void>;
  private generation = 0;
  private metadata=new Map<string,Pick<Book,"minSize"|"tickSize"|"timestamp">>();
  constructor(private client: PublicClient, private now=Date.now) {}
  private invalid(condition: string): void {
    for (const [token,id] of this.identities) if (id === condition) this.books.delete(token);
    this.status.invalid++;
    this.changedMarket(condition);
  }
  private changedMarket(id: string): void {
    if (this.changed.has(id)) this.status.coalesced++;
    this.changed.add(id); this.status.updates++;
    this.wake?.();
  }
  takeChanges(): Set<string> {
    const result = new Set(this.changed);
    this.changed.clear();
    return result;
  }
  async waitForChanges(timeout: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    await new Promise<void>(resolve=>{
      let group:ReturnType<typeof setTimeout>|undefined;
      const done=()=>{clearTimeout(maintenance);clearTimeout(group);this.wake=undefined;signal?.removeEventListener('abort',done);resolve();};
      const maintenance=setTimeout(done,timeout);
      this.wake=()=>{group ??= setTimeout(done,100);};
      signal?.addEventListener('abort',done,{once:true});
      if (this.changed.size) this.wake();
    });
  }
  snapshot(b: OrderBook, receivedAt=this.now()): void {
    const id=this.identities.get(b.assetId), timestamp=Number(b.timestamp);
    if (!id || id !== b.conditionId || !Number.isFinite(timestamp) || timestamp <= 0 || timestamp > receivedAt) throw new Error('Snapshot con identidad o tiempo inválido');
    const current=this.books.get(b.assetId) ?? this.metadata.get(b.assetId);
    // A response may race a newer websocket update. Never roll depth backwards.
    if (current && timestamp < current.timestamp) return;
    const next:Book={tokenId:b.assetId,hash:b.hash,timestamp,receivedAt,verifiedAt:receivedAt,minSize:Number(b.minOrderSize),tickSize:Number(b.tickSize),bids:levels(b.bids,'BUY'),asks:levels(b.asks,'SELL')};
    if (!Number.isFinite(next.minSize) || next.minSize <= 0 || !Number.isFinite(next.tickSize) || next.tickSize <= 0 || next.tickSize > .1) throw new Error('Metadatos de snapshot inválidos');
    next.hash ||= createHash('sha256').update(JSON.stringify([next.bids,next.asks])).digest('hex');
    this.metadata.set(b.assetId,{minSize:next.minSize,tickSize:next.tickSize,timestamp:next.timestamp});
    const prior = this.books.get(b.assetId);
    const unchanged = prior && freshBook(prior, receivedAt, this.maxDataAgeMs) && prior.hash === next.hash && prior.minSize === next.minSize && prior.tickSize === next.tickSize && JSON.stringify([prior.bids,prior.asks]) === JSON.stringify([next.bids,next.asks]);
    this.books.set(b.assetId,next); this.restVerifiedAt.set(b.assetId,receivedAt); this.status.snapshots++;
    if (unchanged) this.status.unchangedSnapshots++; else this.changedMarket(id);
  }
  ingest(event: MarketEvent & {connectionGeneration?:number}): void {
    if (this.handle && (!this.handle.connection?.connected || event.connectionGeneration !== this.handle.connection.generation)) return;
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
        for (const [token,b] of updates) {this.books.set(token,b);this.metadata.set(token,{minSize:b.minSize,tickSize:b.tickSize,timestamp:b.timestamp});}
      } else if (event.type === 'book') {
        const p=event.payload, metadata=this.metadata.get(p.assetId);
        if (this.identities.get(p.assetId) !== id || !metadata || (time < metadata.timestamp)) throw new Error();
        const next:Book={...metadata,tokenId:p.assetId,hash:p.hash ?? undefined,timestamp:time,receivedAt,bids:levels(p.bids,'BUY'),asks:levels(p.asks,'SELL')};
        next.hash ||= createHash('sha256').update(JSON.stringify([next.bids,next.asks])).digest('hex');
        this.books.set(p.assetId,next);this.metadata.set(p.assetId,{minSize:next.minSize,tickSize:next.tickSize,timestamp:time});
      } else if (event.type === 'tick_size_change') {
        // A tick message does not verify depth. Require a new complete REST snapshot.
        for (const [token,condition] of this.identities) if (condition === id) this.metadata.delete(token);
        this.invalid(id); return;
      }
      this.changedMarket(id);
    } catch { this.invalid(id); }
  }
  async connect(identities: Map<string,string>): Promise<void> {
    if (this.handle && JSON.stringify([...identities]) === JSON.stringify([...this.identities])) return;
    await this.close(); this.identities=identities;
    if (!identities.size) return;
    const generation=++this.generation;
    this.handle=await this.client.subscribe([{topic:'market',assetIds:[...identities.keys()],customFeatureEnabled:true}]);
    const handle=this.handle;
    if (!handle.connection || !handle.onConnectionChange) { await this.close();throw new Error('Falta parche de continuidad del SDK'); }
    let transport=-1;
    this.unwatch=handle.onConnectionChange(state=>{
      const changed=transport !== state.generation;
      if (!state.connected || changed) {
        this.books.clear();this.restVerifiedAt.clear();
        for (const id of new Set(this.identities.values())) this.changedMarket(id);
      }
      if (state.connected && changed) this.status.reconnects++;
      transport=state.generation;this.status.connected=state.connected;
      this.onConnectionChange?.(state.connected);
    });
    this.reading=(async()=>{
      try { for await (const event of handle) { if (generation !== this.generation) break; this.ingest(event); } }
      catch { this.status.invalid++; }
      finally { if (generation === this.generation) { this.status.connected=false; this.books.clear(); this.unwatch?.(); this.unwatch=undefined; this.handle=undefined; this.onConnectionChange?.(false); } }
    })();
  }
  async sync(assetIds=[...this.identities.keys()]): Promise<void> {
    for (let i=0;i<assetIds.length;i+=100) {
      const batch=assetIds.slice(i,i+100);
      try {
        const transport=this.handle?.connection?.generation;
        if (this.handle && !this.handle.connection?.connected) return;
        const snapshots=await this.client.fetchOrderBooks(batch.map(assetId=>({assetId})));
        if (this.handle && (!this.handle.connection?.connected || transport !== this.handle.connection.generation)) continue;
        if (new Set(snapshots.map(b=>b.assetId)).size !== snapshots.length || snapshots.some(b=>!batch.includes(b.assetId))) throw new Error();
        // The API omits assets with no book. Keep valid neighbours and invalidate only missing conditions.
        for (const token of batch) if (!snapshots.some(b=>b.assetId === token)) this.invalid(this.identities.get(token)!);
        for (const b of snapshots) {
          try { this.snapshot(b); } catch { this.invalid(this.identities.get(b.assetId)!); }
        }
      } catch { for (const token of batch) this.books.delete(token); this.status.invalid++; }
    }
  }
  async close(): Promise<void> {
    this.generation++; this.status.connected=false;
    this.unwatch?.();this.unwatch=undefined;this.onConnectionChange?.(false);
    await this.handle?.close(); await this.reading;
    this.handle=undefined; this.reading=undefined; this.books.clear(); this.changed.clear(); this.metadata.clear(); this.restVerifiedAt.clear();
  }
}
