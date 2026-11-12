import fs from 'node:fs/promises';
import sync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {NativeRuntime,run,until,validateNativeIsolationReceipt} from '../../scripts/native-harness.mjs';
import {BindingStore,argvSessionProof} from '../../src/shared/session-bindings.js';
import {terminalIdentity,localTerminalAddress} from '../../src/shared/session-identity.js';
import {ClosedJournal,ClosedWatcher,LIMITS,HISTORY_WRAPPER,hostKey} from '../../src/shared/closed-tabs.js';
import {parseCapabilities} from '../../src/shared/tool-capabilities.js';
import {reopen as reopenAction,selectRecord,restorePlan,reopenPreview} from '../../src/shared/reopen.js';

/*
 * Mounted proof for the standalone mission-control-reopen mod. One private app/core plus a second
 * positively owned private core reached through `hc machine add --via` (qa-server). Every close,
 * rename, reopen, retry and key command below is real PID-bound native input; app/hc commands are
 * fixture setup or read-only observation. Fixtures (actors, repos, provider roots) live under the
 * private runtime directories only. The preview frame is promoted only by `promote-preview`, after
 * the harness has written and validated a passing receipt.
 */
const MOD='mission-control-reopen',HOST='qa-server',KEY='ctrl-shift-y',COMMAND_EVENT='mission-control-reopen-command-v1',PREVIEW='reopen-preview',RECEIPT='evidence/native/reopen.json';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const execute=promisify(execFile),delay=ms=>new Promise(resolve=>setTimeout(resolve,ms)),sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const localId=(id,machine)=>machine&&id.startsWith(machine+'/')?id.slice(machine.length+1):id;
const sessionFor=(machine,providerRoot,credentialScope)=>({machine,provider:'claude',credentialScope,providerRoot,sessionId:crypto.randomUUID()});
const usageSource=(machine,providerRoot,credentialScope)=>({v:1,enabled:true,machine,provider:'claude',credentialScope,providerRoot,roots:[providerRoot+'/projects']});
function bounded(promise,ms,label){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Timed out: '+label)),ms);})]).finally(()=>clearTimeout(timer));}

/** Node-side CAS file access with the same expected-bytes contract as Herdr's writeTextFile. */
export function fileIO(home){
  const read=async file=>{try{return await fs.readFile(file,'utf8');}catch(error){if(error.code==='ENOENT')return null;throw error;}};
  return {appHome:()=>home,ensureDirectory:directory=>fs.mkdir(directory,{recursive:true}),readTextFile:read,
    async writeTextFile(file,text,expected){if(await read(file)!==(expected??null))throw Object.assign(Error('stale'),{code:'STALE'});const next=file+'.'+crypto.randomBytes(6).toString('hex');await fs.writeFile(next,text);await fs.rename(next,file);}};
}

/** Disposable Claude-shaped actor: verified help, exact argv/cwd/pid records, Herdr agent status, no provider call. */
export function actorSource(directory,legacyFlag,rootsFile){return String.raw`#!/usr/bin/env python3
import os,sys,json,select,time
if '--help' in sys.argv[1:]:
 lines=['Claude Code QA fixture','Usage: claude [options] [prompt]',' --session-id <uuid>']
 if not os.path.exists(${JSON.stringify(legacyFlag)}): lines.append(' --resume [value]')
 lines.append(' --model <model>')
 print(chr(10).join(lines))
 sys.exit(0)
if '--version' in sys.argv[1:]:
 print('Native reopen fixture 1.0')
 sys.exit(0)
directory=${JSON.stringify(directory)}
record={'tool':'claude','pid':os.getpid(),'cwd':os.getcwd(),'argv':sys.argv[1:],'startedMs':int(time.time()*1000)}
file=os.path.join(directory,str(os.getpid())+'.json')
with open(file+'.next','w') as output: json.dump(record,output)
os.replace(file+'.next',file)
# Like Claude Code: a PID record naming this process's exact session, written into every configured profile root.
import subprocess,uuid
args=sys.argv[1:];sid=None
for i,a in enumerate(args):
 if a in ('--session-id','--resume') and i+1<len(args): sid=args[i+1]
sid=sid or str(uuid.uuid4())
try:
 roots=json.load(open(${JSON.stringify(rootsFile)}))
except Exception:
 roots=[]
start=' '.join(subprocess.run(['ps','-o','lstart=','-p',str(os.getpid())],capture_output=True,text=True,env=dict(os.environ,TZ='UTC',LC_ALL='C')).stdout.split())
for root in roots:
 os.makedirs(os.path.join(root,'sessions'),exist_ok=True)
 with open(os.path.join(root,'sessions',str(os.getpid())+'.json'),'w') as output: json.dump({'pid':os.getpid(),'kind':'interactive','sessionId':sid,'cwd':os.getcwd(),'procStart':start,'startedAt':int(time.time()*1000),'pidDomain':'darwin'},output)
print('Disposable reopen actor; no provider call.',flush=True)
while True:
 print('\x1b]7501;state=idle:app=claude-code\x1b\\',end='',flush=True)
 ready,_,_=select.select([sys.stdin],[],[],2)
 if ready:
  data=os.read(sys.stdin.fileno(),65536)
  if not data: break
  if b'quit' in data: sys.exit(0)
`;}

/** Grok-shaped actor: verified help, the one events.jsonl it holds open (as Grok does), Herdr agent status. */
export function grokSource(directory){return String.raw`#!/usr/bin/env python3
import os,sys,json,select,time,uuid,urllib.parse
args=sys.argv[1:]
if '--help' in args:
 print('Grok Build TUI QA fixture'+chr(10)+'Usage: grok [options]'+chr(10)+' --resume <id>')
 sys.exit(0)
if '--version' in args:
 print('Native grok fixture 1.0')
 sys.exit(0)
sid=None
for i,a in enumerate(args):
 if a=='--resume' and i+1<len(args): sid=args[i+1]
sid=sid or str(uuid.uuid4())
folder=os.path.join(os.path.expanduser('~'),'.grok','sessions',urllib.parse.quote(os.getcwd(),safe=''),sid)
os.makedirs(folder,exist_ok=True)
events=open(os.path.join(folder,'events.jsonl'),'a')
record={'tool':'grok','pid':os.getpid(),'cwd':os.getcwd(),'argv':args,'sessionId':sid,'startedMs':int(time.time()*1000)}
file=os.path.join(${JSON.stringify(directory)},str(os.getpid())+'.json')
with open(file+'.next','w') as output: json.dump(record,output)
os.replace(file+'.next',file)
print('Disposable Grok actor; no provider call.',flush=True)
while True:
 print('\x1b]7501;state=idle:app=grok-build\x1b\\',end='',flush=True)
 ready,_,_=select.select([sys.stdin],[],[],2)
 if ready:
  data=os.read(sys.stdin.fileno(),65536)
  if not data or b'quit' in data: break
`;}

/** Codex-shaped actor: verified help and resume help, a session file, and the real installed Mission Control hook run as Codex runs it. */
export function codexSource(directory){return String.raw`#!/usr/bin/env python3
import os,sys,json,select,subprocess,time,uuid
args=sys.argv[1:]
if args[:1]==['resume'] and '--help' in args:
 print('Usage: codex resume [OPTIONS] [SESSION_ID] [PROMPT]')
 sys.exit(0)
if '--help' in args:
 print('Codex CLI QA fixture'+chr(10)+'Usage: codex [OPTIONS] [PROMPT]')
 sys.exit(0)
if '--version' in args:
 print('Native codex fixture 1.0')
 sys.exit(0)
resumed='resume' in args and args.index('resume')+1<len(args)
sid=args[args.index('resume')+1] if resumed else str(uuid.uuid4())
home=os.environ.get('CODEX_HOME') or os.path.expanduser('~/.codex')
folder=os.path.join(home,'sessions',time.strftime('%Y/%m/%d'))
os.makedirs(folder,exist_ok=True)
transcript=os.path.join(folder,'rollout-'+time.strftime('%Y-%m-%dT%H-%M-%S')+'-'+sid+'.jsonl')
with open(transcript,'a') as output:
 output.write(json.dumps({'type':'session_meta','payload':{'id':sid,'session_id':sid,'cwd':os.getcwd(),'source':'cli','thread_source':'user','base_instructions':'q'*30000}})+chr(10))
hook=os.path.join(home,'mission-control-session-hook.py')
hooked=None
if os.path.exists(hook):
 event={'session_id':sid,'transcript_path':transcript,'cwd':os.getcwd(),'hook_event_name':'SessionStart','model':'qa','permission_mode':'default','source':'resume' if resumed else 'startup'}
 p=subprocess.run(['python3',hook],input=json.dumps(event).encode(),capture_output=True,timeout=15)
 hooked={'code':p.returncode,'stdout':p.stdout.decode('utf-8','replace')}
record={'tool':'codex','pid':os.getpid(),'cwd':os.getcwd(),'argv':args,'sessionId':sid,'hooked':hooked,'startedMs':int(time.time()*1000)}
file=os.path.join(${JSON.stringify(directory)},str(os.getpid())+'.json')
with open(file+'.next','w') as output: json.dump(record,output)
os.replace(file+'.next',file)
print('Disposable Codex actor; no provider call.',flush=True)
while True:
 print('\x1b]7501;state=idle:app=codex\x1b\\',end='',flush=True)
 ready,_,_=select.select([sys.stdin],[],[],2)
 if ready:
  data=os.read(sys.stdin.fileno(),65536)
  if not data or b'quit' in data: break
`;}

/** Transport for the second private core. The gate file refuses new connections and drops the live one. */
export function viaSource(selectors,gate){return String.raw`#!/usr/bin/env python3
import os,sys,json,signal,subprocess
gate=${JSON.stringify(gate)}
if os.path.exists(gate): sys.exit(75)
environment=os.environ.copy()
environment.update(json.loads(${JSON.stringify(JSON.stringify(selectors))}))
child=subprocess.Popen(['/bin/sh','-c',sys.argv[-1]],env=environment,preexec_fn=os.setpgrp)
def drop(*_):
 try: os.killpg(child.pid,signal.SIGTERM)
 except ProcessLookupError: pass
 try: child.wait(timeout=3)
 except subprocess.TimeoutExpired:
  try: os.killpg(child.pid,signal.SIGKILL)
  except ProcessLookupError: pass
 sys.exit(75)
signal.signal(signal.SIGTERM,drop)
signal.signal(signal.SIGHUP,drop)
while True:
 try:
  sys.exit(child.wait(timeout=0.25))
 except subprocess.TimeoutExpired:
  pass
 if os.path.exists(gate): drop()
`;}

export async function writeFixtures(directory){
  const actorDir=path.join(directory,'actor-runs'),actor=path.join(directory,'qa-claude'),legacyFlag=path.join(directory,'qa-claude-without-resume'),rootsFile=path.join(directory,'claude-roots.json');
  const grok=path.join(directory,'qa-grok'),codex=path.join(directory,'qa-codex');
  await fs.mkdir(actorDir,{recursive:true});await fs.writeFile(actor,actorSource(actorDir,legacyFlag,rootsFile));await fs.chmod(actor,0o700);
  await fs.writeFile(grok,grokSource(actorDir));await fs.chmod(grok,0o700);await fs.writeFile(codex,codexSource(actorDir));await fs.chmod(codex,0o700);
  return {actor,actorDir,legacyFlag,rootsFile,grok,codex};
}
export async function readRuns(directory){const runs=[];for(const name of await fs.readdir(directory))if(/^[0-9]+\.json$/.test(name))try{runs.push(JSON.parse(await fs.readFile(path.join(directory,name),'utf8')));}catch{}return runs;}

/** Commits an exact session the way an acknowledged Mission Control launch/resume does: proven argv on that host's terminal generation. */
export async function commitExact(bindings,{machine,ack,raw,session,program,argv,requestId,originId,kind}){
  const terminal=terminalIdentity(raw,machine),capabilities={machine,provider:'claude',run:[program],callerSession:'--session-id',resume:{kind:'flag',flag:'--resume'}};
  await bindings.propose({requestId,originId,session});
  await bindings.commitAcknowledged(requestId,{tabId:ack.tab,terminal},argvSessionProof({capabilities,session,terminal,argv,kind,observedAt:Date.now(),sourceDigest:sha(JSON.stringify(raw.argv??argv))}));
  return terminal;
}

export function reopenLayout(copies=2){
  const block=(id,mod,size)=>({id,type:'block',...(size?{size:{px:size}}:{}),content:{mod}});
  return {id:'qa-root',type:'column',titlebar:'none',traffic_lights:[12,16],theme:'graphite',children:[block('tabs','tabs',42),{id:'terminal',type:'block',content:{tab:'active'}},...Array.from({length:copies},(_,index)=>block('reopen-'+(index+1),MOD,28))]};
}

const POSITION=String.raw`import Cocoa
import ApplicationServices
let pid=Int32(CommandLine.arguments[1])!
func fail(_ message:String)->Never {FileHandle.standardError.write(message.data(using:.utf8)!);exit(2)}
guard let application=NSRunningApplication(processIdentifier:pid) else {fail("Owned app is unavailable")}
application.activate()
var raw:CFTypeRef?
guard AXUIElementCopyAttributeValue(AXUIElementCreateApplication(pid),kAXWindowsAttribute as CFString,&raw) == .success,let windows=raw as? [AXUIElement] else {fail("Owned AX windows unavailable")}
let main=windows.filter {window in
 var value:CFTypeRef?
 guard AXUIElementCopyAttributeValue(window,kAXSizeAttribute as CFString,&value) == .success,let v=value,CFGetTypeID(v)==AXValueGetTypeID() else {return false}
 var size=CGSize.zero
 return AXValueGetValue(v as! AXValue,.cgSize,&size) && size.width>=800 && size.height>=600
}
guard main.count==1 else {fail("A unique owned main window is required")}
var actual:pid_t=0
AXUIElementGetPid(main[0],&actual)
guard actual==pid else {fail("Owned AX PID changed")}
var full:CFTypeRef?
if AXUIElementCopyAttributeValue(main[0],"AXFullScreen" as CFString,&full) == .success,let enabled=full as? Bool,enabled {
 guard AXUIElementSetAttributeValue(main[0],"AXFullScreen" as CFString,kCFBooleanFalse) == .success else {fail("Owned fullscreen exit failed")}
 print(#"{"retry":true}"#);exit(0)
}
var size=CGSize(width:1280,height:760),point=CGPoint(x:300,y:350)
guard let s=AXValueCreate(.cgSize,&size),let p=AXValueCreate(.cgPoint,&point),AXUIElementSetAttributeValue(main[0],kAXSizeAttribute as CFString,s) == .success,AXUIElementSetAttributeValue(main[0],kAXPositionAttribute as CFString,p) == .success else {fail("Owned window positioning failed")}
_ = AXUIElementPerformAction(main[0],kAXRaiseAction as CFString)
let all=CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements],kCGNullWindowID) as? [[String:Any]] ?? []
let owned=all.filter {record in
 guard (record[kCGWindowOwnerPID as String] as? Int)==Int(pid),(record[kCGWindowLayer as String] as? Int)==0,let b=record[kCGWindowBounds as String] as? [String:Any],let r=CGRect(dictionaryRepresentation:b as CFDictionary) else {return false}
 return r.width>=800 && r.height>=600
}
guard owned.count==1,let id=owned[0][kCGWindowNumber as String] as? Int else {fail("A unique owned visible window is required")}
let data=try! JSONSerialization.data(withJSONObject:["windowId":id]);FileHandle.standardOutput.write(data)
`;
export async function positionWindow(runtime,{compileOnly=false,directory=runtime.directory,cache=path.join(ROOT,'.harness/swift-cache')}={}){
  const source=path.join(directory,'reopen-position.swift'),binary=path.join(directory,'reopen-position');
  await fs.writeFile(source,POSITION);run('swiftc',['-module-cache-path',cache,source,'-o',binary],{json:false,timeout:120000});
  if(compileOnly)return binary;
  await until(async()=>{const result=run(binary,[String(runtime.owner.pid)]);if(result.retry)return false;const frame=await runtime.driver.bindWindow(result.windowId);return Math.abs(frame.width-1280)<2&&Math.abs(frame.height-760)<2&&Math.abs(frame.x-300)<2&&Math.abs(frame.y-350)<2;},'owned Reopen window position and native input bounds');
}

async function bindKey(home){
  const file=path.join(home,'keys.json'),read=async()=>{try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}};
  // Herdr writes its own key map into a fresh home; merge into it rather than replacing it.
  let keys=null;for(let attempt=0;attempt<20&&!keys;attempt++){keys=await read();if(!keys)await delay(250);}keys??={};
  assert.ok(!Object.values(keys).some(section=>section&&typeof section==='object'&&Object.hasOwn(section,KEY)),'The private fixture key must be unbound before it is bound to the Reopen command');
  keys.global={...(keys.global||{}),[KEY]:MOD+'.reopen-agent'};await fs.writeFile(file,JSON.stringify(keys,null,2)+'\n');await delay(1500);
  assert.equal(await fs.access(path.join(home,'keys.error')).then(()=>true,()=>false),false,'Herdr accepted the private Reopen key binding');
}

