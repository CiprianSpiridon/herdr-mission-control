import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import sync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import {execFile} from 'node:child_process';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {promisify} from 'node:util';
import { NativeRuntime, NativeIsolationError, run, isolatedEnvironment, validateFixtureEnvironment, verifyPrivateSelectors, validateNativeIsolationReceipt, importNativeScenario, createFixtureService } from '../scripts/native-harness.mjs';

const ROOT=path.resolve(import.meta.dirname,'..'),SOURCE=path.join(ROOT,'scripts/native-harness.mjs');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex'),nonce='a'.repeat(24);
const invalid=error=>error instanceof NativeIsolationError&&error.code==='INVALID_NATIVE_ISOLATION';
const stable=value=>Array.isArray(value)?'['+value.map(stable).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+stable(value[key])).join(',')+'}':JSON.stringify(value);
const fingerprint=p=>sha(JSON.stringify([p.pid,p.uid,p.startedMs,p.executable]));
const directoryProof=file=>{const s=sync.lstatSync(file,{bigint:true});return {dev:String(s.dev),ino:String(s.ino),uid:Number(s.uid),mode:Number(s.mode&0o777n),birthMs:Number(s.birthtimeNs/1000000n)};};

test('scratch environment copies only ordinary variables and explicit bounded synthetic fixtures',()=>{
  const parent={PATH:'/bin',LANG:'en_US.UTF-8',HOME:'/real-home',HC_SESSION:'live',HC_SOCKET:'live',HERDR_APP_HOME:'/real-app',HERDR_OTHER:'live',XDG_RUNTIME_DIR:'/real-runtime',CODEX_HOME:'/real-codex',CLAUDE_CONFIG_DIR:'/real-claude',GROK_CONFIG_DIR:'/real-grok',ZDOTDIR:'/real-shell',NODE_OPTIONS:'--require=/real-hook',NODE_EXTRA_CA_CERTS:'/real-certificate',QA_AMBIENT_TOKEN:'ambient',GH_TOKEN:'ambient',ANTHROPIC_API_KEY:'ambient'};
  const before={...parent},fixtures={QA_TOKEN:'synthetic',NODE_EXTRA_CA_CERTS:path.join(ROOT,'.harness/test-ca.pem')};
  const env=isolatedEnvironment('/private/tmp/mcqa-test',nonce,parent,fixtures);
  assert.equal(env.HC_SESSION,'mcqa-'+nonce);assert.equal(env.HOME,'/private/tmp/mcqa-test/h');assert.equal(env.USERPROFILE,env.HOME);assert.equal(env.HERDR_APP_HOME,'/private/tmp/mcqa-test/app');assert.equal(env.QA_TOKEN,'synthetic');assert.equal(env.NODE_EXTRA_CA_CERTS,fixtures.NODE_EXTRA_CA_CERTS);assert.equal(env.DO_NOT_TRACK,'1');assert.equal(env.HERDR_TELEMETRY,'0');
  for(const key of Object.keys(parent).filter(key=>!['PATH','LANG','HOME','HC_SESSION','HERDR_APP_HOME','XDG_RUNTIME_DIR','NODE_EXTRA_CA_CERTS'].includes(key)))assert.equal(env[key],undefined,key);
  assert.deepEqual(parent,before);assert.deepEqual(fixtures,{QA_TOKEN:'synthetic',NODE_EXTRA_CA_CERTS:path.join(ROOT,'.harness/test-ca.pem')});
  for(const [root,id]of [['/tmp/mcqa-test',nonce],['/private/tmp/mcqa-test/../escape',nonce],['/private/tmp/mcqa-test','abcd']])assert.throws(()=>isolatedEnvironment(root,id,parent),invalid);
});

