import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {run,until,createFixtureService} from '../../scripts/native-harness.mjs';
import {bindingKey} from '../../src/shared/config.js';

const MOD='mission-control-jira',UI='mission-control-jira-ui-v1';
const CLOUD='11111111-2222-4333-8444-555555555555';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const execute=promisify(execFile);
// The harness validates this explicit synthetic record before private startup.
// Importing the scenario leaves the parent environment unchanged.
const fixtureCA=path.resolve('.harness/jira-fixture-cas.pem');
export const fixtureEnvironment={NODE_EXTRA_CA_CERTS:fixtureCA,QA_WORK_EMAIL:'work@example.invalid',QA_WORK_TOKEN:'owned-work-fixture',QA_PERSONAL_EMAIL:'personal@example.invalid',QA_PERSONAL_TOKEN:'owned-personal-fixture'};

// No real provider or credential store is used. These foreground actors only
// implement help/version and keep the owned core terminal alive.
async function tools(runtime){
  const programs={};
  for(const [key,title] of [['claude','Claude Code'],['codex','Codex CLI'],['grok','Grok Build TUI']]){
    const file=path.join(runtime.directory,'qa-'+key),help=title+'\nUsage: '+key+' [OPTIONS] [PROMPT]\n --model <MODEL>\n'+(key==='codex'?' --no-daemon\n':' --session-id <uuid>\n --resume <uuid>\n');
    await fs.writeFile(file,`#!/usr/bin/env python3
import sys,time
if '--help' in sys.argv: print(${JSON.stringify(help)});sys.exit(0)
if '--version' in sys.argv: print('QA fixture 1.0');sys.exit(0)
print('Disposable Jira native actor; no provider request.',flush=True)
time.sleep(3600)
`);await fs.chmod(file,0o700);programs[key]={name:'QA '+key,run:[file]};
  }
  await fs.writeFile(path.join(runtime.env.HERDR_APP_HOME,'programs.json'),JSON.stringify({programs}));return programs;
}

