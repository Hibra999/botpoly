import {createHash} from 'node:crypto';
import type {Frame,RiskConfig} from './model.js';
import type {Store} from './store.js';
export const sizingPolicy=Object.freeze({version:'observed-liquidity-volatility-v1',mode:'paper',liquidityWindowMs:86400000,liquidityFraction:.01,minimumGamma:12,returns:60,volatilityWindowMs:3600000});
export interface SizingEvidence {
  version:string; computedAt:number; gammaCount:number; recentGamma:number; returns:number;
  gammaFrom:number; gammaTo:number; midpointFrom:number; midpointTo:number;
  liquidityP10:number; volatilityYesBps:number; volatilityNoBps:number;
  liquiditySha256:string; midpointsSha256:string; source:string;
}
const sha=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function budgetAdjustment(frame:Frame,before:number,cfg:RiskConfig,now:number,enabled=true) {
  const e=frame.sizing;
  let reason:string|undefined;
  if (enabled) {
    if (!e || e.version !== sizingPolicy.version) reason='Falta historial observado para dimensionamiento';
    else if (e.computedAt > now || now-e.computedAt > 60000 || e.gammaTo > now || now-e.gammaTo > 360000 || e.midpointTo > now || now-e.midpointTo > 90000) reason='Historial de dimensionamiento caducado o futuro';
    else if (e.recentGamma < 12 || e.gammaCount < e.recentGamma || e.returns !== 60 || e.midpointTo-e.midpointFrom !== 3600000 || e.gammaFrom < now-86400000 || e.gammaFrom > e.gammaTo) reason='Cobertura insuficiente: se exigen 12 Gamma y 60 variaciones válidas';
  }
  const volatilityBps=enabled && e ? Math.max(e.volatilityYesBps,e.volatilityNoBps) : 0;
  const liquidityCap=enabled && e ? .01*e.liquidityP10 : before;
  const volatilityFactor=enabled ? Math.min(1,cfg.maxSlippageBps/Math.max(volatilityBps,1)) : 1;
  return {policy:enabled ? sizingPolicy.version : 'sin-ajuste-experimental',before,liquidityCap,volatilityBps,volatilityFactor,after:reason ? 0 : Math.min(before,liquidityCap)*volatilityFactor,reason,evidence:e};
}
interface Observation {at:number;capturedAt?:number;value?:number;yes?:number;no?:number;source:string;sha256:string}
/** Raw observations are persisted once; frames carry compact statistics and hashes, never fabricated history. */
export class ObservedSizing {
  private cache=new Map<string,{minute:number;evidence:SizingEvidence}>();
  constructor(private store:Store) {}
  private insert(market:string,kind:string,at:number,data:Omit<Observation,'sha256'>,period:number):void {
    if (this.store.db.prepare('INSERT OR IGNORE INTO market_observations(market,kind,bucket,at,data) VALUES (?,?,?,?,?)').run(market,kind,Math.floor(at/period),at,JSON.stringify({...data,sha256:sha(data)})).changes) this.cache.delete(market);
  }
  gamma(market:string,value:number,at:number,source:string):void {
    if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(at) || at < 0 || !source) return;
    this.insert(market,'gamma',at,{at,value,source},300000);
  }
  midpoint(frame:Frame):void {
    const values=[frame.yes,frame.no].map(b=>{
      const bid=Math.max(...b.bids.map(l=>l.price)),ask=Math.min(...b.asks.map(l=>l.price));
      const verified=b.verifiedAt ?? b.timestamp;
      return Number.isFinite(bid+ask) && bid<=ask && verified<=frame.timestamp && frame.timestamp-verified<=5000 ? (bid+ask)/2 : undefined;
    });
    if (values.some(x=>x===undefined)) return;
    const minute=Math.floor(frame.timestamp/60000)*60000;
    this.insert(frame.marketId,'midpoint',minute,{at:minute,capturedAt:frame.timestamp,yes:values[0],no:values[1],source:`CLOB verificado · ${frame.source} · ${frame.yes.hash ?? frame.id} · ${frame.no.hash ?? frame.id}`},60000);
  }
  evidence(market:string,now:number):SizingEvidence {
    const minute=Math.floor(now/60000),cached=this.cache.get(market);
    if (cached?.minute===minute && cached.evidence.computedAt<=now) return cached.evidence;
    const read=(kind:string,from:number)=> (this.store.db.prepare('SELECT data FROM market_observations WHERE market=? AND kind=? AND at>=? AND at<=? ORDER BY at').all(market,kind,from,now) as {data:string}[]).map(r=>JSON.parse(r.data) as Observation);
    const gamma=read('gamma',now-86400000), mids=read('midpoint',(minute-60)*60000).filter(m=>(m.capturedAt ?? m.at)<=now);
    const values=gamma.map(g=>g.value!).sort((a,b)=>a-b);
    const index=Math.max(0,(values.length-1)*.1),lo=Math.floor(index),hi=Math.ceil(index);
    const returns:{yes:number;no:number}[]=[];
    for (let i=1;i<mids.length;i++) if (Math.floor(mids[i].at/60000)-Math.floor(mids[i-1].at/60000)===1 && mids[i].at-mids[i-1].at<=90000) returns.push({yes:(mids[i].yes!/mids[i-1].yes!-1)*10000,no:(mids[i].no!/mids[i-1].no!-1)*10000});
    const std=(key:'yes'|'no')=>{if (!returns.length) return 0;const mean=returns.reduce((n,r)=>n+r[key],0)/returns.length;return Math.sqrt(returns.reduce((n,r)=>n+(r[key]-mean)**2,0)/returns.length);};
    const evidence:SizingEvidence={version:sizingPolicy.version,computedAt:now,gammaCount:gamma.length,recentGamma:gamma.filter(g=>g.at>=now-3600000).length,returns:returns.length,gammaFrom:gamma[0]?.at ?? 0,gammaTo:gamma.at(-1)?.at ?? 0,midpointFrom:mids[0]?.at ?? 0,midpointTo:mids.at(-1)?.at ?? 0,liquidityP10:values.length ? values[lo]+(values[hi]-values[lo])*(index-lo) : 0,volatilityYesBps:std('yes'),volatilityNoBps:std('no'),liquiditySha256:sha(gamma),midpointsSha256:sha(mids),source:'Gamma capturado y puntos medios CLOB verificados; observaciones SQLite, no historial anterior a captura'};
    if (this.cache.size>=500) this.cache.clear();
    this.cache.set(market,{minute,evidence});return evidence;
  }
}
