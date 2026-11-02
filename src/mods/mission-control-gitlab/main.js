import {View,div} from 'gpui-kit';
import {v_flex,h_flex,InputState,Input,TextareaState,Textarea} from 'gpui-base';
import * as herdr from 'herdr';
import {readConfig,configPath,gitlabProjectPath} from '../../shared/config.js';
import {validateIssue,validateRepoBinding,trackerOrigin,issueIdentityKey} from '../../shared/tracker-model.js';
import {resolveSpaceRepo,launchTarget} from '../../shared/space-repo.js';
import {createLaunchIO,launch,validateLaunchRequest,verifyTabAcknowledgement} from '../../shared/launch.js';
import {LaunchDialog,openLaunchDialog,quickStart} from '../../shared/launch-dialog.js';
import {newIntent} from '../../shared/session-identity.js';
import {toolChoices,validateLaunchPreferences} from '../../shared/launch-preferences.js';
import {IssueBoardState,renderIssueBoard} from '../../shared/issue-board.js';
import {GitlabDataBridge,gitlabSetupModel} from './data.js';
import {validateMergeRequest,mergeIdentityKey,validateMRActionRequest,mrActionAvailability,mrReasonText,mrLaunchSource} from './merge-model.js';
import {MergeBoardState,renderMergeBoard,mergeSlotKey} from './merges-view.js';
import {colors,label,icon,iconButton,textButton} from '../../shared/ui.js';

const MOD='mission-control-gitlab',STATE='mission-control-gitlab-ui-v1',CONFIG_EVENT='mission-control-gitlab-config-v1',DATA_EVENT='mission-control-gitlab-data-v1';
const copy=value=>JSON.parse(JSON.stringify(value)),machineKey=machine=>JSON.stringify(machine);
const fail=(code,message)=>{throw Object.assign(Error(message),{code});};
const MERGE_STATE='mission-control-gitlab-mrs-ui-v1',SLOT_EVENT='mission-control-gitlab-launches-v1',PREFS_EVENT='mission-control-gitlab-prefs-v1';
const mergeActionTitle=action=>({review:'Review',addressComments:'Address comments',fixChecks:'Fix checks'})[action];
const UI_STATES=['all','todo','inProgress','done'];
function uiState(merges=false){const s=herdr.shared(merges?MERGE_STATE:STATE),states=merges?['all','open','draft','closed','merged','locked']:UI_STATES;return {all:s?.v===1&&s.all===true,query:typeof s?.query==='string'&&s.query.length<=512?s.query:'',status:states.includes(s?.status)?s.status:'all'};}
const sameRepo=(a,b)=>a?.machine===b?.machine&&a?.repoRoot===b?.repoRoot;

export function gitlabLaunchSource(value){const issue=validateIssue(value);if(issue.identity.kind!=='gitlab')fail('INVALID_SCOPE','Select a GitLab issue.');return {kind:'gitlab',connectionId:issue.identity.connectionId,site:issue.identity.site,id:issue.identity.id,key:issue.key,title:issue.title,url:issue.url,body:issue.body};}

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
export async function captureGitlabTarget(value,options={}){
  const issue=validateIssue(value),selected=await captureRepository(issue.repoBinding,options),target=launchTarget(selected);if(options.all)target.checkoutRoot=issue.repoBinding.repoRoot;
  return {issue,source:gitlabLaunchSource(issue),target};
}

/** Presentation hints only. The shared launcher alone verifies and mutates saved work. */
export async function readGitlabMergeSlots(io,spaces){
  const slots=new Map(),raw=await io.readTextFile(io.appHome().replace(/\/$/,'')+'/mission-control/launches.json');if(raw===null||typeof raw!=='string'||raw.length>180000)return slots;
  let journal;try{journal=JSON.parse(raw);}catch{return slots;}if(journal?.v!==1||!journal.requests||Array.isArray(journal.requests)||typeof journal.requests!=='object'||Object.keys(journal.requests).length>2000)return slots;
  for(const record of Object.values(journal.requests))try{
    const request=validateLaunchRequest(record.request),source=request.source;if(source?.kind!=='gitlab-mr'||!record.ack||!/^[1-9][0-9]{0,199}$/.test(source.id))continue;
    const ack=verifyTabAcknowledgement(record.ack,request),key=JSON.stringify([request.machine,request.repoRoot,source.kind,source.connectionId,source.site,source.id,request.toolKey]);if(slots.has(key))continue;
    const tab=spaces.find(s=>s.machine===request.machine&&s.id===ack.space)?.tabs.find(t=>t.id===ack.tab),present=tab&&(!tab.terminals||tab.terminals.some(t=>t.terminal===ack.terminal));slots.set(key,{state:present?'open':'closed',source:copy(source),ack:copy(ack)});
  }catch{/* A malformed hint can never authorize a launch or hide its journal error. */}
  return slots;
}

