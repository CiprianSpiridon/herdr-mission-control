import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import sync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {NAME_LIMITS,NAME_TIMING,observeTab,deriveName,reconcileTab,displayLabel,estimateWidth,issueKey,composeName,reportedTitle,folderName,cleanText,sweep,emptyTabNames,validateTabNames,tabKey,mergeMeta} from '../src/shared/tab-names.js';
import {NameOwnership} from '../src/shared/name-ownership.js';

const HOME='/Users/me';
const pane=(tab,{key='shell',name='zsh',agent=false,title='',cwd='/work/app',status=null,app=null,terminal='t1'}={})=>({pane:'p-'+terminal,tab,terminal,program:{key,name,agent,shell:key==='shell'},title,cwd,status,app});
const claude=(tab,title,extra={})=>pane(tab,{key:'claude',name:'Claude Code',agent:true,status:'working',app:'claude-code',title,...extra});
const codex=(tab,title='codex',extra={})=>pane(tab,{key:'codex',name:'Codex',agent:true,status:'idle',title,...extra});
const name=(panes,meta=null,tab={id:'tb1',name:'1',named:false},machine=null)=>deriveName(observeTab(tab,panes,{machine}),meta,{home:HOME});
/** Drives one tab through reconcile passes the way the service does: entry in, entry out. */
function driver({machine=null,id='tb1',start=1000}={}){
  let entry=null,now=start;const actions=[];const live={name:'1',named:false,panes:[pane(id)]};
  const step=(opts={})=>{const obs=observeTab({id,name:live.name,named:live.named},live.panes,{machine});const r=reconcileTab(entry,obs,{now,home:HOME,...opts});entry=r.entry;if(r.action)actions.push(r.action);return r;};
  const land=action=>{live.name=action.name;live.named=true;};
  return {live,actions,step,land,get entry(){return entry;},set entry(v){entry=v;},tick:(ms=3000)=>{now+=ms;return now;},get now(){return now;}};
}

test('every launch origin keeps its task identity and tool; shells fall back to program, then folder',()=>{
  const t='tb1';
  assert.deepEqual({...name([claude(t,'⠐ Fix login redirect')])},{name:'Fix login redirect',full:'Fix login redirect',basis:'reported',key:null,tool:{key:'claude',name:'Claude Code'}});
  assert.equal(name([claude(t,'✳ Fix login redirect',{status:'idle'})]).name,'Fix login redirect');
  // Unsupported or silent tools: their own display name, never an invented title.
  for(const title of ['codex','Codex','','~/work/app','/work/app','me@host:~/app','12','app','t1'])assert.deepEqual([name([codex(t,title)]).name,name([codex(t,title)]).basis],['Codex','tool'],title);
  // Herdr 0.1.11 titles a pane with its own terminal ID (local part on a remote host) until the program reports a title.
  assert.equal(name([pane(t,{key:'codex',name:'Codex',agent:true,status:'idle',title:'t5x',terminal:'server/t5x'})]).name,'Codex');
  assert.equal(name([pane(t,{key:'agent',name:'my-bot',agent:true,status:'idle'})]).name,'my-bot');
  assert.equal(name([pane(t,{key:'agent',name:null,agent:true,status:'idle',app:null})]).name,'Agent');
  // Issue, PR and MR launches keep their identity alongside the task title, never duplicated.
  const cases=[['jira','ABC-123'],['github','GH-42'],['github-pr','GH-PR-42'],['gitlab','GL-142'],['gitlab-mr','GL-MR-42']];
  for(const [kind,key]of cases){
    const meta={key,title:'Fix login',kind,toolKey:'codex'};
    assert.deepEqual([name([codex(t)],meta).name,name([codex(t)],meta).basis],[key+' Fix login','task'],key);
    assert.equal(name([claude(t,'⠐ Tidy the session store')],meta).name,key+' Tidy the session store');
    assert.equal(name([claude(t,`${key}: Tidy the store`)],meta).name,key+' Tidy the store');
    assert.equal(name([claude(t,`[${key}] Tidy`)],meta).name,key+' Tidy');
    // The agent exited: the tab still belongs to that issue.
    assert.equal(name([pane(t,{cwd:'/work/app'})],meta).name,key+' Fix login');
  }
  assert.equal(name([codex(t)],{key:'GL-142',toolKey:'codex'}).name,'GL-142 Codex');
  // Resume/reopen: a captured reported title survives a tool that reports none.
  assert.deepEqual([name([codex(t)],{title:'Investigate flaky test',toolKey:'codex'}).name,name([codex(t)],{title:'Investigate flaky test'}).basis],['Investigate flaky test','task']);
  // Shells: running program, then folder when idle at the prompt; home is "~".
  assert.deepEqual([name([pane(t,{key:'nvim',name:'Neovim',title:'nvim notes.md'})]).name,name([pane(t,{key:'nvim',name:'Neovim'})]).basis],['Neovim','program']);
  assert.equal(name([pane(t,{key:'program',name:'make'})]).name,'make');
  assert.deepEqual([name([pane(t)]).name,name([pane(t)]).basis],['app','folder']);
  assert.equal(name([pane(t,{cwd:HOME})]).name,'~');assert.equal(name([pane(t,{cwd:'/'})]).name,'/');
  assert.equal(name([pane(t,{cwd:null})]).name,'zsh');
  // The agent pane wins over a shell split beside it; mod-only tabs are not renamed.
  assert.equal(name([pane(t,{terminal:'t1'}),claude(t,'Write tests',{terminal:'t2'})]).name,'Write tests');
  assert.equal(name([{pane:'p1',tab:t,terminal:null,mod:'files',title:'files'}]),null);
  assert.equal(observeTab({id:t,name:'1',named:false},[]).eligible,false);
});

