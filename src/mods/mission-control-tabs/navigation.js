/**
 * Mission Control view navigation: the layout-node contract both layouts share, the one-button
 * view swap, the six work-source controls and the Classic work-panel toggle.
 *
 * Contract consumed by the layouts (TASK-006):
 *   mc-main        the main region beside the rail, in both layouts. Its presence marks a
 *                  Mission Control view; without it the swap is disabled.
 *   mc-work-panel  Classic only: the side panel column [navigation block, mc-work-stack], hidden
 *                  at first. Its presence enables the panel toggle and the panel's hide button.
 *   mc-work-stack  a stack whose children are SOURCES ids (jira, github, pulls, gitlab, merges,
 *                  sessions), each a block with that source's `mod` and `props` below.
 *
 * Every action here takes its effects (run, shared, setShared) as arguments, so it holds no cx and
 * is testable without Herdr. The swap runs layout.switch only; selection and focus live in shared
 * state and Herdr's own per-screen view, so no tab is created or closed.
 */
import {div} from 'gpui-kit';
import {h_flex} from 'gpui-base';
import {colors,icon,iconButton} from '../../shared/ui.js';

export class NavigationError extends Error {constructor(code,message){super(message);this.name='NavigationError';this.code=code;}}
const freeze=v=>{if(v&&typeof v==='object'&&!Object.isFrozen(v)){for(const c of Object.values(v))freeze(c);Object.freeze(v);}return v;};
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const LAYOUT_NAME=/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ID=/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;

/** Versioned shared key: {v:1, source, scope, swap?:{id,from,to,at,space,tab,applied}}. */
export const NAV_STATE='mission-control-tabs-nav-v1';
/** Which work sources the person turned off (Herdr keeps shared state across restarts). The mods stay installed. */
export const SOURCES_STATE='mission-control-tabs-sources-v1';
export const NODES=freeze({main:'mc-main',panel:'mc-work-panel',stack:'mc-work-stack'});
/** The six distinct work sources, in navigation order, with the exact block content each stack child uses. */
export const SOURCES=freeze([
  {id:'jira',label:'Jira',short:'Jira',icon:'jira',mod:'mission-control-jira',props:{view:'panel',hideHeader:true},scopeKey:'mission-control-jira-ui-v1'},
  {id:'github',label:'GitHub issues',short:'GitHub',icon:'github',mod:'mission-control-github',props:{view:'issues',hideHeader:true},scopeKey:'mission-control-github-ui-v1'},
  {id:'pulls',label:'Pull requests',short:'PRs',icon:'pull-request',mod:'mission-control-github',props:{view:'pulls',hideHeader:true},scopeKey:'mission-control-github-prs-ui-v1'},
  {id:'gitlab',label:'GitLab issues',short:'GitLab',icon:'gitlab',mod:'mission-control-gitlab',props:{view:'issues',hideHeader:true},scopeKey:'mission-control-gitlab-ui-v1'},
  {id:'merges',label:'Merge requests',short:'MRs',icon:'branch',mod:'mission-control-gitlab',props:{view:'merges',hideHeader:true},scopeKey:'mission-control-gitlab-mrs-ui-v1'},
  {id:'sessions',label:'Previous sessions',short:'Sessions',icon:'sessions',mod:'mission-control-sessions',props:{hideHeader:true},scopeKey:'mission-control-sessions-ui-v1'}
]);
export const SOURCE_IDS=freeze(SOURCES.map(s=>s.id));
const BY_ID=new Map(SOURCES.map(s=>[s.id,s]));
/** The turned-off source ids, ignoring anything unknown or malformed. */
export function hiddenSources(sharedFn){
  let v=null;try{v=typeof sharedFn==='function'?sharedFn(SOURCES_STATE):null;}catch{}
  return new Set(plain(v)&&v.v===1&&Array.isArray(v.hidden)?v.hidden.filter(id=>BY_ID.has(id)):[]);
}
/** Turns one source on or off; turning off the shown source shows the first one still on. */
export function setSourceShown(id,shown,{contract,sharedFn,setSharedFn,runFn}={}){
  if(!BY_ID.has(id))return freeze({ok:false,code:'UNKNOWN_SOURCE',message:'Unknown source.'});
  const hidden=hiddenSources(sharedFn);if(shown)hidden.delete(id);else hidden.add(id);
  setSharedFn(SOURCES_STATE,{v:1,hidden:SOURCE_IDS.filter(x=>hidden.has(x))});
  if(!shown&&contract?.active===id){const next=SOURCES.find(s=>!hidden.has(s.id)&&sourceState(contract,s.id,hidden).enabled);if(next&&runFn)runFn('layout.select',{stack:NODES.stack,child:next.id});}
  return freeze({ok:true,source:id,shown:Boolean(shown)});
}
export const LAYOUT_PAIR=freeze({'mission-control':'mission-control-classic','mission-control-classic':'mission-control'});
export const LAYOUT_LABELS=freeze({'mission-control':'Mission Control','mission-control-classic':'Classic view'});
/** A swap restores focus only right after it, and never twice. */
export const NAV_TIMING=freeze({swapRestoreMs:15000});

