import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import {execFileSync} from 'node:child_process';
import {publicTrackerError,requestJson} from '../src/shared/tracker-transport.mjs';
import {fetchJiraIssues,probeJiraApi,adfPlainText,jiraQuery} from '../src/mods/mission-control-jira/api.mjs';

const CLOUD='11111111-2222-3333-4444-555555555555',OTHER='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',NOW=1800000000000;
const connection=(site='https://work.atlassian.net')=>({id:'work',kind:'api',site,auth:{kind:'basic',usernameEnv:'JIRA_USER',tokenEnv:'JIRA_TOKEN'}});
const request=(c=connection())=>({v:1,operation:'issues',connection:c,binding:{machine:'server',repoRoot:'/srv/client-portal',jira:{connectionId:c.id,project:'WEB'}}});
const env={JIRA_USER:'fixture@example.invalid',JIRA_TOKEN:'fixture-personal',OAUTH_TOKEN:'fixture-oauth'};
const row=(n,category='new')=>({id:String(10000+n),key:'WEB-'+n,self:'https://untrusted.invalid/issues/'+n,fields:{summary:'Fix issue '+n,description:{type:'doc',version:1,content:[{type:'paragraph',content:[{type:'text',text:'Source task data.'}]}]},status:{name:{new:'To do',indeterminate:'Developing',done:'Resolved'}[category]||'Mystery',statusCategory:{key:category}},priority:{name:'High'},updated:'2026-10-30T10:00:00.000+0000'}});
const json=(res,value,status=200,headers={})=>{res.writeHead(status,{'content-type':'application/json',...headers});res.end(JSON.stringify(value));};
async function fixture(t,handler){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mc-jira-api-')),key=path.join(dir,'key.pem'),cert=path.join(dir,'cert.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
  const ca=await fs.readFile(cert),requests=[];
  const server=https.createServer({key:await fs.readFile(key),cert:ca},(req,res)=>{requests.push({url:req.url,authorization:req.headers.authorization});handler(req,res);});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(dir,{recursive:true,force:true});});
  const origin='https://127.0.0.1:'+server.address().port;
  return {origin,requests,options:{env,ca,clock:()=>NOW},
    routed(log){return async(input,options)=>{const url=new URL(input);log.push({url:url.href,allowedOrigin:options.allowedOrigin,authorization:options.headers.authorization});assert.equal(options.allowedOrigin,url.origin);assert.equal(url.origin,'https://api.atlassian.com');return requestJson(origin+url.pathname+url.search,{...options,allowedOrigin:origin,ca});};}};
}

test('classic Basic reads enhanced JQL pages with all source statuses, stable IDs and canonical links',async t=>{
  let site;const server=await fixture(t,(req,res)=>{
    const url=new URL(req.url,'https://fixture.invalid');if(url.pathname.endsWith('/serverInfo'))return json(res,{baseUrl:site,displayUrl:'https://custom.example.net'});
    assert.equal(url.pathname,'/rest/api/3/search/jql');assert.equal(url.searchParams.get('jql'),'project = "WEB" ORDER BY updated DESC');assert.equal(url.searchParams.get('maxResults'),'50');assert.match(url.searchParams.get('fields'),/description,status,priority/);
    return url.searchParams.get('nextPageToken')==='page-two'?json(res,{issues:[row(143,'indeterminate'),row(144,'done')],isLast:true}):json(res,{issues:[row(142)],isLast:false,nextPageToken:'page-two'});
  });site=server.origin;
  const result=await fetchJiraIssues(request(connection(site)),server.options);
  assert.deepEqual(result.data.map(v=>v.statusGroup),['todo','inProgress','done']);assert.equal(result.truncated,false);assert.equal(result.data[0].url,site+'/browse/WEB-142');assert.equal(result.data[0].identity.id,'10142');assert.equal(result.data[0].body,'Source task data.');assert.equal(result.data[0].repoBinding.machine,'server');assert.equal(result.fetchedAt,NOW);
  assert.ok(server.requests.every(r=>r.authorization==='Basic '+Buffer.from('fixture@example.invalid:fixture-personal').toString('base64')));
});

