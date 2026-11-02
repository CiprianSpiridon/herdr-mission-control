import {canonicalRepoPath} from './config.js';

export class IdentityError extends Error {
  constructor(code,message){super(message);this.code=code;}
}
const fail=message=>{throw new IdentityError('INVALID_IDENTITY',message);};
const text=(v,label,max=2048)=>{if(typeof v!=='string'||!v||v.length>max||/[\u0000-\u001f]/.test(v))fail(`Invalid ${label}`);return v;};
export function machineIdentity(value){return value==null?null:text(value,'machine',128);}
export function sessionIdentity(value){
  if(!value||typeof value!=='object')fail('Missing provider session identity');
  return {machine:machineIdentity(value.machine),provider:text(value.provider,'provider',128),credentialScope:text(value.credentialScope,'credential scope',256),providerRoot:canonicalRepoPath(value.providerRoot),sessionId:text(value.sessionId,'session ID',256)};
}
export const sessionKey=value=>{const s=sessionIdentity(value);return JSON.stringify([s.machine,s.provider,s.credentialScope,s.providerRoot,s.sessionId]);};
export function localTerminalAddress(address,on){
  text(address,'terminal address',256);const machine=machineIdentity(on);
  const local=machine&&address.startsWith(machine+'/')?address.slice(machine.length+1):address;
  // Core addresses are opaque: after the initial numeric-looking values,
  // real cores emit t1b/t1z and other lower-case alphanumeric addresses.
  if(!/^t[0-9a-z]+$/.test(local))fail('Terminal address does not belong to the requested host');
  return local;
}
export function terminalIdentity(raw,on=null){
  if(!raw||!Number.isSafeInteger(raw.created_ms)||raw.created_ms<0)fail('Full raw terminal created_ms is required');
  const machine=machineIdentity(on),local=localTerminalAddress(raw.address,machine);
  const pid=raw.foreground?.pid??null;
  if(pid!==null&&(!Number.isSafeInteger(pid)||pid<=0))fail('Invalid foreground PID');
  return {machine,address:machine?machine+'/'+local:local,createdMs:raw.created_ms,foregroundPid:pid};
}
export function terminalKey(identity){
  if(!identity||!Number.isSafeInteger(identity.createdMs)||identity.createdMs<0)fail('Missing terminal generation');
  const on=machineIdentity(identity.machine),local=localTerminalAddress(identity.address,on),pid=identity.foregroundPid??null;
  if(pid!==null&&(!Number.isSafeInteger(pid)||pid<=0))fail('Invalid foreground PID');
  return JSON.stringify([on,local,identity.createdMs,pid]);
}
export async function hydrateTerminal(raw,{machine=null,exec}={}){
  try{return {identity:terminalIdentity(raw,machine),raw};}catch{}
  const address=localTerminalAddress(raw?.address,machine);
  if(typeof exec!=='function')throw new IdentityError('TERMINAL_UNAVAILABLE','Full terminal hydration is unavailable');
  const r=await exec('hc',['get',address,'--json'],{on:machineIdentity(machine)});
  if(r.code!==0)throw new IdentityError('TERMINAL_UNAVAILABLE','Cannot read the exact terminal generation');
  let full;try{full=JSON.parse(r.stdout);}catch{fail('Invalid full terminal response');}
  if(localTerminalAddress(full.address,machine)!==address)fail('Hydrated terminal address changed');
  return {identity:terminalIdentity(full,machine),raw:full};
}
let sequence=0;
export function newIntent({requestId,originId}={}){
  const mint=()=>`mc-${Date.now().toString(36)}-${(++sequence).toString(36)}-${Array.from({length:4},()=>Math.floor(Math.random()*0x100000000).toString(16).padStart(8,'0')).join('')}`;
  const id=text(requestId??mint(),'request ID',256);
  return {requestId:id,idempotencyKey:id,originId:text(originId??mint(),'origin ID',256)};
}
export function validateOrigin(value){
  if(!value||typeof value!=='object')fail('Missing work origin');
  const result={originId:text(value.originId,'origin ID',256),requestId:text(value.requestId,'request ID',256)};
  if(value.sourceKey!==undefined)result.sourceKey=text(value.sourceKey,'source key',2048);
  if(value.session!==undefined)result.session=sessionIdentity(value.session);
  if(value.currentTabId!==undefined)result.currentTabId=text(value.currentTabId,'tab ID',256);
  if(value.terminal!==undefined){terminalKey(value.terminal);result.terminal={...value.terminal,machine:machineIdentity(value.terminal.machine)};}
  return result;
}
export function sameSession(a,b){return sessionKey(a)===sessionKey(b);}
export function sameTerminal(a,b){return terminalKey(a)===terminalKey(b);}
export function unboundOrigin(origin,reason='No exact provider-session proof'){return {...validateOrigin(origin),session:undefined,binding:{state:'unbound',reason}};}
