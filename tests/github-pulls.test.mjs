import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
import {build} from 'esbuild';
import {fetchGithubPulls} from '../src/mods/mission-control-github/pulls.mjs';
import {validatePullRequest,pullIdentityKey,validatePRActionRequest,prActionAvailability,prReasonText,prDetailCursor,prLaunchSource} from '../src/mods/mission-control-github/pull-model.js';
import {trackerScope} from '../src/shared/tracker-model.js';
import {publicTrackerError} from '../src/shared/tracker-transport.mjs';

const NOW=1800000000000,HEAD='a'.repeat(40),BASE='b'.repeat(40),copy=v=>JSON.parse(JSON.stringify(v));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function sample(){return {identity:{kind:'github-pr',connectionId:'work',site:'https://github.com',owner:'Acme',repo:'Web',number:42},key:'GH-PR-42',title:'Fix login redirect',url:'https://github.com/Acme/Web/pull/42',body:'Task data.',author:{login:'alice',url:'https://github.com/alice'},repoBinding:{machine:'build',repoRoot:'/srv/web',github:{connectionId:'work',owner:'Acme',repo:'Web'}},state:'open',draft:false,head:{ref:'fix/login',sha:HEAD,repoFullName:'Acme/Web',available:true},base:{ref:'main',sha:BASE,available:true},review:{state:'unavailable',reason:'NO_REVIEW_DECISION'},discussions:{state:'actionable',count:1},checks:{state:'failure'},linkedIssues:[],updatedAt:NOW-1000};}
const action=(pull,verb='review')=>({action:verb,pull,toolKey:'claude',requestId:'request-1',checkoutRoot:'/srv/web-worktree'});
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mc-github-pulls-')),key=path.join(root,'key.pem'),cert=path.join(root,'cert.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1','-keyout',key,'-out',cert],{stdio:'ignore'});
  const ca=await fs.readFile(cert),requests=[],state={pages:new Map(),rows:new Map(),repositoryId:900,links:true,link:null,graph:null,http:null,slowList:0,entered:null};let origin;
  const repo=(full='acme/web')=>({id:900,full_name:full,name:full.split('/')[1],owner:{login:full.split('/')[0]},html_url:origin+'/'+full});
  const row=(n,extra={})=>{const raw={id:10000+n,node_id:'PR_'+n,number:n,title:'Fix issue '+n,body:'Task data.',state:'open',merged_at:null,draft:false,user:{login:'alice',html_url:origin+'/alice'},updated_at:'2026-10-30T10:00:00Z',url:origin+'/api/v3/repos/acme/web/pulls/'+n,html_url:origin+'/acme/web/pull/'+n,head:{ref:'fix/'+n,sha:HEAD,repo:repo()},base:{ref:'main',sha:BASE,repo:repo()},...extra};state.rows.set(n,raw);return raw;};
  const graphNode=raw=>({__typename:'PullRequest',id:raw.node_id,number:raw.number,url:raw.html_url,state:raw.merged_at?'MERGED':raw.state.toUpperCase(),isDraft:raw.draft,updatedAt:raw.updated_at,repository:{nameWithOwner:'acme/web',url:origin+'/acme/web'},headRefName:raw.head.ref,headRefOid:raw.head.sha,baseRefName:raw.base.ref,baseRefOid:raw.base.sha,headRepository:raw.head.repo?{nameWithOwner:raw.head.repo.full_name,url:raw.head.repo.html_url}:null,headRef:raw.head.repo?{name:raw.head.ref,target:{oid:raw.head.sha}}:null,baseRef:{name:raw.base.ref,target:{oid:raw.base.sha}},reviewDecision:null,
    reviewThreads:{nodes:[{id:'T_'+raw.number,isResolved:false,isOutdated:false}],totalCount:1,pageInfo:{hasNextPage:false}},
    statusCheckRollup:{commit:{oid:raw.head.sha},state:'FAILURE',contexts:{totalCount:1,pageInfo:{hasNextPage:false},nodes:[{__typename:'CheckRun',id:'C_'+raw.number,status:'COMPLETED',conclusion:'FAILURE',checkSuite:{commit:{oid:raw.head.sha}}}]}},closingIssuesReferences:{nodes:[],pageInfo:{hasNextPage:false}}});
  const server=https.createServer({key:await fs.readFile(key),cert:ca},async(req,res)=>{
    const url=new URL(req.url,origin),chunks=[];for await(const chunk of req)chunks.push(chunk);const body=chunks.length?JSON.parse(Buffer.concat(chunks)):undefined;
    requests.push({method:req.method,path:url.pathname,query:Object.fromEntries(url.searchParams),body,authorization:req.headers.authorization});
    const error=state.http?.(url,req);if(error){res.writeHead(error.status,error.headers||{});res.end('PRIVATE owned-fixture-token upstream detail');return;}
    res.setHeader('content-type','application/json');
    if(url.pathname==='/api/v3/repos/acme/web'){res.end(JSON.stringify({...repo(),id:state.repositoryId,...state.repoOverride}));return;}
    if(url.pathname==='/api/v3/repos/acme/web/pulls'){
      state.entered?.();if(state.slowList)await delay(state.slowList);if(res.destroyed)return;
      const page=Number(url.searchParams.get('page')),rows=state.generate?state.generate(page):state.pages.get(page)||[];
      if(state.link!==null)res.setHeader('link',typeof state.link==='function'?state.link(url,page):state.link);
      else if(state.links&&(state.pages.has(page+1)||state.generate&&rows.length===50)){const next=new URL(origin+'/api/v3/repositories/'+state.repositoryId+'/pulls');for(const[k,v]of url.searchParams)next.searchParams.set(k,v);next.searchParams.set('page',String(page+1));res.setHeader('link','<'+next.href+'>; rel="next"');}
      if(state.noContent){res.writeHead(204);res.end();return;}res.end(JSON.stringify(rows));return;
    }
    const detail=url.pathname.match(/^\/api\/v3\/repos\/acme\/web\/pulls\/([1-9][0-9]*)$/);
    if(detail){res.end(JSON.stringify(state.detail??state.rows.get(Number(detail[1]))));return;}
    if(url.pathname==='/api/graphql'&&req.method==='POST'){
      const raw=[...state.rows.values()].find(r=>r.node_id===body.variables.id),node=raw?graphNode(raw):null;
      const result=state.graph?state.graph(node,body):{data:{node}};res.end(JSON.stringify(result));return;
    }
    res.writeHead(404);res.end('{}');
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});origin='https://127.0.0.1:'+server.address().port;
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(root,{recursive:true,force:true});});
  const connection={id:'work',kind:'github',site:origin,apiBase:origin+'/api/v3',credentialEnv:'GITHUB_WORK'},binding={machine:'build',repoRoot:'/srv/web',github:{connectionId:'work',owner:'acme',repo:'web'}},input={v:1,operation:'pulls',connection,binding},options={env:{GITHUB_WORK:'owned-fixture-token'},ca,clock:()=>NOW};
  const read=async()=>fetchGithubPulls(input,options),detail=pull=>fetchGithubPulls({...input,cursor:prDetailCursor(pull)},options);
  return {origin,state,requests,row,repo,input,options,read,detail};
}