test('fixture ABI rejects accessors, inherited data, reserved selectors and UTF-8 bounds without reading getters',()=>{
  let reads=0;const accessor={get QA_TOKEN(){reads++;return 'secret';}};
  for(const value of [null,[],new Map(),Object.create({QA_TOKEN:'inherited'}),accessor,{[Symbol('hidden')]:'x'},{QA_TOKEN:1},{QA_TOKEN:'x\n'},{QA_TOKEN:'é'.repeat(2049)},{QA_TOKEN:'x'.repeat(4097)},{NODE_EXTRA_CA_CERTS:'relative.pem'},{NODE_EXTRA_CA_CERTS:'/private/real.pem'},Object.fromEntries(Array.from({length:33},(_,i)=>['QA_K'+i,'x'])),Object.fromEntries(Array.from({length:17},(_,i)=>['QA_K'+i,'x'.repeat(4096)]))])assert.throws(()=>validateFixtureEnvironment(value),invalid);
  for(const key of ['HOME','USERPROFILE','TMPDIR','XDG_CONFIG_HOME','XDG_RUNTIME_DIR','HC_SESSION','HC_SOCKET','HERDR_APP_HOME','CODEX_HOME','CLAUDE_CONFIG_DIR','GROK_CONFIG_DIR','NODE_OPTIONS','PATH','GH_TOKEN','QA_lowercase'])assert.throws(()=>validateFixtureEnvironment({[key]:'override'}),invalid,key);
  assert.equal(reads,0);assert.deepEqual(validateFixtureEnvironment(Object.assign(Object.create(null),{QA_EMPTY:''})),{QA_EMPTY:''});
  assert.deepEqual(validateFixtureEnvironment({NODE_EXTRA_CA_CERTS:'/private/tmp/mcqa-toy/cert.pem'},'/private/tmp/mcqa-toy'),{NODE_EXTRA_CA_CERTS:'/private/tmp/mcqa-toy/cert.pem'});
});

async function selectorFixture(t){
  const root=await fs.mkdtemp('/private/tmp/mcqa-'),env=isolatedEnvironment(root,nonce),d=directoryProof(root);
  for(const directory of new Set(Object.values(env).filter(value=>value.startsWith(root+'/'))))await fs.mkdir(directory,{mode:0o700});
  const selectors=Object.fromEntries(Object.entries(env).filter(([key])=>['HOME','USERPROFILE','TMPDIR','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_CACHE_HOME','XDG_RUNTIME_DIR','HERDR_APP_HOME','HC_SESSION'].includes(key)));
  const context={root,nonce,session:env.HC_SESSION,uid:d.uid,createdMs:d.birthMs,directory:d,selectors},directories=Object.fromEntries([...new Set(Object.values(selectors).filter(value=>value.startsWith(root+'/')))].map(file=>[file,directoryProof(file)]));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));return {root,env,context,directories};
}

test('real selector directories retain UID, permissions, canonical paths and original generations',async t=>{
  const f=await selectorFixture(t);assert.equal(verifyPrivateSelectors(f.context,f.env,f.directories),true);
  for(const key of Object.keys(f.context.selectors))assert.throws(()=>verifyPrivateSelectors(f.context,{...f.env,[key]:'/private/tmp/other'},f.directories),invalid,key);
  for(const key of ['HC_SOCKET','HERDR_OTHER','CODEX_HOME','CLAUDE_CONFIG_DIR','NODE_OPTIONS'])assert.throws(()=>verifyPrivateSelectors(f.context,{...f.env,[key]:'forbidden'},f.directories),invalid,key);
  assert.throws(()=>verifyPrivateSelectors({...f.context,uid:f.context.uid+1,directory:{...f.context.directory,uid:f.context.uid+1}},f.env,f.directories),invalid);
  await fs.chmod(f.env.HOME,0o755);assert.throws(()=>verifyPrivateSelectors(f.context,f.env,f.directories),invalid);await fs.chmod(f.env.HOME,0o700);
  await fs.rename(f.env.XDG_CACHE_HOME,f.env.XDG_CACHE_HOME+'-original');await fs.mkdir(f.env.XDG_CACHE_HOME,{mode:0o700});assert.throws(()=>verifyPrivateSelectors(f.context,f.env,f.directories),invalid);
});

test('selector symlinks and replaced root directories are rejected without opening the outside canary',async t=>{
  const f=await selectorFixture(t),outside=await fs.mkdtemp('/private/tmp/mc-canary-');t.after(()=>fs.rm(outside,{recursive:true,force:true}));await fs.writeFile(path.join(outside,'canary'),'unchanged');
  await fs.rm(f.env.HOME,{recursive:true});await fs.symlink(outside,f.env.HOME);assert.throws(()=>verifyPrivateSelectors(f.context,f.env,f.directories),invalid);assert.equal(await fs.readFile(path.join(outside,'canary'),'utf8'),'unchanged');
  await fs.rename(f.root,f.root+'-old');t.after(()=>fs.rm(f.root+'-old',{recursive:true,force:true}));await fs.mkdir(f.root,{mode:0o700});assert.throws(()=>verifyPrivateSelectors(f.context,f.env,f.directories),invalid);
});

