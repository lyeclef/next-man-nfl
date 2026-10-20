import {canonicalTeam,kickoffUTC} from './injury-history.mjs';
import {POSITIONS} from './model.mjs';
export const WATCH_URL='https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries';
const statuses={'Out':'OUT','Questionable':'QUESTIONABLE','Doubtful':'DOUBTFUL','Injured Reserve':'IR'};
// Identity is linked through provider IDs, never a fuzzy player-name match.
export function injuryWatch(feed,depth,games,{asOf,season}){
  if(feed.status!=='success'||Number(feed.season?.year)!==season||!Array.isArray(feed.injuries))throw new Error('Unexpected injury feed season or schema.');
  const cutoff=Date.parse(asOf);if(!Number.isFinite(Date.parse(feed.timestamp))||Date.parse(feed.timestamp)>cutoff)throw new Error('Injury feed timestamp is invalid or after capture.');
  const ids=new Map();for(const d of depth){if(!d.espn_id||!d.gsis_id||Date.parse(d.dt)>=cutoff)continue;const key=`${canonicalTeam(d.team)}:${d.espn_id}`,old=ids.get(key);if(!old||d.dt>old.dt)ids.set(key,d);}
  const records=[];
  for(const team of feed.injuries)for(const row of team.injuries??[]){
    const a=row.athlete,status=statuses[row.status];if(!status||!POSITIONS.includes(a?.position?.abbreviation))continue;
    const link=a.links?.find(l=>l.rel?.includes('playercard'))?.href;
    const espnId=link?.match(/\/id\/(\d+)/)?.[1],club=canonicalTeam(a.team?.abbreviation),identity=ids.get(`${club}:${espnId}`);
    const game=games.filter(g=>Number(g.season)===season&&g.game_type==='REG'&&[canonicalTeam(g.home_team),canonicalTeam(g.away_team)].includes(club)&&kickoffUTC(g)>cutoff).sort((a,b)=>kickoffUTC(a)-kickoffUTC(b))[0];
    const reported=Date.parse(row.date),fresh=Number.isFinite(reported)&&reported<=cutoff&&cutoff-reported<=28*86400000;
    records.push({id:`espn-${espnId??row.id}`,player:a.displayName,playerId:identity?.gsis_id??null,espnId,team:club,position:a.position.abbreviation,status,description:row.details?.type||'Not specified by source',comment:row.shortComment||row.longComment||'',updatedAt:Number.isFinite(reported)?new Date(reported).toISOString():null,capturedAt:asOf,source:link??WATCH_URL,feedSource:WATCH_URL,week:game?Number(game.week):null,kickoff:game?new Date(kickoffUTC(game)).toISOString():null,gameId:game?.game_id??null,fresh,identityMatched:!!identity,forecastScenarioId:null,exclusion:!identity?'No exact current-team player ID link':!fresh?'Listing older than 28 days or invalid timestamp':!game?'No upcoming regular-season game':'Pending workload check'});
  }
  return {asOf,source:WATCH_URL,sourceTimestamp:feed.timestamp,teamsObserved:feed.injuries.length,records,notes:'Provider injury listings are a watchlist, not final official game designations. An estimated return date is not a medical assessment. Conditional scenarios do not estimate the chance of absence.'};
}
