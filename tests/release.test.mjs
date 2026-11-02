import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { publish, preflight, verifyRelease, reconcileBundle, redact, secretFindings, scanFiles, classifyPath, parseGithubRemote, recipeLinks, expandStaged, TOPICS, ReleaseError } from '../scripts/release.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts/release.mjs');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const FAKE_TOKEN = 'ghp_' + 'Q7'.repeat(18);
const passed = async () => ({ ok: true, reasons: [] });

// A fake gh: auth, repo view/create/edit and the REST endpoints release.mjs reads, answered from a JSON state file
// plus the local bare repository the fixture pushes to. It has no network code path.
const GH_STUB = `#!${process.execPath}
const fs=require('node:fs'),{execFileSync}=require('node:child_process');
const file=process.env.GH_STUB_STATE,state=JSON.parse(fs.readFileSync(file,'utf8')),args=process.argv.slice(2);state.calls.push(args);
const save=()=>fs.writeFileSync(file,JSON.stringify(state,null,2));
const out=(value,code=0)=>{save();process.stdout.write(typeof value==='string'?value+'\\n':JSON.stringify(value)+'\\n');process.exit(code);};
const err=(text,code=1)=>{save();process.stderr.write(text+'\\n');process.exit(code);};
const git=(...a)=>execFileSync('git',['-C',state.bare,...a],{encoding:'utf8'}).trim();
const find=name=>Object.keys(state.repos).find(key=>key.toLowerCase()===String(name).toLowerCase());
const branches=()=>{try{return git('for-each-ref','--format=%(refname:short)','refs/heads').split('\\n').filter(Boolean);}catch{return [];}};
if(args[0]==='auth'&&args[1]==='status')state.auth?out('github.com\\n  Logged in to github.com account acme (keyring)\\n  - Token: gho_************************************'):err('github.com\\n  X Failed to log in to github.com using token (GH_TOKEN)\\n  - Token: ${FAKE_TOKEN}');
if(args[0]==='repo'&&args[1]==='view'){const key=find(args[2]);if(!key)err("GraphQL: Could not resolve to a Repository with the name '"+args[2]+"'. (repository)");const r=state.repos[key];const d=r.defaultBranch??branches()[0]??null;out({nameWithOwner:key,visibility:r.visibility.toUpperCase(),isPrivate:r.visibility!=='public',defaultBranchRef:d?{name:d}:null,isEmpty:!d});}
if(args[0]==='repo'&&args[1]==='create'){if(find(args[2]))err('Name already exists on this account');if(!args.includes('--public'))err('visibility required');state.repos[args[2]]={visibility:state.createVisibility??'public',defaultBranch:null,topics:[]};out('https://github.com/'+args[2]);}
if(args[0]==='repo'&&args[1]==='edit'){const r=state.repos[find(args[2])];for(let i=3;i<args.length;i++)if(args[i]==='--add-topic'&&!state.dropTopics&&!r.topics.includes(args[i+1]))r.topics.push(args[++i]);out('');}
if(args[0]==='api'){
  const endpoint=args.at(-1),[base,query='']=endpoint.split('?'),parts=base.split('/'),key=find(parts[1]+'/'+parts[2]);
  if(parts[0]!=='repos'||!key)err('gh: Not Found (HTTP 404)');
  const r=state.repos[key],rest=parts.slice(3);
  if(!rest.length)out({full_name:key,private:r.visibility!=='public',visibility:r.visibility,default_branch:r.defaultBranch??branches()[0]??null,html_url:'https://github.com/'+key});
  if(rest[0]==='topics')out({names:r.topics});
  if(rest[0]==='commits'){try{const sha=git('rev-parse','--verify',rest[1]+'^{commit}');out({sha,commit:{tree:{sha:git('rev-parse',sha+'^{tree}')}}});}catch{err('gh: No commit found (HTTP 422)');}}
  if(rest[0]==='compare'){const [a,b]=rest[1].split('...');try{const x=git('rev-parse',a),y=git('rev-parse',b);let status='diverged';if(x===y)status='identical';else{try{execFileSync('git',['-C',state.bare,'merge-base','--is-ancestor',x,y]);status='ahead';}catch{}}out({status});}catch{err('gh: Not Found (HTTP 404)');}}
  if(rest[0]==='git'&&rest[1]==='trees'){const tree=git('ls-tree','-r','-t',rest[2]).split('\\n').filter(Boolean).map(line=>{const [meta,path]=line.split('\\t'),[mode,type,sha]=meta.split(' ');return {path,mode,type,sha};});out({sha:rest[2],truncated:false,tree:state.tamperTree?tree.slice(1):tree});}
  if(rest[0]==='contents'){const ref=new URLSearchParams(query).get('ref');try{const content=execFileSync('git',['-C',state.bare,'show',ref+':'+rest.slice(1).join('/')]);out({type:'file',encoding:'base64',content:content.toString('base64')});}catch{err('gh: Not Found (HTTP 404)');}}
  err('gh: Not Found (HTTP 404)');
}
err('unknown gh command '+args.join(' '),2);
`;

