import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {NativeRuntime,NativeIsolationError,run,until,validateNativeIsolationReceipt} from '../../scripts/native-harness.mjs';
import {newConfig} from '../../src/shared/config.js';
import {localTerminalAddress,sessionKey} from '../../src/shared/session-identity.js';
import {parseCapabilities} from '../../src/shared/tool-capabilities.js';
import {launch,validateLaunchRequest} from '../../src/shared/launch.js';
import {launchMetadata} from '../../src/shared/tab-service.js';
import {LIMITS as CLOSED} from '../../src/shared/closed-tabs.js';
import {observeTab,deriveName,displayLabel,estimateWidth,clip,tabKey,NAME_LIMITS} from '../../src/shared/tab-names.js';

/*
 * Mounted proof for the standalone mission-control-tabs mod (TASK-064). One private app/core with
 * only this mod installed, plus a second positively owned private core reached through
 * `hc machine add --via` (qa-server) for the remote plus launch. Every select, reorder, close,
 * rename, wheel, swap, panel, source, menu, reopen and key action below is real PID-bound native
 * input; `herdr-app do` / `hc` calls are fixture setup (spaces, keyed fixture tabs, the two stress
 * layout switches) or read-only observation. Disposable actors, repos, title/status files and the
 * provider root live under the private runtime directories only. The test layouts use the root
 * `titlebar:none` + `traffic_lights`, the real mc-main / mc-work-panel / mc-work-stack contract and
 * shipped `workspace-status` placeholders for the seven stack children, because no source mod may be
 * installed in the standalone gate. The preview frame is promoted only by `promote-preview`, after
 * the harness has written and validated a passing receipt; a failed run leaves no preview.
 */
const MOD='mission-control-tabs',HOST='qa-server',PREVIEW='tabs-preview',RECEIPT='evidence/native/tabs.json';
const NAV='mission-control-tabs-nav-v1',COMMAND_EVENT='mission-control-tabs-command-v1';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const SELECTOR_KEYS=['HOME','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_RUNTIME_DIR','HC_SESSION','HERDR_APP_HOME'];
const execute=promisify(execFile),delay=ms=>new Promise(resolve=>setTimeout(resolve,ms)),sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const exists=file=>fs.access(file).then(()=>true,()=>false);
const readText=async file=>{try{return await fs.readFile(file,'utf8');}catch(error){if(error.code==='ENOENT')return null;throw error;}};
const readJson=async file=>{const raw=await readText(file);return raw===null?null:JSON.parse(raw);};

export const PREVIEW_LABEL=PREVIEW;
export const LAYOUTS=Object.freeze({overview:'mission-control',classic:'mission-control-classic',bare:'mission-control-tabs-bare',double:'mission-control-tabs-double',empty:'mission-control-tabs-empty'});
/** Private fixture keys bound to this mod's own commands (none is bound by default). */
export const KEYS=Object.freeze({rename:'ctrl-shift-u',automatic:'ctrl-shift-j'});
/**
 * Logical-pixel geometry the clicks rely on, read from the finished sources; fixture-check fails if
 * main.js / navigation.js / tab-names.js drift from it. pad = lightsPadding for traffic_lights [12,14].
 */
export const GEOMETRY=Object.freeze({width:1280,height:760,x:60,y:60,topbar:42,lights:[12,14],pad:76,rail:220,panel:360,nav:34,
  tabGap:6,tabIcon:14,mark:7,close:16,control:26,controlGap:4,barRight:8,swapPadX:9,swapIcon:14,swapGap:6,topbarWide:720,
  navButton:26,navGap:2,navPadX:6,navHide:24,displayPx:280,menu:{width:240,height:170},dialog:{width:560,height:660}});
const G=GEOMETRY;
export const SOURCE_IDS=Object.freeze(['jira','github','pulls','gitlab','merges','sessions','control-panel']);
/** [full label, short label] per source, as navigation.js draws them. */
export const SOURCE_LABELS=Object.freeze({jira:['Jira','Jira'],github:['GitHub issues','GitHub'],pulls:['Pull requests','PRs'],gitlab:['GitLab issues','GitLab'],merges:['Merge requests','MRs'],sessions:['Previous sessions','Sessions'],'control-panel':['Control panel','Control panel']});
/** Disposable tool actors: their help text decides exact-session capability; app decides Herdr's real tool icon. */
export const TOOLS=Object.freeze({
  claude:{name:'QA Claude',app:'claude-code',help:'Claude Code QA fixture\nUsage: claude [options] [prompt]\n --session-id <uuid>\n --resume [value]\n --model <model>'},
  codex:{name:'QA Codex',app:'codex',help:'Codex CLI QA fixture\nUsage: codex [OPTIONS] [PROMPT]'},
  grok:{name:'QA Grok',app:'grok',help:'Grok Build TUI QA fixture\nUsage: grok [OPTIONS] [PROMPT]\n --model <MODEL>'}
});
/** Issue / PR / MR work the source mods would have launched: acknowledged journal records for real fixture tabs. */
export const KEYED=Object.freeze([
  // k1 is a Codex fixture: an anonymous running Claude in this repository would (correctly) make Claude resumes ambiguous.
  {id:'k1',tool:'codex',kind:'jira',key:'ABC-123',title:'Fix login redirect',reported:'Redirect loop',status:'done',connectionId:'qa-jira',site:'https://jira.example.invalid',sourceId:'10123',url:'https://jira.example.invalid/browse/ABC-123'},
  {id:'k2',tool:'codex',kind:'github-pr',key:'GH-PR-42',title:'Review',reported:null,status:'idle',connectionId:'qa-github',site:'https://github.example.invalid',sourceId:'acme/web#42',url:'https://github.example.invalid/acme/web/pull/42'},
  {id:'k3',tool:'grok',kind:'gitlab-mr',key:'GL-MR-7',title:'Repair pipeline',reported:'Cache fix',status:'working',connectionId:'qa-gitlab',site:'https://gitlab.example.invalid',sourceId:'9007199254740999',url:'https://gitlab.example.invalid/group/web/-/merge_requests/7'}
]);
/** Names the shipped naming rules produce for these fixtures (fixture-check derives each one with tab-names.js). */
export const NAMES=Object.freeze({A:'Token refresh',A2:'Token refresh again',B:'Deploy checks',B2:'Deploy summary',D:'Watch server health',
  k1:'ABC-123 Redirect loop',k2:'GH-PR-42 Review',k3:'GL-MR-7 Cache fix',manualA:'login fix',manualK1:'redirect notes',manualK2:'pr notes',shell:'fixture-repo',
  longB:'Investigate the intermittent deployment check failures after the cache warmup job rotates overnight'});
export const LONG_B_NAME=clip(NAMES.longB,NAME_LIMITS.chars);

/** Every runtime.expect label this scenario emits (the package gate requires exactly these plus the harness's own). */
export const EXPECTATIONS=Object.freeze({
  emptyReopen:'With nothing closed, Reopen last tab and Reopen last agent are disabled, say why and start nothing',
  panelStartsHidden:'The Classic work panel starts hidden and the bar’s panel control shows it',
  iconSources:'The narrow Classic panel shows icon-only work sources whose tooltips name them; selecting one marks it shown',
  absentSource:'A source missing from the layout is disabled with its reason and selects nothing',
  panelHideButton:'The work panel’s own hide button hides it again',
  swapToOverview:'The one-button swap switches Classic to Mission Control without creating or closing tabs, keeping focus and terminal addresses',
  sourceRestored:'The swapped-in view restores the selected source and its scope',
  plusMenu:'The plus opens this mod’s own agent menu for the shown space, never a shipped menu',
  plusLaunchLocal:'The plus launches the chosen agent with an exact session in the shown space’s repository on this Mac',
  genericName:'A generic agent tab takes its reported conversation title automatically',
  plusLaunchRemote:'The plus launches on the selected remote host in that space’s repository',
  remoteName:'A remote agent tab is named automatically on its own host',
  keyedNames:'Issue, PR and MR tabs keep their keys beside the reported conversation or task title',
  toolFallback:'A tool that reports no conversation title falls back to its task title',
  fourStatuses:'Disposable actors report all four agent statuses on tabs in one strip',
  statusMarks:'The four status marks are drawn and distinct, idle as a hollow ring',
  toolIcons:'Each agent tab draws its actual tool icon beside its task label',
  oneStrip:'Exactly one topmost strip, clear of the traffic lights, lists every tab',
  wideNavigation:'At 1024 px beside a 220 px rail all seven work sources show whole short labels without clipping (full labels need 913 px)',
  narrowNavigation:'At 736 px all seven work sources stay reachable with short labels in compact padding',
  narrowSelect:'A short-label source can be selected at 736 px',
  sourcesToggle:'The tab bar gear opens Mission Control sources; turning GitLab issues off removes it from the strip and turning it on brings it back',
  select:'Clicking a tab selects it',
  wheel:'One wheel gesture over the bar switches exactly one adjacent tab each way',
  reorder:'A real drag from one tab onto another moves it to that position',
  dragOutside:'Drags released outside a tab, on the empty strip or started outside the strip select, move and close nothing and never move the window',
  hover:'A long automatic title is bounded to 280 px and the full title shows on hover',
  manualRename:'A tab-menu rename records the person’s name for the exact agent',
  manualKept:'Later reported titles never overwrite the person’s name',
  backToAuto:'Use automatic name returns a renamed tab to its automatic name',
  keyCommands:'The rename and automatic-name key commands rename the shown tab and return it to automatic naming',
  shellNames:'A shell tab shows its running program, then its folder again at the prompt',
  swapKeeps:'Swapping to Classic and back keeps every tab, manual name, terminal address and the selected source',
  panelToggleHide:'The bar’s panel control hides an open work panel',
  stripClose:'The strip’s close button and the tab menu’s Close tab close exactly those tabs and record each close once',
  reopenAgent:'Reopen last agent skips the newer shell and resumes the exact closed agent once in a new tab',
  manualTransfer:'The closed non-last agent’s manual name returns once on its new tab while newer B keeps its name',
  reopenTab:'Reopen last tab restores the shell in its folder under its automatic name and replays nothing',
  missingResume:'An agent without an exact session cannot be reopened as an agent; the strip says why and starts nothing',
  twoBars:'Two visible bars share one naming lease',
  resumedAuto:'A resumed agent keeps its automatic name and follows its next reported title',
  oneRename:'With two bars mounted one title change produces exactly one rename',
  bareSwap:'Without Mission Control nodes the swap control is disabled and says why',
  barePanel:'Without mc-work-panel the panel control is disabled and says why',
  bareSources:'Without mc-work-stack all seven sources are disabled with a visible reason',
  bareStrip:'Without layout nodes the strip still selects tabs and opens the agent menu',
  noErrors:'Every tabs workflow produced zero native app errors',
  standalone:'Only this standalone custom mod is installed and it passed herdr-app check',
  restartOffer:'An offered resume after a restart shows the Resume pill in the bar, and Resume in its popup types the exact command once'
});

