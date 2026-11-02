import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {buildPackage} from '../scripts/project.mjs';

const name='mission-control-gitlab-icon-fixture';
const keys=['gitlab','jira','github','pull-request'];
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mission-gitlab-icon-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const source=path.join(root,'src/mods',name);
  await fs.mkdir(source,{recursive:true});
  await fs.mkdir(path.join(root,'src/assets'),{recursive:true});
  await fs.writeFile(path.join(source,'main.js'),'export default class Panel {}\n');
  await fs.writeFile(path.join(source,'mod.json'),JSON.stringify({title:'Icon fixture',place:'none',build:{assets:keys}}));
  const catalog=JSON.parse(await fs.readFile(new URL('../src/assets/icons.json',import.meta.url),'utf8'));
  const file=path.join(root,'src/assets/icons.json');
  await fs.writeFile(file,JSON.stringify(catalog));
  return {root,catalog,file};
}

test('the actual standalone builder materializes original GitLab and existing tracker icons',async t=>{
  const {root,catalog}=await fixture(t);
  assert.equal(catalog.gitlab.source,'Original Mission Control artwork');
  assert.equal(catalog.gitlab.license,'MIT');
  const result=await buildPackage(name,{root});
  for(const key of keys){
    assert.equal(await fs.readFile(path.join(result.directory,'assets',key+'.svg'),'utf8'),catalog[key].svg+'\n');
    assert.ok(result.manifest.artifacts['assets/'+key+'.svg']);
  }
  assert.match(await fs.readFile(path.join(result.directory,'NOTICE.md'),'utf8'),/gitlab: Original Mission Control artwork; MIT/);
});

test('the same builder rejects external SVG URLs and missing licenses without replacing good assets',async t=>{
  const {root,catalog,file}=await fixture(t);
  const good=await buildPackage(name,{root});
  const iconFile=path.join(good.directory,'assets/gitlab.svg');
  const before=await fs.readFile(iconFile);
  const original=catalog.gitlab.svg;
  catalog.gitlab.svg='<svg><image href="https://example.invalid/remote.svg"/></svg>';
  await fs.writeFile(file,JSON.stringify(catalog));
  await assert.rejects(buildPackage(name,{root}),/Unsafe or malformed SVG: gitlab/);
  assert.deepEqual(await fs.readFile(iconFile),before);
  catalog.gitlab.svg=original;
  delete catalog.gitlab.license;
  await fs.writeFile(file,JSON.stringify(catalog));
  await assert.rejects(buildPackage(name,{root}),/Icon lacks artwork\/provenance: gitlab/);
  assert.deepEqual(await fs.readFile(iconFile),before);
});
