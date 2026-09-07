import {Store} from '../engine/store.js';
import {Ledger} from '../engine/ledger.js';
import {defaults, type Mode} from '../engine/model.js';
import {writePaperChart, writePaperReport} from './paper-report.js';
process.once('message',async(input:{database:string;directory:string;mode:Mode;at:number;days:number})=>{
  let store:Store|undefined;
  try {
    store=new Store(input.database,true);
    const ledger=new Ledger(store,input.mode,defaults,()=>input.at);
    const html=writePaperReport(ledger,input.directory,input.days);
    store.close();store=undefined;
    let png:string|undefined;
    try { png=await writePaperChart(input.directory); } catch { /* HTML/JSON/CSV retain a coherent snapshot even if rendering fails. */ }
    process.send?.({html,png,chartError:!png});
  } catch { process.send?.({error:'No se pudo generar el informe'}); }
  finally { store?.close();process.disconnect?.(); }
});
