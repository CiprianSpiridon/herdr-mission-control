import {div,svg,image} from 'gpui-kit';
import {h_flex,v_flex,Input,InputState} from 'gpui-base';
import {theme} from 'herdr';

export const palette={chrome:'#101114',surface:'#17191d',border:'#2a2d33',foreground:'#e5e7eb',muted:'#91969f',dim:'#6b7079',accent:'#89b4fa',selected:'#253044'};
export const colors=()=>({...palette,...theme()});
const key=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export function asset(mod,name){if(!key.test(mod)||!key.test(name))throw Error('Invalid local artwork identity');return `mods/${mod}/assets/${name}.svg`;}
export const icon=(mod,name,size=15)=>svg(asset(mod,name)).size(size).flex_none();
export function safeArtworkPath(value){return typeof value==='string'&&/^(icons|mods)\/[A-Za-z0-9_./-]+$/.test(value)&&!value.split('/').some(v=>v==='.'||v==='..')&&!value.includes('//')?value:null;}
export function toolIcon(mod,program,size=16){
  const path=safeArtworkPath(program?.icon);
  const el=path?(program.tint?svg(path):image(path)):icon(mod,'agent',size);
  return div().id('tool-icon-'+(program?.key||'agent')).size(size).flex_none().text_color(program?.color||colors().muted)
    .tooltip(program?.name||'Agent').accessibility_label(program?.name||'Agent').child(el.size(size).flex_none());
}
export function iconButton(mod,id,name,label,action,{active=false,disabled=false,size=28}={}){
  const t=colors();let el=div().id(id).size(size).flex_none().flex().items_center().justify_center().rounded(5)
    .text_color(disabled?t.dim:active?t.accent:t.muted).bg(active?t.selected:'#00000000').tooltip(label).accessibility_label(label).role('button')
    .on_mouse_down('left',(_e,cx)=>cx.stop_propagation());
  if(!disabled)el=el.cursor_pointer().hover(s=>s.bg(t.hover).text_color(t.foreground)).on_click((e,cx)=>{cx.stop_propagation();return action(e,cx);});
  return el.child(icon(mod,name,15));
}
export function textButton(id,label,action,{primary=false,disabled=false}={}){
  const t=colors();let el=h_flex().id(id).h(30).px(10).gap(6).items_center().justify_center().rounded(5).text_size(12)
    .bg(primary?t.selected:t.surface).border(1).border_color(t.border).text_color(disabled?t.dim:primary?t.accent:t.foreground).accessibility_label(label).role('button');
  if(!disabled)el=el.cursor_pointer().hover(s=>s.bg(t.hover)).on_click(action);
  return el.child(label);
}
export const label=(value,{muted=false,size=12}={})=>div().text_size(size).text_color(muted?colors().muted:colors().foreground).truncate().child(value);
export function statusDot(status,size=5){const t=colors();return div().size(size).rounded_full().flex_none().bg(t[status]||t.dim).tooltip(status||'Unknown');}
export function sectionHeader(mod,id,title,count,{collapsed=false,toggle,actions=[]}={}){
  return h_flex().h(32).gap(4).px(8).items_center().child(iconButton(mod,id+'-toggle',collapsed?'chevron-right':'chevron-down',`${collapsed?'Expand':'Collapse'} ${title}`,toggle))
    .child(label(title,{muted:true,size:11})).child(label(String(count??''),{muted:true,size:10})).child(div().flex_1()).children(actions);
}
export function emptyState(mod,name,title,description,action){return v_flex().p(24).gap(10).items_center().child(icon(mod,name,22).text_color(colors().dim)).child(label(title)).child(div().text_size(12).text_color(colors().muted).child(description)).when(Boolean(action),e=>e.child(action));}
export function metric(name,reading){
  const t=colors(),available=reading?.state==='available'&&Number.isFinite(reading.percent)&&reading.percent>=0&&reading.percent<=100;
  const value=available?`${Math.round(reading.percent)}%`:reading?.state==='stale'?'Stale':'Unavailable';
  const details=reading?.scope||reading?.reason||'';
  return h_flex().h(15).gap(5).items_center().text_size(10).text_color(t.dim).tooltip(`${name}: ${value}${details?' · '+details:''}`)
    .child(div().flex_1().truncate().child(name)).child(div().text_color(available&&reading.percent<15?t.blocked:t.muted).child(value));
}
export function createSearch(placeholder,onChange){
  const state=InputState.new({placeholder});
  state.on('change',(_e,cx)=>{onChange(state.value(),cx);cx.notify();});
  return state;
}
export function searchInput(mod,id,state){const t=colors();return h_flex().id(id).h(30).gap(6).px(8).rounded(5).border(1).border_color(t.border).bg(t.chrome).items_center().child(icon(mod,'search',13).text_color(t.dim)).child(Input.new(state).flex_1().text_size(12).text_color(t.foreground));}
