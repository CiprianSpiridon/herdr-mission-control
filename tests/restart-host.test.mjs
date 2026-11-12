import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {HOST_HELPER,hostFacts,hostClaim} from '../src/shared/restart-host.js';
import {HOOK_SCRIPT,START_TIME_PY} from '../src/shared/codex-session-hook.js';

const run=promisify(execFile);
const A='01a1b403-2509-7fa2-946f-c72be098fcae',B='01a1b4cc-c4d4-7980-970a-411ea9d001e7',C='9b0765f9-d49d-4198-9b67-4034011fd925';
const delay=ms=>new Promise(r=>setTimeout(r,ms));

function ioWith(env){
  return {exec:async(cmd,args,options={})=>{assert.equal(options.on??null,null);try{const r=await run(cmd,args,{env:{...process.env,...env},maxBuffer:4<<20});return {code:0,stdout:r.stdout,stderr:r.stderr};}catch(e){return {code:typeof e.code==='number'?e.code:1,stdout:e.stdout||'',stderr:e.stderr||''};}}};
}
async function tmp(t,prefix){const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),prefix)));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
/** A live "agent" (python holding a file open) with one child, started under a login-style name. */
async function live(t,{holds=[]}={}){
  const code=`import os,subprocess,sys,time\nfiles=[open(p,'a') for p in sys.argv[1:]]\nkid=subprocess.Popen(['/bin/sleep','60'])\nprint(kid.pid,flush=True)\ntime.sleep(60)\n`;
  const agent=spawn('python3',['-c',code,...holds],{stdio:['ignore','pipe','ignore']});t.after(()=>{try{process.kill(agent.pid,'SIGKILL');}catch{}});
  const child=await new Promise(resolve=>agent.stdout.once('data',d=>resolve(Number(String(d).trim()))));t.after(()=>{try{process.kill(child,'SIGKILL');}catch{}});
  const shell=spawn('/bin/sleep',['60'],{argv0:'-zsh',stdio:'ignore'});t.after(()=>{try{shell.kill('SIGKILL');}catch{}});
  await delay(300);return {agent:agent.pid,child,shell:shell.pid};
}
const utcStart=async pid=>(await run('ps',['-o','lstart=','-p',String(pid)],{env:{...process.env,TZ:'UTC',LC_ALL:'C'}})).stdout.trim();

test('macOS: process facts, children, a login shell name and agreement with the hook start routine', async t=>{
  const p=await live(t),io=ioWith({});
  const r=await hostFacts(io,{terminals:[{address:'t2j',shellPid:p.shell,foregroundPid:p.agent}]});
  assert.equal(r.ok,true);const f=r.terminals.get('t2j');
  assert.equal(f.shell.name,'zsh','leading - stripped from a login shell');assert.ok(f.shell.ageMs>=0&&f.shell.ageMs<60000,'age measured on the host');assert.equal(f.foreground.pid,p.agent);
  assert.deepEqual(f.children.map(c=>c.pid),[p.child]);assert.equal(f.children[0].name,'sleep');
  const hookStart=Number((await run('python3',['-c',HOOK_SCRIPT.split('\nimport json, os, re')[0]+'\nprint(mc_start_ms('+p.agent+'))'])).stdout.trim());
  assert.equal(f.foreground.startMs,hookStart,'hook and helper measure the same start');
  assert.equal(hookStart%1000,0);
});

