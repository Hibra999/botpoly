// Synthetic performance replay only: no exchange, signers, Telegram API or trading authorization.
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {mkdirSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
const [variant,rootArg,directoryArg,secondsArg='120']=process.argv.slice(2);
if(!['baseline','headless'].includes(variant)||!rootArg||!directoryArg)throw Error('variant root output seconds');
const root=resolve(rootArg),directory=resolve(directoryArg),seconds=Number(secondsArg),modern=variant==='headless';
const load=relative=>import(pathToFileURL(resolve(root,modern ? `dist/src/${relative}.js` : `src/${relative}.ts`)).href);
globalThis.fetch=async()=>{throw Error('Network disabled in replay');};
await load('app/main'); // Include actual production module graph and baseline tsx overhead.
const {Store}=await load('engine/store'),{Ledger}=await load('engine/ledger'),{Engine}=await load('engine/engine'),{PaperExecutor}=await load('engine/paper'),{defaults}=await load('engine/model'),{Controller}=await load('app/control'),{BookStream}=await load('research/book-stream');
const {writePaperReport,writePaperChart}=await load('research/paper-report');
const {ObservedSizing}=modern ? await load('engine/sizing') : {};
const {ReportWorker}=modern ? await load('research/report-worker') : {};
mkdirSync(directory,{recursive:true,mode:0o700});
let now=Date.UTC(2026,8,7,12);
const store=new Store(resolve(directory,'replay.sqlite')),ledger=new Ledger(store,'paper',defaults,()=>now),engine=new Engine(ledger,new PaperExecutor('paper',async()=>undefined,()=>now));
engine.health(true);ledger.stop('Replay sintético de rendimiento: entradas detenidas');
const books=new BookStream({},()=>now),sizing=modern ? new ObservedSizing(store) : undefined;
const worker=modern ? new ReportWorker(ledger,resolve(directory,'reports')) : undefined;
let dashboard;
if(!modern){const {createDashboard}=await load('dashboard/server');dashboard=createDashboard(new Controller(engine),{port:0,passwordHash:'a'.repeat(32)+':'+ 'b'.repeat(64)});await dashboard.start();}
const frame=(i,step)=>{
  const book=tokenId=>({tokenId,hash:`${tokenId}:${step}`,timestamp:now,verifiedAt:now,bids:Array.from({length:10},(_,j)=>({price:.44-j*.01,size:100+j})),asks:Array.from({length:10},(_,j)=>({price:.51+j*.01,size:100+j})),minSize:5,tickSize:.01});
  return {id:`${i}:${step}`,timestamp:now,marketId:`synthetic-${i}`,eventId:`e${i}`,underlying:`e${i}`,title:'SYNTHETIC PERFORMANCE ONLY',yes:book(`y${i}`),no:book(`n${i}`),binary:true,negRisk:false,feeRate:.05,feeVerified:true,mergeGasUsd:.02,recoveryGasUsd:.01,gasVerified:true,source:'Deterministic synthetic replay; not profitability evidence',depth:true};
};
const latencies=[],reportTimes=[],jobs=[],inputHash=createHash('sha256'),started=performance.now(),interval=500,steps=Math.floor(seconds*1000/interval);
console.log(JSON.stringify({phase:'ready',pid:process.pid,variant,steps,markets:200}));
try{
 for(let step=0;step<steps;step++){
  const target=started+step*interval;await sleep(Math.max(0,target-performance.now()));now=Date.UTC(2026,8,7,12)+step*interval;
  const frames=Array.from({length:200},(_,i)=>frame(i,step));
  inputHash.update(JSON.stringify(frames));
  for(const f of frames){
   books.identities.set(f.yes.tokenId,f.marketId);books.identities.set(f.no.tokenId,f.marketId);books.books.set(f.yes.tokenId,f.yes);books.books.set(f.no.tokenId,f.no);books.changed.add(f.marketId);
   if(sizing){if(step%600===0)sizing.gamma(f.marketId,100000,now,'Synthetic Gamma replay');sizing.midpoint(f);f.sizing=sizing.evidence(f.marketId,now);}
   if(step%20===0)store.recordBook(f);
  }
  books.takeChanges();await engine.processBatch(frames);
  if(step%120===0)engine.recordEquity();
  if(step===Math.floor(steps/3)||step===Math.floor(2*steps/3)){
   const at=performance.now(),out=resolve(directory,'reports',`report-${step}`);
   if(modern)jobs.push(worker.generate(out).then(result=>{if(result.chartError)throw Error('Render failed');reportTimes.push(performance.now()-at);}));
   else {writePaperReport(ledger,out);await writePaperChart(out);reportTimes.push(performance.now()-at);}
  }
  latencies.push({step,elapsedMs:performance.now()-started,latencyMs:performance.now()-target,rss:process.memoryUsage().rss,heap:process.memoryUsage().heapUsed});
 }
 await Promise.all(jobs);
 const result={variant,node:process.versions.node,seconds,interval,markets:200,steps,inputSha256:inputHash.digest('hex'),config:ledger.config,reportTimes,latencies,orders:store.all('orders').length,recorded:Number(store.db.prepare('SELECT count(*) AS n FROM recorded_books').get().n),limitations:['Synthetic performance only, empty paused account, 200 markets × 2 legs × 10 levels, same replay and costs; no execution/fill latency or exchange/API conditions measured.','Baseline uses original TypeScript module graph and idle loopback dashboard; headless uses compiled JavaScript and production report worker. No browser client.','Both resolve the same installed dependencies; transport unused, so SDK patch does not affect replay.','RSS includes shared pages multiple times when summing process trees; CPU includes report/render children. Sampling may miss sub-100ms peaks.']};
 writeFileSync(resolve(directory,'result.json'),JSON.stringify(result,null,2));
 console.log(JSON.stringify({phase:'complete',variant,reports:reportTimes.length,hash:result.inputSha256}));
}finally{worker?.stop();await dashboard?.close();store.close();}
