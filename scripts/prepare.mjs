// Enrich an explicitly authored scenario using public weekly statistics.
// The cutoff week must be a fully completed week. Never infer availability from missing stats.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseCSV } from '../lib/csv.mjs';
import { baselineFromHistory, validateDataset } from '../lib/model.mjs';
try {
  const [scenarioPath, csvPath, cutoffSeasonRaw, cutoffWeekRaw, output] = process.argv.slice(2);
  const cutoffSeason = Number(cutoffSeasonRaw), cutoffWeek = Number(cutoffWeekRaw);
  if (!output || !Number.isInteger(cutoffSeason) || !Number.isInteger(cutoffWeek) || cutoffWeek < 1 || cutoffWeek > 18) throw new Error('Usage: node scripts/prepare.mjs <scenario.json> <nflverse.csv> <completed-season> <completed-week> <output.json>');
  const data = JSON.parse(await readFile(scenarioPath, 'utf8'));
  const calibration = JSON.parse(await readFile(fileURLToPath(new URL('../data/calibration.json', import.meta.url)), 'utf8'));
  const rows = parseCSV(await readFile(csvPath, 'utf8')).filter(r => r.season_type === 'REG' && (Number(r.season) < cutoffSeason || (Number(r.season) === cutoffSeason && Number(r.week) <= cutoffWeek)))
    .sort((a, b) => Number(a.season) - Number(b.season) || Number(a.week) - Number(b.week));
  let updated = 0;
  for (const s of data.scenarios) for (const p of s.players) {
    if (!p.nflverseId) continue;
    const history = rows.filter(r => r.player_id === p.nflverseId && r.position === p.position);
    if (!history.length) throw new Error(`No historical appearances found for ${p.name}; provide explicit inputs for new players.`);
    // A supplied ID must belong to the exact intended player; no name-based guessing.
    p.historicalPlayerName = history.at(-1).player_display_name;
    for (const m of p.markets) {
      const baseline = baselineFromHistory(history, p.position, m.key, calibration);
      m.opportunities = baseline.opportunities; m.rate = baseline.rate; updated++;
    }
  }
  if (!updated) throw new Error('No affected players have nflverseId. Add explicit IDs before using this tool.');
  data.historyCutoff = { season: cutoffSeason, completedWeek: cutoffWeek, source: 'nflverse', caveat: 'Recent recorded appearances may already reflect an injury. Review starter-active baseline assumptions before projecting.' };
  validateDataset(data);
  await writeFile(output, JSON.stringify(data, null, 2) + '\n');
  console.log(`Prepared ${updated} markets. Verify historicalPlayerName mappings and starter-active workload assumptions in the output before use.`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
