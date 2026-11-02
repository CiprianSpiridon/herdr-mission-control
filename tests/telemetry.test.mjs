import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import sync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {TelemetryBridge,REFRESH_STALE_MS} from '../src/shared/telemetry.js';
import {BindingStore,argvSessionProof} from '../src/shared/session-bindings.js';
import {terminalIdentity} from '../src/shared/session-identity.js';
const MOD='mission-control-agents',ID='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222';
async function fixture(t,{machine=null,alsoLocal=false}={}){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'mc-telemetry-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  let now=1800000000000,mode=null,gate=null;const calls=[],raws=new Map(),agents=[],spaces=[],sources={};
  const providerRoot=root+'/.codex',sessions=providerRoot+'/sessions',home=root+'/app';await fs.mkdir(sessions,{recursive:true});await fs.mkdir(home+'/mission-control',{recursive:true});
  for(const[id,used]of [[ID,40],[OTHER,80]])await fs.writeFile(sessions+'/rollout-'+id+'.jsonl',[{type:'session_meta',payload:{id,cwd:'/fixture/repo',timestamp:new Date(now).toISOString()}},{type:'event_msg',timestamp:new Date(now).toISOString(),payload:{type:'token_count',thread_id:id,info:{last_token_usage:{total_tokens:used},model_context_window:100},rate_limits:{primary:{used_percent:used/2,window_minutes:300}}}}].map(JSON.stringify).join('\n')+'\n');
  const code=(await Promise.all(['collector.py','provider_codex.py','provider_claude.py','provider_grok.py'].map(name=>fs.readFile('src/shared/'+name,'utf8')))).join('\n')+'\ncollector_main({"codex":collect_codex,"claude":collect_claude,"grok":collect_grok})\n';
  const hosts=alsoLocal?[null,machine]:[machine];
  for(const on of hosts){
    const prefix=on?on+'/':'',source={v:1,enabled:true,machine:on,provider:'codex',providerRoot,credentialScope:'fixture',roots:[sessions]};sources[on||'local']=source;spaces.push({id:prefix+'space',machine:on});
    for(const[n,id]of [[1,ID],[2,OTHER],[3,null]]){const address=prefix+'t'+n,raw={address:'t'+n,created_ms:100+n,foreground:{pid:1000+n},argv:id?['codex','resume',id]:['codex'],cwd:'/fixture/repo'};raws.set(address,raw);agents.push({address,space:prefix+'space',tab:prefix+'tab-'+n,title:'Same repo fixture'});}
  }
  const configFile=home+'/mission-control/config.json';await fs.writeFile(configFile,JSON.stringify({v:1,revision:0,connections:{},bindings:{},preferences:{},usageSources:sources}));
  const api={appHome:()=>home,home:()=>root,agents:()=>agents,spaces:()=>spaces,machines:()=>hosts.map(name=>({name,layout:'ready'})),knownAgents:async()=>[],
    readTextFile:async file=>{calls.push({read:file});if(file===home+'/mods/'+MOD+'/collector.py')return code;try{return await fs.readFile(file,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}},
    writeTextFile:async(file,text,expected)=>{let current=null;try{current=sync.readFileSync(file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}if(current!==expected)throw Object.assign(Error('stale'),{code:'STALE'});sync.writeFileSync(file,text);},
    exec:async(command,args,options={})=>{
      const on=options.on??null;calls.push({command,args:command==='python3'?['-c','own-collector',args[2]]:args,on});
      if(command==='mkdir'){await fs.mkdir(args[1],{recursive:true});return {code:0,stdout:''};}
      if(command==='hc'){
        // hc 0.1.16 lists a connected machine's terminals on the local core under qualified addresses.
        if(args[0]==='ls'&&mode==='qualified-listing'&&!on)return {code:0,stdout:JSON.stringify({terminals:[...raws].map(([address,raw])=>({...raw,address}))})};
        if(args[0]==='ls')return {code:0,stdout:JSON.stringify({terminals:[...raws].filter(([address])=>on?address.startsWith(on+'/'):!address.includes('/')).map(([,raw])=>raw)})};
        const raw=raws.get((on?on+'/':'')+args[1]);return {code:raw?0:1,stdout:raw?JSON.stringify(raw):''};
      }
      assert.equal(command,'python3');assert.equal(args[1],code);if(gate)await gate;
      if(mode==='remote-hang'&&on)return new Promise(()=>{});
      if(mode==='missing-python'||mode==='remote-missing'&&on)return {code:127,stdout:'PRIVATE_FAILURE_DETAIL'};
      const child=spawnSync('python3',args,{encoding:'utf8',maxBuffer:1048576});assert.equal(child.status,0,child.stderr);let value=JSON.parse(child.stdout);
      if(mode==='wrong-scope')value.scope.credentialScope='another-profile';
      if(mode==='wrong-session'&&value.data[0]?.identity)value.data[0].identity.sessionId='unrequested-session';
      if(mode==='oversized')return {code:0,stdout:'PRIVATE_PREFIX'+'.'.repeat(524289)};
      if(mode==='malformed')return {code:0,stdout:'PRIVATE_INVALID_JSON'};
      return {code:0,stdout:JSON.stringify(value)};
    }};
  const store=new BindingStore({...api,ensureDirectory:dir=>fs.mkdir(dir,{recursive:true})},{clock:()=>now});
  for(const agent of agents){const raw=raws.get(agent.address);if(raw.argv.length<3)continue;const on=spaces.find(s=>s.id===agent.space).machine,session={machine:on,provider:'codex',credentialScope:'fixture',providerRoot,sessionId:raw.argv[2]},terminal=terminalIdentity(raw,on),requestId='request-'+agent.address;
    await store.propose({requestId,originId:'origin-'+agent.address,session});await store.commitAcknowledged(requestId,{tabId:agent.tab,terminal},argvSessionProof({capabilities:{machine:on,provider:'codex',run:['codex'],resume:{kind:'command',command:'resume'}},session,terminal,argv:raw.argv,kind:'resume-argv',observedAt:now,sourceDigest:'synthetic-exact-argv'}));
  }
  const bridge=new TelemetryBridge(MOD,api,{clock:()=>now});t.after(()=>bridge.close());
  return {root,home,api,bridge,store,agents,raws,calls,sources,setMode:value=>mode=value,setGate:value=>gate=value,setTime:value=>now=value,now:()=>now};
}

test('actual local Python observations attach to two durable exact sessions and leave fresh Codex unbound',async t=>{
  const f=await fixture(t),readings=await f.bridge.refresh();assert.equal(readings.size,3);assert.equal(readings.get('t1').context.remainingPercent,60);assert.equal(readings.get('t2').context.remainingPercent,20);assert.equal(readings.get('t1').quota.scope,'session-observation');assert.equal(readings.get('t1').quota.windows[0].remainingPercent,80);assert.equal(readings.get('t3').context.state,'unavailable');
  const count=f.calls.filter(c=>c.command==='python3').length;await f.bridge.refresh();assert.equal(f.calls.filter(c=>c.command==='python3').length,count,'refresh interval bounds repeated collector IO');
  f.setTime(f.now()+120001);await f.bridge.refresh();assert.equal(f.bridge.reading(f.agents[0]).context.state,'stale');
  assert.deepEqual([...new Set(f.calls.filter(c=>c.read?.endsWith('collector.py')).map(c=>c.read))],[f.home+'/mods/'+MOD+'/collector.py']);
});
test('a separately instantiated consumer reads committed mappings without producer memory',async t=>{
  const f=await fixture(t);await f.bridge.refresh();f.bridge.close();const fresh=new TelemetryBridge(MOD,f.api,{clock:f.now});t.after(()=>fresh.close());const rows=await fresh.refresh();assert.equal(rows.get('t1').context.remainingPercent,60);assert.equal(rows.get('t2').context.remainingPercent,20);
});
test('recorded remote transport retains on: host and never falls back locally after helper failure',async t=>{
  const f=await fixture(t,{machine:'server',alsoLocal:true});f.setMode('remote-missing');const rows=await f.bridge.refresh();assert.equal(rows.size,6);assert.equal(rows.get('t1').context.state,'available');assert.equal(rows.get('server/t1').context.state,'unavailable');
  const remote=f.calls.filter(c=>c.command==='python3'&&c.on==='server');assert.equal(remote.length,1);assert.equal(JSON.parse(remote[0].args[2]).source.machine,'server');assert.equal(f.calls.filter(c=>c.command==='python3'&&c.on===null).length,1);
});
test('oversized, malformed, wrong-profile and wrong-session output preserve visible unavailable agents',async t=>{
  for(const mode of ['oversized','malformed','wrong-scope','wrong-session','missing-python']){const f=await fixture(t);f.setMode(mode);const rows=await f.bridge.refresh();assert.equal(rows.size,3);for(const reading of rows.values()){assert.equal(reading.context.state,'unavailable');assert.doesNotMatch(JSON.stringify(reading),/PRIVATE_/);}}
});
test('source disable in another copy cancels late publication and future metadata reads',async t=>{
  const f=await fixture(t),other=new TelemetryBridge(MOD,f.api,{clock:f.now});t.after(()=>other.close());await other.sources.refresh();let release,entered;const started=new Promise(resolve=>entered=resolve);f.setGate(new Promise(resolve=>release=resolve));const original=f.api.exec;
  f.bridge.io.exec=async(...args)=>{if(args[0]==='python3')entered();return original(...args);};const pending=f.bridge.refresh();await started;await other.sources.save('local',{...f.sources.local,enabled:false});release();await pending;
  assert.equal(f.bridge.observations.size,0);assert.equal(f.bridge.reading(f.agents[0]).context.state,'unavailable');assert.equal((await f.store.requestState('request-t1')).state,'invalidated');const count=f.calls.filter(c=>c.command==='python3').length;await f.bridge.refresh(undefined,{force:true});assert.equal(f.calls.filter(c=>c.command==='python3').length,count);
});
test('a foreground restart during collection invalidates durable correlation before returning readings',async t=>{
  const f=await fixture(t);let entered,release;const started=new Promise(resolve=>entered=resolve);f.setGate(new Promise(resolve=>release=resolve));const original=f.bridge.io.exec;f.bridge.io.exec=async(...args)=>{if(args[0]==='python3')entered();return original(...args);};const pending=f.bridge.refresh();await started;f.raws.get('t1').foreground.pid=99999;release();const rows=await pending;assert.equal(rows.get('t1').context.state,'unavailable');assert.equal((await f.store.requestState('request-t1')).state,'invalidated');assert.equal(rows.get('t2').context.state,'available');
});
test('a remote host that never answers neither hides local readings nor freezes later refreshes',async t=>{
  const f=await fixture(t,{machine:'server',alsoLocal:true});f.setMode('remote-hang');const local=f.agents.find(a=>!a.address.includes('/'));
  f.bridge.refresh();for(let i=0;i<200&&f.bridge.reading(local).context.state!=='available';i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.bridge.reading(local).context.state,'available','local readings publish while the remote host is still pending');
  const before=f.calls.filter(c=>c.command==='python3'&&c.on===null).length;f.setTime(f.now()+REFRESH_STALE_MS+1);f.bridge.refresh(undefined,{force:true});
  for(let i=0;i<200&&f.calls.filter(c=>c.command==='python3'&&c.on===null).length===before;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.ok(f.calls.filter(c=>c.command==='python3'&&c.on===null).length>before,'an abandoned refresh is replaced after its stale age');
});
test('an agent whose terminal just ended does not make every other agent on its host unavailable',async t=>{
  const f=await fixture(t);f.agents.push({address:'t9',space:'space',tab:'tab-9',title:'Ended fixture'});
  const readings=await f.bridge.refresh();
  assert.equal(readings.get('t1').context.remainingPercent,60,'the live bound agent keeps its exact reading');assert.equal(readings.get('t9').context.state,'unavailable');
});
test('a bound terminal that finished but is still listed by hc does not make the host unavailable',async t=>{
  const f=await fixture(t),ended=f.raws.get('t2');ended.state='finished';delete ended.foreground;
  const readings=await f.bridge.refresh();
  assert.equal(readings.get('t1').context.remainingPercent,60,'live agents keep their exact readings');assert.equal(readings.get('t2').context.state,'unavailable');
});
test('a local listing that includes a connected machine\u2019s qualified terminals keeps local readings',async t=>{
  const f=await fixture(t,{machine:'server',alsoLocal:true});f.setMode('qualified-listing');const readings=await f.bridge.refresh();
  assert.equal(readings.get('t1').context.remainingPercent,60,'the local agent keeps its exact reading');assert.equal(readings.get('server/t1').context.remainingPercent,60,'the remote agent keeps its own reading');
});
test('host scheduler permits one operation per host and no more than four hosts',async t=>{
  const f=await fixture(t),counts=new Map();let total=0,max=0,hostMax=0;
  await Promise.all(Array.from({length:15},(_,n)=>f.bridge.onHost('host-'+n%5,async()=>{const key=n%5;counts.set(key,(counts.get(key)||0)+1);total++;max=Math.max(max,total);hostMax=Math.max(hostMax,counts.get(key));await new Promise(resolve=>setTimeout(resolve,4));counts.set(key,counts.get(key)-1);total--;})));
  assert.equal(hostMax,1);assert.equal(max,4);assert.equal(f.bridge.activeHosts,0);
});
test('history reads exact provider identities from the own helper and disabled history cannot run',async t=>{
  const f=await fixture(t),page=await f.bridge.historyPage('local');assert.equal(page.data.length,2);assert.ok(page.data.every(r=>r.identity.providerRoot===f.sources.local.providerRoot));await f.bridge.sources.save('local',{...f.sources.local,enabled:false});await assert.rejects(f.bridge.historyPage('local'),e=>e.code==='SOURCE_DISABLED');
});
test('a kept agent replaced by a shell loses its mapping even after its agent row disappears',async t=>{
  const f=await fixture(t);await f.bridge.refresh();f.raws.get('t1').foreground.pid=99999;f.agents.splice(f.agents.findIndex(a=>a.address==='t1'),1);await f.bridge.refresh(undefined,{force:true});assert.equal((await f.store.requestState('request-t1')).state,'invalidated');assert.equal(f.bridge.agentStates.has('t1'),false);assert.equal(f.bridge.reading(f.agents.find(a=>a.address==='t2')).context.state,'available');
});
test('pending installed-tool discovery cannot occupy an existing source host collector queue',async t=>{
  const f=await fixture(t);let release;f.bridge.io.knownAgents=()=>new Promise(resolve=>release=resolve);
  const discovering=f.bridge.initializeSources();await Promise.resolve();
  assert.equal(f.bridge.activeHosts,0);const rows=await f.bridge.refresh();assert.equal(rows.get('t1').context.remainingPercent,60);
  f.bridge.close();const calls=f.calls.length;release([]);await discovering;assert.equal(f.calls.length,calls,'closed discovery cannot schedule later metadata IO');
});
test('prepared readings avoid metadata work during render and still expire an exact account proof',async t=>{
  const f=await fixture(t);await f.bridge.refresh();const rows=f.bridge.observations.get('local').live;
  for(const row of rows){row.quota.proof={kind:'provider-account',machine:null,credentialScope:'fixture',accountId:'exact-account',poolId:'subscription'};row.quota.windows=[{name:'primary',remainingPercent:row.identity.sessionId===ID?80:10,observedAt:row.identity.sessionId===ID?f.now()-299999:f.now(),resetsAt:null}];}
  f.bridge.publishReadings(f.agents);assert.equal(f.bridge.reading(f.agents[0]).quota.windows[0].remainingPercent,10);
  const original=f.bridge.observations.values;f.bridge.observations.values=()=>{throw Error('Rendering must not rescan provider metadata');};
  try{assert.equal(f.bridge.readings(f.agents).get('t1').context.remainingPercent,60);f.setTime(f.now()+2);assert.equal(f.bridge.reading(f.agents[0]).quota.state,'stale');assert.equal(f.bridge.reading(f.agents[1]).quota.state,'available');f.setTime(f.now()+120001);assert.equal(f.bridge.reading(f.agents[0]).context.state,'stale');}
  finally{f.bridge.observations.values=original;}
});
