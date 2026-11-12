import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {HOOK_SCRIPT,HOOK_HELPER,START_TIME_PY,CODEX_LABEL,HOOK_FILE,parseCodexLabel,codexHook} from '../src/shared/codex-session-hook.js';

const run=promisify(execFile);
const SESSION='01a1b4ca-7e74-7951-98ac-7c31b3522699',OTHER='01a1b4cc-c4d4-7980-970a-411ea9d001e7';
const WRAP_LOCAL='"$@"; exec "$0" -li';

/** A disposable world: the real hook script, a fake hc on PATH, a fake Codex that runs the hook as Codex does. */
async function world(t){
  const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'mc-codex-hook-')));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const bin=path.join(dir,'bin');await fs.mkdir(bin);
  await fs.writeFile(path.join(dir,'hook.py'),HOOK_SCRIPT);
  await fs.writeFile(path.join(bin,'hc'),String.raw`#!/usr/bin/env python3
import json,os,sys
d=os.environ["FAKE_HC_DIR"]
if sys.argv[1:2]==["get"]:
    with open(os.path.join(d,"state.json")) as f: state=json.load(f)
    print(json.dumps({"address":sys.argv[2],"pid":state.get("terminalPid",1),"foreground":state["foreground"],"labels":{}}))
    sys.exit(0)
with open(os.path.join(d,"hc.log"),"a") as f: f.write(json.dumps(sys.argv[1:])+"\n")
`);await fs.chmod(path.join(bin,'hc'),0o755);
  // The fake Codex records itself as the terminal's foreground (or its wrapper's child), then runs the hook.
  await fs.writeFile(path.join(dir,'codex.py'),String.raw`import json,os,subprocess,sys,time
d=os.environ["FAKE_HC_DIR"];mode=sys.argv[1];event=sys.argv[2]
fg={"pid":os.getpid(),"argv":["codex"]}
if mode=="wrapped": fg={"pid":os.getppid(),"argv":["/bin/zsh","-lic",sys.argv[3],"/bin/zsh","python3"]}
if mode=="other-agent": fg={"pid":os.getppid(),"argv":["zsh"]}
with open(os.path.join(d,"state.json"),"w") as f: json.dump({"foreground":fg},f)
hook=os.path.join(d,"hook.py")
cmd={"direct":["python3",hook],"wrapped":["python3",hook],"other-agent":["python3",hook],"sh":["/bin/sh","-c","python3 '"+hook+"'; :"],"app-server":["python3",os.path.join(d,"middle.py"),"app-server",hook]}[mode]
started=time.monotonic()
p=subprocess.run(cmd,input=event.encode(),capture_output=True)
with open(os.path.join(d,"result.json"),"w") as f: json.dump({"code":p.returncode,"stdout":p.stdout.decode(),"stderr":p.stderr.decode(),"ms":int((time.monotonic()-started)*1000),"pid":os.getpid()},f)
`);
  await fs.writeFile(path.join(dir,'middle.py'),'import subprocess,sys\nsys.exit(subprocess.run(["python3",sys.argv[2]],stdin=sys.stdin).returncode)\n');
  const transcript=async(name,payload)=>{const file=path.join(dir,name);await fs.writeFile(file,JSON.stringify({timestamp:'2026-11-07T10:55:32Z',type:'session_meta',payload})+'\n{"type":"event"}\n');return file;};
  const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,FAKE_HC_DIR:dir,HC_TERMINAL_ID:'t2k'};
  const fire=async({mode='direct',event,terminal='t2k'}={})=>{
    await fs.rm(path.join(dir,'hc.log'),{force:true});
    const extra=mode==='wrapped'?[WRAP_LOCAL]:[];
    const args=mode==='wrapped'?['-c','"$@"; exec "$0" -c "exit 0"','/bin/sh','python3',path.join(dir,'codex.py'),mode,JSON.stringify(event),...extra]:[path.join(dir,'codex.py'),mode,JSON.stringify(event)];
    await run(mode==='wrapped'?'/bin/sh':'python3',args,{env:{...env,HC_TERMINAL_ID:terminal},cwd:dir});
    const result=JSON.parse(await fs.readFile(path.join(dir,'result.json'),'utf8'));
    let calls=[];try{calls=(await fs.readFile(path.join(dir,'hc.log'),'utf8')).trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));}catch{}
    return {result,calls};
  };
  return {dir,env,transcript,fire};
}
const startEvent=(transcript_path,extra={})=>({session_id:SESSION,transcript_path,cwd:'/repo',hook_event_name:'SessionStart',model:'gpt',permission_mode:'default',source:'startup',...extra});

