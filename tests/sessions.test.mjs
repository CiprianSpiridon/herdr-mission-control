import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import sync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import Sessions,{sessionAge} from '../src/mods/mission-control-sessions/main.js';
import {buildPackage} from '../scripts/project.mjs';
import {injectNative,context,trigger,findElement,Element,shared,renderRecorded} from './support/native-recording.mjs';

const MOD='mission-control-sessions',minute=60000;
const id=n=>`${String(n).padStart(8,'0')}-2222-4222-8222-${String(n).padStart(12,'0')}`;
const child=(cmd,args,options={})=>new Promise((resolve,reject)=>{const p=spawn(cmd,args,{cwd:options.cwd});let stdout='',stderr='';p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);p.on('error',reject);p.on('close',code=>resolve({code,stdout,stderr}));});
const git=async(dir,...args)=>{const r=await child('git',['-C',dir,...args]);assert.equal(r.code,0,r.stderr);};
async function repository(dir){await fs.mkdir(dir,{recursive:true});for(const args of [['init','-q','-b','main'],['config','user.name','QA'],['config','user.email','qa@example.invalid'],['commit','--allow-empty','-qm','Initial']])await git(dir,...args);}
const stamp=async(file,at)=>{const time=new Date(at);await fs.utimes(file,time,time);};
async function write(file,lines,at){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,lines.map(v=>JSON.stringify(v)).join('\n')+'\n');await stamp(file,at);}
const collector=(await Promise.all(['collector.py','provider_codex.py','provider_claude.py','provider_grok.py'].map(name=>fs.readFile('src/shared/'+name,'utf8')))).join('\n\n')+'\n\nif __name__ == "__main__":\n    collector_main({"codex": collect_codex, "claude": collect_claude, "grok": collect_grok})\n';
const HELP={'qa-claude':'Claude Code\nUsage: claude [options] [prompt]\n --session-id <uuid>\n --resume [value]\n --model <model>','qa-codex':'Codex CLI\nUsage: codex [OPTIONS] [PROMPT]\n --no-daemon\n --model <MODEL>','qa-grok':'Grok Build TUI\nUsage: grok [OPTIONS] [PROMPT]\n --model <MODEL>'};
function texts(root){const out=[];const walk=v=>{if(typeof v==='string')out.push(v);else if(v instanceof Element)v.nodes.forEach(walk);};walk(root);return out;}
function artwork(root){const out=[];const walk=v=>{if(!(v instanceof Element))return;if(['svg','image'].includes(v.kind))out.push(v.value);v.nodes.forEach(walk);};walk(root);return out;}

