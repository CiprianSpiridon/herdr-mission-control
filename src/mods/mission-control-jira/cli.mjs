import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {TrackerError,validateTrackerRequest,validateJiraConnection} from '../../shared/tracker-transport.mjs';
import {trackerScope,trackerScopeKey,validateIssue,validateSnapshot,mappedStatus,issueIdentityKey} from '../../shared/tracker-model.js';

const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const text=(v,max=4096)=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v);
const hash=v=>createHash('sha256').update(v).digest('base64url');
const fail=code=>{throw new TrackerError(code);};
const RESERVED=new Set(['__proto__','constructor','prototype']);
const FIELDS=new Set(['id','key','title','status','statusName','body','url','priority','updatedAt']);

function parts(value){if(typeof value!=='string'||value.length>512||value.split('.').some(p=>!p||!/^[-\w]+$/.test(p)||RESERVED.has(p)))fail('INVALID_CONNECTION');return value.split('.');}
function get(value,key){if(key==='')return value;let result=value;for(const part of parts(key)){if(result===null||typeof result!=='object'||!Object.hasOwn(result,part))return undefined;result=result[part];}return result;}
function mapping(value){
  if(value.issuesPath!=='')parts(value.issuesPath);if(value.nextCursorPath!==undefined)parts(value.nextCursorPath);
  if(['id','key','title','status'].some(k=>!Object.hasOwn(value.fields,k))||Object.keys(value.fields).some(k=>!FIELDS.has(k)))fail('INVALID_CONNECTION');
  for(const p of Object.values(value.fields))parts(p);
  const values=Object.values(value.statusGroups).flat();if(values.some(v=>!text(v,200))||new Set(values).size!==values.length)fail('STATUS_MAPPING_REQUIRED');
}
function validateCli(connection){const c=validateJiraConnection(connection);if(c.kind!=='cli')fail('INVALID_CONNECTION');mapping(c.mapping);return c;}

/** Executable lookup never reads an agent's config or changes a CLI login. */
export async function resolveJiraCli(connection,env=process.env){
  const c=validateCli(connection),command=c.execution.command;
  const base=path.basename(command).toLowerCase().replace(/\.exe$/,'');
  if(['sh','bash','zsh','dash','fish','ksh','csh','tcsh','cmd','powershell','pwsh'].includes(base))fail('INVALID_CONNECTION');
  if(/^(?:node(?:js)?|python(?:\d+(?:\.\d+)*)?|perl|ruby|deno|bun)$/.test(base)&&c.execution.argsTemplate.some(v=>['-c','-e','--eval','--print','-p'].includes(v)))fail('INVALID_CONNECTION');
  if(command.includes(path.sep)&&!path.isAbsolute(command))fail('INVALID_CONNECTION');
  const candidates=path.isAbsolute(command)?[command]:(env.PATH||'').split(path.delimiter).filter(p=>path.isAbsolute(p)).map(p=>path.join(p,command));
  for(const file of candidates){try{await fs.access(file,constants.X_OK);if((await fs.stat(file)).isFile())return file;}catch{}}
  fail('CLI_UNAVAILABLE');
}

/** Placeholders occupy whole argv slots; fetched strings never become shell or eval code. */
export function jiraCliArgs(input,providerCursor=null){
  const c=validateCli(input.connection),values={site:c.site,project:input.binding.jira?.project,jql:input.binding.jira?.jql,connectionId:c.id,pageSize:'50',binding:JSON.stringify(input.binding),request:JSON.stringify({...input,cursor:providerCursor}),cursor:providerCursor||''};
  const args=c.execution.argsTemplate.map(arg=>{
    if(!arg.includes('{{')&&!arg.includes('}}'))return arg;
    const match=arg.match(/^\{\{([A-Za-z]+)\}\}$/);if(!match||!Object.hasOwn(values,match[1])||typeof values[match[1]]!=='string')fail('INVALID_CONNECTION');return values[match[1]];
  });
  if(!c.execution.argsTemplate.some(arg=>/^\{\{(?:project|jql|binding|request)\}\}$/.test(arg))||args.reduce((n,v)=>n+Buffer.byteLength(v),0)>65536)fail('INVALID_CONNECTION');return args;
}

function execute(command,args,{env,timeoutMs,signal,maxBytes=4194304}){
  if(signal?.aborted)return Promise.reject(new TrackerError('REQUEST_CANCELLED'));
  return new Promise((resolve,reject)=>{
    let child,done=false,stdout=[],size=0,stderrBytes=0,timer;
    const kill=()=>{if(!child?.pid)return;try{if(process.platform==='win32')child.kill('SIGKILL');else process.kill(-child.pid,'SIGKILL');}catch{}};
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);if(error)kill();child?.stdout?.destroy();child?.stderr?.destroy();error?reject(error):resolve(value);};
    const cancel=()=>finish(new TrackerError('REQUEST_CANCELLED'));
    timer=setTimeout(()=>finish(new TrackerError('REQUEST_TIMEOUT')),timeoutMs);signal?.addEventListener('abort',cancel,{once:true});
    try{child=spawn(command,args,{shell:false,env,windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});}catch{finish(new TrackerError('CLI_UNAVAILABLE'));return;}
    child.on('error',()=>finish(new TrackerError('CLI_UNAVAILABLE')));
    child.stdout.on('data',chunk=>{size+=chunk.length;if(size>maxBytes)finish(new TrackerError('RESPONSE_TOO_LARGE'));else stdout.push(chunk);});
    child.stderr.on('data',chunk=>{stderrBytes+=chunk.length;if(stderrBytes>65536)finish(new TrackerError('RESPONSE_TOO_LARGE'));});
    child.on('close',code=>{if(done)return;if(code!==0){finish(new TrackerError('ADAPTER_FAILED'));return;}try{const decoded=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(stdout));finish(null,JSON.parse(decoded));}catch{finish(new TrackerError('INVALID_RESPONSE'));}});
  });
}

