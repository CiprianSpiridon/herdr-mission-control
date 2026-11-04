import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {NativeRuntime,NativeIsolationError,run,until,createFixtureService,isolatedEnvironment,validateNativeIsolationReceipt} from '../../scripts/native-harness.mjs';
import {buildPackage} from '../../scripts/project.mjs';
import {bindingKey,newConfig,validateConfig} from '../../src/shared/config.js';
import {localTerminalAddress,terminalIdentity} from '../../src/shared/session-identity.js';
import {BindingStore,argvSessionProof} from '../../src/shared/session-bindings.js';
import {parseCapabilities} from '../../src/shared/tool-capabilities.js';
import {validateUsageSource} from '../../src/shared/usage-sources.js';
import {issueIdentityKey} from '../../src/shared/tracker-model.js';
import {LIMITS as CLOSED} from '../../src/shared/closed-tabs.js';
import {gitlabFixtures,fixtureEnvironment as gitlabEnvironment} from './gitlab.mjs';
import {githubFixtures,fixtureEnvironment as githubEnvironment} from './github.mjs';
import {writeHistory} from './sessions.mjs';
import {viaSource,fileIO} from './reopen.mjs';

/*
 * Integrated mounted proof (TASK-007) for both Mission Control layouts. One private app/core with the
 * seven finished mods installed from fresh per-mod builds and the exact bundle layout sources, plus a
 * second positively owned private core reached only through `hc machine add --via` (qa-server). That
 * second host is a controlled local transport, never evidence of a real remote machine; if it cannot be
 * established the remote gate is recorded as failed and the run fails. Every swap, panel, source, scope,
 * card, menu, rename, close, reopen, history, rail and footer action below is real PID-bound native input;
 * `herdr-app do` / `hc` calls are fixture setup (spaces, fixture tabs, focus of the captured checkout,
 * window placement) or read-only observation. Provider data comes only from owned localhost TLS fixtures
 * (Jira, GitHub, GitLab) with synthetic per-account tokens; disposable actors record argv/cwd/stdin. All
 * fixtures live under the private runtime directories. The overview frame is promoted only by
 * `promote-preview`, after the harness has written and validated a passing receipt.
 */
const MOD_TABS='mission-control-tabs',HOST='qa-server',PREVIEW='layout-preview',CLASSIC_FRAME='layout-classic',RECEIPT='evidence/native/layout.json',BUDGET=1100,AGENTS=30;
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const SELECTOR_KEYS=['HOME','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_RUNTIME_DIR','HC_SESSION','HERDR_APP_HOME'];
const execute=promisify(execFile),delay=ms=>new Promise(resolve=>setTimeout(resolve,ms)),sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const exists=file=>fs.access(file).then(()=>true,()=>false);
const readText=async file=>{try{return await fs.readFile(file,'utf8');}catch(error){if(error.code==='ENOENT')return null;throw error;}};
const readJson=async file=>{const raw=await readText(file);return raw===null?null:JSON.parse(raw);};
const MOJIBAKE=/Ã[\u0080-¿]|Â[ -¿]|â€|�/,BANNER=/\binterrupted\b|could not be re.?rendered|render(?:ing)? (?:error|failed)|could not complete this action/i;
const SLEEPER=label=>['python3','-u','-c',`import time; print(${JSON.stringify('Mission Control layout fixture: '+label)},flush=True); time.sleep(3600)`];

export const PREVIEW_LABEL=PREVIEW,CLASSIC_LABEL=CLASSIC_FRAME,RECEIPT_PATH=RECEIPT;
export const LAYOUTS=Object.freeze({overview:'mission-control',classic:'mission-control-classic'});
/** The destination label each layout's swap control shows (navigation.js LAYOUT_LABELS). */
export const LAYOUT_LABELS=Object.freeze({[LAYOUTS.overview]:'Mission Control',[LAYOUTS.classic]:'Classic view'});
export const LAYOUT_FILES=Object.freeze(['mission-control.json','mission-control-classic.json','mission-control.svg','mission-control-classic.svg']);
/** Every finished mod either layout mounts; exactly these are installed. */
export const MODS=Object.freeze(['mission-control-agents','mission-control-github','mission-control-gitlab','mission-control-jira','mission-control-mods','mission-control-sessions','mission-control-spaces','mission-control-tabs']);
export const STATE_KEYS=Object.freeze({nav:'mission-control-tabs-nav-v1',spaces:'mission-control-spaces-v1',agents:'mission-control-agents-v1'});
/** The seven work sources in navigation order: labels, own persisted UI key, and the text that only that view shows. */
export const SOURCES=Object.freeze([
  {id:'jira',full:'Jira',short:'Jira',key:'mission-control-jira-ui-v1',marker:'WEB-142',search:'Search issues'},
  {id:'github',full:'GitHub issues',short:'GitHub',key:'mission-control-github-ui-v1',marker:'GH-142',search:'Search issues'},
  {id:'pulls',full:'Pull requests',short:'PRs',key:'mission-control-github-prs-ui-v1',marker:'Search pull requests',search:'Search pull requests'},
  {id:'gitlab',full:'GitLab issues',short:'GitLab',key:'mission-control-gitlab-ui-v1',marker:'GL-142',search:'Search issues'},
  {id:'merges',full:'Merge requests',short:'MRs',key:'mission-control-gitlab-mrs-ui-v1',marker:'Search merge requests',search:'Search merge requests'},
  {id:'sessions',full:'Previous sessions',short:'Sessions',key:'mission-control-sessions-ui-v1',marker:'Search sessions',search:'Search sessions'},
  {id:'mods',full:'Mods',short:'Mods',key:null,marker:'Search mods',search:'Search mods and layouts'}].map(Object.freeze));
const SOURCE=Object.fromEntries(SOURCES.map(s=>[s.id,s]));
const HEADINGS=new Set(SOURCES.flatMap(s=>[s.full,s.short]).map(v=>v.toLowerCase()));
/**
 * Logical-pixel geometry the clicks rely on, read from the finished layout JSON and mod sources; fixture-check
 * fails if they drift. Overview: topbar | rail(220) + 1 divider | mc-main [mc-work(weight 3: nav 34 + stack) / 1 /
 * mc-terminals(weight 2)]. Classic: topbar | rail | mc-main(padding 8, gap 8)[terminals, mc-work-panel 360].
 */
export const GEOMETRY=Object.freeze({x:60,y:60,width:1280,height:760,wide:1024,narrow:736,topbar:42,rail:220,divider:1,footer:69,nav:34,pad:8,gap:8,panel:360,workWeight:3,termWeight:2,workMin:160,
  control:26,controlGap:4,barRight:8,swapPadX:9,swapIcon:14,swapGap:6,topbarWide:720,navButton:26,navGap:2,navPadX:6,navHide:24,navFull:850,navShort:507,header:32,
  railSearch:{x:42,dy:37,width:142,height:22},agentSearch:{x:42,dy:36,width:142,height:22},agentButtons:{collapse:8,priority:132,spaces:160,sources:188},agentButton:24,agentIcon:{dx:22,size:15},
  board:{narrowBelow:768,padWide:14,padNarrow:10,columnWide:360,columnNarrow:460,columnGaps:24,cardInset:11,keyRow:14,rowGap:7,title:36,start:25,startStep:27,starts:106},
  merge:{narrowBelow:560,padWide:14,padNarrow:10,cardPad:11,icon:26,iconStep:28,controls:110,iconTop:20},dialog:{width:560,height:660}});
const G=GEOMETRY;
/** Disposable launch actors: help decides exact-session capability, app decides Herdr's real tool icon. */
export const TOOLS=Object.freeze({
  claude:{name:'QA claude',app:'claude-code',help:'Claude Code QA fixture\nUsage: claude [options] [prompt]\n --session-id <uuid>\n --resume [value]\n --model <model>',resumeHelp:''},
  codex:{name:'QA codex',app:'codex',help:'Codex CLI QA fixture\nUsage: codex [OPTIONS] [PROMPT]\n --model <MODEL>',resumeHelp:'Usage: codex resume [OPTIONS] [SESSION_ID] [PROMPT]'},
  grok:{name:'QA grok',app:'grok',help:'Grok Build TUI QA fixture\nUsage: grok [OPTIONS] [PROMPT]\n --model <MODEL>',resumeHelp:''}});
/** Saved provider history [key, provider, reported title, minutes ago, checkout]: the Sessions view's data. */
export const HISTORY=Object.freeze([['H1','claude','Trace token refresh',40,'repo'],['H2','claude','Review deployment checks',5,'linked'],['H3','codex',null,12,'repo'],['H4','claude','Draft billing notes',25,'billing']]);
export const REMOTE_HISTORY=Object.freeze([['R1','claude','Watch server health',3,'repo']]);
const TASKS=['Fix login redirect','Review token refresh','Improve account settings','Fix search filtering','Update request tracing','Review deployment checks','Repair pagination','Improve session recovery'];
/** Telemetry agents with exact session bindings: 0 = Codex with a reported context window; 2/3 = Claude sessions on one shared account. */
export const BOUND=Object.freeze([0,2,3]);
const JIRA=Object.freeze({work:{email:'work@example.invalid',token:'owned-jira-work',emailEnv:'QA_JIRA_WORK_EMAIL',tokenEnv:'QA_JIRA_WORK_TOKEN'},personal:{email:'personal@example.invalid',token:'owned-jira-personal',emailEnv:'QA_JIRA_PERSONAL_EMAIL',tokenEnv:'QA_JIRA_PERSONAL_TOKEN'}});
const CA=path.join(ROOT,'.harness/layout-fixture-cas.pem');
// The harness validates this explicit synthetic record before private startup. Importing leaves the parent environment unchanged.
export const fixtureEnvironment={NODE_EXTRA_CA_CERTS:CA,QA_MODS_FIXTURE:'1',QA_MODS_CATALOG_URL:'http://127.0.0.1:9/{kind}.json',[JIRA.work.emailEnv]:JIRA.work.email,[JIRA.work.tokenEnv]:JIRA.work.token,[JIRA.personal.emailEnv]:JIRA.personal.email,[JIRA.personal.tokenEnv]:JIRA.personal.token,
  QA_GITHUB_WORK:githubEnvironment.QA_GITHUB_WORK,QA_GITHUB_PERSONAL:githubEnvironment.QA_GITHUB_PERSONAL,QA_GITLAB_WORK:gitlabEnvironment.QA_GITLAB_WORK,QA_GITLAB_PERSONAL:gitlabEnvironment.QA_GITLAB_PERSONAL};
/** Opaque GitLab MR identity the owned fixture issues (gitlab.mjs). */
export const mrId=(profile,number)=>String((profile==='work'?9007199254740993n:9007199254741993n)+BigInt(number));

/** Every runtime.expect label this scenario emits (the package gate requires exactly these plus the harness's own). */
export const EXPECTATIONS=Object.freeze({
  installed:'Exactly the eight required Mission Control mods are installed from fresh builds, each passed herdr-app check, and both layout files and previews are byte-identical to the bundle sources',
  secondHost:'The second host is a separate positively owned private core reached only through a controlled via transport, not a real remote machine',
  spacesScale:'The private world holds 128 spaces and native rail search reaches and selects the 128th',
  classicStart:'Classic starts terminal-first under one topmost Mission Control tab bar with its work panel hidden',
  footerClassic:'Settings and Add machine sit at the bottom-left of the 220 px rail and open Herdr’s own Settings and machine dialogs',
  panelOpens:'The bar’s panel control opens the Classic work panel on its first source',
  quickSources:'In Classic the source buttons after the view swap open the work panel on their source, and the shown source’s button closes it',
  classicIcons:'The Classic panel draws all seven local source icons inside the panel',
  classicSeparated:'In Classic, Jira, GitHub issues, pull requests, GitLab issues, merge requests, previous sessions and Mods each show only their own view without a repeated heading',
  classicGitlabStart:'A pinned GitLab issue start in the Classic panel runs the chosen tool in a workspace-plus-issue worktree created from the focused linked checkout',
  autoName:'The issue agent tab is named automatically with its issue key and task title',
  repeatFocus:'Repeating the same pinned start focuses the existing issue agent instead of starting another',
  manualRename:'A real tab-menu rename gives the issue agent tab the person’s manual name',
  swapToOverview:'One swap click switches Classic to Mission Control keeping the selected space and tab, every tab, running terminal address and manual name',
  sourceKeptOverview:'Mission Control restores the source selected in Classic (GitLab issues)',
  overviewSeparated:'In Mission Control the seven navigation sources each show only their own view without a repeated heading',
  compactBoards:'Jira, GitHub and GitLab issue views are compact boards grouped into To do, In progress and Done',
  remoteIssueRoute:'An All-spaces GitLab issue sharing its provider ID with another account starts only on its own host, repository, project and account',
  duplicateJiraRoute:'An All-spaces Jira issue sharing its key and ID with another account starts only in its own space, repository and account',
  githubPinned:'A pinned GitHub issue start runs the third pinned tool from the focused linked checkout',
  overviewMergeReview:'A Mission Control merge-request review reaches its pinned tool from the focused linked checkout with the opaque MR identity',
  reopenAgent:'Closing the renamed agent through the tab menu and Reopen last agent resumes its exact session once in its original folder',
  manualNameReturns:'The person’s manual name returns once on the reopened agent tab',
  historyResume:'Previous sessions resumes an exact saved session in its own checkout on this Mac',
  historyAllSpaces:'Previous sessions in All spaces includes the second host’s history with its host label',
  contextMenuTarget:'Right-clicking another space opens that space’s own menu, including Previous sessions, without changing the selected space',
  rightClickLaunch:'New agent from that menu starts in the right-clicked space’s repository on its own machine',
  noFallback:'A space without a repository shows no other repository’s issues',
  dozensAgents:'The Agents section lists dozens of agents from both hosts',
  contextQuota:'Agent rows show exact session context and shared-account quota as separate readings',
  agentIcons:'Agent rows draw the actual tool icon beside each task name',
  agentGrouping:'The Priority and Spaces quick actions regroup the agents list',
  swapToClassic:'One swap click switches Mission Control back to Classic keeping the selected space and tab, running terminal addresses and manual names',
  sourceKeptClassic:'Classic restores the source selected in Mission Control (merge requests)',
  heldRemoteMerge:'A held All-spaces merge-request action keeps its captured host, project and account through space and scope changes',
  offlineHost:'With the second host offline its spaces read offline and its actions start nothing, while a local action still starts',
  reconnect:'The second host’s spaces return after its transport reconnects',
  classicNarrow:'At 736 px Classic keeps the swap, all seven panel sources and the bottom-left footer reachable without clipping',
  overviewNarrow:'At 736 px beside the 220 px rail all seven sources show whole short labels and a short-label source can be selected',
  footerNarrow:'At 736 px the bottom-left Add machine control still opens Herdr’s machine dialog',
  overviewWide:'At 1024 px beside the 220 px rail all seven sources show whole short labels (seven full labels need 850 px) and remain selectable',
  classicWide:'At 1024 px the Classic panel’s seven sources remain drawn and selectable',
  narrowSwaps:'Swaps at 736 and 1024 px keep the selected space and tab, terminal addresses and manual names',
  utf8:'No observed native text shows mojibake or replacement characters',
  noErrors:'Both layouts with all eight mods produced zero native app errors',
  providersReadOnly:'Every owned provider request was read-only and carried only its own account’s synthetic fixture credentials'
});

