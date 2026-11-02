import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import {execFileSync} from 'node:child_process';
import {fetchGithubIssues,probeGithubApi,githubProgressHint} from '../src/mods/mission-control-github/issues.mjs';
import {publicTrackerError} from '../src/shared/tracker-transport.mjs';

const NOW=1800000000000;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const mapping=()=>({project:{owner:'work',number:7,fieldId:'PVTSSF_status',options:{todo:['opt-todo'],inProgress:['opt-work'],done:['opt-done']},unmapped:'error'}});
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mc-github-issues-')),key=path.join(root,'key.pem'),cert=path.join(root,'cert.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1','-keyout',key,'-out',cert],{stdio:'ignore'});
  const ca=await fs.readFile(cert),requests=[],index=new Map(),state={pages:new Map(),repositoryId:900,hasIssues:true,links:true,customLink:null,http:null,graph:null,graphDelay:0,activeGraph:0,peakGraph:0,slowIssues:0,issueEntered:null};let origin;
  const row=(n,{closed=false,pr=false,labels=[],body='Task data.',...extra}={})=>({id:10000+n,node_id:'I_'+n,number:n,state:closed?'closed':'open',title:'Fix issue '+n,body,updated_at:'2026-10-30T10:00:00Z',labels,
    url:origin+'/api/v3/repos/acme/client-portal/issues/'+n,repository_url:origin+'/api/v3/repos/acme/client-portal',html_url:origin+'/acme/client-portal/issues/'+n,...(pr?{pull_request:{url:origin+'/api/v3/repos/acme/client-portal/pulls/'+n}}:{}),...extra});
  const node=raw=>({__typename:'Issue',id:raw.node_id,number:raw.number,state:raw.state.toUpperCase(),repository:{name:'client-portal',owner:{login:'acme'}},projectItems:{nodes:[{id:'PVTI_'+raw.number,project:{id:'P_work',number:7,owner:{login:'work'}},fieldValues:{nodes:[{__typename:'ProjectV2ItemFieldSingleSelectValue',id:'PVTV_'+raw.number,name:'Localized active state',optionId:'opt-work',field:{id:'PVTSSF_status'}}],pageInfo:{hasNextPage:false}}}],pageInfo:{hasNextPage:false}}});
  const server=https.createServer({key:await fs.readFile(key),cert:ca},async(req,res)=>{
    const url=new URL(req.url,origin);let body;const chunks=[];for await(const chunk of req)chunks.push(chunk);if(chunks.length)body=JSON.parse(Buffer.concat(chunks));
    requests.push({method:req.method,path:url.pathname,query:Object.fromEntries(url.searchParams),body,authorization:req.headers.authorization});
    if(state.http){res.writeHead(state.http.status,state.http.headers||{});res.end('PRIVATE owned-token upstream error');return;}
    res.setHeader('content-type','application/json');
    if(url.pathname==='/api/v3/repos/acme/client-portal'){
      const repo={id:state.repositoryId,full_name:'acme/client-portal',name:'client-portal',owner:{login:'acme'},html_url:origin+'/acme/client-portal',has_issues:state.hasIssues,...state.repoOverride};res.end(JSON.stringify(repo));return;
    }
    if(url.pathname==='/api/v3/repos/acme/client-portal/issues'){
      state.issueEntered?.();if(state.slowIssues)await delay(state.slowIssues);if(res.destroyed)return;
      const page=Number(url.searchParams.get('page')),rows=state.generate?state.generate(page):state.pages.get(page)||[];for(const raw of rows)if(raw?.node_id)index.set(raw.node_id,raw);
      if(state.customLink!==null)res.setHeader('link',typeof state.customLink==='function'?state.customLink(url,page):state.customLink);
      else if(state.links&&(state.pages.has(page+1)||state.generate&&rows.length===50)){
        const next=new URL(origin+'/api/v3/repositories/'+state.repositoryId+'/issues');for(const [k,v]of url.searchParams)next.searchParams.set(k,v);next.searchParams.set('page',String(page+1));res.setHeader('link','<'+next.href+'>; rel="next"');
      }
      if(state.noContent){res.writeHead(204);res.end();return;}res.end(JSON.stringify(rows));return;
    }
    if(url.pathname==='/api/graphql'&&req.method==='POST'){
      state.activeGraph++;state.peakGraph=Math.max(state.peakGraph,state.activeGraph);try{
        if(state.graphDelay)await delay(state.graphDelay);if(res.destroyed)return;
        const ids=body.variables.ids,result=state.graph?state.graph(ids,{index,node}):{data:{nodes:ids.map(id=>node(index.get(id)))}};res.end(JSON.stringify(result));
      }finally{state.activeGraph--;}return;
    }
    res.writeHead(404);res.end('{}');
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});origin='https://127.0.0.1:'+server.address().port;
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(root,{recursive:true,force:true});});
  const connection={id:'work',kind:'github',site:origin,apiBase:origin+'/api/v3',credentialEnv:'GITHUB_WORK'},binding={machine:'server',repoRoot:'/srv/client-portal',github:{connectionId:'work',owner:'acme',repo:'client-portal'}};
  const input={v:1,operation:'issues',connection,binding},options={env:{GITHUB_WORK:'owned-token'},ca,clock:()=>NOW};return {origin,state,requests,row,node,input,options};
}

