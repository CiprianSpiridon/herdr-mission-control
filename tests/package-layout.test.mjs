import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {validateNativeIsolationReceipt} from '../scripts/native-harness.mjs';
import {PACKAGES, reconcilePackage} from '../scripts/verify-gitlab-compatibility.mjs';
import {recipeLinks} from '../scripts/release.mjs';
import {pngInfo} from '../scripts/install.mjs';

// TASK-009: the two-layout bundle is accepted only when `node scripts/project.mjs bundle` produced exactly the
// referenced mods, each byte-identical to a standalone build whose own native proof is current, and when the
// public preview is the actual `layout-preview` frame of a passed isolated native layout run.

const ROOT = path.resolve(import.meta.dirname, '..');
const BUNDLE = 'mission-control';
const LAYOUT_NAMES = Object.freeze(['mission-control', 'mission-control-classic']);
const BUNDLED_MODS = Object.freeze(['mission-control-agents', 'mission-control-github', 'mission-control-gitlab', 'mission-control-jira',
  'mission-control-mods', 'mission-control-sessions', 'mission-control-spaces', 'mission-control-tabs']);
const OPTIONAL_MODS = Object.freeze(['mission-control-accounts']);
/** The seven navigation destinations: mc-work-stack children, in order, with their exact block content. */
const DESTINATIONS = Object.freeze([
  ['jira', 'mission-control-jira', {view: 'panel', hideHeader: true}],
  ['github', 'mission-control-github', {view: 'issues', hideHeader: true}],
  ['pulls', 'mission-control-github', {view: 'pulls', hideHeader: true}],
  ['gitlab', 'mission-control-gitlab', {view: 'issues', hideHeader: true}],
  ['merges', 'mission-control-gitlab', {view: 'merges', hideHeader: true}],
  ['sessions', 'mission-control-sessions', {hideHeader: true}],
  ['mods', 'mission-control-mods', {hideHeader: true}],
]);
const GITLAB_ROLES = Object.freeze([{view: 'issues', hideHeader: true}, {view: 'merges', hideHeader: true}]);
const TOP_LEVEL = Object.freeze(['RECIPE.md', 'build-manifest.json', 'layouts', 'mods', 'preview.png']);
const OPTIONAL_TOP_LEVEL = Object.freeze(['NOTICE.md']);
const PREVIEW_FRAME = 'layout-preview';
const NATIVE_FRAME_PATH = /^\.browse\/sessions\/mission-control-native-[a-f0-9]{24}\/layout-preview\.png$/;
const CLASSIC_EVIDENCE = 'evidence/native/mission-control-classic.png';
const LAYOUT_RECEIPT = 'evidence/native/layout.json';
const COMPATIBILITY_RECEIPT = 'evidence/native/gitlab-compatibility.json';
/**
 * Integrated-gate coverage the layout receipt must contain among its passed assertion labels (TASK-007 acceptance).
 * Align these with the labels tests/native/layout.mjs actually emits once that scenario exists.
 */
const REQUIRED_EVIDENCE = Object.freeze([
  ['Classic view', /classic/i],
  ['Mission Control overview', /overview|mission control/i],
  ['one-button swap', /swap/i],
  ['GitLab issues or merge requests', /gitlab|merge request/i],
  ['All spaces routing', /all spaces|all-spaces/i],
  ['narrow 736 px width', /736/],
]);

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const posix = file => file.split(path.sep).join('/');
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const read = file => fs.readFile(file).catch(error => {
  if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
  throw error;
});
const readJson = async file => {
  const raw = await read(file);
  if (!raw) return undefined;
  try { return JSON.parse(raw); } catch { return null; }
};

/** {relative path: sha256} of every regular file below dir; symlinks are recorded so they always mismatch. */
async function filesBelow(dir) {
  const out = {};
  const visit = async at => {
    let entries;
    try { entries = await fs.readdir(at, {withFileTypes: true}); } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return;
      throw error;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(at, entry.name), rel = posix(path.relative(dir, file));
      if (entry.name === '.DS_Store') continue;
      if (entry.isSymbolicLink()) out[rel] = 'symlink';
      else if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) out[rel] = sha(await fs.readFile(file));
    }
  };
  await visit(dir);
  return out;
}

