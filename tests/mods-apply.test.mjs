import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createSource} from '../src/mods/mission-control-mods/source.mjs';
import {createStore} from '../src/mods/mission-control-mods/store.mjs';
import {checkItem} from '../src/mods/mission-control-mods/updates.mjs';
import {prepare, commit, planKeys, disclose} from '../src/mods/mission-control-mods/apply.mjs';

const ENV = {...process.env, GIT_AUTHOR_NAME: 'QA', GIT_AUTHOR_EMAIL: 'qa@example.invalid', GIT_COMMITTER_NAME: 'QA', GIT_COMMITTER_EMAIL: 'qa@example.invalid'};
const git = (cwd, ...args) => execFileSync('git', args, {cwd, encoding: 'utf8', env: ENV}).trim();
const lines = n => Array.from({length: n}, (_, i) => `line ${i + 1}`).join('\n') + '\n';
async function put(root, files) { for (const [rel, data] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(root, rel)), {recursive: true});await fs.writeFile(path.join(root, rel), data); } }

async function fixture(t, {checkFails = false} = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mc-mods-apply-')));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const repo = path.join(root, 'repo'), home = path.join(root, 'app'), bin = path.join(root, 'herdr-app');
  await fs.mkdir(repo);git(repo, 'init', '-q', '-b', 'main');
  const v1 = {'mods/foo/main.js': lines(20), 'mods/foo/util.js': lines(20), 'mods/foo/icon.png': Buffer.from([0x89, 0x50, 0, 1, 2]), 'mods/foo/old.svg': '<svg/>\n', 'mods/foo/gone.txt': 'bye\n', 'keys.json': JSON.stringify({global: {'ctrl-f': 'foo.open'}})};
  await put(repo, v1);git(repo, 'add', '-A');git(repo, 'commit', '-qm', 'v1');const c1 = git(repo, 'rev-parse', 'HEAD');
  const base = Object.fromEntries(['main.js', 'util.js', 'icon.png', 'old.svg', 'gone.txt'].map(f => [f, git(repo, 'rev-parse', `${c1}:mods/foo/${f}`)]));
  await put(home, Object.fromEntries(Object.entries(v1).filter(([k]) => k.startsWith('mods/'))));
  await put(home, {'mods/foo/gpui-kit.d.ts': 'generated\n', 'keys.json': JSON.stringify({global: {'ctrl-f': 'foo.open', 'ctrl-x': 'mine.cut'}})});
  await fs.writeFile(bin, `#!/bin/sh\n${checkFails ? 'echo "foo failed to render" >&2; exit 1' : 'echo "check passed: $2"'}\n`, {mode: 0o755});
  const source = createSource({appHome: home, env: {...process.env, QA_MODS_FIXTURE: '1'}}), store = createStore({appHome: home});
  const record = {kind: 'mod', name: 'foo', source: {url: 'file://' + repo, fullName: 'fixture/repo', path: '', defaultBranch: 'main'}, commit: c1, base, keysSha: git(repo, 'rev-parse', `${c1}:keys.json`), keys: [{section: 'global', key: 'ctrl-f', action: 'foo.open'}]};
  const upstream = async (files, remove = []) => { await put(repo, files);for (const r of remove) await fs.rm(path.join(repo, r));git(repo, 'add', '-A');git(repo, 'commit', '-qm', 'v2');
    const head = git(repo, 'rev-parse', 'HEAD');return (await checkItem(source, {mods: {entries: [{kind: 'mods', fullName: 'fixture/repo', url: 'file://' + repo, path: '', defaultBranch: 'main', headCommit: head, names: ['foo']}]}, layouts: {entries: []}}, record)).update; };
  const read = rel => fs.readFile(path.join(home, 'mods/foo', rel), 'utf8').catch(() => null);
  return {repo, home, bin, source, store, record, upstream, read};
}

test('local edits merge with upstream changes; unedited removed files go, edited ones stay; generated files are untouched', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.home, 'mods/foo/util.js'), lines(20).replace('line 2\n', 'line 2 mine\n'));
  await fs.writeFile(path.join(f.home, 'mods/foo/old.svg'), '<svg id="mine"/>\n');
  const update = await f.upstream({'mods/foo/util.js': lines(20).replace('line 18\n', 'line 18 theirs\n'), 'mods/foo/main.js': lines(21), 'mods/foo/new.js': 'new\n'}, ['mods/foo/old.svg', 'mods/foo/gone.txt']);
  const prepared = await prepare({appHome: f.home, source: f.source, record: f.record, update, herdrApp: f.bin});
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  assert.deepEqual(prepared.review.changed, ['main.js', 'new.js', 'util.js']);assert.deepEqual(prepared.review.removed, ['gone.txt']);assert.deepEqual(prepared.review.keptEdited, ['old.svg']);
  assert.equal(await f.read('main.js'), lines(20), 'prepare writes nothing to mods/');
  const result = await commit({appHome: f.home, store: f.store, record: f.record});
  assert.equal(result.ok, true);
  const util = await f.read('util.js');assert.match(util, /line 2 mine/);assert.match(util, /line 18 theirs/);
  assert.equal(await f.read('main.js'), lines(21));assert.equal(await f.read('new.js'), 'new\n');
  assert.equal(await f.read('gone.txt'), null);assert.equal(await f.read('old.svg'), '<svg id="mine"/>\n', 'an edited file removed upstream is kept');
  assert.equal(await f.read('gpui-kit.d.ts'), 'generated\n');
  const recorded = (await f.store.readPackages()).packages['mod:foo'];assert.equal(recorded.commit, update.commit);
});