test('the pure model executes with no Node, DOM, URL or GPUI globals',async()=>{
  const bundle=await build({entryPoints:['src/mods/mission-control-github/pull-model.js'],bundle:true,write:false,format:'iife',globalName:'pullApi',platform:'neutral',logLevel:'silent'});
  const sandbox={};const api=vm.runInNewContext(bundle.outputFiles[0].text+'; pullApi',sandbox,{timeout:2000});
  assert.equal(api.validatePullRequest(sample()).author.login,'alice');assert.equal(api.prLaunchSource(action(sample())).id,'acme/web#42');
  for(const global of ['process','Buffer','URL','document','window','herdr'])assert.equal(sandbox[global],undefined);
});

test('pure schema validates author, refs, independent discussions, source scope and exact action shape',()=>{
  const p=sample();assert.equal(validatePullRequest(p).author.login,'alice');assert.equal(prActionAvailability(p,'addressComments').enabled,true);
  const invalid=[q=>{q.author.login=null;},q=>{q.author.url='https://other.invalid/alice';},q=>{q.head.available='true';},q=>{q.head.sha='wrong';},q=>{q.base.ref='../main';},q=>{q.discussions={state:'actionable',count:0};},q=>{q.discussions={state:'none',count:0};},q=>{q.discussions={state:'unavailable',reason:'NO_REVIEW_DECISION'};},q=>{q.review={state:'approved',reason:'NO_REVIEW_DECISION'};},q=>{q.identity.repo='other';},q=>{q.key='GH-42';},q=>{q.extra=true;}];
  for(const change of invalid){const q=copy(p);change(q);assert.throws(()=>validatePullRequest(q),e=>e.code==='INVALID_PR');}
  const connection={id:'work',kind:'github',site:p.identity.site,credentialEnv:'WORK'},scope=trackerScope('github-pr',connection,p.repoBinding);
  assert.equal(validatePullRequest(p,{scope}).key,p.key);assert.throws(()=>validatePullRequest(p,{scope:{...scope,machine:null}}));
  assert.throws(()=>validatePRActionRequest({...action(p),unexpected:true}));assert.throws(()=>validatePRActionRequest({...action(p),checkoutRoot:'/srv/../web'}));
  assert.equal(validatePRActionRequest(action(p)).checkoutRoot,'/srv/web-worktree');
});