function normalize(value,c,b,scope){
  if(!object(value))fail('INVALID_RESPONSE');const fields=Object.fromEntries(Object.entries(c.mapping.fields).map(([key,p])=>[key,get(value,p)]));
  const scalar=v=>typeof v==='string'?v:Number.isSafeInteger(v)?String(v):null;
  let group;try{group=mappedStatus(fields.status,c.mapping.statusGroups);}catch{fail('STATUS_MAPPING_REQUIRED');}
  const row={identity:{kind:'jira',connectionId:c.id,site:c.site,id:scalar(fields.id)},key:fields.key,title:fields.title,url:c.site+'/browse/'+fields.key,body:fields.body??'',statusGroup:group,statusName:fields.statusName??fields.status,repoBinding:b};
  if(fields.url!==undefined&&fields.url!==row.url)fail('INVALID_RESPONSE');
  if(fields.priority!==undefined&&fields.priority!==null)row.priority=fields.priority;
  if(fields.updatedAt!==undefined&&fields.updatedAt!==null){row.updatedAt=typeof fields.updatedAt==='string'?Date.parse(fields.updatedAt):fields.updatedAt;if(!Number.isFinite(row.updatedAt)||row.updatedAt<0)fail('INVALID_RESPONSE');}
  try{return validateIssue(row,{scope});}catch{fail('INVALID_RESPONSE');}
}
function decode(value,scope,now){
  if(!value)return null;let c;try{if(!/^[-\w]+$/.test(value))fail('INVALID_SCOPE');c=JSON.parse(Buffer.from(value,'base64url').toString('utf8'));}catch{fail('INVALID_SCOPE');}
  if(!object(c)||Object.keys(c).sort().join(',')!=='count,issuedAt,scope,seen,token,v'||c.v!==1||c.scope!==hash(trackerScopeKey(scope))||!text(c.token)||!Number.isInteger(c.count)||c.count<0||c.count>=1000||!Number.isFinite(c.issuedAt)||c.issuedAt>now+5000||now-c.issuedAt>=7*86400000||!Array.isArray(c.seen)||c.seen.length>100||c.seen.some(s=>!/^[-\w]{43}$/.test(s))||new Set(c.seen).size!==c.seen.length||c.seen.includes(hash(c.token)))fail('INVALID_SCOPE');return c;
}

export async function probeJiraCli(input,{env=process.env}={}){const r=validateTrackerRequest(input);if(r.operation!=='probe')fail('INVALID_REQUEST');const c=validateCli(r.connection);if(r.binding.jira)jiraCliArgs(r);await resolveJiraCli(c,env);return {site:c.site,route:'local-cli'};}

export async function fetchJiraCli(input,{env=process.env,signal,timeoutMs=18000,maxPages=4,clock=()=>Date.now()}={}){
  const r=validateTrackerRequest(input);if(r.operation!=='issues')fail('INVALID_REQUEST');const c=validateCli(r.connection),scope=trackerScope('jira',c,r.binding),now=clock(),previous=decode(r.cursor,scope,now);
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>25000||!Number.isInteger(maxPages)||maxPages<1||maxPages>20)fail('INVALID_REQUEST');
  const deadline=Date.now()+timeoutMs,command=await resolveJiraCli(c,env),seen=new Set(previous?.seen||[]),ids=new Set(),data=[];
  let token=previous?.token,count=previous?.count||0,bytes=0,truncated=false,cursor,error;
  for(let page=0;page<maxPages;page++){
    if(token){if(seen.has(hash(token)))fail('INVALID_SCOPE');seen.add(hash(token));}
    const remaining=deadline-Date.now();if(remaining<=0)fail('REQUEST_TIMEOUT');const args=jiraCliArgs({...r,connection:c},token),payload=await execute(command,args,{env,signal,timeoutMs:remaining}),items=get(payload,c.mapping.issuesPath);
    if(!Array.isArray(items))fail('INVALID_RESPONSE');if(items.length>50)fail('RESPONSE_TOO_LARGE');
    const next=c.mapping.nextCursorPath===undefined?null:get(payload,c.mapping.nextCursorPath);
    if(c.mapping.nextCursorPath!==undefined&&next===undefined)fail('INVALID_RESPONSE');
    if(next!==null&&next!==undefined&&!text(next))fail('INVALID_RESPONSE');if(next&&(seen.has(hash(next))||next===token))fail('INVALID_SCOPE');
    for(const value of items){if(count>=1000){truncated=true;break;}count++;const item=normalize(value,c,r.binding,scope),id=issueIdentityKey(item);if(ids.has(id))continue;const size=Buffer.byteLength(JSON.stringify(item));if(bytes+size>7*1024*1024){truncated=true;error={code:'RESPONSE_TOO_LARGE',message:new TrackerError('RESPONSE_TOO_LARGE').message};break;}ids.add(id);data.push(item);bytes+=size;}
    if(error||truncated)break;if(!next)break;
    truncated=true;if(count>=1000||seen.size>=100)break;
    token=next;
    if(page===maxPages-1){const encoded=Buffer.from(JSON.stringify({v:1,scope:hash(trackerScopeKey(scope)),token,count,seen:[...seen],issuedAt:previous?.issuedAt??now})).toString('base64url');if(encoded.length<=8192)cursor=encoded;else error={code:'RESPONSE_TOO_LARGE',message:new TrackerError('RESPONSE_TOO_LARGE').message};}
    else truncated=false;
  }
  return validateSnapshot({data,fetchedAt:clock(),scope,truncated,...(cursor?{cursor}:{}),...(error?{error}:{})},scope,{now:clock()});
}
