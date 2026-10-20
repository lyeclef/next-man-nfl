import { applyLearnedImpact } from './injury-impact.mjs';
export const MARKETS = {
  passing_yards: { label: 'Passing yards', opportunity: 'attempts', stat: 'passing_yards', positions: ['QB'] },
  rushing_yards: { label: 'Rushing yards', opportunity: 'carries', stat: 'rushing_yards', positions: ['QB', 'RB', 'WR', 'TE'] },
  receiving_yards: { label: 'Receiving yards', opportunity: 'targets', stat: 'receiving_yards', positions: ['RB', 'WR', 'TE'] },
  receptions: { label: 'Receptions', opportunity: 'targets', stat: 'receptions', positions: ['RB', 'WR', 'TE'] }
};
export const POSITIONS = ['QB', 'RB', 'WR', 'TE'];
const own = (o, k) => Object.hasOwn(o, k);
function number(value, label, min = -Infinity, max = Infinity) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label} must be a number between ${min} and ${max}.`);
  return value;
}
function string(value, label) { if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`); }
function time(value, label) { if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || !/(Z|[+-]\d\d:\d\d)$/.test(value)) throw new Error(`${label} must be an ISO timestamp with a timezone.`); }
function odds(value, label) { number(value, label); if (Math.abs(value) < 100) throw new Error(`${label} must use American odds (at least +100 or at most -100).`); }
export function decimalOdds(american) { odds(american, 'Odds'); return american > 0 ? 1 + american / 100 : 1 + 100 / -american; }
export function expectedValue(win, push, american) { return win * (decimalOdds(american) - 1) - (1 - win - push); }
export function impliedProbability(american) { return 1 / decimalOdds(american); }
export function normalCDF(x) {
  if (x === Infinity) return 1; if (x === -Infinity) return 0;
  const sign = x < 0 ? -1 : 1, z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return (1 + sign * erf) / 2;
}
export function countCDF(k, mean, variance) {
  if (k < 0) return 0;
  if (mean === 0) return 1;
  // Negative binomial for overdispersion, Poisson when fitted variance <= mean.
  const poisson = variance <= mean + 0.0001;
  const shape = poisson ? 0 : mean * mean / (variance - mean);
  const prob = poisson ? 0 : shape / (shape + mean);
  let mass = poisson ? Math.exp(-mean) : Math.exp(shape * Math.log(prob)), sum = mass;
  for (let j = 1; j <= Math.floor(k); j++) {
    mass *= poisson ? mean / j : (j - 1 + shape) / j * (1 - prob);
    sum += mass;
  }
  return Math.min(1, Math.max(0, sum));
}
export function gammaCDF(x, mean, sd) {
  if (x <= 0) return 0;
  if (mean <= 0) return 1;
  const effSD = Math.min(sd, 0.85 * mean);
  const k = (mean / effSD) ** 2;
  const z = (Math.cbrt(x / mean) - (1 - 1 / (9 * k))) / (1 / (3 * Math.sqrt(k)));
  return normalCDF(z);
}
// Rounded normal or right-skewed gamma: respects integer stat settlement and refunds on whole-number lines.
export function settlement(mean, sd, line, distribution = 'normal') {
  number(mean, 'Mean'); number(sd, 'Standard deviation', 0.0001); number(line, 'Line', 0);
  const isWhole = Number.isInteger(line);
  const low = isWhole ? line - 0.5 : Math.floor(line) + 0.5;
  const high = isWhole ? line + 0.5 : low;
  const cdf = x => distribution === 'gamma' ? gammaCDF(x, mean, sd) : normalCDF((x - mean) / sd);
  const under = distribution === 'count' ? countCDF(Math.ceil(line) - 1, mean, sd * sd) : cdf(low);
  const over = distribution === 'count' ? 1 - countCDF(Math.floor(line), mean, sd * sd) : 1 - cdf(high);
  return { over, under, push: Math.max(0, 1 - over - under) };
}
export function baselineFromHistory(history, position, market, calibration) {
  const spec = MARKETS[market], prior = calibration.groups[`${position}:${market}`];
  if (!spec || !prior) throw new Error(`No fitted baseline for ${position}/${market}.`);
  const recent = history.slice(-4);
  if (!recent.length) throw new Error('At least one historical appearance is required; use explicit opportunity inputs for a rookie.');
  let weights = 0, totalOpp = 0, totalStat = 0;
  recent.forEach((row, i) => {
    const w = 0.7 ** (recent.length - 1 - i), opp = Number(row[spec.opportunity]), stat = Number(row[spec.stat]);
    number(opp, spec.opportunity, 0); number(stat, spec.stat);
    weights += w; totalOpp += w * opp; totalStat += w * stat;
  });
  const opportunities = totalOpp / weights;
  const rate = (totalStat + prior.priorStrength * prior.rate) / (totalOpp + prior.priorStrength);
  return { opportunities, rate, mean: opportunities * rate, appearances: recent.length };
}
export function validateDataset(data) {
  if (!data || data.schemaVersion !== 1) throw new Error('Expected schemaVersion: 1.');
  string(data.name, 'Dataset name');
  if (!['sourced', 'historical', 'import'].includes(data.mode)) throw new Error('Mode must be sourced, historical, or import. Demonstration slates are no longer supported.');
  time(data.asOf, 'asOf');
  if (!Array.isArray(data.scenarios) || data.scenarios.length > 500 || (data.mode === 'import' && !data.scenarios.length)) throw new Error('Provide up to 500 scenarios (at least one for an import).');
  const ids = new Set();
  for (const s of data.scenarios) {
    if (s.allocationMode !== undefined && !['manual', 'learned', 'baseline'].includes(s.allocationMode)) throw new Error('allocationMode must be manual, learned, or baseline.');
    string(s.id, 'Scenario id'); if (ids.has(s.id)) throw new Error('Scenario ids must be unique.'); ids.add(s.id);
    string(s.team, 'Team'); string(s.opponent, 'Opponent'); time(s.kickoff, 'Kickoff');
    const snapshot = s.asOf ?? data.asOf; time(snapshot, 'Scenario asOf');
    if (Date.parse(snapshot) >= Date.parse(s.kickoff)) throw new Error(`${s.id}: asOf must precede kickoff.`);
    const injury = s.injury;
    if (!injury) throw new Error(`${s.id}: injury is required.`);
    string(injury.player, 'Injured player');
    if (!POSITIONS.includes(injury.position)) throw new Error('Injury position must be QB, RB, WR, or TE.');
    if (!['OUT', 'DOUBTFUL', 'QUESTIONABLE', 'IR'].includes(injury.status)) throw new Error('Unsupported injury status.');
    string(injury.description, 'Injury description'); string(injury.source, 'Injury source'); time(injury.updatedAt, 'Injury updatedAt');
    if (Date.parse(injury.updatedAt) > Date.parse(snapshot)) throw new Error('Injury information cannot be newer than asOf.');
    number(injury.absenceProbability, 'Absence probability', 0, 1);
    if (['OUT', 'IR'].includes(injury.status) && injury.absenceProbability !== 1) throw new Error('OUT/IR requires absenceProbability: 1.');
    for (const k of ['carries', 'targets', 'attempts']) number(injury.vacated?.[k] ?? 0, `Vacated ${k}`, 0, 80);
    for (const k of ['passing_yards', 'receiving_yards', 'rushing_yards', 'receptions']) if (own(s.context ?? {}, k)) number(s.context[k], `Context ${k}`, 0.25, 2);
    if (!Array.isArray(s.players) || !s.players.length) throw new Error('Each scenario needs affected players.');
    const playerIds = new Set(), allocations = { carries: 0, targets: 0, attempts: 0 };
    if (s.workloadCandidates !== undefined) {
      if (!Array.isArray(s.workloadCandidates) || s.workloadCandidates.length > 100) throw new Error('workloadCandidates must be an array with at most 100 teammates.');
      const ids = new Set();
      for (const c of s.workloadCandidates) {
        string(c.id, 'Candidate id'); if (ids.has(c.id)) throw new Error('Duplicate workload candidate.'); ids.add(c.id);
        if (!POSITIONS.includes(c.position)) throw new Error('Unknown workload candidate position.');
        if (c.depthRank !== undefined && (!Number.isInteger(c.depthRank) || c.depthRank < 1 || c.depthRank > 10)) throw new Error('Invalid workload candidate depthRank.');
        for (const k of ['carries','targets','attempts']) { number(c.baseline?.[k] ?? 0, `Candidate baseline ${k}`, 0, 80); number(c.last?.[k] ?? 0, `Candidate last ${k}`, 0, 80); }
      }
    }
    for (const p of s.players) {
      string(p.id, 'Player id'); string(p.name, 'Player name'); if (playerIds.has(p.id)) throw new Error('Duplicate affected player id.'); playerIds.add(p.id);
      if (!POSITIONS.includes(p.position)) throw new Error('Affected player position must be QB, RB, WR, or TE.');
      if (p.depthRank !== undefined && (!Number.isInteger(p.depthRank) || p.depthRank < 1 || p.depthRank > 10)) throw new Error('depthRank must be an integer from 1 to 10.');
      for (const [k, v] of Object.entries(p.lastOpportunities ?? {})) { if (!['carries', 'targets', 'attempts'].includes(k)) throw new Error('Unknown lastOpportunities field.'); number(v, `Last ${k}`, 0, 80); }
      string(p.assumption, 'Workload assumption');
      for (const k of Object.keys(allocations)) { const share = p.allocation?.[k] ?? 0; number(share, `${p.name} allocation ${k}`, 0, 1); allocations[k] += share; }
      if (!Array.isArray(p.markets) || !p.markets.length) throw new Error('Each affected player needs markets.');
      const marketKeys = new Set();
      for (const m of p.markets) {
        if (!MARKETS[m.key]?.positions.includes(p.position)) throw new Error(`Unsupported market ${m.key} for ${p.position}.`);
        const mk = `${m.key}:${m.book}:${m.line}`; if (marketKeys.has(mk)) throw new Error('Duplicate player/book/market/line.'); marketKeys.add(mk);
        number(m.opportunities, 'Baseline opportunities', 0, 80); number(m.rate, 'Efficiency rate', 0, m.key === 'receptions' ? 1 : 40);
        const hasQuote = m.line !== undefined && m.line !== null;
        if (hasQuote) {
          number(m.line, 'Prop line', 0, 1000); if (!Number.isInteger(m.line * 2)) throw new Error('Lines must use whole or half units.');
          odds(m.overOdds, 'Over odds'); odds(m.underOdds, 'Under odds'); string(m.book, 'Book'); string(m.source, 'Market source'); time(m.updatedAt, 'Market updatedAt');
          if (Date.parse(m.updatedAt) > Date.parse(snapshot)) throw new Error('Market information cannot be newer than asOf.');
        } else {
          if ([m.overOdds,m.underOdds,m.book,m.source,m.updatedAt].some(v => v !== null && v !== undefined)) throw new Error('A quote must include line, both odds, bookmaker, source, and timestamp together.');
          string(m.inputSource, 'Projection input source');
        }
        if (m.actual !== undefined && m.actual !== null) {
          if (data.mode !== 'historical') throw new Error('Actual outcomes are only accepted in historical datasets.');
          if (Date.parse(data.asOf) < Date.parse(s.kickoff) + 8 * 3600000) throw new Error('Historical outcome capture must be after the completed-game window.');
          number(m.actual, 'Actual outcome'); string(m.actualSource, 'Actual outcome source');
        }
        number(m.opponentMultiplier ?? 1, 'Opponent multiplier', 0.5, 1.5);
        if (m.key === 'receptions' && m.rate * (m.opponentMultiplier ?? 1) * Math.max(1, s.context?.receptions ?? 1) > 1) throw new Error('Reception efficiency cannot exceed one catch per target.');
      }
    }
    for (const [k, sum] of Object.entries(allocations)) if (sum > 1.000001) throw new Error(`${s.id}: ${k} allocation exceeds 100%; workload would be double-counted.`);
  }
  return data;
}
export function projectDataset(data, calibration, options = {}) {
  validateDataset(data);
  const scenarios = data.scenarios.map(s => {
    const mode = options.impactMode ?? s.allocationMode ?? 'manual';
    if (!['manual', 'learned', 'baseline'].includes(mode)) throw new Error('Invalid impact mode.');
    if (mode === 'learned') {
      if (!Number.isFinite(Date.parse(options.injuryModel?.availableAfter)) || Date.parse(options.injuryModel.availableAfter) > Date.parse(s.asOf ?? data.asOf)) throw new Error('The injury model training/selection information must be available before the slate asOf timestamp.');
      if (s.injuryModelId && s.injuryModelId !== options.injuryModel.modelId) throw new Error('This slate references a different injury model; use its original fitted artifact.');
      return { ...applyLearnedImpact(s, options.injuryModel), allocationMode: mode };
    }
    const clean = structuredClone(s);
    for (const p of clean.players) { delete p.learnedContext; delete p.learnedImpact; }
    if (mode === 'baseline') { clean.context = {}; for (const p of clean.players) { p.allocation = {}; p.assumption = 'Baseline comparison: no injury-related workload or efficiency adjustments are applied.'; } }
    return { ...clean, allocationMode: mode };
  });
  validateDataset({ ...data, scenarios });
  const now = options.now === undefined ? Date.now() : new Date(options.now).getTime();
  if (!Number.isFinite(now)) throw new Error('Invalid current time.');
  const rows = [];
  for (const s of scenarios) for (const p of s.players) for (const m of p.markets) {
    const prior = calibration.groups[`${p.position}:${m.key}`];
    if (!prior || !Number.isFinite(prior.rmse) || prior.rmse <= 0) throw new Error(`Missing fitted uncertainty for ${p.position}/${m.key}.`);
    const oppKey = MARKETS[m.key].opportunity;
    const gained = (s.injury.vacated?.[oppKey] ?? 0) * (p.allocation?.[oppKey] ?? 0);
    const absentOpp = m.opportunities + gained;
    const factor = m.opponentMultiplier ?? 1;
    const activeMean = m.opportunities * m.rate * factor;
    const combinedContext = (s.context?.[m.key] ?? 1) * (p.learnedContext?.[m.key] ?? 1);
    const context = m.key === 'receptions' && m.rate * factor > 0 ? Math.min(combinedContext, 1 / (m.rate * factor)) : combinedContext;
    const absentMean = absentOpp * m.rate * factor * context;
    const q = options.absence?.[s.id] ?? s.injury.absenceProbability;
    number(q, 'Scenario absence probability', 0, 1);
    const activeSD = m.opportunities === 0 ? 0 : prior.rmse * Math.sqrt(Math.max(0.25, m.opportunities / prior.referenceOpportunities));
    const absentSD = absentOpp === 0 ? 0 : prior.rmse * Math.sqrt(Math.max(0.25, absentOpp / prior.referenceOpportunities));
    const distribution = m.key === 'receptions' ? 'count' : 'gamma';
    const hasQuote = m.line !== undefined && m.line !== null;
    const zero = { over: 0, under: m.line > 0 ? 1 : 0, push: m.line === 0 ? 1 : 0 };
    const missing = { over: null, under: null, push: null };
    const a = !hasQuote ? missing : m.opportunities === 0 ? zero : settlement(activeMean, activeSD, m.line, distribution);
    const b = !hasQuote ? missing : absentOpp === 0 ? zero : settlement(absentMean, absentSD, m.line, distribution);
    const mix = k => (1 - q) * a[k] + q * b[k];
    const overProbability = hasQuote ? mix('over') : null, underProbability = hasQuote ? mix('under') : null, pushProbability = hasQuote ? mix('push') : null;
    const researchOverEV = hasQuote ? expectedValue(overProbability, pushProbability, m.overOdds) : null, researchUnderEV = hasQuote ? expectedValue(underProbability, pushProbability, m.underOdds) : null;
    const archived = Date.parse(s.kickoff) <= now;
    const policy = options.validationPolicy;
    const approved = s.allocationMode === 'learned' && policy?.status === 'approved' && typeof policy.modelId === 'string' &&
      (policy.modelId === options.injuryModel?.modelId || policy.candidateModelId === options.injuryModel?.modelId) &&
      policy.approvedMarkets?.includes(`${p.position}:${m.key}`) === true && policy.probabilityCalibration?.status === 'passed' &&
      policy.pricedValidation?.status === 'passed' && policy.prospective?.status === 'passed';
    const quoteFresh = hasQuote && now >= Date.parse(m.updatedAt) && now - Date.parse(m.updatedAt) <= 168 * 3600000;
    const eligible = approved && hasQuote && quoteFresh && !archived && data.mode !== 'historical' && !s.injury.conditionalOnly;
    const overEV = eligible ? researchOverEV : null, underEV = eligible ? researchUnderEV : null;
    const preferredSide = eligible ? overEV >= underEV ? 'OVER' : 'UNDER' : null;
    const candidateEV = eligible ? Math.max(overEV, underEV) : null;
    const projection = (1 - q) * activeMean + q * absentMean;
    const warnings = [];
    if (s.injury.conditionalOnly) warnings.push('Conditional if absent, not an absence prediction. Do not combine overlapping individual injury scenarios.');
    if (Date.parse(s.kickoff) <= now) warnings.push('Game has started; pregame estimate is archived.');
    const age = (now - Date.parse(m.updatedAt)) / 3600000;
    if (hasQuote && age > 6) warnings.push('Odds snapshot is over 6 hours old.');
    if ((now - Date.parse(s.injury.updatedAt)) / 3600000 > 24) warnings.push('Injury snapshot is over 24 hours old.');
    if (!hasQuote) warnings.push('No sourced sportsbook quote; betting probabilities and EV are unavailable.');
    if (s.allocationMode === 'learned') {
      warnings.push('Learned transfers are experimental; the 2024 yardage holdout did not establish an improvement over baseline.');
      if (!s.workloadCandidates) warnings.push('Allocation uses only listed players. Supply the complete eligible teammate pool for comparable historical features.');
      if (!['OUT', 'IR'].includes(s.injury.status)) warnings.push('Uncertain-availability scenarios are outside the evaluated confirmed-Out population.');
      if (s.injury.status === 'IR') warnings.push('Ongoing IR is outside the evaluated new-absence population.');
    }
    warnings.push('Injury adjustments and EV are unvalidated research estimates.');
    const bookOver = hasQuote ? impliedProbability(m.overOdds) : null, bookUnder = hasQuote ? impliedProbability(m.underOdds) : null;
    const variance = (1 - q) * (activeSD ** 2 + (activeMean - projection) ** 2) + q * (absentSD ** 2 + (absentMean - projection) ** 2);
    rows.push({ id: `${s.id}:${p.id}:${m.key}:${m.book}:${m.line}`, scenarioId: s.id, playerId: p.id, player: p.name, position: p.position,
      team: s.team, opponent: s.opponent, kickoff: s.kickoff, injury: s.injury, market: m.key, book: m.book ?? null, line: m.line ?? null,
      asOf: s.asOf ?? data.asOf, overOdds: m.overOdds ?? null, underOdds: m.underOdds ?? null, updatedAt: m.updatedAt ?? null, source: m.source ?? null, inputSource: m.inputSource ?? null,
      hasQuote, activeMean, absentMean, projection, delta: hasQuote ? projection - m.line : null, projectionGapPct: hasQuote && m.line ? (projection - m.line) / m.line * 100 : null,
      actual: m.actual ?? null, actualSource: m.actualSource ?? null, absoluteError: m.actual !== null && m.actual !== undefined ? Math.abs(m.actual - projection) : null,
      baselineOpportunities: m.opportunities, absentOpportunities: absentOpp, expectedOpportunities: m.opportunities + q * gained,
      absenceProbability: q, rate: m.rate, contextMultiplier: context, opponentMultiplier: factor,
      allocationMode: s.allocationMode, allocationShare: p.allocation?.[oppKey] ?? 0, injuryModelId: s.allocationMode === 'learned' ? options.injuryModel.modelId : null,
      impactEvidence: p.learnedImpact?.provenance?.[oppKey] ?? null, learnedContextMultiplier: p.learnedContext?.[m.key] ?? 1,
      overProbability, underProbability, pushProbability, researchOverEV, researchUnderEV, overEV, underEV, candidateEV,
      noVigOver: hasQuote ? bookOver / (bookOver + bookUnder) : null, preferredSide,
      signal: eligible ? candidateEV > 0 ? preferredSide : 'PASS' : !hasQuote ? 'NO_QUOTE' : archived ? 'ARCHIVED' : 'NOT_VALIDATED', eligible, modelStatus: approved ? 'approved' : 'not_validated',
      interval80: [m.key === 'receptions' ? Math.max(0, projection - 1.28155 * Math.sqrt(variance)) : projection - 1.28155 * Math.sqrt(variance), projection + 1.28155 * Math.sqrt(variance)],
      assumption: p.assumption, warnings, archived });
  }
  return rows.sort((a, b) => (b.candidateEV ?? -Infinity) - (a.candidateEV ?? -Infinity) || b.projection - a.projection);
}
