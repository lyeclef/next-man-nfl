// Learned conditional workload redistribution. No medical or absence prediction.
export const IMPACT_VERSION = 1;
export const FEATURE_NAMES = ['intercept', ...['QB', 'RB', 'WR', 'TE'].flatMap(p => [1, 2, 3].map(r => `${p}:role${r}`)), 'baseline/vacated', 'trend/vacated'];
const clip = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export function impactFeatures(player, opportunity, vacated, role) {
  const baseline = player.baseline?.[opportunity] ?? 0;
  return [1, ...['QB', 'RB', 'WR', 'TE'].flatMap(p => [1, 2, 3].map(r => Number(player.position === p && role === r))),
    clip(baseline / Math.max(1, vacated), 0, 2), clip(((player.last?.[opportunity] ?? baseline) - baseline) / Math.max(1, vacated), -2, 2)];
}
export function rankCandidates(players, opportunity) {
  const result = new Map();
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    const sorted = players.filter(p => p.position === pos).slice().sort((a, b) => {
      const usage = (b.baseline?.[opportunity] ?? 0) - (a.baseline?.[opportunity] ?? 0);
      // For unused quarterbacks, a pre-existing depth order disambiguates backups.
      return usage || (a.depthRank ?? 99) - (b.depthRank ?? 99) || a.id.localeCompare(b.id);
    });
    sorted.forEach((p, i) => result.set(p.id, i + 1));
  }
  return result;
}
export function predictTransfers(event, model, options = {}) {
  const allocations = Object.fromEntries(event.players.map(p => [p.id, { carries: 0, targets: 0, attempts: 0 }]));
  const provenance = {};
  for (const opportunity of ['carries', 'targets', 'attempts']) {
    const vacated = event.vacated[opportunity] ?? 0;
    const key = `${event.injuryPosition}:${opportunity}`, group = model.groups[key];
    const scale = options.scales?.[key] ?? group?.scale ?? 0;
    if (!group || vacated < 0.5 || scale === 0) { provenance[opportunity] = { group: key, scale: 0, reason: !group ? 'Insufficient training support' : vacated < 0.5 ? 'No material vacated workload' : 'Model selection retained baseline', trainingEvents: group?.trainingEvents ?? 0 }; continue; }
    const roles = rankCandidates(event.players, opportunity);
    let sum = 0;
    for (const player of event.players) {
      if (opportunity === 'attempts' && player.position !== 'QB') continue;
      if (group.allowedPositions && !group.allowedPositions.includes(player.position)) continue;
      const features = impactFeatures(player, opportunity, vacated, roles.get(player.id));
      const raw = features.reduce((a, x, i) => a + x * group.coefficients[i], 0);
      const share = clip(raw * scale, 0, 1);
      allocations[player.id][opportunity] = share; sum += share;
    }
    if (sum > 1) for (const player of event.players) allocations[player.id][opportunity] /= sum;
    provenance[opportunity] = { group: key, scale, trainingEvents: group.trainingEvents, totalAllocated: Math.min(1, sum) };
  }
  return { allocations, provenance };
}
export function applyLearnedImpact(scenario, model) {
  if (model?.version !== IMPACT_VERSION || !model.groups) throw new Error('A compatible fitted injury-impact artifact is required for learned allocations.');
  const players = scenario.players.map(p => {
    const baseline = {}, last = {};
    for (const m of p.markets) {
      const opportunity = m.key === 'passing_yards' ? 'attempts' : m.key === 'rushing_yards' ? 'carries' : 'targets';
      if (baseline[opportunity] !== undefined && Math.abs(baseline[opportunity] - m.opportunities) > 0.000001) throw new Error(`${p.name}: markets sharing ${opportunity} must have the same baseline opportunities.`);
      baseline[opportunity] = m.opportunities;
      last[opportunity] = p.lastOpportunities?.[opportunity] ?? m.opportunities;
    }
    return { id: p.id, position: p.position, depthRank: p.depthRank, baseline, last };
  });
  const candidates = scenario.workloadCandidates ? structuredClone(scenario.workloadCandidates) : players;
  if (scenario.workloadCandidates) for (const p of players) {
    const candidate = candidates.find(c => c.id === p.id);
    if (!candidate || candidate.position !== p.position) throw new Error(`${p.id}: quoted player is missing or mismatched in workloadCandidates.`);
    for (const [key, value] of Object.entries(p.baseline)) if (Math.abs((candidate.baseline?.[key] ?? 0) - value) > 0.000001) throw new Error(`${p.id}: quoted opportunities differ from workloadCandidates.`);
  }
  const event = { injuryPosition: scenario.injury.position, vacated: scenario.injury.vacated, players: candidates };
  const predicted = predictTransfers(event, model);
  const rolesByOpp = Object.fromEntries(['carries', 'targets', 'attempts'].map(opp => [opp, rankCandidates(candidates, opp)]));
  const copy = structuredClone(scenario);
  copy.context = {}; // Learned mode replaces manual injury efficiency assumptions.
  for (const p of copy.players) {
    p.allocation = predicted.allocations[p.id];
    p.learnedImpact = { modelVersion: model.version, trainedThrough: model.trainedThrough, provenance: predicted.provenance };
    p.learnedContext = {};
    for (const m of p.markets) {
      const opp = m.key === 'passing_yards' ? 'attempts' : m.key === 'rushing_yards' ? 'carries' : 'targets';
      const role = rolesByOpp[opp].get(p.id) ?? 99;
      const share = p.allocation?.[opp] ?? 0;
      const rb = share > 0 ? 'r1' : role === 1 ? 'r1' : role === 2 ? 'r2' : 'r3+';
      const lastTotal = p.lastOpportunities
        ? (p.lastOpportunities.carries ?? 0) + (p.lastOpportunities.targets ?? 0) + (p.lastOpportunities.attempts ?? 0)
        : m.opportunities;
      const lz = lastTotal === 0 && share === 0;
      const effMult = model.efficiencyContext?.[`${p.position}:${m.key}:${rb}:${lz ? 'lz1' : 'lz0'}`] ?? 1;
      const qbEffect = scenario.injury.position === 'QB' ? model.qbContext?.[`${p.position}:${m.key}`] : null;
      const combined = effMult * (qbEffect?.enabled ? qbEffect.multiplier : 1);
      if (Math.abs(combined - 1) > 1e-7) p.learnedContext[m.key] = combined;
    }
    p.assumption = `Learned historical allocation (${model.trainingSeasons.join(', ')} fit; ${model.selectionSeason} model selection). ` +
      (Object.entries(p.allocation).filter(([, share]) => share > 0).map(([k, share]) => `${(share * 100).toFixed(1)}% of vacated ${k}`).join('; ') || 'No workload transfer selected; baseline retained') +
      '. Conditional on absence; not a causal guarantee. Injury efficiency effects come from the fitted model; matchup multipliers remain supplied inputs.';
  }
  return copy;
}