test('labels the terminal with <pid>:<startMs>:<session> for a top-level Codex session with a large header', async t=>{
  const w=await world(t),file=await w.transcript('top.jsonl',{id:SESSION,session_id:SESSION,source:'cli',thread_source:'user',base_instructions:'x'.repeat(70000)});
  const {result,calls}=await w.fire({event:startEvent(file)});
  assert.equal(result.code,0);assert.equal(result.stdout,'');assert.ok(result.ms<4000,'exits within 4 s');
  assert.equal(calls.length,1);assert.equal(calls[0][0],'label');assert.equal(calls[0][1],'t2k');
  const [key,value]=calls[0][2].split('=');assert.equal(key,CODEX_LABEL);
  const label=parseCodexLabel(value);assert.equal(label.pid,result.pid);assert.equal(label.sessionId,SESSION);
  assert.ok(label.startMs%1000===0&&Math.abs(label.startMs-Date.now())<120000,'START_TIME_PY whole seconds for the live Codex');
});

test('follows a shell between Codex and the hook, and a Herdr wrapper in the foreground', async t=>{
  const w=await world(t),file=await w.transcript('top.jsonl',{id:SESSION,session_id:SESSION,source:'cli'});
  for(const mode of ['sh','wrapped']){const {result,calls}=await w.fire({mode,event:startEvent(file)});assert.equal(result.code,0,mode);assert.equal(calls.length,1,mode);assert.equal(parseCodexLabel(calls[0][2].split('=')[1]).pid,result.pid,mode);}
});

test('never labels when the evidence does not hold', async t=>{
  const w=await world(t);
  const top=await w.transcript('top.jsonl',{id:SESSION,session_id:SESSION,source:'cli'});
  const sub=await w.transcript('sub.jsonl',{id:OTHER,session_id:SESSION,parent_thread_id:SESSION,source:{subagent:{}}});
  const subSame=await w.transcript('sub2.jsonl',{id:SESSION,session_id:SESSION,parent_thread_id:OTHER});
  const huge=await w.transcript('huge.jsonl',{id:SESSION,session_id:SESSION,base_instructions:'y'.repeat(300000)});
  const cases=[
    ['non-UUID session',{event:startEvent(top,{session_id:'not-a-uuid'})}],
    ['another event',{event:startEvent(top,{hook_event_name:'Stop'})}],
    ['missing terminal',{event:startEvent(top),terminal:''}],
    ['bad terminal',{event:startEvent(top),terminal:'x;rm'}],
    ['subagent header',{event:startEvent(sub,{session_id:OTHER})}],
    ['header with a parent',{event:startEvent(subSame)}],
    ['header over 256 KiB',{event:startEvent(huge)}],
    ['missing transcript',{event:startEvent(path.join(w.dir,'none.jsonl'))}],
    ['agent not on the chain',{mode:'other-agent',event:startEvent(top)}],
    ['app-server between hook and Codex',{mode:'app-server',event:startEvent(top)}]
  ];
  for(const [name,c] of cases){const {result,calls}=await w.fire(c);assert.equal(result.code,0,name);assert.equal(result.stdout,'',name);assert.equal(calls.length,0,name);assert.ok(result.ms<4000,name);}
});