// ---------------------------------------------------------------------------------------------
// Geometry: regions of each layout in window coordinates.
// ---------------------------------------------------------------------------------------------
/** The mc-work-stack block (the shown source) for a layout at a window size. */
export function stackRect(view,w){
  if(view===LAYOUTS.overview){const x=G.rail+G.divider,main=w.height-G.topbar-G.divider,work=Math.max(G.workMin,main*G.workWeight/(G.workWeight+G.termWeight));return {x,y:G.topbar+G.nav,width:w.width-x,height:work-G.nav};}
  const x=w.width-G.pad-G.panel,y=G.topbar+G.pad+G.nav;return {x,y,width:G.panel,height:w.height-G.pad-y};
}
/** The seven-source navigation strip. */
export function navRect(view,w){return view===LAYOUTS.overview?{x:G.rail+G.divider,y:G.topbar,width:w.width-G.rail-G.divider,height:G.nav}:{x:w.width-G.pad-G.panel,y:G.topbar+G.pad,width:G.panel,height:G.nav};}
/** The Classic panel's icon-only source control i (navigation.js icons mode). */
export const navIcon=(index,w)=>({x:w.width-G.pad-G.panel+G.navPadX+index*(G.navButton+G.navGap),y:G.topbar+G.pad+(G.nav-G.navButton)/2,width:G.navButton,height:G.navButton});
export const navMode=(view,w)=>view===LAYOUTS.classic?'icons':w.width-G.rail-G.divider>=G.navFull?'full':w.width-G.rail-G.divider>=G.navShort?'short':'icons';
const within=(r,n)=>{const x=n.frame.x+n.frame.width/2,y=n.frame.y+n.frame.height/2;return x>=r.x&&x<=r.x+r.width&&y>=r.y&&y<=r.y+r.height;};
const whole=(r,n)=>n.frame.x>=r.x-1&&n.frame.x+n.frame.width<=r.x+r.width+1&&n.frame.y>=r.y-1&&n.frame.y+n.frame.height<=r.y+r.height+1;
/** Logical widths of every node at a window width (the tests/layouts.test.mjs solver); `open` treats hidden ids as shown. */
export function widthsAt(tree,windowWidth,{open=[]}={}){
  const out=new Map(),padX=p=>Array.isArray(p)?Number(p[1])||0:Number(p)||0;
  const visit=(node,w)=>{
    if(!node||typeof node!=='object')return;out.set(node.id,w);const inner=Math.max(0,w-2*padX(node.padding)),kids=(node.children||[]).filter(c=>c?.hidden!==true||open.includes(c?.id));
    if(node.type!=='row'){kids.forEach(c=>visit(c,inner));return;}
    const fixed=kids.reduce((a,c)=>a+(c.size?.px||0),0),between=Math.max(0,kids.length-1)*((node.gap||0)+(node.divider?.width||0)),rest=Math.max(0,inner-fixed-between),weights=kids.reduce((a,c)=>a+(c.size?.px?0:c.size?.weight||1),0);
    kids.forEach(c=>visit(c,c.size?.px||rest*(c.size?.weight||1)/(weights||1)));
  };
  visit(tree,windowWidth);return out;
}
const findNode=(tree,id)=>{const stack=[tree];while(stack.length){const n=stack.pop();if(!n||typeof n!=='object')continue;if(n.id===id)return n;for(const c of n.children||[])stack.push(c);}return null;};

// ---------------------------------------------------------------------------------------------
// Pixel evidence from the actual WindowServer frame.
// ---------------------------------------------------------------------------------------------
/** 8-bit RGB/RGBA non-interlaced PNG, the format the WindowServer capture writes. */
export function decodePng(bytes){
  if(bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw Error('Not a PNG frame');
  let offset=8,width=0,height=0,depth=0,type=0,interlace=1;const data=[];
  while(offset+12<=bytes.length){const length=bytes.readUInt32BE(offset),kind=bytes.toString('latin1',offset+4,offset+8),body=bytes.subarray(offset+8,offset+8+length);offset+=12+length;
    if(kind==='IHDR'){width=body.readUInt32BE(0);height=body.readUInt32BE(4);depth=body[8];type=body[9];interlace=body[12];}else if(kind==='IDAT')data.push(body);else if(kind==='IEND')break;}
  if(depth!==8||![2,6].includes(type)||interlace!==0||!width||!height)throw Error('Unsupported PNG frame layout');
  const channels=type===6?4:3,stride=width*channels,raw=zlib.inflateSync(Buffer.concat(data)),pixels=Buffer.alloc(stride*height);
  if(raw.length<(stride+1)*height)throw Error('Truncated PNG frame');
  for(let y=0;y<height;y++){
    const filter=raw[y*(stride+1)],line=y*(stride+1)+1,row=y*stride,prev=row-stride;
    for(let x=0;x<stride;x++){
      const a=x>=channels?pixels[row+x-channels]:0,b=y?pixels[prev+x]:0,c=y&&x>=channels?pixels[prev+x-channels]:0;let v=raw[line+x];
      if(filter===1)v+=a;else if(filter===2)v+=b;else if(filter===3)v+=(a+b)>>1;else if(filter===4){const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);v+=pa<=pb&&pa<=pc?a:pb<=pc?b:c;}else if(filter!==0)throw Error('Unknown PNG filter');
      pixels[row+x]=v&255;
    }
  }
  return {width,height,pixel:(x,y)=>{const i=(y*width+x)*channels;return [pixels[i],pixels[i+1],pixels[i+2]];}};
}
const distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);
const box=(image,scale,r)=>({x0:Math.max(0,Math.floor(r.x*scale)),y0:Math.max(0,Math.floor(r.y*scale)),x1:Math.min(image.width,Math.ceil((r.x+r.width)*scale)),y1:Math.min(image.height,Math.ceil((r.y+r.height)*scale))});
/** Median color of a window-coordinate rectangle. */
export function backgroundOf(image,scale,r){const {x0,y0,x1,y1}=box(image,scale,r),v=[[],[],[]];for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){const p=image.pixel(x,y);for(let c=0;c<3;c++)v[c].push(p[c]);}if(!v[0].length)throw Error('Empty pixel sample');return v.map(c=>c.sort((a,b)=>a-b)[c.length>>1]);}
/** Pixels in a rectangle that differ clearly from a background color. */
export function inkCount(image,scale,r,background,threshold=60){const {x0,y0,x1,y1}=box(image,scale,r);let n=0;for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++)if(distance(image.pixel(x,y),background)>threshold)n++;return n;}

// ---------------------------------------------------------------------------------------------
// Disposable fixtures: provider sites, actors, telemetry agents, configuration.
// ---------------------------------------------------------------------------------------------
/** Two owned Jira Cloud-shaped TLS sites whose issues share IDs and keys (WEB-142 is 10001 on both accounts). */
export async function jiraFixtures(directory){
  const sites=[],observed=[],flags={deny:null};
  const issues=profile=>[
    {id:'10001',key:'WEB-142',fields:{summary:profile==='work'?'Fix login redirect':'Refresh billing summary',description:{type:'doc',version:1,content:[{type:'paragraph',content:[{type:'text',text:'Owned Jira fixture task. Keep this captured repository.'}]}]},status:{name:'To do',statusCategory:{key:'new'}},priority:{name:'High'}}},
    {id:'10002',key:'WEB-156',fields:{summary:profile==='work'?'Improve account settings':'Reconcile invoice totals',description:null,status:{name:'In progress',statusCategory:{key:'indeterminate'}},priority:{name:'Medium'}}},
    {id:'10003',key:'WEB-168',fields:{summary:profile==='work'?'Restore keyboard navigation':'Archive billing exports',description:null,status:{name:'Done',statusCategory:{key:'done'}},priority:{name:'Low'}}}];
  const site=async profile=>{
    let service;const expected='Basic '+Buffer.from(JIRA[profile].email+':'+JIRA[profile].token).toString('base64');
    service=await createFixtureService(path.join(directory,'jira-'+profile),{handler:request=>{
      const url=new URL(request.url,'https://fixture.invalid'),authorized=request.headers.authorization===expected;observed.push({profile,method:request.method,path:url.pathname,authorized});
      if(url.pathname.startsWith('/rest/')&&(!authorized||flags.deny===profile))return {status:authorized?403:401,body:{error:'Synthetic private Jira text must not escape.'}};
      if(url.pathname==='/rest/api/3/serverInfo')return {body:{baseUrl:service.origin}};
      if(url.pathname==='/rest/api/3/search/jql')return {body:{issues:issues(profile),isLast:true}};
      if(url.pathname.startsWith('/browse/'))return {body:{fixture:profile,path:url.pathname}};
      return {status:404,body:{error:'No fixture route'}};
    }});sites.push(service);return service;
  };
  try{const work=await site('work'),personal=await site('personal');return {work,personal,sites,observed,flags,async close(){for(const s of [...sites].reverse())await s.close();}};}
  catch(error){for(const s of sites.reverse())await s.close();throw error;}
}
/** Jira, GitHub and GitLab fixture sites for two accounts each, every one with its own CA under the given directory. */
export async function providerFixtures(directory){
  const opened=[];
  try{
    const jira=await jiraFixtures(path.join(directory,'jira'));opened.push(jira);const github=await githubFixtures(path.join(directory,'github'));opened.push(github);const gitlab=await gitlabFixtures(path.join(directory,'gitlab'));opened.push(gitlab);
    return {jira,github,gitlab,sites:[...jira.sites,...github.sites,...gitlab.sites],requests:()=>({jira:[...jira.observed],github:[...github.observed],gitlab:[...gitlab.observed]}),async close(){for(const f of [...opened].reverse())await f.close();}};
  }catch(error){for(const f of opened.reverse())await f.close();throw error;}
}
/** Read-only, own-credential proof over every recorded provider request. */
export function providerRequestsReadOnly(requests){
  const api=requests.github.filter(r=>r.path.startsWith('/api/')),lab=requests.gitlab.filter(r=>r.path.startsWith('/api/')),jira=requests.jira.filter(r=>r.path.startsWith('/rest/'));
  return jira.length>0&&api.length>0&&lab.length>0&&jira.every(r=>r.authorized&&r.method==='GET')&&lab.every(r=>r.authorized&&r.method==='GET')
    &&api.every(r=>r.authorized&&(r.method==='GET'||r.method==='POST'&&r.path==='/api/graphql'&&r.queryName==='MissionControlPullDetail'));
}
/** A launch actor: exact help, recorded argv/cwd/pid/stdin, Herdr agent status; no provider call. */
export function actorSource(tool,directory){const t=TOOLS[tool];return String.raw`#!/usr/bin/env python3
import os,sys,json,time,select,tty
TOOL=${JSON.stringify(tool)}
APP=${JSON.stringify(t.app)}
HELP=${JSON.stringify(t.help)}
RESUME=${JSON.stringify(t.resumeHelp)}
DIRECTORY=${JSON.stringify(directory)}
argv=sys.argv[1:]
if '--help' in argv:
 print(RESUME if 'resume' in argv and RESUME else HELP)
 sys.exit(0)
if '--version' in argv:
 print('Native layout fixture 1.0')
 sys.exit(0)
record={'tool':TOOL,'pid':os.getpid(),'cwd':os.getcwd(),'argv':argv,'received':'','startedMs':int(time.time()*1000)}
file=os.path.join(DIRECTORY,str(os.getpid())+'.json')
def save():
 with open(file+'.next','w') as output: json.dump(record,output)
 os.replace(file+'.next',file)
if sys.stdin.isatty(): tty.setraw(sys.stdin.fileno())
save()
print('Disposable '+TOOL+' layout actor; no provider call.',flush=True)
while True:
 sys.stdout.write('\x1b]7501;state=idle:app='+APP+'\x1b\\')
 sys.stdout.flush()
 ready,_,_=select.select([sys.stdin],[],[],3)
 if ready:
  try: chunk=os.read(sys.stdin.fileno(),65536)
  except OSError: chunk=b''
  if not chunk: break
  record['received']=(record['received']+chunk.decode('utf-8',errors='replace'))[:131072]
  save()
`;}
export async function writeActors(directory,home){
  const runs=path.join(directory,'layout-actor-runs'),programs={};await fs.mkdir(runs,{recursive:true});
  for(const tool of Object.keys(TOOLS)){const file=path.join(directory,'qa-'+tool);await fs.writeFile(file,actorSource(tool,runs));await fs.chmod(file,0o700);programs[tool]={name:TOOLS[tool].name,run:[file]};}
  if(home){await fs.mkdir(home,{recursive:true});await fs.writeFile(path.join(home,'programs.json'),JSON.stringify({programs})+'\n');}
  return {programs,directory:runs,async read(){const out=[];for(const name of await fs.readdir(runs))if(/^[0-9]+\.json$/.test(name))try{out.push(JSON.parse(await fs.readFile(path.join(runs,name),'utf8')));}catch{}return out;}};
}
/** Telemetry agent: OSC title/status, real provider session metadata and (for one writer) the shared Claude quota cache. */
export const TELEMETRY_ACTOR=String.raw`#!/usr/bin/env python3
import sys,os,time,json,datetime
if '--version' in sys.argv: print('Native layout telemetry fixture 1.0');sys.exit(0)
if '--help' in sys.argv: print('Mission Control layout telemetry fixture');sys.exit(0)
spec=json.load(open(sys.argv[-1]))
def now(): return datetime.datetime.now(datetime.timezone.utc).isoformat()
if spec.get('log'):
 os.makedirs(os.path.dirname(spec['log']),exist_ok=True)
 with open(spec['log'],'w') as f:
  if spec['provider']=='codex': f.write(json.dumps({'type':'session_meta','payload':{'id':spec['id'],'session_id':spec['id'],'cwd':spec['repo'],'timestamp':now(),'cli_version':'native-qa'}})+'\n')
print('\x1b]2;'+spec['title']+'\x1b\\',end='',flush=True)
print('Disposable layout telemetry agent; no provider request is made.',flush=True)
while True:
 if spec.get('log'):
  if spec['provider']=='codex': row={'type':'event_msg','timestamp':now(),'payload':{'type':'token_count','thread_id':spec['id'],'info':{'last_token_usage':{'total_tokens':spec['used']},'model_context_window':100},'rate_limits':{'primary':{'used_percent':25,'window_minutes':300}}}}
  else: row={'type':'assistant','sessionId':spec['id'],'cwd':spec['repo'],'timestamp':now(),'message':{'usage':{'input_tokens':spec['used'],'cache_read_input_tokens':0,'cache_creation_input_tokens':0,'output_tokens':1}}}
  with open(spec['log'],'a') as f: f.write(json.dumps(row)+'\n')
 if spec.get('quotaFile'):
  raw=spec['quota'];raw['fetched_at_unix']=int(time.time())
  for sid,observations in raw['session_quota_observations'].items():
   for o in observations: o['observed_at_unix']=int(time.time())-(10 if sid==spec['olderQuotaSession'] else 0)
  tmp=spec['quotaFile']+'.next'
  with open(tmp,'w') as f: json.dump(raw,f)
  os.replace(tmp,spec['quotaFile'])
 print('\x1b]7501;state='+spec['status']+':app='+('codex' if spec['provider']=='codex' else 'claude-code')+'\x1b\\',end='',flush=True)
 time.sleep(3)
`;
/** Telemetry agent specs: provider, exact session id, title, status and (for the bound ones) metadata paths. */
export function telemetrySpecs({sources,agentsRepo,directory,spaces}){
  const roots={codex:sources['local-codex'].providerRoot,claude:sources['local-claude'].providerRoot},quotaFile=path.join(roots.claude,'cache/claude-statusline.json'),agents=[];
  for(let index=0;index<AGENTS;index++){
    const provider=index===0||index%3===1?'codex':'claude',id=crypto.randomUUID(),tab='qa-agent-'+String(index).padStart(2,'0'),title='Task '+String(index).padStart(2,'0')+' '+TASKS[index%TASKS.length];
    const log=BOUND.includes(index)?provider==='codex'?path.join(roots.codex,'sessions','rollout-'+id+'.jsonl'):path.join(roots.claude,'projects',id+'.jsonl'):null;
    agents.push({index,provider,id,tab,title,space:spaces[index<AGENTS/2?0:1],file:path.join(directory,'telemetry-'+index+'.json'),spec:{provider,id,repo:agentsRepo,title,status:['working','blocked','done','idle'][index%4],used:index===0?17:30+index%20,log}});
  }
  const now=Math.floor(Date.now()/1000),quota={provider:'claude',source:'claude-statusline',session_quota_only:true,fetched_at_unix:now,session_contexts:{},session_windows:{},session_quota_observations:{},session_accounts:{}};
  for(const agent of agents.filter(a=>[2,3].includes(a.index))){const remaining=agent.index===2?65:20;quota.session_contexts[agent.id]={used_percent:agent.spec.used};quota.session_windows[agent.id]=[{kind:'five_hour',used_percent:100-remaining,remaining_percent:remaining,resets_at:now+3600}];quota.session_quota_observations[agent.id]=[{kind:'five_hour',observed_at_unix:now-(agent.index===2?10:0)}];quota.session_accounts[agent.id]='a'.repeat(64);}
  Object.assign(agents[2].spec,{quotaFile,quota,olderQuotaSession:agents[2].id});
  return {agents,roots,quotaFile,quota};
}
/** Private settings: six reusable connections, the three-provider repo binding, a duplicate-ID Jira account and the second host's bindings. */
export function configuration({repo,billing,serverRepo},{jira,github,gitlab},history){
  const config=newConfig(),labels={todo:['todo'],inProgress:['doing'],done:['done']};
  config.connections={
    'jira-work':{id:'jira-work',kind:'api',site:jira.work.origin,auth:{kind:'basic',usernameEnv:JIRA.work.emailEnv,tokenEnv:JIRA.work.tokenEnv}},
    'jira-personal':{id:'jira-personal',kind:'api',site:jira.personal.origin,auth:{kind:'basic',usernameEnv:JIRA.personal.emailEnv,tokenEnv:JIRA.personal.tokenEnv}},
    'github-work':{id:'github-work',kind:'github',site:github.work.origin,apiBase:github.work.origin+'/api/v3',credentialEnv:'QA_GITHUB_WORK'},
    'github-personal':{id:'github-personal',kind:'github',site:github.personal.origin,apiBase:github.personal.origin+'/api/v3',credentialEnv:'QA_GITHUB_PERSONAL'},
    'gitlab-work':{id:'gitlab-work',kind:'api',site:gitlab.work.origin,auth:{kind:'bearer',tokenEnv:'QA_GITLAB_WORK'}},
    'gitlab-personal':{id:'gitlab-personal',kind:'api',site:gitlab.personal.origin,auth:{kind:'bearer',tokenEnv:'QA_GITLAB_PERSONAL'}}};
  config.bindings={
    [bindingKey(null,repo)]:{machine:null,repoRoot:repo,jira:{connectionId:'jira-work',project:'WEB'},github:{connectionId:'github-work',owner:'acme',repo:'web',status:{labels}},gitlab:{connectionId:'gitlab-work',projectPath:'group/subgroup/web',status:{labels}}},
    [bindingKey(null,billing)]:{machine:null,repoRoot:billing,jira:{connectionId:'jira-personal',project:'WEB'}},
    [bindingKey(HOST,serverRepo)]:{machine:HOST,repoRoot:serverRepo,github:{connectionId:'github-personal',owner:'personal',repo:'server'},gitlab:{connectionId:'gitlab-personal',projectPath:'personal/server'}}};
  config.preferences.launch={v:1,pins:['claude','codex','grok'],hidden:[],worktree:true,tools:{}};
  const sources={...history.local.sources,...history.remote.sources},claude=sources['local-claude'];
  sources['local-claude']={...claude,cacheRoots:[claude.providerRoot+'/cache']};config.usageSources=sources;
  return validateConfig(config);
}
const helperInput=(config,binding,source,operation)=>({v:1,operation,binding,connection:config.connections[binding[source].connectionId]});
async function helper(file,env,input){const result=await execute(process.execPath,[file,JSON.stringify(input)],{env,maxBuffer:8*1024*1024,timeout:28000});assert.equal(result.stderr,'');return JSON.parse(result.stdout);}