/** OCR observation and PID-bound input helpers shared by the full gate and the empty-state proof. */
function nativeUI(runtime,{copies=2}={}){
  let serial=0;const bars=28*(copies+1)+4;
  const inTabs=n=>n.frame.y<42,inBars=(n,o)=>n.frame.y>o.window.height-bars,inBody=n=>n.frame.y>=42;
  const observe=async(query='')=>{
    if(++serial>700)throw Error('Native Reopen observation budget exhausted');
    const frame=await runtime.frame('reopen-observe-'+serial),observation=await runtime.driver.ocr(path.join(ROOT,frame.path),query);
    const banner=observation.lines.find(n=>/\binterrupted\b|could not be re.?rendered|render(?:ing)? (?:error|failed)/i.test(n.text));
    if(banner)throw Error('Native render/action error banner: '+banner.text);return observation;
  };
  // A control can still be moving after a status or focus change: act only once two frames agree.
  const pick=async(query,where,{index=0,min=1,only=false,description=query}={})=>{
    let prior=null,hit=null;
    await until(async()=>{const o=await observe(query),m=o.matches.filter(n=>n.confidence>=0.6&&where(n,o)).sort((a,b)=>a.frame.y-b.frame.y||a.frame.x-b.frame.x),node=index==='last'?m.at(-1):m[index];if(m.length<min||only&&m.length!==1||!node)return false;const box=JSON.stringify(node.frame);if(box===prior){hit={observation:o,node,count:m.length};return true;}prior=box;return false;},'steady native control '+description,45000);
    return hit;
  };
  const click=async(query,where,options={})=>{const hit=await pick(query,where,options);await runtime.driver.clickObservedText(hit.observation,hit.node);if(options.control)runtime.driver.actions.at(-1).control=options.control;return hit;};
  const has=async(query,where=()=>true)=>{const o=await observe(query);return o.matches.some(n=>n.confidence>=0.6&&where(n,o));};
  const visible=(query,where=()=>true)=>until(async()=>{const o=await observe(query);return o.matches.some(n=>n.confidence>=0.6&&where(n,o))?o:null;},'visible native text '+query,45000);
  const pill=async(label,index=0)=>click(label,(n,o)=>n.text===label&&inBars(n,o),{index,min:copies,description:'mounted '+label,control:label+' copy '+(index+1)});
  const openPopup=async()=>{
    const {observation,node}=await pick('Help',(n,o)=>n.text==='Help'&&inBars(n,o),{min:copies,description:'mounted Reopen Help link'});
    // The more button is the 22 px icon immediately left of Help (6 px gap).
    // A click that lands while the window is still activating only activates it; click again only while no popup is open.
    const open=()=>runtime.app(['status']).overlays?.includes(MOD);
    await until(async()=>{if(!open()){await runtime.driver.click({x:node.frame.x-28,y:node.frame.y+node.frame.height/2-11,width:22,height:22},{expectedSize:observation.window});Object.assign(runtime.driver.actions.at(-1),{control:'Closed tabs and recovery',observation:observation.source});await delay(2000);}return open();},'own Reopen popup',30000).catch(error=>{throw Error(error.message+' status '+JSON.stringify(runtime.app(['status'])).slice(0,1200));});await visible('Recently closed',inBody);
  };
  const closeOverlay=async()=>{await runtime.driver.press('escape');await until(()=>!runtime.app(['status']).overlays?.length,'closed native overlay',20000);};
  const typeKeys=async text=>{for(const character of text)await runtime.driver.press(character===' '?'space':character);await runtime.driver.press('enter');};
  return {observe,pick,click,has,visible,pill,openPopup,closeOverlay,typeKeys,inTabs,inBars,inBody};
}

