import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import sync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn,spawnSync} from 'node:child_process';
import './support/native-loader.mjs';
import {SessionHistory,historyRecord,mergeRecord,byActivity,parseWorktrees,resolveRepoCheckouts,membershipIndex,locateSession,pendingFolders,verifyFolders,journalCheckouts,runningSessions,deriveSessions,filterSessions,repoKey,HISTORY_LIMIT,HISTORY_PAGE,STALE_LOAD_MS} from '../src/mods/mission-control-sessions/model.js';
import {BindingStore,argvSessionProof} from '../src/shared/session-bindings.js';
import {terminalIdentity,sessionKey} from '../src/shared/session-identity.js';
// The shared transport imports Herdr's module; resolve it through the strict test seam.
const {TelemetryBridge}=await import('../src/shared/telemetry.js');

const MOD='mission-control-sessions',T=1800000000000,minute=60000;
const id=n=>`${String(n).padStart(8,'0')}-1111-4111-8111-${String(n).padStart(12,'0')}`;
const child=(cmd,args,options={})=>new Promise((resolve,reject)=>{const p=spawn(cmd,args,{cwd:options.cwd});let stdout='',stderr='';p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);p.on('error',reject);p.on('close',code=>resolve({code,stdout,stderr}));});
const git=async(dir,...args)=>{const r=await child('git',['-C',dir,...args]);assert.equal(r.code,0,r.stderr);};
async function repository(dir){await fs.mkdir(dir,{recursive:true});for(const args of [['init','-q','-b','main'],['config','user.name','QA'],['config','user.email','qa@example.invalid'],['commit','--allow-empty','-qm','Initial']])await git(dir,...args);}
const stamp=async(file,at)=>{const time=new Date(at);await fs.utimes(file,time,time);return file;};
async function rollout(dir,session,{cwd,at,name}){await fs.mkdir(dir,{recursive:true});const file=path.join(dir,name||'rollout-'+session+'.jsonl');await fs.writeFile(file,JSON.stringify({type:'session_meta',payload:{id:session,cwd,timestamp:new Date(at).toISOString()}})+'\n');return stamp(file,at);}
async function claude(dir,session,{cwd,at,title}){
  await fs.mkdir(dir,{recursive:true});const file=path.join(dir,session+'.jsonl');
  await fs.writeFile(file,[{type:'ai-title',sessionId:session,aiTitle:title},{type:'assistant',sessionId:session,cwd,timestamp:new Date(at).toISOString(),message:{usage:{input_tokens:3,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:2}}}].map(JSON.stringify).join('\n')+'\n');return stamp(file,at);
}
const collector=(await Promise.all(['collector.py','provider_codex.py','provider_claude.py','provider_grok.py'].map(name=>fs.readFile('src/shared/'+name,'utf8')))).join('\n\n')+'\n\nif __name__ == "__main__":\n    collector_main({"codex": collect_codex, "claude": collect_claude, "grok": collect_grok})\n';
const listing=dir=>sync.readdirSync(dir,{recursive:true}).sort().map(name=>[name,sync.statSync(path.join(dir,name))]).filter(([,s])=>s.isFile()).map(([name,s])=>[name,s.size,s.mtimeMs]);

