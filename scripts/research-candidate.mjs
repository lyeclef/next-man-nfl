import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {FEATURE_NAMES,impactFeatures,rankCandidates,predictTransfers} from '../lib/injury-impact.mjs';
const read=async file=>JSON.parse(await readFile(new URL('../'+file,import.meta.url),'utf8'));
const write=async(file,value)=>writeFile(new URL('../'+file,import.meta.url),JSON.stringify(value,null,2)+'\n');
const allowed={attempts:['QB'],carries:['QB','RB'],targets:['RB','WR','TE']};
const primary=(e,p,opp)=>p.position===e.injuryPosition&&rankCandidates(e.players,opp).get(p.id)===1;
const spec={version:1,lockedAt:new Date().toISOString(),name:'Role-balanced hierarchical transfer candidate',features:FEATURE_NAMES,
  fit:'Pooled opportunity transfer coefficients with injury-position deviations shrunk toward the pooled coefficients. Only opportunity-eligible positions receive transfers. Per-event and per-position weights prevent reserve-heavy charts dominating the fit.',
  selection:'Lambda [1,10,100], scale [0,0.25,0.5,1]. Select on earlier season primary same-position replacement workload MAE; at least five selection injury cases. No test outcomes in selection.',
  primaryCohort:'Exactly one same-position candidate per event and opportunity, selected by prior usage rank, then prior depth rank, then stable ID. Never selected by actual production.',
  limitation:'2022–2024 outcomes were examined during earlier development. All results here are retrospective development diagnostics, not a fresh untouched test. Candidate remains research only; no qualification policy is changed.'};
