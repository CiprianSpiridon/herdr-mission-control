// Crash-safe records for the Mods manager (Node helper only).
// - packages.json and other JSON records: temp file plus rename, under a lock file.
// - Changes to mods/, layouts/ or keys.json: an intent journal is written before the first change and every
//   original is backed up; a helper killed at any point leaves, after the next recover(), the complete old state
//   (or, once the journal is marked complete, the complete new state). Temp files never sit in a watched folder.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {recordsRoot} from './source.mjs';

export const LOCK_STALE_MS = 60000;
export class StoreError extends Error {
  constructor(code, message) { super(message); this.name = 'StoreError'; this.code = code; }
}
const fail = (code, message) => { throw new StoreError(code, message); };

export function createStore({appHome, now = () => Date.now(), staleMs = LOCK_STALE_MS, lockWaitMs = 8000} = {}) {
  if (typeof appHome !== 'string' || !path.isAbsolute(appHome)) fail('INVALID_APP_HOME', 'An absolute Herdr app home is required.');
  const root = recordsRoot(appHome), tmpDir = path.join(root, 'tmp');
  const files = {packages: path.join(root, 'packages.json'), journal: path.join(root, 'journal.json'), log: path.join(root, 'log.jsonl'), lock: path.join(root, 'lock.json')};

  const inside = target => {
    const resolved = path.resolve(target);
    if (resolved !== appHome && !resolved.startsWith(appHome + path.sep)) fail('OUTSIDE_APP_HOME', 'Refusing to touch a path outside the Herdr app home.');
    return resolved;
  };
  const tempName = () => path.join(tmpDir, `.${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`);

  /** Write bytes atomically: a temp file in the records folder, then rename onto the target (same volume). */
  async function writeAtomic(target, data) {
    inside(target);
    await fs.mkdir(tmpDir, {recursive: true});await fs.mkdir(path.dirname(target), {recursive: true});
    const tmp = tempName();
    await fs.writeFile(tmp, data);
    const handle = await fs.open(tmp, 'r');try { await handle.sync(); } finally { await handle.close(); }
    await fs.rename(tmp, target);
  }
  async function readJson(file, fallback) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; fail('INVALID_RECORD', `${path.basename(file)} is unreadable.`); } }
  const writeJson = (file, value) => writeAtomic(file, JSON.stringify(value, null, 2) + '\n');

  const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

  /** Run fn while holding the records lock; a lock older than the stale timeout or held by a dead process is reclaimed. */
  async function withLock(fn) {
    await fs.mkdir(root, {recursive: true});
    const deadline = Date.now() + lockWaitMs, token = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    for (;;) {
      try {
        const handle = await fs.open(files.lock, 'wx');
        try { await handle.writeFile(JSON.stringify({pid: process.pid, at: now(), token})); } finally { await handle.close(); }
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const held = await readJson(files.lock, null).catch(() => null);
        if (!held || now() - held.at > staleMs || !alive(held.pid)) { await fs.rm(files.lock, {force: true});continue; }
        if (Date.now() > deadline) fail('LOCKED', 'Another Mods manager operation is still running.');
        await new Promise(r => setTimeout(r, 40));
      }
    }
    try { return await fn(); } finally {
      const held = await readJson(files.lock, null).catch(() => null);
      if (held?.token === token) await fs.rm(files.lock, {force: true});
    }
  }

  const emptyPackages = () => ({v: 1, packages: {}});
  async function readPackages() { return readJson(files.packages, emptyPackages()); }
  /** Read-modify-write packages.json under the lock. */
  function updatePackages(mutate) {
    return withLock(async () => {
      const value = await readPackages();
      const next = (await mutate(value)) ?? value;
      await writeJson(files.packages, next);
      return next;
    });
  }

  async function log(entry) {
    await fs.mkdir(root, {recursive: true});
    await fs.appendFile(files.log, JSON.stringify({at: now(), ...entry}) + '\n');
  }

  /**
   * Apply file operations as one journalled change. ops: {type:'write', target, data} | {type:'delete', target}
   * | {type:'move', from, to}. Every original is backed up before the first change; on any failure, or after a
   * crash at the next recover(), everything is restored. Must be called while no other journal is open.
   */
  function commit(ops, {label = 'change', afterOp = null} = {}) {
    return withLock(async () => {
      if (fsSync.existsSync(files.journal)) await rollback(await readJson(files.journal, null));
      const id = `${now()}-${crypto.randomBytes(4).toString('hex')}`, backupDir = path.join(root, 'journal-backup', id);
      await fs.mkdir(backupDir, {recursive: true});await fs.mkdir(tmpDir, {recursive: true});
      const planned = [];
      for (const [index, op] of ops.entries()) {
        if (op.type === 'write') {
          inside(op.target);
          const staged = path.join(backupDir, `new-${index}`);await fs.writeFile(staged, op.data);
          planned.push({type: 'write', target: op.target, staged, ...(await snapshot(op.target, backupDir, index))});
        } else if (op.type === 'delete') {
          inside(op.target);planned.push({type: 'delete', target: op.target, ...(await snapshot(op.target, backupDir, index))});
        } else if (op.type === 'move') {
          inside(op.from);inside(op.to);
          if (fsSync.existsSync(op.to)) fail('TARGET_EXISTS', `${path.basename(op.to)} already exists.`);
          planned.push({type: 'move', from: op.from, to: op.to});
        } else fail('INVALID_REQUEST', 'Unknown file operation.');
      }
      const journal = {v: 1, id, label, state: 'applying', backupDir, ops: planned};
      await writeJson(files.journal, journal);
      try {
        for (const [index, op] of planned.entries()) {
          if (op.type === 'write') await writeAtomic(op.target, await fs.readFile(op.staged));
          else if (op.type === 'delete') await fs.rm(op.target, {recursive: true, force: true});
          else { await fs.mkdir(path.dirname(op.to), {recursive: true});await fs.rename(op.from, op.to); }
          if (afterOp) await afterOp(index);
        }
      } catch (error) {
        await rollback(journal);throw error;
      }
      await writeJson(files.journal, {...journal, state: 'complete'});
      await fs.rm(files.journal, {force: true});await fs.rm(backupDir, {recursive: true, force: true});
      await log({event: 'commit', label, ops: planned.length});
      return {id, ops: planned.length};
    });
  }

  async function snapshot(target, backupDir, index) {
    try {
      const info = await fs.lstat(target);
      if (info.isDirectory()) { const backup = path.join(backupDir, `old-${index}`);await fs.cp(target, backup, {recursive: true});return {backup, existed: 'dir'}; }
      const backup = path.join(backupDir, `old-${index}`);await fs.copyFile(target, backup);return {backup, existed: 'file'};
    } catch (error) { if (error.code === 'ENOENT') return {backup: null, existed: false}; throw error; }
  }

  /** Restore every original listed in a journal (idempotent); moves are undone if they happened. */
  async function rollback(journal) {
    if (!journal || !Array.isArray(journal.ops)) { await fs.rm(files.journal, {force: true});return; }
    for (const op of [...journal.ops].reverse()) {
      if (op.type === 'move') {
        if (!fsSync.existsSync(op.from) && fsSync.existsSync(op.to)) { await fs.mkdir(path.dirname(op.from), {recursive: true});await fs.rename(op.to, op.from); }
        continue;
      }
      if (op.existed === 'file') await writeAtomic(op.target, await fs.readFile(op.backup));
      else if (op.existed === 'dir') { await fs.rm(op.target, {recursive: true, force: true});await fs.cp(op.backup, op.target, {recursive: true}); }
      else await fs.rm(op.target, {recursive: true, force: true});
    }
    await fs.rm(files.journal, {force: true});
    if (journal.backupDir) await fs.rm(journal.backupDir, {recursive: true, force: true});
    await log({event: 'rollback', label: journal.label, ops: journal.ops.length});
  }

  /** Called first by every helper run: finish or undo a change a killed helper left behind. */
  function recover() {
    return withLock(async () => {
      const journal = await readJson(files.journal, null);
      if (!journal) { await fs.rm(tmpDir, {recursive: true, force: true});return {recovered: false}; }
      if (journal.state === 'complete') {
        await fs.rm(files.journal, {force: true});if (journal.backupDir) await fs.rm(journal.backupDir, {recursive: true, force: true});
        return {recovered: true, outcome: 'completed', label: journal.label};
      }
      await rollback(journal);await fs.rm(tmpDir, {recursive: true, force: true});
      return {recovered: true, outcome: 'rolled-back', label: journal.label};
    });
  }

  return {root, files, withLock, readPackages, updatePackages, writeAtomic, writeJson, readJson, commit, recover, log};
}
