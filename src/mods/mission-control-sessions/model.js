import {canonicalRepoPath} from '../../shared/config.js';
import {machineIdentity,sessionIdentity,sessionKey,localTerminalAddress,terminalIdentity,terminalKey} from '../../shared/session-identity.js';
import {validateProviderObservation} from '../../shared/provider-observation.js';
import {usageSourceFingerprint} from '../../shared/usage-sources.js';
import {resolveSpaceRepo} from '../../shared/space-repo.js';
import {BindingStore} from '../../shared/session-bindings.js';

// Herdr ends a continuation that overruns its slice without catch/finally and
// a cancelled task never settles. Every collector page ends long before this.
export const HISTORY_PAGE=50,HISTORY_LIMIT=1000,STALE_LOAD_MS=90000;
export const providerNames=Object.freeze({claude:'Claude Code',codex:'Codex',grok:'Grok'});
export class HistoryError extends Error{constructor(code,message){super(message);this.name='HistoryError';this.code=code;}}
const fail=(code,message)=>{throw new HistoryError(code,message);};
const freeze=v=>{if(v&&typeof v==='object'&&!Object.isFrozen(v)){for(const c of Object.values(v))freeze(c);Object.freeze(v);}return v;};
const exactId=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const scopeFields=['machine','provider','credentialScope','providerRoot'];
const hostKey=machine=>JSON.stringify(machineIdentity(machine));
export const hostLabel=machine=>machine??'This Mac';
export const repoKey=(machine,repoRoot)=>JSON.stringify([machineIdentity(machine),repoRoot]);
const at=(machine,path)=>JSON.stringify([machine,path]);
const parent=path=>{const i=path.lastIndexOf('/');return i>0?path.slice(0,i):path!=='/'&&i===0?'/':null;};
const publicMessage=error=>typeof error?.code==='string'&&typeof error.message==='string'&&error.message.length<=300?error.message:'Session history is unavailable on this host.';
export const rowDigest=value=>{let a=2166136261,b=0x9e3779b9;for(let i=0;i<value.length;i++){const c=value.charCodeAt(i);a=Math.imul(a^c,16777619);b=Math.imul(b^c,2246822519);}return [a>>>0,b>>>0].map(n=>n.toString(16).padStart(8,'0')).join('');};
/** Most recent activity first; equal or unknown times keep exact identity order. */
export const byActivity=(a,b)=>(b.activityAt??-1)-(a.activityAt??-1)||(a.key<b.key?-1:a.key>b.key?1:0);

