import {readFile,writeFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {parseCSV} from '../lib/csv.mjs';
import {normalizeStats} from '../lib/real-data.mjs';
import {canonicalTeam,kickoffUTC} from '../lib/injury-history.mjs';
import {forecastKey,snapshotChronologyValid} from '../lib/forward-validation.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),dir=path.join(root,'.cache/forward-ledger');
const snapshots=[],rejectedSnapshots=[];
for(const file of(await readdir(dir)).filter(f=>/^[a-f0-9]{64}\.json$/.test(f))){
  const text=await readFile(path.join(dir,file),'utf8');if(createHash('sha256').update(text).digest('hex')!==file.slice(0,-5))throw new Error(`Snapshot hash mismatch: ${file}.`);
  const snapshot=JSON.parse(text);
  if(!snapshotChronologyValid(snapshot)){rejectedSnapshots.push({file,reason:'Invalid issue/capture chronology or source retrieved after information cutoff.'});continue;}
  snapshots.push(snapshot);
}
snapshots.sort((a,b)=>Date.parse(a.asOf)-Date.parse(b.asOf));
const chosen=new Map();for(const snapshot of snapshots)for(const p of snapshot.predictions){const key=forecastKey(snapshot.modelId,p);if(!chosen.has(key)&&Date.parse(snapshot.issuedAt??snapshot.asOf)<Date.parse(p.kickoff))chosen.set(key,{...p,snapshotAt:snapshot.issuedAt??snapshot.asOf,modelId:snapshot.modelId});}
const status=JSON.parse(await readFile(path.join(root,'data/source-status.json'),'utf8'));
const fetchCSV=async kind=>{const source=status.sources.find(s=>s.kind===kind);const r=await fetch(source.url,{signal:AbortSignal.timeout(60000)});if(!r.ok)throw new Error(`${kind}: HTTP ${r.status}`);return parseCSV(await r.text());};
const [rawStats,games]=await Promise.all(['stats','games'].map(fetchCSV)),stats=normalizeStats(rawStats),now=Date.now(),graded=[];
for(const p of chosen.values()){
  const game=games.find(g=>g.game_type==='REG'&&kickoffUTC(g)===Date.parse(p.kickoff)&&[canonicalTeam(g.home_team),canonicalTeam(g.away_team)].includes(p.team));
  if(!game||game.home_score===''||game.away_score===''||kickoffUTC(game)+8*3600000>now)continue;
  const teamStats=stats.filter(r=>r.game_id===game.game_id&&r.recent_team===p.team);if(!teamStats.length)continue;
  const player=teamStats.find(r=>r.player_id===p.playerId),actual=player?.[p.market]??0;
  graded.push({...p,actual,zeroKind:player?'recorded':'no_recorded_production',baselineAbsoluteError:Math.abs(actual-p.activeMean),modelAbsoluteError:Math.abs(actual-p.projection)});
}
const byModel=Object.fromEntries([...new Set([...chosen.values()].map(p=>p.modelId))].map(id=>{const rows=graded.filter(p=>p.modelId===id),pending=[...chosen.values()].filter(p=>p.modelId===id).length;return [id,{predictions:pending,gradedRows:rows.length,baselineMAE:rows.length?rows.reduce((a,p)=>a+p.baselineAbsoluteError,0)/rows.length:null,modelMAE:rows.length?rows.reduce((a,p)=>a+p.modelAbsoluteError,0)/rows.length:null}];}));
const result={generatedAt:new Date().toISOString(),status:graded.length?'evaluated_research':'pending',selectionRule:'Earliest valid snapshot per player/market/game/model. Source files remain immutable and are hash-verified. Different models are reported separately.',byModel,snapshotCount:snapshots.length,rejectedSnapshots,predictions:chosen.size,gradedGames:new Set(graded.map(p=>p.kickoff+':'+p.team)).size,gradedRows:graded.length,pendingRows:chosen.size-graded.length,
  baselineMAE:graded.length?graded.reduce((a,p)=>a+p.baselineAbsoluteError,0)/graded.length:null,modelMAE:graded.length?graded.reduce((a,p)=>a+p.modelAbsoluteError,0)/graded.length:null,
  note:'Research results only. No betting ROI is calculated without verified prices and bookmaker-specific void rules.'};
await writeFile(path.join(root,'data/forward-status.json'),JSON.stringify(result,null,2)+'\n');
await writeFile(path.join(root,'reports/forward-predictions.json'),JSON.stringify({summary:result,rows:graded},null,2)+'\n');console.log(JSON.stringify(result,null,2));
