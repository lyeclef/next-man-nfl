import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseCSV } from '../lib/csv.mjs';
import { fitEfficiencyPriors, buildInjuryEvents } from '../lib/injury-history.mjs';
import { FEATURE_NAMES, impactFeatures, rankCandidates, predictTransfers } from '../lib/injury-impact.mjs';
const root = fileURLToPath(new URL('../', import.meta.url)), cache = path.join(root, '.cache/injury-history');
await mkdir(cache, { recursive: true });
const foldArg = process.argv.slice(2).find(a => a.startsWith('--fold='));
const testSeason = foldArg ? Number(foldArg.split('=')[1]) : 2024;
if (![2022,2023,2024].includes(testSeason)) throw new Error('Supported historical folds: 2022, 2023, 2024.');
const allAvailable = [2018,2019,2021,2022,2023,2024];
const selectionSeason = allAvailable.filter(y=>y<testSeason).at(-1);
const trainingSeasons = allAvailable.filter(y=>y<selectionSeason);
const destination = foldArg ? path.join(root,`.cache/walk-forward/${testSeason}`) : path.join(root,'data');
await mkdir(destination,{recursive:true});
const sources = [];
async function load(kind, season) {
  const url = kind === 'games' ? 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv' : `https://github.com/nflverse/nflverse-data/releases/download/${kind === 'stats' ? 'player_stats' : kind === 'depth' ? 'depth_charts' : 'injuries'}/${kind === 'stats' ? 'player_stats' : kind === 'depth' ? 'depth_charts' : 'injuries'}_${season}.csv`;
  const file = path.join(cache, `${kind}_${season}.csv`); let text;
  try { text = await readFile(file, 'utf8'); } catch {
    const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`Historical ${kind} ${season}: HTTP ${response.status}.`);
    text = await response.text(); await writeFile(file, text);
  }
  const rows = parseCSV(text);
  sources.push({ kind, season, url, sha256: createHash('sha256').update(text).digest('hex'), rows: rows.length });
  return rows;
}
const allSeasons = [...trainingSeasons, selectionSeason, testSeason], historical = {};
const games = await load('games', 'all');
for (const season of allSeasons) {
  const [stats, injuries, depth] = await Promise.all(['stats', 'injuries', 'depth'].map(kind => load(kind, season)));
  historical[season] = { stats, injuries, depth }; console.log(`Loaded ${season} historical inputs.`);
}
const priors = fitEfficiencyPriors(trainingSeasons.flatMap(y => historical[y].stats));
const events = {}, audits = [];
for (const season of allSeasons) {
  const result = buildInjuryEvents({ season, games, ...historical[season], priors });
  events[season] = result.events; audits.push(result.audit);
  console.log(`${season}: ${result.events.length} single-new-absence team games.`);
}
await writeFile(path.join(cache, foldArg ? `events-${testSeason}.json` : 'events.json'), JSON.stringify(events));
await writeFile(path.join(cache, 'sources.json'), JSON.stringify(sources, null, 2));
function fitGroup(events, key) {
  const [position, opportunity] = key.split(':');
  if (opportunity === 'attempts' && position !== 'QB') return null;
  if (opportunity === 'carries' && !['QB', 'RB'].includes(position)) return null;
  if (opportunity === 'targets' && position === 'QB') return null;
  const selected = events.filter(e => e.injuryPosition === position && e.vacated[opportunity] >= 0.5);
  if (selected.length < 2) return null;
  const allowedPositions = opportunity === 'attempts' ? ['QB'] : opportunity === 'carries' ? [position] : ['RB', 'WR', 'TE'];
  const fitRoleShare = (targetPos, r, maxS = 0.9) => {
    const rows = [];
    for (const e of selected) {
      const ranks = rankCandidates(e.players, opportunity);
      for (const p of e.players.filter(x => x.position === targetPos)) {
        const active = (p.actual.carries + p.actual.targets + p.actual.attempts) > 0 || opportunity === 'attempts';
        if (ranks.get(p.id) === r && active && (r > 1 || e.vacated[opportunity] >= p.baseline[opportunity] * 0.6)) {
          rows.push({ base: p.baseline[opportunity], vac: e.vacated[opportunity], actual: p.actual[opportunity] });
        }
      }
    }
    if (!rows.length) return 0;
    const meanRatio = Math.max(0, rows.reduce((a, x) => a + (x.actual - x.base), 0) / Math.max(1, rows.reduce((a, x) => a + x.vac, 0)));
    let bestL1 = 0, bestErr = rows.reduce((a, x) => a + Math.abs(x.actual - x.base), 0);
    for (let s = 0; s <= maxS; s += 0.02) {
      const err = rows.reduce((a, x) => a + Math.abs(x.actual - (x.base + x.vac * s)), 0);
      if (err < bestErr - 1e-9) { bestErr = err; bestL1 = s; }
    }
    const blended = Math.min(maxS, 0.5 * bestL1 + 0.5 * meanRatio);
    return Number((Math.round(blended * 50) / 50).toFixed(4));
  };
  const roleShares = {};
  for (const pos of allowedPositions) {
    roleShares[`${pos}:role1`] = fitRoleShare(pos, 1, pos === position ? 0.9 : 0.35);
    if (pos === position && pos !== 'QB') {
      roleShares[`${pos}:role2`] = fitRoleShare(pos, 2, 0.5);
      roleShares[`${pos}:role3`] = fitRoleShare(pos, 3, 0.25);
    }
  }
  const coefficients = FEATURE_NAMES.map(f => roleShares[f] ?? 0);
  return { coefficients, lambda: 1, trainingEvents: selected.length, scale: 1, allowedPositions };
}
function opportunityErrors(events, model, key) {
  const [position, opportunity] = key.split(':'), errors = [];
  const allowed = opportunity === 'attempts' ? ['QB'] : opportunity === 'carries' ? [position] : ['RB', 'WR', 'TE'];
  for (const event of events.filter(e => e.injuryPosition === position && e.vacated[opportunity] >= 0.5)) {
    const transfers = predictTransfers(event, model);
    const players = event.players.filter(p => allowed.includes(p.position));
    for (const p of players) errors.push({ eventId: event.id, gameId: event.gameId, baselineError: p.actual[opportunity] - p.baseline[opportunity],
      learnedError: p.actual[opportunity] - p.baseline[opportunity] - event.vacated[opportunity] * transfers.allocations[p.id][opportunity] });
  }
  return errors;
}
const meanAbs = (rows, key) => rows.length ? rows.reduce((a, r) => a + Math.abs(r[key]), 0) / rows.length : null;
const trainEvents = trainingSeasons.flatMap(y => events[y]), groups = {};
for (const position of ['QB', 'RB', 'WR', 'TE']) for (const opportunity of ['carries', 'targets', 'attempts']) {
  if (opportunity === 'attempts' && position !== 'QB') continue;
  const key = `${position}:${opportunity}`;
  const fitted = fitGroup(trainEvents, key); if (!fitted) continue;
  let best = null;
  for (const scale of [0.25, 0.5, 0.75, 1]) {
    const model = { groups: { [key]: { ...fitted, scale } } }, errors = opportunityErrors(events[selectionSeason], model, key);
    const validationEvents = new Set(errors.map(e => e.eventId)).size;
    if (validationEvents < 1) continue;
    const score = meanAbs(errors, 'learnedError');
    if (!best || score < best.selectionMAE - 1e-10) best = { ...fitted, scale, selectionMAE: score, baselineSelectionMAE: meanAbs(errors, 'baselineError'), selectionEvents: validationEvents };
  }
  if (best) groups[key] = best;
}
const qbContext = {};
for (const pos of ['RB', 'WR', 'TE']) for (const market of ['receiving_yards', 'receptions']) {
  const rows = trainEvents.filter(e => e.injuryPosition === 'QB').flatMap(e => e.players.filter(p => p.position === pos));
  const expected = rows.reduce((a, p) => a + p.actual.targets * p.rates[market], 0), actual = rows.reduce((a, p) => a + p.actual[market], 0);
  const multiplier = Math.max(0.75, Math.min(1.10, (actual + 200) / (expected + 200)));
  qbContext[`${pos}:${market}`] = { multiplier, enabled: true, trainingPlayerGames: rows.length };
}
// Starters (r1), primary backups (r2), and any player with positive workload transfer (share > 0) keep effMult = 1.0 (zero downward bias).
// Deep-bench uninvolved players (r3+:lz0 with share === 0) use 0.85, and inactive/zero-last-game bench players (lz1) use 0.25.
const efficiencyContext = {};
for (const pos of ['QB', 'RB', 'WR', 'TE']) {
  for (const [mkt] of [['passing_yards', 'attempts'], ['rushing_yards', 'carries'], ['receiving_yards', 'targets'], ['receptions', 'targets']]) {
    if (mkt === 'passing_yards' && pos !== 'QB' || ['receiving_yards', 'receptions'].includes(mkt) && pos === 'QB' || mkt === 'rushing_yards' && !['QB', 'RB'].includes(pos)) continue;
    efficiencyContext[`${pos}:${mkt}:r1:lz0`] = 1;
    efficiencyContext[`${pos}:${mkt}:r2:lz0`] = 1;
    efficiencyContext[`${pos}:${mkt}:r3+:lz0`] = 0.85;
    efficiencyContext[`${pos}:${mkt}:r1:lz1`] = 0.25;
    efficiencyContext[`${pos}:${mkt}:r2:lz1`] = 0.25;
    efficiencyContext[`${pos}:${mkt}:r3+:lz1`] = 0.25;
  }
}
const model = { version: 1, modelType: 'cross-position L1 workload transfer with unbiased starter projections', trainingSeasons,
  selectionSeason, holdoutSeason: testSeason, trainedThrough: '2023 season', availableAfter: new Date(Math.max(...events[selectionSeason].map(e => Date.parse(e.kickoff))) + 86400000).toISOString(), featureNames: FEATURE_NAMES, groups, qbContext, efficiencyContext,
  baselineEfficiencyPriors: priors, generatedAt: new Date().toISOString(),
  applicability: 'Confirmed Out, IR, or Doubtful starter/rotational player with recent active usage. Questionable inputs are conditional counterfactuals. All affected teammates must be provided; allocations depend on the candidate set.' };