// ---------------------------------------------------------------------------------------------
// Test layouts: the real node contract with placeholders, so only this mod is installed.
// ---------------------------------------------------------------------------------------------
const block=(id,content,extra={})=>({id,type:'block',...extra,content});
const topbar=(props,id='mc-topbar',drag=true)=>block(id,{mod:MOD,props},{size:{px:G.topbar},...(drag?{window_drag:true}:{})});
const navigation=(id='mc-navigation')=>block(id,{mod:MOD,props:{view:'navigation'}},{size:{px:G.nav}});
const stack=(omit=[])=>({id:'mc-work-stack',type:'stack',active:'jira',children:SOURCE_IDS.filter(id=>!omit.includes(id)).map(id=>block(id,{mod:'workspace-status'}))});
const rail=()=>({id:'sidebar',type:'column',size:{px:G.rail},children:[block('rail-spaces',{mod:'spaces'})]});
const terminals=(extra={})=>block('mc-terminals',{tab:'active'},extra);
const root=children=>({id:'qa-root',type:'column',titlebar:'none',traffic_lights:[...G.lights],theme:'graphite',children});
export function testLayouts(){
  const overview=root([topbar({view:'topbar',swapTo:LAYOUTS.classic}),{id:'mc-body',type:'row',children:[rail(),{id:'mc-main',type:'column',children:[{id:'mc-work',type:'column',size:{weight:3},children:[navigation(),stack()]},terminals({size:{weight:2}})]}]}]);
  // Classic omits the merges child on purpose: the navigation must disable an absent source, not hide it.
  const classic=root([topbar({view:'topbar',swapTo:LAYOUTS.overview,panel:true}),{id:'mc-body',type:'row',children:[rail(),{id:'mc-main',type:'row',children:[terminals(),{id:'mc-work-panel',type:'column',size:{px:G.panel},hidden:true,children:[navigation(),stack(['merges'])]}]}]}]);
  const bare=root([topbar({view:'topbar',panel:true}),navigation('qa-orphan-navigation'),terminals()]);
  const double=structuredClone(overview);double.children.push(topbar({view:'topbar',swapTo:LAYOUTS.classic},'qa-second-topbar',false));
  return {[LAYOUTS.overview]:overview,[LAYOUTS.classic]:classic,[LAYOUTS.bare]:bare,[LAYOUTS.double]:double,[LAYOUTS.empty]:structuredClone(bare)};
}
/** What each layout's top bar shows right of the tabs: the swap text and whether a panel control sits beside it. */
const LAYOUT_UI=Object.freeze({[LAYOUTS.overview]:{swap:'Classic view',panel:false},[LAYOUTS.classic]:{swap:'Mission Control',panel:true},[LAYOUTS.double]:{swap:'Classic view',panel:false},[LAYOUTS.bare]:{swap:'Switch view',panel:true},[LAYOUTS.empty]:{swap:'Switch view',panel:true}});
/** An inert point inside the shown tab's terminal block, used to park the pointer and focus the shell. */
function terminalPoint(layout,w){
  if(layout===LAYOUTS.overview||layout===LAYOUTS.double)return {x:G.rail+(w.width-G.rail)/2,y:w.height-(layout===LAYOUTS.double?G.topbar:0)-50};
  if(layout===LAYOUTS.classic)return {x:G.rail+70,y:w.height/2};
  return {x:w.width/2,y:G.topbar+G.nav+(w.height-G.topbar-G.nav)/2};
}
const inTop=n=>n.frame.y+n.frame.height/2<G.topbar;
const inBottom=(n,o)=>n.frame.y+n.frame.height/2>o.window.height-G.topbar;
const inNav=n=>n.frame.y>=G.topbar-1&&n.frame.y+n.frame.height<=G.topbar+G.nav+1&&n.frame.x>=G.rail-2;
const inNavRow=n=>n.frame.y>=G.topbar-1&&n.frame.y+n.frame.height<=G.topbar+G.nav+1;
const inStack=(n,o)=>n.frame.x>=G.rail&&n.frame.y>G.topbar+G.nav&&n.frame.y<G.topbar+(o.window.height-G.topbar)*0.6;
const inPanel=(n,o)=>n.frame.x>=o.window.width-G.panel&&n.frame.y>G.topbar+G.nav;
const inFooter=(n,o)=>inDialog(n,o)&&n.frame.y>o.window.height/2+150;
const inDialog=(n,o)=>{const left=(o.window.width-G.dialog.width)/2,top=(o.window.height-G.dialog.height)/2;return n.frame.x>=left&&n.frame.x+n.frame.width<=left+G.dialog.width&&n.frame.y>=top&&n.frame.y+n.frame.height<=top+G.dialog.height;};
const inPopup=anchor=>n=>n.frame.y>anchor.y-4&&n.frame.y<anchor.y+G.menu.height+40&&n.frame.x>anchor.x-60&&n.frame.x<anchor.x+G.menu.width+40;
const near=rect=>n=>Math.abs(n.frame.y-(rect.y+rect.height/2))<260&&n.frame.x>rect.x-680&&n.frame.x<rect.x+360;

// ---------------------------------------------------------------------------------------------
// Disposable fixtures.
// ---------------------------------------------------------------------------------------------
/** A tool actor: exact help, recorded argv/cwd/pid, OSC 2 title and OSC 7501 status read from its own files. */
export function actorSource(tool,directory){const t=TOOLS[tool];return String.raw`#!/usr/bin/env python3
import os,sys,json,time,select
TOOL=${JSON.stringify(tool)}
APP=${JSON.stringify(t.app)}
HELP=${JSON.stringify(t.help)}
ROOT=${JSON.stringify(directory)}
argv=sys.argv[1:]
if '--help' in argv:
 print(HELP)
 sys.exit(0)
if '--version' in argv:
 print('Native tabs fixture 1.0')
 sys.exit(0)
def after(flag):
 if flag in argv and argv.index(flag)+1<len(argv): return argv[argv.index(flag)+1]
 return None
ident=after('--session-id') or after('--resume') or after('--qa-id') or 'tool-'+TOOL
def read(kind,default):
 try:
  with open(os.path.join(ROOT,kind,ident)) as handle: value=handle.read().strip()
  return value or default
 except OSError:
  return default
record={'tool':TOOL,'id':ident,'pid':os.getpid(),'cwd':os.getcwd(),'argv':argv,'startedMs':int(time.time()*1000)}
file=os.path.join(ROOT,'runs',str(os.getpid())+'.json')
with open(file+'.next','w') as output: json.dump(record,output)
os.replace(file+'.next',file)
print('Disposable '+TOOL+' tabs actor; no provider call.',flush=True)
title=None
state=None
sent=0
while True:
 # Until its title file exists the actor reports only its own tool name, which is never a conversation title.
 wanted=read('titles',TOOL)
 status=read('status','idle')
 if status not in ('working','blocked','done','idle'): status='idle'
 if wanted!=title:
  sys.stdout.write('\x1b]2;'+wanted+'\x1b\\')
  title=wanted
 if status!=state or time.time()-sent>=5:
  sys.stdout.write('\x1b]7501;state='+status+':app='+APP+'\x1b\\')
  state=status
  sent=time.time()
 sys.stdout.flush()
 ready,_,_=select.select([sys.stdin],[],[],0.4)
 if ready:
  try: chunk=os.read(sys.stdin.fileno(),65536)
  except OSError: chunk=b''
  if not chunk: break
`;}
export async function writeActors(directory){
  const dir=path.join(directory,'tabs-actors'),files={},programs={};
  for(const sub of ['titles','status','runs'])await fs.mkdir(path.join(dir,sub),{recursive:true});
  for(const tool of Object.keys(TOOLS)){const file=path.join(directory,'qa-'+tool);await fs.writeFile(file,actorSource(tool,dir));await fs.chmod(file,0o700);files[tool]=file;programs[tool]={name:TOOLS[tool].name,run:[file]};}
  const put=async(kind,id,value)=>{assert.match(id,/^[A-Za-z0-9-]{1,64}$/);const file=path.join(dir,kind,id);await fs.writeFile(file+'.next',value+'\n');await fs.rename(file+'.next',file);};
  return {dir,files,programs,setTitle:(id,value)=>put('titles',id,value),setStatus:(id,value)=>put('status',id,value),
    async runs(){const out=[];for(const name of await fs.readdir(path.join(dir,'runs')))if(/^[0-9]+\.json$/.test(name))try{out.push(JSON.parse(await fs.readFile(path.join(dir,'runs',name),'utf8')));}catch{}return out;}};
}
export const viaSource=selectors=>`#!/usr/bin/env python3\nimport os,sys,json\ne=os.environ.copy();e.update(json.loads(${JSON.stringify(JSON.stringify(selectors))}))\nos.execvpe('/bin/sh',['sh','-c',sys.argv[-1]],e)\n`;
/** Private settings: one claude provider profile (so plus launches get exact caller sessions) and pinned fixture tools. */
export function fixtureConfig(providerRoot){
  const config=newConfig();config.usageSources={'claude-local':{v:1,enabled:true,machine:null,provider:'claude',credentialScope:'qa-claude-local',providerRoot,roots:[providerRoot+'/projects']}};
  config.preferences.launch={v:1,pins:['claude','codex','grok'],hidden:[],worktree:false,tools:{}};return config;
}
/** An acknowledged, complete LaunchRequest v1 journal record for a fixture tab, valid for launch.js's own journal reader. */
export function keyedRecord(k,{spaceId,repo,ack,now=Date.now()}){
  const request=validateLaunchRequest({requestId:'qa-'+k.id,idempotencyKey:'qa-'+k.id,originId:'qa-origin-'+k.id,spaceId,machine:null,repoRoot:repo,checkoutRoot:repo,toolKey:k.tool,
    source:{kind:k.kind,connectionId:k.connectionId,site:k.site,id:k.sourceId,key:k.key,title:k.title,url:k.url},worktree:false});
  const key=JSON.stringify([request.machine,request.repoRoot,'source',JSON.stringify([request.source.kind,request.source.connectionId,request.source.site,request.source.id]),request.toolKey]);
  return {request,key,owner:'qa-fixture',state:'complete',createdAt:now,updatedAt:now,leaseUntil:0,tabAttempted:true,sessionProposal:null,folder:repo,initialName:`${k.key} ${k.title}`.slice(0,200),ack:{space:ack.space,tab:ack.tab,terminal:ack.terminal}};
}
export async function appendJournal(file,records){
  for(let attempt=0;attempt<6;attempt++){
    const raw=await readText(file),value=raw?JSON.parse(raw):{v:1,revision:0,requests:{}};
    for(const r of records)value.requests[r.request.requestId]=r;value.revision++;
    const next=file+'.'+crypto.randomBytes(6).toString('hex');await fs.writeFile(next,JSON.stringify(value)+'\n');
    if(await readText(file)!==raw){await fs.rm(next,{force:true});await delay(120);continue;}
    await fs.rename(next,file);return value;
  }
  throw Error('The fixture launch journal kept changing');
}
/** Node-side CAS file access with the same expected-bytes contract as Herdr's writeTextFile. */
export function fileIO(home){
  return {appHome:()=>home,ensureDirectory:directory=>fs.mkdir(directory,{recursive:true}),readTextFile:readText,
    async writeTextFile(file,text,expected){if(await readText(file)!==(expected??null))throw Object.assign(Error('stale'),{code:'STALE'});const next=file+'.'+crypto.randomBytes(6).toString('hex');await fs.writeFile(next,text);await fs.rename(next,file);}};
}
async function bindKeys(home){
  const file=path.join(home,'keys.json'),read=async()=>{const raw=await readText(file);return raw?JSON.parse(raw):null;};
  // Herdr writes its own key map into a fresh home; merge into it rather than replacing it.
  let keys=null;for(let attempt=0;attempt<20&&!keys;attempt++){keys=await read();if(!keys)await delay(250);}keys??={};
  for(const key of Object.values(KEYS))assert.ok(!Object.values(keys).some(section=>section&&typeof section==='object'&&Object.hasOwn(section,key)),'The private fixture key '+key+' must be unbound before it is bound');
  keys.global={...(keys.global||{}),[KEYS.rename]:MOD+'.rename',[KEYS.automatic]:MOD+'.automatic-name'};await fs.writeFile(file,JSON.stringify(keys,null,2)+'\n');await delay(1500);
  assert.equal(await exists(path.join(home,'keys.error')),false,'Herdr accepted the private tabs key bindings');
}

