import {View,div} from 'gpui-kit';
import {v_flex,h_flex,InputState,Input,TextareaState,Textarea} from 'gpui-base';
import * as herdr from 'herdr';
import {readConfig,bindingKey} from '../../shared/config.js';
import {validateIssue,validateRepoBinding,trackerOrigin,issueIdentityKey} from '../../shared/tracker-model.js';
import {resolveSpaceRepo,launchTarget} from '../../shared/space-repo.js';
import {createLaunchIO} from '../../shared/launch.js';
import {LaunchDialog,openLaunchDialog,quickStart} from '../../shared/launch-dialog.js';
import {IssueBoardState,renderIssueBoard} from '../../shared/issue-board.js';
import {JiraDataBridge,jiraSetupModel,jiraRouteDescription} from './data.js';
import {colors,label,icon,iconButton,textButton} from '../../shared/ui.js';

const MOD='mission-control-jira',STATE='mission-control-jira-ui-v1',CONFIG_EVENT='mission-control-jira-config-v1',DATA_EVENT='mission-control-jira-data-v1';
const copy=value=>JSON.parse(JSON.stringify(value)),machineKey=machine=>JSON.stringify(machine);
const fail=(code,message)=>{throw Object.assign(Error(message),{code});};
const UI_STATES=['all','todo','inProgress','done'];
function uiState(){const s=herdr.shared(STATE);return {all:s?.v===1&&s.all===true,query:typeof s?.query==='string'&&s.query.length<=512?s.query:'',status:UI_STATES.includes(s?.status)?s.status:'all'};}
const defaultMapping=()=>({issuesPath:'issues',nextCursorPath:'nextCursor',fields:{id:'id',key:'key',title:'title',status:'status',body:'body'},statusGroups:{todo:[],inProgress:[],done:[]}});
const defaultSearch=()=>({tool:'',argsTemplate:{jql:'{{jql}}',maxResults:'{{pageSize}}',nextPageToken:'{{cursor}}'},resultMapping:defaultMapping()});
const sameRepo=(a,b)=>a?.machine===b?.machine&&a?.repoRoot===b?.repoRoot;

export function jiraLaunchSource(value){const issue=validateIssue(value);if(issue.identity.kind!=='jira')fail('INVALID_SCOPE','Select a Jira issue.');return {kind:'jira',connectionId:issue.identity.connectionId,site:issue.identity.site,id:issue.identity.id,key:issue.key,title:issue.title,url:issue.url,body:issue.body};}

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
export async function captureJiraTarget(value,options={}){
  const issue=validateIssue(value),selected=await captureRepository(issue.repoBinding,options),target=launchTarget(selected);if(options.all)target.checkoutRoot=issue.repoBinding.repoRoot;
  return {issue,source:jiraLaunchSource(issue),target};
}

