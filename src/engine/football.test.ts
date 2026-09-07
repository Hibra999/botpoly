import {sizingFixture} from "./sizing-fixture.js";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "./store.js";
import { Ledger } from "./ledger.js";
import { Engine } from "./engine.js";
import { PaperExecutor, simulationDefaults } from "./paper.js";
import { defaults, footballPolicy, type Frame, type Executor, type Order } from "./model.js";
const stores: Store[]=[];
afterEach(()=>stores.splice(0).forEach(s=>s.close()));
function setup(options: {partialEvery?: number} = {}) {
  const now=Date.UTC(2026,8,6), s=new Store(':memory:'); stores.push(s);
  const book=(tokenId:string,price:number)=>({tokenId,hash:tokenId+'hash',timestamp:now,bids:[{price:price-.01,size:1000}],asks:[{price,size:1000}],minSize:5,tickSize:.01});
  const f: Frame={id:'f',timestamp:now,sizing:sizingFixture(now),marketId:'m',eventId:'match',underlying:'match',title:'A gana',yes:book('yes',.4),no:book('no',.65),binary:true,negRisk:true,feeRate:.05,feeVerified:true,mergeGasUsd:.02,recoveryGasUsd:0,gasVerified:true,source:'synthetic test',depth:true,football:{matchId:'match',league:'mex',home:'A',away:'B',startAt:now+86400000,result:'home'},forecast:{probability:.7,version:footballPolicy.version,checksum:'a'.repeat(64),generatedAt:now,dataVerifiedAt:now,sampleSize:30}};
  const l=new Ledger(s,'paper',defaults,()=>f.timestamp);
  const paper=new PaperExecutor('paper',async()=>structuredClone(f),()=>f.timestamp,{...simulationDefaults,latencyMs:0,...options},5000,s);
  const e=new Engine(l,paper); e.health(true); l.save({...l.account,lastDataAt:now});
  return {s,l,e,f,paper};
}
describe('fútbol dentro del motor compartido',()=>{
  it('reserva Kelly <=1%, emite señal una vez y no aumenta al reiniciar ni por submercado',async()=>{
    const {e,f,s,l,paper}=setup();
    await e.process(f);
    expect(l.positions).toHaveLength(1); expect(s.all('fills')).toHaveLength(1); expect(s.all('settlements')).toHaveLength(0);
    expect(l.positions[0].strategy).toBe('football-value'); expect(l.positions[0].football?.matchId).toBe('match');
    expect(l.metrics().exposure).toBeLessThanOrEqual(10.000001); expect(l.account.realized).toBe(0);
    await e.process({...f,id:'again'});
    await e.process({...f,id:'sibling',marketId:'sibling',football:{...f.football!,result:'draw'}});
    l.stop('Reinicio autorizado'); const restarted=new Engine(l,paper); await restarted.reconcile(); restarted.resume();
    await restarted.process({...f,id:'restart'}); expect(s.all('fills')).toHaveLength(1); expect(l.account.stop).toBeNull();
    expect(s.all<{counts:Record<string,number>}>('statistics')[0].counts.signals).toBe(1);
  });
  it('comparte límites globales y agregados; exige ventana, datos y ventaja neta',()=>{
    for (const tweak of [(f:Frame)=>{f.forecast=undefined},(f:Frame)=>{f.football!.startAt=f.timestamp+3599999},(f:Frame)=>{f.forecast!.probability=.44},(f:Frame)=>{f.forecast!.dataVerifiedAt-=8*86400000}]) { const {e,f}=setup();tweak(f);expect(e.reserve(f)).toBeNull(); }
    const {e,f,l,s}=setup();
    s.put('reservations','external',{id:'external',eventId:'other',underlying:'other',strategy:'football-value',remaining:100,timestamp:f.timestamp});
    expect(e.reserve(f)).toBeNull();
    s.delete('reservations','external'); l.save({...l.account,cash:1}); expect(e.reserve(f)).toBeNull();
  });
  it('NO del resultado contrario conserva la proposición',async()=>{
    const {e,f,l}=setup();f.forecast!.probability=.1;f.no.asks=[{price:.5,size:1000}];f.no.bids=[{price:.49,size:1000}];
    await e.process(f);expect(l.positions[0].outcome).toBe('NO');expect(l.positions[0].football?.result).toBe('home');
  });
  it('exige salida completa al 10% neto, cobra comisiones y no vuelve a entrar',async()=>{
    const {e,f,l,s}=setup();await e.process(f);const basis=l.positions[0].cost;
    f.yes.bids=[{price:.46,size:1}];await e.process({...f,id:'thin'});expect(s.all('fills')).toHaveLength(1);
    f.yes.bids=[{price:.43,size:1000}];await e.process({...f,id:'too-low'});expect(s.all('fills')).toHaveLength(1);
    f.yes.hash='exit'; f.yes.bids=[{price:.5,size:1000}];await e.process({...f,id:'profit'});
    expect(l.positions).toHaveLength(0);expect(l.account.realized).toBeGreaterThanOrEqual(basis*.1);expect(l.metrics().reserved).toBe(0);
    await e.process({...f,id:'no-reentry'});expect(s.all('fills')).toHaveLength(2);
  });
  it('conserva salida parcial y no vende una cantidad ya confirmada',async()=>{
    const {e,f,l,s}=setup({partialEvery:2});await e.process(f);const q=l.positions[0].quantity;
    f.yes.hash='exit';f.yes.bids=[{price:.5,size:1000}];await e.process({...f,id:'profit'});
    expect(l.positions[0].quantity).toBeCloseTo(q/2);expect(l.account.stop).toContain('parcial');
    await e.reconcile();await e.process({...f,id:'remaining'});
    expect(l.positions).toHaveLength(0);expect(s.all<Order>('orders').filter(o=>o.side==='SELL').map(o=>o.quantity)).toEqual([q,q/2]);
  });
  it('retiene reserva ante compra o venta incierta y nunca duplica envío',async()=>{
    const {f,l,paper,s}=setup();let calls=0;
    const uncertain:Executor={mode:'paper',execute:async()=>{calls++;return {status:'uncertain',fills:[]}},reconcile:async()=>({status:'uncertain',fills:[]}),cancel:async()=>({status:'uncertain',fills:[]}),merge:(...a)=>paper.merge(...a)};
    const e=new Engine(l,uncertain);await e.process(f);await e.process({...f,id:'again'});await e.reconcile();
    expect(calls).toBe(1);expect(l.metrics().reserved).toBeGreaterThan(0);expect(()=>e.resume()).toThrow();expect(s.all('fills')).toHaveLength(0);
  });
  it.each([1,0,.5])('liquida pago %s una sola vez con base de coste y gas',async(payout)=>{
    const {e,f,l,s}=setup();await e.process(f);const p=l.positions[0];
    f.resolution={payouts:[payout,1-payout],verifiedAt:f.timestamp,source:'synthetic official boundary',evidence:'receipt-test'};
    await e.process(f);await e.process(f);await e.reconcile();
    expect(l.positions).toHaveLength(0);expect(s.all('settlements')).toHaveLength(1);expect(l.account.realized).toBeCloseTo(p.quantity*payout-p.cost-.02,5);expect(l.metrics().reserved).toBe(0);
  });
  it('liquidez con el mismo hash no se renueva después de otro hash',async()=>{
    const {f,e,paper}=setup();f.yes.asks=[{price:.4,size:5}];const o=e.reserve(f)![0];
    expect((await paper.execute(o)).status).toBe('confirmed');f.yes.hash='new';expect((await paper.execute({...o,id:'2'})).status).toBe('confirmed');f.yes.hash='yeshash';expect((await paper.execute({...o,id:'3'})).status).toBe('rejected');
  });
});
it('una posición histórica cerrada adopta los metadatos de la nueva estrategia',async()=>{
 const {s,e,f,l}=setup();s.put('positions','yes',{tokenId:'yes',marketId:'m',eventId:'old',underlying:'old',outcome:'YES',quantity:0,cost:0,mark:0,timestamp:f.timestamp,strategy:'yes-no'});
 await e.process(f);expect(l.positions[0].strategy).toBe('football-value');expect(l.positions[0].football?.matchId).toBe('match');expect(l.metrics().reserved).toBeGreaterThan(0);
});
it('una salida incierta retiene posición y reserva durante conciliación, sin reenviar',async()=>{
 const {f,l,paper,s}=setup();let sells=0;
 const ex:Executor={mode:'paper',execute:async(o)=>{if(o.side==='BUY')return paper.execute(o);sells++;return {status:'uncertain',fills:[]}},reconcile:async(o)=>o.side==='BUY'?paper.reconcile(o):{status:'uncertain',fills:[]},cancel:async(o)=>paper.cancel(o),merge:(...a)=>paper.merge(...a)};
 const e=new Engine(l,ex);await e.process(f);const quantity=l.positions[0].quantity;f.yes.hash='sale';f.yes.bids=[{price:.5,size:1000}];await e.process(f);await e.reconcile();await e.process(f);
 expect(sells).toBe(1);expect(l.positions[0].quantity).toBe(quantity);expect(l.metrics().reserved).toBeGreaterThan(0);expect(s.all('settlements')).toHaveLength(0);expect(()=>e.resume()).toThrow();
});
it('retiene canje incierto y lo confirma una sola vez después de reiniciar el motor',async()=>{
 const {f,l,paper,s}=setup();let submissions=0;
 const ex:Executor={mode:'paper',execute:o=>paper.execute(o),reconcile:o=>paper.reconcile(o),cancel:o=>paper.cancel(o),merge:(...a)=>paper.merge(...a),redeem:async()=>{submissions++;throw new Error('timeout')},reconcileRedeem:(...a)=>paper.redeem(...a)};
 const e=new Engine(l,ex);await e.process(f);f.resolution={payouts:[.5,.5],verifiedAt:f.timestamp,source:'mock official source',evidence:'fixed block'};await e.process(f);expect(l.positions).toHaveLength(1);expect(l.account.stop).toContain('Canje');
 const restarted=new Engine(l,ex);await restarted.process(f);await restarted.process(f);expect(submissions).toBe(1);expect(l.positions).toHaveLength(0);expect(s.all('settlements')).toHaveLength(1);
});

