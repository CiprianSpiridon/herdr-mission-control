import fs from 'node:fs/promises';
import sync from 'node:fs';
import path from 'node:path';
import {run,until} from '../../scripts/native-harness.mjs';
import {flattenTree} from '../../scripts/native-driver.mjs';
import {BindingStore} from '../../src/shared/session-bindings.js';
import {terminalIdentity} from '../../src/shared/session-identity.js';
import {createLaunchIO,launch} from '../../src/shared/launch.js';

const MOD='mission-control-agent-menu';
export default async function agentMenu(runtime){
  const home=runtime.env.HERDR_APP_HOME,tool=path.join(runtime.directory,'qa-claude'),providerRoot=path.join(runtime.directory,'provider-fixture/.claude');
  await fs.mkdir(providerRoot+'/projects',{recursive:true});
  await fs.writeFile(tool,`#!/usr/bin/env python3
import sys,time,json,uuid
if '--help' in sys.argv:
 print('Claude Code QA fixture\\nUsage: claude [options] [prompt]\\n --model <model>\\n --session-id <uuid>\\n --resume [value]');sys.exit(0)
if '--version' in sys.argv: print('QA fixture 1.0');sys.exit(0)
print('Mission Control disposable fixture agent; no provider request is made.',flush=True)
time.sleep(3600)
`);
  await fs.chmod(tool,0o700);
  await fs.writeFile(path.join(home,'programs.json'),JSON.stringify({programs:{claude:{name:'QA Claude fixture',run:[tool]}}})+'\n');
  await fs.mkdir(path.join(home,'mission-control'),{recursive:true});
  const configFile=path.join(home,'mission-control/config.json');
  await fs.writeFile(configFile,JSON.stringify({v:1,revision:0,connections:{},bindings:{},preferences:{launch:{v:1,pins:['claude'],hidden:[],worktree:false,tools:{}}},usageSources:{qa:{v:1,machine:null,provider:'claude',enabled:true,providerRoot,roots:[providerRoot+'/projects'],credentialScope:'qa-fixture'}}})+'\n');
  await runtime.installPackage(MOD);
  const block=(id,mod,size,props)=>({id,type:'block',...(size?{size:{px:size}}:{}),content:{mod,...(props?{props}:{})}});
  const stock={id:'qa-root',type:'row',titlebar:'none',traffic_lights:[12,16],background:'canvas',children:[
    {id:'sidebar',type:'column',size:{px:268},background:'chrome',children:[block('brand','workspace-chrome',46),block('spaces','spaces',240),block('agents','agents'),block('sidebar-footer','workspace-chrome',69,{footer:true})]},
    {id:'work',type:'column',children:[block('tabs','tabs',42),{id:'main',type:'block',content:{tab:'active',pane:{gap:8,radius:8,border:{width:1,color:'border'},header:{content:{mod:'pane'},height:30,position:'top',reveal:'always'}}}},block('status','workspace-status',28)]}
  ]};
  await runtime.startWindow({layout:stock,name:'agent-menu-native'});
  await runtime.driver.enableAccessibility();
  const linked=path.join(runtime.directory,'linked-checkout');
  run('git',['-C',runtime.repo,'worktree','add','-b','qa-linked',linked,'HEAD'],{env:runtime.env,json:false});
  runtime.setupCommands=[{command:'git worktree add',ownedFixture:true},{command:'tab.new',purpose:'Focus live linked checkout while original space folder stays canonical'}];
  const setup=runtime.app(['do','tab.new',JSON.stringify({space:runtime.spaceId,folder:linked,name:'Linked checkout fixture',argv:[tool]})]);
  await until(()=>runtime.hc(['get',setup.terminal,'--json']).foreground?.pid,'fixture foreground process');
  runtime.app(['do','pane.focus',JSON.stringify({terminal:setup.terminal})]);
  const {frame:initialFrame}=await runtime.driver.pointerTarget({x:1,y:1,width:2,height:2});
  await runtime.driver.click({x:initialFrame.width*0.65,y:initialFrame.height*0.5,width:4,height:4},{expectedSize:initialFrame});
  await runtime.frame('linked-checkout-focused');
  const appStatus=()=>runtime.app(['status']);
  const tree=()=>runtime.driver.tree();
  let observationNumber=0;
  const observe=async(query='')=>{const frame=await runtime.frame('observed-'+(++observationNumber));return runtime.driver.ocr(path.resolve(frame.path),query);};
  const nodes=async()=>{
    const ax=flattenTree(await tree());if(ax.some(n=>n.label==='QA Claude fixture'))return ax;
    const observation=await observe();return [...ax,...observation.lines.map(n=>({...n,label:n.text,role:'OCRText'}))];
  };
  const button=async(label,where=()=>true)=>until(async()=>{
    const ax=flattenTree(await tree()).filter(n=>n.role==='AXButton'&&n.label===label&&n.enabled&&where(n));if(ax.length===1)return ax[0];
    const observation=await observe(label),left=(observation.window.width-560)/2,top=(observation.window.height-660)/2;
    const matches=observation.matches.filter(n=>n.confidence>=0.6&&n.frame.x>=left&&n.frame.y>=top&&n.frame.x+n.frame.width<=left+560&&n.frame.y+n.frame.height<=top+660&&where(n));
    return matches.length===1?{...matches[0],observedNode:matches[0],observation,role:'OCRControl'}:null;
  },'unique native button '+label);
  const click=async(label,where)=>{
    if(['Agent shortcuts','Close','Pin shortcut','Unpin shortcut'].includes(label)){
      const observation=await observe();
      runtime.expect(observation.lines.some(n=>['Start working','Agent shortcuts','New agent','Repository unavailable'].includes(n.text)),'Observed actual mounted dialog before icon-only '+label);
      const {width,height}=observation.window,left=(width-560)/2,top=(height-660)/2;
      let rectangle;
      if(label==='Agent shortcuts')rectangle={x:left+560-18-64,y:top+18,width:28,height:28};
      else if(label==='Close')rectangle={x:left+560-46,y:top+18,width:28,height:28};
      else {const row=await button('QA Claude fixture');rectangle={x:left+560-91,y:row.frame.y+row.frame.height/2-14,width:28,height:28};}
      await runtime.driver.click(rectangle,{expectedSize:observation.window});Object.assign(runtime.driver.actions.at(-1),{control:label,observation:observation.source});return;
    }
    const node=await button(label,where);
    if(node.role==='OCRControl')await runtime.driver.clickObservedText(node.observation,node.observedNode);
    else if(node.actions?.includes('AXPress'))await runtime.driver.action(node);
    else if(node.frame)await runtime.driver.click(node.frame,{coordinateSpace:'screen'});
    else throw Error('The inspected native control has no actionable geometry: '+label);
  };
  const read=async name=>JSON.parse(await fs.readFile(path.join(home,'mission-control',name+'.json'),'utf8'));
  const complete=async count=>until(async()=>{const data=await read('launches');const done=Object.values(data.requests).filter(r=>r.state==='complete');return done.length===count?done:null;},'acknowledged complete launches '+count);
  const open=async()=>{runtime.app(['do','mod.open',JSON.stringify({name:MOD})]);await button('QA Claude fixture');};
  const choose=async()=>{await click('QA Claude fixture');await button('Start agent');};
  const nativeStart=async({worktree,count})=>{
    await open();await choose();await click(worktree?'New worktree':'Current checkout');
    const before=runtime.hc(['ls','--json']).terminals.length;await click('Start agent');
    const records=await complete(count),record=records.at(-1),raw=runtime.hc(['get',record.ack.terminal,'--json']);
    runtime.expect(runtime.hc(['ls','--json']).terminals.length===before+1,'Native launch creates exactly one terminal');
    runtime.expect(raw.labels['herdr.tab']===record.ack.tab,'Core terminal belongs to the acknowledged tab');
    runtime.expect(raw.cwd===record.folder,'Actual core cwd matches the captured execution folder');
    return record;
  };
  try{
    await open();await runtime.frame('agent-menu-open');
    const diagnostic=path.resolve('.browse/sessions',`mission-control-native-${runtime.nonce}`,'agent-menu-ax.json');await fs.writeFile(diagnostic,JSON.stringify(await tree(),null,2));
    await runtime.driver.press('1');await button('Start agent');
    runtime.expect((await nodes()).some(n=>n.label==='New agent'),'Popup-scoped number shortcut selects the installed fixture agent');
    await click('Back');
    // Settings are changed through actual mounted controls, not edited as setup.
    await click('Agent shortcuts');const row=await button('QA Claude fixture');
    const withinRow=n=>n.frame&&row.frame&&n.frame.y>=row.frame.y&&n.frame.y+n.frame.height<=row.frame.y+row.frame.height+1;
    await click('Unpin shortcut',withinRow);await click('Pin shortcut',withinRow);await click('Save shortcuts');
    await until(async()=>JSON.stringify((await read('config')).preferences.launch.pins)==='["claude"]','native shortcut save');
    runtime.expect((await read('config')).preferences.launch.pins[0]==='claude','Mounted shortcut pin/save persists');
    await click('Back');await choose();
    runtime.expect(!(await nodes()).some(n=>n.label==='Reasoning'),'Unsupported reasoning capability is absent from native controls');
    await runtime.frame('agent-menu-launch');
    // Preserve this captured intent while the underlying active space changes.
    const other=await runtime.createRepo('other-repo');
    const elsewhere=runtime.app(['do','space.new',JSON.stringify({name:'Elsewhere fixture',folder:other,argv:[tool]})]);
    await click('Current checkout');await click('Start agent');
    const first=(await complete(1))[0];
    runtime.expect(first.request.repoRoot===runtime.repo&&first.request.checkoutRoot===linked&&first.folder===linked,'Native dialog retains canonical identity and live linked checkout across active-space change');
    const firstRaw=runtime.hc(['get',first.ack.terminal,'--json']);
    runtime.expect(firstRaw.cwd===linked,'Current-checkout launch actually runs in the linked worktree');
    const beforeClosedShortcut=runtime.hc(['ls','--json']).terminals.length;await runtime.driver.press('1');
    runtime.expect(runtime.hc(['ls','--json']).terminals.length===beforeClosedShortcut,'Closed popup no longer captures its agent number shortcut');
    const readIO={appHome:()=>home,readTextFile:async file=>{try{return await fs.readFile(file,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}}};
    const fresh=new BindingStore(readIO),bound=await fresh.readCommitted(terminalIdentity(firstRaw,null));
    runtime.expect(bound?.session?.sessionId===first.sessionProposal?.sessionId&&Boolean(bound?.session?.sessionId),'Fresh telemetry-side consumer reads the actual committed exact session mapping');
    // A service-level retry uses the same source against the actual isolated app/core.
    // This is separate from the preceding user-like native input evidence.
    const nativeIO=createLaunchIO({...readIO,exec:async(cmd,args,options={})=>{
      if(options.on)throw Error('Unexpected remote QA host');
      const result=run(cmd,args,{env:runtime.env,json:false});return {code:0,stdout:result};
    },knownAgents:async()=>[{key:'claude',name:'QA Claude fixture',run:[tool],installed:true}],spaces:()=>runtime.app(['ls']).spaces,run:(name,args)=>runtime.app(['do',name,JSON.stringify(args)])});
    nativeIO.writeTextFile=async(file,text,expected)=>{let raw=null;try{raw=sync.readFileSync(file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}if(raw!==expected)throw Object.assign(Error('stale'),{code:'STALE'});sync.writeFileSync(file,text);};
    const beforeRetry=runtime.hc(['ls','--json']).terminals.length,retry=await launch(first.request,nativeIO);
    runtime.expect(retry.ok&&retry.reused&&retry.tabId===first.ack.tab&&runtime.hc(['ls','--json']).terminals.length===beforeRetry,'Exact same-intent real-core retry focuses without creating a duplicate');
    runtime.app(['do','space.select',JSON.stringify({id:runtime.spaceId})]);
    const second=await nativeStart({worktree:true,count:2});
    // Re-select the same initial linked checkout for another independent intent.
    runtime.app(['do','tab.select',JSON.stringify({id:setup.tab})]);
    runtime.app(['do','pane.focus',JSON.stringify({terminal:setup.terminal})]);
    const third=await nativeStart({worktree:true,count:3});
    runtime.expect(second.folder!==third.folder&&second.worktreeSpec.branch!==third.worktreeSpec.branch,'Two native generic new-worktree intents produce distinct stable paths/branches');
    runtime.expect(second.folder.includes('-task-')&&third.folder.includes('-task-'),'Native generic worktree naming includes deterministic request suffixes');
    const nonRepo=path.join(runtime.directory,'not-a-repository');await fs.mkdir(nonRepo);
    runtime.app(['do','space.new',JSON.stringify({name:'Unbound fixture',folder:nonRepo,argv:[tool]})]);
    const beforeUnbound=runtime.hc(['ls','--json']).terminals.length;runtime.app(['do','mod.open',JSON.stringify({name:MOD})]);
    await until(async()=>(await nodes()).some(n=>n.label==='Repository unavailable'),'native unbound repository state');
    runtime.expect(!(await nodes()).some(n=>n.label==='Start agent')&&runtime.hc(['ls','--json']).terminals.length===beforeUnbound,'Unbound target has no start control or creation side effects');await click('Close');
    // Two unfocused live repositories in one captured space are ambiguous.
    const ambiguous=runtime.app(['do','space.new',JSON.stringify({name:'Ambiguous fixture',folder:runtime.repo,argv:[tool]})]);
    const ambiguousSecond=runtime.app(['do','tab.new',JSON.stringify({space:ambiguous.space,folder:other,argv:[tool]})]);
    await until(()=>runtime.hc(['get',ambiguous.terminal,'--json']).foreground?.pid&&runtime.hc(['get',ambiguousSecond.terminal,'--json']).foreground?.pid,'both ambiguous fixture processes and live terminal data');
    // Establish the other active space before mounting a captured-space pane;
    // tab.new can initialize its view before its own selection transition.
    runtime.app(['do','space.select',JSON.stringify({id:elsewhere.space})]);
    runtime.app(['do','tab.select',JSON.stringify({id:elsewhere.tab})]);
    runtime.app(['do','pane.focus',JSON.stringify({terminal:elsewhere.terminal})]);
    const {frame:elsewhereFrame}=await runtime.driver.pointerTarget({x:1,y:1,width:2,height:2});
    await runtime.driver.click({x:elsewhereFrame.width*0.65,y:elsewhereFrame.height*0.5,width:4,height:4},{expectedSize:elsewhereFrame});
    await runtime.frame('elsewhere-focused-before-capture');
    const beforeAmbiguous=runtime.hc(['ls','--json']).terminals.length;
    const modTab=runtime.app(['do','tab.new',JSON.stringify({space:elsewhere.space,mod:MOD,props:{view:'launch',spaceId:ambiguous.space,machine:null}})]);
    await until(async()=>(await nodes()).some(n=>String(n.label).includes('Focus a terminal to choose')),'native ambiguous captured-space state');
    runtime.expect(!(await nodes()).some(n=>n.label==='Start agent')&&runtime.hc(['ls','--json']).terminals.length===beforeAmbiguous,'Ambiguous target cannot create a terminal or worktree');
    runtime.app(['do','tab.close',JSON.stringify({id:modTab.tab,confirmed:true})]);
    runtime.app(['do','space.select',JSON.stringify({id:runtime.spaceId})]);runtime.app(['do','tab.select',JSON.stringify({id:setup.tab})]);
    await open();await choose();
    runtime.expect(appStatus().errors.length===0,'No native package errors after all interactions');
    const preview=await runtime.frame('agent-menu-preview');
    await fs.copyFile(path.resolve(preview.path),path.resolve(MOD,'preview.png'));
    runtime.expect((await fs.readdir(path.join(home,'mods'))).filter(n=>n.startsWith('mission-control-')).join(',')===MOD,'Only this custom standalone mod was installed');
  }catch(error){
    try{await runtime.frame('agent-menu-failure');const folder=path.resolve('.browse/sessions',`mission-control-native-${runtime.nonce}`);await runtime.driver.bridge('screenshot',path.join(folder,'window-server-failure.png'));await fs.writeFile(path.join(folder,'failure-ax.json'),JSON.stringify(await tree(),null,2));await fs.writeFile(path.join(folder,'native-console.txt'),(runtime.appStdout||'')+'\n'+(runtime.appStderr||''));}catch{}
    throw error;
  }
}
