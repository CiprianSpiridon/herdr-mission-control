// Catalog and source-repository reads for the Mods manager. Node helper only (never loaded in GPUI).
// The catalog is herdr.dev's own index of the public herdr-mod / herdr-layout GitHub topics; repositories are
// read through blob-less git partial clones, so no GitHub API rate limit applies. Every call is bounded so a
// helper run fits inside Herdr's 30 s exec limit; a fetch that cannot finish continues detached.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {spawn, execFile} from 'node:child_process';

export const CATALOG_URLS = Object.freeze({
  mods: 'https://assets.herdr.dev/mods/index.json',
  layouts: 'https://assets.herdr.dev/layouts/index.json'
});
export const CATALOG_TTL_MS = 60 * 60 * 1000;
export const CALL_BUDGET_MS = 20000;
export const MAX_FETCH_PASSES = 3;
const GITHUB = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/;

export class SourceError extends Error {
  constructor(code, message) { super(message); this.name = 'SourceError'; this.code = code; }
}
const fail = (code, message) => { throw new SourceError(code, message); };

/** Records root: appHome()/mission-control/control-panel/ (this repository's convention, not Herdr's data/ folder). */
export const recordsRoot = appHome => path.join(appHome, 'mission-control', 'control-panel');

export function createSource({appHome, env = process.env, fetchImpl = globalThis.fetch, now = () => Date.now(), git = 'git'} = {}) {
  if (typeof appHome !== 'string' || !path.isAbsolute(appHome)) fail('INVALID_APP_HOME', 'An absolute Herdr app home is required.');
  const fixture = env.QA_MODS_FIXTURE === '1';
  const root = recordsRoot(appHome), cache = path.join(root, 'cache');
  const gitEnv = {...env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', SSH_ASKPASS: 'echo', GCM_INTERACTIVE: 'never', LC_ALL: 'C'};

  /** Only github.com repositories; file:// remotes exist solely for the native gate's fixture mode. */
  function remote(url) {
    if (typeof url !== 'string') fail('INVALID_SOURCE', 'A source repository URL is required.');
    const clean = url.replace(/\.git$/, '').replace(/\/$/, '');
    const m = GITHUB.exec(clean);
    if (m) return {url: clean + '.git', key: `${m[1]}__${m[2]}`.toLowerCase(), fullName: `${m[1]}/${m[2]}`};
    if (fixture && /^file:\/\/\//.test(url)) {
      const base = path.basename(url.replace(/^file:\/\//, '')).replace(/\.git$/, '');
      return {url, key: 'fixture__' + base.toLowerCase().replace(/[^a-z0-9._-]/g, '_'), fullName: 'fixture/' + base};
    }
    fail('UNSUPPORTED_SOURCE', 'Only public github.com repositories are supported.');
  }

  function run(args, {cwd, timeout = CALL_BUDGET_MS, maxBuffer = 16 * 1024 * 1024, encoding = 'utf8'} = {}) {
    return new Promise(resolve => {
      execFile(git, args, {cwd, env: gitEnv, timeout, maxBuffer, encoding, windowsHide: true}, (error, stdout, stderr) => {
        resolve({code: error ? (error.killed ? 'TIMEOUT' : error.code ?? 1) : 0, stdout, stderr: String(stderr || '').slice(0, 2000)});
      });
    });
  }

  async function readJson(file) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; } }
  async function writeJson(file, value) {
    await fs.mkdir(path.dirname(file), {recursive: true});
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${now()}.tmp`);
    await fs.writeFile(tmp, JSON.stringify(value));
    await fs.rename(tmp, file);
  }

  /** The herdr.dev catalog for mods or layouts, cached for an hour; a failed refresh keeps the last copy. */
  async function catalog(kind, {force = false} = {}) {
    if (!['mods', 'layouts'].includes(kind)) fail('INVALID_REQUEST', 'Catalog kind must be mods or layouts.');
    const file = path.join(cache, `catalog-${kind}.json`), cached = await readJson(file);
    if (!force && cached && now() - cached.fetchedAt < CATALOG_TTL_MS) return {...cached, fresh: true};
    const url = fixture && env.QA_MODS_CATALOG_URL ? env.QA_MODS_CATALOG_URL.replace('{kind}', kind) : CATALOG_URLS[kind];
    try {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
      let response;
      try { response = fixture && url.startsWith('file:///') ? await fixtureFile(url) : await fetchImpl(url, {signal: controller.signal, headers: {accept: 'application/json'}}); } finally { clearTimeout(timer); }
      if (!response.ok) fail('CATALOG_UNAVAILABLE', `The herdr.dev catalog answered ${response.status}.`);
      const body = await response.json(), list = body?.[kind];
      if (!Array.isArray(list)) fail('CATALOG_INVALID', 'The herdr.dev catalog has an unexpected shape.');
      const entries = list.map(entry => normalize(kind, entry)).filter(Boolean);
      const value = {kind, fetchedAt: now(), generatedAt: body.generatedAt ?? null, entries};
      await writeJson(file, value);
      return {...value, fresh: true};
    } catch (error) {
      if (cached) return {...cached, fresh: false, reason: error.message || 'The catalog could not be refreshed.'};
      if (error instanceof SourceError) throw error;
      fail('CATALOG_UNAVAILABLE', 'The herdr.dev catalog is unreachable.');
    }
  }

  /** The native gate's fixture catalog is a local file (fixture mode only). */
  async function fixtureFile(url) {
    try { const text = await fs.readFile(new URL(url), 'utf8');return {ok: true, status: 200, json: async () => JSON.parse(text)}; }
    catch { return {ok: false, status: 404, json: async () => null}; }
  }

  function normalize(kind, e) {
    if (!e || typeof e !== 'object' || typeof e.url !== 'string' || typeof e.fullName !== 'string') return null;
    const names = kind === 'mods' ? e.modNames : e.layoutFiles;
    if (!Array.isArray(names)) return null;
    return {
      kind, owner: String(e.owner || ''), repo: String(e.repo || ''), fullName: e.fullName, url: e.url,
      defaultBranch: typeof e.defaultBranch === 'string' && e.defaultBranch ? e.defaultBranch : 'main',
      headCommit: typeof e.headCommit === 'string' ? e.headCommit : null,
      path: typeof e.path === 'string' ? e.path.replace(/^\/+|\/+$/g, '') : '',
      name: String(e.name || ''), stars: Number(e.stars) || 0, pushedAt: e.pushedAt ?? null,
      previewUrl: typeof e.previewUrl === 'string' && (/^https:\/\/assets\.herdr\.dev\//.test(e.previewUrl) || fixture && /^file:\/\/\//.test(e.previewUrl)) ? e.previewUrl : null,
      names: names.filter(n => typeof n === 'string').map(n => kind === 'layouts' ? n.replace(/\.json$/, '') : n)
    };
  }

  const repoDir = source => path.join(cache, 'repos', remote(source).key + '.git');
  const statusFile = source => repoDir(source) + '.status.json';

  /**
   * Make the partial clone current. Returns {state:'ready'|'pending'|'too-large'|'unreachable', reason?}.
   * A clone or fetch that cannot finish inside the budget continues detached; after three failed passes the
   * repository reads too large or slow to fetch.
   */
  async function ensure(source, {budgetMs = CALL_BUDGET_MS} = {}) {
    const {url} = remote(source), dir = repoDir(source), statusPath = statusFile(source);
    const status = (await readJson(statusPath)) || {passes: 0};
    if (status.state === 'too-large') return {state: 'too-large', reason: 'The repository is too large or slow to fetch.'};
    if (status.pid && alive(status.pid)) return {state: 'pending', reason: 'Still fetching this repository.'};
    const exists = fsSync.existsSync(path.join(dir, 'HEAD'));
    const args = exists
      ? ['--git-dir', dir, 'fetch', '--quiet', '--filter=blob:none', '--prune', url, '+refs/heads/*:refs/heads/*']
      : ['clone', '--quiet', '--bare', '--filter=blob:none', url, dir];
    await fs.mkdir(path.dirname(dir), {recursive: true});
    const result = await run(args, {timeout: budgetMs});
    if (result.code === 0) { await writeJson(statusPath, {state: 'ready', passes: 0, at: now()}); return {state: 'ready'}; }
    if (result.code !== 'TIMEOUT') {
      await writeJson(statusPath, {state: 'unreachable', passes: status.passes || 0, at: now(), reason: summarize(result.stderr)});
      return {state: 'unreachable', reason: summarize(result.stderr)};
    }
    const passes = (status.passes || 0) + 1;
    if (passes >= MAX_FETCH_PASSES) { await writeJson(statusPath, {state: 'too-large', passes, at: now()}); return {state: 'too-large', reason: 'The repository is too large or slow to fetch.'}; }
    if (!exists) await fs.rm(dir, {recursive: true, force: true});
    const child = spawn(git, args, {env: gitEnv, detached: true, stdio: 'ignore'});
    child.unref();
    await writeJson(statusPath, {state: 'pending', passes, pid: child.pid, at: now()});
    return {state: 'pending', reason: 'Still fetching this repository.'};
  }

  /** Newest commits touching a path on a branch: [{commit, time, subject}]. */
  async function log(source, {ref, paths, max = 40, since = null} = {}) {
    const dir = repoDir(source), args = ['--git-dir', dir, 'log', '--format=%H%x09%ct%x09%s', `-n${Math.max(1, Math.min(max, 200))}`];
    if (since) args.push(`${since}..${ref}`); else args.push(ref);
    args.push('--', ...(paths?.length ? paths : ['.']));
    const r = await run(args);
    if (r.code !== 0) fail('GIT_FAILED', 'Reading the repository history failed: ' + summarize(r.stderr));
    return r.stdout.split('\n').filter(Boolean).map(line => { const [commit, time, ...subject] = line.split('\t'); return {commit, time: Number(time) * 1000, subject: subject.join('\t')}; });
  }

  /** Files under paths at a commit: [{path, sha, mode}] (blobs only). */
  async function tree(source, commit, paths = []) {
    const r = await run(['--git-dir', repoDir(source), 'ls-tree', '-r', '--full-tree', commit, '--', ...paths]);
    if (r.code !== 0) fail('GIT_FAILED', 'Reading the repository tree failed: ' + summarize(r.stderr));
    return r.stdout.split('\n').filter(Boolean).map(line => {
      const [meta, file] = line.split('\t'), [mode, type, sha] = meta.split(' ');
      return {path: file, sha, mode, type};
    }).filter(e => e.type === 'blob');
  }

  /** One blob's bytes; a partial clone fetches it on demand. */
  async function blob(source, sha) {
    if (!/^[0-9a-f]{40}$/.test(sha)) fail('INVALID_REQUEST', 'A full blob SHA is required.');
    const r = await run(['--git-dir', repoDir(source), 'cat-file', 'blob', sha], {encoding: 'buffer'});
    if (r.code !== 0) fail('GIT_FAILED', 'Reading a file from the repository failed.');
    return r.stdout;
  }

  /** The current commit of a branch on the remote, for items adopted from a pasted link. */
  async function lsRemote(source, ref = 'HEAD') {
    const r = await run(['ls-remote', remote(source).url, ref]);
    if (r.code !== 0) return null;
    return r.stdout.split('\n').map(l => l.split('\t')[0]).find(s => /^[0-9a-f]{40}$/.test(s)) || null;
  }

  return {catalog, ensure, log, tree, blob, lsRemote, remote, repoDir, root, fixture};
}

function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function summarize(stderr) { return String(stderr || '').split('\n').map(s => s.trim()).filter(Boolean).slice(-1)[0]?.replace(/https?:\/\/[^@\s]*@/g, 'https://') || 'unknown error'; }
