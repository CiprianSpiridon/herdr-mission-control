import {bindingKey,canonicalRepoPath,gitlabProjectPath,resolveBinding,updateConfig,validateConfig} from './config.js';

export const TRACKER_GROUPS=['todo','inProgress','done'];
const messages={INVALID_FILTER:'Choose an available board status filter.',INVALID_SCOPE:'Select a configured repository and tracker connection.',INVALID_BINDING:'The repository tracker binding is invalid.',INVALID_ISSUE:'The tracker returned an invalid issue; reload its source mapping.',INVALID_SNAPSHOT:'The tracker response does not match the requested scope.',STATUS_MAPPING_REQUIRED:'Choose an unambiguous source status mapping.',UNSUPPORTED_INTEGRATION_HOST:'CLI and stdio MCP integrations must run locally. Configure a local bridge or HTTPS MCP endpoint.',CONNECTION_CONFLICT:'This connection is already used elsewhere. Choose a new profile ID before changing it here.'};
export class TrackerModelError extends Error{constructor(code){super(messages[code]||messages.INVALID_SNAPSHOT);this.code=Object.hasOwn(messages,code)?code:'INVALID_SNAPSHOT';}}
const fail=code=>{throw new TrackerModelError(code);};
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,required,optional=[])=>object(v)&&required.every(k=>Object.hasOwn(v,k))&&Object.keys(v).every(k=>required.includes(k)||optional.includes(k));
const text=(v,max=512)=>typeof v==='string'&&v.trim().length>0&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v);
const id=v=>text(v,96)&&/^[a-z][a-z0-9-]*$/.test(v)&&!['constructor','prototype'].includes(v);
const machine=v=>v===null||text(v,128);
const date=v=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<=8640000000000000;
const clone=v=>JSON.parse(JSON.stringify(v));
const trackerSources=['jira','github','github-pr','gitlab','gitlab-mr'];
function sourceKind(source){if(!trackerSources.includes(source))fail('INVALID_SCOPE');return source==='github-pr'?'github':source==='gitlab-mr'?'gitlab':source;}
export const utf8Bytes=value=>{let n=0;for(const c of value){const code=c.codePointAt(0);n+=code<128?1:code<2048?2:code<65536?3:4;}return n;};
function json(value,code='INVALID_SCOPE'){try{validateConfig({v:1,preferences:{tracker:value}});}catch{fail(code);}}
function stable(value){if(Array.isArray(value))return '['+value.map(stable).join(',')+']';if(object(value))return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')+'}';return JSON.stringify(value);}
/** Native-safe URL origin normalization; Node transport does full URL parsing. */
export function trackerOrigin(value){
  if(!text(value,2048))fail('INVALID_SCOPE');const match=value.match(/^https:\/\/(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)(?::([0-9]{1,5}))?\/?$/);
  if(!match||match[2]&&(Number(match[2])<1||Number(match[2])>65535))fail('INVALID_SCOPE');
  const host=match[1].toLowerCase();if(!host.startsWith('[')&&host.split('.').some(part=>part.length>63||!part||part.startsWith('-')||part.endsWith('-')))fail('INVALID_SCOPE');
  if(/^\d+\.\d+\.\d+\.\d+$/.test(host)&&host.split('.').some(n=>Number(n)>255))fail('INVALID_SCOPE');
  return 'https://'+host+(match[2]&&Number(match[2])!==443?':'+Number(match[2]):'');
}
function repoName(value){return text(value,128)&&/^[A-Za-z0-9_.-]+$/.test(value)&&!['.','..'].includes(value);}
function list(value,{caseFold=false}={}){if(!Array.isArray(value)||value.length>100||value.some(v=>!text(v,200)))fail('STATUS_MAPPING_REQUIRED');const keys=value.map(v=>caseFold?v.toLowerCase():v);if(new Set(keys).size!==keys.length)fail('STATUS_MAPPING_REQUIRED');return [...value];}
export function validateStatusMapping(value){
  if(value===undefined)return undefined;
  if(!object(value)||Object.keys(value).length!==1)fail('STATUS_MAPPING_REQUIRED');
  let groups,result,caseFold=false;
  if(Object.hasOwn(value,'labels')){if(!exact(value.labels,TRACKER_GROUPS))fail('STATUS_MAPPING_REQUIRED');caseFold=true;groups=Object.fromEntries(TRACKER_GROUPS.map(k=>[k,list(value.labels[k],{caseFold})]));result={labels:groups};}
  else if(Object.hasOwn(value,'project')){const p=value.project;if(!exact(p,['owner','number','fieldId','options','unmapped'])||!repoName(p.owner)||!Number.isSafeInteger(p.number)||p.number<1||!text(p.fieldId,200)||p.unmapped!=='error'||!exact(p.options,TRACKER_GROUPS))fail('STATUS_MAPPING_REQUIRED');groups=Object.fromEntries(TRACKER_GROUPS.map(k=>[k,list(p.options[k])]));result={project:{...clone(p),options:groups}};}
  else fail('STATUS_MAPPING_REQUIRED');
  const used=new Set();for(const values of Object.values(groups))for(const value of values){const key=caseFold?value.toLowerCase():value;if(used.has(key))fail('STATUS_MAPPING_REQUIRED');used.add(key);}return result;
}
function selection(value,source){
  if(!object(value)||!id(value.connectionId))fail('INVALID_BINDING');
  if(source==='jira'){
    if(!exact(value,['connectionId'],['project','jql'])||!value.project&&!value.jql||value.project!==undefined&&!text(value.project,256)||value.jql!==undefined&&!text(value.jql,8192))fail('INVALID_BINDING');
    return {connectionId:value.connectionId,...(value.project!==undefined?{project:value.project.trim()}:{}),...(value.jql!==undefined?{jql:value.jql.trim()}:{})};
  }
  if(source==='gitlab'){
    if(!exact(value,['connectionId','projectPath'],['status']))fail('INVALID_BINDING');let projectPath;try{projectPath=gitlabProjectPath(value.projectPath);}catch{fail('INVALID_BINDING');}
    const status=validateStatusMapping(value.status);if(status&&!Object.hasOwn(status,'labels'))fail('STATUS_MAPPING_REQUIRED');
    return {connectionId:value.connectionId,projectPath,...(status?{status}:{})};
  }
  if(!exact(value,['connectionId','owner','repo'],['status'])||!repoName(value.owner)||!repoName(value.repo))fail('INVALID_BINDING');
  return {connectionId:value.connectionId,owner:value.owner,repo:value.repo,...(value.status!==undefined?{status:validateStatusMapping(value.status)}:{})};
}
export function validateRepoBinding(value){
  if(!exact(value,['machine','repoRoot'],['jira','github','gitlab','mountedLocalPath'])||!machine(value.machine))fail('INVALID_BINDING');
  try{if(canonicalRepoPath(value.repoRoot)!==value.repoRoot||value.mountedLocalPath!==undefined&&canonicalRepoPath(value.mountedLocalPath)!==value.mountedLocalPath)fail('INVALID_BINDING');}catch{fail('INVALID_BINDING');}
  return {machine:value.machine,repoRoot:value.repoRoot,...(value.jira!==undefined?{jira:selection(value.jira,'jira')}:{}),...(value.github!==undefined?{github:selection(value.github,'github')}:{}),...(value.gitlab!==undefined?{gitlab:selection(value.gitlab,'gitlab')}:{}),...(value.mountedLocalPath!==undefined?{mountedLocalPath:value.mountedLocalPath}:{})};
}
function connectionHeader(value,source){
  json(value);if(!object(value)||!id(value.id)||!text(value.kind,80))fail('INVALID_SCOPE');const site=trackerOrigin(value.site);
  if(source==='jira'&&!['api','cli','mcp-stdio','mcp-http'].includes(value.kind))fail('INVALID_SCOPE');
  if(['cli','mcp-stdio'].includes(value.kind)&&value.execution?.machine!==null)fail('UNSUPPORTED_INTEGRATION_HOST');
  return {...clone(value),site};
}
export function trackerScope(source,connection,binding){
  const kind=sourceKind(source),b=validateRepoBinding(binding),selected=b[kind],c=connectionHeader(connection,kind);
  if(!selected||selected.connectionId!==c.id)fail('INVALID_SCOPE');
  const fingerprint=stable(c);if(fingerprint.length>32000)fail('INVALID_SCOPE');
  return {v:1,source,machine:b.machine,repoRoot:b.repoRoot,connectionId:c.id,site:c.site,selection:clone(selected),fingerprint};
}
export function validateTrackerScope(value){
  if(!exact(value,['v','source','machine','repoRoot','connectionId','site','selection','fingerprint'])||value.v!==1||!trackerSources.includes(value.source)||!machine(value.machine)||!id(value.connectionId)||!text(value.fingerprint,32000))fail('INVALID_SCOPE');
  try{if(canonicalRepoPath(value.repoRoot)!==value.repoRoot||trackerOrigin(value.site)!==value.site)fail('INVALID_SCOPE');}catch{fail('INVALID_SCOPE');}
  const selected=selection(value.selection,sourceKind(value.source));if(selected.connectionId!==value.connectionId||stable(selected)!==stable(value.selection))fail('INVALID_SCOPE');return clone(value);
}
export const trackerScopeKey=scope=>stable(validateTrackerScope(scope));
function selectFromConfig(c,resolved,source='jira'){
  const kind=sourceKind(source);if(!resolved||resolved.state&&resolved.state!=='resolved')return null;const raw=resolveBinding(c,resolved);if(!raw)return null;
  const binding=validateRepoBinding(raw),selected=binding[kind];if(!selected)return null;
  const connection=Object.hasOwn(c.connections,selected.connectionId)?connectionHeader(c.connections[selected.connectionId],kind):null;if(!connection)fail('INVALID_SCOPE');
  return {binding,connection,scope:trackerScope(source,connection,binding)};
}
export function selectTracker(config,resolved,source='jira'){return selectFromConfig(validateConfig(config),resolved,source);}
export function allTrackerBindings(config,source='jira'){
  sourceKind(source);const c=validateConfig(config),result=[];
  for(const binding of Object.values(c.bindings)){const selected=selectFromConfig(c,{state:'resolved',machine:binding.machine,repoRoot:binding.repoRoot},source);if(selected)result.push(selected);}return result;
}

