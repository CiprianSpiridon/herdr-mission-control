import test from 'node:test';
import assert from 'node:assert/strict';
import {LaunchDialog,quickStart} from '../src/shared/launch-dialog.js';
import {parseCapabilities} from '../src/shared/tool-capabilities.js';
import {injectNative,trigger,context,findElement} from './support/native-recording.mjs';
function fixture(){
  injectNative();const files=new Map(),calls=[],effects=[],world={spaces:[{id:'A',name:'client-portal',machine:null,folder:'/stale/wrong-folder',tabs:[{id:'A-tab'}]},{id:'B',name:'other',machine:null,tabs:[{id:'B-tab'}]}]};let active='A',created=0,unbound=false,ambiguous=false;
  const tools=['claude','codex','grok','kiro','cursor'].map(key=>({key,name:key,installed:true,run:['qa-'+key],icon:null}));
  files.set('/qa/mission-control/config.json',JSON.stringify({v:1,revision:0,connections:{},bindings:{},preferences:{launch:{v:1,pins:['claude','codex','grok'],hidden:[],worktree:false,tools:{}}},usageSources:{}}));
  const raws=new Map();const io={appHome:()=>'/qa',clock:()=>1000,capabilities:{get:async tool=>parseCapabilities(tool,{help:tool.key==='claude'?'Claude Code\nUsage: claude [options] [prompt]\n --model <model>':tool.key==='codex'?'Codex CLI\nUsage: codex [OPTIONS] [PROMPT]\n --model <MODEL>\n --no-daemon':'Grok Build TUI\nUsage: grok [OPTIONS] [PROMPT]\n --model <MODEL>'})},knownAgents:async()=>tools,focused:()=>({space:active}),spaces:()=>world.spaces,
    panes:()=>[{pane:'pane-A',tab:'A-tab',terminal:'t1',cwd:'/repo/A-linked',focused:!ambiguous},...(ambiguous?[{pane:'pane-other',tab:'A-tab',terminal:'t2',cwd:'/repo/B',focused:false}]:[])],
    readTextFile:async p=>files.get(p)??null,writeTextFile:async(p,next,expected)=>{if((files.get(p)??null)!==expected)throw Object.assign(Error('stale'),{code:'STALE'});files.set(p,next);},ensureDirectory:async()=>{},run:(...args)=>effects.push(args),closeOverlay:id=>effects.push(['closeOverlay',id]),openOverlay:spec=>effects.push(['openOverlay',spec]),
    exec:async(cmd,args,options={})=>{
      calls.push({cmd,args,options});
      if(cmd==='python3'){
        const q=JSON.parse(args[2]);
        if(q.action==='prepare')return {code:0,stdout:JSON.stringify({ok:true,spec:{v:1,...Object.fromEntries(['requestId','originId','machine','repoRoot','checkoutRoot','sourceKey','path','branch','leaf'].map(k=>[k,q[k]])),base:'a'.repeat(40)}})};
        if(q.action==='create')return {code:0,stdout:JSON.stringify({ok:true,folder:q.spec.path,reused:false,spec:q.spec})};
      }
      if(cmd==='git'){
        if(unbound)return {code:128,stdout:''};
        const cwd=args[0]==='-C'?args[1]:options.cwd,root=cwd?.startsWith('/repo/B')?'/repo/B':'/repo/A';
        return {code:0,stdout:args.includes('--show-toplevel')?cwd+'\n':args.includes('--git-common-dir')?root+'/.git\n':`worktree ${root}\0HEAD a\0\0worktree ${root}-linked\0HEAD a\0\0`};
      }
      if(cmd==='herdr-app'&&args[0]==='do'){
        created++;const params=JSON.parse(args[2]),space=world.spaces.find(s=>s.id===params.space),tab='created-'+created,address='t'+(created+10);space.tabs.push({id:tab,name:params.name,named:true,terminals:[{terminal:address}]});raws.set(address,{address,created_ms:created,foreground:{pid:created+500},argv:params.argv,labels:{'herdr.space':params.space,'herdr.tab':tab}});
        return {code:0,stdout:JSON.stringify({space:params.space,tab,terminal:address})};
      }
      if(cmd==='herdr-app'&&args[0]==='ls')return {code:0,stdout:JSON.stringify(world)};
      if(cmd==='hc')return {code:0,stdout:JSON.stringify(raws.get(args[1]))};
      throw Error('Unexpected fixture process '+cmd);
    }};
  return {io,files,calls,effects,created:()=>created,setActive:id=>active=id,setUnbound:()=>unbound=true,setAmbiguous:()=>ambiguous=true};
}
test('generic dialog captures live linked checkout, asks choices and ignores later active space changes',async()=>{
  const f=fixture(),dialog=new LaunchDialog('mission-control-agent-menu',{view:'launch',spaceId:'A',machine:null,overlay:'own-overlay'},f.io),cx=context();await dialog.init(cx);
  assert.equal(dialog.target.repoRoot,'/repo/A');assert.equal(dialog.target.checkoutRoot,'/repo/A-linked');assert.equal(dialog.worktree,false);
  trigger(dialog.render(cx),'new-worktree');assert.equal(dialog.worktree,true);trigger(dialog.render(cx),'current-checkout');assert.equal(dialog.worktree,false);
  f.setActive('B');await trigger(dialog.render(cx),'start-agent');assert.equal(f.created(),1);const call=f.calls.find(c=>c.cmd==='herdr-app'&&c.args[0]==='do'),params=JSON.parse(call.args[2]);assert.equal(params.space,'A');assert.equal(params.folder,'/repo/A-linked');assert.deepEqual(f.effects.at(-1),['closeOverlay','own-overlay']);
  assert.ok(f.calls.filter(c=>c.cmd==='git').every(c=>!JSON.stringify(c.args).includes('stale')));
});
for(const name of ['', 'clean up website content'])test(`space New agent starts a new worktree with ${name?'a friendly name':'automatic naming'}`,async()=>{
  const f=fixture(),dialog=new LaunchDialog('mission-control-spaces',{view:'launch',spaceId:'A',machine:null,overlay:'own-overlay'},f.io),cx=context();await dialog.init(cx);
  trigger(dialog.render(cx),'new-worktree');dialog.path.set_value(name);f.setActive('B');
  await trigger(dialog.render(cx),'start-agent');
  assert.equal(f.created(),1,dialog.error);
  const q=JSON.parse(f.calls.find(c=>c.cmd==='python3'&&JSON.parse(c.args[2]).action==='prepare').args[2]);
  assert.equal(q.repoRoot,'/repo/A');assert.equal(q.checkoutRoot,'/repo/A-linked');assert.equal(q.machine,null);
  assert.match(q.path,name?/^\/repo\/\.herdr-worktrees\/client-portal-clean-up-website-content$/:/^\/repo\/\.herdr-worktrees\/client-portal-task-/);
  assert.equal(q.branch,'mission-control/'+q.path.split('/').pop());
  const tab=JSON.parse(f.calls.find(c=>c.cmd==='herdr-app'&&c.args[0]==='do').args[2]);
  assert.equal(tab.space,'A');assert.equal(tab.folder,q.path);assert.deepEqual(f.effects.at(-1),['closeOverlay','own-overlay']);
});
test('invalid relative worktree paths show an inline message and cannot start a process',async()=>{
  const f=fixture(),dialog=new LaunchDialog('mission-control-spaces',{view:'launch',spaceId:'A'},f.io),cx=context();await dialog.init(cx);
  trigger(dialog.render(cx),'new-worktree');dialog.path.set_value('../somewhere');
  const error=findElement(dialog.render(cx),'worktree-location');assert.ok(error.nodes.some(v=>typeof v==='string'&&v.includes('Enter a worktree name')));
  assert.equal(findElement(dialog.render(cx),'start-agent').handlers.on_click,undefined);
  await dialog.start(cx);assert.equal(f.created(),0);assert.ok(!f.calls.some(c=>c.cmd==='python3'));
});
test('ambiguous or unbound live repo blocks creation and leaves an actionable error',async()=>{
  for(const flag of ['setUnbound','setAmbiguous']){const f=fixture();f[flag]();const dialog=new LaunchDialog('mission-control-agent-menu',{view:'launch',spaceId:'A'},f.io),cx=context();await dialog.init(cx);assert.equal(dialog.target,null);assert.ok(dialog.error);await dialog.start(cx);assert.equal(f.created(),0);assert.ok(!f.calls.some(c=>c.cmd==='herdr-app'));}
});
test('originating focused pane is captured before the overlay takes keyboard focus',async()=>{
  const f=fixture();f.io.spaces()[0].tabs.push({id:'A-aux'});let overlayFocused=false;
  f.io.panes=()=>[{pane:'main',tab:'A-tab',terminal:'t1',cwd:'/repo/A',focused:false},{pane:'linked',tab:'A-aux',terminal:'t2',cwd:'/repo/A-linked',focused:!overlayFocused}];
  const cx=context();cx.focus_handle=()=>({focus(){overlayFocused=true;}});
  const dialog=new LaunchDialog('mission-control-agent-menu',{view:'launch',spaceId:'A'},f.io);await dialog.init(cx);
  assert.equal(overlayFocused,true);assert.equal(dialog.target.checkoutRoot,'/repo/A-linked');assert.equal(dialog.target.repoRoot,'/repo/A');
});
test('native shortcut settings persist pin changes/order and keep overflow tools available',async()=>{
  const f=fixture(),dialog=new LaunchDialog('mission-control-agent-menu',{view:'settings',spaceId:'A'},f.io),cx=context();await dialog.init(cx);
  trigger(dialog.render(cx),'pin-claude');trigger(dialog.render(cx),'pin-kiro');trigger(dialog.render(cx),'earlier-kiro');await trigger(dialog.render(cx),'save-shortcuts');
  const p=JSON.parse(f.files.get('/qa/mission-control/config.json')).preferences.launch;assert.deepEqual(p.pins,['codex','kiro','grok']);assert.equal(p.worktree,false);assert.ok(findElement(dialog.render(cx),'choose-cursor'));
});
test('unsupported launch options preserve the form and cannot create a tab',async()=>{
  const f=fixture(),dialog=new LaunchDialog('mission-control-agent-menu',{view:'launch',spaceId:'A'},f.io),cx=context();await dialog.init(cx);dialog.reasoning.set_value('high');await dialog.start(cx);assert.equal(f.created(),0);assert.match(dialog.error,/Reasoning selection/);assert.equal(dialog.reasoning.value(),'high');
});
test('pinned issue quick start uses saved defaults directly with captured target and no dialog',async()=>{
  const f=fixture(),target={spaceId:'A',machine:null,repoRoot:'/repo/A',checkoutRoot:'/repo/A-linked'},source={kind:'jira',connectionId:'work',site:'https://jira.example.invalid',id:'10001',key:'WEB-142',title:'Fix login',url:'https://jira.example.invalid/browse/WEB-142'};
  f.setActive('B');const result=await quickStart({target,source,toolKey:'claude'},f.io);assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.folder,target.checkoutRoot);assert.equal(f.effects.filter(e=>e[0]==='openOverlay').length,0);
  const missing=await quickStart({target,source,toolKey:'kiro'},f.io);assert.equal(missing.code,'SHORTCUT_UNAVAILABLE');assert.equal(f.created(),1);
});
