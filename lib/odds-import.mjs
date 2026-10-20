// Import an offline The Odds API event-odds JSON export, without credentials.
// Mapping format: [{ scenarioId, eventId, description, playerId }]. No fuzzy matching.
export function mergeOddsExport(dataset, events, mapping) {
  const result = structuredClone(dataset);
  const allEvents = Array.isArray(events) ? events : [events];
  const keys = { player_pass_yds: 'passing_yards', player_rush_yds: 'rushing_yards', player_reception_yds: 'receiving_yards', player_receptions: 'receptions' };
  let merged = 0;
  const seen = new Set();
  for (const map of mapping) {
    const unique = `${map.scenarioId}:${map.playerId}:${map.eventId}`;
    if (seen.has(unique)) throw new Error('Duplicate odds mapping.'); seen.add(unique);
    const scenario = result.scenarios.find(s => s.id === map.scenarioId);
    const player = scenario?.players.find(p => p.id === map.playerId);
    const event = allEvents.find(e => e.id === map.eventId);
    if (!player || !event) throw new Error('Odds mapping does not resolve to an exact scenario/player/event.');
    if (Date.parse(event.commence_time) !== Date.parse(scenario.kickoff)) throw new Error('Mapped odds event kickoff does not match scenario kickoff.');
    for (const book of event.bookmakers ?? []) for (const market of book.markets ?? []) {
      const key = keys[market.key]; if (!key) continue;
      const baseline = player.markets.find(m => m.key === key); if (!baseline) continue;
      const outcomes = (market.outcomes ?? []).filter(o => o.description === map.description);
      for (const over of outcomes.filter(o => o.name === 'Over')) {
        const under = outcomes.find(o => o.name === 'Under' && o.point === over.point); if (!under) continue;
        const quote = { ...baseline, key, line: over.point, overOdds: over.price, underOdds: under.price, book: book.title,
          updatedAt: market.last_update ?? book.last_update,
          source: `The Odds API offline export; event ${event.id}; book ${book.key}` };
        player.markets = player.markets.filter(m => !(m.key === key && ((m.book == null && m.line == null) || (m.book === book.title && m.line === over.point))));
        player.markets.push(quote); merged++;
      }
    }
  }
  if (!merged) throw new Error('No paired supported props matched. Check exact player descriptions, markets, and American odds format.');
  // Preserve asOf so future data cannot silently enter an older pregame snapshot.
  return { dataset: result, merged };
}