async function prepareOwnedWindow(runtime){
  // Move only this PID/window-verified fixture away from the persistent,
  // unrelated system privacy alert. Do not grant or deny OS permissions.
  const source=path.join(runtime.directory,'position-window.swift'),binary=path.join(runtime.directory,'position-window');
  await fs.writeFile(source,String.raw`import Cocoa
import ApplicationServices
let a=CommandLine.arguments,pid=Int32(a[1])!,windowID=Int(a[2])!
func fail(_ code:String,_ values:[String:Any]=[:]) -> Never {var payload=values;payload["code"]=code;let data=try! JSONSerialization.data(withJSONObject:payload);FileHandle.standardOutput.write(data);exit(2)}
let all=CGWindowListCopyWindowInfo([.optionAll,.excludeDesktopElements],kCGNullWindowID) as? [[String:Any]] ?? []
let owned=all.filter { record in
 guard (record[kCGWindowOwnerPID as String] as? Int)==Int(pid),(record[kCGWindowLayer as String] as? Int)==0,let b=record[kCGWindowBounds as String] as? [String:Any],let r=CGRect(dictionaryRepresentation:b as CFDictionary) else { return false }
 return r.width>=800 && r.height>=600
}
guard owned.count==1,windowID==0 || (owned[0][kCGWindowNumber as String] as? Int)==windowID else { fail("OWNED_WINDOWS",["windows":owned.map{["id":$0[kCGWindowNumber as String] ?? 0,"bounds":$0[kCGWindowBounds as String] ?? [:],"onscreen":$0[kCGWindowIsOnscreen as String] ?? false]}]) }
guard let application=NSRunningApplication(processIdentifier:pid),!application.isTerminated else { fail("APP_EXITED") }
let mustActivate=application.isHidden || !application.isActive || !(owned[0][kCGWindowIsOnscreen as String] as? Bool ?? false)
if mustActivate { application.unhide();application.activate(options:[.activateIgnoringOtherApps,.activateAllWindows]) }
var raw:CFTypeRef?
guard AXUIElementCopyAttributeValue(AXUIElementCreateApplication(pid),kAXWindowsAttribute as CFString,&raw) == .success,let allWindows=raw as? [AXUIElement] else { fail("AX_WINDOWS") }
let windows=allWindows.filter { window in
 var rawSize:CFTypeRef?
 guard AXUIElementCopyAttributeValue(window,kAXSizeAttribute as CFString,&rawSize) == .success,let rawSize=rawSize,CFGetTypeID(rawSize)==AXValueGetTypeID() else { return false }
 var size=CGSize.zero
 return AXValueGetValue(rawSize as! AXValue,.cgSize,&size) && size.width>=800 && size.height>=600
}
guard windows.count==1 else { fail("AX_MAIN_WINDOWS",["all":allWindows.count,"large":windows.count,"hidden":application.isHidden,"active":application.isActive,"foregroundPID":NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0]) }
var actual:pid_t=0
AXUIElementGetPid(windows[0],&actual)
guard actual==pid else { fail("AX_PID") }
if mustActivate { let raised=AXUIElementPerformAction(windows[0],kAXRaiseAction as CFString);guard raised == .success else { fail("AX_RAISE",["error":raised.rawValue]) } }
var full:CFTypeRef?
if AXUIElementCopyAttributeValue(windows[0],"AXFullScreen" as CFString,&full) == .success,let isFull=full as? Bool,isFull {
 guard AXUIElementSetAttributeValue(windows[0],"AXFullScreen" as CFString,kCFBooleanFalse) == .success else { fail("AX_FULLSCREEN") }
 print(#"{"exitingFullscreen":true}"#)
 exit(0)
}
var size=CGSize(width:1280,height:760)
var currentRaw:CFTypeRef?,currentSize=CGSize.zero
if AXUIElementCopyAttributeValue(windows[0],kAXSizeAttribute as CFString,&currentRaw) == .success,let value=currentRaw,CFGetTypeID(value)==AXValueGetTypeID() { _=AXValueGetValue(value as! AXValue,.cgSize,&currentSize) }
if abs(currentSize.width-size.width)>1 || abs(currentSize.height-size.height)>1 { guard let value=AXValueCreate(.cgSize,&size),AXUIElementSetAttributeValue(windows[0],kAXSizeAttribute as CFString,value) == .success else { fail("AX_SIZE") } }
var point=CGPoint(x:Double(a[3])!,y:Double(a[4])!)
var currentPoint=CGPoint.zero
if AXUIElementCopyAttributeValue(windows[0],kAXPositionAttribute as CFString,&currentRaw) == .success,let value=currentRaw,CFGetTypeID(value)==AXValueGetTypeID() { _=AXValueGetValue(value as! AXValue,.cgPoint,&currentPoint) }
if abs(currentPoint.x-point.x)>1 || abs(currentPoint.y-point.y)>1 { guard point.x.isFinite,point.y.isFinite,let value=AXValueCreate(.cgPoint,&point),AXUIElementSetAttributeValue(windows[0],kAXPositionAttribute as CFString,value) == .success else { fail("AX_POSITION") } }
let data=try! JSONSerialization.data(withJSONObject:["moved":true,"windowId":owned[0][kCGWindowNumber as String] as! Int])
FileHandle.standardOutput.write(data)
`);
  run('swiftc',['-module-cache-path',path.resolve('.harness/swift-cache'),source,'-o',binary],{json:false,timeout:60000});
  return async()=>{
    let stableSince=0,signature='';
    await until(async()=>{
      const result=run(binary,[String(runtime.owner.pid),'0','300','350']);if(result.exitingFullscreen)return false;
      let frame;try{frame=await runtime.driver.bindWindow(result.windowId);}catch(error){stableSince=0;throw error;}
      if(Math.abs(frame.y-350)>=2||Math.abs(frame.x-300)>=2||Math.abs(frame.width-1280)>=2||Math.abs(frame.height-760)>=2){stableSince=0;return false;}
      const next=JSON.stringify([frame.id,frame.x,frame.y,frame.width,frame.height]);if(next!==signature||!stableSince){signature=next;stableSince=Date.now();}
      return Date.now()-stableSince>=800;
    },'owned Jira main window visible with verified position and size');
  };
}

