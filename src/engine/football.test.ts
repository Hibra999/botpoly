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
  const f: Frame={id:'f',timestamp:now,marketId:'m',eventId:'match',underlying:'match',title:'A gana',yes:book('yes',.4),no:book('no',.65),binary:true,negRisk:true,feeRate:.05,feeVerified:true,mergeGasUsd:.02,recoveryGasUsd:0,gasVerified:true,source:'synthetic test',depth:true,football:{matchId:'match',league:'mex',home:'A',away:'B',startAt:now+86400000,result:'home'},forecast:{probability:.7,version:footballPolicy.version,checksum:'a'.repeat(64),generatedAt:now,dataVerifiedAt:now,sampleSize:30}};
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
