import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import {execFile,execFileSync} from 'node:child_process';
import {build} from 'esbuild';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {newConfig,bindingKey,readConfig} from '../src/shared/config.js';
import {trackerScope,validateSnapshot} from '../src/shared/tracker-model.js';
import {requestJson} from '../src/shared/tracker-transport.mjs';
import {dispatchJira} from '../src/mods/mission-control-jira/backend.mjs';
import {JiraDataBridge,STALE_LOAD_MS,jiraSetupModel,jiraSetupFields,jiraRouteDescription} from '../src/mods/mission-control-jira/data.js';

const CLOUD='11111111-2222-3333-4444-555555555555';
const mapping={issuesPath:'items',nextCursorPath:'next',fields:{id:'id',key:'key',title:'title',status:'status',body:'body'},statusGroups:{todo:['Open'],inProgress:['Doing'],done:['Done']}};
const search={tool:'search_issues',argsTemplate:{jql:'{{jql}}',limit:'{{pageSize}}',cursor:'{{cursor}}'},resultMapping:mapping};
const mcpTool={name:'search_issues',inputSchema:{type:'object',properties:{jql:{type:'string'},limit:{type:'number'},cursor:{type:'string'}},required:['jql','limit'],additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false}};
const flat=(n=142,status='Open')=>({id:String(10000+n),key:'WEB-'+n,title:'Fix login '+n,status,body:'Actual fixture task data.'});
const apiRow=(n=142,category='new')=>({id:String(10000+n),key:'WEB-'+n,fields:{summary:'Fix login '+n,description:null,status:{name:category,statusCategory:{key:category}}}});
const response=(res,value,status=200,headers={})=>{res.writeHead(status,{'content-type':'application/json',...headers});res.end(JSON.stringify(value));};
const request=(connection,repoRoot='/repos/client',machine=null)=>({v:1,operation:'issues',connection,binding:{machine,repoRoot,jira:{connectionId:connection.id,project:'WEB'}}});
async function waitFor(check,{timeout=6000}={}){const deadline=Date.now()+timeout;while(Date.now()<deadline){if(check())return;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('The owned fixture did not reach its expected state before the deadline.');}

async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mc-jira-backend-')),mod=path.join(root,'mods/mission-control-jira'),file=path.join(root,'mission-control/config.json');await fs.mkdir(mod,{recursive:true});await fs.mkdir(path.dirname(file));
  const backend=path.join(mod,'backend.mjs');await build({entryPoints:['src/mods/mission-control-jira/backend.mjs'],bundle:true,platform:'node',format:'esm',target:'node22',outfile:backend,banner:{js:'import {createRequire as __mcCreateRequire} from "node:module";const require=__mcCreateRequire(import.meta.url);'},logLevel:'silent'});
  const key=path.join(root,'key.pem'),cert=path.join(root,'cert.pem');execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});const ca=await fs.readFile(cert);
  const state={hold:false,holdProbe:false,apiMode:'ok',apiCanonical:null,paginate:false,mcpPaginate:false,many:false},held=[],requests=[],calls=[],mcpCalls=[];let origin;
  const send=(req,res)=>{
    if(req.url.endsWith('/serverInfo'))return response(res,{baseUrl:state.apiCanonical||origin,displayUrl:'https://custom.jira.invalid'});
    if(state.apiMode==='rate')return response(res,{private:'PRIVATE fixture-api-token'},429,{'retry-after':'2'});
    if(state.apiMode==='auth')return response(res,{private:'PRIVATE fixture-api-token'},401);
    const next=new URL(req.url,origin).searchParams.get('nextPageToken'),personal=req.headers.authorization==='Bearer fixture-personal-token';
    if(state.many){const page=Number(next||0),issues=Array.from({length:50},(_,i)=>({...apiRow(page*50+i+1),fields:{...apiRow(page*50+i+1).fields,description:'x'.repeat(48000)}}));return response(res,{issues,isLast:false,nextPageToken:String(page+1)});}
    response(res,{issues:[apiRow(personal?144:next?143:142,personal?'done':next?'indeterminate':'new')],...(state.paginate&&!next?{isLast:false,nextPageToken:'next-page'}:{isLast:true})});
  };
  const server=https.createServer({key:await fs.readFile(key),cert:ca},async(req,res)=>{
    requests.push({url:req.url,authorization:req.headers.authorization,method:req.method});
    if(req.url==='/mcp'){
      const sdk=new Server({name:'backend-fixture',version:'1'},{capabilities:{tools:{}}});sdk.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[mcpTool]}));
      sdk.setRequestHandler(CallToolRequestSchema,async({params})=>{mcpCalls.push(params);return {content:[{type:'text',text:JSON.stringify({items:[flat(params.arguments.cursor?143:142,'Done')],next:state.mcpPaginate&&!params.arguments.cursor?'mcp-next':null})}]};});
      const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});res.once('close',()=>sdk.close().catch(()=>{}));try{await sdk.connect(transport);await transport.handleRequest(req,res);}catch{if(!res.headersSent)res.writeHead(500);res.end();}return;
    }
    if(state.hold&&req.url.includes('/search/jql')||state.holdProbe&&req.url.endsWith('/serverInfo')){held.push(()=>send(req,res));return;}send(req,res);
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});origin='https://127.0.0.1:'+server.address().port;
  const env={...process.env,NODE_EXTRA_CA_CERTS:cert,TEST_JIRA_USER:'fixture@example.invalid',TEST_JIRA_TOKEN:'fixture-api-token',TEST_PERSONAL_TOKEN:'fixture-personal-token',TEST_MCP_TOKEN:'fixture-mcp-token'};
  let active=0,peak=0;const invoke=(command,args,opts)=>{
    assert.equal(command,'node');assert.equal(opts.cwd,root);assert.equal(Object.hasOwn(opts,'on'),false,'the repo execution host is never the helper host');try{calls.push(JSON.parse(args[1]));}catch{calls.push({invalid:true});}active++;peak=Math.max(peak,active);
    return new Promise((resolve,reject)=>execFile(process.execPath,args,{cwd:root,env,maxBuffer:8*1024*1024,timeout:25000},(error,stdout,stderr)=>{active--;if(error&&typeof error.code!=='number')reject(error);else resolve({code:error?.code||0,stdout,stderr});}));
  };
  const io={appHome:()=>root,exec:invoke,readTextFile:async p=>{try{return await fs.readFile(p,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}},ensureDirectory:p=>fs.mkdir(p,{recursive:true}),writeTextFile:async(p,text,expected)=>{let old;try{old=await fs.readFile(p,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;old=null;}if(old!==expected)throw Object.assign(Error('CAS changed'),{code:'STALE'});await fs.writeFile(p,text);}};
  const cliScript=path.join(root,'cli.mjs');await fs.writeFile(cliScript,`const request=JSON.parse(process.argv[2]);process.stdout.write(JSON.stringify({items:[${JSON.stringify(flat())}],next:null}));`);
  const stdioScript=path.join(root,'mcp.mjs'),sdkRoot=new URL('../node_modules/@modelcontextprotocol/sdk/dist/esm/',import.meta.url);
  await fs.writeFile(stdioScript,`import {Server} from ${JSON.stringify(new URL('server/index.js',sdkRoot).href)};import {StdioServerTransport} from ${JSON.stringify(new URL('server/stdio.js',sdkRoot).href)};import {ListToolsRequestSchema,CallToolRequestSchema} from ${JSON.stringify(new URL('types.js',sdkRoot).href)};const server=new Server({name:'backend-stdio-fixture',version:'1'},{capabilities:{tools:{}}});server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[${JSON.stringify(mcpTool)}]}));server.setRequestHandler(CallToolRequestSchema,async()=>({content:[{type:'text',text:JSON.stringify({items:[${JSON.stringify(flat(142,'Doing'))}],next:null})}]}));await server.connect(new StdioServerTransport());`);
  t.after(async()=>{state.hold=false;state.holdProbe=false;while(held.length)held.shift()();await waitFor(()=>active===0,{timeout:26000});server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(root,{recursive:true,force:true});});
  const fetchImpl=(input,init={})=>new Promise((resolve,reject)=>{const req=https.request(input,{method:init.method||'GET',headers:Object.fromEntries(new Headers(init.headers)),ca,signal:init.signal},res=>{const chunks=[];res.on('error',reject);res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve(new Response([204,205,304].includes(res.statusCode)?null:Buffer.concat(chunks),{status:res.statusCode,headers:Object.fromEntries(Object.entries(res.headers).filter(([,v])=>typeof v==='string'))})));});req.on('error',reject);req.end(init.body);});
  return {root,file,backend,origin,io,env,state,held,requests,calls,mcpCalls,ca,fetchImpl,peak:()=>peak,active:()=>active,release:()=>{while(held.length)held.shift()();},
    api:(id='work')=>({id,kind:'api',site:origin,auth:{kind:'basic',usernameEnv:'TEST_JIRA_USER',tokenEnv:'TEST_JIRA_TOKEN'}}),
    personal:()=>({id:'personal',kind:'api',site:origin,cloudId:CLOUD,auth:{kind:'bearer',tokenEnv:'TEST_PERSONAL_TOKEN'}}),
    cli:()=>({id:'cli',kind:'cli',site:origin,execution:{machine:null,command:process.execPath,argsTemplate:[cliScript,'{{request}}']},mapping:structuredClone(mapping)}),
    http:()=>({id:'http',kind:'mcp-http',site:origin,url:origin+'/mcp',auth:{kind:'bearer',tokenEnv:'TEST_MCP_TOKEN'},search:structuredClone(search)}),
    stdio:()=>({id:'stdio',kind:'mcp-stdio',site:origin,execution:{machine:null,command:process.execPath,args:[stdioScript],envRefs:{JIRA_TOKEN:'TEST_MCP_TOKEN'}},search:structuredClone(search)}),
    save:config=>fs.writeFile(file,JSON.stringify(config)),invoke,
  };
}
function configFor(inputs){const config=newConfig();for(const input of inputs){config.connections[input.connection.id]=input.connection;config.bindings[bindingKey(input.binding.machine,input.binding.repoRoot)]=input.binding;}return config;}
const resolved=input=>({state:'resolved',machine:input.binding.machine,repoRoot:input.binding.repoRoot});

