import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {handle} from '../src/mods/mission-control-control-panel/backend.mjs';

const git = (cwd, ...args) => execFileSync('git', args, {cwd, encoding: 'utf8', env: {...process.env,
  GIT_AUTHOR_NAME: 'QA', GIT_AUTHOR_EMAIL: 'qa@example.invalid', GIT_COMMITTER_NAME: 'QA', GIT_COMMITTER_EMAIL: 'qa@example.invalid'}}).trim();
const write = async (file, data) => { await fs.mkdir(path.dirname(file), {recursive: true});await fs.writeFile(file, data); };

test('installed bundle layouts, mods and Control panel adopt, detect and apply their own updates', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mc-managed-')));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const repo = path.join(root, 'upstream'), home = path.join(root, 'app'), catalog = path.join(root, 'catalog');
  await fs.mkdir(repo);git(repo, 'init', '-q', '-b', 'main');
  const names = ['mission-control-agents', 'mission-control-control-panel'];
  const files = Object.fromEntries(names.map(n => [`mods/${n}/main.js`, `// ${n} v1\n`]));
  files['layouts/mission-control.json'] = '{"content":{"mod":"mission-control-agents"}}\n';
  for (const [rel, bytes] of Object.entries(files)) {
    await write(path.join(repo, 'mission-control', rel), bytes);
    await write(path.join(home, rel), bytes);
  }
  // Identical standalone and bundle publications in the same repository must keep the installer's bundle source.
  await write(path.join(repo, 'mission-control-agents/mods/mission-control-agents/main.js'), files['mods/mission-control-agents/main.js']);
  git(repo, 'add', '.');git(repo, 'commit', '-qm', 'Initial bundle');
  await write(path.join(home, 'mission-control/installed-packages.json'), JSON.stringify({v: 1, packages: {'mission-control': {mods: names, layouts: ['mission-control']}}}));
  await write(path.join(home, 'installed.json'), JSON.stringify({menu: {}}));
  await write(path.join(home, 'mods/menu/main.js'), '// builtin\n');
  const entry = {fullName: 'fixture/upstream', url: 'file://' + repo, path: 'mission-control', defaultBranch: 'main'};
  await write(path.join(catalog, 'mods.json'), JSON.stringify({mods: [{...entry, path: 'mission-control-agents', modNames: ['mission-control-agents']}]}));
  await write(path.join(catalog, 'layouts.json'), JSON.stringify({layouts: [{...entry, layoutFiles: ['mission-control/layouts/mission-control.json']}]}));
  const env = {...process.env, QA_MODS_FIXTURE: '1', QA_MODS_CATALOG_URL: 'file://' + catalog + '/{kind}.json'};
  const call = (op, extra = {}) => handle({appHome: home, activeLayout: 'mission-control', op, ...extra}, {env});
  // Supply a layout reference to the panel, as the real bundle does, for catalog matching.
  const layout = JSON.stringify({children: names.map(mod => ({content: {mod}}))}) + '\n';
  await write(path.join(repo, 'mission-control/layouts/mission-control.json'), layout);
  await write(path.join(home, 'layouts/mission-control.json'), layout);
  git(repo, 'add', '.');git(repo, 'commit', '-qm', 'Include panel');
  const initial = await call('check');
  for (const key of ['layout:mission-control', ...names.map(n => 'mod:' + n)]) {
    const item = initial.list.find(i => i.key === key);
    assert.equal(item.state, 'current', key);
    assert.equal(item.source.path, 'mission-control', 'adoption retains the installed bundle source');
  }
  assert.equal(initial.list.find(i => i.name === 'menu').state, 'builtin');
  const changed = {...files, 'layouts/mission-control.json': layout.replace('"children"', '"theme":"graphite","children"')};
  for (const n of names) changed[`mods/${n}/main.js`] = `// ${n} v2\n`;
  for (const [rel, bytes] of Object.entries(changed)) await write(path.join(repo, 'mission-control', rel), bytes);
  git(repo, 'add', '.');git(repo, 'commit', '-qm', 'Update bundle');
  const checked = await call('check');
  const checker = path.join(root, 'herdr-check');await write(checker, '#!/bin/sh\nexit 0\n');await fs.chmod(checker, 0o755);
  for (const key of ['layout:mission-control', ...names.map(n => 'mod:' + n)]) {
    assert.equal(checked.list.find(i => i.key === key).state, 'update', key + ' exposes its update');
    const before = await fs.readFile(path.join(home, key.startsWith('mod:') ? `mods/${key.slice(4)}/main.js` : 'layouts/mission-control.json'), 'utf8');
    const prepared = await handle({appHome: home, op: 'prepare', key}, {env, herdrApp: checker});
    assert.equal(prepared.prepared.ok, true);
    assert.equal(await fs.readFile(path.join(home, key.startsWith('mod:') ? `mods/${key.slice(4)}/main.js` : 'layouts/mission-control.json'), 'utf8'), before, 'prepare leaves installed code unchanged');
    await call('commit', {key});
  }
  for (const [rel, bytes] of Object.entries(changed)) assert.equal(await fs.readFile(path.join(home, rel), 'utf8'), bytes);
  for (const item of (await call('check')).list.filter(i => i.origin !== 'builtin')) assert.equal(item.state, 'current');
  await assert.rejects(call('uninstall', {key: 'mod:mission-control-control-panel'}), e => e.code === 'SELF');
  await assert.rejects(call('disable', {key: 'mod:mission-control-agents'}), e => e.code === 'INSTALLER_MANAGED');
});
