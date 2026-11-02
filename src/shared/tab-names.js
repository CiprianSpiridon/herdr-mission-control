/**
 * Automatic tab names and their manual-ownership transitions (TabNames v1). Pure: no IO, clock,
 * GPUI or Node APIs, so standalone tabs/sessions/reopen bundles can all carry it.
 *
 * Authority: a TASK-070 origin record (names.json, keyed by stable originId and exact session)
 * owns mode/manualName/lastAutoName for every origin-linked tab. A machine/tab entry here is only
 * the current instance link, its captured task metadata and pending writes, plus the ownership of
 * plain tabs that never had an origin. Nothing here invents a manual name.
 */
export class TabNamesError extends Error {constructor(code,message){super(message);this.name='TabNamesError';this.code=code;}}
const fail=(code,message)=>{throw new TabNamesError(code,message);};
/** displayPx: the tab label budget. chars: what tab.rename ever writes. titleChars: full titles kept for hover. */
export const NAME_LIMITS=Object.freeze({displayPx:280,charPx:7,chars:80,titleChars:200,storedChars:1024,entries:1000,retired:64,bytes:512*1024});
/** settleMs: a new name must be seen in two polls. pendingMs: how long a stale snapshot may still show the old name. */
export const NAME_TIMING=Object.freeze({settleMs:2500,pendingMs:10000,retryMs:5000,maxRetryMs:60000,tries:3,intentMs:15000,missingMs:30000,unavailableMs:7*86400000,retiredMs:86400000});
export const SOURCE_KINDS=Object.freeze(['jira','github','github-pr','gitlab','gitlab-mr']);
const clone=v=>JSON.parse(JSON.stringify(v));
const freeze=v=>{if(v&&typeof v==='object'&&!Object.isFrozen(v)){for(const c of Object.values(v))freeze(c);Object.freeze(v);}return v;};
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const time=v=>Number.isSafeInteger(v)&&v>=0;
const RESERVED=new Set(['__proto__','prototype','constructor']);
const id=(v,max=256)=>typeof v==='string'&&v.length>0&&v.length<=max&&!RESERVED.has(v)&&!/[\u0000-\u001f\u007f]/.test(v);
const stored=v=>typeof v==='string'&&v.length<=NAME_LIMITS.storedChars;
const CONTROL=/[\u0000-\u001f\u007f-\u009f]/g,INVISIBLE=/[​-‏‪-‮⁠-⁩﻿]/g,HAS_CONTROL=/[\u0000-\u001f\u007f]/;
const chars=s=>Array.from(s);
/** Bounded by code points; a cut name ends with an ellipsis. */
export function clip(value,max=NAME_LIMITS.chars){const a=chars(value);return a.length<=max?value:a.slice(0,Math.max(1,max-1)).join('').trimEnd()+'…';}
/** Display text only: control/bidi/zero-width characters go, whitespace collapses, length is bounded. */
export function cleanText(value,max=NAME_LIMITS.chars){if(typeof value!=='string')return null;const s=value.replace(CONTROL,' ').replace(INVISIBLE,'').replace(/\s+/g,' ').trim();return s?clip(s,max):null;}
const KEY=/^[A-Z][A-Z0-9_]{0,30}(?:-[A-Z]{1,8})?-[1-9][0-9]{0,11}$/;
/** Jira ABC-123, GitHub GH-42 / GH-PR-42, GitLab GL-142 / GL-MR-42. Anything else is not an identity. */
export const issueKey=v=>typeof v==='string'&&KEY.test(v)?v:null;
const stripKey=(title,key)=>{const m=title.match(new RegExp('^[\\[(]?'+key.replace(/[-]/g,'\\-')+'[\\])]?(?:[\\s:·–—-]+|$)'));return m?title.slice(m[0].length).trim()||null:title;};
/** "KEY title" with the key always kept whole at the front; only the title part is shortened. */
export function composeName(key,title,max=NAME_LIMITS.chars){
  const k=issueKey(key),t=cleanText(title,NAME_LIMITS.titleChars);
  if(!k)return t?clip(t,max):null;
  const rest=t?stripKey(t,k):null;return rest?k+' '+clip(rest,Math.max(1,max-k.length-1)):k;
}
const SHELLS=new Set(['sh','bash','zsh','fish','nu','nushell','pwsh','powershell','dash','ksh','tcsh','csh','elvish','xonsh','login','shell']);
const GENERIC=new Set(['agent','terminal','shell','program','tab','new tab','claude','claude code','codex','grok','gemini','aider','opencode','cursor agent','pi','amp','goose','qwen','kiro','copilot','crush','droid']);
/** Herdr's own + menu names agent tabs after the agent; these are launcher defaults, not user names. */
export const DEFAULT_TOOL_NAMES=Object.freeze(['Claude Code','Claude','Codex','Grok','Gemini','Aider','OpenCode','Cursor Agent','Amp','Goose','Qwen','Kiro','Copilot','Crush','Droid','Pi','Terminal','Shell']);
const LEAD=/^[\p{So}\p{Sk}\p{Co}·•*\s]+/u;
/**
 * A tool's reported conversation/task title, or null. Spinner/status glyphs are stripped; paths,
 * prompts, numbers, command lines and the tool's own name are not conversation titles.
 */
