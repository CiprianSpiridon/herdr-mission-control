import https from 'node:https';
import {canonicalRepoPath,gitlabProjectPath,validateConfig} from './config.js';

const messages={
  INVALID_REQUEST:'The tracker request is invalid. Reload its repository settings.',
  INVALID_CONNECTION:'The integration profile is invalid. Check its adapter and credential references.',
  INVALID_SCOPE:'The tracker result or cursor belongs to a different repository or connection. Reload this scope.',
  CANONICAL_SITE_REQUIRED:'Use the canonical Jira API base URL from serverInfo.baseUrl, rather than a custom display URL. Check the selected site and cloud ID.',
  INCOMPLETE_RESULTS:'The tracker could not confirm a complete result set. Narrow the selected scope and refresh.',
  STATUS_MAPPING_REQUIRED:'Configure the source status mapping before using this board.',
  CLI_UNAVAILABLE:'The configured tracker CLI is not installed locally. Select an installed command or another adapter.',
  ADAPTER_FAILED:'The configured tracker program failed. Check its profile and read-only JSON bridge.',
  MCP_UNAVAILABLE:'The selected MCP server is unavailable. Check its transport and credential references, then reconnect.',
  MCP_TOOL_UNAVAILABLE:'The configured MCP search tool is missing or changed. Reconnect and select its current tool mapping.',
  MCP_TOOL_NOT_READ_ONLY:'Select a read-only MCP issue-search tool before loading this board.',
  ACCOUNT_SELECTION_UNSUPPORTED:'The installed CLI cannot select this account explicitly. Use a credential environment reference or a supported CLI version.',
  INVALID_URL:'Use an explicit HTTPS URL without embedded credentials or fragments.',
  UNSUPPORTED_INTEGRATION_HOST:'CLI and stdio MCP integrations must run locally. Use a local bridge or configured HTTPS MCP endpoint for a server.',
  AUTH_REQUIRED:'Tracker authentication is unavailable. Check the selected profile and its credential environment references.',
  PERMISSION_DENIED:'The selected account cannot read this tracker resource.',
  NOT_FOUND:'The selected tracker resource was not found.',
  RATE_LIMITED:'The tracker rate limit was reached. Retry after the reported delay.',
  UPSTREAM_UNAVAILABLE:'The tracker is temporarily unavailable. Retry this connection.',
  HTTP_ERROR:'The tracker rejected the read request. Check its connection settings.',
  UNTRUSTED_ORIGIN:'The tracker response tried to leave the configured HTTPS origin. Check the endpoint.',
  REQUEST_FAILED:'The tracker could not be reached. Check its HTTPS endpoint and retry.',
  REQUEST_TIMEOUT:'The tracker read timed out. Retry this connection.',
  REQUEST_CANCELLED:'This tracker read was cancelled.',
  RESPONSE_TOO_LARGE:'The tracker response exceeds the bounded page size. Narrow its project or query.',
  INVALID_RESPONSE:'The tracker did not return valid UTF-8 JSON.',
};
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const text=(v,max=8192)=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v);
const exact=(value,required,optional=[])=>object(value)&&required.every(k=>Object.hasOwn(value,k))&&Object.keys(value).every(k=>required.includes(k)||optional.includes(k));
const id=v=>text(v,96)&&/^[a-z][a-z0-9-]*$/.test(v)&&!['constructor','prototype'].includes(v);
const envName=v=>typeof v==='string'&&/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(v);
const strings=(v,max=96)=>Array.isArray(v)&&v.length<=max&&v.every(s=>typeof s==='string'&&s.length<=8192&&!s.includes('\0'));
const clone=v=>JSON.parse(JSON.stringify(v));

