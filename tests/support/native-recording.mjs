// Contract recorder, deliberately not a renderer. Unsupported APIs throw.
import {AsyncLocalStorage} from 'node:async_hooks';
const scope=new AsyncLocalStorage(),contexts=new WeakMap();let ownerSequence=0;
const stateFor=cx=>{const record=contexts.get(cx);if(!record)throw Error('Foreign recorded context');return record;};
function usable(record){if(!record.owner.active||record.task?.active===false)throw Error('Recorded owner is closed');if(record.call&&!record.call.active)throw Error('Stale recorded context');}
function phaseFor(record){const call=scope.getStore();return call?.owner===record.owner?call.phase:record.phase;}
function effectAllowed(record){usable(record);const current=scope.getStore();if(current?.call&&!current.call.active)throw Error('Stale recorded context');if(['render','layout'].includes(phaseFor(record)))throw Error('Native effect is forbidden during render/layout');}
function implicitScope(){const current=scope.getStore();if(current?.call&&!current.call.active)throw Error('Stale recorded context');if(current?.owner&&!current.owner.active||current?.task?.active===false)throw Error('Recorded owner is closed');return current;}
function handlerAllowed(){if(implicitScope()?.phase==='layout')throw Error('Handlers are forbidden during lazy layout');}
function retainedAllowed(){if(['render','layout'].includes(implicitScope()?.phase))throw Error('Retained state is forbidden during render/layout');}
function callScoped(owner,phase,fn,template){if(!owner.active)throw Error('Recorded owner is closed');const call={active:true},cx=makeContext({owner,phase,call},template);try{return scope.run({owner,phase,call,cx},()=>fn(cx));}finally{call.active=false;}}
function ownerRoot(owner){while(owner.parent)owner=owner.parent;return owner;}
function foreignEntity(entity){const current=scope.getStore();if(current&&ownerRoot(current.owner)!==ownerRoot(entity.owner))throw Error('Foreign retained entity');}
function asyncScoped(record,fn,template){const cx=makeContext({...record,call:null,phase:'task'},template);return scope.run({owner:record.owner,phase:'task',task:record.task,cx},()=>fn(cx));}
const chains = new Set(`size size_full w_full h_full flex flex_1 flex_none flex_shrink_0 min_w_0 min_h_0 w h min_w max_w min_h max_h gap p px py pt pb pl pr m mx my mt mb ml mr items_center items_start items_end justify_center justify_between justify_end bg border border_b border_t border_l border_r border_color rounded rounded_full text_size text_color font_semibold font_bold font_family truncate overflow_hidden overflow_y_scroll overflow_y_scrollbar overflow_x_scroll cursor_pointer opacity absolute relative top left right bottom shadow_sm shadow_md whitespace_nowrap line_height tooltip accessibility_label role track_focus key_context`.split(' '));
const handlers = new Set(['on_click','on_mouse_down','on_mouse_up','on_key_down','on_hover','on_size_change','on_scroll_wheel','on_drop']);
export class Element {
  constructor(kind, value) {
    this.kind=kind; this.value=value; this.nodes=[]; this.calls=[]; this.handlers={}; this.semanticId=null;
    return new Proxy(this,{get(target,key,receiver){
      if (typeof key==='symbol' || key in target) return Reflect.get(target,key,receiver);
      if(chains.has(key)) return (...args)=>{target.calls.push({method:key,args});return receiver;};
      if(handlers.has(key)) return (...args)=>{handlerAllowed();const fn=args.at(-1);if(typeof fn!=='function')throw Error(`Missing ${key} callback`);target.handlers[key]={args:args.slice(0,-1),fn,owner:scope.getStore()?.owner};return receiver;};
      if(key==='then') return undefined;
      throw Error(`Unsupported GPUI API: ${String(key)}`);
    }});
  }
  id(value){if(typeof value!=='string'||!value)throw Error('A semantic ID is required');this.semanticId=value;return this;}
  child(value){if(value instanceof RecordedEntity){value.assertLive();foreignEntity(value);}else if(!['string','number','boolean'].includes(typeof value)&&!(value instanceof Element))throw Error('child(value) expects a native element, entity or scalar');this.nodes.push(value);return this;}
  children(values){for(const v of values.flat(Infinity))this.child(v);return this;}
  when(condition,fn){return condition ? fn(this) : this;}
  hover(fn){fn(new Element('hover'));return this;}
  active(fn){fn(new Element('active'));return this;}
  focus(fn){fn(new Element('focus'));return this;}
}
export class View {}
export class RecordedEntity {
  constructor(Class,props,parent){if(typeof Class!=='function'||!(Class.prototype instanceof View))throw Error('A native View subclass is required');this.parent=parent;this.owner={id:++ownerSequence,active:true,parent,scheduleSleep:parent.scheduleSleep,entities:new Set(),tasks:new Set(),notifications:0};this.instance=new Class(props);this.released=false;parent.entities.add(this);try{asyncScoped({owner:this.owner},cx=>this.instance.init?.(props,cx));}catch(error){this.release();throw error;}}
  assertLive(){if(this.released||!this.owner.active||!this.parent.active)throw Error('Released or foreign retained entity');}
  set_props(props){this.assertLive();foreignEntity(this);const current=implicitScope();if(['render','layout'].includes(current?.phase))throw Error('Child updates are forbidden during render/layout');asyncScoped({owner:this.owner},()=>this.instance.update?.(props));}
  release(){if(this.released)return false;this.released=true;for(const entity of [...this.owner.entities])entity.release();for(const task of this.owner.tasks)task.active=false;this.owner.active=false;this.parent.entities.delete(this);this.instance.close?.();return true;}
}
export function list(id,count,getKey,render){if(!['string','number'].includes(typeof id)||!Number.isSafeInteger(count)||count<0||typeof getKey!=='function'||typeof render!=='function')throw Error('Invalid native list contract');return new Element('list',{id,count,getKey,render}).id(String(id));}
export const Scrollbar={vertical:id=>new Element('Scrollbar.vertical',id)};
export const div=()=>new Element('div');
export const h_flex=()=>new Element('h_flex');
export const v_flex=()=>new Element('v_flex');
export const svg=value=>new Element('svg',value);
export const image=value=>new Element('image',value);
export class InputState {
  static new(...args){return new InputState(...args);}
  constructor(options={}){retainedAllowed();this.text=options.value??'';this.listeners=[];}
  value(){return this.text;}
  set_value(value){this.text=value;}
  placeholder(value){this.placeholderText=value;return this;}
  on(event,fn){this.listeners.push({event,fn});return true;}
  focus(){}
  release(){return true;}
}
export const Input={new:state=>new Element('Input',state)};
export class TextareaState extends InputState {
  static new(options={}){return new TextareaState(options);}
  constructor(options={}){if(Object.keys(options).some(key=>!['placeholder','value','rows'].includes(key)))throw Error('Unsupported TextareaState option');super(options);this.set_rows(options.rows??3);this.softWrap=true;}
  set_rows(rows){if(!Number.isInteger(rows)||rows<1)throw Error('Textarea rows must be positive');this.rows=rows;}
  set_auto_grow(min,max){if(!Number.isInteger(min)||!Number.isInteger(max)||min<1||max<min)throw Error('Invalid textarea row bounds');this.autoGrow={min,max};}
  set_soft_wrap(wrap){if(typeof wrap!=='boolean')throw Error('Textarea wrap must be boolean');this.softWrap=wrap;}
}
export const Textarea={new:state=>{if(!(state instanceof TextareaState))throw Error('Textarea needs retained multiline state');return new Element('Textarea',state);}};
export const Button={new:id=>new Element('Button').id(id)};

