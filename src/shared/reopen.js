import {machineIdentity,localTerminalAddress,IdentityError} from './session-identity.js';
import {resume,ResumeError} from './resume.js';
import {verifyTabAcknowledgement,LaunchError} from './launch.js';
import {NameOwnership} from './name-ownership.js';
import {BindingStore} from './session-bindings.js';
import {resolveSpaceRepo} from './space-repo.js';
import {ClosedJournal,ClosedWatcher,ClosedTabsError,LIMITS,importClosedHistory,displayText,snapshotWorld} from './closed-tabs.js';

export class ReopenError extends Error {constructor(code,message,recovery,{uncertain=false}={}){super(message);this.name='ReopenError';this.code=code;if(recovery)this.recovery=recovery;this.uncertain=uncertain;}}
const fail=(code,message,recovery,options)=>{throw new ReopenError(code,message,recovery,options);};
const clone=v=>JSON.parse(JSON.stringify(v));
const freeze=v=>{if(v&&typeof v==='object'&&!Object.isFrozen(v)){for(const c of Object.values(v))freeze(c);Object.freeze(v);}return v;};
const clockOf=io=>io.clock?io.clock():Date.now();
const safeMachine=v=>{try{return machineIdentity(v);}catch{return undefined;}};
const where=on=>on??'this computer';
export const REOPEN_KINDS=Object.freeze(['tab','agent']);
/** Commands a standalone copy or a bundling tab bar routes to these actions. No default keys are bound. */
export const REOPEN_COMMANDS=Object.freeze({'reopen-tab':'tab','reopen-agent':'agent'});
/** Shown verbatim in help so the restore contract is visible before a click. */
export const REOPEN_LIMITATIONS=Object.freeze([
  'Reopen last tab restores the most recently closed tab in its original space on its original machine. Reopen last agent does the same for the most recently closed agent and skips shell-only tabs.',
  'A shell reopens in the folder it started in, not its last cd. Its old command is never run again.',
  'An agent reopens only through its exact saved session ID on the same machine and provider profile (for example claude --resume <id>). --last and --continue are never guessed. An agent without an exact session cannot be resumed; Reopen last tab opens a shell in its folder instead.',
  'If the closed tab was the last one in its space, the space is recreated from its saved folder on the same machine, only after that folder is verified there.',
  'Split layout, extra panes and mod panes are not recorded; only the main terminal comes back.',
  'Closes are recorded every 2 seconds while this bar or the Mission Control tab bar is running. Closes while a machine is offline, or while Herdr is closed, are not recorded. Older history can be imported from herdr-core; partial imports are labelled and their order is unverified.',
  'The last 100 closed tabs are kept in mission-control/closed.json in the Herdr app folder: names, titles, folders and program names only, never command arguments.',
  'A manual tab name returns with its tab; automatic names stay automatic.',
  'Commands: mission-control-reopen.reopen-tab, mission-control-reopen.reopen-agent and mission-control-reopen.open. No keys are bound by default; add your own in keys.json. Commands reach a shown copy of this mod only.'
]);
const actions={NOTHING_TO_REOPEN:['import-history'],HISTORY_PARTIAL:['choose','import-history'],REOPEN_IN_PROGRESS:['retry'],RECORD_GONE:[],HOST_UNAVAILABLE:['retry'],SPACE_UNAVAILABLE:['retry'],FOLDER_MISSING:['retry'],WORKTREE_MISSING:['locate','retry'],FOLDER_UNKNOWN:[],NO_EXACT_SESSION:[],TAB_CREATE_UNCERTAIN:['locate','retry-uncertain'],MALFORMED_ACK:['locate','retry-uncertain'],REOPEN_FAILED:['retry'],CLAIM_LOST:['retry'],CONFLICT:['retry'],PREVIOUS_RESTORE_CLOSED:[],INVALID_CLOSED:[],INVALID_REOPEN:[]};
const terminal=new Set(['RECORD_GONE','REOPEN_IN_PROGRESS','PREVIOUS_RESTORE_CLOSED','INVALID_CLOSED']);
const known=e=>e instanceof ReopenError||e instanceof ClosedTabsError||e instanceof ResumeError||e instanceof LaunchError||e instanceof IdentityError||['ConfigError','WorktreeError','CapabilityError'].includes(e?.name);
function failure(code,message,recovery){
  const extra=recovery&&typeof recovery==='object'?clone(recovery):{},list=[...(extra.actions||actions[code]||[])];
  if(extra.recordId&&!terminal.has(code)&&!list.includes('dismiss'))list.push('dismiss');
  return freeze({ok:false,code,message,recovery:{...extra,actions:list}});
}
const meaningful=v=>{const s=displayText(v,120);return s&&!/^\d+$/.test(s)&&!/^[/~]/.test(s)?s:null;};
/** Display title only. Never an identity. */
export function recordTitle(r){
  const t=r.terminals.find(x=>x.session)||r.terminals.find(x=>x.agent)||r.terminals[0];
  return displayText(r.origin?.mode==='manual'?r.origin.manualName:null,120)||(r.tab.named?displayText(r.tab.name,120):null)||meaningful(t?.title)||t?.program?.name||(r.kind==='agent'?'Agent':'Shell');
}
export const recordDestination=r=>[r.space.name||'Closed space',r.machine||'This Mac'].join(' · ');
const eligible=(r,kind)=>kind==='tab'||r.kind==='agent';
const empty={tab:'No closed tab has been recorded yet. Tabs closed while this bar or the Mission Control tab bar is running appear here.',agent:'No closed agent has been recorded yet. Shell-only tabs are skipped.'};
/** Observed/confirmed order decides "last". Imported history counts only when its scan was complete. */
export function selectRecord(value,kind,{now=Date.now()}={}){
  if(!REOPEN_KINDS.includes(kind))return {error:['INVALID_REOPEN','Choose Reopen last tab or Reopen last agent.']};
  const records=(value?.records||[]).filter(r=>eligible(r,kind));
  let record=records.filter(r=>r.source!=='imported').sort((a,b)=>b.seq-a.seq)[0];
  if(!record){
    const imported=records.filter(r=>r.source==='imported');if(!imported.length)return {error:['NOTHING_TO_REOPEN',empty[kind]]};
    if(imported.some(r=>!r.ordered))return {error:['HISTORY_PARTIAL','Only partial older history was imported, so the most recently closed tab is not known. Choose one from the list.']};
    record=[...imported].sort((a,b)=>b.closedAt-a.closedAt)[0];
  }
  if(record.claim&&record.claim.until>now)return {record,error:['REOPEN_IN_PROGRESS','This closed tab is already being reopened; wait for it to appear.']};
  return {record};
}
/** How a record is restored for an action: exact agent resume, or a shell in its starting folder. */
export function restorePlan(record,kind='tab'){
  const exact=record.terminals.find(t=>t.session),notices=record.panes>1?['panes-not-restored']:[];
  if(kind==='agent'){
    if(record.kind!=='agent')fail('NOT_AN_AGENT','This closed tab ran no agent. Use Reopen last tab.');
    if(!exact)fail('NO_EXACT_SESSION','This agent was not started with an exact session ID, so it cannot be resumed without guessing. Reopen last tab opens a shell in its folder instead, or forget it.');
  }
  if(exact)return {mode:'agent',terminal:exact,notices};
  return {mode:'shell',terminal:record.terminals[0],notices:[...(record.kind==='agent'?['agent-not-resumed']:[]),...notices]};
}
export function reopenPreview(value,kind,{now=Date.now()}={}){
  const base={kind,label:kind==='agent'?'Reopen last agent':'Reopen last tab',recordId:null,title:null,detail:null,imported:false,reason:null,lastError:null};
  if(!value)return freeze({...base,state:'loading',reason:'Reading closed tabs…'});
  const choice=selectRecord(value,kind,{now});
  if(choice.error&&!choice.record)return freeze({...base,state:choice.error[0]==='HISTORY_PARTIAL'?'partial':'empty',reason:choice.error[1]});
  const r=choice.record,preview={...base,state:'ready',recordId:r.id,title:recordTitle(r),detail:recordDestination(r),imported:r.source==='imported',lastError:r.error?.message??null};
  if(choice.error)return freeze({...preview,state:'busy',reason:choice.error[1]});
  try{const p=restorePlan(r,kind);if(p.notices.includes('agent-not-resumed'))preview.reason='Opens a shell in its folder: this agent has no exact session to resume.';}catch(error){preview.state='unsupported';preview.reason=error.message;}
  return freeze(preview);
}
const opId=()=>'reopen-op-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,10);
const hostReady=(io,on)=>typeof io.machines!=='function'||io.machines().find(m=>safeMachine(m?.name)===on)?.layout==='ready';
function findSpace(io,record){const all=io.spaces()||[];for(const id of [record.space.replacement,record.space.id].filter(Boolean)){const s=all.find(x=>x.id===id&&safeMachine(x.machine)===record.machine);if(s)return s;}return null;}
const pause=async(io,ms)=>{if(io.delay)await io.delay(ms);else await io.exec('sleep',[String(ms/1000)]);};
async function appear(io,match,message){for(let i=0;i<10;i++){if((io.spaces()||[]).some(match))return true;await pause(io,150);}if(message)fail('SPACE_UNAVAILABLE',message);return false;}
async function folderExists(io,path,on){try{return (await io.exec('test',['-d',path],{on}))?.code===0;}catch{fail('HOST_UNAVAILABLE',`${where(on)} became unreachable while its folder was checked; nothing was opened.`);}}
/** herdr-app do prints what it made or {"error"} with exit 1. Only that documented refusal is a definite failure. */
async function create(io,command,args,{machine,spaceId}){
  let response;try{response=await io.exec('herdr-app',['do',command,JSON.stringify(args)]);}catch{fail('REOPEN_FAILED','Herdr’s command line could not be started; nothing was opened.');}
  let parsed=null;try{parsed=JSON.parse(response?.stdout);}catch{}
  if(response?.code!==0){
    if(parsed&&typeof parsed==='object'&&typeof parsed.error==='string'&&Object.keys(parsed).length===1)fail('REOPEN_FAILED',`Herdr refused to ${command==='space.new'?'recreate the space':'open the tab'}: ${displayText(parsed.error,300)||'unknown error'}`);
    fail('TAB_CREATE_UNCERTAIN','Herdr did not acknowledge the new tab; it may still have been created. Check the space before opening it again.',undefined,{uncertain:true});
  }
  try{
    if(command==='tab.new')return verifyTabAcknowledgement(parsed,{spaceId,machine});
    const value={space:parsed?.space,tab:parsed?.tab,terminal:parsed?.terminal};
    for(const f of ['space','tab','terminal'])if(typeof value[f]!=='string'||!value[f]||value[f].length>256||/[\u0000-\u001f]/.test(value[f]))throw Error(f);
    if(machine&&(!value.space.startsWith(machine+'/')||!value.tab.startsWith(machine+'/')))throw Error('host');
    localTerminalAddress(value.terminal,machine);return value;
  }catch{fail('MALFORMED_ACK','Herdr returned an invalid acknowledgment; no second tab will be opened automatically.',undefined,{uncertain:true});}
}
function focus(io,ack){io.run('space.select',{id:ack.space});io.run('tab.select',{id:ack.tab});io.run('pane.focus',{terminal:ack.terminal});}
async function transferNames(io,record,{tabId,name}){
  const names=new NameOwnership(io,{clock:()=>clockOf(io)}),originId=record.origin.originId;
  const owned=await names.transferToAcknowledgedTab({originId},{machine:record.machine,tabId,name:name??null});
  if(owned.mode==='manual'&&owned.manualName&&owned.manualName!==name)await names.applyName(originId,owned.manualName,{manualTransfer:true,getTabs:()=>(io.spaces()||[]).flatMap(s=>s.tabs.map(t=>({...t,machine:s.machine}))),rename:args=>io.run('tab.rename',args)});
}
function success(record,fields){return freeze({ok:true,recordId:record.id,machine:record.machine,kind:record.kind,title:recordTitle(record),destination:recordDestination(record),notices:[],...fields});}
async function finish(io,journal,record,owner,ack,{action,name,recreatedSpace,notices}){
  const extra=[...notices];
  if(record.origin?.originId)try{await transferNames(io,record,{tabId:ack.tab,name});}catch{extra.push('names-not-transferred');}
  await journal.consume(record.id,owner);focus(io,ack);
  return success(record,{action,spaceId:ack.space,tabId:ack.tab,terminalId:ack.terminal,recreatedSpace,notices:extra});
}
const manualName=record=>record.origin?.mode==='manual'?record.origin.manualName:record.tab.named?record.tab.name:null;
async function restoreShell(io,journal,record,owner,space,plan){
  const on=record.machine,cwd=plan.terminal.startCwd??record.space.folder;
  if(!cwd)fail('FOLDER_UNKNOWN','This tab’s starting folder was not recorded, so it cannot be reopened safely.');
  if(!await folderExists(io,cwd,on))fail('FOLDER_MISSING',`${cwd} no longer exists on ${where(on)}. Recreate it and retry, or forget this tab.`);
  const name=manualName(record);
  // No argv: the target core starts its own default shell. Old commands are never replayed.
  const [command,args]=space?['tab.new',{space:space.id,folder:cwd,...(name?{name}:{})}]:['space.new',{folder:cwd,...(on?{machine:on}:{}),...(record.space.named&&record.space.name?{name:record.space.name}:{}),...(name?{tab:name}:{})}];
  // Persist uncertainty before the process boundary: an interrupted attempt is never retried blindly.
  await journal.updateClaim(record.id,owner,{phase:'attempting'});
  const ack=await create(io,command,args,{machine:on,spaceId:space?.id});
  await journal.updateClaim(record.id,owner,{phase:'acknowledged',ack},space?{}:{replacement:ack.space});
  return finish(io,journal,record,owner,ack,{action:'shell',name,recreatedSpace:!space,notices:plan.notices});
}
async function finishAcknowledged(io,journal,record,owner){
  const ack=record.claim.ack;
  if(!(io.spaces()||[]).some(s=>s.tabs?.some(t=>t.id===ack.tab))){await journal.consume(record.id,owner);fail('PREVIOUS_RESTORE_CLOSED','This tab was already reopened and that tab has since been closed; reopen its newer record instead.');}
  return finish(io,journal,record,owner,ack,{action:'focus',name:manualName(record),recreatedSpace:Boolean(record.space.replacement),notices:[]});
}
async function closeScaffold(io,journal,scaffold,agentTab,on){
  try{
    for(let i=0;i<10;i++){
      const all=io.spaces()||[],space=all.find(s=>s.id===scaffold.space);if(!space||!space.tabs?.some(t=>t.id===scaffold.tab))return true;
      // Close the helper shell only once both tabs are visible, so this can never close the agent's space.
      if(space.tabs.some(t=>t.id===agentTab)){await journal.expectClose(on,scaffold.tab);io.run('tab.close',{id:scaffold.tab,confirmed:true});return true;}
      // The exact session was already running elsewhere: the recreated space holds only the helper shell.
      if(space.tabs.length===1&&all.some(s=>s.id!==scaffold.space&&s.tabs?.some(t=>t.id===agentTab))){await journal.expectClose(on,scaffold.tab);io.run('space.close',{id:scaffold.space,confirmed:true});return true;}
      await pause(io,150);
    }
  }catch{}
  return false;
}
/**
 * hc keeps finished terminals until hc rm, and nothing else may have invalidated this
 * generation's binding yet. A committed binding for the closed generation would make the
 * shared resume focus a dead terminal, so it is retired once that generation is proven not live.
 */
