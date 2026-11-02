import fs from 'node:fs/promises';
import sync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {NativeRuntime,NativeIsolationError,run,until,isolatedEnvironment,validateNativeIsolationReceipt} from '../../scripts/native-harness.mjs';
import {buildPackage} from '../../scripts/project.mjs';
import {newConfig} from '../../src/shared/config.js';
import {localTerminalAddress,terminalIdentity,sessionKey} from '../../src/shared/session-identity.js';
import {BindingStore,argvSessionProof} from '../../src/shared/session-bindings.js';
import {probeCapabilities,buildArguments} from '../../src/shared/tool-capabilities.js';
import {resumeSupport} from '../../src/shared/resume.js';
import {historyRecord,parseWorktrees,membershipIndex,deriveSessions,repoKey} from '../../src/mods/mission-control-sessions/model.js';

const MOD='mission-control-sessions',UI='mission-control-sessions-ui-v1',PROVIDERS=['claude','codex','grok'];
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
// Fixture layout geometry: 42 px tabs bar, 480 px Sessions panel on the right, 26 px status bar.
// Row titles start 35 px into the panel (6 px list + 7 px row padding, 15 px tool icon, 7 px gap).
const PANEL=480,TABS=42,STATUS=26,LIST=150,FOOTER=64,TITLE_MIN=15,TITLE_MAX=70,MINUTE=60000;
const execute=promisify(execFile),delay=ms=>new Promise(resolve=>setTimeout(resolve,ms)),sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const read=async file=>{try{return await fs.readFile(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}};
const readText=async file=>(await read(file))?.toString('utf8')??null;
const localId=(id,machine)=>machine&&id.startsWith(machine+'/')?id.slice(machine.length+1):id;
// Exact launch argv, or the actual Herdr login-shell wrapper launch already accepts.
// Herdr's login-shell wrappers: 0.1.10 used the user's zsh/bash; 0.1.11 uses /bin/sh locally and `sh -c` remotely (see launch.js observedArgv).
const wrapped=(argv,expected)=>Array.isArray(argv)&&(JSON.stringify(argv)===JSON.stringify(expected)||typeof argv[0]==='string'&&(argv[0].startsWith('/')||!argv[0].includes('/'))&&/^(?:sh|bash|zsh|dash|ksh)$/.test(argv[0].split('/').pop())&&({'-lic':'"$@"; exec "$0" -li','-c':'"$@"; exec "${SHELL:-sh}" -i'})[argv[1]]===argv[2]&&argv[3]===argv[0]&&JSON.stringify(argv.slice(4))===JSON.stringify(expected));

export const TITLES=Object.freeze({A:'Trace token refresh',B:'Review deployment checks',C:'Draft release notes',G:'Audit flaky checkout',X:'Legacy imported chat',S1:'Repair pagination',S2:'Tune cache headers',R1:'Watch server health',R2:'Rotate server logs'});
export const MANUAL='Pinned investigation';
// [key, provider, reported title, minutes ago, checkout]. B is the newest same-repo session, so A is non-last.
// D has no reported title (Codex reports none); X has no exact UUID; G's installed tool has no verified exact resume.
const LOCAL=[['A','claude',TITLES.A,40,'repo'],['B','claude',TITLES.B,5,'repo'],['C','claude',TITLES.C,25,'repo'],['D','codex',null,12,'linked'],['G','grok',TITLES.G,18,'repo'],['X','claude',TITLES.X,60,'repo'],['S1','claude',TITLES.S1,8,'repo2'],['S2','claude',TITLES.S2,30,'repo2']];
const REMOTE=[['R1','claude',TITLES.R1,3,'repo'],['R2','claude',TITLES.R2,20,'repo']];

/** Synthetic provider metadata in the exact formats the bundled collector parses, written only below directory. */
export async function writeHistory(directory,checkouts,{machine=null,entries=LOCAL,now=Math.floor(Date.now()/1000)*1000}={}){
  const scope=machine?'server-':'local-',roots={},sources={},sessions={},files=[];
  for(const provider of PROVIDERS){
    const providerRoot=path.join(directory,'providers','.'+provider),root=path.join(providerRoot,provider==='claude'?'projects':'sessions');await fs.mkdir(root,{recursive:true});
    roots[provider]=root;sources[scope+provider]={v:1,enabled:true,machine,provider,credentialScope:(machine?'qa-server-':'qa-')+provider,providerRoot,roots:[root]};
  }
  for(const [key,provider,title,ago,checkout]of entries){
    const id=key==='X'?'legacy-chat-2024':crypto.randomUUID(),cwd=checkouts[checkout],at=now-ago*MINUTE,timestamp=new Date(at).toISOString(),source=sources[scope+provider];let file,body;
    if(provider==='claude'){file=path.join(roots.claude,cwd.replaceAll('/','-'),id+'.jsonl');body=[...(title?[{type:'ai-title',sessionId:id,aiTitle:title}]:[]),{type:'assistant',sessionId:id,cwd,timestamp,version:'native-qa',message:{usage:{input_tokens:3,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:2}}}].map(v=>JSON.stringify(v)).join('\n')+'\n';}
    else if(provider==='codex'){file=path.join(roots.codex,'2026','10','31','rollout-'+id+'.jsonl');body=JSON.stringify({type:'session_meta',payload:{id,cwd,timestamp,cli_version:'native-qa'}})+'\n';}
    else{file=path.join(roots.grok,id,'summary.json');body=JSON.stringify({info:{id,cwd},generated_title:title,last_active_at:timestamp});}
    await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,body);await fs.utimes(file,new Date(at),new Date(at));files.push(file);
    sessions[key]=Object.freeze({key,id,provider,title,cwd,at,file,identity:Object.freeze({machine,provider,credentialScope:source.credentialScope,providerRoot:source.providerRoot,sessionId:id})});
  }
  return {roots,sources,sessions,files};
}

const HELP={claude:'Claude Code QA fixture\nUsage: claude [options] [prompt]\n --resume [value]  Resume one exact conversation',codex:'Codex CLI QA fixture\nUsage: codex [OPTIONS] [PROMPT]',grok:'Grok Build TUI QA fixture\nUsage: grok [OPTIONS] [PROMPT]\n --model <MODEL>'},RESUME_HELP='Usage: codex resume [OPTIONS] [SESSION_ID] [PROMPT]';
const ACTOR=String.raw`#!/usr/bin/env python3
import os,sys,json,select,tty
KEY=__KEY__
if '--version' in sys.argv: print('Native sessions fixture 1.0');sys.exit(0)
if '--help' in sys.argv:
 print(__RESUME__ if KEY=='codex' and 'resume' in sys.argv else __HELP__);sys.exit(0)
record={'tool':KEY,'pid':os.getpid(),'cwd':os.getcwd(),'argv':sys.argv[1:]}
file=os.path.join(__DIR__,str(os.getpid())+'.json')
with open(file+'.next','w') as output: json.dump(record,output)
os.replace(file+'.next',file)
if sys.stdin.isatty(): tty.setraw(sys.stdin.fileno())
print('Disposable sessions actor; no provider call.',flush=True)
while True:
 print('\x1b]7501;state=idle:app='+__APP__+'\x1b\\',end='',flush=True)
 ready,_,_=select.select([sys.stdin],[],[],3)
 if ready and not os.read(sys.stdin.fileno(),65536): break
`;
/** Disposable tool actors: own help verifies exact resume (Claude flag, Codex command; Grok none); each run records argv/cwd. */
export async function actors(directory,home){
  const input=path.join(directory,'actor-input'),programs={};await fs.mkdir(input,{recursive:true});
  for(const key of PROVIDERS){
    const file=path.join(directory,'qa-'+key),values={__KEY__:key,__APP__:key==='claude'?'claude-code':key,__HELP__:HELP[key],__RESUME__:RESUME_HELP,__DIR__:input};
    await fs.writeFile(file,ACTOR.replace(/__[A-Z]+__/g,token=>JSON.stringify(values[token])));await fs.chmod(file,0o700);programs[key]={name:'QA '+key,run:[file]};
  }
  await fs.mkdir(home,{recursive:true});await fs.writeFile(path.join(home,'programs.json'),JSON.stringify({programs}));
  return {programs,directory:input,async read(){const values=[];for(const name of await fs.readdir(input))if(/^[0-9]+\.json$/.test(name))try{values.push(JSON.parse(await fs.readFile(path.join(input,name),'utf8')));}catch{}return values;}};
}

