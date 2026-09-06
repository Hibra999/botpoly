import { createPublicClient, type Market, type PublicClient } from '@polymarket/client';
import { fetchMarketInfo } from '@polymarket/client/actions';
import { type Frame, type FootballMarket, type Resolution, validateFrame, validateResolution, freshBook } from '../engine/model.js';
import { FootballData, excludedCompetition, footballMarket, leagues } from '../strategies/football.js';
import { BookStream } from './book-stream.js';
export interface GasQuote {
  mergeGasUsd: number; recoveryGasUsd: number; timestamp: number; verified: boolean; source: string; paperGas?: Frame['paperGas'];
}
export type WatchedMarket = Market & {football?: FootballMarket};
export function eligibleMarket(m: Market): boolean {
  return !!m.conditionId && m.state.active === true && m.state.closed === false && !m.state.archived && m.state.negRisk === false && m.state.acceptingOrders === true && m.state.enableOrderBook === true && m.outcomes.yes?.label?.toLowerCase() === 'yes' && m.outcomes.no?.label?.toLowerCase() === 'no' && !!m.outcomes.yes.tokenId && !!m.outcomes.no.tokenId && !excludedCompetition(m);
}
export function selectMarkets(general: Market[], football: WatchedMarket[], now=Date.now()): WatchedMarket[] {
  const selected = [...new Map(football.map(m=>[m.conditionId,m])).values()].sort((a,b)=>a.football!.startAt-b.football!.startAt).slice(0,100);
  const score=(m:Market)=>Math.log1p(Math.max(0,Number(m.metrics.liquidity ?? 0)))+Math.log1p(Math.max(0,Number(m.metrics.volume24hr ?? 0)))+(Number.isFinite(Date.parse(m.state.endDate ?? '')) ? Math.max(0,7-Math.max(0,Date.parse(m.state.endDate!)-now)/86400000) : 0);
  const buckets=new Map<string,Market[]>();
  for (const m of [...general].filter(eligibleMarket).sort((a,b)=>score(b)-score(a))) {
    const key=m.events[0]?.id ?? m.conditionId!;
    const group=buckets.get(key) ?? []; group.push(m); buckets.set(key,group);
  }
  while (selected.length < 200 && buckets.size) for (const [key,group] of buckets) {
    const m=group.shift()!;
    if (!selected.some(s=>s.conditionId === m.conditionId)) selected.push(m);
    if (!group.length) buckets.delete(key);
    if (selected.length === 200) break;
  }
  return selected;
}
export function retainMarkets(selected: WatchedMarket[], previous: WatchedMarket[], pending: Set<string>): WatchedMarket[] {
  return [...selected,...previous.filter(m=>pending.has(m.conditionId!) && !selected.some(s=>s.conditionId === m.conditionId))];
}
export class MarketData {
  readonly stream: BookStream;
  readonly football: FootballData;
  coverage = {inspected:0, selected:0, football:0, forecast:0, retained:0, discoveryErrors:0, metadataFailures:0, ready:0, limit:5000, activeLimit:200, refreshMs:300000};
  private info = new Map<string,{at:number;data:Awaited<ReturnType<typeof fetchMarketInfo>>}>();
  constructor(private gas: (market: Market)=>Promise<GasQuote|undefined> = async()=>undefined, readonly client: PublicClient = createPublicClient(), football = new FootballData()) {
    this.stream=new BookStream(client); this.football=football;
  }
  async markets(ids: string[]=[]): Promise<WatchedMarket[]> {
    await this.football.refresh();
    const general: Market[]=[], sports:WatchedMarket[]=[];
    this.coverage.inspected=0;
    if (ids.length) {
      for (const id of ids.slice(0,200)) general.push(await this.client.fetchMarket({id}));
      this.coverage.inspected=general.length;
    } else {
      for await (const page of this.client.listMarkets({closed:false,pageSize:100,order:'volume24hr',ascending:false})) {
        general.push(...page.items.slice(0,5000-general.length));
        if (general.length >= 5000) break;
      }
      this.coverage.inspected=general.length;
      try {
        const metadata=await this.client.listSports();
        const series=new Map(leagues.flatMap(l=>{
          const matches=metadata.filter(s=>s.sport === l.id);
          return matches.length === 1 && /^\d+$/.test(String(matches[0].series)) ? [[l.id,String(matches[0].series)] as const] : [];
        }));
        let events=0;
        for await (const page of this.client.listEvents({seriesIds:[...series.values()].map(Number),closed:false,pageSize:100,startTimeMin:new Date().toISOString(),startTimeMax:new Date(Date.now()+7*86400000).toISOString(),order:'startTime',ascending:true})) {
          for (const event of page.items) for (const m of event.markets) {
            const football=footballMarket(event,m,series);
            if (football && football.startAt-Date.now() >= 3600000) sports.push({...m,football});
          }
          events+=page.items.length;
          if (events >= 1000) break;
        }
      } catch { this.coverage.discoveryErrors++; }
    }
    const selected=selectMarkets(general,sports);
    this.coverage.selected=selected.length; this.coverage.football=selected.filter(m=>m.football).length;
    this.coverage.forecast=selected.filter(m=>m.football && this.football.forecast(m.football)).length;
    return selected;
  }
  async restore(conditionId: string, football?: FootballMarket): Promise<WatchedMarket | undefined> {
    for await (const page of this.client.listMarkets({conditionIds:[conditionId],pageSize:10})) {
      const matches=page.items.filter(m=>m.conditionId === conditionId);
      if (matches.length === 1) return {...matches[0],football};
      break;
    }
    return undefined;
  }
  private async marketInfo(market: Market) {
    const id=market.conditionId!;
    let cached=this.info.get(id);
    if (!cached || Date.now()-cached.at >= 60000) {
      cached={at:Date.now(),data:await fetchMarketInfo(this.client,{conditionId:id})}; this.info.set(id,cached);
    }
    const info=cached.data;
    const yes=info.tokens.find(t=>t.outcome.toLowerCase() === 'yes'), no=info.tokens.find(t=>t.outcome.toLowerCase() === 'no');
    if (info.tokens.length !== 2 || !yes || !no || yes.assetId !== market.outcomes.yes?.tokenId || no.assetId !== market.outcomes.no?.tokenId || info.negRisk !== market.state.negRisk) throw new Error('Identidad binaria no verificada');
    return info;
  }
  async prepare(markets: WatchedMarket[]): Promise<void> {
    const ids=new Map<string,string>();
    for (const m of markets) for (const o of [m.outcomes.yes,m.outcomes.no]) if (m.conditionId && o?.tokenId) ids.set(o.tokenId,m.conditionId);
    // Bounded metadata concurrency; refresh before snapshots so they do not age in this queue.
    for (let i=0;i<markets.length;i+=8) await Promise.all(markets.slice(i,i+8).map(m=>this.marketInfo(m).catch(()=>{this.info.delete(m.conditionId!);this.coverage.metadataFailures++;} )));
    await this.stream.connect(ids);
    await this.stream.sync();
    this.coverage.ready=markets.filter(m=>[m.outcomes.yes,m.outcomes.no].every(o=>{const b=o?.tokenId && this.stream.books.get(o.tokenId);return b && freshBook(b,Date.now(),5000);})).length;
    for (const id of this.info.keys()) if (!markets.some(m=>m.conditionId === id)) this.info.delete(id);
  }
  async frame(market: WatchedMarket, refresh=true): Promise<Frame> {
    if (!market.conditionId) throw new Error('Mercado sin condición');
    if (refresh) {
      const current=await this.client.fetchMarket({id:market.id});
      if (current.conditionId !== market.conditionId || !current.state.acceptingOrders || current.state.closed || (market.football && Date.parse(current.sports.gameStartTime ?? '') !== market.football.startAt)) throw new Error('Mercado cerrado o partido reprogramado');
      market={...current,football:market.football};
    }
    const info=await this.marketInfo(market);
    const tokens=[market.outcomes.yes!.tokenId!,market.outcomes.no!.tokenId!];
    for (const token of tokens) this.stream.identities.set(token,market.conditionId!);
    if (refresh) await this.stream.sync(tokens);
    const yes=this.stream.books.get(tokens[0]),no=this.stream.books.get(tokens[1]);
    if (!yes || !no) throw new Error('Snapshot completo pendiente');
    const gas=await this.gas(market), timestamp=Date.now();
    const eventId=market.football?.matchId ?? market.events[0]?.id ?? market.conditionId;
    const underlying=market.football ? eventId : /\b(bitcoin|btc|ethereum|eth|solana|sol|xrp|dogecoin|doge)\b/i.test(market.question ?? '') ? 'CRYPTO' : eventId;
    return validateFrame({id:`${market.conditionId}:${yes.hash}:${no.hash}:${timestamp}`,timestamp,marketId:market.conditionId,eventId,underlying,title:market.question ?? market.conditionId,yes:structuredClone(yes),no:structuredClone(no),binary:true,negRisk:info.negRisk,feeRate:info.feeInfo.rate,feeVerified:info.feeInfo.exponent === 1 || info.feeInfo.rate === 0,mergeGasUsd:gas?.mergeGasUsd ?? 0,recoveryGasUsd:gas?.recoveryGasUsd ?? 0,gasVerified:!!gas?.verified && timestamp-gas.timestamp < 60000 && timestamp >= gas.timestamp,paperGas:gas?.paperGas,source:'Polymarket SDK @polymarket/client 0.9.0 · full REST + coalesced WebSocket',depth:true,football:market.football,forecast:market.football ? this.football.forecast(market.football) : undefined,secondsDelay:Number(market.trading.secondsDelay ?? 0)});
  }
  async resolvedFrame(market: WatchedMarket, original: Frame): Promise<Frame | undefined> {
    const resolution=await this.resolution(market);
    if (!resolution) return undefined;
    const gas=await this.gas(market);
    if (!gas || (!gas.verified && !gas.paperGas) || Date.now()-gas.timestamp > 60000) throw new Error('Coste de canje no disponible');
    return validateFrame({...original,id:`${original.marketId}:resolved:${resolution.verifiedAt}`,timestamp:Date.now(),resolution,mergeGasUsd:gas.mergeGasUsd,recoveryGasUsd:gas.recoveryGasUsd,gasVerified:gas.verified,paperGas:gas.paperGas});
  }
  /** V1 CTF payouts at a fixed, confirmed Polygon block, checked against official resolution. */
  async resolution(market: WatchedMarket): Promise<Resolution | undefined> {
    const current=await this.client.fetchMarket({id:market.id});
    if (current.conditionId !== market.conditionId || current.version !== 'v1' || current.resolution.umaResolutionStatus !== 'resolved' || !current.state.closed) return undefined;
    await this.marketInfo(current);
    const env=(this.client as unknown as {environment:{rpc:string;contracts:{conditionalTokens:string}}}).environment;
    const rpc=async(method:string,params:unknown[])=>{
      const response=await fetch(env.rpc,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(10000)});
      const data=await response.json() as {result?:string;error?:unknown};
      if (!response.ok || data.error || !/^0x[0-9a-f]+$/i.test(data.result ?? '')) throw new Error('Resolución on-chain no verificable');
      return data.result!;
    };
    if (BigInt(await rpc('eth_chainId',[])) !== 137n) throw new Error('RPC de otra red');
    const block='0x'+(BigInt(await rpc('eth_blockNumber',[]))-2n).toString(16), condition=market.conditionId!.slice(2);
    // ABI selectors: payoutDenominator(bytes32), payoutNumerators(bytes32,uint256).
    const call=async(data:string)=>BigInt(await rpc('eth_call',[{to:env.contracts.conditionalTokens,data},block]));
    const [denominator,yes,no]=await Promise.all([call('0xdd34de67'+condition),call('0x0504c814'+condition+'0'.repeat(64)),call('0x0504c814'+condition+'0'.repeat(63)+'1')]);
    if (denominator === 0n) return undefined;
    if (yes+no !== denominator || yes > denominator || no > denominator) throw new Error('Vector on-chain incompatible');
    const payouts=[Number(yes*1000000000000n/denominator)/1e12,Number(no*1000000000000n/denominator)/1e12] as [number,number];
    const r:Resolution={payouts,verifiedAt:Date.now(),source:'Polymarket Gamma resolved + Polygon CTF',evidence:JSON.stringify({conditionId:market.conditionId,contract:env.contracts.conditionalTokens,block,numerators:[yes.toString(),no.toString()],denominator:denominator.toString()})};
    validateResolution(r,Date.now()); return r;
  }
}
