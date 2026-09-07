import assert from 'node:assert/strict';
import {backup,DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {createReadStream,readFileSync,mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../dist/src/engine/store.js';
import {Ledger} from '../dist/src/engine/ledger.js';
import {defaults} from '../dist/src/engine/model.js';
const sha=value=>createHash('sha256').update(value).digest('hex');
function state(db){
 const meta=key=>JSON.parse(db.prepare('SELECT data FROM meta WHERE id=?').get(key)?.data ?? 'null');
 return {mode:meta('mode'),account:meta('account'),config:meta('config'),tables:Object.fromEntries(['orders','fills','positions','reservations','settlements'].map(table=>{
  const rows=db.prepare(`SELECT id,data FROM ${table} ORDER BY id`).all();return [table,{rows:rows.length,sha256:sha(JSON.stringify(rows))}];
 })),recordedBooks:Number(db.prepare('SELECT count(*) AS n FROM recorded_books').get().n)};
}
async function migrate(path,mode,risk){
 const directory=join(dirname(path),'backups');mkdirSync(directory,{recursive:true,mode:0o700});
 const id=`headless-${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}`,copy=join(directory,id+'.sqlite');
 const source=new DatabaseSync(path,{readOnly:true});let before;
 try {
  before=state(source);assert.equal(before.mode,mode);assert(before.account && before.config,'Existing account required');
  await backup(source,copy,{rate:1024});
 }finally{source.close();}
 const check=new DatabaseSync(copy,{readOnly:true});
 try {check.exec('PRAGMA cache_size=-262144');assert.deepEqual(check.prepare('PRAGMA integrity_check').all().map(r=>r.integrity_check),['ok']);assert.deepEqual(state(check),before);}
 finally{check.close();}
 const hash=createHash('sha256');for await(const bytes of createReadStream(copy))hash.update(bytes);
 const record={at:new Date().toISOString(),database:path,backup:copy,backupSha256:hash.digest('hex'),codeSha256:sha(readFileSync(new URL('./migrate.mjs',import.meta.url))),integrity:'ok',before};
 const report=join(directory,id+'.json');writeFileSync(report,JSON.stringify(record,null,2),{flag:'wx',mode:0o600});
 const store=new Store(path);
 try {
  const ledger=new Ledger(store,mode,risk),after=state(store.db);record.after=after;
  assert.deepEqual(after.account,before.account,'Account changed during migration');assert.deepEqual(after.tables,before.tables,'Financial records changed during migration');assert.equal(after.recordedBooks,before.recordedBooks);
  for(const [key,value] of Object.entries(before.config))assert.equal(after.config[key],value,'Existing risk parameter changed');
  record.operations=ledger.operationUsage();record.preserved=true;
 }finally{store.close();writeFileSync(report,JSON.stringify(record,null,2),{mode:0o600});}
 return {report,backup:copy,integrity:'ok',preserved:true,stop:before.account.stop};
}
process.umask(0o077);
try {
 if(process.argv.includes('--self-test')){
  const directory=mkdtempSync(join(tmpdir(),'botpoly-migration-')),path=join(directory,'account.sqlite');
  try {
   const store=new Store(path),ledger=new Ledger(store,'paper',defaults),cfg={...ledger.config};delete cfg.max_oper_per_hour;
   store.put('meta','config',cfg);store.delete('meta','operation-slots:migrated');ledger.save({...ledger.account,cash:970,realized:-30,stop:'Límite de pérdida diaria'});
   store.put('reservations','pending',{id:'pending',remaining:10});store.put('orders','pending',{id:'pending',pairId:'pending',side:'BUY',status:'uncertain',timestamp:Date.now()});store.close();
   const result=await migrate(path,'paper',defaults),reopen=new Store(path,true);try{assert.equal(new Ledger(reopen,'paper',defaults).operationUsage().pending,1);assert.equal(reopen.get('meta','account').cash,970);}finally{reopen.close();}
   assert.equal(result.preserved,true);console.log('Correcto: copia íntegra y migración aditiva conservan pérdidas, reserva, entrada incierta y parada.');
  }finally{rmSync(directory,{recursive:true,force:true});}
 }else {
  const {default:dotenv}=await import('dotenv');dotenv.config({quiet:true});
  const {loadConfig}=await import('../dist/src/app/config.js'),config=loadConfig();
  console.log(JSON.stringify(await migrate(resolve(config.database),config.mode,config.risk)));
 }
}catch{console.error('Migración detenida. Revisar la copia y el informe privado de conservación; no sustituir SQLite ni reanudar.');process.exitCode=1;}
