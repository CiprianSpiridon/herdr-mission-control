import test from 'node:test';
import assert from 'node:assert/strict';
import {newConfig} from '../src/shared/config.js';
import {defaultUsageSources,ensureUsageDefaults,UsageSourceRegistry,usageSourceKey,usageSourceFingerprint,validateUsageSource} from '../src/shared/usage-sources.js';

const source=(extra={})=>({v:1,enabled:true,machine:null,provider:'claude',providerRoot:'/profiles/.claude',credentialScope:'profile',roots:['/profiles/.claude/projects'],...extra});
function fixture(values={local:source(),server:source({machine:'server'})}){
  let raw=JSON.stringify({...newConfig(),usageSources:values}),writeFailure=null,writeGate=null;const effects=[],clears=[],invalidations=[];
  const io={appHome:'/qa',ensureDirectory:async path=>effects.push(['mkdir',path]),readTextFile:async()=>raw,writeTextFile:async(path,text,expected)=>{if(writeGate)await writeGate;if(writeFailure)throw writeFailure;if(raw!==expected)throw Object.assign(Error('stale'),{code:'STALE'});raw=text;effects.push(['write',path]);}};
  const registry=()=>new UsageSourceRegistry(io,{clearCache:(id,value)=>clears.push({id,value}),invalidateBindings:async enabled=>invalidations.push(structuredClone(enabled))});
  return {io,registry,effects,clears,invalidations,raw:()=>raw,setRaw:value=>raw=value,config:()=>JSON.parse(raw),failWrite:error=>writeFailure=error,gateWrite:promise=>writeGate=promise};
}