it('compara alternativas antes de reservar y respeta costes, profundidad, frescura y una apuesta al reiniciar',async()=>{
 for (const variant of ['best','thin','stale','unverified'] as const) {
  const {s,l,f}=setup();
  const better=structuredClone(f);better.id='better';better.marketId='better';better.title='B gana';better.yes.tokenId='better-yes';better.no.tokenId='better-no';better.yes.hash='better-y';better.no.hash='better-n';better.football!.result='away';better.forecast!.probability=.2;better.yes.asks=[{price:.1,size:1000}];better.yes.bids=[{price:.09,size:1000}];better.no.asks=[{price:.95,size:1000}];
  if (variant==='thin') better.yes.asks=[{price:.4,size:1}];
  if (variant==='stale') better.yes.timestamp-=6000;
  if (variant==='unverified') better.feeVerified=false;
  const lookup=new Map([[f.marketId,f],[better.marketId,better]]);
  const executor=new PaperExecutor('paper',async id=>lookup.get(id),()=>f.timestamp,{...simulationDefaults,latencyMs:0},5000,s);
  const engine=new Engine(l,executor);
  await engine.processBatch([f,better]);
  expect(s.all<Order>('orders').filter(o=>o.side==='BUY')).toHaveLength(1);
  expect(l.positions[0].marketId).toBe(variant==='best'?'better':'m');
  expect(l.metrics().exposure).toBeLessThanOrEqual(10.000001);
  await new Engine(l,executor).processBatch([better,f]);expect(s.all('fills')).toHaveLength(1);
  const selection=s.get<{candidates:{marketId:string;expectedNetUsd:number|null}[]}>('meta','football:selection:match');
  expect(selection?.candidates[0].marketId).toBe(variant==='best'?'better':'m');
 }
});

it('actualiza juntas las posiciones antes de evaluar otro partido y no inicia órdenes tras cancelar el lote',async()=>{
 const {f,l,s}=setup();
 const other=structuredClone(f);other.id='other';other.marketId='other';other.football!.matchId='other-match';other.eventId=other.underlying='other-match';other.yes.tokenId='other-y';other.no.tokenId='other-n';
 const lookup=new Map([[f.marketId,f],[other.marketId,other]]);
 const executor=new PaperExecutor('paper',async id=>lookup.get(id),()=>f.timestamp,{...simulationDefaults,latencyMs:0},5000,s);
 const engine=new Engine(l,executor), abort=new AbortController();abort.abort();
 await engine.processBatch([f],abort.signal);expect(s.all('orders')).toHaveLength(0);
 await engine.process(f);expect(l.positions).toHaveLength(1);
 f.timestamp+=6000;for(const frame of [f,other]) {frame.timestamp=f.timestamp;frame.yes.timestamp=frame.no.timestamp=f.timestamp;}
 l.mark();expect(l.positions[0].stale).toBe(true);
 await engine.processBatch([other,f]);expect(l.positions).toHaveLength(2);expect(s.all('fills')).toHaveLength(2);expect(l.account.stop).toBeNull();
});