/** Depth-first node lookup by id; bounded so a malformed tree cannot stall a render. */
export function findNode(tree,id,{limit=2000}={}){
  const stack=[tree];let seen=0;
  while(stack.length&&seen++<limit){
    const node=stack.pop();if(!plain(node))continue;if(node.id===id)return node;
    if(Array.isArray(node.children))for(let i=node.children.length-1;i>=0;i--)stack.push(node.children[i]);
  }
  return null;
}
const validName=v=>typeof v==='string'&&LAYOUT_NAME.test(v);
const swapLabel=name=>LAYOUT_LABELS[name]||'the other view';

/**
 * What the shown layout offers. Never throws: absent or malformed nodes disable only the controls
 * that need them, and say why.
 *   tree: layout(); name: shared('layout'); names: layouts(); props: this copy's props
 *   (swapTo names the other view explicitly; panel:true asks for the panel toggle).
 */
export function layoutContract({tree=null,name=null,names=[],props={}}={}){
  const main=findNode(tree,NODES.main),panel=findNode(tree,NODES.panel),node=findNode(tree,NODES.stack);
  const stack=node&&node.type==='stack'&&Array.isArray(node.children)?node:null;
  const ids=stack?stack.children.map(c=>plain(c)&&typeof c.id==='string'?c.id:null).filter(Boolean):[];
  const children=SOURCE_IDS.filter(id=>ids.includes(id)),active=stack?(ids.includes(stack.active)?stack.active:ids[0]??null):null;
  const shown=validName(name)?name:null,list=Array.isArray(names)?names.filter(validName):[];
  const to=validName(props?.swapTo)?props.swapTo:shown?LAYOUT_PAIR[shown]??null:null;
  let swap;
  if(!main)swap={enabled:false,code:'NO_LAYOUT_NODES',reason:'this layout has no Mission Control nodes (mc-main).'};
  else if(!to||to===shown)swap={enabled:false,code:'NO_SWAP_TARGET',reason:'this layout names no other Mission Control view.'};
  else if(!list.includes(to))swap={enabled:false,code:'SWAP_TARGET_MISSING',reason:`the ${swapLabel(to)} layout (${to}) is not installed.`};
  else swap={enabled:true,to,label:swapLabel(to)};
  return freeze({name:shown,main:Boolean(main),stack:Boolean(stack),children,active,
    stackReason:stack?null:node?'mc-work-stack is not a stack.':'this layout has no work stack (mc-work-stack).',
    panel:plain(panel)?{hidden:panel.hidden===true}:null,panelControl:Boolean(panel)||props?.panel===true,swap});
}
/** Per-source availability for the navigation strip. */
export function sourceState(contract,id,hidden=null){
  if(!BY_ID.has(id))return {enabled:false,reason:'Unknown source.'};
  if(hidden?.has(id))return {enabled:false,hidden:true,reason:'Turned off in Mission Control sources (the gear in the tab bar).'};
  if(!contract?.stack)return {enabled:false,reason:'Unavailable: '+(contract?.stackReason||'this layout has no work stack (mc-work-stack).')};
  if(!contract.children.includes(id))return {enabled:false,reason:'Not in this layout.'};
  return {enabled:true,reason:null};
}

