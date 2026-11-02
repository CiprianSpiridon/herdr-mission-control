import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import sync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {resume,resumeSupport,validateResumeRequest} from '../src/shared/resume.js';
import {parseCapabilities} from '../src/shared/tool-capabilities.js';
import {BindingStore,argvSessionProof} from '../src/shared/session-bindings.js';
import {NameOwnership} from '../src/shared/name-ownership.js';
import {terminalIdentity} from '../src/shared/session-identity.js';
const child=(cmd,args,options={})=>new Promise((resolve,reject)=>{const p=spawn(cmd,args,{cwd:options.cwd});let stdout='',stderr='';p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);p.on('error',reject);p.on('close',code=>resolve({code,stdout,stderr}));});
const git=async(dir,...args)=>{const r=await child('git',['-C',dir,...args]);assert.equal(r.code,0,r.stderr);};
const A='019c7714-3b77-74d1-9866-e1f484aae2ab',B='11111111-1111-4111-8111-111111111111',C='22222222-2222-4222-8222-222222222222',D='33333333-3333-4333-8333-333333333333';
const HELP={claude:'Claude Code\nUsage: claude [options] [prompt]\n --session-id <uuid>\n --resume [value]\n --model <model>',codex:'Codex CLI\nUsage: codex [OPTIONS] [PROMPT]\n --no-daemon\n --model <MODEL>',grok:'Grok Build TUI\nUsage: grok [OPTIONS] [PROMPT]\n --model <MODEL>'};
async function fixture(t){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'mc-resume-'))),repo=path.join(root,'repo'),other=path.join(root,'repo-other'),linked=path.join(root,'linked'),home=path.join(root,'app');
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  for(const dir of [repo,other]){await fs.mkdir(dir);for(const args of [['init','-q','-b','main'],['config','user.name','QA'],['config','user.email','qa@example.invalid'],['commit','--allow-empty','-qm','Initial']])await git(dir,...args);}
  await git(repo,'worktree','add','-q','-b','linked',linked,'HEAD');
  let count=0,now=1000,malformed=false,failCommit=false,unreachable=false;
  const effects=[],calls=[],launched=[],raws=new Map(),hosts=[{name:null,layout:'ready'},{name:'server',layout:'ready'}],help={...HELP},qualified=(on,id)=>on?on+'/'+id:id;
  const world={spaces:[{id:'space-A',name:'repo',machine:null,folder:repo,tabs:[]},{id:'server/space-R',name:'repo',machine:'server',folder:repo,tabs:[]}]};
  const tools=['claude','codex','grok'].map(key=>({key,name:key,run:['qa-'+key],installed:true}));
  const io={appHome:home,clock:()=>now,spaces:()=>world.spaces,machines:()=>hosts,run:(...args)=>effects.push(args),delay:async()=>{},
    knownAgents:async({on=null}={})=>{calls.push({cmd:'knownAgents',on});if(unreachable&&on)throw Error('unreachable');return tools;},
    sessionSource:async provider=>({providerRoot:root+'/.providers/'+provider,credentialScope:'fixture'}),
    capabilities:{get:async(tool,on)=>parseCapabilities(tool,{on,help:help[tool.key],resumeHelp:'Usage: codex resume [OPTIONS] [SESSION_ID] [PROMPT]'})},
    readTextFile:async file=>{try{return await fs.readFile(file,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}},ensureDirectory:dir=>fs.mkdir(dir,{recursive:true}),
    writeTextFile:async(file,next,expected)=>{
      if(failCommit&&file.endsWith('session-bindings.json')&&Object.values(JSON.parse(next).proposals).some(r=>r.state==='committed')){failCommit=false;throw Object.assign(Error('injected disk failure'),{code:'EACCES'});}
      // Herdr replaces files atomically; concurrent readers never see a partial journal.
      let actual=null;try{actual=sync.readFileSync(file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}if(actual!==expected)throw Object.assign(Error('stale'),{code:'STALE'});
      const temp=file+'.'+process.pid+'-'+Math.random().toString(36).slice(2);sync.writeFileSync(temp,next);sync.renameSync(temp,file);
    },
    exec:async(cmd,args,options={})=>{
      const on=options.on??null;calls.push({cmd,args,on,cwd:options.cwd});
      if(cmd==='herdr-app'&&args[0]==='do'){
        assert.equal(args[1],'tab.new');const input=JSON.parse(args[2]),space=world.spaces.find(s=>s.id===input.space),host=space.machine;launched.push(input);count++;
        assert.ok(!input.argv.includes('--last')&&!input.argv.includes('--continue'));
        const tab=qualified(host,'tab-'+count),terminal=qualified(host,'t'+count);space.tabs.push({id:tab,name:input.name,named:true,terminals:[{terminal}]});
        raws.set(terminal,{address:'t'+count,created_ms:100+count,state:'live',cwd:input.folder,foreground:{pid:500+count,name:input.argv[0],argv:input.argv,cwd:input.folder},argv:['/bin/zsh','-lic','"$@"; exec "$0" -li','/bin/zsh',...input.argv],labels:{'herdr.space':space.id.replace(/^server\//,''),'herdr.tab':'tab-'+count}});
        if(malformed){malformed=false;return {code:0,stdout:'not-json'};}
        return {code:0,stdout:JSON.stringify({space:space.id,tab,terminal})};
      }
      if(cmd==='herdr-app'&&args[0]==='ls')return {code:0,stdout:JSON.stringify(world)};
      if(unreachable&&on)throw Error('unreachable');
      // Summaries omit generation/foreground so exact identity always comes from hc get.
      if(cmd==='hc'&&args[0]==='ls')return {code:0,stdout:JSON.stringify({terminals:[...raws].filter(([id])=>on?id.startsWith(on+'/'):!id.includes('/')).map(([,raw])=>({address:raw.address,state:raw.state,labels:raw.labels}))})};
      if(cmd==='hc'&&args[0]==='get'){const raw=raws.get(qualified(on,args[1]));return raw?{code:0,stdout:JSON.stringify(raw)}:{code:1,stdout:''};}
      assert.equal(cmd,'git');return child(cmd,args,{cwd:options.cwd});
    }};
  // A terminal that was not started through this resume path.
  const live=(id,{name='qa-claude',argv=[name],cwd=repo}={})=>{raws.set(id,{address:id,created_ms:50,state:'live',cwd,foreground:{pid:900+Number(id.slice(1)),name,argv,cwd},argv,labels:{'herdr.space':'space-A','herdr.tab':'tab-'+id}});world.spaces[0].tabs.push({id:'tab-'+id,name,named:false,terminals:[{terminal:id}]});};
  const close=id=>{raws.delete(id);for(const s of world.spaces)s.tabs=s.tabs.filter(t=>!t.terminals.some(x=>x.terminal===id));};
  const session=(id,provider='claude',machine=null)=>({machine,provider,credentialScope:'fixture',providerRoot:root+'/.providers/'+provider,sessionId:id});
  const request=(id,s,extra={})=>({requestId:id,spaceId:s.machine?'server/space-R':'space-A',session:s,repoRoot:repo,cwd:repo,...extra});
  const file=name=>fs.readFile(home+'/mission-control/'+name,'utf8').catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  return {root,repo,other,linked,io,world,raws,effects,calls,launched,hosts,help,live,close,session,request,file,count:()=>count,now:()=>now,setTime:n=>now=n,malform:()=>malformed=true,failCommit:()=>failCommit=true,unreachable:v=>unreachable=v};
}
async function bind(f,address,s){
  const terminal=terminalIdentity(f.raws.get(address),null),store=new BindingStore(f.io,{clock:f.now}),requestId='proof-'+address+'-'+s.sessionId.slice(0,8);
  await store.propose({requestId,originId:'origin-'+requestId,session:s});
  await store.commitAcknowledged(requestId,{tabId:'tab-'+address,terminal},argvSessionProof({capabilities:{machine:null,provider:s.provider,run:['qa-'+s.provider],resume:{kind:'flag',flag:'--resume'}},session:s,terminal,argv:['qa-'+s.provider,'--resume',s.sessionId],kind:'resume-argv',observedAt:f.now(),sourceDigest:'fixture-proof'}));
  return {store,requestId};
}
const launches=f=>f.calls.filter(c=>c.cmd==='herdr-app'&&c.args[0]==='do').length;
test('the non-last same-repo session resumes its exact verified ID in its original checkout, then focuses its proven terminal',async t=>{
  const f=await fixture(t),a=f.session(A),b=f.session(B),c=f.session(C,'codex');
  const first=await resume(f.request('click-A',a),f.io);assert.equal(first.ok,true,JSON.stringify(first));assert.equal(first.action,'resume');
  assert.deepEqual(f.launched[0].argv,['qa-claude','--resume',A]);assert.equal(f.launched[0].folder,f.repo);assert.equal(f.launched[0].space,'space-A');assert.deepEqual(first.session,a);
  const newer=await resume(f.request('click-B',b),f.io);assert.equal(newer.ok,true,JSON.stringify(newer));assert.deepEqual(f.launched[1].argv,['qa-claude','--resume',B]);
  const codex=await resume(f.request('click-C',c,{cwd:f.linked}),f.io);assert.equal(codex.ok,true,JSON.stringify(codex));assert.deepEqual(f.launched[2].argv,['qa-codex','--no-daemon','resume',C]);assert.equal(codex.folder,f.linked);
  const fresh=new BindingStore(f.io,{clock:f.now});assert.equal((await fresh.readCommitted(terminalIdentity(f.raws.get('t1')))).session.sessionId,A);assert.equal((await fresh.readCommitted(terminalIdentity(f.raws.get('t3')))).session.sessionId,C);
  f.effects.length=0;const again=await resume(f.request('click-A-again',a),f.io);
  assert.equal(again.action,'focus',JSON.stringify(again));assert.equal(again.tabId,first.tabId);assert.deepEqual(f.effects,[['agent.focus',{terminal:'t1'}]]);assert.equal(launches(f),3);
  f.close('t1');const reopened=await resume(f.request('click-A-closed',a),f.io);assert.equal(reopened.action,'resume',JSON.stringify(reopened));assert.equal(launches(f),4);assert.deepEqual(f.launched[3].argv,['qa-claude','--resume',A]);
  const journal=JSON.parse(await f.file('launches.json'));assert.deepEqual(Object.values(journal.requests).filter(r=>r.sessionProposal?.sessionId===A).map(r=>r.request.idempotencyKey.slice(-2)),['-0','-1']);
});
test('a remote session resumes only on its original host and offline/wrong hosts never fall back locally',async t=>{
  const f=await fixture(t),s=f.session(A,'claude','server');
  const result=await resume(f.request('remote-A',s),f.io);assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.terminalId,'server/t1');
  assert.equal(f.launched[0].space,'server/space-R');assert.deepEqual(f.launched[0].argv,['qa-claude','--resume',A]);
  const hostCalls=f.calls.filter(c=>c.cmd!=='herdr-app');assert.ok(hostCalls.some(c=>c.cmd==='git')&&hostCalls.some(c=>c.cmd==='hc'));assert.deepEqual(hostCalls.filter(c=>c.on!=='server'),[]);
  f.effects.length=0;assert.equal((await resume(f.request('remote-A-2',s),f.io)).action,'focus');assert.deepEqual(f.effects,[['agent.focus',{terminal:'server/t1'}]]);
  const verified=f.io.capabilities.get;f.io.capabilities.get=async tool=>verified(tool,null);
  assert.equal((await resume(f.request('remote-D',f.session(D,'claude','server')),f.io)).code,'UNSUPPORTED_RESUME');f.io.capabilities.get=verified;assert.equal(launches(f),1);
  const before=f.calls.length;const wrong=await resume({...f.request('wrong-host',s),spaceId:'space-A'},f.io);assert.equal(wrong.code,'WRONG_HOST');assert.equal(f.calls.length,before);
  f.hosts[1].layout='unavailable';const offline=await resume(f.request('offline',s),f.io);assert.equal(offline.code,'HOST_UNAVAILABLE');assert.deepEqual(offline.recovery.actions,['retry']);assert.equal(f.calls.length,before);
  f.hosts[1].layout='ready';f.unreachable(true);const gone=await resume(f.request('unreachable',s),f.io);assert.equal(gone.code,'HOST_UNAVAILABLE');
  assert.ok(f.calls.slice(before).every(c=>c.on==='server'));assert.equal(launches(f),1);
});
test('same-session double clicks and concurrent separate intents create exactly one acknowledged tab',async t=>{
  const f=await fixture(t),a=f.session(A),b=f.session(B);
  const same=await Promise.all([resume(f.request('click',a),f.io),resume(f.request('click',a),f.io)]);
  assert.equal(launches(f),1,JSON.stringify(same));assert.ok(same.some(r=>r.action==='resume'),JSON.stringify(same));assert.ok(same.every(r=>r.ok||r.code==='RESUME_IN_PROGRESS'),JSON.stringify(same));
  const separate=await Promise.all([resume(f.request('x',b),f.io),resume(f.request('y',b),f.io),resume(f.request('z',b),f.io)]);
  assert.equal(launches(f),2,JSON.stringify(separate));assert.ok(separate.every(r=>r.ok||r.code==='RESUME_IN_PROGRESS'),JSON.stringify(separate));
  const replay=await resume(f.request('click',a),f.io);assert.equal(replay.ok,true);assert.equal(replay.action,'focus');assert.equal(launches(f),2);
  const changed=await resume(f.request('click',f.session(D)),f.io);assert.equal(changed.code,'RETRY_CHANGED');assert.equal(launches(f),2);
});
test('an unbound live same-host/provider/repo terminal blocks resume with zero side effects until exact proof decides',async t=>{
  const f=await fixture(t),a=f.session(A),b=f.session(B);
  f.live('t9');f.live('t10',{cwd:f.other});f.live('t11',{name:'qa-codex'});f.live('t12',{name:'zsh',argv:['/bin/zsh','-li']});f.live('t13',{name:'node',argv:['node','/opt/tools/qa-claude'],cwd:f.linked});
  const blocked=await resume(f.request('click-1',a),f.io);assert.equal(blocked.code,'AMBIGUOUS_RUNNING_SESSION',JSON.stringify(blocked));
  assert.deepEqual(blocked.recovery.actions,['locate','retry-binding','close-existing-and-retry']);assert.deepEqual(blocked.recovery.candidates.map(c=>c.terminal),['t9','t13']);assert.equal(blocked.recovery.candidates[0].tabId,'tab-t9');
  assert.deepEqual(f.effects,[]);assert.equal(launches(f),0);for(const name of ['launches.json','session-bindings.json','names.json'])assert.equal(await f.file(name),null,name);
  f.close('t13');const proofA=await bind(f,'t9',a),snapshot=await f.file('session-bindings.json');
  const focused=await resume(f.request('click-2',a),f.io);assert.equal(focused.action,'focus',JSON.stringify(focused));assert.deepEqual(f.effects,[['agent.focus',{terminal:'t9'}]]);assert.equal(launches(f),0);assert.equal(await f.file('session-bindings.json'),snapshot);assert.equal(await f.file('launches.json'),null);
  await proofA.store.invalidate(proofA.requestId,'Proof now identifies another session');await bind(f,'t9',b);f.effects.length=0;
  const resumed=await resume(f.request('click-3',a),f.io);assert.equal(resumed.action,'resume',JSON.stringify(resumed));assert.equal(launches(f),1);assert.deepEqual(f.launched[0].argv,['qa-claude','--resume',A]);
  assert.ok(!f.effects.some(([name])=>name==='agent.focus'));
});
test('pending acknowledged resumes retry only their binding and uncertain creation is never blindly repeated',async t=>{
  const f=await fixture(t),a=f.session(A),b=f.session(B);
  f.failCommit();const failed=await resume(f.request('click-A',a),f.io);assert.equal(failed.ok,false);assert.equal(failed.recovery.tabId,'tab-1');assert.deepEqual(failed.recovery.actions,['locate','retry-binding']);assert.equal(launches(f),1);
  assert.equal((await resume(f.request('other-click',a),f.io)).code,'RESUME_IN_PROGRESS');
  const retried=await resume(f.request('click-A',a),f.io);assert.equal(retried.ok,true,JSON.stringify(retried));assert.equal(retried.action,'focus');assert.equal(retried.tabId,'tab-1');assert.equal(launches(f),1);
  assert.equal(JSON.parse(await f.file('launches.json')).requests['click-A'].state,'complete');
  f.malform();const uncertain=await resume(f.request('click-B',b),f.io);assert.equal(uncertain.code,'MALFORMED_ACK');assert.deepEqual(uncertain.recovery.actions,['locate','close-existing-and-retry']);assert.equal(launches(f),2);
  assert.equal((await resume(f.request('click-B-2',b),f.io)).code,'RESUME_IN_PROGRESS');
  f.setTime(f.now()+61000);const ambiguous=await resume(f.request('click-B-3',b),f.io);assert.equal(ambiguous.code,'AMBIGUOUS_RUNNING_SESSION');assert.deepEqual(ambiguous.recovery.candidates.map(c=>c.terminal),['t2']);assert.equal(launches(f),2);
  f.close('t2');const after=await resume(f.request('click-B-4',b),f.io);assert.equal(after.action,'resume',JSON.stringify(after));assert.equal(launches(f),3);assert.deepEqual(f.launched[2].argv,['qa-claude','--resume',B]);
  f.effects.length=0;assert.equal((await resume(f.request('click-B',b),f.io)).action,'focus');assert.deepEqual(f.effects,[['agent.focus',{terminal:'t3'}]]);
  f.close('t3');const replay=await resume(f.request('click-B',b),f.io);assert.equal(replay.code,'RECOVERY_REQUIRED');assert.deepEqual(replay.recovery.actions,['locate','close-existing-and-retry']);assert.equal(launches(f),3);
});
test('missing worktrees, unsupported tools, wrong IDs and other accounts never launch and keep saved identity',async t=>{
  const f=await fixture(t),c=f.session(C,'codex'),input=f.request('missing',c,{cwd:f.linked}),saved=JSON.stringify(input);
  await fs.rm(f.linked,{recursive:true,force:true});const missing=await resume(input,f.io);assert.equal(missing.code,'WORKTREE_MISSING',JSON.stringify(missing));assert.deepEqual(missing.recovery.actions,['locate','retry']);
  assert.equal(JSON.stringify(input),saved);for(const name of ['launches.json','session-bindings.json','names.json'])assert.equal(await f.file(name),null,name);
  await git(f.repo,'worktree','prune');await git(f.repo,'worktree','add','-q',f.linked,'linked');const located=await resume(input,f.io);assert.equal(located.ok,true,JSON.stringify(located));assert.equal(located.folder,f.linked);assert.equal(launches(f),1);
  await fs.mkdir(f.repo+'/src');
  const rejected=[[f.request('gone',f.session(A),{cwd:f.root+'/deleted'}),'WORKTREE_MISSING'],[f.request('sub',f.session(A),{cwd:f.repo+'/src'}),'CHECKOUT_MISMATCH'],[f.request('other-repo',f.session(B),{cwd:f.other}),'CHECKOUT_MISMATCH'],[f.request('last',f.session('last')),'INVALID_SESSION'],[f.request('continue',f.session('--continue')),'INVALID_SESSION'],
    [f.request('grok',f.session(D,'grok')),'UNSUPPORTED_RESUME'],[f.request('switch-tool',f.session(D),{toolKey:'codex'}),'UNSUPPORTED_RESUME'],[f.request('account',{...f.session(D),credentialScope:'personal'}),'ACCOUNT_MISMATCH'],
    [f.request('unknown-tool',f.session(D,'pi')),'TOOL_UNAVAILABLE'],[f.request('space',f.session(D),{spaceId:'closed-space'}),'SPACE_UNAVAILABLE'],[{...f.request('relative',f.session(D)),cwd:'repo'},'INVALID_RESUME']];
  for(const [request,code]of rejected){const result=await resume(request,f.io);assert.equal(result.code,code,JSON.stringify(result));assert.ok(Object.isFrozen(result.recovery));}
  f.help.claude='Claude Code\nUsage: claude [options] [prompt]\n --model <model>';assert.equal((await resume(f.request('no-resume',f.session(D)),f.io)).code,'UNSUPPORTED_RESUME');
  assert.equal(launches(f),1);assert.ok(f.launched.every(l=>!l.argv.some(a=>a==='--last'||a==='--continue')));
  const claude=parseCapabilities({key:'claude',run:['claude'],installed:true},{help:HELP.claude});
  assert.equal(resumeSupport(parseCapabilities({key:'grok',run:['grok'],installed:true},{help:HELP.grok}),{provider:'grok'}).supported,false);
  assert.equal(resumeSupport(parseCapabilities({key:'claude',run:['my-claude'],installed:true},{help:''}),{provider:'claude'}).supported,false);
  assert.equal(resumeSupport(claude,{provider:'claude',machine:'server'}).supported,false);
  assert.deepEqual(resumeSupport(claude,{provider:'claude',machine:null}),{supported:true,kind:'flag',reason:null});
  assert.throws(()=>validateResumeRequest({...f.request('proto',f.session(D)),requestId:'__proto__'}),e=>e.code==='INVALID_RESUME');assert.ok(Object.isFrozen(validateResumeRequest(f.request('ok',f.session(D))).session));
});
test('a captured manual name follows exact session A once while unknown history keeps its reported title',async t=>{
  const f=await fixture(t),a=f.session(A),b=f.session(B),d=f.session(D),names=new NameOwnership(f.io,{owner:'seed'});
  await names.transferToAcknowledgedTab({originId:'origin-A',session:a},{tabId:'old-A',name:'claude'});await names.observeNames([{id:'old-A',machine:null,name:'My investigation',named:true}]);
  await names.transferToAcknowledgedTab({originId:'origin-B',session:b},{tabId:'old-B',name:'Newer B'});
  const renames=()=>f.effects.filter(([name])=>name==='tab.rename');
  const restored=await resume(f.request('click-A',a,{title:'Provider title A'}),f.io);assert.equal(restored.ok,true,JSON.stringify(restored));assert.equal(restored.originId,'origin-A');assert.notEqual(restored.tabId,'old-A');
  assert.deepEqual(renames(),[['tab.rename',{id:restored.tabId,name:'My investigation'}]]);
  assert.equal((await resume(f.request('click-A-2',a,{title:'Provider title A'}),f.io)).action,'focus');assert.equal(renames().length,1);
  const owner=await new NameOwnership(f.io).find({session:a});assert.equal(owner.mode,'manual');assert.equal(owner.currentTab.tabId,restored.tabId);assert.equal((await names.find({originId:'origin-B'})).lastAutoName,'Newer B');
  const imported=await resume(f.request('click-D',d,{title:'Reported D'}),f.io);assert.equal(imported.ok,true,JSON.stringify(imported));assert.match(imported.originId,/^session-[0-9a-f]{16}$/);
  assert.deepEqual(renames().slice(1),[['tab.rename',{id:imported.tabId,name:'Reported D'}]]);
  const record=await names.find({session:d});assert.equal(record.mode,'auto');assert.equal(record.manualName,null);assert.equal(record.lastAutoName,'Reported D');
});

test('a finished bound terminal that hc still lists is resumed again, never focused',async t=>{
  const f=await fixture(t),a=f.session(A);assert.equal((await resume(f.request('click-A',a),f.io)).action,'resume');
  // hc keeps finished terminals until removal, so the committed binding still names a readable generation.
  f.raws.get('t1').state='finished';for(const s of f.world.spaces)s.tabs=s.tabs.filter(tab=>!tab.terminals.some(x=>x.terminal==='t1'));f.effects.length=0;
  const again=await resume(f.request('click-A-finished',a),f.io);assert.equal(again.ok,true,JSON.stringify(again));assert.equal(again.action,'resume');assert.equal(launches(f),2);assert.deepEqual(f.launched[1].argv,['qa-claude','--resume',A]);
  assert.ok(!f.effects.some(e=>e[0]==='agent.focus'),'A dead terminal is never focused as the live session');
});
