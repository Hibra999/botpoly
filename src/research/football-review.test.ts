import {it,expect} from 'vitest';
import {Store} from '../engine/store.js';
import {Ledger} from '../engine/ledger.js';
import {defaults,type Frame} from '../engine/model.js';
import {reviewFootball} from './football-review.js';
import {readDataset} from './dataset.js';
it('conserva pérdidas y payout cero, omite profundidad insuficiente y no usa precios posteriores a resolución',()=>{
  const s=new Store(':memory:');try {
    const f:Frame={...readDataset('fixtures/demo.jsonl').frames[0],id:'review',marketId:'m'};
    const l=new Ledger(s,'paper',defaults,()=>f.timestamp);l.stop('Límite de pérdida diaria');
    s.put('orders','buy',{id:'buy',side:'BUY',strategy:'football-value',marketId:'m',tokenId:f.yes.tokenId,pairId:'pair',outcome:'YES',timestamp:f.timestamp});
    s.put('fills','fill',{id:'fill',orderId:'buy',quantity:10,gross:5,fees:.1,timestamp:f.timestamp});
    s.put('meta','signal:pair',f);
    f.yes.bids=[{price:.4,size:1}];s.recordBook(f);
    f.id='full';f.timestamp+=1000;f.yes.timestamp=f.no.timestamp=f.timestamp;f.yes.bids=[{price:.4,size:100}];s.recordBook(f);
    s.put('settlements','settled',{marketId:'m',timestamp:f.timestamp,payout:0,gas:.02,resolution:{payouts:[0,1],verifiedAt:f.timestamp,source:'synthetic test',evidence:'test only'}});
    f.id='after';f.timestamp+=1000;f.yes.timestamp=f.no.timestamp=f.timestamp;f.yes.bids=[{price:.9,size:100}];s.recordBook(f);
    const before=l.account,r=reviewFootball(s).rows[0];
    expect(r.actual.netPnl).toBe(-5.12);expect(r.hold.netPnl).toBe(-5.12);expect(r.coverage.invalid).toBe(1);expect(r.coverage.valid).toBe(1);
    expect(r.stop10?.netPnl).toBeLessThan(-.51);expect(r.takeProfit10).toBeUndefined();expect(l.account).toEqual(before);
  }finally{s.close();}
});
