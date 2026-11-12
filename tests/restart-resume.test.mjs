import test from 'node:test';
import assert from 'node:assert/strict';
import {RESTART,RunningAgents,emptyJournal,validateJournal,observeMachine,decide,markSending,markOutcome,dismiss,offers,claimKey,resumeLine,cdPrefix,resumePreference,argvSession,providerOf,agentProcess,fallbackArgv,takeLease,releaseLease,machineKey} from '../src/shared/restart-resume.js';
import {buildArguments,parseCapabilities} from '../src/shared/tool-capabilities.js';

const A='01a1b403-2509-7fa2-946f-c72be098fcae',B='9b0765f9-d49d-4198-9b67-4034011fd925',C='01a1b4cc-c4d4-7980-970a-411ea9d001e7';
const T0=1794020000000;
function memoryIO(){
  const files=new Map(),writes=[];
  return {files,writes,appHome:()=>'/home/app',ensureDirectory:async()=>{},readTextFile:async f=>files.has(f)?files.get(f):null,
    async writeTextFile(f,t,expected){const cur=files.has(f)?files.get(f):null;if(cur!==(expected??null))throw Object.assign(Error('stale'),{code:'STALE'});files.set(f,t);writes.push(f);}};
}
const agent=(pid,start,sessionId=A,provider='claude')=>({pid,startMs:start,provider,toolKey:provider,sessionId,via:'pid-record'});
const term=(over={})=>({createdMs:1000,spaceId:'sp1',tabId:'tb1',shellPid:500,shellStartMs:T0-3600000,foregroundIsShell:false,cwd:'/repo',agent:agent(600,T0-1800000),...over});
const obs=(terminals,{ok=true,machine=null,live}={})=>({machine,ok,at:0,live:live??new Set(Object.keys(terminals)),terminals:new Map(Object.entries(terminals))});
const tracked=(draft)=>{observeMachine(draft,obs({t1:term()}),{owner:'r1',now:T0});return draft.machines.local.terminals.t1;};

test('records a running agent, follows /clear, and removes it when the person quits', ()=>{
  const d=emptyJournal(),e=tracked(d);
  assert.deepEqual([e.state,e.sessionId,e.via,e.shellPid,e.agentPid],['tracking',A,'pid-record',500,600]);
  observeMachine(d,obs({t1:term({agent:{...agent(600,T0-1800000),sessionId:B}})}),{owner:'r1',now:T0+5000});
  assert.equal(d.machines.local.terminals.t1.sessionId,B,'a new session in the same process is followed');
  const out=observeMachine(d,obs({t1:term({agent:null,foregroundIsShell:true})}),{owner:'r1',now:T0+10000});
  assert.deepEqual(out.removed,[{address:'t1',why:'quit'}]);assert.equal(d.machines.local.terminals.t1,undefined);
  tracked(d);observeMachine(d,obs({},{live:new Set()}),{owner:'r1',now:T0+20000});assert.equal(d.machines.local.terminals.t1,undefined,'closed terminal');
  tracked(d);observeMachine(d,obs({t1:term({agent:agent(601,T0-1000)})}),{owner:'r1',now:T0+30000});
  assert.equal(d.machines.local.terminals.t1.agentPid,601,'another agent in the same shell replaces the quit one');
});

test('a reboot marks exactly the recorded entries lost, also for a fresh observer reading the journal', async ()=>{
  const io=memoryIO(),journal=new RunningAgents(io,{clock:()=>T0});
  await journal.edit((d,now)=>{observeMachine(d,obs({t1:term(),t2:term({shellPid:510,agent:agent(610,T0-100,C,'codex')}),t3:term({shellPid:520,agent:null,foregroundIsShell:true})}),{owner:'old',now});});
  const fresh=new RunningAgents(io,{clock:()=>T0+600000});
  const {result}=await fresh.edit((d,now)=>observeMachine(d,obs({t1:term({shellPid:900,shellStartMs:T0+500000,agent:null,foregroundIsShell:true}),t2:term({shellPid:910,shellStartMs:T0+500000,agent:null,foregroundIsShell:true}),t3:term({shellPid:920,shellStartMs:T0+500000,agent:null,foregroundIsShell:true})}),{owner:'new',now}));
  assert.deepEqual(result.lost.sort(),['t1','t2']);
  const {value}=await fresh.read();
  for(const a of ['t1','t2']){const e=value.machines.local.terminals[a];assert.equal(e.state,'lost');assert.equal(e.lostBy,'new');}
  assert.equal(value.machines.local.terminals.t1.shellPid,900,'rebased to the restored shell');
  assert.equal(value.machines.local.terminals.t3,undefined,'a shell with no agent is never recorded');
});