// ---------------------------------------------------------------------------------------------
// Window placement (AX, owned PID only).
// ---------------------------------------------------------------------------------------------
const POSITION=String.raw`import Cocoa
import ApplicationServices
let args=CommandLine.arguments
func fail(_ message:String)->Never {FileHandle.standardError.write(message.data(using:.utf8)!);exit(2)}
guard args.count==6,let pid=Int32(args[1]),let x=Double(args[2]),let y=Double(args[3]),let width=Double(args[4]),let height=Double(args[5]) else {fail("Usage: pid x y width height")}
guard let application=NSRunningApplication(processIdentifier:pid) else {fail("Owned app is unavailable")}
application.activate()
var raw:CFTypeRef?
guard AXUIElementCopyAttributeValue(AXUIElementCreateApplication(pid),kAXWindowsAttribute as CFString,&raw) == .success,let windows=raw as? [AXUIElement] else {fail("Owned AX windows unavailable")}
let main=windows.filter {window in
 var value:CFTypeRef?
 guard AXUIElementCopyAttributeValue(window,kAXSizeAttribute as CFString,&value) == .success,let v=value,CFGetTypeID(v)==AXValueGetTypeID() else {return false}
 var size=CGSize.zero
 return AXValueGetValue(v as! AXValue,.cgSize,&size) && size.width>=600 && size.height>=500
}
guard main.count==1 else {fail("A unique owned main window is required")}
var actual:pid_t=0
AXUIElementGetPid(main[0],&actual)
guard actual==pid else {fail("Owned AX PID changed")}
var full:CFTypeRef?
if AXUIElementCopyAttributeValue(main[0],"AXFullScreen" as CFString,&full) == .success,let enabled=full as? Bool,enabled {
 guard AXUIElementSetAttributeValue(main[0],"AXFullScreen" as CFString,kCFBooleanFalse) == .success else {fail("Owned fullscreen exit failed")}
 print(#"{"retry":true}"#);exit(0)
}
var size=CGSize(width:width,height:height),point=CGPoint(x:x,y:y)
guard let s=AXValueCreate(.cgSize,&size),let p=AXValueCreate(.cgPoint,&point),AXUIElementSetAttributeValue(main[0],kAXPositionAttribute as CFString,p) == .success,AXUIElementSetAttributeValue(main[0],kAXSizeAttribute as CFString,s) == .success else {fail("Owned window positioning failed")}
_ = AXUIElementPerformAction(main[0],kAXRaiseAction as CFString)
let all=CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements],kCGNullWindowID) as? [[String:Any]] ?? []
let owned=all.filter {record in
 guard (record[kCGWindowOwnerPID as String] as? Int)==Int(pid),(record[kCGWindowLayer as String] as? Int)==0,let b=record[kCGWindowBounds as String] as? [String:Any],let r=CGRect(dictionaryRepresentation:b as CFDictionary) else {return false}
 return r.width>=600 && r.height>=500
}
guard owned.count==1,let id=owned[0][kCGWindowNumber as String] as? Int else {fail("A unique owned visible window is required")}
let data=try! JSONSerialization.data(withJSONObject:["windowId":id]);FileHandle.standardOutput.write(data)
`;
export async function positionWindow(runtime,{width=G.width,height=G.height,x=G.x,y=G.y,compileOnly=false,directory=runtime?.directory,cache=path.join(ROOT,'.harness/swift-cache')}={}){
  const source=path.join(directory,'layout-position.swift'),binary=path.join(directory,'layout-position');
  if(!await exists(binary)){await fs.writeFile(source,POSITION);run('swiftc',['-module-cache-path',cache,source,'-o',binary],{json:false,timeout:180000});}
  if(compileOnly)return binary;
  await until(async()=>{const result=run(binary,[String(runtime.owner.pid),String(x),String(y),String(width),String(height)]);if(result.retry)return false;const frame=await runtime.driver.bindWindow(result.windowId);return Math.abs(frame.width-width)<2&&Math.abs(frame.height-height)<2&&Math.abs(frame.x-x)<2&&Math.abs(frame.y-y)<2;},`owned layout window at ${width}x${height}`,30000);
  await delay(800);
}

