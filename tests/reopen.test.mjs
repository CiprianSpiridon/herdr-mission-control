import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import sync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {reopen,reopenRecord,dismissRecord,selectRecord,restorePlan,reopenPreview,ReopenController,REOPEN_LIMITATIONS} from '../src/shared/reopen.js';
import {ClosedWatcher,ClosedJournal,LIMITS} from '../src/shared/closed-tabs.js';
import {resume} from '../src/shared/resume.js';
import {launch} from '../src/shared/launch.js';
import {parseCapabilities} from '../src/shared/tool-capabilities.js';
import {NameOwnership} from '../src/shared/name-ownership.js';
import {BindingStore} from '../src/shared/session-bindings.js';

const child=(cmd,args,options={})=>new Promise((resolve,reject)=>{const p=spawn(cmd,args,{cwd:options.cwd});let stdout='',stderr='';p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);p.on('error',reject);p.on('close',code=>resolve({code,stdout,stderr}));});
const git=async(dir,...args)=>{const r=await child('git',['-C',dir,...args]);assert.equal(r.code,0,r.stderr);};
const HELP={claude:'Claude Code\nUsage: claude [options] [prompt]\n --session-id <uuid>\n --resume [value]\n --model <model>',codex:'Codex CLI\nUsage: codex [OPTIONS] [PROMPT]\n --no-daemon'};
const q=(on,id)=>on?on+'/'+id:id,local=(on,id)=>on&&id.startsWith(on+'/')?id.slice(on.length+1):id;
async function fixture(t){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'mc-reopen-'))),repo=path.join(root,'repo'),home=path.join(root,'app');
  t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(repo);
  for(const args of [['init','-q','-b','main'],['config','user.name','QA'],['config','user.email','qa@example.invalid'],['commit','--allow-empty','-qm','Initial']])await git(repo,...args);
  let now=100000,count=0,spaces=0,malformed=false,refuse=false;
  const hosts=[{name:null,layout:'ready'},{name:'server',layout:'ready'}],help={...HELP},raws=new Map(),programs=new Map(),effects=[],calls=[],created=[],offline=new Set();
  const world={spaces:[{id:'space-A',name:'repo',named:false,machine:null,folder:repo,tabs:[]},{id:'server/space-R',name:'remote-repo',named:false,machine:'server',folder:repo,tabs:[]}]};
  const tools=['claude','codex'].map(key=>({key,name:key==='claude'?'Claude Code':'Codex',run:['qa-'+key],installed:true}));
  const findTab=id=>world.spaces.flatMap(s=>s.tabs).find(t=>t.id===id);
  const addTab=(space,{argv,folder,name})=>{
    count++;const host=space.machine,tab=q(host,'tab-'+count),terminal=q(host,'t'+count);
    space.tabs.push({id:tab,index:space.tabs.length+1,name:name||String(space.tabs.length+1),named:Boolean(name),panes:1,terminals:[{terminal}]});
    raws.set(terminal,{address:'t'+count,created_ms:now+count,state:'live',cwd:folder,foreground:{pid:500+count,name:argv?argv[0]:'zsh',argv:argv||['/bin/zsh','-l'],cwd:folder},argv:argv?['/bin/zsh','-lic','"$@"; exec "$0" -li','/bin/zsh',...argv]:['/bin/zsh','-l'],labels:{'herdr.space':local(host,space.id),'herdr.tab':'tab-'+count}});
    programs.set(terminal,argv?{key:argv[0].replace(/^qa-/,''),name:argv[0]==='qa-claude'?'Claude Code':'Codex',agent:true}:{key:'zsh',name:'zsh',agent:false});
    return {space:space.id,tab,terminal};
  };
  const close=id=>{for(const s of world.spaces){const tab=s.tabs.find(t=>t.id===id);if(!tab)continue;for(const x of tab.terminals)raws.get(x.terminal).state='finished';s.tabs=s.tabs.filter(t=>t.id!==id);}world.spaces=world.spaces.filter(s=>s.tabs.length||['space-A','server/space-R'].includes(s.id)&&!s.closed);};
  const io={appHome:home,clock:()=>now,machines:()=>hosts,spaces:()=>world.spaces,agents:()=>[],delay:async()=>{},
    panes:()=>world.spaces.flatMap(s=>s.tabs.flatMap(t=>t.terminals.map(x=>({pane:'p-'+x.terminal,tab:t.id,terminal:x.terminal,cwd:raws.get(x.terminal).cwd,title:programs.get(x.terminal).name,program:programs.get(x.terminal),status:programs.get(x.terminal).agent?'idle':null})))),
    terminals:()=>[...raws].filter(([,r])=>r.state==='live').map(([address])=>({address,state:'live'})),
    run:(name,args)=>{effects.push([name,args]);if(name==='tab.close')close(args.id);if(name==='space.close'){const space=world.spaces.find(x=>x.id===args.id);for(const tab of space?.tabs||[])close(tab.id);world.spaces=world.spaces.filter(x=>x.id!==args.id);}if(name==='tab.rename'){const tab=findTab(args.id);if(tab){tab.name=args.name;tab.named=true;}}},
    knownAgents:async()=>tools,sessionSource:async provider=>({providerRoot:root+'/.providers/'+provider,credentialScope:'fixture'}),
    capabilities:{get:async(tool,on)=>parseCapabilities(tool,{on,help:help[tool.key],resumeHelp:'Usage: codex resume [OPTIONS] [SESSION_ID] [PROMPT]'})},
    readTextFile:async file=>{try{return await fs.readFile(file,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}},ensureDirectory:dir=>fs.mkdir(dir,{recursive:true}),
    writeTextFile:async(file,next,expected)=>{let actual=null;try{actual=sync.readFileSync(file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}if(actual!==expected)throw Object.assign(Error('stale'),{code:'STALE'});const temp=file+'.'+Math.random().toString(36).slice(2);sync.writeFileSync(temp,next);sync.renameSync(temp,file);},
    exec:async(cmd,args,options={})=>{
      const on=options.on??null;calls.push({cmd,args,on});
      if(cmd==='herdr-app'&&args[0]==='do'){
        const input=JSON.parse(args[2]);created.push({command:args[1],input});assert.ok(!input.argv?.includes('--last')&&!input.argv?.includes('--continue'));
        if(refuse){refuse=false;return {code:1,stdout:JSON.stringify({error:'the machine layout is unavailable'})};}
        let ack;
        if(args[1]==='tab.new'){const space=world.spaces.find(s=>s.id===input.space);assert.ok(space,'tab.new targets an open space');ack=addTab(space,{argv:input.argv,folder:input.folder,name:input.name});}
        else{assert.equal(args[1],'space.new');spaces++;const machine=input.machine??null,space={id:q(machine,'space-new-'+spaces),name:input.name||path.basename(input.folder),named:Boolean(input.name),machine,folder:input.folder,tabs:[]};world.spaces.push(space);ack=addTab(space,{folder:input.folder,name:input.tab});}
        if(malformed){malformed=false;return {code:0,stdout:'not-json'};}
        return {code:0,stdout:JSON.stringify(ack)};
      }
      if(cmd==='herdr-app'&&args[0]==='ls')return {code:0,stdout:JSON.stringify(world)};
      if(offline.has(on))throw Error('unreachable');
      if(cmd==='hc'&&args[0]==='ls')return {code:0,stdout:JSON.stringify({terminals:[...raws].filter(([id,r])=>r.state==='live'&&(on?id.startsWith(on+'/'):!id.includes('/'))).map(([,raw])=>({address:raw.address,state:raw.state}))})};
      if(cmd==='hc'&&args[0]==='get'){const raw=raws.get(q(on,args[1]));return raw?{code:0,stdout:JSON.stringify(raw)}:{code:1,stdout:''};}
      if(cmd==='test'){assert.equal(args[0],'-d');return {code:sync.existsSync(args[1])&&sync.statSync(args[1]).isDirectory()?0:1,stdout:''};}
      assert.equal(cmd,'git');return child(cmd,args,{cwd:options.cwd});
    }};
  const watcher=new ClosedWatcher(io,{owner:'watch-test'});
  const observe=async(times=2)=>{for(let i=0;i<times;i++){now+=LIMITS.observeMs;const r=await watcher.tick();assert.equal(r.error,undefined,JSON.stringify(r.error));}};
  const session=(id,provider='claude',machine=null)=>({machine,provider,credentialScope:'fixture',providerRoot:root+'/.providers/'+provider,sessionId:id});
  // A generic Mission Control launch: the caller-assigned exact session is bound to its acknowledged tab.
  const agent=async(id,{machine=null,spaceId=machine?'server/space-R':'space-A'}={})=>{const r=await launch({requestId:id,idempotencyKey:id,originId:'origin-'+id,spaceId,machine,repoRoot:repo,checkoutRoot:repo,toolKey:'claude',worktree:false},io);assert.equal(r.ok,true,JSON.stringify(r));return r;};
  const shell=(spaceId,folder,{name,program}={})=>{const ack=addTab(world.spaces.find(s=>s.id===spaceId),{folder,name});if(program)programs.set(ack.terminal,program);return ack;};
  const records=async()=>(await new ClosedJournal(io).read()).value.records;
  const tabNews=()=>created.filter(c=>c.command==='tab.new');
  return {root,repo,home,io,world,raws,effects,calls,created,hosts,help,offline,watcher,observe,session,agent,shell,close,records,findTab,tabNews,now:()=>now,advance:ms=>now+=ms,malform:()=>malformed=true,refuse:()=>refuse=true};
}

test('Reopen last agent skips a newer shell and resumes its exact ID; Reopen last tab then restores the shell in its starting folder',async t=>{
  const f=await fixture(t),sub=path.join(f.repo,'logs');await fs.mkdir(sub);
  const a=await f.agent('launch-A');const shellAck=f.shell('space-A',sub);await f.observe();
  f.close(a.tabId);await f.observe(1);f.close(shellAck.tab);await f.observe(1);
  let saved=await f.records();assert.deepEqual(saved.map(r=>r.kind),['shell','agent']);
  assert.equal(selectRecord({records:saved},'agent').record.kind,'agent');assert.equal(selectRecord({records:saved},'tab').record.kind,'shell');
  assert.equal(reopenPreview({records:saved},'agent').title,'Claude Code');assert.equal(reopenPreview({records:saved},'tab').title,'zsh');
  const before=f.tabNews().length,agent=await reopen('agent',f.io);
  assert.equal(agent.ok,true,JSON.stringify(agent));assert.equal(agent.action,'resume');assert.equal(agent.kind,'agent');assert.deepEqual(agent.session,a.session);
  const resumed=f.tabNews().at(-1).input;assert.equal(f.tabNews().length,before+1);assert.deepEqual(resumed.argv,['qa-claude','--resume',a.session.sessionId]);assert.equal(resumed.space,'space-A');assert.equal(resumed.folder,f.repo);
  const retired=await new BindingStore(f.io).requestState('launch-A');assert.equal(retired.state,'invalidated');assert.match(retired.reason,/closed/i);
  saved=await f.records();assert.deepEqual(saved.map(r=>r.kind),['shell']);
  const tab=await reopen('tab',f.io);assert.equal(tab.ok,true,JSON.stringify(tab));assert.equal(tab.action,'shell');
  const restored=f.tabNews().at(-1).input;assert.deepEqual(restored,{space:'space-A',folder:sub},'no argv and no invented name: the core starts its own shell');
  assert.ok(f.effects.some(([name,args])=>name==='tab.select'&&args.id===tab.tabId));assert.deepEqual(await f.records(),[]);
  const none=await reopen('tab',f.io);assert.equal(none.code,'NOTHING_TO_REOPEN');assert.deepEqual(none.recovery.actions,['import-history']);
  assert.equal((await reopen('agent',f.io)).code,'NOTHING_TO_REOPEN');assert.equal((await reopen('window',f.io)).code,'INVALID_REOPEN');
  assert.ok(f.created.every(c=>!(c.input.argv||[]).some(v=>v==='--last'||v==='--continue')));
});

test('Reopen last tab takes the newest close: an exact agent first, then a manually named shell; manual names return once',async t=>{
  const f=await fixture(t),a=await f.agent('launch-A'),logs=f.shell('space-A',f.repo,{name:'Logs'});await f.observe();
  f.findTab(a.tabId).name='My investigation';await new NameOwnership(f.io,{owner:'tabs-observer'}).observeNames([{id:a.tabId,machine:null,name:'My investigation',named:true}]);await f.observe(1);
  f.close(logs.tab);await f.observe(1);f.close(a.tabId);await f.observe(1);
  const first=await reopen('tab',f.io);assert.equal(first.ok,true,JSON.stringify(first));assert.equal(first.action,'resume');assert.equal(first.originId,'origin-launch-A');
  assert.deepEqual(f.effects.filter(([n])=>n==='tab.rename'),[['tab.rename',{id:first.tabId,name:'My investigation'}]]);
  const owner=await new NameOwnership(f.io).find({originId:'origin-launch-A'});assert.equal(owner.mode,'manual');assert.equal(owner.currentTab.tabId,first.tabId);
  const second=await reopen('tab',f.io);assert.equal(second.ok,true,JSON.stringify(second));assert.equal(second.action,'shell');assert.deepEqual(f.tabNews().at(-1).input,{space:'space-A',folder:f.repo,name:'Logs'});
  assert.equal(f.effects.filter(([n])=>n==='tab.rename').length,1);
});

test('a closed last tab recreates its space only from the verified folder on its own host; missing folders keep the record',async t=>{
  const f=await fixture(t),r=await f.agent('launch-R',{machine:'server'});await f.observe();
  f.world.spaces.find(s=>s.id==='server/space-R').closed=true;f.close(r.tabId);assert.equal(f.world.spaces.some(s=>s.id==='server/space-R'),false);await f.observe(1);
  const [record]=await f.records();assert.equal(record.machine,'server');assert.equal(record.space.id,'server/space-R');assert.deepEqual(record.terminals[0].session,r.session);
  const marker=f.calls.length,result=await reopen('agent',f.io);assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.recreatedSpace,true);
  const made=f.created.slice(-2);assert.deepEqual(made.map(c=>c.command),['space.new','tab.new']);assert.deepEqual(made[0].input,{folder:f.repo,machine:'server'});
  assert.equal(made[1].input.space,'server/space-new-1');assert.deepEqual(made[1].input.argv,['qa-claude','--resume',r.session.sessionId]);
  assert.ok(f.calls.slice(marker).filter(c=>c.cmd!=='herdr-app').every(c=>c.on==='server'),'host checks never fall back locally');
  const space=f.world.spaces.find(s=>s.id==='server/space-new-1');assert.deepEqual(space.tabs.map(x=>x.id),[result.tabId],'the helper shell was closed after the agent appeared');
  assert.ok(f.effects.some(([n,args])=>n==='tab.close'&&args.confirmed===true));await f.observe(2);assert.deepEqual(await f.records(),[],'the helper close is not a record');
  // Shell whose space and folder are both gone.
  const gone=path.join(f.root,'scratch');await fs.mkdir(gone);f.world.spaces.push({id:'space-S',name:'scratch',named:true,machine:null,folder:gone,tabs:[]});const s=f.shell('space-S',gone,{name:'Scratch'});await f.observe();
  f.close(s.tab);await f.observe(1);await fs.rm(gone,{recursive:true});
  const missing=await reopen('tab',f.io);assert.equal(missing.code,'FOLDER_MISSING');assert.deepEqual(missing.recovery.actions,['retry','dismiss']);
  const [kept]=await f.records();assert.equal(kept.error.code,'FOLDER_MISSING');assert.equal(kept.claim,null);
  await fs.mkdir(gone);const back=await reopen('tab',f.io);assert.equal(back.ok,true,JSON.stringify(back));assert.equal(back.recreatedSpace,true);
  assert.deepEqual(f.created.at(-1),{command:'space.new',input:{folder:gone,name:'scratch',tab:'Scratch'}});assert.deepEqual(await f.records(),[]);
});

