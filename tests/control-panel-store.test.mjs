import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync, spawn} from 'node:child_process';
import {createStore} from '../src/mods/mission-control-control-panel/store.mjs';

const STORE = new URL('../src/mods/mission-control-control-panel/store.mjs', import.meta.url).href;

async function home(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mc-mods-store-')));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  await fs.mkdir(path.join(root, 'mods/foo'), {recursive: true});
  await fs.writeFile(path.join(root, 'mods/foo/main.js'), 'old main\n');
  await fs.writeFile(path.join(root, 'mods/foo/mod.json'), 'old manifest\n');
  await fs.writeFile(path.join(root, 'mods/foo/gone.svg'), 'old icon\n');
  await fs.writeFile(path.join(root, 'keys.json'), '{"global":{}}\n');
  return root;
}
const state = async root => Object.fromEntries(await Promise.all(['mods/foo/main.js', 'mods/foo/mod.json', 'mods/foo/gone.svg', 'mods/foo/new.svg', 'keys.json'].map(async f => [f, await fs.readFile(path.join(root, f), 'utf8').catch(() => null)])));
const OLD = {'mods/foo/main.js': 'old main\n', 'mods/foo/mod.json': 'old manifest\n', 'mods/foo/gone.svg': 'old icon\n', 'mods/foo/new.svg': null, 'keys.json': '{"global":{}}\n'};
const NEW = {'mods/foo/main.js': 'new main\n', 'mods/foo/mod.json': 'new manifest\n', 'mods/foo/gone.svg': null, 'mods/foo/new.svg': 'new icon\n', 'keys.json': '{"global":{"ctrl-b":"foo.open"}}\n'};

/** Runs the five-operation change in a separate process that SIGKILLs itself after `killAfter` operations. */
function commitInChild(root, killAfter) {
  const script = `
    import {createStore} from ${JSON.stringify(STORE)};
    import path from 'node:path';
    const root=${JSON.stringify(root)},kill=${killAfter},store=createStore({appHome:root});
    await store.commit([
      {type:'write',target:path.join(root,'mods/foo/main.js'),data:'new main\\n'},
      {type:'write',target:path.join(root,'mods/foo/mod.json'),data:'new manifest\\n'},
      {type:'delete',target:path.join(root,'mods/foo/gone.svg')},
      {type:'write',target:path.join(root,'mods/foo/new.svg'),data:'new icon\\n'},
      {type:'write',target:path.join(root,'keys.json'),data:'{"global":{"ctrl-b":"foo.open"}}\\n'}
    ],{label:'update foo',afterOp:i=>{if(i+1===kill)process.kill(process.pid,'SIGKILL');}});
  `;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {encoding: 'utf8'});
}

test('a helper killed after any number of operations leaves the complete old state after recovery', async t => {
  for (let kill = 1; kill <= 4; kill++) {
    const root = await home(t), child = commitInChild(root, kill);
    assert.equal(child.signal, 'SIGKILL', 'the child really died mid-commit');
    const store = createStore({appHome: root});
    const result = await store.recover();
    assert.deepEqual(result, {recovered: true, outcome: 'rolled-back', label: 'update foo'}, `killed after ${kill}`);
    assert.deepEqual(await state(root), OLD, `killed after ${kill} operations: every file is back`);
    assert.deepEqual(await store.recover(), {recovered: false}, 'recovery is idempotent');
  }
});

test('a completed change stays complete, including one killed after it was marked complete', async t => {
  const root = await home(t), child = commitInChild(root, 99);
  assert.equal(child.status, 0, child.stderr);assert.deepEqual(await state(root), NEW);
  // Simulate a crash between "complete" and cleanup: the journal is complete, so recovery keeps the new state.
  const store = createStore({appHome: root});
  await fs.mkdir(store.root, {recursive: true});await fs.writeFile(store.files.journal, JSON.stringify({v: 1, id: 'x', label: 'done', state: 'complete', ops: []}));
  assert.equal((await store.recover()).outcome, 'completed');assert.deepEqual(await state(root), NEW);
});

test('a failing operation rolls everything back in the same run', async t => {
  const root = await home(t), store = createStore({appHome: root});
  await assert.rejects(store.commit([
    {type: 'write', target: path.join(root, 'mods/foo/main.js'), data: 'new main\n'},
    {type: 'write', target: path.join(root, 'mods/foo/mod.json'), data: 'new manifest\n'}
  ], {afterOp: i => { if (i === 1) throw new Error('disk full'); }}), /disk full/);
  assert.deepEqual(await state(root), OLD);
  await assert.rejects(store.commit([{type: 'write', target: '/etc/hosts', data: 'x'}]), /outside the Herdr app home/);
});

test('moves are journalled and undone too', async t => {
  const root = await home(t), store = createStore({appHome: root}), to = path.join(store.root, 'disabled/mods/foo');
  await store.commit([{type: 'move', from: path.join(root, 'mods/foo'), to}]);
  assert.equal(await fs.readFile(path.join(to, 'main.js'), 'utf8'), 'old main\n');
  await fs.mkdir(store.root, {recursive: true});
  await fs.writeFile(store.files.journal, JSON.stringify({v: 1, id: 'm', label: 'disable', state: 'applying', ops: [{type: 'move', from: path.join(root, 'mods/foo'), to}]}));
  await store.recover();
  assert.equal(await fs.readFile(path.join(root, 'mods/foo/main.js'), 'utf8'), 'old main\n', 'an interrupted move is undone');
});

test('concurrent writers never lose an update, and a stale or dead lock is reclaimed', async t => {
  const root = await home(t);
  const writer = n => new Promise((resolve, reject) => {
    const script = `import {createStore} from ${JSON.stringify(STORE)};const s=createStore({appHome:${JSON.stringify(root)},lockWaitMs:30000});for(let i=0;i<${n};i++)await s.updatePackages(v=>{v.count=(v.count||0)+1;});`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {stdio: 'inherit'});
    child.on('exit', code => code === 0 ? resolve() : reject(new Error('writer failed ' + code)));
  });
  await Promise.all([writer(25), writer(25), writer(25)]);
  const store = createStore({appHome: root});
  assert.equal((await store.readPackages()).count, 75);
  await fs.writeFile(store.files.lock, JSON.stringify({pid: 999999, at: Date.now(), token: 'dead'}));
  await store.updatePackages(v => { v.count++; });
  assert.equal((await store.readPackages()).count, 76, 'a lock held by a dead process is reclaimed');
  let clock = 1000;const timed = createStore({appHome: root, now: () => clock, lockWaitMs: 200});
  await fs.writeFile(store.files.lock, JSON.stringify({pid: process.pid, at: clock, token: 'live'}));
  await assert.rejects(timed.updatePackages(() => {}), /still running/, 'a fresh lock held by a live process waits and then refuses');
  clock += 60001;await timed.updatePackages(v => { v.count++; });
  assert.equal((await store.readPackages()).count, 77, 'a lock older than the stale timeout is reclaimed');
});
