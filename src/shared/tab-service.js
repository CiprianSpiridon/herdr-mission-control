/**
 * The naming / close-history watcher service a tab bar drives from its own cx.timer ticks.
 * It holds no cx and no timers: every copy may tick; one CAS lease per app home (in
 * mission-control/tab-names.json) lets exactly one copy derive and write names. Manual edits are
 * recorded through the shared TASK-070 observer (names.json, its own lease); closes are recorded only
 * by the injected TASK-057 controller/watcher (closed.json, its own lease) and the journal's
 * captureTab/recordConfirmedClose for closes this bar performs itself.
 *
 * A continuation can be interrupted with no catch/finally and a cancelled task never settles, so
 * every in-flight flag here is a timestamp that expires, and every write is recorded before its
 * command is emitted.
 */
import {NameOwnership} from './name-ownership.js';
import {ClosedJournal,LIMITS as CLOSED} from './closed-tabs.js';
import {NAME_LIMITS,TabNamesError,emptyTabNames,validateTabNames,observeTab,reconcileTab,sweep,displayLabel,tabKey,normalizeMeta,mergeMeta} from './tab-names.js';

export class TabServiceError extends Error {constructor(code,message){super(message);this.name='TabServiceError';this.code=code;}}
const fail=(code,message)=>{throw new TabServiceError(code,message);};
/** pollMs is the floor for naming passes; a lease further out than maxLeaseMs is treated as expired. */
export const SERVICE_LIMITS=Object.freeze({pollMs:3000,maxPollMs:60000,leaseMs:12000,maxLeaseMs:60000,staleMs:15000,observeLeaseMs:10000,observeRetryMs:10000,renamesPerPass:4,linkWindowMs:60000,acks:64,closing:16,closeConfirmMs:30000,journalChars:180000,tabs:2000});
const clone=v=>JSON.parse(JSON.stringify(v));
const freeze=v=>{if(v&&typeof v==='object'&&!Object.isFrozen(v)){for(const c of Object.values(v))freeze(c);Object.freeze(v);}return v;};
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const utf8=value=>{let n=0;for(const c of value){const p=c.codePointAt(0);n+=p<128?1:p<2048?2:p<65536?3:4;}return n;};
const isConflict=e=>['STALE','CONFLICT','EAGAIN'].includes(e?.code)||/stale|snapshot|contents?.*changed|expected.*match|compare.and.set/i.test(e?.message||'');
const known=e=>e instanceof TabNamesError||e instanceof TabServiceError;
const randomId=prefix=>prefix+'-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,10);
const homeOf=io=>{const home=typeof io?.appHome==='function'?io.appHome():io?.appHome;if(typeof home!=='string'||!home||/[\u0000-\u001f]/.test(home))fail('SERVICE_PATH','The Herdr app home is unavailable.');return home.replace(/[/\\]+$/,'');};
/** Another owner's lease counts only while it is unexpired and no further out than maxLeaseMs. */
export const leaseHeld=(lease,owner,now)=>Boolean(lease&&lease.owner!==owner&&lease.expiresAt>now&&lease.expiresAt-now<=SERVICE_LIMITS.maxLeaseMs);
// TASK-070 validates manual names with these rules; a name it would reject is never handed to it.
const observable=t=>typeof t.name==='string'&&t.name.length<=512&&!/[\u0000-\u001f]/.test(t.name)&&!['__proto__','prototype','constructor'].includes(t.name);