test('scenario imports hand off explicit fixtures without parent mutation; changed/deleted variables are restored and refused',async t=>{
  const directory=await fs.mkdtemp('/private/tmp/mc-import-');t.after(()=>fs.rm(directory,{recursive:true,force:true}));const before={...process.env};
  const pure=path.join(directory,'pure.mjs');await fs.writeFile(pure,'export const fixtureEnvironment={QA_TOKEN:"synthetic"};export default async function(){}');const loaded=await importNativeScenario(pure);assert.deepEqual(loaded.fixtureEnvironment,{QA_TOKEN:'synthetic'});assert.deepEqual({...process.env},before);
  for(const [name,body]of [['set','process.env.QA_BAD="mutated";'],['delete','delete process.env.PATH;'],['throw','process.env.QA_BAD="mutated";throw new Error("failure");']]){const file=path.join(directory,name+'.mjs');await fs.writeFile(file,body+'export default function(){}');await assert.rejects(importNativeScenario(file),invalid);assert.deepEqual({...process.env},before);}
  const accessor=path.join(directory,'accessor.mjs');await fs.writeFile(accessor,'export const fixtureEnvironment={get QA_TOKEN(){throw new Error("getter invoked")}};export default function(){}');await assert.rejects(importNativeScenario(accessor),invalid);
});

test('default, forged and unknown control contexts are refused before any subprocess is spawned',t=>{
  const calls=[];const mock=t.mock.method(childProcess,'spawnSync',(...args)=>{calls.push(args);throw new Error('Unexpected spawn');});syncBuiltinESMExports();t.after(()=>{mock.mock.restore();syncBuiltinESMExports();});
  for(const executable of ['hc','herdr-app','/Applications/Herdr.app/Contents/MacOS/Herdr'])for(const env of [{},isolatedEnvironment('/private/tmp/mcqa-unknown',nonce,{PATH:'/bin'})])assert.throws(()=>run(executable,['status'],{env}),invalid);
  assert.equal(calls.length,0);
});

