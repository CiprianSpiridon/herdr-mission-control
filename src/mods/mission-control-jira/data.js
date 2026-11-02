import {bindingKey,readConfig,validateConfig} from '../../shared/config.js';
import {trackerScope,trackerScopeKey,trackerOrigin,selectTracker,allTrackerBindings,validateRepoBinding,validateSnapshot,issueIdentityKey,aggregateIssues,ScopedTrackerCache,saveRepoIntegration,utf8Bytes} from '../../shared/tracker-model.js';

const copy=value=>JSON.parse(JSON.stringify(value));
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(v,required,optional=[])=>object(v)&&required.every(k=>Object.hasOwn(v,k))&&Object.keys(v).every(k=>required.includes(k)||optional.includes(k));
const text=(v,max=512)=>typeof v==='string'&&v.trim().length>0&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v);
const messages={INVALID_REQUEST:'Check the Jira connection and repository fields.',INVALID_CONNECTION:'Check the selected Jira adapter and credential environment references.',INVALID_SCOPE:'Reload this repository and its selected Jira profile.',INVALID_RESPONSE:'Jira returned an invalid or mismatched helper response.',INVALID_CONFIG:'Mission Control settings could not be read. The original file was preserved.',AUTH_REQUIRED:'The selected Jira credentials are unavailable or expired. Check its environment references.',PERMISSION_DENIED:'The selected account cannot read this Jira project.',NOT_FOUND:'The selected Jira resource was not found.',RATE_LIMITED:'Jira reached its read limit. Retry after the reported delay.',CANONICAL_SITE_REQUIRED:'Use the canonical Jira API base URL from serverInfo.baseUrl, rather than its custom display URL.',CLI_UNAVAILABLE:'The configured Jira CLI is not installed locally. Choose an installed executable or JSON bridge.',MCP_UNAVAILABLE:'The selected MCP server is unavailable. Check its endpoint or local program.',MCP_TOOL_UNAVAILABLE:'The selected MCP search tool is missing or its schema changed. Check the tool mapping.',MCP_TOOL_NOT_READ_ONLY:'Select a search tool that the MCP server declares read-only.',STATUS_MAPPING_REQUIRED:'Configure an unambiguous To do, In progress and Done mapping.',UNSUPPORTED_INTEGRATION_HOST:'CLI and stdio MCP integrations run locally. Use a local bridge or HTTPS MCP endpoint for a server.',UNTRUSTED_ORIGIN:'The selected integration tried to leave its configured HTTPS origin.',REQUEST_TIMEOUT:'The Jira read timed out. Retry this connection.',REQUEST_CANCELLED:'This Jira operation was cancelled.',RESPONSE_TOO_LARGE:'The Jira result exceeds its bounded size. Narrow the project or query.',ADAPTER_FAILED:'The selected Jira program or search tool failed. Check its read-only JSON mapping.',HELPER_UNAVAILABLE:'The local Jira helper could not run. Check that Node.js 22 or later is installed.',CONNECTION_CONFLICT:'This profile is already used. Choose a new profile ID to change its connection.',INCOMPLETE_RESULTS:'Jira could not confirm a complete result set. Narrow the project or query.',REQUEST_FAILED:'Jira could not be reached. Check the selected connection and retry.'};
export class JiraDataError extends Error{constructor(code,details={}){const safe=Object.hasOwn(messages,code)?code:'REQUEST_FAILED';super(messages[safe]);this.name='JiraDataError';this.code=safe;if(Number.isFinite(details.retryAfterMs)&&details.retryAfterMs>=0)this.retryAfterMs=Math.min(details.retryAfterMs,86400000);}}
const fail=code=>{throw new JiraDataError(code);};
// Herdr ends a continuation that overruns its time slice without running
// catch/finally, and a cancelled task's promise never settles. Every helper
// read finishes within its own deadlines long before this age.
export const STALE_LOAD_MS=90000;
const safeError=error=>error instanceof JiraDataError?error:new JiraDataError(Object.hasOwn(messages,error?.code)?error.code:error?.code==='INVALID_BINDING'?'INVALID_SCOPE':['INVALID_ISSUE','INVALID_SNAPSHOT'].includes(error?.code)?'INVALID_RESPONSE':['INVALID_JSON','UNSUPPORTED_VERSION','CONFIG_PATH','CONFIG_DIRECTORY'].includes(error?.code)?'INVALID_CONFIG':'REQUEST_FAILED');
function stable(value){if(Array.isArray(value))return '['+value.map(stable).join(',')+']';if(object(value))return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')+'}';return JSON.stringify(value);}
const selectionKey=desired=>desired?.all?'all':stable([desired?.resolved?.state||'unbound',desired?.resolved?.machine??null,desired?.resolved?.repoRoot??null]);