test('names are bounded, safe text and keep issue/PR keys inside the 280px label',()=>{
  const long='Investigate '+'very '.repeat(60)+'slow builds';
  const d=name([claude('tb1',long)],{key:'GL-MR-42'});
  assert.ok(Array.from(d.name).length<=NAME_LIMITS.chars);assert.ok(d.name.startsWith('GL-MR-42 Investigate'));assert.ok(d.name.endsWith('…'));
  assert.ok(Array.from(d.full).length<=NAME_LIMITS.titleChars);
  const label=displayLabel(d.name,{full:d.full});
  assert.ok(estimateWidth(label.text)<=NAME_LIMITS.displayPx);assert.ok(label.text.startsWith('GL-MR-42 '));assert.equal(label.truncated,true);assert.equal(label.full,d.full);
  assert.deepEqual({...displayLabel('app')},{text:'app',full:'app',truncated:false});
  assert.ok(estimateWidth(displayLabel('漢'.repeat(40)).text)<=280);
  // Control, bidi and zero-width characters never reach a tab name.
  assert.equal(cleanText('Fix\u202e\u0007 evil\n\tname\u200b'),'Fix evil name');
  assert.equal(name([claude('tb1','\u202eFix\u0000 it')]).name,'Fix it');
  // A shell's command-line title (possibly with secrets) is not a conversation title.
  assert.equal(name([codex('tb1','codex --token ghp_secretValue resume')]).name,'Codex');
  assert.equal(reportedTitle('claude --resume abc'),null);assert.equal(reportedTitle('zsh'),null);assert.equal(reportedTitle('Fix -v flag'),null);
  assert.equal(reportedTitle('⠂ Plan the migration'),'Plan the migration');
  // Shell/program self-reports are lowercase; English titles that begin with the same word are real titles.
  for(const shell of ['-zsh','zsh: ~/repo','login','bash'])assert.equal(reportedTitle(shell),null,shell);for(const title of ['Login loop','Shell script cleanup','Fish order bug'])assert.equal(reportedTitle(title),title);
  for(const bad of ['gl-1','GL-0','GL-142; rm','GH-PR-','X',' GL-1',null,42])assert.equal(issueKey(bad),null,String(bad));
  for(const good of ['ABC-123','GH-42','GH-PR-42','GL-142','GL-MR-42','A2_B-9'])assert.equal(issueKey(good),good);
  assert.equal(composeName('not a key','Title'),'Title');assert.equal(composeName('GL-1420','GL-142 x'),'GL-1420 GL-142 x');
  assert.equal(folderName('C:\\work\\repo\\'),'repo');assert.equal(folderName('/a/\u0007b'),null);
});

