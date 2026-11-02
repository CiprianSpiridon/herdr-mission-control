import fs from 'node:fs/promises';
import path from 'node:path';
import {NativeRuntime,run,until} from '../../scripts/native-harness.mjs';
import {bindingKey} from '../../src/shared/config.js';
import {localTerminalAddress} from '../../src/shared/session-identity.js';

const MOD='mission-control-spaces';
export default async function spaces(runtime){
  const home=runtime.env.HERDR_APP_HOME,tool=path.join(runtime.directory,'qa-claude');
  const server=new NativeRuntime();let connected=false;
  await fs.writeFile(tool,`#!/usr/bin/env python3
import sys,time
if '--help' in sys.argv: print('Claude Code QA fixture\\n --model <model>\\n --session-id <uuid>\\n --resume [value]');sys.exit(0)
if '--version' in sys.argv: print('QA fixture 1.0');sys.exit(0)
print('Disposable native test agent; no provider request.',flush=True)
time.sleep(3600)
`);await fs.chmod(tool,0o700);
  await fs.writeFile(path.join(home,'programs.json'),JSON.stringify({programs:{claude:{name:'QA Claude fixture',run:[tool]}}}));
  await fs.mkdir(path.join(home,'mission-control'),{recursive:true});
  const configFile=path.join(home,'mission-control/config.json');
  await fs.writeFile(configFile,JSON.stringify({v:1,revision:0,connections:{},bindings:{},preferences:{launch:{v:1,pins:['claude'],hidden:[],worktree:false,tools:{}}},usageSources:{}}));
  await runtime.installPackage(MOD);
  // This narrower real window is independent of the user's normal Herdr window.
  await fs.writeFile(path.join(home,'window.json'),JSON.stringify({state:'windowed',bounds:[100,100,1024,720]}));
  const block=(id,mod,size,props)=>({id,type:'block',...(size?{size:{px:size}}:{}),content:{mod,...(props?{props}:{})}});
  await runtime.startWindow({name:'spaces-native',layout:{id:'qa-root',type:'row',titlebar:'none',traffic_lights:[12,16],background:'canvas',children:[
    {id:'sidebar',type:'column',size:{px:220},background:'chrome',children:[block('brand','workspace-chrome',46),block('spaces',MOD),block('agents','agents',150),block('footer',MOD,69,{view:'footer'})]},
    {id:'work',type:'column',children:[block('tabs','tabs',42),{id:'main',type:'block',content:{tab:'active'}},block('status','workspace-status',28)]}
  ]}});
  // Position only this verified fixture window beside the central system
  // alert. The public AX window-position API changes no OS permissions.
  const positionSource=path.join(runtime.directory,'position-window.swift'),positionBinary=path.join(runtime.directory,'position-window');
  await fs.writeFile(positionSource,String.raw`import Cocoa
import ApplicationServices
let args=CommandLine.arguments
let pid=Int32(args[1])!,windowID=Int(args[2])!
let all=CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements],kCGNullWindowID) as? [[String:Any]] ?? []
let owned=all.filter { ($0[kCGWindowOwnerPID as String] as? Int)==Int(pid) && ($0[kCGWindowLayer as String] as? Int)==0 }
guard owned.count==1,(owned[0][kCGWindowNumber as String] as? Int)==windowID else { exit(2) }
let app=AXUIElementCreateApplication(pid)
var raw:CFTypeRef?
guard AXUIElementCopyAttributeValue(app,kAXWindowsAttribute as CFString,&raw) == .success,let windows=raw as? [AXUIElement],windows.count==1 else { exit(3) }
var actual:pid_t=0
AXUIElementGetPid(windows[0],&actual)
guard actual==pid else { exit(4) }
var point=CGPoint(x:Double(args[3])!,y:Double(args[4])!)
guard point.x.isFinite,point.y.isFinite,let value=AXValueCreate(.cgPoint,&point),AXUIElementSetAttributeValue(windows[0],kAXPositionAttribute as CFString,value) == .success else { exit(5) }
print(#"{"moved":true}"#)
`);
  run('swiftc',['-module-cache-path',path.resolve('.harness/swift-cache'),positionSource,'-o',positionBinary],{json:false,timeout:60000});
  // The new window can report its layout before WindowServer lists it on screen.
  const positionBefore=await until(async()=>(await runtime.driver.pointerTarget({x:1,y:1,width:2,height:2})).frame,'one visible owned fixture window');
  run(positionBinary,[String(positionBefore.pid),String(positionBefore.id),String(positionBefore.x),'350']);
  await until(async()=>Math.abs((await runtime.driver.pointerTarget({x:1,y:1,width:2,height:2})).frame.y-350)<2,'owned fixture window positioned beside system alert');
  runtime.expect(true,'Only the owned fixture window was positioned; system permissions were left unchanged');
  let serial=0;
  const observe=async(query='')=>{const frame=await runtime.frame('spaces-observe-'+(++serial));return runtime.driver.ocr(path.resolve(frame.path),query);};
  const text=async(query,predicate=()=>true)=>until(async()=>{const observation=await observe(query),matches=observation.matches.filter(n=>n.confidence>=0.6&&predicate(n,observation));return matches.length===1?{observation,node:matches[0]}:null;},'visible unique native text '+query);
  const click=async(query,predicate)=>{const {observation,node}=await text(query,predicate);await runtime.driver.clickObservedText(observation,node);};
  const has=async query=>(await observe()).lines.some(n=>n.text.includes(query));
  const search=async value=>{
    const observation=await observe();
    // The retained native Input is at the fixed list header, not an OCR text surrogate.
    await runtime.driver.click({x:42,y:46+32+5,width:142,height:22},{expectedSize:observation.window});
    Object.assign(runtime.driver.actions.at(-1),{control:'Find a space',observation:observation.source});
    await runtime.driver.press('cmd-a');await runtime.driver.press('backspace');
    for(const character of value)await runtime.driver.press(character);
    await until(async()=>(await runtime.shared())['mission-control-spaces-v1']?.query===value,'native search input '+value);
  };
  const selectA=()=>runtime.app(['do','space.select',JSON.stringify({id:runtime.spaceId})]);
  const context=async(name,{ellipsis=false}={})=>{
    await search(name.split('-')[0]);
    const {observation,node}=await text(name,n=>n.frame.x<220&&n.frame.y>108);
    if(ellipsis){await runtime.driver.click({x:220-7-24,y:node.frame.y+node.frame.height/2-12,width:24,height:24},{expectedSize:observation.window});Object.assign(runtime.driver.actions.at(-1),{control:'Space menu',observation:observation.source});}
    else{await runtime.driver.click(node.frame,{expectedSize:observation.window,button:'right'});Object.assign(runtime.driver.actions.at(-1),{control:'Right-click '+name,observation:observation.source});}
    await text('New agent');
  };
  const overlay=()=>runtime.app(['status']).overlays;
  const close=async()=>{await runtime.driver.press('escape');await until(()=>!overlay()?.length,'closed native overlay');};
  const finderTarget=()=>run('osascript',['-e','tell application "Finder" to get POSIX path of (target of front window as alias)'],{json:false});
  const closeFinder=folder=>run('osascript',['-e',`tell application "Finder"
repeat with w in (get every Finder window)
if POSIX path of (target of w as alias) is ${JSON.stringify(folder+'/')} then close w
end repeat
end tell`],{json:false});
  // Closing the Finder window leaves Finder frontmost and it will not yield focus; activate the owned window before more input.
  const refocus=async()=>{await runtime.driver.activate({x:600,y:300,width:4,height:4});runtime.driver.actions.at(-1).after='Finder';};
  try{
    const repoB=await runtime.createRepo('client-portal');
    const b=runtime.app(['do','space.new',JSON.stringify({name:'client-portal',folder:repoB,argv:[tool]})]);
    const ambiguous=runtime.app(['do','space.new',JSON.stringify({name:'ambiguous-space',folder:runtime.repo,argv:['/bin/cat']})]);
    const otherTab=runtime.app(['do','tab.new',JSON.stringify({space:ambiguous.space,folder:repoB,argv:['/bin/cat']})]);
    const emptyFolder=path.join(runtime.directory,'not-git');await fs.mkdir(emptyFolder);
    runtime.app(['do','space.new',JSON.stringify({name:'not-git',folder:emptyFolder,argv:['/bin/cat']})]);
    for(let n=4;n<128;n++)runtime.app(['do','space.new',JSON.stringify({name:'space-'+String(n).padStart(3,'0'),folder:runtime.repo,argv:['/bin/cat']})]);
    runtime.expect(runtime.app(['ls']).spaces.length===128,'Actual private model contains 128 spaces');
    await search('127');await click('space-127',n=>n.frame.x<220&&n.frame.y>108);
    runtime.expect(runtime.app(['ls']).spaces.find(s=>s.active)?.name==='space-127','Native search reaches and selects the 128th space');
    const stateBefore=(await runtime.shared())['mission-control-spaces-v1'];
    let observed=await observe();await runtime.driver.click({x:8,y:46+2,width:28,height:28},{expectedSize:observed.window});Object.assign(runtime.driver.actions.at(-1),{control:'Collapse Spaces',observation:observed.source});
    await until(async()=>(await runtime.shared())['mission-control-spaces-v1']?.collapsed===true,'collapsed native Spaces');
    runtime.expect(await has('Agents'),'Collapsing Spaces leaves the separate native Agents section accessible');
    await click('Settings',n=>n.frame.x<220);await until(()=>overlay()?.includes('frame-settings'),'actual native Settings overlay');
    runtime.expect(overlay().includes('frame-settings'),'Bottom Settings opens the native Settings view while Spaces is collapsed');await close();
    await click('Add machine',n=>n.frame.x<220);await until(()=>overlay()?.length&&has('Add a machine'),'actual machine-add overlay');
    runtime.expect(await has('user@host'),'Bottom Add machine opens the shipped machine-add host dialog');await close();
    observed=await observe();await runtime.driver.click({x:8,y:46+2,width:28,height:28},{expectedSize:observed.window});
    await until(async()=>(await runtime.shared())['mission-control-spaces-v1']?.collapsed===false,'expanded native Spaces');
    runtime.expect((await runtime.shared())['mission-control-spaces-v1'].query===stateBefore.query,'Collapsing/expanding preserves the search query');
    await click('This Mac',n=>n.frame.x<220&&n.frame.y>108);await until(async()=>Boolean((await runtime.shared())['mission-control-spaces-v1'].groups['[null]']),'machine group collapsed');
    runtime.expect(!(await has('space-127')),'Collapsing the machine group hides its rows');await click('This Mac',n=>n.frame.x<220&&n.frame.y>108);
    selectA();await context('client-portal');
    runtime.expect(runtime.app(['ls']).spaces.find(s=>s.active)?.id===runtime.spaceId,'Right-clicking B preserves selected space A');
    await click('Open in Finder');await until(()=>finderTarget()===repoB+'/','actual Finder opened clicked repository');
    runtime.expect(finderTarget()===repoB+'/','Native Finder control opens B rather than selected A');closeFinder(repoB);await refocus();
    selectA();await context('client-portal',{ellipsis:true});await click('New agent');await click('QA Claude fixture');await click('New worktree');await click('Start agent');
    const launched=await until(async()=>{try{const journal=JSON.parse(await fs.readFile(path.join(home,'mission-control/launches.json'),'utf8'));return Object.values(journal.requests).find(r=>r.state==='complete');}catch{return null;}},'native right-click launch');
    runtime.expect(launched.request.spaceId===b.space&&launched.request.repoRoot===repoB&&launched.request.machine===null,'Right-click New agent keeps B repository, space and host');
    runtime.expect(launched.folder!==repoB&&launched.folder.includes('client-portal-task-')&&runtime.hc(['get',launched.ack.terminal,'--json']).cwd===launched.folder,'Actual agent starts in B new worktree');
    selectA();await context('ambiguous-space');await until(()=>has('Focus a terminal'),'conflicting unfocused repositories blocked');
    const count=runtime.hc(['ls','--json']).terminals.length,before=JSON.stringify(overlay());await click('New agent');
    runtime.expect(JSON.stringify(overlay())===before&&runtime.hc(['ls','--json']).terminals.length===count,'Ambiguous inactive space cannot launch an agent');
    await click('Open in Finder');runtime.expect(JSON.stringify(overlay())===before,'Ambiguous inactive space cannot open Finder');await close();
    // Explicit native selection/focus disambiguates the repository.
    await click('ambiguous-space',n=>n.frame.x<220&&n.frame.y>108);runtime.app(['do','pane.focus',JSON.stringify({terminal:otherTab.terminal})]);
    observed=await observe();await runtime.driver.click({x:600,y:300,width:4,height:4},{expectedSize:observed.window});
    await context('ambiguous-space');await click('New agent');await click('QA Claude fixture');
    // The dialog can draw its captured folder a frame after the tool click.
    runtime.expect(await until(()=>has(repoB),'captured repository in the launch dialog',10000).then(()=>true,()=>false),'Explicit focused checkout supplies the captured repository');await close();
    selectA();await context('not-git');await until(()=>has('No live terminal'),'unbound repository reason');
    const noRepo=JSON.stringify(overlay());await click('New agent');runtime.expect(JSON.stringify(overlay())===noRepo,'Non-Git folder has no launch fallback');await close();

    // A second actual core uses a task-owned transparent transport. It is a
    // local multi-machine fixture, not evidence of external server availability.
    await server.start();
    const via=path.join(runtime.directory,'qa-via.py');await fs.writeFile(via,`#!/usr/bin/env python3\nimport os,sys\ne=os.environ.copy();e.update(${JSON.stringify(Object.fromEntries(Object.entries(server.env).filter(([key])=>['HOME','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_RUNTIME_DIR','HC_SESSION','HERDR_APP_HOME'].includes(key)))).replaceAll('null','None')})\nos.execvpe('/bin/sh',['sh','-c',sys.argv[-1]],e)\n`);await fs.chmod(via,0o700);
    runtime.hc(['machine','add','--via',via,'--name','qa-server','--session',server.env.HC_SESSION,'--json']);connected=true;
    const remote=await until(()=>runtime.app(['ls']).spaces.find(s=>s.machine==='qa-server'),'remote core sentinel adoption');
    runtime.app(['do','space.rename',JSON.stringify({id:remote.id,name:'server-repo'})]);selectA();
    await context('server-repo');const remoteOverlay=JSON.stringify(overlay());await click('Open in Finder');
    runtime.expect(JSON.stringify(overlay())===remoteOverlay,'Unmapped remote repository cannot open its server path locally');await close();
    const cfg=JSON.parse(await fs.readFile(configFile,'utf8'));cfg.bindings[bindingKey('qa-server',server.repo)]={machine:'qa-server',repoRoot:server.repo,mountedLocalPath:repoB};cfg.revision++;await fs.writeFile(configFile,JSON.stringify(cfg));
    await context('server-repo');await click('Open in Finder');await until(()=>finderTarget()===repoB+'/','explicit mounted remote Finder');runtime.expect(finderTarget()===repoB+'/','Remote Finder uses only the explicitly configured validated local mount');closeFinder(repoB);await refocus();
    await context('server-repo');await click('New agent');await click('QA Claude fixture');
    // The program lives at a shared physical fixture path but authority/cwd
    // still goes through the named machine, never through a local fallback.
    await click('Current checkout');await click('Start agent');
    const remoteLaunch=await until(async()=>{const journal=JSON.parse(await fs.readFile(path.join(home,'mission-control/launches.json'),'utf8'));return Object.values(journal.requests).find(r=>r.state==='complete'&&r.request.machine==='qa-server');},'named-machine native agent launch');
    runtime.expect(remoteLaunch.request.spaceId===remote.id&&remoteLaunch.request.repoRoot===server.repo&&server.hc(['get',localTerminalAddress(remoteLaunch.ack.terminal,'qa-server'),'--json']).cwd===server.repo,'Named-machine launch actually belongs to the separate core/repository');
    selectA();await search('missing');await until(()=>has('No matching spaces.'),'native empty search');runtime.expect(await has('Add machine'),'Empty search retains the native footer');
    // The published preview shows the whole list, not a one-result search.
    await search('');await until(async()=>!(await has('No matching spaces.')),'full space list',20000);await runtime.frame('spaces-preview').then(frame=>fs.copyFile(path.resolve(frame.path),path.resolve(MOD,'preview.png')));
    runtime.expect(runtime.app(['status']).errors.length===0,'No native errors across Spaces interactions');
    runtime.expect((await fs.readdir(path.join(home,'mods'))).filter(n=>n.startsWith('mission-control-')).join(',')===MOD,'Only the standalone Spaces custom mod is installed');
  }catch(error){try{await runtime.frame('spaces-failure');const directory=path.resolve('.browse/sessions',`mission-control-native-${runtime.nonce}`);await fs.writeFile(path.join(directory,'native-console.txt'),runtime.appStdout+'\n'+runtime.appStderr);await fs.writeFile(path.join(directory,'failure-status.json'),JSON.stringify(runtime.app(['status']),null,2));}catch{}throw error;}
  finally{if(connected)runtime.hc(['machine','rm','qa-server','--json']);if(server.directory)await server.close();}
}
