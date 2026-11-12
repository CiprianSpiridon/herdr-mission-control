import {canonicalRepoPath} from './config.js';
import {machineIdentity,sessionIdentity,localTerminalAddress} from './session-identity.js';
import {BindingStore} from './session-bindings.js';
import {NameOwnership} from './name-ownership.js';

export class ClosedTabsError extends Error {constructor(code,message,recovery){super(message);this.name='ClosedTabsError';this.code=code;if(recovery)this.recovery=recovery;}}
const fail=(code,message,recovery)=>{throw new ClosedTabsError(code,message,recovery);};
/** Every bound the journal, watcher and history import enforce. */
export const LIMITS=Object.freeze({records:100,hosts:32,tabs:400,terminals:8,suppress:64,bytes:900*1024,observeMs:2000,leaseMs:10000,continuityMs:25000,parkedMs:6000,claimMs:60000,tickStaleMs:15000,hydratePerTick:4,hydrateTries:3,historyBytes:4194304,historyMs:5000,historyBatch:80,historyOutput:1048576});
export const KNOWN_AGENTS=new Set(['claude','claude-code','codex','grok','gemini','aider','opencode','cursor-agent','pi','amp','goose','qwen','kiro','kiro-cli','copilot','crush','droid']);
const clone=v=>JSON.parse(JSON.stringify(v));
const freeze=v=>{if(v&&typeof v==='object'&&!Object.isFrozen(v)){for(const c of Object.values(v))freeze(c);Object.freeze(v);}return v;};
const clockOf=io=>io.clock?io.clock():Date.now();
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const time=v=>Number.isSafeInteger(v)&&v>=0;
const utf8=value=>{let n=0;for(const c of value){const p=c.codePointAt(0);n+=p<128?1:p<2048?2:p<65536?3:4;}return n;};
const reserved=new Set(['__proto__','prototype','constructor']);
const text=(v,label,max=256)=>{if(typeof v!=='string'||!v||v.length>max||reserved.has(v)||/[\u0000-\u001f\u007f]/.test(v))fail('INVALID_CLOSED',`Invalid ${label}`);return v;};
/** Titles and names are display text only: control characters collapse and length is bounded. */
export const displayText=(v,max=160)=>{if(typeof v!=='string')return null;const s=v.replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,max).trim();return s||null;};
const folder=v=>{if(typeof v!=='string'||!v||v.length>1024)return null;try{return canonicalRepoPath(v);}catch{return null;}};
const strictFolder=v=>{const path=canonicalRepoPath(v);if(path.length>1024)fail('INVALID_CLOSED','Folder path exceeds its supported length');return path;};
export const hostKey=machine=>JSON.stringify(machineIdentity(machine));
const localId=(id,machine)=>machine&&id.startsWith(machine+'/')?id.slice(machine.length+1):id;
const qualified=(id,machine)=>machine?machine+'/'+localId(id,machine):id;
const safeMachine=v=>{try{return machineIdentity(v);}catch{return undefined;}};
export function digest(value){let a=2166136261,b=0x9e3779b9;for(let i=0;i<value.length;i++){const c=value.charCodeAt(i);a=Math.imul(a^c,16777619);b=Math.imul(b^c,2246822519);}return [a>>>0,b>>>0].map(n=>n.toString(16).padStart(8,'0')).join('');}
const isConflict=e=>['STALE','CONFLICT','EAGAIN'].includes(e?.code)||/stale|contents?.*changed|expected.*match|compare.and.set/i.test(e?.message||'');
const randomId=prefix=>prefix+'-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,10);
const safeProgram=p=>p&&typeof p.key==='string'&&/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(p.key)?{key:p.key,name:displayText(p.name,128)||p.key}:null;

