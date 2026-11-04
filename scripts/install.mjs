import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const SELF = fileURLToPath(import.meta.url);
export const PROJECT_ROOT = path.resolve(path.dirname(SELF), '..');
const NAME = /^mission-control(?:-[a-z0-9]+)*$/;
const HEX = /^[a-f0-9]{64}$/;
const CODE = /\.(?:m?js|cjs|py|sh)$/;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const posix = file => file.split(path.sep).join('/');
const inside = (file, parent) => file === parent || file.startsWith(parent + path.sep);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const lstat = file => fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
const quote = value => /^[A-Za-z0-9_./:@-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
const installerSha256 = async () => sha(await fs.readFile(SELF));
/** Canonical path of a file that may not exist yet: realpath its nearest existing ancestor. */
async function canonical(file) {
  let at = path.resolve(file), rest = [];
  for (;;) {
    try { return path.join(await fs.realpath(at), ...rest); }
    catch (error) { if (error.code !== 'ENOENT' || path.dirname(at) === at) throw error; rest.unshift(path.basename(at)); at = path.dirname(at); }
  }
}

export class InstallError extends Error {
  constructor(code, message, { exitCode = 1, details } = {}) {
    super(message); this.name = 'InstallError'; this.code = code; this.exitCode = exitCode;
    if (details !== undefined) this.details = details;
  }
}
const refuse = (code, message, details) => { throw new InstallError(code, message, { exitCode: 3, details }); };
const fail = (code, message, details) => { throw new InstallError(code, message, { exitCode: 1, details }); };

export function defaultAppHome(env = process.env) {
  return env.HERDR_APP_HOME || path.join(os.homedir(), '.config/herdr-app');
}

/** PNG signature plus a bounded IHDR size; anything else is not a captured frame. */
export function pngInfo(bytes) {
  if (!bytes || bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  return width > 0 && height > 0 && width <= 32768 && height <= 32768 ? { width, height } : null;
}

async function json(file, code, label) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; refuse(code, `${label} is not valid JSON`); }
}

async function walk(root, dir = root, out = []) {
  for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) refuse('INVALID_PACKAGE', `Symlinks cannot be installed: ${posix(path.relative(root, file))}`);
    if (entry.isDirectory()) await walk(root, file, out);
    else if (entry.isFile()) out.push(posix(path.relative(root, file)));
    else refuse('INVALID_PACKAGE', `Unsupported package entry: ${posix(path.relative(root, file))}`);
  }
  return out;
}

/** Every mod / layout name a layout tree depends on: content and header mods plus the root terminal menu. */
export function layoutReferences(tree) {
  const found = new Set();
  const visit = (value, key) => {
    if (Array.isArray(value)) return value.forEach(item => visit(item));
    if (!plain(value)) { if (typeof value === 'string' && (key === 'mod' || key === 'terminal_menu' || key === 'header' && value !== 'tabs')) found.add(value); return; }
    for (const [child, item] of Object.entries(value)) visit(item, child);
  };
  visit(tree);
  return [...found].sort();
}

