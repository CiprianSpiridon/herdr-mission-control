import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import {execFileSync} from 'node:child_process';
import {TrackerError,publicTrackerError,validateJiraConnection,validateTrackerRequest,credentialHeaders,apiHeaders,requestJson} from '../src/shared/tracker-transport.mjs';

const connection=(id='work',site='https://example.atlassian.net')=>({id,kind:'api',site,auth:{kind:'basic',usernameEnv:'JIRA_USER',tokenEnv:'JIRA_TOKEN'}});
const mapping={issuesPath:'issues',nextCursorPath:'next',fields:{id:'id',key:'key',title:'summary',status:'status'},statusGroups:{todo:['To Do'],inProgress:['In Progress'],done:['Done']}};
const envelope=c=>({v:1,operation:'issues',connection:c,binding:{machine:'server',repoRoot:'/srv/repo',jira:{connectionId:c.id,project:'WEB'}}});
async function fixture(t,handler){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'mc-tracker-tls-')),key=directory+'/key.pem',cert=directory+'/cert.pem';
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1','-keyout',key,'-out',cert],{stdio:'ignore'});
  const ca=await fs.readFile(cert),requests=[];
  const server=https.createServer({key:await fs.readFile(key),cert:ca},(req,res)=>{requests.push({url:req.url,authorization:req.headers.authorization});handler(req,res);});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(directory,{recursive:true,force:true});});
  const origin='https://127.0.0.1:'+server.address().port;
  return {origin,requests,options:{allowedOrigin:origin,ca}};
}
const json=(res,value)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(value));};