function program(v){if(v===null)return null;if(!plain(v))fail('INVALID_CLOSED','Invalid program identity');const p=safeProgram(v);if(!p)fail('INVALID_CLOSED','Invalid program identity');return p;}
function terminal(t,machine,{snapshot=false}={}){
  if(!plain(t)||typeof t.agent!=='boolean'||t.createdMs!==null&&!time(t.createdMs))fail('INVALID_CLOSED','Invalid closed terminal');
  const address=text(t.address,'terminal address');let local;try{local=localTerminalAddress(address,machine);}catch{fail('INVALID_CLOSED','A terminal address does not belong to its machine');}
  if(qualified(local,machine)!==address)fail('INVALID_CLOSED','A terminal address is not machine-qualified');
  const r={address,createdMs:t.createdMs,startCwd:t.startCwd===null?null:strictFolder(t.startCwd),program:program(t.program),agent:t.agent,title:t.title===null?null:displayText(t.title)};
  if(snapshot){if(!Number.isSafeInteger(t.tries)||t.tries<0||t.tries>9)fail('INVALID_CLOSED','Invalid hydration state');r.tries=t.tries;return r;}
  if(t.session!==undefined){const s=sessionIdentity(t.session);if(s.machine!==machine)fail('INVALID_CLOSED','A closed session belongs to another machine');r.session=s;}
  for(const f of ['requestId','originId'])if(t[f]!==undefined)r[f]=text(t[f],f);
  if(t.toolKey!==undefined)r.toolKey=text(t.toolKey,'tool key',96);
  for(const f of ['repoRoot','checkoutRoot'])if(t[f]!==undefined)r[f]=strictFolder(t[f]);
  return r;
}
const nullable=(v,fn)=>v===null?null:fn(v);
function spaceInfo(s){if(!plain(s)||typeof s.named!=='boolean')fail('INVALID_CLOSED','Invalid space');return {id:text(s.id,'space ID'),name:nullable(s.name,v=>displayText(v)),named:s.named,folder:nullable(s.folder,strictFolder)};}
function index(v){if(v!==null&&!(Number.isSafeInteger(v)&&v>0&&v<100000))fail('INVALID_CLOSED','Invalid tab position');return v;}
const ack=v=>({space:text(v?.space,'acknowledged space'),tab:text(v?.tab,'acknowledged tab'),terminal:text(v?.terminal,'acknowledged terminal')});
const SOURCES=['observed','confirmed','imported'],PHASES=['claimed','attempting','acknowledged'];
function record(r){
  if(!plain(r)||typeof r.id!=='string'||!/^c-[0-9a-f]{16}$/.test(r.id)||!time(r.seq)||!SOURCES.includes(r.source)||typeof r.ordered!=='boolean'||!time(r.closedAt)||!['shell','agent'].includes(r.kind))fail('INVALID_CLOSED','Invalid closed record');
  const machine=machineIdentity(r.machine),space=spaceInfo(r.space);if(r.space.replacement!==undefined)space.replacement=text(r.space.replacement,'replacement space');
  if(!plain(r.tab)||typeof r.tab.named!=='boolean')fail('INVALID_CLOSED','Invalid closed tab');
  const tab={id:text(r.tab.id,'tab ID'),name:nullable(r.tab.name,v=>displayText(v,200)),named:r.tab.named,index:index(r.tab.index)};
  if(!Array.isArray(r.terminals)||!r.terminals.length||r.terminals.length>LIMITS.terminals)fail('INVALID_CLOSED','A closed tab needs one to eight terminals');
  const terminals=r.terminals.map(t=>terminal(t,machine));
  if(!Number.isSafeInteger(r.panes)||r.panes<terminals.length||r.panes>64)fail('INVALID_CLOSED','Invalid pane count');
  let origin=null;if(r.origin!==null){if(!plain(r.origin)||!['auto','manual'].includes(r.origin.mode))fail('INVALID_CLOSED','Invalid name ownership');origin={originId:text(r.origin.originId,'origin ID'),mode:r.origin.mode,manualName:nullable(r.origin.manualName,v=>text(v,'manual name',512))};if(origin.mode==='manual'&&!origin.manualName)fail('INVALID_CLOSED','A manual name is required');}
  let claim=null;if(r.claim!==null){if(!plain(r.claim)||!PHASES.includes(r.claim.phase)||!time(r.claim.until)||!time(r.claim.at))fail('INVALID_CLOSED','Invalid reopen claim');claim={owner:text(r.claim.owner,'claim owner'),until:r.claim.until,requestId:text(r.claim.requestId,'request ID'),phase:r.claim.phase,at:r.claim.at};if(r.claim.ack!==undefined)claim.ack=ack(r.claim.ack);if(r.claim.scaffold!==undefined)claim.scaffold=ack(r.claim.scaffold);}
  let error=null;if(r.error!==null){if(!plain(r.error)||!time(r.error.at))fail('INVALID_CLOSED','Invalid reopen error');error={code:text(r.error.code,'error code',64),message:displayText(r.error.message,512)||'Reopen failed.',at:r.error.at};}
  return {id:r.id,seq:r.seq,source:r.source,ordered:r.ordered,closedAt:r.closedAt,machine,kind:r.kind,space,tab,terminals,panes:r.panes,origin,claim,error};
}
function host(key,h){
  if(!plain(h)||!['ready','unavailable'].includes(h.state)||!time(h.observedAt)||!Number.isSafeInteger(h.limit)||h.limit<0||h.limit>LIMITS.tabs||typeof h.truncated!=='boolean'||!plain(h.spaces)||!plain(h.tabs))fail('INVALID_CLOSED','Invalid host snapshot');
  const machine=machineIdentity(h.machine);if(hostKey(machine)!==key)fail('INVALID_CLOSED','A host snapshot does not match its key');
  if(Object.keys(h.tabs).length>LIMITS.tabs||Object.keys(h.spaces).length>LIMITS.tabs)fail('INVALID_CLOSED','A host snapshot exceeds its bounds');
  const spaces={},tabs={};for(const [id,s]of Object.entries(h.spaces))spaces[text(id,'space ID')]=spaceInfo(s);
  for(const [id,t]of Object.entries(h.tabs)){
    if(!plain(t)||typeof t.named!=='boolean'||!Number.isSafeInteger(t.panes)||t.panes<0||t.panes>64||!Array.isArray(t.terms)||t.terms.length>LIMITS.terminals)fail('INVALID_CLOSED','Invalid tab snapshot');
    const x={id:text(t.id,'tab ID'),space:text(t.space,'space ID'),index:index(t.index),name:nullable(t.name,v=>displayText(v,200)),named:t.named,panes:t.panes,terms:t.terms.map(v=>terminal(v,machine,{snapshot:true}))};
    if(t.parkedSince!==undefined){if(!time(t.parkedSince))fail('INVALID_CLOSED','Invalid parked time');x.parkedSince=t.parkedSince;}
    tabs[text(id,'tab ID')]=x;
  }
  return {machine,state:h.state,observedAt:h.observedAt,limit:h.limit,truncated:h.truncated,spaces,tabs};
}
export const emptyJournal=()=>({v:1,revision:0,seq:0,lease:null,hosts:{},records:[],suppress:[],imports:{}});
/** Closed-tab journal v1. Invalid data is rejected whole; the caller never rewrites it. */
export function validateClosedJournal(value){
  try{
    if(!plain(value)||value.v!==1||!time(value.revision)||!time(value.seq)||!plain(value.hosts)||!Array.isArray(value.records)||!Array.isArray(value.suppress)||!plain(value.imports))fail('INVALID_CLOSED','Invalid journal');
    if(value.records.length>LIMITS.records||Object.keys(value.hosts).length>LIMITS.hosts||value.suppress.length>LIMITS.suppress||Object.keys(value.imports).length>LIMITS.hosts)fail('INVALID_CLOSED','Journal bounds exceeded');
    let lease=null;if(value.lease!==null){if(!plain(value.lease)||!time(value.lease.expiresAt))fail('INVALID_CLOSED','Invalid watcher lease');lease={owner:text(value.lease.owner,'lease owner'),expiresAt:value.lease.expiresAt};}
    const records=value.records.map(record);if(new Set(records.map(r=>r.id)).size!==records.length)fail('INVALID_CLOSED','Duplicate closed record');
    const hosts={};for(const [key,h]of Object.entries(value.hosts))hosts[key]=host(key,h);
    const suppress=value.suppress.map(s=>{if(!plain(s)||!time(s.until))fail('INVALID_CLOSED','Invalid suppression');return {machine:machineIdentity(s.machine),tab:text(s.tab,'tab ID'),until:s.until};});
    const imports={};for(const [key,i]of Object.entries(value.imports)){if(!plain(i)||!time(i.at)||!['complete','partial','unavailable'].includes(i.state)||i.cursor!==null&&!/^t[0-9a-z]{1,63}$/.test(i.cursor))fail('INVALID_CLOSED','Invalid import state');hostKey(JSON.parse(key));imports[key]={at:i.at,state:i.state,reason:nullable(i.reason,v=>displayText(v,300)),cursor:i.cursor};}
    return {v:1,revision:value.revision,seq:value.seq,lease,hosts,records,suppress,imports};
  }catch{throw new ClosedTabsError('INVALID_CLOSED','Closed-tab history is invalid; the original file was kept unchanged.');}
}
/** Observed and confirmed closes first in proven order, then imported history newest first. */
export function sortRecords(records){return records.sort((a,b)=>(a.source==='imported')-(b.source==='imported')||(a.source==='imported'?b.closedAt-a.closedAt:b.seq-a.seq)||(a.id<b.id?-1:1));}
function boundRecords(d,now){
  sortRecords(d.records);
  while(d.records.length>LIMITS.records){const pool=d.records.filter(r=>!(r.claim&&r.claim.until>now)),victim=[...pool].reverse().find(r=>r.source==='imported')||pool.at(-1);if(!victim)break;d.records.splice(d.records.indexOf(victim),1);}
}
function fit(next){
  let body=JSON.stringify(next)+'\n';
  while(utf8(body)>LIMITS.bytes){
    const hosts=Object.values(next.hosts).filter(h=>Object.keys(h.tabs).length).sort((a,b)=>Object.keys(b.tabs).length-Object.keys(a.tabs).length);
    if(hosts.length){const h=hosts[0],ids=Object.keys(h.tabs);h.limit=Math.floor(ids.length/2);for(const id of ids.slice(h.limit))delete h.tabs[id];h.truncated=true;}
    else if(next.records.length)next.records.pop();
    else fail('CLOSED_CAPACITY','Closed-tab history cannot fit its size limit.');
    body=JSON.stringify(next)+'\n';
  }
  return body;
}
const generations=r=>new Set((r.terminals||r.terms).filter(t=>t.createdMs!==null&&t.createdMs!==undefined).map(t=>JSON.stringify([t.address,t.createdMs])));
/** One closure: same machine and tab, and any known terminal generation in common. */
export function sameClosure(a,b){if(a.machine!==b.machine||localId(a.tab.id,a.machine)!==localId(b.tab.id,b.machine))return false;const x=generations(a),y=generations(b);return !x.size||!y.size||[...x].some(g=>y.has(g));}

