// A layout package includes the installed mods it shipped with, not only its JSON and preview.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {prepare, commitMany, readPrepared} from './apply.mjs';
import {SELF} from './inventory.mjs';
import {recordsRoot} from './source.mjs';

const fail = (code, message) => { throw Object.assign(new Error(message), {code}); };
const stageFor = (home, r) => path.join(recordsRoot(home), 'stage', `${r.kind}-${r.name}`);
const bundleStage = (home, layout) => path.join(recordsRoot(home), 'stage', `bundle-${layout.name}`);
const prefix = r => r.kind === 'mod' ? `mods/${r.name}/` : 'layouts/';
const pending = r => r?.lastResult?.state === 'update' && r.lastResult.update;

/** Only enabled members of the installed package, from the same repository/branch, can join its update. */
export function layoutUpdateKeys(layout, items, packages) {
  if (layout.kind !== 'layout' || layout.disabled || ['builtin', 'clone'].includes(layout.origin)) return [];
  const source = packages[layout.key]?.source;
  const members = items.filter(i => i.key === layout.key || i.kind === 'mod' && !i.disabled && !['builtin', 'clone'].includes(i.origin) &&
    (layout.installerPackage ? i.installerPackage === layout.installerPackage : layout.mods?.includes(i.name) && packages[i.key]?.source?.path === source?.path) &&
    source?.url && packages[i.key]?.source?.url === source.url && packages[i.key]?.source?.defaultBranch === source.defaultBranch);
  return members.filter(i => pending(packages[i.key])).sort((a, b) =>
    Number(a.name === SELF) - Number(b.name === SELF) || Number(a.kind === 'layout') - Number(b.kind === 'layout') || a.key.localeCompare(b.key)).map(i => i.key);
}

/** Prepare one member per helper call so native checks stay within Herdr's exec limit. */
export async function prepareLayout({appHome, layout, items, packages, source, resolutions = {}, continuation, herdrApp, env}) {
  const keys = layoutUpdateKeys(layout, items, packages);
  if (!keys.length) fail('NO_UPDATE', 'There is no update to apply; check again.');
  const root = bundleStage(appHome, layout), file = path.join(root, 'bundle.json');
  const signature = JSON.stringify([keys.map(key => [key, packages[key].commit, packages[key].lastResult.update.commit]), resolutions]);
  let batch;
  if (continuation) {
    try { batch = JSON.parse(await fs.readFile(file, 'utf8')); } catch { fail('NOT_PREPARED', 'Start preparing the layout update again.'); }
    if (batch.token !== continuation || batch.signature !== signature || batch.state !== 'preparing') fail('STALE_PREPARE', 'The layout update changed; review it again.');
  } else {
    await fs.rm(root, {recursive: true, force: true});await fs.mkdir(root, {recursive: true});
    let currentKeys = {};try { currentKeys = JSON.parse(await fs.readFile(path.join(appHome, 'keys.json'), 'utf8')); } catch {}
    batch = {token: crypto.randomUUID(), signature, state: 'preparing', targets: keys.map(key => ({key, base: packages[key].commit})), results: [], currentKeys};
  }
  const key = keys[batch.results.length], record = packages[key], scope = prefix(record);
  const choices = Object.fromEntries(Object.entries(resolutions).filter(([file]) => file.startsWith(scope)).map(([file, choice]) => [file.slice(scope.length), choice]));
  const result = await prepare({appHome, source, record, update: record.lastResult.update, resolutions: choices, herdrApp, env, currentKeys: batch.currentKeys});
  let planSha = null;
  if (result.ok) {
    planSha = (await readPrepared(appHome, record)).digest;
    try { batch.currentKeys = JSON.parse(await fs.readFile(path.join(stageFor(appHome, record), 'keys.json'), 'utf8')); } catch {}
  }
  batch.results.push({key, record: {kind: record.kind, name: record.name}, result, planSha});
  const done = batch.results.length === keys.length;
  if (done) batch.state = batch.results.every(r => r.result.ok) ? 'ready' : 'conflict';
  await fs.writeFile(file, JSON.stringify(batch));
  if (!done) return {pending: true, continuation: batch.token, message: `Preparing layout update (${batch.results.length}/${keys.length})…`};
  const review = {subject: `Layout files and bundled mods for ${layout.name}`, time: Math.max(...keys.map(k => packages[k].lastResult.update.time || 0)), changed: [], removed: [], keptEdited: [], access: {hosts: [], programs: [], files: false}, keys: {add: [], remove: [], clash: []}};
  const conflicts = [], conflictDir = path.join(root, 'conflicts');
  for (const {record, result} of batch.results) {
    const scope = prefix(record), r = result.review;
    for (const field of ['changed', 'removed', 'keptEdited']) review[field].push(...(r[field] || []).map(file => scope + file));
    for (const field of ['hosts', 'programs']) review.access[field] = [...new Set([...review.access[field], ...(r.access?.[field] || [])])];
    review.access.files ||= Boolean(r.access?.files);
    for (const field of ['add', 'remove', 'clash']) review.keys[field].push(...(r.keys?.[field] || []));
    for (const c of result.conflicts || []) {
      const file = scope + c.file;conflicts.push({...c, file});
      if (!c.binary && result.conflictDir) {
        const target = path.join(conflictDir, file);await fs.mkdir(path.dirname(target), {recursive: true});
        await fs.copyFile(path.join(result.conflictDir, c.file), target);
      }
    }
  }
  return {ok: batch.state === 'ready', state: batch.state, review, conflicts, ...(conflicts.length ? {conflictDir} : {})};
}

export async function commitLayout({appHome, store, layout, packages, now}) {
  const root = bundleStage(appHome, layout);let batch;
  try { batch = JSON.parse(await fs.readFile(path.join(root, 'bundle.json'), 'utf8')); } catch { fail('NOT_PREPARED', 'Prepare the layout update first.'); }
  if (batch.state !== 'ready') fail('NOT_PREPARED', 'Resolve and review the layout update before applying it.');
  const records = batch.targets.map(t => {
    const r = packages[t.key];if (!r || r.commit !== t.base) fail('STALE_PREPARE', 'An item changed since this review; prepare the layout update again.');
    return r;
  });
  const result = await commitMany({appHome, store, records, now, label: `update layout bundle ${layout.name}`, expectedPlans: Object.fromEntries(batch.results.map(r => [r.key, r.planSha]))});
  await fs.rm(root, {recursive: true, force: true});return result;
}
