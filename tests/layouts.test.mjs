import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// GPUI mod sources import native externals; the contract recorder stands in so their exported contracts load.
await import('./support/native-loader.mjs');
const tabs=await import('../src/mods/mission-control-tabs/main.js');
const nav=await import('../src/mods/mission-control-tabs/navigation.js');

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),layoutsDir=path.join(root,'src/layouts'),modsDir=path.join(root,'src/mods');
const NAMES=Object.freeze(Object.keys(nav.LAYOUT_PAIR)),CLASSIC='mission-control-classic',INSTALLED=['main',...NAMES];
const MC_NAME=/^mission-control-[a-z0-9]+(?:-[a-z0-9]+)*$/,TYPES=new Set(['block','row','column','stack']),CONTENT_KINDS=['mod','terminal','tab','agent'];
/** Herdr app 0.1.9 shipped mod names (its installed.json). Layouts may reference them; they are never copied or overwritten. */
export const SHIPPED=Object.freeze(new Set(['agents','changes','confirm','files','help','machine-add','menu','new-menu','pane','peek','picker','prompt','spaces','tabs','terminals-bar','terminals-pane','toast','win98','workspace-chrome','workspace-status','worktree']));
/** Shipped tab strips: any of them would be a second strip beside the one topmost Mission Control bar. */
const STRIPS=new Set(['tabs','terminals-bar']);
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const clone=v=>JSON.parse(JSON.stringify(v));
const LIT=/'([A-Za-z0-9_-]+)'/g,lits=s=>[...s.matchAll(LIT)].map(m=>m[1]);

/**
 * The props roles a mod accepts, derived from its own source: its role expression (or exported viewRole/VIEWS),
 * every literal it compares this.role against, the roles that construct its bundled LaunchDialog, the views it
 * opens itself as overlays and literal roles it only assigns internally. Block roles are what a layout may mount.
 */