const png = (w = 1280, h = 760) => { const b = Buffer.alloc(45); Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(b); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); b[24] = 8; b[25] = 6; Buffer.from('0000000049454e44ae426082', 'hex').copy(b, 33); return b; };

async function writeFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true }); await fs.writeFile(path.join(root, rel), content); }
}

async function reviewLedger(root) {
  const plans = [];
  for (const name of ['mission-control', 'mission-control-alpha']) {
    plans.push({ name, verdict: 'APPROVE', blocks: 0, concerns: 0, sha256: { json: sha(await fs.readFile(path.join(root, `.ulpi/plans/${name}.json`))), md: sha(await fs.readFile(path.join(root, `.ulpi/plans/${name}.md`))) } });
  }
  await writeFiles(root, { 'evidence/reviews/final.json': JSON.stringify({ schemaVersion: 1, verdict: 'APPROVE', state: 'approved', pending: [], plans }, null, 2) + '\n' });
}

async function fixture(t, { stub: initial = {} } = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mc-release-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo'), bare = path.join(base, 'remote.git'), home = path.join(base, 'home');
  const alpha = { 'mods/mission-control-alpha/main.js': 'export default class A {}\n', 'mods/mission-control-alpha/mod.json': '{"title":"Alpha","place":"none"}\n' };
  await writeFiles(root, {
    '.gitignore': (await fs.readFile(path.join(ROOT, '.gitignore'), 'utf8')) + 'drafts/\n',
    '.ulpi/plans/mission-control.json': '{"name":"mission-control","tasks":[]}\n', '.ulpi/plans/mission-control.md': '# Mission Control plan\n',
    '.ulpi/plans/mission-control-alpha.json': '{"name":"mission-control-alpha","tasks":[]}\n', '.ulpi/plans/mission-control-alpha.md': '# Alpha plan\n',
    'README.md': '# Mission Control\n', 'scripts/tool.mjs': 'export const token = process.env.FIXTURE_TOKEN_ENV;\nconst sample = "https://user:PRIVATE@github.com";\n',
    'mission-control/layouts/mission-control.json': JSON.stringify({ id: 'root', type: 'block', preview: 'layouts/mission-control.svg', content: { mod: 'mission-control-alpha' } }) + '\n',
    'mission-control/layouts/mission-control.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
    ...Object.fromEntries(Object.entries(alpha).map(([rel, text]) => ['mission-control/' + rel, text])),
    'mission-control/RECIPE.md': '# Mission Control\n\nTwo layouts.\n\n![Mission Control](preview.png)\n\nThe [agents mod](../mission-control-alpha/RECIPE.md) and [its folder](../mission-control-alpha/) ship separately; see [herdr](https://herdr.dev).\n',
    'mission-control/preview.png': png(), 'mission-control/.DS_Store': 'junk',
    ...Object.fromEntries(Object.entries(alpha).map(([rel, text]) => ['mission-control-alpha/' + rel, text])),
    'mission-control-alpha/RECIPE.md': '# Alpha\n\n![Alpha](preview.png)\n', 'mission-control-alpha/preview.png': png(320, 560),
    'evidence/native/install.json': '{"private":"home paths"}\n', '.harness/state.json': '{}\n', 'node_modules/x/index.js': 'x\n', 'drafts/idea.md': 'later\n',
  });
  await reviewLedger(root);
  await fs.mkdir(home);
  const gitconfig = path.join(base, 'gitconfig');
  await fs.writeFile(gitconfig, `[user]\n\tname = Release Fixture\n\temail = release@example.invalid\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n` +
    ['acme/herdr-mission-control', 'acme/existing-name'].map(repo => `[url "${bare}"]\n\tinsteadOf = https://github.com/${repo}.git\n`).join(''));
  // GIT_ALLOW_PROTOCOL=file: any URL not rewritten to the local bare repository fails instead of reaching a network.
  const env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1', GIT_ALLOW_PROTOCOL: 'file', GH_STUB_STATE: path.join(base, 'gh-state.json'), LANG: 'C' };
  const run = (args, cwd = root) => { const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
  run(['init', '-q', '--bare', '-b', 'main', bare], base);
  const ghBin = path.join(base, 'gh');
  await fs.writeFile(ghBin, GH_STUB, { mode: 0o755 });
  await fs.writeFile(env.GH_STUB_STATE, JSON.stringify({ auth: true, repos: {}, bare, calls: [], ...initial }));
  const state = async () => JSON.parse(await fs.readFile(env.GH_STUB_STATE, 'utf8'));
  const patch = async value => fs.writeFile(env.GH_STUB_STATE, JSON.stringify({ ...await state(), ...value }));
  const paths = ['.gitignore', '.ulpi/plans', 'evidence/reviews', 'README.md', 'scripts', 'mission-control', 'mission-control-alpha'];
  const receiptPath = path.join(base, 'release.json');
  const options = { root, paths, repo: 'acme/herdr-mission-control', receiptPath, init: true, gh: ghBin, env, reconcile: passed };
  const remoteFiles = () => { try { return run(['ls-tree', '-r', '--name-only', 'main'], bare).split('\n').filter(Boolean).sort(); } catch { return []; } };
  return { base, root, bare, env, ghBin, state, patch, paths, receiptPath, options, run, remoteFiles };
}

const receiptOf = async f => JSON.parse(await fs.readFile(f.receiptPath, 'utf8'));
const cli = (args, env) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env, timeout: 60000 });
const expectedRemote = ['.gitignore', '.ulpi/plans/mission-control-alpha.json', '.ulpi/plans/mission-control-alpha.md', '.ulpi/plans/mission-control.json', '.ulpi/plans/mission-control.md', 'README.md',
  'evidence/reviews/final.json', 'mission-control-alpha/RECIPE.md', 'mission-control-alpha/mods/mission-control-alpha/main.js', 'mission-control-alpha/mods/mission-control-alpha/mod.json', 'mission-control-alpha/preview.png',
  'mission-control/RECIPE.md', 'mission-control/layouts/mission-control.json', 'mission-control/layouts/mission-control.svg', 'mission-control/mods/mission-control-alpha/main.js', 'mission-control/mods/mission-control-alpha/mod.json',
  'mission-control/preview.png', 'scripts/tool.mjs'].sort();

