import {View,div,list} from 'gpui-kit';
import {v_flex,h_flex,Scrollbar} from 'gpui-base';
import {toolChoices} from '../../shared/launch-preferences.js';
import {colors,label,icon,iconButton,textButton,toolIcon,createSearch,searchInput} from '../../shared/ui.js';
import {validatePullRequest,pullIdentityKey,prActionAvailability,prReasonText} from './pull-model.js';

const filters=[['all','All'],['open','Open'],['draft','Draft'],['closed','Closed'],['merged','Merged']];
export const pullActions=[['review','Review'],['addressComments','Address comments'],['fixChecks','Fix checks']];
export const pullCardId=(board,pull)=>board+'-pull-'+pullIdentityKey(pull);
function validatedSlotKey(p,toolKey){const i=p.identity;return JSON.stringify([p.repoBinding.machine,p.repoBinding.repoRoot,'github-pr',i.connectionId,i.site,i.owner.toLowerCase()+'/'+i.repo.toLowerCase()+'#'+i.number,toolKey]);}
export function pullSlotKey(value,toolKey){return validatedSlotKey(validatePullRequest(value),toolKey);}
function deeplyFrozen(value){return value===null||typeof value!=='object'||Object.isFrozen(value)&&Object.values(value).every(deeplyFrozen);}
function freezePresentation(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))freezePresentation(child);Object.freeze(value);}return value;}
const fail=()=>{throw Object.assign(Error('Choose an available pull request filter.'),{code:'INVALID_FILTER'});};

