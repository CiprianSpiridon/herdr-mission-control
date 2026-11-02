import {createHash} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport,getDefaultEnvironment} from '@modelcontextprotocol/sdk/client/stdio.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {AjvJsonSchemaValidator} from '@modelcontextprotocol/sdk/validation/ajv';
import {McpError,ErrorCode} from '@modelcontextprotocol/sdk/types.js';
import {TrackerError,validateTrackerRequest,validateJiraConnection,credentialHeaders,httpsUrl} from '../../shared/tracker-transport.mjs';
import {trackerScope,trackerScopeKey,validateIssue,validateSnapshot,mappedStatus,issueIdentityKey} from '../../shared/tracker-model.js';

const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const text=(v,max=4096)=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v);
const hash=v=>createHash('sha256').update(v).digest('base64url');
const fail=code=>{throw new TrackerError(code);};
const RESERVED=new Set(['__proto__','prototype','constructor']);
function pathParts(value){if(typeof value!=='string'||value.length>512||value.split('.').some(p=>!p||!/^[-\w]+$/.test(p)||RESERVED.has(p)))fail('INVALID_CONNECTION');return value.split('.');}
function at(value,path){if(path==='')return value;let result=value;for(const p of pathParts(path)){if(result===null||typeof result!=='object'||!Object.hasOwn(result,p))return undefined;result=result[p];}return result;}
function validateMcp(value){
  const c=validateJiraConnection(value);if(!['mcp-http','mcp-stdio'].includes(c.kind))fail('INVALID_CONNECTION');const m=c.search.resultMapping;
  if(m.issuesPath!=='')pathParts(m.issuesPath);if(m.nextCursorPath!==undefined)pathParts(m.nextCursorPath);
  const fields=['id','key','title','status','statusName','body','url','priority','updatedAt'];
  if(['id','key','title','status'].some(k=>!Object.hasOwn(m.fields,k))||Object.keys(m.fields).some(k=>!fields.includes(k)))fail('INVALID_CONNECTION');for(const p of Object.values(m.fields))pathParts(p);
  const all=Object.values(m.statusGroups).flat();if(all.some(v=>!text(v,200))||new Set(all).size!==all.length)fail('STATUS_MAPPING_REQUIRED');return c;
}

/** Every HTTP exchange, including optional SSE, stays on the selected MCP endpoint. */
export function mcpFetch(endpoint,{fetchImpl=globalThis.fetch,signal,onFailure=()=>{}}={}){
  const origin=httpsUrl(endpoint).origin;
  return async(input,init={})=>{
    try{
      const url=httpsUrl(String(input));if(url.origin!==origin)fail('UNTRUSTED_ORIGIN');
      const response=await fetchImpl(url.href,{...init,redirect:'manual',credentials:'omit',signal:signal&&init.signal?AbortSignal.any([signal,init.signal]):signal||init.signal});
      if(response.status>=300&&response.status<400){await response.body?.cancel();fail('UNTRUSTED_ORIGIN');}
      if([401,403,429].includes(response.status)||response.status>=500){const retry=response.headers.get('retry-after');await response.body?.cancel();throw new TrackerError(response.status===401?'AUTH_REQUIRED':response.status===403?'PERMISSION_DENIED':response.status===429?'RATE_LIMITED':'MCP_UNAVAILABLE',{status:response.status,...(/^\d+$/.test(retry||'')?{retryAfterMs:Math.min(Number(retry)*1000,86400000)}:{})});}
      const declared=Number(response.headers.get('content-length'));if(Number.isFinite(declared)&&declared>4194304){await response.body?.cancel();fail('RESPONSE_TOO_LARGE');}
      if(!response.body)return response;const reader=response.body.getReader();let bytes=0,cancelled=false;
      const body=new ReadableStream({async pull(controller){try{const item=await reader.read();if(cancelled)return;if(item.done){controller.close();return;}bytes+=item.value.byteLength;if(bytes>4194304){await reader.cancel();fail('RESPONSE_TOO_LARGE');}controller.enqueue(item.value);}catch(e){if(!cancelled){onFailure(e);controller.error(e);}}},cancel(reason){cancelled=true;return reader.cancel(reason);}});
      return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
    }catch(e){onFailure(e);throw e;}
  };
}

