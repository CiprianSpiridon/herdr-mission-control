import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {build} from 'esbuild';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {validateNativeIsolationReceipt} from '../scripts/native-harness.mjs';

const name='mission-control-control-panel',root=path.resolve(import.meta.dirname,'..'),packageRoot=path.join(root,name),mod=path.join(packageRoot,'mods',name),sha=b=>crypto.createHash('sha256').update(b).digest('hex');

test('Control panel standalone recipe, real preview and all source/artifact bytes match the full passed native proof',async()=>{
  assert.ok(!(await fs.readdir(packageRoot)).includes('layouts'));assert.deepEqual(await fs.readdir(path.join(packageRoot,'mods')),[name]);
  const recipe=await fs.readFile(path.join(packageRoot,'RECIPE.md'),'utf8');let previous=-1;
  for(const title of ['# Mission Control · Control panel','## What you see','## How it behaves','## Built from','## Watch out','## Done when']){const index=recipe.indexOf(title);assert.ok(index>previous,title);previous=index;}
  assert.match(recipe,/!\[Mission Control · Control panel\]\(preview\.png\)/);
  // The access disclosure names every file area, program and host the helper reaches.
  const disclosure=recipe.slice(recipe.indexOf('**Access disclosure:**'));assert.ok(recipe.includes('**Access disclosure:**'));
  for(const part of ['appHome()/mods/','appHome()/layouts/','installed.json','keys.json','appHome()/mission-control/control-panel/','Node.js','`git`','herdr-app check','https://assets.herdr.dev/','https://github.com/','never changes built-in'])assert.ok(disclosure.includes(part),'disclosure names '+part);
  const scenario=await import('./native/control-panel.mjs');
  const receiptPath=path.join(root,'evidence/native/control-panel.json'),receipt=JSON.parse(await fs.readFile(receiptPath,'utf8'));assert.equal(receipt.ok,true);assert.equal(await validateNativeIsolationReceipt(receipt,{receiptPath}),true);
  assert.ok(receipt.inputActions.some(a=>['AX','pointer'].includes(a.kind)),'real native presses');assert.ok(receipt.inputActions.some(a=>a.kind==='key'&&a.key===scenario.KEY),'the added key was pressed natively');
  const passed=new Set(receipt.assertions.filter(a=>a.passed).map(a=>a.label));for(const label of Object.values(scenario.EXPECTATIONS))assert.ok(passed.has(label),label);
  const frame=receipt.frames.find(f=>f.label==='control-panel-preview');assert.ok(frame,'the native preview frame');assert.equal(frame.capture,'macos-window-server');
  const bytes=await fs.readFile(path.join(packageRoot,'preview.png'));assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.equal(sha(bytes),frame.sha256,'preview.png is the native preview frame');assert.equal(sha(await fs.readFile(path.join(root,frame.path))),frame.sha256);
  const manifest=JSON.parse(await fs.readFile(path.join(packageRoot,'build-manifest.json'),'utf8')),tested=receipt.packages.find(p=>p.name===name);assert.equal(tested.nativeCheck,true);assert.deepEqual(tested.manifest,manifest,'the package is the natively tested build');
  for(const[file,expected]of Object.entries(manifest.artifacts))assert.equal(sha(await fs.readFile(path.join(mod,file))),expected,file);
  for(const[file,expected]of Object.entries(manifest.sources))assert.equal(sha(await fs.readFile(path.join(root,file))),expected,file);
});

test('copied Control panel mod resolves its view, helper and icons inside its own folder, and its helper answers on its own',async t=>{
  const temp=await fs.realpath(await fs.mkdtemp('/private/tmp/mc-mods-copy-'));t.after(()=>fs.rm(temp,{recursive:true,force:true}));const copy=path.join(temp,'app/mods',name);await fs.cp(mod,copy,{recursive:true});
  const native=new Set(['gpui-kit','gpui-base','herdr']),built=await build({entryPoints:[path.join(copy,'main.js')],bundle:true,platform:'neutral',format:'esm',write:false,metafile:true,logLevel:'silent',plugins:[{name:'standalone-boundary',setup(b){b.onResolve({filter:/.*/},async args=>{if(native.has(args.path))return {path:args.path,external:true};if(args.kind!=='entry-point'&&!args.path.startsWith('.'))throw Error('Unexpected runtime dependency '+args.path);const target=await fs.realpath(path.resolve(args.resolveDir||temp,args.path));assert.ok(target.startsWith(copy+path.sep));return {path:target};});}}]});
  assert.equal(Object.keys(built.metafile.inputs).length,1);
  const code=await fs.readFile(path.join(copy,'main.js'),'utf8');assert.ok(!code.includes(root),'no repository path is embedded');assert.match(code,/\/backend\.mjs/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(copy,'mod.json'),'utf8')),{title:'Mission Control · Control panel',place:'right',size:420});
  for(const asset of ['layout.svg','panel.svg','refresh.svg','search.svg','chevron-down.svg','chevron-right.svg']){const file=await fs.realpath(path.join(copy,'assets',asset));assert.ok(file.startsWith(copy+path.sep));assert.match(await fs.readFile(file,'utf8'),/<svg\b/);}
  assert.match(await fs.readFile(path.join(copy,'NOTICE.md'),'utf8'),/Original Mission Control artwork/);
  // The bundled helper needs only Node's standard library; offline it still lists what is installed.
  const helper=await fs.readFile(path.join(copy,'backend.mjs'),'utf8');for(const m of helper.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g))assert.match(m[1],/^node:/,'helper import '+m[1]);
  await fs.mkdir(path.join(temp,'app/mods/qa-local'),{recursive:true});await fs.writeFile(path.join(temp,'app/mods/qa-local/main.js'),'export default 1;\n');
  const env={PATH:process.env.PATH,HOME:path.join(temp,'home'),QA_MODS_FIXTURE:'1',QA_MODS_CATALOG_URL:'http://127.0.0.1:9/{kind}.json'};await fs.mkdir(env.HOME);
  const out=JSON.parse((await promisify(execFile)(process.execPath,[path.join(copy,'backend.mjs'),JSON.stringify({appHome:path.join(temp,'app'),op:'inventory'})],{cwd:temp,env,timeout:25000})).stdout);
  assert.equal(out.ok,true);assert.deepEqual(out.list.map(i=>[i.key,i.origin]).sort(),[['mod:mission-control-control-panel','self'],['mod:qa-local','user']]);
  const bad=JSON.parse((await promisify(execFile)(process.execPath,[path.join(copy,'backend.mjs'),'{}'],{cwd:temp,env,timeout:25000})).stdout);assert.deepEqual([bad.ok,bad.code],[false,'INVALID_REQUEST']);
  assert.equal(await fs.stat(path.join(temp,'node_modules')).then(()=>true,()=>false),false);
});
