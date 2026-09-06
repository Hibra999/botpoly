import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { footballPolicy, type FootballMarket, type Forecast } from "../engine/model.js";

export const leagues = [
  { id: "epl", name: "Premier League", code: "E0" },
  { id: "lal", name: "LaLiga", code: "SP1" },
  { id: "bun", name: "Bundesliga", code: "D1" },
  { id: "sea", name: "Serie A", code: "I1" },
  { id: "fl1", name: "Ligue 1", code: "F1" },
  { id: "mex", name: "Liga MX", code: "MEX" },
] as const;
export interface Match { date: number; home: string; away: string; hg: number; ag: number; closing?: [number, number, number] }
export interface FootballDataset { matches: Match[]; verifiedAt: number; checksum: string; sources: { url: string; sha256: string }[] }
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

/** RFC 4180 fields, including quoted commas, escaped quotes and CRLF. */
export function csvRows(text: string): string[][] {
  const rows: string[][] = [], row: string[] = [];
  let field = "", quoted = false, closed = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else if (quoted) { quoted = false; closed = true; }
      else if (!field && !closed) quoted = true;
      else throw new Error("CSV: comilla fuera de campo");
    } else if (c === "," && !quoted) { row.push(field); field = ""; closed = false; }
    else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = ""; closed = false;
      if (row.some(Boolean)) rows.push(row.splice(0)); else row.length = 0;
    } else { if (closed) throw new Error("CSV: contenido tras comilla de cierre"); field += c; }
  }
  if (quoted) throw new Error("CSV: campo sin cerrar");
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}
export function parseMatches(csv: string): Match[] {
  const [headers, ...rows] = csvRows(csv);
  if (!headers) throw new Error("CSV vacío");
  const get = (row: string[], ...names: string[]) => {
    const i = names.map((name) => headers.indexOf(name)).find((i) => i >= 0);
    return i === undefined ? "" : (row[i] ?? "").trim();
  };
  if (new Set(headers).size !== headers.length || ![["Date"], ["HomeTeam", "Home"], ["AwayTeam", "Away"], ["HG", "FTHG"], ["AG", "FTAG"]].every((names) => names.some((h) => headers.includes(h)))) throw new Error("Esquema de resultados incompatible");
  const matches = new Map<string, Match>();
  for (const row of rows) {
    if (row.length !== headers.length) throw new Error("CSV: campos faltantes o sobrantes");
    const hg = get(row, "FTHG", "HG"), ag = get(row, "FTAG", "AG");
    if (!hg && !ag) continue;
    const home = get(row, "HomeTeam", "Home"), away = get(row, "AwayTeam", "Away");
    const rawDate = get(row, "Date");
    if (!/^\d{2}\/\d{2}\/(\d{2}|\d{4})$/.test(rawDate)) throw new Error("Fecha inválida");
    const parts = rawDate.split("/").map(Number);
    const year = parts[2] < 100 ? 2000 + parts[2] : parts[2];
    const date = Date.UTC(year, parts[1] - 1, parts[0]);
    if (!home || !away || home === away || !Number.isFinite(date) || new Date(date).getUTCDate() !== parts[0] || new Date(date).getUTCMonth() !== parts[1] - 1 || new Date(date).getUTCFullYear() !== year || !/^\d+$/.test(hg) || !/^\d+$/.test(ag) || +hg > 30 || +ag > 30) throw new Error("Resultado de fútbol inválido");
    const odds = [get(row, "AvgCH"), get(row, "AvgCD"), get(row, "AvgCA")].map(Number);
    const match: Match = { date, home, away, hg: +hg, ag: +ag, ...(odds.every((n) => Number.isFinite(n) && n > 1) ? { closing: odds as [number, number, number] } : {}) };
    const key = `${date}:${home}:${away}`, prior = matches.get(key);
    if (prior && (prior.hg !== match.hg || prior.ag !== match.ag)) throw new Error("Resultados contradictorios");
    matches.set(key, match);
  }
  return [...matches.values()].sort((a, b) => a.date - b.date);
}
export function deduplicate(matches: Match[]): Match[] {
  const unique = new Map<string, Match>();
  for (const m of matches) {
    const key = `${m.date}:${m.home}:${m.away}`, prior = unique.get(key);
    if (prior && JSON.stringify(prior) !== JSON.stringify(m)) throw new Error("Resultados duplicados contradictorios");
    unique.set(key, m);
  }
  return [...unique.values()].sort((a, b) => a.date - b.date || a.home.localeCompare(b.home) || a.away.localeCompare(b.away));
}
export function restoreSources(source: Pick<FootballDataset,"sources"|"checksum"|"verifiedAt">, directory: string): FootballDataset {
  if (!Array.isArray(source.sources) || !source.sources.length || !Number.isFinite(source.verifiedAt)) throw new Error("Manifiesto de fútbol inválido");
  const matches=deduplicate(source.sources.flatMap(s=>{
    if (!/^https:\/\/football-data\.co\.uk\//.test(s.url) || !/^[a-f0-9]{64}$/.test(s.sha256)) throw new Error("Fuente inválida");
    const raw=readFileSync(resolve(directory,s.sha256+".csv"),"utf8");
    if (hash(raw) !== s.sha256) throw new Error("Checksum de fuente incorrecto");
    return parseMatches(raw);
  }));
  if (hash(JSON.stringify({matches,sources:source.sources})) !== source.checksum) throw new Error("Checksum del historial incorrecto");
  return {...source,matches};
}
const aliases: Record<string, string> = {
  parma1913: "parma", bologna1909: "bologna", ussassuolo: "sassuolo", uslecce: "lecce", sslazio: "lazio", acffiorentina: "fiorentina", genoacfc: "genoa",
 estroyes: "troyes", staderennais1901: "rennes", olympiquedemarseille: "marseille", hamburgersv: "hamburg", "1fsvmainz05": "mainz", "1unionberlin": "unionberlin", tsg1899hoffenheim: "hoffenheim", bvborussia09dortmund: "dortmund", paderborn07: "paderborn",
  levanteud: "levante", rcdespanyoldebarcelona: "espanol", celtadevigo: "celta", realsociedaddefutbol: "sociedad", realracing: "santander", pumasdelaunam: "unampumas",
  wolverhamptonwanderers: "wolves", manchesterunited: "manunited", manchestercity: "mancity", nottinghamforest: "nottmforest", tottenhamhotspur: "tottenham", newcastleunited: "newcastle", westhamunited: "westham", brightonhovealbion: "brighton", leedsunited: "leeds", leicestercity: "leicester", ipswichtown: "ipswich",
  athleticbilbao: "athbilbao", atleticomadrid: "athmadrid", realbetis: "betis", realsociedad: "sociedad", rayovallecano: "vallecano", celta: "celta", celtavigo: "celta", realoviedo: "oviedo", osasuna: "osasuna",
  borussiadortmund: "dortmund", borussiamonchengladbach: "mgladbach", bayernmunich: "bayernmunich", bayernmunchen: "bayernmunich", bayerleverkusen: "leverkusen", eintrachtfrankfurt: "einfrankfurt", rbleipzig: "rbleipzig", mainz05: "mainz", stpauli: "stpauli", vflwolfsburg: "wolfsburg", vfbstuttgart: "stuttgart", vflbochum: "bochum",
  internazionale: "inter", intermilano: "inter", milan: "milan", hellasverona: "verona", parissaintgermain: "parissg", olympiquelyonnais: "lyon", olympiquemarseille: "marseille", stadebrestois29: "brest", staderennais: "rennes", strasbourgalsace: "strasbourg", ogcnice: "nice", saintetienne: "stetienne",
  americacf: "america", guadalajara: "guadalajarachivas", unampumas: "unampumas", pumasunam: "unampumas", tigresuanl: "tigresuanl", uanltigres: "tigresuanl", atleticosanluis: "atlsanluis", queretaro: "queretaro",
};
export function teamKey(name: string): string {
  const key = name.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/\b(fc|cf|afc|ac|sc|as|rc|ca|club|deportivo|football|calcio|sco)\b/g, "").replace(/[^a-z0-9]/g, "");
  return aliases[key] ?? key;
}
export function matchTeam(name: string, teams: string[]): string | undefined {
  const matches = [...new Set(teams)].filter((t) => teamKey(t) === teamKey(name));
  return matches.length === 1 ? matches[0] : undefined;
}
export function poisson(matches: Match[], home: string, away: string, before: number): { home: number; draw: number; away: number; sampleSize: number } | undefined {
  const played = matches.filter((m) => m.date < before && m.date >= before - footballPolicy.historyDays * 86400000);
  const totals = new Map<string, { n: number; scored: number; conceded: number }>();
  let homeGoals = 0, awayGoals = 0;
  for (const m of played) {
    homeGoals += m.hg; awayGoals += m.ag;
    for (const [team, scored, conceded] of [[m.home, m.hg, m.ag], [m.away, m.ag, m.hg]] as const) {
      const t = totals.get(team) ?? { n: 0, scored: 0, conceded: 0 };
      t.n++; t.scored += scored; t.conceded += conceded; totals.set(team, t);
    }
  }
  const h = totals.get(home), a = totals.get(away);
  if (!h || !a || Math.min(h.n, a.n) < footballPolicy.minMatches || !homeGoals || !awayGoals) return undefined;
  const base = (homeGoals + awayGoals) / (2 * played.length), k = footballPolicy.shrinkMatches;
  const rate = (t: typeof h, kind: "scored" | "conceded") => (t[kind] + k * base) / ((t.n + k) * base);
  const local = Math.sqrt(homeGoals / awayGoals);
  const lh = base * rate(h, "scored") * rate(a, "conceded") * local;
  const la = base * rate(a, "scored") * rate(h, "conceded") / local;
  if (![lh, la].every((n) => Number.isFinite(n) && n > 0 && n <= 10)) return undefined;
  const probabilities = (lambda: number) => {
    const p = [Math.exp(-lambda)]; let sum = p[0];
    for (let n = 1; n < 100 && 1 - sum > 1e-10; n++) { p.push(p[n - 1] * lambda / n); sum += p[n]; }
    return p;
  };
  const ph = probabilities(lh), pa = probabilities(la);
  let homeP = 0, draw = 0, awayP = 0;
  ph.forEach((h, i) => pa.forEach((a, j) => { if (i > j) homeP += h * a; else if (i === j) draw += h * a; else awayP += h * a; }));
  const total = homeP + draw + awayP;
  return { home: homeP / total, draw: draw / total, away: awayP / total, sampleSize: Math.min(h.n, a.n) };
}
export class FootballData {
  datasets = new Map<string, FootballDataset>();
  status: Record<string, string> = {};
  private checkedAt = -Infinity;
  private forecasts = new Map<string, Forecast | undefined>();
  constructor(private directory = resolve(".runtime/football"), private request: typeof fetch = fetch, private now = Date.now) {}
  async refresh(firstSeason?: number): Promise<void> {
    if (this.now() - this.checkedAt < 6 * 3600000) return;
    this.checkedAt = this.now();
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const year = new Date(this.now()).getUTCFullYear() - (new Date(this.now()).getUTCMonth() < 6 ? 1 : 0);
    if (firstSeason !== undefined && (!Number.isInteger(firstSeason) || firstSeason < 2000 || firstSeason > year)) throw new Error("Temporada inválida");
    await Promise.all(leagues.map(async (league) => {
      const file = resolve(this.directory, `${league.id}.json`);
      try {
        const urls = league.code === "MEX" ? ["https://football-data.co.uk/new/MEX.csv"] : Array.from({length:year-(firstSeason ?? year-2)+1},(_,i)=>(firstSeason ?? year-2)+i).map((y) => `https://football-data.co.uk/mmz4281/${String(y).slice(-2)}${String(y + 1).slice(-2)}/${league.code}.csv`);
        const matches: Match[] = [], sources: FootballDataset["sources"] = [];
        for (const url of urls) {
          const response = await this.request(url, { signal: AbortSignal.timeout(15000) });
          if (!response.ok) throw new Error("Fuente de fútbol no disponible");
          const raw = await response.text();
          if (raw.length > 8 * 1024 * 1024) throw new Error("Fuente excesiva");
          const sha256 = hash(raw);
          writeFileSync(resolve(this.directory, `${sha256}.csv`), raw, { mode: 0o600 });
          sources.push({ url, sha256 }); matches.push(...parseMatches(raw));
        }
        const unique = deduplicate(matches);
        const data: FootballDataset = { matches: unique, sources, verifiedAt: this.now(), checksum: hash(JSON.stringify({ matches: unique, sources })) };
        writeFileSync(file + ".tmp", JSON.stringify(data), { mode: 0o600 }); renameSync(file + ".tmp", file);
        this.datasets.set(league.id, data); this.status[league.id] = `${matches.length} resultados verificados`;
      } catch {
        if (!this.datasets.has(league.id) && existsSync(file)) {
          try { const cached = JSON.parse(readFileSync(file, "utf8")) as FootballDataset; if (!Number.isFinite(cached.verifiedAt) || cached.verifiedAt > this.now() || cached.checksum !== hash(JSON.stringify({ matches: cached.matches, sources: cached.sources }))) throw new Error();
            this.datasets.set(league.id, restoreSources(cached,this.directory)); } catch { this.status[league.id] = "Caché inválida"; }
        }
        this.status[league.id] = "Fuente no disponible; comprobar antigüedad del historial";
      }
    }));
    this.forecasts.clear();
  }
  forecast(market: FootballMarket): Forecast | undefined {
    const data = this.datasets.get(market.league), now = this.now();
    if (!data || data.verifiedAt > now || now - data.verifiedAt > 7 * 86400000) return undefined;
    const key = `${market.matchId}:${market.home}:${market.away}:${market.startAt}:${market.result}:${data.checksum}:${new Date(now).toISOString().slice(0, 10)}`;
    if (this.forecasts.has(key)) return this.forecasts.get(key);
    const teams = data.matches.flatMap((m) => [m.home, m.away]);
    const home = matchTeam(market.home, teams), away = matchTeam(market.away, teams);
    if (!home || !away || home === away) return undefined;
    const before = Math.min(market.startAt, Date.parse(new Date(now).toISOString().slice(0, 10)));
    const p = poisson(data.matches, home, away, before);
    if (!p) { this.forecasts.set(key, undefined); return undefined; }
    const result = { probability: p[market.result], version: footballPolicy.version, checksum: data.checksum, generatedAt: now, dataVerifiedAt: data.verifiedAt, sampleSize: p.sampleSize };
    if (this.forecasts.size > 1000) this.forecasts.clear();
    this.forecasts.set(key, result);
    return result;
  }
}