// ---------------------------------------------------------------------------------------------
// The mounted integrated gate.
// ---------------------------------------------------------------------------------------------
export default async function layoutNative(runtime){
  const home=runtime.env.HERDR_APP_HOME,state=path.join(home,'mission-control'),server=new NativeRuntime(),io=fileIO(home);
  const files={config:path.join(state,'config.json'),launches:path.join(state,'launches.json'),names:path.join(state,'names.json'),closed:path.join(state,'closed.json'),bindings:path.join(state,'session-bindings.json'),tabNames:path.join(state,'tab-names.json')};
  const diagnostics=path.join(ROOT,'.browse/sessions',`mission-control-native-${runtime.nonce}`),gate=path.join(runtime.directory,'qa-server-offline');
  const seen={mojibake:[],errors:[]},manual=new Map();let connected=false,fixtures=null,actor=null,view=LAYOUTS.classic,serial=0;
  const progress=stage=>fs.mkdir(path.join(ROOT,'.harness'),{recursive:true}).then(()=>fs.writeFile(path.join(ROOT,'.harness/layout-progress.json'),JSON.stringify({stage,nonce:runtime.nonce,assertions:runtime.assertions.length,observations:serial})+'\n')).catch(()=>{});
  const expect=(value,key)=>{if(!Object.hasOwn(EXPECTATIONS,key))throw Error('Unknown layout expectation '+key);runtime.expect(value,EXPECTATIONS[key]);};
  const remoteGate=async(status,detail)=>{await fs.mkdir(diagnostics,{recursive:true});await fs.writeFile(path.join(diagnostics,'layout-remote-gate.json'),JSON.stringify({schema:'mission-control-layout-remote-gate-v1',status,transport:'hc machine add --via to a task-owned private core',realRemoteMachine:false,...detail},null,2)+'\n');};
  // Read-only observation of the private world, both cores and the mods' own state files.
  const status=()=>runtime.app(['status']),overlays=()=>status().overlays||[],shared=()=>runtime.shared();
  const world=()=>runtime.app(['ls']).spaces||[],activeSpace=()=>world().find(s=>s.active)?.id??null;
  const tabOf=id=>{for(const s of world())for(const t of s.tabs||[])if(t.id===id)return {...t,space:s.id,machine:s.machine??null};return null;};
  const live=core=>(core.hc(['ls','--json']).terminals||[]).filter(t=>t.state===undefined||t.state==='live').map(t=>t.address).sort();
  const journal=async()=>Object.values((await readJson(files.launches))?.requests||{}),requestIds=async()=>new Set((await journal()).map(r=>r.request.requestId));
  const newRecord=(before,test,label,timeout=90000)=>until(async()=>(await journal()).find(r=>!before.has(r.request.requestId)&&r.state==='complete'&&test(r))||null,'acknowledged '+label,timeout);
  const received=(record,text)=>until(async()=>{const raw=(await actor.read()).find(row=>row.tool===record.request.toolKey&&row.cwd===record.folder);return raw&&(raw.argv.join('\n')+'\n'+raw.received).includes(text)?raw:null;},'task delivered to the disposable '+record.request.toolKey+' actor',45000);
  const remoteCwd=record=>server.hc(['get',localTerminalAddress(record.ack.terminal,HOST),'--json']).cwd;
  const recordErrors=()=>{const errors=status().errors||[];if(errors.length)seen.errors.push(...errors.map(e=>JSON.stringify(e).slice(0,300)));return errors.length===0;};
  try{
    await progress('fixtures');console.log('Layout native: provider fixtures, disposable actors and a second owned core');
    // Empty startup files keep zsh from running its interactive new-user setup in fixture shells.
    await fs.writeFile(path.join(runtime.env.HOME,'.zshrc'),'# Disposable native fixture shell\n');await fs.writeFile(path.join(runtime.env.HOME,'.profile'),"PS1='$ '\n");// neutral prompt: no host or user names in previews
    fixtures=await providerFixtures(path.join(runtime.directory,'providers-tls'));
    await fs.mkdir(path.dirname(CA),{recursive:true});await fs.writeFile(CA,(await Promise.all(fixtures.sites.map(s=>fs.readFile(s.caFile,'utf8')))).join('\n'));
    try{
      await server.start();await fs.writeFile(path.join(server.env.HOME,'.zshrc'),'# Disposable native fixture shell\n');await fs.writeFile(path.join(server.env.HOME,'.profile'),"PS1='$ '\n");
      const selectors=Object.fromEntries(Object.entries(server.env).filter(([key])=>SELECTOR_KEYS.includes(key))),via=path.join(runtime.directory,'layout-via.py');
      await fs.writeFile(via,viaSource(selectors,gate));await fs.chmod(via,0o700);
      runtime.hc(['machine','add','--via',via,'--name',HOST,'--session',server.env.HC_SESSION,'--json']);connected=true;
    }catch(error){
      await remoteGate('failed',{code:error.code||'REMOTE_GATE_FAILED',message:String(error.message).slice(0,600)});if(error instanceof NativeIsolationError)throw error;
      throw Object.assign(Error('Remote second-host gate failed (no remote proof claimed): '+error.message),{code:'REMOTE_GATE_FAILED'});
    }
    const billing=await runtime.createRepo('billing-service'),agentsRepo=await runtime.createRepo('agents-repo'),linked=path.join(runtime.directory,'linked-checkout'),unbound=path.join(runtime.directory,'unbound-folder');
    run('git',['-C',runtime.repo,'worktree','add','-q','-b','qa-linked',linked],{env:runtime.env,json:false});await fs.writeFile(path.join(linked,'linked.md'),'Captured linked checkout HEAD\n');
    run('git',['-C',linked,'add','linked.md'],{env:runtime.env,json:false});run('git',['-C',linked,'commit','-qm','Advance linked fixture'],{env:runtime.env,json:false});
    const linkedHead=run('git',['-C',linked,'rev-parse','HEAD'],{env:runtime.env,json:false});await fs.mkdir(unbound);
    const history={local:await writeHistory(runtime.directory,{repo:runtime.repo,linked,billing},{entries:HISTORY}),remote:await writeHistory(server.directory,{repo:server.repo},{machine:HOST,entries:REMOTE_HISTORY})};
    const config=configuration({repo:runtime.repo,billing,serverRepo:server.repo},fixtures,history);await fs.mkdir(state,{recursive:true});await fs.writeFile(files.config,JSON.stringify(config)+'\n');
    actor=await writeActors(runtime.directory,home);
    // Dozens of agents: telemetry fixtures in two local spaces, three of them exactly bound, plus two on the second host.
    const telemetryTool=path.join(runtime.directory,'qa-telemetry');await fs.writeFile(telemetryTool,TELEMETRY_ACTOR);await fs.chmod(telemetryTool,0o700);
    const alpha=runtime.spaceId+'-alpha',beta=runtime.spaceId+'-beta',telemetry=telemetrySpecs({sources:history.local.sources,agentsRepo,directory:runtime.directory,spaces:[alpha,beta]});await fs.mkdir(path.dirname(telemetry.quotaFile),{recursive:true});
    for(const agent of telemetry.agents){
      await fs.writeFile(agent.file,JSON.stringify(agent.spec));agent.argv=[telemetryTool,agent.provider==='codex'?'resume':'--session-id',agent.id,agent.file];
      agent.address=runtime.hc(['run','--bg','--no-parent','--cwd',agentsRepo,'--label','herdr.space='+agent.space,'--label','herdr.tab='+agent.tab,'--',...agent.argv]).address;
    }
    for(let index=0;index<2;index++){const id=crypto.randomUUID(),file=path.join(runtime.directory,'remote-telemetry-'+index+'.json');await fs.writeFile(file,JSON.stringify({provider:'claude',id,repo:server.repo,title:'Remote task '+index+' Watch server health',status:index?'working':'blocked',used:40,log:null}));
      server.hc(['run','--bg','--no-parent','--cwd',server.repo,'--label','herdr.space='+server.spaceId,'--label','herdr.tab=qa-remote-agent-'+index,'--',telemetryTool,'--session-id',id,file]);}
    const bindings=new BindingStore(io),sources=history.local.sources;
    for(const agent of telemetry.agents.filter(a=>BOUND.includes(a.index))){
      const raw=await until(()=>{const value=runtime.hc(['get',agent.address,'--json']);return value.foreground?.pid&&value.status?.state?value:null;},'telemetry fixture foreground and OSC status '+agent.index,40000);
      const source=sources['local-'+agent.provider],session={machine:null,provider:agent.provider,credentialScope:source.credentialScope,providerRoot:source.providerRoot,sessionId:agent.id},terminal=terminalIdentity(raw,null),requestId='qa-telemetry-'+agent.index;
      await bindings.propose({requestId,originId:'qa-origin-telemetry-'+agent.index,session});
      await bindings.commitAcknowledged(requestId,{tabId:agent.tab,terminal},argvSessionProof({capabilities:{machine:null,provider:agent.provider,run:[telemetryTool],...(agent.provider==='codex'?{resume:{kind:'command',command:'resume'}}:{callerSession:'--session-id'})},session,terminal,argv:agent.argv,kind:agent.provider==='codex'?'resume-argv':'caller-session-id',observedAt:Date.now(),sourceDigest:sha(JSON.stringify(raw.argv))}));
    }
    await progress('install');
    for(const name of MODS)await runtime.installPackage(name);
    const layoutDir=path.join(home,'layouts'),shipped={};await fs.mkdir(layoutDir,{recursive:true});
    for(const file of LAYOUT_FILES){const bytes=await fs.readFile(path.join(ROOT,'src/layouts',file));shipped['layouts/'+file]=sha(bytes);await fs.writeFile(path.join(layoutDir,file),bytes);}
    await fs.writeFile(path.join(home,'window.json'),JSON.stringify({state:'windowed',bounds:[G.x,G.y,G.width,G.height]})+'\n');
    // The harness names this layout mission-control-<name>: "classic" installs the bundle's own Classic tree under its real name.
    await runtime.startWindow({name:'classic',layout:JSON.parse(await fs.readFile(path.join(ROOT,'src/layouts',LAYOUTS.classic+'.json'),'utf8'))});await positionWindow(runtime);
    const installedLayouts=Object.fromEntries(await Promise.all(LAYOUT_FILES.map(async file=>['layouts/'+file,sha(await fs.readFile(path.join(layoutDir,file)))])));
    const mods=(await fs.readdir(path.join(home,'mods'))).filter(n=>n.startsWith('mission-control-')).sort();
    expect(JSON.stringify(mods)===JSON.stringify(MODS)&&MODS.every(name=>runtime.packages.some(p=>p.name===name&&p.nativeCheck===true))&&JSON.stringify(installedLayouts)===JSON.stringify(shipped)&&status().layout===LAYOUTS.classic,'installed');
    await progress('world');console.log('Layout native: spaces, fixture tabs and 128-space scale');
    const remote=await until(()=>world().find(s=>s.machine===HOST&&s.id.endsWith('/'+server.spaceId)),'second-host space adoption',60000);
    await remoteGate('passed',{localCore:runtime.own.core.id,remoteCore:server.own.core.id,remoteSpace:remote.id});
    expect(server.own.core.id!==runtime.own.core.id&&remote.machine===HOST&&connected,'secondHost');
    await until(()=>{const ids=world().map(s=>s.id);return [alpha,beta].every(id=>ids.includes(id));},'telemetry agent spaces adopted',60000);
    for(const [id,name]of [[runtime.spaceId,'client-portal'],[remote.id,'server-repo'],[alpha,'agents-alpha'],[beta,'agents-beta']])runtime.app(['do','space.rename',JSON.stringify({id,name})]);
    const billingSpace=runtime.app(['do','space.new',JSON.stringify({name:'billing-service',folder:billing,argv:SLEEPER('billing checkout')})]);
    const linkedTab=runtime.app(['do','tab.new',JSON.stringify({space:runtime.spaceId,folder:linked,argv:SLEEPER('linked checkout')})]);
    const fillers=128-world().length;assert.ok(fillers>100,'The fixture world leaves room for filler spaces');
    for(let index=0;index<fillers;index++)runtime.app(['do','space.new',JSON.stringify({name:'space-'+String(index+128-fillers).padStart(3,'0'),folder:unbound,argv:['/bin/cat']})]);
    await until(()=>world().length===128,'128 private spaces',60000);const last=world().find(s=>s.name==='space-127');assert.ok(last,'The 128th fixture space exists');
    // A structural rename is a fixture manual name: it must survive every swap.
    runtime.app(['do','tab.rename',JSON.stringify({id:runtime.tabId,name:'fixture sentinel'})]);manual.set(runtime.tabId,'fixture sentinel');
    runtime.app(['do','space.select',JSON.stringify({id:runtime.spaceId})]);runtime.app(['do','tab.select',JSON.stringify({id:runtime.tabId})]);
    await until(()=>status().tab===runtime.tabId&&activeSpace()===runtime.spaceId,'sentinel tab shown',20000);

    // -------------------------------------------------------------------------------------------
    // Native observation and input helpers (OCR of the actual frame; PID-bound pointer and keys).
    // -------------------------------------------------------------------------------------------
    const observe=async(query='')=>{
      if(++serial>BUDGET)throw Error('Native layout observation budget exhausted');
      const frame=await runtime.frame('layout-observe-'+serial),o=await runtime.driver.ocr(path.join(ROOT,frame.path),query);
      for(const line of o.lines)if(MOJIBAKE.test(line.text))seen.mojibake.push(line.text.slice(0,120));
      const banner=o.lines.find(n=>BANNER.test(n.text));if(banner)throw Error('Native render/action error banner: '+banner.text);return o;
    };
    // A control can still be moving after a status, launch or focus change: act only once two frames agree.
    const pick=async(query,where,{index=0,min=1,only=false,description=query,timeout=45000}={})=>{
      let prior=null,hit=null;
      await until(async()=>{const o=await observe(query),m=o.matches.filter(n=>n.confidence>=0.6&&where(n,o)).sort((a,b)=>a.frame.y-b.frame.y||a.frame.x-b.frame.x),node=index==='last'?m.at(-1):m[index];
        if(m.length<min||only&&m.length!==1||!node)return false;const key=JSON.stringify(node.frame);if(key===prior){hit={observation:o,node,count:m.length,matches:m};return true;}prior=key;return false;},'steady native control '+description,timeout);
      return hit;
    };
    const annotate=(control,observation)=>Object.assign(runtime.driver.actions.at(-1),{control,observation:observation.source});
    const clickRect=async(rect,observation,control,{button='left'}={})=>{await runtime.driver.click(rect,{button,expectedSize:observation.window});annotate(control,observation);};
    const clickHit=async(hit,control)=>{await runtime.driver.clickObservedText(hit.observation,hit.node);runtime.driver.actions.at(-1).control=control;};
    const click=async(query,where,options={})=>{const hit=await pick(query,where,options);await clickHit(hit,options.control||query);return hit;};
    const has=async(query,where=()=>true)=>{const o=await observe(query);return o.matches.some(n=>n.confidence>=0.6&&where(n,o));};
    const visible=(query,where=()=>true,timeout=45000)=>until(async()=>{const o=await observe(query),m=o.matches.filter(n=>n.confidence>=0.6&&where(n,o));return m.length?{observation:o,node:m[0],matches:m}:null;},'visible native text '+query,timeout);
    const optional=async promise=>{try{return await promise;}catch(error){if(error instanceof NativeIsolationError||/budget exhausted|error banner/.test(error.message))throw error;return null;}};
    const inTop=n=>n.frame.y+n.frame.height/2<G.topbar,inRail=n=>n.frame.x+n.frame.width<=G.rail+2&&n.frame.y>=G.topbar;
    const inFooter=(n,o)=>inRail(n)&&n.frame.y>=o.window.height-G.footer-2;
    const inNav=(n,o)=>within(navRect(view,o.window),n),inStack=(n,o)=>within(stackRect(view,o.window),n);
    // Source toolbars: one row when wide, scope/actions above the search when narrow (issue-board.js, merges-view.js).
    const inToolbar=(n,o)=>{const r=stackRect(view,o.window);return within({...r,height:r.width<G.board.narrowBelow?120:80},n);};
    const inDialog=(n,o)=>within({x:(o.window.width-G.dialog.width)/2,y:(o.window.height-G.dialog.height)/2,width:G.dialog.width,height:G.dialog.height},n);
    const image=async o=>{const png=decodePng(await fs.readFile(path.join(ROOT,o.source.path)));return {png,scale:png.width/o.window.width};};
    const typeChunks=async(value,control,check)=>{let typed='';for(let index=0;index<value.length;index+=4){const chunk=value.slice(index,index+4);await runtime.driver.bridge('type',chunk);typed+=chunk;runtime.driver.actions.push({kind:'native-text',pid:runtime.owner.pid,control,characters:chunk.length});if(check)await until(()=>check(typed),control+' typed '+typed,20000);else await delay(150);}};
    // Park the real pointer on the inert Spaces header so no tooltip or hover state covers the next observation.
    const park=async()=>{const o=await observe();await clickRect({x:120,y:G.topbar+12,width:8,height:8},o,'Inert Spaces header');await delay(250);};
    const focusLocal=async()=>{runtime.app(['do','space.select',JSON.stringify({id:runtime.spaceId})]);runtime.app(['do','pane.focus',JSON.stringify({terminal:linkedTab.terminal})]);await until(()=>status().tab===linkedTab.tab,'focused linked checkout',20000);};
    /** Top-bar control rectangles right of the tabs, measured from the observed swap text (main.js/navigation.js). */
    const controls=async()=>{
      const label=LAYOUT_LABELS[view===LAYOUTS.overview?LAYOUTS.classic:LAYOUTS.overview],hit=await pick(label,(n,o)=>inTop(n)&&n.frame.x>o.window.width/2,{only:true,description:'view swap control '+label});
      const f=hit.node.frame,left=f.x-G.swapGap-G.swapIcon-G.swapPadX,top=(G.topbar-G.control)/2,rects={swap:{x:left,y:top,width:f.x+f.width+G.swapPadX-left,height:G.control}};
      (view===LAYOUTS.classic?['sources','panel','reopen-agent','reopen-tab','plus']:['sources','reopen-agent','reopen-tab','plus']).forEach((name,index)=>{const right=left-G.controlGap-index*(G.control+G.controlGap);rects[name]={x:right-G.control,y:top,width:G.control,height:G.control};});
      // Classic's source buttons follow the swap, 2 px apart.
      if(view===LAYOUTS.classic){const start=rects.swap.x+rects.swap.width+G.controlGap;SOURCES.forEach((source,index)=>{rects['quick-'+source.id]={x:start+index*(G.control+2),y:top,width:G.control,height:G.control};});}
      return {observation:hit.observation,rects,label:hit};
    };
    const panelOpen=async()=>{
      // Every work source in the Classic panel shows its This space / All spaces switch right of the terminal;
      // the toggle's own highlight is unreliable once a narrow window's tab strip overflows.
      await park();const o=await observe('All spaces');return o.matches.some(n=>n.confidence>=0.6&&n.frame.x>o.window.width*0.4&&n.frame.y>60);
    };
    const ensurePanel=async()=>{if(view!==LAYOUTS.classic)throw Error('Only Classic has a work panel');if(await panelOpen())return false;const c=await controls();await clickRect(c.rects.panel,c.observation,'Show work panel');await until(()=>panelOpen(),'Classic work panel shown',30000);return true;};
    const iconsDrawn=async()=>{const o=await observe(),{png,scale}=await image(o);return SOURCES.every((_s,index)=>{const r=navIcon(index,o.window),bg=backgroundOf(png,scale,r);return whole(navRect(view,o.window),{frame:r})&&r.x+r.width<=o.window.width&&inkCount(png,scale,r,bg)>8;});};
    /** Visible source markers in the stack; exactly the selected one, and no repeated source heading. */
    const separated=(id,timeout=45000)=>until(async()=>{
      const o=await observe(),r=stackRect(view,o.window),lines=o.lines.filter(l=>l.confidence>=0.5&&within(r,l)),found=SOURCES.filter(s=>lines.some(l=>l.text.toLowerCase().includes(s.marker.toLowerCase()))).map(s=>s.id);
      const heading=lines.some(l=>l.frame.y<r.y+40&&HEADINGS.has(l.text.trim().toLowerCase()));return found.length===1&&found[0]===id&&!heading?o:null;
    },'only the '+id+' source view is shown',timeout);
    const selectSource=async(id,{check=true}={})=>{
      const s=SOURCE[id],o=await observe(),mode=navMode(view,o.window);
      if(mode==='icons')await clickRect(navIcon(SOURCES.indexOf(s),o.window),o,'Source '+s.full+' (icon)');
      else{const label=mode==='full'?s.full:s.short;await click(label,(n,ob)=>inNav(n,ob)&&n.text.toLowerCase()===label.toLowerCase(),{only:true,description:'navigation '+label,control:'Source '+label});}
      await until(async()=>(await shared())[STATE_KEYS.nav]?.source===id,'navigation selected '+id,20000);
      return check?separated(id):o;
    };
    /** Every source label whole, once, inside the strip and in navigation order (one query each: OCR may merge adjacent labels into one line). */
    const navLabels=async mode=>{
      const found=[];for(const s of SOURCES){const label=mode==='full'?s.full:s.short,o=await observe(label),r=navRect(view,o.window),m=o.matches.filter(n=>n.confidence>=0.6&&within(r,n)&&n.text.toLowerCase()===label.toLowerCase());if(m.length!==1)return false;found.push({node:m[0],r,w:o.window});}
      return found.every(({node,r,w})=>whole(r,node)&&node.frame.x+node.frame.width<=w.width-1)&&found.every((f,i)=>!i||f.node.frame.x>found[i-1].node.frame.x+found[i-1].node.frame.width)&&found[0].node.frame.x>=G.rail;
    };
    const scope=async(id,all)=>{const s=SOURCE[id];if(((await shared())[s.key]?.all===true)===all)return;await click(all?'All spaces':'This space',inToolbar,{only:true,control:s.full+(all?' All spaces':' This space')});await until(async()=>((await shared())[s.key]?.all===true)===all,s.full+' scope '+(all?'All spaces':'This space'),20000);};
    const search=async(id,value)=>{
      const s=SOURCE[id],current=(await shared())[s.key]?.query||'';if(current===value)return;
      const hit=await pick((current||s.search).slice(0,24),inToolbar,{only:true,description:s.full+' search control'});await clickHit(hit,s.full+' search');
      await runtime.driver.press('cmd-a');await runtime.driver.press('backspace');await until(async()=>((await shared())[s.key]?.query??'')==='','cleared '+s.full+' search',20000);
      // Observe each user-paced chunk: fast injected text can overrun native key delivery while a filtered frame lays out.
      await typeChunks(value,s.full+' search',async typed=>((await shared())[s.key]?.query??'')===typed);
    };
    /** One of a card's pinned tool starts, anchored on its rendered key (issue-board.js geometry). */
    const captionOf=(o,key)=>{const y=key.frame.y+G.board.keyRow+2*G.board.rowGap+G.board.title+G.board.start/2;return o.lines.filter(l=>Math.abs(l.frame.y+l.frame.height/2-y)<9&&l.frame.x>=key.frame.x-12&&l.frame.x<key.frame.x+240).map(l=>l.text).join(' ');};
    const issueStart=async(key,index,{caption=null}={})=>{
      const hit=await pick(key,(n,o)=>inStack(n,o)&&n.frame.y>stackRect(view,o.window).y+60&&(!caption||captionOf(o,n).includes(caption)),{only:true,description:'card '+key+(caption?' · '+caption:'')});
      const o=hit.observation,b=stackRect(view,o.window),narrow=b.width<G.board.narrowBelow,pad=narrow?G.board.padNarrow:G.board.padWide,column=narrow?Math.min(G.board.columnNarrow,b.width-2*pad):Math.min(G.board.columnWide,(b.width-2*pad-G.board.columnGaps)/3),left=hit.node.frame.x-G.board.cardInset;
      await clickRect({x:left+column-10-G.board.starts+index*G.board.startStep,y:hit.node.frame.y+G.board.keyRow+2*G.board.rowGap+G.board.title,width:G.board.start,height:G.board.start},o,'Start '+key+(caption?' ('+caption+')':'')+' with '+['claude','codex','grok'][index]);
    };
    /** One of a single shown MR card's pinned tool icons, anchored on its Address comments chip (merges-view.js geometry). */
    const mergeStart=async index=>{
      const hit=await pick('Address comments',(n,o)=>inStack(n,o)&&n.frame.y>stackRect(view,o.window).y+60,{only:true,description:'single shown MR card'}),o=hit.observation,b=stackRect(view,o.window),pad=b.width<G.merge.narrowBelow?G.merge.padNarrow:G.merge.padWide;
      const right=b.x+b.width-pad-1-G.merge.cardPad;await clickRect({x:right-G.merge.controls+index*G.merge.iconStep,y:hit.node.frame.y+hit.node.frame.height/2+G.merge.iconTop,width:G.merge.icon,height:G.merge.icon},o,'MR agent '+['claude','codex','grok'][index]);
    };
    const tabLabel=text=>pick(text,(n,o)=>inTop(n)&&n.frame.x>=60&&n.frame.x<o.window.width-200,{only:true,description:'tab '+text});
    const tabMenu=async(text,item)=>{
      const hit=await tabLabel(text);await clickRect(hit.node.frame,hit.observation,'Tab menu '+text,{button:'right'});await until(()=>overlays().includes(MOD_TABS),'own tab context menu',20000);
      await click(item,n=>n.frame.y>G.topbar-4&&n.frame.y<G.topbar+220&&Math.abs(n.frame.x-hit.node.frame.x)<320,{only:true,description:item+' for '+text,control:item+' · '+text});
    };
    const typePrompt=async(id,value)=>{
      await until(()=>overlays().includes('prompt'),'Herdr rename prompt',20000);await until(async()=>(await observe()).lines.some(n=>/^(Cancel|Save)$/i.test(n.text.trim())),'visible rename prompt',20000);await delay(800);
      await runtime.driver.press('cmd-a');await runtime.driver.press('backspace');await typeChunks(value,'Tab rename prompt');await runtime.driver.press('enter');
      await until(()=>tabOf(id)?.name===value,'manual name '+value,20000);await until(()=>!overlays().length,'closed rename prompt',20000);
    };
    const closeOverlay=async()=>{await runtime.driver.press('escape');await until(()=>!overlays().length,'closed native overlay',20000);};
    const railSearch=async value=>{
      if(((await shared())[STATE_KEYS.spaces]?.query??'')===value)return;const o=await observe();
      await clickRect({x:G.railSearch.x,y:G.topbar+G.railSearch.dy,width:G.railSearch.width,height:G.railSearch.height},o,'Find a space');
      await runtime.driver.press('cmd-a');await runtime.driver.press('backspace');await until(async()=>((await shared())[STATE_KEYS.spaces]?.query??'')==='','cleared space search',20000);
      await typeChunks(value,'Find a space',async typed=>((await shared())[STATE_KEYS.spaces]?.query??'')===typed);
    };
    const agentsHeader=()=>pick('Agents',n=>inRail(n)&&n.text==='Agents',{only:true,description:'Agents section header'});
    const agentSearch=async value=>{
      if(((await shared())[STATE_KEYS.agents]?.query??'')===value)return;const hit=await agentsHeader(),top=hit.node.frame.y+hit.node.frame.height/2-G.header/2;
      await clickRect({x:G.agentSearch.x,y:top+G.agentSearch.dy,width:G.agentSearch.width,height:G.agentSearch.height},hit.observation,'Find an agent');
      await runtime.driver.press('cmd-a');await runtime.driver.press('backspace');await until(async()=>((await shared())[STATE_KEYS.agents]?.query??'')==='','cleared agent search',20000);
      await typeChunks(value,'Find an agent',async typed=>((await shared())[STATE_KEYS.agents]?.query??'')===typed);
    };
    const spaceRows=(n,o,header)=>inRail(n)&&n.frame.y>G.topbar+G.header+38&&n.frame.y<header;
    const manualKept=()=>[...manual].every(([id,name])=>tabOf(id)?.name===name);
    const snapshot=()=>{const s=status(),spaces=world();return {layout:s.layout,tab:s.tab,space:spaces.find(x=>x.active)?.id??null,tabs:JSON.stringify(spaces.map(x=>[x.id,(x.tabs||[]).map(t=>[t.id,(t.terminals||[]).map(v=>v.terminal).sort()])])),local:JSON.stringify(live(runtime)),remote:JSON.stringify(live(server))};};
    /** The one-button swap by real input; proves the same space/tab, tabs, terminal addresses and manual names afterwards. */
    const swap=async to=>{
      await park();const before=snapshot(),c=await controls();await clickHit(c.label,'View swap to '+LAYOUT_LABELS[to]);
      await until(()=>status().layout===to,'one-button swap to '+to,30000);view=to;await delay(1500);
      const after=await until(()=>{const s=snapshot();return s.tab===before.tab&&s.space===before.space?s:null;},'swap kept the selected space and tab',20000).catch(()=>snapshot());
      const ok=recordErrors();return after.tab===before.tab&&after.space===before.space&&after.tabs===before.tabs&&after.local===before.local&&after.remote===before.remote&&manualKept()&&ok;
    };

    // -------------------------------------------------------------------------------------------
    await progress('classic');console.log('Layout native: Classic is terminal-first; footer, panel and seven separated sources');
    const start=await visible('Mission Control isolated',(n,o)=>n.frame.x>G.rail&&n.frame.y>G.topbar,60000),sentinelTab=await tabLabel('fixture sentinel'),o0=start.observation;
    const panelArea={x:o0.window.width-G.pad-G.panel,y:G.topbar+G.pad,width:G.panel,height:o0.window.height-G.topbar-2*G.pad};
    expect(status().layout===LAYOUTS.classic&&sentinelTab.count===1&&!o0.lines.some(l=>within(panelArea,l)&&SOURCES.some(s=>l.text.includes(s.marker)))&&!(await panelOpen())&&recordErrors(),'classicStart');
    await runtime.frame('layout-classic-start');
    await click('Add machine',inFooter,{only:true,control:'Footer Add machine'});await until(async()=>overlays().length&&await has('Add a machine'),'Herdr machine-add dialog',20000);const machineDialog=await has('user@host');await closeOverlay();
    await click('Settings',inFooter,{only:true,control:'Footer Settings'});await until(()=>overlays().includes('frame-settings'),'Herdr Settings',20000);await closeOverlay();
    expect(machineDialog,'footerClassic');
    expect(await ensurePanel()&&Boolean(await separated('jira')),'panelOpens');
    {
      // Classic's source buttons: one opens the panel on its source; the shown source's button closes the panel.
      let c=await controls();await clickRect(c.rects['quick-gitlab'],c.observation,'Open GitLab issues in the work panel');
      const opened=await until(async()=>(await panelOpen())&&(await shared())[STATE_KEYS.nav]?.source==='gitlab'?true:null,'GitLab issues opened from its tab-bar button',30000).catch(()=>false);
      c=await controls();await clickRect(c.rects['quick-gitlab'],c.observation,'Hide GitLab issues');
      const closed=await until(async()=>!(await panelOpen())?true:null,'work panel closed by the shown source button',30000).catch(()=>false);
      expect(Boolean(opened&&closed&&await ensurePanel()),'quickSources');
    }
    expect(await iconsDrawn(),'classicIcons');
    let allSeparated=true;for(const id of ['github','pulls','merges','sessions','mods','jira','gitlab'])allSeparated=Boolean(await selectSource(id))&&allSeparated;
    expect(allSeparated,'classicSeparated');

    await progress('classic-gitlab');console.log('Layout native: GitLab issue start from the Classic panel in the linked checkout');
    await focusLocal();await separated('gitlab');let before=await requestIds();await issueStart('GL-142',0);
    const glLocal=await newRecord(before,r=>r.request.source?.kind==='gitlab'&&r.request.source.connectionId==='gitlab-work'&&r.request.source.id==='10142'&&r.request.toolKey==='claude','GitLab GL-142 claude start');
    const glRun=await received(glLocal,'Work on GL-142');
    expect(glLocal.request.checkoutRoot===linked&&glLocal.request.repoRoot===runtime.repo&&glLocal.request.machine===null&&path.basename(glLocal.folder)==='client-portal-GL-142'&&run('git',['-C',glLocal.folder,'rev-parse','HEAD'],{env:runtime.env,json:false})===linkedHead
      &&runtime.hc(['get',glLocal.ack.terminal,'--json']).cwd===glLocal.folder&&glRun.argv.includes('--session-id')&&glRun.argv.includes(glLocal.sessionProposal?.sessionId),'classicGitlabStart');
    await until(()=>tabOf(glLocal.ack.tab)?.name?.startsWith('GL-142'),'automatic issue tab name',30000);expect(Boolean(await tabLabel('GL-142')),'autoName');
    const liveBefore=live(runtime).length;await focusLocal();before=await requestIds();await issueStart('GL-142',0);await until(()=>status().tab===glLocal.ack.tab,'existing issue agent focused',20000);await delay(1500);
    expect(live(runtime).length===liveBefore&&!(await journal()).some(r=>!before.has(r.request.requestId)&&r.state==='complete'),'repeatFocus');
    await tabMenu('GL-142','Rename');await typePrompt(glLocal.ack.tab,'login fix');manual.set(glLocal.ack.tab,'login fix');expect(tabOf(glLocal.ack.tab)?.name==='login fix','manualRename');

    await progress('swap-overview');console.log('Layout native: swap to Mission Control and seven separated sources');
    expect(await swap(LAYOUTS.overview),'swapToOverview');
    expect((await shared())[STATE_KEYS.nav]?.source==='gitlab'&&Boolean(await separated('gitlab')),'sourceKeptOverview');
    allSeparated=true;const boards={};
    for(const id of ['jira','github','pulls','merges','sessions','mods','gitlab']){const o=await selectSource(id);allSeparated=Boolean(o)&&allSeparated;
      if(['jira','github','gitlab'].includes(id))boards[id]=['To do','In progress','Done'].every(group=>o.lines.some(l=>within(stackRect(view,o.window),l)&&l.text.includes(group)));}
    expect(allSeparated,'overviewSeparated');expect(boards.jira&&boards.github&&boards.gitlab,'compactBoards');

    await progress('routing');console.log('Layout native: All-spaces routing with duplicate provider identities');
    await scope('gitlab',true);await pick('GL-142',inStack,{min:2,description:'two GL-142 cards on two accounts'});await focusLocal();before=await requestIds();await issueStart('GL-142',1,{caption:HOST});
    const glRemote=await newRecord(before,r=>r.request.source?.kind==='gitlab'&&r.request.source.connectionId==='gitlab-personal','remote GL-142 codex start');
    expect(glRemote.request.machine===HOST&&glRemote.request.spaceId===remote.id&&glRemote.request.repoRoot===server.repo&&glRemote.request.source.id===glLocal.request.source.id&&glRemote.request.toolKey==='codex'&&remoteCwd(glRemote)===glRemote.folder
      &&(await journal()).filter(r=>r.request.source?.kind==='gitlab'&&r.request.source.connectionId==='gitlab-work').length===1,'remoteIssueRoute');
    // Starting the remote agent focused its tab on qa-server; return to the local space before checking Jira's cards.
    await scope('gitlab',false);await focusLocal();await selectSource('jira');await scope('jira',true);await pick('WEB-142',inStack,{min:2,description:'two WEB-142 cards on two Jira accounts'});await focusLocal();before=await requestIds();await issueStart('WEB-142',0,{caption:'billing-service'});
    const jiraBilling=await newRecord(before,r=>r.request.source?.kind==='jira'&&r.request.source.connectionId==='jira-personal','billing WEB-142 claude start');
    expect(jiraBilling.request.spaceId===billingSpace.space&&jiraBilling.request.repoRoot===billing&&jiraBilling.request.source.id==='10001'&&jiraBilling.request.source.key==='WEB-142'&&path.basename(jiraBilling.folder)==='billing-service-WEB-142'
      &&runtime.hc(['get',jiraBilling.ack.terminal,'--json']).cwd===jiraBilling.folder&&!(await journal()).some(r=>r.request.source?.connectionId==='jira-work'),'duplicateJiraRoute');
    await scope('jira',false);await focusLocal();await selectSource('github');await focusLocal();before=await requestIds();await issueStart('GH-156',2);
    const ghGrok=await newRecord(before,r=>r.request.source?.kind==='github'&&r.request.toolKey==='grok','GitHub GH-156 grok start');
    expect(ghGrok.request.source.connectionId==='github-work'&&ghGrok.request.checkoutRoot===linked&&Boolean(await received(ghGrok,'Work on GH-156')),'githubPinned');
    await focusLocal();await selectSource('merges');await search('merges','Review reconnect handling');await focusLocal();before=await requestIds();await mergeStart(0);
    const mrLocal=await newRecord(before,r=>r.request.source?.kind==='gitlab-mr'&&r.request.source.connectionId==='gitlab-work','local MR 42 review');
    expect(mrLocal.request.source.id===mrId('work',42)&&mrLocal.request.source.key==='GL-MR-42'&&mrLocal.request.checkoutRoot===linked&&Boolean(await received(mrLocal,'Mission Control action: Review merge request')),'overviewMergeReview');
    await search('merges','');

    await progress('reopen');console.log('Layout native: close through the tab menu, Reopen last agent and the manual name');
    runtime.app(['do','space.select',JSON.stringify({id:runtime.spaceId})]);runtime.app(['do','tab.select',JSON.stringify({id:glLocal.ack.tab})]);
    // A menu click can land while the popup is still opening; repeat only while the tab is still open and no menu is shown.
    for(let attempt=0;tabOf(glLocal.ack.tab)&&attempt<3;attempt++){if(!status().overlays?.length)await tabMenu('login fix','Close tab');await until(()=>!tabOf(glLocal.ack.tab),'tab-menu close of login fix',8000).catch(()=>null);}
    await until(()=>!tabOf(glLocal.ack.tab),'tab-menu close of login fix',5000);manual.delete(glLocal.ack.tab);
    await until(async()=>((await readJson(files.closed))?.records||[]).some(r=>r.tab?.id===glLocal.ack.tab),'recorded close of login fix',45000);await delay(CLOSED.observeMs*2+1000);
    const tabsBefore=new Set(world().flatMap(s=>(s.tabs||[]).map(t=>t.id))),runsBefore=(await actor.read()).filter(r=>r.argv.includes('--resume')).length,ctl=await controls();await clickRect(ctl.rects['reopen-agent'],ctl.observation,'Reopen last agent');
    const reopened=await until(()=>world().flatMap(s=>(s.tabs||[]).map(t=>({...t,space:s.id}))).find(t=>!tabsBefore.has(t.id)&&t.name==='login fix')||null,'reopened agent tab with its manual name',90000);
    const resumedRuns=await until(async()=>{const r=(await actor.read()).filter(a=>a.argv.includes('--resume')&&a.argv.includes(glLocal.sessionProposal.sessionId));return r.length?r:null;},'exact resume actor',45000);await delay(CLOSED.observeMs*2);
    expect(resumedRuns.length===1&&resumedRuns[0].cwd===glLocal.folder&&(await actor.read()).filter(r=>r.argv.includes('--resume')).length===runsBefore+1&&reopened.space===runtime.spaceId,'reopenAgent');
    manual.set(reopened.id,'login fix');expect(world().flatMap(s=>s.tabs||[]).filter(t=>t.name==='login fix').length===1,'manualNameReturns');

    await progress('history');console.log('Layout native: previous sessions on both hosts');
    await focusLocal();await selectSource('sessions');await scope('sessions',false);await focusLocal();const h1=history.local.sessions.H1;before=await requestIds();await click(h1.title,inStack,{only:true,control:'Resume '+h1.title});
    const resumed=await newRecord(before,r=>r.sessionProposal?.sessionId===h1.id,'exact history resume '+h1.title);const resumedRun=await until(async()=>(await actor.read()).find(a=>a.argv.includes(h1.id)&&a.argv.includes('--resume'))||null,'history resume actor',45000);
    expect(resumed.request.idempotencyKey.startsWith('resume-')&&resumed.request.toolKey==='claude'&&resumed.request.machine===null&&resumed.folder===runtime.repo&&resumedRun.cwd===runtime.repo,'historyResume');
    await scope('sessions',true);const r1=history.remote.sessions.R1,remoteRow=await visible(r1.title,inStack,60000);
    expect(remoteRow.observation.lines.some(l=>inStack(l,remoteRow.observation)&&l.frame.y>remoteRow.node.frame.y&&l.frame.y<remoteRow.node.frame.y+40&&l.text.includes(HOST)),'historyAllSpaces');await scope('sessions',false);

    await progress('rail');console.log('Layout native: right-click target, 128 spaces and dozens of agents');
    await railSearch('billing');let header=(await agentsHeader()).node.frame.y;const row=await pick('billing-service',(n,o)=>spaceRows(n,o,header),{only:true,description:'billing-service space row'});
    const selectedBefore=activeSpace();await clickRect(row.node.frame,row.observation,'Right-click billing-service',{button:'right'});await until(()=>overlays().includes('mission-control-spaces'),'space context menu',20000);
    // The space menu is a pointer popup: its items sit beside the clicked row, never in the bar or the navigation strip.
    const menuArea=(n,o)=>!inTop(n)&&!inNav(n,o)&&Math.abs(n.frame.y-row.node.frame.y)<260&&n.frame.x<row.node.frame.x+340;
    const menu=await pick('New agent',menuArea,{only:true,description:'space menu New agent'}),item=menu.node.frame;
    const inMenu=(n,o)=>menuArea(n,o)&&n.frame.y>=item.y-48&&n.frame.y<=item.y+140&&Math.abs(n.frame.x-item.x)<80;
    expect(activeSpace()===selectedBefore&&await has('Previous sessions',inMenu)&&await has('Open in Finder',inMenu)&&menu.observation.lines.some(l=>l.text.includes('billing-service')&&l.frame.y<item.y&&item.y-l.frame.y<48&&Math.abs(l.frame.x-item.x)<80),'contextMenuTarget');
    await clickHit(menu,'Space menu New agent');await until(()=>overlays().includes('mission-control-spaces'),'the space mod’s own launch dialog',20000);
    await click(TOOLS.claude.name,inDialog,{only:true,control:'Launch dialog '+TOOLS.claude.name});await visible('Start agent',inDialog,30000);
    await click('Current checkout',inDialog,{only:true,control:'Launch dialog Current checkout'});await until(async()=>!(await has('Checking available options',inDialog)),'probed launch options',30000);before=await requestIds();
    await click('Start agent',inDialog,{only:true,control:'Launch dialog Start agent'});const rightClick=await newRecord(before,r=>!r.request.source&&r.request.spaceId===billingSpace.space,'right-click New agent');
    expect(rightClick.request.repoRoot===billing&&rightClick.request.checkoutRoot===billing&&rightClick.request.machine===null&&rightClick.request.toolKey==='claude'&&runtime.hc(['get',rightClick.ack.terminal,'--json']).cwd===rightClick.folder,'rightClickLaunch');
    await railSearch('127');header=(await agentsHeader()).node.frame.y;await click('space-127',(n,o)=>spaceRows(n,o,header),{only:true,control:'Space space-127'});await until(()=>activeSpace()===last.id,'128th space selected',20000);
    expect(world().length===128&&activeSpace()===last.id,'spacesScale');
    await selectSource('gitlab',{check:false});
    const unboundView=await until(async()=>{const o=await observe(),r=stackRect(view,o.window);return o.lines.some(l=>within(r,l)&&/Choose a repository|Connect this space/i.test(l.text))&&!o.lines.some(l=>within(r,l)&&/GL-1[0-9]{2}/.test(l.text))?o:null;},'unbound space shows no other repository issues',45000);
    expect(Boolean(unboundView)&&activeSpace()===last.id,'noFallback');
    await railSearch('client');header=(await agentsHeader()).node.frame.y;await click('client-portal',(n,o)=>spaceRows(n,o,header),{only:true,control:'Space client-portal'});await until(()=>activeSpace()===runtime.spaceId,'client-portal selected',20000);await railSearch('');
    const agentsHit=await agentsHeader(),counts=agentsHit.observation.lines.filter(l=>inRail(l)&&Math.abs(l.frame.y+l.frame.height/2-agentsHit.node.frame.y-agentsHit.node.frame.height/2)<8).flatMap(l=>[...l.text.matchAll(/\b([0-9]{2,3})\b/g)].map(m=>Number(m[1])));
    expect(counts.some(n=>n>=AGENTS+2),'dozensAgents');
    await agentSearch('00');const task0=await visible('Task 00',inRail,45000),ctx=await visible('83%',(n,o)=>inRail(n)&&n.frame.y>task0.node.frame.y&&n.frame.y<task0.node.frame.y+50,60000).catch(async error=>{
      // Name why the reading is unavailable: the reading's tooltip carries its reason.
      const o=await observe('Unavailable'),cell=o.matches.find(n=>inRail(n)&&n.frame.y>task0.node.frame.y&&n.frame.y<task0.node.frame.y+50);let tip='';
      if(cell){await runtime.driver.hover(cell.frame,{expectedSize:o.window});await new Promise(resolve=>setTimeout(resolve,1500));const t=await observe();tip=t.lines.filter(l=>l.frame.y>cell.frame.y-60&&l.frame.y<cell.frame.y+80&&l.frame.x>cell.frame.x-40).map(l=>l.text).join(' | ');}
      throw Error(error.message+' — reading tooltip: '+tip);});
    const {png,scale}=await image(ctx.observation),title=ctx.observation.lines.find(l=>inRail(l)&&l.text.includes('Task 00'))||task0.node,iconRect={x:title.frame.x-G.agentIcon.dx,y:title.frame.y+title.frame.height/2-G.agentIcon.size/2,width:G.agentIcon.size,height:G.agentIcon.size};
    const iconInk=inkCount(png,scale,iconRect,backgroundOf(png,scale,{x:iconRect.x-7,y:iconRect.y,width:5,height:iconRect.height}));
    await agentSearch('03');const quota3=await visible('20%',inRail,60000);await agentSearch('02');const quota2=await visible('20%',inRail,60000);
    expect(Boolean(ctx&&quota3&&quota2)&&quota3.observation.lines.some(l=>inRail(l)&&/Context/.test(l.text))&&quota2.observation.lines.some(l=>inRail(l)&&/Quota/.test(l.text)),'contextQuota');
    expect(iconInk>12,'agentIcons');
    await agentSearch('');let a=await agentsHeader(),top=a.node.frame.y+a.node.frame.height/2-G.header/2;await clickRect({x:G.agentButtons.spaces,y:top+4,width:G.agentButton,height:G.agentButton},a.observation,'Agents group by space');
    await until(async()=>(await shared())[STATE_KEYS.agents]?.mode==='spaces','agents grouped by space',20000);const grouped=await optional(visible('agents-alpha',inRail,20000));
    a=await agentsHeader();top=a.node.frame.y+a.node.frame.height/2-G.header/2;await clickRect({x:G.agentButtons.priority,y:top+4,width:G.agentButton,height:G.agentButton},a.observation,'Agents priority');
    await until(async()=>(await shared())[STATE_KEYS.agents]?.mode==='priority','agents by priority',20000);expect(Boolean(grouped),'agentGrouping');

    await progress('swap-classic');console.log('Layout native: swap back to Classic and the held All-spaces MR action');
    await focusLocal();await selectSource('merges');await focusLocal();expect(await swap(LAYOUTS.classic),'swapToClassic');await ensurePanel();
    expect((await shared())[STATE_KEYS.nav]?.source==='merges'&&Boolean(await separated('merges')),'sourceKeptClassic');
    await scope('merges',true);await search('merges','Server: Review reconnect handling');const held=fixtures.gitlab.hold('personal',42);await focusLocal();before=await requestIds();await mergeStart(1);
    await until(()=>held.entered,'clicked remote MR detail actually pending',45000);runtime.app(['do','space.select',JSON.stringify({id:billingSpace.space})]);await scope('merges',false);held.release();
    const mrRemote=await newRecord(before,r=>r.request.source?.kind==='gitlab-mr'&&r.request.source.connectionId==='gitlab-personal','held remote MR review');
    expect(mrRemote.request.spaceId===remote.id&&mrRemote.request.machine===HOST&&mrRemote.request.repoRoot===server.repo&&mrRemote.request.checkoutRoot===server.repo&&mrRemote.request.source.id===mrId('personal',42)&&remoteCwd(mrRemote)===mrRemote.folder
      &&Boolean(await received(mrRemote,'Mission Control action: Review merge request')),'heldRemoteMerge');
    await search('merges','');await focusLocal();await separated('merges');await runtime.frame(CLASSIC_FRAME);

    await progress('offline');console.log('Layout native: offline second host, then reconnect');
    await fs.writeFile(gate,'offline\n');await railSearch(HOST);const railHeader=(await agentsHeader()).node.frame.y;
    // Throttled: one observation per poll while the transport drops and Herdr marks the machine unavailable.
    const offline=await until(async()=>{const o=await observe(),rows=o.lines.filter(l=>spaceRows(l,o,railHeader));if(rows.some(l=>/offline/i.test(l.text))||!rows.some(l=>l.text.includes('server-repo')))return o;await delay(3000);return null;},'second host observed offline',150000);
    const serverLive=live(server).length,pidsBefore=new Set((await actor.read()).map(r=>r.pid));await scope('merges',true);await search('merges','Server: Address redirect comments');before=await requestIds();
    const offlineCard=await optional(pick('Address comments',inStack,{only:true,description:'offline host MR card',timeout:15000}));if(offlineCard)await mergeStart(2);await delay(4000);
    const startedRemote=(await journal()).some(r=>!before.has(r.request.requestId)&&r.state==='complete'&&r.request.machine===HOST);
    await search('merges','');await scope('merges',false);await focusLocal();await selectSource('gitlab');before=await requestIds();await issueStart('GL-156',0);
    const localWhileOffline=await newRecord(before,r=>r.request.source?.kind==='gitlab'&&r.request.source.connectionId==='gitlab-work'&&r.request.source.id==='10156','local GL-156 start while the second host is offline');
    expect(Boolean(offline)&&!startedRemote&&live(server).length===serverLive&&!(await actor.read()).some(r=>!pidsBefore.has(r.pid)&&r.cwd.startsWith(server.directory))&&localWhileOffline.request.machine===null,'offlineHost');
    await fs.rm(gate,{force:true});
    await railSearch(HOST);
    const back=await until(async()=>{const o=await observe('server-repo');if(o.matches.some(n=>n.confidence>=0.6&&spaceRows(n,o,railHeader))&&!o.lines.some(l=>spaceRows(l,o,railHeader)&&/offline/i.test(l.text)))return o;await delay(3000);return null;},'second host back after reconnect',180000);
    expect(Boolean(back),'reconnect');await railSearch('');

    await progress('widths');console.log('Layout native: 736 and 1024 px in both layouts');
    let narrowSwaps=true;
    await positionWindow(runtime,{width:G.narrow});await ensurePanel();const classicIcons736=await iconsDrawn(),sessions736=Boolean(await selectSource('sessions'));
    let o=await observe(),swapLabel=(await controls()).label.node.frame;
    expect(classicIcons736&&sessions736&&swapLabel.x+swapLabel.width<=o.window.width-G.barRight+2&&await has('Settings',inFooter)&&await has('Add machine',inFooter),'classicNarrow');
    narrowSwaps=await swap(LAYOUTS.overview)&&narrowSwaps;expect(await navLabels('short')&&Boolean(await selectSource('merges')),'overviewNarrow');
    await click('Add machine',inFooter,{only:true,control:'Footer Add machine (736)'});await until(async()=>overlays().length&&await has('Add a machine'),'Herdr machine-add dialog at 736',20000);const machine736=await has('user@host');await closeOverlay();expect(machine736,'footerNarrow');
    await positionWindow(runtime,{width:G.wide});expect(await navLabels('short')&&Boolean(await selectSource('github')),'overviewWide');
    narrowSwaps=await swap(LAYOUTS.classic)&&narrowSwaps;await ensurePanel();expect(await iconsDrawn()&&Boolean(await selectSource('jira')),'classicWide');
    narrowSwaps=await swap(LAYOUTS.overview)&&narrowSwaps;expect(narrowSwaps,'narrowSwaps');await positionWindow(runtime);

    await progress('preview');console.log('Layout native: final overview frame and read-only provider evidence');
    await selectSource('jira');await scope('jira',false);await focusLocal();await separated('jira');await park();const preview=await runtime.frame(PREVIEW);
    assert.ok(Math.abs(preview.width/preview.height-G.width/G.height)<0.02,'The overview preview is a full 1280×760 window frame');
    expect(seen.mojibake.length===0,'utf8');
    expect(recordErrors()&&seen.errors.length===0,'noErrors');
    expect(providerRequestsReadOnly(fixtures.requests()),'providersReadOnly');
    runtime.packages.push({name:'mission-control',kind:'layout-bundle',layouts:shipped,mods:[...MODS],nativeLayoutSwitch:true,views:[LAYOUTS.overview,LAYOUTS.classic],widths:[G.narrow,G.wide,G.width]});
    // The preview is promoted only by `promote-preview` after the harness validated this receipt.
  }catch(error){
    console.error('Layout native failure: '+(error?.stack||error));
    try{
      await fs.mkdir(diagnostics,{recursive:true});
      for(const [name,file]of Object.entries(files))try{await fs.copyFile(file,path.join(diagnostics,'layout-failure-'+name+'.json'));}catch{}
      await fs.writeFile(path.join(diagnostics,'layout-native-console.txt'),(runtime.appStdout||'')+'\n'+(runtime.appStderr||''));
      try{await fs.writeFile(path.join(diagnostics,'layout-fixture-requests.json'),JSON.stringify(fixtures?.requests()||{},null,2));}catch{}
      try{await fs.writeFile(path.join(diagnostics,'layout-failure-actors.json'),JSON.stringify(await actor?.read(),null,2));}catch{}
      try{await fs.writeFile(path.join(diagnostics,'layout-failure-shared.json'),JSON.stringify(await runtime.shared(),null,2));}catch{}
      await fs.writeFile(path.join(diagnostics,'layout-failure-seen.json'),JSON.stringify({view,observations:serial,...seen},null,2));
      // App IPC before the window is proven owned would taint the private context and refuse cleanup.
      if(runtime.driver)try{await fs.writeFile(path.join(diagnostics,'layout-failure-status.json'),JSON.stringify({status:runtime.app(['status']),world:runtime.app(['ls'])},null,2));await runtime.frame('layout-failure');}catch{}
    }catch{}
    throw error;
  }finally{
    try{await fixtures?.close();}catch{}
    await fs.rm(gate,{force:true});
    if(connected)try{runtime.hc(['machine','rm',HOST,'--json']);}catch(error){if(error instanceof NativeIsolationError)throw error;}
    if(server.directory)await server.close();
  }
}