/** Every mission-control-* mod a layout tree references, exactly as the bundler collects them. */
function referencedMods(tree) {
  const out = new Set();
  const visit = value => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!plain(value)) return;
    if (typeof value.mod === 'string' && value.mod.startsWith('mission-control-')) out.add(value.mod);
    for (const child of Object.values(value)) visit(child);
  };
  visit(tree);
  return out;
}

function findNode(tree, id) {
  const stack = [tree];
  while (stack.length) {
    const node = stack.pop();
    if (!plain(node)) continue;
    if (node.id === id) return node;
    if (Array.isArray(node.children)) stack.push(...node.children);
  }
  return null;
}

/** Problems with the seven destinations and both GitLab role nodes in one layout tree. */
function destinationProblems(name, tree) {
  const out = [], stack = findNode(tree, 'mc-work-stack');
  const children = Array.isArray(stack?.children) ? stack.children : [];
  const actual = children.map(child => [child?.id, child?.content?.mod, child?.content?.props]);
  if (stack?.type !== 'stack' || !isDeepStrictEqual(actual, DESTINATIONS.map(d => [...d]))) out.push('MISSING_DESTINATION:' + name);
  const gitlab = children.filter(child => child?.type === 'block' && child?.content?.mod === 'mission-control-gitlab').map(child => child.content.props);
  if (!isDeepStrictEqual(gitlab, GITLAB_ROLES)) out.push('MISSING_GITLAB_ROLE:' + name);
  return out;
}

/** Structural problems of root/mission-control as `node scripts/project.mjs bundle` must leave it. Empty means acceptable. */
export async function inspectBundle({root = ROOT} = {}) {
  const reasons = new Set(), add = reason => reasons.add(reason);
  const bundle = path.join(root, BUNDLE), files = await filesBelow(bundle);
  const top = new Set(Object.keys(files).map(file => file.split('/')[0]));
  for (const entry of TOP_LEVEL) if (!top.has(entry)) add('MISSING_ENTRY:' + entry);
  for (const entry of top) if (!TOP_LEVEL.includes(entry) && !OPTIONAL_TOP_LEVEL.includes(entry)) add('UNEXPECTED_ENTRY:' + entry);
  if (Object.values(files).includes('symlink')) add('SYMLINK');

  const expectedLayoutFiles = LAYOUT_NAMES.flatMap(name => [`layouts/${name}.json`, `layouts/${name}.svg`]);
  for (const file of Object.keys(files).filter(file => file.startsWith('layouts/'))) {
    if (!expectedLayoutFiles.includes(file)) add('UNEXPECTED_ENTRY:' + file);
  }
  const referenced = new Set();
  for (const name of LAYOUT_NAMES) {
    for (const file of [`${name}.json`, `${name}.svg`]) {
      const bundled = await read(path.join(bundle, 'layouts', file)), source = await read(path.join(root, 'src/layouts', file));
      if (!bundled) add('MISSING_LAYOUT:' + file);
      else if (!source || !bundled.equals(source)) add('LAYOUT_MISMATCH:' + file);
    }
    const tree = await readJson(path.join(bundle, 'layouts', `${name}.json`));
    if (!plain(tree)) continue;
    if (tree.preview !== `layouts/${name}.svg` || !files[tree.preview]) add('PREVIEW_PATH:' + name);
    for (const mod of referencedMods(tree)) referenced.add(mod);
    destinationProblems(name, tree).forEach(add);
  }
  for (const mod of OPTIONAL_MODS) if (referenced.has(mod)) add('ACCOUNTS_REQUIRED:' + mod);

  const bundledMods = new Set(Object.keys(files).filter(file => file.startsWith('mods/')).map(file => file.split('/')[1]));
  for (const mod of referenced) if (!bundledMods.has(mod)) add('MISSING_MOD:' + mod);
  for (const mod of bundledMods) if (!referenced.has(mod)) add('UNEXPECTED_MOD:' + mod);
  for (const mod of [...referenced].filter(mod => bundledMods.has(mod)).sort()) {
    const prefix = `mods/${mod}/`;
    const bundled = Object.fromEntries(Object.entries(files).filter(([file]) => file.startsWith(prefix)).map(([file, digest]) => [file.slice(prefix.length), digest]));
    const standalone = await filesBelow(path.join(root, mod, 'mods', mod));
    if (!Object.keys(standalone).length) { add('MISSING_STANDALONE:' + mod); continue; }
    if (!isDeepStrictEqual(bundled, standalone)) add('MOD_MISMATCH:' + mod);
    const manifest = await readJson(path.join(root, mod, 'build-manifest.json'));
    if (!plain(manifest?.artifacts) || manifest.name !== mod) add('MISSING_STANDALONE_MANIFEST:' + mod);
    else if (!isDeepStrictEqual(manifest.artifacts, standalone)) add('STALE_STANDALONE:' + mod);
  }

  const manifest = await readJson(path.join(bundle, 'build-manifest.json'));
  const artifacts = Object.fromEntries(Object.entries(files).filter(([file]) => file !== 'build-manifest.json'));
  if (!plain(manifest)) add('MISSING_MANIFEST');
  else if (!isDeepStrictEqual(manifest, {v: 1, name: BUNDLE, artifacts})) add('MANIFEST_MISMATCH');
  return {reasons: [...reasons].sort(), mods: [...referenced].sort()};
}