/** The scope a source mod itself persists (its own versioned shared UI state): "space" or "all". */
export function scopeOf(id,sharedFn){
  const s=BY_ID.get(id);if(!s||typeof sharedFn!=='function')return null;let v=null;try{v=sharedFn(s.scopeKey);}catch{}
  return plain(v)&&v.v===1&&v.all===true?'all':'space';
}
/** The stored navigation state; anything malformed reads as empty, never as a wrong source. */
export function readNavState(sharedFn){
  let v=null;try{v=typeof sharedFn==='function'?sharedFn(NAV_STATE):null;}catch{}
  const out={v:1,source:null,scope:null,swap:null};if(!plain(v)||v.v!==1)return out;
  if(BY_ID.has(v.source))out.source=v.source;if(v.scope==='space'||v.scope==='all')out.scope=v.scope;
  const s=v.swap;
  if(plain(s)&&typeof s.id==='string'&&s.id.length<=96&&validName(s.from)&&validName(s.to)&&Number.isSafeInteger(s.at)&&s.at>=0)
    out.swap={id:s.id,from:s.from,to:s.to,at:s.at,space:typeof s.space==='string'&&ID.test(s.space)?s.space:null,tab:typeof s.tab==='string'&&ID.test(s.tab)?s.tab:null,applied:s.applied===true};
  return out;
}
const write=(setSharedFn,state)=>{setSharedFn(NAV_STATE,state);return state;};
const randomId=()=>'swap-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,10);

/** Selects one work source: layout.select on mc-work-stack (and shows the Classic panel when asked). */
export function selectSource(id,{contract,sharedFn,setSharedFn,runFn,reveal=false}={}){
  const state=sourceState(contract,id,hiddenSources(sharedFn));if(!state.enabled)return freeze({ok:false,code:state.hidden?'SOURCE_OFF':BY_ID.has(id)?contract?.stack?'SOURCE_MISSING':'NO_WORK_STACK':'UNKNOWN_SOURCE',message:state.reason});
  const commands=[];
  if(contract.active!==id){runFn('layout.select',{stack:NODES.stack,child:id});commands.push('layout.select');}
  if(reveal&&contract.panel?.hidden){runFn('layout.show',{id:NODES.panel});commands.push('layout.show');}
  const prev=readNavState(sharedFn);write(setSharedFn,{...prev,v:1,source:id,scope:scopeOf(id,sharedFn)});
  return freeze({ok:true,source:id,commands});
}
/** Shows or hides the Classic work panel. */
export function togglePanel({contract,runFn}={}){
  if(!contract?.panel)return freeze({ok:false,code:'NO_WORK_PANEL',message:'This layout has no work panel (mc-work-panel).'});
  const command=contract.panel.hidden?'layout.show':'layout.hide';runFn(command,{id:NODES.panel});return freeze({ok:true,command});
}
/**
 * The one-button swap: records the selected source, its scope and the current focus, then runs
 * layout.switch and nothing else. The other view restores the source on start (restoreView).
 */
export function swapView({contract,focused=null,sharedFn,setSharedFn,runFn,now=Date.now(),id=randomId()}={}){
  if(!contract?.swap?.enabled)return freeze({ok:false,code:contract?.swap?.code||'NO_LAYOUT_NODES',message:'View swap unavailable: '+(contract?.swap?.reason||'this layout has no Mission Control nodes (mc-main).')});
  const prev=readNavState(sharedFn),source=contract.active&&BY_ID.has(contract.active)?contract.active:prev.source;
  const space=typeof focused?.space==='string'&&ID.test(focused.space)?focused.space:null,tab=typeof focused?.tab==='string'&&ID.test(focused.tab)?focused.tab:null;
  const state=write(setSharedFn,{v:1,source,scope:source?scopeOf(source,sharedFn):prev.scope,swap:{id,from:contract.name||'unknown',to:contract.swap.to,at:now,space,tab,applied:false}});
  runFn('layout.switch',{name:contract.swap.to});
  return freeze({ok:true,to:contract.swap.to,state});
}
/**
 * Applied once by a view that starts: selects the stored source on mc-work-stack when it differs,
 * and, right after a swap into this layout, brings back a space/tab the switch lost. Idempotent.
 */
