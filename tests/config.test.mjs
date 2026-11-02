import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bindingKey, configPath, createConfigIO, newConfig, readConfig, redactConfig, resolveBinding, updateConfig, validateConfig } from '../src/shared/config.js';

async function fixture(t) {
  const appHome = await fs.mkdtemp(path.join(os.tmpdir(), 'mission-config-'));
  t.after(() => fs.rm(appHome, { recursive: true, force: true }));
  let queue = Promise.resolve();
  const io = {
    appHome,
    readTextFile: file => fs.readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; }),
    ensureDirectory: dir => fs.mkdir(dir, { recursive: true }),
    writeTextFile(file, text, expected) {
      const operation = queue.then(async () => {
        const actual = await io.readTextFile(file);
        if (actual !== expected) throw Object.assign(new Error('stale snapshot'), { code: 'STALE' });
        const temporary = file + '.pending';
        await fs.writeFile(temporary, text);
        await fs.rename(temporary, file);
      });
      queue = operation.catch(() => {});
      return operation;
    },
  };
  return io;
}

test('missing config reads without writing and saves only when edited', async t => {
  const io = await fixture(t);
  const initial = await readConfig(io);
  assert.equal(initial.raw, null);
  assert.deepEqual(initial.value, newConfig());
  assert.equal(await fs.stat(path.dirname(configPath(io))).then(() => true, () => false), false);
  const saved = await updateConfig(io, config => { config.preferences.grouping = 'priority'; });
  assert.equal(saved.revision, 1);
  assert.equal((await readConfig(io)).value.preferences.grouping, 'priority');
});

test('machine/canonical-root keys isolate identical names and retain independent tracker accounts', () => {
  const config = newConfig();
  config.connections.work = { id: 'work', kind: 'api', site: 'https://work.example.test', auth: { kind: 'basic', usernameEnv: 'JIRA_EMAIL', tokenEnv: 'JIRA_TOKEN' } };
  config.connections.personal = { id: 'personal', kind: 'api', site: 'https://personal.example.test', auth: { kind: 'bearer', tokenEnv: 'PERSONAL_TOKEN' } };
  for (const [machine, repoRoot, connectionId] of [[null, '/work/repo', 'work'], ['server', '/work/repo', 'personal'], [null, '/other/repo', 'personal']]) {
    config.bindings[bindingKey(machine, repoRoot)] = { machine, repoRoot, jira: { connectionId, project: 'WEB' } };
  }
  const validated = validateConfig(config);
  assert.equal(resolveBinding(validated, { name: 'repo', repoRoot: '/work/repo/', machine: null }).jira.connectionId, 'work');
  assert.equal(resolveBinding(validated, { name: 'repo', repoRoot: '/work/repo', machine: 'server' }).jira.connectionId, 'personal');
  assert.equal(resolveBinding(validated, { folder: '/work/repo', machine: null }), null);
  assert.equal(resolveBinding(validated, { state: 'ambiguous', repoRoot: '/work/repo', machine: null }), null);
  assert.equal(resolveBinding(validated, { repoRoot: '/missing/repo', machine: null }), null);
});

test('concurrent real-file CAS edits reload and preserve both changes', async t => {
  const io = await fixture(t);
  let reads = 0;
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const baseRead = io.readTextFile;
  io.readTextFile = async file => {
    const raw = await baseRead(file);
    if (++reads <= 2) { if (reads === 2) release(); await barrier; }
    return raw;
  };
  await Promise.all([
    updateConfig(io, config => { config.preferences.first = 'saved'; }),
    updateConfig(io, config => { config.preferences.second = 'saved'; }),
  ]);
  const final = (await readConfig(io)).value;
  assert.deepEqual(final.preferences, { first: 'saved', second: 'saved' });
  assert.equal(final.revision, 2);
});

test('malformed/unsupported private files are preserved and error output never dumps their contents', async t => {
  const io = await fixture(t);
  await io.ensureDirectory(path.dirname(configPath(io)));
  for (const raw of ['{"token":"private-value",', '{"v":2,"token":"private-value"}', '{"v":1,"connections":[],"token":"private-value"}']) {
    await fs.writeFile(configPath(io), raw);
    await assert.rejects(updateConfig(io, config => { config.preferences.change = true; }), error => {
      assert.doesNotMatch(error.message, /private-value/);
      return true;
    });
    assert.equal(await fs.readFile(configPath(io), 'utf8'), raw);
  }
});

test('invalid credentials, dangling bindings, relative roots and prototype keys cannot be persisted', () => {
  assert.throws(() => validateConfig({ ...newConfig(), preferences: { api_key: 'private-value' } }), /environment reference/);
  assert.throws(() => validateConfig(JSON.parse('{"v":1,"preferences":{"__proto__":{"polluted":true}}}')), /reserved object key/);
  assert.throws(() => bindingKey(null, '../relative'), /Relative/);
  assert.throws(() => bindingKey(null, '/repo/../other'), /canonical/);
  const config = newConfig();
  config.bindings[bindingKey(null, '/repo')] = { machine: null, repoRoot: '/repo', jira: { connectionId: 'missing', project: 'WEB' } };
  assert.throws(() => validateConfig(config), /existing connection/);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(redactConfig({ auth: { token: 'secret', tokenEnv: 'TOKEN_REF' } }), { auth: { token: '[redacted]', tokenEnv: 'TOKEN_REF' } });
});

test('persistent CAS contention is bounded and a permission error is not retried as a conflict', async t => {
  const io = await fixture(t);
  let writes = 0;
  io.writeTextFile = async () => { writes++; throw Object.assign(new Error('stale snapshot'), { code: 'STALE' }); };
  await assert.rejects(updateConfig(io, config => { config.preferences.value = true; }, { attempts: 2 }), error => error.code === 'CONFLICT');
  assert.equal(writes, 2);
  writes = 0;
  io.writeTextFile = async () => { writes++; throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); };
  await assert.rejects(updateConfig(io, () => {}), /permission denied/);
  assert.equal(writes, 1);
  assert.equal((await readConfig(io)).raw, null);
});

test('native config IO creates only its local private parent via argv', async () => {
  const calls = [];
  const io = createConfigIO({ appHome: () => '/tmp/Herdr app', exec: async (...args) => { calls.push(args); return { code: 0 }; } });
  await io.ensureDirectory('/tmp/Herdr app/mission-control');
  assert.deepEqual(calls, [['mkdir', ['-p', '/tmp/Herdr app/mission-control']]]);
  assert.equal(configPath(io), '/tmp/Herdr app/mission-control/config.json');
});