/** SHA-256 of every browser or mockup capture: non-native .browse sessions and anything under work/. */
async function mockupHashes(root) {
  const out = new Set(), sources = [];
  const sessions = path.join(root, '.browse/sessions');
  for (const entry of await fs.readdir(sessions, {withFileTypes: true}).catch(() => [])) {
    if (entry.isDirectory() && !entry.name.startsWith('mission-control-native-')) sources.push(path.join(sessions, entry.name));
  }
  sources.push(path.join(root, 'work'));
  let budget = 5000;
  for (const dir of sources) {
    for (const [file, digest] of Object.entries(await filesBelow(dir))) {
      if (--budget < 0) break;
      if (/\.png$/i.test(file) && digest !== 'symlink') out.add(digest);
    }
  }
  return out;
}

/** Problems with mission-control/preview.png and the layout receipt frame it must equal. Empty means acceptable. */
export async function inspectPreview({root = ROOT, receiptPath = path.join(root, LAYOUT_RECEIPT), validate = validateNativeIsolationReceipt} = {}) {
  const reasons = new Set(), add = reason => reasons.add(reason);
  const preview = await read(path.join(root, BUNDLE, 'preview.png'));
  if (!preview) add('MISSING_PREVIEW');
  else if (!pngInfo(preview)) add('NOT_PNG');
  const receipt = await readJson(receiptPath);
  if (receipt === undefined) add('MISSING_RECEIPT');
  else if (!plain(receipt)) add('INVALID_RECEIPT');
  else {
    if (receipt.ok !== true) add('FAILED_RECEIPT');
    else {
      try { if (await validate(receipt, {receiptPath}) !== true) add('UNPROVEN_ISOLATION'); } catch { add('UNPROVEN_ISOLATION'); }
    }
    const frame = Array.isArray(receipt.frames) ? receipt.frames.find(f => f?.label === PREVIEW_FRAME) : null;
    if (!frame) add('MISSING_FRAME');
    else {
      const native = frame.capture === 'macos-window-server' && typeof frame.path === 'string' && NATIVE_FRAME_PATH.test(frame.path);
      if (!native) add('NON_NATIVE_FRAME');
      if (preview && sha(preview) !== frame.sha256) add('PREVIEW_MISMATCH');
      const safe = typeof frame.path === 'string' && /^[A-Za-z0-9._/-]+$/.test(frame.path) && !frame.path.split('/').includes('..');
      const captured = safe ? await read(path.join(root, frame.path)) : null;
      if (!captured || sha(captured) !== frame.sha256) add('FRAME_FILE_MISMATCH');
    }
  }
  if (preview && (await mockupHashes(root)).has(sha(preview))) add('MOCKUP_PREVIEW');
  return [...reasons].sort();
}

