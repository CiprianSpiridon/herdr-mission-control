// Updating an installed item (Node helper only), in two exec-sized phases:
//  prepare(): outside mods/, build the new version, merge local edits (git merge-file), mark conflicts (binary
//             edits included), compute the review and run herdr-app check on the staged copy;
//  commit():  back up, then apply the prepared change as one journalled store.commit (rolled back on any failure
//             or, after a crash, at the next helper start), and record the new commit.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {recordsRoot} from './source.mjs';
import {gitBlobSha, GENERATED} from './inventory.mjs';

export const BACKUPS_KEPT = 3;
export class ApplyError extends Error {
  constructor(code, message, detail) { super(message); this.name = 'ApplyError'; this.code = code; if (detail) this.detail = detail; }
}
const fail = (code, message, detail) => { throw new ApplyError(code, message, detail); };
const run = (file, args, opts = {}) => new Promise(resolve => execFile(file, args, {timeout: 20000, maxBuffer: 8 * 1024 * 1024, ...opts}, (error, stdout, stderr) =>
  resolve({code: error ? (error.killed ? 'TIMEOUT' : error.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '')})));

const isBinary = buffer => buffer.subarray(0, 8000).includes(0);
const installedDir = (appHome, record) => record.kind === 'mod' ? path.join(appHome, 'mods', record.name) : path.join(appHome, 'layouts');

