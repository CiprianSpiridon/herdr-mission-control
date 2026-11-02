import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {buildPackage} from '../scripts/project.mjs';
import Agents from '../src/mods/mission-control-agents/main.js';
import {injectNative,context,trigger,findElement,Element,shared} from './support/native-recording.mjs';

function fixture(props={},{empty=false,discover=async()=>[]}={}){
  const effects=[],timers=[],pending=[],files=new Map(),root='/fixture/app';
  const source={v:1,enabled:true,machine:null,provider:'codex',providerRoot:'/profiles/.codex',credentialScope:'fixture',roots:['/profiles/.codex/sessions']};
  files.set(root+'/mission-control/config.json',JSON.stringify({v:1,revision:0,connections:{},bindings:{},preferences:{},usageSources:{local:source}}));
  const program={key:'codex',name:'Codex',icon:'icons/codex.png',tint:false},agents=empty?[]:[{address:'t1',space:'A',tab:'A-tab',title:'Fix login redirect',tab_name:'1',program,status:'working'},{address:'t2',space:'A',tab:'A-tab-2',title:'Review pull request',tab_name:'2',program,status:'blocked'}];
  const raws=agents.map((a,i)=>({address:a.address,created_ms:100+i,foreground:{pid:1000+i},state:'live'}));
  injectNative({props,appHome:root,home:'/fixture',agents,terminals:raws,machines:[{name:null,layout:'ready'}],spaces:[{id:'A',name:'client-portal',machine:null,tabs:[{id:'A-tab',name:'1',named:false},{id:'A-tab-2',name:'2',named:false}]}],knownAgents:discover,setAgentOrder:order=>effects.push(['order',order]),run:(...args)=>effects.push(['run',...args]),openOverlay:spec=>{effects.push(['overlay',spec]);return 'overlay-created';},closeOverlay:id=>effects.push(['close',id]),readTextFile:async path=>files.get(path)??null,writeTextFile:async(path,text,expected)=>{assert.equal(files.get(path)??null,expected);files.set(path,text);},exec:async(command,args)=>{effects.push(['exec',command,args]);if(command==='mkdir')return {code:0,stdout:''};assert.equal(command,'hc');return {code:0,stdout:JSON.stringify(args[0]==='ls'?{terminals:raws}:raws.find(r=>r.address===args[1]))};}});
  const cx=context();cx.timer.every=(ms,fn)=>{const timer={ms,fn,cancelled:false,cancel(){this.cancelled=true;}};timers.push(timer);return timer;};
  cx.spawn=fn=>{const task={done:false,cancelled:false,cancel(){this.cancelled=true;},is_done(){return this.done;}};const work=Promise.resolve().then(()=>fn(cx)).finally(()=>task.done=true);pending.push(work);return task;};
  const view=new Agents();view.init({view:'wrong-init-props'},cx);
  const flush=async()=>{for(let i=0;i<pending.length;i++)await pending[i];};
  return {view,cx,effects,timers,pending,files,source,agents,raws,flush,render:()=>view.render(cx)};
}
function texts(root){const result=[];const walk=node=>{if(typeof node==='string')result.push(node);else if(node instanceof Element)node.nodes.forEach(walk);};walk(root);return result;}
function artwork(root){const result=[];const walk=node=>{if(!(node instanceof Element))return;if(['svg','image'].includes(node.kind))result.push(node.value);node.nodes.forEach(walk);};walk(root);return result;}