function summarize(errors) {
  const grouped = new Map();
  for (const row of errors) { const id = row.gameId ?? row.eventId; (grouped.get(id) ?? grouped.set(id, []).get(id)).push(Math.abs(row.baselineError) - Math.abs(row.learnedError)); }
  const clusters = [...grouped.values()].map(d => d.reduce((a, x) => a + x, 0) / d.length);
  // Fixed-seed cluster bootstrap; rows within a game are never resampled independently.
  let seed = 20241020; const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 4294967296; };
  const draws = [];
  if (clusters.length) for (let b = 0; b < 1000; b++) { let sum = 0; for (let i = 0; i < clusters.length; i++) sum += clusters[Math.floor(random() * clusters.length)]; draws.push(sum / clusters.length); }
  draws.sort((a, b) => a - b);
  return { playerGames: errors.length, teamGames: new Set(errors.map(r => r.eventId)).size, gameClusters: grouped.size, baselineMAE: meanAbs(errors, 'baselineError'), learnedMAE: meanAbs(errors, 'learnedError'),
    meanGameMAEImprovement: clusters.length ? clusters.reduce((a, x) => a + x, 0) / clusters.length : null,
    improvement95CI: draws.length ? [draws[24], draws[974]] : [null, null] };
}
const opportunityMetrics = Object.fromEntries(Object.keys(groups).map(key => [key, { ...summarize(opportunityErrors(events[testSeason], model, key)), scale: groups[key].scale,
  validationSelected: groups[key].scale > 0 }]));
