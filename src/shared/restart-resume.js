/**
 * Resume after restart: the running-agents journal and its pure rules.
 *
 * While an agent runs, Mission Control records {terminal, tool, exact session ID}. When Herdr brings that
 * terminal back as a plain shell because the terminal's own process was lost (reboot, logout, core crash,
 * that process dying by signal), the entry becomes lost and a restart pass types the tool's own resume
 * command into the restored shell, or offers it. Agents the person quit are removed and never come back.
 */
import {machineIdentity} from './session-identity.js';

export const RESTART=Object.freeze({version:1,entriesPerMachine:500,bytes:900*1024,machines:32,typeWindowMs:15*60000,sendingStaleMs:60000,graceMs:60000,offerMs:24*3600000,leaseMs:15000,seenRefreshMs:60000,maxSends:4});
export const RESTART_STATE_KEY='mission-control-restart-v1';
export const STATES=Object.freeze(['tracking','lost','sending','sent','offered','skipped']);
export const VIAS=Object.freeze(['pid-record','codex-hook','open-file','argv','binding']);
export const PROVIDERS=Object.freeze(['claude','codex','grok']);
export const POSIX_SHELLS=new Set(['sh','bash','zsh','dash','ksh']);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ADDRESS=/^t[0-9a-z]{1,63}$/;
// Herdr's launch wrappers: local login shell and the remote sh -c form (launch.js).
const WRAPPERS=Object.freeze({'-lic':'"$@"; exec "$0" -li','-c':'"$@"; exec "${SHELL:-sh}" -i'});

export class RestartError extends Error {constructor(code,message){super(message);this.name='RestartError';this.code=code;}}
const fail=(code,message)=>{throw new RestartError(code,message);};
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const time=v=>Number.isSafeInteger(v)&&v>=0;
const pid=v=>Number.isSafeInteger(v)&&v>1;
const text=(v,max=256)=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\u0000-\u001f]/.test(v)&&!['__proto__','constructor','prototype'].includes(v);
const clone=v=>JSON.parse(JSON.stringify(v));
const freeze=v=>{if(v&&typeof v==='object'&&!Object.isFrozen(v)){for(const c of Object.values(v))freeze(c);Object.freeze(v);}return v;};
const base=v=>typeof v==='string'?v.slice(v.lastIndexOf('/')+1).replace(/^-+/,''):'';

/** "local" for this computer, else the machine name. A machine literally named "local" is not supported. */
export function machineKey(machine){const m=machineIdentity(machine);if(m==='local')fail('INVALID_MACHINE','A machine named "local" cannot be recorded');return m===null?'local':m;}
export const machineOf=key=>key==='local'?null:key;

/** preferences.resumeAfterRestart: absent means on; anything but a boolean means off, and says so. */
export function resumePreference(config){
  const v=config?.preferences?.resumeAfterRestart;
  if(v===undefined)return freeze({on:true,reason:null});
  if(typeof v==='boolean')return freeze({on:v,reason:v?null:'Resume after restart is turned off.'});
  return freeze({on:false,reason:'preferences.resumeAfterRestart is not true or false, so resume after restart is off.'});
}

/** An exact resume argv: claude/grok --resume <uuid>, codex resume <uuid>. Same UUID rule as buildArguments. */
export function argvSession(argv){
  if(!Array.isArray(argv))return null;const words=argv.slice(0,32).map(String),names=words.slice(0,3).map(base);
  const provider=names.some(n=>n==='claude')||words.slice(0,3).some(w=>w.includes('/@anthropic-ai/claude-code/'))?'claude':names.some(n=>n==='codex')?'codex':names.some(n=>/^grok(?:$|-)/.test(n))?'grok':null;
  if(!provider)return null;
  for(let i=0;i<words.length;i++){
    const w=words[i];let id=null;
    if(provider!=='codex'&&(w==='--resume'||w==='-r'))id=words[i+1];
    else if(provider!=='codex'&&w.startsWith('--resume='))id=w.slice(9);
    else if(provider==='codex'&&w==='resume')id=words[i+1];
    if(typeof id==='string'&&UUID.test(id))return freeze({provider,sessionId:id.toLowerCase(),via:'argv'});
  }
  return null;
}

