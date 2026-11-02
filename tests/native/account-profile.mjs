// TASK-067: account-profile launch routing without credentials, in a private
// app/core only. Toy Codex/Claude-shaped actors print their profile roots;
// no provider CLI, login, logout, credential read or paid turn ever runs.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {NativeRuntime,NativeIsolationError,isolatedEnvironment,run} from '../../scripts/native-harness.mjs';
import {flattenTree} from '../../scripts/native-driver.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const PROBE='mission-control-account-profile-probe',KEY='mission-control-account-profile-probe-v1',HOST='qa-server',ENV='/usr/bin/env',PANEL=280;
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex'),delay=ms=>new Promise(resolve=>setTimeout(resolve,ms)),same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const clean=(value,max=1800)=>String(value).replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,max);
const firstLine=error=>clean(String(error?.message??error).split('\n').map(s=>s.trim()).filter(Boolean).slice(0,2).join(' '),300);
// TASK-066: these variables select independent A/B configuration roots. Keys are Herdr program-table names.
export const PROVIDERS=Object.freeze({codex:Object.freeze({variable:'CODEX_HOME',app:'codex',keys:Object.freeze(['codex'])}),claude:Object.freeze({variable:'CLAUDE_CONFIG_DIR',app:'claude-code',keys:Object.freeze(['claude','claude-code'])})});
const PROFILE_VARIABLES=Object.values(PROVIDERS).map(p=>p.variable);
/** A capability the gate refuses: recorded as an explicit verdict, never as success. */
export class Unsupported extends Error{constructor(requirement,detail){super(requirement+': '+detail);this.name='Unsupported';this.code='PROFILE_ROUTING_UNSUPPORTED';this.requirement=requirement;this.detail=clean(detail,900);}}
/** Cross-profile leak, wrong machine/core or a changed running session: the whole run fails. */
export class Unsafe extends Error{constructor(message){super(clean(message,1700));this.name='Unsafe';this.code='PROFILE_ROUTING_UNSAFE';}}
class Timeout extends Error{constructor(description,last){super('Timed out: '+description+(last?' ('+firstLine(last)+')':''));this.name='Timeout';}}
const rethrow=error=>{if(error instanceof NativeIsolationError||error instanceof Unsafe)throw error;};
const need=(condition,requirement,detail)=>{if(!condition)throw new Unsupported(requirement,detail);};

/** Polls like the harness, but never retries through an isolation, safety or capability verdict. */
export async function waitFor(read,description,timeout=20000){
  const end=Date.now()+timeout;let last;
  for(;;){
    try{const value=await read();if(value)return value;}catch(error){if(error instanceof NativeIsolationError||error instanceof Unsafe||error instanceof Unsupported)throw error;last=error;}
    if(Date.now()>=end)throw new Timeout(description,last);
    await delay(150);
  }
}

/** Options from clap help ("  -i, --stdin", "      --env <K=V>  ..."). Signatures are read, never assumed. */
export function helpOptions(text){
  const options={};
  for(const line of String(text).split(/\r?\n/)){const m=line.match(/^\s+(?:-([A-Za-z]),\s+)?--([a-z][a-z0-9-]*)(?:\s+<([^>]+)>)?(?:\s+(.*))?$/);if(m)options['--'+m[2]]={short:m[1]?'-'+m[1]:null,value:m[3]??null,about:clean(m[4]??'',200).trim()};}
  return options;
}
export function parseCapabilities({runHelp,execHelp,commands,hcVersion=null,appVersion=null}){
  const runOptions=helpOptions(runHelp),execOptions=helpOptions(execHelp);
  if(!runOptions['--cwd']||!runOptions['--label']||!runOptions['--bg']||!execOptions['--cwd'])throw Error('Installed hc run/exec help no longer has the reviewed option format; re-read it before routing profiles.');
  if(!Array.isArray(commands))throw Error('herdr-app commands did not return a command array.');
  const argsOf=name=>{const c=commands.find(c=>c?.name===name);return Array.isArray(c?.args)?c.args.map(a=>a?.name).filter(n=>typeof n==='string'):null;};
  const launch=Object.fromEntries(['tab.new','space.new','pane.split','terminal.open'].map(name=>[name,argsOf(name)]));
  if(!launch['tab.new']?.includes('argv')||!launch['tab.new'].includes('task'))throw Error('tab.new no longer accepts argv and task.');
  return {versions:{hc:hcVersion,app:appVersion},hcRun:{env:Object.hasOwn(runOptions,'--env'),options:Object.keys(runOptions).sort()},hcExec:{env:Object.hasOwn(execOptions,'--env'),envValue:execOptions['--env']?.value??null,options:Object.keys(execOptions).sort()},launch,appEnvArgument:Object.entries(launch).filter(([,args])=>args?.includes('env')).map(([name])=>name)};
}

// Exact argv, or the observed Herdr login-shell wrapper around exactly that argv.
// Herdr's login-shell wrappers: 0.1.10 used the user's zsh/bash; 0.1.11 uses /bin/sh locally and `sh -c` remotely (see launch.js observedArgv).
export const wrappedArgv=(argv,expected)=>Array.isArray(argv)&&(same(argv,expected)||typeof argv[0]==='string'&&(argv[0].startsWith('/')||!argv[0].includes('/'))&&/^(?:sh|bash|zsh|dash|ksh)$/.test(argv[0].split('/').pop())&&({'-lic':'"$@"; exec "$0" -li','-c':'"$@"; exec "${SHELL:-sh}" -i'})[argv[1]]===argv[2]&&argv[3]===argv[0]&&same(argv.slice(4),expected));
// A local leg matches only an unqualified local entry; a machine leg only its machine-qualified entry.
export const sameAddress=(entry,local,machine=null)=>!!entry&&typeof entry.address==='string'&&(machine===null?entry.address===local&&!entry.machine:entry.address===machine+'/'+local||entry.address===local&&entry.machine===machine);

/** Process evidence from a toy record. unsafe = leak or wrong routing; unsupported = mechanism did not deliver. */
export function assessRecord(record,{provider,root,ownRoots=[],toy,folder,home,session,address,args=[],terminal=true,task}){
  const spec=PROVIDERS[provider],values=record?.env?.values??{},bad=(kind,requirement,detail)=>({ok:false,kind,requirement,detail:clean(detail,600)});
  if(!spec)throw Error('Unknown toy provider '+provider);
  if(!record||record.v!==1||record.tool!==provider||record.argv0!==toy)return bad('unsupported','tool identity','the process is not the '+provider+' toy '+toy);
  // Herdr 0.1.11 hands tab.new's task (first message) to the program as its last argument.
  if(!same(record.argv,args)&&!(task&&same(record.argv,[...args,task])))return bad('unsupported','argv preservation','toy argv '+JSON.stringify(record.argv)+' instead of '+JSON.stringify(args));
  if(home&&values.HOME!==home)return bad('unsafe','machine identity','HOME '+values.HOME+' is not the owning core home '+home);
  if(session&&values.HC_SESSION!=null&&values.HC_SESSION!==session)return bad('unsupported','core identity','HC_SESSION '+values.HC_SESSION+' is not '+session);
  if(terminal&&address&&values.HC_TERMINAL_ID!=null&&values.HC_TERMINAL_ID!==address)return bad('unsupported','terminal identity','HC_TERMINAL_ID '+values.HC_TERMINAL_ID+' is not '+address);
  if(terminal&&record.tty!==true)return bad('unsupported','terminal identity','toy stdin is not a terminal');
  const sensitive=record.env?.sensitiveNames??[];if(sensitive.length)return bad('unsafe','credential isolation','credential-like variable names reached the toy: '+sensitive.join(','));
  for(const[other,o]of Object.entries(PROVIDERS))if(other!==provider&&values[o.variable]!=null)return bad('unsafe','profile isolation',o.variable+'='+values[o.variable]+' reached the '+provider+' toy');
  const value=values[spec.variable]??null;
  if(root===null){if(value!==null)return bad(ownRoots.includes(value)?'unsafe':'unsupported','global profile environment',spec.variable+'='+value+' without any profile selection');}
  else if(value===null)return bad('unsupported','profile routing',spec.variable+' never reached the toy');
  else if(value!==root)return bad('unsafe','profile routing',spec.variable+'='+value+' instead of '+root);
  if(folder&&record.cwd!==folder)return bad('unsupported','working folder','cwd '+record.cwd+' is not '+folder);
  // Other provider-prefixed names (never values) are evidence, not a profile selector.
  return {ok:true,value,extra:(record.env?.providerNames??[]).filter(name=>!PROFILE_VARIABLES.includes(name))};
}
/** Herdr's own classification, as the private probe mod published agents()/terminals(). A machine leg may also match its own space. */
export function assessClassification(snapshot,{local,machine=null,provider,space=null}){
  const hit=entry=>sameAddress(entry,local,machine)||machine!==null&&!!space&&entry?.address===local&&entry.space===space;
  const spec=PROVIDERS[provider],terminal=(snapshot?.terminals??[]).find(hit)??null,agent=(snapshot?.agents??[]).find(hit)??null,program=agent?.program??terminal?.program??null;
  const fail=detail=>({ok:false,requirement:'agent classification',detail,program,agent,terminal});
  if(!terminal&&!agent)return fail('Herdr has not published terminal '+local);
  if(program?.shell)return fail('Herdr classifies '+local+' as shell program '+program.key);
  if(!agent)return fail('Herdr lists '+local+' as program '+(program?.key??'unknown')+' but not as an agent');
  if(agent.app!==spec.app)return fail('agent '+local+' reports app '+agent.app+' instead of '+spec.app);
  if(!program||!spec.keys.includes(program.key)||program.agent!==true)return fail('agent '+local+' is program '+(program?.key??'none')+' instead of '+spec.keys.join('/'));
  return {ok:true,program,agent,terminal};
}

