import {div} from 'gpui-kit';
import {v_flex,h_flex,Input,InputState} from 'gpui-base';
import {readConfig} from './config.js';
import {newIntent,machineIdentity} from './session-identity.js';
import {resolveSpaceRepo,launchTarget} from './space-repo.js';
import {toolChoices,validateLaunchPreferences,saveLaunchPreferences} from './launch-preferences.js';
import {launch,createLaunchIO} from './launch.js';
import {colors,label,iconButton,textButton,toolIcon,createSearch,searchInput,emptyState} from './ui.js';

export function openLaunchDialog(mod,herdr,{spaceId,machine=null,source,target,toolKey,view='launch'}={}){
  return herdr.openOverlay({mod,kind:'dialog',width:560,height:660,props:{view,spaceId,machine,source,target,toolKey}});
}
export async function quickStart({target,source,toolKey},io){
  try{
    const config=(await readConfig(io)).value,p=validateLaunchPreferences(config.preferences.launch),tools=await io.knownAgents({on:target.machine});
    if(!toolChoices(tools,p).quick.some(t=>t.key===toolKey))return {ok:false,code:'SHORTCUT_UNAVAILABLE',message:'This shortcut is no longer pinned and installed on the destination machine.'};
    return launch({...newIntent(),...target,toolKey,source,worktree:p.worktree,...(p.tools[toolKey]||{})},io);
  }catch(e){return {ok:false,code:e.code||'LAUNCH_SETTINGS',message:e.code?e.message:'Agent shortcuts could not be loaded.'};}
}