test('pure gates: credential shapes, redaction, path classes, remotes and recipe links', () => {
  for (const sample of [FAKE_TOKEN, 'github_pat_' + 'a1'.repeat(15), 'glpat-' + 'x'.repeat(20), 'AKIA' + 'ABCDEFGHIJKLMNOP', '-----BEGIN OPENSSH ' + 'PRIVATE KEY-----', 'sk-ant-api03-' + 'z'.repeat(30), 'https://bot:' + 'abcd1234EFGH5678ijkl9012' + '@git.example']) {
    assert.ok(secretFindings(`const x = "${sample}";`).length, sample.slice(0, 12));
  }
  for (const sample of ['fixture-api-token', 'TEST_JIRA_TOKEN', 'https://user:PRIVATE@github.com', 'https://user:PRIVATE_CREDENTIAL@gitlab.com', 'tokenEnv:"GL_TOKEN"']) assert.deepEqual(secretFindings(sample), [], sample);
  const text = redact(`fatal: https://x-access-token:${FAKE_TOKEN}@github.com/a/b.git\n  - Token: gho_secretvalue\nAuthorization: Bearer abcdefghijklmnop\nplain line`);
  assert.doesNotMatch(text, /ghp_|gho_secretvalue|abcdefghijklmnop/);
  assert.match(text, /plain line/);
  assert.deepEqual(['src/a.js', '.env', '.env.local', 'x/auth.json', 'evidence/private/a', 'evidence/native/install.json', '.harness/a', '.browse/s/x.png', 'node_modules/a', 'a.log', 'k.pem', '.ulpi/execution.private.json', 'a/.DS_Store', 'tests/__pycache__/x.pyc', 'evidence/native/agents.json']
    .map(classifyPath), ['ok', 'sensitive', 'sensitive', 'sensitive', 'sensitive', 'sensitive', 'sensitive', 'sensitive', 'sensitive', 'sensitive', 'sensitive', 'sensitive', 'junk', 'junk', 'ok']);
  assert.equal(parseGithubRemote('git@github.com:acme/herdr.git'), 'acme/herdr');
  assert.equal(parseGithubRemote('https://github.com/acme/herdr'), 'acme/herdr');
  assert.equal(parseGithubRemote('ssh://git@github.com/acme/herdr.git'), 'acme/herdr');
  assert.equal(parseGithubRemote('https://gitlab.com/acme/herdr.git'), null);
  assert.throws(() => parseGithubRemote(`https://${FAKE_TOKEN}@github.com/acme/herdr.git`), error => error.code === 'REMOTE_CREDENTIALS' && !error.message.includes(FAKE_TOKEN));
  assert.deepEqual(recipeLinks('mission-control', '![a](preview.png) [b](../x/RECIPE.md#top) [c](https://e.com) [d](#local) [e](<layouts/a b.svg>)'), ['mission-control/preview.png', 'x/RECIPE.md', 'mission-control/layouts/a b.svg']);
  assert.deepEqual(TOPICS, ['herdr-layout', 'herdr-mod']);
});

