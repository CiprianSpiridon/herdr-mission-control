import {canonicalRepoPath} from './config.js';
import {sessionIdentity,sessionKey} from './session-identity.js';

const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&(Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null);
const text=(v,max=200)=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\u0000-\u001f]/.test(v);
const number=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
const nullableNumber=v=>v===null||number(v);
const timestamp=v=>v===null||number(v)&&v<=8640000000000000;
const keys=(v,required,optional=[])=>object(v)&&required.every(k=>Object.hasOwn(v,k))&&Object.keys(v).every(k=>required.includes(k)||optional.includes(k));
const providers=new Set(['codex','claude','grok']);
const session=value=>{
  if(!keys(value,['machine','provider','credentialScope','providerRoot','sessionId'])||!(value.machine===null||text(value.machine,128))||!providers.has(value.provider)||!text(value.credentialScope)||!text(value.sessionId))return false;
  try{return sessionIdentity(value).providerRoot===value.providerRoot;}catch{return false;}
};

/** Validate the entire collector union before either metric consumes it. */
export function validateProviderObservation(value,{identity}={}){
  const fail=(code,reason)=>({ok:false,code,reason});
  if(!object(value)||!['available','unavailable'].includes(value.state))return fail('INVALID_OBSERVATION','Provider observation envelope is invalid.');
  if(value.identity!==null&&!session(value.identity))return fail('INVALID_OBSERVATION','Provider session identity is invalid.');
  if(value.state==='available'&&value.identity===null)return fail('INVALID_OBSERVATION','Measured observations require an exact session identity.');
  const p=value.provenance;
  if(!keys(p,['provider','format','formatVersion','sourceDigest','observedAt'])||!providers.has(p.provider)||!text(p.format,80)||!(p.formatVersion===null||text(p.formatVersion,80))||typeof p.sourceDigest!=='string'||!/^[a-f0-9]{64}$/.test(p.sourceDigest)||!timestamp(p.observedAt)||value.identity&&p.provider!==value.identity.provider)return fail('INVALID_OBSERVATION','Provider provenance is invalid.');
  if(identity){
    if(!session(identity))return fail('INVALID_IDENTITY','The requested session identity is invalid.');
    if(p.provider!==identity.provider||value.identity&&sessionKey(value.identity)!==sessionKey(identity))return fail('SCOPE_MISMATCH','Observation belongs to a different exact provider session.');
  }
  if(value.state==='unavailable')return keys(value,['state','identity','provenance','code','reason'])&&text(value.code,80)&&text(value.reason,300)?{ok:true,value}:fail('INVALID_OBSERVATION','Unavailable observation is invalid.');
  if(!keys(value,['state','identity','provenance','context','quota'],['title','cwd']))return fail('INVALID_OBSERVATION','Unexpected provider observation fields.');
  if(Object.hasOwn(value,'title')&&!text(value.title))return fail('INVALID_OBSERVATION','Reported session title is invalid.');
  if(Object.hasOwn(value,'cwd')){try{if(canonicalRepoPath(value.cwd)!==value.cwd)return fail('INVALID_OBSERVATION','Reported working directory is not canonical.');}catch{return fail('INVALID_OBSERVATION','Reported working directory is invalid.');}}
  const c=value.context;
  if(c!==null&&(!keys(c,['usedTokens','windowTokens','compactionLimitTokens','reportedUsedPercent'])||Object.values(c).some(v=>!nullableNumber(v))||c.reportedUsedPercent!==null&&c.reportedUsedPercent>100))return fail('INVALID_OBSERVATION','Provider context fields are invalid.');
  const q=value.quota;
  if(q!==null){
    if(!keys(q,['proof','windows']))return fail('INVALID_OBSERVATION','Provider quota envelope is invalid.');
    const proof=q.proof;
    if(!keys(proof,['kind','machine','credentialScope','accountId','poolId'])||!['provider-account','session-account-digest','session-report','none'].includes(proof.kind)||proof.machine!==value.identity.machine||proof.credentialScope!==value.identity.credentialScope||![proof.accountId,proof.poolId].every(v=>v===null||text(v)))return fail('INVALID_OBSERVATION','Provider quota identity is invalid.');
    if(!Array.isArray(q.windows)||q.windows.length>16||q.windows.some(w=>!keys(w,['name','remainingPercent','observedAt','resetsAt'])||!text(w.name,80)||!number(w.remainingPercent)||w.remainingPercent>100||!timestamp(w.observedAt)||!timestamp(w.resetsAt)))return fail('INVALID_OBSERVATION','Provider quota windows are invalid.');
  }
  return {ok:true,value};
}
