import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
import {build} from 'esbuild';
import {fetchGitlabMerges} from '../src/mods/mission-control-gitlab/merges.mjs';
import {validateMergeRequest,mergeIdentityKey,validateMRActionRequest,mrActionAvailability,mrReasonText,mrDetailCursor,mrLaunchSource} from '../src/mods/mission-control-gitlab/merge-model.js';
import {trackerScope} from '../src/shared/tracker-model.js';
import {publicTrackerError} from '../src/shared/tracker-transport.mjs';
import {launch} from '../src/shared/launch.js';
import {parseCapabilities} from '../src/shared/tool-capabilities.js';

const NOW=1800000000000,HEAD='a'.repeat(40),BASE='b'.repeat(40),copy=value=>JSON.parse(JSON.stringify(value));
const safeError=code=>error=>{assert.equal(error.code,code);assert.doesNotMatch(error.stack+JSON.stringify(publicTrackerError(error)),/fixture-private-token|PRIVATE_PROVIDER_BODY/);return true;};
function sample(){return {identity:{kind:'gitlab-mr',connectionId:'gl-work',site:'https://gitlab.example.test',projectPath:'Group/web/client',id:'9007199254740993',number:42},key:'GL-MR-42',title:'Repair login redirect',url:'https://gitlab.example.test/Group/web/client/-/merge_requests/42',body:'Task details.',repoBinding:{machine:'server',repoRoot:'/srv/client',gitlab:{connectionId:'gl-work',projectPath:'Group/web/client'}},state:'open',draft:true,head:{ref:'fix/login',sha:HEAD,repoFullName:'Group/web/client'},base:{ref:'main',sha:BASE},review:{state:'changesRequested'},discussions:{state:'readable',unresolvedCount:1,complete:true},checks:{state:'failure'},actionContext:{comments:{notes:[{id:'123',body:'Handle the expired cookie before redirecting.',position:{oldPath:null,newPath:'src/login.js',oldLine:null,newLine:12}}],truncated:false},pipeline:{id:'942',url:'https://gitlab.example.test/Group/web/client/-/pipelines/942',sha:HEAD,ref:'fix/login',status:'failed',jobs:[{id:'1001',name:'login-tests',stage:'test',url:'https://gitlab.example.test/Group/web/client/-/jobs/1001',failureReason:'script_failure'}],jobsUnavailable:false,jobsTruncated:false}},linkedIssues:[],updatedAt:NOW};}
const action=(merge,verb='review')=>({v:1,action:verb,merge,checkoutRoot:'/srv/worktree',toolKey:'claude',requestId:'request-42'});
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mc-gitlab-mrs-')),key=path.join(root,'key.pem'),cert=path.join(root,'cert.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1','-keyout',key,'-out',cert],{stdio:'ignore'});
  const ca=await fs.readFile(cert),requests=[],projectPath='Group/web/client',projectId=77,prefix='/api/v4/projects/'+encodeURIComponent(projectPath);
  const state={pages:new Map(),rows:new Map(),details:new Map(),approval:{approved:true},discussions:null,discussionNext:null,closing:null,jobs:null,fail:null,now:NOW,advanceDetail:0,advancePage:null,delay:0,active:0,peak:0,noPageMeta:false};let origin;
  const row=(number,change={})=>{const raw={id:String(9007199254740993n+BigInt(number)),iid:number,project_id:projectId,target_project_id:projectId,source_project_id:projectId,title:'Fix MR '+number,description:'Task data. WEB-142 is plain text.',state:'opened',draft:true,work_in_progress:false,source_branch:'fix/'+number,target_branch:'main',sha:HEAD,web_url:origin+'/'+projectPath+'/-/merge_requests/'+number,updated_at:new Date(NOW).toISOString(),...change};state.rows.set(number,raw);return raw;};
  const detail=number=>({...state.rows.get(number),diff_refs:{head_sha:HEAD,start_sha:BASE,base_sha:BASE},head_pipeline:{id:900+number,project_id:projectId,sha:HEAD,ref:'fix/'+number,status:'failed',web_url:origin+'/'+projectPath+'/-/pipelines/'+(900+number),detailed_status:{action:{path:'https://never-fetch.invalid/retry'}}}});
  const server=https.createServer({key:await fs.readFile(key),cert:ca},(req,res)=>{
    const url=new URL(req.url,origin);requests.push({method:req.method,path:url.pathname,query:Object.fromEntries(url.searchParams),authorization:req.headers.authorization});
    state.active++;state.peak=Math.max(state.peak,state.active);res.once('close',()=>state.active--);
    const send=()=>{
      if(res.destroyed)return;const denied=state.fail?.(url);
      if(denied||req.headers.authorization!=='Bearer fixture-private-token'){res.writeHead(denied||401,{'retry-after':'2'});res.end('PRIVATE_PROVIDER_BODY fixture-private-token');return;}
      res.setHeader('content-type','application/json');
      if(url.pathname===prefix){res.end(JSON.stringify({id:projectId,path_with_namespace:projectPath,web_url:origin+'/'+projectPath,issues_enabled:false}));return;}
      if(url.pathname===prefix+'/merge_requests'){
        const page=Number(url.searchParams.get('page')),p=state.pages.get(page)||{rows:[],next:null};
        if(!state.noPageMeta&&p.next!==undefined)res.setHeader('x-next-page',p.next===null?'':String(p.next));
        if(state.advancePage===page){state.now+=24000;state.advancePage=null;}res.end(JSON.stringify(p.rows));return;
      }
      const match=url.pathname.slice(prefix.length).match(/^\/merge_requests\/([1-9][0-9]*)(?:\/(approvals|discussions|closes_issues))?$/);
      if(match){
        const number=Number(match[1]),kind=match[2];
        if(!kind){state.now+=state.advanceDetail;state.advanceDetail=0;res.end(JSON.stringify(state.details.get(number)??detail(number)));return;}
        if(kind==='approvals'){res.end(JSON.stringify(state.approval));return;}
        if(kind==='discussions'){res.setHeader('x-next-page',state.discussionNext===null?'':String(state.discussionNext));res.end(JSON.stringify(state.discussions??[{id:'thread-1',notes:[{id:123,body:'Handle the expired cookie.',resolvable:true,resolved:false,position:{old_path:null,new_path:'src/login.js',old_line:null,new_line:12}}]}]));return;}
        res.setHeader('x-next-page','');res.end(JSON.stringify(state.closing??[{id:700,iid:7,web_url:origin+'/'+projectPath+'/-/issues/7'}]));return;
      }
      const pipeline=url.pathname.slice(prefix.length).match(/^\/pipelines\/([1-9][0-9]*)\/jobs$/);
      if(pipeline){const pipelineId=Number(pipeline[1]);res.setHeader('x-next-page','');res.end(JSON.stringify(state.jobs??[{id:1001,name:'login-tests',stage:'test',status:'failed',failure_reason:'script_failure',pipeline:{id:pipelineId,project_id:projectId,sha:HEAD},commit:{id:HEAD},web_url:origin+'/'+projectPath+'/-/jobs/1001'}]));return;}
      res.writeHead(404);res.end('{}');
    };
    if(state.delay)setTimeout(send,state.delay);else send();
  });
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(root,{recursive:true,force:true});});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});origin='https://127.0.0.1:'+server.address().port;
  const connection={id:'gl-work',kind:'api',site:origin,auth:{kind:'bearer',tokenEnv:'GL_TOKEN'}},binding={machine:'server',repoRoot:'/srv/client',gitlab:{connectionId:connection.id,projectPath}},request={v:1,operation:'merges',connection,binding},options={ca,env:{GL_TOKEN:'fixture-private-token'},clock:()=>state.now};
  const read=cursor=>fetchGitlabMerges({...request,...(cursor?{cursor}:{})},options);
  const selected=async(number=42)=>{const list=await read();return (await read(mrDetailCursor(list.data.find(m=>m.identity.number===number)))).data[0];};
  return {origin,prefix,projectPath,projectId,state,requests,row,detail,request,options,read,selected};
}