function toolArgs(template,r,token){
  const selection=r.binding.jira||{},project=selection.project,jql=selection.jql||(project?'project = "'+project.replaceAll('\\','\\\\').replaceAll('"','\\"')+'" ORDER BY updated DESC':undefined);
  const values={site:r.connection.site,project,jql,connectionId:r.connection.id,pageSize:50,cursor:token??undefined,binding:r.binding};let scoped=false;
  function visit(value,depth=0){
    if(depth>16)fail('INVALID_CONNECTION');
    if(typeof value==='string'&&(value.includes('{{')||value.includes('}}'))){const match=value.match(/^\{\{([A-Za-z]+)\}\}$/);if(!match||!Object.hasOwn(values,match[1]))fail('INVALID_CONNECTION');if(['project','jql','binding'].includes(match[1]))scoped=true;if(values[match[1]]===undefined&&match[1]!=='cursor')fail('INVALID_CONNECTION');return values[match[1]];}
    if(Array.isArray(value))return value.map(v=>{const out=visit(v,depth+1);if(out===undefined)fail('INVALID_CONNECTION');return out;});
    if(object(value))return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,visit(v,depth+1)]).filter(([,v])=>v!==undefined));return value;
  }
  const result=visit(template);if(!scoped||Buffer.byteLength(JSON.stringify(result))>65536)fail('INVALID_CONNECTION');return result;
}

