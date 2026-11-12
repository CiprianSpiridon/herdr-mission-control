import * as herdr from 'herdr';
import {createConfigIO} from './config.js';
import {BindingStore} from './session-bindings.js';
import {machineIdentity,localTerminalAddress,sessionKey,terminalIdentity,terminalKey} from './session-identity.js';
import {UsageSourceRegistry,ensureUsageDefaults,usageSourceKey} from './usage-sources.js';
import {validateProviderObservation} from './provider-observation.js';
import {CONTEXT_STALE_MS,normalizeContext,selectContext} from './context.js';
import {QUOTA_STALE_MS,quotaKey,normalizeQuota,selectQuota} from './quota.js';
import {hostFacts} from './restart-host.js';
import {CODEX_LABEL,parseCodexLabel} from './codex-session-hook.js';
import {agentProcess,argvSession,providerOf} from './restart-resume.js';
/** Beyond every helper deadline: a refresh still pending this long was abandoned by the host. */
export const REFRESH_STALE_MS=90000;

const bytes=value=>{let size=0;for(const character of value){const n=character.codePointAt(0);size+=n<128?1:n<2048?2:n<65536?3:4;}return size;};
const fail=(code,message)=>{throw Object.assign(Error(message),{code});};
/** Herdr reports Claude Code's foreground command as `claude` (or a path to it, or its npm package). */
const claudeForeground=raw=>{const argv=Array.isArray(raw?.foreground?.argv)?raw.foreground.argv.slice(0,4):[];return argv.some(a=>typeof a==='string'&&(/(^|\/)claude$/.test(a)||a.includes('/@anthropic-ai/claude-code/')));};
const sameScope=(scope,source)=>scope&&['machine','provider','providerRoot','credentialScope'].every(k=>scope[k]===source[k]);