export default class MissionControlGitlab extends View{
  init(_props,cx){
    this.props=herdr.props()||{};this.role=this.props.view==='issues'?'panel':this.props.view||'panel';this.closed=false;this.jobs=[];this.timers=[];this.inputs=[];this.originPanes=new Map();this.tools=new Map();this.toolTimes=new Map();this.toolPending=new Set();this.launching=new Set();this.toolRevision=0;this.mergeLifetimeRevision=0;this.mergeIntents=new Map();this.slots=new Map();this.slotEpoch=0;this.emptyPreferences={};this.preferencesEpoch=0;this.lastPrefs=JSON.stringify(herdr.shared(PREFS_EVENT)||null);this.launchPreferences=null;this.info=null;this.contextEpoch=0;this.formEpoch=0;this.seq=0;this.error=null;this.instance=Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8);this.io=createLaunchIO(herdr);
    if(['launch','settings','menu'].includes(this.role)){
      const dialogApi={...herdr,writeTextFile:async(file,text,expected)=>{const result=await herdr.writeTextFile(file,text,expected);if(file===configPath(this.io))herdr.setShared(PREFS_EVENT,{v:1,owner:this.instance,revision:++this.seq});if(file===this.io.appHome().replace(/\/$/,'')+'/mission-control/launches.json')herdr.setShared(SLOT_EVENT,{v:1,owner:this.instance,revision:++this.seq});return result;}};
      this.dialog=new LaunchDialog(MOD,this.props,dialogApi);
      // The own-mod MR dialog keeps the click's intent through tool loading and retries.
      if(this.props.mergeAction){const request=validateMRActionRequest(this.props.mergeAction);this.dialog.intent=newIntent({requestId:request.requestId,originId:this.props.mergeOriginId});}
      this.dialogTask=this.dialog.init(cx);return;
    }
    this.data=new GitlabDataBridge(this.io,{view:this.role==='merges'?'merges':'issues',onChange:()=>{if(!this.closed)herdr.setShared(DATA_EVENT,{owner:this.instance,revision:++this.seq});}});
    if(this.role==='setup'){
      this.setupLoading=true;this.capturedWorld=this.world();this.spawn(cx,async()=>{try{this.config=(await readConfig(this.io)).value;if(this.closed)return;if(this.props.target)this.setupTarget=validateRepoBinding({machine:this.props.target.machine,repoRoot:this.props.target.repoRoot});else await this.resolveSetup(this.capturedWorld.space,this.capturedWorld.panes);if(!this.closed&&this.setupTarget)this.initializeForm();}finally{this.setupLoading=false;}});return;
    }
    const saved=uiState(this.role==='merges');this.all=this.props.scope==='all'||this.props.scope!=='space'&&saved.all;
    this.board=new (this.role==='merges'?MergeBoardState:IssueBoardState)({query:saved.query,status:saved.status,onChange:()=>this.saveUI()});this.lastConfig=JSON.stringify(herdr.shared(CONFIG_EVENT)||null);this.contextKey=null;
    this.syncFromWorld(cx,{force:true});this.timers.push(cx.timer.every(60000,eventCx=>this.syncFromWorld(eventCx,{force:true})));
    // A load the host ended mid-flight is retried here instead of showing Loading for ever.
    this.timers.push(cx.timer.every(5000,eventCx=>{if(!this.closed&&this.data.hasAbandonedLoad())this.spawn(eventCx,()=>this.data.recoverAbandoned());}));
    this.commandTask=cx.spawn(async(eventCx)=>{while(!this.closed){const command=await herdr.nextCommand();if(this.closed)return;if(command==='refresh')this.syncFromWorld(eventCx,{force:true});else if(command==='setup')this.openSetup(undefined,eventCx);else if(command==='all-spaces')this.setScope(true,eventCx);else if(command==='this-space')this.setScope(false,eventCx);eventCx.notify();}});
  }
  spawn(cx,work){
    this.jobs=this.jobs.filter(job=>!job?.is_done?.());const job=cx.spawn(async(eventCx)=>{try{await work(eventCx);}catch(error){if(!this.closed&&error?.code!=='REQUEST_CANCELLED')this.error=error?.code?error.message:'GitLab could not complete this action. Check the selected connection and retry.';}if(!this.closed)eventCx.notify();});this.jobs.push(job);return job;
  }
  world(){
    const spaces=herdr.spaces(),focused=herdr.focused(),panes=herdr.panes().map(p=>({...p,focused:p.focused||p.pane===focused?.pane}));
    for(const space of spaces){const pane=panes.find(p=>p.terminal&&p.focused&&space.tabs.some(t=>t.id===p.tab));if(pane)this.originPanes.set(space.id,pane.pane);}
    const wanted=this.props.target?.spaceId||this.props.spaceId||focused?.space,expected=this.props.target&&Object.hasOwn(this.props.target,'machine')?this.props.target.machine:Object.hasOwn(this.props,'machine')?this.props.machine:undefined,space=spaces.find(s=>s.id===wanted&&(expected===undefined||s.machine===expected));
    return {spaces:copy(spaces),space:space?copy(space):null,panes};
  }
  saveUI(){if(this.board)herdr.setShared(this.role==='merges'?MERGE_STATE:STATE,{v:1,all:this.all,...this.board.filters()});}
  refreshSlots(cx,{force=false}={}){
    if(this.role!=='merges'||this.closed)return;const spaces=copy(herdr.spaces()),key=JSON.stringify([herdr.shared(SLOT_EVENT)||null,spaces.map(s=>[s.id,s.machine,s.tabs.map(t=>[t.id,t.terminals?.map(p=>p.terminal)])])]);if(!force&&key===this.slotContext)return;this.slotContext=key;const epoch=++this.slotEpoch;
    return this.spawn(cx,async()=>{const slots=await readGitlabMergeSlots(this.io,spaces);if(!this.closed&&epoch===this.slotEpoch)this.slots=slots;});
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
    if(this.closed||!['panel','merges'].includes(this.role))return;const captured=this.world(),revision=JSON.stringify(herdr.shared(CONFIG_EVENT)||null),space=captured.space,origin=space?this.originPanes.get(space.id):null;
    const eligible=captured.panes.filter(p=>space?.tabs.some(t=>t.id===p.tab)),bound=this.props.target?.repoRoot&&!this.props.target.spaceId,key=this.all?'all':bound?JSON.stringify(['bound',this.props.target.machine,this.props.target.repoRoot,captured.panes.map(p=>[p.pane,p.terminal,p.cwd])]):JSON.stringify([space?.id??null,space?.machine??null,origin??null,eligible.map(p=>[p.pane,p.terminal,p.cwd])]);
    const changed=key!==this.contextKey||revision!==this.lastConfig;if(!force&&!changed)return;
    this.contextKey=key;this.lastConfig=revision;const epoch=++this.contextEpoch,preferencesEpoch=this.preferencesEpoch;if(changed){this.resolved=null;this.data.clearSelection();}if(force){this.error=null;this.info=null;}this.refreshSlots(cx,{force:true});
    return this.spawn(cx,async(eventCx)=>{
      let resolved=null;
      if(!this.all&&this.props.target?.repoRoot&&!this.props.target.spaceId){
        const binding=validateRepoBinding({machine:this.props.target.machine,repoRoot:this.props.target.repoRoot});
        try{resolved=await captureRepository(binding,{all:true,isCurrent:()=>!this.closed&&epoch===this.contextEpoch});}catch(error){if(error.code==='REQUEST_CANCELLED')throw error;resolved={machine:binding.machine,repoRoot:binding.repoRoot};}
      }else if(!this.all&&space){
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
    let issue;try{issue=validateIssue(value);gitlabLaunchSource(issue);}catch{this.error='This issue is unavailable. Refresh its connection.';cx.notify();return;}
    const key=issueIdentityKey(issue);if(this.launching.has(key))return;this.launching.add(key);this.error=null;const all=this.all,resolved=this.resolved?copy(this.resolved):null,originPane=resolved?this.originPanes.get(resolved.spaceId):null;cx.notify();
    return this.spawn(cx,async()=>{
      try{const captured=await captureGitlabTarget(issue,{all,resolved,originPane,isCurrent:()=>!this.closed});if(this.closed)return;
        if(options)openLaunchDialog(MOD,herdr,{view:'launch',target:captured.target,...captured.target,source:captured.source,...(toolKey?{toolKey}:{})});
        else{const result=await quickStart({target:captured.target,source:captured.source,toolKey},this.io);if(!result.ok)this.error=result.message;}
      }finally{this.launching.delete(key);}
    });
  }
  mergeReason(merge){
    if(this.launching.has(mergeIdentityKey(merge)))return 'Opening this merge request’s agent…';if(!this.all&&this.props.target?.repoRoot&&this.resolved?.state!=='resolved')return 'Open this repository in a space to start work.';return herdr.machines().find(m=>m.name===merge.repoBinding.machine)?.layout==='ready'?'':'The execution machine is offline or still connecting.';
  }
  loadMergeDetails(merge,cx){return this.spawn(cx,()=>this.data.loadMergeDetails(validateMergeRequest(merge)));}
  startMerge(value,action,toolKey,cx,{options=false}={}){
    let request,origin,intent;
    const all=this.all,resolved=this.resolved?copy(this.resolved):null,originPane=resolved?this.originPanes.get(resolved.spaceId):null;
    try{
      const merge=validateMergeRequest(value),key=mergeIdentityKey(merge);if(this.launching.has(key))return;
      const binding=this.data.view().bindings.find(b=>sameRepo(b.binding,merge.repoBinding));if(!binding)fail('REQUEST_CANCELLED','This merge request’s repository changed.');
      const checkoutRoot=binding.checkoutRoot,intentKey=JSON.stringify([key,action,toolKey||'options',checkoutRoot,merge.head.sha,merge.base.sha]);
      intent=this.mergeIntents.get(intentKey);if(!intent){if(this.mergeIntents.size>=1000)fail('LAUNCH_CAPACITY','Reopen this panel before starting more work.');intent=newIntent();this.mergeIntents.set(intentKey,intent);}
      // Capture every action field before spawning, resolving Git, opening a
      // dialog or asking the provider for details. Never borrow later focus.
      request=validateMRActionRequest({v:1,action,merge,checkoutRoot,toolKey:toolKey||'options',requestId:intent.requestId});
      if(request.merge.state==='locked')fail('MR_ACTION_UNAVAILABLE',mrReasonText('MR_LOCKED'));
      origin=this.data.acquireMergeOrigin(request.merge);
    }catch(error){this.error=error?.code?error.message:'This merge request changed. Refresh its repository.';cx.notify();return;}
    const key=mergeIdentityKey(request.merge);this.launching.add(key);this.mergeLifetimeRevision++;const held=this.board.retain(key);this.error=null;this.info=null;
    const current=()=>!this.closed&&this.data.mergeOriginCurrent(origin);herdr.setShared(DATA_EVENT,{owner:this.instance,revision:++this.seq});cx.notify();
    const job=this.spawn(cx,async()=>{
      try{
        const selected=await captureRepository(request.merge.repoBinding,{all,resolved,originPane,isCurrent:current}),target=launchTarget(selected);
        if(!all&&target.checkoutRoot!==request.checkoutRoot)fail('REQUEST_CANCELLED','The captured checkout changed. Refresh and retry.');target.checkoutRoot=request.checkoutRoot;
        const slots=await readGitlabMergeSlots(this.io,copy(herdr.spaces()));if(!current())fail('REQUEST_CANCELLED','This merge request’s source changed.');this.slots=slots;
        const previous=toolKey?slots.get(mergeSlotKey(request.merge,toolKey)):null;let source;
        if(previous&&!options)source=previous.source;
        else{
          const detailed=await this.data.loadMergeDetails(request.merge,{origin});if(!current()||!this.data.detailCurrent(request.merge,{origin}))fail('REQUEST_CANCELLED','This merge request changed while loading details. Refresh and retry.');request=validateMRActionRequest({...request,merge:detailed});
          const available=mrActionAvailability(request.merge,request.action);if(!available.enabled)fail('MR_ACTION_UNAVAILABLE',mrReasonText(available.reason));source=mrLaunchSource(request);
        }
        if(!current())fail('REQUEST_CANCELLED','This merge request’s source changed.');await this.data.validateMergeOrigin(origin);
        if(options)herdr.openOverlay({mod:MOD,kind:'dialog',width:560,height:660,props:{view:'launch',target,source,mergeAction:request,mergeOriginId:intent.originId,...(toolKey?{toolKey}:{})}});
        else{
          const config=(await readConfig(this.io)).value,p=validateLaunchPreferences(config.preferences.launch),tools=await this.io.knownAgents({on:target.machine});
          if(!toolChoices(tools,p).quick.some(tool=>tool.key===request.toolKey))fail('SHORTCUT_UNAVAILABLE','This shortcut is no longer pinned and installed on the destination machine.');
          if(!current())fail('REQUEST_CANCELLED','This merge request’s source changed.');await this.data.validateMergeOrigin(origin);
          const result=await launch({...intent,...target,source,toolKey:request.toolKey,worktree:p.worktree,...(p.tools[request.toolKey]||{})},this.io);
          if(!result.ok)this.error=result.message;else this.info=result.reused?'Opened existing agent. No new task was sent.':mergeActionTitle(request.action)+' started.';
          herdr.setShared(SLOT_EVENT,{v:1,owner:this.instance,revision:++this.seq});
        }
      }catch(error){if(!this.closed&&error?.code==='REQUEST_CANCELLED')this.error=error.message;throw error;}
      finally{this.data.releaseMergeOrigin(origin);this.launching.delete(key);this.board.unretain(key);this.mergeLifetimeRevision++;if(!this.closed)herdr.setShared(DATA_EVENT,{owner:this.instance,revision:++this.seq});}
    });held.task=job;return job;
  }
  openMergeLink(value,url,cx){
    let merge;try{merge=validateMergeRequest(value);if(url!==merge.url&&!merge.linkedIssues.some(i=>i.url===url))fail('INVALID_MR','This link is unavailable.');}catch{this.error='This merge request link is unavailable. Refresh its connection.';cx.notify();return;}
    return this.spawn(cx,async()=>{const platform=herdr.window().platform,command=platform==='macos'?'open':platform==='windows'?'explorer.exe':'xdg-open',result=await herdr.exec(command,[url]);if(result.code!==0)fail('OPEN_FAILED','The browser could not open this link.');});
  }
  openIssue(value,cx){let issue;try{issue=validateIssue(value);gitlabLaunchSource(issue);}catch{this.error='This issue link is unavailable. Refresh its connection.';cx.notify();return;}
    return this.spawn(cx,async()=>{const platform=herdr.window().platform,command=platform==='macos'?'open':platform==='windows'?'explorer.exe':'xdg-open',result=await herdr.exec(command,[issue.url]);if(result.code!==0)fail('OPEN_FAILED','The browser could not open this issue.');});
  }
  openSetup(binding,cx){
    if(binding||this.props.target?.repoRoot||!this.all&&this.resolved?.state==='resolved'){
      const target=binding||this.props.target||this.resolved;return herdr.openOverlay({mod:MOD,kind:'dialog',width:680,height:760,props:{view:'setup',target:{machine:target.machine,repoRoot:target.repoRoot}}});
    }
    const captured=this.world();return herdr.openOverlay({mod:MOD,kind:'dialog',width:680,height:760,props:{view:'setup',...(captured.space?{spaceId:captured.space.id,machine:captured.space.machine}:{})}});
  }
  openShortcuts(cx){
    const captured=this.world();return this.spawn(cx,async()=>{if(!captured.space)fail('SPACE_UNAVAILABLE','Select a repository space first.');const origin=this.originPanes.get(captured.space.id),panes=origin?captured.panes.filter(p=>p.pane===origin):captured.panes,resolved=await resolveSpaceRepo(captured.space,panes,herdr.exec);if(resolved.state!=='resolved')fail('REPO_UNAVAILABLE',resolved.reason);const target=launchTarget(resolved);if(!this.closed)openLaunchDialog(MOD,herdr,{view:'settings',target,...target});});
  }
  async resolveSetup(space,panes){
    this.setupSpace=space;this.setupPanes=panes;if(!space){this.setupError='Choose a repository space.';return;}
    const origin=this.originPanes.get(space.id),chosen=origin?panes.filter(p=>p.pane===origin):panes,result=await resolveSpaceRepo(space,chosen,herdr.exec);if(this.closed)return;
    if(result.state==='resolved'){this.setupTarget={machine:result.machine,repoRoot:result.repoRoot};this.setupError=null;this.setupCandidates=[];}
    else{this.setupTarget=null;this.setupError=result.reason;this.setupCandidates=result.state==='ambiguous'?result.candidates.filter(c=>c.repoRoot):[];}
  }
  chooseSetup(space,cx,paneId){if(this.setupLoading)return;this.setupLoading=true;this.error=null;const panes=herdr.panes().map(p=>({...p}));return this.spawn(cx,async()=>{try{await this.resolveSetup(space,paneId?panes.filter(p=>p.pane===paneId):panes);if(!this.closed&&this.setupTarget)this.initializeForm();}finally{this.setupLoading=false;}});}
  input(value,placeholder,{rows}={}){const state=rows?TextareaState.new({value,placeholder,rows}):InputState.new({value,placeholder});state.on('change',(_e,cx)=>{if(!this.initializingForm){this.formEpoch++;this.data.cancelSetup();this.error=null;this.saved=false;}cx.notify();});this.inputs.push(state);return state;}
  nextProfileId(){let id='gitlab-work',n=2;while(this.config.connections[id])id='gitlab-work-'+n++;return id;}
  initializeForm(){
    for(const input of this.inputs)input.release();this.inputs=[];const model=gitlabSetupModel(this.config,{state:'resolved',...this.setupTarget});this.setupProfiles=model.profiles;
    this.project=this.input(model.selection.projectPath||'','group/subgroup/project');this.hasMapping=Boolean(model.selection.status);
    this.labels=Object.fromEntries(['todo','inProgress','done'].map(group=>[group,this.input((model.selection.status?.labels[group]||[]).join('\n'),'One label per line',{rows:2})]));
    this.profileId=this.input('','Profile ID');this.site=this.input('','https://gitlab.com');this.tokenEnv=this.input('','WORK_GITLAB_TOKEN');this.setProfile(model.connection,{existing:Boolean(model.connection)});
  }
  setProfile(connection,{existing=false}={}){
    this.initializingForm=true;const c=connection||{id:this.nextProfileId(),kind:'api',site:'https://gitlab.com',auth:{kind:'bearer',tokenEnv:''}};this.selectedProfile=existing?copy(c):null;
    this.profileId.set_value(c.id);this.site.set_value(c.site);this.tokenEnv.set_value(c.auth.tokenEnv);this.initializingForm=false;this.formEpoch++;this.data.cancelSetup();this.error=null;this.saved=false;
  }
  collectProfile(){return this.selectedProfile?copy(this.selectedProfile):{id:this.profileId.value().trim(),kind:'api',site:trackerOrigin(this.site.value().trim()),auth:{kind:'bearer',tokenEnv:this.tokenEnv.value().trim()}};}
  collectSelection(){
    const projectPath=gitlabProjectPath(this.project.value().trim()),labels=Object.fromEntries(['todo','inProgress','done'].map(group=>[group,this.labels[group].value().split(/\r?\n/).filter(value=>value.trim())]));
    return {projectPath,...(this.hasMapping||Object.values(labels).some(values=>values.length)?{status:{labels}}:{})};
  }
  checkProject(cx){
    if(this.discovering||this.saving||!this.setupTarget)return;let connection,selection;try{connection=this.collectProfile();selection=this.collectSelection();}catch{this.error='Enter a valid GitLab site, credential variable and project path.';cx.notify();return;}
    const target=copy(this.setupTarget),epoch=this.formEpoch;this.discovering=true;this.error=null;cx.notify();
    return this.spawn(cx,async()=>{try{await this.data.discoverProject({target,connection,selection},{isCurrent:()=>!this.closed&&epoch===this.formEpoch});}catch(error){if(!this.closed&&epoch===this.formEpoch&&error.code!=='REQUEST_CANCELLED')this.error=error.message;}finally{this.discovering=false;}});
  }
  saveSetup(cx){
    if(this.saving||!this.setupTarget)return;let connection,selection;try{connection=this.collectProfile();selection=this.collectSelection();}catch{this.error='Check this GitLab profile, project path and workflow labels.';cx.notify();return;}
    const target=copy(this.setupTarget),epoch=this.formEpoch;this.saving=true;this.error=null;cx.notify();
    return this.spawn(cx,async()=>{try{const saved=await this.data.saveSetup({target,connection,selection},{isCurrent:()=>!this.closed&&epoch===this.formEpoch});if(!this.closed&&epoch===this.formEpoch){this.config=saved.config;herdr.setShared(CONFIG_EVENT,{v:1,owner:this.instance,revision:++this.seq});if(!this.props.overlay)this.setProfile(saved.config.connections[connection.id],{existing:true});this.saved=true;this.closeOverlay();}}catch(error){if(!this.closed&&epoch===this.formEpoch&&error.code!=='REQUEST_CANCELLED')this.error=error?.code?error.message:'The connection could not be saved. Existing settings were preserved.';}finally{this.saving=false;}});
  }
  closeOverlay(){if(this.props.overlay)herdr.closeOverlay(this.props.overlay);}
  header(title){const t=colors(),caption=this.all?String(Object.values(this.config?.bindings||{}).filter(b=>b.gitlab).length)+' spaces':this.scopeSpace?.name||(this.resolved?.repoRoot||this.props.target?.repoRoot||'').split('/').filter(Boolean).at(-1);return h_flex().h(38).px(12).gap(8).items_center().border_b(1).border_color(t.border).child(icon(MOD,'gitlab',16)).child(div().font_semibold().text_size(12).text_color(t.foreground).child(title))
    .when(['panel','merges'].includes(this.role)&&Boolean(caption),row=>row.child(div().flex_1().min_w(0).truncate().text_size(10).text_color(t.dim).child(caption))).child(div().flex_1())
    .when(['panel','merges'].includes(this.role),row=>row.child(iconButton(MOD,'gitlab-shortcuts','pin','Agent shortcuts',(_e,cx)=>this.openShortcuts(cx))))
    .when(Boolean(this.props.overlay),row=>row.child(iconButton(MOD,'gitlab-close','close','Close',()=>this.closeOverlay())));}
  field(id,title,state,{multiline=false,height=32}={}){const t=colors(),input=multiline?Textarea.new(state):Input.new(state);return v_flex().gap(5).child(label(title,{muted:true,size:11})).child(input.id(id).h(height).px(8).py(multiline?7:0).rounded(5).border(1).border_color(t.border).bg(t.chrome).text_color(t.foreground).text_size(multiline?11:12).when(multiline,el=>el.font_family('Geist Mono')));}
  setupView(cx){
    const t=colors(),root=v_flex().id('gitlab-setup').size_full().min_h(0).bg(t.surface).text_size(12).child(this.header('GitLab connection'));
    if(this.setupLoading)return root.child(div().p(18).text_color(t.muted).child('Loading repository settings…'));
    if(!this.config)return root.child(div().p(18).text_color(t.blocked).child(this.error||'Repository settings are unavailable. The original file was preserved.'));
    if(!this.setupTarget)return root.child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().p(16).gap(8).child(label(this.setupError||'Choose a repository space.',{muted:true})).children((this.setupCandidates?.length?this.setupCandidates.map(c=>({space:this.setupSpace,pane:c.paneId,label:c.repoRoot})):herdr.spaces().map(space=>({space,label:space.name+' · '+(space.machine||'This Mac')}))).map(choice=>textButton('gitlab-choose-'+(choice.pane||choice.space.id),choice.label,(_e,eventCx)=>this.chooseSetup(choice.space,eventCx,choice.pane)))));
    const body=v_flex().flex_1().min_h(0).overflow_y_scrollbar().p(16).gap(13).child(label((this.setupTarget.machine||'This Mac')+' · '+this.setupTarget.repoRoot,{muted:true,size:11}))
      .when(Boolean(this.setupProfiles?.length),el=>el.child(v_flex().max_h(112).overflow_y_scrollbar().gap(4).children(this.setupProfiles.map(profile=>textButton('gitlab-profile-'+profile.id,profile.id+' · '+profile.site,(_e,eventCx)=>{this.setProfile(this.config.connections[profile.id],{existing:true});eventCx.notify();},{primary:this.selectedProfile?.id===profile.id})))))
      .child(h_flex().gap(6).child(textButton('gitlab-new-profile','New profile',(_e,eventCx)=>{this.setProfile(null);eventCx.notify();},{primary:!this.selectedProfile}))
        .when(Boolean(this.selectedProfile),el=>el.child(textButton('gitlab-duplicate-profile','Duplicate profile',(_e,eventCx)=>{this.setProfile({...copy(this.selectedProfile),id:this.nextProfileId()});eventCx.notify();}))))
      .child(this.field('gitlab-project','Project path',this.project));
    if(this.selectedProfile)body.child(v_flex().gap(6).p(10).rounded(5).border(1).border_color(t.border).child(label(this.selectedProfile.id)).child(label(this.selectedProfile.site,{muted:true,size:11})).child(div().text_color(t.dim).text_size(11).child('This profile is shared. Duplicate it to change its connection.')));
    else body.child(this.field('gitlab-profile-id','Profile ID',this.profileId)).child(this.field('gitlab-site','GitLab site',this.site)).child(this.field('gitlab-token-env','Token environment variable',this.tokenEnv)).child(div().text_size(10).text_color(t.dim).child('Variable name only. Credentials stay in the local helper.'));
    body.child(div().h(1).bg(t.border)).child(label('Workflow labels',{size:12})).child(div().text_size(10).text_color(t.dim).child('One label per line. Open issues default to To do; closed issues are Done.'));
    for(const [group,title]of [['todo','To do'],['inProgress','In progress'],['done','Done']])body.child(this.field('gitlab-labels-'+group,title,this.labels[group],{multiline:true,height:54}));
    const discovery=this.data.view().discovery;
    if(discovery?.probe){const probe=discovery.probe;body.child(v_flex().id('gitlab-project-result').gap(6).p(10).rounded(5).border(1).border_color(t.border).child(label(probe.canonical?'Project verified': 'Canonical project path',{size:11})).child(label(probe.projectPath,{muted:true,size:11})).when(!probe.canonical,el=>el.child(textButton('gitlab-use-canonical','Use this project path',(_e,eventCx)=>{this.project.set_value(probe.projectPath);this.formEpoch++;this.data.cancelSetup();this.error=null;eventCx.notify();}))));}
    return root.child(body).when(Boolean(this.error),el=>el.child(div().px(16).py(6).text_size(11).text_color(t.blocked).child(this.error)))
      .child(h_flex().p(12).gap(8).items_center().border_t(1).border_color(t.border).child(textButton('gitlab-cancel-setup','Cancel',()=>this.closeOverlay())).child(div().flex_1())
        .child(textButton('gitlab-check-project',this.discovering?'Checking…':'Check project',(_e,eventCx)=>this.checkProject(eventCx),{disabled:this.discovering||this.saving}))
        .child(textButton('gitlab-save-setup',this.saving?'Checking…':this.saved?'Saved':'Save connection',(_e,eventCx)=>this.saveSetup(eventCx),{primary:true,disabled:this.saving||this.discovering})));
  }
  render(cx){
    if(this.dialog)return this.dialog.render(cx);if(this.role==='setup')return this.setupView(cx);this.refreshPreferences(cx);this.syncFromWorld(cx);
    const t=colors(),root=v_flex().id('gitlab-panel').relative().size_full().min_h(0).bg(t.surface);
    this.refreshSlots(cx);if(!this.props.hideHeader)root.child(this.header(this.role==='merges'?'Merge requests':'GitLab'));
    const finish=body=>{
      root.child(body);const message=this.error||this.info;
      // Reuse the existing footer area. Feedback must never move the search
      // field, filters or a shortcut while a native click is in flight.
      if(message)root.child(h_flex().id(this.error?'gitlab-action-error':'gitlab-action-info').absolute().bottom(6).left(12).right(12).h(22).gap(6).items_center().bg(t.surface)
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(this.error?t.blocked:t.muted).tooltip(message).accessibility_label(message).child(message))
        .child(iconButton(MOD,'gitlab-dismiss-action','close','Dismiss status',(_e,eventCx)=>{this.error=null;this.info=null;eventCx.notify();},{size:22})));
      return root;
    };
    if(this.role==='merges'){
      const props={id:'gitlab-merges',mod:MOD,state:this.board,view:this.data.view(),preferences:this.launchPreferences??this.config?.preferences.launch??this.emptyPreferences,slots:this.slots,revision:JSON.stringify([this.toolRevision,this.mergeLifetimeRevision,herdr.machines().map(m=>[m.name,m.layout]),this.resolved?.state??null,[...this.launching]]),toolsForMachine:machine=>this.tools.get(machineKey(machine))||[],detailState:merge=>this.data.detailState(merge),slotFor:(_merge,_toolKey,key)=>this.slots.get(key),launchReason:merge=>this.mergeReason(merge),onDetails:(merge,eventCx)=>this.loadMergeDetails(merge,eventCx),onOpen:(merge,url,eventCx)=>this.openMergeLink(merge,url,eventCx),onLaunch:(merge,action,key,eventCx)=>this.startMerge(merge,action,key,eventCx),onOptions:(merge,action,eventCx)=>this.startMerge(merge,action,undefined,eventCx,{options:true}),onRefresh:eventCx=>this.syncFromWorld(eventCx,{force:true}),onScopeChange:(all,eventCx)=>this.setScope(all,eventCx),onSetup:(binding,eventCx)=>this.openSetup(binding,eventCx),onLoadMore:eventCx=>this.spawn(eventCx,()=>this.data.refresh({loadMore:true}))};
      this.board.synchronize(props,cx,(ownerCx,work)=>this.spawn(ownerCx,work));return finish(renderMergeBoard(props,cx));
    }
    return finish(renderIssueBoard({id:'gitlab-board',mod:MOD,state:this.board,view:this.data.view(),preferences:this.launchPreferences??this.config?.preferences.launch??{},toolsForMachine:machine=>this.tools.get(machineKey(machine))||[],launchReason:issue=>this.launchReason(issue),onOpenIssue:(issue,eventCx)=>this.openIssue(issue,eventCx),onLaunch:(issue,key,eventCx)=>this.startIssue(issue,key,eventCx),onOptions:(issue,eventCx)=>this.startIssue(issue,undefined,eventCx,{options:true}),onRefresh:(_value,eventCx)=>this.syncFromWorld(eventCx,{force:true}),onSetup:(binding,eventCx)=>this.openSetup(binding,eventCx),onScopeChange:(all,eventCx)=>this.setScope(all,eventCx),onLoadMore:(_value,eventCx)=>this.spawn(eventCx,()=>this.data.refresh({loadMore:true})),onInvalid:(message,eventCx)=>{this.error=message;eventCx.notify();}},cx));
  }
  close(){if(this.closed)return;this.closed=true;this.contextEpoch++;this.formEpoch++;this.preferencesEpoch++;this.slotEpoch++;this.mergeIntents.clear();this.data?.close();this.board?.close();this.dialog?.close();this.dialogTask?.cancel?.();for(const timer of this.timers)timer?.cancel?.();for(const job of this.jobs)job?.cancel?.();this.commandTask?.cancel?.();for(const input of this.inputs)input.release();}
}
