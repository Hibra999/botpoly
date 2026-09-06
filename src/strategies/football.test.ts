import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { csvRows, deduplicate, FootballData, matchTeam, parseMatches, poisson, type Match } from "./football.js";
const header = 'Date,HomeTeam,AwayTeam,FTHG,FTAG';
const history: Match[] = Array.from({length: 30}, (_, i) => ({date: Date.UTC(2025, 0, i + 1), home: i % 2 ? 'A' : 'B', away: i % 2 ? 'B' : 'A', hg: 2, ag: 1}));
describe('historial y Poisson sin información futura', () => {
  it('valida CSV, fechas completas y resultados duplicados', () => {
    expect(csvRows('\uFEFFa,b\r\n"x,y","z""\nq"')).toEqual([['a','b'], ['x,y','z"\nq']]);
    for (const raw of ['a\n"x"z', 'a\n"x', header + '\n01/13/2025,A,B,1,0', header + '\n29/02/2025,A,B,1,0', header + '\n01/01/2025,A,B,1', header + '\n01/01/2025,A,B,1,']) expect(() => parseMatches(raw)).toThrow();
    const rows = parseMatches(header + '\n29/02/2024,A,B,1,0\n29/02/2024,A,B,1,0');
    expect(rows).toHaveLength(1);
    expect(deduplicate([...rows,...rows])).toHaveLength(1);
    expect(() => deduplicate([...rows, {...rows[0], hg: 2}])).toThrow();
    expect(() => parseMatches('Date,Home,HG\n01/01/2025,A,1')).toThrow();
  });
  it('rechaza nombres ambiguos y abreviaturas genéricas', () => {
    expect(matchTeam('Manchester United FC', ['Man United'])).toBe('Man United');
    expect(matchTeam('Manchester United', ['Man United', 'Manchester United'])).toBeUndefined();
    expect(matchTeam('atletico', ['Ath Madrid'])).toBeUndefined();
    expect(matchTeam('le', ['Le Havre'])).toBeUndefined();
  });
  it('normaliza probabilidades, exige muestra y excluye futuro', () => {
    const before = Date.UTC(2025, 1, 1), p = poisson(history, 'A', 'B', before)!;
    expect(p.home + p.draw + p.away).toBeCloseTo(1, 10);
    expect(p.home).toBeGreaterThan(p.away);
    expect(poisson([...history, {date: before, home:'A',away:'B',hg:20,ag:0}], 'A','B',before)).toEqual(p);
    expect(poisson(history.slice(0,9),'A','B',before)).toBeUndefined();
    expect(poisson(history,'ascendido','B',before)).toBeUndefined();
  });
  it('conserva fuentes y verifica la caché contra los CSV, caducando a siete días', async () => {
    const directory=mkdtempSync(join(tmpdir(),'football-'));
    const now=Date.UTC(2026,8,6), raw=header+'\n'+history.map(m => `${new Date(m.date).toISOString().slice(0,10).split('-').reverse().join('/')},${m.home},${m.away},${m.hg},${m.ag}`).join('\n');
    const request = (async () => new Response(raw)) as typeof fetch;
    try {
      const loader=new FootballData(directory,request,()=>now); await loader.refresh();
      expect(loader.datasets.size).toBe(6);
      expect(loader.datasets.get('epl')?.matches).toHaveLength(30);
      const badRequest=(async()=>{throw new Error('offline')}) as typeof fetch;
      const cached=new FootballData(directory,badRequest,()=>now); await cached.refresh(); expect(cached.datasets.size).toBe(6);
      const file=join(directory,'epl.json'), tampered=JSON.parse(readFileSync(file,'utf8')); tampered.matches[0].hg=30; writeFileSync(file,JSON.stringify(tampered));
      const broken=new FootballData(directory,badRequest,()=>now); await broken.refresh(); expect(broken.datasets.has('epl')).toBe(false);
      const expired=new FootballData(directory,badRequest,()=>now+8*86400000); await expired.refresh();
      expect(expired.forecast({matchId:'m',league:'mex',home:'A',away:'B',startAt:now+9*86400000,result:'home'})).toBeUndefined();
    } finally { rmSync(directory,{recursive:true,force:true}); }
  });
});
