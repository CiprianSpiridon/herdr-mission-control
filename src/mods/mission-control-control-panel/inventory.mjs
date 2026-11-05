// Inventory of installed mods and layouts, and adoption of each user item's exact origin (Node helper only).
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {recordsRoot} from './source.mjs';

export const SELF = 'mission-control-control-panel';
/** Files Herdr or herdr-app check writes into a mod folder; never part of an item's identity. */
export const GENERATED = /(^|\/)(gpui-kit\.d\.ts|herdr\.d\.ts|jsconfig\.json|runtime\.json|\.DS_Store)$/;
const MAX_FILES = 500, MAX_FILE_BYTES = 8 * 1024 * 1024;

/** The SHA git gives a file's bytes, so installed files compare directly with repository trees. */
export const gitBlobSha = data => crypto.createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');

async function readJson(file) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; } }

/** Every regular file below dir as {relativePath: blobSha}, skipping generated files and symlinks. */
export async function hashTree(dir) {
  const out = {};
  async function walk(current, rel) {
    let entries;try { entries = await fs.readdir(current, {withFileTypes: true}); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = rel ? `${rel}/${entry.name}` : entry.name, full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { await walk(full, relative);continue; }
      if (!entry.isFile() || GENERATED.test(relative)) continue;
      if (Object.keys(out).length >= MAX_FILES) return;
      const info = await fs.stat(full);if (info.size > MAX_FILE_BYTES) continue;
      out[relative] = gitBlobSha(await fs.readFile(full));
    }
  }
  await walk(dir, '');
  return out;
}

/** List and classify what is installed. Returns {items:[...], shipped, installer}. */
export async function scan(appHome) {
  const records = recordsRoot(appHome);
  const shipped = new Set(Object.keys((await readJson(path.join(appHome, 'installed.json'))) || {}));
  const manifest = (await readJson(path.join(appHome, 'mission-control', 'installed-packages.json')))?.packages || {};
  const installer = new Map();
  for (const [pkg, entry] of Object.entries(manifest)) {
    for (const name of entry?.mods || []) installer.set('mod:' + name, pkg);
    for (const name of entry?.layouts || []) installer.set('layout:' + String(name).replace(/\.json$/, ''), pkg);
  }
  const items = [];
  const classify = (kind, name, extra = {}) => {
    const key = `${kind}:${name}`;
    const shippedKey = kind === 'mod' ? name : key;
    const origin = shipped.has(shippedKey) ? 'builtin' : name === SELF && kind === 'mod' ? 'self' : installer.has(key) ? 'installer' : extra.clonedFrom ? 'clone' : 'user';
    return {key, kind, name, origin, ...(installer.has(key) ? {installerPackage: installer.get(key)} : {}), ...extra};
  };
  for (const [base, disabled] of [[path.join(appHome, 'mods'), false], [path.join(records, 'disabled', 'mods'), true]]) {
    let names = [];try { names = (await fs.readdir(base, {withFileTypes: true})).filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name); } catch {}
    for (const name of names.sort()) {
      const dir = path.join(base, name), manifestJson = await readJson(path.join(dir, 'mod.json'));
      items.push(classify('mod', name, {dir, disabled, files: await hashTree(dir), clonedFrom: manifestJson?.cloned_from ?? null, title: typeof manifestJson?.title === 'string' ? manifestJson.title : null}));
    }
  }
  for (const [base, disabled] of [[path.join(appHome, 'layouts'), false], [path.join(records, 'disabled', 'layouts'), true]]) {
    let names = [];try { names = (await fs.readdir(base)).filter(n => n.endsWith('.json') && !n.startsWith('.')); } catch {}
    for (const file of names.sort()) {
      const name = file.replace(/\.json$/, ''), full = path.join(base, file), layout = await readJson(full);
      const files = {[file]: gitBlobSha(await fs.readFile(full))};
      try { files[name + '.svg'] = gitBlobSha(await fs.readFile(path.join(base, name + '.svg'))); } catch {}
      items.push(classify('layout', name, {file: full, disabled, files, clonedFrom: layout?.cloned_from ?? null, mods: layoutMods(layout)}));
    }
  }
  return {items, shipped, installer};
}

/** Mod names a layout tree references (content.mod and terminal_menu). */
export function layoutMods(tree) {
  const found = new Set();let seen = 0;
  (function walk(node) {
    if (!node || typeof node !== 'object' || ++seen > 5000) return;
    if (typeof node.content?.mod === 'string') found.add(node.content.mod);
    if (typeof node.terminal_menu === 'string') found.add(node.terminal_menu);
    if (typeof node.mod === 'string') found.add(node.mod);
    for (const value of Object.values(node)) if (value && typeof value === 'object') walk(value);
  })(tree);
  return [...found].sort();
}

