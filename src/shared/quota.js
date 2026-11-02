import {sessionIdentity,sessionKey} from './session-identity.js';
import {validateProviderObservation} from './provider-observation.js';

export const QUOTA_STALE_MS=300000;
const formats={codex:new Set(['codex-rollout-jsonl','legacy-codex-app-server']),claude:new Set(['claude-project-jsonl','legacy-claude-statusline']),grok:new Set(['grok-build-summary','grok-build-updates','legacy-grok-cli-billing'])};
export const quotaKey=identity=>JSON.stringify([identity.machine,identity.provider,identity.credentialScope,identity.accountId,identity.poolId,identity.session?sessionKey(identity.session):null]);

function candidate(observation,identity,{now=Date.now(),staleAfter=QUOTA_STALE_MS}={}){
  let target;try{target=sessionIdentity(identity);}catch{target=null;}
  const unknown={machine:target?.machine??null,provider:target?.provider??'unknown',credentialScope:target?.credentialScope??'unknown',accountId:null,poolId:null,...(target?{session:target}:{})};
  const missing=reason=>({reading:{identity:unknown,state:'unavailable',windows:[],observedAt:null,scope:'unknown',reason},sourceWindows:[]});
  if(!target)return missing('An exact provider session identity is required.');
  if(!observation)return missing('No exact session quota observation is available.');
  const checked=validateProviderObservation(observation,{identity:target});
  if(!checked.ok)return missing(checked.reason);
  if(observation.state!=='available')return missing(observation.reason);
  if(!formats[target.provider]?.has(observation.provenance.format))return missing('The quota source format is unsupported.');
  const q=observation.quota;
  if(!q||!q.windows.length||q.proof.kind==='none')return missing('This session has no proven provider quota report.');
  const names=new Set(q.windows.map(w=>w.name));
  if(names.size!==q.windows.length)return missing('The provider reported conflicting duplicate quota windows.');
  if(q.windows.some(w=>w.observedAt!==null&&w.observedAt>now+5000))return missing('The quota observation is dated in the future.');
  const p=q.proof;
  // This sanitized Claude schema reports the subscription's window set, with
  // an exact per-session account digest and no separate pool dimension.
  const noPool=target.provider==='claude'&&observation.provenance.format==='legacy-claude-statusline'&&p.kind==='session-account-digest'&&/^[a-f0-9]{64}$/.test(p.accountId||'')&&p.poolId===null;
  const shared=['provider-account','session-account-digest'].includes(p.kind)&&p.accountId!==null&&(p.poolId!==null||noPool);
  const quotaIdentity={machine:target.machine,provider:target.provider,credentialScope:target.credentialScope,accountId:shared?p.accountId:null,poolId:shared?p.poolId:null,...(!shared?{session:target}:{})};
  const unknownAge=q.windows.some(w=>w.observedAt===null),old=q.windows.some(w=>w.observedAt!==null&&now-w.observedAt>staleAfter),reset=q.windows.some(w=>w.resetsAt!==null&&w.resetsAt<=now);
  const stale=unknownAge||old||reset;
  const reason=reset?'A reported quota window has reset; a new observation is required.':unknownAge?'A quota window has no trustworthy observation time.':old?'The quota observation is older than five minutes.':shared?'Shared account quota; matching agents use the same allowance.':'Session observation; the serving account/pool is not fully proven.';
  return {reading:{identity:quotaIdentity,state:stale?'stale':'available',windows:q.windows.map(w=>({name:w.name,remainingPercent:w.remainingPercent,...(w.resetsAt!==null?{resetsAt:w.resetsAt}:{})})),observedAt:unknownAge?null:Math.min(...q.windows.map(w=>w.observedAt)),scope:shared?'shared-account':'session-observation',reason},sourceWindows:q.windows.map(w=>({...w}))};
}

export function normalizeQuota(observation,identity,options={}){return candidate(observation,identity,options).reading;}

/** Join only after this exact session has a fresh verified account identity. */
export function selectQuota(observations,identity,options={}){
  const values=Array.isArray(observations)?observations:[];
  const own=values.map(observation=>({observation,...candidate(observation,identity,options)})).filter(c=>c.reading.state!=='unavailable');
  own.sort((a,b)=>Math.max(...b.sourceWindows.map(w=>w.observedAt??-1))-Math.max(...a.sourceWindows.map(w=>w.observedAt??-1)));
  const anchor=own[0];
  if(!anchor)return normalizeQuota(null,identity,options);
  if(anchor.reading.scope!=='shared-account'||anchor.reading.state!=='available')return anchor.reading;
  const key=quotaKey(anchor.reading.identity),windows=new Map(anchor.sourceWindows.map(w=>[w.name,w]));
  for(const observation of values){
    const other=candidate(observation,observation?.identity,options);
    if(other.reading.state==='unavailable'||other.reading.scope!=='shared-account'||quotaKey(other.reading.identity)!==key)continue;
    for(const window of other.sourceWindows){
      const current=windows.get(window.name);
      if(window.observedAt!==null&&(!current||window.observedAt>(current.observedAt??-1)))windows.set(window.name,window);
    }
  }
  return normalizeQuota({...anchor.observation,quota:{...anchor.observation.quota,windows:[...windows.values()]}},identity,options);
}
