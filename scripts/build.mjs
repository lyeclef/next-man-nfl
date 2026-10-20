import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validateDataset, projectDataset } from '../lib/model.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const calibration = JSON.parse(await readFile(path.join(root, 'data/calibration.json'), 'utf8'));
const injuryModel = JSON.parse(await readFile(path.join(root, 'data/injury-model.json'), 'utf8'));
const validationPolicy=JSON.parse(await readFile(path.join(root,'data/validation-policy.json'),'utf8'));
for(const name of ['current-slate','historical-slate','conditional-slate']){const slate=JSON.parse(await readFile(path.join(root,`data/${name}.json`),'utf8'));validateDataset(slate);projectDataset(slate,calibration,{injuryModel,validationPolicy});const candidate=JSON.parse(await readFile(path.join(root,'data/candidate-model.json'),'utf8'));const copy=structuredClone(slate);for(const s of copy.scenarios)s.injuryModelId=candidate.modelId;projectDataset(copy,calibration,{injuryModel:candidate,validationPolicy});}
const dist=path.resolve(root,'dist'),workspace=path.resolve(root);
if(dist!==path.join(workspace,'dist')||!dist.startsWith(workspace+path.sep))throw new Error('Build output is outside the intended project.');
await rm(dist,{recursive:true,force:true});await mkdir(dist,{recursive:true});
await cp(path.join(root,'public'),dist,{recursive:true});
await mkdir(path.join(dist,'lib'),{recursive:true});await mkdir(path.join(dist,'data'),{recursive:true});
for(const name of ['model.mjs','injury-impact.mjs','csv.mjs','quote-csv.mjs'])await cp(path.join(root,'lib',name),path.join(dist,'lib',name));
for(const name of ['current-slate','historical-slate','conditional-slate','injury-watchlist','candidate-model','candidate-validation','calibration','injury-model','injury-validation','walk-forward-validation','validation-policy','source-status','forward-status'])await cp(path.join(root,`data/${name}.json`),path.join(dist,`data/${name}.json`));
console.log('Built sourced-only dashboard; test fixtures and retired demo assets are excluded.');
