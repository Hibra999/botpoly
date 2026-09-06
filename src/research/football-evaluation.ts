import { footballPolicy } from '../engine/model.js';
import { poisson, type FootballDataset } from '../strategies/football.js';
export const footballPeriods = {
  development: {from:Date.UTC(2023,6,1),to:Date.UTC(2025,6,1)},
  evaluation: {from:Date.UTC(2025,6,1),to:Date.UTC(2026,6,1)},
} as const;
type Probabilities=[number,number,number];
export interface PredictionRow {league:string;period:keyof typeof footballPeriods;date:number;home:string;away:string;actual:number;probabilities:Probabilities;reference:Probabilities;closing?:Probabilities;checksum:string;sampleSize:number}
export function scores(p: Probabilities, actual:number) {
  if (!p.every(n=>Number.isFinite(n)&&n>=0&&n<=1) || Math.abs(p.reduce((s,n)=>s+n,0)-1)>1e-8 || ![0,1,2].includes(actual)) throw new Error('Probabilidad o resultado inválido');
  return {brier:p.reduce((s,n,i)=>s+(n-(i===actual?1:0))**2,0),logLoss:-Math.log(Math.max(1e-12,p[actual]))};
}
function metrics(rows:PredictionRow[], source:'probabilities'|'reference'|'closing') {
  const selected=rows.filter(r=>r[source]);
  if (!selected.length) return {n:0,brier:null,logLoss:null};
  const values=selected.map(r=>scores(r[source]!,r.actual));
  return {n:selected.length,brier:values.reduce((s,n)=>s+n.brier,0)/values.length,logLoss:values.reduce((s,n)=>s+n.logLoss,0)/values.length};
}
export function evaluateFootball(datasets: ReadonlyMap<string,FootballDataset>) {
  const rows:PredictionRow[]=[],coverage:Record<string,{eligible:number;predicted:number;insufficient:number}>={};
  for (const [league,data] of datasets) {
    const c=coverage[league]={eligible:0,predicted:0,insufficient:0};
    for (const match of data.matches) {
      const period=(Object.keys(footballPeriods) as (keyof typeof footballPeriods)[]).find(key=>match.date>=footballPeriods[key].from&&match.date<footballPeriods[key].to);
      if (!period) continue;
      c.eligible++;
      const p=poisson(data.matches,match.home,match.away,match.date);
      if (!p) {c.insufficient++;continue;}
      const history=data.matches.filter(m=>m.date<match.date&&m.date>=match.date-footballPolicy.historyDays*86400000);
      const frequencies=[0,0,0];for(const m of history)frequencies[m.hg>m.ag?0:m.hg===m.ag?1:2]++;
      const reference=frequencies.map(n=>n/history.length) as Probabilities;
      const inv=match.closing?.map(n=>1/n),total=inv?.reduce((s,n)=>s+n,0);
      rows.push({league,period,date:match.date,home:match.home,away:match.away,actual:match.hg>match.ag?0:match.hg===match.ag?1:2,probabilities:[p.home,p.draw,p.away],reference,closing:inv&&total?inv.map(n=>n/total) as Probabilities:undefined,checksum:data.checksum,sampleSize:p.sampleSize});c.predicted++;
    }
  }
  const summary=Object.fromEntries((Object.keys(footballPeriods) as (keyof typeof footballPeriods)[]).map(period=>{
    const selected=rows.filter(r=>r.period===period),complete=selected.filter(r=>r.closing);
    return [period,{model:metrics(selected,'probabilities'),historicalReference:metrics(selected,'reference'),modelWithClosing:metrics(complete,'probabilities'),closingReference:metrics(complete,'closing'),calibration:[0,1,2].flatMap(outcome=>Array.from({length:10},(_,bin)=>{
      const group=selected.filter(r=>Math.min(9,Math.floor(r.probabilities[outcome]*10))===bin);
      return {outcome,from:bin/10,to:(bin+1)/10,n:group.length,forecast:group.length?group.reduce((s,r)=>s+r.probabilities[outcome],0)/group.length:null,observed:group.length?group.filter(r=>r.actual===outcome).length/group.length:null};
    }))}];
  }));
  return {schema:1,kind:'football-predictive-evaluation',status:'exploratorio',policy:footballPolicy,periods:footballPeriods,trials:[{id:footballPolicy.version,parameters:footballPolicy,selection:'Un único modelo predefinido; sin seleccionar parámetros con evaluación'}],coverage,summary,rows};
}