test('the bundled executable dispatches real API, CLI, MCP HTTP and MCP stdio fixtures without sibling modules',async t=>{
  const f=await fixture(t),inputs=[request(f.api(),'/repos/api'),request(f.cli(),'/srv/cli','server'),request(f.http(),'/repos/http'),request(f.stdio(),'/srv/stdio','server')];
  for(const input of inputs){const result=await f.invoke('node',[f.backend,JSON.stringify(input)],{cwd:f.root}),reply=JSON.parse(result.stdout);assert.equal(result.code,0);assert.equal(reply.ok,true,JSON.stringify(reply));assert.equal(reply.operation,'issues');assert.equal(validateSnapshot(reply.snapshot,trackerScope('jira',input.connection,input.binding)).data.length,1);assert.equal(reply.snapshot.data[0].repoBinding.machine,input.binding.machine);assert.equal(reply.snapshot.truncated,false);assert.doesNotMatch(result.stdout,/fixture-api-token|fixture-mcp-token/);}
  assert.ok(f.requests.filter(r=>r.url.includes('/rest/api/')).every(r=>r.authorization==='Basic '+Buffer.from('fixture@example.invalid:fixture-api-token').toString('base64')));assert.ok(f.requests.filter(r=>r.url==='/mcp').every(r=>r.authorization==='Bearer fixture-mcp-token'));assert.equal(f.mcpCalls.length,1);assert.doesNotMatch(JSON.stringify(f.calls),/fixture-api-token|fixture-mcp-token/);assert.equal(await fs.readdir(path.join(f.root,'mods')).then(v=>v.length),1);
});

