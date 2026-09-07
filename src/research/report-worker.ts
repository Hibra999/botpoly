import {fork, type ChildProcess} from 'node:child_process';
import {readFileSync, realpathSync, mkdirSync} from 'node:fs';
import {basename, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {Ledger} from '../engine/ledger.js';
export interface ReportFiles {html:string;png?:string;chartError:boolean}
/** One on-demand process; no writable database connection or network in the renderer. */
export class ReportWorker {
  private child?:ChildProcess;
  constructor(private ledger:Ledger, private reports=resolve('reports')) {}
  generate(directory:string,days=5):Promise<ReportFiles> {
    if (this.child) return Promise.reject(new Error('Ya hay un informe en curso'));
    if (!Number.isSafeInteger(days) || days < 1 || days > 30) return Promise.reject(new Error('Periodo inválido'));
    mkdirSync(this.reports,{recursive:true,mode:0o700});
    const id=basename(directory);
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || resolve(directory,'..') !== resolve(this.reports)) return Promise.reject(new Error('Ruta de informe inválida'));
    mkdirSync(directory,{recursive:true,mode:0o700});
    if (!realpathSync(directory).startsWith(realpathSync(this.reports)+sep)) return Promise.reject(new Error('Ruta de informe inválida'));
    const source=import.meta.url.endsWith('.ts');
    const child=fork(fileURLToPath(new URL(source ? './report-job.ts' : './report-job.js',import.meta.url)),[],{execArgv:source ? ['--import','tsx'] : [],stdio:['ignore','ignore','ignore','ipc'],env:{PATH:process.env.PATH,LANG:'C.UTF-8'}});
    this.child=child;
    return new Promise((resolveResult,reject)=>{
      let result:ReportFiles|undefined,failed=false;
      const timer=setTimeout(()=>{failed=true;child.kill('SIGKILL');},60000);
      child.on('message',(m:ReportFiles & {error?:string})=>{if(m.error) failed=true; else result=m;});
      child.once('error',()=>{failed=true;});
      child.once('exit',()=>{
        clearTimeout(timer);this.child=undefined;
        if (failed || !result) {this.ledger.event('report_failed','No se pudo generar el informe; solicitud conservada');reject(new Error('Informe no disponible'));return;}
        try {
          const data=JSON.parse(readFileSync(resolve(directory,'result.json'),'utf8'));
          const manifest=JSON.parse(readFileSync(resolve(directory,'manifest.json'),'utf8'));
          this.ledger.store.transaction(()=>{
            this.ledger.store.put('reports',id,{id,timestamp:data.to,label:`Seguimiento ${data.kind}`,status:'exploratorio',netPnl:data.metrics.netPnl,manifest,chartError:result!.chartError});
            this.ledger.store.put('meta','paper:analysis',data.analysis);
            this.ledger.event('report',`Informe ${id} · ${data.kind} · ${result!.chartError ? 'PNG falló; demás archivos disponibles' : 'archivos generados'}`);
          });
          resolveResult(result);
        } catch {reject(new Error('No se pudo registrar el informe'));}
      });
      child.send({database:this.ledger.store.path,directory,mode:this.ledger.mode,at:this.ledger.now(),days});
    });
  }
  stop():void {this.child?.kill('SIGTERM');}
}