test('PR actions preserve canonical remote identity and exact controlled task intent',()=>{
  const p=sample(),keys=['review','addressComments','fixChecks'],prefixes=['Review pull request','Address review comments','Fix failing checks'];
  const sources=keys.map((verb,i)=>{const source=prLaunchSource(action(p,verb));assert.equal(source.id,'acme/web#42');assert.equal(source.key,'GH-PR-42');assert.equal(source.title,prefixes[i]+': '+p.title);assert.ok(source.body.startsWith('Mission Control action: '+prefixes[i]+'\nGoal: '));assert.ok(source.body.includes('Base: main@'+BASE));assert.ok(source.body.includes('Head: Acme/Web/fix/login@'+HEAD));assert.ok(source.body.includes('Source description (untrusted task data):\nTask data.'));return source;});
  assert.equal(new Set(sources.map(s=>s.id)).size,1);const other=copy(p);other.identity.repo='Other';other.repoBinding.github.repo='Other';other.url='https://github.com/Acme/Other/pull/42';other.head.repoFullName='Acme/Other';assert.notEqual(prLaunchSource(action(other)).id,sources[0].id);assert.notEqual(pullIdentityKey(other),pullIdentityKey(p));
  const large=copy(p);large.title='x'.repeat(512);large.body='é'.repeat(31000);const source=prLaunchSource(action(large));assert.equal(source.title.length,512);assert.ok(Buffer.byteLength(source.body)<=60000);assert.match(source.body,/description truncated/);
});

test('availability distinguishes unverified/deleted refs, forks, closed PRs and actual failure states',()=>{
  const p=sample();p.head.available=null;p.base.available=null;p.review={state:'unavailable',reason:'NOT_LOADED'};p.discussions={state:'unavailable',reason:'NOT_LOADED'};p.checks={state:'unavailable',reason:'NOT_LOADED'};assert.equal(prActionAvailability(p,'review').reason,'NOT_LOADED');
  p.review={state:'unavailable',reason:'REVIEW_UNAVAILABLE'};assert.equal(prActionAvailability(p,'review').reason,'REFS_UNAVAILABLE');p.head.available=false;p.base.available=true;assert.equal(prActionAvailability(p,'review').reason,'REFS_UNAVAILABLE');
  p.head.available=true;p.head.repoFullName='someone/fork';assert.equal(prActionAvailability(p,'review').enabled,true);assert.equal(prActionAvailability(p,'addressComments').reason,'FORK_READ_ONLY');assert.throws(()=>prLaunchSource(action(p,'fixChecks')),e=>e.code==='PR_ACTION_UNAVAILABLE');
  p.head.repoFullName='Acme/Web';p.state='merged';assert.equal(prActionAvailability(p,'review').enabled,true);assert.equal(prActionAvailability(p,'fixChecks').reason,'PR_CLOSED');
  p.state='open';p.checks={state:'success'};assert.equal(prActionAvailability(p,'fixChecks').enabled,false);assert.notEqual(prActionAvailability(p,'fixChecks').reason,'NO_CHECKS');assert.match(prReasonText('DISCUSSIONS_PARTIAL'),/complete review thread/);
});