test('the release and install tooling itself passes the publish scan', async () => {
  await scanFiles(ROOT, ['scripts/release.mjs', 'scripts/install.mjs', 'tests/release.test.mjs', 'tests/install.test.mjs']);
});

test('publish stages only explicit deliverables, creates a public repo, pushes, adds both topics and verifies via the API', async t => {
  const f = await fixture(t);
  const receipt = await publish(f.options);
  assert.equal(receipt.ok, true);
  assert.deepEqual(f.remoteFiles(), expectedRemote, 'Private evidence, .harness, node_modules, ignored drafts and .DS_Store never leave the machine');
  assert.equal(receipt.commit, f.run(['rev-parse', 'main'], f.bare));
  assert.deepEqual(Object.keys(receipt.tree).sort(), expectedRemote);
  assert.deepEqual(receipt.repository, { fullName: 'acme/herdr-mission-control', url: 'https://github.com/acme/herdr-mission-control', visibility: 'public', defaultBranch: 'main' });
  assert.deepEqual(receipt.topics, ['herdr-layout', 'herdr-mod']);
  assert.deepEqual(receipt.remote.topics.names, ['herdr-layout', 'herdr-mod']);
  assert.deepEqual(receipt.packages.map(p => [p.name, p.kind, p.files]), [['mission-control', 'layout', 6], ['mission-control-alpha', 'standalone', 4]]);
  assert.equal(receipt.packages[0].previewUrl, `https://raw.githubusercontent.com/acme/herdr-mission-control/${receipt.commit}/mission-control/preview.png`);
  assert.equal(receipt.packages[1].url, `https://github.com/acme/herdr-mission-control/tree/${receipt.commit}/mission-control-alpha`);
  assert.deepEqual(Object.keys(receipt.reviews), ['mission-control', 'mission-control-alpha']);
  const calls = (await f.state()).calls;
  assert.deepEqual(calls.find(c => c[1] === 'create'), ['repo', 'create', 'acme/herdr-mission-control', '--public', '--description', 'Herdr layouts + mods for running many coding agents across repos and machines: Spaces/Agents rail with context & quota, Jira/GitHub/GitLab boards and PR/MR lists that start Claude Code or Codex in the right worktree, session resume, Reopen last tab/agent, auto-named tabs. Overview and terminal-first Classic views; every mod also standalone.']);
  assert.deepEqual(calls.find(c => c[1] === 'edit'), ['repo', 'edit', 'acme/herdr-mission-control', '--add-topic', 'herdr-layout', '--add-topic', 'herdr-mod']);
  assert.ok(!calls.some(c => c.includes('--show-token') || c[1] === 'token'), 'Authentication material is never requested');
  assert.ok(calls.some(c => c[0] === 'api' && c.at(-1).startsWith('repos/acme/herdr-mission-control/contents/mission-control/RECIPE.md?ref=')));
  assert.equal(f.run(['config', '--get', 'remote.origin.url']), 'https://github.com/acme/herdr-mission-control.git');
  assert.equal((await verifyRelease({ receiptPath: f.receiptPath, root: f.root, gh: f.ghBin, env: f.env })).ok, true);
  const verified = cli(['verify', '--receipt', f.receiptPath, '--root', f.root, '--gh', f.ghBin], f.env);
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).commit, receipt.commit);
  const again = await publish({ ...f.options, init: false });
  assert.equal(again.commit, receipt.commit, 'A rerun with unchanged deliverables pushes nothing new and re-verifies');
});