export function reportedTitle(title,{generic=new Set(),commands=new Set()}={}){
  let s=cleanText(title,NAME_LIMITS.titleChars);if(!s)return null;s=s.replace(LEAD,'').trim();if(!s)return null;
  // Shells and programs report their own lowercase name ("zsh", "-zsh", "zsh: ~/repo"); a
  // conversation title such as "Login loop" or "Shell script cleanup" is not one.
  const lower=s.toLowerCase(),first=s.split(/\s/)[0].replace(/^-/,'').replace(/:$/,'');
  if(/^\d+$/.test(s)||/^[/~]/.test(s)||/^[A-Za-z]:[\\/]/.test(s)||/^[^\s@]+@[^\s:]+:/.test(s)||/(^|\s)--?[a-z]/i.test(s))return null;
  if(GENERIC.has(lower)||generic.has(lower)||SHELLS.has(first)||commands.has(first))return null;
  return s;
}
/** The folder's own name; the home folder is "~", as in Herdr's space names. */
export function folderName(cwd,{home=null}={}){
  if(typeof cwd!=='string'||!cwd||cwd.length>4096||HAS_CONTROL.test(cwd))return null;
  const path=cwd.replace(/\\/g,'/').replace(/\/+$/,'')||'/',h=typeof home==='string'&&home?home.replace(/\\/g,'/').replace(/\/+$/,''):null;
  if(h&&path===h)return '~';if(path==='/')return '/';return cleanText(path.slice(path.lastIndexOf('/')+1));
}
const machineOf=m=>m===null||m===undefined?null:id(m,128)?m:fail('INVALID_TAB_NAMES','Invalid machine');
/** Machine-qualified tab identity, the same key TASK-070 indexes current tabs by. */
export const tabKey=(machine,tabId)=>{if(!id(tabId))fail('INVALID_TAB_NAMES','Invalid tab ID');return JSON.stringify([machineOf(machine),tabId]);};
const isAgent=p=>p.program?.agent===true||typeof p.status==='string'&&p.status!==''||typeof p.app==='string'&&p.app!=='';
function programOf(p){const g=plain(p.program)?p.program:{},key=typeof g.key==='string'&&/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(g.key)?g.key:null;return {key,name:cleanText(g.name,64),shell:g.shell===true||key==='shell',agent:isAgent(p)};}
/** One live tab (TabInfo) and its panes. Mod-only tabs are not eligible for automatic names. */
export function observeTab(tab,panes=[],{machine=null}={}){
  if(!plain(tab)||!id(tab.id))fail('INVALID_TAB_NAMES','Invalid tab');const m=machineOf(machine);
  const terms=(Array.isArray(panes)?panes:[]).filter(p=>plain(p)&&p.tab===tab.id&&typeof p.terminal==='string'&&p.terminal).slice(0,16),primary=terms.find(isAgent)||terms[0]||null;
  return freeze({key:tabKey(m,tab.id),machine:m,tabId:tab.id,name:typeof tab.name==='string'?tab.name.slice(0,NAME_LIMITS.storedChars):'',named:tab.named===true,eligible:Boolean(primary),
    primary:primary?{program:programOf(primary),title:typeof primary.title==='string'?primary.title.slice(0,1024):null,cwd:typeof primary.cwd==='string'?primary.cwd.slice(0,4096):null,app:cleanText(primary.app,64),terminal:cleanText(primary.terminal,128)}:null,
    programs:[...new Set(terms.map(p=>programOf(p).name).filter(Boolean))].slice(0,16)});
}
export const emptyMeta=()=>({key:null,title:null,kind:null,tool:null,initial:null});
/** Captured task identity: launch journal source, resume/reopen reported title, tool. Invalid fields drop to null. */
export function normalizeMeta(v){
  if(!plain(v))return emptyMeta();
  const toolKey=plain(v.tool)?v.tool.key:v.toolKey,tool=typeof toolKey==='string'&&/^[A-Za-z0-9][A-Za-z0-9._+-]{0,95}$/.test(toolKey)?{key:toolKey,name:cleanText(plain(v.tool)?v.tool.name:v.toolName,64)}:null;
  const key=issueKey(v.key),title=cleanText(v.title,NAME_LIMITS.titleChars);
  return {key,title:key&&title?stripKey(title,key):title,kind:SOURCE_KINDS.includes(v.kind)?v.kind:null,tool,initial:cleanText(v.initial,NAME_LIMITS.chars)};
}
/** Fills only what is still unknown; captured identity never changes under a tab. */
export function mergeMeta(base,extra){const a=normalizeMeta(base),b=normalizeMeta(extra);return {key:a.key??b.key,title:a.title??(a.key&&b.key&&a.key!==b.key?null:b.title),kind:a.kind??b.kind,tool:a.tool??b.tool,initial:a.initial??b.initial};}
function genericNames(obs,meta,{home=null,knownNames=[]}={}){
  const out=new Set(),add=v=>{const s=cleanText(v,NAME_LIMITS.titleChars);if(s)out.add(s.toLowerCase());},p=obs.primary;
  // Herdr 0.1.11 titles a pane with its terminal ID until the program reports one; that ID is never a task title.
  if(p){add(p.program.key);add(p.program.name);add(p.app);add(folderName(p.cwd,{home}));add(p.terminal);add(p.terminal?.split('/').pop());}
  for(const n of obs.programs)add(n);add(meta.tool?.key);add(meta.tool?.name);for(const n of [...DEFAULT_TOOL_NAMES,...knownNames])add(n);
  return out;
}
const commandNames=(obs,meta)=>new Set([obs.primary?.program.key,obs.primary?.app,meta.tool?.key].filter(Boolean).map(s=>s.toLowerCase()));
/**
 * The automatic name, or null. Order: issue/PR key + (reported conversation title, else task title,
 * else tool); reported title; task title; agent tool name; shell's running program; shell folder.
 */
