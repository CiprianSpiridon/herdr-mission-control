import {View,div} from 'gpui-kit';
import {v_flex,h_flex,InputState,Input} from 'gpui-base';
import * as herdr from 'herdr';
import {buildAgentModel} from './model.js';
import {TelemetryBridge} from '../../shared/telemetry.js';
import {NameOwnership} from '../../shared/name-ownership.js';
import {usageSourceFingerprint,validateUsageSource} from '../../shared/usage-sources.js';
import {colors,label,iconButton,textButton,toolIcon,sectionHeader,statusDot,createSearch,searchInput} from '../../shared/ui.js';

const MOD='mission-control-agents',STATE='mission-control-agents-v1',clone=value=>JSON.parse(JSON.stringify(value));
const state=()=>{const value=herdr.shared(STATE)||{};return {v:1,collapsed:Boolean(value.collapsed),mode:value.mode==='spaces'?'spaces':'priority',query:typeof value.query==='string'?value.query:''};};
const edit=fn=>{const next=state();fn(next);herdr.setShared(STATE,next);};
const providerName=key=>({claude:'Claude Code',codex:'Codex',grok:'Grok'}[key]||key);

export default class MissionControlAgents extends View{
  init(_props,cx){
    this.props=herdr.props()||{};this.role=this.props.view||'list';this.closed=false;this.busy=false;this.error=null;this.timers=[];this.jobs=[];this.names=null;this.telemetry=new TelemetryBridge(MOD,herdr);this.ownership=new NameOwnership(this.telemetry.io);this.inputs=[];
    if(this.role==='source-form'){
      try{this.form=validateUsageSource(this.props.source);}catch{this.role='unavailable';this.error='This usage source is unavailable. Reopen source settings.';return;}
      this.formId=this.props.sourceId;this.expected=this.props.fresh?null:usageSourceFingerprint(this.form);
      this.profile=this.input(this.props.fresh?'':this.form.credentialScope,'Profile name');this.providerRoot=this.input(this.form.providerRoot,'Absolute provider root');this.rootInputs=this.form.roots.map(value=>this.input(value,'Absolute session metadata root'));this.cacheInputs=(this.form.cacheRoots||[]).map(value=>this.input(value,'Explicit sanitized cache root'));
      this.spawn(cx,async()=>this.telemetry.sources.refresh());return;
    }
    if(this.role==='sources'){
      this.loading=true;this.spawn(cx,async()=>{try{await this.telemetry.sources.refresh();}finally{this.loading=false;}});
      this.spawn(cx,async()=>this.telemetry.initializeSources());
      this.timers.push(cx.timer.every(2000,cx=>this.pollSources(cx)));return;
    }
    this.search=createSearch('Find an agent',value=>edit(s=>{s.query=value;}));this.search.set_value(state().query);this.inputs.push(this.search);
    this.busy=true;this.spawn(cx,async()=>{try{await this.telemetry.sources.refresh();await this.refreshData();}finally{this.busy=false;}});
    this.spawn(cx,async()=>{await this.telemetry.initializeSources();if(!this.closed)await this.refreshData();});
    this.timers.push(cx.timer.every(30000,cx=>this.refresh(cx)));
    this.timers.push(cx.timer.every(2000,cx=>this.pollSources(cx)));
  }
  input(value,placeholder){const input=InputState.new({placeholder});input.set_value(value);input.on('change',(_e,cx)=>cx.notify());this.inputs.push(input);return input;}
  spawn(cx,work){this.jobs=this.jobs.filter(job=>!job?.is_done?.());const task=cx.spawn(async(cx)=>{try{await work();}catch{this.error='Usage sources or session readings are unavailable. Open source settings to inspect the configured paths.';}if(!this.closed)cx.notify();});this.jobs.push(task);return task;}
  pollSources(cx){if(this.closed||this.polling)return;this.polling=true;return this.spawn(cx,async()=>{try{await this.telemetry.sources.refresh();}finally{this.polling=false;}});}
  async refreshData(){
    if(this.closed)return;
    try{this.names=(await this.ownership.read()).value;}catch{this.names=null;}
    const all=this.model({query:''});await this.telemetry.refresh(all.rows.map(row=>({...row,address:row.address,space:row.space})));
  }
  refresh(cx){if(this.closed||this.busy)return;this.busy=true;return this.spawn(cx,async()=>{try{await this.refreshData();}finally{this.busy=false;}});}
  model(overrides={}){
    const s={...state(),...overrides},agents=herdr.agents();return buildAgentModel({agents,terminals:herdr.terminals(),spaces:herdr.spaces(),mode:s.mode,query:s.query,names:this.names,readings:this.telemetry.readings([...agents,...this.extraAgents()])});
  }
  extraAgents(){
    // Models supply the parent space for pane-less children; only their own
    // exact telemetry binding can produce numbers, never the parent's values.
    return buildAgentModel({agents:herdr.agents(),terminals:herdr.terminals(),spaces:herdr.spaces()}).rows.filter(r=>!r.native);
  }
  openSources(){herdr.openOverlay({mod:MOD,kind:'dialog',width:720,height:660,props:{view:'sources'}});}
  openForm(id,source,{fresh=false}={}){herdr.openOverlay({mod:MOD,kind:'dialog',width:720,height:660,props:{view:'source-form',sourceId:fresh?'custom-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2):id,source:clone(source),fresh}});}
  closeOverlay(){if(this.props.overlay)herdr.closeOverlay(this.props.overlay);}
  field(id,title,input){const t=colors();return v_flex().gap(5).child(label(title,{muted:true,size:11})).child(Input.new(input).id(id).h(31).px(8).bg(t.chrome).border(1).border_color(t.border).rounded(5).text_size(12).text_color(t.foreground));}
  sourceHeader(title){return h_flex().gap(8).items_center().child(label(title,{size:15})).child(div().flex_1()).child(iconButton(MOD,'close-source-settings','close','Close',()=>this.closeOverlay()));}
  toggleSource(id,source,cx){
    if(this.busy)return;this.busy=true;this.error=null;
    return this.spawn(cx,async()=>{try{await this.telemetry.sources.save(id,{...source,enabled:!source.enabled},{expectedFingerprint:usageSourceFingerprint(source)});}catch(error){this.error=error.code==='SOURCE_CONFLICT'?error.message:'This usage source could not be saved. The original settings were preserved.';}finally{this.busy=false;}});
  }
  sourceList(){
    const t=colors(),sources=[...this.telemetry.sources.sources].map(([id,source])=>({id,...source}));
    return v_flex().id('usage-sources').size_full().p(18).gap(12).bg(t.surface).text_size(12)
      .child(this.sourceHeader('Usage sources')).child(div().text_size(11).text_color(t.muted).child('Read-only session metadata on each machine. Paths are shown below.'))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().gap(8).children(sources.map(source=>v_flex().id('source-'+source.id).p(10).gap(6).border(1).border_color(t.border).rounded(6)
        .child(h_flex().gap(8).items_center().child(label(providerName(source.provider))).child(label(source.machine||'This Mac',{muted:true,size:10})).child(div().flex_1()).child(textButton('source-toggle-'+source.id,source.enabled?'Enabled':'Disabled',(_e,cx)=>this.toggleSource(source.id,source,cx),{disabled:this.busy})).child(iconButton(MOD,'source-edit-'+source.id,'settings','Edit source',()=>this.openForm(source.id,source))).child(iconButton(MOD,'source-copy-'+source.id,'plus','Add profile on this machine',()=>this.openForm(source.id,source,{fresh:true}))))
        .child(label('Profile: '+source.credentialScope,{muted:true,size:10}))
        .children([...source.roots,...(source.cacheRoots||[])].map(root=>div().text_size(10).text_color(t.dim).truncate().tooltip(root).child(root)))))
        .when(!sources.length,e=>e.child(div().p(12).text_color(t.muted).child(this.loading?'Discovering metadata sources…':'No supported metadata sources were found on the connected machines.')))
        .children([...this.telemetry.sourceErrors].map(([machine,message])=>div().text_color(t.muted).child((JSON.parse(machine)||'This Mac')+': '+message))))
      .when(Boolean(this.error),e=>e.child(div().text_size(11).text_color(t.blocked).child(this.error)))
      .child(div().text_size(10).text_color(t.dim).child('Changing or disabling a source clears its readings until that session is identified again.'));
  }
  pathRows(title,kind,inputs){
    const t=colors();return v_flex().gap(6).child(h_flex().gap(8).items_center().child(label(title,{muted:true,size:11})).child(div().flex_1()).child(iconButton(MOD,'add-'+kind,'plus','Add '+title.toLowerCase(),(_e,cx)=>{if(inputs.length>=(kind==='cache'?4:8))return;inputs.push(this.input('','Absolute metadata directory'));cx.notify();})))
      .children(inputs.map((input,index)=>h_flex().gap(6).items_center().child(div().flex_1().child(Input.new(input).id(kind+'-'+index).h(31).px(8).border(1).border_color(t.border).rounded(5).bg(t.chrome).text_size(11).text_color(t.foreground))).child(iconButton(MOD,'remove-'+kind+'-'+index,'close','Remove path',(_e,cx)=>{inputs.splice(index,1);this.inputs=this.inputs.filter(value=>value!==input);input.release();cx.notify();},{disabled:kind==='roots'&&inputs.length===1}))));
  }
  saveSource(cx){
    if(this.busy)return;this.busy=true;this.error=null;
    const next={...this.form,credentialScope:this.profile.value().trim(),providerRoot:this.providerRoot.value(),roots:this.rootInputs.map(v=>v.value()),cacheRoots:this.cacheInputs.map(v=>v.value())};
    return this.spawn(cx,async()=>{try{await this.telemetry.sources.save(this.formId,next,{expectedFingerprint:this.expected});this.closeOverlay();}catch(error){this.error=error.code?error.message:'The source could not be saved. The original settings were preserved.';}finally{this.busy=false;}});
  }
  sourceForm(){const t=colors();return v_flex().id('usage-source-form').size_full().p(18).gap(12).bg(t.surface).text_size(12)
    .child(this.sourceHeader(this.props.fresh?'Add metadata profile':'Edit usage source')).child(label(providerName(this.form.provider)+' · '+(this.form.machine||'This Mac'),{muted:true,size:11}))
    .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().gap(13).child(this.field('source-profile','Profile name',this.profile)).child(this.field('source-provider-root','Provider root',this.providerRoot)).child(this.pathRows('Session roots','roots',this.rootInputs)).child(this.pathRows('Sanitized cache roots (optional)','cache',this.cacheInputs)))
    .when(Boolean(this.error),e=>e.child(div().text_size(11).text_color(t.blocked).child(this.error))).child(textButton('save-usage-source',this.busy?'Saving…':'Save source',(_e,cx)=>this.saveSource(cx),{primary:true,disabled:this.busy}));}
  reading(labelText,value){const t=colors(),available=value.state==='available'&&Number.isFinite(value.percent),text=available?(value.estimated?'~':'')+Math.round(value.percent)+'%':value.state==='stale'?'Stale':'Unavailable';return h_flex().flex_1().min_w(0).gap(4).items_center().text_size(9).tooltip(value.scope||value.reason).child(div().text_color(t.dim).child(labelText)).child(div().truncate().text_color(available&&value.percent<15?t.blocked:t.muted).child(text));}
  row(row){
    const t=colors(),active=row.focused||herdr.focused()?.agent===row.address;
    let element=v_flex().id('agent-'+row.address).pl(7+Math.min(row.depth,4)*10).pr(7).py(6).gap(3).rounded(5).bg(active?t.selected:'#00000000').tooltip(row.title+' · '+row.spaceName+' · '+(row.machine||'This Mac')).role('button').accessibility_label(row.title);
    if(row.focus)element=element.cursor_pointer().hover(s=>s.bg(t.hover)).on_click(()=>herdr.run(row.focus.command,row.focus.args));
    return element.child(h_flex().h(17).gap(7).items_center().child(toolIcon(MOD,row.program,15)).child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(row.title)).child(statusDot(row.status)))
      .child(h_flex().h(13).gap(7).items_center().child(div().w(15)).child(div().flex_1().min_w(0).text_size(9).text_color(t.dim).truncate().child(row.spaceName+(row.machine?' · '+row.machine:''))))
      .child(h_flex().h(14).gap(8).items_center().child(this.reading(row.depth?'Ctx':'Context',row.context)).child(this.reading('Quota',row.quota)));
  }
  render(cx){
    if(this.role==='unavailable')return v_flex().size_full().p(18).gap(12).bg(colors().surface).child(this.sourceHeader('Usage source unavailable')).child(label(this.error,{muted:true}));
    if(this.role==='sources')return this.sourceList();if(this.role==='source-form')return this.sourceForm();
    const t=colors(),s=state(),model=this.model();herdr.setAgentOrder(model.navigation);
    return v_flex().id('agents-list').size_full().min_h(0).bg(t.chrome).text_size(12)
      .child(sectionHeader(MOD,'agents','Agents',model.count,{collapsed:s.collapsed,toggle:()=>edit(s=>{s.collapsed=!s.collapsed;}),actions:[iconButton(MOD,'agents-priority','priority','Priority',()=>edit(s=>{s.mode='priority';}),{active:s.mode==='priority',size:24}),iconButton(MOD,'agents-spaces','spaces','Group by space',()=>edit(s=>{s.mode='spaces';}),{active:s.mode==='spaces',size:24}),iconButton(MOD,'agents-sources','settings','Usage sources',()=>this.openSources(),{size:24})]}))
      .when(!s.collapsed,e=>e.child(div().px(10).pb(6).child(searchInput(MOD,'agent-search',this.search)))
        .child(v_flex().id('agent-groups').flex_1().min_h(0).px(7).pb(7).gap(5).overflow_y_scrollbar().children(model.groups.map(group=>v_flex().gap(1)
          .child(h_flex().h(23).px(4).gap(6).items_center().child(label(group.label,{muted:true,size:10})).when(Boolean(group.machine),e=>e.child(label(group.machine,{muted:true,size:9}))))
          .children(group.rows.map(row=>this.row(row))))))
        .when(!model.rows.length,e=>e.child(div().p(12).text_size(11).text_color(t.dim).child(model.count?'No matching agents.':'No agents running.'))));
  }
  close(){this.closed=true;for(const timer of this.timers)timer?.cancel?.();for(const job of this.jobs)job?.cancel?.();this.telemetry.close();for(const input of this.inputs)input.release();}
}
