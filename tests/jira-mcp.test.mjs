import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {execFileSync} from 'node:child_process';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {fetchJiraMcp,probeJiraMcp} from '../src/mods/mission-control-jira/mcp.mjs';
import {publicTrackerError} from '../src/shared/tracker-transport.mjs';

const NOW=1800000000000,CLOUD='11111111-2222-3333-4444-555555555555';
const mapping={issuesPath:'items',nextCursorPath:'next',fields:{id:'id',key:'key',title:'summary',status:'status',body:'body'},statusGroups:{todo:['Open'],inProgress:['Doing'],done:['Done']}};
const search={tool:'search_issues',argsTemplate:{cloudId:CLOUD,jql:'{{jql}}',cursor:'{{cursor}}',limit:'{{pageSize}}'},resultMapping:mapping};
const request=c=>({v:1,operation:'issues',connection:c,binding:{machine:'server',repoRoot:'/srv/client-portal',jira:{connectionId:c.id,project:'WEB'}}});
const issue=(n,status)=>({id:String(10000+n),key:'WEB-'+n,summary:'Fix login '+n,status,body:'Task data.'});
const tool=()=>({name:'search_issues',description:'Read issues',inputSchema:{type:'object',properties:{cloudId:{type:'string'},jql:{type:'string'},cursor:{type:'string'},limit:{type:'number'}},required:['cloudId','jql','limit'],additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false}});
const options={clock:()=>NOW};
async function endpoint(t,{stateful=false}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mc-jira-mcp-')),key=path.join(root,'key.pem'),cert=path.join(root,'cert.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
  const ca=await fs.readFile(cert),requests=[],calls=[],sessions=new Map(),state={mode:'pages',tools:[tool()],redirect:null};
  const server=https.createServer({key:await fs.readFile(key),cert:ca},async(req,res)=>{
    requests.push({url:req.url,method:req.method,authorization:req.headers.authorization});
    if(state.redirect){res.writeHead(302,{location:state.redirect});res.end();return;}
    if(state.mode==='auth'||state.mode==='rate'){res.writeHead(state.mode==='auth'?401:429,{'retry-after':'2'});res.end('PRIVATE token-value');return;}
    const sessionId=req.headers['mcp-session-id'];
    if(stateful&&sessionId){const session=sessions.get(sessionId);if(!session){res.writeHead(404).end();return;}try{await session.transport.handleRequest(req,res);}catch{if(!res.headersSent)res.writeHead(500);res.end();}return;}
    const mcp=new Server({name:'jira-fixture',version:'1'},{capabilities:{tools:{}}});
    mcp.setRequestHandler(ListToolsRequestSchema,async()=>({tools:state.tools}));
    mcp.setRequestHandler(CallToolRequestSchema,async({params})=>{
      calls.push({name:params.name,args:params.arguments});state.onCall?.();if(state.mode==='slow')await new Promise(resolve=>setTimeout(resolve,300));
      if(state.mode==='error')return {isError:true,content:[{type:'text',text:'PRIVATE token-value'}]};
      if(state.mode==='malformed')return {content:[{type:'text',text:'not JSON'}]};
      const second=params.arguments.cursor==='page-two',items=second?[issue(143,'Doing'),issue(144,'Done')]:[issue(142,state.mode==='unknown'?'Mystery':'Open')];
      if(state.mode==='adf')items[0].body={type:'doc',version:1,content:[{type:'paragraph',content:[{type:'text',text:'Read this',marks:[{type:'link',attrs:{href:'https://never-fetched.invalid/docs'}}]}]}]};
      const payload={items,next:state.mode==='repeat'?'repeat':state.mode==='single'||state.mode==='adf'||second?null:'page-two'};
      if(state.mode==='large')payload.items[0].body='x'.repeat(4200000);
      if(['many','many-large','too-many'].includes(state.mode)){const page=Number(params.arguments.cursor||0);payload.items=Array.from({length:state.mode==='too-many'?51:50},(_,i)=>issue(page*50+i+1,i%3===0?'Done':'Open'));payload.next=String(page+1);if(state.mode==='many-large')for(const item of payload.items)item.body='x'.repeat(48000);}
      if(state.mode==='structured')return {content:[],structuredContent:payload};return {content:[{type:'text',text:JSON.stringify(payload)}]};
    });
    let transport;transport=new StreamableHTTPServerTransport({sessionIdGenerator:stateful?randomUUID:undefined,enableJsonResponse:true,...(stateful?{onsessioninitialized:id=>sessions.set(id,{mcp,transport})}:{})});
    if(!stateful)res.once('close',()=>{mcp.close().catch(()=>{});});
    try{await mcp.connect(transport);await transport.handleRequest(req,res);}catch{if(!res.headersSent)res.writeHead(500);res.end();}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  t.after(async()=>{for(const session of sessions.values())await session.mcp.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(root,{recursive:true,force:true});});
  const origin='https://127.0.0.1:'+server.address().port;
  const fetchImpl=(input,init={})=>new Promise((resolve,reject)=>{
    const req=https.request(input,{method:init.method||'GET',headers:Object.fromEntries(new Headers(init.headers)),ca,signal:init.signal},res=>{
      if(stateful){resolve(new Response([204,205,304].includes(res.statusCode)?null:Readable.toWeb(res),{status:res.statusCode,headers:Object.fromEntries(Object.entries(res.headers).filter(([,value])=>typeof value==='string'))}));return;}
      const chunks=[];res.on('error',reject);res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{const status=res.statusCode,body=[204,205,304].includes(status)?null:Buffer.concat(chunks);resolve(new Response(body,{status,headers:Object.fromEntries(Object.entries(res.headers).filter(([,v])=>typeof v==='string'))}));});
    });req.on('error',reject);req.end(init.body);
  });
  return {origin,state,requests,calls,fetchImpl,disconnect:()=>server.closeAllConnections(),connection:auth=>({id:'work',kind:'mcp-http',site:'https://work.atlassian.net',url:origin+'/mcp',...(auth?{auth}:{}),search:structuredClone(search)})};
}

test('real HTTP MCP SDK handshake selects only the declared read-only tool and preserves all workflow groups',async t=>{
  const f=await endpoint(t),input=request(f.connection()),result=await fetchJiraMcp(input,{...options,fetchImpl:f.fetchImpl});
  assert.deepEqual(result.data.map(v=>v.statusGroup),['todo','inProgress','done']);assert.equal(result.truncated,false);assert.equal(result.data[0].url,input.connection.site+'/browse/WEB-142');assert.equal(result.data[0].repoBinding.machine,'server');assert.ok(f.requests.every(v=>!v.authorization));assert.ok(f.calls.every(v=>v.name==='search_issues'));
  assert.equal(f.calls[0].args.jql,'project = "WEB" ORDER BY updated DESC');assert.equal(f.calls[0].args.cloudId,CLOUD);assert.equal(f.calls[0].args.limit,50);assert.equal(Object.hasOwn(f.calls[0].args,'cursor'),false);assert.equal(f.calls[1].args.cursor,'page-two');
  const count=f.calls.length;assert.deepEqual(await probeJiraMcp({...input,operation:'probe'},{...options,fetchImpl:f.fetchImpl}),{site:input.connection.site,route:'mcp-http',tool:'search_issues'});assert.equal(f.calls.length,count);
});

test('stateful HTTP MCP closes its SSE stream without masking success or selected-tool errors',async t=>{
  const f=await endpoint(t,{stateful:true});f.state.mode='single';const input=request(f.connection()),settings={...options,fetchImpl:f.fetchImpl};
  const result=await fetchJiraMcp(input,settings);assert.equal(result.data.length,1);assert.equal(result.data[0].key,'WEB-142');
  const before=f.calls.length;input.connection.search.tool='missing_search_tool';await assert.rejects(fetchJiraMcp(input,settings),error=>error.code==='MCP_TOOL_UNAVAILABLE');assert.equal(f.calls.length,before);
  assert.ok(f.requests.some(request=>request.method==='GET'),'A real streaming SSE channel was opened');
  input.connection.search.tool='search_issues';f.state.mode='slow';const started=new Promise(resolve=>{f.state.onCall=resolve;});
  const disconnected=assert.rejects(fetchJiraMcp(input,settings),error=>error.code==='MCP_UNAVAILABLE');await started;f.disconnect();await disconnected;
});

test('HTTP MCP Basic and Bearer credentials stay in selected endpoint headers and never enter tool args',async t=>{
  const f=await endpoint(t);f.state.mode='single';const env={USER_REF:'fixture@example.invalid',TOKEN_REF:'fixture-personal',SERVICE_REF:'fixture-service'};
  for(const auth of [{kind:'basic',usernameEnv:'USER_REF',tokenEnv:'TOKEN_REF'},{kind:'bearer',tokenEnv:'SERVICE_REF'}]){
    const start=f.requests.length;await fetchJiraMcp(request(f.connection(auth)),{...options,env,fetchImpl:f.fetchImpl});const expected=auth.kind==='basic'?'Basic '+Buffer.from('fixture@example.invalid:fixture-personal').toString('base64'):'Bearer fixture-service';assert.ok(f.requests.slice(start).every(v=>v.authorization===expected));
  }
  assert.doesNotMatch(JSON.stringify(f.calls),/fixture-personal|fixture-service|USER_REF|TOKEN_REF/);
  const before=f.requests.length;await assert.rejects(fetchJiraMcp(request(f.connection({kind:'bearer',tokenEnv:'MISSING'})),{...options,env,fetchImpl:f.fetchImpl}),e=>e.code==='AUTH_REQUIRED');assert.equal(f.requests.length,before);
});

test('HTTP redirects cannot forward MCP credentials to a second origin',async t=>{
  const source=await endpoint(t),sink=await endpoint(t);source.state.redirect=sink.origin+'/mcp';
  await assert.rejects(fetchJiraMcp(request(source.connection({kind:'bearer',tokenEnv:'TOKEN'})),{...options,env:{TOKEN:'fixture-secret'},fetchImpl:source.fetchImpl}),e=>e.code==='UNTRUSTED_ORIGIN');assert.equal(sink.requests.length,0);assert.ok(source.requests.every(v=>v.authorization==='Bearer fixture-secret'));
});

test('missing, mutation-only and changed input schemas cannot invoke any tool',async t=>{
  const f=await endpoint(t),input=request(f.connection());
  for(const tools of [[],[{...tool(),annotations:{readOnlyHint:false}}],[{...tool(),annotations:{readOnlyHint:true,destructiveHint:true}}],[{...tool(),inputSchema:{type:'object',required:['changedRequiredField']}}]]){
    f.state.tools=tools;await assert.rejects(fetchJiraMcp(input,{...options,fetchImpl:f.fetchImpl}),e=>['MCP_TOOL_UNAVAILABLE','MCP_TOOL_NOT_READ_ONLY'].includes(e.code));
  }
  assert.equal(f.calls.length,0);
});

test('MCP setup probe checks configured arguments against the selected tool schema without calling it',async t=>{
  const f=await endpoint(t),input=request(f.connection());input.operation='probe';input.connection.search.argsTemplate={cloudId:CLOUD,jql:'{{jql}}',limit:'not-a-number'};await assert.rejects(probeJiraMcp(input,{...options,fetchImpl:f.fetchImpl}),e=>e.code==='MCP_TOOL_UNAVAILABLE');assert.equal(f.calls.length,0);
});

test('MCP pagination chunks reject changed query, literal cloudId and expired scope before connection',async t=>{
  const f=await endpoint(t),input=request(f.connection()),settings={...options,fetchImpl:f.fetchImpl},first=await fetchJiraMcp(input,{...settings,maxPages:1});assert.ok(first.cursor);assert.equal(first.truncated,true);
  const next=await fetchJiraMcp({...input,cursor:first.cursor},settings);assert.equal(next.truncated,false);assert.equal(next.data.length,2);const count=f.requests.length;
  for(const change of [{binding:{...input.binding,jira:{connectionId:'work',project:'OPS'}}},{connection:{...input.connection,search:{...input.connection.search,argsTemplate:{...search.argsTemplate,cloudId:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'}}}}])await assert.rejects(fetchJiraMcp({...input,...change,cursor:first.cursor},settings),e=>e.code==='INVALID_SCOPE');
  await assert.rejects(fetchJiraMcp({...input,cursor:first.cursor},{...settings,clock:()=>NOW+7*86400000}),e=>e.code==='INVALID_SCOPE');assert.equal(f.requests.length,count);
});

test('MCP errors, unknown mappings, repetition, oversized output and expired auth never become cards',async t=>{
  const f=await endpoint(t),input=request(f.connection());
  for(const [mode,code]of [['auth','AUTH_REQUIRED'],['rate','RATE_LIMITED'],['error','ADAPTER_FAILED'],['malformed','INVALID_RESPONSE'],['unknown','STATUS_MAPPING_REQUIRED'],['repeat','INVALID_SCOPE'],['large','RESPONSE_TOO_LARGE']]){
    f.state.mode=mode;await assert.rejects(fetchJiraMcp(input,{...options,fetchImpl:f.fetchImpl}),e=>{assert.equal(e.code,code,mode);assert.doesNotMatch(JSON.stringify(publicTrackerError(e)),/PRIVATE|token-value/);return true;});
  }
});

test('structured output and ADF descriptions normalize without fetching rich-text links',async t=>{
  const f=await endpoint(t),input=request(f.connection());for(const mode of ['structured','adf']){f.state.mode=mode;const result=await fetchJiraMcp(input,{...options,fetchImpl:f.fetchImpl});assert.ok(result.data.length);if(mode==='adf')assert.match(result.data[0].body,/Read this \(https:\/\/never-fetched.invalid\/docs\)/);}
  assert.ok(f.requests.every(v=>v.url==='/mcp'));
});

test('MCP catalog, page, cumulative-count and normalized output limits stay explicit',async t=>{
  const f=await endpoint(t),input=request(f.connection()),settings={...options,fetchImpl:f.fetchImpl};f.state.tools=Array.from({length:201},(_,i)=>({...tool(),name:'tool_'+i}));
  await assert.rejects(fetchJiraMcp(input,settings),e=>e.code==='RESPONSE_TOO_LARGE');assert.equal(f.calls.length,0);f.state.tools=[tool()];
  f.state.mode='too-many';await assert.rejects(fetchJiraMcp(input,settings),e=>e.code==='RESPONSE_TOO_LARGE');
  f.state.mode='many';const capped=await fetchJiraMcp(input,{...settings,maxPages:20});assert.equal(capped.data.length,1000);assert.equal(capped.truncated,true);assert.equal(capped.cursor,undefined);assert.ok(capped.data.some(v=>v.statusGroup==='done'));
  f.state.mode='many-large';const bounded=await fetchJiraMcp(input,{...settings,maxPages:20});assert.equal(bounded.truncated,true);assert.equal(bounded.error.code,'RESPONSE_TOO_LARGE');assert.equal(bounded.cursor,undefined);assert.ok(bounded.data.length>0&&bounded.data.length<1000);assert.ok(Buffer.byteLength(JSON.stringify(bounded))<8*1024*1024);
});

test('MCP deadline and cancellation close the SDK session with static reasons',async t=>{
  for(const stateful of [false,true]){
    const f=await endpoint(t,{stateful});f.state.mode='slow';const input=request(f.connection());await assert.rejects(fetchJiraMcp(input,{...options,fetchImpl:f.fetchImpl,timeoutMs:150}),e=>e.code==='REQUEST_TIMEOUT');
    const abort=new AbortController(),pending=fetchJiraMcp(input,{...options,fetchImpl:f.fetchImpl,signal:abort.signal}),rejected=assert.rejects(pending,e=>e.code==='REQUEST_CANCELLED');setTimeout(()=>abort.abort(),50);await rejected;
  }
});

test('real stdio MCP process uses selected envRefs locally and does not expose stderr',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mc-jira-mcp-stdio-')),script=path.join(root,'server.mjs'),record=path.join(root,'record.json');t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const sdk=new URL('../node_modules/@modelcontextprotocol/sdk/dist/esm/',import.meta.url);
  await fs.writeFile(script,`import fs from 'node:fs';
import {Server} from ${JSON.stringify(new URL('server/index.js',sdk).href)};
import {StdioServerTransport} from ${JSON.stringify(new URL('server/stdio.js',sdk).href)};
import {ListToolsRequestSchema,CallToolRequestSchema} from ${JSON.stringify(new URL('types.js',sdk).href)};
const record=process.argv[2],server=new Server({name:'stdio-fixture',version:'1'},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[${JSON.stringify(tool())}]}));
server.setRequestHandler(CallToolRequestSchema,async({params})=>{fs.writeFileSync(record,JSON.stringify({pid:process.pid,name:params.name,args:params.arguments,hasSelectedToken:Boolean(process.env.JIRA_API_TOKEN),hasUnrelatedToken:Boolean(process.env.UNRELATED_SECRET)}));process.stderr.write('PRIVATE unrelated credential');return {content:[{type:'text',text:JSON.stringify({items:[${JSON.stringify(issue(142,'Done'))}],next:null})}]};});
await server.connect(new StdioServerTransport());
`);
  const c={id:'stdio',kind:'mcp-stdio',site:'https://work.atlassian.net',execution:{machine:null,command:process.execPath,args:[script,record],envRefs:{JIRA_API_TOKEN:'WORK_TOKEN'}},search:structuredClone(search)},env={...process.env,WORK_TOKEN:'fixture-selected',UNRELATED_SECRET:'fixture-unrelated'},result=await fetchJiraMcp(request(c),{...options,env});
  assert.equal(result.data[0].statusGroup,'done');const proof=JSON.parse(await fs.readFile(record,'utf8'));assert.equal(proof.hasSelectedToken,true);assert.equal(proof.hasUnrelatedToken,false);assert.equal(proof.name,'search_issues');assert.doesNotMatch(JSON.stringify(result),/PRIVATE|credential|fixture-selected/);assert.throws(()=>process.kill(proof.pid,0),e=>e.code==='ESRCH');
  await assert.rejects(fetchJiraMcp(request({...c,execution:{...c.execution,machine:'server'}}),{...options,env}),e=>e.code==='UNSUPPORTED_INTEGRATION_HOST');await assert.rejects(fetchJiraMcp(request(c),{...options,env:{}}),e=>e.code==='AUTH_REQUIRED');
});