test('the same tab ID on two hosts is two separate instances',()=>{
  const local=observeTab({id:'tb1',name:'Notes',named:true},[pane('tb1')],{machine:null}),remote=observeTab({id:'tb1',name:'Notes',named:true},[pane('tb1')],{machine:'server'});
  assert.notEqual(local.key,remote.key);assert.equal(local.key,tabKey(null,'tb1'));assert.equal(remote.key,JSON.stringify(['server','tb1']));
  const a=reconcileTab(null,local,{now:1}),b=reconcileTab(null,remote,{now:1,retired:[{machine:'server',name:'Notes',at:0}]});
  assert.equal(a.entry.mode,'manual');assert.equal(b.entry.mode,'auto');assert.equal(b.retiredUsed,0);
  // A retired automatic name on another machine proves nothing here.
  assert.equal(reconcileTab(null,local,{now:1,retired:[{machine:'server',name:'Notes',at:0}]}).entry.mode,'manual');
});

test('automatic names settle once, are written once and an identical name is never written again',()=>{
  const t=driver();
  assert.equal(t.step().reason,'settling');assert.equal(t.actions.length,0);
  t.tick();const r=t.step();assert.equal(r.reason,'rename');assert.deepEqual({...r.action},{type:'rename',originId:null,key:tabKey(null,'tb1'),machine:null,tabId:'tb1',name:'app',from:'1',fromNamed:false});
  // A stale snapshot still shows Herdr's number: nothing is concluded and nothing repeats.
  t.tick(1000);assert.equal(t.step().reason,'pending');
  t.land(r.action);t.tick();assert.equal(t.step().reason,'unchanged');assert.equal(t.entry.lastName,'app');assert.equal(t.entry.pending,null);
  for(let i=0;i<5;i++){t.tick();assert.equal(t.step().reason,'unchanged');}
  // A program seen in only one poll is a transient: no rename.
  t.live.panes=[pane('tb1',{key:'git',name:'git'})];t.tick();assert.equal(t.step().reason,'settling');
  t.live.panes=[pane('tb1')];t.tick();assert.equal(t.step().reason,'unchanged');
  t.live.panes=[pane('tb1',{key:'nvim',name:'Neovim'})];t.tick();t.step();t.tick();const nvim=t.step();assert.equal(nvim.action.name,'Neovim');t.land(nvim.action);
  t.live.panes=[pane('tb1')];t.tick();t.step();t.tick();assert.equal(t.step().action.name,'app');
  assert.deepEqual(t.actions.map(a=>a.name),['app','Neovim','app']);
});

test('an observed manual edit is never overwritten, even while our write is pending',()=>{
  const t=driver();t.step();t.tick();t.land(t.step().action);t.tick();t.step();
  t.live.name='Notes';t.tick();assert.equal(t.step().reason,'manual');assert.deepEqual(t.entry.manual,{name:'Notes',source:'observed'});
  t.live.panes=[pane('tb1',{key:'nvim',name:'Neovim'})];for(let i=0;i<4;i++){t.tick();assert.equal(t.step().action,null);}
  // Herdr's own name again ("" rename) is the route back to automatic naming.
  t.live.name='1';t.live.named=false;t.tick();assert.equal(t.step().reason,'settling');assert.equal(t.entry.mode,'auto');
  t.tick();const back=t.step();assert.equal(back.action.name,'Neovim');
  // The user renames before our write lands: their name wins and is kept from then on.
  t.live.name='Mine';t.live.named=true;t.tick(500);assert.equal(t.step().reason,'manual');assert.equal(t.entry.pending,null);
  t.live.panes=[pane('tb1')];for(let i=0;i<4;i++){t.tick();assert.equal(t.step().action,null);}
  assert.equal(t.actions.length,2);
});

