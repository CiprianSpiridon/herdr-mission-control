import {canonicalRepoPath,readConfig,updateConfig} from './config.js';
import {machineIdentity} from './session-identity.js';

const providers=new Set(['codex','claude','grok']),copy=value=>JSON.parse(JSON.stringify(value));
const fail=message=>{throw Object.assign(Error(message),{code:'INVALID_USAGE_SOURCE'});};
const text=(value,max=200)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\u0000-\u001f]/.test(value);
const broad=new Set(['/','/Users','/home','/tmp','/private','/private/tmp','/var','/etc','/usr','/opt','/Volumes']);
const forbidden=path=>path.toLowerCase().split('/').some(p=>['.ssh','.aws','.azure','keychains','auth','credentials','secrets','auth.json','.credentials.json','credentials.json','settings.json','config.json','keys.json'].includes(p)||/\.(pem|key|p12)$/.test(p));
const canonical=value=>{try{if(!text(value,4096)||canonicalRepoPath(value)!==value||broad.has(value)||forbidden(value))fail('Usage roots must be dedicated canonical metadata directories, outside credential paths.');return value;}catch{fail('Usage roots must be dedicated canonical metadata directories, outside credential paths.');}};

export function validateUsageSource(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||value.v!==1||!providers.has(value.provider)||typeof value.enabled!=='boolean'||!text(value.credentialScope))fail('A versioned provider/profile source is required.');
  const machine=machineIdentity(value.machine),providerRoot=canonical(value.providerRoot);
  if(!Object.hasOwn(value,'machine'))fail('An explicit source machine is required.');
  if(!Array.isArray(value.roots)||!value.roots.length||value.roots.length>8||value.cacheRoots!==undefined&&(!Array.isArray(value.cacheRoots)||value.cacheRoots.length>4))fail('Configure one to eight session roots and at most four explicit cache roots.');
  const check=path=>{canonical(path);if(path===providerRoot||providerRoot.startsWith(path+'/')||/^\/(Users|home)\/[^/]+$/.test(path)||['Library','Desktop','Documents','Downloads','Applications','.config','.cache'].includes(path.split('/').at(-1)))fail('A profile, home, broad personal directory or ancestor cannot be scanned.');return path;};
  const roots=[...new Set(value.roots.map(check))],cacheRoots=[...new Set((value.cacheRoots||[]).map(check))];
  if(roots.some(root=>cacheRoots.includes(root)))fail('Session and sanitized cache roots must be separate.');
  return {v:1,enabled:value.enabled,machine,provider:value.provider,providerRoot,credentialScope:value.credentialScope,roots,...(cacheRoots.length?{cacheRoots}:{})};
}
export const usageSourceKey=source=>{const s=validateUsageSource(source);return JSON.stringify([s.machine,s.provider,s.providerRoot,s.credentialScope]);};
export const usageSourceFingerprint=source=>JSON.stringify(validateUsageSource(source));

export function defaultUsageSources({machine=null,home,installed=[]}){
  const base=canonical(home),on=machineIdentity(machine),keys=new Set(installed.filter(t=>t.installed===true).map(t=>t.key)),result={};
  for(const provider of providers){
    if(!keys.has(provider))continue;
    const root=base+'/.'+provider,roots=provider==='claude'?[root+'/projects']:provider==='codex'?[root+'/sessions',root+'/archived_sessions']:[root+'/sessions'];
    const source=validateUsageSource({v:1,enabled:true,machine:on,provider,credentialScope:'standard',providerRoot:root,roots});result[usageSourceKey(source)]=source;
  }
  return result;
}

/** home is discovered on the destination host by the caller, never borrowed locally. */
export async function ensureUsageDefaults(io,options){
  const defaults=defaultUsageSources(options),existing=(await readConfig(io)).value;
  const absent=config=>Object.values(defaults).filter(s=>!Object.values(config.usageSources).some(v=>v?.provider===s.provider&&(v.machine??null)===s.machine));
  if(!absent(existing).length)return existing;
  return updateConfig(io,config=>{for(const source of absent(config))config.usageSources[usageSourceKey(source)]=source;});
}

