import {div} from 'gpui-kit';
import {v_flex,h_flex} from 'gpui-base';
import {groupIssues,validateIssue,trackerOrigin,issueIdentityKey,TRACKER_GROUPS} from './tracker-model.js';
import {toolChoices} from './launch-preferences.js';
import {colors,label,icon,iconButton,textButton,toolIcon,createSearch,searchInput} from './ui.js';

const groups=[{key:'todo',title:'To do',color:'dim'},{key:'inProgress',title:'In progress',color:'working'},{key:'done',title:'Done',color:'done'}];
const copy=value=>JSON.parse(JSON.stringify(value));
export const issueCardId=(board,issue)=>board+'-issue-'+issueIdentityKey(issue);
const fail=()=>{throw Object.assign(Error('Choose an available issue filter.'),{code:'INVALID_FILTER'});};

/** Retain this state beside its owning native View; never create InputState during render. */
export class IssueBoardState{
  constructor({query='',status='all',onChange=()=>{}}={}){
    if(typeof query!=='string'||query.length>512||!['all',...TRACKER_GROUPS].includes(status))fail();
    this.query=query;this.status=status;this.width=0;this.onChange=onChange;this.closed=false;
    this.search=createSearch('Search issues',(value,cx)=>{this.query=value.slice(0,512);if(value!==this.query)this.search.set_value(this.query);this.onChange(this.filters(),cx);});this.search.set_value(query);
  }
  filters(){return {query:this.query,status:this.status};}
  selectStatus(value,cx){if(!['all',...TRACKER_GROUPS].includes(value))fail();this.status=value;this.onChange(this.filters(),cx);cx.notify();}
  close(){if(this.closed)return;this.closed=true;this.search.release();}
}
function validLink(issue){
  try{
    const site=trackerOrigin(issue.identity.site);if(site!==issue.identity.site)return false;
    if(issue.identity.kind==='jira')return /^[A-Za-z][A-Za-z0-9_]*-[1-9][0-9]*$/.test(issue.key)&&issue.url===site+'/browse/'+issue.key;
    if(issue.identity.kind==='gitlab'){validateIssue(issue);return true;}
    const b=issue.repoBinding.github,prefix=site+'/'+b.owner+'/'+b.repo+'/issues/',parts=issue.url.match(/^(https:\/\/[^/]+\/[^/]+\/[^/]+\/issues\/)([1-9][0-9]*)$/);return issue.identity.kind==='github'&&Boolean(parts)&&parts[1].toLowerCase()===prefix.toLowerCase();
  }catch{return false;}
}
function capturedAction(issue,callback,onInvalid){
  return (_event,cx)=>{cx.stop_propagation();let captured;try{captured=validateIssue(issue);}catch{onInvalid?.('This issue is unavailable. Reload its source mapping.',cx);return;}return callback(captured,cx);};
}
function issueLink(id,value,issue,callback,onInvalid,{title=false,linkValid=validLink(issue)}={}){
  const t=colors(),valid=linkValid&&typeof callback==='function';
  let el=div().id(id).min_w(0).text_color(title?t.foreground:t.accent).text_size(title?12:10).tooltip(valid?(title?issue.title+'\n':'Open '+issue.key+' · ')+issue.url:'Issue link unavailable').accessibility_label('Open '+issue.key).role('link');
  if(title)el=el.h(36).line_height('18px').overflow_hidden();else el=el.truncate();
  if(valid)el=el.cursor_pointer().hover(s=>s.text_color(t.accent)).on_mouse_down('left',(_e,cx)=>cx.stop_propagation()).on_click(capturedAction(issue,callback,onInvalid));
  return el.child(value);
}
function programButton(mod,id,issue,program,callback,onInvalid,reason,linkValid){
  const t=colors(),enabled=linkValid&&typeof callback==='function'&&!reason;
  let el=div().id(id).size(25).flex_none().flex().items_center().justify_center().rounded(4).tooltip(reason||'Start '+issue.key+' with '+(program.name||program.key)).accessibility_label('Start '+issue.key+' with '+(program.name||program.key)).role('button').opacity(enabled?1:0.45);
  if(enabled)el=el.cursor_pointer().hover(s=>s.bg(t.selected)).on_mouse_down('left',(_e,cx)=>cx.stop_propagation()).on_click(capturedAction(issue,(captured,cx)=>callback(captured,program.key,cx),onInvalid));
  return el.child(toolIcon(mod,program,15));
}
function repoCaption(issue){const b=issue.repoBinding,leaf=b.repoRoot.split('/').filter(Boolean).at(-1)||b.repoRoot;return leaf+(b.machine?' · '+b.machine:'');}
function card(props,issue,choices,narrow){
  const {mod,onOpenIssue,onLaunch,onOptions,onInvalid}=props,t=colors(),id=issueCardId(props.id,issue),linkValid=validLink(issue),reason=props.launchReason?.(issue)||'',all=Boolean(props.view.all);
  const optionsEnabled=linkValid&&typeof onOptions==='function'&&!reason;
  const context=[issue.statusName,issue.identity.connectionId,issue.identity.site,issue.repoBinding.repoRoot,issue.repoBinding.machine||'This Mac'].join(' · ');
  const caption=all?(props.bindingLabel?.(issue.repoBinding)||repoCaption(issue)):issue.statusName;
  return v_flex().id(id).w_full().min_w(0).max_w(narrow?460:360).p(10).gap(7).rounded(6).bg(t.chrome).border(1).border_color(t.border).opacity(linkValid?1:0.6).tooltip(context)
    .child(h_flex().gap(8).items_center().child(issueLink(id+'-key',issue.key,issue,onOpenIssue,onInvalid,{linkValid})).child(div().flex_1())
      .when(Boolean(issue.priority),el=>el.child(div().max_w(90).truncate().text_size(10).text_color(t.muted).tooltip(issue.priority).child(issue.priority))))
    .child(issueLink(id+'-title',issue.title,issue,onOpenIssue,onInvalid,{title:true,linkValid}))
    .child(h_flex().gap(5).items_center().child(div().flex_1().min_w(0).text_size(10).text_color(t.dim).truncate().tooltip(context).child(linkValid?caption:'Issue unavailable'))
      .child(h_flex().gap(2).items_center().children(choices.quick.map(program=>programButton(mod,id+'-start-'+program.key,issue,program,onLaunch,onInvalid,reason,linkValid)))
        .child(iconButton(mod,id+'-options','more',reason||(choices.overflow.length?'Choose another agent or launch options':'Launch options'),capturedAction(issue,(captured,cx)=>onOptions(captured,cx),onInvalid),{disabled:!optionsEnabled,size:25}))));
}
function statusFilter(id,title,count,active,action,{disabled=false}={}){
  const t=colors();let el=h_flex().id(id).h(25).px(7).gap(5).rounded(4).items_center().text_size(11).text_color(disabled?t.dim:active?t.accent:t.muted).bg(active?t.selected:'#00000000').role('button').accessibility_label(title+' filter');
  if(!disabled)el=el.cursor_pointer().hover(s=>s.bg(t.hover)).on_mouse_down('left',(_e,cx)=>cx.stop_propagation()).on_click(action);
  return el.child(title).when(count!=='',node=>node.child(div().text_size(10).text_color(active?t.accent:t.dim).child(String(count))));
}
function age(value,now){const minutes=Math.max(0,Math.floor((now-value)/60000));return minutes===0?'just now':minutes<60?minutes+'m ago':Math.floor(minutes/60)+'h ago';}