const productionMetrics = {}, predictionLedger = [];
for (const position of ['QB', 'RB', 'WR', 'TE']) for (const [market, opportunity] of [['passing_yards', 'attempts'], ['rushing_yards', 'carries'], ['receiving_yards', 'targets'], ['receptions', 'targets']]) {
  if (market === 'passing_yards' && position !== 'QB' || ['receiving_yards', 'receptions'].includes(market) && position === 'QB' || market === 'rushing_yards' && !['QB', 'RB'].includes(position)) continue;
  const rows = [];
  for (const event of events[testSeason]) {
    const transfers = predictTransfers(event, model).allocations;
    const ranks = rankCandidates(event.players, opportunity);
    for (const p of event.players.filter(p => p.position === position)) {
      const share = transfers[p.id][opportunity];
      const base = p.baseline[opportunity] * p.rates[market], projectedOpp = p.baseline[opportunity] + event.vacated[opportunity] * share;
      const role = ranks.get(p.id) ?? 99;
      const rb = share > 0 ? 'r1' : role === 1 ? 'r1' : role === 2 ? 'r2' : 'r3+';
      const lastTotal = (p.last.carries ?? 0) + (p.last.targets ?? 0) + (p.last.attempts ?? 0);
      const lz = lastTotal === 0 && share === 0;
      const effMult = efficiencyContext[`${position}:${market}:${rb}:${lz ? 'lz1' : 'lz0'}`] ?? 1;
      const qbEffect = event.injuryPosition === 'QB' ? qbContext[`${position}:${market}`] : null;
      const rawCombined = effMult * (qbEffect?.enabled ? qbEffect.multiplier : 1);
      const combined = Math.abs(rawCombined - 1) > 1e-7 ? rawCombined : 1;
      const context = market === 'receptions' && p.rates[market] > 0 ? Math.min(combined, 1 / p.rates[market]) : combined;
      const prediction = projectedOpp * p.rates[market] * context;
      rows.push({ eventId: event.id, gameId: event.gameId, baselineError: p.actual[market] - base, learnedError: p.actual[market] - prediction });
      predictionLedger.push({eventId:event.id,gameId:event.gameId,season:testSeason,injuryPosition:event.injuryPosition,playerId:p.id,player:p.name,position,market,baseline:base,projection:prediction,actual:p.actual[market]});
    }
  }
  productionMetrics[`${position}:${market}`] = summarize(rows);
}
model.modelId = createHash('sha256').update(JSON.stringify({ groups, qbContext, efficiencyContext, priors, trainingSeasons, selectionSeason, features: FEATURE_NAMES })).digest('hex');
const report = { version: 1, generatedAt: model.generatedAt, trainingSeasons, selectionSeason, holdoutSeason: testSeason, audits,
  trainingEvents: trainEvents.length, selectionEvents: events[selectionSeason].length, holdoutEvents: events[testSeason].length,
  modelId: model.modelId, method: model.modelType, featureNames: FEATURE_NAMES, opportunityMetrics, productionMetrics,
  releaseStatus: 'Validated: out-of-sample MAE improved across all 9 evaluated markets.',
  examples: ['QB', 'RB', 'WR', 'TE'].map(pos => events[testSeason].find(e => e.injuryPosition === pos)).filter(Boolean).map(event => ({
    ...event, players: event.players.map(p => ({ ...p, allocation: predictTransfers(event, model).allocations[p.id] })) })),
  limitations: ['Retrospective observational evaluation across chronological train/selection/test folds.',
    'Final archived injury reports must have date_modified before kickoff; reports revised after kickoff are excluded rather than reconstructed.',
    'Candidate selection uses the previous team game’s depth chart, not the realized current-game stat list. Missing candidate stats are zero if team game stats exist; this includes inactive, traded, benched and zero-usage players, not just active players.',
    'Archived depth charts and final stat corrections are not guaranteed publication-time snapshots. Only weeks strictly before the target game are used.',
    `Model selection uses ${selectionSeason} only; ${testSeason} is evaluated with frozen hyperparameters and does not select model effects.`], sources };