test('explicit cloudId Basic and Bearer use only the official gateway and verify canonical baseUrl',async t=>{
  const site='https://work.atlassian.net',log=[];const server=await fixture(t,(req,res)=>{
    assert.ok(req.url.startsWith('/ex/jira/'+CLOUD+'/rest/api/3/'));
    return req.url.endsWith('/serverInfo')?json(res,{baseUrl:site,displayUrl:'https://jira.custom.invalid'}):json(res,{issues:[row(142)],nextPageToken:null});
  });
  for(const auth of [connection().auth,{kind:'bearer',tokenEnv:'OAUTH_TOKEN'}]){
    const c={...connection(site),cloudId:CLOUD,auth};const result=await fetchJiraIssues(request(c),{...server.options,request:server.routed(log)});assert.equal(result.data[0].url,site+'/browse/WEB-142');assert.equal(result.truncated,false);
  }
  assert.equal(log.length,4);assert.ok(log.every(v=>v.url.startsWith('https://api.atlassian.com/ex/jira/'+CLOUD+'/')));assert.equal(log[2].authorization,'Bearer fixture-oauth');
});

test('OAuth discovers the exact Jira tenant, deduplicates container IDs and ignores other sites',async t=>{
  const site='https://work.atlassian.net',log=[];const server=await fixture(t,(req,res)=>{
    if(req.url==='/oauth/token/accessible-resources')return json(res,[{id:OTHER,url:'https://another.atlassian.net',scopes:['read:jira-work']},{id:OTHER,url:site,scopes:['read:confluence-content.all']},{id:CLOUD,url:site,scopes:['read:jira-work']},{id:CLOUD,url:site+'/',scopes:['read:issue-details:jira']}]);
    assert.ok(req.url.startsWith('/ex/jira/'+CLOUD+'/'));
    return req.url.endsWith('/serverInfo')?json(res,{baseUrl:site}):json(res,{issues:[row(144,'done')],isLast:true});
  });
  const c={...connection(site),auth:{kind:'bearer',tokenEnv:'OAUTH_TOKEN'}},result=await fetchJiraIssues(request(c),{...server.options,request:server.routed(log)});
  assert.equal(result.data[0].statusGroup,'done');assert.equal(log.length,3);assert.ok(log.every(v=>v.authorization==='Bearer fixture-oauth'));assert.equal(log[0].url,'https://api.atlassian.com/oauth/token/accessible-resources');
});

test('ambiguous or missing OAuth tenant scope cannot fetch any site issues',async t=>{
  let resources=[];const log=[],server=await fixture(t,(_req,res)=>json(res,resources)),c={...connection(),auth:{kind:'bearer',tokenEnv:'OAUTH_TOKEN'}};
  for(const value of [[],[{id:CLOUD,url:c.site,scopes:['read:confluence-content.all']}],[{id:CLOUD,url:c.site,scopes:['read:jira-work']},{id:OTHER,url:c.site,scopes:['read:jira-work']}]]){
    resources=value;await assert.rejects(fetchJiraIssues(request(c),{...server.options,request:server.routed(log)}),e=>e.code==='INVALID_SCOPE');
  }
  assert.equal(log.length,3);assert.ok(log.every(v=>v.url.endsWith('/oauth/token/accessible-resources')));
});

test('selected-route setup probe rejects custom displayUrl or wrong cloudId before issue reads',async t=>{
  const canonical='https://canonical.atlassian.net',display='https://jira.custom.invalid',log=[];const server=await fixture(t,(req,res)=>{assert.ok(req.url.endsWith('/serverInfo'));json(res,{baseUrl:canonical,displayUrl:display});});
  for(const site of [canonical,display]){
    const input={...request({...connection(site),cloudId:CLOUD}),operation:'probe',binding:{machine:'server',repoRoot:'/srv/client-portal'}},options={...server.options,request:server.routed(log)};
    if(site===canonical)assert.deepEqual(await probeJiraApi(input,options),{site:canonical,cloudId:CLOUD,route:'gateway'});
    else await assert.rejects(probeJiraApi(input,options),e=>e.code==='CANONICAL_SITE_REQUIRED'&&/canonical.*base URL/.test(e.message));
  }
  await assert.rejects(fetchJiraIssues(request({...connection('https://wrong.atlassian.net'),cloudId:CLOUD}),{...server.options,request:server.routed(log)}),e=>e.code==='CANONICAL_SITE_REQUIRED');
  assert.equal(log.length,3);
});