export class PullBoardState{
  constructor({query='',status='all',onChange=()=>{}}={}){
    if(typeof query!=='string'||query.length>512||!filters.some(([key])=>key===status))fail();
    Object.assign(this,{query,status,onChange,width:0,limit:60,actions:new Map(),expanded:new Set(),presentation:new WeakMap(),pool:new Map(),retained:new Map(),poolEpoch:0,requested:null,ready:null,closed:false});
    this.search=createSearch('Search pull requests',(value,cx)=>{this.query=value.slice(0,512);if(value!==this.query)this.search.set_value(this.query);this.limit=60;this.onChange(this.filters(),cx);});this.search.set_value(query);
  }
  filters(){return {query:this.query,status:this.status};}
  selectStatus(status,cx){if(!filters.some(([key])=>key===status))fail();this.status=status;this.limit=60;this.onChange(this.filters(),cx);cx.notify();}
  prepare(pull){
    const cached=this.presentation.get(pull);if(cached)return cached;
    const checked=validatePullRequest(pull),record={pull:checked,key:pullIdentityKey(checked),search:[checked.title,checked.key,checked.author.login||'',checked.identity.owner+'/'+checked.identity.repo,...checked.linkedIssues.map(i=>i.id)].join(' ').toLowerCase(),availability:Object.fromEntries(pullActions.map(([action])=>[action,prActionAvailability(checked,action)]))};
    // Only immutable bridge snapshots may be memoized. Callers with mutable
    // records still receive fresh validation, including nested metadata.
    if(deeplyFrozen(pull))this.presentation.set(pull,freezePresentation(record));return record;
  }
  action(pull,key=pullIdentityKey(pull)){return this.actions.get(key)||'review';}
  selectAction(pull,action,cx){if(!pullActions.some(([key])=>key===action))fail();if(this.actions.size>=1000)this.actions.clear();this.actions.set(pullIdentityKey(pull),action);cx.notify();}
  toggle(pull,cx){const key=pullIdentityKey(pull);if(this.expanded.has(key))this.expanded.delete(key);else{if(this.expanded.size>=1000)this.expanded.clear();this.expanded.add(key);}cx.notify();}
  retain(key){const held={task:null,finishing:false};this.retained.set(key,held);return held;}
  unretain(key){const held=this.retained.get(key);if(held)held.finishing=true;}
  /** Only root-owned tasks create, update or release native child handles. */
  synchronize(props,cx,spawn){
    if(this.closed)return;const previous=this.requested;
    if(previous&&previous.view===props.view&&previous.preferences===props.preferences&&previous.revision===props.revision&&previous.slots===props.slots)return;
    const request={view:props.view,preferences:props.preferences,revision:props.revision,slots:props.slots,epoch:++this.poolEpoch};this.requested=request;this.ready=null;
    return spawn(cx,async taskCx=>{
      const current=()=>!this.closed&&this.requested===request,records=[],children=[],wanted=new Set(),choices=new Map();let count=0,bytes=0,started=Date.now();
      // Native spawn starts synchronously in its caller's phase. Yield before
      // any retained-view effect when scheduling from a root render.
      await taskCx.sleep(0);if(!current())return;
      const yieldBatch=async size=>{count++;bytes+=size;if(count>=8||bytes>=32768||Date.now()-started>=6){await taskCx.sleep(0);count=0;bytes=0;started=Date.now();}return current();};
      for(const pull of props.view.data||[]){
        if(!current())return;const listed=this.prepare(pull),key=listed.key,detail=props.detailState?.(listed.pull)||{state:'unloaded'},record=detail.state==='ready'?this.prepare(detail.pull):listed,machine=JSON.stringify(record.pull.repoBinding.machine);
        if(!choices.has(machine))choices.set(machine,toolChoices(props.toolsForMachine?.(record.pull.repoBinding.machine)||[],props.preferences||{}));
        const tools=choices.get(machine),slots=Object.fromEntries(tools.all.map(tool=>[tool.key,props.slotFor?.(record.pull,tool.key,validatedSlotKey(record.pull,tool.key))||null]));
        const child={id:props.id,mod:props.mod,record,detail,choices:tools,slots,reason:props.launchReason?.(record.pull)||'',all:Boolean(props.view.all),action:()=>this.action(record.pull,key),expanded:()=>this.expanded.has(key),selectAction:(action,eventCx)=>this.selectAction(record.pull,action,eventCx),toggle:eventCx=>this.toggle(record.pull,eventCx),onDetails:props.onDetails,onOpen:props.onOpen,onLaunch:props.onLaunch,onOptions:props.onOptions};
        children.push({key,props:child});wanted.add(key);records.push(record);
        if(!await yieldBatch(record.search.length+record.pull.body.length))return;
      }
      for(const[key,held]of this.retained)if(held.finishing){while(!held.task?.is_done()){await taskCx.sleep(0);if(!current())return;}this.retained.delete(key);}
      for(const[key,entry]of this.pool){if(!current())return;if(!wanted.has(key)&&!this.retained.has(key)){entry.entity.release();this.pool.delete(key);if(!await yieldBatch(0))return;}}
      // Prune before allocating the next source collection. Even while a new
      // account prepares, the pool is bounded by its collection plus launches.
      for(const child of children){if(!current())return;let entry=this.pool.get(child.key);if(entry)entry.entity.set_props(child.props);else{entry={entity:taskCx.new(PullCard,child.props)};this.pool.set(child.key,entry);}if(!await yieldBatch(0))return;}
      if(current()){this.ready={request,records};taskCx.notify();}
    });
  }
  close(){if(this.closed)return;this.closed=true;this.poolEpoch++;this.ready=null;this.requested=null;for(const entry of this.pool.values())entry.entity.release();this.pool.clear();this.retained.clear();this.presentation=new WeakMap();this.search.release();}
}

