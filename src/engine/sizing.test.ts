import {it,expect} from 'vitest';
import {Store} from './store.js';
import {Ledger} from './ledger.js';
import {Engine} from './engine.js';
import {PaperExecutor} from './paper.js';
import {ObservedSizing,budgetAdjustment} from './sizing.js';
import {defaults,type Frame} from './model.js';
import {sizingFixture} from './sizing-fixture.js';
const start=Date.UTC(2026,8,7,12);
function frame(at=start,yes=.45,no=.45):Frame {
  const book=(tokenId:string,mid:number)=>({tokenId,hash:tokenId+at,timestamp:at,verifiedAt:at,minSize:1,tickSize:.01,bids:[{price:mid-.01,size:1000}],asks:[{price:mid+.01,size:1000}]});
  return {id:String(at),timestamp:at,marketId:'m',eventId:'e',underlying:'e',title:'Synthetic only',yes:book('yes',yes),no:book('no',no),binary:true,negRisk:false,feeRate:0,feeVerified:true,mergeGasUsd:0,recoveryGasUsd:0,gasVerified:true,source:'synthetic test',depth:true};
}
it('captura una observación por intervalo, 60 variaciones, p10 lineal y mayor volatilidad de ambas patas; no inventa pasado',()=>{
  const s=new Store(':memory:');try {
    const observed=new ObservedSizing(s);
    expect(observed.evidence('m',start).returns).toBe(0);
    for(let minute=0;minute<=60;minute++) {
      const at=start+minute*60000;
      observed.midpoint(frame(at,.45,.4+(minute%2)*.02));observed.midpoint(frame(at,.46,.6));
      if(minute%5===0) observed.gamma('m',100+minute,at,'Gamma synthetic test');
    }
    const now=start+3600000,e=observed.evidence('m',now);
    expect(e.returns).toBe(60);expect(e.gammaCount).toBe(13);expect(e.liquidityP10).toBeCloseTo(106);
    expect(e.volatilityNoBps).toBeGreaterThan(400);expect(e.volatilityYesBps).toBe(0);
    const adjusted=budgetAdjustment({...frame(now),sizing:e},10,defaults,now);
    expect(adjusted.after).toBeCloseTo(1.06*50/e.volatilityNoBps);
    expect(budgetAdjustment({...frame(now+120000),sizing:e},10,defaults,now+120000).reason).toBeTruthy();
    expect(observed.evidence('m',start-1).gammaCount).toBe(0);
  }finally{s.close();}
});
it('rechaza un hueco o libro no verificado y no usa Gamma actual como historial anterior',()=>{
  const s=new Store(':memory:');try{
    const observed=new ObservedSizing(s);
    for(let i=0;i<=60;i++) if(i!==30) observed.midpoint(frame(start+i*60000));
    observed.gamma('m',1000,start+3600000,'Gamma current capture');
    const e=observed.evidence('m',start+3600000);expect(e.recentGamma).toBe(1);expect(e.returns).toBe(58);
    expect(budgetAdjustment({...frame(start+3600000),sizing:e},10,defaults,start+3600000).reason).toBeTruthy();
    expect(observed.evidence('m',start).gammaCount).toBe(0);
    expect(observed.evidence('m',start+3600000-1).returns).toBeLessThan(60);
    const bad=frame(start+61*60000);bad.yes.verifiedAt=start;bad.no.verifiedAt=start;observed.midpoint(bad);
    expect(observed.evidence('m',bad.timestamp).midpointTo).toBe(start+3600000);
  }finally{s.close();}
});
it('no atribuye el punto medio al comienzo del minuto antes de su captura, incluso con caché',()=>{
  const s=new Store(':memory:');try {
    const observed=new ObservedSizing(s);observed.midpoint(frame(start+30000));
    expect(observed.evidence('m',start+30000).midpointTo).toBe(start);
    expect(observed.evidence('m',start+10000).midpointTo).toBe(0);
    expect(budgetAdjustment({...frame(),sizing:{...sizingFixture(start),midpointFrom:start-1}},10,defaults,start).reason).toContain('Cobertura');
  }finally{s.close();}
});
it('solo reduce y vuelve a comprobar el mínimo; sin historial no reserva capital ni cupo',()=>{
  const s=new Store(':memory:');try{
    const l=new Ledger(s,'paper',defaults,()=>start),e=new Engine(l,new PaperExecutor('paper',async()=>undefined));e.health(true);
    expect(e.reserve(frame())).toBeNull();expect(l.operationUsage().used).toBe(0);
    const f={...frame(),sizing:{...sizingFixture(start),liquidityP10:1}};
    expect(e.reserve(f)).toBeNull();expect(l.metrics().reserved).toBe(0);
    for(const liquidity of [0,10,100,10000]) for(const vol of [0,10,100,1000]) {
      const a=budgetAdjustment({...frame(),sizing:{...sizingFixture(start),liquidityP10:liquidity,volatilityNoBps:vol}},10,defaults,start);
      expect(a.after).toBeLessThanOrEqual(10);expect(a.after).toBeCloseTo(Math.min(10,.01*liquidity)*Math.min(1,50/Math.max(vol,1)));
    }
    expect(e.reserve({...frame(),sizing:sizingFixture(start)})).toHaveLength(2);
  }finally{s.close();}
});