export class TelemetryBridge{
  constructor(mod,api=herdr,{clock=()=>Date.now()}={}){
    if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(mod))fail('INVALID_MOD','A safe owning mod name is required.');
    this.mod=mod;this.io=createConfigIO(api);this.clock=clock;this.bindings=new BindingStore(this.io,{clock});this.observations=new Map();this.measurements=new Map();this.agentStates=new Map();this.lastScan=new Map();this.sourceErrors=new Map();this.hostQueues=new Map();this.activeHosts=0;this.hostWaiters=[];this.closed=false;
    this.sources=new UsageSourceRegistry(this.io,{clearCache:id=>{this.observations.delete(id);this.lastScan.delete(id);for(const state of this.agentStates.values())if(state.sourceId===id){this.measurements.delete(state.terminal?.address);state.session=null;state.reason='Usage source changed or was disabled.';}},invalidateBindings:enabled=>this.bindings.invalidateSources(enabled)});
  }
  async slot(){if(this.activeHosts>=4){await new Promise(resolve=>this.hostWaiters.push(resolve));return;}this.activeHosts++;}
  unslot(){const next=this.hostWaiters.shift();if(next)next();else this.activeHosts--;}
  async onHost(machine,work){
    const key=JSON.stringify(machineIdentity(machine)),previous=this.hostQueues.get(key);let release,acquired=false;
    const current=new Promise(resolve=>{release=resolve;});this.hostQueues.set(key,current);
    try{
      if(previous)await previous;
      // Keep the first native effect in its calling task, as source refresh
      // does. Only a genuinely occupied host/slot needs an async barrier.
      if(this.activeHosts>=4)await this.slot();else this.activeHosts++;acquired=true;
      if(this.closed)fail('CLOSED','Telemetry view was closed.');return await work();
    }finally{if(acquired)this.unslot();release();if(this.hostQueues.get(key)===current)this.hostQueues.delete(key);}
  }
  async initializeSources(){
    const machines=this.io.machines?.()||[{name:null,layout:'ready'}];
    await Promise.all(machines.filter(m=>m.layout==='ready').map(async m=>{
      try{
        // Tool discovery is advisory and can outlive a metadata refresh. It
        // must not hold the per-host collector queue while Herdr probes it.
        const installed=await this.io.knownAgents({on:m.name});if(this.closed)return;
        await this.onHost(m.name,async()=>{
          let home;if(m.name===null)home=this.io.home();else{const result=await this.io.exec('python3',['-c','import os,json; print(json.dumps({"home":os.path.realpath(os.path.expanduser("~"))}))'],{on:m.name});if(result.code!==0)fail('HOST_UNSUPPORTED','Python metadata helpers are unavailable on this machine.');try{home=JSON.parse(result.stdout).home;}catch{fail('INVALID_HOME','The machine did not report its metadata home.');}}
          if(this.closed)return;await ensureUsageDefaults(this.io,{machine:m.name,home,installed});
        });
      }catch{if(!this.closed)this.sourceErrors.set(JSON.stringify(m.name),'Provider metadata defaults are unavailable on this host.');}
    }));
    return this.sources.refresh();
  }
  async collector(){
    if(this.code)return this.code;
    const code=await this.io.readTextFile(this.io.appHome()+'/mods/'+this.mod+'/collector.py');
    if(typeof code!=='string'||!code.length||bytes(code)>65536)fail('COLLECTOR_UNAVAILABLE','This mod has no valid self-contained bounded collector.');
    this.code=code;return code;
  }
  async request(source,{operation='observe',identities=[],cursor,roots,limit=50}={}){
    const request={v:1,operation,source,...(identities.length?{identities}:{}),...(cursor?{cursor}:{}),...(roots?{roots}:{}),limit};
    const serialized=JSON.stringify(request);if(bytes(serialized)>65536)fail('REQUEST_TOO_LARGE','The metadata request exceeds its bounded size.');
    const code=await this.collector();if(this.closed)fail('CLOSED','Telemetry view was closed.');
    const result=await this.io.exec('python3',['-c',code,serialized],{on:source.machine});
    if(result.code!==0)fail('HOST_UNAVAILABLE','The destination machine could not run its read-only Python collector.');
    if(typeof result.stdout!=='string'||bytes(result.stdout)>524288)fail('RESPONSE_TOO_LARGE','The metadata response exceeds its bounded size.');
    let response;try{response=JSON.parse(result.stdout);}catch{fail('INVALID_RESPONSE','The metadata response is not valid JSON.');}
    if(response?.v!==1||!sameScope(response.scope,source))fail('SCOPE_MISMATCH','The metadata response belongs to a different host/provider/profile.');
    if(response.state==='error')fail('SOURCE_UNAVAILABLE','The configured metadata source is unavailable or unsupported.');
    if(!Array.isArray(response.data)||response.data.length>limit||typeof response.truncated!=='boolean'||!(response.cursor===null||typeof response.cursor==='string'&&response.cursor.length<=512)||!Array.isArray(response.errors)||!response.scan||!Number.isInteger(response.scan.indexed)||response.scan.indexed<0||response.scan.indexed>1000||!Number.isFinite(response.scan.bytes)||response.scan.bytes<0||response.scan.bytes>4*1024*1024)fail('INVALID_RESPONSE','The metadata response violates the bounded collector protocol.');
    const requested=new Set(identities.map(sessionKey));
    for(const value of response.data){const checked=validateProviderObservation(value);if(!checked.ok||value.provenance.provider!==source.provider||value.identity&&(!sameScope(value.identity,source)||operation==='observe'&&!requested.has(sessionKey(value.identity))))fail('INVALID_OBSERVATION','The collector returned malformed or wrong-scope session metadata.');}
    return response;
  }
  batches(source,identities,roots){
    const batches=[];let current=[];
    for(const identity of identities){
      const next=[...current,identity],request={v:1,operation:'observe',source,identities:next,roots,limit:50};
      if(next.length>50||bytes(JSON.stringify(request))>64000){if(!current.length)fail('REQUEST_TOO_LARGE','The exact session scope cannot fit a bounded collector request.');batches.push(current);current=[identity];}else current=next;
    }
    if(current.length)batches.push(current);return batches;
  }
  async scanSource(source,identities,{force=false}={}){
    const previous=this.observations.get(source.id)||{live:[],cache:[]},times=this.lastScan.get(source.id)||{},sessions=JSON.stringify(identities.map(sessionKey).sort());
    for(const[kind,roots,interval]of [['live',source.roots,30000],['cache',source.cacheRoots||[],60000]]){
      if(!roots.length||!identities.length||!force&&times[kind+'Sessions']===sessions&&times[kind]!==undefined&&this.clock()-times[kind]<interval)continue;
      const ticket=this.sources.begin(source.id);if(!ticket)continue;
      const rows=[];let partial=false;
      try{
        for(const batch of this.batches(ticket.source,identities,roots)){
          let cursor;const expected=new Set(batch.map(sessionKey));
          for(let page=0;page<4;page++){
            await this.sources.refresh();
            if(!this.sources.current(ticket))return;
            const response=await this.request(ticket.source,{identities:batch,roots,cursor});rows.push(...response.data);cursor=response.cursor;partial=partial||response.truncated;
            if(!cursor||new Set(rows.filter(r=>r.identity&&expected.has(sessionKey(r.identity))).map(r=>sessionKey(r.identity))).size>=batch.length)break;
          }
        }
        await this.sources.accept(ticket,rows.slice(0,1000),value=>{previous[kind]=value;this.observations.set(source.id,previous);times[kind]=this.clock();times[kind+'Sessions']=sessions;this.lastScan.set(source.id,{...times,truncated:partial});});
      }catch(error){if(ticket.cancelled)return;throw error;}finally{this.sources.release(ticket);}
    }
  }
  /** Read-only: Claude Code's own records for these foreground PIDs, accepted only for the live process that wrote them. */
  async adopt(source,processes){
    const unique=new Map();for(const p of processes)if(!unique.has(p.pid))unique.set(p.pid,{pid:p.pid,notBefore:p.notBefore});
    const request={v:1,operation:'adopt',source,pids:[...unique.values()].slice(0,64)},asked=new Set(request.pids.map(p=>p.pid)),serialized=JSON.stringify(request);
    if(bytes(serialized)>65536)fail('REQUEST_TOO_LARGE','The adoption request exceeds its bounded size.');
    const code=await this.collector();if(this.closed)fail('CLOSED','Telemetry view was closed.');
    const result=await this.io.exec('python3',['-c',code,serialized],{on:source.machine});
    if(result.code!==0||typeof result.stdout!=='string'||bytes(result.stdout)>65536)fail('HOST_UNAVAILABLE','The destination machine could not run its read-only Python collector.');
    let response;try{response=JSON.parse(result.stdout);}catch{fail('INVALID_RESPONSE','The adoption response is not valid JSON.');}
    if(response?.v!==1||!sameScope(response.scope,source)||!Array.isArray(response.adopt))fail('SCOPE_MISMATCH','The adoption response belongs to a different host/provider/profile.');
    const found=new Map(),UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for(const row of response.adopt)if(row&&asked.has(row.pid)&&typeof row.sessionId==='string'&&UUID.test(row.sessionId))found.set(row.pid,row.sessionId);
    return found;
  }
  async full(address,machine){
    const local=localTerminalAddress(address,machine),result=await this.io.exec('hc',['get',local,'--json'],{on:machine});
    if(result.code!==0||typeof result.stdout!=='string'||bytes(result.stdout)>1048576)fail('TERMINAL_UNAVAILABLE','The exact terminal generation is unavailable on its machine.');
    let raw;try{raw=JSON.parse(result.stdout);}catch{fail('INVALID_TERMINAL','The exact terminal generation response is invalid.');}
    if(localTerminalAddress(raw.address,machine)!==local)fail('INVALID_TERMINAL','The terminal response has a different address.');
    return {raw,terminal:terminalIdentity(raw,machine)};
  }
  async hostRefresh(machine,agents,{force}){
    try{
      const listing=await this.io.exec('hc',['ls','--json'],{on:machine});let live;
      try{live=listing.code===0?JSON.parse(listing.stdout).terminals:null;}catch{}
      if(!Array.isArray(live))fail('HOST_UNAVAILABLE','The destination machine is offline or unavailable.');
      // hc keeps finished terminals listed until removal; only live ones still hold their binding.
      // hc 0.1.16 also lists a connected machine's terminals under qualified addresses; they are not this host's.
      const addresses=new Set();for(const raw of live)if(raw.state===undefined||raw.state==='live')try{addresses.add(localTerminalAddress(raw.address,machine));}catch{}
      const snapshot=(await this.bindings.read()).value,fullCache=new Map();
      // A kept agent can become a shell and disappear from agents(). Its old
      // mapping still needs invalidation even though no agent row remains.
      for(const[id,record]of Object.entries(snapshot.proposals))if(record.state==='committed'&&record.ack.terminal.machine===machine){
        if(this.closed)return;
        if(!addresses.has(localTerminalAddress(record.ack.terminal.address,machine)))await this.bindings.invalidate(id,'Terminal is no longer live on its machine');
        else{let actual;try{actual=await this.full(record.ack.terminal.address,machine);}catch{await this.bindings.invalidate(id,'Terminal is no longer live on its machine');continue;}fullCache.set(actual.terminal.address,actual);if(terminalKey(actual.terminal)!==terminalKey(record.ack.terminal))await this.bindings.invalidate(id,'Terminal generation or foreground PID changed');}
      }
      const groups=new Map(),sources=this.sources.enabled().filter(s=>s.machine===machine);
      for(const agent of agents){
        if(this.closed)return;
        // One agent whose terminal just ended must not mark every other agent on this host unavailable.
        let actual;try{const qualified=machine?machine+'/'+localTerminalAddress(agent.address,machine):localTerminalAddress(agent.address,machine);actual=fullCache.get(qualified)||await this.full(agent.address,machine);}
        catch{this.agentStates.set(agent.address,{session:null,reason:'This agent\u2019s terminal is no longer available.'});continue;}
        const bound=await this.bindings.readCommitted(actual.terminal);
        if(this.closed)return;
        const source=bound?sources.find(s=>usageSourceKey(s)===JSON.stringify([bound.session.machine,bound.session.provider,bound.session.providerRoot,bound.session.credentialScope])):null;
        const state={...actual,session:bound?.session||null,requestId:bound?.requestId||null,sourceId:source?.id||null,unbound:!bound,reason:!bound?'No committed exact provider session binding.':!source?'This session usage source is disabled or unavailable.':null};
        if(!source)state.session=null;
        this.agentStates.set(agent.address,state);
        // A restart has a different terminalKey even if its address is reused.
        for(const[id,record]of Object.entries(snapshot.proposals))if(record.state==='committed'&&record.ack.terminal.machine===machine&&record.ack.terminal.address===actual.terminal.address&&terminalKey(record.ack.terminal)!==terminalKey(actual.terminal))await this.bindings.invalidate(id,'Terminal generation or foreground PID changed');
      }
      // A process can change conversations without changing PID (/clear). Read its current evidence even when a launch binding exists.
      const candidates=agents.map(agent=>[agent,this.agentStates.get(agent.address)]).filter(([,state])=>Number.isSafeInteger(state?.terminal?.foregroundPid)&&Number.isSafeInteger(state.terminal?.createdMs));
      const adopt=async(state,source,sessionId)=>{
        const session={machine,provider:source.provider,credentialScope:source.credentialScope,providerRoot:source.providerRoot,sessionId};
        if(state.requestId&&state.session&&sessionKey(state.session)!==sessionKey(session)){await this.bindings.invalidate(state.requestId,'The running agent changed conversations');state.requestId=null;}
        state.session=session;state.sourceId=source.id;state.adopted=true;state.reason=null;
      };
      // Codex and Grok started with `codex resume <id>` / `grok --resume <id>`: the exact ID is in their own argv.
      for(const[,state]of candidates.filter(([,state])=>state.unbound)){
        const argv=state.raw.foreground?.argv;if(argv?.some(a=>a==='--last'||a==='--continue'))continue;
        const hit=argvSession(argv);if(!hit||!['codex','grok'].includes(hit.provider))continue;const matches=sources.filter(s=>s.provider===hit.provider);
        if(matches.length===1)await adopt(state,matches[0],hit.sessionId);else if(matches.length)state.reason=`Several ${hit.provider} profiles are enabled on this machine; no session is chosen.`;
      }
      // Use the same exact process evidence as restart recovery: a PID/start-bound Codex hook label or Grok's open session file.
      for(const provider of ['codex','grok']){
        const entries=candidates.filter(([agent,state])=>providerOf({programKey:agent.program?.key,app:agent.app,argv:state.raw.foreground?.argv,name:state.raw.foreground?.name})===provider);
        if(!entries.length)continue;const matches=sources.filter(s=>s.provider===provider);
        if(matches.length!==1){for(const[,state]of entries)if(!state.session)state.reason=matches.length?`Several ${provider} profiles are enabled on this machine; no session is chosen.`:`The ${provider} usage source is disabled or unavailable.`;continue;}
        const source=matches[0],inspect=provider==='codex'?entries.filter(([,state])=>parseCodexLabel(state.raw.labels?.[CODEX_LABEL])):entries;
        for(const[,state]of entries)if(!state.session&&!inspect.some(([,s])=>s===state))state.reason='Codex has not reported its exact conversation. Use Set up Codex resume in Sources and trust the hook in Codex.';
        if(!inspect.length)continue;
        const facts=await hostFacts(this.io,{machine,terminals:inspect.map(([,state])=>({address:localTerminalAddress(state.raw.address,machine),shellPid:state.raw.pid,foregroundPid:state.raw.foreground?.pid})),grokRoot:provider==='grok'?source.providerRoot:null});
        if(this.closed)return;
        for(const[,state]of inspect){
          const f=facts.ok?facts.terminals.get(localTerminalAddress(state.raw.address,machine)):null,picked=f?agentProcess(state.raw.foreground,f.children):null;
          const process=picked?(picked.pid===state.raw.foreground?.pid?f.foreground:f.children.find(c=>c.pid===picked.pid)):null;
          if(!process||!Number.isSafeInteger(process.startMs))continue;
          const label=provider==='codex'?parseCodexLabel(state.raw.labels?.[CODEX_LABEL]):null;
          const sessionId=provider==='codex'?(label?.pid===process.pid&&label.startMs===process.startMs?label.sessionId:null):f.sessions.get(process.pid)?.grok?.sessionId;
          if(sessionId)await adopt(state,source,sessionId);
        }
      }
      const claudeCandidates=candidates.filter(([,state])=>claudeForeground(state.raw));
      if(claudeCandidates.length){
        const hits=new Map();
        for(const source of sources.filter(s=>s.provider==='claude')){
          if(this.closed)return;let found;try{found=await this.adopt(source,claudeCandidates.map(([,state])=>({pid:state.terminal.foregroundPid,notBefore:state.terminal.createdMs})));}catch{continue;}
          for(const[pid,sessionId]of found){if(!hits.has(pid))hits.set(pid,[]);hits.get(pid).push({source,sessionId});}
        }
        for(const[,state]of claudeCandidates){
          const found=hits.get(state.terminal.foregroundPid)||[];if(found.length!==1){if(found.length)state.reason='Several Claude Code profiles claim this process; no session is chosen.';continue;}
          await adopt(state,found[0].source,found[0].sessionId);
        }
      }
      // Build the scan only after current-session discovery, so old launch bindings never contribute a previous conversation's readings.
      for(const[,state]of candidates){const source=sources.find(s=>s.id===state.sourceId);if(!state.session||!source)continue;if(!groups.has(source.id))groups.set(source.id,{source,identities:new Map()});groups.get(source.id).identities.set(sessionKey(state.session),state.session);}
      for(const group of groups.values())try{await this.scanSource(group.source,[...group.identities.values()],{force});}catch(error){for(const state of this.agentStates.values())if(state.sourceId===group.source.id){state.session=null;state.reason='This provider metadata source or Python helper is unavailable.';}}
      // Recheck the full raw generation and durable mapping after asynchronous IO.
      for(const agent of agents){if(this.closed)return;const state=this.agentStates.get(agent.address);if(!state?.session)continue;let actual;try{actual=await this.full(agent.address,machine);}catch{this.agentStates.set(agent.address,{session:null,reason:'This agent\u2019s terminal is no longer available.'});continue;}const bound=await this.bindings.readCommitted(actual.terminal);if(this.closed)return;if(terminalKey(actual.terminal)!==terminalKey(state.terminal)||!state.adopted&&(!bound||sessionKey(bound.session)!==sessionKey(state.session))){if(state.requestId)await this.bindings.invalidate(state.requestId,'Terminal identity changed during usage collection');state.session=null;state.reason='Terminal identity changed while collecting usage.';}}
    }catch(error){if(this.closed)return;const tag=[error?.code,error?.name].find(v=>typeof v==='string'&&/^[A-Za-z_]{2,40}$/.test(v)),code=tag?' ('+tag+')':'';for(const agent of agents)this.agentStates.set(agent.address,{session:null,reason:'Host, Python helper, source or exact terminal identity is unavailable'+code+'.'});}
  }
  refresh(agents=this.io.agents(),{force=false}={}){
    if(this.closed)return Promise.resolve(new Map());
    // A refresh the host abandoned leaves its promise pending for ever; past a stale age a new one replaces it.
    if(this.refreshing&&this.clock()-this.refreshingAt<REFRESH_STALE_MS)return this.refreshing;
    this.refreshingAt=this.clock();const work=(async()=>{
      await this.sources.refresh();const spaces=this.io.spaces(),groups=new Map(),seen=new Set();
      for(const source of this.sources.enabled())if(!groups.has(JSON.stringify(source.machine)))groups.set(JSON.stringify(source.machine),{machine:source.machine,agents:[]});
      for(const agent of agents){seen.add(agent.address);const space=spaces.find(s=>s.id===agent.space);if(!space){this.agentStates.set(agent.address,{session:null,reason:'The agent space/machine is unavailable.'});continue;}const machine=machineIdentity(space.machine),key=JSON.stringify(machine);if(!groups.has(key))groups.set(key,{machine,agents:[]});groups.get(key).agents.push({...agent});}
      for(const address of this.agentStates.keys())if(!seen.has(address))this.agentStates.delete(address);
      // Publish as each host finishes, so a slow or unreachable host never hides another host's readings.
      await Promise.all([...groups.values()].map(group=>this.onHost(group.machine,()=>this.hostRefresh(group.machine,group.agents,{force})).then(()=>{if(!this.closed)this.publishReadings(agents);})));return this.publishReadings(agents);
    })();this.refreshing=work;work.finally(()=>{if(this.refreshing===work)this.refreshing=null;}).catch(()=>{});return work;
  }
  publishReadings(agents){
    const now=this.clock(),options={now},bySession=new Map(),byAccount=new Map(),shared=new Map(),enabled=new Set(this.sources.enabled().map(s=>s.id));
    for(const value of this.observations.values())for(const row of [...value.live,...value.cache]){
      if(!row.identity||!validateProviderObservation(row).ok)continue;
      const key=sessionKey(row.identity);if(!bySession.has(key))bySession.set(key,[]);bySession.get(key).push(row);
      const quota=normalizeQuota(row,row.identity,options);
      if(quota.scope==='shared-account'&&quota.state!=='unavailable'){const key=quotaKey(quota.identity);if(!byAccount.has(key))byAccount.set(key,[]);byAccount.get(key).push(row);}
    }
    this.measurements.clear();
    for(const agent of agents){
      const state=this.agentStates.get(agent.address),identity=state?.session;if(!identity||!enabled.has(state.sourceId))continue;
      const rows=bySession.get(sessionKey(identity))||[],context=selectContext(rows,identity,options),own=selectQuota(rows,identity,options);let quota=own;
      if(own.scope==='shared-account'&&own.state==='available'){
        const key=quotaKey(own.identity);if(!shared.has(key))shared.set(key,selectQuota(byAccount.get(key)||rows,identity,options));quota=shared.get(key);
      }
      this.measurements.set(agent.address,{context,quota,proofObservedAt:own.observedAt});
    }
    return this.readings(agents);
  }
  reading(agent){
    const state=this.agentStates.get(agent.address),value=this.measurements.get(agent.address),now=this.clock();
    if(!state?.session||!value){const reason=state?.reason||'Exact session usage is not available yet.';return {context:{...normalizeContext(null,null),reason},quota:{...normalizeQuota(null,null),reason}};}
    // Rendering only reads prepared values. Revalidating every observation for
    // every row can exhaust GPUI's synchronous rendering budget at scale.
    let {context,quota}=value;
    if(context.state==='available'&&now-context.observedAt>CONTEXT_STALE_MS)context={...context,state:'stale',reason:'The exact context observation is older than two minutes.'};
    if(quota.state==='available'&&(now-quota.observedAt>QUOTA_STALE_MS||quota.windows.some(w=>w.resetsAt!==undefined&&w.resetsAt<=now)||quota.scope==='shared-account'&&(value.proofObservedAt===null||now-value.proofObservedAt>QUOTA_STALE_MS)))quota={...quota,state:'stale',reason:'The quota observation or exact session account proof needs refreshing.'};
    return {context,quota};
  }
  readings(agents){return new Map(agents.map(agent=>[agent.address,this.reading(agent)]));}
  async historyPage(sourceId,{cursor}={}){
    await this.sources.refresh();const ticket=this.sources.begin(sourceId);if(!ticket)fail('SOURCE_DISABLED','This history source is disabled.');
    try{return await this.onHost(ticket.source.machine,async()=>{await this.sources.refresh();if(!this.sources.current(ticket))fail('SOURCE_CHANGED','The history source changed before its scan.');const response=await this.request(ticket.source,{operation:'list',cursor,roots:ticket.source.roots});let accepted=false;await this.sources.accept(ticket,response,()=>{accepted=true;});if(!accepted)fail('SOURCE_CHANGED','The history source changed during its scan.');return response;});}finally{this.sources.release(ticket);}
  }
  close(){this.closed=true;this.sources.close();this.observations.clear();this.measurements.clear();this.agentStates.clear();}
}
