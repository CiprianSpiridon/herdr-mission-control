import {bindingKey,gitlabProjectPath,readConfig,validateConfig} from '../../shared/config.js';
import {trackerScope,trackerScopeKey,trackerOrigin,selectTracker,allTrackerBindings,validateRepoBinding,validateSnapshot,issueIdentityKey,ScopedTrackerCache,saveRepoIntegration,utf8Bytes} from '../../shared/tracker-model.js';
import {validateMergeRequest,mergeIdentityKey,mrDetailCursor} from './merge-model.js';

const copy=value=>JSON.parse(JSON.stringify(value));
function freezeSnapshot(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))freezeSnapshot(child);Object.freeze(value);}return value;}
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,required,optional=[])=>object(value)&&required.every(k=>Object.hasOwn(value,k))&&Object.keys(value).every(k=>required.includes(k)||optional.includes(k));
const text=(value,max=512)=>typeof value==='string'&&value.trim().length>0&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value);
const name=value=>text(value,128)&&/^[A-Za-z0-9_.-]+$/.test(value)&&!['.','..'].includes(value);
function stable(value){if(Array.isArray(value))return '['+value.map(stable).join(',')+']';if(object(value))return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')+'}';return JSON.stringify(value);}
const messages={INVALID_REQUEST:'Check the GitLab profile and project fields.',INVALID_CONNECTION:'Check the HTTPS GitLab site and bearer credential reference.',INVALID_SCOPE:'This GitLab project or account changed. Reload its view.',INVALID_RESPONSE:'The GitLab helper returned an invalid or mismatched response.',INVALID_CONFIG:'Mission Control settings could not be read. The original file was preserved.',AUTH_REQUIRED:'The selected GitLab credentials are unavailable.',PERMISSION_DENIED:'The selected account cannot read this GitLab resource.',NOT_FOUND:'The selected GitLab resource was not found.',RATE_LIMITED:'GitLab reached its read limit. Retry after the reported delay.',STATUS_MAPPING_REQUIRED:'Choose unambiguous To do, In progress and Done labels.',CONNECTION_CONFLICT:'This profile is already used. Choose a new profile ID to change it.',CANONICAL_PROJECT_REQUIRED:'Use the canonical project path shown in setup, then save again.',REQUEST_TIMEOUT:'The GitLab read timed out. Retry this scope.',REQUEST_CANCELLED:'This GitLab operation was cancelled.',RESPONSE_TOO_LARGE:'The GitLab result exceeds its bounded size.',INCOMPLETE_RESULTS:'GitLab could not confirm a complete result. Narrow this scope and refresh.',UNTRUSTED_ORIGIN:'GitLab tried to leave the selected HTTPS origin.',INVALID_URL:'Use the selected HTTPS API origin without credentials or fragments.',HELPER_UNAVAILABLE:'The local GitLab helper could not run. Check that Node.js 22 or later is installed.',UPSTREAM_UNAVAILABLE:'GitLab is temporarily unavailable.',HTTP_ERROR:'GitLab rejected this read request.',REQUEST_FAILED:'GitLab could not be reached. Check this profile.'};
export class GitlabDataError extends Error{
  constructor(code,details={}){const safe=Object.hasOwn(messages,code)?code:'REQUEST_FAILED';super(messages[safe]);this.name='GitlabDataError';this.code=safe;if(Number.isFinite(details.retryAfterMs)&&details.retryAfterMs>=0)this.retryAfterMs=Math.min(details.retryAfterMs,86400000);}
}
const fail=code=>{throw new GitlabDataError(code);};
const safeError=e=>e instanceof GitlabDataError?e:new GitlabDataError(['INVALID_MR','INVALID_MR_ACTION','INVALID_SNAPSHOT','INVALID_ISSUE'].includes(e?.code)?'INVALID_RESPONSE':e?.code==='INVALID_BINDING'?'INVALID_SCOPE':['INVALID_JSON','UNSUPPORTED_VERSION','CONFIG_PATH','CONFIG_DIRECTORY'].includes(e?.code)?'INVALID_CONFIG':e?.code);
function profile(value){
  if(!exact(value,['id','kind','site','auth'])||value.kind!=='api'||!text(value.id,96)||!/^[a-z][a-z0-9-]*$/.test(value.id)||['constructor','prototype'].includes(value.id)||!exact(value.auth,['kind','tokenEnv'])||value.auth.kind!=='bearer'||typeof value.auth.tokenEnv!=='string'||!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value.auth.tokenEnv))fail('INVALID_CONNECTION');
  try{validateConfig({v:1,preferences:{gitlabProfile:value}});return {...copy(value),site:trackerOrigin(value.site)};}catch{fail('INVALID_CONNECTION');}
}
export const gitlabApiBase=site=>trackerOrigin(site)+'/api/v4';
const sameRefs=(a,b)=>a.head.sha.toLowerCase()===b.head.sha.toLowerCase()&&(a.base.sha===null||b.base.sha===null||a.base.sha.toLowerCase()===b.base.sha.toLowerCase());
function inputShape(input){
  if(!exact(input,['v','operation','connection','binding'],['cursor'])||input.v!==1||!['issues','merges','probe'].includes(input.operation)||input.cursor!==undefined&&input.cursor!==null&&!text(input.cursor,8192))fail('INVALID_REQUEST');
  const connection=profile(input.connection),binding=validateRepoBinding(input.binding);if(binding.gitlab?.connectionId!==connection.id)fail('INVALID_SCOPE');
  if(input.operation==='probe'&&input.cursor)fail('INVALID_REQUEST');
  if(input.cursor?.startsWith('{')){
    if(input.operation!=='merges')fail('INVALID_SCOPE');let c;try{c=JSON.parse(input.cursor);}catch{fail('INVALID_SCOPE');}const i=c?.identity,sha=value=>typeof value==='string'&&/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
    if(!exact(c,['v','kind','identity','machine','repoRoot','headSha','baseSha'])||c.v!==1||c.kind!=='mr-detail'||!exact(i,['kind','connectionId','site','projectPath','id','number'])||i.kind!=='gitlab-mr'||i.connectionId!==connection.id||i.site!==connection.site||i.projectPath!==binding.gitlab.projectPath||typeof i.id!=='string'||!/^[1-9][0-9]{0,199}$/.test(i.id)||!Number.isSafeInteger(i.number)||i.number<1||c.machine!==binding.machine||c.repoRoot!==binding.repoRoot||!sha(c.headSha)||c.baseSha!==null&&!sha(c.baseSha))fail('INVALID_SCOPE');
  }
  return {...copy(input),connection,binding};
}
function validateProbe(value,input){
  if(!exact(value,['kind','site','projectPath','projectId','issuesEnabled','canonical'])||value.kind!=='project'||value.site!==input.connection.site||typeof value.projectId!=='string'||!/^[1-9][0-9]{0,199}$/.test(value.projectId)||![true,false,null].includes(value.issuesEnabled)||typeof value.canonical!=='boolean')fail('INVALID_RESPONSE');
  try{gitlabProjectPath(value.projectPath);}catch{fail('INVALID_RESPONSE');}
  if(value.canonical!==(value.projectPath===input.binding.gitlab.projectPath))fail('INVALID_RESPONSE');return copy(value);
}

