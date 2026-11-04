import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import sync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Tabs,{MOD,COMMANDS} from '../src/mods/mission-control-tabs/main.js';
import {SOURCES_STATE,hiddenSources,setSourceShown,NAV_STATE,NODES,SOURCES,SOURCE_IDS,LAYOUT_PAIR,NAV_METRICS,NAV_TIMING,findNode,layoutContract,sourceState,scopeOf,readNavState,selectSource,swapView,togglePanel,restoreView,navigationMode,navigationWidth,navigationMinWidth}
  from '../src/mods/mission-control-tabs/navigation.js';
// The recorder's shared store is module state; setShared/shared are its public accessors.
import {injectNative,context,trigger,findElement,Element,setShared as sharedSet,shared as sharedGet} from './support/native-recording.mjs';

const root=new URL('../',import.meta.url).pathname;
const ZSH={key:'shell',name:'zsh',icon:'icons/shell.svg',tint:true,shell:true,agent:false};
const ok=stdout=>({code:0,stdout,stderr:''});
const topbar=props=>({id:'mc-topbar',type:'block',size:{px:36},window_drag:true,content:{mod:MOD,props}});
const nav=()=>({id:'mc-navigation',type:'block',size:{px:34},content:{mod:MOD,props:{view:'navigation'}}});
const stack=(active='jira',ids=SOURCE_IDS)=>({id:NODES.stack,type:'stack',active,children:SOURCES.filter(s=>ids.includes(s.id)).map(s=>({id:s.id,type:'block',content:{mod:s.mod,props:s.props}}))});
const rail=()=>({id:'sidebar',type:'column',size:{px:220},children:[{id:'spaces',type:'block',content:{mod:'mission-control-spaces'}}]});
/** The two trees TASK-006 composes from this contract (the overview, and Classic with its hidden side panel). */
const overview=(active='jira',ids)=>({id:'root',type:'column',titlebar:'none',traffic_lights:[14,14],children:[topbar({view:'topbar',swapTo:'mission-control-classic'}),{id:'body',type:'row',children:[rail(),{id:NODES.main,type:'column',children:[nav(),stack(active,ids)]}]}]});
const classic=(active='jira',hidden=true)=>({id:'root',type:'column',titlebar:'none',traffic_lights:[14,14],children:[topbar({view:'topbar',swapTo:'mission-control',panel:true}),{id:'body',type:'row',children:[rail(),
  {id:NODES.main,type:'row',children:[{id:'terminals',type:'block',content:{tab:'active'}},{id:NODES.panel,type:'column',hidden,size:{px:360},children:[nav(),stack(active)]}]}]}]});
const vanilla=()=>({id:'root',type:'row',children:[rail(),{id:'work',type:'column',children:[{id:'tabs',type:'block',size:{px:30},content:{mod:MOD}},{id:'main',type:'block',content:{tab:'active'}}]}]});
const NAMES=['main','mission-control','mission-control-classic'];

function walk(node,fn){if(node instanceof Element){fn(node);node.nodes.forEach(c=>walk(c,fn));}}
const calls=(el,method)=>el.calls.filter(c=>c.method===method).map(c=>c.args);
const tooltip=el=>calls(el,'tooltip').map(a=>a[0]).join('\n');
const label=el=>calls(el,'accessibility_label').map(a=>a[0]).join('\n');
const artwork=node=>{const out=[];walk(node,el=>{if(el.kind==='svg'||el.kind==='image')out.push(el.value);});return out;};
const strings=node=>{const out=[];walk(node,el=>{for(const v of el.nodes)if(typeof v==='string')out.push(v);});return out;};
const clickable=el=>Boolean(el.handlers.on_click);
const present=(node,id)=>{let found=false;walk(node,el=>{if(el.semanticId===id||calls(el,'id').some(a=>a[0]===id))found=true;});return found;};

