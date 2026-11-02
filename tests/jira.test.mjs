import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import Jira,{captureJiraTarget,jiraLaunchSource} from '../src/mods/mission-control-jira/main.js';
import {newConfig,bindingKey} from '../src/shared/config.js';
import {trackerScope} from '../src/shared/tracker-model.js';
import {validateTrackerRequest,publicTrackerError,TrackerError} from '../src/shared/tracker-transport.mjs';
import {issueCardId} from '../src/shared/issue-board.js';
import {injectNative,context,trigger,findElement,Element} from './support/native-recording.mjs';

const exec=promisify(execFile),CLOUD='11111111-2222-3333-4444-555555555555';
async function command(cmd,args,options={}){try{const r=await exec(cmd,args,{cwd:options.cwd,maxBuffer:8*1024*1024});return {code:0,stdout:r.stdout,stderr:r.stderr};}catch(e){return {code:Number.isInteger(e.code)?e.code:1,stdout:e.stdout||'',stderr:e.stderr||''};}}
const source=(c,b)=>({identity:{kind:'jira',connectionId:c.id,site:c.site,id:'stable-rest-id'},key:'WEB-142',title:'Fix login redirect',url:c.site+'/browse/WEB-142',body:'Task text from the selected Jira issue.',statusGroup:'todo',statusName:'Open',priority:'High',repoBinding:b});
function visibleStrings(root){const out=[];function walk(v){if(!(v instanceof Element))return;for(const child of v.nodes)if(typeof child==='string')out.push(child);else walk(child);}walk(root);return out;}
async function fixture(t,{props={},all=false,worktree=false}={}){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'mc-jira-view-'))),app=path.join(root,'app'),repoA=path.join(root,'repo-a'),repoB=path.join(root,'repo-b'),linked=path.join(root,'a-linked');await fs.mkdir(path.join(app,'mission-control'),{recursive:true});
  for(const repo of [repoA,repoB]){await fs.mkdir(repo);for(const args of [['init','-q','-b','main'],['config','user.name','Fixture'],['config','user.email','fixture@example.invalid']])assert.equal((await command('git',['-C',repo,...args])).code,0);await fs.writeFile(path.join(repo,'README.md'),'Disposable Jira View fixture.\n');assert.equal((await command('git',['-C',repo,'add','README.md'])).code,0);assert.equal((await command('git',['-C',repo,'commit','-qm','Create fixture'])).code,0);}
  assert.equal((await command('git',['-C',repoA,'worktree','add','-q','-b','fixture-linked',linked])).code,0);
  const a={id:'A',name:'client-portal',machine:null,folder:'/stale/creation-folder',active:true,tabs:[{id:'A-tab'}]},b={id:'server/B',name:'server-repo',machine:'server',folder:'/stale/server-folder',active:false,tabs:[{id:'server/B-tab'}]},world={spaces:[a,b]},panes=[{pane:'A-pane',tab:'A-tab',terminal:'t1',cwd:linked,focused:true},{pane:'B-pane',tab:'server/B-tab',terminal:'server/t2',cwd:repoB,focused:false}],machines=[{name:null,layout:'ready'},{name:'server',layout:'ready'}];let focus={space:'A',pane:'A-pane'},created=0,probeGate=null;
  const config=newConfig(),work={id:'work',kind:'api',site:'https://work.atlassian.net',auth:{kind:'basic',usernameEnv:'WORK_EMAIL',tokenEnv:'WORK_TOKEN'}},personal={id:'personal',kind:'api',site:'https://personal.atlassian.net',auth:{kind:'bearer',tokenEnv:'PERSONAL_TOKEN'}};config.connections={work,personal};const bindingA={machine:null,repoRoot:repoA,jira:{connectionId:'work',project:'WEB'}},bindingB={machine:'server',repoRoot:repoB,jira:{connectionId:'personal',project:'WEB'}};config.bindings={[bindingKey(null,repoA)]:bindingA,[bindingKey('server',repoB)]:bindingB};config.preferences.launch={v:1,pins:['claude','codex','grok'],hidden:[],worktree,tools:{}};
  const configFile=path.join(app,'mission-control/config.json');await fs.writeFile(configFile,JSON.stringify(config));const effects=[],raws=new Map(),calls=[],flags={probeError:null};
  const tools=['claude','codex','grok','kiro'].map(key=>({key,name:key==='claude'?'Claude Code':key==='codex'?'Codex':key,icon:'icons/'+key+'.svg',tint:key==='claude',installed:true,run:['qa-'+key]}));
  const api={props,spaces:()=>world.spaces,panes:()=>panes,focused:()=>focus,machines:()=>machines,window:{platform:'macos'},appHome:app,shared:{'mission-control-jira-ui-v1':{v:1,all,query:'',status:'all'}},knownAgents:async()=>tools,
    readTextFile:async file=>{try{return await fs.readFile(file,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}},writeTextFile:async(file,text,expected)=>{let old;try{old=await fs.readFile(file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;old=null;}assert.equal(old,expected);await fs.writeFile(file,text);},
    run:(name,args)=>{effects.push([name,args]);return null;},openOverlay:spec=>{effects.push(['overlay',spec]);return 'own-overlay';},closeOverlay:id=>{effects.push(['close',id]);return null;},nextCommand:()=>new Promise(()=>{}),
    exec:async(cmd,args,options={})=>{
      calls.push({cmd,args:structuredClone(args),options:structuredClone(options)});
      if(cmd==='git'||cmd==='python3'||cmd==='mkdir')return command(cmd,args,options);
      if(cmd==='node'){
        try{const r=validateTrackerRequest(JSON.parse(args[1]));if(r.operation==='probe'){if(probeGate)await probeGate;if(flags.probeError)throw new TrackerError(flags.probeError);const c=r.connection;return {code:0,stdout:JSON.stringify({v:1,ok:true,operation:'probe',connection:c,probe:{site:c.site,route:c.kind==='api'?c.cloudId||c.auth.kind==='bearer'?'gateway':'tenant':c.kind==='cli'?'local-cli':c.kind,...(c.kind==='api'?{cloudId:c.cloudId||null}:{}),...(c.search?{tool:c.search.tool}:{})}})};}
          return {code:0,stdout:JSON.stringify({v:1,ok:true,operation:'issues',snapshot:{data:[source(r.connection,r.binding)],fetchedAt:Date.now(),scope:trackerScope('jira',r.connection,r.binding),truncated:false}})};
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
  injectNative(api);const cx=context(),timers=[];cx.timer.every=(ms,fn)=>{const timer={ms,fn,cancelled:false,cancel(){this.cancelled=true;}};timers.push(timer);return timer;};const view=new Jira();view.init({},cx);
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

test('native panel resolves the live linked repo, shows one source heading and keeps context when the panel takes focus',async t=>{
  const f=await fixture(t);await f.flush();assert.equal(f.view.resolved.repoRoot,f.repoA);assert.equal(f.view.resolved.worktreeRoot,f.linked);assert.equal(f.view.data.view().data.length,1);let tree=f.view.render(f.cx);assert.equal(visibleStrings(tree).filter(v=>v==='Jira').length,1);assert.ok(findElement(tree,'jira-board-column-done'));const count=f.calls.filter(c=>c.cmd==='node').length;f.panelFocus();f.view.render(f.cx);await f.flush();assert.equal(f.calls.filter(c=>c.cmd==='node').length,count);assert.equal(f.view.data.view().data.length,1);
  f.view.props.hideHeader=true;tree=f.view.render(f.cx);assert.equal(visibleStrings(tree).filter(v=>v==='Jira').length,0);assert.equal(f.timers[0].ms,60000);
});

test('current-space action captures its live checkout and stable REST id before later space changes',async t=>{
  const f=await fixture(t);await f.flush();const row=f.view.data.view().data[0],pending=f.view.startIssue(row,'claude',f.cx);f.active('server/B');await pending;assert.equal(f.created(),1,f.view.error);const params=JSON.parse(f.calls.find(c=>c.cmd==='herdr-app'&&c.args[0]==='do').args[2]);assert.equal(params.space,'A');assert.equal(params.folder,f.linked);assert.match(params.task,/WEB-142/);const journal=JSON.parse(await fs.readFile(path.join(f.app,'mission-control/launches.json'),'utf8')),record=Object.values(journal.requests)[0];assert.equal(record.request.source.id,'stable-rest-id');assert.equal(record.request.source.key,'WEB-142');assert.equal(record.request.checkoutRoot,f.linked);assert.equal(record.request.repoRoot,f.repoA);
});

test('All spaces starts the captured issue in its canonical repo and repeat clicks focus existing work',async t=>{
  const f=await fixture(t,{all:true});await f.flush();assert.equal(f.view.data.view().data.length,2);const row=f.view.data.view().data.find(v=>v.identity.connectionId==='work');f.active('server/B');await f.view.startIssue(row,'codex',f.cx);assert.equal(f.created(),1,f.view.error);const created=f.calls.find(c=>c.cmd==='herdr-app'&&c.args[0]==='do'),params=JSON.parse(created.args[2]);assert.equal(params.space,'A');assert.equal(params.folder,f.repoA);assert.ok(!f.calls.some(c=>c.cmd==='git'&&c.args.includes('/stale/creation-folder')));
  await f.view.startIssue(row,'codex',f.cx);assert.equal(f.created(),1,f.view.error);assert.ok(f.effects.some(e=>e[0]==='tab.select'));await f.view.startIssue(row,'claude',f.cx);assert.equal(f.created(),1);assert.match(f.view.error,/another tool/);
});

test('saved new-worktree default creates the workspace-plus-issue leaf using real disposable Git',async t=>{
  const f=await fixture(t,{worktree:true});await f.flush();await f.view.startIssue(f.view.data.view().data[0],'claude',f.cx);assert.equal(f.created(),1,f.view.error);const params=JSON.parse(f.calls.find(c=>c.cmd==='herdr-app'&&c.args[0]==='do').args[2]);assert.equal(path.basename(params.folder),'client-portal-WEB-142');assert.ok((await fs.stat(params.folder)).isDirectory());assert.notEqual(params.folder,f.linked);
});

test('links open the selected Jira URL locally and options use the same mod with an immutable target',async t=>{
  const f=await fixture(t);await f.flush();const row=f.view.data.view().data[0],id=issueCardId('jira-board',row),tree=f.view.render(f.cx);await trigger(tree,id+'-key',undefined,{},f.cx);assert.deepEqual(f.effects.find(e=>e[0]==='browser'),['browser',row.url]);assert.equal(f.created(),0);
  await trigger(tree,id+'-options',undefined,{},f.cx);const overlay=f.effects.findLast(e=>e[0]==='overlay')[1];assert.equal(overlay.mod,'mission-control-jira');assert.equal(overlay.props.view,'launch');assert.equal(overlay.props.target.repoRoot,f.repoA);assert.equal(overlay.props.target.checkoutRoot,f.linked);assert.equal(overlay.props.source.id,'stable-rest-id');assert.equal(f.created(),0);
});

test('offline hosts and a mismatched repo cannot launch or silently route to the active space',async t=>{
  const f=await fixture(t,{all:true});await f.flush();const remote=f.view.data.view().data.find(v=>v.repoBinding.machine==='server');f.machines.find(m=>m.name==='server').layout='unavailable';await f.view.startIssue(remote,'claude',f.cx);assert.equal(f.created(),0);assert.match(f.view.error,/offline/);
  const local=f.view.data.view().data.find(v=>v.repoBinding.machine===null);await assert.rejects(captureJiraTarget(local,{all:false,resolved:{state:'resolved',spaceId:'server/B',machine:'server',repoRoot:f.repoB},api:f.realApi()}),e=>e.code==='INVALID_SCOPE');assert.equal(f.created(),0);
});

test('a props-bound repo chooses its own live space instead of the active repository',async t=>{
  const f=await fixture(t);await f.flush();f.view.props.target={machine:'server',repoRoot:f.repoB};f.view.contextKey=null;f.view.render(f.cx);await f.flush();assert.equal(f.view.data.view().data[0].repoBinding.repoRoot,f.repoB);assert.equal(f.view.resolved.spaceId,'server/B');assert.equal(f.view.data.view().data[0].identity.connectionId,'personal');assert.ok(visibleStrings(f.view.render(f.cx)).includes('server-repo'));
});

test('setup renders cloud-id and environment-reference fields, probes before saving and preserves values on failure',async t=>{
  const f=await fixture(t,{props:{view:'setup',target:{machine:null,repoRoot:'/explicit/repo'},overlay:'setup'}});await f.flush();trigger(f.view.render(f.cx),'jira-new-profile',undefined,{},f.cx);for(const [state,value]of [[f.view.profileId,'new-work'],[f.view.site,'https://canonical.atlassian.net'],[f.view.cloudId,CLOUD],[f.view.emailEnv,'NEW_EMAIL'],[f.view.tokenEnv,'NEW_TOKEN'],[f.view.project,'WEB']])f.edit(state,value);
  let tree=f.view.render(f.cx);for(const id of ['jira-site','jira-cloud-id','jira-email-env','jira-token-env'])assert.ok(findElement(tree,id));const original=await fs.readFile(f.configFile,'utf8');f.flags.probeError='CANONICAL_SITE_REQUIRED';await trigger(tree,'jira-save-setup',undefined,{},f.cx);assert.equal(await fs.readFile(f.configFile,'utf8'),original);assert.match(f.view.error,/canonical/);assert.equal(f.view.cloudId.value(),CLOUD);f.flags.probeError=null;await trigger(f.view.render(f.cx),'jira-save-setup',undefined,{},f.cx);const saved=JSON.parse(await fs.readFile(f.configFile,'utf8'));assert.equal(saved.connections['new-work'].cloudId,CLOUD);assert.equal(saved.connections['new-work'].auth.tokenEnv,'NEW_TOKEN');assert.ok(f.effects.some(e=>e[0]==='close'&&e[1]==='setup'));
});

test('MCP HTTPS setup supports Basic env references and preserves literal tool cloudId arguments',async t=>{
  const f=await fixture(t,{props:{view:'setup',target:{machine:null,repoRoot:'/explicit/mcp'}}});await f.flush();trigger(f.view.render(f.cx),'jira-new-profile',undefined,{},f.cx);trigger(f.view.render(f.cx),'jira-kind-mcp-http',undefined,{},f.cx);trigger(f.view.render(f.cx),'jira-auth-basic',undefined,{},f.cx);
  for(const [state,value]of [[f.view.profileId,'mcp-basic'],[f.view.site,'https://work.atlassian.net'],[f.view.mcpUrl,'https://mcp.example.invalid/mcp'],[f.view.emailEnv,'MCP_EMAIL'],[f.view.tokenEnv,'MCP_TOKEN'],[f.view.project,'WEB']])f.edit(state,value);
  const search=JSON.parse(f.view.searchConfig.value());search.tool='search_issues';search.argsTemplate.cloudId=CLOUD;f.edit(f.view.searchConfig,JSON.stringify(search,null,2));assert.ok(findElement(f.view.render(f.cx),'jira-search-config'));await trigger(f.view.render(f.cx),'jira-save-setup',undefined,{},f.cx);const saved=JSON.parse(await fs.readFile(f.configFile,'utf8'));assert.equal(saved.connections['mcp-basic'].auth.kind,'basic');assert.equal(saved.connections['mcp-basic'].auth.usernameEnv,'MCP_EMAIL');assert.equal(saved.connections['mcp-basic'].search.argsTemplate.cloudId,CLOUD);assert.equal(f.view.selectedProfile.id,'mcp-basic');
});

test('editing a setup draft during its probe cancels persistence without closing the form',async t=>{
  const f=await fixture(t,{props:{view:'setup',target:{machine:null,repoRoot:'/explicit/repo'},overlay:'setup'}});await f.flush();trigger(f.view.render(f.cx),'jira-new-profile',undefined,{},f.cx);for(const [state,value]of [[f.view.site,'https://work.atlassian.net'],[f.view.emailEnv,'WORK_EMAIL'],[f.view.tokenEnv,'WORK_TOKEN'],[f.view.project,'WEB']])f.edit(state,value);const original=await fs.readFile(f.configFile,'utf8'),release=f.holdProbe(),pending=trigger(f.view.render(f.cx),'jira-save-setup',undefined,{},f.cx);await new Promise(resolve=>setImmediate(resolve));f.edit(f.view.cloudId,CLOUD);release();await pending;assert.equal(await fs.readFile(f.configFile,'utf8'),original);assert.ok(!f.effects.some(e=>e[0]==='close'));assert.equal(f.view.cloudId.value(),CLOUD);
});

test('source id/key mapping and invalid source guards remain exact',()=>{
  const c={id:'work',site:'https://work.atlassian.net'},b={machine:null,repoRoot:'/repo',jira:{connectionId:'work',project:'WEB'}},row=source(c,b),mapped=jiraLaunchSource(row);assert.equal(mapped.id,'stable-rest-id');assert.equal(mapped.key,'WEB-142');assert.equal(mapped.body,row.body);assert.throws(()=>jiraLaunchSource({...row,url:'javascript:alert(1)'}));
});