/** Which tool a terminal runs, from Herdr's own program table first, then the agent's report, then argv. */
export function providerOf({programKey,app,argv,name}={}){
  const k=String(programKey||'').toLowerCase();if(PROVIDERS.includes(k))return k;
  const a=String(app||'').toLowerCase();if(a==='claude-code'||a==='claude')return 'claude';if(a==='codex')return 'codex';if(a==='grok-build'||a==='grok')return 'grok';
  const words=Array.isArray(argv)?argv.slice(0,3).map(String):[],names=[...words.map(base),base(name)];
  if(names.includes('claude')||words.some(w=>w.includes('/@anthropic-ai/claude-code/')))return 'claude';
  if(names.includes('codex'))return 'codex';if(names.some(n=>/^grok(?:$|-)/.test(n)))return 'grok';
  return null;
}

/** True when argv is one of Herdr's launch wrappers (the program still runs inside it). */
export function isWrapper(argv){return Array.isArray(argv)&&argv.length>=3&&WRAPPERS[argv[1]]===argv[2]&&POSIX_SHELLS.has(base(argv[0]));}
/** The agent process: the foreground, or its single direct child when the foreground is a Herdr launch wrapper. */
export function agentProcess(foreground,children=[]){
  if(isWrapper(foreground?.argv))return children.length===1?children[0]:null;
  return foreground&&pid(foreground.pid)?foreground:null;
}