test('existing remote, repository and default-branch names are respected, never retargeted', async t => {
  const f = await fixture(t, { stub: { repos: { 'acme/existing-name': { visibility: 'public', defaultBranch: 'trunk', topics: [] } } } });
  f.run(['init', '-q', '-b', 'work']);
  f.run(['remote', 'add', 'origin', 'https://github.com/acme/existing-name.git']);
  await assert.rejects(publish({ ...f.options }), error => error.code === 'REMOTE_MISMATCH' && /already points to acme\/existing-name/.test(error.message));
  await assert.rejects(publish({ ...f.options, repo: undefined, branch: 'main' }), error => error.code === 'BRANCH_MISMATCH');
  assert.deepEqual(f.remoteFiles(), []);
  const receipt = await publish({ ...f.options, repo: undefined });
  assert.equal(receipt.repository.fullName, 'acme/existing-name');
  assert.equal(receipt.branch, 'trunk');
  assert.equal(f.run(['rev-parse', 'trunk'], f.bare), receipt.commit);
  assert.equal((await f.state()).calls.some(c => c[1] === 'create'), false, 'An existing repository is reused, not recreated');
  await f.run(['remote', 'set-url', 'origin', `https://${FAKE_TOKEN}@github.com/acme/existing-name.git`]);
  await assert.rejects(publish({ ...f.options, repo: undefined }), error => error.code === 'REMOTE_CREDENTIALS' && !error.message.includes(FAKE_TOKEN));
  assert.doesNotMatch(await fs.readFile(f.receiptPath, 'utf8'), /ghp_/);
});

test('failed authentication exits nonzero, never prints the token and leaves no success receipt', async t => {
  const f = await fixture(t, { stub: { auth: false } });
  await assert.rejects(publish(f.options), error => error instanceof ReleaseError && error.code === 'AUTH_FAILED' && error.gate === 'auth' && !error.message.includes(FAKE_TOKEN));
  const receipt = await receiptOf(f);
  assert.deepEqual([receipt.ok, receipt.gate, receipt.code], [false, 'auth', 'AUTH_FAILED']);
  assert.doesNotMatch(JSON.stringify(receipt), /ghp_/);
  const run = cli(['publish', '--root', f.root, '--repo', 'acme/herdr-mission-control', '--receipt', f.receiptPath, '--init', '--gh', f.ghBin, ...f.paths.flatMap(p => ['--path', p])], f.env);
  assert.equal(run.status, 3, 'The CLI cannot reach auth without current native receipts; local gates fail first');
  assert.match(run.stderr, /NATIVE_RECEIPT \(preflight\)/);
  assert.doesNotMatch(run.stdout + run.stderr, /ghp_/);
  const verify = cli(['verify', '--receipt', f.receiptPath, '--root', f.root, '--gh', f.ghBin], f.env);
  assert.equal(verify.status, 1);
  assert.match(verify.stderr, /RELEASE_FAILED: The recorded release failed at preflight/);
  assert.equal(f.remoteFiles().length, 0);
  assert.equal(await fs.stat(path.join(f.root, '.git')).then(() => true, () => false), false, 'Nothing local is initialized before auth succeeds');
});

test('a private repository is refused before push; a private result after push fails verification', async t => {
  const existing = await fixture(t, { stub: { repos: { 'acme/herdr-mission-control': { visibility: 'private', defaultBranch: null, topics: [] } } } });
  await assert.rejects(publish(existing.options), error => error.code === 'PRIVATE_REPOSITORY' && error.exitCode === 3);
  assert.deepEqual(existing.remoteFiles(), []);
  assert.equal((await existing.state()).calls.some(c => c[1] === 'edit'), false, 'Visibility is never changed automatically');
  const flipped = await fixture(t, { stub: { createVisibility: 'private' } });
  await assert.rejects(publish(flipped.options), error => error.code === 'PRIVATE_REPOSITORY' && error.gate === 'remote-verify');
  assert.deepEqual([(await receiptOf(flipped)).ok, (await receiptOf(flipped)).gate], [false, 'remote-verify']);
  await assert.rejects(verifyRelease({ receiptPath: flipped.receiptPath, root: flipped.root, gh: flipped.ghBin, env: flipped.env }), error => error.code === 'RELEASE_FAILED');
});

