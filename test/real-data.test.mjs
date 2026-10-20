import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {projectDataset,validateDataset} from '../lib/model.mjs';
import {latestDepth,normalizeStats} from '../lib/real-data.mjs';
import {forecastKey,snapshotChronologyValid} from '../lib/forward-validation.mjs';
const read=async name=>JSON.parse(await readFile(new URL(`../data/${name}.json`,import.meta.url),'utf8'));
const [current,historical,model,calibration,policy,status]=await Promise.all(['current-slate','historical-slate','injury-model','calibration','validation-policy','source-status'].map(read));
const fixture=JSON.parse(await readFile(new URL('./fixtures/synthetic-slate.json',import.meta.url),'utf8'));
test('Published current data contains only linked real identities, live quotes, and no future outcomes',()=>{
  assert.equal(current.mode,'sourced');
  const rows=projectDataset(current,calibration,{injuryModel:model,validationPolicy:policy,now:current.asOf});
  assert.ok(rows.every(r=>['QB','RB','WR','TE'].includes(r.position)));
  for(const s of current.scenarios){assert.match(s.injury.source,/^https:\/\//);assert.match(s.injury.nflverseId,/^00-/);assert.ok(Date.parse(s.injury.updatedAt)<=Date.parse(s.asOf));}
  assert.ok(rows.some(r=>r.hasQuote),'Current slate should include matched live sportsbook/DFS quotes.');
  for(const r of rows){
    assert.equal(r.actual,null);
    if(r.hasQuote){
      assert.equal(r.eligible,true);
      assert.ok(Number.isFinite(r.candidateEV));
      assert.ok(Number.isFinite(r.overProbability));
      assert.ok(['OVER','UNDER','PASS'].includes(r.signal));
    }else{
      assert.equal(r.candidateEV,null);
      assert.equal(r.overProbability,null);
      assert.equal(r.eligible,false);
      assert.equal(r.signal,'NO_QUOTE');
    }
  }
  for(const source of status.sources)assert.ok(Date.parse(source.retrievedAt)<=Date.parse(current.asOf),'A source must be retrieved before the forecast information cutoff.');
});
test('Historical board predictions exactly reproduce the frozen 2024 validation ledger',async()=>{
  const rows=projectDataset(historical,calibration,{injuryModel:model,validationPolicy:policy});
  const ledger=JSON.parse(await readFile(new URL('./fixtures/2024-real-ledger.json',import.meta.url),'utf8'));
  assert.equal(rows.length,ledger.length);const lookup=new Map(rows.map(r=>[`${r.scenarioId}:${r.playerId}:${r.market}`,r]));
  for(const expected of ledger){const actual=lookup.get(`${expected.eventId}:${expected.playerId}:${expected.market}`);assert.ok(actual);assert.ok(Math.abs(actual.projection-expected.projection)<1e-7);assert.equal(actual.actual,expected.actual);assert.equal(actual.hasQuote,false);}
  assert.ok(rows.some(r=>r.actual===0),'Zero-production outcomes must be retained.');
});
test('Missing quotes are distinct from zero lines and partial quotes are rejected',()=>{
  const d=structuredClone(current),m=d.scenarios.flatMap(s=>s.players).flatMap(p=>p.markets).find(x=>x.line===null);
  assert.doesNotThrow(()=>validateDataset(d));m.overOdds=-110;assert.throws(()=>validateDataset(d),/together/);
});
test('Priced rows do not produce an actionable EV without validation approval',()=>{
  const rows=projectDataset(fixture,calibration,{validationPolicy:policy,now:fixture.asOf});
  for(const r of rows){assert.equal(r.hasQuote,true);assert.ok(Number.isFinite(r.researchOverEV));assert.equal(r.candidateEV,null);assert.equal(r.signal,'NOT_VALIDATED');assert.equal(r.eligible,false);}
});
test('An approval list cannot bypass failed validation or missing model-specific evidence',()=>{
  const p={...policy,approvedMarkets:['RB:rushing_yards'],status:'approved',probabilityCalibration:{status:'not_evaluated'}};
  const rows=projectDataset(fixture,calibration,{validationPolicy:p,injuryModel:model,now:fixture.asOf});assert.ok(rows.every(r=>!r.eligible&&r.candidateEV===null));
});
test('Quote changes do not multiply prospective samples and invalid chronology is rejected',()=>{
  const p={kickoff:'2026-10-25T20:25:00Z',team:'LA',playerId:'real-player',market:'receiving_yards',id:'first-book-line'};
  assert.equal(forecastKey('m',p),forecastKey('m',{...p,id:'second-book-line'}));
  const snapshot={asOf:'2026-10-20T17:00:00Z',issuedAt:'2026-10-20T17:00:01Z',sources:[{retrievedAt:'2026-10-20T16:59:59Z'}]};assert.equal(snapshotChronologyValid(snapshot),true);
  snapshot.sources[0].retrievedAt='invalid';assert.equal(snapshotChronologyValid(snapshot),false);
});
test('Future outcomes cannot enter a current pregame dataset or an early historical capture',()=>{
  const d=structuredClone(current),m=d.scenarios[0].players[0].markets[0];m.actual=10;m.actualSource='https://example.org/test-outcome';
  assert.throws(()=>validateDataset(d),/only accepted in historical/);d.mode='historical';assert.throws(()=>validateDataset(d),/completed-game window/);
});
test('Old demonstration imports are rejected and empty current coverage is represented honestly',()=>{
  const d=structuredClone(fixture);d.mode='demo';assert.throws(()=>validateDataset(d),/no longer supported/);
  assert.doesNotThrow(()=>validateDataset({...current,scenarios:[]}));
});
test('Timestamped depth selection excludes future snapshots',()=>{
  const row={team:'LA',gsis_id:'00-1',player_name:'Test player',pos_abb:'WR',pos_rank:'1'};
  const result=latestDepth([{...row,dt:'2026-10-10T12:00:00Z'},{...row,dt:'2026-10-30T12:00:00Z',player_name:'Future name'}],'LAR','2026-10-20T12:00:00Z');
  assert.equal(result.at,'2026-10-10T12:00:00Z');assert.equal(result.players[0].name,'Test player');
});
test('Modern stat schema maps team fields and rejects malformed numeric inputs',()=>{
  const row={player_id:'00-1',position:'QB',season_type:'REG',team:'LAR',attempts:'30',carries:'2',targets:'0',passing_yards:'200',rushing_yards:'10',receiving_yards:'0',receptions:'0'};
  const result=normalizeStats([row]);assert.equal(result[0].recent_team,'LA');assert.equal(result[0].attempts,30);assert.throws(()=>normalizeStats([{...row,attempts:'bad'}]),/Invalid attempts/);
});
test('Static build excludes retired fictional assets and test fixtures',async()=>{
  const files=await readdir(new URL('../dist/',import.meta.url),{recursive:true});assert.ok(!files.some(f=>/demo|fixture|make-demo/.test(f)));
  const json=await readFile(new URL('../dist/data/current-slate.json',import.meta.url),'utf8');for(const old of ['Owen Brooks','Marcus Hale','Example Book','Finn Marshall'])assert.ok(!json.includes(old));
});
test('Validation report is chronological and approves markets with out-of-sample MAE improvement',async()=>{
  const report=await read('walk-forward-validation');assert.deepEqual(report.folds.map(f=>f.testSeason),[2022,2023,2024]);
  for(const f of report.folds){assert.ok(f.trainingSeasons.every(y=>y<f.selectionSeason));assert.ok(f.selectionSeason<f.testSeason);}
  assert.equal(policy.status,'approved');assert.equal(policy.approvedMarkets.length,9);assert.ok(Object.values(report.metrics).every(m=>Array.isArray(m.familywise95CI)&&m.learnedMAE<m.baselineMAE));
});

