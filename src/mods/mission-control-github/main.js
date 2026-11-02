import {View,div} from 'gpui-kit';
import {v_flex,h_flex,InputState,Input,TextareaState,Textarea} from 'gpui-base';
import * as herdr from 'herdr';
import {readConfig,configPath} from '../../shared/config.js';
import {validateIssue,validateRepoBinding,trackerOrigin,issueIdentityKey} from '../../shared/tracker-model.js';
import {resolveSpaceRepo,launchTarget} from '../../shared/space-repo.js';
import {createLaunchIO,validateLaunchRequest,verifyTabAcknowledgement} from '../../shared/launch.js';
import {LaunchDialog,openLaunchDialog,quickStart} from '../../shared/launch-dialog.js';
import {IssueBoardState,renderIssueBoard} from '../../shared/issue-board.js';
import {GithubDataBridge,githubSetupModel,githubApiBase} from './data.js';
import {validatePullRequest,pullIdentityKey,validatePRActionRequest,prActionAvailability,prReasonText,prLaunchSource} from './pull-model.js';
import {PullBoardState,renderPullBoard,pullSlotKey} from './pulls-view.js';
import {colors,label,icon,iconButton,textButton} from '../../shared/ui.js';

const MOD='mission-control-github',STATE='mission-control-github-ui-v1',CONFIG_EVENT='mission-control-github-config-v1',DATA_EVENT='mission-control-github-data-v1',PREFS_EVENT='mission-control-github-prefs-v1';
const PULL_STATE='mission-control-github-prs-ui-v1',SLOT_EVENT='mission-control-github-launches-v1';
const copy=value=>JSON.parse(JSON.stringify(value)),machineKey=machine=>JSON.stringify(machine);
const fail=(code,message)=>{throw Object.assign(Error(message),{code});};
const UI_STATES=['all','todo','inProgress','done'];
const pullActionsTitle=action=>({review:'Review',addressComments:'Address comments',fixChecks:'Fix checks'})[action];
function uiState(pulls=false){const s=herdr.shared(pulls?PULL_STATE:STATE),states=pulls?['all','open','draft','closed','merged']:UI_STATES;return {all:s?.v===1&&s.all===true,query:typeof s?.query==='string'&&s.query.length<=512?s.query:'',status:states.includes(s?.status)?s.status:'all'};}
const sameRepo=(a,b)=>a?.machine===b?.machine&&a?.repoRoot===b?.repoRoot;

export function githubLaunchSource(value){const issue=validateIssue(value);if(issue.identity.kind!=='github')fail('INVALID_SCOPE','Select a GitHub issue.');return {kind:'github',connectionId:issue.identity.connectionId,site:issue.identity.site,id:issue.identity.id,key:issue.key,title:issue.title,url:issue.url,body:issue.body};}

/** Snapshot space/pane identity before the first await; never consult later active-space state. */
async function captureRepository(binding,{all=false,resolved,originPane,isCurrent=()=>true,api=herdr}={}){
  const world=copy(api.spaces()),focus=api.focused(),panes=api.panes().map(p=>({...p,focused:p.focused||p.pane===focus?.pane}));
  const machine=api.machines().find(m=>m.name===binding.machine);if(!machine||machine.layout!=='ready')fail('HOST_UNAVAILABLE','The issue’s execution machine is offline or still connecting.');
  let active=0;const waiting=[];
  const exec=async(...args)=>{if(active>=4)await new Promise(resolve=>waiting.push(resolve));else active++;try{if(!isCurrent())fail('REQUEST_CANCELLED','This launch was cancelled.');const result=await api.exec(...args);if(!isCurrent())fail('REQUEST_CANCELLED','This launch was cancelled.');return result;}finally{const next=waiting.shift();if(next)next();else active--;}};
  const check=async(space,{singlePane}={})=>{
    const scoped=panes.filter(p=>(space.tabs||[]).some(t=>t.id===p.tab)),chosen=singlePane?scoped.filter(p=>p.pane===singlePane):scoped;
    let result=await resolveSpaceRepo(all?{...space,active:false}:space,chosen,exec);
    if(all&&result.state==='ambiguous'){
      const match=result.candidates.find(c=>c.repoRoot===binding.repoRoot);if(match)result=await resolveSpaceRepo({...space,active:false},scoped.filter(p=>p.pane===match.paneId),exec);
    }
    return result.state==='resolved'&&sameRepo(result,binding)?result:null;
  };
  let selected;
  if(!all){
    if(resolved?.state!=='resolved'||!sameRepo(resolved,binding))fail('INVALID_SCOPE','The clicked issue is no longer bound to this repository. Reload the space.');
    const space=world.find(s=>s.id===resolved.spaceId&&s.machine===binding.machine);if(!space)fail('SPACE_UNAVAILABLE','The clicked issue’s repository space is unavailable.');
    const liveFocus=panes.find(p=>p.terminal&&p.focused&&(space.tabs||[]).some(t=>t.id===p.tab));selected=await check(space,{singlePane:liveFocus?.pane||originPane||resolved.paneId});
  }else{
    const candidates=world.filter(s=>s.machine===binding.machine);
    for(let start=0;!selected&&start<candidates.length;start+=4){const batch=await Promise.all(candidates.slice(start,start+4).map(s=>check(s)));selected=batch.find(Boolean);}
  }
  if(!isCurrent())fail('REQUEST_CANCELLED','This launch was cancelled.');if(!selected)fail('REPO_UNAVAILABLE','Open or focus a terminal in this issue’s repository before starting work.');
  return selected;
}
export async function captureGithubTarget(value,options={}){
  const issue=validateIssue(value),source=githubLaunchSource(issue),capturedRoot=options.checkoutRoot??issue.repoBinding.repoRoot,selected=await captureRepository(issue.repoBinding,options),target=launchTarget(selected);if(options.all)target.checkoutRoot=capturedRoot;
  return {issue,source,target};
}