export class ClosedJournal {
  constructor(io,{clock}={}){this.io=io;this.clock=clock||(()=>clockOf(io));const home=typeof io.appHome==='function'?io.appHome():io.appHome;if(typeof home!=='string'||!home||/[\u0000-\u001f]/.test(home))fail('CLOSED_PATH','The Herdr app home is unavailable.');this.path=home.replace(/[/\\]+$/,'')+'/mission-control/closed.json';}
  async read(){
    const raw=await this.io.readTextFile(this.path);if(raw===null)return {raw,value:emptyJournal()};
    if(typeof raw!=='string'||utf8(raw)>LIMITS.bytes+65536)fail('INVALID_CLOSED','Closed-tab history exceeds its supported size; the original file was kept unchanged.');
    let data;try{data=JSON.parse(raw);}catch{fail('INVALID_CLOSED','Closed-tab history is not valid JSON; the original file was kept unchanged.');}
    return {raw,value:validateClosedJournal(data)};
  }
  /** fn(draft,now) is synchronous; {write:false} skips the write. Conflicts re-read and re-apply. */
  async edit(fn,{snapshot}={}){
    for(let attempt=0;attempt<4;attempt++){
      const {raw,value}=attempt===0&&snapshot?snapshot:await this.read(),draft=clone(value),result=fn(draft,this.clock())||{};
      if(result.write===false)return {value,result};
      draft.revision++;if(!Number.isSafeInteger(draft.revision))fail('CLOSED_CAPACITY','Closed-tab history revision exhausted.');
      const next=validateClosedJournal(draft),body=fit(next);
      await this.io.ensureDirectory?.(this.path.slice(0,this.path.lastIndexOf('/')));
      try{await this.io.writeTextFile(this.path,body,raw);return {value:next,result};}catch(e){if(!isConflict(e))throw e;}
    }
    fail('CONFLICT','Closed-tab history changed repeatedly; nothing stale was written.');
  }
  async claim(id,owner,{confirmUncertain=false}={}){
    text(owner,'claim owner');
    return (await this.edit((d,now)=>{
      const r=d.records.find(x=>x.id===id);if(!r)fail('RECORD_GONE','This closed tab was already reopened or forgotten.');
      const c=r.claim;
      if(c&&c.owner!==owner&&c.until>now)fail('REOPEN_IN_PROGRESS','This closed tab is already being reopened; wait for it to appear.',{recordId:id});
      if(c?.phase==='attempting'&&!confirmUncertain)fail('TAB_CREATE_UNCERTAIN','An earlier reopen of this tab was interrupted after Herdr was asked to create it. Check its space first; open it again only if it is missing.',{recordId:id});
      r.claim={owner,until:now+LIMITS.claimMs,requestId:c?.requestId||'reopen-'+r.id.slice(2),phase:c?.phase==='acknowledged'?'acknowledged':'claimed',at:now,...(c?.ack?{ack:c.ack}:{}),...(c?.scaffold?{scaffold:c.scaffold}:{})};
      r.error=null;return clone(r);
    })).result;
  }
  async updateClaim(id,owner,patch,{replacement}={}){
    return (await this.edit((d,now)=>{
      const r=d.records.find(x=>x.id===id);if(!r||r.claim?.owner!==owner)fail('CLAIM_LOST','Another reopen took over this closed tab; nothing more was done.');
      Object.assign(r.claim,clone(patch),{until:now+LIMITS.claimMs});if(replacement)r.space.replacement=text(replacement,'replacement space');return clone(r);
    })).result;
  }
  /** Removes a record only for the claim that acknowledged its replacement. */
  async consume(id,owner){return (await this.edit(d=>{const i=d.records.findIndex(x=>x.id===id);if(i<0)return {write:false,consumed:false};if(d.records[i].claim?.owner!==owner)fail('CLAIM_LOST','Another reopen took over this closed tab.');d.records.splice(i,1);return {consumed:true};})).result;}
  /** A definite failure frees the record; uncertain creation and acknowledged/scaffold state stay for explicit recovery. */
  async release(id,owner,error){
    return (await this.edit((d,now)=>{
      const r=d.records.find(x=>x.id===id);if(!r||r.claim?.owner!==owner)return {write:false};
      if(r.claim.phase==='attempting'&&error?.definite)r.claim.phase='claimed';
      if(r.claim.phase!=='claimed'||r.claim.scaffold)r.claim.until=now;else r.claim=null;
      r.error=error?{code:text(error.code,'error code',64),message:displayText(error.message,512)||'Reopen failed.',at:now}:null;return {};
    })).result;
  }
  async dismiss(id,{owner}={}){
    return (await this.edit((d,now)=>{const i=d.records.findIndex(x=>x.id===id);if(i<0)return {write:false,dismissed:false};const c=d.records[i].claim;if(c&&c.until>now&&c.owner!==owner)fail('REOPEN_IN_PROGRESS','This closed tab is being reopened; wait for it before forgetting it.');d.records.splice(i,1);return {dismissed:true};})).result;
  }
  /** Before this mod (or a bundling tab bar) closes its own transient tab, so the close is not recorded. */
  async expectClose(machine,tabId,{ms=30000}={}){
    const m=machineIdentity(machine);text(tabId,'tab ID');
    return (await this.edit((d,now)=>{d.suppress=d.suppress.filter(s=>s.until>now&&!(s.machine===m&&s.tab===tabId));d.suppress.push({machine:m,tab:tabId,until:now+Math.min(Math.max(ms,1000),120000)});d.suppress=d.suppress.slice(-LIMITS.suppress);})).value;
  }
  /** Snapshot a live tab before an owned tab.close; recordConfirmedClose stores it once the close is visible. */
  async captureTab(tabId,world=snapshotWorld(this.io)){
    text(tabId,'tab ID');
    for(const [key,live]of world.hosts){
      if(!live.ready)continue;const tid=localId(tabId,live.machine),tab=live.tabs[tid];if(!tab||tab.id!==tabId)continue;
      let prev=null;try{prev=(await this.read()).value.hosts[key];}catch{}
      const old=continuity(prev,world.at)?prev.tabs[tid]:null,terms=[];
      for(const t of tab.terms){let x=carry(t,old?.terms.find(o=>o.address===t.address));if(x.createdMs===null)x=carry(t,null,await hydrate(this.io,{machine:live.machine,address:t.address}));terms.push(x);}
      return freeze({machine:live.machine,tab:{...clone(tab),terms},space:live.spaces[tab.space]?clone(live.spaces[tab.space]):null,capturedAt:world.at});
    }
    fail('TAB_UNAVAILABLE','That tab is not open on a ready machine; nothing was captured.');
  }
  async recordConfirmedClose(capture,world=snapshotWorld(this.io)){
    if(!capture?.tab?.id||!Array.isArray(capture.tab.terms))fail('INVALID_CLOSED','A captured tab is required.');
    const machine=machineIdentity(capture.machine),key=hostKey(machine),live=world.hosts.get(key),tid=localId(capture.tab.id,machine);
    if(!live?.ready)fail('HOST_UNAVAILABLE','The tab’s machine is unavailable, so its close cannot be confirmed yet.');
    if(live.tabs[tid])fail('NOT_CLOSED','The tab is still open; nothing was recorded.');
    if(!capture.tab.terms.length)return freeze({id:null,duplicate:false,recorded:false});
    const enrichment=await enrichmentFor(this.io,[{machine,tab:capture.tab}]);
    return freeze((await this.edit((d,now)=>{
      const extra=enrichment.get(JSON.stringify([machine,capture.tab.id])),closed=closedRecord({machine,tab:capture.tab,space:capture.space},{source:'confirmed',closedAt:now,seq:d.seq+1,extra});
      if(d.hosts[key]?.tabs[tid])delete d.hosts[key].tabs[tid];
      const existing=d.records.find(r=>sameClosure(r,closed));if(existing)return {id:existing.id,duplicate:true,recorded:false};
      d.seq++;d.records.push(closed);boundRecords(d,now);return {id:closed.id,duplicate:false,recorded:true};
    })).result);
  }
}