// Real disposable files/socket inodes; only process and CLI observations are
// injected. No installed Herdr command or arbitrary process can be reached.
async function fakeRuntime(t,options={}){
  const bins=await fs.mkdtemp('/private/tmp/mc-bin-');for(const file of ['hc','Herdr'])await fs.writeFile(path.join(bins,file),'#!/bin/sh\nexit 93\n',{mode:0o700});
  const original=childProcess.spawnSync,state={calls:[],pid:60001,holderPid:null,appPid:60003,id:'1'.repeat(32),alive:new Set(),owners:new Map(),startedMs:0,root:null};
  const result=value=>({status:0,stdout:typeof value==='string'?value:JSON.stringify(value),stderr:''});
  const bind=file=>{const r=original('python3',['-c','import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.close()',file],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);};state.bind=bind;
  const psDate=ms=>{const d=new Date(ms);return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getUTCDay()]+' '+['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()]+' '+String(d.getUTCDate()).padStart(2,' ')+' '+d.toISOString().slice(11,19)+' '+d.getUTCFullYear();};
  const mock=t.mock.method(childProcess,'spawnSync',(file,args,opts={})=>{
    if(file==='which')return result(path.join(bins,args[0]==='hc'?'hc':'Herdr'));
    if(file==='/bin/ps'){const address=Number(args[1]);if(!state.alive.has(address))return {status:1,stdout:'',stderr:''};return result(`${process.getuid()} ${psDate(state.startedMs+(state.reused?10000:0))} ${process.execPath}\n`);}
    if(file==='/usr/sbin/lsof'){assert.deepEqual(args.slice(0,5),['-nP','-U','-t','-a','--']);assert.ok(args[5].startsWith(state.root+'/'));return result((state.owners.get(args[5])??[]).join('\n'));}
    if(file===path.join(bins,'hc')||file===path.join(bins,'Herdr')){
      assert.ok(opts.env.HC_SESSION?.startsWith('mcqa-'));assert.ok(opts.env.HOME.startsWith('/private/tmp/mcqa-'));assert.equal(opts.env.HC_SOCKET,undefined);assert.equal(opts.env.GH_TOKEN,undefined);state.calls.push({file,args,env:{...opts.env}});
      if(args[0]==='server'&&args[1]==='start'){state.root=path.dirname(opts.env.HOME);state.startedMs=Math.floor(directoryProof(state.root).birthMs/1000)*1000-(options.older?10000:0);state.alive.add(state.pid);const socket=path.join(state.root,'r/core.sock');bind(socket);state.owners.set(socket,[state.pid]);return result({started:true});}
      if(args[0]==='server'&&args[1]==='status')return result({core:{id:state.id},pid:state.pid,holder:state.holderPid?{pid:state.holderPid}:null,live:0,finished:0});
      if(args[0]==='server'&&args[1]==='stop'){state.alive.delete(state.pid);state.alive.delete(state.holderPid);return result({stopped:true});}
      if(args[0]==='ls')return result({terminals:[{address:'t1'}]});
      if(args[0]==='get')return result({created_ms:directoryProof(state.root).birthMs,labels:{'mission-control.qa':opts.env.HC_SESSION.slice(5)}});
      if(args[0]==='status')return result({errors:[]});
      if(args[0]==='do'&&args[1]==='app.quit'){state.alive.delete(state.appPid);return result({ok:true});}
      return result({ok:true});
    }
    assert.equal(file,'git','Only fixture Git is allowed outside injected observations');return original(file,args,opts);
  });syncBuiltinESMExports();const runtime=new NativeRuntime();
  t.after(async()=>{mock.mock.restore();syncBuiltinESMExports();if(runtime.directory)await fs.rm(runtime.directory,{recursive:true,force:true});await fs.rm(bins,{recursive:true,force:true});});
  return {runtime,state,bins};
}

test('registered runtime pins executables despite PATH changes and cleans only its observed private core',async t=>{
  const {runtime,state}=await fakeRuntime(t);await runtime.start({fixtureEnvironment:{QA_TOKEN:'synthetic'}});runtime.env.PATH='/path/with/untrusted/hc';runtime.hc(['ls','--json']);assert.ok(state.calls.every(c=>c.env.QA_TOKEN==='synthetic'));assert.ok(state.calls.every(c=>c.file===runtime.context.hcBinary));assert.ok(Object.isFrozen(runtime.context.record.selectors));
  await runtime.close();assert.equal(runtime.cleanup.resourcesRemoved,true);assert.equal(runtime.cleanup.verifiedPrivateCore,true);assert.equal(runtime.cleanup.existingInstancesQueried,false);assert.equal(runtime.cleanup.verifiedPrivateApp,false);assert.equal(state.alive.size,0);await assert.rejects(fs.stat(runtime.directory),{code:'ENOENT'});assert.throws(()=>runtime.hc(['ls']),invalid);await assert.rejects(runtime.start(),invalid);
});

test('a private app requires a proven listener before its first IPC and a separate owned exit',async t=>{
  const {runtime,state}=await fakeRuntime(t);await runtime.start();assert.throws(()=>runtime.app(['status']),invalid);await assert.rejects(runtime.close(),invalid);assert.equal(runtime.cleanup.refused,true);assert.ok(await fs.stat(runtime.directory));assert.ok(state.alive.has(state.pid));
});

test('actual app socket metadata and PID proof allow IPC then private app/core cleanup',async t=>{
  const {runtime,state}=await fakeRuntime(t);await runtime.start();const socket=path.join(runtime.env.HERDR_APP_HOME,'herdr-app.sock');state.bind(socket);state.alive.add(state.appPid);state.owners.set(socket,[state.appPid]);
  const p={pid:state.appPid,uid:process.getuid(),startedMs:state.startedMs,executable:sync.realpathSync(process.execPath)};p.fingerprint=fingerprint(p);const s=sync.lstatSync(socket,{bigint:true});runtime.context.app={process:p,socket:{path:socket,dev:String(s.dev),ino:String(s.ino),uid:Number(s.uid),mode:Number(s.mode&0o777n),ownerPids:[state.appPid]}};
  assert.deepEqual(runtime.app(['status']),{errors:[]});await runtime.close();assert.equal(runtime.cleanup.verifiedPrivateApp,true);assert.equal(runtime.cleanup.refused,false);assert.equal(state.alive.size,0);assert.ok(runtime.context.audit.some(e=>e.kind==='app'&&e.command==='verify exit'&&e.phase==='cleanup'));
});

for(const scenario of ['selector','extra-env','fixture-env','directory','socket-inode','socket-owner','pid-generation','core-id','binary','argv-session','unowned-stop'])test('ownership drift refuses operation and cleanup: '+scenario,async t=>{
  const {runtime,state,bins}=await fakeRuntime(t);await runtime.start();
  if(scenario==='selector')runtime.env.HOME='/private/tmp/outside';
  if(scenario==='extra-env')runtime.env.HC_SOCKET='outside';
  if(scenario==='fixture-env')runtime.env.QA_UNREGISTERED='outside';
  if(scenario==='directory'){await fs.rename(runtime.env.XDG_CACHE_HOME,runtime.env.XDG_CACHE_HOME+'-original');await fs.mkdir(runtime.env.XDG_CACHE_HOME,{mode:0o700});}
  if(scenario==='socket-inode'){const socket=runtime.context.core.socket.path;await fs.rename(socket,socket+'-old');state.bind(socket);}
  if(scenario==='socket-owner')state.owners.set(runtime.context.core.socket.path,[state.appPid]);
  if(scenario==='pid-generation')state.reused=true;
  if(scenario==='core-id')state.id='2'.repeat(32);
  if(scenario==='binary')await fs.appendFile(path.join(bins,'hc'),'# changed\n');
  const before=state.calls.filter(c=>c.args[0]==='run').length;assert.throws(()=>runtime.hc(scenario==='argv-session'?['ls','--session','user']:scenario==='unowned-stop'?['server','stop']:['run','--','false']),invalid);assert.equal(state.calls.filter(c=>c.args[0]==='run').length,before);await assert.rejects(runtime.close(),invalid);assert.equal(runtime.cleanup.refused,true);assert.equal(runtime.cleanup.resourcesRemoved,false);assert.ok(state.alive.has(state.pid));assert.ok(await fs.stat(runtime.directory));
});

test('a borrowed older PID is refused before fixture mutations and retained for diagnostics',async t=>{
  const {runtime,state}=await fakeRuntime(t,{older:true});await assert.rejects(runtime.start(),invalid);assert.equal(state.calls.some(c=>c.args[0]==='run'),false);await assert.rejects(runtime.close(),invalid);assert.equal(runtime.cleanup.refused,true);assert.ok(state.alive.has(state.pid));
});

test('late holder receives independent new private-listener proof before cleanup',async t=>{
  const {runtime,state}=await fakeRuntime(t);await runtime.start();state.holderPid=60002;state.alive.add(state.holderPid);const socket=path.join(state.root,'r/holder.sock');state.bind(socket);state.owners.set(socket,[state.holderPid]);runtime.hc(['ls']);assert.equal(runtime.context.core.holder.process.pid,state.holderPid);await runtime.close();assert.equal(state.alive.size,0);
});

function validReceipt(){
  const root='/private/tmp/mcqa-receipt',createdMs=1800000000000,env=isolatedEnvironment(root,nonce,{}),selectors=Object.fromEntries(Object.entries(env).filter(([key])=>!['DO_NOT_TRACK','HERDR_TELEMETRY'].includes(key))),context={root,nonce,session:env.HC_SESSION,uid:501,createdMs,directory:{dev:'1',ino:'9007199254740995',uid:501,mode:0o700,birthMs:createdMs},selectors};
  const p=pid=>{const value={pid,uid:501,startedMs:createdMs,executable:'/bin/private-fixture'};return {...value,fingerprint:fingerprint(value)};},socket=(name,pid)=>({path:root+'/'+name,dev:'1',ino:String(pid),uid:501,mode:0o600,ownerPids:[pid]});
  const core={id:'1'.repeat(32),process:p(123),socket:socket('r/core.sock',123),holder:null},app={process:p(124),socket:socket('app/herdr-app.sock',124)},commandAudit=[['hc','server start','boot'],['hc','ls','owned'],['app','verify exit','cleanup'],['hc','verify exit','cleanup']].map(([kind,command,phase],i)=>({sequence:i+1,at:createdMs+i,kind,command,phase,result:'ok',selectorSha256:sha(stable(selectors))}));
  return {v:2,ok:true,code:null,error:null,cleanupError:null,completedMs:createdMs+100,nonce,isolation:{method:'private-ownership-v2',existingInstancesQueried:false,context,core,app,commandAudit},privateCoreId:core.id,privateCorePid:123,privateHolderPid:null,appPid:124,launcherPid:null,launcherExitCode:null,assertions:[{label:'actual click changed state',passed:true}],inputActions:[{kind:'pointer',pid:124}],frames:['before','after'].map((label,i)=>({label,capture:'macos-window-server',path:'.browse/sessions/mission-control-native-'+nonce+'/'+label+'.png',sha256:String(i+1).repeat(64),width:1280,height:760})),appCommands:[],packages:[],appErrors:[],boundary:'Synthetic receipt validator fixture; no native success claim.',cleanup:{attempted:true,stoppedOnlyOwnedProcesses:true,existingInstancesQueried:false,verifiedPrivateCore:true,verifiedPrivateApp:true,resourcesRemoved:true,refused:false},harnessSourceSha256:sha(sync.readFileSync(SOURCE))};
}

test('strict current V2 validates exact identity, routing, input, cleanup and provenance; adversarial mutations fail',async()=>{
  const good=validReceipt();assert.equal(await validateNativeIsolationReceipt(good),true);
  const mutations=[r=>r.v=1,r=>r.v=3,r=>r.ok=false,r=>r.code='FAILED',r=>r.error='failed',r=>r.cleanupError='failed',r=>r.extra=true,r=>delete r.privateCoreId,r=>r.baselineCoreSha256='a'.repeat(64),r=>r.harnessSourceSha256='f'.repeat(64),r=>r.completedMs=0,r=>r.nonce='b'.repeat(24),r=>r.isolation.method='legacy',r=>r.isolation.existingInstancesQueried=true,r=>r.isolation.userCoreIdentityAndPidUnchanged=true,r=>r.isolation.context.root='/tmp/wrong',r=>r.isolation.context.selectors.HOME='/real/home',r=>r.isolation.context.selectors.HC_SOCKET='/real/socket',r=>r.isolation.context.directory.uid=502,r=>r.isolation.context.directory.mode=0o755,r=>r.isolation.context.directory.birthMs++,r=>r.isolation.context.directory.ino=Number(r.isolation.context.directory.ino),r=>r.isolation.core.id='not-a-core',r=>r.privateCorePid=999,r=>r.privateHolderPid=999,r=>r.appPid=999,r=>r.isolation.app.process={...r.isolation.core.process},r=>r.isolation.core.process.uid=502,r=>r.isolation.core.process.startedMs-=10000,r=>r.isolation.core.process.fingerprint='f'.repeat(64),r=>r.isolation.core.process.executable='/bin/../invalid',r=>r.isolation.core.socket.path='/tmp/socket',r=>r.isolation.core.socket.dev=1,r=>r.isolation.core.socket.ino='01',r=>r.isolation.core.socket.uid=502,r=>r.isolation.core.socket.mode=0o1000,r=>r.isolation.core.socket.ownerPids=[999],r=>r.isolation.core.socket.ownerPids=[123,123],r=>r.isolation.app.socket.path=r.isolation.context.root+'/wrong.sock',r=>r.isolation.commandAudit[0].sequence=2,r=>r.isolation.commandAudit[0].at--,r=>r.isolation.commandAudit[0].selectorSha256='f'.repeat(64),r=>r.isolation.commandAudit[0].command='run',r=>r.isolation.commandAudit[1].result='refused',r=>r.isolation.commandAudit.pop(),r=>r.assertions[0].passed=false,r=>r.assertions=[],r=>r.inputActions[0].pid=999,r=>r.frames.pop(),r=>r.frames[0].path='../outside.png',r=>r.frames[1].sha256=r.frames[0].sha256,r=>r.frames[0].capture='offscreen',r=>r.frames[0].width=0,r=>r.appErrors.push({code:'error'}),r=>r.cleanup.resourcesRemoved=false,r=>r.cleanup.refused=true,r=>r.cleanup.userCoreIdentityAndPidUnchanged=true,r=>r.packages.push(()=>{}),r=>r.packages.push(new Date())];
  for(const [index,mutate]of mutations.entries()){const value=structuredClone(good);mutate(value);await assert.rejects(validateNativeIsolationReceipt(value),invalid,'mutation '+index);}
});

test('receipt JSON and options accessors, cycles, holes, symbols and source changes cannot downgrade validation',async t=>{
  let reads=0;const good=validReceipt();for(const target of ['options','object','array']){const value=structuredClone(good),options={};const destination=target==='options'?options:target==='object'?value:value.packages;Object.defineProperty(destination,target==='array'?'0':target==='options'?'receiptPath':'hidden',{enumerable:true,get(){reads++;return 'injected';}});await assert.rejects(validateNativeIsolationReceipt(value,options),invalid);}assert.equal(reads,0);
  const cyclic=structuredClone(good);cyclic.packages.push(cyclic);await assert.rejects(validateNativeIsolationReceipt(cyclic),invalid);const hole=structuredClone(good);hole.packages.length=1;await assert.rejects(validateNativeIsolationReceipt(hole),invalid);const symbol=structuredClone(good);symbol.packages[Symbol('hidden')]='x';await assert.rejects(validateNativeIsolationReceipt(symbol),invalid);
  const read=sync.readFileSync,changed=Buffer.concat([read(SOURCE),Buffer.from('\n// changed after load\n')]);const mock=t.mock.method(sync,'readFileSync',(file,...args)=>file===SOURCE?changed:read(file,...args));t.after(()=>mock.mock.restore());await assert.rejects(validateNativeIsolationReceipt(good),invalid);good.harnessSourceSha256=sha(changed);await assert.rejects(validateNativeIsolationReceipt(good),invalid);
});

test('retained legacy success is accepted only at the exact original path, bytes and old harness digest',async t=>{
  // A rerun (TASK-093) replaces a retained legacy receipt with current-harness proof; the old pin then accepts nothing.
  const names=['agent-menu','spaces','agents'],OLD_HARNESS='7989669a28df40986e7cffc818c5155ecf927c34cd26df910de1cb2dfd225ff9';
  for(const name of names){const file=path.join(ROOT,'evidence/native',name+'.json'),raw=await fs.readFile(file),receipt=JSON.parse(raw);
    if(receipt.v===1){assert.equal(await validateNativeIsolationReceipt(receipt,{receiptPath:file}),true);await assert.rejects(validateNativeIsolationReceipt(receipt),invalid);for(const mutate of [r=>r.ok=false,r=>r.harnessSourceSha256='f'.repeat(64),r=>r.v=2,r=>r.extra='changed']){const changed=structuredClone(receipt);mutate(changed);await assert.rejects(validateNativeIsolationReceipt(changed,{receiptPath:file}),invalid);}}
    else{assert.equal(receipt.v,2);await assert.rejects(validateNativeIsolationReceipt({...receipt,v:1,ok:true,harnessSourceSha256:OLD_HARNESS},{receiptPath:file}),invalid);}
    assert.equal(sha(await fs.readFile(file)),sha(raw));}
  const source={...JSON.parse(await fs.readFile(path.join(ROOT,'evidence/native/agent-menu.json'))),v:1,ok:true,harnessSourceSha256:OLD_HARNESS},copy=path.join(ROOT,'evidence/native','unit-copy-'+crypto.randomBytes(4).toString('hex')+'.json');t.after(()=>fs.rm(copy,{force:true}));await fs.writeFile(copy,JSON.stringify(source));await assert.rejects(validateNativeIsolationReceipt(source,{receiptPath:copy}),invalid);await assert.rejects(validateNativeIsolationReceipt(source,{receiptPath:'evidence/reviews/pre-private-isolation-v2/agent-menu.native.json'}),invalid);
  const arbitrary={...source,nonce:'forged'};await assert.rejects(validateNativeIsolationReceipt(arbitrary),invalid);
});

test('actual receipt paths reject symlink/body substitution; current V2 supports pre-write validation and exact file validation',async t=>{
  const packet=validReceipt(),file=path.join(ROOT,'evidence/native','unit-vtwo-'+crypto.randomBytes(4).toString('hex')+'.json'),link=file.replace('.json','-link.json');t.after(async()=>{await fs.rm(file,{force:true});await fs.rm(link,{force:true});});await fs.writeFile(file,JSON.stringify(packet));assert.equal(await validateNativeIsolationReceipt(packet,{receiptPath:path.relative(ROOT,file)}),true);await fs.symlink(file,link);await assert.rejects(validateNativeIsolationReceipt(packet,{receiptPath:link}),invalid);await fs.writeFile(file,JSON.stringify({...packet,nonce:'changed'}));await assert.rejects(validateNativeIsolationReceipt(packet,{receiptPath:file}),invalid);await assert.rejects(validateNativeIsolationReceipt(packet,{unknown:true}),invalid);
});

test('fixture HTTP uses a private trusted certificate and records redacted request metadata', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mission-tls-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const server = await createFixtureService(dir, { handler: ({ url }) => ({ body: { fixture: true, path: url } }) });
  t.after(() => server.close());
  const ca = await fs.readFile(server.caFile);
  const response = await new Promise((resolve, reject) => {
    https.get(server.origin + '/issues', { ca, headers: { authorization: 'Bearer fixture-only' } }, res => {
      const chunks = []; res.on('data', b => chunks.push(b)); res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks))));
    }).on('error', reject);
  });
  assert.deepEqual(response, { fixture: true, path: '/issues' });
  assert.deepEqual(server.requests, [{ method: 'GET', path: '/issues', hasAuthorization: true }]);
  assert.doesNotMatch(JSON.stringify(server.requests), /fixture-only/);
});