test('a same-line conflict writes nothing and can be resolved either way; an edited binary file is a conflict', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.home, 'mods/foo/main.js'), lines(20).replace('line 5\n', 'line 5 mine\n'));
  await fs.writeFile(path.join(f.home, 'mods/foo/icon.png'), Buffer.from([0x89, 0x50, 0, 9, 9]));
  const update = await f.upstream({'mods/foo/main.js': lines(20).replace('line 5\n', 'line 5 theirs\n'), 'mods/foo/icon.png': Buffer.from([0x89, 0x50, 0, 7, 7])});
  const first = await prepare({appHome: f.home, source: f.source, record: f.record, update, herdrApp: f.bin});
  assert.equal(first.state, 'conflict');assert.deepEqual(first.conflicts, [{file: 'icon.png', binary: true}, {file: 'main.js', binary: false}]);
  assert.match(await fs.readFile(path.join(first.conflictDir, 'main.js'), 'utf8'), /<<<<<<< yours[\s\S]*line 5 mine[\s\S]*line 5 theirs[\s\S]*>>>>>>> upstream/);
  assert.match(await f.read('main.js'), /line 5 mine/, 'nothing written on conflict');
  const resolved = await prepare({appHome: f.home, source: f.source, record: f.record, update, herdrApp: f.bin, resolutions: {'main.js': 'theirs', 'icon.png': 'mine'}});
  assert.equal(resolved.ok, true);await commit({appHome: f.home, store: f.store, record: f.record});
  assert.match(await f.read('main.js'), /line 5 theirs/);
  assert.deepEqual([...await fs.readFile(path.join(f.home, 'mods/foo/icon.png'))], [0x89, 0x50, 0, 9, 9], 'Keep mine keeps the person\'s binary file');
});

test('a failing herdr-app check stops before anything is written', async t => {
  const f = await fixture(t, {checkFails: true});
  const update = await f.upstream({'mods/foo/main.js': lines(22)});
  await assert.rejects(prepare({appHome: f.home, source: f.source, record: f.record, update, herdrApp: f.bin}), error => error.code === 'CHECK_FAILED' && /failed to render/.test(error.message));
  assert.equal(await f.read('main.js'), lines(20));
  await assert.rejects(commit({appHome: f.home, store: f.store, record: f.record}), error => error.code === 'NOT_PREPARED');
});

test('the review discloses newly reached hosts and programs', async t => {
  const f = await fixture(t);
  const update = await f.upstream({'mods/foo/main.js': lines(20) + 'fetch("https://telemetry.example.com/x");exec("curl",["-s"]);\n'});
  const prepared = await prepare({appHome: f.home, source: f.source, record: f.record, update, herdrApp: f.bin});
  assert.deepEqual(prepared.review.access, {hosts: ['telemetry.example.com'], programs: ['curl'], files: false});
  assert.deepEqual(disclose(['readTextFile(x)']).files, true);
});

test('keys: free keys are added, taken keys clash, owned keys change or go only while they still equal what the item set', () => {
  const owned = [{section: 'global', key: 'ctrl-f', action: 'foo.open'}, {section: 'global', key: 'ctrl-g', action: 'foo.go'}];
  const user = {global: {'ctrl-f': 'foo.open', 'ctrl-g': 'someone.else', 'ctrl-x': 'mine.cut'}};
  const plan = planKeys(user, {global: {'ctrl-f': 'foo.open2', 'ctrl-x': 'foo.cut', 'ctrl-h': 'foo.help'}}, owned);
  assert.deepEqual(plan.add.map(k => k.key).sort(), ['ctrl-f', 'ctrl-h'], 'an owned key whose action changed and a free key');
  assert.deepEqual(plan.clash.map(k => k.key), ['ctrl-x'], 'a key the person uses for something else clashes');
  assert.deepEqual(plan.remove, [], 'ctrl-g was rebound by the person, so it is not the item\'s to remove');
  assert.equal(plan.keys.global['ctrl-x'], 'mine.cut');assert.equal(plan.keys.global['ctrl-g'], 'someone.else');
  assert.deepEqual(planKeys({global: {'ctrl-f': 'foo.open'}}, {}, [owned[0]]).remove.map(k => k.key), ['ctrl-f'], 'a dropped owned key is removed while it still equals');
});

test('an update keeps the newest three backups and applies keys with the change', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 4; i++) {
    const update = await f.upstream({'mods/foo/main.js': lines(30 + i), 'keys.json': JSON.stringify({global: {'ctrl-f': 'foo.open', 'ctrl-y': `foo.v${i}`}})});
    const prepared = await prepare({appHome: f.home, source: f.source, record: f.record, update, herdrApp: f.bin});
    assert.equal(prepared.ok, true);let clock = 1000 + i;
    await commit({appHome: f.home, store: f.store, record: f.record, now: () => clock});
    Object.assign(f.record, (await f.store.readPackages()).packages['mod:foo']);
  }
  const backups = await fs.readdir(path.join(f.store.root, 'backup', 'mod-foo'));assert.equal(backups.length, 3);
  const keys = JSON.parse(await fs.readFile(path.join(f.home, 'keys.json'), 'utf8'));
  assert.equal(keys.global['ctrl-y'], 'foo.v3');assert.equal(keys.global['ctrl-x'], 'mine.cut', 'the person\'s own key is untouched');
});
