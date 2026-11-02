import {ConfigError} from './config.js';
import {sessionIdentity,sessionKey,terminalKey,terminalIdentity,machineIdentity} from './session-identity.js';
const clone=v=>JSON.parse(JSON.stringify(v));
const fail=(code,message)=>{throw new ConfigError(code,message);};
const text=(v,label,max=256)=>{if(typeof v!=='string'||!v||v.length>max||['__proto__','prototype','constructor'].includes(v)||/[\u0000-\u001f]/.test(v))fail('INVALID_BINDING',`Invalid ${label}`);return v;};
const time=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
const bytes=value=>{let n=0;for(const c of value){const p=c.codePointAt(0);n+=p<128?1:p<2048?2:p<65536?3:4;}return n;};
const empty=()=>({v:1,revision:0,proposals:{},terminals:{}});
const proofKinds=new Set(['caller-session-id','resume-argv','pid-open-file','provider-handshake']);
const conflict=e=>['STALE','CONFLICT','EAGAIN'].includes(e?.code)||/stale|contents?.*changed|expected.*match|compare.and.set/i.test(e?.message||'');
function validateAck(ack){text(ack?.tabId,'acknowledged tab ID');terminalKey(ack?.terminal);return clone(ack);}
function validateProof(proof,session,terminal){
  if(!proof||!proofKinds.has(proof.kind)||!time(proof.observedAt)||typeof proof.sourceDigest!=='string'||!proof.sourceDigest||proof.sourceDigest.length>512)fail('UNPROVEN_SESSION','Exact provider-session evidence is required');
  if(!proof.session||sessionKey(proof.session)!==sessionKey(session)||terminalKey(proof.terminal)!==terminalKey(terminal)||session.machine!==terminal.machine)fail('UNPROVEN_SESSION','Session proof does not match the exact host/session/terminal generation');
  return clone(proof);
}
function indexes(d){const result={};for(const [id,r]of Object.entries(d.proposals))if(r.state==='committed'){
  const key=terminalKey(r.ack.terminal);if(result[key])fail('BINDING_CONFLICT','A terminal generation cannot belong to two work origins');result[key]=id;
}d.terminals=result;return d;}
export function validateBindingStore(value){
  if(!value||value.v!==1||!Number.isSafeInteger(value.revision)||value.revision<0||!value.proposals||!value.terminals||Array.isArray(value.proposals)||Array.isArray(value.terminals))fail('INVALID_BINDING','Invalid binding store; original preserved');
  const d=clone(value);
  for(const [id,r]of Object.entries(d.proposals)){
    text(id,'request ID');text(r.originId,'origin ID');
    if(!['proposed','commit-pending','committed','invalidated'].includes(r.state)||!time(r.createdAt)||!time(r.updatedAt)||r.updatedAt<r.createdAt)fail('INVALID_BINDING','Invalid binding state/timestamps');
    if(r.session!==null)r.session=sessionIdentity(r.session);
    if(r.state==='proposed'||r.state==='commit-pending'){if(!time(r.expiresAt)||r.expiresAt<r.createdAt||r.invalidatedAt!==null)fail('INVALID_BINDING','Uncommitted proposal needs its own TTL');}
    else if(r.expiresAt!==null)fail('INVALID_BINDING','Committed/invalidated records do not expire by age');
    if(r.state==='invalidated'){if(!time(r.invalidatedAt)||r.invalidatedAt<r.createdAt||r.invalidatedAt>r.updatedAt)fail('INVALID_BINDING','Invalid first-invalidation timestamp');}
    else if(r.invalidatedAt!==null)fail('INVALID_BINDING','Unexpected invalidation timestamp');
    if(r.state==='committed'||r.state==='commit-pending'){validateAck(r.ack);if(r.session)validateProof(r.proof,r.session,r.ack.terminal);}
    else if(r.ack)validateAck(r.ack);
  }
  const expected=indexes(clone(d)).terminals;
  if(Object.keys(expected).length!==Object.keys(d.terminals).length||Object.entries(expected).some(([k,id])=>d.terminals[k]!==id))fail('INVALID_BINDING','Terminal index does not match retained committed records');
  return d;
}
export function pruneBindings(draft,now,{recoveryRecorded=[]}={}){
  const recovered=new Set(recoveryRecorded);
  for(const [id,r]of Object.entries(draft.proposals))if(['proposed','commit-pending'].includes(r.state)&&r.expiresAt<=now&&recovered.has(id))delete draft.proposals[id];
  const invalid=Object.entries(draft.proposals).filter(([,r])=>r.state==='invalidated').sort(([a,x],[b,y])=>x.invalidatedAt-y.invalidatedAt||(a<b?-1:a>b?1:0));
  for(const [id]of invalid.slice(0,Math.max(0,invalid.length-100)))delete draft.proposals[id];
  return indexes(draft);
}
function capacity(d){if(Object.keys(d.proposals).length>500||bytes(JSON.stringify(d))>768*1024)fail('BINDING_CAPACITY','Session binding storage is full. Reconcile closed terminals or archive recovered requests; active mappings were preserved.');}
export function argvSessionProof({capabilities,session,terminal,argv,kind,observedAt,sourceDigest}){
  const s=sessionIdentity(session);terminalKey(terminal);
  if(capabilities?.machine!==s.machine||capabilities.provider!==s.provider||!Array.isArray(argv)||!Array.isArray(capabilities.run)||!capabilities.run.every((v,i)=>argv[i]===v))fail('UNPROVEN_SESSION','Launch command/provider/host does not match session evidence');
  let marker;
  if(kind==='caller-session-id')marker=capabilities.callerSession;
  else if(kind==='resume-argv')marker=capabilities.resume?.kind==='command'?capabilities.resume.command:capabilities.resume?.flag;
  else fail('UNPROVEN_SESSION','This proof requires caller-assigned or exact resume argv');
  const at=marker?argv.indexOf(marker,capabilities.run.length):-1;
  if(at<0||argv[at+1]!==s.sessionId||argv.includes('--last')||argv.includes('--continue'))fail('UNPROVEN_SESSION','The exact session ID is absent from verified launch argv');
  return validateProof({kind,session:s,terminal:clone(terminal),observedAt,sourceDigest},s,terminal);
}
export function processSessionProof({session,terminal,evidence,observedAt,sourceDigest}){
  const s=sessionIdentity(session);terminalKey(terminal);
  if(evidence?.machine!==s.machine||terminal.machine!==s.machine||!terminal.foregroundPid||!Array.isArray(evidence.processes)||!Array.isArray(evidence.files))fail('UNPROVEN_SESSION','Exact foreground process evidence is unavailable');
  const descendants=new Set([terminal.foregroundPid]);let changed=true;
  while(changed){changed=false;for(const p of evidence.processes)if(Number.isSafeInteger(p.pid)&&descendants.has(p.parentPid)&&!descendants.has(p.pid)){descendants.add(p.pid);changed=true;}}
  const matches=evidence.files.filter(f=>descendants.has(f.pid)&&typeof f.path==='string'&&f.path.startsWith(s.providerRoot.replace(/\/$/,'')+'/')&&!f.path.split('/').includes('..')&&f.session);
  const identities=new Set(matches.map(f=>sessionKey(f.session)));
  if(identities.size!==1||!identities.has(sessionKey(s)))fail('UNPROVEN_SESSION','Process files do not uniquely identify this provider session');
  return validateProof({kind:'pid-open-file',session:s,terminal:clone(terminal),observedAt,sourceDigest},s,terminal);
}
export class BindingStore {
  constructor(io,{clock=()=>Date.now()}={}){this.io=io;this.clock=clock;const root=typeof io.appHome==='function'?io.appHome():io.appHome;this.path=root.replace(/\/$/,'')+'/mission-control/session-bindings.json';}
  now(){const n=this.clock();if(!time(n))fail('INVALID_CLOCK','The binding clock is unavailable');return n;}
  async read(){const raw=await this.io.readTextFile(this.path);if(raw===null)return {raw,value:empty()};if(typeof raw!=='string'||bytes(raw)>768*1024)fail('BINDING_CAPACITY','Binding file exceeds its supported size');let data;try{data=JSON.parse(raw);}catch{fail('INVALID_BINDING','Binding JSON is invalid; original preserved');}const value=validateBindingStore(data);capacity(value);return {raw,value};}
  async edit(edit,{recoveryRecorded=[]}={}){
    for(let attempt=0;attempt<4;attempt++){
      const {raw,value}=await this.read(),draft=clone(value),now=this.now();pruneBindings(draft,now,{recoveryRecorded});
      const result=edit(draft,now);pruneBindings(draft,now,{recoveryRecorded});draft.revision++;if(!Number.isSafeInteger(draft.revision))fail('BINDING_CAPACITY','Binding revision exhausted');
      const next=validateBindingStore(indexes(draft));capacity(next);await this.io.ensureDirectory?.(this.path.slice(0,this.path.lastIndexOf('/')));
      try{await this.io.writeTextFile(this.path,JSON.stringify(next)+'\n',raw);return {value:next,result};}catch(e){if(!conflict(e))throw e;}
    }fail('CONFLICT','Binding state changed repeatedly; retry the acknowledged commit without launching again');
  }
  async propose({requestId,originId,session=null},{recoveryRecorded=[]}={}){
    text(requestId,'request ID');text(originId,'origin ID');const exact=session?sessionIdentity(session):null;
    return (await this.edit((d,now)=>{
      const old=d.proposals[requestId];
      if(old){if(old.originId!==originId||JSON.stringify(old.session)!==JSON.stringify(exact))fail('BINDING_CONFLICT','A request cannot change its origin or exact session');if(old.state==='invalidated'||(['proposed','commit-pending'].includes(old.state)&&old.expiresAt<=now))fail('RECOVERY_REQUIRED','The interrupted request needs recovery; do not launch it again');return clone(old);}
      const record={originId,session:exact,state:'proposed',createdAt:now,updatedAt:now,invalidatedAt:null,expiresAt:now+300000};d.proposals[requestId]=record;return clone(record);
    },{recoveryRecorded})).result;
  }
  async transition(requestId,ack,proof,{pending=false,session}={}){
    validateAck(ack);const exact=session?sessionIdentity(session):null;
    return (await this.edit((d,now)=>{
      const r=d.proposals[requestId];if(!r||r.state==='invalidated')fail('RECOVERY_REQUIRED','No active proposal exists for this acknowledged launch');
      if(r.state!=='committed'&&r.expiresAt<=now)fail('RECOVERY_REQUIRED','Acknowledged launch proposal expired; retain it for explicit recovery');
      if(now<r.updatedAt)fail('INVALID_CLOCK','The binding clock moved backwards');
      const selected=r.session||exact;if(r.session&&exact&&sessionKey(r.session)!==sessionKey(exact))fail('BINDING_CONFLICT','A committed request cannot change provider sessions');
      if(selected)validateProof(proof,selected,ack.terminal);
      if(r.ack&&(r.ack.tabId!==ack.tabId||terminalKey(r.ack.terminal)!==terminalKey(ack.terminal)))fail('BINDING_CONFLICT','Acknowledgment belongs to a different tab/terminal generation');
      if(r.state==='committed'&&r.session&&selected&&sessionKey(r.session)===sessionKey(selected))return clone(r);
      if(r.state==='committed'&&pending)return clone(r);
      r.session=selected||null;r.state=pending?'commit-pending':'committed';r.updatedAt=now;r.expiresAt=pending?r.expiresAt:null;r.ack=clone(ack);if(selected)r.proof=clone(proof);return clone(r);
    })).result;
  }
  commitAcknowledged(requestId,ack,proof,options){return this.transition(requestId,ack,proof,options);}
  markCommitPending(requestId,ack,proof,options={}){return this.transition(requestId,ack,proof,{...options,pending:true});}
  async readCommitted(terminal){const {value}=await this.read(),id=value.terminals[terminalKey(terminal)],r=id?value.proposals[id]:null;return r?.state==='committed'&&r.session?{requestId:id,...clone(r)}:null;}
  async requestState(requestId){const {value}=await this.read(),r=value.proposals[requestId];return r?{...clone(r),recoveryRequired:['proposed','commit-pending'].includes(r.state)&&r.expiresAt<=this.now()}:null;}
  async invalidate(requestId,reason='Exact generation/source no longer valid'){
    text(reason,'invalidation reason',512);return (await this.edit((d,now)=>{const r=d.proposals[requestId];if(!r)return null;if(now<r.updatedAt)fail('INVALID_CLOCK','The binding clock moved backwards');r.invalidatedAt=r.invalidatedAt??now;r.updatedAt=now;r.state='invalidated';r.expiresAt=null;r.reason=reason;return clone(r);})).result;
  }
  async reconcile(raws,{machine=null,available=true,authoritative=false,enabledSources=null}={}){
    const on=machineIdentity(machine);if(!available)return {invalidated:[],offline:true};
    const generations=new Map();for(const raw of raws){const identity=terminalIdentity(raw,on);generations.set(identity.address,identity);}
    return (await this.edit((d,now)=>{const invalidated=[];
      for(const [id,r]of Object.entries(d.proposals)){
        if(r.state!=='committed'||r.ack.terminal.machine!==on)continue;
        const actual=generations.get(r.ack.terminal.address),changed=actual&&terminalKey(actual)!==terminalKey(r.ack.terminal),missing=!actual&&authoritative;
        const disabled=r.session&&enabledSources&&!enabledSources.some(s=>s.machine===r.session.machine&&s.provider===r.session.provider&&s.credentialScope===r.session.credentialScope&&s.providerRoot===r.session.providerRoot);
        if(changed||missing||disabled){if(now<r.updatedAt)fail('INVALID_CLOCK','The binding clock moved backwards');r.state='invalidated';r.invalidatedAt=r.invalidatedAt??now;r.updatedAt=now;r.expiresAt=null;r.reason=disabled?'Source disabled or profile/root changed':changed?'Terminal generation or foreground PID changed':'Terminal closed';invalidated.push(id);}
      }return {invalidated,offline:false};
    })).result;
  }
  async garbageCollect(options={}){return (await this.edit(()=>null,options)).value;}
  async invalidateSources(enabledSources){
    return (await this.edit((d,now)=>{const invalidated=[];for(const [id,r]of Object.entries(d.proposals)){
      if(r.state==='invalidated'||!r.session||enabledSources.some(s=>s.machine===r.session.machine&&s.provider===r.session.provider&&s.credentialScope===r.session.credentialScope&&s.providerRoot===r.session.providerRoot))continue;
      if(now<r.updatedAt)fail('INVALID_CLOCK','The binding clock moved backwards');r.state='invalidated';r.invalidatedAt=r.invalidatedAt??now;r.updatedAt=now;r.expiresAt=null;r.reason='Source disabled or changed';invalidated.push(id);
    }return invalidated;})).result;
  }
}