test('native model bundles and runs without Node, DOM, timers, network or process globals',async()=>{
  const result=await build({entryPoints:[new URL('../src/mods/mission-control-gitlab/merge-model.js',import.meta.url).pathname],bundle:true,platform:'neutral',format:'iife',globalName:'Model',write:false,logLevel:'silent'});
  const context={};vm.runInNewContext(result.outputFiles[0].text,context,{timeout:1000});
  assert.equal(context.process,undefined);assert.equal(context.Buffer,undefined);assert.equal(context.document,undefined);assert.equal(context.fetch,undefined);assert.equal(context.setTimeout,undefined);
  assert.equal(context.Model.validateMergeRequest(sample()).key,'GL-MR-42');assert.equal(context.Model.mrLaunchSource(action(sample(),'fixChecks')).id,sample().identity.id);
});

test('DTO and action capture require exact global/project/account/machine identity and checkout with no fallback',()=>{
  const m=sample(),c={id:'gl-work',kind:'api',site:m.identity.site,auth:{kind:'bearer',tokenEnv:'TOKEN'}},scope=trackerScope('gitlab-mr',c,m.repoBinding);
  assert.equal(validateMergeRequest(m,{scope}).identity.id,m.identity.id);assert.throws(()=>validateMergeRequest(m,{scope:{...scope,machine:null}}));
  const captured=validateMRActionRequest(action(m),{scope});m.actionContext.comments.notes[0].body='changed later';m.repoBinding.machine='other';assert.equal(captured.merge.repoBinding.machine,'server');assert.match(captured.merge.actionContext.comments.notes[0].body,/expired cookie/);
  for(const change of [{v:2},{checkoutRoot:undefined},{checkoutRoot:'/srv/../escape'},{toolKey:''},{extra:true}])assert.throws(()=>validateMRActionRequest({...action(sample()),...change}));
  const other=sample();other.identity.id='44';assert.notEqual(mergeIdentityKey(other),mergeIdentityKey(sample()));
  for(const change of [m=>m.identity.projectPath='Group/other',m=>m.identity.id='01',m=>m.identity.number=0,m=>m.head.repoFullName='foreign/project',m=>m.actionContext.pipeline.url='https://foreign.invalid/pipeline',m=>m.actionContext.comments.notes[0].position.newPath='../escape',m=>m.actionContext.comments.notes[0].body='',m=>m.discussions.unresolvedCount=2]){const value=sample();change(value);assert.throws(()=>validateMergeRequest(value));}
});

