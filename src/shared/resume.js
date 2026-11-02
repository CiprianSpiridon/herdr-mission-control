import {canonicalRepoPath} from './config.js';
import {IdentityError,machineIdentity,sessionIdentity,sessionKey,localTerminalAddress,terminalIdentity,terminalKey} from './session-identity.js';
import {installedTools} from './launch-preferences.js';
import {CapabilityRegistry,buildArguments} from './tool-capabilities.js';
import {prepareWorktree} from './worktrees.js';
import {BindingStore} from './session-bindings.js';
import {NameOwnership} from './name-ownership.js';
import {launch,LaunchError} from './launch.js';
export class ResumeError extends Error {constructor(code,message,recovery){super(message);this.name='ResumeError';this.code=code;this.recovery=recovery;}}
const fail=(code,message,recovery)=>{throw new ResumeError(code,message,recovery);};
const freeze=v=>{if(v&&typeof v==='object'&&!Object.isFrozen(v)){for(const c of Object.values(v))freeze(c);Object.freeze(v);}return v;};
const text=(v,name,max=256)=>{if(typeof v!=='string'||!v||v.length>max||['__proto__','constructor','prototype'].includes(v)||/[\u0000-\u001f]/.test(v))fail('INVALID_RESUME',`Invalid ${name}`);return v;};
const now=io=>io.clock?io.clock():Date.now();
const digest=value=>{let a=2166136261,b=0x9e3779b9;for(let i=0;i<value.length;i++){const c=value.charCodeAt(i);a=Math.imul(a^c,16777619);b=Math.imul(b^c,2246822519);}return [a>>>0,b>>>0].map(n=>n.toString(16).padStart(8,'0')).join('');};
const prefix=session=>'resume-'+digest(sessionKey(session))+'-';
const base=v=>typeof v==='string'?v.slice(v.lastIndexOf('/')+1).toLowerCase():null;
const within=(path,root)=>path===root||path.startsWith(root.replace(/\/$/,'')+'/');
const strip=(id,on)=>on&&id.startsWith(on+'/')?id.slice(on.length+1):id;
const qualify=(id,on)=>typeof id==='string'&&id?(on?on+'/'+id:id):null;
const aliases={claude:['claude','claude-code'],codex:['codex'],grok:['grok']};
// Beyond Herdr's 30 s exec bound: an unacknowledged tab.new can no longer be in flight.
const UNCERTAIN_MS=60000;
const inFlight=(record,clock)=>record.ack?!['complete','failed'].includes(record.state)&&record.leaseUntil>clock:record.tabAttempted?clock<record.updatedAt+UNCERTAIN_MS:record.state!=='failed'&&record.leaseUntil>clock;
const actions={HOST_UNAVAILABLE:['retry'],SPACE_UNAVAILABLE:['retry'],TOOL_UNAVAILABLE:['retry'],TERMINAL_UNAVAILABLE:['retry'],RESUME_IN_PROGRESS:['retry'],PREVIOUS_SESSION_CLOSED:['retry'],WORKTREE_MISSING:['locate','retry'],CHECKOUT_MISMATCH:['locate','retry'],AMBIGUOUS_RUNNING_SESSION:['locate','retry-binding','close-existing-and-retry'],RECOVERY_REQUIRED:['locate','close-existing-and-retry'],MALFORMED_ACK:['locate','close-existing-and-retry'],TAB_CREATE_UNCERTAIN:['locate','close-existing-and-retry']};
const known=e=>e instanceof ResumeError||e instanceof LaunchError||e instanceof IdentityError||['ConfigError','WorktreeError','CapabilityError'].includes(e?.name);
function failure(code,message,recovery){const extra=recovery&&typeof recovery==='object'?recovery:{};return freeze({ok:false,code,message,recovery:{actions:extra.tabId?['locate','retry-binding']:actions[code]||[],...extra}});}
export function validateResumeRequest(value){
  if(!value||typeof value!=='object'||Array.isArray(value))fail('INVALID_RESUME','Missing resume request');
  let session,repoRoot,cwd;try{session=sessionIdentity(value.session);repoRoot=canonicalRepoPath(value.repoRoot);cwd=canonicalRepoPath(value.cwd);}catch(e){fail('INVALID_RESUME',e.message);}
  const r={requestId:text(value.requestId,'request ID'),spaceId:text(value.spaceId,'space ID'),session,machine:session.machine,repoRoot,cwd,toolKey:text(value.toolKey??session.provider,'tool key',96)};
  if(value.originId!==undefined)r.originId=text(value.originId,'origin ID');
  if(value.title!==undefined)r.title=text(value.title,'reported title',200);
  return freeze(r);
}
/** Labels history rows before any click. Only verified exact-ID resume qualifies; --last/--continue never do. */
export function resumeSupport(capabilities,{provider,machine}={}){
  const no=reason=>freeze({supported:false,kind:null,reason});
  if(!capabilities?.base||!capabilities.provider)return no('Exact resume is unsupported: the installed command was not verified by its own help output.');
  if(machine!==undefined&&capabilities.machine!==machineIdentity(machine))return no('Exact resume was verified on a different host than the one that owns this session.');
  if(provider!==undefined&&capabilities.provider!==provider)return no('The installed tool is not the provider that owns this session. Start a new session to switch tools.');
  if(!capabilities.resume)return no('This installed tool/version has no verified exact-session resume.');
  return freeze({supported:true,kind:capabilities.resume.kind,reason:null});
}
async function journal(io){
  const home=typeof io.appHome==='function'?io.appHome():io.appHome,raw=await io.readTextFile(home.replace(/\/$/,'')+'/mission-control/launches.json');
  if(raw===null)return {};let value=null;try{value=JSON.parse(raw);}catch{}
  if(value?.v!==1||!value.requests||typeof value.requests!=='object'||Array.isArray(value.requests))fail('INVALID_JOURNAL','Launch journal is invalid; original preserved and nothing was started');
  return value.requests;
}
function attempts(requests,session){
  const p=prefix(session),key=sessionKey(session),found=[];
  for(const record of Object.values(requests)){
    const id=record?.request?.idempotencyKey;if(typeof id!=='string'||!id.startsWith(p)||!/^(0|[1-9]\d{0,8})$/.test(id.slice(p.length)))continue;
    if(record.sessionProposal&&sessionKey(record.sessionProposal)!==key)fail('RESUME_CONFLICT','Saved resume state belongs to a different exact session; nothing was started');
    found.push({epoch:Number(id.slice(p.length)),record});
  }
  return found.sort((a,b)=>b.epoch-a.epoch);
}
async function full(io,address,on){
  const local=localTerminalAddress(address,on);let result;
  try{result=await io.exec('hc',['get',local,'--json'],{on});}catch{fail('HOST_UNAVAILABLE','The original host became unreachable while checking live terminals; nothing was started');}
  if(result?.code!==0)return null;
  try{const raw=JSON.parse(result.stdout);if(localTerminalAddress(raw.address,on)!==local)throw Error('address');return {raw,identity:terminalIdentity(raw,on)};}catch{fail('TERMINAL_UNAVAILABLE','A live terminal returned invalid identity data; nothing was started');}
}
async function commonDir(io,cwd,on){let r;try{r=await io.exec('git',['rev-parse','--path-format=absolute','--git-common-dir'],{cwd,on});}catch{return undefined;}if(r.code!==0)return null;try{return canonicalRepoPath(r.stdout.trim());}catch{return null;}}
async function sameRepo(io,r,cwd,cache){
  // Unknown or unreadable folders stay plausible: this check can only block a resume, never bind one.
  if(typeof cwd!=='string')return true;let path;try{path=canonicalRepoPath(cwd);}catch{return true;}
  if(within(path,r.repoRoot)||within(path,r.cwd))return true;
  if(!cache.has(r.repoRoot))cache.set(r.repoRoot,await commonDir(io,r.repoRoot,r.machine));
  const repo=cache.get(r.repoRoot),other=await commonDir(io,path,r.machine);
  return repo===undefined||other===undefined||other!==null&&other===repo;
}
async function inspectHost(io,r,{tool,bindings,found,terminals}){
  const on=r.machine,key=sessionKey(r.session);
  for(const [requestId,b]of Object.entries(bindings.proposals))if(b.state==='committed'&&b.session&&sessionKey(b.session)===key&&b.ack.terminal.machine===on){
    // hc keeps finished terminals until removal; only a live bound generation can be focused.
    const actual=await full(io,b.ack.terminal.address,on);
    if(actual&&(actual.raw.state===undefined||actual.raw.state==='live')&&terminalKey(actual.identity)===terminalKey(b.ack.terminal))return {exact:{requestId,originId:b.originId,tabId:b.ack.tabId,terminal:actual.identity}};
  }
  const names=new Set([...(aliases[r.session.provider.toLowerCase()]||[r.session.provider.toLowerCase()]),...(tool?[base(tool.run[0])]:[])]),agents=new Map(),pending=new Map(),own=[],candidates=[],cache=new Map();
  for(const a of io.agents?.()||[]){const space=io.spaces().find(s=>s.id===a.space);if(space&&machineIdentity(space.machine)===on)try{agents.set(localTerminalAddress(a.address,on),a);}catch{}}
  for(const {record}of found)if(record.ack&&!['complete','failed'].includes(record.state))try{pending.set(localTerminalAddress(record.ack.terminal,on),record);}catch{}
  for(const summary of terminals){
    let local,actual=null;try{local=localTerminalAddress(summary?.address,on);}catch{continue;}
    if(summary.state!==undefined&&summary.state!=='live')continue;
    try{if(Number.isSafeInteger(summary.created_ms)&&summary.foreground!==undefined)actual={raw:summary,identity:terminalIdentity(summary,on)};}catch{}
    actual=actual||await full(io,local,on);if(!actual)continue;
    const fg=actual.raw.foreground||{},agent=agents.get(local),labels=actual.raw.labels||{};
    if(![fg.name,base(fg.argv?.[0]),base(fg.argv?.[1]),agent?.app,agent?.program?.key].some(v=>typeof v==='string'&&names.has(v.toLowerCase())))continue;
    // Our own acknowledged resume of this exact session: launch can still prove it from its captured argv.
    const mine=pending.get(local);if(mine&&labels['herdr.tab']===strip(mine.ack.tab,on)){own.push(mine);continue;}
    const id=bindings.terminals[terminalKey(actual.identity)];if(id&&bindings.proposals[id]?.session)continue;
    if(!await sameRepo(io,r,fg.cwd??actual.raw.cwd,cache))continue;
    candidates.push({machine:on,terminal:actual.identity.address,tabId:qualify(labels['herdr.tab'],on),spaceId:qualify(labels['herdr.space'],on)});
  }
  return {exact:null,own,candidates};
}
async function verifyCheckout(io,r){
  try{await prepareWorktree({requestId:r.requestId,originId:'resume-check',worktree:false,machine:r.machine,repoRoot:r.repoRoot,checkoutRoot:r.cwd},{exec:io.exec});}
  catch(error){if(error?.name==='WorktreeError')throw error;fail('WORKTREE_MISSING','The original repository or working directory is missing on its host. Locate it, then retry; the saved session is unchanged.');}
}
function choose(r,found,own,requests,clock){
  const p=prefix(r.session),byId=requests[r.requestId],busy=()=>fail('RESUME_IN_PROGRESS','This exact session is already being resumed; wait for its acknowledgment.');
  if(byId){if(typeof byId.request?.idempotencyKey!=='string'||!byId.request.idempotencyKey.startsWith(p))fail('RETRY_CHANGED','This resume request ID already belongs to different work');return {key:byId.request.idempotencyKey,originId:byId.request.originId};}
  if(own.length){if(own[0].leaseUntil>clock)busy();return {takeover:own[0].request};}
  const latest=found[0];if(!latest)return {key:p+'0'};
  // Acknowledged attempts reach here only after their exact terminal closed or stopped running the provider.
  if(!latest.record.ack&&inFlight(latest.record,clock))busy();
  return {key:p+(latest.epoch+1)};
}
async function owner(names,r){
  const exact=await names.find({session:r.session});if(exact)return exact.originId;
  const given=r.originId?await names.find({originId:r.originId}):null;
  return r.originId&&!(given?.session&&sessionKey(given.session)!==sessionKey(r.session))?r.originId:'session-'+digest(sessionKey(r.session));
}
export async function resume(input,io){
  try{
    const r=validateResumeRequest(input),on=r.machine,clock=now(io);
    if(typeof io.machines==='function'&&io.machines().find(m=>machineIdentity(m.name)===on)?.layout!=='ready')fail('HOST_UNAVAILABLE',`${on??'This computer'} is offline or still loading; nothing was started.`);
    const space=io.spaces().find(s=>s.id===r.spaceId);if(!space)fail('SPACE_UNAVAILABLE','The destination space is no longer open; nothing was started.');
    if(machineIdentity(space.machine)!==on)fail('WRONG_HOST','This session belongs to another host and is only resumed on its original host.');
    let tools,requests,found,live;try{tools=installedTools(await io.knownAgents({on}));}catch{fail('HOST_UNAVAILABLE','The original host could not report its installed tools; nothing was started.');}
    const tool=tools.find(t=>t.key===r.toolKey)||null;
    // Journal, then bindings, then live terminals: launch commits a binding before completing its journal
    // entry, so a stale snapshot can only make a live terminal look unbound (blocking), never absent.
    // A blocking candidate gets one fresh look in case a concurrent resume just committed its proof.
    for(let pass=0;pass<2&&!live?.exact&&(!live||live.candidates.length);pass++){
      requests=await journal(io);found=attempts(requests,r.session);const bindings=(await new BindingStore(io,{clock:()=>now(io)}).read()).value;
      let listing=null,terminals=null;try{listing=await io.exec('hc',['ls','--json'],{on});}catch{}
      try{if(listing?.code===0)terminals=JSON.parse(listing.stdout).terminals;}catch{}
      if(!Array.isArray(terminals))fail('HOST_UNAVAILABLE','The original host could not list its live terminals; nothing was started.');
      if(terminals.length>1000)fail('HOST_UNAVAILABLE','The original host has too many live terminals to verify safely; nothing was started.');
      live=await inspectHost(io,r,{tool,bindings,found,terminals});
    }
    if(live.exact){io.run('agent.focus',{terminal:live.exact.terminal.address});return freeze({ok:true,action:'focus',tabId:live.exact.tabId,terminalId:live.exact.terminal.address,reused:true,originId:live.exact.originId,session:r.session});}
    if(live.candidates.length){
      if(found.some(({record})=>inFlight(record,clock)))fail('RESUME_IN_PROGRESS','This exact session is already being resumed; wait for its acknowledgment.');
      fail('AMBIGUOUS_RUNNING_SESSION',`A running ${r.session.provider} terminal in this repository has no exact session binding. Locate it, retry its binding, or close it and retry; nothing was resumed.`,{candidates:live.candidates});
    }
    if(!tool)fail('TOOL_UNAVAILABLE','The session tool is not installed on its original host.');
    const caps=io.capabilities?await io.capabilities.get(tool,on):await new CapabilityRegistry(io.exec).get(tool,on),support=resumeSupport(caps,{provider:r.session.provider,machine:on});
    if(!support.supported)fail('UNSUPPORTED_RESUME',support.reason);
    buildArguments(caps,{resumeSessionId:r.session.sessionId});
    if(typeof io.sessionSource==='function'){const source=await io.sessionSource(r.session.provider,on);if(source&&(source.providerRoot!==r.session.providerRoot||source.credentialScope!==r.session.credentialScope))fail('ACCOUNT_MISMATCH','This session belongs to a different provider profile than the one enabled on its host; nothing was started.');}
    await verifyCheckout(io,r);
    const choice=choose(r,found,live.own,requests,clock),names=new NameOwnership(io,{clock:()=>now(io)});
    const request=choice.takeover?{...choice.takeover}:{requestId:r.requestId,idempotencyKey:choice.key,originId:choice.originId||await owner(names,r),spaceId:r.spaceId,machine:on,repoRoot:r.repoRoot,checkoutRoot:r.cwd,toolKey:r.toolKey,worktree:false};
    const result=await launch(request,{...io,exactResumeSession:r.session});
    if(!result.ok)return result.code==='LAUNCH_BUSY'?failure('RESUME_IN_PROGRESS','This exact session is already being resumed; wait for its acknowledgment.'):failure(result.code,result.message,result.recovery);
    // Launch already transferred a captured manual name; this only replaces the tool-name placeholder.
    if(!result.reused&&r.title)try{await names.applyName(result.originId,r.title,{getTabs:()=>io.spaces().flatMap(s=>s.tabs.map(t=>({...t,machine:s.machine}))),rename:args=>io.run('tab.rename',args)});}catch{}
    return freeze({ok:true,action:result.reused?'focus':'resume',tabId:result.tabId,terminalId:result.terminalId,folder:result.folder,reused:result.reused,originId:result.originId,session:result.session});
  }catch(error){
    return failure(error?.code||'RESUME_FAILED',known(error)?error.message:'Resume could not complete; the saved session identity was preserved.',error?.recovery);
  }
}