async function transport(t,root,sources,{clock=()=>T}={}){
  const home=root+'/app',calls=[],raws=new Map(),hooks={};await fs.mkdir(home+'/mission-control',{recursive:true});
  await fs.writeFile(home+'/mission-control/config.json',JSON.stringify({v:1,revision:0,connections:{},bindings:{},preferences:{},usageSources:sources}));
  const api={appHome:()=>home,home:()=>root,agents:()=>[],spaces:()=>[],machines:()=>[{name:null,layout:'ready'},{name:'server',layout:'ready'}],knownAgents:async()=>[],
    readTextFile:async file=>{if(file===home+'/mods/'+MOD+'/collector.py')return collector;try{return await fs.readFile(file,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}},
    writeTextFile:async(file,text,expected)=>{let current=null;try{current=sync.readFileSync(file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}if(current!==expected)throw Object.assign(Error('stale'),{code:'STALE'});sync.writeFileSync(file,text);},
    exec:async(command,args,options={})=>{
      const on=options.on??null;calls.push({command,args:command==='python3'?['-c','own-collector',JSON.parse(args[2])]:args,on});
      if(command==='python3'){assert.equal(args[1],collector);const r=spawnSync('python3',args,{encoding:'utf8',maxBuffer:8*1024*1024});assert.equal(r.status,0,r.stderr);return {code:0,stdout:hooks.response?hooks.response(r.stdout):r.stdout,stderr:''};}
      if(command==='git')return child('git',args,{cwd:options.cwd});
      if(command==='mkdir'){await fs.mkdir(args[1],{recursive:true});return {code:0,stdout:''};}
      if(command==='hc'){if(args[0]==='ls')return {code:0,stdout:JSON.stringify({terminals:[...raws.values()].map(raw=>({address:raw.address,state:'live'}))})};const raw=raws.get(args[1]);return raw?{code:0,stdout:JSON.stringify(raw)}:{code:1,stdout:''};}
      throw Error('Unexpected fixture effect '+command);
    }};
  const bridges=[],history=new SessionHistory(()=>{const bridge=new TelemetryBridge(MOD,api,{clock});bridges.push(bridge);return bridge;},{clock});t.after(()=>history.close());
  return {home,api,calls,raws,hooks,history,bridges,pages:()=>calls.filter(c=>c.command==='python3').map(c=>c.args[2])};
}
function source(root,provider,machine=null,prefix=''){
  const providerRoot=root+prefix+'/.'+provider;return {v:1,enabled:true,machine,provider,credentialScope:'standard',providerRoot,roots:[providerRoot+(provider==='claude'?'/projects':'/sessions')]};
}
async function fixture(t){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'mc-sessions-model-'))),work=root+'/work',repo=work+'/client',linked=work+'/client-linked',gone=work+'/client-gone',pruned=work+'/client-pruned',sibling=work+'/client-other',twin=root+'/work2/client',moved=work+'/app',renamed=work+'/app-renamed';
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  for(const dir of [repo,sibling,twin,moved])await repository(dir);
  await git(repo,'worktree','add','-q','-b','feature',linked);await git(repo,'worktree','add','-q','-b','gone',gone);await git(repo,'worktree','add','-q','-b','pruned',pruned);
  await fs.rm(gone,{recursive:true,force:true});await fs.rm(pruned,{recursive:true,force:true});await git(repo,'worktree','prune');
  // git prune also forgets client-gone; record it again as a missing (prunable) checkout.
  await git(repo,'worktree','add','-q',gone,'gone');await fs.rm(gone,{recursive:true,force:true});
  await fs.mkdir(repo+'/src');await repository(repo+'/vendor/lib');
  const sources={'local-codex':source(root,'codex'),'server-codex':source(root,'codex','server','/server'),'local-claude':source(root,'claude')},codex=sources['local-codex'].roots[0],server=sources['server-codex'].roots[0];
  const s={A1:id(1),A2:id(2),L1:id(3),G1:id(4),SUB:id(5),NEST:id(6),SIB:id(7),TWIN:id(8),J1:id(9),R1:id(10),C1:id(11),RN:id(12)};
  const plan=[['A1',repo,50],['A2',repo,10],['L1',linked,20],['G1',gone,30],['SUB',repo+'/src',15],['NEST',repo+'/vendor/lib',5],['SIB',sibling,3],['TWIN',twin,4],['J1',pruned,40],['RN',moved,45]];
  for(const[name,cwd,ago]of plan)await rollout(codex+'/2026/10/31',s[name],{cwd,at:T-ago*minute});
  await rollout(server+'/2026/10/31',s.R1,{cwd:repo,at:T-minute});
  await claude(sources['local-claude'].roots[0]+'/-work-client',s.C1,{cwd:repo,at:T-12*minute,title:'Fix login redirect'});
  await fs.writeFile(codex+'/2026/10/31/rollout-broken.jsonl','{not json\n');await stamp(codex+'/2026/10/31/rollout-broken.jsonl',T-2*minute);
  await fs.writeFile(codex+'/2026/10/31/rollout-anonymous.jsonl',JSON.stringify({type:'session_meta',payload:{cwd:repo}})+'\n');
  await fs.rename(moved,renamed);
  const f=await transport(t,root,sources);
  const journal={v:1,revision:1,requests:{'req-J1':{request:{requestId:'req-J1',idempotencyKey:'resume-j1-0',originId:'origin-J1',spaceId:'A',machine:null,repoRoot:repo,checkoutRoot:pruned,toolKey:'codex',worktree:false},state:'complete',createdAt:1,updatedAt:2,leaseUntil:0,owner:'op',tabAttempted:true,folder:pruned,ack:{space:'A',tab:'tab-9',terminal:'t9'},sessionProposal:{machine:null,provider:'codex',credentialScope:'standard',providerRoot:sources['local-codex'].providerRoot,sessionId:s.J1}}}};
  await fs.writeFile(f.home+'/mission-control/launches.json',JSON.stringify(journal));
  const spaces={A:{id:'A',name:'client',machine:null,active:true,tabs:[{id:'A-tab'}]},B:{id:'server/B',name:'client',machine:'server',active:false,tabs:[{id:'server/B-tab'}]},C:{id:'C',name:'client',machine:null,active:false,tabs:[{id:'C-tab'}]},D:{id:'D',name:'app',machine:null,active:false,tabs:[{id:'D-tab'}]}};
  const panes={A:[{pane:'A-pane',tab:'A-tab',terminal:'t1',cwd:linked,focused:true}],B:[{pane:'B-pane',tab:'server/B-tab',terminal:'server/t2',cwd:repo,focused:false}],C:[{pane:'C-pane',tab:'C-tab',terminal:'t3',cwd:twin,focused:false}],D:[{pane:'D-pane',tab:'D-tab',terminal:'t4',cwd:renamed,focused:false}]};
  return {...f,root,repo,linked,gone,pruned,sibling,twin,renamed,sources,codex,s,spaces,panes};
}
const identity=(f,name,machine=null)=>({machine,provider:name==='C1'?'claude':'codex',credentialScope:'standard',providerRoot:machine?f.sources['server-codex'].providerRoot:name==='C1'?f.sources['local-claude'].providerRoot:f.sources['local-codex'].providerRoot,sessionId:f.s[name]});
async function derive(f,{spaces,scope,ready=()=>true,running=new Map(),folders=new Map()}){
  const exec=f.api.exec,repos=[];for(const name of spaces)repos.push(await resolveRepoCheckouts(f.spaces[name],f.panes[name],exec));
  const index=membershipIndex(repos),journal=journalCheckouts(await f.api.readTextFile(f.home+'/mission-control/launches.json')),ids=f.history.list().map(e=>e.id);
  const target=scope.all?scope:{...scope,repoKey:repoKey(repos[0].machine,repos[0].repoRoot)},isMember=target.all?()=>true:record=>locateSession(index,record,{journal,folders})?.repoKey===target.repoKey;
  await f.history.scan(ids,{want:HISTORY_PAGE,isMember});const records=f.history.records(ids);
  await verifyFolders(exec,pendingFolders(index,records),folders);
  return {repos,index,view:await deriveSessions({records,index,scope:target,journal,folders,running,ready})};
}
const names=(f,view)=>view.rows.map(r=>Object.keys(f.s).find(k=>f.s[k]===r.identity.sessionId));

