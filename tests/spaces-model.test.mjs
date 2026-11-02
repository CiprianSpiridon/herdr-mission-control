import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {groupSpaces,capturedSpace,resolveSpaceRepo,launchTarget} from '../src/mods/mission-control-spaces/model.js';
import {resolveSpaceRepo as sharedResolver} from '../src/shared/space-repo.js';
import {resolveBinding,newConfig,bindingKey} from '../src/shared/config.js';
const exec=async(cmd,args,options={})=>{assert.equal(options.on??null,null);const p=spawnSync(cmd,args,{cwd:options.cwd,encoding:'utf8'});if(p.error)throw p.error;return {code:p.status,stdout:p.stdout,stderr:p.stderr};};
async function fixture(t){const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'mc-spaces-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));const repo=async name=>{const r=path.join(root,name);await fs.mkdir(r);for(const args of [['init','-q','-b','main'],['config','user.name','QA'],['config','user.email','qa@example.invalid'],['commit','--allow-empty','-qm','Initial']])assert.equal((await exec('git',['-C',r,...args])).code,0);return r;};return {root,repo};}
const space={id:'space-A',name:'same-name',machine:null,folder:'/stale/original',tabs:[{id:'tab-A'},{id:'tab-B'}]};
const pane=(cwd,id='pane-A',tab='tab-A',focused=false)=>({pane:id,tab,terminal:'t1',cwd,focused});
test('128-space filtering/groups preserve stable IDs, machine keys and collapse state',()=>{
  const spaces=Array.from({length:128},(_,i)=>({id:'space-'+i,name:'repo-'+i,machine:i%3===0?null:i%3===1?'server':'Mac mini',branch:i===53?'feature-login':'main'}));
  const grouped=groupSpaces(spaces,{collapsed:{'["server"]':true}});assert.equal(grouped[0].machine,null);assert.equal(grouped.find(g=>g.machine==='server').collapsed,true);assert.equal(grouped.flatMap(g=>g.spaces).length,128);
  assert.equal(groupSpaces(spaces,{query:'feature-login'})[0].spaces[0].id,'space-53');assert.equal(capturedSpace(spaces,'space-53',null),null);assert.equal(capturedSpace(spaces,'space-53','Mac mini').id,'space-53');
});
test('live linked-worktree cwd preserves canonical binding and selected execution root',async t=>{
  assert.equal(resolveSpaceRepo,sharedResolver);const {root,repo}=await fixture(t),main=await repo('main'),linked=root+'/linked';assert.equal((await exec('git',['-C',main,'worktree','add','-b','linked',linked,'HEAD'])).code,0);
  const resolved=await resolveSpaceRepo(space,[pane(linked)],exec);assert.equal(resolved.state,'resolved');assert.equal(resolved.repoRoot,main);assert.equal(resolved.worktreeRoot,linked);assert.equal(resolved.finderPath,linked);assert.equal(launchTarget(resolved).checkoutRoot,linked);
  const config=newConfig(),key=bindingKey(null,main);config.bindings[key]={machine:null,repoRoot:main};assert.equal(resolveBinding(config,resolved).repoRoot,main);
});
test('unfocused conflicting repos are ambiguous, focused pane wins, and other spaces never participate',async t=>{
  const {repo}=await fixture(t),a=await repo('A'),b=await repo('B'),panes=[pane(a),pane(b,'pane-B','tab-B')];
  const ambiguous=await resolveSpaceRepo(space,panes,exec);assert.equal(ambiguous.state,'ambiguous');assert.equal(ambiguous.candidates.length,2);assert.throws(()=>launchTarget(ambiguous),/Focus/);
  assert.equal((await resolveSpaceRepo({...space,active:false},[{...panes[0],focused:true},panes[1]],exec)).state,'ambiguous');
  const focused=await resolveSpaceRepo(space,[panes[0],{...panes[1],focused:true},pane(a,'outside','other-space',true)],exec);assert.equal(focused.repoRoot,b);assert.equal(focused.paneId,'pane-B');
});
test('same-common-directory panes choose native order; missing repo/host never uses creation folder',async t=>{
  const {root,repo}=await fixture(t),a=await repo('A'),linked=root+'/linked';await exec('git',['-C',a,'worktree','add','-b','linked',linked]);
  const r=await resolveSpaceRepo(space,[pane(linked),pane(a,'p2','tab-B')],exec);assert.equal(r.worktreeRoot,linked);
  assert.equal((await resolveSpaceRepo({...space,folder:a},[],exec)).state,'unbound');
  assert.equal((await resolveSpaceRepo({...space,folder:a},[pane(root)],exec)).state,'unbound');
  let calls=0;const offline=await resolveSpaceRepo({...space,machine:'server'},[pane('/repo')],async(_cmd,_args,opts)=>{calls++;assert.equal(opts.on,'server');throw Error('offline');});assert.equal(offline.state,'error');assert.equal(calls,1);
});
test('remote Finder uses only an explicit validated local mount and never a remote-looking local path',async t=>{
  const {root}=await fixture(t);const remoteExec=async(cmd,args,opts)=>{
    if(cmd==='python3'){assert.equal(opts,undefined);return exec(cmd,args);}
    assert.equal(opts.on,'server');const part=args.at(-1);return {code:0,stdout:part==='--show-toplevel'?'/srv/repo\n':part==='--git-common-dir'?'/srv/repo/.git\n':'worktree /srv/repo\0HEAD abc\0branch refs/heads/main\0\0'};
  };
  const remote={...space,machine:'server'},panes=[pane('/srv/repo')];assert.equal((await resolveSpaceRepo(remote,panes,remoteExec)).finderPath,null);
  assert.equal((await resolveSpaceRepo(remote,panes,remoteExec,{mountedLocalPath:root})).finderPath,root);
  const missing=await resolveSpaceRepo(remote,panes,remoteExec,{mountedLocalPath:root+'/missing'});assert.equal(missing.finderPath,null);assert.match(missing.finderReason,/unavailable/);
});