test('an offline host or missing facts change nothing', ()=>{
  const d=emptyJournal();tracked(d);const before=JSON.stringify(d);
  observeMachine(d,obs({},{ok:false,live:new Set()}),{owner:'r',now:T0+1000});assert.equal(JSON.stringify(d),before);
  observeMachine(d,obs({},{live:new Set(['t1'])}),{owner:'r',now:T0+1000});assert.equal(d.machines.local.terminals.t1.state,'tracking','live but without facts is unknown, not quit');
});

const ready=(over={})=>({preference:{on:true},tool:{argv:['claude','--resume',A]},now:T0+600000,...over,t:{foregroundIsShell:true,shellName:'zsh',cwd:'/repo',shellAgeMs:30000,...(over.t||{})}});
test('each type-now condition yields an offer or a skip with its reason', ()=>{
  const e={provider:'claude',sessionId:A,cwd:'/repo',seenAt:T0+590000};
  assert.deepEqual(decide(e,ready()),{type:'type',reason:null,line:'claude --resume '+A});
  const cases=[
    [{preference:{on:false,reason:'Resume after restart is turned off.'}},'skip',/turned off/],
    [{tool:{argv:null,reason:'claude is not installed on this machine.'}},'offer',/not installed/],
    [{t:{foregroundIsShell:false}},'offer',/running something else/],
    [{t:{shellName:'nu'}},'offer',/not a POSIX shell/],
    [{t:{cwd:'/elsewhere'}},'offer',/another folder/],
    [{t:{shellAgeMs:16*60000}},'offer',/more than 15 minutes/],
    [{t:{shellAgeMs:null}},'offer',/age is unknown/]
  ];
  for(const [over,type,reason]of cases){const r=decide(e,ready(over));assert.equal(r.type,type,String(reason));assert.match(r.reason,reason);}
  assert.equal(decide(e,ready({t:{cwd:'/elsewhere'}})).line,"cd /repo && claude --resume "+A);
  for(const hours of [1,8,24,168]){
    const afterBatteryLoss=decide({...e,seenAt:T0-hours*3600000},ready());
    assert.equal(afterBatteryLoss.type,'type',`a fresh restored shell resumes after ${hours} hours powered off`);
    assert.equal(decide({...e,seenAt:T0-hours*3600000},ready({t:{shellAgeMs:16*60000}})).type,'offer','powered-off time does not bypass the restored-shell age limit');
  }
  assert.equal(decide({...e,provider:'codex'},ready({tool:{argv:null}})).line,'codex resume '+A,'the default form when capabilities are unknown');
  assert.equal(decide(e,ready({t:{shellName:'-zsh'}})).type,'type','login shell name');
});

test('after a pass every lost entry has one outcome; a later restart of an untyped entry types nothing', ()=>{
  const d=emptyJournal();tracked(d);
  observeMachine(d,obs({t1:term({shellPid:900,shellStartMs:T0+500000,agent:null,foregroundIsShell:true})}),{owner:'r',now:T0+600000});
  assert.equal(markOutcome(d,{machine:null,address:'t1',state:'offered',reason:'x',line:'claude --resume '+A,passId:'p1',now:T0+600001}),true);
  assert.equal(offers(d).length,1);
  const out=observeMachine(d,obs({t1:term({shellPid:950,shellStartMs:T0+900000,agent:null,foregroundIsShell:true})}),{owner:'r',now:T0+900000});
  assert.deepEqual(out.lost,[]);assert.deepEqual(out.removed,[{address:'t1',why:'restarted-again'}]);
  tracked(d);observeMachine(d,obs({t1:term({shellPid:900,shellStartMs:T0+500000,agent:null,foregroundIsShell:true})}),{owner:'r',now:T0+600000});
  observeMachine(d,obs({t1:term({shellPid:960,shellStartMs:T0+700000,agent:null,foregroundIsShell:true})}),{owner:'r2',now:T0+700000});
  assert.equal(d.machines.local.terminals.t1.shellPid,960,'an unhandled loss follows the newest shell');assert.equal(d.machines.local.terminals.t1.lostBy,'r2');
});