test('bundle recipe follows the six-part brief with an access disclosure and separate Classic evidence', async () => {
  const bytes = await fs.readFile(path.join(ROOT, BUNDLE, 'RECIPE.md'));
  const recipe = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  assert.ok(!recipe.includes('�'), 'clean UTF-8');
  assert.ok(recipe.startsWith('# Mission Control\n'), 'titled brief');
  let previous = -1;
  for (const title of ['# Mission Control', '## What you see', '## How it behaves', '## Built from', '## Watch out', '## Done when']) {
    const index = recipe.indexOf(title, previous + 1);
    assert.ok(index > previous, title);
    previous = index;
  }
  assert.match(recipe, /!\[Mission Control\]\(preview\.png\)/);
  assert.match(recipe, /\*\*Access disclosure:\*\*/);
  for (const required of ['appHome()/mission-control/', 'Node.js 22', 'Python 3', '`hc`', 'herdr-app check', 'layout.switch'])
    assert.ok(recipe.includes(required), required);
  assert.match(recipe, /authenticated provider access remains separate/i);
  for (const file of LAYOUT_NAMES.flatMap(name => [`layouts/${name}.json`, `layouts/${name}.svg`])) assert.ok(recipe.includes(file), file);
  for (const mod of BUNDLED_MODS) assert.ok(recipe.includes(mod), mod);
  for (const [id, mod] of DESTINATIONS) assert.ok(recipe.includes('`' + id + '`') && recipe.includes(mod), id);
  assert.ok(recipe.includes(CLASSIC_EVIDENCE) && recipe.includes(LAYOUT_RECEIPT), 'Classic evidence is referenced separately from the preview');
  assert.ok(recipe.includes('mission-control-accounts'), 'states the optional accounts mod is not required');
  for (const target of recipeLinks(BUNDLE, recipe)) assert.ok(target.startsWith(BUNDLE + '/'), `relative link stays inside the package: ${target}`);
});

test('both layout files and both Settings SVGs are bundled unchanged with all seven destinations and both GitLab roles', async () => {
  const layouts = await filesBelow(path.join(ROOT, BUNDLE, 'layouts'));
  assert.deepEqual(Object.keys(layouts).sort(), ['mission-control-classic.json', 'mission-control-classic.svg', 'mission-control.json', 'mission-control.svg']);
  const referenced = new Set();
  for (const name of LAYOUT_NAMES) {
    for (const file of [`${name}.json`, `${name}.svg`]) {
      const bundled = await fs.readFile(path.join(ROOT, BUNDLE, 'layouts', file));
      assert.ok(bundled.equals(await fs.readFile(path.join(ROOT, 'src/layouts', file))), `${file} is byte-identical to src/layouts`);
    }
    const tree = JSON.parse(await fs.readFile(path.join(ROOT, BUNDLE, 'layouts', `${name}.json`), 'utf8'));
    assert.equal(tree.preview, `layouts/${name}.svg`);
    const svg = await fs.readFile(path.join(ROOT, BUNDLE, tree.preview), 'utf8');
    assert.match(svg, /^\s*<svg[\s>]/);
    assert.match(svg, new RegExp(`data-view="${name}"`));
    assert.deepEqual(destinationProblems(name, tree), [], name);
    const navigation = findNode(tree, 'mc-navigation');
    assert.deepEqual(navigation?.content, {mod: 'mission-control-tabs', props: {view: 'navigation'}}, `${name} navigation block`);
    const swapTo = findNode(tree, 'mc-topbar')?.content?.props?.swapTo;
    assert.equal(swapTo, LAYOUT_NAMES.find(other => other !== name), `${name} swaps to the other bundled layout`);
    for (const mod of referencedMods(tree)) referenced.add(mod);
  }
  const overviewSlots = [...(await fs.readFile(path.join(ROOT, BUNDLE, 'layouts/mission-control.svg'), 'utf8')).matchAll(/data-source="([a-z]+)"/g)].map(m => m[1]);
  assert.deepEqual(overviewSlots, DESTINATIONS.map(([id]) => id), 'the overview Settings artwork depicts the seven sources');
  assert.deepEqual([...referenced].sort(), [...BUNDLED_MODS]);
});

