/**
 * RestartRunner: observes agent terminals, learns their exact sessions, and after a lost terminal process
 * types the tool's resume command into the restored shell (or offers it). One lease holder per app home
 * observes and runs passes; every copy can resume or dismiss an offer the person clicks. It holds no cx.
 */
import {machineIdentity,localTerminalAddress,terminalIdentity} from './session-identity.js';
import {installedTools} from './launch-preferences.js';
import {CapabilityRegistry,buildArguments} from './tool-capabilities.js';
import {BindingStore} from './session-bindings.js';
import {readConfig} from './config.js';
import {hostFacts,hostClaim} from './restart-host.js';
import {codexHook,parseCodexLabel,CODEX_LABEL} from './codex-session-hook.js';
import {RESTART,RESTART_STATE_KEY,RunningAgents,observeMachine,decide,markSending,markOutcome,dismiss,offers,claimKey,resumeLine,cdPrefix,resumePreference,argvSession,providerOf,agentProcess,isWrapper,takeLease,releaseLease,machineKey,machineOf,POSIX_SHELLS} from './restart-resume.js';

export const RUNNER=Object.freeze({episodeMs:90000,tickMs:5000,budget:8,refreshMs:30000,journalRefreshMs:5000,listMs:30000,factsFreshMs:10000,codexStatusMs:600000,staleTickMs:25000});
const SHELL_NAMES=new Set([...POSIX_SHELLS,'fish','nu','tcsh','csh','elvish','xonsh']);
const DEFAULT_ROOTS={claude:'~/.claude',grok:'~/.grok'};
const freeze=v=>{if(v&&typeof v==='object'&&!Object.isFrozen(v)){for(const c of Object.values(v))freeze(c);Object.freeze(v);}return v;};
const base=v=>typeof v==='string'?v.slice(v.lastIndexOf('/')+1).replace(/^-+/,''):'';
const safeMachine=v=>{try{return machineIdentity(v);}catch{return undefined;}};
const strip=(id,on)=>typeof id==='string'&&on&&id.startsWith(on+'/')?id.slice(on.length+1):id;
const qualify=(id,on)=>on?on+'/'+id:id;

class Budget {constructor(n){this.left=n;}take(n=1){if(this.left<n)return false;this.left-=n;return true;}}

export class RestartRunner {
  constructor(io,{owner,clock=()=>Date.now(),budget=RUNNER.budget}={}){
    this.io=io;this.owner=owner||'restart-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8);this.clock=clock;this.budgetSize=budget;
    this.journal=new RunningAgents(io,{clock});this.bindings=new BindingStore(io,{clock});
    this.fetched=new Map();this.signatures=new Map();this.facts=new Map();this.listed=new Map();this.codex=new Map();this.codexAt=0;
    this.value=null;this.status='starting';this.error=null;this.ticking=0;this.passes=0;this.closed=false;this.lastSummary=null;
  }
  async exec(budget,cmd,args,options){if(budget&&!budget.take())throw Object.assign(Error('budget'),{code:'BUDGET'});return this.io.exec(cmd,args,options);}

  /** One bounded step. Never throws. */
  async tick(){
    const now=this.clock();if(this.closed||this.ticking&&now-this.ticking<RUNNER.staleTickMs)return {skipped:true};this.ticking=now;
    try{
      const {value,status}=await this.journal.read();
      if(status==='newer'){this.status='idle-newer';this.value=null;return {idle:true};}
      this.value=value;const budget=new Budget(this.budgetSize);
      const {result}=await this.journal.edit((d,t)=>{const before=JSON.stringify(d.lease),owned=takeLease(d,this.owner,t);return {write:JSON.stringify(d.lease)!==before?undefined:false,owned};});
      if(!result.owned){this.status='watching';return {owned:false};}
      this.status='observing';
      if(this.hasLost(this.value))await this.pass(budget);
      await this.observe(budget);
      if(now-this.codexAt>=RUNNER.codexStatusMs)await this.refreshCodex();
      this.value=(await this.journal.read()).value;this.error=null;return {owned:true};
    }catch(error){this.error=freeze({code:error?.code||'RESTART_FAILED',message:error?.code==='NEWER_JOURNAL'?error.message:'Resume after restart could not check agents; nothing was typed.'});return {error:this.error};}
    finally{this.ticking=0;}
  }
  hasLost(value){return Object.values(value?.machines||{}).some(m=>Object.values(m.terminals).some(e=>e.state==='lost'));}

