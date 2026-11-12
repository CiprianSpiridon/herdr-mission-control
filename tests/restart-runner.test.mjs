import test from 'node:test';
import assert from 'node:assert/strict';
import {RestartRunner,RUNNER} from '../src/shared/restart-runner.js';
import {RunningAgents,RESTART,RESTART_STATE_KEY} from '../src/shared/restart-resume.js';
import {HOST_HELPER} from '../src/shared/restart-host.js';
import {HOOK_HELPER,CODEX_LABEL} from '../src/shared/codex-session-hook.js';

const CL='9b0765f9-d49d-4198-9b67-4034011fd925',CX='01a1b4cc-c4d4-7980-970a-411ea9d001e7',GK='01a1b403-2509-7fa2-946f-c72be098fcae',RM='59998f5e-7b3f-46cf-a194-998f1e9d683b';
const T0=1794020000000,REMOTE='qa-server';
const WRAP_REMOTE='"$@"; exec "${SHELL:-sh}" -i';
const HELP={claude:'Claude Code\nUsage: claude [options] [prompt]\n --resume [value]\n --session-id <uuid>\n',codex:'Codex CLI\n --no-daemon  x\n',grok:'Grok Build TUI\n --resume <id>\n'};

/** Two machines, their core terminals and processes; the host helper and hc are answered from this model. */
function makeWorld(){
  const hosts={local:{terminals:{},procs:{},claude:{},grok:{},claims:new Set()},[REMOTE]:{terminals:{},procs:{},claude:{},grok:{},claims:new Set()}};
  const w={hosts,spaces:[{id:'sp1',machine:null,tabs:[{id:'tb1'},{id:'tb2'},{id:'tb3'}]},{id:`${REMOTE}/sp9`,machine:REMOTE,tabs:[{id:`${REMOTE}/tb9`}]}],agents:[],panes:[],ready:{local:true,[REMOTE]:true},
    sends:[],labels:[],failSend:false,changeForegroundOnRecheck:false,helperDown:false,gets:new Map()};
  w.proc=(host,pid,{name,ppid=1,startMs=T0-3600000,ageMs=3600000}={})=>{hosts[host].procs[pid]={pid,ppid,name,startMs,ageMs};};
  /** An agent terminal: shell process pid, agent pid (foreground or the wrapper's child), its session evidence. */
  w.agent=(host,address,{tab,space,shell,agent,provider,session,wrapped=false,cwd='/repo'})=>{
    w.proc(host,shell,{name:wrapped?'sh':'zsh'});w.proc(host,agent,{name:provider==='claude'?'2.1.317':provider==='grok'?'grok-1.0.70-macos-aarch64':'codex',ppid:shell,startMs:T0-1800000});
    const fg=wrapped?{pid:shell,argv:['sh','-c',WRAP_REMOTE,'sh',provider],cwd,name:'sh'}:{pid:agent,argv:[provider],cwd,name:provider};
    const labels={'herdr.space':space,'herdr.tab':tab};
    if(provider==='codex')labels[CODEX_LABEL]=`${agent}:${T0-1800000}:${session}`;
    if(provider==='claude')hosts[host].claude[agent]=session;if(provider==='grok')hosts[host].grok[agent]=session;
    hosts[host].terminals[address]={address,pid:shell,created_ms:1000,labels,foreground:fg,cwd,state:'live'};
    const qualified=host==='local'?address:`${host}/${address}`,qtab=host==='local'?tab:`${host}/${tab}`;
    w.panes.push({pane:'p-'+qualified,terminal:qualified,tab:qtab,program:{key:provider,agent:true},status:'idle'});
    w.agents.push({address:qualified,space:host==='local'?space:`${host}/${space}`,app:provider==='claude'?'claude-code':provider,program:{key:provider},status:'idle'});
  };
  /** Every terminal's own process is lost: shells come back at the same addresses; agents() forgets them. */
  w.reboot=({at=T0+600000}={})=>{
    w.agents=[];w.panes=w.panes.map(p=>({...p,program:{key:'zsh',agent:false},status:null}));
    for(const [host,h]of Object.entries(hosts))for(const t of Object.values(h.terminals)){const pid=t.pid+5000;w.proc(host,pid,{name:'zsh',startMs:at-20000,ageMs:20000});
      const labels={...t.labels};Object.assign(t,{pid,foreground:{pid,argv:['/bin/zsh','-l'],cwd:t.cwd,name:'zsh'},labels});}
  };
  return w;
}
function makeIO(w,{home='/app',files=new Map(),capabilities}={}){
  const effects={notify:[],exec:[]};let shared={};
  const hostOf=on=>on??'local';
  const io={files,effects,appHome:()=>home,ensureDirectory:async()=>{},
    machines:()=>[{name:null,layout:w.ready.local?'ready':'loading'},{name:REMOTE,layout:w.ready[REMOTE]?'ready':'loading'}],
    spaces:()=>w.spaces,agents:()=>w.agents,panes:()=>w.panes,terminals:()=>[],
    shared:key=>shared[key],setShared:(key,value)=>{shared[key]=value;},notify:n=>{effects.notify.push(n);return 'n'+effects.notify.length;},
    knownAgents:async()=>['claude','codex','grok'].map(key=>({key,name:key,run:[key],installed:true})),
    sessionSource:async()=>null,
    readTextFile:async f=>files.has(f)?files.get(f):null,
    writeTextFile:async(f,t,expected)=>{const cur=files.has(f)?files.get(f):null;if(cur!==(expected??null))throw Object.assign(Error('stale'),{code:'STALE'});files.set(f,t);},
    exec:async(cmd,args,options={})=>{
      const on=options.on??null,h=w.hosts[hostOf(on)];effects.exec.push([cmd,args[0],on]);
      if(!w.ready[hostOf(on)])throw Error('offline');
      if(cmd==='python3'&&args[1]===HOST_HELPER){
        if(w.helperDown)return {code:1,stdout:''};const q=JSON.parse(args[2]);
        if(q.op==='claim'){if(h.claims.has(q.key))return {code:0,stdout:JSON.stringify({v:1,ok:true,claimed:false})};h.claims.add(q.key);return {code:0,stdout:JSON.stringify({v:1,ok:true,claimed:true})};}
        const info=pid=>h.procs[pid]?{...h.procs[pid]}:null,found=(map,pid)=>map[pid]?{sessionId:map[pid],via:map===h.grok?'open-file':'pid-record'}:{code:'NO_RECORD'};
        return {code:0,stdout:JSON.stringify({v:1,ok:true,terminals:q.terminals.map(t=>{const fg=info(t.foregroundPid),kids=fg?Object.values(h.procs).filter(p=>p.ppid===fg.pid).map(p=>({...p})):[];
          return {address:t.address,shell:info(t.shellPid),foreground:fg,children:kids,sessions:[fg,...kids].filter(Boolean).map(p=>({pid:p.pid,claude:found(h.claude,p.pid),grok:found(h.grok,p.pid)}))};})})};
      }
      if(cmd==='python3'&&args[1]===HOOK_HELPER)return {code:0,stdout:JSON.stringify({ok:true,installed:false,codexHome:'/home/me/.codex'})};
      if(cmd==='hc'&&args[0]==='get'){const t=h.terminals[args[1]];if(!t)return {code:1,stdout:''};const n=(w.gets.get(args[1])||0)+1;w.gets.set(args[1],n);
        let raw=JSON.parse(JSON.stringify(t));if(w.changeForegroundOnRecheck&&w.sends.length===0&&raw.foreground.pid===raw.pid&&w.recheck===args[1])raw.foreground={...raw.foreground,pid:raw.pid+1};return {code:0,stdout:JSON.stringify(raw)};}
      if(cmd==='hc'&&args[0]==='ls')return {code:0,stdout:JSON.stringify({terminals:Object.values(h.terminals).map(t=>({address:on?`${on}/${t.address}`:t.address,state:'live'}))})};
      if(cmd==='hc'&&args[0]==='label'){w.labels.push([on,...args.slice(1)]);const [k,v]=args[2].split('=');if(!v)delete h.terminals[args[1]].labels[k];return {code:0,stdout:''};}
      if(cmd==='hc'&&args[0]==='send'){if(w.failSend)return {code:1,stdout:''};w.sends.push([on,args[1],args[2]]);return {code:0,stdout:''};}
      const tool=['claude','codex','grok'].find(k=>cmd===k);
      if(tool){if(args[0]==='--help')return {code:0,stdout:HELP[tool]};if(args[0]==='--version')return {code:0,stdout:'1.0'};if(tool==='codex'&&args[0]==='resume')return {code:0,stdout:'Usage: codex resume [OPTIONS] [SESSION_ID] [PROMPT]'};}
      throw Error('Unexpected exec '+cmd+' '+args[0]);
    }};
  if(capabilities)io.capabilities=capabilities;
  return io;
}
function populate(w){
  w.agent('local','t1',{space:'sp1',tab:'tb1',shell:500,agent:600,provider:'claude',session:CL});
  w.agent('local','t2',{space:'sp1',tab:'tb2',shell:510,agent:610,provider:'codex',session:CX});
  w.agent('local','t3',{space:'sp1',tab:'tb3',shell:520,agent:620,provider:'grok',session:GK});
  w.agent(REMOTE,'t9',{space:'sp9',tab:'tb9',shell:700,agent:710,provider:'claude',session:RM,wrapped:true});
}
async function ticks(runner,n){for(let i=0;i<n;i++)await runner.tick();}
const clockAt=start=>{let now=start;const c=()=>now;c.advance=ms=>{now+=ms;};return c;};

