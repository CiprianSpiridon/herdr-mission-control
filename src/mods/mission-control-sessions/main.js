import {View,div} from 'gpui-kit';
import {v_flex,h_flex} from 'gpui-base';
import * as herdr from 'herdr';
import {TelemetryBridge} from '../../shared/telemetry.js';
import {NameOwnership} from '../../shared/name-ownership.js';
import {createLaunchIO} from '../../shared/launch.js';
import {resume,resumeSupport} from '../../shared/resume.js';
import {installedTools} from '../../shared/launch-preferences.js';
import {canonicalRepoPath} from '../../shared/config.js';
import {newIntent,sessionKey} from '../../shared/session-identity.js';
import {SessionHistory,resolveRepoCheckouts,membershipIndex,locateSession,pendingFolders,verifyFolders,journalCheckouts,runningSessions,sessionNames,deriveSessions,filterSessions,repoKey,hostLabel,providerNames,HISTORY_PAGE,STALE_LOAD_MS} from './model.js';
import {colors,label,icon,iconButton,toolIcon,createSearch,searchInput} from '../../shared/ui.js';

const MOD='mission-control-sessions',STATE='mission-control-sessions-ui-v1',PROVIDERS=['claude','codex','grok'];
const copy=value=>JSON.parse(JSON.stringify(value)),hostKey=machine=>JSON.stringify(machine??null);
const freeze=v=>{if(v&&typeof v==='object'&&!Object.isFrozen(v)){for(const c of Object.values(v))freeze(c);Object.freeze(v);}return v;};
// A retry keeps its request only once side effects may exist; any other click is a new intent.
const retained=result=>Boolean(result.recovery?.tabId)||['TAB_CREATE_UNCERTAIN','MALFORMED_ACK','RECOVERY_REQUIRED','BINDING_NOT_READY','UNPROVEN_SESSION'].includes(result.code);
function uiState(){const s=herdr.shared(STATE);return {all:s?.v===1&&s.all===true,query:typeof s?.query==='string'&&s.query.length<=200?s.query:'',tool:PROVIDERS.includes(s?.tool)?s.tool:'all'};}
export function sessionAge(at,now,{suffix=false}={}){
  if(!Number.isFinite(at))return '';const m=Math.max(0,Math.floor((now-at)/60000)),value=m<1?'':m<60?m+'m':m<1440?Math.floor(m/60)+'h':m<10080?Math.floor(m/1440)+'d':null;
  return value===null?new Date(at).toISOString().slice(0,10):value===''?'just now':value+(suffix?' ago':'');
}
function pill(id,content,action,{active=false,disabled=false,hint=typeof content==='string'?content:''}={}){
  const t=colors();let el=h_flex().id(id).h(24).px(7).gap(5).flex_none().items_center().rounded(4).text_size(11).text_color(disabled?t.dim:active?t.accent:t.muted).bg(active?t.selected:'#00000000').tooltip(hint).accessibility_label(hint).role('button');
  if(!disabled)el=el.cursor_pointer().hover(s=>s.bg(t.hover)).on_mouse_down('left',(_e,cx)=>cx.stop_propagation()).on_click((_e,cx)=>{cx.stop_propagation();return action(cx);});
  for(const part of Array.isArray(content)?content:[content])el=el.child(part);return el;
}

