import {it,expect} from 'vitest';
import {fitGoalRates,poisson,scoreProbabilities,type Match} from '../strategies/football.js';
import {compareFootball,fitCorrection,calibration} from './football-comparison.js';
import {evaluateFootball} from './football-evaluation.js';

it('fits only past days, preserves baseline predictions and reports comparable calibration without authorizing sizing',()=>{
  const date=Date.UTC(2025,6,1),day=86400000;
  const matches:Match[]=Array.from({length:100},(_,i)=>({date:date-(100-i)*day,home:i%2?'B':'A',away:i%2?'A':'B',hg:[0,1,2,1][i%4],ag:[0,1,1,2][i%4]}));
  const correction=fitCorrection(matches,date)!;expect(correction.n).toBe(100);expect(correction.rho).toBeLessThan(0);
  const rates=fitGoalRates(matches,date)('A','B')!;
  const base=scoreProbabilities(rates.lh,rates.la)!,dc=scoreProbabilities(rates.lh,rates.la,correction.rho)!;
  expect(dc.draw).toBeGreaterThan(base.draw);expect(dc.home+dc.draw+dc.away).toBeCloseTo(1,12);
  expect(poisson(matches,'A','B',date)).toEqual({...base,sampleSize:100});
  expect(scoreProbabilities(2,2,1)).toBeUndefined();
  const recent=fitGoalRates(matches,date,365)('A','B')!;expect(recent.lh).not.toBe(rates.lh);
  const current={date,home:'A',away:'B',hg:0,ag:0,closing:[2,3,4] as [number,number,number]};
  const data={matches:[...matches,current],sources:[],checksum:'fixture',verifiedAt:date};
  const result=compareFootball(new Map([['fixture',data]]));
  const changed=compareFootball(new Map([['fixture',{...data,matches:[...matches,{...current,hg:12,ag:10},{...current,date:date+day}]}]]));
  expect(result.rows.filter(r=>r.date===date).map(r=>r.probabilities)).toEqual(changed.rows.filter(r=>r.date===date).map(r=>r.probabilities));
  const old=evaluateFootball(new Map([['fixture',data]]));
  expect(result.rows.filter(r=>r.model==='poisson-clubs-v1').map(r=>r.probabilities)).toEqual(old.rows.map(r=>r.probabilities));
  for(const s of result.summary){expect(s.commonCases.n).toBeLessThanOrEqual(s.ownCoverage.n);expect(result.summary.filter(x=>x.period===s.period&&x.league===s.league).every(x=>x.commonCases.n===s.commonCases.n)).toBe(true);expect(s.sizingApproved).toBe(false);for(const outcome of [0,1,2])expect(s.calibration.filter(c=>c.outcome===outcome).reduce((sum,c)=>sum+c.n,0)).toBe(s.commonCases.n);}
  const bin=calibration([{probabilities:[1,0,0],actual:0}]).find(c=>c.outcome===0&&c.n===1)!;
  expect(bin.observed).toBe(1);expect(bin.forecast).toBe(1);expect(bin.status).toBe('muestra-insuficiente');expect(bin.observedWilson95![1]).toBeCloseTo(1);expect(result.liveEligible).toBe(false);
});