test('pinned connection union and request scope reject unsafe shapes before any adapter runs',()=>{
  const api=connection(),cli={id:'cli',kind:'cli',site:api.site,execution:{machine:null,command:'jira',argsTemplate:['issues','{{jql}}']},mapping},stdio={id:'mcp',kind:'mcp-stdio',site:api.site,execution:{machine:null,command:'node',args:['bridge.mjs'],envRefs:{JIRA_API_TOKEN:'WORK_JIRA_TOKEN'}},search:{tool:'search_issues',argsTemplate:{query:'{{jql}}'},resultMapping:mapping}},http={id:'http',kind:'mcp-http',site:api.site,url:'https://mcp.example.net/jira',auth:{kind:'bearer',tokenEnv:'MCP_TOKEN'},search:stdio.search};
  for(const c of [api,cli,stdio,http,{...api,cloudId:'11111111-2222-3333-4444-555555555555'},{...http,auth:{kind:'basic',usernameEnv:'A',tokenEnv:'B'}}]){assert.equal(validateJiraConnection(c).kind,c.kind);const r=validateTrackerRequest(envelope(c));assert.equal(r.binding.machine,'server');if(c.execution)assert.equal(r.connection.execution.machine,null);}
  for(const c of [{...api,auth:{kind:'bearer',token:'PRIVATE'}},{...api,site:'http://example.net'},{...api,site:'https://user:PRIVATE@example.net'},{...api,extra:true},{...http,auth:{kind:'basic',usernameEnv:'A',token:'PRIVATE'}},...[null,'','../another','not-a-cloud-id',42].map(cloudId=>({...api,cloudId}))])assert.throws(()=>validateJiraConnection(c),TrackerError);
  for(const key of ['access_token','apiKey','token','password'])assert.throws(()=>validateJiraConnection({...http,url:'https://mcp.example.net/jira?'+key+'=PRIVATE'}),e=>e.code==='INVALID_CONNECTION');
  assert.throws(()=>validateJiraConnection({...cli,execution:{...cli.execution,machine:'server'}}),e=>e.code==='UNSUPPORTED_INTEGRATION_HOST');
  for(const change of [{operation:'mutate'},{operation:'pulls'},{binding:{machine:null,repoRoot:'relative',jira:{connectionId:'work',project:'WEB'}}},{binding:{machine:null,repoRoot:'/repo',jira:{connectionId:'another',project:'WEB'}}},{cursor:'.'.repeat(8193)},{unexpected:true}])assert.throws(()=>validateTrackerRequest({...envelope(api),...change}),TrackerError);
  assert.throws(()=>validateTrackerRequest({...envelope(api),binding:{repoRoot:'/repo',jira:{connectionId:'work',project:'WEB'}}}),TrackerError);
  assert.equal(validateTrackerRequest({...envelope(api),operation:'probe',binding:{machine:null,repoRoot:'/repo'}}).operation,'probe');
});
test('MCP Basic and Bearer credentials use the same private resolver and never cross endpoint origins',async t=>{
  const endpoint=await fixture(t,(_req,res)=>json(res,{ok:true})),sink=await fixture(t,(_req,res)=>json(res,{unexpected:true})),env={MCP_USER:'fixture@example.invalid',MCP_TOKEN:'fixture-personal',SERVICE_TOKEN:'fixture-service'};
  for(const spec of [{kind:'basic',usernameEnv:'MCP_USER',tokenEnv:'MCP_TOKEN'},{kind:'bearer',tokenEnv:'SERVICE_TOKEN'}]){
    const headers=credentialHeaders(spec,env);assert.deepEqual(await requestJson(endpoint.origin+'/mcp',{...endpoint.options,headers}),{ok:true});
    await assert.rejects(requestJson(sink.origin+'/capture',{...endpoint.options,headers}),e=>e.code==='UNTRUSTED_ORIGIN');
  }
  assert.deepEqual(endpoint.requests.map(r=>r.authorization),['Basic '+Buffer.from('fixture@example.invalid:fixture-personal').toString('base64'),'Bearer fixture-service']);assert.equal(sink.requests.length,0);
  assert.throws(()=>credentialHeaders({kind:'basic',usernameEnv:'MCP_USER',tokenEnv:'MCP_TOKEN'},{...env,MCP_USER:'bad:user'}),e=>e.code==='AUTH_REQUIRED');
  assert.throws(()=>credentialHeaders({kind:'bearer',token:'literal-value'},env),e=>e.code==='INVALID_CONNECTION');
});
test('two simultaneous profiles resolve credentials in memory without switching process or CLI auth',async t=>{
  const server=await fixture(t,(req,res)=>json(res,{profile:req.url.slice(1)})),a={...connection('work',server.origin),auth:{kind:'basic',usernameEnv:'A_USER',tokenEnv:'A_TOKEN'}},b={...connection('personal',server.origin),auth:{kind:'bearer',tokenEnv:'B_TOKEN'}},env={A_USER:'fixture@example.invalid',A_TOKEN:'fixture-a',B_TOKEN:'fixture-b'},before={...env};
  const results=await Promise.all([requestJson(server.origin+'/work',{...server.options,headers:apiHeaders(a,env)}),requestJson(server.origin+'/personal',{...server.options,headers:apiHeaders(b,env)})]);
  assert.deepEqual(results,[{profile:'work'},{profile:'personal'}]);assert.deepEqual(env,before);assert.equal(server.requests.find(r=>r.url==='/work').authorization,'Basic '+Buffer.from('fixture@example.invalid:fixture-a').toString('base64'));assert.equal(server.requests.find(r=>r.url==='/personal').authorization,'Bearer fixture-b');
  assert.throws(()=>apiHeaders(a,{}),e=>e.code==='AUTH_REQUIRED');assert.throws(()=>apiHeaders(a,{...env,A_TOKEN:'bad\r\nheader'}),e=>e.code==='AUTH_REQUIRED');
});
test('a redirect cannot send authentication to another origin or downgrade HTTPS',async t=>{
  const sink=await fixture(t,(_req,res)=>json(res,{unexpected:true})),source=await fixture(t,(req,res)=>{res.writeHead(302,{location:req.url==='/downgrade'?'http://127.0.0.1/':sink.origin+'/capture'});res.end();});
  for(const route of ['/redirect','/downgrade'])await assert.rejects(requestJson(source.origin+route,{...source.options,headers:{authorization:'Bearer fixture-secret'}}),e=>e.code==='UNTRUSTED_ORIGIN');
  assert.equal(sink.requests.length,0);assert.equal(source.requests.length,2);
  await assert.rejects(requestJson(sink.origin+'/direct',{...source.options,headers:{authorization:'Bearer fixture-secret'}}),e=>e.code==='UNTRUSTED_ORIGIN');assert.equal(sink.requests.length,0);
});
test('same-origin redirects are bounded and POST never silently changes into a GET',async t=>{
  const server=await fixture(t,(req,res)=>{if(req.url==='/ok')return json(res,{read:true});res.writeHead(302,{location:req.url==='/start'?'/ok':'/loop'});res.end();});
  assert.deepEqual(await requestJson(server.origin+'/start',server.options),{read:true});
  await assert.rejects(requestJson(server.origin+'/loop',server.options),e=>e.code==='UNTRUSTED_ORIGIN');
  await assert.rejects(requestJson(server.origin+'/start',{...server.options,method:'POST',body:{query:'query { viewer { login } }'}}),e=>e.code==='UNTRUSTED_ORIGIN');
});
test('HTTP failures retain safe status and retry metadata without upstream error text or credentials',async t=>{
  const server=await fixture(t,(req,res)=>{res.writeHead(Number(req.url.slice(1)),{'retry-after':'2'});res.end('PRIVATE_PROVIDER_TOKEN fixture-secret /private/auth.json');});
  for(const [status,code]of [[401,'AUTH_REQUIRED'],[403,'PERMISSION_DENIED'],[404,'NOT_FOUND'],[429,'RATE_LIMITED'],[503,'UPSTREAM_UNAVAILABLE']]){
    await assert.rejects(requestJson(server.origin+'/'+status,server.options),error=>{const value=publicTrackerError(error);assert.equal(value.code,code);assert.equal(value.status,status);assert.equal(value.retryAfterMs,2000);assert.doesNotMatch(JSON.stringify(value),/PRIVATE|fixture-secret|auth\.json/);return true;});
  }
  assert.doesNotMatch(JSON.stringify(publicTrackerError(Error('PRIVATE_PROVIDER_TOKEN'))),/PRIVATE/);assert.equal(publicTrackerError(new TrackerError('PRIVATE_PROVIDER_TOKEN')).code,'REQUEST_FAILED');
});
test('opt-in HTTP metadata preserves bounded pagination headers and can refuse all redirects',async t=>{
  let origin;
  const server=await fixture(t,(req,res)=>{
    if(req.url==='/redirect'){res.writeHead(302,{location:'/page'});res.end();return;}
    res.setHeader('link',req.url==='/huge'?'x'.repeat(8193):'<'+origin+'/page?page=2>; rel="next"');res.setHeader('x-ratelimit-remaining','42');res.setHeader('set-cookie','PRIVATE_SESSION');res.setHeader('authorization','PRIVATE_TOKEN');json(res,{items:[]});
  });origin=server.origin;
  const value=await requestJson(origin+'/page',{...server.options,metadata:true,maxRedirects:0});
  assert.deepEqual(value,{data:{items:[]},status:200,url:origin+'/page',headers:{link:'<'+origin+'/page?page=2>; rel="next"','x-ratelimit-remaining':'42'}});
  assert.doesNotMatch(JSON.stringify(value),/PRIVATE/);assert.deepEqual(await requestJson(origin+'/page',server.options),{items:[]});
  const before=server.requests.length;await assert.rejects(requestJson(origin+'/redirect',{...server.options,metadata:true,maxRedirects:0}),e=>e.code==='UNTRUSTED_ORIGIN');assert.equal(server.requests.length,before+1);
  await assert.rejects(requestJson(origin+'/huge',{...server.options,metadata:true}),e=>e.code==='RESPONSE_TOO_LARGE');
});
test('an explicit exhausted GitHub rate budget remains distinct from ordinary permission denial',async t=>{
  const reset=Math.ceil(Date.now()/1000)+2,server=await fixture(t,(_req,res)=>{res.writeHead(403,{'x-ratelimit-remaining':'0','x-ratelimit-reset':String(reset)});res.end('PRIVATE rate body');});
  await assert.rejects(requestJson(server.origin+'/limited',server.options),e=>{assert.equal(e.code,'RATE_LIMITED');assert.equal(e.status,403);assert.ok(e.retryAfterMs>=0&&e.retryAfterMs<=3000);assert.doesNotMatch(JSON.stringify(publicTrackerError(e)),/PRIVATE/);return true;});
});
test('bounded JSON reads reject malformed UTF-8, huge bodies, timeout and cancellation',async t=>{
  let entered;const received=new Promise(resolve=>entered=resolve);
  const server=await fixture(t,(req,res)=>{
    if(req.url==='/invalid')return res.end('not JSON');if(req.url==='/utf8')return res.end(Buffer.from([0xff]));
    if(req.url==='/declared'){res.writeHead(200,{'content-length':'100000'});return res.end('x');}
    if(req.url==='/chunked'){res.write('[');res.write(' '.repeat(200));return res.end(']');}
    entered();setTimeout(()=>{if(!res.destroyed)json(res,{late:true});},150);
  });
  for(const route of ['/invalid','/utf8'])await assert.rejects(requestJson(server.origin+route,server.options),e=>e.code==='INVALID_RESPONSE');
  for(const route of ['/declared','/chunked'])await assert.rejects(requestJson(server.origin+route,{...server.options,maxBytes:100}),e=>e.code==='RESPONSE_TOO_LARGE');
  const controller=new AbortController(),pending=requestJson(server.origin+'/abort',{...server.options,signal:controller.signal});await received;controller.abort();await assert.rejects(pending,e=>e.code==='REQUEST_CANCELLED');
  await assert.rejects(requestJson(server.origin+'/timeout',{...server.options,timeoutMs:30}),e=>e.code==='REQUEST_TIMEOUT');
  const count=server.requests.length;await assert.rejects(requestJson(server.origin+'/bad-header',{...server.options,headers:{authorization:'bad\r\nheader'}}),e=>e.code==='INVALID_REQUEST');assert.equal(server.requests.length,count);
});