async function retireClosedBinding(io,on,t){
  if(!t.requestId)return;let raw=null;
  try{const r=await io.exec('hc',['get',localTerminalAddress(t.address,on),'--json'],{on});if(r?.code===0)raw=JSON.parse(r.stdout);}
  catch(error){if(error instanceof SyntaxError)raw=null;else fail('HOST_UNAVAILABLE',`${where(on)} became unreachable while its terminals were checked; nothing was resumed.`);}
  if(raw?.state==='live'&&(t.createdMs===null||raw.created_ms===t.createdMs))return;
  const store=new BindingStore(io,{clock:()=>clockOf(io)}),state=await store.requestState(t.requestId),term=state?.ack?.terminal;
  if(state?.state==='committed'&&term?.machine===on&&term.address===t.address&&(t.createdMs===null||term.createdMs===t.createdMs))await store.invalidate(t.requestId,'Terminal closed; recorded by reopen');
}
async function restoreAgent(io,journal,record,owner,space,plan){
  const on=record.machine,t=plan.terminal,session=t.session;let cwd=t.checkoutRoot??t.startCwd,repoRoot=t.repoRoot??null;
  if(!cwd)fail('FOLDER_UNKNOWN','This agent’s checkout folder was not recorded, so it cannot be resumed safely.');
  if(!repoRoot){
    const resolved=await resolveSpaceRepo({id:'reopen-probe',machine:on,active:false,tabs:[{id:'reopen-probe'}]},[{pane:'reopen-probe',tab:'reopen-probe',terminal:'t0',cwd}],io.exec);
    if(resolved.state!=='resolved')fail('WORKTREE_MISSING','The agent’s repository folder is missing or is no longer a Git checkout on its machine. Locate it and retry, or forget this agent.');
    repoRoot=resolved.repoRoot;cwd=resolved.worktreeRoot;
  }
  let scaffold=record.claim.scaffold&&space?.id===record.claim.scaffold.space?record.claim.scaffold:null,spaceId=space?.id??null;
  if(!space){
    if(!await folderExists(io,cwd,on))fail('WORKTREE_MISSING',`${cwd} no longer exists on ${where(on)}. Locate it and retry, or forget this agent.`);
    await journal.updateClaim(record.id,owner,{phase:'attempting'});
    scaffold=await create(io,'space.new',{folder:cwd,...(on?{machine:on}:{}),...(record.space.named&&record.space.name?{name:record.space.name}:{})},{machine:on});
    await journal.updateClaim(record.id,owner,{phase:'claimed',scaffold},{replacement:scaffold.space});spaceId=scaffold.space;
    await appear(io,s=>s.id===spaceId&&safeMachine(s.machine)===on,'The recreated space has not appeared yet; retry in a moment.');
  }
  await retireClosedBinding(io,on,t);await journal.updateClaim(record.id,owner,{});
  const originId=record.origin?.originId??t.originId,title=record.origin?.mode==='manual'?null:record.tab.named?displayText(record.tab.name,200):meaningful(t.title);
  // The shared exact resume owns host checks, live-session focus, dedupe, binding and name transfer.
  const result=await resume({requestId:record.claim.requestId,spaceId,session,repoRoot,cwd,toolKey:t.toolKey??session.provider,...(originId?{originId}:{}),...(title?{title}:{})},io);
  if(!result.ok)fail(result.code,result.message,result.recovery);
  const notices=[...plan.notices];if(scaffold&&result.tabId&&result.tabId!==scaffold.tab&&!await closeScaffold(io,journal,scaffold,result.tabId,on))notices.push('scaffold-tab-kept');
  await journal.consume(record.id,owner);
  return success(record,{action:result.action==='focus'?'focus':'resume',spaceId,tabId:result.tabId,terminalId:result.terminalId,recreatedSpace:Boolean(scaffold),originId:result.originId,session:result.session,notices});
}
/** Restores one record. The record is consumed only after Herdr or the shared resume acknowledged success. */
export async function reopenRecord(id,io,{owner=opId(),kind='tab',confirmUncertain=false}={}){
  let journal,claimed=false;
  try{
    if(!REOPEN_KINDS.includes(kind))fail('INVALID_REOPEN','Choose Reopen last tab or Reopen last agent.');
    journal=new ClosedJournal(io,{clock:()=>clockOf(io)});
    const record=await journal.claim(id,owner,{confirmUncertain});claimed=true;
    if(record.claim.phase==='acknowledged'&&record.claim.ack)return await finishAcknowledged(io,journal,record,owner);
    const plan=restorePlan(record,kind);
    if(!hostReady(io,record.machine))fail('HOST_UNAVAILABLE',`${where(record.machine)} is offline or still loading; the closed tab was kept.`);
    const space=findSpace(io,record);
    return plan.mode==='agent'?await restoreAgent(io,journal,record,owner,space,plan):await restoreShell(io,journal,record,owner,space,plan);
  }catch(error){
    const code=error?.code||'REOPEN_FAILED',message=known(error)?error.message:'Reopen could not complete; the closed tab was kept.';
    if(claimed)try{await journal.release(id,owner,{code,message,definite:!error?.uncertain});}catch{}
    return failure(code,message,{...(error?.recovery||{}),recordId:id});
  }
}
/** reopen('tab'|'agent', io): the two distinct default actions. */
export async function reopen(kind,io,options={}){
  try{
    if(!REOPEN_KINDS.includes(kind))fail('INVALID_REOPEN','Choose Reopen last tab or Reopen last agent.');
    const {value}=await new ClosedJournal(io).read(),choice=selectRecord(value,kind,{now:clockOf(io)});
    if(choice.error)return failure(choice.error[0],choice.error[1],choice.record?{recordId:choice.record.id}:undefined);
    return await reopenRecord(choice.record.id,io,{...options,kind});
  }catch(error){return failure(error?.code||'REOPEN_FAILED',known(error)?error.message:'Closed tabs could not be read; nothing was opened.');}
}
export async function dismissRecord(id,io,{owner}={}){
  try{const result=await new ClosedJournal(io).dismiss(id,{owner});return freeze({ok:true,dismissed:result.dismissed});}
  catch(error){return failure(error?.code||'DISMISS_FAILED',known(error)?error.message:'This closed tab could not be forgotten.');}
}
const BUSY_MS=90000;
/**
 * The controller a standalone reopen view or a bundling tab bar drives from its own timers and clicks.
 * It holds no cx; the watcher lease keeps a single observer per app home across copies.
 */