/** A shared compact board for validated tracker Issue v1 snapshots. No source title is repeated. */
export function renderIssueBoard(options,cx){
  const props={id:'issue-board',...options},t=colors(),{id,mod,state,view}=props,data=view.data||[],narrow=(props.width??state.width)<768;
  const searched=groupIssues(data,{query:state.query,status:'all'}),filtered=groupIssues(data,state.filters()),visible=state.status==='all'?groups:groups.filter(g=>g.key===state.status),count=Object.values(filtered).reduce((n,rows)=>n+rows.length,0);
  const unavailable=!data.length&&['error','setup','unbound'].includes(view.state),loading=!data.length&&view.state==='loading',unknown=unavailable||loading;
  const choices=new Map();for(const issue of data){const key=JSON.stringify(issue.repoBinding.machine);if(!choices.has(key))choices.set(key,toolChoices(props.toolsForMachine?.(issue.repoBinding.machine)||[],props.preferences||{}));}
  const control=(name,callback)=>iconButton(mod,id+'-'+name,name,name==='refresh'?'Refresh issues':'Integration settings',(_e,eventCx)=>callback?.(undefined,eventCx),{disabled:typeof callback!=='function'||name==='refresh'&&Boolean(view.loading)});
  const scope=h_flex().gap(3).items_center().child(statusFilter(id+'-scope-this','This space','',!view.all,(_e,eventCx)=>{eventCx.stop_propagation();props.onScopeChange?.(false,eventCx);},{disabled:typeof props.onScopeChange!=='function'})).child(statusFilter(id+'-scope-all','All spaces','',Boolean(view.all),(_e,eventCx)=>{eventCx.stop_propagation();props.onScopeChange?.(true,eventCx);},{disabled:typeof props.onScopeChange!=='function'}));
  const search=searchInput(mod,id+'-search',state.search).flex_1().min_w(0),actions=h_flex().gap(3).items_center().child(control('refresh',props.onRefresh)).child(control('settings',props.onSetup));
  const toolbar=narrow?v_flex().gap(8).child(h_flex().items_center().child(scope).child(div().flex_1()).child(actions)).child(search):h_flex().gap(10).items_center().child(scope).child(search).child(actions);
  const filterButtons=[statusFilter(id+'-filter-all','All',unknown?'?':Object.values(searched).reduce((n,rows)=>n+rows.length,0),state.status==='all',(_e,eventCx)=>{eventCx.stop_propagation();state.selectStatus('all',eventCx);}),...groups.map(group=>statusFilter(id+'-filter-'+group.key,group.title,unknown?'?':searched[group.key].length,state.status===group.key,(_e,eventCx)=>{eventCx.stop_propagation();state.selectStatus(group.key,eventCx);}))];
  const filters=(props.width??state.width)<360?v_flex().id(id+'-filters-wrapped').gap(3).child(h_flex().gap(3).items_center().children(filterButtons.slice(0,2))).child(h_flex().gap(3).items_center().children(filterButtons.slice(2))):h_flex().gap(3).items_center().children(filterButtons).child(div().flex_1());
  const column=group=>{
    const rows=filtered[group.key],content=v_flex().id(id+'-cards-'+group.key).gap(8).min_w(0).children(rows.map(issue=>card(props,issue,choices.get(JSON.stringify(issue.repoBinding.machine)),narrow)))
      .when(!rows.length,el=>el.child(div().id(id+'-empty-'+group.key).p(13).rounded(5).border(1).border_color(t.border).text_size(11).text_color(t.dim).child(loading?'Loading issues…':unavailable?'Unavailable':state.query?'No matching issues':'No '+group.title.toLowerCase()+' issues')));
    return v_flex().id(id+'-column-'+group.key).min_w(narrow?0:220).max_w(narrow?460:360).gap(9).when(narrow,el=>el.w_full()).when(!narrow,el=>el.flex_1().h_full().min_h(0))
      .child(h_flex().gap(6).px(2).h(22).items_center().child(div().size(5).rounded_full().bg(t[group.color]||t.dim)).child(div().text_size(11).font_semibold().text_color(t.muted).child(group.title)).child(label(unknown?'?':String(rows.length),{muted:true,size:10})))
      .child(narrow?content:content.flex_1().min_h(0).overflow_y_scrollbar());
  };
  const body=narrow?v_flex().id(id+'-stacked').flex_1().min_h(0).overflow_y_scrollbar().gap(16).children(visible.map(column)):h_flex().id(id+'-columns').flex_1().min_h(0).items_start().overflow_x_scroll().gap(12).children(visible.map(column));
  const errors=view.errors||[],snapshotTimes=(view.bindings||[]).map(b=>b.snapshot?.fetchedAt).filter(Number.isFinite),fetchedAt=snapshotTimes.length?Math.min(...snapshotTimes):null;
  const footer=h_flex().gap(8).items_center().text_size(10).text_color(t.dim).child(div().flex_1().min_w(0).truncate().child(loading?'Loading':unavailable?'Source unavailable':String(count)+(state.query||state.status!=='all'?' / '+data.length:'')+' loaded'+(fetchedAt!==null?' · '+(errors.length?'Cached · ':'')+'Updated '+age(fetchedAt,props.now??Date.now()):'')))
    .when(Boolean(view.truncated),el=>el.child(label(view.limitReached?'Select a space to see more':'More results',{muted:true,size:10})))
    .when(Boolean(view.truncated&&!view.limitReached&&(view.bindings||[]).some(b=>b.snapshot?.cursor)),el=>el.child(textButton(id+'-load-more','Load more',(_e,eventCx)=>{eventCx.stop_propagation();props.onLoadMore?.(undefined,eventCx);},{disabled:Boolean(view.loading)||typeof props.onLoadMore!=='function'})));
  const errorBanner=errors.length?h_flex().id(id+'-error').gap(7).items_center().text_color(t.muted).child(icon(mod,'issue',13))
    .child(div().flex_1().min_w(0).truncate().text_size(11).tooltip(errors.map(e=>e.error?.message||'Source unavailable').join('\n')).child(errors[0].error?.message||'Source unavailable'))
    .when(errors.length>1,row=>row.child(label('+'+(errors.length-1),{muted:true,size:10})))
    .when(typeof props.onSetup==='function',row=>row.child(iconButton(mod,id+'-error-settings','settings','Check this connection',(_e,eventCx)=>props.onSetup(errors[0].binding?copy(errors[0].binding):undefined,eventCx),{size:25}))):null;
  const setupBanner=view.state==='setup'||view.state==='unbound'?h_flex().id(id+'-connect').gap(8).p(10).items_center().rounded(5).border(1).border_color(t.border)
    .child(div().flex_1().min_w(0).text_size(11).text_color(t.muted).child(view.state==='unbound'?'Choose a repository space.':'Connect this space to its project.'))
    .when(typeof props.onSetup==='function',row=>row.child(textButton(id+'-connect-action','Set up',(_e,eventCx)=>{eventCx.stop_propagation();props.onSetup(undefined,eventCx);} ))):null;
  return v_flex().id(id).size_full().min_w(0).min_h(0).p(narrow?10:14).gap(10).bg(t.surface).text_size(12)
    .on_size_change((size,eventCx)=>{if(state.width!==size.width){state.width=size.width;eventCx.notify();}})
    .child(toolbar).child(filters).when(Boolean(errorBanner),el=>el.child(errorBanner)).when(Boolean(setupBanner),el=>el.child(setupBanner)).child(body).child(footer);
}