test('real REST pages include open/closed issues, exclude PR rows and retain stable source identity',async t=>{
  const f=await fixture(t);f.state.pages.set(1,[f.row(1),f.row(2,{pr:true}),f.row(3,{closed:true})]);f.state.pages.set(2,[f.row(4,{labels:['busy']})]);
  const result=await fetchGithubIssues(f.input,f.options);assert.deepEqual(result.data.map(issue=>issue.key),['GH-1','GH-3','GH-4']);assert.deepEqual(result.data.map(issue=>issue.statusGroup),['todo','done','todo']);assert.equal(result.truncated,false);
  assert.equal(result.data[0].identity.id,'10001');assert.equal(result.data[0].url,f.origin+'/acme/client-portal/issues/1');assert.equal(result.data[0].repoBinding.machine,'server');assert.equal(result.scope.connectionId,'work');assert.match(githubProgressHint(f.input.binding),/Configure.*In progress/);
  const lists=f.requests.filter(r=>r.path.endsWith('/issues'));assert.deepEqual(lists.map(r=>r.query.page),['1','2']);assert.ok(lists.every(r=>r.query.state==='all'&&r.query.per_page==='50'&&r.query.sort==='updated'&&r.query.direction==='desc'));assert.ok(f.requests.every(r=>r.authorization==='Bearer owned-token'));
  assert.ok(f.requests.every(r=>r.method==='GET'));assert.doesNotMatch(JSON.stringify(result),/owned-token/);
});

test('label mappings are explicit, case insensitive and ambiguous cross-group labels fail',async t=>{
  const f=await fixture(t);f.input.binding.github.status={labels:{todo:['Backlog'],inProgress:['Doing','Busy'],done:['Complete']}};
  f.state.pages.set(1,[f.row(1,{labels:[{name:'doing'},'BUSY']}),f.row(2,{labels:['Complete']}),f.row(3,{closed:true,labels:['Doing']}),f.row(4)]);
  const result=await fetchGithubIssues(f.input,f.options);assert.deepEqual(result.data.map(i=>i.statusGroup),['inProgress','done','done','todo']);assert.equal(result.data[0].statusName,'doing');assert.equal(githubProgressHint(f.input.binding),'');
  f.state.pages.set(1,[f.row(1,{labels:['Backlog','Doing']})]);await assert.rejects(fetchGithubIssues(f.input,f.options),e=>e.code==='STATUS_MAPPING_REQUIRED');
  const before=f.requests.length;f.input.binding.github.status.labels.todo=['DOING'];await assert.rejects(fetchGithubIssues(f.input,f.options),e=>e.code==='STATUS_MAPPING_REQUIRED');assert.equal(f.requests.length,before);
  f.input.binding.github.status={labels:{todo:[],inProgress:[],done:[]}};assert.match(githubProgressHint(f.input.binding),/Configure.*In progress/);
});

