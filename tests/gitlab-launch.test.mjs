import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {launch,validateLaunchRequest} from '../src/shared/launch.js';
import {prepareWorktree,ensureWorktree} from '../src/shared/worktrees.js';

const run=promisify(execFile),site='https://git.example.test';
const source=kind=>({kind,connectionId:'gitlab-work',site,id:'9007199254740993',key:kind==='gitlab-mr'?'GL-MR-42':'GL-42',title:'Repair request tracing',url:site+'/group/sub/project/-/'+(kind==='gitlab-mr'?'merge_requests':'issues')+'/42',body:'Keep source text as data; `$(not a command)`.'});
const request=(repoRoot,kind='gitlab')=>({requestId:'request-'+kind,idempotencyKey:'intent-'+kind,originId:'origin-'+kind,spaceId:'space-A',machine:null,repoRoot,checkoutRoot:repoRoot,toolKey:'claude',worktree:true,source:source(kind)});
async function command(cmd,args,options={}){try{const r=await run(cmd,args,{cwd:options.cwd,maxBuffer:1024*1024});return {code:0,stdout:r.stdout,stderr:r.stderr};}catch(e){return {code:Number.isInteger(e.code)?e.code:1,stdout:e.stdout||'',stderr:e.stderr||''};}}
async function fixture(t){
  const root=await fs.realpath(await fs.mkdtemp('/private/tmp/mc-gitlab-launch-')),repo=path.join(root,'repo'),calls=[];t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(repo);
  for(const args of [['init','-q','-b','main'],['config','user.name','Fixture'],['config','user.email','fixture@example.invalid'],['config','commit.gpgsign','false'],['commit','--allow-empty','-qm','Create fixture']])assert.equal((await command('git',['-C',repo,...args])).code,0);
  const exec=(cmd,args,options={})=>{assert.equal(options.on??null,null);calls.push({cmd,args,options});return command(cmd,args,options);};return {root,repo,calls,exec};
}

test('launch requests accept both GitLab kinds with nested source URLs without changing global identity or legacy kinds',()=>{
  for(const kind of ['gitlab','gitlab-mr']){const raw=request('/fixture/repo',kind),checked=validateLaunchRequest(raw);assert.deepEqual(checked.source,raw.source);assert.equal(checked.source.id,'9007199254740993');assert.equal(checked.source.key,kind==='gitlab'?'GL-42':'GL-MR-42');checked.source.title='Changed clone';assert.equal(raw.source.title,'Repair request tracing');}
  for(const kind of ['jira','github','github-pr']){const raw=request('/fixture/repo'),number=kind==='jira'?'WEB-42':kind==='github'?'GH-42':'GH-PR-42';raw.source={...raw.source,kind,connectionId:'work',site:'https://example.test',id:kind==='github-pr'?'acme/web#42':'10142',key:number,url:'https://example.test/'+(kind==='jira'?'browse/WEB-42':kind==='github'?'Acme/Web/issues/42':'Acme/Web/pull/42')};assert.equal(validateLaunchRequest(raw).source.kind,kind);}
});

test('real GitLab issue and MR worktrees use human keys for names and retain decimal global IDs for ownership and retry',async t=>{
  const f=await fixture(t),paths=[];
  for(const kind of ['gitlab','gitlab-mr']){const raw=request(f.repo,kind),checked=validateLaunchRequest(raw),spec=await prepareWorktree(checked,{spaceName:'client-portal',exec:f.exec});assert.equal(path.basename(spec.path),'client-portal-'+raw.source.key);assert.equal(spec.branch,'mission-control/client-portal-'+raw.source.key);assert.deepEqual(JSON.parse(spec.sourceKey),[kind,'gitlab-work',site,'9007199254740993']);assert.ok(spec.path.startsWith(f.root+path.sep));const created=await ensureWorktree(checked,spec,{exec:f.exec});assert.equal(created.reused,false);assert.equal((await ensureWorktree(checked,spec,{exec:f.exec})).reused,true);paths.push(created.folder);
    const count=f.calls.length;await assert.rejects(ensureWorktree({...checked,source:{...checked.source,id:'42'}},spec,{exec:f.exec}),e=>e.code==='RETRY_CHANGED');assert.equal(f.calls.length,count,'a changed global identity is rejected before target-host execution');}
  assert.notEqual(paths[0],paths[1]);assert.ok(f.calls.every(c=>!c.args.some(arg=>String(arg).includes('not a command'))));
});

test('unknown kind, non-HTTPS origins and credential-bearing URLs reject before launch IO or any worktree helper command',async()=>{
  for(const kind of ['gitlab','gitlab-mr'])for(const change of [{kind:'invented'},{site:'http://git.example.test'},{site:'https://user:password@git.example.test'},{url:'http://git.example.test/group/project/-/issues/42'},{url:'https://user:password@git.example.test/group/project/-/issues/42'},{url:undefined}]){
    const raw=request('/fixture/repo',kind);raw.source={...raw.source,...change};let accesses=0,commands=0;const io=new Proxy({},{get(){accesses++;throw Error('Invalid requests may not access launch IO');}}),exec=async()=>{commands++;throw Error('Invalid sources may not run target-host commands');};const result=await launch(raw,io);assert.equal(result.ok,false);assert.equal(result.code,'INVALID_LAUNCH');assert.equal(accesses,0);await assert.rejects(prepareWorktree(raw,{spaceName:'repo',exec}),e=>e.code==='INVALID_WORKTREE');await assert.rejects(ensureWorktree(raw,{}, {exec}),e=>e.code==='INVALID_WORKTREE');assert.equal(commands,0);assert.ok(!result.message.includes('password'));
  }
});

test('existing GitHub PR worktree identity and legacy source-only callers remain compatible',async t=>{
  const f=await fixture(t),raw=request(f.repo);raw.source={kind:'github-pr',connectionId:'work',site:'https://github.com',id:'acme/web#9',key:'GH-PR-9',title:'Review pull request',url:'https://github.com/acme/web/pull/9'};const checked=validateLaunchRequest(raw),spec=await prepareWorktree(checked,{spaceName:'client-portal',exec:f.exec});assert.equal(path.basename(spec.path),'client-portal-GH-PR-9');assert.deepEqual(JSON.parse(spec.sourceKey),['github-pr','work','https://github.com','acme/web#9']);assert.equal((await ensureWorktree(checked,spec,{exec:f.exec})).reused,false);
  const legacy={...raw,requestId:'legacy-request',originId:'legacy-origin',worktree:false,source:{kind:'jira',connectionId:'work',site:'https://jira.example.test',id:'1001',key:'WEB-1'}};assert.equal((await prepareWorktree(legacy,{exec:f.exec})).path,f.repo);
});