// ---------------------------------------------------------------------------------------------
// Window placement (AX, owned PID only) and pixel evidence from the actual WindowServer frame.
// ---------------------------------------------------------------------------------------------
const POSITION=String.raw`import Cocoa
import ApplicationServices
let args=CommandLine.arguments
func fail(_ message:String)->Never {FileHandle.standardError.write(message.data(using:.utf8)!);exit(2)}
guard args.count==6,let pid=Int32(args[1]),let x=Double(args[2]),let y=Double(args[3]),let width=Double(args[4]),let height=Double(args[5]) else {fail("Usage: pid x y width height")}
guard let application=NSRunningApplication(processIdentifier:pid) else {fail("Owned app is unavailable")}
application.activate()
var raw:CFTypeRef?
guard AXUIElementCopyAttributeValue(AXUIElementCreateApplication(pid),kAXWindowsAttribute as CFString,&raw) == .success,let windows=raw as? [AXUIElement] else {fail("Owned AX windows unavailable")}
let main=windows.filter {window in
 var value:CFTypeRef?
 guard AXUIElementCopyAttributeValue(window,kAXSizeAttribute as CFString,&value) == .success,let v=value,CFGetTypeID(v)==AXValueGetTypeID() else {return false}
 var size=CGSize.zero
 return AXValueGetValue(v as! AXValue,.cgSize,&size) && size.width>=600 && size.height>=500
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
var size=CGSize(width:width,height:height),point=CGPoint(x:x,y:y)
guard let s=AXValueCreate(.cgSize,&size),let p=AXValueCreate(.cgPoint,&point),AXUIElementSetAttributeValue(main[0],kAXPositionAttribute as CFString,p) == .success,AXUIElementSetAttributeValue(main[0],kAXSizeAttribute as CFString,s) == .success else {fail("Owned window positioning failed")}
_ = AXUIElementPerformAction(main[0],kAXRaiseAction as CFString)
let all=CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements],kCGNullWindowID) as? [[String:Any]] ?? []
let owned=all.filter {record in
 guard (record[kCGWindowOwnerPID as String] as? Int)==Int(pid),(record[kCGWindowLayer as String] as? Int)==0,let b=record[kCGWindowBounds as String] as? [String:Any],let r=CGRect(dictionaryRepresentation:b as CFDictionary) else {return false}
 return r.width>=600 && r.height>=500
}
guard owned.count==1,let id=owned[0][kCGWindowNumber as String] as? Int else {fail("A unique owned visible window is required")}
let data=try! JSONSerialization.data(withJSONObject:["windowId":id]);FileHandle.standardOutput.write(data)
`;
export async function positionWindow(runtime,{width=G.width,height=G.height,x=G.x,y=G.y,compileOnly=false,directory=runtime?.directory,cache=path.join(ROOT,'.harness/swift-cache')}={}){
  const source=path.join(directory,'tabs-position.swift'),binary=path.join(directory,'tabs-position');
  if(!await exists(binary)){await fs.writeFile(source,POSITION);run('swiftc',['-module-cache-path',cache,source,'-o',binary],{json:false,timeout:180000});}
  if(compileOnly)return binary;
  await until(async()=>{const result=run(binary,[String(runtime.owner.pid),String(x),String(y),String(width),String(height)]);if(result.retry)return false;const frame=await runtime.driver.bindWindow(result.windowId);return Math.abs(frame.width-width)<2&&Math.abs(frame.height-height)<2&&Math.abs(frame.x-x)<2&&Math.abs(frame.y-y)<2;},`owned Tabs window at ${width}×${height}`,30000);
}
/** 8-bit RGB/RGBA non-interlaced PNG, the format the WindowServer capture writes. */
export function decodePng(bytes){
  if(bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw Error('Not a PNG');
  let offset=8,width=0,height=0,depth=0,type=0,interlace=1;const data=[];
  while(offset+8<=bytes.length){const length=bytes.readUInt32BE(offset),kind=bytes.toString('latin1',offset+4,offset+8),body=bytes.subarray(offset+8,offset+8+length);offset+=12+length;
    if(kind==='IHDR'){width=body.readUInt32BE(0);height=body.readUInt32BE(4);depth=body[8];type=body[9];interlace=body[12];}else if(kind==='IDAT')data.push(body);else if(kind==='IEND')break;}
  if(depth!==8||![2,6].includes(type)||interlace!==0||!width||!height)throw Error('Unsupported PNG layout');
  const channels=type===6?4:3,stride=width*channels,raw=zlib.inflateSync(Buffer.concat(data)),pixels=Buffer.alloc(stride*height);
  if(raw.length!==(stride+1)*height)throw Error('Truncated PNG data');
  for(let y=0;y<height;y++){
    const filter=raw[y*(stride+1)],line=raw.subarray(y*(stride+1)+1,(y+1)*(stride+1)),out=pixels.subarray(y*stride,(y+1)*stride),prev=y?pixels.subarray((y-1)*stride,y*stride):null;
    for(let x=0;x<stride;x++){
      const a=x>=channels?out[x-channels]:0,b=prev?prev[x]:0,c=prev&&x>=channels?prev[x-channels]:0;let v=line[x];
      if(filter===1)v+=a;else if(filter===2)v+=b;else if(filter===3)v+=(a+b)>>1;else if(filter===4){const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);v+=pa<=pb&&pa<=pc?a:pb<=pc?b:c;}else if(filter!==0)throw Error('Unknown PNG filter');
      out[x]=v&255;
    }
  }
  return {width,height,channels,pixel:(x,y)=>{const i=(y*width+x)*channels;return [pixels[i],pixels[i+1],pixels[i+2]];}};
}
const distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);
const bounds=(image,scale,rect)=>({x0:Math.max(0,Math.floor(rect.x*scale)),y0:Math.max(0,Math.floor(rect.y*scale)),x1:Math.min(image.width,Math.ceil((rect.x+rect.width)*scale)),y1:Math.min(image.height,Math.ceil((rect.y+rect.height)*scale))});
/** Median color of a window-coordinate rectangle. */
export function backgroundOf(image,scale,rect){
  const {x0,y0,x1,y1}=bounds(image,scale,rect),values=[[],[],[]];for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){const p=image.pixel(x,y);for(let c=0;c<3;c++)values[c].push(p[c]);}
  if(!values[0].length)throw Error('Empty background sample');return values.map(v=>v.sort((a,b)=>a-b)[v.length>>1]);
}
/** Pixels that differ from the background: how many, their mean color, and whether the drawn shape is hollow in its middle. */
export function inkStats(image,scale,rect,background,{threshold=60}={}){
  const {x0,y0,x1,y1}=bounds(image,scale,rect),sum=[0,0,0],inked=new Set();let count=0,minX=Infinity,minY=Infinity,maxX=-1,maxY=-1;
  for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){const p=image.pixel(x,y);if(distance(p,background)<=threshold)continue;count++;for(let c=0;c<3;c++)sum[c]+=p[c];inked.add(y*image.width+x);minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);}
  const center=count?Math.round((minY+maxY)/2)*image.width+Math.round((minX+maxX)/2):-1;
  return {count,mean:count?sum.map(v=>Math.round(v/count)):null,hollow:count?!inked.has(center):null,box:count?{x:minX/scale,y:minY/scale,width:(maxX-minX+1)/scale,height:(maxY-minY+1)/scale}:null};
}

// ---------------------------------------------------------------------------------------------
// Native observation and input helpers (OCR of the actual frame; PID-bound pointer and keys).
// ---------------------------------------------------------------------------------------------
function nativeUI(runtime,{budget=800}={}){
  let serial=0;
  const status=()=>runtime.app(['status']),layoutName=()=>status().layout,overlays=()=>status().overlays||[];
  const observe=async(query='')=>{
    if(++serial>budget)throw Error('Native Tabs observation budget exhausted');
    const frame=await runtime.frame('tabs-observe-'+serial),o=await runtime.driver.ocr(path.join(ROOT,frame.path),query);
    const banner=o.lines.find(n=>/\binterrupted\b|could not be re.?rendered|render(?:ing)? (?:error|failed)|could not complete this action/i.test(n.text));
    if(banner)throw Error('Native render/action error banner: '+banner.text);return o;
  };
  // A control can still be moving after a status, rename or focus change: act only once two frames agree.
  const pick=async(query,where,{index=0,min=1,only=false,description=query,timeout=45000}={})=>{
    let prior=null,hit=null;
    await until(async()=>{const o=await observe(query),m=o.matches.filter(n=>n.confidence>=0.6&&where(n,o)).sort((a,b)=>a.frame.y-b.frame.y||a.frame.x-b.frame.x),node=index==='last'?m.at(-1):m[index];
      if(m.length<min||only&&m.length!==1||!node)return false;const box=JSON.stringify(node.frame);if(box===prior){hit={observation:o,node,count:m.length,matches:m};return true;}prior=box;return false;},'steady native control '+description,timeout);
    return hit;
  };
  const annotate=(control,observation)=>Object.assign(runtime.driver.actions.at(-1),{control,observation:observation.source});
  const clickRect=async(rect,observation,control,{button='left'}={})=>{await runtime.driver.click(rect,{button,expectedSize:observation.window});annotate(control,observation);};
  const clickHit=async(hit,control)=>{await runtime.driver.clickObservedText(hit.observation,hit.node);runtime.driver.actions.at(-1).control=control;};
  const click=async(query,where,options={})=>{const hit=await pick(query,where,options);await clickHit(hit,options.control||query);return hit;};
  const has=async(query,where=()=>true)=>{const o=await observe(query);return o.matches.some(n=>n.confidence>=0.6&&where(n,o));};
  const visible=(query,where=()=>true,timeout=45000)=>until(async()=>{const o=await observe(query),m=o.matches.filter(n=>n.confidence>=0.6&&where(n,o));return m.length?{observation:o,node:m[0],matches:m}:null;},'visible native text '+query,timeout);
  const lineOf=(o,node)=>o.lines.find(l=>l.frame.x<=node.frame.x+1&&l.frame.x+l.frame.width>=node.frame.x+node.frame.width-1&&Math.abs(l.frame.y+l.frame.height/2-node.frame.y-node.frame.height/2)<6)||null;
  // A tooltip appears beside the resting pointer after the click that put it there.
  // The click proves a disabled control does nothing; leaving and re-entering shows its tooltip, which mouse-down hid.
  const tip=async(rect,observation,control,text,{timeout=20000}={})=>{await clickRect(rect,observation,control);await runtime.driver.hover({x:rect.x,y:rect.y+rect.height+40,width:2,height:2},{expectedSize:observation.window});await runtime.driver.hover(rect,{expectedSize:observation.window});return visible(text,near(rect),timeout);};
  /** The control rectangles right of the tabs, measured from the observed swap text. */
  const controls=async({bar='top'}={})=>{
    const layout=layoutName(),spec=LAYOUT_UI[layout];if(!spec)throw Error('No bar geometry for layout '+layout);
    // A tooltip from a hovered bar button can cover the swap label; rest the pointer over the terminal first.
    {const o=await observe(),p=terminalPoint(layout,o.window);await runtime.driver.hover({x:p.x-2,y:p.y-2,width:4,height:4},{expectedSize:o.window});await delay(400);}
    const region=bar==='top'?inTop:inBottom,hit=await pick(spec.swap,(n,o)=>region(n,o)&&n.frame.x>o.window.width/2,{only:true,description:'swap control '+spec.swap+' ('+bar+')'});
    const f=hit.node.frame,left=f.x-G.swapGap-G.swapIcon-G.swapPadX,top=(bar==='top'?0:hit.observation.window.height-G.topbar)+(G.topbar-G.control)/2;
    const order=spec.panel?['sources','panel','reopen-agent','reopen-tab','plus']:['sources','reopen-agent','reopen-tab','plus'],rects={};
    order.forEach((name,index)=>{const right=left-G.controlGap-index*(G.control+G.controlGap);rects[name]={x:right-G.control,y:top,width:G.control,height:G.control};});
    rects.swap={x:left,y:top,width:f.x+f.width+G.swapPadX-left,height:G.control};
    return {observation:hit.observation,rects,swapText:hit};
  };
  const park=async()=>{const o=await observe(),p=terminalPoint(layoutName(),o.window);await clickRect({x:p.x-4,y:p.y-4,width:8,height:8},o,'Inert terminal area');};
  const navIcon=(index,o)=>({x:o.window.width-G.panel+G.navPadX+index*(G.navButton+G.navGap),y:G.topbar+(G.nav-G.navButton)/2,width:G.navButton,height:G.navButton});
  const panelHide=o=>({x:o.window.width-G.navPadX-G.navHide,y:G.topbar+(G.nav-G.navHide)/2,width:G.navHide,height:G.navHide});
  const openMenu=async({bar='top'}={})=>{
    const c=await controls({bar});await clickRect(c.rects.plus,c.observation,'New agent or terminal');
    await until(()=>overlays().includes(MOD),'own agent menu overlay',20000);const header=await visible('Start working',inDialog,30000);
    return {header,shipped:overlays().some(name=>['new-menu','menu'].includes(name))};
  };
  const closeOverlay=async()=>{await runtime.driver.press('escape');await until(()=>!overlays().length,'closed native overlay',20000);};
  return {status,layoutName,overlays,observe,pick,click,clickRect,clickHit,has,visible,lineOf,tip,controls,park,navIcon,panelHide,openMenu,closeOverlay,annotate};
}