export default async function reopenNative(runtime){
  const home=runtime.env.HERDR_APP_HOME,io=fileIO(home),bindings=new BindingStore(io),journal=new ClosedJournal(io),server=new NativeRuntime();
  const gate=path.join(runtime.directory,'qa-server-offline'),diagnostics=path.join(ROOT,'.browse/sessions',`mission-control-native-${runtime.nonce}`),fixtures=await writeFixtures(runtime.directory);let connected=false;
  const actorRuns=()=>readRuns(fixtures.actorDir),runsOf=async(flag,id)=>(await actorRuns()).filter(r=>r.argv[0]===flag&&r.argv[1]===id);
  try{
    // Empty startup files keep zsh from running its interactive new-user setup in fixture shells, and a neutral
    // prompt keeps the host and user names out of the published preview (Herdr 0.1.11 starts login /bin/sh shells).
    const shellFixture=async directory=>{await fs.writeFile(path.join(directory,'.zshrc'),'# Disposable native fixture shell\n');await fs.writeFile(path.join(directory,'.profile'),"PS1='$ '\n");};
    await shellFixture(runtime.env.HOME);
    await server.start();await shellFixture(server.env.HOME);
    const selectors=Object.fromEntries(Object.entries(server.env).filter(([key])=>['HOME','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_RUNTIME_DIR','HC_SESSION','HERDR_APP_HOME'].includes(key))),via=path.join(runtime.directory,'reopen-via.py');
    await fs.writeFile(via,viaSource(selectors,gate));await fs.chmod(via,0o700);
    runtime.hc(['machine','add','--via',via,'--name',HOST,'--session',server.env.HC_SESSION,'--json']);connected=true;
    // More finished remote terminals than one bounded import batch reads.
    for(let index=0;index<LIMITS.historyBatch+4;index++)server.hc(['run','--bg','--no-parent','--cwd',server.repo,'--','/usr/bin/true']);
    await until(()=>{const all=server.hc(['ls','--all','--json']);return (all.terminals||[]).filter(t=>t.state!=='live'&&!t.parent).length+(Number.isSafeInteger(all.hidden_finished)?all.hidden_finished:0)>LIMITS.historyBatch;},'remote finished history beyond one import batch',90000);
    const providers={local:path.join(runtime.directory,'providers/claude'),server:path.join(server.directory,'providers/claude')};for(const root of Object.values(providers))await fs.mkdir(path.join(root,'projects'),{recursive:true});
    await fs.mkdir(path.join(home,'mission-control'),{recursive:true});
    await fs.writeFile(path.join(home,'mission-control/config.json'),JSON.stringify({v:1,revision:0,connections:{},bindings:{},preferences:{},usageSources:{'claude-local':usageSource(null,providers.local,'qa-claude-local'),'claude-server':usageSource(HOST,providers.server,'qa-claude-server')}})+'\n');
    await fs.writeFile(path.join(home,'programs.json'),JSON.stringify({programs:{claude:{name:'QA Claude',run:[fixtures.actor]}}})+'\n');
    const linked=path.join(runtime.directory,'linked-checkout'),notes=path.join(runtime.directory,'notes'),scratch=path.join(runtime.directory,'scratch');
    run('git',['-C',runtime.repo,'worktree','add','-q','-b','qa-linked',linked],{env:runtime.env,json:false});for(const directory of [notes,scratch])await fs.mkdir(directory);
    await runtime.installPackage(MOD);
    await fs.writeFile(path.join(home,'window.json'),JSON.stringify({state:'windowed',bounds:[300,350,1280,760]})+'\n');
    await runtime.startWindow({name:'reopen-native',layout:reopenLayout(2)});await positionWindow(runtime);
    const remote=await until(()=>runtime.app(['ls']).spaces?.find(s=>s.machine===HOST),'remote fixture space adoption',60000);
    runtime.app(['do','space.rename',JSON.stringify({id:runtime.spaceId,name:'client-portal'})]);runtime.app(['do','space.rename',JSON.stringify({id:remote.id,name:'server-repo'})]);runtime.app(['do','space.select',JSON.stringify({id:runtime.spaceId})]);
    await bindKey(home);

    const ui=nativeUI(runtime,{copies:2}),{pick,click,has,visible,pill,openPopup,closeOverlay,typeKeys,inTabs,inBars,inBody}=ui;
    // Herdr's own "herdr-core <version> is ready · Open Updates" notice can appear after start and cover the bars' right edge.
    // Close it with its × as a person would (about 28 px right of the link); it is the app's, not this mod's.
    const notice=await until(async()=>{const o=await ui.observe('Open Updates'),n=o.matches.find(m=>m.confidence>=0.6);return n?{o,n}:null;},'Herdr update notice',12000).catch(()=>null);
    if(notice){await runtime.driver.click({x:notice.n.frame.x+notice.n.frame.width+20,y:notice.n.frame.y+notice.n.frame.height/2-8,width:16,height:16},{expectedSize:notice.o.window});Object.assign(runtime.driver.actions.at(-1),{control:'Close the Herdr update notice',observation:notice.o.source});
      await until(async()=>!(await has('Open Updates')),'Herdr update notice closed',20000);}
    const value=async()=>(await journal.read()).value,recordsOf=async(machine,tabId)=>(await value()).records.filter(r=>r.machine===machine&&r.tab.id===tabId);
    const snapshot=async(machine,tabId)=>{const h=(await value()).hosts[hostKey(machine)];return h?.state==='ready'?h.tabs[localId(tabId,machine)]??null:null;};
    const named=async(machine,name)=>Object.values((await value()).hosts[hostKey(machine)]?.tabs||{}).filter(t=>t.named&&t.name===name);
    const hydrated=(machine,tabId,count,label)=>until(async()=>{const t=await snapshot(machine,tabId);return t&&t.terms.length>=count&&t.terms.every(x=>x.createdMs!==null&&x.startCwd!==null)?t:null;},'watcher hydrated '+label,45000);
    // Wait two more watcher periods so a second mounted copy has had every chance to double-record.
    const recorded=async(machine,tabId,label)=>{await until(async()=>(await recordsOf(machine,tabId)).length>0,'observed close record '+label,45000);await delay(LIMITS.observeMs*2+500);return recordsOf(machine,tabId);};
    const world=()=>runtime.app(['ls']).spaces||[],tabsIn=id=>world().find(s=>s.id===id)?.tabs||[],tabIds=id=>new Set(tabsIn(id).map(t=>t.id)),created=(id,before)=>tabsIn(id).filter(t=>!before.has(t.id)),liveTab=id=>world().some(s=>s.tabs?.some(t=>t.id===id));
    const select=(spaceId,tabId)=>{runtime.app(['do','space.select',JSON.stringify({id:spaceId})]);if(tabId)runtime.app(['do','tab.select',JSON.stringify({id:tabId})]);};
    const tabMenu=async(spaceId,tabId,label,item)=>{
      select(spaceId,tabId);const tab=await pick(label,n=>n.text===label&&inTabs(n),{only:true,description:'tab '+label});
      await runtime.driver.click(tab.node.frame,{button:'right',expectedSize:tab.observation.window});Object.assign(runtime.driver.actions.at(-1),{control:'Tab menu '+label,observation:tab.observation.source});
      await until(()=>runtime.app(['status']).overlays?.includes('menu'),'native tab context menu for '+label,20000);
      await click(item,n=>n.text===item&&n.frame.y>tab.node.frame.y&&n.frame.y<tab.node.frame.y+240&&Math.abs(n.frame.x-tab.node.frame.x)<260,{only:true,description:item+' '+label,control:item+' tab '+label});
    };
    const closeTab=async(spaceId,tabId,label)=>{await tabMenu(spaceId,tabId,label,'Close');await until(()=>!liveTab(tabId),'actual native close of '+label,20000);};
    const focusShell=async()=>{const o=await ui.observe();await runtime.driver.click({x:Math.round(o.window.width/4),y:Math.round((42+o.window.height-56)/2),width:24,height:24},{expectedSize:o.window});Object.assign(runtime.driver.actions.at(-1),{control:'Shell pane',observation:o.source});};
    const exactAgent=async(core,machine,{space,folder,name,session,requestId,originId})=>{
      const argv=[fixtures.actor,'--session-id',session.sessionId],ack=runtime.app(['do','tab.new',JSON.stringify({space,folder,name,argv})]),local=localTerminalAddress(ack.terminal,machine);
      // A remote `sh -c` wrapper stays in the foreground with the agent as its child. On a timeout, report what the core and the actor observed.
      let seen=null;const raw=await until(async()=>{const value=core.hc(['get',local,'--json']),runs=await actorRuns(),started=runs.find(r=>r.pid===value.foreground?.pid)||runs.find(r=>{if(!value.foreground?.pid)return false;try{return Number(run('ps',['-o','ppid=','-p',String(r.pid)],{json:false}).trim())===value.foreground.pid;}catch{return false;}});seen={folder,foreground:value.foreground,cwd:value.cwd,argv:value.argv,runs:runs.map(r=>({pid:r.pid,cwd:r.cwd,argv:r.argv}))};return started&&started.cwd===folder&&JSON.stringify(started.argv)===JSON.stringify(argv.slice(1))?value:null;},'exact fixture agent foreground '+name,40000).catch(error=>{throw Error(error.message+' '+JSON.stringify(seen));});
      return {ack,raw,session,terminal:await commitExact(bindings,{machine,ack,raw,session,program:fixtures.actor,argv,requestId,originId,kind:'caller-session-id'})};
    };
    // Polls the journal while a reopen runs: the first read without the record must already see its acknowledged tab.
    const consumption=(recordId,spaceId,before)=>{let stopped=false;const phases=new Set(),result=(async()=>{while(!stopped){let current;try{current=(await value()).records.find(r=>r.id===recordId);}catch{await delay(30);continue;}if(current?.claim)phases.add(current.claim.phase);if(!current)return {phases:[...phases],acknowledged:created(spaceId,before).length===1};await delay(30);}return null;})();return {result,stop(){stopped=true;}};};
    const reopened=async(recordId,spaceId,before,act,label)=>{const watch=consumption(recordId,spaceId,before);try{await act();return await bounded(watch.result,90000,label);}finally{watch.stop();}};

    console.log('Reopen native: empty state on two mounted copies');
    const empty=await pick('Nothing closed yet',inBars,{min:2,description:'two empty Reopen bars'});
    runtime.expect(empty.count>=2&&(await value()).records.length===0,'Two mounted Reopen bars show the empty state before any close');
    const quiet=runtime.hc(['ls','--json']).terminals.length;await pill('Reopen tab');await pill('Reopen agent');await delay(1500);await openPopup();await visible('Nothing to reopen yet',inBody);
    runtime.expect(runtime.hc(['ls','--json']).terminals.length===quiet&&(await value()).records.length===0,'Empty Reopen actions are disabled, start nothing and the popup shows the empty state');
    await closeOverlay();

    console.log('Reopen native: exact agents on two hosts, a split shell and a scratch shell');
    const sessions={local:sessionFor(null,providers.local,'qa-claude-local'),remote:sessionFor(HOST,providers.server,'qa-claude-server')};
    const A=await exactAgent(runtime,null,{space:runtime.spaceId,folder:linked,name:'agent setup',session:sessions.local,requestId:'qa-request-login',originId:'qa-origin-login'});
    const R=await exactAgent(server,HOST,{space:remote.id,folder:server.repo,name:'api review',session:sessions.remote,requestId:'qa-request-api',originId:'qa-origin-api'});
    // Herdr 0.1.11 assigns random tab IDs, so identical local IDs on two hosts no longer occur by chance; closed-tabs.test.mjs covers that collision.
    runtime.expect(A.ack.tab!==R.ack.tab&&A.ack.terminal!==R.ack.terminal&&!A.ack.tab.includes('/')&&R.ack.tab.startsWith(HOST+'/')&&R.ack.terminal.startsWith(HOST+'/')&&Boolean(localTerminalAddress(R.ack.terminal,HOST)),'Local and remote exact agents keep host-qualified tab and terminal identities');
    const S=runtime.app(['do','tab.new',JSON.stringify({space:runtime.spaceId,folder:notes,name:'release notes'})]);select(runtime.spaceId,S.tab);runtime.app(['do','pane.focus',JSON.stringify({terminal:S.terminal})]);
    const splitPane=tabsIn(runtime.spaceId).find(t=>t.id===S.tab)?.terminals?.find(t=>t.terminal===S.terminal)?.pane;runtime.app(['do','pane.split',JSON.stringify({direction:'right',...(typeof splitPane==='string'?{pane:splitPane}:{})})]);
    const D=runtime.app(['do','tab.new',JSON.stringify({space:runtime.spaceId,folder:scratch,name:'scratch pad'})]);
    for(const [machine,tab,count,label]of [[null,A.ack.tab,1,'agent setup'],[HOST,R.ack.tab,1,'api review'],[null,S.tab,2,'release notes'],[null,D.tab,1,'scratch pad']])await hydrated(machine,tab,count,label);

    // The person's own manual rename, through the shipped tab menu and prompt.
    await tabMenu(runtime.spaceId,A.ack.tab,'agent setup','Rename');await until(()=>runtime.app(['status']).overlays?.includes('prompt'),'native rename prompt',20000);
    await pick('Save',(n,o)=>n.text==='Save'&&inBody(n,o)&&!inBars(n,o),{only:true,description:'rename prompt'});await delay(800);await runtime.driver.press('cmd-a');await typeKeys('login fix');
    await until(()=>!runtime.app(['status']).overlays?.length,'closed native rename prompt',20000);
    const renamed=await until(async()=>{const t=await snapshot(null,A.ack.tab);return t?.named&&t.name==='login fix'?t:null;},'native manual rename observed',20000);
    runtime.expect(renamed.terms[0].address===A.ack.terminal,'A native tab-menu rename gives the exact agent a manual name');
    select(runtime.spaceId,S.tab);await focusShell();await typeKeys('cd');await typeKeys('pwd');await typeKeys('echo reopenmarker');
    await until(()=>{const text=runtime.hc(['read',S.terminal,'--lines','40'],{json:false});return text.includes(runtime.env.HOME)&&text.includes('reopenmarker');},'native shell input moved away from its starting folder',20000);
    runtime.expect((await snapshot(null,S.tab)).terms.find(t=>t.address===S.terminal)?.startCwd===notes,'Native typing moves the shell away from the starting folder its record keeps');

    console.log('Reopen native: actual observed closes on both hosts');
    await closeTab(runtime.spaceId,A.ack.tab,'login fix');const [closedA]=await recorded(null,A.ack.tab,'login fix');
    await closeTab(remote.id,R.ack.tab,'api review');const [closedR]=await recorded(HOST,R.ack.tab,'api review');
    await closeTab(runtime.spaceId,S.tab,'release notes');const [closedS]=await recorded(null,S.tab,'release notes');
    const lease=(await value()).lease?.owner;await delay(LIMITS.leaseMs/2+LIMITS.observeMs);const afterCloses=await value();
    runtime.expect([[null,A.ack.tab],[HOST,R.ack.tab],[null,S.tab]].every(([m,t])=>afterCloses.records.filter(r=>r.machine===m&&r.tab.id===t).length===1)&&afterCloses.records.length===3&&/^mission-control-reopen-[0-9a-z]+-[0-9a-z]+-watch$/.test(lease||'')&&afterCloses.lease?.owner===lease,'Two mounted copies keep one lease holder and record each actual close exactly once');
    runtime.expect(closedA.kind==='agent'&&closedA.machine===null&&closedA.terminals[0].session?.sessionId===sessions.local.sessionId&&closedR.kind==='agent'&&closedR.machine===HOST&&closedR.tab.id===R.ack.tab&&closedR.terminals[0].address===R.ack.terminal&&closedR.terminals[0].session?.machine===HOST&&closedR.terminals[0].session.sessionId===sessions.remote.sessionId&&closedA.id!==closedR.id,'Identical local IDs on two hosts become two exact machine-qualified agent records');
    runtime.expect(closedS.kind==='shell'&&closedS.panes===2&&closedS.tab.named&&closedS.tab.name==='release notes'&&closedS.seq>closedR.seq&&closedR.seq>closedA.seq,'The newest close is a named split shell after both agents');
    await openPopup();
    runtime.expect(await has('Reopen last tab',inBody)&&await has('Reopen last agent',inBody)&&await has('api review',inBody)&&await has('release notes',inBody),'The popup separates Reopen last tab from Reopen last agent and lists recent closes');
    await runtime.frame(PREVIEW);await closeOverlay();

    console.log('Reopen native: transient remote disconnect, offline reopen and reconnect');
    await fs.writeFile(gate,'offline\n');await until(async()=>(await value()).hosts[hostKey(HOST)]?.state==='unavailable','remote host observed offline',90000);
    await pill('Reopen agent');await visible('offline or still loading',inBars);const offline=(await value()).records.find(r=>r.id===closedR.id);
    runtime.expect(offline?.error?.code==='HOST_UNAVAILABLE'&&offline.claim===null&&(await runsOf('--resume',sessions.remote.sessionId)).length===0,'An offline host keeps the remote agent record with a visible reason and starts nothing');
    await fs.rm(gate);await until(async()=>{const h=(await value()).hosts[hostKey(HOST)];return h?.state==='ready'&&Object.keys(h.tabs).length>0;},'remote host reconnected and observed again',180000);await delay(LIMITS.observeMs*3);
    runtime.expect(JSON.stringify((await value()).records.filter(r=>r.machine===HOST).map(r=>r.id))===JSON.stringify([closedR.id]),'A transient remote disconnect and reconnect invent no closure');

    console.log('Reopen native: unsupported resume and bounded history import');
    // The popup copy owns its capability cache, so the bars still probe the restored help later.
    await fs.writeFile(fixtures.legacyFlag,'no exact resume\n');await openPopup();
    let prior=null,rowHit=null;
    await until(async()=>{const o=await ui.observe('api review'),anchor=o.lines.find(n=>n.text.trim()==='Recently closed'),m=anchor?o.matches.filter(n=>n.confidence>=0.6&&n.text==='api review'&&n.frame.y>anchor.frame.y+anchor.frame.height):[];if(m.length!==1)return false;const box=JSON.stringify(m[0].frame);if(box===prior){rowHit={observation:o,node:m[0]};return true;}prior=box;return false;},'steady recently closed row api review',45000);
    await runtime.driver.clickObservedText(rowHit.observation,rowHit.node);runtime.driver.actions.at(-1).control='Recently closed api review';
    await visible('no verified exact',inBody);const unsupported=(await value()).records.find(r=>r.id===closedR.id);
    runtime.expect(unsupported?.error?.code==='UNSUPPORTED_RESUME'&&unsupported.claim===null&&(await runsOf('--resume',sessions.remote.sessionId)).length===0,'A tool without verified exact resume keeps the record with a visible reason');
    await fs.rm(fixtures.legacyFlag);const importStarted=Date.now();
    await click('Import older history',(n,o)=>n.text==='Import older history'&&inBody(n,o),{index:'last',description:'Import older history link',control:'Import older history'});
    const imports=await until(async()=>{const i=(await value()).imports;return i[hostKey(null)]?.at>=importStarted&&i[hostKey(HOST)]?.at>=importStarted?i:null;},'bounded history import from both hosts',90000);
    // OCR reads the 0 in the truncated status as the letter O; the journal check below proves the count.
    await visible('older closed tabs from',inBody);const afterImport=await value();
    runtime.expect(imports[hostKey(HOST)].state==='partial'&&afterImport.records.length===3&&afterImport.records.filter(r=>r.machine===HOST).length===1&&!afterImport.records.some(r=>r.source==='imported'),'Overflowing remote history imports partially and keeps exactly one qualified record');
    await closeOverlay();

    console.log('Reopen native: one key command reaches both copies and resumes the remote agent once');
    // A remote `sh -c` wrapper stays in the foreground with the resumed agent as its child.
    const parentOf=pid=>{try{return Number(run('ps',['-o','ppid=','-p',String(pid)],{json:false}).trim());}catch{return null;}};
    const remoteBefore=tabIds(remote.id),localBefore=tabIds(runtime.spaceId);
    const consumedR=await reopened(closedR.id,remote.id,remoteBefore,()=>runtime.driver.press(KEY),'remote record consumed after acknowledgment');
    const [resumedR]=await until(async()=>{const r=await runsOf('--resume',sessions.remote.sessionId);return r.length?r:null;},'exact remote resume actor',30000);await delay(LIMITS.observeMs+1000);
    const tabR=created(remote.id,remoteBefore),rawR=tabR.length===1?server.hc(['get',localTerminalAddress(tabR[0].terminals[0].terminal,HOST),'--json']):null;
    runtime.expect((await runsOf('--resume',sessions.remote.sessionId)).length===1&&tabR.length===1&&created(runtime.spaceId,localBefore).length===0&&resumedR.cwd===server.repo&&(rawR?.foreground?.pid===resumedR.pid||parentOf(resumedR.pid)===rawR?.foreground?.pid)&&rawR.cwd===server.repo&&JSON.stringify(rawR.argv.slice(-3))===JSON.stringify([fixtures.actor,'--resume',sessions.remote.sessionId])&&!rawR.argv.some(a=>a==='--last'||a==='--continue'),'Reopen last agent resumes the exact remote session argv, folder and host once');
    runtime.expect((await runtime.shared())[COMMAND_EVENT]?.command==='reopen-agent'&&!(await has('already being reopened',inBars))&&(await value()).records.length===2,'One key command delivered to both mounted copies consumes the closure once');

    console.log('Reopen native: Reopen last agent skips the newer shell and resumes the local agent');
    const beforeA=tabIds(runtime.spaceId),consumedA=await reopened(closedA.id,runtime.spaceId,beforeA,()=>pill('Reopen agent'),'local agent record consumed after acknowledgment');
    const [resumedA]=await until(async()=>{const r=await runsOf('--resume',sessions.local.sessionId);return r.length?r:null;},'exact local resume actor',30000);
    const tabA=created(runtime.spaceId,beforeA),rawA=tabA.length===1?runtime.hc(['get',localTerminalAddress(tabA[0].terminals[0].terminal,null),'--json']):null;
    const nameA=await until(async()=>{const t=tabA.length===1?await snapshot(null,tabA[0].id):null;return t?.named&&t.name==='login fix'?t:null;},'manual name on the resumed agent tab',30000);await delay(LIMITS.observeMs*2);
    runtime.expect(tabA.length===1&&(await runsOf('--resume',sessions.local.sessionId)).length===1&&resumedA.cwd===linked&&rawA?.foreground?.pid===resumedA.pid&&JSON.stringify(rawA.argv.slice(-3))===JSON.stringify([fixtures.actor,'--resume',sessions.local.sessionId])&&(await recordsOf(null,S.tab)).length===1,'Reopen last agent skips the newer shell tab and resumes the exact local session in its linked checkout');

    console.log('Reopen native: Reopen last tab restores the shell');
    const beforeS=tabIds(runtime.spaceId),consumedS=await reopened(closedS.id,runtime.spaceId,beforeS,()=>pill('Reopen tab'),'shell record consumed after acknowledgment');
    const tabS=created(runtime.spaceId,beforeS),addressS=tabS[0]?.terminals?.[0]?.terminal,snapS=tabS.length===1?await hydrated(null,tabS[0].id,1,'reopened release notes'):null;await delay(1500);
    const rawS=addressS?runtime.hc(['get',addressS,'--json']):null,textS=addressS?runtime.hc(['read',addressS,'--lines','60'],{json:false}):'';
    runtime.expect(tabS.length===1&&tabS[0].terminals?.length===1&&snapS?.panes===1&&snapS.terms[0].startCwd===notes&&rawS?.cwd===notes&&!textS.includes('reopenmarker')&&!(rawS.argv||[]).some(a=>a.includes('reopenmarker')),'Reopen last tab restores the shell in its starting folder with one pane and replays no command');
    runtime.expect(consumedR.acknowledged&&consumedA.acknowledged&&consumedS.acknowledged,'Each record is consumed only after its replacement tab was acknowledged');
    runtime.expect((await named(null,'login fix')).length===1&&(await named(null,'release notes')).length===1&&(await named(HOST,'api review')).length===1&&nameA.terms[0].address===tabA[0].terminals[0].terminal,'Manual tab names return exactly once on their reopened tabs');
    await click('Help',(n,o)=>n.text==='Help'&&inBars(n,o),{min:2,description:'mounted Reopen Help link',control:'Reopen help'});await until(()=>runtime.app(['status']).overlays?.includes(MOD),'own Reopen help dialog',20000);await visible('what comes back',inBody);
    // The help text wraps "never guessed" across lines; "guessed" appears only in that sentence.
    runtime.expect(await has('not recorded',inBody)&&await has('guessed',inBody),'Help states visibly that split panes are not restored and no session is guessed');
    await closeOverlay();

    console.log('Reopen native: already-live exact work is focused, not duplicated');
    await closeTab(runtime.spaceId,tabA[0].id,'login fix');const [closedA2]=await recorded(null,tabA[0].id,'resumed login fix');
    const liveArgv=[fixtures.actor,'--resume',sessions.local.sessionId],live=runtime.app(['do','tab.new',JSON.stringify({space:runtime.spaceId,folder:linked,name:'running elsewhere',argv:liveArgv})]);
    const liveRaw=await until(async()=>{const v=runtime.hc(['get',localTerminalAddress(live.terminal,null),'--json']),started=(await actorRuns()).find(r=>r.pid===v.foreground?.pid);return started?v:null;},'already-live exact session foreground',40000);
    await commitExact(bindings,{machine:null,ack:live,raw:liveRaw,session:sessions.local,program:fixtures.actor,argv:liveArgv,requestId:'qa-request-live',originId:'qa-origin-live',kind:'resume-argv'});
    select(runtime.spaceId,D.tab);const runsLive=(await runsOf('--resume',sessions.local.sessionId)).length,beforeLive=tabIds(runtime.spaceId);await pill('Reopen agent');
    await until(async()=>!(await value()).records.some(r=>r.id===closedA2.id),'already-live record consumed by focus',60000);await until(()=>runtime.app(['status']).tab===live.tab,'focus on the already-live exact agent',20000);await delay(1500);
    runtime.expect(closedA2.kind==='agent'&&closedA2.terminals[0].session?.sessionId===sessions.local.sessionId&&(await runsOf('--resume',sessions.local.sessionId)).length===runsLive&&created(runtime.spaceId,beforeLive).length===0&&runtime.app(['status']).tab===live.tab,'Already-live exact work is focused instead of duplicated');

    console.log('Reopen native: a deleted folder keeps the record until it exists again');
    await closeTab(runtime.spaceId,D.tab,'scratch pad');const [closedD]=await recorded(null,D.tab,'scratch pad');await fs.rm(scratch,{recursive:true});await openPopup();const beforeD=tabIds(runtime.spaceId);
    await click('Reopen last tab',(n,o)=>n.text==='Reopen last tab'&&inBody(n,o),{only:true,description:'popup Reopen last tab',control:'Popup Reopen last tab'});
    await visible('no longer exists',inBody);const missing=(await value()).records.find(r=>r.id===closedD.id);
    runtime.expect(missing?.error?.code==='FOLDER_MISSING'&&missing.claim===null&&created(runtime.spaceId,beforeD).length===0,'A deleted starting folder keeps the record with a visible reason');
    await fs.mkdir(scratch);await click('Retry',(n,o)=>n.text==='Retry'&&inBody(n,o),{only:true,description:'Retry recovery link',control:'Retry reopen'});
    await until(()=>!runtime.app(['status']).overlays?.length,'popup closes after the acknowledged retry',60000);await until(async()=>!(await value()).records.some(r=>r.id===closedD.id),'restored folder record consumed',30000);
    const tabD=created(runtime.spaceId,beforeD),rawD=tabD.length===1?runtime.hc(['get',tabD[0].terminals[0].terminal,'--json']):null;
    runtime.expect(tabD.length===1&&rawD?.cwd===scratch,'Retry reopens the shell once its starting folder exists again');

    console.log('Reopen native: shell-only history and repeated clicks');
    await closeTab(runtime.spaceId,tabS[0].id,'release notes');const [closedS2]=await recorded(null,tabS[0].id,'reopened release notes');
    const quietRuns=(await actorRuns()).length,beforeRepeat=tabIds(runtime.spaceId);await pill('Reopen agent');await delay(2000);
    runtime.expect((await actorRuns()).length===quietRuns&&created(runtime.spaceId,beforeRepeat).length===0&&(await value()).records.some(r=>r.id===closedS2.id),'Reopen last agent skips shell-only tabs and starts nothing');
    const target=await pick('Reopen tab',(n,o)=>n.text==='Reopen tab'&&inBars(n,o),{min:2,description:'mounted Reopen tab'});
    for(let index=0;index<2;index++){await runtime.driver.clickObservedText(target.observation,target.node);runtime.driver.actions.at(-1).control='Reopen tab repeated '+(index+1);}
    await until(async()=>!(await value()).records.some(r=>r.id===closedS2.id),'repeated-click record consumed',60000);await delay(3000);
    runtime.expect(created(runtime.spaceId,beforeRepeat).length===1&&(await named(null,'release notes')).length===1,'Repeated Reopen tab clicks open exactly one tab');

    console.log('Reopen native: final empty state, errors and standalone install');
    await openPopup();await visible('Nothing to reopen yet',inBody);runtime.expect((await value()).records.length===0,'After every reopen the popup shows the empty state again');await closeOverlay();
    console.log('Reopen native: resume after restart');
    // Agents of three tools on both hosts, started as kept core programs and as tab.new wrappers. The person quits one;
    // the terminal process of every other one is SIGKILLed while no Reopen bar runs, so keep recovery restores plain shells.
    const restartJournal=path.join(home,'mission-control/running-agents.json'),readRestart=async()=>{try{return JSON.parse(await fs.readFile(restartJournal,'utf8'));}catch{return null;}};
    const entryOf=async(machine,address)=>(await readRestart())?.machines?.[machine===null?'local':machine]?.terminals?.[address]??null;
    await fs.writeFile(fixtures.rootsFile,JSON.stringify([providers.local,providers.server]));
    await fs.mkdir(path.join(runtime.env.HOME,'.codex'),{recursive:true});
    await fs.writeFile(path.join(home,'programs.json'),JSON.stringify({programs:{claude:{name:'QA Claude',run:[fixtures.actor]},grok:{name:'QA Grok',run:[fixtures.grok]},codex:{name:'QA Codex',run:[fixtures.codex]}}})+'\n');
    await fs.writeFile(path.join(home,'layouts','reopen-bare.json'),JSON.stringify(reopenLayout(0),null,2)+'\n');
    await openPopup();
    await click('Set up Codex resume',(n,o)=>n.text==='Set up Codex resume'&&inBody(n,o),{only:true,description:'Set up Codex resume link',control:'Set up Codex resume'});
    const hooks=await until(async()=>{try{const v=JSON.parse(await fs.readFile(path.join(runtime.env.HOME,'.codex','hooks.json'),'utf8'));return v.hooks?.SessionStart?.some(g=>g.hooks?.some(h=>String(h.command).includes('mission-control-session-hook.py')))?v:null;}catch{return null;}},'Codex session hook installed through the popup',30000);
    runtime.expect(Boolean(hooks)&&sync.existsSync(path.join(runtime.env.HOME,'.codex','mission-control-session-hook.py')),'Set up Codex resume installs the session hook through the native popup');
    await closeOverlay();
    const kept=(core,machine,spaceLocal,{program,args=[],folder,name})=>{const tab='qa-restart-'+name;const ack=core.hc(['run','--bg','--keep','--no-parent','--json','--cwd',folder,'--label','herdr.space='+spaceLocal,'--label','herdr.tab='+tab,'--',program,...args]);return {core,machine,address:localTerminalAddress(ack.address,machine),name};};
    const wrapped=(core,machine,{space,folder,name,session})=>{const ack=runtime.app(['do','tab.new',JSON.stringify({space,folder,name,argv:[fixtures.actor,'--session-id',session]})]);return {core,machine,address:localTerminalAddress(ack.terminal,machine),name};};
    const ids={claude:crypto.randomUUID(),wrappedLocal:crypto.randomUUID(),remote:crypto.randomUUID(),wrappedRemote:crypto.randomUUID(),quit:crypto.randomUUID()};
    const remoteSpace=localId(remote.id,HOST);
    const agents=[
      {...kept(runtime,null,runtime.spaceId,{program:fixtures.actor,args:['--session-id',ids.claude],folder:runtime.repo,name:'claude'}),tool:'claude',session:ids.claude,via:'pid-record',flag:'--resume'},
      {...kept(runtime,null,runtime.spaceId,{program:fixtures.grok,folder:runtime.repo,name:'grok'}),tool:'grok',via:'open-file',flag:'--resume'},
      {...kept(runtime,null,runtime.spaceId,{program:fixtures.codex,folder:runtime.repo,name:'codex'}),tool:'codex',via:'codex-hook',flag:'resume'},
      {...wrapped(runtime,null,{space:runtime.spaceId,folder:runtime.repo,name:'wrapped claude',session:ids.wrappedLocal}),tool:'claude',session:ids.wrappedLocal,via:'pid-record',flag:'--resume'},
      {...kept(server,HOST,remoteSpace,{program:fixtures.actor,args:['--session-id',ids.remote],folder:server.repo,name:'remote-claude'}),tool:'claude',session:ids.remote,via:'pid-record',flag:'--resume'},
      {...wrapped(server,HOST,{space:remote.id,folder:server.repo,name:'remote wrapped',session:ids.wrappedRemote}),tool:'claude',session:ids.wrappedRemote,via:'pid-record',flag:'--resume'}
    ];
    const quitter={...kept(runtime,null,runtime.spaceId,{program:fixtures.actor,args:['--session-id',ids.quit],folder:runtime.repo,name:'quitter'}),session:ids.quit};
    // Grok and Codex choose their own session IDs; read them from the actors' own records.
    for(const a of agents.filter(x=>!x.session)){const raw=a.core.hc(['get',a.address,'--json']);const run=await until(async()=>(await actorRuns()).find(r=>r.tool===a.tool&&r.pid===raw.foreground?.pid),a.tool+' actor started',40000);a.session=run.sessionId;}
    const recordedAll=await until(async()=>{for(const a of [...agents,quitter]){const e=await entryOf(a.machine,a.address);if(e?.state!=='tracking'||e.sessionId!==a.session||(a.via&&e.via!==a.via))return null;}return true;},'every running agent recorded with its exact session',120000).catch(async error=>{throw Error(error.message+' journal '+JSON.stringify(await readRestart()));});
    runtime.expect(recordedAll===true,'Resume after restart records each running agent with its exact session on both hosts');
    runtime.hc(['send',quitter.address,'quit'],{json:false});
    await until(async()=>!(await entryOf(null,quitter.address)),'the quit agent is forgotten',90000);
    const before=new Map();for(const a of agents){const raw=a.core.hc(['get',a.address,'--json']);before.set(a,{pid:raw.pid,created:raw.created_ms,labels:JSON.stringify(raw.labels),foreground:raw.foreground?.pid});}
    const ownerBefore=(await readRestart())?.lease?.owner;
    // The harness stores the window's layout under its own name; switch back to exactly the layout that was showing.
    const shownLayout=runtime.app(['status']).layout;
    runtime.app(['do','layout.switch',JSON.stringify({name:'reopen-bare'})]);await until(()=>runtime.app(['status']).layout==='reopen-bare','layout without Reopen bars shown',30000);
    await until(async()=>!(await readRestart())?.lease,'closed Reopen bars released the restart lease',30000);
    const killTree=pid=>{let kids=[];try{kids=run('pgrep',['-P',String(pid)],{json:false}).split(/\s+/).filter(Boolean).map(Number);}catch{}for(const p of [pid,...kids])try{process.kill(p,'SIGKILL');}catch{}};
    for(const a of agents){const b=before.get(a);killTree(b.pid);if(b.foreground&&b.foreground!==b.pid)killTree(b.foreground);}
    const recovered=await until(()=>agents.every(a=>{const raw=a.core.hc(['get',a.address,'--json']),b=before.get(a);return raw.state==='live'&&raw.pid!==b.pid&&raw.foreground?.pid===raw.pid&&raw.created_ms===b.created&&JSON.stringify(raw.labels)===b.labels;}),'keep recovery gives every killed terminal a shell at its address',60000);
    runtime.expect(recovered===true,'Killed terminal processes come back as shells at the same addresses with the same labels');
    runtime.app(['do','layout.switch',JSON.stringify({name:shownLayout})]);await until(()=>runtime.app(['status']).layout===shownLayout,'Reopen bars mounted again',30000);
    const lostBy=new Map();
    const resumed=await until(async()=>{
      for(const a of agents){const e=await entryOf(a.machine,a.address);if(e?.lostBy&&!lostBy.has(a))lostBy.set(a,e.lostBy);}
      const runs=await actorRuns();return agents.every(a=>runs.some(r=>r.argv.includes(a.flag)&&r.argv[r.argv.indexOf(a.flag)+1]===a.session))?runs:null;
    },'every restored shell resumed its exact session',120000).catch(async error=>{throw Error(error.message+' journal '+JSON.stringify(await readRestart()));});
    runtime.expect(agents.every(a=>lostBy.get(a)&&lostBy.get(a)!==ownerBefore&&/^mission-control-reopen-[0-9a-z]+-[0-9a-z]+-restart$/.test(lostBy.get(a))),'A fresh runner finds every loss from the journal after the Reopen bars were out of the app');
    await delay(15000);
    const resumes=async a=>(await actorRuns()).filter(r=>r.argv.includes(a.flag)&&r.argv[r.argv.indexOf(a.flag)+1]===a.session);
    let exact=true;for(const a of agents){const list=await resumes(a),raw=a.core.hc(['get',a.address,'--json']);const started=list[0];const inTerminal=started&&(raw.foreground?.pid===started.pid);exact=exact&&list.length===1&&inTerminal&&started.cwd===(a.machine?server.repo:runtime.repo);}
    runtime.expect(exact,'Each restored shell receives its exact resume command once on its own host');
    runtime.expect((await actorRuns()).filter(r=>r.argv.includes('--resume')&&r.argv.includes(ids.quit)).length===0,'An agent the person quit is not resumed');
    runtime.app(['do','layout.switch',JSON.stringify({name:'reopen-bare'})]);await until(()=>runtime.app(['status']).layout==='reopen-bare','bars out again',30000);
    runtime.app(['do','layout.switch',JSON.stringify({name:shownLayout})]);await until(()=>runtime.app(['status']).layout===shownLayout,'bars back again',30000);await delay(20000);
    let once=true;for(const a of agents)once=once&&(await resumes(a)).length===1;
    runtime.expect(once,'Reloading the bars and a second mounted copy type nothing more');
    // An exact resume that cannot be verified is offered, never typed; Resume types it once it is verified again.
    await delay(65000);
    const offered={...kept(runtime,null,runtime.spaceId,{program:fixtures.actor,args:['--session-id',ids.quit.replace(/^.{8}/,'0ffe4ed0')],folder:runtime.repo,name:'offered'}),session:ids.quit.replace(/^.{8}/,'0ffe4ed0')};
    await until(async()=>(await entryOf(null,offered.address))?.state==='tracking','offered agent recorded',90000);
    await fs.writeFile(fixtures.legacyFlag,'no exact resume\n');const rawO=runtime.hc(['get',offered.address,'--json']);killTree(rawO.pid);
    await until(async()=>(await entryOf(null,offered.address))?.state==='offered','unverified resume offered',90000);
    await visible('Resume 1 agent',inBars);await fs.rm(fixtures.legacyFlag);
    runtime.expect((await actorRuns()).filter(r=>r.argv.includes('--resume')&&r.argv.includes(offered.session)).length===0,'An unverified resume is offered and never typed');
    await click('Resume 1 agent',(n,o)=>n.text==='Resume 1 agent'&&inBars(n,o),{index:0,min:1,description:'Resume offered agent pill',control:'Resume 1 agent'});
    const offerRun=await until(async()=>(await actorRuns()).find(r=>r.argv.includes('--resume')&&r.argv.includes(offered.session)),'offered agent resumed after the click',60000);await delay(8000);
    runtime.expect(Boolean(offerRun)&&(await actorRuns()).filter(r=>r.argv.includes('--resume')&&r.argv.includes(offered.session)).length===1,'Resume on an offer types its exact command once');
    runtime.expect(runtime.app(['status']).errors?.length===0,'Every reopen workflow produced zero native app errors');
    runtime.expect((await fs.readdir(path.join(home,'mods'))).filter(n=>n.startsWith('mission-control-')).join(',')===MOD,'Only this standalone custom mod is installed');
    // The preview is promoted only by `promote-preview` after the harness validated a passing receipt.
  }catch(error){
    try{
      await fs.mkdir(diagnostics,{recursive:true});
      for(const name of ['closed.json','session-bindings.json','names.json','launches.json','config.json'])try{await fs.copyFile(path.join(home,'mission-control',name),path.join(diagnostics,'reopen-failure-'+name));}catch{}
      await fs.writeFile(path.join(diagnostics,'reopen-native-console.txt'),(runtime.appStdout||'')+'\n'+(runtime.appStderr||''));
      try{await fs.writeFile(path.join(diagnostics,'reopen-failure-actors.json'),JSON.stringify(await actorRuns(),null,2));}catch{}
      try{await fs.writeFile(path.join(diagnostics,'reopen-failure-shared.json'),JSON.stringify(await runtime.shared(),null,2));}catch{}
      try{await fs.writeFile(path.join(diagnostics,'reopen-failure-status.json'),JSON.stringify({status:runtime.app(['status']),world:runtime.app(['ls'])},null,2));await runtime.frame('reopen-failure');}catch{}
    }catch{}
    throw error;
  }finally{
    await fs.rm(gate,{force:true});
    if(connected)try{runtime.hc(['machine','rm',HOST,'--json']);}catch(error){if(error?.code==='INVALID_NATIVE_ISOLATION')throw error;}
    if(server.directory)await server.close();
  }
}

