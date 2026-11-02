import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {TextareaState,Textarea,InputState,context,div,View,list,Scrollbar,renderRecorded,invalidateRecordedContext,trigger} from './support/native-recording.mjs';

test('opt-in loader executes a real View handler with the captured repo identity',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'native-contract-'));
  try {
    const recorder=new URL('./support/native-recording.mjs',import.meta.url).href;
    await fs.writeFile(path.join(dir,'probe.mjs'),`import {View,div} from 'gpui-kit';import {spaces,run} from 'herdr';
      export default class Probe extends View {render(){const captured=spaces()[0];return div().id('launch').on_click(()=>run('tab.new',{space:captured.id}));}}`);
    await fs.writeFile(path.join(dir,'test.mjs'),`import assert from 'node:assert/strict';import Probe from './probe.mjs';
      import {injectNative,nativeEffects,trigger,div} from ${JSON.stringify(recorder)};
      let current=[{id:'repo-A'}];injectNative({spaces:()=>current,run:()=>null});
      const tree=new Probe().render();current=[{id:'repo-B'}];trigger(tree,'launch');
      assert.equal(nativeEffects()[0].args[1].space,'repo-A');
      assert.throws(()=>trigger(tree,'missing'),/found 0/);
      assert.throws(()=>trigger(div().id('empty'),'empty'),/Missing on_click/);
      assert.throws(()=>div().invented_api(),/Unsupported GPUI API/);`);
    const r=spawnSync(process.execPath,['--import',new URL('./support/native-loader.mjs',import.meta.url).pathname,path.join(dir,'test.mjs')],{encoding:'utf8'});
    assert.equal(r.status,0,r.stderr||r.stdout);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('documented native textarea state retains multiline edits and rejects unsupported APIs',()=>{
  const state=TextareaState.new({value:'{\n  "site": "https://jira.example.net"\n}',rows:5}),first=Textarea.new(state).id('profile-json').h(140);let changed;
  state.on('change',(_event,cx)=>{changed=JSON.parse(state.value()).site;cx.notify();});state.set_value('{\n  "site": "https://other.example.net"\n}');state.listeners[0].fn({},context());
  assert.equal(changed,'https://other.example.net');assert.equal(Textarea.new(state).value,first.value);assert.equal(state.rows,5);state.set_auto_grow(3,8);state.set_soft_wrap(false);assert.deepEqual(state.autoGrow,{min:3,max:8});assert.equal(state.softWrap,false);
  assert.throws(()=>TextareaState.new({invented:true}),/Unsupported/);assert.throws(()=>Textarea.new(InputState.new()),/retained multiline/);assert.throws(()=>Textarea.new(state).invented_api(),/Unsupported GPUI API/);assert.equal(state.release(),true);
});

test('native child union accepts supported scalars and rejects missing or raw object children',()=>{
  for(const value of [false,true,42,'text'])assert.deepEqual(div().child(value).nodes,[value]);
  for(const value of [null,undefined,{},[]])assert.throws(()=>div().child(value),/expects a native element, entity or scalar/);
  assert.throws(()=>div().children([div(),null]),/expects a native element, entity or scalar/);
  const tree=div().child('Visible').child(div()).when(false,el=>el.child(null));assert.equal(tree.nodes.length,2);
});

test('retained Views update captured handlers, release children and reject foreign/duplicate mounts',async()=>{
  const cx=context(),events=[],closed=[];class Child extends View{init(p){this.update(p);}update(p){this.p=p;}render(){const captured=this.p.target;return div().id('child').on_click(()=>events.push(captured)).child(captured);}close(){closed.push(this.p.target);}}
  const entity=cx.new(Child,{target:'repo-A'}),shell=()=>div().child(entity),old=renderRecorded(shell(),cx);entity.set_props({target:'repo-B'});trigger(old,'child');trigger(renderRecorded(shell(),cx),'child');assert.deepEqual(events,['repo-A','repo-B']);
  assert.throws(()=>renderRecorded(div().child(entity).child(entity),cx),/Duplicate retained/);const other=context();assert.throws(()=>renderRecorded(div().child(entity),other),/Foreign retained/);assert.throws(()=>other.notify(entity),/Foreign retained/);
  class Invalid extends View{render(call){call.new(Child,{target:'bad'});return div();}}assert.throws(()=>renderRecorded(new Invalid(),cx),/forbidden during render/);
  class InvalidUpdate extends View{render(){entity.set_props({target:'bad'});return div();}}assert.throws(()=>renderRecorded(new InvalidUpdate(),cx),/forbidden during render/);
  assert.equal(entity.release(),true);assert.equal(entity.release(),false);assert.deepEqual(closed,['repo-B']);assert.throws(()=>entity.set_props({target:'bad'}),/Released/);assert.throws(()=>div().child(entity),/Released/);assert.throws(()=>trigger(old,'child'),/closed/);assert.deepEqual(events,['repo-A','repo-B']);
  invalidateRecordedContext(cx);invalidateRecordedContext(other);
});

test('lazy materialization renders only the explicit range and child handlers remain outside layout',()=>{
  const cx=context(),rendered=[],clicked=[];class Child extends View{init(p){this.p=p;}render(){rendered.push(this.p.index);return div().id('card-'+this.p.index).on_click(()=>clicked.push(this.p.index)).child('Card '+this.p.index);}}
  const entities=Array.from({length:120},(_,index)=>cx.new(Child,{index})),tree=div().child(list('cards',120,index=>'item-'+index,index=>div().child(entities[index]))).child(Scrollbar.vertical('cards'));
  const first=renderRecorded(tree,cx,{range:()=>[0,2]});assert.deepEqual(rendered,[0,1]);trigger(first,'card-1');assert.deepEqual(clicked,[1]);assert.throws(()=>trigger(first,'card-119'),/found 0/);
  const last=renderRecorded(tree,cx,{range:()=>[118,120]});assert.deepEqual(rendered,[0,1,118,119]);trigger(last,'card-119');assert.deepEqual(clicked,[1,119]);assert.throws(()=>renderRecorded(tree,cx),/explicit recorded lazy range/);assert.throws(()=>renderRecorded(tree,cx,{range:()=>[0,121]}),/Invalid recorded lazy range/);
  for(const render of [()=>div().on_click(()=>{}),()=>div().child(cx.new(Child,{index:4})),(_index,call)=>{call.notify();return div();},()=>div().child(Textarea.new(TextareaState.new()))])assert.throws(()=>renderRecorded(list('bad',1,()=> 'one',render),cx,{range:()=>[0,1]}),/forbidden/);
  invalidateRecordedContext(cx);assert.throws(()=>renderRecorded(last,cx),/closed/);
});

function scheduler(){const pending=[];return {pending,scheduleSleep:(ms,owner)=>new Promise(resolve=>pending.push({ms,owner,resolve}))};}

test('ordinary event/render Context expires on return/await while AsyncContext resumes in task phase',async()=>{
  const s=scheduler(),cx=context({scheduleSleep:s.scheduleSleep});let saved,renderContext,renderSleep;
  class ButtonView extends View{render(call){renderContext=call;renderSleep=call.sleep(0);return div().id('event').on_click(async(_e,eventCx)=>{saved=eventCx;await eventCx.sleep(0);eventCx.notify();});}}
  const tree=renderRecorded(new ButtonView(),cx);assert.throws(()=>renderContext.phase(),/Stale/);s.pending.shift().resolve();await renderSleep;assert.throws(()=>renderContext.notify(),/Stale/);
  const failed=trigger(tree,'event'),rejected=assert.rejects(failed,/Stale recorded context/);assert.throws(()=>saved.new(ButtonView),/Stale/);s.pending.shift().resolve();await rejected;assert.equal(cx.notifications,0);
  let phase,owner;const task=cx.spawn(async asyncCx=>{owner=s.pending.length;await asyncCx.sleep(0);phase=asyncCx.phase();asyncCx.notify();return asyncCx.new(ButtonView);});assert.equal(task.is_done(),false);assert.equal(s.pending[0].owner>0,true);s.pending.shift().resolve();const child=await task;assert.equal(phase,'task');assert.equal(cx.notifications,1);assert.equal(task.is_done(),true);assert.equal(owner,0);child.release();invalidateRecordedContext(cx);
});

test('deterministic yields reject closed owners and prevent stale preparation from updating or publishing children',async()=>{
  const s=scheduler(),cx=context({scheduleSleep:s.scheduleSleep}),updates=[],closed=[];let generation=0,published;
  class Child extends View{init(p){this.p=p;}update(p){updates.push(p.id);this.p=p;}render(){return div().child(this.p.id);}close(){closed.push(this.p.id);}}
  const prepare=id=>{const epoch=++generation;return cx.spawn(async taskCx=>{const child=taskCx.new(Child,{id});await taskCx.sleep(0);if(epoch!==generation){child.release();return null;}child.set_props({id:id+'-ready'});published=child;return child;});};
  const first=prepare('old'),second=prepare('new');s.pending[1].resolve();const current=await second;assert.strictEqual(published,current);s.pending[0].resolve();assert.equal(await first,null);assert.deepEqual(updates,['new-ready']);assert.deepEqual(closed,['old']);assert.deepEqual(renderRecorded(div().child(current),cx).nodes[0].nodes,['new-ready']);
  const pending=cx.spawn(async taskCx=>{await taskCx.sleep(0);taskCx.notify();});const rejected=assert.rejects(pending,/owner is closed/);invalidateRecordedContext(cx);s.pending[2].resolve();await rejected;assert.ok(closed.includes('new-ready'));assert.throws(()=>cx.phase(),/closed/);assert.throws(()=>current.set_props({id:'late'}),/Released/);
});

test('virtual module namespaces reject valid symbols imported from the wrong native module',()=>{
  for(const [module,name]of [['gpui-kit','Scrollbar'],['gpui-base','View'],['herdr','InputState']]){const result=spawnSync(process.execPath,['--import',new URL('./support/native-loader.mjs',import.meta.url).pathname,'--input-type=module','-e',`import {${name}} from ${JSON.stringify(module)};console.log(${name});`],{encoding:'utf8'});assert.notEqual(result.status,0);assert.match(result.stderr,/does not provide an export/);}
});

test('explicit fixture schedulers and propagation spies retain the strict event/task lifetime boundary',async()=>{
  const cx=context(),pending=[];let stopped=0,event,phase;cx.stop_propagation=()=>stopped++;cx.spawn=body=>{const promise=Promise.resolve().then(()=>body(cx));pending.push(promise);return promise;};
  const tree=div().id('scheduled').on_click((_e,call)=>{event=call;call.stop_propagation();call.spawn(async task=>{await task.sleep(0);phase=task.phase();task.notify();});});trigger(tree,'scheduled',undefined,{},cx);assert.equal(stopped,1);assert.throws(()=>event.phase(),/Stale/);await Promise.all(pending);assert.equal(phase,'task');assert.equal(cx.notifications,1);invalidateRecordedContext(cx);
});