test('optional accounts is not required by either layout, the bundle or this gate', async () => {
  for (const name of LAYOUT_NAMES) {
    const tree = JSON.parse(await fs.readFile(path.join(ROOT, 'src/layouts', `${name}.json`), 'utf8'));
    for (const mod of OPTIONAL_MODS) assert.ok(!referencedMods(tree).has(mod), `${name} does not reference ${mod}`);
  }
  for (const mod of OPTIONAL_MODS) assert.ok(!BUNDLED_MODS.includes(mod));
  const {reasons} = await inspectBundle();
  assert.ok(!reasons.some(reason => reason.startsWith('ACCOUNTS_REQUIRED')), 'no account mod is pulled into the bundle');
});

test('bundle output contains exactly the referenced mods, byte-identical to their standalone builds', async () => {
  const {reasons, mods} = await inspectBundle();
  assert.deepEqual(reasons, [], 'run node scripts/project.mjs bundle after every standalone package gate passes');
  assert.deepEqual(mods, [...BUNDLED_MODS]);
  assert.deepEqual((await fs.readdir(path.join(ROOT, BUNDLE, 'mods'))).filter(name => name !== '.DS_Store').sort(), [...BUNDLED_MODS]);
});

test('every bundled mod matches its current standalone native receipt, manifest, sources and preview', async () => {
  const results = [];
  for (const name of BUNDLED_MODS) results.push(await reconcilePackage({name, scenario: name.slice('mission-control-'.length)}, {root: ROOT}));
  assert.deepEqual(Object.fromEntries(results.map(r => [r.name, r.reasons])), Object.fromEntries(BUNDLED_MODS.map(name => [name, []])));
});

test('the post-GitLab compatibility receipt passes for every earlier standalone package at current hashes', async () => {
  const receipt = await readJson(path.join(ROOT, COMPATIBILITY_RECEIPT));
  assert.ok(plain(receipt), `${COMPATIBILITY_RECEIPT} exists`);
  assert.equal(receipt.kind, 'gitlab-shared-extension-compatibility');
  assert.deepEqual(receipt.packages.map(p => [p.name, p.ok, p.reasons]), PACKAGES.map(p => [p.name, true, []]));
  assert.equal(receipt.ok, true);
  for (const pkg of PACKAGES) {
    const recorded = receipt.packages.find(p => p.name === pkg.name);
    assert.equal(recorded.previewSha256, sha(await fs.readFile(path.join(ROOT, pkg.name, 'preview.png'))), `${pkg.name} preview unchanged since the compatibility run`);
    assert.deepEqual((await reconcilePackage(pkg, {root: ROOT})).reasons, [], `${pkg.name} still reconciles`);
  }
});

