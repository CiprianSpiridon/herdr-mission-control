/**
 * Mission Control · Mods. Lists the mods and layouts installed in this Herdr, shows which have a newer version on
 * GitHub, updates them after a review, and disables, enables, uninstalls and restores them. Every file operation
 * runs in the Node helper (backend.mjs) through exec; this view only describes the UI.
 * Roles (props): {hideHeader?: true} inside the Mission Control layouts; standalone otherwise.
 */
import {View,div,image} from 'gpui-kit';
import {v_flex,h_flex} from 'gpui-base';
import * as herdr from 'herdr';
import {colors,label,icon,iconButton,textButton,sectionHeader,emptyState,createSearch,searchInput} from '../../shared/ui.js';

export const MOD='mission-control-mods';
export const FILTERS=Object.freeze([['all','All'],['updates','Updates'],['mods','Mods'],['layouts','Layouts'],['disabled','Disabled'],['builtin','Built in']]);
export const STATE_LABEL=Object.freeze({current:'Up to date',edited:'Edited by you',update:'Update available',conflict:'Conflict',ambiguous:'Choose its source',untracked:'Source unknown',
  pending:'Checking…','too-large':'Too large to check',unreachable:'Source unreachable',disabled:'Disabled',builtin:'Built into Herdr',clone:'Your own copy',installer:'Managed by the installer',self:'This manager',unknown:'Not checked yet'});
const MAX_PASSES=5;
const ago=ms=>{if(!ms)return 'never';const s=Math.max(0,Math.round((Date.now()-ms)/1000));return s<60?'just now':s<3600?`${Math.round(s/60)} min ago`:s<86400?`${Math.round(s/3600)} h ago`:`${Math.round(s/86400)} d ago`;};

/** Which actions a row offers, by its state (exported for tests). */
export function actionsFor(item){
  if(['builtin','installer','self','clone'].includes(item.state))return [];
  if(item.state==='disabled')return ['enable','uninstall'];
  const base=['disable','uninstall'];
  if(item.state==='update')return ['update',...base];
  if(item.state==='ambiguous')return ['choose',...base];
  if(item.state==='untracked')return ['link',...base];
  return base;
}
export function matches(item,filter,query){
  const q=(query||'').trim().toLowerCase(),text=[item.name,item.title,item.source?.fullName].filter(Boolean).join(' ').toLowerCase();
  if(q&&!text.includes(q))return false;
  if(filter==='updates')return item.state==='update';
  if(filter==='mods')return item.kind==='mod'&&!['builtin','disabled'].includes(item.state);
  if(filter==='layouts')return item.kind==='layout'&&!['builtin','disabled'].includes(item.state);
  if(filter==='disabled')return item.state==='disabled';
  if(filter==='builtin')return item.state==='builtin';
  return true;
}