test('a real helper can trust two independent fixture sites in one extra-CA bundle',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'mission-multi-tls-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const sites=[];t.after(async()=>{for(const site of sites)await site.close();});
  for(const name of ['work','personal'])sites.push(await createFixtureService(path.join(directory,name),{handler:()=>({body:{account:name}})}));
  const bundle=path.join(directory,'both.pem');await fs.writeFile(bundle,(await Promise.all(sites.map(site=>fs.readFile(site.caFile,'utf8')))).join('\n'));
  const script=`import https from 'node:https';const sites=JSON.parse(process.argv[1]);console.log(JSON.stringify(await Promise.all(sites.map(site=>new Promise((resolve,reject)=>{https.get(site+'/profile',res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve(JSON.parse(Buffer.concat(chunks))))}).on('error',reject)})))));`;
  const result=await promisify(execFile)(process.execPath,['--input-type=module','-e',script,JSON.stringify(sites.map(site=>site.origin))],{env:{...process.env,NODE_EXTRA_CA_CERTS:bundle},timeout:15000});
  assert.deepEqual(JSON.parse(result.stdout),[{account:'work'},{account:'personal'}]);assert.equal(result.stderr,'');
  for(const site of sites)assert.deepEqual(site.requests,[{method:'GET',path:'/profile',hasAuthorization:false}]);
});

