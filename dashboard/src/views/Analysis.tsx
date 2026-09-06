import type { Snapshot } from '../hooks/useBot';

const usd = (n: number) => new Intl.NumberFormat('es', {style:'currency', currency:'USD', maximumFractionDigits:2}).format(n);
export const groupName = (name: string) => ({'yes-no':'Arbitraje YES/NO','football-value':'Fútbol','sin-atribuir':'Sin atribuir','no-aplica':'Sin liga','desconocida':'Liga desconocida',epl:'Premier League',lal:'LaLiga',bun:'Bundesliga',sea:'Serie A',fl1:'Ligue 1',mex:'Liga MX'} as Record<string,string>)[name] ?? name;

export function Analysis({ data }: {data: Snapshot}) {
  const a = data.analysis;
  return <section className="panel" aria-label="Análisis del rendimiento">
    <h2>Rendimiento por estrategia y liga</h2>
    {!a ? <p className="empty" role="status">El análisis aparecerá al generar el siguiente informe paper.</p> : <>
      <p className="muted">Actualizado {new Date(a.generatedAt).toLocaleString('es',{timeZone:'UTC'})} UTC · cada 5 minutos · acumulado de toda la cuenta.</p>
      <p>Efectivo sin operar: <strong>{usd(a.cashBenchmark)}</strong> · diferencia: <strong>{usd(a.excessOverCash)}</strong>. Mismos depósitos y retiros, sin intereses.</p>
      {([{title:'Por estrategia',rows:a.byStrategy},{title:'Por liga',rows:a.byLeague}]).map(({title,rows})=><div key={title}>
        <h3>{title}</h3>
        {!rows.length ? <p className="empty">Sin operaciones para desglosar.</p> : <div className="table-scroll" tabIndex={0} aria-label={`Tabla ${title.toLowerCase()}`}><table>
          <thead><tr><th>Grupo</th><th>Realizado</th><th>Abierto</th><th>PnL neto</th><th>Comisiones</th><th>Gas</th><th>Fills</th></tr></thead>
          <tbody>{rows.map(r=><tr key={r.name}><th scope="row">{groupName(r.name)}</th>{[r.realized,r.unrealized,r.netPnl,r.fees,r.gas].map((v,i)=><td key={i}>{usd(v)}</td>)}<td>{r.fills}</td></tr>)}</tbody>
        </table></div>}
      </div>)}
      <h3>Calidad de las entradas</h3>
      <p className="muted">Salida hipotética del fill completo al primer libro válido hasta 30 segundos después del horizonte. Incluye comisiones y gas de salida modelado. No son ventas ni PnL contabilizado.</p>
      <div className="table-scroll" tabIndex={0} aria-label="Tabla de calidad de entrada"><table>
        <thead><tr><th>Después de</th><th>Observadas</th><th>Pendientes</th><th>Sin datos válidos</th><th>Sin liquidez o mínimo</th><th>PnL hipotético medio por fill</th></tr></thead>
        <tbody>{a.entryQuality.horizons.map(h=>{
          const rows=a.entryQuality.rows.filter(r=>r.horizonMinutes===h), observed=rows.filter(r=>r.status==='observed');
          return <tr key={h}><th scope="row">{h} minutos</th><td>{observed.length}</td><td>{rows.filter(r=>r.status==='pending').length}</td><td>{rows.filter(r=>r.status==='missing'||r.status==='invalid').length}</td><td>{rows.filter(r=>r.status==='illiquid').length}</td><td>{observed.length ? usd(observed.reduce((sum,r)=>sum+r.hypotheticalNetPnl!,0)/observed.length) : 'Sin muestra'}</td></tr>;
        })}</tbody>
      </table></div>
      <h3>Concentración del fútbol</h3>
      <p className="muted">Coste más reservas, como porcentaje del capital inicial. Un partido cuenta para ambos equipos. Jornada agrupada por liga y fecha UTC; no es el número oficial de ronda.</p>
      {!a.concentration.length ? <p className="empty">Sin exposición de fútbol.</p> : <div className="table-scroll" tabIndex={0} aria-label="Tabla de concentración"><table>
        <thead><tr><th>Agrupación</th><th>Grupo</th><th>Exposición</th><th>Capital inicial</th><th>Partidos</th><th>Valoraciones obsoletas</th></tr></thead>
        <tbody>{a.concentration.map(r=><tr key={`${r.kind}:${r.key}`}><td>{{league:'Liga',team:'Equipo',matchday:'Jornada UTC'}[r.kind]}</td><th scope="row">{r.key.split(':').map(groupName).join(' · ')}</th><td>{usd(r.exposure)}</td><td>{r.capitalPct.toFixed(2)}%</td><td>{r.matches.length}</td><td>{r.stalePositions}</td></tr>)}</tbody>
      </table></div>}
      <details><summary>Cómo interpretar el análisis</summary><ul>{a.limitations.map(text=><li key={text}>{text}</li>)}</ul></details>
    </>}
  </section>;
}
