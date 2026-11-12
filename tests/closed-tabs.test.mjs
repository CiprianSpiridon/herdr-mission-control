import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import sync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {ClosedJournal,ClosedWatcher,importClosedHistory,snapshotWorld,validateClosedJournal,LIMITS,HISTORY_WRAPPER} from '../src/shared/closed-tabs.js';
import recorded from './fixtures/herdr-0113-launch-argv.json' with {type:'json'};
import {BindingStore,argvSessionProof} from '../src/shared/session-bindings.js';
import {NameOwnership} from '../src/shared/name-ownership.js';
import {terminalIdentity} from '../src/shared/session-identity.js';

const SECRET='ghp_fixtureSecretTokenValue0123456789',TASK='Fix the login bug; the password is hunter2';
const q=(machine,id)=>machine?machine+'/'+id:id;
const SHELL={key:'zsh',name:'zsh',agent:false},CLAUDE={key:'claude',name:'Claude Code',agent:true};
const FAKE_HC=`#!/usr/bin/env python3
import json,os,sys,time
here=os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(here,'pids'),'a') as f: f.write(str(os.getpid())+'\\n')
data=json.load(open(os.path.join(here,'data.json')))
args=sys.argv[1:]
if data.get('mode')=='hang': time.sleep(30)
if args[:1]==['ls'] and data.get('mode')=='flood':
  chunk=b'x'*65536
  for _ in range(200): sys.stdout.buffer.write(chunk)
  sys.exit(0)
if args[:1]==['ls'] and data.get('mode')=='malformed': print('{"nope":1}'); sys.exit(0)
if args==['ls','--all','--json']: print(json.dumps(data['ls'])); sys.exit(0)
if args[:1]==['get'] and args[1] in data['get']: print(json.dumps(data['get'][args[1]])); sys.exit(0)
sys.exit(1)
`;
const child=(cmd,args,options={})=>new Promise((resolve,reject)=>{const p=spawn(cmd,args,options);let stdout='',stderr='';p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);p.on('error',reject);p.on('close',code=>resolve({code,stdout,stderr}));});
async function fixture(t){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'mc-closed-'))),home=path.join(root,'app'),repo=path.join(root,'repo');
  t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(repo,{recursive:true});
  let now=100000;const hosts=[{name:null,layout:'ready'},{name:'server',layout:'ready'}],spaces=[],panes=[],raws=new Map(),calls=[],hidden=new Map(),unreachable=new Set(),bins=new Map(),outputs=[];
  const io={appHome:home,clock:()=>now,machines:()=>hosts,spaces:()=>spaces,panes:()=>panes,agents:()=>[],
    terminals:()=>[...raws].filter(([,r])=>r.state==='live').map(([address])=>({address,state:'live'})),
    readTextFile:async file=>{try{return await fs.readFile(file,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}},ensureDirectory:dir=>fs.mkdir(dir,{recursive:true}),
    writeTextFile:async(file,next,expected)=>{let actual=null;try{actual=sync.readFileSync(file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}if(actual!==expected)throw Object.assign(Error('stale'),{code:'STALE'});const temp=file+'.'+Math.random().toString(36).slice(2);sync.writeFileSync(temp,next);sync.renameSync(temp,file);},
    exec:async(cmd,args,options={})=>{
      const on=options.on??null;calls.push({cmd,args:cmd==='python3'?['-c','<wrapper>',args[2]]:args,on});if(unreachable.has(on))throw Error('unreachable');
      if(cmd==='hc'&&args[0]==='get'){const raw=raws.get(q(on,args[1]));return raw?{code:0,stdout:JSON.stringify(raw),stderr:''}:{code:1,stdout:'',stderr:'missing'};}
      // Each host's wrapper only ever sees that host's fake hc; the user's real hc is never on this PATH.
      if(cmd==='python3'){const bin=bins.get(JSON.stringify(on));if(!bin)throw Error('python3 is not installed there');assert.equal(args[0],'-c');assert.equal(args[1],HISTORY_WRAPPER);const r=await child('python3',args,{env:{PATH:bin+':/usr/bin:/bin:'+path.dirname(process.execPath)+':/opt/homebrew/bin:/usr/local/bin',HOME:root}});outputs.push(r.stdout);return r;}
      throw Error('Unexpected command '+cmd);
    }};
  const open=(machine,{space='sp1',tab='tb1',terminal='t1',cwd=repo,program=SHELL,name='1',named=false,spaceName='repo'}={})=>{
    let s=spaces.find(x=>x.id===q(machine,space));if(!s){s={id:q(machine,space),name:spaceName,named:false,folder:cwd,machine,tabs:[]};spaces.push(s);}
    s.tabs.push({id:q(machine,tab),index:s.tabs.length+1,name,named,panes:1});
    panes.push({pane:'p-'+q(machine,terminal),tab:q(machine,tab),terminal:q(machine,terminal),cwd,title:program.name,program,status:program.agent?'idle':null});
    raws.set(q(machine,terminal),{address:terminal,created_ms:now-50,state:'live',cwd,argv:['/bin/zsh','-lic','"$@"; exec "$0" -li','/bin/zsh',program.key,'--token',SECRET,TASK],foreground:{pid:4000+raws.size,name:program.key,argv:[program.key,SECRET]},labels:{'herdr.space':space,'herdr.tab':tab}});
  };
  const close=(machine,tab,{keepTerminal=false}={})=>{const id=q(machine,tab);for(const s of spaces)s.tabs=s.tabs.filter(x=>x.id!==id);for(let i=spaces.length-1;i>=0;i--)if(!spaces[i].tabs.length)spaces.splice(i,1);for(let i=panes.length-1;i>=0;i--)if(panes[i].tab===id){if(!keepTerminal)raws.get(panes[i].terminal).state='finished';panes.splice(i,1);}};
  const disconnect=machine=>{hosts.find(h=>h.name===machine).layout='unavailable';hidden.set(machine,{spaces:spaces.filter(s=>s.machine===machine),panes:panes.filter(p=>p.terminal.startsWith(machine+'/'))});for(let i=spaces.length-1;i>=0;i--)if(spaces[i].machine===machine)spaces.splice(i,1);for(let i=panes.length-1;i>=0;i--)if(panes[i].terminal.startsWith(machine+'/'))panes.splice(i,1);};
  const reconnect=machine=>{const h=hidden.get(machine);hosts.find(x=>x.name===machine).layout='ready';spaces.push(...h.spaces.filter(s=>s.tabs.length));panes.push(...h.panes.filter(p=>h.spaces.some(s=>s.tabs.some(t=>t.id===p.tab))));};
  const hideClose=(machine,tab)=>{const h=hidden.get(machine);for(const s of h.spaces)s.tabs=s.tabs.filter(x=>x.id!==q(machine,tab));};
  const file=()=>fs.readFile(path.join(home,'mission-control/closed.json'),'utf8').catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  const journal=async()=>JSON.parse(await file());
  const host=async(name,data,mode)=>{const bin=path.join(root,'bin-'+(name??'local'));await fs.mkdir(bin,{recursive:true});await fs.writeFile(path.join(bin,'hc'),FAKE_HC,{mode:0o755});await fs.writeFile(path.join(bin,'data.json'),JSON.stringify({...data,mode}));bins.set(JSON.stringify(name),bin);return bin;};
  return {root,home,repo,io,hosts,spaces,panes,raws,calls,outputs,unreachable,open,close,disconnect,reconnect,hideClose,file,journal,host,now:()=>now,advance:ms=>now+=ms};
}
async function tick(f,watcher,ms=LIMITS.observeMs){f.advance(ms);const r=await watcher.tick();assert.equal(r.error,undefined,JSON.stringify(r.error));return r;}
async function bind(f,machine,terminal,tab,session){
  const identity=terminalIdentity(f.raws.get(q(machine,terminal)),machine),store=new BindingStore(f.io,{clock:f.now}),requestId='req-'+q(machine,terminal).replace('/','-');
  await store.propose({requestId,originId:'origin-'+requestId,session});
  await store.commitAcknowledged(requestId,{tabId:q(machine,tab),terminal:identity},argvSessionProof({capabilities:{machine,provider:session.provider,run:['claude'],resume:{kind:'flag',flag:'--resume'}},session,terminal:identity,argv:['claude','--resume',session.sessionId],kind:'resume-argv',observedAt:f.now(),sourceDigest:'fixture'}));
  return requestId;
}
const session=(f,id,machine=null)=>({machine,provider:'claude',credentialScope:'fixture',providerRoot:f.root+'/.claude',sessionId:id});
const assertNoArgv=text=>{for(const secret of [SECRET,TASK,'--token','"$@"; exec'])assert.ok(!text.includes(secret),'leaked '+secret);};

test('observed shell and exact-agent closes produce ordered machine-qualified records without argv',async t=>{
  const f=await fixture(t),watcher=new ClosedWatcher(f.io,{owner:'watch-A'});
  f.open(null,{tab:'tb1',terminal:'t1'});f.open(null,{tab:'tb2',terminal:'t2',program:CLAUDE,name:'My investigation',named:true});
  const exact=session(f,'019c7714-3b77-74d1-9866-e1f484aae2ab'),requestId=await bind(f,null,'t2','tb2',exact);
  await fs.writeFile(path.join(f.home,'mission-control/launches.json'),JSON.stringify({v:1,revision:1,requests:{[requestId]:{request:{requestId,machine:null,repoRoot:f.repo,checkoutRoot:f.repo,toolKey:'claude'},folder:f.repo}}}));
  const names=new NameOwnership(f.io,{owner:'seed'});await names.transferToAcknowledgedTab({originId:'origin-A',session:exact},{tabId:'tb2',name:'Claude Code'});await names.observeNames([{id:'tb2',machine:null,name:'My investigation',named:true}]);
  assert.equal((await tick(f,watcher)).owned,true);assert.deepEqual((await f.journal()).records,[]);
  assert.deepEqual(f.calls.filter(c=>c.cmd==='hc').map(c=>[c.args[1],c.on]),[['t1',null],['t2',null]]);
  f.close(null,'tb1');const first=await tick(f,watcher);assert.equal(first.recorded.length,1);
  f.close(null,'tb2');const second=await tick(f,watcher);assert.equal(second.recorded.length,1);
  const value=await f.journal(),[agent,shell]=value.records;assert.equal(value.records.length,2);
  assert.equal(shell.kind,'shell');assert.equal(shell.machine,null);assert.equal(shell.tab.id,'tb1');assert.equal(shell.space.id,'sp1');assert.equal(shell.terminals[0].startCwd,f.repo);assert.ok(Number.isSafeInteger(shell.terminals[0].createdMs));
  assert.equal(agent.kind,'agent');assert.ok(agent.seq>shell.seq);assert.deepEqual(agent.terminals[0].session,exact);assert.equal(agent.terminals[0].requestId,requestId);assert.equal(agent.terminals[0].repoRoot,f.repo);assert.equal(agent.terminals[0].toolKey,'claude');
  assert.deepEqual(agent.origin,{originId:'origin-A',mode:'manual',manualName:'My investigation'});assert.equal(agent.tab.named,true);assert.equal(agent.tab.name,'My investigation');
  assertNoArgv(await f.file());assert.doesNotThrow(()=>validateClosedJournal(value));
  // Idle polls are cheap: no hc calls once generations are known, and only a lease renewal is written.
  const hcCalls=f.calls.filter(c=>c.cmd==='hc').length,revision=(await f.journal()).revision;
  for(let i=0;i<3;i++)assert.deepEqual((await tick(f,watcher)).recorded,[]);
  assert.equal(f.calls.filter(c=>c.cmd==='hc').length,hcCalls);assert.ok((await f.journal()).revision-revision<=1);assert.equal((await f.journal()).records.length,2);
});

test('at most 100 records stay in exact close order and several closes in one poll are all kept',async t=>{
  const f=await fixture(t),watcher=new ClosedWatcher(f.io,{owner:'watch-A'});
  for(let i=0;i<105;i++){f.open(null,{tab:'tb'+i,terminal:'t'+(i+1)});await tick(f,watcher);f.close(null,'tb'+i);await tick(f,watcher);}
  let value=await f.journal();assert.equal(value.records.length,100);assert.deepEqual(value.records.map(r=>r.tab.id),Array.from({length:100},(_,i)=>'tb'+(104-i)));
  assert.ok(value.records.every((r,i,all)=>i===0||all[i-1].seq>r.seq));
  f.open(null,{tab:'x1',terminal:'t201'});f.open(null,{tab:'x2',terminal:'t202'});await tick(f,watcher);f.close(null,'x1');f.close(null,'x2');assert.equal((await tick(f,watcher)).recorded.length,2);
  value=await f.journal();assert.equal(value.records.length,100);assert.deepEqual(value.records.slice(0,2).map(r=>r.tab.id).sort(),['x1','x2']);assert.equal(value.records[2].tab.id,'tb104');
});

test('identical local and remote tb1/t1 through disconnect, reconnect and one actual close yield exactly one qualified record',async t=>{
  const f=await fixture(t),watcher=new ClosedWatcher(f.io,{owner:'watch-A'});
  for(const m of [null,'server']){f.open(m,{tab:'tb1',terminal:'t1'});}f.open('server',{tab:'tb2',terminal:'t2'});
  await tick(f,watcher);await tick(f,watcher);
  assert.deepEqual(f.calls.filter(c=>c.cmd==='hc').map(c=>[c.args[1],c.on]).sort(),[['t1',null],['t1','server'],['t2','server']]);
  f.disconnect('server');assert.deepEqual((await tick(f,watcher)).recorded,[]);
  // Closed while the host was unreachable: nobody can order it, so it is never invented later.
  f.hideClose('server','tb2');assert.deepEqual((await tick(f,watcher)).recorded,[]);
  f.reconnect('server');assert.deepEqual((await tick(f,watcher)).recorded,[]);assert.deepEqual((await tick(f,watcher)).recorded,[]);
  assert.equal((await f.journal()).records.length,0);
  f.close('server','tb1');assert.equal((await tick(f,watcher)).recorded.length,1);
  for(let i=0;i<3;i++)await tick(f,watcher);
  const {records}=await f.journal();assert.equal(records.length,1);const [r]=records;
  assert.equal(r.machine,'server');assert.equal(r.tab.id,'server/tb1');assert.equal(r.space.id,'server/sp1');assert.equal(r.terminals[0].address,'server/t1');assert.equal(r.terminals[0].createdMs,f.raws.get('server/t1').created_ms);
  assert.ok(f.spaces.some(s=>s.id==='sp1'&&s.tabs.some(x=>x.id==='tb1')),'the identical local tab is untouched');
});

test('a second watcher cannot double-record; it takes over after lease expiry and a restart never invents closes',async t=>{
  const f=await fixture(t),a=new ClosedWatcher(f.io,{owner:'watch-A'}),b=new ClosedWatcher(f.io,{owner:'watch-B'});
  for(let i=1;i<=4;i++)f.open(null,{tab:'tb'+i,terminal:'t'+i});
  f.advance(LIMITS.observeMs);const firstRound=await Promise.all([a.tick(),b.tick()]);assert.equal(firstRound.filter(r=>r.owned).length,1,JSON.stringify(firstRound));
  for(let i=0;i<2;i++){f.advance(LIMITS.observeMs);await Promise.all([a.tick(),b.tick()]);}
  const owner=(await f.journal()).lease.owner,[lead,other]=owner==='watch-A'?[a,b]:[b,a];
  f.close(null,'tb1');f.advance(LIMITS.observeMs);const round=await Promise.all([a.tick(),b.tick()]);assert.equal(round.flatMap(r=>r.recorded).length,1);
  for(let i=0;i<3;i++){f.advance(LIMITS.observeMs);await Promise.all([a.tick(),b.tick()]);}assert.equal((await f.journal()).records.length,1);
  // The lead copy stops (hidden/closed/interrupted); the other observes only once the lease expires.
  f.advance(4000);assert.equal((await other.tick()).owned,false);
  f.advance(LIMITS.leaseMs);const takeover=await other.tick();assert.equal(takeover.owned,true);assert.equal((await f.journal()).lease.owner,other.owner);
  f.close(null,'tb2');assert.equal((await tick(f,other)).recorded.length,1);assert.equal((await lead.tick()).owned,false);
  // App quit: closes during downtime cannot be ordered, so a fresh watcher rebaselines.
  f.close(null,'tb3');f.advance(120000);const fresh=new ClosedWatcher(f.io,{owner:'watch-C'});assert.deepEqual((await fresh.tick()).recorded,[]);
  f.close(null,'tb4');assert.equal((await tick(f,fresh)).recorded.length,1);
  assert.deepEqual((await f.journal()).records.map(r=>r.tab.id),['tb4','tb2','tb1']);
});

test('parked terminals and this mod’s own closes are not records; a confirmed close is recorded once',async t=>{
  const f=await fixture(t),watcher=new ClosedWatcher(f.io,{owner:'watch-A'}),journal=new ClosedJournal(f.io);
  for(let i=1;i<=4;i++)f.open(null,{tab:'tb'+i,terminal:'t'+i});await tick(f,watcher);await tick(f,watcher);
  f.close(null,'tb1',{keepTerminal:true});assert.deepEqual((await tick(f,watcher)).recorded,[]);assert.ok((await f.journal()).hosts.null.tabs.tb1.parkedSince);
  await tick(f,watcher,LIMITS.parkedMs);assert.deepEqual((await tick(f,watcher)).recorded,[]);assert.equal((await f.journal()).hosts.null.tabs.tb1,undefined);
  // Exit lags the tab: still live at the first poll, finished at the next one, so it is a real close.
  f.close(null,'tb4',{keepTerminal:true});assert.deepEqual((await tick(f,watcher)).recorded,[]);f.raws.get('t4').state='finished';assert.equal((await tick(f,watcher)).recorded.length,1);
  await journal.expectClose(null,'tb2');f.close(null,'tb2');assert.deepEqual((await tick(f,watcher)).recorded,[]);
  const capture=await journal.captureTab('tb3',snapshotWorld(f.io));assert.ok(Number.isSafeInteger(capture.tab.terms[0].createdMs));
  await assert.rejects(journal.recordConfirmedClose(capture,snapshotWorld(f.io)),e=>e.code==='NOT_CLOSED');
  f.close(null,'tb3');const confirmed=await journal.recordConfirmedClose(capture,snapshotWorld(f.io));assert.equal(confirmed.recorded,true);
  assert.deepEqual((await tick(f,watcher)).recorded,[]);assert.equal((await journal.recordConfirmedClose(capture,snapshotWorld(f.io))).duplicate,true);
  const {records}=await f.journal();assert.deepEqual(records.map(r=>[r.tab.id,r.source]),[['tb3','confirmed'],['tb4','observed']]);assertNoArgv(await f.file());
});

test('an invalid journal is reported and kept byte-for-byte; nothing overwrites it',async t=>{
  const f=await fixture(t),watcher=new ClosedWatcher(f.io,{owner:'watch-A'}),file=path.join(f.home,'mission-control/closed.json');f.open(null);
  await fs.mkdir(path.dirname(file),{recursive:true});
  for(const bytes of ['not json','{"v":2,"records":[]}',JSON.stringify({v:1,revision:0,seq:0,lease:null,hosts:{},records:[{id:'c-bad'}],suppress:[],imports:{}})]){
    await fs.writeFile(file,bytes);f.advance(LIMITS.observeMs);const r=await watcher.tick();assert.equal(r.error.code,'INVALID_CLOSED');assert.match(r.error.message,/original file was kept/);assert.equal(await f.file(),bytes);
    await assert.rejects(new ClosedJournal(f.io).claim('c-0000000000000000','op'),e=>e.code==='INVALID_CLOSED');assert.equal((await importClosedHistory(null,f.io)).code,'INVALID_CLOSED');assert.equal(await f.file(),bytes);
  }
});

test('history import runs a bounded wrapper on each host itself and keeps only safe labelled records',async t=>{
  const f=await fixture(t),argv=['/bin/zsh','-lic','"$@"; exec "$0" -li','/bin/zsh','claude','--token',SECRET,TASK];
  const full=(address,tab,finished,extra={})=>({address,created_ms:finished-1000,finished_ms:finished,state:'finished',cwd:f.repo,argv,title:'old work',labels:{'herdr.space':'sp9','herdr.tab':tab},...extra});
  const local=await f.host(null,{ls:{hidden_finished:0,terminals:[{address:'t1',state:'finished',exit_code:0},{address:'t2',state:'live'},{address:'t3',state:'finished'},{address:'t4',state:'finished',parent:'t3'},{address:'t5',state:'finished'}]},get:{t1:full('t1','tb9',5000,{argv:['/bin/zsh','-l']}),t3:full('t3','tb8',7000),t5:{address:'t5',created_ms:10,finished_ms:20,state:'finished',argv}}});
  // Herdr 0.1.11 wraps remote launches in a bare `sh -c` form; it must still unwrap to the agent.
  const remote=await f.host('server',{ls:{terminals:[{address:'t1',state:'finished'}]},get:{t1:full('t1','tb9',6000,{argv:['sh','-c','"$@"; exec "${SHELL:-sh}" -i','sh','claude','--token',SECRET,TASK]})}});
  f.open(null,{tab:'live-tab',terminal:'t7'});
  const a=await importClosedHistory(null,f.io),b=await importClosedHistory('server',f.io);
  assert.equal(a.ok,true,JSON.stringify(a));assert.equal(a.complete,true);assert.equal(a.added,2);assert.equal(b.ok,true,JSON.stringify(b));assert.equal(b.added,1);
  assert.deepEqual(f.calls.filter(c=>c.cmd==='python3').map(c=>c.on),[null,'server']);
  for(const bin of [local,remote])assert.ok((await fs.readFile(path.join(bin,'pids'),'utf8')).trim().split('\n').length>=2,'each host ran its own hc ls and hc get');
  const value=await f.journal(),byKey=Object.fromEntries(value.records.map(r=>[r.tab.id,r]));
  assert.deepEqual(Object.keys(byKey).sort(),['server/tb9','tb8','tb9']);assert.ok(value.records.every(r=>r.source==='imported'&&r.ordered));
  assert.equal(byKey['server/tb9'].machine,'server');assert.equal(byKey['server/tb9'].kind,'agent');assert.equal(byKey['server/tb9'].terminals[0].program.key,'claude');assert.equal(byKey['server/tb9'].terminals[0].address,'server/t1');assert.equal(byKey.tb9.terminals[0].address,'t1');
  assert.equal(byKey.tb8.kind,'agent');assert.equal(byKey.tb8.terminals[0].program.key,'claude');assert.equal(byKey.tb9.kind,'shell');assert.equal(byKey.tb8.terminals[0].startCwd,f.repo);
  assertNoArgv(await f.file());for(const out of f.outputs){assertNoArgv(out);assert.ok(out.length<LIMITS.historyOutput);}
  assert.equal((await importClosedHistory(null,f.io)).added,0,'re-import dedupes');
  // Herdr 0.1.13 starts a remote program through a login-shell dispatcher: the recorded argv still names the agent.
  const h=await fixture(t);await h.host('server',{ls:{terminals:[{address:'t2',state:'finished'}]},get:{t2:{address:'t2',created_ms:100,finished_ms:900,state:'finished',cwd:h.repo,argv:recorded.remote.argv,title:'old work',labels:{'herdr.space':'sp9','herdr.tab':'tb7'}}}});
  const dispatched=await importClosedHistory('server',h.io);assert.equal(dispatched.added,1,JSON.stringify(dispatched));
  const hv=await h.journal();assert.equal(hv.records[0].terminals[0].program.key,'qa-claude','the dispatcher is stripped to the agent program');assertNoArgv(await h.file());
  // A bounded batch is partial: labelled unordered, resumable from its cursor, never globally newest.
  const g=await fixture(t);await g.host(null,{ls:{terminals:[1,2,3].map(n=>({address:'t'+n,state:'finished'}))},get:Object.fromEntries([1,2,3].map(n=>['t'+n,{address:'t'+n,created_ms:n,finished_ms:n*100,state:'finished',cwd:g.repo,argv,labels:{'herdr.space':'s','herdr.tab':'tab'+n}}]))});
  const partial=await importClosedHistory(null,g.io,{batch:1});assert.equal(partial.complete,false);assert.equal(partial.added,1);
  let state=await g.journal();assert.equal(state.imports.null.state,'partial');assert.equal(state.imports.null.cursor,'t3');assert.equal(state.records[0].ordered,false);assert.equal(state.records[0].tab.id,'tab3');
  assert.equal((await importClosedHistory(null,g.io,{batch:1})).added,1);state=await g.journal();assert.deepEqual(state.records.map(r=>r.tab.id).sort(),['tab2','tab3']);
});

test('huge, hung, malformed or unreachable history reports older-history-unavailable and keeps the journal',async t=>{
  const f=await fixture(t),watcher=new ClosedWatcher(f.io,{owner:'watch-A'});f.open(null);await tick(f,watcher);f.close(null,'tb1');await tick(f,watcher);
  const records=JSON.stringify((await f.journal()).records);assert.equal(JSON.parse(records).length,1);
  const bin=await f.host(null,{ls:{terminals:[]},get:{}},'flood'),started=Date.now(),flood=await importClosedHistory(null,f.io);
  assert.equal(flood.code,'OLDER_HISTORY_UNAVAILABLE');assert.match(flood.message,/4 MiB/);assert.ok(Date.now()-started<4000);
  await f.host(null,{ls:{terminals:[]},get:{}},'hang');await fs.writeFile(path.join(bin,'pids'),'');
  const hung=await importClosedHistory(null,f.io,{timeoutMs:300});assert.equal(hung.code,'OLDER_HISTORY_UNAVAILABLE');assert.match(hung.message,/5 seconds/);
  await new Promise(r=>setTimeout(r,100));for(const pid of (await fs.readFile(path.join(bin,'pids'),'utf8')).trim().split('\n').map(Number))assert.throws(()=>process.kill(pid,0),e=>e.code==='ESRCH','its own hc client was killed');
  await f.host(null,{ls:{terminals:[]},get:{}},'malformed');assert.equal((await importClosedHistory(null,f.io)).code,'OLDER_HISTORY_UNAVAILABLE');
  assert.equal((await importClosedHistory('server',f.io)).code,'OLDER_HISTORY_UNAVAILABLE','no wrapper there; never run locally instead');
  f.unreachable.add('server');assert.equal((await importClosedHistory('server',f.io)).code,'OLDER_HISTORY_UNAVAILABLE');
  f.hosts[1].layout='unavailable';const before=f.calls.length;assert.match((await importClosedHistory('server',f.io)).message,/offline/);assert.equal(f.calls.length,before);
  const after=await f.journal();assert.equal(JSON.stringify(after.records),records);assert.equal(after.imports.null.state,'unavailable');assert.equal(after.imports['"server"'].state,'unavailable');assert.deepEqual(f.calls.filter(c=>c.cmd==='python3').map(c=>c.on),[null,null,null,'server','server'],'server imports never ran locally');
});