export class TrackerError extends Error{
  constructor(code,details={}){
    const safe=Object.hasOwn(messages,code)?code:'REQUEST_FAILED';super(messages[safe]);this.name='TrackerError';this.code=safe;
    if(Number.isInteger(details.status)&&details.status>=100&&details.status<=599)this.status=details.status;
    if(Number.isFinite(details.retryAfterMs)&&details.retryAfterMs>=0)this.retryAfterMs=Math.min(details.retryAfterMs,86400000);
  }
}
const fail=code=>{throw new TrackerError(code);};
/** No upstream message, response body, command stderr, stack or credential is reflected. */
export function publicTrackerError(error){
  const e=error instanceof TrackerError?error:new TrackerError('REQUEST_FAILED');
  return {code:e.code,message:messages[e.code]||messages.REQUEST_FAILED,...(e.status!==undefined?{status:e.status}:{}),...(e.retryAfterMs!==undefined?{retryAfterMs:e.retryAfterMs}:{})};
}
function jsonData(value,code){try{validateConfig({v:1,preferences:{tracker:value}});}catch{fail(code);}}
export function httpsUrl(value,{originOnly=false}={}){
  if(!text(value,8192))fail('INVALID_URL');let url;try{url=new URL(value);}catch{fail('INVALID_URL');}
  if(url.protocol!=='https:'||!url.hostname||url.username||url.password||url.hash||originOnly&&(url.pathname!=='/'||url.search))fail('INVALID_URL');
  return url;
}
const origin=value=>httpsUrl(value,{originOnly:true}).origin;
function auth(value,{optional=false,basic=true}={}){
  if(value===undefined&&optional)return;
  if(!object(value)||!['bearer',...(basic?['basic']:[])].includes(value.kind)||!exact(value,value.kind==='basic'?['kind','usernameEnv','tokenEnv']:['kind','tokenEnv'])||!envName(value.tokenEnv)||value.kind==='basic'&&!envName(value.usernameEnv))fail('INVALID_CONNECTION');
}
function execution(value,{stdio=false}={}){
  if(!exact(value,['machine','command',stdio?'args':'argsTemplate'],stdio?['envRefs']:[])||value.machine!==null){if(value?.machine!==undefined&&value.machine!==null)fail('UNSUPPORTED_INTEGRATION_HOST');fail('INVALID_CONNECTION');}
  if(!text(value.command,4096)||!strings(value[stdio?'args':'argsTemplate']))fail('INVALID_CONNECTION');
  if(stdio&&(!object(value.envRefs)||Object.entries(value.envRefs).some(([key,ref])=>!envName(key)||!envName(ref))))fail('INVALID_CONNECTION');
}
function mapping(value){
  if(!exact(value,['issuesPath','fields','statusGroups'],['nextCursorPath'])||typeof value.issuesPath!=='string'||value.issuesPath.length>512||value.nextCursorPath!==undefined&&(typeof value.nextCursorPath!=='string'||value.nextCursorPath.length>512)||!object(value.fields)||!Object.keys(value.fields).length||Object.values(value.fields).some(v=>typeof v!=='string'||v.length>512)||!exact(value.statusGroups,['todo','inProgress','done'])||Object.values(value.statusGroups).some(v=>!strings(v,100)))fail('INVALID_CONNECTION');
}
function search(value){if(!exact(value,['tool','argsTemplate','resultMapping'])||!text(value.tool,128)||!object(value.argsTemplate))fail('INVALID_CONNECTION');mapping(value.resultMapping);}