/** CAS file IO for the private app home only, with atomic replacement like Herdr's writeTextFile. */
export function fileIO(home){return {appHome:()=>home,ensureDirectory:directory=>fs.mkdir(directory,{recursive:true}),readTextFile:readText,writeTextFile:async(file,text,expected)=>{let raw=null;try{raw=sync.readFileSync(file,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}if(raw!==expected)throw Object.assign(Error('stale'),{code:'STALE'});const next=file+'.qa-'+crypto.randomBytes(6).toString('hex');sync.writeFileSync(next,text);sync.renameSync(next,file);}};}

/** Exact resume-argv proof from a terminal's actual observed command, recorded the way launch records it. */
export async function commitProof(home,{requestId,tabId,raw,session,run:command}){
  const argv=[...command,'--resume',session.sessionId];if(!wrapped(raw.argv,argv))throw Error('A fixture terminal can only be bound by the exact resume argv it actually runs');
  const terminal=terminalIdentity(raw,session.machine),bindings=new BindingStore(fileIO(home));
  await bindings.propose({requestId,originId:'qa-origin-'+requestId,session});
  await bindings.commitAcknowledged(requestId,{tabId,terminal},argvSessionProof({capabilities:{machine:session.machine,provider:session.provider,run:command,resume:{kind:'flag',flag:'--resume'}},session,terminal,argv,kind:'resume-argv',observedAt:Date.now(),sourceDigest:sha(JSON.stringify(raw.argv))}));
  return terminal;
}

async function positionWindow(runtime,{compileOnly=false}={}){
  const source=path.join(runtime.directory,'sessions-position.swift'),binary=path.join(runtime.directory,'sessions-position');
  await fs.writeFile(source,String.raw`import Cocoa
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
`);
  run('swiftc',['-module-cache-path',path.join(ROOT,'.harness/swift-cache'),source,'-o',binary],{json:false,timeout:60000});
  if(compileOnly)return binary;
  await until(async()=>{const result=run(binary,[String(runtime.owner.pid)]);if(result.retry)return false;const frame=await runtime.driver.bindWindow(result.windowId);return Math.abs(frame.width-1280)<2&&Math.abs(frame.height-760)<2&&Math.abs(frame.x-300)<2&&Math.abs(frame.y-350)<2;},'owned Sessions window position and native input bounds');
}

const block=(id,mod,size,props)=>({id,type:'block',...(size?{size:{px:size}}:{}),content:{mod,...(props?{props}:{})}});
export const sessionsLayout=()=>({id:'qa-root',type:'column',titlebar:'none',traffic_lights:[12,16],theme:'graphite',children:[block('tabs','tabs',TABS),{id:'workspace',type:'row',children:[{id:'terminal',type:'block',content:{tab:'active'}},block('sessions',MOD,PANEL)]},block('status','workspace-status',STATUS)]});

/** OCR observation of the actual WindowServer frame; every helper requires one unambiguous native target. */
function observer(runtime,prefix){
  let serial=0;
  const observe=async(query='')=>{if(++serial>600)throw Error('Native Sessions observation budget exhausted');const frame=await runtime.frame(prefix+'-'+serial),o=await runtime.driver.ocr(path.join(ROOT,frame.path),query);if(o.lines.some(n=>/\binterrupted\b|could not be re.?rendered|render.*error|could not complete this action/i.test(n.text)))throw Error('Native Sessions render/action error banner: '+o.lines.map(n=>n.text).join(' | '));return o;};
  const inPanel=(n,o)=>n.frame.x>=o.window.width-PANEL&&n.frame.y>TABS&&n.frame.y<o.window.height-STATUS;
  const inList=(n,o)=>inPanel(n,o)&&n.frame.y>LIST&&n.frame.y<o.window.height-STATUS-FOOTER;
  // Only the row-title column: excludes hover tooltips, meta/reason lines and the footer's info line.
  const title=(n,o)=>inList(n,o)&&n.frame.x>o.window.width-PANEL+TITLE_MIN&&n.frame.x<o.window.width-PANEL+TITLE_MAX;
  const toolbar=(n,o)=>inPanel(n,o)&&n.frame.y<LIST,inTabs=n=>n.frame.y<TABS;
  const text=(query,where=inPanel,timeout=20000)=>until(async()=>{const o=await observe(query),m=o.matches.filter(n=>n.confidence>=0.6&&where(n,o));return m.length===1?{observation:o,node:m[0]}:null;},'visible unique Sessions text '+query,timeout);
  const has=async(query,where=inPanel)=>{const o=await observe(query);return o.matches.some(n=>n.confidence>=0.5&&where(n,o));};
  const click=async(query,where=inPanel)=>{const found=await text(query,where);await runtime.driver.clickObservedText(found.observation,found.node);return found;};
  // Move the real pointer onto the inert panel header so a row tooltip cannot cover the next observation.
  const park=async o=>{await runtime.driver.click({x:o.window.width-PANEL/2,y:TABS+8,width:8,height:8},{expectedSize:o.window});Object.assign(runtime.driver.actions.at(-1),{control:'Inert Sessions header',observation:o.source});};
  const line=(o,node)=>o.lines.filter(n=>inPanel(n,o)&&Math.abs(n.frame.y+n.frame.height/2-node.frame.y-node.frame.height/2)<8).map(n=>n.text).join(' | ');
  const below=(o,node)=>o.lines.filter(n=>inPanel(n,o)&&n.frame.y>node.frame.y+node.frame.height+1&&n.frame.y<node.frame.y+44).map(n=>n.text).join(' | ');
  const row=(query,accept=()=>true,description,timeout=30000)=>until(async()=>{const o=await observe(query),m=o.matches.filter(n=>n.confidence>=0.6&&title(n,o));if(m.length!==1)return null;const found={observation:o,node:m[0],line:line(o,m[0]),below:below(o,m[0])};return accept(found)?found:null;},description||'Sessions row '+query,timeout);
  const order=(titles,timeout=30000)=>until(async()=>{const o=await observe(),ys=titles.map(t=>o.lines.filter(n=>n.confidence>=0.5&&inList(n,o)&&n.frame.x<o.window.width-PANEL+TITLE_MAX&&n.text.toLowerCase().includes(t.toLowerCase())).map(n=>n.frame.y));return ys.every(y=>y.length===1)?ys.map(y=>y[0]):null;},'visible Sessions rows '+titles.join(', '),timeout);
  const clickRow=async(query,accept)=>{const target=await row(query,accept);await runtime.driver.clickObservedText(target.observation,target.node);await park(target.observation);return target;};
  const doubleClick=async(query,accept)=>{const target=await row(query,accept);await runtime.driver.clickObservedText(target.observation,target.node);await runtime.driver.click(target.node.frame,{expectedSize:target.observation.window});Object.assign(runtime.driver.actions.at(-1),{control:'Second click '+query,observation:target.observation.source});await park(target.observation);return target;};
  const pill=async name=>{const found=await click(name,toolbar);await park(found.observation);return found;};
  const sources=async()=>{const search=await text('Search sessions',toolbar),o=search.observation;await runtime.driver.click({x:o.window.width-36,y:search.node.frame.y+search.node.frame.height/2-13,width:26,height:26},{expectedSize:o.window});Object.assign(runtime.driver.actions.at(-1),{control:'History sources and paths',observation:o.source});await park(o);};
  return {observe,inPanel,inList,title,toolbar,inTabs,text,has,click,park,row,order,clickRow,doubleClick,pill,sources};
}

export default async function sessions(runtime){
  const home=runtime.env.HERDR_APP_HOME,state=path.join(home,'mission-control'),files={config:path.join(state,'config.json'),journal:path.join(state,'launches.json'),bindings:path.join(state,'session-bindings.json'),names:path.join(state,'names.json')};
  const server=new NativeRuntime(),gate=path.join(runtime.directory,'qa-server-offline');let connected=false,actor,failure,cleanupError;
  const progress=stage=>fs.mkdir(path.join(ROOT,'.harness'),{recursive:true}).then(()=>fs.writeFile(path.join(ROOT,'.harness/sessions-progress.json'),JSON.stringify({stage,nonce:runtime.nonce,assertions:runtime.assertions.length})+'\n')).catch(()=>{});
  const journal=async()=>{const raw=await readText(files.journal);return raw?Object.values(JSON.parse(raw).requests):[];};
  const completed=async session=>(await journal()).filter(r=>r.state==='complete'&&r.sessionProposal&&sessionKey(r.sessionProposal)===sessionKey(session.identity)).sort((a,b)=>a.createdAt-b.createdAt);
  const resumed=(session,count,timeout=60000)=>until(async()=>{const rows=await completed(session);return rows.length>=count?rows:null;},'acknowledged exact resume '+session.key+' #'+count,timeout);
  const origins=async session=>{const raw=await readText(files.names);return raw?Object.values(JSON.parse(raw).origins).filter(o=>o.session&&sessionKey(o.session)===sessionKey(session.identity)):[];};
  const world=()=>runtime.app(['ls']).spaces||[];
  const tabInfo=id=>{for(const space of world())for(const tab of space.tabs||[])if(tab.id===id)return {...tab,space:space.id};return null;};
  const localTabs=()=>world().filter(s=>(s.machine??null)===null).flatMap(s=>(s.tabs||[]).map(t=>t.id)).sort();
  const live=(terminal,core=runtime,machine=null)=>(core.hc(['ls','--json']).terminals||[]).some(t=>t.address===localTerminalAddress(terminal,machine)&&(t.state===undefined||t.state==='live'));
  const focused=()=>runtime.app(['status']).tab;
  const select=async space=>{runtime.app(['do','space.select',JSON.stringify({id:space.id})]);runtime.app(['do','tab.select',JSON.stringify({id:space.tab})]);runtime.app(['do','pane.focus',JSON.stringify({terminal:space.terminal})]);await until(()=>focused()===space.tab,'focused fixture space '+space.name);};
  const closeTab=async ack=>{runtime.app(['do','tab.close',JSON.stringify({id:ack.tab,confirmed:true})]);await until(()=>!tabInfo(ack.tab)&&!live(ack.terminal),'closed fixture tab '+ack.tab);};
  const snapshot=async()=>({journal:await readText(files.journal),bindings:await readText(files.bindings),tabs:JSON.stringify(localTabs()),actors:(await actor.read()).length,focused:focused()});
  const writeConfig=async mutate=>{const next=JSON.parse(await fs.readFile(files.config,'utf8'));mutate(next);next.revision++;await fs.writeFile(files.config,JSON.stringify(next));};
  try{
    console.log('Sessions native: private fixtures, disposable actors and a second owned core');await progress('fixtures');
    actor=await actors(runtime.directory,home);
    const repo=runtime.repo,repo2=await runtime.createRepo('api-repo'),linked=path.join(runtime.directory,'client-linked'),notes=path.join(runtime.directory,'scratch-notes');
    run('git',['-C',repo,'worktree','add','-q','-b','qa-linked',linked],{env:runtime.env,json:false});await fs.mkdir(notes);
    const local=await writeHistory(runtime.directory,{repo,linked,repo2});
    await server.start();const remote=await writeHistory(server.directory,{repo:server.repo},{machine:'qa-server',entries:REMOTE});
    const s=local.sessions,r=remote.sessions,hashes=new Map(await Promise.all([...local.files,...remote.files].map(async file=>[file,sha(await fs.readFile(file))])));
    const perRepo=[[repo,linked],[repo2],[server.repo]].map(checkouts=>Object.values({...s,...r}).filter(x=>checkouts.includes(x.cwd)&&UUID.test(x.id)).length);
    runtime.expect(perRepo.every(n=>n>=2)&&!UUID.test(s.X.id),'Fixture provider history holds at least two exact session IDs in every repository');
    await fs.mkdir(state,{recursive:true});await fs.writeFile(files.config,JSON.stringify({...newConfig(),usageSources:{...local.sources,...remote.sources}}));
    // The remote transport is gated: once the owned server is stopped, reconnects fail fast instead of reaching any core.
    const via=path.join(runtime.directory,'sessions-via.py'),selectors=Object.fromEntries(Object.entries(server.env).filter(([key])=>['HOME','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_RUNTIME_DIR','HC_SESSION','HERDR_APP_HOME'].includes(key)));
    await fs.writeFile(via,`#!/usr/bin/env python3\nimport os,sys,json\nif os.path.exists(${JSON.stringify(gate)}): sys.exit(75)\ne=os.environ.copy();e.update(json.loads(${JSON.stringify(JSON.stringify(selectors))}))\nos.execvpe('/bin/sh',['sh','-c',sys.argv[-1]],e)\n`);await fs.chmod(via,0o700);
    runtime.hc(['machine','add','--via',via,'--name','qa-server','--session',server.env.HC_SESSION,'--json']);connected=true;
    const sleeper=['python3','-u','-c','import time; print("Mission Control sessions fixture space",flush=True); time.sleep(3600)'];
    const space1={id:runtime.spaceId,tab:runtime.tabId,terminal:runtime.sentinel,name:'client-portal'},api={id:runtime.spaceId+'-api',tab:`qa-tab-${runtime.nonce}-api`,name:'api-service',cwd:repo2},scratch={id:runtime.spaceId+'-notes',tab:`qa-tab-${runtime.nonce}-notes`,name:'scratch-notes',cwd:notes};
    for(const space of [api,scratch])space.terminal=runtime.hc(['run','--bg','--no-parent','--label','herdr.space='+space.id,'--label','herdr.tab='+space.tab,'--cwd',space.cwd,'--',...sleeper]).address;
    await runtime.installPackage(MOD);
    runtime.expect(runtime.packages.length===1&&runtime.packages[0].name===MOD&&runtime.packages[0].nativeCheck===true&&(await fs.readdir(path.join(home,'mods'))).join(',')===MOD,'Standalone install contains only mission-control-sessions and passes herdr-app check');
    await fs.writeFile(path.join(home,'window.json'),JSON.stringify({state:'windowed',bounds:[300,350,1280,760]}));
    await runtime.startWindow({name:'sessions-native',layout:sessionsLayout()});await positionWindow(runtime);
    const remoteSpace=await until(()=>world().find(x=>x.machine==='qa-server'),'remote qa-server space adoption',40000);
    await until(()=>{const ids=world().map(x=>x.id);return [space1,api,scratch].every(x=>ids.includes(x.id));},'local fixture spaces adopted by the private window');
    for(const [id,name]of [[space1.id,space1.name],[api.id,api.name],[scratch.id,scratch.name],[remoteSpace.id,'server-repo']])runtime.app(['do','space.rename',JSON.stringify({id,name})]);
    await select(space1);
    const {inPanel,toolbar,inTabs,text,has,click,park,row,order,clickRow,doubleClick,pill,sources}=observer(runtime,'sessions-observe');
    const idle=found=>!/Running|Opening|Focusing/.test(found.line),program=provider=>actor.programs[provider];
    const verifyLaunch=async(record,session,{args,cwd,spaceId,machine=null,core=runtime,repoRoot=repo})=>{
      const raw=core.hc(['get',localTerminalAddress(record.ack.terminal,machine),'--json']),expected=[...program(session.provider).run,...args];
      // A remote `sh -c` wrapper stays in the foreground with the agent as its child.
      const started=await until(async()=>{const runs=await actor.read();return runs.find(a=>a.pid===raw.foreground?.pid)||runs.find(a=>{if(!raw.foreground?.pid)return false;try{return Number(run('ps',['-o','ppid=','-p',String(a.pid)],{json:false}).trim())===raw.foreground.pid;}catch{return false;}});},'actor record of the acknowledged resume '+session.key,20000);
      return record.request.idempotencyKey.startsWith('resume-')&&record.request.machine===machine&&record.request.spaceId===spaceId&&record.request.repoRoot===repoRoot&&record.request.checkoutRoot===cwd&&record.request.toolKey===session.provider&&record.request.worktree===false&&record.folder===cwd&&record.ack.space===spaceId
        &&wrapped(raw.argv,expected)&&raw.cwd===cwd&&raw.labels?.['herdr.space']===localId(spaceId,machine)&&JSON.stringify(started.argv)===JSON.stringify(args)&&started.cwd===cwd;
    };

    console.log('Sessions native: per-space history, newest first, and scope');await progress('per-space history');
    await text(space1.name,toolbar);const ys=await order([TITLES.B,'Untitled',TITLES.G,TITLES.C,TITLES.A,TITLES.X]);
    runtime.expect(ys.every((y,index)=>index===0||y>ys[index-1]),'This space lists only its repository sessions, newest first, with newer B above non-last A');
    runtime.expect(!(await has(TITLES.S1))&&!(await has(TITLES.S2))&&!(await has(TITLES.R1))&&!(await has(TITLES.R2)),'This space excludes another repository space and the remote host');
    await select(api);await text(TITLES.S1);await text(TITLES.S2);
    runtime.expect(!(await has(TITLES.A))&&!(await has(TITLES.B)),'Focusing the second repository space scopes Sessions to its own exact sessions');
    await select(space1);await text(TITLES.A);await pill('All spaces');await until(async()=>(await runtime.shared())[UI]?.all===true,'mounted All spaces scope');
    await text(TITLES.S1);const remoteOrder=await order([TITLES.R1,TITLES.R2]);const remoteRow=await row(TITLES.R2,found=>/qa-server/.test(found.below));
    runtime.expect(Boolean(remoteRow)&&remoteOrder[0]<remoteOrder[1]&&await has(TITLES.A)&&await has(TITLES.S2),'All spaces lists every space and the remote host with their host labels');
    await pill('This space');await until(async()=>(await runtime.shared())[UI]?.all===false,'mounted This space scope');await text(TITLES.A);

    console.log('Sessions native: exact resume, live focus and a native manual rename');await progress('first exact resume');
    let tabs=localTabs();await clickRow(TITLES.A,idle);const [t1]=await resumed(s.A,1);
    await until(()=>tabInfo(t1.ack.tab)?.name===TITLES.A,'reported title applied to the resumed tab');
    runtime.expect(await verifyLaunch(t1,s.A,{args:['--resume',s.A.id],cwd:repo,spaceId:space1.id})&&JSON.stringify(localTabs().filter(id=>!tabs.includes(id)))===JSON.stringify([t1.ack.tab]),'Selecting non-last A resumes exact claude --resume A argv in its original checkout on This Mac');
    const autoA=await origins(s.A);
    runtime.expect(autoA.length===1&&autoA[0].mode==='auto'&&autoA[0].manualName===null&&autoA[0].lastAutoName===TITLES.A&&autoA[0].currentTab.tabId===t1.ack.tab,'A history session resumes under its reported title with automatic name ownership');
    await row(TITLES.A,found=>/Running/.test(found.line),'A row shows its exact live terminal',40000);
    await select(space1);let before=await snapshot();await clickRow(TITLES.A);await until(()=>focused()===t1.ack.tab,'exact live terminal focus',40000);await text('Focused the running session');
    runtime.expect((await readText(files.journal))===before.journal&&JSON.stringify(localTabs())===before.tabs&&(await actor.read()).length===before.actors,'Clicking a running exact session focuses its proven terminal without a new tab');
    await progress('native manual rename');
    const label=await text(TITLES.A,inTabs);await runtime.driver.click(label.node.frame,{button:'right',expectedSize:label.observation.window});Object.assign(runtime.driver.actions.at(-1),{control:'Tab menu '+TITLES.A,observation:label.observation.source});
    await click('Rename',(n,o)=>!inPanel(n,o)&&n.frame.y<400);await text('Cancel',()=>true);await delay(800);
    await runtime.driver.press('cmd-a');await runtime.driver.press('backspace');
    for(let index=0;index<MANUAL.length;index+=4){const chunk=MANUAL.slice(index,index+4);await runtime.driver.bridge('type',chunk);runtime.driver.actions.push({kind:'native-text',pid:runtime.owner.pid,control:'Tab rename prompt',characters:chunk.length});await delay(150);}
    await runtime.driver.press('enter');await until(()=>{const tab=tabInfo(t1.ack.tab);return tab?.name===MANUAL&&tab.named!==false;},'native manual tab rename');
    const manualA=await until(async()=>{const list=await origins(s.A);return list.length===1&&list[0].mode==='manual'&&list[0].manualName===MANUAL?list[0]:null;},'mounted observer records the manual name',30000);
    await row(MANUAL,()=>true,'manual name shown as the history title',30000);
    runtime.expect(manualA.currentTab.tabId===t1.ack.tab&&!(await has(TITLES.A,(n,o)=>inPanel(n,o)&&n.frame.y>LIST&&n.frame.y<o.window.height-STATUS-FOOTER)),'Native tab menu rename records a manual name for exact session A');

    console.log('Sessions native: newer B kept, A closed, non-last A double-clicked');await progress('manual name restore');
    tabs=localTabs();await clickRow(TITLES.B,idle);const [tb]=await resumed(s.B,1);await until(()=>tabInfo(tb.ack.tab)?.name===TITLES.B,'B reported title');
    runtime.expect(await verifyLaunch(tb,s.B,{args:['--resume',s.B.id],cwd:repo,spaceId:space1.id})&&JSON.stringify(localTabs().filter(id=>!tabs.includes(id)))===JSON.stringify([tb.ack.tab]),'Newer same-repo B resumes into its own exact tab');
    const keptB=JSON.stringify(await origins(s.B));
    await closeTab(t1.ack);const closed=await row(MANUAL,idle,'closed A returns to resumable history',40000);
    const yb=await order([TITLES.B,MANUAL]);
    runtime.expect(Boolean(closed)&&yb[0]<yb[1],'Closing A’s tab returns its history row to resumable without losing the manual name');
    tabs=localTabs();const revision=(await origins(s.A))[0].revision;
    await doubleClick(MANUAL,idle);const [,t2]=await resumed(s.A,2);await delay(2500);const restored=await origins(s.A),t2tab=tabInfo(t2.ack.tab);
    runtime.expect((await completed(s.A)).length===2&&JSON.stringify(localTabs().filter(id=>!tabs.includes(id)))===JSON.stringify([t2.ack.tab])&&t2.ack.tab!==t1.ack.tab&&await verifyLaunch(t2,s.A,{args:['--resume',s.A.id],cwd:repo,spaceId:space1.id}),'Double-clicking non-last A creates exactly one new tab with exact resume argv, cwd and host');
    // One acknowledged transfer plus one manual-name restore; a repeated restore would advance the revision again.
    runtime.expect(restored.length===1&&restored[0].mode==='manual'&&restored[0].manualName===MANUAL&&restored[0].currentTab.tabId===t2.ack.tab&&restored[0].revision===revision+2&&t2tab?.name===MANUAL&&t2tab.named!==false&&JSON.stringify(await origins(s.B))===keptB&&tabInfo(tb.ack.tab)?.name===TITLES.B,'A’s manual name is restored exactly once onto the new tab ID while newer B stays unchanged');

    console.log('Sessions native: history-only titles and checkout fallbacks');await progress('reported fallback');
    const noPriorName=(await origins(s.C)).length===0&&(await origins(s.D)).length===0;
    tabs=localTabs();await clickRow(TITLES.C,idle);const [tc]=await resumed(s.C,1);await until(()=>tabInfo(tc.ack.tab)?.name===TITLES.C,'C reported title applied');const c=await origins(s.C);
    runtime.expect(noPriorName&&c.length===1&&c[0].mode==='auto'&&c[0].manualName===null&&c[0].lastAutoName===TITLES.C&&await verifyLaunch(tc,s.C,{args:['--resume',s.C.id],cwd:repo,spaceId:space1.id}),'History-only session without a saved name resumes under its truthful reported title');
    await clickRow('Untitled',idle);const [td]=await resumed(s.D,1);await delay(1500);const d=await origins(s.D);
    runtime.expect(d.length===1&&d[0].mode==='auto'&&d[0].manualName===null&&d[0].lastAutoName===program('codex').name&&tabInfo(td.ack.tab)?.name===program('codex').name&&await verifyLaunch(td,s.D,{args:['resume',s.D.id],cwd:linked,spaceId:space1.id}),'Untitled Codex history keeps its truthful fallback and resumes codex resume D in its linked worktree');

    console.log('Sessions native: unsupported histories and disclosed sources');await progress('unsupported');
    for(const [query,reason,label]of [[TITLES.G,/no verified exact/i,'Grok history without verified exact resume is labelled unsupported and inert'],[TITLES.X,/no exact resumable/i,'History without an exact session ID is labelled unsupported and inert']]){
      await row(query,found=>reason.test(found.below),'unsupported reason for '+query);before=await snapshot();await clickRow(query);await delay(2000);const after=await snapshot();
      runtime.expect(after.journal===before.journal&&after.tabs===before.tabs&&after.actors===before.actors&&after.focused===before.focused,label);
    }
    await sources();await text('Read-only provider metadata');
    runtime.expect(await has('claude/projects')&&await has('codex/sessions')&&await has('grok/sessions'),'Sources panel discloses exact read-only provider roots');
    await sources();await until(async()=>!(await has('Read-only provider metadata')),'sources panel closed');
    await order([TITLES.B,'Untitled',TITLES.G,TITLES.C,MANUAL,TITLES.X]);
    runtime.expect(runtime.app(['status']).errors.length===0,'Preview frame shows populated history with zero native app errors');await runtime.frame('sessions-preview');

    console.log('Sessions native: unbound live terminal ambiguity and exact proof');await progress('ambiguity');
    await closeTab(t2.ack);await row(MANUAL,idle,'A resumable again',40000);
    const unbound=async(session,name)=>{const argv=[...program('claude').run,'--resume',session.id],ack=runtime.app(['do','tab.new',JSON.stringify({space:space1.id,folder:repo,name,argv})]);
      const raw=await until(async()=>{const value=runtime.hc(['get',localTerminalAddress(ack.terminal,null),'--json']),started=(await actor.read()).find(a=>a.pid===value.foreground?.pid);return started&&wrapped(value.argv,argv)?value:null;},'unbound same-host claude terminal '+name);return {...ack,raw};};
    const blocked=async()=>{await select(space1);const target=await row(MANUAL,found=>!/Opening|Focusing/.test(found.line)),prior=await snapshot();await runtime.driver.clickObservedText(target.observation,target.node);await park(target.observation);
      await row(MANUAL,found=>/running claude terminal/i.test(found.below),'visible ambiguous-session refusal',60000);await delay(1500);const after=await snapshot();
      return prior.focused===space1.tab&&after.focused===space1.tab&&after.journal===prior.journal&&after.bindings===prior.bindings&&after.tabs===prior.tabs&&after.actors===prior.actors;};
    const u1=await unbound(s.A,'Unbound claude one');
    runtime.expect(await blocked(),'Unbound live same-host claude terminal blocks A with zero focus and zero tab.new/resume');
    await commitProof(home,{requestId:'qa-proof-u1-a',tabId:u1.tab,raw:u1.raw,session:s.A.identity,run:program('claude').run});await select(space1);before=await snapshot();
    await clickRow(MANUAL);await until(()=>focused()===u1.tab,'exact proven focus of the bound terminal',40000);await text('Focused the running session');await delay(1500);let after=await snapshot();
    runtime.expect(after.journal===before.journal&&after.tabs===before.tabs&&after.actors===before.actors&&after.focused===u1.tab,'After exact proof binds that terminal to A, selecting A focuses it once without a launch');
    await closeTab(u1);const u2=await unbound(s.B,'Unbound claude two');
    runtime.expect(await blocked(),'A second unbound terminal again blocks A with zero side effects');
    await commitProof(home,{requestId:'qa-proof-u2-b',tabId:u2.tab,raw:u2.raw,session:s.B.identity,run:program('claude').run});await select(space1);tabs=localTabs();
    await doubleClick(MANUAL,found=>!/Opening|Focusing/.test(found.line));const [,,t3]=await resumed(s.A,3);await delay(2500);
    runtime.expect((await completed(s.A)).length===3&&JSON.stringify(localTabs().filter(id=>!tabs.includes(id)))===JSON.stringify([t3.ack.tab])&&focused()===t3.ack.tab&&live(u2.terminal)&&await verifyLaunch(t3,s.A,{args:['--resume',s.A.id],cwd:repo,spaceId:space1.id}),'After exact proof binds that terminal to B, double-clicking A resumes A exactly once');

    console.log('Sessions native: remote exact host and offline host');await progress('remote host');
    await pill('All spaces');await until(async()=>(await runtime.shared())[UI]?.all===true,'All spaces for remote history');
    await clickRow(TITLES.R2,found=>idle(found)&&/qa-server/.test(found.below));const [rr]=await resumed(r.R2,1,90000);
    runtime.expect(await verifyLaunch(rr,r.R2,{args:['--resume',r.R2.id],cwd:server.repo,spaceId:remoteSpace.id,machine:'qa-server',core:server,repoRoot:server.repo}),'Non-last remote session resumes only on qa-server with exact argv and remote cwd');
    // hc may list a connected machine's terminals with qualified addresses; only unqualified ones run on the local core.
    const localRuns=(runtime.hc(['ls','--json']).terminals||[]).filter(t=>(t.state===undefined||t.state==='live')&&!String(t.address).includes('/')).map(t=>runtime.hc(['get',t.address,'--json']));
    runtime.expect(!localRuns.some(raw=>(raw.argv||[]).some(value=>value===r.R1.id||value===r.R2.id)),'No remote session ever runs on the local core');
    const remoteUnchanged=(await Promise.all(remote.files.map(async file=>sha(await fs.readFile(file))===hashes.get(file)))).every(Boolean);
    await fs.writeFile(gate,'offline\n');await server.close();
    const offline=await row(TITLES.R1,found=>/offline or still connecting/i.test(found.below),'remote rows become offline',90000);await delay(2000);
    before=await snapshot();await runtime.driver.clickObservedText(offline.observation,offline.node);await park(offline.observation);await delay(2000);after=await snapshot();
    runtime.expect(after.journal===before.journal&&after.actors===before.actors&&(await completed(r.R1)).length===0,'Offline host rows explain the outage and start nothing');
    runtime.expect(Boolean(await row(TITLES.C,found=>!/offline/i.test(found.below))),'Only the offline host loses its action; local rows stay resumable');

    console.log('Sessions native: empty and missing-source states');await progress('empty states');
    await pill('This space');await until(async()=>(await runtime.shared())[UI]?.all===false,'This space before empty states');
    await select(scratch);await text('No live terminal in this space has a Git repository',inPanel,40000);
    runtime.expect(!(await has(MANUAL))&&!(await has(TITLES.B)),'A space without a Git repository shows its empty state');
    await writeConfig(value=>{for(const source of Object.values(value.usageSources))source.enabled=false;});await select(space1);await text('No session history sources are enabled',inPanel,40000);
    runtime.expect(!(await has(TITLES.B))&&!(await has(MANUAL)),'Disabling every history source clears rows and shows the missing-source empty state');

    const launches=await journal(),epochs=(await completed(s.A)).map(record=>Number(record.request.idempotencyKey.split('-').at(-1)));
    runtime.expect(launches.length===7&&launches.every(record=>record.state==='complete')&&JSON.stringify(epochs)==='[0,1,2]','Every acknowledged resume is unique per click: seven launches and exactly three epochs for A');
    runtime.expect(remoteUnchanged&&(await Promise.all(local.files.map(async file=>sha(await fs.readFile(file))===hashes.get(file)))).every(Boolean),'Provider history files are never modified');
    runtime.expect((await actor.read()).every(started=>!started.argv.includes('--last')&&!started.argv.includes('--continue')),'No resume used --last or --continue');
    // Herdr 0.1.11 lists an unreachable machine in its status errors; qa-server is offline on purpose here.
    runtime.expect(runtime.app(['status']).errors.filter(error=>!/^layout qa-server: cannot reach /.test(String(error))).length===0,'Mounted Sessions workflows produce zero native app errors');
    runtime.expect((await fs.readdir(path.join(home,'mods'))).filter(name=>name.startsWith('mission-control-')).join(',')===MOD,'Only this standalone custom mod is installed');
    await progress('native Sessions scenario passed');
    // The public preview is promoted only by the promote-preview mode after the harness validated this receipt.
  }catch(error){
    failure=error;const directory=path.join(ROOT,'.browse/sessions',`mission-control-native-${runtime.nonce}`);
    try{await fs.mkdir(directory,{recursive:true});for(const [name,file]of Object.entries(files))try{await fs.copyFile(file,path.join(directory,'sessions-failure-'+name+'.json'));}catch{}
      await fs.writeFile(path.join(directory,'sessions-failure-actors.json'),JSON.stringify(actor?await actor.read():[],null,2));await fs.writeFile(path.join(directory,'sessions-native-console.txt'),(runtime.appStdout||'')+'\n'+(runtime.appStderr||''));
      await fs.writeFile(path.join(directory,'sessions-failure-status.json'),JSON.stringify({status:runtime.app(['status']),world:runtime.app(['ls'])},null,2));await runtime.frame('sessions-failure');}catch{}
  }finally{
    try{await fs.writeFile(gate,'offline\n');}catch{}
    try{if(connected)runtime.hc(['machine','rm','qa-server','--json']);}catch(error){if(error instanceof NativeIsolationError)cleanupError??=error;}
    try{if(server.directory)await server.close();}catch(error){cleanupError??=error;}
  }
  if(failure)throw failure;if(cleanupError)throw cleanupError;
}

/** Core-free preflight: copied collector/model over the fixture history and disposable actors. No Herdr app/core, receipt or preview. */
export async function checkFixtures(){
  const directory=await fs.mkdtemp('/private/tmp/mcqa-');let assertions=0;const ok=(value,message)=>{assert.ok(value,message);assertions++;};
  try{
    const ordinary=['PATH','LANG','LC_ALL','LC_CTYPE','TZ','TERM','NO_COLOR'],importEnv=Object.fromEntries(ordinary.filter(key=>typeof process.env[key]==='string').map(key=>[key,process.env[key]]));
    Object.assign(importEnv,{HOME:directory+'/sentinel-home',XDG_RUNTIME_DIR:directory+'/sentinel-runtime',HC_SESSION:'sentinel-live-core',HERDR_APP_HOME:directory+'/sentinel-app',CODEX_HOME:directory+'/sentinel-codex',CLAUDE_CONFIG_DIR:directory+'/sentinel-claude'});
    const handoff=`import assert from 'node:assert/strict';import {importNativeScenario} from ${JSON.stringify(pathToFileURL(path.join(ROOT,'scripts/native-harness.mjs')).href)};const before={...process.env};const loaded=await importNativeScenario(${JSON.stringify(fileURLToPath(import.meta.url))});assert.deepEqual({...process.env},before);assert.deepEqual(loaded.fixtureEnvironment,{});assert.equal(typeof loaded.execute,'function');console.log(JSON.stringify({pureImport:true}));`;
    const imported=await execute(process.execPath,['--input-type=module','-e',handoff],{env:importEnv,cwd:ROOT,timeout:30000});ok(JSON.parse(imported.stdout).pureImport===true&&imported.stderr==='','The scenario import is pure and needs no fixture environment');
    // Build the current sources in a scratch root; the repository's generated package is left untouched.
    const root=path.join(directory,'build');await fs.mkdir(root);await fs.cp(path.join(ROOT,'src'),path.join(root,'src'),{recursive:true,filter:file=>!file.includes('__pycache__')});
    const built=await buildPackage(MOD,{root}),home=path.join(directory,'app');await fs.mkdir(path.join(home,'mods'),{recursive:true});await fs.cp(built.directory,path.join(home,'mods',MOD),{recursive:true});
    let currentBuild=false;try{const manifest=JSON.parse(await fs.readFile(path.join(ROOT,MOD,'build-manifest.json'),'utf8'));currentBuild=JSON.stringify(manifest.artifacts)===JSON.stringify(built.manifest.artifacts)&&JSON.stringify(manifest.sources)===JSON.stringify(built.manifest.sources);}catch{}
    const env=isolatedEnvironment(directory,crypto.randomBytes(12).toString('hex'));for(const key of ['HOME','TMPDIR','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_CACHE_HOME','XDG_RUNTIME_DIR'])await fs.mkdir(env[key],{recursive:true,mode:0o700});
    const git=(cwd,...args)=>execute('git',['-C',cwd,...args],{env,timeout:20000}),repo=path.join(directory,'fixture-repo'),repo2=path.join(directory,'api-repo'),linked=path.join(directory,'client-linked'),serverRepo=path.join(directory,'server','fixture-repo');
    for(const dir of [repo,repo2,serverRepo]){await fs.mkdir(dir,{recursive:true});for(const args of [['init','-q','-b','main'],['config','user.name','Mission Control QA'],['config','user.email','qa@example.invalid'],['config','commit.gpgsign','false'],['commit','--allow-empty','-qm','Create fixture']])await git(dir,...args);}
    await git(repo,'worktree','add','-q','-b','qa-linked',linked);
    const local=await writeHistory(directory,{repo,linked,repo2}),remote=await writeHistory(path.join(directory,'server'),{repo:serverRepo},{machine:'qa-server',entries:REMOTE}),all={...local.sessions,...remote.sessions};
    const hashes=new Map(await Promise.all([...local.files,...remote.files].map(async file=>[file,sha(await fs.readFile(file))])));
    const code=await fs.readFile(path.join(home,'mods',MOD,'collector.py'),'utf8'),records=new Map();
    for(const [id,source]of Object.entries({...local.sources,...remote.sources})){
      const result=await execute('python3',['-c',code,JSON.stringify({v:1,operation:'list',source,roots:source.roots,limit:50})],{env,cwd:directory,timeout:20000,maxBuffer:8*1024*1024}),response=JSON.parse(result.stdout);
      ok(response.v===1&&Array.isArray(response.data)&&response.cursor===null&&!response.state,'Copied collector lists source '+id+' in one bounded page');
      for(const value of response.data){const checked=historyRecord(value,{...source,id});ok(checked.ok,'Collector row is an exact in-scope history record for '+id);records.set(checked.record.key,checked.record);}
    }
    for(const session of Object.values(all)){const record=records.get(sessionKey(session.identity));ok(record&&record.title===session.title&&record.cwd===session.cwd&&record.activityAt===session.at,'Exact fixture metadata for '+session.key);}
    ok(records.size===Object.keys(all).length,'Every fixture file yields one exact session and nothing merges');
    const exec=async(cmd,args,{cwd}={})=>{try{const result=await execute(cmd,args,{env,cwd,timeout:10000});return {code:0,stdout:result.stdout,stderr:result.stderr};}catch(error){return {code:typeof error.code==='number'?error.code:1,stdout:error.stdout||'',stderr:error.stderr||''};}};
    const actor=await actors(directory,home),caps={},support=new Map();
    for(const machine of [null,'qa-server'])for(const key of PROVIDERS){const value=await probeCapabilities({key,name:'QA '+key,run:actor.programs[key].run,installed:true},{on:machine,exec});caps[JSON.stringify([machine,key])]=value;support.set(JSON.stringify([machine,key]),resumeSupport(value,{provider:key,machine}));}
    const cap=(key,machine=null)=>caps[JSON.stringify([machine,key])];
    ok(cap('claude').provider==='claude'&&cap('claude').resume?.flag==='--resume'&&cap('codex').provider==='codex'&&cap('codex').resume?.command==='resume'&&cap('codex').foregroundFlag===null&&cap('grok').provider==='grok'&&cap('grok').resume===null,'Actor help verifies Claude and Codex exact resume and leaves Grok unsupported');
    ok(JSON.stringify(buildArguments(cap('claude'),{resumeSessionId:local.sessions.A.id}))===JSON.stringify([...actor.programs.claude.run,'--resume',local.sessions.A.id])&&JSON.stringify(buildArguments(cap('codex'),{resumeSessionId:local.sessions.D.id}))===JSON.stringify([...actor.programs.codex.run,'resume',local.sessions.D.id]),'Exact resume argv matches the scenario expectations');
    const worktrees=async dir=>parseWorktrees((await git(dir,'worktree','list','--porcelain','-z')).stdout);
    const index=membershipIndex([{state:'resolved',spaceId:'space-1',spaceName:'client-portal',machine:null,repoRoot:repo,worktreeRoot:repo,worktrees:await worktrees(repo)},{state:'resolved',spaceId:'space-2',spaceName:'api-service',machine:null,repoRoot:repo2,worktreeRoot:repo2,worktrees:await worktrees(repo2)},{state:'resolved',spaceId:'qa-server/space-r',spaceName:'server-repo',machine:'qa-server',repoRoot:serverRepo,worktreeRoot:serverRepo,worktrees:await worktrees(serverRepo)}]);
    const derive=scope=>deriveSessions({records:[...records.values()],index,scope,journal:new Map(),folders:new Map(),running:new Map(),names:new Map(),support,ready:()=>true});
    const key=session=>sessionKey(session.identity),byKey=(view,session)=>view.rows.find(row=>row.key===key(session)),L=local.sessions;
    const first=await derive({all:false,spaceId:'space-1',spaceName:'client-portal',machine:null,repoKey:repoKey(null,repo)});
    ok(JSON.stringify(first.rows.map(row=>row.key))===JSON.stringify(['B','D','G','C','A','X'].map(name=>key(L[name]))),'Space one lists only its repository, newest first with non-last A');
    ok(['A','B','C','D'].every(name=>byKey(first,L[name]).state==='ready')&&byKey(first,L.G).state==='unsupported'&&/no verified exact/i.test(byKey(first,L.G).reason)&&byKey(first,L.X).state==='unsupported'&&/no exact resumable/i.test(byKey(first,L.X).reason),'Ready, unsupported-tool and non-exact rows derive as the scenario expects');
    ok(byKey(first,L.C).title===TITLES.C&&byKey(first,L.C).titleKind==='reported'&&byKey(first,L.D).titleKind==='untitled'&&byKey(first,L.D).title.startsWith('Untitled · ')&&byKey(first,L.D).checkoutRoot===linked&&byKey(first,L.D).linked,'Reported and untitled fallbacks plus the linked checkout derive truthfully');
    const visible=first.rows.map(row=>row.title.toLowerCase());ok([TITLES.A,TITLES.B,TITLES.C,TITLES.G,TITLES.X,'Untitled'].every(query=>visible.filter(value=>value.includes(query.toLowerCase())).length===1)&&!visible.some(value=>value.includes(MANUAL.toLowerCase())),'Every OCR query used by the scenario names exactly one visible row');
    const second=await derive({all:false,spaceId:'space-2',spaceName:'api-service',machine:null,repoKey:repoKey(null,repo2)});ok(JSON.stringify(second.rows.map(row=>row.key))===JSON.stringify(['S1','S2'].map(name=>key(L[name]))),'Space two lists only its own exact sessions');
    const every=await derive({all:true,activeSpaceId:'space-1'});ok(every.rows.length===Object.keys(all).length&&['R1','R2'].every(name=>{const row=byKey(every,remote.sessions[name]);return row.host==='qa-server'&&row.spaceId==='qa-server/space-r'&&row.state==='ready';})&&every.rows.findIndex(row=>row.key===key(remote.sessions.R1))<every.rows.findIndex(row=>row.key===key(remote.sessions.R2)),'All spaces includes both remote sessions on their own host with R2 non-last');
    const script=`import os,pty,time,select,sys,signal\nchild,fd=pty.fork()\nif child==0:\n os.chdir(sys.argv[2])\n os.execv(sys.argv[1],[sys.argv[1],'--resume',sys.argv[3]])\ntry:\n ready=False\n deadline=time.monotonic()+5\n while time.monotonic()<deadline:\n  if select.select([fd],[],[],0.1)[0] and b'Disposable sessions actor' in os.read(fd,8192): ready=True;break\n if not ready: raise RuntimeError('Actor never became ready')\nfinally:\n os.kill(child,signal.SIGTERM)\n os.waitpid(child,0)\n os.close(fd)\n`;
    await execute('python3',['-c',script,actor.programs.claude.run[0],repo,local.sessions.A.id],{env,timeout:15000});const started=await actor.read();
    ok(started.length===1&&JSON.stringify(started[0].argv)===JSON.stringify(['--resume',local.sessions.A.id])&&started[0].cwd===repo,'A disposable actor records its exact argv and cwd');
    const raw={address:'t9',created_ms:Date.now(),state:'live',cwd:repo,argv:['/bin/zsh','-lic','"$@"; exec "$0" -li','/bin/zsh',...actor.programs.claude.run,'--resume',local.sessions.A.id],foreground:{pid:4242,name:'python3'}};
    const terminal=await commitProof(home,{requestId:'qa-proof-u1-a',tabId:'qa-tab-u1',raw,session:local.sessions.A.identity,run:actor.programs.claude.run}),bound=await new BindingStore(fileIO(home)).readCommitted(terminal);
    ok(bound&&sessionKey(bound.session)===key(L.A)&&bound.proof.kind==='resume-argv','The exact-argv binding proof is accepted by the shared binding store');
    await assert.rejects(commitProof(home,{requestId:'qa-proof-wrong',tabId:'qa-tab-u1',raw,session:local.sessions.B.identity,run:actor.programs.claude.run}));assertions++;
    ok((await Promise.all([...hashes].map(async ([file,hash])=>sha(await fs.readFile(file))===hash))).every(Boolean),'Fixture provider files are unchanged after collection');
    await positionWindow({directory},{compileOnly:true});ok(true,'The window positioning helper compiles');
    return {ok:true,assertions,currentBuild,boundary:'Fixture history, a scratch build of the current sources, the copied collector/model and disposable actors only. No Herdr app/core was constructed, queried or stopped; no receipt or preview was written.'};
  }finally{await fs.rm(directory,{recursive:true,force:true});}
}

/** Negative missing-capability proof in its own private window; never writes a releasable receipt or preview. */
export async function checkEmptySetup(){
  const runtime=new NativeRuntime(),receiptFile=path.join(ROOT,'evidence/native/sessions.json'),previewFile=path.join(ROOT,MOD,'preview.png');let failure,publicReceiptUnchanged=false,publicPreviewUnchanged=false;
  const before={receipt:await read(receiptFile),preview:await read(previewFile)};
  try{
    await runtime.start();const home=runtime.env.HERDR_APP_HOME,missing=path.join(runtime.directory,'missing-tool');
    await fs.writeFile(path.join(home,'programs.json'),JSON.stringify({programs:Object.fromEntries(PROVIDERS.map(key=>[key,{name:'Missing '+key,run:[missing+'-'+key]}]))}));
    await runtime.installPackage(MOD);await runtime.startWindow({name:'sessions-empty-setup',layout:sessionsLayout()});await positionWindow(runtime);
    const {text,sources}=observer(runtime,'sessions-empty');
    await text('No session history sources are enabled',undefined,40000);await sources();await text('No history sources are enabled');
    const config=await readText(path.join(home,'mission-control/config.json'));
    runtime.expect(config===null||Object.keys(JSON.parse(config).usageSources||{}).length===0,'Tools that are not installed add no default history source');
    runtime.expect(runtime.hc(['ls','--json']).terminals.length===1,'Empty setup has only its original positively owned sentinel and no invented agent');
    runtime.expect(runtime.app(['status']).errors.length===0,'Empty setup produces no native app error');
  }catch(error){failure=error;}
  finally{if(runtime.directory)try{await runtime.close();}catch(error){failure??=error;}}
  try{const receiptAfter=await read(receiptFile),previewAfter=await read(previewFile);publicReceiptUnchanged=before.receipt===null?receiptAfter===null:before.receipt.equals(receiptAfter);publicPreviewUnchanged=before.preview===null?previewAfter===null:before.preview.equals(previewAfter);assert.equal(publicReceiptUnchanged,true);assert.equal(publicPreviewUnchanged,true);}catch(error){failure??=error;}
  const report={schema:'mission-control-empty-setup-negative-v1',passed:!failure,featureProof:false,publicReceiptUnchanged,publicPreviewUnchanged,cleanup:runtime.cleanup,cleanupError:runtime.closeError?{code:runtime.closeError.code,message:runtime.closeError.message}:null,negativeReceipt:runtime.receipt(false,Object.assign(Error('A missing-capability view is not a successful feature/release gate.'),{code:'EMPTY_SETUP_NOT_RELEASEABLE'})),...(failure?{error:failure.message}:{})};
  await fs.mkdir(path.join(ROOT,'.harness'),{recursive:true});await fs.writeFile(path.join(ROOT,'.harness/sessions-empty-setup.json'),JSON.stringify(report,null,2)+'\n');if(failure)throw failure;
  return {passed:true,featureProof:false,publicReceiptUnchanged,publicPreviewUnchanged,cleanup:runtime.cleanup};
}

/** Copies the preview frame only from a passed, validated receipt of the current build. */
export async function promotePreview(){
  const receiptFile=path.join(ROOT,'evidence/native/sessions.json'),receipt=JSON.parse(await fs.readFile(receiptFile,'utf8'));
  assert.equal(receipt.ok,true,'Only a passed native receipt can release a preview');assert.equal(await validateNativeIsolationReceipt(receipt,{receiptPath:receiptFile}),true);
  const frame=receipt.frames.find(f=>f.label==='sessions-preview');assert.ok(frame,'The receipt has no sessions-preview frame');assert.equal(frame.capture,'macos-window-server');
  const source=path.join(ROOT,frame.path),bytes=await fs.readFile(source);assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.equal(sha(bytes),frame.sha256);
  const manifest=JSON.parse(await fs.readFile(path.join(ROOT,MOD,'build-manifest.json'),'utf8')),tested=receipt.packages.find(p=>p.name===MOD);assert.deepEqual(tested?.manifest,manifest,'The preview belongs to an older build');
  const target=path.join(ROOT,MOD,'preview.png');await fs.copyFile(source,target);assert.equal(sha(await fs.readFile(target)),frame.sha256);
  return {promoted:true,sha256:frame.sha256,frame:frame.path,width:frame.width,height:frame.height};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const mode=process.argv[2],check=mode==='fixture-check'?checkFixtures:mode==='empty-setup-check'?checkEmptySetup:mode==='promote-preview'?promotePreview:null;
  if(!check)throw Error('Use the reviewed native harness for the mounted gate, fixture-check for the core-free preflight, empty-setup-check for the private negative proof, or promote-preview after a passed receipt.');
  check().then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error);process.exitCode=1;});
}
