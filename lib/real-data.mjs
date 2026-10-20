import {canonicalTeam,kickoffUTC} from './injury-history.mjs';
import {MARKETS,POSITIONS} from './model.mjs';
import {matchLiveQuote} from './live-odds.mjs';
import {predictTransfers} from './injury-impact.mjs';
const numericKeys=['carries','targets','attempts','passing_yards','rushing_yards','receiving_yards','receptions'];
export function normalizeStats(rows){return rows.filter(r=>r.player_id&&POSITIONS.includes(r.position)&&r.season_type==='REG').map(r=>{
  const out={...r,recent_team:canonicalTeam(r.recent_team??r.team)};
  for(const k of numericKeys){const value=Number(r[k]);if(!Number.isFinite(value))throw new Error(`Invalid ${k} for ${r.player_id}.`);out[k]=value;}return out;
});}
export function latestDepth(rows,team,before){
  const selected=rows.filter(r=>canonicalTeam(r.team)===canonicalTeam(team)&&r.gsis_id&&POSITIONS.includes(r.pos_abb)&&Date.parse(r.dt)<Date.parse(before));
  const dt=selected.reduce((a,r)=>r.dt>a?r.dt:a,'');if(!dt)throw new Error(`${team}: no eligible timestamped depth snapshot before cutoff.`);
  const pool=new Map();for(const r of selected.filter(r=>r.dt===dt)){const rank=Number(r.pos_rank),old=pool.get(r.gsis_id);if(!Number.isInteger(rank)||rank<1||rank>10)continue;if(!old||rank<old.depthRank)pool.set(r.gsis_id,{id:r.gsis_id,name:r.player_name,position:r.pos_abb,depthRank:rank});}
  return {at:dt,players:[...pool.values()]};
}
function computeOpponentMultipliers({games,stats,opponent,season,now}){
  const completed=games.filter(g=>Number(g.season)===season&&g.game_type==='REG'&&kickoffUTC(g)+8*3600000<now&&g.home_score!==''&&g.away_score!=='');
  const defByWeekOff=new Map();
  for(const g of completed){
    const w=Number(g.week),h=canonicalTeam(g.home_team),a=canonicalTeam(g.away_team);
    defByWeekOff.set(`${w}:${h}`,a);defByWeekOff.set(`${w}:${a}`,h);
  }
  const leagueOpp={passing_yards:0,rushing_yards:0,receiving_yards:0,receptions:0},leagueStat={passing_yards:0,rushing_yards:0,receiving_yards:0,receptions:0};
  const oppDefOpp={passing_yards:0,rushing_yards:0,receiving_yards:0,receptions:0},oppDefStat={passing_yards:0,rushing_yards:0,receiving_yards:0,receptions:0};
  for(const r of stats){
    if(Number(r.season)!==season)continue;
    const defTeam=defByWeekOff.get(`${Number(r.week)}:${r.recent_team}`);
    if(!defTeam)continue;
    for(const [key,spec] of Object.entries(MARKETS)){
      if(!spec.positions.includes(r.position)||key==='rushing_yards'&&!['QB','RB'].includes(r.position))continue;
      const o=Number(r[spec.opportunity]??0),s=Number(r[spec.stat]??0);
      leagueOpp[key]+=o;leagueStat[key]+=s;
      if(defTeam===opponent){oppDefOpp[key]+=o;oppDefStat[key]+=s;}
    }
  }
  const out={};
  for(const [key,spec] of Object.entries(MARKETS)){
    if(leagueOpp[key]<=0||leagueStat[key]<=0||oppDefOpp[key]<=0){out[key]=1;continue;}
    const leagueRate=leagueStat[key]/leagueOpp[key];
    const priorK=spec.opportunity==='carries'?75:90;
    const shrunkRate=(oppDefStat[key]+priorK*leagueRate)/(oppDefOpp[key]+priorK);
    const mult=Math.min(1.18,Math.max(0.85,shrunkRate/leagueRate));
    out[key]=Math.round(mult*10000)/10000;
  }
  return out;
}
export function prepareCurrentCase({injury,games,stats,depth,model,asOf,season,sourceURLs,liveOdds=null}){
  const team=canonicalTeam(injury.team),now=Date.parse(asOf);
  const teamGames=games.filter(g=>Number(g.season)===season&&g.game_type==='REG'&&[canonicalTeam(g.home_team),canonicalTeam(g.away_team)].includes(team)).sort((a,b)=>kickoffUTC(a)-kickoffUTC(b));
  const upcoming=teamGames.find(g=>kickoffUTC(g)>now);if(!upcoming)return null;
  if(injury.week&&Number(injury.week)!==Number(upcoming.week))return null;
  const prior=teamGames.filter(g=>kickoffUTC(g)+8*3600000<now&&g.home_score!==''&&g.away_score!=='').slice(-4);if(prior.length<3)throw new Error(`${team}: fewer than three completed prior team games.`);
  const byWeek=prior.map(g=>stats.filter(r=>Number(r.season)===season&&r.recent_team===team&&Number(r.week)===Number(g.week)));
  if(byWeek.some(rows=>!rows.length))throw new Error(`${team}: missing complete-team historical stats.`);
  const weights=prior.map((_,i)=>0.7**(prior.length-1-i)),sum=weights.reduce((a,x)=>a+x,0),history=id=>byWeek.map(rows=>rows.find(r=>r.player_id===id)??{});
  const baseline=id=>Object.fromEntries(['carries','targets','attempts'].map(k=>[k,history(id).reduce((a,r,i)=>a+Number(r[k]??0)*weights[i],0)/sum]));
  const injuryActiveLast=Boolean(history(injury.playerId).at(-1)?.player_id);
  const candidateBaseline=(id,pos)=>{
    if(!injuryActiveLast&&pos===injury.position)return baseline(id);
    const h=history(id);
    if(!h.at(-1)?.player_id)return baseline(id);
    const activeWeightSum=h.reduce((a,r,i)=>a+(r.player_id?weights[i]:0),0);
    if(activeWeightSum<=0)return baseline(id);
    return Object.fromEntries(['carries','targets','attempts'].map(k=>[k,h.reduce((a,r,i)=>a+(r.player_id?Number(r[k]??0)*weights[i]:0),0)/activeWeightSum]));
  };
  const chart=latestDepth(depth,team,new Date(kickoffUTC(prior.at(-1))).toISOString());
  const candidates=chart.players.filter(p=>p.id!==injury.playerId&&!injury.otherOutIds?.includes(p.id)).map(p=>({...p,baseline:candidateBaseline(p.id,p.position),last:Object.fromEntries(['carries','targets','attempts'].map(k=>[k,Number(history(p.id).at(-1)[k]??0)]))}));
  const opponent=canonicalTeam(canonicalTeam(upcoming.home_team)===team?upcoming.away_team:upcoming.home_team);
  const oppMultipliers=computeOpponentMultipliers({games,stats,opponent,season,now});
  const vacated=baseline(injury.playerId);
  const transfers=predictTransfers({injuryPosition:injury.position,vacated,players:candidates},model);
  const players=[];
  for(const c of candidates){
    const rows=history(c.id),markets=[];
    for(const [key,spec] of Object.entries(MARKETS)){
      if(!spec.positions.includes(c.position)||key==='rushing_yards'&&!['QB','RB'].includes(c.position))continue;
      const opp=c.baseline[spec.opportunity];
      const share=transfers.allocations[c.id]?.[spec.opportunity]??0;
      const isImpacted=share>0||(injury.position==='QB'&&['receiving_yards','receptions'].includes(key));
      const quote=isImpacted?matchLiveQuote(liveOdds,c.name,key,asOf):null;
      if(opp<0.5&&!(c.position===injury.position&&c.depthRank<=3)&&!quote)continue;
      const priorRate=model.baselineEfficiencyPriors[`${c.position}:${key}`];
      const totalOpp=rows.reduce((a,r)=>a+Number(r[spec.opportunity]??0),0),totalStat=rows.reduce((a,r)=>a+Number(r[spec.stat]??0),0);
      const rawRate=Math.max(0,(totalStat+priorRate.strength*priorRate.rate)/(totalOpp+priorRate.strength));
      const rate=key==='receptions'?Math.min(1,rawRate):rawRate;
      const rawOppMult=oppMultipliers[key]??1;
      const opponentMultiplier=key==='receptions'&&rate>0?Math.min(rawOppMult,Math.floor(0.995/rate*10000)/10000):rawOppMult;
      markets.push({key,opportunities:opp,rate,line:quote?.line??null,overOdds:quote?.overOdds??null,underOdds:quote?.underOdds??null,book:quote?.book??null,source:quote?.source??null,updatedAt:quote?.updatedAt??null,inputSource:sourceURLs.stats,opponentMultiplier});
    }
    if(markets.length)players.push({id:c.id,nflverseId:c.id,name:c.name,position:c.position,depthRank:c.depthRank,lastOpportunities:c.last,allocation:{},assumption:'Inputs derived from prior team-game usage, opponent defensive efficiency, and frozen training priors; allocation fitted on historical absences.',markets});
  }
  players.sort((a,b)=>Number(b.markets.some(m=>m.line!==null))-Number(a.markets.some(m=>m.line!==null))||Number(b.position===injury.position)-Number(a.position===injury.position)||a.depthRank-b.depthRank);
  if(!players.length)throw new Error(`${team}: no traceable eligible projection inputs.`);
  const defaultProb=injury.conditionalOnly?1:injury.status==='DOUBTFUL'?0.85:1;
  return {id:injury.id,asOf,team,opponent,kickoff:new Date(kickoffUTC(upcoming)).toISOString(),gameId:upcoming.game_id,season,week:Number(upcoming.week),allocationMode:'learned',injuryModelId:model.modelId,
    injury:{player:injury.player,nflverseId:injury.playerId,position:injury.position,status:injury.status,description:injury.description,absenceProbability:injury.absenceProbability??defaultProb,conditionalOnly:injury.conditionalOnly===true,vacated,expectedReturn:injury.expectedReturn??'Not reported',source:injury.source,updatedAt:injury.updatedAt,statusBasis:injury.statusBasis??'Current league report',timestampKind:injury.timestampKind??'publication'},
    historyCutoff:{weeks:prior.map(g=>Number(g.week)),depthAt:chart.at,source:sourceURLs.stats},workloadCandidates:candidates,players};
}
export function historicalSlate(events,model,generatedAt){
  const scenarios=events.map(e=>({id:e.id,gameId:e.gameId,asOf:e.injuryUpdatedAt,team:e.team,opponent:e.opponent,kickoff:e.kickoff,season:e.season,week:e.week,allocationMode:'learned',injuryModelId:model.modelId,
    injury:{player:e.injuryPlayer,nflverseId:e.injuryId,position:e.injuryPosition,status:'OUT',description:e.injuryDescription||'Not specified in archived report',absenceProbability:1,vacated:e.vacated,expectedReturn:'Not reported in archive',source:`https://github.com/nflverse/nflverse-data/releases/download/injuries/injuries_${e.season}.csv`,updatedAt:e.injuryUpdatedAt,statusBasis:'Archived pregame Out report'},
    historyCutoff:{weeks:e.historyWeeks,depthWeek:e.depthWeek},workloadCandidates:e.players.map(p=>({id:p.id,position:p.position,depthRank:p.depthRank,baseline:Object.fromEntries(['carries','targets','attempts'].map(k=>[k,p.baseline[k]])),last:p.last})),
    players:e.players.map(p=>({id:p.id,name:p.name,position:p.position,depthRank:p.depthRank,lastOpportunities:p.last,allocation:{},assumption:'Pre-game inputs reconstructed using strictly prior weeks. Archived stats may include later corrections.',markets:Object.entries(MARKETS).filter(([key,spec])=>spec.positions.includes(p.position)&&(key!=='rushing_yards'||['QB','RB'].includes(p.position))).map(([key,spec])=>({key,opportunities:p.baseline[spec.opportunity],rate:p.rates[key],line:null,book:null,overOdds:null,underOdds:null,source:null,updatedAt:null,inputSource:`https://github.com/nflverse/nflverse-data/releases/download/player_stats/player_stats_${e.season}.csv`,actual:p.actual[key],actualSource:`https://github.com/nflverse/nflverse-data/releases/download/player_stats/player_stats_${e.season}.csv`}))}))}));
  return {schemaVersion:1,name:`${model.holdoutSeason} historical injury holdout`,mode:'historical',asOf:generatedAt,scenarios,notes:'Real archived injuries, player usage and outcomes. No sportsbook quotes are supplied. Historical reconstruction has publication-time limitations.'};
}
