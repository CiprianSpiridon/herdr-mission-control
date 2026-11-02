export const CONFIG_VERSION = 1;
export const MAX_CONFIG_CHARACTERS = 180000;

export class ConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
  }
}

const fail = message => { throw new ConfigError('INVALID_CONFIG', message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const copy = value => JSON.parse(JSON.stringify(value));
const secretFields = new Set(['token', 'accesstoken', 'refreshtoken', 'apikey', 'password', 'secret', 'authorization']);
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);

function validateJson(value, depth = 0, envMap = false) {
  if (depth > 16) fail('Configuration nesting exceeds the supported limit.');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail('Configuration numbers must be finite.'); return; }
  if (typeof value !== 'object') fail('Configuration must contain JSON values only.');
  if (Array.isArray(value)) { for (const item of value) validateJson(item, depth + 1); return; }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail('Configuration objects must be plain JSON objects.');
  for (const [key, item] of Object.entries(value)) {
    if (forbiddenKeys.has(key)) fail('Configuration contains a reserved object key.');
    const compact = key.toLowerCase().replaceAll('_', '').replaceAll('-', '');
    if (!envMap && secretFields.has(compact)) fail('Store a credential environment reference, not a credential value.');
    if ((key.endsWith('Env') || envMap) && (typeof item !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(item))) fail('Credential environment references must be environment variable names.');
    validateJson(item, depth + 1, key === 'envRefs');
  }
}

function machine(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > 128 || /[\u0000-\u001f]/.test(value)) fail('Machine identity is invalid.');
  return value;
}