test('preview.png is the layout-preview frame of a passed isolated native run of both layouts', async () => {
  assert.deepEqual(await inspectPreview(), [], 'run node scripts/native-harness.mjs run layout, then promote its layout-preview frame');
  const receiptPath = path.join(ROOT, LAYOUT_RECEIPT), receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(await validateNativeIsolationReceipt(receipt, {receiptPath}), true);
  const preview = await fs.readFile(path.join(ROOT, BUNDLE, 'preview.png')), frame = receipt.frames.find(f => f.label === PREVIEW_FRAME);
  assert.equal(sha(preview), frame.sha256);

  const classic = receipt.frames.filter(f => /classic/.test(f.label));
  assert.ok(classic.length, 'the receipt records a separate Classic frame');
  const classicBytes = await fs.readFile(path.join(ROOT, CLASSIC_EVIDENCE));
  assert.ok(pngInfo(classicBytes), `${CLASSIC_EVIDENCE} is a PNG`);
  assert.ok(classic.some(f => f.sha256 === sha(classicBytes) && f.sha256 !== frame.sha256), 'Classic evidence is its own native frame, not the overview preview');

  assert.ok(receipt.inputActions.some(a => a.kind === 'pointer' && a.pid === receipt.appPid), 'actual PID-bound pointer input');
  for (const name of BUNDLED_MODS) {
    const tested = receipt.packages.find(p => p?.name === name);
    assert.ok(tested?.nativeCheck, `${name} passed herdr-app check in the integrated run`);
    assert.deepEqual(tested.manifest, JSON.parse(await fs.readFile(path.join(ROOT, name, 'build-manifest.json'), 'utf8')), `${name} integrated build equals its standalone manifest`);
  }
  for (const mod of OPTIONAL_MODS) assert.ok(!receipt.packages.some(p => p?.name === mod), `${mod} was not needed`);
  const passed = receipt.assertions.filter(a => a.passed).map(a => a.label);
  for (const [what, pattern] of REQUIRED_EVIDENCE) assert.ok(passed.some(label => pattern.test(label)), `integrated evidence covers ${what}`);
  const recipe = await fs.readFile(path.join(ROOT, BUNDLE, 'RECIPE.md'), 'utf8');
  assert.doesNotMatch(recipe, /<!--\s*draft/i, 'the recipe is finalized from the real native results');
});

/* Negative and boundary cases on an owned fixture tree: none of them needs native input. */

const PNG = width => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(64, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'), header, Buffer.alloc(4)]);
};
const NONCE = 'a1b2c3d4e5f60718293a4b5c';

async function writeFile(file, bytes) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, bytes);
}

/** A complete acceptable fixture: source layouts, seven standalone builds, the bundle, a native-shaped receipt and frame. */
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-package-layout-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  for (const name of LAYOUT_NAMES) {
    for (const file of [`${name}.json`, `${name}.svg`]) {
      const bytes = await fs.readFile(path.join(ROOT, 'src/layouts', file));
      await writeFile(path.join(root, 'src/layouts', file), bytes);
      await writeFile(path.join(root, BUNDLE, 'layouts', file), bytes);
    }
  }
  for (const mod of BUNDLED_MODS) {
    const content = {'main.js': `export default class Fixture {} // ${mod}\n`, 'mod.json': JSON.stringify({title: mod}) + '\n', 'NOTICE.md': '# Included artwork and code\n'};
    for (const [file, text] of Object.entries(content)) {
      await writeFile(path.join(root, mod, 'mods', mod, file), text);
      await writeFile(path.join(root, BUNDLE, 'mods', mod, file), text);
    }
    await writeFile(path.join(root, mod, 'build-manifest.json'), JSON.stringify({v: 1, name: mod, artifacts: await filesBelow(path.join(root, mod, 'mods', mod)), sources: {}}));
  }
  await writeFile(path.join(root, BUNDLE, 'RECIPE.md'), await fs.readFile(path.join(ROOT, BUNDLE, 'RECIPE.md')));
  const preview = PNG(1280), framePath = `.browse/sessions/mission-control-native-${NONCE}/${PREVIEW_FRAME}.png`;
  await writeFile(path.join(root, BUNDLE, 'preview.png'), preview);
  await writeFile(path.join(root, framePath), preview);
  await writeFile(path.join(root, '.browse/sessions/mission-control-design/mission-control.png'), PNG(1024));
  const receipt = {v: 2, ok: true, frames: [{label: PREVIEW_FRAME, capture: 'macos-window-server', path: framePath, sha256: sha(preview), width: 1280, height: 64}]};
  await writeFile(path.join(root, LAYOUT_RECEIPT), JSON.stringify(receipt));
  await rewriteManifest(root);
  return root;
}
async function rewriteManifest(root) {
  const bundle = path.join(root, BUNDLE), artifacts = await filesBelow(bundle);
  delete artifacts['build-manifest.json'];
  await writeFile(path.join(bundle, 'build-manifest.json'), JSON.stringify({v: 1, name: BUNDLE, artifacts}));
}
const accept = async () => true;
const has = (reasons, prefix) => reasons.some(reason => reason === prefix || reason.startsWith(prefix + ':'));