test('history normalization keeps exact source identity and rejects wrong-scope or malformed observations',()=>{
  const src={id:'local',machine:null,provider:'codex',credentialScope:'work',providerRoot:'/profiles/work/.codex'},identity={machine:null,provider:'codex',credentialScope:'work',providerRoot:'/profiles/work/.codex',sessionId:id(1)};
  const observation=(at,extra={})=>({state:'available',identity,provenance:{provider:'codex',format:'codex-rollout-jsonl',formatVersion:null,sourceDigest:'a'.repeat(64),observedAt:at},context:null,quota:null,...extra});
  const older=historyRecord(observation(10,{title:'Kept title',cwd:'/repo'}),src),newer=historyRecord(observation(20),src);
  assert.equal(older.ok,true);assert.equal(older.record.key,sessionKey(identity));assert.ok(Object.isFrozen(older.record.identity));
  const merged=mergeRecord(older.record,newer.record);assert.equal(merged.activityAt,20);assert.equal(merged.title,'Kept title');assert.equal(merged.cwd,'/repo');assert.deepEqual(mergeRecord(newer.record,older.record),merged);
  assert.equal(historyRecord(observation(5,{identity:{...identity,credentialScope:'personal'}}),src).code,'WRONG_SCOPE');assert.equal(historyRecord(observation(5,{identity:{...identity,machine:'server'}}),src).code,'WRONG_SCOPE');
  assert.equal(historyRecord({...observation(5),cwd:'relative/path'},src).code,'MALFORMED');assert.equal(historyRecord({state:'unavailable',identity:null,provenance:observation(1).provenance,code:'MISSING_SESSION_ID',reason:'No exact ID.'},src).code,'UNREADABLE');
  assert.throws(()=>mergeRecord(older.record,historyRecord(observation(1,{identity:{...identity,sessionId:id(2)}}),src).record),e=>e.code==='IDENTITY_CONFLICT');
  assert.deepEqual([{key:'b',activityAt:null},{key:'c',activityAt:5},{key:'a',activityAt:5}].sort(byActivity).map(r=>r.key),['a','c','b']);
});

