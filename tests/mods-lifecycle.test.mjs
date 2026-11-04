import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {handle} from '../src/mods/mission-control-mods/backend.mjs';
import {createStore} from '../src/mods/mission-control-mods/store.mjs';

const BACKEND = new URL('../src/mods/mission-control-mods/backend.mjs', import.meta.url).pathname;
async function put(root, files) { for (const [rel, data] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(root, rel)), {recursive: true});await fs.writeFile(path.join(root, rel), data); } }
async function tree(root, rel) { const out = {};async function walk(d, r) { for (const e of await fs.readdir(d, {withFileTypes: true}).catch(() => [])) { const p = r ? `${r}/${e.name}` : e.name;if (e.isDirectory()) await walk(path.join(d, e.name), p);else out[p] = await fs.readFile(path.join(d, e.name), 'utf8'); } } await walk(path.join(root, rel), '');return out; }

async function fixture(t) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mc-mods-lifecycle-')));
  t.after(() => fs.rm(home, {recursive: true, force: true}));
  await put(home, {
    'installed.json': JSON.stringify({menu: {}, 'layout:main': {}}), 'mods/menu/main.js': 'shipped\n', 'layouts/main.json': '{}\n',
    'mods/mission-control-mods/main.js': 'self\n', 'mods/mission-control-agents/main.js': 'mc\n',
    'mission-control/installed-packages.json': JSON.stringify({v: 1, packages: {'mission-control': {mods: ['mission-control-agents'], layouts: []}}}),
    'mods/foo/main.js': 'foo\n', 'mods/foo/assets/icon.svg': '<svg/>\n', 'mods/laymod/main.js': 'laymod\n',
    'layouts/lay.json': JSON.stringify({children: [{content: {mod: 'laymod'}}]}), 'layouts/lay.svg': '<svg/>\n',
    'keys.json': JSON.stringify({global: {'ctrl-f': 'foo.open', 'ctrl-x': 'mine.cut'}})
  });
  const store = createStore({appHome: home});
  await store.updatePackages(v => { v.packages['mod:foo'] = {kind: 'mod', name: 'foo', state: 'current', keys: [{section: 'global', key: 'ctrl-f', action: 'foo.open'}]}; });
  let clock = 1_800_000_000_000;
  // No network in tests: the fixture mode points the catalog at a closed local port.
  const env = {QA_MODS_FIXTURE: '1', QA_MODS_CATALOG_URL: 'http://127.0.0.1:9/{kind}.json'};
  const call = (op, extra = {}) => handle({appHome: home, op, ...extra}, {env, now: () => clock});
  return {home, store, call, advance: ms => { clock += ms; }};
}

test('disable then enable, and uninstall then restore, return identical files and keys', async t => {
  const f = await fixture(t), files = await tree(f.home, 'mods/foo'), keys = await fs.readFile(path.join(f.home, 'keys.json'), 'utf8');
  assert.equal((await f.call('disable', {key: 'mod:foo'})).result.state, 'disabled');
  assert.deepEqual(await tree(f.home, 'mods/foo'), {}, 'the folder left mods/');
  const listed = (await f.call('inventory')).list.find(i => i.key === 'mod:foo');assert.equal(listed.state, 'disabled');
  await f.call('enable', {key: 'mod:foo'});assert.deepEqual(await tree(f.home, 'mods/foo'), files);
  const removed = (await f.call('uninstall', {key: 'mod:foo'})).result;
  assert.deepEqual(removed.removedKeys.map(k => k.key), ['ctrl-f'], 'only the key the item added is removed');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.home, 'keys.json'), 'utf8')).global, {'ctrl-x': 'mine.cut'});
  const {removed: list} = await f.call('inventory');assert.equal(list.length, 1);assert.equal(list[0].restoreUntil - list[0].at, 30 * 24 * 3600 * 1000);
  await f.call('restore', {id: list[0].id});
  assert.deepEqual(await tree(f.home, 'mods/foo'), files);assert.equal(await fs.readFile(path.join(f.home, 'keys.json'), 'utf8').then(JSON.parse).then(k => k.global['ctrl-f']), JSON.parse(keys).global['ctrl-f']);
});

test('built-in, installer-managed and self items, and the active layout, are refused with a reason', async t => {
  const f = await fixture(t);
  for (const [key, code] of [['mod:menu', 'BUILT_IN'], ['layout:main', 'BUILT_IN'], ['mod:mission-control-agents', 'INSTALLER_MANAGED'], ['mod:mission-control-mods', 'SELF']])
    await assert.rejects(f.call('disable', {key}), error => error.code === code, key);
  await assert.rejects(f.call('uninstall', {key: 'layout:lay', activeLayout: 'lay'}), error => error.code === 'ACTIVE_LAYOUT');
});

test('a mod a layout uses needs a confirmation naming it, and is refused while that layout is on screen', async t => {
  const f = await fixture(t);
  await assert.rejects(f.call('disable', {key: 'mod:laymod', activeLayout: 'lay'}), error => error.code === 'USED_BY_ACTIVE_LAYOUT' && error.detail.layouts[0] === 'lay');
  const ask = (await f.call('disable', {key: 'mod:laymod', activeLayout: 'main'})).result;
  assert.deepEqual(ask, {needsConfirm: true, layouts: ['lay']});assert.ok(await fs.stat(path.join(f.home, 'mods/laymod')), 'nothing moved before confirming');
  assert.equal((await f.call('disable', {key: 'mod:laymod', activeLayout: 'main', confirm: true})).result.state, 'disabled');
});

test('removed items are deleted after 30 days, and Restore everything brings back what is left', async t => {
  const f = await fixture(t);
  await f.call('uninstall', {key: 'mod:foo'});await f.call('disable', {key: 'layout:lay', activeLayout: 'main'});
  f.advance(31 * 24 * 3600 * 1000);
  assert.deepEqual((await f.call('inventory')).removed, [], 'pruned after 30 days');
  const restored = (await f.call('restore-all')).restored;assert.deepEqual(restored, ['layout:lay']);
  assert.ok(await fs.stat(path.join(f.home, 'layouts/lay.json')));
});

test('the command-line entry point recovers an interrupted change before doing anything else', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.store.root, {recursive: true});
  await fs.writeFile(f.store.files.journal, JSON.stringify({v: 1, id: 'x', label: 'disable mod:foo', state: 'applying', ops: [{type: 'move', from: path.join(f.home, 'mods/foo'), to: path.join(f.store.root, 'disabled/mods/foo')}]}));
  await fs.rename(path.join(f.home, 'mods/foo'), path.join(f.store.root, 'tmp-moved'));
  await fs.mkdir(path.join(f.store.root, 'disabled/mods'), {recursive: true});await fs.rename(path.join(f.store.root, 'tmp-moved'), path.join(f.store.root, 'disabled/mods/foo'));
  const run = spawnSync(process.execPath, [BACKEND, JSON.stringify({appHome: f.home, op: 'recover'})], {encoding: 'utf8'});
  const out = JSON.parse(run.stdout);
  assert.equal(out.ok, true);assert.deepEqual(out.recovered, {recovered: true, outcome: 'rolled-back', label: 'disable mod:foo'});
  assert.equal(await fs.readFile(path.join(f.home, 'mods/foo/main.js'), 'utf8'), 'foo\n');
  const bad = JSON.parse(spawnSync(process.execPath, [BACKEND, JSON.stringify({appHome: f.home, op: 'disable', key: 'mod:menu'})], {encoding: 'utf8'}).stdout);
  assert.deepEqual([bad.ok, bad.code], [false, 'BUILT_IN']);
});
