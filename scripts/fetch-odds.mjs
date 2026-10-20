import {writeFile,mkdir} from 'node:fs/promises';
import {fetchLiveOdds} from '../lib/live-odds.mjs';
// Fetches live public NFL player prop odds from BetRivers (Kambi CDN) and PrizePicks without an API key,
// or uses The Odds API if NFL_ODDS_API_KEY is set alongside --list / --event=<id>.
const key=process.env.NFL_ODDS_API_KEY,args=process.argv.slice(2),list=args.includes('--list'),eventArg=args.find(a=>a.startsWith('--event='));
try{
  const capturedAt=new Date().toISOString(),dir=new URL('../imports/',import.meta.url);await mkdir(dir,{recursive:true});
  if(!key||(!list&&!eventArg)){
    const live=await fetchLiveOdds({asOf:capturedAt});
    const filename=`odds-public-live-${capturedAt.replaceAll(':','-')}.json`;
    await writeFile(new URL(filename,dir),JSON.stringify({capturedAt,quotes:live.quotes,sources:live.sources,failures:live.failures},null,2)+'\n');
    console.log(JSON.stringify({file:'imports/'+filename,capturedAt,quotes:live.quotes.length,uniquePlayerMarkets:live.byPlayerMarket.size,sources:live.sources.map(s=>({kind:s.kind,rows:s.rows})),failures:live.failures},null,2));
  }else{
    const id=eventArg?.slice(8);
    if(!list&&(!id||!/^[a-zA-Z0-9_-]+$/.test(id)))throw new Error('Use --list to inspect NFL events, or --event=<exact provider event ID>. One event per command limits quota usage.');
    const endpoint=list?'events':`events/${id}/odds`,url=new URL(`https://api.the-odds-api.com/v4/sports/americanfootball_nfl/${endpoint}`);
    url.searchParams.set('apiKey',key);if(!list){url.searchParams.set('regions','us');url.searchParams.set('oddsFormat','american');url.searchParams.set('markets','player_pass_yds,player_rush_yds,player_reception_yds,player_receptions');}
    let response;try{response=await fetch(url,{signal:AbortSignal.timeout(30000)});}catch{throw new Error('Odds provider connection failed. Credential and request URL withheld.');}
    if(!response.ok)throw new Error(`Odds provider returned HTTP ${response.status}. Check account access and quota in your provider dashboard.`);
    const data=await response.json();
    const filename=`odds-${list?'events':id}-${capturedAt.replaceAll(':','-')}.json`;await writeFile(new URL(filename,dir),JSON.stringify(data,null,2)+'\n');
    console.log(JSON.stringify({file:'imports/'+filename,capturedAt,events:list?data.length:1,requestsRemaining:response.headers.get('x-requests-remaining')},null,2));
  }
}catch(error){console.error(error.message);process.exitCode=1;}