test('fixture MCP performs initialize, list and call over its real HTTPS transport',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mission-mcp-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const fixture=await createFixtureService(dir,{tools:[{name:'search_issues',description:'Read fixture issues',inputSchema:{type:'object',properties:{}},handler:async()=>({content:[{type:'text',text:'{"issues":[{"key":"WEB-142"}]}'}]})}]});
  t.after(()=>fixture.close());
  const ca=await fs.readFile(fixture.caFile);let session;
  const request=body=>new Promise((resolve,reject)=>{
    const bytes=JSON.stringify(body);
    const req=https.request(fixture.origin+'/mcp',{method:'POST',ca,headers:{'content-type':'application/json',accept:'application/json, text/event-stream',...(session?{'mcp-session-id':session}:{})}},res=>{
      session=res.headers['mcp-session-id']||session;const chunks=[];
      res.on('data',b=>chunks.push(b));res.on('end',()=>{try{assert.equal(res.statusCode,200,Buffer.concat(chunks).toString());resolve(JSON.parse(Buffer.concat(chunks)));}catch(e){reject(e);}});
    });req.on('error',reject);req.end(bytes);
  });
  const hello=await request({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'qa',version:'1'}}});
  assert.equal(hello.result.serverInfo.name,'mission-control-native-fixture');assert.ok(session);
  const list=await request({jsonrpc:'2.0',id:2,method:'tools/list',params:{}});assert.equal(list.result.tools[0].name,'search_issues');
  const call=await request({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'search_issues',arguments:{}}});
  assert.equal(JSON.parse(call.result.content[0].text).issues[0].key,'WEB-142');
});