/** TabNames v1 at appHome()/mission-control/tab-names.json. fn(draft) is synchronous; {write:false} skips the write. */
export class TabNameStore {
  constructor(io){this.io=io;this.path=homeOf(io)+'/mission-control/tab-names.json';}
  async read(){
    const raw=await this.io.readTextFile(this.path);if(raw===null)return {raw,value:emptyTabNames()};
    if(typeof raw!=='string'||utf8(raw)>NAME_LIMITS.bytes+65536)throw new TabNamesError('TAB_NAMES_CAPACITY','Tab names exceed their supported size; the original file was kept unchanged.');
    let data;try{data=JSON.parse(raw);}catch{throw new TabNamesError('INVALID_TAB_NAMES','Tab names are not valid JSON; the original file was kept unchanged.');}
    return {raw,value:validateTabNames(data)};
  }
  async edit(fn,{snapshot}={}){
    for(let attempt=0;attempt<4;attempt++){
      const {raw,value}=attempt===0&&snapshot?snapshot:await this.read(),draft=clone(value),result=fn(draft)||{};
      if(result.write===false)return {value,result,written:false};
      draft.revision++;if(!Number.isSafeInteger(draft.revision))fail('TAB_NAMES_CAPACITY','Tab names revision exhausted.');
      const next=validateTabNames(draft),body=JSON.stringify(next)+'\n';if(utf8(body)>NAME_LIMITS.bytes)fail('TAB_NAMES_CAPACITY','Tab names cannot fit their size limit.');
      // An existing file proves its folder exists; only the first write may need to create it.
      if(raw===null)await this.io.ensureDirectory?.(this.path.slice(0,this.path.lastIndexOf('/')));
      try{await this.io.writeTextFile(this.path,body,raw);return {value:next,result,written:true};}catch(e){if(!isConflict(e))throw e;}
    }
    fail('CONFLICT','Tab names changed repeatedly; nothing stale was written.');
  }
}
const SETTLED=new Set(['complete','failed','recovery-required']);
export const linkingName=(machine,name)=>'name:'+JSON.stringify([machine??null,name]);
/**
 * The launch journal (launches.json), read only: task identity by acknowledged tab and by origin, and
 * the tabs an unfinished launch/resume is still linking to its origin (by ack, or by its placeholder
 * name before the ack is journaled). Malformed input yields nothing; it never throws.
 */
export function launchMetadata(raw){
  const meta=new Map(),linking=new Set(),out={meta,linking};if(typeof raw!=='string'||raw.length>SERVICE_LIMITS.journalChars)return out;
  let value;try{value=JSON.parse(raw);}catch{return out;}if(value?.v!==1||!plain(value.requests))return out;
  for(const r of Object.values(value.requests).slice(0,2000))try{
    const q=r?.request;if(!plain(q))continue;const machine=q.machine??null,open=typeof r.state==='string'&&!SETTLED.has(r.state);
    if(!plain(r.ack)||typeof r.ack.tab!=='string'){if(open&&typeof r.initialName==='string'&&r.initialName)linking.add(linkingName(machine,r.initialName));continue;}
    const m=normalizeMeta({key:q.source?.key,title:q.source?.title,kind:q.source?.kind,toolKey:q.toolKey,initial:r.initialName}),tab=tabKey(machine,r.ack.tab);
    meta.set(tab,m);if(open)linking.add(tab);if(typeof q.originId==='string'&&q.originId)meta.set('origin:'+q.originId,mergeMeta(meta.get('origin:'+q.originId),m));
  }catch{}
  return out;
}

/**
 * new TabNameService(io,{owner?,clock?,pollMs?=3000,leaseMs?=12000,names?,closed?,knownNames?,home?})
 *   io: createLaunchIO(herdr) or an equivalent (appHome, read/writeTextFile CAS, spaces, panes, machines, run).
 *   closed: a ReopenController or ClosedWatcher (anything with tick()/release()); its own lease decides who records.
 * Drive it with cx.timer.every(1000, cx => cx.spawn(async c => { if ((await service.tick()).changed) c.notify(); })).
 */
