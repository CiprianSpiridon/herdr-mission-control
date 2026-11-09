import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {execFileSync} from 'node:child_process';
import {createSource, SourceError, MAX_FETCH_PASSES} from '../src/mods/mission-control-control-panel/source.mjs';

const git = (cwd, ...args) => execFileSync('git', args, {cwd, encoding: 'utf8', env: {...process.env, GIT_AUTHOR_NAME: 'QA', GIT_AUTHOR_EMAIL: 'qa@example.invalid', GIT_COMMITTER_NAME: 'QA', GIT_COMMITTER_EMAIL: 'qa@example.invalid'}}).trim();

/** A real local repository holding one mod, with a commit outside it, served as a fixture remote. */
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mc-mods-source-')));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const repo = path.join(root, 'upstream'), home = path.join(root, 'app');
  await fs.mkdir(path.join(repo, 'mods/foo'), {recursive: true});await fs.mkdir(home);
  git(root, 'init', '-q', '-b', 'main', repo);
  await fs.writeFile(path.join(repo, 'mods/foo/main.js'), 'export default 1;\n');
  await fs.writeFile(path.join(repo, 'mods/foo/mod.json'), '{"place":"none"}\n');
  git(repo, 'add', '.');git(repo, 'commit', '-qm', 'Add foo');
  const first = git(repo, 'rev-parse', 'HEAD');
  await fs.writeFile(path.join(repo, 'README.md'), 'unrelated\n');git(repo, 'add', '.');git(repo, 'commit', '-qm', 'Docs only');
  await fs.writeFile(path.join(repo, 'mods/foo/main.js'), 'export default 2;\n');git(repo, 'add', '.');git(repo, 'commit', '-qm', 'Improve foo');
  const head = git(repo, 'rev-parse', 'HEAD');
  let hits = 0, broken = false;
  const server = http.createServer((req, res) => {
    hits++;
    if (broken) { res.writeHead(503); res.end(); return; }
    const kind = req.url.includes('layouts') ? 'layouts' : 'mods';
    const entry = {owner: 'fixture', repo: 'upstream', fullName: 'fixture/upstream', url: 'file://' + repo, defaultBranch: 'main', headCommit: head, path: '', name: 'Foo', stars: 3, pushedAt: null, [kind === 'mods' ? 'modNames' : 'layoutFiles']: kind === 'mods' ? ['foo'] : ['bundle/layouts/bar.json']};
    res.writeHead(200, {'content-type': 'application/json'});res.end(JSON.stringify({schemaVersion: 1, generatedAt: 'x', [kind]: [entry, {bad: true}]}));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));t.after(() => server.close());
  const env = {...process.env, QA_MODS_FIXTURE: '1', QA_MODS_CATALOG_URL: `http://127.0.0.1:${server.address().port}/{kind}.json`};
  let clock = 1_800_000_000_000;
  const source = createSource({appHome: home, env, now: () => clock});
  return {root, repo, home, env, first, head, source, url: 'file://' + repo, hits: () => hits, breakServer: () => { broken = true; }, advance: ms => { clock += ms; }};
}

test('the catalog is read, normalized, cached for an hour and kept when a refresh fails', async t => {
  const f = await fixture(t);
  const mods = await f.source.catalog('mods');
  assert.equal(mods.entries.length, 1, 'malformed entries are dropped');
  assert.deepEqual(mods.entries[0].names, ['foo']);assert.equal(mods.entries[0].path, '');
  const layouts = await f.source.catalog('layouts');assert.deepEqual(layouts.entries[0].names, ['bar'], 'repository-relative layout paths become installed names');
  const legacy = path.join(f.source.root, 'cache/catalog-layouts.json');
  const cached = JSON.parse(await fs.readFile(legacy, 'utf8'));cached.entries[0].names = ['bundle/layouts/bar'];
  await fs.writeFile(legacy, JSON.stringify(cached));
  assert.deepEqual((await f.source.catalog('layouts')).entries[0].names, ['bar'], 'existing caches are migrated without waiting an hour');
  const hits = f.hits();await f.source.catalog('mods');assert.equal(f.hits(), hits, 'a fresh cache costs no request');
  f.advance(60 * 60 * 1000 + 1);f.breakServer();
  const stale = await f.source.catalog('mods');assert.equal(stale.fresh, false);assert.equal(stale.entries.length, 1);assert.match(stale.reason, /503/);
});

test('only github.com sources are accepted outside the native gate fixture mode', async t => {
  const f = await fixture(t), real = createSource({appHome: f.home, env: {}});
  assert.equal(real.remote('https://github.com/CiprianSpiridon/herdr-mission-control').fullName, 'CiprianSpiridon/herdr-mission-control');
  for (const bad of ['file://' + f.repo, 'https://gitlab.com/a/b', 'https://github.com/a/b/c', 'git@github.com:a/b.git'])
    assert.throws(() => real.remote(bad), SourceError, bad);
  assert.equal(f.source.remote(f.url).fullName, 'fixture/upstream', 'the fixture mode allows a file:// remote');
});

test('a partial clone answers path-scoped history, trees and blobs, then refreshes with a fetch', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.source.ensure(f.url), {state: 'ready'});
  const history = await f.source.log(f.url, {ref: 'main', paths: ['mods/foo']});
  assert.deepEqual(history.map(h => h.subject), ['Improve foo', 'Add foo'], 'a commit outside the path is not in its history');
  const files = await f.source.tree(f.url, f.first, ['mods/foo']);
  assert.deepEqual(files.map(x => x.path).sort(), ['mods/foo/main.js', 'mods/foo/mod.json']);
  const main = files.find(x => x.path.endsWith('main.js'));assert.equal((await f.source.blob(f.url, main.sha)).toString(), 'export default 1;\n');
  await fs.writeFile(path.join(f.repo, 'mods/foo/extra.svg'), '<svg/>');git(f.repo, 'add', '.');git(f.repo, 'commit', '-qm', 'Add icon');
  assert.equal((await f.source.ensure(f.url)).state, 'ready');
  assert.equal((await f.source.log(f.url, {ref: 'main', paths: ['mods/foo'], max: 1}))[0].subject, 'Add icon');
  assert.equal(await f.source.lsRemote(f.url, 'refs/heads/main'), git(f.repo, 'rev-parse', 'HEAD'));
});

test('a fetch that cannot finish in its budget continues detached and ends as too large after three passes', async t => {
  const f = await fixture(t);
  let last;
  for (let pass = 1; pass <= MAX_FETCH_PASSES; pass++) {
    // A 1 ms budget always times out; wait for the detached fetch from the previous pass first.
    const status = path.join(f.source.repoDir(f.url) + '.status.json');
    for (let i = 0; i < 100; i++) { const s = JSON.parse(await fs.readFile(status, 'utf8').catch(() => '{}'));try { if (!s.pid) break;process.kill(s.pid, 0); } catch { break; } await new Promise(r => setTimeout(r, 50)); }
    if (pass > 1) await fs.rm(f.source.repoDir(f.url), {recursive: true, force: true});
    last = await f.source.ensure(f.url, {budgetMs: 1});
  }
  assert.equal(last.state, 'too-large');assert.match(last.reason, /too large or slow/);
  assert.equal((await f.source.ensure(f.url)).state, 'too-large', 'it stays too large until reset');
});

test('a missing repository fails fast without a credential prompt', async t => {
  const f = await fixture(t);
  const result = await f.source.ensure('file://' + path.join(f.root, 'missing'));
  assert.equal(result.state, 'unreachable');
});