test('Projects matches the configured owner/project/field/option IDs, including archived membership',async t=>{
  const f=await fixture(t);f.input.binding.github.status=mapping();f.state.pages.set(1,[f.row(1),f.row(2,{closed:true})]);
  f.state.graph=(ids,{index,node})=>({data:{nodes:ids.map(id=>{const value=node(index.get(id));value.projectItems.nodes.unshift({project:{id:'P_other',number:7,owner:{login:'someone-else'}}});value.projectItems.nodes[1].isArchived=true;return value;})}});
  const result=await fetchGithubIssues(f.input,f.options);assert.deepEqual(result.data.map(i=>i.statusGroup),['inProgress','done']);assert.equal(result.data[0].statusName,'Localized active state');
  const graph=f.requests.find(r=>r.method==='POST');assert.deepEqual(graph.body.variables.ids,['I_1']);assert.match(graph.body.query,/includeArchived: true/);assert.match(graph.body.query,/ProjectV2SingleSelectField/);assert.doesNotMatch(graph.body.query,/fieldValueByName|mutation/);
});

test('unknown/duplicate Projects fields, missing permission and wrong repo cannot fabricate progress',async t=>{
  const f=await fixture(t);f.input.binding.github.status=mapping();f.state.pages.set(1,[f.row(1)]);
  const changes=[
    [n=>{n.projectItems.nodes[0].fieldValues.nodes[0].optionId='unknown';},'STATUS_MAPPING_REQUIRED'],
    [n=>{n.projectItems.nodes[0].fieldValues.nodes[0].field.id='another-field';},'STATUS_MAPPING_REQUIRED'],
    [n=>{n.projectItems.nodes[0].fieldValues.nodes.push(structuredClone(n.projectItems.nodes[0].fieldValues.nodes[0]));},'STATUS_MAPPING_REQUIRED'],
    [n=>{n.projectItems.nodes.push(structuredClone(n.projectItems.nodes[0]));},'STATUS_MAPPING_REQUIRED'],
    [n=>{n.projectItems.nodes[0].project.owner.login='other-owner';},'STATUS_MAPPING_REQUIRED'],
    [n=>{n.projectItems.pageInfo.hasNextPage=true;},'INCOMPLETE_RESULTS'],
    [n=>{n.projectItems.nodes[0].fieldValues.pageInfo.hasNextPage=true;},'INCOMPLETE_RESULTS'],
    [n=>{n.projectItems=null;},'PERMISSION_DENIED'],
    [n=>{n.repository.name='wrong-repo';},'INVALID_SCOPE'],
    [n=>{n.id='wrong-node';},'INVALID_SCOPE']
  ];
  for(const [change,code]of changes){f.state.graph=(ids,{index,node})=>({data:{nodes:ids.map(id=>{const n=node(index.get(id));change(n);return n;})}});await assert.rejects(fetchGithubIssues(f.input,f.options),e=>e.code===code);}
  f.state.graph=()=>({errors:[{type:'FORBIDDEN',message:'PRIVATE owned-token'}],data:{nodes:[]}});await assert.rejects(fetchGithubIssues(f.input,f.options),e=>{assert.equal(e.code,'PERMISSION_DENIED');assert.doesNotMatch(JSON.stringify(publicTrackerError(e)),/PRIVATE|owned-token/);return true;});
});

