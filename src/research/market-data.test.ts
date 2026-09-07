import {describe,expect,it,vi} from 'vitest';
import type {Market,Event,PublicClient,OrderBook} from '@polymarket/client';
import {MarketData,selectMarkets,retainMarkets} from './market-data.js';
import {BookStream,type MarketEvent} from './book-stream.js';
import {FootballData,footballMarket} from '../strategies/football.js';
const now=Date.UTC(2026,8,6);
function market(id='1',eventId='event'):Market {return {id,version:'v1',conditionId:id,question:id,description:'',state:{active:true,closed:false,negRisk:false,acceptingOrders:true,enableOrderBook:true,endDate:new Date(now+864e5).toISOString()},outcomes:{yes:{label:'Yes',tokenId:id+'y'},no:{label:'No',tokenId:id+'n'}},metrics:{liquidity:'100',volume24hr:'100'},trading:{minimumOrderSize:'5'},sports:{},events:[{id:eventId}],tags:[],resolution:{}} as unknown as Market;}
const raw=(assetId='y',timestamp=now-60000)=>({assetId,conditionId:'m',timestamp,hash:'h',minOrderSize:'5',tickSize:'.01',bids:[{price:'.4',size:'10'}],asks:[{price:'.5',size:'10'}]}) as unknown as OrderBook;
const change=(timestamp:number,size='0',assetId='y')=>({topic:'market',type:'price_change',payload:{conditionId:'m',timestamp,priceChanges:[{assetId,price:'.4',size,side:'BUY',hash:'changed'}]}}) as unknown as MarketEvent;
describe('descubrimiento y correspondencia deportiva',()=>{
  it('recorre 50 páginas, diversifica eventos y retiene mercados pendientes aparte del cupo',async()=>{
    let pages=0;
    const client={listMarkets:async function*(){for(let p=0;p<60;p++){pages++;yield {items:Array.from({length:100},(_,i)=>market(String(p*100+i),String(i%5)))}}},listSports:async()=>[],listEvents:async function*(){}} as unknown as PublicClient;
    const football=new FootballData();vi.spyOn(football,'refresh').mockResolvedValue();
    const d=new MarketData(undefined,client,football), selected=await d.markets();
    expect(pages).toBe(50);expect(d.coverage.inspected).toBe(5000);expect(selected).toHaveLength(200);expect(new Set(selected.slice(0,5).map(m=>m.events[0].id)).size).toBe(5);
    const held=market('held');expect(retainMarkets(selected,[held],new Set(['held']))).toHaveLength(201);
    expect(retainMarkets(selected,[held],new Set())).toHaveLength(200);
    expect(selectMarkets([market('a')],[])).toHaveLength(1);
  });
  it('identifica local, visitante y empate, excluye Mundial por competición/etiquetas y evita ambigüedad',()=>{
    const event={id:'event',state:{active:true,closed:false},sports:{sport:{sport:'mex',series:'10290'},gameId:4,teams:[{name:'Atlas FC',league:'mex',ordering:'home'},{name:'Atlante FC',league:'mex',ordering:'away'}]},schedule:{startTime:new Date(now+864e5).toISOString()},series:[{id:'10290'}],tags:[]} as unknown as Event;
    const m=market();m.sports={sportsMarketType:'moneyline',gameStartTime:event.schedule.startTime};
    const series=new Map([['mex','10290']]);
    for(const [group,clause,result] of [['Atlas FC','If Atlas FC wins','home'],['Atlante FC','If Atlante FC wins','away'],['Draw (Atlas FC vs. Atlante FC)','If the game ends in a draw','draw']]) {
      m.groupItemTitle=group;m.description=clause+', this market will resolve to "Yes". first 90 minutes of regular play plus stoppage time';
      expect(footballMarket(event,m,series)?.result).toBe(result);
    }
    event.tags=[{id:'x',slug:'world-cup-qualifiers'}] as unknown as Event['tags'];expect(footballMarket(event,m,series)).toBeUndefined();event.tags=[];
    event.sports.sport!.sport='fif';expect(footballMarket(event,m,series)).toBeUndefined();event.sports.sport!.sport='mex';
    event.sports.teams[1].ordering=event.sports.teams[0].ordering;expect(footballMarket(event,m,series)).toBeUndefined();event.sports.teams[1].ordering='away' as typeof event.sports.teams[1]['ordering'];
    m.sports.sportsMarketType='total_corners';expect(footballMarket(event,m,series)).toBeUndefined();
  });
});
describe('libros completos y flujo acotado',()=>{
  it('verifica snapshot auténtico, elimina niveles y no rejuvenece con best_bid_ask',()=>{
    const b=new BookStream({} as PublicClient,()=>now);b.identities.set('y','m');b.snapshot(raw());
    expect(b.books.get('y')?.verifiedAt).toBe(now);expect(b.books.get('y')?.timestamp).toBe(now-60000);
    b.ingest({type:'best_bid_ask',payload:{conditionId:'m',assetId:'y',timestamp:now}} as unknown as MarketEvent);expect(b.books.get('y')?.timestamp).toBe(now-60000);
    b.ingest(change(now));expect(b.books.get('y')?.bids).toEqual([]);expect(b.books.get('y')?.verifiedAt).toBeUndefined();
    b.ingest(change(now,'4'));expect(b.books.get('y')?.bids).toEqual([{price:.4,size:4}]);expect(b.changed.size).toBe(1);expect(b.status.coalesced).toBeGreaterThan(0);
  });
  it('invalida ambas patas por futuro, fuera de orden o identidad incorrecta; resincroniza',()=>{
    const b=new BookStream({} as PublicClient,()=>now);b.identities=new Map([['y','m'],['n','m']]);
    for(const event of [change(now+1),change(now-70000),change(now,'2','wrong')]) {
      b.snapshot(raw());b.snapshot(raw('n'));b.ingest(event);expect(b.books.size).toBe(0);
    }
    b.snapshot(raw());b.ingest(change(now,'3'));b.snapshot(raw('y',now-1));expect(b.books.get('y')?.bids[0].size).toBe(3);
    expect(()=>b.snapshot({...raw(),conditionId:'wrong'} as unknown as OrderBook)).toThrow();
  });
  it('la desconexión elimina snapshots; reconectar exige nuevos snapshots completos',async()=>{
    let finish:()=>void=()=>{};
    const client={subscribe:async()=>({connection:{connected:true,generation:1},onConnectionChange:(fn:(state:{connected:boolean;generation:number})=>void)=>{fn({connected:true,generation:1});return()=>{};},close:async()=>finish(),async *[Symbol.asyncIterator](){await new Promise<void>(r=>finish=r);throw new Error('disconnect')}})} as unknown as PublicClient;
    const b=new BookStream(client,()=>now);await b.connect(new Map([['y','m']]));b.snapshot(raw());finish();await new Promise(r=>setTimeout(r,0));expect(b.books.size).toBe(0);expect(b.status.connected).toBe(false);
    await b.connect(new Map([['y','m']]));expect(b.books.size).toBe(0);b.snapshot(raw());expect(b.books.size).toBe(1);await b.close();expect(b.books.size).toBe(0);
  });
});
it('conserva vecinos válidos cuando el lote omite un token y acepta un snapshot WS completo tras invalidación',async()=>{
 const c={fetchOrderBooks:async()=>[raw()]} as unknown as PublicClient;
 const b=new BookStream(c,()=>now);b.identities=new Map([['y','m'],['missing','other']]);await b.sync();expect(b.books.has('y')).toBe(true);expect(b.books.has('missing')).toBe(false);
 b.ingest(change(now+1));expect(b.books.has('y')).toBe(false);
 b.ingest({topic:'market',type:'book',payload:{conditionId:'m',assetId:'y',timestamp:now,bids:[{price:'.4',size:'3'}],asks:[{price:'.5',size:'4'}],hash:'full'}} as unknown as MarketEvent);
 expect(b.books.get('y')?.bids[0].size).toBe(3);expect(b.books.get('y')?.verifiedAt).toBeUndefined();
});

