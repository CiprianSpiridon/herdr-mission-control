import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {build} from 'esbuild';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {validateNativeIsolationReceipt} from '../scripts/native-harness.mjs';

const name='mission-control-github',root=path.resolve(import.meta.dirname,'..'),packageRoot=path.join(root,name),mod=path.join(packageRoot,'mods',name),sha=b=>crypto.createHash('sha256').update(b).digest('hex');

test('GitHub standalone recipe, real preview and all source/artifact bytes match the full passed native proof',async()=>{
  assert.ok(!(await fs.readdir(packageRoot)).includes('layouts'));assert.deepEqual(await fs.readdir(path.join(packageRoot,'mods')),[name]);
  const recipe=await fs.readFile(path.join(packageRoot,'RECIPE.md'),'utf8');let previous=-1;
  for(const title of ['# Mission Control GitHub','## What you see','## How it behaves','## Built from','## Watch out','## Done when']){const index=recipe.indexOf(title);assert.ok(index>previous,title);previous=index;}
  assert.match(recipe,/!\[Mission Control GitHub\]\(preview\.png\)/);assert.match(recipe,/Access disclosure/);assert.match(recipe,/Node.js 22/);assert.match(recipe,/Authenticated provider access remains separate/);
  const receiptPath=path.join(root,'evidence/native/github.json'),receipt=JSON.parse(await fs.readFile(receiptPath,'utf8'));assert.equal(await validateNativeIsolationReceipt(receipt,{receiptPath}),true);
  assert.ok(receipt.inputActions.some(a=>a.kind==='pointer'));assert.ok(receipt.inputActions.some(a=>a.kind==='key'));assert.ok(receipt.inputActions.some(a=>a.kind==='scroll'&&a.deltaY===-2000));
  for(const label of ['Actual standalone setup probes','Actual own-mod shortcut settings','Actual native issue-key click','Actual universal task reaches','A different selected action on existing PR/tool work','Held PR launch survives removal','Native 120-PR fixture uses real same-origin Link pages of 50/50/20','Native Show more and scrolling expose an interactive offscreen','Linked GitHub issue shows its human number','Owned HTTP evidence contains no provider mutation'])assert.ok(receipt.assertions.some(a=>a.passed&&a.label.includes(label)),label);
  const frame=receipt.frames.find(f=>f.label==='github-preview');assert.ok(frame);assert.equal(frame.capture,'macos-window-server');const bytes=await fs.readFile(path.join(packageRoot,'preview.png'));assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.equal(sha(bytes),frame.sha256);assert.equal(sha(await fs.readFile(path.join(root,frame.path))),frame.sha256);
  const manifest=JSON.parse(await fs.readFile(path.join(packageRoot,'build-manifest.json'),'utf8')),tested=receipt.packages.find(p=>p.name===name);assert.equal(tested.nativeCheck,true);assert.deepEqual(tested.manifest,manifest);
  for(const[file,expected]of Object.entries(manifest.artifacts))assert.equal(sha(await fs.readFile(path.join(mod,file))),expected,file);
  for(const[file,expected]of Object.entries(manifest.sources))assert.equal(sha(await fs.readFile(path.join(root,file))),expected,file);
});

test('copied GitHub mod resolves native imports/assets and executes its backend without repository or sibling dependencies',async t=>{
  const temp=await fs.mkdtemp('/private/tmp/mc-github-copy-');t.after(()=>fs.rm(temp,{recursive:true,force:true}));const copy=path.join(temp,name);await fs.cp(mod,copy,{recursive:true});
  const native=new Set(['gpui-kit','gpui-base','herdr']),built=await build({entryPoints:[path.join(copy,'main.js')],bundle:true,platform:'neutral',format:'esm',write:false,metafile:true,logLevel:'silent',plugins:[{name:'standalone-boundary',setup(b){b.onResolve({filter:/.*/},async args=>{if(native.has(args.path))return {path:args.path,external:true};if(args.kind!=='entry-point'&&!args.path.startsWith('.'))throw Error('Unexpected runtime dependency '+args.path);const target=await fs.realpath(path.resolve(args.resolveDir||temp,args.path));assert.ok(target.startsWith(copy+path.sep));return {path:target};});}}]});assert.equal(Object.keys(built.metafile.inputs).length,1);
  for(const asset of ['github.svg','issue.svg','pull-request.svg','jira.svg','more.svg','settings.svg','agent.svg']){const file=await fs.realpath(path.join(copy,'assets',asset));assert.ok(file.startsWith(copy+path.sep));assert.match(await fs.readFile(file,'utf8'),/<svg\b/);}assert.match(await fs.readFile(path.join(copy,'NOTICE.md'),'utf8'),/Original Mission Control artwork/);
  const backend=path.join(copy,'backend.mjs'),env={PATH:process.env.PATH,HOME:temp,XDG_CONFIG_HOME:temp+'/config'},execute=promisify(execFile);
  const imported=await execute(process.execPath,['--input-type=module','-e',`import {dispatchGithub} from ${JSON.stringify(new URL('file://'+backend).href)};console.log(JSON.stringify(await dispatchGithub({})));`],{cwd:temp,env,timeout:10000});assert.equal(JSON.parse(imported.stdout).error.code,'INVALID_REQUEST');
  const direct=await execute(process.execPath,[backend,'{}'],{cwd:temp,env,timeout:10000});assert.equal(JSON.parse(direct.stdout).error.code,'INVALID_REQUEST');assert.equal(await fs.stat(path.join(temp,'node_modules')).then(()=>true,()=>false),false);
});