test('concurrent clicks and two controllers create one tab; refused, malformed and interrupted acknowledgments never duplicate',async t=>{
  const f=await fixture(t);for(let i=0;i<4;i++)f.shell('space-A',f.repo);await f.observe(2);
  for(const tab of f.world.spaces[0].tabs.map(x=>x.id))f.close(tab);await f.observe(1);assert.equal((await f.records()).length,4);
  let before=f.tabNews().length;const pair=await Promise.all([reopen('tab',f.io),reopen('tab',f.io)]);
  assert.equal(f.tabNews().length,before+1,JSON.stringify(pair));assert.equal(pair.filter(r=>r.ok).length,1);assert.ok(['REOPEN_IN_PROGRESS','RECORD_GONE'].includes(pair.find(r=>!r.ok).code));
  const a=new ReopenController(f.io,{owner:'copy-A'}),b=new ReopenController(f.io,{owner:'copy-B'});await Promise.all([a.refresh(),b.refresh()]);
  before=f.tabNews().length;const copies=await Promise.all([a.run('tab'),b.run('tab'),a.run('tab')]);
  assert.equal(f.tabNews().length,before+1,JSON.stringify(copies));assert.equal(copies.filter(r=>r.ok).length,1);assert.equal((await f.records()).length,2);
  f.refuse();const refused=await reopen('tab',f.io);assert.equal(refused.code,'REOPEN_FAILED');assert.match(refused.message,/layout is unavailable/);
  let [next]=await f.records();assert.equal(next.claim,null);assert.equal(next.error.code,'REOPEN_FAILED');
  f.malform();before=f.tabNews().length;const bad=await reopen('tab',f.io);assert.equal(bad.code,'MALFORMED_ACK');assert.deepEqual(bad.recovery.actions,['locate','retry-uncertain','dismiss']);
  const again=await reopen('tab',f.io);assert.equal(again.code,'TAB_CREATE_UNCERTAIN');assert.equal(f.tabNews().length,before+1,'no blind retry');
  const forced=await reopenRecord(again.recovery.recordId,f.io,{confirmUncertain:true});assert.equal(forced.ok,true,JSON.stringify(forced));assert.equal(f.tabNews().length,before+2);
  // Interrupted after Herdr acknowledged: recovery focuses the acknowledged tab instead of opening another.
  const [last]=await f.records(),ack=f.shell('space-A',f.repo),journal=new ClosedJournal(f.io);
  await journal.claim(last.id,'interrupted-op');await journal.updateClaim(last.id,'interrupted-op',{phase:'acknowledged',ack});f.advance(LIMITS.claimMs+1);
  before=f.tabNews().length;const recovered=await reopen('tab',f.io);assert.equal(recovered.ok,true,JSON.stringify(recovered));assert.equal(recovered.action,'focus');assert.equal(recovered.tabId,ack.tab);assert.equal(f.tabNews().length,before);assert.deepEqual(await f.records(),[]);
});

