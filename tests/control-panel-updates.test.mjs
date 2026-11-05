import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createSource} from '../src/mods/mission-control-control-panel/source.mjs';
import {checkItem} from '../src/mods/mission-control-control-panel/updates.mjs';

const ENV = {...process.env, GIT_AUTHOR_NAME: 'QA', GIT_AUTHOR_EMAIL: 'qa@example.invalid', GIT_COMMITTER_NAME: 'QA', GIT_COMMITTER_EMAIL: 'qa@example.invalid'};
const git = (cwd, ...args) => execFileSync('git', args, {cwd, encoding: 'utf8', env: ENV}).trim();
async function commit(repo, files, message, remove = []) {
  for (const [rel, text] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(repo, rel)), {recursive: true});await fs.writeFile(path.join(repo, rel), text); }
  for (const rel of remove) await fs.rm(path.join(repo, rel));
  git(repo, 'add', '-A');git(repo, 'commit', '-qm', message);return git(repo, 'rev-parse', 'HEAD');
}

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mc-mods-updates-')));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const repo = path.join(root, 'repo'), home = path.join(root, 'app');await fs.mkdir(repo);await fs.mkdir(home);git(repo, 'init', '-q', '-b', 'main');
  const first = await commit(repo, {'mods/foo/main.js': 'one\n', 'mods/foo/old.svg': '<svg/>\n'}, 'Add foo');
  const real = createSource({appHome: home, env: {...process.env, QA_MODS_FIXTURE: '1'}});
  let ensures = 0, remotes = 0, offline = false;
  const source = {...real, ensure: async url => { ensures++;return offline ? {state: 'unreachable', reason: 'offline'} : real.ensure(url); }, lsRemote: async (...a) => { remotes++;return offline ? null : real.lsRemote(...a); }};
  const sha = rel => git(repo, 'rev-parse', `${first}:mods/foo/${rel}`);
  const record = {kind: 'mod', name: 'foo', source: {url: 'file://' + repo, fullName: 'fixture/repo', path: '', defaultBranch: 'main'}, commit: first, base: {'main.js': sha('main.js'), 'old.svg': sha('old.svg')}};
  const catalogs = head => ({mods: {entries: [{kind: 'mods', fullName: 'fixture/repo', url: 'file://' + repo, path: '', defaultBranch: 'main', headCommit: head, names: ['foo']}]}, layouts: {entries: []}});
  return {repo, record, catalogs, source, first, ensures: () => ensures, remotes: () => remotes, setOffline: v => { offline = v; }};
}

test('a commit outside the item is not an update; changed, added and removed files are', async t => {
  const f = await fixture(t);
  const docs = await commit(f.repo, {'README.md': 'docs\n'}, 'Docs only');
  const quiet = await checkItem(f.source, f.catalogs(docs), f.record);
  assert.equal(quiet.state, 'current', 'a repository commit elsewhere is not an update');assert.equal(quiet.headCommit, docs);
  const next = await commit(f.repo, {'mods/foo/main.js': 'two\n', 'mods/foo/new.svg': '<svg id="n"/>\n'}, 'Improve foo', ['mods/foo/old.svg']);
  const result = await checkItem(f.source, f.catalogs(next), f.record);
  assert.equal(result.state, 'update');assert.equal(result.update.commit, next);assert.equal(result.update.subject, 'Improve foo');
  assert.deepEqual([result.update.changed, result.update.added, result.update.removed], [['main.js'], ['new.svg'], ['old.svg']]);
});

test('an unchanged catalog headCommit costs no fetch; offline keeps the last result with its reason', async t => {
  const f = await fixture(t), head = git(f.repo, 'rev-parse', 'HEAD');
  const lastResult = {state: 'current', headCommit: head};
  const before = f.ensures();
  assert.deepEqual(await checkItem(f.source, f.catalogs(head), {...f.record, headCommit: head, lastResult}), {...lastResult, headCommit: head});
  assert.equal(f.ensures(), before, 'no git fetch for an unchanged catalog head');
  f.setOffline(true);
  const off = await checkItem(f.source, f.catalogs('ffffffffffffffffffffffffffffffffffffffff'), {...f.record, headCommit: head, lastResult});
  assert.equal(off.state, 'unreachable');assert.equal(off.reason, 'offline');assert.equal(off.headCommit, head, 'the last known head is kept');
});

test('an item adopted from a pasted link is re-checked with git ls-remote', async t => {
  const f = await fixture(t), linked = {...f.record, linked: true};
  const first = await checkItem(f.source, f.catalogs(null), linked);
  assert.equal(first.state, 'current');assert.equal(first.remoteHead, f.first);assert.equal(f.remotes(), 1);
  const ensures = f.ensures();
  const again = await checkItem(f.source, f.catalogs(null), {...linked, remoteHead: f.first, lastResult: first});
  assert.equal(again.state, 'current');assert.equal(f.ensures(), ensures, 'an unchanged remote head costs no fetch');
  const next = await commit(f.repo, {'mods/foo/main.js': 'three\n'}, 'Linked change');
  const changed = await checkItem(f.source, f.catalogs(null), {...linked, remoteHead: f.first, lastResult: first});
  assert.equal(changed.state, 'update');assert.equal(changed.remoteHead, next);assert.deepEqual(changed.update.changed, ['main.js']);
});

test('a shared keys.json gives each item only its own keys; a single-item repository owns the whole file', async () => {
  const {itemKeys, keysDigest} = await import('../src/mods/mission-control-control-panel/updates.mjs');
  const file = {global: {'cmd-1': 'qa-clock.bump', 'cmd-2': 'qa-notes.add', 'cmd-3': 'tab.new'}, 'mod:qa-notes': {'cmd-s': 'qa-notes.save'}, 'layout:board': {'cmd-b': 'space.next'}};
  assert.deepEqual(itemKeys(file, {kind: 'mod', name: 'qa-clock'}), {global: {'cmd-1': 'qa-clock.bump'}});
  assert.deepEqual(itemKeys(file, {kind: 'mod', name: 'qa-notes'}), {global: {'cmd-2': 'qa-notes.add'}, 'mod:qa-notes': {'cmd-s': 'qa-notes.save'}});
  assert.deepEqual(itemKeys(file, {kind: 'layout', name: 'board'}), {'layout:board': {'cmd-b': 'space.next'}});
  assert.deepEqual(itemKeys(file, {kind: 'mod', name: 'qa-clock'}, {single: true}), file);
  const changedForNotes = {...file, global: {...file.global, 'cmd-2': 'qa-notes.remove'}};
  assert.equal(keysDigest(itemKeys(changedForNotes, {kind: 'mod', name: 'qa-clock'})), keysDigest(itemKeys(file, {kind: 'mod', name: 'qa-clock'})), 'another item’s key change is not this item’s update');
  assert.equal(keysDigest({}), null);
});