test('a symlinked installed helper runs with both default and preserved-symlink Node entry handling',async t=>{
  const f=await fixture(t),alias=path.join(f.root,'linked-mod');await fs.symlink(path.dirname(f.backend),alias,'dir');const input=request(f.api());
  for(const preserve of [false,true]){if(preserve)f.env.NODE_OPTIONS='--preserve-symlinks-main';else delete f.env.NODE_OPTIONS;const reply=JSON.parse((await f.invoke('node',[path.join(alias,'backend.mjs'),JSON.stringify(input)],{cwd:f.root})).stdout);assert.equal(reply.ok,true);assert.equal(reply.snapshot.data[0].key,'WEB-142');}
});

test('public helper scope and cursor retain the exact requested profile despite Node URL normalization',async t=>{
  const f=await fixture(t),connection=f.http();connection.url=f.origin+'/unused/../mcp';const input=request(connection);
  const reply=JSON.parse((await f.invoke('node',[f.backend,JSON.stringify(input)],{cwd:f.root})).stdout);assert.equal(reply.ok,true);assert.equal(reply.snapshot.scope.fingerprint,trackerScope('jira',connection,input.binding).fingerprint);assert.ok(f.requests.every(r=>r.url==='/mcp'));
  f.state.paginate=true;const api=request(f.api()),first=await dispatchJira(api,{env:f.env,api:{ca:f.ca,maxPages:1}});assert.ok(first.snapshot.cursor);const next=await dispatchJira({...api,cursor:first.snapshot.cursor},{env:f.env,api:{ca:f.ca}});assert.equal(next.ok,true);assert.equal(next.snapshot.data[0].key,'WEB-143');assert.equal(next.snapshot.truncated,false);
  const count=f.requests.length,wrong=await dispatchJira({...api,connection:{...api.connection,auth:{...api.connection.auth,tokenEnv:'OTHER_TOKEN'}},cursor:first.snapshot.cursor},{env:f.env,api:{ca:f.ca}});assert.equal(wrong.ok,false);assert.equal(wrong.error.code,'INVALID_SCOPE');assert.equal(f.requests.length,count);
  f.state.mcpPaginate=true;const mcpOptions={env:f.env,mcp:{fetchImpl:f.fetchImpl,maxPages:1}},mcpFirst=await dispatchJira(input,mcpOptions);assert.ok(mcpFirst.snapshot.cursor);const requests=f.requests.length;
  const canonicalUrl=await dispatchJira({...input,connection:{...connection,url:f.origin+'/mcp'},cursor:mcpFirst.snapshot.cursor},mcpOptions);assert.equal(canonicalUrl.error.code,'INVALID_SCOPE');assert.equal(f.requests.length,requests,'a raw-profile scope change must fail even when Node would normalize both URLs identically');
  const mcpNext=await dispatchJira({...input,cursor:mcpFirst.snapshot.cursor},mcpOptions);assert.equal(mcpNext.ok,true);assert.equal(mcpNext.snapshot.data[0].key,'WEB-143');
});

