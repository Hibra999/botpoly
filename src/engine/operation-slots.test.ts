import {afterEach, expect, it} from 'vitest';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from './store.js';
import {Ledger} from './ledger.js';
import {Engine} from './engine.js';
import {PaperExecutor} from './paper.js';
import {defaults, validateConfig, type Frame, type Order} from './model.js';
import {Controller} from '../app/control.js';
const stores: Store[] = [], dirs: string[] = [];
afterEach(() => { stores.splice(0).forEach(s=>s.close()); dirs.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true})); });
function setup(path=':memory:') {
  let now=Date.UTC(2026,8,7);
  const s=new Store(path); stores.push(s);
  const l=new Ledger(s,'paper',{...defaults,max_oper_per_hour:2},()=>now);
  const ex=new PaperExecutor('paper',async()=>undefined,()=>now,undefined,5000,s), e=new Engine(l,ex);
  e.health(true);
  const frame=(id:string):Frame=>({id,timestamp:now,marketId:id,eventId:id,underlying:id,title:id,binary:true,negRisk:false,feeRate:0,feeVerified:true,mergeGasUsd:.01,recoveryGasUsd:.01,gasVerified:true,source:'synthetic test',depth:true,...Object.fromEntries(['yes','no'].map(side=>[side,{tokenId:id+side,timestamp:now,minSize:5,tickSize:.01,bids:[{price:.4,size:100}],asks:[{price:.45,size:100}]}]))} as Frame);
  const finish=(orders:Order[])=>s.transaction(()=>orders.forEach(o=>{o.status='rejected';l.finishOperation(o);}));
  return {s,l,e,ex,frame,finish,set:(t:number)=>now=t,time:()=>now};
}
it('cuenta una entrada YES/NO, conserva pendientes y abre exactamente 60 minutos después de finalizar',()=>{
  const x=setup(), start=x.time();
  const pair=x.e.reserve(x.frame('a'))!;
  expect(pair).toHaveLength(2); expect(x.l.operationUsage()).toMatchObject({used:1,pending:1,available:1});
  x.set(start+2*3600000); expect(x.l.operationUsage().used).toBe(1);
  x.finish(pair); const end=x.time();
  x.e.reserve(x.frame('b')); expect(x.e.reserve(x.frame('c'))).toBeNull();
  x.set(end+3599999); expect(x.l.operationUsage()).toMatchObject({used:2,pending:1,nextAt:end+3600000});
  x.set(end+3600000); expect(x.l.operationUsage()).toMatchObject({used:1,pending:1,available:1});
});
it('serializa conexiones y reinicios; bajar/subir límite o cancelar no borra historial',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'botpoly-slots-')); dirs.push(dir);
  const a=setup(join(dir,'test.sqlite')),b=setup(join(dir,'test.sqlite'));
  const results=await Promise.all([Promise.resolve().then(()=>a.e.reserve(a.frame('a'))),Promise.resolve().then(()=>b.e.reserve(b.frame('b'))),Promise.resolve().then(()=>a.e.reserve(a.frame('c')))]);
  expect(results.filter(Boolean)).toHaveLength(2);
  const c=new Controller(b.e);
  expect((await c.execute({id:'lower',command:'set_config',payload:{max_oper_per_hour:1}})).ok).toBe(true);
  expect(a.l.operationUsage()).toMatchObject({used:2,available:0});
  await a.e.cancelOrders(); expect(a.l.operationUsage()).toMatchObject({used:2,pending:0});
  expect(setup(join(dir,'test.sqlite')).l.operationUsage().used).toBe(2);
  await c.execute({id:'raise',command:'set_config',payload:{max_oper_per_hour:3}});
  expect(a.l.operationUsage()).toMatchObject({used:2,available:1});
});
it('rechazos previos no consumen; intentos rechazados sí y ventas no adquieren cupo',async()=>{
  const x=setup(); expect(x.e.reserve({...x.frame('bad'),depth:false})).toBeNull();
  expect(x.l.operationUsage().used).toBe(0);
  await x.e.process(x.frame('sent'));
  expect(x.l.operationUsage()).toMatchObject({used:1,pending:0});
  const o=x.s.all<Order>('orders')[0];
  x.s.transaction(()=>x.l.finishOperation({...o,id:'sale',side:'SELL'}));
  expect(x.l.operationUsage().used).toBe(1);
});
it('retroceder el reloj no adelanta el final de la ventana ni retrocede el día contable',()=>{
  const x=setup(), start=x.time(), pair=x.e.reserve(x.frame('a'))!;
  x.set(start+1800000);x.s.transaction(()=>x.l.operationTime());
  x.set(start-86400000);x.finish(pair);x.l.rollDay();
  expect(x.l.account.day).toBe('2026-09-07');
  x.set(start+3600000);expect(x.l.operationUsage().used).toBe(1);
  x.set(start+5400000);expect(x.l.operationUsage().used).toBe(0);
});
it('migra solo campos ausentes y finales desconocidos conservando cuenta, reservas y parada',()=>{
  const x=setup(), pair=x.e.reserve(x.frame('old'))!;
  x.l.stop('Límite de pérdida diaria'); const account=x.l.account, reserves=x.s.all('reservations');
  const {max_oper_per_hour,...old}=x.l.config;
  x.s.put('meta','config',{...old,maxDataAgeMs:1200});
  x.s.delete('meta','operation-slots:migrated');x.s.db.exec('DELETE FROM operation_slots');
  const migrated=new Ledger(x.s,'paper',defaults,x.time);
  expect(migrated.config).toEqual({...old,maxDataAgeMs:1200,max_oper_per_hour:15});
  expect(migrated.account).toEqual(account);expect(x.s.all('reservations')).toEqual(reserves);
  expect(migrated.operationUsage().pending).toBe(1);
  x.finish(pair);x.s.delete('meta','operation-slots:migrated');x.s.db.exec('DELETE FROM operation_slots');
  pair.forEach(o=>{delete o.terminalAt;x.s.put('orders',o.id,o);});
  x.set(x.time()+7200000);new Ledger(x.s,'paper',defaults,x.time);
  expect(migrated.operationUsage().used).toBe(1);
});
it('configuración parcial conserva parámetros, llega a paper y valida enteros seguros',async()=>{
  const x=setup(), c=new Controller(x.e);
  await c.execute({id:'age',command:'set_config',payload:{maxDataAgeMs:1000}});
  await c.execute({id:'budget',command:'set_config',payload:{capitalUsd:50}});
  expect(x.ex.maxDataAgeMs).toBe(1000);expect(x.l.config.max_oper_per_hour).toBe(2);
  expect(x.l.account.cash).toBe(1000);expect(x.l.metrics().netPnl).toBe(0);
  for(const n of [0,-1,1.5,Infinity,NaN,Number.MAX_SAFE_INTEGER+1]) expect(()=>validateConfig({max_oper_per_hour:n})).toThrow();
});