export default class MissionControlSessions extends View{
  init(_props,cx){
    this.props=herdr.props()||{};this.closed=false;this.jobs=[];this.timers=[];this.inputs=[];
    this.instance=Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8);this.io=createLaunchIO(herdr);
    this.history=new SessionHistory(()=>new TelemetryBridge(MOD,herdr));this.names=new NameOwnership(this.io,{owner:MOD+'-'+this.instance});
    Object.assign(this,{originPanes:new Map(),repoCache:new Map(),folders:new Map(),support:new Map(),programs:new Map(),resuming:new Map(),intents:new Map(),outcomes:new Map(),epoch:0,page:0,view:null,scope:null,status:null,basis:null,error:null,info:null,loading:null,memo:null,showSources:false,leased:false,observedKey:null,observing:0,observeRetryAt:0,runningAt:0});
    let pinned=null;try{if(this.props.session)pinned=sessionKey(this.props.session);}catch{}this.pinned=pinned;
    const saved=uiState(),explicit=Boolean(this.props.target?.spaceId||this.props.spaceId);
    this.all=this.props.scope==='all'||this.props.scope!=='space'&&!explicit&&saved.all;this.query=saved.query;this.tool=saved.tool;
    this.search=createSearch('Search sessions',value=>{this.query=value.slice(0,200);this.page=0;this.saveUI();});this.search.set_value(this.query);this.inputs.push(this.search);
    this.sync(cx,{force:true});
    // A standalone install adds the documented provider defaults for installed tools; history never waits for it.
    this.spawn(cx,async taskCx=>{await this.history.bridge.initializeSources();if(!this.closed)this.sync(taskCx,{force:true});});
    this.timers.push(cx.timer.every(60000,eventCx=>this.sync(eventCx,{force:true})));
    // A load or resume the host ended mid-flight is recovered here instead of staying busy for ever.
    this.timers.push(cx.timer.every(5000,eventCx=>this.recover(eventCx)));
    this.timers.push(cx.timer.every(2000,eventCx=>this.observeNames(eventCx)));
    this.commandTask=cx.spawn(async eventCx=>{while(!this.closed){const command=await herdr.nextCommand();if(this.closed)return;if(command==='refresh')this.refresh(eventCx);else if(command==='all-spaces')this.setScope(true,eventCx);else if(command==='this-space')this.setScope(false,eventCx);else if(command==='older')this.older(eventCx);eventCx.notify();}});
  }
  spawn(cx,work){
    this.jobs=this.jobs.filter(job=>!job?.is_done?.());
    const job=cx.spawn(async taskCx=>{try{await work(taskCx);}catch(error){if(!this.closed)this.error=typeof error?.code==='string'&&typeof error.message==='string'&&error.message.length<=300?error.message:'Session history could not be loaded. Retry.';}if(!this.closed)taskCx.notify();});
    this.jobs.push(job);return job;
  }
  ready(machine){return herdr.machines().some(m=>(m.name??null)===(machine??null)&&m.layout==='ready');}
  /** One host snapshot per pass; per-record native reads would grow with history size. */
  readiness(){const hosts=new Map(herdr.machines().map(m=>[m.name??null,m.layout==='ready']));return machine=>hosts.get(machine??null)===true;}
  isLoading(){return Boolean(this.loading)&&Date.now()-this.loading.at<STALE_LOAD_MS;}
  busy(key){const held=this.resuming.get(key);return Boolean(held)&&Date.now()-held.at<STALE_LOAD_MS;}
  saveUI(){herdr.setShared(STATE,{v:1,all:this.all,query:this.query,tool:this.tool});}
  remember(map,key,value,limit){map.delete(key);map.set(key,value);while(map.size>limit)map.delete(map.keys().next().value);}
  world(){
    const spaces=herdr.spaces(),focused=herdr.focused(),panes=herdr.panes(),owners=new Map();
    for(const space of spaces)for(const tab of space.tabs||[])owners.set(tab.id,space.id);
    for(const pane of panes)if(pane.terminal&&(pane.focused||pane.pane===focused?.pane)&&owners.has(pane.tab))this.originPanes.set(owners.get(pane.tab),pane.pane);
    const target=this.props.target||{},wanted=target.spaceId||this.props.spaceId||focused?.space,expected=Object.hasOwn(target,'machine')?target.machine:Object.hasOwn(this.props,'machine')?this.props.machine:undefined;
    return {spaces,panes,space:spaces.find(s=>s.id===wanted&&(expected===undefined||(s.machine??null)===(expected??null)))||null};
  }
  /** Capture scope and panes before any await; later focus never redirects a running load. */
  sync(cx,{force=false,more=false}={}){
    if(this.closed)return;const world=this.world(),space=world.space,scopeId=this.all?'all':JSON.stringify([space?.id??null,space?.machine??null]);
    const origin=space?this.originPanes.get(space.id):null,eligible=space?world.panes.filter(p=>p.terminal&&p.cwd&&space.tabs.some(t=>t.id===p.tab)):[],chosen=eligible.some(p=>p.pane===origin)?eligible.filter(p=>p.pane===origin):eligible;
    // Space names belong in the key: a rename must refresh the caption and All-spaces row labels.
    const key=JSON.stringify([scopeId,space?.name??null,this.all?world.spaces.map(s=>[s.id,s.machine??null,s.name]):chosen.map(p=>[p.pane,p.cwd]),herdr.machines().map(m=>[m.name,m.layout])]);
    if(!force&&!more&&key===this.contextKey)return;
    // A different space or scope clears the old rows at once; same-scope refreshes keep them.
    if(scopeId!==this.scopeId){this.scopeId=scopeId;this.view=null;this.status=null;this.basis=null;this.memo=null;this.page=0;this.loadedScope=null;}
    this.contextKey=key;this.scopeName=this.all?null:space?.name??null;
    const epoch=++this.epoch,mode=more?'more':this.loadedScope===scopeId?'refresh':'initial',snapshot=copy({spaces:world.spaces,panes:world.panes,space,chosen});
    this.loading={epoch,at:Date.now()};if(force)this.error=null;
    return this.spawn(cx,async taskCx=>{try{await this.load(taskCx,{epoch,mode,scopeId,all:this.all,...snapshot});}finally{if(this.loading?.epoch===epoch)this.loading=null;}});
  }
  async load(taskCx,{epoch,mode,scopeId,all,spaces,panes,space,chosen}){
    const current=()=>!this.closed&&epoch===this.epoch,ready=machine=>this.ready(machine);
    await this.history.refreshSources();if(!current())return;
    let repos=[],scope;
    if(all){repos=await this.resolveAll(spaces,panes,current);scope={all:true,activeSpaceId:herdr.focused()?.space??null};}
    else if(space){const repo=await this.resolveSpace(space,chosen);repos=[repo];scope={all:false,spaceId:space.id,spaceName:space.name,machine:space.machine??null,repo,repoKey:repo.state==='resolved'?repoKey(repo.machine,repo.repoRoot):null};}
    else scope={all:false,spaceId:null,spaceName:null,machine:null,repo:null,repoKey:null};
    if(!current())return;
    const index=membershipIndex(repos),machines=all?herdr.machines().map(m=>m.name??null):space?[space.machine??null]:[],ids=this.history.on(machines);
    let journal=new Map();try{journal=journalCheckouts(await this.io.readTextFile(this.io.appHome().replace(/\/$/,'')+'/mission-control/launches.json'));}catch{}
    if(!current())return;
    const folders=this.folders,isMember=all?()=>true:record=>locateSession(index,record,{journal,folders})?.repoKey===scope.repoKey;
    if(all||scope.repoKey){
      const pages=mode==='refresh'||all&&mode==='initial'?1:6,want=mode==='more'?this.filtered().rows.length+HISTORY_PAGE:HISTORY_PAGE*(this.page+1);
      await this.history.scan(this.history.on(machines.filter(ready)),{more:mode==='more',pages,want,isMember,isCurrent:current,pause:()=>taskCx.sleep(0)});if(!current())return;
    }
    const records=this.history.records(ids);
    await verifyFolders(this.io.exec,pendingFolders(index,records,{repoKey:all?undefined:scope.repoKey}),folders,{isCurrent:current});if(!current())return;
    let running=new Map();try{running=await runningSessions(this.io,{ready,isCurrent:current});}catch{}
    if(!current())return;await this.probeSupport(records,current);if(!current())return;
    this.basis={scope,index,records,journal,running,ids};await this.derive(taskCx);
    if(current()&&mode!=='more')this.loadedScope=scopeId;
  }
  async derive(taskCx){
    const basis=this.basis;if(!basis)return;let names=new Map();try{names=sessionNames((await this.names.read()).value);}catch{}
    if(this.closed||this.basis!==basis)return;
    const view=await deriveSessions({records:basis.records,index:basis.index,scope:basis.scope,journal:basis.journal,folders:this.folders,running:basis.running,names,support:this.support,ready:this.readiness()},{pause:()=>taskCx.sleep(0)});
    if(this.closed||this.basis!==basis)return;this.view=view;this.scope=basis.scope;this.status=this.history.status(basis.ids);this.memo=null;
  }
  async resolveSpace(space,panes){
    const key=JSON.stringify([space.id,space.machine??null]),cached=this.repoCache.get(key);
    if(!this.ready(space.machine))return cached?.repo||freeze({state:'offline',spaceId:space.id,machine:space.machine??null,spaceName:space.name,reason:hostLabel(space.machine??null)+' is offline or still connecting.'});
    const repo=await resolveRepoCheckouts(space,panes,this.io.exec);this.remember(this.repoCache,key,{repo,stamp:null,at:Date.now()},500);return repo;
  }
  /** Bounded to four spaces at a time; each space's repository comes from its own focused or first terminal.
   *  Unchanged terminals reuse their resolution for five minutes; Refresh resolves every space again. */
  async resolveAll(spaces,panes,current){
    const work=spaces.map(space=>async()=>{
      const eligible=panes.filter(p=>p.terminal&&p.cwd&&space.tabs.some(t=>t.id===p.tab)),pane=eligible.find(p=>p.pane===this.originPanes.get(space.id))||eligible[0]||null;
      const key=JSON.stringify([space.id,space.machine??null]),stamp=JSON.stringify([pane?.pane??null,pane?.cwd??null]),cached=this.repoCache.get(key);
      if(cached&&(!this.ready(space.machine)||cached.stamp===stamp&&Date.now()-cached.at<300000))return {...cached.repo,spaceName:space.name};
      if(!this.ready(space.machine))return null;
      const repo=await resolveRepoCheckouts({...space,active:false},pane?[pane]:[],this.io.exec);this.remember(this.repoCache,key,{repo,stamp,at:Date.now()},500);return repo;
    }),out=[];
    for(let i=0;i<work.length&&current();i+=4)out.push(...await Promise.all(work.slice(i,i+4).map(run=>run())));
    return out.filter(Boolean);
  }
  /** Labels rows before any click: only a verified exact resume on the owning host is offered. */
  async probeSupport(records,current){
    const pairs=new Map(),lists=new Map(),ready=this.readiness();for(const r of records){const machine=r.identity.machine;if(ready(machine))pairs.set(JSON.stringify([machine,r.identity.provider]),[machine,r.identity.provider]);}
    for(const[key,[machine,provider]]of pairs){
      if(!current())return;const saved=this.support.get(key);if(saved&&Date.now()-saved.at<60000)continue;
      if(!lists.has(hostKey(machine))){let list=null;try{list=await this.io.knownAgents({on:machine});}catch{}lists.set(hostKey(machine),Array.isArray(list)?list:null);if(Array.isArray(list))this.programs.set(hostKey(machine),new Map(list.filter(p=>typeof p?.key==='string').map(p=>[p.key,p])));}
      const list=lists.get(hostKey(machine));if(!list)continue;const tool=installedTools(list).find(t=>t.key===provider);
      if(!tool){this.support.set(key,freeze({supported:false,kind:null,reason:`${providerNames[provider]||provider} is not installed on ${hostLabel(machine)}.`,at:Date.now()}));continue;}
      try{const caps=await this.io.capabilities.get(tool,machine);this.support.set(key,freeze({...resumeSupport(caps,{provider,machine}),at:Date.now()}));}catch{}
    }
  }
  program(provider,machine){
    const own=this.programs.get(hostKey(machine))?.get(provider);if(own)return own;
    for(const programs of this.programs.values())if(programs.has(provider))return programs.get(provider);
    return {key:provider,name:providerNames[provider]||provider,icon:null};
  }
  filtered(){
    const m=this.memo;if(m&&m.view===this.view&&m.query===this.query&&m.tool===this.tool&&m.pinned===this.pinned)return m.value;
    const value=this.view?filterSessions(this.view,{query:this.query,tool:this.tool,session:this.pinned}):{rows:[],counts:{all:0}};this.memo={view:this.view,query:this.query,tool:this.tool,pinned:this.pinned,value};return value;
  }
  refresh(cx){this.repoCache.clear();return this.sync(cx,{force:true});}
  setScope(all,cx){if(this.all===all)return;this.all=all;this.pinned=null;this.saveUI();this.sync(cx,{force:true});}
  setTool(tool,cx){if(this.tool!==tool){this.tool=tool;this.page=0;this.saveUI();}cx.notify();}
  older(cx,page=this.page){const end=(page+1)*HISTORY_PAGE;this.page=page+1;if(end<this.filtered().rows.length){cx.notify();return;}if(this.status?.more&&!this.isLoading())return this.sync(cx,{more:true});cx.notify();}
  /** One exact resume or focus per click; a second click during it is ignored and the journal dedupes retries. */
  open(row,cx,{cwd}={}){
    if(this.closed||this.busy(row.key))return;
    if(row.state==='running'&&!row.spaceId){herdr.run('agent.focus',{terminal:row.running.terminal});return;}
    if(!row.spaceId||!row.repoRoot||!(cwd||row.checkoutRoot)){this.outcomes.set(row.key,freeze({ok:false,code:'SPACE_UNAVAILABLE',message:row.reason||'Open this repository in a space to resume.',recovery:{actions:[]}}));cx.notify();return;}
    let intent=this.intents.get(row.key);if(!intent){intent=newIntent();this.remember(this.intents,row.key,intent,1000);}
    const input={requestId:intent.requestId,spaceId:row.spaceId,session:copy(row.identity),repoRoot:row.repoRoot,cwd:cwd||row.checkoutRoot,...(row.reportedTitle?{title:row.reportedTitle}:{})},held={at:Date.now(),task:null};
    this.resuming.set(row.key,held);this.outcomes.delete(row.key);this.info=null;cx.notify();
    held.task=this.spawn(cx,async taskCx=>{
      const result=await resume(input,this.io);if(this.closed)return;if(this.resuming.get(row.key)===held)this.resuming.delete(row.key);
      if(result.ok){this.intents.delete(row.key);this.info=result.action==='focus'?'Focused the running session.':'Resumed '+row.title+' in its original checkout.';this.sync(taskCx,{force:true});return;}
      if(!retained(result))this.intents.delete(row.key);this.remember(this.outcomes,row.key,result,200);
    });
    return held.task;
  }
  locate(row,cx){
    if(row.machine!==null||this.busy(row.key))return;
    return this.spawn(cx,async taskCx=>{
      const folder=await herdr.pickFolder({prompt:'Use this checkout'});if(this.closed||!folder)return;let cwd;
      try{cwd=canonicalRepoPath(folder);}catch{this.remember(this.outcomes,row.key,freeze({ok:false,code:'INVALID_RESUME',message:'Choose the absolute checkout folder of this session.',recovery:{actions:['locate']}}),200);return;}
      await this.open(row,taskCx,{cwd});
    });
  }
  show(target){
    const spaces=herdr.spaces(),space=spaces.find(s=>s.id===target.spaceId)||spaces.find(s=>(s.tabs||[]).some(t=>t.id===target.tabId)),terminal=target.terminal&&target.machine&&!target.terminal.startsWith(target.machine+'/')?target.machine+'/'+target.terminal:target.terminal;
    if(space)herdr.run('space.select',{id:space.id});if(target.tabId)herdr.run('tab.select',{id:target.tabId});if(terminal)herdr.run('pane.focus',{terminal});
  }
  recover(cx){
    if(this.closed)return;const now=Date.now();let changed=false;
    for(const[key,held]of this.resuming)if(held.task?.is_done?.()||now-held.at>=STALE_LOAD_MS){this.resuming.delete(key);changed=true;}
    if(this.history.hasAbandonedLoad()){this.history.recover();this.loading=null;return this.sync(cx,{force:true});}
    if(this.loading&&now-this.loading.at>=STALE_LOAD_MS){this.loading=null;return this.sync(cx,{force:true});}
    if(changed)cx.notify();
  }
  /** Shared name observer while this View lives: records manual renames under one CAS lease. */
  observeNames(cx){
    const now=Date.now();if(this.closed||this.observing&&now-this.observing<10000||now<this.observeRetryAt)return;
    const tabs=[];for(const space of herdr.spaces())for(const tab of space.tabs||[])tabs.push({id:tab.id,machine:space.machine??null,name:typeof tab.name==='string'?tab.name:'',named:tab.named===true});
    const key=JSON.stringify(tabs.map(t=>[t.machine,t.id,t.name,t.named]));if(key===this.observedKey)return;this.observing=now;
    return this.spawn(cx,async taskCx=>{
      try{const result=await this.names.observeNames(tabs,{leaseMs:10000});if(this.closed)return;if(!result.owned){this.observeRetryAt=Date.now()+10000;return;}this.leased=true;this.observedKey=key;if(result.changed.length)await this.derive(taskCx);}
      catch{this.observeRetryAt=Date.now()+10000;}finally{this.observing=0;}
    });
  }
  /** Live terminal changes refresh exact running state only; history is not rescanned. */
  watchTerminals(cx){
    if(!this.basis)return;const key=herdr.terminals().map(t=>t?.address).join(' ');if(key===this.terminalKey)return;const first=this.terminalKey===undefined;this.terminalKey=key;if(first)return;
    if(this.runningAt&&Date.now()-this.runningAt<STALE_LOAD_MS){this.terminalKey=null;return;}this.runningAt=Date.now();
    return this.spawn(cx,async taskCx=>{
      try{const basis=this.basis,running=await runningSessions(this.io,{ready:m=>this.ready(m),isCurrent:()=>!this.closed&&this.basis===basis});if(this.closed||this.basis!==basis)return;this.basis={...basis,running};await this.derive(taskCx);}
      finally{this.runningAt=0;}
    });
  }
  header(){
    const t=colors();return h_flex().h(38).px(12).gap(8).items_center().border_b(1).border_color(t.border).child(icon(MOD,'sessions',16).text_color(t.muted)).child(div().font_semibold().text_size(12).text_color(t.foreground).child('Sessions'))
      .child(div().flex_1().min_w(0).truncate().text_size(10).text_color(t.dim).child(this.all?'All spaces':this.scopeName||''))
      .when(Boolean(this.props.overlay),row=>row.child(iconButton(MOD,'sessions-close','close','Close',()=>herdr.closeOverlay(this.props.overlay))));
  }
  toolbar(){
    return h_flex().px(10).pt(9).pb(6).gap(6).items_center().min_w(0)
      .child(h_flex().gap(2).flex_none().child(pill('sessions-scope-this','This space',cx=>this.setScope(false,cx),{active:!this.all})).child(pill('sessions-scope-all','All spaces',cx=>this.setScope(true,cx),{active:this.all})))
      .child(searchInput(MOD,'sessions-search',this.search).flex_1().min_w(0))
      .child(iconButton(MOD,'sessions-refresh','refresh','Refresh sessions',(_e,cx)=>this.refresh(cx),{size:26,disabled:this.isLoading()}))
      .child(iconButton(MOD,'sessions-sources','settings','History sources and paths',(_e,cx)=>{this.showSources=!this.showSources;cx.notify();},{size:26,active:this.showSources}));
  }
  toolFilters(counts){
    const t=colors(),count=n=>div().text_size(10).text_color(t.dim).child(String(n)),chips=[pill('sessions-tool-all',['All',count(counts.all)],cx=>this.setTool('all',cx),{active:this.tool==='all',hint:'All tools'})];
    for(const provider of PROVIDERS)if(counts[provider]||this.tool===provider)chips.push(pill('sessions-tool-'+provider,[toolIcon(MOD,this.program(provider,null),13),count(counts[provider]||0)],cx=>this.setTool(provider,cx),{active:this.tool===provider,hint:providerNames[provider]}));
    const row=h_flex().px(10).pb(6).gap(2).items_center().min_w(0).children(chips);
    return this.pinned?row.child(div().flex_1()).child(pill('sessions-show-all','Show all',cx=>{this.pinned=null;this.page=0;cx.notify();},{hint:'Show every session in this scope'})):row;
  }
  sourcesPanel(){
    const t=colors(),entries=this.history.list();
    return v_flex().id('sessions-source-list').mx(10).mb(6).p(8).gap(5).rounded(5).border(1).border_color(t.border).bg(t.chrome)
      .child(div().text_size(10).text_color(t.muted).child('Read-only provider metadata on each machine. History is never modified or deleted.'))
      .children(entries.map(e=>v_flex().id('sessions-source-'+e.id).gap(1).child(label(`${providerNames[e.source.provider]||e.source.provider} · ${hostLabel(e.source.machine)} · ${e.source.credentialScope}`,{size:11})).children(e.source.roots.map(root=>div().text_size(10).text_color(t.dim).truncate().tooltip(root).child(root)))))
      .when(!entries.length,el=>el.child(div().text_size(10).text_color(t.dim).child('No history sources are enabled.')));
  }
  banner(){
    const t=colors(),errors=this.status?.errors||[],lines=errors.map(e=>`${providerNames[e.provider]||e.provider} on ${hostLabel(e.machine)}: ${e.message}`),message=this.error||lines[0];if(!message)return null;
    return h_flex().id('sessions-error').mx(10).mb(6).px(8).py(4).gap(6).items_center().rounded(5).border(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.blocked).tooltip([this.error,...lines].filter(Boolean).join('\n')).accessibility_label(message).child(message))
      .when(lines.length>1,el=>el.child(label('+'+(lines.length-1),{muted:true,size:10})))
      .child(iconButton(MOD,'sessions-error-retry','refresh','Retry',(_e,cx)=>this.sync(cx,{force:true}),{size:22,disabled:this.isLoading()}));
  }
  empty(){
    const scope=this.scope,text=!this.view?(this.isLoading()?'Loading sessions…':'Sessions are unavailable. Retry.')
      :!this.all&&!scope?.spaceId?'Select a repository space to see its sessions.'
      :!this.all&&scope.repo?.state!=='resolved'?scope.repo?.reason||'Open or focus a terminal in this space’s repository.'
      :!this.status?.sources?`No session history sources are enabled${this.all?'':' on '+hostLabel(scope.machine)}.`
      :this.query||this.tool!=='all'||this.pinned?'No matching sessions.':this.all?'No previous sessions.':'No previous sessions in this repository yet.';
    return div().id('sessions-empty').p(16).text_size(11).text_color(colors().dim).child(text);
  }
  recovery(row,outcome){
    const buttons=[],actions=outcome?.recovery?.actions||[],candidate=outcome?.recovery?.candidates?.[0],tabId=outcome?.recovery?.tabId;
    if(candidate||tabId)buttons.push(iconButton(MOD,row.id+'-show','agent',candidate?'Show the running terminal':'Show its tab',()=>this.show(candidate||{tabId,terminal:outcome.recovery.terminalId}),{size:20}));
    if((row.state==='missing'||['WORKTREE_MISSING','CHECKOUT_MISMATCH'].includes(outcome?.code))&&row.machine===null&&row.spaceId)buttons.push(iconButton(MOD,row.id+'-locate','folder','Locate this checkout',(_e,cx)=>this.locate(row,cx),{size:20}));
    if(row.state==='offline')buttons.push(iconButton(MOD,row.id+'-retry','refresh','Retry',(_e,cx)=>this.sync(cx,{force:true}),{size:20,disabled:this.isLoading()}));
    else if(outcome?actions.some(a=>a.startsWith('retry')):row.state==='missing')buttons.push(iconButton(MOD,row.id+'-retry','refresh',actions.includes('retry-binding')?'Retry its binding':'Retry',(_e,cx)=>this.open(row,cx),{size:20}));
    if(outcome)buttons.push(iconButton(MOD,row.id+'-dismiss','close','Dismiss',(_e,cx)=>{this.outcomes.delete(row.key);cx.notify();},{size:20}));
    return buttons;
  }
  row(row,now){
    const t=colors(),busy=this.busy(row.key),outcome=this.outcomes.get(row.key),usable=['ready','running'].includes(row.state),clickable=usable&&!busy;
    const meta=[...new Set([row.branch,row.linked||!row.branch?row.folder:null,this.all?row.spaceName:null,row.host].filter(Boolean))].join(' · '),hint=clickable?(row.state==='running'?'Focus ':'Resume ')+row.title:row.title+(row.reason?' · '+row.reason:'');
    let el=v_flex().id(row.id).px(7).py(6).gap(3).rounded(5).min_w(0).bg(this.pinned===row.key?t.selected:'#00000000').tooltip([row.title,row.cwd||row.checkoutRoot,row.providerName+' · '+row.host].filter(Boolean).join('\n')).accessibility_label(hint).role('button');
    if(clickable)el=el.cursor_pointer().hover(s=>s.bg(t.hover)).on_click((_e,eventCx)=>this.open(row,eventCx));
    const status=busy?div().flex_none().text_size(10).text_color(t.accent).child(row.state==='running'?'Focusing…':'Opening…')
      :row.state==='running'?h_flex().flex_none().gap(4).items_center().child(div().size(5).rounded_full().bg(t.working)).child(div().text_size(10).text_color(t.working).child('Running'))
      :div().flex_none().text_size(10).text_color(t.dim).child(sessionAge(row.activityAt,now));
    el=el.child(h_flex().h(17).gap(7).items_center().min_w(0).child(toolIcon(MOD,this.program(row.provider,row.machine),15)).child(div().flex_1().min_w(0).truncate().text_color(usable?t.foreground:t.muted).child(row.title)).child(status))
      .child(h_flex().h(13).gap(5).items_center().min_w(0).child(div().w(15).flex_none()).when(Boolean(row.branch),r=>r.child(icon(MOD,'branch',10).text_color(t.dim))).child(div().flex_1().min_w(0).truncate().text_size(10).text_color(t.dim).child(meta)));
    const message=outcome?.message||row.reason;
    return message?el.child(h_flex().gap(4).items_center().min_w(0).child(div().w(15).flex_none()).child(div().flex_1().min_w(0).truncate().text_size(10).text_color(outcome?t.blocked:t.muted).tooltip(message).accessibility_label(message).child(message)).children(this.recovery(row,outcome))):el;
  }
  footer({page,total,shown,now}){
    const t=colors(),s=this.status,end=page*HISTORY_PAGE+shown,loading=this.isLoading(),more=end<total||Boolean(s?.more)&&!this.view?.truncated;
    const text=!this.view?'':(total?`${page*HISTORY_PAGE+1}–${end} of ${total}`:'0 sessions')+(s?.fetchedAt?' · Updated '+sessionAge(s.fetchedAt,now,{suffix:true}):'')+(loading?' · Updating':'')+(s?.unreadable?` · ${s.unreadable} unreadable`:'');
    return v_flex().id('sessions-footer').px(10).py(6).gap(4).border_t(1).border_color(t.border)
      .when(Boolean(this.info),el=>el.child(h_flex().id('sessions-info').gap(6).items_center().child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).tooltip(this.info).child(this.info)).child(iconButton(MOD,'sessions-dismiss-info','close','Dismiss',(_e,cx)=>{this.info=null;cx.notify();},{size:20}))))
      .child(h_flex().h(24).gap(4).items_center().child(div().flex_1().min_w(0).truncate().text_size(10).text_color(t.dim).child(text))
        .when(Boolean(this.view?.truncated||s?.truncated),el=>el.child(div().flex_none().text_size(10).text_color(t.dim).tooltip('Only the most recent 1000 sessions per scope are listed. Provider history is never deleted.').child('Most recent 1000')))
        .child(pill('sessions-newer','Newer',cx=>{this.page=Math.max(0,page-1);cx.notify();},{disabled:page===0,hint:'Newer sessions'}))
        .child(pill('sessions-older','Older',cx=>this.older(cx,page),{disabled:!more||loading&&end>=total,hint:'Older sessions'})));
  }
  render(cx){
    this.sync(cx);this.watchTerminals(cx);
    const t=colors(),now=Date.now(),filtered=this.filtered(),total=filtered.rows.length,page=Math.min(this.page,Math.max(0,Math.ceil(total/HISTORY_PAGE)-1)),rows=filtered.rows.slice(page*HISTORY_PAGE,(page+1)*HISTORY_PAGE);
    const root=v_flex().id('sessions-panel').relative().size_full().min_w(0).min_h(0).bg(t.surface).text_size(12);
    if(!this.props.hideHeader)root.child(this.header());
    root.child(this.toolbar()).child(this.toolFilters(filtered.counts));
    if(this.showSources)root.child(this.sourcesPanel());
    const banner=this.banner();if(banner)root.child(banner);
    root.child(v_flex().id('sessions-list').flex_1().min_h(0).overflow_y_scrollbar().px(6).pb(4).gap(1).children(rows.map(row=>this.row(row,now))).when(!rows.length,el=>el.child(this.empty())));
    return root.child(this.footer({page,total,shown:rows.length,now}));
  }
  async close(){
    if(this.closed)return;this.closed=true;this.epoch++;for(const timer of this.timers)timer?.cancel?.();for(const job of this.jobs)job?.cancel?.();this.commandTask?.cancel?.();this.history.close();for(const input of this.inputs)input.release();
    if(this.leased)try{await this.names.releaseLease();}catch{}
  }
}
