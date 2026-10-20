import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decimalOdds, expectedValue, settlement, normalCDF, projectDataset, validateDataset, baselineFromHistory } from '../lib/model.mjs';
import { parseCSV } from '../lib/csv.mjs';
import { mergeOddsExport } from '../lib/odds-import.mjs';
const demo = JSON.parse(await readFile(new URL('./fixtures/synthetic-slate.json', import.meta.url), 'utf8'));
const calibration = JSON.parse(await readFile(new URL('../data/calibration.json', import.meta.url), 'utf8'));
const copy = () => structuredClone(demo);
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);
test('American payout, expected value, and refunded pushes', () => {
  near(decimalOdds(-110), 1 + 100 / 110); near(decimalOdds(150), 2.5);
  near(expectedValue(0.55, 0, -110), 0.05); near(expectedValue(0.4, 0.2, 100), 0);
  assert.throws(() => decimalOdds(0)); assert.throws(() => decimalOdds(-1));
});
test('Integer settlement handles whole-line push and half-line no push', () => {
  const whole = settlement(10, 3, 10), half = settlement(10, 3, 10.5);
  near(whole.over, whole.under); assert.ok(whole.push > 0); near(half.push, 0);
  near(whole.over + whole.under + whole.push, 1); near(normalCDF(0), 0.5);
});
test('Reception distribution has no negative counts and handles zero opportunity', () => {
  const zero = settlement(0, 1, 0, 'count'); near(zero.push, 1); near(zero.under, 0); near(zero.over, 0);
  const count = settlement(3, 2, 0, 'count'); near(count.under, 0); assert.ok(count.push > 0);
  const half = settlement(3, 2, 3.5, 'count'); near(half.push, 0); near(half.over + half.under, 1);
});
test('QB, RB, WR and TE project and all outputs remain research estimates', () => {
  const rows = projectDataset(demo, calibration, { now: demo.asOf });
  assert.deepEqual([...new Set(rows.map(r => r.position))].sort(), ['QB', 'RB', 'TE', 'WR']);
  for (const r of rows) { assert.equal(r.eligible, false); assert.equal(r.modelStatus, 'not_validated'); assert.ok(Number.isFinite(r.projection)); near(r.overProbability + r.underProbability + r.pushProbability, 1); }
});
test('Workload is conserved across a committee and cannot exceed 100%', () => {
  const rows = projectDataset(demo, calibration, { now: demo.asOf }).filter(r => r.scenarioId === 'demo-rb' && r.market === 'rushing_yards');
  near(rows.reduce((a, r) => a + r.absentOpportunities - r.baselineOpportunities, 0), 16);
  const data = copy(); data.scenarios[0].players[0].allocation.carries = 1;
  assert.throws(() => validateDataset(data), /exceeds 100%/);
});
test('Multiple target markets on one player do not consume allocation twice', () => {
  assert.doesNotThrow(() => validateDataset(demo));
  const data = copy(); data.scenarios[1].players[0].allocation.targets = 0.8;
  assert.throws(() => validateDataset(data), /targets allocation/);
});
test('Zero absence probability restores active workload and projection', () => {
  for (const r of projectDataset(demo, calibration, { now: demo.asOf, absence: { 'demo-wr': 0 } }).filter(r => r.scenarioId === 'demo-wr')) {
    near(r.projection, r.activeMean); near(r.expectedOpportunities, r.baselineOpportunities);
  }
});
test('Uncertain availability mixes probabilities, not just means', () => {
  const at = q => projectDataset(demo, calibration, { now: demo.asOf, absence: { 'demo-wr': q } }).find(r => r.playerId === 'jalen' && r.market === 'receiving_yards');
  const zero = at(0), one = at(1), half = at(0.5);
  near(half.overProbability, (zero.overProbability + one.overProbability) / 2); near(half.projection, (zero.projection + one.projection) / 2);
});
test('Backup QB affects his own attempts and receiver efficiency', () => {
  const rows = projectDataset(demo, calibration, { now: demo.asOf });
  const qb = rows.find(r => r.playerId === 'theo' && r.market === 'passing_yards'); near(qb.absentOpportunities, 30);
  const wr = rows.find(r => r.playerId === 'devon'); assert.ok(wr.projection < wr.activeMean);
});
test('A zero-opportunity scenario has a point mass at zero, without phantom production', () => {
  const data = copy(); data.scenarios[2].injury.status = 'QUESTIONABLE'; data.scenarios[2].injury.absenceProbability = 0;
  const row = projectDataset(data, calibration, { now: demo.asOf }).find(r => r.playerId === 'theo' && r.market === 'passing_yards');
  near(row.projection, 0); near(row.overProbability, 0); near(row.underProbability, 1);
});
test('Nonlinear outcome prices keep projection gaps separate from EV', () => {
  const data = copy(), m = data.scenarios[0].players[0].markets[0];
  const row1 = projectDataset(data, calibration, { now: demo.asOf }).find(r => r.playerId === 'owen' && r.market === 'rushing_yards');
  m.overOdds = -400;
  const row2 = projectDataset(data, calibration, { now: demo.asOf }).find(r => r.playerId === 'owen' && r.market === 'rushing_yards');
  near(row1.projectionGapPct, row2.projectionGapPct); assert.ok(row2.researchOverEV < row1.researchOverEV); assert.equal(row1.overEV, null);
});
test('No future snapshot information, duplicate IDs, invalid odds or implicit probabilities', () => {
  for (const change of [d => d.scenarios[0].injury.updatedAt = '2027-01-01T00:00:00Z', d => d.scenarios[0].players[0].markets[0].updatedAt = '2027-01-01T00:00:00Z', d => d.scenarios[1].id = d.scenarios[0].id, d => d.scenarios[0].players[0].markets[0].overOdds = 1.91, d => delete d.scenarios[0].injury.absenceProbability, d => d.scenarios[0].injury.absenceProbability = 0.5]) {
    const data = copy(); change(data); assert.throws(() => validateDataset(data));
  }
});
test('Post-kickoff and stale inputs are flagged', () => {
  const rows = projectDataset(demo, calibration, { now: '2026-10-26T17:00:00Z' });
  assert.ok(rows.every(r => r.archived)); assert.ok(rows[0].warnings.some(w => w.includes('6 hours')));
});
test('Baseline handles sparse history with efficiency shrinkage', () => {
  const b = baselineFromHistory([{ carries: 10, rushing_yards: 100 }], 'RB', 'rushing_yards', calibration);
  near(b.opportunities, 10); assert.ok(b.rate < 10); assert.ok(b.rate > 0);
  assert.throws(() => baselineFromHistory([], 'RB', 'rushing_yards', calibration));
});
test('CSV parser preserves quoted names, newlines, zeros and BOM', () => {
  const rows = parseCSV('\uFEFFname,value,note\r\n"Doe, John",0,"a\n""quote"""\r\n');
  assert.equal(rows[0].name, 'Doe, John'); assert.equal(rows[0].value, '0'); assert.equal(rows[0].note, 'a\n"quote"');
  assert.throws(() => parseCSV('x,x\n1,2')); assert.throws(() => parseCSV('x\n"oops'));
});
test('Offline odds import pairs exact event/player/line and preserves snapshot cutoff', () => {
  const data = copy(), s = data.scenarios[0];
  const events = { id: 'event-a', commence_time: s.kickoff, bookmakers: [{ key: 'test', title: 'Imported book', last_update: demo.asOf, markets: [{ key: 'player_rush_yds', outcomes: [{ name: 'Over', description: 'Owen Brooks', price: -115, point: 52.5 }, { name: 'Under', description: 'Owen Brooks', price: -105, point: 52.5 }] }] }] };
  const mapping = [{ scenarioId: s.id, playerId: 'owen', eventId: 'event-a', description: 'Owen Brooks' }];
  const result = mergeOddsExport(data, events, mapping); assert.equal(result.merged, 1); assert.equal(result.dataset.asOf, demo.asOf); validateDataset(result.dataset);
  events.commence_time = '2026-10-25T20:00:00Z'; assert.throws(() => mergeOddsExport(data, events, mapping), /kickoff/);
});
