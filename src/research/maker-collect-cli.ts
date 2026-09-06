import {createPublicClient} from '@polymarket/client';
import {fetchMarketInfo} from '@polymarket/client/actions';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,writeFileSync,appendFileSync,readFileSync,statfsSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
const {values}=parseArgs({options:{out:{type:'string'},database:{type:'string',default:'.runtime/paper-observation.sqlite'},seconds:{type:'string',default:'720'},limit:{type:'string',default:'20'}}});
const seconds=Number(values.seconds),limit=Number(values.limit);
if(!values.out || !Number.isInteger(seconds) || seconds<1 || seconds>86400 || !Number.isInteger(limit) || limit<1 || limit>100)throw Error('Usa --out DIRECTORIO-NUEVO --seconds 1..86400 --limit 1..100 [--database BASE-PAPER]');
const directory=values.out;mkdirSync(directory,{recursive:false,mode:0o700});
const file=directory+'/events.jsonl', startedAt=Date.now(), durationMs=seconds*1000;
writeFileSync(file,'',{mode:0o600});
const db=new DatabaseSync(values.database!,{readOnly:true});
const watched=(db.prepare("SELECT data FROM meta WHERE id LIKE 'market:%'").all() as {data:string}[]).map(r=>JSON.parse(r.data)).filter(m=>!m.football && m.state.acceptingOrders && !m.state.closed).sort((a,b)=>Number(b.metrics.volume24hr??0)-Number(a.metrics.volume24hr??0)).slice(0,limit);db.close();
const client=createPublicClient(), ids=new Set<string>(), counts:Record<string,number>={};let healthy=true,stopping=false;
const append=(kind:string,payload:unknown)=>{const receivedAt=Date.now();counts[kind]=(counts[kind]??0)+1;appendFileSync(file,JSON.stringify({schema:1,receivedAt,kind,payload})+'\n');return receivedAt;};
for(const market of watched){
 try{const info=await fetchMarketInfo(client,{conditionId:market.conditionId});const tokens=info.tokens.filter(t=>['yes','no'].includes(t.outcome.toLowerCase()));if(tokens.length!==2)throw Error();
  append('metadata',{marketId:market.conditionId,title:market.question,tokens,feeInfo:info.feeInfo,negRisk:info.negRisk,secondsDelay:Number(market.trading.secondsDelay??0)});tokens.forEach(t=>ids.add(t.assetId));
 }catch{healthy=false;append('gap',{reason:'metadata_unavailable',marketId:market.conditionId});}
}
if(!ids.size)throw Error('No eligible public tokens to record');
const handle=await client.subscribe([{topic:'market',assetIds:[...ids],customFeatureEnabled:true}]);
let pending:Promise<void>|undefined;
const snapshots=async()=>{
 try{const books=await client.fetchOrderBooks([...ids].map(assetId=>({assetId})));
  const seen=new Set<string>();for(const book of books){if(!ids.has(book.assetId)||seen.has(book.assetId))throw Error();seen.add(book.assetId);append('snapshot',book);}
  if(seen.size!==ids.size){healthy=false;append('gap',{reason:'missing_snapshot',missing:[...ids].filter(id=>!seen.has(id))});}
 }catch{healthy=false;append('gap',{reason:'snapshot_failed'});}
};
pending=snapshots().finally(()=>{pending=undefined;});
const terminate=()=>{healthy=false;stopping=true;append('gap',{reason:'interrupted'});void handle.close();};
process.once('SIGTERM',terminate);process.once('SIGINT',terminate);
const timer=setTimeout(()=>{stopping=true;void handle.close();},durationMs);
const interval=setInterval(()=>{
 const disk=statfsSync(directory);if(disk.bavail*disk.bsize<512*1024*1024 || statSync(file).size>120*1024*1024){healthy=false;stopping=true;append('gap',{reason:'disk_limit'});void handle.close();return;}
 append('heartbeat',{connected:!stopping});if(!pending)pending=snapshots().finally(()=>{pending=undefined;});
},30000);
console.log(JSON.stringify({status:'recording',directory,tokens:ids.size,durationMs,startedAt}));
try{for await(const event of handle){append('event',event);}if(!stopping){healthy=false;append('gap',{reason:'unexpected_disconnect'});}}
catch{healthy=false;append('gap',{reason:'stream_failed'});}
finally{clearTimeout(timer);clearInterval(interval);await handle.close();await pending;
 const to=append('end',{healthy});const sha256=createHash('sha256').update(readFileSync(file)).digest('hex');
 const manifest={schema:1,kind:'public-market-event-observation',collectorSha256:createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'),configuration:{seconds,limit,snapshotIntervalMs:30000,maxFileBytes:128*1024*1024},license:'Datos públicos de Polymarket, sujetos a condiciones del proveedor',source:'Polymarket SDK @polymarket/client 0.9.0 public REST + market WebSocket',from:startedAt,to,durationMs:to-startedAt,sha256,counts,healthy,tokens:[...ids],limitations:['Observed client stream; exchange events have no global sequence proof.','Public price/size changes do not identify individual queue priority or cancellation ownership.','No private account stream, no orders, no fees or profits actually incurred by this collector.']};
 writeFileSync(directory+'/manifest.json',JSON.stringify(manifest,null,2),{mode:0o600});console.log(JSON.stringify({status:'completed',directory,counts,healthy,sha256}));
}
