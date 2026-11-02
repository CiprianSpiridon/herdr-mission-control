import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import sync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {build} from 'esbuild';
import {buildPackage} from '../scripts/project.mjs';
import Reopen from '../src/mods/mission-control-reopen/main.js';
import {ReopenController,REOPEN_COMMANDS} from '../src/shared/reopen.js';
import {injectNative,context,trigger,findElement,Element} from './support/native-recording.mjs';

const MOD='mission-control-reopen',root=new URL('../',import.meta.url).pathname;
function texts(node){const out=[];const walk=v=>{if(typeof v==='string')out.push(v);else if(v instanceof Element){for(const c of v.calls)if(c.method==='tooltip')out.push(String(c.args[0]));v.nodes.forEach(walk);}};walk(node);return out.join('\n');}
async function fixture(t){
  const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'mc-reopen-mod-'))),home=path.join(dir,'app'),repo=path.join(dir,'repo');
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));await fs.mkdir(repo);
  let count=0,props={},running=null;
  const world={spaces:[{id:'space-A',name:'repo',named:false,machine:null,folder:repo,tabs:[]}]},raws=new Map(),effects=[],created=[],copies=[],waiting=[];
  const addTab=(folder,name)=>{count++;const tab='tab-'+count,terminal='t'+count;world.spaces[0].tabs.push({id:tab,index:world.spaces[0].tabs.length+1,name:name||String(count),named:Boolean(name),panes:1});raws.set(terminal,{address:terminal,created_ms:1000+count,state:'live',cwd:folder,foreground:{pid:700+count,name:'zsh'},argv:['/bin/zsh','-l'],labels:{'herdr.space':'space-A','herdr.tab':tab}});return {space:'space-A',tab,terminal};};
  injectNative({props:()=>props,appHome:home,home:dir,machines:[{name:null,layout:'ready'}],spaces:()=>world.spaces,agents:[],
    panes:()=>world.spaces.flatMap(s=>s.tabs.map(tab=>{const terminal='t'+tab.id.slice(4);return {pane:'p-'+terminal,tab:tab.id,terminal,cwd:raws.get(terminal).cwd,title:'zsh',program:{key:'zsh',name:'zsh',agent:false},status:null};})),
    terminals:()=>[...raws].filter(([,r])=>r.state==='live').map(([address])=>({address,state:'live'})),
    knownAgents:async()=>[],run:(name,args)=>{effects.push(['run',name,args]);return null;},openOverlay:spec=>{effects.push(['overlay',spec]);return 'overlay-'+effects.length;},closeOverlay:id=>{effects.push(['close',id]);return null;},notify:n=>{effects.push(['notify',n]);return 'toast';},
    nextCommand:()=>{if(running)running.loop=true;return new Promise(resolve=>waiting.push(resolve));},
    readTextFile:async file=>{effects.push(['read',file]);try{return await fs.readFile(file,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}},
    writeTextFile:async(file,next,expected)=>{let actual=null;try{actual=sync.readFileSync(file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}if(actual!==expected)throw Object.assign(Error('stale'),{code:'STALE'});const temp=file+'.'+Math.random().toString(36).slice(2);sync.writeFileSync(temp,next);sync.renameSync(temp,file);},
    exec:async(cmd,args,options={})=>{
      effects.push(['exec',cmd,args,options.on??null]);
      if(cmd==='mkdir'){await fs.mkdir(args[1],{recursive:true});return {code:0,stdout:'',stderr:''};}
      if(cmd==='hc'&&args[0]==='get'){const raw=raws.get(args[1]);return raw?{code:0,stdout:JSON.stringify(raw)}:{code:1,stdout:''};}
      if(cmd==='test')return {code:sync.existsSync(args[1])?0:1,stdout:''};
      if(cmd==='herdr-app'&&args[0]==='do'){assert.equal(args[1],'tab.new');const input=JSON.parse(args[2]);created.push(input);return {code:0,stdout:JSON.stringify(addTab(input.folder,input.name))};}
      throw Error('Unexpected command '+cmd);
    }});
  const mount=(given={})=>{
    props=given;const cx=context(),timers=[],tasks=[];
    cx.timer.every=(ms,fn)=>{const timer={ms,fn,cancelled:false,cancel(){timer.cancelled=true;}};timers.push(timer);return timer;};
    // Like the host: a task body runs synchronously up to its first await.
    cx.spawn=fn=>{const task={done:false,loop:false,cancel(){task.cancelled=true;},is_done:()=>task.done};running=task;let value;try{value=fn(cx);}catch(error){value=Promise.reject(error);}finally{running=null;}task.promise=Promise.resolve(value).then(()=>{},()=>{}).finally(()=>{task.done=true;});tasks.push(task);return task;};
    const view=new Reopen();view.init(given,cx);const copy={view,cx,timers,tasks,render:()=>view.render(cx)};copies.push(copy);return copy;
  };
  const flush=async()=>{for(let i=0;i<40;i++){const open=copies.flatMap(c=>c.tasks).filter(x=>!x.loop&&!x.done);if(!open.length)return;await Promise.all(open.map(x=>x.promise));}};
  const tick=async(list=copies)=>{for(const c of list)for(const timer of c.timers)if(!timer.cancelled)timer.fn(c.cx);await flush();};
  const deliver=async command=>{const now=waiting.splice(0);for(const resolve of now)resolve(command);await new Promise(r=>setImmediate(r));await flush();return now.length;};
  const close=tab=>{const t=world.spaces[0].tabs.find(x=>x.id===tab);world.spaces[0].tabs=world.spaces[0].tabs.filter(x=>x!==t);raws.get('t'+tab.slice(4)).state='finished';};
  const journal=async()=>JSON.parse(await fs.readFile(path.join(home,'mission-control/closed.json'),'utf8'));
  const teardown=async()=>{for(const c of copies)await c.view.close();await deliver('shutdown');};
  return {dir,home,repo,world,effects,created,copies,mount,flush,tick,deliver,close,journal,teardown,shell:(folder=repo,name)=>addTab(folder,name)};
}

test('two mounted bar copies keep one lease-held watcher and record a close exactly once',async t=>{
  const f=await fixture(t);f.shell();f.shell();const a=f.mount(),b=f.mount();await f.flush();
  assert.deepEqual([a,b].map(c=>c.timers.map(x=>x.ms)),[[2000],[2000]]);
  for(let i=0;i<3;i++)await f.tick();
  const lease=(await f.journal()).lease.owner,owners=[a,b].map(c=>MOD+'-'+c.view.instance+'-watch');assert.ok(owners.includes(lease),lease);
  f.close('tab-2');for(let i=0;i<4;i++)await f.tick();
  const {records}=await f.journal();assert.equal(records.length,1);assert.equal(records[0].tab.id,'tab-2');assert.equal(records[0].kind,'shell');
  assert.equal((await f.journal()).lease.owner,lease,'no second observer took over a live lease');
  const idle=[a.cx.notifications,b.cx.notifications],revision=(await f.journal()).revision;for(let i=0;i<3;i++)await f.tick();
  assert.deepEqual([a.cx.notifications,b.cx.notifications],idle,'idle polls never redraw');assert.equal((await f.journal()).revision,revision,'idle polls write nothing');
  assert.ok(texts(a.render()).includes('Last closed: zsh · repo · This Mac'));
  await f.teardown();assert.equal((await f.journal()).lease,null,'closing the owning copy releases its lease');
});

test('a key command delivered to every shown copy reopens once, and the two commands stay distinct',async t=>{
  const f=await fixture(t);f.shell();f.shell(f.repo,'Logs');const a=f.mount(),b=f.mount();await f.flush();await f.tick();await f.tick();
  f.close('tab-1');f.close('tab-2');await f.tick();await f.tick();assert.equal((await f.journal()).records.length,2);
  assert.deepEqual(Object.keys(REOPEN_COMMANDS),['reopen-tab','reopen-agent']);
  assert.equal(await f.deliver('reopen-tab'),2,'both copies were waiting for the command');
  assert.equal(f.created.length,1);assert.deepEqual(f.created[0],{space:'space-A',folder:f.repo,name:'Logs'});assert.equal((await f.journal()).records.length,1);
  assert.ok(f.effects.some(([kind,name,args])=>kind==='run'&&name==='tab.select'&&args.id==='tab-3'));
  await f.deliver('reopen-agent');assert.equal(f.created.length,1,'shell-only tabs are skipped');
  const toasts=f.effects.filter(e=>e[0]==='notify');assert.equal(toasts.length,1);assert.equal(toasts[0][1].title,'Reopen last agent');assert.match(toasts[0][1].body,/Shell-only tabs are skipped/);
  await f.deliver('bogus');await f.deliver('open');await f.deliver('help');
  const overlays=f.effects.filter(e=>e[0]==='overlay').map(e=>[e[1].mod,e[1].kind,e[1].props.view]);assert.deepEqual(overlays,[[MOD,'popup','popup'],[MOD,'dialog','help']]);
  await f.deliver('reopen-tab');assert.equal(f.created.length,2);assert.equal((await f.journal()).records.length,0);
  await f.teardown();
});

test('an empty history is a clear disabled state; bar and popup clicks reopen through this mod alone',async t=>{
  const f=await fixture(t),bar=f.mount();const popup=f.mount({view:'popup',overlay:'overlay-popup'});await f.flush();await f.tick([bar]);
  let tree=bar.render();assert.match(texts(tree),/Nothing closed yet/);assert.match(texts(findElement(tree,'reopen-tab')),/No closed tab has been recorded yet/);assert.match(texts(findElement(tree,'reopen-agent')),/Shell-only tabs are skipped/);
  assert.throws(()=>trigger(tree,'reopen-tab','on_click',{},bar.cx),/Missing on_click/);assert.throws(()=>trigger(tree,'reopen-agent','on_click',{},bar.cx),/Missing on_click/);
  const empty=popup.render();assert.ok(findElement(empty,'reopen-empty'));assert.match(texts(empty),/Nothing to reopen yet/);assert.throws(()=>trigger(empty,'popup-reopen-tab','on_click',{},popup.cx),/Missing on_click/);
  f.shell();await f.tick([bar]);await f.tick([bar]);f.close('tab-1');await f.tick([bar]);await f.tick([popup]);
  assert.ok(findElement(popup.render(),'recent-'+(await f.journal()).records[0].id));
  trigger(popup.render(),'popup-reopen-tab','on_click',{},popup.cx);await f.flush();
  assert.equal(f.created.length,1);assert.ok(f.effects.some(e=>e[0]==='close'&&e[1]==='overlay-popup'),'a successful reopen closes the popup');
  await f.tick([bar]);await f.tick([bar]);f.close('tab-2');await f.tick([bar]);tree=bar.render();trigger(tree,'reopen-tab','on_click',{},bar.cx);await f.flush();assert.equal(f.created.length,2);
  assert.match(texts(bar.render()),/Reopened zsh · repo · This Mac/);
  await f.teardown();
});

test('a failed reopen shows its reason and recovery in the popup; Forget removes only that record',async t=>{
  const f=await fixture(t),gone=path.join(f.dir,'gone');await fs.mkdir(gone);f.shell(gone);f.shell();const bar=f.mount(),popup=f.mount({view:'popup'});await f.flush();await f.tick([bar]);await f.tick([bar]);
  f.close('tab-2');await f.tick([bar]);f.close('tab-1');await f.tick([bar]);await fs.rm(gone,{recursive:true});await f.tick([popup]);
  trigger(popup.render(),'popup-reopen-tab','on_click',{},popup.cx);await f.flush();
  let tree=popup.render();const result=findElement(tree,'reopen-result');assert.match(texts(result),/no longer exists/);assert.ok(findElement(tree,'recover-retry'));assert.equal(f.created.length,0);
  assert.equal((await f.journal()).records.length,2);assert.equal((await f.journal()).records[0].error.code,'FOLDER_MISSING');
  trigger(tree,'recover-dismiss','on_click',{},popup.cx);await f.flush();
  const left=(await f.journal()).records;assert.deepEqual(left.map(r=>r.tab.id),['tab-2']);
  tree=popup.render();assert.throws(()=>findElement(tree,'reopen-result'),/found 0/);assert.match(texts(findElement(tree,'popup-reopen-tab')),/zsh · repo · This Mac/);
  await f.teardown();
});

test('help shows every restore limit and both overlays belong to this mod; help does no IO',async t=>{
  const f=await fixture(t),bar=f.mount();await f.flush();
  trigger(bar.render(),'reopen-help','on_click',{},bar.cx);trigger(bar.render(),'reopen-more','on_click',{},bar.cx);
  const specs=f.effects.filter(e=>e[0]==='overlay').map(e=>e[1]);assert.deepEqual(specs.map(s=>[s.mod,s.kind,s.props.view]),[[MOD,'dialog','help'],[MOD,'popup','popup']]);
  const before=f.effects.length,help=f.mount({view:'help',overlay:'overlay-help'}),text=texts(help.render());
  for(const phrase of ['skips shell-only tabs','not its last cd','--last and --continue are never guessed','Split layout, extra panes and mod panes are not recorded','offline','last 100','No keys are bound by default','mission-control-reopen.reopen-tab'])assert.ok(text.includes(phrase),phrase);
  assert.equal(f.effects.length,before);assert.equal(help.timers.length,0);trigger(help.render(),'help-close','on_click',{},help.cx);assert.deepEqual(f.effects.at(-1),['close','overlay-help']);
  await f.teardown();
});

test('the standalone package bundles its own helpers: no sibling mods, no default keys, own artwork',async t=>{
  const built=await buildPackage(MOD),mod=built.directory,manifest=JSON.parse(await fs.readFile(path.join(mod,'mod.json'),'utf8'));
  assert.deepEqual((await fs.readdir(path.join(root,MOD,'mods'))),[MOD]);assert.equal(sync.existsSync(path.join(root,MOD,'layouts')),false);assert.equal(sync.existsSync(path.join(root,MOD,'keys.json')),false);
  assert.equal(manifest.build,undefined);assert.equal(manifest.place,'bottom');assert.deepEqual(manifest.overlay,{kind:'popup',width:340,height:440});
  const bundle=await fs.readFile(path.join(mod,'main.js'),'utf8');
  assert.deepEqual([...new Set([...bundle.matchAll(/^import .* from "([^"]+)";$/gm)].map(m=>m[1]))].sort(),['gpui-base','gpui-kit','herdr']);
  assert.ok(!/mods\/mission-control-(?!reopen)/.test(bundle),'no sibling mod path is read at runtime');assert.ok(!bundle.includes('setTimeout'));
  const source=await fs.readFile(path.join(root,'src/mods',MOD,'main.js'),'utf8'),declared=JSON.parse(await fs.readFile(path.join(root,'src/mods',MOD,'mod.json'),'utf8')).build.assets;
  // Every artwork name the view draws (static or chosen per row/result) is declared and shipped in the copied folder.
  const icons=['sessions','agent','folder','more','close','check'];for(const name of icons){assert.ok(source.includes(`'${name}'`),name);assert.ok(declared.includes(name),'declared '+name);}
  assert.deepEqual((await fs.readdir(path.join(mod,'assets'))).sort(),declared.map(n=>n+'.svg').sort());
  assert.match(await fs.readFile(path.join(mod,'NOTICE.md'),'utf8'),/Original Mission Control artwork/);
  const temp=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'mc-reopen-copy-')));t.after(()=>fs.rm(temp,{recursive:true,force:true}));const copy=path.join(temp,MOD);await fs.cp(mod,copy,{recursive:true});
  const native=new Set(['gpui-kit','gpui-base','herdr']),only=await build({entryPoints:[path.join(copy,'main.js')],bundle:true,platform:'neutral',format:'esm',write:false,metafile:true,logLevel:'silent',plugins:[{name:'copy-boundary',setup(b){b.onResolve({filter:/.*/},async args=>{if(native.has(args.path))return {path:args.path,external:true};if(args.kind!=='entry-point')throw Error('Unexpected runtime import '+args.path);return {path:await fs.realpath(args.path)};});}}]});
  assert.equal(Object.keys(only.metafile.inputs).length,1);
  // The tab bar bundles the same controller headlessly: it needs no GPUI module and no visible reopen panel.
  const headless=await build({entryPoints:[path.join(root,'src/shared/reopen.js')],bundle:true,platform:'neutral',format:'esm',write:false,logLevel:'silent',plugins:[{name:'no-native',setup(b){b.onResolve({filter:/^(gpui-kit|gpui-base|herdr)$/},args=>{throw Error('reopen.js must not import '+args.path);});}}]});
  assert.match(headless.outputFiles[0].text,/export \{[^}]*\bReopenController\b[^}]*\}/);assert.equal(typeof ReopenController.prototype.tick,'function');assert.equal(typeof ReopenController.prototype.run,'function');
});