test('REST lists all PR states with actual authors and unloaded metadata, without per-card enrichment',async t=>{
  const f=await fixture(t);f.state.pages.set(1,[f.row(1),f.row(2,{state:'closed'}),f.row(3,{state:'closed',merged_at:'2026-10-29T10:00:00Z'}),f.row(4,{user:null,draft:true})]);
  const result=await f.read();assert.deepEqual(result.data.map(p=>p.state),['open','closed','merged','open']);assert.equal(result.data[0].author.login,'alice');assert.deepEqual(result.data[3].author,{login:null,url:null});assert.equal(result.data[3].draft,true);
  for(const p of result.data){assert.equal(p.review.reason,'NOT_LOADED');assert.equal(p.discussions.reason,'NOT_LOADED');assert.equal(p.checks.reason,'NOT_LOADED');assert.equal(p.head.available,null);assert.equal(p.base.available,null);}
  assert.equal(f.requests.length,2);assert.equal(f.requests[1].query.state,'all');assert.ok(f.requests.every(r=>r.method==='GET'&&r.authorization==='Bearer owned-fixture-token'));assert.doesNotMatch(JSON.stringify(result),/owned-fixture-token/);
});

test('one selected detail verifies exact refs with independent null review and actionable threads',async t=>{
  const f=await fixture(t);f.state.pages.set(1,[f.row(42)]);const p=(await f.read()).data[0],before=f.requests.length,result=await f.detail(p),loaded=result.data[0];
  assert.equal(f.requests.length-before,3);assert.equal(result.cursor,undefined);assert.equal(result.truncated,false);assert.equal(loaded.review.reason,'NO_REVIEW_DECISION');assert.deepEqual(loaded.discussions,{state:'actionable',count:1});assert.equal(loaded.checks.state,'failure');assert.equal(loaded.head.available,true);assert.equal(prActionAvailability(loaded,'addressComments').enabled,true);assert.equal(prActionAvailability(loaded,'fixChecks').enabled,true);
  const graph=f.requests.at(-1);assert.equal(graph.method,'POST');assert.deepEqual(graph.body.variables,{id:'PR_42'});assert.match(graph.body.query,/reviewThreads\(first: 100\)/);assert.match(graph.body.query,/statusCheckRollup/);assert.doesNotMatch(graph.body.query,/mutation|headSha/);
});