export function jiraRouteDescription(connection){
  if(connection?.kind==='api')return connection.cloudId?'Scoped token or service account · cloud ID gateway':connection.auth?.kind==='bearer'?'OAuth access token · discover this exact Jira site':'Unscoped API token · canonical Jira site';
  return connection?.kind==='cli'?'Installed local CLI / JSON bridge':connection?.kind==='mcp-stdio'?'Configured local MCP server':connection?.kind==='mcp-http'?'Configured HTTPS MCP server':'Choose a connection';
}
export function jiraSetupFields(connection){
  const fields=[{path:'id',label:'Profile ID',kind:'text'},{path:'site',label:'Canonical Jira base URL',kind:'text'},{path:'kind',label:'Connection',kind:'select',choices:['api','cli','mcp-stdio','mcp-http']}];
  if(connection?.kind==='api')fields.push({path:'cloudId',label:'Cloud ID',kind:'text',optional:true},{path:'auth.kind',label:'Authentication',kind:'select',choices:['basic','bearer']});
  if(connection?.kind==='mcp-http')fields.push({path:'url',label:'MCP endpoint',kind:'text'},{path:'auth.kind',label:'Authentication',kind:'select',choices:['none','basic','bearer']});
  if(['api','mcp-http'].includes(connection?.kind)&&connection.auth){if(connection.auth.kind==='basic')fields.push({path:'auth.usernameEnv',label:'Email environment variable',kind:'text'});fields.push({path:'auth.tokenEnv',label:'Token environment variable',kind:'text'});}
  if(connection?.kind==='cli'||connection?.kind==='mcp-stdio')fields.push({path:'execution',label:'Local program and arguments',kind:'json'});
  if(connection?.kind==='cli')fields.push({path:'mapping',label:'JSON result mapping',kind:'json'});
  if(connection?.kind?.startsWith('mcp-'))fields.push({path:'search',label:'Read-only search tool and mapping',kind:'json'});
  return fields;
}
export function jiraSetupModel(config,resolved,{connectionId}={}){
  const c=validateConfig(config);if(!resolved||resolved.state&&resolved.state!=='resolved')return {state:resolved?.state==='ambiguous'?'ambiguous':'unbound',profiles:[]};
  const target=validateRepoBinding({machine:resolved.machine,repoRoot:resolved.repoRoot}),bound=c.bindings[bindingKey(target.machine,target.repoRoot)]?.jira;
  const id=connectionId||bound?.connectionId,connection=id&&Object.hasOwn(c.connections,id)?copy(c.connections[id]):null;
  return {state:'ready',target,selection:bound?copy(bound):{},connection,profiles:Object.values(c.connections).filter(p=>['api','cli','mcp-stdio','mcp-http'].includes(p.kind)).map(p=>({id:p.id,kind:p.kind,site:p.site})),fields:jiraSetupFields(connection),route:jiraRouteDescription(connection),siteHint:'Use serverInfo.baseUrl. A custom display URL is a separate Jira setting.',credentialHint:'Enter environment variable names; token values stay in the local helper.'};
}

function mergePages(previous,next,scope,now){
  const rows=new Map(previous.data.map(item=>[issueIdentityKey(item),item]));for(const item of next.data)rows.set(issueIdentityKey(item),item);
  const data=[];let bytes=0,capped=false;
  for(const item of rows.values()){const size=utf8Bytes(JSON.stringify(item));if(data.length===1000||bytes+size>7*1024*1024){capped=true;break;}data.push(item);bytes+=size;}
  const result={...next,data,fetchedAt:Math.min(previous.fetchedAt,next.fetchedAt)};
  if(capped){result.truncated=true;delete result.cursor;result.error={code:'RESPONSE_TOO_LARGE',message:messages.RESPONSE_TOO_LARGE};}
  return validateSnapshot(result,scope,{now});
}