/** The pinned JiraConnection v1 union; GitHub supplies its own validator. */
export function validateJiraConnection(input){
  jsonData(input,'INVALID_CONNECTION');if(!id(input?.id))fail('INVALID_CONNECTION');const c=clone(input);c.site=origin(c.site);
  switch(c.kind){
    case 'api':if(!exact(c,['id','kind','site','auth'],['cloudId'])||c.cloudId!==undefined&&!(typeof c.cloudId==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(c.cloudId)))fail('INVALID_CONNECTION');auth(c.auth);break;
    case 'cli':if(!exact(c,['id','kind','site','execution','mapping']))fail('INVALID_CONNECTION');execution(c.execution);mapping(c.mapping);break;
    case 'mcp-stdio':if(!exact(c,['id','kind','site','execution','search']))fail('INVALID_CONNECTION');execution(c.execution,{stdio:true});search(c.search);break;
    case 'mcp-http':{
      if(!exact(c,['id','kind','site','url','search'],['auth']))fail('INVALID_CONNECTION');const endpoint=httpsUrl(c.url);
      if([...endpoint.searchParams.keys()].some(key=>/^(?:access[-_]?token|api[-_]?(?:key|token)|token|auth|authorization|password|secret|x-api-key)$/i.test(key)))fail('INVALID_CONNECTION');
      c.url=endpoint.href;auth(c.auth,{optional:true});search(c.search);break;
    }
    default:fail('INVALID_CONNECTION');
  }
  return c;
}
export function validateTrackerRequest(input,{connectionValidator=validateJiraConnection,source='jira'}={}){
  const operations={jira:['issues','probe'],github:['issues','pulls','probe'],gitlab:['issues','merges','probe']};
  jsonData(input,'INVALID_REQUEST');if(!exact(input,['v','operation','connection','binding'],['cursor'])||input.v!==1||!Object.hasOwn(operations,source)||!operations[source].includes(input.operation)||Buffer.byteLength(JSON.stringify(input))>65536||input.cursor!==undefined&&input.cursor!==null&&!text(input.cursor,8192))fail('INVALID_REQUEST');
  const connection=connectionValidator(input.connection),binding=clone(input.binding);
  if(!object(binding)||!Object.hasOwn(binding,'machine')||!(binding.machine===null||text(binding.machine,128)))fail('INVALID_REQUEST');
  try{if(canonicalRepoPath(binding.repoRoot)!==binding.repoRoot)fail('INVALID_REQUEST');}catch{fail('INVALID_REQUEST');}
  const selected=binding[source];
  if(selected!==undefined&&(selected?.connectionId!==connection.id||source==='jira'&&(!text(selected.project,256)&&!text(selected.jql,8192))||source==='github'&&(!text(selected.owner,128)||!text(selected.repo,128))))fail('INVALID_REQUEST');
  if(source==='gitlab'&&selected!==undefined){try{gitlabProjectPath(selected.projectPath);}catch{fail('INVALID_REQUEST');}}
  if(input.operation!=='probe'&&!selected)fail('INVALID_REQUEST');
  return {...clone(input),connection,binding};
}
function credential(env,ref){const value=env[ref];if(!text(value,16384))fail('AUTH_REQUIRED');return value;}
/** Shared API/MCP resolver. Call only for defined auth; values never enter argv/state. */
export function credentialHeaders(spec,env=process.env){
  jsonData(spec,'INVALID_CONNECTION');auth(spec);const token=credential(env,spec.tokenEnv);
  if(spec.kind==='bearer')return {authorization:'Bearer '+token};
  const username=credential(env,spec.usernameEnv);if(username.includes(':'))fail('AUTH_REQUIRED');return {authorization:'Basic '+Buffer.from(username+':'+token,'utf8').toString('base64')};
}
export function apiHeaders(connection,env=process.env){const c=validateJiraConnection(connection);if(c.kind!=='api')fail('INVALID_CONNECTION');return credentialHeaders(c.auth,env);}
function retryAfter(value,now){if(typeof value!=='string')return undefined;const seconds=/^\d+$/.test(value)?Number(value):NaN,date=Number.isFinite(seconds)?now+seconds*1000:Date.parse(value);return Number.isFinite(date)?Math.min(86400000,Math.max(0,date-now)):undefined;}
function httpError(status,headers){const limited=status===429||status===403&&headers['x-ratelimit-remaining']==='0',now=Date.now(),retry=retryAfter(headers['retry-after'],now),reset=limited&&/^\d+$/.test(headers['x-ratelimit-reset']||'')?Math.min(86400000,Math.max(0,Number(headers['x-ratelimit-reset'])*1000-now)):undefined;return new TrackerError(limited?'RATE_LIMITED':status===401?'AUTH_REQUIRED':status===403?'PERMISSION_DENIED':status===404?'NOT_FOUND':status>=500?'UPSTREAM_UNAVAILABLE':'HTTP_ERROR',{status,retryAfterMs:retry??reset});}