async function fixture(t,{props={},all=false}={}){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'mc-sessions-view-'))),app=root+'/app',repo=root+'/work/client',linked=root+'/work/client-linked',gone=root+'/work/client-gone',sibling=root+'/work/client-other',T=Date.now()-1000;
  for(const dir of [repo,sibling])await repository(dir);
  await git(repo,'worktree','add','-q','-b','feature',linked);await git(repo,'worktree','add','-q','-b','gone',gone);await fs.rm(gone,{recursive:true,force:true});
  const source=(provider,machine=null,prefix='')=>{const providerRoot=root+prefix+'/.'+provider;return {v:1,enabled:true,machine,provider,credentialScope:'standard',providerRoot,roots:[providerRoot+(provider==='claude'?'/projects':'/sessions')]};};
  const sources={'local-codex':source('codex'),'local-claude':source('claude'),'local-grok':source('grok'),'server-codex':source('codex','server','/server')},s={A:id(1),B:id(2),C:id(3),G:id(4),S:id(5),K:id(6),R:id(7)};
  const rollout=(where,session,cwd,ago)=>write(where+'/2026/10/31/rollout-'+session+'.jsonl',[{type:'session_meta',payload:{id:session,cwd,timestamp:new Date(T-ago*minute).toISOString()}}],T-ago*minute);
  await rollout(sources['local-codex'].roots[0],s.A,repo,50);await rollout(sources['local-codex'].roots[0],s.B,repo,10);await rollout(sources['local-codex'].roots[0],s.G,gone,30);await rollout(sources['local-codex'].roots[0],s.S,sibling,5);await rollout(sources['server-codex'].roots[0],s.R,repo,1);
  await write(sources['local-claude'].roots[0]+'/-work-client-linked/'+s.C+'.jsonl',[{type:'ai-title',sessionId:s.C,aiTitle:'Fix login redirect'},{type:'assistant',sessionId:s.C,cwd:linked,timestamp:new Date(T-20*minute).toISOString(),message:{usage:{input_tokens:1,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:1}}}],T-20*minute);
  const grok=sources['local-grok'].roots[0]+'/k/summary.json';await fs.mkdir(path.dirname(grok),{recursive:true});await fs.writeFile(grok,JSON.stringify({info:{id:s.K,cwd:repo},generated_title:'Review flaky checkout',last_active_at:new Date(T-15*minute).toISOString()}));await stamp(grok,T-15*minute);
  await fs.mkdir(app+'/mission-control',{recursive:true});await fs.mkdir(app+'/mods/'+MOD,{recursive:true});await fs.writeFile(app+'/mods/'+MOD+'/collector.py',collector);
  await fs.writeFile(app+'/mission-control/config.json',JSON.stringify({v:1,revision:0,connections:{},bindings:{},preferences:{},usageSources:sources}));
  const world={spaces:[{id:'A',name:'client',machine:null,active:true,folder:'/stale',tabs:[{id:'A-tab',name:'1',named:false,terminals:[{terminal:'t1'}]}]},{id:'server/B',name:'client',machine:'server',active:false,folder:'/stale',tabs:[{id:'server/B-tab',name:'1',named:false,terminals:[{terminal:'server/t2'}]}]},{id:'E',name:'empty',machine:null,active:false,folder:'/stale',tabs:[{id:'E-tab',name:'1',named:false,terminals:[]}]}]};
  const panes=[{pane:'A-pane',tab:'A-tab',terminal:'t1',cwd:linked,focused:true},{pane:'B-pane',tab:'server/B-tab',terminal:'server/t2',cwd:repo,focused:false}],machines=[{name:null,layout:'ready'},{name:'server',layout:'ready'}];
  const shell=(address,cwd,space,tab)=>({address,created_ms:50,state:'live',cwd,foreground:{pid:90,name:'zsh',argv:['/bin/zsh','-li'],cwd},argv:['/bin/zsh','-li'],labels:{'herdr.space':space,'herdr.tab':tab}});
  const raws=new Map([['t1',shell('t1',linked,'A','A-tab')],['server/t2',shell('t2',repo,'B','B-tab')]]),effects=[],calls=[],launched=[],waiters=[];let created=0,gate=null,picked=null;
  const tool=(key,name,installed=true)=>({key,name,icon:'icons/'+key+'.svg',tint:key!=='codex',tile:null,color:null,shell:false,agent:true,installed,run:['qa-'+key]});
  const tools=[tool('claude','Claude Code'),tool('codex','Codex'),tool('grok','Grok')],serverTools=[tool('claude','Claude Code',false),tool('codex','Codex'),tool('grok','Grok',false)];
  const api={props,spaces:()=>world.spaces,panes:()=>panes,focused:()=>({space:'A',tab:'A-tab',pane:'A-pane',terminal:'t1'}),machines:()=>machines,agents:()=>[],appHome:app,home:root,window:{platform:'macos'},
    terminals:()=>[...raws.keys()].map(address=>({address,state:'live'})),shared:{'mission-control-sessions-ui-v1':{v:1,all,query:'',tool:'all'}},knownAgents:async({on=null}={})=>on?serverTools:tools,
    readTextFile:async file=>{try{return await fs.readFile(file,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}},
    writeTextFile:async(file,text,expected)=>{let current=null;try{current=sync.readFileSync(file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}if(current!==expected)throw Object.assign(Error('stale'),{code:'STALE'});const temp=file+'.'+Math.random().toString(36).slice(2);sync.writeFileSync(temp,text);sync.renameSync(temp,file);},
    run:(name,args)=>{effects.push([name,args]);return null;},openOverlay:spec=>{effects.push(['overlay',spec]);return 'overlay';},closeOverlay:overlay=>{effects.push(['close',overlay]);return null;},
    nextCommand:()=>new Promise(resolve=>waiters.push(resolve)),pickFolder:async()=>picked,
    exec:async(cmd,args,options={})=>{
      const on=options.on??null;calls.push({cmd,args:cmd==='python3'&&args[1]===collector?['-c','own-collector',JSON.parse(args[2])]:structuredClone(args),on,cwd:options.cwd});
      if(cmd==='python3'&&args[1]===collector){const r=spawnSync('python3',args,{encoding:'utf8',maxBuffer:8*1024*1024});return {code:r.status,stdout:r.stdout,stderr:r.stderr};}
      if(cmd==='python3'&&args[1].startsWith('import os,json'))return {code:0,stdout:JSON.stringify({home:root})};
      if(cmd==='git'||cmd==='mkdir')return child(cmd,args,{cwd:options.cwd});
      if(cmd.startsWith('qa-'))return {code:0,stdout:args.includes('--version')?'fixture 1':args[0]==='resume'?'Usage: codex resume [OPTIONS] [SESSION_ID] [PROMPT]':HELP[cmd],stderr:''};
      if(cmd==='herdr-app'&&args[0]==='do'){
        assert.equal(args[1],'tab.new');const p=JSON.parse(args[2]);launched.push(p);if(gate)await gate;
        const space=world.spaces.find(x=>x.id===p.space),host=space.machine,n=++created,local='t'+(10+n),tab=(host?host+'/':'')+'new-'+n,address=(host?host+'/':'')+local;
        space.tabs.push({id:tab,name:p.name,named:true,terminals:[{terminal:address}]});
        raws.set(address,{address:local,created_ms:1000+n,state:'live',cwd:p.folder,foreground:{pid:5000+n,name:p.argv[0],argv:p.argv,cwd:p.folder},argv:p.argv,labels:{'herdr.space':host?space.id.slice(host.length+1):space.id,'herdr.tab':host?tab.slice(host.length+1):tab}});
        return {code:0,stdout:JSON.stringify({space:space.id,tab,terminal:address})};
      }
      if(cmd==='herdr-app'&&args[0]==='ls')return {code:0,stdout:JSON.stringify({spaces:world.spaces})};
      if(cmd==='hc'&&args[0]==='ls')return {code:0,stdout:JSON.stringify({terminals:[...raws].filter(([k])=>on?k.startsWith(on+'/'):!k.includes('/')).map(([,raw])=>({address:raw.address,state:'live',labels:raw.labels}))})};
      if(cmd==='hc'&&args[0]==='get'){const raw=raws.get((on?on+'/':'')+args[1]);return raw?{code:0,stdout:JSON.stringify(raw)}:{code:1,stdout:''};}
      if(cmd==='sleep')return {code:0,stdout:''};
      throw Error('Unexpected controlled fixture effect '+cmd);
    }};
  injectNative(api);const cx=context(),timers=[];cx.timer.every=(ms,fn)=>{const timer={ms,fn,cancelled:false,cancel(){this.cancelled=true;}};timers.push(timer);return timer;};
  const view=new Sessions();view.init({},cx);
  const render=()=>renderRecorded(view,cx);
  const flush=async()=>{for(let n=0;n<80;n++){render();const jobs=[...view.jobs];await Promise.all(jobs);await new Promise(r=>setImmediate(r));render();if(jobs.length===view.jobs.length&&jobs.every((job,i)=>view.jobs[i]===job)&&view.jobs.every(job=>job.is_done()))return;}assert.fail('The native View did not settle its finite jobs.');};
  t.after(async()=>{gate=null;await view.close();await Promise.allSettled(view.jobs);await fs.rm(root,{recursive:true,force:true});});
  const row=name=>view.view?.rows.find(r=>r.identity.sessionId===s[name]);
  return {root,app,repo,linked,gone,sibling,sources,s,world,panes,machines,raws,effects,calls,launched,timers,view,cx,render,flush,row,
    names:()=>view.view.rows.map(r=>Object.keys(s).find(k=>s[k]===r.identity.sessionId)),hold:()=>{let release;gate=new Promise(r=>release=r);return ()=>{gate=null;release();};},pick:folder=>picked=folder,
    command:async name=>{while(!waiters.length)await new Promise(r=>setImmediate(r));waiters.shift()(name);},timer:ms=>timers.find(x=>x.ms===ms),file:name=>fs.readFile(app+'/mission-control/'+name,'utf8').then(JSON.parse,()=>null)};
}
const until=async(check,message)=>{for(let n=0;n<400;n++){if(check())return;await new Promise(r=>setTimeout(r,5));}assert.fail(message);};
const opened=f=>f.launched.length;

test('per-space history shows only this repository with actual tool icons, host and worktree details',async t=>{
  const f=await fixture(t);await f.flush();assert.deepEqual(f.timers.map(x=>x.ms),[60000,5000,2000]);
  assert.deepEqual(f.names(),['B','K','C','G','A']);let tree=f.render();const strings=texts(tree);
  assert.equal(strings.filter(v=>v==='Sessions').length,1);assert.ok(strings.includes('client'));assert.ok(strings.includes('Fix login redirect'));assert.ok(strings.includes('Review flaky checkout'));
  const c=findElement(tree,f.row('C').id),b=findElement(tree,f.row('B').id);
  assert.ok(artwork(c).includes('icons/claude.svg'));assert.ok(artwork(b).includes('icons/codex.svg'));assert.ok(texts(c).includes('feature · client-linked · This Mac'));assert.ok(texts(b).includes('main · This Mac'));assert.ok(!texts(c).includes('Claude Code'),'the tool is an icon, not the row title');
  for(const name of ['S','R'])assert.equal(f.row(name),undefined,name);
  const k=findElement(tree,f.row('K').id);assert.equal(k.handlers.on_click,undefined,'unsupported rows are not clickable');assert.ok(texts(k).includes('This installed tool/version has no verified exact-session resume.'));assert.ok(texts(k).includes('main · This Mac'));
  const g=findElement(tree,f.row('G').id);assert.equal(g.handlers.on_click,undefined);assert.ok(texts(g).some(v=>/worktree is missing on This Mac/.test(v)));assert.ok(findElement(tree,f.row('G').id+'-locate'));assert.ok(findElement(tree,f.row('G').id+'-retry'));
  assert.ok(texts(tree).some(v=>/^1–5 of 5 · Updated/.test(v)));
  const lists=f.calls.filter(c=>c.cmd==='python3'&&c.args[1]==='own-collector').map(c=>[c.args[2].operation,c.args[2].limit,c.args[2].source.provider,c.on]);assert.ok(lists.length>=3);assert.ok(lists.every(([op,limit,,on])=>op==='list'&&limit===50&&on===null),'This space reads only its own host');
  trigger(tree,'sessions-tool-claude','on_click',{},f.cx);tree=f.render();assert.deepEqual(texts(findElement(tree,'sessions-list')).filter(v=>v==='Fix login redirect'),['Fix login redirect']);assert.equal(shared('mission-control-sessions-ui-v1').tool,'claude');
  trigger(tree,'sessions-tool-all','on_click',{},f.cx);trigger(f.render(),'sessions-sources','on_click',{},f.cx);tree=f.render();assert.ok(texts(findElement(tree,'sessions-source-list')).includes(f.sources['local-codex'].roots[0]));
  f.view.props.hideHeader=true;assert.equal(texts(f.render()).filter(v=>v==='Sessions').length,0);
  assert.equal(sessionAge(Date.now()-3*minute,Date.now()),'3m');assert.equal(sessionAge(Date.now()-90*minute,Date.now(),{suffix:true}),'1h ago');assert.equal(sessionAge(null,Date.now()),'');
});

test('renaming the focused space updates the header caption without clearing its rows',async t=>{
  const f=await fixture(t);await f.flush();const space=f.world.spaces.find(s=>texts(f.render()).includes(s.name));assert.ok(space);
  space.name='client-portal';await f.flush();const strings=texts(f.render());
  assert.ok(strings.includes('client-portal'),'the caption follows the renamed space');assert.deepEqual(f.names(),['B','K','C','G','A']);
});
test('the non-last exact session resumes once in its original checkout; a second click during resume cannot duplicate it',async t=>{
  const f=await fixture(t);await f.flush();const a=f.row('A'),release=f.hold(),before=f.render();
  trigger(before,a.id,'on_click',{},f.cx);let tree=f.render(),row=findElement(tree,a.id);assert.ok(texts(row).includes('Opening…'));assert.equal(row.handlers.on_click,undefined);
  assert.equal(trigger(before,a.id,'on_click',{},f.cx),undefined,'a stale handler from the earlier frame is ignored while resuming');
  await until(()=>opened(f)===1,'resume did not reach acknowledged tab creation');for(let n=0;n<20;n++)await new Promise(r=>setImmediate(r));assert.equal(opened(f),1);
  release();await f.flush();assert.equal(opened(f),1);const p=f.launched[0];assert.deepEqual(p.argv,['qa-codex','--no-daemon','resume',f.s.A]);assert.equal(p.folder,f.repo);assert.equal(p.space,'A');
  assert.equal(f.row('A').state,'running');tree=f.render();assert.ok(texts(findElement(tree,a.id)).includes('Running'));assert.ok(texts(tree).some(v=>/^Resumed Untitled · 00000001 in its original checkout\.$/.test(v)));
  f.effects.length=0;trigger(tree,a.id,'on_click',{},f.cx);await f.flush();assert.deepEqual(f.effects.filter(e=>e[0]==='agent.focus'),[['agent.focus',{terminal:'t11'}]]);assert.equal(opened(f),1);assert.ok(texts(f.render()).includes('Focused the running session.'));
  const journal=await f.file('launches.json');assert.deepEqual(Object.values(journal.requests).map(r=>r.sessionProposal.sessionId),[f.s.A]);
});

test('a manual tab name captured by the live observer is restored exactly once when that closed session resumes',async t=>{
  const f=await fixture(t);await f.flush();const a=f.row('A');trigger(f.render(),a.id,'on_click',{},f.cx);await f.flush();assert.equal(opened(f),1);
  f.timer(2000).fn(f.cx);await f.flush();const tab=f.world.spaces[0].tabs.find(x=>x.id==='new-1');Object.assign(tab,{name:'My investigation',named:true});
  f.timer(2000).fn(f.cx);await f.flush();const names=await f.file('names.json'),record=Object.values(names.origins).find(r=>r.session?.sessionId===f.s.A);assert.equal(record.mode,'manual');assert.equal(record.manualName,'My investigation');assert.equal(names.lease.owner.startsWith(MOD+'-'),true);
  assert.equal(f.row('A').title,'My investigation');assert.equal(f.row('A').titleKind,'manual');
  f.world.spaces[0].tabs=f.world.spaces[0].tabs.filter(x=>x.id!=='new-1');f.raws.delete('t11');await f.flush();assert.equal(f.row('A').state,'ready','a closed exact terminal is no longer running');
  f.effects.length=0;trigger(f.render(),a.id,'on_click',{},f.cx);await f.flush();assert.equal(opened(f),2);assert.deepEqual(f.launched[1].argv,['qa-codex','--no-daemon','resume',f.s.A]);
  assert.deepEqual(f.effects.filter(e=>e[0]==='tab.rename'),[['tab.rename',{id:'new-2',name:'My investigation'}]]);
  await f.view.close();assert.equal((await f.file('names.json')).lease,null,'closing the View releases its observer lease');
});

test('All spaces, explicit props and scope commands select the same mod scope; remote sessions resume only on their host',async t=>{
  const f=await fixture(t);await f.flush();trigger(f.render(),'sessions-scope-all','on_click',{},f.cx);assert.equal(f.view.view,null,'scope changes clear the old rows immediately');await f.flush();
  assert.equal(shared('mission-control-sessions-ui-v1').all,true);assert.deepEqual(f.names(),['R','S','B','K','C','G','A']);
  assert.equal(f.row('R').spaceId,'server/B');assert.equal(f.row('R').host,'server');assert.equal(f.row('S').state,'unassigned');assert.match(f.row('S').reason,/No open space on This Mac/);
  let tree=f.render();assert.equal(findElement(tree,f.row('S').id).handlers.on_click,undefined);assert.ok(texts(findElement(tree,f.row('R').id)).includes('main · client · server'));
  await f.command('this-space');await f.flush();assert.equal(f.view.all,false);assert.deepEqual(f.names(),['B','K','C','G','A']);await f.command('all-spaces');await f.flush();assert.equal(f.view.all,true);
  f.machines[1].layout='unavailable';await f.flush();tree=f.render();const r=f.row('R');assert.equal(r.state,'offline');assert.match(r.reason,/server is offline or still connecting/);assert.equal(findElement(tree,r.id).handlers.on_click,undefined);assert.ok(findElement(tree,r.id+'-retry'));assert.equal(f.row('B').state,'ready','only the offline host loses its action');
  f.machines[1].layout='ready';await f.flush();
  const remote=await fixture(t,{props:{spaceId:'server/B',machine:'server'}});await remote.flush();assert.deepEqual(remote.names(),['R']);
  const before=remote.calls.length;trigger(remote.render(),remote.row('R').id,'on_click',{},remote.cx);await remote.flush();assert.equal(opened(remote),1);
  assert.equal(remote.launched[0].space,'server/B');assert.deepEqual(remote.launched[0].argv,['qa-codex','--no-daemon','resume',remote.s.R]);assert.equal(remote.launched[0].folder,remote.repo);
  assert.deepEqual(remote.calls.slice(before).filter(c=>['git','hc','qa-codex'].includes(c.cmd)&&c.on!=='server'),[],'no local fallback for a remote session');
});

test('missing and unsupported sessions keep readable metadata with actionable recovery; empty spaces explain themselves',async t=>{
  const f=await fixture(t);await f.flush();const g=f.row('G');
  trigger(f.render(),g.id+'-retry','on_click',{},f.cx);await f.flush();let tree=f.render(),row=findElement(tree,g.id);assert.ok(texts(row).some(v=>/missing on its host\. Locate it, then retry/.test(v)));assert.equal(opened(f),0);assert.ok(findElement(tree,g.id+'-dismiss'));
  await git(f.repo,'worktree','prune');await git(f.repo,'worktree','add','-q',f.gone,'gone');f.pick(f.gone);
  trigger(tree,g.id+'-locate','on_click',{},f.cx);await f.flush();assert.equal(opened(f),1);assert.equal(f.launched[0].folder,f.gone);assert.deepEqual(f.launched[0].argv,['qa-codex','--no-daemon','resume',f.s.G]);
  const k=f.row('K');assert.equal(k.state,'unsupported');assert.equal(k.branch,'main');assert.equal(k.title,'Review flaky checkout');
  const empty=await fixture(t,{props:{spaceId:'E'}});await empty.flush();assert.deepEqual(empty.view.view.rows,[]);assert.ok(texts(empty.render()).includes('This space has no live terminal folder. Open or focus a terminal first.'));
});

test('an abandoned resume guard expires without allowing a duplicate terminal, and close stops every timer and task',async t=>{
  const f=await fixture(t);await f.flush();const a=f.row('A'),release=f.hold();trigger(f.render(),a.id,'on_click',{},f.cx);await until(()=>opened(f)===1,'resume did not start');
  f.view.resuming.get(a.key).at-=100000;f.timer(5000).fn(f.cx);assert.equal(f.view.resuming.size,0);const row=findElement(f.render(),a.id);assert.ok(row.handlers.on_click,'the stale guard no longer blocks the row');
  trigger(f.render(),a.id,'on_click',{},f.cx);await until(()=>f.view.outcomes.has(a.key),'second resume did not answer');assert.equal(f.view.outcomes.get(a.key).code,'RESUME_IN_PROGRESS');assert.equal(opened(f),1);
  release();await f.flush();assert.equal(opened(f),1);assert.equal(f.row('A').state,'running');
  await f.view.close();assert.ok(f.timers.every(x=>x.cancelled));const notified=f.cx.notifications;for(const timer of f.timers)timer.fn(f.cx);assert.equal(f.cx.notifications,notified);
});

test('the standalone package bundles its own collector and strips build-only manifest fields',async()=>{
  const built=await buildPackage(MOD),manifest=JSON.parse(await fs.readFile(built.directory+'/mod.json','utf8'));
  assert.deepEqual(manifest,{title:'Mission Control · Sessions',place:'right',size:360,overlay:{kind:'dialog',width:720,height:640}});
  assert.equal(crypto.createHash('sha256').update(await fs.readFile(built.directory+'/collector.py')).digest('hex'),crypto.createHash('sha256').update(collector).digest('hex'));
  const code=await fs.readFile(built.directory+'/main.js','utf8');assert.doesNotMatch(code,/from ['"]\.\.?\//,'no runtime cross-mod or relative imports');
  for(const name of ['sessions','branch','folder','refresh','settings','close','search','agent'])assert.ok(sync.existsSync(built.directory+'/assets/'+name+'.svg'),name);
});