/** One collector observation of exactly this source scope, or the reason it is not a history row. */
export function historyRecord(value,source){
  if(!validateProviderObservation(value).ok)return {ok:false,code:'MALFORMED'};
  if(value.state!=='available')return {ok:false,code:'UNREADABLE'};
  if(value.provenance.provider!==source.provider||scopeFields.some(k=>value.identity[k]!==source[k]))return {ok:false,code:'WRONG_SCOPE'};
  const identity=sessionIdentity(value.identity);
  return {ok:true,record:freeze({key:sessionKey(identity),identity,sourceId:source.id,title:value.title??null,cwd:value.cwd??null,activityAt:value.provenance.observedAt})};
}
/** Files of one exact session merge into its freshest metadata; titles never merge identities. */
export function mergeRecord(a,b){
  if(!a)return b;if(a.key!==b.key)fail('IDENTITY_CONFLICT','Different exact sessions cannot merge.');
  const [newer,older]=byActivity(b,a)<=0?[b,a]:[a,b];
  return freeze({...newer,title:newer.title??older.title,cwd:newer.cwd??older.cwd,activityAt:newer.activityAt??older.activityAt});
}
export function parseWorktrees(stdout){
  if(typeof stdout!=='string'||stdout.length>1048576)fail('INVALID_WORKTREES','The Git worktree list is unavailable.');
  const result=[];let current=null;
  for(const line of stdout.split('\0')){
    if(line.startsWith('worktree ')){let path;try{path=canonicalRepoPath(line.slice(9));}catch{fail('INVALID_WORKTREES','Git reported a non-canonical worktree path.');}current={path,head:null,branch:null,detached:false,bare:false,missing:false};result.push(current);continue;}
    if(!line){current=null;continue;}if(!current)continue;
    if(line.startsWith('HEAD '))current.head=line.slice(5);else if(line.startsWith('branch '))current.branch=line.slice(7).replace(/^refs\/heads\//,'');
    else if(line==='detached')current.detached=true;else if(line==='bare')current.bare=true;else if(line==='prunable'||line.startsWith('prunable '))current.missing=true;
  }
  if(result.length>1000)fail('INVALID_WORKTREES','The repository lists too many worktrees.');return freeze(result);
}
/** The space's canonical repository plus every checkout Git still records for it, missing ones included. */
export async function resolveRepoCheckouts(space,panes,exec){
  const resolved=await resolveSpaceRepo(space,panes,exec),named={spaceName:typeof space?.name==='string'?space.name:null};
  if(resolved.state!=='resolved')return freeze({...resolved,...named});
  let worktrees=null;try{const r=await exec('git',['-C',resolved.repoRoot,'worktree','list','--porcelain','-z'],{on:resolved.machine});if(r?.code===0)worktrees=parseWorktrees(r.stdout);}catch{}
  if(!worktrees?.length||worktrees[0].path!==resolved.repoRoot)return freeze({state:'error',spaceId:resolved.spaceId,machine:resolved.machine,reason:'The repository worktree list is unavailable on its host.',...named});
  return freeze({...resolved,...named,worktrees});
}
/** Mission Control's acknowledged launches: exact session to canonical repo and checkout. Hints only. */
export function journalCheckouts(raw){
  const result=new Map();if(typeof raw!=='string'||raw.length>180000)return result;
  let value;try{value=JSON.parse(raw);}catch{return result;}
  if(value?.v!==1||!value.requests||typeof value.requests!=='object'||Array.isArray(value.requests))return result;
  for(const record of Object.values(value.requests).slice(0,2000))try{
    if(!record?.sessionProposal||!record.ack)continue;const session=sessionIdentity(record.sessionProposal),machine=machineIdentity(record.request.machine);if(session.machine!==machine)continue;
    const entry={machine,repoRoot:canonicalRepoPath(record.request.repoRoot),checkoutRoot:canonicalRepoPath(record.folder??record.request.checkoutRoot??record.request.repoRoot),at:Number.isFinite(record.updatedAt)?record.updatedAt:0},key=sessionKey(session),old=result.get(key);
    if(!old||entry.at>=old.at)result.set(key,freeze(entry));
  }catch{}
  return result;
}
export function membershipIndex(repos){
  const roots=new Map(),byRepo=new Map();
  for(const repo of repos){
    if(repo?.state!=='resolved'||!Array.isArray(repo.worktrees))continue;const key=repoKey(repo.machine,repo.repoRoot);let entry=byRepo.get(key);
    if(!entry){entry={key,machine:repo.machine,repoRoot:repo.repoRoot,spaces:[]};byRepo.set(key,entry);for(const worktree of repo.worktrees)if(!worktree.bare&&!roots.has(at(repo.machine,worktree.path)))roots.set(at(repo.machine,worktree.path),{repoKey:key,worktree});}
    if(!entry.spaces.some(s=>s.spaceId===repo.spaceId))entry.spaces.push({spaceId:repo.spaceId,spaceName:repo.spaceName,worktreeRoot:repo.worktreeRoot});
  }
  return {roots,byRepo};
}
function nearest(index,machine,cwd){let path=cwd,hit=null;while(path&&!(hit=index.roots.get(at(machine,path))))path=parent(path);return hit;}
/** Canonical membership only: a checkout Git records for the repo, a verified subfolder, or an acknowledged launch. */
export function locateSession(index,record,{journal,folders}={}){
  const machine=record.identity.machine;
  if(record.cwd){
    const hit=nearest(index,machine,record.cwd);
    if(hit&&hit.worktree.path===record.cwd)return {...hit,missing:hit.worktree.missing,via:'checkout'};
    const folder=hit?folders?.get(at(machine,record.cwd)):null;
    if(folder?.state==='present'){
      const own=folder.toplevel===hit.worktree.path?hit:index.roots.get(at(machine,folder.toplevel));
      // A nested independent checkout never joins the repository of its parent folder.
      return own?{...own,missing:own.worktree.missing,via:'folder'}:null;
    }
  }
  const saved=journal?.get(record.key),repo=saved&&saved.machine===machine?index.byRepo.get(repoKey(machine,saved.repoRoot)):null;if(!repo)return null;
  const checkout=index.roots.get(at(machine,saved.checkoutRoot));
  return checkout?.repoKey===repo.key?{...checkout,missing:checkout.worktree.missing,via:'journal'}:{repoKey:repo.key,worktree:freeze({path:saved.checkoutRoot,head:null,branch:null,detached:false,bare:false,missing:true}),missing:true,via:'journal'};
}
/** Subfolders below a recorded checkout still need Git to name their own top level. */
export function pendingFolders(index,records,{repoKey:only}={}){
  const out=new Map();
  for(const record of [...records].sort(byActivity)){
    if(!record.cwd)continue;const machine=record.identity.machine,hit=nearest(index,machine,record.cwd);
    if(hit&&hit.worktree.path!==record.cwd&&(!only||hit.repoKey===only))out.set(at(machine,record.cwd),[machine,record.cwd]);
  }
  return [...out.values()];
}
export async function verifyFolders(exec,pending,cache,{limit=64,isCurrent=()=>true,clock=()=>Date.now()}={}){
  const work=pending.filter(([machine,path])=>{const c=cache.get(at(machine,path));return !c||clock()-c.at>300000;}).slice(0,limit);
  for(let i=0;i<work.length&&isCurrent();i+=4)await Promise.all(work.slice(i,i+4).map(async([machine,path])=>{
    let r;try{r=await exec('git',['-C',path,'rev-parse','--path-format=absolute','--show-toplevel'],{on:machine});}catch{return;}
    let value={state:'missing',at:clock()};if(r?.code===0)try{value={state:'present',toplevel:canonicalRepoPath(r.stdout.trim()),at:clock()};}catch{}
    cache.delete(at(machine,path));cache.set(at(machine,path),freeze(value));while(cache.size>2000)cache.delete(cache.keys().next().value);
  }));
  return cache;
}
/** Exact live bindings only; a reused address or changed generation is not this session. */
export async function runningSessions(io,{ready=()=>true,isCurrent=()=>true}={}){
  const {value}=await new BindingStore(io).read(),byHost=new Map(),result=new Map();
  for(const[requestId,r]of Object.entries(value.proposals)){
    if(r.state!=='committed'||!r.session||!r.ack?.terminal)continue;const on=r.ack.terminal.machine;if(r.session.machine!==on||!ready(on))continue;
    if(!byHost.has(hostKey(on)))byHost.set(hostKey(on),{machine:on,list:[]});byHost.get(hostKey(on)).list.push({requestId,record:r});
  }
  for(const {machine,list}of byHost.values()){
    if(!isCurrent())break;let live=null;try{const r=await io.exec('hc',['ls','--json'],{on:machine});if(r.code===0)live=JSON.parse(r.stdout).terminals;}catch{}
    if(!Array.isArray(live))continue;const summaries=new Map();for(const t of live.slice(0,1000))try{if(t.state===undefined||t.state==='live')summaries.set(localTerminalAddress(t.address,machine),t);}catch{}
    for(const {requestId,record}of list.slice(0,200)){
      if(!isCurrent())break;
      try{
        const local=localTerminalAddress(record.ack.terminal.address,machine),summary=summaries.get(local);if(!summary)continue;let raw=summary;
        if(!Number.isSafeInteger(summary.created_ms)||summary.foreground===undefined){const r=await io.exec('hc',['get',local,'--json'],{on:machine});if(r.code!==0)continue;raw=JSON.parse(r.stdout);if(localTerminalAddress(raw.address,machine)!==local)continue;}
        const identity=terminalIdentity(raw,machine);if(terminalKey(identity)===terminalKey(record.ack.terminal))result.set(sessionKey(record.session),freeze({terminal:identity.address,tabId:record.ack.tabId,requestId}));
      }catch{}
    }
  }
  return result;
}
/** Manual names captured by the shared observer. Imported histories keep their reported title. */
export function sessionNames(value){const names=new Map();for(const r of Object.values(value?.origins||{}))try{if(r.session&&r.mode==='manual'&&typeof r.manualName==='string'&&r.manualName)names.set(sessionKey(r.session),r.manualName.slice(0,200));}catch{}return names;}

function pickSpace(repo,checkout,active){return repo.spaces.find(s=>s.worktreeRoot===checkout)||repo.spaces.find(s=>s.spaceId===active)||repo.spaces[0]||null;}
function sessionRow(record,hit,{index,scope,running,names,support,ready}){
  const s=record.identity,machine=s.machine,host=hostLabel(machine),repo=hit?index.byRepo.get(hit.repoKey):null,checkout=hit?.worktree||null,provider=s.provider,providerName=providerNames[provider]||provider;
  const space=!repo?null:scope.all?pickSpace(repo,checkout?.path,scope.activeSpaceId):{spaceId:scope.spaceId,spaceName:scope.spaceName},live=running?.get(record.key)||null,manual=names?.get(record.key)||null,help=support?.get(JSON.stringify([machine,provider]));
  let state='ready',reason=null;
  if(!ready(machine)){state='offline';reason=`${host} is offline or still connecting. Retry when it is ready.`;}
  else if(live)state='running';
  else if(!space){state='unassigned';reason=`No open space on ${host} contains this folder. Open its repository in a space to resume.`;}
  else if(hit.missing){state='missing';reason=`This ${checkout.path===repo.repoRoot?'checkout':'worktree'} is missing on ${host}. Locate or restore it, then retry.`;}
  else if(!exactId.test(s.sessionId)){state='unsupported';reason='This history has no exact resumable session ID.';}
  else if(help?.supported===false){state='unsupported';reason=help.reason;}
  const folder=(checkout?.path||record.cwd||'').split('/').filter(Boolean).at(-1)||null,branch=checkout?.branch??(checkout?.detached?'detached':null),title=manual||record.title||'Untitled · '+s.sessionId.slice(0,8);
  return {key:record.key,id:'session-'+rowDigest(record.key),identity:s,provider,providerName,machine,host,title,titleKind:manual?'manual':record.title?'reported':'untitled',reportedTitle:record.title,activityAt:record.activityAt,cwd:record.cwd,
    checkoutRoot:checkout?.path??null,repoRoot:repo?.repoRoot??null,branch,linked:Boolean(checkout&&repo&&checkout.path!==repo.repoRoot),folder,spaceId:space?.spaceId??null,spaceName:space?.spaceName??null,state,reason,running:live,
    search:[title,record.title,providerName,branch,folder,record.cwd,host,space?.spaceName,s.sessionId].filter(Boolean).join(' ').toLowerCase()};
}
/** Scope rows, most recent first, capped at the display limit. Yields between bounded batches. */
export async function deriveSessions({records,index,scope,journal,folders,running,names,support,ready=()=>true},{pause=async()=>{}}={}){
  const rows=[];let n=0;
  for(const record of records){
    if(++n%250===0)await pause();
    const hit=locateSession(index,record,{journal,folders});if(!scope.all&&(!scope.repoKey||hit?.repoKey!==scope.repoKey))continue;
    rows.push(sessionRow(record,hit,{index,scope,running,names,support,ready}));
  }
  rows.sort(byActivity);await pause();
  return freeze({rows:rows.slice(0,HISTORY_LIMIT),total:rows.length,truncated:rows.length>HISTORY_LIMIT});
}
export function filterSessions(view,{query='',tool='all',session=null}={}){
  const needle=query.trim().toLowerCase(),searched=view.rows.filter(r=>(!session||r.key===session)&&(!needle||r.search.includes(needle))),counts={all:searched.length};
  for(const r of searched)counts[r.provider]=(counts[r.provider]||0)+1;
  return {rows:tool==='all'?searched:searched.filter(r=>r.provider===tool),counts};
}

/** Per-source history over the shared telemetry/collector transport. Never writes provider files. */
export class SessionHistory{
  constructor(createBridge,{clock=()=>Date.now()}={}){
    if(typeof createBridge!=='function')fail('INVALID_TRANSPORT','The shared telemetry transport is required.');
    Object.assign(this,{createBridge,clock,bridge:createBridge(),entries:new Map(),closed:false,revision:0});
  }
  async refreshSources(){const bridge=this.bridge,enabled=await bridge.sources.refresh();if(!this.closed&&bridge===this.bridge)this.reconcile(enabled);return this.list();}
  /** Disabled or changed sources clear their rows immediately; nothing old-scope stays visible. */
  reconcile(enabled){
    const next=new Map();for(const source of enabled)try{next.set(source.id,{source,fingerprint:usageSourceFingerprint(source)});}catch{}
    for(const[id,entry]of this.entries)if(next.get(id)?.fingerprint!==entry.fingerprint){this.entries.delete(id);this.revision++;}
    for(const[id,{source,fingerprint}]of next)if(!this.entries.has(id)){this.entries.set(id,{id,source:freeze({...source}),fingerprint,records:new Map(),unreadable:new Set(),malformed:0,cursor:null,pages:0,done:false,capped:false,indexTruncated:false,error:null,fetchedAt:null,pending:null,pendingAt:0});this.revision++;}
  }
  list(){return [...this.entries.values()];}
  on(machines){const keys=new Set(machines.map(hostKey));return this.list().filter(e=>keys.has(hostKey(e.source.machine))).map(e=>e.id);}
  records(ids){const out=[];for(const id of ids){const e=this.entries.get(id);if(e)for(const r of e.records.values())out.push(r);}return out;}
  stale(entry){return Boolean(entry.pending)&&this.clock()-entry.pendingAt>=STALE_LOAD_MS;}
  hasAbandonedLoad(){return !this.closed&&this.list().some(e=>this.stale(e));}
  /** A task the host ended can leave the old transport's host queue waiting forever. */
  recover(){if(this.closed)return;for(const e of this.entries.values())e.pending=null;try{this.bridge.close();}catch{}this.bridge=this.createBridge();this.revision++;}
  status(ids){
    const entries=ids.map(id=>this.entries.get(id)).filter(Boolean),times=entries.map(e=>e.fetchedAt).filter(Number.isFinite);
    return freeze({sources:entries.length,loading:entries.some(e=>e.pending&&!this.stale(e)),fetchedAt:times.length?Math.min(...times):null,more:entries.some(e=>!e.done&&!e.capped),truncated:entries.some(e=>e.capped||e.indexTruncated),unreadable:entries.reduce((n,e)=>n+e.unreadable.size+e.malformed,0),
      errors:entries.filter(e=>e.error).map(e=>({sourceId:e.id,provider:e.source.provider,machine:e.source.machine,code:e.error.code,message:e.error.message,at:e.error.at}))});
  }
  /** One in-flight read per source; pages stop once the scope has enough rows or the source is exhausted. */
  async scan(ids,{more=false,pages=6,want=Infinity,isMember=()=>true,isCurrent=()=>true,pause=async()=>{}}={}){
    const entries=ids.map(id=>this.entries.get(id)).filter(Boolean),state={members:0};
    for(const e of entries)for(const r of e.records.values())if(isMember(r))state.members++;
    await Promise.all(entries.map(entry=>this.scanEntry(entry,{more,pages,want,isMember,isCurrent,pause,state})));return this.status(ids);
  }
  async scanEntry(entry,options){
    const previous=entry.pending&&!this.stale(entry)?entry.pending:null;if(previous){await previous;if(!options.more)return;}
    if(this.closed||this.entries.get(entry.id)!==entry)return;
    const pending=this.readPages(entry,options);entry.pending=pending;entry.pendingAt=this.clock();
    try{await pending;}finally{if(entry.pending===pending)entry.pending=null;}
  }
  async readPages(entry,{more,pages,want,isMember,isCurrent,pause,state}){
    const bridge=this.bridge,current=()=>!this.closed&&bridge===this.bridge&&this.entries.get(entry.id)===entry&&isCurrent();
    if(more&&(entry.done||entry.capped))return;
    let cursor=more?entry.cursor:null,read=more?entry.pages:0,budget=pages,restarted=false;
    for(let page=0;page<budget;page++){
      if(!current())return;let response;
      try{response=await bridge.historyPage(entry.id,cursor?{cursor}:{});}
      catch(error){
        if(!current())return;
        // A cursor stops matching when provider files change; restart once from the newest page.
        if(cursor&&!restarted){restarted=true;budget=read+pages;read=0;cursor=null;page=-1;continue;}
        entry.error=freeze({code:typeof error?.code==='string'?error.code:'HISTORY_UNAVAILABLE',message:publicMessage(error),at:this.clock()});this.revision++;return;
      }
      if(!current())return;read++;this.accept(entry,response,{isMember,state});cursor=response.cursor;
      if(more||restarted||read>=entry.pages){entry.cursor=cursor;entry.pages=read;entry.done=!cursor;}
      entry.indexTruncated=Boolean(response.scan?.indexLimitReached);entry.error=null;entry.fetchedAt=this.clock();this.revision++;
      if(!cursor||entry.capped||state.members>=want)return;
      await pause();
    }
  }
  accept(entry,response,{isMember,state}){
    for(const value of response.data){
      let checked;try{checked=historyRecord(value,entry.source);}catch{checked={ok:false,code:'MALFORMED'};}
      if(!checked.ok){if(checked.code==='UNREADABLE'){if(entry.unreadable.size<HISTORY_LIMIT)entry.unreadable.add(value.provenance.sourceDigest);}else entry.malformed++;continue;}
      const record=checked.record,old=entry.records.get(record.key);
      if(!old&&entry.records.size>=HISTORY_LIMIT){
        // Retain the most recent sessions; provider files themselves are never touched.
        entry.capped=true;let oldest=null;for(const r of entry.records.values())if(!oldest||byActivity(r,oldest)>0)oldest=r;
        if(byActivity(record,oldest)>=0)continue;entry.records.delete(oldest.key);
      }
      entry.records.set(record.key,mergeRecord(old,record));if(!old&&isMember(record))state.members++;
    }
  }
  close(){this.closed=true;try{this.bridge.close();}catch{}this.entries.clear();}
}