test('fixture: a complete bundle and native-shaped preview are accepted without any accounts artifacts', async t => {
  const root = await fixture(t);
  assert.deepEqual(await inspectBundle({root}), {reasons: [], mods: [...BUNDLED_MODS]});
  assert.deepEqual(await inspectPreview({root, validate: accept}), []);
  assert.equal(await fs.stat(path.join(root, 'mission-control-accounts')).then(() => true, () => false), false);
});

test('fixture: a missing, outdated, unexpected or stale mod fails the bundle', async t => {
  const root = await fixture(t);
  await fs.rm(path.join(root, BUNDLE, 'mods/mission-control-gitlab'), {recursive: true});
  await rewriteManifest(root);
  assert.ok(has((await inspectBundle({root})).reasons, 'MISSING_MOD'), 'missing GitLab mod');

  const outdated = await fixture(t), standalone = path.join(outdated, 'mission-control-jira/mods/mission-control-jira/main.js');
  await fs.appendFile(standalone, '// rebuilt standalone\n');
  await writeFile(path.join(outdated, 'mission-control-jira/build-manifest.json'), JSON.stringify({v: 1, name: 'mission-control-jira', artifacts: await filesBelow(path.dirname(standalone)), sources: {}}));
  assert.deepEqual((await inspectBundle({root: outdated})).reasons, ['MOD_MISMATCH:mission-control-jira'], 'bundled copy older than its standalone build');

  const stale = await fixture(t);
  await fs.appendFile(path.join(stale, 'mission-control-tabs/mods/mission-control-tabs/main.js'), '// hand edit\n');
  await fs.appendFile(path.join(stale, BUNDLE, 'mods/mission-control-tabs/main.js'), '// hand edit\n');
  await rewriteManifest(stale);
  assert.deepEqual((await inspectBundle({root: stale})).reasons, ['STALE_STANDALONE:mission-control-tabs'], 'standalone bytes differ from their build manifest');

  const extra = await fixture(t);
  await writeFile(path.join(extra, BUNDLE, 'mods/mission-control-agent-menu/main.js'), 'export default class Extra {}\n');
  await rewriteManifest(extra);
  assert.ok(has((await inspectBundle({root: extra})).reasons, 'UNEXPECTED_MOD'), 'unreferenced mod');

  const edited = await fixture(t);
  await fs.appendFile(path.join(edited, BUNDLE, 'RECIPE.md'), '\nedited after bundling\n');
  assert.deepEqual((await inspectBundle({root: edited})).reasons, ['MANIFEST_MISMATCH'], 'bundle manifest must cover the final files');
});