/** What a file set can reach: network hosts, programs it runs, and whether it reads or writes outside its folder. */
export function disclose(texts) {
  const hosts = new Set(), programs = new Set();let files = false;
  for (const text of texts) {
    for (const m of text.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) hosts.add(m[1].toLowerCase());
    for (const m of text.matchAll(/\bexec(?:Sync|File)?\s*\(\s*['"`]([A-Za-z0-9_./-]{1,80})['"`]/g)) programs.add(m[1]);
    for (const m of text.matchAll(/\bspawn(?:Sync)?\s*\(\s*['"`]([A-Za-z0-9_./-]{1,80})['"`]/g)) programs.add(m[1]);
    if (/\b(readTextFile|writeTextFile|appHome\s*\(|homedir\s*\(|fs\.(read|write|rm|unlink|rename))/.test(text)) files = true;
  }
  return {hosts: [...hosts].sort(), programs: [...programs].sort(), files};
}
export function newAccess(before, after) {
  return {hosts: after.hosts.filter(h => !before.hosts.includes(h)), programs: after.programs.filter(p => !before.programs.includes(p)), files: after.files && !before.files};
}

/** Plan key changes from an item's keys.json snippet against the person's keys.json and the keys the item owns. */
export function planKeys(userKeys, snippet, owned = []) {
  const user = JSON.parse(JSON.stringify(userKeys || {})), add = [], clash = [], remove = [], keep = [];
  const want = [];
  for (const [section, map] of Object.entries(snippet || {})) for (const [key, action] of Object.entries(map || {})) if (typeof action === 'string') want.push({section, key, action});
  for (const w of want) {
    const current = user[w.section]?.[w.key];
    if (current === undefined) { add.push(w);(user[w.section] ??= {})[w.key] = w.action; }
    else if (current === w.action) keep.push(w);
    else if (owned.some(o => o.section === w.section && o.key === w.key && o.action === current)) { add.push(w);user[w.section][w.key] = w.action; }
    else clash.push({...w, current});
  }
  for (const o of owned) {
    if (want.some(w => w.section === o.section && w.key === o.key)) continue;
    if (user[o.section]?.[o.key] === o.action) { remove.push(o);delete user[o.section][o.key];if (!Object.keys(user[o.section]).length) delete user[o.section]; }
  }
  const nowOwned = [...owned.filter(o => !remove.some(r => r.section === o.section && r.key === o.key) && !add.some(a => a.section === o.section && a.key === o.key)), ...add];
  return {add, clash, remove, keep, keys: user, owned: nowOwned, changed: add.length > 0 || remove.length > 0};
}

/**
 * Phase 1. record: adopted record (kind, name, source, commit, base, keys). update: from checkItem (commit, files).
 * resolutions: {relativePath: 'mine'|'theirs'} for previously reported conflicts.
 * Returns {ok, conflicts, review, plan} and writes the plan to the stage folder; nothing under mods/ changes.
 */
export async function prepare({appHome, source, record, update, resolutions = {}, herdrApp = 'herdr-app', env = process.env, currentKeys}) {
  const records = recordsRoot(appHome), stageRoot = path.join(records, 'stage', `${record.kind}-${record.name}`);
  const base = record.base || {}, upstream = update.files || {}, dir = installedDir(appHome, record);
  const localFiles = record.kind === 'mod' ? await listFiles(dir) : Object.keys(base).concat(Object.keys(upstream)).filter((v, i, a) => a.indexOf(v) === i);
  const local = {};
  for (const rel of localFiles) { try { local[rel] = await fs.readFile(path.join(dir, rel)); } catch {} }
  const localSha = Object.fromEntries(Object.entries(local).map(([rel, data]) => [rel, gitBlobSha(data)]));
  const blob = sha => source.blob(record.source.url, sha);
  const writes = {}, deletes = [], conflicts = [], keptEdited = [];
  await fs.rm(stageRoot, {recursive: true, force: true});await fs.mkdir(stageRoot, {recursive: true});
  for (const rel of [...new Set([...Object.keys(upstream), ...Object.keys(base)])].sort()) {
    if (GENERATED.test(rel)) continue;
    const b = base[rel], u = upstream[rel], l = localSha[rel];
    if (u && l === u) continue;                                   // already the new version
    if (!u) {                                                     // removed upstream
      if (l === undefined) continue;
      if (l === b) deletes.push(rel); else keptEdited.push(rel);
      continue;
    }
    if (l === undefined || l === b) { writes[rel] = await blob(u);continue; }  // unedited or new: take upstream
    if (u === b) continue;                                        // only the person changed it
    const choice = resolutions[rel];
    if (choice === 'mine') continue;
    if (choice === 'theirs') { writes[rel] = await blob(u);continue; }
    const theirs = await blob(u), baseData = b ? await blob(b) : Buffer.alloc(0);
    if (isBinary(local[rel]) || isBinary(theirs) || isBinary(baseData)) { conflicts.push({file: rel, binary: true});continue; }
    const merged = await merge(stageRoot, rel, local[rel], baseData, theirs);
    if (merged.conflict) conflicts.push({file: rel, binary: false, merged: merged.path}); else writes[rel] = merged.data;
  }
  // Keys: the item's keys.json snippet in its source folder, if any.
  let keys = null;
  if (Object.keys(update.keys || {}).length || record.keys?.length) {
    // Only this item's own keys (checkItem): its section and the actions addressed to it.
    const snippet = update.keys || {};
    let userKeys = currentKeys;
    if (userKeys === undefined) { userKeys = {};try { userKeys = JSON.parse(await fs.readFile(path.join(appHome, 'keys.json'), 'utf8')); } catch {} }
    keys = planKeys(userKeys, snippet, record.keys || []);
  }
  const before = disclose(Object.values(local).filter(d => !isBinary(d)).map(d => d.toString('utf8')));
  const afterTexts = {...Object.fromEntries(Object.entries(local).map(([rel, d]) => [rel, d])), ...writes};
  for (const rel of deletes) delete afterTexts[rel];
  const after = disclose(Object.values(afterTexts).filter(d => !isBinary(d)).map(d => d.toString('utf8')));
  const review = {commit: update.commit, subject: update.subject, time: update.time, changed: Object.keys(writes).sort(), removed: deletes.sort(), keptEdited, conflicts,
    access: newAccess(before, after), keys: keys ? {add: keys.add, remove: keys.remove, clash: keys.clash} : null};
  if (conflicts.length) {
    const conflictDir = path.join(records, 'conflicts', `${record.kind}-${record.name}`);
    await fs.rm(conflictDir, {recursive: true, force: true});
    for (const c of conflicts.filter(c => c.merged)) { await fs.mkdir(path.dirname(path.join(conflictDir, c.file)), {recursive: true});await fs.copyFile(c.merged, path.join(conflictDir, c.file)); }
    return {ok: false, state: 'conflict', conflicts: conflicts.map(c => ({file: c.file, binary: c.binary})), conflictDir, review};
  }
  // Stage the complete new folder under the same name and check it before anything is written.
  if (record.kind === 'mod') {
    const staged = path.join(stageRoot, record.name);
    await fs.mkdir(staged, {recursive: true});
    for (const [rel, data] of Object.entries(local)) if (!deletes.includes(rel)) { await fs.mkdir(path.dirname(path.join(staged, rel)), {recursive: true});await fs.writeFile(path.join(staged, rel), data); }
    for (const [rel, data] of Object.entries(writes)) { await fs.mkdir(path.dirname(path.join(staged, rel)), {recursive: true});await fs.writeFile(path.join(staged, rel), data); }
    const check = await run(herdrApp, ['check', staged], {env});
    if (check.code !== 0) fail('CHECK_FAILED', `herdr-app check refused the new version: ${(check.stderr || check.stdout).trim().slice(0, 600)}`);
  } else {
    for (const [rel, data] of Object.entries(writes)) if (rel.endsWith('.json')) { try { JSON.parse(data.toString('utf8')); } catch { fail('CHECK_FAILED', `${rel} is not valid JSON.`); } }
  }
  const plan = {v: 1, kind: record.kind, name: record.name, commit: update.commit, files: upstream, keysDigest: update.keysDigest ?? null, writes: Object.keys(writes), deletes, keys: keys ? {changed: keys.changed, owned: keys.owned} : null};
  await fs.mkdir(path.join(stageRoot, 'files'), {recursive: true});
  for (const [rel, data] of Object.entries(writes)) { await fs.mkdir(path.dirname(path.join(stageRoot, 'files', rel)), {recursive: true});await fs.writeFile(path.join(stageRoot, 'files', rel), data); }
  if (keys?.changed) await fs.writeFile(path.join(stageRoot, 'keys.json'), JSON.stringify(keys.keys, null, 2) + '\n');
  await fs.writeFile(path.join(stageRoot, 'plan.json'), JSON.stringify(plan));
  return {ok: true, state: 'ready', review};
}

/** Phase 2: back up and apply a prepared change as one journalled commit; then record the new commit. */
export async function commit({appHome, store, record, now = () => Date.now()}) {
  return commitMany({appHome, store, records: [record], now, label: `update ${record.kind}:${record.name}`});
}

/** Read exactly the staged bytes being reviewed, including merged files and composed keys. */
export async function readPrepared(appHome, record) {
  const stageRoot = path.join(recordsRoot(appHome), 'stage', `${record.kind}-${record.name}`);
  let bytes;try { bytes = await fs.readFile(path.join(stageRoot, 'plan.json')); } catch { fail('NOT_PREPARED', 'Prepare the update first.'); }
  const plan = JSON.parse(bytes.toString('utf8')), writes = new Map(), hash = crypto.createHash('sha256').update(bytes);
  if (plan.kind !== record.kind || plan.name !== record.name) fail('STALE_PREPARE', 'The prepared update does not match this item.');
  for (const rel of plan.writes) {
    const data = await fs.readFile(path.join(stageRoot, 'files', rel));writes.set(rel, data);hash.update('\0' + rel + '\0').update(data);
  }
  const keysData = plan.keys?.changed ? await fs.readFile(path.join(stageRoot, 'keys.json')) : null;
  if (keysData) hash.update('\0keys\0').update(keysData);
  return {stageRoot, plan, writes, keysData, digest: hash.digest('hex')};
}

/** A layout and its bundled mods apply in one journal, with the last composed keys file written once. */
export async function commitMany({appHome, store, records, now = () => Date.now(), label = 'update layout bundle', expectedPlans = {}}) {
  const stages = [], ops = [];let keysData = null, written = 0, deleted = 0;
  for (const record of records) {
    const key = `${record.kind}:${record.name}`, staged = await readPrepared(appHome, record), {stageRoot, plan} = staged, dir = installedDir(appHome, record);
    if (expectedPlans[key] && staged.digest !== expectedPlans[key]) fail('STALE_PREPARE', 'The prepared update changed; review it again.');
    for (const [rel, data] of staged.writes) ops.push({type: 'write', target: path.join(dir, rel), data});
    for (const rel of plan.deletes) ops.push({type: 'delete', target: path.join(dir, rel)});
    if (staged.keysData) keysData = staged.keysData;
    written += plan.writes.length;deleted += plan.deletes.length;stages.push({record, key, plan, stageRoot});
  }
  for (const {record} of stages) await backup(appHome, record, now);
  if (keysData) ops.push({type: 'write', target: path.join(appHome, 'keys.json'), data: keysData});
  await store.commit(ops, {label});
  await store.updatePackages(value => {
    for (const {key, record, plan} of stages) {
      const current = value.packages[key] || record;
      value.packages[key] = {...current, commit: plan.commit, base: plan.files, keysDigest: plan.keysDigest ?? null, keys: plan.keys ? plan.keys.owned : current.keys, state: 'current', lastResult: null, updatedAt: now()};
    }
  });
  for (const {stageRoot} of stages) await fs.rm(stageRoot, {recursive: true, force: true});
  return {ok: true, commit: stages.at(-1)?.plan.commit, written, deleted};
}

/** Copy the installed item to backup/<kind>-<name>/<time>/ and keep the newest three. */
async function backup(appHome, record, now) {
  const root = path.join(recordsRoot(appHome), 'backup', `${record.kind}-${record.name}`), target = path.join(root, String(now()));
  await fs.mkdir(target, {recursive: true});
  if (record.kind === 'mod') await fs.cp(installedDir(appHome, record), target, {recursive: true});
  else for (const ext of ['.json', '.svg']) { try { await fs.copyFile(path.join(appHome, 'layouts', record.name + ext), path.join(target, record.name + ext)); } catch {} }
  try { await fs.copyFile(path.join(appHome, 'keys.json'), path.join(target, '.keys.json')); } catch {}
  const all = (await fs.readdir(root)).sort((a, b) => Number(b) - Number(a));
  for (const old of all.slice(BACKUPS_KEPT)) await fs.rm(path.join(root, old), {recursive: true, force: true});
}

async function listFiles(dir) {
  const out = [];
  async function walk(current, rel) {
    let entries;try { entries = await fs.readdir(current, {withFileTypes: true}); } catch { return; }
    for (const e of entries) { const r = rel ? `${rel}/${e.name}` : e.name;if (e.isSymbolicLink()) continue;if (e.isDirectory()) await walk(path.join(current, e.name), r);else if (e.isFile() && !GENERATED.test(r)) out.push(r); }
  }
  await walk(dir, '');return out.sort();
}

async function merge(stageRoot, rel, mine, base, theirs) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-mods-merge-'));
  try {
    const [m, b, t] = ['mine', 'base', 'theirs'].map(n => path.join(dir, n));
    await fs.writeFile(m, mine);await fs.writeFile(b, base);await fs.writeFile(t, theirs);
    const r = await run('git', ['merge-file', '-p', '-L', 'yours', '-L', 'installed', '-L', 'upstream', m, b, t], {encoding: 'buffer'});
    const data = Buffer.from(r.stdout);
    if (r.code === 0) return {conflict: false, data};
    if (typeof r.code === 'number' && r.code > 0 && r.code < 128) {
      const out = path.join(stageRoot, 'merged', rel);await fs.mkdir(path.dirname(out), {recursive: true});
      const full = await new Promise(resolve => execFile('git', ['merge-file', '-p', '-L', 'yours', '-L', 'installed', '-L', 'upstream', m, b, t], {encoding: 'buffer', maxBuffer: 8 * 1024 * 1024}, (_e, stdout) => resolve(stdout)));
      await fs.writeFile(out, full);return {conflict: true, path: out};
    }
    fail('MERGE_FAILED', `Merging ${rel} failed.`);
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
}
