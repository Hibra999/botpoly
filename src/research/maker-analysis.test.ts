import {it,expect} from 'vitest';
import {analyzeMaker} from './maker-analysis.js';

it('replays public volume, queue assumptions, partials and cancel latency without converting depth removal or gaps into fills',()=>{
 const id='0x'+'a'.repeat(64),t=1700000000000;
 const record=(receivedAt:number,kind:string,payload:unknown)=>({schema:1,receivedAt,kind,payload});
 const metadata=record(t,'metadata',{marketId:id,tokens:[{assetId:'1',outcome:'Yes'},{assetId:'2',outcome:'No'}],feeInfo:{rate:.05,exponent:1},secondsDelay:0});
 const book=(at:number,size='10')=>record(at,'snapshot',{assetId:'1',conditionId:id,timestamp:at,hash:'sample',bids:[{price:'.4',size}],asks:[{price:'.5',size:'100'}],minOrderSize:'5',tickSize:'.01'});
 const trade=(at:number,size:number)=>record(at,'event',{topic:'market',type:'last_trade_price',payload:{assetId:'1',conditionId:id,timestamp:at,price:'.4',size:String(size),side:'SELL'}});
 const removal=record(t+1000,'event',{topic:'market',type:'price_change',payload:{conditionId:id,timestamp:t+1000,priceChanges:[{assetId:'1',price:'.4',size:'0',side:'BUY'}]}});
 const records=[metadata,book(t),removal,trade(t+2000,12),book(t+60200,'100'),trade(t+60400,5),record(t+60500,'end',{healthy:true})];
 const result=analyzeMaker(records),q=result.rows[0];
 expect(q.queueAhead).toBe(10);expect(q.depthReduction).toBe(10);expect(q.sellVolume).toBe(17);expect(q.cancelWindowVolume).toBe(5);
 expect(q.scenarios.map(s=>s.quantity)).toEqual([17,7]);expect(q.scenarios.every(s=>s.partial)).toBe(true);expect(q.scenarios[0].exitFees).toBeCloseTo(.204);expect(q.scenarios[0].gasSensitivity[0].hypotheticalNetUsd).toBeCloseTo(-.214);expect(result.actualPnl).toBeNull();expect(result.confirmedFills).toBe(0);
 const withDuplicate=analyzeMaker([...records.slice(0,4),records[3],...records.slice(4)]);expect(withDuplicate.counts.duplicateTrade).toBe(1);expect(withDuplicate.rows[0].sellVolume).toBe(17);
 const withGap=analyzeMaker([...records.slice(0,4),record(t+3000,'gap',{reason:'disconnect'}),...records.slice(4)]);expect(withGap.rows[0].status).toBe('invalid');expect(withGap.summary.every(s=>s.executableExits===0)).toBe(true);
 const late=analyzeMaker([...records.slice(0,-1),trade(t+60600,500),record(t+60601,'end',{healthy:true})]);expect(late.rows[0].sellVolume).toBe(17);
 const removalOnly=analyzeMaker([metadata,book(t),removal,record(t+60500,'end',{healthy:true})]);expect(removalOnly.rows[0].scenarios.every(s=>s.quantity===0)).toBe(true);
 expect(()=>analyzeMaker([metadata,book(t-1)])).toThrow('reloj');expect(result.liveEligible).toBe(false);
});