test('invalid envelopes and remote integration programs fail before any provider or process starts',async t=>{
  const f=await fixture(t),input=request(f.api());
  for(const value of [{...input,operation:'delete'},{...input,operation:'pulls'},{...input,unexpected:true},{...input,binding:{...input.binding,machine:undefined}},{...request(f.cli()),connection:{...f.cli(),execution:{...f.cli().execution,machine:'server'}}},{...input,operation:'probe',cursor:'not-allowed'}]){const reply=await dispatchJira(value,{env:f.env,api:{ca:f.ca}});assert.equal(reply.ok,false);assert.equal(Object.hasOwn(reply,'snapshot'),false);}
  assert.equal(f.requests.length,0);const result=await f.invoke('node',[f.backend,'not JSON'],{cwd:f.root});assert.equal(JSON.parse(result.stdout).error.code,'INVALID_REQUEST');assert.doesNotMatch(result.stdout,/not JSON/);
});

test('native bridge aggregates every qualified binding while all helpers execute locally',async t=>{
  const f=await fixture(t),inputs=[request(f.api(),'/repos/api'),request(f.cli(),'/srv/cli','server'),request(f.http(),'/repos/http'),request(f.stdio(),'/srv/stdio','server')],config=configFor(inputs),changes=[];await f.save(config);const bridge=new JiraDataBridge(f.io,{onChange:v=>changes.push(v)});t.after(()=>bridge.close());
  await bridge.synchronize(null,{all:true});assert.equal(bridge.view().data.length,0);assert.equal(bridge.view().state,'loading');await bridge.refresh();assert.equal(bridge.view().data.length,4);assert.equal(bridge.view().bindings.length,4);assert.equal(new Set(bridge.view().data.map(v=>v.identity.connectionId)).size,4);assert.equal(bridge.view().errors.length,0);assert.ok(changes.some(v=>v.data.length>0&&v.loading>0));assert.ok(f.peak()<=4);
});

test('manual and timer refresh coalesce; same-scope errors retain timestamped cards and respect retry delay',async t=>{
  const f=await fixture(t),input=request(f.api());await f.save(configFor([input]));let now=Date.now();const bridge=new JiraDataBridge(f.io,{clock:()=>now});t.after(()=>bridge.close());await bridge.synchronize(resolved(input));f.state.hold=true;
  const first=bridge.refresh({force:true}),second=bridge.refresh();await waitFor(()=>f.held.length===1);assert.equal(f.calls.length,1);f.state.hold=false;f.release();await Promise.all([first,second]);const initial=bridge.view().bindings[0].snapshot.fetchedAt;assert.equal(bridge.view().data.length,1);
  await bridge.refresh();assert.equal(f.calls.length,1);now=Date.now()+61000;f.state.apiMode='rate';await bridge.refresh();assert.equal(f.calls.length,2);assert.equal(bridge.view().bindings[0].snapshot.fetchedAt,initial);assert.equal(bridge.view().data.length,1);assert.equal(bridge.view().errors[0].error.code,'RATE_LIMITED');assert.doesNotMatch(JSON.stringify(bridge.view()),/PRIVATE|fixture-api-token/);
  await bridge.refresh({force:true});assert.equal(f.calls.length,2);now+=2001;f.state.apiMode='ok';await bridge.refresh({force:true});assert.equal(f.calls.length,3);assert.equal(bridge.view().errors.length,0);
});