test('compact rows use actual tool artwork, task names and two separate unavailable readings',async()=>{
  const f=fixture();await f.flush();const tree=f.render(),row=findElement(tree,'agent-t1'),text=texts(row);assert.ok(text.includes('Fix login redirect'));assert.ok(!text.includes('Codex'));assert.ok(text.includes('Context'));assert.ok(text.includes('Quota'));assert.equal(text.filter(v=>v==='Unavailable').length,2);assert.ok(artwork(row).includes('icons/codex.png'));
  trigger(tree,'agent-t1');assert.deepEqual(f.effects.at(-1),['run','agent.focus',{terminal:'t1'}]);assert.deepEqual(f.effects.findLast(e=>e[0]==='order')[1],['t2','t1']);f.view.close();
});
test('grouping buttons and collapse update only Agents state and keep native ordering usable',async()=>{
  const f=fixture();await f.flush();trigger(f.render(),'agents-spaces');assert.equal(shared('mission-control-agents-v1').mode,'spaces');assert.ok(texts(f.render()).includes('client-portal'));trigger(f.render(),'agents-priority');assert.equal(shared('mission-control-agents-v1').mode,'priority');trigger(f.render(),'agents-toggle');assert.throws(()=>findElement(f.render(),'agent-groups'),/found 0/);assert.equal(shared('mission-control-spaces-v1'),undefined);assert.deepEqual(f.effects.findLast(e=>e[0]==='order')[1],['t2','t1']);f.view.close();
});
test('reported estimates and shared quota remain subordinate to the task title',async()=>{
  const f=fixture();await f.flush();const session={machine:null,provider:'codex',providerRoot:f.source.providerRoot,credentialScope:'fixture',sessionId:'exact-thread'};
  f.view.telemetry.agentStates.set('t1',{session,sourceId:'local'});f.view.telemetry.observations.set('local',{live:[{state:'available',identity:session,provenance:{provider:'codex',format:'codex-rollout-jsonl',formatVersion:null,sourceDigest:'a'.repeat(64),observedAt:Date.now()},context:{usedTokens:40,windowTokens:100,compactionLimitTokens:null,reportedUsedPercent:null},quota:{proof:{kind:'session-report',machine:null,credentialScope:'fixture',accountId:null,poolId:null},windows:[{name:'primary',remainingPercent:25,observedAt:Date.now(),resetsAt:null}]}}],cache:[]});
  f.view.telemetry.publishReadings(f.agents);const values=texts(findElement(f.render(),'agent-t1'));assert.ok(values.includes('~60%'));assert.ok(values.includes('25%'));assert.ok(values.indexOf('Fix login redirect')<values.indexOf('Context'));f.view.close();
});
test('usage-source gear opens this mod and native source forms preserve captured paths',async()=>{
  const f=fixture();await f.flush();trigger(f.render(),'agents-sources');assert.equal(f.effects.at(-1)[1].mod,'mission-control-agents');assert.equal(f.effects.at(-1)[1].props.view,'sources');f.view.close();
  const settings=fixture({view:'sources',overlay:'sources'});await settings.flush();trigger(settings.render(),'source-edit-local');const opened=settings.effects.at(-1)[1];assert.equal(opened.props.view,'source-form');assert.equal(opened.props.source.machine,null);assert.equal(opened.props.source.roots[0],'/profiles/.codex/sessions');trigger(settings.render(),'source-toggle-local','on_click',{},settings.cx);await settings.flush();assert.equal(JSON.parse(settings.files.get('/fixture/app/mission-control/config.json')).usageSources.local.enabled,false);settings.view.close();
});
test('source form saves explicit root changes, rejects broad roots and cannot crash from missing props',async()=>{
  const source={v:1,enabled:true,machine:null,provider:'codex',providerRoot:'/profiles/.codex',credentialScope:'fixture',roots:['/profiles/.codex/sessions']};
  const f=fixture({view:'source-form',sourceId:'local',source,overlay:'form'});await f.flush();f.view.rootInputs[0].set_value('/profiles/.codex/extra-sessions');trigger(f.render(),'save-usage-source','on_click',{},f.cx);await f.flush();assert.equal(JSON.parse(f.files.get('/fixture/app/mission-control/config.json')).usageSources.local.roots[0],'/profiles/.codex/extra-sessions');assert.ok(f.effects.some(e=>e[0]==='close'&&e[1]==='form'));f.view.close();
  const bad=fixture({view:'source-form',sourceId:'local',source});await bad.flush();bad.view.rootInputs[0].set_value('/Users');trigger(bad.render(),'save-usage-source','on_click',{},bad.cx);await bad.flush();assert.ok(bad.view.error);assert.equal(JSON.parse(bad.files.get('/fixture/app/mission-control/config.json')).usageSources.local.roots[0],source.roots[0]);bad.view.close();
  const absent=fixture({view:'source-form'});assert.ok(texts(absent.render()).includes('Usage source unavailable'));absent.view.close();
});
test('empty lists remain usable and close cancels timers/tasks without retaining callbacks',async()=>{
  const f=fixture({}, {empty:true});await f.flush();assert.ok(texts(f.render()).includes('No agents running.'));assert.ok(findElement(f.render(),'agents-sources'));const before=f.cx.notifications;f.view.close();assert.ok(f.timers.every(t=>t.cancelled));for(const timer of f.timers)timer.fn(f.cx);await f.flush();assert.equal(f.cx.notifications,before);assert.equal(f.view.telemetry.observations.size,0);
});
test('the actual package contains the exact collector that passed installed-provider compatibility',async()=>{
  const built=await buildPackage('mission-control-agents'),receipt=JSON.parse(await fs.readFile('evidence/native/provider-compatibility.json','utf8')),bytes=await fs.readFile(built.directory+'/collector.py');assert.equal(receipt.status,'PASS');assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),receipt.collectorSourceSha256);assert.equal(bytes.length,receipt.collectorBytes);
  for(const name of ['collector.py','provider_codex.py','provider_claude.py','provider_grok.py'])assert.ok(built.manifest.sources['src/shared/'+name]);
  for(const[name,hash]of Object.entries(receipt.helperSourceSha256))assert.equal(built.manifest.sources['src/shared/'+name],hash,'Verified helper '+name+' must match the package source');
  assert.equal(JSON.parse(await fs.readFile(built.directory+'/mod.json','utf8')).build,undefined);
});
test('configured readings and source settings load while tool discovery is pending',async()=>{
  for(const props of [{},{view:'sources'}]){
    let release;const gate=new Promise(resolve=>release=resolve),f=fixture(props,{discover:()=>gate});
    await f.pending[0];assert.equal(f.view.busy,false);assert.ok(f.view.telemetry.sources.enabled().length);assert.equal(f.view.loading??false,false);
    if(!props.view)assert.ok(f.effects.some(e=>e[0]==='exec'&&e[1]==='hc'&&e[2][0]==='ls'));
    f.view.close();release([]);await f.flush();
  }
});