export default class MissionControlMods extends View {
  init(props,cx){
    this.props=herdr.props()||props||{};this.hideHeader=this.props.hideHeader===true;this.closed=false;this.jobs=[];
    Object.assign(this,{list:[],removed:[],busy:null,error:null,info:null,filter:'all',query:'',review:null,confirm:null,linkFor:null,checkedAt:null,collapsed:{builtin:true}});
    this.search=createSearch('Search mods and layouts',value=>{this.query=value;});
    this.linkInput=createSearch('Paste a github.com repository or folder link',()=>{});
    // Recover any interrupted change first, then list and check (the helper caches; checks are cheap when nothing moved).
    this.run(cx,'Loading…',async()=>{await this.call({op:'recover'});await this.load('inventory');await this.load('check');});
    this.timer=cx.timer.every(3600000,timerCx=>this.run(timerCx,null,()=>this.load('check')));
  }
  appHome(){return herdr.appHome();}
  activeLayout(){try{return herdr.shared('layout')||null;}catch{return null;}}
  async call(request){
    const home=this.appHome(),result=await herdr.exec('node',[home+'/mods/'+MOD+'/backend.mjs',JSON.stringify({appHome:home,activeLayout:this.activeLayout(),...request})],{cwd:home});
    let out;try{out=JSON.parse(result.stdout);}catch{throw Object.assign(Error('The Mods helper did not answer. Node.js 22 and git are required.'),{code:'HELPER'});}
    if(!out.ok)throw Object.assign(Error(out.message||'The Mods helper refused that.'),{code:out.code,detail:out.detail});
    return out;
  }
  async load(op){
    let out=await this.call({op});
    for(let pass=1;out.partial&&pass<MAX_PASSES&&!this.closed;pass++)out=await this.call({op});
    this.list=out.list||[];this.removed=out.removed||[];if(op==='check')this.checkedAt=out.checkedAt||Date.now();
    if(out.partial)this.info='Some sources are still being fetched; check again in a moment.';
  }
  run(cx,busy,work){
    this.busy=busy;this.error=null;
    const job=cx.spawn(async taskCx=>{try{await work(taskCx);}catch(error){this.error=error.message;}finally{this.busy=null;if(!this.closed)taskCx.notify();}});
    this.jobs.push(job);if(this.jobs.length>16)this.jobs=this.jobs.filter(j=>!j?.is_done?.());
  }
  item(key){return this.list.find(i=>i.key===key);}

  // Actions -----------------------------------------------------------------------------------------------
  update(key,cx,resolutions){this.info=null;this.run(cx,'Preparing the update…',async()=>{const out=await this.call({op:'prepare',key,resolutions:resolutions||{}});this.review={key,resolutions:resolutions||{},...out.prepared};});}
  apply(cx){const key=this.review?.key;this.run(cx,'Applying…',async()=>{await this.call({op:'commit',key});this.review=null;this.info=`${this.item(key)?.name||'Item'} updated.`;await this.load('inventory');await this.load('check');});}
  resolveAll(cx,choice){const r=this.review;if(!r)return;const resolutions={...r.resolutions};for(const c of r.conflicts||[])resolutions[c.file]=choice;this.update(r.key,cx,resolutions);}
  openConflicts(){if(this.review?.conflictDir)herdr.exec('open',[this.review.conflictDir]).catch(()=>{});}
  updateAll(cx){
    this.run(cx,'Updating…',async()=>{
      const done=[],skipped=[];
      for(const item of this.list.filter(i=>i.state==='update')){
        try{
          const p=(await this.call({op:'prepare',key:item.key})).prepared,a=p.review?.access;
          const risky=!p.ok||a?.hosts?.length||a?.programs?.length||a?.files||p.review?.keys?.clash?.length;
          if(risky){skipped.push(item.name);continue;}
          await this.call({op:'commit',key:item.key});done.push(item.name);
        }catch{skipped.push(item.name);}
      }
      await this.load('inventory');await this.load('check');
      this.info=`${done.length} updated${skipped.length?`; ${skipped.join(', ')} need${skipped.length===1?'s':''} a review`:''}.`;
    });
  }
  lifecycle(op,key,cx,{confirm=false}={}){
    this.run(cx,null,async()=>{
      const out=await this.call({op,key,confirm});
      if(out.result?.needsConfirm){this.confirm={op,key,layouts:out.result.layouts};return;}
      this.confirm=null;await this.load('inventory');
      this.info=op==='uninstall'?`${this.item(key)?.name||key.split(':')[1]} removed. It can be restored for 30 days, then it is deleted.`:null;
    });
  }
  restore(id,cx){this.run(cx,null,async()=>{await this.call({op:'restore',id});await this.load('inventory');});}
  link(key,cx,url){this.run(cx,'Linking…',async()=>{await this.call({op:'link',key,url:url??this.linkInput.value()});this.linkFor=null;await this.load('inventory');await this.load('check');});}