test('a skipped watcher tick still reads closes recorded elsewhere, so the Reopen preview is never stale',async t=>{
  const f=await fixture(t);f.shell('space-A',f.repo);await f.observe(2);
  const b=new ReopenController(f.io,{owner:'copy-B'});await b.refresh();assert.equal(b.preview('tab').state,'empty');
  f.close(f.world.spaces[0].tabs[0].id);await f.observe(1);assert.equal((await f.records()).length,1);
  b.watcher.started=f.now();const r=await b.tick();assert.equal(r.skipped,true,'an earlier tick of this copy is still in flight');
  assert.equal(b.preview('tab').state,'ready','the copy reads the record the recording copy wrote');
});
test('offline hosts, inexact agents and unsupported resume keep the record with a reason; live exact work only focuses',async t=>{
  const f=await fixture(t),remote=f.shell('server/space-R',f.repo);await f.observe();f.close(remote.tab);await f.observe(1);
  f.hosts[1].layout='unavailable';const marker=f.calls.length,offline=await reopen('tab',f.io);assert.equal(offline.code,'HOST_UNAVAILABLE');assert.deepEqual(offline.recovery.actions,['retry','dismiss']);
  assert.deepEqual(f.calls.slice(marker),[],'nothing runs on another host instead');assert.equal((await f.records())[0].error.code,'HOST_UNAVAILABLE');
  f.hosts[1].layout='ready';assert.equal((await dismissRecord((await f.records())[0].id,f.io)).dismissed,true);assert.deepEqual(await f.records(),[]);
  // An agent started outside Mission Control has no exact session: never resumed by guessing.
  const plain=f.shell('space-A',f.repo,{program:{key:'claude',name:'Claude Code',agent:true}});await f.observe();f.close(plain.tab);await f.observe(1);
  const inexact=await reopen('agent',f.io);assert.equal(inexact.code,'NO_EXACT_SESSION');assert.deepEqual(inexact.recovery.actions,['dismiss']);assert.equal((await f.records()).length,1);
  assert.equal(reopenPreview({records:await f.records()},'agent').state,'unsupported');assert.match(reopenPreview({records:await f.records()},'tab').reason,/shell/);
  const asShell=await reopen('tab',f.io);assert.equal(asShell.ok,true,JSON.stringify(asShell));assert.deepEqual(asShell.notices,['agent-not-resumed']);assert.equal(f.tabNews().at(-1).input.argv,undefined);
  // Exact record, but the installed tool no longer verifies exact resume.
  const a=await f.agent('launch-A');await f.observe();f.close(a.tabId);await f.observe(1);
  f.help.claude='Claude Code\nUsage: claude [options] [prompt]\n --session-id <uuid>';const before=f.tabNews().length,unsupported=await reopen('agent',f.io);
  assert.equal(unsupported.code,'UNSUPPORTED_RESUME',JSON.stringify(unsupported));assert.ok(unsupported.recovery.actions.includes('dismiss'));assert.equal(f.tabNews().length,before);assert.equal((await f.records())[0].error.code,'UNSUPPORTED_RESUME');
  f.help.claude=HELP.claude;
  // Already resumed elsewhere (for example from Sessions): reopen focuses that exact live terminal and consumes the record.
  const elsewhere=await resume({requestId:'sessions-click',spaceId:'space-A',session:a.session,repoRoot:f.repo,cwd:f.repo},f.io);assert.equal(elsewhere.ok,true,JSON.stringify(elsewhere));
  const tabs=f.tabNews().length;f.effects.length=0;const live=await reopen('agent',f.io);assert.equal(live.ok,true,JSON.stringify(live));assert.equal(live.action,'focus');assert.equal(live.tabId,elsewhere.tabId);
  assert.equal(f.tabNews().length,tabs);assert.ok(f.effects.some(([n])=>n==='agent.focus'));assert.deepEqual(await f.records(),[]);
  // Its space was closed too, but the exact session already runs elsewhere: the recreated helper space goes away again.
  f.world.spaces.push({id:'space-B',name:'repo-b',named:false,machine:null,folder:f.repo,tabs:[]});const b=await f.agent('launch-B',{spaceId:'space-B'});await f.observe();f.close(b.tabId);await f.observe(1);
  // As the Agents telemetry reconcile does once a terminal is gone; shared resume itself does not check liveness.
  assert.equal(f.world.spaces.some(x=>x.id==='space-B'),false);await new BindingStore(f.io).invalidate('launch-B','Terminal closed');const runningB=await resume({requestId:'sessions-B',spaceId:'space-A',session:b.session,repoRoot:f.repo,cwd:f.repo},f.io);assert.equal(runningB.action,'resume',JSON.stringify(runningB));
  const focused=await reopen('agent',f.io);assert.equal(focused.ok,true,JSON.stringify(focused));assert.equal(focused.action,'focus');assert.equal(focused.tabId,runningB.tabId);assert.deepEqual(focused.notices,[]);
  const helper=f.created.at(-1);assert.equal(helper.command,'space.new');assert.ok(f.effects.some(([n,args])=>n==='space.close'&&args.confirmed===true));assert.equal(f.world.spaces.some(x=>x.id.startsWith('space-new-')),false);
  await f.observe(2);assert.deepEqual(await f.records(),[],'the helper close is not recorded');
});