test('bounded page chunks expose continuation and reject account/query/cloudId/expired cursors',async t=>{
  let site;const server=await fixture(t,(req,res)=>{
    if(req.url.endsWith('/serverInfo'))return json(res,{baseUrl:site});const token=new URL(req.url,'https://fixture.invalid').searchParams.get('nextPageToken');
    json(res,token?{issues:[row(143,'done')],isLast:true}:{issues:[row(142)],nextPageToken:'page-two'});
  });site=server.origin;const input=request(connection(site)),first=await fetchJiraIssues(input,{...server.options,maxPages:1});
  assert.equal(first.truncated,true);assert.ok(first.cursor);const next=await fetchJiraIssues({...input,cursor:first.cursor},server.options);assert.equal(next.truncated,false);assert.deepEqual(next.data.map(v=>v.key),['WEB-143']);
  const count=server.requests.length;
  for(const change of [{connection:{...input.connection,auth:{...input.connection.auth,tokenEnv:'OTHER_TOKEN'}}},{connection:{...input.connection,cloudId:CLOUD}},{binding:{...input.binding,jira:{connectionId:'work',project:'OPS'}}}])await assert.rejects(fetchJiraIssues({...input,...change,cursor:first.cursor},server.options),e=>e.code==='INVALID_SCOPE');
  await assert.rejects(fetchJiraIssues({...input,cursor:first.cursor},{...server.options,clock:()=>NOW+7*86400000}),e=>e.code==='INVALID_SCOPE');assert.equal(server.requests.length,count);
});

test('contradictory/repeated pagination fails and missing completeness or warnings stays explicitly truncated',async t=>{
  let site,response;const server=await fixture(t,(req,res)=>req.url.endsWith('/serverInfo')?json(res,{baseUrl:site}):json(res,response));site=server.origin;const input=request(connection(site));
  for(const value of [{issues:[],isLast:false},{issues:[],isLast:true,nextPageToken:'more'},{issues:[],isLast:'yes'},{issues:null,isLast:true}]){response=value;await assert.rejects(fetchJiraIssues(input,server.options),e=>e.code==='INVALID_RESPONSE');}
  response={issues:[row(142)],nextPageToken:'repeat'};await assert.rejects(fetchJiraIssues(input,server.options),e=>e.code==='INVALID_SCOPE');
  for(const value of [{issues:[row(142)]},{issues:[row(142)],isLast:true,warnings:[{untrusted:'PRIVATE upstream token'}]}]){response=value;const result=await fetchJiraIssues(input,server.options);assert.equal(result.truncated,true);assert.equal(result.error.code,'INCOMPLETE_RESULTS');assert.equal(result.cursor,undefined);assert.doesNotMatch(JSON.stringify(result),/PRIVATE/);}
});

test('cumulative count and output-byte caps remain explicit instead of claiming a complete board',async t=>{
  let site,large=false;const server=await fixture(t,(req,res)=>{
    if(req.url.endsWith('/serverInfo'))return json(res,{baseUrl:site});
    const page=Number(new URL(req.url,'https://fixture.invalid').searchParams.get('nextPageToken')||0),issues=Array.from({length:50},(_,i)=>row(page*50+i+1,i%3===0?'done':'new'));
    if(large)for(const issue of issues)issue.fields.description='x'.repeat(48000);
    json(res,{issues,nextPageToken:String(page+1),isLast:false});
  });site=server.origin;const input=request(connection(site)),capped=await fetchJiraIssues(input,{...server.options,maxPages:20});
  assert.equal(capped.data.length,1000);assert.equal(capped.truncated,true);assert.equal(capped.cursor,undefined);assert.ok(capped.data.some(v=>v.statusGroup==='done'));
  large=true;const bounded=await fetchJiraIssues(input,{...server.options,maxPages:20});assert.equal(bounded.truncated,true);assert.equal(bounded.error.code,'RESPONSE_TOO_LARGE');assert.equal(bounded.cursor,undefined);assert.ok(bounded.data.length>0&&bounded.data.length<1000);assert.ok(Buffer.byteLength(JSON.stringify(bounded))<8*1024*1024);
});

