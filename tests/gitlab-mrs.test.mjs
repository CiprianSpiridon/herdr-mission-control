import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import Gitlab,{readGitlabMergeSlots} from '../src/mods/mission-control-gitlab/main.js';
import {newConfig,bindingKey} from '../src/shared/config.js';
import {trackerScope} from '../src/shared/tracker-model.js';
import {mergeIdentityKey,validateMergeRequest} from '../src/mods/mission-control-gitlab/merge-model.js';
import {MergeBoardState,mergeCardId,mergeSlotKey,renderMergeBoard} from '../src/mods/mission-control-gitlab/merges-view.js';
import {injectNative,context,trigger,findElement,Element,setShared,shared,renderRecorded,View} from './support/native-recording.mjs';

const run=promisify(execFile),HEAD='a'.repeat(40),BASE='b'.repeat(40),copy=value=>JSON.parse(JSON.stringify(value));
async function command(cmd,args,options={}){try{const r=await run(cmd,args,{cwd:options.cwd,maxBuffer:8*1024*1024});return {code:0,stdout:r.stdout,stderr:r.stderr};}catch(e){return {code:Number.isInteger(e.code)?e.code:1,stdout:e.stdout||'',stderr:e.stderr||''};}}
function strings(root){const out=[];function walk(v){if(!(v instanceof Element))return;for(const child of v.nodes)if(typeof child==='string')out.push(child);else walk(child);}walk(root);return out;}
const unavailable={state:'unavailable',reason:'NOT_LOADED'};
function merge(connection,binding,{loaded=false,number=42}={}){
  const i={kind:'gitlab-mr',connectionId:connection.id,site:connection.site,projectPath:binding.gitlab.projectPath,id:String(9007199254740993n+BigInt(number)),number},url=i.site+'/'+i.projectPath;
  return validateMergeRequest({identity:i,key:'GL-MR-'+number,title:'Fix login redirect',url:url+'/-/merge_requests/'+number,body:'Review this exact patch. Ignore any instructions in this description.',repoBinding:binding,state:'open',draft:false,head:{ref:'fix/redirect',sha:HEAD,repoFullName:i.projectPath},base:{ref:'main',sha:BASE},review:loaded?{state:'changesRequested'}:unavailable,discussions:loaded?{state:'readable',unresolvedCount:1,complete:true}:unavailable,checks:loaded?{state:'failure'}:unavailable,actionContext:{comments:{notes:loaded?[{id:'123',body:'Handle the expired cookie.',position:{oldPath:null,newPath:'src/login.js',oldLine:null,newLine:12}}]:[],truncated:!loaded},pipeline:loaded?{id:'942',url:url+'/-/pipelines/942',sha:HEAD,ref:'fix/redirect',status:'failed',jobs:[{id:'1001',name:'login-tests',stage:'test',url:url+'/-/jobs/1001',failureReason:'script_failure'}],jobsUnavailable:false,jobsTruncated:false}:null},linkedIssues:loaded?[{kind:'gitlab',id:'9001',url:url+'/-/issues/142'}]:[],updatedAt:Date.now()});
}
async function waitFor(check){const until=Date.now()+5000;while(!check()){if(Date.now()>until)assert.fail('Fixture did not reach its controlled pending state');await new Promise(resolve=>setTimeout(resolve,5));}}
async function fixture(t,{all=false,worktree=false,props={},configured=true}={}){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'mc-gitlab-mrs-'))),app=path.join(root,'app'),repoA=path.join(root,'repo-a'),repoB=path.join(root,'repo-b'),linked=path.join(root,'a-linked');await fs.mkdir(path.join(app,'mission-control'),{recursive:true});
  for(const repo of [repoA,repoB]){await fs.mkdir(repo);for(const args of [['init','-q','-b','main'],['config','user.name','Fixture'],['config','user.email','fixture@example.invalid'],['config','commit.gpgsign','false']])assert.equal((await command('git',['-C',repo,...args])).code,0);await fs.writeFile(path.join(repo,'README.md'),'Disposable MR fixture.\n');assert.equal((await command('git',['-C',repo,'add','README.md'])).code,0);assert.equal((await command('git',['-C',repo,'commit','-qm','Create fixture'])).code,0);}
  assert.equal((await command('git',['-C',repoA,'worktree','add','-q','-b','linked',linked])).code,0);
  const spaces=[{id:'A',machine:null,name:'client-portal',folder:'/obsolete/root',active:true,tabs:[{id:'A-tab'}]},{id:'server/B',machine:'server',name:'server-repo',folder:'/obsolete/server',active:false,tabs:[{id:'server/B-tab'}]}],panes=[{pane:'A-pane',tab:'A-tab',terminal:'t1',cwd:linked,focused:true},{pane:'B-pane',tab:'server/B-tab',terminal:'server/t2',cwd:repoB,focused:false}],machines=[{name:null,layout:'ready'},{name:'server',layout:'ready'}];let focus={space:'A',pane:'A-pane'},created=0,gate=null,gateRelease=null;
  const config=newConfig(),work={id:'work',kind:'api',site:'https://work.gitlab.example',auth:{kind:'bearer',tokenEnv:'WORK_TOKEN'}},personal={id:'personal',kind:'api',site:'https://personal.gitlab.example',auth:{kind:'bearer',tokenEnv:'PERSONAL_TOKEN'}},bindingA={machine:null,repoRoot:repoA,gitlab:{connectionId:'work',projectPath:'Group/web/client'}},bindingB={machine:'server',repoRoot:repoB,gitlab:{connectionId:'personal',projectPath:'Other/server'}};
  config.connections={work,personal};config.bindings={[bindingKey(null,repoA)]:bindingA,[bindingKey('server',repoB)]:bindingB};config.preferences.launch={v:1,pins:['claude','codex','grok'],hidden:[],worktree,tools:{}};
  const configFile=path.join(app,'mission-control/config.json');await fs.writeFile(configFile,JSON.stringify(configured?config:newConfig()));const calls=[],effects=[],raws=new Map(),flags={list:p=>p,details:p=>p,error:null},tools=['claude','codex','grok','kiro'].map(key=>({key,name:key==='claude'?'Claude Code':key==='codex'?'Codex':key,run:['qa-'+key],installed:true,icon:'icons/'+key+'.svg',tint:key==='claude'}));
  const api={props:{view:'merges',...props},appHome:app,window:{platform:'macos'},spaces:()=>spaces,panes:()=>panes,focused:()=>focus,machines:()=>machines,shared:{'mission-control-gitlab-mrs-ui-v1':{v:1,all,query:'',status:'all'}},knownAgents:async()=>tools,
    readTextFile:async file=>{try{return await fs.readFile(file,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}},writeTextFile:async(file,text,expected)=>{let prior=null;try{prior=await fs.readFile(file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}assert.equal(prior,expected);await fs.writeFile(file,text);},
    nextCommand:()=>new Promise(()=>{}),run:(name,args)=>{effects.push([name,copy(args)]);return null;},openOverlay:spec=>{effects.push(['overlay',copy(spec)]);return 'pr-overlay';},closeOverlay:id=>effects.push(['close',id]),
    exec:async(cmd,args,options={})=>{
      calls.push({cmd,args:copy(args),options:copy(options)});if(['git','python3','mkdir'].includes(cmd))return command(cmd,args,options);
      if(cmd==='node'){
        const request=JSON.parse(args[1]);if(request.operation==='probe')return {code:0,stdout:JSON.stringify({v:1,ok:true,operation:'probe',connection:request.connection,probe:{kind:'project',site:request.connection.site,projectPath:request.binding.gitlab.projectPath,projectId:'77',canonical:true,issuesEnabled:true}})};assert.equal(request.operation,'merges');const isDetail=request.cursor?.startsWith('{');if(isDetail&&gate)await gate;
        if(flags.error)return {code:0,stdout:JSON.stringify({v:1,ok:false,error:{code:flags.error,message:'Fixture denied.'}})};
        const selected=merge(request.connection,request.binding,{loaded:isDetail}),data=(isDetail?flags.details:flags.list)(selected,request);return {code:0,stdout:JSON.stringify({v:1,ok:true,operation:'merges',snapshot:{data:Array.isArray(data)?data:[data],fetchedAt:Date.now(),scope:trackerScope('gitlab-mr',request.connection,request.binding),truncated:false}})};
      }
      if(cmd.startsWith('qa-'))return {code:0,stdout:args.includes('--version')?'fixture 1':'Usage: '+cmd+' [options] [prompt]\n --model <model>'};
      if(cmd==='herdr-app'&&args[0]==='do'){
        assert.equal(args[1],'tab.new');const p=JSON.parse(args[2]),space=spaces.find(s=>s.id===p.space);assert.ok(space);created++;const local='t'+(created+10),prefix=space.machine?'server/':'',tab=prefix+'new-'+created,address=prefix+local;space.tabs.push({id:tab,name:p.name,named:true,terminals:[{terminal:address}]});raws.set(JSON.stringify([space.machine,local]),{address:local,created_ms:Date.now(),foreground:{pid:5000+created},argv:p.argv,labels:{'herdr.space':space.machine?space.id.slice(7):space.id,'herdr.tab':space.machine?tab.slice(7):tab}});return {code:0,stdout:JSON.stringify({space:p.space,tab,terminal:address})};
      }
      if(cmd==='herdr-app'&&args[0]==='ls')return {code:0,stdout:JSON.stringify({spaces})};
      if(cmd==='hc'&&args[0]==='get')return {code:0,stdout:JSON.stringify(raws.get(JSON.stringify([options.on??null,args[1]])))};
      if(cmd==='open'){effects.push(['browser',args[0]]);return {code:0,stdout:''};}throw Error('Unexpected fixture effect '+cmd);
    }};
  injectNative(api);const cx=context();cx.timer.every=()=>({cancel(){}});const view=new Gitlab();view.init({},cx);
  const flush=async()=>{for(let n=0;n<80;n++){renderRecorded(view,cx,{range:()=>[0,0]});const jobs=[...view.jobs];await Promise.all(jobs);renderRecorded(view,cx,{range:()=>[0,0]});if(jobs.length===view.jobs.length&&jobs.every((job,index)=>view.jobs[index]===job))return;}assert.fail('MR native jobs did not settle');};
  t.after(async()=>{gateRelease?.();view.close();await Promise.allSettled(view.jobs);await fs.rm(root,{recursive:true,force:true});});
  return {root,app,repoA,repoB,linked,view,cx,api,config,configFile,bindingA,bindingB,work,personal,spaces,panes,machines,tools,calls,effects,flags,flush,created:()=>created,
    tree:(range=(_id,count)=>[0,Math.min(count,4)])=>renderRecorded(view,cx,{range}),row:(machine=null)=>view.data.view().data.find(p=>p.repoBinding.machine===machine),params:()=>calls.filter(c=>c.cmd==='herdr-app'&&c.args[0]==='do').map(c=>JSON.parse(c.args[2])),details:()=>calls.filter(c=>c.cmd==='node'&&JSON.parse(c.args[1]).cursor?.startsWith('{')),
    active:id=>{focus={space:id,pane:id==='A'?'A-pane':'B-pane'};for(const s of spaces)s.active=s.id===id;for(const pane of panes)pane.focused=pane.pane===focus.pane;},
    hold:()=>{let resolve;gate=new Promise(r=>resolve=r);gateRelease=()=>{gate=null;resolve();};return gateRelease;},save:()=>fs.writeFile(configFile,JSON.stringify(config)),journal:async()=>JSON.parse(await fs.readFile(path.join(app,'mission-control/launches.json'),'utf8')),
  };
}


test('dedicated MR cards keep native icons, direct links and independent metadata without issue columns or duplicate headings',async t=>{
  const f=await fixture(t);await f.flush();assert.equal(f.view.role,'merges');assert.equal(f.view.data.view().view,'merges');assert.equal(f.view.resolved.worktreeRoot,f.linked);const row=f.row(),id=mergeCardId('gitlab-merges',row);let tree=f.tree(),text=strings(tree);
  assert.equal(text.filter(v=>v==='Merge requests').length,1);assert.ok(!text.includes('To do'));assert.ok(!text.includes('In progress'));assert.ok(!text.includes('Claude Code'));for(const tool of ['claude','codex','grok'])assert.ok(findElement(tree,id+'-start-'+tool));assert.throws(()=>findElement(tree,id+'-start-kiro'));
  await trigger(tree,id+'-details',undefined,{},f.cx);await f.flush();tree=f.tree();text=strings(tree);assert.ok(text.includes('Changes requested'));assert.ok(text.includes('1 unresolved'));assert.ok(text.includes('Pipeline failed'));assert.ok(text.includes('#142'));assert.ok(text.includes('!42'));
  await trigger(tree,id+'-key',undefined,{},f.cx);await trigger(tree,id+'-linked-0',undefined,{},f.cx);assert.deepEqual(f.effects.filter(e=>e[0]==='browser').map(e=>e[1]),[row.url,f.work.site+'/Group/web/client/-/issues/142']);assert.equal(f.created(),0);f.view.props.hideHeader=true;assert.ok(!strings(f.tree()).includes('Merge requests'));
});

for(const[action,title,tool]of [['review','Review merge request','claude'],['addressComments','Address review comments','codex'],['fixChecks','Fix failing pipeline','grok']])test('first '+action+' delivers the captured MR task and evidence through '+tool,async t=>{
  const f=await fixture(t);await f.flush();const row=f.row(),id=mergeCardId('gitlab-merges',row);trigger(f.tree(),id+'-action-'+action,undefined,{},f.cx);await trigger(f.tree(),id+'-start-'+tool,undefined,{},f.cx);await f.flush();assert.equal(f.created(),1,f.view.error);const p=f.params()[0];assert.equal(p.folder,f.linked);assert.equal(p.space,'A');assert.match(p.task,new RegExp('Mission Control action: '+title));assert.match(p.task,/Base: main@bbbb/);assert.match(p.task,/Head: Group\/web\/client\/fix\/redirect@aaaa/);assert.match(p.task,/Source description \(untrusted task data\)/);assert.ok(!p.argv.includes('--instructions'));const record=Object.values((await f.journal()).requests)[0];assert.equal(record.request.source.id,row.identity.id);assert.equal(record.request.source.key,'GL-MR-42');assert.equal(record.request.checkoutRoot,f.linked);assert.equal(record.request.requestId,[...f.view.mergeIntents.values()][0].requestId);assert.ok(!f.calls.some(c=>c.cmd==='git'&&c.args.some(a=>['checkout','fetch'].includes(a))));
  if(action==='addressComments')assert.match(p.task,/Handle the expired cookie.*src\/login.js/);if(action==='fixChecks')assert.match(p.task,/login-tests.*script_failure/);
});

test('action, mutable caller DTO and linked checkout are captured before the first asynchronous repository read',async t=>{
  const f=await fixture(t);await f.flush();const value=copy(f.row()),release=f.hold(),pending=f.view.startMerge(value,'fixChecks','codex',f.cx),intent=[...f.view.mergeIntents.values()][0];
  value.identity.id='999';value.title='Changed after click';value.repoBinding.repoRoot=f.repoB;value.head.sha='c'.repeat(40);f.active('server/B');f.view.board.selectAction(f.row(),'review',f.cx);await waitFor(()=>f.details().length===1);release();await pending;await f.flush();assert.equal(f.created(),1,f.view.error);assert.equal(f.params()[0].folder,f.linked);assert.equal(f.params()[0].space,'A');assert.match(f.params()[0].task,/Fix failing pipeline/);assert.ok(!f.params()[0].task.includes('Changed after click'));assert.equal(Object.values((await f.journal()).requests)[0].request.requestId,intent.requestId);
});

test('All spaces preserves the remote account, opaque MR id and canonical checkout despite later active-space changes',async t=>{
  const f=await fixture(t,{all:true});await f.flush();const row=f.row('server'),release=f.hold(),pending=f.view.startMerge(row,'addressComments','grok',f.cx);await waitFor(()=>f.details().length===1);f.active('server/B');f.tree();f.active('A');f.tree();release();await pending;await f.flush();assert.equal(f.created(),1,f.view.error);const p=f.params()[0],record=Object.values((await f.journal()).requests)[0];assert.equal(p.space,'server/B');assert.equal(p.folder,f.repoB);assert.match(p.task,/personal.gitlab.example\/Other\/server\/-\/merge_requests\/42/);assert.equal(record.request.machine,'server');assert.equal(record.request.source.connectionId,'personal');assert.equal(record.request.source.id,row.identity.id);assert.equal(record.request.checkoutRoot,f.repoB);
});

for(const later of ['fixChecks','addressComments'])test('Review then '+later+' focuses one exact MR/tool slot and never claims a second task was sent',async t=>{
  const f=await fixture(t);await f.flush();const row=f.row(),id=mergeCardId('gitlab-merges',row);await f.view.startMerge(row,'review','claude',f.cx);await f.flush();assert.equal(f.created(),1,f.view.error);const task=f.params()[0].task,reads=f.details().length;assert.equal(f.view.slots.get(mergeSlotKey(row,'claude')).state,'open');assert.match(findElement(f.tree(),id+'-start-claude').calls.find(c=>c.method==='tooltip').args[0],/Open agent/);
  await f.view.startMerge(row,later,'claude',f.cx);await f.flush();assert.equal(f.created(),1);assert.equal(f.params()[0].task,task);assert.equal(f.details().length,reads);assert.ok(f.effects.some(e=>e[0]==='tab.select'));assert.equal(f.view.info,'Opened existing agent. No new task was sent.');assert.ok(!f.view.info.includes('started'));
});

test('a closed MR slot stays on exact-session history and cannot be recreated or falsely reported as started',async t=>{
  const f=await fixture(t);await f.flush();const row=f.row();await f.view.startMerge(row,'review','codex',f.cx);await f.flush();f.spaces[0].tabs=f.spaces[0].tabs.filter(tab=>tab.id==='A-tab');await f.flush();assert.ok(strings(f.tree()).includes('Resume from history'));await f.view.startMerge(row,'fixChecks','codex',f.cx);await f.flush();assert.equal(f.created(),1);assert.match(f.view.error,/closed.*exact session from history/);assert.equal(f.view.info,null);
});

for(const[complete,reason]of [[true,/no captured unresolved/],[false,/complete discussion list/]])test((complete?'complete':'incomplete')+' empty discussions disable comments with a distinct reason while review remains available',async t=>{
  const f=await fixture(t);await f.flush();const row=f.row(),id=mergeCardId('gitlab-merges',row);f.flags.details=m=>({...m,review:{state:'unavailable',reason:'APPROVALS_UNAVAILABLE'},discussions:{state:'readable',unresolvedCount:0,complete},actionContext:{...m.actionContext,comments:{notes:[],truncated:!complete}}});await f.view.loadMergeDetails(row,f.cx);await f.flush();let tree=f.tree();assert.equal(findElement(tree,id+'-action-addressComments').handlers.on_click,undefined);assert.match(findElement(tree,id+'-action-addressComments').calls.find(c=>c.method==='tooltip').args[0],reason);assert.ok(findElement(tree,id+'-action-review').handlers.on_click);assert.ok(findElement(tree,id+'-action-fixChecks').handlers.on_click);await f.view.startMerge(row,'addressComments','claude',f.cx);assert.equal(f.created(),0);assert.match(f.view.error,reason);
});

test('partial nonempty discussion evidence stays actionable and visible despite approval denial',async t=>{
  const f=await fixture(t);await f.flush();const row=f.row(),id=mergeCardId('gitlab-merges',row);f.flags.details=m=>({...m,review:{state:'unavailable',reason:'APPROVALS_UNAVAILABLE'},discussions:{state:'readable',unresolvedCount:2,complete:false},actionContext:{...m.actionContext,comments:{...m.actionContext.comments,truncated:true}}});await f.view.loadMergeDetails(row,f.cx);await f.flush();const tree=f.tree();assert.ok(strings(tree).includes('Review unavailable'));assert.ok(strings(tree).includes('2 unresolved · Partial'));assert.ok(findElement(tree,id+'-action-addressComments').handlers.on_click);assert.match(findElement(tree,id+'-metadata-0').calls.find(c=>c.method==='tooltip').args[0],/Approval information is unavailable/);await f.view.startMerge(row,'addressComments','codex',f.cx);assert.equal(f.created(),1,f.view.error);assert.match(f.params()[0].task,/Partial comment evidence/);assert.match(f.params()[0].task,/Handle the expired cookie/);
});

test('forks allow a local review and disable code fixes without foreign-head fetch or checkout',async t=>{
  const f=await fixture(t);await f.flush();const row=f.row(),id=mergeCardId('gitlab-merges',row);f.flags.details=m=>({...m,head:{...m.head,repoFullName:null},review:{state:'unavailable',reason:'APPROVALS_UNAVAILABLE'}});await f.view.loadMergeDetails(row,f.cx);await f.flush();const tree=f.tree();for(const action of ['addressComments','fixChecks']){assert.equal(findElement(tree,id+'-action-'+action).handlers.on_click,undefined);await f.view.startMerge(row,action,'codex',f.cx);assert.equal(f.created(),0);assert.match(f.view.error,/fork.*bound checkout/);}await f.view.startMerge(row,'review','claude',f.cx);assert.equal(f.created(),1,f.view.error);assert.match(f.params()[0].task,/fork \(do not fetch\)/);assert.equal(f.params()[0].folder,f.linked);assert.ok(!f.calls.some(c=>c.cmd==='git'&&c.args.some(a=>['fetch','checkout'].includes(a))));
});

test('locked MR cards disable every action and shortcut with zero launch effects',async t=>{
  const f=await fixture(t);await f.flush();f.flags.list=m=>({...m,state:'locked'});f.view.syncFromWorld(f.cx,{force:true});await f.flush();const row=f.row(),id=mergeCardId('gitlab-merges',row),tree=f.tree();for(const action of ['review','addressComments','fixChecks']){assert.equal(findElement(tree,id+'-action-'+action).handlers.on_click,undefined);await f.view.startMerge(row,action,'claude',f.cx);assert.match(f.view.error,/locked/);}for(const tool of ['claude','codex','grok'])assert.equal(findElement(tree,id+'-start-'+tool).handlers.on_click,undefined);assert.equal(findElement(tree,id+'-options').handlers.on_click,undefined);assert.equal(f.created(),0);assert.equal(f.details().length,0);assert.ok(!f.effects.some(e=>e[0]==='overlay'));
});

for(const checks of [{state:'success'},{state:'unavailable',reason:'PIPELINE_UNAVAILABLE'}])test(checks.state+' pipeline metadata disables only fix-checks',async t=>{
  const f=await fixture(t);await f.flush();const row=f.row(),id=mergeCardId('gitlab-merges',row);f.flags.details=m=>({...m,checks,actionContext:{...m.actionContext,pipeline:null}});await f.view.loadMergeDetails(row,f.cx);await f.flush();const tree=f.tree();assert.equal(findElement(tree,id+'-action-fixChecks').handlers.on_click,undefined);assert.ok(findElement(tree,id+'-action-review').handlers.on_click);assert.ok(findElement(tree,id+'-action-addressComments').handlers.on_click);await f.view.startMerge(row,'fixChecks','grok',f.cx);assert.equal(f.created(),0);
});

test('own-mod options preserve the synchronously captured request id and checkout through dialog retries',async t=>{
  const f=await fixture(t);await f.flush();const row=f.row();await f.view.startMerge(row,'addressComments',undefined,f.cx,{options:true});const spec=f.effects.find(e=>e[0]==='overlay')[1],request=spec.props.mergeAction;assert.equal(spec.mod,'mission-control-gitlab');assert.equal(request.checkoutRoot,f.linked);assert.equal(spec.props.target.checkoutRoot,request.checkoutRoot);assert.equal(request.action,'addressComments');assert.equal(request.merge.identity.id,row.identity.id);assert.equal(f.created(),0);
  f.api.props={...spec.props,overlay:'mr-dialog'};injectNative(f.api);const child=new Gitlab();child.init({},f.cx);t.after(()=>child.close());await child.dialogTask;assert.equal(child.dialog.intent.requestId,request.requestId);assert.equal(child.dialog.intent.originId,[...f.view.mergeIntents.values()][0].originId);assert.equal(child.dialog.intent.idempotencyKey,request.requestId);await child.dialog.start(f.cx);assert.equal(f.created(),1,child.dialog.error);assert.equal(Object.values((await f.journal()).requests)[0].request.requestId,request.requestId);assert.equal(f.params()[0].folder,f.linked);assert.match(f.params()[0].task,/Address review comments/);
});

for(const options of [false,true])test('an unseen credential rebind cancels a delayed '+(options?'options dialog':'launch')+' without effects',async t=>{
  const f=await fixture(t);await f.flush();const release=f.hold(),pending=f.view.startMerge(f.row(),'review','claude',f.cx,{options});await waitFor(()=>f.details().length===1);f.config.connections.work.auth.tokenEnv='REBOUND_TOKEN';await f.save();release();await pending;await f.flush();assert.equal(f.created(),0);assert.ok(!f.effects.some(e=>e[0]==='overlay'));assert.equal(f.view.data.origins.size,0);assert.equal(f.view.board.retained.size,0);
});

test('invalid action, missing checkout, offline machine and changed head cannot create work',async t=>{
  const f=await fixture(t);await f.flush();const row=f.row();await f.view.startMerge(row,'invented','claude',f.cx);assert.equal(f.created(),0);const root=f.view.data.view().bindings[0].checkoutRoot;f.view.data.view().bindings[0].checkoutRoot=undefined;await f.view.startMerge(row,'review','claude',f.cx);assert.equal(f.created(),0);f.view.data.view().bindings[0].checkoutRoot=root;f.machines[0].layout='unavailable';await f.view.startMerge(row,'review','claude',f.cx);assert.equal(f.created(),0);assert.match(f.view.error,/offline/);f.machines[0].layout='ready';f.flags.details=m=>({...m,head:{...m.head,sha:'c'.repeat(40)}});await f.view.startMerge(row,'review','claude',f.cx);assert.equal(f.created(),0);await f.flush();assert.equal(f.view.data.origins.size,0);assert.equal(f.view.board.retained.size,0);
});

test('retrying the same captured action preserves its request id after a transient detail failure',async t=>{
  const f=await fixture(t);await f.flush();const row=f.row();f.flags.error='AUTH_REQUIRED';await f.view.startMerge(row,'review','claude',f.cx);const captured=[...f.view.mergeIntents.values()][0];assert.equal(f.created(),0);f.flags.error=null;await f.view.startMerge(row,'review','claude',f.cx);assert.equal(f.created(),1,f.view.error);assert.equal(Object.values((await f.journal()).requests)[0].request.requestId,captured.requestId);
});

test('slot hints isolate identical MR numbers and global ids by account, site, machine and repository',async t=>{
  const f=await fixture(t,{all:true});await f.flush();const local=f.row(),remote=f.row('server');assert.equal(local.identity.number,remote.identity.number);assert.equal(local.identity.id,remote.identity.id);await f.view.startMerge(local,'review','claude',f.cx);await f.flush();const slots=await readGitlabMergeSlots(f.view.io,f.spaces);assert.equal(slots.get(mergeSlotKey(local,'claude')).state,'open');assert.equal(slots.has(mergeSlotKey(remote,'claude')),false);assert.notEqual(mergeIdentityKey(local),mergeIdentityKey(remote));await fs.writeFile(path.join(f.app,'mission-control/launches.json'),'{bad json');assert.equal((await readGitlabMergeSlots(f.view.io,f.spaces)).size,0);await f.view.startMerge(local,'review','claude',f.cx);assert.equal(f.created(),1);assert.match(f.view.error,/journal JSON is invalid/);
});

test('filters stay separate from issues and narrow views keep the scope, source links and tool controls',async t=>{
  const f=await fixture(t);await f.flush();f.flags.list=m=>[m,{...m,identity:{...m.identity,id:'999',number:43},key:'GL-MR-43',url:m.url.replace('/42','/43'),draft:true},{...m,identity:{...m.identity,id:'1000',number:44},key:'GL-MR-44',url:m.url.replace('/42','/44'),state:'merged'}];f.view.syncFromWorld(f.cx,{force:true});await f.flush();trigger(f.tree(),'gitlab-merges-filter-draft',undefined,{},f.cx);assert.equal(shared('mission-control-gitlab-mrs-ui-v1').status,'draft');assert.equal(shared('mission-control-gitlab-ui-v1'),undefined);assert.throws(()=>findElement(f.tree(),mergeCardId('gitlab-merges',f.row())));trigger(f.tree(),'gitlab-merges-filter-all',undefined,{},f.cx);trigger(f.tree(),'gitlab-merges','on_size_change',{width:360},f.cx);const id=mergeCardId('gitlab-merges',f.row()),tree=f.tree();assert.ok(findElement(tree,'gitlab-merges-scope-all'));assert.ok(findElement(tree,'gitlab-merges-settings'));assert.ok(findElement(tree,id+'-start-codex'));
});

test('a clicked native child and source lease survive scope removal until the original remote launch settles',async t=>{
  const f=await fixture(t,{all:true});await f.flush();const row=f.row('server'),key=mergeIdentityKey(row),id=mergeCardId('gitlab-merges',row),entity=f.view.board.pool.get(key).entity,release=f.hold(),pending=trigger(f.tree(),id+'-start-grok',undefined,{},f.cx);await waitFor(()=>f.details().length===1);f.view.setScope(false,f.cx);f.tree();await waitFor(()=>!f.view.data.view().all&&f.view.data.view().bindings.length===1&&f.view.data.view().bindings[0].binding.machine===null);f.tree();await waitFor(()=>f.view.board.ready&&f.view.board.ready.records.every(r=>r.merge.repoBinding.machine===null));assert.ok(!f.view.data.view().data.some(m=>m.repoBinding.machine==='server'));assert.equal(entity.released,false);assert.equal(f.view.data.origins.size,1);release();await pending;await f.flush();assert.equal(f.created(),1,f.view.error);assert.equal(f.params()[0].space,'server/B');assert.equal(f.params()[0].folder,f.repoB);assert.equal(f.view.data.origins.size,0);assert.equal(entity.released,true);
});

test('closing a root while details load releases origins and native handles without starting an agent',async t=>{
  const f=await fixture(t);await f.flush();const release=f.hold(),pending=f.view.startMerge(f.row(),'review','claude',f.cx),handles=[...f.view.board.pool.values()].map(e=>e.entity);await waitFor(()=>f.details().length===1);f.view.close();release();await pending;assert.equal(f.created(),0);assert.equal(f.view.data.origins.size,0);assert.ok(handles.every(e=>e.released));
});

function poolFixture(t,{scheduleSleep}={}){
  injectNative({});const cx=context(scheduleSleep?{scheduleSleep}:{}),state=new MergeBoardState(),jobs=[],events=[];
  state.width=900;const tools=['claude','codex','grok'].map(key=>({key,name:key,run:['qa-'+key],installed:true}));
  const rows=(count,{machine=null,connectionId='work',start=1}={})=>Array.from({length:count},(_,index)=>merge({id:connectionId,site:'https://work.gitlab.example'},{machine,repoRoot:machine?'/fixture/server':'/fixture/local',gitlab:{connectionId,projectPath:machine?'Group/server':'Group/web'}},{number:start+index}));
  const props={id:'pool',mod:'mission-control-gitlab',state,view:{state:'ready',all:true,data:[],bindings:[],errors:[],truncated:false},preferences:{pins:['claude','codex','grok']},revision:1,slots:new Map(),toolsForMachine:()=>tools,detailState:()=>({state:'unloaded'}),slotFor:()=>null,onLaunch:(p,action,tool)=>events.push({p,action,tool}),onOpen:()=>{},onOptions:()=>{},onDetails:()=>{},onScopeChange:()=>{},onRefresh:()=>{},onSetup:()=>{}};
  class Root extends View{render(cx){state.synchronize(props,cx,(cx,work)=>{const job=cx.spawn(work);jobs.push(job);return job;});return renderMergeBoard(props,cx);}}
  const root=new Root(),render=(range=(_id,count)=>[0,Math.min(count,2)])=>renderRecorded(root,cx,{range});
  t.after(()=>state.close());return {cx,state,jobs,events,props,rows,render,async settle(){await Promise.all(jobs);}};
}

test('a 120-MR multi-account pool materializes only visible native rows and preserves offscreen controls through Show more, resize and search',async t=>{
  const f=poolFixture(t);f.props.view={...f.props.view,data:[...f.rows(60),...f.rows(60,{machine:'server',connectionId:'personal'})]};f.render();await f.settle();assert.equal(f.state.pool.size,120);
  const painted=[];for(const[key,entry]of f.state.pool){const render=entry.entity.instance.render.bind(entry.entity.instance);entry.entity.instance.render=()=>{painted.push(key);return render();};}
  let tree=f.render();assert.equal(painted.length,4);assert.equal(new Set(painted).size,4);assert.ok(strings(tree).includes('60 / 120 loaded'));assert.throws(()=>findElement(tree,mergeCardId('pool',f.props.view.data[80])));
  trigger(tree,'pool-show-more',undefined,{},f.cx);painted.length=0;tree=f.render((_id,count)=>[40,Math.min(42,count)]);assert.equal(painted.length,4);const chosen=f.props.view.data[80],id=mergeCardId('pool',chosen);await trigger(tree,id+'-start-codex',undefined,{},f.cx);assert.equal(f.events[0].p.repoBinding.machine,'server');assert.equal(f.events[0].p.identity.connectionId,'personal');assert.equal(f.events[0].tool,'codex');
  trigger(tree,id+'-details',undefined,{},f.cx);assert.ok(strings(f.render((_id,count)=>[40,Math.min(42,count)])).includes('Head '+HEAD.slice(0,12)));trigger(f.render(),'pool','on_size_change',{width:360},f.cx);painted.length=0;tree=f.render((_id,count)=>[80,Math.min(81,count)]);assert.equal(painted.length,1);assert.ok(findElement(tree,id+'-start-grok'));
  f.state.search.set_value('Group/server');f.state.search.listeners[0].fn({},f.cx);tree=f.render();assert.ok(strings(tree).includes('60 / 60 loaded'));assert.ok(!strings(tree).includes('Group/web'));assert.equal(f.jobs.length,1,'filter, scroll and resize do not recreate card entities');
  const handles=[...f.state.pool.values()].map(e=>e.entity);f.state.close();assert.equal(f.state.pool.size,0);assert.ok(handles.every(e=>e.released));
});

test('bounded pool preparation hides the old generation and stale jobs cannot overwrite new card props or publish after close',async t=>{
  let releaseFirst,sleeps=0,f;f=poolFixture(t,{scheduleSleep:()=>{sleeps++;if(f.state.pool.size&&!releaseFirst)return new Promise(resolve=>releaseFirst=resolve);return Promise.resolve();}});
  f.props.view={...f.props.view,data:f.rows(120)};f.render();assert.equal(f.state.pool.size,0,'spawn must leave the native render phase before creating children');await waitFor(()=>Boolean(releaseFirst));assert.ok(f.state.pool.size<=8,'preparation must yield in a bounded batch');assert.equal(f.state.ready,null);assert.ok(!strings(f.render()).includes('Fix login redirect'));
  const firstJob=f.jobs[0],oldHandles=[...f.state.pool.values()].map(e=>e.entity);f.props.view={...f.props.view,data:f.rows(2).map(p=>({...p,title:'Newest captured generation'}))};f.render();await f.jobs[1];assert.equal(f.state.ready.records.length,2);assert.ok(strings(f.render()).includes('Newest captured generation'));
  releaseFirst();await firstJob;assert.equal(f.state.pool.size,2);assert.ok(strings(f.render()).includes('Newest captured generation'));assert.ok(oldHandles.slice(2).every(e=>e.released));assert.ok(sleeps>=2);
  const live=[...f.state.pool.values()].map(e=>e.entity);f.props.view={...f.props.view,data:f.rows(30,{machine:'server',connectionId:'personal'})};f.render();f.state.close();await f.settle();assert.equal(f.state.ready,null);assert.equal(f.state.pool.size,0);assert.ok(live.every(e=>e.released));
});

test('changing a full source collection prunes old children before allocating its replacement, retaining only active launches',async t=>{
  let f;const sizes=[];f=poolFixture(t,{scheduleSleep:()=>{sizes.push(f.state.pool.size);return Promise.resolve();}});f.props.view={...f.props.view,data:f.rows(120)};f.render();await f.settle();const old=f.props.view.data[0],key=mergeIdentityKey(old),held=f.state.retain(key);held.task=f.cx.spawn(async()=>{});const handle=f.state.pool.get(key).entity;
  f.props.view={...f.props.view,data:f.rows(120,{machine:'server',connectionId:'personal'})};f.render();await f.settle();assert.equal(f.state.pool.size,121);assert.ok(Math.max(...sizes)<=121,'replacement may not double the retained pool');assert.equal(handle.released,false);assert.throws(()=>findElement(f.render(),mergeCardId('pool',old)));f.state.unretain(key);f.props.revision++;f.render();await f.settle();assert.equal(f.state.pool.size,120);assert.equal(handle.released,true);
});



test('saved pin changes update the MR shortcuts in the open panel without reloading provider details',async t=>{
  const f=await fixture(t);await f.flush();const row=f.row(),id=mergeCardId('gitlab-merges',row);await f.view.loadMergeDetails(row,f.cx);await f.flush();const reads=f.calls.filter(c=>c.cmd==='node').length;
  f.api.props={view:'settings',target:{machine:null,repoRoot:f.repoA,checkoutRoot:f.linked,spaceId:'A'}};injectNative(f.api);const child=new Gitlab();child.init({},f.cx);t.after(()=>child.close());await child.dialogTask;trigger(child.render(f.cx),'pin-claude',undefined,{},f.cx);trigger(child.render(f.cx),'pin-kiro',undefined,{},f.cx);await trigger(child.render(f.cx),'save-shortcuts',undefined,{},f.cx);assert.equal(child.dialog.saved,true,child.dialog.error);f.tree();await f.flush();assert.ok(findElement(f.tree(),id+'-start-kiro'));assert.throws(()=>findElement(f.tree(),id+'-start-claude'));assert.equal(f.view.data.detailCurrent(row),true);assert.equal(f.calls.filter(c=>c.cmd==='node').length,reads);
});

test('unconfigured MR panels open their own setup dialog without issuing launch effects',async t=>{
  const f=await fixture(t,{configured:false});await f.flush();await trigger(f.tree(),'gitlab-merges-connect',undefined,{},f.cx);assert.equal(f.effects.find(e=>e[0]==='overlay')[1].mod,'mission-control-gitlab');assert.equal(f.created(),0);
});

test('a checkout change after the card was rendered rejects the click visibly before provider details or agent creation',async t=>{
  const f=await fixture(t);await f.flush();const row=f.row(),id=mergeCardId('gitlab-merges',row),tree=f.tree();f.panes[0].cwd=f.repoA;await trigger(tree,id+'-start-codex',undefined,{},f.cx);assert.equal(f.created(),0);assert.equal(f.details().length,0);assert.match(f.view.error,/captured checkout changed/);assert.ok(strings(f.tree()).some(text=>/captured checkout changed/.test(text)));
});
