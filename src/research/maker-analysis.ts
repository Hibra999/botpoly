import {createPublicClient,type OrderBook} from '@polymarket/client';
import {BookStream,type MarketEvent} from './book-stream.js';
import {freshBook,quote,money} from '../engine/model.js';

export const makerProtocol={notionalUsd:10,entryLatencyMs:250,quoteLifetimeMs:60000,cancelLatencyMs:250,maxBookAgeMs:5000,gasScenariosUsd:[.01,.03],makerFeeRate:0,rebatesUsd:0,clock:'client-received-time',queueScenarios:['zero-ahead','visible-depth-ahead']} as const;
type Metadata={marketId:string;tokens:{assetId:string;outcome:string}[];feeInfo:{rate:number;exponent:number};secondsDelay:number};
interface ShadowQuote {token:string;marketId:string;line:number;requestedAt:number;arrivalAt:number;cancelAt:number;cancelAckAt:number;price:number;quantity:number;feeRate:number;sourceHash?:string;referenceTakerCost:number|null;active:boolean;invalid?:string;queueAhead:number;sellVolume:number;cancelWindowVolume:number;tradeLines:number[];depthReduction:number;}
const object=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw Error('Registro de eventos inválido');return v as Record<string,unknown>;};
const token=(v:unknown)=>typeof v==='string'&&/^\d{1,80}$/.test(v);
const condition=(v:unknown)=>typeof v==='string'&&/^0x[a-f0-9]{64}$/i.test(v);
export function analyzeMaker(records:Iterable<unknown>) {
  let now=0,from=0,line=0,ended=false;
  // Only snapshot/ingest are used; this offline replay never connects or submits orders.
  const stream=new BookStream(createPublicClient(),()=>now),metadata=new Map<string,Metadata>(),active=new Map<string,ShadowQuote>(),nextQuoteAt=new Map<string,number>(),seenTrades=new Set<string>();
  const counts:Record<string,number>={},rows:(ShadowQuote&{status:string;scenarios:{queue:string;quantity:number;partial:boolean;exitStatus:string;exitFees:number|null;netBeforeGasUsd:number|null;gasSensitivity:{gasUsd:number;hypotheticalNetUsd:number}[]}[]})[]=[];
  const count=(key:string,n=1)=>{counts[key]=(counts[key]??0)+n;};
  const invalidate=(reason:string,id?:string)=>{for(const q of active.values())if(!id||q.marketId===id)q.invalid??=reason;};
  function finish(q:ShadowQuote,status='closed') {
    const book=stream.books.get(q.token);
    const scenarios=makerProtocol.queueScenarios.map(queue=>{
      const quantity=money(Math.max(0,Math.min(q.quantity,q.sellVolume-(queue==='visible-depth-ahead'?q.queueAhead:0))));
      const exit=status==='closed'&&!q.invalid&&quantity>0&&book&&freshBook(book,q.cancelAckAt,makerProtocol.maxBookAgeMs)&&quantity>=book.minSize?quote(book.bids,quantity,q.feeRate,'SELL'):null;
      const net=exit?money(exit.gross-exit.fees-quantity*q.price):null;
      return {queue,quantity,partial:quantity>0&&quantity<q.quantity,exitStatus:q.invalid||status!=='closed'?'invalid-window':!quantity?'no-hypothetical-fill':exit?'observed-executable':'missing-stale-or-below-minimum',exitFees:exit?.fees??null,netBeforeGasUsd:net,gasSensitivity:net===null?[]:makerProtocol.gasScenariosUsd.map(gasUsd=>({gasUsd,hypotheticalNetUsd:money(net-gasUsd)}))};
    });
    rows.push({...q,status:q.invalid?'invalid':status,scenarios});active.delete(q.token);
  }
  function advance(at:number) {
    for(const q of active.values()) {
      if(!q.active && !q.invalid && at>=q.arrivalAt) {
        const b=stream.books.get(q.token);
        if(!b||!freshBook(b,q.arrivalAt,makerProtocol.maxBookAgeMs))q.invalid='arrival-book-stale';
        else if(!b.asks.length||q.price>=b.asks[0].price||q.quantity<b.minSize||Math.abs(q.price/b.tickSize-Math.round(q.price/b.tickSize))>1e-7)q.invalid='post-only-or-minimum-rejected';
        else {q.active=true;q.queueAhead=b.bids.find(l=>l.price===q.price)?.size??0;}
      }
      if(at>=q.cancelAckAt)finish(q);
    }
  }
  for(const value of records) {
    if(ended)throw Error('Eventos posteriores al cierre de captura');
    line++;const r=object(value),at=r.receivedAt;
    if(r.schema!==1||!Number.isSafeInteger(at)||Number(at)<=0||Number(at)<now||typeof r.kind!=='string')throw Error(`Registro o reloj inválido en línea ${line}`);
    now=Number(at);from ||= now;advance(now-1);count(r.kind);
    const payload=object(r.payload);
    if(r.kind==='metadata') {
      const m=payload as unknown as Metadata;
      if(!condition(m.marketId)||!Array.isArray(m.tokens)||m.tokens.length!==2||m.tokens.some(t=>!token(t.assetId)||typeof t.outcome!=='string')||new Set(m.tokens.map(t=>t.assetId)).size!==2||new Set(m.tokens.map(t=>t.outcome.toLowerCase())).size!==2||m.tokens.some(t=>!['yes','no'].includes(t.outcome.toLowerCase()))||!m.feeInfo||!Number.isFinite(m.feeInfo.rate)||m.feeInfo.rate<0||m.feeInfo.rate>1||!(m.feeInfo.rate===0||m.feeInfo.exponent===1)||!Number.isFinite(m.secondsDelay)||m.secondsDelay<0||m.secondsDelay>60)throw Error(`Metadatos inválidos en línea ${line}`);
      for(const t of m.tokens){if(stream.identities.has(t.assetId)&&stream.identities.get(t.assetId)!==m.marketId)throw Error('Identidad contradictoria');stream.identities.set(t.assetId,m.marketId);metadata.set(t.assetId,m);}
    } else if(r.kind==='snapshot') {
      const b=payload as unknown as OrderBook;
      if(!stream.identities.has(b.assetId))count('unwatchedSnapshot');
      else try{stream.snapshot(b,now);}catch{count('invalidSnapshot');invalidate('invalid-snapshot',stream.identities.get(b.assetId));for(const [t,id] of stream.identities)if(id===stream.identities.get(b.assetId))stream.books.delete(t);}
    } else if(r.kind==='event') {
      if(payload.topic!=='market'||typeof payload.type!=='string')throw Error(`Evento inválido en línea ${line}`);
      const event=payload as unknown as MarketEvent,p=object(payload.payload);count(`event:${event.type}`);
      if(!['book','price_change','last_trade_price','best_bid_ask','tick_size_change','market_resolved','new_market'].includes(event.type))throw Error('Tipo de evento público no soportado');
      if(event.type==='price_change' && Array.isArray(p.priceChanges))for(const raw of p.priceChanges){const c=object(raw);if(c.side==='BUY'&&typeof c.assetId==='string'){const b=stream.books.get(c.assetId),old=b?.bids.find(l=>l.price===Number(c.price)),size=Number(c.size);if(old&&Number.isFinite(size)&&size>=0&&size<old.size){count('depthDecreases');const q=active.get(c.assetId);if(q&&q.price===Number(c.price))q.depthReduction+=old.size-size;}}}
      const invalid=stream.status.invalid;
      try{stream.ingest(event);}catch{count('malformedBookEvent');invalidate('malformed-book-event',typeof p.conditionId==='string'?p.conditionId:undefined);stream.books.clear();}
      if(stream.status.invalid>invalid){count('bookInvalidations');invalidate('book-invalidated',typeof p.conditionId==='string'?p.conditionId:undefined);}
      if(event.type==='last_trade_price') {
        const id=String(p.assetId),m=metadata.get(id);if(!m){count('unwatchedTrade');continue;}
        const price=Number(p.price),size=Number(p.size),time=Number(p.timestamp);
        if(p.conditionId!==m.marketId||!Number.isFinite(price)||price<=0||price>=1||!Number.isFinite(size)||size<=0||!Number.isSafeInteger(time)||time<=0||time>now||!['BUY','SELL'].includes(String(p.side))){count('invalidTrade');invalidate('invalid-trade',m.marketId);continue;}
        const identity=JSON.stringify([id,time,price,size,p.side,p.transactionHash??null]);if(seenTrades.has(identity)){count('duplicateTrade');continue;}seenTrades.add(identity);count('validatedTrades');
        const q=active.get(id);if(q&&now-time>makerProtocol.maxBookAgeMs)q.invalid='delayed-trade';
        if(q?.active&&!q.invalid&&p.side==='SELL'&&Math.abs(price-q.price)<1e-9&&now<q.cancelAckAt){q.sellVolume+=size;q.tradeLines.push(line);if(now>=q.cancelAt)q.cancelWindowVolume+=size;}
      }
    } else if(r.kind==='gap'){count('explicitGaps');invalidate('capture-gap');stream.books.clear();}
    else if(r.kind==='heartbeat'){if(payload.connected!==true){invalidate('disconnected-heartbeat');stream.books.clear();}}
    else if(r.kind==='end'){ended=true;if(payload.healthy!==true)invalidate('unhealthy-end');}
    else throw Error(`Tipo de registro desconocido en línea ${line}`);
    advance(now);
    if(r.kind==='end')continue;
    for(const [id,b] of stream.books) {
      if(active.has(id)||now<(nextQuoteAt.get(id)??0)||!freshBook(b,now,makerProtocol.maxBookAgeMs)||!b.bids.length||!b.asks.length||b.bids[0].price>=b.asks[0].price)continue;
      const m=metadata.get(id);if(!m)continue;const price=b.bids[0].price,quantity=Math.floor(makerProtocol.notionalUsd/price*100)/100;if(quantity<b.minSize)continue;
      const taker=quote(b.asks,quantity,m.feeInfo.rate,'BUY'),arrivalAt=now+makerProtocol.entryLatencyMs+m.secondsDelay*1000,cancelAt=arrivalAt+makerProtocol.quoteLifetimeMs;
      active.set(id,{token:id,marketId:m.marketId,line,requestedAt:now,arrivalAt,cancelAt,cancelAckAt:cancelAt+makerProtocol.cancelLatencyMs,price,quantity,feeRate:m.feeInfo.rate,sourceHash:b.hash,referenceTakerCost:taker?money(taker.gross+taker.fees):null,active:false,queueAhead:0,sellVolume:0,cancelWindowVolume:0,tradeLines:[],depthReduction:0});nextQuoteAt.set(id,cancelAt+makerProtocol.cancelLatencyMs);
    }
  }
  for(const q of active.values())finish(q,'capture-ended');
  const summary=makerProtocol.queueScenarios.map(queue=>{
    const complete=rows.filter(q=>q.status==='closed').map(q=>q.scenarios.find(s=>s.queue===queue)!);
    return {queue,completedWindows:complete.length,withHypotheticalFills:complete.filter(s=>s.quantity>0).length,partial:complete.filter(s=>s.partial).length,quantity:money(complete.reduce((n,s)=>n+s.quantity,0)),executableExits:complete.filter(s=>s.netBeforeGasUsd!==null).length,gasSensitivity:makerProtocol.gasScenariosUsd.map(gasUsd=>({gasUsd,hypotheticalNetUsdOnObservedExits:money(complete.reduce((n,s)=>n+(s.gasSensitivity.find(g=>g.gasUsd===gasUsd)?.hypotheticalNetUsd??0),0))}))};
  });
  return {schema:1,kind:'maker-public-event-research',status:'insuficiente',liveEligible:false,from,to:now,protocol:makerProtocol,counts,watchedTokens:metadata.size,quotes:rows.length,invalidWindows:rows.filter(q=>q.status==='invalid').length,unfinishedWindows:rows.filter(q=>q.status==='capture-ended').length,privateOrderAcknowledgements:0,verifiedQueuePositions:0,verifiedCancellations:0,confirmedFills:0,actualPnl:null,summary,rows,limitations:[
    'Escenarios hipotéticos sobre eventos públicos, sin órdenes ni mutaciones del Ledger; no son fills confirmados ni rentabilidad.',
    'Cero cola previa y profundidad visible previa son supuestos, no límites demostrados de ejecución. No hay prioridad individual, secuencia completa de mercado ni acuses privados.',
    'Una disminución de profundidad puede ser ejecución o cancelación. No se descuenta de la cola ni se convierte en un fill; solo se usa volumen SELL publicado al mismo precio.',
    'Reloj de recepción local y latencias supuestas de entrada/cancelación; se cuenta volumen entre petición y acuse hipotético de cancelación. No acredita la carrera real con el exchange.',
    'No se conoce la reacción del mercado a nuestras órdenes hipotéticas. Mensajes de trades idénticos se deduplican de forma conservadora, sin identidad de fill propia.',
    'Gas de US$0,01 y US$0,03 por salida son sensibilidades supuestas, no precios históricos verificados; comisión maker cero y sin rebates, comisión de salida con metadatos iniciales fijos.',
    'No se valora inventario sin salida fresca, profundidad o cantidad mínima. Los totales de escenarios con salida excluyen esas ventanas; no representan el resultado de toda una estrategia.',
  ]};
}