/** A native controller compiled into its owning mod; never opens a sibling mod. */
export class LaunchDialog {
  constructor(mod,props,herdr){
    this.mod=mod;this.props={...props};this.herdr=herdr;this.io=herdr.capabilities?herdr:createLaunchIO(herdr);this.view=props.view||'menu';this.intent=newIntent();this.loading=true;this.busy=false;this.error=null;this.tools=[];this.preferences=validateLaunchPreferences();this.query='';this.selected=null;this.caps=null;this.target=null;this.worktree=true;this.generation=0;
  }
  init(cx){
    // Opening an overlay takes focus. Capture the originating live pane before
    // focusing its controls or awaiting config/discovery, rather than choosing
    // another checkout after every terminal has become unfocused.
    const focused=this.herdr.focused?.(),spaceId=this.props.spaceId??focused?.space;
    const capturedSpace=this.io.spaces().find(s=>s.id===spaceId&&(this.props.machine===undefined||machineIdentity(s.machine)===machineIdentity(this.props.machine)));
    this.capturedSpace=capturedSpace?{...capturedSpace,tabs:capturedSpace.tabs.map(t=>({...t}))}:null;
    this.capturedPanes=this.herdr.panes().map(p=>({...p,focused:p.focused||p.pane===focused?.pane}));
    this.focus=cx.focus_handle();this.search=createSearch('Find an installed agent',(value)=>{this.query=value;});
    this.search.on('focus',()=>{this.typingSearch=true;});this.search.on('blur',()=>{this.typingSearch=false;});
    this.model=InputState.new({placeholder:'Tool default'});this.reasoning=InputState.new({placeholder:'Tool default'});this.instructions=InputState.new({placeholder:'Optional instructions'});this.path=InputState.new({placeholder:'Automatic worktree path'});this.branch=InputState.new({placeholder:'Automatic branch name'});
    for(const state of [this.model,this.reasoning,this.instructions,this.path,this.branch])state.on('change',(_e,cx)=>cx.notify());
    this.focus.focus();
    return cx.spawn(async(cx)=>{
      try{
        const config=(await readConfig(this.io)).value;this.preferences=validateLaunchPreferences(config.preferences.launch);this.worktree=this.preferences.worktree;
        const initial=this.props.target;
        if(initial){
          const space=this.io.spaces().find(s=>s.id===initial.spaceId&&machineIdentity(s.machine)===machineIdentity(initial.machine));
          if(!space)throw Object.assign(Error('The captured destination space is unavailable.'),{code:'SPACE_UNAVAILABLE'});
          this.target={...initial,machine:machineIdentity(initial.machine)};
        }else{
          const space=this.capturedSpace;
          if(!space)throw Object.assign(Error('Select a space before starting an agent.'),{code:'SPACE_UNAVAILABLE'});
          this.target=launchTarget(await resolveSpaceRepo(space,this.capturedPanes,this.io.exec));
        }
        this.tools=await this.io.knownAgents({on:this.target.machine});
        const choices=toolChoices(this.tools,this.preferences);const first=choices.all.find(t=>t.key===this.props.toolKey)||choices.quick[0]||choices.all[0];
        if(first)await this.loadTool(first);
      }catch(e){this.error=e.message||'The destination could not be loaded.';this.target=null;}
      this.loading=false;cx.notify();
      // The dialog frame establishes its own focus while mounting. Take the
      // menu focus once its interactive content has actually been installed.
      this.focus.focus();
    });
  }
  async loadTool(tool){
    const generation=++this.generation;this.selected=tool;this.caps=null;
    const options=this.preferences.tools[tool.key]||{};this.model.set_value(options.model||'');this.reasoning.set_value(options.reasoning||'');this.instructions.set_value(options.instructions||'');this.subagents=options.subagents;
    const caps=await this.io.capabilities.get(tool,this.target.machine);if(generation===this.generation)this.caps=caps;
  }
  select(tool,cx,{launchView=true}={}){
    this.error=null;if(launchView)this.view='launch';return cx.spawn(async(cx)=>{try{await this.loadTool(tool);}catch(e){this.error=e.message;}cx.notify();});
  }
  options(){
    const value={};for(const [field,state]of [['model',this.model],['reasoning',this.reasoning],['instructions',this.instructions]])if(state.value().trim())value[field]=state.value();
    if(this.subagents!==undefined)value.subagents=this.subagents;return value;
  }
  start(cx){
    if(this.busy||this.loading||!this.target||!this.selected||!this.caps)return;
    this.busy=true;this.error=null;cx.notify();
    return cx.spawn(async(cx)=>{
      const request={...this.intent,...this.target,toolKey:this.selected.key,worktree:this.worktree,...this.options()};
      if(this.props.source)request.source={...this.props.source};
      if(this.worktree){if(this.path.value().trim())request.worktreePath=this.path.value();if(this.branch.value().trim())request.branch=this.branch.value();}
      const result=await launch(request,this.io);this.busy=false;
      if(result.ok){this.result=result;this.closeOverlay();}else this.error=result.message;
      cx.notify();return result;
    });
  }
  closeOverlay(){if(this.props.overlay)this.herdr.closeOverlay(this.props.overlay);}
  save(cx){
    if(this.busy)return;this.busy=true;this.error=null;
    return cx.spawn(async(cx)=>{try{if(this.selected)this.preferences.tools[this.selected.key]=this.options();await saveLaunchPreferences(this.io,this.preferences);this.saved=true;}catch(e){this.error=e.message;}this.busy=false;cx.notify();});
  }
  togglePin(key,cx){const p=this.preferences,pins=p.pins??toolChoices(this.tools,p).quick.map(t=>t.key);this.error=null;
    if(pins.includes(key))p.pins=pins.filter(k=>k!==key);else if(pins.length<3)p.pins=[...pins,key];else this.error='Unpin an agent before adding another shortcut. You can pin up to three.';cx.notify();
  }
  movePin(key,cx){const pins=this.preferences.pins??toolChoices(this.tools,this.preferences).quick.map(t=>t.key),index=pins.indexOf(key);if(index>0){[pins[index-1],pins[index]]=[pins[index],pins[index-1]];this.preferences.pins=[...pins];}cx.notify();}
  toggleHidden(key,cx){const p=this.preferences;if(p.hidden.includes(key))p.hidden=p.hidden.filter(v=>v!==key);else{p.hidden=[...p.hidden,key];if(p.pins)p.pins=p.pins.filter(v=>v!==key);}cx.notify();}
  field(id,title,state){const t=colors();return v_flex().gap(5).child(label(title,{muted:true,size:11})).child(Input.new(state).id(id).h(32).px(9).rounded(5).border(1).border_color(t.border).bg(t.chrome).text_size(12).text_color(t.foreground));}
  toolRow(tool,index,{settings=false}={}){
    const t=colors(),p=this.preferences,pins=p.pins??toolChoices(this.tools,p).quick.map(t=>t.key),hidden=p.hidden.includes(tool.key);
    let row=h_flex().id('choose-'+tool.key).h(40).px(8).gap(9).rounded(6).items_center().bg(this.selected?.key===tool.key?t.selected:'#00000000').role('button').accessibility_label(tool.name||tool.key)
      .hover(s=>s.bg(t.hover)).cursor_pointer().on_click((_e,cx)=>this.select(tool,cx,{launchView:!settings})).child(toolIcon(this.mod,tool,18)).child(label(tool.name||tool.key)).child(div().flex_1());
    if(settings)row=row.child(iconButton(this.mod,'pin-'+tool.key,'pin',pins.includes(tool.key)?'Unpin shortcut':'Pin shortcut',(_e,cx)=>this.togglePin(tool.key,cx),{active:pins.includes(tool.key)}))
      .when(pins.indexOf(tool.key)>0,e=>e.child(iconButton(this.mod,'earlier-'+tool.key,'priority','Move shortcut earlier',(_e,cx)=>this.movePin(tool.key,cx))))
      .child(iconButton(this.mod,'hide-'+tool.key,hidden?'plus':'close',hidden?'Show agent':'Hide agent',(_e,cx)=>this.toggleHidden(tool.key,cx),{active:hidden}));
    else row=row.child(label(String(index+1),{muted:true,size:10}));return row;
  }
  advanced(){
    if(!this.caps)return label('Checking available options…',{muted:true});
    return v_flex().gap(10).when(Boolean(this.caps.model),e=>e.child(this.field('model','Model',this.model)))
      .when(Boolean(this.caps.reasoning),e=>e.child(this.field('reasoning',this.caps.reasoning?.values?.length?'Reasoning · '+this.caps.reasoning.values.join(', '):'Reasoning',this.reasoning)))
      .when(Boolean(this.caps.instructions),e=>e.child(this.field('instructions','Instructions',this.instructions)))
      .when(Boolean(this.caps.subagents),e=>e.child(textButton('subagents',this.subagents===false?'Subagents off':'Subagents allowed',(_e,cx)=>{this.subagents=this.subagents===false?true:false;cx.notify();})))
      .when(Boolean(this.caps.probeError),e=>e.child(label('Base launch available · advanced options unavailable',{muted:true,size:11})));
  }
  render(cx){
    const t=colors(),choices=toolChoices(this.tools,this.preferences,this.query),role=this.view;
    const header=h_flex().gap(8).items_center().child(div().flex_1().font_semibold().text_size(15).text_color(t.foreground).child(role==='settings'?'Agent shortcuts':role==='launch'?'New agent':'Start working'))
      .when(role!=='settings',e=>e.child(iconButton(this.mod,'shortcuts','settings','Agent shortcuts',(_e,cx)=>{this.view='settings';cx.notify();})))
      .when(Boolean(this.props.overlay),e=>e.child(iconButton(this.mod,'close-dialog','close','Close',()=>this.closeOverlay())));
    const root=v_flex().id('launch-dialog').size_full().p(18).gap(12).bg(t.surface).text_color(t.foreground).text_size(12).track_focus(this.focus)
      .on_key_down((event,cx)=>{if(role==='menu'&&!this.typingSearch&&/^[1-9]$/.test(event.keystroke)){const tool=choices.all[Number(event.key)-1];if(tool){cx.stop_propagation();this.select(tool,cx);}}})
      .child(header).child(label(this.target?`${this.target.machine||'This Mac'} · ${this.target.checkoutRoot||this.target.repoRoot}`:'Choose a repository space',{muted:true,size:11}));
    if(this.loading)return root.child(label('Loading installed agents…',{muted:true}));
    if(this.error)root.child(div().text_size(12).text_color(t.blocked).child(this.error));
    if(!this.target)return root.child(emptyState(this.mod,'folder','Repository unavailable','Focus a terminal in the intended repository, then reopen this dialog.'));
    if(role==='menu'||role==='settings'){
      root.child(searchInput(this.mod,'agent-search',this.search));
      const rows=role==='settings'?this.tools.filter(t=>t.installed&&(!this.query||`${t.name} ${t.key}`.toLowerCase().includes(this.query.toLowerCase()))):choices.all;
      root.child(v_flex().id('installed-tools').flex_1().min_h(60).overflow_y_scrollbar().gap(3).children(rows.map((tool,i)=>this.toolRow(tool,i,{settings:role==='settings'}))));
      if(!rows.length)root.child(label('No installed agents available on this machine.',{muted:true}));
      if(role==='menu')root.child(h_flex().gap(8).border_t(1).border_color(t.border).pt(12)
        .child(textButton('terminal','Terminal',()=>{this.herdr.run('tab.new',{space:this.target.spaceId,folder:this.target.checkoutRoot});this.closeOverlay();}))
        .child(textButton('new-space','New space',()=>{this.herdr.run('space.new',{machine:this.target.machine});this.closeOverlay();}))
        .child(textButton('worktree','Worktree',(_e,cx)=>{this.worktree=true;this.view='launch';cx.notify();})));
      else root.child(textButton('default-worktree',this.preferences.worktree?'New worktree by default':'Current checkout by default',(_e,cx)=>{this.preferences.worktree=!this.preferences.worktree;cx.notify();}))
        .when(Boolean(this.selected),e=>e.child(this.advanced())).child(h_flex().gap(8).child(textButton('back','Back',(_e,cx)=>{this.view='menu';cx.notify();})).child(div().flex_1()).child(textButton('save-shortcuts',this.busy?'Saving…':this.saved?'Saved':'Save shortcuts',(_e,cx)=>this.save(cx),{primary:true,disabled:this.busy})));
      return root;
    }
    root.when(Boolean(this.props.source),e=>e.child(label(`${this.props.source.key} · ${this.props.source.title}`)));
    const shortcuts=[...choices.quick];if(this.selected&&!shortcuts.some(t=>t.key===this.selected.key))shortcuts.push(this.selected);
    root.child(h_flex().gap(6).children(shortcuts.map(tool=>textButton('tool-'+tool.key,tool.name||tool.key,(_e,cx)=>this.select(tool,cx),{primary:tool.key===this.selected?.key})))
      .when(choices.overflow.length>0,e=>e.child(iconButton(this.mod,'more-tools','more','Choose another agent',(_e,cx)=>{this.view='menu';cx.notify();}))));
    root.child(h_flex().gap(6).child(textButton('current-checkout','Current checkout',(_e,cx)=>{this.worktree=false;cx.notify();},{primary:!this.worktree})).child(textButton('new-worktree','New worktree',(_e,cx)=>{this.worktree=true;cx.notify();},{primary:this.worktree})));
    const content=v_flex().id('launch-options').flex_1().min_h(80).overflow_y_scrollbar().gap(12).when(this.worktree,e=>e.child(this.field('worktree-path','Worktree folder',this.path)).child(this.field('worktree-branch','Branch',this.branch))).child(this.advanced());
    root.child(content).child(h_flex().gap(8).child(textButton('back-to-agents','Back',(_e,cx)=>{this.view='menu';cx.notify();})).child(div().flex_1()).child(textButton('start-agent',this.busy?'Starting…':'Start agent',(_e,cx)=>this.start(cx),{primary:true,disabled:this.busy||!this.selected||!this.caps})));
    return root;
  }
  close(){for(const state of [this.search,this.model,this.reasoning,this.instructions,this.path,this.branch])state?.release();}
}
