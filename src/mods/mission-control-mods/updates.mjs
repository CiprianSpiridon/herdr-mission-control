// New-version detection for adopted items (Node helper only).
// An update exists only when a commit touching the item's own subtree changed, added or removed one of its files;
// a commit elsewhere in the repository is not an update. Items whose catalog headCommit is unchanged cost nothing;
// items adopted from a pasted link are re-checked with git ls-remote.
import crypto from 'node:crypto';
import {GENERATED, subtree} from './inventory.mjs';

/**
 * The part of a repository's keys.json that belongs to one item: its own `mod:<name>` / `layout:<name>` section and,
 * for a mod, every action addressed to it (`<name>.<command>`). A repository with a single item owns the whole file,
 * so one item's key change is never another item's update and one item's update never adds another item's keys.
 */
export function itemKeys(snippet, {kind, name}, {single = false} = {}) {
  const out = {};
  if (!snippet || typeof snippet !== 'object' || Array.isArray(snippet)) return out;
  for (const [section, map] of Object.entries(snippet)) {
    if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
    const own = single || section === `${kind}:${name}`;
    for (const [key, action] of Object.entries(map)) {
      if (typeof action !== 'string') continue;
      if (own || kind === 'mod' && (action.startsWith(name + '.') || action.startsWith(name + ':'))) (out[section] ??= {})[key] = action;
    }
  }
  return out;
}
/** A stable digest of an item's keys (null when it has none). */
export function keysDigest(keys) {
  const flat = Object.entries(keys || {}).flatMap(([section, map]) => Object.entries(map).map(([key, action]) => `${section}\u0000${key}\u0000${action}`)).sort();
  return flat.length ? crypto.createHash('sha256').update(flat.join('\n')).digest('hex') : null;
}

/**
 * record: {kind, name, source:{url, fullName, path, defaultBranch}, commit, base:{file:sha}, headCommit?, remoteHead?, linked?}
 * Returns {state:'current'|'update'|'pending'|'too-large'|'unreachable', headCommit, remoteHead, update?, reason?}.
 */
export async function checkItem(source, catalogs, record) {
  const entry = record.linked ? null : findEntry(catalogs, record);
  let head = entry?.headCommit ?? null, remoteHead = record.remoteHead ?? null;
  if (record.linked) {
    remoteHead = await source.lsRemote(record.source.url, `refs/heads/${record.source.defaultBranch}`);
    if (!remoteHead) return {state: 'unreachable', reason: 'The linked repository could not be reached.', remoteHead: record.remoteHead ?? null};
    if (remoteHead === record.remoteHead && record.lastResult) return {...record.lastResult, remoteHead};
  } else if (head && head === record.headCommit && record.lastResult) {
    return {...record.lastResult, headCommit: head};
  }
  const ready = await source.ensure(record.source.url);
  if (ready.state !== 'ready') return {state: ready.state, reason: ready.reason, headCommit: record.headCommit ?? null, remoteHead: record.remoteHead ?? null};
  const scope = subtree({path: record.source.path}, {kind: record.kind, name: record.name});
  const keysPath = (record.source.path ? record.source.path + '/' : '') + 'keys.json';
  // A change to the item's keys.json snippet alone is an update too.
  const [newest] = await source.log(record.source.url, {ref: record.source.defaultBranch, paths: [...scope.paths, keysPath], max: 1});
  if (!newest || newest.commit === record.commit) return {state: 'current', headCommit: head, remoteHead};
  const files = Object.fromEntries((await source.tree(record.source.url, newest.commit, scope.paths))
    .filter(f => f.path.startsWith(scope.strip) && !GENERATED.test(f.path)).map(f => [f.path.slice(scope.strip.length), f.sha]));
  const single = !entry || (entry.names?.length ?? 1) <= 1;
  const keysAt = async commit => {
    const sha = (await source.tree(record.source.url, commit, [keysPath])).find(f => f.path === keysPath)?.sha ?? null;
    if (!sha) return {};
    try { return itemKeys(JSON.parse((await source.blob(record.source.url, sha)).toString('utf8')), record, {single}); } catch { return {}; }
  };
  const keys = await keysAt(newest.commit), digest = keysDigest(keys);
  // The baseline is what the item was adopted or last updated with; an item adopted before keys were recorded uses its commit's keys.
  const baseDigest = 'keysDigest' in record ? record.keysDigest : keysDigest(await keysAt(record.commit));
  const base = record.base || {};
  const added = Object.keys(files).filter(f => !(f in base)).sort();
  const removed = Object.keys(base).filter(f => !(f in files)).sort();
  const changed = Object.keys(files).filter(f => f in base && base[f] !== files[f]).sort();
  const keysChanged = digest !== baseDigest;
  if (!added.length && !removed.length && !changed.length && !keysChanged) return {state: 'current', headCommit: head, remoteHead};
  return {state: 'update', headCommit: head, remoteHead, update: {commit: newest.commit, time: newest.time, subject: newest.subject, files, keys, keysDigest: digest, keysChanged, added, changed, removed}};
}

export function findEntry(catalogs, record) {
  const pool = [...(catalogs.mods?.entries || []), ...(catalogs.layouts?.entries || [])];
  return pool.find(e => e.fullName === record.source?.fullName && e.path === record.source?.path) || null;
}