test('account change clears cards immediately, caps four helpers and discards queued and late old-scope work',async t=>{
  const f=await fixture(t),inputs=Array.from({length:6},(_,i)=>request(f.api(),'/repos/project-'+i)),config=configFor(inputs),views=[];const bridge=new JiraDataBridge(f.io,{onChange:v=>views.push(v)});t.after(()=>bridge.close());bridge.selectConfig(config,null,{all:true});f.state.hold=true;const old=bridge.refresh({force:true});assert.equal(f.calls.length,4,'available native effects start synchronously in their calling task');await waitFor(()=>f.held.length===4);assert.equal(f.calls.length,4);assert.equal(f.peak(),4);
  const next=request({...f.api('personal'),auth:{kind:'basic',usernameEnv:'TEST_JIRA_USER',tokenEnv:'TEST_PERSONAL_TOKEN'}},inputs[0].binding.repoRoot),nextConfig=configFor([next]);bridge.selectConfig(nextConfig,resolved(next));assert.equal(bridge.view().data.length,0);const start=views.length,current=bridge.refresh({force:true});f.state.hold=false;f.release();await Promise.all([old,current]);
  assert.equal(f.calls.length,5,'two obsolete queued scopes must never execute');assert.ok(f.peak()<=4);assert.equal(bridge.view().data[0].identity.connectionId,'personal');assert.ok(views.slice(start).every(v=>v.data.every(row=>row.identity.connectionId==='personal')));
});

test('load-more merges real rows and source errors cannot turn a wrong-scope packet into a card',async t=>{
  const f=await fixture(t),input=request(f.api()),config=configFor([input]);f.state.paginate=true;
  const io={...f.io,exec:async(command,args,opts)=>{assert.equal(command,'node');assert.equal(opts.cwd,f.root);const reply=await dispatchJira(JSON.parse(args[1]),{env:f.env,api:{ca:f.ca,maxPages:1}});return {code:0,stdout:JSON.stringify(reply),stderr:''};}};
  const bridge=new JiraDataBridge(io);t.after(()=>bridge.close());bridge.selectConfig(config,resolved(input));await bridge.refresh();assert.equal(bridge.view().data.length,1);assert.equal(bridge.view().truncated,true);await bridge.refresh({loadMore:true});assert.deepEqual(bridge.view().data.map(v=>v.key),['WEB-142','WEB-143']);assert.equal(bridge.view().truncated,false);
  const snapshot=structuredClone(bridge.view().bindings[0].snapshot);snapshot.scope.connectionId='wrong-profile';io.exec=async()=>({code:0,stdout:JSON.stringify({v:1,ok:true,operation:'issues',snapshot}),stderr:'PRIVATE token'});await bridge.refresh({force:true});assert.equal(bridge.view().data.length,2);assert.equal(bridge.view().errors[0].error.code,'INVALID_RESPONSE');assert.doesNotMatch(JSON.stringify(bridge.view()),/PRIVATE/);
});

test('API setup probes canonical site before CAS save and failure preserves every byte of prior config',async t=>{
  const f=await fixture(t),old=request(f.api('old')),config=configFor([old]);config.connections.github={id:'github',kind:'github',site:'https://github.com',credentialEnv:'GH_TEST_TOKEN'};config.bindings[bindingKey(old.binding.machine,old.binding.repoRoot)].github={connectionId:'github',owner:'Acme',repo:'Web'};await f.save(config);const original=await fs.readFile(f.file,'utf8');const bridge=new JiraDataBridge(f.io);t.after(()=>bridge.close());bridge.selectConfig(config,resolved(old));f.state.apiCanonical='https://canonical.atlassian.net';
  await assert.rejects(bridge.saveSetup({target:{machine:null,repoRoot:old.binding.repoRoot},connection:f.api('new'),selection:{project:'OPS'}}),e=>e.code==='CANONICAL_SITE_REQUIRED'&&/canonical/.test(e.message));assert.equal(await fs.readFile(f.file,'utf8'),original);assert.ok(f.requests.every(r=>r.url.endsWith('/serverInfo')));
  f.state.apiCanonical=null;const saved=await bridge.saveSetup({target:{machine:null,repoRoot:old.binding.repoRoot},connection:f.api('new'),selection:{project:'OPS'}});assert.equal(saved.probe.route,'tenant');const next=(await readConfig(f.io)).value;assert.equal(next.bindings[bindingKey(null,old.binding.repoRoot)].jira.connectionId,'new');assert.deepEqual(next.bindings[bindingKey(null,old.binding.repoRoot)].github,config.bindings[bindingKey(null,old.binding.repoRoot)].github);assert.deepEqual(next.connections.github,config.connections.github);assert.deepEqual(next.connections.old,config.connections.old);await bridge.refresh({force:true});assert.equal(bridge.view().data[0].identity.connectionId,'new');
});

