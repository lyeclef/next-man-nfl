export function forecastKey(modelId,prediction){
  // One predictive outcome per player/market/game, regardless of quote updates.
  return [modelId,prediction.kickoff,prediction.team,prediction.playerId,prediction.market].join(':');
}
export function snapshotChronologyValid(snapshot){
  const cutoff=Date.parse(snapshot.asOf),issued=Date.parse(snapshot.issuedAt??snapshot.asOf);
  return Number.isFinite(cutoff)&&Number.isFinite(issued)&&issued>=cutoff&&Array.isArray(snapshot.sources)&&snapshot.sources.length>0&&snapshot.sources.every(s=>Number.isFinite(Date.parse(s.retrievedAt))&&Date.parse(s.retrievedAt)<=cutoff);
}
