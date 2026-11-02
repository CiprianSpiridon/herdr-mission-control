import test from 'node:test';
import assert from 'node:assert/strict';
import {sessionKey,terminalIdentity,terminalKey,hydrateTerminal,newIntent,unboundOrigin,localTerminalAddress} from '../src/shared/session-identity.js';
const s={machine:null,provider:'codex',credentialScope:'work',providerRoot:'/home/me/.codex',sessionId:'session-A'};
test('session keys separate every provider, account, root and host',()=>{
  const keys=[s,{...s,machine:'server'},{...s,provider:'claude'},{...s,credentialScope:'personal'},{...s,providerRoot:'/other/.codex'},{...s,sessionId:'session-B'}].map(sessionKey);
  assert.equal(new Set(keys).size,keys.length);
  assert.throws(()=>sessionKey({...s,providerRoot:'../root'}));
});
test('observed alphanumeric core addresses remain exact and cannot cross host/path boundaries',()=>{
  for(const address of ['t19','t1b','t1g','t1z','t20']){assert.equal(localTerminalAddress(address,null),address);assert.equal(localTerminalAddress('server/'+address,'server'),address);assert.equal(terminalIdentity({address,created_ms:10,foreground:{pid:55}},'server').address,'server/'+address);}
  for(const address of ['other/t1b','server/t1b/extra','../t1b','t1b;echo','t1b white','t1B'])assert.throws(()=>localTerminalAddress(address,'server'),/requested host/);
});
test('generic intents are distinct and retry preserves explicit IDs without a fabricated session',()=>{
  const a=newIntent(),b=newIntent();assert.notEqual(a.requestId,b.requestId);assert.notEqual(a.originId,b.originId);
  assert.deepEqual(newIntent(a),a);assert.equal(unboundOrigin(a).session,undefined);
});
test('only full raw created_ms defines a terminal generation',()=>{
  const raw={address:'server/t9',created_ms:10,foreground:{pid:55}};
  const a=terminalIdentity(raw,'server');assert.equal(a.createdMs,10);
  assert.notEqual(terminalKey(a),terminalKey(terminalIdentity({...raw,created_ms:11},'server')));
  assert.notEqual(terminalKey(a),terminalKey({...a,foregroundPid:56}));
  assert.throws(()=>terminalIdentity({address:'t9'},'server'),/created_ms/);
  assert.throws(()=>terminalIdentity({...raw,address:'other/t9'},'server'),/requested host/);
});
test('summary hydration targets the exact host and refuses missing creation or changed address',async()=>{
  const calls=[];const exec=async(...args)=>{calls.push(args);return {code:0,stdout:JSON.stringify({address:'t9',created_ms:25,foreground:{pid:55}})};};
  const r=await hydrateTerminal({address:'server/t9',cwd:'/repo'},{machine:'server',exec});
  assert.equal(r.identity.createdMs,25);assert.deepEqual(calls,[['hc',['get','t9','--json'],{on:'server'}]]);
  await assert.rejects(hydrateTerminal({address:'t9'},{exec:async()=>({code:0,stdout:'{"address":"t9"}'})}),/created_ms/);
  await assert.rejects(hydrateTerminal({address:'t9'},{exec:async()=>({code:0,stdout:'{"address":"t8","created_ms":1}'})}),/changed/);
  assert.equal(calls.length,1);
});