test('none, partial, denied and unknown discussion data never borrow aggregate review status',async t=>{
  const f=await fixture(t);f.state.pages.set(1,[f.row(1)]);const p=(await f.read()).data[0];
  const cases=[
    [node=>{node.reviewThreads.nodes[0].isResolved=true;},'NO_ACTIONABLE_COMMENTS'],
    [node=>{node.reviewThreads.nodes[0].isOutdated=true;},'NO_ACTIONABLE_COMMENTS'],
    [node=>{node.reviewThreads.pageInfo.hasNextPage=true;},'DISCUSSIONS_PARTIAL'],
    [node=>{node.reviewThreads.nodes.push(copy(node.reviewThreads.nodes[0]));node.reviewThreads.totalCount=2;},'DISCUSSIONS_PARTIAL'],
    [node=>{node.reviewThreads.totalCount=2;},'DISCUSSIONS_PARTIAL'],
    [node=>{node.reviewThreads.nodes[0].isResolved=null;},'DISCUSSIONS_PARTIAL'],
    [node=>{node.reviewThreads=null;},'DISCUSSIONS_UNAVAILABLE']
  ];
  for(const [change,reason]of cases){f.state.graph=node=>{change(node);node.reviewDecision='APPROVED';return {data:{node}};};const loaded=(await f.detail(p)).data[0];assert.equal(loaded.review.state,'approved');assert.equal(prActionAvailability(loaded,'addressComments').reason,reason);}
  f.state.graph=node=>({data:{node:{...node,reviewThreads:null}},errors:[{type:'FORBIDDEN',path:['node','reviewThreads'],message:'PRIVATE owned-fixture-token'}]});
  const loaded=(await f.detail(p)).data[0];assert.equal(loaded.discussions.reason,'DISCUSSIONS_UNAVAILABLE');assert.equal(loaded.review.reason,'NO_REVIEW_DECISION');assert.equal(prActionAvailability(loaded,'review').enabled,true);assert.doesNotMatch(JSON.stringify(loaded),/PRIVATE|owned-fixture-token/);
  f.state.graph=node=>({data:{node},errors:[{type:'FORBIDDEN',path:['node','reviewDecision'],message:'PRIVATE'}]});
  const independent=(await f.detail(p)).data[0];assert.equal(independent.review.reason,'REVIEW_UNAVAILABLE');assert.equal(prActionAvailability(independent,'addressComments').enabled,true);
});

test('check runs and legacy contexts require complete same-head evidence before repair',async t=>{
  const f=await fixture(t);f.state.pages.set(1,[f.row(1)]);const p=(await f.read()).data[0];
  const cases=[
    [node=>{node.statusCheckRollup=null;},'unavailable','NO_CHECKS'],
    [node=>{node.statusCheckRollup.commit=null;},'unavailable','CHECKS_UNAVAILABLE'],
    [node=>{node.statusCheckRollup.contexts.pageInfo.hasNextPage=true;},'unavailable','CHECKS_PARTIAL'],
    [node=>{node.statusCheckRollup.contexts.nodes=[];node.statusCheckRollup.contexts.totalCount=0;},'unavailable','NO_CHECKS'],
    [node=>{node.statusCheckRollup.contexts.nodes[0].conclusion=null;},'unavailable','CHECKS_PARTIAL'],
    [node=>{node.statusCheckRollup.contexts.nodes[0].status='IN_PROGRESS';node.statusCheckRollup.state='PENDING';},'pending',undefined],
    [node=>{node.statusCheckRollup.contexts.nodes[0].conclusion='SUCCESS';node.statusCheckRollup.state='SUCCESS';},'success',undefined],
    [node=>{node.statusCheckRollup.contexts.nodes=[{__typename:'StatusContext',id:'S',state:'ERROR',commit:{oid:HEAD}}];},'failure',undefined],
    [node=>{node.statusCheckRollup.contexts.nodes=[{__typename:'StatusContext',id:'S',state:'ERROR',commit:null}];},'unavailable','CHECKS_PARTIAL']
  ];
  for(const[change,state,reason]of cases){f.state.graph=node=>{change(node);return {data:{node}};};const loaded=(await f.detail(p)).data[0];assert.equal(loaded.checks.state,state);assert.equal(loaded.checks.reason,reason);assert.equal(prActionAvailability(loaded,'fixChecks').enabled,state==='failure');}
  f.state.graph=node=>({data:{node:{...node,statusCheckRollup:null}},errors:[{type:'FORBIDDEN',path:['node','statusCheckRollup'],message:'PRIVATE'}]});assert.equal((await f.detail(p)).data[0].checks.reason,'CHECKS_UNAVAILABLE');
  f.state.graph=node=>{node.statusCheckRollup.contexts.nodes[0].checkSuite.commit.oid=BASE;return {data:{node}};};await assert.rejects(f.detail(p),e=>e.code==='INVALID_SCOPE');
});

