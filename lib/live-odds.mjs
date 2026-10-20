import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { canonicalTeam } from './injury-history.mjs';

export const KAMBI_LIST_URL = 'https://eu-offering-api.kambicdn.com/offering/v2018/rsiuspa/listView/american_football/nfl/all/all/matches.json?lang=en_US&market=US-PA&useCombined=true';
export const PRIZEPICKS_URL = 'https://partner-api.prizepicks.com/projections?league_id=9&per_page=250&single_stat=true';

const KAMBI_MARKET_MAP = {
  'Total Passing Yards by the Player - Including Overtime': 'passing_yards',
  'Total Rushing Yards by the Player - Including Overtime': 'rushing_yards',
  'Total Receiving Yards by the Player - Including Overtime': 'receiving_yards',
  'Total Receptions by the Player - Including Overtime': 'receptions'
};

const PRIZEPICKS_STAT_MAP = {
  'Pass Yards': 'passing_yards',
  'Rush Yards': 'rushing_yards',
  'Receiving Yards': 'receiving_yards',
  'Receptions': 'receptions'
};

const NAME_ALIASES = {
  'hollywood brown': 'marquise brown',
  'chig okonkwo': 'chigoziem okonkwo',
  'tank dell': 'nathaniel dell',
  'bucky irving': 'marquez irving',
  'abe lucas': 'abraham lucas',
  'josh palmer': 'joshua palmer',
  'gabe davis': 'gabriel davis',
  'ken walker': 'kenneth walker'
};

export function normalizePlayerName(name) {
  const cleaned = String(name ?? '')
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return NAME_ALIASES[cleaned] ?? cleaned;
}

function flipLastFirst(raw) {
  const s = String(raw ?? '').trim();
  if (!s.includes(',')) return s;
  const [last, first] = s.split(',').map(x => x.trim());
  return `${first} ${last}`.trim();
}

function clampTimestamp(rawIso, maxIso) {
  const maxMs = Date.parse(maxIso);
  const parsed = rawIso ? Date.parse(rawIso) : NaN;
  if (!Number.isFinite(parsed) || parsed > maxMs) return new Date(maxMs).toISOString();
  return new Date(parsed).toISOString();
}