async function fixture(t,{tree=overview(),name='mission-control',names=NAMES}={}){
  const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'mc-nav-'))),home=path.join(dir,'app'),repo=path.join(dir,'repo');
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));await fs.mkdir(repo);await fs.mkdir(home);
  let props={},running=null,count=0;
  const world={tree,names,spaces:[{id:'space-A',name:'client-portal',named:false,folder:repo,machine:null,active:true,tabs:[]}],panes:[],raws:new Map(),focused:null};
  const effects=[],copies=[],waiting=[];
  const addTab=name=>{count++;const s=world.spaces[0],id='tab-'+count;for(const x of s.tabs)x.active=false;s.tabs.push({id,index:s.tabs.length+1,name,named:true,active:true,status:null,panes:1,zoomed:false,settled:false});
    world.panes.push({pane:'p'+count,tab:id,terminal:'t'+count,title:'',cwd:repo,status:null,app:null,program:ZSH,focused:true});world.raws.set('t'+count,{address:'t'+count,created_ms:100+count,state:'live',cwd:repo,foreground:{pid:500+count},argv:['/bin/zsh','-l'],labels:{'herdr.space':'space-A','herdr.tab':id}});
    world.focused={space:'space-A',tab:id,pane:'p'+count,terminal:'t'+count,shown:null,agent:null,cwd:repo};return id;};
  const run=(cmd,args={})=>{
    effects.push(['run',cmd,args]);
    if(cmd==='layout.select'){const n=findNode(world.tree,args.stack);if(n)n.active=args.child;}
    if(cmd==='layout.show'||cmd==='layout.hide'){const n=findNode(world.tree,args.id);if(n)n.hidden=cmd==='layout.hide';}
    if(cmd==='tab.select'){for(const x of world.spaces[0].tabs)x.active=x.id===args.id;world.focused={...world.focused,tab:args.id};}
    if(cmd==='space.select')world.focused={...world.focused,space:args.id};
    return null;
  };
  injectNative({props:()=>props,appHome:home,home:dir,machines:[{name:null,layout:'ready'}],spaces:()=>world.spaces,agents:[],panes:()=>world.panes,
    terminals:()=>[...world.raws.keys()].map(address=>({address,state:'live'})),focused:()=>world.focused,layout:()=>world.tree,layouts:()=>world.names,
    window:{platform:'macos',titlebar:'none',buttons:false,fullscreen:false},settings:{zoom:1},shared:{layout:name},knownAgents:async()=>[],run,
    openOverlay:spec=>{effects.push(['overlay',spec]);return 'o'+effects.length;},closeOverlay:id=>{effects.push(['close-overlay',id]);return null;},notify:n=>{effects.push(['notify',n]);return 'toast';},
    nextCommand:()=>{if(running)running.loop=true;return new Promise(resolve=>waiting.push(resolve));},
    readTextFile:async file=>{effects.push(['read',file]);try{return await fs.readFile(file,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}},
    writeTextFile:async(file,next,expected)=>{effects.push(['write',file]);let actual=null;try{actual=sync.readFileSync(file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}if(actual!==expected)throw Object.assign(Error('stale'),{code:'STALE'});sync.writeFileSync(file,next);},
    exec:async(cmd,args=[])=>{effects.push(['exec',cmd,args]);if(cmd==='mkdir'){await fs.mkdir(args[1],{recursive:true});return ok('');}if(cmd==='hc'&&args[0]==='get'){const raw=world.raws.get(args[1]);return raw?ok(JSON.stringify(raw)):{code:1,stdout:''};}throw Error('Unexpected command '+cmd);}});
  const mount=(given={})=>{
    props=given;const cx=context(),timers=[],tasks=[];
    cx.timer.every=(ms,fn)=>{const timer={ms,fn,cancelled:false,cancel(){timer.cancelled=true;}};timers.push(timer);return timer;};
    cx.spawn=fn=>{const task={done:false,loop:false,cancel(){},is_done:()=>task.done};running=task;let value;try{value=fn(cx);}catch(error){value=Promise.reject(error);}finally{running=null;}task.promise=Promise.resolve(value).then(()=>{},()=>{}).finally(()=>{task.done=true;});tasks.push(task);return task;};
    const view=new Tabs();view.init(given,cx);const copy={view,cx,timers,tasks,render:()=>view.render(cx)};copies.push(copy);return copy;
  };
  const flush=async()=>{for(let i=0;i<40;i++){await new Promise(r=>setImmediate(r));const open=copies.flatMap(c=>c.tasks).filter(x=>!x.loop&&!x.done);if(!open.length)return;await Promise.all(open.map(x=>x.promise));}};
  const deliver=async command=>{const now=waiting.splice(0);for(const resolve of now)resolve(command);await flush();return now.length;};
  /** Herdr's layout.switch: the old layout's copies close, the other tree shows, its copies start fresh. */
  const switchTo=async(next,tree)=>{for(const c of copies.splice(0))await c.view.close();await deliver('shutdown');world.tree=tree;sharedSet('layout',next);};
  const since=n=>effects.slice(n),commands=list=>list.filter(e=>e[0]==='run').map(e=>[e[1],e[2]]);
  return {dir,home,world,effects,copies,addTab,run,mount,flush,deliver,switchTo,since,commands,teardown:async()=>{for(const c of copies.splice(0))await c.view.close();await deliver('shutdown');}};
}

test('the layout-node contract and the seven work sources are exact, distinct and match the source mods',async()=>{
  assert.deepEqual({...NODES},{main:'mc-main',panel:'mc-work-panel',stack:'mc-work-stack'});
  assert.deepEqual(SOURCE_IDS,['jira','github','pulls','gitlab','merges','sessions','mods']);
  assert.equal(new Set(SOURCES.map(s=>s.icon)).size,7,'seven distinct icons');assert.equal(new Set(SOURCES.map(s=>s.label)).size,7);assert.equal(new Set(SOURCES.map(s=>s.short)).size,7);
  assert.deepEqual(SOURCES.map(s=>s.icon),['jira','github','pull-request','gitlab','branch','sessions','layout'],'Mods reuses the existing layout icon');
  const by=Object.fromEntries(SOURCES.map(s=>[s.id,s]));
  assert.deepEqual([by.gitlab.mod,by.gitlab.props],['mission-control-gitlab',{view:'issues',hideHeader:true}]);assert.deepEqual([by.merges.mod,by.merges.props],['mission-control-gitlab',{view:'merges',hideHeader:true}]);
  assert.deepEqual([by.github.mod,by.github.props],['mission-control-github',{view:'issues',hideHeader:true}]);assert.deepEqual([by.pulls.mod,by.pulls.props],['mission-control-github',{view:'pulls',hideHeader:true}]);
  assert.deepEqual([by.jira.mod,by.jira.props],['mission-control-jira',{view:'panel',hideHeader:true}]);assert.deepEqual([by.sessions.mod,by.sessions.props],['mission-control-sessions',{hideHeader:true}]);
  assert.deepEqual([by.mods.mod,by.mods.props,by.mods.fixedScope,by.mods.caption],['mission-control-mods',{hideHeader:true},'all','All installed']);
  // Test-time only: the embedded mods really honour these props and persist scope under these keys.
  for(const s of SOURCES){
    const code=await fs.readFile(path.join(root,'src/mods',s.mod,'main.js'),'utf8');
    assert.match(code,/props\.hideHeader/,s.mod+' hides its own heading when embedded');if(s.scopeKey)assert.ok(code.includes(`'${s.scopeKey}'`),s.mod+' persists '+s.scopeKey);else assert.ok(s.fixedScope,s.id+' has a scope of its own or a fixed one');
    if(s.props.view&&s.props.view!=='panel')assert.ok(code.includes(`'${s.props.view}'`),s.mod+' has a '+s.props.view+' view');
  }
  assert.deepEqual({...LAYOUT_PAIR},{'mission-control':'mission-control-classic','mission-control-classic':'mission-control'});
  for(const command of ['swap','panel',...SOURCE_IDS.map(id=>'source-'+id)])assert.ok(COMMANDS.includes(command),'keys can reach '+command);
});

test('seven icon-labelled sources at wide widths, short labels at 1024 and 736px with a 220px rail, accessible icon-only controls in narrow panels',async t=>{
  assert.equal(navigationMode(900),'full');assert.ok(navigationWidth('full')<=900);assert.equal(navigationMode(1024-220),'short','seven full labels need about 850px');
  const main=736-220;assert.equal(navigationMode(main),'short');assert.ok(navigationWidth('short')<=main,'seven labelled controls fit 516px unclipped');
  assert.equal(navigationMode(360,{panel:true}),'icons');assert.equal(navigationMode(undefined),'icons','unmeasured: never wider than the panel');
  for(const width of [360,300,220,180])assert.ok(navigationMinWidth({panel:true})<=width,'all seven stay whole at '+width+'px');
  const f=await fixture(t),copy=f.mount({view:'navigation'});
  const at=width=>{trigger(copy.render(),'mc-work-navigation','on_size_change',{width,height:34},copy.cx);return copy.render();};
  let tree=at(1000);
  for(const s of SOURCES){const el=findElement(tree,'source-'+s.id);assert.deepEqual(artwork(el),[`mods/${MOD}/assets/${s.icon}.svg`]);assert.deepEqual(strings(el),[s.label]);assert.ok(clickable(el));assert.equal(calls(el,'role')[0][0],'tab');}
  assert.deepEqual(strings(findElement(tree,'source-caption')),['This space · client-portal']);
  tree=at(main);for(const s of SOURCES)assert.deepEqual(strings(findElement(tree,'source-'+s.id)),[s.short]);
  tree=at(220);
  for(const s of SOURCES){
    const el=findElement(tree,'source-'+s.id);assert.deepEqual(strings(el),[],'icon only');assert.match(tooltip(el),new RegExp(s.label));assert.match(label(el),new RegExp(s.label));assert.ok(clickable(el));
    assert.deepEqual([calls(el,'min_w')[0][0],calls(el,'max_w')[0][0]],[NAV_METRICS.minButton,NAV_METRICS.button],'icon controls shrink before anything clips');
  }
  assert.throws(()=>findElement(tree,'source-caption'),/found 0/);
  await f.teardown();
});

test('a source control selects one content panel and the choice is shared through mission-control-tabs-nav-v1',async t=>{
  const f=await fixture(t),copy=f.mount({view:'navigation'});let n=f.effects.length;
  trigger(copy.render(),'source-gitlab','on_click',{},copy.cx);
  assert.deepEqual(f.commands(f.since(n)),[['layout.select',{stack:'mc-work-stack',child:'gitlab'}]]);assert.equal(findNode(f.world.tree,NODES.stack).active,'gitlab');
  assert.deepEqual(sharedGet(NAV_STATE),{v:1,source:'gitlab',scope:'space',swap:null});
  const tree=copy.render();assert.match(label(findElement(tree,'source-gitlab')),/\(shown\)/);assert.doesNotMatch(label(findElement(tree,'source-jira')),/\(shown\)/);
  sharedSet('mission-control-gitlab-ui-v1',{v:1,all:true,query:'',status:'all'});n=f.effects.length;trigger(copy.render(),'source-gitlab','on_click',{},copy.cx);
  assert.deepEqual(f.commands(f.since(n)),[],'the shown source is not selected again');assert.equal(sharedGet(NAV_STATE).scope,'all');
  trigger(copy.render(),'mc-work-navigation','on_size_change',{width:1000,height:34},copy.cx);assert.deepEqual(strings(findElement(copy.render(),'source-caption')),['All spaces']);
  n=f.effects.length;trigger(copy.render(),'source-mods','on_click',{},copy.cx);
  assert.deepEqual(f.commands(f.since(n)),[['layout.select',{stack:'mc-work-stack',child:'mods'}]]);assert.deepEqual(sharedGet(NAV_STATE),{v:1,source:'mods',scope:'all',swap:null});
  assert.deepEqual(strings(findElement(copy.render(),'source-caption')),['All installed'],'Mods covers the whole install, never one space');
  assert.equal(copy.timers.length,0,'navigation runs no naming service');assert.ok(!f.effects.some(e=>e[0]==='read'&&e[1].includes('tab-names.json')));
  await f.teardown();
});

test('the Sources dialog turns a source off and on: the strip, its commands and the shown source all follow',async t=>{
  const f=await fixture(t);sharedSet(SOURCES_STATE,null);const nav=f.mount({view:'navigation'}),dialog=f.mount({view:'sources'});
  let tree=dialog.render();for(const s of SOURCES)assert.match(label(findElement(tree,'source-row-'+s.id)),new RegExp(s.label+': on'));
  assert.ok(findElement(nav.render(),'source-gitlab'),'every source is on by default');
  trigger(dialog.render(),'source-row-gitlab','on_click',{},dialog.cx);
  assert.deepEqual(sharedGet(SOURCES_STATE),{v:1,hidden:['gitlab']});assert.match(label(findElement(dialog.render(),'source-row-gitlab')),/GitLab issues: off/);
  assert.equal(present(nav.render(),'source-gitlab'),false,'a source that is off leaves the strip');assert.equal(present(nav.render(),'source-merges'),true,'its sibling source stays');
  let n=f.effects.length;assert.equal(selectSource('gitlab',{contract:layoutContract({tree:f.world.tree,name:'mission-control',names:NAMES}),sharedFn:sharedGet,setSharedFn:sharedSet,runFn:f.run}).code,'SOURCE_OFF');
  assert.deepEqual(f.commands(f.since(n)),[],'a source command for a source that is off selects nothing');
  // Turning off the source on screen shows the first source still on.
  n=f.effects.length;trigger(dialog.render(),'source-row-jira','on_click',{},dialog.cx);
  assert.deepEqual(f.commands(f.since(n)),[['layout.select',{stack:'mc-work-stack',child:'github'}]]);assert.deepEqual(sharedGet(SOURCES_STATE).hidden,['jira','gitlab']);
  for(const s of SOURCES)if(!hiddenSources(sharedGet).has(s.id))setSourceShown(s.id,false,{sharedFn:sharedGet,setSharedFn:sharedSet});
  assert.match(strings(findElement(nav.render(),'source-caption')).join(' '),/Every work source is turned off/);
  for(const s of SOURCES)trigger(dialog.render(),'source-row-'+s.id,'on_click',{},dialog.cx);
  assert.deepEqual(sharedGet(SOURCES_STATE),{v:1,hidden:[]});assert.ok(findElement(nav.render(),'source-gitlab'),'turned back on, it returns');
  sharedSet(SOURCES_STATE,{v:1,hidden:['gitlab','not-a-source',7]});assert.deepEqual([...hiddenSources(sharedGet)],['gitlab'],'unknown entries are ignored');
  sharedSet(SOURCES_STATE,null);assert.equal(nav.timers.length,0,'the strip follows shared state without a timer');await f.teardown();
});
test('Classic shows one button per source after the view swap: it opens the panel on that source and the shown one closes it',async t=>{
  sharedSet(SOURCES_STATE,null);
  const f=await fixture(t,{tree:classic('jira',true),name:'mission-control-classic'}),bar=f.mount({view:'topbar',swapTo:'mission-control',panel:true});
  let tree=bar.render();for(const s of SOURCES)assert.match(label(findElement(tree,'quick-'+s.id)),new RegExp('Open '+s.label+' in the work panel'));
  let n=f.effects.length;trigger(bar.render(),'quick-gitlab','on_click',{},bar.cx);
  assert.deepEqual(f.commands(f.since(n)),[['layout.select',{stack:'mc-work-stack',child:'gitlab'}],['layout.show',{id:'mc-work-panel'}]],'opens the panel on GitLab issues');
  assert.match(label(findElement(bar.render(),'quick-gitlab')),/Hide GitLab issues/);
  n=f.effects.length;trigger(bar.render(),'quick-gitlab','on_click',{},bar.cx);
  assert.deepEqual(f.commands(f.since(n)),[['layout.hide',{id:'mc-work-panel'}]],'the shown source closes the panel');
  sharedSet(SOURCES_STATE,{v:1,hidden:['gitlab']});assert.equal(present(bar.render(),'quick-gitlab'),false,'a source that is off has no button');assert.equal(present(bar.render(),'quick-jira'),true);
  sharedSet(SOURCES_STATE,null);await f.teardown();
  const o=await fixture(t),top=o.mount({view:'topbar',swapTo:'mission-control-classic'});assert.equal(present(top.render(),'quick-sources'),false,'the overview keeps its own navigation strip instead');await o.teardown();
});
test('the tab bar gear opens the Sources dialog, and the sources command does the same',async t=>{
  const f=await fixture(t),bar=f.mount({view:'topbar',swapTo:'mission-control-classic'});let n=f.effects.length;
  trigger(bar.render(),'mc-sources','on_click',{},bar.cx);
  const open=f.since(n).filter(e=>e[0]==='overlay');assert.equal(open.length,1);assert.deepEqual(open[0][1].props,{view:'sources'});assert.equal(open[0][1].mod,MOD);
  assert.ok(COMMANDS.includes('sources'));await f.teardown();
});
test('the one-button swap runs layout.switch only, keeps every source and its scope, and loses no selected work',async t=>{
  for(const source of SOURCE_IDS){
    const f=await fixture(t,{tree:overview(source)});const tab=f.addTab('Logs');
    const scopeKey=SOURCES.find(s=>s.id===source).scopeKey;sharedSet(scopeKey,{v:1,all:source.length%2===0});
    const bar=f.mount();await f.flush();let tree=bar.render(),n=f.effects.length;
    assert.match(tooltip(findElement(tree,'view-swap')),/Switch to Classic view/);trigger(tree,'view-swap','on_click',{},bar.cx);
    assert.deepEqual(f.commands(f.since(n)),[['layout.switch',{name:'mission-control-classic'}]],'nothing else: no tab is created, closed or selected');
    const state=sharedGet(NAV_STATE);assert.equal(state.source,source);assert.equal(state.scope,source.length%2===0?'all':'space');
    assert.deepEqual([state.swap.from,state.swap.to,state.swap.space,state.swap.tab],['mission-control','mission-control-classic','space-A',tab]);
    // Classic starts with its own saved stack child; the new bar restores the shared source and leaves the panel closed.
    await f.switchTo('mission-control-classic',classic('jira'));n=f.effects.length;const next=f.mount();await f.flush();
    assert.deepEqual(f.commands(f.since(n)).filter(([c])=>c.startsWith('layout.')||c.startsWith('tab.')||c.startsWith('space.')),source==='jira'?[]:[['layout.select',{stack:'mc-work-stack',child:source}]]);
    assert.equal(findNode(f.world.tree,NODES.panel).hidden,true,'Classic panel still starts closed');assert.equal(sharedGet(NAV_STATE).swap.applied,true);
    assert.equal(sharedGet(scopeKey).all,source.length%2===0,'the source keeps its own scope');
    // And back again: Mission Control shows the same source.
    n=f.effects.length;trigger(next.render(),'view-swap','on_click',{},next.cx);assert.deepEqual(f.commands(f.since(n)),[['layout.switch',{name:'mission-control'}]]);
    await f.switchTo('mission-control',overview('sessions'));f.mount();await f.flush();assert.equal(findNode(f.world.tree,NODES.stack).active,source);
    assert.equal(f.world.spaces[0].tabs.length,1,'no tab was created or closed');assert.equal(f.world.focused.tab,tab);
    await f.teardown();
  }
});

test('a switch that lost the focused tab brings it back once; a stale or applied swap does nothing',async t=>{
  const f=await fixture(t),first=f.addTab('First'),second=f.addTab('Second');
  const contract=layoutContract({tree:f.world.tree,name:'mission-control',names:NAMES,props:{}});
  swapView({contract,focused:f.world.focused,sharedFn:sharedGet,setSharedFn:sharedSet,runFn:f.run,now:1000,id:'swap-x'});
  f.world.focused={...f.world.focused,tab:first};f.world.tree=classic();
  const classicContract=layoutContract({tree:f.world.tree,name:'mission-control-classic',names:NAMES,props:{}});
  assert.deepEqual(restoreView({contract:classicContract,sharedFn:sharedGet,setSharedFn:sharedSet,runFn:f.run,focused:f.world.focused,spaces:f.world.spaces,now:2000}).commands,['tab.select']);
  assert.equal(f.world.focused.tab,second);
  f.world.focused={...f.world.focused,tab:first};assert.deepEqual(restoreView({contract:classicContract,sharedFn:sharedGet,setSharedFn:sharedSet,runFn:f.run,focused:f.world.focused,spaces:f.world.spaces,now:2100}).commands,[],'applied once');
  swapView({contract,focused:{space:'space-A',tab:second},sharedFn:sharedGet,setSharedFn:sharedSet,runFn:f.run,now:5000,id:'swap-y'});
  assert.deepEqual(restoreView({contract:classicContract,sharedFn:sharedGet,setSharedFn:sharedSet,runFn:f.run,focused:f.world.focused,spaces:f.world.spaces,now:5000+NAV_TIMING.swapRestoreMs+1}).commands,[],'too late to be this swap');
  assert.deepEqual(restoreView({contract,sharedFn:sharedGet,setSharedFn:sharedSet,runFn:f.run,focused:f.world.focused,spaces:f.world.spaces,now:5001}).commands,[],'only the destination layout restores');
  await f.teardown();
});

test('the Classic work panel starts closed and toggles by request',async t=>{
  const f=await fixture(t,{tree:classic(),name:'mission-control-classic'});f.addTab('Logs');const bar=f.mount();await f.flush();
  let tree=bar.render(),n=f.effects.length;const toggle=findElement(tree,'work-panel');assert.equal(tooltip(toggle),'Show work panel');
  trigger(tree,'work-panel','on_click',{},bar.cx);assert.deepEqual(f.commands(f.since(n)),[['layout.show',{id:'mc-work-panel'}]]);
  tree=bar.render();assert.equal(tooltip(findElement(tree,'work-panel')),'Hide work panel');
  const panel=f.mount({view:'navigation'});n=f.effects.length;trigger(panel.render(),'hide-work-panel','on_click',{},panel.cx);assert.deepEqual(f.commands(f.since(n)),[['layout.hide',{id:'mc-work-panel'}]]);
  n=f.effects.length;await f.deliver('panel');assert.deepEqual(f.commands(f.since(n)),[['layout.show',{id:'mc-work-panel'}]]);
  n=f.effects.length;await f.deliver('panel');assert.deepEqual(f.commands(f.since(n)),[['layout.hide',{id:'mc-work-panel'}]]);
  n=f.effects.length;await f.deliver('source-merges');assert.deepEqual(f.commands(f.since(n)),[['layout.select',{stack:'mc-work-stack',child:'merges'}],['layout.show',{id:'mc-work-panel'}]],'a source request reveals the closed panel');
  await f.teardown();
  const g=await fixture(t);g.addTab('Logs');const overviewBar=g.mount();await g.flush();assert.throws(()=>findElement(overviewBar.render(),'work-panel'),/found 0/,'Mission Control has no panel toggle');
  await g.teardown();
});

test('missing custom layout nodes disable layout-only controls clearly while the tab bar keeps working',async t=>{
  const f=await fixture(t,{tree:vanilla(),name:'main'});const a=f.addTab('A'),b=f.addTab('B');const bar=f.mount();await f.flush();
  let tree=bar.render();const swap=findElement(tree,'view-swap');assert.ok(!clickable(swap));assert.match(tooltip(swap),/View swap unavailable: this layout has no Mission Control nodes \(mc-main\)/);assert.match(label(swap),/unavailable/);
  assert.throws(()=>findElement(tree,'work-panel'),/found 0/);
  let n=f.effects.length;trigger(tree,'tab-body-'+a,'on_mouse_down',{click_count:1},bar.cx);trigger(bar.render(),'tab-body-'+a,'on_mouse_up',{},bar.cx);assert.deepEqual(f.commands(f.since(n)),[['tab.select',{id:a}]],'tabs still select');
  n=f.effects.length;trigger(bar.render(),'mc-new','on_click',{},bar.cx);assert.equal(f.since(n).find(e=>e[0]==='overlay')[1].mod,MOD,'the agent menu still opens');
  n=f.effects.length;await f.deliver('swap');assert.deepEqual(f.commands(f.since(n)),[]);assert.match(f.since(n).find(e=>e[0]==='notify')[1].body,/View swap unavailable/);
  const copy=f.mount({view:'navigation'});trigger(copy.render(),'mc-work-navigation','on_size_change',{width:900,height:34},copy.cx);tree=copy.render();
  for(const s of SOURCES){const el=findElement(tree,'source-'+s.id);assert.ok(!clickable(el));assert.match(tooltip(el),/Unavailable: this layout has no work stack \(mc-work-stack\)/);}
  assert.match(strings(findElement(tree,'source-caption')).join(''),/Work sources unavailable/);
  n=f.effects.length;await f.deliver('source-jira');assert.deepEqual(f.commands(f.since(n)),[]);
  const panelBar=f.mount({view:'topbar',panel:true});await f.flush();const disabled=findElement(panelBar.render(),'work-panel');assert.ok(!clickable(disabled));assert.match(tooltip(disabled),/no mc-work-panel node/);
  assert.ok(b);await f.teardown();
  const missing=layoutContract({tree:overview(),name:'mission-control',names:['main','mission-control'],props:{}});assert.equal(missing.swap.code,'SWAP_TARGET_MISSING');assert.match(missing.swap.reason,/Classic view layout \(mission-control-classic\) is not installed/);
  const partial=layoutContract({tree:overview('jira',['jira','github','pulls','sessions']),name:'mission-control',names:NAMES,props:{}});
  assert.deepEqual(['gitlab','merges'].map(id=>sourceState(partial,id)),[{enabled:false,reason:'Not in this layout.'},{enabled:false,reason:'Not in this layout.'}]);assert.equal(sourceState(partial,'jira').enabled,true);
  assert.equal(selectSource('merges',{contract:partial,sharedFn:sharedGet,setSharedFn:sharedSet,runFn:()=>assert.fail('no command')}).code,'SOURCE_MISSING');
  assert.equal(togglePanel({contract:partial,runFn:()=>assert.fail('no command')}).code,'NO_WORK_PANEL');
  const renamed=layoutContract({tree:overview(),name:'my-mc',names:['my-mc','my-classic'],props:{swapTo:'my-classic'}});assert.deepEqual([renamed.swap.enabled,renamed.swap.to],[true,'my-classic'],'props.swapTo names a renamed pair');
});

test('stored navigation state is validated: nothing malformed selects a wrong source',()=>{
  const read=v=>readNavState(()=>v);
  assert.deepEqual(read(null),{v:1,source:null,scope:null,swap:null});assert.deepEqual(read({v:2,source:'jira'}),{v:1,source:null,scope:null,swap:null});
  assert.deepEqual(read({v:1,source:'bogus',scope:'everywhere'}),{v:1,source:null,scope:null,swap:null});
  assert.equal(read({v:1,source:'pulls',swap:{id:'s',from:'a/../b',to:'x',at:1}}).swap,null);
  assert.equal(scopeOf('jira',()=>({v:1,all:true})),'all');assert.equal(scopeOf('jira',()=>({v:9,all:true})),'space');assert.equal(scopeOf('nope',()=>null),null);
  const contract=layoutContract({tree:overview('pulls'),name:'mission-control',names:NAMES,props:{}});assert.equal(contract.active,'pulls');assert.deepEqual(contract.children,SOURCE_IDS);
  assert.deepEqual(restoreView({contract,sharedFn:()=>({v:1,source:'bogus'}),setSharedFn:()=>assert.fail(),runFn:()=>assert.fail()}).commands,[]);
});