export class ReopenController {
  constructor(io,{owner='reopen-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,10)}={}){this.io=io;this.owner=owner;this.journal=new ClosedJournal(io,{clock:()=>clockOf(io)});this.watcher=new ClosedWatcher(io,{owner:owner+'-watch'});this.value=null;this.error=null;this.busy=new Map();this.sequence=0;this.importing=0;this.lastImport=null;}
  async refresh(){try{this.value=(await this.journal.read()).value;this.error=null;}catch(error){this.error=Object.freeze({code:error?.code||'INVALID_CLOSED',message:known(error)?error.message:'Closed tabs could not be read.'});}return this.value;}
  // A copy that does not hold the recording lease is skipped by the watcher, but must still read the journal
  // another copy records into; otherwise its Reopen preview stays on a stale "last" record.
  async tick(){const result=await this.watcher.tick();if(result.value){this.value=result.value;this.error=null;}else if(result.error)this.error=result.error;else await this.refresh();return result;}
  get revision(){return this.value?.revision??null;}
  running(){const now=clockOf(this.io);for(const [key,at]of this.busy)if(now-at>=BUSY_MS)this.busy.delete(key);return this.busy.size>0;}
  preview(kind){const p=reopenPreview(this.value,kind,{now:clockOf(this.io)});return this.running()&&p.state==='ready'?freeze({...p,state:'busy',reason:'Reopening…'}):p;}
  recent(limit=6){const now=clockOf(this.io);return (this.value?.records||[]).slice(0,limit).map(r=>freeze({id:r.id,kind:r.kind,title:recordTitle(r),destination:recordDestination(r),closedAt:r.closedAt,imported:r.source==='imported',ordered:r.ordered,error:r.error?.message??null,busy:Boolean(r.claim&&r.claim.until>now),exact:r.terminals.some(t=>t.session)}));}
  async run(kind,{recordId,confirmUncertain=false}={}){
    // One action at a time per copy; a double click or repeated key waits for the first acknowledgment.
    if(this.running())return failure('REOPEN_IN_PROGRESS','A reopen is already running; wait for it to appear.');
    const key=++this.sequence;this.busy.set(key,clockOf(this.io));let result;
    try{const owner=this.owner+'-'+key;result=recordId?await reopenRecord(recordId,this.io,{owner,kind,confirmUncertain}):await reopen(kind,this.io,{owner,confirmUncertain});}
    catch{result=failure('REOPEN_FAILED','Reopen could not complete; the closed tab was kept.');}
    this.busy.delete(key);await this.refresh();return result;
  }
  async dismiss(id){const result=await dismissRecord(id,this.io);await this.refresh();return result;}
  async importHistory(){
    const now=clockOf(this.io);if(this.importing&&now-this.importing<LIMITS.historyMs*LIMITS.hosts)return [failure('IMPORT_IN_PROGRESS','Older history is already being imported.')];
    this.importing=now;const results=[];
    const hosts=(typeof this.io.machines==='function'?this.io.machines()||[]:[{name:null,layout:'ready'}]).filter(m=>m&&!m.temporary&&safeMachine(m.name)!==undefined).slice(0,LIMITS.hosts);
    for(const m of hosts)results.push(await importClosedHistory(m.name??null,this.io));
    this.importing=0;this.lastImport=freeze({at:clockOf(this.io),results});await this.refresh();return results;
  }
  release(){return this.watcher.release();}
}
export {snapshotWorld};