/** Pure native bridge: all effects come from the calling mod's installed Herdr IO. */
export class JiraDataBridge{
  constructor(io,{clock=()=>Date.now(),onChange=()=>{}}={}){
    this.io=io;this.clock=clock;this.onChange=onChange;this.entries=new Map();this.visible=[];this.jobs=new Map();this.waiters=[];this.holders=new Set();this.closed=false;this.generation=0;this.setupEpoch=0;this.phase='setup';this.all=false;this.schemaErrors=[];this.globalError=null;this.desired=null;this.publish();
  }
  publish(){
    if(this.closed)return;
    const bindings=this.visible.map(key=>{const entry=this.entries.get(key);return {binding:entry.selection.binding,scope:entry.selection.scope,snapshot:entry.cache.snapshot,loading:entry.cache.pending};});
    const snapshots=bindings.map(b=>b.snapshot).filter(Boolean),aggregate=aggregateIssues(snapshots),errors=[...this.schemaErrors,...bindings.filter(b=>b.snapshot?.error).map(b=>({binding:b.binding,error:b.snapshot.error}))];if(this.globalError)errors.push({error:{code:this.globalError.code,message:this.globalError.message}});
    const loading=bindings.filter(b=>b.loading||!b.snapshot).length;
    const state=this.phase==='loading'&&!bindings.length?'loading':errors.length?(aggregate.data.length||bindings.some(b=>b.snapshot&&!b.snapshot.error)?'partial':'error'):loading?'loading':this.phase;
    this.value={state,all:this.all,data:aggregate.data,bindings,errors,loading,truncated:aggregate.truncated,limitReached:aggregate.data.length===1000&&aggregate.truncated};this.onChange(this.value);
  }
  view(){return this.value;}
  clearSelection({phase='loading'}={}){
    this.generation++;for(const key of this.visible){const e=this.entries.get(key);e.cache.clear();e.pending=null;}this.visible=[];this.schemaErrors=[];this.globalError=null;this.phase=phase;this.publish();
  }
  selectConfig(config,resolved,{all=false}={}){
    if(this.closed)return this.value;this.generation++;this.config=validateConfig(config);this.all=Boolean(all);this.desired={resolved:resolved?copy(resolved):null,all:this.all};this.schemaErrors=[];this.globalError=null;
    let selections=[];
    if(all){try{selections=allTrackerBindings(this.config,'jira');}catch{
      for(const binding of Object.values(this.config.bindings)){if(!binding.jira)continue;try{const selected=selectTracker(this.config,{state:'resolved',machine:binding.machine,repoRoot:binding.repoRoot},'jira');if(selected)selections.push(selected);}catch(error){const safe=safeError(error);this.schemaErrors.push({binding:{machine:binding.machine,repoRoot:binding.repoRoot},error:{code:safe.code,message:safe.message}});}}
    }}else if(resolved?.state===undefined||resolved.state==='resolved'){try{if(resolved&&!Object.hasOwn(resolved,'machine'))fail('INVALID_SCOPE');const selected=selectTracker(this.config,resolved,'jira');if(selected)selections=[selected];}catch(error){this.globalError=safeError(error);}}
    const wanted=new Set(selections.map(s=>bindingKey(s.binding.machine,s.binding.repoRoot)));
    for(const old of this.visible)if(!wanted.has(old)){const e=this.entries.get(old);e.cache.clear();e.pending=null;}
    this.visible=[];
    for(const selection of selections){const key=bindingKey(selection.binding.machine,selection.binding.repoRoot);let entry=this.entries.get(key);
      if(!entry){entry={selection,cache:new ScopedTrackerCache({clock:this.clock}),pending:null};this.entries.set(key,entry);}
      if(entry.cache.scope&&trackerScopeKey(entry.cache.scope)!==trackerScopeKey(selection.scope)){entry.cache.clear();entry.pending=null;}
      entry.selection=selection;entry.cache.select(selection.scope);this.visible.push(key);
    }
    this.phase=this.visible.length?'ready':all||resolved?.state===undefined||resolved?.state==='resolved'?'setup':'unbound';this.publish();return this.value;
  }
  async synchronize(resolved,{all=false}={}){
    if(this.closed)return this.value;const next={resolved:resolved?copy(resolved):null,all:Boolean(all)};
    this.all=next.all;if(selectionKey(next)!==selectionKey(this.desired))this.clearSelection();this.desired=next;const generation=++this.generation;
    try{const config=await readConfig(this.io);if(this.closed||generation!==this.generation)return this.value;return this.selectConfig(config.value,next.resolved,{all:next.all});}
    catch(error){if(this.closed||generation!==this.generation)return this.value;this.clearSelection({phase:'error'});this.globalError=safeError(error);this.publish();return this.value;}
  }
  async request(input){
    if(this.closed)fail('REQUEST_CANCELLED');let serialized;try{serialized=JSON.stringify(input);}catch{fail('INVALID_REQUEST');}if(utf8Bytes(serialized)>65536)fail('INVALID_REQUEST');
    let result;try{const home=this.io.appHome();result=await this.io.exec('node',[home+'/mods/mission-control-jira/backend.mjs',serialized],{cwd:home});}catch{fail('HELPER_UNAVAILABLE');}
    if(this.closed)fail('REQUEST_CANCELLED');if(result?.code!==0)fail('HELPER_UNAVAILABLE');if(typeof result.stdout!=='string')fail('INVALID_RESPONSE');if(utf8Bytes(result.stdout)>8*1024*1024)fail('RESPONSE_TOO_LARGE');
    let response;try{response=JSON.parse(result.stdout);}catch{fail('INVALID_RESPONSE');}
    if(!object(response)||response.v!==1||typeof response.ok!=='boolean')fail('INVALID_RESPONSE');
    if(!response.ok){if(!exact(response,['v','ok','error'])||!exact(response.error,['code','message'],['status','retryAfterMs'])||!text(response.error.code,80)||!text(response.error.message,512)||response.error.status!==undefined&&(!Number.isInteger(response.error.status)||response.error.status<100||response.error.status>599)||response.error.retryAfterMs!==undefined&&(!Number.isFinite(response.error.retryAfterMs)||response.error.retryAfterMs<0||response.error.retryAfterMs>86400000))fail('INVALID_RESPONSE');throw new JiraDataError(response.error.code,response.error);}
    if(response.operation!==input.operation)fail('INVALID_RESPONSE');
    if(input.operation==='issues'){
      if(!exact(response,['v','ok','operation','snapshot']))fail('INVALID_RESPONSE');try{return validateSnapshot(response.snapshot,trackerScope('jira',input.connection,input.binding),{now:this.clock()});}catch{fail('INVALID_RESPONSE');}
    }
    if(!exact(response,['v','ok','operation','connection','probe'])||!exact(response.probe,['site','route'],['cloudId','tool']))fail('INVALID_RESPONSE');
    try{validateConfig({v:1,connections:{[response.connection.id]:response.connection}});if(response.connection.id!==input.connection.id||response.connection.kind!==input.connection.kind||trackerOrigin(response.connection.site)!==trackerOrigin(input.connection.site)||response.probe.site!==trackerOrigin(input.connection.site))fail('INVALID_RESPONSE');}catch{fail('INVALID_RESPONSE');}
    const route=input.connection.kind==='api'?['tenant','gateway']:input.connection.kind==='cli'?['local-cli']:[input.connection.kind];
    if(!route.includes(response.probe.route)||response.probe.cloudId!==undefined&&response.probe.cloudId!==null&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(response.probe.cloudId)||response.probe.tool!==undefined&&response.probe.tool!==input.connection.search?.tool)fail('INVALID_RESPONSE');return copy(response.probe);
  }
  // An abandoned holder can never release, so its slot expires instead.
  activeSlots(){const now=this.clock();for(const holder of this.holders)if(now-holder.at>=STALE_LOAD_MS)this.holders.delete(holder);return this.holders.size;}
  hold(){const holder={at:this.clock()};this.holders.add(holder);return holder;}
  drain(){while(this.waiters.length&&this.activeSlots()<4)this.waiters.shift()(this.hold());}
  release(holder){if(this.holders.delete(holder))this.drain();}
  async query(scope,cursor,current,work){
    const key=trackerScopeKey(scope),previous=this.jobs.get(key);
    if(previous&&this.clock()-previous.at<STALE_LOAD_MS){if(previous.cursor===cursor)return previous.promise;try{await previous.promise;}catch{}if(!current())fail('REQUEST_CANCELLED');return this.query(scope,cursor,current,work);}
    const holder=!this.waiters.length&&this.activeSlots()<4?this.hold():await new Promise(resolve=>{this.waiters.push(resolve);this.drain();});
    let job;
    try{if(this.closed||!current())fail('REQUEST_CANCELLED');const promise=work();job={cursor,promise,at:this.clock()};this.jobs.set(key,job);return await promise;}
    finally{if(job&&this.jobs.get(key)===job)this.jobs.delete(key);this.release(holder);}
  }
  // A ticket without its live load, or a load past every helper deadline, was abandoned by the host.
  abandonedLoad(entry){return entry.pending?this.clock()-entry.pendingAt>=STALE_LOAD_MS:entry.cache.pending;}
  hasAbandonedLoad(){return !this.closed&&this.visible.some(key=>this.entries.has(key)&&this.abandonedLoad(this.entries.get(key)));}
  recoverAbandoned(){return Promise.all(this.visible.filter(key=>this.entries.has(key)&&this.abandonedLoad(this.entries.get(key))).map(key=>this.refreshEntry(this.entries.get(key),{force:true})));}
  refreshEntry(entry,{force=false,loadMore=false}={}){
    if(this.abandonedLoad(entry)){entry.pending=null;entry.cache.abandon();this.publish();}
    if(entry.pending)return entry.pending;const selection=copy(entry.selection),previous=entry.cache.snapshot,now=this.clock();
    if(previous?.error?.retryAt>now||loadMore&&!previous?.cursor||!loadMore&&!force&&previous&&!previous.error&&now-previous.fetchedAt<60000)return Promise.resolve(previous);
    const ticket=entry.cache.begin(selection.scope);if(!ticket)return entry.pending||Promise.resolve(previous);const cursor=loadMore?previous.cursor:undefined;
    const run=async()=>{
      try{const chunk=await this.query(selection.scope,cursor,()=>!this.closed&&entry.cache.current(ticket),()=>this.request({v:1,operation:'issues',connection:selection.connection,binding:selection.binding,...(cursor?{cursor}:{})}));
        if(!this.closed&&entry.cache.current(ticket))entry.cache.accept(ticket,loadMore?mergePages(previous,chunk,selection.scope,this.clock()):chunk);
      }catch(error){if(!this.closed&&entry.cache.current(ticket)){const safe=safeError(error);entry.cache.fail(ticket,{code:safe.code,message:safe.message,...(safe.retryAfterMs!==undefined?{retryAt:this.clock()+safe.retryAfterMs}:{})});}}
      finally{if(entry.pending===pending)entry.pending=null;if(!this.closed)this.publish();}
      return entry.cache.snapshot;
    };
    const pending=run();entry.pending=pending;entry.pendingAt=now;this.publish();return pending;
  }
  async refresh({force=false,loadMore=false,binding}={}){
    if(this.closed)return this.value;const keys=binding?[bindingKey(binding.machine,binding.repoRoot)]:this.visible;
    await Promise.all(keys.filter(key=>this.visible.includes(key)).map(key=>this.refreshEntry(this.entries.get(key),{force,loadMore})));return this.value;
  }
  cancelSetup(){this.setupEpoch++;}
  async saveSetup({target,connection,selection},{isCurrent=()=>true}={}){
    const binding=validateRepoBinding({machine:target.machine,repoRoot:target.repoRoot,jira:{...copy(selection),connectionId:connection.id}}),profile={...copy(connection),site:trackerOrigin(connection.site)},epoch=++this.setupEpoch;
    validateConfig({v:1,connections:{[profile.id]:profile},bindings:{[bindingKey(binding.machine,binding.repoRoot)]:binding}});
    const current=()=>!this.closed&&epoch===this.setupEpoch&&isCurrent();if(!current())fail('REQUEST_CANCELLED');
    const existing=(await readConfig(this.io)).value.connections[profile.id];if(existing&&stable(existing)!==stable(profile))fail('CONNECTION_CONFLICT');
    if(!current())fail('REQUEST_CANCELLED');this.clearSelection();
    const probe=await this.request({v:1,operation:'probe',connection:profile,binding});if(!current())fail('REQUEST_CANCELLED');
    const io={...this.io,readTextFile:async(...args)=>{const value=await this.io.readTextFile(...args);if(!current())fail('REQUEST_CANCELLED');return value;},writeTextFile:(...args)=>{if(!current())fail('REQUEST_CANCELLED');return this.io.writeTextFile(...args);}};
    const config=await saveRepoIntegration(io,{machine:binding.machine,repoRoot:binding.repoRoot,source:'jira',connection:profile,selection:binding.jira});
    if(!current())fail('REQUEST_CANCELLED');if(this.desired)this.selectConfig(config,this.desired.resolved,{all:this.desired.all});else this.config=config;
    return {config,binding,probe};
  }
  close(){if(this.closed)return;this.closed=true;this.generation++;this.setupEpoch++;for(const entry of this.entries.values()){entry.cache.clear();entry.pending=null;}this.visible=[];this.value={state:'closed',all:this.all,data:[],bindings:[],errors:[],loading:0,truncated:false,limitReached:false};}
}