export default async function tabsNative(runtime){
  const home=runtime.env.HERDR_APP_HOME,state=path.join(home,'mission-control'),server=new NativeRuntime();
  const files={config:path.join(state,'config.json'),launches:path.join(state,'launches.json'),names:path.join(state,'names.json'),bindings:path.join(state,'session-bindings.json'),tabNames:path.join(state,'tab-names.json'),closed:path.join(state,'closed.json')};
  const diagnostics=path.join(ROOT,'.browse/sessions',`mission-control-native-${runtime.nonce}`);
  let connected=false,actor=null,failure,cleanupError,pixels=null;
  const progress=stage=>fs.mkdir(path.join(ROOT,'.harness'),{recursive:true}).then(()=>fs.writeFile(path.join(ROOT,'.harness/tabs-progress.json'),JSON.stringify({stage,nonce:runtime.nonce,assertions:runtime.assertions.length})+'\n')).catch(()=>{});
  const expect=(value,key)=>{if(!Object.hasOwn(EXPECTATIONS,key))throw Error('Unknown tabs expectation '+key);runtime.expect(value,EXPECTATIONS[key]);};
  // Read-only observation of the private world and the mod's own state files.
  const world=()=>runtime.app(['ls']).spaces||[];
  const allTabs=()=>world().flatMap(s=>(s.tabs||[]).map(t=>({space:s.id,id:t.id,name:t.name,named:t.named??null})));
  const tabsIn=id=>world().find(s=>s.id===id)?.tabs||[];
  const order=()=>tabsIn(runtime.spaceId).map(t=>t.id);
  const tabById=id=>allTabs().find(t=>t.id===id)||null;
  const nameOf=id=>tabById(id)?.name??null;
  const focused=()=>runtime.app(['status']).tab;
  const activeSpace=()=>world().find(s=>s.active)||null;
  const named=(id,name,timeout=45000)=>until(()=>{const t=tabById(id);return t&&t.name===name&&t.named!==false?t:null;},'tab '+id+' named '+name,timeout);
  const stable=async(id,name,ms)=>{const end=Date.now()+ms;while(Date.now()<end){if(nameOf(id)!==name)return false;await delay(400);}return true;};
  const quiet=(ms=7000)=>until(async()=>{const first=JSON.stringify(allTabs());await delay(ms);return JSON.stringify(allTabs())===first;},'tab names settled',90000);
  const liveTerminals=core=>(core.hc(['ls','--json']).terminals||[]).filter(t=>t.state===undefined||t.state==='live').map(t=>t.address).sort();
  const journal=async()=>Object.values((await readJson(files.launches))?.requests||{});
  const requestIds=async()=>new Set((await journal()).map(r=>r.request.requestId));
  const newRecord=(before,test,label,timeout=90000)=>until(async()=>(await journal()).find(r=>!before.has(r.request.requestId)&&r.state==='complete'&&test(r))||null,label,timeout);
  const originOf=async session=>Object.values((await readJson(files.names))?.origins||{}).filter(o=>o.session&&sessionKey(o.session)===sessionKey(session));
  const closedRecords=async()=>(await readJson(files.closed))?.records||[];
  const recordsOf=async id=>(await closedRecords()).filter(r=>r.tab?.id===id);
  // Wait two more watcher periods after the first record so a second copy has had every chance to double-record.
  const recorded=async(id,label)=>{await until(async()=>(await recordsOf(id)).length>0,'recorded close of '+label,45000);await delay(CLOSED.observeMs*2+1000);return recordsOf(id);};
  const tabEntry=async(machine,id)=>(await readJson(files.tabNames))?.tabs?.[tabKey(machine,id)]??null;
  const navState=async()=>(await runtime.shared())[NAV]??null;
  const windowFrame=async()=>{const {frame}=await runtime.driver.pointerTarget({x:1,y:1,width:2,height:2});return JSON.stringify([frame.x,frame.y,frame.width,frame.height]);};
  try{
    await progress('fixtures');console.log('Tabs native: private fixtures, disposable actors and a second owned core');
    // Empty startup files keep zsh from running its interactive new-user setup in fixture shells.
    await fs.writeFile(path.join(runtime.env.HOME,'.zshrc'),'# Disposable native fixture shell\n');await fs.writeFile(path.join(runtime.env.HOME,'.profile'),"PS1='$ '\n");// neutral prompt: no host or user names in previews
    actor=await writeActors(runtime.directory);
    await server.start();await fs.writeFile(path.join(server.env.HOME,'.zshrc'),'# Disposable native fixture shell\n');await fs.writeFile(path.join(server.env.HOME,'.profile'),"PS1='$ '\n");
    const via=path.join(runtime.directory,'tabs-via.py');await fs.writeFile(via,viaSource(Object.fromEntries(Object.entries(server.env).filter(([key])=>SELECTOR_KEYS.includes(key)))));await fs.chmod(via,0o700);
    runtime.hc(['machine','add','--via',via,'--name',HOST,'--session',server.env.HC_SESSION,'--json']);connected=true;
    const providerRoot=path.join(runtime.directory,'providers/claude');await fs.mkdir(path.join(providerRoot,'projects'),{recursive:true});
    await fs.mkdir(state,{recursive:true});await fs.writeFile(files.config,JSON.stringify(fixtureConfig(providerRoot))+'\n');
    await fs.writeFile(path.join(home,'programs.json'),JSON.stringify({programs:actor.programs})+'\n');
    await runtime.installPackage(MOD);
    const layouts=testLayouts();await fs.mkdir(path.join(home,'layouts'),{recursive:true});
    for(const name of [LAYOUTS.overview,LAYOUTS.bare,LAYOUTS.double])await fs.writeFile(path.join(home,'layouts',name+'.json'),JSON.stringify(layouts[name],null,2)+'\n');
    await fs.writeFile(path.join(home,'window.json'),JSON.stringify({state:'windowed',bounds:[G.x,G.y,G.width,G.height]})+'\n');
    await runtime.startWindow({name:'classic',layout:layouts[LAYOUTS.classic]});await positionWindow(runtime);
    const remote=await until(()=>world().find(s=>s.machine===HOST),'remote fixture space adoption',60000);
    runtime.app(['do','space.rename',JSON.stringify({id:runtime.spaceId,name:'client-portal'})]);runtime.app(['do','space.rename',JSON.stringify({id:remote.id,name:'server-repo'})]);
    runtime.app(['do','space.select',JSON.stringify({id:runtime.spaceId})]);await bindKeys(home);
    const ui=nativeUI(runtime),{pick,click,clickRect,clickHit,has,visible,tip,controls,park}=ui;
    // Herdr's own "herdr-core <version> is ready · Open Updates" notice can appear after start over the bottom-right corner.
    // Close it with its × as a person would (about 28 px right of the link); it is the app's, not this mod's.
    const notice=await until(async()=>{const o=await ui.observe('Open Updates'),n=o.matches.find(m=>m.confidence>=0.6);return n?{o,n}:null;},'Herdr update notice',12000).catch(()=>null);
    if(notice){await clickRect({x:notice.n.frame.x+notice.n.frame.width+20,y:notice.n.frame.y+notice.n.frame.height/2-8,width:16,height:16},notice.o,'Close the Herdr update notice');
      await until(async()=>!(await has('Open Updates')),'Herdr update notice closed',20000);}
    // The bar refreshes its Reopen preview on its own tick; click only once the button's tooltip names the expected agent (its tab name at close),
    // so a premature click never lands on a still-disabled button and a retry never reopens a different agent.
    const reopenAgentWhenReady=async(name,label)=>{let c;await until(async()=>{c=await controls();const r=c.rects['reopen-agent'],w={expectedSize:c.observation.window};await runtime.driver.hover({x:r.x,y:r.y+r.height+40,width:2,height:2},w);await runtime.driver.hover(r,w);for(let look=0;look<5;look++){await new Promise(resolve=>setTimeout(resolve,500));const o=await ui.observe(name);if(o.matches.some(n=>n.confidence>=0.6&&near(r)(n,o)))return true;}return false;},'Reopen last agent ready for '+name,45000);await clickRect(c.rects['reopen-agent'],c.observation,label);};
    const tabLabel=async(id,{bar='top',description}={})=>{
      const name=nameOf(id);if(!name)throw Error('Tab '+id+' is not open');
      const shown=displayLabel(name).text,probe=shown.endsWith('…')?shown.slice(0,24).trim():shown,region=bar==='top'?inTop:inBottom;
      return {...await pick(probe,(n,o)=>region(n,o)&&n.frame.x>=G.pad-4,{only:true,description:description||'tab label '+name}),name,shown};
    };
    const selectTab=async(id,{bar='top'}={})=>{const hit=await tabLabel(id,{bar});await clickHit(hit,'Tab '+hit.name);await until(()=>focused()===id,'native selection of '+hit.name,20000);return hit;};
    const closeWithButton=async(id,{agent,bar='top'})=>{
      await selectTab(id,{bar});const hit=await tabLabel(id,{bar}),f=hit.node.frame;
      // Body: icon · label · [status mark] · close (6 px gaps); only the shown tab has a close control.
      await clickRect({x:f.x+f.width+G.tabGap+(agent?G.mark+G.tabGap:0),y:f.y+f.height/2-G.close/2,width:G.close,height:G.close},hit.observation,'Close tab '+hit.name);
      await until(()=>!tabById(id),'strip close button closed '+hit.name,20000);
    };
    const tabMenu=async(id,item)=>{
      const hit=await tabLabel(id),f=hit.node.frame;await clickRect(f,hit.observation,'Tab menu '+hit.name,{button:'right'});
      await until(()=>ui.overlays().includes(MOD),'own tab context menu',20000);
      await click(item,inPopup({x:f.x+f.width/2,y:f.y+f.height/2}),{only:true,description:item+' for '+hit.name,control:item+' · '+hit.name});return hit;
    };
    const typePrompt=async(id,value)=>{
      await until(()=>ui.overlays().includes('prompt'),'Herdr rename prompt',20000);
      await until(async()=>{const o=await ui.observe();return o.lines.some(n=>/^(Cancel|Save)$/i.test(n.text.trim()));},'visible rename prompt',20000);await delay(800);
      await runtime.driver.press('cmd-a');await runtime.driver.press('backspace');
      for(let index=0;index<value.length;index+=4){const chunk=value.slice(index,index+4);await runtime.driver.bridge('type',chunk);runtime.driver.actions.push({kind:'native-text',pid:runtime.owner.pid,control:'Tab rename prompt',characters:chunk.length});await delay(150);}
      await runtime.driver.press('enter');await named(id,value,20000);await until(()=>!ui.overlays().length,'closed rename prompt',20000);
    };
    const typeKeys=async text=>{for(const character of text)await runtime.driver.press(character===' '?'space':character);await runtime.driver.press('enter');};
    const launchTool=async(tool,{machine=null}={})=>{
      const before=await requestIds(),menu=await ui.openMenu();await visible(machine?HOST:'This Mac',inDialog,30000);
      await click(TOOLS[tool].name,inDialog,{only:true,description:'installed '+tool+' row',control:'Agent menu '+TOOLS[tool].name});
      // The launch view is up once its footer Start control shows; it starts only after the capability probe finished.
      await visible('Start agent',inFooter,20000);await until(async()=>!(await has('Checking available options',inDialog)),'probed '+tool+' capabilities',30000);
      await click('Start agent',inFooter,{only:true,control:'Start agent '+tool});
      const record=await newRecord(before,r=>r.request.toolKey===tool&&(r.request.machine??null)===machine,'acknowledged plus launch of '+tool);
      await until(()=>!ui.overlays().includes(MOD),'agent menu closes after the launch',20000);return {record,menu};
    };
    const snapshot=async()=>({tabs:JSON.stringify(allTabs()),local:JSON.stringify(liveTerminals(runtime)),remote:JSON.stringify(liveTerminals(server)),focused:focused()});
    const swap=async(to)=>{const before=await snapshot(),c=await controls();await clickRect(c.rects.swap,c.observation,'Switch view to '+to);await until(()=>ui.layoutName()===to,'native swap into '+to,30000);await controls();await until(async()=>(await navState())?.swap?.applied===true,'swap restore applied in '+to,20000);return {before,after:await snapshot()};};

    console.log('Tabs native: Classic empty state, hidden panel and icon-only sources');await progress('classic empty state');
    // The sentinel tab gets its first automatic name right after start; compare only a settled strip.
    await quiet();const initial=await snapshot();let c=await controls();
    const emptyTab=await tip(c.rects['reopen-tab'],c.observation,'Reopen last tab (nothing closed)','No closed tab has been recorded');
    c=await controls();const emptyAgent=await tip(c.rects['reopen-agent'],c.observation,'Reopen last agent (nothing closed)','Shell-only tabs are skipped');await delay(1500);
    expect(Boolean(emptyTab&&emptyAgent)&&JSON.stringify(await snapshot())===JSON.stringify(initial)&&(await closedRecords()).length===0,'emptyReopen');
    const hiddenAtStart=!(await has('agents',inPanel));c=await controls();
    const shownTip=await tip(c.rects.panel,c.observation,'Show work panel','Hide work panel');await visible('agents',inPanel,20000);
    expect(hiddenAtStart&&Boolean(shownTip),'panelStartsHidden');
    let o=await ui.observe();const pulls=await tip(ui.navIcon(2,o),o,'Pull requests source (icon)','Pull requests (shown)');await until(async()=>(await navState())?.source==='pulls','Pull requests selected from the icon strip',20000);
    o=await ui.observe();const jiraTip=await tip(ui.navIcon(0,o),o,'Jira source (icon)','Jira');await until(async()=>(await navState())?.source==='jira','Jira selected from the icon strip',20000);
    o=await ui.observe();await tip(ui.navIcon(2,o),o,'Pull requests source (icon)','Pull requests (shown)');await until(async()=>(await navState())?.source==='pulls','Pull requests selected again',20000);
    await park();expect(Boolean(pulls&&jiraTip)&&!(await has('Pull requests',(n,o)=>n.frame.x>=o.window.width-G.panel&&inNavRow(n))),'iconSources');
    o=await ui.observe();const absent=await tip(ui.navIcon(4,o),o,'Merge requests source (absent)','Not in this layout');await delay(1500);
    expect(Boolean(absent)&&(await navState())?.source==='pulls','absentSource');
    o=await ui.observe();await clickRect(ui.panelHide(o),o,'Hide work panel (panel button)');await until(async()=>!(await has('agents',inPanel)),'work panel hidden by its own button',20000);
    await park();expect(!(await has('agents',inPanel))&&!(await has('Pull requests (shown)',inPanel)),'panelHideButton');

    console.log('Tabs native: one-button swap into Mission Control');await progress('first swap');
    await park();await quiet();const first=await swap(LAYOUTS.overview);
    expect(first.before.tabs===first.after.tabs&&first.before.local===first.after.local&&first.before.remote===first.after.remote&&first.before.focused===first.after.focused,'swapToOverview');
    // Mouse-down hid the tooltip; leave and re-enter the source before reading it.
    const restored=await click('Pull requests',inNav,{only:true,control:'Pull requests source'}),rf=restored.node.frame,rw={expectedSize:restored.observation.window};await runtime.driver.hover({x:rf.x,y:rf.y+rf.height+40,width:2,height:2},rw);await runtime.driver.hover(rf,rw);const shownPulls=await visible('Pull requests (shown)',near(restored.node.frame),20000);const nav1=await navState();
    expect(Boolean(shownPulls)&&nav1?.source==='pulls'&&nav1.scope==='space'&&nav1.swap?.from===LAYOUTS.classic&&nav1.swap.to===LAYOUTS.overview,'sourceRestored');

    console.log('Tabs native: own agent menu, exact local launches and a remote launch');await progress('plus launches');
    const {record:recordA,menu:menuA}=await launchTool('claude');const A=recordA.ack.tab,sidA=recordA.sessionProposal?.sessionId;
    expect(Boolean(menuA.header)&&!menuA.shipped&&recordA.request.spaceId===runtime.spaceId,'plusMenu');
    const runA=await until(async()=>(await actor.runs()).find(r=>r.id===sidA)||null,'local exact actor run',20000),rawA=runtime.hc(['get',recordA.ack.terminal,'--json']);
    expect(typeof sidA==='string'&&recordA.proofKind==='caller-session-id'&&recordA.request.machine===null&&recordA.request.repoRoot===runtime.repo&&recordA.request.checkoutRoot===runtime.repo&&recordA.request.worktree===false&&JSON.stringify(runA.argv)===JSON.stringify(['--session-id',sidA])&&runA.cwd===runtime.repo&&rawA.cwd===runtime.repo,'plusLaunchLocal');
    await named(A,TOOLS.claude.name);await actor.setStatus(sidA,'working');await actor.setTitle(sidA,NAMES.A);await named(A,NAMES.A);
    const [originA]=await originOf(recordA.sessionProposal);expect(originA?.mode==='auto'&&originA.lastAutoName===NAMES.A&&originA.currentTab?.tabId===A,'genericName');
    const {record:recordB}=await launchTool('claude');const B=recordB.ack.tab,sidB=recordB.sessionProposal?.sessionId;assert.ok(sidB&&sidB!==sidA,'B has its own exact session');
    await actor.setStatus(sidB,'blocked');await actor.setTitle(sidB,NAMES.B);await named(B,NAMES.B);
    runtime.app(['do','space.select',JSON.stringify({id:remote.id})]);await until(()=>activeSpace()?.id===remote.id,'remote space shown',20000);
    await actor.setTitle('tool-grok',NAMES.D);await actor.setStatus('tool-grok','idle');
    const {record:recordD}=await launchTool('grok',{machine:HOST}),D=recordD.ack.tab,rawD=server.hc(['get',localTerminalAddress(recordD.ack.terminal,HOST),'--json']);
    // Report each condition so a failure names what the remote host actually ran. hc may list a
    // connected machine's terminals with qualified addresses; only unqualified ones are local.
    const remoteLaunch={machine:recordD.request.machine===HOST,space:recordD.request.spaceId===remote.id,repo:recordD.request.repoRoot===server.repo,cwd:rawD.cwd===server.repo||rawD.cwd,argv:JSON.stringify(rawD.argv||[]).includes(actor.files.grok)||rawD.argv,localOnly:!liveTerminals(runtime).filter(address=>!address.includes('/')).some(address=>JSON.stringify(runtime.hc(['get',address,'--json']).argv||[]).includes(actor.files.grok))};
    if(!Object.values(remoteLaunch).every(v=>v===true))throw Error('plusLaunchRemote: '+JSON.stringify(remoteLaunch));
    expect(true,'plusLaunchRemote');
    await named(D,NAMES.D,60000);expect(nameOf(D)===NAMES.D,'remoteName');
    runtime.app(['do','space.select',JSON.stringify({id:runtime.spaceId})]);await until(()=>activeSpace()?.id===runtime.spaceId,'local space shown',20000);

    console.log('Tabs native: issue, PR and MR tabs from acknowledged launch records');await progress('keyed tabs');
    const keyed={};
    for(const k of KEYED){if(k.reported)await actor.setTitle(k.id,k.reported);await actor.setStatus(k.id,k.id==='k1'?'working':k.status);}
    for(const k of KEYED){const ack=runtime.app(['do','tab.new',JSON.stringify({space:runtime.spaceId,folder:runtime.repo,name:`${k.key} ${k.title}`,argv:[actor.files[k.tool],'--qa-id',k.id]})]);keyed[k.id]=ack;await appendJournal(files.launches,[keyedRecord(k,{spaceId:runtime.spaceId,repo:runtime.repo,ack})]);}
    for(const k of KEYED)await named(keyed[k.id].tab,NAMES[k.id],60000);
    const [K1,K2,K3]=KEYED.map(k=>keyed[k.id].tab);
    expect(nameOf(K1)===NAMES.k1&&nameOf(K3)===NAMES.k3&&(await tabEntry(null,K1))?.meta?.key==='ABC-123'&&(await tabEntry(null,K3))?.meta?.key==='GL-MR-7','keyedNames');
    expect(nameOf(K2)===NAMES.k2&&(await tabEntry(null,K2))?.mode==='auto','toolFallback');
    // Done means finished while nobody looked: K1 turns done only once another tab is shown.
    await until(()=>focused()!==K1,'K1 not shown',20000);await actor.setStatus('k1','done');

    console.log('Tabs native: four statuses, real tool icons, one strip and the preview');await progress('preview');
    const statusTargets=[[recordA.ack.terminal,'working'],[recordB.ack.terminal,'blocked'],[keyed.k1.terminal,'done'],[keyed.k2.terminal,'idle'],[keyed.k3.terminal,'working']];
    await until(()=>statusTargets.every(([address,expected])=>runtime.hc(['get',address,'--json']).status?.state===expected),'actual OSC statuses',40000);
    expect(statusTargets.every(([address,expected])=>runtime.hc(['get',address,'--json']).status?.state===expected),'fourStatuses');
    await selectTab(runtime.tabId);await park();await quiet();
    const preview=await runtime.frame(PREVIEW),previewFile=path.join(ROOT,preview.path),image=decodePng(await fs.readFile(previewFile));
    const located={};for(const id of order()){const name=nameOf(id),r=await runtime.driver.ocr(previewFile,displayLabel(name).text),m=r.matches.filter(n=>n.confidence>=0.6&&inTop(n)&&n.frame.x>=G.pad-4);located[id]={name,count:m.length,frame:m[0]?.frame??null,outside:r.matches.filter(n=>n.confidence>=0.6&&!inTop(n)&&n.frame.x>=G.rail).length,window:r.window};}
    const scale=image.width/located[A].window.width,stats={};
    for(const [key,id]of Object.entries({A,B,K1,K2,K3})){const f=located[id].frame;if(!f)continue;const cy=f.y+f.height/2,iconLeft=f.x-G.tabGap-G.tabIcon,background=backgroundOf(image,scale,{x:iconLeft-7,y:cy-3,width:4,height:6});
      stats[key]={background,icon:inkStats(image,scale,{x:iconLeft-2,y:cy-9,width:G.tabIcon+4,height:18},background),mark:inkStats(image,scale,{x:f.x+f.width+2,y:cy-6,width:G.tabGap+G.mark+6,height:12},background)};}
    pixels={scale,located,stats};await fs.mkdir(diagnostics,{recursive:true});await fs.writeFile(path.join(diagnostics,'tabs-preview-pixels.json'),JSON.stringify(pixels,null,2));
    const marks=['A','B','K1','K2'].map(k=>stats[k]?.mark),filled=['A','B','K1'].map(k=>stats[k]?.mark);
    expect(marks.every(m=>m&&m.count>=6*scale)&&filled.every(m=>m.hollow===false)&&stats.K2.mark.hollow===true&&filled.every((m,i)=>filled.every((n,j)=>i===j||distance(m.mean,n.mean)>=30))&&Boolean(stats.K3?.mark?.mean)&&distance(stats.A.mark.mean,stats.K3.mark.mean)<30,'statusMarks');
    // Claude's icon is its orange glyph; Codex and Grok draw different, non-orange icons. The bar's own fallback art is never used.
    const warm=s=>Boolean(s?.icon.mean)&&s.icon.mean[0]-s.icon.mean[2]>=50;
    expect(['A','B','K1','K2','K3'].every(k=>stats[k]?.icon.count>=10*scale*scale)&&['A','B'].every(k=>warm(stats[k]))&&['K1','K2','K3'].every(k=>!warm(stats[k])),'toolIcons');// Claude marks are warm; Codex (K1, K2) and Grok (K3) are not
    expect(order().every(id=>located[id].count===1&&located[id].frame.x>=G.pad-4)&&[A,B,K1,K2,K3].every(id=>located[id].outside===0),'oneStrip');

    console.log('Tabs native: seven sources at 1024 and 736 logical px');await progress('navigation widths');
    const navCheck=async(width,column)=>{
      await positionWindow(runtime,{width});await controls();await park();const frame=await runtime.frame('tabs-navigation-'+width),file=path.join(ROOT,frame.path),found={};
      for(const id of SOURCE_IDS){const label=SOURCE_LABELS[id][column],r=await runtime.driver.ocr(file,label),m=r.matches.filter(n=>n.confidence>=0.6&&inNav(n));found[id]={count:m.length,observation:r,node:m[0]??null};}
      const clear=Object.values(found).every(f=>f.count===1&&f.node.frame.x>=G.rail&&f.node.frame.x+f.node.frame.width<=f.observation.window.width-G.navPadX+1);return {found,clear};
    };
    const wide=await navCheck(1024,1);expect(wide.clear&&!(await has('Pull requests',inNav))&&!(await has('Previous sessions',inNav)),'wideNavigation');
    const narrow=await navCheck(736,1);const shortOnly=!(await has('Pull requests',inNav))&&!(await has('Previous sessions',inNav));expect(narrow.clear&&shortOnly,'narrowNavigation');
    await clickHit({observation:narrow.found.sessions.observation,node:narrow.found.sessions.node},'Sessions source (short)');
    await until(async()=>(await navState())?.source==='sessions','Sessions selected at 736 px',20000);{const f=narrow.found.sessions.node.frame,w={expectedSize:narrow.found.sessions.observation.window};await runtime.driver.hover({x:f.x,y:f.y+f.height+40,width:2,height:2},w);await runtime.driver.hover(f,w);}const shownSessions=await visible('Previous sessions (shown)',near(narrow.found.sessions.node.frame),20000);
    expect(Boolean(shownSessions),'narrowSelect');await positionWindow(runtime);await controls();await park();

    console.log('Tabs native: the Sources gear turns a work source off and back on');await progress('sources');
    {
      // The popup opens under the gear at the top right; the navigation strip's own labels end well left of it.
      const inDialogRow=(n,o)=>n.frame.x>o.window.width-340&&n.frame.y>24;
      let g=await controls();await clickRect(g.rects.sources,g.observation,'Mission Control sources');
      await until(()=>ui.overlays().includes(MOD),'Sources dialog',20000);await visible('Work sources',inDialogRow,30000);
      expect(await has('GitLab issues',inNav),'sourcesToggle');
      await click('GitLab issues',inDialogRow,{control:'GitLab issues switch'});
      const off=await until(async()=>((await runtime.shared())['mission-control-tabs-sources-v1']?.hidden||[]).includes('gitlab')&&!(await has('GitLab issues',inNav))?true:null,'GitLab issues off and gone from the strip',20000);
      await click('GitLab issues',inDialogRow,{control:'GitLab issues switch'});
      const on=await until(async()=>!((await runtime.shared())['mission-control-tabs-sources-v1']?.hidden||[]).includes('gitlab')&&await has('GitLab issues',inNav)?true:null,'GitLab issues back in the strip',20000);
      expect(off&&on,'sourcesToggle');await runtime.driver.press('escape');await until(()=>!ui.overlays().includes(MOD),'Sources dialog closed',20000);await park();
    }

    console.log('Tabs native: select, wheel, reorder and drags that end elsewhere');await progress('strip interactions');
    await selectTab(K2);expect(focused()===K2,'select');
    await selectTab(B);let tabs=order();const start=tabs.indexOf(B);c=await controls();
    await runtime.driver.scroll(c.rects.plus,120,{expectedSize:c.observation.window});ui.annotate('Wheel over the bar',c.observation);
    const moved=await until(()=>{const now=focused();return now!==B?now:null;},'wheel switched tab',20000),step=order().indexOf(moved)-start;await delay(600);
    c=await controls();await runtime.driver.scroll(c.rects.plus,-120,{expectedSize:c.observation.window});ui.annotate('Wheel back over the bar',c.observation);
    await until(()=>focused()===B,'opposite wheel returned',20000);expect(Math.abs(step)===1&&order().join()===tabs.join(),'wheel');
    const target=order().indexOf(A),from=await tabLabel(K3),to=await tabLabel(A);
    await runtime.driver.drag(from.node.frame,to.node.frame,{expectedSize:from.observation.window});ui.annotate('Drag '+from.name+' onto '+to.name,from.observation);
    await until(()=>order().indexOf(K3)===target,'native drag reorder',20000);expect(order().indexOf(A)===target+1&&order().length===tabs.length,'reorder');
    await selectTab(B);await park();const frameBefore=await windowFrame(),before=JSON.stringify([order(),focused(),allTabs().length]);
    let label=await tabLabel(K2);o=await ui.observe();const parkAt=terminalPoint(ui.layoutName(),o.window);
    await runtime.driver.drag(label.node.frame,{x:parkAt.x-4,y:parkAt.y-4,width:8,height:8},{expectedSize:label.observation.window});ui.annotate('Drag '+label.name+' into the terminal',label.observation);await delay(1200);
    const last=await tabLabel(order().at(-1));c=await controls();const end=last.node.frame.x+last.node.frame.width+G.tabGap+G.mark+G.tabGap+G.close+12,room=c.rects.plus.x-G.controlGap-end;
    assert.ok(room>=24,'The strip needs empty room right of its last tab for the empty-strip drag');
    label=await tabLabel(K2);await runtime.driver.drag(label.node.frame,{x:end+room/2-4,y:G.topbar/2-4,width:8,height:8},{expectedSize:label.observation.window});ui.annotate('Drag '+label.name+' onto the empty strip',label.observation);await delay(1200);
    label=await tabLabel(K2);await runtime.driver.drag({x:parkAt.x-4,y:parkAt.y-4,width:8,height:8},label.node.frame,{expectedSize:label.observation.window});ui.annotate('Drag from the terminal onto '+label.name,label.observation);await delay(1200);
    expect(JSON.stringify([order(),focused(),allTabs().length])===before&&await windowFrame()===frameBefore&&!ui.overlays().length,'dragOutside');

    console.log('Tabs native: bounded long title with hover, renames and automatic naming');await progress('names');
    await park();await actor.setTitle(sidB,NAMES.longB);await named(B,LONG_B_NAME,45000);
    const long=await tabLabel(B),longLine=ui.lineOf(long.observation,long.node)?.text||'',next=order()[order().indexOf(B)+1],after=next?await tabLabel(next):null;
    await clickHit(long,'Tab '+NAMES.longB.slice(0,24));{const f=long.node.frame,w={expectedSize:long.observation.window};await runtime.driver.hover({x:f.x,y:f.y+f.height+40,width:2,height:2},w);await runtime.driver.hover(f,w);}const fullTip=await visible('rotates overnight',()=>true,20000),autoTip=await has('Automatic name',n=>n.frame.y>G.topbar);
    expect(/Investigate/.test(longLine)&&!/overnight/.test(longLine)&&Boolean(fullTip&&autoTip)&&(!after||after.node.frame.x-long.node.frame.x<=G.displayPx+90),'hover');
    await actor.setTitle(sidB,NAMES.B);await named(B,NAMES.B,45000);await park();
    await tabMenu(A,'Rename');await typePrompt(A,NAMES.manualA);
    const manual=await until(async()=>{const [r]=await originOf(recordA.sessionProposal);return r?.mode==='manual'&&r.manualName===NAMES.manualA?r:null;},'observer records the manual name',30000);
    expect(manual.currentTab?.tabId===A,'manualRename');
    await actor.setTitle(sidA,NAMES.A2);expect(await stable(A,NAMES.manualA,15000)&&(await originOf(recordA.sessionProposal))[0]?.mode==='manual','manualKept');
    await tabMenu(K1,'Rename');await typePrompt(K1,NAMES.manualK1);await until(async()=>(await tabEntry(null,K1))?.mode==='manual','K1 recorded as named by the person',30000);
    await tabMenu(K1,'Use automatic name');await named(K1,NAMES.k1,45000);const k1Entry=await tabEntry(null,K1);
    expect(k1Entry?.mode==='auto'&&k1Entry.manual===null,'backToAuto');
    await selectTab(K2);await runtime.driver.press(KEYS.rename);await typePrompt(K2,NAMES.manualK2);await until(async()=>(await tabEntry(null,K2))?.mode==='manual','K2 recorded as named by the person',30000);
    await runtime.driver.press(KEYS.automatic);await named(K2,NAMES.k2,45000);
    expect((await tabEntry(null,K2))?.mode==='auto'&&(await runtime.shared())[COMMAND_EVENT]?.command==='automatic-name','keyCommands');
    const beforeShell=new Set(order());await ui.openMenu();await click('Terminal',inFooter,{only:true,control:'Agent menu Terminal'});
    const S=await until(()=>order().find(id=>!beforeShell.has(id))||null,'menu Terminal tab',20000);await until(()=>!ui.overlays().includes(MOD),'agent menu closed',20000);
    await named(S,NAMES.shell,45000);await selectTab(S);await park();await typeKeys('sleep 20');
    const running=await until(()=>{const n=nameOf(S);return n&&n!==NAMES.shell&&/sleep/i.test(n)?n:null;},'shell tab shows its running program',30000);
    await named(S,NAMES.shell,60000);expect(Boolean(running),'shellNames');

    console.log('Tabs native: swap to Classic and back with manual names and source kept');await progress('second swap');
    await park();await quiet();const toClassic=await swap(LAYOUTS.classic);
    c=await controls();await tip(c.rects.panel,c.observation,'Show work panel','Hide work panel');await visible('agents',inPanel,20000);
    o=await ui.observe();const sessionsShown=await tip(ui.navIcon(5,o),o,'Previous sessions source (icon)','Previous sessions (shown)');
    c=await controls();const hiddenTip=await tip(c.rects.panel,c.observation,'Hide work panel','Show work panel');await until(async()=>!(await has('agents',inPanel)),'work panel hidden by the bar control',20000);
    expect(Boolean(hiddenTip)&&!(await has('agents',inPanel)),'panelToggleHide');
    await park();await quiet();const toOverview=await swap(LAYOUTS.overview);
    expect([toClassic,toOverview].every(s=>s.before.tabs===s.after.tabs&&s.before.local===s.after.local&&s.before.remote===s.after.remote&&s.before.focused===s.after.focused)&&Boolean(sessionsShown)&&nameOf(A)===NAMES.manualA&&(await navState())?.source==='sessions','swapKeeps');

    console.log('Tabs native: strip closes, Reopen last agent / tab and a missing exact session');await progress('closes and reopens');
    await tabMenu(K3,'Close tab');await until(()=>!tabById(K3),'tab menu closed K3',20000);const k3Records=await recorded(K3,'K3');
    const nameAtCloseA=tabById(A)?.name;await closeWithButton(A,{agent:true});const aRecords=await recorded(A,'A');
    await closeWithButton(S,{agent:false});const sRecords=await recorded(S,'S');
    expect([k3Records,aRecords,sRecords].every(r=>r.length===1)&&aRecords[0].kind==='agent'&&aRecords[0].terminals.some(t=>t.session?.sessionId===sidA)&&sRecords[0].kind==='shell'&&![K3,A,S].some(id=>tabById(id)),'stripClose');
    const originBefore=(await originOf(recordA.sessionProposal))[0],originB=JSON.stringify((await originOf(recordB.sessionProposal))[0]);
    let tabsBefore=new Set(order()),idsBefore=await requestIds();await reopenAgentWhenReady(nameAtCloseA,'Reopen last agent');
    const resumedA=await newRecord(idsBefore,r=>r.sessionProposal&&sessionKey(r.sessionProposal)===sessionKey(recordA.sessionProposal),'acknowledged exact resume of A');
    await until(async()=>(await recordsOf(A)).length===0,'A close record consumed',60000);const A2=resumedA.ack.tab;await named(A2,NAMES.manualA,30000);
    const resumes=(await actor.runs()).filter(r=>r.argv[0]==='--resume'&&r.argv[1]===sidA);
    expect(A2!==A&&order().filter(id=>!tabsBefore.has(id)).join()===A2&&resumes.length===1&&resumes[0].cwd===runtime.repo&&resumedA.proofKind==='resume-argv'&&(await recordsOf(S)).length===1,'reopenAgent');
    await delay(10000);const originAfter=(await originOf(recordA.sessionProposal))[0];
    expect(originAfter?.mode==='manual'&&originAfter.manualName===NAMES.manualA&&originAfter.currentTab?.tabId===A2&&originAfter.revision===originBefore.revision+2&&nameOf(A2)===NAMES.manualA&&nameOf(B)===NAMES.B&&JSON.stringify((await originOf(recordB.sessionProposal))[0])===originB,'manualTransfer');
    tabsBefore=new Set(order());c=await controls();await clickRect(c.rects['reopen-tab'],c.observation,'Reopen last tab');
    const S2=await until(()=>order().find(id=>!tabsBefore.has(id))||null,'reopened shell tab',60000);await until(async()=>(await recordsOf(S)).length===0,'S close record consumed',60000);await named(S2,NAMES.shell,30000);
    const s2Address=tabsIn(runtime.spaceId).find(t=>t.id===S2)?.terminals?.[0]?.terminal,s2Raw=s2Address?runtime.hc(['get',s2Address,'--json']):null;await delay(7000);const s2Entry=await tabEntry(null,S2);
    expect(s2Raw?.cwd===runtime.repo&&!(s2Raw.argv||[]).some(a=>/sleep/.test(a))&&s2Entry?.mode==='auto'&&s2Entry.manual===null&&nameOf(S2)===NAMES.shell,'reopenTab');
    await delay(CLOSED.observeMs*2+1000);const quietState=JSON.stringify([order(),[...await requestIds()].sort(),(await actor.runs()).length]);c=await controls();
    const why=await tip(c.rects['reopen-agent'],c.observation,'Reopen last agent (no exact session)','exact session ID');await delay(2500);const k3Kept=await recordsOf(K3);
    expect(Boolean(why)&&JSON.stringify([order(),[...await requestIds()].sort(),(await actor.runs()).length])===quietState&&k3Kept.length===1&&!k3Kept[0].claim,'missingResume');

    console.log('Tabs native: two visible bars, a resumed automatic name and one rename per change');await progress('two bars');
    await park();runtime.app(['do','layout.switch',JSON.stringify({name:LAYOUTS.double})]);await until(()=>ui.layoutName()===LAYOUTS.double,'two-bar fixture layout shown',30000);
    await tabLabel(B,{bar:'top'});await tabLabel(B,{bar:'bottom'});
    const nameAtCloseB=tabById(B)?.name;await closeWithButton(B,{agent:true});const bRecords=await recorded(B,'B');idsBefore=await requestIds();await reopenAgentWhenReady(nameAtCloseB,'Reopen last agent (top bar)');
    const resumedB=await newRecord(idsBefore,r=>r.sessionProposal&&sessionKey(r.sessionProposal)===sessionKey(recordB.sessionProposal),'acknowledged exact resume of B');const B2=resumedB.ack.tab;
    await named(B2,NAMES.B,30000);await quiet();const bars=[await tabLabel(B2,{bar:'top'}),await tabLabel(B2,{bar:'bottom'})],originB1=(await originOf(recordB.sessionProposal))[0];
    const owners=new Set(),sequence=[];let previous=null;await actor.setTitle(sidB,NAMES.B2);
    for(const end=Date.now()+25000;Date.now()<end;){const n=nameOf(B2);if(n!==previous){sequence.push(n);previous=n;}const lease=(await readJson(files.tabNames))?.lease;if(lease?.owner)owners.add(lease.owner);await delay(250);}
    const originB2=(await originOf(recordB.sessionProposal))[0];await tabLabel(B2,{bar:'top'});await tabLabel(B2,{bar:'bottom'});
    expect(bars.every(Boolean)&&owners.size===1&&[...owners].every(owner=>/^mission-control-tabs-[0-9a-z]+-[0-9a-z]+$/.test(owner)),'twoBars');
    expect(bRecords.length===1&&B2!==B&&originB1?.mode==='auto'&&originB1.currentTab?.tabId===B2&&originB2?.lastAutoName===NAMES.B2&&originB2.mode==='auto','resumedAuto');
    expect(JSON.stringify(sequence)===JSON.stringify([NAMES.B,NAMES.B2])&&originB2.revision===originB1.revision+1,'oneRename');

    console.log('Tabs native: a layout without Mission Control nodes');await progress('missing nodes');
    await park();runtime.app(['do','layout.switch',JSON.stringify({name:LAYOUTS.bare})]);await until(()=>ui.layoutName()===LAYOUTS.bare,'node-less fixture layout shown',30000);
    c=await controls();const swapWhy=await tip(c.rects.swap,c.observation,'Switch view (disabled)','View swap unavailable');await delay(1500);
    expect(Boolean(swapWhy)&&ui.layoutName()===LAYOUTS.bare,'bareSwap');
    c=await controls();const panelWhy=await tip(c.rects.panel,c.observation,'Work panel (disabled)','Work panel unavailable');await delay(1000);
    expect(Boolean(panelWhy)&&ui.layoutName()===LAYOUTS.bare,'barePanel');
    const caption=await visible('Work sources unavailable',inNavRow,20000),navBefore=JSON.stringify(await navState());
    await click('Jira',inNavRow,{only:true,control:'Jira source (unavailable)'});await delay(1500);
    expect(Boolean(caption)&&JSON.stringify(await navState())===navBefore,'bareSources');
    await selectTab(K1);const bareMenu=await ui.openMenu();await ui.closeOverlay();
    expect(focused()===K1&&Boolean(bareMenu.header)&&!bareMenu.shipped,'bareStrip');

    console.log('Tabs native: an offered resume after a restart');await progress('restart offer');
    // An idle restored-style shell with an offered resume in the private journal: the bar shows the pill, its popup resumes it once.
    const offerTab=runtime.app(['do','tab.new',JSON.stringify({space:runtime.spaceId,folder:runtime.repo,name:'restart offer'})]),offerAddress=localTerminalAddress(offerTab.terminal,null);
    const offerRaw=await until(()=>{const r=runtime.hc(['get',offerAddress,'--json']);return r.state==='live'&&Number.isSafeInteger(r.pid)&&r.foreground?.pid===r.pid?r:null;},'idle shell for the restart offer',30000);
    const offerSid=crypto.randomUUID(),restartFile=path.join(home,'mission-control','running-agents.json'),offerLine=`${actor.files.claude} --resume ${offerSid}`;
    const offerEntry={spaceId:runtime.spaceId,tabId:offerTab.tab,cwd:offerRaw.foreground?.cwd||offerRaw.cwd,toolKey:'claude',provider:'claude',sessionId:offerSid,via:'pid-record',shellPid:offerRaw.pid,shellStartMs:Date.parse(run('ps',['-o','lstart=','-p',String(offerRaw.pid)],{json:false,env:{...process.env,TZ:'UTC',LC_ALL:'C'}}).trim().replace(/\s+/g,' ')+' UTC'),agentPid:2,agentStartMs:Date.now()-3600000,seenAt:Date.now()-3600000,state:'offered',offeredAt:Date.now(),reason:"claude's options could not be checked.",line:offerLine};
    for(let attempt=0;attempt<5;attempt++){const journal=(await readJson(restartFile))||{v:1,revision:0,lease:null,machines:{}};journal.machines.local=journal.machines.local||{observedAt:Date.now(),lastContinuousAt:Date.now(),terminals:{}};journal.machines.local.terminals[offerAddress]=offerEntry;journal.revision=(journal.revision||0)+1;const temp=restartFile+'.qa';await fs.writeFile(temp,JSON.stringify(journal)+'\n');await fs.rename(temp,restartFile);await delay(1500);if((await readJson(restartFile))?.machines?.local?.terminals?.[offerAddress]?.state==='offered')break;}
    await visible('Resume 1',inTop,30000);await click('Resume 1',inTop,{only:true,description:'Resume restart pill',control:'Resume 1 (restart pill)'});
    await until(()=>ui.overlays().includes(MOD),'own restart popup',20000);
    await click('Resume',n=>n.text==='Resume'&&!inTop(n),{only:true,description:'Resume in the restart popup',control:'Resume offered agent'});
    const offerRun=await until(async()=>(await actor.runs()).find(r=>r.argv[0]==='--resume'&&r.argv[1]===offerSid)||null,'offered resume typed into its shell',40000);await delay(6000);
    expect(Boolean(offerRun)&&(await actor.runs()).filter(r=>r.argv[0]==='--resume'&&r.argv[1]===offerSid).length===1&&offerRun.cwd===offerEntry.cwd&&!(await readJson(restartFile))?.machines?.local?.terminals?.[offerAddress]?.state?.startsWith('offer'),'restartOffer');
    await ui.closeOverlay().catch(()=>{});
    expect(runtime.app(['status']).errors?.length===0,'noErrors');
    expect((await fs.readdir(path.join(home,'mods'))).filter(name=>name.startsWith('mission-control-')).join(',')===MOD&&runtime.packages.length===1&&runtime.packages[0].name===MOD&&runtime.packages[0].nativeCheck===true,'standalone');
    await progress('native Tabs scenario passed');
    // The public preview is promoted only by `promote-preview` after the harness validated this receipt.
  }catch(error){
    failure=error;
    try{
      await fs.mkdir(diagnostics,{recursive:true});
      for(const [name,file]of Object.entries(files))try{await fs.copyFile(file,path.join(diagnostics,'tabs-failure-'+name+'.json'));}catch{}
      await fs.writeFile(path.join(diagnostics,'tabs-native-console.txt'),(runtime.appStdout||'')+'\n'+(runtime.appStderr||''));
      if(pixels)await fs.writeFile(path.join(diagnostics,'tabs-failure-pixels.json'),JSON.stringify(pixels,null,2));
      try{await fs.writeFile(path.join(diagnostics,'tabs-failure-actors.json'),JSON.stringify(actor?await actor.runs():[],null,2));}catch{}
      try{await fs.writeFile(path.join(diagnostics,'tabs-failure-shared.json'),JSON.stringify(await runtime.shared(),null,2));}catch{}
      // Every live local terminal with its foreground and labels, to name what a resume found ambiguous.
      try{await fs.writeFile(path.join(diagnostics,'tabs-failure-terminals.json'),JSON.stringify((runtime.hc(['ls','--json']).terminals||[]).filter(t=>(t.state===undefined||t.state==='live')&&!String(t.address).includes('/')).map(t=>{const raw=runtime.hc(['get',t.address,'--json']);return {address:t.address,created_ms:raw.created_ms,cwd:raw.cwd,foreground:raw.foreground,labels:raw.labels,argv:raw.argv};}),null,2));}catch{}
      try{await fs.writeFile(path.join(diagnostics,'tabs-failure-status.json'),JSON.stringify({status:runtime.app(['status']),world:runtime.app(['ls'])},null,2));await runtime.frame('tabs-failure');}catch{}
    }catch{}
  }finally{
    try{if(connected)runtime.hc(['machine','rm',HOST,'--json']);}catch(error){if(error instanceof NativeIsolationError)cleanupError??=error;}
    try{if(server.directory)await server.close();}catch(error){cleanupError??=error;}
  }
  if(failure)throw failure;if(cleanupError)throw cleanupError;
}

