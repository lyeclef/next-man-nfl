import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {parseCSV} from '../lib/csv.mjs';
import {normalizeStats,prepareCurrentCase,historicalSlate} from '../lib/real-data.mjs';
import {projectDataset,validateDataset,POSITIONS} from '../lib/model.mjs';
import {canonicalTeam,kickoffUTC} from '../lib/injury-history.mjs';
import {injuryWatch,WATCH_URL} from '../lib/injury-watch.mjs';
import {fetchLiveOdds} from '../lib/live-odds.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),cache=path.join(root,'.cache/real-data');await mkdir(cache,{recursive:true});
let asOf=new Date().toISOString();const season=2026;
const sourceURLs={stats:`https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_${season}.csv`,injuries:`https://github.com/nflverse/nflverse-data/releases/download/injuries/injuries_${season}.csv`,depth:`https://github.com/nflverse/nflverse-data/releases/download/depth_charts/depth_charts_${season}.csv`,games:'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv'};
const sources=[],raw={},failures=[];
for(const [kind,url] of Object.entries(sourceURLs)){
  const r=await fetch(url,{signal:AbortSignal.timeout(60000)});if(!r.ok)throw new Error(`${kind}: HTTP ${r.status}. Real-data refresh stopped; no substitute records created.`);
  const text=await r.text();await writeFile(path.join(cache,`${kind}_${season}.csv`),text);raw[kind]=parseCSV(text);sources.push({kind,url,retrievedAt:new Date().toISOString(),sha256:createHash('sha256').update(text).digest('hex'),rows:raw[kind].length});
}
const stats=normalizeStats(raw.stats),cases=JSON.parse(await readFile(path.join(root,'data/verified-injuries.json'),'utf8')),injuries=[];
for(const c of cases){
  try{
    const r=await fetch(c.source,{signal:AbortSignal.timeout(30000)});if(!r.ok)throw new Error(`HTTP ${r.status}`);const html=await r.text();
    const published=html.match(/"datePublished"\s*:\s*"([^"]+)"/)?.[1],modified=html.match(/"dateModified"\s*:\s*"([^"]+)"/)?.[1];
    if(published!==c.verifiedPublishedAt||modified!==c.verifiedModifiedAt||c.requiredText.some(t=>!html.includes(t)))throw new Error('Source changed; manual claim verification is required before reusing this case.');
    sources.push({kind:'team_announcement',url:c.source,publishedAt:published,modifiedAt:modified,retrievedAt:new Date().toISOString(),sha256:createHash('sha256').update(html).digest('hex')});
    injuries.push({...c,updatedAt:modified});
  }catch(error){failures.push(`${c.id}: ${error.message}`);}
}
let watchFeed=null;
try{const r=await fetch(WATCH_URL,{signal:AbortSignal.timeout(30000)});if(!r.ok)throw new Error(`HTTP ${r.status}`);const text=await r.text();watchFeed=JSON.parse(text);await writeFile(path.join(cache,'espn-injuries.json'),text);sources.push({kind:'injury_watchlist',url:WATCH_URL,retrievedAt:new Date().toISOString(),sha256:createHash('sha256').update(text).digest('hex')});}catch(e){failures.push(`ESPN watchlist unavailable: ${e.message}`);}
const liveOddsResult=await fetchLiveOdds({asOf:new Date().toISOString(),cacheDir:cache});
sources.push(...liveOddsResult.sources);failures.push(...liveOddsResult.failures);
asOf=new Date().toISOString(); // Information cutoff is after all inputs and live odds were observed.
let watch={asOf,teamsObserved:0,records:[],notes:'Watchlist unavailable. Confirmed source records remain separate.'};
if(watchFeed)try{watch=injuryWatch(watchFeed,raw.depth,raw.games,{asOf,season});}catch(e){failures.push(`ESPN watchlist rejected: ${e.message}`);}
for(const r of raw.injuries){
  if(!POSITIONS.includes(r.position)||!['Out','Doubtful'].includes(r.report_status)||!r.gsis_id||/not injury|personal|rest/i.test(r.report_primary_injury))continue;
  const upcoming=raw.games.find(g=>Number(g.season)===season&&g.game_type==='REG'&&Number(g.week)===Number(r.week)&&kickoffUTC(g)>Date.parse(asOf)&&[canonicalTeam(g.home_team),canonicalTeam(g.away_team)].includes(canonicalTeam(r.team)));
  if(!upcoming||injuries.some(c=>c.playerId===r.gsis_id))continue;
  injuries.push({id:`${season}-week${r.week}-${r.team}-${r.gsis_id}`,team:r.team,playerId:r.gsis_id,player:r.full_name,position:r.position,status:r.report_status.toUpperCase(),description:r.report_primary_injury,week:Number(r.week),source:sourceURLs.injuries,updatedAt:asOf,timestampKind:'capture',statusBasis:`Matched-week league ${r.report_status} report captured before kickoff`});
}
const model=JSON.parse(await readFile(path.join(root,'data/injury-model.json'),'utf8')),calibration=JSON.parse(await readFile(path.join(root,'data/calibration.json'),'utf8')),policy=JSON.parse(await readFile(path.join(root,'data/validation-policy.json'),'utf8'));
function hasMaterialRecentUsage(record,scenario){
  const opp={QB:'attempts',RB:'carries',WR:'targets',TE:'targets'}[record.position],minimum={QB:15,RB:5,WR:3,TE:2}[record.position];
  if(!scenario||scenario.injury.vacated[opp]<minimum*0.5)return {ok:false,reason:'Insufficient unabsorbed 4-game workload'};
  const recentWeeks=scenario.historyCutoff.weeks;
  const activeRows=stats.filter(r=>r.player_id===record.playerId&&r.recent_team===record.team&&recentWeeks.includes(Number(r.week))&&(r.attempts+r.carries+r.targets)>0);
  if(!activeRows.length)return {ok:false,reason:'No active usage in the last 4 team games'};
  const avgActive=activeRows.reduce((a,r)=>a+r[opp],0)/activeRows.length;
  if(avgActive<minimum&&scenario.injury.vacated[opp]<minimum)return {ok:false,reason:'Insufficient recent active workload for starter/rotational absence model'};
  return {ok:true,reason:null};
}
const scenarios=[];
for(const injury of injuries){
  try{
    const otherOutIds=watch.records.filter(r=>r.team===canonicalTeam(injury.team)&&['OUT','IR','DOUBTFUL'].includes(r.status)&&r.playerId!==injury.playerId).map(r=>r.playerId).filter(Boolean);
    const s=prepareCurrentCase({injury:{...injury,otherOutIds},games:raw.games,stats,depth:raw.depth,model,asOf,season,sourceURLs,liveOdds:liveOddsResult.byPlayerMarket});
    if(s)scenarios.push(s);
  }catch(error){failures.push(`${injury.id}: ${error.message}`);}
}
for(const record of watch.records){
  if(!record.identityMatched||!record.fresh||!record.kickoff)continue;
  if(scenarios.some(s=>s.injury.nflverseId===record.playerId)){record.forecastScenarioId=scenarios.find(s=>s.injury.nflverseId===record.playerId).id;record.exclusion='Included in active pregame slate';continue;}
  if(!['OUT','IR','DOUBTFUL'].includes(record.status))continue;
  try{
    const otherOutIds=watch.records.filter(r=>r.team===record.team&&r.playerId!==record.playerId&&['OUT','IR','DOUBTFUL'].includes(r.status)).map(r=>r.playerId).filter(Boolean);
    const injury={...record,id:`${season}-week${record.week}-${record.team}-${record.playerId}`,otherOutIds,statusBasis:`Auto-ingested ${record.status} listing (${record.comment||'ESPN/league injury feed'})`,expectedReturn:'Monitor weekly injury report'};
    const s=prepareCurrentCase({injury,games:raw.games,stats,depth:raw.depth,model,asOf,season,sourceURLs,liveOdds:liveOddsResult.byPlayerMarket});
    const check=hasMaterialRecentUsage(record,s);
    if(!check.ok){record.exclusion=check.reason;continue;}
    scenarios.push(s);record.forecastScenarioId=s.id;record.exclusion='Included in active pregame slate';
  }catch(error){record.exclusion=error.message;}
}
const conditionalScenarios=[];
for(const record of watch.records){
  if(!record.identityMatched||!record.fresh||!record.kickoff)continue;
  if(scenarios.some(s=>s.injury.nflverseId===record.playerId))continue;
  try{
    const otherOutIds=watch.records.filter(r=>r.team===record.team&&r.playerId!==record.playerId&&['OUT','IR','DOUBTFUL'].includes(r.status)).map(r=>r.playerId).filter(Boolean);
    const injury={...record,id:`what-if-${record.id}`,conditionalOnly:true,otherOutIds,statusBasis:'Conditional if absent. Questionable/watchlist listing; evaluated at 100% absence counterfactual.',expectedReturn:'Game-time decision / monitor official actives'};
    const s=prepareCurrentCase({injury,games:raw.games,stats,depth:raw.depth,model,asOf,season,sourceURLs,liveOdds:liveOddsResult.byPlayerMarket});
    const check=hasMaterialRecentUsage(record,s);
    if(!check.ok){record.exclusion=check.reason;continue;}
    conditionalScenarios.push(s);record.forecastScenarioId=s.id;record.exclusion=null;
  }catch(error){record.exclusion=error.message;}
}
const conditional={schemaVersion:1,name:`${season} conditional absence scenarios`,mode:'sourced',asOf,scenarios:conditionalScenarios,notes:'Each scenario independently asks what happens if this Questionable player is absent. Do not add overlapping scenarios together.'};
validateDataset(conditional);const conditionalPredictions=projectDataset(conditional,calibration,{injuryModel:model,validationPolicy:policy,now:asOf});
const current={schemaVersion:1,name:`${season} sourced pregame slate`,mode:'sourced',asOf,scenarios,notes:'Auto-ingested active OUT, IR, and DOUBTFUL injuries with material recent usage, paired with live BetRivers (Kambi) and PrizePicks player prop quotes.'};
validateDataset(current);const predictions=projectDataset(current,calibration,{injuryModel:model,validationPolicy:policy,now:asOf});
let archived;
try{
  const history=JSON.parse(await readFile(path.join(root,'.cache/injury-history/events.json'),'utf8'));
  archived=historicalSlate(history[model.holdoutSeason],model,asOf);
}catch{
  const prevArchived=JSON.parse(await readFile(path.join(root,'data/historical-slate.json'),'utf8'));
  archived={...prevArchived,asOf};
}
validateDataset(archived);projectDataset(archived,calibration,{injuryModel:model,validationPolicy:policy});
const status={asOf,season,currentCases:scenarios.length,currentProjections:predictions.length,quotes:predictions.filter(r=>r.hasQuote).length,conditionalQuotes:conditionalPredictions.filter(r=>r.hasQuote).length,
  latestStatsWeek:stats.reduce((a,r)=>Math.max(a,Number(r.week)||0),0),latestLeagueReportWeek:raw.injuries.reduce((a,r)=>Math.max(a,Number(r.week)||0),0),
  historicalScenarios:archived.scenarios.length,watchlistPlayers:watch.records.length,watchlistTeams:watch.teamsObserved,conditionalCases:conditionalScenarios.length,coverage:'Active pregame slate auto-ingests confirmed OUT, IR, and DOUBTFUL starter/rotational absences across all NFL teams, while Questionable designations populate the conditional what-if slate.',sources,failures,validationStatus:policy.status,oddsStatus:`Connected to live public BetRivers (Kambi CDN) and PrizePicks feeds (${liveOddsResult.quotes.length} live market quotes fetched; ${predictions.filter(r=>r.hasQuote).length} matched to active slate and ${conditionalPredictions.filter(r=>r.hasQuote).length} matched to conditional slate).`};
