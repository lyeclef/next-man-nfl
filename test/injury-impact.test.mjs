import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { projectDataset } from '../lib/model.mjs';
import { predictTransfers, impactFeatures, rankCandidates, FEATURE_NAMES } from '../lib/injury-impact.mjs';
import { buildInjuryEvents, fitEfficiencyPriors, kickoffUTC } from '../lib/injury-history.mjs';
const load = async name => JSON.parse(await readFile(new URL(name === 'demo' ? './fixtures/synthetic-slate.json' : `../data/${name}.json`, import.meta.url), 'utf8'));
const [demo, calibration, model] = await Promise.all(['demo','calibration','injury-model'].map(load));
const near = (a,b) => assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);
test('Learned mode uses fitted coefficients for all four positions and preserves conservation', () => {
  const rows = projectDataset(demo, calibration, { impactMode: 'learned', injuryModel: model, now: demo.asOf });
  assert.deepEqual([...new Set(rows.map(r=>r.position))].sort(), ['QB','RB','TE','WR']);
  for (const r of rows) { assert.equal(r.allocationMode,'learned'); assert.equal(r.injuryModelId,model.modelId); assert.equal(r.eligible,false); assert.ok(r.impactEvidence); }
  for (const s of demo.scenarios) for (const opportunity of ['carries','targets','attempts']) {
    const seen = new Set(); let sum=0;
    for(const r of rows.filter(r=>r.scenarioId===s.id)) {
      const key=r.market==='passing_yards'?'attempts':r.market==='rushing_yards'?'carries':'targets';
      if(key!==opportunity || seen.has(r.playerId))continue; seen.add(r.playerId);sum+=r.allocationShare;
    }
    assert.ok(sum<=1.0000001);
  }
});
test('Validation-selected zero effects fall back to baseline without inventing a lift', () => {
  const event={injuryPosition:'WR',vacated:{targets:10},players:[{id:'p',position:'WR',baseline:{targets:4},last:{targets:5}}]};
  const result=predictTransfers(event,{groups:{'WR:targets':{coefficients:FEATURE_NAMES.map(()=>100),scale:0,trainingEvents:50}}});
  assert.equal(result.allocations.p.targets,0); assert.equal(result.provenance.targets.scale,0);
});
test('Large positive learned scores are normalized across teammates',()=>{
  const event={injuryPosition:'RB',vacated:{carries:15},players:['a','b'].map(id=>({id,position:'RB',baseline:{carries:3},last:{carries:3}}))};
  const coefs=FEATURE_NAMES.map((_,i)=>i===0?100:0);
  const result=predictTransfers(event,{groups:{'RB:carries':{coefficients:coefs,scale:1}}});
  near(result.allocations.a.carries,0.5);near(result.allocations.b.carries,0.5);
});
test('Current-game outcomes are never features and role ties are deterministic',()=>{
  const p={id:'a',position:'RB',baseline:{carries:3},last:{carries:4},actual:{carries:50}};
  const a=impactFeatures(p,'carries',10,1);p.actual.carries=0;
  assert.deepEqual(a,impactFeatures(p,'carries',10,1));assert.equal(a.length,FEATURE_NAMES.length);
  assert.equal(rankCandidates([{...p,id:'b',depthRank:3},{...p,id:'a',depthRank:2}],'carries').get('a'),1);
});
test('Learned mode rejects future fitted parameters, wrong artifact IDs, and inconsistent target inputs',()=>{
  assert.throws(()=>projectDataset(demo,calibration,{impactMode:'learned'}),/available/);
  assert.throws(()=>projectDataset(demo,calibration,{impactMode:'learned',injuryModel:{...model,availableAfter:'2027-01-01T00:00:00Z'}}),/available/);
  const d=structuredClone(demo);d.scenarios[0].injuryModelId='wrong';
  assert.throws(()=>projectDataset(d,calibration,{impactMode:'learned',injuryModel:model}),/different injury model/);
  delete d.scenarios[0].injuryModelId;d.scenarios[0].players[0].markets.find(m=>m.key==='receptions').opportunities=20;
  assert.throws(()=>projectDataset(d,calibration,{impactMode:'learned',injuryModel:model}),/same baseline/);
});
test('Baseline comparison removes every injury adjustment, including QB efficiency',()=>{
  const rows=projectDataset(demo,calibration,{impactMode:'baseline'});
  for(const r of rows){near(r.projection,r.activeMean);near(r.contextMultiplier,1);assert.equal(r.allocationMode,'baseline');}
});
test('Unquoted teammates remain in the allocation pool and mismatched features are rejected',()=>{
  const d=structuredClone(demo),s=d.scenarios[0];
  s.workloadCandidates=s.players.map(p=>({id:p.id,position:p.position,baseline:Object.fromEntries(['carries','targets','attempts'].map(k=>[k,p.markets.find(m=>(m.key==='rushing_yards'?'carries':m.key==='passing_yards'?'attempts':'targets')===k)?.opportunities??0])),last:{carries:0,targets:0,attempts:0}}));
  s.workloadCandidates.push({id:'unquoted-leader',position:'RB',depthRank:1,baseline:{carries:15,targets:4,attempts:0},last:{carries:16,targets:4,attempts:0}});
  const rows=projectDataset(d,calibration,{impactMode:'learned',injuryModel:model});assert.equal(rows.length,17);
  const p=rows.find(r=>r.playerId==='owen'&&r.market==='rushing_yards');assert.ok(p.allocationShare<1);
  s.workloadCandidates[0].baseline.carries=50;
  assert.throws(()=>projectDataset(d,calibration,{impactMode:'learned',injuryModel:model}),/differ from workloadCandidates/);
});
test('Kickoff conversion respects Eastern daylight and standard time',()=>{
  assert.equal(new Date(kickoffUTC({gameday:'2024-09-22',gametime:'13:00'})).toISOString(),'2024-09-22T17:00:00.000Z');
  assert.equal(new Date(kickoffUTC({gameday:'2024-12-01',gametime:'13:00'})).toISOString(),'2024-12-01T18:00:00.000Z');
});
function fixture(){
  const games=[1,2,3,4].map(week=>({game_id:`game${week}`,season:2024,game_type:'REG',week,gameday:`2024-09-${String(week*7-6).padStart(2,'0')}`,gametime:'13:00',home_team:'SEA',away_team:'ARI',home_score:'20',away_score:'17'}));
  const stat=(week,id,position,targets)=>({season:2024,week,season_type:'REG',recent_team:'SEA',player_id:id,position,targets,carries:0,attempts:0,receiving_yards:targets*8,receptions:targets*0.5,passing_yards:0,rushing_yards:0});
  const stats=[1,2,3].flatMap(w=>[stat(w,'injured','WR',6),stat(w,'beneficiary','WR',2)]);stats.push(stat(4,'beneficiary','WR',8));
  const depth=['injured','beneficiary','zero-player'].map((gsis_id,i)=>({season:2024,game_type:'REG',week:3,club_code:'SEA',formation:'Offense',position:'WR',gsis_id,depth_team:i+1,full_name:gsis_id}));
  const injuries=[{game_type:'REG',team:'SEA',week:4,gsis_id:'injured',position:'WR',full_name:'Injured Receiver',report_status:'Out',report_primary_injury:'Ankle',date_modified:'2024-09-20T16:00:00Z'}];
  return {season:2024,games,stats,depth,injuries,priors:fitEfficiencyPriors(stats.filter(r=>r.week<4))};
}
test('Historical candidate set is formed before the game and retains zero-production outcomes',()=>{
  const f=fixture();f.depth.push({...f.depth[0],gsis_id:'future-player',week:4});
  const result=buildInjuryEvents(f);assert.equal(result.events.length,1);
  const e=result.events[0];assert.equal(e.depthWeek,3);assert.deepEqual(e.historyWeeks,[1,2,3]);
  assert.equal(e.players.find(p=>p.id==='zero-player').actual.targets,0);
  assert.ok(!e.players.some(p=>p.id==='future-player'));
  const before=e.players.find(p=>p.id==='beneficiary').baseline.targets;
  f.stats.find(r=>r.week===4).targets=100;
  near(buildInjuryEvents(f).events[0].players.find(p=>p.id==='beneficiary').baseline.targets,before);
});
test('Post-kickoff reports and missing full-game stats cannot manufacture injury examples',()=>{
  const f=fixture();f.injuries[0].date_modified='2024-09-22T18:00:00Z';
  assert.equal(buildInjuryEvents(f).events.length,0);assert.equal(buildInjuryEvents(f).audit.lateOrInvalidReports,1);
  const g=fixture();g.stats=g.stats.filter(r=>r.week!==4);assert.equal(buildInjuryEvents(g).events.length,0);
});
test('Offline learned-slate preparer reproduces prior-game inputs and does not use the target game',()=>{
  const f=fixture(), root=fileURLToPath(new URL('../',import.meta.url)), dir=path.join(root,'.cache/test-preparer');mkdirSync(dir,{recursive:true});
  const csv=rows=>{const keys=[...new Set(rows.flatMap(r=>Object.keys(r)))];const cell=v=>'"'+String(v??'').replaceAll('"','""')+'"';return [keys.join(','),...rows.map(r=>keys.map(k=>cell(r[k])).join(','))].join('\n');};
  for(const [name,rows] of Object.entries({stats:f.stats,depth:f.depth,games:f.games}))writeFileSync(path.join(dir,`${name}.csv`),csv(rows));
  const data={schemaVersion:1,name:'Preparer test',mode:'import',asOf:'2024-09-21T18:00:00Z',scenarios:[{id:'fixture',team:'SEA',opponent:'ARI',kickoff:'2024-09-22T17:00:00Z',injury:{player:'Injured Receiver',nflverseId:'injured',position:'WR',status:'OUT',description:'Ankle',source:'Test report',updatedAt:'2024-09-20T16:00:00Z',absenceProbability:1,vacated:{targets:1}},players:[{id:'quoted',name:'Beneficiary',nflverseId:'beneficiary',position:'WR',allocation:{},assumption:'Test input',markets:[{key:'receiving_yards',opportunities:1,rate:5,line:20.5,overOdds:-110,underOdds:-110,book:'Test book',source:'Test quote',updatedAt:'2024-09-21T17:00:00Z'}]}]}]};
  writeFileSync(path.join(dir,'slate.json'),JSON.stringify(data));
  const output=path.join(dir,'prepared.json');
  execFileSync(process.execPath,[path.join(root,'scripts/prepare-injury-slate.mjs'),path.join(dir,'slate.json'),...['stats','depth','games'].map(n=>path.join(dir,`${n}.csv`)),output],{cwd:root});
  const prepared=JSON.parse(readFileSync(output,'utf8')), s=prepared.scenarios[0];
  near(s.injury.vacated.targets,6);near(s.players[0].markets[0].opportunities,2);assert.equal(s.workloadCandidates.length,2);assert.equal(s.players[0].id,'beneficiary');assert.equal(s.allocationMode,'learned');
  assert.equal(s.injuryModelId,model.modelId);assert.equal(s.historyCutoff.depthWeek,3);
  assert.doesNotThrow(()=>projectDataset(prepared,calibration,{injuryModel:model}));
});