export default class MissionControlJira extends View{
  init(_props,cx){
    this.props=herdr.props()||{};this.role=this.props.view||'panel';this.closed=false;this.jobs=[];this.timers=[];this.inputs=[];this.originPanes=new Map();this.tools=new Map();this.toolTimes=new Map();this.toolPending=new Set();this.launching=new Set();this.contextEpoch=0;this.formEpoch=0;this.seq=0;this.error=null;this.instance=Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8);this.io=createLaunchIO(herdr);
    if(['launch','settings','menu'].includes(this.role)){this.dialog=new LaunchDialog(MOD,this.props,herdr);this.dialog.init(cx);return;}
    this.data=new JiraDataBridge(this.io,{onChange:()=>{if(!this.closed)herdr.setShared(DATA_EVENT,{owner:this.instance,revision:++this.seq});}});
    if(this.role==='setup'){
      this.setupLoading=true;this.capturedWorld=this.world();this.spawn(cx,async()=>{try{this.config=(await readConfig(this.io)).value;if(this.closed)return;if(this.props.target)this.setupTarget=validateRepoBinding({machine:this.props.target.machine,repoRoot:this.props.target.repoRoot});else await this.resolveSetup(this.capturedWorld.space,this.capturedWorld.panes);if(!this.closed&&this.setupTarget)this.initializeForm();}finally{this.setupLoading=false;}});return;
    }
    const saved=uiState();this.all=this.props.scope==='all'||this.props.scope!=='space'&&saved.all;
    this.board=new IssueBoardState({query:saved.query,status:saved.status,onChange:()=>this.saveUI()});this.lastConfig=JSON.stringify(herdr.shared(CONFIG_EVENT)||null);this.contextKey=null;
    this.syncFromWorld(cx,{force:true});this.timers.push(cx.timer.every(60000,eventCx=>this.syncFromWorld(eventCx,{force:true})));
    // A load the host ended mid-flight is retried here instead of showing Loading for ever.
    this.timers.push(cx.timer.every(5000,eventCx=>{if(!this.closed&&this.data.hasAbandonedLoad())this.spawn(eventCx,()=>this.data.recoverAbandoned());}));
    this.commandTask=cx.spawn(async(eventCx)=>{while(!this.closed){const command=await herdr.nextCommand();if(this.closed)return;if(command==='refresh')this.syncFromWorld(eventCx,{force:true});else if(command==='setup')this.openSetup(undefined,eventCx);else if(command==='all-spaces')this.setScope(true,eventCx);else if(command==='this-space')this.setScope(false,eventCx);eventCx.notify();}});
  }
  spawn(cx,work){
    this.jobs=this.jobs.filter(job=>!job?.is_done?.());const job=cx.spawn(async(eventCx)=>{try{await work(eventCx);}catch(error){if(!this.closed&&error?.code!=='REQUEST_CANCELLED')this.error=error?.code?error.message:'Jira could not complete this action. Check the selected connection and retry.';}if(!this.closed)eventCx.notify();});this.jobs.push(job);return job;
  }
  world(){
    const spaces=herdr.spaces(),focused=herdr.focused(),panes=herdr.panes().map(p=>({...p,focused:p.focused||p.pane===focused?.pane}));
    for(const space of spaces){const pane=panes.find(p=>p.terminal&&p.focused&&space.tabs.some(t=>t.id===p.tab));if(pane)this.originPanes.set(space.id,pane.pane);}
    const wanted=this.props.target?.spaceId||this.props.spaceId||focused?.space,expected=this.props.target&&Object.hasOwn(this.props.target,'machine')?this.props.target.machine:Object.hasOwn(this.props,'machine')?this.props.machine:undefined,space=spaces.find(s=>s.id===wanted&&(expected===undefined||s.machine===expected));
    return {spaces:copy(spaces),space:space?copy(space):null,panes};
  }
  saveUI(){if(this.board)herdr.setShared(STATE,{v:1,all:this.all,...this.board.filters()});}
  setScope(all,cx){if(this.all===all)return;this.all=all;this.saveUI();this.contextKey=null;this.syncFromWorld(cx,{force:true});}
  discover(machine,cx){
    const key=machineKey(machine),host=herdr.machines().find(m=>m.name===machine);if(host?.layout!=='ready'||this.toolPending.has(key)||Date.now()-(this.toolTimes.get(key)||0)<60000)return;
    this.toolPending.add(key);return this.spawn(cx,async()=>{try{const tools=await herdr.knownAgents({on:machine});if(!this.closed){this.tools.set(key,tools);this.toolTimes.set(key,Date.now());}}catch{this.tools.delete(key);}finally{this.toolPending.delete(key);}});
  }
  syncFromWorld(cx,{force=false}={}){
    if(this.closed||this.role!=='panel')return;const captured=this.world(),revision=JSON.stringify(herdr.shared(CONFIG_EVENT)||null),space=captured.space,origin=space?this.originPanes.get(space.id):null;
    const eligible=captured.panes.filter(p=>space?.tabs.some(t=>t.id===p.tab)),bound=this.props.target?.repoRoot&&!this.props.target.spaceId,key=this.all?'all':bound?JSON.stringify(['bound',this.props.target.machine,this.props.target.repoRoot,captured.panes.map(p=>[p.pane,p.terminal,p.cwd])]):JSON.stringify([space?.id??null,space?.machine??null,origin??null,eligible.map(p=>[p.pane,p.terminal,p.cwd])]);
    const changed=key!==this.contextKey||revision!==this.lastConfig;if(!force&&!changed)return;
    this.contextKey=key;this.lastConfig=revision;const epoch=++this.contextEpoch;if(changed){this.resolved=null;this.data.clearSelection();}this.error=null;
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
      await this.data.synchronize(resolved,{all:this.all});if(this.closed||epoch!==this.contextEpoch)return;this.config=this.data.config;
      for(const machine of new Set(this.data.view().bindings.map(b=>b.binding.machine)))this.discover(machine,eventCx);
      await this.data.refresh({force});
    });
  }
  launchReason(issue){
    if(this.launching.has(issueIdentityKey(issue)))return 'Starting this issue…';if(!this.all&&this.props.target?.repoRoot&&this.resolved?.state!=='resolved')return 'Open this repository in a space to start work.';const host=herdr.machines().find(m=>m.name===issue.repoBinding.machine);return host?.layout==='ready'?'':'The execution machine is offline or still connecting.';
  }
  startIssue(value,toolKey,cx,{options=false}={}){
    let issue;try{issue=validateIssue(value);jiraLaunchSource(issue);}catch{this.error='This issue is unavailable. Refresh its connection.';cx.notify();return;}
    const key=issueIdentityKey(issue);if(this.launching.has(key))return;this.launching.add(key);this.error=null;const all=this.all,resolved=this.resolved?copy(this.resolved):null,originPane=resolved?this.originPanes.get(resolved.spaceId):null;cx.notify();
    return this.spawn(cx,async()=>{
      try{const captured=await captureJiraTarget(issue,{all,resolved,originPane,isCurrent:()=>!this.closed});if(this.closed)return;
        if(options)openLaunchDialog(MOD,herdr,{view:'launch',target:captured.target,...captured.target,source:captured.source,...(toolKey?{toolKey}:{})});
        else{const result=await quickStart({target:captured.target,source:captured.source,toolKey},this.io);if(!result.ok)this.error=result.message;}
      }finally{this.launching.delete(key);}
    });
  }
  openIssue(value,cx){let issue;try{issue=validateIssue(value);jiraLaunchSource(issue);}catch{this.error='This issue link is unavailable. Refresh its connection.';cx.notify();return;}
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
  input(value,placeholder,{rows}={}){const state=rows?TextareaState.new({value,placeholder,rows}):InputState.new({value,placeholder});state.on('change',(_e,cx)=>{if(!this.initializingForm){this.formEpoch++;this.data.cancelSetup();this.error=null;}cx.notify();});this.inputs.push(state);return state;}
  nextProfileId(){let id='jira-work',n=2;while(this.config.connections[id])id='jira-work-'+n++;return id;}
  initializeForm(){
    for(const input of this.inputs)input.release();this.inputs=[];const model=jiraSetupModel(this.config,{state:'resolved',...this.setupTarget});this.project=this.input(model.selection.project||'','WEB');this.jql=this.input(model.selection.jql||'','Optional JQL',{rows:3});
    this.profileId=this.input('','Profile ID');this.site=this.input('','https://your-site.atlassian.net');this.cloudId=this.input('','Optional Jira cloud ID');this.emailEnv=this.input('','WORK_JIRA_EMAIL');this.tokenEnv=this.input('','WORK_JIRA_TOKEN');this.mcpUrl=this.input('','https://your-mcp-server/mcp');
    this.execution=this.input('','Local program and arguments',{rows:5});this.mapping=this.input('','JSON result mapping',{rows:7});this.searchConfig=this.input('','Read-only tool configuration',{rows:9});this.setProfile(model.connection,{existing:Boolean(model.connection)});
  }
  setProfile(connection,{existing=false}={}){
    this.initializingForm=true;const c=connection||{id:this.nextProfileId(),kind:'api',site:'',auth:{kind:'basic',usernameEnv:'',tokenEnv:''}};this.selectedProfile=existing?copy(c):null;this.kind=c.kind;this.authKind=c.auth?.kind||(c.kind==='mcp-http'?'none':'basic');
    this.profileId.set_value(c.id);this.site.set_value(c.site);this.cloudId.set_value(c.cloudId||'');this.emailEnv.set_value(c.auth?.usernameEnv||'');this.tokenEnv.set_value(c.auth?.tokenEnv||'');this.mcpUrl.set_value(c.url||'');
    this.execution.set_value(JSON.stringify(c.execution||(c.kind==='mcp-stdio'?{machine:null,command:'',args:[],envRefs:{}}:{machine:null,command:'',argsTemplate:['{{request}}']}),null,2));this.mapping.set_value(JSON.stringify(c.mapping||defaultMapping(),null,2));this.searchConfig.set_value(JSON.stringify(c.search||defaultSearch(),null,2));this.initializingForm=false;this.formEpoch++;this.data.cancelSetup();this.error=null;
  }
  changeKind(kind,cx){const c={id:this.profileId.value(),site:this.site.value(),kind};if(kind==='api')c.auth={kind:'basic',usernameEnv:this.emailEnv.value(),tokenEnv:this.tokenEnv.value()};this.setProfile(c);cx.notify();}
  collectProfile(){
    if(this.selectedProfile)return copy(this.selectedProfile);const c={id:this.profileId.value().trim(),kind:this.kind,site:trackerOrigin(this.site.value().trim())};
    const json=state=>{try{return JSON.parse(state.value());}catch{fail('INVALID_PROFILE_JSON','Program, tool and mapping fields must contain valid JSON.');}};
    if(this.kind==='api'){const cloudId=this.cloudId.value().trim();if(cloudId)c.cloudId=cloudId;}
    if(['api','mcp-http'].includes(this.kind)&&this.authKind!=='none'){c.auth={kind:this.authKind,tokenEnv:this.tokenEnv.value().trim()};if(this.authKind==='basic')c.auth.usernameEnv=this.emailEnv.value().trim();}
    if(this.kind==='mcp-http')c.url=this.mcpUrl.value().trim();if(this.kind==='cli'||this.kind==='mcp-stdio')c.execution=json(this.execution);if(this.kind==='cli')c.mapping=json(this.mapping);if(this.kind.startsWith('mcp-'))c.search=json(this.searchConfig);return c;
  }
  saveSetup(cx){
    if(this.saving||!this.setupTarget)return;let connection,selection;
    try{connection=this.collectProfile();selection={...(this.project.value().trim()?{project:this.project.value().trim()}:{}),...(this.jql.value().trim()?{jql:this.jql.value().trim()}:{})};}catch(error){this.error=error?.code==='INVALID_PROFILE_JSON'?error.message:'Enter a valid canonical Jira base URL and profile configuration.';cx.notify();return;}
    const epoch=this.formEpoch,target=copy(this.setupTarget);this.saving=true;this.error=null;cx.notify();
    return this.spawn(cx,async()=>{try{const saved=await this.data.saveSetup({target,connection,selection},{isCurrent:()=>!this.closed&&epoch===this.formEpoch});if(!this.closed&&epoch===this.formEpoch){this.config=saved.config;herdr.setShared(CONFIG_EVENT,{v:1,owner:this.instance,revision:++this.seq});if(!this.props.overlay)this.setProfile(saved.config.connections[connection.id],{existing:true});this.closeOverlay();this.saved=true;}}catch(error){if(!this.closed&&epoch===this.formEpoch)this.error=error?.code?error.message:'The connection could not be saved. Existing settings were preserved.';}finally{this.saving=false;}});
  }
  closeOverlay(){if(this.props.overlay)herdr.closeOverlay(this.props.overlay);}
  header(title){const t=colors(),caption=this.all?String(Object.values(this.config?.bindings||{}).filter(b=>b.jira).length)+' spaces':this.scopeSpace?.name||(this.resolved?.repoRoot||this.props.target?.repoRoot||'').split('/').filter(Boolean).at(-1);return h_flex().h(38).px(12).gap(8).items_center().border_b(1).border_color(t.border).child(icon(MOD,'jira',16)).child(div().font_semibold().text_size(12).text_color(t.foreground).child(title))
    .when(this.role==='panel'&&Boolean(caption),row=>row.child(div().flex_1().min_w(0).truncate().text_size(10).text_color(t.dim).child(caption))).child(div().flex_1())
    .when(this.role==='panel',row=>row.child(iconButton(MOD,'jira-shortcuts','pin','Agent shortcuts',(_e,cx)=>this.openShortcuts(cx))))
    .when(Boolean(this.props.overlay),row=>row.child(iconButton(MOD,'jira-close','close','Close',()=>this.closeOverlay())));}
  field(id,title,state,{multiline=false,height=32}={}){const t=colors(),input=multiline?Textarea.new(state):Input.new(state);return v_flex().gap(5).child(label(title,{muted:true,size:11})).child(input.id(id).h(height).px(8).py(multiline?7:0).rounded(5).border(1).border_color(t.border).bg(t.chrome).text_color(t.foreground).text_size(multiline?11:12).when(multiline,el=>el.font_family('Geist Mono')));}
  setupView(cx){
    const t=colors(),root=v_flex().id('jira-setup').size_full().min_h(0).bg(t.surface).text_size(12).child(this.header('Jira connection'));
    if(this.setupLoading)return root.child(div().p(18).text_color(t.muted).child('Loading repository settings…'));
    if(!this.config)return root.child(div().p(18).text_color(t.blocked).child(this.error||'Repository settings are unavailable. The original file was preserved.'));
    if(!this.setupTarget)return root.child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().p(16).gap(8).child(label(this.setupError||'Choose a repository space.',{muted:true})).children((this.setupCandidates?.length?this.setupCandidates.map(c=>({space:this.setupSpace,pane:c.paneId,label:c.repoRoot})):herdr.spaces().map(space=>({space,label:space.name+' · '+(space.machine||'This Mac')}))).map(choice=>textButton('jira-choose-'+(choice.pane||choice.space.id),choice.label,(_e,eventCx)=>this.chooseSetup(choice.space,eventCx,choice.pane)))));
    const profiles=Object.values(this.config.connections).filter(p=>['api','cli','mcp-stdio','mcp-http'].includes(p.kind));
    const body=v_flex().flex_1().min_h(0).overflow_y_scrollbar().p(16).gap(13).child(label((this.setupTarget.machine||'This Mac')+' · '+this.setupTarget.repoRoot,{muted:true,size:11}))
      .when(Boolean(profiles.length),el=>el.child(v_flex().max_h(112).overflow_y_scrollbar().gap(4).children(profiles.map(profile=>textButton('jira-profile-'+profile.id,profile.id+' · '+profile.site,(_e,eventCx)=>{this.setProfile(profile,{existing:true});eventCx.notify();},{primary:this.selectedProfile?.id===profile.id})))))
      .child(h_flex().gap(6).child(textButton('jira-new-profile','New profile',(_e,eventCx)=>{this.setProfile(null);eventCx.notify();},{primary:!this.selectedProfile}))
        .when(Boolean(this.selectedProfile),el=>el.child(textButton('jira-duplicate-profile','Duplicate profile',(_e,eventCx)=>{const profile={...copy(this.selectedProfile),id:this.nextProfileId()};this.setProfile(profile);eventCx.notify();}))))
      .child(this.field('jira-project','Project key',this.project)).child(this.field('jira-jql','JQL (optional; replaces the project filter)',this.jql,{multiline:true,height:64}));
    if(this.selectedProfile)body.child(v_flex().gap(6).p(10).rounded(5).border(1).border_color(t.border).child(label(this.selectedProfile.id)).child(label(this.selectedProfile.site,{muted:true,size:11})).child(label(jiraRouteDescription(this.selectedProfile),{muted:true,size:11})).child(div().text_color(t.dim).text_size(11).child('This profile is shared. Duplicate it to change its connection.')));
    else{
      body.child(this.field('jira-profile-id','Profile ID',this.profileId)).child(this.field('jira-site','Canonical Jira base URL',this.site))
        .child(div().text_size(10).text_color(t.dim).child('Use serverInfo.baseUrl, not a custom display URL.'))
        .child(h_flex().gap(5).children([['api','API'],['cli','CLI'],['mcp-stdio','MCP program'],['mcp-http','MCP HTTPS']].map(([kind,name])=>textButton('jira-kind-'+kind,name,(_e,eventCx)=>this.changeKind(kind,eventCx),{primary:this.kind===kind}))));
      if(this.kind==='api'||this.kind==='mcp-http')body.child(h_flex().gap(5).children((this.kind==='api'?['basic','bearer']:['none','basic','bearer']).map(auth=>textButton('jira-auth-'+auth,auth==='basic'?'Email + token':auth==='bearer'?'Bearer token':'No auth',(_e,eventCx)=>{this.authKind=auth;this.formEpoch++;this.data.cancelSetup();eventCx.notify();},{primary:this.authKind===auth}))));
      if(this.kind==='api')body.child(this.field('jira-cloud-id','Cloud ID (scoped tokens / service accounts)',this.cloudId)).child(div().text_size(10).text_color(t.dim).child(jiraRouteDescription({kind:'api',cloudId:this.cloudId.value().trim(),auth:{kind:this.authKind}})));
      if(this.kind==='mcp-http')body.child(this.field('jira-mcp-url','HTTPS MCP endpoint',this.mcpUrl));
      if(['api','mcp-http'].includes(this.kind)&&this.authKind!=='none'){if(this.authKind==='basic')body.child(this.field('jira-email-env','Email environment variable',this.emailEnv));body.child(this.field('jira-token-env','Token environment variable',this.tokenEnv)).child(div().text_size(10).text_color(t.dim).child('Variable names only. Credential values stay in the local helper.'));}
      if(this.kind==='cli'||this.kind==='mcp-stdio')body.child(this.field('jira-execution','Local program and arguments',this.execution,{multiline:true,height:150}));
      if(this.kind==='cli')body.child(this.field('jira-result-mapping','JSON result and workflow mapping',this.mapping,{multiline:true,height:190}));
      if(this.kind.startsWith('mcp-'))body.child(this.field('jira-search-config','Read-only tool, arguments and result mapping',this.searchConfig,{multiline:true,height:240}));
    }
    return root.child(body).when(Boolean(this.error),el=>el.child(div().px(16).py(6).text_size(11).text_color(t.blocked).child(this.error)))
      .child(h_flex().p(12).gap(8).items_center().border_t(1).border_color(t.border).child(textButton('jira-cancel-setup','Cancel',()=>this.closeOverlay())).child(div().flex_1()).child(textButton('jira-save-setup',this.saving?'Checking…':this.saved?'Saved':'Save connection',(_e,eventCx)=>this.saveSetup(eventCx),{primary:true,disabled:this.saving})));
  }
  render(cx){
    if(this.dialog)return this.dialog.render(cx);if(this.role==='setup')return this.setupView(cx);this.syncFromWorld(cx);
    const t=colors(),root=v_flex().id('jira-panel').size_full().min_h(0).bg(t.surface);
    if(!this.props.hideHeader)root.child(this.header('Jira'));
    if(this.error)root.child(div().id('jira-action-error').px(12).py(7).text_size(11).text_color(t.blocked).child(this.error));
    return root.child(renderIssueBoard({id:'jira-board',mod:MOD,state:this.board,view:this.data.view(),preferences:this.config?.preferences.launch||{},toolsForMachine:machine=>this.tools.get(machineKey(machine))||[],launchReason:issue=>this.launchReason(issue),onOpenIssue:(issue,eventCx)=>this.openIssue(issue,eventCx),onLaunch:(issue,key,eventCx)=>this.startIssue(issue,key,eventCx),onOptions:(issue,eventCx)=>this.startIssue(issue,undefined,eventCx,{options:true}),onRefresh:(_value,eventCx)=>this.syncFromWorld(eventCx,{force:true}),onSetup:(binding,eventCx)=>this.openSetup(binding,eventCx),onScopeChange:(all,eventCx)=>this.setScope(all,eventCx),onLoadMore:(_value,eventCx)=>this.spawn(eventCx,()=>this.data.refresh({loadMore:true})),onInvalid:(message,eventCx)=>{this.error=message;eventCx.notify();}},cx));
  }
  close(){if(this.closed)return;this.closed=true;this.contextEpoch++;this.data?.close();this.board?.close();this.dialog?.close();for(const timer of this.timers)timer?.cancel?.();for(const job of this.jobs)job?.cancel?.();this.commandTask?.cancel?.();for(const input of this.inputs)input.release();}
}
