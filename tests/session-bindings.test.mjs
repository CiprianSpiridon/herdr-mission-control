import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import sync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {BindingStore,argvSessionProof,processSessionProof,validateBindingStore} from '../src/shared/session-bindings.js';
import {terminalKey} from '../src/shared/session-identity.js';
const session={machine:null,provider:'claude',credentialScope:'work',providerRoot:'/profiles/work/.claude',sessionId:'019c7714-3b77-74d1-9866-e1f484aae2ab'};
const terminal={machine:null,address:'t1',createdMs:100,foregroundPid:222};
const ack={tabId:'tab-A',terminal};
const capabilities={machine:null,provider:'claude',run:['claude'],callerSession:'--session-id',resume:{kind:'flag',flag:'--resume'}};
const proof=(s=session,t=terminal)=>argvSessionProof({capabilities:{...capabilities,machine:s.machine,provider:s.provider},session:s,terminal:t,argv:['claude','--session-id',s.sessionId],kind:'caller-session-id',observedAt:1000,sourceDigest:'verified-argv-v1'});
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'mc-bindings-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));let now=1000;
  const io={appHome:root,readTextFile:async p=>{try{return await fs.readFile(p,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}},ensureDirectory:p=>fs.mkdir(p,{recursive:true}),writeTextFile:async(p,next,expected)=>{let current=null;try{current=sync.readFileSync(p,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}if(current!==expected)throw Object.assign(Error('stale'),{code:'STALE'});sync.writeFileSync(p,next);}};
  return {root,io,store:new BindingStore(io,{clock:()=>now}),clock:()=>now,setTime:n=>now=n};
}
test('acknowledged exact mapping is durable across independently instantiated consumers and never expires by age',async t=>{
  const f=await fixture(t);await f.store.propose({requestId:'A',originId:'origin-A',session});assert.equal(await f.store.readCommitted(terminal),null);
  await f.store.markCommitPending('A',ack,proof());assert.equal(await f.store.readCommitted(terminal),null);
  await f.store.commitAcknowledged('A',ack,proof());f.setTime(3601000);
  const fresh=new BindingStore(f.io,{clock:f.clock}),record=await fresh.readCommitted(terminal);assert.equal(record.requestId,'A');assert.equal(record.expiresAt,null);assert.equal(record.createdAt,1000);
  await fresh.garbageCollect();assert.equal((await f.store.readCommitted(terminal)).session.sessionId,session.sessionId);
  const replay=await fresh.commitAcknowledged('A',ack,proof());assert.equal(replay.updatedAt,1000);
});
test('wrong host/account/root and changed terminal generations cannot attach an old reading',async t=>{
  const f=await fixture(t);await f.store.propose({requestId:'A',originId:'origin-A',session});
  await assert.rejects(f.store.commitAcknowledged('A',ack,proof({...session,credentialScope:'other'})),e=>e.code==='UNPROVEN_SESSION');
  await assert.rejects(f.store.commitAcknowledged('A',{...ack,terminal:{...terminal,machine:'server'}},proof()),e=>e.code==='UNPROVEN_SESSION');
  await f.store.commitAcknowledged('A',ack,proof());assert.equal(await f.store.readCommitted({...terminal,createdMs:101}),null);assert.equal(await f.store.readCommitted({...terminal,foregroundPid:333}),null);
  await f.store.reconcile([],{available:false,authoritative:true});assert.ok(await f.store.readCommitted(terminal));
  await f.store.reconcile([{address:'t1',created_ms:100,foreground:{pid:333}}],{authoritative:true});assert.equal(await f.store.readCommitted(terminal),null);assert.equal((await f.store.requestState('A')).state,'invalidated');
});
test('no-ID fresh sessions remain unbound; explicit exact resume and unique PID/open-file evidence can prove one',async t=>{
  const f=await fixture(t);await f.store.propose({requestId:'unknown',originId:'origin-X'});await f.store.commitAcknowledged('unknown',ack);assert.equal(await f.store.readCommitted(terminal),null);
  const resume=argvSessionProof({capabilities,session,terminal,argv:['claude','--resume',session.sessionId],kind:'resume-argv',observedAt:1000,sourceDigest:'resume'});assert.equal(resume.kind,'resume-argv');
  assert.throws(()=>argvSessionProof({capabilities,session,terminal,argv:['claude','--continue'],kind:'resume-argv',observedAt:1000,sourceDigest:'wrong'}),/exact session ID/);
  const evidence={machine:null,processes:[{pid:223,parentPid:222}],files:[{pid:223,path:session.providerRoot+'/projects/session.jsonl',session}]};
  const verified=processSessionProof({session,terminal,evidence,observedAt:1000,sourceDigest:'pid-files'});assert.equal(verified.kind,'pid-open-file');
  assert.throws(()=>processSessionProof({session,terminal,evidence:{...evidence,files:[...evidence.files,{pid:223,path:session.providerRoot+'/other.jsonl',session:{...session,sessionId:'other'}}]},observedAt:1000,sourceDigest:'ambiguous'}),/uniquely/);
  await f.store.commitAcknowledged('unknown',ack,verified,{session});assert.equal((await f.store.readCommitted(terminal)).session.sessionId,session.sessionId);
});
test('expired interrupted work needs journal recovery and is never silently respawned or garbage-collected',async t=>{
  const f=await fixture(t);await f.store.propose({requestId:'A',originId:'origin-A',session});await f.store.markCommitPending('A',ack,proof());f.setTime(301001);
  await assert.rejects(f.store.propose({requestId:'A',originId:'origin-A',session}),e=>e.code==='RECOVERY_REQUIRED');
  await assert.rejects(f.store.commitAcknowledged('A',ack,proof()),e=>e.code==='RECOVERY_REQUIRED');
  assert.equal((await f.store.requestState('A')).recoveryRequired,true);await f.store.garbageCollect();assert.ok(await f.store.requestState('A'));
  await f.store.garbageCollect({recoveryRecorded:['A']});assert.equal(await f.store.requestState('A'),null);
});
test('concurrent CAS proposals retain both; terminal index cannot point at two origins',async t=>{
  const f=await fixture(t),b=new BindingStore(f.io,{clock:f.clock});
  await Promise.all([f.store.propose({requestId:'A',originId:'origin-A',session}),b.propose({requestId:'B',originId:'origin-B',session:{...session,sessionId:'B'}})]);
  assert.deepEqual(Object.keys((await b.read()).value.proposals).sort(),['A','B']);await f.store.commitAcknowledged('A',ack,proof());
  await assert.rejects(b.commitAcknowledged('B',ack,proof({...session,sessionId:'B'})),e=>e.code==='BINDING_CONFLICT');assert.equal((await b.read()).value.terminals[terminalKey(terminal)],'A');
});
test('equal-time invalidation GC is deterministic across fresh consumers and preserves every active mapping',async t=>{
  const f=await fixture(t),g=await fixture(t);await f.store.propose({requestId:'active',originId:'origin-active',session});await f.store.commitAcknowledged('active',ack,proof());
  const initial=(await f.store.read()).value;
  for(let i=104;i>=0;i--){const id='r'+String(i).padStart(3,'0');initial.proposals[id]={originId:'origin-'+id,session:null,state:'invalidated',createdAt:500,updatedAt:900,invalidatedAt:900,expiresAt:null};}
  const raw=JSON.stringify(initial);await fs.writeFile(f.store.path,raw);await fs.mkdir(path.dirname(g.store.path),{recursive:true});await fs.writeFile(g.store.path,raw);
  const a=new BindingStore(f.io,{clock:f.clock}),b=new BindingStore(g.io,{clock:g.clock});const [x,y]=await Promise.all([a.garbageCollect(),b.garbageCollect()]);assert.deepEqual(x,y);
  assert.equal(Object.keys(x.proposals).length,101);for(let i=0;i<5;i++)assert.equal(x.proposals['r'+String(i).padStart(3,'0')],undefined);assert.equal(x.terminals[terminalKey(terminal)],'active');
  f.setTime(2000);await a.invalidate('active','First');f.setTime(3000);await a.invalidate('active','Again');const r=await a.requestState('active');assert.equal(r.invalidatedAt,2000);assert.equal(r.updatedAt,3000);
});
test('capacity failure cannot evict active mappings or partially write a new proposal',async t=>{
  const f=await fixture(t);const d={v:1,revision:1,proposals:{},terminals:{}};
  for(let i=0;i<500;i++){const tr={...terminal,address:'t'+(i+1)},id='active-'+i;d.proposals[id]={originId:'origin-'+i,session:null,state:'committed',createdAt:1,updatedAt:1,invalidatedAt:null,expiresAt:null,ack:{tabId:'tab-'+i,terminal:tr}};d.terminals[terminalKey(tr)]=id;}
  await fs.mkdir(path.dirname(f.store.path),{recursive:true});const raw=JSON.stringify(d);await fs.writeFile(f.store.path,raw);
  await assert.rejects(f.store.propose({requestId:'overflow',originId:'overflow'}),e=>e.code==='BINDING_CAPACITY');assert.equal(await fs.readFile(f.store.path,'utf8'),raw);
});
test('invalid persisted timestamps are rejected and disable invalidates even offline sources',async t=>{
  const f=await fixture(t);await f.store.propose({requestId:'A',originId:'origin-A',session});await f.store.commitAcknowledged('A',ack,proof());await f.store.invalidateSources([]);assert.equal(await f.store.readCommitted(terminal),null);
  const snapshot=(await f.store.read()).value;delete snapshot.proposals.A.invalidatedAt;assert.throws(()=>validateBindingStore(snapshot),/timestamp/);
  await fs.writeFile(f.store.path,'{broken');await assert.rejects(f.store.propose({requestId:'B',originId:'origin-B'}),/original preserved/);assert.equal(await fs.readFile(f.store.path,'utf8'),'{broken');
  await assert.rejects(f.store.propose({requestId:'__proto__',originId:'bad'}),/Invalid/);
});