/** Herdr-shaped in-memory world over the real shared modules: no app, no core, no hc. */
function fakeHerdr(home){
  const state={remote:'ready'},raws=new Map(),panes=[],spaces=[{id:'qa-sp-local',name:'client-portal',named:true,machine:null,folder:'/fixture/local',tabs:[]},{id:HOST+'/qa-sp-remote',name:'server-repo',named:true,machine:HOST,folder:'/fixture/server',tabs:[]}];
  const shown=machine=>machine===null||state.remote==='ready';let generation=1000;
  const io={...fileIO(home),machines:()=>[{name:null,layout:'ready'},{name:HOST,layout:state.remote}],spaces:()=>spaces.filter(s=>shown(s.machine)),panes:()=>panes.filter(p=>shown(p.machine)).map(({machine,space,...p})=>p),
    agents:()=>panes.filter(p=>shown(p.machine)&&p.program?.agent).map(p=>({address:p.terminal,space:p.space,tab:p.tab,app:'claude-code',status:'idle'})),terminals:()=>[...raws.values()].filter(r=>r.value.state==='live').map(r=>({address:r.address,state:'live'})),
    exec:async(command,args,{on=null}={})=>{if(command==='hc'&&args[0]==='get'){const raw=raws.get(JSON.stringify([on,args[1]]));return raw?{code:0,stdout:JSON.stringify(raw.value),stderr:''}:{code:1,stdout:'',stderr:''};}throw Error('Unexpected fixture command '+command);}};
  const add=(machine,{tab,name,folder,program,terminals})=>{const space=spaces.find(s=>s.machine===machine);space.tabs.push({id:tab,index:space.tabs.length+1,name,named:true,panes:terminals.length});
    for(const address of terminals){const local=localTerminalAddress(address,machine),value={address:local,created_ms:++generation,state:'live',cwd:folder,foreground:{pid:generation},argv:['/bin/zsh']};raws.set(JSON.stringify([machine,local]),{address,value});panes.push({machine,space:space.id,pane:'p-'+address,tab,terminal:address,cwd:folder,title:name,program,status:program.agent?'idle':null});}};
  const close=(machine,tab)=>{const space=spaces.find(s=>s.machine===machine);space.tabs=space.tabs.filter(t=>t.id!==tab);for(const pane of panes.filter(p=>p.tab===tab)){raws.get(JSON.stringify([machine,localTerminalAddress(pane.terminal,machine)])).value.state='finished';panes.splice(panes.indexOf(pane),1);}};
  return {io,state,add,close,raw:(machine,address)=>raws.get(JSON.stringify([machine,localTerminalAddress(address,machine)])).value};
}
const FAKE_HC=String.raw`#!/bin/sh
n=${'$'}{QA_FAKE_FINISHED:-0}
if [ "$1" = ls ]; then
 printf '{"hidden_finished":0,"terminals":[{"address":"t1","state":"live"}'
 i=2; while [ "$i" -le $((n+1)) ]; do printf ',{"address":"t%d","state":"finished"}' "$i"; i=$((i+1)); done
 printf '],"pad":"'; head -c "${'$'}{QA_FAKE_PAD:-0}" /dev/zero | tr '\000' x; printf '"}'
 exit 0
fi
if [ "$1" = get ]; then
 i=${'$'}{2#t}
 if [ "$i" -eq $((n+1)) ]; then labels='{"herdr.space":"qa-sp","herdr.tab":"tb1"}'; else labels='{}'; fi
 printf '{"address":"%s","state":"finished","created_ms":%d,"finished_ms":%d,"labels":%s,"cwd":"/fixture","argv":["/bin/zsh"]}\n' "$2" $((1000+i)) $((2000+i)) "$labels"
 exit 0
fi
exit 2
`;