/** Competition, teams, proposition and 90-minute rules must agree. */
export function footballMarket(event: import('@polymarket/client').Event, market: import('@polymarket/client').Market, series: ReadonlyMap<string, string>): FootballMarket | undefined {
  const sport = event.sports.sport;
  const league = leagues.find((l) => l.id === sport?.sport);
  const expected = league && series.get(league.id);
  if (!league || !expected || String(sport?.series) !== expected || !event.series.some((s) => s.id === expected) || excludedCompetition(event) || excludedCompetition(market)) return undefined;
  if (!event.state.active || event.state.closed || event.state.archived || !market.state.active || market.state.closed || market.state.archived || !market.state.acceptingOrders || !market.state.enableOrderBook || market.version !== 'v1') return undefined;
  const teams = event.sports.teams;
  if (teams.length !== 2 || teams.some((t) => t.league !== league.id)) return undefined;
  const home = teams.filter((t) => t.ordering === 'home'), away = teams.filter((t) => t.ordering === 'away');
  if (home.length !== 1 || away.length !== 1 || !home[0].name || !away[0].name || teamKey(home[0].name) === teamKey(away[0].name)) return undefined;
  const startAt = Date.parse(event.schedule.startTime ?? '');
  if (!Number.isFinite(startAt) || Date.parse(market.sports.gameStartTime ?? '') !== startAt || market.sports.sportsMarketType !== 'moneyline' || market.outcomes.yes?.label?.toLowerCase() !== 'yes' || market.outcomes.no?.label?.toLowerCase() !== 'no') return undefined;
  const desc = market.description ?? '', group = market.groupItemTitle;
  if (!desc.includes('first 90 minutes of regular play plus stoppage time')) return undefined;
  let result: FootballMarket['result'] | undefined;
  if (group === home[0].name && desc.includes(`If ${home[0].name} wins, this market will resolve to "Yes"`)) result = 'home';
  if (group === away[0].name && desc.includes(`If ${away[0].name} wins, this market will resolve to "Yes"`)) result = 'away';
  if (group === `Draw (${home[0].name} vs. ${away[0].name})` && desc.includes('If the game ends in a draw, this market will resolve to "Yes"')) result = 'draw';
  if (!result) return undefined;
  return {matchId: `${league.id}:${event.sports.gameId ?? event.parentEventId ?? event.id}`, league: league.id, home: home[0].name, away: away[0].name, startAt, result};
}
export function excludedCompetition(value: {tags: {slug?: string | null; label?: string | null}[]; title?: string | null; question?: string | null; series?: {slug?: string | null; title?: string | null}[]}): boolean {
  return /world.?cup|fifa|mundial|wc.?qualif/i.test([value.title,value.question,...value.tags.flatMap(t=>[t.slug,t.label]),...(value.series ?? []).flatMap(s=>[s.slug,s.title])].join(' '));
}