/** Exact public protocol validation is shared with this mod's Node dispatcher. */
export function validateGitlabReply(value,request,{now=Date.now()}={}){
  const input=inputShape(request);
  if(!object(value)||value.v!==1||typeof value.ok!=='boolean')fail('INVALID_RESPONSE');
  if(!value.ok){
    const e=value.error;if(!exact(value,['v','ok','error'])||!exact(e,['code','message'],['status','retryAfterMs'])||!text(e.code,80)||!text(e.message,512)||e.status!==undefined&&(!Number.isInteger(e.status)||e.status<100||e.status>599)||e.retryAfterMs!==undefined&&(!Number.isFinite(e.retryAfterMs)||e.retryAfterMs<0||e.retryAfterMs>86400000))fail('INVALID_RESPONSE');const safe=new GitlabDataError(e.code,e);return {v:1,ok:false,error:{code:safe.code,message:safe.message,...(e.status!==undefined?{status:e.status}:{}),...(safe.retryAfterMs!==undefined?{retryAfterMs:safe.retryAfterMs}:{})}};
  }
  if(value.operation!==input.operation)fail('INVALID_RESPONSE');
  if(input.operation==='probe'){
    if(!exact(value,['v','ok','operation','connection','probe'])||stable(profile(value.connection))!==stable(input.connection))fail('INVALID_RESPONSE');return {...copy(value),probe:validateProbe(value.probe,input)};
  }
  if(!exact(value,input.operation==='issues'?['v','ok','operation','snapshot','progressHint']:['v','ok','operation','snapshot'])||input.operation==='issues'&&(typeof value.progressHint!=='string'||utf8Bytes(value.progressHint)>1024||/[\u0000-\u001f\u007f]/.test(value.progressHint)))fail('INVALID_RESPONSE');
  const source=input.operation==='issues'?'gitlab':'gitlab-mr',scope=trackerScope(source,input.connection,input.binding),validators=input.operation==='merges'?{validateItem:validateMergeRequest,itemKey:mergeIdentityKey}:{};let snapshot;
  try{snapshot=validateSnapshot(value.snapshot,scope,{...validators,now});}catch{fail('INVALID_RESPONSE');}
  if(input.operation==='merges'&&input.cursor?.startsWith('{')){
    let cursor;try{cursor=JSON.parse(input.cursor);}catch{fail('INVALID_RESPONSE');}
    const item=snapshot.data[0];
    if(snapshot.data.length!==1||snapshot.cursor||cursor.v!==1||cursor.kind!=='mr-detail'||stable(item.identity)!==stable(cursor.identity)||item.repoBinding.machine!==cursor.machine||item.repoBinding.repoRoot!==cursor.repoRoot||item.head.sha.toLowerCase()!==String(cursor.headSha).toLowerCase()||cursor.baseSha!==null&&item.base.sha?.toLowerCase()!==String(cursor.baseSha).toLowerCase())fail('INVALID_RESPONSE');
  }
  if(snapshot.error){const safe=safeError(snapshot.error);snapshot.error={...snapshot.error,code:safe.code,message:safe.message};}
  return {...copy(value),snapshot};
}
export function gitlabSetupFields(){return [{path:'id',label:'Profile ID',kind:'text'},{path:'site',label:'GitLab site',kind:'text'},{path:'auth.tokenEnv',label:'Token environment variable',kind:'text'}];}
export function gitlabSetupModel(config,resolved,{connectionId}={}){
  const c=validateConfig(config);if(!resolved||resolved.state&&resolved.state!=='resolved')return {state:resolved?.state==='ambiguous'?'ambiguous':'unbound',profiles:[]};
  const target=validateRepoBinding({machine:resolved.machine,repoRoot:resolved.repoRoot}),bound=c.bindings[bindingKey(target.machine,target.repoRoot)]?.gitlab,id=connectionId||bound?.connectionId,connection=id&&c.connections[id]?profile(c.connections[id]):null,profiles=[];
  for(const value of Object.values(c.connections)){try{const p=profile(value);profiles.push({id:p.id,kind:p.kind,site:p.site});}catch{}}
  return {state:'ready',target,selection:bound?copy(bound):{},connection,profiles,fields:gitlabSetupFields(),credentialHint:'Use a bearer-token environment variable name. Credential values stay in the local helper.'};
}

