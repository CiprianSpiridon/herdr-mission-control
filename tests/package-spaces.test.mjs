import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {build} from 'esbuild';
import {validateNativeIsolationReceipt} from '../scripts/native-harness.mjs';
const name='mission-control-spaces',root=new URL('../',import.meta.url).pathname,packageRoot=path.join(root,name),mod=path.join(packageRoot,'mods',name),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
test('standalone folder contains the six-part reconstruction brief and the exact passed native preview',async()=>{
  assert.equal(await fs.stat(path.join(packageRoot,'layouts')).then(()=>true,()=>false),false);
  assert.deepEqual(await fs.readdir(path.join(packageRoot,'mods')),[name]);
  const recipe=await fs.readFile(path.join(packageRoot,'RECIPE.md'),'utf8');const titles=['# Mission Control Spaces','## What you see','## How it behaves','## Built from','## Watch out','## Done when'];let previous=-1;for(const title of titles){const index=recipe.indexOf(title);assert.ok(index>previous,title);previous=index;}assert.match(recipe,/!\[Mission Control Spaces\]\(preview\.png\)/);assert.match(recipe,/Access disclosure/);
  const receiptPath=path.join(root,'evidence/native/spaces.json'),receipt=JSON.parse(await fs.readFile(receiptPath,'utf8'));assert.equal(await validateNativeIsolationReceipt(receipt,{receiptPath}),true);assert.equal(receipt.appErrors.length,0);assert.ok(receipt.inputActions.some(a=>a.kind==='pointer'&&a.control==='Start agent'));assert.ok(receipt.inputActions.some(a=>a.kind==='pointer'&&a.button==='right'));assert.ok(receipt.assertions.some(a=>a.passed&&a.label.includes('separate core/repository')));
  const preview=receipt.frames.find(f=>f.label==='spaces-preview');assert.ok(preview);assert.equal(preview.capture,'macos-window-server');const bytes=await fs.readFile(path.join(packageRoot,'preview.png'));assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.equal(sha(bytes),preview.sha256);assert.equal(sha(await fs.readFile(path.join(root,preview.path))),preview.sha256);
  const manifest=JSON.parse(await fs.readFile(path.join(packageRoot,'build-manifest.json'),'utf8')),tested=receipt.packages.find(p=>p.name===name);assert.equal(tested.nativeCheck,true);assert.deepEqual(tested.manifest,manifest,'Current output must equal the exact natively tested build');
  for(const [file,expected]of Object.entries(manifest.artifacts))assert.equal(sha(await fs.readFile(path.join(mod,file))),expected,file);
  for(const [file,expected]of Object.entries(manifest.sources))assert.equal(sha(await fs.readFile(path.join(root,file))),expected,file);
});
test('only the copied mod folder is enough to resolve every runtime import and local asset',async t=>{
  const temp=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'mc-standalone-copy-')));t.after(()=>fs.rm(temp,{recursive:true,force:true}));const copy=path.join(temp,name);await fs.cp(mod,copy,{recursive:true});
  const native=new Set(['gpui-kit','gpui-base','herdr']);const result=await build({entryPoints:[path.join(copy,'main.js')],bundle:true,platform:'neutral',format:'esm',write:false,metafile:true,logLevel:'silent',plugins:[{name:'standalone-boundary',setup(b){b.onResolve({filter:/.*/},async args=>{if(native.has(args.path))return {path:args.path,external:true};if(args.kind!=='entry-point'&&!args.path.startsWith('.'))throw Error('Unexpected runtime dependency '+args.path);const target=await fs.realpath(path.resolve(args.resolveDir||temp,args.path));assert.ok(target.startsWith(copy+path.sep));return {path:target};});}}]});
  assert.equal(Object.keys(result.metafile.inputs).length,1);assert.ok((await fs.readdir(path.join(copy,'assets'))).includes('more.svg'));assert.ok((await fs.readFile(path.join(copy,'NOTICE.md'),'utf8')).includes('Original Mission Control artwork'));
});