export default async function jira(runtime){
  const home=runtime.env.HERDR_APP_HOME,configFile=path.join(home,'mission-control/config.json'),services=[];
  const flags={workError:false,personalError:false},data=(project)=>[
    {id:'10001',key:project+'-142',fields:{summary:project==='WEB'?'Fix login redirect':'Refresh billing summary',description:{type:'doc',version:1,content:[{type:'paragraph',content:[{type:'text',text:'Fixture issue task data. Preserve the captured repository.'}]}]},status:{name:'To do',statusCategory:{key:'new'}},priority:{name:'High'}}},
    {id:'10002',key:project+'-156',fields:{summary:'Improve account settings',description:null,status:{name:'In progress',statusCategory:{key:'indeterminate'}},priority:{name:'Medium'}}},
    {id:'10003',key:project+'-168',fields:{summary:'Restore keyboard navigation',description:null,status:{name:'Done',statusCategory:{key:'done'}},priority:{name:'Low'}}}
  ];
  let work,personal;
  try{
    work=await createFixtureService(path.join(runtime.directory,'jira-work'),{handler:request=>{
      if(request.url==='/rest/api/3/serverInfo')return {body:{baseUrl:work.origin,displayUrl:'https://custom.example.invalid'}};
      if(request.url.startsWith('/rest/api/3/search/jql'))return flags.workError?{status:401,body:{error:'Private fixture message must not appear.'}}:{body:{issues:data('WEB'),isLast:true}};
      return {body:{fixture:true}};
    }});services.push(work);
    personal=await createFixtureService(path.join(runtime.directory,'jira-personal'),{handler:request=>{
      if(request.url==='/rest/api/3/serverInfo')return {body:{baseUrl:personal.origin}};
      if(request.url.startsWith('/rest/api/3/search/jql'))return flags.personalError?{status:403,body:{error:'Private fixture message must not appear.'}}:{body:{issues:data('OPS'),isLast:true}};
      return {body:{fixture:true}};
    },tools:[{name:'search_issues',description:'Owned read-only Jira fixture',annotations:{readOnlyHint:true},inputSchema:{type:'object',properties:{jql:{type:'string'},cloudId:{type:'string'},maxResults:{type:'integer'},nextPageToken:{type:'string'}},required:['jql','cloudId','maxResults']},handler:()=>({structuredContent:{issues:data('MCP').map(row=>({id:row.id,key:row.key,title:row.fields.summary,body:'MCP fixture',status:row.fields.status.name}))},content:[]})}]});services.push(personal);
    await fs.writeFile(fixtureCA,(await Promise.all(services.map(s=>fs.readFile(s.caFile,'utf8')))).join('\n'));
    const programs=await tools(runtime),other=await runtime.createRepo('billing-service');
    const config={v:1,revision:0,connections:{work:{id:'work',kind:'api',site:work.origin,auth:{kind:'basic',usernameEnv:'QA_WORK_EMAIL',tokenEnv:'QA_WORK_TOKEN'}},personal:{id:'personal',kind:'api',site:personal.origin,auth:{kind:'basic',usernameEnv:'QA_PERSONAL_EMAIL',tokenEnv:'QA_PERSONAL_TOKEN'}}},bindings:{[bindingKey(null,runtime.repo)]:{machine:null,repoRoot:runtime.repo,jira:{connectionId:'work',project:'WEB'}},[bindingKey(null,other)]:{machine:null,repoRoot:other,jira:{connectionId:'personal',project:'OPS'}}},preferences:{launch:{v:1,pins:['claude','codex','grok'],hidden:[],worktree:true,tools:{}}},usageSources:{}};
    await fs.mkdir(path.dirname(configFile),{recursive:true});await fs.writeFile(configFile,JSON.stringify(config));
    await runtime.installPackage(MOD);
    const probe=await execute(process.execPath,[path.join(home,'mods',MOD,'backend.mjs'),JSON.stringify({v:1,operation:'issues',connection:config.connections.work,binding:config.bindings[bindingKey(null,runtime.repo)]})],{env:runtime.env,timeout:25000});
    const probeResult=JSON.parse(probe.stdout);if(!probeResult.ok)throw Error('Standalone TLS fixture preflight failed: '+probeResult.error?.code);runtime.expect(probeResult.snapshot.data.length===3,'Real standalone helper can read all three owned TLS fixture issues before mounting');
    await fs.writeFile(path.join(home,'window.json'),JSON.stringify({state:'windowed',bounds:[50,350,1280,760]}));
    const positionOwnedWindow=await prepareOwnedWindow(runtime);
    const block=(id,mod,size,props)=>({id,type:'block',...(size?{size:{px:size}}:{}),content:{mod,...(props?{props}:{})}});
    await runtime.startWindow({name:'jira-native',layout:{id:'qa-root',type:'column',titlebar:'none',traffic_lights:[12,16],theme:'graphite',background:'canvas',children:[block('tabs','tabs',42),{id:'workspace',type:'row',children:[{id:'board',type:'block',size:{weight:3},content:{mod:MOD}},{id:'terminal',type:'block',size:{px:280},content:{tab:'active'}}]},block('status','workspace-status',26)]}});
    await positionOwnedWindow();
    // A Space transition can start between a screenshot and its guarded input.
    // Recover only a missing-window guard raised before any native event; the
    // original PID/id/size/hit-test checks still run after the recovery.
    const pointerTarget=runtime.driver.pointerTarget.bind(runtime.driver);let recovering=false;
    runtime.driver.pointerTarget=async(...args)=>{
      try{return await pointerTarget(...args);}catch(error){
        if(recovering||error.message!=='A unique owned visible native window is required')throw error;
        recovering=true;try{await positionOwnedWindow();runtime.driver.actions.push({kind:'window-recovery',pid:runtime.owner.pid,windowId:runtime.driver.windowId,beforeInput:true});return await pointerTarget(...args);}finally{recovering=false;}
      }
    };
    const press=runtime.driver.press.bind(runtime.driver);
    runtime.driver.press=async key=>{
      for(let attempt=0;;attempt++){
        try{return await press(key);}catch(error){
          // This exact Swift guard occurs before keyDown. A failure after
          // keyDown has different wording and must not replay the character.
          if(attempt>=2||error.message!=='The owned keyboard destination is not foreground.')throw error;
          await positionOwnedWindow();runtime.driver.actions.push({kind:'keyboard-recovery',pid:runtime.owner.pid,key,beforeInput:true});
        }
      }
    };
    let serial=0;
    const observe=async(query='')=>{
      const folder=path.resolve('.browse/sessions',`mission-control-native-${runtime.nonce}`);let frame;
      try{await runtime.driver.pointerTarget({x:1,y:1,width:2,height:2});}catch{await positionOwnedWindow();}
      try{frame=await runtime.frame('jira-observe-'+(++serial));}catch(error){
        const response=await runtime.driver.bridge('screenshot',path.join(folder,'capture-diagnostic.png'));
        await fs.writeFile(path.join(folder,'capture-diagnostic.json'),JSON.stringify({response,state:await runtime.driver.bridge('state')},null,2));throw error;
      }
      const observation=await runtime.driver.ocr(path.resolve(frame.path),query);await fs.writeFile(path.join(folder,'last-ocr.json'),JSON.stringify({query,...observation},null,2));return observation;
    };
    const text=(query,predicate=(n,o)=>!/^[A-Z]+-[0-9]+$/.test(query)||n.frame.y>170&&n.frame.y<o.window.height-40&&n.frame.x<o.window.width-280)=>until(async()=>{const observation=await observe(query),matches=observation.matches.filter(n=>n.confidence>=0.6&&predicate(n,observation));return matches.length===1?{observation,node:matches[0]}:null;},'visible unique Jira text '+query);
    const click=async(query,predicate)=>{const {observation,node}=await text(query,predicate);await runtime.driver.clickObservedText(observation,node);};
    const has=async query=>{
      const observation=await observe(query);
      return /^[A-Z]+-[0-9]+$/.test(query)?observation.matches.some(n=>n.confidence>=0.6&&n.frame.y>170&&n.frame.y<observation.window.height-40&&n.frame.x<observation.window.width-280):observation.lines.some(n=>n.text.includes(query));
    };
    const state=async()=>(await runtime.shared())[UI];
    const journal=async()=>{try{return Object.values(JSON.parse(await fs.readFile(path.join(home,'mission-control/launches.json'),'utf8')).requests);}catch{return [];}};
    const complete=count=>until(async()=>{const records=(await journal()).filter(r=>r.state==='complete');return records.length===count?records:null;},'completed Jira native launches '+count);
    const search=async value=>{
      const {observation,node}=await text(value? 'Search issues':(await state())?.query||'Search issues',n=>n.frame.y<125&&n.frame.x>150);
      await runtime.driver.clickObservedText(observation,node);await runtime.driver.press('cmd-a');await runtime.driver.press('backspace');
      for(const character of value)await runtime.driver.press(character);
      await until(async()=>(await state())?.query===value,'native Jira query '+value);
    };
    const filter=async(title,key)=>{await click(title,n=>n.frame.y>125&&n.frame.y<170);await until(async()=>(await state())?.status===key,'native issue status '+key);};
    const launchIcon=async(issueKey,index)=>{
      const {observation,node}=await text(issueKey,(n,observation)=>n.frame.y>170&&n.frame.y<observation.window.height-40&&n.frame.x<observation.window.width-280);
      // The card key is 10px below its top. The action bar follows its
      // 36px title; geometry is anchored in this actual rendered key.
      const boardWidth=observation.window.width-280,padding=boardWidth<768?10:14,columnWidth=boardWidth<768?Math.min(460,boardWidth-2*padding):Math.min(360,(boardWidth-2*padding-24)/3),columnLeft=node.frame.x-11;
      await runtime.driver.click({x:columnLeft+columnWidth-10-106+index*27,y:node.frame.y-1+14+7+36+7+1,width:25,height:25},{expectedSize:observation.window});
      Object.assign(runtime.driver.actions.at(-1),{control:index===3?'Launch options '+issueKey:'Start '+issueKey+' with '+['claude','codex','grok'][index],observation:observation.source});
    };
    const toolbarIcon=async name=>{
      const {observation,node}=await text('Search issues',n=>n.frame.x>150&&n.frame.y<180),boardWidth=observation.window.width-280;
      await runtime.driver.click({x:boardWidth-(name==='refresh'?73:42),y:node.frame.y+node.frame.height/2-14,width:28,height:28},{expectedSize:observation.window});
      Object.assign(runtime.driver.actions.at(-1),{control:name==='refresh'?'Refresh issues':'Integration settings',observation:observation.source});
    };
    const closeOverlay=async()=>{await runtime.driver.press('escape');await until(()=>!runtime.app(['status']).overlays.length,'closed Jira overlay');};
    const writeConfig=async mutate=>{const value=JSON.parse(await fs.readFile(configFile,'utf8'));mutate(value);value.revision++;await fs.writeFile(configFile,JSON.stringify(value));return value;};
    const field=async(title,value,{multiline=false}={})=>{
      let target;
      for(let n=0;n<10;n++){
        const observation=await observe(title),matches=observation.matches.filter(node=>node.confidence>=0.6&&node.frame.y>50&&node.frame.y<observation.window.height-100);
        if(matches.length===1){target={observation,node:matches[0]};break;}
        await runtime.driver.scroll({x:observation.window.width/2+230,y:observation.window.height/2,width:8,height:8},-350,{expectedSize:observation.window});
      }
      if(!target)throw Error('Editable setup field is not visible: '+title);const {observation,node}=target;
      await runtime.driver.click({x:node.frame.x+20,y:node.frame.y+node.frame.height+10,width:150,height:20},{expectedSize:observation.window});await runtime.driver.press('cmd-a');await runtime.driver.press('backspace');
      if(value){await runtime.driver.bridge('type',value);runtime.driver.actions.push({kind:'native-text',pid:runtime.owner.pid,control:title,characters:value.length,multiline,observation:observation.source});}
    };
    const scrollSetupTop=async()=>{const observation=await observe();await runtime.driver.scroll({x:observation.window.width/2+230,y:observation.window.height/2,width:8,height:8},1500,{expectedSize:observation.window});};
    await text('WEB-142');await text('WEB-156');await text('WEB-168');
    runtime.app(['do','space.rename',JSON.stringify({id:runtime.spaceId,name:'client-portal'})]);
    const b=runtime.app(['do','space.new',JSON.stringify({name:'billing-service',folder:other,argv:[programs.codex.run[0]]})]);
    await text('OPS-142');runtime.app(['do','space.select',JSON.stringify({id:runtime.spaceId})]);await text('WEB-142');
    runtime.expect(await has('To do')&&await has('In progress')&&await has('Done'),'Actual Jira board displays all three source workflow groups');
    let observed=await observe('Jira');runtime.expect(observed.matches.filter(n=>n.confidence>=0.6).length===1,'Native panel has only one Jira heading');
    await text('Fix login redirect');runtime.expect(await has('Improve account settings'),'Actual compact issue cards render their task titles');
    runtime.expect(!observed.lines.some(n=>['QA claude','QA codex','QA grok','Actions'].includes(n.text)),'Cards use tool icons without repeated tool-name or Actions labels');
    runtime.expect(work.requests.some(r=>r.path.startsWith('/rest/api/3/search/jql')&&r.hasAuthorization),'Standalone Node helper reads the selected account through owned HTTPS');
    await filter('Done','done');runtime.expect(!(await has('WEB-142'))&&await has('WEB-168'),'Mounted Done filter hides To-do cards');
    await filter('All','all');await search('settings');runtime.expect(await has('WEB-156')&&!(await has('WEB-142')),'Native retained text input filters issue titles');
    await filter('To do','todo');runtime.expect(await has('No matching issues'),'Native text and status filters compose');
    await filter('All','all');await search('');await text('WEB-142');
    console.log('Jira native: workflow groups, visible titles and composed filters pass.');
    await launchIcon('WEB-142',0);const first=(await complete(1))[0];
    runtime.expect(first.request.source.id==='10001'&&first.request.source.key==='WEB-142','Mounted Claude shortcut separates stable Jira REST ID from its display key');
    runtime.expect(path.basename(first.folder)==='client-portal-WEB-142'&&runtime.hc(['get',first.ack.terminal,'--json']).cwd===first.folder,'One-click saved default creates the real workspace-plus-issue Git worktree');
    const before=runtime.hc(['ls','--json']).terminals.length;await text('WEB-142');await launchIcon('WEB-142',0);await delay(500);
    runtime.expect(runtime.hc(['ls','--json']).terminals.length===before&&(await complete(1)).length===1,'Native repeat shortcut focuses existing work without a duplicate terminal');
    await launchIcon('WEB-142',1);await text('another tool');runtime.expect(runtime.hc(['ls','--json']).terminals.length===before,'Conflicting Codex shortcut does not create duplicate work');
    await click('All spaces',n=>n.frame.y<160);await until(async()=>(await state())?.all===true,'native All-spaces scope');await text('OPS-142');
    runtime.expect(await has('WEB-142')&&await has('OPS-142'),'All spaces displays separate sites and project bindings');
    runtime.expect(personal.requests.some(r=>r.path.startsWith('/rest/api/3/search/jql')&&r.hasAuthorization),'Second site uses its own selected credential profile');
    await launchIcon('OPS-142',1);const second=(await complete(2)).find(r=>r.request.source.key==='OPS-142');
    runtime.expect(second.request.spaceId===b.space&&second.request.repoRoot===other&&second.request.source.connectionId==='personal','All-spaces Codex shortcut stays on its clicked site/account/repository while another space is active');
    runtime.expect(runtime.hc(['get',second.ack.terminal,'--json']).cwd===second.folder&&path.basename(second.folder)==='billing-service-OPS-142','Native Codex action starts in the captured repository worktree');
    await launchIcon('WEB-156',2);const third=(await complete(3)).find(r=>r.request.source.key==='WEB-156');
    runtime.expect(third.request.toolKey==='grok'&&third.request.repoRoot===runtime.repo,'Third pinned icon starts Grok directly in the clicked issue repository');
    console.log('Jira native: three pinned tool starts, real worktrees, repeat safety and All-spaces routing pass.');

    await launchIcon('WEB-168',3);await text('New agent');runtime.expect(runtime.app(['status']).overlays.includes(MOD),'Options opens the Jira mod’s own launch dialog');await closeOverlay();
    runtime.app(['do','space.select',JSON.stringify({id:runtime.spaceId})]);await click('This space',n=>n.frame.y<160);await until(async()=>(await state())?.all===false,'native current-space scope');await text('WEB-142');
    let observation=await observe();await runtime.driver.click({x:observation.window.width-280-40,y:47,width:28,height:28},{expectedSize:observation.window});
    Object.assign(runtime.driver.actions.at(-1),{control:'Agent shortcuts',observation:observation.source});await text('Agent shortcuts');
    const toolRow=await text('QA grok'),left=(toolRow.observation.window.width-560)/2;
    // Grok has Pin, Earlier and Hide controls: three28px icons with9px
    // gaps and26px total right inset. Select Pin rather than Earlier.
    await runtime.driver.click({x:left+560-128,y:toolRow.node.frame.y+toolRow.node.frame.height/2-14,width:28,height:28},{expectedSize:toolRow.observation.window});
    Object.assign(runtime.driver.actions.at(-1),{control:'Unpin Grok',observation:toolRow.observation.source});await click('Save shortcuts');
    await until(async()=>JSON.stringify(JSON.parse(await fs.readFile(configFile,'utf8')).preferences.launch.pins)==='["claude","codex"]','native shortcut preference save');
    runtime.expect(JSON.parse(await fs.readFile(configFile,'utf8')).preferences.launch.pins.length===2,'Actual shortcut settings persist the changed pinned-tool list');await closeOverlay();
    // Refresh is a real mounted action and also reloads preferences saved by
    // the same-mod dialog. No settings file is written to assert this step.
    await toolbarIcon('refresh');await text('WEB-142');

    flags.workError=true;await toolbarIcon('refresh');await text('credentials are unavailable');
    runtime.expect(await has('WEB-142')&&await has('Cached'),'Same-scope API failure retains timestamped real cards and reports cached data');
    flags.workError=false;await toolbarIcon('refresh');await text('Updated just now');
    const mapping={issuesPath:'issues',fields:{id:'id',key:'key',title:'title',status:'status',body:'body'},statusGroups:{todo:['To do'],inProgress:['In progress'],done:['Done']}};
    await writeConfig(value=>{value.connections.work={id:'work',kind:'cli',site:work.origin,execution:{machine:null,command:path.join(runtime.directory,'missing-jira-cli'),argsTemplate:['{{request}}']},mapping};});
    await toolbarIcon('refresh');await text('CLI is not installed locally');runtime.expect(!(await has('WEB-142')),'Changing to an unavailable CLI profile clears old API cards');
    await writeConfig(value=>{value.connections.work={id:'work',kind:'mcp-http',site:work.origin,url:personal.origin+'/mcp',search:{tool:'missing_search_tool',argsTemplate:{jql:'{{jql}}',maxResults:'{{pageSize}}',cloudId:CLOUD},resultMapping:mapping}};});
    await toolbarIcon('refresh');await text('search tool is missing');runtime.expect(!(await has('WEB-142')),'Missing MCP capability is explicit and cannot display another adapter’s cards');
    await writeConfig(value=>{value.connections.work=config.connections.work;value.preferences.launch=config.preferences.launch;});await toolbarIcon('refresh');await text('WEB-142');
    console.log('Jira native: same-mod options/settings and API/CLI/MCP error isolation pass.');

    await toolbarIcon('settings');await text('Jira connection');await click('Duplicate profile');
    await field('Profile ID','jira-native-api');await field('Cloud ID (scoped tokens / service accounts)','invalidcloud');
    const beforeInvalid=await fs.readFile(configFile,'utf8');await click('Save connection');await text('Check the selected Jira adapter');
    runtime.expect(await fs.readFile(configFile,'utf8')===beforeInvalid,'Native invalid cloud-ID form preserves the previous configuration');
    await scrollSetupTop();await click('MCP HTTPS');await click('Email + token');await field('Canonical Jira base URL',personal.origin);await field('HTTPS MCP endpoint',personal.origin+'/mcp');
    await field('Email environment variable','QA_PERSONAL_EMAIL');await field('Token environment variable','QA_PERSONAL_TOKEN');
    await field('Read-only tool, arguments and result mapping',JSON.stringify({tool:'search_issues',argsTemplate:{jql:'{{jql}}',maxResults:'{{pageSize}}',cloudId:CLOUD},resultMapping:mapping}),{multiline:true});
    await click('Save connection');await until(()=>!runtime.app(['status']).overlays.length,'native MCP setup accepted after read-only probe');
    const saved=JSON.parse(await fs.readFile(configFile,'utf8')),newId=saved.bindings[bindingKey(null,runtime.repo)].jira.connectionId,newProfile=saved.connections[newId];
    runtime.expect(newProfile.kind==='mcp-http'&&newProfile.auth.kind==='basic'&&newProfile.auth.usernameEnv==='QA_PERSONAL_EMAIL'&&newProfile.auth.tokenEnv==='QA_PERSONAL_TOKEN','Mounted MCP Basic setup saves only selected environment-variable references');
    runtime.expect(newProfile.search.argsTemplate.cloudId===CLOUD,'Native multiline tool editor preserves an explicit literal cloudId');
    await text('MCP-142');runtime.expect(!(await has('WEB-142')),'Successful profile change replaces visible old-account cards');
    await writeConfig(value=>{value.connections=config.connections;value.bindings=config.bindings;value.preferences=config.preferences;});await toolbarIcon('refresh');await text('WEB-142');

    // A real link click opens only the owned fixture URL in the system browser.
    const url=work.origin+'/browse/WEB-168';await click('WEB-168');
    const browserScript=close=>['set found to false',...['Google Chrome','Safari'].flatMap(browser=>[`if application "${browser}" is running then`,`tell application "${browser}"`,`repeat with w in windows`,`repeat with t in tabs of w`,`if URL of t is ${JSON.stringify(url)} then`,`set found to true`,...(close?['close t']:[]),'end if','end repeat','end repeat','end tell','end if']),'return found'].join('\n');
    await until(()=>run('osascript',['-e',browserScript(false)],{json:false})==='true','actual system-browser Jira issue URL');
    runtime.expect(true,'Actual issue-key click opens its captured Jira URL in the system browser');run('osascript',['-e',browserScript(true)],{json:false});await runtime.driver.press('escape');
    await text('WEB-142');const nativeFrame=await runtime.frame('jira-preview');
    runtime.expect(runtime.app(['status']).errors.length===0,'No native mod errors across Jira workflows');
    runtime.expect((await fs.readdir(path.join(home,'mods'))).filter(name=>name.startsWith('mission-control-')).join(',')===MOD,'Only the standalone Jira custom mod is installed');
    await fs.copyFile(path.resolve(nativeFrame.path),path.resolve(MOD,'preview.png'));
  }catch(error){
    const folder=path.resolve('.browse/sessions',`mission-control-native-${runtime.nonce}`);await fs.mkdir(folder,{recursive:true});await fs.writeFile(path.join(folder,'fixture-requests.json'),JSON.stringify(services.map(s=>s.requests),null,2));
    await fs.writeFile(path.join(folder,'native-console.txt'),(runtime.appStdout||'')+'\n'+(runtime.appStderr||''));
    try{await fs.writeFile(path.join(folder,'failure-status.json'),JSON.stringify(runtime.app(['status']),null,2));await runtime.frame('jira-failure');}catch{}
    throw error;
  }finally{for(const service of services.reverse())await service.close();}
}
