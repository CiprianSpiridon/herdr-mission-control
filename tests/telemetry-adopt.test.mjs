// Agents started outside Mission Control: Claude Code's own PID records adopt their exact conversation.
// The real collector runs against live child processes, so the PID and recorded start-time checks are real.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import sync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn,spawnSync} from 'node:child_process';
// The collector runs no programs: Claude Code rewrites its record whenever a process starts.
import {TelemetryBridge} from '../src/shared/telemetry.js';

const MOD='mission-control-agents';
const OWN='11111111-1111-4111-8111-111111111111',JOB='aaaaaaaa-2222-4222-8222-222222222222',TWIN='aaaaaaaa-3333-4333-8333-333333333333';
const DOMAIN=process.platform==='darwin'?'darwin':'linux';

// Herdr created each fixture terminal a minute ago; a Claude Code process in it started after that.
const CREATED=Date.now()-60000,STARTED=Date.now();
function live(t){const child=spawn('sleep',['60'],{stdio:'ignore'});t.after(()=>child.kill());return {pid:child.pid,start:STARTED};}

async function fixture(t,{records,agents:rows}){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'mc-adopt-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  let now=1800000000000;const calls=[],raws=new Map(),agents=[];
  const providerRoot=root+'/.claude',projects=providerRoot+'/projects',usage=root+'/usage',home=root+'/app';
  for(const dir of [providerRoot+'/sessions',projects+'/-fixture-repo',usage,home+'/mission-control'])await fs.mkdir(dir,{recursive:true});
  for(const record of records)await fs.writeFile(`${providerRoot}/sessions/${record.pid}.json`,JSON.stringify(record));
  // A key file beside the records must never be read.
  await fs.writeFile(`${providerRoot}/sessions/${records[0]?.pid??1}.secret.key`,'PRIVATE_KEY_MATERIAL');
  const at=Math.floor(now/1000),context=(id,used)=>({used_percent:used,cache:{session_id:id,last_activity_unix:at}});
  await fs.writeFile(usage+'/claude-statusline.json',JSON.stringify({provider:'claude',source:'claude-statusline',fetched_at_unix:at,session_quota_only:true,
    session_contexts:{[OWN]:context(OWN,30),[JOB]:context(JOB,55),[TWIN]:context(TWIN,90)},session_windows:{},session_quota_observations:{},session_accounts:{}}));
  const source={v:1,enabled:true,machine:null,provider:'claude',providerRoot,credentialScope:'standard',roots:[projects],cacheRoots:[usage]};
  for(const [n,pid,argv] of rows){const address='t'+n;raws.set(address,{address,created_ms:CREATED,foreground:{pid,argv},argv:['/bin/zsh'],cwd:'/fixture/repo'});agents.push({address,space:'space',tab:'tab-'+n,title:'Fixture agent '+n});}
  await fs.writeFile(home+'/mission-control/config.json',JSON.stringify({v:1,revision:0,connections:{},bindings:{},preferences:{},usageSources:{[JSON.stringify([null,'claude',providerRoot,'standard'])]:source}}));
  const code=(await Promise.all(['collector.py','provider_codex.py','provider_claude.py','provider_grok.py'].map(name=>fs.readFile('src/shared/'+name,'utf8')))).join('\n')+'\ncollector_main({"codex":collect_codex,"claude":collect_claude,"grok":collect_grok})\n';
  const api={appHome:()=>home,home:()=>root,agents:()=>agents,spaces:()=>[{id:'space',machine:null}],machines:()=>[{name:null,layout:'ready'}],knownAgents:async()=>[],
    readTextFile:async file=>{calls.push({read:file});if(file===home+'/mods/'+MOD+'/collector.py')return code;try{return await fs.readFile(file,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}},
    writeTextFile:async(file,text,expected)=>{let current=null;try{current=sync.readFileSync(file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}if(current!==expected)throw Object.assign(Error('stale'),{code:'STALE'});sync.writeFileSync(file,text);},
    exec:async(command,args,options={})=>{
      calls.push({command,args:command==='python3'?JSON.parse(args[2]):args});
      if(command==='mkdir'){await fs.mkdir(args[1],{recursive:true});return {code:0,stdout:''};}
      if(command==='hc'){if(args[0]==='ls')return {code:0,stdout:JSON.stringify({terminals:[...raws.values()]})};const raw=raws.get(args[1]);return {code:raw?0:1,stdout:raw?JSON.stringify(raw):''};}
      assert.equal(command,'python3');assert.equal(args[1],code);
      const child=spawnSync('python3',args,{encoding:'utf8',maxBuffer:1048576});assert.equal(child.status,0,child.stderr);return {code:0,stdout:child.stdout};
    }};
  const bridge=new TelemetryBridge(MOD,api,{clock:()=>now});t.after(()=>bridge.close());
  return {bridge,agents,calls,providerRoot,setTime:value=>now=value,now:()=>now};
}

test('a running Claude Code agent started outside Mission Control adopts its exact session from its own PID record',async t=>{
  const a=live(t),f=await fixture(t,{records:[{pid:a.pid,sessionId:OWN,startedAt:a.start,pidDomain:DOMAIN,kind:'interactive'}],agents:[[1,a.pid,['claude']]]});
  const readings=await f.bridge.refresh(),context=readings.get('t1').context;
  assert.equal(context.state,'available');assert.equal(context.remainingPercent,70,'used 30% of the context leaves 70%');
  const adopt=f.calls.find(c=>c.command==='python3'&&c.args.operation==='adopt');assert.deepEqual(adopt.args.pids,[{pid:a.pid,notBefore:CREATED}],'only the foreground process is asked about, with its terminal creation time');
  assert.ok(!f.calls.some(c=>c.read?.endsWith('.key')),'no key file is read by the bridge');
  f.setTime(f.now()+120001);await f.bridge.refresh();const later=f.bridge.reading(f.agents[0]).context;
  assert.equal(later.state,'stale');assert.equal(later.remainingPercent,70,'an idle agent keeps its last reported value, marked stale');
});

test('a leftover PID record from before the terminal existed is never adopted',async t=>{
  const a=live(t),f=await fixture(t,{records:[{pid:a.pid,sessionId:OWN,startedAt:CREATED-600000,pidDomain:DOMAIN,kind:'interactive'}],agents:[[1,a.pid,['claude']]]});
  const context=(await f.bridge.refresh()).get('t1').context;
  assert.equal(context.state,'unavailable');assert.match(context.reason,/No committed exact provider session binding/);
});

test('a client attached to a background job reads that job’s conversation, and only when exactly one live job matches',async t=>{
  const client=live(t),job=live(t),twin=live(t);
  const records=[{pid:client.pid,sessionId:OWN,startedAt:client.start,pidDomain:DOMAIN,kind:'interactive',parkedJobId:'aaaaaaaa'},{pid:job.pid,sessionId:JOB,startedAt:job.start,pidDomain:DOMAIN,kind:'bg'}];
  const one=await fixture(t,{records,agents:[[1,client.pid,['claude']]]});
  assert.equal((await one.bridge.refresh()).get('t1').context.remainingPercent,45,'the parked job’s 55% used, not the client’s own 30%');
  const two=await fixture(t,{records:[...records,{pid:twin.pid,sessionId:TWIN,startedAt:twin.start,pidDomain:DOMAIN,kind:'bg'}],agents:[[1,client.pid,['claude']]]});
  assert.equal((await two.bridge.refresh()).get('t1').context.state,'unavailable','two live jobs under one job ID adopt nothing');
});

test('an agent without a Claude Code record, such as Codex, stays unadopted',async t=>{
  const a=live(t),c=live(t),f=await fixture(t,{records:[{pid:a.pid,sessionId:OWN,startedAt:a.start,pidDomain:DOMAIN,kind:'interactive'}],agents:[[1,a.pid,['claude']],[2,c.pid,['codex']]]});
  const readings=await f.bridge.refresh();
  assert.equal(readings.get('t1').context.remainingPercent,70);assert.equal(readings.get('t2').context.state,'unavailable');
  assert.ok(f.calls.filter(x=>x.command==='python3'&&x.args.operation==='adopt').every(x=>x.args.pids.every(p=>p.pid!==c.pid)),'a Codex foreground process is never asked about');
});