test('missing topics, a failed push or tampered remote content never mark the release complete', async t => {
  const topics = await fixture(t, { stub: { dropTopics: true } });
  await assert.rejects(publish(topics.options), error => error.code === 'MISSING_TOPICS' && /herdr-layout, herdr-mod/.test(error.message));
  assert.equal((await receiptOf(topics)).ok, false);
  const push = await fixture(t);
  await fs.writeFile(path.join(push.bare, 'hooks/pre-receive'), '#!/bin/sh\necho "remote: push rejected by policy" >&2\nexit 1\n', { mode: 0o755 });
  await assert.rejects(publish(push.options), error => error.code === 'PUSH_FAILED' && error.gate === 'push');
  assert.deepEqual([(await receiptOf(push)).gate, push.remoteFiles()], ['push', []]);
  assert.equal((await push.state()).calls.some(c => c[1] === 'edit'), false, 'Topics are not added after a failed push');
  const tamper = await fixture(t);
  await publish(tamper.options);
  await tamper.patch({ tamperTree: true });
  await assert.rejects(verifyRelease({ receiptPath: tamper.receiptPath, root: tamper.root, gh: tamper.ghBin, env: tamper.env }), error => error.code === 'REMOTE_CONTENT_MISMATCH');
});

test('leaked paths and credential-like content are rejected before git, gh or the network are used', async t => {
  const f = await fixture(t);
  const refused = async (change, code, more = {}) => {
    await assert.rejects(publish({ ...f.options, ...change }), error => error.code === code && error.gate === 'preflight' && !error.message.includes(FAKE_TOKEN));
    assert.equal((await receiptOf(f)).code, code);
    for (const [key, value] of Object.entries(more)) assert.ok(value(), key);
  };
  await writeFiles(f.root, { '.env': 'A=1\n' });
  await refused({ paths: [...f.paths, '.env'] }, 'LEAKED_PATH');
  await refused({ paths: [...f.paths, '.harness'] }, 'LEAKED_PATH');
  await refused({ paths: [...f.paths, 'evidence/native/install.json'] }, 'LEAKED_PATH');
  await refused({ paths: [...f.paths, '../outside'] }, 'LEAKED_PATH');
  await writeFiles(f.root, { 'mission-control-alpha/auth.json': '{}' });
  await refused({}, 'LEAKED_PATH');
  await fs.rm(path.join(f.root, 'mission-control-alpha/auth.json'));
  await writeFiles(f.root, { 'scripts/leak.mjs': `export const key = "${FAKE_TOKEN}";\n` });
  await refused({}, 'CREDENTIAL_CONTENT');
  await fs.rm(path.join(f.root, 'scripts/leak.mjs'));
  await fs.symlink('/etc/hosts', path.join(f.root, 'scripts/hosts'));
  await refused({}, 'LEAKED_PATH');
  await fs.rm(path.join(f.root, 'scripts/hosts'));
  assert.deepEqual((await f.state()).calls, [], 'No gh call happened');
  assert.equal(await fs.stat(path.join(f.root, '.git')).then(() => true, () => false), false);
  await assert.rejects(publish({ ...f.options, paths: [...f.paths, 'drafts'] }), error => error.code === 'IGNORED_PATH' && /drafts\/idea\.md/.test(error.message));
  assert.deepEqual(f.remoteFiles(), []);
});

test('earlier commits or tracked files outside the explicit deliverables block the push', async t => {
  const f = await fixture(t);
  f.run(['init', '-q', '-b', 'main']);
  await writeFiles(f.root, { 'notes/key.txt': `token ${FAKE_TOKEN}\n` });
  f.run(['add', 'notes/key.txt']);
  f.run(['commit', '-qm', 'old']);
  await assert.rejects(publish(f.options), error => error.code === 'UNSTAGED_TRACKED_PATH' && /notes\/key\.txt/.test(error.message));
  f.run(['rm', '-q', 'notes/key.txt']);
  await assert.rejects(publish(f.options), error => error.code === 'HISTORY_LEAK' && /notes\/key\.txt \(github-token\)/.test(error.message) && !error.message.includes(FAKE_TOKEN));
  assert.deepEqual(f.remoteFiles(), [], 'Nothing was pushed');
  assert.equal((await f.state()).calls.some(c => c[1] === 'create'), false, 'The remote repository is not created when history is unsafe');
});