test('records every agent with its exact session, including a remote wrapper\'s child', async ()=>{
  const w=makeWorld();populate(w);const io=makeIO(w),clock=clockAt(T0),r=new RestartRunner(io,{owner:'a',clock});
  await ticks(r,2);const {value}=await new RunningAgents(io).read();
  const local=value.machines.local.terminals,remote=value.machines[REMOTE].terminals;
  assert.deepEqual([local.t1.sessionId,local.t1.via],[CL,'pid-record']);assert.deepEqual([local.t2.sessionId,local.t2.via],[CX,'codex-hook']);
  assert.deepEqual([local.t3.sessionId,local.t3.via],[GK,'open-file']);assert.deepEqual([remote.t9.sessionId,remote.t9.agentPid],[RM,710],'the wrapper child is the agent');
  assert.equal(remote.t9.tabId,`${REMOTE}/tb9`);
});

test('a fresh runner after eight hours powered off types one exact resume per lost terminal, on its own machine', async ()=>{
  const w=makeWorld();populate(w);const files=new Map(),clock=clockAt(T0);
  const before=new RestartRunner(makeIO(w,{files}),{owner:'before',clock});await ticks(before,2);await before.release();
  w.reboot({at:T0+8*3600000});clock.advance(8*3600000);
  const io=makeIO(w,{files}),fresh=new RestartRunner(io,{owner:'fresh',clock});
  for(let i=0;i<3;i++){await fresh.tick();clock.advance(1000);}const lost=(await new RunningAgents(io).read()).value;
  for(const e of [...Object.values(lost.machines.local.terminals),...Object.values(lost.machines[REMOTE].terminals)]){assert.ok(['lost','sending','sent'].includes(e.state),e.state);assert.equal(e.lostBy,'fresh','the fresh copy found the loss from the journal');}
  assert.ok(w.labels.some(([on,a,v])=>on===null&&a==='t2'&&v===CODEX_LABEL+'='),'the stale Codex label is cleared');
  clock.advance(RUNNER.tickMs);await ticks(fresh,3);
  const sends=w.sends.map(([on,a,line])=>[on,a,line]).sort((x,y)=>String(x[0]).localeCompare(String(y[0]))||x[1].localeCompare(y[1]));
  assert.deepEqual(sends,[[null,'t1','claude --resume '+CL],[null,'t2','codex --no-daemon resume '+CX],[null,'t3','grok --resume '+GK],[REMOTE,'t9','claude --resume '+RM]]);
  assert.equal(io.effects.notify.length,1,'one toast for the restart');assert.match(io.effects.notify[0].body,/Resumed 4 agents: /);assert.match(io.effects.notify[0].body,/tb2/,'names the tabs');
  const reloaded=new RestartRunner(makeIO(w,{files}),{owner:'reloaded',clock});clock.advance(RESTART.leaseMs);await fresh.release();await ticks(reloaded,3);
  assert.equal(w.sends.length,4,'a reload sends nothing more');
});