/** Core-free preflight: actors, transport gate, history bounds and fixture bindings through the real shared modules. */
export async function checkFixtures(){
  const directory=await fs.realpath(await fs.mkdtemp('/private/tmp/mcqa-')),checks=[];const check=(condition,label)=>{assert.ok(condition,label);checks.push(label);};
  try{
    const fixtures=await writeFixtures(directory),tool={key:'claude',name:'QA Claude',run:[fixtures.actor],installed:true},help=async()=>(await execute(fixtures.actor,['--help'],{timeout:10000})).stdout;
    const verified=parseCapabilities(tool,{help:await help()});check(verified.provider==='claude'&&verified.resume?.flag==='--resume'&&verified.callerSession==='--session-id','Disposable actor help verifies exact resume and caller session IDs');
    await fs.writeFile(fixtures.legacyFlag,'legacy\n');check(parseCapabilities(tool,{help:await help()}).resume===null,'The legacy-help flag removes verified exact resume');await fs.rm(fixtures.legacyFlag);
    const id=crypto.randomUUID(),child=spawn(fixtures.actor,['--session-id',id],{cwd:directory,stdio:['pipe','ignore','ignore']}),exited=new Promise(resolve=>child.once('exit',resolve));
    const started=await until(async()=>(await readRuns(fixtures.actorDir)).find(r=>r.pid===child.pid),'fixture actor record',10000);child.stdin.end();await bounded(exited,10000,'fixture actor exit');
    check(started.cwd===directory&&JSON.stringify(started.argv)===JSON.stringify(['--session-id',id]),'Disposable actor records its exact argv, folder and pid');

    const gate=path.join(directory,'gate'),via=path.join(directory,'via.py');await fs.writeFile(via,viaSource({HC_SESSION:'mcqa-fixture-check'},gate));await fs.chmod(via,0o700);
    check((await execute(via,['ignored','echo "$HC_SESSION"'],{timeout:10000})).stdout.trim()==='mcqa-fixture-check','Via transport applies the second core selectors and passes bytes through');
    await fs.writeFile(gate,'offline\n');const refused=await execute(via,['echo connected'],{timeout:10000}).then(()=>null,error=>error);check(refused?.code===75&&!refused.stdout.includes('connected'),'Via gate refuses a connection while the fixture host is offline');await fs.rm(gate);
    const held=execute(via,['sleep 30'],{timeout:40000}).then(()=>null,error=>error);await delay(700);await fs.writeFile(gate,'offline\n');const dropped=await bounded(held,8000,'via drop');check(dropped?.code===75,'Via gate drops a live connection within seconds');await fs.rm(gate);

    const fakeBin=path.join(directory,'fake-hc');await fs.mkdir(fakeBin);await fs.writeFile(path.join(fakeBin,'hc'),FAKE_HC);await fs.chmod(path.join(fakeBin,'hc'),0o700);
    const wrapper=async env=>JSON.parse((await execute('python3',['-c',HISTORY_WRAPPER,JSON.stringify({v:1,cursor:null,maxBytes:LIMITS.historyBytes,timeoutMs:LIMITS.historyMs,limit:LIMITS.records,batch:LIMITS.historyBatch})],{env:{PATH:fakeBin+':'+process.env.PATH,...env},timeout:20000,maxBuffer:8*1024*1024})).stdout);
    const partial=await wrapper({QA_FAKE_FINISHED:String(LIMITS.historyBatch+4)});
    check(partial.ok===true&&partial.complete===false&&partial.scanned===LIMITS.historyBatch&&typeof partial.cursor==='string'&&partial.records.length===1&&partial.records[0].tab==='tb1','The history wrapper stops at one batch and reports partial history with a cursor');
    const huge=await wrapper({QA_FAKE_FINISHED:'3',QA_FAKE_PAD:String(LIMITS.historyBytes+1024)});check(huge.ok===false&&huge.code==='BYTE_LIMIT','The history wrapper stops reading oversized hc output at 4 MiB');

    const fake=fakeHerdr(path.join(directory,'app')),store=new BindingStore(fake.io),closed=new ClosedJournal(fake.io),watcher=new ClosedWatcher(fake.io,{owner:'fixture-watch'}),tick=async(count=1)=>{for(let index=0;index<count;index++)await watcher.tick();};
    const agent={key:'claude',name:'QA Claude',agent:true},local=sessionFor(null,path.join(directory,'providers/local'),'qa-claude-local'),remote=sessionFor(HOST,path.join(directory,'providers/server'),'qa-claude-server');
    fake.add(null,{tab:'tb1',name:'login fix',folder:'/fixture/linked',program:agent,terminals:['t2']});fake.add(HOST,{tab:HOST+'/tb1',name:'api review',folder:'/fixture/server',program:agent,terminals:[HOST+'/t2']});fake.add(null,{tab:'tb2',name:'release notes',folder:'/fixture/notes',program:{key:'zsh',name:'zsh',agent:false},terminals:['t3','t4']});
    for(const [machine,space,session,origin] of [[null,'qa-sp-local',local,'login'],[HOST,HOST+'/qa-sp-remote',remote,'api']])await commitExact(store,{machine,ack:{space,tab:(machine?machine+'/':'')+'tb1',terminal:(machine?machine+'/':'')+'t2'},raw:fake.raw(machine,'t2'),session,program:fixtures.actor,argv:[fixtures.actor,'--session-id',session.sessionId],requestId:'qa-request-'+origin,originId:'qa-origin-'+origin,kind:'caller-session-id'});
    await tick(3);fake.state.remote='unavailable';await tick(2);fake.state.remote='ready';await tick(2);
    check((await closed.read()).value.records.length===0,'A fixture disconnect and reconnect invent no closure');
    fake.close(null,'tb1');await tick(2);fake.close(HOST,HOST+'/tb1');await tick(2);fake.close(null,'tb2');await tick(2);
    const value=(await closed.read()).value,[la]=value.records.filter(r=>r.machine===null&&r.kind==='agent'),[ra]=value.records.filter(r=>r.machine===HOST),[shell]=value.records.filter(r=>r.kind==='shell');
    check(value.records.length===3&&la?.terminals[0].session?.sessionId===local.sessionId&&ra?.terminals[0].session?.machine===HOST&&ra.terminals[0].session.sessionId===remote.sessionId&&localId(la.tab.id,null)===localId(ra.tab.id,HOST)&&la.id!==ra.id,'Fixture bindings turn identical local/remote IDs into two exact qualified records');
    check(selectRecord(value,'agent').record?.id===ra.id&&selectRecord(value,'tab').record?.id===shell?.id&&shell.panes===2&&restorePlan(ra,'agent').terminal.session.machine===HOST&&reopenPreview(value,'agent').title==='api review'&&reopenPreview(value,'agent').detail==='server-repo · qa-server','Fixture close order makes Reopen last agent skip the newer shell tab');
    fake.state.remote='unavailable';const offline=await reopenAction('agent',fake.io),kept=(await closed.read()).value.records.find(r=>r.id===ra.id);
    check(offline.code==='HOST_UNAVAILABLE'&&kept?.error?.code==='HOST_UNAVAILABLE'&&kept.claim===null,'A fixture offline host keeps the remote record with its reason');
    fake.state.remote='ready';fake.add(null,{tab:'tb3',name:'running elsewhere',folder:'/fixture/linked',program:agent,terminals:['t5']});
    await commitExact(store,{machine:null,ack:{space:'qa-sp-local',tab:'tb3',terminal:'t5'},raw:fake.raw(null,'t5'),session:local,program:fixtures.actor,argv:[fixtures.actor,'--resume',local.sessionId],requestId:'qa-request-live',originId:'qa-origin-live',kind:'resume-argv'});
    check((await store.requestState('qa-request-live'))?.state==='committed','An exact resume argv commits a live duplicate binding');

    await positionWindow(null,{compileOnly:true,directory,cache:path.join(directory,'swift-cache')});check(true,'The owned window positioning helper compiles');
    return {ok:true,assertions:checks.length,checks,boundary:'Disposable actors, a fake hc for the history wrapper, an in-memory Herdr world over the real shared closed-tab/reopen modules and the via/position helpers only. No Herdr app/core was constructed, queried or stopped and no receipt or preview was written.'};
  }finally{await fs.rm(directory,{recursive:true,force:true});}
}

