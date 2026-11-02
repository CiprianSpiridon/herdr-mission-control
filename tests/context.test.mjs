import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeContext,selectContext} from '../src/shared/context.js';
const now=1800000000000,identity={machine:null,provider:'codex',credentialScope:'profile',providerRoot:'/profiles/.codex',sessionId:'thread-a'};
const observation=(context,extra={})=>({state:'available',identity:{...identity},provenance:{provider:'codex',format:'codex-rollout-jsonl',formatVersion:null,sourceDigest:'a'.repeat(64),observedAt:now-1000},context,quota:null,...extra});
const counts=(used,window,limit=null)=>({usedTokens:used,windowTokens:window,compactionLimitTokens:limit,reportedUsedPercent:null});
test('reported compaction boundary differs from a context-window estimate',()=>{
  const before=normalizeContext(observation(counts(40,100,80)),identity,{now});assert.equal(before.state,'available');assert.equal(before.remainingPercent,50);assert.equal(before.basis,'reported');
  const estimate=normalizeContext(observation(counts(40,100)),identity,{now});assert.equal(estimate.remainingPercent,60);assert.equal(estimate.basis,'estimate');assert.match(estimate.reason,/threshold/);
  assert.equal(normalizeContext(observation(counts(110,100,80)),identity,{now}).remainingPercent,0);
  assert.equal(normalizeContext(observation(counts(0,100)),identity,{now}).remainingPercent,100);
});
test('exact host/profile/root/session identity prevents borrowing context',()=>{
  const value=observation(counts(40,100));
  for(const changed of [{machine:'server'},{credentialScope:'other'},{providerRoot:'/another/.codex'},{sessionId:'thread-b'}])assert.equal(normalizeContext(value,{...identity,...changed},{now}).state,'unavailable');
  const other=observation(counts(90,100),{identity:{...identity,sessionId:'thread-b'}});
  assert.equal(selectContext([other,value],identity,{now}).remainingPercent,60);
  assert.equal(selectContext([value,other],other.identity,{now}).remainingPercent,10);
});
test('missing/contradictory capacities or malformed whole envelopes remain unavailable',()=>{
  for(const context of [counts(40,null),counts(40,0),counts(40,100,110),{...counts(40,100),reportedUsedPercent:90}])assert.equal(normalizeContext(observation(context),identity,{now}).state,'unavailable');
  const percent=normalizeContext(observation({usedTokens:null,windowTokens:null,compactionLimitTokens:null,reportedUsedPercent:25}),identity,{now});assert.equal(percent.remainingPercent,75);assert.equal(percent.basis,'estimate');
  for(const malformed of [{...observation(counts(40,100)),quota:{proof:{}}},{...observation(counts(40,100)),transcript:'PRIVATE'},{...observation(counts(-1,100))}])assert.equal(normalizeContext(malformed,identity,{now}).state,'unavailable');
});
test('source timestamps govern stale/unknown/future context independently of collection time',()=>{
  const value=observation(counts(40,100));value.provenance.observedAt=now-120001;assert.equal(normalizeContext(value,identity,{now}).state,'stale');
  value.provenance.observedAt=null;assert.equal(normalizeContext(value,identity,{now}).state,'unavailable');
  value.provenance.observedAt=now+5001;assert.equal(normalizeContext(value,identity,{now}).state,'unavailable');
  value.provenance.observedAt=now-120000;assert.equal(normalizeContext(value,identity,{now}).state,'available');
});
test('newest valid exact reading wins and an unavailable session never gets a default allowance',()=>{
  const old=observation(counts(20,100));old.provenance.observedAt=now-20000;const latest=observation(counts(80,100));assert.equal(selectContext([old,latest],identity,{now}).remainingPercent,20);
  const missing=normalizeContext(null,identity,{now});assert.equal(missing.remainingPercent,null);assert.equal(missing.basis,'unavailable');
  const unknown=observation(null);assert.equal(normalizeContext(unknown,identity,{now}).state,'unavailable');
  const other=observation(counts(20,100),{identity:{...identity,sessionId:'other'}});assert.match(selectContext([other],identity,{now}).reason,/No exact session/);
});
