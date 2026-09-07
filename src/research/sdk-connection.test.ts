import {it,expect,vi} from 'vitest';
import {createPublicClient,type OrderBook} from '@polymarket/client';
import {BookStream,type MarketEvent} from './book-stream.js';
it('el SDK reconecta sin cerrar el iterador, notifica inmediatamente y BookStream exige snapshot de la generación vigente',async()=>{
  const sockets:FakeSocket[]=[];
  class FakeSocket extends EventTarget {
    static OPEN=1;static CLOSED=3;static CLOSING=2;readyState=0;
    constructor(){super();sockets.push(this);queueMicrotask(()=>{this.readyState=1;this.dispatchEvent(new Event('open'));});}
    send(){}
    close(){this.readyState=3;this.dispatchEvent(Object.assign(new Event('close'),{code:1006,reason:''}));}
  }
  vi.stubGlobal('WebSocket',FakeSocket);
  const client=createPublicClient(),stream=new BookStream(client);
  const raw=():OrderBook=>({assetId:'y',conditionId:'0x1111111111111111111111111111111111111111111111111111111111111111',timestamp:Date.now(),hash:'snapshot',minOrderSize:'5',tickSize:'.01',bids:[{price:'.4',size:'10'}],asks:[{price:'.5',size:'10'}]}) as unknown as OrderBook;
  try {
    await stream.connect(new Map([['y','0x1111111111111111111111111111111111111111111111111111111111111111']]));stream.snapshot(raw());
    expect(stream.books.size).toBe(1);expect(stream.status.connected).toBe(true);
    const subscribe=vi.spyOn(client,'subscribe');
    sockets[0].close();expect(stream.books.size).toBe(0);expect(stream.status.connected).toBe(false);
    await stream.connect(new Map([['y','0x1111111111111111111111111111111111111111111111111111111111111111']]));expect(subscribe).not.toHaveBeenCalled();
    await vi.waitFor(()=>expect(stream.status.connected).toBe(true));
    expect(sockets).toHaveLength(2);expect(stream.status.reconnects).toBe(2);expect(stream.books.size).toBe(0);
    const event={topic:'market',type:'price_change',payload:{conditionId:'0x1111111111111111111111111111111111111111111111111111111111111111',timestamp:Date.now(),priceChanges:[{assetId:'y',price:'.4',size:'3',side:'BUY',hash:'delta'}]}} as unknown as MarketEvent;
    stream.ingest({...event,connectionGeneration:2});expect(stream.books.size).toBe(0);
    stream.snapshot(raw());stream.ingest({...event,connectionGeneration:1});expect(stream.books.get('y')?.bids[0].size).toBe(10);
    stream.ingest({...event,payload:{...event.payload,timestamp:Date.now()},connectionGeneration:2} as MarketEvent & {connectionGeneration:number});expect(stream.books.get('y')?.bids[0].size).toBe(3);
    sockets[1].dispatchEvent(new MessageEvent('message',{data:JSON.stringify({event_type:'price_change',market:'0x1111111111111111111111111111111111111111111111111111111111111111',timestamp:String(Date.now()),price_changes:[{asset_id:'y',price:'.4',size:'4',side:'BUY',hash:'sdk-delta',best_bid:'.4',best_ask:'.5'}]})}));
    await vi.waitFor(()=>expect(stream.books.get('y')?.bids[0].size).toBe(4));
    let finish!:(books:OrderBook[])=>void;
    vi.spyOn(client,'fetchOrderBooks').mockImplementation(()=>new Promise(r=>finish=r));
    const pending=stream.sync();sockets[1].close();await vi.waitFor(()=>expect(stream.status.connected).toBe(true));
    finish([raw()]);await pending;expect(stream.books.size).toBe(0);
  }finally{await stream.close();vi.unstubAllGlobals();}
});
it('agrupa cambios 100 ms y mantiene vencimiento de mantenimiento y cierre abortable',async()=>{
  vi.useFakeTimers();
  try {
    const b=new BookStream({} as ReturnType<typeof createPublicClient>);
    const done=vi.fn();const pending=b.waitForChanges(2000).then(done);
    b.changed.add('0x1111111111111111111111111111111111111111111111111111111111111111'); // Call the same snapshot path that signals the wakeup.
    b.identities.set('y','0x1111111111111111111111111111111111111111111111111111111111111111');
    b.snapshot({assetId:'y',conditionId:'0x1111111111111111111111111111111111111111111111111111111111111111',timestamp:Date.now(),hash:'a',minOrderSize:'1',tickSize:'.01',bids:[],asks:[]} as unknown as OrderBook);
    await vi.advanceTimersByTimeAsync(99);expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);await pending;expect(done).toHaveBeenCalledOnce();
    b.takeChanges();const abort=new AbortController();const cancelled=b.waitForChanges(2000,abort.signal);abort.abort();await cancelled;
  }finally{vi.useRealTimers();}
});