test('setup model exposes profile choice, cloud ID and Basic/Bearer env references without token-value fields',async t=>{
  const f=await fixture(t),input=request({...f.api(),cloudId:CLOUD}),config=configFor([input]);config.connections.http=f.http();
  const model=jiraSetupModel(config,resolved(input));assert.equal(model.state,'ready');assert.equal(model.connection.id,'work');assert.equal(model.profiles.length,2);assert.match(model.siteHint,/baseUrl/);assert.match(model.route,/cloud ID/);assert.ok(model.fields.some(v=>v.path==='cloudId'));assert.ok(model.fields.some(v=>v.path==='auth.usernameEnv'));assert.ok(model.fields.some(v=>v.path==='auth.tokenEnv'));assert.ok(model.fields.every(v=>!['token','password','auth.token'].includes(v.path)));
  const http={...f.http(),auth:{kind:'basic',usernameEnv:'TEST_JIRA_USER',tokenEnv:'TEST_MCP_TOKEN'}};assert.ok(jiraSetupFields(http).some(v=>v.path==='auth.usernameEnv'));assert.match(jiraRouteDescription(http),/HTTPS MCP/);assert.match(jiraRouteDescription({...f.api(),auth:{kind:'bearer',tokenEnv:'TEST_PERSONAL_TOKEN'}}),/OAuth/);assert.equal(jiraSetupModel(config,{state:'ambiguous',machine:null,repoRoot:input.binding.repoRoot}).state,'ambiguous');
});

test('scoped API setup and MCP Basic save credential references and never send MCP auth to REST',async t=>{
  const f=await fixture(t);await f.save(newConfig());const intended=[];
  const io={...f.io,exec:async(command,args,opts)=>{const input=JSON.parse(args[1]);if(input.connection.kind!=='api')return f.invoke(command,args,opts);const reply=await dispatchJira(input,{env:f.env,api:{request:async(url,options)=>{intended.push(url);const target=new URL(url);assert.equal(target.origin,'https://api.atlassian.com');assert.ok(target.pathname.startsWith('/ex/jira/'+CLOUD+'/'));return requestJson(f.origin+target.pathname+target.search,{...options,allowedOrigin:f.origin,ca:f.ca});}}});return {code:0,stdout:JSON.stringify(reply),stderr:''};}};
  const bridge=new JiraDataBridge(io);t.after(()=>bridge.close());const scoped={...f.api('scoped'),cloudId:CLOUD};await bridge.saveSetup({target:{machine:'server',repoRoot:'/srv/scoped'},connection:scoped,selection:{project:'WEB'}});assert.equal(intended.length,1);assert.ok(intended[0].endsWith('/serverInfo'));
  const start=f.requests.length,http={...f.http(),auth:{kind:'basic',usernameEnv:'TEST_JIRA_USER',tokenEnv:'TEST_MCP_TOKEN'}};await bridge.saveSetup({target:{machine:null,repoRoot:'/repos/mcp'},connection:http,selection:{project:'OPS'}});assert.ok(f.requests.slice(start).every(v=>v.url==='/mcp'));assert.ok(f.requests.slice(start).every(v=>v.authorization==='Basic '+Buffer.from('fixture@example.invalid:fixture-mcp-token').toString('base64')));
  const saved=(await readConfig(f.io)).value;assert.equal(saved.connections.scoped.cloudId,CLOUD);assert.equal(saved.connections.http.auth.usernameEnv,'TEST_JIRA_USER');assert.equal(saved.bindings[bindingKey('server','/srv/scoped')].jira.connectionId,'scoped');assert.doesNotMatch(await fs.readFile(f.file,'utf8'),/fixture-api-token|fixture-mcp-token/);
  const before=await fs.readFile(f.file,'utf8'),requests=f.requests.length;await assert.rejects(bridge.saveSetup({target:{machine:null,repoRoot:'/repos/bad'},connection:{...f.api('bad'),auth:{kind:'bearer',token:'PRIVATE'}},selection:{project:'WEB'}}));assert.equal(await fs.readFile(f.file,'utf8'),before);assert.equal(f.requests.length,requests);
});