test('a discovered route change cannot reuse a cursor for the previous cloud instance',async t=>{
  let cloudId=CLOUD;const site='https://work.atlassian.net',log=[],server=await fixture(t,(req,res)=>{
    if(req.url==='/oauth/token/accessible-resources')return json(res,[{id:cloudId,url:site,scopes:['read:jira-work']}]);
    if(req.url.endsWith('/serverInfo'))return json(res,{baseUrl:site});json(res,{issues:[row(142)],nextPageToken:'continue'});
  });
  const input=request({...connection(site),auth:{kind:'bearer',tokenEnv:'OAUTH_TOKEN'}}),options={...server.options,request:server.routed(log)},first=await fetchJiraIssues(input,{...options,maxPages:1});cloudId=OTHER;
  const before=log.length;await assert.rejects(fetchJiraIssues({...input,cursor:first.cursor},options),e=>e.code==='INVALID_SCOPE');assert.equal(log.length-before,2);assert.ok(log.slice(before).every(v=>!v.url.includes('/search/jql')));
});

test('full JQL is preserved verbatim as data and project-only expressions escape quoted values',()=>{
  const b=request().binding;b.jira.jql='project in (WEB, OPS) AND status != Closed ORDER BY priority DESC';assert.equal(jiraQuery(b),b.jira.jql);
  assert.equal(jiraQuery({jira:{project:'WEB" OR project = "OPS'}}),'project = "WEB\\" OR project = \\"OPS" ORDER BY updated DESC');
});

test('ADF preserves readable ordered text, links and lists while bounding controls, media and depth',()=>{
  const doc={version:1,type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Open docs',marks:[{type:'link',attrs:{href:'https://docs.example.invalid/a'}}]},{type:'hardBreak'},{type:'mention',attrs:{text:'@Ciprian'}},{type:'text',text:'\x1b[2J'}]},{type:'bulletList',content:[{type:'listItem',content:[{type:'paragraph',content:[{type:'text',text:'One'}]}]}]},{type:'media',attrs:{url:'https://never-fetched.invalid'}}]};
  const result=adfPlainText(doc);assert.match(result,/Open docs \(https:\/\/docs.example.invalid\/a\)/);assert.match(result,/@Ciprian\\u001b\[2J/);assert.match(result,/- One/);assert.match(result,/Unsupported Jira content/);assert.doesNotMatch(result,/never-fetched/);
  assert.match(adfPlainText('🙂'.repeat(20000)),/Jira description truncated/);assert.ok(Buffer.byteLength(adfPlainText('🙂'.repeat(20000)))<49000);assert.equal(adfPlainText(null),'');
  let deep={type:'text',text:'nested'};for(let n=0;n<33;n++)deep={type:'paragraph',content:[deep]};assert.throws(()=>adfPlainText({type:'doc',version:1,content:[deep]}),e=>e.code==='RESPONSE_TOO_LARGE');assert.throws(()=>adfPlainText({type:'doc',version:2,content:[]}),e=>e.code==='INVALID_RESPONSE');
});

test('auth/rate-limit/timeout errors remain safe and unknown source categories never become To do',async t=>{
  let site,mode='auth';const server=await fixture(t,(req,res)=>{
    if(req.url.endsWith('/serverInfo'))return json(res,{baseUrl:site});
    if(mode==='auth')return json(res,{error:'PRIVATE fixture-personal'},401);
    if(mode==='rate')return json(res,{error:'PRIVATE fixture-personal'},429,{'retry-after':'2'});
    if(mode==='slow')return setTimeout(()=>{if(!res.destroyed)json(res,{issues:[],isLast:true});},100);
    json(res,{issues:[row(142,mode)],isLast:true});
  });site=server.origin;const input=request(connection(site));
  for(const [kind,code]of [['auth','AUTH_REQUIRED'],['rate','RATE_LIMITED'],['slow','REQUEST_TIMEOUT'],['unknown','STATUS_MAPPING_REQUIRED'],['constructor','STATUS_MAPPING_REQUIRED']]){
    mode=kind;await assert.rejects(fetchJiraIssues(input,{...server.options,...(kind==='slow'?{timeoutMs:30}:{})}),e=>{assert.equal(e.code,code);const safe=publicTrackerError(e);assert.doesNotMatch(JSON.stringify(safe),/PRIVATE|fixture-personal/);if(kind==='rate')assert.equal(safe.retryAfterMs,2000);return true;});
  }
});