let injected={}, effects=[], stored=new Map();
export function injectNative(values={}){injected=values;effects=[];stored=new Map(Object.entries(values.shared??{}));}
export const nativeEffects=()=>effects;
const snapshot=(name,fallback)=>{const v=injected[name];return typeof v==='function'?v():v??fallback;};
const effect=(name,...args)=>{effects.push({name,args});if(typeof injected[name]!=='function')throw Error(`No injected Herdr effect: ${name}`);return injected[name](...args);};
export const spaces=()=>snapshot('spaces',[]), agents=()=>snapshot('agents',[]), panes=()=>snapshot('panes',[]), terminals=()=>snapshot('terminals',[]), machines=()=>snapshot('machines',[]);
export const focused=()=>snapshot('focused',null), layout=()=>snapshot('layout',null), layouts=()=>snapshot('layouts',[]), props=()=>snapshot('props',{}), settings=()=>snapshot('settings',{});
export const window=()=>snapshot('window',{platform:'macos'});
export const theme=()=>snapshot('theme',{background:'#101114',canvas:'#101114',chrome:'#101114',surface:'#17191d',raised:'#25282d',hover:'#25282d',selected:'#253044',border:'#2a2d33',foreground:'#e5e7eb',muted:'#91969f',dim:'#6b7079',accent:'#89b4fa',blocked:'#d4a05a',working:'#89b4fa',done:'#7bb393',idle:'#6b7079'});
export const home=()=>snapshot('home','/fixture'),appHome=()=>snapshot('appHome','/fixture/app');
export const shared=key=>stored.get(key),setShared=(key,value)=>{stored.set(key,value);effects.push({name:'setShared',args:[key,value]});return null;};
export const run=(...args)=>effect('run',...args),exec=(...args)=>effect('exec',...args),hc=(...args)=>effect('hc',...args),knownAgents=(...args)=>effect('knownAgents',...args);
export const setAgentOrder=(...args)=>effect('setAgentOrder',...args);
export const readTextFile=(...args)=>effect('readTextFile',...args),writeTextFile=(...args)=>effect('writeTextFile',...args),openOverlay=(...args)=>effect('openOverlay',...args),closeOverlay=(...args)=>effect('closeOverlay',...args),notify=(...args)=>effect('notify',...args),nextCommand=(...args)=>effect('nextCommand',...args),pickFolder=(...args)=>effect('pickFolder',...args);
function makeContext(record,template){
  const cx={
    get notifications(){return record.owner.notifications;},
    notify(target){effectAllowed(record);if(target!==undefined){if(!(target instanceof RecordedEntity)||ownerRoot(target.owner)!==ownerRoot(record.owner))throw Error('Foreign retained target');target.assertLive();}record.owner.notifications++;},
    stop_propagation(){usable(record);},phase(){usable(record);return phaseFor(record);},
    new(Class,props){effectAllowed(record);return new RecordedEntity(Class,props,record.owner);},
    spawn(fn){usable(record);if(phaseFor(record)==='layout')throw Error('Tasks are forbidden during lazy layout');if(typeof fn!=='function')throw Error('Task body is required');const task={active:true,done:false};record.owner.tasks.add(task);let value;try{value=asyncScoped({owner:record.owner,task},fn,cx);}catch(error){value=Promise.reject(error);}const promise=Promise.resolve(value).then(result=>{task.done=true;record.owner.tasks.delete(task);return result;},error=>{task.done=true;record.owner.tasks.delete(task);throw error;});return {then:(...a)=>promise.then(...a),catch:(...a)=>promise.catch(...a),finally:(...a)=>promise.finally(...a),cancel(){task.active=false;},is_done:()=>task.done};},
    async sleep(ms=0){usable(record);if(!Number.isFinite(ms)||ms<0||phaseFor(record)==='layout')throw Error('Invalid native sleep');await record.owner.scheduleSleep(ms,record.owner.id);if(!record.owner.active||record.task?.active===false)throw Error('Recorded owner is closed');},
    timer:{every(){throw Error('Inject a timer scheduler explicitly for timer tests');}},
    focus_handle(){effectAllowed(record);return {focus(){usable(record);}};}
  };record.native={spawn:cx.spawn,stop_propagation:cx.stop_propagation,focus_handle:cx.focus_handle};record.overrides={};contexts.set(cx,record);
  // Explicit fixture schedulers and propagation spies survive a new event
  // context; the event itself still expires and spawned work gets AsyncContext.
  if(template){const source=stateFor(template);if(ownerRoot(source.owner)!==ownerRoot(record.owner))throw Error('Foreign injected context');cx.timer=template.timer;
    for(const name of ['stop_propagation','focus_handle'])if(template[name]!==source.native[name]){const original=source.overrides[name]??template[name];record.overrides[name]=original;cx[name]=(...args)=>{if(name==='focus_handle')effectAllowed(record);else usable(record);return original(...args);};}
    if(template.spawn!==source.native.spawn){const original=source.overrides.spawn??template.spawn;record.overrides.spawn=original;cx.spawn=(body,opts)=>{usable(record);if(phaseFor(record)==='layout')throw Error('Tasks are forbidden during lazy layout');return original(()=>asyncScoped({owner:record.owner},body,cx),opts);};}
  }return cx;
}
export function context({scheduleSleep=(ms)=>new Promise(resolve=>setTimeout(resolve,ms))}={}){if(typeof scheduleSleep!=='function')throw Error('A sleep scheduler is required');const owner={id:++ownerSequence,active:true,parent:null,scheduleSleep,entities:new Set(),tasks:new Set(),notifications:0};return makeContext({owner,phase:'task',call:null});}
export function invalidateRecordedContext(cx){const {owner}=stateFor(cx);if(!owner.active)return;for(const entity of [...owner.entities])entity.release();for(const task of owner.tasks)task.active=false;owner.active=false;}
export function renderRecorded(view,cx=context(),{range}={}){
  const owner=stateFor(cx).owner,mounted=new Set();usable(stateFor(cx));
  const sameRoot=child=>{let at=child;while(at.parent)at=at.parent;let root=owner;while(root.parent)root=root.parent;return root===at;};
  function materialize(value){
    if(value instanceof RecordedEntity){value.assertLive();if(!sameRoot(value.owner))throw Error('Foreign retained entity');if(mounted.has(value))throw Error('Duplicate retained entity mount');mounted.add(value);return materialize(callScoped(value.owner,'render',childCx=>value.instance.render(childCx)));}
    if(!(value instanceof Element))return value;
    const result=new Element(value.kind,value.value);result.semanticId=value.semanticId;result.calls=[...value.calls];result.handlers={...value.handlers};
    if(value.kind==='list'){
      if(typeof range!=='function')throw Error('An explicit recorded lazy range is required');const {id,count,getKey,render}=value.value,[start,end]=range(id,count);
      if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||end>count)throw Error('Invalid recorded lazy range');const keys=new Set();
      for(let index=start;index<end;index++){const key=callScoped(owner,'layout',()=>getKey(index));if(typeof key!=='string'||!key||keys.has(key))throw Error('Invalid or duplicate lazy key');keys.add(key);const item=callScoped(owner,'layout',layoutCx=>render(index,layoutCx));if(!(item instanceof Element))throw Error('Lazy row must return an element');result.child(materialize(item));}
    }else for(const child of value.nodes)result.child(materialize(child));
    return result;
  }
  const root=view instanceof View?callScoped(owner,'render',renderCx=>view.render(renderCx)):view;return materialize(root);
}
export function findElement(root,id){
  const found=[];function walk(v){if(!(v instanceof Element))return;if(v.semanticId===id)found.push(v);v.nodes.forEach(walk);}walk(root);
  if(found.length!==1)throw Error(`Expected one native control ${id}; found ${found.length}`);return found[0];
}
export function trigger(root,id,event='on_click',data={},cx){
  const control=findElement(root,id), handler=control.handlers[event];
  if(!handler)throw Error(`Missing ${event} handler for ${id}`);
  const owner=handler.owner??stateFor(cx??context()).owner;return callScoped(owner,'event',eventCx=>handler.fn(data,eventCx),cx);
}