test('a write that never lands backs off and stops after bounded attempts: no rename loop',()=>{
  const t=driver();t.step();t.tick();t.step();
  let actions=1;for(let i=0;i<40;i++){t.tick();const r=t.step();if(r.action)actions++;}
  assert.equal(actions,NAME_TIMING.tries);assert.equal(t.entry.stuck,'app');assert.equal(t.step().reason,'stuck');
  // A different target is a new change and gets its own bounded attempts.
  t.live.panes=[pane('tb1',{key:'nvim',name:'Neovim'})];t.tick(70000);t.step();t.tick();assert.equal(t.step().action.name,'Neovim');
  // A failed command frees its pending write at once instead of waiting it out.
  t.tick();const failed=t.step({failed:true});assert.notEqual(failed.reason,'pending');assert.ok(t.entry.retryAt>t.now);
});

test('pre-existing names are adopted truthfully; launcher defaults and our own reopened names stay automatic',()=>{
  const fresh=(tab,panes,opts={})=>reconcileTab(null,observeTab(tab,panes),{now:5000,home:HOME,...opts});
  assert.equal(fresh({id:'tb1',name:'Claude Code',named:true},[claude('tb1','')]).entry.mode,'auto');
  assert.equal(fresh({id:'tb1',name:'Codex',named:true},[pane('tb1')],{knownNames:['Codex']}).entry.mode,'auto');
  assert.equal(fresh({id:'tb1',name:'GL-142 Fix login',named:true},[codex('tb1')],{meta:{key:'GL-142',title:'Fix login',initial:'GL-142 Fix login'}}).entry.mode,'auto');
  const unknown=fresh({id:'tb1',name:'Release notes',named:true},[pane('tb1')]);assert.deepEqual([unknown.entry.mode,unknown.entry.manual],['manual',{name:'Release notes',source:'adopted'}]);
  // Later metadata proving the name was the launch's own makes it automatic again.
  const later=reconcileTab(unknown.entry,observeTab({id:'tb1',name:'Release notes',named:true},[pane('tb1')]),{now:6000,meta:{initial:'Release notes'}});assert.equal(later.entry.mode,'auto');
  // A closed plain tab's automatic name, restored as a fixed name by reopen, is still ours.
  const state=emptyTabNames(),gone=driver();gone.step();gone.tick();gone.land(gone.step().action);gone.tick();gone.step();
  state.tabs[gone.entry.machine===null?tabKey(null,'tb1'):'x']=gone.entry;
  sweep(state,{live:new Set(),ready:()=>true,now:20000});assert.equal(state.retired.length,0);
  sweep(state,{live:new Set(),ready:()=>true,now:20000+NAME_TIMING.missingMs});assert.deepEqual(state.retired,[{machine:null,name:'app',at:20000+NAME_TIMING.missingMs}]);assert.deepEqual(state.tabs,{});
  const reopened=fresh({id:'tb9',name:'app',named:true},[pane('tb9',{key:'nvim',name:'Neovim',cwd:'/work/other'})],{retired:state.retired});assert.deepEqual([reopened.entry.mode,reopened.retiredUsed],['auto',0]);
  // An unavailable host keeps its entries for days, not seconds.
  const kept=emptyTabNames();kept.tabs[tabKey('server','tb1')]={...gone.entry,machine:'server',missingSince:1};
  sweep(kept,{live:new Set(),ready:()=>false,now:NAME_TIMING.missingMs*10});assert.equal(Object.keys(kept.tabs).length,1);
});