/** Cheap synchronous snapshot of live data. No exec and no terminal argv. */
export function snapshotWorld(api,at=clockOf(api)){
  const hosts=new Map(),list=typeof api.machines==='function'?api.machines()||[]:[{name:null,layout:'ready'}];
  for(const m of list){if(!m||m.temporary)continue;const machine=safeMachine(m.name);if(machine===undefined)continue;hosts.set(hostKey(machine),{machine,ready:m.layout==='ready',spaces:{},tabs:{}});}
  const spaces=api.spaces()||[],machineOf=new Map(),byTab=new Map(),agents=new Set();
  for(const s of spaces){const m=safeMachine(s?.machine);if(m!==undefined&&typeof s.id==='string')machineOf.set(s.id,m);}
  for(const a of (typeof api.agents==='function'?api.agents():[])||[]){const m=machineOf.get(a?.space);if(m===undefined)continue;try{agents.add(qualified(localTerminalAddress(a.address,m),m));}catch{}}
  for(const p of (typeof api.panes==='function'?api.panes():[])||[]){if(!p||typeof p.tab!=='string')continue;if(!byTab.has(p.tab))byTab.set(p.tab,[]);byTab.get(p.tab).push(p);}
  for(const s of spaces){
    const machine=machineOf.get(s?.id);if(machine===undefined)continue;const h=hosts.get(hostKey(machine));if(!h?.ready)continue;
    let sid;try{sid=text(localId(text(s.id,'space ID'),machine),'space ID');}catch{continue;}
    h.spaces[sid]={id:s.id,name:displayText(s.name),named:s.named===true,folder:folder(s.folder)};
    for(const t of s.tabs||[]){
      let tid;try{tid=text(localId(text(t?.id,'tab ID'),machine),'tab ID');}catch{continue;}
      const panes=byTab.get(t.id)||[],terms=[];
      for(const p of panes){
        if(!p.terminal||terms.length>=LIMITS.terminals)continue;let address;try{address=qualified(localTerminalAddress(p.terminal,machine),machine);}catch{continue;}
        terms.push({address,program:safeProgram(p.program),agent:p.program?.agent===true||agents.has(address)||Boolean(p.status)||Boolean(p.app),title:displayText(p.title)});
      }
      h.tabs[tid]={id:t.id,space:sid,index:Number.isSafeInteger(t.index)&&t.index>0&&t.index<100000?t.index:null,name:displayText(t.name,200),named:t.named===true,panes:Math.min(Math.max(Number.isSafeInteger(t.panes)?t.panes:0,panes.length),64),terms};
    }
  }
  const live=new Set();for(const t of (typeof api.terminals==='function'?api.terminals():[])||[])if(t&&t.state==='live'&&typeof t.address==='string')live.add(t.address);
  return {at,hosts,live};
}
function continuity(prev,now){return Boolean(prev&&prev.state==='ready'&&now>=prev.observedAt&&now-prev.observedAt<=LIMITS.continuityMs);}
function carry(t,old,h){
  const x={address:t.address,createdMs:old?.createdMs??null,startCwd:old?.startCwd??null,program:t.program??old?.program??null,agent:Boolean(t.agent||old?.agent),title:t.title??old?.title??null,tries:old?.tries??0};
  if(h&&x.createdMs===null){if(h.failed)x.tries=Math.min(x.tries+1,9);else{x.createdMs=h.createdMs;x.startCwd=h.startCwd;}}
  return x;
}
/** Full terminal data only for its generation and starting folder; raw argv never leaves this function. */
async function hydrate(io,{machine,address}){
  try{
    const local=localTerminalAddress(address,machine),r=await io.exec('hc',['get',local,'--json'],{on:machine});
    if(r?.code!==0||typeof r.stdout!=='string'||r.stdout.length>LIMITS.historyOutput)return {failed:true};
    const raw=JSON.parse(r.stdout);if(localTerminalAddress(raw?.address,machine)!==local||!time(raw.created_ms))return {failed:true};
    return {createdMs:raw.created_ms,startCwd:folder(raw.cwd)};
  }catch{return {failed:true};}
}
function hydrationNeeds(value,world){
  const needs=[];
  for(const [key,live]of world.hosts){
    if(!live.ready)continue;const prev=value.hosts[key],keep=continuity(prev,world.at),limit=prev?.limit??LIMITS.tabs;
    for(const [tid,tab]of Object.entries(live.tabs).slice(0,limit))for(const t of tab.terms){
      const old=keep?prev.tabs[tid]?.terms.find(o=>o.address===t.address):null;if(old?.createdMs!=null||(old?.tries??0)>=LIMITS.hydrateTries)continue;
      needs.push({machine:live.machine,address:t.address});if(needs.length>=LIMITS.hydratePerTick)return needs;
    }
  }
  return needs;
}
function closures(value,world){
  const found=[];
  for(const [key,live]of world.hosts){
    const prev=value.hosts[key];if(!live.ready||!continuity(prev,world.at))continue;
    for(const [tid,old]of Object.entries(prev.tabs)){
      if(live.tabs[tid]||!old.terms.length||value.suppress.some(s=>s.machine===live.machine&&s.tab===old.id&&s.until>world.at)||old.terms.some(t=>world.live.has(t.address)))continue;
      found.push({machine:live.machine,tab:old});
    }
  }
  return found;
}
async function launchRequests(io){
  const home=(typeof io.appHome==='function'?io.appHome():io.appHome).replace(/[/\\]+$/,''),raw=await io.readTextFile(home+'/mission-control/launches.json');if(typeof raw!=='string')return {};
  let value;try{value=JSON.parse(raw);}catch{return {};}if(value?.v!==1||!plain(value.requests))return {};
  const out={};for(const [id,r]of Object.entries(value.requests))try{const q=r.request;out[id]={machine:machineIdentity(q.machine),repoRoot:strictFolder(q.repoRoot),checkoutRoot:strictFolder(r.folder??q.checkoutRoot??q.repoRoot),toolKey:text(q.toolKey,'tool key',96)};}catch{}
  return out;
}
/** Exact provider identity comes only from committed (or later invalidated) acknowledged bindings. */
async function enrichmentFor(io,candidates){
  const out=new Map();if(!candidates.length)return out;let proposals={},names=null,requests={};
  try{proposals=(await new BindingStore(io,{clock:()=>clockOf(io)}).read()).value.proposals;}catch{}
  try{names=(await new NameOwnership(io).read()).value;}catch{}
  try{requests=await launchRequests(io);}catch{}
  for(const c of candidates){
    const terminals=new Map();
    for(const t of c.tab.terms){
      let best=null;
      for(const [requestId,b]of Object.entries(proposals)){
        if(!['committed','invalidated'].includes(b.state)||!b.session||!b.ack||b.ack.tabId!==c.tab.id)continue;
        const term=b.ack.terminal;if(term.machine!==c.machine||term.address!==t.address||t.createdMs!=null&&term.createdMs!==t.createdMs)continue;
        if(!best||b.updatedAt>best.b.updatedAt)best={requestId,b};
      }
      if(!best)continue;
      const x={session:clone(best.b.session),requestId:best.requestId,originId:best.b.originId},launch=requests[best.requestId];
      if(launch&&launch.machine===c.machine){x.repoRoot=launch.repoRoot;x.checkoutRoot=launch.checkoutRoot;x.toolKey=launch.toolKey;}
      terminals.set(t.address,x);
    }
    const originId=names?.tabs?.[JSON.stringify([c.machine,c.tab.id])],o=originId?names.origins[originId]:null;
    out.set(JSON.stringify([c.machine,c.tab.id]),{terminals,origin:o?{originId:o.originId,mode:o.mode,manualName:o.mode==='manual'?o.manualName:null}:null});
  }
  return out;
}
function closedRecord({machine,tab,space},{source,closedAt,seq,extra,ordered=true}){
  const terminals=tab.terms.slice(0,LIMITS.terminals).map(t=>{const x={address:t.address,createdMs:t.createdMs??null,startCwd:t.startCwd??null,program:t.program??null,agent:Boolean(t.agent),title:t.title??null},b=extra?.terminals?.get(t.address);if(b){Object.assign(x,clone(b));x.agent=true;}return x;});
  const id='c-'+digest(JSON.stringify([machine,tab.id,source,closedAt,seq,terminals.map(t=>[t.address,t.createdMs])]));
  return {id,seq:source==='imported'?0:seq,source,ordered,closedAt,machine,kind:terminals.some(t=>t.agent)?'agent':'shell',
    space:{id:space?.id||qualified(tab.space,machine),name:space?.name??null,named:space?.named===true,folder:space?.folder??null},tab:{id:tab.id,name:tab.name??null,named:tab.named===true,index:tab.index??null},
    terminals,panes:Math.min(Math.max(tab.panes??0,terminals.length),64),origin:extra?.origin?clone(extra.origin):null,claim:null,error:null};
}
const structure=d=>JSON.stringify([Object.entries(d.hosts).map(([k,h])=>[k,h.state,h.limit,h.truncated,h.spaces,Object.entries(h.tabs).map(([id,t])=>[id,t.space,t.index,t.name,t.named,t.panes,t.parkedSince,t.terms.map(x=>[x.address,x.createdMs,x.startCwd,x.program,x.agent,x.tries])])]),d.records.map(r=>r.id),d.suppress]);
/**
 * Applies one observation. A disappearance is a close only when the same host was
 * ready in the previous persisted observation (within continuityMs) and is ready now.
 * Offline, reconnecting, restarted or stale hosts rebaseline without inventing closes.
 */