test('availability isolates approval, discussion, fork, locked and empty/partial evidence states',()=>{
  const m=sample();m.review={state:'unavailable',reason:'APPROVALS_UNAVAILABLE'};assert.equal(mrActionAvailability(m,'review').enabled,true);assert.equal(mrActionAvailability(m,'addressComments').enabled,true);
  m.discussions={state:'unavailable',reason:'DISCUSSIONS_UNAVAILABLE'};m.actionContext.comments={notes:[],truncated:true};assert.equal(mrActionAvailability(m,'addressComments').reason,'DISCUSSIONS_UNAVAILABLE');assert.equal(mrActionAvailability(m,'fixChecks').enabled,true);
  m.discussions={state:'readable',unresolvedCount:0,complete:true};assert.equal(mrActionAvailability(m,'addressComments').reason,'NO_ACTIONABLE_COMMENTS');
  m.discussions.complete=false;assert.equal(mrActionAvailability(m,'addressComments').reason,'DISCUSSIONS_PARTIAL');
  const partial=sample();partial.discussions.complete=false;partial.actionContext.comments.truncated=true;assert.equal(mrActionAvailability(partial,'addressComments').enabled,true);assert.match(mrLaunchSource(action(partial,'addressComments')).body,/Partial comment evidence/);
  const fork=sample();fork.head.repoFullName=null;assert.equal(mrActionAvailability(fork,'review').enabled,true);for(const verb of ['addressComments','fixChecks'])assert.equal(mrActionAvailability(fork,verb).reason,'FORK_READ_ONLY');
  fork.state='locked';for(const verb of ['review','addressComments','fixChecks'])assert.equal(mrActionAvailability(fork,verb).reason,'MR_LOCKED');
  const missing=sample();missing.actionContext.pipeline=null;assert.equal(mrActionAvailability(missing,'fixChecks').reason,'PIPELINE_CONTEXT_UNAVAILABLE');assert.throws(()=>mrLaunchSource(action(missing,'fixChecks')),e=>e.code==='MR_ACTION_UNAVAILABLE');assert.match(mrReasonText('PIPELINE_CONTEXT_UNAVAILABLE'),/identity/);
});