// ---------------------------------------------------------------------------------------------
// Preview promotion: only from a passed, validated receipt whose tested builds equal the current packages.
// ---------------------------------------------------------------------------------------------
export async function promotionPlan(receipt,{receiptPath,root=ROOT}={}){
  assert.equal(receipt?.ok,true,'Only a passed layout receipt can promote a preview');
  assert.equal(await validateNativeIsolationReceipt(receipt,receiptPath?{receiptPath}:{}),true);
  for(const label of Object.values(EXPECTATIONS))assert.ok(receipt.assertions.some(a=>a.label===label&&a.passed===true),'The passed receipt lacks: '+label);
  const frames={};
  for(const label of [PREVIEW,CLASSIC_FRAME]){
    const matches=receipt.frames.filter(f=>f.label===label);assert.equal(matches.length,1,'The passed receipt has exactly one native '+label+' frame');const frame=matches[0];assert.equal(frame.capture,'macos-window-server');
    const bytes=await fs.readFile(path.join(root,frame.path));assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.equal(sha(bytes),frame.sha256);frames[label]={frame,bytes};
  }
  assert.ok(Math.abs(frames[PREVIEW].frame.width/frames[PREVIEW].frame.height-G.width/G.height)<0.02,'The overview preview is a full rendered 1280×760 window frame');
  const bundle=receipt.packages.find(p=>p.name==='mission-control'&&p.kind==='layout-bundle');assert.ok(bundle,'The receipt records the tested layout bundle');assert.deepEqual([...bundle.mods].sort(),[...MODS].sort());
  for(const [file,expected]of Object.entries(bundle.layouts)){assert.equal(sha(await fs.readFile(path.join(root,'src',file))),expected,file);const copy=path.join(root,'mission-control',file);if(await exists(copy))assert.equal(sha(await fs.readFile(copy)),expected,'bundle '+file);}
  for(const name of MODS){
    const tested=receipt.packages.find(p=>p.name===name);assert.equal(tested?.nativeCheck,true,name+' passed herdr-app check');
    const manifest=JSON.parse(await fs.readFile(path.join(root,name,'build-manifest.json'),'utf8'));assert.deepEqual(tested.manifest,manifest,'The preview belongs to a different build of '+name);
    const bundled=path.join(root,'mission-control/mods',name),inBundle=await exists(bundled);
    for(const [file,expected]of Object.entries(manifest.artifacts)){assert.equal(sha(await fs.readFile(path.join(root,name,'mods',name,file))),expected,name+'/'+file);if(inBundle)assert.equal(sha(await fs.readFile(path.join(bundled,file))),expected,'bundle '+name+'/'+file);}
    for(const [file,expected]of Object.entries(manifest.sources))assert.equal(sha(await fs.readFile(path.join(root,file))),expected,file);
  }
  return {writes:[[path.join(root,'mission-control/preview.png'),frames[PREVIEW].bytes],[path.join(root,'evidence/native/mission-control.png'),frames[PREVIEW].bytes],[path.join(root,'evidence/native/mission-control-classic.png'),frames[CLASSIC_FRAME].bytes]],
    summary:{preview:{sha256:frames[PREVIEW].frame.sha256,frame:frames[PREVIEW].frame.path},classic:{sha256:frames[CLASSIC_FRAME].frame.sha256,frame:frames[CLASSIC_FRAME].frame.path}}};
}
export async function promotePreview(){
  const receipt=JSON.parse(await fs.readFile(path.join(ROOT,RECEIPT),'utf8')),plan=await promotionPlan(receipt,{receiptPath:RECEIPT});
  for(const [target,bytes]of plan.writes){await fs.mkdir(path.dirname(target),{recursive:true});const next=target+'.next';await fs.writeFile(next,bytes);await fs.rename(next,target);}
  return {promoted:true,...plan.summary};
}