function observeDraft(draft,world,{owner,hydrated,enrichment}){
  const now=world.at,lease=draft.lease;
  if(lease&&lease.owner!==owner&&lease.expiresAt>now)return {write:false,owned:false,changed:false,recorded:[]};
  const before=structure(draft),recorded=[];draft.suppress=draft.suppress.filter(s=>s.until>now);
  for(const [key,live]of world.hosts){
    const prev=draft.hosts[key];
    if(!live.ready){if(prev?.state!=='unavailable')draft.hosts[key]={machine:live.machine,state:'unavailable',observedAt:now,limit:prev?.limit??LIMITS.tabs,truncated:false,spaces:{},tabs:{}};continue;}
    const keep=continuity(prev,now),limit=prev?.limit??LIMITS.tabs,entries=Object.entries(live.tabs),tabs={};
    for(const [tid,tab]of entries.slice(0,limit)){const old=keep?prev.tabs[tid]:null;tabs[tid]={...tab,terms:tab.terms.map(t=>carry(t,old?.terms.find(o=>o.address===t.address),hydrated.get(t.address)))};}
    if(keep)for(const [tid,old]of Object.entries(prev.tabs)){
      if(live.tabs[tid]||!old.terms.length)continue;
      const s=draft.suppress.findIndex(x=>x.machine===live.machine&&x.tab===old.id);if(s>=0){draft.suppress.splice(s,1);continue;}
      // A pane that went away with its terminal still live was parked, not closed. Its exit may lag the tab, so wait briefly.
      if(old.terms.some(t=>world.live.has(t.address))){const since=old.parkedSince??now;if(now-since<LIMITS.parkedMs)tabs[tid]={...old,parkedSince:since};continue;}
      const extra=enrichment.get(JSON.stringify([live.machine,old.id]));if(!extra){tabs[tid]=old;continue;}
      const closed=closedRecord({machine:live.machine,tab:old,space:live.spaces[old.space]||prev.spaces[old.space]||null},{source:'observed',closedAt:now,seq:draft.seq+1,extra});
      if(draft.records.some(r=>sameClosure(r,closed)))continue;
      draft.seq++;draft.records.push(closed);recorded.push(closed.id);
    }
    const spaces={};for(const t of Object.values(tabs)){const info=live.spaces[t.space]||prev?.spaces[t.space];if(info)spaces[t.space]=info;}
    draft.hosts[key]={machine:live.machine,state:'ready',observedAt:prev?.observedAt??now,limit,truncated:entries.length>limit,spaces,tabs};
  }
  for(const [key,h]of Object.entries(draft.hosts))if(!world.hosts.has(key)&&h.state!=='unavailable')draft.hosts[key]={...h,state:'unavailable',observedAt:now,spaces:{},tabs:{}};
  const stale=Object.entries(draft.hosts).filter(([,h])=>h.state==='unavailable').sort(([,a],[,b])=>a.observedAt-b.observedAt);
  while(Object.keys(draft.hosts).length>LIMITS.hosts&&stale.length)delete draft.hosts[stale.shift()[0]];
  boundRecords(draft,now);
  const changed=structure(draft)!==before,renew=!lease||lease.owner!==owner||lease.expiresAt-now<LIMITS.leaseMs/2;
  if(!changed&&!renew)return {write:false,owned:true,changed:false,recorded};
  draft.lease={owner,expiresAt:now+LIMITS.leaseMs};for(const h of Object.values(draft.hosts))if(h.state==='ready')h.observedAt=now;
  return {write:true,owned:true,changed,recorded};
}

