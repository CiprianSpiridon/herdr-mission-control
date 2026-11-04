// New-version detection for adopted items (Node helper only).
// An update exists only when a commit touching the item's own subtree changed, added or removed one of its files;
// a commit elsewhere in the repository is not an update. Items whose catalog headCommit is unchanged cost nothing;
// items adopted from a pasted link are re-checked with git ls-remote.
import {GENERATED, subtree} from './inventory.mjs';

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
  const keysSha = (await source.tree(record.source.url, newest.commit, [keysPath])).find(f => f.path === keysPath)?.sha ?? null;
  const base = record.base || {};
  const added = Object.keys(files).filter(f => !(f in base)).sort();
  const removed = Object.keys(base).filter(f => !(f in files)).sort();
  const changed = Object.keys(files).filter(f => f in base && base[f] !== files[f]).sort();
  const keysChanged = keysSha !== (record.keysSha ?? null);
  if (!added.length && !removed.length && !changed.length && !keysChanged) return {state: 'current', headCommit: head, remoteHead};
  return {state: 'update', headCommit: head, remoteHead, update: {commit: newest.commit, time: newest.time, subject: newest.subject, files, keysSha, keysChanged, added, changed, removed}};
}

export function findEntry(catalogs, record) {
  const pool = [...(catalogs.mods?.entries || []), ...(catalogs.layouts?.entries || [])];
  return pool.find(e => e.fullName === record.source?.fullName && e.path === record.source?.path) || null;
}
