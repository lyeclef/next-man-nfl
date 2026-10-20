import { POSITIONS } from './model.mjs';
const opportunities = ['carries', 'targets', 'attempts'];
const stats = ['passing_yards', 'rushing_yards', 'receiving_yards', 'receptions'];
const sums = rows => Object.fromEntries([...opportunities, ...stats].map(k => [k, rows.reduce((a, r) => a + Number(r?.[k] ?? 0), 0)]));
export const canonicalTeam = t => ({ OAK: 'LV', SD: 'LAC', STL: 'LA', LAR: 'LA', WSH: 'WAS' })[t] ?? t;
export function kickoffUTC(game) {
  if (!/^\d\d:\d\d/.test(game.gametime ?? '')) return NaN;
  const guess = Date.parse(`${game.gameday}T${game.gametime}:00Z`);
  const part = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' }).formatToParts(new Date(guess)).find(p => p.type === 'timeZoneName').value;
  const match = part.match(/GMT([+-])(\d+)(?::(\d+))?/);
  const offset = match ? (match[1] === '+' ? 1 : -1) * (Number(match[2]) * 60 + Number(match[3] ?? 0)) : 0;
  return guess - offset * 60000;
}
function weightedHistory(rows) {
  const recent = rows.slice(-4), baseline = {}, last = recent.at(-1) ?? {};
  const weights = recent.map((_, i) => 0.7 ** (recent.length - i - 1)), sumW = weights.reduce((a, x) => a + x, 0);
  for (const k of [...opportunities, ...stats]) baseline[k] = recent.reduce((a, r, i) => a + Number(r?.[k] ?? 0) * weights[i], 0) / (sumW || 1);
  return { baseline, last: Object.fromEntries(opportunities.map(k => [k, Number(last[k] ?? 0)])), recent };
}
export function fitEfficiencyPriors(rows) {
  const groups = {};
  for (const pos of POSITIONS) for (const [market, opportunity] of [['passing_yards', 'attempts'], ['rushing_yards', 'carries'], ['receiving_yards', 'targets'], ['receptions', 'targets']]) {
    const selected = rows.filter(r => r.position === pos && Number(r[opportunity]) > 0);
    const total = selected.reduce((a, r) => a + Number(r[opportunity]), 0);
    groups[`${pos}:${market}`] = { rate: total ? Math.max(0, selected.reduce((a, r) => a + Number(r[market]), 0) / total) : 0,
      strength: opportunity === 'attempts' ? 50 : opportunity === 'carries' ? 20 : 15 };
  }
  return groups;
}
export function buildInjuryEvents({ season, games, stats: statRows, injuries, depth, priors }) {
  const audit = { season, teamGames: 0, events: 0, lateOrInvalidReports: 0, noSingleNewAbsence: 0, missingPriorDepth: 0, insufficientHistory: 0, inconsistentOutcomes: 0 };
  const schedule = games.filter(g => Number(g.season) === season && g.game_type === 'REG' && g.home_score !== '' && g.away_score !== '').sort((a, b) => Number(a.week) - Number(b.week));
  const byTeam = new Map(), statsByTeamWeek = new Map(), reportByTeamWeek = new Map(), depthByTeamWeek = new Map();
  for (const g of schedule) for (const team of [g.home_team, g.away_team]) { const t = canonicalTeam(team); (byTeam.get(t) ?? byTeam.set(t, []).get(t)).push(g); }
  for (const r of statRows.filter(r => r.season_type === 'REG')) { const k = `${canonicalTeam(r.recent_team)}:${r.week}`; (statsByTeamWeek.get(k) ?? statsByTeamWeek.set(k, []).get(k)).push(r); }
  for (const r of injuries.filter(r => r.game_type === 'REG')) { const k = `${canonicalTeam(r.team)}:${r.week}`; (reportByTeamWeek.get(k) ?? reportByTeamWeek.set(k, []).get(k)).push(r); }
  for (const r of depth.filter(r => r.game_type === 'REG' && r.formation === 'Offense' && POSITIONS.includes(r.position) && r.gsis_id)) {
    const k = `${canonicalTeam(r.club_code)}:${r.week}`; (depthByTeamWeek.get(k) ?? depthByTeamWeek.set(k, []).get(k)).push(r);
  }
  const events = [];
  for (const [team, teamGames] of byTeam) for (let gi = 0; gi < teamGames.length; gi++) {
    audit.teamGames++;
    if (gi < 3) { audit.insufficientHistory++; continue; }
    const game = teamGames[gi], week = Number(game.week), kickoff = kickoffUTC(game);
    if (!Number.isFinite(kickoff)) continue;
    const previousGames = teamGames.slice(Math.max(0, gi - 4), gi), previousWeek = Number(previousGames.at(-1).week);
    const currentStats = statsByTeamWeek.get(`${team}:${week}`) ?? [];
    if (!currentStats.length) continue; // Missing game data is never interpreted as every player scoring zero.
    const currentById = new Map(currentStats.map(r => [r.player_id, r]));
    const previousRows = previousGames.map(g => statsByTeamWeek.get(`${team}:${g.week}`) ?? []);
    if (previousRows.some(rows => !rows.length)) continue;
    const priorDepth = depthByTeamWeek.get(`${team}:${previousWeek}`);
    if (!priorDepth?.length) { audit.missingPriorDepth++; continue; }
    const reports = new Map();
    for (const r of reportByTeamWeek.get(`${team}:${week}`) ?? []) {
      const at = Date.parse(r.date_modified);
      if (!Number.isFinite(at) || at >= kickoff) { audit.lateOrInvalidReports++; continue; }
      if (!reports.has(r.gsis_id) || at > Date.parse(reports.get(r.gsis_id).date_modified)) reports.set(r.gsis_id, r);
    }
    const priorPlayer = id => weightedHistory(previousRows.map(rows => rows.find(r => r.player_id === id) ?? {}));
    const outs = [...reports.values()].filter(r => r.report_status === 'Out');
    const highUsage = outs.filter(r => {
      if (!POSITIONS.includes(r.position) || /not injury|personal|rest|illness|covid/i.test(r.report_primary_injury)) return false;
      const h = priorPlayer(r.gsis_id), metric = r.position === 'QB' ? 'attempts' : r.position === 'RB' ? 'carries' : 'targets';
      const minimum = { QB: 15, RB: 5, WR: 3, TE: 2 }[r.position];
      return h.baseline[metric] >= minimum && h.last[metric] >= (r.position === 'QB' ? 10 : 1);
    });
    if (highUsage.length !== 1) { audit.noSingleNewAbsence++; continue; }
    const injured = highUsage[0], injuredHistory = priorPlayer(injured.gsis_id);
    // Outcome consistency is only an audit exclusion, never an inference of the injury label.
    if (opportunities.some(k => Number(currentById.get(injured.gsis_id)?.[k] ?? 0) > 0)) { audit.inconsistentOutcomes++; continue; }
    const outIds = new Set(outs.map(r => r.gsis_id)), candidates = new Map();
    for (const d of priorDepth) {
      if (outIds.has(d.gsis_id)) continue;
      const old = candidates.get(d.gsis_id), rank = Number(d.depth_team) || 99;
      if (!old || rank < old.depthRank) candidates.set(d.gsis_id, { id: d.gsis_id, name: d.full_name, position: d.position, depthRank: rank });
    }
    const players = [...candidates.values()].map(p => {
      const h = priorPlayer(p.id), actual = sums(currentById.has(p.id) ? [currentById.get(p.id)] : []), rates = {};
      for (const [market, opportunity] of [['passing_yards', 'attempts'], ['rushing_yards', 'carries'], ['receiving_yards', 'targets'], ['receptions', 'targets']]) {
        const prior = priors[`${p.position}:${market}`], totalOpp = h.recent.reduce((a, r) => a + Number(r[opportunity] ?? 0), 0), totalStat = h.recent.reduce((a, r) => a + Number(r[market] ?? 0), 0);
        rates[market] = (totalStat + prior.strength * prior.rate) / (totalOpp + prior.strength);
      }
      return { ...p, baseline: h.baseline, last: h.last, rates, actual };
    });
    if (!players.length) continue;
    const opponent = canonicalTeam(canonicalTeam(game.home_team) === team ? game.away_team : game.home_team);
    events.push({ id: `${season}:${week}:${team}`, gameId: game.game_id, season, week, team, opponent, kickoff: new Date(kickoff).toISOString(),
      injuryId: injured.gsis_id, injuryPlayer: injured.full_name, injuryPosition: injured.position, injuryDescription: injured.report_primary_injury,
      injuryUpdatedAt: injured.date_modified, historyWeeks: previousGames.map(g => Number(g.week)), depthWeek: previousWeek,
      vacated: Object.fromEntries(opportunities.map(k => [k, injuredHistory.baseline[k]])), players });
    audit.events++;
  }
  return { events, audit };
}