test('stale reviews, missing previews, incomplete packages or failed native proof block the release locally', async t => {
  const f = await fixture(t);
  const local = (change = {}) => preflight({ root: f.root, paths: f.paths, reconcile: passed, ...change });
  assert.deepEqual((await local()).packages.map(p => p.name), ['mission-control', 'mission-control-alpha']);
  await fs.appendFile(path.join(f.root, '.ulpi/plans/mission-control-alpha.md'), 'edited after review\n');
  await assert.rejects(local(), error => error.code === 'STALE_REVIEW' && /mission-control-alpha/.test(error.message));
  await assert.rejects(publish(f.options), error => error.code === 'STALE_REVIEW');
  assert.equal((await receiptOf(f)).ok, false);
  await reviewLedger(f.root);
  await writeFiles(f.root, { '.ulpi/plans/mission-control-beta.json': '{}' });
  await assert.rejects(local(), error => error.code === 'STALE_REVIEW' && /mission-control-beta/.test(error.message), 'An unreviewed plan is stale');
  await fs.rm(path.join(f.root, '.ulpi/plans/mission-control-beta.json'));
  await assert.rejects(local({ paths: f.paths.filter(p => p !== '.ulpi/plans') }), error => error.code === 'REVIEW_EVIDENCE_UNSTAGED');
  await assert.rejects(local({ paths: [...f.paths.filter(p => p !== 'mission-control-alpha'), 'mission-control-alpha/RECIPE.md', 'mission-control-alpha/mods'] }), error => error.code === 'INCOMPLETE_PACKAGE' && /preview\.png/.test(error.message));
  await assert.rejects(local({ paths: f.paths.filter(p => p !== 'mission-control') }), error => error.code === 'TOPIC_UNSUPPORTED');
  await assert.rejects(local({ reconcile: async ({ name }) => ({ ok: name !== 'mission-control-alpha', reasons: ['PREVIEW_MISMATCH'] }) }), error => error.code === 'NATIVE_RECEIPT' && /mission-control-alpha.*PREVIEW_MISMATCH/.test(error.message));
  await fs.writeFile(path.join(f.root, 'mission-control-alpha/preview.png'), 'not a screenshot');
  await assert.rejects(local(), error => error.code === 'MISSING_PREVIEW');
  await fs.rm(path.join(f.root, 'mission-control-alpha/preview.png'));
  await assert.rejects(local(), error => error.code === 'MISSING_PREVIEW');
  await fs.writeFile(path.join(f.root, 'mission-control-alpha/preview.png'), png());
  await fs.writeFile(path.join(f.root, 'mission-control-alpha/RECIPE.md'), '# Alpha\n\nNo screenshot.\n');
  await assert.rejects(local(), error => error.code === 'RECIPE_PREVIEW_LINK');
  await fs.writeFile(path.join(f.root, 'mission-control-alpha/RECIPE.md'), '# Alpha\n\n![Alpha](preview.png) [gone](mods/missing.md)\n');
  await assert.rejects(local(), error => error.code === 'BROKEN_RECIPE_LINK');
  await fs.writeFile(path.join(f.root, 'mission-control-alpha/RECIPE.md'), '# Alpha\n\n![Alpha](preview.png)\n');
  await writeFiles(f.root, { 'mission-control-alpha/mods/mission-control-other/main.js': 'x' });
  await assert.rejects(local(), error => error.code === 'INVALID_PACKAGE' && /exactly mods\/mission-control-alpha/.test(error.message));
  await fs.rm(path.join(f.root, 'mission-control-alpha/mods/mission-control-other'), { recursive: true });
  await fs.rm(path.join(f.root, 'mission-control/layouts/mission-control.svg'));
  await assert.rejects(local(), error => error.code === 'MISSING_PREVIEW' && /root preview/.test(error.message));
  assert.deepEqual((await f.state()).calls, []);
});

test('verify fails cleanly for a missing, failed or stale receipt and for a repository made private later', async t => {
  const f = await fixture(t);
  const missing = cli(['verify', '--receipt', path.join(f.base, 'none.json'), '--root', f.root, '--gh', f.ghBin], f.env);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /^MISSING_RECEIPT: No release receipt at .*none\.json; it is written only by a real verified publish\./);
  await publish(f.options);
  const good = await receiptOf(f);
  const check = () => verifyRelease({ receiptPath: f.receiptPath, root: f.root, gh: f.ghBin, env: f.env });
  await fs.writeFile(f.receiptPath, JSON.stringify({ ...good, topics: ['herdr-mod'] }));
  await assert.rejects(check(), error => error.code === 'INVALID_RECEIPT');
  await fs.writeFile(f.receiptPath, JSON.stringify(good));
  await fs.appendFile(path.join(f.root, '.ulpi/plans/mission-control.md'), 'revised\n');
  await assert.rejects(check(), error => error.code === 'STALE_REVIEW');
  await reviewLedger(f.root);
  await assert.rejects(check(), error => error.code === 'STALE_REVIEW', 'A re-approved but different plan no longer matches the released review hashes');
  await fs.writeFile(path.join(f.root, '.ulpi/plans/mission-control.md'), '# Mission Control plan\n');
  await reviewLedger(f.root);
  assert.equal((await check()).ok, true);
  const state = await f.state();
  state.repos['acme/herdr-mission-control'].visibility = 'private';
  await f.patch({ repos: state.repos });
  await assert.rejects(check(), error => error.code === 'PRIVATE_REPOSITORY');
});