/** MCP tool text may contain ADF; keep only bounded plain task data. */
function bodyText(value){
  if(value===undefined||value===null)return '';let result='',bytes=0,nodes=0,truncated=false;
  const append=s=>{for(const ch of s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'))){const n=Buffer.byteLength(ch);if(bytes+n>48000){truncated=true;break;}result+=ch;bytes+=n;}};
  if(typeof value==='string')append(value);
  else{
    if(!object(value)||value.type!=='doc'||value.version!==1||!Array.isArray(value.content))fail('INVALID_RESPONSE');
    const stack=[{node:value,depth:0}];while(stack.length&&!truncated){const e=stack.pop();if(e.suffix!==undefined){append(e.suffix);continue;}const n=e.node;if(++nodes>10000||e.depth>32)fail('RESPONSE_TOO_LARGE');if(!object(n)||!text(n.type,80)||n.content!==undefined&&!Array.isArray(n.content))fail('INVALID_RESPONSE');
      if(n.type==='text'){if(typeof n.text!=='string')fail('INVALID_RESPONSE');append(n.text);for(const m of n.marks||[]){if(m.type==='link'&&text(m.attrs?.href,4096)){let u;try{u=new URL(m.attrs.href);}catch{}if(u&&['https:','http:'].includes(u.protocol)&&!u.username&&!u.password&&u.href!==n.text)append(' ('+u.href+')');}}}
      else if(n.type==='hardBreak')append('\n');else if(n.type==='mention')append(typeof n.attrs?.text==='string'?n.attrs.text:'[mention]');else if(n.type==='emoji')append(typeof n.attrs?.text==='string'?n.attrs.text:'[emoji]');else if(!n.content?.length&&!['doc','paragraph'].includes(n.type))append('[Unsupported Jira content]');
      if(n.type==='listItem')append('- ');if(['paragraph','heading','listItem','codeBlock','tableRow','blockquote'].includes(n.type))stack.push({suffix:'\n'});for(let i=(n.content?.length||0)-1;i>=0;i--)stack.push({node:n.content[i],depth:e.depth+1});
    }
  }
  return result.trim()+(truncated?'\n[Jira description truncated; open the issue for the full text.]':'');
}
function normalize(value,c,b,scope){
  if(!object(value))fail('INVALID_RESPONSE');const f=Object.fromEntries(Object.entries(c.search.resultMapping.fields).map(([k,p])=>[k,at(value,p)]));let group;try{group=mappedStatus(f.status,c.search.resultMapping.statusGroups);}catch{fail('STATUS_MAPPING_REQUIRED');}
  const item={identity:{kind:'jira',connectionId:c.id,site:c.site,id:typeof f.id==='string'?f.id:Number.isSafeInteger(f.id)?String(f.id):null},key:f.key,title:f.title,url:c.site+'/browse/'+f.key,body:bodyText(f.body),statusGroup:group,statusName:f.statusName??f.status,repoBinding:b};
  if(f.url!==undefined&&f.url!==item.url)fail('INVALID_RESPONSE');if(f.priority!==undefined&&f.priority!==null)item.priority=f.priority;if(f.updatedAt!==undefined&&f.updatedAt!==null){item.updatedAt=typeof f.updatedAt==='string'?Date.parse(f.updatedAt):f.updatedAt;if(!Number.isFinite(item.updatedAt)||item.updatedAt<0)fail('INVALID_RESPONSE');}
  try{return validateIssue(item,{scope});}catch{fail('INVALID_RESPONSE');}
}
function cursorRead(value,scope,now){let c;if(!value)return null;try{if(!/^[-\w]+$/.test(value))fail('INVALID_SCOPE');c=JSON.parse(Buffer.from(value,'base64url').toString('utf8'));}catch{fail('INVALID_SCOPE');}
  if(!object(c)||Object.keys(c).sort().join(',')!=='count,issuedAt,scope,seen,token,v'||c.v!==1||c.scope!==hash(trackerScopeKey(scope))||!text(c.token)||!Number.isInteger(c.count)||c.count<0||c.count>=1000||!Number.isFinite(c.issuedAt)||c.issuedAt>now+5000||now-c.issuedAt>=7*86400000||!Array.isArray(c.seen)||c.seen.length>100||c.seen.some(v=>!/^[-\w]{43}$/.test(v))||new Set(c.seen).size!==c.seen.length||c.seen.includes(hash(c.token)))fail('INVALID_SCOPE');return c;
}

async function withServer(input,options,action){
  const c=validateMcp(input.connection),{env=process.env,signal,timeoutMs=18000,fetchImpl}=options;
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>25000)fail('INVALID_REQUEST');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(new TrackerError('REQUEST_TIMEOUT')),timeoutMs),cancel=()=>controller.abort(new TrackerError('REQUEST_CANCELLED'));if(signal?.aborted)cancel();else signal?.addEventListener('abort',cancel,{once:true});
  const deadline=Date.now()+timeoutMs;let failure,transport,client,closing=false;
  const remember=e=>{if(!closing&&!failure)failure=e instanceof TrackerError?e:new TrackerError('MCP_UNAVAILABLE');};
  try{
    if(controller.signal.aborted)throw controller.signal.reason;
    if(c.kind==='mcp-http'){
      transport=new StreamableHTTPClientTransport(new URL(c.url),{requestInit:{headers:c.auth?credentialHeaders(c.auth,env):{}},fetch:mcpFetch(c.url,{fetchImpl,signal:controller.signal,onFailure:remember}),redirectPolicy:'same-origin',reconnectionOptions:{maxRetries:0,initialReconnectionDelay:1000,maxReconnectionDelay:1000,reconnectionDelayGrowFactor:1}});
    }else{
      const selected={...getDefaultEnvironment()};for(const[key,ref]of Object.entries(c.execution.envRefs)){if(!text(env[ref],16384))fail('AUTH_REQUIRED');selected[key]=env[ref];}
      transport=new StdioClientTransport({command:c.execution.command,args:c.execution.args,env:selected,stderr:'pipe',maxBufferSize:4194304});let stderr=0;transport.stderr?.on('data',chunk=>{stderr+=chunk.length;if(stderr>65536){remember(new TrackerError('RESPONSE_TOO_LARGE'));controller.abort(failure);}});
    }
    transport.onerror=e=>{if(!closing){remember(e);controller.abort(failure);}};
    client=new Client({name:'herdr-mission-control-jira',version:'0.1.0'},{capabilities:{}});
    const cancelled=new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>reject(controller.signal.reason),{once:true}));
    const bounded=promise=>Promise.race([promise,cancelled]);
    await bounded(client.connect(transport,{signal:controller.signal,timeout:Math.max(1,deadline-Date.now())}));
    const tools=[],seen=new Set();let pageCursor;
    for(let page=0;page<10;page++){
      const list=await bounded(client.listTools(pageCursor?{cursor:pageCursor}:{},{signal:controller.signal,timeout:Math.max(1,deadline-Date.now())}));
      tools.push(...list.tools);if(tools.length>200)fail('RESPONSE_TOO_LARGE');if(!list.nextCursor)break;if(!text(list.nextCursor)||seen.has(list.nextCursor)||page===9)fail('MCP_TOOL_UNAVAILABLE');seen.add(list.nextCursor);pageCursor=list.nextCursor;
    }
    const chosen=tools.filter(t=>t.name===c.search.tool);if(chosen.length!==1)fail('MCP_TOOL_UNAVAILABLE');const tool=chosen[0];
    if(tool.annotations?.readOnlyHint!==true||tool.annotations?.destructiveHint===true)fail('MCP_TOOL_NOT_READ_ONLY');if(tool.execution?.taskSupport==='required')fail('MCP_TOOL_UNAVAILABLE');
    if(Buffer.byteLength(JSON.stringify(tool))>65536)fail('RESPONSE_TOO_LARGE');
    const validator=new AjvJsonSchemaValidator();let inputValidator,outputValidator;
    try{inputValidator=validator.getValidator(tool.inputSchema);if(tool.outputSchema)outputValidator=validator.getValidator(tool.outputSchema);}catch{fail('MCP_TOOL_UNAVAILABLE');}
    const validateArgs=args=>{if(!inputValidator(args).valid)fail('MCP_TOOL_UNAVAILABLE');};
    return await action({c,tool,validateArgs,call:async args=>{
      validateArgs(args);
      const result=await bounded(client.callTool({name:tool.name,arguments:args},undefined,{signal:controller.signal,timeout:Math.max(1,deadline-Date.now())}));
      if(result.isError)fail('ADAPTER_FAILED');if(outputValidator&&(!result.structuredContent||!outputValidator(result.structuredContent).valid))fail('INVALID_RESPONSE');
      if(Buffer.byteLength(JSON.stringify(result))>4194304)fail('RESPONSE_TOO_LARGE');if(result.structuredContent)return result.structuredContent;
      if(result.content?.length!==1||result.content[0].type!=='text')fail('INVALID_RESPONSE');try{return JSON.parse(result.content[0].text);}catch{fail('INVALID_RESPONSE');}
    }});
  }catch(e){if(controller.signal.aborted)throw controller.signal.reason;if(failure)throw failure;if(e instanceof TrackerError)throw e;if(e instanceof McpError&&e.code===ErrorCode.RequestTimeout)throw new TrackerError('REQUEST_TIMEOUT');throw new TrackerError('MCP_UNAVAILABLE');}
  finally{closing=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);try{if(client)await client.close();else if(transport)await transport.close();}catch{}}
}

