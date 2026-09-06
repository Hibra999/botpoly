import {footballPolicy} from '../engine/model.js';
import {fitGoalRates, scoreProbabilities, type Match, type FootballDataset} from '../strategies/football.js';
import {footballPeriods, scores} from './football-evaluation.js';

export const comparisonTrials = [
  {id:'poisson-clubs-v1',halfLifeDays:null,correction:false},
  {id:'poisson-recency-365',halfLifeDays:365,correction:false},
  {id:'poisson-dc-correction',halfLifeDays:null,correction:true},
  {id:'poisson-recency-365-dc',halfLifeDays:365,correction:true},
] as const;
type Probability = [number,number,number];
export interface ComparisonRow {
  league:string; period:keyof typeof footballPeriods; model:string; date:number; home:string; away:string;
  actual:number; probabilities:Probability; closing?:Probability; checksum:string; sampleSize:number;
  lh:number; la:number; rho:number; rhoTraining:number;
}
/** Conditional fit: intensities stay fixed. Concavity makes one-dimensional bisection sufficient. */
export function fitCorrection(matches: Match[], before: number, halfLifeDays=Infinity) {
  const past=matches.filter(m=>m.date<before && m.date>=before-footballPolicy.historyDays*86400000);
  const rates=fitGoalRates(past,before,halfLifeDays), terms:{c:number;w:number}[]=[];
  let lo=-.2,hi=.2,n=0;
  for (const m of past) {
    const r=rates(m.home,m.away);if(!r)continue;
    n++;lo=Math.max(lo,-1/r.lh+1e-8,-1/r.la+1e-8);hi=Math.min(hi,1/(r.lh*r.la)-1e-8);
    const c=m.hg===0 && m.ag===0 ? -r.lh*r.la : m.hg===0 && m.ag===1 ? r.lh : m.hg===1 && m.ag===0 ? r.la : m.hg===1 && m.ag===1 ? -1 : 0;
    if(c)terms.push({c,w:Math.exp(-Math.LN2*(before-m.date)/(halfLifeDays*86400000))});
  }
  if(terms.length<20 || lo>=hi)return undefined;
  const derivative=(rho:number)=>terms.reduce((sum,t)=>sum+t.w*t.c/(1+t.c*rho),0);
  if(derivative(lo)<=0)return {rho:lo,n,lowScores:terms.length,boundary:true};
  if(derivative(hi)>=0)return {rho:hi,n,lowScores:terms.length,boundary:true};
  while(hi-lo>1e-10){const mid=(lo+hi)/2;if(derivative(mid)>0)lo=mid;else hi=mid;}
  return {rho:(lo+hi)/2,n,lowScores:terms.length,boundary:false};
}
function metric(rows:ComparisonRow[], source:'probabilities'|'closing'='probabilities') {
  const values=rows.filter(r=>r[source]).map(r=>scores(r[source]!,r.actual));
  return {n:values.length,brier:values.length?values.reduce((s,v)=>s+v.brier,0)/values.length:null,logLoss:values.length?values.reduce((s,v)=>s+v.logLoss,0)/values.length:null};
}
export function calibration(rows: Pick<ComparisonRow,'probabilities'|'actual'>[]) {
  return [0,1,2].flatMap(outcome=>Array.from({length:10},(_,bin)=>{
    const group=rows.filter(r=>Math.min(9,Math.floor(r.probabilities[outcome]*10))===bin),n=group.length;
    const observed=n?group.filter(r=>r.actual===outcome).length/n:null;
    const forecast=n?group.reduce((s,r)=>s+r.probabilities[outcome],0)/n:null;
    const z=1.959963984540054,den=1+z*z/n,center=observed===null?0:(observed+z*z/(2*n))/den;
    const radius=observed===null?0:z*Math.sqrt(observed*(1-observed)/n+z*z/(4*n*n))/den;
    return {outcome,from:bin/10,to:(bin+1)/10,n,forecast,observed,gap:observed===null?null:observed-forecast!,observedWilson95:observed===null?null:[Math.max(0,center-radius),Math.min(1,center+radius)],status:n<30?'muestra-insuficiente':'descriptivo',sizingApproved:false};
  }));
}
export function compareFootball(datasets: ReadonlyMap<string,FootballDataset>) {
  const rows:ComparisonRow[]=[], coverage:{league:string;period:string;model:string;eligible:number;predicted:number;insufficientHistory:number;insufficientCorrection:number;invalidCorrection:number}[]=[];
  const fits:{league:string;date:number;halfLifeDays:number|null;rho:number;n:number;lowScores:number;boundary:boolean}[]=[];
  for(const [league,data] of datasets) {
    const days=[...new Set(data.matches.map(m=>m.date))].sort((a,b)=>a-b);
    for(const date of days) {
      const period=(Object.keys(footballPeriods) as (keyof typeof footballPeriods)[]).find(k=>date>=footballPeriods[k].from && date<footballPeriods[k].to);
      if(!period)continue;
      const matches=data.matches.filter(m=>m.date===date);
      for(const halfLifeDays of [null,365]) {
        const rates=fitGoalRates(data.matches,date,halfLifeDays??Infinity), correction=fitCorrection(data.matches,date,halfLifeDays??Infinity);
        if(correction)fits.push({league,date,halfLifeDays,...correction});
        for(const model of comparisonTrials.filter(t=>t.halfLifeDays===halfLifeDays)) {
          let count=coverage.find(c=>c.league===league && c.period===period && c.model===model.id);
          if(!count){count={league,period,model:model.id,eligible:0,predicted:0,insufficientHistory:0,insufficientCorrection:0,invalidCorrection:0};coverage.push(count);}
          for(const match of matches) {
            count.eligible++;const r=rates(match.home,match.away);
            if(!r){count.insufficientHistory++;continue;}
            if(model.correction && !correction){count.insufficientCorrection++;continue;}
            const rho=model.correction?correction!.rho:0,p=scoreProbabilities(r.lh,r.la,rho);
            if(!p){count.invalidCorrection++;continue;}
            const inv=match.closing?.map(n=>1/n),total=inv?.reduce((s,n)=>s+n,0);
            rows.push({league,period,model:model.id,date,home:match.home,away:match.away,actual:match.hg>match.ag?0:match.hg===match.ag?1:2,probabilities:[p.home,p.draw,p.away],closing:inv&&total?inv.map(n=>n/total) as Probability:undefined,checksum:data.checksum,...r,rho,rhoTraining:model.correction?correction!.n:0});count.predicted++;
          }
        }
      }
    }
  }
  const key=(r:ComparisonRow)=>JSON.stringify([r.league,r.date,r.home,r.away]),counts=new Map<string,number>();
  for(const r of rows)counts.set(key(r),(counts.get(key(r))??0)+1);
  const common=rows.filter(r=>counts.get(key(r))===comparisonTrials.length);
  const summary=(Object.keys(footballPeriods) as (keyof typeof footballPeriods)[]).flatMap(period=>['all',...datasets.keys()].flatMap(league=>comparisonTrials.map(model=>{
    const selected=rows.filter(r=>r.period===period && (league==='all'||r.league===league) && r.model===model.id),matched=common.filter(r=>r.period===period && (league==='all'||r.league===league) && r.model===model.id),withClosing=matched.filter(r=>r.closing);
    return {period,league,model:model.id,ownCoverage:metric(selected),commonCases:metric(matched),modelWithClosing:metric(withClosing),closingReference:metric(withClosing,'closing'),calibration:calibration(matched),sizingApproved:false};
  })));
  return {schema:1,kind:'football-model-comparison',status:'exploratorio',liveEligible:false,candidateSizingApproved:false,policy:footballPolicy,periods:footballPeriods,trials:comparisonTrials,coverage,summary,fits,rows};
}