export function restoreView({contract,sharedFn,setSharedFn,runFn,focused=null,spaces=[],now=Date.now()}={}){
  const state=readNavState(sharedFn),commands=[];
  if(state.source&&contract?.stack&&contract.children.includes(state.source)&&contract.active!==state.source){runFn('layout.select',{stack:NODES.stack,child:state.source});commands.push('layout.select');}
  const s=state.swap;
  if(s&&!s.applied&&contract?.name&&s.to===contract.name&&now>=s.at&&now-s.at<=NAV_TIMING.swapRestoreMs){
    const space=s.space?(spaces||[]).find(x=>x?.id===s.space):null,live=Boolean(space&&s.tab&&(space.tabs||[]).some(t=>t?.id===s.tab));
    if(live&&focused?.tab!==s.tab){if(focused?.space!==s.space){runFn('space.select',{id:s.space});commands.push('space.select');}runFn('tab.select',{id:s.tab});commands.push('tab.select');}
    write(setSharedFn,{...state,swap:{...s,applied:true}});
  }
  return freeze({commands});
}

/** Estimated widths (logical px) of the strip in each presentation; charPx matches NAME_LIMITS. */
export const NAV_METRICS=freeze({charPx:7,icon:14,gap:2,pad:12,full:{px:10,gap:6},short:{px:8,gap:5},button:26,minButton:18,hide:30,caption:110});
/** Natural width of a presentation; icon-only buttons may shrink to minButton (navigationMinWidth). */
export function navigationWidth(mode,{panel=false,button=NAV_METRICS.button,sources=SOURCES}={}){
  const m=NAV_METRICS,n=sources.length;let items;
  if(mode==='icons')items=n*button;
  else{const p=mode==='full'?m.full:m.short,chars=sources.reduce((a,s)=>a+Array.from(mode==='full'?s.label:s.short).length,0);items=chars*m.charPx+n*(2*p.px+m.icon+p.gap);}
  return items+Math.max(0,n-1)*m.gap+m.pad+(panel?m.hide:0);
}
/** The narrowest strip that still shows every source control whole. */
export const navigationMinWidth=({panel=false}={})=>navigationWidth('icons',{panel,button:NAV_METRICS.minButton});
/** Six labelled sources when they fit, short labels next, accessible icon-only controls otherwise. */
export function navigationMode(width,{panel=false,sources=SOURCES}={}){
  if(!Number.isFinite(width)||width<=0)return 'icons';
  for(const mode of ['full','short'])if(navigationWidth(mode,{panel,sources})<=width)return mode;
  return 'icons';
}

function sourceButton(mod,source,{mode,selected,state,onSelect}){
  const t=colors(),hint=(state.enabled?source.label:`${source.label} · ${state.reason}`)+(selected?' (shown)':'');
  let el=h_flex().id('source-'+source.id).h(26).flex_none().items_center().justify_center().rounded(5).text_size(11.5).role('tab').tooltip(hint).accessibility_label(hint)
    .bg(selected?t.selected:'#00000000').text_color(!state.enabled?t.dim:selected?t.foreground:t.muted).on_mouse_down('left',(_e,cx)=>cx.stop_propagation());
  // Icon-only controls share the strip and shrink before anything is clipped.
  el=mode==='icons'?el.flex_1().min_w(NAV_METRICS.minButton).max_w(NAV_METRICS.button):el.px(NAV_METRICS[mode].px).gap(NAV_METRICS[mode].gap);
  if(state.enabled)el=el.cursor_pointer().hover(s=>s.bg(t.hover).text_color(t.foreground)).on_click((_e,cx)=>{cx.stop_propagation();onSelect(source.id,cx);});
  el=el.child(icon(mod,source.icon,NAV_METRICS.icon).text_color(selected&&state.enabled?t.accent:state.enabled?t.muted:t.dim));
  return mode==='icons'?el:el.child(div().child(mode==='full'?source.label:source.short));
}
/**
 * The work-navigation strip. The selected source is the heading (the embedded views run with
 * hideHeader); the caption keeps only the useful scope/space metadata, when it fits.
 */