/** One POSIX shell line from a verified argv: words needing it are single-quoted. */
export function resumeLine(argv){
  if(!Array.isArray(argv)||!argv.length||argv.some(w=>typeof w!=='string'||!w||w.includes('\0')||/[\n\r]/.test(w)))fail('INVALID_ARGV','A resume command needs plain words');
  return argv.map(w=>/^[A-Za-z0-9_@%+=:,./-]+$/.test(w)?w:"'"+w.replace(/'/g,"'\\''")+"'").join(' ');
}
export const cdPrefix=cwd=>"cd "+resumeLine([cwd])+' && ';

export const emptyJournal=()=>({v:RESTART.version,revision:0,lease:null,machines:{}});
function entry(e){
  if(!plain(e)||!STATES.includes(e.state))fail('INVALID_JOURNAL','Invalid running-agent entry');
  for(const f of ['spaceId','tabId','toolKey'])if(!text(e[f]))fail('INVALID_JOURNAL','Invalid '+f);
  if(!text(e.cwd,4096)||!e.cwd.startsWith('/'))fail('INVALID_JOURNAL','Invalid cwd');
  if(!PROVIDERS.includes(e.provider)||!UUID.test(e.sessionId??'')||!VIAS.includes(e.via))fail('INVALID_JOURNAL','Invalid session identity');
  for(const f of ['shellPid','agentPid'])if(!pid(e[f]))fail('INVALID_JOURNAL','Invalid '+f);
  for(const f of ['shellStartMs','agentStartMs','seenAt'])if(!time(e[f]))fail('INVALID_JOURNAL','Invalid '+f);
  for(const f of ['lostAt','offeredAt','sendingAt','sentAt'])if(e[f]!==undefined&&!time(e[f]))fail('INVALID_JOURNAL','Invalid '+f);
  for(const f of ['lostBy','reason','line','passId','claimKey'])if(e[f]!==undefined&&!text(e[f],2048))fail('INVALID_JOURNAL','Invalid '+f);
  if(e.createdMs!==undefined&&!time(e.createdMs))fail('INVALID_JOURNAL','Invalid createdMs');
  return e;
}
export function validateJournal(value){
  if(!plain(value)||value.v!==RESTART.version||!time(value.revision)||!plain(value.machines))fail('INVALID_JOURNAL','Invalid running-agents journal');
  if(value.lease!==null&&!(plain(value.lease)&&text(value.lease.owner)&&time(value.lease.expiresAt)))fail('INVALID_JOURNAL','Invalid lease');
  const keys=Object.keys(value.machines);if(keys.length>RESTART.machines)fail('INVALID_JOURNAL','Too many machines');
  for(const k of keys){
    const m=value.machines[k];if(!text(k,128)||!plain(m)||!time(m.observedAt)||!plain(m.terminals))fail('INVALID_JOURNAL','Invalid machine record');
    const addresses=Object.keys(m.terminals);if(addresses.length>RESTART.entriesPerMachine)fail('INVALID_JOURNAL','Too many entries');
    for(const a of addresses){if(!ADDRESS.test(a))fail('INVALID_JOURNAL','Invalid terminal address');entry(m.terminals[a]);}
  }
  return value;
}
/** Drops the least useful entries until the journal fits: skipped, then offered, then the oldest seen. */
function fit(draft){
  const rank={skipped:0,offered:1,sent:2,tracking:3,lost:4,sending:5};
  for(let guard=0;guard<5000&&JSON.stringify(draft).length>RESTART.bytes;guard++){
    let worst=null;for(const [k,m]of Object.entries(draft.machines))for(const [a,e]of Object.entries(m.terminals))if(!worst||rank[e.state]<rank[worst.e.state]||rank[e.state]===rank[worst.e.state]&&e.seenAt<worst.e.seenAt)worst={k,a,e};
    if(!worst)break;delete draft.machines[worst.k].terminals[worst.a];
  }
}
const isConflict=e=>['STALE','CONFLICT','EAGAIN'].includes(e?.code)||/stale|contents?.*changed|expected.*match|compare.and.set/i.test(e?.message||'');

/** appHome()/mission-control/running-agents.json with compare-and-set writes. */
export class RunningAgents {
  constructor(io,{clock=()=>Date.now()}={}){this.io=io;this.clock=clock;const home=typeof io.appHome==='function'?io.appHome():io.appHome;this.path=String(home).replace(/[/\\]+$/,'')+'/mission-control/running-agents.json';}
  /** {raw, value, status}: status "ok", "missing", "newer" (left untouched, feature idle) or "invalid" (kept aside). */
  async read(){
    const raw=await this.io.readTextFile(this.path);if(raw===null||raw===undefined)return {raw:null,value:emptyJournal(),status:'missing'};
    let parsed;try{parsed=JSON.parse(raw);}catch{return {raw,value:emptyJournal(),status:'invalid'};}
    if(plain(parsed)&&Number.isSafeInteger(parsed.v)&&parsed.v>RESTART.version)return {raw,value:null,status:'newer'};
    try{return {raw,value:validateJournal(parsed),status:'ok'};}catch{return {raw,value:emptyJournal(),status:'invalid'};}
  }
  /** fn(draft, now) returns {write:false} to skip the write, or any result. A newer journal is never written. */
  async edit(fn){
    for(let attempt=0;attempt<4;attempt++){
      const {raw,value,status}=await this.read();if(status==='newer')fail('NEWER_JOURNAL','running-agents.json was written by a newer Mission Control; it is left untouched');
      if(status==='invalid'&&raw!==null){const aside=this.path+'.invalid-'+this.clock();try{await this.io.writeTextFile(aside,raw,null);}catch{}}
      const draft=clone(value),now=this.clock(),result=fn(draft,now)||{};
      if(result.write===false&&status!=='invalid')return {value,result};
      draft.revision=(value.revision||0)+1;fit(draft);validateJournal(draft);
      await this.io.ensureDirectory?.(this.path.slice(0,this.path.lastIndexOf('/')));
      try{await this.io.writeTextFile(this.path,JSON.stringify(draft)+'\n',raw);return {value:draft,result};}
      catch(error){if(!isConflict(error)||attempt===3)throw error;}
    }
    fail('CONFLICT','running-agents.json kept changing');
  }
}

/** Takes or renews the observer lease. Returns false when another live owner holds it. */
export function takeLease(draft,owner,now){
  const l=draft.lease;if(l&&l.owner!==owner&&l.expiresAt>now)return false;
  if(!l||l.owner!==owner||l.expiresAt-now<RESTART.leaseMs/2)draft.lease={owner,expiresAt:now+RESTART.leaseMs};
  return true;
}
export function releaseLease(draft,owner){if(draft.lease?.owner!==owner)return {write:false};draft.lease=null;return {};}

/**
 * Applies one machine's observation. obs: {machine, ok, at, live:Set(address)|null, terminals:Map(address → t)}
 * with t: {createdMs, spaceId, tabId, shellPid, shellStartMs, foregroundIsShell, cwd, agent:null|{pid,startMs,provider,toolKey,sessionId,via}}.
 * ok:false (host offline, listing failed) changes nothing. Returns {lost, removed, added, changed}.
 */
export function observeMachine(draft,obs,{owner,now}){
  const key=machineKey(obs.machine),out={lost:[],removed:[],added:[],changed:false};if(!obs.ok)return out;
  const m=draft.machines[key]||(draft.machines[key]={observedAt:now,lastContinuousAt:now,terminals:{}});
  if(now-m.observedAt>=RESTART.seenRefreshMs){m.observedAt=now;out.changed=true;}
  const remove=(a,why)=>{delete m.terminals[a];out.removed.push({address:a,why});out.changed=true;};
  for(const [a,e]of Object.entries(m.terminals)){
    const t=obs.terminals.get(a);
    if(!t){if(obs.live&&!obs.live.has(a))remove(a,'closed');continue;}
    if(e.createdMs!==undefined&&t.createdMs!==undefined&&t.createdMs!==e.createdMs){remove(a,'replaced');continue;}
    const sameShell=t.shellPid===e.shellPid&&t.shellStartMs===e.shellStartMs;
    if(e.state==='tracking'){
      if(!sameShell){
        if(t.spaceId!==e.spaceId||t.tabId!==e.tabId){remove(a,'moved');continue;}
        Object.assign(e,{state:'lost',lostAt:now,lostBy:owner,shellPid:t.shellPid,shellStartMs:t.shellStartMs});out.lost.push(a);out.changed=true;continue;
      }
      if(t.spaceId!==e.spaceId||t.tabId!==e.tabId){e.spaceId=t.spaceId;e.tabId=t.tabId;out.changed=true;}
      const ag=t.agent;
      if(!ag||ag.pid!==e.agentPid||ag.startMs!==e.agentStartMs){remove(a,'quit');continue;}
      if(ag.sessionId&&ag.sessionId!==e.sessionId){e.sessionId=ag.sessionId;e.via=ag.via;out.changed=true;}
      if(t.cwd&&t.cwd!==e.cwd&&t.cwd.startsWith('/')){e.cwd=t.cwd;out.changed=true;}
      if(now-e.seenAt>=RESTART.seenRefreshMs){e.seenAt=now;out.changed=true;}
      continue;
    }
    // A loss no pass has handled yet follows the newest shell; after a pass, another loss ends the entry,
    // so a pass that typed nothing never types later.
    if(!sameShell){if(e.state==='lost'){Object.assign(e,{lostAt:now,lostBy:owner,shellPid:t.shellPid,shellStartMs:t.shellStartMs});out.changed=true;out.lost.push(a);}else remove(a,'restarted-again');continue;}
    if(e.state==='sent'){
      const ag=t.agent;
      if(ag&&ag.provider===e.provider){Object.assign(e,{state:'tracking',agentPid:ag.pid,agentStartMs:ag.startMs,seenAt:now,...(ag.sessionId?{sessionId:ag.sessionId,via:ag.via}:{})});for(const f of ['lostAt','lostBy','offeredAt','sendingAt','sentAt','reason','line','passId','claimKey'])delete e[f];out.changed=true;}
      else if(now-(e.sentAt??now)>=RESTART.graceMs)remove(a,'resume-ended');
      continue;
    }
    if(e.state==='offered'){if(!t.foregroundIsShell||now-(e.offeredAt??now)>=RESTART.offerMs)remove(a,t.foregroundIsShell?'offer-expired':'shell-used');continue;}
    if(e.state==='sending'&&now-(e.sendingAt??now)>=RESTART.sendingStaleMs){Object.assign(e,{state:'offered',offeredAt:now,reason:'The resume command was not confirmed as sent.'});out.changed=true;continue;}
    if(e.state==='skipped')remove(a,'skipped');
  }
  for(const [a,t]of obs.terminals){
    const ag=t.agent;if(m.terminals[a]||!ag||!ag.sessionId||!PROVIDERS.includes(ag.provider))continue;
    if(Object.keys(m.terminals).length>=RESTART.entriesPerMachine)break;
    if(!text(t.spaceId)||!text(t.tabId)||!text(t.cwd,4096)||!t.cwd.startsWith('/')||!pid(t.shellPid)||!time(t.shellStartMs)||!pid(ag.pid)||!time(ag.startMs))continue;
    m.terminals[a]={spaceId:t.spaceId,tabId:t.tabId,cwd:t.cwd,toolKey:ag.toolKey||ag.provider,provider:ag.provider,sessionId:ag.sessionId,via:ag.via,shellPid:t.shellPid,shellStartMs:t.shellStartMs,agentPid:ag.pid,agentStartMs:ag.startMs,seenAt:now,state:'tracking',...(time(t.createdMs)?{createdMs:t.createdMs}:{})};
    out.added.push(a);out.changed=true;
  }
  if(out.changed)m.lastContinuousAt=now;
  return out;
}

/** The default command form when a tool's verified capabilities are not available on that machine. */
export function fallbackArgv(provider,sessionId){return provider==='codex'?['codex','resume',sessionId]:[provider,'--resume',sessionId];}

/**
 * The outcome for one lost entry. The host-measured restored shell age limits automatic typing.
 * The saved agent's last-seen time does not: a laptop can remain powered off for hours after battery loss.
 * tool: {argv} when installed and exact resume is verified there, else {argv:null, reason}.
 */
export function decide(e,{t,preference,tool}){
  if(!preference.on)return {type:'skip',reason:preference.reason||'Resume after restart is turned off.'};
  const argv=tool?.argv||fallbackArgv(e.provider,e.sessionId);let line;try{line=resumeLine(argv);}catch{return {type:'skip',reason:'No safe resume command could be built.'};}
  const offer=(reason,{cd=false}={})=>({type:'offer',reason,line:(cd?cdPrefix(e.cwd):'')+line});
  if(!tool?.argv)return offer(tool?.reason||`${e.provider} is not installed or its exact resume is not verified on this machine.`);
  if(!t||!t.foregroundIsShell)return offer('The restored shell is already running something else.');
  if(!POSIX_SHELLS.has(base(t.shellName||'')))return offer(`The restored shell is ${t.shellName||'unknown'}, not a POSIX shell.`);
  if(t.cwd!==e.cwd)return offer('The restored shell is in another folder.',{cd:true});
  if(!Number.isSafeInteger(t.shellAgeMs))return offer('The restored shell’s age is unknown.');
  if(t.shellAgeMs>RESTART.typeWindowMs)return offer('The restored shell is more than 15 minutes old.');
  return {type:'type',reason:null,line};
}

export const claimKey=(address,e,{offer}={})=>[address,e.shellPid,e.shellStartMs].join('-')+(offer?'-offer-'+offer:'');
/** Marks an entry sending under a claim; false when its state moved on. */
export function markSending(draft,{machine,address,passId,claim,line,expect=['lost'],now}){
  const e=draft.machines[machineKey(machine)]?.terminals[address];if(!e||!expect.includes(e.state))return false;
  Object.assign(e,{state:'sending',sendingAt:now,passId,claimKey:claim,line});return true;
}
export function markOutcome(draft,{machine,address,state,reason,line,passId,now}){
  const e=draft.machines[machineKey(machine)]?.terminals[address];if(!e)return false;
  e.state=state;if(passId)e.passId=passId;if(line)e.line=line;if(reason)e.reason=reason;else delete e.reason;
  if(state==='sent')e.sentAt=now;if(state==='offered')e.offeredAt=now;return true;
}
export function dismiss(draft,{machine,address}){const m=draft.machines[machineKey(machine)];if(!m?.terminals[address])return {write:false};delete m.terminals[address];return {};}

/** Offers across machines for display: [{machine, address, spaceId, tabId, provider, line, reason}]. */
export function offers(value){
  const list=[];for(const [k,m]of Object.entries(value?.machines||{}))for(const [a,e]of Object.entries(m.terminals))if(e.state==='offered')list.push(freeze({machine:machineOf(k),address:a,spaceId:e.spaceId,tabId:e.tabId,provider:e.provider,sessionId:e.sessionId,cwd:e.cwd,line:e.line??resumeLine(fallbackArgv(e.provider,e.sessionId)),reason:e.reason??null}));
  return list;
}
