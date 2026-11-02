import {View,div} from 'gpui-kit';
import {v_flex,h_flex} from 'gpui-base';
import * as herdr from 'herdr';
import {groupSpaces,machineGroupKey,resolveSpaceRepo,launchTarget} from './model.js';
import {readConfig,resolveBinding} from '../../shared/config.js';
import {createLaunchIO} from '../../shared/launch.js';
import {LaunchDialog,openLaunchDialog} from '../../shared/launch-dialog.js';
import {colors,label,icon,iconButton,sectionHeader,statusDot,createSearch,searchInput} from '../../shared/ui.js';
const MOD='mission-control-spaces',STATE='mission-control-spaces-v1';
const state=()=>{const value=herdr.shared(STATE);return value?.v===1?{v:1,collapsed:Boolean(value.collapsed),groups:value.groups||{},query:typeof value.query==='string'?value.query:''}:{v:1,collapsed:false,groups:{},query:''};};
const editState=edit=>{const next=state();edit(next);herdr.setShared(STATE,next);};

export default class MissionControlSpaces extends View {
  init(_props,cx){
    this.props=herdr.props()||{};this.role=this.props.view||(this.props.footer?'footer':'list');this.io=createLaunchIO(herdr);this.hovered=null;
    if(['launch','settings','menu'].includes(this.role)){this.dialog=new LaunchDialog(MOD,this.props,herdr);this.dialog.init(cx);return;}
    if(this.role==='context'){
      const space=herdr.spaces().find(s=>s.id===this.props.spaceId&&(s.machine??null)===(this.props.machine??null));
      this.space=space?{...space,tabs:space.tabs.map(t=>({...t}))}:null;
      const focus=herdr.focused();this.panes=herdr.panes().map(p=>({...p,focused:p.focused||p.pane===focus?.pane}));
      this.resolved=null;this.error=null;this.sessionsAvailable=false;
      cx.spawn(async(cx)=>{
        if(!this.space){this.error='The clicked space is no longer available.';cx.notify();return;}
        const resolved=await resolveSpaceRepo(this.space,this.panes,herdr.exec);this.resolved=resolved;
        if(resolved.state!=='resolved')this.error=resolved.reason;
        else if(resolved.machine!==null){
          try{const binding=resolveBinding((await readConfig(this.io)).value,resolved);if(binding?.mountedLocalPath){
            const mounted=await resolveSpaceRepo(this.space,this.panes,herdr.exec,{mountedLocalPath:binding.mountedLocalPath});
            if(mounted.state==='resolved'&&mounted.repoRoot===resolved.repoRoot&&mounted.gitCommonDir===resolved.gitCommonDir)this.resolved=mounted;
            else this.error='Repository identity changed while checking the mount; reopen the menu.';
          }}catch{this.error='The remote mount settings could not be validated.';}
        }
        // Optional UI integration reads only the public manifest, never another
        // mod's code. A standalone install simply omits this unavailable action.
        try{const raw=await herdr.readTextFile(herdr.appHome()+'/mods/mission-control-sessions/mod.json');this.sessionsAvailable=Boolean(raw&&typeof JSON.parse(raw).title==='string');}catch{}
        cx.notify();
      });
      return;
    }
    this.search=createSearch('Find a space',value=>editState(s=>{s.query=value;}));this.search.set_value(state().query);
  }
  menu(space){herdr.openOverlay({mod:MOD,kind:'popup',width:268,height:244,props:{view:'context',spaceId:space.id,machine:space.machine??null}});}
  closeOverlay(){if(this.props.overlay)herdr.closeOverlay(this.props.overlay);}
  newAgent(){if(this.resolved?.state!=='resolved'||this.error)return;const target=launchTarget(this.resolved);this.closeOverlay();openLaunchDialog(MOD,herdr,{target,...target,view:'launch'});}
  async finder(cx){
    if(herdr.window()?.platform!=='macos'||this.resolved?.state!=='resolved'||!this.resolved.finderPath||this.error)return;
    try{const r=await herdr.exec('open',[this.resolved.finderPath]);if(r.code!==0)throw Error('Finder could not open this folder.');this.closeOverlay();}catch{this.error='Finder could not open the validated folder.';cx.notify();}
  }
  sessions(){if(!this.sessionsAvailable||this.resolved?.state!=='resolved')return;const target=launchTarget(this.resolved);this.closeOverlay();herdr.openOverlay({mod:'mission-control-sessions',kind:'dialog',width:900,height:640,props:{view:'panel',target,...target}});}
  action(id,name,title,fn,{disabled=false,reason,height=34}={}){const t=colors();let row=h_flex().id(id).h(height).px(9).gap(9).rounded(5).items_center().text_color(disabled?t.dim:t.foreground).role('button').accessibility_label(title).child(icon(MOD,name,15)).child(div().text_color(disabled?t.dim:t.foreground).child(title));if(!disabled)row=row.cursor_pointer().hover(s=>s.bg(t.hover)).on_click(fn);if(reason)row=row.tooltip(reason);return row;}
  context(cx){
    const t=colors(),ready=this.resolved?.state==='resolved'&&!this.error,canFind=ready&&herdr.window()?.platform==='macos'&&Boolean(this.resolved.finderPath);
    return v_flex().id('space-context').size_full().p(8).gap(3).bg(t.surface).text_size(12).child(div().px(9).py(6).font_semibold().text_color(t.foreground).truncate().child(this.space?.name||'Space'))
      .child(this.action('context-new-agent','agent','New agent',()=>this.newAgent(),{disabled:!ready}))
      .when(this.sessionsAvailable,e=>e.child(this.action('context-sessions','sessions','Previous sessions',()=>this.sessions(),{disabled:!ready})))
      .child(this.action('context-finder','folder','Open in Finder',(_e,cx)=>cx.spawn(cx=>this.finder(cx)),{disabled:!canFind,reason:!canFind?this.resolved?.finderReason||'A validated local folder on macOS is required.':null}))
      .when(!this.resolved,e=>e.child(div().p(8).text_color(t.muted).child('Resolving live repository…')))
      .when(Boolean(this.error),e=>e.child(div().p(8).text_size(11).text_color(t.blocked).child(this.error)));
  }
  footer(){return v_flex().id('spaces-footer').size_full().px(8).pt(4).pb(8).text_size(12).bg(colors().chrome).border_t(1).border_color(colors().border)
    .child(this.action('settings','settings','Settings',()=>herdr.run('app.settings'),{height:28}))
    .child(this.action('add-machine','plus','Add machine',()=>herdr.run('mod.open',{name:'machine-add'}),{height:28}));}
  row(space){
    const t=colors(),first=Array.from((space.name||'').trim())[0],initial=first&&/[A-Za-z0-9]/.test(first)?first.toUpperCase():null;
    return h_flex().id('space-'+space.id).h(30).px(7).gap(7).items_center().rounded(5).bg(space.active?t.selected:'#00000000').cursor_pointer().hover(s=>s.bg(t.hover))
      .tooltip([space.name,space.branch,space.machine||'This Mac'].filter(Boolean).join(' · ')).role('button').accessibility_label(space.name)
      .on_hover((over,cx)=>{this.hovered=over?space.id:null;cx.notify();})
      .on_click(()=>herdr.run('space.select',{id:space.id}))
      .on_mouse_down('right',(_e,cx)=>{cx.stop_propagation();this.menu(space);})
      .child(div().size(18).rounded(5).bg(t.raised).text_color(t.accent).text_size(10).font_semibold().flex().items_center().justify_center().child(initial||icon(MOD,'folder',12)))
      .child(div().flex_1().min_w(0).truncate().text_color(space.active?t.foreground:t.muted).child(space.name))
      .when(Boolean(space.status),e=>e.child(statusDot(space.status)))
      .child(iconButton(MOD,'space-more-'+space.id,'more','Space menu',()=>this.menu(space),{size:24}));
  }
  render(cx){
    if(this.dialog)return this.dialog.render(cx);if(this.role==='footer')return this.footer();if(this.role==='context')return this.context(cx);
    const t=colors(),s=state(),all=herdr.spaces(),groups=groupSpaces(all,{query:s.query,collapsed:s.groups});
    return v_flex().id('spaces-list').size_full().min_h(0).bg(t.chrome).text_size(12)
      .child(sectionHeader(MOD,'spaces','Spaces',all.length,{collapsed:s.collapsed,toggle:()=>editState(s=>{s.collapsed=!s.collapsed;}),actions:[iconButton(MOD,'new-space','plus','New space',()=>herdr.run('space.new'))]}))
      .when(!s.collapsed,e=>e.child(div().px(10).pb(8).child(searchInput(MOD,'space-search',this.search)))
        .child(v_flex().id('space-groups').flex_1().min_h(0).px(7).pb(6).gap(5).overflow_y_scrollbar().children(groups.map(group=>{
          const machine=herdr.machines().find(m=>m.name===group.machine),offline=machine?.layout==='unavailable';
          return v_flex().gap(2).child(h_flex().id('machine-'+group.key).h(25).px(3).gap(5).items_center().cursor_pointer().on_click(()=>editState(s=>{s.groups={...s.groups,[group.key]:!s.groups[group.key]};}))
            .child(icon(MOD,group.collapsed?'chevron-right':'chevron-down',11).text_color(t.dim)).child(label(group.label,{muted:true,size:10})).child(label(offline?'Offline':String(group.spaces.length),{muted:true,size:10})))
            .when(!group.collapsed,e=>e.children(group.spaces.map(space=>this.row(space))));
        })))).when(!s.collapsed&&!groups.length,e=>e.child(div().p(12).text_color(t.dim).child('No matching spaces.')));
  }
  close(){this.dialog?.close();this.search?.release();}
}