test('cancelled setup cannot persist after a slow probe and a shared profile cannot be edited implicitly',async t=>{
  const f=await fixture(t),input=request(f.api()),config=configFor([input]);await f.save(config);const original=await fs.readFile(f.file,'utf8'),bridge=new JiraDataBridge(f.io);t.after(()=>bridge.close());f.state.holdProbe=true;
  const pending=bridge.saveSetup({target:{machine:null,repoRoot:input.binding.repoRoot},connection:f.api('new'),selection:{project:'OPS'}}),rejected=assert.rejects(pending,e=>e.code==='REQUEST_CANCELLED');await waitFor(()=>f.held.length===1);bridge.cancelSetup();f.state.holdProbe=false;f.release();await rejected;assert.equal(await fs.readFile(f.file,'utf8'),original);
  const count=f.calls.length;await assert.rejects(bridge.saveSetup({target:{machine:null,repoRoot:input.binding.repoRoot},connection:{...f.api(),auth:{kind:'bearer',tokenEnv:'TEST_PERSONAL_TOKEN'}},selection:{project:'OPS'}}),e=>e.code==='CONNECTION_CONFLICT');assert.equal(f.calls.length,count);assert.equal(await fs.readFile(f.file,'utf8'),original);
});

test('a concurrent config edit survives setup and only the captured repo binding changes',async t=>{
  const f=await fixture(t),a=request(f.api(),'/repos/a'),b=request(f.api(),'/srv/b','server'),config=configFor([a,b]);await f.save(config);const bridge=new JiraDataBridge(f.io);t.after(()=>bridge.close());f.state.holdProbe=true;
  const pending=bridge.saveSetup({target:{machine:null,repoRoot:a.binding.repoRoot},connection:f.api(),selection:{project:'OPS'}});await waitFor(()=>f.held.length===1);
  const edited=(await readConfig(f.io)).value;edited.preferences.userSetting='preserve me';edited.revision++;edited.connections.github={id:'github',kind:'github',site:'https://github.com',credentialEnv:'GH_TEST_TOKEN'};edited.bindings[bindingKey('server','/srv/b')].github={connectionId:'github',owner:'Acme',repo:'Server'};await f.save(edited);f.state.holdProbe=false;f.release();await pending;
  const next=(await readConfig(f.io)).value;assert.equal(next.bindings[bindingKey(null,'/repos/a')].jira.project,'OPS');assert.equal(next.bindings[bindingKey('server','/srv/b')].jira.project,'WEB');assert.deepEqual(next.bindings[bindingKey('server','/srv/b')].github,edited.bindings[bindingKey('server','/srv/b')].github);assert.equal(next.preferences.userSetting,'preserve me');assert.equal(next.revision,edited.revision+1);
});

test('closing the bridge suppresses publication and prevents queued scopes from starting',async t=>{
  const f=await fixture(t),inputs=Array.from({length:6},(_,i)=>request(f.api(),'/repos/project-'+i)),views=[],bridge=new JiraDataBridge(f.io,{onChange:v=>views.push(v)});bridge.selectConfig(configFor(inputs),null,{all:true});f.state.hold=true;const pending=bridge.refresh({force:true});await waitFor(()=>f.held.length===4);bridge.close();const count=views.length;f.state.hold=false;f.release();await pending;
  assert.equal(f.calls.length,4);assert.equal(f.active(),0);assert.equal(bridge.holders.size,0);assert.equal(bridge.jobs.size,0);assert.equal(bridge.waiters.length,0);assert.equal(views.length,count);assert.equal(bridge.view().state,'closed');assert.deepEqual(bridge.view().data,[]);
});