  // Rendering ---------------------------------------------------------------------------------------------
  render(){
    const t=colors();
    let root=v_flex().id('mc-mods').size_full().min_w(0).bg(t.chrome).text_color(t.foreground);
    if(!this.hideHeader)root=root.child(h_flex().h(34).px(10).gap(8).items_center().border_b(1).border_color(t.border).child(icon(MOD,'layout',15).text_color(t.muted)).child(label('Mods and layouts')));
    root=root.child(this.toolbar(t));
    if(this.busy||this.error||this.info)root=root.child(div().id('mods-status').px(10).py(4).text_size(11).text_color(this.error?t.blocked:t.muted).child(this.error||this.busy||this.info));
    return root.child(this.review?this.reviewView(t):this.listView(t));
  }
  toolbar(t){
    const updates=this.list.filter(i=>i.state==='update').length;
    const chips=FILTERS.map(([id,name])=>h_flex().id('mods-filter-'+id).h(24).px(8).items_center().rounded(5).text_size(11).cursor_pointer()
      .bg(this.filter===id?t.selected:'#00000000').text_color(this.filter===id?t.accent:t.muted).role('tab').accessibility_label(name)
      .on_click((_e,cx)=>{this.filter=id;cx.notify();}).child(id==='updates'&&updates?`${name} ${updates}`:name));
    return v_flex().id('mods-toolbar').px(10).py(8).gap(6).border_b(1).border_color(t.border)
      .child(h_flex().gap(6).items_center().child(div().flex_1().min_w(0).child(searchInput(MOD,'mods-search',this.search)))
        .child(iconButton(MOD,'mods-check','refresh',`Check for updates (last checked ${ago(this.checkedAt)})`,(_e,cx)=>this.run(cx,'Checking…',()=>this.load('check')),{disabled:Boolean(this.busy)}))
        .when(updates>0,el=>el.child(textButton('mods-update-all',`Update all (${updates})`,(_e,cx)=>this.updateAll(cx),{primary:true,disabled:Boolean(this.busy)}))))
      .child(h_flex().gap(2).items_center().children(chips).child(div().flex_1()).child(div().text_size(10).text_color(t.dim).child(`Checked ${ago(this.checkedAt)}`)));
  }
  listView(t){
    const visible=this.list.filter(i=>matches(i,this.filter,this.query));
    const groups=[['updates','Updates',visible.filter(i=>i.state==='update')],['layouts','Layouts',visible.filter(i=>i.kind==='layout'&&!['update','disabled','builtin'].includes(i.state))],
      ['mods','Mods',visible.filter(i=>i.kind==='mod'&&!['update','disabled','builtin'].includes(i.state))],['disabled','Disabled',visible.filter(i=>i.state==='disabled')],['builtin','Built into Herdr',visible.filter(i=>i.state==='builtin')]];
    let body=v_flex().id('mods-list').flex_1().min_h(0).overflow_y_scroll().gap(2).pb(12);
    if(!this.list.length&&!this.busy)return body.child(emptyState(MOD,'layout','Nothing listed yet','Check again once the helper can run (Node.js 22 and git).'));
    for(const [id,title,items]of groups){
      if(!items.length)continue;const collapsed=Boolean(this.collapsed[id]);
      body=body.child(sectionHeader(MOD,'mods-section-'+id,title,items.length,{collapsed,toggle:(_e,cx)=>{this.collapsed[id]=!collapsed;cx.notify();}}));
      if(!collapsed)body=body.children(items.map(item=>this.row(item,t)));
    }
    if(this.removed.length&&this.filter==='all')body=body.child(sectionHeader(MOD,'mods-section-removed','Removed (restorable for 30 days)',this.removed.length,{toggle:()=>{}}))
      .children(this.removed.map(r=>h_flex().id('removed-'+r.id).px(12).py(6).gap(8).items_center().child(label(`${r.name} (${r.kind})`)).child(div().flex_1())
        .child(div().text_size(10).text_color(t.dim).child(`deleted ${new Date(r.restoreUntil).toLocaleDateString()}`)).child(textButton('restore-'+r.id,'Restore',(_e,cx)=>this.restore(r.id,cx)).accessibility_label(`Restore ${r.name}`))));
    return body;
  }
  row(item,t){
    const thumb=item.preview?image(item.preview).w(48).h(30).rounded(4).flex_none():div().w(48).h(30).flex_none().flex().items_center().justify_center().rounded(4).bg(t.surface).child(icon(MOD,item.kind==='layout'?'layout':'panel',14).text_color(t.dim));
    const tone=item.state==='update'?t.accent:['conflict','unreachable','too-large'].includes(item.state)?t.blocked:item.state==='edited'?t.working||t.accent:t.dim;
    const sourceText=item.source?[item.source.fullName,item.source.path].filter(Boolean).join(' · '):item.installerPackage?`installed with ${item.installerPackage}`:null;
    const detail=item.state==='update'&&item.update?`${item.update.subject} · ${item.update.changed+item.update.added+item.update.removed} files · ${ago(item.update.time)}`:item.reason;
    // Every row has the same button words, so each button names its item for assistive technology.
    const named=item.title||item.name,rowButton=(id,text,verb,action,options)=>textButton(id,text,action,options).accessibility_label(`${verb} ${named}`);
    const buttons=actionsFor(item).map(action=>{
      if(action==='update')return rowButton('update-'+item.key,'Update…','Update',(_e,cx)=>this.update(item.key,cx),{primary:true});
      if(action==='disable')return rowButton('disable-'+item.key,'Disable','Disable',(_e,cx)=>this.lifecycle('disable',item.key,cx));
      if(action==='enable')return rowButton('enable-'+item.key,'Enable','Enable',(_e,cx)=>this.lifecycle('enable',item.key,cx));
      if(action==='uninstall')return rowButton('uninstall-'+item.key,'Uninstall','Uninstall',(_e,cx)=>{this.confirm={op:'uninstall',key:item.key,layouts:item.usedBy||[]};cx.notify();});
      if(action==='link')return rowButton('link-'+item.key,'Link source…','Link a source for',(_e,cx)=>{this.linkFor=item.key;cx.notify();});
      return rowButton('choose-'+item.key,'Choose source…','Choose the source of',(_e,cx)=>{this.linkFor=item.key;cx.notify();});
    });
    let row=v_flex().id('row-'+item.key).px(10).py(6).gap(4)
      .child(h_flex().gap(10).items_center().child(thumb)
        .child(v_flex().flex_1().min_w(0).gap(1).child(label(item.title||item.name)).when(Boolean(sourceText),el=>el.child(label(sourceText,{muted:true,size:10}))))
        .child(div().id('state-'+item.key).text_size(10).text_color(tone).flex_none().tooltip(detail||STATE_LABEL[item.state]||item.state).child(STATE_LABEL[item.state]||item.state))
        .child(h_flex().gap(4).flex_none().children(buttons)));
    if(detail)row=row.child(div().pl(58).text_size(10).text_color(t.dim).truncate().child(detail));
    if(this.confirm?.key===item.key)row=row.child(this.confirmView(item,t));
    if(this.linkFor===item.key)row=row.child(this.linkView(item,t));
    return row;
  }
  confirmView(item,t){
    const c=this.confirm,uses=c.layouts?.length?`Used by ${c.layouts.join(', ')}. `:'',text=c.op==='uninstall'?`${uses}Remove ${item.name}? It can be restored for 30 days, then it is deleted.`:`${uses}Disable ${item.name} anyway?`;
    return h_flex().id('confirm-'+item.key).pl(58).gap(6).items_center().child(div().flex_1().text_size(11).text_color(t.muted).child(text))
      .child(textButton('confirm-yes-'+item.key,c.op==='uninstall'?'Remove':'Disable',(_e,cx)=>this.lifecycle(c.op,item.key,cx,{confirm:true}),{primary:true}).accessibility_label(`Confirm: ${c.op==='uninstall'?'remove':'disable'} ${item.title||item.name}`))
      .child(textButton('confirm-no-'+item.key,'Cancel',(_e,cx)=>{this.confirm=null;cx.notify();}).accessibility_label(`Cancel: keep ${item.title||item.name}`));
  }
  linkView(item,t){
    let box=v_flex().id('link-'+item.key).pl(58).gap(6);
    for(const c of item.candidates||[])box=box.child(textButton(`candidate-${item.key}-${c.fullName}`,`${c.fullName}${c.path?' · '+c.path:''}${c.exact?' (exact)':''}`,(_e,cx)=>this.link(item.key,cx,`${c.url}/tree/${c.defaultBranch||'main'}${c.path?'/'+c.path:''}`)));
    return box.child(h_flex().gap(6).items_center().child(div().flex_1().min_w(0).child(searchInput(MOD,'link-input-'+item.key,this.linkInput)))
      .child(textButton('link-go-'+item.key,'Link',(_e,cx)=>this.link(item.key,cx),{primary:true})).child(textButton('link-cancel-'+item.key,'Cancel',(_e,cx)=>{this.linkFor=null;cx.notify();})));
  }
  reviewView(t){
    const r=this.review,item=this.item(r.key)||{name:r.key},rv=r.review||{},a=rv.access||{},k=rv.keys;
    const lines=(title,list,tone=t.muted)=>list?.length?[div().pt(6).text_size(11).text_color(t.dim).child(title),...list.map((x,i)=>div().id(`${title}-${i}`).pl(8).text_size(11).text_color(tone).truncate().child(typeof x==='string'?x:x.key?`${x.section} ${x.key} → ${x.action}${x.current?` (you use it for ${x.current})`:''}`:x.file))]:[];
    let body=v_flex().id('mods-review').flex_1().min_h(0).overflow_y_scroll().p(12).gap(2)
      .child(label(`Update ${item.title||item.name}`)).child(div().text_size(11).text_color(t.muted).child(rv.subject?`${rv.subject} · ${ago(rv.time)}`:''));
    if(r.state==='conflict'){
      body=body.child(div().pt(8).text_size(12).text_color(t.blocked).child('Your edits and the update change the same lines. Nothing was written.'))
        .children(lines('Conflicting files',(r.conflicts||[]).map(c=>c.binary?`${c.file} (binary)`:c.file),t.blocked))
        .child(h_flex().pt(10).gap(6).child(textButton('conflict-mine','Keep mine',(_e,cx)=>this.resolveAll(cx,'mine'))).child(textButton('conflict-theirs','Take theirs',(_e,cx)=>this.resolveAll(cx,'theirs')))
          .child(textButton('conflict-open','Open the merged files',()=>this.openConflicts())).child(textButton('review-cancel','Cancel',(_e,cx)=>{this.review=null;cx.notify();})));
      return body;
    }
    const access=[...(a.hosts||[]).map(h=>`reaches ${h}`),...(a.programs||[]).map(p=>`runs ${p}`),...(a.files?['reads or writes files outside its folder']:[])];
    return body.children(lines('Changed or added',rv.changed)).children(lines('Removed',rv.removed)).children(lines('Kept (you edited them; removed upstream)',rv.keptEdited))
      .children(lines('New access',access,t.blocked)).children(lines('Keys added',k?.add)).children(lines('Keys removed',k?.remove)).children(lines('Keys left as you set them',k?.clash,t.blocked))
      .child(h_flex().pt(12).gap(6).child(textButton('review-apply','Apply update',(_e,cx)=>this.apply(cx),{primary:true,disabled:Boolean(this.busy)})).child(textButton('review-cancel','Cancel',(_e,cx)=>{this.review=null;cx.notify();})));
  }
  close(){this.closed=true;this.timer?.cancel?.();for(const job of this.jobs)job?.cancel?.();}
}
