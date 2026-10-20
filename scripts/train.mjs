import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseCSV } from '../lib/csv.mjs';
import { MARKETS, POSITIONS, baselineFromHistory } from '../lib/model.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const cache = path.join(root, '.cache'); await mkdir(cache, { recursive: true });
async function season(year) {
  const file = path.join(cache, `player_stats_${year}.csv`);
  let csv;
  try { csv = await readFile(file, 'utf8'); } catch {
    const url = `https://github.com/nflverse/nflverse-data/releases/download/player_stats/player_stats_${year}.csv`;
    console.log(`Downloading public nflverse ${year} player statistics…`);
    const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`nflverse returned ${response.status}; no synthetic training data substituted.`);
    csv = await response.text(); await writeFile(file, csv);
  }
  const rows = parseCSV(csv).filter(r => r.season_type === 'REG' && POSITIONS.includes(r.position));
  for (const r of rows) for (const key of ['season', 'week', 'attempts', 'carries', 'targets', 'passing_yards', 'rushing_yards', 'receiving_yards', 'receptions']) {
    const n = Number(r[key]); if (!Number.isFinite(n)) throw new Error(`Invalid ${key} in historical stats.`); r[key] = n;
  }
  return rows.sort((a, b) => a.week - b.week || a.player_id.localeCompare(b.player_id));
}
const [train, holdout] = await Promise.all([season(2023), season(2024)]);
const groups = {};
for (const pos of POSITIONS) for (const [key, spec] of Object.entries(MARKETS)) {
  if (!spec.positions.includes(pos)) continue;
  const rows = train.filter(r => r.position === pos && r[spec.opportunity] > 0);
  const totalOpp = rows.reduce((a, r) => a + r[spec.opportunity], 0);
  const totalStat = rows.reduce((a, r) => a + r[spec.stat], 0);
  groups[`${pos}:${key}`] = {
    rate: Math.max(0, totalStat / totalOpp), priorStrength: key === 'passing_yards' ? 50 : key === 'rushing_yards' ? 20 : 15,
    referenceOpportunities: totalOpp / rows.length, trainingAppearances: rows.length,
    rmse: 1
  };
}
const calibration = { version: 1, trainingSeason: 2023, validationSeason: 2024,
  generatedAt: new Date().toISOString(), source: 'nflverse weekly player statistics',
  sourceUrl: 'https://nflreadr.nflverse.com/reference/load_player_stats.html', groups };
function evaluate(rows) {
  const history = new Map(), errors = {};
  for (const row of rows) {
    const historyKey = `${row.player_id}:${row.position}`;
    const previous = history.get(historyKey) ?? [];
    if (previous.length >= 3) for (const [market, spec] of Object.entries(MARKETS)) {
      // Evaluation population: recorded appearances with positive CURRENT exposure.
      // This is not a pregame player-selection rule or an injury backtest.
      if (!spec.positions.includes(row.position) || row[spec.opportunity] <= 0) continue;
      const pred = baselineFromHistory(previous, row.position, market, calibration);
      if (pred.opportunities < 1) continue;
      const actual = row[spec.stat], priorRows = previous.slice(-4);
      const naive = priorRows.reduce((a, r) => a + r[spec.stat], 0) / priorRows.length;
      const key = `${row.position}:${market}`;
      (errors[key] ??= []).push({ error: actual - pred.mean, naiveError: actual - naive,
        scale: Math.sqrt(Math.max(0.25, pred.opportunities / groups[key].referenceOpportunities)) });
    }
    previous.push(row); history.set(historyKey, previous);
  }
  return errors;
}
const trainingErrors = evaluate(train);
for (const [key, g] of Object.entries(groups)) {
  const es = trainingErrors[key] ?? [];
  g.residualExamples = es.length;
  g.rmse = Math.max(key.endsWith(':receptions') ? 1 : 5,
    es.length ? Math.sqrt(es.reduce((a, x) => a + (x.error / x.scale) ** 2, 0) / es.length) : g.rate * 2);
}
const errors = evaluate(holdout), metrics = {};
for (const [key, es] of Object.entries(errors)) {
  metrics[key] = { n: es.length,
    mae: es.reduce((a, x) => a + Math.abs(x.error), 0) / es.length,
    rmse: Math.sqrt(es.reduce((a, x) => a + x.error ** 2, 0) / es.length),
    naiveMAE: es.reduce((a, x) => a + Math.abs(x.naiveError), 0) / es.length,
    interval80Coverage: es.filter(x => Math.abs(x.error) <= 1.28155 * groups[key].rmse * x.scale).length / es.length };
}
const report = { generatedAt: calibration.generatedAt, trainingSeason: 2023, holdoutSeason: 2024,
  method: 'Four most recent recorded appearances, exponentially weighted opportunities; efficiency shrunk to 2023 position/market priors. Uncertainty fitted from 2023 residuals. 2024 predictions only use earlier weeks in that season and frozen 2023 parameters.',
  population: 'Regular-season QB/RB/WR/TE rows with at least 3 prior recorded appearances, positive realized market exposure, and predicted exposure >=1. DNP/zero-exposure outcomes are excluded. This selection prevents interpreting these metrics as pregame prop accuracy.',
  limitations: ['Baseline validation only: no historical injury scenarios or sportsbook odds were supplied.',
    'No betting ROI, calibration of injury probabilities, or demonstrated injury edge.',
    'Normal residual approximation may assign probability to impossible count outcomes or implausible negative yardage; probabilities and intervals are research estimates.',
    'No schedule-aware DNP or inactive rows: recent appearances may overstate workload after injury.',
    'No claim of improvement over the naive baseline; compare the reported errors.'], metrics };
await mkdir(path.join(root, 'data'), { recursive: true });
await writeFile(path.join(root, 'data/calibration.json'), JSON.stringify(calibration, null, 2) + '\n');
await writeFile(path.join(root, 'data/validation.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`Fitted ${Object.keys(groups).length} position/market groups; evaluated ${Object.values(metrics).reduce((a, x) => a + x.n, 0)} market observations in 2024.`);
console.table(Object.fromEntries(Object.entries(metrics).map(([k, m]) => [k, { n: m.n, MAE: m.mae.toFixed(2), naiveMAE: m.naiveMAE.toFixed(2), coverage80: (m.interval80Coverage * 100).toFixed(1) + '%' }])));
