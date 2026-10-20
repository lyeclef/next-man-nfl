// Build historically comparable model inputs from explicitly supplied offline CSVs.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseCSV } from '../lib/csv.mjs';
import { canonicalTeam, kickoffUTC } from '../lib/injury-history.mjs';
import { validateDataset, projectDataset, MARKETS, POSITIONS } from '../lib/model.mjs';
try {
  const [slatePath, statsPath, depthPath, gamesPath, output] = process.argv.slice(2);
  if (!output) throw new Error('Usage: node scripts/prepare-injury-slate.mjs <slate.json> <player-stats.csv> <weekly-depth.csv> <games.csv> <output.json>');
  const data = JSON.parse(await readFile(slatePath,'utf8')); validateDataset(data);
  const [statRows, depth, games] = await Promise.all([statsPath,depthPath,gamesPath].map(async p=>parseCSV(await readFile(p,'utf8'))));
  const model = JSON.parse(await readFile(fileURLToPath(new URL('../data/injury-model.json',import.meta.url)),'utf8'));
  const calibration = JSON.parse(await readFile(fileURLToPath(new URL('../data/calibration.json',import.meta.url)),'utf8'));
  if (!Object.hasOwn(depth[0] ?? {},'week') || !Object.hasOwn(depth[0] ?? {},'depth_team')) throw new Error('This preparer requires week-based depth CSVs with week/depth_team/gsis_id. Map newer timestamped provider snapshots to workloadCandidates explicitly.');
  const warnings=[];
  for (const s of data.scenarios) {
    if (!s.injury.nflverseId) throw new Error(`${s.id}: injury.nflverseId is required. No identity is guessed from a name.`);
    if (s.players.some(p=>!p.nflverseId)) throw new Error(`${s.id}: every affected player needs an exact nflverseId.`);
    const team=canonicalTeam(s.team), asOf=Date.parse(data.asOf);
    const prior=games.filter(g=>g.game_type==='REG' && [canonicalTeam(g.home_team),canonicalTeam(g.away_team)].includes(team) && Number.isFinite(kickoffUTC(g)) && kickoffUTC(g)+8*3600000<asOf && g.home_score!=='' && g.away_score!=='')
      .sort((a,b)=>kickoffUTC(a)-kickoffUTC(b));
    const last=prior.at(-1); if(!last)throw new Error(`${s.id}: no completed prior team games.`);
    const season=Number(last.season), recent=prior.filter(g=>Number(g.season)===season).slice(-4);
    if(recent.length<3)throw new Error(`${s.id}: at least three prior team games in the same season are required.`);
    const selected=statRows.filter(r=>r.season_type==='REG' && Number(r.season)===season && canonicalTeam(r.recent_team ?? r.team)===team);
    const byWeek=recent.map(g=>selected.filter(r=>Number(r.week)===Number(g.week)));
    if(byWeek.some(rows=>!rows.length))throw new Error(`${s.id}: missing stats for a complete prior team game.`);
    const history=id=>byWeek.map(rows=>rows.find(r=>r.player_id===id)??{});
    const weights=recent.map((_,i)=>0.7**(recent.length-i-1)), sum=weights.reduce((a,x)=>a+x,0);
    const baseline=id=>Object.fromEntries(['carries','targets','attempts'].map(k=>[k,history(id).reduce((a,r,i)=>a+Number(r[k]??0)*weights[i],0)/sum]));
    const unavailable=new Set([s.injury.nflverseId,...(s.otherUnavailableNflverseIds??[])]);
    const chart=depth.filter(r=>Number(r.season)===season && Number(r.week)===Number(last.week) && r.game_type==='REG' && r.formation==='Offense' && canonicalTeam(r.club_code)===team && POSITIONS.includes(r.position) && r.gsis_id && !unavailable.has(r.gsis_id));
    if(!chart.length)throw new Error(`${s.id}: prior-game depth chart is missing.`);
    const pool=new Map();
    for(const c of chart){const old=pool.get(c.gsis_id);if(!old || Number(c.depth_team)<old.depthRank)pool.set(c.gsis_id,{id:c.gsis_id,name:c.full_name,position:c.position,depthRank:Number(c.depth_team),baseline:baseline(c.gsis_id),last:Object.fromEntries(['carries','targets','attempts'].map(k=>[k,Number(history(c.gsis_id).at(-1)[k]??0)]))});}
    s.injury.vacated=baseline(s.injury.nflverseId);
    for(const p of s.players){
      const candidate=pool.get(p.nflverseId); if(!candidate || candidate.position!==p.position)throw new Error(`${p.name}: no matching eligible prior-depth candidate. Review the exact ID and team.`);
      p.id=p.nflverseId;p.depthRank=candidate.depthRank;p.lastOpportunities=candidate.last;
      for(const m of p.markets){const spec=MARKETS[m.key], rows=history(p.nflverseId), prior=model.baselineEfficiencyPriors[`${p.position}:${m.key}`];
        const opp=rows.reduce((a,r)=>a+Number(r[spec.opportunity]??0),0), stat=rows.reduce((a,r)=>a+Number(r[spec.stat]??0),0);
        m.opportunities=candidate.baseline[spec.opportunity];m.rate=Math.max(0,(stat+prior.strength*prior.rate)/(opp+prior.strength));
        if(m.key==='receptions')m.rate=Math.min(1,m.rate);
      }
      p.historicalPlayerName=candidate.name;
    }
    s.workloadCandidates=[...pool.values()];s.allocationMode='learned';s.injuryModelId=model.modelId;
    s.historyCutoff={season,weeks:recent.map(g=>Number(g.week)),depthWeek:Number(last.week),asOf:data.asOf,source:'Caller-supplied nflverse weekly CSVs'};
    warnings.push(`${s.id}: verify player names/IDs and otherUnavailableNflverseIds. Final stat corrections and week-based depth archives are not guaranteed publication-time snapshots.`);
  }
  projectDataset(data,calibration,{injuryModel:model});
  await writeFile(output,JSON.stringify(data,null,2)+'\n');console.log(`Prepared ${data.scenarios.length} learned injury scenarios.\n${warnings.join('\n')}`);
}catch(error){console.error(error.message);process.exitCode=1;}