test('Claude PID records: exact second, leftover records, startedAt fallback, wrong kind', async t=>{
  const p=await live(t),root=await tmp(t,'mc-claude-'),io=ioWith({});await fs.mkdir(path.join(root,'sessions'));
  const start=await utcStart(p.agent),startMs=Date.parse(start+' UTC');
  const write=async(pid,record)=>fs.writeFile(path.join(root,'sessions',pid+'.json'),JSON.stringify({pid,kind:'interactive',sessionId:A,...record}));
  const ask=async()=>(await hostFacts(io,{terminals:[{address:'t1',shellPid:p.shell,foregroundPid:p.agent}],claudeRoot:root})).terminals.get('t1').sessions.get(p.agent).claude;
  await write(p.agent,{procStart:start});assert.deepEqual({...await ask()},{sessionId:A,via:'pid-record'});
  await write(p.agent,{procStart:new Date(startMs-3600000).toUTCString()});assert.equal((await ask()).code,'PROCESS_MISMATCH','a leftover record from before this process');
  await write(p.agent,{procStart:'garbage',startedAt:startMs+1200});assert.equal((await ask()).sessionId,A,'unparseable procStart falls back to startedAt');
  await write(p.agent,{startedAt:startMs-60000});assert.equal((await ask()).code,'PROCESS_MISMATCH');
  await write(p.agent,{procStart:start,kind:'bg'});assert.equal((await ask()).code,'INVALID_RECORD');
  await fs.rm(path.join(root,'sessions',p.agent+'.json'));assert.equal((await ask()).code,'NO_RECORD');
});

test('Grok: the one events.jsonl a live process holds open, found with the real lsof', async t=>{
  const root=await tmp(t,'mc-grok-'),file=path.join(root,'sessions','%2FUsers%2Fme%2Frepo',A,'events.jsonl');await fs.mkdir(path.dirname(file),{recursive:true});
  const p=await live(t,{holds:[file]}),io=ioWith({});
  const r=await hostFacts(io,{terminals:[{address:'t3',shellPid:p.shell,foregroundPid:p.agent}],grokRoot:root});
  assert.deepEqual({...r.terminals.get('t3').sessions.get(p.agent).grok},{sessionId:A,via:'open-file'});
  assert.equal(r.terminals.get('t3').sessions.get(p.child).grok.code,'NO_SESSION','the child holds nothing');
});

test('Grok with a fake lsof: two sessions, subagent depth, outside the root, lsof missing', async t=>{
  const dir=await tmp(t,'mc-lsof-'),root=path.join(dir,'grok'),fake=path.join(dir,'lsof');await fs.mkdir(root);
  const p=await live(t);
  const answer=async lines=>{await fs.writeFile(fake,'#!/bin/sh\nprintf "p%s\\n" "$6"\n'+lines.map(l=>`printf '%s\\n' 'n${l}'`).join('\n')+'\n');await fs.chmod(fake,0o755);
    return (await hostFacts(ioWith({MC_RESTART_TEST_LSOF:fake}),{terminals:[{address:'t4',shellPid:p.shell,foregroundPid:p.agent}],grokRoot:root})).terminals.get('t4').sessions.get(p.agent).grok;};
  const at=(seg,id,rest='events.jsonl')=>`${root}/sessions/${seg}/${id}/${rest}`;
  assert.equal((await answer([at('x',A),at('x',A)])).sessionId,A,'the same file twice is one session');
  assert.equal((await answer([at('x',A),at('y',B)])).code,'AMBIGUOUS');
  assert.equal((await answer([at('x',A,`subagents/${B}/events.jsonl`)])).code,'NO_SESSION','subagent depth excluded');
  assert.equal((await answer([`${dir}/elsewhere/sessions/x/${A}/events.jsonl`])).code,'NO_SESSION');
  assert.equal((await answer([at('x','not-a-uuid-at-all-0000000000000000000')])).code,'NO_SESSION');
  const missing=(await hostFacts(ioWith({MC_RESTART_TEST_LSOF:path.join(dir,'none')}),{terminals:[{address:'t4',shellPid:p.shell,foregroundPid:p.agent}],grokRoot:root})).terminals.get('t4').sessions.get(p.agent).grok;
  assert.equal(missing.code,'UNAVAILABLE');
});