  machines(){
    const list=typeof this.io.machines==='function'?this.io.machines()||[]:[{name:null,layout:'ready'}];
    return list.filter(m=>m&&!m.temporary&&m.layout==='ready'&&safeMachine(m.name)!==undefined).map(m=>safeMachine(m.name));
  }
  /** Every terminal worth a look on each machine: agents(), agent-program panes and journal entries. */
  candidates(){
    const spaces=this.io.spaces?.()||[],machineOfSpace=new Map(),tabSpace=new Map(),out=new Map();
    for(const s of spaces){const m=safeMachine(s?.machine);if(m===undefined)continue;machineOfSpace.set(s.id,m);for(const t of s.tabs||[])tabSpace.set(t.id,s.id);}
    const add=(m,address,info)=>{let local;try{local=localTerminalAddress(address,m);}catch{return;}const key=machineKey(m);if(!out.has(key))out.set(key,new Map());const map=out.get(key),prev=map.get(local)||{};map.set(local,{...prev,...info});};
    for(const a of this.io.agents?.()||[]){const m=machineOfSpace.get(a?.space);if(m===undefined||!a.address)continue;add(m,a.address,{app:a.app,programKey:a.program?.key,status:a.status});}
    for(const p of this.io.panes?.()||[]){
      if(!p?.terminal)continue;const k=String(p.program?.key||'').toLowerCase();if(!(p.program?.agent===true||['claude','codex','grok'].includes(k)))continue;
      const m=machineOfSpace.get(tabSpace.get(p.tab));if(m===undefined)continue;add(m,p.terminal,{programKey:p.program?.key,app:p.app});
    }
    for(const [key,m]of Object.entries(this.value?.machines||{}))for(const a of Object.keys(m.terminals)){if(!out.has(key))out.set(key,new Map());const map=out.get(key);if(!map.has(a))map.set(a,{});map.get(a).journal=true;}
    return out;
  }
  async roots(provider,machine){
    try{const s=await this.io.sessionSource?.(provider,machine);if(s?.providerRoot)return s.providerRoot;}catch{}
    return null;
  }
  async observe(budget){
    const now=this.clock(),ready=new Set(this.machines().map(m=>machineKey(m))),all=[...this.candidates()];
    // Machines take turns going first, so one busy machine never starves another.
    const turn=all.length?(this.turn=(this.turn??-1)+1)%all.length:0;
    for(const [key,terms]of [...all.slice(turn),...all.slice(0,turn)]){
      if(!ready.has(key)||budget.left<2)continue;const machine=machineOf(key);
      // Journal entries first and at start, then changed listings, then the oldest look.
      const order=[...terms].map(([a,info])=>{const sig=JSON.stringify([info.programKey??null,info.app??null,Boolean(info.status)]),changed=this.signatures.get(key+a)!==sig,last=this.fetched.get(key+a)??0;
        return {a,info,sig,score:info.journal?(now-last>=RUNNER.journalRefreshMs?0:3):changed?1:now-last>=RUNNER.refreshMs?2:9,last};}).filter(x=>x.score<9).sort((x,y)=>x.score-y.score||x.last-y.last);
      let live=null;
      if(now-(this.listed.get(key)??0)>=RUNNER.listMs&&Object.keys(this.value?.machines?.[key]?.terminals||{}).length&&budget.left>=3&&budget.take()){
        try{const r=await this.io.exec('hc',['ls','--json'],{on:machine});const list=r?.code===0?JSON.parse(r.stdout).terminals:null;
          if(Array.isArray(list)){live=new Set();for(const t of list)if(t&&(t.state===undefined||t.state==='live'))try{live.add(localTerminalAddress(t.address,machine));}catch{}this.listed.set(key,now);}}catch{}
      }
      const raws=new Map();
      for(const x of order){
        if(budget.left<2)break;budget.take();
        try{const r=await this.io.exec('hc',['get',x.a,'--json'],{on:machine});if(r?.code!==0)continue;const raw=JSON.parse(r.stdout);if(localTerminalAddress(raw.address,machine)!==x.a||raw.state&&raw.state!=='live')continue;raws.set(x.a,{raw,info:x.info});this.fetched.set(key+x.a,now);this.signatures.set(key+x.a,x.sig);}catch{}
      }
      if(!raws.size&&!live)continue;
      const [claudeRoot,grokRoot]=await Promise.all([this.roots('claude',machine),this.roots('grok',machine)]);
      let facts={ok:false};
      if(raws.size&&budget.take())facts=await hostFacts(this.io,{machine,terminals:[...raws].map(([a,{raw}])=>({address:a,shellPid:raw.pid,foregroundPid:raw.foreground?.pid})),claudeRoot:claudeRoot??DEFAULT_ROOTS.claude,grokRoot:grokRoot??DEFAULT_ROOTS.grok}).then(r=>r,()=>({ok:false}));
      const terminals=new Map();
      for(const [a,{raw,info}]of raws){
        const f=facts.ok?facts.terminals.get(a):null;if(!f?.shell||!Number.isSafeInteger(f.shell.startMs))continue;
        const t=await this.describe(machine,a,raw,info,f);if(t){terminals.set(a,t);this.facts.set(key+a,{at:now,t});}
      }
      const obs={machine,ok:true,at:now,live,terminals};
      const {result}=await this.journal.edit((d,t)=>{if(d.lease?.owner!==this.owner)return {write:false,lost:[]};const r=observeMachine(d,obs,{owner:this.owner,now:t});return r.changed?r:{...r,write:false};});
      // A label survives recovery and PIDs restart low after a reboot, so a lost terminal's Codex label is cleared.
      if(result?.lost?.length)for(const a of result.lost)if(raws.get(a)?.raw?.labels?.[CODEX_LABEL]!==undefined&&budget.take())try{await this.io.exec('hc',['label',a,CODEX_LABEL+'='],{on:machine});}catch{}
    }
  }
  /** Turns hc get + host facts into the observation the journal rules take. */
  async describe(machine,address,raw,info,f){
    const labels=raw.labels||{},spaceId=labels['herdr.space'],tabId=labels['herdr.tab'];if(typeof spaceId!=='string'||typeof tabId!=='string')return null;
    const fg=raw.foreground||{},shellPid=raw.pid;if(!Number.isSafeInteger(shellPid))return null;
    const fgFacts=f.foreground&&f.foreground.pid===fg.pid?f.foreground:null;
    const picked=agentProcess({pid:fg.pid,argv:fg.argv},f.children);
    const agentFacts=picked?(picked.pid===fg.pid?fgFacts:f.children.find(c=>c.pid===picked.pid)):null;
    const provider=agentFacts?providerOf({programKey:info.programKey,app:info.app,argv:picked.pid===fg.pid?fg.argv:null,name:agentFacts.name}):null;
    const foregroundIsShell=fg.pid===shellPid&&SHELL_NAMES.has(base(f.shell.name||''))&&!isWrapper(fg.argv)&&!providerOf({argv:fg.argv,name:fg.name});
    const cwd=typeof fg.cwd==='string'?fg.cwd:typeof raw.cwd==='string'?raw.cwd:null;
    let agent=null;
    if(provider&&agentFacts&&Number.isSafeInteger(agentFacts.startMs)&&!foregroundIsShell){
      const s=f.sessions.get(agentFacts.pid)||{};let session=null;
      if(provider==='claude'&&s.claude?.sessionId)session={sessionId:s.claude.sessionId,via:'pid-record'};
      if(!session&&provider==='codex'){const l=parseCodexLabel(labels[CODEX_LABEL]);if(l&&l.pid===agentFacts.pid&&l.startMs===agentFacts.startMs)session={sessionId:l.sessionId,via:'codex-hook'};}
      if(!session&&provider==='grok'&&s.grok?.sessionId)session={sessionId:s.grok.sessionId,via:'open-file'};
      if(!session&&picked.pid===fg.pid){const hit=argvSession(fg.argv);if(hit&&hit.provider===provider)session={sessionId:hit.sessionId,via:'argv'};}
      if(!session)try{const bound=await this.bindings.readCommitted(terminalIdentity(raw,machine));if(bound?.session?.provider===provider)session={sessionId:bound.session.sessionId,via:'binding'};}catch{}
      agent={pid:agentFacts.pid,startMs:agentFacts.startMs,provider,toolKey:provider,sessionId:session?.sessionId??null,via:session?.via??null};
    }
    return {createdMs:Number.isSafeInteger(raw.created_ms)?raw.created_ms:undefined,spaceId:qualify(spaceId,machine),tabId:qualify(tabId,machine),shellPid,shellStartMs:f.shell.startMs,shellName:f.shell.name,shellAgeMs:f.shell.ageMs,foregroundIsShell,cwd,agent};
  }
  /** Verified resume argv for a provider on a machine; fresh skips the 60 s capability cache. */
  async tool(provider,machine,{fresh=false}={}){
    let tools;try{tools=installedTools(await this.io.knownAgents({on:machine}));}catch{return {argv:null,reason:`${machine??'This computer'} could not list its installed tools.`};}
    const tool=tools.find(t=>t.key===provider);if(!tool)return {argv:null,reason:`${provider} is not installed on ${machine??'this computer'}.`};
    let caps;try{caps=fresh?await new CapabilityRegistry(this.io.exec).get(tool,machine):this.io.capabilities?await this.io.capabilities.get(tool,machine):await new CapabilityRegistry(this.io.exec).get(tool,machine);}catch{return {argv:null,reason:`${provider}'s options could not be checked.`};}
    if(caps?.provider!==provider||!caps.resume)return {argv:null,reason:`This ${provider} has no verified exact-session resume.`};
    return {argv:null,caps,reason:null};
  }
  /** One restart pass over lost entries, within the tick budget. */
  async pass(budget){
    const now=this.clock(),passId=this.owner+'-p'+(++this.passes),summary={passId,at:now,resumed:[],offered:[],skipped:[],failed:[]};
    let preference;try{preference=resumePreference((await readConfig(this.io)).value);}catch{preference={on:false,reason:'Mission Control settings could not be read, so nothing was typed.'};}
    const tools=new Map();let sends=0;
    for(const [key,m]of Object.entries(this.value.machines)){
      const machine=machineOf(key);
      for(const [address,e]of Object.entries(m.terminals)){
        if(e.state!=='lost')continue;const fresh=this.facts.get(key+address);
        if(!fresh||now-fresh.at>RUNNER.factsFreshMs||fresh.t.shellPid!==e.shellPid)continue;
        const tk=key+'\u0000'+e.provider;if(!tools.has(tk)){if(!budget.take(2))continue;tools.set(tk,await this.tool(e.provider,machine));}const tool=tools.get(tk);
        let argv=null;try{if(tool.caps)argv=buildArguments(tool.caps,{resumeSessionId:e.sessionId});}catch{}
        const d=decide(e,{t:fresh.t,preference,tool:{argv,reason:tool.reason},now});
        const row={machine,address,tabId:e.tabId,provider:e.provider,line:d.line??null,reason:d.reason??null};
        if(d.type!=='type'){await this.journal.edit((draft,t)=>markOutcome(draft,{machine,address,state:d.type==='skip'?'skipped':'offered',reason:d.reason,line:d.line,passId,now:t})?{}:{write:false});summary[d.type==='skip'?'skipped':'offered'].push(row);continue;}
        if(sends>=RESTART.maxSends||budget.left<3)continue;sends++;
        const sent=await this.send(budget,{machine,address,e,line:d.line,passId,claim:claimKey(address,e),expect:['lost']});
        // A transient failure (host unreachable, another copy holds the claim) stays lost and is retried; only offers are reported.
        if(sent.ok)summary.resumed.push(row);else if(sent.offered)summary.failed.push({...row,reason:sent.reason??null});
      }
    }
    // One restart can take several budgeted passes; they are reported together once nothing is left lost.
    const episode=this.episode&&now-this.episode.at<RUNNER.episodeMs?this.episode:(this.episode={passId,at:now,resumed:[],offered:[],skipped:[],failed:[]});
    for(const k of ['resumed','offered','skipped','failed'])episode[k].push(...summary[k]);episode.passId=passId;
    const remaining=Object.values((await this.journal.read()).value?.machines||{}).some(m=>Object.values(m.terminals).some(e=>e.state==='lost'||e.state==='sending'));
    if((!remaining||now-episode.at>=RUNNER.episodeMs)&&(episode.resumed.length||episode.offered.length||episode.failed.length)){this.publish({...episode});this.episode=null;}
    return summary;
  }
  /** Claim on the host, CAS sending, fresh foreground check, hc send. Failures become offers. */
  async send(budget,{machine,address,e,line,passId,claim,expect}){
    const offer=async reason=>{await this.journal.edit((d,t)=>markOutcome(d,{machine,address,state:'offered',reason,line,passId,now:t})?{}:{write:false});return {ok:false,offered:true,reason};};
    const c=await hostClaim(this.io,{machine,key:claim,owner:this.owner});
    if(!c.ok)return {ok:false,reason:'The machine could not be reached to claim this resume.'};
    if(!c.claimed)return {ok:false,reason:'Another Mission Control is resuming this agent.'};
    const {result}=await this.journal.edit((d,t)=>{const ok=markSending(d,{machine,address,passId,claim,line,expect,now:t});return ok?{ok}:{write:false,ok};});
    if(!result.ok)return {ok:false,reason:'This agent was already handled.'};
    let raw=null;try{if(!budget||budget.take()){const r=await this.io.exec('hc',['get',address,'--json'],{on:machine});if(r?.code===0)raw=JSON.parse(r.stdout);}}catch{}
    if(!raw||raw.pid!==e.shellPid||raw.foreground?.pid!==raw.pid)return offer('The restored shell changed before the command could be typed.');
    let r;try{if(budget&&!budget.take())return offer('Typing was postponed.');r=await this.io.exec('hc',['send',address,line],{on:machine});}catch{return offer('The resume command could not be typed.');}
    if(r?.code!==0)return offer('Herdr refused to type the resume command.');
    await this.journal.edit((d,t)=>markOutcome(d,{machine,address,state:'sent',line,passId,now:t})?{}:{write:false});
    return {ok:true};
  }
  publish(summary){
    this.lastSummary=freeze(summary);
    let shared=null;try{shared=this.io.shared?.(RESTART_STATE_KEY);}catch{}
    if(shared?.toastedPassId===summary.passId)return;
    try{this.io.setShared?.(RESTART_STATE_KEY,{v:1,passId:summary.passId,toastedPassId:summary.passId,summary});}catch{}
    const names=new Map();for(const sp of this.io.spaces?.()||[])for(const t of sp.tabs||[])names.set(t.id,t.name||null);
    const tab=r=>names.get(r.tabId)||r.tabId,needs=[...summary.failed,...summary.offered],n=summary.resumed.length;
    const body=[n?`Resumed ${n} agent${n===1?'':'s'}: ${summary.resumed.slice(0,6).map(tab).join(', ')}${n>6?'…':''}.`:null,
      ...needs.slice(0,3).map(r=>`${tab(r)} needs you: ${r.line}${r.reason?' ('+r.reason+')':''}`),needs.length>3?`${needs.length-3} more in the Reopen bar.`:null].filter(Boolean).join('\n');
    try{this.io.notify?.({title:'Agents after restart',body,level:needs.length?'warning':'success'});}catch{}
  }
  /** Reads the journal for display without observing (popups and non-lease copies). */
  async refresh(){try{const {value,status}=await this.journal.read();this.value=status==='newer'?null:value;this.status=status==='newer'?'idle-newer':this.status;}catch{}return this.value;}
  /** Offers for display. */
  offers(){return offers(this.value);}
  /** Resume one offer the person clicked: fresh capabilities, its own claim, the same send protocol. */
  async resumeOffer({machine=null,address}){
    try{
      const {value,status}=await this.journal.read();if(status==='newer')return {ok:false,reason:'Resume after restart is idle: a newer Mission Control owns its journal.'};
      const key=machineKey(machine),e=value.machines[key]?.terminals[address];if(!e||e.state!=='offered')return {ok:false,reason:'This offer is gone.'};
      const tool=await this.tool(e.provider,machine,{fresh:true});let argv=null;try{if(tool.caps)argv=buildArguments(tool.caps,{resumeSessionId:e.sessionId});}catch{}
      if(!argv)return {ok:false,reason:tool.reason||'Exact resume is not verified on this machine.',line:e.line};
      let raw=null;try{const r=await this.io.exec('hc',['get',address,'--json'],{on:machine});if(r?.code===0)raw=JSON.parse(r.stdout);}catch{}
      if(!raw||raw.pid!==e.shellPid||raw.foreground?.pid!==raw.pid)return {ok:false,reason:'That shell is busy or gone; run the command yourself.',line:e.line};
      const cwd=raw.foreground?.cwd??raw.cwd,line=(cwd===e.cwd?'':cdPrefix(e.cwd))+resumeLine(argv);
      const result=await this.send(null,{machine,address,e,line,passId:this.owner+'-offer',claim:claimKey(address,e,{offer:value.revision}),expect:['offered']});
      this.value=(await this.journal.read()).value;return result.ok?{ok:true}:{ok:false,reason:result.reason,line};
    }catch{return {ok:false,reason:'The offer could not be resumed.'};}
  }
  async dismissOffer({machine=null,address}){try{await this.journal.edit(d=>dismiss(d,{machine,address}));this.value=(await this.journal.read()).value;return {ok:true};}catch{return {ok:false};}}
  async resumeAll(){const results=[];for(const o of this.offers())results.push(await this.resumeOffer(o));return results;}
  /** Codex hook state per machine where Codex is installed. */
  async refreshCodex(){
    this.codexAt=this.clock();
    for(const machine of this.machines()){
      let tools=[];try{tools=installedTools(await this.io.knownAgents({on:machine}));}catch{continue;}
      if(!tools.some(t=>t.key==='codex')){this.codex.delete(machineKey(machine));continue;}
      this.codex.set(machineKey(machine),await codexHook(this.io,'status',{machine}));
    }
  }
  codexSetup(){return [...this.codex].map(([key,s])=>freeze({machine:machineOf(key),installed:s.ok&&s.installed===true,ok:s.ok,message:s.ok?null:s.message}));}
  async installCodex(machine=null){const r=await codexHook(this.io,'install',{machine});if(r.ok)this.codex.set(machineKey(machine),{...r,installed:true});return r;}
  async removeCodex(machine=null){const r=await codexHook(this.io,'remove',{machine});if(r.ok)this.codex.set(machineKey(machine),{...r,installed:false});return r;}
  snapshot(){return freeze({status:this.status,error:this.error,offers:this.offers(),codex:this.codexSetup(),summary:this.lastSummary});}
  async release(){this.closed=true;try{await this.journal.edit(d=>releaseLease(d,this.owner));}catch{}}
}