/** Bounded HTTPS transport for trusted read adapters; redirects retain one origin. */
export async function requestJson(input,{allowedOrigin,headers={},method='GET',body,timeoutMs=12000,maxBytes=1048576,ca,signal,metadata=false,maxRedirects=3}={}){
  const expected=origin(allowedOrigin);let url=httpsUrl(input);
  if(!object(headers)||!['GET','POST'].includes(method)||method==='GET'&&body!==undefined||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000||!Number.isInteger(maxBytes)||maxBytes<1||maxBytes>4194304||typeof metadata!=='boolean'||!Number.isInteger(maxRedirects)||maxRedirects<0||maxRedirects>3)fail('INVALID_REQUEST');
  const requestHeaders={accept:'application/json','accept-encoding':'identity','user-agent':'herdr-mission-control/0.1'};
  for(const[key,value]of Object.entries(headers)){const name=key.toLowerCase();if(!['authorization','accept','content-type','x-github-api-version','user-agent'].includes(name)||!text(value,32768))fail('INVALID_REQUEST');requestHeaders[name]=value;}
  let payload;if(body!==undefined){try{payload=Buffer.from(JSON.stringify(body),'utf8');}catch{fail('INVALID_REQUEST');}if(payload.length>65536)fail('INVALID_REQUEST');requestHeaders['content-type']='application/json';requestHeaders['content-length']=String(payload.length);}
  const deadline=Date.now()+timeoutMs;
  for(let redirects=0;redirects<=maxRedirects;redirects++){
    if(url.origin!==expected)fail('UNTRUSTED_ORIGIN');if(signal?.aborted)fail('REQUEST_CANCELLED');const remaining=deadline-Date.now();if(remaining<=0)fail('REQUEST_TIMEOUT');
    const result=await new Promise((resolve,reject)=>{
      let settled=false,request;const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);error?reject(error):resolve(value);};
      const cancel=()=>{finish(new TrackerError('REQUEST_CANCELLED'));request?.destroy();};
      const timer=setTimeout(()=>{finish(new TrackerError('REQUEST_TIMEOUT'));request?.destroy();},remaining);
      try{request=https.request(url,{method,headers:requestHeaders,ca,rejectUnauthorized:true},response=>{
        const status=response.statusCode||0;
        if([301,302,303,307,308].includes(status)){const location=response.headers.location;response.destroy();finish(null,{redirect:location,status});return;}
        if(status<200||status>=300){const error=httpError(status,response.headers);response.destroy();finish(error);return;}
        if(Number(response.headers['content-length'])>maxBytes){response.destroy();finish(new TrackerError('RESPONSE_TOO_LARGE'));return;}
        const responseHeaders={};if(metadata)for(const name of ['link','x-ratelimit-limit','x-ratelimit-remaining','x-ratelimit-reset','x-ratelimit-resource','x-next-page']){const value=response.headers[name];if(value!==undefined){if(!(name==='x-next-page'&&value==='')&&!text(value,name==='link'?8192:128)){response.destroy();finish(new TrackerError('RESPONSE_TOO_LARGE'));return;}responseHeaders[name]=value;}}
        let length=0;const chunks=[];response.on('data',chunk=>{if(settled)return;length+=chunk.length;if(length>maxBytes){response.destroy();finish(new TrackerError('RESPONSE_TOO_LARGE'));}else chunks.push(chunk);});
        response.on('error',()=>finish(new TrackerError('REQUEST_FAILED')));response.on('end',()=>{if(settled)return;try{const data=status===204?null:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));finish(null,{value:metadata?{data,status,headers:responseHeaders,url:url.href}:data});}catch{finish(new TrackerError('INVALID_RESPONSE'));}});
      });request.on('error',()=>finish(new TrackerError('REQUEST_FAILED')));signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted){cancel();return;}request.end(payload);
      }catch{finish(new TrackerError('REQUEST_FAILED'));}
    });
    if(!Object.hasOwn(result,'redirect'))return result.value;
    if(redirects===maxRedirects||typeof result.redirect!=='string'||method==='POST'&&![307,308].includes(result.status))fail('UNTRUSTED_ORIGIN');
    try{url=httpsUrl(new URL(result.redirect,url).href);}catch{fail('UNTRUSTED_ORIGIN');}
  }
  fail('UNTRUSTED_ORIGIN');
}