test('each space lists only its canonical repo/worktree sessions, sorted by activity with stable exact identity',async t=>{
  const f=await fixture(t),before=listing(f.root+'/.codex');await f.history.refreshSources();
  const a=await derive(f,{spaces:['A'],scope:{all:false,spaceId:'A',spaceName:'client'}});
  assert.equal(a.repos[0].repoRoot,f.repo);assert.equal(a.repos[0].worktreeRoot,f.linked);assert.deepEqual(a.repos[0].worktrees.map(w=>[w.path,w.branch,w.missing]).sort(),[[f.gone,'gone',true],[f.repo,'main',false],[f.linked,'feature',false]].sort());
  assert.deepEqual(names(f,a.view),['A2','C1','SUB','L1','G1','J1','A1']);
  const rows=Object.fromEntries(a.view.rows.map(r=>[Object.keys(f.s).find(k=>f.s[k]===r.identity.sessionId),r]));
  assert.equal(rows.C1.title,'Fix login redirect');assert.equal(rows.C1.titleKind,'reported');assert.equal(rows.A2.titleKind,'untitled');assert.match(rows.A2.title,/^Untitled · 00000002$/);
  assert.equal(rows.L1.branch,'feature');assert.equal(rows.L1.linked,true);assert.equal(rows.L1.checkoutRoot,f.linked);assert.equal(rows.SUB.checkoutRoot,f.repo);assert.equal(rows.SUB.cwd,f.repo+'/src');assert.equal(rows.A1.branch,'main');
  for(const row of a.view.rows){assert.equal(row.key,sessionKey(row.identity));assert.equal(row.spaceId,'A');assert.equal(row.repoRoot,f.repo);assert.equal(row.machine,null);assert.equal(row.host,'This Mac');assert.ok(Object.isFrozen(row));}
  assert.ok(!a.view.rows.some(r=>[f.s.SIB,f.s.TWIN,f.s.NEST,f.s.R1,f.s.RN].includes(r.identity.sessionId)),'siblings, nested repos, other hosts and similar names never merge');
  const again=await derive(f,{spaces:['A'],scope:{all:false,spaceId:'A',spaceName:'client'}});assert.deepEqual(again.view.rows.map(r=>[r.id,r.key]),a.view.rows.map(r=>[r.id,r.key]));assert.equal(new Set(a.view.rows.map(r=>r.id)).size,a.view.rows.length);
  const b=await derive(f,{spaces:['B'],scope:{all:false,spaceId:'server/B',spaceName:'client'}});assert.deepEqual(names(f,b.view),['R1']);assert.equal(b.view.rows[0].machine,'server');assert.equal(b.view.rows[0].host,'server');assert.equal(b.view.rows[0].repoRoot,f.repo,'the same path on another host is a different repository');
  const c=await derive(f,{spaces:['C'],scope:{all:false,spaceId:'C',spaceName:'client'}});assert.deepEqual(names(f,c.view),['TWIN']);
  const status=f.history.status(f.history.list().map(e=>e.id));assert.equal(status.unreadable,2);assert.equal(status.errors.length,0);assert.equal(status.more,false);assert.equal(status.truncated,false);
  assert.ok(f.pages().every(request=>request.operation==='list'&&request.limit===50));assert.deepEqual(listing(f.root+'/.codex'),before,'history is read-only');
  const filtered=filterSessions(a.view,{query:'feature'});assert.deepEqual(filtered.rows.map(r=>r.identity.sessionId),[f.s.L1]);assert.deepEqual(filterSessions(a.view,{tool:'claude'}).rows.map(r=>r.provider),['claude']);assert.equal(filterSessions(a.view).counts.codex,6);
});

