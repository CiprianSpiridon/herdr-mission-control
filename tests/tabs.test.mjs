import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import sync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {build} from 'esbuild';
import Tabs,{MOD,VIEWS,COMMANDS,STATUS,ICONS,TIMING,REQUEST_EVENT,viewRole,lightsPadding,leftOffset,primaryPanes} from '../src/mods/mission-control-tabs/main.js';
import {SOURCES,NAV_STATE} from '../src/mods/mission-control-tabs/navigation.js';
import {SERVICE_LIMITS} from '../src/shared/tab-service.js';
import {NAME_LIMITS,estimateWidth} from '../src/shared/tab-names.js';
import {injectNative,context,trigger,findElement,Element,setShared} from './support/native-recording.mjs';

const root=new URL('../',import.meta.url).pathname;
const CLAUDE={key:'claude',name:'Claude Code',icon:'icons/claude.svg',tint:false,tile:null,color:null,shell:false,agent:true};
const CODEX={key:'codex',name:'Codex',icon:'icons/codex.svg',tint:true,tile:null,color:'#e5e7eb',shell:false,agent:true};
const ZSH={key:'shell',name:'zsh',icon:'icons/shell.svg',tint:true,tile:null,color:null,shell:true,agent:false};
const ok=stdout=>({code:0,stdout,stderr:''});
const find=(node,id)=>{if(!node||typeof node!=='object')return null;if(node.id===id)return node;for(const c of node.children||[]){const f=find(c,id);if(f)return f;}return null;};
const topbar=props=>({id:'mc-topbar',type:'block',size:{px:36},window_drag:true,content:{mod:MOD,props}});
const sidebar=(px=220)=>({id:'sidebar',type:'column',size:{px},children:[{id:'spaces',type:'block',content:{mod:'mission-control-spaces'}}]});
const stack=()=>({id:'mc-work-stack',type:'stack',active:'jira',children:SOURCES.map(s=>({id:s.id,type:'block',content:{mod:s.mod,props:s.props}}))});
export const overviewTree=()=>({id:'root',type:'column',titlebar:'none',traffic_lights:[14,14],children:[topbar({view:'topbar',swapTo:'mission-control-classic'}),
  {id:'body',type:'row',children:[sidebar(),{id:'mc-main',type:'column',children:[{id:'mc-navigation',type:'block',size:{px:34},content:{mod:MOD,props:{view:'navigation'}}},stack()]}]}]});
const vanillaTree=(px=240,hidden=false)=>({id:'root',type:'row',titlebar:'none',traffic_lights:[14,14],children:[{...sidebar(px),hidden},{id:'work',type:'column',children:[{id:'tabs',type:'block',size:{px:30},content:{mod:MOD}},{id:'main',type:'block',content:{tab:'active'}}]}]});

function walk(node,fn){if(node instanceof Element){fn(node);node.nodes.forEach(c=>walk(c,fn));}}
function texts(node){const out=[];const visit=v=>{if(typeof v==='string')out.push(v);else if(v instanceof Element){for(const c of v.calls)if(c.method==='tooltip'||c.method==='accessibility_label')out.push(String(c.args[0]));v.nodes.forEach(visit);}};visit(node);return out.join('\n');}
const calls=(el,method)=>el.calls.filter(c=>c.method===method).map(c=>c.args);
const tooltip=el=>calls(el,'tooltip').map(a=>a[0]).join('\n');
const artwork=node=>{const out=[];walk(node,el=>{if(el.kind==='svg'||el.kind==='image')out.push(el.value);});return out;};
const roles=(node,name)=>{let n=0;walk(node,el=>{if(calls(el,'role').some(a=>a[0]===name))n++;});return n;};
const labelText=el=>el.nodes.filter(v=>typeof v==='string').join('');