export function modContract(name,source,{viewRole=null,views=null}={}){
  const compared=new Set(),dialog=new Set(),overlay=new Set(),internal=new Set();
  const sets=new Map([...source.matchAll(/\b([A-Z_][A-Z0-9_]*)=new Set\((\[[^\]]*\])\)/g)].map(m=>[m[1],lits(m[2])]));
  for(const m of source.matchAll(/(\[[^\]]*\])\.includes\(this\.role\)|\b([A-Z_][A-Z0-9_]*)\.has\(this\.role\)|this\.role[!=]==('[A-Za-z0-9_-]+')/g)){
    const list=m[1]?lits(m[1]):m[2]?sets.get(m[2])??[]:lits(m[3]);list.forEach(v=>compared.add(v));
    if(m[3])continue;const rest=source.slice(m.index+m[0].length),at=rest.indexOf('new LaunchDialog('),next=rest.indexOf('this.role');
    if(at>=0&&(next<0||at<next))list.forEach(v=>dialog.add(v));
  }
  for(const m of source.matchAll(/openOverlay\(\{mod:MOD,[^;]*?props:\{view:'([A-Za-z0-9_-]+)'/g))overlay.add(m[1]);
  for(const m of source.matchAll(/openLaunchDialog\(MOD,herdr,\{[^;]*?view:'([A-Za-z0-9_-]+)'/g))overlay.add(m[1]);
  for(const m of source.matchAll(/this\.role='([A-Za-z0-9_-]+)'/g))internal.add(m[1]);
  const dialogOnly=/init\([^)]*\)\{\s*this\.dialog=new LaunchDialog\(/.test(source),assignment=/this\.role=([^;'][^;]*);/.exec(source);
  let roleOf,roles;
  if(typeof viewRole==='function'){roleOf=props=>viewRole(props||{});roles=new Set(views);}
  else if(assignment){
    const expr=assignment[1].replaceAll('this.props','props');
    if(!/^(?:props(?:\.[A-Za-z]+)?|'[A-Za-z0-9_-]*'|\|\||&&|===|!==|[!?:()\s])+$/.test(expr))throw new Error(`${name}: unsupported role expression ${expr}`);
    const fn=new Function('props',`"use strict";return (${expr});`);roleOf=props=>fn(props||{});roles=new Set([roleOf({}),...compared]);
  }else{roleOf=props=>props?.view===undefined?'default':String(props.view);roles=new Set(['default']);}
  const blockRoles=new Set(dialogOnly?[]:[...roles].filter(r=>!dialog.has(r)&&!overlay.has(r)&&!internal.has(r)));
  return Object.freeze({name,roleOf,roles,compared,dialog,overlay,internal,dialogOnly,blockRoles});
}
/** Every Mission Control mod under src/mods; the tabs mod contributes its exported VIEWS/viewRole. */
export function loadRegistry(dir=modsDir){
  const out=new Map();
  for(const name of fs.readdirSync(dir).filter(n=>MC_NAME.test(n)).sort()){
    const main=path.join(dir,name,'main.js'),manifest=path.join(dir,name,'mod.json');if(!fs.existsSync(main)||!fs.existsSync(manifest))continue;
    const json=JSON.parse(fs.readFileSync(manifest,'utf8'));if(typeof json.title!=='string'||!json.title.trim())throw new Error(`${name}: mod.json has no title`);
    out.set(name,modContract(name,fs.readFileSync(main,'utf8'),name===tabs.MOD?{viewRole:tabs.viewRole,views:tabs.VIEWS}:{}));
  }
  return out;
}
const REGISTRY=loadRegistry();

function walkNodes(tree,fn){
  const visit=(node,parent,index,trail)=>{if(!plain(node))return fn(node,parent,index,trail);fn(node,parent,index,trail);const at=[...trail,node.id??'?'];
    (Array.isArray(node.children)?node.children:[]).forEach((c,i)=>visit(c,node,i,at));(Array.isArray(node.floating)?node.floating:[]).forEach((c,i)=>visit(c,node,i,[...at,'floating']));};
  visit(tree,null,0,[]);
}
/** Every {mod, props?} reference anywhere in a tree, including pane headers and floating blocks. */
export function modRefs(tree){
  const out=[],visit=(v,trail)=>{if(Array.isArray(v))return v.forEach(x=>visit(x,trail));if(!plain(v))return;
    if(typeof v.mod==='string')out.push({mod:v.mod,props:v.props,trail:trail.join('/')});
    const at=typeof v.id==='string'?[...trail,v.id]:trail;for(const [k,x] of Object.entries(v))if(k!=='props')visit(x,['children','floating','id'].includes(k)?at:[...at,k]);};
  visit(tree,[]);return out;
}
const findAll=(tree,pred)=>{const out=[];walkNodes(tree,(n,parent,index)=>{if(plain(n)&&pred(n))out.push({node:n,parent,index});});return out;};
const findId=(tree,id)=>findAll(tree,n=>n.id===id)[0]??null;
const isMod=(node,mod,role)=>node?.type==='block'&&node.content?.mod===mod&&(role===undefined||REGISTRY.get(mod)?.roleOf(node.content.props)===role);
const sameContent=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const validSize=s=>plain(s)&&Object.keys(s).length===1&&(Number.isFinite(s.px)&&s.px>0||Number.isFinite(s.weight)&&s.weight>0);

/**
 * The Mission Control layout tree checker. Returns [{code, at, message}], empty when the tree honors the Herdr
 * node schema and the reviewed mod contracts for `name` (mission-control or mission-control-classic).
 */
export function checkLayout(tree,{name,registry=REGISTRY,layouts=INSTALLED}={}){
  const errors=[],fail=(code,at,message)=>errors.push({code,at,message}),classic=name===CLASSIC,other=nav.LAYOUT_PAIR[name];
  if(!other)fail('NAME','root',`${name} is not a Mission Control layout name`);
  if(!plain(tree)){fail('TREE_SHAPE','root','the layout is not a JSON object');return errors;}
  // Herdr node schema.
  const ids=new Map();
  walkNodes(tree,(node,parent,index,trail)=>{
    const at=[...trail,plain(node)?node.id:index].join('/');
    if(!plain(node))return fail('TREE_SHAPE',at,'a node must be an object');
    if(typeof node.id!=='string'||!node.id)fail('TREE_SHAPE',at,'every node needs an id');else{ids.set(node.id,(ids.get(node.id)||0)+1);}
    if(!TYPES.has(node.type)&&!(trail.at(-1)==='floating'&&node.type===undefined))fail('TREE_SHAPE',at,`unknown node type ${node.type}`);
    if(node.size!==undefined&&!validSize(node.size))fail('SIZE',at,'size must be {px:>0} or {weight:>0}');
    for(const k of ['min','max'])if(node[k]!==undefined&&!(Number.isFinite(node[k])&&node[k]>=0))fail('SIZE',at,`${k} must be a non-negative px number`);
    if(Number.isFinite(node.min)&&Number.isFinite(node.max)&&node.min>node.max)fail('SIZE',at,'min exceeds max');
    if(node.hidden!==undefined&&typeof node.hidden!=='boolean')fail('TREE_SHAPE',at,'hidden must be boolean');
    if(node.type==='block'||trail.at(-1)==='floating'){
      if(node.children!==undefined)fail('TREE_SHAPE',at,'a block has no children');
      const kinds=plain(node.content)?CONTENT_KINDS.filter(k=>node.content[k]!==undefined):[];
      if(kinds.length!==1)fail('CONTENT',at,'block content needs exactly one of mod, terminal, tab or agent');
    }else if(TYPES.has(node.type)){
      if(!Array.isArray(node.children)||!node.children.length)fail('TREE_SHAPE',at,`${node.type} needs children`);
      if(node.type==='stack'&&Array.isArray(node.children)&&!node.children.some(c=>c?.id===node.active))fail('TREE_SHAPE',at,'stack active must name one of its children');
      if(node.type==='stack'&&node.header!==undefined)fail('SECOND_STRIP',at,'a stack header draws a second tab strip');
    }
    if(node.window_drag===true&&node.id!=='mc-topbar')fail('TOPBAR',at,'only the topmost bar drags the window');
  });
  for(const [id,count] of ids)if(count>1)fail('DUPLICATE_ID',id,`node id ${id} is used ${count} times`);
  // Every mod reference: an existing Mission Control mod in a block role it accepts, or a shipped Herdr mod.
  for(const ref of modRefs(tree)){
    if(MC_NAME.test(ref.mod)){
      const mod=registry.get(ref.mod);if(!mod){fail('UNKNOWN_MOD',ref.trail,`${ref.mod} is not a mod under src/mods`);continue;}
      if(ref.props!==undefined&&!plain(ref.props)){fail('UNKNOWN_ROLE',ref.trail,`${ref.mod} props must be an object`);continue;}
      const role=mod.roleOf(ref.props);
      if(!mod.roles.has(role))fail('UNKNOWN_ROLE',ref.trail,`${ref.mod} does not accept role ${role}`);
      else if(!mod.blockRoles.has(role))fail('OVERLAY_ROLE',ref.trail,`${ref.mod} role ${role} is an overlay/internal role, not a layout block`);
    }else if(!SHIPPED.has(ref.mod))fail('UNKNOWN_MOD',ref.trail,`${ref.mod} is neither a Mission Control mod nor a shipped Herdr mod`);
    else if(STRIPS.has(ref.mod))fail('SECOND_STRIP',ref.trail,`shipped ${ref.mod} is a second tab strip`);
  }
  // Root look and preview.
  if(tree.type!=='column')fail('ROOT','root','the root is a full-width column');
  if(tree.titlebar!=='none')fail('ROOT','root','the layout draws its own title bar (titlebar:none)');
  if(!Array.isArray(tree.traffic_lights)||tree.traffic_lights.length!==2||!tree.traffic_lights.every(n=>Number.isFinite(n)&&n>=0))fail('ROOT','root','traffic_lights must be [x, y]');
  if(tree.theme!=='graphite')fail('ROOT','root','the fixed look is graphite');
  if(tree.preview!==`layouts/${name}.svg`)fail('PREVIEW','root',`preview must be layouts/${name}.svg`);
  // Exactly one topmost native tab bar.
  const kids=Array.isArray(tree.children)?tree.children:[],bars=findAll(tree,n=>isMod(n,tabs.MOD,'topbar')),top=kids[0];
  if(bars.length!==1)fail('TOPBAR','root',`expected exactly one topbar, found ${bars.length}`);
  if(!tabs.isTopbarBlock(top)||top.id!=='mc-topbar'||top.window_drag!==true||!Number.isFinite(top.size?.px))fail('TOPBAR','root','the first root child is the fixed-height, window-dragging mc-topbar');
  const barProps=plain(top?.content?.props)?top.content.props:{};
  if(barProps.swapTo!==other||!layouts.includes(barProps.swapTo))fail('SWAP','mc-topbar',`swapTo must name the other installed layout ${other}`);
  if((barProps.panel===true)!==classic)fail('PANEL','mc-topbar',classic?'Classic asks for the panel toggle':'the overview has no panel toggle');
  // Layout nodes consumed by navigation.
  const main=findId(tree,nav.NODES.main),panel=findId(tree,nav.NODES.panel),stack=findId(tree,nav.NODES.stack);
  if(!main)fail('NODES','root','mc-main is missing (the swap needs it)');
  if(classic){
    if(!panel)fail('PANEL','mc-main','Classic needs mc-work-panel');
    else{
      if(panel.node.type!=='column'||panel.node.hidden!==true)fail('PANEL','mc-work-panel','mc-work-panel is a column hidden at first');
      if(panel.parent!==main?.node)fail('PANEL','mc-work-panel','mc-work-panel sits inside mc-main beside the terminals');
    }
  }else if(panel)fail('PANEL','mc-work-panel','only Classic has mc-work-panel');
  if(!stack||stack.node.type!=='stack')fail('STACK','root','mc-work-stack must be a stack');
  else{
    const children=Array.isArray(stack.node.children)?stack.node.children:[];
    if(children.length!==nav.SOURCES.length||nav.SOURCES.some((s,i)=>children[i]?.id!==s.id||children[i]?.type!=='block'||!sameContent(children[i]?.content,{mod:s.mod,props:s.props})))
      fail('STACK','mc-work-stack','children must be exactly '+nav.SOURCE_IDS.join('/')+' with their navigation content');
    if(classic&&stack.parent!==panel?.node)fail('STACK','mc-work-stack','Classic keeps the stack inside mc-work-panel');
    const navs=findAll(tree,n=>isMod(n,tabs.MOD,'navigation')),before=stack.parent?.children?.[stack.index-1];
    if(navs.length!==1||before!==navs[0]?.node||!sameContent(before?.content,{mod:tabs.MOD,props:{view:'navigation'}})||!Number.isFinite(before?.size?.px))
      fail('NAVIGATION','mc-work-stack','one fixed-height navigation block sits directly above mc-work-stack');
  }
  // Rail: separate Spaces and Agents blocks, footer at the absolute bottom-left.
  const body=kids.at(-1),rail=body?.children?.[0];
  if(kids.length!==2||body?.type!=='row'||rail?.id!=='sidebar'||rail.type!=='column'||rail.hidden===true)fail('FOOTER','root','the rail is the left column of the row filling the window below the bar');
  else{
    const last=rail.children?.at(-1),footers=findAll(tree,n=>isMod(n,'mission-control-spaces','footer'));
    if(!isMod(last,'mission-control-spaces','footer')||last.hidden===true||!Number.isFinite(last.size?.px)||footers.length!==1)fail('FOOTER','sidebar','Settings/Add machine footer is the rail\'s last, fixed-height block');
    const inRail=pred=>findAll(rail,pred).filter(f=>f.node!==last);
    const lists=[inRail(n=>isMod(n,'mission-control-spaces','list')),inRail(n=>isMod(n,'mission-control-agents','list'))];
    if(lists.some(l=>l.length!==1)||lists[0][0]?.parent!==lists[1][0]?.parent||lists[0][0].index>lists[1][0].index)fail('RAIL','sidebar','Spaces then Agents are separate sibling blocks above the footer');
  }
  // Terminals: one active-tab block; Classic leads with it.
  const terms=findAll(tree,n=>n.type==='block'&&n.content?.tab==='active');
  if(terms.length!==1)fail('TERMINALS','root','exactly one {tab:"active"} block');
  else if(classic&&(terms[0].parent!==main?.node||terms[0].index!==0))fail('TERMINALS','mc-main','Classic is terminal-first');
  return errors;
}

/** Logical widths of every node at a window width; `open` treats hidden ids as shown. */
export function widthsAt(tree,windowWidth,{open=[]}={}){
  const out=new Map(),padX=p=>Array.isArray(p)?Number(p[1])||0:Number(p)||0;
  const visit=(node,w)=>{
    if(!plain(node))return;out.set(node.id,w);const inner=Math.max(0,w-2*padX(node.padding)),kids=(node.children||[]).filter(c=>c?.hidden!==true||open.includes(c?.id));
    if(node.type!=='row'){kids.forEach(c=>visit(c,inner));return;}
    const fixed=kids.reduce((a,c)=>a+(c.size?.px||0),0),between=Math.max(0,kids.length-1)*((node.gap||0)+(node.divider?.width||0));
    const rest=Math.max(0,inner-fixed-between),weights=kids.reduce((a,c)=>a+(c.size?.px?0:c.size?.weight||1),0);
    kids.forEach(c=>visit(c,c.size?.px||rest*(c.size?.weight||1)/(weights||1)));
  };
  visit(tree,windowWidth);return out;
}

const readLayout=name=>{const file=path.join(layoutsDir,name+'.json'),text=fs.readFileSync(file,'utf8');return {file,text,tree:JSON.parse(text)};};
const LAYOUTS=Object.fromEntries(NAMES.map(n=>[n,readLayout(n)]));
const codes=(tree,name)=>checkLayout(tree,{name}).map(e=>e.code);
const mutate=(name,edit)=>{const tree=clone(LAYOUTS[name].tree);edit(tree,id=>findId(tree,id)?.node);return tree;};

test('the derived mod contracts know every role the layouts and navigation use',()=>{
  const roles=Object.fromEntries([...REGISTRY].map(([name,m])=>[name,[...m.blockRoles].sort()]));
  assert.deepEqual(roles,{'mission-control-agent-menu':[],'mission-control-agents':['list'],'mission-control-github':['panel','pulls'],'mission-control-gitlab':['merges','panel'],'mission-control-jira':['panel'],
    'mission-control-reopen':['bar'],'mission-control-sessions':['default'],'mission-control-spaces':['footer','list'],'mission-control-tabs':['navigation','topbar']});
  const t=REGISTRY.get(tabs.MOD);assert.ok([...t.compared].every(v=>tabs.VIEWS.includes(v)),'every tabs role compared in source is an exported view');
  assert.deepEqual([...t.dialog].sort(),['launch','menu','settings']);assert.ok(t.overlay.has('context'));
  assert.ok(REGISTRY.get('mission-control-agent-menu').dialogOnly,'the agent menu is only its own dialog');
  assert.ok(REGISTRY.get('mission-control-agents').internal.has('unavailable'));
  for(const s of nav.SOURCES){const m=REGISTRY.get(s.mod);assert.ok(m&&m.blockRoles.has(m.roleOf(s.props)),`${s.id}: ${s.mod} accepts its navigation props`);}
  assert.deepEqual(['issues','merges'].map(view=>REGISTRY.get('mission-control-gitlab').roleOf({view,hideHeader:true})),['panel','merges']);
  assert.throws(()=>modContract('x',"init(){this.role=globalThis.view||'panel';}"),/unsupported role expression/);
});

test('both layout files are UTF-8 two-space JSON trees that pass the checker',()=>{
  for(const name of NAMES){
    const {file,text,tree}=LAYOUTS[name],bytes=fs.readFileSync(file);
    assert.equal(new TextDecoder('utf-8',{fatal:true}).decode(bytes),text);assert.notEqual(bytes[0],0xef,'no BOM');
    assert.equal(text,JSON.stringify(tree,null,2)+'\n',`${name}: canonical two-space JSON`);
    assert.deepEqual(checkLayout(tree,{name}),[],name);
  }
});

test('exactly one topmost tab bar, swapping to the other layout with traffic-light room',()=>{
  for(const name of NAMES){
    const {tree}=LAYOUTS[name],classic=name===CLASSIC,bar=tree.children[0];
    assert.ok(tabs.isTopbarBlock(bar));assert.equal(bar.window_drag,true);assert.equal(tree.titlebar,'none');
    assert.deepEqual(bar.content,{mod:tabs.MOD,props:classic?{view:'topbar',swapTo:'mission-control',panel:true}:{view:'topbar',swapTo:CLASSIC}});
    const refs=modRefs(tree).filter(r=>r.mod===tabs.MOD);assert.deepEqual(refs.map(r=>tabs.viewRole(r.props)).sort(),['navigation','topbar']);
    assert.equal(findAll(tree,n=>n.header!==undefined).length,0,'no stack header strip');
    assert.equal(tabs.leftOffset(tree,tabs.isTopbarBlock),0,'the bar spans the full window width');
    assert.equal(tabs.lightsPadding({win:{platform:'macos',titlebar:'none',fullscreen:false},tree}),tree.traffic_lights[0]+64);
    // The tab bar's own reading of this tree: swap target, panel control and all six sources.
    const c=nav.layoutContract({tree,name,names:INSTALLED,props:bar.content.props});
    assert.deepEqual({main:c.main,stack:c.stack,children:c.children,active:c.active,panel:c.panel,panelControl:c.panelControl,swap:c.swap},
      {main:true,stack:true,children:[...nav.SOURCE_IDS],active:'jira',panel:classic?{hidden:true}:null,panelControl:classic,swap:{enabled:true,to:nav.LAYOUT_PAIR[name],label:nav.LAYOUT_LABELS[nav.LAYOUT_PAIR[name]]}});
    assert.ok(fs.existsSync(path.join(layoutsDir,nav.LAYOUT_PAIR[name]+'.json')),'the swap target layout exists');
  }
});

test('both layouts mount mc-main and the same six-source mc-work-stack; Classic starts with the panel hidden',()=>{
  for(const name of NAMES){
    const {tree}=LAYOUTS[name],stack=findId(tree,'mc-work-stack');
    assert.ok(findId(tree,'mc-main'));assert.equal(stack.node.header,undefined);
    assert.deepEqual(stack.node.children.map(c=>[c.id,c.content]),nav.SOURCES.map(s=>[s.id,{mod:s.mod,props:{...s.props}}]));
    assert.deepEqual(stack.node.children.filter(c=>c.content.mod==='mission-control-gitlab').map(c=>c.content.props),[{view:'issues',hideHeader:true},{view:'merges',hideHeader:true}]);
    assert.deepEqual(stack.parent.children[stack.index-1].content,{mod:tabs.MOD,props:{view:'navigation'}});
  }
  const panel=findId(LAYOUTS[CLASSIC].tree,'mc-work-panel').node;
  assert.equal(panel.hidden,true);assert.deepEqual(panel.children.map(c=>c.id),['mc-navigation','mc-work-stack']);
  assert.equal(findId(LAYOUTS['mission-control'].tree,'mc-work-panel'),null);
  assert.deepEqual(findId(LAYOUTS[CLASSIC].tree,'mc-main').node.children.map(c=>c.id),['mc-terminals','mc-work-panel'],'Classic is terminal-first');
});

test('Spaces and Agents are separate rail sections with Settings/Add machine at the bottom-left in both',()=>{
  for(const name of NAMES){
    const {tree}=LAYOUTS[name],body=tree.children.at(-1),rail=body.children[0];
    assert.equal(rail.id,'sidebar','cmd-b layout.toggle:sidebar keeps working');assert.equal(rail.size.px,220);
    assert.deepEqual(rail.children.at(-1).content,{mod:'mission-control-spaces',props:{view:'footer'}});
    const lists=findId(tree,'mc-rail-lists').node.children;
    assert.deepEqual(lists.map(n=>n.content),[{mod:'mission-control-spaces',props:{view:'list'}},{mod:'mission-control-agents',props:{view:'list'}}]);
    assert.ok(lists.every(n=>n.size.weight>0&&n.min<=32),'each section can shrink to its own header when collapsed');
  }
  assert.deepEqual(LAYOUTS['mission-control'].tree.children[1].children[0],LAYOUTS[CLASSIC].tree.children[1].children[0],'the same rail in both');
});

test('preview paths resolve to the existing Settings SVGs beside each installed layout',()=>{
  for(const name of NAMES){
    const {tree}=LAYOUTS[name],installed=path.posix.join('layouts',name+'.json');
    assert.equal(tree.preview,`layouts/${name}.svg`);assert.equal(path.posix.dirname(tree.preview),path.posix.dirname(installed));
    const svg=path.join(layoutsDir,path.posix.basename(tree.preview)),text=fs.readFileSync(svg,'utf8');
    assert.ok(fs.statSync(svg).isFile()&&!fs.lstatSync(svg).isSymbolicLink());assert.match(text,/^\s*<svg[\s>]/);assert.match(text,new RegExp(`data-view="${name}"`));
  }
  const slots=[...fs.readFileSync(path.join(layoutsDir,'mission-control.svg'),'utf8').matchAll(/data-source="([a-z]+)"/g)].map(m=>m[1]);
  assert.deepEqual(slots,[...nav.SOURCE_IDS],'the overview artwork depicts the same six sources');
});

test('the six sources stay reachable at 1024 and 736 px with a 220 px rail; Classic keeps terminal room',()=>{
  for(const width of [1024,736]){
    const mc=widthsAt(LAYOUTS['mission-control'].tree,width).get('mc-navigation');
    assert.ok(mc>=nav.navigationMinWidth(),`overview navigation ${mc}px at ${width}`);if(width>=1024)assert.equal(nav.navigationMode(mc),'full');
    const open=widthsAt(LAYOUTS[CLASSIC].tree,width,{open:['mc-work-panel']}),closed=widthsAt(LAYOUTS[CLASSIC].tree,width);
    assert.ok(open.get('mc-navigation')>=nav.navigationMinWidth({panel:true}),`panel navigation at ${width}`);
    assert.ok(open.get('mc-terminals')>100&&closed.get('mc-terminals')>open.get('mc-terminals'),`Classic terminals ${open.get('mc-terminals')}/${closed.get('mc-terminals')}px at ${width}`);
  }
});

test('the bundle collects exactly the referenced Mission Control mods, all present in src/mods',()=>{
  const required=new Set();for(const name of NAMES)for(const r of modRefs(LAYOUTS[name].tree))if(r.mod.startsWith('mission-control-'))required.add(r.mod);
  assert.deepEqual([...required].sort(),['mission-control-agents','mission-control-github','mission-control-gitlab','mission-control-jira','mission-control-sessions','mission-control-spaces','mission-control-tabs']);
  for(const mod of required)assert.ok(REGISTRY.has(mod),mod);
  const shipped=new Set();for(const name of NAMES)for(const r of modRefs(LAYOUTS[name].tree))if(!r.mod.startsWith('mission-control-'))shipped.add(r.mod);
  assert.deepEqual([...shipped],['pane'],'only the shipped pane header is used, read-only');
});

test('the checker rejects invalid references, roles and structure',()=>{
  const MC='mission-control',expect=(name,edit,code)=>assert.ok(codes(mutate(name,edit),name).includes(code),`${code} expected`);
  expect(MC,(_t,node)=>{node('mc-agents').content.mod='mission-control-nope';},'UNKNOWN_MOD');
  expect(MC,(_t,node)=>{node('mc-terminals').content.pane.header.content.mod='my-pane';},'UNKNOWN_MOD');
  expect(MC,(_t,node)=>{node('github').content.props.view='bogus';},'UNKNOWN_ROLE');
  expect(CLASSIC,(_t,node)=>{node('sessions').content.props={view:'panel',hideHeader:true};},'UNKNOWN_ROLE');
  expect(MC,(_t,node)=>{node('mc-agents').content.props='list';},'UNKNOWN_ROLE');
  expect(MC,(_t,node)=>{node('mc-rail-footer').content.props={view:'context'};},'OVERLAY_ROLE');
  expect(CLASSIC,(_t,node)=>{node('mc-navigation').content.props={view:'menu'};},'OVERLAY_ROLE');
  expect(MC,(_t,node)=>{node('mc-agents').content={mod:'mission-control-agent-menu'};},'OVERLAY_ROLE');
  expect(MC,(_t,node)=>{node('mc-agents').content.props={view:'unavailable'};},'OVERLAY_ROLE');
  expect(MC,(_t,node)=>{node('mc-agents').id='mc-spaces';},'DUPLICATE_ID');
  expect(MC,(_t,node)=>{node('mc-work-stack').header='tabs';},'SECOND_STRIP');
  expect(CLASSIC,(_t,node)=>{node('mc-main').children.unshift({id:'strip',type:'block',size:{px:30},content:{mod:'tabs'}});},'SECOND_STRIP');
  expect(MC,(t)=>{t.children.splice(1,0,{...clone(t.children[0]),id:'mc-topbar-2',window_drag:false});},'TOPBAR');
  expect(MC,(t)=>{t.children.reverse();},'TOPBAR');
  expect(MC,(_t,node)=>{node('mc-topbar').content.props.swapTo='mission-control-missing';},'SWAP');
  expect(CLASSIC,(_t,node)=>{node('mc-topbar').content.props.swapTo=CLASSIC;},'SWAP');
  expect(CLASSIC,(_t,node)=>{node('mc-work-panel').hidden=false;},'PANEL');
  expect(CLASSIC,(_t,node)=>{delete node('mc-topbar').content.props.panel;},'PANEL');
  expect(MC,(_t,node)=>{node('mc-work').id='mc-work-panel';},'PANEL');
  expect(MC,(_t,node)=>{node('mc-work-stack').children.splice(4,1);},'STACK');
  expect(CLASSIC,(_t,node)=>{node('merges').content.props.hideHeader=false;},'STACK');
  expect(MC,(_t,node)=>{node('mc-work-stack').children.reverse();},'STACK');
  expect(MC,(_t,node)=>{node('mc-main').id='mc-overview';},'NODES');
  expect(MC,(_t,node)=>{node('mc-work').children.reverse();},'NAVIGATION');
  expect(MC,(_t,node)=>{node('sidebar').children.reverse();},'FOOTER');
  expect(CLASSIC,(_t,node)=>{node('sidebar').children.pop();},'FOOTER');
  expect(MC,(t)=>{t.children.push({id:'status',type:'block',size:{px:28},content:{mod:'workspace-status'}});},'FOOTER');
  expect(MC,(_t,node)=>{node('mc-rail-lists').children.reverse();},'RAIL');
  expect(CLASSIC,(_t,node)=>{node('mc-main').children.reverse();},'TERMINALS');
  expect(MC,(t)=>{t.preview='layouts/main.svg';},'PREVIEW');
  expect(MC,(_t,node)=>{node('sidebar').size={px:-1};},'SIZE');
  expect(MC,(_t,node)=>{node('mc-spaces').content.tab='active';},'CONTENT');
  expect(MC,(_t,node)=>{node('mc-work-stack').active='nope';},'TREE_SHAPE');
  assert.deepEqual(codes(LAYOUTS[MC].tree,CLASSIC).sort().filter((v,i,a)=>a.indexOf(v)===i),['PANEL','PREVIEW','STACK','SWAP','TERMINALS'],'a tree checked under the wrong name fails');
});