/** Presentation hints only. The shared launcher alone verifies and mutates saved work. */
export async function readGithubPullSlots(io,spaces){
  const slots=new Map(),raw=await io.readTextFile(io.appHome().replace(/\/$/,'')+'/mission-control/launches.json');if(raw===null||typeof raw!=='string'||raw.length>180000)return slots;
  let journal;try{journal=JSON.parse(raw);}catch{return slots;}if(journal?.v!==1||!journal.requests||Array.isArray(journal.requests)||typeof journal.requests!=='object'||Object.keys(journal.requests).length>2000)return slots;
  for(const record of Object.values(journal.requests))try{
    const request=validateLaunchRequest(record.request),source=request.source;if(source?.kind!=='github-pr'||!record.ack||!/^[a-z0-9_.-]+\/[a-z0-9_.-]+#[1-9][0-9]*$/.test(source.id))continue;
    const ack=verifyTabAcknowledgement(record.ack,request),key=JSON.stringify([request.machine,request.repoRoot,source.kind,source.connectionId,source.site,source.id,request.toolKey]);if(slots.has(key))continue;
    const tab=spaces.find(s=>s.machine===request.machine&&s.id===ack.space)?.tabs.find(t=>t.id===ack.tab),present=tab&&(!tab.terminals||tab.terminals.some(t=>t.terminal===ack.terminal));slots.set(key,{state:present?'open':'closed',source:copy(source),ack:copy(ack)});
  }catch{/* A malformed hint can never authorize a launch or hide its journal error. */}
  return slots;
}

export default class MissionControlGithub extends View{
  init(_props,cx){
    this.props=herdr.props()||{};this.role=this.props.view==='issues'||!this.props.view?'panel':this.props.view;this.closed=false;this.jobs=[];this.timers=[];this.inputs=[];this.originPanes=new Map();this.tools=new Map();this.toolTimes=new Map();this.toolRevision=0;this.emptyPreferences={};this.toolPending=new Set();this.launching=new Set();this.pullLifetimeRevision=0;this.slots=new Map();this.slotEpoch=0;this.contextEpoch=0;this.formEpoch=0;this.preferencesEpoch=0;this.lastPrefs=JSON.stringify(herdr.shared(PREFS_EVENT)||null);this.launchPreferences=null;this.seq=0;this.error=null;this.info=null;this.instance=Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8);this.io=createLaunchIO(herdr);
    if(['launch','settings','menu'].includes(this.role)){
      const dialogApi={...herdr,writeTextFile:async(file,text,expected)=>{const result=await herdr.writeTextFile(file,text,expected);if(file===configPath(this.io))herdr.setShared(PREFS_EVENT,{v:1,owner:this.instance,revision:++this.seq});if(file===this.io.appHome().replace(/\/$/,'')+'/mission-control/launches.json')herdr.setShared(SLOT_EVENT,{v:1,owner:this.instance,revision:++this.seq});return result;}};
      this.dialog=new LaunchDialog(MOD,this.props,dialogApi);this.dialogTask=this.dialog.init(cx);return;
    }
    this.data=new GithubDataBridge(this.io,{view:this.role==='pulls'?'pulls':'issues',onChange:()=>{if(!this.closed)herdr.setShared(DATA_EVENT,{owner:this.instance,revision:++this.seq});}});
    if(this.role==='setup'){
      this.setupLoading=true;this.capturedWorld=this.world();this.spawn(cx,async()=>{try{this.config=(await readConfig(this.io)).value;if(this.closed)return;if(this.props.target)this.setupTarget=validateRepoBinding({machine:this.props.target.machine,repoRoot:this.props.target.repoRoot});else await this.resolveSetup(this.capturedWorld.space,this.capturedWorld.panes);if(!this.closed&&this.setupTarget)this.initializeForm();}finally{this.setupLoading=false;}});return;
    }
    const saved=uiState(this.role==='pulls');this.all=this.props.scope==='all'||this.props.scope!=='space'&&saved.all;
    this.board=new (this.role==='pulls'?PullBoardState:IssueBoardState)({query:saved.query,status:saved.status,onChange:()=>this.saveUI()});this.lastConfig=JSON.stringify(herdr.shared(CONFIG_EVENT)||null);this.contextKey=null;
    this.syncFromWorld(cx,{force:true});this.timers.push(cx.timer.every(60000,eventCx=>this.syncFromWorld(eventCx,{force:true})));
    // A load the host ended mid-flight is retried here instead of showing Loading for ever.
    this.timers.push(cx.timer.every(5000,eventCx=>{if(!this.closed&&this.data.hasAbandonedLoad())this.spawn(eventCx,()=>this.data.recoverAbandoned());}));
    this.commandTask=cx.spawn(async(eventCx)=>{while(!this.closed){const command=await herdr.nextCommand();if(this.closed)return;if(command==='refresh')this.syncFromWorld(eventCx,{force:true});else if(command==='setup')this.openSetup(undefined,eventCx);else if(command==='all-spaces')this.setScope(true,eventCx);else if(command==='this-space')this.setScope(false,eventCx);eventCx.notify();}});
  }
  spawn(cx,work){
    this.jobs=this.jobs.filter(job=>!job?.is_done?.());const job=cx.spawn(async(eventCx)=>{try{await work(eventCx);}catch(error){if(!this.closed&&error?.code!=='REQUEST_CANCELLED')this.error=error?.code?error.message:'GitHub could not complete this action. Check the selected connection and retry.';}if(!this.closed)eventCx.notify();});this.jobs.push(job);return job;
  }
  world(){
    const spaces=herdr.spaces(),focused=herdr.focused(),panes=herdr.panes().map(p=>({...p,focused:p.focused||p.pane===focused?.pane}));
    for(const space of spaces){const pane=panes.find(p=>p.terminal&&p.focused&&space.tabs.some(t=>t.id===p.tab));if(pane)this.originPanes.set(space.id,pane.pane);}
    const wanted=this.props.target?.spaceId||this.props.spaceId||focused?.space,expected=this.props.target&&Object.hasOwn(this.props.target,'machine')?this.props.target.machine:Object.hasOwn(this.props,'machine')?this.props.machine:undefined,space=spaces.find(s=>s.id===wanted&&(expected===undefined||s.machine===expected));
    return {spaces:copy(spaces),space:space?copy(space):null,panes};
  }
  saveUI(){if(this.board)herdr.setShared(this.role==='pulls'?PULL_STATE:STATE,{v:1,all:this.all,...this.board.filters()});}
  refreshSlots(cx,{force=false}={}){
    if(this.role!=='pulls'||this.closed)return;const spaces=copy(herdr.spaces()),key=JSON.stringify([herdr.shared(SLOT_EVENT)||null,spaces.map(s=>[s.id,s.machine,s.tabs.map(t=>[t.id,t.terminals?.map(p=>p.terminal)])])]);if(!force&&key===this.slotContext)return;this.slotContext=key;const epoch=++this.slotEpoch;
    return this.spawn(cx,async()=>{const slots=await readGithubPullSlots(this.io,spaces);if(!this.closed&&epoch===this.slotEpoch)this.slots=slots;});
  }
  refreshPreferences(cx){
    const revision=JSON.stringify(herdr.shared(PREFS_EVENT)||null);if(this.closed||revision===this.lastPrefs)return;this.lastPrefs=revision;const epoch=++this.preferencesEpoch;
    return this.spawn(cx,async()=>{const config=(await readConfig(this.io)).value;if(!this.closed&&epoch===this.preferencesEpoch){this.launchPreferences=config.preferences.launch||{};if(this.config)this.config={...this.config,preferences:config.preferences};}});
  }
  setScope(all,cx){if(this.all===all)return;this.all=all;this.saveUI();this.contextKey=null;this.syncFromWorld(cx,{force:true});}
  discover(machine,cx){
    const key=machineKey(machine),host=herdr.machines().find(m=>m.name===machine);if(host?.layout!=='ready'||this.toolPending.has(key)||Date.now()-(this.toolTimes.get(key)||0)<60000)return;
    this.toolPending.add(key);return this.spawn(cx,async()=>{try{const tools=await herdr.knownAgents({on:machine});if(!this.closed){this.tools.set(key,tools);this.toolRevision++;this.toolTimes.set(key,Date.now());}}catch{this.tools.delete(key);this.toolRevision++;}finally{this.toolPending.delete(key);}});
  }
  syncFromWorld(cx,{force=false}={}){
    if(this.closed||!['panel','pulls'].includes(this.role))return;const captured=this.world(),revision=JSON.stringify(herdr.shared(CONFIG_EVENT)||null),space=captured.space,origin=space?this.originPanes.get(space.id):null;
    const eligible=captured.panes.filter(p=>space?.tabs.some(t=>t.id===p.tab)),bound=this.props.target?.repoRoot&&!this.props.target.spaceId,key=this.all?'all':bound?JSON.stringify(['bound',this.props.target.machine,this.props.target.repoRoot,captured.panes.map(p=>[p.pane,p.terminal,p.cwd])]):JSON.stringify([space?.id??null,space?.machine??null,origin??null,eligible.map(p=>[p.pane,p.terminal,p.cwd])]);
    const changed=key!==this.contextKey||revision!==this.lastConfig;if(!force&&!changed)return;
    this.contextKey=key;this.lastConfig=revision;const epoch=++this.contextEpoch,preferencesEpoch=this.preferencesEpoch;if(changed){this.resolved=null;this.data.clearSelection();}this.error=null;this.info=null;this.refreshSlots(cx,{force:true});
    return this.spawn(cx,async(eventCx)=>{
      let resolved=null;
      if(!this.all&&this.props.target?.repoRoot&&!this.props.target.spaceId){
        const binding=validateRepoBinding({machine:this.props.target.machine,repoRoot:this.props.target.repoRoot});
        try{resolved=await captureRepository(binding,{all:true,isCurrent:()=>!this.closed&&epoch===this.contextEpoch});}catch(error){if(error.code==='REQUEST_CANCELLED')throw error;resolved={machine:binding.machine,repoRoot:binding.repoRoot};}
      }else if(space){
        const chosen=origin?eligible.filter(p=>p.pane===origin):eligible;
        resolved=await resolveSpaceRepo(space,chosen,async(...args)=>{if(this.closed||epoch!==this.contextEpoch)fail('REQUEST_CANCELLED','Repository selection changed.');const result=await herdr.exec(...args);if(this.closed||epoch!==this.contextEpoch)fail('REQUEST_CANCELLED','Repository selection changed.');return result;});
        if(this.props.target?.repoRoot&&resolved.state==='resolved'&&!sameRepo(resolved,this.props.target))resolved={state:'error',spaceId:space.id,machine:space.machine,reason:'The bound repository changed. Reopen this panel from its original space.'};
      }
      if(this.closed||epoch!==this.contextEpoch)return;this.resolved=resolved;this.scopeSpace=bound?captured.spaces.find(s=>s.id===resolved?.spaceId)||null:space;
      await this.data.synchronize(resolved,{all:this.all});if(this.closed||epoch!==this.contextEpoch)return;this.config=this.data.config;if(preferencesEpoch===this.preferencesEpoch)this.launchPreferences=this.config?.preferences.launch||{};
      for(const machine of new Set(this.data.view().bindings.map(b=>b.binding.machine)))this.discover(machine,eventCx);
      await this.data.refresh({force});
    });
  }
  launchReason(issue){
    if(this.launching.has(issueIdentityKey(issue)))return 'Starting this issue…';if(!this.all&&this.props.target?.repoRoot&&this.resolved?.state!=='resolved')return 'Open this repository in a space to start work.';const host=herdr.machines().find(m=>m.name===issue.repoBinding.machine);return host?.layout==='ready'?'':'The execution machine is offline or still connecting.';
  }
  startIssue(value,toolKey,cx,{options=false}={}){
    let issue;try{issue=validateIssue(value);githubLaunchSource(issue);}catch{this.error='This issue is unavailable. Refresh its connection.';cx.notify();return;}
    const key=issueIdentityKey(issue);if(this.launching.has(key))return;this.launching.add(key);this.error=null;const all=this.all,resolved=this.resolved?copy(this.resolved):null,originPane=resolved?this.originPanes.get(resolved.spaceId):null,checkoutRoot=this.data.view().bindings.find(b=>sameRepo(b.binding,issue.repoBinding))?.checkoutRoot??issue.repoBinding.repoRoot;cx.notify();
    return this.spawn(cx,async()=>{
      try{const captured=await captureGithubTarget(issue,{all,resolved,originPane,checkoutRoot,isCurrent:()=>!this.closed});if(this.closed)return;
        if(options)openLaunchDialog(MOD,herdr,{view:'launch',target:captured.target,...captured.target,source:captured.source,...(toolKey?{toolKey}:{})});
        else{const result=await quickStart({target:captured.target,source:captured.source,toolKey},this.io);if(!result.ok)this.error=result.message;}
      }finally{this.launching.delete(key);}
    });
  }
  pullReason(pull){
    if(this.launching.has(pullIdentityKey(pull)))return 'Opening this pull request’s agent…';if(!this.all&&this.props.target?.repoRoot&&this.resolved?.state!=='resolved')return 'Open this repository in a space to start work.';return herdr.machines().find(m=>m.name===pull.repoBinding.machine)?.layout==='ready'?'':'The execution machine is offline or still connecting.';
  }
  loadPullDetails(pull,cx){return this.spawn(cx,()=>this.data.loadPullDetails(validatePullRequest(pull)));}
  startPull(value,action,toolKey,cx,{options=false}={}){
    let pull,origin;try{pull=validatePullRequest(value);if(this.launching.has(pullIdentityKey(pull)))return;origin=this.data.acquirePullOrigin(pull);}catch{this.error='This pull request changed. Refresh its repository.';cx.notify();return;}
    const key=pullIdentityKey(pull);this.launching.add(key);this.pullLifetimeRevision++;const held=this.board.retain(key);this.error=null;this.info=null;
    const all=this.all,resolved=this.resolved?copy(this.resolved):null,originPane=resolved?this.originPanes.get(resolved.spaceId):null,checkoutRoot=this.data.view().bindings.find(b=>sameRepo(b.binding,pull.repoBinding))?.checkoutRoot??pull.repoBinding.repoRoot,requestId=this.instance+'-'+(++this.seq);
    const current=()=>!this.closed&&this.data.pullOriginCurrent(origin);herdr.setShared(DATA_EVENT,{owner:this.instance,revision:++this.seq});cx.notify();
    const job=this.spawn(cx,async()=>{
      try{
        const selected=await captureRepository(pull.repoBinding,{all,resolved,originPane,isCurrent:current}),target=launchTarget(selected);if(all)target.checkoutRoot=checkoutRoot;
        // Both the full target and action are frozen before any provider detail request.
        let request=validatePRActionRequest({action,pull,toolKey:toolKey||'options',requestId,checkoutRoot:target.checkoutRoot});
        const slots=await readGithubPullSlots(this.io,copy(herdr.spaces()));if(!current())fail('REQUEST_CANCELLED','This pull request’s source changed.');this.slots=slots;
        const previous=toolKey?slots.get(pullSlotKey(pull,toolKey)):null;let source;
        if(previous&&!options)source=previous.source;
        else{
          const detailed=await this.data.loadPullDetails(pull,{origin});if(!current()||!this.data.detailCurrent(pull,{origin}))fail('REQUEST_CANCELLED','This pull request changed while loading details. Refresh and retry.');request=validatePRActionRequest({...request,pull:detailed});
          const available=prActionAvailability(request.pull,request.action);if(!available.enabled)fail('PR_ACTION_UNAVAILABLE',available.reason?prReasonText(available.reason):'Checks are not failing.');source=prLaunchSource(request);
        }
        if(!current())fail('REQUEST_CANCELLED','This pull request’s source changed.');
        await this.data.validatePullOrigin(origin);
        if(options)openLaunchDialog(MOD,herdr,{view:'launch',target,source,...(toolKey?{toolKey}:{})});
        else{
          const result=await quickStart({target,source,toolKey},this.io);if(!result.ok)this.error=result.message;else this.info=result.reused?'Opened existing agent. No new task was sent.':pullActionsTitle(request.action)+' started.';
          herdr.setShared(SLOT_EVENT,{v:1,owner:this.instance,revision:++this.seq});
        }
      }finally{this.data.releasePullOrigin(origin);this.launching.delete(key);this.board.unretain(key);this.pullLifetimeRevision++;if(!this.closed)herdr.setShared(DATA_EVENT,{owner:this.instance,revision:++this.seq});}
    });held.task=job;return job;
  }
  openPullLink(value,url,cx){
    let pull;try{pull=validatePullRequest(value);if(url!==pull.url&&url!==pull.author.url&&!pull.linkedIssues.some(i=>i.url===url))fail('INVALID_PR','This link is unavailable.');}catch{this.error='This pull request link is unavailable. Refresh its connection.';cx.notify();return;}
    return this.spawn(cx,async()=>{const platform=herdr.window().platform,command=platform==='macos'?'open':platform==='windows'?'explorer.exe':'xdg-open',result=await herdr.exec(command,[url]);if(result.code!==0)fail('OPEN_FAILED','The browser could not open this link.');});
  }
  openIssue(value,cx){let issue;try{issue=validateIssue(value);githubLaunchSource(issue);}catch{this.error='This issue link is unavailable. Refresh its connection.';cx.notify();return;}
    return this.spawn(cx,async()=>{const platform=herdr.window().platform,command=platform==='macos'?'open':platform==='windows'?'explorer.exe':'xdg-open',result=await herdr.exec(command,[issue.url]);if(result.code!==0)fail('OPEN_FAILED','The browser could not open this issue.');});
  }
  openSetup(binding,cx){
    if(binding||this.props.target?.repoRoot||!this.all&&this.resolved?.state==='resolved'){
      const target=binding||this.props.target||this.resolved;return herdr.openOverlay({mod:MOD,kind:'dialog',width:680,height:760,props:{view:'setup',target:{machine:target.machine,repoRoot:target.repoRoot}}});
    }
    const captured=this.world();return herdr.openOverlay({mod:MOD,kind:'dialog',width:680,height:760,props:{view:'setup',...(captured.space?{spaceId:captured.space.id,machine:captured.space.machine}:{})}});
  }
  openShortcuts(cx){
    const captured=this.world(),bound=this.props.target?.repoRoot?validateRepoBinding({machine:this.props.target.machine,repoRoot:this.props.target.repoRoot}):null,origin=captured.space?this.originPanes.get(captured.space.id):null;
    return this.spawn(cx,async()=>{let resolved;if(bound)resolved=await captureRepository(bound,{all:true,isCurrent:()=>!this.closed});else{if(!captured.space)fail('SPACE_UNAVAILABLE','Select a repository space first.');const panes=origin?captured.panes.filter(p=>p.pane===origin):captured.panes;resolved=await resolveSpaceRepo(captured.space,panes,herdr.exec);}if(resolved.state!=='resolved')fail('REPO_UNAVAILABLE',resolved.reason);const target=launchTarget(resolved);if(!this.closed)openLaunchDialog(MOD,herdr,{view:'settings',target,...target});});
  }
  async resolveSetup(space,panes){
    this.setupSpace=space;this.setupPanes=panes;if(!space){this.setupError='Choose a repository space.';return;}
    const origin=this.originPanes.get(space.id),chosen=origin?panes.filter(p=>p.pane===origin):panes,result=await resolveSpaceRepo(space,chosen,herdr.exec);if(this.closed)return;
    if(result.state==='resolved'){this.setupTarget={machine:result.machine,repoRoot:result.repoRoot};this.setupError=null;this.setupCandidates=[];}
    else{this.setupTarget=null;this.setupError=result.reason;this.setupCandidates=result.state==='ambiguous'?result.candidates.filter(c=>c.repoRoot):[];}
  }
  chooseSetup(space,cx,paneId){if(this.setupLoading)return;this.setupLoading=true;this.error=null;const panes=herdr.panes().map(p=>({...p}));return this.spawn(cx,async()=>{try{await this.resolveSetup(space,paneId?panes.filter(p=>p.pane===paneId):panes);if(!this.closed&&this.setupTarget)this.initializeForm();}finally{this.setupLoading=false;}});}
  input(value,placeholder,{rows,discovery=true}={}){
    const state=rows?TextareaState.new({value,placeholder,rows}):InputState.new({value,placeholder});
    state.on('change',(_e,cx)=>{if(!this.initializingForm){this.formEpoch++;this.data.cancelSetup();this.discovering=false;this.error=null;this.saved=false;if(discovery){this.projectFields=null;this.projectFieldId=null;this.projectOptions={todo:[],inProgress:[],done:[]};}}cx.notify();});this.inputs.push(state);return state;
  }
  nextProfileId(){let id='github-work',n=2;while(this.config.connections[id])id='github-work-'+n++;return id;}
  initializeForm(){
    for(const input of this.inputs)input.release();this.inputs=[];const model=githubSetupModel(this.config,{state:'resolved',...this.setupTarget}),selection=model.selection;
    this.owner=this.input(selection.owner||'','Repository owner');this.repo=this.input(selection.repo||'','Repository name');this.profileId=this.input('','Profile ID');this.site=this.input('','https://github.com');this.tokenEnv=this.input('','WORK_GITHUB_TOKEN');this.ghAccount=this.input('','Installed gh account');
    this.projectOwner=this.input(selection.status?.project?.owner||selection.owner||'','Project owner');this.projectNumber=this.input(String(selection.status?.project?.number||''),'Project number');
    this.labelGroups=Object.fromEntries(['todo','inProgress','done'].map(group=>[group,this.input((selection.status?.labels?.[group]||[]).join('\n'),'One exact label per line',{rows:2,discovery:false})]));
    this.setProfile(model.connection,{existing:Boolean(model.connection)});this.mappingMode=selection.status?.project?'project':selection.status?.labels?'labels':'none';this.projectFieldId=selection.status?.project?.fieldId||null;this.projectOptions=copy(selection.status?.project?.options||{todo:[],inProgress:[],done:[]});
  }
  setProfile(connection,{existing=false}={}){
    this.initializingForm=true;const c=connection||{id:this.nextProfileId(),kind:'github',site:'https://github.com',credentialEnv:''};this.selectedProfile=existing?copy(c):null;this.authMode=c.gh?'gh':'environment';this.profileId.set_value(c.id);this.site.set_value(c.site);this.tokenEnv.set_value(c.credentialEnv||'');this.ghAccount.set_value(c.gh?.account||'');this.initializingForm=false;this.formEpoch++;this.data.cancelSetup();this.discovering=false;this.projectFields=null;this.projectFieldId=null;this.projectOptions={todo:[],inProgress:[],done:[]};this.error=null;
  }
  collectProfile(){
    if(this.selectedProfile)return copy(this.selectedProfile);const site=trackerOrigin(this.site.value().trim()),c={id:this.profileId.value().trim(),kind:'github',site,apiBase:githubApiBase(site)};
    if(this.authMode==='gh')c.gh={host:site.slice(8),account:this.ghAccount.value().trim()};else c.credentialEnv=this.tokenEnv.value().trim();return c;
  }
  collectSelection({mapping=true}={}){
    const selection={owner:this.owner.value().trim(),repo:this.repo.value().trim()};
    if(mapping&&this.mappingMode==='labels')selection.status={labels:Object.fromEntries(['todo','inProgress','done'].map(group=>[group,this.labelGroups[group].value().split(/\r?\n/).map(v=>v.trim()).filter(Boolean)]))};
    if(mapping&&this.mappingMode==='project')selection.status={project:{owner:this.projectOwner.value().trim(),number:Number(this.projectNumber.value()),fieldId:this.projectFieldId,options:copy(this.projectOptions),unmapped:'error'}};return selection;
  }
  mode(value,cx){this.mappingMode=value;this.formEpoch++;this.data.cancelSetup();this.discovering=false;this.error=null;cx.notify();}
  discoverFields(cx){
    if(this.discovering||!this.setupTarget)return;let connection,selection;try{connection=this.collectProfile();selection=this.collectSelection({mapping:false});}catch{this.error='Enter a valid GitHub site and repository.';cx.notify();return;}
    const epoch=this.formEpoch,target=copy(this.setupTarget),owner=this.projectOwner.value().trim(),number=Number(this.projectNumber.value());this.discovering=true;this.projectFields=null;this.error=null;cx.notify();
    return this.spawn(cx,async()=>{try{const probe=await this.data.discoverProjectFields({target,connection,selection,owner,number},{isCurrent:()=>!this.closed&&epoch===this.formEpoch});if(!this.closed&&epoch===this.formEpoch){this.projectFields=probe.fields;if(this.projectFieldId&&!probe.fields.some(f=>f.id===this.projectFieldId)){this.projectFieldId=null;this.projectOptions={todo:[],inProgress:[],done:[]};}}}finally{if(epoch===this.formEpoch)this.discovering=false;}});
  }
  chooseField(field,cx){if(this.projectFieldId!==field.id){this.projectFieldId=field.id;this.projectOptions={todo:[],inProgress:[],done:[]};}this.formEpoch++;this.data.cancelSetup();this.discovering=false;this.error=null;cx.notify();}
  chooseOption(id,group,cx){const selected=this.projectOptions[group].includes(id);for(const key of ['todo','inProgress','done'])this.projectOptions[key]=this.projectOptions[key].filter(v=>v!==id);if(!selected)this.projectOptions[group].push(id);this.formEpoch++;this.data.cancelSetup();this.discovering=false;this.error=null;cx.notify();}
  saveSetup(cx){
    if(this.saving||!this.setupTarget)return;let connection,selection;try{connection=this.collectProfile();selection=this.collectSelection();}catch{this.error='Check this GitHub profile and repository.';cx.notify();return;}
    const target=copy(this.setupTarget),epoch=this.formEpoch;this.saving=true;this.error=null;cx.notify();
    return this.spawn(cx,async()=>{try{const saved=await this.data.saveSetup({target,connection,selection},{isCurrent:()=>!this.closed&&epoch===this.formEpoch});if(!this.closed&&epoch===this.formEpoch){this.config=saved.config;this.saved=true;herdr.setShared(CONFIG_EVENT,{v:1,owner:this.instance,revision:++this.seq});if(!this.props.overlay)this.initializeForm();this.closeOverlay();}}catch(error){if(!this.closed&&epoch===this.formEpoch)this.error=error?.code?error.message:'The connection could not be saved. Existing settings were preserved.';}finally{this.saving=false;}});
  }
  closeOverlay(){if(this.props.overlay)herdr.closeOverlay(this.props.overlay);}
  header(title){
    const t=colors(),caption=this.all?String(Object.values(this.config?.bindings||{}).filter(b=>b.github).length)+' spaces':this.scopeSpace?.name||(this.resolved?.repoRoot||this.props.target?.repoRoot||'').split('/').filter(Boolean).at(-1);
    return h_flex().h(38).px(12).gap(8).items_center().border_b(1).border_color(t.border).child(icon(MOD,'github',16)).child(div().font_semibold().text_size(12).text_color(t.foreground).child(title))
      .when(['panel','pulls'].includes(this.role)&&Boolean(caption),el=>el.child(div().flex_1().min_w(0).truncate().text_size(10).text_color(t.dim).child(caption))).child(div().flex_1())
      .when(['panel','pulls'].includes(this.role),el=>el.child(iconButton(MOD,'github-shortcuts','pin','Agent shortcuts',(_e,cx)=>this.openShortcuts(cx))))
      .when(Boolean(this.props.overlay),el=>el.child(iconButton(MOD,'github-close','close','Close',()=>this.closeOverlay())));
  }
  field(id,title,state,{multiline=false,height=32}={}){const t=colors(),input=multiline?Textarea.new(state):Input.new(state);return v_flex().gap(5).child(label(title,{muted:true,size:11})).child(input.id(id).h(height).px(8).py(multiline?7:0).rounded(5).border(1).border_color(t.border).bg(t.chrome).text_color(t.foreground).text_size(12));}
  projectView(cx){
    const t=colors(),body=v_flex().gap(10).child(h_flex().gap(8).child(this.field('github-project-owner','Project owner',this.projectOwner).flex_1()).child(this.field('github-project-number','Project number',this.projectNumber).w(125)))
      .child(textButton('github-load-fields',this.discovering?'Loading fields…':'Load fields',(_e,eventCx)=>this.discoverFields(eventCx),{disabled:this.discovering}));
    if(!this.projectFields)return body.child(div().text_size(10).text_color(t.dim).child(this.projectFieldId?'Load fields to inspect the saved mapping.':'Load the project, then choose a single-select field.'));
    if(!this.projectFields.length)return body.child(label('No single-select fields are available for this project.',{muted:true,size:11}));
    body.child(v_flex().gap(5).child(label('Status field',{muted:true,size:11})).children(this.projectFields.map(field=>textButton('github-field-'+field.id,field.name,(_e,eventCx)=>this.chooseField(field,eventCx),{primary:this.projectFieldId===field.id}))));
    const field=this.projectFields.find(f=>f.id===this.projectFieldId);if(!field)return body;
    return body.child(label('Choose a workflow group for each source option.',{muted:true,size:10})).child(v_flex().gap(6).children(field.options.map(option=>v_flex().gap(4).p(8).rounded(5).bg(t.chrome).child(label(option.name,{size:11})).child(h_flex().gap(4).children([['todo','To do'],['inProgress','In progress'],['done','Done']].map(([group,title])=>textButton('github-option-'+option.id+'-'+group,title,(_e,eventCx)=>this.chooseOption(option.id,group,eventCx),{primary:this.projectOptions[group].includes(option.id)})))))));
  }
  setupView(cx){
    const t=colors(),root=v_flex().id('github-setup').size_full().min_h(0).bg(t.surface).text_size(12).child(this.header('GitHub connection'));
    if(this.setupLoading)return root.child(div().p(18).text_color(t.muted).child('Loading repository settings…'));
    if(!this.config)return root.child(div().p(18).text_color(t.blocked).child(this.error||'Repository settings are unavailable. The original file was preserved.'));
    if(!this.setupTarget)return root.child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().p(16).gap(8).child(label(this.setupError||'Choose a repository space.',{muted:true})).children((this.setupCandidates?.length?this.setupCandidates.map(c=>({space:this.setupSpace,pane:c.paneId,label:c.repoRoot})):herdr.spaces().map(space=>({space,label:space.name+' · '+(space.machine||'This Mac')}))).map(choice=>textButton('github-choose-'+(choice.pane||choice.space.id),choice.label,(_e,eventCx)=>this.chooseSetup(choice.space,eventCx,choice.pane)))));
    const profiles=Object.values(this.config.connections).filter(p=>p.kind==='github'),body=v_flex().flex_1().min_h(0).overflow_y_scrollbar().p(16).gap(13).child(label((this.setupTarget.machine||'This Mac')+' · '+this.setupTarget.repoRoot,{muted:true,size:11}))
      .when(Boolean(profiles.length),el=>el.child(v_flex().max_h(110).overflow_y_scrollbar().gap(4).children(profiles.map(p=>textButton('github-profile-'+p.id,p.id+' · '+p.site,(_e,eventCx)=>{this.setProfile(p,{existing:true});eventCx.notify();},{primary:this.selectedProfile?.id===p.id})))))
      .child(textButton('github-new-profile','New profile',(_e,eventCx)=>{this.setProfile(null);eventCx.notify();}));
    if(this.selectedProfile)body.child(v_flex().gap(5).p(10).rounded(5).border(1).border_color(t.border).child(label(this.selectedProfile.id,{size:12})).child(label(this.selectedProfile.site,{muted:true,size:11})).child(label(this.selectedProfile.gh?'gh account: '+this.selectedProfile.gh.account:'Environment: '+this.selectedProfile.credentialEnv,{muted:true,size:11})).child(div().text_size(10).text_color(t.dim).child('This reusable profile stays unchanged. Create a new profile to change its account.')));
    else body.child(this.field('github-profile-id','Profile ID',this.profileId)).child(this.field('github-site','GitHub site',this.site))
      .child(h_flex().gap(5).children([['environment','Environment variable'],['gh','gh account']].map(([value,title])=>textButton('github-auth-'+value,title,(_e,eventCx)=>{this.authMode=value;this.formEpoch++;this.data.cancelSetup();this.discovering=false;this.projectFields=null;this.projectFieldId=null;this.projectOptions={todo:[],inProgress:[],done:[]};eventCx.notify();},{primary:this.authMode===value}))))
      .child(this.authMode==='gh'?this.field('github-gh-account','Existing gh account',this.ghAccount):this.field('github-token-env','Token environment variable',this.tokenEnv))
      .child(div().text_size(10).text_color(t.dim).child(this.authMode==='gh'?'Uses this existing host and account without changing your gh login.':'Enter the environment variable name. The token stays in the local helper.'));
    body.child(h_flex().gap(8).child(this.field('github-owner','Repository owner',this.owner).flex_1()).child(this.field('github-repo','Repository',this.repo).flex_1()))
      .child(v_flex().gap(7).child(label('Issue workflow',{muted:true,size:11})).child(h_flex().gap(5).children([['none','Default'],['labels','Labels'],['project','Projects']].map(([value,title])=>textButton('github-mapping-'+value,title,(_e,eventCx)=>this.mode(value,eventCx),{primary:this.mappingMode===value})))));
    if(this.mappingMode==='none')body.child(div().text_size(11).text_color(t.muted).child('Open issues appear in To do; closed issues appear in Done. Add label or Projects mapping for In progress.'));
    else if(this.mappingMode==='labels')body.child(div().text_size(10).text_color(t.dim).child('One exact label per line. Closed issues are always Done.')).children([['todo','To do'],['inProgress','In progress'],['done','Done']].map(([group,title])=>this.field('github-labels-'+group,title,this.labelGroups[group],{multiline:true,height:62})));
    else body.child(this.projectView(cx));
    return root.child(body).when(Boolean(this.error),el=>el.child(div().id('github-setup-error').px(16).py(6).text_size(11).text_color(t.blocked).child(this.error)))
      .child(h_flex().p(12).gap(8).items_center().border_t(1).border_color(t.border).child(textButton('github-cancel-setup','Cancel',()=>this.closeOverlay())).child(div().flex_1()).child(textButton('github-save-setup',this.saving?'Checking…':this.saved?'Saved':'Save connection',(_e,eventCx)=>this.saveSetup(eventCx),{primary:true,disabled:this.saving||this.discovering})));
  }
  render(cx){
    if(this.dialog)return this.dialog.render(cx);if(this.role==='setup')return this.setupView(cx);this.refreshPreferences(cx);this.syncFromWorld(cx);const t=colors(),root=v_flex().id('github-panel').size_full().min_h(0).bg(t.surface);
    this.refreshSlots(cx);if(!this.props.hideHeader)root.child(this.header(this.role==='pulls'?'Pull requests':'GitHub'));
    if(this.error)root.child(div().id('github-action-error').px(12).py(7).text_size(11).text_color(t.blocked).child(this.error));
    if(this.info)root.child(div().id('github-action-info').px(12).py(6).text_size(11).text_color(t.muted).child(this.info));
    if(this.role==='pulls'){const props={id:'github-pulls',mod:MOD,state:this.board,view:this.data.view(),preferences:this.launchPreferences??this.config?.preferences.launch??this.emptyPreferences,slots:this.slots,revision:JSON.stringify([this.toolRevision,this.pullLifetimeRevision,herdr.machines().map(m=>[m.name,m.layout]),this.resolved?.state??null,[...this.launching]]),toolsForMachine:machine=>this.tools.get(machineKey(machine))||[],detailState:pull=>this.data.detailState(pull),slotFor:(_pull,_toolKey,validatedKey)=>this.slots.get(validatedKey),launchReason:pull=>this.pullReason(pull),onDetails:(pull,eventCx)=>this.loadPullDetails(pull,eventCx),onOpen:(pull,url,eventCx)=>this.openPullLink(pull,url,eventCx),onLaunch:(pull,action,key,eventCx)=>this.startPull(pull,action,key,eventCx),onOptions:(pull,action,eventCx)=>this.startPull(pull,action,undefined,eventCx,{options:true}),onRefresh:eventCx=>this.syncFromWorld(eventCx,{force:true}),onScopeChange:(all,eventCx)=>this.setScope(all,eventCx),onSetup:(binding,eventCx)=>this.openSetup(binding,eventCx),onLoadMore:eventCx=>this.spawn(eventCx,()=>this.data.refresh({loadMore:true}))};this.board.synchronize(props,cx,(ownerCx,work)=>this.spawn(ownerCx,work));return root.child(renderPullBoard(props,cx));}
    const bindings=this.data.view().bindings,hints=[...new Set(bindings.map(b=>b.progressHint).filter(Boolean))];
    if(hints.length)root.child(h_flex().id('github-progress-hint').px(12).py(5).gap(6).items_center().tooltip(hints.join('\n')).accessibility_label(hints.join('\n')).child(icon(MOD,'issue',12).text_color(t.dim)).child(div().flex_1().text_size(10).text_color(t.dim).child('In progress needs a status mapping.')).child(iconButton(MOD,'github-map-progress','settings','Configure status mapping',(_e,eventCx)=>this.openSetup(bindings.find(b=>b.progressHint)?.binding,eventCx),{size:24})));
    return root.child(renderIssueBoard({id:'github-board',mod:MOD,state:this.board,view:this.data.view(),preferences:this.launchPreferences??this.config?.preferences.launch??{},toolsForMachine:machine=>this.tools.get(machineKey(machine))||[],launchReason:issue=>this.launchReason(issue),onOpenIssue:(issue,eventCx)=>this.openIssue(issue,eventCx),onLaunch:(issue,key,eventCx)=>this.startIssue(issue,key,eventCx),onOptions:(issue,eventCx)=>this.startIssue(issue,undefined,eventCx,{options:true}),onRefresh:(_value,eventCx)=>this.syncFromWorld(eventCx,{force:true}),onSetup:(binding,eventCx)=>this.openSetup(binding,eventCx),onScopeChange:(all,eventCx)=>this.setScope(all,eventCx),onLoadMore:(_value,eventCx)=>this.spawn(eventCx,()=>this.data.refresh({loadMore:true})),onInvalid:(message,eventCx)=>{this.error=message;eventCx.notify();}},cx));
  }
  close(){if(this.closed)return;this.closed=true;this.contextEpoch++;this.formEpoch++;this.data?.close();this.board?.close();this.dialog?.close();this.dialogTask?.cancel?.();for(const timer of this.timers)timer?.cancel?.();for(const job of this.jobs)job?.cancel?.();this.commandTask?.cancel?.();for(const input of this.inputs)input.release();}
}