export class PullCard extends View{
  init(props){this.update(props);}
  update(props){this.props=props;}
  render(){return card(this.props);}
}
function button(id,title,action,{active=false,disabled=false,hint=title}={}){
  const t=colors();let el=h_flex().id(id).h(25).px(6).gap(4).items_center().rounded(4).bg(active?t.selected:'#00000000').text_size(10).text_color(disabled?t.dim:active?t.accent:t.muted).tooltip(hint).accessibility_label(hint).role('button');
  if(!disabled)el=el.cursor_pointer().hover(s=>s.bg(t.hover)).on_mouse_down('left',(_e,cx)=>cx.stop_propagation()).on_click((_e,cx)=>{cx.stop_propagation();return action(cx);});
  return el.child(title);
}
function captured(pull,callback){return (_e,cx)=>{cx.stop_propagation();return callback(validatePullRequest(pull),cx);};}
function link(id,title,url,pull,onOpen,{main=false}={}){
  const t=colors();let el=div().id(id).min_w(0).text_size(main?12:10).text_color(main?t.foreground:t.accent).tooltip(url).accessibility_label('Open '+title).role('link').cursor_pointer().hover(s=>s.text_color(t.accent)).on_mouse_down('left',(_e,cx)=>cx.stop_propagation()).on_click(captured(pull,(p,cx)=>onOpen(p,url,cx)));
  return (main?el.h(36).line_height('18px').overflow_hidden():el.truncate()).child(title);
}
function linkedIssueLabel(pull,issue){
  if(issue.kind!=='github')return issue.id;
  const [owner,repo,,number]=issue.url.slice(pull.identity.site.length+1).split('/'),repository=owner+'/'+repo;
  return (repository.toLowerCase()===(pull.identity.owner+'/'+pull.identity.repo).toLowerCase()?'':repository)+'#'+number;
}
function metadata(pull){
  const review={approved:'Approved',changesRequested:'Changes requested',reviewRequired:'Review required'},checks={success:'Checks passed',pending:'Checks pending',failure:'Checks failed'};
  return [
    [review[pull.review.state]||'Review unavailable',pull.review.reason?prReasonText(pull.review.reason):'',pull.review.state==='approved'?'done':pull.review.state==='changesRequested'?'blocked':'dim'],
    [pull.discussions.state==='actionable'?pull.discussions.count+' unresolved':pull.discussions.state==='none'?'No open threads':'Threads unavailable',pull.discussions.reason?prReasonText(pull.discussions.reason):'Unresolved review threads',pull.discussions.state==='actionable'?'blocked':'dim'],
    [checks[pull.checks.state]||'Checks unavailable',pull.checks.reason?prReasonText(pull.checks.reason):'',pull.checks.state==='success'?'done':pull.checks.state==='failure'?'blocked':'dim']
  ];
}
function card(props){
  const {id,mod,record,choices,detail,reason}=props,t=colors(),pull=record.pull,key=record.key,cid=id+'-pull-'+key,action=props.action(),existing=Object.values(props.slots).filter(Boolean),availability=record.availability[action],canLoad=availability.reason==='NOT_LOADED',open=pull.state==='open',expanded=props.expanded(),binding=pull.repoBinding;
  const context=[binding.machine||'This Mac',binding.repoRoot,pull.identity.connectionId,pull.identity.site].join(' · '),status=pull.draft&&open?'Draft':pull.state[0].toUpperCase()+pull.state.slice(1);
  const controls=h_flex().gap(2).items_center().children(choices.quick.map(tool=>{
    const slot=props.slots[tool.key],verb=slot?'Open agent':'Start '+pullActions.find(([key])=>key===action)[1],disabled=Boolean(reason)||!slot&&!availability.enabled&&!canLoad,hint=reason||slot&&(slot.state==='closed'?'This agent is closed. Resume its exact session from history.':'Open agent · '+tool.name)||!availability.enabled&&!canLoad&&(availability.reason?prReasonText(availability.reason):'Checks are not failing.')||verb+' with '+tool.name;
    let control=div().id(cid+'-start-'+tool.key).size(26).flex_none().flex().items_center().justify_center().rounded(4).opacity(disabled?0.45:1).tooltip(hint).accessibility_label(hint).role('button');
    if(!disabled)control=control.cursor_pointer().hover(s=>s.bg(t.selected)).on_mouse_down('left',(_e,cx)=>cx.stop_propagation()).on_click(captured(pull,(p,cx)=>props.onLaunch(p,action,tool.key,cx)));
    return control.child(toolIcon(mod,tool,15));
  })).child(iconButton(mod,cid+'-options','more','Choose an agent and worktree options',captured(pull,(p,cx)=>props.onOptions(p,action,cx)),{size:26,disabled:Boolean(reason)||!availability.enabled&&!canLoad}));
  const actions=h_flex().gap(2).items_center().children(pullActions.map(([value,title])=>{const a=record.availability[value];return button(cid+'-action-'+value,title,cx=>props.selectAction(value,cx),{active:action===value,disabled:!a.enabled&&a.reason!=='NOT_LOADED',hint:a.enabled?title:a.reason?prReasonText(a.reason):'Checks are not failing.'});}));
  const result=v_flex().id(cid).flex_1().min_w(0).p(11).gap(7).rounded(6).bg(t.chrome).border(1).border_color(t.border).tooltip(context)
    .child(h_flex().gap(6).items_center().child(icon(mod,'github',13).text_color(t.muted)).child(link(cid+'-key','#'+pull.identity.number,pull.url,pull,props.onOpen)).child(div().flex_1()).child(div().text_size(10).text_color(pull.state==='merged'?t.accent:open?t.done:t.dim).child(status)))
    .child(link(cid+'-title',pull.title,pull.url,pull,props.onOpen,{main:true}))
    .child(h_flex().gap(5).items_center().when(Boolean(pull.author.login),el=>el.child(link(cid+'-author','@'+pull.author.login,pull.author.url,pull,props.onOpen))).when(!pull.author.login,el=>el.child(label('Deleted account',{muted:true,size:10}))).child(div().flex_1()).child(div().max_w(190).truncate().text_size(10).text_color(t.dim).tooltip(context).child(pull.identity.owner+'/'+pull.identity.repo)))
    .child(h_flex().gap(7).children(metadata(pull).map(([title,hint,color],index)=>h_flex().id(cid+'-metadata-'+index).flex_1().min_w(0).gap(4).items_center().tooltip(hint||title).child(div().size(4).flex_none().rounded_full().bg(t[color]||t.dim)).child(label(title,{muted:true,size:10}).flex_1().min_w(0)))))
    .when(Boolean(pull.linkedIssues.length),el=>el.child(h_flex().gap(6).children(pull.linkedIssues.slice(0,3).map((issue,index)=>h_flex().gap(3).min_w(0).child(icon(mod,issue.kind==='jira'?'jira':'issue',11)).child(link(cid+'-linked-'+index,linkedIssueLabel(pull,issue),issue.url,pull,props.onOpen))))
      .when(pull.linkedIssues.length>3,row=>row.child(label('+'+(pull.linkedIssues.length-3),{muted:true,size:10})))))
    .child(h_flex().gap(5).items_center().child(button(cid+'-details',detail.state==='loading'?'Loading…':expanded?'Hide details':'Details',cx=>{props.toggle(cx);if(!expanded)return props.onDetails?.(pull,cx);},{disabled:detail.state==='loading'})).child(div().flex_1())
      .when(existing.length>0,el=>el.child(div().text_size(10).text_color(t.accent).tooltip('Existing work is focus-only. A different action is never sent to the running agent.').child(existing.every(slot=>slot.state==='closed')?'Resume from history':'Open agent'))))
    .when(expanded,el=>el.child(v_flex().gap(4).p(7).rounded(4).bg(t.surface).child(label(pull.base.ref+' ← '+pull.head.ref,{muted:true,size:10})).child(label('Head '+pull.head.sha.slice(0,12),{muted:true,size:10})).when(Boolean(detail.error),row=>row.child(div().text_size(10).text_color(t.blocked).child(detail.error.message)))))
    .child(actions).child(h_flex().gap(6).items_center().when(props.all,el=>el.child(div().flex_1().min_w(0).truncate().text_size(10).text_color(t.dim).child((binding.machine||'This Mac')+' · '+(binding.repoRoot.split('/').at(-1)||binding.repoRoot)))).when(!props.all,el=>el.child(div().flex_1())).child(controls));
  return result;
}

