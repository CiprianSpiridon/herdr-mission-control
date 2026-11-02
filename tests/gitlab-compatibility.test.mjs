import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {newConfig,bindingKey,validateConfig} from '../src/shared/config.js';
import {selectTracker,allTrackerBindings,trackerScopeKey} from '../src/shared/tracker-model.js';
import {PACKAGES,reconcilePackage} from '../scripts/verify-gitlab-compatibility.mjs';

const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex'),copy=value=>JSON.parse(JSON.stringify(value));

test('one repository binding carrying Jira, GitHub and GitLab keeps every selection, scope and account independent',()=>{
  const repoRoot='/repos/client-portal',c=newConfig();
  c.connections={jira:{id:'jira',kind:'api',site:'https://acme.atlassian.net',auth:{kind:'bearer',tokenEnv:'JIRA_TOKEN'}},hub:{id:'hub',kind:'github',site:'https://github.com',apiBase:'https://api.github.com',credentialEnv:'GH_TOKEN'},lab:{id:'lab',kind:'api',site:'https://gitlab.example',auth:{kind:'bearer',tokenEnv:'GL_TOKEN'}}};
  c.bindings={[bindingKey(null,repoRoot)]:{machine:null,repoRoot,jira:{connectionId:'jira',project:'WEB'},github:{connectionId:'hub',owner:'acme',repo:'client-portal'},gitlab:{connectionId:'lab',projectPath:'group/web',status:{labels:{todo:['triage'],inProgress:['doing'],done:['shipped']}}}}};
  const saved=validateConfig(copy(c)),resolved={state:'resolved',machine:null,repoRoot};assert.deepEqual(saved.bindings,c.bindings);
  const picks=Object.fromEntries(['jira','github','github-pr','gitlab','gitlab-mr'].map(source=>[source,selectTracker(saved,resolved,source)]));
  assert.equal(picks.jira.connection.id,'jira');assert.equal(picks.github.connection.id,'hub');assert.equal(picks.gitlab.connection.id,'lab');assert.deepEqual(picks.gitlab.binding.gitlab.status.labels.inProgress,['doing']);
  assert.equal(picks.jira.binding.jira.project,'WEB');assert.equal(picks.github.binding.github.repo,'client-portal');assert.equal(picks.gitlab.binding.gitlab.projectPath,'group/web');
  const keys=Object.values(picks).map(p=>trackerScopeKey(p.scope));assert.equal(new Set(keys).size,keys.length,'Every source and PR/MR view has its own scope fingerprint');
  for(const source of ['jira','github','gitlab'])assert.equal(allTrackerBindings(saved,source).length,1);
  const withoutJira=copy(saved);delete withoutJira.bindings[bindingKey(null,repoRoot)].jira;delete withoutJira.connections.jira;assert.equal(selectTracker(withoutJira,resolved,'jira'),null);assert.equal(trackerScopeKey(selectTracker(withoutJira,resolved,'gitlab').scope),trackerScopeKey(picks.gitlab.scope));
});

async function packageFixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mc-gitlab-compat-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const pkg=PACKAGES[0],mod=path.join(root,pkg.name,'mods',pkg.name);
  await fs.mkdir(mod,{recursive:true});await fs.mkdir(path.join(root,'src/shared'),{recursive:true});await fs.mkdir(path.join(root,'evidence/native'),{recursive:true});await fs.mkdir(path.join(root,'.browse'),{recursive:true});
  const artifact=Buffer.from('export default 1;\n'),source=Buffer.from('export const shared=1;\n'),preview=Buffer.from('89504e470d0a1a0a','hex');
  await fs.writeFile(path.join(mod,'main.js'),artifact);await fs.writeFile(path.join(root,'src/shared/config.js'),source);await fs.writeFile(path.join(root,pkg.name,'preview.png'),preview);
  const manifest={artifacts:{'main.js':sha(artifact)},sources:{'src/shared/config.js':sha(source)}};await fs.writeFile(path.join(root,pkg.name,'build-manifest.json'),JSON.stringify(manifest));
  const receipt={v:2,ok:true,completedMs:1,packages:[{name:pkg.name,nativeCheck:true,manifest}],frames:[{label:pkg.scenario+'-preview',sha256:sha(preview)}]};
  const write=value=>fs.writeFile(path.join(root,'evidence/native',pkg.scenario+'.json'),JSON.stringify(value));await write(receipt);
  return {root,pkg,mod,receipt,manifest,write,validate:async()=>true};
}

test('reconciliation accepts only a passed isolated receipt at current manifest, artifact, source and preview bytes',async t=>{
  const f=await packageFixture(t);assert.deepEqual(await reconcilePackage(f.pkg,{root:f.root,validate:f.validate}),{name:f.pkg.name,scenario:f.pkg.scenario,ok:true,reasons:[],receiptCompletedMs:1,previewSha256:f.receipt.frames[0].sha256});
  assert.deepEqual((await reconcilePackage(f.pkg,{root:f.root,validate:async()=>{throw Error('foreign core');}})).reasons,['UNPROVEN_ISOLATION']);
  await fs.writeFile(path.join(f.root,'src/shared/config.js'),'export const shared=2;\n');assert.deepEqual((await reconcilePackage(f.pkg,{root:f.root,validate:f.validate})).reasons,['SOURCE_MISMATCH'],'A historical success never covers changed runtime source bytes');
});

test('failed, stale or mismatched gates stay failed and never reuse a historical success',async t=>{
  const f=await packageFixture(t),check=async()=>(await reconcilePackage(f.pkg,{root:f.root,validate:f.validate})).reasons;
  await f.write({...f.receipt,ok:false});assert.deepEqual(await check(),['FAILED_RECEIPT']);
  await f.write({...f.receipt,packages:[{name:f.pkg.name,nativeCheck:true,manifest:{...f.manifest,artifacts:{'main.js':'0'.repeat(64)}}}]});assert.deepEqual(await check(),['STALE_MANIFEST']);
  await f.write(f.receipt);await fs.writeFile(path.join(f.mod,'main.js'),'export default 2;\n');assert.deepEqual(await check(),['ARTIFACT_MISMATCH']);
  await fs.writeFile(path.join(f.mod,'main.js'),'export default 1;\n');await fs.writeFile(path.join(f.root,f.pkg.name,'preview.png'),'not the native frame');assert.deepEqual(await check(),['PREVIEW_MISMATCH']);
  await fs.rm(path.join(f.root,'evidence/native',f.pkg.scenario+'.json'));assert.deepEqual(await check(),['MISSING_RECEIPT']);
  assert.deepEqual(PACKAGES.map(p=>p.scenario),['agent-menu','spaces','agents','jira','github']);
});