export async function probeJiraMcp(input,options={}){const r=validateTrackerRequest(input);if(r.operation!=='probe')fail('INVALID_REQUEST');return withServer(r,options,async({c,validateArgs})=>{if(r.binding.jira)validateArgs(toolArgs(c.search.argsTemplate,r));return {site:c.site,route:c.kind,tool:c.search.tool};});}

export async function fetchJiraMcp(input,options={}){
  const r=validateTrackerRequest(input);if(r.operation!=='issues')fail('INVALID_REQUEST');const c=validateMcp(r.connection),scope=trackerScope('jira',c,r.binding),clock=options.clock||(()=>Date.now()),now=clock(),previous=cursorRead(r.cursor,scope,now),maxPages=options.maxPages??4;
  if(!Number.isInteger(maxPages)||maxPages<1||maxPages>20)fail('INVALID_REQUEST');
  return withServer(r,options,async({call})=>{
    const seen=new Set(previous?.seen||[]),ids=new Set(),data=[];let token=previous?.token,count=previous?.count||0,bytes=0,truncated=false,cursor,error;
    for(let page=0;page<maxPages;page++){
      if(token){if(seen.has(hash(token)))fail('INVALID_SCOPE');seen.add(hash(token));}
      const payload=await call(toolArgs(c.search.argsTemplate,r,token)),m=c.search.resultMapping,items=at(payload,m.issuesPath),next=m.nextCursorPath===undefined?null:at(payload,m.nextCursorPath);
      if(!Array.isArray(items)||next!==null&&next!==undefined&&!text(next)||m.nextCursorPath!==undefined&&next===undefined)fail('INVALID_RESPONSE');if(items.length>50)fail('RESPONSE_TOO_LARGE');if(next&&(seen.has(hash(next))||next===token))fail('INVALID_SCOPE');
      for(const value of items){if(count>=1000){truncated=true;break;}count++;const item=normalize(value,c,r.binding,scope),key=issueIdentityKey(item);if(ids.has(key))continue;const size=Buffer.byteLength(JSON.stringify(item));if(bytes+size>7*1024*1024){truncated=true;error={code:'RESPONSE_TOO_LARGE',message:new TrackerError('RESPONSE_TOO_LARGE').message};break;}ids.add(key);data.push(item);bytes+=size;}
      if(error||truncated)break;if(!next)break;truncated=true;if(count>=1000||seen.size>=100)break;token=next;
      if(page===maxPages-1){const encoded=Buffer.from(JSON.stringify({v:1,scope:hash(trackerScopeKey(scope)),token,count,seen:[...seen],issuedAt:previous?.issuedAt??now})).toString('base64url');if(encoded.length<=8192)cursor=encoded;else error={code:'RESPONSE_TOO_LARGE',message:new TrackerError('RESPONSE_TOO_LARGE').message};}else truncated=false;
    }
    return validateSnapshot({data,fetchedAt:clock(),scope,truncated,...(cursor?{cursor}:{}),...(error?{error}:{})},scope,{now:clock()});
  });
}
