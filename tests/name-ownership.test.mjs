import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import sync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {NameOwnership} from '../src/shared/name-ownership.js';
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'mc-names-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const io={appHome:root,readTextFile:async p=>{try{return await fs.readFile(p,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}},ensureDirectory:p=>fs.mkdir(p,{recursive:true}),writeTextFile:async(p,next,expected)=>{let actual=null;try{actual=sync.readFileSync(p,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}if(actual!==expected)throw Object.assign(Error('stale'),{code:'STALE'});sync.writeFileSync(p,next);}};return {io,root};}
const session=id=>({machine:null,provider:'codex',credentialScope:'work',providerRoot:'/profiles/work/.codex',sessionId:id});
test('manual A survives close, newer B and acknowledged replacement with a fresh consumer',async t=>{
  const {io}=await fixture(t),a=new NameOwnership(io,{owner:'a'});await a.transferToAcknowledgedTab({originId:'A',session:session('session-A')},{tabId:'tab-A',name:'Auto A'});
  await a.observeNames([{id:'tab-A',machine:null,name:'My investigation',named:true}]);
  await a.transferToAcknowledgedTab({originId:'B',session:session('session-B')},{tabId:'tab-B',name:'Newer B'});
  const fresh=new NameOwnership(io,{owner:'fresh'});const record=await fresh.find({session:session('session-A')});assert.equal(record.manualName,'My investigation');
  await fresh.transferToAcknowledgedTab({originId:record.originId,session:session('session-A')},{tabId:'replacement-A',name:'Auto A'});
  const effects=[];await fresh.applyName('A',record.manualName,{manualTransfer:true,getTabs:()=>[{id:'replacement-A',machine:null,name:'Auto A',named:true}],rename:args=>effects.push(args)});
  assert.deepEqual(effects,[{id:'replacement-A',name:'My investigation'}]);assert.equal((await fresh.find({originId:'B'})).lastAutoName,'Newer B');
});
test('unknown imported history has no invented ownership or cross-account name',async t=>{
  const {io}=await fixture(t),store=new NameOwnership(io);assert.equal(await store.find({session:session('unknown')}),null);
  await store.transferToAcknowledgedTab({originId:'imported',session:session('unknown')},{tabId:'new',name:'Provider title'});assert.equal((await store.find({originId:'imported'})).manualName,null);
  assert.equal(await store.find({session:{...session('unknown'),credentialScope:'personal'}}),null);
});
test('one observer lease and CAS races preserve manual edits and stale auto work cannot rename',async t=>{
  const {io}=await fixture(t);let now=10;const a=new NameOwnership(io,{owner:'a',clock:()=>now}),b=new NameOwnership(io,{owner:'b',clock:()=>now});
  await a.transferToAcknowledgedTab({originId:'A'},{tabId:'t-A',name:'Auto'});
  assert.equal((await a.observeNames([])).owned,true);assert.equal((await b.observeNames([])).owned,false);
  await a.observeNames([{id:'t-A',name:'Manual',named:true}]);let renamed=0;
  assert.equal((await b.applyName('A','Stale auto',{getTabs:()=>[{id:'t-A',name:'Manual',named:true}],rename:()=>renamed++})).applied,false);assert.equal(renamed,0);
  now=6000;assert.equal((await b.observeNames([])).owned,true);
  await Promise.all([a.transferToAcknowledgedTab({originId:'B'},{tabId:'t-B',name:'B'}),b.transferToAcknowledgedTab({originId:'C'},{tabId:'t-C',name:'C'})]);
  assert.deepEqual(Object.keys((await a.read()).value.origins).sort(),['A','B','C']);
});
test('a user rename arriving during an auto CAS is checked again immediately before the action',async t=>{
  const {io}=await fixture(t),store=new NameOwnership(io);await store.transferToAcknowledgedTab({originId:'A'},{tabId:'t-A',name:'Auto'});
  let name='Auto',calls=0;const getTabs=()=>{calls++;return [{id:'t-A',name:calls===1?name:'User rename',named:true}];};
  const effects=[];const result=await store.applyName('A','Next auto',{getTabs,rename:args=>effects.push(args)});assert.equal(result.applied,false);assert.deepEqual(effects,[]);
});