test('missing or renamed paths are recoverable unavailable rows, and stale running matches never merge',async t=>{
  const f=await fixture(t);await f.history.refreshSources();
  const all=await derive(f,{spaces:['A','B','C','D'],scope:{all:true,activeSpaceId:'A'}}),rows=Object.fromEntries(all.view.rows.map(r=>[Object.keys(f.s).find(k=>f.s[k]===r.identity.sessionId),r]));
  assert.equal(all.view.rows.length,12);assert.equal(rows.G1.state,'missing');assert.match(rows.G1.reason,/worktree is missing on This Mac\. Locate or restore it, then retry\./);assert.equal(rows.G1.checkoutRoot,f.gone);assert.equal(rows.G1.branch,'gone');
  assert.equal(rows.J1.state,'missing');assert.equal(rows.J1.checkoutRoot,f.pruned);assert.equal(rows.J1.spaceId,'A');
  for(const name of ['RN','SIB','NEST']){assert.equal(rows[name].state,'unassigned',name);assert.equal(rows[name].spaceId,null);assert.match(rows[name].reason,/No open space on This Mac contains this folder/);}
  assert.equal(rows.RN.cwd,f.root+'/work/app');assert.equal(rows.TWIN.spaceId,'C');assert.equal(rows.R1.spaceId,'server/B');assert.equal(rows.L1.spaceId,'A');assert.equal(rows.A2.state,'ready');
  // Exact binding A2 is live; A1's address was reused by a new generation; t5 runs Codex unbound.
  const io={...f.api,appHome:f.home},store=new BindingStore(io,{clock:()=>T}),capabilities={machine:null,provider:'codex',run:['codex'],resume:{kind:'command',command:'resume'}};
  for(const[name,address,created]of [['A2','t1',101],['A1','t2',102]]){
    const raw={address,created_ms:created,foreground:{pid:700+created},argv:['codex','resume',f.s[name]],cwd:f.repo},terminal=terminalIdentity(raw,null),session=identity(f,name);
    await store.propose({requestId:'req-'+name,originId:'origin-'+name,session});await store.commitAcknowledged('req-'+name,{tabId:'tab-'+address,terminal},argvSessionProof({capabilities,session,terminal,argv:raw.argv,kind:'resume-argv',observedAt:T,sourceDigest:'fixture'}));f.raws.set(address,raw);
  }
  f.raws.set('t2',{...f.raws.get('t2'),created_ms:999});f.raws.set('t5',{address:'t5',created_ms:105,foreground:{pid:805,name:'codex'},argv:['codex'],cwd:f.repo});
  const running=await runningSessions(io);assert.deepEqual([...running.keys()],[sessionKey(identity(f,'A2'))]);assert.equal(running.get(sessionKey(identity(f,'A2'))).tabId,'tab-t1');
  const live=await derive(f,{spaces:['A'],scope:{all:false,spaceId:'A',spaceName:'client'},running}),states=Object.fromEntries(live.view.rows.map(r=>[r.identity.sessionId,r.state]));
  assert.equal(states[f.s.A2],'running');assert.equal(states[f.s.A1],'ready');assert.equal(live.view.rows.filter(r=>r.state==='running').length,1);
  const offline=await derive(f,{spaces:['A'],scope:{all:false,spaceId:'A',spaceName:'client'},ready:machine=>machine!==null});
  assert.ok(offline.view.rows.every(r=>r.state==='offline'&&/This Mac is offline/.test(r.reason)));assert.equal(offline.view.rows.find(r=>r.identity.sessionId===f.s.L1).branch,'feature');assert.equal(offline.view.rows.length,live.view.rows.length);
});