export function renderNavigation({mod,contract,width=null,scope=null,spaceName=null,hidden=new Set(),onSelect,onHide,onSize}){
  const t=colors(),panel=Boolean(contract.panel),shown=SOURCES.filter(s=>!hidden.has(s.id)),mode=navigationMode(width,{panel,sources:shown});
  const room=Number.isFinite(width)?width-navigationWidth(mode,{panel,sources:shown}):0;
  const caption=!contract.stack?'Work sources unavailable: '+contract.stackReason:!shown.length?'Every work source is turned off. Turn one on with the gear in the tab bar.':contract.active&&!hidden.has(contract.active)?scope==='all'?'All spaces':['This space',spaceName].filter(Boolean).join(' · '):null;
  let group=h_flex().id('work-sources').flex_1().min_w(0).h_full().gap(NAV_METRICS.gap).items_center()
    .children(shown.map(s=>sourceButton(mod,s,{mode,selected:contract.active===s.id,state:sourceState(contract,s.id,hidden),onSelect})));
  if(!shown.length)group=group.child(div().id('source-caption').min_w(0).px(6).truncate().text_size(10.5).text_color(t.dim).tooltip(caption).child(caption));
  else if(mode!=='icons'){
    group=group.child(div().flex_1().min_w(0));
    if(caption&&(!contract.stack||room>=NAV_METRICS.caption))group=group.child(div().id('source-caption').min_w(0).truncate().text_size(10.5).text_color(contract.stack?t.dim:t.blocked).tooltip(caption).child(caption));
  }
  let root=h_flex().id('mc-work-navigation').size_full().min_w(0).px(6).gap(NAV_METRICS.gap).items_center().bg(t.chrome).border_b(1).border_color(t.border)
    .role('tab_list').accessibility_label(contract.stack?'Work sources':'Work sources unavailable: '+contract.stackReason).on_size_change((size,cx)=>onSize?.(size,cx)).child(group);
  if(panel)root=root.child(iconButton(mod,'hide-work-panel','close','Hide work panel',(_e,cx)=>onHide?.(cx),{size:24}));
  return root;
}
/** The one swap control for the top bar; disabled with its reason outside a Mission Control view. */
export function renderSwap(mod,contract,{compact=true,onSwap}={}){
  const t=colors(),s=contract.swap,hint=s.enabled?'Switch to '+s.label:'View swap unavailable: '+s.reason;
  let el=h_flex().id('view-swap').h(26).flex_none().items_center().justify_center().gap(6).rounded(6).border(1).border_color(t.border).text_size(12)
    .text_color(s.enabled?t.foreground:t.dim).role('button').tooltip(hint).accessibility_label(hint).on_mouse_down('left',(_e,cx)=>cx.stop_propagation());
  el=compact?el.w(28):el.px(9);
  if(s.enabled)el=el.cursor_pointer().hover(st=>st.bg(t.hover)).on_click((_e,cx)=>{cx.stop_propagation();onSwap?.(cx);});
  el=el.child(icon(mod,'layout',14));
  return compact?el:el.child(div().child(s.enabled?s.label:'Switch view'));
}
/** Classic panel toggle: present where the layout has (or asks for) mc-work-panel; disabled when the node is missing. */
export function renderPanelToggle(mod,contract,{onToggle}={}){
  if(!contract.panelControl)return null;
  const enabled=Boolean(contract.panel),open=enabled&&!contract.panel.hidden;
  const hint=!enabled?'Work panel unavailable: this layout has no mc-work-panel node.':open?'Hide work panel':'Show work panel';
  return iconButton(mod,'work-panel','panel',hint,(_e,cx)=>onToggle?.(cx),{active:open,disabled:!enabled,size:26});
}