test('Projects enrichment batches visible open issues with at most four concurrent read requests',async t=>{
  const f=await fixture(t);f.input.binding.github.status=mapping();f.state.pages.set(1,Array.from({length:49},(_,i)=>f.row(i+1)));f.state.graphDelay=30;
  const result=await fetchGithubIssues(f.input,f.options);assert.equal(result.data.length,49);assert.equal(f.requests.filter(r=>r.method==='POST').length,5);assert.equal(f.state.peakGraph,4);assert.ok(result.data.every(i=>i.statusGroup==='inProgress'));
  assert.ok(f.requests.filter(r=>r.method==='POST').every(r=>r.body.variables.ids.length<=10));
});

test('a native helper can serialize Projects enrichment without changing issue results',async t=>{
  const f=await fixture(t);f.input.binding.github.status=mapping();f.state.pages.set(1,Array.from({length:49},(_,i)=>f.row(i+1)));f.state.graphDelay=30;
  const result=await fetchGithubIssues(f.input,{...f.options,concurrency:1});
  assert.equal(f.state.peakGraph,1);assert.equal(f.requests.filter(r=>r.method==='POST').length,5);
  assert.equal(result.data.length,49);assert.ok(result.data.every(i=>i.statusGroup==='inProgress'));assert.equal(result.truncated,false);
});

test('invalid helper concurrency is rejected before any provider request',async t=>{
  const f=await fixture(t);
  for(const concurrency of [0,5,-1,1.5,'1',null,NaN,Infinity]){
    await assert.rejects(fetchGithubIssues(f.input,{...f.options,concurrency}),e=>e.code==='INVALID_REQUEST');
    await assert.rejects(probeGithubApi({...f.input,operation:'probe'},{...f.options,concurrency}),e=>e.code==='INVALID_REQUEST');
  }
  assert.equal(f.requests.length,0);
});

test('a newer closed GraphQL state stays Done without requiring a stale project value',async t=>{
  const f=await fixture(t);f.input.binding.github.status=mapping();f.state.pages.set(1,[f.row(1)]);f.state.graph=(ids,{index,node})=>({data:{nodes:ids.map(id=>({...node(index.get(id)),state:'CLOSED',projectItems:null}))}});
  assert.equal((await fetchGithubIssues(f.input,f.options)).data[0].statusGroup,'done');
});
test('a failed Projects batch preserves its reason and stops queued enrichment',async t=>{
  const f=await fixture(t);f.input.binding.github.status=mapping();f.state.pages.set(1,Array.from({length:49},(_,i)=>f.row(i+1)));f.state.graphDelay=30;f.state.graph=()=>({errors:[{type:'FORBIDDEN',message:'PRIVATE'}],data:{nodes:null}});
  await assert.rejects(fetchGithubIssues(f.input,f.options),e=>e.code==='PERMISSION_DENIED');const calls=f.requests.filter(r=>r.method==='POST');assert.ok(calls.length>=1&&calls.length<=4);assert.ok(f.state.peakGraph<=4);
});

test('safe numeric-repository Link pagination rejects foreign hosts, repo IDs, filters and page loops',async t=>{
  const f=await fixture(t);f.state.pages.set(1,[f.row(1)]);
  const valid=url=>{const next=new URL(f.origin+'/api/v3/repositories/900/issues');for(const[k,v]of url.searchParams)next.searchParams.set(k,v);next.searchParams.set('page','2');return next;};
  for(const alter of [u=>{u.hostname='other.invalid';},u=>{u.pathname='/api/v3/repositories/901/issues';},u=>{u.searchParams.set('state','closed');},u=>{u.searchParams.set('page','1');},u=>{u.searchParams.append('page','2');},u=>{u.username='private';},u=>{u.hash='fragment';},u=>{u.searchParams.set('token','PRIVATE');}]){
    f.state.customLink=url=>{const next=valid(url);alter(next);return '<'+next.href+'>; rel="next"';};const before=f.requests.length;await assert.rejects(fetchGithubIssues(f.input,f.options),e=>e.code==='INVALID_SCOPE');assert.equal(f.requests.length,before+2);
  }
  f.state.customLink='malformed';await assert.rejects(fetchGithubIssues(f.input,f.options),e=>e.code==='INVALID_RESPONSE');
  f.state.customLink=url=>{f.state.customLink=null;return '<'+valid(url).href+'>; rel="Next"';};f.state.pages.set(2,[f.row(2,{closed:true})]);assert.deepEqual((await fetchGithubIssues(f.input,f.options)).data.map(i=>i.key),['GH-1','GH-2']);
});

