import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {handle} from '../src/mods/mission-control-control-panel/backend.mjs';
import {layoutUpdateKeys, commitLayout} from '../src/mods/mission-control-control-panel/bundles.mjs';
import {scan, SELF} from '../src/mods/mission-control-control-panel/inventory.mjs';
import {createStore} from '../src/mods/mission-control-control-panel/store.mjs';

const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',env:{...process.env,GIT_AUTHOR_NAME:'QA',GIT_AUTHOR_EMAIL:'qa@example.invalid',GIT_COMMITTER_NAME:'QA',GIT_COMMITTER_EMAIL:'qa@example.invalid'}}).trim();
const write=async(file,bytes)=>{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes);};
const code=version=>`export const value = '${version}';\n`;
async function fixture(t){
  const root=await fs.mkdtemp('/private/tmp/mc-layout-bundle-');t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const repo=path.join(root,'upstream'),home=path.join(root,'app'),names=['mission-control-agents',SELF],layouts=['mission-control','mission-control-classic'];
  await fs.mkdir(repo);git(repo,'init','-q','-b','main');
  const initial={};for(const name of names)initial[`mods/${name}/main.js`]=code('v1');
  for(const name of layouts)initial[`layouts/${name}.json`]=JSON.stringify({children:names.map(mod=>({content:{mod}}))})+'\n';
  for(const [file,bytes] of Object.entries(initial)){await write(path.join(repo,'mission-control',file),bytes);await write(path.join(home,file),bytes);}
  await write(path.join(repo,'mission-control/keys.json'),'{}\n');
  git(repo,'add','.');git(repo,'commit','-qm','Initial layout bundle');
  const old=git(repo,'rev-parse','HEAD');
  await write(path.join(home,'mission-control/installed-packages.json'),JSON.stringify({v:1,packages:{'mission-control':{mods:names,layouts}}}));
  await write(path.join(home,'keys.json'),JSON.stringify({global:{'ctrl-k':'mine.keep'}}));
  const entry={url:'file://'+repo,fullName:'fixture/upstream',defaultBranch:'main',path:'mission-control'};
  await write(path.join(root,'mods.json'),JSON.stringify({mods:[]}));
  await write(path.join(root,'layouts.json'),JSON.stringify({layouts:[{...entry,layoutFiles:layouts.map(n=>'mission-control/layouts/'+n+'.json')}]}));
  const env={...process.env,QA_MODS_FIXTURE:'1',QA_MODS_CATALOG_URL:'file://'+root+'/{kind}.json'};
  const checker=path.join(root,'herdr-app');await write(checker,'#!/bin/sh\nexit 0\n');await fs.chmod(checker,0o755);
  const call=(op,extra={})=>handle({appHome:home,op,...extra},{env,herdrApp:checker});
  await call('check');
  const push=async files=>{for(const [file,bytes]of Object.entries(files))await write(path.join(repo,'mission-control',file),bytes);git(repo,'add','.');git(repo,'commit','-qm','Update bundled mods');return git(repo,'rev-parse','HEAD');};
  const prepare=async(resolutions={})=>{
    let p,continuation,calls=0;
    do{p=(await call('prepare',{key:'layout:mission-control',resolutions,continuation})).prepared;continuation=p.continuation;if(++calls>10)throw Error('Preparation did not finish');}while(p.pending);
    return p;
  };
  return {root,repo,home,names,layouts,initial,old,call,push,prepare,checker};
}

test('the screenshot case: unchanged layout files expose the same bundled Control Panel update and apply it',async t=>{
  const f=await fixture(t),next=await f.push({[`mods/${SELF}/main.js`]:code('v2')});
  const checked=await f.call('check');
  for(const name of f.layouts){
    const row=checked.list.find(i=>i.key==='layout:'+name);
    assert.equal(row.state,'update');assert.deepEqual(row.updateKeys,['mod:'+SELF]);
    assert.equal(row.update.changed,1);assert.match(row.update.subject,/mission-control-control-panel/);
  }
  assert.equal(checked.list.find(i=>i.name==='mission-control-agents').state,'current');
  const p=await f.prepare();assert.equal(p.ok,true);
  assert.deepEqual(p.review.changed,[`mods/${SELF}/main.js`]);
  assert.equal(await fs.readFile(path.join(f.home,'mods',SELF,'main.js'),'utf8'),code('v1'),'review writes nothing');
  await f.call('commit',{key:'layout:mission-control'});
  assert.equal(await fs.readFile(path.join(f.home,'mods',SELF,'main.js'),'utf8'),code('v2'));
  const records=JSON.parse(await fs.readFile(path.join(f.home,'mission-control/control-panel/packages.json'),'utf8'));
  assert.equal(records.packages['mod:'+SELF].commit,next);
  for(const name of f.layouts){assert.equal((await f.call('inventory')).list.find(i=>i.name===name).state,'current');assert.equal(await fs.readFile(path.join(f.home,'layouts',name+'.json'),'utf8'),f.initial['layouts/'+name+'.json']);}
});