const pageNumber=value=>typeof value==='string'&&/^[1-9][0-9]{0,5}$/.test(value)?Number(value):null;
function pageQuery(url,code){
  const query=new Map();
  for(const [key,value] of url.searchParams){if(query.has(key))fail(code);query.set(key,value);}
  if(query.has('page')&&pageNumber(query.get('page'))===null)fail(code);
  return query;
}
/** Parse the bounded RFC Link syntax; quoted commas and URI commas are not separators. */
function pageLinks(header,original,query){
  if(!text(header,8192))fail('INVALID_RESPONSE');
  const entry=/<([^<>\s]+)>((?:\s*;\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+\s*=\s*(?:"(?:[^"\\\r\n]|\\[\x20-\x7e])*"|[!#$%&'*+.^_`|~0-9A-Za-z-]+))*)\s*(,|$)/y;
  const parameter=/\s*;\s*([!#$%&'*+.^_`|~0-9A-Za-z-]+)\s*=\s*("(?:[^"\\\r\n]|\\[\x20-\x7e])*"|[!#$%&'*+.^_`|~0-9A-Za-z-]+)/gy;
  let position=0,count=0,next=null,hasNext=false;
  while(position<header.length){
    while(header[position]===' '||header[position]==='\t')position++;
    entry.lastIndex=position;const match=entry.exec(header);
    if(!match||++count>32)fail('INVALID_RESPONSE');
    position=entry.lastIndex;if(match[3]===','&&position===header.length)fail('INVALID_RESPONSE');
    const params=new Map();parameter.lastIndex=0;let param;
    while((param=parameter.exec(match[2]))){
      const name=param[1].toLowerCase(),value=param[2].startsWith('"')?param[2].slice(1,-1).replace(/\\([\x20-\x7e])/g,'$1'):param[2];
      if(params.has(name)||name==='anchor')fail('INVALID_RESPONSE');params.set(name,value);
    }
    const relations=params.get('rel')?.toLowerCase().split(/\s+/);
    if(!relations?.length||new Set(relations).size!==relations.length||relations.some(rel=>!['next','prev','first','last'].includes(rel)))fail('INVALID_RESPONSE');
    let target;try{target=httpsUrl(new URL(match[1],original).href);}catch{fail('INVALID_RESPONSE');}
    if(target.origin!==original.origin||target.pathname!==original.pathname)fail('INVALID_RESPONSE');
    const candidate=pageQuery(target,'INVALID_RESPONSE');
    if(!candidate.has('page')||candidate.size!==query.size+(query.has('page')?0:1))fail('INVALID_RESPONSE');
    for(const [key,value]of query)if(key!=='page'&&candidate.get(key)!==value)fail('INVALID_RESPONSE');
    const page=pageNumber(candidate.get('page'));
    if(relations.includes('next')){
      if(hasNext||page<=(pageNumber(query.get('page'))??1))fail('INVALID_RESPONSE');hasNext=true;next=page;
    }
  }
  if(!count)fail('INVALID_RESPONSE');return next;
}

/** GitLab page numbers only: links are validated, never followed or returned. */
export async function requestJsonPage(input,{requirePageHeader=false,...options}={}){
  if(typeof requirePageHeader!=='boolean'||requirePageHeader&&options.method!==undefined&&options.method!=='GET')fail('INVALID_REQUEST');
  const original=httpsUrl(input),query=pageQuery(original,'INVALID_REQUEST'),current=pageNumber(query.get('page'))??1;
  const result=await requestJson(original.href,{...options,metadata:true,maxRedirects:0});
  if(requirePageHeader&&(!Array.isArray(result.data)||result.data.length>50))fail('INVALID_RESPONSE');
  const hasPage=Object.hasOwn(result.headers,'x-next-page'),hasLink=Object.hasOwn(result.headers,'link');
  let nextPage=null;
  if(hasPage){
    const value=result.headers['x-next-page'];nextPage=value===''?null:pageNumber(value);
    if(value!==''&&(nextPage===null||nextPage<=current))fail('INVALID_RESPONSE');
  }
  if(hasLink){const linked=pageLinks(result.headers.link,original,query);if(hasPage&&linked!==nextPage)fail('INVALID_RESPONSE');nextPage=linked;}
  if(!hasPage&&!hasLink&&requirePageHeader&&result.data.length>=50)fail('INCOMPLETE_RESULTS');
  return {value:result.data,nextPage};
}