/** The single per-app-home observer. Every copy may tick; only the CAS lease holder observes. */
export class ClosedWatcher {
  constructor(io,{owner=randomId('watch'),clock}={}){this.io=io;this.owner=text(owner,'watcher owner');this.journal=new ClosedJournal(io,{clock});this.clock=this.journal.clock;this.started=0;this.owned=false;}
  async tick(){
    const at=this.clock();
    // An interrupted continuation never reaches the reset below; staleness frees the slot instead.
    if(this.started&&at-this.started<LIMITS.tickStaleMs)return Object.freeze({owned:this.owned,skipped:true,recorded:[]});
    this.started=at;
    try{const result=await this.observe();this.started=0;return result;}
    catch(error){this.started=0;this.owned=false;return Object.freeze({owned:false,recorded:[],error:Object.freeze({code:error?.code||'OBSERVE_FAILED',message:error instanceof ClosedTabsError?error.message:'Closed tabs could not be observed; the saved history was kept.'})});}
  }
  async observe(){
    const snapshot=await this.journal.read(),value=snapshot.value,lease=value.lease,world=snapshotWorld(this.io,this.clock());
    if(lease&&lease.owner!==this.owner&&lease.expiresAt>world.at){this.owned=false;return Object.freeze({owned:false,changed:false,recorded:[],value});}
    const hydrated=new Map();for(const need of hydrationNeeds(value,world))hydrated.set(need.address,await hydrate(this.io,need));
    const enrichment=await enrichmentFor(this.io,closures(value,world));
    const {value:next,result}=await this.journal.edit(d=>observeDraft(d,world,{owner:this.owner,hydrated,enrichment}),{snapshot});
    this.owned=result.owned;return Object.freeze({owned:result.owned,changed:Boolean(result.changed),recorded:Object.freeze([...result.recorded]),value:next});
  }
  async release(){return this.journal.edit(d=>{if(d.lease?.owner!==this.owner)return {write:false};d.lease=null;return {};});}
}