test('more than 1000 records stay bounded, paged and newest first without touching provider files',async t=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'mc-sessions-bulk-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const bulk=source(root,'codex','bulk'),dir=bulk.roots[0]+'/2026/10';for(let n=1;n<=1100;n++)await rollout(dir,id(n),{cwd:root+'/repo',at:T-(1101-n)*minute});
  const before=listing(bulk.roots[0]),f=await transport(t,root,{bulk});await f.history.refreshSources();const ids=f.history.on(['bulk']);
  await f.history.scan(ids,{pages:3});let status=f.history.status(ids);assert.equal(status.more,true);assert.equal(f.history.records(ids).length,150);
  await f.history.scan(ids,{more:true,pages:40});status=f.history.status(ids);const entry=f.history.list()[0];
  assert.equal(entry.records.size,HISTORY_LIMIT);assert.equal(status.more,false);assert.equal(status.truncated,true,'the collector indexes only the newest 1000 files');assert.equal(entry.indexTruncated,true);
  assert.ok(f.pages().every(r=>r.operation==='list'&&r.limit===50));assert.equal(f.pages().length,20);
  const view=await deriveSessions({records:f.history.records(ids),index:membershipIndex([]),scope:{all:true}},{pause:async()=>{}});
  assert.equal(view.rows.length,HISTORY_LIMIT);assert.equal(view.rows[0].identity.sessionId,id(1100));assert.equal(view.rows.at(-1).identity.sessionId,id(101));assert.ok(!view.rows.some(r=>r.identity.sessionId===id(100)));
  assert.ok(view.rows.every((r,i)=>i===0||view.rows[i-1].activityAt>=r.activityAt));assert.ok(view.rows.every(r=>r.state==='unassigned'));
  const pages=[];for(let page=0;page*HISTORY_PAGE<view.rows.length;page++)pages.push(filterSessions(view).rows.slice(page*HISTORY_PAGE,(page+1)*HISTORY_PAGE));assert.equal(pages.length,20);assert.ok(pages.every(p=>p.length===HISTORY_PAGE));
  await rollout(dir,id(1101),{cwd:root+'/repo',at:T+minute});await f.history.scan(ids,{pages:1});
  assert.equal(entry.records.size,HISTORY_LIMIT);assert.ok(entry.records.has(sessionKey({...bulk,sessionId:id(1101)})));assert.ok(!entry.records.has(sessionKey({...bulk,sessionId:id(101)})),'the oldest retained session yields to newer activity');assert.equal(entry.capped,true);
  await fs.rm(dir+'/rollout-'+id(1101)+'.jsonl');assert.deepEqual(listing(bulk.roots[0]),before,'no provider history is deleted or rewritten');
});