test('the layout bundle needs manifest bytes, byte-identical standalone mods, its passed native frame and a matching install receipt', async t => {
  const f = await fixture(t);
  const bundle = path.join(f.root, 'mission-control'), installable = {};
  for (const rel of ['layouts/mission-control.json', 'layouts/mission-control.svg', 'mods/mission-control-alpha/main.js', 'mods/mission-control-alpha/mod.json']) installable[rel] = sha(await fs.readFile(path.join(bundle, rel)));
  await fs.writeFile(path.join(bundle, 'build-manifest.json'), JSON.stringify({ v: 1, name: 'mission-control', artifacts: installable }));
  const frame = sha(await fs.readFile(path.join(bundle, 'preview.png')));
  await writeFiles(f.root, { 'evidence/native/layout.json': JSON.stringify({ v: 2, ok: true, frames: [{ label: 'mission-control-overview', sha256: frame }] }) });
  const install = { v: 1, kind: 'mission-control-install', ok: true, state: 'installed', appHome: '/tmp/home', installerSha256: 'a'.repeat(64), source: { root: bundle, name: 'mission-control', files: installable },
    owned: Object.entries(installable).map(([p, s]) => ({ path: p, sha256: s })), createdDirectories: ['mods/mission-control-alpha'], layouts: ['mission-control'], mods: ['mission-control-alpha'], layout: 'mission-control', previousLayout: 'main',
    error: null, rollbackCommand: 'node scripts/install.mjs --rollback --receipt x', validation: { checks: [{ name: 'check', ok: true }], status: { layout: 'mission-control', errors: [] }, frames: { after: { sha256: 'b'.repeat(64), width: 10, height: 10 } }, terminals: { missing: [] }, previews: [{}] } };
  await writeFiles(f.root, { 'evidence/native/install.json': JSON.stringify(install) });
  const validate = async (receipt, { receiptPath }) => receiptPath.endsWith('evidence/native/layout.json') && receipt.ok === true;
  const check = async () => (await reconcileBundle({ name: 'mission-control' }, { root: f.root, validate })).reasons;
  assert.deepEqual(await check(), []);
  await fs.appendFile(path.join(f.root, 'mission-control-alpha/mods/mission-control-alpha/main.js'), '// newer standalone\n');
  assert.deepEqual(await check(), ['STANDALONE_MISMATCH']);
  await fs.writeFile(path.join(f.root, 'mission-control-alpha/mods/mission-control-alpha/main.js'), 'export default class A {}\n');
  await fs.writeFile(path.join(bundle, 'preview.png'), png(1024, 736));
  assert.deepEqual(await check(), ['PREVIEW_MISMATCH']);
  await fs.writeFile(path.join(bundle, 'preview.png'), png());
  assert.deepEqual((await reconcileBundle({ name: 'mission-control' }, { root: f.root, validate: async () => { throw new Error('foreign core'); } })).reasons, ['UNPROVEN_ISOLATION']);
  await writeFiles(f.root, { 'evidence/native/install.json': JSON.stringify({ ...install, state: 'rolled-back', ok: false }) });
  assert.deepEqual(await check(), ['INSTALL_UNVERIFIED']);
  await fs.rm(path.join(f.root, 'evidence/native/install.json'));
  await fs.appendFile(path.join(bundle, 'layouts/mission-control.svg'), '\n');
  assert.deepEqual(await check(), ['ARTIFACT_MISMATCH', 'INSTALL_UNVERIFIED']);
});

test('explicit staging rejects nothing-staged and missing paths', async t => {
  const f = await fixture(t);
  await assert.rejects(expandStaged(f.root, []), error => error.code === 'NOTHING_STAGED');
  await assert.rejects(expandStaged(f.root, ['missing']), error => error.code === 'MISSING_PATH');
  assert.deepEqual((await expandStaged(f.root, ['mission-control'])).filter(file => file.endsWith('.DS_Store')), []);
  const usage = cli(['bogus'], f.env);
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /^Usage:/);
});

test('the repository release check fails cleanly until a real verified publish exists', { skip: await fs.stat(path.join(ROOT, 'evidence/release.json')).then(() => true, () => false) }, () => {
  const run = cli(['verify', '--receipt', path.join(ROOT, 'evidence/release.json')], { PATH: process.env.PATH, HOME: process.env.HOME });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /^MISSING_RECEIPT: /);
});