export function canonicalRepoPath(value) {
  if (typeof value !== 'string' || !value || /[\u0000-\u001f]/.test(value)) fail('A canonical absolute repository path is required.');
  let result = value.replaceAll('\\', '/');
  if (!result.startsWith('/') && !/^[A-Za-z]:\//.test(result)) fail('Relative repository paths cannot identify a binding.');
  if (result.split('/').some(part => part === '.' || part === '..')) fail('Repository paths must already be canonical.');
  result = result.replace(/\/+$/, '') || '/';
  if (/^[a-z]:\//.test(result)) result = result[0].toUpperCase() + result.slice(1);
  return result;
}

export function bindingKey(on, repoRoot) {
  return JSON.stringify([machine(on), canonicalRepoPath(repoRoot)]);
}

export function newConfig() {
  return { v: CONFIG_VERSION, revision: 0, connections: {}, bindings: {}, preferences: {}, usageSources: {} };
}

/** Shared native-safe grammar for persisted, model and transport selectors. */
export function gitlabProjectPath(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 255) fail('A GitLab project needs a valid namespace/project path.');
  const segments = value.split('/');
  if (segments.length > 21 || segments.some(segment => !/^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/.test(segment))) fail('A GitLab project needs a valid namespace/project path.');
  return value;
}

function validateGitlabSelection(value) {
  if (!Object.hasOwn(value, 'connectionId') || !Object.hasOwn(value, 'projectPath') || Object.keys(value).some(key => !['connectionId', 'projectPath', 'status'].includes(key))) fail('A GitLab binding needs its connection and project path.');
  gitlabProjectPath(value.projectPath);
  if (value.status === undefined) return;
  const status = value.status, groups = ['todo', 'inProgress', 'done'];
  if (!object(status) || Object.keys(status).length !== 1 || !Object.hasOwn(status, 'labels') || !object(status.labels) || Object.keys(status.labels).length !== groups.length || groups.some(group => !Object.hasOwn(status.labels, group))) fail('GitLab workflow mapping needs To do, In progress and Done label groups.');
  const used = new Set();
  for (const group of groups) {
    const labels = status.labels[group];
    if (!Array.isArray(labels) || labels.length > 100) fail('GitLab workflow label groups must be bounded lists.');
    for (const label of labels) {
      if (typeof label !== 'string' || !label.trim() || label.length > 200 || /[\u0000-\u001f\u007f]/.test(label) || used.has(label.toLowerCase())) fail('GitLab workflow labels must be valid and disjoint, ignoring case.');
      used.add(label.toLowerCase());
    }
  }
}

function validateBinding(binding, key, connections) {
  if (!object(binding)) fail('Repository bindings must be objects.');
  if (bindingKey(binding.machine, binding.repoRoot) !== key) fail('A repository binding does not match its machine/root key.');
  for (const source of ['jira', 'github', 'gitlab']) {
    if (binding[source] === undefined) continue;
    const selected = binding[source];
    if (!object(selected) || typeof selected.connectionId !== 'string' || !Object.hasOwn(connections, selected.connectionId)) fail('A tracker binding must reference an existing connection.');
    if (source === 'jira' && !selected.project && !selected.jql) fail('A Jira binding needs a project or JQL filter.');
    if (source === 'github' && (typeof selected.owner !== 'string' || !selected.owner || typeof selected.repo !== 'string' || !selected.repo)) fail('A GitHub binding needs its owner and repository.');
    if (source === 'gitlab') validateGitlabSelection(selected);
  }
  if (binding.mountedLocalPath !== undefined) canonicalRepoPath(binding.mountedLocalPath);
}

export function validateConfig(value) {
  if (!object(value)) fail('Configuration must be an object.');
  if (value.v !== CONFIG_VERSION) throw new ConfigError('UNSUPPORTED_VERSION', 'Unsupported configuration version; the original file has been preserved.');
  validateJson(value);
  const normalized = { ...newConfig(), ...copy(value) };
  if (!Number.isSafeInteger(normalized.revision) || normalized.revision < 0) fail('Configuration revision must be a non-negative safe integer.');
  for (const field of ['connections', 'bindings', 'preferences', 'usageSources']) if (!object(normalized[field])) fail(`Configuration ${field} must be an object.`);
  for (const [id, connection] of Object.entries(normalized.connections)) {
    if (!/^[a-z][a-z0-9-]{0,95}$/.test(id) || !object(connection) || connection.id !== id || typeof connection.kind !== 'string') fail('Connections require a matching stable id and adapter kind.');
    if (connection.site !== undefined && (typeof connection.site !== 'string' || !/^https:\/\/[^\s/@?#]+\/?$/.test(connection.site))) fail('A tracker site must be an HTTPS origin without credentials or query parameters.');
  }
  for (const [key, binding] of Object.entries(normalized.bindings)) validateBinding(binding, key, normalized.connections);
  if (JSON.stringify(normalized).length > MAX_CONFIG_CHARACTERS) fail('Configuration exceeds the supported file size.');
  return normalized;
}

export function configPath(io) {
  const app = typeof io.appHome === 'function' ? io.appHome() : io.appHome;
  if (typeof app !== 'string' || !app || /[\u0000-\u001f]/.test(app)) throw new ConfigError('CONFIG_PATH', 'The Herdr app home is unavailable.');
  return app.replace(/[/\\]+$/, '') + '/mission-control/config.json';
}

/** Build the local persistence capability from installed Herdr functions. No remote fallback. */
export function createConfigIO(herdr) {
  return {
    ...herdr,
    async ensureDirectory(directory) {
      const result = await herdr.exec('mkdir', ['-p', directory]);
      if (result.code !== 0) throw new ConfigError('CONFIG_DIRECTORY', 'Cannot create the private Mission Control settings directory.');
    },
  };
}

/** @returns {Promise<{value: object, raw: string|null, path: string}>} */
export async function readConfig(io) {
  const file = configPath(io);
  const raw = await io.readTextFile(file);
  if (raw === null) return { value: newConfig(), raw, path: file };
  if (typeof raw !== 'string' || raw.length > MAX_CONFIG_CHARACTERS) fail('Configuration exceeds the supported file size.');
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { throw new ConfigError('INVALID_JSON', 'Mission Control settings are not valid JSON; the original file has been preserved.'); }
  return { value: validateConfig(parsed), raw, path: file };
}

function conflict(error) {
  return ['STALE', 'CONFLICT', 'EAGAIN'].includes(error?.code) || /stale|snapshot|contents?.*changed|expected.*match|compare.and.set/i.test(error?.message ?? '');
}

/** Edit is synchronous and may be rerun against a fresher snapshot after CAS conflict. */
export async function updateConfig(io, edit, { attempts = 4 } = {}) {
  if (typeof edit !== 'function' || !Number.isInteger(attempts) || attempts < 1 || attempts > 8) throw new ConfigError('INVALID_EDIT', 'Settings need a synchronous edit and one to eight CAS attempts.');
  for (let attempt = 0; attempt < attempts; attempt++) {
    const snapshot = await readConfig(io);
    const draft = copy(snapshot.value);
    const returned = edit(draft);
    if (returned?.then) throw new ConfigError('INVALID_EDIT', 'Settings edits must be synchronous.');
    const next = validateConfig(returned === undefined ? draft : returned);
    if (next.revision !== snapshot.value.revision) throw new ConfigError('INVALID_EDIT', 'Settings edits cannot replace the CAS revision.');
    if (next.revision === Number.MAX_SAFE_INTEGER) throw new ConfigError('REVISION_LIMIT', 'Settings revision reached its supported limit; the original file has been preserved.');
    next.revision++;
    const text = JSON.stringify(next, null, 2) + '\n';
    if (text.length > MAX_CONFIG_CHARACTERS) fail('Configuration exceeds the supported file size.');
    await io.ensureDirectory?.(snapshot.path.slice(0, snapshot.path.lastIndexOf('/')));
    try {
      await io.writeTextFile(snapshot.path, text, snapshot.raw);
      return next;
    } catch (error) {
      if (!conflict(error)) throw error;
    }
  }
  throw new ConfigError('CONFLICT', 'Mission Control settings changed repeatedly; reload and retry. No stale update was applied.');
}

/** Only a canonical resolved repo can select a binding. Display names/folder fallbacks never do. */
export function resolveBinding(config, space) {
  if (!config || config.v !== CONFIG_VERSION || !space?.repoRoot || (space.state && space.state !== 'resolved')) return null;
  const key = bindingKey(space.machine, space.repoRoot);
  const selected = config.bindings?.[key];
  if (!selected || bindingKey(selected.machine, selected.repoRoot) !== key) return null;
  return copy(selected);
}

export function redactConfig(value) {
  if (Array.isArray(value)) return value.map(redactConfig);
  if (!object(value)) return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (forbiddenKeys.has(key)) continue;
    const compact = key.toLowerCase().replaceAll('_', '').replaceAll('-', '');
    output[key] = secretFields.has(compact) ? '[redacted]' : redactConfig(item);
  }
  return output;
}
