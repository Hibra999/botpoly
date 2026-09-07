import {it,expect} from 'vitest';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../engine/store.js';
import {Ledger} from '../engine/ledger.js';
import {defaults} from '../engine/model.js';
import {ReportWorker} from './report-worker.js';
it('trabajador único, snapshot de solo lectura, Markdown/PNG/HTML/JSON/CSV y registro por el padre',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'botpoly-worker-')),s=new Store(join(dir,'account.sqlite'));
  try {
    const l=new Ledger(s,'paper',defaults); l.stop('Límite de pérdida diaria');
    const before=l.account, worker=new ReportWorker(l,join(dir,'reports'));
    const job=worker.generate(join(dir,'reports','test'));
    await expect(worker.generate(join(dir,'reports','second'))).rejects.toThrow('curso');
    const result=await job;expect(result.png).toBeTruthy();expect(result.chartError).toBe(false);
    expect(l.account).toEqual(before);expect(s.get('reports','test')).toBeDefined();
    const manifest=JSON.parse(readFileSync(join(dir,'reports/test/manifest.json'),'utf8'));
    expect(Object.keys(manifest.files)).toEqual(expect.arrayContaining(['report.html','summary.md','result.json','trades.csv','chart.png']));
    const ro=new Store(s.path,true);
    try {
      expect(()=>ro.put('meta','account',{})).toThrow();
      ro.transaction(()=>{
        const old=ro.get('meta','account');l.save({...l.account,cash:980});
        expect(ro.get('meta','account')).toEqual(old);
      });
      expect(ro.get('meta','account')).toEqual(l.account);
    } finally {ro.close();}
  } finally {s.close();rmSync(dir,{recursive:true,force:true});}
},20000);
it('live identifica costes y datos reales; fallo de trabajador conserva cuenta',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'botpoly-live-report-')),s=new Store(join(dir,'live.sqlite'));
  try {
    const l=new Ledger(s,'live',defaults),worker=new ReportWorker(l,join(dir,'reports'));
    await worker.generate(join(dir,'reports','live'));
    const raw=readFileSync(join(dir,'reports/live/summary.md'),'utf8');expect(raw).toContain('LIVE');expect(raw).toContain('reales confirmados');
    expect(raw).not.toContain('fills son simulados');
    const bad=new Store(':memory:');try {
      const failed=new ReportWorker(new Ledger(bad,'paper',defaults),join(dir,'reports'));
      await expect(failed.generate(join(dir,'reports','missing'))).rejects.toThrow();expect(bad.get('meta','account')).toBeDefined();
    }finally{bad.close();}
  }finally{s.close();rmSync(dir,{recursive:true,force:true});}
},20000);
it('un fallo de PNG se informa y conserva archivos y hashes de los demás formatos',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'botpoly-render-fail-')),s=new Store(join(dir,'account.sqlite')),path=process.env.PATH;
  try {
    const l=new Ledger(s,'paper',defaults),worker=new ReportWorker(l,join(dir,'reports'));
    process.env.PATH='/nonexistent';const job=worker.generate(join(dir,'reports','render-fail'));process.env.PATH=path;
    const result=await job;expect(result.chartError).toBe(true);expect(result.png).toBeUndefined();
    expect(readFileSync(result.html,'utf8')).toContain('Sin posiciones abiertas');
    expect(s.get<{chartError:boolean}>('reports','render-fail')?.chartError).toBe(true);
  }finally{process.env.PATH=path;s.close();rmSync(dir,{recursive:true,force:true});}
},20000);