async function store(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mc-tab-names-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const io={appHome:root,readTextFile:async p=>{try{return await fs.readFile(p,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}},ensureDirectory:p=>fs.mkdir(p,{recursive:true}),
    writeTextFile:async(p,next,expected)=>{let actual=null;try{actual=sync.readFileSync(p,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}if(actual!==expected)throw Object.assign(Error('stale'),{code:'STALE'});sync.writeFileSync(p,next);}};
  return new NameOwnership(io,{owner:'observer'});
}
const session=id=>({machine:null,provider:'codex',credentialScope:'work',providerRoot:'/profiles/work/.codex',sessionId:id});
const own=async(names,originId)=>(await names.read()).value.origins[originId];

test('manual A, closed and resumed into a new tab while newer B exists, gets its name back exactly once',async t=>{
  const names=await store(t);
  await names.transferToAcknowledgedTab({originId:'A',session:session('s-A')},{tabId:'tab-A',name:'Codex'});
  await names.observeNames([{id:'tab-A',machine:null,name:'My investigation',named:true}]);
  await names.transferToAcknowledgedTab({originId:'B',session:session('s-B')},{tabId:'tab-B',name:'Codex'});
  // Resume launched A2 with its placeholder name; the manual transfer did not run (interrupted).
  await names.transferToAcknowledgedTab({originId:'A',session:session('s-A')},{tabId:'tab-A2',name:'Codex'});
  const a2={name:'Codex',named:true},b={name:'Codex',named:true},emitted=[];let ea=null,eb=null,now=1000;
  const pass=async()=>{
    for(const [tab,live,get,set]of [['tab-A2',a2,()=>ea,v=>{ea=v;}],['tab-B',b,()=>eb,v=>{eb=v;}]]){
      const originId=tab==='tab-A2'?'A':'B',r=reconcileTab(get(),observeTab({id:tab,...live},[codex(tab,'codex')]),{now,own:await own(names,originId),meta:{toolKey:'codex'}});set(r.entry);
      if(r.action){emitted.push([tab,r.action.type,r.action.name]);await names.applyName(r.action.originId,r.action.name,{manualTransfer:r.action.type==='transfer',getTabs:()=>[{id:'tab-A2',machine:null,...a2},{id:'tab-B',machine:null,...b}],rename:({id,name})=>{const x=id==='tab-A2'?a2:b;x.name=name;x.named=true;}});}
    }
    now+=3000;
  };
  for(let i=0;i<6;i++)await pass();
  assert.deepEqual(emitted,[['tab-A2','transfer','My investigation']]);assert.equal(a2.name,'My investigation');assert.equal(b.name,'Codex');
  assert.equal(ea.transfer,true);assert.equal((await own(names,'B')).manualName,null);
  // A later user rename of A2 is recorded and never replaced by the old transferred name.
  a2.name='Later';await names.observeNames([{id:'tab-A2',machine:null,...a2},{id:'tab-B',machine:null,...b}]);
  for(let i=0;i<4;i++)await pass();
  assert.equal(a2.name,'Later');assert.equal(emitted.length,1);assert.equal((await own(names,'A')).manualName,'Later');
  // An unrecorded edit on an automatic origin waits for the observer instead of being overwritten.
  b.name='Typed by user';const held=reconcileTab(eb,observeTab({id:'tab-B',...b},[codex('tab-B')]),{now,own:await own(names,'B')});
  assert.deepEqual([held.reason,held.action],['awaiting-observer',null]);
});

test('a history-only resumed session keeps its reported title and never gains a manual name',async t=>{
  const names=await store(t);
  assert.equal(await names.find({session:session('imported')}),null);
  // As resume() does: acknowledged placeholder, then the reported history title as an automatic name.
  await names.transferToAcknowledgedTab({originId:'session-x',session:session('imported')},{tabId:'tab-R',name:'Codex'});
  let live={id:'tab-R',name:'Codex',named:true};
  await names.applyName('session-x','Investigate flaky test',{getTabs:()=>[{...live,machine:null}],rename:({name})=>{live={...live,name};}});
  let entry=null,now=1000;const actions=[];
  for(let i=0;i<5;i++){const r=reconcileTab(entry,observeTab(live,[codex('tab-R','codex')]),{now,own:await own(names,'session-x')});entry=r.entry;if(r.action)actions.push(r.action);now+=3000;}
  assert.deepEqual(actions,[]);assert.equal(entry.mode,'auto');assert.equal(entry.manual,null);assert.equal(entry.meta.title,'Investigate flaky test');
  const record=await own(names,'session-x');assert.deepEqual([record.mode,record.manualName],['auto',null]);
  // The agent exits: the session's task identity stays instead of dropping to the folder.
  const after=reconcileTab(entry,observeTab(live,[pane('tab-R')]),{now,own:record});assert.equal(after.derived.name,'Investigate flaky test');assert.equal(after.action,null);
});

test('origin back-to-auto intent is persisted and an interrupted recorded write is finished, not lost',()=>{
  const obs=(n,named=true,panes=[pane('tbO')])=>observeTab({id:'tbO',name:n,named},panes);
  const manual={originId:'O',mode:'manual',manualName:'Mine',lastAutoName:'app'};
  let r=reconcileTab(null,obs('Mine'),{now:1000,own:manual});assert.deepEqual([r.reason,r.entry.transfer],['manual',true]);
  r=reconcileTab(r.entry,obs('2',false),{now:2000,own:manual});assert.equal(r.action.type,'automatic');assert.deepEqual(r.entry.intent,{at:2000,sent:2000});
  assert.equal(reconcileTab(r.entry,obs('2',false),{now:5000,own:manual}).reason,'resetting');
  r=reconcileTab(r.entry,obs('2',false),{now:8000,own:{originId:'O',mode:'auto',manualName:null,lastAutoName:null}});assert.equal(r.entry.intent,null);assert.equal(r.reason,'settling');
  // applyName recorded "Neovim" but the view was cancelled before its rename: the same write is finished directly.
  let e={...r.entry,lastName:'app',pending:{kind:'rename',from:'app',fromNamed:true,to:'Neovim',at:10000},attempt:{name:'Neovim',tries:1}};
  const recorded={originId:'O',mode:'auto',manualName:null,lastAutoName:'Neovim'},vim=[pane('tbO',{key:'nvim',name:'Neovim'})];
  r=reconcileTab(e,obs('app',true,vim),{now:15000,own:recorded});assert.equal(r.reason,'pending');
  r=reconcileTab(r.entry,obs('app',true,vim),{now:10000+NAME_TIMING.pendingMs,own:recorded});assert.deepEqual(r.entry.orphan,{from:'app',to:'Neovim'});assert.equal(r.reason,'backoff');
  r=reconcileTab(r.entry,obs('app',true,vim),{now:40000,own:recorded});assert.deepEqual([r.action.type,r.action.direct,r.action.name],['rename',true,'Neovim']);
});

test('persisted tab names validate strictly and round-trip every state the machine produces',()=>{
  const t=driver();t.step();t.tick();t.step();
  const state={...emptyTabNames(),revision:3,lease:{owner:'tabs-1',expiresAt:9},tabs:{[t.entry.machine===null?tabKey(null,'tb1'):'']:t.entry},retired:[{machine:null,name:'app',at:1}]};
  assert.deepEqual(validateTabNames(JSON.parse(JSON.stringify(state))),state);
  for(const broken of [{...state,v:2},{...state,tabs:{wrong:t.entry}},{...state,tabs:{[tabKey(null,'tb1')]:{...t.entry,mode:'manual'}}},{...state,lease:{owner:'',expiresAt:1}},{...state,retired:[{machine:null,name:'',at:1}]},{...state,tabs:{[tabKey(null,'tb1')]:{...t.entry,pending:{kind:'reset',from:'1',fromNamed:false,to:null,at:1}}}}])
    assert.throws(()=>validateTabNames(JSON.parse(JSON.stringify(broken))),{code:'INVALID_TAB_NAMES'});
  const many={...emptyTabNames(),tabs:Object.fromEntries(Array.from({length:NAME_LIMITS.entries+1},(_,i)=>[tabKey(null,'t'+i),{...t.entry,tabId:'t'+i}]))};
  assert.throws(()=>validateTabNames(many),{code:'TAB_NAMES_CAPACITY'});
  assert.deepEqual(mergeMeta({key:'GL-1',title:'A'},{key:'GL-2',title:'B',toolKey:'codex'}),{key:'GL-1',title:'A',kind:null,tool:{key:'codex',name:null},initial:null});
  assert.deepEqual(mergeMeta({title:'Resume title'},{key:'GL-2',title:'B'}),{key:'GL-2',title:'Resume title',kind:null,tool:null,initial:null});
});
