import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {normalizeQuota,selectQuota,quotaKey} from '../src/shared/quota.js';
const now=1800000000000,identity={machine:null,provider:'claude',credentialScope:'profile',providerRoot:'/profiles/.claude',sessionId:'session-a'};
const observation=({session=identity,account='a'.repeat(64),pool=null,kind='session-account-digest',percent=65,at=now-10000,name='five_hour',format='legacy-claude-statusline',reset=now+100000}={})=>({state:'available',identity:{...session},provenance:{provider:session.provider,format,formatVersion:null,sourceDigest:'b'.repeat(64),observedAt:null},context:null,quota:{proof:{kind,machine:session.machine,credentialScope:session.credentialScope,accountId:account,poolId:pool},windows:[{name,remainingPercent:percent,observedAt:at,resetsAt:reset}]}});
test('fresh exact account digests share newest windows and keep sessions distinct',()=>{
  const a=observation(),b=observation({session:{...identity,sessionId:'session-b'},percent:30,at:now-1000});
  const q=selectQuota([a,b],identity,{now});assert.equal(q.scope,'shared-account');assert.equal(q.windows[0].remainingPercent,30);assert.equal(q.identity.accountId,'a'.repeat(64));assert.equal(q.identity.session,undefined);
  assert.equal(quotaKey(normalizeQuota(a,identity,{now}).identity),quotaKey(normalizeQuota(b,b.identity,{now}).identity));
});
test('account, pool, profile and host mismatches cannot borrow another allowance',()=>{
  const own=observation();
  for(const other of [observation({account:'c'.repeat(64),percent:5}),observation({pool:'different',percent:5}),observation({session:{...identity,machine:'server'},percent:5}),observation({session:{...identity,credentialScope:'other'},percent:5})])assert.equal(selectQuota([own,other],identity,{now}).windows[0].remainingPercent,65);
  assert.equal(selectQuota([observation({session:{...identity,sessionId:'other'}})],identity,{now}).state,'unavailable');
  const stale=observation({at:now-300001});assert.equal(selectQuota([stale,observation({session:{...identity,sessionId:'other'},percent:30})],identity,{now}).state,'stale');
});
test('session-local reports and unknown pool identity never become account-wide quota',()=>{
  const codex={...identity,provider:'codex',providerRoot:'/profiles/.codex'};
  const local=observation({session:codex,format:'codex-rollout-jsonl',kind:'session-report',account:null,pool:'reported-pool'});
  const q=normalizeQuota(local,codex,{now});assert.equal(q.scope,'session-observation');assert.equal(q.identity.session.sessionId,'session-a');
  const unknownPool=observation({session:codex,format:'codex-rollout-jsonl',kind:'provider-account'});assert.equal(normalizeQuota(unknownPool,codex,{now}).scope,'session-observation');
  const verified=observation({session:codex,format:'codex-rollout-jsonl',kind:'provider-account',pool:'subscription-pool'});assert.equal(normalizeQuota(verified,codex,{now}).scope,'shared-account');
});
test('window age, reset, missing timestamps and malformed whole observations stay explicit',()=>{
  assert.equal(normalizeQuota(observation({at:now-300001}),identity,{now}).state,'stale');assert.equal(normalizeQuota(observation({at:null}),identity,{now}).state,'stale');assert.equal(normalizeQuota(observation({reset:now-1}),identity,{now}).state,'stale');assert.equal(normalizeQuota(observation({at:now+5001}),identity,{now}).state,'unavailable');
  const bad=observation();bad.context={usedTokens:1};assert.equal(normalizeQuota(bad,identity,{now}).state,'unavailable');
  for(const value of [observation({format:'unknown-cache'}),observation({percent:101}),observation({kind:'none'})])assert.equal(normalizeQuota(value,identity,{now}).state,'unavailable');
  const duplicate=observation();duplicate.quota.windows.push({...duplicate.quota.windows[0],remainingPercent:20});assert.equal(normalizeQuota(duplicate,identity,{now}).state,'unavailable');
});
test('shared windows merge independently by their own observation dates',()=>{
  const a=observation(),b=observation({session:{...identity,sessionId:'session-b'},percent:10,at:now-1000});
  a.quota.windows.push({name:'weekly',remainingPercent:50,observedAt:now-5000,resetsAt:null});b.quota.windows.push({name:'weekly',remainingPercent:90,observedAt:now-20000,resetsAt:null});
  const result=selectQuota([a,b],identity,{now});assert.deepEqual(result.windows.map(w=>[w.name,w.remainingPercent]),[['five_hour',10],['weekly',50]]);
});
test('actual bounded Python cache adapter rejects global/legacy scope fallback before quota joining',async t=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'mc-quota-cache-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));const providerRoot=root+'/.claude',sessions=providerRoot+'/projects',cache=providerRoot+'/explicit-cache';await fs.mkdir(sessions,{recursive:true});await fs.mkdir(cache);
  const source={v:1,enabled:true,machine:null,provider:'claude',credentialScope:'fixture',providerRoot,roots:[sessions],cacheRoots:[cache]},a={machine:null,provider:'claude',credentialScope:'fixture',providerRoot,sessionId:'a'},b={...a,sessionId:'b'};
  const raw={provider:'claude',source:'claude-statusline',fetched_at_unix:now/1000,session_quota_only:true,session_accounts:{a:'a'.repeat(64),b:'b'.repeat(64)},session_windows:{a:[{kind:'five_hour',used_percent:35,remaining_percent:65,resets_at:null}],b:[{kind:'five_hour',used_percent:90,remaining_percent:10,resets_at:null}]},session_quota_observations:{a:[{kind:'five_hour',observed_at_unix:now/1000-10}],b:[{kind:'five_hour',observed_at_unix:now/1000-1}]},quota_scope_windows:{old:[{kind:'weekly',remaining_percent:100}]}};
  const code=(await fs.readFile('src/shared/collector.py','utf8'))+'\n'+(await fs.readFile('src/shared/provider_claude.py','utf8'))+'\ncollector_main({"claude":collect_claude})\n';
  const collect=async()=>{await fs.writeFile(cache+'/claude-statusline.json',JSON.stringify(raw));const p=spawnSync('python3',['-c',code,JSON.stringify({v:1,operation:'observe',source,identities:[a,b]})],{encoding:'utf8'});assert.equal(p.status,0,p.stderr);return JSON.parse(p.stdout).data;};
  let rows=await collect();assert.equal(selectQuota(rows,a,{now}).windows[0].remainingPercent,65);
  raw.session_accounts.b=raw.session_accounts.a;rows=await collect();assert.equal(selectQuota(rows,a,{now}).windows[0].remainingPercent,10);
  raw.session_accounts={};rows=await collect();assert.equal(selectQuota(rows,a,{now}).scope,'session-observation');assert.equal(selectQuota(rows,a,{now}).windows[0].remainingPercent,65);
  raw.session_quota_only=false;rows=await collect();assert.equal(selectQuota(rows,a,{now}).state,'unavailable');
  raw.source='wrong-source';rows=await collect();assert.equal(rows[0].state,'unavailable');assert.equal(normalizeQuota(rows[0],a,{now}).state,'unavailable');
});