// ---------------------------------------------------------------------------------------------
// Core-free preflight: no Herdr app or core is constructed, queried or stopped.
// ---------------------------------------------------------------------------------------------
/** Source facts the geometry and labels rely on; a drift fails the preflight before any native run. */
export const SOURCE_FACTS=Object.freeze([
  ['src/mods/mission-control-tabs/main.js',['TOPBAR_WIDE=720','.pr(8).gap(4)','renderSwap(MOD,contract,{compact:!(this.width>=TOPBAR_WIDE)']],
  ['src/mods/mission-control-tabs/navigation.js',['el=compact?el.w(28):el.px(9)','.gap(6).rounded(6).border(1)',"icon(mod,'layout',14)","{active:open,disabled:!enabled,size:26}","'Hide work panel',(_e,cx)=>onHide?.(cx),{size:24}",'.px(6).gap(NAV_METRICS.gap)']],
  ['src/shared/issue-board.js',['max_w(narrow?460:360).p(10).gap(7)','.size(25).flex_none()','el.h(36)','narrow=(props.width??state.width)<768','.p(narrow?10:14)',"'This space'","'All spaces'"]],
  ['src/mods/mission-control-gitlab/merges-view.js',['.size(26).flex_none()','.p(11).gap(7)','narrow=width<560','.p(narrow?10:14)',"'Address comments'","'Search merge requests'"]],
  ['src/mods/mission-control-github/pulls-view.js',["'Search pull requests'"]],
  ['src/mods/mission-control-sessions/main.js',["'Search sessions'","'This space'","'All spaces'"]],
  ['src/shared/ui.js',['h_flex().h(32).gap(4).px(8)','h_flex().id(id).h(30).gap(6).px(8)']],
  ['src/mods/mission-control-agents/main.js',['pl(7+Math.min(row.depth,4)*10)','toolIcon(MOD,row.program,15)',"{active:s.mode==='priority',size:24}","{active:s.mode==='spaces',size:24}","'Find an agent'"]],
  ['src/mods/mission-control-spaces/main.js',["this.action('settings','settings','Settings'","this.action('add-machine','plus','Add machine'","'Previous sessions'","'Open in Finder'","'Find a space'"]],
  ['src/shared/launch-dialog.js',["'Start agent'","'Current checkout'"]]]);