// Herdr ends a continuation that overruns its time slice without running
// catch/finally, and a cancelled task's promise never settles. Every helper
// read finishes within its own deadlines long before this age.
export const STALE_LOAD_MS=90000;
/** Reserve each scope's tail before waiting for a shared slot, including queued jobs. */
export class HelperQueue{
  constructor({clock=()=>Date.now()}={}){this.clock=clock;this.holders=new Set();this.waiters=[];this.tails=new Map();}
  // An abandoned holder can never release, so its slot expires instead.
  active(){const now=this.clock();let total=0;for(const holder of this.holders)if(now-holder.at>=STALE_LOAD_MS)this.holders.delete(holder);else total+=holder.weight;return total;}
  hold(weight){const holder={weight,at:this.clock()};this.holders.add(holder);return holder;}
  drain(){while(this.waiters.length&&this.active()+this.waiters[0].weight<=4){const next=this.waiters.shift();next.resolve(this.hold(next.weight));}}
  async acquire(weight){if(!this.waiters.length&&this.active()+weight<=4)return this.hold(weight);return new Promise(resolve=>{this.waiters.push({weight,resolve});this.drain();});}
  release(holder){if(this.holders.delete(holder))this.drain();}
  run(key,current,work,weight=1){
    const tail=this.tails.get(key),previous=tail&&this.clock()-tail.at<STALE_LOAD_MS?tail.promise:null,promise=(async()=>{if(previous)try{await previous;}catch{}if(!current())fail('REQUEST_CANCELLED');const holder=await this.acquire(weight);try{if(!current())fail('REQUEST_CANCELLED');return await work();}finally{this.release(holder);}})();
    const record={promise,at:this.clock()};this.tails.set(key,record);const cleanup=()=>{if(this.tails.get(key)===record)this.tails.delete(key);};promise.then(cleanup,cleanup);return promise;
  }
}
const helperQueue=new HelperQueue();
const desiredKey=value=>value?.all?'all':stable([value?.resolved?.state||'unbound',value?.resolved?.machine??null,value?.resolved?.repoRoot??null,value?.resolved?.worktreeRoot??null]);
const setupScopeKey=(config,target)=>{const selected=config?.bindings?.[bindingKey(target.machine,target.repoRoot)]?.gitlab;return stable([selected??null,selected?config?.connections?.[selected.connectionId]??null:null]);};