test('sending, sent, stale sends, offers and dismissals', ()=>{
  const d=emptyJournal();tracked(d);const lost={t1:term({shellPid:900,shellStartMs:T0+500000,agent:null,foregroundIsShell:true})};
  observeMachine(d,obs(lost),{owner:'r',now:T0+600000});const e=d.machines.local.terminals.t1;
  const key=claimKey('t1',e);assert.equal(key,`t1-900-${T0+500000}`);assert.equal(claimKey('t1',e,{offer:7}),`t1-900-${T0+500000}-offer-7`);
  assert.equal(markSending(d,{machine:null,address:'t1',passId:'p',claim:key,line:'l',now:T0+600001}),true);
  assert.equal(markSending(d,{machine:null,address:'t1',passId:'p2',claim:key,line:'l',now:T0+600002}),false,'a second sender loses');
  observeMachine(d,obs(lost),{owner:'r',now:T0+600000+RESTART.sendingStaleMs+1});assert.equal(d.machines.local.terminals.t1.state,'offered','a stale send becomes an offer');
  assert.equal(markSending(d,{machine:null,address:'t1',passId:'p3',claim:key+'-offer-1',line:'l',expect:['offered'],now:T0+700000}),true,'resume from an offer');
  markOutcome(d,{machine:null,address:'t1',state:'sent',now:T0+700001});
  observeMachine(d,obs({t1:{...lost.t1,foregroundIsShell:false,agent:agent(990,T0+700002,A)}}),{owner:'r',now:T0+701000});
  assert.equal(d.machines.local.terminals.t1.state,'tracking','the resumed agent is tracked again');assert.equal(d.machines.local.terminals.t1.lostBy,undefined);
  const d2=emptyJournal();tracked(d2);observeMachine(d2,obs(lost),{owner:'r',now:T0+600000});markOutcome(d2,{machine:null,address:'t1',state:'sent',now:T0+600001});
  observeMachine(d2,obs(lost),{owner:'r',now:T0+600001+RESTART.graceMs});assert.equal(d2.machines.local.terminals.t1,undefined,'a resume that never showed its agent ends');
  const d3=emptyJournal();tracked(d3);observeMachine(d3,obs(lost),{owner:'r',now:T0+600000});markOutcome(d3,{machine:null,address:'t1',state:'offered',now:T0+600000});
  observeMachine(d3,obs({t1:{...lost.t1,foregroundIsShell:false}}),{owner:'r',now:T0+600500});assert.equal(d3.machines.local.terminals.t1,undefined,'an offer ends when the shell runs something else');
  const d4=emptyJournal();tracked(d4);observeMachine(d4,obs(lost),{owner:'r',now:T0+600000});markOutcome(d4,{machine:null,address:'t1',state:'offered',now:T0+600000});
  assert.deepEqual(dismiss(d4,{machine:null,address:'t1'}),{});assert.equal(offers(d4).length,0);
});

test('racing writers produce one sending; corrupt journals are kept aside; newer ones are left alone', async ()=>{
  const io=memoryIO(),a=new RunningAgents(io,{clock:()=>T0}),b=new RunningAgents(io,{clock:()=>T0});
  await a.edit((d,now)=>{observeMachine(d,obs({t1:term()}),{owner:'a',now});observeMachine(d,obs({t1:term({shellPid:900,shellStartMs:T0+1,agent:null,foregroundIsShell:true})}),{owner:'a',now:now+1});});
  const send=j=>j.edit((d,now)=>({sent:markSending(d,{machine:null,address:'t1',passId:'p',claim:'k',line:'l',now})}));
  const results=await Promise.all([send(a),send(b)]);assert.deepEqual(results.map(r=>r.result.sent).sort(),[false,true]);
  io.files.set(a.path,'{not json');await a.edit(()=>({}));
  assert.ok([...io.files.keys()].some(f=>f.startsWith(a.path+'.invalid-')),'kept aside');assert.equal((await a.read()).status,'ok');
  io.files.set(a.path,JSON.stringify({v:2,revision:9}));
  await assert.rejects(a.edit(()=>({})),/newer Mission Control/);assert.equal(io.files.get(a.path),JSON.stringify({v:2,revision:9}),'untouched');
  assert.throws(()=>validateJournal({...emptyJournal(),machines:{local:{observedAt:0,terminals:{bad:{}}}}}));
});

