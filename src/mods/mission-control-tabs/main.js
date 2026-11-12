/**
 * Mission Control tabs: the one topmost tab bar both Mission Control layouts share, plus its own
 * overlays. Roles (props.view):
 *   topbar (default)  native tabs of the shown space, own agent menu (+), Reopen last tab / agent,
 *                     Classic panel toggle, the one-button view swap and window controls. The only
 *                     role that runs the naming / close-history service.
 *   navigation        the six work-source controls above mc-work-stack (no naming service).
 *   menu | launch | settings   this mod's own bundled agent menu dialog (LaunchDialog).
 *   context           this mod's own tab context menu popup.
 * Everything it needs is bundled from this folder and src/shared; no other mod is read at run time.
 */
import {View,div,svg,image} from 'gpui-kit';
import {h_flex,v_flex} from 'gpui-base';
import * as herdr from 'herdr';
import {createLaunchIO} from '../../shared/launch.js';
import {LaunchDialog,openLaunchDialog} from '../../shared/launch-dialog.js';
import {TabNameService} from '../../shared/tab-service.js';
import {ReopenController} from '../../shared/reopen.js';
import {RestartRunner,RUNNER} from '../../shared/restart-runner.js';
import {displayLabel,folderName,NAME_LIMITS} from '../../shared/tab-names.js';
import {colors,icon,iconButton,safeArtworkPath} from '../../shared/ui.js';
import {NODES,SOURCES,NAV_STATE,NAV_TIMING,SOURCES_STATE,layoutContract,scopeOf,selectSource,swapView,togglePanel,restoreView,renderNavigation,renderSwap,renderPanelToggle,hiddenSources,setSourceShown,sourceState,renderSourceButtons} from './navigation.js';

export const MOD='mission-control-tabs';
/** Versioned shared keys: a context-menu request for the bar, and key-command de-duplication across copies. */
export const REQUEST_EVENT='mission-control-tabs-request-v1',COMMAND_EVENT='mission-control-tabs-command-v1';
export const VIEWS=Object.freeze(['topbar','navigation','menu','launch','settings','context','sources','restart']);
/** keys.json actions: "mission-control-tabs.<command>". None is bound by default. */
export const COMMANDS=Object.freeze(['new','settings','sources','reopen-tab','reopen-agent','swap','panel','rename','automatic-name','close',...SOURCES.map(s=>'source-'+s.id)]);
/** Every in-flight flag is a timestamp with a staleness bound: an interrupted task never clears its own. */
export const TIMING=Object.freeze({tickMs:1000,tickStaleMs:20000,pressMs:6000,closeMs:10000,reopenStaleMs:95000,requestMs:5000,namesMs:60000,wheelMs:160,commandMs:750,reopenReadMs:2000});
export const STATUS=Object.freeze({working:'Working',blocked:'Needs input',done:'Done',idle:'Idle'});
/** Every local artwork name this mod draws, its own views and the bundled agent menu alike. */
export const ICONS=Object.freeze(['agent','branch','close','folder','github','gitlab','jira','layout','more','panel','pin','plus','priority','pull-request','refresh','search','sessions','settings']);
const TOPBAR_WIDE=720,DIALOG_VIEWS=new Set(['menu','launch','settings']);
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const randomId=prefix=>prefix+'-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8);
const safeHome=()=>{try{const h=herdr.home();return typeof h==='string'?h:null;}catch{return null;}};