function verifyManifest(pkg, manifest) {
  if (!plain(manifest) || !plain(manifest.artifacts)) refuse('UNMANIFESTED_PACKAGE', 'The package has no build-manifest.json artifact list');
  const installable = [...pkg.files.keys()];
  const rooted = Object.keys(manifest.artifacts).some(file => /^(?:layouts|mods)\//.test(file));
  const expected = new Map();
  if (rooted) for (const [file, digest] of Object.entries(manifest.artifacts)) { if (/^(?:layouts|mods)\//.test(file)) expected.set(file, digest); }
  else if (pkg.mods.length === 1 && manifest.name === pkg.mods[0].name && !pkg.layouts.length) {
    for (const [file, digest] of Object.entries(manifest.artifacts)) expected.set(`mods/${manifest.name}/${file}`, digest);
  } else refuse('UNMANIFESTED_PACKAGE', 'The build manifest does not describe this package');
  for (const file of installable) {
    if (!expected.has(file)) refuse('UNMANIFESTED_PACKAGE', `Package file is not in its build manifest: ${file}`);
    if (expected.get(file) !== pkg.files.get(file).sha256) refuse('MANIFEST_MISMATCH', `Package file differs from its build manifest: ${file}`);
  }
  for (const file of expected.keys()) if (!pkg.files.has(file)) refuse('MANIFEST_MISMATCH', `Manifest artifact is missing: ${file}`);
}

/** Read every package file once: only layouts/ and mods/ are installed; RECIPE.md, preview.png and notices stay out. */
export async function readPackage(source) {
  const root = await fs.realpath(source).catch(() => refuse('INVALID_PACKAGE', `Package folder not found: ${source}`));
  if (!(await fs.stat(root)).isDirectory()) refuse('INVALID_PACKAGE', `Package source is not a folder: ${source}`);
  const files = new Map(), mods = new Map(), layouts = [];
  for (const rel of await walk(root)) {
    const parts = rel.split('/');
    if (parts.at(-1) === '.DS_Store' || !['layouts', 'mods'].includes(parts[0])) continue;
    if (parts.some(part => part.startsWith('.'))) refuse('INVALID_PACKAGE', `Hidden files cannot be installed: ${rel}`);
    if (parts[0] === 'layouts' && (parts.length !== 2 || !/\.(?:json|svg|png)$/.test(parts[1]))) refuse('INVALID_PACKAGE', `Unexpected layout entry: ${rel}`);
    if (parts[0] === 'mods' && (parts.length < 3 || !NAME.test(parts[1]))) refuse('INVALID_PACKAGE', `Mods must be mission-control-* folders: ${rel}`);
    const absolute = path.join(root, rel), bytes = await fs.readFile(absolute), stat = await fs.stat(absolute);
    files.set(rel, { bytes, sha256: sha(bytes), mode: stat.mode & 0o755 });
    if (parts[0] === 'mods') mods.set(parts[1], null);
  }
  for (const name of [...mods.keys()].sort()) {
    if (!files.has(`mods/${name}/main.js`)) refuse('INVALID_PACKAGE', `Mod has no main.js: ${name}`);
    let manifest;
    try { manifest = JSON.parse(files.get(`mods/${name}/mod.json`)?.bytes.toString('utf8')); } catch { manifest = null; }
    if (!plain(manifest)) refuse('INVALID_PACKAGE', `Mod has no valid mod.json: ${name}`);
    mods.set(name, { name, place: manifest.place ?? 'none', title: manifest.title ?? name });
  }
  for (const rel of [...files.keys()].filter(file => /^layouts\/[^/]+\.json$/.test(file))) {
    const name = path.basename(rel, '.json');
    if (!NAME.test(name)) refuse('INVALID_PACKAGE', `Layouts must be mission-control* names: ${rel}`);
    let tree;
    try { tree = JSON.parse(files.get(rel).bytes.toString('utf8')); } catch { refuse('INVALID_PACKAGE', `Layout is not valid JSON: ${rel}`); }
    if (!plain(tree)) refuse('INVALID_PACKAGE', `Layout root must be an object: ${rel}`);
    layouts.push({ name, file: rel, preview: tree.preview ?? null, references: layoutReferences(tree) });
  }
  for (const rel of files.keys()) {
    if (/^layouts\/[^/]+\.(?:svg|png)$/.test(rel) && !layouts.some(layout => layout.preview === rel)) refuse('INVALID_PACKAGE', `Layout asset is not a root preview: ${rel}`);
  }
  if (!files.size) refuse('EMPTY_PACKAGE', `Package has no layouts/ or mods/ to install: ${source}`);
  const pkg = { root, name: path.basename(root), files, mods: [...mods.values()], layouts };
  verifyManifest(pkg, await json(path.join(root, 'build-manifest.json'), 'UNMANIFESTED_PACKAGE', 'build-manifest.json'));
  const keys = await json(path.join(root, 'keys.json'), 'INVALID_PACKAGE', 'Package keys.json');
  if (keys !== undefined && (!plain(keys) || Object.values(keys).some(section => !plain(section)))) refuse('INVALID_PACKAGE', 'Package keys.json must map sections to key bindings');
  pkg.keys = keys ?? null;
  return pkg;
}

const CAPABILITIES = {
  network: [/\bfetch\s*\(/, /\bnode:https?\b/, /\brequire\(\s*['"]https?['"]\s*\)/, /\burllib\b/, /\bhttp\.client\b/, /\bWebSocket\b/, /\bcurl\b/],
  exec: [/\bexec\s*\(/, /\bhc\s*\(/, /\bchild_process\b/, /\b(?:spawn|spawnSync|execFile|execFileSync|execSync)\s*\(/, /\bsubprocess\b/, /\bos\.system\s*\(/],
  files: [/\breadTextFile\s*\(/, /\bwriteTextFile\s*\(/, /\bwatchFolder\s*\(/, /\bnode:fs\b/, /\bexpanduser\b/, /\bhomedir\s*\(/, /\bPath\.home\s*\(/, /\bhome\s*\(\s*\)/],
  history: [/\.claude\b/, /\.codex\b/, /\.grok\b/, /\.jsonl\b/, /\bsessions?\//, /\bhistory\b/i, /\btranscripts?\b/i],
};

/** Heuristic, file:line-anchored disclosure of what each mod can reach; shown before anything is copied. */
export function discloseCapabilities(pkg) {
  return pkg.mods.map(mod => {
    const found = { network: [], exec: [], files: [], history: [] }, origins = new Set(), programs = new Set();
    for (const [rel, file] of pkg.files) {
      if (!rel.startsWith(`mods/${mod.name}/`) || !CODE.test(rel)) continue;
      const lines = file.bytes.toString('utf8').split('\n');
      lines.forEach((line, index) => {
        for (const [kind, patterns] of Object.entries(CAPABILITIES)) {
          if (patterns.some(pattern => pattern.test(line)) && found[kind].length < 5) found[kind].push(`${rel}:${index + 1}`);
        }
        for (const match of line.matchAll(/\bhttps?:\/\/[A-Za-z0-9.-]+(?::\d+)?/g)) origins.add(match[0]);
        for (const match of line.matchAll(/\b(?:exec|spawn|spawnSync|execFile|execFileSync)\s*\(\s*["']([A-Za-z0-9_.\/-]+)["']/g)) programs.add(match[1]);
      });
    }
    return { name: mod.name, place: mod.place, network: { origins: [...origins].sort().slice(0, 40), evidence: found.network },
      exec: { programs: [...programs].sort(), evidence: found.exec }, files: { evidence: found.files }, history: { evidence: found.history } };
  });
}

/** No key is ever replaced: an occupied key is a refusal; free keys are listed for the person to merge. */
export function analyzeKeys(packageKeys, userKeys) {
  const pending = [], conflicts = [], present = [];
  for (const [section, bindings] of Object.entries(packageKeys ?? {})) {
    for (const [key, action] of Object.entries(bindings)) {
      const current = plain(userKeys?.[section]) ? userKeys[section][key] : undefined;
      if (current === undefined) pending.push({ section, key, action });
      else if (isDeepStrictEqual(current, action)) present.push({ section, key, action });
      else conflicts.push({ section, key, action, current });
    }
  }
  return { pending, conflicts, present };
}

async function appHomeRoot(appHome) {
  if (typeof appHome !== 'string' || !path.isAbsolute(appHome)) refuse('APP_HOME_REQUIRED', 'Pass an absolute --app-home target');
  const real = await fs.realpath(appHome).catch(() => refuse('APP_HOME_REQUIRED', `Herdr app home does not exist: ${appHome}`));
  if (!(await fs.stat(real)).isDirectory()) refuse('APP_HOME_REQUIRED', `Herdr app home is not a folder: ${appHome}`);
  for (const child of ['layouts', 'mods']) {
    const stat = await lstat(path.join(real, child));
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) refuse('UNSAFE_APP_HOME', `App home ${child}/ must be a real folder`);
  }
  return real;
}

/** Collisions with existing files, folders or Herdr's shipped names (installed.json): never overwritten, never renamed. */
export async function findCollisions(pkg, appHome) {
  let shipped = {};
  try { shipped = JSON.parse(await fs.readFile(path.join(appHome, 'installed.json'), 'utf8')); } catch { shipped = {}; }
  const out = [];
  for (const mod of pkg.mods) {
    if (await lstat(path.join(appHome, 'mods', mod.name))) out.push({ kind: 'mod', name: mod.name, path: `mods/${mod.name}`, reason: 'exists' });
    else if (plain(shipped) && Object.hasOwn(shipped, mod.name)) out.push({ kind: 'mod', name: mod.name, path: `mods/${mod.name}`, reason: 'shipped' });
  }
  for (const layout of pkg.layouts) {
    if (plain(shipped) && Object.hasOwn(shipped, `layout:${layout.name}`)) out.push({ kind: 'layout', name: layout.name, path: layout.file, reason: 'shipped' });
  }
  for (const rel of pkg.files.keys()) {
    if (rel.startsWith('mods/')) continue;
    if (await lstat(path.join(appHome, rel))) out.push({ kind: rel.endsWith('.json') ? 'layout' : 'file', name: path.basename(rel), path: rel, reason: 'exists' });
  }
  return out;
}

function chooseLayout(pkg, requested) {
  if (!pkg.layouts.length) { if (requested) refuse('UNKNOWN_LAYOUT', `The package has no layouts: ${requested}`); return null; }
  if (requested) { if (!pkg.layouts.some(layout => layout.name === requested)) refuse('UNKNOWN_LAYOUT', `The package has no layout ${requested}`); return requested; }
  const preferred = pkg.layouts.find(layout => layout.name === pkg.name) ?? (pkg.layouts.length === 1 ? pkg.layouts[0] : null);
  if (!preferred) refuse('UNKNOWN_LAYOUT', 'Choose the layout to show with --layout');
  return preferred.name;
}

/** Read-only plan: every target, collision, key, reference and preview problem plus the capability disclosure. */
export async function planInstall({ source, appHome, layout } = {}) {
  const home = await appHomeRoot(appHome);
  const pkg = await readPackage(source);
  if (inside(home, pkg.root) || inside(pkg.root, home)) refuse('UNSAFE_APP_HOME', 'The package source and app home must not contain each other');
  const refusals = [];
  const collisions = await findCollisions(pkg, home);
  for (const collision of collisions) refusals.push({ code: 'COLLISION', ...collision });
  let userKeys = null;
  if (pkg.keys) {
    try { userKeys = JSON.parse(await fs.readFile(path.join(home, 'keys.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') refusals.push({ code: 'INVALID_USER_KEYS', path: 'keys.json' }); }
  }
  const keys = analyzeKeys(pkg.keys, userKeys);
  for (const conflict of keys.conflicts) refusals.push({ code: 'KEY_CONFLICT', section: conflict.section, key: conflict.key });
  const ownMods = new Set(pkg.mods.map(mod => mod.name));
  for (const item of pkg.layouts) {
    for (const reference of item.references) {
      if (!ownMods.has(reference) && !await lstat(path.join(home, 'mods', reference))) refusals.push({ code: 'MISSING_REFERENCE', layout: item.name, mod: reference });
    }
    if (typeof item.preview !== 'string' || !/^layouts\/[^/]+\.(?:svg|png)$/.test(item.preview) || !pkg.files.has(item.preview)) refusals.push({ code: 'PREVIEW_UNRESOLVED', layout: item.name, preview: item.preview });
  }
  const order = rel => rel.startsWith('mods/') ? 0 : rel.endsWith('.json') ? 2 : 1;
  const targets = [...pkg.files.keys()].sort((a, b) => order(a) - order(b) || a.localeCompare(b)).map(rel => ({ path: rel, sha256: pkg.files.get(rel).sha256 }));
  const directories = new Set();
  for (const { path: rel } of targets) { for (let dir = path.posix.dirname(rel); dir !== '.'; dir = path.posix.dirname(dir)) directories.add(dir); }
  const createDirectories = [];
  for (const dir of [...directories].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))) {
    if (!await lstat(path.join(home, dir))) createDirectories.push(dir);
  }
  return { appHome: home, pkg, layout: chooseLayout(pkg, layout), targets, createDirectories, collisions, keys, refusals, disclosure: discloseCapabilities(pkg) };
}

export function formatDisclosure(plan) {
  const lines = [`Mission Control install disclosure: ${plan.pkg.root} -> ${plan.appHome}`];
  for (const mod of plan.disclosure) {
    const parts = [];
    if (mod.network.evidence.length || mod.network.origins.length) parts.push(`reaches the network (URLs in code: ${mod.network.origins.join(', ') || 'none literal; see ' + mod.network.evidence.join(', ')})`);
    if (mod.exec.evidence.length) parts.push(`runs programs (${mod.exec.programs.join(', ') || 'see ' + mod.exec.evidence.join(', ')})`);
    if (mod.files.evidence.length) parts.push(`reads/writes files outside its folder (${mod.files.evidence.join(', ')})`);
    if (mod.history.evidence.length) parts.push(`reads agent session history (${mod.history.evidence.join(', ')})`);
    if (mod.place !== 'none') parts.push(`docks itself on the ${mod.place} of the shown layout when Herdr first sees it`);
    lines.push(`  mods/${mod.name}: ${parts.join('; ') || 'no network, program or outside-file access found'}`);
  }
  for (const layout of plan.pkg.layouts) lines.push(`  ${layout.file}: uses ${layout.references.join(', ') || 'no mods'}; preview ${layout.preview ?? 'missing'}`);
  if (plan.keys.pending.length) lines.push(`  keys.json: ${plan.keys.pending.length} binding(s) are NOT merged automatically; add them yourself: ${JSON.stringify(plan.keys.pending.map(({ section, key, action }) => ({ section, key, action })))}`);
  for (const refusal of plan.refusals) lines.push(`  REFUSED ${refusal.code}: ${JSON.stringify(Object.fromEntries(Object.entries(refusal).filter(([key]) => key !== 'code')))}`);
  return lines.join('\n');
}

function appContext({ appHome, herdrApp = 'herdr-app', env = process.env, timeout = 30000 }) {
  const commands = [];
  const call = (args, { json = true, code = 'APP_COMMAND_FAILED' } = {}) => {
    const result = spawnSync(herdrApp, args, { env: { ...env, HERDR_APP_HOME: appHome }, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
    commands.push({ command: args[0] === 'do' ? `do ${args[1]}` : args[0], exitCode: result.status ?? null });
    const label = args[0] === 'do' ? `herdr-app do ${args[1]}` : `herdr-app ${args[0]}`;
    if (result.error || result.status !== 0) fail(code, `${label} failed: ${(result.stderr || result.stdout || result.error?.message || 'no output').trim().slice(0, 600)}`);
    if (!json) return result.stdout.trim();
    try { return JSON.parse(result.stdout); } catch { fail(code, `${label} did not print JSON`); }
  };
  return { appHome, commands, call };
}

function readStatus(app) {
  const status = app.call(['status'], { code: 'APP_STATUS_UNAVAILABLE' });
  if (!plain(status) || typeof status.layout !== 'string' || !Array.isArray(status.errors ?? [])) fail('APP_STATUS_UNAVAILABLE', 'herdr-app status has no shown layout');
  return { layout: status.layout, errors: status.errors ?? [] };
}

/** Terminal addresses anywhere in `herdr-app ls`; used to prove existing terminals keep running. */
export function terminalAddresses(value, out = new Set()) {
  if (Array.isArray(value)) { for (const item of value) terminalAddresses(item, out); return out; }
  if (!plain(value)) return out;
  for (const [key, item] of Object.entries(value)) {
    if ((key === 'address' || key === 'terminal') && typeof item === 'string') out.add(item);
    else if (key === 'terminals' && Array.isArray(item)) item.forEach(entry => typeof entry === 'string' ? out.add(entry) : terminalAddresses(entry, out));
    else terminalAddresses(item, out);
  }
  return out;
}

async function shot(app, file) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  app.call(['shot', file], { json: false, code: 'NO_FRAME' });
  const bytes = await fs.readFile(file).catch(() => fail('NO_FRAME', 'herdr-app shot wrote no frame'));
  const info = pngInfo(bytes);
  if (!info) fail('NO_FRAME', 'herdr-app shot did not produce a PNG frame');
  return { path: file, sha256: sha(bytes), ...info };
}

async function switchLayout(app, name, { pollMs, pollAttempts }) {
  const result = app.call(['do', 'layout.switch', JSON.stringify({ name })], { code: 'SWITCH_FAILED' });
  if (plain(result) && result.error) fail('SWITCH_FAILED', `layout.switch refused: ${String(result.error).slice(0, 300)}`);
  for (let attempt = 0; attempt < pollAttempts; attempt++) {
    if (readStatus(app).layout === name) return true;
    await delay(pollMs);
  }
  fail('LAYOUT_NOT_SHOWN', `Herdr did not show layout ${name}`);
}

/** appHome()/mission-control/installed-packages.json: which mods and layouts this installer owns, so the
 *  Mods manager shows them as installer-managed (read-only). Written after a successful install, removed on rollback. */
export const OWNERSHIP_MANIFEST = 'mission-control/installed-packages.json';
async function updateOwnership(appHome, name, entry) {
  const file = path.join(appHome, OWNERSHIP_MANIFEST);
  let value = { v: 1, packages: {} };
  try { const parsed = JSON.parse(await fs.readFile(file, 'utf8')); if (parsed?.v === 1 && parsed.packages && typeof parsed.packages === 'object') value = parsed; } catch {}
  if (entry) value.packages[name] = entry; else delete value.packages[name];
  if (!Object.keys(value.packages).length) { await fs.rm(file, { force: true }); return; }
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + `.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n');
  await fs.rename(tmp, file);
}

async function writeReceipt(file, receipt) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  await fs.writeFile(temporary, JSON.stringify(receipt, null, 2) + '\n');
  await fs.rename(temporary, file);
}

async function fileDigest(file) {
  const stat = await lstat(file);
  return stat?.isFile() ? sha(await fs.readFile(file)) : null;
}

// gpui-shell writes these editor files into every mod folder that imports gpui-kit (see a shipped mod folder).
const GENERATED = new Set(['jsconfig.json', 'gpui-kit.d.ts']);

/** App-written editor files inside folders this install created, by path and digest. */
export async function generatedFiles(appHome, createdDirectories) {
  const out = {};
  for (const dir of createdDirectories) {
    for (const name of GENERATED) { const digest = await fileDigest(path.join(appHome, dir, name)); if (digest) out[`${dir}/${name}`] = digest; }
  }
  return out;
}

async function siblingDigests(appHome, createdDirectories) {
  const ours = new Set(createdDirectories), out = new Map([...GENERATED].map(name => [name, new Set()]));
  for (const entry of await fs.readdir(path.join(appHome, 'mods'), { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || ours.has(`mods/${entry.name}`)) continue;
    for (const name of GENERATED) { const digest = await fileDigest(path.join(appHome, 'mods', entry.name, name)); if (digest) out.get(name).add(digest); }
  }
  return out;
}

/** Remove only files that still carry the installed hash, app-generated editor files proven by digest, then only now-empty folders this install created. */
export async function removeOwned(appHome, owned, createdDirectories, { generated = {} } = {}) {
  const removed = [], kept = [], removedDirectories = [], keptDirectories = [], removedGenerated = [];
  for (const { path: rel, sha256 } of [...owned].reverse()) {
    const file = path.join(appHome, rel), stat = await lstat(file);
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink()) { kept.push({ path: rel, reason: 'not-a-regular-file' }); continue; }
    if (sha(await fs.readFile(file)) !== sha256) { kept.push({ path: rel, reason: 'modified' }); continue; }
    await fs.rm(file); removed.push(rel);
  }
  const ownedPaths = new Set(owned.map(file => file.path)), siblings = await siblingDigests(appHome, createdDirectories);
  for (const dir of createdDirectories) {
    for (const name of GENERATED) {
      const rel = `${dir}/${name}`, digest = ownedPaths.has(rel) ? null : await fileDigest(path.join(appHome, rel));
      if (!digest) continue;
      if (generated[rel] === digest || siblings.get(name).has(digest)) { await fs.rm(path.join(appHome, rel)); removedGenerated.push(rel); }
      else kept.push({ path: rel, reason: 'app-file-edited' });
    }
  }
  for (const rel of [...createdDirectories].sort((a, b) => b.split('/').length - a.split('/').length || b.localeCompare(a))) {
    try { await fs.rmdir(path.join(appHome, rel)); removedDirectories.push(rel); }
    catch (error) { if (error.code !== 'ENOENT') keptDirectories.push({ path: rel, reason: error.code === 'ENOTEMPTY' || error.code === 'EEXIST' ? 'not-empty' : error.code }); }
  }
  return { removed, kept, removedDirectories, keptDirectories, removedGenerated };
}

async function restoreLayout(app, receipt, { pollMs, pollAttempts, force }) {
  if (!receipt.previousLayout) return { restored: null, reason: 'no-previous-layout' };
  let shown;
  try { shown = readStatus(app).layout; } catch (error) { return { restored: null, error: error.message }; }
  if (!force && !receipt.layouts.includes(shown)) return { restored: null, reason: 'installed-layout-not-shown', shown };
  if (shown === receipt.previousLayout) return { restored: receipt.previousLayout };
  try { await switchLayout(app, receipt.previousLayout, { pollMs, pollAttempts }); return { restored: receipt.previousLayout }; }
  catch (error) { return { restored: null, error: error.message }; }
}

/** Dry-run (no writes) or hash-receipted install, native checks, layout switch and status/frame/terminal verification. */
export async function install({ source = path.join(PROJECT_ROOT, 'mission-control'), appHome, layout, receiptPath, herdrApp = 'herdr-app', env = process.env,
  dryRun = false, shotDir, pollMs = 250, pollAttempts = 40, settleMs = 1500, onDisclosure = plan => console.log(formatDisclosure(plan)) } = {}) {
  const plan = await planInstall({ source, appHome, layout });
  onDisclosure(plan);
  const summary = { appHome: plan.appHome, source: plan.pkg.root, layout: plan.layout, targets: plan.targets, createDirectories: plan.createDirectories,
    keys: plan.keys, refusals: plan.refusals, disclosure: plan.disclosure };
  if (dryRun) return { dryRun: true, ok: plan.refusals.length === 0, ...summary };
  if (plan.refusals.length) refuse('REFUSED', `Install refused: ${[...new Set(plan.refusals.map(r => r.code))].join(', ')}`, plan.refusals);
  if (typeof receiptPath !== 'string' || !path.isAbsolute(receiptPath)) refuse('RECEIPT_REQUIRED', 'Pass an absolute receipt path');
  if (inside(await canonical(receiptPath), plan.appHome)) refuse('RECEIPT_REQUIRED', 'The receipt must live outside the app home');
  const prior = await fs.readFile(receiptPath, 'utf8').then(text => { try { return JSON.parse(text); } catch { return {}; } }, () => null);
  if (prior && ['installing', 'installed', 'failed'].includes(prior.state) && !(prior.state === 'failed' && prior.rollback?.kept?.length === 0)) {
    refuse('RECEIPT_IN_USE', `${receiptPath} still records owned files; roll it back first`);
  }
  const app = appContext({ appHome: plan.appHome, herdrApp, env });
  const timing = { pollMs, pollAttempts };
  const before = readStatus(app);
  const terminalsBefore = terminalAddresses(app.call(['ls'], { code: 'APP_LS_UNAVAILABLE' }));
  const frames = shotDir ?? path.join(PROJECT_ROOT, '.browse/sessions', `mission-control-install-${Date.now()}`);
  const frameBefore = await shot(app, path.join(frames, 'before.png'));
  const previousFiles = before.layout ? [`layouts/${before.layout}.json`, `layouts/.state/${before.layout}.json`] : [];
  const previousIntegrity = Object.fromEntries(await Promise.all(previousFiles.map(async rel => [rel, await fileDigest(path.join(plan.appHome, rel))])));
  const receipt = {
    v: 1, kind: 'mission-control-install', ok: false, state: 'installing', startedMs: Date.now(), completedMs: null, installerSha256: await installerSha256(),
    appHome: plan.appHome, source: { root: plan.pkg.root, name: plan.pkg.name, files: Object.fromEntries(plan.targets.map(t => [t.path, t.sha256])) },
    layouts: plan.pkg.layouts.map(l => l.name), mods: plan.pkg.mods.map(m => m.name), layout: plan.layout, previousLayout: before.layout,
    owned: plan.targets, createdDirectories: plan.createDirectories, keys: { pending: plan.keys.pending, present: plan.keys.present, conflicts: [] },
    disclosure: plan.disclosure, validation: null, error: null, rollback: null,
    rollbackCommand: `node scripts/install.mjs --rollback --receipt ${quote(receiptPath)} --app-home ${quote(plan.appHome)}`,
  };
  await writeReceipt(receiptPath, receipt);
  let switched = false;
  const created = [];
  try {
    for (const dir of plan.createDirectories) {
      try { await fs.mkdir(path.join(plan.appHome, dir)); created.push(dir); }
      catch (error) { fail('COPY_FAILED', `Could not create ${dir}: ${error.code ?? error.message}`); }
    }
    for (const target of plan.targets) {
      const file = plan.pkg.files.get(target.path);
      try { await fs.writeFile(path.join(plan.appHome, target.path), file.bytes, { flag: 'wx', mode: file.mode | 0o600 }); }
      catch (error) { fail('COPY_FAILED', `Could not add ${target.path}: ${error.code ?? error.message}`); }
    }
    for (const target of plan.targets) {
      if (await fileDigest(path.join(plan.appHome, target.path)) !== target.sha256) fail('COPY_FAILED', `Installed bytes differ: ${target.path}`);
    }
    const checks = [];
    for (const mod of plan.pkg.mods) {
      const output = app.call(['check', path.join(plan.appHome, 'mods', mod.name)], { json: false, code: 'CHECK_FAILED' });
      checks.push({ name: `herdr-app check mods/${mod.name}`, ok: true, output: output.slice(0, 300) });
    }
    if (plan.layout) { switched = true; await switchLayout(app, plan.layout, timing); checks.push({ name: `layout.switch ${plan.layout}`, ok: true }); }
    await delay(settleMs);
    const after = readStatus(app);
    if (plan.layout && after.layout !== plan.layout) fail('LAYOUT_NOT_SHOWN', `Herdr shows ${after.layout}, not ${plan.layout}`);
    const names = [...receipt.layouts, ...receipt.mods];
    const errors = after.errors.filter(error => !before.errors.some(old => isDeepStrictEqual(old, error)) || names.some(name => JSON.stringify(error).includes(name)));
    if (errors.length) fail('STATUS_ERRORS', `herdr-app status reports ${errors.length} new error(s): ${JSON.stringify(errors).slice(0, 600)}`, errors);
    checks.push({ name: 'herdr-app status has no new errors', ok: true });
    const frameAfter = await shot(app, path.join(frames, 'after.png'));
    if (plan.layout && frameAfter.sha256 === frameBefore.sha256) fail('FRAME_UNCHANGED', 'The window frame did not change after switching layouts');
    checks.push({ name: 'visible frame captured', ok: true });
    const terminalsAfter = terminalAddresses(app.call(['ls'], { code: 'APP_LS_UNAVAILABLE' }));
    const missing = [...terminalsBefore].filter(address => !terminalsAfter.has(address)).sort();
    if (missing.length) fail('TERMINALS_LOST', `Existing terminals disappeared: ${missing.join(', ')}`);
    checks.push({ name: 'existing terminals still running', ok: true });
    const previews = [];
    for (const item of plan.pkg.layouts) {
      const digest = await fileDigest(path.join(plan.appHome, item.preview));
      if (digest !== plan.pkg.files.get(item.preview).sha256) fail('PREVIEW_UNRESOLVED', `Installed preview does not resolve: ${item.preview}`);
      previews.push({ layout: item.name, path: item.preview, sha256: digest });
    }
    if (previews.length) checks.push({ name: 'root preview paths resolve in the app home', ok: true });
    const previousLayoutIntegrity = {};
    for (const [rel, digest] of Object.entries(previousIntegrity)) previousLayoutIntegrity[rel] = { before: digest, after: await fileDigest(path.join(plan.appHome, rel)) };
    Object.assign(receipt, { ok: true, state: 'installed', completedMs: Date.now(), generated: await generatedFiles(plan.appHome, plan.createDirectories), commands: app.commands,
      validation: { checks, status: { layout: after.layout, errors: [], baselineErrors: before.errors }, frames: { before: frameBefore, after: frameAfter },
        terminals: { before: terminalsBefore.size, after: terminalsAfter.size, missing: [] }, previews, previousLayoutIntegrity } });
    await writeReceipt(receiptPath, receipt);
    await updateOwnership(plan.appHome, receipt.source?.name || path.basename(plan.pkg.root), { receipt: receiptPath, installedMs: receipt.completedMs,
      mods: receipt.mods, layouts: receipt.layouts, files: Object.fromEntries(receipt.owned.map(file => [file.path, file.sha256])) });
    return { ...summary, ok: true, state: 'installed', receipt: receiptPath, previousLayout: receipt.previousLayout, rollbackCommand: receipt.rollbackCommand };
  } catch (error) {
    const layoutResult = switched ? await restoreLayout(app, receipt, { ...timing, force: true }) : { restored: null, reason: 'not-switched' };
    // Only folders this run actually created; a folder that appeared concurrently is never ours.
    receipt.createdDirectories = created;
    const removal = await removeOwned(plan.appHome, receipt.owned, created);
    Object.assign(receipt, { ok: false, state: 'failed', completedMs: Date.now(), error: { code: error.code ?? 'INSTALL_FAILED', message: error.message.slice(0, 1200) },
      rollback: { completedMs: Date.now(), layout: layoutResult, ...removal }, commands: app.commands });
    await writeReceipt(receiptPath, receipt);
    if (!(error instanceof InstallError)) throw new InstallError('INSTALL_FAILED', error.message);
    error.message += `; rolled back (${removal.removed.length} removed, ${removal.kept.length} kept${layoutResult.restored ? `, layout ${layoutResult.restored} restored` : ''})`;
    throw error;
  }
}

/** Shape-only validation shared with the release gate; it never consults the app home. */
export function validateInstallReceipt(receipt) {
  const bad = message => fail('INVALID_RECEIPT', `Install receipt is invalid: ${message}`);
  const rel = value => typeof value === 'string' && value.length <= 512 && /^(?:layouts|mods)\/./.test(value) && !value.split('/').some(part => !part || part === '.' || part === '..');
  if (!plain(receipt) || receipt.v !== 1 || receipt.kind !== 'mission-control-install') bad('wrong version or kind');
  if (!['installing', 'installed', 'failed', 'rolled-back'].includes(receipt.state)) bad('unknown state');
  if (typeof receipt.appHome !== 'string' || !path.isAbsolute(receipt.appHome) || !HEX.test(receipt.installerSha256 ?? '')) bad('app home or installer digest');
  if (!plain(receipt.source) || typeof receipt.source.root !== 'string' || !path.isAbsolute(receipt.source.root) || !plain(receipt.source.files)) bad('source');
  if (!Array.isArray(receipt.owned) || !receipt.owned.length || receipt.owned.some(file => !rel(file?.path) || !HEX.test(file?.sha256 ?? ''))) bad('owned files');
  const owned = Object.fromEntries(receipt.owned.map(file => [file.path, file.sha256]));
  if (Object.keys(owned).length !== receipt.owned.length || !isDeepStrictEqual(owned, receipt.source.files)) bad('owned files must equal the source package files');
  if (!Array.isArray(receipt.createdDirectories) || receipt.createdDirectories.some(dir => !['layouts', 'mods'].includes(dir) && !rel(dir))) bad('created directories');
  if (!Array.isArray(receipt.layouts) || !Array.isArray(receipt.mods) || ![...receipt.layouts, ...receipt.mods].every(name => NAME.test(name))) bad('names');
  if (receipt.previousLayout !== null && typeof receipt.previousLayout !== 'string') bad('previous layout');
  if (receipt.generated !== undefined && (!plain(receipt.generated) || Object.entries(receipt.generated).some(([file, digest]) => !rel(file) || !GENERATED.has(path.posix.basename(file)) || !HEX.test(digest)))) bad('generated files');
  if (receipt.state === 'installed') {
    const v = receipt.validation;
    if (receipt.ok !== true || receipt.error !== null || !plain(v) || !Array.isArray(v.checks) || !v.checks.length || !v.checks.every(check => check?.ok === true)) bad('installed without passing validation');
    if (!Array.isArray(v.status?.errors) || v.status.errors.length || (receipt.layout && v.status.layout !== receipt.layout)) bad('status');
    if (!HEX.test(v.frames?.after?.sha256 ?? '') || !(v.frames.after.width > 0 && v.frames.after.height > 0) || v.terminals?.missing?.length !== 0) bad('frame or terminals');
    if (receipt.layouts.length && (!Array.isArray(v.previews) || v.previews.length !== receipt.layouts.length)) bad('previews');
    if (typeof receipt.rollbackCommand !== 'string' || !receipt.rollbackCommand.includes('--rollback')) bad('rollback command');
  } else if (receipt.ok !== false) bad('only an installed receipt can be ok');
  return receipt;
}

async function readReceipt(file) {
  let text;
  try { text = await fs.readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') fail('MISSING_RECEIPT', `No install receipt at ${file}; it is written only by a confirmed real install.`); throw error; }
  try { return JSON.parse(text); } catch { fail('INVALID_RECEIPT', `Install receipt is not JSON: ${file}`); }
}

/** A receipt proves an install only while the installer, package source and every installed byte still match it. */
export async function verifyInstallReceipt(file) {
  const receipt = validateInstallReceipt(await readReceipt(file));
  if (receipt.state !== 'installed') fail('NOT_INSTALLED', `Install receipt state is ${receipt.state}${receipt.error ? ` (${receipt.error.code})` : ''}`);
  if (receipt.installerSha256 !== await installerSha256()) fail('STALE_RECEIPT', 'scripts/install.mjs changed since this install; reinstall to refresh the receipt');
  const changed = [];
  for (const owned of receipt.owned) if (await fileDigest(path.join(receipt.appHome, owned.path)) !== owned.sha256) changed.push(owned.path);
  if (changed.length) fail('INSTALLED_FILES_CHANGED', `Installed files are missing or changed: ${changed.slice(0, 10).join(', ')}`, changed);
  const stale = [];
  for (const [rel, digest] of Object.entries(receipt.source.files)) if (await fileDigest(path.join(receipt.source.root, rel)) !== digest) stale.push(rel);
  if (stale.length) fail('SOURCE_CHANGED', `Package source no longer matches what was installed: ${stale.slice(0, 10).join(', ')}`, stale);
  return { ok: true, appHome: receipt.appHome, layout: receipt.layout, previousLayout: receipt.previousLayout, files: receipt.owned.length, completedMs: receipt.completedMs };
}

/** Restore the previous layout when an installed one is shown, then remove only hash-matching owned files and empty owned folders. */
export async function rollback({ receiptPath, appHome, herdrApp = 'herdr-app', env = process.env, pollMs = 250, pollAttempts = 40 } = {}) {
  const receipt = validateInstallReceipt(await readReceipt(receiptPath));
  if (appHome && await fs.realpath(appHome).catch(() => appHome) !== receipt.appHome) refuse('APP_HOME_MISMATCH', 'The receipt belongs to a different app home');
  if (receipt.state === 'rolled-back') return { ok: true, state: 'rolled-back', alreadyRolledBack: true, rollback: receipt.rollback };
  const app = appContext({ appHome: receipt.appHome, herdrApp, env });
  const layoutResult = await restoreLayout(app, receipt, { pollMs, pollAttempts, force: false });
  const removal = await removeOwned(receipt.appHome, receipt.owned, receipt.createdDirectories, { generated: receipt.generated ?? {} });
  Object.assign(receipt, { ok: false, state: 'rolled-back', rollback: { completedMs: Date.now(), layout: layoutResult, ...removal, previous: receipt.rollback ?? null } });
  await writeReceipt(receiptPath, receipt);
  await updateOwnership(receipt.appHome, receipt.source?.name || 'mission-control', null);
  const ok = !layoutResult.error;
  if (!ok) fail('LAYOUT_RESTORE_FAILED', `Owned files handled but the previous layout was not restored: ${layoutResult.error}`, receipt.rollback);
  return { ok, state: 'rolled-back', rollback: receipt.rollback };
}

const USAGE = `Usage:
  node scripts/install.mjs --dry-run [--source <package>] [--app-home <dir>] [--layout <name>]
  node scripts/install.mjs --app-home <dir> [--source <package>] [--layout <name>] [--receipt <file>] [--herdr-app <bin>] [--shot-dir <dir>]
  node scripts/install.mjs --rollback [--receipt <file>] [--app-home <dir>] [--herdr-app <bin>]
  node scripts/install.mjs --verify-receipt <file>`;

export function parseArgs(argv) {
  const options = {}, flags = new Set(['--dry-run', '--rollback', '--help']), values = new Set(['--source', '--app-home', '--layout', '--receipt', '--herdr-app', '--shot-dir', '--verify-receipt']);
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (flags.has(arg)) options[arg.slice(2)] = true;
    else if (values.has(arg) && index + 1 < argv.length && !argv[index + 1].startsWith('--')) options[arg.slice(2)] = argv[++index];
    else throw new InstallError('USAGE', `Unknown or incomplete argument: ${arg}\n${USAGE}`, { exitCode: 2 });
  }
  if ([options['dry-run'], options.rollback, options['verify-receipt']].filter(Boolean).length > 1) throw new InstallError('USAGE', `Choose one mode\n${USAGE}`, { exitCode: 2 });
  return options;
}

async function main(argv) {
  const options = parseArgs(argv), env = process.env, herdrApp = options['herdr-app'] ?? env.MISSION_CONTROL_HERDR_APP ?? 'herdr-app';
  const resolve = value => value && path.resolve(value);
  const receiptPath = resolve(options.receipt) ?? path.join(PROJECT_ROOT, 'evidence/native/install.json');
  if (options.help) return console.log(USAGE);
  if (options['verify-receipt']) return console.log(JSON.stringify(await verifyInstallReceipt(resolve(options['verify-receipt'])), null, 2));
  if (options.rollback) return console.log(JSON.stringify(await rollback({ receiptPath, appHome: resolve(options['app-home']), herdrApp, env }), null, 2));
  const source = resolve(options.source) ?? path.join(PROJECT_ROOT, 'mission-control');
  if (options['dry-run']) {
    const result = await install({ source, appHome: resolve(options['app-home']) ?? defaultAppHome(env), layout: options.layout, dryRun: true });
    console.log(JSON.stringify({ ...result, disclosure: undefined }, null, 2));
    if (!result.ok) process.exitCode = 3;
    return;
  }
  if (!options['app-home']) throw new InstallError('APP_HOME_REQUIRED', `A real install needs an explicit --app-home target (for example --app-home ~/.config/herdr-app)\n${USAGE}`, { exitCode: 2 });
  const result = await install({ source, appHome: resolve(options['app-home']), layout: options.layout, receiptPath, herdrApp, env, shotDir: resolve(options['shot-dir']) });
  console.log(JSON.stringify({ ok: result.ok, state: result.state, layout: result.layout, previousLayout: result.previousLayout, receipt: result.receipt, rollbackCommand: result.rollbackCommand }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error.code ? `${error.code}: ${error.message}` : error.message);
    process.exitCode = error.exitCode || 1;
  });
}