test('partial imported history is never called newest; restore plans, previews and help state their limits',async t=>{
  const f=await fixture(t),journal=new ClosedJournal(f.io);
  const imported=(id,ordered,closedAt)=>({id,seq:0,source:'imported',ordered,closedAt,machine:null,kind:'shell',space:{id:'space-A',name:'repo',named:false,folder:f.repo},tab:{id:'tab-'+id,name:null,named:false,index:null},terminals:[{address:'t9'+closedAt%10,createdMs:1,startCwd:f.repo,program:null,agent:false,title:null}],panes:2,origin:null,claim:null,error:null});
  await journal.edit(d=>{d.records.push(imported('c-0000000000000001',false,200),imported('c-0000000000000002',false,300));});
  const partial=await reopen('tab',f.io);assert.equal(partial.code,'HISTORY_PARTIAL');assert.deepEqual(partial.recovery.actions,['choose','import-history']);assert.equal(reopenPreview((await journal.read()).value,'tab').state,'partial');
  const chosen=await reopenRecord('c-0000000000000001',f.io);assert.equal(chosen.ok,true,JSON.stringify(chosen));assert.deepEqual(chosen.notices,['panes-not-restored']);
  await journal.edit(d=>{d.records[0].ordered=true;});assert.equal(selectRecord((await journal.read()).value,'tab').record.id,'c-0000000000000002');
  assert.throws(()=>restorePlan({...imported('c-0000000000000003',true,1),kind:'shell'},'agent'),e=>e.code==='NOT_AN_AGENT');
  assert.equal(reopenPreview(null,'tab').state,'loading');
  for(const phrase of ['skips shell-only tabs','not its last cd','never guessed','Split layout','last 100','No keys are bound'])assert.ok(REOPEN_LIMITATIONS.some(l=>l.includes(phrase)),phrase);
});