/** The role a props object selects. An overlay without a view is this mod's own agent menu. */
export function viewRole(props){
  const v=props?.view;if(v===undefined||v===null||v==='')return props?.overlay?'menu':'topbar';
  return VIEWS.includes(v)?v:'unknown';
}
export const isTopbarBlock=node=>node?.type==='block'&&node.content?.mod===MOD&&viewRole(node.content.props||{})==='topbar';
const num=v=>Number.isFinite(v)&&v>0?v:0;
/** x of the first matching block from the window's left edge: px siblings before it in rows; unknown widths give Infinity. */
export function leftOffset(tree,match,{limit=2000}={}){
  let seen=0;
  const walk=(node,x)=>{
    if(!plain(node)||++seen>limit)return null;if(match(node))return x;const kids=Array.isArray(node.children)?node.children:[];
    if(node.type==='row'){let at=x;const step=num(node.gap)+num(node.divider?.width);for(const k of kids){const r=walk(k,at);if(r!==null)return r;if(k?.hidden===true)continue;const px=num(k?.size?.px);at=px?at+px+step:Infinity;}return null;}
    for(const k of kids){const r=walk(k,x);if(r!==null)return r;}return null;
  };
  return walk(tree,0);
}
/** Room for the macOS window buttons when the layout draws its own title bar and the bar starts under them. */
export function lightsPadding({win,tree,zoom=1,match=isTopbarBlock}={}){
  if(win?.platform!=='macos'||win.titlebar!=='none'||win.fullscreen||!Array.isArray(tree?.traffic_lights))return 10;
  const x=Number(tree.traffic_lights[0]);if(!Number.isFinite(x)||x<0||x>400)return 10;
  const z=Number.isFinite(zoom)&&zoom>0?zoom:1,offset=leftOffset(tree,match)??0;
  return Number.isFinite(offset)?Math.max(10,Math.ceil((x+64)/z-offset)):10;
}
const isAgent=p=>p?.program?.agent===true||typeof p?.status==='string'&&p.status!==''||typeof p?.app==='string'&&p.app!=='';
/** One pass over panes(): each shown tab's agent pane, else its first terminal, else its mod pane. */
export function primaryPanes(tabs,panes){
  const ids=new Set(tabs.map(t=>t?.id)),out=new Map();
  for(const p of panes||[]){
    if(!p||!ids.has(p.tab))continue;const prev=out.get(p.tab),terminal=typeof p.terminal==='string'&&p.terminal!=='',agent=terminal&&isAgent(p);
    if(!prev||(!prev.terminal&&terminal)||(prev.terminal&&!prev.agent&&agent))out.set(p.tab,{program:plain(p.program)?p.program:null,cwd:typeof p.cwd==='string'?p.cwd:null,terminal,agent,mod:!terminal&&typeof p.mod==='string'});
  }
  return out;
}
function statusMark(id,status,t){
  const name=STATUS[status];if(!name)return null;const el=div().id(id).size(7).flex_none().rounded_full().tooltip(name).accessibility_label(name);
  // Four distinct marks: idle is a hollow ring; working, needs input and done are filled in their theme colors.
  return status==='idle'?el.border(1).border_color(t.idle||t.dim):el.bg(t[status]||t.dim);
}

