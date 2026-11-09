// Disable, enable, uninstall and restore (Node helper only). Every change is one journalled store.commit, so a
// killed helper is rolled back at the next start. Built-in, installer-managed and self items are refused, as are
// the active layout and any mod the active layout uses; other layouts that use a mod need a confirmation.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {recordsRoot} from './source.mjs';
import {layoutMods} from './inventory.mjs';
import {planKeys} from './apply.mjs';

export const REMOVED_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
export class LifecycleError extends Error {
  constructor(code, message, detail) { super(message); this.name = 'LifecycleError'; this.code = code; if (detail) this.detail = detail; }
}
const refuse = (code, message, detail) => { throw new LifecycleError(code, message, detail); };

async function readJson(file) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; } }

/** Installed layouts (enabled ones) that reference a mod. */
export async function layoutsUsing(appHome, modName) {
  const dir = path.join(appHome, 'layouts'), out = [];
  let files = [];try { files = (await fs.readdir(dir)).filter(f => f.endsWith('.json') && !f.startsWith('.')); } catch {}
  for (const file of files.sort()) if (layoutMods(await readJson(path.join(dir, file))).includes(modName)) out.push(file.replace(/\.json$/, ''));
  return out;
}

function guard(item, {activeLayout}) {
  if (item.origin === 'builtin') refuse('BUILT_IN', `${item.name} is built into Herdr; Herdr restores and updates it itself.`);
  if (item.origin === 'installer') refuse('INSTALLER_MANAGED', `${item.name} was installed with Mission Control; remove it with the installer.`);
  if (item.origin === 'self') refuse('SELF', 'The Mods manager cannot disable or remove itself.');
  if (item.kind === 'layout' && item.name === activeLayout) refuse('ACTIVE_LAYOUT', `${item.name} is the layout on screen; switch to another layout first.`);
}

function paths(appHome, item) {
  const records = recordsRoot(appHome);
  return item.kind === 'mod'
    ? {live: [path.join(appHome, 'mods', item.name)], disabled: [path.join(records, 'disabled', 'mods', item.name)]}
    : {live: ['.json', '.svg'].map(ext => path.join(appHome, 'layouts', item.name + ext)), disabled: ['.json', '.svg'].map(ext => path.join(records, 'disabled', 'layouts', item.name + ext))};
}

/** Check the layout references first; returns {needsConfirm, layouts} when other layouts use the mod. */
async function references(appHome, item, {activeLayout, confirm}) {
  if (item.kind !== 'mod') return null;
  const users = await layoutsUsing(appHome, item.name);
  if (activeLayout && users.includes(activeLayout)) refuse('USED_BY_ACTIVE_LAYOUT', `${item.name} is used by the layout on screen (${activeLayout}).`, {layouts: users});
  if (users.length && !confirm) return {needsConfirm: true, layouts: users};
  return null;
}

export async function disable({appHome, store, item, activeLayout = null, confirm = false}) {
  guard(item, {activeLayout});
  const pending = await references(appHome, item, {activeLayout, confirm});if (pending) return pending;
  const {live, disabled} = paths(appHome, item);
  const ops = live.map((from, i) => ({from, to: disabled[i]})).filter(m => fsSync.existsSync(m.from)).map(m => ({type: 'move', ...m}));
  if (!ops.length) refuse('NOT_INSTALLED', `${item.name} is not installed.`);
  await store.commit(ops, {label: `disable ${item.kind}:${item.name}`});
  await store.updatePackages(v => { v.packages[`${item.kind}:${item.name}`] = {...(v.packages[`${item.kind}:${item.name}`] || {kind: item.kind, name: item.name}), disabled: true}; });
  return {ok: true, state: 'disabled'};
}

export async function enable({appHome, store, item}) {
  const {live, disabled} = paths(appHome, item);
  const ops = disabled.map((from, i) => ({from, to: live[i]})).filter(m => fsSync.existsSync(m.from));
  if (!ops.length) refuse('NOT_DISABLED', `${item.name} is not disabled.`);
  if (ops.some(m => fsSync.existsSync(m.to))) refuse('NAME_TAKEN', `Another ${item.kind} named ${item.name} is installed now.`);
  await store.commit(ops.map(m => ({type: 'move', ...m})), {label: `enable ${item.kind}:${item.name}`});
  await store.updatePackages(v => { const r = v.packages[`${item.kind}:${item.name}`];if (r) r.disabled = false; });
  return {ok: true, state: 'enabled'};
}