/**
 * Runs on the history's own host via exec("python3",["-c",HISTORY_WRAPPER,request],{on}).
 * It reads hc output with one shared byte/time budget, kills only its own hc client,
 * and emits safe labels/generations/folders only: never argv or terminal text.
 */
export const HISTORY_WRAPPER=String.raw`
import json,os,re,select,subprocess,sys,time
q=json.loads(sys.argv[1])
CAP=max(1,min(int(q.get("maxBytes",4194304)),4194304))
END=time.monotonic()+max(100,min(int(q.get("timeoutMs",5000)),5000))/1000.0
LIMIT=max(1,min(int(q.get("limit",100)),100))
BATCH=max(1,min(int(q.get("batch",80)),200))
ADDR=re.compile(r"t[0-9a-z]{1,63}")
ID=re.compile(r"[^\x00-\x1f\x7f]{1,256}")
NAME=re.compile(r"[a-z0-9][a-z0-9._+-]{0,63}")
# Herdr login wrappers: local "-lic" and the remote "-c" form (split so the JS template never interpolates).
WRAPS={"-lic":'"$@"; exec "$0" -li',"-c":'"$@"; exec "$' '{SHELL:-sh}" -i'}
# Herdr 0.1.13 remote launches: sh -c '<login-shell dispatcher>' sh <program...> (tests/fixtures/herdr-0113-launch-argv.json).
DISPATCH='shell=$' '{SHELL:-/bin/sh}\ncase "$' '{shell##*/}" in\n  fish) exec "$shell" -lic \'command $argv[2..]; exec $argv[1] -li\' "$shell" "$@" ;;\n  sh|bash|zsh|dash|ksh) exec "$shell" -lic \'"$@"; exec "$0" -li\' "$shell" "$@" ;;\n  *) exec sh -c \'"$@"; exec "$' '{SHELL:-sh}" -i\' sh "$@" ;;\nesac'
used=0
class Stop(Exception):
 pass
def emit(value):
 sys.stdout.write(json.dumps(value,separators=(",",":")))
 sys.stdout.flush()
 sys.exit(0)
def call(args):
 global used
 try:
  p=subprocess.Popen(["hc"]+args,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
 except OSError:
  raise Stop("HC_UNAVAILABLE")
 done=False
 try:
  fd=p.stdout.fileno();chunks=[]
  while True:
   left=END-time.monotonic()
   if left<=0 or not select.select([fd],[],[],left)[0]:
    raise Stop("TIME_LIMIT")
   data=os.read(fd,65536)
   if not data:
    break
   used+=len(data)
   if used>CAP:
    raise Stop("BYTE_LIMIT")
   chunks.append(data)
  try:
   code=p.wait(timeout=max(0.01,END-time.monotonic()))
  except subprocess.TimeoutExpired:
   raise Stop("TIME_LIMIT")
  done=True
  return code,b"".join(chunks)
 finally:
  if not done:
   try:
    p.kill();p.wait(timeout=1)
   except Exception:
    pass
  p.stdout.close()
def clean(v,n):
 if not isinstance(v,str):
  return None
 v=" ".join("".join(" " if ord(c)<32 or ord(c)==127 else c for c in v).split())[:n].strip()
 return v or None
def path(v):
 return v if isinstance(v,str) and 0<len(v)<=1024 and ID.fullmatch(v[:256]) and not any(ord(c)<32 or ord(c)==127 for c in v) else None
def program(argv):
 if not isinstance(argv,list) or not argv or not all(isinstance(a,str) for a in argv):
  return None
 if len(argv)>4 and (WRAPS.get(argv[1])==argv[2] and argv[3]==argv[0] or argv[:2]==["sh","-c"] and argv[2]==DISPATCH and argv[3]=="sh"):
  argv=argv[4:]
 name=os.path.basename(argv[0]).lower()
 return name if NAME.fullmatch(name) else None
def natural(a):
 return (len(a),a)
try:
 code,raw=call(["ls","--all","--json"])
except Stop as e:
 emit({"ok":False,"code":e.args[0]})
if code!=0:
 emit({"ok":False,"code":"HC_FAILED"})
try:
 envelope=json.loads(raw.decode("utf-8"))
except Exception:
 emit({"ok":False,"code":"MALFORMED"})
if not isinstance(envelope,dict) or not isinstance(envelope.get("terminals"),list):
 emit({"ok":False,"code":"MALFORMED"})
found=set()
for row in envelope["terminals"]:
 if isinstance(row,dict) and isinstance(row.get("address"),str) and ADDR.fullmatch(row["address"]) and isinstance(row.get("state"),str) and row["state"]!="live" and not row.get("parent"):
  found.add(row["address"])
pending=sorted(found,key=natural,reverse=True)
cursor=q.get("cursor")
if isinstance(cursor,str) and ADDR.fullmatch(cursor):
 pending=[a for a in pending if natural(a)<natural(cursor)]
rows=[];scanned=0;stopped=None;last=None
for address in pending[:BATCH]:
 try:
  code,raw=call(["get",address,"--json"])
 except Stop as e:
  stopped=e.args[0]
  break
 scanned+=1;last=address
 if code!=0:
  continue
 try:
  t=json.loads(raw.decode("utf-8"))
 except Exception:
  continue
 if not isinstance(t,dict) or t.get("address")!=address or t.get("state")=="live" or t.get("parent"):
  continue
 labels=t.get("labels") if isinstance(t.get("labels"),dict) else {}
 space,tab,created,finished=labels.get("herdr.space"),labels.get("herdr.tab"),t.get("created_ms"),t.get("finished_ms")
 if not (isinstance(space,str) and ID.fullmatch(space) and isinstance(tab,str) and ID.fullmatch(tab)) or type(created) is not int or created<0:
  continue
 rows.append({"address":address,"createdMs":created,"finishedMs":finished if type(finished) is int and finished>=0 else None,"space":space,"tab":tab,"cwd":path(t.get("cwd")),"title":clean(t.get("title") or t.get("name"),160),"program":program(t.get("argv"))})
hidden=envelope.get("hidden_finished")
remaining=len(pending)-scanned
complete=stopped is None and remaining==0 and not (type(hidden) is int and hidden>0)
rows.sort(key=lambda r:(r["finishedMs"] is None,-(r["finishedMs"] or 0)))
emit({"ok":True,"complete":complete,"stopped":stopped,"cursor":last if remaining>0 else None,"scanned":scanned,"candidates":len(pending),"records":rows[:LIMIT]})
`;
const historyReasons={BYTE_LIMIT:'herdr-core history exceeded the 4 MiB import limit.',TIME_LIMIT:'herdr-core did not answer within 5 seconds.',HC_UNAVAILABLE:'hc is not available there.',HC_FAILED:'hc could not list finished terminals.',MALFORMED:'hc returned an unexpected history format.'};
function historyRows(out,machine){
  if(!Array.isArray(out.records)||out.records.length>LIMITS.records)return null;const rows=[];
  // Fields are picked explicitly: nothing else the helper printed can reach the journal.
  for(const r of out.records)try{
    if(!time(r.createdMs)||r.finishedMs!==null&&!time(r.finishedMs))continue;
    rows.push({address:qualified(localTerminalAddress(r.address,machine),machine),createdMs:r.createdMs,finishedMs:r.finishedMs,space:text(r.space,'space'),tab:text(r.tab,'tab'),startCwd:folder(r.cwd),title:displayText(r.title),program:typeof r.program==='string'&&/^[a-z0-9][a-z0-9._+-]{0,63}$/.test(r.program)?r.program:null});
  }catch{}
  return rows;
}
/**
 * Optional, explicitly requested import of older closes from one ready host's herdr-core.
 * A capped, malformed or failed scan reports OLDER_HISTORY_UNAVAILABLE and keeps the journal's records.
 * Imported records are labelled; their order counts only after a complete candidate scan.
 */