export default class MissionControlTabs extends View {
  init(_props,cx){
    this.props=herdr.props()||{};this.role=viewRole(this.props);this.closed=false;this.jobs=[];this.timers=[];this.width=null;this.instance=Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8);
    if(DIALOG_VIEWS.has(this.role)){this.dialog=new LaunchDialog(MOD,this.props,herdr);this.dialog.init(cx);return;}
    // setShared re-renders every mod, so the strip follows a changed source choice without a timer.
    if(this.role==='navigation')return this.restore();
    // The Sources gear and the restart popup read the resume-after-restart journal; only the top bar observes.
    if(this.role==='sources'||this.role==='restart'){this.restartStatus=null;try{this.restart=new RestartRunner(createLaunchIO(herdr),{owner:MOD+'-'+this.instance+'-restart-view'});this.spawn(cx,async()=>{await this.restart.refresh();await this.restart.refreshCodex();return !this.closed;});}catch{}return;}
    if(this.role!=='topbar')return;
    Object.assign(this,{press:null,ticking:0,reopening:0,closing:new Map(),handled:new Set(),picking:null,namesAt:0,wheelAt:0,labels:new Map(),labelGen:0,previewMemo:null,home:safeHome(),service:null,reopen:null,error:null});
    try{
      const io=createLaunchIO(herdr);this.reopen=new ReopenController(io,{owner:MOD+'-'+this.instance+'-reopen'});
      // One naming / close-history service per bar copy; its CAS leases keep a single writer per app home.
      this.service=new TabNameService(io,{owner:MOD+'-'+this.instance,closed:this.reopen,home:this.home});
      // Resume after restart: its own 5 s cadence, driven from this bar's tick but never inside the close-history pass.
      this.restart=new RestartRunner(io,{owner:MOD+'-'+this.instance+'-restart'});this.restartAt=0;this.restartBusy=0;
    }catch(error){this.error=error?.message||'Automatic tab names are unavailable.';}
    this.restore();
    this.timers.push(cx.timer.every(TIMING.tickMs,eventCx=>this.tick(eventCx)));this.tick(cx);
    this.commandTask=cx.spawn(async taskCx=>{while(!this.closed){const command=await herdr.nextCommand();if(this.closed)return;this.command(command,taskCx);}});
  }
  spawn(cx,work){
    if(this.jobs.length>32)this.jobs=this.jobs.filter(job=>!job?.is_done?.());
    const job=cx.spawn(async taskCx=>{let redraw=false;try{redraw=await work(taskCx);}catch{redraw=false;}if(!this.closed&&redraw)taskCx.notify();});this.jobs.push(job);return job;
  }
  contract(tree=herdr.layout()){
    let name=null;try{name=herdr.shared('layout');}catch{}
    return layoutContract({tree,name,names:typeof herdr.layouts==='function'?herdr.layouts()||[]:[],props:this.props});
  }
  restore(contract=this.contract()){try{this.restoredFor=JSON.stringify([contract?.name??null,Boolean(contract?.stack)]);restoreView({contract,sharedFn:herdr.shared,setSharedFn:herdr.setShared,runFn:herdr.run,focused:herdr.focused?.()??null,spaces:herdr.spaces()||[]});}catch{}}
  /** Herdr can keep this bar across a layout switch or start it before the new stack exists: restore once per layout and stack. */
  restoreOnLayoutChange(){
    const contract=this.contract();if(JSON.stringify([contract?.name??null,Boolean(contract?.stack)])!==this.restoredFor)return this.restore(contract);
    // Herdr can drop a selection sent while the switched-in layout is still mounting: re-select within the swap window only.
    let nav=null;try{nav=herdr.shared(NAV_STATE);}catch{}
    if(nav?.source&&nav.swap?.to===contract?.name&&Date.now()-nav.swap.at<=NAV_TIMING.swapRestoreMs&&contract.active&&contract.active!==nav.source)this.restore(contract);
  }
  activeSpace(){return (herdr.spaces()||[]).find(s=>s?.active)||null;}
  restartTick(cx,now){
    if(!this.restart||now-this.restartAt<RUNNER.tickMs||this.restartBusy&&now-this.restartBusy<RUNNER.staleTickMs)return;this.restartAt=now;this.restartBusy=now;
    const fingerprint=()=>JSON.stringify(this.restart.offers().map(o=>[o.machine,o.address]));const before=fingerprint();
    this.spawn(cx,async()=>{await this.restart.tick();if(!this.codexAt){this.codexAt=now;await this.restart.refreshCodex();}this.restartBusy=0;return !this.closed&&fingerprint()!==before;});
  }
  openRestart(){herdr.openOverlay({mod:MOD,kind:'popup',width:360,height:320,props:{view:'restart'}});}
  restartAct(work,cx){
    if(this.closed||!this.restart)return;this.restartStatus='Working…';cx.notify();
    this.spawn(cx,async()=>{const message=await work();if(this.closed)return false;this.restartStatus=message||null;return true;});
  }
  resumeOffers(cx,offer){return this.restartAct(async()=>{const results=offer?[await this.restart.resumeOffer(offer)]:await this.restart.resumeAll();const failed=results.filter(r=>!r.ok);
    return failed.length?failed.map(r=>r.reason+(r.line?' Run: '+r.line:'')).join(' '):`Resumed ${results.length} agent${results.length===1?'':'s'}.`;},cx);}
  dismissOffers(cx,offer){return this.restartAct(async()=>{for(const o of offer?[offer]:this.restart.offers())await this.restart.dismissOffer(o);return null;},cx);}
  setupCodex(cx,machine){return this.restartAct(async()=>{const r=await this.restart.installCodex(machine);return r.ok?'Codex resume is set up. Codex asks you to trust the new hook the next time it starts.':r.message;},cx);}
  restartPill(){
    const t=colors(),list=this.restart.offers(),n=list.length,text=`Resume ${n}`;
    return h_flex().id('mc-restart').h(22).px(8).flex_none().items_center().rounded(6).border(1).border_color(t.accent).text_size(11.5).text_color(t.foreground).role('button')
      .accessibility_label(`Resume ${n} agent${n===1?'':'s'} from before the restart`).tooltip(['From before the restart:',...list.map(o=>o.line+(o.reason?'\n  '+o.reason:'')),'Click to resume or dismiss them.'].join('\n'))
      .cursor_pointer().hover(st=>st.bg(t.hover)).on_mouse_down('left',(_e,cx)=>cx.stop_propagation()).on_click((_e,cx)=>{cx.stop_propagation();this.openRestart();}).child(text);
  }
  codexRows(t){
    return this.restart?this.restart.codexSetup().filter(c=>c.ok&&!c.installed).map((c,i)=>h_flex().id('mc-restart-codex-'+i).min_h(30).px(8).gap(8).items_center().rounded(6)
      .child(div().flex_1().min_w(0).text_size(11).text_color(t.muted).child(`Codex on ${c.machine||'this Mac'} comes back after a restart once its session hook is set up.`))
      .child(div().id('mc-restart-codex-setup-'+i).text_size(11).text_color(t.accent).role('button').cursor_pointer().on_click((_e,cx)=>{cx.stop_propagation();this.setupCodex(cx,c.machine);}).child('Set up Codex resume'))):[];
  }
  restartPanel(){
    const t=colors(),list=this.restart?this.restart.offers():[],link=(id,text,fn)=>div().id(id).text_size(11).text_color(t.accent).role('button').cursor_pointer().hover(st=>st.text_color(t.foreground)).on_click((_e,cx)=>{cx.stop_propagation();fn(cx);}).child(text);
    return v_flex().id('mc-restart-panel').size_full().p(10).gap(6).bg(t.surface).text_size(12).text_color(t.foreground).overflow_y_scrollbar()
      .child(h_flex().gap(8).items_center().child(div().flex_1().text_size(12.5).child('From before the restart')).when(list.length>0,e=>e.child(link('mc-restart-resume-all','Resume all',cx=>this.resumeOffers(cx))).child(link('mc-restart-dismiss-all','Dismiss',cx=>this.dismissOffers(cx)))))
      .when(!list.length,e=>e.child(div().id('mc-restart-empty').text_size(11).text_color(t.dim).child('Nothing to resume. Agents that were running when their terminal was lost show here when they could not be resumed by themselves.')))
      .children(list.map((o,i)=>h_flex().id('mc-restart-offer-'+i).min_h(36).px(8).gap(8).items_center().rounded(6).border(1).border_color(t.border)
        .child(v_flex().flex_1().min_w(0).child(div().truncate().child(o.line)).child(div().truncate().text_size(10.5).text_color(t.dim).child([o.machine||'This Mac',o.reason].filter(Boolean).join(' · '))))
        .child(link('mc-restart-resume-'+i,'Resume',cx=>this.resumeOffers(cx,o))).child(link('mc-restart-dismiss-'+i,'Dismiss',cx=>this.dismissOffers(cx,o)))))
      .children(this.codexRows(t))
      .when(Boolean(this.restartStatus),e=>e.child(div().id('mc-restart-status').text_size(10.5).text_color(t.muted).child(this.restartStatus)));
  }
  tick(cx){
    if(this.closed||!this.service)return;const now=Date.now();this.restoreOnLayoutChange();this.takeRequest(cx);this.restartTick(cx,now);
    if(now-this.namesAt>=TIMING.namesMs){this.namesAt=now;this.spawn(cx,async()=>{const tools=await herdr.knownAgents({on:null});if(!this.closed&&Array.isArray(tools))this.service.setKnownNames(tools.map(t=>t?.name));return false;});}
    // The Reopen buttons read closed history directly, so a copy whose service pass is stuck or not recording never shows a stale "last" record.
    if(this.reopen&&!this.reopen.running()&&now-(this.reopenReadAt||0)>=TIMING.reopenReadMs){this.reopenReadAt=now;const before=this.reopen.value?.revision??null;this.spawn(cx,async()=>{await this.reopen.refresh();return !this.closed&&(this.reopen.value?.revision??null)!==before;});}
    if(this.ticking&&now-this.ticking>=0&&now-this.ticking<TIMING.tickStaleMs)return;this.ticking=now;
    // Idle passes redraw nothing; only renamed tabs or new close history do.
    return this.spawn(cx,async()=>{const r=await this.service.tick();this.ticking=0;if(this.closed||!r?.changed)return false;this.labelGen++;return true;});
  }
  // Context-menu requests: noticed while drawing, taken in a task once the frame is described.
  pickRequest(cx){
    const r=herdr.shared(REQUEST_EVENT);if(!plain(r)||typeof r.id!=='string'||r.claimed||this.handled.has(r.id)||this.picking===r.id)return;
    this.picking=r.id;this.spawn(cx,async taskCx=>{await null;this.takeRequest(taskCx);return false;});
  }
  takeRequest(cx){
    if(this.closed||!this.service)return;const r=herdr.shared(REQUEST_EVENT),now=Date.now();
    if(!plain(r)||r.v!==1||typeof r.id!=='string'||r.id.length>96||this.handled.has(r.id))return;
    this.handled.add(r.id);if(this.handled.size>64)this.handled.delete(this.handled.values().next().value);
    if(r.claimed||!Number.isSafeInteger(r.at)||now<r.at||now-r.at>TIMING.requestMs)return;
    herdr.setShared(REQUEST_EVENT,{...r,claimed:this.instance});
    if(r.action==='close'&&typeof r.tabId==='string')this.closeTab(r.tabId,cx);
  }
  command(command,cx){
    if(typeof command!=='string'||!COMMANDS.includes(command))return;
    // A key command reaches every shown copy; only the first to take it acts.
    const now=Date.now(),seen=herdr.shared(COMMAND_EVENT);
    if(plain(seen)&&seen.command===command&&seen.owner!==this.instance&&now-seen.at>=0&&now-seen.at<TIMING.commandMs)return;
    herdr.setShared(COMMAND_EVENT,{v:1,command,owner:this.instance,at:now});
    const space=this.activeSpace(),tab=(space?.tabs||[]).find(t=>t?.active);
    if(command==='new')return this.openMenu(space);
    if(command==='settings')return this.openMenu(space,'settings');
    if(command==='sources')return this.openSources();
    if(command==='reopen-tab'||command==='reopen-agent')return this.reopenLast(command==='reopen-agent'?'agent':'tab',cx,{fromKey:true});
    if(command==='swap')return this.swap();
    if(command==='panel')return this.togglePanel();
    if(!command.startsWith('source-')){if(!tab)return;if(command==='rename')herdr.run('tab.rename',{id:tab.id});else if(command==='automatic-name')this.service?.requestAutomatic(tab.id);else this.closeTab(tab.id,cx);return;}
    const r=selectSource(command.slice(7),{contract:this.contract(),sharedFn:herdr.shared,setSharedFn:herdr.setShared,runFn:herdr.run,reveal:true});
    if(!r.ok)herdr.notify({title:'Work sources',body:r.message,level:'warning'});
  }
  openMenu(space,view='menu'){
    if(!space){herdr.notify({title:'New agent',body:'Select a space first.',level:'info'});return null;}
    return openLaunchDialog(MOD,herdr,{view,spaceId:space.id,machine:space.machine??null});
  }
  openSource(id){const r=selectSource(id,{contract:this.contract(),sharedFn:herdr.shared,setSharedFn:herdr.setShared,runFn:herdr.run,reveal:true});if(!r.ok)herdr.notify({title:'Work sources',body:r.message,level:'warning'});return r;}
  openSources(){herdr.openOverlay({mod:MOD,kind:'popup',width:300,height:318,props:{view:'sources'}});}
  swap(){const r=swapView({contract:this.contract(),focused:herdr.focused?.()??null,sharedFn:herdr.shared,setSharedFn:herdr.setShared,runFn:herdr.run});if(!r.ok)herdr.notify({title:'Switch view',body:r.message,level:'warning'});return r;}
  togglePanel(){const r=togglePanel({contract:this.contract(),runFn:herdr.run});if(!r.ok)herdr.notify({title:'Work panel',body:r.message,level:'warning'});return r;}
  closeTab(id,cx){
    if(this.closed||!this.service)return;const now=Date.now(),at=this.closing.get(id);if(at&&now-at>=0&&now-at<TIMING.closeMs)return;
    this.closing.set(id,now);if(this.closing.size>16)this.closing.delete(this.closing.keys().next().value);
    return this.spawn(cx,async()=>{const r=await this.service.closeTab(id);this.closing.delete(id);if(!this.closed&&!r.ok&&r.code!=='TAB_UNAVAILABLE')herdr.notify({title:'Close tab',body:r.message,level:'warning'});return true;});
  }
  reopenBusy(){const now=Date.now();return Boolean(this.reopening&&now-this.reopening>=0&&now-this.reopening<TIMING.reopenStaleMs)||Boolean(this.reopen?.running());}
  reopenLast(kind,cx,{fromKey=false}={}){
    if(this.closed||!this.reopen)return;
    if(this.reopenBusy()){if(fromKey)herdr.notify({title:kind==='agent'?'Reopen last agent':'Reopen last tab',body:'A reopen is already running; wait for it to appear.',level:'info'});return;}
    this.reopening=Date.now();
    return this.spawn(cx,async()=>{
      const r=await this.reopen.run(kind);this.reopening=0;if(this.closed)return false;
      // Its task title travels with a reopened agent; a shell keeps following its folder.
      if(r.ok&&r.kind==='agent'&&typeof r.tabId==='string'&&r.title)this.service?.acknowledge({machine:r.machine??null,tabId:r.tabId,title:r.title});
      else if(!r.ok&&r.code!=='REOPEN_IN_PROGRESS')herdr.notify({title:kind==='agent'?'Reopen last agent':'Reopen last tab',body:r.message,level:'warning'});
      return true;
    });
  }
  previews(){
    const c=this.reopen;if(!c)return null;const key=[c.value?.revision??null,c.running(),c.error?.code??null].join('|');
    if(this.previewMemo?.key!==key)this.previewMemo={key,tab:c.preview('tab'),agent:c.preview('agent')};return this.previewMemo;
  }
  openContext(tab,space,mode){herdr.openOverlay({mod:MOD,kind:'popup',width:240,height:170,props:{view:'context',target:{tabId:tab.id,spaceId:space.id,machine:space.machine??null,mode:mode??null}}});}
  pressTab(tab,space,event){
    // A double press is Herdr's own rename prompt; it never also selects or moves.
    if(event?.click_count===2){this.press=null;herdr.run('tab.rename',{id:tab.id});return;}
    this.press={tab:tab.id,space:space.id,at:Date.now()};
  }
  releaseTab(tab,space){
    const p=this.press,now=Date.now();this.press=null;
    // Only a fresh press that began on one of these tabs, without leaving the bar, selects or reorders.
    if(!p||p.space!==space.id||!(now-p.at>=0&&now-p.at<=TIMING.pressMs))return;
    if(p.tab===tab.id)return herdr.run('tab.select',{id:tab.id});
    const live=(herdr.spaces()||[]).find(s=>s?.id===space.id),list=Array.isArray(live?.tabs)?live.tabs:[],index=list.findIndex(x=>x?.id===tab.id);
    if(index<0||!list.some(x=>x?.id===p.tab))return;herdr.run('tab.move',{id:p.tab,index:index+1});
  }
  wheel(event){
    const dy=Number(event?.delta?.y)||0,dx=Number(event?.delta?.x)||0,now=Date.now();
    if(Math.abs(dy)<1||Math.abs(dy)<=Math.abs(dx)||now-this.wheelAt>=0&&now-this.wheelAt<TIMING.wheelMs)return;this.wheelAt=now;herdr.run(dy>0?'tab.prev':'tab.next');
  }
  labelFor(tab,machine,primary){
    let base=typeof tab.name==='string'?tab.name:'';
    // Herdr calls an unnamed tab by its position until the first naming pass; show what runs there meanwhile.
    if(tab.named!==true)base=(primary?.agent?primary.program?.name:folderName(primary?.cwd,{home:this.home})||primary?.program?.name)||base;
    const key=(machine??'')+'\u0000'+tab.id,hit=this.labels.get(key);
    if(hit&&hit.gen===this.labelGen&&hit.base===base&&hit.name===tab.name)return hit.value;
    let value=null;if(tab.named===true&&this.service){try{value=this.service.label(tab,{machine});}catch{}}
    if(!value)value=displayLabel(base);
    if(this.labels.size>=512)this.labels.clear();this.labels.set(key,{gen:this.labelGen,base,name:tab.name,value});return value;
  }
  tabIcon(tab,primary,t){
    const program=primary?.program,path=safeArtworkPath(program?.icon),wrap=div().id('tab-icon-'+tab.id).size(14).flex_none();
    if(path)return wrap.child((program.tint?svg(path).text_color(program.color||t.muted):image(path)).size(14).flex_none());
    return wrap.child(icon(MOD,primary?.agent?'agent':primary?.mod?'panel':'folder',14).text_color(t.dim));
  }
  tabItem(tab,index,{t,space,machine,primaries}){
    const primary=primaries.get(tab.id)||null,l=this.labelFor(tab,machine,primary),status=STATUS[tab.status]?tab.status:null,name=l.text||String(index+1);
    const tip=[l.full||name,status?STATUS[status]:null,tab.zoomed?'Zoomed pane':null,tab.settled?'Settled · still running':null,l.mode==='manual'?'Named by you':l.mode==='auto'?'Automatic name':null].filter(Boolean).join('\n');
    const closeAt=this.closing.get(tab.id),now=Date.now(),closing=Boolean(closeAt&&now-closeAt>=0&&now-closeAt<TIMING.closeMs);
    let body=h_flex().id('tab-body-'+tab.id).h(28).px(9).gap(6).items_center().rounded(7).border(1).text_size(12.5)
      .border_color(tab.active?t.border:t.chrome).bg(tab.active?t.raised:t.chrome).text_color(tab.active?t.foreground:tab.settled?t.dim:t.muted)
      .hover(s=>s.bg(t.hover)).on_mouse_down('left',(event,cx)=>{cx.stop_propagation();this.pressTab(tab,space,event);}).on_mouse_up('left',()=>this.releaseTab(tab,space))
      .child(this.tabIcon(tab,primary,t)).child(div().id('tab-label-'+tab.id).max_w(NAME_LIMITS.displayPx).truncate().child(name))
      .when(tab.zoomed===true,el=>el.child(icon(MOD,'layout',11).text_color(t.dim)))
      .when(Boolean(status),el=>el.child(statusMark('tab-status-'+tab.id,status,t)));
    if(tab.active){
      let close=div().id('tab-close-'+tab.id).size(16).flex_none().flex().items_center().justify_center().rounded(4).text_color(t.dim).role('button').tooltip('Close tab').accessibility_label('Close tab '+name)
        .on_mouse_down('left',(_e,cx)=>{cx.stop_propagation();this.press=null;});
      if(!closing)close=close.cursor_pointer().hover(s=>s.bg(t.hover).text_color(t.foreground)).on_click((_e,cx)=>{cx.stop_propagation();this.closeTab(tab.id,cx);});
      body=body.child(close.child(icon(MOD,'close',11)));
    }
    return div().id('tab-'+tab.id).flex_none().role('tab').tooltip(tip).accessibility_label([name,status?STATUS[status]:null,tab.active?'shown':null].filter(Boolean).join(' · '))
      .on_mouse_down('right',(_e,cx)=>{cx.stop_propagation();this.press=null;this.openContext(tab,space,l.mode);}).child(body);
  }
  reopenButton(id,name,kind,preview){
    const ready=preview?.state==='ready'&&!this.reopenBusy(),label=preview?.label||(kind==='agent'?'Reopen last agent':'Reopen last tab');
    const detail=preview&&['ready','busy'].includes(preview.state)?[preview.title,preview.detail].filter(Boolean).join(' · '):null;
    const hint=[label+(detail?': '+detail:''),preview?.reason||(detail?null:'Nothing to reopen yet.')].filter(Boolean).join('\n');
    return iconButton(MOD,id,name,hint,(_e,cx)=>this.reopenLast(kind,cx),{disabled:!ready,size:26});
  }
  windowButtons(t,w){
    const b=(id,text,command,glyph)=>div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).role('button').tooltip(text).accessibility_label(text)
      .cursor_pointer().hover(s=>s.bg(t.hover).text_color(t.foreground)).on_mouse_down('left',(_e,cx)=>cx.stop_propagation()).on_click((_e,cx)=>{cx.stop_propagation();herdr.run(command);}).child(glyph);
    return h_flex().id('window-controls').flex_none().gap(2).items_center()
      .child(b('window-minimize','Minimize','window.minimize',div().w(10).h(1).bg(t.muted)))
      .child(b('window-maximize',w.maximized?'Restore':'Maximize','window.maximize',div().size(9).border(1).border_color(t.muted)))
      .child(b('window-close','Close window','window.close',icon(MOD,'close',13)));
  }
  topbar(cx){
    const t=colors(),space=this.activeSpace(),tabs=Array.isArray(space?.tabs)?space.tabs:[],machine=space?.machine??null,tree=herdr.layout(),contract=this.contract(tree),w=herdr.window?.()||null;
    let zoom=1;try{zoom=Number(herdr.settings()?.zoom)||1;}catch{}
    this.pickRequest(cx);
    const ctx={t,space,machine,primaries:primaryPanes(tabs,herdr.panes()||[])},previews=this.previews(),panel=renderPanelToggle(MOD,contract,{onToggle:()=>this.togglePanel()});
    const quick=renderSourceButtons(MOD,contract,{hidden:hiddenSources(herdr.shared),onPick:(id,shown)=>shown?this.togglePanel():this.openSource(id)});
    const plus=iconButton(MOD,'mc-new','plus',space?`New agent or terminal in ${space.name||'this space'}`:'Select a space to start an agent',()=>this.openMenu(space),{disabled:!space,size:26});
    return h_flex().id('mc-tabs').size_full().min_w(0).pl(lightsPadding({win:w,tree,zoom})).pr(8).gap(4).items_center().bg(t.chrome).border_b(1).border_color(t.border).text_color(t.foreground)
      .on_size_change((size,eventCx)=>{if(size?.width!==this.width){this.width=size?.width??null;eventCx.notify();}})
      .on_mouse_up('left',()=>{this.press=null;}).on_hover(hovered=>{if(!hovered)this.press=null;}).on_scroll_wheel(event=>this.wheel(event))
      .child(h_flex().id('mc-tab-strip').flex_1().min_w(0).h_full().gap(3).items_center().overflow_x_scroll().role('tab_list').accessibility_label(space?'Tabs in '+(space.name||'this space'):'Tabs')
        .children(tabs.map((tab,i)=>this.tabItem(tab,i,ctx))))
      .child(plus)
      .when(Boolean(previews),el=>el.child(this.reopenButton('reopen-tab','refresh','tab',previews.tab)).child(this.reopenButton('reopen-agent','agent','agent',previews.agent)))
      .when(Boolean(this.restart?.offers().length),el=>el.child(this.restartPill()))
      .when(Boolean(panel),el=>el.child(panel))
      .child(iconButton(MOD,'mc-sources','settings','Mission Control sources: choose which work sources to show',()=>this.openSources(),{size:26}))
      .child(renderSwap(MOD,contract,{compact:!(this.width>=TOPBAR_WIDE),onSwap:()=>this.swap()}))
      .when(Boolean(quick),el=>el.child(quick))
      .when(w?.buttons===true,el=>el.child(this.windowButtons(t,w)));
  }
  navigation(){
    const contract=this.contract(),space=this.activeSpace();
    return renderNavigation({mod:MOD,contract,width:this.width,scope:contract.active?scopeOf(contract.active,herdr.shared):null,spaceName:space?.name??null,hidden:hiddenSources(herdr.shared),
      onSelect:id=>{const r=selectSource(id,{contract:this.contract(),sharedFn:herdr.shared,setSharedFn:herdr.setShared,runFn:herdr.run});if(!r.ok)herdr.notify({title:'Work sources',body:r.message,level:'warning'});},
      onHide:()=>togglePanel({contract:this.contract(),runFn:herdr.run}),
      onSize:(size,cx)=>{if(size?.width!==this.width){this.width=size?.width??null;cx.notify();}}});
  }
  menuItem(id,text,action,{disabled=false,hint=null}={}){
    const t=colors();let el=h_flex().id(id).h(28).px(8).items_center().rounded(5).role('menu_item').accessibility_label(hint||text).text_color(disabled?t.dim:t.foreground);
    if(hint)el=el.tooltip(hint);if(!disabled)el=el.cursor_pointer().hover(s=>s.bg(t.hover)).on_click((_e,cx)=>{cx.stop_propagation();action(cx);});
    return el.child(text);
  }
  closeOverlay(){if(this.props.overlay)herdr.closeOverlay(this.props.overlay);}
  contextMenu(){
    const t=colors(),target=plain(this.props.target)?this.props.target:{},space=(herdr.spaces()||[]).find(s=>s?.id===target.spaceId)||null,tab=(space?.tabs||[]).find(x=>x?.id===target.tabId)||null;
    const root=v_flex().id('tab-menu').size_full().p(6).gap(2).bg(t.surface).text_size(12).text_color(t.foreground).role('menu').accessibility_label('Tab menu');
    if(!tab)return root.child(div().id('tab-menu-gone').p(8).text_color(t.muted).child('This tab is no longer open.'));
    const manual=tab.named===true&&target.mode!=='auto';
    return root.child(div().id('tab-menu-title').px(8).py(4).text_size(11).text_color(t.dim).truncate().tooltip(tab.name).child(displayLabel(tab.name).text||String(tab.index||'')))
      .child(this.menuItem('tab-menu-rename','Rename…',()=>{herdr.run('tab.rename',{id:tab.id});this.closeOverlay();}))
      .child(this.menuItem('tab-menu-automatic','Use automatic name',()=>{herdr.run('tab.rename',{id:tab.id,name:''});this.closeOverlay();},{disabled:!manual,hint:manual?'Return this tab to automatic naming':'This tab is already named automatically'}))
      .child(div().h(1).mx(6).my(3).bg(t.border))
      .child(this.menuItem('tab-menu-close','Close tab',()=>{
        // The bar closes it, so the close is captured for Reopen first.
        herdr.setShared(REQUEST_EVENT,{v:1,id:randomId('close'),action:'close',tabId:tab.id,spaceId:space.id,machine:space.machine??null,at:Date.now(),owner:this.instance});this.closeOverlay();
      }));
  }
  /** One switch per work source. A source that is off leaves the navigation strip and the Classic panel; its mod stays installed. */
  sourcesPanel(){
    const t=colors(),hidden=hiddenSources(herdr.shared),contract=this.contract();
    const row=s=>{
      const on=!hidden.has(s.id),present=sourceState(contract,s.id).enabled,label=`${s.label}: ${on?'on':'off'}`+(present?'':' (not in this layout)');
      const knob=div().size(12).rounded_full().bg(on?t.foreground:t.muted);
      const toggle=h_flex().id('source-switch-'+s.id).w(30).h(16).px(2).flex_none().items_center().rounded_full().bg(on?t.accent:t.border).when(on,el=>el.justify_end()).child(knob);
      return h_flex().id('source-row-'+s.id).h(34).px(8).gap(10).items_center().rounded(6).role('menu_item').tooltip(label).accessibility_label(label).cursor_pointer().hover(st=>st.bg(t.hover))
        .on_click((_e,cx)=>{cx.stop_propagation();setSourceShown(s.id,!on,{contract:this.contract(),sharedFn:herdr.shared,setSharedFn:herdr.setShared,runFn:herdr.run});cx.notify();})
        .child(icon(MOD,s.icon,15).text_color(on?t.foreground:t.dim)).child(div().flex_1().min_w(0).truncate().text_color(on?t.foreground:t.muted).child(s.label)).child(toggle);
    };
    return v_flex().id('mc-sources').size_full().overflow_y_scrollbar().p(8).gap(2).bg(t.surface).text_size(12.5).text_color(t.foreground).role('menu').accessibility_label('Mission Control sources')
      .child(div().id('mc-sources-title').px(8).pt(2).text_size(12.5).text_color(t.foreground).child('Work sources'))
      .child(div().id('mc-sources-note').px(8).pb(4).text_size(10.5).text_color(t.dim).child('Sources you turn off leave the navigation and the Classic panel. Their mods stay installed.'))
      .children(SOURCES.map(row))
      .when(this.codexRows(t).length>0,e=>e.child(div().id('mc-sources-restart').px(8).pt(6).text_size(10.5).text_color(t.dim).child('Resume after restart')).children(this.codexRows(t)))
      .when(Boolean(this.restartStatus),e=>e.child(div().id('mc-restart-status').px(8).text_size(10.5).text_color(t.muted).child(this.restartStatus)));
  }
  render(cx){
    if(this.dialog)return this.dialog.render(cx);
    if(this.role==='sources')return this.sourcesPanel();
    if(this.role==='topbar')return this.topbar(cx);
    if(this.role==='navigation')return this.navigation();
    if(this.role==='context')return this.contextMenu();
    if(this.role==='restart')return this.restartPanel();
    const t=colors();return div().id('tabs-unknown-view').size_full().p(8).bg(t.chrome).text_size(11).text_color(t.blocked).child(`Unknown Mission Control tabs view "${String(this.props.view).slice(0,40)}". Use topbar or navigation.`);
  }
  close(){
    if(this.closed)return;this.closed=true;for(const timer of this.timers)timer?.cancel?.();for(const job of this.jobs)job?.cancel?.();this.commandTask?.cancel?.();this.dialog?.close();
    // Leases are released best effort; an unreleased one simply expires and another copy takes over.
    if(this.service)return Promise.all([this.service.stop().catch(()=>{}),this.restart?.release().catch(()=>{})]);
  }
}
export {NODES,SOURCES};