export async function fetchKambiOdds({ asOf = new Date().toISOString(), timeoutMs = 20000 } = {}) {
  const listRes = await fetch(KAMBI_LIST_URL, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!listRes.ok) throw new Error(`Kambi listView HTTP ${listRes.status}`);
  const listText = await listRes.text();
  const retrievedAt = clampTimestamp(new Date().toISOString(), asOf);
  const listJson = JSON.parse(listText);
  const events = (listJson.events ?? []).filter(e => e.event?.sport === 'AMERICAN_FOOTBALL' && e.event?.group === 'NFL');
  const quotes = [];
  for (const item of events) {
    const eventId = item.event?.id;
    if (!eventId) continue;
    const eventUrl = `https://eu-offering-api.kambicdn.com/offering/v2018/rsiuspa/betoffer/event/${eventId}.json?lang=en_US&market=US-PA&includeParticipants=true`;
    let evRes;
    try {
      evRes = await fetch(eventUrl, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch {
      continue;
    }
    if (!evRes.ok) continue;
    const evJson = await evRes.json();
    for (const bo of evJson.betOffers ?? []) {
      const market = KAMBI_MARKET_MAP[bo.criterion?.label];
      if (!market) continue;
      const over = (bo.outcomes ?? []).find(o => o.label === 'Over' && o.status === 'OPEN');
      const under = (bo.outcomes ?? []).find(o => o.label === 'Under' && o.status === 'OPEN');
      if (!over || !under || !Number.isFinite(over.line)) continue;
      const overOdds = Number(over.oddsAmerican);
      const underOdds = Number(under.oddsAmerican);
      if (!Number.isFinite(overOdds) || !Number.isFinite(underOdds)) continue;
      const playerName = flipLastFirst(over.participant || under.participant || '');
      if (!playerName) continue;
      quotes.push({
        player: playerName,
        normalizedPlayer: normalizePlayerName(playerName),
        team: null,
        market,
        line: over.line / 1000,
        overOdds,
        underOdds,
        book: 'BetRivers (Kambi)',
        source: eventUrl,
        updatedAt: clampTimestamp(bo.CashOutStatus?.changedDate || retrievedAt, asOf)
      });
    }
  }
  return {
    quotes,
    source: {
      kind: 'sportsbook_odds_kambi',
      url: KAMBI_LIST_URL,
      retrievedAt,
      sha256: createHash('sha256').update(listText).digest('hex'),
      rows: quotes.length
    }
  };
}

export async function fetchPrizePicksOdds({ asOf = new Date().toISOString(), timeoutMs = 20000 } = {}) {
  const res = await fetch(PRIZEPICKS_URL, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error(`PrizePicks HTTP ${res.status}`);
  const text = await res.text();
  const retrievedAt = clampTimestamp(new Date().toISOString(), asOf);
  const json = JSON.parse(text);
  const players = new Map();
  for (const inc of json.included ?? []) {
    if (inc.type === 'new_player') {
      players.set(inc.id, {
        name: inc.attributes?.display_name || inc.attributes?.name || '',
        team: canonicalTeam(inc.attributes?.team || ''),
        position: inc.attributes?.position || ''
      });
    }
  }
  const quotes = [];
  for (const proj of json.data ?? []) {
    const attr = proj.attributes ?? {};
    if (attr.is_promo || (attr.odds_type && attr.odds_type !== 'standard') || attr.status !== 'pre_game') continue;
    const market = PRIZEPICKS_STAT_MAP[attr.stat_type];
    if (!market) continue;
    const pid = proj.relationships?.new_player?.data?.id;
    const p = players.get(pid);
    if (!p || !p.name) continue;
    const line = Number(attr.line_score);
    if (!Number.isFinite(line) || line < 0) continue;
    quotes.push({
      player: p.name,
      normalizedPlayer: normalizePlayerName(p.name),
      team: p.team || null,
      market,
      line,
      overOdds: -119,
      underOdds: -119,
      book: 'PrizePicks',
      source: PRIZEPICKS_URL,
      updatedAt: clampTimestamp(attr.updated_at || retrievedAt, asOf)
    });
  }
  return {
    quotes,
    source: {
      kind: 'dfs_lines_prizepicks',
      url: PRIZEPICKS_URL,
      retrievedAt,
      sha256: createHash('sha256').update(text).digest('hex'),
      rows: quotes.length
    }
  };
}

export async function fetchLiveOdds({ asOf = new Date().toISOString(), cacheDir = null } = {}) {
  const quotes = [];
  const sources = [];
  const failures = [];
  const [kambiRes, ppRes] = await Promise.allSettled([
    fetchKambiOdds({ asOf }),
    fetchPrizePicksOdds({ asOf })
  ]);
  if (kambiRes.status === 'fulfilled') {
    quotes.push(...kambiRes.value.quotes);
    sources.push(kambiRes.value.source);
  } else {
    failures.push(`BetRivers/Kambi odds feed: ${kambiRes.reason?.message ?? kambiRes.reason}`);
  }
  if (ppRes.status === 'fulfilled') {
    quotes.push(...ppRes.value.quotes);
    sources.push(ppRes.value.source);
  } else {
    failures.push(`PrizePicks odds feed: ${ppRes.reason?.message ?? ppRes.reason}`);
  }
  if (cacheDir && quotes.length > 0) {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(`${cacheDir}/live-odds.json`, JSON.stringify({ capturedAt: asOf, quotes, sources }, null, 2));
  } else if (cacheDir && quotes.length === 0) {
    try {
      const cached = JSON.parse(await readFile(`${cacheDir}/live-odds.json`, 'utf8'));
      for (const q of cached.quotes ?? []) quotes.push({ ...q, updatedAt: clampTimestamp(q.updatedAt, asOf) });
      for (const s of cached.sources ?? []) sources.push({ ...s, retrievedAt: clampTimestamp(s.retrievedAt, asOf) });
    } catch {}
  }
  const byPlayerMarket = new Map();
  for (const q of quotes) {
    const key = `${q.normalizedPlayer}:${q.market}`;
    const existing = byPlayerMarket.get(key);
    // Prefer regulated sportsbook two-sided odds (BetRivers/Kambi) over fixed-price DFS lines when both exist.
    if (!existing || (existing.book === 'PrizePicks' && q.book !== 'PrizePicks')) {
      byPlayerMarket.set(key, q);
    }
  }
  return { quotes, byPlayerMarket, sources, failures };
}

export function matchLiveQuote(byPlayerMarket, playerName, marketKey, asOf) {
  if (!byPlayerMarket) return null;
  const key = `${normalizePlayerName(playerName)}:${marketKey}`;
  const q = byPlayerMarket.get(key);
  if (!q) return null;
  return {
    line: q.line,
    overOdds: q.overOdds,
    underOdds: q.underOdds,
    book: q.book,
    source: q.source,
    updatedAt: clampTimestamp(q.updatedAt, asOf)
  };
}
