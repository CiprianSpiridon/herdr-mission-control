import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {prepareWorktree,ensureWorktree,requestDigest,resolveWorktreeChoice} from '../src/shared/worktrees.js';
const exec=(command,args,options={})=>new Promise((resolve,reject)=>{assert.equal(options.on??null,null);const p=spawn(command,args,{cwd:options.cwd});let stdout='',stderr='';p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);p.on('error',reject);p.on('close',code=>resolve({code,stdout,stderr}));});
async function fixture(t){const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'mc-worktree-')),root=await fs.realpath(temporary),repo=path.join(root,'repo');await fs.mkdir(repo);for(const args of [['init','-q','-b','main'],['config','user.name','QA'],['config','user.email','qa@example.invalid'],['commit','--allow-empty','-qm','Initial']]){const r=await exec('git',['-C',repo,...args]);assert.equal(r.code,0,r.stderr);}t.after(()=>fs.rm(root,{recursive:true,force:true}));return {root,repo};}
const request=repo=>({requestId:'request-A',idempotencyKey:'request-A',originId:'origin-A',spaceId:'space-A',machine:null,repoRoot:repo,checkoutRoot:repo,worktree:true,source:{kind:'jira',connectionId:'work',site:'https://jira.example.invalid',id:'10001',key:'WEB-142'}});
test('a friendly worktree name creates a real Git worktree with an automatic branch',async t=>{
  const {repo}=await fixture(t),r={...request(repo),source:undefined};
  const choice=resolveWorktreeChoice(r,{spaceName:'repo',value:'clean up website content'});
  assert.match(choice.worktreePath,/\.herdr-worktrees\/repo-clean-up-website-content$/);
  const launch={...r,...choice},spec=await prepareWorktree(launch,{spaceName:'repo',exec}),created=await ensureWorktree(launch,spec,{exec});
  assert.equal(created.folder,choice.worktreePath);assert.equal((await exec('git',['-C',created.folder,'branch','--show-current'])).stdout.trim(),choice.branch);
  assert.deepEqual(resolveWorktreeChoice(r,{spaceName:'repo'}),resolveWorktreeChoice(r,{spaceName:'repo',value:'   '}));
  assert.deepEqual(resolveWorktreeChoice(r,{value:choice.worktreePath,branch:'custom-branch'}),{worktreePath:choice.worktreePath,branch:'custom-branch'});
});
test('Jira display key names a real worktree while exact owned retries retain path/ref',async t=>{
  const {repo}=await fixture(t),r=request(repo),s=await prepareWorktree(r,{spaceName:'client-portal',exec});assert.match(s.path,/client-portal-WEB-142$/);assert.equal(s.branch,'mission-control/client-portal-WEB-142');
  const first=await ensureWorktree(r,s,{exec});assert.equal(first.reused,false);
  await fs.writeFile(path.join(first.folder,'uncommitted.txt'),'preserve');
  const retry=await ensureWorktree({...r,source:{...r.source,key:'WEB-999'}},s,{exec});assert.equal(retry.reused,true);assert.equal(retry.folder,first.folder);assert.equal(await fs.readFile(path.join(first.folder,'uncommitted.txt'),'utf8'),'preserve');
  await assert.rejects(ensureWorktree({...r,branch:'changed'},s,{exec}),e=>e.code==='RETRY_CHANGED');
});
test('independent generic intents have distinct captured names and concurrent Git creates are safe',async t=>{
  const {repo}=await fixture(t),a={...request(repo),source:undefined},b={...a,requestId:'request-B',originId:'origin-B'};
  const [x,y]=await Promise.all([prepareWorktree(a,{spaceName:'repo',exec}),prepareWorktree(b,{spaceName:'repo',exec})]);assert.notEqual(x.path,y.path);assert.match(x.path,new RegExp('task-'+requestDigest(a.requestId)+'$'));
  const run=async(r,s)=>{try{return await ensureWorktree(r,s,{exec});}catch(e){if(e.code!=='WORKTREE_BUSY')throw e;return ensureWorktree(r,s,{exec});}};
  const result=await Promise.all([run(a,x),run(b,y)]);assert.notEqual(result[0].folder,result[1].folder);
});
test('existing dirty paths/refs, symlinks and hostile overrides are preserved',async t=>{
  const {repo,root}=await fixture(t),r=request(repo),dirty=path.join(root,'existing');await fs.mkdir(dirty);await fs.writeFile(path.join(dirty,'work'),'user work');
  await assert.rejects(prepareWorktree({...r,worktreePath:dirty},{spaceName:'x',exec}),e=>e.code==='WORKTREE_EXISTS');assert.equal(await fs.readFile(path.join(dirty,'work'),'utf8'),'user work');
  const link=path.join(root,'link');await fs.symlink(dirty,link);await assert.rejects(prepareWorktree({...r,worktreePath:link+'/tree'},{exec}),e=>e.code==='SYMLINK_PATH');
  await assert.rejects(prepareWorktree({...r,branch:'bad..ref'},{exec}));
  await assert.rejects(prepareWorktree({...r,worktree:false,worktreePath:dirty},{exec}),/require a new worktree/);
  await assert.rejects(prepareWorktree({...r,source:{...r.source,key:'../../'}},{exec}),/safe characters/);
  const branch=await exec('git',['-C',repo,'branch','taken']);assert.equal(branch.code,0);await assert.rejects(prepareWorktree({...r,branch:'taken'},{exec}),e=>e.code==='BRANCH_EXISTS');
});
test('a collision appearing after capture is never adopted by another request',async t=>{
  const {repo}=await fixture(t),r=request(repo),s=await prepareWorktree(r,{exec});await fs.mkdir(s.path,{recursive:true});await fs.writeFile(path.join(s.path,'keep'),'safe');await assert.rejects(ensureWorktree(r,s,{exec}),e=>e.code==='WORKTREE_EXISTS');assert.equal(await fs.readFile(path.join(s.path,'keep'),'utf8'),'safe');
});
test('a linked current checkout retains canonical identity and new work starts from its HEAD',async t=>{
  const {repo,root}=await fixture(t),checkout=path.join(root,'linked');
  assert.equal((await exec('git',['-C',repo,'worktree','add','-b','linked',checkout,'HEAD'])).code,0);
  assert.equal((await exec('git',['-C',checkout,'commit','--allow-empty','-qm','Linked-only commit'])).code,0);
  const r={...request(repo),source:undefined,checkoutRoot:checkout,worktree:false};const spec=await prepareWorktree(r,{exec});
  await assert.rejects(prepareWorktree({...r,checkoutRoot:undefined},{exec}),/captured checkoutRoot/);
  const fallback=await prepareWorktree({...request(repo),worktree:false,checkoutRoot:undefined},{exec});assert.equal(fallback.path,repo);
  await assert.rejects(prepareWorktree({...request(repo),checkoutRoot:undefined,source:{...request(repo).source,kind:'invented'}},{exec}),/Unsupported tracker/);
  assert.equal(spec.repoRoot,repo);assert.equal(spec.checkoutRoot,checkout);assert.equal((await ensureWorktree(r,spec,{exec})).folder,checkout);
  const derived=await prepareWorktree({...r,worktree:true},{exec});const head=(await exec('git',['-C',checkout,'rev-parse','HEAD'])).stdout.trim();assert.equal(derived.base,head);
  const other=path.join(root,'other');await fs.mkdir(other);await exec('git',['-C',other,'init','-q']);await assert.rejects(prepareWorktree({...r,checkoutRoot:other},{exec}),e=>e.code==='CHECKOUT_MISMATCH');
});