export class TabNameService {
  constructor(io,{owner=randomId('tabs'),clock,pollMs=SERVICE_LIMITS.pollMs,leaseMs=SERVICE_LIMITS.leaseMs,names,closed=null,knownNames=[],home}={}){
    if(!io||typeof io.spaces!=='function'||typeof io.run!=='function'||typeof io.readTextFile!=='function'||typeof io.writeTextFile!=='function')fail('INVALID_SERVICE','The tab service needs live spaces, run and CAS file access.');
    if(!Number.isInteger(pollMs)||pollMs<SERVICE_LIMITS.pollMs||pollMs>SERVICE_LIMITS.maxPollMs)fail('INVALID_SERVICE','Tabs are polled no faster than every 3 seconds.');
    if(!Number.isInteger(leaseMs)||leaseMs<pollMs*2||leaseMs>SERVICE_LIMITS.maxLeaseMs)fail('INVALID_SERVICE','The naming lease must outlast two polls and stay bounded.');
    if(typeof owner!=='string'||!/^[A-Za-z0-9._:-]{1,120}$/.test(owner))fail('INVALID_SERVICE','Invalid service owner.');
    if(closed!==null&&typeof closed?.tick!=='function')fail('INVALID_SERVICE','The close-history watcher needs tick().');
    this.io=io;this.owner=owner;this.clock=clock||(typeof io.clock==='function'?()=>io.clock():()=>Date.now());this.pollMs=pollMs;this.leaseMs=leaseMs;
    this.store=new TabNameStore(io);this.launches=homeOf(io)+'/mission-control/launches.json';
    this.names=names||new NameOwnership(io,{clock:this.clock,owner:owner+'-names'});this.closedSource=closed;this.journal=new ClosedJournal(io,{clock:this.clock});
    this.home=home??(typeof io.home==='function'?io.home():null);this.setKnownNames(knownNames);
    Object.assign(this,{closed:false,epoch:0,running:0,lastPass:-Infinity,closedRunning:0,lastClosed:-Infinity,owned:false,namesLeased:false,observedKey:null,observeRetryAt:0,error:null,
      failures:new Map(),acks:new Map(),closing:new Map(),derived:new Map(),linking:new Set(),forcedAt:-Infinity,journalCache:{raw:undefined,value:launchMetadata(null)}});
  }
  /** Installed tool display names (knownAgents()), so Herdr's own "Claude Code" tab names count as defaults. */
  setKnownNames(list){this.knownNames=(Array.isArray(list)?list:[]).filter(n=>typeof n==='string'&&n&&n.length<=64).slice(0,64);}
  /**
   * Starts whatever is due: the close watcher every CLOSED.observeMs, a naming pass every pollMs.
   * Never runs two of either at once; an interrupted one expires after its stale bound.
   */
  tick(){
    if(this.closed)return Promise.resolve(freeze({ran:false,closed:true,owned:false,renamed:[],changed:false,naming:null,history:null,error:null}));
    const now=this.clock(),jobs=[null,null];
    if(now<this.lastPass)this.lastPass=-Infinity;if(now<this.lastClosed)this.lastClosed=-Infinity;
    const free=(at,stale)=>!at||now<at||now-at>=stale;
    if((this.closedSource||this.closing.size)&&now-this.lastClosed>=CLOSED.observeMs&&free(this.closedRunning,CLOSED.tickStaleMs)){
      this.lastClosed=now;const token=this.closedRunning=now;jobs[0]=this.historyPass().then(r=>{if(this.closedRunning===token)this.closedRunning=0;return r;});
    }
    if(now-this.lastPass>=this.pollMs&&free(this.running,SERVICE_LIMITS.staleMs)){
      this.lastPass=now;const token=this.running=now;jobs[1]=this.pass().then(r=>{if(this.running===token)this.running=0;return r;});
    }
    return Promise.all(jobs).then(([history,naming])=>freeze({ran:Boolean(naming),closed:this.closed,owned:this.owned,renamed:naming?.renamed??[],changed:Boolean(naming?.changed||history?.changed),naming,history,error:naming?.error??null}));
  }
  /** Synchronous live snapshot: ready, non-temporary hosts only. No exec. */
  world(){
    const io=this.io,at=this.clock(),hosts=new Map(),byTab=new Map(),tabs=[];
    for(const m of (typeof io.machines==='function'?io.machines():[{name:null,layout:'ready'}])||[]){if(!m||m.temporary)continue;const name=m.name??null;if(name!==null&&(typeof name!=='string'||!name||name.length>128))continue;hosts.set(JSON.stringify(name),m.layout==='ready');}
    for(const p of (typeof io.panes==='function'?io.panes():[])||[]){if(!p||typeof p.tab!=='string')continue;if(!byTab.has(p.tab))byTab.set(p.tab,[]);const list=byTab.get(p.tab);if(list.length<16)list.push(p);}
    for(const s of io.spaces()||[]){const machine=s?.machine??null;if(hosts.get(JSON.stringify(machine))!==true)continue;for(const t of s?.tabs||[]){if(tabs.length>=SERVICE_LIMITS.tabs)break;try{tabs.push(observeTab(t,byTab.get(t?.id)||[],{machine}));}catch{}}}
    return {at,tabs,ready:m=>hosts.get(JSON.stringify(m??null))===true};
  }
  liveTabs(){const out=[];for(const t of this.world().tabs)out.push({id:t.tabId,tabId:t.tabId,machine:t.machine,name:t.name,named:t.named,key:t.key});return out;}
  /** One naming pass. Returns {owned,renamed,changed,error}; never throws. */
  async pass(){
    const epoch=++this.epoch,alive=()=>!this.closed&&this.epoch===epoch,aborted=()=>freeze({owned:this.owned,renamed:[],changed:false,aborted:true,error:null});
    let world;try{world=this.world();}catch{return this.failed('WORLD_UNAVAILABLE','Live tabs could not be read; no tab was renamed.');}
    const now=world.at;let snapshot;
    try{snapshot=await this.store.read();}catch(error){return this.failed(error?.code||'INVALID_TAB_NAMES',known(error)?error.message:'Tab names could not be read; no tab was renamed.');}
    if(!alive())return aborted();
    if(leaseHeld(snapshot.value.lease,this.owner,now)){this.owned=false;this.error=null;return freeze({owned:false,renamed:[],changed:false,error:null});}
    await this.observe(world,snapshot.value,now);if(!alive())return aborted();
    // Unknown ownership renames nothing: an unreadable names.json could hide a manual name.
    let names;try{names=(await this.names.read()).value;}catch(error){return this.failed(error?.code||'NAMES_UNAVAILABLE',typeof error?.message==='string'&&error.message.length<=300?error.message:'Saved tab names could not be read; no tab was renamed.');}
    if(!alive())return aborted();
    const meta=await this.metadata(world,snapshot.value,now);if(!alive())return aborted();
    const failures=new Map(this.failures);let outcome;
    try{outcome=await this.store.edit(draft=>this.plan(draft,{world,names,meta,failures,now}),{snapshot});}
    catch(error){return this.failed(error?.code||'TAB_NAMES_FAILED',known(error)?error.message:'Tab names could not be saved; no tab was renamed.');}
    const r=outcome.result;if(!r.owned){this.owned=false;this.error=null;return freeze({owned:false,renamed:[],changed:false,error:null});}
    for(const key of failures.keys())this.failures.delete(key);
    this.owned=true;this.error=null;this.derived=r.derived;this.linking=r.linking;
    // An unrecorded edit is waiting for the observer: look again soon, but never more than once per retry interval.
    if(r.hold&&now-this.forcedAt>=SERVICE_LIMITS.observeRetryMs){this.forcedAt=now;this.observedKey=null;}
    if(!alive())return aborted();
    const renamed=[];for(const action of r.actions){if(!alive())break;if(await this.emit(action,epoch))renamed.push({type:action.type,machine:action.machine,tabId:action.tabId,name:action.name});}
    return freeze({owned:true,renamed,changed:Boolean(r.changed||renamed.length),error:null});
  }
  failed(code,message){this.owned=false;this.error=freeze({code,message});return freeze({owned:false,renamed:[],changed:true,error:this.error});}
  /** The draft transition: lease check, one reconcile per eligible tab, sweep, lease renewal. Pure over its inputs. */
  plan(d,{world,names,meta,failures,now}){
    // A stopped copy whose edit retries after a conflict must not take the lease back.
    if(this.closed||leaseHeld(d.lease,this.owner,now))return {write:false,owned:false,actions:[],derived:new Map(),linking:new Set()};
    const before=JSON.stringify([d.tabs,d.retired]),actions=[],derived=new Map(),live=new Set(),linking=new Set();let hold=false;
    for(const obs of world.tabs){
      if(!obs.eligible)continue;live.add(obs.key);const prev=d.tabs[obs.key]||null;
      if(!prev&&Object.keys(d.tabs).length>=NAME_LIMITS.entries)continue;
      const originId=Object.hasOwn(names.tabs,obs.key)?names.tabs[obs.key]:null,own=originId&&Object.hasOwn(names.origins,originId)?names.origins[originId]:null;
      // A young tab an unfinished launch is still linking waits for its origin instead of being renamed as a plain tab.
      const young=!prev||now-prev.firstSeen<SERVICE_LIMITS.linkWindowMs,link=!own&&young&&(meta.linking.has(obs.key)||obs.named&&meta.linking.has(linkingName(obs.machine,obs.name)));
      if(link)linking.add(obs.key);
      let r;try{r=reconcileTab(prev,obs,{own,meta:mergeMeta(meta.get(obs.key),originId?meta.get('origin:'+originId):null),now,home:this.home,knownNames:this.knownNames,retired:d.retired,failed:failures.has(obs.key),emit:actions.length<SERVICE_LIMITS.renamesPerPass,linking:link});}catch{continue;}
      if(r.retiredUsed>=0)d.retired.splice(r.retiredUsed,1);
      d.tabs[obs.key]=r.entry;if(r.action)actions.push(r.action);if(r.reason==='awaiting-observer')hold=true;
      derived.set(obs.key,freeze({name:r.derived?.name??null,full:r.derived?.full??null,basis:r.derived?.basis??null,key:r.derived?.key??null,tool:r.derived?.tool??null,mode:r.entry.mode,reason:r.reason}));
    }
    sweep(d,{live,ready:world.ready,now});
    const changed=JSON.stringify([d.tabs,d.retired])!==before,renew=!d.lease||d.lease.owner!==this.owner||d.lease.expiresAt-now<this.leaseMs/2;
    if(!changed&&!renew)return {write:false,owned:true,actions,derived,changed:false,hold,linking};
    d.lease={owner:this.owner,expiresAt:now+this.leaseMs};return {owned:true,actions,derived,changed,hold,linking};
  }
  /** Bundled TASK-070 observer: records manual edits under names.json's own lease, only when tabs changed. */
  async observe(world,state,now){
    if(now<this.observeRetryAt)return;const tabs=[];
    for(const t of world.tabs){
      // Our own write in flight: a snapshot still showing its old name must not read as a user edit.
      const p=state.tabs[t.key]?.pending;if(p&&t.name===p.from&&t.named===p.fromNamed)continue;
      if(observable(t))tabs.push({id:t.tabId,machine:t.machine,name:t.name,named:t.named});
    }
    const key=JSON.stringify(tabs.map(t=>[t.machine,t.id,t.name,t.named]));if(key===this.observedKey)return;
    try{const r=await this.names.observeNames(tabs,{leaseMs:SERVICE_LIMITS.observeLeaseMs});if(r.owned){this.namesLeased=true;this.observedKey=key;}else this.observeRetryAt=now+SERVICE_LIMITS.observeRetryMs;}
    catch{this.observeRetryAt=now+SERVICE_LIMITS.observeRetryMs;}
  }
  /** Acknowledged launch/resume metadata, read only while some tab is new, still unlinked or being linked. */
  async metadata(world,state,now){
    const out=new Map(),result={get:key=>out.get(key),linking:new Set()};
    for(const [key,a]of this.acks){if(now-a.at>SERVICE_LIMITS.linkWindowMs||now<a.at)this.acks.delete(key);else out.set(key,a.meta);}
    const young=world.tabs.some(t=>{if(!t.eligible)return false;if(this.linking.has(t.key))return true;if(out.has(t.key))return false;const e=state.tabs[t.key];return !e||!e.meta.key&&!e.meta.title&&!e.meta.tool&&now-e.firstSeen<SERVICE_LIMITS.linkWindowMs;});
    if(!young)return result;
    let raw=null;try{raw=await this.io.readTextFile(this.launches);}catch{return result;}
    if(raw!==this.journalCache.raw)this.journalCache={raw,value:launchMetadata(raw)};
    for(const [key,meta]of this.journalCache.value.meta)if(!out.has(key))out.set(key,meta);
    result.linking=this.journalCache.value.linking;return result;
  }
  /** Exact command emission. Origin tabs go through TASK-070 applyName (record, last live check, rename). */
  async emit(a,epoch){
    const rename=args=>{this.io.run('tab.rename',args);},getTabs=()=>this.liveTabs();
    try{
      if(a.type==='automatic'){await this.names.backToAutomatic(a.originId);this.observedKey=null;return false;}
      if(a.originId&&!a.direct){
        // applyName's own CAS has recorded the name by the time it calls rename: that rename always completes.
        const r=await this.names.applyName(a.originId,a.name,{manualTransfer:a.type==='transfer',getTabs,rename});
        if(!r.applied)this.failures.set(a.key,r.reason||'not-applied');return r.applied===true;
      }
      // Plain tab, or finishing our own recorded write: last live guard and the command with no await between.
      const t=getTabs().find(x=>x.key===a.key);
      if(this.closed||this.epoch!==epoch||!t||t.name!==a.from||t.named!==a.fromNamed){this.failures.set(a.key,'changed');return false;}
      rename({id:a.tabId,name:a.name});return true;
    }catch{this.failures.set(a.key,'failed');return false;}
  }
  /** Close-history coordination: the injected watcher's tick, then confirmation of closes this bar made. */
  async historyPass(){
    let result=null;
    if(this.closedSource){try{result=await this.closedSource.tick();}catch{result={owned:false,recorded:[],error:{code:'OBSERVE_FAILED',message:'Closed tabs could not be observed; the saved history was kept.'}}}}
    const recorded=[...(Array.isArray(result?.recorded)?result.recorded:[])];
    if(this.closing.size&&!this.closed){
      const open=new Set(this.liveTabs().map(t=>t.key));
      for(const [key,c]of [...this.closing]){
        if(this.clock()>c.until){this.closing.delete(key);continue;}if(open.has(key))continue;
        try{const r=await this.journal.recordConfirmedClose(c.capture);this.closing.delete(key);if(r.recorded)recorded.push(r.id);}
        catch(error){if(!['NOT_CLOSED','HOST_UNAVAILABLE'].includes(error?.code))this.closing.delete(key);}
        if(this.closed)break;
      }
    }
    return freeze({owned:Boolean(result?.owned),recorded,changed:Boolean(result?.changed)||recorded.length>0,error:result?.error??null});
  }
  /** Metadata from the bar's own acknowledged launch/reopen/resume result, applied on the next pass. */
  acknowledge({machine=null,tabId,key,title,kind,toolKey,toolName}={}){
    try{const k=tabKey(machine,tabId);this.acks.delete(k);this.acks.set(k,{at:this.clock(),meta:normalizeMeta({key,title,kind,toolKey,toolName})});while(this.acks.size>SERVICE_LIMITS.acks)this.acks.delete(this.acks.keys().next().value);return true;}catch{return false;}
  }
  /** The explicit route back to automatic naming: Herdr's own name again (tab.rename ""), recorded on the next pass. */
  requestAutomatic(target){
    if(this.closed)return false;let key;try{key=typeof target==='string'?null:tabKey(target?.machine??null,target?.tabId);}catch{return false;}
    const t=this.liveTabs().find(x=>key?x.key===key:x.id===target);if(!t||!t.named)return false;
    this.io.run('tab.rename',{id:t.id,name:''});this.observedKey=null;return true;
  }
  /** Label for the bar: bounded to NAME_LIMITS.displayPx with the full title for hover. */
  label(tab,{machine=null}={}){
    const name=typeof tab?.name==='string'?tab.name:'';let d=null;try{d=this.derived.get(tabKey(machine,tab?.id))||null;}catch{}
    const ours=Boolean(d?.name)&&d.name===name;
    return freeze({...displayLabel(name,{full:ours?d.full:null}),mode:d?.mode??null,basis:ours?d.basis:null,key:ours?d.key:null,tool:d?.tool??null});
  }
  /** A close this bar performs: snapshot first (best effort), then tab.close; recorded once it is visible. */
  async closeTab(tabId,{confirmed=false}={}){
    if(this.closed)return freeze({ok:false,code:'SERVICE_CLOSED',message:'The tab bar was closed; nothing was done.'});
    if(!this.liveTabs().some(t=>t.id===tabId))return freeze({ok:false,code:'TAB_UNAVAILABLE',message:'That tab is no longer open.'});
    let capture=null;try{capture=await this.journal.captureTab(tabId);}catch{}
    // The person asked for this close; it still happens if this view went away meanwhile.
    const live=this.liveTabs().find(t=>t.id===tabId);if(!live)return freeze({ok:false,code:'TAB_UNAVAILABLE',message:'That tab is no longer open.'});
    this.io.run('tab.close',{id:tabId,...(confirmed?{confirmed:true}:{})});
    if(capture){this.closing.delete(live.key);this.closing.set(live.key,{capture,until:this.clock()+SERVICE_LIMITS.closeConfirmMs});while(this.closing.size>SERVICE_LIMITS.closing)this.closing.delete(this.closing.keys().next().value);}
    return freeze({ok:true,captured:Boolean(capture)});
  }
  /** Best effort: an unreleased lease simply expires. */
  async release(){
    const jobs=[this.store.edit(d=>{if(d.lease?.owner!==this.owner)return {write:false};d.lease=null;return {};}).catch(()=>{})];
    if(this.namesLeased)jobs.push(this.names.releaseLease().catch(()=>{}));
    if(typeof this.closedSource?.release==='function')jobs.push(Promise.resolve().then(()=>this.closedSource.release()).catch(()=>{}));
    await Promise.all(jobs);this.owned=false;
  }
  /** View close: no further pass emits anything; in-flight work is abandoned at its next check. */
  stop(){this.closed=true;this.epoch++;return this.release();}
}