/** An item's files inside a catalog entry's folder, keyed the way they are installed. */
export function subtree(entry, item) {
  const base = entry.path ? entry.path + '/' : '';
  return item.kind === 'mod'
    ? {prefix: `${base}mods/${item.name}/`, paths: [`${base}mods/${item.name}`], strip: `${base}mods/${item.name}/`}
    : {prefix: `${base}layouts/`, paths: [`${base}layouts/${item.name}.json`, `${base}layouts/${item.name}.svg`], strip: `${base}layouts/`};
}

/** Catalog entries that publish this item: mods by modNames (or the mods folder of a layout entry), layouts by layoutFiles. */
export function candidates(catalogs, item, {layoutsUsing = []} = {}) {
  if (item.kind === 'layout') return (catalogs.layouts?.entries || []).filter(entry => entry.names.includes(item.name));
  // A mod is published by a mods entry naming it, or ships inside the folder of a layout entry whose layout uses it.
  return [...(catalogs.mods?.entries || []).filter(entry => entry.names.includes(item.name)),
    ...(catalogs.layouts?.entries || []).filter(entry => entry.names.some(name => layoutsUsing.includes(name)))];
}

/**
 * Find an item's origin among catalog candidates. The commit whose subtree holds every installed blob wins; several
 * exact matches prefer the repository already recorded; with no exact match a single candidate gives its closest
 * commit (the item is edited), and several give an ambiguous item listing them.
 */
export async function adopt(source, catalogs, item, {previous = null, maxCommits = 40, layoutsUsing = []} = {}) {
  const pool = candidates(catalogs, item, {layoutsUsing});
  if (!pool.length) return {state: 'untracked', reason: 'No herdr.dev entry publishes this name.'};
  const results = [];
  for (const entry of pool) {
    const ready = await source.ensure(entry.url);
    if (ready.state !== 'ready') { results.push({entry, state: ready.state, reason: ready.reason});continue; }
    const scope = subtree(entry, item);
    let history;try { history = await source.log(entry.url, {ref: entry.defaultBranch, paths: scope.paths, max: maxCommits}); } catch { continue; }
    if (!history.length) continue; // a layout entry's mods folder does not hold this mod
    let best = null;
    for (const commit of history) {
      const files = Object.fromEntries((await source.tree(entry.url, commit.commit, scope.paths))
        .filter(f => f.path.startsWith(scope.strip) && !GENERATED.test(f.path)).map(f => [f.path.slice(scope.strip.length), f.sha]));
      if (!Object.keys(files).length) continue;
      const names = new Set([...Object.keys(files), ...Object.keys(item.files)]);
      const equal = [...names].filter(n => files[n] === item.files[n]).length;
      const candidate = {entry, commit: commit.commit, time: commit.time, subject: commit.subject, files, equal, total: names.size, exact: equal === names.size};
      if (candidate.exact) { best = candidate;break; }
      if (!best || equal > best.equal) best = candidate;
    }
    if (best) results.push({...best, state: 'found'});
  }
  const found = results.filter(r => r.state === 'found');
  if (!found.length) {
    const pending = results.find(r => r.state === 'pending' || r.state === 'too-large' || r.state === 'unreachable');
    return pending ? {state: pending.state, reason: pending.reason} : {state: 'untracked', reason: 'No published version matches this item.'};
  }
  const exact = found.filter(r => r.exact);
  let chosen = null;
  if (exact.length === 1) chosen = exact[0];
  else if (exact.length > 1) chosen = exact.find(r => r.entry.fullName === previous?.source?.fullName) || null;
  else if (found.length === 1) chosen = found[0];
  else chosen = found.find(r => r.entry.fullName === previous?.source?.fullName) || null;
  if (!chosen) return {state: 'ambiguous', candidates: (exact.length ? exact : found).map(r => ({fullName: r.entry.fullName, path: r.entry.path, url: r.entry.url, defaultBranch: r.entry.defaultBranch, exact: r.exact}))};
  const edited = [...new Set([...Object.keys(chosen.files), ...Object.keys(item.files)])].filter(n => chosen.files[n] !== item.files[n]).sort();
  return {
    state: edited.length ? 'edited' : 'current',
    source: {url: chosen.entry.url, fullName: chosen.entry.fullName, path: chosen.entry.path, defaultBranch: chosen.entry.defaultBranch, previewUrl: chosen.entry.previewUrl ?? null},
    commit: chosen.commit, commitTime: chosen.time, subject: chosen.subject, base: chosen.files, edited
  };
}