test('a second app home on the same machines sends nothing more', async ()=>{
  const w=makeWorld();populate(w);const clock=clockAt(T0),homes=[new Map(),new Map()];
  const runners=homes.map((files,i)=>new RestartRunner(makeIO(w,{files,home:'/app'+i}),{owner:'home'+i,clock}));
  for(const r of runners)await ticks(r,2);w.reboot();clock.advance(600000);
  for(let i=0;i<8;i++){for(const r of runners)await r.tick();clock.advance(RUNNER.tickMs);}
  assert.equal(w.sends.length,4,'host claims allow one send per restored shell');
});

test('offline hosts, failed claims, changed foregrounds and rejected sends type nothing and leave offers', async ()=>{
  const w=makeWorld();populate(w);const files=new Map(),clock=clockAt(T0),io=makeIO(w,{files}),r=new RestartRunner(io,{owner:'a',clock});
  await ticks(r,2);w.reboot();clock.advance(600000);w.ready[REMOTE]=false;
  w.helperDown=true;await r.tick();clock.advance(RUNNER.tickMs);await r.tick();
  assert.equal(w.sends.length,0,'nothing without host facts');const v0=(await new RunningAgents(io).read()).value;
  assert.equal(v0.machines[REMOTE].terminals.t9.state,'tracking','an offline machine is unknown, not lost');
  w.helperDown=false;await r.tick();clock.advance(RUNNER.tickMs);
  w.failSend=true;await r.tick();clock.advance(RUNNER.tickMs);await r.tick();
  const offered=r.offers();assert.ok(offered.length>=1,'rejected sends become offers');assert.ok(offered.every(o=>o.line.includes('--resume')||o.line.includes(' resume ')));
  assert.equal(w.sends.length,0);
});