test('the journal stays within its size and entry limits', async ()=>{
  const io=memoryIO(),j=new RunningAgents(io,{clock:()=>T0});
  await j.edit((d,now)=>{const many={};for(let i=0;i<RESTART.entriesPerMachine+20;i++)many['t'+i.toString(36)]=term({shellPid:1000+i,cwd:'/'+'x'.repeat(1500),agent:agent(5000+i,T0-1)});observeMachine(d,obs(many),{owner:'r',now});});
  const {value}=await j.read();assert.equal(Object.keys(value.machines.local.terminals).length<=RESTART.entriesPerMachine,true);
  assert.ok(io.files.get(j.path).length<=RESTART.bytes+1);
});

test('lease, preference, argv, provider, wrapper and quoting rules', ()=>{
  const d=emptyJournal();assert.equal(takeLease(d,'a',T0),true);assert.equal(takeLease(d,'b',T0+1),false);assert.deepEqual(releaseLease(d,'b'),{write:false});releaseLease(d,'a');assert.equal(takeLease(d,'b',T0+2),true);
  assert.deepEqual({...resumePreference({preferences:{}})},{on:true,reason:null});assert.equal(resumePreference({preferences:{resumeAfterRestart:false}}).on,false);
  const odd=resumePreference({preferences:{resumeAfterRestart:'yes'}});assert.equal(odd.on,false);assert.match(odd.reason,/not true or false/);
  assert.equal(argvSession(['claude','--resume',A]).sessionId,A);assert.equal(argvSession(['/opt/codex','--no-daemon','resume',C]).provider,'codex');
  assert.equal(argvSession(['grok-1.0.70-macos-aarch64','--resume='+A]).provider,'grok');
  assert.equal(argvSession(['claude','--resume','00000000-0000-0000-0000-000000000000']),null,'buildArguments rejects version 0, so do we');
  assert.equal(argvSession(['zsh','-l']),null);assert.equal(argvSession(['codex','resume','--last']),null);
  assert.equal(providerOf({programKey:'claude'}),'claude');assert.equal(providerOf({app:'grok-build'}),'grok');assert.equal(providerOf({name:'2.1.317',argv:['claude']}),'claude');assert.equal(providerOf({name:'zsh'}),null);
  const wrapper={pid:700,argv:['sh','-c','"$@"; exec "${SHELL:-sh}" -i','sh','codex']};
  assert.equal(agentProcess(wrapper,[{pid:701}]).pid,701);assert.equal(agentProcess(wrapper,[{pid:701},{pid:702}]),null);assert.equal(agentProcess({pid:800,argv:['claude']},[{pid:801}]).pid,800);
  assert.equal(resumeLine(['claude','--resume',A]),'claude --resume '+A);
  assert.equal(resumeLine(["/Users/o'k/my tools/claude",'--resume',A]),"'/Users/o'\\''k/my tools/claude' --resume "+A);
  assert.throws(()=>resumeLine(['a\nb']));assert.equal(cdPrefix('/a b'),"cd '/a b' && ");
  const caps=parseCapabilities({key:'codex',name:'Codex',run:['codex'],installed:true},{help:'Codex CLI\n --no-daemon  x\n',resumeHelp:'Usage: codex resume [OPTIONS] [SESSION_ID] [PROMPT]'});
  assert.equal(resumeLine(buildArguments(caps,{resumeSessionId:C})),'codex --no-daemon resume '+C);
  assert.deepEqual(fallbackArgv('grok',A),['grok','--resume',A]);assert.equal(machineKey(null),'local');assert.throws(()=>machineKey('local'));
});