test('cursor scope/age changes fail before HTTP; deleting and recreating a repo cannot reuse its cursor',async t=>{
  const f=await fixture(t);f.state.pages.set(1,Array.from({length:50},(_,i)=>f.row(i+1)));f.state.pages.set(2,[f.row(51,{closed:true})]);
  const first=await fetchGithubIssues(f.input,{...f.options,maxPages:1});assert.ok(first.cursor);assert.equal(first.truncated,true);
  const next=await fetchGithubIssues({...f.input,cursor:first.cursor},f.options);assert.deepEqual(next.data.map(i=>i.key),['GH-51']);assert.equal(next.truncated,false);const before=f.requests.length;
  for(const change of [{connection:{...f.input.connection,credentialEnv:'OTHER_TOKEN'}},{binding:{...f.input.binding,machine:'another-machine'}},{binding:{...f.input.binding,github:{...f.input.binding.github,repo:'other-repo'}}},{binding:{...f.input.binding,github:{...f.input.binding.github,status:mapping()}}}])await assert.rejects(fetchGithubIssues({...f.input,...change,cursor:first.cursor},f.options),e=>e.code==='INVALID_SCOPE');
  await assert.rejects(fetchGithubIssues({...f.input,cursor:first.cursor},{...f.options,clock:()=>NOW+7*86400000}),e=>e.code==='INVALID_SCOPE');assert.equal(f.requests.length,before);
  const wrongType=JSON.parse(Buffer.from(first.cursor,'base64url'));wrongType.repositoryId=900;await assert.rejects(fetchGithubIssues({...f.input,cursor:Buffer.from(JSON.stringify(wrongType)).toString('base64url')},f.options),e=>e.code==='INVALID_SCOPE');assert.equal(f.requests.length,before);
  f.state.repositoryId=901;await assert.rejects(fetchGithubIssues({...f.input,cursor:first.cursor},f.options),e=>e.code==='INVALID_SCOPE');assert.equal(f.requests.length,before+1);
});

test('PR-only pages retain continuation instead of consuming the 1000-issue allowance',async t=>{
  const f=await fixture(t);f.state.generate=page=>page<=20?Array.from({length:50},(_,i)=>f.row((page-1)*50+i+1,{pr:true})):page===21?[f.row(1001),f.row(1002,{closed:true})]:[];
  const first=await fetchGithubIssues(f.input,{...f.options,maxPages:20});assert.equal(first.data.length,0);assert.ok(first.cursor);assert.equal(JSON.parse(Buffer.from(first.cursor,'base64url')).count,0);
  const next=await fetchGithubIssues({...f.input,cursor:first.cursor},f.options);assert.deepEqual(next.data.map(i=>i.statusGroup),['todo','done']);assert.equal(next.truncated,false);
});

test('missing Link on a full page requires an empty-page proof, and repeated full pages fail',async t=>{
  const f=await fixture(t);f.state.links=false;const rows=Array.from({length:50},(_,i)=>f.row(i+1));f.state.pages.set(1,rows);
  const result=await fetchGithubIssues(f.input,f.options);assert.equal(result.truncated,false);assert.equal(result.data.length,50);assert.deepEqual(f.requests.filter(r=>r.path.endsWith('/issues')).map(r=>r.query.page),['1','2']);
  f.state.pages.set(2,rows);await assert.rejects(fetchGithubIssues(f.input,f.options),e=>e.code==='INVALID_SCOPE');
});

