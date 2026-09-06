import 'dotenv/config';
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {resolve,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {FootballData,restoreSources,leagues} from '../strategies/football.js';
import {evaluateFootball} from './football-evaluation.js';
import {escapeHtml,csvCell} from './report.js';
import {Store} from '../engine/store.js';
const {values}=parseArgs({options:{out:{type:'string',default:'reports/football-evaluation'},register:{type:'string'},manifest:{type:'string'}}});
const directory=resolve(values.out!);if(existsSync(resolve(directory,'result.json')))throw new Error('El informe ya existe; usa otro directorio para conservar los ensayos');
const data=new FootballData();
if(values.manifest){
 const manifest=JSON.parse(readFileSync(values.manifest,'utf8'));
 if(!Array.isArray(manifest.sources))throw new Error('Manifiesto inválido');
 for(const source of manifest.sources){if(!leagues.some(l=>l.id===source.league)||data.datasets.has(source.league))throw new Error('Liga inválida o duplicada');data.datasets.set(source.league,restoreSources(source,resolve('.runtime/football')));data.status[source.league]='Reproducción offline verificada por checksum';}
}else await data.refresh(2023);
const result={...evaluateFootball(data.datasets),capturedAt:Date.now(),sourceStatus:data.status,sources:[...data.datasets].map(([league,d])=>({league,verifiedAt:d.verifiedAt,checksum:d.checksum,sources:d.sources})),limitations:[
 'Calidad predictiva retrospectiva; no demuestra rentabilidad ni fills ejecutables en Polymarket. No contiene operaciones simuladas ni PnL.',
 'Resultados anteriores al día del partido. Football-Data no suministra historial de revisiones ni hora exacta de publicación; no se puede probar disponibilidad intradía histórica.',
 'Modelo fijo con mínimo de 10 partidos y ventana de 730 días; los casos sin muestra se conservan en cobertura, incluidos ascendidos.',
 'Brier multiclase: suma de tres errores cuadrados (0–2); log-loss natural. Calibración por resultado y decil.',
 'Referencia histórica calculada solo con partidos anteriores. Cuotas AvgCH/AvgCD/AvgCA sin margen solo cuando las tres están completas; cuotas de otra plataforma no prueban ejecución en Polymarket.',
 'La cuenta prospectiva paper conserva por separado profundidad, latencia, comisiones, gas, reservas, fills y resolución oficial.',
],attribution:[{source:'https://football-data.co.uk/data.php',use:'Resultados y cuotas históricas gratuitos; sujetos a condiciones del proveedor'},{source:'https://github.com/memonkey01/pypro_polymarket_agent/tree/e7ed2f35bf4bf0a7fef5d3c497cd9aff62d3b0a5',use:'Ideas de Poisson, regularización y Kelly; implementación propia, sin copiar código ni dependencias; su estrategia Liga MX era draft sin ventaja demostrada'}]};
mkdirSync(directory,{recursive:true,mode:0o700});
const csv=[['league','period','date','home','away','actual_0_home_1_draw_2_away','p_home','p_draw','p_away','ref_home','ref_draw','ref_away','closing_home','closing_draw','closing_away','sample','checksum'],...result.rows.map(r=>[r.league,r.period,new Date(r.date).toISOString(),r.home,r.away,r.actual,...r.probabilities,...r.reference,...(r.closing??['','','']),r.sampleSize,r.checksum])].map(r=>r.map(csvCell).join(',')).join('\n');
const html=`<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Botpoly · Evaluación predictiva</title><style>body{background:#101018;color:#eee;font:16px/1.6 system-ui;padding:24px;max-width:1000px;margin:auto}h1,h2{color:#b9a9ff}pre{white-space:pre-wrap;overflow-wrap:anywhere}table{width:100%;border-collapse:collapse}td,th{padding:12px;border-bottom:1px solid #454552;text-align:left}.scroll{overflow:auto}</style><h1>Fútbol · evaluación predictiva</h1><p>Desarrollo 2023/24–2024/25 · evaluación 2025/26 · UTC. Modelo ${result.policy.version}. Sin PnL ni afirmación de rentabilidad.</p><div class="scroll"><table><tr><th>Periodo</th><th>Modelo: n / Brier / log-loss</th><th>Frecuencia histórica</th><th>Modelo en casos con cuotas</th><th>Cuotas de cierre sin margen</th></tr>${Object.entries(result.summary).map(([period,s])=>'<tr><td>'+period+'</td>'+[s.model,s.historicalReference,s.modelWithClosing,s.closingReference].map(m=>`<td>${m.n} / ${m.brier?.toFixed(4) ?? 'sin datos'} / ${m.logLoss?.toFixed(4) ?? 'sin datos'}</td>`).join('')+'</tr>').join('')}</table></div><h2>Cobertura</h2><pre>${escapeHtml(JSON.stringify(result.coverage,null,2))}</pre><h2>Calibración, parámetros y procedencia</h2><pre>${escapeHtml(JSON.stringify({...result,rows:undefined},null,2))}</pre>`;
for(const [file,body] of [['result.json',JSON.stringify(result,null,2)],['predictions.csv',csv],['report.html',html]])writeFileSync(resolve(directory,file),body,{mode:0o600});
const manifest={schema:1,kind:result.kind,capturedAt:result.capturedAt,periods:result.periods,sources:result.sources,files:Object.fromEntries(['result.json','predictions.csv','report.html'].map(file=>[file,createHash('sha256').update(readFileSync(resolve(directory,file))).digest('hex')]))};
writeFileSync(resolve(directory,'manifest.json'),JSON.stringify(manifest,null,2),{mode:0o600});
if(values.register){
 if(!existsSync(values.register))throw new Error('La base de registro no existe');
 const store=new Store(values.register);try{
  if(store.get('meta','mode')!=='paper')throw new Error('Solo registrar en paper');
  store.put('meta','football:evidence',{report:basename(directory),manifest});
 }finally{store.close()}
}
console.log(JSON.stringify({report:directory,coverage:result.coverage,summary:Object.fromEntries(Object.entries(result.summary).map(([k,v])=>[k,{model:v.model,reference:v.historicalReference,modelWithClosing:v.modelWithClosing,closing:v.closingReference}]))},null,2));