test('explicit50-row lists preserve states/draft/global IDs and never enrich the whole collection',async t=>{
  const f=await fixture(t);f.state.pages.set(1,{rows:[f.row(1),f.row(2,{state:'closed',draft:false,work_in_progress:true}),f.row(3,{state:'merged'}),f.row(4,{state:'locked'})],next:null});
  const list=await f.read();assert.deepEqual(list.data.map(m=>m.state),['open','closed','merged','locked']);assert.equal(list.data[1].draft,false);assert.equal(list.data[0].base.sha,null);assert.equal(list.data[0].checks.reason,'NOT_LOADED');assert.notEqual(list.data[0].identity.id,'1');assert.equal(f.requests.length,2);
  assert.deepEqual(f.requests[1].query,{state:'all',per_page:'50',page:'1',order_by:'updated_at',sort:'desc'});assert.ok(f.requests.every(r=>r.method==='GET'));
  f.state.noPageMeta=true;f.state.pages.set(1,{rows:Array.from({length:20},(_,i)=>f.row(i+1)),next:null});assert.equal((await f.read()).data.length,20);assert.equal(f.requests.at(-1).query.per_page,'50');
  f.state.pages.set(1,{rows:Array.from({length:50},(_,i)=>f.row(i+1)),next:null});await assert.rejects(f.read(),safeError('INCOMPLETE_RESULTS'));
  f.state.noPageMeta=false;f.state.pages.set(1,{rows:[f.row(42,{draft:undefined,work_in_progress:true})],next:null});const legacy=await f.read();assert.equal(legacy.data[0].draft,true);
});

test('selected detail enriches nullable base SHA, actual notes, CE approval and failed pipeline/jobs within shared bounds',async t=>{
  const f=await fixture(t);f.state.pages.set(1,{rows:[f.row(42)],next:null});f.state.delay=5;
  const m=await f.selected();assert.equal(m.base.sha,BASE);assert.equal(m.review.state,'changesRequested');assert.equal(m.discussions.unresolvedCount,1);assert.equal(m.checks.state,'failure');assert.match(m.actionContext.comments.notes[0].body,/expired cookie/);assert.equal(m.actionContext.comments.notes[0].position.newLine,12);assert.equal(m.actionContext.pipeline.jobs[0].name,'login-tests');assert.equal(m.linkedIssues[0].id,'700');
  assert.equal(f.requests.filter(r=>r.path===f.prefix+'/merge_requests/42').length,1);assert.ok(f.state.peak<=4);assert.ok(f.state.peak>=2);
  assert.equal(f.requests.find(r=>r.path.endsWith('/discussions')).query.per_page,'100');assert.deepEqual(f.requests.find(r=>r.path.endsWith('/jobs')).query,{'scope[]':'failed',per_page:'50',page:'1'});
  assert.ok(f.requests.every(r=>r.method==='GET'&&!r.path.includes('retry')&&!r.path.includes('trace')));
  const list=(await f.read()).data[0],known={...list,base:{...list.base,sha:BASE}};f.state.details.set(42,{...f.detail(42),diff_refs:{head_sha:HEAD,start_sha:'c'.repeat(40)}});await assert.rejects(f.read(mrDetailCursor(known)),safeError('INVALID_SCOPE'));
});

test('wrong detail identity/refs and foreign selectors fail before metadata publication or account retargeting',async t=>{
  const f=await fixture(t);f.state.pages.set(1,{rows:[f.row(42)],next:null});const m=(await f.read()).data[0],cursor=mrDetailCursor(m),selector=JSON.parse(cursor);
  for(const change of [{machine:null},{repoRoot:'/srv/other'},{identity:{...selector.identity,connectionId:'personal'}},{identity:{...selector.identity,projectPath:'other/project'}}]){const before=f.requests.length;await assert.rejects(f.read(JSON.stringify({...selector,...change})),safeError('INVALID_SCOPE'));assert.equal(f.requests.length,before);}
  for(const change of [{id:'44'},{iid:43},{project_id:88},{sha:'c'.repeat(40),diff_refs:{head_sha:'c'.repeat(40),start_sha:BASE}}]){f.state.details.set(42,{...f.detail(42),...change});const before=f.requests.length;await assert.rejects(f.read(cursor),safeError('INVALID_SCOPE'));assert.equal(f.requests.length,before+2);}
});

