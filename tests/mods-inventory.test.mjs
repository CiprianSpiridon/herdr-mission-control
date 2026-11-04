import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createSource} from '../src/mods/mission-control-mods/source.mjs';
import {scan, adopt, gitBlobSha, hashTree, layoutMods} from '../src/mods/mission-control-mods/inventory.mjs';

const ENV = {...process.env, GIT_AUTHOR_NAME: 'QA', GIT_AUTHOR_EMAIL: 'qa@example.invalid', GIT_COMMITTER_NAME: 'QA', GIT_COMMITTER_EMAIL: 'qa@example.invalid'};
const git = (cwd, ...args) => execFileSync('git', args, {cwd, encoding: 'utf8', env: ENV}).trim();
async function write(root, files) { for (const [rel, text] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(root, rel)), {recursive: true});await fs.writeFile(path.join(root, rel), text); } }
async function commit(repo, files, message) { await write(repo, files);git(repo, 'add', '-A');git(repo, 'commit', '-qm', message);return git(repo, 'rev-parse', 'HEAD'); }

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mc-mods-inventory-')));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const a = path.join(root, 'repo-a'), b = path.join(root, 'repo-b'), home = path.join(root, 'app');
  for (const repo of [a, b]) { await fs.mkdir(repo);git(repo, 'init', '-q', '-b', 'main'); }
  const barOld = await commit(a, {'mods/foo/main.js': 'foo 1\n', 'mods/bar/main.js': 'bar 1\n', 'mods/baz/main.js': 'baz 1\n', 'mods/baz/mod.json': '{}\n', 'mods/dup/main.js': 'dup A\n',
    'layouts/lay.json': '{"content":{"mod":"laymod"}}\n', 'mods/laymod/main.js': 'laymod 1\n'}, 'First');
  await commit(a, {'mods/bar/main.js': 'bar 2\n', 'mods/foo/main.js': 'foo 2\n'}, 'Second');
  await commit(b, {'pkg/mods/dup/main.js': 'dup B\n'}, 'B first');
  const catalogs = {
    mods: {entries: [
      {kind: 'mods', fullName: 'fixture/repo-a', url: 'file://' + a, defaultBranch: 'main', path: '', names: ['foo', 'bar', 'baz', 'dup'], previewUrl: null},
      {kind: 'mods', fullName: 'fixture/repo-b', url: 'file://' + b, defaultBranch: 'main', path: 'pkg', names: ['dup'], previewUrl: null}]},
    layouts: {entries: [{kind: 'layouts', fullName: 'fixture/repo-a', url: 'file://' + a, defaultBranch: 'main', path: '', names: ['lay'], previewUrl: null}]}
  };
  await write(home, {
    'installed.json': JSON.stringify({menu: {'main.js': 'x'}, 'layout:main': {json: 'x'}}),
    'mods/menu/main.js': 'shipped\n', 'layouts/main.json': '{}\n',
    'mods/mine/main.js': 'personal\n', 'mods/mine/mod.json': JSON.stringify({cloned_from: {name: 'menu', version: '1'}}),
    'mods/mission-control-agents/main.js': 'mc\n', 'mission-control/installed-packages.json': JSON.stringify({v: 1, packages: {'mission-control': {mods: ['mission-control-agents'], layouts: ['mission-control']}}}),
    'mods/mission-control-mods/main.js': 'self\n',
    'mods/foo/main.js': 'foo 2\n', 'mods/foo/gpui-kit.d.ts': 'generated\n', 'mods/foo/jsconfig.json': '{}',
    'mods/bar/main.js': 'bar 1\n',
    'mods/baz/main.js': 'baz 1 edited\n', 'mods/baz/mod.json': '{}\n',
    'mods/dup/main.js': 'dup edited\n',
    'mods/zzz/main.js': 'unknown\n',
    'mission-control/mods/disabled/mods/off/main.js': 'off\n',
    'layouts/lay.json': '{"content":{"mod":"laymod"}}\n', 'mods/laymod/main.js': 'laymod 1\n'
  });
  const source = createSource({appHome: home, env: {...process.env, QA_MODS_FIXTURE: '1'}});
  return {root, a, b, home, catalogs, source, barOld};
}

test('git blob hashes match git itself, and generated helper files are not part of an item', async t => {
  const f = await fixture(t);
  assert.equal(gitBlobSha(Buffer.from('foo 2\n')), git(f.a, 'rev-parse', 'HEAD:mods/foo/main.js'));
  assert.deepEqual(Object.keys(await hashTree(path.join(f.home, 'mods/foo'))), ['main.js']);
  assert.deepEqual(layoutMods({children: [{content: {mod: 'x'}}, {terminal_menu: 'y'}]}), ['x', 'y']);
});

test('every installed item is classified, and only user items are ever adopted', async t => {
  const f = await fixture(t), {items} = await scan(f.home), by = Object.fromEntries(items.map(i => [i.key, i]));
  assert.equal(by['mod:menu'].origin, 'builtin');assert.equal(by['layout:main'].origin, 'builtin');
  assert.equal(by['mod:mine'].origin, 'clone');
  assert.equal(by['mod:mission-control-agents'].origin, 'installer');assert.equal(by['mod:mission-control-agents'].installerPackage, 'mission-control');
  assert.equal(by['mod:mission-control-mods'].origin, 'self');
  assert.equal(by['mod:off'].disabled, true);assert.equal(by['mod:off'].origin, 'user');
  for (const name of ['foo', 'bar', 'baz', 'dup', 'zzz', 'laymod']) assert.equal(by['mod:' + name].origin, 'user', name);
  assert.deepEqual(by['layout:lay'].mods, ['laymod']);
});

test('adoption finds the exact commit, an older commit, edits, ambiguity and unknown items', async t => {
  const f = await fixture(t), {items} = await scan(f.home), by = Object.fromEntries(items.map(i => [i.key, i]));
  const foo = await adopt(f.source, f.catalogs, by['mod:foo']);
  assert.equal(foo.state, 'current');assert.equal(foo.source.fullName, 'fixture/repo-a');assert.equal(foo.subject, 'Second');
  const bar = await adopt(f.source, f.catalogs, by['mod:bar']);
  assert.equal(bar.state, 'current');assert.equal(bar.commit, f.barOld, 'an older install records the commit it matches, not HEAD');
  const baz = await adopt(f.source, f.catalogs, by['mod:baz']);
  assert.equal(baz.state, 'edited');assert.deepEqual(baz.edited, ['main.js']);
  const dup = await adopt(f.source, f.catalogs, by['mod:dup']);
  assert.equal(dup.state, 'ambiguous');assert.deepEqual(dup.candidates.map(c => c.fullName).sort(), ['fixture/repo-a', 'fixture/repo-b']);
  const dupKnown = await adopt(f.source, f.catalogs, by['mod:dup'], {previous: {source: {fullName: 'fixture/repo-b'}}});
  assert.equal(dupKnown.state, 'edited');assert.equal(dupKnown.source.path, 'pkg', 'the recorded repository breaks the tie, nested path included');
  assert.equal((await adopt(f.source, f.catalogs, by['mod:zzz'])).state, 'untracked');
  const lay = await adopt(f.source, f.catalogs, by['layout:lay']);assert.equal(lay.state, 'current');
  const laymod = await adopt(f.source, f.catalogs, by['mod:laymod'], {layoutsUsing: ['lay']});
  assert.equal(laymod.state, 'current', 'a mod that ships inside a layout entry is matched through the layout that uses it');
  assert.equal((await adopt(f.source, f.catalogs, by['mod:laymod'])).state, 'untracked', 'without a using layout no layout repository is searched');
});
