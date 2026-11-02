import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import sync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {TabNameService,TabNameStore,SERVICE_LIMITS,launchMetadata,leaseHeld} from '../src/shared/tab-service.js';
import {NAME_TIMING,tabKey} from '../src/shared/tab-names.js';
import {NameOwnership} from '../src/shared/name-ownership.js';
import {ReopenController} from '../src/shared/reopen.js';

const SHELL={key:'shell',name:'zsh',agent:false,shell:true},NVIM={key:'nvim',name:'Neovim',agent:false,shell:false};
const CODEX={key:'codex',name:'Codex',agent:true,shell:false},CLAUDE={key:'claude',name:'Claude Code',agent:true,shell:false};
const session=id=>({machine:null,provider:'codex',credentialScope:'work',providerRoot:'/profiles/work/.codex',sessionId:id});
async function fixture(t){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'mc-tab-service-'))),home=path.join(root,'app');
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  let now=1_000_000,terms=0;const hosts=[{name:null,layout:'ready'},{name:'server',layout:'ready'}],spaces=[],panes=[],commands=[],writes={},hooks={},lag={on:false,queue:[]};
  const q=(machine,id)=>machine?machine+'/'+id:id;
  const findTab=id=>{for(const s of spaces)for(const x of s.tabs)if(x.id===id)return x;return null;};
  const file=name=>path.join(home,'mission-control',name);
  const io={appHome:home,home:()=>'/Users/me',clock:()=>now,machines:()=>hosts,spaces:()=>spaces,panes:()=>panes,agents:()=>[],terminals:()=>[],
    readTextFile:async p=>{try{return await fs.readFile(p,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}},ensureDirectory:p=>fs.mkdir(p,{recursive:true}),
    writeTextFile:async(p,next,expected)=>{
      const base=path.basename(p);if(hooks.fail?.(base))throw Object.assign(Error('disk full'),{code:'EIO'});if(hooks.before)await hooks.before(base);
      let actual=null;try{actual=sync.readFileSync(p,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
      if(actual!==expected)throw Object.assign(Error('stale'),{code:'STALE'});sync.writeFileSync(p,next);writes[base]=(writes[base]||0)+1;
    },
    run:(name,args)=>{
      commands.push({name,args:{...args},at:now});
      if(name==='tab.rename'){const apply=()=>{const x=findTab(args.id);if(!x)return;if(args.name===''){x.name=String(x.index);x.named=false;}else{x.name=args.name;x.named=true;}};if(lag.on)lag.queue.push(apply);else apply();}
      if(name==='tab.close')close(args.id);
      return null;
    },
    exec:async(cmd,args)=>{if(cmd==='hc'&&args[0]==='get')return {code:1,stdout:'',stderr:'missing'};throw Error('Unexpected command '+cmd);}};
  const tab=(id,{machine=null,name,named=false,program=SHELL,title='',cwd='/work/app'}={})=>{
    const tid=q(machine,id);let s=spaces.find(x=>(x.machine??null)===machine);if(!s){s={id:q(machine,'sp1'),name:'app',named:false,folder:cwd,machine,tabs:[]};spaces.push(s);}
    const index=s.tabs.length+1,terminal=q(machine,'t'+(++terms).toString(36));s.tabs.push({id:tid,index,name:name??String(index),named:name!==undefined||named,active:false,status:null,panes:1,settled:false});
    panes.push({pane:'p'+terms,tab:tid,terminal,program,title,cwd,status:program.agent?'idle':null,app:null,focused:false});return tid;
  };
  const close=id=>{for(const s of spaces)s.tabs=s.tabs.filter(x=>x.id!==id);for(let i=panes.length-1;i>=0;i--)if(panes[i].tab===id)panes.splice(i,1);};
  const set=(id,patch)=>Object.assign(panes.find(p=>p.tab===id),patch);
  const named=id=>{const x=findTab(id);return x&&{name:x.name,named:x.named};};
  const renames=id=>commands.filter(c=>c.name==='tab.rename'&&(id===undefined||c.args.id===id));
  const json=async name=>JSON.parse(await fs.readFile(file(name),'utf8'));
  return {io,hosts,spaces,commands,writes,hooks,lag,tab,close,set,named,renames,json,file,findTab,advance:(ms=SERVICE_LIMITS.pollMs)=>{now+=ms;return now;},get now(){return now;}};
}
const rounds=async(f,services,n,ms=SERVICE_LIMITS.pollMs)=>{const out=[];for(let i=0;i<n;i++){out.push(await Promise.all(services.map(s=>s.tick())));f.advance(ms);}return out;};
const names=f=>new NameOwnership(f.io,{owner:'launcher',clock:()=>f.now});

test('two visible tab bars issue one rename per actual change, and manual names persist across a layout switch',async t=>{
  const f=await fixture(t),tb1=f.tab('tb1'),tb2=f.tab('tb2',{program:CLAUDE,title:'⠐ Fix login redirect'});
  const store=names(f);await store.transferToAcknowledgedTab({originId:'O',session:session('s-O')},{tabId:'tbO',name:'Codex'});
  const tbO=f.tab('tbO',{name:'Codex',program:CODEX});await store.observeNames([{id:tbO,machine:null,name:'Kept by me',named:true}]);
  f.findTab(tbO).name='Kept by me';await store.observeNames([{id:tbO,machine:null,name:'Kept by me',named:true}]);
  const a=new TabNameService(f.io,{owner:'bar-a'}),b=new TabNameService(f.io,{owner:'bar-b'});
  await rounds(f,[a,b],4);
  assert.deepEqual(f.renames().map(c=>[c.args.id,c.args.name]),[[tb1,'app'],[tb2,'Fix login redirect']]);
  assert.equal([a.owned,b.owned].filter(Boolean).length,1);
  f.set(tb1,{program:NVIM});await rounds(f,[a,b],3);
  f.set(tb1,{program:SHELL});await rounds(f,[a,b],3);
  assert.deepEqual(f.renames(tb1).map(c=>c.args.name),['app','Neovim','app']);
  // The user renames tb2; the next title change from the agent never overrides it.
  f.findTab(tb2).name='Release prep';await rounds(f,[a,b],2);f.set(tb2,{title:'⠂ Something else'});await rounds(f,[a,b],3);
  // Layout switch: both copies close; the new layout's copies start fresh from disk.
  await Promise.all([a.stop(),b.stop()]);assert.equal((await f.json('tab-names.json')).lease,null);
  const c=new TabNameService(f.io,{owner:'bar-c'}),d=new TabNameService(f.io,{owner:'bar-d'});const before=f.renames().length;
  await rounds(f,[c,d],5);
  assert.equal(f.renames().length,before);assert.deepEqual(f.named(tb2),{name:'Release prep',named:true});assert.deepEqual(f.named(tbO),{name:'Kept by me',named:true});
  assert.deepEqual((await f.json('tab-names.json')).tabs[tabKey(null,tb2)].manual,{name:'Release prep',source:'observed'});
  assert.equal((await store.find({originId:'O'})).manualName,'Kept by me');
});

test('ticks never start passes faster than every 3 seconds and the floor cannot be configured away',async t=>{
  const f=await fixture(t);f.tab('tb1');
  assert.throws(()=>new TabNameService(f.io,{pollMs:1000}),{code:'INVALID_SERVICE'});assert.throws(()=>new TabNameService(f.io,{leaseMs:4000}),{code:'INVALID_SERVICE'});
  assert.throws(()=>new TabNameService({...f.io,run:undefined}),{code:'INVALID_SERVICE'});
  const s=new TabNameService(f.io,{owner:'solo'}),ran=[];
  for(const step of [0,1000,1000,999,1,2999,1])ran.push((f.advance(step),await s.tick()).ran);
  assert.deepEqual(ran,[true,false,false,false,true,false,true]);
});

test('a pending command and a stale host snapshot never revert user names, misread our own write or loop',async t=>{
  const f=await fixture(t),tb1=f.tab('tb1'),store=names(f);
  await store.transferToAcknowledgedTab({originId:'O'},{tabId:'tbO',name:'Codex'});const tbO=f.tab('tbO',{name:'Codex',program:CODEX,title:'⠐ Plan the release'});
  const s=new TabNameService(f.io,{owner:'bar'});f.lag.on=true;
  await rounds(f,[s],2);assert.deepEqual(f.renames().map(c=>c.args.name),['app','Plan the release']);
  // The host has not applied either rename yet: polls inside the pending window conclude nothing.
  await rounds(f,[s],2);assert.equal(f.renames().length,2);
  const origin=await store.find({originId:'O'});assert.deepEqual([origin.mode,origin.lastAutoName],['auto','Plan the release']);
  // Our rename lands, then the user renames tb1 straight after: their name is kept.
  f.lag.queue.splice(0).forEach(apply=>apply());f.lag.on=false;f.findTab(tb1).name='Mine';
  f.set(tb1,{program:NVIM});await rounds(f,[s],6);
  assert.deepEqual(f.named(tb1),{name:'Mine',named:true});assert.equal(f.renames(tb1).length,1);
  assert.equal((await store.find({originId:'O'})).mode,'auto');assert.deepEqual(f.named(tbO),{name:'Plan the release',named:true});
  // A command the host drops for good is retried a bounded number of times, then left alone.
  const tb2=f.tab('tb2',{cwd:'/work/other'});f.lag.on=true;
  await rounds(f,[s],60);f.lag.queue.length=0;
  assert.equal(f.renames(tb2).length,NAME_TIMING.tries);assert.equal((await f.json('tab-names.json')).tabs[tabKey(null,tb2)].stuck,'other');
});

test('an expired lease is taken over within bounds, a bogus lease cannot block naming and racing takers yield one owner',async t=>{
  const f=await fixture(t);f.tab('tb1');
  const a=new TabNameService(f.io,{owner:'bar-a'}),b=new TabNameService(f.io,{owner:'bar-b'});
  await a.tick();assert.equal(a.owned,true);f.advance(100);await b.tick();assert.equal(b.owned,false);
  // a's view was cancelled mid-flight: it never releases. b waits out the lease, then takes over.
  const expiresAt=(await f.json('tab-names.json')).lease.expiresAt;
  while(f.now<expiresAt-SERVICE_LIMITS.pollMs){f.advance();await b.tick();assert.equal(b.owned,false);}
  f.advance(SERVICE_LIMITS.pollMs);await b.tick();assert.equal(b.owned,true);
  assert.ok(f.now-expiresAt<=SERVICE_LIMITS.pollMs);
  // A lease written with a far-future expiry (clock skew, corruption) is bounded by maxLeaseMs.
  const state=await f.json('tab-names.json');state.lease={owner:'ghost',expiresAt:f.now+10*86400000};await fs.writeFile(f.file('tab-names.json'),JSON.stringify(state));
  assert.equal(leaseHeld(state.lease,'bar-c',f.now),false);
  const c=new TabNameService(f.io,{owner:'bar-c'});f.advance();await c.tick();assert.equal(c.owned,true);
  // Fresh home, two copies racing for the free lease in the same instant: CAS leaves exactly one.
  const g=await fixture(t),tb=g.tab('tb1'),x=new TabNameService(g.io,{owner:'x'}),y=new TabNameService(g.io,{owner:'y'});
  await rounds(g,[x,y],4);assert.equal([x.owned,y.owned].filter(Boolean).length,1);assert.deepEqual(g.renames(tb).map(c=>c.args.name),['app']);
});

test('persistence conflicts, write failures and invalid files never emit a rename or rewrite saved state',async t=>{
  const f=await fixture(t),tb1=f.tab('tb1'),s=new TabNameService(f.io,{owner:'bar'});
  await s.tick();f.advance();
  // Another copy takes the lease between our read and our write: our CAS loses and nothing is emitted.
  f.hooks.before=async base=>{if(base!=='tab-names.json')return;f.hooks.before=null;const other=new TabNameStore(f.io);await other.edit(d=>{d.lease={owner:'other',expiresAt:f.now+SERVICE_LIMITS.leaseMs};});};
  const lost=await s.tick();assert.equal(lost.owned,false);assert.equal(f.renames().length,0);
  // A failing disk: an error to show, no command.
  f.advance(SERVICE_LIMITS.leaseMs+1);f.hooks.fail=base=>base==='tab-names.json';
  for(let i=0;i<3;i++){const r=await s.tick();assert.equal(r.error.code,'EIO');f.advance();}
  assert.equal(f.renames().length,0);f.hooks.fail=null;
  // Invalid saved state is reported and kept byte for byte.
  await fs.writeFile(f.file('tab-names.json'),'{"v":1,"broken":');
  const bad=await s.tick();assert.equal(bad.error.code,'INVALID_TAB_NAMES');assert.equal(await fs.readFile(f.file('tab-names.json'),'utf8'),'{"v":1,"broken":');
  await fs.rm(f.file('tab-names.json'));await fs.writeFile(f.file('names.json'),'not json');f.advance();
  const unknown=await s.tick();assert.equal(unknown.error.code,'INVALID_NAMES');assert.equal(f.renames().length,0);assert.equal(await fs.readFile(f.file('names.json'),'utf8'),'not json');
  await fs.rm(f.file('names.json'));f.advance();await rounds(f,[s],2);assert.deepEqual(f.renames(tb1).map(c=>c.args.name),['app']);
});

test('idle polling issues no commands, never rewrites names.json and only renews the lease',async t=>{
  const f=await fixture(t);f.tab('tb1');f.tab('tb2',{program:CODEX});const store=names(f);
  await store.transferToAcknowledgedTab({originId:'O'},{tabId:'tbO',name:'Codex'});f.tab('tbO',{name:'Codex',program:CODEX});
  const s=new TabNameService(f.io,{owner:'bar'});await rounds(f,[s],4);
  const commands=f.commands.length,namesWrites=f.writes['names.json'],stateWrites=f.writes['tab-names.json'];
  await rounds(f,[s],20);
  assert.equal(f.commands.length,commands);assert.equal(f.writes['names.json'],namesWrites);
  const renewals=f.writes['tab-names.json']-stateWrites;assert.ok(renewals>0&&renewals<=Math.ceil(20*SERVICE_LIMITS.pollMs/(SERVICE_LIMITS.leaseMs/2))+1,String(renewals));
  // A second copy only reads while the first holds the lease.
  const other=new TabNameService(f.io,{owner:'other'}),seen=f.writes['tab-names.json'];await rounds(f,[s,other],3);
  assert.ok(f.writes['tab-names.json']-seen<=2);assert.equal(other.owned,false);
});

test('stale or unavailable hosts are never renamed and keep their entries; the same IDs on two hosts stay apart',async t=>{
  const f=await fixture(t),local=f.tab('tb1'),remote=f.tab('tb1',{machine:'server',cwd:'/srv/api'});
  const s=new TabNameService(f.io,{owner:'bar'});await rounds(f,[s],2);
  assert.deepEqual(f.renames().map(c=>[c.args.id,c.args.name]),[[local,'app'],[remote,'api']]);
  // The server's layout becomes unavailable while its last snapshot lingers in spaces().
  f.hosts[1].layout='unavailable';f.set(remote,{program:NVIM});await rounds(f,[s],5);
  assert.equal(f.renames(remote).length,1);
  f.advance(NAME_TIMING.missingMs*3);await s.tick();assert.ok((await f.json('tab-names.json')).tabs[tabKey('server',remote)]);
  f.hosts[1].layout='ready';f.advance();await rounds(f,[s],2);assert.deepEqual(f.renames(remote).map(c=>c.args.name),['api','Neovim']);
  assert.deepEqual(f.named(local),{name:'app',named:true});
  // A closed tab's entry goes once its ready host has not shown it for missingMs.
  f.close(local);await rounds(f,[s],2);f.advance(NAME_TIMING.missingMs);await s.tick();
  assert.equal((await f.json('tab-names.json')).tabs[tabKey(null,local)],undefined);
});

test('launch, resume and reopen metadata are captured and late acknowledgments reconcile on a later snapshot',async t=>{
  const f=await fixture(t),store=names(f);
  const journal=requests=>fs.mkdir(path.dirname(f.file('launches.json')),{recursive:true}).then(()=>fs.writeFile(f.file('launches.json'),JSON.stringify({v:1,revision:1,requests})));
  const request=(id,tab,source,extra={})=>({request:{requestId:id,idempotencyKey:id,originId:'origin-'+id,spaceId:'sp1',machine:null,repoRoot:'/work/app',checkoutRoot:'/work/app',toolKey:'codex',worktree:false,...(source?{source:{connectionId:'c',site:'https://gitlab.example',id:'1',url:'https://gitlab.example/x',...source}}:{})},ack:{space:'sp1',tab,terminal:'t9'},initialName:source?`${source.key} ${source.title}`:'Codex',state:'complete',...extra});
  await journal({r1:request('r1','tbL',{kind:'gitlab',key:'GL-142',title:'Fix login'})});
  const tbL=f.tab('tbL',{name:'GL-142 Fix login',program:CODEX,title:'codex'});
  // Named before its acknowledgment was journaled: adopted, then proven ours by the later ack.
  const tbM=f.tab('tbM',{name:'GL-MR-7 Review cache',program:CODEX});
  const s=new TabNameService(f.io,{owner:'bar'});await rounds(f,[s],3);assert.equal(f.renames().length,0);
  assert.equal((await f.json('tab-names.json')).tabs[tabKey(null,tbM)].mode,'manual');
  await journal({r1:request('r1','tbL',{kind:'gitlab',key:'GL-142',title:'Fix login'}),r2:request('r2','tbM',{kind:'gitlab-mr',key:'GL-MR-7',title:'Review cache'})});
  await rounds(f,[s],2);assert.equal((await f.json('tab-names.json')).tabs[tabKey(null,tbM)].mode,'auto');
  // The agent exits in both: the issue/MR identity stays, so nothing is renamed to the folder.
  f.set(tbL,{program:SHELL,status:null});f.set(tbM,{program:SHELL,status:null});await rounds(f,[s],3);assert.equal(f.renames().length,0);
  // A conversation title arriving later keeps the key in front.
  f.set(tbL,{program:CLAUDE,title:'⠐ Tidy redirects'});await rounds(f,[s],2);assert.deepEqual(f.renames(tbL).map(c=>c.args.name),['GL-142 Tidy redirects']);
  // The bar's own acknowledged PR action, before any journal entry exists.
  const tbP=f.tab('tbP',{program:CODEX});s.acknowledge({tabId:tbP,key:'GH-PR-42',title:'Review auth',kind:'github-pr',toolKey:'codex'});
  await rounds(f,[s],2);assert.deepEqual(f.renames(tbP).map(c=>c.args.name),['GH-PR-42 Review auth']);
  // Resume as resume() does it: placeholder, then the reported history title; it survives the agent exiting.
  await store.transferToAcknowledgedTab({originId:'session-r',session:session('s-r')},{tabId:'tbR',name:'Codex'});const tbR=f.tab('tbR',{name:'Codex',program:CODEX});
  await store.applyName('session-r','Investigate flaky test',{getTabs:()=>[{id:tbR,machine:null,...f.named(tbR)}],rename:a=>f.io.run('tab.rename',a)});
  await rounds(f,[s],2);f.set(tbR,{program:SHELL,status:null});await rounds(f,[s],3);
  assert.deepEqual(f.named(tbR),{name:'Investigate flaky test',named:true});assert.equal((await store.find({originId:'session-r'})).manualName,null);
  assert.equal(launchMetadata('{"v":1,"requests":{"x":{"request":null}}}').meta.size,0);assert.equal(launchMetadata('nope').meta.size,0);
});

test('a tab an unfinished launch is still linking is not renamed as a plain tab before its origin exists',async t=>{
  const f=await fixture(t),store=names(f),s=new TabNameService(f.io,{owner:'bar'});
  const journal=requests=>fs.mkdir(path.dirname(f.file('launches.json')),{recursive:true}).then(()=>fs.writeFile(f.file('launches.json'),JSON.stringify({v:1,revision:1,requests})));
  const request=(id,state,ack)=>({request:{requestId:id,idempotencyKey:id,originId:'origin-'+id,spaceId:'sp1',machine:null,repoRoot:'/work/app',checkoutRoot:'/work/app',toolKey:'claude',worktree:false},...(ack?{ack:{space:'sp1',tab:ack,terminal:'t9'}}:{}),initialName:'Claude Code',state});
  // Visible and titled while launch() is still committing its binding: acknowledged, not yet linked.
  await journal({r1:request('r1','binding-commit-pending','tbN')});const tbN=f.tab('tbN',{name:'Claude Code',program:CLAUDE,title:'⠐ Draft release notes'});
  await rounds(f,[s],4);assert.equal(f.renames().length,0);assert.equal(s.derived.get(tabKey(null,tbN)).reason,'linking');
  await store.transferToAcknowledgedTab({originId:'origin-r1'},{tabId:tbN,name:'Claude Code'});await journal({r1:request('r1','complete','tbN')});
  await rounds(f,[s],3);assert.deepEqual(f.renames(tbN).map(c=>c.args.name),['Draft release notes']);
  const record=await store.find({originId:'origin-r1'});assert.deepEqual([record.mode,record.lastAutoName],['auto','Draft release notes']);
  // Before its ack is journaled the placeholder name links it; an abandoned launch only holds it for the link window.
  await journal({r2:request('r2','creating',null)});const tbQ=f.tab('tbQ',{name:'Claude Code',program:CLAUDE,title:'⠐ Port the cache'});
  await rounds(f,[s],5);assert.equal(f.renames(tbQ).length,0);assert.equal(s.derived.get(tabKey(null,tbQ)).reason,'linking');
  f.advance(SERVICE_LIMITS.linkWindowMs);await rounds(f,[s],2);assert.deepEqual(f.renames(tbQ).map(c=>c.args.name),['Port the cache']);
});

test('labels fit 280px with full hover text, and the explicit route back to automatic naming works for plain and origin tabs',async t=>{
  const f=await fixture(t),long='Investigate '+'very '.repeat(30)+'slow builds',tb1=f.tab('tb1',{program:CLAUDE,title:long}),store=names(f);
  await store.transferToAcknowledgedTab({originId:'O'},{tabId:'tbO',name:'Codex'});const tbO=f.tab('tbO',{name:'Codex',program:CODEX});
  await store.observeNames([{id:tbO,machine:null,name:'Pinned',named:true}]);f.findTab(tbO).name='Pinned';
  const plain=f.tab('tbX',{name:'My notes'}),s=new TabNameService(f.io,{owner:'bar'});await rounds(f,[s],2);
  const label=s.label(f.findTab(tb1));assert.equal(label.truncated,true);assert.ok(label.full.startsWith('Investigate very'));assert.equal(label.basis,'reported');assert.equal(label.tool.name,'Claude Code');
  assert.deepEqual([s.label(f.findTab(plain)).mode,s.label(f.findTab(plain)).text],['manual','My notes']);
  assert.equal(s.requestAutomatic('missing'),false);
  assert.equal(s.requestAutomatic(plain),true);assert.equal(s.requestAutomatic({machine:null,tabId:tbO}),true);
  await rounds(f,[s],3);
  assert.deepEqual(f.named(plain),{name:'app',named:true});assert.deepEqual(f.named(tbO),{name:'Codex',named:true});
  const record=await store.find({originId:'O'});assert.deepEqual([record.mode,record.manualName,record.lastAutoName],['auto',null,'Codex']);
});

test('a cancelled or interrupted pass expires safely and a stopped service emits nothing and keeps no lease',async t=>{
  const f=await fixture(t),tb1=f.tab('tb1'),s=new TabNameService(f.io,{owner:'bar'});
  // Wired as a View wires it: each timer callback gets its own cx and the service never keeps one.
  const notified=[],timer={cancelled:false,fire(){if(this.cancelled)return;const cx={notify:()=>notified.push(cx)};return s.tick().then(r=>{if(r.changed)cx.notify();});}};
  await timer.fire();assert.equal(notified.length,1);assert.ok(!Object.values(s).includes(notified[0]));f.advance();
  // The host cancels the task mid-write: its promise never settles and no finally runs.
  f.hooks.before=base=>base==='tab-names.json'?new Promise(()=>{}):undefined;
  s.tick();await new Promise(r=>setTimeout(r,20));f.hooks.before=null;
  for(let i=0;i<4;i++){f.advance();assert.equal((await s.tick()).ran,false);}
  f.advance(SERVICE_LIMITS.staleMs);await s.tick();f.advance();await s.tick();assert.deepEqual(f.renames(tb1).map(c=>c.args.name),['app']);
  // Stop while a pass waits on its write: when the write resumes, nothing is emitted and the lease is not retaken.
  f.set(tb1,{program:NVIM});f.advance();await s.tick();f.advance();
  let open;f.hooks.before=base=>base==='tab-names.json'?new Promise(r=>{open=r;f.hooks.before=null;}):undefined;
  const inflight=s.tick();await new Promise(r=>setTimeout(r,20));timer.cancelled=true;await s.stop();open();await inflight;
  assert.equal(f.renames(tb1).length,1);assert.equal((await s.tick()).closed,true);assert.equal(timer.fire(),undefined);
  assert.equal((await f.json('tab-names.json')).lease,null);
  const next=new TabNameService(f.io,{owner:'next'});await rounds(f,[next],3);assert.deepEqual(f.renames(tb1).map(c=>c.args.name),['app','Neovim']);
});

test('close history is driven on the same timer and every close is recorded once across copies',async t=>{
  const f=await fixture(t),tb1=f.tab('tb1'),tb2=f.tab('tb2',{cwd:'/work/other'});
  const a=new TabNameService(f.io,{owner:'bar-a',closed:new ReopenController(f.io,{owner:'reopen-a'})}),b=new TabNameService(f.io,{owner:'bar-b',closed:new ReopenController(f.io,{owner:'reopen-b'})});
  const ticks=await rounds(f,[a,b],3);assert.ok(ticks.every(pair=>pair.filter(r=>r.history?.owned).length<=1));
  f.close(tb1);await rounds(f,[a,b],2);
  const closed=await a.closeTab(tb2);assert.deepEqual({...closed},{ok:true,captured:true});assert.deepEqual(f.commands.at(-1),{name:'tab.close',args:{id:tb2},at:f.now});
  await rounds(f,[a,b],3);
  const records=(await f.json('closed.json')).records;assert.deepEqual(records.map(r=>r.tab.id).sort(),[tb1,tb2]);
  assert.deepEqual((await a.closeTab('gone')).code,'TAB_UNAVAILABLE');
  // A failing history watcher never stops naming.
  const g=await fixture(t),tb=g.tab('tb1'),broken=new TabNameService(g.io,{owner:'bar',closed:{tick:async()=>{throw Error('boom');}}});
  const r=await rounds(g,[broken],2);assert.equal(r[0][0].history.error.code,'OBSERVE_FAILED');assert.deepEqual(g.renames(tb).map(c=>c.args.name),['app']);
  assert.throws(()=>new TabNameService(g.io,{closed:{}}),{code:'INVALID_SERVICE'});
});