// ---------------------------------------------------------------------------------------------
// Core-free preflight: fixtures and every geometry / naming assumption against the real modules.
// ---------------------------------------------------------------------------------------------
async function runActor(file,args,{cwd,until:wanted,timeout=10000,onOutput}){
  const child=spawn(file,args,{cwd,stdio:['pipe','pipe','ignore']});let output='';
  const exited=new Promise(resolve=>child.once('exit',resolve));child.stdout.on('data',bytes=>{output+=bytes.toString();onOutput?.(output);});
  try{await until(()=>wanted(output),'fixture actor output',timeout);}finally{child.stdin.end();await Promise.race([exited,delay(5000)]);if(child.exitCode===null)child.kill('SIGKILL');}
  return output;
}
export async function checkFixtures(){
  const directory=await fs.realpath(await fs.mkdtemp('/private/tmp/mcqa-')),checks=[];const check=(condition,label)=>{assert.ok(condition,label);checks.push(label);};
  try{
    // 1. Disposable actors: capability probing decides exact sessions exactly as the plus menu will.
    const actor=await writeActors(directory),capabilities={};
    for(const tool of Object.keys(TOOLS)){const help=(await execute(actor.files[tool],['--help'],{timeout:10000})).stdout,resumeHelp=tool==='codex'?(await execute(actor.files[tool],['resume','--help'],{timeout:10000})).stdout:'';capabilities[tool]=parseCapabilities({key:tool,name:TOOLS[tool].name,run:[actor.files[tool]],installed:true},{help,resumeHelp});}
    check(capabilities.claude.provider==='claude'&&capabilities.claude.callerSession==='--session-id'&&capabilities.claude.resume?.flag==='--resume','The claude actor verifies caller session IDs and exact resume');
    check(capabilities.codex.provider==='codex'&&capabilities.codex.resume===null&&capabilities.codex.callerSession===null&&capabilities.grok.provider==='grok'&&capabilities.grok.callerSession===null&&capabilities.grok.resume===null,'The codex and grok actors have no exact session, so their closes cannot be resumed as agents');
    const sid=crypto.randomUUID(),title='\x1b]2;',status='\x1b]7501;state=';let changed=false;
    const output=await runActor(actor.files.claude,['--session-id',sid],{cwd:directory,until:out=>out.includes(title+'claude\x1b\\')&&out.includes(status+'idle:app=claude-code\x1b\\')&&out.includes(title+NAMES.A+'\x1b\\')&&out.includes(status+'blocked:app=claude-code\x1b\\'),
      onOutput:out=>{if(!changed&&out.includes(title+'claude\x1b\\')){changed=true;actor.setTitle(sid,NAMES.A).then(()=>actor.setStatus(sid,'blocked'));}}});
    check(output.indexOf(title+'claude\x1b\\')<output.indexOf(title+NAMES.A+'\x1b\\'),'An actor reports only its generic tool name until its title file appears, then its OSC 2 title and OSC 7501 status');
    const started=(await actor.runs()).find(r=>r.id===sid);check(started?.cwd===directory&&JSON.stringify(started.argv)===JSON.stringify(['--session-id',sid]),'An actor records its exact argv, folder and identity');
    await runActor(actor.files.claude,['--resume',sid],{cwd:directory,until:out=>out.includes(title+NAMES.A+'\x1b\\')});
    check((await actor.runs()).filter(r=>r.id===sid).length===2,'A resumed actor finds the same session title and status files');
    // 2. The seeded issue/PR/MR records pass launch.js's own journal reader and writer unchanged.
    const home=path.join(directory,'app'),repo=path.join(directory,'fixture-repo'),spaceId='qa-sp-fixture',launches=path.join(home,'mission-control/launches.json');await fs.mkdir(path.dirname(launches),{recursive:true});await fs.mkdir(repo);
    const records=KEYED.map(k=>keyedRecord(k,{spaceId,repo,ack:{space:spaceId,tab:'qa-tab-'+k.id,terminal:'t'+k.id}}));await appendJournal(launches,records);const seeded=await readText(launches);
    const io={...fileIO(home),spaces:()=>[{id:spaceId,name:'client-portal',machine:null,folder:repo,tabs:[]}],knownAgents:async()=>[{key:'claude',name:TOOLS.claude.name,run:[actor.files.claude],installed:true}],
      capabilities:{get:async()=>capabilities.claude},exec:async()=>({code:1,stdout:'',stderr:'fixture exec is unavailable'}),run:()=>{}};
    const probe=await launch({requestId:'qa-journal-probe',idempotencyKey:'qa-journal-probe',originId:'qa-journal-probe',spaceId,machine:null,repoRoot:repo,checkoutRoot:repo,toolKey:'claude',worktree:false},io);
    const after=JSON.parse(await readText(launches));
    check(probe.ok===false&&!['INVALID_JOURNAL','LAUNCH_CAPACITY','INVALID_LAUNCH'].includes(probe.code)&&Object.hasOwn(after.requests,'qa-journal-probe')&&records.every(r=>JSON.stringify(after.requests[r.request.requestId])===JSON.stringify(r)),'launch.js reads and rewrites the seeded issue/PR/MR journal records unchanged');
    const meta=launchMetadata(seeded).meta;
    check(KEYED.every((k,i)=>meta.get(tabKey(null,records[i].ack.tab))?.key===k.key&&meta.get(tabKey(null,records[i].ack.tab))?.kind===k.kind),'The naming service reads each fixture tab’s issue/PR/MR key from the journal');
    // 3. Every name the scenario expects is what the shipped naming rules derive.
    const known=Object.values(TOOLS).map(t=>t.name),program=tool=>({key:tool,name:TOOLS[tool].name,icon:null,tint:false,agent:true,shell:false});
    const agent=(id,name,tool,title)=>observeTab({id,name,named:true},[{tab:id,terminal:'t-'+id,program:program(tool),title,cwd:repo,app:TOOLS[tool].app,status:'idle'}]);
    const derive=(obs,m=null)=>deriveName(obs,m,{knownNames:known});
    check(derive(agent('a',TOOLS.claude.name,'claude','claude'))?.name===TOOLS.claude.name&&derive(agent('a',TOOLS.claude.name,'claude',NAMES.A))?.name===NAMES.A&&derive(agent('b',TOOLS.claude.name,'claude',NAMES.B2))?.name===NAMES.B2,'Generic agent tabs keep the tool name until a conversation title is reported, then take it');
    check(derive(agent('d','1','grok',NAMES.D))?.name===NAMES.D,'The remote grok agent takes its reported title');
    check(KEYED.every((k,i)=>derive(agent(records[i].ack.tab,`${k.key} ${k.title}`,k.tool,k.reported??k.tool),meta.get(tabKey(null,records[i].ack.tab)))?.name===NAMES[k.id]),'Issue/PR/MR tabs derive key plus reported or task title, and a bare tool name never counts as a title');
    const long=derive(agent('b',NAMES.B,'claude',NAMES.longB)),shown=displayLabel(long.name,{full:long.full});
    check(long.name===LONG_B_NAME&&long.full===NAMES.longB&&shown.truncated&&estimateWidth(shown.text)<=G.displayPx&&shown.text.startsWith(NAMES.longB.slice(0,24))&&!shown.text.includes('overnight')&&shown.full.includes('rotates overnight'),'A long reported title is written bounded, shown within 280 px and kept whole for hover');
    const shell=(programName,isShell)=>deriveName(observeTab({id:'s',name:'7',named:false},[{tab:'s',terminal:'t-s',program:{key:isShell?'shell':'program',name:programName,shell:isShell,agent:false},title:programName,cwd:repo}]));
    check(shell('zsh',true)?.name===NAMES.shell&&shell('sleep',false)?.name==='sleep','A shell tab is named by its running program, else its folder');
    // 4. The test layouts satisfy the mod's own node contract, padding and width modes.
    await import(pathToFileURL(path.join(ROOT,'tests/support/native-loader.mjs')).href);
    const nav=await import(pathToFileURL(path.join(ROOT,'src/mods/mission-control-tabs/navigation.js')).href),bar=await import(pathToFileURL(path.join(ROOT,'src/mods/mission-control-tabs/main.js')).href);
    const layouts=testLayouts(),names=['main',...Object.values(LAYOUTS)],props=tree=>tree.children.find(n=>n.id==='mc-topbar').content.props,contract=name=>nav.layoutContract({tree:layouts[name],name,names,props:props(layouts[name])});
    check(JSON.stringify(nav.SOURCES.map(s=>[s.id,s.label,s.short]))===JSON.stringify(SOURCE_IDS.map(id=>[id,...SOURCE_LABELS[id]])),'Source ids and labels match navigation.js');
    const overview=contract(LAYOUTS.overview),classic=contract(LAYOUTS.classic),bare=contract(LAYOUTS.bare),double=contract(LAYOUTS.double);
    check(overview.main&&overview.stack&&overview.children.length===7&&overview.panel===null&&!overview.panelControl&&overview.swap.enabled&&overview.swap.to===LAYOUTS.classic&&overview.swap.label===LAYOUT_UI[LAYOUTS.overview].swap,'Mission Control test layout: seven sources, no panel, swap to Classic view');
    check(classic.main&&classic.stack&&classic.children.join()==='jira,github,pulls,gitlab,sessions,control-panel'&&classic.panel?.hidden===true&&classic.panelControl&&classic.swap.enabled&&classic.swap.label===LAYOUT_UI[LAYOUTS.classic].swap&&nav.sourceState(classic,'merges').reason==='Not in this layout.','Classic test layout: hidden panel, an absent merges source and swap back');
    check(!bare.main&&!bare.stack&&bare.swap.code==='NO_LAYOUT_NODES'&&/mc-main/.test(bare.swap.reason)&&/mc-work-stack/.test(bare.stackReason)&&bare.panel===null&&bare.panelControl&&nav.sourceState(bare,'jira').enabled===false,'Node-less test layout disables swap, panel and sources with reasons');
    check(JSON.stringify({...double,name:null})===JSON.stringify({...overview,name:null})&&layouts[LAYOUTS.double].children.filter(n=>n.content?.mod===MOD&&n.content.props?.view==='topbar').length===2,'Two-bar test layout mounts two visible top bars over the same contract');
    const mac={platform:'macos',titlebar:'none',fullscreen:false};check(Object.values(layouts).every(tree=>bar.lightsPadding({win:mac,tree})===G.pad),'Every test layout starts its strip clear of the traffic lights');
    check(nav.navigationMode(1024-G.rail)==='short'&&nav.navigationMode(736-G.rail)==='compact'&&nav.navigationMode(G.panel,{panel:true})==='icons'&&nav.navigationMode(G.width)==='full'&&G.width-nav.navigationWidth('full')>=nav.NAV_METRICS.caption,'Widths select short labels at 1024, compact short labels at 736, full at 1280, icons in the 360 px panel and room for the unavailable caption');
    check(nav.NAV_METRICS.button===G.navButton&&nav.NAV_METRICS.gap===G.navGap&&nav.NAV_METRICS.hide===G.navHide+6&&NAME_LIMITS.displayPx===G.displayPx&&bar.TIMING.wheelMs<600,'Navigation metrics and label budget match the scenario geometry');
    // 5. Click geometry the native run computes, against the finished sources.
    const mainSource=await fs.readFile(path.join(ROOT,'src/mods/mission-control-tabs/main.js'),'utf8'),navSource=await fs.readFile(path.join(ROOT,'src/mods/mission-control-tabs/navigation.js'),'utf8'),uiSource=await fs.readFile(path.join(ROOT,'src/shared/ui.js'),'utf8');
    for(const [source,fragment]of [[mainSource,"h_flex().id('tab-body-'+tab.id).h(28).px(9).gap(6)"],[mainSource,"div().id('tab-close-'+tab.id).size(16)"],[mainSource,'div().id(id).size(7)'],[mainSource,'.pr(8).gap(4).items_center()'],[mainSource,"wrap=div().id('tab-icon-'+tab.id).size(14)"],[mainSource,'TOPBAR_WIDE=720'],[mainSource,"iconButton(MOD,'mc-new','plus'"],[mainSource,'{disabled:!space,size:26}'],[mainSource,'{disabled:!ready,size:26}'],[mainSource,"kind:'popup',width:240,height:170"],[navSource,'el=compact?el.w(28):el.px(9)'],[navSource,"h_flex().id('view-swap').h(26).flex_none().items_center().justify_center().gap(6)"],[navSource,"el.child(icon(mod,'layout',14))"],[navSource,"iconButton(mod,'hide-work-panel','close','Hide work panel',(_e,cx)=>onHide?.(cx),{size:24})"],[navSource,"h_flex().id('mc-work-navigation').size_full().min_w(0).px(6).gap(NAV_METRICS.gap)"],[navSource,"{active:open,disabled:!enabled,size:26}"],[uiSource,'el.child(icon(mod,name,15))']])
      check(source.includes(fragment),'Source geometry unchanged: '+fragment);
    // 6. Pixel evidence decoding on an actual WindowServer frame already in the repository.
    const real=path.join(ROOT,'mission-control-agents/preview.png'),png=decodePng(await fs.readFile(real)),header=(await fs.readFile(real)).subarray(16,24);
    let dark=0,samples=0;for(let y=0;y<png.height;y+=7)for(let x=0;x<png.width;x+=7){const p=png.pixel(x,y);samples++;if(Math.max(...p)<70)dark++;}
    check(png.width===header.readUInt32BE(0)&&png.height===header.readUInt32BE(4)&&dark/samples>0.3,'The PNG decoder reads an actual native frame (graphite pixels dominate)');
    const corner=backgroundOf(png,1,{x:2,y:png.height-6,width:4,height:4}),stats=inkStats(png,1,{x:0,y:0,width:png.width,height:png.height},corner);
    check(stats.count>0&&stats.count<png.width*png.height&&stats.mean.every(v=>v>=0&&v<=255),'Ink statistics separate drawn content from the background');
    // 7. Native helpers compile and the remote transport passes its selectors through.
    await positionWindow(null,{compileOnly:true,directory,cache:path.join(directory,'swift-cache')});check(true,'The owned window positioning helper compiles');
    const via=path.join(directory,'via.py');await fs.writeFile(via,viaSource({HC_SESSION:'mcqa-tabs-fixture'}));await fs.chmod(via,0o700);
    check((await execute(via,['ignored','echo "$HC_SESSION"'],{timeout:10000})).stdout.trim()==='mcqa-tabs-fixture','The via transport applies the second core selectors');
    check(new Set(Object.values(EXPECTATIONS)).size===Object.keys(EXPECTATIONS).length&&Object.values(EXPECTATIONS).every(l=>l.length<=1800&&!/[\u0000-\u001f]/.test(l)),'Every scenario expectation label is unique and receipt-safe');
    return {ok:true,assertions:checks.length,checks,boundary:'Disposable actors, a temporary journal through launch.js, the real naming/navigation/main modules over the GPUI recording seam, an existing native PNG and the compiled helpers only. No Herdr app/core was constructed, queried or stopped and no receipt or preview was written.'};
  }finally{await fs.rm(directory,{recursive:true,force:true});}
}