it('omite snapshots idénticos vigentes, recupera caducados y conserva cambios recibidos después de extraer el lote',()=>{
 let time=now;
 const stream=new BookStream({} as PublicClient,()=>time);stream.identities.set('y','m');stream.snapshot(raw());
 expect(stream.takeChanges()).toEqual(new Set(['m']));
 time+=2000;stream.snapshot(raw());expect(stream.takeChanges().size).toBe(0);expect(stream.status.unchangedSnapshots).toBe(1);
 const first=stream.takeChanges();stream.ingest(change(time,'3'));expect(first.size).toBe(0);expect(stream.takeChanges()).toEqual(new Set(['m']));
 time+=6000;stream.snapshot(raw('y',time));expect(stream.takeChanges()).toEqual(new Set(['m']));
 stream.maxDataAgeMs=1000;time+=1500;stream.snapshot(raw('y',time));expect(stream.takeChanges()).toEqual(new Set(['m']));
});

it('incluye todas las alternativas del partido cambiado y posiciones, y reevalúa todo al cambiar el estado', async()=>{
 const {marketsToEvaluate}=await import('./market-data.js');
 const first={...market('a'),football:{matchId:'match',league:'mex',home:'A',away:'B',startAt:now+864e5,result:'home' as const}};
 const second={...market('b'),football:{...first.football,result:'draw' as const}};
 const markets=[first,second,market('held'),market('quiet')];
 expect(marketsToEvaluate(markets,new Set(['a']),new Set(['held']),false)).toEqual(new Set(['a','b','held']));
 expect(marketsToEvaluate(markets,new Set(),new Set(),false).size).toBe(0);
 expect(marketsToEvaluate(markets,new Set(),new Set(),true).size).toBe(4);
});

it('resincroniza según el límite vigente sin volver a pedir libros todavía recientes',async()=>{
 vi.useFakeTimers();vi.setSystemTime(now);
 try {
  const fetchOrderBooks=vi.fn(async(requests:{assetId:string}[])=>requests.map(r=>raw(r.assetId,now-60000)));
  const data=new MarketData(undefined,{fetchOrderBooks} as unknown as PublicClient,new FootballData());
  vi.spyOn(data as unknown as {marketInfo:()=>Promise<unknown>},'marketInfo').mockResolvedValue({});
  vi.spyOn(data.stream,'connect').mockImplementation(async ids=>{data.stream.identities=ids;data.stream.status.connected=true;});
  await data.prepare([market('m')],1000);expect(fetchOrderBooks).toHaveBeenCalledTimes(1);expect(data.coverage.ready).toBe(1);
  vi.setSystemTime(now+499);await data.prepare([market('m')],1000);expect(fetchOrderBooks).toHaveBeenCalledTimes(1);
  vi.setSystemTime(now+501);await data.prepare([market('m')],1000);expect(fetchOrderBooks).toHaveBeenCalledTimes(2);expect(data.coverage.ready).toBe(1);
  data.stream.takeChanges();vi.setSystemTime(now+1502);await data.prepare([market('m')],1000);expect(data.stream.takeChanges()).toEqual(new Set(['m']));expect(data.coverage.ready).toBe(1);
 }finally{vi.useRealTimers();}
});
