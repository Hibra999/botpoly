import {it,expect} from 'vitest';
import {evaluateFootball,scores} from './football-evaluation.js';
import type {FootballDataset} from '../strategies/football.js';
it('mide probabilidades y conserva periodos sin usar resultados futuros',()=>{
 expect(scores([1,0,0],0).brier).toBe(0);expect(scores([1,0,0],0).logLoss).toBeCloseTo(0);
 expect(()=>scores([.5,.5,.5],0)).toThrow();
 const matches=Array.from({length:25},(_,i)=>({date:Date.UTC(2025,5,10+i),home:i%2?'A':'B',away:i%2?'B':'A',hg:2,ag:1,closing:[2,3,4] as [number,number,number]}));
 const data:FootballDataset={matches,checksum:'test',sources:[],verifiedAt:Date.UTC(2026,8,6)};
 const result=evaluateFootball(new Map([['epl',data]]));expect(result.rows.some(r=>r.period==='evaluation')).toBe(true);expect(result.rows.some(r=>r.period==='development')).toBe(true);
 const first=result.rows[0];matches.push({date:Date.UTC(2025,8,1),home:'A',away:'B',hg:20,ag:0,closing:[2,3,4]});
 expect(evaluateFootball(new Map([['epl',data]])).rows[0]).toEqual(first);
 expect(result.coverage.epl.insufficient).toBe(10);expect(result.summary.evaluation.model.n).toBeGreaterThan(0);
 expect(result.kind).toBe('football-predictive-evaluation');expect(result).not.toHaveProperty('netPnl');
});