test('START_TIME_PY reads macOS lstart and a Linux /proc tree as whole seconds', async t=>{
  const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'mc-start-')));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const probe=START_TIME_PY+'\nimport os,sys\nprint(mc_start_ms(int(sys.argv[1])))\n';
  const live=Number((await run('python3',['-c',probe,String(process.pid)])).stdout.trim());
  assert.ok(Number.isSafeInteger(live)&&live%1000===0&&live<=Date.now()&&Date.now()-live<3600000*24,'live start of this test process');
  const proc=path.join(dir,'proc');await fs.mkdir(path.join(proc,'4242'),{recursive:true});
  await fs.writeFile(path.join(proc,'stat'),'cpu 1 2 3\nbtime 1794021241\n');
  const fields=['S',...Array(18).fill('0'),'12345','0'];await fs.writeFile(path.join(proc,'4242','stat'),'4242 (co dex) '+fields.join(' ')+'\n');
  const hz=Number((await run('python3',['-c','import os;print(os.sysconf("SC_CLK_TCK"))'])).stdout.trim());
  const linux=Number((await run('python3',['-c',probe,'4242'],{env:{...process.env,MC_RESTART_TEST_PROC:proc}})).stdout.trim());
  assert.equal(linux,(1794021241+Math.floor(12345/hz))*1000);
  const missing=(await run('python3',['-c',probe,'4243'],{env:{...process.env,MC_RESTART_TEST_PROC:proc}})).stdout.trim();
  assert.equal(missing,'None');
});

async function helper(home,op,{env={}}={}){
  const request=JSON.stringify({v:1,op,timeout:5,...(op==='remove'?{}:{script:HOOK_SCRIPT})});
  return JSON.parse((await run('python3',['-c',HOOK_HELPER,request],{env:{...process.env,CODEX_HOME:home,...env}})).stdout);
}
const HERDR=`{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "command": "bash '/Users/me/.codex/herdr-agent-state.sh' session",
            "timeout": 10,
            "type": "command"
          }
        ]
      }
    ]
  }
}
`;
async function codexHome(t,hooks,mode){
  const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'mc-codex-home-')));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  if(hooks!==undefined){await fs.writeFile(path.join(dir,'hooks.json'),hooks);if(mode)await fs.chmod(path.join(dir,'hooks.json'),mode);}
  return dir;
}
const groupsOf=async home=>JSON.parse(await fs.readFile(path.join(home,'hooks.json'),'utf8')).hooks.SessionStart;

test('install appends one group after the existing ones and keeps their bytes, mode and a backup', async t=>{
  const home=await codexHome(t,HERDR,0o600),before=HERDR;
  const r=await helper(home,'install');assert.equal(r.ok,true);assert.equal(r.changed,true);assert.equal(r.index,1);
  const text=await fs.readFile(path.join(home,'hooks.json'),'utf8'),firstEnd=before.indexOf('      }\n    ]')+7;
  assert.equal(text.slice(0,firstEnd),before.slice(0,firstEnd),'the earlier group is byte-identical');
  const groups=await groupsOf(home);assert.equal(groups.length,2);assert.deepEqual(groups[0],JSON.parse(before).hooks.SessionStart[0]);
  assert.equal(groups[1].hooks[0].command,`python3 '${path.join(home,HOOK_FILE)}'`);
  assert.equal((await fs.stat(path.join(home,'hooks.json'))).mode&0o777,0o600);
  assert.equal(await fs.readFile(path.join(home,HOOK_FILE),'utf8'),HOOK_SCRIPT);
  assert.equal(await fs.readFile(r.backup,'utf8'),before);
  const again=await helper(home,'install');assert.equal(again.changed,false);assert.equal(await fs.readFile(path.join(home,'hooks.json'),'utf8'),text,'idempotent');
  const status=await helper(home,'status');assert.deepEqual([status.installed,status.index,status.script,status.current],[true,1,true,true]);
});