export async function importClosedHistory(machine,io,{timeoutMs=LIMITS.historyMs,maxBytes=LIMITS.historyBytes,batch=LIMITS.historyBatch}={}){
  const on=machineIdentity(machine),journal=new ClosedJournal(io),key=hostKey(on),where=on??'this computer';
  const unavailable=async reason=>{try{await journal.edit((d,now)=>{d.imports[key]={at:now,state:'unavailable',reason,cursor:d.imports[key]?.cursor??null};});}catch{}return freeze({ok:false,code:'OLDER_HISTORY_UNAVAILABLE',machine:on,message:`Older closed-tab history is unavailable on ${where}: ${reason} Current history was kept.`});};
  if(typeof io.machines==='function'&&io.machines().find(m=>safeMachine(m?.name)===on)?.layout!=='ready')return unavailable('the machine is offline or still loading.');
  let before;try{before=(await journal.read()).value;}catch(error){return freeze({ok:false,code:error.code||'INVALID_CLOSED',machine:on,message:error.message});}
  const previous=before.imports[key],request=JSON.stringify({v:1,cursor:previous?.state==='partial'?previous.cursor:null,maxBytes:Math.min(maxBytes,LIMITS.historyBytes),timeoutMs:Math.min(timeoutMs,LIMITS.historyMs),limit:LIMITS.records,batch:Math.min(batch,200)});
  let result;try{result=await io.exec('python3',['-c',HISTORY_WRAPPER,request],{on});}catch{return unavailable('Python 3 could not be started there.');}
  if(result?.code!==0||typeof result.stdout!=='string'||result.stdout.length>LIMITS.historyOutput)return unavailable('the history helper failed.');
  let out;try{out=JSON.parse(result.stdout);}catch{return unavailable('the history helper returned invalid data.');}
  if(out?.ok!==true)return unavailable(historyReasons[out?.code]||'the history helper failed.');
  const rows=historyRows(out,on),cursor=typeof out.cursor==='string'&&/^t[0-9a-z]{1,63}$/.test(out.cursor)?out.cursor:null,complete=out.complete===true&&!cursor;
  if(!rows)return unavailable('the history helper returned invalid data.');
  const world=snapshotWorld(io),live=world.hosts.get(key),groups=new Map();
  for(const r of rows){const k=JSON.stringify([r.space,r.tab]);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(r);}
  const candidates=[];
  for(const g of groups.values()){
    const tabId=qualified(g[0].tab,on);if(!live?.ready||live.tabs[localId(tabId,on)])continue;
    const space=live.spaces[g[0].space]||{id:qualified(g[0].space,on),name:null,named:false,folder:null};
    candidates.push({machine:on,space,closedAt:Math.max(...g.map(r=>r.finishedMs??r.createdMs)),ordered:complete&&g.every(r=>r.finishedMs!==null),
      tab:{id:tabId,space:g[0].space,index:null,name:null,named:false,panes:g.length,terms:g.slice(0,LIMITS.terminals).map(r=>({address:r.address,createdMs:r.createdMs,startCwd:r.startCwd,program:r.program?{key:r.program,name:r.program}:null,agent:KNOWN_AGENTS.has(r.program),title:r.title}))}});
  }
  const enrichment=await enrichmentFor(io,candidates);
  try{
    const {result:summary}=await journal.edit((d,now)=>{
      let added=0;
      for(const c of candidates){const closed=closedRecord(c,{source:'imported',closedAt:c.closedAt,seq:0,extra:enrichment.get(JSON.stringify([on,c.tab.id])),ordered:c.ordered});if(d.records.some(r=>sameClosure(r,closed)))continue;d.records.push(closed);added++;}
      d.imports[key]={at:now,state:complete?'complete':'partial',reason:null,cursor};boundRecords(d,now);return {added};
    });
    return freeze({ok:true,machine:on,added:summary.added,complete,scanned:Number.isSafeInteger(out.scanned)?out.scanned:0,message:`Imported ${summary.added} older closed tab${summary.added===1?'':'s'} from ${where}${complete?'.':'; history is partial, so its order is unverified.'}`});
  }catch(error){return freeze({ok:false,code:error.code||'IMPORT_FAILED',machine:on,message:error instanceof ClosedTabsError?error.message:'Imported history could not be saved; current history was kept.'});}
}
