import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import AgentMenu from '../src/mods/mission-control-agent-menu/main.js';
import {injectNative,trigger,context} from './support/native-recording.mjs';
function nativeFixture({empty=false,offline=false}={}){
  const files=new Map(),effects=[],jobs=[];let current='A';
  injectNative({props:{overlay:'own',spaceId:'A'},spaces:[{id:'A',name:'client-portal',machine:null,tabs:[{id:'tab-A'}]}],focused:()=>({space:current}),panes:[{pane:'pane-A',tab:'tab-A',terminal:'t1',cwd:'/repo',focused:true}],appHome:'/qa',readTextFile:async p=>files.get(p)??null,writeTextFile:async(p,next,expected)=>{assert.equal(files.get(p)??null,expected);files.set(p,next);},knownAgents:async()=>{if(offline)throw Error('Machine unavailable');return empty?[]:[{key:'claude',name:'Claude Code',run:['claude'],installed:true,icon:'icons/claude.svg',tint:true}];},exec:async(cmd,args)=>{
    if(cmd==='git')return {code:0,stdout:args.includes('--show-toplevel')?'/repo\n':args.includes('--git-common-dir')?'/repo/.git\n':'worktree /repo\0HEAD a\0\0'};
    if(cmd==='claude')return {code:0,stdout:args.includes('--help')?'Claude Code\nUsage: claude [options] [prompt]\n --model <model>':'claude test'};
    if(cmd==='mkdir')return {code:0,stdout:''};throw Error('Unexpected '+cmd);
  },run:(...args)=>{effects.push(args);return null;},closeOverlay:id=>{effects.push(['closeOverlay',id]);return null;}});
  const cx=context();cx.spawn=fn=>{const p=fn(cx);jobs.push(p);return p;};
  return {cx,effects,flush:()=>Promise.all(jobs),changeSpace:id=>current=id};
}
test('standalone entry opens its own menu/settings/launch roles with captured destination',async()=>{
  const f=nativeFixture(),view=new AgentMenu();view.init({overlay:'wrong-init',spaceId:'wrong-init'},f.cx);await f.flush();
  let tree=view.render(f.cx);assert.equal(view.dialog.target.spaceId,'A');
  await trigger(tree,'choose-claude');assert.equal(view.dialog.view,'launch');f.changeSpace('B');assert.equal(view.dialog.target.spaceId,'A');
  trigger(view.render(f.cx),'shortcuts');assert.equal(view.dialog.view,'settings');trigger(view.render(f.cx),'close-dialog');assert.deepEqual(f.effects.at(-1),['closeOverlay','own']);view.close();
});
test('empty/offline target keeps close available and cannot start',async()=>{
  for(const options of [{empty:true},{offline:true}]){const f=nativeFixture(options),view=new AgentMenu();view.init({overlay:'own',spaceId:'A'},f.cx);await f.flush();assert.equal(view.dialog.selected,null);assert.equal(await view.dialog.start(f.cx),undefined);trigger(view.render(f.cx),'close-dialog');assert.deepEqual(f.effects.at(-1),['closeOverlay','own']);view.close();}
});
test('popup shortcuts are local handlers and text entry does not launch/select tools',async()=>{
  const f=nativeFixture(),view=new AgentMenu();view.init({overlay:'own',spaceId:'A'},f.cx);await f.flush();view.dialog.typingSearch=true;
  trigger(view.render(f.cx),'launch-dialog','on_key_down',{key:'1',keystroke:'1'});assert.equal(view.dialog.view,'menu');view.dialog.typingSearch=false;
  await trigger(view.render(f.cx),'launch-dialog','on_key_down',{key:'1',keystroke:'1'});assert.equal(view.dialog.view,'launch');assert.ok(!f.effects.some(e=>e[0].includes('key')));view.close();
});
test('manifest uses native overlay metadata and no default sibling dependency',async()=>{
  const m=JSON.parse(await fs.readFile(new URL('../src/mods/mission-control-agent-menu/mod.json',import.meta.url),'utf8'));assert.equal(m.place,'none');assert.equal(m.overlay.kind,'dialog');assert.equal(m.overlay.width,560);
});
