import {bindingKey,readConfig,validateConfig} from '../../shared/config.js';
import {trackerScope,trackerScopeKey,trackerOrigin,selectTracker,allTrackerBindings,validateRepoBinding,validateSnapshot,issueIdentityKey,ScopedTrackerCache,saveRepoIntegration,utf8Bytes} from '../../shared/tracker-model.js';
import {validatePullRequest,pullIdentityKey,prDetailCursor} from './pull-model.js';

const copy=value=>JSON.parse(JSON.stringify(value));
function freezeSnapshot(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))freezeSnapshot(child);Object.freeze(value);}return value;}
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,required,optional=[])=>object(value)&&required.every(k=>Object.hasOwn(value,k))&&Object.keys(value).every(k=>required.includes(k)||optional.includes(k));
const text=(value,max=512)=>typeof value==='string'&&value.trim().length>0&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value);
const name=value=>text(value,128)&&/^[A-Za-z0-9_.-]+$/.test(value)&&!['.','..'].includes(value);
function stable(value){if(Array.isArray(value))return '['+value.map(stable).join(',')+']';if(object(value))return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')+'}';return JSON.stringify(value);}
const messages={INVALID_REQUEST:'Check the GitHub connection and repository fields.',INVALID_CONNECTION:'Check the GitHub site, API URL and selected credential reference.',INVALID_SCOPE:'This repository or account changed. Reload its GitHub view.',INVALID_RESPONSE:'The GitHub helper returned an invalid or mismatched response.',INVALID_CONFIG:'Mission Control settings could not be read. The original file was preserved.',AUTH_REQUIRED:'The selected GitHub credentials are unavailable. Check this profile.',PERMISSION_DENIED:'The selected account cannot read this GitHub resource.',NOT_FOUND:'The selected GitHub resource was not found.',RATE_LIMITED:'GitHub reached its read limit. Retry after the reported delay.',STATUS_MAPPING_REQUIRED:'Choose one available Projects field and its stable status options, or configure label mapping.',ACCOUNT_SELECTION_UNSUPPORTED:'The installed gh cannot safely select this account. Use an environment reference or a supported version.',CLI_UNAVAILABLE:'The selected local GitHub program is unavailable.',CONNECTION_CONFLICT:'This profile is already used. Choose a new profile ID to change its connection.',REQUEST_TIMEOUT:'The GitHub read timed out. Retry this scope.',REQUEST_CANCELLED:'This GitHub operation was cancelled.',RESPONSE_TOO_LARGE:'The GitHub result exceeds its bounded size. Narrow the selected scope.',INCOMPLETE_RESULTS:'GitHub could not confirm a complete result. Narrow the selected scope and refresh.',UNTRUSTED_ORIGIN:'GitHub tried to leave the selected HTTPS origin.',HELPER_UNAVAILABLE:'The local GitHub helper could not run. Check that Node.js 22 or later is installed.',UPSTREAM_UNAVAILABLE:'GitHub is temporarily unavailable. Retry this connection.',HTTP_ERROR:'GitHub rejected this read request. Check the selected profile.',REQUEST_FAILED:'GitHub could not be reached. Check the selected profile and retry.'};
export class GithubDataError extends Error{
  constructor(code,details={}){const safe=Object.hasOwn(messages,code)?code:'REQUEST_FAILED';super(messages[safe]);this.name='GithubDataError';this.code=safe;if(Number.isFinite(details.retryAfterMs)&&details.retryAfterMs>=0)this.retryAfterMs=Math.min(details.retryAfterMs,86400000);}
}
const fail=code=>{throw new GithubDataError(code);};
const safeError=e=>e instanceof GithubDataError?e:new GithubDataError(['INVALID_PR','INVALID_PR_ACTION','INVALID_SNAPSHOT','INVALID_ISSUE'].includes(e?.code)?'INVALID_RESPONSE':e?.code==='INVALID_BINDING'?'INVALID_SCOPE':['INVALID_JSON','UNSUPPORTED_VERSION','CONFIG_PATH','CONFIG_DIRECTORY'].includes(e?.code)?'INVALID_CONFIG':e?.code);
function profile(value){
  if(!exact(value,['id','kind','site','apiBase'],['credentialEnv','gh'])||value.kind!=='github'||!text(value.id,96)||!/^[a-z][a-z0-9-]*$/.test(value.id)||['constructor','prototype'].includes(value.id)||!text(value.apiBase,2048)||!/^https:\/\/[^\s/@?#]+(?:\/[^\s?#]*)?$/.test(value.apiBase))fail('INVALID_CONNECTION');
  try{validateConfig({v:1,preferences:{githubProfile:value}});}catch{fail('INVALID_CONNECTION');}
  const env=Object.hasOwn(value,'credentialEnv'),gh=Object.hasOwn(value,'gh');
  if(env===gh||env&&!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value.credentialEnv)||gh&&(!exact(value.gh,['host','account'])||!text(value.gh.host,256)||!text(value.gh.account,100)))fail('INVALID_CONNECTION');
  return {...copy(value),site:trackerOrigin(value.site)};
}
export function githubApiBase(site){
  const origin=trackerOrigin(site),host=origin.slice(8);if(host==='github.com')return 'https://api.github.com';if(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.ghe\.com$/.test(host))return 'https://api.'+host;return origin+'/api/v3';
}
export function githubProjectFieldsCursor({owner,number}){
  if(!name(owner)||!Number.isInteger(number)||number<1||number>2147483647)fail('INVALID_REQUEST');return JSON.stringify({v:1,kind:'github-project-fields',owner,number});
}
export function readGithubProjectFieldsCursor(value){
  let c;try{c=JSON.parse(value);}catch{fail('INVALID_REQUEST');}
  if(!exact(c,['v','kind','owner','number'])||c.v!==1||c.kind!=='github-project-fields')fail('INVALID_REQUEST');githubProjectFieldsCursor(c);return c;
}
function inputShape(input){
  if(!exact(input,['v','operation','connection','binding'],['cursor'])||input.v!==1||!['issues','pulls','probe'].includes(input.operation)||input.cursor!==undefined&&input.cursor!==null&&!text(input.cursor,8192))fail('INVALID_REQUEST');
  const connection=profile(input.connection),binding=validateRepoBinding(input.binding);if(binding.github?.connectionId!==connection.id)fail('INVALID_SCOPE');
  if(input.operation==='probe'&&input.cursor)readGithubProjectFieldsCursor(input.cursor);
  if(input.operation!=='probe'&&input.cursor?.startsWith('{')){if(input.operation!=='pulls')fail('INVALID_SCOPE');let c;try{c=JSON.parse(input.cursor);}catch{fail('INVALID_SCOPE');}if(c?.kind!=='pr-detail')fail('INVALID_SCOPE');}
  return {...copy(input),connection,binding};
}
function validateProbe(value,input){
  const c=input.connection,b=input.binding.github;
  if(input.cursor){
    const selected=readGithubProjectFieldsCursor(input.cursor);
    if(!exact(value,['kind','site','owner','number','projectId','fields','complete'])||value.kind!=='project-fields'||value.site!==c.site||value.owner?.toLowerCase()!==selected.owner.toLowerCase()||value.number!==selected.number||!text(value.projectId,200)||value.complete!==true||!Array.isArray(value.fields)||value.fields.length>300)fail('INVALID_RESPONSE');
    const seen=new Set();for(const field of value.fields){
      if(!exact(field,['id','name','options'])||!text(field.id,200)||!text(field.name,200)||seen.has(field.id)||!Array.isArray(field.options)||field.options.length>250)fail('INVALID_RESPONSE');seen.add(field.id);const ids=new Set();
      for(const option of field.options){if(!exact(option,['id','name'])||!text(option.id,200)||!text(option.name,200)||ids.has(option.id))fail('INVALID_RESPONSE');ids.add(option.id);}
    }
  }else if(!exact(value,['kind','site','owner','repo','repositoryId','issuesEnabled'])||value.kind!=='repository'||value.site!==c.site||value.owner?.toLowerCase()!==b.owner.toLowerCase()||value.repo?.toLowerCase()!==b.repo.toLowerCase()||typeof value.repositoryId!=='string'||!/^[1-9][0-9]{0,199}$/.test(value.repositoryId)||typeof value.issuesEnabled!=='boolean')fail('INVALID_RESPONSE');
  return copy(value);
}

/** Exact public protocol validation is shared with this mod's Node dispatcher. */
export function validateGithubReply(value,request,{now=Date.now()}={}){
  const input=inputShape(request);
  if(!object(value)||value.v!==1||typeof value.ok!=='boolean')fail('INVALID_RESPONSE');
  if(!value.ok){
    const e=value.error;if(!exact(value,['v','ok','error'])||!exact(e,['code','message'],['status','retryAfterMs'])||!text(e.code,80)||!text(e.message,512)||e.status!==undefined&&(!Number.isInteger(e.status)||e.status<100||e.status>599)||e.retryAfterMs!==undefined&&(!Number.isFinite(e.retryAfterMs)||e.retryAfterMs<0||e.retryAfterMs>86400000))fail('INVALID_RESPONSE');return copy(value);
  }
  if(value.operation!==input.operation)fail('INVALID_RESPONSE');
  if(input.operation==='probe'){
    if(!exact(value,['v','ok','operation','connection','probe'])||stable(profile(value.connection))!==stable(input.connection))fail('INVALID_RESPONSE');return {...copy(value),probe:validateProbe(value.probe,input)};
  }
  if(!exact(value,input.operation==='issues'?['v','ok','operation','snapshot','progressHint']:['v','ok','operation','snapshot'])||input.operation==='issues'&&(typeof value.progressHint!=='string'||utf8Bytes(value.progressHint)>1024||/[\u0000-\u001f\u007f]/.test(value.progressHint)))fail('INVALID_RESPONSE');
  const source=input.operation==='issues'?'github':'github-pr',scope=trackerScope(source,input.connection,input.binding),validators=input.operation==='pulls'?{validateItem:validatePullRequest,itemKey:pullIdentityKey}:{};let snapshot;
  try{snapshot=validateSnapshot(value.snapshot,scope,{...validators,now});}catch{fail('INVALID_RESPONSE');}
  if(input.operation==='pulls'&&input.cursor?.startsWith('{')){
    let cursor;try{cursor=JSON.parse(input.cursor);}catch{fail('INVALID_RESPONSE');}
    if(snapshot.data.length!==1||snapshot.cursor||stable(JSON.parse(prDetailCursor(snapshot.data[0])))!==stable(cursor))fail('INVALID_RESPONSE');
  }
  if(snapshot.error){const safe=safeError(snapshot.error);snapshot.error={...snapshot.error,code:safe.code,message:safe.message};}
  return {...copy(value),snapshot};
}
export function githubSetupFields(connection){
  return [{path:'id',label:'Profile ID',kind:'text'},{path:'site',label:'GitHub site',kind:'text'},...(connection?.gh?[{path:'gh.host',label:'gh host',kind:'text'},{path:'gh.account',label:'gh account',kind:'text'}]:[{path:'credentialEnv',label:'Token environment variable',kind:'text'}])];
}
export function githubSetupModel(config,resolved,{connectionId}={}){
  const c=validateConfig(config);if(!resolved||resolved.state&&resolved.state!=='resolved')return {state:resolved?.state==='ambiguous'?'ambiguous':'unbound',profiles:[]};
  const target=validateRepoBinding({machine:resolved.machine,repoRoot:resolved.repoRoot}),bound=c.bindings[bindingKey(target.machine,target.repoRoot)]?.github,id=connectionId||bound?.connectionId,connection=id&&c.connections[id]?profile(c.connections[id]):null;
  return {state:'ready',target,selection:bound?copy(bound):{},connection,profiles:Object.values(c.connections).filter(p=>p.kind==='github').map(p=>({id:p.id,kind:p.kind,site:p.site})),fields:githubSetupFields(connection),credentialHint:'Select an existing gh account or enter an environment variable name. Credential values remain in the local helper.'};
}

// Herdr ends a continuation that overruns its time slice without running
// catch/finally, and a cancelled task's promise never settles. Every helper
// read finishes within its own deadlines long before this age.
export const STALE_LOAD_MS=90000;
/** Reserve each scope's tail before waiting for a shared slot, including queued jobs. */
export class HelperQueue{
  constructor({clock=()=>Date.now()}={}){this.clock=clock;this.holders=new Set();this.waiters=[];this.tails=new Map();}
  // An abandoned holder can never release, so its slot expires instead.
  active(){const now=this.clock();let total=0;for(const holder of this.holders)if(now-holder.at>=STALE_LOAD_MS)this.holders.delete(holder);else total++;return total;}
  hold(){const holder={at:this.clock()};this.holders.add(holder);return holder;}
  drain(){while(this.waiters.length&&this.active()<4)this.waiters.shift()(this.hold());}
  async acquire(){if(!this.waiters.length&&this.active()<4)return this.hold();return new Promise(resolve=>{this.waiters.push(resolve);this.drain();});}
  release(holder){if(this.holders.delete(holder))this.drain();}
  run(key,current,work){
    const tail=this.tails.get(key),previous=tail&&this.clock()-tail.at<STALE_LOAD_MS?tail.promise:null,promise=(async()=>{if(previous)try{await previous;}catch{}if(!current())fail('REQUEST_CANCELLED');const holder=await this.acquire();try{if(!current())fail('REQUEST_CANCELLED');return await work();}finally{this.release(holder);}})();
    const record={promise,at:this.clock()};this.tails.set(key,record);const cleanup=()=>{if(this.tails.get(key)===record)this.tails.delete(key);};promise.then(cleanup,cleanup);return promise;
  }
}
const helperQueue=new HelperQueue();
const desiredKey=value=>value?.all?'all':stable([value?.resolved?.state||'unbound',value?.resolved?.machine??null,value?.resolved?.repoRoot??null,value?.resolved?.worktreeRoot??null]);

export class GithubDataBridge{
  constructor(io,{view='issues',clock=()=>Date.now(),onChange=()=>{}}={}){
    if(!['issues','pulls'].includes(view))fail('INVALID_REQUEST');Object.assign(this,{io,viewKind:view,clock,onChange,source:view==='issues'?'github':'github-pr',entries:new Map(),visible:[],details:new Map(),pullIndexes:new WeakMap(),origins:new Map(),originRecords:new WeakMap(),retiredEntries:new Set(),generation:0,epoch:0,setupEpoch:0,closed:false,all:false,phase:'setup',errors:[],desired:null,discovery:null});this.publish();
  }
  itemKey(item){return this.viewKind==='issues'?issueIdentityKey(item):pullIdentityKey(item);}
  validators(){return this.viewKind==='pulls'?{validateItem:validatePullRequest,itemKey:pullIdentityKey}:{};}
  indexedPulls(snapshot){
    const rows=snapshot?.data;if(!rows)return new Map();let index=this.pullIndexes.get(rows);
    if(!index){index=new Map(rows.map(p=>[pullIdentityKey(p),p]));freezeSnapshot(rows);this.pullIndexes.set(rows,index);}return index;
  }
  publish(){
    if(this.closed)return;const bindings=this.visible.map(key=>{const e=this.entries.get(key);return {binding:e.selection.binding,scope:e.selection.scope,checkoutRoot:e.checkoutRoot,snapshot:e.cache.snapshot,loading:e.cache.pending,progressHint:e.progressHint};});
    const data=[],seen=new Set(),errors=[...this.errors];let bytes=0,truncated=false,loading=0;
    for(const entry of bindings){if(entry.loading||!entry.snapshot)loading++;if(entry.snapshot?.error)errors.push({binding:entry.binding,error:entry.snapshot.error});truncated||=Boolean(entry.snapshot?.truncated);
      const rows=this.viewKind==='pulls'?this.indexedPulls(entry.snapshot):(entry.snapshot?.data||[]).map(item=>[this.itemKey(item),item]);
      for(const [key,item]of rows){if(seen.has(key))continue;const size=utf8Bytes(JSON.stringify(item));if(data.length===1000||bytes+size>7*1024*1024){truncated=true;continue;}seen.add(key);bytes+=size;data.push(item);}
    }
    const state=errors.length?(data.length?'partial':'error'):loading?'loading':this.phase;const discovery=this.discovery?{state:this.discovery.state,...(this.discovery.probe?{probe:this.discovery.probe}:{}),...(this.discovery.error?{error:{code:this.discovery.error.code,message:this.discovery.error.message}}:{})}:null;this.value={state,view:this.viewKind,all:this.all,data,bindings,errors,loading,truncated,limitReached:truncated&&!bindings.some(b=>b.snapshot?.cursor),discovery};this.onChange(this.value);
  }
  view(){return this.value;}
  entryLeased(entry){return [...this.origins.values()].some(info=>info.entry===entry);}
  destroyEntry(entry){entry.cache.clear();entry.version=++this.epoch;entry.pending=null;this.retiredEntries.delete(entry);for(const[key,detail]of this.details)if(detail.entry===entry)this.details.delete(key);}
  detachEntry(entry){if(this.entryLeased(entry)){entry.cache.pending=false;entry.cache.epoch++;entry.pending=null;this.retiredEntries.add(entry);}else this.destroyEntry(entry);}
  dropOrigin(info){
    if(!info?.active)return false;const entry=info.entry;this.origins.delete(info.token);info.active=false;info.entry=null;info.pull=null;info.token=null;
    if(this.retiredEntries.has(entry)&&!this.entryLeased(entry))this.destroyEntry(entry);return true;
  }
  pruneOrigins(){const now=this.clock();for(const info of [...this.origins.values()])if(this.closed||!Number.isFinite(now)||now<info.createdAt||now-info.createdAt>=120000)this.dropOrigin(info);}
  originConfigMatches(info,config){
    try{const binding=config?.bindings?.[info.bindingKey],connection=binding?.github&&config.connections?.[binding.github.connectionId];return Boolean(connection)&&trackerScopeKey(trackerScope('github-pr',profile(connection),binding))===info.scopeKey;}catch{return false;}
  }
  originInfoCurrent(info){
    if(!info?.active||this.closed||!info.entry||info.entry.version!==info.version||!this.originConfigMatches(info,this.config))return false;
    const now=this.clock();if(!Number.isFinite(now)||now<info.createdAt||now-info.createdAt>=120000)return false;
    const found=this.indexedPulls(info.entry.cache.snapshot).get(info.identity);return Boolean(found)&&found.head.sha===info.pull.head.sha&&found.base.sha===info.pull.base.sha;
  }
  reconcileOrigins(){this.pruneOrigins();for(const info of [...this.origins.values()])if(!this.originInfoCurrent(info))this.dropOrigin(info);}
  acquirePullOrigin(value){
    this.pruneOrigins();if(this.closed||this.origins.size>=64)fail('REQUEST_CANCELLED');let pull,entry;try{({pull,entry}=this.pullEntry(value));}catch{fail('REQUEST_CANCELLED');}
    const createdAt=this.clock();if(!Number.isFinite(createdAt)||createdAt<0)fail('REQUEST_CANCELLED');const token=Object.freeze(Object.create(null)),info={token,active:true,pull:freezeSnapshot(pull),entry,version:entry.version,createdAt,bindingKey:bindingKey(pull.repoBinding.machine,pull.repoBinding.repoRoot),identity:pullIdentityKey(pull),scopeKey:trackerScopeKey(entry.selection.scope)};
    this.originRecords.set(token,info);this.origins.set(token,info);if(!this.originInfoCurrent(info)){this.dropOrigin(info);fail('REQUEST_CANCELLED');}return token;
  }
  pullOriginCurrent(origin){this.pruneOrigins();const info=object(origin)&&this.originRecords.get(origin);if(!this.originInfoCurrent(info)){if(info)this.dropOrigin(info);return false;}return true;}
  async validatePullOrigin(origin){
    if(!this.pullOriginCurrent(origin))fail('REQUEST_CANCELLED');const info=this.originRecords.get(origin);let config;
    try{config=(await readConfig(this.io)).value;}catch{this.dropOrigin(info);fail('REQUEST_CANCELLED');}
    if(!this.pullOriginCurrent(origin)||!this.originConfigMatches(info,config)){this.dropOrigin(info);fail('REQUEST_CANCELLED');}return true;
  }
  releasePullOrigin(origin){const info=object(origin)&&this.originRecords.get(origin);if(!info)fail('REQUEST_CANCELLED');return this.dropOrigin(info);}
  originEntry(value,origin){
    if(!this.pullOriginCurrent(origin))fail('REQUEST_CANCELLED');const info=this.originRecords.get(origin);let pull;try{pull=validatePullRequest(value,{scope:info.entry.selection.scope});}catch{fail('REQUEST_CANCELLED');}
    if(pullIdentityKey(pull)!==info.identity||pull.head.sha!==info.pull.head.sha||pull.base.sha!==info.pull.base.sha)fail('REQUEST_CANCELLED');return {pull,entry:info.entry};
  }
  clearSelection({phase='loading'}={}){
    this.pruneOrigins();if(phase==='closed'||phase==='error')for(const info of [...this.origins.values()])this.dropOrigin(info);
    this.generation++;for(const e of this.entries.values())this.detachEntry(e);this.entries.clear();this.visible=[];for(const[key,d]of this.details)if(!this.entryLeased(d.entry))this.details.delete(key);this.errors=[];this.phase=phase;this.publish();
  }
  selectConfig(config,resolved,{all=false}={}){
    if(this.closed)return this.value;const c=validateConfig(config),next={resolved:resolved?copy(resolved):null,all:Boolean(all)};
    if(this.desired&&desiredKey(next)!==desiredKey(this.desired))this.clearSelection();this.generation++;this.config=c;this.reconcileOrigins();this.desired=next;this.all=next.all;this.errors=[];let selections=[];
    if(all){try{selections=allTrackerBindings(c,this.source);}catch{for(const binding of Object.values(c.bindings)){if(!binding.github)continue;try{const s=selectTracker(c,{state:'resolved',machine:binding.machine,repoRoot:binding.repoRoot},this.source);if(s)selections.push(s);}catch(error){this.errors.push({binding:{machine:binding.machine,repoRoot:binding.repoRoot},error:safeError(error)});}}}}
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
    this.phase=this.visible.length?'ready':all||!resolved||resolved.state===undefined||resolved.state==='resolved'?'setup':'unbound';this.publish();return this.value;
  }
  async synchronize(resolved,{all=false}={}){
    const next={resolved:resolved?copy(resolved):null,all:Boolean(all)};if(this.closed)return this.value;if(desiredKey(next)!==desiredKey(this.desired))this.clearSelection();const generation=++this.generation;
    try{const c=await readConfig(this.io);if(!this.closed&&generation===this.generation)return this.selectConfig(c.value,next.resolved,{all:next.all});}
    catch(error){if(!this.closed&&generation===this.generation){this.clearSelection({phase:'error'});this.errors=[{error:safeError(error)}];this.publish();}}
    return this.value;
  }
  currentEntry(entry,version){const key=bindingKey(entry.selection.binding.machine,entry.selection.binding.repoRoot);return !this.closed&&entry.version===version&&this.entries.get(key)===entry&&this.visible.includes(key);}
  async request(input,{isCurrent=()=>true}={}){
    const request=inputShape(input),serialized=JSON.stringify(request);if(utf8Bytes(serialized)>65536)fail('INVALID_REQUEST');
    const scope=trackerScope('github',request.connection,request.binding),current=()=>!this.closed&&isCurrent();
    return helperQueue.run(trackerScopeKey(scope),current,async()=>{
      let result;try{const home=this.io.appHome();result=await this.io.exec('node',[home+'/mods/mission-control-github/backend.mjs',serialized],{cwd:home});}catch{fail('HELPER_UNAVAILABLE');}
      if(!current())fail('REQUEST_CANCELLED');if(result?.code!==0||typeof result.stdout!=='string')fail('HELPER_UNAVAILABLE');if(utf8Bytes(result.stdout)>8*1024*1024)fail('RESPONSE_TOO_LARGE');let reply;
      try{reply=validateGithubReply(JSON.parse(result.stdout),request,{now:this.clock()});}catch{fail('INVALID_RESPONSE');}
      if(!reply.ok)throw new GithubDataError(reply.error.code,reply.error);return reply;
    });
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
      }catch(error){if(current()){const safe=safeError(error);entry.cache.fail(ticket,{code:safe.code,message:safe.message,...(safe.retryAfterMs!==undefined?{retryAt:this.clock()+safe.retryAfterMs}:{})});}}
      finally{if(entry.pending===pending)entry.pending=null;this.publish();}return entry.cache.snapshot;
    })();entry.pending=pending;entry.pendingAt=now;this.publish();return pending;
  }
  async refresh({force=false,loadMore=false,binding}={}){if(this.closed)return this.value;const keys=binding?[bindingKey(binding.machine,binding.repoRoot)]:[...this.visible];await Promise.all(keys.filter(k=>this.visible.includes(k)).map(k=>this.refreshEntry(this.entries.get(k),{force,loadMore})));return this.value;}
  pullEntry(value){
    if(this.viewKind!=='pulls')fail('INVALID_REQUEST');const pull=validatePullRequest(value),key=bindingKey(pull.repoBinding.machine,pull.repoBinding.repoRoot),entry=this.entries.get(key);if(!entry||!this.visible.includes(key))fail('INVALID_SCOPE');
    try{validatePullRequest(pull,{scope:entry.selection.scope});}catch{fail('INVALID_SCOPE');}const found=this.indexedPulls(entry.cache.snapshot).get(pullIdentityKey(pull));if(!found||found.head.sha!==pull.head.sha||found.base.sha!==pull.base.sha)fail('INVALID_SCOPE');return {pull,entry};
  }
  detailKey(pull,entry){return stable([trackerScopeKey(entry.selection.scope),entry.version,pullIdentityKey(pull),pull.head.sha,pull.base.sha]);}
  detailState(value,{origin}={}){if(origin!==undefined&&!this.pullOriginCurrent(origin)||!this.details.size)return {state:'unloaded'};try{const {pull,entry}=origin!==undefined?this.originEntry(value,origin):this.pullEntry(value),d=this.details.get(this.detailKey(pull,entry));return d?{state:d.state,...(d.pull?{pull:copy(d.pull),fetchedAt:d.fetchedAt}:{}),...(d.error?{error:{code:d.error.code,message:d.error.message}}:{})}:{state:'unloaded'};}catch{return {state:'unloaded'};}}
  detailCurrent(value,options={}){const d=this.detailState(value,options);return d.state==='ready'&&this.clock()-d.fetchedAt<60000;}
  loadPullDetails(value,{force=false,origin}={}){
    const {pull,entry}=origin!==undefined?this.originEntry(value,origin):this.pullEntry(value),key=this.detailKey(pull,entry),old=this.details.get(key),version=entry.version;
    const deliver=promise=>promise.then(result=>{if(origin!==undefined){this.originEntry(pull,origin);}else if(!this.currentEntry(entry,version))fail('REQUEST_CANCELLED');return copy(result);});
    if(old?.state==='loading'&&this.clock()-old.startedAt<STALE_LOAD_MS)return deliver(old.promise);if(!force&&old?.state==='ready'&&this.clock()-old.fetchedAt<60000)return deliver(Promise.resolve(old.pull));
    const identity=pullIdentityKey(pull),record={entry,version,identity,state:'loading',startedAt:this.clock()},current=()=>{
      this.pruneOrigins();if(this.closed||entry.version!==version||this.details.get(key)!==record)return false;
      const leased=[...this.origins.values()].some(info=>info.entry===entry&&info.identity===identity&&info.pull.head.sha===pull.head.sha&&info.pull.base.sha===pull.base.sha&&this.originInfoCurrent(info));
      if(!this.currentEntry(entry,version)&&!leased)return false;const member=this.indexedPulls(entry.cache.snapshot).get(identity);return Boolean(member)&&member.head.sha===pull.head.sha&&member.base.sha===pull.base.sha;
    };this.details.set(key,record);
    while(this.details.size>100){const candidate=[...this.details].find(([k,d])=>k!==key&&(d.state!=='loading'||this.clock()-d.startedAt>=STALE_LOAD_MS)&&![...this.origins.values()].some(info=>info.entry===d.entry&&info.identity===d.identity));if(!candidate){this.details.delete(key);fail('RESPONSE_TOO_LARGE');}this.details.delete(candidate[0]);}
    const promise=(async()=>{try{const reply=await this.request({v:1,operation:'pulls',connection:copy(entry.selection.connection),binding:copy(entry.selection.binding),cursor:prDetailCursor(pull)},{isCurrent:current});if(!current())fail('REQUEST_CANCELLED');record.state='ready';record.pull=reply.snapshot.data[0];record.fetchedAt=reply.snapshot.fetchedAt;if(reply.snapshot.error){record.error=safeError(reply.snapshot.error);if(reply.snapshot.error.code!=='INCOMPLETE_RESULTS'){record.state='error';throw record.error;}}return copy(record.pull);}catch(error){const safe=safeError(error);if(safe.code==='INVALID_RESPONSE')for(const info of [...this.origins.values()])if(info.entry===entry&&info.identity===identity)this.dropOrigin(info);if(current()){record.state='error';delete record.pull;record.error=safe;}throw safe;}finally{this.publish();}})();record.promise=promise;this.publish();return deliver(promise);
  }
  cancelSetup(){this.setupEpoch++;this.discovery=null;}
  setupInput({target,connection,selection}){const c=profile(connection),binding=validateRepoBinding({machine:target.machine,repoRoot:target.repoRoot,github:{...copy(selection),connectionId:c.id}});return {connection:c,binding};}
  async discoverProjectFields({target,connection,selection,owner,number},{isCurrent=()=>true}={}){
    const input=this.setupInput({target,connection,selection}),cursor=githubProjectFieldsCursor({owner,number}),key=stable([input,cursor]),epoch=++this.setupEpoch;this.discovery={state:'loading',key};const current=()=>!this.closed&&epoch===this.setupEpoch&&isCurrent();this.publish();
    try{const reply=await this.request({v:1,operation:'probe',...input,cursor},{isCurrent:current});if(!current())fail('REQUEST_CANCELLED');this.discovery={state:'ready',key,probe:reply.probe};this.publish();return copy(reply.probe);}
    catch(error){if(current()){this.discovery={state:'error',key,error:safeError(error)};this.publish();}throw safeError(error);}
  }
  async saveSetup({target,connection,selection},{isCurrent=()=>true}={}){
    const input=this.setupInput({target,connection,selection}),epoch=++this.setupEpoch,current=()=>!this.closed&&epoch===this.setupEpoch&&isCurrent();if(!current())fail('REQUEST_CANCELLED');
    const existing=(await readConfig(this.io)).value.connections[input.connection.id];if(existing&&stable(profile(existing))!==stable(input.connection))fail('CONNECTION_CONFLICT');if(!current())fail('REQUEST_CANCELLED');
    const project=input.binding.github.status?.project,cursor=project?githubProjectFieldsCursor(project):undefined;this.discovery=null;
    const reply=await this.request({v:1,operation:'probe',...input,...(cursor?{cursor}:{})},{isCurrent:current});if(!current())fail('REQUEST_CANCELLED');
    if(project){const field=reply.probe.fields.find(f=>f.id===project.fieldId),chosen=Object.values(project.options).flat();if(!field||!chosen.length||chosen.some(id=>!field.options.some(o=>o.id===id)))fail('STATUS_MAPPING_REQUIRED');}
    const io={...this.io,readTextFile:async(...args)=>{const result=await this.io.readTextFile(...args);if(!current())fail('REQUEST_CANCELLED');return result;},writeTextFile:(...args)=>{if(!current())fail('REQUEST_CANCELLED');return this.io.writeTextFile(...args);}};
    const config=await saveRepoIntegration(io,{machine:input.binding.machine,repoRoot:input.binding.repoRoot,source:'github',connection:reply.connection,selection:input.binding.github});if(!current())fail('REQUEST_CANCELLED');
    if(this.desired)this.selectConfig(config,this.desired.resolved,{all:this.desired.all});return {config,binding:input.binding,probe:reply.probe};
  }
  close(){if(this.closed)return;this.cancelSetup();this.clearSelection({phase:'closed'});this.closed=true;this.value={state:'closed',view:this.viewKind,all:this.all,data:[],bindings:[],errors:[],loading:0,truncated:false,limitReached:false};}
}