export function deriveName(obs,meta=null,{home=null,knownNames=[]}={}){
  if(!obs?.eligible)return null;const p=obs.primary,m=normalizeMeta(meta),agent=p.program.agent;
  const tool=agent?{key:p.program.key??m.tool?.key??null,name:p.program.name||m.tool?.name||p.app||null}:m.tool;
  const reported=agent?reportedTitle(p.title,{generic:genericNames(obs,m,{home,knownNames}),commands:commandNames(obs,m)}):null,title=reported??m.title;
  let full,basis;const keyed=t=>{const rest=t?stripKey(t,m.key):null;return rest?m.key+' '+rest:m.key;},beside=title??(agent?tool?.name??null:null);
  if(m.key){full=keyed(beside);basis=reported?'reported':title?'task':'key';}
  else if(title){full=title;basis=reported?'reported':'task';}
  else if(agent){full=tool?.name||(tool?.key&&!['agent','program'].includes(tool.key)?tool.key:null)||'Agent';basis='tool';}
  else if(!p.program.shell&&p.program.name){full=p.program.name;basis='program';}
  else{full=folderName(p.cwd,{home});basis='folder';if(!full&&p.program.name){full=p.program.name;basis='program';}}
  full=cleanText(full,NAME_LIMITS.titleChars);if(!full)return null;
  const name=m.key?composeName(m.key,beside):clip(full,NAME_LIMITS.chars);
  return freeze({name,full,basis,key:m.key,tool:tool?{key:tool.key??null,name:tool.name??null}:null});
}
const WIDE=/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/u;
export function estimateWidth(text,{charPx=NAME_LIMITS.charPx}={}){let w=0;for(const c of chars(text||''))w+=WIDE.test(c)?charPx*2:charPx;return w;}
/** Fits a label to the 280px budget, keeping a leading issue/PR key; full stays available for hover. */
export function displayLabel(name,{maxPx=NAME_LIMITS.displayPx,charPx=NAME_LIMITS.charPx,full=null}={}){
  const text=cleanText(name,NAME_LIMITS.titleChars)||'',whole=cleanText(full,NAME_LIMITS.titleChars)||text;
  if(estimateWidth(text,{charPx})<=maxPx)return freeze({text,full:whole,truncated:whole!==text});
  const head=text.split(' ')[0],keep=issueKey(head)?chars(head).length:1,a=chars(text);
  while(a.length>keep&&estimateWidth(a.join('').trimEnd()+'…',{charPx})>maxPx)a.pop();
  return freeze({text:a.join('').trimEnd()+'…',full:whole,truncated:true});
}
function candidates(obs,meta,derived,{home,knownNames}){
  const out=new Set(),add=v=>{const s=cleanText(v,NAME_LIMITS.chars);if(s)out.add(s);},p=obs.primary;
  add(derived?.name);for(const n of obs.programs)add(n);if(p){add(p.program.name);add(p.app);add(folderName(p.cwd,{home}));}
  add(meta.tool?.name);add(meta.initial);if(meta.key)add(composeName(meta.key,meta.title));for(const n of [...DEFAULT_TOOL_NAMES,...knownNames])add(n);
  return out;
}
/** TASK-070 record, normalized for this machine; anything malformed is treated as unknown ownership. */
function ownership(own){
  if(!plain(own)||!id(own.originId)||!['auto','manual'].includes(own.mode))return null;
  const name=v=>typeof v==='string'&&v?v:null,r={originId:own.originId,mode:own.mode,manualName:name(own.manualName),lastAutoName:name(own.lastAutoName)};
  return r.mode==='manual'&&!r.manualName?null:r;
}
export function newEntry(obs,now){return {machine:obs.machine,tabId:obs.tabId,originId:null,mode:'auto',manual:null,lastName:null,meta:emptyMeta(),candidate:null,pending:null,attempt:null,retryAt:0,stuck:null,orphan:null,transfer:false,intent:null,missingSince:null,firstSeen:now};}
// The entry stays a mutable plain copy: the caller persists it and may sweep it later.
const result=(entry,action,reason,derived,extra={})=>Object.freeze({entry,action:action?freeze(action):null,reason,derived,retiredUsed:-1,...extra});
function expire(e,now,T){
  const p=e.pending,tries=e.attempt&&e.attempt.name===p.to?e.attempt.tries:1;e.pending=null;
  e.retryAt=now+Math.min(T.maxRetryMs,T.retryMs*2**(tries-1));if(tries>=T.tries)e.stuck=p.to;
}
function emit(e,obs,kind,to,now,action,derived){
  const tries=e.attempt&&e.attempt.name===to?Math.min(e.attempt.tries+1,9):1;e.attempt={name:to,tries};e.candidate=null;
  e.pending={kind,from:obs.name,fromNamed:obs.named,to,at:now};
  return result(e,freeze({...action,key:obs.key,machine:obs.machine,tabId:obs.tabId,name:to,from:obs.name,fromNamed:obs.named}),kind,derived);
}
function capture(e,name,obs,{home,knownNames}){
  // A name launch/resume/reopen recorded as automatic: for an agent tab it is the task title to keep.
  if(e.meta.title||!(obs.primary?.program.agent||e.meta.tool))return;
  let t=cleanText(name,NAME_LIMITS.titleChars);if(t&&e.meta.key)t=stripKey(t,e.meta.key);
  if(t&&!genericNames(obs,e.meta,{home,knownNames}).has(t.toLowerCase())&&!SHELLS.has(t.toLowerCase())&&!GENERIC.has(t.toLowerCase()))e.meta.title=t;
}
/**
 * One transition for one live tab instance. Inputs: the previous entry (null on first sight), the
 * observation, TASK-070 ownership for this tab (or null), captured metadata and the clock. Returns
 * the next entry and at most one action:
 *   rename     {originId|null, direct?}  write an automatic name (origin: via applyName; direct: repair)
 *   transfer   {originId}                apply a transferred manual name once for this instance
 *   automatic  {originId}                record back-to-auto after the tab returned to Herdr's name
 * States: auto / manual(observed|adopted) for plain tabs, mirrored from ownership for origin tabs;
 * a pending write holds every conclusion until it lands or expires. linking: an unfinished launch is
 * still attaching its origin to this tab, so no automatic write happens yet.
 */