export function validateIssue(value,{scope}={}){
  if(!exact(value,['identity','key','title','url','body','statusGroup','statusName','repoBinding'],['priority','updatedAt']))fail('INVALID_ISSUE');
  const i=value.identity;if(!exact(i,['kind','connectionId','site','id'])||!['jira','github','gitlab'].includes(i.kind)||!id(i.connectionId)||!text(i.id,200)||!text(value.key,200)||!text(value.title,512)||!text(value.statusName,200)||!TRACKER_GROUPS.includes(value.statusGroup)||typeof value.body!=='string'||utf8Bytes(value.body)>64000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.body)||value.priority!==undefined&&!text(value.priority,128))fail('INVALID_ISSUE');
  let binding,site;try{binding=validateRepoBinding(value.repoBinding);site=trackerOrigin(i.site);}catch{fail('INVALID_ISSUE');}
  if(site!==i.site||binding[i.kind]?.connectionId!==i.connectionId||!text(value.url,4096))fail('INVALID_ISSUE');
  if(i.kind==='jira'){if(!/^[A-Za-z][A-Za-z0-9_]*-[1-9][0-9]*$/.test(value.key)||value.url!==site+'/browse/'+value.key)fail('INVALID_ISSUE');}
  else if(i.kind==='gitlab'){const number=value.key.match(/^GL-([1-9][0-9]*)$/);if(!/^[1-9][0-9]*$/.test(i.id)||!number||value.url!==site+'/'+binding.gitlab.projectPath+'/-/issues/'+number[1])fail('INVALID_ISSUE');}
  else{const prefix=site+'/'+binding.github.owner+'/'+binding.github.repo+'/issues/',parts=value.url.match(/^(https:\/\/[^/]+\/[^/]+\/[^/]+\/issues\/)([1-9][0-9]*)$/);if(!parts||parts[1].toLowerCase()!==prefix.toLowerCase())fail('INVALID_ISSUE');}
  if(value.updatedAt!==undefined&&!date(value.updatedAt))fail('INVALID_ISSUE');
  if(scope){const s=validateTrackerScope(scope);if(s.source!==i.kind||s.connectionId!==i.connectionId||s.site!==site||s.machine!==binding.machine||s.repoRoot!==binding.repoRoot||stable(s.selection)!==stable(binding[i.kind]))fail('INVALID_SNAPSHOT');}
  return {...clone(value),repoBinding:binding};
}
export function issueIdentityKey(issue){const i=issue.identity,b=issue.repoBinding;return stable([i.kind,i.connectionId,i.site,i.id,b.machine,b.repoRoot]);}
export function groupIssues(issues,{query='',status='all'}={}){
  if(!['all',...TRACKER_GROUPS].includes(status)||typeof query!=='string'||query.length>512)fail('INVALID_FILTER');const needle=query.trim().toLowerCase(),groups=Object.fromEntries(TRACKER_GROUPS.map(k=>[k,[]]));
  for(const issue of issues){if(!TRACKER_GROUPS.includes(issue.statusGroup))fail('INVALID_ISSUE');if(status!=='all'&&issue.statusGroup!==status)continue;if(needle&&!`${issue.key} ${issue.title} ${issue.statusName} ${issue.repoBinding.repoRoot} ${issue.repoBinding.machine||'This Mac'}`.toLowerCase().includes(needle))continue;groups[issue.statusGroup].push(issue);}return groups;
}
export function mappedStatus(value,groups){
  if(!text(value,200)||!exact(groups,TRACKER_GROUPS))fail('STATUS_MAPPING_REQUIRED');const all=TRACKER_GROUPS.flatMap(group=>list(groups[group]));if(new Set(all).size!==all.length)fail('STATUS_MAPPING_REQUIRED');const matches=TRACKER_GROUPS.filter(group=>groups[group].includes(value));if(matches.length!==1)fail('STATUS_MAPPING_REQUIRED');return matches[0];
}
export function validateSnapshot(value,expectedScope,{validateItem=validateIssue,itemKey=issueIdentityKey,now=Date.now()}={}){
  const scope=validateTrackerScope(expectedScope);
  if(!exact(value,['data','fetchedAt','scope','truncated'],['cursor','error'])||!Array.isArray(value.data)||value.data.length>1000||!date(value.fetchedAt)||value.fetchedAt<0||value.fetchedAt>now+5000||typeof value.truncated!=='boolean'||value.cursor!==undefined&&value.cursor!==null&&!text(value.cursor,8192)||trackerScopeKey(value.scope)!==trackerScopeKey(scope))fail('INVALID_SNAPSHOT');
  if(value.cursor&&!value.truncated)fail('INVALID_SNAPSHOT');
  if(value.error!==undefined&&(!exact(value.error,['code','message'],['retryAt'])||!text(value.error.code,80)||!text(value.error.message,512)||value.error.retryAt!==undefined&&(!date(value.error.retryAt)||value.error.retryAt<0)))fail('INVALID_SNAPSHOT');
  const seen=new Set(),data=value.data.map(item=>{const checked=validateItem(item,{scope}),key=itemKey(checked);if(seen.has(key))fail('INVALID_SNAPSHOT');seen.add(key);return checked;});
  const result={...clone(value),data,scope};if(utf8Bytes(JSON.stringify(result))>8*1024*1024)fail('INVALID_SNAPSHOT');return result;
}
/** Collection only; validation happens before UI rendering or aggregation. */
export function aggregateIssues(snapshots,{limit=1000}={}){
  if(!Number.isInteger(limit)||limit<1||limit>1000)fail('INVALID_SNAPSHOT');const seen=new Set(),data=[];let truncated=false;
  for(const snapshot of snapshots){truncated=truncated||snapshot.truncated;for(const issue of snapshot.data){const key=issueIdentityKey(issue);if(seen.has(key))continue;seen.add(key);if(data.length===limit){truncated=true;continue;}data.push(issue);}}
  return {data,truncated};
}

