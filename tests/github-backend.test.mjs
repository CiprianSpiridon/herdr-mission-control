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
import {trackerScope,validateSnapshot} from '../src/shared/tracker-model.js';
import {dispatchGithub} from '../src/mods/mission-control-github/backend.mjs';
import {GithubDataBridge,HelperQueue,STALE_LOAD_MS,validateGithubReply,githubApiBase,githubProjectFieldsCursor,githubSetupModel} from '../src/mods/mission-control-github/data.js';
import {prDetailCursor} from '../src/mods/mission-control-github/pull-model.js';

const HEAD='a'.repeat(40),BASE='b'.repeat(40),copy=v=>JSON.parse(JSON.stringify(v));
const mapping=(n=7)=>({project:{owner:'acme',number:n,fieldId:'FIELD_'+n,options:{todo:['todo-'+n],inProgress:['work-'+n],done:['done-'+n]},unmapped:'error'}});
const resolved=input=>({state:'resolved',machine:input.binding.machine,repoRoot:input.binding.repoRoot,worktreeRoot:input.binding.repoRoot+'-linked'});
const configFor=inputs=>{const c=newConfig();for(const r of inputs){c.connections[r.connection.id]=copy(r.connection);c.bindings[bindingKey(r.binding.machine,r.binding.repoRoot)]=copy(r.binding);}return c;};
async function waitFor(check){const until=Date.now()+12000;while(Date.now()<until){if(check())return;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Owned helper fixture did not reach the expected state.');}
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mc-github-backend-')),mod=path.join(root,'mods/mission-control-github'),file=path.join(root,'mission-control/config.json');await fs.mkdir(mod,{recursive:true});await fs.mkdir(path.dirname(file));
  const backend=path.join(mod,'backend.mjs');await build({entryPoints:['src/mods/mission-control-github/backend.mjs'],bundle:true,platform:'node',format:'esm',target:'node22',outfile:backend,banner:{js:'import {createRequire as __mcCreateRequire} from "node:module";const require=__mcCreateRequire(import.meta.url);'},logLevel:'silent'});
  const key=path.join(root,'key.pem'),cert=path.join(root,'cert.pem');execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1','-keyout',key,'-out',cert],{stdio:'ignore'});const ca=await fs.readFile(cert);
  const requests=[],calls=[],held=[],bridges=[],state={hold:null,issueStatus:200,projectError:null,fieldPages:2,fields:null,heads:new Map(),listPages:1,pullCount:1,projectStatuses:false,projectActive:0,projectPeak:0};let origin,active=0,peak=0;
  const repo=name=>({id:900,full_name:'acme/'+name,name,owner:{login:'acme'},html_url:origin+'/acme/'+name,has_issues:true});
  const issue=(name,n=1,personal=false)=>({id:10000+n,node_id:'I_'+n,number:n,title:(personal?'Personal':'Work')+' issue '+n,body:'Fixture issue.',state:n%2?'open':'closed',labels:[],updated_at:'2026-10-30T10:00:00Z',url:origin+'/api/v3/repos/acme/'+name+'/issues/'+n,repository_url:origin+'/api/v3/repos/acme/'+name,html_url:origin+'/acme/'+name+'/issues/'+n});
  const pull=(name,n=42)=>({id:20000+n,node_id:'PR_'+n,number:n,title:'Fix redirect',body:'Fixture PR.',state:'open',merged_at:null,draft:false,user:{login:'alice',html_url:origin+'/alice'},updated_at:'2026-10-30T10:00:00Z',url:origin+'/api/v3/repos/acme/'+name+'/pulls/'+n,html_url:origin+'/acme/'+name+'/pull/'+n,head:{ref:'fix/redirect',sha:state.heads.get(name)||HEAD,repo:repo(name)},base:{ref:'main',sha:BASE,repo:repo(name)}});
  const field=n=>({__typename:'ProjectV2SingleSelectField',id:'FIELD_'+n,name:'Status',options:['todo','work','done'].map(id=>({id:id+'-'+n,name:id}))});
  const server=https.createServer({key:await fs.readFile(key),cert:ca},async(req,res)=>{
    const u=new URL(req.url,origin),chunks=[];for await(const c of req)chunks.push(c);const body=chunks.length?JSON.parse(Buffer.concat(chunks)):null,entry={method:req.method,path:u.pathname,query:Object.fromEntries(u.searchParams),body,authorization:req.headers.authorization};requests.push(entry);
    const send=async()=>{
      if(res.destroyed)return;res.setHeader('content-type','application/json');const route=u.pathname.match(/^\/api\/v3\/repos\/acme\/([^/]+)(?:\/(issues|pulls)(?:\/([0-9]+))?)?$/),personal=req.headers.authorization==='Bearer fixture-personal';
      if(route){const name=route[1];if(!route[2])return res.end(JSON.stringify(repo(name)));
        if(route[2]==='issues'){
          if(state.issueStatus!==200){res.writeHead(state.issueStatus);return res.end('PRIVATE fixture-work');}
          const page=Number(u.searchParams.get('page'));if(page<state.listPages){const next=new URL(u);next.searchParams.set('page',String(page+1));res.setHeader('link','<'+next.href+'>; rel="next"');}
          return res.end(JSON.stringify(state.projectStatuses?Array.from({length:49},(_,i)=>issue(name,i+1,personal)):[issue(name,page,personal)]));
        }
        return res.end(JSON.stringify(route[3]?pull(name,Number(route[3])):Array.from({length:state.pullCount},(_,index)=>pull(name,42+index))));
      }
      if(u.pathname==='/api/graphql'){
        const query=body.query;
        if(query.includes('MissionControlProjectFields')){
          if(state.projectError)return res.end(JSON.stringify({errors:[{type:state.projectError,message:'PRIVATE fixture-work'}],data:{repositoryOwner:null}}));
          const n=body.variables.number,page=body.variables.after?Number(body.variables.after.slice(5)):0,pages=state.fieldPages;
          const nodes=state.fields?state.fields(n,page):[page===0?field(n):{__typename:'ProjectV2Field',id:'TEXT_'+n+'_'+page}];
          return res.end(JSON.stringify({data:{repositoryOwner:{__typename:'Organization',login:body.variables.owner,projectV2:{id:'PROJECT_'+n,number:n,owner:{login:body.variables.owner},fields:{totalCount:pages,nodes,pageInfo:{hasNextPage:page+1<pages,endCursor:page+1<pages?'page-'+(page+1):null}}}}}}));
        }
        if(query.includes('MissionControlIssueStatus')){
          state.projectActive++;state.projectPeak=Math.max(state.projectPeak,state.projectActive);await new Promise(resolve=>setTimeout(resolve,15));
          const nodes=body.variables.ids.map(id=>({__typename:'Issue',id,number:Number(id.slice(2)),state:'OPEN',repository:{name:'web',owner:{login:'acme'}},projectItems:{nodes:[{project:{number:7,owner:{login:'acme'}},fieldValues:{nodes:[{__typename:'ProjectV2ItemFieldSingleSelectValue',name:'Working',optionId:'work-7',field:{id:'FIELD_7'}}],pageInfo:{hasNextPage:false}}}],pageInfo:{hasNextPage:false}}}));state.projectActive--;return res.end(JSON.stringify({data:{nodes}}));
        }
        if(query.includes('MissionControlPullDetail')){
          const p=pull('web',Number(body.variables.id.slice(3)));const node={__typename:'PullRequest',id:p.node_id,number:p.number,url:p.html_url,state:'OPEN',isDraft:false,updatedAt:p.updated_at,repository:{nameWithOwner:'acme/web',url:origin+'/acme/web'},headRefName:p.head.ref,headRefOid:p.head.sha,baseRefName:p.base.ref,baseRefOid:p.base.sha,headRepository:{nameWithOwner:'acme/web',url:origin+'/acme/web'},headRef:{name:p.head.ref,target:{oid:p.head.sha}},baseRef:{name:p.base.ref,target:{oid:p.base.sha}},reviewDecision:null,reviewThreads:{totalCount:0,nodes:[],pageInfo:{hasNextPage:false}},statusCheckRollup:null,closingIssuesReferences:{nodes:[],pageInfo:{hasNextPage:false}}};return res.end(JSON.stringify({data:{node}}));
        }
      }
      res.writeHead(404);res.end('{}');
    };
    if(state.hold?.(entry)){held.push(send);return;}await send();
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});origin='https://127.0.0.1:'+server.address().port;
  const env={...process.env,NODE_EXTRA_CA_CERTS:cert,TEST_GITHUB_WORK:'fixture-work',TEST_GITHUB_PERSONAL:'fixture-personal'};
  const invoke=(command,args,options)=>{
    assert.equal(command,'node');assert.equal(options.cwd,root);assert.equal(Object.hasOwn(options,'on'),false);calls.push(JSON.parse(args[1]));active++;peak=Math.max(peak,active);
    return new Promise((resolve,reject)=>execFile(process.execPath,args,{cwd:root,env,maxBuffer:8*1024*1024,timeout:28000},(error,stdout,stderr)=>{active--;if(error&&typeof error.code!=='number')reject(error);else resolve({code:error?.code||0,stdout,stderr});}));
  };
  const io={appHome:()=>root,exec:invoke,readTextFile:async p=>{try{return await fs.readFile(p,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}},ensureDirectory:p=>fs.mkdir(p,{recursive:true}),writeTextFile:async(p,value,expected)=>{let old;try{old=await fs.readFile(p,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;old=null;}if(old!==expected)throw Object.assign(Error('CAS changed'),{code:'STALE'});await fs.writeFile(p,value);}};
  const input=(id='work',name='web',repoRoot='/repos/'+name,machine=null)=>({v:1,operation:'issues',connection:{id,kind:'github',site:origin,apiBase:origin+'/api/v3',credentialEnv:id==='personal'?'TEST_GITHUB_PERSONAL':'TEST_GITHUB_WORK'},binding:{machine,repoRoot,github:{connectionId:id,owner:'acme',repo:name}}});
  t.after(async()=>{for(const b of bridges)b.close();state.hold=null;while(held.length)await held.shift()();await waitFor(()=>active===0);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(root,{recursive:true,force:true});});
  return {root,file,backend,origin,ca,env,io,input,requests,calls,state,held,field,active:()=>active,peak:()=>peak,release:async()=>{while(held.length)await held.shift()();},save:config=>fs.writeFile(file,JSON.stringify(config)+'\n'),config:async()=>JSON.parse(await fs.readFile(file,'utf8')),bridge:options=>{const b=new GithubDataBridge(io,options);bridges.push(b);return b;},run:async request=>JSON.parse((await invoke('node',[backend,JSON.stringify(request)],{cwd:root})).stdout)};
}

test('a copied mod-only executable returns exact issue, PR and repo-probe packets without Jira',async t=>{
  const f=await fixture(t),r=f.input();for(const operation of ['issues','pulls','probe']){const input={...r,operation},reply=await f.run(input);assert.equal(reply.ok,true,JSON.stringify(reply));assert.deepEqual(validateGithubReply(reply,input),reply);assert.doesNotMatch(JSON.stringify(reply),/fixture-work|fixture-personal/);if(operation==='issues')assert.match(reply.progressHint,/In progress/);if(operation==='probe')assert.equal(reply.probe.kind,'repository');}
  assert.deepEqual(await fs.readdir(path.join(f.root,'mods')),['mission-control-github']);assert.ok(f.requests.every(r=>r.authorization==='Bearer fixture-work'));
  for(const operation of ['issues','pulls']){const reply=await dispatchGithub({...r,operation},{env:f.env,api:{ca:f.ca,concurrency:0}});assert.equal(reply.ok,true,'backend must replace invalid nested pool options');}
});

test('backend serializes actual Projects enrichment and separates public list/detail cursors',async t=>{
  const f=await fixture(t),r=f.input();r.binding.github.status=mapping();f.state.projectStatuses=true;const reply=await dispatchGithub(r,{env:f.env,api:{ca:f.ca,concurrency:4}});assert.equal(reply.ok,true,JSON.stringify(reply));assert.equal(f.state.projectPeak,1);assert.equal(reply.snapshot.data.length,49);
  f.state.projectStatuses=false;f.state.listPages=2;delete r.binding.github.status;const first=await dispatchGithub(r,{env:f.env,api:{ca:f.ca,maxPages:1}});assert.ok(first.snapshot.cursor);const before=f.requests.length;
  for(const change of [{operation:'pulls'},{connection:{...r.connection,credentialEnv:'TEST_GITHUB_PERSONAL'}}]){const result=await dispatchGithub({...r,...change,cursor:first.snapshot.cursor},{env:f.env,api:{ca:f.ca}});assert.equal(result.error.code,'INVALID_SCOPE');}assert.equal(f.requests.length,before);
  const next=await dispatchGithub({...r,cursor:first.snapshot.cursor},{env:f.env,api:{ca:f.ca}});assert.equal(next.snapshot.data[0].key,'GH-2');
});

test('public scope retains raw API profile spelling and rejects changes before provider access',async t=>{
  const f=await fixture(t),r=f.input();r.connection.apiBase+='/';f.state.listPages=2;const first=await dispatchGithub(r,{env:f.env,api:{ca:f.ca,maxPages:1}});assert.equal(first.ok,true);assert.equal(first.snapshot.scope.fingerprint,trackerScope('github',r.connection,r.binding).fingerprint);
  const before=f.requests.length,result=await dispatchGithub({...r,connection:{...r.connection,apiBase:r.connection.apiBase.slice(0,-1)},cursor:first.snapshot.cursor},{env:f.env,api:{ca:f.ca}});assert.equal(result.error.code,'INVALID_SCOPE');assert.equal(f.requests.length,before);
});

test('Projects discovery returns stable single-select IDs across complete pages and no partial success',async t=>{
  const f=await fixture(t),r={...f.input(),operation:'probe',cursor:githubProjectFieldsCursor({owner:'acme',number:7})};let result=await f.run(r);assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.probe.complete,true);assert.deepEqual(result.probe.fields,[{id:'FIELD_7',name:'Status',options:f.field(7).options}]);assert.equal(f.requests.length,3);assert.ok(f.requests.filter(r=>r.method==='POST').every(r=>!r.body.query.includes('mutation')));
  const before=f.requests.length;for(const cursor of [JSON.stringify({v:1,kind:'github-project-fields',owner:'acme',number:7,extra:1}),githubProjectFieldsCursor({owner:'acme',number:7}).replace('"number":7','"number":0'),'bad']){result=await dispatchGithub({...r,cursor},{env:f.env,api:{ca:f.ca}});assert.equal(result.ok,false);}assert.equal(f.requests.length,before);
  f.state.fieldPages=4;const started=f.requests.length;result=await f.run(r);assert.equal(result.error.code,'INCOMPLETE_RESULTS');assert.equal(f.requests.length-started,4);assert.equal(result.probe,undefined);
  f.state.fieldPages=1;
  for(const[fields,code]of [[()=>[{...f.field(7),options:Array.from({length:251},(_,i)=>({id:'option-'+i,name:'State'}))}],'INCOMPLETE_RESULTS'],[()=>[{...f.field(7),options:[{id:'duplicate',name:'A'},{id:'duplicate',name:'B'}]}],'INVALID_RESPONSE'],[()=>[null],'PERMISSION_DENIED'],[()=>[{__typename:'UnknownField',id:'F'}],'INCOMPLETE_RESULTS']]){f.state.fields=fields;result=await f.run(r);assert.equal(result.ok,false);assert.equal(result.error.code,code);assert.equal(result.probe,undefined);}
  f.state.fields=null;
  f.state.projectError='FORBIDDEN';result=await f.run(r);assert.equal(result.error.code,'PERMISSION_DENIED');assert.doesNotMatch(JSON.stringify(result),/PRIVATE|fixture-work/);
});

test('strict helper packets reject extra fields, wrong scope, missing hints and changed detail SHAs',async t=>{
  const f=await fixture(t),r=f.input(),reply=await f.run(r);
  for(const change of [v=>{v.extra=true;},v=>{delete v.progressHint;},v=>{v.snapshot.scope.machine='other';}]){const v=copy(reply);change(v);assert.throws(()=>validateGithubReply(v,r),e=>e.code==='INVALID_RESPONSE');}
  const input={...r,operation:'pulls'},list=await f.run(input),p=list.snapshot.data[0],detail={...input,cursor:prDetailCursor(p)},loaded=await f.run(detail);assert.equal(loaded.ok,true);const wrong=copy(loaded);wrong.snapshot.data[0].head.sha=BASE;assert.throws(()=>validateGithubReply(wrong,detail),e=>e.code==='INVALID_RESPONSE');
});

test('native bridge retains progress hints and clears old account data before late responses',async t=>{
  const f=await fixture(t),r=f.input(),c=configFor([r]);await f.save(c);const b=f.bridge();await b.synchronize(resolved(r));await b.refresh();assert.equal(b.view().data[0].title,'Work issue 1');assert.match(b.view().bindings[0].progressHint,/In progress/);assert.equal(b.view().bindings[0].checkoutRoot,r.binding.repoRoot+'-linked');
  f.state.hold=e=>e.path.endsWith('/issues')&&e.authorization==='Bearer fixture-work';const old=b.refresh({force:true});await waitFor(()=>f.held.length===1);
  const personal=f.input('personal');b.selectConfig(configFor([personal]),resolved(personal));assert.equal(b.view().data.length,0);await b.refresh();assert.equal(b.view().data[0].title,'Personal issue 1');f.state.hold=null;await f.release();await old;assert.equal(b.view().data[0].identity.connectionId,'personal');
});

test('one shared native queue caps helpers at four across scopes and bridge instances',async t=>{
  const f=await fixture(t),inputs=Array.from({length:6},(_,i)=>f.input('work','repo'+i));f.state.hold=e=>e.path.endsWith('/issues');const a=f.bridge(),b=f.bridge();a.selectConfig(configFor(inputs.slice(0,3)),null,{all:true});b.selectConfig(configFor(inputs.slice(3)),null,{all:true});
  const pending=Promise.all([a.refresh(),b.refresh()]);await waitFor(()=>f.held.length===4);assert.equal(f.active(),4);assert.equal(f.calls.length,4);f.state.hold=null;await f.release();await pending;assert.equal(f.peak(),4);assert.equal(a.view().data.length+b.view().data.length,6);
});

test('closing a bridge discards its queued work before another helper can start',async t=>{
  const f=await fixture(t),inputs=Array.from({length:5},(_,i)=>f.input('work','repo'+i));f.state.hold=e=>e.path.endsWith('/issues');const a=f.bridge(),b=f.bridge();a.selectConfig(configFor(inputs.slice(0,4)),null,{all:true});b.selectConfig(configFor(inputs.slice(4)),null,{all:true});
  const first=a.refresh();await waitFor(()=>f.held.length===4);const queued=b.refresh();b.close();f.state.hold=null;await f.release();await first;await queued;assert.equal(f.calls.length,4);assert.equal(b.view().state,'closed');assert.equal(b.view().data.length,0);
});

test('PR list/detail reads serialize and old head generations cannot publish actionable details',async t=>{
  const f=await fixture(t),r=f.input(),b=f.bridge({view:'pulls'});b.selectConfig(configFor([r]),resolved(r));await b.refresh();const p=b.view().data[0];f.state.hold=e=>e.body?.query.includes('MissionControlPullDetail');
  const detail=b.loadPullDetails(p);await waitFor(()=>f.held.length===1);const count=f.calls.length,list=b.refresh({force:true});await new Promise(resolve=>setTimeout(resolve,30));assert.equal(f.calls.length,count,'same scope list must wait for detail helper');f.state.hold=null;await f.release();assert.equal((await detail).head.sha,HEAD);await list;
  f.state.heads.set('web',BASE);f.state.hold=e=>e.path.endsWith('/pulls');const refresh=b.refresh({force:true});await waitFor(()=>f.held.length===1);const stale=b.loadPullDetails(p),rejected=assert.rejects(stale,e=>['REQUEST_CANCELLED','INVALID_SCOPE'].includes(e.code));f.state.hold=null;await f.release();await refresh;await rejected;assert.equal(b.view().data[0].head.sha,BASE);assert.equal(b.detailCurrent(p),false);
});

test('same-scope auth failure retains a timestamped issue snapshot and static error',async t=>{
  const f=await fixture(t),r=f.input(),b=f.bridge();b.selectConfig(configFor([r]),resolved(r));await b.refresh();const fetched=b.view().bindings[0].snapshot.fetchedAt;f.state.issueStatus=401;await b.refresh({force:true});assert.equal(b.view().state,'partial');assert.equal(b.view().data.length,1);assert.equal(b.view().bindings[0].snapshot.fetchedAt,fetched);assert.equal(b.view().errors[0].error.code,'AUTH_REQUIRED');assert.doesNotMatch(JSON.stringify(b.view()),/PRIVATE|fixture-work/);
});

test('setup probes before CAS, saves stable IDs and preserves Jira plus concurrent config edits',async t=>{
  const f=await fixture(t),r=f.input(),c=configFor([r]);c.connections.jira={id:'jira',kind:'api',site:'https://jira.invalid',auth:{kind:'bearer',tokenEnv:'JIRA_TOKEN'}};c.bindings[bindingKey(null,r.binding.repoRoot)].jira={connectionId:'jira',project:'WEB'};await f.save(c);const b=f.bridge();
  const model=githubSetupModel(c,resolved(r));assert.equal(model.connection.id,'work');assert.equal(model.target.repoRoot,r.binding.repoRoot);
  f.state.hold=e=>e.body?.query.includes('MissionControlProjectFields');const pending=b.saveSetup({target:r.binding,connection:r.connection,selection:{...r.binding.github,status:mapping()}});await waitFor(()=>f.held.length===1);const edited=await f.config();edited.preferences.concurrent='kept';edited.revision++;await f.save(edited);f.state.hold=null;await f.release();const saved=await pending;
  assert.deepEqual(saved.config.bindings[bindingKey(null,r.binding.repoRoot)].jira,c.bindings[bindingKey(null,r.binding.repoRoot)].jira);assert.equal(saved.config.preferences.concurrent,'kept');assert.deepEqual(saved.config.bindings[bindingKey(null,r.binding.repoRoot)].github.status,mapping());assert.equal(saved.probe.complete,true);
});

test('denied/incomplete/invalid Projects setup and cancelled probes preserve original config bytes',async t=>{
  const f=await fixture(t),r=f.input();await f.save(configFor([r]));const original=await fs.readFile(f.file,'utf8'),b=f.bridge(),setup={target:r.binding,connection:r.connection,selection:{...r.binding.github,status:mapping()}};
  f.state.projectError='FORBIDDEN';await assert.rejects(b.saveSetup(setup),e=>e.code==='PERMISSION_DENIED');assert.equal(await fs.readFile(f.file,'utf8'),original);f.state.projectError=null;
  f.state.fieldPages=4;await assert.rejects(b.saveSetup(setup),e=>e.code==='INCOMPLETE_RESULTS');assert.equal(await fs.readFile(f.file,'utf8'),original);f.state.fieldPages=2;
  const invalid=copy(setup);invalid.selection.status.project.options.inProgress=['invented'];await assert.rejects(b.saveSetup(invalid),e=>e.code==='STATUS_MAPPING_REQUIRED');assert.equal(await fs.readFile(f.file,'utf8'),original);
  f.state.hold=e=>e.body?.query.includes('MissionControlProjectFields');const pending=b.saveSetup(setup),rejected=assert.rejects(pending,e=>e.code==='REQUEST_CANCELLED');await waitFor(()=>f.held.length===1);b.cancelSetup();f.state.hold=null;await f.release();await rejected;assert.equal(await fs.readFile(f.file,'utf8'),original);
  const count=f.calls.length;await assert.rejects(b.saveSetup({...setup,connection:{...r.connection,credentialEnv:'TEST_GITHUB_PERSONAL'}}),e=>e.code==='CONNECTION_CONFLICT');assert.equal(f.calls.length,count);
});

test('changing a project or profile clears transient choices and rejects late discovery',async t=>{
  const f=await fixture(t),r=f.input(),b=f.bridge(),base={target:r.binding,connection:r.connection,selection:r.binding.github,owner:'acme',number:7};await b.discoverProjectFields(base);assert.equal(b.view().discovery.probe.number,7);
  f.state.hold=e=>e.body?.query.includes('MissionControlProjectFields')&&e.authorization==='Bearer fixture-work';const old=b.discoverProjectFields(base),rejected=assert.rejects(old,e=>e.code==='REQUEST_CANCELLED');await waitFor(()=>f.held.length===1);
  const personal=f.input('personal');const next=b.discoverProjectFields({...base,connection:personal.connection,selection:personal.binding.github,number:8});assert.equal(b.view().discovery.state,'loading');assert.equal(b.view().discovery.probe,undefined);await next;assert.equal(b.view().discovery.probe.number,8);f.state.hold=null;await f.release();await rejected;assert.equal(b.view().discovery.probe.number,8);
});

test('native data bundle has no Node/URL/DOM runtime dependency',async()=>{
  const built=await build({entryPoints:['src/mods/mission-control-github/data.js'],bundle:true,write:false,platform:'neutral',format:'iife',globalName:'githubData',logLevel:'silent'}),sandbox={};const api=vm.runInNewContext(built.outputFiles[0].text+';githubData',sandbox,{timeout:2000});
  assert.equal(api.githubApiBase('https://github.com'),'https://api.github.com');assert.equal(api.githubApiBase('https://tenant.ghe.com'),'https://api.tenant.ghe.com');assert.equal(githubApiBase('https://git.example'),'https://git.example/api/v3');assert.equal(api.githubProjectFieldsCursor({owner:'acme',number:7}),githubProjectFieldsCursor({owner:'acme',number:7}));for(const global of ['process','Buffer','URL','document','window','herdr'])assert.equal(sandbox[global],undefined);
});

test('PR detail presentation never rescans other rows and its immutable membership index follows snapshot/head changes',async t=>{
  const f=await fixture(t),r=f.input(),b=f.bridge({view:'pulls'});f.state.pullCount=32;b.selectConfig(configFor([r]),resolved(r));await b.refresh();
  const entry=b.entries.get(bindingKey(null,r.binding.repoRoot)),initial=b.view().data;assert.equal(initial.length,32);assert.ok(Object.isFrozen(entry.cache.snapshot.data));assert.ok(Object.isFrozen(initial[0].identity));
  assert.throws(()=>{initial[0].identity.number=999;},TypeError);assert.throws(()=>{entry.cache.snapshot.data.pop();},TypeError);
  let rowReads=0;const indexed=new Proxy(entry.cache.snapshot.data,{get(target,key,receiver){if(typeof key==='string'&&/^\d+$/.test(key))rowReads++;return Reflect.get(target,key,receiver);}});entry.cache.snapshot={...entry.cache.snapshot,data:indexed};b.publish();rowReads=0;
  for(const p of initial)assert.equal(b.detailState(p).state,'unloaded');assert.equal(rowReads,0,'Per-card presentation must use current indexed membership, not scan every PR');
  await b.loadPullDetails(initial[0]);assert.equal(b.detailState(initial[0]).state,'ready');assert.equal(b.detailState(initial.at(-1)).state,'unloaded');
  f.state.heads.set('web','c'.repeat(40));f.state.pullCount=1;await b.refresh({force:true});assert.throws(()=>b.pullEntry(initial[0]),e=>e.code==='INVALID_SCOPE');assert.throws(()=>b.pullEntry(initial.at(-1)),e=>e.code==='INVALID_SCOPE');assert.equal(b.view().data[0].head.sha,'c'.repeat(40));assert.equal(b.detailState(b.view().data[0]).state,'unloaded');
  const wrong=copy(b.view().data[0]);wrong.identity.connectionId='another';wrong.repoBinding.github.connectionId='another';assert.throws(()=>b.pullEntry(wrong),e=>e.code==='INVALID_SCOPE');b.clearSelection();assert.throws(()=>b.pullEntry(b.view().data[0]??initial[0]));
});

test('helper failures and secret-bearing error messages remain static in the native view',async t=>{
  const r={v:1,operation:'issues',connection:{id:'work',kind:'github',site:'https://github.com',apiBase:'https://api.github.com',credentialEnv:'WORK_TOKEN'},binding:{machine:null,repoRoot:'/repos/web',github:{connectionId:'work',owner:'acme',repo:'web'}}};
  for(const exec of [async()=>{throw Error('PRIVATE secret');},async()=>({code:0,stdout:'PRIVATE secret'}),async()=>({code:0,stdout:JSON.stringify({v:1,ok:false,error:{code:'AUTH_REQUIRED',message:'PRIVATE secret'}})})]){const b=new GithubDataBridge({appHome:()=>'/private/tmp/fixture',exec});t.after(()=>b.close());b.selectConfig(configFor([r]),resolved(r));await b.refresh();assert.equal(b.view().state,'error');assert.doesNotMatch(JSON.stringify(b.view()),/PRIVATE|secret/);assert.ok(['HELPER_UNAVAILABLE','INVALID_RESPONSE','AUTH_REQUIRED'].includes(b.view().errors[0].error.code));}
});

test('leased PR details survive navigation without publishing/polling hidden origins; nonleased callers still cancel',async t=>{
  const f=await fixture(t),a=f.input(),other=f.input('work','other'),config=configFor([a,other]);await f.save(config);const b=f.bridge({view:'pulls'});b.selectConfig(config,resolved(a));await b.refresh();const p=b.view().data[0],origin=b.acquirePullOrigin(p),second=b.acquirePullOrigin(p);assert.ok(Object.isFrozen(origin));assert.deepEqual(Object.keys(origin),[]);
  f.state.hold=e=>e.body?.query.includes('MissionControlPullDetail');const read=b.loadPullDetails(p,{origin}),otherRead=b.loadPullDetails(p,{origin:second}),plain=b.loadPullDetails(p),plainRejected=assert.rejects(plain,e=>e.code==='REQUEST_CANCELLED');await waitFor(()=>f.held.length===1);const count=f.calls.length;
  b.selectConfig(config,resolved(other));await b.refresh();assert.equal(b.view().data[0].repoBinding.repoRoot,other.binding.repoRoot);assert.ok(b.view().bindings.every(v=>v.binding.repoRoot!==a.binding.repoRoot));assert.equal(b.pullOriginCurrent(origin),true);assert.equal(b.retiredEntries.size,1);const visibleCalls=f.calls.length;await b.refresh({binding:a.binding});assert.equal(f.calls.length,visibleCalls,'hidden origins cannot start a background refresh');assert.equal(visibleCalls,count+1);
  f.state.hold=null;await f.release();assert.equal((await read).identity.owner,'acme');assert.equal((await otherRead).head.sha,HEAD);await plainRejected;assert.equal(b.detailCurrent(p,{origin}),true);assert.equal(b.detailCurrent(p),false);assert.equal(await b.validatePullOrigin(origin),true);assert.ok(b.view().data.every(v=>v.repoBinding.repoRoot===other.binding.repoRoot));
  assert.equal(b.releasePullOrigin(origin),true);assert.equal(b.releasePullOrigin(origin),false);assert.equal(b.retiredEntries.size,1);assert.equal(b.releasePullOrigin(second),true);assert.equal(b.retiredEntries.size,0);assert.equal(b.details.size,0);assert.equal(b.origins.size,0);assert.equal(b.pullOriginCurrent(origin),false);assert.throws(()=>b.loadPullDetails(p,{origin}),e=>e.code==='REQUEST_CANCELLED');
});

test('an acquired origin can begin its explicit detail read after its source leaves the visible selection',async t=>{
  const f=await fixture(t),a=f.input(),other=f.input('work','other'),config=configFor([a,other]);await f.save(config);const b=f.bridge({view:'pulls'});b.selectConfig(config,resolved(a));await b.refresh();const p=b.view().data[0],origin=b.acquirePullOrigin(p);b.selectConfig(config,resolved(other));const result=await b.loadPullDetails(p,{origin});assert.equal(result.identity.repo,'web');assert.equal(b.view().data.length,0);assert.equal(b.detailCurrent(p,{origin}),true);assert.equal(await b.validatePullOrigin(origin),true);b.releasePullOrigin(origin);assert.equal(b.retiredEntries.size,0);
});

test('final saved-config validation rejects unseen account/repo changes, removal and malformed config without provider effects',async t=>{
  const f=await fixture(t),a=f.input(),config=configFor([a]);
  for(const change of [c=>{c.connections.work.credentialEnv='TEST_GITHUB_PERSONAL';},c=>{c.bindings[bindingKey(null,a.binding.repoRoot)].github.repo='other';},c=>{delete c.bindings[bindingKey(null,a.binding.repoRoot)];},()=>null]){
    await f.save(config);const b=f.bridge({view:'pulls'});b.selectConfig(config,resolved(a));await b.refresh();const p=b.view().data[0],origin=b.acquirePullOrigin(p),before=f.calls.length,next=copy(config),result=change(next);if(result===null)await fs.writeFile(f.file,'{broken');else await f.save(next);
    const savedBytes=await fs.readFile(f.file,'utf8');assert.equal(b.pullOriginCurrent(origin),true,'cached config alone cannot observe an external file edit');await assert.rejects(b.validatePullOrigin(origin),e=>e.code==='REQUEST_CANCELLED');assert.equal(b.pullOriginCurrent(origin),false);assert.equal(f.calls.length,before);assert.equal(b.releasePullOrigin(origin),false);assert.equal(b.origins.size,0);assert.equal(await fs.readFile(f.file,'utf8'),savedBytes);
  }
});

test('origin leases enforce capacity, TTL, foreign identity and full captured head/base membership',async t=>{
  const f=await fixture(t),a=f.input(),config=configFor([a]);let now=Date.now();const b=f.bridge({view:'pulls',clock:()=>now});b.selectConfig(config,resolved(a));await b.refresh();const p=b.view().data[0],leases=Array.from({length:64},()=>b.acquirePullOrigin(p)),before=f.calls.length;assert.throws(()=>b.acquirePullOrigin(p),e=>e.code==='REQUEST_CANCELLED');assert.equal(f.calls.length,before);
  const other=f.bridge({view:'pulls'});assert.equal(other.pullOriginCurrent(leases[0]),false);assert.throws(()=>other.releasePullOrigin(leases[0]),e=>e.code==='REQUEST_CANCELLED');assert.throws(()=>b.loadPullDetails({...p,base:{...p.base,sha:HEAD}},{origin:leases[0]}),e=>e.code==='REQUEST_CANCELLED');assert.throws(()=>b.loadPullDetails(p,{origin:Object.freeze({})}),e=>e.code==='REQUEST_CANCELLED');
  now+=119999;assert.equal(b.pullOriginCurrent(leases[0]),true);now++;assert.equal(b.pullOriginCurrent(leases[0]),false);assert.equal(b.origins.size,0);for(const lease of leases)assert.equal(b.releasePullOrigin(lease),false);const next=b.acquirePullOrigin(p);assert.equal(b.pullOriginCurrent(next),true);b.close();assert.equal(b.pullOriginCurrent(next),false);assert.equal(b.releasePullOrigin(next),false);assert.throws(()=>b.acquirePullOrigin(p),e=>e.code==='REQUEST_CANCELLED');
});

test('observed head changes, removed PRs and source rebinding revoke captured origins before action',async t=>{
  const f=await fixture(t),a=f.input(),other=f.input('work','other'),config=configFor([a,other]);const b=f.bridge({view:'pulls'});b.selectConfig(config,resolved(a));await b.refresh();let p=b.view().data[0],origin=b.acquirePullOrigin(p);f.state.heads.set('web',BASE);await b.refresh({force:true});assert.equal(b.pullOriginCurrent(origin),false);
  p=b.view().data[0];origin=b.acquirePullOrigin(p);f.state.pullCount=0;await b.refresh({force:true});assert.equal(b.pullOriginCurrent(origin),false);assert.equal(b.origins.size,0);
  f.state.pullCount=1;await b.refresh({force:true});p=b.view().data[0];origin=b.acquirePullOrigin(p);const changed=copy(config);changed.connections.work.credentialEnv='TEST_GITHUB_PERSONAL';b.selectConfig(changed,resolved(other));assert.equal(b.pullOriginCurrent(origin),false);assert.equal(b.retiredEntries.size,0);assert.equal(b.origins.size,0);
});

test('leased navigation cancels a list ticket without leaving a reused cache permanently pending',async t=>{
  const f=await fixture(t),a=f.input(),other=f.input('work','other'),config=configFor([a,other]),b=f.bridge({view:'pulls'});b.selectConfig(config,resolved(a));await b.refresh();const p=b.view().data[0],origin=b.acquirePullOrigin(p);f.state.hold=e=>e.path.endsWith('/pulls');const old=b.refresh({force:true});await waitFor(()=>f.held.length===1);const count=f.calls.length;
  b.selectConfig(config,resolved(other));b.selectConfig(config,resolved(a));const fresh=b.refresh({force:true});f.state.hold=null;await f.release();await old;await fresh;assert.equal(f.calls.length,count+1);assert.equal(b.view().loading,0);assert.equal(b.entries.get(bindingKey(null,a.binding.repoRoot)).cache.pending,false);assert.equal(b.pullOriginCurrent(origin),true);b.releasePullOrigin(origin);
});

test('closing during a leased detail read revokes ownership and forbids late publication',async t=>{
  const f=await fixture(t),a=f.input(),config=configFor([a]),events=[],b=f.bridge({view:'pulls',onChange:value=>events.push(value.state)});b.selectConfig(config,resolved(a));await b.refresh();const p=b.view().data[0],origin=b.acquirePullOrigin(p);f.state.hold=e=>e.body?.query.includes('MissionControlPullDetail');const pending=b.loadPullDetails(p,{origin}),rejected=assert.rejects(pending,e=>e.code==='REQUEST_CANCELLED');await waitFor(()=>f.held.length===1);b.clearSelection();assert.equal(b.retiredEntries.size,1);b.close();const before=events.length;f.state.hold=null;await f.release();await rejected;assert.equal(events.length,before);assert.equal(b.view().state,'closed');assert.equal(b.view().data.length,0);assert.equal(b.origins.size,0);assert.equal(b.retiredEntries.size,0);assert.equal(b.details.size,0);assert.equal(b.releasePullOrigin(origin),false);
});

test('coalesced detail reads cannot borrow a released caller lease while another origin remains valid',async t=>{
  const f=await fixture(t),a=f.input(),b=f.bridge({view:'pulls'});b.selectConfig(configFor([a]),resolved(a));await b.refresh();const p=b.view().data[0],first=b.acquirePullOrigin(p),second=b.acquirePullOrigin(p);f.state.hold=e=>e.body?.query.includes('MissionControlPullDetail');const pending=b.loadPullDetails(p,{origin:first}),rejected=assert.rejects(pending,e=>e.code==='REQUEST_CANCELLED');await waitFor(()=>f.held.length===1);const before=f.calls.length,valid=b.loadPullDetails(p,{origin:second});b.releasePullOrigin(first);b.clearSelection();f.state.hold=null;await f.release();await rejected;assert.equal((await valid).head.sha,HEAD);assert.equal(f.calls.length,before);assert.equal(b.pullOriginCurrent(second),true);b.releasePullOrigin(second);assert.equal(b.retiredEntries.size,0);assert.equal(b.details.size,0);
});

// Herdr ends an overrunning continuation without catch/finally; its ticket must not show Loading for ever.
test('a load the host ended mid-flight is reloaded and expired queue slots never block helpers',async t=>{
  const f=await fixture(t),r=f.input(),c=configFor([r]);await f.save(c);const b=f.bridge();b.selectConfig(c,resolved(r));
  const entry=[...b.entries.values()][0];assert.ok(entry.cache.begin());b.publish();assert.equal(b.view().state,'loading');assert.equal(b.hasAbandonedLoad(),true);
  await b.recoverAbandoned();assert.equal(b.view().state,'ready');assert.equal(b.view().data[0].title,'Work issue 1');assert.equal(b.hasAbandonedLoad(),false);
  let now=0;const queue=new HelperQueue({clock:()=>now}),never=()=>new Promise(()=>{});for(let n=0;n<4;n++)queue.run('scope-'+n,()=>true,never);let ran=false;queue.run('scope-0',()=>true,async()=>{ran=true;});
  await new Promise(resolve=>setTimeout(resolve,20));assert.equal(ran,false,'Live holders and tails keep their order and four-slot bound');now=STALE_LOAD_MS;assert.equal(await queue.run('scope-0',()=>true,async()=>'recovered'),'recovered');
});