test('fixture: a lost GitLab role, destination or Settings SVG and a required accounts mod fail the bundle', async t => {
  const root = await fixture(t), file = path.join(root, BUNDLE, 'layouts/mission-control-classic.json');
  const tree = JSON.parse(await fs.readFile(file, 'utf8'));
  findNode(tree, 'mc-work-stack').children = findNode(tree, 'mc-work-stack').children.filter(child => child.id !== 'merges');
  await fs.writeFile(file, JSON.stringify(tree, null, 2) + '\n');
  await rewriteManifest(root);
  const reasons = (await inspectBundle({root})).reasons;
  for (const code of ['LAYOUT_MISMATCH', 'MISSING_DESTINATION', 'MISSING_GITLAB_ROLE']) assert.ok(has(reasons, code), code);

  const svg = await fixture(t);
  await fs.rm(path.join(svg, BUNDLE, 'layouts/mission-control.svg'));
  await rewriteManifest(svg);
  const svgReasons = (await inspectBundle({root: svg})).reasons;
  assert.ok(has(svgReasons, 'MISSING_LAYOUT') && has(svgReasons, 'PREVIEW_PATH'), 'Settings SVG preview');

  const accounts = await fixture(t);
  for (const dir of ['src/layouts', BUNDLE + '/layouts']) {
    const layout = path.join(accounts, dir, 'mission-control.json'), value = JSON.parse(await fs.readFile(layout, 'utf8'));
    value.children.push({id: 'mc-accounts', type: 'block', size: {px: 28}, content: {mod: 'mission-control-accounts'}});
    await fs.writeFile(layout, JSON.stringify(value, null, 2) + '\n');
  }
  await rewriteManifest(accounts);
  const accountReasons = (await inspectBundle({root: accounts})).reasons;
  assert.ok(has(accountReasons, 'ACCOUNTS_REQUIRED'), 'the optional accounts mod is never silently required');
});

test('fixture: an absent preview, browser or mockup frame, mismatched frame and unproven receipt fail', async t => {
  const missing = await fixture(t);
  await fs.rm(path.join(missing, BUNDLE, 'preview.png'));
  assert.deepEqual(await inspectPreview({root: missing, validate: accept}), ['MISSING_PREVIEW']);

  const browser = await fixture(t), mockup = '.browse/sessions/mission-control-design/mission-control.png', bytes = await fs.readFile(path.join(browser, mockup));
  await fs.writeFile(path.join(browser, BUNDLE, 'preview.png'), bytes);
  await writeFile(path.join(browser, LAYOUT_RECEIPT), JSON.stringify({v: 2, ok: true, frames: [{label: PREVIEW_FRAME, capture: 'browser', path: mockup, sha256: sha(bytes), width: 1024, height: 64}]}));
  assert.deepEqual(await inspectPreview({root: browser, validate: accept}), ['MOCKUP_PREVIEW', 'NON_NATIVE_FRAME']);

  const disguised = await fixture(t), native = `.browse/sessions/mission-control-native-${NONCE}/${PREVIEW_FRAME}.png`, copied = await fs.readFile(path.join(disguised, mockup));
  await fs.writeFile(path.join(disguised, BUNDLE, 'preview.png'), copied);
  await fs.writeFile(path.join(disguised, native), copied);
  await writeFile(path.join(disguised, LAYOUT_RECEIPT), JSON.stringify({v: 2, ok: true, frames: [{label: PREVIEW_FRAME, capture: 'macos-window-server', path: native, sha256: sha(copied), width: 1024, height: 64}]}));
  assert.deepEqual(await inspectPreview({root: disguised, validate: accept}), ['MOCKUP_PREVIEW'], 'mockup bytes behind native-looking metadata');

  const swapped = await fixture(t);
  await fs.writeFile(path.join(swapped, BUNDLE, 'preview.png'), PNG(900));
  assert.deepEqual(await inspectPreview({root: swapped, validate: accept}), ['PREVIEW_MISMATCH']);

  const unproven = await fixture(t);
  assert.deepEqual(await inspectPreview({root: unproven}), ['UNPROVEN_ISOLATION'], 'the canonical validator rejects a fabricated receipt');
  await writeFile(path.join(unproven, LAYOUT_RECEIPT), JSON.stringify({v: 2, ok: false, frames: []}));
  assert.deepEqual(await inspectPreview({root: unproven, validate: accept}), ['FAILED_RECEIPT', 'MISSING_FRAME']);
  await fs.rm(path.join(unproven, LAYOUT_RECEIPT));
  assert.deepEqual(await inspectPreview({root: unproven, validate: accept}), ['MISSING_RECEIPT']);
});