test('install creates the file, the hooks key or SessionStart, and leaves following keys alone', async t=>{
  const fresh=await codexHome(t);assert.equal((await helper(fresh,'install')).index,0);assert.equal((await groupsOf(fresh)).length,1);
  const following=await codexHome(t,'{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"a"}]}],"Stop":[{"hooks":[{"type":"command","command":"b"}]}]},"x":1}');
  assert.equal((await helper(following,'install')).index,1);const v=JSON.parse(await fs.readFile(path.join(following,'hooks.json'),'utf8'));
  assert.equal(v.hooks.SessionStart.length,2);assert.deepEqual(v.hooks.Stop,[{hooks:[{type:'command',command:'b'}]}]);assert.equal(v.x,1);
  const noStart=await codexHome(t,'{"hooks":{"Stop":[]}}');assert.equal((await helper(noStart,'install')).index,0);assert.equal((await groupsOf(noStart)).length,1);
  const noHooks=await codexHome(t,'{"other":true}');assert.equal((await helper(noHooks,'install')).index,0);assert.equal(JSON.parse(await fs.readFile(path.join(noHooks,'hooks.json'),'utf8')).other,true);
});

test('install refuses symlinks, invalid files and a missing Codex home', async t=>{
  const home=await codexHome(t),target=path.join(home,'real.json');await fs.writeFile(target,HERDR);await fs.symlink(target,path.join(home,'hooks.json'));
  assert.equal((await helper(home,'install')).code,'SYMLINK');assert.equal(await fs.readFile(target,'utf8'),HERDR);
  const bad=await codexHome(t,'{"hooks":');assert.equal((await helper(bad,'install')).code,'INVALID_HOOKS');assert.equal(await fs.readFile(path.join(bad,'hooks.json'),'utf8'),'{"hooks":');
  assert.equal((await helper(path.join(home,'missing'),'install')).code,'NO_CODEX');
});

test('remove deletes only its own group and script and reports groups whose trust key shifts', async t=>{
  const home=await codexHome(t,HERDR);await helper(home,'install');
  const r=await helper(home,'remove');assert.equal(r.ok,true);assert.equal(r.laterGroups,0);
  assert.deepEqual(await groupsOf(home),JSON.parse(HERDR).hooks.SessionStart);
  await assert.rejects(fs.stat(path.join(home,HOOK_FILE)));
  await helper(home,'install');const text=await fs.readFile(path.join(home,'hooks.json'),'utf8');
  await fs.writeFile(path.join(home,'hooks.json'),text.replace(/\]\s*\}\s*\}\s*$/,', {"hooks":[{"type":"command","command":"later"}]}]}}\n'));
  const later=await helper(home,'remove');assert.equal(later.laterGroups,1);
  const left=await groupsOf(home);assert.equal(left.length,2);assert.equal(left[1].hooks[0].command,'later');
});

test('parseCodexLabel and codexHook keep to exact values and never throw', async t=>{
  assert.deepEqual({...parseCodexLabel(`97160:1794034532000:${SESSION}`)},{pid:97160,startMs:1794034532000,sessionId:SESSION});
  for(const v of ['',`0:1:${SESSION}`,`1:x:${SESSION}`,'1:1:not-a-uuid',null,`1:1:${SESSION}:extra`])assert.equal(parseCodexLabel(v),null);
  const home=await codexHome(t,HERDR);
  const io={exec:async(cmd,args,options)=>{assert.equal(options.on,null);try{const r=await run(cmd,args,{env:{...process.env,CODEX_HOME:home}});return {code:0,stdout:r.stdout,stderr:r.stderr};}catch(e){return {code:e.code||1,stdout:e.stdout||'',stderr:e.stderr||''};}}};
  const status=await codexHook(io,'status');assert.equal(status.ok,true);assert.equal(status.installed,false);
  const failed=await codexHook({exec:async()=>{throw Error('offline');}},'status',{machine:'qa-server'});assert.equal(failed.code,'HOST_UNAVAILABLE');
  assert.equal((await codexHook(io,'delete')).code,'INVALID_REQUEST');
});
