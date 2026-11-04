#!/usr/bin/env node
// Mods manager helper: `node backend.mjs '<json request>'`, run by the panel through Herdr's exec (30 s limit).
// Every run first finishes or undoes an interrupted change, then does at most ~24 s of work and says if more is due.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createSource, recordsRoot} from './source.mjs';
import {createStore} from './store.mjs';
import {scan, adopt} from './inventory.mjs';
import {checkItem} from './updates.mjs';
import {prepare, commit} from './apply.mjs';
import {disable, enable, uninstall, restore, restoreEverything, pruneRemoved, layoutsUsing, REMOVED_KEEP_MS} from './lifecycle.mjs';

const BUDGET_MS = 24000;

export async function handle(request, {env = process.env, now = () => Date.now(), herdrApp = env.QA_MODS_HERDR_APP || 'herdr-app'} = {}) {
  const started = Date.now(), timeLeft = () => BUDGET_MS - (Date.now() - started);
  const appHome = request?.appHome;
  if (typeof appHome !== 'string' || !path.isAbsolute(appHome)) return {v: 1, ok: false, code: 'INVALID_REQUEST', message: 'An absolute app home is required.'};
  const source = createSource({appHome, env, now}), store = createStore({appHome, now});
  const recovered = await store.recover();
  const items = async () => (await scan(appHome)).items;
  const find = async key => (await items()).find(i => i.key === key) || failWith('NOT_FOUND', 'That item is no longer installed.');
  const record = async key => (await store.readPackages()).packages[key] || null;
  switch (request.op) {
    case 'inventory': return {v: 1, ok: true, recovered, ...(await inventory())};
    case 'check': return {v: 1, ok: true, recovered, ...(await check())};
    case 'prepare': {
      const r = await record(request.key);if (!r?.lastResult?.update) failWith('NO_UPDATE', 'There is no update to apply; check again.');
      return {v: 1, ok: true, recovered, prepared: await prepare({appHome, source, record: r, update: r.lastResult.update, resolutions: request.resolutions || {}, herdrApp, env})};
    }
    case 'commit': {
      const r = await record(request.key);if (!r) failWith('NOT_FOUND', 'That item has no record.');
      return {v: 1, ok: true, recovered, committed: await commit({appHome, store, record: r, now})};
    }
    case 'disable': return {v: 1, ok: true, recovered, result: await disable({appHome, store, item: await find(request.key), activeLayout: request.activeLayout ?? null, confirm: Boolean(request.confirm)})};
    case 'enable': return {v: 1, ok: true, recovered, result: await enable({appHome, store, item: await find(request.key)})};
    case 'uninstall': return {v: 1, ok: true, recovered, result: await uninstall({appHome, store, item: await find(request.key), activeLayout: request.activeLayout ?? null, confirm: Boolean(request.confirm), now})};
    case 'restore': return {v: 1, ok: true, recovered, result: await restore({appHome, store, id: request.id})};
    case 'restore-all': return {v: 1, ok: true, recovered, restored: await restoreEverything({appHome, store})};
    case 'link': return {v: 1, ok: true, recovered, result: await link()};
    case 'recover': return {v: 1, ok: true, recovered};
    default: return {v: 1, ok: false, code: 'INVALID_REQUEST', message: 'Unknown operation.'};
  }

  /** Classify, adopt items that have no record yet (within the budget) and describe everything for the panel. */
  async function inventory() {
    const all = await items(), pkgs = (await store.readPackages()).packages;
    let catalogs = null, partial = false;
    const fresh = all.filter(i => i.origin === 'user' && !pkgs[i.key]);
    if (fresh.length) {
      catalogs = {mods: await source.catalog('mods').catch(() => null), layouts: await source.catalog('layouts').catch(() => null)};
      for (const item of fresh) {
        if (timeLeft() < 6000) { partial = true;break; }
        const result = await adopt(source, catalogs, item, {layoutsUsing: item.kind === 'mod' ? (await layoutsUsing(appHome, item.name)) : []}).catch(error => ({state: 'unreachable', reason: error.message}));
        if (['pending', 'unreachable', 'too-large'].includes(result.state)) { partial ||= result.state === 'pending';continue; }
        await store.updatePackages(v => { v.packages[item.key] = {kind: item.kind, name: item.name, ...result, adoptedAt: now()}; });
      }
    }
    await pruneRemoved({store, now});
    await cachePreviews();
    return {...(await describe()), partial};
  }

  /** Download missing preview thumbnails (the repository's own preview.png from herdr.dev), a few per call. */
  async function cachePreviews() {
    const dir = path.join(recordsRoot(appHome), 'cache', 'previews'), pkgs = (await store.readPackages()).packages;let fetched = 0;
    for (const [key, r] of Object.entries(pkgs)) {
      const url = r.source?.previewUrl, file = path.join(dir, key.replace(':', '-') + '.png');
      if (!url || fetched >= 6 || timeLeft() < 4000) continue;
      if (await fs.access(file).then(() => true, () => false)) continue;
      try {
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 4000);
        const response = await fetch(url, {signal: controller.signal}).finally(() => clearTimeout(timer));
        const data = Buffer.from(await response.arrayBuffer());
        if (!response.ok || data.length > 3 * 1024 * 1024 || data.subarray(0, 4).toString('hex') !== '89504e47') continue;
        await fs.mkdir(dir, {recursive: true});await store.writeAtomic(file, data);fetched++;
      } catch {}
    }
  }

  /** Re-check adopted items for new versions (catalog headCommit gated), within the budget. */
  async function check() {
    const catalogs = {mods: await source.catalog('mods').catch(() => null), layouts: await source.catalog('layouts').catch(() => null)};
    const pkgs = (await store.readPackages()).packages;let partial = false;
    for (const [key, r] of Object.entries(pkgs)) {
      if (!r.source || r.disabled) continue;
      if (timeLeft() < 6000) { partial = true;break; }
      const result = await checkItem(source, catalogs, r).catch(error => ({state: 'unreachable', reason: error.message}));
      await store.updatePackages(v => { const cur = v.packages[key];if (!cur) return;cur.lastResult = result;cur.headCommit = result.headCommit ?? cur.headCommit;cur.remoteHead = result.remoteHead ?? cur.remoteHead;cur.checkedAt = now(); });
    }
    return {...(await describe()), partial, checkedAt: now(), catalogAge: catalogs.mods?.fetchedAt ? now() - catalogs.mods.fetchedAt : null};
  }

  /** Adopt an untracked or ambiguous item from a pasted github.com folder link. */
  async function link() {
    const item = await find(request.key), m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/tree\/([^/]+)(?:\/(.*))?)?\/?$/.exec(String(request.url || '').trim());
    if (!m) failWith('INVALID_LINK', 'Paste a github.com repository or folder link.');
    let folder = (m[4] || '').replace(/\/+$/, '');
    for (const tail of [`mods/${item.name}`, `layouts`]) if (folder.endsWith(tail)) folder = folder.slice(0, -tail.length).replace(/\/+$/, '');
    const entry = {kind: item.kind === 'mod' ? 'mods' : 'layouts', fullName: `${m[1]}/${m[2]}`, url: `https://github.com/${m[1]}/${m[2]}`, defaultBranch: m[3] || 'main', path: folder, names: [item.name], previewUrl: null};
    const result = await adopt(source, item.kind === 'mod' ? {mods: {entries: [entry]}, layouts: {entries: []}} : {mods: {entries: []}, layouts: {entries: [entry]}}, item);
    if (!['current', 'edited'].includes(result.state)) failWith('NO_MATCH', result.reason || 'That folder does not hold this item.');
    await store.updatePackages(v => { v.packages[item.key] = {kind: item.kind, name: item.name, ...result, linked: true, adoptedAt: now()}; });
    return {state: result.state};
  }

  async function describe() {
    const all = await items(), value = await store.readPackages(), records = recordsRoot(appHome);
    const out = [];
    for (const i of all) {
      const r = value.packages[i.key] || {}, last = r.lastResult || {};
      const state = i.origin !== 'user' ? i.origin : i.disabled ? 'disabled' : last.state === 'update' ? 'update' : r.state || 'unknown';
      const preview = path.join(records, 'cache', 'previews', `${i.kind}-${i.name}.png`), previewRel = path.relative(appHome, preview);
      out.push({key: i.key, kind: i.kind, name: i.name, title: i.title || null, origin: i.origin, disabled: Boolean(i.disabled), state,
        reason: last.reason || r.reason || null, source: r.source ? {fullName: r.source.fullName, path: r.source.path, url: r.source.url} : null,
        commit: r.commit || null, subject: r.subject || null, edited: r.edited || [], candidates: r.candidates || [],
        update: last.update ? {subject: last.update.subject, time: last.update.time, changed: last.update.changed.length, added: last.update.added.length, removed: last.update.removed.length} : null,
        usedBy: i.kind === 'mod' ? await layoutsUsing(appHome, i.name) : [], installerPackage: i.installerPackage || null,
        preview: await fs.access(preview).then(() => previewRel, () => null)});
    }
    const removed = Object.entries(value.removed || {}).map(([id, r]) => ({id, kind: r.kind, name: r.name, at: r.at, restoreUntil: r.at + REMOVED_KEEP_MS}));
    return {list: out, removed};
  }
}

function failWith(code, message) { throw Object.assign(new Error(message), {code}); }

if (import.meta.url === `file://${process.argv[1]}`) {
  let request;
  try { request = JSON.parse(process.argv[2] || '{}'); } catch { request = {}; }
  handle(request).then(result => process.stdout.write(JSON.stringify(result)),
    error => process.stdout.write(JSON.stringify({v: 1, ok: false, code: error.code || 'FAILED', message: String(error.message || 'The Mods helper failed.').slice(0, 600), ...(error.detail ? {detail: error.detail} : {})})));
}