/** Private negative proof: empty history and a missing Python capability never write a releasable receipt or preview. */
export async function checkEmptyState(){
  const runtime=new NativeRuntime(),receiptFile=path.join(ROOT,RECEIPT),previewFile=path.join(ROOT,MOD,'preview.png');let failure,publicReceiptUnchanged=false,publicPreviewUnchanged=false;
  const read=async file=>{try{return await fs.readFile(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}},before={receipt:await read(receiptFile),preview:await read(previewFile)};
  try{
    await runtime.start();
    const shim=path.join(runtime.directory,'missing-python');await fs.mkdir(shim);await fs.writeFile(path.join(shim,'python3'),'#!/bin/sh\nexit 127\n');await fs.chmod(path.join(shim,'python3'),0o700);runtime.env.PATH=shim+':'+runtime.env.PATH;
    await runtime.installPackage(MOD);await runtime.startWindow({name:'reopen-empty-state',layout:reopenLayout(1)});await positionWindow(runtime);
    const {pick,click,visible,pill,openPopup,inBars,inBody}=nativeUI(runtime,{copies:1}),journal=new ClosedJournal(fileIO(runtime.env.HERDR_APP_HOME));
    await pick('Nothing closed yet',inBars,{description:'empty Reopen bar'});const quiet=runtime.hc(['ls','--json']).terminals.length;await pill('Reopen tab');await pill('Reopen agent');await delay(1500);
    runtime.expect(runtime.hc(['ls','--json']).terminals.length===quiet,'Empty Reopen actions start nothing');
    await openPopup();await visible('Nothing to reopen yet',inBody);
    await click('Import older history',(n,o)=>n.text==='Import older history'&&inBody(n,o),{index:'last',description:'Import older history link'});await visible('Older closed',inBody);
    const value=(await journal.read()).value;runtime.expect(value.records.length===0&&value.imports[hostKey(null)]?.state==='unavailable','A missing Python history capability reports unavailable history and invents nothing');
    runtime.expect(runtime.app(['status']).errors?.length===0,'Empty and missing-capability states produce no native app error');
  }catch(error){failure=error;}
  finally{if(runtime.directory)try{await runtime.close();}catch(error){failure??=error;}}
  try{const receiptAfter=await read(receiptFile),previewAfter=await read(previewFile);publicReceiptUnchanged=before.receipt===null?receiptAfter===null:before.receipt.equals(receiptAfter);publicPreviewUnchanged=before.preview===null?previewAfter===null:before.preview.equals(previewAfter);assert.equal(publicReceiptUnchanged,true);assert.equal(publicPreviewUnchanged,true);}catch(error){failure??=error;}
  const report={schema:'mission-control-reopen-empty-state-negative-v1',passed:!failure,featureProof:false,publicReceiptUnchanged,publicPreviewUnchanged,cleanup:runtime.cleanup,cleanupError:runtime.closeError?{code:runtime.closeError.code,message:runtime.closeError.message}:null,negativeReceipt:runtime.receipt(false,Object.assign(Error('An empty or capability-missing view is not a successful feature/release gate.'),{code:'EMPTY_STATE_NOT_RELEASEABLE'})),...(failure?{error:failure.message}:{})};
  await fs.mkdir(path.join(ROOT,'.harness'),{recursive:true});await fs.writeFile(path.join(ROOT,'.harness/reopen-empty-state.json'),JSON.stringify(report,null,2)+'\n');
  if(failure)throw failure;return {passed:true,featureProof:false,publicReceiptUnchanged,publicPreviewUnchanged,cleanup:runtime.cleanup};
}

/** Copies the preview frame only from a passed, validated receipt whose tested build equals the current package. */
export async function promotePreview(){
  const receiptPath=path.join(ROOT,RECEIPT),receipt=JSON.parse(await fs.readFile(receiptPath,'utf8'));
  assert.equal(receipt.ok,true,'Only a passed Reopen receipt can promote a preview');assert.equal(await validateNativeIsolationReceipt(receipt,{receiptPath:RECEIPT}),true);
  const frame=receipt.frames.find(f=>f.label===PREVIEW);assert.ok(frame&&frame.capture==='macos-window-server','The passed receipt has no native preview frame');
  const bytes=await fs.readFile(path.join(ROOT,frame.path));assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.equal(sha(bytes),frame.sha256);
  const packageRoot=path.join(ROOT,MOD),manifest=JSON.parse(await fs.readFile(path.join(packageRoot,'build-manifest.json'),'utf8')),tested=receipt.packages.find(p=>p.name===MOD);
  assert.equal(tested?.nativeCheck,true);assert.deepEqual(tested.manifest,manifest,'The preview belongs to a different build than the current package');
  for(const [file,expected]of Object.entries(manifest.artifacts))assert.equal(sha(await fs.readFile(path.join(packageRoot,'mods',MOD,file))),expected,file);
  for(const [file,expected]of Object.entries(manifest.sources))assert.equal(sha(await fs.readFile(path.join(ROOT,file))),expected,file);
  const target=path.join(packageRoot,'preview.png'),next=target+'.next';await fs.writeFile(next,bytes);await fs.rename(next,target);
  return {promoted:true,sha256:frame.sha256,frame:frame.path};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const mode=process.argv[2],check={'fixture-check':checkFixtures,'empty-state-check':checkEmptyState,'promote-preview':promotePreview}[mode];
  if(!check)throw Error('Use node scripts/native-harness.mjs run reopen for the mounted gate, fixture-check for the core-free preflight, empty-state-check for the private negative proof, or promote-preview after a passed receipt.');
  check().then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error);process.exitCode=1;});
}