test('Linux /proc tree: start time, names, children, open files and Claude procStart at whole seconds', async t=>{
  const dir=await tmp(t,'mc-proc-'),proc=path.join(dir,'proc'),grok=path.join(dir,'grok'),claude=path.join(dir,'claude');
  const hz=Number((await run('python3',['-c','import os;print(os.sysconf("SC_CLK_TCK"))'])).stdout.trim()),btime=1794021241;
  await fs.mkdir(proc,{recursive:true});await fs.writeFile(path.join(proc,'stat'),`cpu 1\nbtime ${btime}\n`);
  const stat=(pid,name,ppid,ticks)=>`${pid} (${name}) S ${ppid} `+Array(17).fill('0').join(' ')+` ${ticks} 0 0\n`;
  const add=async(pid,name,ppid,ticks)=>{await fs.mkdir(path.join(proc,String(pid),'fd'),{recursive:true});await fs.writeFile(path.join(proc,String(pid),'stat'),stat(pid,name,ppid,ticks));};
  await add(100,'-bash',1,50*hz);await add(200,'sh',100,60*hz+37);await add(300,'grok',200,61*hz);await add(400,'claude',200,62*hz+5);
  const events=path.join(grok,'sessions','seg',B,'events.jsonl');await fs.mkdir(path.dirname(events),{recursive:true});await fs.writeFile(events,'');
  await fs.symlink(events,path.join(proc,'300','fd','7'));await fs.symlink('/dev/null',path.join(proc,'300','fd','0'));
  await fs.mkdir(path.join(claude,'sessions'),{recursive:true});
  const lstart=ms=>{const d=new Date(ms);return d.toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) (\S+) GMT$/,(_,w,day,mon,y,time)=>`${w} ${mon} ${day.padStart(2,' ')} ${time} ${y}`);};
  const claudeStart=(btime+62)*1000;
  await fs.writeFile(path.join(claude,'sessions','400.json'),JSON.stringify({pid:400,kind:'interactive',sessionId:C,procStart:lstart(claudeStart)}));
  const r=await hostFacts(ioWith({MC_RESTART_TEST_PROC:proc}),{terminals:[{address:'t9',shellPid:100,foregroundPid:200}],claudeRoot:claude,grokRoot:grok});
  const f=r.terminals.get('t9');
  assert.equal(f.shell.name,'bash');assert.equal(f.shell.startMs,(btime+50)*1000);assert.equal(f.foreground.startMs,(btime+60)*1000,'whole seconds');
  assert.deepEqual(f.children.map(c=>[c.pid,c.name]),[[300,'grok'],[400,'claude']]);
  assert.equal(f.sessions.get(300).grok.sessionId,B);assert.equal(f.sessions.get(400).claude.sessionId,C,'procStart matches at whole-second resolution though ticks carry a fraction');
  assert.equal(f.sessions.get(200).grok.code,'NO_SESSION');
});

test('claims are exclusive, keys are strict, and a failed call is never a claim', async t=>{
  const dir=await tmp(t,'mc-claims-'),io=ioWith({MC_RESTART_TEST_CLAIMS:path.join(dir,'claims')});
  const key='t2k-1833-1794021366000';
  assert.deepEqual([(await hostClaim(io,{key,owner:'a'})).claimed,(await hostClaim(io,{key,owner:'b'})).claimed],[true,false]);
  assert.equal((await hostClaim(io,{key:key+'-offer-3'})).claimed,true,'an offer resume has its own key');
  assert.equal((await hostClaim(io,{key:'../escape'})).code,'INVALID_KEY');
  const failed=await hostClaim({exec:async()=>({code:1,stdout:''})},{key});assert.equal(failed.ok,false);assert.equal(failed.claimed,undefined);
  const offline=await hostFacts({exec:async()=>{throw Error('offline');}},{terminals:[{address:'t1',shellPid:2,foregroundPid:3}]});assert.equal(offline.code,'HOST_UNAVAILABLE');
  const bogus=(await run('python3',['-c',HOST_HELPER,JSON.stringify({v:2,op:'facts'})])).stdout;assert.equal(JSON.parse(bogus).code,'INVALID_REQUEST');
  assert.ok(START_TIME_PY.includes('LC_ALL'));
});