test('denied metadata remains independent, forks never read foreign pipelines, and locked actions are disabled',async t=>{
  const f=await fixture(t);f.state.pages.set(1,{rows:[f.row(42)],next:null});
  f.state.fail=url=>url.pathname.endsWith('/approvals')?403:null;let m=await f.selected();assert.equal(m.review.reason,'APPROVALS_UNAVAILABLE');assert.equal(mrActionAvailability(m,'addressComments').enabled,true);assert.equal(mrActionAvailability(m,'review').enabled,true);
  f.state.fail=url=>url.pathname.endsWith('/discussions')?403:null;m=await f.selected();assert.equal(m.review.reason,'DISCUSSIONS_UNAVAILABLE');assert.equal(mrActionAvailability(m,'addressComments').enabled,false);assert.equal(mrActionAvailability(m,'fixChecks').enabled,true);
  f.state.fail=url=>url.pathname.endsWith('/jobs')?403:null;m=await f.selected();assert.equal(m.actionContext.pipeline.jobsUnavailable,true);assert.match(mrLaunchSource(action(m,'fixChecks')).body,/reproduce from local CI/);
  f.state.fail=null;f.state.details.set(42,{...f.detail(42),source_project_id:88,head_pipeline:{...f.detail(42).head_pipeline,project_id:88,web_url:'https://foreign.invalid/fork/-/pipelines/942'}});const before=f.requests.length;m=await f.selected();assert.equal(m.head.repoFullName,null);assert.equal(mrActionAvailability(m,'review').enabled,true);assert.equal(mrActionAvailability(m,'fixChecks').reason,'FORK_READ_ONLY');assert.ok(f.requests.slice(before).every(r=>!r.path.endsWith('/jobs')));
  f.state.details.set(42,{...f.detail(42),state:'locked'});m=await f.selected();for(const verb of ['review','addressComments','fixChecks'])assert.equal(mrActionAvailability(m,verb).reason,'MR_LOCKED');
});

test('99/100-row discussion completeness and bounded hostile note context drive exact action states',async t=>{
  const f=await fixture(t);f.state.pages.set(1,{rows:[f.row(42)],next:null});
  const threads=(count,unresolved=false)=>Array.from({length:count},(_,i)=>({id:'thread-'+i,notes:[{id:i+1,resolvable:true,resolved:!unresolved,body:'Review note '+i}]}));
  f.state.discussions=threads(99);let m=await f.selected();assert.equal(m.review.state,'approved');assert.equal(m.discussions.complete,true);assert.equal(mrActionAvailability(m,'addressComments').reason,'NO_ACTIONABLE_COMMENTS');
  f.state.approval={approved:false,approvals_left:0,approved_by:[{user:{id:1}}]};m=await f.selected();assert.equal(m.review.state,'reviewRequired');
  f.state.approval={approved:true,approvals_left:3};m=await f.selected();assert.equal(m.review.state,'approved');
  f.state.discussions=threads(100);m=await f.selected();assert.equal(m.discussions.state,'readable');assert.equal(m.discussions.complete,false);assert.equal(m.review.reason,'DISCUSSIONS_PARTIAL');assert.equal(mrActionAvailability(m,'addressComments').reason,'DISCUSSIONS_PARTIAL');
  f.state.discussions[0].notes[0].resolved=false;m=await f.selected();assert.equal(m.review.state,'changesRequested');assert.equal(mrActionAvailability(m,'addressComments').enabled,true);assert.match(mrLaunchSource(action(m,'addressComments')).body,/Partial comment evidence/);
  for(const value of [threads(101),{not:'an array'},[{id:'bad',notes:[{id:1,resolvable:true,body:'missing resolved'}]}],[{id:'empty',notes:[{id:1,resolvable:true,resolved:false,body:' '}]}]]){f.state.discussions=value;m=await f.selected();assert.equal(m.discussions.state,'unavailable');assert.equal(mrActionAvailability(m,'addressComments').enabled,false);}
  f.state.discussions=threads(100,true);for(const thread of f.state.discussions){thread.notes[0].body='$(not executed)\u0001🙂'.repeat(1000);thread.notes[0].position={new_path:'../../escape',new_line:12};}
  m=await f.selected();assert.ok(Buffer.byteLength(JSON.stringify(m.actionContext.comments.notes))<=24000);assert.ok(m.actionContext.comments.notes.length<50);assert.equal(m.actionContext.comments.truncated,true);for(const note of m.actionContext.comments.notes){assert.equal(note.position,null);assert.ok(Buffer.byteLength(note.body)<=4000);assert.match(note.body,/\\u0001/);}
});