/** A selection generation prevents late source/account responses from publishing. */
export class ScopedTrackerCache{
  constructor({clock=()=>Date.now()}={}){this.clock=clock;this.epoch=0;this.scope=null;this.snapshot=null;this.pending=false;}
  select(scope){const next=validateTrackerScope(scope);if(!this.scope||trackerScopeKey(this.scope)!==trackerScopeKey(next)){this.scope=next;this.snapshot=null;this.pending=false;this.epoch++;}return this.scope;}
  begin(scope=this.scope){this.select(scope);if(this.pending)return null;this.pending=true;return {epoch:++this.epoch,scope:clone(this.scope)};}
  current(ticket){return Boolean(ticket&&this.pending&&ticket.epoch===this.epoch&&this.scope&&trackerScopeKey(ticket.scope)===trackerScopeKey(this.scope));}
  accept(ticket,snapshot,options={}){if(!this.current(ticket))return false;const checked=validateSnapshot(snapshot,this.scope,{now:this.clock(),...options});this.snapshot=checked;this.pending=false;return true;}
  fail(ticket,error){if(!this.current(ticket))return false;if(!exact(error,['code','message'],['retryAt'])||!text(error.code,80)||!text(error.message,512)||error.retryAt!==undefined&&(!date(error.retryAt)||error.retryAt<0))fail('INVALID_SNAPSHOT');this.pending=false;this.snapshot=this.snapshot?{...this.snapshot,error:clone(error)}:{data:[],fetchedAt:this.clock(),scope:clone(this.scope),truncated:false,error:clone(error)};return true;}
  clear(){this.epoch++;this.scope=null;this.snapshot=null;this.pending=false;}
  /** Herdr ends an overrunning continuation without catch/finally; release its orphaned ticket. */
  abandon(){if(!this.pending)return false;this.pending=false;this.epoch++;return true;}
}
/** Only the named repo binding changes. Reusing a profile never edits it implicitly. */
export async function saveRepoIntegration(io,{machine:on,repoRoot,source,connection,selection:selected}){
  if(!['jira','github','gitlab'].includes(source))fail('INVALID_BINDING');const c=connectionHeader(connection,source),binding=validateRepoBinding({machine:on,repoRoot,[source]:{...selected,connectionId:c.id}});
  return updateConfig(io,config=>{
    const old=config.connections[c.id];if(old&&stable(connectionHeader(old,source))!==stable(c))fail('CONNECTION_CONFLICT');
    config.connections[c.id]=c;const key=bindingKey(on,repoRoot);config.bindings[key]={...(config.bindings[key]||{machine:on,repoRoot}),[source]:binding[source]};
  });
}
