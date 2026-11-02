import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import vm from 'node:vm';
import {execFile,execFileSync} from 'node:child_process';
import {build} from 'esbuild';
import {newConfig,bindingKey} from '../src/shared/config.js';
import {trackerScope,trackerScopeKey} from '../src/shared/tracker-model.js';
import {dispatchGitlab} from '../src/mods/mission-control-gitlab/backend.mjs';
import {GitlabDataBridge,HelperQueue,STALE_LOAD_MS,validateGitlabReply,gitlabSetupModel,gitlabApiBase} from '../src/mods/mission-control-gitlab/data.js';
import {mrDetailCursor} from '../src/mods/mission-control-gitlab/merge-model.js';

const HEAD='a'.repeat(40),BASE='b'.repeat(40),copy=value=>JSON.parse(JSON.stringify(value));
const resolved=request=>({state:'resolved',machine:request.binding.machine,repoRoot:request.binding.repoRoot,worktreeRoot:request.binding.repoRoot+'-linked'});
function configFor(inputs){const c=newConfig();for(const r of inputs){c.connections[r.connection.id]=copy(r.connection);c.bindings[bindingKey(r.binding.machine,r.binding.repoRoot)]=copy(r.binding);}return c;}
async function waitFor(check){const until=Date.now()+12000;while(Date.now()<until){if(check())return;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Owned GitLab fixture did not reach the expected state.');}
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mc-gitlab-backend-')),mod=path.join(root,'mods/mission-control-gitlab'),file=path.join(root,'mission-control/config.json');await fs.mkdir(mod,{recursive:true});await fs.mkdir(path.dirname(file));
  const backend=path.join(mod,'backend.mjs');
  const built=await build({entryPoints:['src/mods/mission-control-gitlab/backend.mjs'],bundle:true,platform:'node',format:'esm',target:'node22',outfile:backend,metafile:true,banner:{js:'import {createRequire as __mcCreateRequire} from "node:module";const require=__mcCreateRequire(import.meta.url);'},logLevel:'silent'});
  assert.ok(Object.keys(built.metafile.inputs).every(p=>p.startsWith('src/shared/')||p.startsWith('src/mods/mission-control-gitlab/')));
  const key=path.join(root,'key.pem'),cert=path.join(root,'cert.pem');execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1','-keyout',key,'-out',cert],{stdio:'ignore'});const ca=await fs.readFile(cert);
  const requests=[],calls=[],held=[],bridges=[],scopeActive=new Map();let active=0,peak=0,scopePeak=0,writes=0,origin;
  const state={hold:null,delay:0,canonical:new Map(),badWeb:false,status:200,heads:new Map(),bases:new Map(),active:0,peak:0,listPages:1};
  const server=https.createServer({key:await fs.readFile(key),cert:ca},(req,res)=>{
    const url=new URL(req.url,origin),entry={method:req.method,path:url.pathname,query:Object.fromEntries(url.searchParams),authorization:req.headers.authorization};requests.push(entry);
    state.active++;state.peak=Math.max(state.peak,state.active);res.once('close',()=>state.active--);
    const send=()=>{
      if(res.destroyed)return;const route=url.pathname.match(/^\/api\/v4\/projects\/([^/]+)(?:\/(.*))?$/),personal=req.headers.authorization==='Bearer fixture-personal-token';
      if(state.status!==200){res.writeHead(state.status,{'retry-after':'2'});res.end('PRIVATE_PROVIDER_BODY fixture-work-token');return;}
      if(!route||!['Bearer fixture-work-token','Bearer fixture-personal-token'].includes(req.headers.authorization)){res.writeHead(401);res.end('PRIVATE_PROVIDER_BODY');return;}
      const typed=decodeURIComponent(route[1]),project=state.canonical.get(typed)||typed,base=origin+'/'+project,kind=route[2],page=Number(url.searchParams.get('page')||1),title=personal?'Personal':'Work';
      const merge=()=>({id:'9007199254740993',iid:42,project_id:77,target_project_id:77,source_project_id:77,title:title+' MR',description:'MR fixture.',state:'opened',draft:false,source_branch:'fix/login',target_branch:'main',sha:state.heads.get(project)||HEAD,web_url:base+'/-/merge_requests/42',updated_at:new Date().toISOString(),...(state.bases.has(project)?{diff_refs:{head_sha:state.heads.get(project)||HEAD,start_sha:state.bases.get(project)}}:{})});
      res.setHeader('content-type','application/json');
      if(!kind){state.onProject?.();res.end(JSON.stringify({id:77,path_with_namespace:project,web_url:state.badWeb?'https://foreign.invalid/'+project:base,issues_enabled:true}));return;}
      if(kind==='issues'){res.setHeader('x-next-page',page<state.listPages?String(page+1):'');res.end(JSON.stringify([{id:String(700+page),iid:page,project_id:77,issue_type:'issue',title:title+' issue '+page,description:'Issue fixture.',state:'opened',labels:[],web_url:base+'/-/issues/'+page,updated_at:new Date().toISOString()}]));return;}
      if(kind==='merge_requests'){res.setHeader('x-next-page','');res.end(JSON.stringify([merge()]));return;}
      if(kind==='merge_requests/42'){res.end(JSON.stringify({...merge(),diff_refs:{head_sha:state.heads.get(project)||HEAD,start_sha:state.bases.get(project)||BASE},head_pipeline:{id:942,project_id:77,sha:HEAD,ref:'fix/login',status:'failed',web_url:base+'/-/pipelines/942'}}));return;}
      if(kind==='merge_requests/42/approvals'){res.end(JSON.stringify({approved:true}));return;}
      if(kind==='merge_requests/42/discussions'){res.setHeader('x-next-page','');res.end(JSON.stringify([{id:'thread-1',notes:[{id:123,resolvable:true,resolved:false,body:'Handle the expired cookie.'}]}]));return;}
      if(kind==='merge_requests/42/closes_issues'){res.setHeader('x-next-page','');res.end('[]');return;}
      if(kind==='pipelines/942/jobs'){res.setHeader('x-next-page','');res.end(JSON.stringify([{id:1001,name:'login-tests',stage:'test',status:'failed',web_url:base+'/-/jobs/1001',pipeline:{id:942,project_id:77,sha:HEAD},commit:{id:HEAD},failure_reason:'script_failure'}]));return;}
      res.writeHead(404);res.end('{}');
    };
    const deliver=()=>state.delay?setTimeout(send,state.delay):send();if(state.hold?.(entry)){held.push({entry,send:deliver});return;}deliver();
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});origin='https://127.0.0.1:'+server.address().port;
  const env={PATH:process.env.PATH,NODE_EXTRA_CA_CERTS:cert,GL_WORK_TOKEN:'fixture-work-token',GL_PERSONAL_TOKEN:'fixture-personal-token'};
  const invoke=async(command,args,options={})=>{
    assert.equal(command,'node');assert.equal(options.cwd,root);assert.equal(Object.hasOwn(options,'on'),false);
    const input=JSON.parse(args[1]),scope=trackerScopeKey(trackerScope('gitlab',input.connection,input.binding));calls.push(input);active++;peak=Math.max(peak,active);scopeActive.set(scope,(scopeActive.get(scope)||0)+1);scopePeak=Math.max(scopePeak,scopeActive.get(scope));
    return new Promise((resolve,reject)=>execFile(process.execPath,args,{cwd:root,env,maxBuffer:8*1024*1024,timeout:28000},(error,stdout,stderr)=>{active--;scopeActive.set(scope,scopeActive.get(scope)-1);if(error&&typeof error.code!=='number')reject(error);else resolve({code:error?.code||0,stdout,stderr});}));
  };
  const io={appHome:()=>root,exec:invoke,readTextFile:async p=>{try{return await fs.readFile(p,'utf8');}catch(error){if(error.code==='ENOENT')return null;throw error;}},ensureDirectory:p=>fs.mkdir(p,{recursive:true}),writeTextFile:async(p,value,expected)=>{let old;try{old=await fs.readFile(p,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;old=null;}if(old!==expected)throw Object.assign(Error('CAS changed'),{code:'STALE'});writes++;await fs.writeFile(p,value);}};
  const input=(id='work',projectPath='Group/web',repoRoot='/repos/web',machine=null)=>({v:1,operation:'issues',connection:{id,kind:'api',site:origin,auth:{kind:'bearer',tokenEnv:id==='personal'?'GL_PERSONAL_TOKEN':'GL_WORK_TOKEN'}},binding:{machine,repoRoot,gitlab:{connectionId:id,projectPath}}});
  const release=()=>{while(held.length)held.shift().send();};
  t.after(async()=>{for(const b of bridges)b.close();state.hold=null;release();await waitFor(()=>active===0);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(root,{recursive:true,force:true});});
  return {root,file,mod,backend,origin,ca,env,io,input,requests,calls,state,held,active:()=>active,peak:()=>peak,scopePeak:()=>scopePeak,writes:()=>writes,release,save:config=>fs.writeFile(file,JSON.stringify(config)+'\n'),config:async()=>JSON.parse(await fs.readFile(file,'utf8')),bridge:options=>{const b=new GitlabDataBridge(io,options);bridges.push(b);return b;},run:async request=>JSON.parse((await invoke('node',[backend,JSON.stringify(request)],{cwd:root})).stdout)};
}

test('a copied mod-only backend runs issues, merges and canonical probe without Jira, siblings or node_modules',async t=>{
  const f=await fixture(t),r=f.input();
  for(const operation of ['issues','merges','probe']){const request={...r,operation},reply=await f.run(request);assert.equal(reply.ok,true,JSON.stringify(reply));assert.deepEqual(validateGitlabReply(reply,request),reply);assert.doesNotMatch(JSON.stringify(reply),/fixture-work-token|fixture-personal-token/);if(operation==='probe')assert.equal(reply.probe.projectPath,'Group/web');else assert.equal(reply.snapshot.scope.source,operation==='issues'?'gitlab':'gitlab-mr');}
  assert.deepEqual(await fs.readdir(path.join(f.root,'mods')),['mission-control-gitlab']);assert.deepEqual(await fs.readdir(f.mod),['backend.mjs']);assert.ok(f.requests.every(r=>r.method==='GET'));
  const raw=await new Promise((resolve,reject)=>execFile(process.execPath,[f.backend,'not JSON'],{env:f.env},(error,stdout)=>error?reject(error):resolve(stdout)));assert.equal(JSON.parse(raw).error.code,'INVALID_REQUEST');
});

test('native bridge bundles without Node APIs and rejects wrong packets, scope and malformed detail selectors',async t=>{
  const f=await fixture(t),r=f.input(),reply=await f.run(r);
  const result=await build({entryPoints:['src/mods/mission-control-gitlab/data.js'],bundle:true,platform:'neutral',format:'iife',globalName:'Bridge',write:false,logLevel:'silent'}),context={};vm.runInNewContext(result.outputFiles[0].text,context,{timeout:1000});assert.equal(context.process,undefined);assert.equal(context.Bridge.gitlabApiBase(f.origin),f.origin+'/api/v4');
  for(const mutate of [v=>v.extra=true,v=>delete v.progressHint,v=>v.snapshot.scope.machine='other']){const bad=copy(reply);mutate(bad);assert.throws(()=>validateGitlabReply(bad,r),e=>e.code==='INVALID_RESPONSE');}
  const b=f.bridge({view:'merges'});b.selectConfig(configFor([r]),resolved(r));await b.refresh();const m=b.view().data[0],cursor=JSON.parse(mrDetailCursor(m)),before=f.calls.length;
  for(const change of [{extra:true},{machine:'other'},{identity:{...cursor.identity,connectionId:'personal'}}])await assert.rejects(b.request({...r,operation:'merges',cursor:JSON.stringify({...cursor,...change})}),e=>e.code==='INVALID_SCOPE');assert.equal(f.calls.length,before);
  const loaded=await b.loadMergeDetails(m);assert.equal(loaded.base.sha,BASE);const detailRequest={...r,operation:'merges',cursor:mrDetailCursor(m)};assert.equal(validateGitlabReply(await f.run(detailRequest),detailRequest).snapshot.data[0].base.sha,BASE);
  const error=validateGitlabReply({v:1,ok:false,error:{code:'AUTH_REQUIRED',message:'PRIVATE_PROVIDER_BODY fixture-work-token',status:401}},r);assert.doesNotMatch(JSON.stringify(error),/PRIVATE|fixture-work-token/);
});

test('public list cursors preserve operation, credential and repository scope before provider access',async t=>{
  const f=await fixture(t),r=f.input();f.state.listPages=2;let now=Date.now();f.state.onProject=()=>{now+=24000;f.state.onProject=null;};
  const first=await dispatchGitlab(r,{env:f.env,clock:()=>now,api:{ca:f.ca}});
  // A fixed helper deadline can also yield a page1 continuation before any list read.
  assert.equal(first.ok,true,JSON.stringify(first));assert.ok(first.snapshot.cursor);const before=f.requests.length;
  for(const change of [{operation:'merges'},{connection:{...r.connection,auth:{kind:'bearer',tokenEnv:'GL_PERSONAL_TOKEN'}}},{binding:{...r.binding,repoRoot:'/repos/other'}}]){const response=await dispatchGitlab({...r,...change,cursor:first.snapshot.cursor},{env:f.env,api:{ca:f.ca}});assert.equal(response.error.code,'INVALID_SCOPE');}assert.equal(f.requests.length,before);
  const next=await dispatchGitlab({...r,cursor:first.snapshot.cursor},{env:f.env,api:{ca:f.ca}});assert.equal(next.ok,true,JSON.stringify(next));assert.equal(next.snapshot.data.length,2);
});

test('issues and MR views have independent caches but serialize helper reads for one exact repository',async t=>{
  const f=await fixture(t),r=f.input(),c=configFor([r]);await f.save(c);const issues=f.bridge(),merges=f.bridge({view:'merges'});issues.selectConfig(c,resolved(r));merges.selectConfig(c,resolved(r));await Promise.all([issues.refresh(),merges.refresh()]);
  assert.equal(issues.view().data[0].key,'GL-1');assert.equal(merges.view().data[0].key,'GL-MR-42');assert.equal(issues.view().bindings[0].scope.source,'gitlab');assert.equal(merges.view().bindings[0].scope.source,'gitlab-mr');assert.equal(issues.view().bindings[0].checkoutRoot,r.binding.repoRoot+'-linked');
  f.state.hold=e=>e.path.endsWith('/issues');const count=f.calls.length,old=issues.refresh({force:true});await waitFor(()=>f.held.length===1);const queued=merges.refresh({force:true});await new Promise(resolve=>setTimeout(resolve,50));assert.equal(f.calls.length,count+1);f.state.hold=null;f.release();await Promise.all([old,queued]);assert.equal(f.scopePeak(),1);
});

test('account changes clear old rows immediately and late former-account responses cannot republish',async t=>{
  const f=await fixture(t),work=f.input(),personal=f.input('personal'),b=f.bridge();await f.save(configFor([work]));await b.synchronize(resolved(work));await b.refresh();assert.match(b.view().data[0].title,/Work/);
  f.state.hold=e=>e.path.endsWith('/issues')&&e.authorization==='Bearer fixture-work-token';const old=b.refresh({force:true});await waitFor(()=>f.held.length===1);await f.save(configFor([personal]));await b.synchronize(resolved(personal));assert.deepEqual(b.view().data,[]);await b.refresh();assert.match(b.view().data[0].title,/Personal/);f.state.hold=null;f.release();await old;assert.match(b.view().data[0].title,/Personal/);
  assert.doesNotMatch(JSON.stringify(f.calls),/fixture-work-token|fixture-personal-token/);
});

test('All spaces keeps local/remote roots and accounts separate without running provider helpers remotely',async t=>{
  const f=await fixture(t),a=f.input('work','Group/web','/srv/web','server'),b=f.input('personal','Group/web','/repos/web',null),bridge=f.bridge();bridge.selectConfig(configFor([a,b]),resolved(a),{all:true});await bridge.refresh();
  assert.equal(bridge.view().data.length,2);assert.deepEqual(new Set(bridge.view().data.map(row=>row.repoBinding.machine)),new Set(['server',null]));assert.deepEqual(new Set(bridge.view().data.map(row=>row.identity.connectionId)),new Set(['work','personal']));assert.equal(bridge.view().bindings.find(row=>row.binding.machine==='server').checkoutRoot,'/srv/web-linked');assert.equal(bridge.view().bindings.find(row=>row.binding.machine===null).checkoutRoot,'/repos/web');
});

test('captured MR origins survive visible-source removal and acquire a proven base SHA without retargeting',async t=>{
  const f=await fixture(t),a=f.input('work','Group/web','/srv/web','server'),b=f.input('personal','Group/other','/repos/other'),c=configFor([a,b]),bridge=f.bridge({view:'merges'});await f.save(c);bridge.selectConfig(c,resolved(a));await bridge.refresh();const m=bridge.view().data[0],origin=bridge.acquireMergeOrigin(m);
  f.state.hold=e=>e.path.endsWith('/merge_requests/42')&&e.authorization==='Bearer fixture-work-token';const pending=bridge.loadMergeDetails(m,{origin});await waitFor(()=>f.held.length===1);bridge.selectConfig(c,resolved(b));assert.deepEqual(bridge.view().data,[]);assert.equal(bridge.mergeOriginCurrent(origin),true);f.state.hold=null;f.release();const detail=await pending;
  assert.equal(detail.repoBinding.machine,'server');assert.equal(detail.repoBinding.repoRoot,'/srv/web');assert.equal(detail.identity.connectionId,'work');assert.equal(detail.base.sha,BASE);assert.equal(bridge.originEntry(detail,origin).entry.checkoutRoot,'/srv/web-linked');assert.equal(await bridge.validateMergeOrigin(origin),true);assert.deepEqual(bridge.view().data,[]);
  const wrong=copy(detail);wrong.base.sha='c'.repeat(40);const count=f.calls.length;assert.throws(()=>bridge.originEntry(wrong,origin),e=>e.code==='REQUEST_CANCELLED');assert.equal(f.calls.length,count);
  assert.equal(bridge.releaseMergeOrigin(origin),true);assert.equal(bridge.retiredEntries.size,0);await bridge.refresh();assert.match(bridge.view().data[0].title,/Personal/);
});

test('fresh config validation, head/base drift, foreign tokens, TTL/capacity and close revoke captured origins',async t=>{
  const f=await fixture(t),r=f.input(),c=configFor([r]);let now=Date.now();const b=f.bridge({view:'merges',clock:()=>now});await f.save(c);b.selectConfig(c,resolved(r));await b.refresh();let m=b.view().data[0],origin=b.acquireMergeOrigin(m);await b.loadMergeDetails(m,{origin});
  const changed=copy(c);changed.connections.work.auth.tokenEnv='GL_PERSONAL_TOKEN';await f.save(changed);await assert.rejects(b.validateMergeOrigin(origin),e=>e.code==='REQUEST_CANCELLED');await f.save(c);
  const foreign=f.bridge({view:'merges'});origin=b.acquireMergeOrigin(m);assert.equal(foreign.mergeOriginCurrent(origin),false);assert.throws(()=>foreign.releaseMergeOrigin(origin),e=>e.code==='REQUEST_CANCELLED');b.releaseMergeOrigin(origin);
  const tokens=Array.from({length:64},()=>b.acquireMergeOrigin(m));assert.throws(()=>b.acquireMergeOrigin(m),e=>e.code==='REQUEST_CANCELLED');now+=120000;assert.equal(b.mergeOriginCurrent(tokens[0]),false);assert.equal(b.origins.size,0);now=Date.now();
  origin=b.acquireMergeOrigin(m);await b.loadMergeDetails(m,{origin});f.state.bases.set('Group/web','c'.repeat(40));await b.refresh({force:true});assert.equal(b.mergeOriginCurrent(origin),false);f.state.bases.delete('Group/web');await b.refresh({force:true});m=b.view().data[0];origin=b.acquireMergeOrigin(m);f.state.heads.set('Group/web','c'.repeat(40));await b.refresh({force:true});assert.equal(b.mergeOriginCurrent(origin),false);
  origin=b.acquireMergeOrigin(b.view().data[0]);b.close();assert.equal(b.mergeOriginCurrent(origin),false);assert.deepEqual(b.view().data,[]);
});

test('setup saves only GitLab while preserving Jira/GitHub/preferences and rejects profile reuse without writes',async t=>{
  const f=await fixture(t),r=f.input(),c=configFor([r]);const binding=c.bindings[bindingKey(null,r.binding.repoRoot)];delete binding.gitlab;
  c.connections.jira={id:'jira',kind:'api',site:'https://jira.example.invalid',auth:{kind:'basic',usernameEnv:'JIRA_USER',tokenEnv:'JIRA_TOKEN'}};c.connections.gh={id:'gh',kind:'github',site:'https://github.com',apiBase:'https://api.github.com',credentialEnv:'GH_TOKEN'};binding.jira={connectionId:'jira',project:'WEB'};binding.github={connectionId:'gh',owner:'acme',repo:'web'};c.preferences={launch:{pinned:['claude','codex']}};
  const jira=JSON.stringify(binding.jira),github=JSON.stringify(binding.github),preferences=JSON.stringify(c.preferences);await f.save(c);const b=f.bridge();await b.synchronize(resolved(r));assert.equal(b.view().state,'setup');const setup=gitlabSetupModel(c,resolved(r));assert.equal(setup.state,'ready');assert.equal(setup.profiles.length,1);assert.equal(gitlabApiBase(r.connection.site),f.origin+'/api/v4');
  await b.saveSetup({target:setup.target,connection:r.connection,selection:r.binding.gitlab});const saved=await f.config(),target=saved.bindings[bindingKey(null,r.binding.repoRoot)];assert.equal(JSON.stringify(target.jira),jira);assert.equal(JSON.stringify(target.github),github);assert.equal(JSON.stringify(saved.preferences),preferences);assert.equal(target.gitlab.projectPath,'Group/web');assert.equal(f.writes(),1);
  const before=f.requests.length;await assert.rejects(b.saveSetup({target:setup.target,connection:{...r.connection,auth:{kind:'bearer',tokenEnv:'OTHER_TOKEN'}},selection:r.binding.gitlab}),e=>e.code==='CONNECTION_CONFLICT');assert.equal(f.requests.length,before);assert.equal(f.writes(),1);
});

test('canonical-path mismatch shows setup and canonical path without old cards, writes or site changes',async t=>{
  const f=await fixture(t),r=f.input(),c=configFor([r]),b=f.bridge();await f.save(c);b.selectConfig(c,resolved(r));await b.refresh();assert.equal(b.view().data.length,1);const original=await fs.readFile(f.file,'utf8');f.state.canonical.set('Group/web','Group/Web');await b.refresh({force:true});
  assert.deepEqual(b.view().data,[]);assert.equal(b.view().state,'setup');assert.equal(b.view().discovery.state,'canonical');assert.equal(b.view().discovery.probe.projectPath,'Group/Web');assert.equal(b.view().discovery.probe.site,r.connection.site);
  await b.synchronize(resolved(r));assert.equal(b.view().state,'setup');assert.equal(b.view().discovery.probe.projectPath,'Group/Web');
  await assert.rejects(b.saveSetup({target:r.binding,connection:r.connection,selection:r.binding.gitlab}),e=>e.code==='CANONICAL_PROJECT_REQUIRED');assert.equal(await fs.readFile(f.file,'utf8'),original);assert.equal(f.writes(),0);
  f.state.badWeb=true;await assert.rejects(b.discoverProject({target:r.binding,connection:r.connection,selection:r.binding.gitlab}),e=>e.code==='INVALID_SCOPE');assert.equal(await fs.readFile(f.file,'utf8'),original);
});

test('late discovery/save responses are discarded after a newer project or cancelled form',async t=>{
  const f=await fixture(t),r=f.input(),c=configFor([r]),b=f.bridge();await f.save(c);b.selectConfig(c,resolved(r));const draft={target:r.binding,connection:r.connection,selection:r.binding.gitlab},original=await fs.readFile(f.file,'utf8');
  f.state.hold=e=>e.path.endsWith('/Group%2Fweb');const old=b.discoverProject(draft);const oldError=assert.rejects(old,e=>e.code==='REQUEST_CANCELLED');await waitFor(()=>f.held.length===1);const other={...draft,selection:{...draft.selection,projectPath:'Group/other'}};await b.discoverProject(other);assert.equal(b.view().discovery.probe.projectPath,'Group/other');f.state.hold=null;f.release();await oldError;assert.equal(b.view().discovery.probe.projectPath,'Group/other');
  f.state.hold=e=>e.path.endsWith('/Group%2Fweb');const pending=b.saveSetup(draft),cancelled=assert.rejects(pending,e=>e.code==='REQUEST_CANCELLED');await waitFor(()=>f.held.length===1);b.cancelSetup();f.state.hold=null;f.release();await cancelled;assert.equal(await fs.readFile(f.file,'utf8'),original);assert.equal(f.writes(),0);
});

test('weighted scheduling bounds actual HTTP to four across detail helpers and issue batches',async t=>{
  const f=await fixture(t),inputs=Array.from({length:6},(_,i)=>f.input('work','Group/project'+i,'/repos/project'+i)),c=configFor(inputs),issues=f.bridge(),merges=f.bridge({view:'merges'});await f.save(c);issues.selectConfig(c,resolved(inputs[0]),{all:true});merges.selectConfig(c,resolved(inputs[0]),{all:true});await Promise.all([issues.refresh(),merges.refresh()]);
  f.state.delay=15;f.state.peak=0;const rows=merges.view().data;await Promise.all([merges.loadMergeDetails(rows[0]),merges.loadMergeDetails(rows[1]),issues.refresh({force:true})]);assert.ok(f.state.peak<=4,'actual provider reads stay within four, including metadata fanout');assert.ok(f.peak()<=4);assert.equal(f.scopePeak(),1);assert.equal(issues.view().data.length,6);
});

test('a space switch or same-space project rebind cancels an older setup probe',async t=>{
  const f=await fixture(t),r=f.input(),other=f.input('personal','Group/other','/repos/other'),c=configFor([r,other]),b=f.bridge();await f.save(c);b.selectConfig(c,resolved(r));
  const draft={target:r.binding,connection:r.connection,selection:r.binding.gitlab};
  f.state.hold=e=>e.path.endsWith('/Group%2Fweb');let pending=b.discoverProject(draft),cancelled=assert.rejects(pending,e=>e.code==='REQUEST_CANCELLED');await waitFor(()=>f.held.length===1);b.selectConfig(c,resolved(other));f.state.hold=null;f.release();await cancelled;assert.equal(b.view().discovery,null);
  b.selectConfig(c,resolved(r));f.state.hold=e=>e.path.endsWith('/Group%2Fweb');pending=b.discoverProject(draft);cancelled=assert.rejects(pending,e=>e.code==='REQUEST_CANCELLED');await waitFor(()=>f.held.length===1);
  const changed=copy(c);changed.bindings[bindingKey(null,r.binding.repoRoot)].gitlab.projectPath='Group/changed';await f.save(changed);b.selectConfig(changed,resolved(r));f.state.hold=null;f.release();await cancelled;assert.equal(b.view().discovery,null);assert.equal((await f.config()).bindings[bindingKey(null,r.binding.repoRoot)].gitlab.projectPath,'Group/changed');assert.equal(f.writes(),0);
});

test('malformed config is preserved and helper errors never publish stderr or credential values',async t=>{
  const f=await fixture(t),r=f.input(),b=f.bridge();await fs.writeFile(f.file,'{ malformed original');await b.synchronize(resolved(r));assert.equal(b.view().state,'error');assert.deepEqual(b.view().data,[]);assert.equal(await fs.readFile(f.file,'utf8'),'{ malformed original');assert.equal(f.writes(),0);
  await f.save(configFor([r]));await b.synchronize(resolved(r));f.state.status=401;await b.refresh();assert.equal(b.view().errors[0].error.code,'AUTH_REQUIRED');assert.doesNotMatch(JSON.stringify(b.view()),/PRIVATE_PROVIDER_BODY|fixture-work-token/);
  const count=f.requests.length;const invalid=await dispatchGitlab({...r,operation:'pulls'},{env:f.env,api:{ca:f.ca}});assert.equal(invalid.error.code,'INVALID_REQUEST');assert.equal(f.requests.length,count);
  const fake=new GitlabDataBridge({...f.io,exec:async()=>({code:0,stdout:JSON.stringify({v:1,ok:false,error:{code:'AUTH_REQUIRED',message:'PRIVATE_PROVIDER_BODY fixture-work-token'}}),stderr:'PRIVATE_PROVIDER_BODY'})});t.after(()=>fake.close());await assert.rejects(fake.request(r),error=>{assert.equal(error.code,'AUTH_REQUIRED');assert.doesNotMatch(error.message,/PRIVATE|fixture-work-token/);return true;});
});

// Herdr ends an overrunning continuation without catch/finally; its ticket must not show Loading for ever.
test('a load the host ended mid-flight is detected and reloaded instead of staying Loading',async t=>{
  const f=await fixture(t),r=f.input(),c=configFor([r]);await f.save(c);const b=f.bridge({view:'merges'});b.selectConfig(c,resolved(r));
  const entry=[...b.entries.values()][0];assert.ok(entry.cache.begin());b.publish();assert.equal(b.view().state,'loading');assert.equal(b.hasAbandonedLoad(),true);
  await b.recoverAbandoned();assert.equal(b.view().state,'ready');assert.equal(b.view().data[0].key,'GL-MR-42');assert.equal(b.hasAbandonedLoad(),false);
  let now=Date.now();const late=f.bridge({view:'merges',clock:()=>now});late.selectConfig(c,resolved(r));f.state.hold=e=>e.path.endsWith('/merge_requests');const stuck=late.refresh({force:true});await waitFor(()=>f.held.length===1);
  assert.equal(late.hasAbandonedLoad(),false,'A live helper read inside every deadline is not abandoned');now+=STALE_LOAD_MS;assert.equal(late.hasAbandonedLoad(),true);
  const reload=late.recoverAbandoned();f.state.hold=null;f.release();await Promise.all([stuck,reload]);assert.equal(late.view().state,'ready');assert.equal(late.view().data.length,1);assert.equal(late.hasAbandonedLoad(),false);
});

test('the helper queue expires slots and tails that an ended continuation can never release',async()=>{
  let now=0;const queue=new HelperQueue({clock:()=>now}),never=()=>new Promise(()=>{});
  for(let n=0;n<4;n++)queue.run('scope-'+n,()=>true,never);let ran=false;queue.run('scope-0',()=>true,async()=>{ran=true;});
  await new Promise(resolve=>setTimeout(resolve,20));assert.equal(ran,false,'Live holders and tails keep their order and four-slot bound');
  now=STALE_LOAD_MS;assert.equal(await queue.run('scope-0',()=>true,async()=>'recovered'),'recovered');assert.equal(await queue.run('scope-9',()=>true,async()=>'free'),'free');
});
