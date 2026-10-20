import {parseCSV} from './csv.mjs';
import {validateDataset} from './model.mjs';
export const QUOTE_COLUMNS=['scenarioId','playerId','market','line','overOdds','underOdds','book','source','capturedAt'];
export function quoteTemplate(dataset){return QUOTE_COLUMNS.join(',')+'\r\n'+dataset.scenarios.flatMap(s=>s.players.flatMap(p=>p.markets.map(m=>[s.id,p.id,m.key,'','','','','',''].map(v=>'"'+String(v).replaceAll('"','""')+'"').join(',')))).join('\r\n')+'\r\n';}
export function mergeQuoteCSV(dataset,text,{now=new Date().toISOString()}={}){
  const records=parseCSV(text);if(!records.length)throw new Error('No quote records supplied.');
  const cutoff=Date.parse(now);if(!Number.isFinite(cutoff))throw new Error('Invalid import time.');
  const result=structuredClone(dataset),seen=new Set(),replaced=new Set(),originalCutoffs=new Map(dataset.scenarios.map(s=>[s.id,Date.parse(s.asOf??dataset.asOf)]));let merged=0;
  for(const r of records){
    if(QUOTE_COLUMNS.some(k=>!Object.hasOwn(r,k)))throw new Error('Missing required quote columns: '+QUOTE_COLUMNS.join(', '));
    if(!r.line&&!r.book&&!r.capturedAt)continue; // Unfilled template rows are never quotes.
    if(QUOTE_COLUMNS.some(k=>!String(r[k]).trim()))throw new Error('Every quote needs a line, both prices, book, source and capture time.');
    const s=result.scenarios.find(s=>s.id===r.scenarioId),p=s?.players.find(p=>p.id===r.playerId),m=p?.markets.find(m=>m.key===r.market);if(!m)throw new Error('Quote does not match an exact scenario/player/market.');
    const at=Date.parse(r.capturedAt),original=originalCutoffs.get(s.id);
    if(!Number.isFinite(at)||!/(Z|[+-]\d\d:\d\d)$/.test(r.capturedAt)||at>cutoff||at<original||at>=Date.parse(s.kickoff)||cutoff>=Date.parse(s.kickoff))throw new Error('Quote must be captured after the input snapshot, no later than import time, and before kickoff.');
    if(dataset.mode==='historical')throw new Error('Use an archived price pipeline for historical data; current quote capture cannot rewrite a historical forecast.');
    if(cutoff-original>24*3600000)throw new Error('Injury inputs are over 24 hours old. Refresh the sourced slate before importing current quotes.');
    if(!/^https:\/\//.test(r.source))throw new Error('Quote source must be an HTTPS source link.');
    const quote={...m,line:Number(r.line),overOdds:Number(r.overOdds),underOdds:Number(r.underOdds),book:r.book,source:r.source,updatedAt:new Date(at).toISOString()};
    const key=[s.id,p.id,m.key,r.book,quote.line].join(':');if(seen.has(key))throw new Error('Duplicate quote row.');seen.add(key);
    const targetKey=[s.id,p.id,m.key].join(':');
    p.markets=p.markets.filter(old=>!(old.key===m.key&&(!replaced.has(targetKey)||old.book==null||old.book===r.book&&old.line===quote.line)));
    replaced.add(targetKey);p.markets.push(quote);s.asOf=new Date(cutoff).toISOString();merged++;
  }
  if(!merged)throw new Error('The template contains no completed quotes. No prices were invented.');
  result.originalAsOf=dataset.asOf;result.asOf=new Date(cutoff).toISOString();result.mode='import';result.name=dataset.name+' · user-supplied prices';
  validateDataset(result);return {dataset:result,merged};
}