test('Resume from an offer re-probes capabilities, uses its own claim and succeeds once', async ()=>{
  const w=makeWorld();w.agent('local','t1',{space:'sp1',tab:'tb1',shell:500,agent:600,provider:'claude',session:CL});
  const stale={get:async(tool)=>({v:1,key:tool.key,provider:tool.key,run:tool.run,base:true,resume:null})};
  const files=new Map(),clock=clockAt(T0),io=makeIO(w,{files,capabilities:stale}),r=new RestartRunner(io,{owner:'a',clock});
  await ticks(r,2);w.reboot();clock.advance(600000);await ticks(r,3);
  assert.equal(w.sends.length,0,'cached capabilities say no resume, so it is offered');const [o]=r.offers();assert.ok(o);assert.match(o.reason,/no verified exact-session resume/);
  const first=await r.resumeOffer(o);assert.equal(first.ok,true,JSON.stringify(first));
  assert.deepEqual(w.sends,[[null,'t1','claude --resume '+CL]]);
  assert.ok([...w.hosts.local.claims].some(k=>k.includes('-offer-')),'its own single-use claim');
  assert.equal((await r.resumeOffer(o)).ok,false,'a second click does nothing');assert.equal(w.sends.length,1);
});

test('dismiss, the setting off, and the per-tick exec budget', async ()=>{
  const w=makeWorld();populate(w);const files=new Map(),clock=clockAt(T0),io=makeIO(w,{files}),r=new RestartRunner(io,{owner:'a',clock});
  files.set('/app/mission-control/config.json',JSON.stringify({v:1,revision:1,connections:{},bindings:{},preferences:{resumeAfterRestart:false},usageSources:{}}));
  await ticks(r,2);w.reboot();clock.advance(600000);
  for(let i=0;i<4;i++){const before=io.effects.exec.length;await r.tick();clock.advance(RUNNER.tickMs);assert.ok(io.effects.exec.length-before<=RUNNER.budget+2,'bounded exec per tick');}
  assert.equal(w.sends.length,0,'off: never typed');assert.equal(r.offers().length,0,'off: never offered');
  const w2=makeWorld();w2.agent('local','t1',{space:'sp1',tab:'tb1',shell:500,agent:600,provider:'claude',session:CL});
  const io2=makeIO(w2,{capabilities:{get:async t=>({v:1,key:t.key,provider:t.key,run:t.run,base:true,resume:null})}}),r2=new RestartRunner(io2,{owner:'b',clock});
  await ticks(r2,2);w2.reboot();clock.advance(600000);await ticks(r2,3);assert.equal(r2.offers().length,1);
  assert.match(io2.effects.notify.at(-1).body,new RegExp('needs you: claude --resume '+CL),'the toast gives the command to run');
  await r2.dismissOffer(r2.offers()[0]);assert.equal(r2.offers().length,0);
  assert.equal(io2.shared(RESTART_STATE_KEY).toastedPassId,io2.shared(RESTART_STATE_KEY).passId);
});