export class GitlabDataBridge{
  constructor(io,{view='issues',clock=()=>Date.now(),onChange=()=>{}}={}){
    if(!['issues','merges'].includes(view))fail('INVALID_REQUEST');Object.assign(this,{io,viewKind:view,clock,onChange,source:view==='issues'?'gitlab':'gitlab-mr',entries:new Map(),visible:[],details:new Map(),mergeIndexes:new WeakMap(),origins:new Map(),originRecords:new WeakMap(),retiredEntries:new Set(),generation:0,epoch:0,setupEpoch:0,closed:false,all:false,phase:'setup',errors:[],desired:null,discovery:null});this.publish();
  }
  itemKey(item){return this.viewKind==='issues'?issueIdentityKey(item):mergeIdentityKey(item);}
  validators(){return this.viewKind==='merges'?{validateItem:validateMergeRequest,itemKey:mergeIdentityKey}:{};}
  indexedMerges(snapshot){
    const rows=snapshot?.data;if(!rows)return new Map();let index=this.mergeIndexes.get(rows);
    if(!index){index=new Map(rows.map(p=>[mergeIdentityKey(p),p]));freezeSnapshot(rows);this.mergeIndexes.set(rows,index);}return index;
  }
  publish(){
    if(this.closed)return;const bindings=this.visible.map(key=>{const e=this.entries.get(key);return {binding:e.selection.binding,scope:e.selection.scope,checkoutRoot:e.checkoutRoot,snapshot:e.cache.snapshot,loading:e.cache.pending,progressHint:e.progressHint};});
    const data=[],seen=new Set(),errors=[...this.errors];let bytes=0,truncated=false,loading=0;
    for(const entry of bindings){if(entry.loading||!entry.snapshot)loading++;if(entry.snapshot?.error)errors.push({binding:entry.binding,error:entry.snapshot.error});truncated||=Boolean(entry.snapshot?.truncated);
      const rows=this.viewKind==='merges'?this.indexedMerges(entry.snapshot):(entry.snapshot?.data||[]).map(item=>[this.itemKey(item),item]);
      for(const [key,item]of rows){if(seen.has(key))continue;const size=utf8Bytes(JSON.stringify(item));if(data.length===1000||bytes+size>7*1024*1024){truncated=true;continue;}seen.add(key);bytes+=size;data.push(item);}
    }
    const state=this.phase==='setup'?'setup':errors.length?(data.length?'partial':'error'):loading?'loading':this.phase;const discovery=this.discovery?{state:this.discovery.state,...(this.discovery.probe?{probe:this.discovery.probe}:{}),...(this.discovery.error?{error:{code:this.discovery.error.code,message:this.discovery.error.message}}:{})}:null;this.value={state,view:this.viewKind,all:this.all,data,bindings,errors,loading,truncated,limitReached:truncated&&!bindings.some(b=>b.snapshot?.cursor),discovery};this.onChange(this.value);
  }
  view(){return this.value;}
  entryLeased(entry){return [...this.origins.values()].some(info=>info.entry===entry);}
  destroyEntry(entry){entry.cache.clear();entry.version=++this.epoch;entry.pending=null;this.retiredEntries.delete(entry);for(const[key,detail]of this.details)if(detail.entry===entry)this.details.delete(key);}
  detachEntry(entry){if(this.entryLeased(entry)){entry.cache.pending=false;entry.cache.epoch++;entry.pending=null;this.retiredEntries.add(entry);}else this.destroyEntry(entry);}
  dropOrigin(info){
    if(!info?.active)return false;const entry=info.entry;this.origins.delete(info.token);info.active=false;info.entry=null;info.merge=null;info.token=null;
    if(this.retiredEntries.has(entry)&&!this.entryLeased(entry))this.destroyEntry(entry);return true;
  }
  pruneOrigins(){const now=this.clock();for(const info of [...this.origins.values()])if(this.closed||!Number.isFinite(now)||now<info.createdAt||now-info.createdAt>=120000)this.dropOrigin(info);}
  originConfigMatches(info,config){
    try{const binding=config?.bindings?.[info.bindingKey],connection=binding?.gitlab&&config.connections?.[binding.gitlab.connectionId];return Boolean(connection)&&trackerScopeKey(trackerScope('gitlab-mr',profile(connection),binding))===info.scopeKey;}catch{return false;}
  }
  originInfoCurrent(info){
    if(!info?.active||this.closed||!info.entry||info.entry.version!==info.version||!this.originConfigMatches(info,this.config))return false;
    const now=this.clock();if(!Number.isFinite(now)||now<info.createdAt||now-info.createdAt>=120000)return false;
    const found=this.indexedMerges(info.entry.cache.snapshot).get(info.identity);return Boolean(found)&&sameRefs(info.merge,found)&&(info.provenBase===undefined||found.base.sha===null||info.provenBase.toLowerCase()===found.base.sha.toLowerCase());
  }
  reconcileOrigins(){this.pruneOrigins();for(const info of [...this.origins.values()])if(!this.originInfoCurrent(info))this.dropOrigin(info);}
  acquireMergeOrigin(value){
    this.pruneOrigins();if(this.closed||this.origins.size>=64)fail('REQUEST_CANCELLED');let merge,entry;try{({merge,entry}=this.mergeEntry(value));}catch{fail('REQUEST_CANCELLED');}
    const createdAt=this.clock();if(!Number.isFinite(createdAt)||createdAt<0)fail('REQUEST_CANCELLED');const token=Object.freeze(Object.create(null)),info={token,active:true,merge:freezeSnapshot(merge),entry,version:entry.version,createdAt,bindingKey:bindingKey(merge.repoBinding.machine,merge.repoBinding.repoRoot),identity:mergeIdentityKey(merge),scopeKey:trackerScopeKey(entry.selection.scope)};
    this.originRecords.set(token,info);this.origins.set(token,info);if(!this.originInfoCurrent(info)){this.dropOrigin(info);fail('REQUEST_CANCELLED');}return token;
  }
  mergeOriginCurrent(origin){this.pruneOrigins();const info=object(origin)&&this.originRecords.get(origin);if(!this.originInfoCurrent(info)){if(info)this.dropOrigin(info);return false;}return true;}
  async validateMergeOrigin(origin){
    if(!this.mergeOriginCurrent(origin))fail('REQUEST_CANCELLED');const info=this.originRecords.get(origin);let config;
    try{config=(await readConfig(this.io)).value;}catch{this.dropOrigin(info);fail('REQUEST_CANCELLED');}
    if(!this.mergeOriginCurrent(origin)||!this.originConfigMatches(info,config)){this.dropOrigin(info);fail('REQUEST_CANCELLED');}return true;
  }
  releaseMergeOrigin(origin){const info=object(origin)&&this.originRecords.get(origin);if(!info)fail('REQUEST_CANCELLED');return this.dropOrigin(info);}
  originEntry(value,origin){
    if(!this.mergeOriginCurrent(origin))fail('REQUEST_CANCELLED');const info=this.originRecords.get(origin);let merge;try{merge=validateMergeRequest(value,{scope:info.entry.selection.scope});}catch{fail('REQUEST_CANCELLED');}
    if(mergeIdentityKey(merge)!==info.identity||!sameRefs(info.merge,merge)||info.provenBase!==undefined&&merge.base.sha!==null&&info.provenBase.toLowerCase()!==merge.base.sha.toLowerCase())fail('REQUEST_CANCELLED');return {merge,entry:info.entry};
  }
  clearSelection({phase='loading'}={}){
    this.pruneOrigins();if(phase==='closed'||phase==='error')for(const info of [...this.origins.values()])this.dropOrigin(info);
    this.generation++;for(const e of this.entries.values())this.detachEntry(e);this.entries.clear();this.visible=[];for(const[key,d]of this.details)if(!this.entryLeased(d.entry))this.details.delete(key);this.errors=[];this.phase=phase;this.publish();
  }
  selectConfig(config,resolved,{all=false}={}){
    if(this.closed)return this.value;const c=validateConfig(config),next={resolved:resolved?copy(resolved):null,all:Boolean(all)};
    if(this.setupTarget&&this.config&&setupScopeKey(this.config,this.setupTarget)!==setupScopeKey(c,this.setupTarget))this.cancelSetup();
    if(this.desired&&desiredKey(next)!==desiredKey(this.desired)){this.cancelSetup();this.clearSelection();}this.generation++;this.config=c;this.reconcileOrigins();this.desired=next;this.all=next.all;this.errors=[];let selections=[];
    if(all){try{selections=allTrackerBindings(c,this.source);}catch{for(const binding of Object.values(c.bindings)){if(!binding.gitlab)continue;try{const s=selectTracker(c,{state:'resolved',machine:binding.machine,repoRoot:binding.repoRoot},this.source);if(s)selections.push(s);}catch(error){this.errors.push({binding:{machine:binding.machine,repoRoot:binding.repoRoot},error:safeError(error)});}}}}
    else if(resolved?.state===undefined||resolved.state==='resolved'){try{const s=selectTracker(c,resolved,this.source);if(s)selections=[s];}catch(error){this.errors.push({error:safeError(error)});}}
    const wanted=new Set();this.visible=[];
    for(const selection of selections){
      const key=bindingKey(selection.binding.machine,selection.binding.repoRoot);try{profile(selection.connection);}catch(error){this.errors.push({binding:selection.binding,error:safeError(error)});continue;}
      let entry=this.entries.get(key);if(entry&&trackerScopeKey(entry.selection.scope)!==trackerScopeKey(selection.scope)){entry.cache.clear();entry.version=++this.epoch;entry.pending=null;this.entries.delete(key);entry=null;}
      if(!entry){entry=[...this.retiredEntries].find(e=>trackerScopeKey(e.selection.scope)===trackerScopeKey(selection.scope));if(entry)this.retiredEntries.delete(entry);else entry={selection,cache:new ScopedTrackerCache({clock:this.clock}),version:++this.epoch,pending:null,progressHint:'',checkoutRoot:selection.binding.repoRoot};this.entries.set(key,entry);}
      entry.selection=selection;entry.cache.select(selection.scope);
      if(resolved?.machine===selection.binding.machine&&resolved?.repoRoot===selection.binding.repoRoot&&resolved.worktreeRoot)entry.checkoutRoot=resolved.worktreeRoot;
      wanted.add(key);this.visible.push(key);
    }
    for(const[key,entry]of this.entries)if(!wanted.has(key)){this.entries.delete(key);this.detachEntry(entry);}
    for(const[key,d]of this.details)if(!this.currentEntry(d.entry,d.version)&&!this.entryLeased(d.entry))this.details.delete(key);
    this.phase=this.visible.length?(!all&&this.visible.some(key=>this.entries.get(key).cache.snapshot?.error?.code==='INVALID_SCOPE')?'setup':'ready'):all||!resolved||resolved.state===undefined||resolved.state==='resolved'?'setup':'unbound';this.publish();return this.value;
  }
  async synchronize(resolved,{all=false}={}){
    const next={resolved:resolved?copy(resolved):null,all:Boolean(all)};if(this.closed)return this.value;if(desiredKey(next)!==desiredKey(this.desired)){this.cancelSetup();this.clearSelection();}const generation=++this.generation;
    try{const c=await readConfig(this.io);if(!this.closed&&generation===this.generation)return this.selectConfig(c.value,next.resolved,{all:next.all});}
    catch(error){if(!this.closed&&generation===this.generation){this.clearSelection({phase:'error'});this.errors=[{error:safeError(error)}];this.publish();}}
    return this.value;
  }
  currentEntry(entry,version){const key=bindingKey(entry.selection.binding.machine,entry.selection.binding.repoRoot);return !this.closed&&entry.version===version&&this.entries.get(key)===entry&&this.visible.includes(key);}
  async request(input,{isCurrent=()=>true}={}){
    const request=inputShape(input),serialized=JSON.stringify(request);if(utf8Bytes(serialized)>65536)fail('INVALID_REQUEST');
    const scope=trackerScope('gitlab',request.connection,request.binding),current=()=>!this.closed&&isCurrent();
    return helperQueue.run(trackerScopeKey(scope),current,async()=>{
      let result;try{const home=this.io.appHome();result=await this.io.exec('node',[home+'/mods/mission-control-gitlab/backend.mjs',serialized],{cwd:home});}catch{fail('HELPER_UNAVAILABLE');}
      if(!current())fail('REQUEST_CANCELLED');if(result?.code!==0||typeof result.stdout!=='string')fail('HELPER_UNAVAILABLE');if(utf8Bytes(result.stdout)>8*1024*1024)fail('RESPONSE_TOO_LARGE');let reply;
      try{reply=validateGitlabReply(JSON.parse(result.stdout),request,{now:this.clock()});}catch{fail('INVALID_RESPONSE');}
      if(!reply.ok)throw new GitlabDataError(reply.error.code,reply.error);return reply;
    },request.operation==='merges'&&request.cursor?.startsWith('{')?4:1);
  }
  mergePages(previous,next,scope){
    const rows=new Map(previous.data.map(p=>[this.itemKey(p),p]));for(const p of next.data)rows.set(this.itemKey(p),p);const data=[];let bytes=0,capped=false;
    for(const p of rows.values()){const size=utf8Bytes(JSON.stringify(p));if(data.length===1000||bytes+size>7*1024*1024){capped=true;break;}data.push(p);bytes+=size;}
    const result={...next,data,fetchedAt:Math.min(previous.fetchedAt,next.fetchedAt)};if(capped){result.truncated=true;delete result.cursor;result.error={code:'RESPONSE_TOO_LARGE',message:messages.RESPONSE_TOO_LARGE};}
    return validateSnapshot(result,scope,{...this.validators(),now:this.clock()});
  }
  // A ticket without its live load, or a load past every helper deadline, was abandoned by the host.
  abandonedLoad(entry){return entry.pending?this.clock()-entry.pendingAt>=STALE_LOAD_MS:entry.cache.pending;}
  hasAbandonedLoad(){return !this.closed&&this.visible.some(key=>this.entries.has(key)&&this.abandonedLoad(this.entries.get(key)));}
  recoverAbandoned(){return Promise.all(this.visible.filter(key=>this.entries.has(key)&&this.abandonedLoad(this.entries.get(key))).map(key=>this.refreshEntry(this.entries.get(key),{force:true})));}
  refreshEntry(entry,{force=false,loadMore=false}={}){
    if(!this.currentEntry(entry,entry.version))return Promise.resolve(entry.cache.snapshot);
    if(this.abandonedLoad(entry)){entry.pending=null;entry.cache.abandon();this.publish();}
    if(entry.pending)return entry.pending;const selection=copy(entry.selection),previous=entry.cache.snapshot,now=this.clock(),version=entry.version;
    if(previous?.error?.retryAt>now||loadMore&&!previous?.cursor||!loadMore&&!force&&previous&&!previous.error&&now-previous.fetchedAt<60000)return Promise.resolve(previous);
    const ticket=entry.cache.begin(selection.scope);if(!ticket)return Promise.resolve(previous);const current=()=>this.currentEntry(entry,version)&&entry.cache.current(ticket);
    const pending=(async()=>{
      try{
        const reply=await this.request({v:1,operation:this.viewKind,connection:selection.connection,binding:selection.binding,...(loadMore?{cursor:previous.cursor}:{})},{isCurrent:current});
        if(current()){entry.cache.accept(ticket,loadMore?this.mergePages(previous,reply.snapshot,selection.scope):reply.snapshot,this.validators());this.reconcileOrigins();if(reply.progressHint!==undefined)entry.progressHint=reply.progressHint;for(const[key,d]of this.details)if(d.entry===entry)this.details.delete(key);}
      }catch(error){if(current()){
        const safe=safeError(error),failure={code:safe.code,message:safe.message,...(safe.retryAfterMs!==undefined?{retryAt:this.clock()+safe.retryAfterMs}:{})};
        if(safe.code==='INVALID_SCOPE'){
          entry.version=++this.epoch;entry.cache.clear();entry.cache.select(selection.scope);entry.cache.fail(entry.cache.begin(),failure);this.reconcileOrigins();
          if(!this.all){
            this.phase='setup';const version=entry.version,epoch=++this.setupEpoch,probeCurrent=()=>this.currentEntry(entry,version)&&epoch===this.setupEpoch;this.discovery={state:'loading'};this.publish();
            try{const reply=await this.request({v:1,operation:'probe',connection:selection.connection,binding:selection.binding},{isCurrent:probeCurrent});if(probeCurrent())this.discovery={state:reply.probe.canonical?'ready':'canonical',probe:reply.probe};}
            catch(cause){if(probeCurrent())this.discovery={state:'error',error:safeError(cause)};}
          }
        }else entry.cache.fail(ticket,failure);
      }}
      finally{if(entry.pending===pending)entry.pending=null;this.publish();}return entry.cache.snapshot;
    })();entry.pending=pending;entry.pendingAt=now;this.publish();return pending;
  }
  async refresh({force=false,loadMore=false,binding}={}){if(this.closed)return this.value;const keys=binding?[bindingKey(binding.machine,binding.repoRoot)]:[...this.visible];await Promise.all(keys.filter(k=>this.visible.includes(k)).map(k=>this.refreshEntry(this.entries.get(k),{force,loadMore})));return this.value;}
  mergeEntry(value){
    if(this.viewKind!=='merges')fail('INVALID_REQUEST');const merge=validateMergeRequest(value),key=bindingKey(merge.repoBinding.machine,merge.repoBinding.repoRoot),entry=this.entries.get(key);if(!entry||!this.visible.includes(key))fail('INVALID_SCOPE');
    try{validateMergeRequest(merge,{scope:entry.selection.scope});}catch{fail('INVALID_SCOPE');}const found=this.indexedMerges(entry.cache.snapshot).get(mergeIdentityKey(merge));if(!found||!sameRefs(found,merge))fail('INVALID_SCOPE');return {merge,entry};
  }
  detailKey(merge,entry){return stable([trackerScopeKey(entry.selection.scope),entry.version,mergeIdentityKey(merge),merge.head.sha,merge.base.sha]);}
  detailState(value,{origin}={}){if(origin!==undefined&&!this.mergeOriginCurrent(origin)||!this.details.size)return {state:'unloaded'};try{const {merge,entry}=origin!==undefined?this.originEntry(value,origin):this.mergeEntry(value),d=this.details.get(this.detailKey(merge,entry));return d?{state:d.state,...(d.merge?{merge:copy(d.merge),fetchedAt:d.fetchedAt}:{}),...(d.error?{error:{code:d.error.code,message:d.error.message}}:{})}:{state:'unloaded'};}catch{return {state:'unloaded'};}}
  detailCurrent(value,options={}){const d=this.detailState(value,options);return d.state==='ready'&&this.clock()-d.fetchedAt<60000;}
  loadMergeDetails(value,{force=false,origin}={}){
    const {merge,entry}=origin!==undefined?this.originEntry(value,origin):this.mergeEntry(value),key=this.detailKey(merge,entry),old=this.details.get(key),version=entry.version;
    const deliver=promise=>promise.then(result=>{if(origin!==undefined){this.originEntry(result,origin);if(result.base.sha!==null)this.originRecords.get(origin).provenBase=result.base.sha;}else if(!this.currentEntry(entry,version))fail('REQUEST_CANCELLED');return copy(result);});
    if(old?.state==='loading'&&this.clock()-old.startedAt<STALE_LOAD_MS)return deliver(old.promise);if(!force&&old?.state==='ready'&&this.clock()-old.fetchedAt<60000)return deliver(Promise.resolve(old.merge));
    const identity=mergeIdentityKey(merge),record={entry,version,identity,state:'loading',startedAt:this.clock()},current=()=>{
      this.pruneOrigins();if(this.closed||entry.version!==version||this.details.get(key)!==record)return false;
      const leased=[...this.origins.values()].some(info=>info.entry===entry&&info.identity===identity&&sameRefs(info.merge,merge)&&this.originInfoCurrent(info));
      if(!this.currentEntry(entry,version)&&!leased)return false;const member=this.indexedMerges(entry.cache.snapshot).get(identity);return Boolean(member)&&sameRefs(member,merge);
    };this.details.set(key,record);
    while(this.details.size>100){const candidate=[...this.details].find(([k,d])=>k!==key&&(d.state!=='loading'||this.clock()-d.startedAt>=STALE_LOAD_MS)&&![...this.origins.values()].some(info=>info.entry===d.entry&&info.identity===d.identity));if(!candidate){this.details.delete(key);fail('RESPONSE_TOO_LARGE');}this.details.delete(candidate[0]);}
    const promise=(async()=>{try{const reply=await this.request({v:1,operation:'merges',connection:copy(entry.selection.connection),binding:copy(entry.selection.binding),cursor:mrDetailCursor(merge)},{isCurrent:current});if(!current())fail('REQUEST_CANCELLED');record.state='ready';record.merge=reply.snapshot.data[0];record.fetchedAt=reply.snapshot.fetchedAt;for(const info of [...this.origins.values()])if(info.entry===entry&&info.identity===identity&&record.merge.base.sha!==null){if(info.provenBase!==undefined&&info.provenBase.toLowerCase()!==record.merge.base.sha.toLowerCase())this.dropOrigin(info);else info.provenBase=record.merge.base.sha;}if(reply.snapshot.error){record.error=safeError(reply.snapshot.error);if(reply.snapshot.error.code!=='INCOMPLETE_RESULTS'){record.state='error';throw record.error;}}return copy(record.merge);}catch(error){const safe=safeError(error);if(safe.code==='INVALID_RESPONSE')for(const info of [...this.origins.values()])if(info.entry===entry&&info.identity===identity)this.dropOrigin(info);if(current()){record.state='error';delete record.merge;record.error=safe;}throw safe;}finally{this.publish();}})();record.promise=promise;this.publish();return deliver(promise);
  }
  cancelSetup(){this.setupEpoch++;this.discovery=null;this.setupTarget=null;}
  setupInput({target,connection,selection}){const c=profile(connection),binding=validateRepoBinding({machine:target.machine,repoRoot:target.repoRoot,gitlab:{...copy(selection),connectionId:c.id}});return {connection:c,binding};}
  async discoverProject({target,connection,selection},{isCurrent=()=>true}={}){
    const input=this.setupInput({target,connection,selection}),epoch=++this.setupEpoch,key=stable(input);this.setupTarget={machine:input.binding.machine,repoRoot:input.binding.repoRoot};this.discovery={state:'loading',key};const current=()=>!this.closed&&epoch===this.setupEpoch&&isCurrent();this.publish();
    try{const reply=await this.request({v:1,operation:'probe',...input},{isCurrent:current});if(!current())fail('REQUEST_CANCELLED');this.discovery={state:reply.probe.canonical?'ready':'canonical',key,probe:reply.probe};this.publish();return copy(reply.probe);}
    catch(error){if(current()){this.discovery={state:'error',key,error:safeError(error)};this.publish();}throw safeError(error);}
  }
  async saveSetup({target,connection,selection},{isCurrent=()=>true}={}){
    const input=this.setupInput({target,connection,selection}),epoch=++this.setupEpoch,current=()=>!this.closed&&epoch===this.setupEpoch&&isCurrent();this.setupTarget={machine:input.binding.machine,repoRoot:input.binding.repoRoot};if(!current())fail('REQUEST_CANCELLED');
    const existing=(await readConfig(this.io)).value.connections[input.connection.id];if(existing&&stable(profile(existing))!==stable(input.connection))fail('CONNECTION_CONFLICT');if(!current())fail('REQUEST_CANCELLED');
    this.clearSelection({phase:'setup'});this.discovery={state:'loading',key:stable(input)};this.publish();
    const reply=await this.request({v:1,operation:'probe',...input},{isCurrent:current});if(!current())fail('REQUEST_CANCELLED');
    this.discovery={state:reply.probe.canonical?'ready':'canonical',key:stable(input),probe:reply.probe};this.publish();if(!reply.probe.canonical)fail('CANONICAL_PROJECT_REQUIRED');
    const io={...this.io,readTextFile:async(...args)=>{const result=await this.io.readTextFile(...args);if(!current())fail('REQUEST_CANCELLED');return result;},writeTextFile:(...args)=>{if(!current())fail('REQUEST_CANCELLED');return this.io.writeTextFile(...args);}};
    const config=await saveRepoIntegration(io,{machine:input.binding.machine,repoRoot:input.binding.repoRoot,source:'gitlab',connection:reply.connection,selection:{...input.binding.gitlab,projectPath:reply.probe.projectPath}});if(!current())fail('REQUEST_CANCELLED');
    if(this.desired)this.selectConfig(config,this.desired.resolved,{all:this.desired.all});else this.config=config;return {config,binding:input.binding,probe:reply.probe};
  }
  close(){if(this.closed)return;this.cancelSetup();this.clearSelection({phase:'closed'});this.closed=true;this.value={state:'closed',view:this.viewKind,all:this.all,data:[],bindings:[],errors:[],loading:0,truncated:false,limitReached:false};}
}