test('only validated detail head_pipeline supplies checks; budget skips and job/linked scope errors stay honest',async t=>{
  const f=await fixture(t);f.state.pages.set(1,{rows:[f.row(42,{head_pipeline:{status:'success'}})],next:null});
  const statuses=[['success','success'],['failed','failure'],['running','pending'],['pending','pending'],['canceled','unavailable']];
  for(const [status,expected]of statuses){f.state.details.set(42,{...f.detail(42),head_pipeline:{...f.detail(42).head_pipeline,status}});assert.equal((await f.selected()).checks.state,expected);}
  f.state.details.set(42,{...f.detail(42),head_pipeline:null});assert.equal((await f.selected()).checks.reason,'NO_PIPELINE');
  f.state.details.clear();f.state.advanceDetail=24000;const before=f.requests.length;let m=await f.selected();assert.equal(m.discussions.reason,'BUDGET_EXHAUSTED');assert.equal(m.review.reason,'BUDGET_EXHAUSTED');assert.equal(m.checks.state,'failure');assert.equal(m.actionContext.pipeline.jobsUnavailable,true);assert.equal(f.requests.length,before+4);
  f.state.jobs=[{id:1001,name:'test',stage:'test',status:'failed',pipeline:{id:9999},web_url:f.origin+'/'+f.projectPath+'/-/jobs/1001'}];await assert.rejects(f.selected(),safeError('INVALID_SCOPE'));f.state.jobs=null;
  f.state.closing=[{id:700,iid:7,web_url:'https://foreign.invalid/project/-/issues/7'}];await assert.rejects(f.selected(),safeError('INVALID_SCOPE'));
  f.state.closing=[{id:700,iid:7,web_url:f.origin+'/'+f.projectPath+'/-/issues/8'}];await assert.rejects(f.selected(),safeError('INVALID_SCOPE'));
  f.state.closing=[{id:700,title:'JIRA-42'}];const detail=await f.selected();assert.deepEqual(detail.linkedIssues,[]);assert.ok(f.requests.every(r=>r.path.startsWith(f.prefix)));
  f.state.fail=url=>url.pathname.endsWith('/approvals')?429:null;await assert.rejects(f.selected(),safeError('RATE_LIMITED'));
});

test('MR list pagination, deadline cursors, record cap and output continuation preserve scope',async t=>{
  const f=await fixture(t);for(let page=1;page<=3;page++)f.state.pages.set(page,{rows:Array.from({length:page===3?20:50},(_,i)=>f.row((page-1)*50+i+1)),next:page===3?null:page+1});
  let result=await f.read();assert.equal(result.data.length,120);assert.equal(result.truncated,false);
  f.state.advancePage=1;result=await f.read();assert.equal(result.data.length,50);assert.equal(result.truncated,true);const c=result.cursor;assert.equal((await f.read(c)).data.length,70);
  const before=f.requests.length;await assert.rejects(fetchGitlabMerges({...f.request,cursor:c,binding:{...f.request.binding,machine:null}},f.options),safeError('INVALID_SCOPE'));assert.equal(f.requests.length,before);
  for(let page=1;page<=20;page++)f.state.pages.set(page,{rows:Array.from({length:50},(_,i)=>f.row((page-1)*50+i+1)),next:page+1});
  result=await f.read();assert.equal(result.data.length,1000);assert.equal(result.truncated,true);assert.equal(result.cursor,undefined);
  for(let page=1;page<=5;page++)f.state.pages.set(page,{rows:Array.from({length:50},(_,i)=>f.row((page-1)*50+i+1,{description:'x'.repeat(48000)})),next:page===5?null:page+1});
  result=await f.read();assert.equal(result.data.length,150);assert.equal(result.error.code,'RESPONSE_TOO_LARGE');assert.equal((await f.read(result.cursor)).data[0].key,'GL-MR-151');
});