/** Per-copy lifecycle; accept() rereads durable settings before publication. */
export class UsageSourceRegistry{
  constructor(io,{clearCache,invalidateBindings}){
    if(typeof clearCache!=='function'||typeof invalidateBindings!=='function')fail('Source lifecycle requires cache and durable-binding invalidation capabilities.');
    this.io=io;this.clearCache=clearCache;this.invalidateBindings=invalidateBindings;this.sources=new Map();this.generations=new Map();this.tickets=new Set();this.blocked=new Set();this.revision=-1;this.closed=false;
  }
  cancel(id,source){
    this.generations.set(id,(this.generations.get(id)||0)+1);
    for(const ticket of this.tickets)if(ticket.id===id)ticket.cancelled=true;
    const result=this.clearCache(id,source?copy(source):null);
    if(result?.then)fail('Cache invalidation must be synchronous.');
  }
  async refresh(){
    // Start the first read in its calling native task. Deferring it through
    // .then() can attach that effect to a concurrently starting GPUI task.
    const previous=this.queue;let release;
    const current=new Promise(resolve=>{release=resolve;});this.queue=current;
    try{if(previous)await previous;return await this.reconcile();}
    finally{release();if(this.queue===current)this.queue=null;}
  }
  async reconcile(){
    if(this.closed)return [];
    let config;
    try{config=(await readConfig(this.io)).value;const seen=new Set();for(const source of Object.values(config.usageSources)){const key=usageSourceKey(source);if(seen.has(key))fail('Duplicate provider/profile/root sources must be merged explicitly.');seen.add(key);}}
    catch(error){for(const[id,source]of this.sources)this.cancel(id,source);this.sources.clear();for(const ticket of this.tickets)ticket.cancelled=true;await this.invalidateBindings([]);throw error;}
    if(config.revision<this.revision)return this.enabled();
    const initial=this.revision<0,next=new Map(Object.entries(config.usageSources).map(([id,source])=>[id,validateUsageSource(source)])),changed=new Set();
    for(const[id,old]of this.sources)if(!next.has(id)||usageSourceFingerprint(old)!==usageSourceFingerprint(next.get(id))){changed.add(usageSourceKey(old));this.cancel(id,old);}
    this.sources=next;this.revision=config.revision;
    // Excluding changed identities once also invalidates bindings when only
    // the roots changed, even though provider/profile identity stayed equal.
    if(initial||changed.size)await this.invalidateBindings([...next.values()].filter(s=>s.enabled&&!changed.has(usageSourceKey(s))));
    return this.enabled();
  }
  enabled(){return [...this.sources].filter(([id,source])=>source.enabled&&!this.blocked.has(id)).map(([id,source])=>({...copy(source),id}));}
  begin(id){
    const source=this.sources.get(id);if(this.closed||!source?.enabled||this.blocked.has(id))return null;
    const ticket={id,generation:this.generations.get(id)||0,fingerprint:usageSourceFingerprint(source),source:copy(source),cancelled:false};this.tickets.add(ticket);return ticket;
  }
  current(ticket){const source=this.sources.get(ticket?.id);return !this.closed&&this.tickets.has(ticket)&&!ticket.cancelled&&!this.blocked.has(ticket.id)&&source?.enabled&&(this.generations.get(ticket.id)||0)===ticket.generation&&usageSourceFingerprint(source)===ticket.fingerprint;}
  release(ticket){this.tickets.delete(ticket);}
  async accept(ticket,value,publish){
    try{await this.refresh();if(!this.current(ticket))return false;const result=publish(value,copy(ticket.source));if(result?.then)fail('Usage publication must be synchronous.');return true;}finally{this.release(ticket);}
  }
  async save(id,value,{expectedFingerprint}={}){
    if(!text(id,8192)||['__proto__','prototype','constructor'].includes(id))fail('Invalid usage source key.');
    const next=validateUsageSource(value),old=this.sources.get(id);this.blocked.add(id);this.cancel(id,old||next);
    try{await updateConfig(this.io,config=>{const current=config.usageSources[id];if(expectedFingerprint!==undefined&&(current?usageSourceFingerprint(current):null)!==expectedFingerprint)throw Object.assign(Error('This usage source changed; reload it before saving.'),{code:'SOURCE_CONFLICT'});config.usageSources[id]=next;});await this.refresh();return copy(next);}
    finally{this.blocked.delete(id);}
  }
  close(){this.closed=true;for(const[id,source]of this.sources)this.cancel(id,source);this.tickets.clear();this.sources.clear();}
}