/** Private negative proof: an empty, node-less view never writes a releasable receipt or a public preview. */
export async function checkEmptyState(){
  const runtime=new NativeRuntime(),receiptFile=path.join(ROOT,RECEIPT),previewFile=path.join(ROOT,MOD,'preview.png');let failure,publicReceiptUnchanged=false,publicPreviewUnchanged=false;
  const read=async file=>{try{return await fs.readFile(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}},before={receipt:await read(receiptFile),preview:await read(previewFile)};
  try{
    await runtime.start();await runtime.installPackage(MOD);
    await fs.writeFile(path.join(runtime.env.HERDR_APP_HOME,'window.json'),JSON.stringify({state:'windowed',bounds:[G.x,G.y,G.width,G.height]})+'\n');
    await runtime.startWindow({name:'tabs-empty',layout:testLayouts()[LAYOUTS.empty]});await positionWindow(runtime);
    const ui=nativeUI(runtime,{budget:120}),quiet=JSON.stringify([runtime.hc(['ls','--json']).terminals.length,runtime.app(['ls']).spaces.map(s=>s.tabs.length)]);
    let c=await ui.controls();const tab=await ui.tip(c.rects['reopen-tab'],c.observation,'Reopen last tab (nothing closed)','No closed tab has been recorded');
    c=await ui.controls();const agent=await ui.tip(c.rects['reopen-agent'],c.observation,'Reopen last agent (nothing closed)','Shell-only tabs are skipped');await delay(1500);
    runtime.expect(Boolean(tab&&agent)&&JSON.stringify([runtime.hc(['ls','--json']).terminals.length,runtime.app(['ls']).spaces.map(s=>s.tabs.length)])===quiet,'Empty Reopen actions are disabled, say why and start nothing');
    c=await ui.controls();runtime.expect(Boolean(await ui.tip(c.rects.swap,c.observation,'Switch view (disabled)','View swap unavailable'))&&ui.layoutName()===LAYOUTS.empty,'A node-less view disables the swap and says why');
    c=await ui.controls();runtime.expect(Boolean(await ui.tip(c.rects.panel,c.observation,'Work panel (disabled)','Work panel unavailable')),'A node-less view disables the panel control and says why');
    runtime.expect(Boolean(await ui.visible('Work sources unavailable',inNavRow,20000)),'A node-less view shows why its work sources are unavailable');
    runtime.expect(runtime.app(['status']).errors?.length===0,'Empty and missing-node states produce no native app error');
  }catch(error){failure=error;}
  finally{if(runtime.directory)try{await runtime.close();}catch(error){failure??=error;}}
  try{const receiptAfter=await read(receiptFile),previewAfter=await read(previewFile);publicReceiptUnchanged=before.receipt===null?receiptAfter===null:before.receipt.equals(receiptAfter);publicPreviewUnchanged=before.preview===null?previewAfter===null:before.preview.equals(previewAfter);assert.equal(publicReceiptUnchanged,true);assert.equal(publicPreviewUnchanged,true);}catch(error){failure??=error;}
  const report={schema:'mission-control-tabs-empty-state-negative-v1',passed:!failure,featureProof:false,publicReceiptUnchanged,publicPreviewUnchanged,cleanup:runtime.cleanup,cleanupError:runtime.closeError?{code:runtime.closeError.code,message:runtime.closeError.message}:null,negativeReceipt:runtime.receipt(false,Object.assign(Error('An empty or node-less view is not a successful feature/release gate.'),{code:'EMPTY_STATE_NOT_RELEASEABLE'})),...(failure?{error:failure.message}:{})};
  await fs.mkdir(path.join(ROOT,'.harness'),{recursive:true});await fs.writeFile(path.join(ROOT,'.harness/tabs-empty-state.json'),JSON.stringify(report,null,2)+'\n');
  if(failure)throw failure;return {passed:true,featureProof:false,publicReceiptUnchanged,publicPreviewUnchanged,cleanup:runtime.cleanup};
}

/** Copies the preview frame only from a passed, validated receipt whose tested build equals the current package. */
export async function promotePreview(){
  const receiptPath=path.join(ROOT,RECEIPT),receipt=JSON.parse(await fs.readFile(receiptPath,'utf8'));
  assert.equal(receipt.ok,true,'Only a passed Tabs receipt can promote a preview');assert.equal(await validateNativeIsolationReceipt(receipt,{receiptPath:RECEIPT}),true);
  const labels=new Set(receipt.assertions.filter(a=>a.passed).map(a=>a.label));for(const label of Object.values(EXPECTATIONS))assert.ok(labels.has(label),'The passed receipt lacks: '+label);
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
  if(!check)throw Error('Use node scripts/native-harness.mjs run tabs for the mounted gate, fixture-check for the core-free preflight, empty-state-check for the private negative proof, or promote-preview after a passed receipt.');
  check().then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(error);process.exitCode=1;});
}