test('same-repo pane changes preserve data and a late config read cannot restore an older selection',async t=>{
  const f=await fixture(t),a=request(f.api(),'/repos/a'),b=request(f.api('other'),'/repos/b'),config=configFor([a,b]);await f.save(config);const bridge=new JiraDataBridge(f.io);t.after(()=>bridge.close());await bridge.synchronize({...resolved(a),paneId:'pane-a',cwd:'/repos/a'});await bridge.refresh();const calls=f.calls.length;await bridge.synchronize({...resolved(a),paneId:'pane-b',cwd:'/repos/a/subfolder'});assert.equal(bridge.view().data.length,1);await bridge.refresh();assert.equal(f.calls.length,calls);
  let release;const oldRead=new Promise(resolve=>release=resolve),io={...f.io,readTextFile:()=>oldRead},other=new JiraDataBridge(io);t.after(()=>other.close());const pending=other.synchronize(resolved(a));other.selectConfig(config,resolved(b));release(JSON.stringify(config));await pending;assert.equal(other.view().bindings[0].binding.repoRoot,'/repos/b');
  other.selectConfig(config,{state:'resolved',repoRoot:'/repos/a'});await other.refresh();assert.equal(other.view().data.length,0);assert.equal(other.view().errors[0].error.code,'INVALID_SCOPE');assert.equal(f.calls.length,calls);
});

test('an invalid binding is isolated in All spaces and malformed settings never overwrite the file',async t=>{
  const f=await fixture(t),good=request(f.api()),bad=request({...f.cli(),execution:{...f.cli().execution,machine:'server'}},'/srv/bad','server'),config=configFor([good,bad]);await f.save(config);const bridge=new JiraDataBridge(f.io);t.after(()=>bridge.close());await bridge.synchronize(null,{all:true});await bridge.refresh();assert.equal(bridge.view().data.length,1);assert.equal(bridge.view().state,'partial');assert.equal(bridge.view().errors[0].error.code,'UNSUPPORTED_INTEGRATION_HOST');assert.equal(f.calls.length,1);
  const invalid='{"v":1,"PRIVATE":"broken"';await fs.writeFile(f.file,invalid);await bridge.synchronize(null,{all:true});assert.equal(bridge.view().data.length,0);assert.equal(bridge.view().state,'error');assert.doesNotMatch(JSON.stringify(bridge.view()),/PRIVATE/);assert.equal(await fs.readFile(f.file,'utf8'),invalid);
});

test('load-more accumulation enforces the final native snapshot byte limit',async t=>{
  const f=await fixture(t),input=request(f.api());f.state.many=true;const io={...f.io,exec:async(_command,args)=>({code:0,stdout:JSON.stringify(await dispatchJira(JSON.parse(args[1]),{env:f.env,api:{ca:f.ca,maxPages:1}})),stderr:''})},bridge=new JiraDataBridge(io);t.after(()=>bridge.close());bridge.selectConfig(configFor([input]),resolved(input));await bridge.refresh();assert.equal(bridge.view().data.length,50);
  for(let i=0;i<3;i++)await bridge.refresh({loadMore:true});const snapshot=bridge.view().bindings[0].snapshot;assert.ok(snapshot.data.length>100&&snapshot.data.length<200);assert.equal(snapshot.truncated,true);assert.equal(snapshot.cursor,undefined);assert.equal(snapshot.error.code,'RESPONSE_TOO_LARGE');assert.ok(Buffer.byteLength(JSON.stringify(snapshot))<8*1024*1024);
});

// Herdr ends an overrunning continuation without catch/finally; its ticket must not show Loading for ever.
test('a load the host ended mid-flight is reloaded and an expired helper slot or job never blocks the next read',async t=>{
  const f=await fixture(t),input=request(f.api());await f.save(configFor([input]));let now=Date.now();const bridge=new JiraDataBridge(f.io,{clock:()=>now});t.after(()=>bridge.close());await bridge.synchronize(resolved(input));
  const entry=[...bridge.entries.values()][0];assert.ok(entry.cache.begin());bridge.publish();assert.equal(bridge.view().state,'loading');assert.equal(bridge.hasAbandonedLoad(),true);
  await bridge.recoverAbandoned();assert.equal(bridge.view().data.length,1);assert.equal(bridge.hasAbandonedLoad(),false);
  f.state.hold=true;const stuck=bridge.refresh({force:true});await waitFor(()=>f.held.length===1);assert.equal(bridge.hasAbandonedLoad(),false,'A live helper read inside every deadline is not abandoned');now+=STALE_LOAD_MS;assert.equal(bridge.hasAbandonedLoad(),true);
  const reload=bridge.recoverAbandoned();await waitFor(()=>f.held.length===2);f.state.hold=false;f.release();await Promise.all([stuck,reload]);assert.equal(bridge.view().data.length,1);assert.equal(bridge.hasAbandonedLoad(),false);
});