export function reconcileTab(previous,obs,options={}){
  const {now,meta=null,home=null,knownNames=[],retired=[],failed=false,emit:allowed=true,linking=false}=options,T={...NAME_TIMING};
  for(const k of ['settleMs','pendingMs'])if(options[k]!==undefined){if(!time(options[k]))fail('INVALID_TAB_NAMES','Invalid timing');T[k]=options[k];}
  if(!time(now))fail('INVALID_TAB_NAMES','A clock reading is required');
  if(!obs?.eligible)return result(previous?clone(previous):null,null,'ineligible',null);
  const own=ownership(options.own),fresh=!previous,e=fresh?newEntry(obs,now):clone(previous);
  e.missingSince=null;e.meta=mergeMeta(e.meta,meta);e.originId=own?.originId??null;
  const ctx={home,knownNames},derive=()=>deriveName(obs,e.meta,ctx);let derived=derive(),retiredUsed=-1;
  const done=(action,reason)=>action?result(e,action,reason,derived,{retiredUsed}):result(e,null,reason,derived,{retiredUsed});
  if(fresh&&!own){
    if(!obs.named)e.mode='auto';
    else if(candidates(obs,e.meta,derived,ctx).has(obs.name))e.lastName=obs.name;
    else if((retiredUsed=(Array.isArray(retired)?retired:[]).findIndex(r=>r&&r.machine===obs.machine&&r.name===obs.name&&now-r.at<NAME_TIMING.retiredMs))>=0)e.lastName=obs.name;
    // A name this tab already had that cannot be proven ours is kept as the user's.
    else{e.mode='manual';e.manual={name:obs.name,source:'adopted'};}
  }
  if(failed&&e.pending)expire(e,now,T);
  // 1. A pending write: a stale snapshot still showing the old name proves nothing either way.
  if(e.pending){
    const p=e.pending,landed=obs.named&&obs.name===p.to,unchanged=obs.named===p.fromNamed&&obs.name===p.from;
    if(landed){e.pending=null;e.attempt=null;e.stuck=null;e.retryAt=0;e.orphan=null;if(p.kind==='rename')e.lastName=p.to;else e.transfer=true;}
    else if(unchanged&&now-p.at<T.pendingMs)return done(null,'pending');
    else if(unchanged){if(own?.mode==='auto'&&p.kind==='rename'&&p.fromNamed&&own.lastAutoName===p.to)e.orphan={from:p.from,to:p.to};expire(e,now,T);}
    else e.pending=null;
  }
  // 2. Ownership. Origin tabs follow TASK-070; plain tabs follow this entry.
  if(own){
    e.mode=own.mode;e.manual=own.mode==='manual'?{name:own.manualName,source:'observed'}:null;
    if(own.mode==='manual'){
      e.orphan=null;
      if(!obs.named){
        // Herdr's own name again: the documented route back to automatic naming (back-to-auto intent).
        e.candidate=null;e.intent=e.intent||{at:now,sent:null};if(e.intent.sent!==null&&now>=e.intent.sent&&now-e.intent.sent<T.intentMs)return done(null,'resetting');
        e.intent.sent=now;return done(freeze({type:'automatic',originId:own.originId,key:obs.key,machine:obs.machine,tabId:obs.tabId}),'automatic');
      }
      e.intent=null;
      if(!e.transfer){
        // Once per acknowledged instance: a replacement still showing its placeholder gets the transferred name.
        if(obs.name===own.manualName)e.transfer=true;
        else if(obs.name===own.lastAutoName){
          if(e.stuck===own.manualName){e.transfer=true;e.candidate=null;return done(null,'stuck');}
          if(now<e.retryAt)return done(null,'backoff');
          if(e.candidate?.name!==own.manualName){e.candidate={name:own.manualName,since:now};return done(null,'settling');}
          if(now-e.candidate.since<T.settleMs)return done(null,'settling');
          if(!allowed)return done(null,'deferred');
          return emit(e,obs,'transfer',own.manualName,now,{type:'transfer',originId:own.originId},derived);
        }else e.transfer=true;
      }
      e.candidate=null;return done(null,'manual');
    }
    e.intent=null;e.transfer=true;
    if(e.orphan){
      // Our own recorded name never reached the tab (an interrupted command): finish that same write.
      if(obs.named&&obs.name===e.orphan.from&&own.lastAutoName===e.orphan.to){if(e.stuck===e.orphan.to)return done(null,'stuck');if(now<e.retryAt)return done(null,'backoff');if(!allowed)return done(null,'deferred');return emit(e,obs,'rename',e.orphan.to,now,{type:'rename',originId:own.originId,direct:true},derived);}
      e.orphan=null;
    }
    // A name the record does not know is either an unrecorded user edit or another writer: wait.
    if(obs.named&&obs.name!==own.lastAutoName){e.candidate=null;return done(null,'awaiting-observer');}
    if(obs.named&&e.lastName!==own.lastAutoName){capture(e,own.lastAutoName,obs,ctx);derived=derive();}
    e.lastName=own.lastAutoName;
  }else{
    if(!obs.named){if(e.mode==='manual'){e.mode='auto';e.manual=null;}e.lastName=null;}
    else if(e.mode==='manual'){
      if(obs.name!==e.manual.name)e.manual={name:obs.name,source:'observed'};
      else if(e.manual.source==='adopted'&&candidates(obs,e.meta,derived,ctx).has(obs.name)){e.mode='auto';e.manual=null;e.lastName=obs.name;}
      if(e.mode==='manual'){e.candidate=null;return done(null,'manual');}
    }else if(obs.name!==e.lastName){e.mode='manual';e.manual={name:obs.name,source:'observed'};e.candidate=null;return done(null,'manual');}
  }
  // 3. Automatic naming: one write per settled change; the same name is never written twice.
  if(!derived){e.candidate=null;return done(null,'no-name');}
  if(obs.named&&obs.name===derived.name){if(!own)e.lastName=obs.name;e.candidate=null;e.stuck=null;e.attempt=null;return done(null,'unchanged');}
  if(e.stuck&&e.stuck!==derived.name)e.stuck=null;
  if(e.stuck===derived.name)return done(null,'stuck');
  if(now<e.retryAt)return done(null,'backoff');
  if(e.candidate?.name!==derived.name){e.candidate={name:derived.name,since:now};return done(null,'settling');}
  if(now-e.candidate.since<T.settleMs)return done(null,'settling');
  if(linking&&!own)return done(null,'linking');
  if(!allowed)return done(null,'deferred');
  return emit(e,obs,'rename',derived.name,now,{type:'rename',originId:own?.originId??null},derived);
}
/** Entries whose tab is gone: a ready host drops them after missingMs, an unavailable one after unavailableMs. */
export function sweep(state,{live,ready,now}){
  for(const [key,e]of Object.entries(state.tabs)){
    if(live.has(key))continue;if(e.missingSince===null){e.missingSince=now;continue;}
    const up=ready(e.machine);if(now-e.missingSince<(up?NAME_TIMING.missingMs:NAME_TIMING.unavailableMs))continue;
    // A closed plain tab's automatic name: if reopen restores it as a fixed name, it is still ours.
    if(up&&!e.originId&&e.mode==='auto'&&e.lastName)state.retired.push({machine:e.machine,name:e.lastName,at:now});
    delete state.tabs[key];
  }
  state.retired=state.retired.filter(r=>now-r.at<NAME_TIMING.retiredMs).slice(-NAME_LIMITS.retired);
  return state;
}
export const emptyTabNames=()=>({v:1,revision:0,lease:null,tabs:{},retired:[]});
const nullable=(v,f)=>v===null?null:f(v);
const bad=()=>fail('INVALID_TAB_NAMES','Tab names are invalid; the original file was kept unchanged.');
const ok=(test,v)=>test?v:bad();
function entry(key,e){
  if(!plain(e)||!id(e.tabId)||!['auto','manual'].includes(e.mode)||typeof e.transfer!=='boolean'||!time(e.retryAt)||!time(e.firstSeen))bad();
  const machine=e.machine===null?null:ok(id(e.machine,128),e.machine);if(key!==tabKey(machine,e.tabId))bad();
  const name=v=>ok(stored(v),v),manual=nullable(e.manual,m=>ok(plain(m)&&stored(m.name)&&['observed','adopted'].includes(m.source),{name:m.name,source:m.source}));
  if((e.mode==='manual')!==(manual!==null))bad();
  const m=e.meta;if(!plain(m))bad();
  const meta={key:nullable(m.key,v=>ok(issueKey(v),v)),title:nullable(m.title,name),kind:nullable(m.kind,v=>ok(SOURCE_KINDS.includes(v),v)),tool:nullable(m.tool,t=>ok(plain(t)&&id(t.key,96)&&(t.name===null||stored(t.name)),{key:t.key,name:t.name})),initial:nullable(m.initial,name)};
  const pending=nullable(e.pending,p=>ok(plain(p)&&['rename','transfer'].includes(p.kind)&&stored(p.from)&&typeof p.fromNamed==='boolean'&&stored(p.to)&&p.to!==''&&time(p.at),{kind:p.kind,from:p.from,fromNamed:p.fromNamed,to:p.to,at:p.at}));
  return {machine,tabId:e.tabId,originId:nullable(e.originId,v=>ok(id(v),v)),mode:e.mode,manual,lastName:nullable(e.lastName,name),meta,
    candidate:nullable(e.candidate,c=>ok(plain(c)&&stored(c.name)&&time(c.since),{name:c.name,since:c.since})),pending,
    attempt:nullable(e.attempt,a=>ok(plain(a)&&(a.name===null||stored(a.name))&&Number.isSafeInteger(a.tries)&&a.tries>=1&&a.tries<=9,{name:a.name,tries:a.tries})),
    retryAt:e.retryAt,stuck:nullable(e.stuck,name),orphan:nullable(e.orphan,o=>ok(plain(o)&&stored(o.from)&&stored(o.to),{from:o.from,to:o.to})),transfer:e.transfer,
    intent:nullable(e.intent,i=>ok(plain(i)&&time(i.at)&&(i.sent===null||time(i.sent)),{at:i.at,sent:i.sent})),missingSince:nullable(e.missingSince,v=>ok(time(v),v)),firstSeen:e.firstSeen};
}
/** TabNames v1 file. Invalid data is rejected whole and never rewritten by the caller. */
export function validateTabNames(value){
  if(!plain(value)||value.v!==1||!time(value.revision)||!plain(value.tabs)||!Array.isArray(value.retired))bad();
  if(Object.keys(value.tabs).length>NAME_LIMITS.entries||value.retired.length>NAME_LIMITS.retired)fail('TAB_NAMES_CAPACITY','Tab names exceed their supported size.');
  const lease=nullable(value.lease,l=>ok(plain(l)&&id(l.owner)&&time(l.expiresAt),{owner:l.owner,expiresAt:l.expiresAt})),tabs={};
  for(const [key,e]of Object.entries(value.tabs))tabs[key]=entry(key,e);
  const retired=value.retired.map(r=>ok(plain(r)&&(r.machine===null||id(r.machine,128))&&stored(r.name)&&r.name!==''&&time(r.at),{machine:r.machine,name:r.name,at:r.at}));
  return {v:1,revision:value.revision,lease,tabs,retired};
}