test('deleted refs and accessible forks retain source metadata while disabling unsafe starts',async t=>{
  const f=await fixture(t);f.state.pages.set(1,[f.row(1,{head:{ref:'fork-branch',sha:HEAD,repo:f.repo('someone/fork')}})]);const p=(await f.read()).data[0];
  let loaded=(await f.detail(p)).data[0];assert.equal(prActionAvailability(loaded,'review').enabled,true);assert.equal(prActionAvailability(loaded,'fixChecks').reason,'FORK_READ_ONLY');
  f.state.graph=node=>({data:{node:{...node,headRef:null}}});loaded=(await f.detail(p)).data[0];assert.equal(loaded.head.ref,'fork-branch');assert.equal(loaded.head.sha,HEAD);assert.equal(loaded.head.available,false);assert.equal(prActionAvailability(loaded,'review').reason,'REFS_UNAVAILABLE');
  f.state.graph=node=>({data:{node:{...node,baseRef:null}}});assert.equal((await f.detail(p)).data[0].base.available,false);
  f.state.graph=node=>({data:{node:null},errors:[{type:'FORBIDDEN',path:['node'],message:'PRIVATE'}]});loaded=(await f.detail(p)).data[0];assert.equal(loaded.head.available,null);assert.equal(prActionAvailability(loaded,'review').reason,'REFS_UNAVAILABLE');
  f.state.graph=null;f.state.pages.set(1,[f.row(2,{head:{ref:'deleted',sha:HEAD,repo:null}})]);const gone=(await f.read()).data[0];loaded=(await f.detail(gone)).data[0];assert.equal(loaded.head.repoFullName,null);assert.equal(loaded.head.available,false);assert.equal(prActionAvailability(loaded,'review').reason,'REFS_UNAVAILABLE');
});

test('immutable detail cursors reject wrong shapes, accounts, repos and SHA changes',async t=>{
  const f=await fixture(t);f.state.pages.set(1,[f.row(1)]);const p=(await f.read()).data[0],cursor=JSON.parse(prDetailCursor(p)),before=f.requests.length;
  for(const change of [c=>{c.extra=true;},c=>{c.kind='pr-list';},c=>{c.identity.connectionId='another';},c=>{c.identity.site='https://other.invalid';},c=>{c.identity.repo='other';},c=>{c.identity.number=0;},c=>{c.headSha='bad';}]){const c=copy(cursor);change(c);await assert.rejects(fetchGithubPulls({...f.input,cursor:JSON.stringify(c)},f.options),e=>e.code==='INVALID_SCOPE');}
  assert.equal(f.requests.length,before);
  const raw=copy(f.state.rows.get(1));raw.head.sha=BASE;f.state.detail=raw;await assert.rejects(f.detail(p),e=>e.code==='INVALID_SCOPE');assert.equal(f.requests.at(-1).method,'GET');f.state.detail=null;
  for(const change of [node=>{node.headRefOid=BASE;},node=>{node.baseRefOid=HEAD;},node=>{node.number=2;},node=>{node.repository.nameWithOwner='acme/other';},node=>{node.headRef.target.oid=BASE;}]){f.state.graph=node=>{change(node);return {data:{node}};};await assert.rejects(f.detail(p),e=>e.code==='INVALID_SCOPE');}
});