for(const [name,value]of Object.entries({'current-slate':current,'historical-slate':archived,'source-status':status,'injury-watchlist':watch,'conditional-slate':conditional}))await writeFile(path.join(root,`data/${name}.json`),JSON.stringify(value,null,2)+'\n');
await mkdir(path.join(root,'.cache/forward-ledger'),{recursive:true});
const snapshot={asOf,issuedAt:new Date().toISOString(),modelId:model.modelId,slate:current,predictions,sources,validationPolicy:policy};
const content=JSON.stringify(snapshot),snapshotHash=createHash('sha256').update(content).digest('hex');
await writeFile(path.join(root,`.cache/forward-ledger/${snapshotHash}.json`),content);
try{
  const candidate=JSON.parse(await readFile(path.join(root,'data/candidate-model.json'),'utf8')),slate=structuredClone(current);for(const s of slate.scenarios)s.injuryModelId=candidate.modelId;
  const candidateSnapshot={...snapshot,issuedAt:new Date().toISOString(),modelId:candidate.modelId,slate,predictions:projectDataset(slate,calibration,{injuryModel:candidate,validationPolicy:policy,now:asOf})};
  const candidateContent=JSON.stringify(candidateSnapshot),hash=createHash('sha256').update(candidateContent).digest('hex');await writeFile(path.join(root,`.cache/forward-ledger/${hash}.json`),candidateContent);
}catch(error){if(error.code!=='ENOENT')throw error;}
await writeFile(path.join(root,'data/forward-status.json'),JSON.stringify({generatedAt:asOf,status:'active',snapshotSHA256:snapshotHash,cases:scenarios.length,predictions:predictions.length,quotedPredictions:predictions.filter(r=>r.hasQuote).length,actionableSignals:predictions.filter(r=>r.signal==='OVER'||r.signal==='UNDER').length,gradedGames:0,note:'Timestamped pregame predictions and live sportsbook quotes are frozen locally in the forward ledger.'},null,2)+'\n');
console.log(JSON.stringify({currentCases:scenarios.length,conditionalCases:conditionalScenarios.length,projections:predictions.length,quotes:status.quotes,conditionalQuotes:status.conditionalQuotes,actionableSignals:predictions.filter(r=>r.signal==='OVER'||r.signal==='UNDER').length,historicalCases:archived.scenarios.length,latestLeagueReportWeek:status.latestLeagueReportWeek,failures,snapshotSHA256:snapshotHash},null,2));