// Toy actor: records only allowlisted values and the NAMES of provider/credential-like variables.
const TOY=String.raw`#!/usr/bin/env python3
import os,sys,json,time,select,tty
TOOL=__TOOL__
APP=__APP__
RECORDS=__RECORDS__
KEYS=('CODEX_HOME','CLAUDE_CONFIG_DIR','HOME','XDG_CONFIG_HOME','HC_SESSION','HC_TERMINAL_ID','HERDR_APP_HOME')
PROVIDER=('CODEX','CLAUDE','ANTHROPIC','OPENAI')
SENSITIVE=('API_KEY','TOKEN','SECRET','PASSWORD','CREDENTIAL','OAUTH')
CONTROL=('HC_','HERDR_')
def snapshot():
 env=os.environ
 return {'values':{k:env.get(k) for k in KEYS},'providerNames':sorted(k for k in env if k.upper().startswith(PROVIDER)),'sensitiveNames':sorted(k for k in env if any(s in k.upper() for s in SENSITIVE) and not k.upper().startswith(CONTROL)),'controlNames':sorted(k for k in env if k.upper().startswith(CONTROL))}
if '--version' in sys.argv: print('Account-profile toy '+TOOL+' 1.0; never a provider CLI');sys.exit(0)
if '--help' in sys.argv: print('Account-profile toy '+TOOL+'\nUsage: '+TOOL+' [--probe-env]');sys.exit(0)
record={'v':1,'tool':TOOL,'pid':os.getpid(),'ppid':os.getppid(),'cwd':os.getcwd(),'argv0':os.path.realpath(sys.argv[0]),'argv':sys.argv[1:],'tty':sys.stdin.isatty(),'env':snapshot(),'received':'','chunks':0,'startedMs':int(time.time()*1000)}
if '--probe-env' in sys.argv:
 print(json.dumps(record),flush=True);sys.exit(0)
target=os.path.join(RECORDS,str(os.getpid())+'.json')
def save():
 record['env']=snapshot();record['savedMs']=int(time.time()*1000)
 temporary=target+'.next'
 with open(temporary,'w') as output: json.dump(record,output)
 os.replace(temporary,target)
if sys.stdin.isatty(): tty.setraw(sys.stdin.fileno())
save()
print('Account-profile toy '+TOOL+': no provider call, no credentials.',flush=True)
while True:
 print('\x1b]7501;state=idle:app='+APP+'\x1b\\',end='',flush=True)
 ready,_,_=select.select([sys.stdin],[],[],2)
 if ready:
  chunk=os.read(sys.stdin.fileno(),65536)
  if not chunk: break
  record['received']=(record['received']+chunk.decode('utf-8','replace'))[-65536:]
  record['chunks']+=1
  save()
`;
/** Toys named exactly codex/claude so Herdr's interpreter rule shows what they run; never on PATH. */
export async function writeToys(directory){
  const bin=path.join(directory,'toy-bin'),records=path.join(directory,'toy-records'),tools={};
  await fs.mkdir(bin,{recursive:true,mode:0o700});await fs.mkdir(records,{recursive:true,mode:0o700});
  for(const[provider,spec]of Object.entries(PROVIDERS)){const file=path.join(bin,provider),values={__TOOL__:provider,__APP__:spec.app,__RECORDS__:records};await fs.writeFile(file,TOY.replace(/__[A-Z]+__/g,token=>JSON.stringify(values[token])),{mode:0o700});await fs.chmod(file,0o700);tools[provider]={file,sha256:sha(await fs.readFile(file))};}
  const read=async file=>{try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT'||error instanceof SyntaxError)return null;throw error;}};
  return {bin,records,tools,byPid:pid=>Number.isSafeInteger(pid)&&pid>1?read(path.join(records,pid+'.json')):Promise.resolve(null),
    async all(){const values=[];for(const name of await fs.readdir(records))if(/^[0-9]+\.json$/.test(name)){const value=await read(path.join(records,name));if(value)values.push(value);}return values;}};
}
async function makeRoots(directory,names){const roots={};for(const[provider,profiles]of Object.entries(names)){roots[provider]={};for(const profile of profiles){const root=path.join(directory,'profiles',provider+'-'+profile);await fs.mkdir(root,{recursive:true,mode:0o700});roots[provider][profile]=root;}}return roots;}
async function filesUnder(directories){const found=[];const walk=async directory=>{for(const item of await fs.readdir(directory,{withFileTypes:true})){if(found.length>=200)return;const file=path.join(directory,item.name);found.push(file);if(item.isDirectory()&&!item.isSymbolicLink())await walk(file);}};for(const directory of directories)await walk(directory);return found;}
async function socketsUnder(directory){const found=[];for(const file of await filesUnder([directory])){const stat=await fs.lstat(file);if(stat.isSocket())found.push(file);}return found;}

/** Private GPUI probe: launch buttons plus Herdr's live agents()/terminals()/knownAgents() classification. Never shipped. */
export function probeSource(){return String.raw`import {View,div} from "gpui-kit";
import {v_flex} from "gpui-base";
import {agents,terminals,knownAgents,run,setShared} from "herdr";
const KEY=${JSON.stringify(KEY)},KEYS=["codex","claude","qa-missing"];
const text=(value,max=512)=>typeof value==="string"?value.slice(0,max):value==null?null:String(value).slice(0,max);
const program=p=>p&&typeof p==="object"?{key:text(p.key,64),name:text(p.name,128),agent:p.agent===true,shell:p.shell===true}:null;
export default class AccountProfileProbe extends View {
  init(props,cx){
    this.config=props&&typeof props==="object"?props:{};this.closed=false;this.seq=0;this.inputs=0;this.clicks=[];this.known=null;this.knownError=null;this.loading=false;this.last="";this.jobs=[];
    this.timers=[cx.timer.every(1000,tick=>this.tick(tick))];this.tick(cx);
  }
  tick(cx){if(this.closed)return;this.refresh(cx);this.publish();}
  refresh(cx){
    if(this.loading||this.closed)return;this.loading=true;this.jobs=this.jobs.filter(job=>!job.is_done());
    this.jobs.push(cx.spawn(async task=>{
      let list=null,error=null;try{list=await knownAgents();}catch(e){error=text(e&&e.message||e,300);}
      this.loading=false;if(this.closed)return;
      this.known=Array.isArray(list)?list.filter(a=>a&&KEYS.includes(a.key)).map(a=>({key:a.key,run:Array.isArray(a.run)?a.run.map(v=>text(v,1024)):null,installed:a.installed===true,agent:a.agent===true})):null;
      this.knownError=error;this.publish();task.notify();
    }));
  }
  publish(){
    const value={v:1,inputs:this.inputs,known:this.known,knownError:this.knownError,clicks:this.clicks.slice(-32),
      agents:(agents()||[]).slice(0,64).map(a=>({address:text(a.address,160),space:text(a.space,256),tab:text(a.tab,256),status:text(a.status,32),app:text(a.app,64),program:program(a.program)})),
      terminals:(terminals()||[]).slice(0,64).map(t=>({address:text(t.address,160),machine:text(t.machine,128),state:text(t.state,32),status:text(t.status,32),program:program(t.program),argv:Array.isArray(t.argv)?t.argv.slice(0,12).map(v=>text(v,1024)):null}))};
    const json=JSON.stringify(value);if(json!==this.last){this.last=json;setShared(KEY,value);}
  }
  launch(key,cx){
    if(this.closed)return;this.jobs=this.jobs.filter(job=>!job.is_done());
    this.jobs.push(cx.spawn(async task=>{
      let list=null;try{list=await knownAgents();}catch(e){list=null;}
      if(this.closed)return;
      const entry=Array.isArray(list)?list.find(a=>a&&a.key===key):null,seq=++this.seq,name="qa-click-"+key+"-"+seq,message=String(this.config.task||"qa profile task")+" click "+key+" "+seq;
      if(!entry||entry.installed!==true||!Array.isArray(entry.run)||!entry.run.length){this.clicks.push({seq,key,name,state:"unavailable"});this.publish();task.notify();return;}
      // Publish the intent before the command: an interrupted continuation skips what follows.
      const argv=entry.run.map(String);this.clicks.push({seq,key,name,argv,task:message,state:"requested"});this.publish();
      run("tab.new",{space:this.config.space,folder:this.config.folder,name,argv,task:message});
      this.clicks[this.clicks.length-1].state="sent";this.publish();task.notify();
    }));
  }
  close(){this.closed=true;for(const timer of this.timers)timer?.cancel?.();for(const job of this.jobs)job?.cancel?.();}
  render(_cx){
    return v_flex().id("qa-account-profile-probe").size_full().bg("#17191d").p(12).gap(10).text_size(13).text_color("#d8dbe2")
      .child(div().h(22).font_semibold().child("Account profile probe"))
      .child(div().id("qa-input-check").h(32).w_full().rounded(6).bg("#2a2d33").text_color("#e5e9f0").flex().items_center().justify_center().cursor_pointer()
        .accessibility_label("Check native input").role("button").on_click((_e,cx)=>{this.inputs++;this.publish();cx.notify();}).child("Check native input"))
      .children(["codex","claude"].map(key=>div().id("qa-start-"+key).h(40).w_full().rounded(6).bg("#253044").text_color("#e5e9f0").flex().items_center().justify_center().cursor_pointer()
        .accessibility_label("Start "+key+" profile").role("button").on_click((_e,cx)=>{this.launch(key,cx);cx.notify();}).child("Start "+key+" profile")))
      .child(div().h(18).text_size(11).text_color("#91969f").child("Launch requests: "+this.clicks.length));
  }
}
`;}

/** Mounted gate: real isolated app/core, PID-bound native input and the canonical TASK005 receipt. */
export default async function accountProfile(runtime){
  const home=runtime.env.HERDR_APP_HOME,server=new NativeRuntime(),short=runtime.nonce.slice(0,8);
  // Task/marker text is lowercase letters, digits and spaces: typeable natively and inert if a shell ever receives it.
  const word=[...short].map(c=>/[0-9]/.test(c)?String.fromCharCode(103+Number(c)):c).join(''),prefix='qa profile task '+word;
  const matrix={schema:'mission-control-account-profile-matrix-v1',task:'TASK-067',nonce:runtime.nonce,capabilities:null,verdicts:[],legs:[],observations:[]};
  const ok=label=>runtime.expect(true,clean(label)),observed=[];
  let connected=false,failure=null,serial=0,markers=0,local=null,remoteToys=null;
  const probeState=async()=>{try{return (await runtime.shared())[KEY]??null;}catch(error){if(error instanceof SyntaxError)return null;throw error;}};
  const world=()=>runtime.app(['ls']).spaces||[],tabsOf=id=>world().find(s=>s.id===id)?.tabs||[];
  const spaceOfTerminal=address=>world().find(s=>(s.tabs||[]).some(t=>(t.terminals||[]).some(x=>x.terminal===address)))||null;
  const terminalCount=()=>runtime.hc(['ls','--json']).terminals.length;
  const look=async(query='')=>{if(++serial>150)throw Error('Native observation budget exhausted');const frame=await runtime.frame('profile-observe-'+serial);return runtime.driver.ocr(path.join(ROOT,frame.path),query);};
  const control=async label=>{
    let nodes=[];try{nodes=flattenTree(await runtime.driver.tree());}catch(error){rethrow(error);}
    const ax=nodes.filter(n=>n.label===label&&(n.role==='AXButton'||n.actions?.includes('AXPress')));
    if(ax.length===1&&(ax[0].enabled&&ax[0].actions?.includes('AXPress')||ax[0].frame))return {ax:ax[0]};
    const o=await look(label),matches=o.matches.filter(n=>n.confidence>=0.6&&n.frame.x<PANEL+24&&n.text.toLowerCase().includes(label.toLowerCase()));
    return matches.length===1?{observation:o,node:matches[0]}:null;
  };
  const activate=async label=>{
    const found=await waitFor(()=>control(label),'unique native control '+label,30000);
    if(found.ax?.enabled&&found.ax.actions?.includes('AXPress'))await runtime.driver.action(found.ax);
    else if(found.ax)await runtime.driver.click(found.ax.frame,{coordinateSpace:'screen'});
    else await runtime.driver.clickObservedText(found.observation,found.node);
    Object.assign(runtime.driver.actions.at(-1),{control:label});
  };
  const typeInto=async(leg,text)=>{
    runtime.app(['do','tab.select',JSON.stringify({id:leg.tab})]);runtime.app(['do','pane.focus',JSON.stringify({terminal:leg.address})]);
    const {frame}=await runtime.driver.pointerTarget({x:1,y:1,width:2,height:2});
    await runtime.driver.click({x:Math.round(frame.width*0.7),y:Math.round(frame.height*0.55),width:4,height:4},{expectedSize:frame});Object.assign(runtime.driver.actions.at(-1),{control:'terminal '+leg.address});
    for(const character of text)await runtime.driver.press(character===' '?'space':character);
    await runtime.driver.press('enter');
  };
  const send=(core,address,text)=>waitFor(()=>{try{core.hc(['send','--if','idle',address,text],{json:false});return true;}catch(error){rethrow(error);throw error;}},'idle send to '+address,20000);
  const after=(requirement,label,detail)=>error=>{if(error instanceof Timeout)throw new Unsupported(requirement,label+': '+detail());throw error;};

  /** One launched terminal: process, profile, machine, argv, window, classification and task evidence. */
  const observeLeg=async leg=>{
    const spec=PROVIDERS[leg.provider],toy=leg.toys.tools[leg.provider].file,core=leg.core;let raw=null,record=null;
    await waitFor(async()=>{raw=core.hc(['get',leg.local,'--json']);if(raw?.state&&raw.state!=='live')throw new Unsupported('toy launch',leg.label+': terminal '+leg.local+' is '+raw.state);record=await leg.toys.byPid(raw?.foreground?.pid);return record;},leg.label+' toy foreground',leg.launchTimeout??25000)
      .catch(async error=>{if(!(error instanceof Timeout))throw error;const hint=assessClassification(await probeState(),{local:leg.local,machine:leg.machine,provider:leg.provider,space:leg.space});throw new Unsupported('toy launch',leg.label+': foreground '+(raw?.foreground?.name??raw?.foreground?.pid??'none')+' never became the toy; Herdr shows '+(hint.program?hint.program.key+(hint.program.shell?' (shell)':''):'no program'));});
    const firstMessage=leg.send?undefined:leg.task,verdict=assessRecord(record,{provider:leg.provider,root:leg.root,ownRoots:leg.ownRoots,toy,folder:leg.folder,home:core.env.HOME,session:core.env.HC_SESSION,address:leg.local,task:firstMessage});
    if(!verdict.ok){if(verdict.kind==='unsafe')throw new Unsafe(leg.label+': '+verdict.requirement+': '+verdict.detail);throw new Unsupported(verdict.requirement,leg.label+': '+verdict.detail);}
    const launched=expected=>leg.exactArgv?same(raw.argv,expected):wrappedArgv(raw.argv,expected);
    need(launched(leg.expectedArgv)||Boolean(firstMessage)&&launched([...leg.expectedArgv,firstMessage]),'argv preservation',leg.label+': core argv '+JSON.stringify(raw.argv)+' differs from launched '+JSON.stringify(leg.expectedArgv));
    const space=await waitFor(()=>spaceOfTerminal(leg.address),leg.label+' window adoption',20000).catch(after('window adoption',leg.label,()=>'terminal '+leg.address+' never appeared in a window space'));
    if((space.machine??null)!==leg.machine)throw new Unsafe(leg.label+': terminal '+leg.address+' is in space '+space.id+' on '+(space.machine??'local')+', not '+(leg.machine??'local'));
    let last=null;
    const classified=await waitFor(async()=>{last=assessClassification(await probeState(),{local:leg.local,machine:leg.machine,provider:leg.provider,space:space.id});return last.ok?last:null;},leg.label+' Herdr classification',20000).catch(after('agent classification',leg.label,()=>last?.detail??'no classification published'));
    ok(`${leg.label}: ${leg.machine??'local'} core runs toy PID ${record.pid} (${toy}) as terminal ${leg.address} in ${record.cwd} with ${spec.variable}=${verdict.value??'unset'} from argv ${JSON.stringify(leg.expectedArgv)}${verdict.extra.length?'; other provider-prefixed names '+verdict.extra.join(','):''}`);
    ok(`${leg.label}: Herdr classifies ${leg.address} as the ${classified.program.key} agent (app ${classified.agent.app}, status ${classified.agent.status}), not a shell`);
    if(leg.send)await send(core,leg.local,leg.task).catch(after('task routing',leg.label,()=>'hc send --if idle never delivered to '+leg.local));
    const asArgument=Boolean(firstMessage)&&record.argv.at(-1)===firstMessage;
    await waitFor(async()=>{const r=await leg.toys.byPid(record.pid);return asArgument||r?.received?.includes(leg.task)?r:null;},leg.label+' task delivery',25000).catch(after('task routing',leg.label,()=>'task "'+leg.task+'" never reached toy PID '+record.pid));
    ok(`${leg.label}: task "${leg.task}" reached toy PID ${record.pid} ${leg.send?'through hc send':asArgument?'as the Herdr first message (its last argument)':'as the Herdr first message'}`);
    const evidence={candidate:leg.candidate,label:leg.label,provider:leg.provider,profile:leg.profile,machine:leg.machine,address:leg.address,tab:leg.tab,space:space.id,pid:record.pid,createdMs:raw.created_ms,root:leg.root,value:verdict.value,extraNames:verdict.extra,controlNames:record.env.controlNames??[],cwd:record.cwd,argv:raw.argv,foreground:raw.foreground?.name??null,program:classified.program.key,app:classified.agent.app,task:leg.task};
    matrix.legs.push(evidence);const result={...leg,...evidence};observed.push(result);return result;
  };
  /** Requirement 3: an earlier session keeps its generation and root and still takes input after a later profile launch. */
  const persists=async(leg,via,deliver)=>{
    const raw=leg.core.hc(['get',leg.local,'--json']);
    if(raw.state!=='live'||raw.created_ms!==leg.createdMs||raw.foreground?.pid!==leg.pid)throw new Unsafe(leg.label+': existing terminal '+leg.local+' changed generation after a later profile launch (created '+raw.created_ms+', foreground '+raw.foreground?.pid+')');
    const marker=`${word} kept ${leg.provider} ${++markers}`;await Promise.resolve().then(()=>deliver(marker)).catch(after('existing session input',leg.label,()=>via+' delivery never succeeded'));
    const record=await waitFor(async()=>{const r=await leg.toys.byPid(leg.pid);return r?.received?.includes(marker)?r:null;},leg.label+' post-switch input',25000).catch(after('existing session input',leg.label,()=>via+' input after the later launch never reached toy PID '+leg.pid));
    const value=record.env.values[PROVIDERS[leg.provider].variable]??null;
    if(value!==leg.root)throw new Unsafe(leg.label+': existing session reports '+value+' after a later profile launch');
    ok(`${leg.label}: existing terminal ${leg.address} (PID ${leg.pid}, created ${leg.createdMs}) kept ${PROVIDERS[leg.provider].variable}=${leg.root} after later profile launches and took ${via} input; new launches only, no hot switch`);
  };
  const attempt=async(candidate,{counts,documented,machine=null},body)=>{
    const where=candidate+(machine?'@'+machine:''),noted=documented===false?' (absent from installed help)':'';
    try{const evidence=await body();matrix.verdicts.push({candidate,machine,counts,documented,supported:true,summary:evidence.summary});ok(`Capability ${where}: SUPPORTED for new launches${noted}; ${evidence.summary}`);return true;}
    catch(error){if(!(error instanceof Unsupported))throw error;matrix.verdicts.push({candidate,machine,counts,documented,supported:false,requirement:error.requirement,detail:error.detail});ok(`Gate refuses ${where}: ${error.requirement} unsupported${noted} - ${error.detail}`);return false;}
  };

  try{
    // Fixtures stay inside the private runtime directories; nothing references real provider homes.
    for(const directory of [runtime.env.HOME])await fs.writeFile(path.join(directory,'.zshrc'),'# Disposable account-profile fixture shell\n');
    local=await writeToys(runtime.directory);const roots=await makeRoots(runtime.directory,{codex:['a','b'],claude:['a','b']});
    await server.start();await fs.writeFile(path.join(server.env.HOME,'.zshrc'),'# Disposable account-profile fixture shell\n');
    remoteToys=await writeToys(server.directory);const remoteRoots=await makeRoots(server.directory,{codex:['remote']});
    const allRoots=[...Object.values(roots).flatMap(r=>Object.values(r)),remoteRoots.codex.remote],others=root=>allRoots.filter(r=>r!==root);
    runtime.expect(allRoots.every(r=>r.startsWith(runtime.directory+'/')||r.startsWith(server.directory+'/'))&&!PROFILE_VARIABLES.some(k=>Object.hasOwn(runtime.env,k)||Object.hasOwn(server.env,k)),'Profile roots are fresh private directories and no control environment carries CODEX_HOME or CLAUDE_CONFIG_DIR');
    const wrapper=(provider,root,toys=local)=>[ENV,PROVIDERS[provider].variable+'='+root,toys.tools[provider].file];
    const programsFile=path.join(home,'programs.json'),programs=profile=>JSON.stringify({programs:{codex:{run:wrapper('codex',roots.codex[profile])},claude:{run:wrapper('claude',roots.claude[profile])},'qa-missing':{name:'QA missing wrapped tool',run:[ENV,'CODEX_HOME='+roots.codex[profile],path.join(local.bin,'missing-tool')]}}})+'\n';
    await fs.writeFile(programsFile,programs('a'));
    const probeDirectory=path.join(home,'mods',PROBE);await fs.mkdir(probeDirectory,{recursive:true});
    await fs.writeFile(path.join(probeDirectory,'main.js'),probeSource());await fs.writeFile(path.join(probeDirectory,'mod.json'),'{"title":"Account profile probe","place":"none"}\n');
    runtime.app(['check',probeDirectory],{json:false});ok('Private probe mod '+PROBE+' passes herdr-app check in the private app home only');
    const via=path.join(runtime.directory,'account-profile-via.py'),selectors=Object.fromEntries(Object.entries(server.env).filter(([key])=>['HOME','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_RUNTIME_DIR','HC_SESSION','HERDR_APP_HOME'].includes(key)));
    await fs.writeFile(via,`#!/usr/bin/env python3\nimport os,sys,json\ne=os.environ.copy();e.update(json.loads(${JSON.stringify(JSON.stringify(selectors))}))\nos.execvpe('/bin/sh',['sh','-c',sys.argv[-1]],e)\n`);await fs.chmod(via,0o700);
    runtime.hc(['machine','add','--via',via,'--name',HOST,'--session',server.env.HC_SESSION,'--json']);connected=true;
    const layout={id:'qa-root',type:'column',titlebar:'none',traffic_lights:[12,16],children:[{id:'tabs',type:'block',size:{px:42},content:{mod:'tabs'}},
      {id:'work',type:'row',children:[{id:'probe-column',type:'column',size:{px:PANEL},children:[{id:'probe',type:'block',size:{px:250},content:{mod:PROBE,props:{space:runtime.spaceId,folder:runtime.repo,task:prefix}}},{id:'agents',type:'block',content:{mod:'agents'}}]},{id:'main',type:'block',content:{tab:'active'}}]}]};
    await runtime.startWindow({layout,name:'account-profile-native'});await runtime.driver.enableAccessibility();
    await runtime.frame('account-profile-start');

    // Signatures come from the installed help, read inside the private context.
    const capabilities=parseCapabilities({runHelp:runtime.hc(['run','--help'],{json:false}),execHelp:runtime.hc(['exec','--help'],{json:false}),commands:runtime.app(['commands']),hcVersion:run('hc',['--version'],{env:runtime.env,json:false}),appVersion:run('herdr-app',['--version'],{env:runtime.env,json:false})});
    matrix.capabilities=capabilities;
    ok(`Installed help (${capabilities.versions.hc}, ${capabilities.versions.app}): hc exec --env ${capabilities.hcExec.env?'<'+capabilities.hcExec.envValue+'> present':'absent'}; hc run --env ${capabilities.hcRun.env?'present':'absent'} (options ${capabilities.hcRun.options.join(' ')}); env argument on ${capabilities.appEnvArgument.join(', ')||'no launch command'} (tab.new args ${capabilities.launch['tab.new'].join(',')}); mod exec(command,args,{cwd,on}) has no env option per the reviewed contract`);
    const first=await waitFor(async()=>{const s=await probeState();return s?.v===1&&Array.isArray(s.terminals)?s:null;},'probe publication of Herdr live classification',30000);
    runtime.expect(first.terminals.some(t=>t.address===runtime.sentinel),'Probe mod publishes Herdr live terminals(), including the private sentinel');
    // Unconditional real input, independent of every capability verdict (the receipt always needs it).
    await activate('Check native input');
    await waitFor(async()=>(await probeState())?.inputs===1,'real PID-bound input reaching the private probe handler',20000);
    ok('Real PID-bound native input reached the private probe GPUI handler (shared inputs=1) before any profile launch');

    // C1: acknowledged tab.new (the path exec("herdr-app",["do","tab.new",...]) takes) with an explicit env argv wrapper.
    await attempt('app-tab-new-env-argv',{counts:true,documented:true},async()=>{
      const legs={};
      for(const provider of ['codex','claude'])for(const profile of ['a','b']){
        const root=roots[provider][profile],argv=wrapper(provider,root),task=`${prefix} tabnew ${provider} ${profile}`;let ack;
        try{ack=runtime.app(['do','tab.new',JSON.stringify({space:runtime.spaceId,folder:runtime.repo,name:`qa-tabnew-${provider}-${profile}`,argv,task})]);}catch(error){rethrow(error);throw new Unsupported('tab.new acceptance',firstLine(error));}
        need(ack?.space===runtime.spaceId&&typeof ack.tab==='string'&&typeof ack.terminal==='string','tab.new acknowledgement','unexpected acknowledgement '+JSON.stringify(ack));
        legs[provider+profile]=await observeLeg({candidate:'app-tab-new-env-argv',label:`tab.new env argv ${provider} profile ${profile.toUpperCase()}`,provider,profile,root,ownRoots:others(root),core:runtime,machine:null,address:ack.terminal,local:ack.terminal,tab:ack.tab,folder:runtime.repo,toys:local,expectedArgv:argv,task});
      }
      for(const provider of ['codex','claude'])await persists(legs[provider+'a'],'hc send',marker=>send(runtime,legs[provider+'a'].local,marker));
      return {summary:Object.values(legs).map(l=>`${l.provider} ${l.profile.toUpperCase()} ${l.address}/PID ${l.pid} ${l.value}`).join('; ')+'; A sessions kept their roots after B'};
    });
    await runtime.frame('account-profile-tabnew');

    // C2: programs.json run with an env wrapper, launched by a real PID-bound click through knownAgents() and run("tab.new").
    await attempt('programs-run-env-wrapper',{counts:true,documented:true},async()=>{
      const knownRun=(state,key)=>state?.known?.find(a=>a.key===key)?.run;
      await waitFor(async()=>{const s=await probeState();return ['codex','claude'].every(k=>same(knownRun(s,k),wrapper(k,roots[k].a)))?s:null;},'knownAgents() reports the profile A wrappers',30000).catch(after('knownAgents run',`programs.json profile A`,()=>'knownAgents() never reported the programs.json env-wrapper run'));
      const missing=(await probeState())?.known?.find(a=>a.key==='qa-missing');
      matrix.observations.push({kind:'knownAgents-installed-wrapper',installed:missing?.installed??null});
      ok(`Observation: knownAgents() reports installed=${missing?.installed??'absent'} for an env wrapper around a missing tool${missing?.installed?'; the wrapper hides a missing provider, so production must verify the wrapped executable itself':''}`);
      const clickLaunch=async(provider,profile)=>{
        const before=new Set(tabsOf(runtime.spaceId).map(t=>t.id)),count=(await probeState())?.clicks?.length??0;
        await activate(`Start ${provider} profile`);
        const click=await waitFor(async()=>(await probeState())?.clicks?.[count]??null,'probe launch request '+provider,30000).catch(after('mod launch request',provider,()=>'the native click produced no probe launch request'));
        need(click.state!=='unavailable','knownAgents launch entry',`${provider} has no installed knownAgents() run`);
        need(same(click.argv,wrapper(provider,roots[provider][profile])),'profile selection',`${provider} ${profile.toUpperCase()} click used ${JSON.stringify(click.argv)}`);
        const tab=await waitFor(()=>{const list=tabsOf(runtime.spaceId).filter(t=>!before.has(t.id));return list.length===1&&list[0].terminals?.[0]?.terminal?list[0]:null;},'tab created by the native click',30000).catch(after('mod run("tab.new")',provider,()=>'no tab appeared after the click'));
        const root=roots[provider][profile],address=tab.terminals[0].terminal;
        return observeLeg({candidate:'programs-run-env-wrapper',label:`programs.json run ${provider} profile ${profile.toUpperCase()} (native click)`,provider,profile,root,ownRoots:others(root),core:runtime,machine:null,address,local:address,tab:tab.id,folder:runtime.repo,toys:local,expectedArgv:click.argv,task:click.task});
      };
      const legs={};for(const provider of ['codex','claude'])legs[provider+'a']=await clickLaunch(provider,'a');
      await fs.writeFile(programsFile,programs('b'));
      await waitFor(async()=>{const s=await probeState();return ['codex','claude'].every(k=>same(knownRun(s,k),wrapper(k,roots[k].b)))?s:null;},'knownAgents() reports the profile B wrappers',75000).catch(after('profile selection','programs.json profile B',()=>'knownAgents() kept the old run after programs.json changed'));
      for(const provider of ['codex','claude'])legs[provider+'b']=await clickLaunch(provider,'b');
      await persists(legs.codexa,'native keyboard',marker=>typeInto(legs.codexa,marker));
      await persists(legs.claudea,'hc send',marker=>send(runtime,legs.claudea.local,marker));
      await runtime.frame('account-profile-switched');
      return {summary:Object.values(legs).map(l=>`${l.provider} ${l.profile.toUpperCase()} ${l.address}/PID ${l.pid} ${l.value}`).join('; ')+'; programs.json A->B changed only later launches'};
    });

    // C3: core-owned launch (hc run) with the same explicit env argv; the window adopts it by labels.
    await attempt('core-hc-run-env-argv',{counts:true,documented:true},async()=>{
      const legs={};
      for(const provider of ['codex','claude'])for(const profile of ['a','b']){
        const root=roots[provider][profile],argv=wrapper(provider,root),tab=`qa-core-${provider}-${profile}-${short}`;let ack;
        try{ack=runtime.hc(['run','--bg','--no-parent','--json','--name',`qa-core-${provider}-${profile}`,'--cwd',runtime.repo,'--label',`herdr.space=${runtime.spaceId}`,'--label',`herdr.tab=${tab}`,'--',...argv]);}catch(error){rethrow(error);throw new Unsupported('hc run acceptance',firstLine(error));}
        need(typeof ack?.address==='string','hc run acknowledgement','unexpected acknowledgement '+JSON.stringify(ack));
        legs[provider+profile]=await observeLeg({candidate:'core-hc-run-env-argv',label:`hc run env argv ${provider} profile ${profile.toUpperCase()}`,provider,profile,root,ownRoots:others(root),core:runtime,machine:null,address:ack.address,local:ack.address,tab,folder:runtime.repo,toys:local,expectedArgv:argv,exactArgv:true,task:`${prefix} core ${provider} ${profile}`,send:true});
      }
      for(const provider of ['codex','claude'])await persists(legs[provider+'a'],'hc send',marker=>send(runtime,legs[provider+'a'].local,marker));
      return {summary:Object.values(legs).map(l=>`${l.provider} ${l.profile.toUpperCase()} ${l.address}/PID ${l.pid} ${l.value}`).join('; ')};
    });

    // C4/C5: first-class env selectors absent from installed help must be rejected without side effects.
    await attempt('core-hc-run-env-flag',{counts:true,documented:capabilities.hcRun.env},async()=>{
      const legs={};
      for(const provider of ['codex','claude'])for(const profile of ['a','b']){
        const root=roots[provider][profile],toy=local.tools[provider].file,tab=`qa-core-env-flag-${provider}-${profile}-${short}`,before=terminalCount();let ack;
        try{ack=runtime.hc(['run','--bg','--no-parent','--json','--env',`${PROVIDERS[provider].variable}=${root}`,'--name',`qa-env-flag-${provider}-${profile}`,'--cwd',runtime.repo,'--label',`herdr.space=${runtime.spaceId}`,'--label',`herdr.tab=${tab}`,'--',toy]);}
        catch(error){rethrow(error);runtime.expect(terminalCount()===before,'Rejected hc run --env created no terminal');throw new Unsupported('hc run --env',firstLine(error));}
        legs[provider+profile]=await observeLeg({candidate:'core-hc-run-env-flag',label:`hc run --env ${provider} profile ${profile.toUpperCase()}`,provider,profile,root,ownRoots:others(root),core:runtime,machine:null,address:ack.address,local:ack.address,tab,folder:runtime.repo,toys:local,expectedArgv:[toy],exactArgv:true,task:`${prefix} envflag ${provider} ${profile}`,send:true});
      }
      for(const provider of ['codex','claude'])await persists(legs[provider+'a'],'hc send',marker=>send(runtime,legs[provider+'a'].local,marker));
      return {summary:Object.values(legs).map(l=>`${l.provider} ${l.profile.toUpperCase()} ${l.address} ${l.value}`).join('; ')};
    });
    await attempt('app-tab-new-env-argument',{counts:true,documented:capabilities.launch['tab.new'].includes('env')},async()=>{
      const legs={};
      for(const provider of ['codex','claude'])for(const profile of ['a','b']){
        const root=roots[provider][profile],toy=local.tools[provider].file,task=`${prefix} envarg ${provider} ${profile}`,tabs=tabsOf(runtime.spaceId).length,before=terminalCount();let ack;
        try{ack=runtime.app(['do','tab.new',JSON.stringify({space:runtime.spaceId,folder:runtime.repo,name:`qa-tabnew-env-argument-${provider}-${profile}`,argv:[toy],env:{[PROVIDERS[provider].variable]:root},task})]);}
        catch(error){rethrow(error);runtime.expect(tabsOf(runtime.spaceId).length===tabs&&terminalCount()===before,'Rejected tab.new env argument created no tab or terminal');throw new Unsupported('tab.new env argument',firstLine(error));}
        legs[provider+profile]=await observeLeg({candidate:'app-tab-new-env-argument',label:`tab.new env argument ${provider} profile ${profile.toUpperCase()}`,provider,profile,root,ownRoots:others(root),core:runtime,machine:null,address:ack.terminal,local:ack.terminal,tab:ack.tab,folder:runtime.repo,toys:local,expectedArgv:[toy],task});
      }
      for(const provider of ['codex','claude'])await persists(legs[provider+'a'],'hc send',marker=>send(runtime,legs[provider+'a'].local,marker));
      return {summary:Object.values(legs).map(l=>`${l.provider} ${l.profile.toUpperCase()} ${l.address} ${l.value}`).join('; ')};
    });

    // C6: a shell-assignment word in argv is not an env mechanism; a shell that receives the task must fail the gate.
    await attempt('app-tab-new-assignment-argv',{counts:false,documented:false},async()=>{
      const root=roots.codex.a,toy=local.tools.codex.file,argv=['CODEX_HOME='+root,toy],task=`${prefix} assign codex a`;let ack;
      try{ack=runtime.app(['do','tab.new',JSON.stringify({space:runtime.spaceId,folder:runtime.repo,name:'qa-tabnew-assignment',argv,task})]);}catch(error){rethrow(error);throw new Unsupported('assignment argv','tab.new rejected it: '+firstLine(error));}
      try{await observeLeg({candidate:'app-tab-new-assignment-argv',label:'tab.new assignment argv codex profile A',provider:'codex',profile:'a',root,ownRoots:others(root),core:runtime,machine:null,address:ack.terminal,local:ack.terminal,tab:ack.tab,folder:runtime.repo,toys:local,expectedArgv:argv,task,launchTimeout:12000});}
      catch(error){if(!(error instanceof Unsupported))throw error;if(error.requirement!=='toy launch')throw error;await delay(3000);const reached=(await local.all()).some(r=>r.received.includes(task));if(reached)throw new Unsafe('A toy received the assignment-argv task although no toy launched for it');throw new Unsupported('toy launch',error.detail+'; its task reached no toy');}
      throw new Unsupported('argv shell parsing','tab.new interpreted an assignment word; the gate never accepts shell-parsed argv');
    });

    // C7: hc exec --env routes one-shot processes only: no terminal, agent or task identity.
    await attempt('core-hc-exec-env',{counts:false,documented:capabilities.hcExec.env},async()=>{
      const root=roots.codex.a,toy=local.tools.codex.file,before=terminalCount();let output;
      try{output=runtime.hc(['exec','--env',`CODEX_HOME=${root}`,'--cwd',runtime.repo,'--',toy,'--probe-env'],{json:false});}catch(error){rethrow(error);throw new Unsupported('hc exec --env',firstLine(error));}
      let record=null;try{record=JSON.parse(String(output).trim().split('\n').at(-1));}catch{}
      const verdict=assessRecord(record,{provider:'codex',root,ownRoots:others(root),toy,folder:runtime.repo,home:runtime.env.HOME,session:runtime.env.HC_SESSION,args:['--probe-env'],terminal:false});
      if(!verdict.ok){if(verdict.kind==='unsafe')throw new Unsafe('hc exec --env: '+verdict.requirement+': '+verdict.detail);throw new Unsupported(verdict.requirement,'hc exec --env: '+verdict.detail);}
      runtime.expect(terminalCount()===before&&record.env.values.HC_TERMINAL_ID==null,'hc exec --env created no terminal');
      ok(`hc exec --env delivered CODEX_HOME=${verdict.value} to one-shot toy PID ${record.pid} (exit 0) without a terminal`);
      throw new Unsupported('terminal launch','hc exec --env sets per-process env for one-shot commands only (e.g. a future anonymous status probe); it creates no terminal, agent classification or task routing');
    });

    // Control: after every profile launch, direct toy launches still see no profile root (no global mutation).
    await attempt('baseline-no-selection',{counts:false,documented:true},async()=>{
      const legs=[];
      for(const provider of ['codex','claude']){
        const argv=[local.tools[provider].file],task=`${prefix} baseline ${provider}`;let ack;
        try{ack=runtime.app(['do','tab.new',JSON.stringify({space:runtime.spaceId,folder:runtime.repo,name:`qa-baseline-${provider}`,argv,task})]);}catch(error){rethrow(error);throw new Unsupported('tab.new acceptance',firstLine(error));}
        legs.push(await observeLeg({candidate:'baseline-no-selection',label:`baseline ${provider} without profile selection`,provider,profile:'none',root:null,ownRoots:allRoots,core:runtime,machine:null,address:ack.terminal,local:ack.terminal,tab:ack.tab,folder:runtime.repo,toys:local,expectedArgv:argv,task}));
      }
      return {summary:legs.map(l=>`${l.provider} ${l.address} ${PROVIDERS[l.provider].variable} unset`).join('; ')};
    });

    // Machine identity: the same tab.new path on a second private core attached as a remote machine. Run last,
    // so short local/remote addresses (both cores count from t1) never coexist with an unclassified local leg.
    await attempt('app-tab-new-env-argv',{counts:false,documented:true,machine:HOST},async()=>{
      const remoteSpace=await waitFor(()=>world().find(s=>s.machine===HOST),'remote fixture space adoption',60000).catch(after('remote machine adoption',HOST,()=>'the private remote core never appeared as a window space'));
      const root=remoteRoots.codex.remote,argv=wrapper('codex',root,remoteToys),task=`${prefix} remote codex`;let ack;
      try{ack=runtime.app(['do','tab.new',JSON.stringify({space:remoteSpace.id,folder:server.repo,name:'qa-remote-codex',argv,task})]);}catch(error){rethrow(error);throw new Unsupported('remote tab.new acceptance',firstLine(error));}
      need(ack?.space===remoteSpace.id&&typeof ack.terminal==='string','remote tab.new acknowledgement','unexpected acknowledgement '+JSON.stringify(ack));
      const remoteLocal=ack.terminal.startsWith(HOST+'/')?ack.terminal.slice(HOST.length+1):ack.terminal;
      const leg=await observeLeg({candidate:'app-tab-new-env-argv',label:`remote tab.new env argv codex profile R on ${HOST}`,provider:'codex',profile:'remote',root,ownRoots:others(root),core:server,machine:HOST,address:ack.terminal,local:remoteLocal,tab:ack.tab,space:remoteSpace.id,folder:server.repo,toys:remoteToys,expectedArgv:argv,task});
      runtime.expect(!(await local.byPid(leg.pid)),'Remote profile launch ran no toy on the local core');
      return {summary:`codex R ${leg.address}/PID ${leg.pid} ${leg.value} on the ${HOST} core (HOME ${server.env.HOME})`};
    });

    // Safety: toy-only processes, no credential material, no replaced session, no app errors.
    for(const leg of observed){const raw=leg.core.hc(['get',leg.local,'--json']);if(raw.state!=='live'||raw.created_ms!==leg.createdMs||raw.foreground?.pid!==leg.pid)throw new Unsafe(leg.label+': a later launch replaced terminal '+leg.address);}
    ok(`All ${observed.length} observed profile sessions kept their terminal generation and foreground PID through every later launch`);
    for(const toys of [local,remoteToys])for(const[provider,tool]of Object.entries(toys.tools))runtime.expect(sha(await fs.readFile(tool.file))===tool.sha256,`Toy ${provider} actor ${tool.file} is unchanged (sha256 ${tool.sha256.slice(0,16)}); no provider CLI was launched`);
    const written=await filesUnder(allRoots);matrix.observations.push({kind:'profile-root-entries',entries:written.map(f=>path.relative(runtime.directory,f))});
    runtime.expect(!written.some(f=>/auth|credential|token|keychain|oauth|session/i.test(path.basename(f))),'Profile roots hold no auth, credential, token or session file ('+written.length+' entries in total)');
    runtime.expect(!PROFILE_VARIABLES.some(k=>Object.hasOwn(runtime.env,k)||Object.hasOwn(server.env,k)),'Private app/core control environments still carry no profile variable (no global authentication mutation)');
    runtime.expect(runtime.app(['status']).errors?.length===0,'No native app or mod errors after every profile launch');
    await runtime.frame('account-profile-final');

    // Gate: a clean control plus at least one complete local new-launch path; refusals stay explicit.
    const supported=matrix.verdicts.filter(v=>v.counts&&v.supported&&!v.machine),baseline=matrix.verdicts.find(v=>v.candidate==='baseline-no-selection'),remote=matrix.verdicts.find(v=>v.machine===HOST);
    const describe=v=>v.candidate+(v.machine?'@'+v.machine:'')+'='+(v.supported?'supported':v.requirement);
    if(!baseline?.supported||!supported.length)throw Object.assign(new Error(clean('Account-profile launch routing gate FAILED (TASK-067): '+(baseline?.supported?'':'control '+(baseline?.detail??'missing')+'; ')+'no complete new-launch path. '+matrix.verdicts.map(describe).join('; '))),{code:'PROFILE_ROUTING_UNSUPPORTED'});
    ok(`ACCOUNT-PROFILE LAUNCH ROUTING GATE PASS (TASK-067, new launches only): supported ${supported.map(v=>v.candidate).join(', ')}; remote ${remote?.supported?'supported on '+HOST:'unsupported ('+(remote?.requirement??'not run')+')'}; refused ${matrix.verdicts.filter(v=>!v.supported).map(describe).join(', ')||'none'}. Toy actors only: no login/logout, credential access or copying, paid turn, hot switch or authenticated resume claim`);
  }catch(error){
    failure=error;
    try{await runtime.frame('account-profile-failure');const folder=path.join(ROOT,'.browse/sessions',`mission-control-native-${runtime.nonce}`);await fs.writeFile(path.join(folder,'account-profile-failure-ax.json'),JSON.stringify(await runtime.driver.tree(),null,2));await fs.writeFile(path.join(folder,'account-profile-console.txt'),(runtime.appStdout||'')+'\n'+(runtime.appStderr||''));}catch{}
  }finally{
    try{if(connected)runtime.hc(['machine','rm',HOST,'--json']);}catch(error){failure??=error;}
    try{if(server.directory)await server.close();}catch(error){failure??=error;}
    try{const folder=path.join(ROOT,'.browse/sessions',`mission-control-native-${runtime.nonce}`);await fs.mkdir(folder,{recursive:true});await fs.writeFile(path.join(folder,'account-profile-matrix.json'),JSON.stringify({...matrix,failure:failure?{code:failure.code??null,message:clean(failure.message)}:null},null,2)+'\n');}catch{}
  }
  if(failure)throw failure;
}

/** Core-free preflight: static help parsing, toy actors and the probe mod under the strict recording seam. */
export async function checkFixtures(){
  const directory=await fs.mkdtemp('/private/tmp/mcqa-'),children=[];let assertions=0;const check=(value,label)=>{assert.ok(value,label);assertions++;};
  try{
    const env=isolatedEnvironment(directory,crypto.randomBytes(12).toString('hex'));
    for(const key of ['HOME','TMPDIR','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_CACHE_HOME','XDG_RUNTIME_DIR','HERDR_APP_HOME'])await fs.mkdir(env[key],{recursive:true,mode:0o700});
    // Static help only, with private selectors, so no binary can reach a real app/core.
    const help=(command,args)=>{const r=spawnSync(command,args,{env,cwd:directory,encoding:'utf8',timeout:20000,maxBuffer:8*1024*1024});if(r.error||r.status!==0)throw Error(command+' '+args.join(' ')+' failed: '+(r.stderr||r.error?.message||r.status));return r.stdout;};
    const capabilities=parseCapabilities({runHelp:help('hc',['run','--help']),execHelp:help('hc',['exec','--help']),commands:JSON.parse(help('herdr-app',['commands'])),hcVersion:help('hc',['--version']).trim(),appVersion:help('herdr-app',['--version']).trim()});
    check(capabilities.hcExec.env&&capabilities.hcExec.envValue==='K=V','Installed hc exec documents --env <K=V>');
    check(!capabilities.hcRun.env&&capabilities.hcRun.options.includes('--label'),'Installed hc run has no --env option');
    check(capabilities.appEnvArgument.length===0&&capabilities.launch['tab.new'].includes('argv'),'No Herdr launch command declares an env argument; tab.new takes argv and task');
    const synthetic=parseCapabilities({runHelp:'Usage: hc run\n      --cwd <CWD>  x\n      --label <K=V>  x\n      --bg  x\n      --env <K=V>  x\n',execHelp:'  -i, --stdin  x\n      --cwd <CWD>  x\n',commands:[{name:'tab.new',args:[{name:'argv'},{name:'task'},{name:'env'}]}]});
    check(synthetic.hcRun.env&&!synthetic.hcExec.env&&same(synthetic.appEnvArgument,['tab.new'])&&synthetic.hcExec.options.includes('--stdin'),'Parser detects a future documented env option or argument');
    assert.throws(()=>parseCapabilities({runHelp:'garbage',execHelp:'',commands:[]}),/reviewed option format/);assertions++;
    check((await socketsUnder(directory)).length===0,'Help probes created no Unix listener: no Herdr app or core started');
    // Toy actors behind the exact /usr/bin/env argv wrapper.
    const toys=await writeToys(directory),roots=await makeRoots(directory,{codex:['a','b'],claude:['a','b']}),ownRoots=Object.values(roots).flatMap(r=>Object.values(r));
    const probe=(argv,extra={})=>{const r=spawnSync(ENV,argv,{env:{...env,...extra},cwd:directory,encoding:'utf8',timeout:10000});assert.equal(r.status,0,r.stderr);return {record:JSON.parse(r.stdout.trim()),stdout:r.stdout};};
    for(const provider of Object.keys(PROVIDERS)){
      const root=roots[provider].a,{record}=probe([PROVIDERS[provider].variable+'='+root,toys.tools[provider].file,'--probe-env']);
      check(same(assessRecord(record,{provider,root,ownRoots:ownRoots.filter(r=>r!==root),toy:toys.tools[provider].file,folder:directory,home:env.HOME,session:env.HC_SESSION,args:['--probe-env'],terminal:false}),{ok:true,value:root,extra:[]}),provider+' toy reports only its intended root through /usr/bin/env');
      check(same(assessRecord(record,{provider,root:roots[provider].b,ownRoots:[root],toy:toys.tools[provider].file,args:['--probe-env'],terminal:false}).kind,'unsafe'),provider+' toy evidence flags a cross-profile root as unsafe');
    }
    const plain=probe([toys.tools.codex.file,'--probe-env']).record;
    check(assessRecord(plain,{provider:'codex',root:roots.codex.a,toy:toys.tools.codex.file,args:['--probe-env'],terminal:false}).requirement==='profile routing'&&assessRecord(plain,{provider:'codex',root:null,ownRoots,toy:toys.tools.codex.file,args:['--probe-env'],terminal:false}).ok,'An unwrapped toy has no profile root: missing routing is unsupported, the baseline is clean');
    const leaked=probe(['CODEX_HOME='+roots.codex.a,'CLAUDE_CONFIG_DIR='+roots.claude.a,toys.tools.codex.file,'--probe-env']).record;
    check(assessRecord(leaked,{provider:'codex',root:roots.codex.a,toy:toys.tools.codex.file,args:['--probe-env'],terminal:false}).kind==='unsafe','A second provider root in one toy is an unsafe leak');
    const secret=probe(['CODEX_HOME='+roots.codex.a,toys.tools.codex.file,'--probe-env'],{QA_FIXTURE_API_KEY:'fixture-value-never-recorded'});
    check(secret.record.env.sensitiveNames.includes('QA_FIXTURE_API_KEY')&&!secret.stdout.includes('fixture-value-never-recorded')&&assessRecord(secret.record,{provider:'codex',root:roots.codex.a,toy:toys.tools.codex.file,args:['--probe-env'],terminal:false}).requirement==='credential isolation','Toys record only credential-like names, never values, and such names fail the gate');
    const control=probe(['CODEX_HOME='+roots.codex.a,toys.tools.codex.file,'--probe-env'],{HC_FIXTURE_TOKEN:'x',CLAUDECODE:'1'}),controlVerdict=assessRecord(control.record,{provider:'codex',root:roots.codex.a,toy:toys.tools.codex.file,args:['--probe-env'],terminal:false});
    check(controlVerdict.ok&&same(controlVerdict.extra,['CLAUDECODE'])&&control.record.env.controlNames.includes('HC_FIXTURE_TOKEN')&&!control.record.env.sensitiveNames.length,'Herdr control names and non-profile provider names are recorded as names, not treated as profile or credential routing');
    check(assessRecord({...plain,argv0:'/opt/homebrew/bin/codex'},{provider:'codex',root:null,toy:toys.tools.codex.file,args:['--probe-env'],terminal:false}).requirement==='tool identity','A real provider executable is never accepted as the toy');
    check(assessRecord({...plain,env:{...plain.env,values:{...plain.env.values,HOME:'/elsewhere'}}},{provider:'codex',root:null,toy:toys.tools.codex.file,home:env.HOME,args:['--probe-env'],terminal:false}).requirement==='machine identity','A process under another machine home is an unsafe routing');
    const assignment=spawnSync('CODEX_HOME='+roots.codex.a,[toys.tools.codex.file],{env,cwd:directory});
    check(assignment.error?.code==='ENOENT','An assignment word is a program name to execvp, not an environment selector');
    // Interactive toy: env exec keeps the PID, OSC 7501 report, task input recorded.
    const child=spawn(ENV,['CLAUDE_CONFIG_DIR='+roots.claude.b,toys.tools.claude.file],{env,cwd:directory,stdio:['pipe','pipe','pipe']});children.push(child);let output='';child.stdout.on('data',bytes=>{output+=bytes;});
    const started=await waitFor(()=>toys.byPid(child.pid),'interactive toy record',10000);
    check(started.pid===child.pid&&started.argv0===toys.tools.claude.file,'/usr/bin/env execs the toy in place: the wrapper PID is the agent PID Herdr sees');
    child.stdin.write('qa fixture task word\r');
    const received=await waitFor(async()=>{const r=await toys.byPid(child.pid);return r?.received?.includes('qa fixture task word')?r:null;},'toy stdin',10000);
    check(same(assessRecord(received,{provider:'claude',root:roots.claude.b,ownRoots:ownRoots.filter(r=>r!==roots.claude.b),toy:toys.tools.claude.file,folder:directory,home:env.HOME,session:env.HC_SESSION,terminal:false}),{ok:true,value:roots.claude.b,extra:[]}),'Interactive claude toy records its task input under profile B only');
    child.stdin.end();const code=await new Promise(resolve=>child.exitCode!==null?resolve(child.exitCode):child.once('exit',resolve));
    check(code===0&&output.includes('\u001b]7501;state=idle:app=claude-code\u001b\\'),'Toy reports agent status by OSC 7501 and exits on end of input');
    check((await filesUnder(ownRoots)).length===0,'Toys write nothing into profile roots');
    // Argv, address and classification rules.
    const wrap=['/usr/bin/env','CODEX_HOME=/r','/t/codex'];
    check(wrappedArgv(['/bin/zsh','-lic','"$@"; exec "$0" -li','/bin/zsh',...wrap],wrap)&&wrappedArgv(wrap,wrap)&&!wrappedArgv(['/bin/zsh','-lic','x','/bin/zsh',...wrap],wrap)&&!wrappedArgv(['/t/codex'],wrap),'Argv check accepts only the exact launch or the observed login-shell wrapper around it');
    check(sameAddress({address:'t3'},'t3')&&!sameAddress({address:'t3',machine:HOST},'t3')&&sameAddress({address:HOST+'/t3'},'t3',HOST)&&!sameAddress({address:'t3'},'t3',HOST),'Local and machine-qualified terminal addresses never alias');
    const agent=(address,key,app,shell=false)=>({address,status:'idle',app,program:{key,name:key,agent:!shell,shell}});
    check(assessClassification({agents:[agent('t4','codex','codex')],terminals:[]},{local:'t4',provider:'codex'}).ok&&assessClassification({agents:[agent('t5','claude','claude-code')],terminals:[]},{local:'t5',provider:'claude'}).ok,'Codex and Claude toys classify as their Herdr agents');
    check(/shell/.test(assessClassification({agents:[],terminals:[{address:'t6',program:{key:'shell',agent:false,shell:true}}]},{local:'t6',provider:'codex'}).detail)&&/not as an agent/.test(assessClassification({agents:[],terminals:[{address:'t7',program:{key:'program',agent:false,shell:false}}]},{local:'t7',provider:'codex'}).detail)&&/reports app/.test(assessClassification({agents:[agent('t8','claude','codex')],terminals:[]},{local:'t8',provider:'claude'}).detail),'Shell, plain-program and wrong-app classifications fail');
    // Probe mod under the strict GPUI recording seam (not a renderer): init, publish, click, profile switch, close.
    await import(pathToFileURL(path.join(ROOT,'tests/support/native-loader.mjs')).href);
    const recording=await import(pathToFileURL(path.join(ROOT,'tests/support/native-recording.mjs')).href);
    const probeFile=path.join(directory,'probe','main.mjs');await fs.mkdir(path.dirname(probeFile),{recursive:true});await fs.writeFile(probeFile,probeSource());
    const {default:Probe}=await import(pathToFileURL(probeFile).href);
    const runs=[];let known=[{key:'codex',run:wrap,installed:true,agent:true},{key:'claude',run:[ENV,'CLAUDE_CONFIG_DIR=/a','/t/claude'],installed:true,agent:true},{key:'pi',run:['pi'],installed:true}];
    recording.injectNative({agents:()=>[agent('t4','codex','codex')],terminals:()=>[{address:'t4',state:'live',status:'idle',program:{key:'codex',name:'Codex',agent:true,shell:false},argv:['/bin/zsh','-lic','"$@"; exec "$0" -li','/bin/zsh',...wrap],labels:{'herdr.space':'s1'}}],knownAgents:async()=>known,run:(name,args)=>{runs.push([name,args]);return null;}});
    const cx=recording.context(),timers=[];cx.timer.every=(ms,fn)=>{const timer={ms,fn,cancelled:false,cancel(){timer.cancelled=true;}};timers.push(timer);return timer;};
    const view=new Probe();view.init({space:'s1',folder:'/repo',task:'qa profile task word'},cx);await Promise.all(view.jobs);
    let state=recording.shared(KEY);
    check(timers.length===1&&timers[0].ms===1000&&same(state.known.map(a=>a.key),['codex','claude'])&&state.agents[0].program.key==='codex'&&state.terminals[0].argv.length===7&&!('labels' in state.terminals[0]),'Probe publishes bounded knownAgents()/agents()/terminals() classification');
    recording.trigger(view.render(cx),'qa-input-check','on_click',{},cx);
    check(recording.shared(KEY).inputs===1&&runs.length===0,'Native input check button counts clicks without launching anything');
    recording.trigger(view.render(cx),'qa-start-codex','on_click',{},cx);await Promise.all(view.jobs);state=recording.shared(KEY);
    check(same(runs[0],['tab.new',{space:'s1',folder:'/repo',name:'qa-click-codex-1',argv:wrap,task:'qa profile task word click codex 1'}])&&state.clicks[0].state==='sent'&&same(state.clicks[0].argv,wrap),'Probe click launches through run("tab.new") with the current knownAgents() run and a unique task');
    known=[{...known[0],run:[ENV,'CODEX_HOME=/b','/t/codex']},{...known[1],installed:false}];timers[0].fn(cx);await Promise.all(view.jobs);
    check(same(recording.shared(KEY).known[0].run,[ENV,'CODEX_HOME=/b','/t/codex']),'Probe republishes knownAgents() after programs.json changes');
    recording.trigger(view.render(cx),'qa-start-claude','on_click',{},cx);await Promise.all(view.jobs);
    check(runs.length===1&&recording.shared(KEY).clicks[1].state==='unavailable','An uninstalled knownAgents() entry is reported, never launched');
    recording.trigger(view.render(cx),'qa-start-codex','on_click',{},cx);await Promise.all(view.jobs);
    check(same(runs[1][1].argv,[ENV,'CODEX_HOME=/b','/t/codex'])&&runs[1][1].name==='qa-click-codex-3','A later click uses the switched profile run');
    view.close();check(timers.every(t=>t.cancelled),'Probe cancels its timer on close');
    check((await socketsUnder(directory)).length===0,'Fixture check ends without any Unix listener');
    return {ok:true,assertions,versions:capabilities.versions,capabilities:{hcRunEnv:capabilities.hcRun.env,hcExecEnv:capabilities.hcExec.env,appEnvArgument:capabilities.appEnvArgument,tabNew:capabilities.launch['tab.new']},boundary:'Static help with private selectors, disposable toy actors and the private probe mod under the strict GPUI recording seam only. No Herdr app/core was constructed, queried or stopped; no receipt or preview was written.'};
  }finally{for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await fs.rm(directory,{recursive:true,force:true});}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv[2]!=='fixture-check'){console.error('Use node scripts/native-harness.mjs run account-profile for the mounted gate, or fixture-check for the core-free preflight.');process.exitCode=2;}
  else checkFixtures().then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(error);process.exitCode=1;});
}