export async function checkFixtures({build=process.argv.includes('--build')}={}){
  const directory=await fs.realpath(await fs.mkdtemp('/private/tmp/mcqa-')),home=path.join(directory,'app'),checks=[],notes={};const check=(condition,label)=>{assert.ok(condition,label);checks.push(label);};let fixtures;
  try{
    // 1. Pure import and allowlisted child environment, in a fresh process under sentinel ambient settings.
    const ordinary=['PATH','LANG','LC_ALL','LC_CTYPE','TZ','TERM','NO_COLOR'],importEnv=Object.fromEntries(ordinary.filter(key=>typeof process.env[key]==='string').map(key=>[key,process.env[key]]));
    Object.assign(importEnv,{HOME:directory+'/sentinel-home',XDG_RUNTIME_DIR:directory+'/sentinel-runtime',HC_SESSION:'sentinel-live-core',HERDR_APP_HOME:directory+'/sentinel-app',CODEX_HOME:directory+'/sentinel-codex',CLAUDE_CONFIG_DIR:directory+'/sentinel-claude',GH_TOKEN:'sentinel-ambient-token',QA_GITLAB_WORK:'sentinel-ambient-token',QA_UNSELECTED:'sentinel-ambient-token'});
    const expectedKeys=Object.keys(fixtureEnvironment).sort();
    const handoff=`import assert from 'node:assert/strict';import {importNativeScenario,isolatedEnvironment} from ${JSON.stringify(new URL('../../scripts/native-harness.mjs',import.meta.url).href)};const before={...process.env};const loaded=await importNativeScenario(${JSON.stringify(fileURLToPath(import.meta.url))});assert.deepEqual({...process.env},before);const env=isolatedEnvironment('/private/tmp/mcqa-preflight','a'.repeat(24),process.env,loaded.fixtureEnvironment);assert.equal(env.HOME,'/private/tmp/mcqa-preflight/h');assert.equal(env.HERDR_APP_HOME,'/private/tmp/mcqa-preflight/app');assert.equal(env.QA_GITLAB_WORK,'owned-gitlab-work');for(const key of ['CODEX_HOME','CLAUDE_CONFIG_DIR','GH_TOKEN','QA_UNSELECTED'])assert.equal(env[key],undefined,key);assert.deepEqual(Object.keys(loaded.fixtureEnvironment).sort(),${JSON.stringify(expectedKeys)});console.log(JSON.stringify({pureImport:true,allowlistedChild:true}));`;
    const imported=await execute(process.execPath,['--input-type=module','-e',handoff],{env:importEnv,timeout:20000});check(JSON.stringify(JSON.parse(imported.stdout))===JSON.stringify({pureImport:true,allowlistedChild:true})&&imported.stderr==='','Scenario import is pure and its fixture environment is allowlisted synthetic QA values only');
    check(Object.values(EXPECTATIONS).length===new Set(Object.values(EXPECTATIONS)).size&&Object.values(EXPECTATIONS).every(l=>l.length<=1800&&!/[\u0000-\u001f]/.test(l)),'Expectation labels are unique bounded receipt labels');
    const flow=String(layoutNative);check(Object.keys(EXPECTATIONS).every(key=>flow.includes(`'${key}')`)),'Every expectation label is emitted by the mounted flow');
    // 2. Source facts behind the geometry and labels.
    for(const [file,facts]of SOURCE_FACTS){const text=await fs.readFile(path.join(ROOT,file),'utf8');for(const fact of facts)check(text.includes(fact),file+' still contains '+fact);}
    // 3. Layout sources: exact bytes, node geometry and the navigation presentation at each width.
    const trees={};for(const name of Object.values(LAYOUTS)){const raw=await fs.readFile(path.join(ROOT,'src/layouts',name+'.json'),'utf8'),tree=JSON.parse(raw);trees[name]=tree;check(JSON.stringify(tree,null,2)+'\n'===raw,name+' installs byte-identically through the harness layout writer');}
    for(const file of LAYOUT_FILES){const copy=path.join(ROOT,'mission-control/layouts',file);if(await exists(copy))check((await fs.readFile(copy)).equals(await fs.readFile(path.join(ROOT,'src/layouts',file))),'Bundle copy of '+file+' equals its source');}
    const ov=trees[LAYOUTS.overview],cl=trees[LAYOUTS.classic],px=(tree,id)=>findNode(tree,id)?.size?.px;
    check([ov,cl].every(t=>px(t,'mc-topbar')===G.topbar&&px(t,'sidebar')===G.rail&&px(t,'mc-rail-footer')===G.footer&&px(t,'mc-navigation')===G.nav&&findNode(t,'mc-body').divider.width===G.divider),'Both layouts keep the 42 px bar, 220 px rail, 69 px footer and 34 px navigation');
    check(findNode(ov,'mc-work').size.weight===G.workWeight&&findNode(ov,'mc-terminals').size.weight===G.termWeight&&findNode(ov,'mc-work').min===G.workMin&&findNode(ov,'mc-main').divider.width===G.divider,'Overview splits work 3 : terminals 2');
    check(findNode(cl,'mc-main').padding===G.pad&&findNode(cl,'mc-main').gap===G.gap&&px(cl,'mc-work-panel')===G.panel&&findNode(cl,'mc-work-panel').hidden===true,'Classic keeps a hidden 360 px work panel inside 8 px padding');
    check(findNode(ov,'mc-topbar').content.props.swapTo===LAYOUTS.classic&&findNode(cl,'mc-topbar').content.props.swapTo===LAYOUTS.overview&&findNode(cl,'mc-topbar').content.props.panel===true,'Each topbar swaps to the other installed layout');
    check(Object.values(LAYOUTS).every(name=>JSON.stringify(findNode(trees[name],'mc-work-stack').children.map(c=>c.id))===JSON.stringify(SOURCES.map(s=>s.id))),'Both stacks hold the seven sources in navigation order');
    await import('../support/native-loader.mjs');const nav=await import('../../src/mods/mission-control-tabs/navigation.js');
    check(nav.navigationWidth('full')===G.navFull&&nav.navigationWidth('short')===G.navShort&&nav.NAV_METRICS.button===G.navButton&&nav.NAV_METRICS.gap===G.navGap&&nav.NAV_METRICS.pad===2*G.navPadX,'Navigation metrics match the geometry');
    check(JSON.stringify(nav.SOURCES.map(s=>[s.id,s.label,s.short,s.scopeKey]))===JSON.stringify(SOURCES.map(s=>[s.id,s.full,s.short,s.key]))&&nav.NAV_STATE===STATE_KEYS.nav&&JSON.stringify(nav.LAYOUT_LABELS)===JSON.stringify(LAYOUT_LABELS),'Source labels, scope keys and swap labels match navigation.js');
    const modes={};for(const width of [G.narrow,G.wide,G.width]){
      const o=widthsAt(ov,width),c=widthsAt(cl,width,{open:['mc-work-panel']}),w={width,height:G.height};
      check(o.get('sidebar')===G.rail&&o.get('mc-main')===width-G.rail-G.divider&&stackRect(LAYOUTS.overview,w).width===o.get('mc-work')&&navRect(LAYOUTS.overview,w).width===o.get('mc-navigation'),'Overview regions at '+width+' px follow the layout solver');
      check(c.get('mc-work-panel')===G.panel&&c.get('mc-terminals')>=100&&stackRect(LAYOUTS.classic,w).x===width-G.pad-G.panel&&navIcon(SOURCES.length-1,w).x+G.navButton<=width-G.pad-G.navHide,'Classic panel at '+width+' px keeps terminals and six icon sources');
      modes[width]={overview:nav.navigationMode(o.get('mc-navigation')),classic:nav.navigationMode(c.get('mc-navigation'),{panel:true})};
      check(modes[width].overview===navMode(LAYOUTS.overview,w)&&modes[width].classic==='icons','Navigation presentation at '+width+' px is '+modes[width].overview+' / icons');
    }
    check(modes[G.width].overview==='full'&&modes[G.wide].overview==='short'&&modes[G.narrow].overview==='short','Full labels at 1280 px and short labels at 1024 and 736 px');notes.navigation=modes;
    // 4. Current helpers against the owned TLS sites. By default the unbundled source helpers run (the mounted gate bundles
    //    exactly these sources fresh); --build opts into fresh buildPackage copies, which rewrites those package outputs.
    fixtures=await providerFixtures(path.join(directory,'providers-tls'));await fs.mkdir(path.join(home,'mods'),{recursive:true});const stale=[],helpers={};
    for(const name of MODS){
      const manifest=await readJson(path.join(ROOT,name,'build-manifest.json'));let current=Boolean(manifest);
      for(const [file,expected]of Object.entries(manifest?.sources||{}))if(!await exists(path.join(ROOT,file))||sha(await fs.readFile(path.join(ROOT,file)))!==expected){current=false;break;}
      if(!current)stale.push(name);
    }
    for(const name of ['mission-control-jira','mission-control-github','mission-control-gitlab']){
      if(build){const built=await buildPackage(name),target=path.join(home,'mods',name);await fs.cp(built.directory,target,{recursive:true});helpers[name]=path.join(target,'backend.mjs');}
      else helpers[name]=path.join(ROOT,'src/mods',name,'backend.mjs');
    }
    notes.packages={helpers:build?'fresh buildPackage copies':'current unbundled source helpers (no package output rewritten)',staleStandaloneOutputs:stale};
    const ca=path.join(directory,'fixture-cas.pem');await fs.writeFile(ca,(await Promise.all(fixtures.sites.map(s=>fs.readFile(s.caFile,'utf8')))).join('\n'));
    const env=isolatedEnvironment(directory,crypto.randomBytes(12).toString('hex'),process.env,{...fixtureEnvironment,NODE_EXTRA_CA_CERTS:ca});for(const key of ['HOME','TMPDIR','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_CACHE_HOME','XDG_RUNTIME_DIR'])await fs.mkdir(env[key],{recursive:true,mode:0o700});
    const history={local:await writeHistory(directory,{repo:'/fixture/repo',linked:'/fixture/linked',billing:'/fixture/billing'},{entries:HISTORY}),remote:await writeHistory(path.join(directory,'server'),{repo:'/fixture/server'},{machine:HOST,entries:REMOTE_HISTORY})};
    const config=configuration({repo:'/fixture/repo',billing:'/fixture/billing',serverRepo:'/fixture/server'},fixtures,history),local=config.bindings[bindingKey(null,'/fixture/repo')],billingBinding=config.bindings[bindingKey(null,'/fixture/billing')],server=config.bindings[bindingKey(HOST,'/fixture/server')];
    check(Boolean(local.jira&&local.github&&local.gitlab)&&Object.values(config.usageSources).every(s=>validateUsageSource(s))&&config.usageSources['local-claude'].cacheRoots.length===1,'One repo binding carries Jira, GitHub and GitLab and every usage source validates');
    const jiraWork=await helper(helpers['mission-control-jira'],env,helperInput(config,local,'jira','issues')),jiraPersonal=await helper(helpers['mission-control-jira'],env,helperInput(config,billingBinding,'jira','issues'));
    check(jiraWork.ok&&jiraPersonal.ok&&jiraWork.snapshot.data.length===3&&jiraPersonal.snapshot.data.length===3,'The current Jira helper reads both owned accounts');
    const w142=jiraWork.snapshot.data.find(i=>i.key==='WEB-142'),p142=jiraPersonal.snapshot.data.find(i=>i.key==='WEB-142');
    check(w142.identity.id===p142.identity.id&&w142.identity.connectionId!==p142.identity.connectionId&&issueIdentityKey(w142)!==issueIdentityKey(p142)&&w142.repoBinding.repoRoot!==p142.repoBinding.repoRoot,'Duplicate Jira key and ID on two accounts keep distinct identities and repositories');
    check(JSON.stringify(jiraWork.snapshot.data.map(i=>i.statusGroup))==='["todo","inProgress","done"]','Jira fixture covers To do, In progress and Done');
    for(const [binding,expected]of [[local,['todo','inProgress','done']],[server,['todo','todo','done']]]){
      const gh=await helper(helpers['mission-control-github'],env,helperInput(config,binding,'github','issues')),gl=await helper(helpers['mission-control-gitlab'],env,helperInput(config,binding,'gitlab','issues'));
      check(gh.ok&&gl.ok&&JSON.stringify(gh.snapshot.data.map(i=>i.statusGroup))===JSON.stringify(expected)&&JSON.stringify(gl.snapshot.data.map(i=>i.statusGroup))===JSON.stringify(expected),'GitHub and GitLab issue helpers read the '+(binding.machine||'local')+' binding');
      if(binding.machine){const lw=await helper(helpers['mission-control-gitlab'],env,helperInput(config,local,'gitlab','issues'));check(lw.snapshot.data[0].identity.id===gl.snapshot.data[0].identity.id&&lw.snapshot.data[0].identity.connectionId!==gl.snapshot.data[0].identity.connectionId&&gl.snapshot.data[0].repoBinding.machine===HOST,'GitLab GL-142 shares its provider ID across accounts while keeping its host and account');}
      const prs=await helper(helpers['mission-control-github'],env,helperInput(config,binding,'github','pulls')),mrs=await helper(helpers['mission-control-gitlab'],env,helperInput(config,binding,'gitlab','merges'));
      check(prs.ok&&mrs.ok&&prs.snapshot.data.length===11&&mrs.snapshot.data.length===11&&mrs.snapshot.data.some(m=>m.identity.id===mrId(binding.machine?'personal':'work',42)),'PR and MR lists for the '+(binding.machine||'local')+' binding carry the opaque MR identity');
    }
    const requests=fixtures.requests();check(providerRequestsReadOnly(requests),'Every owned provider request is read-only and uses only its own account credentials');
    check(requests.jira.filter(r=>r.profile==='personal'&&r.path.startsWith('/rest/')).length>0&&requests.jira.every(r=>r.authorized),'The second Jira site saw only its own synthetic Basic credentials');
    // 5. Disposable actors, capabilities and the telemetry/quota fixture.
    const actors=await writeActors(directory,home);
    for(const tool of Object.keys(TOOLS)){
      const help=(await execute(actors.programs[tool].run[0],['--help'],{env,timeout:10000})).stdout,resumeHelp=tool==='codex'?(await execute(actors.programs[tool].run[0],['resume','--help'],{env,timeout:10000})).stdout:'';
      const caps=parseCapabilities({key:tool,name:TOOLS[tool].name,run:actors.programs[tool].run,installed:true},{help,resumeHelp});
      check(caps.provider===tool&&(tool==='claude'?caps.callerSession==='--session-id'&&caps.resume?.flag==='--resume':tool==='codex'?caps.resume?.command==='resume':!caps.resume&&!caps.callerSession),'The '+tool+' actor help yields its exact-session capability');
    }
    const id=crypto.randomUUID(),child=spawn(actors.programs.claude.run[0],['--session-id',id],{cwd:directory,stdio:['pipe','ignore','ignore']}),exited=new Promise(resolve=>child.once('exit',resolve));
    const started=await until(async()=>(await actors.read()).find(r=>r.pid===child.pid),'actor record',10000);child.stdin.write('Mission Control action: Review merge request\n');
    await until(async()=>(await actors.read()).find(r=>r.pid===child.pid)?.received.includes('Review merge request'),'actor received stdin',10000);child.stdin.end();await exited;
    check(started.cwd===directory&&JSON.stringify(started.argv)===JSON.stringify(['--session-id',id]),'The launch actor records exact argv, folder, pid and the delivered task');
    const tool=path.join(directory,'qa-telemetry');await fs.writeFile(tool,TELEMETRY_ACTOR);await fs.chmod(tool,0o700);
    const specs=telemetrySpecs({sources:history.local.sources,agentsRepo:'/fixture/agents',directory,spaces:['alpha','beta']});await fs.mkdir(path.dirname(specs.quotaFile),{recursive:true});
    check(specs.agents.length===AGENTS&&specs.agents.filter(a=>a.spec.log).length===BOUND.length&&specs.agents[0].provider==='codex'&&specs.agents[2].provider==='claude'&&specs.agents[3].provider==='claude'&&specs.quota.session_accounts[specs.agents[2].id]===specs.quota.session_accounts[specs.agents[3].id],'Thirty telemetry agents with one Codex context session and two shared-account Claude sessions');
    const runs=[];let written;try{for(const index of [0,2]){const agent=specs.agents[index];await fs.writeFile(agent.file,JSON.stringify(agent.spec));runs.push(spawn(tool,[agent.provider==='codex'?'resume':'--session-id',agent.id,agent.file],{stdio:'ignore'}));}
      written=await until(async()=>{const codex=await readText(specs.agents[0].spec.log),quota=await readJson(specs.quotaFile);return codex?.includes('token_count')&&codex.includes('session_meta')&&quota?.session_quota_observations?.[specs.agents[3].id]&&Math.abs(quota.fetched_at_unix-Date.now()/1000)<30?{codex,quota}:null;},'telemetry metadata written',15000);
    }finally{for(const r of runs)r.kill('SIGTERM');}
    check(written.quota.session_windows[specs.agents[3].id][0].remaining_percent===20&&written.quota.session_accounts[specs.agents[2].id]===written.quota.session_accounts[specs.agents[3].id],'Telemetry agents write Codex token-count metadata and the fresh shared Claude quota cache');
    // 6. Second-host transport gate and window helper.
    const gate=path.join(directory,'gate'),via=path.join(directory,'via.py');await fs.writeFile(via,viaSource({HC_SESSION:'mcqa-fixture-check'},gate));await fs.chmod(via,0o700);
    check((await execute(via,['ignored','echo "$HC_SESSION"'],{timeout:10000})).stdout.trim()==='mcqa-fixture-check','The via transport applies the second core selectors');
    await fs.writeFile(gate,'offline\n');const refused=await execute(via,['echo connected'],{timeout:10000}).then(()=>null,error=>error);check(refused?.code===75,'The via gate refuses connections while the second host is offline');await fs.rm(gate);
    await positionWindow(null,{compileOnly:true,directory,cache:path.join(directory,'swift-cache')});check(true,'The owned window positioning helper compiles');
    // 7. Pixel helpers and preview promotion refusal.
    const sample=path.join(ROOT,'mission-control-agents/preview.png');if(await exists(sample)){const png=decodePng(await fs.readFile(sample));check(png.width>0&&inkCount(png,1,{x:0,y:0,width:Math.min(200,png.width),height:Math.min(200,png.height)},[0,0,0],1)>=0,'The PNG decoder reads an actual native frame');}
    const previewFile=path.join(ROOT,'mission-control/preview.png'),previewBefore=await fs.readFile(previewFile).catch(()=>null);
    await assert.rejects(promotionPlan({ok:false}),/passed layout receipt/);await assert.rejects(promotionPlan({v:2,ok:true}),error=>error instanceof NativeIsolationError);
    const previewAfter=await fs.readFile(previewFile).catch(()=>null);check(previewBefore===null?previewAfter===null:previewBefore.equals(previewAfter),'Failed or unvalidated receipts cannot promote a preview');
    return {ok:true,assertions:checks.length,checks,notes,boundary:'Owned TLS provider sites, current Jira/GitHub/GitLab helpers (source, or fresh builds with --build), disposable actors, telemetry fixtures, the via gate, layout/source geometry and the window helper only. No Herdr app/core was constructed, queried or stopped; no receipt or preview was written.'};
  }finally{await fixtures?.close();await fs.rm(directory,{recursive:true,force:true});}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const mode=process.argv[2],check={'fixture-check':checkFixtures,'promote-preview':promotePreview}[mode];
  if(!check)throw Error('Use node scripts/native-harness.mjs run layout for the mounted gate, fixture-check [--build] for the core-free preflight, or promote-preview after a passed receipt.');
  check().then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(error);process.exitCode=1;});
}