test('actual linked URLs are deduplicated associations and never fetched as an integration',async t=>{
  const f=await fixture(t);const jira='https://jira.example/browse/WEB-142';f.state.pages.set(1,[f.row(1,{body:`See ${jira} and ${jira}. WEB-999 alone is not a URL. https://bad.invalid/browse/WEB-142suffix https://bad..invalid/browse/WEB-1`})]);const p=(await f.read()).data[0];assert.deepEqual(p.linkedIssues,[{kind:'jira',id:'WEB-142',url:jira}]);
  const linked={id:'I_7',number:7,url:f.origin+'/acme/other/issues/7',repository:{nameWithOwner:'acme/other'}};
  f.state.graph=node=>{node.closingIssuesReferences.nodes=[linked,copy(linked)];return {data:{node}};};let result=await f.detail(p);assert.equal(result.data[0].linkedIssues.length,2);assert.deepEqual(result.data[0].linkedIssues[1],{kind:'github',id:'I_7',url:linked.url});assert.ok(f.requests.every(r=>r.path.startsWith('/api/')));
  f.state.graph=node=>{node.closingIssuesReferences.pageInfo.hasNextPage=true;return {data:{node}};};result=await f.detail(p);assert.equal(result.error.code,'INCOMPLETE_RESULTS');assert.equal(result.cursor,undefined);
});

test('list cursors continue safely, expire and cannot cross scope or recreated repositories',async t=>{
  const f=await fixture(t);f.state.pages.set(1,Array.from({length:50},(_,i)=>f.row(i+1)));f.state.pages.set(2,[f.row(51)]);
  const first=await fetchGithubPulls(f.input,{...f.options,maxPages:1});assert.equal(first.truncated,true);assert.ok(first.cursor);const next=await fetchGithubPulls({...f.input,cursor:first.cursor},f.options);assert.deepEqual(next.data.map(p=>p.key),['GH-PR-51']);assert.equal(next.truncated,false);const before=f.requests.length;
  for(const change of [{connection:{...f.input.connection,credentialEnv:'OTHER'}},{binding:{...f.input.binding,machine:null}},{binding:{...f.input.binding,github:{...f.input.binding.github,repo:'other'}}}])await assert.rejects(fetchGithubPulls({...f.input,...change,cursor:first.cursor},f.options),e=>e.code==='INVALID_SCOPE');
  await assert.rejects(fetchGithubPulls({...f.input,cursor:first.cursor},{...f.options,clock:()=>NOW+7*86400000}),e=>e.code==='INVALID_SCOPE');assert.equal(f.requests.length,before);
  f.state.repositoryId=901;await assert.rejects(fetchGithubPulls({...f.input,cursor:first.cursor},f.options),e=>e.code==='INVALID_SCOPE');assert.equal(f.requests.length,before+1);
});

test('safe pagination rejects hostile links, repeated pages and incomplete full-page guesses',async t=>{
  const f=await fixture(t);f.state.pages.set(1,[f.row(1)]);
  const valid=url=>{const next=new URL(f.origin+'/api/v3/repositories/900/pulls');for(const[k,v]of url.searchParams)next.searchParams.set(k,v);next.searchParams.set('page','2');return next;};
  for(const change of [u=>{u.hostname='other.invalid';},u=>{u.pathname='/api/v3/repositories/901/pulls';},u=>{u.searchParams.set('state','closed');},u=>{u.searchParams.append('page','2');},u=>{u.searchParams.set('page','1');},u=>{u.username='private';},u=>{u.hash='fragment';}]){f.state.link=url=>{const u=valid(url);change(u);return '<'+u.href+'>; rel="next"';};await assert.rejects(f.read(),e=>e.code==='INVALID_SCOPE');}
  f.state.link=null;f.state.links=false;f.state.pages.set(1,Array.from({length:50},(_,i)=>f.row(i+1)));const before=f.requests.length,result=await f.read();assert.equal(result.truncated,false);assert.deepEqual(f.requests.slice(before).filter(r=>r.path.endsWith('/pulls')).map(r=>r.query.page),['1','2']);
  f.state.pages.set(2,f.state.pages.get(1));await assert.rejects(f.read(),e=>e.code==='INVALID_SCOPE');
});