async function launchFixture(t){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'mc-mr-launch-'))),repo=path.join(root,'repo');t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(repo);
  for(const args of [['init','-q','-b','main'],['config','user.name','QA'],['config','user.email','qa@example.invalid'],['commit','--allow-empty','-qm','Initial']])execFileSync('git',['-C',repo,...args],{stdio:'ignore'});
  const texts=new Map(),calls=[],world={spaces:[{id:'A',name:'client',machine:null,folder:repo,tabs:[]}]};
  const tool={key:'claude',name:'Claude',run:['qa-actor'],installed:true};let tab;
  const io={appHome:root,spaces:()=>world.spaces,knownAgents:async()=>[tool],clock:()=>1000,run:()=>{},delay:async()=>{},capabilities:{get:async()=>parseCapabilities(tool,{help:''})},readTextFile:async file=>texts.get(file)??null,ensureDirectory:async()=>{},writeTextFile:async(file,value,expected)=>{if((texts.get(file)??null)!==expected)throw Object.assign(Error('stale'),{code:'STALE'});texts.set(file,value);},exec:async(command,args,options={})=>{
    calls.push({command,args,options});
    if(command==='herdr-app'&&args[0]==='do'){const input=JSON.parse(args[2]);tab=input;world.spaces[0].tabs.push({id:'tab-1',terminals:[{terminal:'t1'}]});return {code:0,stdout:JSON.stringify({space:'A',tab:'tab-1',terminal:'t1'})};}
    if(command==='herdr-app'&&args[0]==='ls')return {code:0,stdout:JSON.stringify(world)};
    if(command==='hc')return {code:0,stdout:JSON.stringify({address:'t1',created_ms:101,foreground:{pid:501},argv:tab.argv,labels:{'herdr.space':'A','herdr.tab':'tab-1'}})};
    try{return {code:0,stdout:execFileSync(command,args,{encoding:'utf8',cwd:options.cwd}),stderr:''};}catch(error){return {code:error.status??1,stdout:error.stdout??'',stderr:error.stderr??''};}
  }};
  return {repo,io,calls,task:()=>tab?.task};
}

test('each isolated first launch delivers its controlled goal, exact refs and actionable evidence to shared launch',async t=>{
  for(const verb of ['review','addressComments','fixChecks']){
    const f=await launchFixture(t),m=sample();m.repoBinding.machine=null;m.repoBinding.repoRoot=f.repo;m.body='$(provider text is data) '+ 'é'.repeat(30000);m.actionContext.comments.notes[0].body='$(not a command) Fix the expired cookie.';
    const request={...action(m,verb),checkoutRoot:f.repo},source=mrLaunchSource(request);
    assert.deepEqual(Object.keys(source),['kind','connectionId','site','id','key','title','url','body']);assert.equal(source.id,m.identity.id);assert.ok(Buffer.byteLength(source.body)<=60000);assert.match(source.body,/description truncated/);
    const result=await launch({requestId:request.requestId,idempotencyKey:request.requestId,originId:'mr-card',spaceId:'A',machine:null,repoRoot:f.repo,checkoutRoot:request.checkoutRoot,toolKey:request.toolKey,worktree:false,source},f.io);
    assert.equal(result.ok,true,JSON.stringify(result));assert.ok(f.task().includes('Base: main@'+BASE));assert.ok(f.task().includes('Head: Group/web/client/fix/login@'+HEAD));assert.match(f.task(),/untrusted task data/);
    if(verb==='review')assert.match(f.task(),/without local or provider writes/);
    if(verb==='addressComments'){assert.match(f.task(),/expired cookie/);assert.match(f.task(),/src\/login.js/);assert.match(f.task(),/without replying to or resolving/);}
    if(verb==='fixChecks'){assert.match(f.task(),/login-tests/);assert.match(f.task(),/script_failure/);assert.match(f.task(),/pipelines\/942/);assert.match(f.task(),/without rerunning jobs/);}
    assert.equal(f.calls.filter(call=>call.command==='herdr-app'&&call.args[0]==='do').length,1);assert.ok(f.calls.filter(call=>call.command==='git').every(call=>!call.args.some(arg=>arg.includes('provider text'))));
  }
  const missing=sample();missing.actionContext.comments.notes=[];missing.discussions.unresolvedCount=0;missing.review={state:'approved'};
  assert.throws(()=>mrLaunchSource(action(missing,'addressComments')),e=>e.code==='MR_ACTION_UNAVAILABLE');
});
