import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { publishablePath } from './project.mjs';
import { pngInfo, validateInstallReceipt } from './install.mjs';

const SELF = fileURLToPath(import.meta.url);
export const PROJECT_ROOT = path.resolve(path.dirname(SELF), '..');
export const TOPICS = Object.freeze(['herdr-layout', 'herdr-mod']);
const PACKAGE = /^mission-control(?:-[a-z0-9]+)*$/;
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const posix = file => file.split(path.sep).join('/');
const read = file => fs.readFile(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });

export class ReleaseError extends Error {
  constructor(code, message, { exitCode = 1, gate } = {}) { super(message); this.name = 'ReleaseError'; this.code = code; this.exitCode = exitCode; if (gate) this.gate = gate; }
}
const refuse = (code, message) => { throw new ReleaseError(code, message, { exitCode: 3 }); };
const fail = (code, message) => { throw new ReleaseError(code, message, { exitCode: 1 }); };

/** High-confidence credential shapes only; synthetic fixture strings such as "fixture-api-token" are not credentials. */
const SECRETS = [
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/],
  ['gitlab-token', /\bglpat-[A-Za-z0-9_-]{20,}/],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['private-key', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['openai-key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{40,}/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}/],
  ['atlassian-token', /\bATATT3[A-Za-z0-9_=-]{20,}/],
  ['npm-token', /\bnpm_[A-Za-z0-9]{36}\b/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
];
const URL_CREDENTIAL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"`]+:([^\s/@'"`]{20,})@/gi;

export function secretFindings(text) {
  const found = SECRETS.filter(([, pattern]) => pattern.test(text)).map(([kind]) => kind);
  for (const match of text.matchAll(URL_CREDENTIAL)) if (/[0-9]/.test(match[1]) && /[A-Za-z]/.test(match[1])) { found.push('url-credential'); break; }
  return found;
}

/** Bounded, credential-free text for errors; tool output is never printed whole. */
export function redact(text, limit = 600) {
  let out = String(text ?? '');
  for (const [, pattern] of SECRETS) out = out.replace(new RegExp(pattern.source, 'g'), '[REDACTED]');
  out = out.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"`]+@/gi, '$1[REDACTED]@');
  out = out.replace(/\b(token|authorization|password|passwd|secret|api[_-]?key)(["']?\s*[:=]\s*)\S.*$/gim, '$1$2[REDACTED]').replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{8,}/g, '$1 [REDACTED]');
  return out.length > limit ? out.slice(0, limit) + '…' : out;
}

const JUNK = [/(^|\/)\.DS_Store$/, /(^|\/)__pycache__\//, /\.pyc$/, /(^|\/)\.(?:layout-)?build-[^/]*\//];
const PRIVATE = [/^evidence\/private\//, /^evidence\/native\/install\.json$/, /^\.ulpi\/execution\.private\.json$/, /(^|\/)coverage\//, /\.(?:pem|key|p12|pfx|keychain)$/,
  /(^|\/)id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/, /(^|\/)\.(?:npmrc|netrc|pypirc|git-credentials)$/, /(^|\/)\.git(?:\/|$)/];

/** "junk" is skipped inside a staged folder; "sensitive" always refuses the release; "ok" may be published. */
export function classifyPath(rel) {
  if (JUNK.some(pattern => pattern.test(rel))) return 'junk';
  if (!publishablePath(rel) || PRIVATE.some(pattern => pattern.test(rel))) return 'sensitive';
  return 'ok';
}

async function walk(root, dir, out) {
  for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(dir, entry.name), rel = posix(path.relative(root, file));
    if (entry.isSymbolicLink()) refuse('LEAKED_PATH', `Symlinks cannot be published: ${rel}`);
    if (entry.isDirectory()) { if (classifyPath(rel + '/') === 'junk') continue; await walk(root, file, out); }
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/** Expand explicit deliverable paths to files; any sensitive path (named or inside a named folder) refuses everything. */
export async function expandStaged(root, paths) {
  if (!Array.isArray(paths) || !paths.length) refuse('NOTHING_STAGED', 'Name the deliverable paths to publish with --path or --paths-from');
  const files = new Set(), leaked = [];
  for (const raw of paths) {
    const rel = posix(path.normalize(String(raw))).replace(/\/+$/, '');
    if (!rel || rel === '.' || rel.startsWith('../') || path.isAbsolute(rel)) refuse('LEAKED_PATH', `Staged paths must be inside the repository and explicit: ${raw}`);
    const absolute = path.join(root, rel), stat = await fs.lstat(absolute).catch(() => null);
    if (!stat) refuse('MISSING_PATH', `Staged path does not exist: ${rel}`);
    if (stat.isSymbolicLink()) refuse('LEAKED_PATH', `Symlinks cannot be published: ${rel}`);
    const kind = classifyPath(stat.isDirectory() ? rel + '/' : rel);
    if (kind !== 'ok') { leaked.push(rel); continue; }
    for (const file of stat.isDirectory() ? await walk(root, absolute, []) : [rel]) {
      const fileKind = classifyPath(file);
      if (fileKind === 'sensitive') leaked.push(file); else if (fileKind === 'ok') files.add(file);
    }
  }
  if (leaked.length) refuse('LEAKED_PATH', `Private, credential or generated artifacts cannot be published: ${leaked.slice(0, 10).join(', ')}`);
  return [...files].sort();
}

export async function scanFiles(root, files) {
  const findings = [];
  for (const rel of files) {
    const kinds = secretFindings((await fs.readFile(path.join(root, rel))).toString('latin1'));
    if (kinds.length) findings.push(`${rel} (${kinds.join(', ')})`);
  }
  if (findings.length) refuse('CREDENTIAL_CONTENT', `Credential-like content found: ${findings.slice(0, 10).join('; ')}`);
}

/** Every current plan pair must carry an approved founder review at its exact JSON and Markdown SHA256. */
export async function checkReviews(root) {
  let ledger;
  try { ledger = JSON.parse(await fs.readFile(path.join(root, 'evidence/reviews/final.json'), 'utf8')); } catch { refuse('STALE_REVIEW', 'evidence/reviews/final.json is missing or not JSON'); }
  if (!plain(ledger) || ledger.state !== 'approved' || ledger.verdict !== 'APPROVE' || (ledger.pending ?? []).length || !Array.isArray(ledger.plans)) refuse('STALE_REVIEW', 'The review ledger is not a complete approval');
  const names = (await fs.readdir(path.join(root, '.ulpi/plans')).catch(() => [])).filter(file => file.endsWith('.json')).map(file => file.slice(0, -5)).sort();
  if (!names.length) refuse('STALE_REVIEW', 'No plans were found under .ulpi/plans');
  const reviewed = new Map(ledger.plans.map(plan => [plan?.name, plan])), hashes = {}, stale = [];
  for (const name of names) {
    const json = await read(path.join(root, '.ulpi/plans', name + '.json')), md = await read(path.join(root, '.ulpi/plans', name + '.md'));
    const entry = reviewed.get(name), current = { json: sha(json), md: md ? sha(md) : null };
    if (!entry || entry.verdict !== 'APPROVE' || entry.blocks !== 0 || entry.concerns !== 0 || entry.sha256?.json !== current.json || entry.sha256?.md !== current.md) stale.push(name);
    hashes[name] = current;
  }
  if (stale.length) refuse('STALE_REVIEW', `Plans changed since their founder review or were never reviewed: ${stale.join(', ')}`);
  return hashes;
}

const LINK = /!?\[[^\]]*\]\(\s*(?:<([^>\n]+)>|([^)\s]+))(?:\s+"[^"]*")?\s*\)/g;
/** Relative Markdown link targets of a recipe, resolved to repository paths. */
export function recipeLinks(pkg, text) {
  const out = [];
  for (const match of text.matchAll(LINK)) {
    const target = match[1] ?? match[2];
    if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)) continue;
    out.push(path.posix.normalize(path.posix.join(pkg, decodeURIComponent(target.split('#')[0].split('?')[0]))));
  }
  return out;
}

const resolves = (target, files) => files.has(target) || [...files].some(file => file.startsWith(target.replace(/\/$/, '') + '/'));
function recipeProblems(pkg, text, has) {
  if (!text?.trim() || text.includes('�') || !/^# \S/.test(text)) return 'MISSING_RECIPE';
  if (!/!\[[^\]]*\]\(\s*<?(?:\.\/)?preview\.png>?\s*\)/.test(text)) return 'RECIPE_PREVIEW_LINK';
  if (recipeLinks(pkg, text).some(target => target.startsWith('../') || !has(target))) return 'BROKEN_RECIPE_LINK';
  return null;
}

/** Complete package folders: recipe, real preview, own mod (standalone) or layouts with resolvable previews (bundle), every file staged. */
export async function inspectPackages(root, files, { reconcile = defaultReconcile } = {}) {
  const staged = new Set(files), names = [...new Set(files.map(file => file.split('/')[0]).filter(name => PACKAGE.test(name)))].sort(), packages = [];
  for (const name of names) {
    const dir = path.join(root, name), onDisk = await walk(root, dir, []);
    const leaked = onDisk.filter(file => classifyPath(file) === 'sensitive');
    if (leaked.length) refuse('LEAKED_PATH', `Package contains private or generated artifacts: ${leaked.slice(0, 5).join(', ')}`);
    const unstaged = onDisk.filter(file => classifyPath(file) === 'ok' && !staged.has(file));
    if (unstaged.length) refuse('INCOMPLETE_PACKAGE', `Stage the whole package folder ${name}/; missing: ${unstaged.slice(0, 5).join(', ')}`);
    const recipe = await read(path.join(dir, 'RECIPE.md')), preview = await read(path.join(dir, 'preview.png'));
    if (!preview || !pngInfo(preview)) refuse('MISSING_PREVIEW', `${name}/preview.png is missing or not a PNG screenshot`);
    const problem = recipeProblems(name, recipe && new TextDecoder('utf-8', { fatal: false }).decode(recipe), target => resolves(target, staged));
    if (problem) refuse(problem, `${name}/RECIPE.md must be a titled brief showing ![...](preview.png) with resolvable relative links`);
    const layouts = onDisk.filter(file => file.startsWith(`${name}/layouts/`)), mods = [...new Set(onDisk.filter(file => file.startsWith(`${name}/mods/`)).map(file => file.split('/')[2]))];
    const kind = layouts.length ? 'layout' : 'standalone';
    if (kind === 'standalone') {
      if (mods.length !== 1 || mods[0] !== name || !staged.has(`${name}/mods/${name}/main.js`) || !staged.has(`${name}/mods/${name}/mod.json`)) refuse('INVALID_PACKAGE', `${name}/ must contain exactly mods/${name}/ with main.js and mod.json`);
    } else {
      const trees = layouts.filter(file => /^[^/]+\/layouts\/[^/]+\.json$/.test(file));
      if (!trees.length) refuse('INVALID_PACKAGE', `${name}/layouts/ has no layout JSON`);
      for (const file of trees) {
        let tree; try { tree = JSON.parse(await fs.readFile(path.join(root, file), 'utf8')); } catch { refuse('INVALID_PACKAGE', `${file} is not JSON`); }
        if (typeof tree?.preview !== 'string' || !/^layouts\/[^/]+\.(?:svg|png)$/.test(tree.preview) || !staged.has(`${name}/${tree.preview}`)) refuse('MISSING_PREVIEW', `${file} root preview does not resolve inside ${name}/`);
        const wanted = new Set();
        const visit = value => { if (Array.isArray(value)) value.forEach(visit); else if (plain(value)) for (const [key, item] of Object.entries(value)) { if (key === 'mod' && typeof item === 'string' && PACKAGE.test(item)) wanted.add(item); else visit(item); } };
        visit(tree);
        for (const mod of wanted) if (!mods.includes(mod)) refuse('INVALID_PACKAGE', `${file} needs mods/${mod}/ inside ${name}/`);
      }
    }
    const native = await reconcile({ name, kind }, { root });
    if (native?.ok !== true) refuse('NATIVE_RECEIPT', `${name} has no current passed native/install proof: ${(native?.reasons ?? ['UNKNOWN']).join(', ')}`);
    packages.push({ name, kind, files: onDisk.filter(file => staged.has(file)).length, preview: { sha256: sha(preview), ...pngInfo(preview) } });
  }
  if (!packages.some(p => p.kind === 'layout') || !packages.some(p => p.kind === 'standalone')) {
    refuse('TOPIC_UNSUPPORTED', 'Both discovery topics need at least one complete layout package and one standalone mod package');
  }
  return packages;
}

async function filesBelow(dir) {
  const out = {};
  const visit = async at => {
    for (const entry of await fs.readdir(at, { withFileTypes: true }).catch(() => [])) {
      const file = path.join(at, entry.name);
      if (entry.isDirectory()) await visit(file); else if (entry.isFile() && entry.name !== '.DS_Store') out[posix(path.relative(dir, file))] = sha(await fs.readFile(file));
    }
  };
  await visit(dir);
  return out;
}

/** Layout bundle proof: manifest bytes, byte-identical standalone mods, passed isolated layout receipt with this preview, and a matching install receipt. */
export async function reconcileBundle({ name }, { root, validate, installReceiptPath = path.join(root, 'evidence/native/install.json'), layoutReceiptPath = path.join(root, 'evidence/native/layout.json') } = {}) {
  const reasons = [], dir = path.join(root, name);
  let manifest = null; try { manifest = JSON.parse(await fs.readFile(path.join(dir, 'build-manifest.json'), 'utf8')); } catch {}
  const installable = Object.fromEntries(Object.entries(await filesBelow(dir)).filter(([rel]) => /^(?:layouts|mods)\//.test(rel)));
  if (!plain(manifest?.artifacts)) reasons.push('MISSING_MANIFEST');
  else if (!isDeepStrictEqual(Object.fromEntries(Object.entries(manifest.artifacts).filter(([rel]) => /^(?:layouts|mods)\//.test(rel))), installable)) reasons.push('ARTIFACT_MISMATCH');
  for (const mod of new Set(Object.keys(installable).filter(rel => rel.startsWith('mods/')).map(rel => rel.split('/')[1]))) {
    const bundled = Object.fromEntries(Object.entries(installable).filter(([rel]) => rel.startsWith(`mods/${mod}/`)).map(([rel, digest]) => [rel.slice(`mods/${mod}/`.length), digest]));
    if (!isDeepStrictEqual(bundled, await filesBelow(path.join(root, mod, 'mods', mod)))) { reasons.push('STANDALONE_MISMATCH'); break; }
  }
  const preview = await read(path.join(dir, 'preview.png'));
  let layout = null; try { layout = JSON.parse(await fs.readFile(layoutReceiptPath, 'utf8')); } catch {}
  if (!layout) reasons.push('MISSING_RECEIPT');
  else {
    try { if (await (validate ?? (await import('./native-harness.mjs')).validateNativeIsolationReceipt)(layout, { receiptPath: layoutReceiptPath }) !== true) reasons.push('UNPROVEN_ISOLATION'); }
    catch { reasons.push('UNPROVEN_ISOLATION'); }
    if (!preview || !layout.frames?.some?.(frame => frame?.sha256 === sha(preview))) reasons.push('PREVIEW_MISMATCH');
  }
  let installed = null; try { installed = validateInstallReceipt(JSON.parse(await fs.readFile(installReceiptPath, 'utf8'))); } catch {}
  if (!installed || installed.state !== 'installed' || !isDeepStrictEqual(installed.source.files, installable)) reasons.push('INSTALL_UNVERIFIED');
  return { name, ok: !reasons.length, reasons };
}

export async function defaultReconcile({ name, kind }, { root }) {
  if (kind === 'layout') return reconcileBundle({ name }, { root });
  const { reconcilePackage } = await import('./verify-gitlab-compatibility.mjs');
  return reconcilePackage({ name, scenario: name.slice('mission-control-'.length) }, { root });
}

function tool(bin, { env, cwd, label }) {
  const quiet = { ...env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', GH_NO_UPDATE_NOTIFIER: '1', GH_SPINNER_DISABLED: '1', NO_COLOR: '1', GH_PAGER: 'cat', GIT_PAGER: 'cat', PAGER: 'cat' };
  return (args, { input, raw = false, code = 'COMMAND_FAILED', allowFail = false } = {}) => {
    const result = spawnSync(bin, args, { cwd, env: quiet, maxBuffer: 256 * 1024 * 1024, timeout: 300000,
      ...(raw ? { input: typeof input === 'string' ? Buffer.from(input) : input } : { input, encoding: 'utf8' }) });
    if (!allowFail && (result.error || result.status !== 0)) {
      const detail = result.error?.message ?? (raw ? result.stderr?.toString('utf8') : result.stderr) ?? '';
      const shown = args[0] === 'api' ? ['api', String(args.at(-1)).split('?')[0]] : args.slice(0, 2);
      fail(code, `${label} ${shown.join(' ')} failed: ${redact(detail.trim() || `exit ${result.status}`, 400)}`);
    }
    return result;
  };
}

/** github.com remotes only; embedded credentials are refused and never echoed. */
export function parseGithubRemote(url) {
  const text = String(url ?? '').trim();
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/]*@/i.test(text) && !/^ssh:\/\/git@github\.com\//i.test(text)) refuse('REMOTE_CREDENTIALS', 'The configured remote URL embeds credentials; replace it with a plain https or ssh URL');
  const match = text.match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i);
  return match ? `${match[1]}/${match[2]}` : null;
}

function ghJson(gh, endpoint, code) {
  const result = gh(['api', '-H', 'Accept: application/vnd.github+json', endpoint], { code });
  try { return JSON.parse(result.stdout); } catch { fail(code, `gh api ${endpoint.split('?')[0]} did not return JSON`); }
}

/** Remote truth via gh API: public, default branch, both topics, exact tree and every package recipe/preview link. */
export async function verifyRemote({ gh, repo, branch, commit, treeSha, tree, packages, exactHead }) {
  const info = ghJson(gh, `repos/${repo}`, 'REMOTE_VERIFY_FAILED');
  if (String(info.full_name).toLowerCase() !== repo.toLowerCase()) fail('REPOSITORY_MISMATCH', `The API returned a different repository for ${repo}`);
  if (info.private !== false || info.visibility !== 'public') fail('PRIVATE_REPOSITORY', `${repo} is not public`);
  if (info.default_branch !== branch) fail('DEFAULT_BRANCH', `${repo} default branch is ${info.default_branch}, not ${branch}`);
  const topics = ghJson(gh, `repos/${repo}/topics`, 'REMOTE_VERIFY_FAILED').names ?? [];
  const missing = TOPICS.filter(topic => !topics.includes(topic));
  if (missing.length) fail('MISSING_TOPICS', `${repo} lacks discovery topic(s): ${missing.join(', ')}`);
  let head;
  if (exactHead) {
    head = ghJson(gh, `repos/${repo}/commits/${branch}`, 'REMOTE_VERIFY_FAILED');
    if (head.sha !== commit) fail('REMOTE_HEAD_MISMATCH', `${repo}@${branch} is ${String(head.sha).slice(0, 12)}, not the pushed ${commit.slice(0, 12)}`);
    if (head.commit?.tree?.sha !== treeSha) fail('REMOTE_CONTENT_MISMATCH', 'The remote commit tree differs from the published tree');
  } else {
    const compare = ghJson(gh, `repos/${repo}/compare/${commit}...${branch}`, 'COMMIT_NOT_ON_BRANCH');
    if (!['identical', 'ahead'].includes(compare.status)) fail('COMMIT_NOT_ON_BRANCH', `${commit.slice(0, 12)} is not contained in ${repo}@${branch}`);
    head = { sha: compare.status === 'identical' ? commit : null };
  }
  const listing = ghJson(gh, `repos/${repo}/git/trees/${treeSha}?recursive=1`, 'REMOTE_CONTENT_MISMATCH');
  if (listing.truncated !== false || !Array.isArray(listing.tree)) fail('REMOTE_CONTENT_MISMATCH', 'The remote tree listing is truncated or invalid');
  const remote = Object.fromEntries(listing.tree.filter(entry => entry.type === 'blob').map(entry => [entry.path, entry.sha]));
  if (!isDeepStrictEqual(remote, tree)) {
    const differs = [...new Set([...Object.keys(tree), ...Object.keys(remote)])].filter(file => tree[file] !== remote[file]);
    fail('REMOTE_CONTENT_MISMATCH', `Remote files differ from the published tree: ${differs.slice(0, 10).join(', ')}`);
  }
  for (const pkg of packages) {
    const kind = Object.keys(remote).some(file => file.startsWith(`${pkg.name}/layouts/`)) ? 'layout' : 'standalone';
    if (kind !== pkg.kind || !remote[`${pkg.name}/preview.png`]) fail('MISSING_PREVIEW', `${pkg.name} preview or package kind is missing remotely`);
    const content = ghJson(gh, `repos/${repo}/contents/${pkg.name}/RECIPE.md?ref=${commit}`, 'MISSING_RECIPE');
    const text = content.encoding === 'base64' ? Buffer.from(String(content.content ?? ''), 'base64').toString('utf8') : null;
    const problem = recipeProblems(pkg.name, text, target => resolves(target, new Set(Object.keys(remote))));
    if (problem) fail(problem, `${pkg.name}/RECIPE.md links do not resolve on ${repo}@${commit.slice(0, 12)}`);
  }
  if (!TOPICS.every(topic => packages.some(p => p.kind === (topic === 'herdr-layout' ? 'layout' : 'standalone')))) fail('TOPIC_UNSUPPORTED', 'Each discovery topic needs a matching package');
  return { repo: { full_name: info.full_name, private: info.private, visibility: info.visibility, default_branch: info.default_branch, html_url: info.html_url }, topics: { names: [...topics].sort() }, head: { sha: head.sha } };
}

async function writeReceipt(file, receipt) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  await fs.writeFile(temporary, JSON.stringify(receipt, null, 2) + '\n');
  await fs.rename(temporary, file);
}

/** Local gates only (no git, gh or network): explicit paths, leak/credential scan, review hashes, complete packages and native receipts. */
export async function preflight({ root = PROJECT_ROOT, paths, reconcile = defaultReconcile } = {}) {
  root = await fs.realpath(root);
  const files = await expandStaged(root, paths);
  await scanFiles(root, files);
  const reviews = await checkReviews(root);
  const required = ['evidence/reviews/final.json', ...Object.keys(reviews).flatMap(name => [`.ulpi/plans/${name}.json`, `.ulpi/plans/${name}.md`])];
  const unstaged = required.filter(file => !files.includes(file));
  if (unstaged.length) refuse('REVIEW_EVIDENCE_UNSTAGED', `Stage the reviewed plans and review ledger: ${unstaged.slice(0, 6).join(', ')}`);
  const packages = await inspectPackages(root, files, { reconcile });
  return { root, files, reviews, packages };
}

function historyBlobs(git) {
  const objects = git(['rev-list', '--objects', 'HEAD'], { code: 'HISTORY_SCAN_FAILED' }).stdout.split('\n').filter(Boolean).map(line => [line.slice(0, 40), line.slice(41)]);
  const types = git(['cat-file', '--batch-check=%(objectname) %(objecttype)'], { input: objects.map(([id]) => id).join('\n') + '\n', code: 'HISTORY_SCAN_FAILED' }).stdout.split('\n');
  const blobs = new Map();
  types.forEach((line, index) => { if (line.endsWith(' blob') && objects[index]) blobs.set(objects[index][0], objects[index][1]); });
  if (!blobs.size) return [];
  const out = git(['cat-file', '--batch'], { input: [...blobs.keys()].join('\n') + '\n', raw: true, code: 'HISTORY_SCAN_FAILED' }).stdout, items = [];
  for (let at = 0; at < out.length;) {
    const end = out.indexOf(10, at), [id, , size] = out.subarray(at, end).toString('latin1').split(' '), length = Number(size);
    items.push({ path: blobs.get(id), text: out.subarray(end + 1, end + 1 + length).toString('latin1') });
    at = end + 1 + length + 1;
  }
  return items;
}

const failure = (gate, error) => ({ v: 1, kind: 'mission-control-release', ok: false, gate, code: error.code ?? 'RELEASE_FAILED', error: redact(error.message, 1200), completedMs: Date.now() });

/** Publish explicitly staged deliverables to a public GitHub repository and record only a fully verified result. */
export async function publish({ root = PROJECT_ROOT, paths, repo, remote = 'origin', branch, message = 'Publish Mission Control packages', description = 'Mission Control layouts and standalone mods for the Herdr app',
  receiptPath = path.join(PROJECT_ROOT, 'evidence/release.json'), init = false, git: gitBin = 'git', gh: ghBin = 'gh', env = process.env, reconcile = defaultReconcile, log = () => {} } = {}) {
  let gate = 'preflight';
  try {
    if (repo !== undefined && !REPO.test(repo)) refuse('USAGE', 'Pass --repo as owner/name');
    const local = await preflight({ root, paths, reconcile });
    root = local.root;
    const git = tool(gitBin, { env, cwd: root, label: 'git' }), gh = tool(ghBin, { env, cwd: root, label: 'gh' });
    gate = 'auth';
    gh(['auth', 'status', '--hostname', 'github.com'], { code: 'AUTH_FAILED' });
    gate = 'repository';
    const top = git(['rev-parse', '--show-toplevel'], { allowFail: true });
    const isRepo = top.status === 0 && await fs.realpath(top.stdout.trim()).catch(() => null) === root;
    if (!isRepo && !init) refuse('NOT_A_REPOSITORY', `${root} is not its own git repository; pass --init to create one`);
    // The raw configured URL: `remote get-url` would expand insteadOf rewrites.
    const existingUrl = isRepo ? git(['config', '--get', `remote.${remote}.url`], { allowFail: true }) : { status: 1 };
    let target = repo;
    if (existingUrl.status === 0) {
      const named = parseGithubRemote(existingUrl.stdout);
      if (!named) refuse('REMOTE_MISMATCH', `Remote ${remote} is not a github.com repository`);
      if (repo && named.toLowerCase() !== repo.toLowerCase()) refuse('REMOTE_MISMATCH', `Remote ${remote} already points to ${named}; it is not retargeted to ${repo}`);
      target = named;
    }
    if (!target) refuse('USAGE', 'Pass --repo owner/name (no existing remote names one)');
    const view = gh(['repo', 'view', target, '--json', 'nameWithOwner,visibility,isPrivate,defaultBranchRef,isEmpty'], { allowFail: true });
    let existing = null;
    if (view.status === 0) { try { existing = JSON.parse(view.stdout); } catch { fail('REPOSITORY_LOOKUP_FAILED', `gh repo view ${target} did not return JSON`); } }
    else if (!/could not resolve to a repository|not found|HTTP 404/i.test(view.stderr ?? '')) fail('REPOSITORY_LOOKUP_FAILED', `gh repo view ${target} failed: ${redact(view.stderr, 300)}`);
    if (existing) {
      if (existing.isPrivate !== false || String(existing.visibility).toUpperCase() !== 'PUBLIC') refuse('PRIVATE_REPOSITORY', `${existing.nameWithOwner ?? target} exists and is not public; it is never made public automatically`);
      target = existing.nameWithOwner ?? target;
      const current = existing.defaultBranchRef?.name;
      if (current && branch && current !== branch) refuse('BRANCH_MISMATCH', `${target} uses default branch ${current}; it is not changed to ${branch}`);
      branch = current || branch || 'main';
    } else branch = branch || 'main';
    gate = 'stage';
    if (!isRepo) git(['init', '-q', '-b', branch], { code: 'INIT_FAILED' });
    const check = git(['check-ignore', '--no-index', '--stdin', '-z'], { input: local.files.join('\0') + '\0', allowFail: true });
    if (check.error || check.status > 1) fail('STAGE_FAILED', `git check-ignore failed: ${redact(check.stderr, 300)}`);
    const ignored = check.stdout.split('\0').filter(Boolean);
    if (ignored.length) refuse('IGNORED_PATH', `.gitignore excludes staged deliverables: ${ignored.slice(0, 10).join(', ')}`);
    git(['--literal-pathspecs', 'add', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: local.files.join('\0') + '\0', code: 'STAGE_FAILED' });
    const indexed = git(['ls-files', '-z'], { code: 'STAGE_FAILED' }).stdout.split('\0').filter(Boolean).sort();
    const extra = indexed.filter(file => !local.files.includes(file));
    if (extra.length) refuse('UNSTAGED_TRACKED_PATH', `Tracked files are not in the explicit deliverables: ${extra.slice(0, 10).join(', ')}`);
    if (!isDeepStrictEqual(indexed, local.files)) fail('STAGE_FAILED', 'The git index does not hold exactly the staged deliverables');
    const hasHead = git(['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true }).status === 0;
    if (!hasHead || git(['diff', '--cached', '--quiet'], { allowFail: true }).status !== 0) git(['commit', '-q', '-m', message], { code: 'COMMIT_FAILED' });
    const commit = git(['rev-parse', 'HEAD'], { code: 'COMMIT_FAILED' }).stdout.trim(), treeSha = git(['rev-parse', 'HEAD^{tree}'], { code: 'COMMIT_FAILED' }).stdout.trim();
    const tree = {};
    for (const line of git(['ls-tree', '-r', '-z', 'HEAD'], { code: 'COMMIT_FAILED' }).stdout.split('\0').filter(Boolean)) { const [meta, file] = line.split('\t'); tree[file] = meta.split(' ')[2]; }
    if (!isDeepStrictEqual(Object.keys(tree).sort(), local.files)) fail('STAGE_FAILED', 'The commit tree does not hold exactly the staged deliverables');
    const history = historyBlobs(git), leaks = [];
    for (const blob of history) { if (classifyPath(blob.path) === 'sensitive') leaks.push(blob.path); else if (secretFindings(blob.text).length) leaks.push(`${blob.path} (${secretFindings(blob.text).join(', ')})`); }
    if (leaks.length) refuse('HISTORY_LEAK', `Commit history would publish private or credential-like content: ${[...new Set(leaks)].slice(0, 10).join(', ')}`);
    gate = 'push';
    if (!existing) gh(['repo', 'create', target, '--public', '--description', description], { code: 'CREATE_FAILED' });
    if (existingUrl.status !== 0) git(['remote', 'add', remote, `https://github.com/${target}.git`], { code: 'REMOTE_FAILED' });
    git(['push', '--porcelain', remote, `HEAD:refs/heads/${branch}`], { code: 'PUSH_FAILED' });
    gate = 'topics';
    gh(['repo', 'edit', target, ...TOPICS.flatMap(topic => ['--add-topic', topic])], { code: 'TOPICS_FAILED' });
    gate = 'remote-verify';
    const remoteState = await verifyRemote({ gh, repo: target, branch, commit, treeSha, tree, packages: local.packages, exactHead: true });
    const base = `https://github.com/${target}`;
    const receipt = { v: 1, kind: 'mission-control-release', ok: true, completedMs: Date.now(),
      repository: { fullName: target, url: base, visibility: 'public', defaultBranch: branch }, branch, commit, treeSha, commitUrl: `${base}/commit/${commit}`, topics: [...TOPICS],
      packages: local.packages.map(p => ({ ...p, url: `${base}/tree/${commit}/${p.name}`, recipeUrl: `${base}/blob/${commit}/${p.name}/RECIPE.md`, previewUrl: `https://raw.githubusercontent.com/${target}/${commit}/${p.name}/preview.png` })),
      reviews: local.reviews, tree, remote: remoteState,
      boundary: 'GitHub API verification of the pushed public tree, topics and recipe/preview links. Package native proof is the staged receipts; no provider authentication is implied.' };
    await writeReceipt(receiptPath, receipt);
    log(`Published ${target}@${commit}`);
    return receipt;
  } catch (error) {
    const wrapped = error instanceof ReleaseError ? error : new ReleaseError('RELEASE_FAILED', redact(error.message));
    wrapped.gate = gate;
    if (wrapped.code !== 'USAGE' && receiptPath) await writeReceipt(receiptPath, failure(gate, wrapped)).catch(() => {});
    throw wrapped;
  }
}

/** Re-prove a recorded release against the live API and current review hashes; a failed or missing receipt never verifies. */
export async function verifyRelease({ receiptPath, root = PROJECT_ROOT, gh: ghBin = 'gh', env = process.env } = {}) {
  const text = await fs.readFile(receiptPath, 'utf8').catch(error => { if (error.code === 'ENOENT') fail('MISSING_RECEIPT', `No release receipt at ${receiptPath}; it is written only by a real verified publish.`); throw error; });
  let receipt; try { receipt = JSON.parse(text); } catch { fail('INVALID_RECEIPT', `Release receipt is not JSON: ${receiptPath}`); }
  if (!plain(receipt) || receipt.v !== 1 || receipt.kind !== 'mission-control-release') fail('INVALID_RECEIPT', 'Release receipt has the wrong version or kind');
  if (receipt.ok !== true) fail('RELEASE_FAILED', `The recorded release failed at ${receipt.gate ?? 'an unknown gate'} (${receipt.code ?? 'no code'})`);
  const r = receipt;
  if (!REPO.test(r.repository?.fullName ?? '') || !SHA1.test(r.commit ?? '') || !SHA1.test(r.treeSha ?? '') || typeof r.branch !== 'string' || !plain(r.tree) || !Object.values(r.tree).every(value => SHA1.test(value))
    || !isDeepStrictEqual([...(r.topics ?? [])].sort(), [...TOPICS]) || !Array.isArray(r.packages) || !r.packages.length || r.packages.some(p => !PACKAGE.test(p?.name ?? '') || !['layout', 'standalone'].includes(p.kind))) {
    fail('INVALID_RECEIPT', 'Release receipt is incomplete');
  }
  const reviews = await checkReviews(await fs.realpath(root));
  if (!isDeepStrictEqual(reviews, r.reviews)) fail('STALE_REVIEW', 'Plans or reviews changed since this release was published');
  const gh = tool(ghBin, { env, cwd: root, label: 'gh' });
  const remote = await verifyRemote({ gh, repo: r.repository.fullName, branch: r.branch, commit: r.commit, treeSha: r.treeSha, tree: r.tree, packages: r.packages, exactHead: false });
  return { ok: true, repository: r.repository.url, commit: r.commit, branch: r.branch, topics: remote.topics.names, packages: r.packages.map(p => ({ name: p.name, kind: p.kind, url: p.url })) };
}

const USAGE = `Usage:
  node scripts/release.mjs preflight (--path <deliverable>)... [--paths-from <file>] [--root <dir>]
  node scripts/release.mjs publish [--repo <owner/name>] (--path <deliverable>)... [--paths-from <file>] [--remote origin] [--branch <name>]
                                   [--message <text>] [--receipt evidence/release.json] [--init] [--git <bin>] [--gh <bin>] [--root <dir>]
  node scripts/release.mjs verify [--receipt evidence/release.json] [--gh <bin>] [--root <dir>]`;

export async function parseArgs(argv) {
  const [command, ...rest] = argv, options = { paths: [] };
  const values = new Set(['--repo', '--path', '--paths-from', '--remote', '--branch', '--message', '--receipt', '--git', '--gh', '--root']);
  if (!['preflight', 'publish', 'verify'].includes(command)) throw new ReleaseError('USAGE', USAGE, { exitCode: 2 });
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === '--init') options.init = true;
    else if (values.has(arg) && index + 1 < rest.length) {
      const value = rest[++index];
      if (arg === '--path') options.paths.push(value);
      else if (arg === '--paths-from') options.paths.push(...(await fs.readFile(path.resolve(value), 'utf8')).split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#')));
      else options[arg.slice(2)] = value;
    } else throw new ReleaseError('USAGE', `Unknown or incomplete argument: ${arg}\n${USAGE}`, { exitCode: 2 });
  }
  return { command, ...options };
}

async function main(argv) {
  const options = await parseArgs(argv), env = process.env;
  const root = options.root ? path.resolve(options.root) : PROJECT_ROOT, receiptPath = options.receipt ? path.resolve(options.receipt) : path.join(root, 'evidence/release.json');
  const gh = options.gh ?? env.MISSION_CONTROL_GH ?? 'gh', git = options.git ?? env.MISSION_CONTROL_GIT ?? 'git';
  if (options.command === 'verify') return console.log(JSON.stringify(await verifyRelease({ receiptPath, root, gh, env }), null, 2));
  if (options.command === 'preflight') {
    const result = await preflight({ root, paths: options.paths });
    return console.log(JSON.stringify({ ok: true, files: result.files.length, packages: result.packages, reviewedPlans: Object.keys(result.reviews) }, null, 2));
  }
  const receipt = await publish({ root, paths: options.paths, repo: options.repo, remote: options.remote, branch: options.branch, message: options.message, receiptPath, init: options.init, git, gh, env });
  console.log(JSON.stringify({ ok: true, repository: receipt.repository.url, commit: receipt.commit, topics: receipt.topics, packages: receipt.packages.map(p => p.url), receipt: receiptPath }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  main(process.argv.slice(2)).catch(error => {
    console.error(redact(error.code && error.code !== 'USAGE' ? `${error.code}${error.gate ? ` (${error.gate})` : ''}: ${error.message}` : error.message, 2000));
    process.exitCode = error.exitCode || 1;
  });
}
