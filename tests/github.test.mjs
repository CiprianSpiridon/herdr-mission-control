import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import Github,{captureGithubTarget,githubLaunchSource} from '../src/mods/mission-control-github/main.js';
import {newConfig,bindingKey} from '../src/shared/config.js';
import {trackerScope} from '../src/shared/tracker-model.js';
import {validateTrackerRequest,publicTrackerError,TrackerError} from '../src/shared/tracker-transport.mjs';
import {validateGithubConnection} from '../src/mods/mission-control-github/auth.mjs';
import {githubProgressHint} from '../src/mods/mission-control-github/issues.mjs';
import {issueCardId} from '../src/shared/issue-board.js';
import {injectNative,context,trigger,findElement,Element} from './support/native-recording.mjs';

const exec=promisify(execFile);
async function command(cmd,args,options={}){try{const r=await exec(cmd,args,{cwd:options.cwd,maxBuffer:8*1024*1024});return {code:0,stdout:r.stdout,stderr:r.stderr};}catch(e){return {code:Number.isInteger(e.code)?e.code:1,stdout:e.stdout||'',stderr:e.stderr||''};}}
const source=(c,b)=>({identity:{kind:'github',connectionId:c.id,site:c.site,id:'100142'},key:'GH-142',title:'Fix login redirect',url:c.site+'/'+b.github.owner+'/'+b.github.repo+'/issues/142',body:'Task text from the selected GitHub issue.',statusGroup:'todo',statusName:'Open',priority:'High',repoBinding:b});
function visibleStrings(root){const out=[];function walk(v){if(!(v instanceof Element))return;for(const child of v.nodes)if(typeof child==='string')out.push(child);else walk(child);}walk(root);return out;}
async function fixture(t,{props={},all=false,worktree=false,configured=true}={}){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'mc-github-view-'))),app=path.join(root,'app'),repoA=path.join(root,'repo-a'),repoB=path.join(root,'repo-b'),linked=path.join(root,'a-linked');await fs.mkdir(path.join(app,'mission-control'),{recursive:true});
  for(const repo of [repoA,repoB]){await fs.mkdir(repo);for(const args of [['init','-q','-b','main'],['config','user.name','Fixture'],['config','user.email','fixture@example.invalid'],['config','commit.gpgsign','false']])assert.equal((await command('git',['-C',repo,...args])).code,0);await fs.writeFile(path.join(repo,'README.md'),'Disposable Github View fixture.\n');assert.equal((await command('git',['-C',repo,'add','README.md'])).code,0);assert.equal((await command('git',['-C',repo,'commit','-qm','Create fixture'])).code,0);}
  assert.equal((await command('git',['-C',repoA,'worktree','add','-q','-b','fixture-linked',linked])).code,0);
  const a={id:'A',name:'client-portal',machine:null,folder:'/stale/creation-folder',active:true,tabs:[{id:'A-tab'}]},b={id:'server/B',name:'server-repo',machine:'server',folder:'/stale/server-folder',active:false,tabs:[{id:'server/B-tab'}]},world={spaces:[a,b]},panes=[{pane:'A-pane',tab:'A-tab',terminal:'t1',cwd:linked,focused:true},{pane:'B-pane',tab:'server/B-tab',terminal:'server/t2',cwd:repoB,focused:false}],machines=[{name:null,layout:'ready'},{name:'server',layout:'ready'}];let focus={space:'A',pane:'A-pane'},created=0,probeGate=null;
  const config=newConfig(),work={id:'work',kind:'github',site:'https://github.com',apiBase:'https://api.github.com',credentialEnv:'WORK_TOKEN'},personal={id:'personal',kind:'github',site:'https://git.example.invalid',apiBase:'https://git.example.invalid/api/v3',credentialEnv:'PERSONAL_TOKEN'};config.connections={work,personal};const bindingA={machine:null,repoRoot:repoA,github:{connectionId:'work',owner:'acme',repo:'web'}},bindingB={machine:'server',repoRoot:repoB,github:{connectionId:'personal',owner:'personal',repo:'server'}};config.bindings={[bindingKey(null,repoA)]:bindingA,[bindingKey('server',repoB)]:bindingB};config.preferences.launch={v:1,pins:['claude','codex','grok'],hidden:[],worktree,tools:{}};
  const configFile=path.join(app,'mission-control/config.json');await fs.writeFile(configFile,JSON.stringify(configured?config:newConfig()));const effects=[],raws=new Map(),calls=[],flags={probeError:null};
  const tools=['claude','codex','grok','kiro'].map(key=>({key,name:key==='claude'?'Claude Code':key==='codex'?'Codex':key,icon:'icons/'+key+'.svg',tint:key==='claude',installed:true,run:['qa-'+key]}));
  const api={props,spaces:()=>world.spaces,panes:()=>panes,focused:()=>focus,machines:()=>machines,window:{platform:'macos'},appHome:app,shared:{'mission-control-github-ui-v1':{v:1,all,query:'',status:'all'}},knownAgents:async()=>tools,
    readTextFile:async file=>{try{return await fs.readFile(file,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}},writeTextFile:async(file,text,expected)=>{let old;try{old=await fs.readFile(file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;old=null;}assert.equal(old,expected);await fs.writeFile(file,text);},
    run:(name,args)=>{effects.push([name,args]);return null;},openOverlay:spec=>{effects.push(['overlay',spec]);return 'own-overlay';},closeOverlay:id=>{effects.push(['close',id]);return null;},nextCommand:()=>new Promise(()=>{}),
    exec:async(cmd,args,options={})=>{
      calls.push({cmd,args:structuredClone(args),options:structuredClone(options)});
      if(cmd==='git'||cmd==='python3'||cmd==='mkdir')return command(cmd,args,options);
      if(cmd==='node'){
        try{const r=validateTrackerRequest(JSON.parse(args[1]),{connectionValidator:validateGithubConnection,source:'github'});if(r.operation==='probe'){if(probeGate)await probeGate;if(flags.probeError)throw new TrackerError(flags.probeError);const c=r.connection,project=r.cursor?JSON.parse(r.cursor):null;const probe=project?{kind:'project-fields',site:c.site,owner:project.owner,number:project.number,projectId:'PROJECT_'+project.number,fields:[{id:'FIELD_'+project.number,name:'Status',options:[{id:'todo-'+project.number,name:'Backlog'},{id:'work-'+project.number,name:'Working'},{id:'done-'+project.number,name:'Complete'}]}],complete:true}:{kind:'repository',site:c.site,owner:r.binding.github.owner,repo:r.binding.github.repo,repositoryId:'900',issuesEnabled:true};return {code:0,stdout:JSON.stringify({v:1,ok:true,operation:'probe',connection:c,probe})};}
          return {code:0,stdout:JSON.stringify({v:1,ok:true,operation:'issues',snapshot:{data:[source(r.connection,r.binding)],fetchedAt:Date.now(),scope:trackerScope('github',r.connection,r.binding),truncated:false},progressHint:githubProgressHint(r.binding)})};
        }catch(e){return {code:0,stdout:JSON.stringify({v:1,ok:false,error:publicTrackerError(e)})};}
      }
      if(cmd.startsWith('qa-'))return {code:0,stdout:args.includes('--version')?'fixture 1':cmd==='qa-claude'?'Claude Code\nUsage: claude [options] [prompt]\n --model <model>':cmd==='qa-codex'?'Codex CLI\nUsage: codex [OPTIONS] [PROMPT]\n --model <MODEL>\n --no-daemon':'Grok Build TUI\nUsage: grok [OPTIONS] [PROMPT]\n --model <MODEL>'};
      if(cmd==='herdr-app'&&args[0]==='do'){
        assert.equal(args[1],'tab.new');const p=JSON.parse(args[2]),space=world.spaces.find(s=>s.id===p.space);assert.ok(space);created++;const local='t'+(created+10),tab=(space.machine?'server/':'')+'new-'+created,address=(space.machine?'server/':'')+local;space.tabs.push({id:tab,name:p.name,named:true,terminals:[{terminal:address}]});raws.set(JSON.stringify([space.machine,local]),{address:local,created_ms:Date.now(),foreground:{pid:5000+created},argv:p.argv,labels:{'herdr.space':space.machine?space.id.slice(7):space.id,'herdr.tab':space.machine?tab.slice(7):tab}});return {code:0,stdout:JSON.stringify({space:p.space,tab,terminal:address})};
      }
      if(cmd==='herdr-app'&&args[0]==='ls')return {code:0,stdout:JSON.stringify(world)};
      if(cmd==='hc'&&args[0]==='get')return {code:0,stdout:JSON.stringify(raws.get(JSON.stringify([options.on??null,args[1]])))};
      if(cmd==='open'){effects.push(['browser',args[0]]);return {code:0,stdout:''};}
      throw Error('Unexpected controlled fixture effect '+cmd);
    }};
  injectNative(api);const cx=context(),timers=[];cx.timer.every=(ms,fn)=>{const timer={ms,fn,cancelled:false,cancel(){this.cancelled=true;}};timers.push(timer);return timer;};const view=new Github();view.init({},cx);
  const flush=async()=>{let previous=-1;for(let n=0;n<20;n++){const jobs=[...view.jobs];await Promise.all(jobs);if(jobs.length===view.jobs.length&&previous===jobs.length)return;previous=jobs.length;}assert.fail('The native View did not settle its finite jobs.');};
  t.after(async()=>{view.close();await Promise.allSettled(view.jobs);await fs.rm(root,{recursive:true,force:true});});
  return {root,app,repoA,repoB,linked,view,cx,api,panes,machines,world,config,configFile,work,personal,bindingA,bindingB,effects,calls,flags,timers,tools,flush,created:()=>created,
    active:id=>{focus={space:id,pane:id==='A'?'A-pane':'B-pane'};for(const space of world.spaces)space.active=space.id===id;for(const pane of panes)pane.focused=pane.pane===focus.pane;},
    panelFocus:()=>{focus={space:focus.space,pane:null};for(const pane of panes)pane.focused=false;},
    edit:(state,value)=>{state.set_value(value);for(const listener of state.listeners.filter(l=>l.event==='change'))listener.fn({},cx);},
    holdProbe:()=>{let resolve;probeGate=new Promise(r=>resolve=r);return ()=>{probeGate=null;resolve();};},
    realApi:()=>({spaces:()=>world.spaces,panes:()=>panes,focused:()=>focus,machines:()=>machines,exec:api.exec}),
  };
}

test('issues role resolves a live linked checkout, renders compact groups and avoids duplicate headings',async t=>{
  const f=await fixture(t,{props:{view:'issues'}});await f.flush();assert.equal(f.view.resolved.repoRoot,f.repoA);assert.equal(f.view.resolved.worktreeRoot,f.linked);assert.equal(f.view.data.view().data.length,1);let tree=f.view.render(f.cx);
  assert.equal(visibleStrings(tree).filter(v=>v==='GitHub').length,1);for(const group of ['todo','inProgress','done'])assert.ok(findElement(tree,'github-board-column-'+group));assert.ok(findElement(tree,'github-progress-hint'));assert.match(findElement(tree,'github-progress-hint').calls.find(c=>c.method==='tooltip').args[0],/Open issues.*To do/);
  const count=f.calls.filter(c=>c.cmd==='node').length;f.panelFocus();f.view.render(f.cx);await f.flush();assert.equal(f.calls.filter(c=>c.cmd==='node').length,count);f.view.props.hideHeader=true;tree=f.view.render(f.cx);assert.equal(visibleStrings(tree).filter(v=>v==='GitHub').length,0);assert.equal(f.timers[0].ms,60000);
});

test('current-space clicks preserve the captured live checkout and stable source ID across active-space changes',async t=>{
  const f=await fixture(t);await f.flush();const pending=f.view.startIssue(f.view.data.view().data[0],'claude',f.cx);f.active('server/B');await pending;assert.equal(f.created(),1,f.view.error);const params=JSON.parse(f.calls.find(c=>c.cmd==='herdr-app'&&c.args[0]==='do').args[2]);assert.equal(params.space,'A');assert.equal(params.folder,f.linked);assert.match(params.task,/GH-142/);
  const journal=JSON.parse(await fs.readFile(path.join(f.app,'mission-control/launches.json'),'utf8')),record=Object.values(journal.requests)[0];assert.equal(record.request.source.id,'100142');assert.equal(record.request.source.key,'GH-142');assert.equal(record.request.checkoutRoot,f.linked);assert.equal(record.request.repoRoot,f.repoA);
});

test('All spaces retains known linked checkouts, defaults uncaptured cards canonically and focuses repeats',async t=>{
  const f=await fixture(t,{all:true});await f.flush();const local=f.view.data.view().data.find(v=>v.identity.connectionId==='work'),remote=f.view.data.view().data.find(v=>v.identity.connectionId==='personal');assert.equal(f.view.data.view().bindings.find(b=>b.binding.machine===null).checkoutRoot,f.linked);
  f.active('server/B');await f.view.startIssue(local,'codex',f.cx);assert.equal(f.created(),1,f.view.error);let params=JSON.parse(f.calls.find(c=>c.cmd==='herdr-app'&&c.args[0]==='do').args[2]);assert.equal(params.space,'A');assert.equal(params.folder,f.linked);
  await f.view.startIssue(local,'codex',f.cx);assert.equal(f.created(),1);assert.ok(f.effects.some(e=>e[0]==='tab.select'));await f.view.startIssue(local,'claude',f.cx);assert.equal(f.created(),1);assert.match(f.view.error,/another tool/);
  f.active('A');await f.view.startIssue(remote,'claude',f.cx);assert.equal(f.created(),2,f.view.error);params=JSON.parse(f.calls.findLast(c=>c.cmd==='herdr-app'&&c.args[0]==='do').args[2]);assert.equal(params.space,'server/B');assert.equal(params.folder,f.repoB);assert.ok(!f.calls.some(c=>c.cmd==='git'&&c.args.includes('/stale/creation-folder')));
});

test('saved worktree defaults create workspace-plus-GH-key names using disposable real Git',async t=>{
  const f=await fixture(t,{worktree:true});await f.flush();await f.view.startIssue(f.view.data.view().data[0],'claude',f.cx);assert.equal(f.created(),1,f.view.error);const params=JSON.parse(f.calls.find(c=>c.cmd==='herdr-app'&&c.args[0]==='do').args[2]);assert.equal(path.basename(params.folder),'client-portal-GH-142');assert.ok((await fs.stat(params.folder)).isDirectory());assert.notEqual(params.folder,f.linked);
});

test('real card handlers open exact URLs and own-mod options while showing only pinned tool icons',async t=>{
  const f=await fixture(t);await f.flush();const row=f.view.data.view().data[0],id=issueCardId('github-board',row),tree=f.view.render(f.cx);await trigger(tree,id+'-key',undefined,{},f.cx);assert.deepEqual(f.effects.find(e=>e[0]==='browser'),['browser',row.url]);assert.equal(f.created(),0);
  for(const tool of ['claude','codex','grok'])assert.ok(findElement(tree,id+'-start-'+tool));assert.throws(()=>findElement(tree,id+'-start-kiro'));assert.ok(!visibleStrings(tree).includes('Claude Code'));assert.ok(!visibleStrings(tree).includes('Codex'));
  await trigger(tree,id+'-options',undefined,{},f.cx);const overlay=f.effects.findLast(e=>e[0]==='overlay')[1];assert.equal(overlay.mod,'mission-control-github');assert.equal(overlay.props.view,'launch');assert.equal(overlay.props.target.checkoutRoot,f.linked);assert.equal(overlay.props.source.id,'100142');assert.equal(f.created(),0);
});

test('offline or mismatched repositories cannot route an issue to the active space',async t=>{
  const f=await fixture(t,{all:true});await f.flush();const remote=f.view.data.view().data.find(v=>v.repoBinding.machine==='server');f.machines.find(m=>m.name==='server').layout='unavailable';await f.view.startIssue(remote,'claude',f.cx);assert.equal(f.created(),0);assert.match(f.view.error,/offline/);
  const local=f.view.data.view().data.find(v=>v.repoBinding.machine===null);await assert.rejects(captureGithubTarget(local,{all:false,resolved:{state:'resolved',spaceId:'server/B',machine:'server',repoRoot:f.repoB},api:f.realApi()}),e=>e.code==='INVALID_SCOPE');assert.equal(f.created(),0);
});

test('a props-bound panel chooses its repository while a GitHub-less repo offers setup',async t=>{
  const f=await fixture(t);await f.flush();f.view.props.target={machine:'server',repoRoot:f.repoB};f.view.contextKey=null;f.view.render(f.cx);await f.flush();assert.equal(f.view.resolved.spaceId,'server/B');assert.equal(f.view.data.view().data[0].identity.connectionId,'personal');assert.ok(visibleStrings(f.view.render(f.cx)).includes('server-repo'));
  const empty=await fixture(t,{configured:false});await empty.flush();assert.equal(empty.view.data.view().state,'setup');const tree=empty.view.render(empty.cx);await trigger(tree,'github-board-connect-action',undefined,{},empty.cx);assert.equal(empty.effects.find(e=>e[0]==='overlay')[1].mod,'mission-control-github');assert.equal(empty.calls.filter(c=>c.cmd==='node').length,0);
});

test('agent-shortcut settings follow the bound repo when another space is active',async t=>{
  const f=await fixture(t);await f.flush();f.view.props.target={machine:'server',repoRoot:f.repoB};f.view.contextKey=null;f.view.render(f.cx);await f.flush();await trigger(f.view.render(f.cx),'github-shortcuts',undefined,{},f.cx);const overlay=f.effects.findLast(e=>e[0]==='overlay')[1];assert.equal(overlay.props.view,'settings');assert.equal(overlay.props.target.spaceId,'server/B');assert.equal(overlay.props.target.repoRoot,f.repoB);assert.equal(overlay.props.target.machine,'server');assert.equal(f.created(),0);
});

test('saving shortcut pins in an own-mod dialog immediately refreshes the issue panel',async t=>{
  const f=await fixture(t);await f.flush();const reads=f.calls.filter(c=>c.cmd==='node').length;f.api.props={view:'settings',target:{spaceId:'A',machine:null,repoRoot:f.repoA,checkoutRoot:f.linked},overlay:'settings'};const child=new Github(),cx=context();child.init({},cx);t.after(()=>child.close());await child.dialogTask;assert.equal(child.dialog.error,null);
  trigger(child.render(cx),'pin-claude',undefined,{},cx);trigger(child.render(cx),'pin-kiro',undefined,{},cx);await trigger(child.render(cx),'save-shortcuts',undefined,{},cx);assert.equal(child.dialog.saved,true,child.dialog.error);
  f.view.render(f.cx);await f.flush();const row=f.view.data.view().data[0],id=issueCardId('github-board',row),tree=f.view.render(f.cx);assert.ok(findElement(tree,id+'-start-kiro'));assert.throws(()=>findElement(tree,id+'-start-claude'));assert.deepEqual(f.view.config.preferences.launch.pins,['codex','grok','kiro']);assert.equal(f.created(),0);assert.equal(f.calls.filter(c=>c.cmd==='node').length,reads,'pin changes must retain cards without refetching tracker scopes');
});

test('gh-account setup probes before saving, preserves failed drafts and never requires Jira',async t=>{
  const f=await fixture(t,{props:{view:'setup',target:{machine:null,repoRoot:'/explicit/repo'},overlay:'setup'}});await f.flush();trigger(f.view.render(f.cx),'github-new-profile',undefined,{},f.cx);trigger(f.view.render(f.cx),'github-auth-gh',undefined,{},f.cx);
  for(const[state,value]of [[f.view.profileId,'team-github'],[f.view.site,'https://github.com'],[f.view.ghAccount,'developer'],[f.view.owner,'acme'],[f.view.repo,'web']])f.edit(state,value);let tree=f.view.render(f.cx);assert.ok(findElement(tree,'github-gh-account'));assert.throws(()=>findElement(tree,'github-token-env'));
  const original=await fs.readFile(f.configFile,'utf8');f.flags.probeError='PERMISSION_DENIED';await trigger(tree,'github-save-setup',undefined,{},f.cx);assert.equal(await fs.readFile(f.configFile,'utf8'),original);assert.equal(f.view.ghAccount.value(),'developer');assert.match(f.view.error,/cannot read/);
  f.flags.probeError=null;await trigger(f.view.render(f.cx),'github-save-setup',undefined,{},f.cx);const saved=JSON.parse(await fs.readFile(f.configFile,'utf8'));assert.deepEqual(saved.connections['team-github'].gh,{host:'github.com',account:'developer'});assert.equal(saved.connections['team-github'].apiBase,'https://api.github.com');assert.ok(f.effects.some(e=>e[0]==='close'&&e[1]==='setup'));
});

test('Projects setup chooses stable fields/options and retained standalone forms survive saving',async t=>{
  const f=await fixture(t,{props:{view:'setup',target:{machine:null,repoRoot:'/explicit/project'}}});await f.flush();trigger(f.view.render(f.cx),'github-new-profile',undefined,{},f.cx);
  for(const[state,value]of [[f.view.tokenEnv,'WORK_TOKEN'],[f.view.owner,'acme'],[f.view.repo,'web'],[f.view.projectOwner,'acme'],[f.view.projectNumber,'7']])f.edit(state,value);trigger(f.view.render(f.cx),'github-mapping-project',undefined,{},f.cx);await trigger(f.view.render(f.cx),'github-load-fields',undefined,{},f.cx);assert.equal(f.view.projectFieldId,null,'discovery must not guess a field');trigger(f.view.render(f.cx),'github-field-FIELD_7',undefined,{},f.cx);
  for(const[option,group]of [['todo-7','todo'],['work-7','inProgress'],['done-7','done']])trigger(f.view.render(f.cx),'github-option-'+option+'-'+group,undefined,{},f.cx);await trigger(f.view.render(f.cx),'github-save-setup',undefined,{},f.cx);const saved=JSON.parse(await fs.readFile(f.configFile,'utf8')),status=saved.bindings[bindingKey(null,'/explicit/project')].github.status;
  assert.equal(status.project.fieldId,'FIELD_7');assert.deepEqual(status.project.options,{todo:['todo-7'],inProgress:['work-7'],done:['done-7']});assert.equal(f.view.projectFieldId,'FIELD_7');assert.deepEqual(f.view.projectOptions,status.project.options);assert.equal(f.calls.filter(c=>c.cmd==='node'&&JSON.parse(c.args[1]).operation==='probe').length,2);
  f.edit(f.view.projectNumber,'8');assert.equal(f.view.projectFieldId,null);assert.equal(f.view.projectFields,null);
});

test('label mapping preserves comma-containing labels and rejects an edited in-flight save',async t=>{
  const f=await fixture(t,{props:{view:'setup',target:{machine:null,repoRoot:'/explicit/labels'},overlay:'setup'}});await f.flush();trigger(f.view.render(f.cx),'github-new-profile',undefined,{},f.cx);for(const[state,value]of [[f.view.tokenEnv,'WORK_TOKEN'],[f.view.owner,'acme'],[f.view.repo,'web']])f.edit(state,value);trigger(f.view.render(f.cx),'github-mapping-labels',undefined,{},f.cx);f.edit(f.view.labelGroups.inProgress,'Doing\npriority, critical');
  const original=await fs.readFile(f.configFile,'utf8'),release=f.holdProbe(),pending=trigger(f.view.render(f.cx),'github-save-setup',undefined,{},f.cx);await new Promise(resolve=>setImmediate(resolve));f.edit(f.view.owner,'other');release();await pending;assert.equal(await fs.readFile(f.configFile,'utf8'),original);assert.ok(!f.effects.some(e=>e[0]==='close'));
  await trigger(f.view.render(f.cx),'github-save-setup',undefined,{},f.cx);const saved=JSON.parse(await fs.readFile(f.configFile,'utf8'));assert.deepEqual(saved.bindings[bindingKey(null,'/explicit/labels')].github.status.labels.inProgress,['Doing','priority, critical']);
});

test('changing a project during discovery permits a fresh load and discards the old choices',async t=>{
  const f=await fixture(t,{props:{view:'setup',target:{machine:null,repoRoot:'/explicit/project'}}});await f.flush();trigger(f.view.render(f.cx),'github-new-profile',undefined,{},f.cx);for(const[state,value]of [[f.view.tokenEnv,'WORK_TOKEN'],[f.view.owner,'acme'],[f.view.repo,'web'],[f.view.projectOwner,'acme'],[f.view.projectNumber,'7']])f.edit(state,value);trigger(f.view.render(f.cx),'github-mapping-project',undefined,{},f.cx);
  const release=f.holdProbe(),first=f.view.discoverFields(f.cx);await new Promise(resolve=>setImmediate(resolve));assert.equal(f.view.discovering,true);f.edit(f.view.projectNumber,'8');assert.equal(f.view.discovering,false);const second=f.view.discoverFields(f.cx);assert.ok(second);assert.equal(f.view.discovering,true);release();await first;await second;assert.equal(f.view.discovering,false);assert.equal(f.view.projectFields[0].id,'FIELD_8');assert.equal(f.view.projectFieldId,null);
});

test('source id/key mapping stays exact and unsafe URLs are rejected',()=>{
  const c={id:'work',site:'https://github.com'},b={machine:null,repoRoot:'/repo',github:{connectionId:'work',owner:'acme',repo:'web'}},row=source(c,b),mapped=githubLaunchSource(row);assert.equal(mapped.id,'100142');assert.equal(mapped.key,'GH-142');assert.equal(mapped.body,row.body);assert.throws(()=>githubLaunchSource({...row,url:'javascript:alert(1)'}));
});