test('record/output bounds, invalid config and malformed provider records cannot create launchable cards',async t=>{
  const f=await fixture(t);f.state.generate=page=>Array.from({length:50},(_,i)=>f.row((page-1)*50+i+1));let result=await fetchGithubPulls(f.input,{...f.options,maxPages:20});assert.equal(result.data.length,1000);assert.equal(result.truncated,true);assert.equal(result.cursor,undefined);
  f.state.generate=page=>Array.from({length:50},(_,i)=>f.row((page-1)*50+i+1,{body:'é'.repeat(25000)}));result=await fetchGithubPulls(f.input,{...f.options,maxPages:20});assert.equal(result.error.code,'RESPONSE_TOO_LARGE');assert.ok(result.data.length>0&&result.data.length<1000);assert.ok(Buffer.byteLength(JSON.stringify(result))<8*1024*1024);assert.match(result.data[0].body,/description truncated/);f.state.generate=null;
  for(const change of [raw=>{raw.user={login:'alice',html_url:'https://other.invalid/alice'};},raw=>{raw.base.repo=f.repo('acme/other');},raw=>{raw.head.sha='bad';},raw=>{raw.title='bad\u001btitle';},raw=>{raw.state='unknown';},raw=>{delete raw.merged_at;},raw=>{raw.body={};}]){const raw=f.row(1);change(raw);f.state.pages.set(1,[raw]);await assert.rejects(f.read(),e=>['INVALID_RESPONSE','INVALID_SCOPE'].includes(e.code));}
  const before=f.requests.length;for(const concurrency of [0,5,1.5,null])await assert.rejects(fetchGithubPulls(f.input,{...f.options,concurrency}),e=>e.code==='INVALID_REQUEST');assert.equal(f.requests.length,before);
});

test('HTTP failures, rate limits, deadlines and active cancellation stay bounded and redacted',async t=>{
  const f=await fixture(t);f.state.pages.set(1,[f.row(1)]);
  for(const[status,headers,code]of [[401,{},'AUTH_REQUIRED'],[403,{},'PERMISSION_DENIED'],[403,{'retry-after':'2'},'RATE_LIMITED'],[429,{'retry-after':'2'},'RATE_LIMITED']]){f.state.http=()=>({status,headers});await assert.rejects(f.read(),e=>{assert.equal(e.code,code);assert.doesNotMatch(JSON.stringify(publicTrackerError(e)),/PRIVATE|owned-fixture-token/);return true;});}
  f.state.http=null;f.state.slowList=200;await assert.rejects(fetchGithubPulls(f.input,{...f.options,timeoutMs:30}),e=>e.code==='REQUEST_TIMEOUT');
  const abort=new AbortController();let entered;const ready=new Promise(resolve=>entered=resolve);f.state.entered=entered;const pending=fetchGithubPulls(f.input,{...f.options,signal:abort.signal}),rejected=assert.rejects(pending,e=>e.code==='REQUEST_CANCELLED');await ready;abort.abort();await rejected;
});

test('denied metadata, malformed GraphQL and empty REST results keep distinct states',async t=>{
  const f=await fixture(t);f.state.noContent=true;assert.deepEqual((await f.read()).data,[]);f.state.noContent=false;
  f.state.pages.set(1,[f.row(1)]);const p=(await f.read()).data[0];
  f.state.http=url=>url.pathname==='/api/graphql'?{status:403}:null;let loaded=(await f.detail(p)).data[0];assert.equal(loaded.review.reason,'REVIEW_UNAVAILABLE');assert.equal(loaded.discussions.reason,'DISCUSSIONS_UNAVAILABLE');assert.equal(loaded.checks.reason,'CHECKS_UNAVAILABLE');assert.equal(prActionAvailability(loaded,'review').reason,'REFS_UNAVAILABLE');
  f.state.http=null;f.state.graph=()=>({});await assert.rejects(f.detail(p),e=>e.code==='INVALID_RESPONSE');
  f.state.graph=()=>({errors:[{type:'RATE_LIMITED',message:'PRIVATE'}],data:{node:null}});await assert.rejects(f.detail(p),e=>e.code==='RATE_LIMITED');
  f.state.graph=node=>({data:{node:{...node,state:'CLOSED'}}});loaded=(await f.detail(p)).data[0];assert.equal(loaded.state,'closed');assert.equal(prActionAvailability(loaded,'addressComments').reason,'PR_CLOSED');
});