/** Move to removed/<kind>-<name>/<time>/ and remove only keys the item added (while they still equal). */
export async function uninstall({appHome, store, item, activeLayout = null, confirm = false, now = () => Date.now()}) {
  guard(item, {activeLayout});
  const pending = await references(appHome, item, {activeLayout, confirm});if (pending) return pending;
  const key = `${item.kind}:${item.name}`, records = recordsRoot(appHome), stamp = String(now());
  const target = path.join(records, 'removed', `${item.kind}-${item.name}`, stamp);
  const from = item.disabled ? paths(appHome, item).disabled : paths(appHome, item).live;
  const ops = from.filter(p => fsSync.existsSync(p)).map(p => ({type: 'move', from: p, to: path.join(target, path.basename(p))}));
  if (!ops.length) refuse('NOT_INSTALLED', `${item.name} is not installed.`);
  const record = (await store.readPackages()).packages[key] || {};
  let removedKeys = [];
  if (record.keys?.length) {
    let userKeys = {};try { userKeys = JSON.parse(await fs.readFile(path.join(appHome, 'keys.json'), 'utf8')); } catch {}
    const plan = planKeys(userKeys, {}, record.keys);
    if (plan.remove.length) { removedKeys = plan.remove;ops.push({type: 'write', target: path.join(appHome, 'keys.json'), data: JSON.stringify(plan.keys, null, 2) + '\n'}); }
  }
  await store.commit(ops, {label: `uninstall ${key}`});
  await store.updatePackages(v => {
    v.removed ??= {};v.removed[`${key}@${stamp}`] = {kind: item.kind, name: item.name, at: Number(stamp), dir: target, wasDisabled: Boolean(item.disabled), keys: removedKeys, record};
    delete v.packages[key];
  });
  return {ok: true, state: 'removed', restoreUntil: Number(stamp) + REMOVED_KEEP_MS, removedKeys};
}

/** Put a removed item back where it was (disabled ones back to disabled) and re-add its keys where still free. */
export async function restore({appHome, store, id}) {
  const removed = (await store.readPackages()).removed?.[id];
  if (!removed) refuse('NOT_FOUND', 'That removed item no longer exists.');
  const item = {kind: removed.kind, name: removed.name}, places = removed.wasDisabled ? paths(appHome, item).disabled : paths(appHome, item).live;
  const ops = places.map(to => ({from: path.join(removed.dir, path.basename(to)), to})).filter(m => fsSync.existsSync(m.from));
  if (ops.some(m => fsSync.existsSync(m.to))) refuse('NAME_TAKEN', `Another ${item.kind} named ${item.name} is installed now.`);
  const all = ops.map(m => ({type: 'move', ...m}));
  if (removed.keys?.length) {
    let userKeys = {};try { userKeys = JSON.parse(await fs.readFile(path.join(appHome, 'keys.json'), 'utf8')); } catch {}
    const snippet = {};for (const k of removed.keys) (snippet[k.section] ??= {})[k.key] = k.action;
    const plan = planKeys(userKeys, snippet, []);
    if (plan.add.length) all.push({type: 'write', target: path.join(appHome, 'keys.json'), data: JSON.stringify(plan.keys, null, 2) + '\n'});
  }
  await store.commit(all, {label: `restore ${removed.kind}:${removed.name}`});
  await store.updatePackages(v => { delete v.removed[id];v.packages[`${removed.kind}:${removed.name}`] = {...(removed.record || {}), kind: removed.kind, name: removed.name, disabled: removed.wasDisabled}; });
  await fs.rm(removed.dir, {recursive: true, force: true});
  return {ok: true, state: removed.wasDisabled ? 'disabled' : 'enabled'};
}

/** Delete removed items older than 30 days (the uninstall confirmation says so). */
export async function pruneRemoved({store, now = () => Date.now()}) {
  const removed = (await store.readPackages()).removed || {}, gone = [];
  for (const [id, r] of Object.entries(removed)) if (now() - r.at > REMOVED_KEEP_MS) { await fs.rm(r.dir, {recursive: true, force: true});gone.push(id); }
  if (gone.length) await store.updatePackages(v => { for (const id of gone) delete v.removed[id]; });
  return gone;
}

/** Before the Mods manager itself is removed: enable everything disabled and restore everything removed. */
export async function restoreEverything({appHome, store}) {
  const records = recordsRoot(appHome), done = [];
  for (const [kind, sub] of [['mod', 'mods'], ['layout', 'layouts']]) {
    let names = [];try { names = await fs.readdir(path.join(records, 'disabled', sub)); } catch {}
    for (const n of new Set(names.filter(x => !x.startsWith('.')).map(x => kind === 'layout' ? x.replace(/\.(json|svg)$/, '') : x))) {
      try { await enable({appHome, store, item: {kind, name: n}});done.push(`${kind}:${n}`); } catch {}
    }
  }
  for (const id of Object.keys((await store.readPackages()).removed || {})) { try { await restore({appHome, store, id});done.push(id); } catch {} }
  return done;
}