test('a multi-mod layout update composes keys and rolls all files back together on a failed write',async t=>{
  const f=await fixture(t);
  await f.push(Object.fromEntries([...f.names.map(n=>[`mods/${n}/main.js`,code('v2')]),['keys.json',JSON.stringify({global:{'ctrl-a':'mission-control-agents.open','ctrl-b':SELF+'.open'}})]]));
  await f.call('check');assert.equal((await f.prepare()).ok,true);
  const store=createStore({appHome:f.home}),layout=(await scan(f.home)).items.find(i=>i.key==='layout:mission-control');
  const packages=(await store.readPackages()).packages;
  await assert.rejects(commitLayout({appHome:f.home,layout,packages,store:{...store,commit:(ops,options)=>store.commit(ops,{...options,afterOp:index=>{if(index===1)throw Error('fixture write failure');}})}}),/fixture write failure/);
  for(const n of f.names)assert.equal(await fs.readFile(path.join(f.home,'mods',n,'main.js'),'utf8'),code('v1'));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.home,'keys.json'),'utf8')),{global:{'ctrl-k':'mine.keep'}});
  for(const n of f.names)assert.equal((await store.readPackages()).packages['mod:'+n].commit,f.old);
  await f.call('commit',{key:'layout:mission-control'});
  for(const n of f.names)assert.equal(await fs.readFile(path.join(f.home,'mods',n,'main.js'),'utf8'),code('v2'));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.home,'keys.json'),'utf8')),{global:{'ctrl-k':'mine.keep','ctrl-a':'mission-control-agents.open','ctrl-b':SELF+'.open'}});
});

test('a bundled-mod conflict blocks the entire layout update and resolves through the scoped review',async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.home,'mods',SELF,'main.js'),code('mine'));
  await f.push(Object.fromEntries(f.names.map(n=>[`mods/${n}/main.js`,code('theirs')])));await f.call('check');
  const p=await f.prepare();assert.equal(p.state,'conflict');assert.deepEqual(p.conflicts.map(c=>c.file),[`mods/${SELF}/main.js`]);
  await assert.rejects(f.call('commit',{key:'layout:mission-control'}),e=>e.code==='NOT_PREPARED');
  assert.equal(await fs.readFile(path.join(f.home,'mods/mission-control-agents/main.js'),'utf8'),code('v1'));
  assert.equal(await fs.readFile(path.join(f.home,'mods',SELF,'main.js'),'utf8'),code('mine'));
  assert.equal((await f.prepare({[`mods/${SELF}/main.js`]:'theirs'})).ok,true);
  await f.call('commit',{key:'layout:mission-control'});
  for(const n of f.names)assert.equal(await fs.readFile(path.join(f.home,'mods',n,'main.js'),'utf8'),code('theirs'));
});

test('a failed native check cannot leave a partially applicable layout bundle',async t=>{
  const f=await fixture(t);await f.push(Object.fromEntries(f.names.map(n=>[`mods/${n}/main.js`,code('v2')])));await f.call('check');
  await fs.writeFile(f.checker,`#!/bin/sh\ncase "$2" in *${SELF}*) exit 1;; esac\nexit 0\n`);
  await assert.rejects(f.prepare(),e=>e.code==='CHECK_FAILED');
  await assert.rejects(f.call('commit',{key:'layout:mission-control'}),e=>e.code==='NOT_PREPARED');
  for(const n of f.names)assert.equal(await fs.readFile(path.join(f.home,'mods',n,'main.js'),'utf8'),code('v1'));
});

test('changing staged bundled files after review invalidates the whole layout Apply',async t=>{
  const f=await fixture(t);await f.push(Object.fromEntries(f.names.map(n=>[`mods/${n}/main.js`,code('v2')])));await f.call('check');
  assert.equal((await f.prepare()).ok,true);
  await fs.writeFile(path.join(f.home,'mission-control/control-panel/stage/mod-'+SELF+'/files/main.js'),code('changed after review'));
  await assert.rejects(f.call('commit',{key:'layout:mission-control'}),e=>e.code==='STALE_PREPARE');
  for(const n of f.names)assert.equal(await fs.readFile(path.join(f.home,'mods',n,'main.js'),'utf8'),code('v1'));
});

test('layout membership excludes disabled, built-in, other-package and other-source mods',()=>{
  const layout={key:'layout:one',kind:'layout',name:'one',origin:'installer',installerPackage:'pkg'};
  const source={url:'https://github.com/fixture/repo',defaultBranch:'main',path:'pkg'};
  const mods=['good','disabled','builtin','other-package','other-source'].map(name=>({key:'mod:'+name,kind:'mod',name,origin:name==='builtin'?'builtin':'installer',disabled:name==='disabled',installerPackage:name==='other-package'?'other':'pkg'}));
  const packages=Object.fromEntries([layout,...mods].map(i=>[i.key,{source:i.name==='other-source'?{...source,url:'https://github.com/fixture/other'}:source,lastResult:i===layout?{state:'current'}:{state:'update',update:{}}}]));
  assert.deepEqual(layoutUpdateKeys(layout,[layout,...mods],packages),['mod:good']);
});