async function fixture(t){
  const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'mc-tabs-'))),home=path.join(dir,'app'),repo=path.join(dir,'repo');
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));await fs.mkdir(repo);await fs.mkdir(home);
  const realNow=Date.now;let offset=0;Date.now=()=>realNow()+offset;t.after(()=>{Date.now=realNow;});
  let count=0,props={},running=null;
  const world={spaces:[],panes:[],raws:new Map(),tree:overviewTree(),name:'mission-control',layouts:['main','mission-control','mission-control-classic'],focused:null,
    window:{platform:'macos',titlebar:'none',buttons:false,maximized:false,fullscreen:false,active:true},zoom:1,tools:[{...CLAUDE,run:['claude'],installed:true},{...CODEX,run:['codex'],installed:true}]};
  const effects=[],created=[],copies=[],waiting=[],known=[];
  const tabOf=id=>{for(const s of world.spaces){const i=s.tabs.findIndex(x=>x.id===id);if(i>=0)return {s,i,tab:s.tabs[i]};}return null;};
  const space=(id,{name='repo',machine=null,folder=repo,active=true}={})=>{if(active)for(const s of world.spaces)s.active=false;const s={id,name,named:false,folder,machine,branch:null,active,status:null,tabs:[]};world.spaces.push(s);return s;};
  const addTab=(spaceId,{name,program=ZSH,status=null,title='',cwd=repo,settled=false,zoomed=false,active=false,mod=null,argv=['/bin/zsh','-l']}={})=>{
    count++;const s=world.spaces.find(x=>x.id===spaceId),prefix=s.machine?s.machine+'/':'',id=prefix+'tab-'+count,terminal=mod?null:prefix+'t'+count;
    if(active||!s.tabs.length)for(const x of s.tabs)x.active=false;
    s.tabs.push({id,index:s.tabs.length+1,name:name??String(s.tabs.length+1),named:name!==undefined,active:active||!s.tabs.length,status,panes:1,zoomed,settled,settled_at:null,changed_at:null,working_since:null});
    world.panes.push(mod?{pane:'p'+count,tab:id,terminal:null,mod,title:mod,focused:false,zoomed:false}
      :{pane:'p'+count,tab:id,terminal,title,cwd,branch:null,status:program.agent?status||'idle':null,app:program.agent?program.key:null,program,focused:false,zoomed:false,movable:false});
    if(terminal)world.raws.set(terminal,{address:'t'+count,created_ms:1000+count,state:'live',cwd,foreground:{pid:700+count,name:program.key},argv,labels:{'herdr.space':s.machine?s.id.slice(prefix.length):s.id,'herdr.tab':'tab-'+count}});
    return id;
  };
  const run=(name,args={})=>{
    effects.push(['run',name,args]);const f=args?.id?tabOf(args.id):null;
    if(name==='tab.select'&&f){for(const x of f.s.tabs)x.active=x===f.tab;for(const s of world.spaces)s.active=s===f.s;}
    if(name==='space.select'){for(const s of world.spaces)s.active=s.id===args.id;}
    if(name==='tab.move'&&f){f.s.tabs.splice(f.i,1);f.s.tabs.splice(args.index-1,0,f.tab);f.s.tabs.forEach((x,i)=>x.index=i+1);}
    if(name==='tab.close'&&f){f.s.tabs.splice(f.i,1);f.s.tabs.forEach((x,i)=>x.index=i+1);if(f.tab.active&&f.s.tabs[0])f.s.tabs[0].active=true;for(const p of world.panes)if(p.tab===args.id&&p.terminal)world.raws.get(p.terminal).state='finished';world.panes=world.panes.filter(p=>p.tab!==args.id);}
    if(name==='tab.rename'&&f&&typeof args.name==='string'){if(args.name===''){f.tab.name=String(f.tab.index);f.tab.named=false;}else{f.tab.name=args.name;f.tab.named=true;}}
    if(name==='layout.select'){const n=find(world.tree,args.stack);if(n)n.active=args.child;}
    if(name==='layout.show'||name==='layout.hide'){const n=find(world.tree,args.id);if(n)n.hidden=name==='layout.hide';}
    return null;
  };
  injectNative({props:()=>props,appHome:home,home:dir,machines:()=>[{name:null,layout:'ready'},{name:'server',layout:'ready'}],spaces:()=>world.spaces,agents:[],panes:()=>world.panes,
    terminals:()=>[...world.raws].filter(([,r])=>r.state==='live').map(([address])=>({address,state:'live'})),focused:()=>world.focused,layout:()=>world.tree,layouts:()=>world.layouts,
    window:()=>world.window,settings:()=>({zoom:world.zoom}),shared:{layout:world.name},
    knownAgents:async(options={})=>{known.push(options.on??null);return world.tools;},run,
    openOverlay:spec=>{effects.push(['overlay',spec]);return 'overlay-'+effects.length;},closeOverlay:id=>{effects.push(['close-overlay',id]);return null;},notify:n=>{effects.push(['notify',n]);return 'toast';},
    nextCommand:()=>{if(running)running.loop=true;return new Promise(resolve=>waiting.push(resolve));},
    readTextFile:async file=>{effects.push(['read',file]);try{return await fs.readFile(file,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}},
    writeTextFile:async(file,next,expected)=>{effects.push(['write',file]);let actual=null;try{actual=sync.readFileSync(file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}if(actual!==expected)throw Object.assign(Error('stale'),{code:'STALE'});const temp=file+'.'+Math.random().toString(36).slice(2);sync.writeFileSync(temp,next);sync.renameSync(temp,file);},
    exec:async(cmd,args=[],options={})=>{
      const on=options.on??null;effects.push(['exec',cmd,args,on]);
      if(cmd==='mkdir'){await fs.mkdir(args[1],{recursive:true});return ok('');}
      if(cmd==='hc'&&args[0]==='get'){const raw=world.raws.get((on?on+'/':'')+args[1]);return raw?ok(JSON.stringify(raw)):{code:1,stdout:'',stderr:'missing'};}
      if(cmd==='test')return {code:sync.existsSync(args[1])?0:1,stdout:'',stderr:''};
      if(cmd==='sleep')return ok('');
      if(cmd==='git'){const top=on?'/srv/app':repo;if(args.includes('--show-toplevel'))return ok(top+'\n');if(args.includes('--git-common-dir'))return ok(top+'/.git\n');if(args.includes('list'))return ok('worktree '+top+'\0HEAD '+'a'.repeat(40)+'\0branch refs/heads/main\0\0');return {code:1,stdout:'',stderr:'unsupported'};}
      if(cmd==='claude'||cmd==='codex')return ok(args.includes('--help')?'Claude Code\nUsage: claude [options] [prompt]\n --model <model>':'');
      if(cmd==='herdr-app'&&args[0]==='do'){
        assert.equal(args[1],'tab.new');const input=JSON.parse(args[2]),s=world.spaces.find(x=>x.id===input.space);created.push(input);
        const id=addTab(s.id,{name:input.name,program:input.argv?CLAUDE:ZSH,cwd:input.folder,active:true,argv:input.argv?['/bin/zsh','-lic','"$@"; exec "$0" -li','/bin/zsh',...input.argv]:['/bin/zsh','-l']});
        return ok(JSON.stringify({space:s.id,tab:id,terminal:world.panes.find(p=>p.tab===id).terminal}));
      }
      if(cmd==='herdr-app'&&args[0]==='ls')return ok(JSON.stringify({spaces:world.spaces.map(s=>({id:s.id,machine:s.machine,tabs:s.tabs.map(x=>({id:x.id,terminals:world.panes.filter(p=>p.tab===x.id&&p.terminal).map(p=>({terminal:p.terminal}))}))}))}));
      throw Error('Unexpected command '+cmd+' '+args.join(' '));
    }});
  const mount=(given={})=>{
    props=given;const cx=context(),timers=[],tasks=[];
    cx.timer.every=(ms,fn)=>{const timer={ms,fn,cancelled:false,cancel(){timer.cancelled=true;}};timers.push(timer);return timer;};
    // Like the host: a task body runs synchronously up to its first await.
    cx.spawn=fn=>{const task={done:false,loop:false,cancelled:false,cancel(){task.cancelled=true;},is_done:()=>task.done};running=task;let value;try{value=fn(cx);}catch(error){value=Promise.reject(error);}finally{running=null;}task.promise=Promise.resolve(value).then(()=>{},()=>{}).finally(()=>{task.done=true;});tasks.push(task);return task;};
    const view=new Tabs();view.init(given,cx);const copy={view,cx,timers,tasks,render:()=>view.render(cx)};copies.push(copy);return copy;
  };
  const flush=async()=>{for(let i=0;i<60;i++){await new Promise(r=>setImmediate(r));const open=copies.flatMap(c=>c.tasks).filter(x=>!x.loop&&!x.done);if(!open.length)return;await Promise.all(open.map(x=>x.promise));}};
  const tick=async(list=copies.filter(c=>!c.closed),ms=SERVICE_LIMITS.pollMs)=>{offset+=ms;for(const c of list)for(const timer of c.timers)if(!timer.cancelled)timer.fn(c.cx);await flush();};
  const deliver=async command=>{const now=waiting.splice(0);for(const resolve of now)resolve(command);await flush();return now.length;};
  const close=async copy=>{copy.closed=true;await copy.view.close();};
  const teardown=async()=>{for(const c of copies)if(!c.closed)await close(c);await deliver('shutdown');};
  const since=n=>effects.slice(n);
  const commands=(list,names)=>list.filter(e=>e[0]==='run'&&(!names||names.includes(e[1]))).map(e=>[e[1],e[2]]);
  const json=async name=>JSON.parse(await fs.readFile(path.join(home,'mission-control',name),'utf8'));
  return {dir,home,repo,world,effects,created,copies,known,space,addTab,run,mount,flush,tick,deliver,close,teardown,since,commands,json,tabOf,advance:ms=>{offset+=ms;}};
}
const SELECTING=['tab.select','tab.move','tab.close','tab.rename','space.select'];

test('one topmost strip lists every running tab with its actual tool icon, task label and all four statuses',async t=>{
  const f=await fixture(t);f.space('space-A');
  const ids={working:f.addTab('space-A',{name:'Fix login redirect',program:CLAUDE,status:'working'}),blocked:f.addTab('space-A',{name:'Review PR 42',program:CODEX,status:'blocked'}),
    done:f.addTab('space-A',{name:'Write release notes',program:CLAUDE,status:'done'}),idle:f.addTab('space-A',{name:'Triage flaky test',program:CODEX,status:'idle'}),
    shell:f.addTab('space-A'),settled:f.addTab('space-A',{name:'Background build',settled:true}),board:f.addTab('space-A',{mod:'mission-control-jira'})};
  const bar=f.mount();await f.flush();const tree=bar.render();
  assert.equal(roles(tree,'tab_list'),1,'exactly one strip of tabs: no nested strip');assert.throws(()=>findElement(tree,'mc-work-navigation'),/found 0/);
  const shown=f.world.spaces[0].tabs.map(x=>x.id);for(const id of shown)assert.ok(findElement(tree,'tab-'+id),'every running tab is shown, settled ones too: '+id);
  assert.equal(roles(tree,'tab'),shown.length);
  // Actual tool icons from Herdr's program table; own artwork only where a tab has none.
  assert.deepEqual(artwork(findElement(tree,'tab-icon-'+ids.working)),['icons/claude.svg']);assert.equal(findElement(tree,'tab-icon-'+ids.working).nodes[0].kind,'image');
  assert.deepEqual(artwork(findElement(tree,'tab-icon-'+ids.blocked)),['icons/codex.svg']);assert.equal(findElement(tree,'tab-icon-'+ids.blocked).nodes[0].kind,'svg');
  assert.deepEqual(artwork(findElement(tree,'tab-icon-'+ids.shell)),['icons/shell.svg']);assert.deepEqual(artwork(findElement(tree,'tab-icon-'+ids.board)),['mods/mission-control-tabs/assets/panel.svg']);
  assert.equal(labelText(findElement(tree,'tab-label-'+ids.working)),'Fix login redirect');assert.equal(labelText(findElement(tree,'tab-label-'+ids.blocked)),'Review PR 42');
  assert.equal(labelText(findElement(tree,'tab-label-'+ids.shell)),path.basename(f.repo),'an unnamed shell shows its folder, not its position');
  const marks=Object.entries(STATUS).map(([status,label])=>{const el=findElement(tree,'tab-status-'+ids[status]);assert.equal(tooltip(el),label);assert.match(tooltip(findElement(tree,'tab-'+ids[status])),new RegExp(label));return JSON.stringify(el.calls.filter(c=>['bg','border','border_color'].includes(c.method)));});
  assert.equal(new Set(marks).size,4,'working, needs input, done and idle look different');
  assert.throws(()=>findElement(tree,'tab-status-'+ids.shell),/found 0/,'a plain shell has no agent status');
  assert.match(tooltip(findElement(tree,'tab-'+ids.settled)),/Settled · still running/);
  assert.doesNotMatch(texts(tree),/\bActions\b/);
  for(const art of artwork(tree)){
    if(art.startsWith('mods/')){const name=art.match(/^mods\/mission-control-tabs\/assets\/([a-z-]+)\.svg$/)?.[1];assert.ok(ICONS.includes(name),'declared own artwork '+art);}
    else assert.match(art,/^icons\/[a-z]+\.svg$/);
  }
  await f.teardown();
});

test('labels stay within 280px with the full title on hover',async t=>{
  const f=await fixture(t);f.space('space-A');const long='Investigate the intermittent authentication redirect loop seen after the session cookie rotates overnight in staging';
  const id=f.addTab('space-A',{name:long,program:CLAUDE,status:'working'}),bar=f.mount();await f.flush();const tree=bar.render(),label=labelText(findElement(tree,'tab-label-'+id));
  assert.ok(label.endsWith('…'));assert.ok(estimateWidth(label)<=NAME_LIMITS.displayPx,label);assert.ok(tooltip(findElement(tree,'tab-'+id)).startsWith(long),'the whole title is one hover away');
  assert.ok(calls(findElement(tree,'tab-label-'+id),'max_w').some(a=>a[0]===NAME_LIMITS.displayPx));
  await f.teardown();
});

test('selection, reorder, rename and wheel follow Herdr’s native tab semantics',async t=>{
  const f=await fixture(t);f.space('space-A');const a=f.addTab('space-A',{name:'A'}),b=f.addTab('space-A',{name:'B'}),c=f.addTab('space-A',{name:'C'});
  const bar=f.mount();await f.flush();let n=f.effects.length;
  trigger(bar.render(),'tab-body-'+b,'on_mouse_down',{click_count:1},bar.cx);trigger(bar.render(),'tab-body-'+b,'on_mouse_up',{},bar.cx);
  assert.deepEqual(f.commands(f.since(n),SELECTING),[['tab.select',{id:b}]]);
  n=f.effects.length;trigger(bar.render(),'tab-body-'+a,'on_mouse_down',{click_count:1},bar.cx);trigger(bar.render(),'tab-body-'+c,'on_mouse_up',{},bar.cx);
  assert.deepEqual(f.commands(f.since(n),SELECTING),[['tab.move',{id:a,index:3}]]);assert.deepEqual(f.world.spaces[0].tabs.map(x=>x.name),['B','C','A']);
  n=f.effects.length;trigger(bar.render(),'tab-body-'+c,'on_mouse_down',{click_count:1},bar.cx);trigger(bar.render(),'tab-body-'+c,'on_mouse_up',{},bar.cx);
  trigger(bar.render(),'tab-body-'+c,'on_mouse_down',{click_count:2},bar.cx);trigger(bar.render(),'tab-body-'+c,'on_mouse_up',{},bar.cx);
  assert.deepEqual(f.commands(f.since(n),SELECTING),[['tab.select',{id:c}],['tab.rename',{id:c}]],'a double press asks Herdr for the name; it never selects twice or moves');
  n=f.effects.length;const wheel=dy=>trigger(bar.render(),'mc-tabs','on_scroll_wheel',{delta:{x:0,y:dy}},bar.cx);
  wheel(3);wheel(3);f.advance(TIMING.wheelMs+10);wheel(-3);wheel(0.2);trigger(bar.render(),'mc-tabs','on_scroll_wheel',{delta:{x:40,y:2}},bar.cx);
  assert.deepEqual(f.commands(f.since(n),['tab.prev','tab.next']).map(x=>x[0]),['tab.prev','tab.next'],'one switch per wheel gesture; sideways scrolling only scrolls the strip');
  await f.teardown();
});

test('a drag that ends outside a tab never selects, moves or closes the wrong item',async t=>{
  const f=await fixture(t);f.space('space-A');const a=f.addTab('space-A',{name:'A'}),b=f.addTab('space-A',{name:'B'});f.addTab('space-A',{name:'C'});
  const bar=f.mount();await f.flush();const n=f.effects.length,down=id=>trigger(bar.render(),'tab-body-'+id,'on_mouse_down',{click_count:1},bar.cx),up=id=>trigger(bar.render(),'tab-body-'+id,'on_mouse_up',{},bar.cx);
  // Pressed on A, dragged off the bar and released elsewhere; later a release lands on B.
  down(a);trigger(bar.render(),'mc-tabs','on_hover',false,bar.cx);up(b);
  // Released outside without the bar noticing at all; the press goes stale.
  down(a);f.advance(TIMING.pressMs+1);up(b);
  // A drag that started in a terminal and ends on a tab.
  up(b);
  // Released on the empty strip.
  down(a);trigger(bar.render(),'mc-tabs','on_mouse_up',{},bar.cx);up(b);
  // A press on the shown tab's close control, released on the tab body: neither closes nor selects.
  down(b);trigger(bar.render(),'tab-close-'+a,'on_mouse_down',{},bar.cx);up(a);
  // A right press opens the menu and forgets any earlier left press.
  down(a);trigger(bar.render(),'tab-'+b,'on_mouse_down',{},bar.cx);up(b);
  assert.deepEqual(f.commands(f.since(n),SELECTING),[]);assert.deepEqual(f.world.spaces[0].tabs.map(x=>x.name),['A','B','C']);
  assert.equal(f.since(n).filter(e=>e[0]==='overlay').length,1);
  await f.teardown();
});

test('close goes through the bar’s capture; the tab menu is this mod’s own popup',async t=>{
  const f=await fixture(t);f.space('space-A');const a=f.addTab('space-A',{name:'Logs'}),b=f.addTab('space-A',{name:'Deploy notes'}),c=f.addTab('space-A');
  const bar=f.mount();await f.flush();await f.tick();await f.tick();let tree=bar.render();
  assert.ok(findElement(tree,'tab-close-'+a));for(const id of [b,c])assert.throws(()=>findElement(tree,'tab-close-'+id),/found 0/,'only the shown tab has a close control');
  let n=f.effects.length;trigger(tree,'tab-close-'+a,'on_click',{},bar.cx);trigger(tree,'tab-close-'+a,'on_click',{},bar.cx);
  assert.throws(()=>trigger(bar.render(),'tab-close-'+a,'on_click',{},bar.cx),/Missing on_click/,'a closing tab offers no second close');await f.flush();
  assert.deepEqual(f.commands(f.since(n),SELECTING),[['tab.close',{id:a}]],'a double click closes once');
  const order=f.since(n),captured=order.findIndex(e=>e[0]==='read'&&e[1].endsWith('/mission-control/closed.json')),closed=order.findIndex(e=>e[0]==='run'&&e[1]==='tab.close');
  assert.ok(captured>=0&&captured<closed,'the closed tab was captured from the close journal before tab.close');
  await f.tick();await f.tick();assert.equal((await f.json('closed.json')).records.filter(r=>r.tab.id===a).length,1,'the close is recorded once for Reopen');
  n=f.effects.length;trigger(bar.render(),'tab-'+b,'on_mouse_down',{},bar.cx);
  const [spec]=f.since(n).filter(e=>e[0]==='overlay').map(e=>e[1]);assert.equal(spec.mod,MOD);assert.equal(spec.kind,'popup');assert.equal(spec.props.view,'context');
  assert.deepEqual({...spec.props.target,mode:undefined},{tabId:b,spaceId:'space-A',machine:null,mode:undefined});
  const menu=f.mount({...spec.props,overlay:'menu-1'});assert.equal(menu.timers.length,0,'the popup runs no service');tree=menu.render();
  assert.equal(roles(tree,'tab_list'),0);assert.match(texts(tree),/Rename…/);assert.doesNotMatch(texts(tree),/\bActions\b/);
  n=f.effects.length;trigger(tree,'tab-menu-rename','on_click',{},menu.cx);assert.deepEqual(f.commands(f.since(n)),[['tab.rename',{id:b}]]);assert.ok(f.since(n).some(e=>e[0]==='close-overlay'&&e[1]==='menu-1'));
  // Close from the menu: the bar takes the request once, captures and closes.
  const second=f.mount();await f.flush();n=f.effects.length;trigger(menu.render(),'tab-menu-close','on_click',{},menu.cx);
  bar.render();second.render();await f.flush();await f.tick();
  assert.deepEqual(f.commands(f.since(n),SELECTING),[['tab.close',{id:b}]]);assert.ok(f.world.spaces[0].tabs.every(x=>x.id!==b));
  assert.match(texts(f.mount({view:'context',overlay:'menu-2',target:{tabId:b,spaceId:'space-A',machine:null}}).render()),/This tab is no longer open/);
  await f.teardown();
});

test('plus opens this mod’s own agent menu for the shown space and launches on its host and repository',async t=>{
  const f=await fixture(t);f.space('space-A');f.addTab('space-A',{name:'Logs'});const bar=f.mount();await f.flush();
  let n=f.effects.length;trigger(bar.render(),'mc-new','on_click',{},bar.cx);
  const [spec]=f.since(n).filter(e=>e[0]==='overlay').map(e=>e[1]);
  assert.deepEqual({mod:spec.mod,kind:spec.kind,view:spec.props.view,spaceId:spec.props.spaceId,machine:spec.props.machine},{mod:MOD,kind:'dialog',view:'menu',spaceId:'space-A',machine:null});
  const dialog=f.mount({...spec.props,overlay:'agents-1'});await f.flush();
  assert.equal(dialog.timers.length,0);assert.deepEqual(dialog.view.dialog.target,{spaceId:'space-A',machine:null,repoRoot:f.repo,checkoutRoot:f.repo});
  trigger(dialog.render(),'choose-claude','on_click',{},dialog.cx);await f.flush();trigger(dialog.render(),'current-checkout','on_click',{},dialog.cx);
  n=f.effects.length;trigger(dialog.render(),'start-agent','on_click',{},dialog.cx);await f.flush();
  assert.equal(f.created.length,1);assert.equal(f.created[0].space,'space-A');assert.equal(f.created[0].folder,f.repo);assert.equal(f.created[0].argv[0],'claude');
  assert.ok(f.since(n).some(e=>e[0]==='close-overlay'&&e[1]==='agents-1'),'a launched agent closes the menu');
  // A space on another machine: the menu asks that machine for its agents and its repository.
  f.space('server/space-B',{name:'api',machine:'server',folder:'/srv/app'});f.addTab('server/space-B',{name:'Server shell',cwd:'/srv/app'});
  n=f.effects.length;trigger(bar.render(),'mc-new','on_click',{},bar.cx);const remote=f.since(n).find(e=>e[0]==='overlay')[1];
  assert.deepEqual([remote.props.spaceId,remote.props.machine],['server/space-B','server']);
  const before=f.known.length,second=f.mount({...remote.props,overlay:'agents-2'});await f.flush();
  assert.deepEqual(second.view.dialog.target,{spaceId:'server/space-B',machine:'server',repoRoot:'/srv/app',checkoutRoot:'/srv/app'});
  assert.deepEqual(f.known.slice(before),['server']);assert.ok(f.since(n).filter(e=>e[0]==='exec'&&e[1]==='git').every(e=>e[3]==='server'));
  for(const s of f.world.spaces)s.active=false;n=f.effects.length;const none=bar.render();assert.throws(()=>trigger(none,'mc-new','on_click',{},bar.cx),/Missing on_click/);
  assert.match(tooltip(findElement(none,'mc-new')),/Select a space/);
  for(const e of f.effects.filter(e=>e[0]==='overlay'))assert.equal(e[1].mod,MOD,'never a sibling or shipped menu');
  await f.teardown();
});

test('Reopen last tab and Reopen last agent are compact actions backed by the bundled controller',async t=>{
  const f=await fixture(t);f.space('space-A');f.addTab('space-A',{name:'Logs'});const b=f.addTab('space-A',{name:'Scratch'});
  const bar=f.mount();await f.flush();await f.tick();await f.tick();let tree=bar.render();
  assert.throws(()=>trigger(tree,'reopen-tab','on_click',{},bar.cx),/Missing on_click/);assert.match(tooltip(findElement(tree,'reopen-tab')),/^Reopen last tab\nNo closed tab has been recorded yet/);
  f.run('tab.close',{id:b});await f.tick();await f.tick();tree=bar.render();
  assert.match(tooltip(findElement(tree,'reopen-tab')),/Reopen last tab: Scratch · repo · This Mac/);
  assert.throws(()=>trigger(tree,'reopen-agent','on_click',{},bar.cx),/Missing on_click/);assert.match(tooltip(findElement(tree,'reopen-agent')),/Shell-only tabs are skipped/);
  trigger(tree,'reopen-tab','on_click',{},bar.cx);await f.flush();
  assert.equal(f.created.length,1);assert.deepEqual(f.created[0],{space:'space-A',folder:f.repo,name:'Scratch'});
  const n=f.effects.length;await f.deliver('reopen-agent');const toast=f.since(n).find(e=>e[0]==='notify')?.[1];
  assert.equal(toast?.title,'Reopen last agent');assert.match(toast.body,/Shell-only tabs are skipped/);assert.equal(f.created.length,1);
  await f.teardown();
});

test('automatic names fill eligible tabs and the bar never overwrites a name the person chose',async t=>{
  const f=await fixture(t);f.space('space-A');const agent=f.addTab('space-A',{program:CLAUDE,status:'working',title:'⠐ Fix login redirect'}),mine=f.addTab('space-A',{name:'Release prep'});
  const bar=f.mount();await f.flush();for(let i=0;i<4;i++)await f.tick();
  const renames=()=>f.commands(f.effects,['tab.rename']);
  assert.deepEqual(renames().filter(([,a])=>a.id===agent).map(([,a])=>a.name),['Fix login redirect']);assert.deepEqual(renames().filter(([,a])=>a.id===mine),[]);
  let tree=bar.render();assert.equal(labelText(findElement(tree,'tab-label-'+mine)),'Release prep');assert.match(tooltip(findElement(tree,'tab-'+agent)),/Automatic name/);
  // The person renames the agent tab; later title changes never take it back.
  f.tabOf(agent).tab.name='Login fix (mine)';f.world.panes.find(p=>p.tab===agent).title='⠂ Something else';for(let i=0;i<4;i++)await f.tick();
  assert.equal(renames().filter(([,a])=>a.id===agent).length,1);assert.equal(f.tabOf(agent).tab.name,'Login fix (mine)');
  tree=bar.render();trigger(tree,'tab-'+agent,'on_mouse_down',{},bar.cx);const spec=f.effects.filter(e=>e[0]==='overlay').at(-1)[1];assert.notEqual(spec.props.target.mode,'auto');
  // The explicit route back to automatic naming.
  const menu=f.mount({...spec.props,overlay:'menu-1'});trigger(menu.render(),'tab-menu-automatic','on_click',{},menu.cx);for(let i=0;i<4;i++)await f.tick();
  assert.equal(f.tabOf(agent).tab.name,'Something else');assert.deepEqual(renames().filter(([,a])=>a.id===agent).map(([,a])=>a.name),['Fix login redirect','','Something else']);
  assert.deepEqual(renames().filter(([,a])=>a.id===mine),[]);
  const auto=f.mount({view:'context',overlay:'menu-2',target:{tabId:agent,spaceId:'space-A',machine:null,mode:'auto'}});assert.throws(()=>trigger(auto.render(),'tab-menu-automatic','on_click',{},auto.cx),/Missing on_click/);
  await f.teardown();
});

test('traffic-light padding and window controls follow the native title bar',()=>{
  const mac={platform:'macos',titlebar:'none',buttons:false,fullscreen:false};
  assert.equal(lightsPadding({win:mac,tree:overviewTree()}),78,'a full-width top bar starts under the window buttons');
  assert.equal(lightsPadding({win:mac,tree:vanillaTree(240)}),10,'a bar beside a 240px sidebar needs no extra room');
  assert.equal(lightsPadding({win:mac,tree:vanillaTree(44)}),34);assert.equal(lightsPadding({win:mac,tree:vanillaTree(240,true)}),78);
  assert.equal(lightsPadding({win:mac,tree:overviewTree(),zoom:2}),39);assert.equal(lightsPadding({win:{...mac,fullscreen:true},tree:overviewTree()}),10);
  assert.equal(lightsPadding({win:{...mac,titlebar:'system'},tree:overviewTree()}),10);assert.equal(lightsPadding({win:{...mac,platform:'linux'},tree:overviewTree()}),10);
  assert.equal(leftOffset({type:'row',children:[{size:{weight:1}},{id:'x'}]},n=>n.id==='x'),Infinity);
});

test('window buttons are drawn only where the system draws none, and use the window commands',async t=>{
  const f=await fixture(t);f.space('space-A');f.addTab('space-A',{name:'A'});const bar=f.mount();await f.flush();
  let tree=bar.render();assert.equal(calls(tree,'pl')[0][0],78);assert.throws(()=>findElement(tree,'window-controls'),/found 0/);
  f.world.window={platform:'linux',titlebar:'none',buttons:true,maximized:false,fullscreen:false,active:true};tree=bar.render();assert.equal(calls(tree,'pl')[0][0],10);
  const n=f.effects.length;for(const id of ['window-minimize','window-maximize','window-close'])trigger(tree,id,'on_click',{},bar.cx);
  assert.deepEqual(f.commands(f.since(n)).map(c=>c[0]),['window.minimize','window.maximize','window.close']);assert.deepEqual(artwork(findElement(tree,'window-close')),['mods/mission-control-tabs/assets/close.svg']);
  await f.teardown();
});

test('a bar Herdr keeps across a layout switch restores the stored source on its next tick',async t=>{
  const f=await fixture(t);f.mount({view:'topbar',swapTo:'mission-control-classic'});await f.flush();await f.tick();
  setShared(NAV_STATE,{v:1,source:'gitlab',scope:null});f.world.tree=overviewTree();setShared('layout','mission-control-classic');
  assert.equal(find(f.world.tree,'mc-work-stack').active,'jira');await f.tick();
  assert.equal(find(f.world.tree,'mc-work-stack').active,'gitlab','the surviving bar re-selects the stored source in the new layout');
});
test('a selection Herdr dropped while the swapped-in layout mounted is re-sent only inside the swap window',async t=>{
  const f=await fixture(t);f.mount({view:'topbar',swapTo:'mission-control-classic'});await f.flush();await f.tick();
  const stackNode=()=>find(f.world.tree,'mc-work-stack');
  setShared(NAV_STATE,{v:1,source:'gitlab',scope:null,swap:{id:'swap-test',from:'mission-control-classic',to:'mission-control',at:Date.now(),space:null,tab:null,applied:true}});
  stackNode().active='jira';await f.tick();assert.equal(stackNode().active,'gitlab','a dropped select is sent again during the swap window');
  setShared(NAV_STATE,{v:1,source:'gitlab',scope:null,swap:{id:'swap-old',from:'mission-control-classic',to:'mission-control',at:Date.now()-60000,space:null,tab:null,applied:true}});
  stackNode().active='pulls';await f.tick();assert.equal(stackNode().active,'pulls','outside the window a different source is left alone');
});
test('a bar copy whose close-history pass is stuck still shows the newest closed tab on its Reopen buttons',async t=>{
  const f=await fixture(t);f.space('space-A');f.addTab('space-A',{name:'Logs'});const b=f.addTab('space-A',{name:'Scratch'});
  const bar=f.mount(),stuck=f.mount();await f.flush();await f.tick();await f.tick();
  stuck.view.service.closedRunning=Date.now();stuck.view.service.lastClosed=Date.now();
  f.run('tab.close',{id:b});for(let i=0;i<4;i++)await f.tick(undefined,TIMING.reopenReadMs);
  assert.ok((await f.json('closed.json')).records.length>=1,'the recording copy saved the close');
  assert.match(tooltip(findElement(stuck.render(),'reopen-tab')),/Reopen last tab: Scratch/,'the stuck copy still reads the newest record');
  await f.teardown();
});
test('one bar copy drives the service on one 1s timer; idle ticks do not redraw; closing releases its leases',async t=>{
  const f=await fixture(t);f.space('space-A');f.addTab('space-A',{program:CLAUDE,status:'idle',title:'Plan the migration'});
  const bar=f.mount();await f.flush();assert.deepEqual(bar.timers.map(x=>x.ms),[TIMING.tickMs]);
  for(let i=0;i<4;i++)await f.tick();const lease=(await f.json('tab-names.json')).lease;assert.equal(lease.owner,MOD+'-'+bar.view.instance);
  const idle=bar.cx.notifications,writes=f.effects.filter(e=>e[0]==='write').length;for(let i=0;i<3;i++)await f.tick([bar],1000);
  assert.equal(bar.cx.notifications,idle,'idle ticks never redraw the window');assert.ok(f.effects.filter(e=>e[0]==='write').length-writes<=1,'idle ticks write at most a lease renewal');
  for(const role of [{view:'navigation'},{view:'context',overlay:'x',target:{}},{view:'bogus'}]){const copy=f.mount(role);await f.flush();assert.equal(copy.timers.length,0,JSON.stringify(role));assert.equal(copy.view.service,undefined);}
  assert.match(texts(f.copies.at(-1).render()),/Unknown Mission Control tabs view "bogus"/);
  await f.close(bar);assert.equal((await f.json('tab-names.json')).lease,null);assert.ok(bar.timers.every(x=>x.cancelled));
  await f.teardown();
});

test('an interrupted close, reopen or naming pass only expires: no control or loop stays stuck',async t=>{
  const f=await fixture(t);f.space('space-A');const a=f.addTab('space-A',{name:'Logs'}),b=f.addTab('space-A',{name:'Scratch'});
  const bar=f.mount();await f.flush();await f.tick();await f.tick();f.run('tab.close',{id:b});await f.tick();await f.tick();
  // A task the host cancelled never settles and skips its own cleanup, so each flag is a timestamp.
  bar.view.closing.set(a,Date.now());bar.view.reopening=Date.now();bar.view.ticking=Date.now();
  let tree=bar.render();assert.throws(()=>trigger(tree,'tab-close-'+a,'on_click',{},bar.cx),/Missing on_click/);assert.throws(()=>trigger(tree,'reopen-tab','on_click',{},bar.cx),/Missing on_click/);
  const passes=()=>f.effects.filter(e=>e[0]==='read'&&e[1].endsWith('/mission-control/tab-names.json')).length;let before=passes();
  await f.tick([bar]);assert.equal(passes(),before,'a pass still in flight is never doubled');
  f.advance(Math.max(TIMING.closeMs,TIMING.reopenStaleMs,TIMING.tickStaleMs)+1);tree=bar.render();
  assert.ok(findElement(tree,'tab-close-'+a).handlers.on_click,'close is offered again');assert.ok(findElement(tree,'reopen-tab').handlers.on_click,'reopen is offered again');
  before=passes();await f.tick([bar]);assert.ok(passes()>before,'the next tick runs a fresh naming pass');
  await f.teardown();
});

test('key commands reach one copy and stay distinct',async t=>{
  const f=await fixture(t);f.space('space-A');const a=f.addTab('space-A',{name:'Logs'});const one=f.mount(),two=f.mount();await f.flush();
  assert.ok(COMMANDS.includes('new')&&COMMANDS.includes('reopen-tab')&&COMMANDS.includes('reopen-agent')&&COMMANDS.includes('swap')&&COMMANDS.includes('panel')&&COMMANDS.includes('automatic-name'));
  for(const s of SOURCES)assert.ok(COMMANDS.includes('source-'+s.id));
  let n=f.effects.length;assert.equal(await f.deliver('new'),2);let overlays=f.since(n).filter(e=>e[0]==='overlay');
  assert.equal(overlays.length,1,'both copies heard it; one acted');assert.equal(overlays[0][1].props.view,'menu');
  f.advance(TIMING.commandMs+1);n=f.effects.length;await f.deliver('settings');overlays=f.since(n).filter(e=>e[0]==='overlay');assert.deepEqual(overlays.map(e=>e[1].props.view),['settings']);
  f.advance(TIMING.commandMs+1);n=f.effects.length;await f.deliver('rename');assert.deepEqual(f.commands(f.since(n)),[['tab.rename',{id:a}]]);
  f.advance(TIMING.commandMs+1);n=f.effects.length;await f.deliver('not-a-command');assert.deepEqual(f.since(n).filter(e=>e[0]!=='read'),[]);
  await f.teardown();
});

test('rendering many tabs stays cheap: labels are computed once per name change',async t=>{
  const f=await fixture(t);f.space('space-A');for(let i=0;i<240;i++)f.addTab('space-A',{name:'Task '+i+' · keep the bar quick',program:i%2?CLAUDE:CODEX,status:['working','blocked','done','idle'][i%4]});
  const bar=f.mount();await f.flush();let labels=0;const original=bar.view.service.label.bind(bar.view.service);bar.view.service.label=(...args)=>{labels++;return original(...args);};
  let started=performance.now();bar.render();const first=performance.now()-started;assert.equal(labels,240);
  started=performance.now();for(let i=0;i<20;i++)bar.render();const each=(performance.now()-started)/20;assert.equal(labels,240,'re-renders reuse every label');
  assert.ok(first<100&&each<60,`render took ${first.toFixed(1)}ms then ${each.toFixed(1)}ms`);
  assert.equal(primaryPanes(f.world.spaces[0].tabs,f.world.panes).size,240);
  await f.teardown();
});

test('roles dispatch from one module and the manifest stays standalone',async()=>{
  assert.deepEqual(VIEWS,['topbar','navigation','menu','launch','settings','context']);
  assert.equal(viewRole({}),'topbar');assert.equal(viewRole({overlay:'o'}),'menu');assert.equal(viewRole({view:'navigation'}),'navigation');assert.equal(viewRole({view:'x'}),'unknown');
  const manifest=JSON.parse(await fs.readFile(path.join(root,'src/mods',MOD,'mod.json'),'utf8')),catalog=JSON.parse(await fs.readFile(path.join(root,'src/assets/icons.json'),'utf8'));
  assert.equal(manifest.place,'none','no second strip is docked into a layout that already has one');assert.deepEqual(manifest.overlay,{kind:'dialog',width:560,height:660});
  assert.deepEqual([...manifest.build.assets].sort(),[...ICONS].sort());for(const name of ICONS)assert.ok(catalog[name]?.svg,'shared artwork '+name);
  for(const s of SOURCES)assert.ok(ICONS.includes(s.icon));
  // Every artwork name the bar, navigation and the bundled agent menu draw is declared.
  const sources=['src/mods/mission-control-tabs/main.js','src/mods/mission-control-tabs/navigation.js','src/shared/launch-dialog.js','src/shared/ui.js'].map(p=>sync.readFileSync(path.join(root,p),'utf8')).join('\n');
  const drawn=new Set([...sources.matchAll(/\bicon\((?:MOD|mod|this\.mod),'([a-z-]+)'/g),...sources.matchAll(/iconButton\((?:MOD|mod|this\.mod),'[^']+','([a-z-]+)'/g)].map(m=>m[1]));
  for(const name of ['agent','folder','panel','refresh','search'])drawn.add(name);for(const name of drawn)assert.ok(ICONS.includes(name),'declared '+name);
});

test('the bundle carries its own helpers: no sibling mod, no timers outside cx, native externals only',async()=>{
  const native=new Set(['gpui-kit','gpui-base','herdr']),inputs=new Set(),externals=new Set();
  const out=await build({entryPoints:[path.join(root,'src/mods',MOD,'main.js')],bundle:true,platform:'neutral',format:'esm',write:false,metafile:true,logLevel:'silent',absWorkingDir:root,
    plugins:[{name:'record',setup(b){b.onResolve({filter:/.*/},args=>{if(native.has(args.path)){externals.add(args.path);return {path:args.path,external:true};}if(args.kind!=='entry-point'&&!args.path.startsWith('.'))throw Error('Unexpected package import '+args.path);return undefined;});}}]});
  for(const input of Object.keys(out.metafile.inputs)){inputs.add(input);assert.ok(input.startsWith('src/mods/mission-control-tabs/')||input.startsWith('src/shared/'),'bundled from this mod or shared source only: '+input);}
  assert.ok(inputs.has('src/mods/mission-control-tabs/navigation.js'));assert.ok(inputs.has('src/shared/tab-service.js')&&inputs.has('src/shared/reopen.js')&&inputs.has('src/shared/launch-dialog.js'));
  assert.deepEqual([...externals].sort(),['gpui-base','gpui-kit','herdr']);
  const text=out.outputFiles[0].text;assert.ok(!/\bset(?:Timeout|Interval)\s*\(/.test(text));assert.ok(!/mods\/mission-control-(?!tabs\/)/.test(text),'no sibling mod path is read at run time');
  assert.ok(!/['"]new-menu['"]/.test(text),'the plus never opens the shipped menu');
});
