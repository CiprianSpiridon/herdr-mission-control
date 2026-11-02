import test from 'node:test';
import assert from 'node:assert/strict';
import Spaces from '../src/mods/mission-control-spaces/main.js';
import {injectNative,context,trigger,findElement} from './support/native-recording.mjs';
function fixture(props={}){
  const effects=[],jobs=[];const spaces=[{id:'A',name:'same-name',machine:null,active:true,branch:'main',tabs:[{id:'A-tab'}]},{id:'server/B',name:'same-name',machine:'server',active:false,branch:'main',tabs:[{id:'server/B-tab'}]}];let platform='macos',sessions=false;
  injectNative({props,spaces,panes:[{pane:'A-pane',tab:'A-tab',terminal:'t1',cwd:'/repo/A',focused:true},{pane:'B-pane',tab:'server/B-tab',terminal:'server/t2',cwd:'/repo/B',focused:false}],focused:{space:'A',pane:'A-pane'},machines:[{name:null,layout:'ready'},{name:'server',layout:'ready'}],window:()=>({platform}),appHome:'/qa',readTextFile:async p=>p.endsWith('mission-control-sessions/mod.json')&&sessions?'{"title":"Mission Control Sessions","place":"none"}':null,openOverlay:spec=>{effects.push(['overlay',spec]);return 'created-overlay';},closeOverlay:id=>{effects.push(['close',id]);return null;},run:(...args)=>{effects.push(['run',...args]);return null;},exec:async(cmd,args,options={})=>{
    effects.push(['exec',cmd,args,options]);if(cmd==='open')return {code:0,stdout:''};assert.equal(cmd,'git');const root=options.on==='server'?'/repo/B':'/repo/A';return {code:0,stdout:args.includes('--show-toplevel')?root+'\n':args.includes('--git-common-dir')?root+'/.git\n':'worktree '+root+'\0HEAD x\0\0'};
  }});
  const cx=context();cx.spawn=fn=>{const p=fn(cx);jobs.push(p);return p;};const view=new Spaces();view.init({},cx);
  return {view,cx,effects,spaces,flush:()=>Promise.all(jobs),platform:p=>platform=p,sessions:value=>sessions=value};
}
test('space rows capture right-click/ellipsis target and collapse only their own section',()=>{
  const f=fixture();trigger(f.view.render(f.cx),'space-more-server/B');let popup=f.effects.at(-1)[1];assert.equal(popup.mod,'mission-control-spaces');assert.equal(popup.props.spaceId,'server/B');assert.equal(popup.props.machine,'server');
  trigger(f.view.render(f.cx),'space-A','on_mouse_down',{});assert.equal(f.effects.at(-1)[1].props.spaceId,'A');
  trigger(f.view.render(f.cx),'spaces-toggle');assert.throws(()=>findElement(f.view.render(f.cx),'space-groups'),/found 0/);assert.equal(f.effects.filter(e=>e[0]==='run').length,0);
});
test('footer uses actual native Settings and Add machine commands',()=>{
  const f=fixture({view:'footer'});trigger(f.view.render(f.cx),'settings');trigger(f.view.render(f.cx),'add-machine');assert.deepEqual(f.effects,[['run','app.settings'],['run','mod.open',{name:'machine-add'}]]);
});
test('remote context launches on clicked repo/host and cannot open its remote path locally',async()=>{
  const f=fixture({view:'context',spaceId:'server/B',machine:'server',overlay:'context'});await f.flush();const tree=f.view.render(f.cx);assert.throws(()=>trigger(tree,'context-finder'),/Missing/);
  trigger(tree,'context-new-agent');const overlay=f.effects.findLast(e=>e[0]==='overlay')[1];assert.equal(overlay.mod,'mission-control-spaces');assert.equal(overlay.props.target.spaceId,'server/B');assert.equal(overlay.props.target.machine,'server');assert.equal(overlay.props.target.repoRoot,'/repo/B');assert.ok(!f.effects.some(e=>e[0]==='exec'&&e[1]==='open'));
});
test('Finder opens only validated local root on macOS; stale/deleted target has no actions',async()=>{
  const f=fixture({view:'context',spaceId:'A',machine:null,overlay:'context'});await f.flush();await trigger(f.view.render(f.cx),'context-finder');assert.deepEqual(f.effects.find(e=>e[0]==='exec'&&e[1]==='open'),['exec','open',['/repo/A'],{}]);
  const other=fixture({view:'context',spaceId:'missing',machine:null});await other.flush();assert.throws(()=>trigger(other.view.render(other.cx),'context-new-agent'),/Missing/);assert.ok(!other.effects.some(e=>e[0]==='overlay'));
});
test('optional Sessions integration is absent standalone and preserves clicked target when installed',async()=>{
  const absent=fixture({view:'context',spaceId:'A',machine:null});await absent.flush();assert.throws(()=>findElement(absent.view.render(absent.cx),'context-sessions'),/found 0/);
  const present=fixture({view:'context',spaceId:'server/B',machine:'server',overlay:'context'});present.sessions(true);await present.flush();trigger(present.view.render(present.cx),'context-sessions');
  const spec=present.effects.findLast(e=>e[0]==='overlay')[1];assert.equal(spec.mod,'mission-control-sessions');assert.equal(spec.props.target.spaceId,'server/B');assert.equal(spec.props.target.machine,'server');assert.equal(spec.props.target.repoRoot,'/repo/B');
});