test('item/count/output bounds and explicit empty/disabled states cannot claim a complete oversized board',async t=>{
  const f=await fixture(t);f.state.noContent=true;assert.deepEqual((await fetchGithubIssues(f.input,f.options)).data,[]);f.state.noContent=false;
  f.state.hasIssues=false;assert.equal((await probeGithubApi({...f.input,operation:'probe'},f.options)).issuesEnabled,false);await assert.rejects(fetchGithubIssues(f.input,f.options),e=>e.code==='NOT_FOUND');f.state.hasIssues=true;
  f.state.generate=page=>Array.from({length:50},(_,i)=>f.row((page-1)*50+i+1));const capped=await fetchGithubIssues(f.input,{...f.options,maxPages:20});assert.equal(capped.data.length,1000);assert.equal(capped.truncated,true);assert.equal(capped.cursor,undefined);
  f.state.generate=page=>Array.from({length:50},(_,i)=>f.row((page-1)*50+i+1,{body:'é'.repeat(25000)}));const bytes=await fetchGithubIssues(f.input,{...f.options,maxPages:20});assert.equal(bytes.truncated,true);assert.equal(bytes.error.code,'RESPONSE_TOO_LARGE');assert.ok(bytes.data.length>0&&bytes.data.length<1000);assert.ok(Buffer.byteLength(JSON.stringify(bytes))<8*1024*1024);assert.match(bytes.data[0].body,/description truncated/);
});

test('malformed or retargeted REST data and unsafe config fail without launchable cards',async t=>{
  const f=await fixture(t);
  for(const change of [{id:0},{state:'unknown'},{number:1.2},{title:'bad\u001btitle'},{html_url:f.origin+'/other/repo/issues/1'},{url:f.origin+'/api/v3/repos/other/repo/issues/1'},{repository_url:f.origin+'/api/v3/repos/other/repo'},{labels:[{}]},{body:{}},{updated_at:'not-a-date'}]){
    f.state.pages.set(1,[f.row(1,change)]);await assert.rejects(fetchGithubIssues(f.input,f.options),e=>['INVALID_RESPONSE','INVALID_SCOPE'].includes(e.code));
  }
  const before=f.requests.length;await assert.rejects(fetchGithubIssues({...f.input,binding:{...f.input.binding,github:{...f.input.binding.github,repo:'../other'}}},f.options));assert.equal(f.requests.length,before);
  f.state.repoOverride={full_name:'wrong/repo'};await assert.rejects(fetchGithubIssues(f.input,f.options),e=>e.code==='INVALID_SCOPE');
});

test('read errors, rate limits, deadlines and cancellation stay static and credential scoped',async t=>{
  const f=await fixture(t);f.state.pages.set(1,[f.row(1)]);
  for(const[status,headers,code]of [[401,{},'AUTH_REQUIRED'],[403,{},'PERMISSION_DENIED'],[403,{'retry-after':'2'},'RATE_LIMITED'],[429,{'retry-after':'2'},'RATE_LIMITED']]){
    f.state.http={status,headers};await assert.rejects(fetchGithubIssues(f.input,f.options),e=>{assert.equal(e.code,code);assert.doesNotMatch(JSON.stringify(publicTrackerError(e)),/PRIVATE|owned-token/);return true;});
  }
  f.state.http=null;f.state.slowIssues=200;await assert.rejects(fetchGithubIssues(f.input,{...f.options,timeoutMs:30}),e=>e.code==='REQUEST_TIMEOUT');
  const abort=new AbortController();let entered;const ready=new Promise(resolve=>entered=resolve);f.state.issueEntered=entered;
  const pending=fetchGithubIssues(f.input,{...f.options,signal:abort.signal}),rejected=assert.rejects(pending,e=>e.code==='REQUEST_CANCELLED');await ready;abort.abort();await rejected;
});
