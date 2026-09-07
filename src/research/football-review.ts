import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {quote,freshBook,validateFrame,money,type Frame,type Fill,type Order,type Position} from '../engine/model.js';
import type {Store} from '../engine/store.js';
const sha=(data:string|Uint8Array)=>createHash('sha256').update(data).digest('hex');
export function reviewFootball(store:Store) {
  return store.transaction(()=>{
    const orders=store.all<Order>('orders'),fills=store.all<Fill>('fills');
    const settlements=store.all<{marketId:string;timestamp:number;payout?:number;basis?:number;gas:number;resolution?:Frame['resolution']}>('settlements');
    const account=store.get<import('../engine/model.js').Account>('meta','account')!;
    const config=store.get<import('../engine/model.js').RiskConfig>('meta','config')!;
    const sourceTo=Math.max(account.lastDataAt,...orders.map(o=>o.timestamp),Number(store.db.prepare('SELECT MAX(timestamp) AS at FROM recorded_books').get()?.at ?? 0));
    const sources=store.get<{sources:{league:string;checksum:string;sources:{url:string;sha256:string}[]}[]}>('meta','football:status');
    const rows=orders.filter(o=>o.side==='BUY'&&o.strategy==='football-value').map(order=>{
      const entries=fills.filter(f=>f.orderId===order.id),quantity=entries.reduce((n,f)=>n+f.quantity,0),basis=money(entries.reduce((n,f)=>n+f.gross+f.fees,0));
      const signal=store.get<Frame>('meta',`signal:${order.pairId}`);
      const saleOrders=new Set(orders.filter(o=>o.pairId===order.pairId&&o.side==='SELL').map(o=>o.id));
      const sales=fills.filter(f=>saleOrders.has(f.orderId));
      const official=settlements.filter(x=>x.marketId===order.marketId&&x.resolution);
      const position=store.get<Position>('positions',order.tokenId);
      const mark=position?.quantity ? position.mark : 0;
      const actualNet=money(sales.reduce((n,f)=>n+f.gross-f.fees,0)+official.reduce((n,x)=>n+(x.payout ?? 0)-x.gas,0)+mark-basis);
      const at=entries[0]?.timestamp ?? order.timestamp;
      const probability=order.outcome==='YES' ? order.forecast?.probability : order.forecast ? 1-order.forecast.probability : undefined;
      const titleDate=order.title?.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
      return {order,entries,quantity,basis,entryAt:at,price:quantity ? entries.reduce((n,f)=>n+f.gross,0)/quantity : null,entryFees:money(entries.reduce((n,f)=>n+f.fees,0)),probability,
        signal:signal ? {id:signal.id,sha256:sha(JSON.stringify(signal)),source:signal.source,feeRate:signal.feeRate,mergeGasUsd:signal.mergeGasUsd,recoveryGasUsd:signal.recoveryGasUsd,paperGas:signal.paperGas,yes:signal.yes,no:signal.no} : null,
        forecastSources:sources?.sources.filter(s=>s.checksum===order.forecast?.checksum) ?? [],
        timing:{titleDate,verifiedStartUtc:order.football ? new Date(order.football.startAt).toISOString() : null,discrepancy:!!titleDate&&!!order.football&&titleDate!==new Date(order.football.startAt).toISOString().slice(0,10)},
        actual:{netPnl:actualNet,includesOpenMark:!!position?.quantity,position,sales,settlements:official},
        hold:official.length ? {status:'resolución oficial del snapshot',netPnl:money(quantity*official[0].resolution!.payouts[order.outcome==='YES'?0:1]-basis-official[0].gas),evidence:official[0]} : {status:'sin resolución oficial en el snapshot; no se estima resultado',netPnl:null},
        stop10:undefined as undefined|{at:number;netPnl:number;fees:number;gas:number;frameId:string;sha256:string},
        takeProfit10:undefined as undefined|{at:number;netPnl:number;fees:number;gas:number;frameId:string;sha256:string},
        coverage:{samples:0,valid:0,invalid:0,firstAt:null as number|null,lastAt:null as number|null,maxGapMs:0,entryGapMs:null as number|null,trailingGapMs:0},
      };
    });
    const byMarket=new Map(rows.map(r=>[r.order.marketId,r]));
    const ids=[...byMarket.keys()],from=rows.length ? Math.min(...rows.map(r=>r.entryAt)) : sourceTo;
    if (ids.length) for (const raw of store.db.prepare(`SELECT timestamp,market,data FROM recorded_books WHERE timestamp>=? AND market IN (${ids.map(()=>'?').join(',')}) ORDER BY timestamp,rowid`).iterate(from,...ids)) {
      const row=byMarket.get(String(raw.market))!,at=Number(raw.timestamp);if(at<row.entryAt || (row.actual.settlements.length && at>row.actual.settlements[0].timestamp))continue;
      const c=row.coverage;c.samples++;c.maxGapMs=Math.max(c.maxGapMs,at-(c.lastAt??row.entryAt));c.firstAt??=at;c.lastAt=at;c.entryGapMs=c.firstAt-row.entryAt;
      try {
        const bytes=raw.data as Uint8Array,frame=validateFrame(JSON.parse(gunzipSync(bytes,{maxOutputLength:8*1024*1024}).toString()));
        const b=row.order.outcome==='YES'?frame.yes:frame.no;
        if(frame.marketId!==row.order.marketId||b.tokenId!==row.order.tokenId||!frame.feeVerified||!freshBook(b,frame.timestamp,config.maxDataAgeMs)||!(frame.gasVerified||frame.paperGas)||row.quantity<b.minSize) {c.invalid++;continue;}
        const exit=quote(b.bids,row.quantity,frame.feeRate,'SELL');if(!exit){c.invalid++;continue;}c.valid++;
        const netPnl=money(exit.gross-exit.fees-frame.recoveryGasUsd-row.basis);
        const sample={at,netPnl,fees:exit.fees,gas:frame.recoveryGasUsd,frameId:frame.id,sha256:sha(bytes)};
        if(netPnl<=-.1*row.basis)row.stop10??=sample;
        if(netPnl>=.1*row.basis)row.takeProfit10??=sample;
      }catch{c.invalid++;}
    }
    for(const row of rows)row.coverage.trailingGapMs=(row.actual.settlements[0]?.timestamp ?? sourceTo)-(row.coverage.lastAt??row.entryAt);
    return {schema:1,kind:'football-eleven-entry-review',mode:'paper',from,to:sourceTo,account,config,rows,
      limitations:[
        'Fills y costes paper simulados. La política actual es la contabilidad del snapshot; incluye valoraciones abiertas cuando se indica.',
        'Stop neto del 10% y take-profit observado se calculan con profundidad ejecutable completa, comisiones y gas del frame; son contrafactuales, no fills ni beneficios registrados.',
        'El primer cruce observado no demuestra el primer cruce real. Se muestran huecos, primer/último dato y muestras inválidas; no se interpolan libros ausentes ni se afirma prioridad de cola.',
        'Mantener hasta resolución solo se cuantifica con la resolución oficial conservada. Una posición vendida sin prueba de resolución no tiene resultado final inferido.',
        'No se promueve ninguna variante con estos mismos once casos. Se requiere un protocolo fijado y otra muestra prospectiva antes de cambiar la salida.',
        'Gamma consultado después de esta captura solo verifica metadatos actuales; no es historia anterior. Los títulos y horarios se conservan por separado.',
      ]};
  });
}