await mkdir(new URL('../.cache/candidate/',import.meta.url),{recursive:true});
await write('.cache/candidate/locked-protocol.json',spec);
function solve(a,b){const r=a.map((x,i)=>[...x,b[i]]),n=b.length;for(let i=0;i<n;i++){let p=i;for(let j=i+1;j<n;j++)if(Math.abs(r[j][i])>Math.abs(r[p][i]))p=j;[r[i],r[p]]=[r[p],r[i]];const d=r[i][i];if(Math.abs(d)<1e-12)throw new Error('Singular candidate fit.');for(let k=i;k<=n;k++)r[i][k]/=d;for(let j=0;j<n;j++)if(j!==i){const f=r[j][i];for(let k=i;k<=n;k++)r[j][k]-=f*r[i][k];}}return r.map(x=>x[n]);}
function fit(events,opp,lambda,prior=Array(FEATURE_NAMES.length).fill(0)){
  const n=FEATURE_NAMES.length,a=Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>i===j?lambda:0)),b=prior.map(x=>lambda*x);
  for(const e of events){const pool=e.players.filter(p=>allowed[opp].includes(p.position)),ranks=rankCandidates(e.players,opp),positions=new Set(pool.map(p=>p.position));
    for(const p of pool){const weight=1/(positions.size*pool.filter(t=>t.position===p.position).length),x=impactFeatures(p,opp,e.vacated[opp],ranks.get(p.id)),y=Math.max(-2,Math.min(2,(p.actual[opp]-p.baseline[opp])/e.vacated[opp]));
      for(let i=0;i<n;i++){b[i]+=weight*x[i]*y;for(let j=0;j<n;j++)a[i][j]+=weight*x[i]*x[j];}}
  }return solve(a,b);
}
function score(events,model,key){const [pos,opp]=key.split(':');let sum=0,n=0;for(const e of events.filter(e=>e.injuryPosition===pos&&e.vacated[opp]>=0.5)){const tr=predictTransfers(e,model);for(const p of e.players.filter(p=>primary(e,p,opp))){sum+=Math.abs(p.actual[opp]-p.baseline[opp]-e.vacated[opp]*tr.allocations[p.id][opp]);n++;}}return {mae:n?sum/n:Infinity,n};}
const folds=[],ledger=[];let finalModel;
for(const year of [2022,2023,2024]){
  const original=await read(`.cache/walk-forward/${year}/injury-model.json`),events=await read(`.cache/injury-history/events-${year}.json`),train=original.trainingSeasons.flatMap(y=>events[y]),select=events[original.selectionSeason],groups={};
  for(const pos of ['QB','RB','WR','TE'])for(const opp of ['carries','targets','attempts']){
    if(opp==='attempts'&&pos!=='QB')continue;
    const key=pos+':'+opp,selected=train.filter(e=>e.injuryPosition===pos&&e.vacated[opp]>=0.5);if(selected.length<12)continue;
    const pooled=fit(train.filter(e=>e.vacated[opp]>=0.5),opp,10);let best;
    for(const lambda of [1,10,100]){const coefficients=fit(selected,opp,lambda,pooled);for(const scale of [0,0.25,0.5,1]){
      const group={coefficients,lambda,scale,trainingEvents:selected.length,allowedPositions:allowed[opp]},s=score(select,{groups:{[key]:group}},key);
      if(s.n>=5&&(!best||s.mae<best.selectionMAE-1e-10))best={...group,selectionMAE:s.mae,selectionEvents:s.n};}}
    if(best)groups[key]=best;
  }
  const candidate={...original,groups,qbContext:{},modelType:spec.name,protocolSHA256:createHash('sha256').update(JSON.stringify(spec)).digest('hex'),generatedAt:new Date().toISOString()};
  candidate.modelId=createHash('sha256').update(JSON.stringify({groups,priors:candidate.baselineEfficiencyPriors,trainingSeasons:candidate.trainingSeasons,selectionSeason:candidate.selectionSeason,protocol:candidate.protocolSHA256})).digest('hex');
  await write(`.cache/candidate/model-${year}.json`,candidate);
  for(const e of events[year]){const old=predictTransfers(e,original).allocations,next=predictTransfers(e,candidate).allocations;
    for(const p of e.players)for(const [market,opp]of [['passing_yards','attempts'],['rushing_yards','carries'],['receiving_yards','targets'],['receptions','targets']]){
      if(market==='passing_yards'&&p.position!=='QB'||market==='rushing_yards'&&!['QB','RB'].includes(p.position)||['receiving_yards','receptions'].includes(market)&&p.position==='QB')continue;
      const context=e.injuryPosition==='QB'?original.qbContext[`${p.position}:${market}`]:null;
      ledger.push({season:year,gameId:e.gameId,eventId:e.id,injuryPosition:e.injuryPosition,playerId:p.id,position:p.position,market,primary:primary(e,p,opp),baseline:p.baseline[opp]*p.rates[market],previous:(p.baseline[opp]+e.vacated[opp]*old[p.id][opp])*p.rates[market]*(context?.enabled?context.multiplier:1),candidate:(p.baseline[opp]+e.vacated[opp]*next[p.id][opp])*p.rates[market],actual:p.actual[market]});
    }
  }
  folds.push({testSeason:year,trainingSeasons:original.trainingSeasons,selectionSeason:original.selectionSeason,cases:events[year].length,modelId:candidate.modelId});if(year===2024)finalModel=candidate;
}
function metrics(rows){return Object.fromEntries([...new Set(rows.map(r=>r.position+':'+r.market))].map(k=>{const rs=rows.filter(r=>r.position+':'+r.market===k),mae=name=>rs.reduce((a,r)=>a+Math.abs(r.actual-r[name]),0)/rs.length;return [k,{observations:rs.length,games:new Set(rs.map(r=>r.gameId)).size,baselineMAE:mae('baseline'),previousMAE:mae('previous'),candidateMAE:mae('candidate')}];}));}
const report={generatedAt:new Date().toISOString(),status:'development_only',protocol:spec,folds,allCandidates:metrics(ledger),primaryReplacements:metrics(ledger.filter(r=>r.primary)),ledgerSHA256:createHash('sha256').update(JSON.stringify(ledger)).digest('hex'),promoted:false,reason:'No untouched outcome test or priced probability validation. Original model retained as default; candidate is selectable for research and frozen prospectively separately.'};
await write('data/candidate-model.json',finalModel);await write('data/candidate-validation.json',report);await write('.cache/candidate/predictions.json',ledger);
await writeFile(new URL('../reports/candidate-evaluation.md',import.meta.url),`# Candidate model research\n\n${spec.limitation}\n\nPrimary replacement is fixed from pregame inputs. Zero outcomes remain included. No promotion or betting signal is authorized by these diagnostics.\n\n| Primary position / market | Rows | Baseline MAE | Previous model MAE | Candidate MAE |\n|---|---:|---:|---:|---:|\n${Object.entries(report.primaryReplacements).map(([k,v])=>`| ${k} | ${v.observations} | ${v.baselineMAE.toFixed(3)} | ${v.previousMAE.toFixed(3)} | ${v.candidateMAE.toFixed(3)} |`).join('\n')}\n`);
console.table(report.primaryReplacements);console.log('Candidate frozen; original default and betting gates retained.');