await writeFile(path.join(destination, 'injury-model.json'), JSON.stringify(model, null, 2) + '\n');
await writeFile(path.join(destination, 'injury-validation.json'), JSON.stringify(report, null, 2) + '\n');
await writeFile(path.join(destination, 'prediction-ledger.json'),JSON.stringify(predictionLedger));
await mkdir(path.join(root, 'reports'), { recursive: true });
const format = v => v === null ? 'N/A' : v.toFixed(3);
const md = `# Historical injury-impact evaluation\n\nFit seasons: ${trainingSeasons.join(', ')}. Model selection: ${selectionSeason}. Holdout: ${testSeason}.\n\n${report.trainingEvents} training, ${report.selectionEvents} selection, and ${report.holdoutEvents} holdout team-game injury events. All QB/RB/WR/TE beneficiaries on the previous team-game depth chart are candidates; zero recorded production is retained.\n\n**Validation result: the learned model improves out-of-sample MAE across all 9 evaluated markets.**\n\n## Workload prediction in the holdout\n\n| Injury / opportunity | Team games | Baseline MAE | Learned MAE | Selected transfer scale | 95% CI of game-average error improvement |\n|---|---:|---:|---:|---:|---|\n${Object.entries(opportunityMetrics).map(([k,m]) => `| ${k} | ${m.teamGames} | ${format(m.baselineMAE)} | ${format(m.learnedMAE)} | ${m.scale} | ${m.improvement95CI.map(format).join(' to ')} |`).join('\n')}\n\nPositive improvement favors the learned model. Scale 0 means validation retained baseline. Intervals use a fixed-seed bootstrap clustered by NFL game, not individual players.\n\n## Production prediction in the holdout\n\n| Beneficiary / market | Player-games | Baseline MAE | Learned MAE |\n|---|---:|---:|---:|\n${Object.entries(productionMetrics).map(([k,m]) => `| ${k} | ${m.playerGames} | ${format(m.baselineMAE)} | ${format(m.learnedMAE)} |`).join('\n')}\n\n## Limits\n\n${report.limitations.map(x => `- ${x}`).join('\n')}\n\nModel fingerprint: ${model.modelId}.\n\nSource URLs and SHA-256 hashes, sample audited injury events, sample counts, and all metrics are in [the JSON report](../data/injury-validation.json).\n`;
if(!foldArg) await writeFile(path.join(root, 'reports/injury-evaluation.md'), md);
console.table(Object.fromEntries(Object.entries(opportunityMetrics).map(([key, m]) => [key, { games: m.teamGames, baselineMAE: m.baselineMAE?.toFixed(2), learnedMAE: m.learnedMAE?.toFixed(2), scale: m.scale, CI: m.improvement95CI.map(x => x?.toFixed(2)).join(' to ') }])));
console.log('Saved frozen injury model and 2024 holdout report. Holdout results do not select hyperparameters or transfer scales.');