test('defaults contain only installed known provider session roots on the specified host',()=>{
  const values=Object.values(defaultUsageSources({machine:'server',home:'/remote/home',installed:[{key:'claude',installed:true},{key:'codex',installed:true},{key:'grok',installed:false},{key:'other',installed:true}]}));assert.equal(values.length,2);
  assert.ok(values.every(v=>v.enabled&&v.machine==='server'&&v.providerRoot.startsWith('/remote/home/.')&&!v.cacheRoots));assert.deepEqual(values.find(v=>v.provider==='codex').roots,['/remote/home/.codex/sessions','/remote/home/.codex/archived_sessions']);
  assert.throws(()=>defaultUsageSources({installed:[{key:'claude',installed:true}]}),/canonical/);
});
test('default persistence preserves disabled/custom profiles instead of resetting user choices',async()=>{
  const f=fixture({existing:source({enabled:false,providerRoot:'/custom/.claude',roots:['/custom/.claude/projects']})});
  await ensureUsageDefaults(f.io,{home:'/local/home',installed:[{key:'claude',installed:true},{key:'codex',installed:true}]});const saved=f.config();assert.equal(saved.usageSources.existing.enabled,false);assert.equal(Object.values(saved.usageSources).filter(v=>v.provider==='claude').length,1);assert.equal(Object.values(saved.usageSources).find(v=>v.provider==='codex').providerRoot,'/local/home/.codex');
  const writes=f.effects.length;await ensureUsageDefaults(f.io,{home:'/local/home',installed:[{key:'claude',installed:true},{key:'codex',installed:true}]});assert.equal(f.effects.length,writes);
});
test('root validation rejects traversal, credentials, broad directories and overlapping caches',()=>{
  for(const root of ['/','/Users','/Users/another','/profiles','/profiles/.claude','/profiles/../elsewhere','/profiles/.ssh','/profiles/auth.json','/profiles/Library'])assert.throws(()=>validateUsageSource(source({roots:[root]})),/root|directory|profile|metadata|scanned/i);
  assert.throws(()=>validateUsageSource(source({cacheRoots:['/profiles/.claude/projects']})),/separate/);
  assert.throws(()=>validateUsageSource(source({enabled:'true'})),/versioned/);
  assert.equal(validateUsageSource(source({roots:['/dedicated/session-archive'],cacheRoots:['/dedicated/sanitized-cache']})).cacheRoots[0],'/dedicated/sanitized-cache');
});
test('disable cancels in-flight publication, removes future reads and preserves other hosts',async()=>{
  const f=fixture(),first=f.registry(),otherCopy=f.registry();await first.refresh();await otherCopy.refresh();const ticket=first.begin('local'),otherTicket=otherCopy.begin('local'),server=first.begin('server');assert.ok(ticket&&otherTicket&&server);
  let release;f.gateWrite(new Promise(resolve=>release=resolve));const save=first.save('local',source({enabled:false}));assert.equal(first.current(ticket),false);assert.equal(first.begin('local'),null);assert.ok(first.current(server));
  release();await save;let published=false;assert.equal(await otherCopy.accept(otherTicket,{},()=>published=true),false);assert.equal(published,false);assert.equal(first.begin('local'),null);assert.ok(f.clears.some(c=>c.id==='local'));assert.deepEqual(f.invalidations.at(-1).map(v=>v.machine),['server']);assert.equal(f.config().usageSources.server.enabled,true);
});
test('same-profile root changes clear exact bindings once before fresh scans can publish',async()=>{
  const f=fixture(),registry=f.registry();await registry.refresh();const ticket=registry.begin('local');await registry.save('local',source({roots:['/profiles/.claude/projects-new']}));assert.equal(registry.current(ticket),false);assert.ok(f.invalidations.at(-1).every(v=>usageSourceKey(v)!==usageSourceKey(source())));
  const next=registry.begin('local');assert.equal(next.source.roots[0],'/profiles/.claude/projects-new');let result=null;assert.equal(await registry.accept(next,{count:1},value=>result=value),true);assert.deepEqual(result,{count:1});
  const before=f.invalidations.length;await registry.refresh();await registry.refresh();assert.equal(f.invalidations.length,before,'unchanged refreshes must not rewrite durable bindings');
});
test('failed CAS save preserves config and cancels old work without deleting valid bindings',async()=>{
  const f=fixture(),registry=f.registry();await registry.refresh();const raw=f.raw(),ticket=registry.begin('local'),invalidations=f.invalidations.length;f.failWrite(Object.assign(Error('disk denied'),{code:'EACCES'}));await assert.rejects(registry.save('local',source({enabled:false})),/disk denied/);assert.equal(f.raw(),raw);assert.equal(registry.current(ticket),false);assert.equal(f.invalidations.length,invalidations);assert.ok(registry.begin('local'),'persisted original source remains available for a fresh scan');
});
test('invalid durable sources clear caches/bindings and never publish retained observations',async()=>{
  const f=fixture(),registry=f.registry();await registry.refresh();const ticket=registry.begin('local');f.setRaw('{"private":"MALFORMED_PRIVATE_VALUE",');await assert.rejects(registry.accept(ticket,{},()=>assert.fail('must not publish')),error=>!/MALFORMED_PRIVATE_VALUE/.test(error.message));assert.deepEqual(f.invalidations.at(-1),[]);assert.equal(registry.begin('local'),null);assert.match(f.raw(),/MALFORMED_PRIVATE_VALUE/);
  registry.close();assert.equal(registry.begin('server'),null);
});
test('duplicate source identities and asynchronous publishers cannot weaken lifecycle guards',async()=>{
  const f=fixture({a:source(),b:source()}),registry=f.registry();await assert.rejects(registry.refresh(),/Duplicate/);
  const g=fixture(),valid=g.registry();await valid.refresh();const ticket=valid.begin('local');await assert.rejects(valid.accept(ticket,{},async()=>{}),/synchronous/);assert.equal(valid.current(ticket),false);
  assert.throws(()=>new UsageSourceRegistry(g.io,{}),/capabilities/);
});
test('an outdated source form cannot overwrite a newer root/profile edit',async()=>{
  const f=fixture(),a=f.registry(),b=f.registry();await a.refresh();await b.refresh();const expected=usageSourceFingerprint(source());await b.save('local',source({roots:['/profiles/.claude/new-projects']}));const raw=f.raw();await assert.rejects(a.save('local',source({enabled:false}),{expectedFingerprint:expected}),e=>e.code==='SOURCE_CONFLICT');assert.equal(f.raw(),raw);
});
