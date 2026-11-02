import {sessionIdentity} from './session-identity.js';
import {validateProviderObservation} from './provider-observation.js';

export const CONTEXT_STALE_MS=120000;
const clamp=value=>Math.max(0,Math.min(100,value));

export function normalizeContext(observation,identity,{now=Date.now(),staleAfter=CONTEXT_STALE_MS}={}){
  let target;try{target=sessionIdentity(identity);}catch{return {identity:null,state:'unavailable',remainingPercent:null,basis:'unavailable',observedAt:null,reason:'An exact provider session identity is required.'};}
  const missing=reason=>({identity:target,state:'unavailable',remainingPercent:null,basis:'unavailable',observedAt:null,reason});
  if(!observation)return missing('No exact session context observation is available.');
  const checked=validateProviderObservation(observation,{identity:target});
  if(!checked.ok)return missing(checked.reason);
  if(observation.state!=='available')return missing(observation.reason);
  const c=observation.context;
  if(!c)return missing('This provider has not reported session context.');
  const {usedTokens:used,windowTokens:window,compactionLimitTokens:limit,reportedUsedPercent:percent}=c;
  if(window===0||limit===0||limit!==null&&window!==null&&limit>window)return missing('Reported context window and compaction limit are contradictory.');
  if(percent!==null&&used!==null&&window!==null&&Math.abs(percent-clamp(100*used/window))>1)return missing('Reported token counts and context percentage disagree.');
  let remaining,basis,reason;
  if(limit!==null&&used!==null){remaining=clamp(100*(limit-used)/limit);basis='reported';reason='Remaining before the reported compaction threshold.';}
  else if(used!==null&&window!==null){remaining=clamp(100*(window-used)/window);basis='estimate';reason='Context-window estimate; the provider did not report its compaction threshold.';}
  else if(percent!==null){remaining=clamp(100-percent);basis='estimate';reason='Reported context-window percentage; the compaction threshold is unavailable.';}
  else return missing('A reported context window or percentage is required; model names do not establish capacity.');
  const at=observation.provenance.observedAt;
  if(at===null)return missing('The context observation has no session-specific timestamp.');
  if(at>now+5000)return missing('The context observation is dated in the future.');
  const stale=now-at>staleAfter;
  return {identity:target,state:stale?'stale':'available',remainingPercent:remaining,basis,observedAt:at,reason:stale?'The last exact context observation is older than two minutes. '+reason:reason};
}

export function selectContext(observations,identity,options={}){
  const readings=(Array.isArray(observations)?observations:[]).filter(o=>o?.identity&&validateProviderObservation(o,{identity}).ok).map(o=>normalizeContext(o,identity,options));
  const measured=readings.filter(r=>r.state!=='unavailable').sort((a,b)=>b.observedAt-a.observedAt);
  return measured[0]||readings[0]||normalizeContext(null,identity,options);
}