test('stale cursors restart from the newest page and failing pages keep timestamped same-scope data',async t=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'mc-sessions-cursor-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const local=source(root,'codex'),dir=local.roots[0];for(let n=1;n<=120;n++)await rollout(dir,id(n),{cwd:root+'/repo',at:T-(121-n)*minute});
  let now=T;const f=await transport(t,root,{local},{clock:()=>now});await f.history.refreshSources();const ids=f.history.on([null]),entry=f.history.list()[0];
  await f.history.scan(ids,{pages:1});assert.equal(entry.records.size,50);assert.ok(entry.cursor);
  await stamp(dir+'/rollout-'+id(3)+'.jsonl',T+minute);await f.history.scan(ids,{more:true,pages:1});
  assert.equal(entry.error,null);assert.equal(entry.records.size,100);const requests=f.pages().slice(-3);assert.deepEqual(requests.map(r=>typeof r.cursor),['string','undefined','string'],'a rejected cursor restarts once from the newest page, then continues');
  now=T+5*minute;f.hooks.response=stdout=>{const value=JSON.parse(stdout);value.scope.credentialScope='another-profile';return JSON.stringify(value);};
  await f.history.scan(ids,{pages:1});const status=f.history.status(ids);
  assert.equal(status.errors[0].code,'SCOPE_MISMATCH');assert.equal(status.errors[0].at,now);assert.doesNotMatch(status.errors[0].message,/another-profile/);assert.equal(entry.records.size,100,'same-scope failures keep the earlier rows');assert.equal(status.fetchedAt,T);
  f.hooks.response=null;
  const config=JSON.parse(await fs.readFile(f.home+'/mission-control/config.json','utf8'));config.usageSources.local.enabled=false;config.revision++;await fs.writeFile(f.home+'/mission-control/config.json',JSON.stringify(config));
  await f.history.refreshSources();assert.equal(f.history.list().length,0,'a disabled source clears its rows immediately');
});

test('an abandoned history read is recovered with a fresh shared transport',async t=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'mc-sessions-abandon-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  let now=T;const f=await transport(t,root,{local:source(root,'codex')},{clock:()=>now});await f.history.refreshSources();const entry=f.history.list()[0];
  entry.pending=new Promise(()=>{});entry.pendingAt=now;assert.equal(f.history.hasAbandonedLoad(),false);assert.equal(f.history.status([entry.id]).loading,true);
  now+=STALE_LOAD_MS;assert.equal(f.history.hasAbandonedLoad(),true);assert.equal(f.history.status([entry.id]).loading,false);
  const old=f.history.bridge;f.history.recover();assert.notEqual(f.history.bridge,old);assert.equal(old.closed,true);assert.equal(entry.pending,null);assert.equal(f.bridges.length,2);
  await f.history.refreshSources();await f.history.scan([entry.id]);assert.equal(entry.error?.code,undefined);assert.equal(f.history.list()[0],entry);
  assert.deepEqual(parseWorktrees('worktree /r\0HEAD 1\0branch refs/heads/main\0\0worktree /w\0HEAD 1\0detached\0prunable gitdir file points to non-existent location\0\0').map(w=>[w.path,w.branch,w.detached,w.missing]),[['/r','main',false,false],['/w',null,true,true]]);
  assert.throws(()=>parseWorktrees('worktree relative\0\0'),e=>e.code==='INVALID_WORKTREES');
});
