import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {build} from 'esbuild';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {validateNativeIsolationReceipt} from '../scripts/native-harness.mjs';

const name='mission-control-jira',root=path.resolve(import.meta.dirname,'..'),packageRoot=path.join(root,name),mod=path.join(packageRoot,'mods',name),sha=b=>crypto.createHash('sha256').update(b).digest('hex');

test('Jira standalone recipe, actual preview and every packaged/source byte match its passed native proof',async()=>{
  assert.equal(await fs.stat(path.join(packageRoot,'layouts')).then(()=>true,()=>false),false);assert.deepEqual(await fs.readdir(path.join(packageRoot,'mods')),[name]);
  const recipe=await fs.readFile(path.join(packageRoot,'RECIPE.md'),'utf8');let previous=-1;
  for(const title of ['# Mission Control Jira','## What you see','## How it behaves','## Built from','## Watch out','## Done when']){const index=recipe.indexOf(title);assert.ok(index>previous,title);previous=index;}
  assert.match(recipe,/!\[Mission Control Jira\]\(preview\.png\)/);assert.match(recipe,/Access disclosure/);assert.match(recipe,/Node.js 22/);assert.match(recipe,/authenticated tenant access remains separate/i);
  const receiptPath=path.join(root,'evidence/native/jira.json'),receipt=JSON.parse(await fs.readFile(receiptPath,'utf8'));assert.equal(await validateNativeIsolationReceipt(receipt,{receiptPath}),true);
  assert.ok(receipt.inputActions.some(a=>a.kind==='pointer'));assert.ok(receipt.inputActions.some(a=>a.kind==='key'));assert.ok(receipt.assertions.some(a=>a.passed&&a.label.includes('All-spaces Codex shortcut')));assert.ok(receipt.assertions.some(a=>a.passed&&a.label.includes('MCP Basic setup')));assert.ok(receipt.assertions.some(a=>a.passed&&a.label.includes('system browser')));
  const frame=receipt.frames.find(f=>f.label==='jira-preview');assert.ok(frame);assert.equal(frame.capture,'macos-window-server');const bytes=await fs.readFile(path.join(packageRoot,'preview.png'));assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.equal(sha(bytes),frame.sha256);assert.equal(sha(await fs.readFile(path.join(root,frame.path))),frame.sha256);
  const manifest=JSON.parse(await fs.readFile(path.join(packageRoot,'build-manifest.json'),'utf8')),tested=receipt.packages.find(p=>p.name===name);assert.equal(tested.nativeCheck,true);assert.deepEqual(tested.manifest,manifest);
  for(const [file,expected]of Object.entries(manifest.artifacts))assert.equal(sha(await fs.readFile(path.join(mod,file))),expected,file);
  for(const [file,expected]of Object.entries(manifest.sources))assert.equal(sha(await fs.readFile(path.join(root,file))),expected,file);
});

test('copied Jira mod resolves its native imports/assets and runs its backend without repository or sibling modules',async t=>{
  const temp=await fs.mkdtemp('/private/tmp/mc-jira-copy-');t.after(()=>fs.rm(temp,{recursive:true,force:true}));const copy=path.join(temp,name);await fs.cp(mod,copy,{recursive:true});
  const native=new Set(['gpui-kit','gpui-base','herdr']);const built=await build({entryPoints:[path.join(copy,'main.js')],bundle:true,platform:'neutral',format:'esm',write:false,metafile:true,logLevel:'silent',plugins:[{name:'standalone-boundary',setup(b){b.onResolve({filter:/.*/},async args=>{if(native.has(args.path))return {path:args.path,external:true};if(args.kind!=='entry-point'&&!args.path.startsWith('.'))throw Error('Unexpected runtime dependency '+args.path);const target=await fs.realpath(path.resolve(args.resolveDir||temp,args.path));assert.ok(target.startsWith(copy+path.sep));return {path:target};});}}]});assert.equal(Object.keys(built.metafile.inputs).length,1);assert.ok((await fs.readdir(path.join(copy,'assets'))).includes('jira.svg'));assert.match(await fs.readFile(path.join(copy,'NOTICE.md'),'utf8'),/Original Mission Control artwork/);
  const backend=path.join(copy,'backend.mjs'),env={PATH:process.env.PATH,HOME:temp,XDG_CONFIG_HOME:temp+'/config'},execute=promisify(execFile);
  const imported=await execute(process.execPath,['--input-type=module','-e',`import {dispatchJira} from ${JSON.stringify(new URL('file://'+backend).href)};console.log(JSON.stringify(await dispatchJira({})));`],{cwd:temp,env,timeout:10000});assert.equal(JSON.parse(imported.stdout).error.code,'INVALID_REQUEST');
  const direct=await execute(process.execPath,[backend,'{}'],{cwd:temp,env,timeout:10000});assert.equal(JSON.parse(direct.stdout).error.code,'INVALID_REQUEST');assert.equal(await fs.stat(path.join(temp,'node_modules')).then(()=>true,()=>false),false);
});