/** Dedicated PR surface; no issue workflow groups or repeated provider heading. */
export function renderPullBoard(props,cx){
  const {id,mod,state,view}=props,t=colors(),width=state.width,narrow=width<560,query=state.query.toLowerCase(),ready=state.ready?.request===state.requested?state.ready:null,searched=(ready?.records||[]).filter(record=>record.search.includes(query));
  const match=({pull:p},status)=>status==='all'||(status==='draft'?p.state==='open'&&p.draft:status==='open'?p.state==='open'&&!p.draft:p.state===status),filtered=searched.filter(p=>match(p,state.status)),rows=filtered.slice(0,state.limit),columns=width>=1100?3:width>=720?2:1,batches=[];
  for(let index=0;index<rows.length;index+=columns){const records=rows.slice(index,index+columns);batches.push({key:columns+':'+records.map(p=>p.key).join('|'),entities:records.map(p=>state.pool.get(p.key).entity)});}
  const scope=h_flex().gap(2).child(button(id+'-scope-this','This space',cx=>props.onScopeChange(false,cx),{active:!view.all})).child(button(id+'-scope-all','All spaces',cx=>props.onScopeChange(true,cx),{active:Boolean(view.all)})),search=searchInput(mod,id+'-search',state.search).flex_1().min_w(0),actions=h_flex().gap(2).child(iconButton(mod,id+'-refresh','refresh','Refresh pull requests',(_e,eventCx)=>props.onRefresh(eventCx),{disabled:Boolean(view.loading)})).child(iconButton(mod,id+'-settings','settings','Integration settings',(_e,eventCx)=>props.onSetup(undefined,eventCx)));
  const toolbar=narrow?v_flex().gap(8).child(h_flex().items_center().child(scope).child(div().flex_1()).child(actions)).child(search):h_flex().gap(8).items_center().child(scope).child(search).child(actions),filterButtons=filters.map(([key,title])=>button(id+'-filter-'+key,title+' '+searched.filter(p=>match(p,key)).length,eventCx=>state.selectStatus(key,eventCx),{active:state.status===key}));
  const filterBar=width<390?v_flex().gap(2).child(h_flex().gap(2).children(filterButtons.slice(0,3))).child(h_flex().gap(2).children(filterButtons.slice(3))):h_flex().gap(2).children(filterButtons);
  const body=v_flex().id(id+'-cards').relative().flex_1().min_h(0),listId=id+'-card-list';
  if(batches.length)body.child(list(listId,batches.length,index=>batches[index].key,index=>h_flex().w_full().pb(10).gap(10).items_start().children(batches[index].entities)).flex_1()).child(Scrollbar.vertical(listId).absolute().top(0).bottom(0).left(0).right(0));
  else body.child(div().id(id+'-empty').p(20).text_size(11).text_color(t.dim).child(!ready||view.state==='loading'?'Loading pull requests…':view.state==='error'?'Pull requests unavailable':view.state==='setup'||view.state==='unbound'?'Choose a repository and connect its GitHub project.':'No matching pull requests'));
  const root=v_flex().id(id).size_full().min_w(0).min_h(0).p(narrow?10:14).gap(10).bg(t.surface).on_size_change((size,eventCx)=>{if(state.width!==size.width){state.width=size.width;eventCx.notify();}}).child(toolbar).child(filterBar);
  if(view.errors?.length)root.child(h_flex().gap(6).items_center().child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.blocked).tooltip(view.errors.map(e=>e.error.message).join('\n')).child(view.errors[0].error.message)).child(iconButton(mod,id+'-error-settings','settings','Check this connection',(_e,eventCx)=>props.onSetup(view.errors[0].binding,eventCx))));
  if(['setup','unbound'].includes(view.state))root.child(textButton(id+'-connect','Set up GitHub',(_e,eventCx)=>props.onSetup(undefined,eventCx)));
  return root.child(body).when(rows.length<filtered.length,el=>el.child(textButton(id+'-show-more','Show more',(_e,eventCx)=>{state.limit+=60;eventCx.notify();}))).child(h_flex().gap(8).items_center().child(div().flex_1().text_size(10).text_color(t.dim).child(!ready||view.state==='loading'&&!view.data.length?'Loading':rows.length+' / '+filtered.length+' loaded'+(view.errors?.length?' · Cached':'')))
    .when(Boolean(view.truncated),el=>el.child(label(view.limitReached?'Select a space to see more':'More results',{muted:true,size:10})))
    .when(Boolean(view.truncated&&!view.limitReached),el=>el.child(textButton(id+'-load-more','Load more',(_e,eventCx)=>props.onLoadMore(eventCx),{disabled:Boolean(view.loading)}))));
}
