// src/mods/mission-control-sessions/main.js
import { View, div as div2 } from "gpui-kit";
import { v_flex as v_flex2, h_flex as h_flex2 } from "gpui-base";
import * as herdr2 from "herdr";

// src/shared/telemetry.js
import * as herdr from "herdr";

// src/shared/config.js
var CONFIG_VERSION = 1;
var MAX_CONFIG_CHARACTERS = 18e4;
var ConfigError = class extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
  }
};
var fail = (message) => {
  throw new ConfigError("INVALID_CONFIG", message);
};
var object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
var copy = (value) => JSON.parse(JSON.stringify(value));
var secretFields = /* @__PURE__ */ new Set(["token", "accesstoken", "refreshtoken", "apikey", "password", "secret", "authorization"]);
var forbiddenKeys = /* @__PURE__ */ new Set(["__proto__", "prototype", "constructor"]);
function validateJson(value, depth = 0, envMap = false) {
  if (depth > 16) fail("Configuration nesting exceeds the supported limit.");
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("Configuration numbers must be finite.");
    return;
  }
  if (typeof value !== "object") fail("Configuration must contain JSON values only.");
  if (Array.isArray(value)) {
    for (const item of value) validateJson(item, depth + 1);
    return;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail("Configuration objects must be plain JSON objects.");
  for (const [key3, item] of Object.entries(value)) {
    if (forbiddenKeys.has(key3)) fail("Configuration contains a reserved object key.");
    const compact = key3.toLowerCase().replaceAll("_", "").replaceAll("-", "");
    if (!envMap && secretFields.has(compact)) fail("Store a credential environment reference, not a credential value.");
    if ((key3.endsWith("Env") || envMap) && (typeof item !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(item))) fail("Credential environment references must be environment variable names.");
    validateJson(item, depth + 1, key3 === "envRefs");
  }
}
function machine(value) {
  if (value === null || value === void 0) return null;
  if (typeof value !== "string" || !value.trim() || value.length > 128 || /[\u0000-\u001f]/.test(value)) fail("Machine identity is invalid.");
  return value;
}
function canonicalRepoPath(value) {
  if (typeof value !== "string" || !value || /[\u0000-\u001f]/.test(value)) fail("A canonical absolute repository path is required.");
  let result = value.replaceAll("\\", "/");
  if (!result.startsWith("/") && !/^[A-Za-z]:\//.test(result)) fail("Relative repository paths cannot identify a binding.");
  if (result.split("/").some((part) => part === "." || part === "..")) fail("Repository paths must already be canonical.");
  result = result.replace(/\/+$/, "") || "/";
  if (/^[a-z]:\//.test(result)) result = result[0].toUpperCase() + result.slice(1);
  return result;
}
function bindingKey(on, repoRoot) {
  return JSON.stringify([machine(on), canonicalRepoPath(repoRoot)]);
}
function newConfig() {
  return { v: CONFIG_VERSION, revision: 0, connections: {}, bindings: {}, preferences: {}, usageSources: {} };
}
function gitlabProjectPath(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 255) fail("A GitLab project needs a valid namespace/project path.");
  const segments = value.split("/");
  if (segments.length > 21 || segments.some((segment) => !/^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/.test(segment))) fail("A GitLab project needs a valid namespace/project path.");
  return value;
}
function validateGitlabSelection(value) {
  if (!Object.hasOwn(value, "connectionId") || !Object.hasOwn(value, "projectPath") || Object.keys(value).some((key3) => !["connectionId", "projectPath", "status"].includes(key3))) fail("A GitLab binding needs its connection and project path.");
  gitlabProjectPath(value.projectPath);
  if (value.status === void 0) return;
  const status = value.status, groups = ["todo", "inProgress", "done"];
  if (!object(status) || Object.keys(status).length !== 1 || !Object.hasOwn(status, "labels") || !object(status.labels) || Object.keys(status.labels).length !== groups.length || groups.some((group) => !Object.hasOwn(status.labels, group))) fail("GitLab workflow mapping needs To do, In progress and Done label groups.");
  const used = /* @__PURE__ */ new Set();
  for (const group of groups) {
    const labels = status.labels[group];
    if (!Array.isArray(labels) || labels.length > 100) fail("GitLab workflow label groups must be bounded lists.");
    for (const label2 of labels) {
      if (typeof label2 !== "string" || !label2.trim() || label2.length > 200 || /[\u0000-\u001f\u007f]/.test(label2) || used.has(label2.toLowerCase())) fail("GitLab workflow labels must be valid and disjoint, ignoring case.");
      used.add(label2.toLowerCase());
    }
  }
}
function validateBinding(binding, key3, connections) {
  if (!object(binding)) fail("Repository bindings must be objects.");
  if (bindingKey(binding.machine, binding.repoRoot) !== key3) fail("A repository binding does not match its machine/root key.");
  for (const source of ["jira", "github", "gitlab"]) {
    if (binding[source] === void 0) continue;
    const selected = binding[source];
    if (!object(selected) || typeof selected.connectionId !== "string" || !Object.hasOwn(connections, selected.connectionId)) fail("A tracker binding must reference an existing connection.");
    if (source === "jira" && !selected.project && !selected.jql) fail("A Jira binding needs a project or JQL filter.");
    if (source === "github" && (typeof selected.owner !== "string" || !selected.owner || typeof selected.repo !== "string" || !selected.repo)) fail("A GitHub binding needs its owner and repository.");
    if (source === "gitlab") validateGitlabSelection(selected);
  }
  if (binding.mountedLocalPath !== void 0) canonicalRepoPath(binding.mountedLocalPath);
}
function validateConfig(value) {
  if (!object(value)) fail("Configuration must be an object.");
  if (value.v !== CONFIG_VERSION) throw new ConfigError("UNSUPPORTED_VERSION", "Unsupported configuration version; the original file has been preserved.");
  validateJson(value);
  const normalized = { ...newConfig(), ...copy(value) };
  if (!Number.isSafeInteger(normalized.revision) || normalized.revision < 0) fail("Configuration revision must be a non-negative safe integer.");
  for (const field of ["connections", "bindings", "preferences", "usageSources"]) if (!object(normalized[field])) fail(`Configuration ${field} must be an object.`);
  for (const [id, connection] of Object.entries(normalized.connections)) {
    if (!/^[a-z][a-z0-9-]{0,95}$/.test(id) || !object(connection) || connection.id !== id || typeof connection.kind !== "string") fail("Connections require a matching stable id and adapter kind.");
    if (connection.site !== void 0 && (typeof connection.site !== "string" || !/^https:\/\/[^\s/@?#]+\/?$/.test(connection.site))) fail("A tracker site must be an HTTPS origin without credentials or query parameters.");
  }
  for (const [key3, binding] of Object.entries(normalized.bindings)) validateBinding(binding, key3, normalized.connections);
  if (JSON.stringify(normalized).length > MAX_CONFIG_CHARACTERS) fail("Configuration exceeds the supported file size.");
  return normalized;
}
function configPath(io) {
  const app = typeof io.appHome === "function" ? io.appHome() : io.appHome;
  if (typeof app !== "string" || !app || /[\u0000-\u001f]/.test(app)) throw new ConfigError("CONFIG_PATH", "The Herdr app home is unavailable.");
  return app.replace(/[/\\]+$/, "") + "/mission-control/config.json";
}
function createConfigIO(herdr3) {
  return {
    ...herdr3,
    async ensureDirectory(directory) {
      const result = await herdr3.exec("mkdir", ["-p", directory]);
      if (result.code !== 0) throw new ConfigError("CONFIG_DIRECTORY", "Cannot create the private Mission Control settings directory.");
    }
  };
}
async function readConfig(io) {
  const file = configPath(io);
  const raw = await io.readTextFile(file);
  if (raw === null) return { value: newConfig(), raw, path: file };
  if (typeof raw !== "string" || raw.length > MAX_CONFIG_CHARACTERS) fail("Configuration exceeds the supported file size.");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError("INVALID_JSON", "Mission Control settings are not valid JSON; the original file has been preserved.");
  }
  return { value: validateConfig(parsed), raw, path: file };
}
function conflict(error2) {
  return ["STALE", "CONFLICT", "EAGAIN"].includes(error2?.code) || /stale|snapshot|contents?.*changed|expected.*match|compare.and.set/i.test(error2?.message ?? "");
}
async function updateConfig(io, edit, { attempts: attempts2 = 4 } = {}) {
  if (typeof edit !== "function" || !Number.isInteger(attempts2) || attempts2 < 1 || attempts2 > 8) throw new ConfigError("INVALID_EDIT", "Settings need a synchronous edit and one to eight CAS attempts.");
  for (let attempt = 0; attempt < attempts2; attempt++) {
    const snapshot = await readConfig(io);
    const draft = copy(snapshot.value);
    const returned = edit(draft);
    if (returned?.then) throw new ConfigError("INVALID_EDIT", "Settings edits must be synchronous.");
    const next = validateConfig(returned === void 0 ? draft : returned);
    if (next.revision !== snapshot.value.revision) throw new ConfigError("INVALID_EDIT", "Settings edits cannot replace the CAS revision.");
    if (next.revision === Number.MAX_SAFE_INTEGER) throw new ConfigError("REVISION_LIMIT", "Settings revision reached its supported limit; the original file has been preserved.");
    next.revision++;
    const text9 = JSON.stringify(next, null, 2) + "\n";
    if (text9.length > MAX_CONFIG_CHARACTERS) fail("Configuration exceeds the supported file size.");
    await io.ensureDirectory?.(snapshot.path.slice(0, snapshot.path.lastIndexOf("/")));
    try {
      await io.writeTextFile(snapshot.path, text9, snapshot.raw);
      return next;
    } catch (error2) {
      if (!conflict(error2)) throw error2;
    }
  }
  throw new ConfigError("CONFLICT", "Mission Control settings changed repeatedly; reload and retry. No stale update was applied.");
}

// src/shared/session-identity.js
var IdentityError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
};
var fail2 = (message) => {
  throw new IdentityError("INVALID_IDENTITY", message);
};
var text = (v, label2, max = 2048) => {
  if (typeof v !== "string" || !v || v.length > max || /[\u0000-\u001f]/.test(v)) fail2(`Invalid ${label2}`);
  return v;
};
function machineIdentity(value) {
  return value == null ? null : text(value, "machine", 128);
}
function sessionIdentity(value) {
  if (!value || typeof value !== "object") fail2("Missing provider session identity");
  return { machine: machineIdentity(value.machine), provider: text(value.provider, "provider", 128), credentialScope: text(value.credentialScope, "credential scope", 256), providerRoot: canonicalRepoPath(value.providerRoot), sessionId: text(value.sessionId, "session ID", 256) };
}
var sessionKey = (value) => {
  const s = sessionIdentity(value);
  return JSON.stringify([s.machine, s.provider, s.credentialScope, s.providerRoot, s.sessionId]);
};
function localTerminalAddress(address, on) {
  text(address, "terminal address", 256);
  const machine2 = machineIdentity(on);
  const local = machine2 && address.startsWith(machine2 + "/") ? address.slice(machine2.length + 1) : address;
  if (!/^t[0-9a-z]+$/.test(local)) fail2("Terminal address does not belong to the requested host");
  return local;
}
function terminalIdentity(raw, on = null) {
  if (!raw || !Number.isSafeInteger(raw.created_ms) || raw.created_ms < 0) fail2("Full raw terminal created_ms is required");
  const machine2 = machineIdentity(on), local = localTerminalAddress(raw.address, machine2);
  const pid = raw.foreground?.pid ?? null;
  if (pid !== null && (!Number.isSafeInteger(pid) || pid <= 0)) fail2("Invalid foreground PID");
  return { machine: machine2, address: machine2 ? machine2 + "/" + local : local, createdMs: raw.created_ms, foregroundPid: pid };
}
function terminalKey(identity) {
  if (!identity || !Number.isSafeInteger(identity.createdMs) || identity.createdMs < 0) fail2("Missing terminal generation");
  const on = machineIdentity(identity.machine), local = localTerminalAddress(identity.address, on), pid = identity.foregroundPid ?? null;
  if (pid !== null && (!Number.isSafeInteger(pid) || pid <= 0)) fail2("Invalid foreground PID");
  return JSON.stringify([on, local, identity.createdMs, pid]);
}
var sequence = 0;
function newIntent({ requestId, originId } = {}) {
  const mint = () => `mc-${Date.now().toString(36)}-${(++sequence).toString(36)}-${Array.from({ length: 4 }, () => Math.floor(Math.random() * 4294967296).toString(16).padStart(8, "0")).join("")}`;
  const id = text(requestId ?? mint(), "request ID", 256);
  return { requestId: id, idempotencyKey: id, originId: text(originId ?? mint(), "origin ID", 256) };
}

// src/shared/session-bindings.js
var clone = (v) => JSON.parse(JSON.stringify(v));
var fail3 = (code, message) => {
  throw new ConfigError(code, message);
};
var text2 = (v, label2, max = 256) => {
  if (typeof v !== "string" || !v || v.length > max || ["__proto__", "prototype", "constructor"].includes(v) || /[\u0000-\u001f]/.test(v)) fail3("INVALID_BINDING", `Invalid ${label2}`);
  return v;
};
var time = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
var bytes = (value) => {
  let n = 0;
  for (const c of value) {
    const p = c.codePointAt(0);
    n += p < 128 ? 1 : p < 2048 ? 2 : p < 65536 ? 3 : 4;
  }
  return n;
};
var empty = () => ({ v: 1, revision: 0, proposals: {}, terminals: {} });
var proofKinds = /* @__PURE__ */ new Set(["caller-session-id", "resume-argv", "pid-open-file", "provider-handshake"]);
var conflict2 = (e) => ["STALE", "CONFLICT", "EAGAIN"].includes(e?.code) || /stale|contents?.*changed|expected.*match|compare.and.set/i.test(e?.message || "");
function validateAck(ack) {
  text2(ack?.tabId, "acknowledged tab ID");
  terminalKey(ack?.terminal);
  return clone(ack);
}
function validateProof(proof, session2, terminal) {
  if (!proof || !proofKinds.has(proof.kind) || !time(proof.observedAt) || typeof proof.sourceDigest !== "string" || !proof.sourceDigest || proof.sourceDigest.length > 512) fail3("UNPROVEN_SESSION", "Exact provider-session evidence is required");
  if (!proof.session || sessionKey(proof.session) !== sessionKey(session2) || terminalKey(proof.terminal) !== terminalKey(terminal) || session2.machine !== terminal.machine) fail3("UNPROVEN_SESSION", "Session proof does not match the exact host/session/terminal generation");
  return clone(proof);
}
function indexes(d) {
  const result = {};
  for (const [id, r] of Object.entries(d.proposals)) if (r.state === "committed") {
    const key3 = terminalKey(r.ack.terminal);
    if (result[key3]) fail3("BINDING_CONFLICT", "A terminal generation cannot belong to two work origins");
    result[key3] = id;
  }
  d.terminals = result;
  return d;
}
function validateBindingStore(value) {
  if (!value || value.v !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 || !value.proposals || !value.terminals || Array.isArray(value.proposals) || Array.isArray(value.terminals)) fail3("INVALID_BINDING", "Invalid binding store; original preserved");
  const d = clone(value);
  for (const [id, r] of Object.entries(d.proposals)) {
    text2(id, "request ID");
    text2(r.originId, "origin ID");
    if (!["proposed", "commit-pending", "committed", "invalidated"].includes(r.state) || !time(r.createdAt) || !time(r.updatedAt) || r.updatedAt < r.createdAt) fail3("INVALID_BINDING", "Invalid binding state/timestamps");
    if (r.session !== null) r.session = sessionIdentity(r.session);
    if (r.state === "proposed" || r.state === "commit-pending") {
      if (!time(r.expiresAt) || r.expiresAt < r.createdAt || r.invalidatedAt !== null) fail3("INVALID_BINDING", "Uncommitted proposal needs its own TTL");
    } else if (r.expiresAt !== null) fail3("INVALID_BINDING", "Committed/invalidated records do not expire by age");
    if (r.state === "invalidated") {
      if (!time(r.invalidatedAt) || r.invalidatedAt < r.createdAt || r.invalidatedAt > r.updatedAt) fail3("INVALID_BINDING", "Invalid first-invalidation timestamp");
    } else if (r.invalidatedAt !== null) fail3("INVALID_BINDING", "Unexpected invalidation timestamp");
    if (r.state === "committed" || r.state === "commit-pending") {
      validateAck(r.ack);
      if (r.session) validateProof(r.proof, r.session, r.ack.terminal);
    } else if (r.ack) validateAck(r.ack);
  }
  const expected = indexes(clone(d)).terminals;
  if (Object.keys(expected).length !== Object.keys(d.terminals).length || Object.entries(expected).some(([k, id]) => d.terminals[k] !== id)) fail3("INVALID_BINDING", "Terminal index does not match retained committed records");
  return d;
}
function pruneBindings(draft, now3, { recoveryRecorded = [] } = {}) {
  const recovered = new Set(recoveryRecorded);
  for (const [id, r] of Object.entries(draft.proposals)) if (["proposed", "commit-pending"].includes(r.state) && r.expiresAt <= now3 && recovered.has(id)) delete draft.proposals[id];
  const invalid = Object.entries(draft.proposals).filter(([, r]) => r.state === "invalidated").sort(([a, x], [b, y]) => x.invalidatedAt - y.invalidatedAt || (a < b ? -1 : a > b ? 1 : 0));
  for (const [id] of invalid.slice(0, Math.max(0, invalid.length - 100))) delete draft.proposals[id];
  return indexes(draft);
}
function capacity(d) {
  if (Object.keys(d.proposals).length > 500 || bytes(JSON.stringify(d)) > 768 * 1024) fail3("BINDING_CAPACITY", "Session binding storage is full. Reconcile closed terminals or archive recovered requests; active mappings were preserved.");
}
function argvSessionProof({ capabilities, session: session2, terminal, argv, kind, observedAt, sourceDigest }) {
  const s = sessionIdentity(session2);
  terminalKey(terminal);
  if (capabilities?.machine !== s.machine || capabilities.provider !== s.provider || !Array.isArray(argv) || !Array.isArray(capabilities.run) || !capabilities.run.every((v, i) => argv[i] === v)) fail3("UNPROVEN_SESSION", "Launch command/provider/host does not match session evidence");
  let marker;
  if (kind === "caller-session-id") marker = capabilities.callerSession;
  else if (kind === "resume-argv") marker = capabilities.resume?.kind === "command" ? capabilities.resume.command : capabilities.resume?.flag;
  else fail3("UNPROVEN_SESSION", "This proof requires caller-assigned or exact resume argv");
  const at2 = marker ? argv.indexOf(marker, capabilities.run.length) : -1;
  if (at2 < 0 || argv[at2 + 1] !== s.sessionId || argv.includes("--last") || argv.includes("--continue")) fail3("UNPROVEN_SESSION", "The exact session ID is absent from verified launch argv");
  return validateProof({ kind, session: s, terminal: clone(terminal), observedAt, sourceDigest }, s, terminal);
}
var BindingStore = class {
  constructor(io, { clock = () => Date.now() } = {}) {
    this.io = io;
    this.clock = clock;
    const root = typeof io.appHome === "function" ? io.appHome() : io.appHome;
    this.path = root.replace(/\/$/, "") + "/mission-control/session-bindings.json";
  }
  now() {
    const n = this.clock();
    if (!time(n)) fail3("INVALID_CLOCK", "The binding clock is unavailable");
    return n;
  }
  async read() {
    const raw = await this.io.readTextFile(this.path);
    if (raw === null) return { raw, value: empty() };
    if (typeof raw !== "string" || bytes(raw) > 768 * 1024) fail3("BINDING_CAPACITY", "Binding file exceeds its supported size");
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      fail3("INVALID_BINDING", "Binding JSON is invalid; original preserved");
    }
    const value = validateBindingStore(data);
    capacity(value);
    return { raw, value };
  }
  async edit(edit, { recoveryRecorded = [] } = {}) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const { raw, value } = await this.read(), draft = clone(value), now3 = this.now();
      pruneBindings(draft, now3, { recoveryRecorded });
      const result = edit(draft, now3);
      pruneBindings(draft, now3, { recoveryRecorded });
      draft.revision++;
      if (!Number.isSafeInteger(draft.revision)) fail3("BINDING_CAPACITY", "Binding revision exhausted");
      const next = validateBindingStore(indexes(draft));
      capacity(next);
      await this.io.ensureDirectory?.(this.path.slice(0, this.path.lastIndexOf("/")));
      try {
        await this.io.writeTextFile(this.path, JSON.stringify(next) + "\n", raw);
        return { value: next, result };
      } catch (e) {
        if (!conflict2(e)) throw e;
      }
    }
    fail3("CONFLICT", "Binding state changed repeatedly; retry the acknowledged commit without launching again");
  }
  async propose({ requestId, originId, session: session2 = null }, { recoveryRecorded = [] } = {}) {
    text2(requestId, "request ID");
    text2(originId, "origin ID");
    const exact = session2 ? sessionIdentity(session2) : null;
    return (await this.edit((d, now3) => {
      const old = d.proposals[requestId];
      if (old) {
        if (old.originId !== originId || JSON.stringify(old.session) !== JSON.stringify(exact)) fail3("BINDING_CONFLICT", "A request cannot change its origin or exact session");
        if (old.state === "invalidated" || ["proposed", "commit-pending"].includes(old.state) && old.expiresAt <= now3) fail3("RECOVERY_REQUIRED", "The interrupted request needs recovery; do not launch it again");
        return clone(old);
      }
      const record = { originId, session: exact, state: "proposed", createdAt: now3, updatedAt: now3, invalidatedAt: null, expiresAt: now3 + 3e5 };
      d.proposals[requestId] = record;
      return clone(record);
    }, { recoveryRecorded })).result;
  }
  async transition(requestId, ack, proof, { pending = false, session: session2 } = {}) {
    validateAck(ack);
    const exact = session2 ? sessionIdentity(session2) : null;
    return (await this.edit((d, now3) => {
      const r = d.proposals[requestId];
      if (!r || r.state === "invalidated") fail3("RECOVERY_REQUIRED", "No active proposal exists for this acknowledged launch");
      if (r.state !== "committed" && r.expiresAt <= now3) fail3("RECOVERY_REQUIRED", "Acknowledged launch proposal expired; retain it for explicit recovery");
      if (now3 < r.updatedAt) fail3("INVALID_CLOCK", "The binding clock moved backwards");
      const selected = r.session || exact;
      if (r.session && exact && sessionKey(r.session) !== sessionKey(exact)) fail3("BINDING_CONFLICT", "A committed request cannot change provider sessions");
      if (selected) validateProof(proof, selected, ack.terminal);
      if (r.ack && (r.ack.tabId !== ack.tabId || terminalKey(r.ack.terminal) !== terminalKey(ack.terminal))) fail3("BINDING_CONFLICT", "Acknowledgment belongs to a different tab/terminal generation");
      if (r.state === "committed" && r.session && selected && sessionKey(r.session) === sessionKey(selected)) return clone(r);
      if (r.state === "committed" && pending) return clone(r);
      r.session = selected || null;
      r.state = pending ? "commit-pending" : "committed";
      r.updatedAt = now3;
      r.expiresAt = pending ? r.expiresAt : null;
      r.ack = clone(ack);
      if (selected) r.proof = clone(proof);
      return clone(r);
    })).result;
  }
  commitAcknowledged(requestId, ack, proof, options) {
    return this.transition(requestId, ack, proof, options);
  }
  markCommitPending(requestId, ack, proof, options = {}) {
    return this.transition(requestId, ack, proof, { ...options, pending: true });
  }
  async readCommitted(terminal) {
    const { value } = await this.read(), id = value.terminals[terminalKey(terminal)], r = id ? value.proposals[id] : null;
    return r?.state === "committed" && r.session ? { requestId: id, ...clone(r) } : null;
  }
  async requestState(requestId) {
    const { value } = await this.read(), r = value.proposals[requestId];
    return r ? { ...clone(r), recoveryRequired: ["proposed", "commit-pending"].includes(r.state) && r.expiresAt <= this.now() } : null;
  }
  async invalidate(requestId, reason = "Exact generation/source no longer valid") {
    text2(reason, "invalidation reason", 512);
    return (await this.edit((d, now3) => {
      const r = d.proposals[requestId];
      if (!r) return null;
      if (now3 < r.updatedAt) fail3("INVALID_CLOCK", "The binding clock moved backwards");
      r.invalidatedAt = r.invalidatedAt ?? now3;
      r.updatedAt = now3;
      r.state = "invalidated";
      r.expiresAt = null;
      r.reason = reason;
      return clone(r);
    })).result;
  }
  async reconcile(raws, { machine: machine2 = null, available = true, authoritative = false, enabledSources = null } = {}) {
    const on = machineIdentity(machine2);
    if (!available) return { invalidated: [], offline: true };
    const generations = /* @__PURE__ */ new Map();
    for (const raw of raws) {
      const identity = terminalIdentity(raw, on);
      generations.set(identity.address, identity);
    }
    return (await this.edit((d, now3) => {
      const invalidated = [];
      for (const [id, r] of Object.entries(d.proposals)) {
        if (r.state !== "committed" || r.ack.terminal.machine !== on) continue;
        const actual = generations.get(r.ack.terminal.address), changed = actual && terminalKey(actual) !== terminalKey(r.ack.terminal), missing = !actual && authoritative;
        const disabled = r.session && enabledSources && !enabledSources.some((s) => s.machine === r.session.machine && s.provider === r.session.provider && s.credentialScope === r.session.credentialScope && s.providerRoot === r.session.providerRoot);
        if (changed || missing || disabled) {
          if (now3 < r.updatedAt) fail3("INVALID_CLOCK", "The binding clock moved backwards");
          r.state = "invalidated";
          r.invalidatedAt = r.invalidatedAt ?? now3;
          r.updatedAt = now3;
          r.expiresAt = null;
          r.reason = disabled ? "Source disabled or profile/root changed" : changed ? "Terminal generation or foreground PID changed" : "Terminal closed";
          invalidated.push(id);
        }
      }
      return { invalidated, offline: false };
    })).result;
  }
  async garbageCollect(options = {}) {
    return (await this.edit(() => null, options)).value;
  }
  async invalidateSources(enabledSources) {
    return (await this.edit((d, now3) => {
      const invalidated = [];
      for (const [id, r] of Object.entries(d.proposals)) {
        if (r.state === "invalidated" || !r.session || enabledSources.some((s) => s.machine === r.session.machine && s.provider === r.session.provider && s.credentialScope === r.session.credentialScope && s.providerRoot === r.session.providerRoot)) continue;
        if (now3 < r.updatedAt) fail3("INVALID_CLOCK", "The binding clock moved backwards");
        r.state = "invalidated";
        r.invalidatedAt = r.invalidatedAt ?? now3;
        r.updatedAt = now3;
        r.expiresAt = null;
        r.reason = "Source disabled or changed";
        invalidated.push(id);
      }
      return invalidated;
    })).result;
  }
};

// src/shared/usage-sources.js
var providers = /* @__PURE__ */ new Set(["codex", "claude", "grok"]);
var copy2 = (value) => JSON.parse(JSON.stringify(value));
var fail4 = (message) => {
  throw Object.assign(Error(message), { code: "INVALID_USAGE_SOURCE" });
};
var text3 = (value, max = 200) => typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value);
var broad = /* @__PURE__ */ new Set(["/", "/Users", "/home", "/tmp", "/private", "/private/tmp", "/var", "/etc", "/usr", "/opt", "/Volumes"]);
var forbidden = (path) => path.toLowerCase().split("/").some((p) => [".ssh", ".aws", ".azure", "keychains", "auth", "credentials", "secrets", "auth.json", ".credentials.json", "credentials.json", "settings.json", "config.json", "keys.json"].includes(p) || /\.(pem|key|p12)$/.test(p));
var canonical = (value) => {
  try {
    if (!text3(value, 4096) || canonicalRepoPath(value) !== value || broad.has(value) || forbidden(value)) fail4("Usage roots must be dedicated canonical metadata directories, outside credential paths.");
    return value;
  } catch {
    fail4("Usage roots must be dedicated canonical metadata directories, outside credential paths.");
  }
};
function validateUsageSource(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.v !== 1 || !providers.has(value.provider) || typeof value.enabled !== "boolean" || !text3(value.credentialScope)) fail4("A versioned provider/profile source is required.");
  const machine2 = machineIdentity(value.machine), providerRoot = canonical(value.providerRoot);
  if (!Object.hasOwn(value, "machine")) fail4("An explicit source machine is required.");
  if (!Array.isArray(value.roots) || !value.roots.length || value.roots.length > 8 || value.cacheRoots !== void 0 && (!Array.isArray(value.cacheRoots) || value.cacheRoots.length > 4)) fail4("Configure one to eight session roots and at most four explicit cache roots.");
  const check = (path) => {
    canonical(path);
    if (path === providerRoot || providerRoot.startsWith(path + "/") || /^\/(Users|home)\/[^/]+$/.test(path) || ["Library", "Desktop", "Documents", "Downloads", "Applications", ".config", ".cache"].includes(path.split("/").at(-1))) fail4("A profile, home, broad personal directory or ancestor cannot be scanned.");
    return path;
  };
  const roots = [...new Set(value.roots.map(check))], cacheRoots = [...new Set((value.cacheRoots || []).map(check))];
  if (roots.some((root) => cacheRoots.includes(root))) fail4("Session and sanitized cache roots must be separate.");
  return { v: 1, enabled: value.enabled, machine: machine2, provider: value.provider, providerRoot, credentialScope: value.credentialScope, roots, ...cacheRoots.length ? { cacheRoots } : {} };
}
var usageSourceKey = (source) => {
  const s = validateUsageSource(source);
  return JSON.stringify([s.machine, s.provider, s.providerRoot, s.credentialScope]);
};
var usageSourceFingerprint = (source) => JSON.stringify(validateUsageSource(source));
function defaultUsageSources({ machine: machine2 = null, home, installed = [] }) {
  const base3 = canonical(home), on = machineIdentity(machine2), keys2 = new Set(installed.filter((t) => t.installed === true).map((t) => t.key)), result = {};
  for (const provider of providers) {
    if (!keys2.has(provider)) continue;
    const root = base3 + "/." + provider, roots = provider === "claude" ? [root + "/projects"] : provider === "codex" ? [root + "/sessions", root + "/archived_sessions"] : [root + "/sessions"];
    const source = validateUsageSource({ v: 1, enabled: true, machine: on, provider, credentialScope: "standard", providerRoot: root, roots });
    result[usageSourceKey(source)] = source;
  }
  return result;
}
async function ensureUsageDefaults(io, options) {
  const defaults = defaultUsageSources(options), existing = (await readConfig(io)).value;
  const absent = (config) => Object.values(defaults).filter((s) => !Object.values(config.usageSources).some((v) => v?.provider === s.provider && (v.machine ?? null) === s.machine));
  if (!absent(existing).length) return existing;
  return updateConfig(io, (config) => {
    for (const source of absent(config)) config.usageSources[usageSourceKey(source)] = source;
  });
}
var UsageSourceRegistry = class {
  constructor(io, { clearCache, invalidateBindings }) {
    if (typeof clearCache !== "function" || typeof invalidateBindings !== "function") fail4("Source lifecycle requires cache and durable-binding invalidation capabilities.");
    this.io = io;
    this.clearCache = clearCache;
    this.invalidateBindings = invalidateBindings;
    this.sources = /* @__PURE__ */ new Map();
    this.generations = /* @__PURE__ */ new Map();
    this.tickets = /* @__PURE__ */ new Set();
    this.blocked = /* @__PURE__ */ new Set();
    this.revision = -1;
    this.closed = false;
  }
  cancel(id, source) {
    this.generations.set(id, (this.generations.get(id) || 0) + 1);
    for (const ticket of this.tickets) if (ticket.id === id) ticket.cancelled = true;
    const result = this.clearCache(id, source ? copy2(source) : null);
    if (result?.then) fail4("Cache invalidation must be synchronous.");
  }
  async refresh() {
    const previous = this.queue;
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    this.queue = current;
    try {
      if (previous) await previous;
      return await this.reconcile();
    } finally {
      release();
      if (this.queue === current) this.queue = null;
    }
  }
  async reconcile() {
    if (this.closed) return [];
    let config;
    try {
      config = (await readConfig(this.io)).value;
      const seen = /* @__PURE__ */ new Set();
      for (const source of Object.values(config.usageSources)) {
        const key3 = usageSourceKey(source);
        if (seen.has(key3)) fail4("Duplicate provider/profile/root sources must be merged explicitly.");
        seen.add(key3);
      }
    } catch (error2) {
      for (const [id, source] of this.sources) this.cancel(id, source);
      this.sources.clear();
      for (const ticket of this.tickets) ticket.cancelled = true;
      await this.invalidateBindings([]);
      throw error2;
    }
    if (config.revision < this.revision) return this.enabled();
    const initial = this.revision < 0, next = new Map(Object.entries(config.usageSources).map(([id, source]) => [id, validateUsageSource(source)])), changed = /* @__PURE__ */ new Set();
    for (const [id, old] of this.sources) if (!next.has(id) || usageSourceFingerprint(old) !== usageSourceFingerprint(next.get(id))) {
      changed.add(usageSourceKey(old));
      this.cancel(id, old);
    }
    this.sources = next;
    this.revision = config.revision;
    if (initial || changed.size) await this.invalidateBindings([...next.values()].filter((s) => s.enabled && !changed.has(usageSourceKey(s))));
    return this.enabled();
  }
  enabled() {
    return [...this.sources].filter(([id, source]) => source.enabled && !this.blocked.has(id)).map(([id, source]) => ({ ...copy2(source), id }));
  }
  begin(id) {
    const source = this.sources.get(id);
    if (this.closed || !source?.enabled || this.blocked.has(id)) return null;
    const ticket = { id, generation: this.generations.get(id) || 0, fingerprint: usageSourceFingerprint(source), source: copy2(source), cancelled: false };
    this.tickets.add(ticket);
    return ticket;
  }
  current(ticket) {
    const source = this.sources.get(ticket?.id);
    return !this.closed && this.tickets.has(ticket) && !ticket.cancelled && !this.blocked.has(ticket.id) && source?.enabled && (this.generations.get(ticket.id) || 0) === ticket.generation && usageSourceFingerprint(source) === ticket.fingerprint;
  }
  release(ticket) {
    this.tickets.delete(ticket);
  }
  async accept(ticket, value, publish) {
    try {
      await this.refresh();
      if (!this.current(ticket)) return false;
      const result = publish(value, copy2(ticket.source));
      if (result?.then) fail4("Usage publication must be synchronous.");
      return true;
    } finally {
      this.release(ticket);
    }
  }
  async save(id, value, { expectedFingerprint } = {}) {
    if (!text3(id, 8192) || ["__proto__", "prototype", "constructor"].includes(id)) fail4("Invalid usage source key.");
    const next = validateUsageSource(value), old = this.sources.get(id);
    this.blocked.add(id);
    this.cancel(id, old || next);
    try {
      await updateConfig(this.io, (config) => {
        const current = config.usageSources[id];
        if (expectedFingerprint !== void 0 && (current ? usageSourceFingerprint(current) : null) !== expectedFingerprint) throw Object.assign(Error("This usage source changed; reload it before saving."), { code: "SOURCE_CONFLICT" });
        config.usageSources[id] = next;
      });
      await this.refresh();
      return copy2(next);
    } finally {
      this.blocked.delete(id);
    }
  }
  close() {
    this.closed = true;
    for (const [id, source] of this.sources) this.cancel(id, source);
    this.tickets.clear();
    this.sources.clear();
  }
};

// src/shared/provider-observation.js
var object2 = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
var text4 = (v, max = 200) => typeof v === "string" && v.length > 0 && v.length <= max && !/[\u0000-\u001f]/.test(v);
var number = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
var nullableNumber = (v) => v === null || number(v);
var timestamp = (v) => v === null || number(v) && v <= 864e13;
var keys = (v, required, optional = []) => object2(v) && required.every((k) => Object.hasOwn(v, k)) && Object.keys(v).every((k) => required.includes(k) || optional.includes(k));
var providers2 = /* @__PURE__ */ new Set(["codex", "claude", "grok"]);
var session = (value) => {
  if (!keys(value, ["machine", "provider", "credentialScope", "providerRoot", "sessionId"]) || !(value.machine === null || text4(value.machine, 128)) || !providers2.has(value.provider) || !text4(value.credentialScope) || !text4(value.sessionId)) return false;
  try {
    return sessionIdentity(value).providerRoot === value.providerRoot;
  } catch {
    return false;
  }
};
function validateProviderObservation(value, { identity } = {}) {
  const fail12 = (code, reason) => ({ ok: false, code, reason });
  if (!object2(value) || !["available", "unavailable"].includes(value.state)) return fail12("INVALID_OBSERVATION", "Provider observation envelope is invalid.");
  if (value.identity !== null && !session(value.identity)) return fail12("INVALID_OBSERVATION", "Provider session identity is invalid.");
  if (value.state === "available" && value.identity === null) return fail12("INVALID_OBSERVATION", "Measured observations require an exact session identity.");
  const p = value.provenance;
  if (!keys(p, ["provider", "format", "formatVersion", "sourceDigest", "observedAt"]) || !providers2.has(p.provider) || !text4(p.format, 80) || !(p.formatVersion === null || text4(p.formatVersion, 80)) || typeof p.sourceDigest !== "string" || !/^[a-f0-9]{64}$/.test(p.sourceDigest) || !timestamp(p.observedAt) || value.identity && p.provider !== value.identity.provider) return fail12("INVALID_OBSERVATION", "Provider provenance is invalid.");
  if (identity) {
    if (!session(identity)) return fail12("INVALID_IDENTITY", "The requested session identity is invalid.");
    if (p.provider !== identity.provider || value.identity && sessionKey(value.identity) !== sessionKey(identity)) return fail12("SCOPE_MISMATCH", "Observation belongs to a different exact provider session.");
  }
  if (value.state === "unavailable") return keys(value, ["state", "identity", "provenance", "code", "reason"]) && text4(value.code, 80) && text4(value.reason, 300) ? { ok: true, value } : fail12("INVALID_OBSERVATION", "Unavailable observation is invalid.");
  if (!keys(value, ["state", "identity", "provenance", "context", "quota"], ["title", "cwd"])) return fail12("INVALID_OBSERVATION", "Unexpected provider observation fields.");
  if (Object.hasOwn(value, "title") && !text4(value.title)) return fail12("INVALID_OBSERVATION", "Reported session title is invalid.");
  if (Object.hasOwn(value, "cwd")) {
    try {
      if (canonicalRepoPath(value.cwd) !== value.cwd) return fail12("INVALID_OBSERVATION", "Reported working directory is not canonical.");
    } catch {
      return fail12("INVALID_OBSERVATION", "Reported working directory is invalid.");
    }
  }
  const c = value.context;
  if (c !== null && (!keys(c, ["usedTokens", "windowTokens", "compactionLimitTokens", "reportedUsedPercent"]) || Object.values(c).some((v) => !nullableNumber(v)) || c.reportedUsedPercent !== null && c.reportedUsedPercent > 100)) return fail12("INVALID_OBSERVATION", "Provider context fields are invalid.");
  const q = value.quota;
  if (q !== null) {
    if (!keys(q, ["proof", "windows"])) return fail12("INVALID_OBSERVATION", "Provider quota envelope is invalid.");
    const proof = q.proof;
    if (!keys(proof, ["kind", "machine", "credentialScope", "accountId", "poolId"]) || !["provider-account", "session-account-digest", "session-report", "none"].includes(proof.kind) || proof.machine !== value.identity.machine || proof.credentialScope !== value.identity.credentialScope || ![proof.accountId, proof.poolId].every((v) => v === null || text4(v))) return fail12("INVALID_OBSERVATION", "Provider quota identity is invalid.");
    if (!Array.isArray(q.windows) || q.windows.length > 16 || q.windows.some((w) => !keys(w, ["name", "remainingPercent", "observedAt", "resetsAt"]) || !text4(w.name, 80) || !number(w.remainingPercent) || w.remainingPercent > 100 || !timestamp(w.observedAt) || !timestamp(w.resetsAt))) return fail12("INVALID_OBSERVATION", "Provider quota windows are invalid.");
  }
  return { ok: true, value };
}

// src/shared/context.js
var CONTEXT_STALE_MS = 12e4;
var clamp = (value) => Math.max(0, Math.min(100, value));
function normalizeContext(observation, identity, { now: now3 = Date.now(), staleAfter = CONTEXT_STALE_MS } = {}) {
  let target;
  try {
    target = sessionIdentity(identity);
  } catch {
    return { identity: null, state: "unavailable", remainingPercent: null, basis: "unavailable", observedAt: null, reason: "An exact provider session identity is required." };
  }
  const missing = (reason2) => ({ identity: target, state: "unavailable", remainingPercent: null, basis: "unavailable", observedAt: null, reason: reason2 });
  if (!observation) return missing("No exact session context observation is available.");
  const checked = validateProviderObservation(observation, { identity: target });
  if (!checked.ok) return missing(checked.reason);
  if (observation.state !== "available") return missing(observation.reason);
  const c = observation.context;
  if (!c) return missing("This provider has not reported session context.");
  const { usedTokens: used, windowTokens: window, compactionLimitTokens: limit, reportedUsedPercent: percent } = c;
  if (window === 0 || limit === 0 || limit !== null && window !== null && limit > window) return missing("Reported context window and compaction limit are contradictory.");
  if (percent !== null && used !== null && window !== null && Math.abs(percent - clamp(100 * used / window)) > 1) return missing("Reported token counts and context percentage disagree.");
  let remaining, basis, reason;
  if (limit !== null && used !== null) {
    remaining = clamp(100 * (limit - used) / limit);
    basis = "reported";
    reason = "Remaining before the reported compaction threshold.";
  } else if (used !== null && window !== null) {
    remaining = clamp(100 * (window - used) / window);
    basis = "estimate";
    reason = "Context-window estimate; the provider did not report its compaction threshold.";
  } else if (percent !== null) {
    remaining = clamp(100 - percent);
    basis = "estimate";
    reason = "Reported context-window percentage; the compaction threshold is unavailable.";
  } else return missing("A reported context window or percentage is required; model names do not establish capacity.");
  const at2 = observation.provenance.observedAt;
  if (at2 === null) return missing("The context observation has no session-specific timestamp.");
  if (at2 > now3 + 5e3) return missing("The context observation is dated in the future.");
  const stale = now3 - at2 > staleAfter;
  return { identity: target, state: stale ? "stale" : "available", remainingPercent: remaining, basis, observedAt: at2, reason: stale ? "The last exact context observation is older than two minutes. " + reason : reason };
}
function selectContext(observations, identity, options = {}) {
  const valid = (Array.isArray(observations) ? observations : []).filter((o) => o?.identity && validateProviderObservation(o, { identity }).ok);
  const turns = valid.filter((o) => o.state === "available" && Number.isFinite(o.provenance?.observedAt)).map((o) => o.provenance.observedAt), turn = turns.length ? Math.max(...turns) : null;
  const dated = valid.map((o) => turn !== null && o.state === "available" && o.provenance.observedAt === null && o.context?.reportedUsedPercent != null ? { ...o, provenance: { ...o.provenance, observedAt: turn } } : o);
  const readings = dated.map((o) => normalizeContext(o, identity, options));
  const measured = readings.filter((r) => r.state !== "unavailable").sort((a, b) => b.observedAt - a.observedAt);
  return measured[0] || readings[0] || normalizeContext(null, identity, options);
}

// src/shared/quota.js
var QUOTA_STALE_MS = 3e5;
var formats = { codex: /* @__PURE__ */ new Set(["codex-rollout-jsonl", "legacy-codex-app-server"]), claude: /* @__PURE__ */ new Set(["claude-project-jsonl", "legacy-claude-statusline"]), grok: /* @__PURE__ */ new Set(["grok-build-summary", "grok-build-updates", "legacy-grok-cli-billing"]) };
var quotaKey = (identity) => JSON.stringify([identity.machine, identity.provider, identity.credentialScope, identity.accountId, identity.poolId, identity.session ? sessionKey(identity.session) : null]);
function candidate(observation, identity, { now: now3 = Date.now(), staleAfter = QUOTA_STALE_MS } = {}) {
  let target;
  try {
    target = sessionIdentity(identity);
  } catch {
    target = null;
  }
  const unknown = { machine: target?.machine ?? null, provider: target?.provider ?? "unknown", credentialScope: target?.credentialScope ?? "unknown", accountId: null, poolId: null, ...target ? { session: target } : {} };
  const missing = (reason2) => ({ reading: { identity: unknown, state: "unavailable", windows: [], observedAt: null, scope: "unknown", reason: reason2 }, sourceWindows: [] });
  if (!target) return missing("An exact provider session identity is required.");
  if (!observation) return missing("No exact session quota observation is available.");
  const checked = validateProviderObservation(observation, { identity: target });
  if (!checked.ok) return missing(checked.reason);
  if (observation.state !== "available") return missing(observation.reason);
  if (!formats[target.provider]?.has(observation.provenance.format)) return missing("The quota source format is unsupported.");
  const q = observation.quota;
  if (!q || !q.windows.length || q.proof.kind === "none") return missing("This session has no proven provider quota report.");
  const names = new Set(q.windows.map((w) => w.name));
  if (names.size !== q.windows.length) return missing("The provider reported conflicting duplicate quota windows.");
  if (q.windows.some((w) => w.observedAt !== null && w.observedAt > now3 + 5e3)) return missing("The quota observation is dated in the future.");
  const p = q.proof;
  const noPool = target.provider === "claude" && observation.provenance.format === "legacy-claude-statusline" && p.kind === "session-account-digest" && /^[a-f0-9]{64}$/.test(p.accountId || "") && p.poolId === null;
  const shared2 = ["provider-account", "session-account-digest"].includes(p.kind) && p.accountId !== null && (p.poolId !== null || noPool);
  const quotaIdentity = { machine: target.machine, provider: target.provider, credentialScope: target.credentialScope, accountId: shared2 ? p.accountId : null, poolId: shared2 ? p.poolId : null, ...!shared2 ? { session: target } : {} };
  const unknownAge = q.windows.some((w) => w.observedAt === null), old = q.windows.some((w) => w.observedAt !== null && now3 - w.observedAt > staleAfter), reset = q.windows.some((w) => w.resetsAt !== null && w.resetsAt <= now3);
  const stale = unknownAge || old || reset;
  const reason = reset ? "A reported quota window has reset; a new observation is required." : unknownAge ? "A quota window has no trustworthy observation time." : old ? "The quota observation is older than five minutes." : shared2 ? "Shared account quota; matching agents use the same allowance." : "Session observation; the serving account/pool is not fully proven.";
  return { reading: { identity: quotaIdentity, state: stale ? "stale" : "available", windows: q.windows.map((w) => ({ name: w.name, remainingPercent: w.remainingPercent, ...w.resetsAt !== null ? { resetsAt: w.resetsAt } : {} })), observedAt: unknownAge ? null : Math.min(...q.windows.map((w) => w.observedAt)), scope: shared2 ? "shared-account" : "session-observation", reason }, sourceWindows: q.windows.map((w) => ({ ...w })) };
}
function normalizeQuota(observation, identity, options = {}) {
  return candidate(observation, identity, options).reading;
}
function selectQuota(observations, identity, options = {}) {
  const values = Array.isArray(observations) ? observations : [];
  const own = values.map((observation) => ({ observation, ...candidate(observation, identity, options) })).filter((c) => c.reading.state !== "unavailable");
  own.sort((a, b) => Math.max(...b.sourceWindows.map((w) => w.observedAt ?? -1)) - Math.max(...a.sourceWindows.map((w) => w.observedAt ?? -1)));
  const anchor = own[0];
  if (!anchor) return normalizeQuota(null, identity, options);
  if (anchor.reading.scope !== "shared-account" || anchor.reading.state !== "available") return anchor.reading;
  const key3 = quotaKey(anchor.reading.identity), windows = new Map(anchor.sourceWindows.map((w) => [w.name, w]));
  for (const observation of values) {
    const other = candidate(observation, observation?.identity, options);
    if (other.reading.state === "unavailable" || other.reading.scope !== "shared-account" || quotaKey(other.reading.identity) !== key3) continue;
    for (const window of other.sourceWindows) {
      const current = windows.get(window.name);
      if (window.observedAt !== null && (!current || window.observedAt > (current.observedAt ?? -1))) windows.set(window.name, window);
    }
  }
  return normalizeQuota({ ...anchor.observation, quota: { ...anchor.observation.quota, windows: [...windows.values()] } }, identity, options);
}

// src/shared/telemetry.js
var REFRESH_STALE_MS = 9e4;
var bytes2 = (value) => {
  let size = 0;
  for (const character of value) {
    const n = character.codePointAt(0);
    size += n < 128 ? 1 : n < 2048 ? 2 : n < 65536 ? 3 : 4;
  }
  return size;
};
var fail5 = (code, message) => {
  throw Object.assign(Error(message), { code });
};
var claudeForeground = (raw) => {
  const argv = Array.isArray(raw?.foreground?.argv) ? raw.foreground.argv.slice(0, 4) : [];
  return argv.some((a) => typeof a === "string" && (/(^|\/)claude$/.test(a) || a.includes("/@anthropic-ai/claude-code/")));
};
var RESUME_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var argvSession = (raw) => {
  const argv = Array.isArray(raw?.foreground?.argv) ? raw.foreground.argv.slice(0, 16) : [];
  if (!argv.length || argv.some((a) => a === "--last" || a === "--continue")) return null;
  const base3 = String(argv[0]).split("/").pop(), at2 = (flag, provider) => {
    const i = argv.indexOf(flag, 1);
    return i > 0 && RESUME_ID.test(String(argv[i + 1])) ? { provider, sessionId: argv[i + 1] } : null;
  };
  return base3 === "codex" ? at2("resume", "codex") : base3 === "grok" ? at2("--resume", "grok") : null;
};
var sameScope = (scope, source) => scope && ["machine", "provider", "providerRoot", "credentialScope"].every((k) => scope[k] === source[k]);
var TelemetryBridge = class {
  constructor(mod, api = herdr, { clock = () => Date.now() } = {}) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(mod)) fail5("INVALID_MOD", "A safe owning mod name is required.");
    this.mod = mod;
    this.io = createConfigIO(api);
    this.clock = clock;
    this.bindings = new BindingStore(this.io, { clock });
    this.observations = /* @__PURE__ */ new Map();
    this.measurements = /* @__PURE__ */ new Map();
    this.agentStates = /* @__PURE__ */ new Map();
    this.lastScan = /* @__PURE__ */ new Map();
    this.sourceErrors = /* @__PURE__ */ new Map();
    this.hostQueues = /* @__PURE__ */ new Map();
    this.activeHosts = 0;
    this.hostWaiters = [];
    this.closed = false;
    this.sources = new UsageSourceRegistry(this.io, { clearCache: (id) => {
      this.observations.delete(id);
      this.lastScan.delete(id);
      for (const state of this.agentStates.values()) if (state.sourceId === id) {
        this.measurements.delete(state.terminal?.address);
        state.session = null;
        state.reason = "Usage source changed or was disabled.";
      }
    }, invalidateBindings: (enabled) => this.bindings.invalidateSources(enabled) });
  }
  async slot() {
    if (this.activeHosts >= 4) {
      await new Promise((resolve) => this.hostWaiters.push(resolve));
      return;
    }
    this.activeHosts++;
  }
  unslot() {
    const next = this.hostWaiters.shift();
    if (next) next();
    else this.activeHosts--;
  }
  async onHost(machine2, work) {
    const key3 = JSON.stringify(machineIdentity(machine2)), previous = this.hostQueues.get(key3);
    let release, acquired = false;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    this.hostQueues.set(key3, current);
    try {
      if (previous) await previous;
      if (this.activeHosts >= 4) await this.slot();
      else this.activeHosts++;
      acquired = true;
      if (this.closed) fail5("CLOSED", "Telemetry view was closed.");
      return await work();
    } finally {
      if (acquired) this.unslot();
      release();
      if (this.hostQueues.get(key3) === current) this.hostQueues.delete(key3);
    }
  }
  async initializeSources() {
    const machines2 = this.io.machines?.() || [{ name: null, layout: "ready" }];
    await Promise.all(machines2.filter((m) => m.layout === "ready").map(async (m) => {
      try {
        const installed = await this.io.knownAgents({ on: m.name });
        if (this.closed) return;
        await this.onHost(m.name, async () => {
          let home;
          if (m.name === null) home = this.io.home();
          else {
            const result = await this.io.exec("python3", ["-c", 'import os,json; print(json.dumps({"home":os.path.realpath(os.path.expanduser("~"))}))'], { on: m.name });
            if (result.code !== 0) fail5("HOST_UNSUPPORTED", "Python metadata helpers are unavailable on this machine.");
            try {
              home = JSON.parse(result.stdout).home;
            } catch {
              fail5("INVALID_HOME", "The machine did not report its metadata home.");
            }
          }
          if (this.closed) return;
          await ensureUsageDefaults(this.io, { machine: m.name, home, installed });
        });
      } catch {
        if (!this.closed) this.sourceErrors.set(JSON.stringify(m.name), "Provider metadata defaults are unavailable on this host.");
      }
    }));
    return this.sources.refresh();
  }
  async collector() {
    if (this.code) return this.code;
    const code = await this.io.readTextFile(this.io.appHome() + "/mods/" + this.mod + "/collector.py");
    if (typeof code !== "string" || !code.length || bytes2(code) > 65536) fail5("COLLECTOR_UNAVAILABLE", "This mod has no valid self-contained bounded collector.");
    this.code = code;
    return code;
  }
  async request(source, { operation = "observe", identities = [], cursor, roots, limit = 50 } = {}) {
    const request = { v: 1, operation, source, ...identities.length ? { identities } : {}, ...cursor ? { cursor } : {}, ...roots ? { roots } : {}, limit };
    const serialized = JSON.stringify(request);
    if (bytes2(serialized) > 65536) fail5("REQUEST_TOO_LARGE", "The metadata request exceeds its bounded size.");
    const code = await this.collector();
    if (this.closed) fail5("CLOSED", "Telemetry view was closed.");
    const result = await this.io.exec("python3", ["-c", code, serialized], { on: source.machine });
    if (result.code !== 0) fail5("HOST_UNAVAILABLE", "The destination machine could not run its read-only Python collector.");
    if (typeof result.stdout !== "string" || bytes2(result.stdout) > 524288) fail5("RESPONSE_TOO_LARGE", "The metadata response exceeds its bounded size.");
    let response;
    try {
      response = JSON.parse(result.stdout);
    } catch {
      fail5("INVALID_RESPONSE", "The metadata response is not valid JSON.");
    }
    if (response?.v !== 1 || !sameScope(response.scope, source)) fail5("SCOPE_MISMATCH", "The metadata response belongs to a different host/provider/profile.");
    if (response.state === "error") fail5("SOURCE_UNAVAILABLE", "The configured metadata source is unavailable or unsupported.");
    if (!Array.isArray(response.data) || response.data.length > limit || typeof response.truncated !== "boolean" || !(response.cursor === null || typeof response.cursor === "string" && response.cursor.length <= 512) || !Array.isArray(response.errors) || !response.scan || !Number.isInteger(response.scan.indexed) || response.scan.indexed < 0 || response.scan.indexed > 1e3 || !Number.isFinite(response.scan.bytes) || response.scan.bytes < 0 || response.scan.bytes > 4 * 1024 * 1024) fail5("INVALID_RESPONSE", "The metadata response violates the bounded collector protocol.");
    const requested = new Set(identities.map(sessionKey));
    for (const value of response.data) {
      const checked = validateProviderObservation(value);
      if (!checked.ok || value.provenance.provider !== source.provider || value.identity && (!sameScope(value.identity, source) || operation === "observe" && !requested.has(sessionKey(value.identity)))) fail5("INVALID_OBSERVATION", "The collector returned malformed or wrong-scope session metadata.");
    }
    return response;
  }
  batches(source, identities, roots) {
    const batches = [];
    let current = [];
    for (const identity of identities) {
      const next = [...current, identity], request = { v: 1, operation: "observe", source, identities: next, roots, limit: 50 };
      if (next.length > 50 || bytes2(JSON.stringify(request)) > 64e3) {
        if (!current.length) fail5("REQUEST_TOO_LARGE", "The exact session scope cannot fit a bounded collector request.");
        batches.push(current);
        current = [identity];
      } else current = next;
    }
    if (current.length) batches.push(current);
    return batches;
  }
  async scanSource(source, identities, { force = false } = {}) {
    const previous = this.observations.get(source.id) || { live: [], cache: [] }, times = this.lastScan.get(source.id) || {};
    for (const [kind, roots, interval] of [["live", source.roots, 3e4], ["cache", source.cacheRoots || [], 6e4]]) {
      if (!roots.length || !identities.length || !force && times[kind] !== void 0 && this.clock() - times[kind] < interval) continue;
      const ticket = this.sources.begin(source.id);
      if (!ticket) continue;
      const rows = [];
      let partial = false;
      try {
        for (const batch of this.batches(ticket.source, identities, roots)) {
          let cursor;
          const expected = new Set(batch.map(sessionKey));
          for (let page = 0; page < 4; page++) {
            await this.sources.refresh();
            if (!this.sources.current(ticket)) return;
            const response = await this.request(ticket.source, { identities: batch, roots, cursor });
            rows.push(...response.data);
            cursor = response.cursor;
            partial = partial || response.truncated;
            if (!cursor || new Set(rows.filter((r) => r.identity && expected.has(sessionKey(r.identity))).map((r) => sessionKey(r.identity))).size >= batch.length) break;
          }
        }
        await this.sources.accept(ticket, rows.slice(0, 1e3), (value) => {
          previous[kind] = value;
          this.observations.set(source.id, previous);
          times[kind] = this.clock();
          this.lastScan.set(source.id, { ...times, truncated: partial });
        });
      } catch (error2) {
        if (ticket.cancelled) return;
        throw error2;
      } finally {
        this.sources.release(ticket);
      }
    }
  }
  /** Read-only: Claude Code's own records for these foreground PIDs, accepted only for the live process that wrote them. */
  async adopt(source, processes) {
    const unique = /* @__PURE__ */ new Map();
    for (const p of processes) if (!unique.has(p.pid)) unique.set(p.pid, { pid: p.pid, notBefore: p.notBefore });
    const request = { v: 1, operation: "adopt", source, pids: [...unique.values()].slice(0, 64) }, asked = new Set(request.pids.map((p) => p.pid)), serialized = JSON.stringify(request);
    if (bytes2(serialized) > 65536) fail5("REQUEST_TOO_LARGE", "The adoption request exceeds its bounded size.");
    const code = await this.collector();
    if (this.closed) fail5("CLOSED", "Telemetry view was closed.");
    const result = await this.io.exec("python3", ["-c", code, serialized], { on: source.machine });
    if (result.code !== 0 || typeof result.stdout !== "string" || bytes2(result.stdout) > 65536) fail5("HOST_UNAVAILABLE", "The destination machine could not run its read-only Python collector.");
    let response;
    try {
      response = JSON.parse(result.stdout);
    } catch {
      fail5("INVALID_RESPONSE", "The adoption response is not valid JSON.");
    }
    if (response?.v !== 1 || !sameScope(response.scope, source) || !Array.isArray(response.adopt)) fail5("SCOPE_MISMATCH", "The adoption response belongs to a different host/provider/profile.");
    const found = /* @__PURE__ */ new Map(), UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const row of response.adopt) if (row && asked.has(row.pid) && typeof row.sessionId === "string" && UUID.test(row.sessionId)) found.set(row.pid, row.sessionId);
    return found;
  }
  async full(address, machine2) {
    const local = localTerminalAddress(address, machine2), result = await this.io.exec("hc", ["get", local, "--json"], { on: machine2 });
    if (result.code !== 0 || typeof result.stdout !== "string" || bytes2(result.stdout) > 1048576) fail5("TERMINAL_UNAVAILABLE", "The exact terminal generation is unavailable on its machine.");
    let raw;
    try {
      raw = JSON.parse(result.stdout);
    } catch {
      fail5("INVALID_TERMINAL", "The exact terminal generation response is invalid.");
    }
    if (localTerminalAddress(raw.address, machine2) !== local) fail5("INVALID_TERMINAL", "The terminal response has a different address.");
    return { raw, terminal: terminalIdentity(raw, machine2) };
  }
  async hostRefresh(machine2, agents, { force }) {
    try {
      const listing = await this.io.exec("hc", ["ls", "--json"], { on: machine2 });
      let live;
      try {
        live = listing.code === 0 ? JSON.parse(listing.stdout).terminals : null;
      } catch {
      }
      if (!Array.isArray(live)) fail5("HOST_UNAVAILABLE", "The destination machine is offline or unavailable.");
      const addresses = /* @__PURE__ */ new Set();
      for (const raw of live) if (raw.state === void 0 || raw.state === "live") try {
        addresses.add(localTerminalAddress(raw.address, machine2));
      } catch {
      }
      const snapshot = (await this.bindings.read()).value, fullCache = /* @__PURE__ */ new Map();
      for (const [id, record] of Object.entries(snapshot.proposals)) if (record.state === "committed" && record.ack.terminal.machine === machine2) {
        if (this.closed) return;
        if (!addresses.has(localTerminalAddress(record.ack.terminal.address, machine2))) await this.bindings.invalidate(id, "Terminal is no longer live on its machine");
        else {
          let actual;
          try {
            actual = await this.full(record.ack.terminal.address, machine2);
          } catch {
            await this.bindings.invalidate(id, "Terminal is no longer live on its machine");
            continue;
          }
          fullCache.set(actual.terminal.address, actual);
          if (terminalKey(actual.terminal) !== terminalKey(record.ack.terminal)) await this.bindings.invalidate(id, "Terminal generation or foreground PID changed");
        }
      }
      const groups = /* @__PURE__ */ new Map(), sources = this.sources.enabled().filter((s) => s.machine === machine2);
      for (const agent of agents) {
        if (this.closed) return;
        let actual;
        try {
          const qualified = machine2 ? machine2 + "/" + localTerminalAddress(agent.address, machine2) : localTerminalAddress(agent.address, machine2);
          actual = fullCache.get(qualified) || await this.full(agent.address, machine2);
        } catch {
          this.agentStates.set(agent.address, { session: null, reason: "This agent’s terminal is no longer available." });
          continue;
        }
        const bound = await this.bindings.readCommitted(actual.terminal);
        if (this.closed) return;
        const source = bound ? sources.find((s) => usageSourceKey(s) === JSON.stringify([bound.session.machine, bound.session.provider, bound.session.providerRoot, bound.session.credentialScope])) : null;
        const state = { ...actual, session: bound?.session || null, requestId: bound?.requestId || null, sourceId: source?.id || null, unbound: !bound, reason: !bound ? "No committed exact provider session binding." : !source ? "This session usage source is disabled or unavailable." : null };
        if (!source) state.session = null;
        this.agentStates.set(agent.address, state);
        if (source) {
          if (!groups.has(source.id)) groups.set(source.id, { source, identities: /* @__PURE__ */ new Map() });
          groups.get(source.id).identities.set(sessionKey(bound.session), bound.session);
        }
        for (const [id, record] of Object.entries(snapshot.proposals)) if (record.state === "committed" && record.ack.terminal.machine === machine2 && record.ack.terminal.address === actual.terminal.address && terminalKey(record.ack.terminal) !== terminalKey(actual.terminal)) await this.bindings.invalidate(id, "Terminal generation or foreground PID changed");
      }
      const unbound = agents.map((agent) => [agent, this.agentStates.get(agent.address)]).filter(([, state]) => state?.unbound && Number.isSafeInteger(state.terminal?.foregroundPid) && Number.isSafeInteger(state.terminal?.createdMs));
      const adopt = (state, source, sessionId) => {
        state.session = { machine: machine2, provider: source.provider, credentialScope: source.credentialScope, providerRoot: source.providerRoot, sessionId };
        state.sourceId = source.id;
        state.adopted = true;
        state.reason = null;
        if (!groups.has(source.id)) groups.set(source.id, { source, identities: /* @__PURE__ */ new Map() });
        groups.get(source.id).identities.set(sessionKey(state.session), state.session);
      };
      for (const [, state] of unbound) {
        const hit = argvSession(state.raw);
        if (!hit) continue;
        const matches = sources.filter((s) => s.provider === hit.provider);
        if (matches.length === 1) adopt(state, matches[0], hit.sessionId);
        else if (matches.length) state.reason = `Several ${hit.provider} profiles are enabled on this machine; no session is chosen.`;
      }
      const claudeUnbound = unbound.filter(([, state]) => !state.session && claudeForeground(state.raw));
      if (claudeUnbound.length) {
        const hits = /* @__PURE__ */ new Map();
        for (const source of sources.filter((s) => s.provider === "claude")) {
          if (this.closed) return;
          let found;
          try {
            found = await this.adopt(source, claudeUnbound.map(([, state]) => ({ pid: state.terminal.foregroundPid, notBefore: state.terminal.createdMs })));
          } catch {
            continue;
          }
          for (const [pid, sessionId] of found) {
            if (!hits.has(pid)) hits.set(pid, []);
            hits.get(pid).push({ source, sessionId });
          }
        }
        for (const [, state] of claudeUnbound) {
          const found = hits.get(state.terminal.foregroundPid) || [];
          if (found.length !== 1) {
            if (found.length) state.reason = "Several Claude Code profiles claim this process; no session is chosen.";
            continue;
          }
          adopt(state, found[0].source, found[0].sessionId);
        }
      }
      for (const group of groups.values()) try {
        await this.scanSource(group.source, [...group.identities.values()], { force });
      } catch (error2) {
        for (const state of this.agentStates.values()) if (state.sourceId === group.source.id) {
          state.session = null;
          state.reason = "This provider metadata source or Python helper is unavailable.";
        }
      }
      for (const agent of agents) {
        if (this.closed) return;
        const state = this.agentStates.get(agent.address);
        if (!state?.session) continue;
        let actual;
        try {
          actual = await this.full(agent.address, machine2);
        } catch {
          this.agentStates.set(agent.address, { session: null, reason: "This agent’s terminal is no longer available." });
          continue;
        }
        const bound = await this.bindings.readCommitted(actual.terminal);
        if (this.closed) return;
        if (terminalKey(actual.terminal) !== terminalKey(state.terminal) || !state.adopted && (!bound || sessionKey(bound.session) !== sessionKey(state.session))) {
          if (state.requestId) await this.bindings.invalidate(state.requestId, "Terminal identity changed during usage collection");
          state.session = null;
          state.reason = "Terminal identity changed while collecting usage.";
        }
      }
    } catch (error2) {
      if (this.closed) return;
      const tag = [error2?.code, error2?.name].find((v) => typeof v === "string" && /^[A-Za-z_]{2,40}$/.test(v)), code = tag ? " (" + tag + ")" : "";
      for (const agent of agents) this.agentStates.set(agent.address, { session: null, reason: "Host, Python helper, source or exact terminal identity is unavailable" + code + "." });
    }
  }
  refresh(agents = this.io.agents(), { force = false } = {}) {
    if (this.closed) return Promise.resolve(/* @__PURE__ */ new Map());
    if (this.refreshing && this.clock() - this.refreshingAt < REFRESH_STALE_MS) return this.refreshing;
    this.refreshingAt = this.clock();
    const work = (async () => {
      await this.sources.refresh();
      const spaces2 = this.io.spaces(), groups = /* @__PURE__ */ new Map(), seen = /* @__PURE__ */ new Set();
      for (const source of this.sources.enabled()) if (!groups.has(JSON.stringify(source.machine))) groups.set(JSON.stringify(source.machine), { machine: source.machine, agents: [] });
      for (const agent of agents) {
        seen.add(agent.address);
        const space = spaces2.find((s) => s.id === agent.space);
        if (!space) {
          this.agentStates.set(agent.address, { session: null, reason: "The agent space/machine is unavailable." });
          continue;
        }
        const machine2 = machineIdentity(space.machine), key3 = JSON.stringify(machine2);
        if (!groups.has(key3)) groups.set(key3, { machine: machine2, agents: [] });
        groups.get(key3).agents.push({ ...agent });
      }
      for (const address of this.agentStates.keys()) if (!seen.has(address)) this.agentStates.delete(address);
      await Promise.all([...groups.values()].map((group) => this.onHost(group.machine, () => this.hostRefresh(group.machine, group.agents, { force })).then(() => {
        if (!this.closed) this.publishReadings(agents);
      })));
      return this.publishReadings(agents);
    })();
    this.refreshing = work;
    work.finally(() => {
      if (this.refreshing === work) this.refreshing = null;
    }).catch(() => {
    });
    return work;
  }
  publishReadings(agents) {
    const now3 = this.clock(), options = { now: now3 }, bySession = /* @__PURE__ */ new Map(), byAccount = /* @__PURE__ */ new Map(), shared2 = /* @__PURE__ */ new Map(), enabled = new Set(this.sources.enabled().map((s) => s.id));
    for (const value of this.observations.values()) for (const row of [...value.live, ...value.cache]) {
      if (!row.identity || !validateProviderObservation(row).ok) continue;
      const key3 = sessionKey(row.identity);
      if (!bySession.has(key3)) bySession.set(key3, []);
      bySession.get(key3).push(row);
      const quota = normalizeQuota(row, row.identity, options);
      if (quota.scope === "shared-account" && quota.state !== "unavailable") {
        const key4 = quotaKey(quota.identity);
        if (!byAccount.has(key4)) byAccount.set(key4, []);
        byAccount.get(key4).push(row);
      }
    }
    this.measurements.clear();
    for (const agent of agents) {
      const state = this.agentStates.get(agent.address), identity = state?.session;
      if (!identity || !enabled.has(state.sourceId)) continue;
      const rows = bySession.get(sessionKey(identity)) || [], context = selectContext(rows, identity, options), own = selectQuota(rows, identity, options);
      let quota = own;
      if (own.scope === "shared-account" && own.state === "available") {
        const key3 = quotaKey(own.identity);
        if (!shared2.has(key3)) shared2.set(key3, selectQuota(byAccount.get(key3) || rows, identity, options));
        quota = shared2.get(key3);
      }
      this.measurements.set(agent.address, { context, quota, proofObservedAt: own.observedAt });
    }
    return this.readings(agents);
  }
  reading(agent) {
    const state = this.agentStates.get(agent.address), value = this.measurements.get(agent.address), now3 = this.clock();
    if (!state?.session || !value) {
      const reason = state?.reason || "Exact session usage is not available yet.";
      return { context: { ...normalizeContext(null, null), reason }, quota: { ...normalizeQuota(null, null), reason } };
    }
    let { context, quota } = value;
    if (context.state === "available" && now3 - context.observedAt > CONTEXT_STALE_MS) context = { ...context, state: "stale", reason: "The exact context observation is older than two minutes." };
    if (quota.state === "available" && (now3 - quota.observedAt > QUOTA_STALE_MS || quota.windows.some((w) => w.resetsAt !== void 0 && w.resetsAt <= now3) || quota.scope === "shared-account" && (value.proofObservedAt === null || now3 - value.proofObservedAt > QUOTA_STALE_MS))) quota = { ...quota, state: "stale", reason: "The quota observation or exact session account proof needs refreshing." };
    return { context, quota };
  }
  readings(agents) {
    return new Map(agents.map((agent) => [agent.address, this.reading(agent)]));
  }
  async historyPage(sourceId, { cursor } = {}) {
    await this.sources.refresh();
    const ticket = this.sources.begin(sourceId);
    if (!ticket) fail5("SOURCE_DISABLED", "This history source is disabled.");
    try {
      return await this.onHost(ticket.source.machine, async () => {
        await this.sources.refresh();
        if (!this.sources.current(ticket)) fail5("SOURCE_CHANGED", "The history source changed before its scan.");
        const response = await this.request(ticket.source, { operation: "list", cursor, roots: ticket.source.roots });
        let accepted = false;
        await this.sources.accept(ticket, response, () => {
          accepted = true;
        });
        if (!accepted) fail5("SOURCE_CHANGED", "The history source changed during its scan.");
        return response;
      });
    } finally {
      this.sources.release(ticket);
    }
  }
  close() {
    this.closed = true;
    this.sources.close();
    this.observations.clear();
    this.measurements.clear();
    this.agentStates.clear();
  }
};

// src/shared/name-ownership.js
var clone2 = (v) => JSON.parse(JSON.stringify(v));
var error = (code, message) => {
  throw new ConfigError(code, message);
};
var text5 = (v, label2, max = 256) => {
  if (typeof v !== "string" || !v || v.length > max || ["__proto__", "prototype", "constructor"].includes(v) || /[\u0000-\u001f]/.test(v)) error("INVALID_NAMES", `Invalid ${label2}`);
  return v;
};
var tabKey = (tab) => JSON.stringify([machineIdentity(tab.machine), text5(tab.tabId, "tab ID")]);
var name = (v) => v === null ? null : text5(v, "tab name", 512);
var empty2 = () => ({ v: 1, revision: 0, origins: {}, sessions: {}, tabs: {}, lease: null });
function validate(value) {
  if (!value || value.v !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 || !value.origins || !value.sessions || !value.tabs) error("INVALID_NAMES", "Invalid name ownership file; original preserved");
  const next = clone2(value), sessions = {}, tabs = {};
  if (Object.keys(next.origins).length > 5e3) error("NAME_CAPACITY", "Too many retained names; archive old origins before adding more");
  for (const [id, r] of Object.entries(next.origins)) {
    if (id !== r.originId || !["auto", "manual"].includes(r.mode) || !Number.isSafeInteger(r.revision) || r.revision < 0) error("INVALID_NAMES", "Invalid name ownership record");
    text5(id, "origin ID");
    name(r.manualName);
    name(r.lastAutoName);
    if (r.mode === "manual" && r.manualName === null) error("INVALID_NAMES", "A manual name is required");
    if (r.session) {
      r.session = sessionIdentity(r.session);
      const s = sessionKey(r.session);
      if (sessions[s]) error("INVALID_NAMES", "Duplicate exact session ownership");
      sessions[s] = id;
    }
    if (r.currentTab) {
      const t = tabKey(r.currentTab);
      if (tabs[t]) error("INVALID_NAMES", "Duplicate current tab ownership");
      tabs[t] = id;
    }
  }
  if (JSON.stringify(sessions) !== JSON.stringify(next.sessions) || JSON.stringify(tabs) !== JSON.stringify(next.tabs)) error("INVALID_NAMES", "Name ownership indexes disagree");
  if (next.lease && (!Number.isFinite(next.lease.expiresAt) || typeof next.lease.owner !== "string" || !next.lease.owner)) error("INVALID_NAMES", "Invalid name observer lease");
  if (JSON.stringify(next).length > 768 * 1024) error("NAME_CAPACITY", "Name ownership file exceeds its supported size");
  return next;
}
function index(draft) {
  draft.sessions = {};
  draft.tabs = {};
  for (const [id, r] of Object.entries(draft.origins)) {
    if (r.session) draft.sessions[sessionKey(r.session)] = id;
    if (r.currentTab) draft.tabs[tabKey(r.currentTab)] = id;
  }
  return draft;
}
var isConflict = (e) => ["STALE", "CONFLICT", "EAGAIN"].includes(e?.code) || /stale|contents?.*changed|expected.*match|compare.and.set/i.test(e?.message || "");
var NameOwnership = class {
  constructor(io, { clock = () => Date.now(), owner: owner2 = "observer-" + Math.random().toString(36).slice(2) } = {}) {
    this.io = io;
    this.clock = clock;
    this.owner = owner2;
    const home = typeof io.appHome === "function" ? io.appHome() : io.appHome;
    this.path = home.replace(/\/$/, "") + "/mission-control/names.json";
  }
  async read() {
    const raw = await this.io.readTextFile(this.path);
    if (raw === null) return { value: empty2(), raw };
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      error("INVALID_NAMES", "Name ownership JSON is invalid; original preserved");
    }
    return { value: validate(data), raw };
  }
  async edit(fn) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const { value, raw } = await this.read(), draft = clone2(value), result = fn(draft);
      draft.revision++;
      if (!Number.isSafeInteger(draft.revision)) error("NAME_CAPACITY", "Name ownership revision exhausted");
      const next = validate(index(draft));
      await this.io.ensureDirectory?.(this.path.slice(0, this.path.lastIndexOf("/")));
      try {
        await this.io.writeTextFile(this.path, JSON.stringify(next) + "\n", raw);
        return { value: next, result };
      } catch (e) {
        if (!isConflict(e)) throw e;
      }
    }
    error("CONFLICT", "Name ownership changed repeatedly; no stale edit was applied");
  }
  async find({ originId, session: session2 } = {}) {
    const { value } = await this.read();
    const id = originId || (session2 ? value.sessions[sessionKey(session2)] : null);
    return id && value.origins[id] ? clone2(value.origins[id]) : null;
  }
  async transferToAcknowledgedTab({ originId, session: session2 }, { machine: machine2 = null, tabId, name: initialName = null }) {
    text5(originId, "origin ID");
    tabKey({ machine: machine2, tabId });
    name(initialName);
    const exact = session2 ? sessionIdentity(session2) : null;
    const { result } = await this.edit((d) => {
      const old = d.origins[originId];
      if (exact && d.sessions[sessionKey(exact)] && d.sessions[sessionKey(exact)] !== originId) error("NAME_CONFLICT", "This exact session belongs to a different work origin");
      if (old?.session && exact && sessionKey(old.session) !== sessionKey(exact)) error("NAME_CONFLICT", "An origin cannot change its provider session");
      const owner2 = d.tabs[tabKey({ machine: machine2, tabId })];
      if (owner2 && owner2 !== originId) error("NAME_CONFLICT", "The acknowledged tab belongs to another work origin");
      const sameTab = old?.currentTab && tabKey(old.currentTab) === tabKey({ machine: machine2, tabId });
      const record = { originId, ...old?.session || exact ? { session: old?.session || exact } : {}, currentTab: { machine: machineIdentity(machine2), tabId }, mode: old?.mode || "auto", manualName: old?.manualName ?? null, lastAutoName: sameTab ? old.lastAutoName : initialName, revision: (old?.revision ?? -1) + 1 };
      d.origins[originId] = record;
      return clone2(record);
    });
    return result;
  }
  async observeNames(tabs, { leaseMs = 5e3 } = {}) {
    if (!Number.isInteger(leaseMs) || leaseMs < 100 || leaseMs > 3e4) error("INVALID_NAMES", "Invalid observer lease duration");
    const snapshot = new Map(tabs.map((t) => [tabKey({ machine: t.machine, tabId: t.id ?? t.tabId }), t]));
    const { result } = await this.edit((d) => {
      const now3 = this.clock();
      if (d.lease && d.lease.owner !== this.owner && d.lease.expiresAt > now3) return { owned: false, changed: [] };
      d.lease = { owner: this.owner, expiresAt: now3 + leaseMs };
      const changed = [];
      for (const r of Object.values(d.origins)) {
        if (!r.currentTab) continue;
        const live = snapshot.get(tabKey(r.currentTab));
        if (!live) continue;
        const value = live.name ?? "";
        if (live.named === false && r.mode === "manual") {
          r.mode = "auto";
          r.manualName = null;
          r.lastAutoName = null;
          r.revision++;
          changed.push(r.originId);
        } else if (live.named === true && value && value !== r.lastAutoName && (r.mode !== "manual" || value !== r.manualName)) {
          name(value);
          r.mode = "manual";
          r.manualName = value;
          r.revision++;
          changed.push(r.originId);
        }
      }
      return { owned: true, changed };
    });
    return result;
  }
  async releaseLease() {
    return this.edit((d) => {
      if (d.lease?.owner === this.owner) d.lease = null;
    });
  }
  async backToAutomatic(originId) {
    return (await this.edit((d) => {
      const r = d.origins[originId];
      if (!r) error("UNKNOWN_ORIGIN", "Unknown work origin");
      r.mode = "auto";
      r.manualName = null;
      r.lastAutoName = null;
      r.revision++;
      return clone2(r);
    })).result;
  }
  async applyName(originId, desired, { getTabs, rename, manualTransfer = false } = {}) {
    name(desired);
    if (typeof getTabs !== "function" || typeof rename !== "function") error("INVALID_NAMES", "Live tab snapshot and rename action are required");
    const before = await this.find({ originId });
    if (!before?.currentTab || !manualTransfer && before.mode !== "auto") return { applied: false, reason: "manual-or-missing" };
    const find = () => getTabs().find((t) => tabKey({ machine: t.machine, tabId: t.id ?? t.tabId }) === tabKey(before.currentTab));
    const live = find();
    if (!live) return { applied: false, reason: "closed" };
    if (live.named && live.name !== before.lastAutoName && live.name !== before.manualName) return { applied: false, reason: "user-renamed" };
    const expectedName = live.name;
    const { result } = await this.edit((d) => {
      const r = d.origins[originId];
      if (!r || r.revision !== before.revision || tabKey(r.currentTab) !== tabKey(before.currentTab)) return false;
      if (manualTransfer) {
        if (r.mode !== "manual" || desired !== r.manualName) return false;
      } else {
        if (r.mode !== "auto") return false;
        r.lastAutoName = desired;
      }
      r.revision++;
      return true;
    });
    if (!result) return { applied: false, reason: "ownership-changed" };
    const latest = find();
    if (!latest || latest.name !== expectedName) return { applied: false, reason: "user-renamed" };
    rename({ id: before.currentTab.tabId, name: desired });
    return { applied: true };
  }
};

// src/shared/launch-preferences.js
var key = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/;
var fail6 = (message) => {
  throw new ConfigError("INVALID_LAUNCH_PREFERENCES", message);
};
var object3 = (v) => v && typeof v === "object" && !Array.isArray(v);
var bounded = (v, name2, max = 512) => {
  if (typeof v !== "string" || !v.trim() || v.length > max || /[\u0000-\u001f]/.test(v)) fail6(`Invalid ${name2}`);
  return v;
};
function validateToolOptions(value = {}) {
  if (!object3(value)) fail6("Tool options must be an object");
  for (const name2 of Object.keys(value)) if (!["model", "reasoning", "instructions", "skill", "subagents"].includes(name2)) fail6(`Unsupported tool option: ${name2}`);
  const result = {};
  if (value.model !== void 0) result.model = bounded(value.model, "model", 256);
  if (value.reasoning !== void 0) result.reasoning = bounded(value.reasoning, "reasoning", 32);
  if (value.instructions !== void 0) {
    if (typeof value.instructions !== "string" || value.instructions.length > 16e3 || value.instructions.includes("\0")) fail6("Invalid instructions");
    result.instructions = value.instructions;
  }
  if (value.skill !== void 0) result.skill = bounded(value.skill, "skill", 128);
  if (value.subagents !== void 0) {
    if (typeof value.subagents !== "boolean") fail6("Subagent preference must be boolean");
    result.subagents = value.subagents;
  }
  return result;
}
function installedTools(tools) {
  const seen = /* @__PURE__ */ new Set();
  return tools.filter((tool) => tool?.installed === true && key.test(tool.key) && Array.isArray(tool.run) && tool.run.length && tool.run.every((v) => typeof v === "string" && v.length && v.length <= 4096 && !v.includes("\0")) && !seen.has(tool.key) && seen.add(tool.key));
}

// src/shared/tool-capabilities.js
var CapabilityError = class extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CapabilityError";
    this.code = code;
  }
};
var fail7 = (code, message) => {
  throw new CapabilityError(code, message);
};
var has = (help, flag) => new RegExp(`(?:^|\\n)\\s*(?:-[A-Za-z],\\s*)?${flag.replaceAll("-", "\\-")}(?=\\s|[=<]|$)`, "m").test(help);
var uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
var fingerprint = (value) => {
  let n = 2166136261;
  for (let i = 0; i < value.length; i++) n = Math.imul(n ^ value.charCodeAt(i), 16777619);
  return (n >>> 0).toString(16).padStart(8, "0");
};
function parseCapabilities(tool, { on = null, help = "", resumeHelp = "", version = "unavailable", probeError = null } = {}) {
  if (!installedTools([tool]).length) fail7("TOOL_UNAVAILABLE", "The selected tool is not installed on this machine");
  const machine2 = machineIdentity(on), provider = tool.key === "claude" && /Claude Code/.test(help) ? "claude" : tool.key === "codex" && /Codex CLI/.test(help) ? "codex" : tool.key === "grok" && /Grok Build TUI/.test(help) ? "grok" : null;
  const result = { v: 1, key: tool.key, machine: machine2, run: [...tool.run], version: String(version).slice(0, 256), provider, base: true, model: null, reasoning: null, resume: null, callerSession: null, foregroundFlag: null, instructions: null, subagents: null, skill: false, prompt: false, probeError };
  if (provider) {
    result.model = has(help, "--model") ? "--model" : null;
    result.prompt = /\[(?:PROMPT|prompt)\]/.test(help);
    if (provider === "claude") {
      result.reasoning = has(help, "--effort") ? { flag: "--effort", values: ["low", "medium", "high", "xhigh", "max"].filter((v) => new RegExp(`\\b${v}\\b`).test(help.slice(help.indexOf("--effort"), help.indexOf("--effort") + 250))) } : null;
      result.resume = has(help, "--resume") ? { kind: "flag", flag: "--resume" } : null;
      result.callerSession = has(help, "--session-id") ? "--session-id" : null;
      result.instructions = has(help, "--append-system-prompt") ? "--append-system-prompt" : null;
    } else if (provider === "codex") {
      result.resume = /Usage:\s*codex resume[\s\S]*\[SESSION_ID\]/.test(resumeHelp) ? { kind: "command", command: "resume" } : null;
      result.foregroundFlag = has(help, "--no-daemon") ? "--no-daemon" : null;
    } else {
      result.resume = has(help, "--resume") ? { kind: "flag", flag: "--resume" } : null;
      result.callerSession = has(help, "--session-id") ? "--session-id" : null;
      result.reasoning = has(help, "--reasoning-effort") ? { flag: "--reasoning-effort", values: null } : null;
      result.instructions = has(help, "--rules") ? "--rules" : null;
      result.subagents = has(help, "--no-subagents") ? { disable: "--no-subagents" } : null;
    }
  }
  result.cacheKey = JSON.stringify([machine2, tool.key, tool.run, result.version, fingerprint(help + "\n" + resumeHelp)]);
  return result;
}
async function probeCapabilities(tool, { on = null, exec } = {}) {
  if (!installedTools([tool]).length) fail7("TOOL_UNAVAILABLE", "The selected tool is not installed on this machine");
  const call = async (flags) => {
    try {
      const r = await exec(tool.run[0], [...tool.run.slice(1), ...flags], { on: machineIdentity(on) });
      return r.code === 0 && typeof r.stdout === "string" ? r.stdout.slice(0, 65536) : "";
    } catch {
      return "";
    }
  };
  const help = await call(["--help"]), version = (await call(["--version"])).trim();
  const resumeHelp = tool.key === "codex" && /Codex CLI/.test(help) ? await call(["resume", "--help"]) : "";
  return parseCapabilities(tool, { on, help, resumeHelp, version: version || "unavailable", probeError: help ? null : "Advanced options unavailable: direct help probing failed. Base configured launch is available." });
}
function buildArguments(capabilities, { options = {}, resumeSessionId, newSessionId, prompt } = {}) {
  if (!capabilities?.base || !Array.isArray(capabilities.run) || !capabilities.run.length) fail7("TOOL_UNAVAILABLE", "No installed launch command");
  const requested = validateToolOptions(options), argv = [...capabilities.run];
  if (resumeSessionId && newSessionId) fail7("INVALID_OPTIONS", "Resume and new session ID are mutually exclusive");
  const requireOption = (enabled, name2) => {
    if (!enabled) fail7("UNSUPPORTED_OPTION", `${name2} is unavailable for this installed tool/version`);
  };
  if (capabilities.foregroundFlag) argv.push(capabilities.foregroundFlag);
  if (resumeSessionId) {
    requireOption(capabilities.resume, "Exact session resume");
    if (!uuid.test(resumeSessionId)) fail7("INVALID_SESSION", "Resume requires an exact provider session UUID");
    if (capabilities.resume.kind === "command") argv.push(capabilities.resume.command, resumeSessionId);
    else argv.push(capabilities.resume.flag, resumeSessionId);
  }
  if (newSessionId) {
    requireOption(capabilities.callerSession, "Caller-assigned session ID");
    if (!uuid.test(newSessionId)) fail7("INVALID_SESSION", "A valid provider session UUID is required");
    argv.push(capabilities.callerSession, newSessionId);
  }
  if (requested.model) {
    requireOption(capabilities.model, "Model selection");
    argv.push(capabilities.model, requested.model);
  }
  if (requested.reasoning) {
    requireOption(capabilities.reasoning, "Reasoning selection");
    const r = capabilities.reasoning;
    if (r.values && !r.values.includes(requested.reasoning)) fail7("UNSUPPORTED_OPTION", "Unsupported reasoning value");
    argv.push(r.flag, requested.reasoning);
  }
  if (requested.instructions) {
    requireOption(capabilities.instructions, "Custom instructions");
    argv.push(capabilities.instructions, requested.instructions);
  }
  if (requested.skill) fail7("UNSUPPORTED_OPTION", "This tool has no verified command-line skill selector");
  if (requested.subagents !== void 0) {
    requireOption(capabilities.subagents, "Subagent selection");
    if (!requested.subagents) argv.push(capabilities.subagents.disable);
  }
  if (prompt !== void 0) {
    requireOption(capabilities.prompt, "Initial prompt");
    if (typeof prompt !== "string" || prompt.includes("\0") || prompt.length > 64e3) fail7("INVALID_OPTIONS", "Invalid task text");
    argv.push("--", prompt);
  }
  return argv;
}
var CapabilityRegistry = class {
  constructor(exec, { clock = () => Date.now(), ttl = 6e4 } = {}) {
    this.exec = exec;
    this.clock = clock;
    this.ttl = ttl;
    this.cache = /* @__PURE__ */ new Map();
  }
  async get(tool, on = null) {
    if (!installedTools([tool]).length) fail7("TOOL_UNAVAILABLE", "The selected tool is no longer installed");
    const key3 = JSON.stringify([machineIdentity(on), tool.key, tool.run]), saved = this.cache.get(key3);
    if (saved && saved.expires > this.clock()) return saved.value;
    const value = await probeCapabilities(tool, { on, exec: this.exec });
    this.cache.set(key3, { expires: this.clock() + this.ttl, value });
    return value;
  }
  clear() {
    this.cache.clear();
  }
};

// src/shared/worktrees.js
var WorktreeError = class extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WorktreeError";
    this.code = code;
  }
};
var fail8 = (code, message) => {
  throw new WorktreeError(code, message);
};
var copy3 = (v) => JSON.parse(JSON.stringify(v));
var text6 = (v, label2, max = 512) => {
  if (typeof v !== "string" || !v || v.length > max || /[\u0000-\u001f]/.test(v)) fail8("INVALID_WORKTREE", `Invalid ${label2}`);
  return v;
};
function requestDigest(value) {
  text6(value, "request ID", 256);
  let a = 2166136261, b = 2654435769;
  for (let i = 0; i < value.length; i++) {
    a = Math.imul(a ^ value.charCodeAt(i), 16777619);
    b = Math.imul(b ^ value.charCodeAt(i), 2246822519);
  }
  return [a >>> 0, b >>> 0].map((n) => n.toString(16).padStart(8, "0")).join("").slice(0, 12);
}
function slug(value, max = 64) {
  text6(value, "worktree name");
  const v = value.normalize("NFKD").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/, "");
  if (!v || v === "." || v === "..") fail8("INVALID_WORKTREE", "Worktree name has no safe characters");
  return v;
}
function sourceIdentity(source) {
  if (!source) return null;
  for (const field of ["kind", "connectionId", "site", "id", "key"]) text6(source[field], `source ${field}`, field === "site" ? 2048 : 512);
  if (!["jira", "github", "github-pr", "gitlab", "gitlab-mr"].includes(source.kind) || !/^https:\/\/[^\s/@?#]+\/?$/.test(source.site)) fail8("INVALID_WORKTREE", "Unsupported tracker source identity");
  if (source.url !== void 0 || ["gitlab", "gitlab-mr"].includes(source.kind)) {
    text6(source.url, "source URL", 2048);
    if (!/^https:\/\/[^\s@]+$/.test(source.url)) fail8("INVALID_WORKTREE", "Unsupported tracker source URL");
  }
  return JSON.stringify([source.kind, source.connectionId, source.site, source.id]);
}
function requestShape(request) {
  if (!request || typeof request.worktree !== "boolean") fail8("INVALID_WORKTREE", "A boolean worktree choice is required");
  text6(request.requestId, "request ID", 256);
  text6(request.originId, "origin ID", 256);
  if (!request.source && request.checkoutRoot === void 0) fail8("INVALID_WORKTREE", "Generic launches require the captured checkoutRoot");
  const machine2 = machineIdentity(request.machine), repoRoot = canonicalRepoPath(request.repoRoot), checkoutRoot = canonicalRepoPath(request.checkoutRoot ?? request.repoRoot), sourceKey = sourceIdentity(request.source);
  if (!request.worktree && (request.worktreePath !== void 0 || request.branch !== void 0)) fail8("INVALID_WORKTREE", "Worktree path/branch overrides require a new worktree");
  if (request.worktreePath !== void 0) canonicalRepoPath(request.worktreePath);
  if (request.branch !== void 0) {
    text6(request.branch, "branch", 200);
    if (request.branch.startsWith("-")) fail8("INVALID_WORKTREE", "Invalid branch");
  }
  return { machine: machine2, repoRoot, checkoutRoot, sourceKey };
}
var HELPER = String.raw`
import os,sys,json,stat,hashlib,subprocess,tempfile
try:
 import fcntl
except ImportError:
 print(json.dumps({"ok":False,"code":"UNSUPPORTED_HOST","message":"Safe worktrees require Python with POSIX locking"}));sys.exit(0)
class Failure(Exception):
 def __init__(self,code,message): self.code=code;self.message=message
def stop(code,message): raise Failure(code,message)
def git(repo,args,check=True):
 p=subprocess.run(["git","-C",repo]+args,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=20)
 if check and p.returncode: stop("GIT_FAILED","Git rejected the worktree operation; existing work was preserved")
 return p
def safe(path):
 if not os.path.isabs(path) or os.path.normpath(path)!=path: stop("UNSAFE_PATH","A canonical absolute path is required")
 current="/"
 for part in path.split("/")[1:]:
  current=os.path.join(current,part)
  if os.path.lexists(current) and stat.S_ISLNK(os.lstat(current).st_mode): stop("SYMLINK_PATH","Worktree paths cannot pass through symlinks")
def root_for(repo):
 resolved=os.path.realpath(git(repo,["rev-parse","--show-toplevel"]).stdout.strip())
 if resolved!=repo: stop("REPO_CHANGED","The canonical repository root changed")
 return resolved
def same_checkout(repo,checkout):
 safe(checkout);root_for(checkout)
 a=os.path.realpath(git(repo,["rev-parse","--path-format=absolute","--git-common-dir"]).stdout.strip())
 b=os.path.realpath(git(checkout,["rev-parse","--path-format=absolute","--git-common-dir"]).stdout.strip())
 if a!=b: stop("CHECKOUT_MISMATCH","The selected checkout belongs to a different canonical repository")
def branches(repo):
 output=git(repo,["worktree","list","--porcelain"]).stdout
 return [dict(line.split(" ",1) if " " in line else (line,True) for line in block.splitlines()) for block in output.strip().split("\n\n") if block]
def check_spec(s):
 for k in ["path","repoRoot"]: safe(s[k])
 root_for(s["repoRoot"])
 same_checkout(s["repoRoot"],s["checkoutRoot"])
 if s["path"]==s["repoRoot"] or s["path"].startswith(s["repoRoot"]+"/"): stop("UNSAFE_PATH","A worktree must be outside its source repository")
 if s["repoRoot"].startswith(s["path"].rstrip("/")+"/"): stop("UNSAFE_PATH","A worktree cannot replace a repository ancestor")
 git(s["repoRoot"],["check-ref-format","--branch",s["branch"]])
 base=git(s["repoRoot"],["rev-parse","--verify",s["base"]+"^{commit}"]).stdout.strip()
 if base!=s["base"]: stop("BASE_CHANGED","Captured base commit is invalid")
def main(q):
 repo=q["repoRoot"];safe(repo);root_for(repo)
 if q["action"]=="prepare":
  branch=q["branch"];git(repo,["check-ref-format","--branch",branch])
  target=q["path"];safe(target)
  same_checkout(repo,q["checkoutRoot"])
  s={k:q[k] for k in ["requestId","originId","machine","repoRoot","checkoutRoot","sourceKey","path","branch","leaf"]}
  s["v"]=1;s["base"]=git(q["checkoutRoot"],["rev-parse","--verify","HEAD^{commit}"]).stdout.strip();check_spec(s)
  if os.path.lexists(target) or any(os.path.realpath(w["worktree"])==target for w in branches(repo)): stop("WORKTREE_EXISTS","The requested path already exists and is not owned by this request")
  if git(repo,["show-ref","--verify","--quiet","refs/heads/"+branch],False).returncode==0: stop("BRANCH_EXISTS","The requested branch already exists")
  return {"ok":True,"spec":s}
 s=q["spec"];check_spec(s)
 common=os.path.realpath(git(repo,["rev-parse","--path-format=absolute","--git-common-dir"]).stdout.strip())
 owned=os.path.join(common,"mission-control","worktrees");safe(owned);os.makedirs(owned,mode=0o700,exist_ok=True);safe(owned)
 lockpath=os.path.join(owned,".lock");fd=os.open(lockpath,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
 try:
  try: fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError: stop("WORKTREE_BUSY","Another worktree request is being committed; retry this same request")
  marker=os.path.join(owned,hashlib.sha256(s["requestId"].encode()).hexdigest()+".json");safe(marker)
  saved=None
  if os.path.lexists(marker):
   if not stat.S_ISREG(os.lstat(marker).st_mode) or os.path.getsize(marker)>32768: stop("OWNERSHIP_INVALID","Worktree ownership metadata is invalid")
   with open(marker) as f: saved=json.load(f)
   if saved.get("spec")!=s: stop("RETRY_CHANGED","The request has different captured worktree parameters")
  entries=branches(repo);matching=[w for w in entries if os.path.realpath(w["worktree"])==s["path"]]
  exists=os.path.lexists(s["path"]);branch_exists=git(repo,["show-ref","--verify","--quiet","refs/heads/"+s["branch"]],False).returncode==0
  if saved and saved.get("state")=="created":
   if len(matching)!=1 or matching[0].get("branch")!="refs/heads/"+s["branch"] or not os.path.isdir(s["path"]): stop("OWNERSHIP_CHANGED","The owned worktree was moved or changed; inspect it before retrying")
   return {"ok":True,"folder":s["path"],"reused":True,"spec":s}
  if exists or branch_exists or matching: stop("WORKTREE_RECOVERY_REQUIRED" if saved else "WORKTREE_EXISTS","Existing path/ref cannot be overwritten or adopted; inspect the captured request")
  def save(state):
   f,tmp=tempfile.mkstemp(prefix=".mc-",dir=owned)
   try:
    with os.fdopen(f,"w") as out: json.dump({"v":1,"state":state,"spec":s},out);out.flush();os.fsync(out.fileno())
    os.replace(tmp,marker)
   finally:
    if os.path.exists(tmp): os.unlink(tmp)
  save("proposed")
  parent=os.path.dirname(s["path"]);safe(parent);os.makedirs(parent,mode=0o700,exist_ok=True);safe(parent)
  git(repo,["worktree","add","-b",s["branch"],s["path"],s["base"]])
  safe(s["path"]);save("created")
  return {"ok":True,"folder":s["path"],"reused":False,"spec":s}
 finally: os.close(fd)
try:
 q=json.loads(sys.argv[1]);print(json.dumps(main(q)))
except Failure as e: print(json.dumps({"ok":False,"code":e.code,"message":e.message}))
except Exception: print(json.dumps({"ok":False,"code":"WORKTREE_ERROR","message":"Worktree operation failed; inspect the captured request before retrying"}))
`;
async function execute(exec, machine2, query) {
  if (typeof exec !== "function") fail8("UNSUPPORTED_HOST", "Target-host execution is unavailable");
  let r;
  try {
    r = await exec("python3", ["-c", HELPER, JSON.stringify(query)], { on: machine2 });
  } catch {
    fail8("UNSUPPORTED_HOST", "Python/Git could not run on the selected machine");
  }
  if (r.code !== 0) fail8("WORKTREE_ERROR", "The target-host worktree helper failed");
  let result;
  try {
    result = JSON.parse(r.stdout);
  } catch {
    fail8("WORKTREE_ERROR", "Invalid target-host worktree response");
  }
  if (!result.ok) fail8(result.code || "WORKTREE_ERROR", result.message || "Worktree operation failed");
  return result;
}
async function prepareWorktree(request, { spaceName, exec } = {}) {
  const shape = requestShape(request);
  if (!request.worktree) {
    await validateCheckout(shape, exec);
    return { v: 1, requestId: request.requestId, originId: request.originId, ...shape, path: shape.checkoutRoot, worktree: false };
  }
  const leaf = slug(spaceName || request.spaceId || "space", 48) + "-" + (request.source ? slug(request.source.key, 64) : "task-" + requestDigest(request.requestId));
  const parent2 = shape.repoRoot.slice(0, shape.repoRoot.lastIndexOf("/")) || "/";
  const target = request.worktreePath ? canonicalRepoPath(request.worktreePath) : `${parent2 === "/" ? "" : parent2}/.herdr-worktrees/${leaf}`;
  const branch = request.branch || `mission-control/${leaf}`;
  const result = await execute(exec, shape.machine, { action: "prepare", requestId: request.requestId, originId: request.originId, ...shape, path: target, branch, leaf });
  return { ...result.spec, worktree: true };
}
async function ensureWorktree(request, captured, { exec } = {}) {
  const shape = requestShape(request), spec = copy3(captured);
  if (spec?.v !== 1 || spec.requestId !== request.requestId || spec.originId !== request.originId || spec.machine !== shape.machine || spec.repoRoot !== shape.repoRoot || spec.checkoutRoot !== shape.checkoutRoot || spec.sourceKey !== shape.sourceKey || spec.worktree !== request.worktree) fail8("RETRY_CHANGED", "The request differs from its immutable captured worktree");
  if (request.worktreePath !== void 0 && canonicalRepoPath(request.worktreePath) !== spec.path || request.branch !== void 0 && request.branch !== spec.branch) fail8("RETRY_CHANGED", "Captured worktree path/ref cannot change on retry");
  if (!spec.worktree) {
    await validateCheckout(shape, exec);
    return { ok: true, folder: shape.checkoutRoot, reused: true, spec };
  }
  if (typeof spec.base !== "string" || !/^[a-f0-9]{40,64}$/.test(spec.base) || typeof spec.branch !== "string") fail8("INVALID_WORKTREE", "Invalid captured worktree");
  const payload = { ...spec };
  delete payload.worktree;
  return execute(exec, shape.machine, { action: "create", repoRoot: shape.repoRoot, spec: payload });
}
async function validateCheckout(shape, exec) {
  const read = async (cwd, args) => {
    const r = await exec("git", args, { cwd, on: shape.machine });
    if (r.code !== 0) fail8("CHECKOUT_MISMATCH", "The captured checkout is unavailable");
    return canonicalRepoPath(r.stdout.trim());
  };
  const main = await read(shape.repoRoot, ["rev-parse", "--show-toplevel"]), checkout = await read(shape.checkoutRoot, ["rev-parse", "--show-toplevel"]);
  if (main !== shape.repoRoot || checkout !== shape.checkoutRoot) fail8("CHECKOUT_MISMATCH", "The captured checkout root changed");
  const a = await read(main, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), b = await read(checkout, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (a !== b) fail8("CHECKOUT_MISMATCH", "The selected checkout belongs to a different canonical repository");
}

// src/shared/launch.js
var clone3 = (v) => JSON.parse(JSON.stringify(v));
var LaunchError = class extends Error {
  constructor(code, message, recovery) {
    super(message);
    this.code = code;
    this.recovery = recovery;
  }
};
var fail9 = (code, message, recovery) => {
  throw new LaunchError(code, message, recovery);
};
var text7 = (v, name2, max = 256) => {
  if (typeof v !== "string" || !v || v.length > max || ["__proto__", "constructor", "prototype"].includes(v) || /[\u0000-\u001f]/.test(v)) fail9("INVALID_LAUNCH", `Invalid ${name2}`);
  return v;
};
var now = (io) => io.clock ? io.clock() : Date.now();
var uuid2 = () => {
  const a = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
  a[6] = a[6] & 15 | 64;
  a[8] = a[8] & 63 | 128;
  return a.map((n, i) => ([4, 6, 8, 10].includes(i) ? "-" : "") + n.toString(16).padStart(2, "0")).join("");
};
function sourceIdentity2(source) {
  return source ? JSON.stringify([source.kind, source.connectionId, source.site, source.id]) : null;
}
function validateLaunchRequest(value) {
  if (!value || typeof value !== "object") fail9("INVALID_LAUNCH", "Missing launch request");
  const r = clone3(value);
  for (const f of ["requestId", "idempotencyKey", "originId", "spaceId", "toolKey"]) text7(r[f], f);
  if (!r.source && r.checkoutRoot === void 0) fail9("INVALID_LAUNCH", "Generic launches require the captured checkoutRoot");
  r.machine = machineIdentity(r.machine);
  r.repoRoot = canonicalRepoPath(r.repoRoot);
  r.checkoutRoot = canonicalRepoPath(r.checkoutRoot ?? r.repoRoot);
  if (typeof r.worktree !== "boolean") fail9("INVALID_LAUNCH", "Choose the current checkout or a new worktree");
  if (!r.worktree && (r.worktreePath !== void 0 || r.branch !== void 0)) fail9("INVALID_LAUNCH", "Path/branch overrides require a new worktree");
  if (r.worktreePath !== void 0) r.worktreePath = canonicalRepoPath(r.worktreePath);
  if (r.branch !== void 0) text7(r.branch, "branch", 200);
  if (r.source) {
    for (const f of ["kind", "connectionId", "site", "id", "key", "title", "url"]) text7(r.source[f], `source ${f}`, f === "title" ? 512 : 2048);
    if (!["jira", "github", "github-pr", "gitlab", "gitlab-mr"].includes(r.source.kind) || !/^https:\/\/[^\s/@?#]+\/?$/.test(r.source.site) || !/^https:\/\/[^\s@]+$/.test(r.source.url)) fail9("INVALID_LAUNCH", "Invalid source identity/URL/site");
    if (r.source.body !== void 0 && (typeof r.source.body !== "string" || r.source.body.length > 64e3)) fail9("INVALID_LAUNCH", "Source body exceeds the supported limit");
  }
  r.options = validateToolOptions(Object.fromEntries(["model", "reasoning", "instructions", "skill", "subagents"].filter((k) => r[k] !== void 0).map((k) => [k, r[k]])));
  return r;
}
var operationKey = (r) => JSON.stringify([r.machine, r.repoRoot, r.source ? "source" : "intent", ...r.source ? [sourceIdentity2(r.source), r.toolKey] : [r.idempotencyKey]]);
var sameIntent = (a, b) => ["requestId", "originId", "idempotencyKey", "spaceId", "machine", "repoRoot", "checkoutRoot", "toolKey", "worktree", "worktreePath", "branch"].every((k) => a[k] === b[k]) && sourceIdentity2(a.source) === sourceIdentity2(b.source) && JSON.stringify(a.options) === JSON.stringify(b.options);
var strip = (id, machine2) => machine2 && id.startsWith(machine2 + "/") ? id.slice(machine2.length + 1) : id;
var isConflict2 = (e) => ["STALE", "CONFLICT", "EAGAIN"].includes(e?.code) || /stale|contents?.*changed|expected.*match|compare.and.set/i.test(e?.message || "");
function validateJournal(d) {
  if (!d || d.v !== 1 || !Number.isSafeInteger(d.revision) || d.revision < 0 || !d.requests || Array.isArray(d.requests)) fail9("INVALID_JOURNAL", "Launch journal is invalid; original preserved");
  for (const [id, r] of Object.entries(d.requests)) {
    text7(id, "journal request ID");
    if (r.request.requestId !== id || !["creating", "worktree-ready", "tab-created", "binding-commit-pending", "complete", "failed", "recovery-required"].includes(r.state) || !Number.isFinite(r.createdAt) || !Number.isFinite(r.updatedAt) || !Number.isFinite(r.leaseUntil) || typeof r.owner !== "string") fail9("INVALID_JOURNAL", "Invalid launch journal entry");
    validateLaunchRequest(r.request);
    if (r.key !== operationKey(r.request)) fail9("INVALID_JOURNAL", "Launch journal key mismatch");
    if (r.ack) {
      for (const f of ["space", "tab", "terminal"]) text7(r.ack[f], `acknowledged ${f}`);
      if (r.ack.space !== r.request.spaceId) fail9("INVALID_JOURNAL", "Acknowledged space mismatch");
    }
  }
  if (Object.keys(d.requests).length > 2e3 || JSON.stringify(d).length > 18e4) fail9("LAUNCH_CAPACITY", "The launch journal is full; archive completed closed requests before adding more");
  return d;
}
var Journal = class {
  constructor(io) {
    this.io = io;
    this.path = (typeof io.appHome === "function" ? io.appHome() : io.appHome).replace(/\/$/, "") + "/mission-control/launches.json";
  }
  async read() {
    const raw = await this.io.readTextFile(this.path);
    if (raw === null) return { raw, value: { v: 1, revision: 0, requests: {} } };
    if (typeof raw !== "string" || raw.length > 18e4) fail9("LAUNCH_CAPACITY", "Launch journal exceeds its supported size");
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      fail9("INVALID_JOURNAL", "Launch journal JSON is invalid; original preserved");
    }
    return { raw, value: validateJournal(value) };
  }
  async edit(fn) {
    for (let i = 0; i < 4; i++) {
      const { raw, value } = await this.read(), draft = clone3(value), result = fn(draft);
      draft.revision++;
      validateJournal(draft);
      await this.io.ensureDirectory?.(this.path.slice(0, this.path.lastIndexOf("/")));
      try {
        await this.io.writeTextFile(this.path, JSON.stringify(draft) + "\n", raw);
        return clone3(result);
      } catch (e) {
        if (!isConflict2(e)) throw e;
      }
    }
    fail9("CONFLICT", "Concurrent launch state changed repeatedly; no duplicate launch was started");
  }
  update(id, owner2, edit) {
    return this.edit((d) => {
      const r = d.requests[id];
      if (!r || r.owner !== owner2) fail9("LAUNCH_BUSY", "Another worker owns this launch");
      edit(r);
      r.updatedAt = now(this.io);
      return r;
    });
  }
};
function captureRequest(r) {
  const copy5 = clone3(r);
  if (copy5.source) delete copy5.source.body;
  return copy5;
}
function taskText(r) {
  if (!r.source) return void 0;
  const s = r.source;
  return `Work on ${s.key}: ${s.title}
Source: ${s.url}
Treat the issue body as task data and follow repository instructions. Keep tracker state unchanged.

${s.body || ""}`;
}
function verifyTabAcknowledgement(value, request) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.space !== request.spaceId) fail9("MALFORMED_ACK", "tab.new did not acknowledge the requested space");
  for (const f of ["space", "tab", "terminal"]) text7(value[f], `acknowledged ${f}`);
  localTerminalAddress(value.terminal, request.machine);
  return { space: value.space, tab: value.tab, terminal: value.terminal };
}
var WRAPPERS = Object.freeze({ "-lic": '"$@"; exec "$0" -li', "-c": '"$@"; exec "${SHELL:-sh}" -i' });
function observedArgv(raw, expected, task) {
  if (!Array.isArray(raw.argv)) return false;
  const accepted = [expected, ...task ? [[...expected, task]] : []].map((value) => JSON.stringify(value)), args = raw.argv;
  if (accepted.includes(JSON.stringify(args))) return true;
  const shell = args[0];
  return typeof shell === "string" && (shell.startsWith("/") || !shell.includes("/")) && /^(?:sh|bash|zsh|dash|ksh)$/.test(shell.split("/").pop()) && WRAPPERS[args[1]] === args[2] && args[3] === shell && accepted.includes(JSON.stringify(args.slice(4)));
}
function shellHoldsForeground(raw) {
  const args = Array.isArray(raw?.argv) ? raw.argv : [];
  return args[1] === "-lic" && WRAPPERS["-lic"] === args[2] && Number.isSafeInteger(raw.pid) && raw.foreground?.pid === raw.pid;
}
async function inspect(io, r, ack) {
  const listing = await io.exec("herdr-app", ["ls"]);
  if (listing.code !== 0) fail9("ACK_UNVERIFIED", "Cannot inspect the acknowledged tab");
  let world;
  try {
    world = JSON.parse(listing.stdout);
  } catch {
    fail9("ACK_UNVERIFIED", "Invalid app-world response");
  }
  const space = world.spaces?.find((s) => s.id === r.spaceId && machineIdentity(s.machine) === r.machine), tab = space?.tabs?.find((t) => t.id === ack.tab);
  if (!tab) return { exists: false };
  if (!tab.terminals?.some((t) => t.terminal === ack.terminal)) fail9("ACK_UNVERIFIED", "The acknowledged terminal does not belong to that tab");
  const address = localTerminalAddress(ack.terminal, r.machine), result = await io.exec("hc", ["get", address, "--json"], { on: r.machine });
  if (result.code !== 0) fail9("ACK_UNVERIFIED", "Cannot read the acknowledged full terminal");
  let raw;
  try {
    raw = JSON.parse(result.stdout);
  } catch {
    fail9("ACK_UNVERIFIED", "Invalid full terminal response");
  }
  const identity = terminalIdentity(raw, r.machine);
  if (identity.address !== (r.machine ? r.machine + "/" + address : address) || raw.labels?.["herdr.space"] !== strip(r.spaceId, r.machine) || raw.labels?.["herdr.tab"] !== strip(ack.tab, r.machine)) fail9("ACK_UNVERIFIED", "Terminal generation/space/tab ownership does not match");
  return { exists: true, raw, identity, tab };
}
async function focus(io, r, ack) {
  io.run("space.select", { id: r.spaceId });
  io.run("tab.select", { id: ack.tab });
  io.run("pane.focus", { terminal: ack.terminal });
}
function createLaunchIO(herdr3) {
  const io = createConfigIO(herdr3);
  io.capabilities = new CapabilityRegistry(herdr3.exec);
  io.sessionSource = async (provider, machine2) => {
    const config = (await readConfig(io)).value;
    const sources = Object.values(config.usageSources).filter((s) => s?.v === 1 && s.enabled === true && s.provider === provider && machineIdentity(s.machine) === machineIdentity(machine2));
    if (sources.length !== 1) return null;
    const source = sources[0];
    text7(source.credentialScope, "credential scope");
    const providerRoot = canonicalRepoPath(source.providerRoot);
    if (providerRoot === "/" || !Array.isArray(source.roots) || !source.roots.length) return null;
    return { providerRoot, credentialScope: source.credentialScope };
  };
  return io;
}
async function launch(input, io) {
  let request, journal2, record, owned = false, owner2 = "op-" + uuid2();
  try {
    request = validateLaunchRequest(input);
    journal2 = new Journal(io);
    const space = io.spaces().find((s) => s.id === request.spaceId && machineIdentity(s.machine) === request.machine);
    if (!space) fail9("SPACE_UNAVAILABLE", "The captured destination space is no longer available on that machine");
    const tools = installedTools(await io.knownAgents({ on: request.machine })), tool = tools.find((t) => t.key === request.toolKey);
    if (!tool) fail9("TOOL_UNAVAILABLE", "The selected tool is not installed on the destination machine");
    const caps = io.capabilities ? await io.capabilities.get(tool, request.machine) : await new CapabilityRegistry(io.exec).get(tool, request.machine);
    buildArguments(caps, { options: request.options });
    const key3 = operationKey(request), clock = now(io);
    record = await journal2.edit((d) => {
      const byId = d.requests[request.requestId];
      if (byId && !sameIntent(byId.request, captureRequest(request))) fail9("RETRY_CHANGED", "A launch intent cannot change its captured options/destination");
      const old = byId || Object.values(d.requests).find((r2) => r2.key === key3);
      if (old) {
        if (old.ack) {
          old.owner = owner2;
          old.leaseUntil = clock + 3e4;
          return old;
        }
        if (old.state === "failed" && !old.tabAttempted) {
          old.owner = owner2;
          old.leaseUntil = clock + 3e4;
          old.state = old.worktreeSpec ? "worktree-ready" : "creating";
          return old;
        }
        fail9(old.leaseUntil > clock ? "LAUNCH_BUSY" : "RECOVERY_REQUIRED", old.leaseUntil > clock ? "This launch is already being created" : "An interrupted launch has uncertain side effects; inspect it before retrying");
      }
      const other = request.source && Object.values(d.requests).find((r2) => sourceIdentity2(r2.request.source) === sourceIdentity2(request.source) && r2.request.machine === request.machine && r2.request.repoRoot === request.repoRoot && r2.request.toolKey !== request.toolKey && r2.state !== "failed");
      if (other && !(request.worktree && request.worktreePath && request.branch)) fail9("ISSUE_TOOL_CONFLICT", "This issue already has work under another tool. Focus it or explicitly choose a separate worktree.", other.ack ? { tabId: other.ack.tab, terminalId: other.ack.terminal } : void 0);
      const created = { request: captureRequest(request), key: key3, owner: owner2, state: "creating", createdAt: clock, updatedAt: clock, leaseUntil: clock + 3e4, tabAttempted: false, sessionProposal: null };
      d.requests[request.requestId] = created;
      return created;
    });
    owned = true;
    const reused = Boolean(record.ack), r = record.request, id = r.requestId, bindings = new BindingStore(io, { clock: () => now(io) }), names = new NameOwnership(io, { clock: () => now(io), owner: owner2 });
    const destinationSpace = io.spaces().find((s) => s.id === r.spaceId && machineIdentity(s.machine) === r.machine);
    if (!destinationSpace) fail9("SPACE_UNAVAILABLE", "The original captured destination is unavailable");
    if (!record.ack) {
      let proposal = record.sessionProposal;
      if (!proposal && io.exactResumeSession) {
        proposal = sessionIdentity(io.exactResumeSession);
        if (proposal.provider !== caps.provider || proposal.machine !== r.machine) fail9("UNPROVEN_SESSION", "Resume identity does not match the installed provider and machine");
      }
      if (!proposal && caps.callerSession && io.sessionSource) {
        const source = await io.sessionSource(caps.provider, r.machine);
        if (source) proposal = sessionIdentity({ machine: r.machine, provider: caps.provider, credentialScope: source.credentialScope, providerRoot: source.providerRoot, sessionId: uuid2() });
      }
      const mode = io.exactResumeSession ? "resume-argv" : "caller-session-id";
      const argv = buildArguments(caps, { options: request.options, ...proposal ? mode === "resume-argv" ? { resumeSessionId: proposal.sessionId } : { newSessionId: proposal.sessionId } : {} });
      record = await journal2.update(id, owner2, (d) => {
        d.sessionProposal = proposal;
        d.proofKind = proposal ? mode : null;
      });
      await bindings.propose({ requestId: id, originId: r.originId, session: proposal });
      const spec = record.worktreeSpec || await prepareWorktree(r, { spaceName: destinationSpace.name, exec: io.exec });
      record = await journal2.update(id, owner2, (d) => {
        d.worktreeSpec = spec;
        d.state = "worktree-ready";
      });
      const tree = await ensureWorktree(r, spec, { exec: io.exec });
      record = await journal2.update(id, owner2, (d) => {
        d.folder = tree.folder;
        d.tabAttempted = true;
        d.initialName = r.source ? `${r.source.key} ${r.source.title}`.slice(0, 200) : tool.name || r.toolKey;
      });
      const args = { space: r.spaceId, folder: tree.folder, argv, name: record.initialName };
      const task = taskText(request);
      if (task) args.task = task;
      const response = await io.exec("herdr-app", ["do", "tab.new", JSON.stringify(args)]);
      if (response.code !== 0) fail9("TAB_CREATE_UNCERTAIN", "Herdr did not acknowledge tab creation; inspect the request before retrying");
      let rawAck;
      try {
        rawAck = JSON.parse(response.stdout);
      } catch {
        fail9("MALFORMED_ACK", "Herdr returned an invalid tab acknowledgment; no second launch will be attempted");
      }
      const ack = verifyTabAcknowledgement(rawAck, r);
      record = await journal2.update(id, owner2, (d) => {
        d.ack = ack;
        d.state = "tab-created";
      });
    }
    let actual = await inspect(io, r, record.ack);
    if (!actual.exists) fail9("PREVIOUS_SESSION_CLOSED", "The acknowledged tab is closed. Resume its exact session from history instead of launching a duplicate.");
    if (reused && record.state === "complete") {
      if (!record.terminal || record.terminal.createdMs !== actual.identity.createdMs || record.terminal.address !== actual.identity.address || record.terminal.machine !== actual.identity.machine) fail9("ACK_GENERATION_CHANGED", "The acknowledged terminal was replaced; inspect its saved session before retrying");
      await bindings.reconcile([actual.raw], { machine: r.machine });
      const committed = await bindings.readCommitted(actual.identity);
      await journal2.update(id, owner2, (d) => {
        d.leaseUntil = 0;
      });
      await focus(io, r, record.ack);
      return { ok: true, tabId: record.ack.tab, terminalId: record.ack.terminal, folder: record.folder, reused: true, originId: r.originId, session: committed?.session ?? null };
    }
    let proof = null;
    if (record.sessionProposal) {
      for (let attempt = 0; !actual.identity.foregroundPid && attempt < 10; attempt++) {
        if (io.delay) await io.delay(150);
        else await io.exec("sleep", ["0.15"]);
        actual = await inspect(io, r, record.ack);
        if (!actual.exists) break;
      }
      for (let attempt = 0; actual.exists && shellHoldsForeground(actual.raw) && attempt < 40; attempt++) {
        if (io.delay) await io.delay(150);
        else await io.exec("sleep", ["0.15"]);
        actual = await inspect(io, r, record.ack);
      }
      if (!actual.exists || !actual.identity.foregroundPid) fail9("BINDING_NOT_READY", "Agent started; exact foreground identity is still unavailable. Retry only its binding commit.", { tabId: record.ack.tab, terminalId: record.ack.terminal });
      const expected = buildArguments(caps, { options: r.options, ...record.proofKind === "resume-argv" ? { resumeSessionId: record.sessionProposal.sessionId } : { newSessionId: record.sessionProposal.sessionId } });
      if (!observedArgv(actual.raw, expected, taskText(request))) fail9("UNPROVEN_SESSION", "The acknowledged terminal does not have the captured exact launch command", { tabId: record.ack.tab, terminalId: record.ack.terminal });
      proof = argvSessionProof({ capabilities: caps, session: record.sessionProposal, terminal: actual.identity, argv: expected, kind: record.proofKind, observedAt: now(io), sourceDigest: requestDigest(JSON.stringify(expected)) });
    }
    record = await journal2.update(id, owner2, (d) => {
      d.terminal = actual.identity;
      d.state = "binding-commit-pending";
    });
    await bindings.commitAcknowledged(id, { tabId: record.ack.tab, terminal: actual.identity }, proof);
    const ownership = await names.transferToAcknowledgedTab({ originId: r.originId, ...record.sessionProposal ? { session: record.sessionProposal } : {} }, { machine: r.machine, tabId: record.ack.tab, name: record.initialName });
    if (ownership.mode === "manual") await names.applyName(r.originId, ownership.manualName, { manualTransfer: true, getTabs: () => io.spaces().flatMap((s) => s.tabs.map((t) => ({ ...t, machine: s.machine }))), rename: (args) => io.run("tab.rename", args) });
    record = await journal2.update(id, owner2, (d) => {
      d.state = "complete";
      d.leaseUntil = 0;
    });
    await focus(io, r, record.ack);
    return { ok: true, tabId: record.ack.tab, terminalId: record.ack.terminal, folder: record.folder, reused, originId: r.originId, session: record.sessionProposal };
  } catch (error2) {
    const code = error2.code || "LAUNCH_FAILED", message = error2 instanceof LaunchError || error2 instanceof ConfigError || error2.name === "WorktreeError" || error2.name === "CapabilityError" ? error2.message : "Launch could not complete; existing work was preserved.";
    if (owned && record && journal2) {
      try {
        await journal2.update(record.request.requestId, owner2, (d) => {
          d.state = d.ack ? "binding-commit-pending" : d.tabAttempted ? "recovery-required" : "failed";
          d.error = { code, message };
          if (!d.tabAttempted) d.leaseUntil = 0;
        });
      } catch {
      }
    }
    return { ok: false, code, message, ...error2.recovery ? { recovery: error2.recovery } : record?.ack ? { recovery: { tabId: record.ack.tab, terminalId: record.ack.terminal } } : {} };
  }
}

// src/shared/resume.js
var ResumeError = class extends Error {
  constructor(code, message, recovery) {
    super(message);
    this.name = "ResumeError";
    this.code = code;
    this.recovery = recovery;
  }
};
var fail10 = (code, message, recovery) => {
  throw new ResumeError(code, message, recovery);
};
var freeze = (v) => {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    for (const c of Object.values(v)) freeze(c);
    Object.freeze(v);
  }
  return v;
};
var text8 = (v, name2, max = 256) => {
  if (typeof v !== "string" || !v || v.length > max || ["__proto__", "constructor", "prototype"].includes(v) || /[\u0000-\u001f]/.test(v)) fail10("INVALID_RESUME", `Invalid ${name2}`);
  return v;
};
var now2 = (io) => io.clock ? io.clock() : Date.now();
var digest = (value) => {
  let a = 2166136261, b = 2654435769;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    a = Math.imul(a ^ c, 16777619);
    b = Math.imul(b ^ c, 2246822519);
  }
  return [a >>> 0, b >>> 0].map((n) => n.toString(16).padStart(8, "0")).join("");
};
var prefix = (session2) => "resume-" + digest(sessionKey(session2)) + "-";
var base = (v) => typeof v === "string" ? v.slice(v.lastIndexOf("/") + 1).toLowerCase() : null;
var within = (path, root) => path === root || path.startsWith(root.replace(/\/$/, "") + "/");
var strip2 = (id, on) => on && id.startsWith(on + "/") ? id.slice(on.length + 1) : id;
var qualify = (id, on) => typeof id === "string" && id ? on ? on + "/" + id : id : null;
var aliases = { claude: ["claude", "claude-code"], codex: ["codex"], grok: ["grok"] };
var UNCERTAIN_MS = 6e4;
var inFlight = (record, clock) => record.ack ? !["complete", "failed"].includes(record.state) && record.leaseUntil > clock : record.tabAttempted ? clock < record.updatedAt + UNCERTAIN_MS : record.state !== "failed" && record.leaseUntil > clock;
var actions = { HOST_UNAVAILABLE: ["retry"], SPACE_UNAVAILABLE: ["retry"], TOOL_UNAVAILABLE: ["retry"], TERMINAL_UNAVAILABLE: ["retry"], RESUME_IN_PROGRESS: ["retry"], PREVIOUS_SESSION_CLOSED: ["retry"], WORKTREE_MISSING: ["locate", "retry"], CHECKOUT_MISMATCH: ["locate", "retry"], AMBIGUOUS_RUNNING_SESSION: ["locate", "retry-binding", "close-existing-and-retry"], RECOVERY_REQUIRED: ["locate", "close-existing-and-retry"], MALFORMED_ACK: ["locate", "close-existing-and-retry"], TAB_CREATE_UNCERTAIN: ["locate", "close-existing-and-retry"] };
var known = (e) => e instanceof ResumeError || e instanceof LaunchError || e instanceof IdentityError || ["ConfigError", "WorktreeError", "CapabilityError"].includes(e?.name);
function failure(code, message, recovery) {
  const extra = recovery && typeof recovery === "object" ? recovery : {};
  return freeze({ ok: false, code, message, recovery: { actions: extra.tabId ? ["locate", "retry-binding"] : actions[code] || [], ...extra } });
}
function validateResumeRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail10("INVALID_RESUME", "Missing resume request");
  let session2, repoRoot, cwd;
  try {
    session2 = sessionIdentity(value.session);
    repoRoot = canonicalRepoPath(value.repoRoot);
    cwd = canonicalRepoPath(value.cwd);
  } catch (e) {
    fail10("INVALID_RESUME", e.message);
  }
  const r = { requestId: text8(value.requestId, "request ID"), spaceId: text8(value.spaceId, "space ID"), session: session2, machine: session2.machine, repoRoot, cwd, toolKey: text8(value.toolKey ?? session2.provider, "tool key", 96) };
  if (value.originId !== void 0) r.originId = text8(value.originId, "origin ID");
  if (value.title !== void 0) r.title = text8(value.title, "reported title", 200);
  return freeze(r);
}
function resumeSupport(capabilities, { provider, machine: machine2 } = {}) {
  const no = (reason) => freeze({ supported: false, kind: null, reason });
  if (!capabilities?.base || !capabilities.provider) return no("Exact resume is unsupported: the installed command was not verified by its own help output.");
  if (machine2 !== void 0 && capabilities.machine !== machineIdentity(machine2)) return no("Exact resume was verified on a different host than the one that owns this session.");
  if (provider !== void 0 && capabilities.provider !== provider) return no("The installed tool is not the provider that owns this session. Start a new session to switch tools.");
  if (!capabilities.resume) return no("This installed tool/version has no verified exact-session resume.");
  return freeze({ supported: true, kind: capabilities.resume.kind, reason: null });
}
async function journal(io) {
  const home = typeof io.appHome === "function" ? io.appHome() : io.appHome, raw = await io.readTextFile(home.replace(/\/$/, "") + "/mission-control/launches.json");
  if (raw === null) return {};
  let value = null;
  try {
    value = JSON.parse(raw);
  } catch {
  }
  if (value?.v !== 1 || !value.requests || typeof value.requests !== "object" || Array.isArray(value.requests)) fail10("INVALID_JOURNAL", "Launch journal is invalid; original preserved and nothing was started");
  return value.requests;
}
function attempts(requests, session2) {
  const p = prefix(session2), key3 = sessionKey(session2), found = [];
  for (const record of Object.values(requests)) {
    const id = record?.request?.idempotencyKey;
    if (typeof id !== "string" || !id.startsWith(p) || !/^(0|[1-9]\d{0,8})$/.test(id.slice(p.length))) continue;
    if (record.sessionProposal && sessionKey(record.sessionProposal) !== key3) fail10("RESUME_CONFLICT", "Saved resume state belongs to a different exact session; nothing was started");
    found.push({ epoch: Number(id.slice(p.length)), record });
  }
  return found.sort((a, b) => b.epoch - a.epoch);
}
async function full(io, address, on) {
  const local = localTerminalAddress(address, on);
  let result;
  try {
    result = await io.exec("hc", ["get", local, "--json"], { on });
  } catch {
    fail10("HOST_UNAVAILABLE", "The original host became unreachable while checking live terminals; nothing was started");
  }
  if (result?.code !== 0) return null;
  try {
    const raw = JSON.parse(result.stdout);
    if (localTerminalAddress(raw.address, on) !== local) throw Error("address");
    return { raw, identity: terminalIdentity(raw, on) };
  } catch {
    fail10("TERMINAL_UNAVAILABLE", "A live terminal returned invalid identity data; nothing was started");
  }
}
async function commonDir(io, cwd, on) {
  let r;
  try {
    r = await io.exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on });
  } catch {
    return void 0;
  }
  if (r.code !== 0) return null;
  try {
    return canonicalRepoPath(r.stdout.trim());
  } catch {
    return null;
  }
}
async function sameRepo(io, r, cwd, cache) {
  if (typeof cwd !== "string") return true;
  let path;
  try {
    path = canonicalRepoPath(cwd);
  } catch {
    return true;
  }
  if (within(path, r.repoRoot) || within(path, r.cwd)) return true;
  if (!cache.has(r.repoRoot)) cache.set(r.repoRoot, await commonDir(io, r.repoRoot, r.machine));
  const repo = cache.get(r.repoRoot), other = await commonDir(io, path, r.machine);
  return repo === void 0 || other === void 0 || other !== null && other === repo;
}
async function inspectHost(io, r, { tool, bindings, found, terminals: terminals2 }) {
  const on = r.machine, key3 = sessionKey(r.session);
  for (const [requestId, b] of Object.entries(bindings.proposals)) if (b.state === "committed" && b.session && sessionKey(b.session) === key3 && b.ack.terminal.machine === on) {
    const actual = await full(io, b.ack.terminal.address, on);
    if (actual && (actual.raw.state === void 0 || actual.raw.state === "live") && terminalKey(actual.identity) === terminalKey(b.ack.terminal)) return { exact: { requestId, originId: b.originId, tabId: b.ack.tabId, terminal: actual.identity } };
  }
  const names = /* @__PURE__ */ new Set([...aliases[r.session.provider.toLowerCase()] || [r.session.provider.toLowerCase()], ...tool ? [base(tool.run[0])] : []]), agents = /* @__PURE__ */ new Map(), pending = /* @__PURE__ */ new Map(), own = [], candidates = [], cache = /* @__PURE__ */ new Map();
  for (const a of io.agents?.() || []) {
    const space = io.spaces().find((s) => s.id === a.space);
    if (space && machineIdentity(space.machine) === on) try {
      agents.set(localTerminalAddress(a.address, on), a);
    } catch {
    }
  }
  for (const { record } of found) if (record.ack && !["complete", "failed"].includes(record.state)) try {
    pending.set(localTerminalAddress(record.ack.terminal, on), record);
  } catch {
  }
  for (const summary of terminals2) {
    let local, actual = null;
    try {
      local = localTerminalAddress(summary?.address, on);
    } catch {
      continue;
    }
    if (summary.state !== void 0 && summary.state !== "live") continue;
    try {
      if (Number.isSafeInteger(summary.created_ms) && summary.foreground !== void 0) actual = { raw: summary, identity: terminalIdentity(summary, on) };
    } catch {
    }
    actual = actual || await full(io, local, on);
    if (!actual) continue;
    const fg = actual.raw.foreground || {}, agent = agents.get(local), labels = actual.raw.labels || {};
    if (![fg.name, base(fg.argv?.[0]), base(fg.argv?.[1]), agent?.app, agent?.program?.key].some((v) => typeof v === "string" && names.has(v.toLowerCase()))) continue;
    const mine = pending.get(local);
    if (mine && labels["herdr.tab"] === strip2(mine.ack.tab, on)) {
      own.push(mine);
      continue;
    }
    const id = bindings.terminals[terminalKey(actual.identity)];
    if (id && bindings.proposals[id]?.session) continue;
    if (!await sameRepo(io, r, fg.cwd ?? actual.raw.cwd, cache)) continue;
    candidates.push({ machine: on, terminal: actual.identity.address, tabId: qualify(labels["herdr.tab"], on), spaceId: qualify(labels["herdr.space"], on) });
  }
  return { exact: null, own, candidates };
}
async function verifyCheckout(io, r) {
  try {
    await prepareWorktree({ requestId: r.requestId, originId: "resume-check", worktree: false, machine: r.machine, repoRoot: r.repoRoot, checkoutRoot: r.cwd }, { exec: io.exec });
  } catch (error2) {
    if (error2?.name === "WorktreeError") throw error2;
    fail10("WORKTREE_MISSING", "The original repository or working directory is missing on its host. Locate it, then retry; the saved session is unchanged.");
  }
}
function choose(r, found, own, requests, clock) {
  const p = prefix(r.session), byId = requests[r.requestId], busy = () => fail10("RESUME_IN_PROGRESS", "This exact session is already being resumed; wait for its acknowledgment.");
  if (byId) {
    if (typeof byId.request?.idempotencyKey !== "string" || !byId.request.idempotencyKey.startsWith(p)) fail10("RETRY_CHANGED", "This resume request ID already belongs to different work");
    return { key: byId.request.idempotencyKey, originId: byId.request.originId };
  }
  if (own.length) {
    if (own[0].leaseUntil > clock) busy();
    return { takeover: own[0].request };
  }
  const latest = found[0];
  if (!latest) return { key: p + "0" };
  if (!latest.record.ack && inFlight(latest.record, clock)) busy();
  return { key: p + (latest.epoch + 1) };
}
async function owner(names, r) {
  const exact = await names.find({ session: r.session });
  if (exact) return exact.originId;
  const given = r.originId ? await names.find({ originId: r.originId }) : null;
  return r.originId && !(given?.session && sessionKey(given.session) !== sessionKey(r.session)) ? r.originId : "session-" + digest(sessionKey(r.session));
}
async function resume(input, io) {
  try {
    const r = validateResumeRequest(input), on = r.machine, clock = now2(io);
    if (typeof io.machines === "function" && io.machines().find((m) => machineIdentity(m.name) === on)?.layout !== "ready") fail10("HOST_UNAVAILABLE", `${on ?? "This computer"} is offline or still loading; nothing was started.`);
    const space = io.spaces().find((s) => s.id === r.spaceId);
    if (!space) fail10("SPACE_UNAVAILABLE", "The destination space is no longer open; nothing was started.");
    if (machineIdentity(space.machine) !== on) fail10("WRONG_HOST", "This session belongs to another host and is only resumed on its original host.");
    let tools, requests, found, live;
    try {
      tools = installedTools(await io.knownAgents({ on }));
    } catch {
      fail10("HOST_UNAVAILABLE", "The original host could not report its installed tools; nothing was started.");
    }
    const tool = tools.find((t) => t.key === r.toolKey) || null;
    for (let pass = 0; pass < 2 && !live?.exact && (!live || live.candidates.length); pass++) {
      requests = await journal(io);
      found = attempts(requests, r.session);
      const bindings = (await new BindingStore(io, { clock: () => now2(io) }).read()).value;
      let listing = null, terminals2 = null;
      try {
        listing = await io.exec("hc", ["ls", "--json"], { on });
      } catch {
      }
      try {
        if (listing?.code === 0) terminals2 = JSON.parse(listing.stdout).terminals;
      } catch {
      }
      if (!Array.isArray(terminals2)) fail10("HOST_UNAVAILABLE", "The original host could not list its live terminals; nothing was started.");
      if (terminals2.length > 1e3) fail10("HOST_UNAVAILABLE", "The original host has too many live terminals to verify safely; nothing was started.");
      live = await inspectHost(io, r, { tool, bindings, found, terminals: terminals2 });
    }
    if (live.exact) {
      io.run("agent.focus", { terminal: live.exact.terminal.address });
      return freeze({ ok: true, action: "focus", tabId: live.exact.tabId, terminalId: live.exact.terminal.address, reused: true, originId: live.exact.originId, session: r.session });
    }
    if (live.candidates.length) {
      if (found.some(({ record }) => inFlight(record, clock))) fail10("RESUME_IN_PROGRESS", "This exact session is already being resumed; wait for its acknowledgment.");
      fail10("AMBIGUOUS_RUNNING_SESSION", `A running ${r.session.provider} terminal in this repository has no exact session binding. Locate it, retry its binding, or close it and retry; nothing was resumed.`, { candidates: live.candidates });
    }
    if (!tool) fail10("TOOL_UNAVAILABLE", "The session tool is not installed on its original host.");
    const caps = io.capabilities ? await io.capabilities.get(tool, on) : await new CapabilityRegistry(io.exec).get(tool, on), support = resumeSupport(caps, { provider: r.session.provider, machine: on });
    if (!support.supported) fail10("UNSUPPORTED_RESUME", support.reason);
    buildArguments(caps, { resumeSessionId: r.session.sessionId });
    if (typeof io.sessionSource === "function") {
      const source = await io.sessionSource(r.session.provider, on);
      if (source && (source.providerRoot !== r.session.providerRoot || source.credentialScope !== r.session.credentialScope)) fail10("ACCOUNT_MISMATCH", "This session belongs to a different provider profile than the one enabled on its host; nothing was started.");
    }
    await verifyCheckout(io, r);
    const choice = choose(r, found, live.own, requests, clock), names = new NameOwnership(io, { clock: () => now2(io) });
    const request = choice.takeover ? { ...choice.takeover } : { requestId: r.requestId, idempotencyKey: choice.key, originId: choice.originId || await owner(names, r), spaceId: r.spaceId, machine: on, repoRoot: r.repoRoot, checkoutRoot: r.cwd, toolKey: r.toolKey, worktree: false };
    const result = await launch(request, { ...io, exactResumeSession: r.session });
    if (!result.ok) return result.code === "LAUNCH_BUSY" ? failure("RESUME_IN_PROGRESS", "This exact session is already being resumed; wait for its acknowledgment.") : failure(result.code, result.message, result.recovery);
    if (!result.reused && r.title) try {
      await names.applyName(result.originId, r.title, { getTabs: () => io.spaces().flatMap((s) => s.tabs.map((t) => ({ ...t, machine: s.machine }))), rename: (args) => io.run("tab.rename", args) });
    } catch {
    }
    return freeze({ ok: true, action: result.reused ? "focus" : "resume", tabId: result.tabId, terminalId: result.terminalId, folder: result.folder, reused: result.reused, originId: result.originId, session: result.session });
  } catch (error2) {
    return failure(error2?.code || "RESUME_FAILED", known(error2) ? error2.message : "Resume could not complete; the saved session identity was preserved.", error2?.recovery);
  }
}

// src/shared/space-repo.js
var line = (value) => value.replace(/\r?\n$/, "");
function base2(space) {
  return { spaceId: space.id, machine: machineIdentity(space.machine) };
}
async function git(exec, cwd, on, args) {
  const r = await exec("git", ["-C", cwd, ...args], { on });
  return r.code === 0 ? r.stdout : null;
}
async function resolvePane(space, pane, exec) {
  const target = { ...base2(space), paneId: pane.pane, cwd: pane.cwd };
  try {
    const cwd = canonicalRepoPath(pane.cwd), top = await git(exec, cwd, target.machine, ["rev-parse", "--path-format=absolute", "--show-toplevel"]);
    if (top === null) return { ...target, state: "unbound", reason: "No Git repository at this live terminal folder." };
    const worktreeRoot = canonicalRepoPath(line(top)), common = await git(exec, worktreeRoot, target.machine, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (common === null) return { ...target, state: "error", reason: "The Git common directory is unavailable." };
    const gitCommonDir = canonicalRepoPath(line(common)), list = await git(exec, worktreeRoot, target.machine, ["worktree", "list", "--porcelain", "-z"]);
    if (list === null) return { ...target, state: "error", reason: "Cannot inspect the canonical Git worktree list." };
    const roots = list.split("\0").filter((v) => v.startsWith("worktree ")).map((v) => canonicalRepoPath(v.slice(9)));
    if (!roots.length || !roots.includes(worktreeRoot)) return { ...target, state: "error", reason: "The live checkout is absent from its own Git worktree list." };
    const repoRoot = roots[0], mainCommon = await git(exec, repoRoot, target.machine, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (mainCommon === null || canonicalRepoPath(line(mainCommon)) !== gitCommonDir) return { ...target, state: "error", reason: "Canonical repository/common-directory identity could not be verified." };
    return { ...target, state: "resolved", worktreeRoot, repoRoot, gitCommonDir, finderPath: target.machine === null ? worktreeRoot : null };
  } catch {
    return { ...target, state: "error", reason: "The selected machine, live folder or Git repository is unavailable." };
  }
}
var MOUNT_PROBE = 'import os,sys,json; p=sys.argv[1]; print(json.dumps({"valid":os.path.isabs(p) and p!="/" and os.path.isdir(p) and os.path.realpath(p)==p}))';
async function withMount(result, path, exec) {
  if (result.state !== "resolved" || result.machine === null || !path) return result;
  if (result.worktreeRoot !== result.repoRoot) return { ...result, finderReason: "This linked checkout has no configured local mount." };
  try {
    const local = canonicalRepoPath(path), probe = await exec("python3", ["-c", MOUNT_PROBE, local]);
    if (probe.code === 0 && JSON.parse(probe.stdout).valid === true) return { ...result, finderPath: local };
  } catch {
  }
  return { ...result, finderPath: null, finderReason: "The configured local mount is unavailable or is not a canonical directory." };
}
async function resolveSpaceRepo(space, panes2, exec, { mountedLocalPath = null } = {}) {
  if (!space?.id || typeof exec !== "function") return { state: "error", spaceId: space?.id ?? null, machine: space?.machine ?? null, reason: "Space or target-host execution is unavailable." };
  const tabs = new Set((space.tabs || []).map((t) => t.id));
  const eligible = panes2.filter((p) => p.terminal && p.cwd && tabs.has(p.tab));
  if (!eligible.length) return { ...base2(space), state: "unbound", reason: "This space has no live terminal folder. Open or focus a terminal first." };
  const focused2 = space.active === false ? [] : eligible.filter((p) => p.focused), chosen = focused2.length ? focused2 : eligible;
  const results = [];
  for (let start = 0; start < chosen.length; start += 4) results.push(...await Promise.all(chosen.slice(start, start + 4).map((p) => resolvePane(space, p, exec))));
  if (results.some((r) => r.state === "error")) return { ...base2(space), state: "error", reason: results.find((r) => r.state === "error").reason };
  const resolved = results.filter((r) => r.state === "resolved");
  if (!resolved.length) return { ...base2(space), state: "unbound", reason: "No live terminal in this space has a Git repository." };
  if (resolved.length !== results.length || new Set(resolved.map((r) => r.gitCommonDir)).size !== 1) return { ...base2(space), state: "ambiguous", candidates: results.map((r) => ({ paneId: r.paneId, cwd: r.cwd, repoRoot: r.repoRoot ?? null })), reason: "Focus a terminal to choose the repository for this space." };
  return withMount(resolved[0], mountedLocalPath, exec);
}

// src/mods/mission-control-sessions/model.js
var HISTORY_PAGE = 50;
var HISTORY_LIMIT = 1e3;
var STALE_LOAD_MS = 9e4;
var providerNames = Object.freeze({ claude: "Claude Code", codex: "Codex", grok: "Grok" });
var HistoryError = class extends Error {
  constructor(code, message) {
    super(message);
    this.name = "HistoryError";
    this.code = code;
  }
};
var fail11 = (code, message) => {
  throw new HistoryError(code, message);
};
var freeze2 = (v) => {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    for (const c of Object.values(v)) freeze2(c);
    Object.freeze(v);
  }
  return v;
};
var exactId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
var scopeFields = ["machine", "provider", "credentialScope", "providerRoot"];
var hostKey = (machine2) => JSON.stringify(machineIdentity(machine2));
var hostLabel = (machine2) => machine2 ?? "This Mac";
var repoKey = (machine2, repoRoot) => JSON.stringify([machineIdentity(machine2), repoRoot]);
var at = (machine2, path) => JSON.stringify([machine2, path]);
var parent = (path) => {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : path !== "/" && i === 0 ? "/" : null;
};
var publicMessage = (error2) => typeof error2?.code === "string" && typeof error2.message === "string" && error2.message.length <= 300 ? error2.message : "Session history is unavailable on this host.";
var rowDigest = (value) => {
  let a = 2166136261, b = 2654435769;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    a = Math.imul(a ^ c, 16777619);
    b = Math.imul(b ^ c, 2246822519);
  }
  return [a >>> 0, b >>> 0].map((n) => n.toString(16).padStart(8, "0")).join("");
};
var byActivity = (a, b) => (b.activityAt ?? -1) - (a.activityAt ?? -1) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
function historyRecord(value, source) {
  if (!validateProviderObservation(value).ok) return { ok: false, code: "MALFORMED" };
  if (value.state !== "available") return { ok: false, code: "UNREADABLE" };
  if (value.provenance.provider !== source.provider || scopeFields.some((k) => value.identity[k] !== source[k])) return { ok: false, code: "WRONG_SCOPE" };
  const identity = sessionIdentity(value.identity);
  return { ok: true, record: freeze2({ key: sessionKey(identity), identity, sourceId: source.id, title: value.title ?? null, cwd: value.cwd ?? null, activityAt: value.provenance.observedAt }) };
}
function mergeRecord(a, b) {
  if (!a) return b;
  if (a.key !== b.key) fail11("IDENTITY_CONFLICT", "Different exact sessions cannot merge.");
  const [newer, older] = byActivity(b, a) <= 0 ? [b, a] : [a, b];
  return freeze2({ ...newer, title: newer.title ?? older.title, cwd: newer.cwd ?? older.cwd, activityAt: newer.activityAt ?? older.activityAt });
}
function parseWorktrees(stdout) {
  if (typeof stdout !== "string" || stdout.length > 1048576) fail11("INVALID_WORKTREES", "The Git worktree list is unavailable.");
  const result = [];
  let current = null;
  for (const line2 of stdout.split("\0")) {
    if (line2.startsWith("worktree ")) {
      let path;
      try {
        path = canonicalRepoPath(line2.slice(9));
      } catch {
        fail11("INVALID_WORKTREES", "Git reported a non-canonical worktree path.");
      }
      current = { path, head: null, branch: null, detached: false, bare: false, missing: false };
      result.push(current);
      continue;
    }
    if (!line2) {
      current = null;
      continue;
    }
    if (!current) continue;
    if (line2.startsWith("HEAD ")) current.head = line2.slice(5);
    else if (line2.startsWith("branch ")) current.branch = line2.slice(7).replace(/^refs\/heads\//, "");
    else if (line2 === "detached") current.detached = true;
    else if (line2 === "bare") current.bare = true;
    else if (line2 === "prunable" || line2.startsWith("prunable ")) current.missing = true;
  }
  if (result.length > 1e3) fail11("INVALID_WORKTREES", "The repository lists too many worktrees.");
  return freeze2(result);
}
async function resolveRepoCheckouts(space, panes2, exec) {
  const resolved = await resolveSpaceRepo(space, panes2, exec), named = { spaceName: typeof space?.name === "string" ? space.name : null };
  if (resolved.state !== "resolved") return freeze2({ ...resolved, ...named });
  let worktrees = null;
  try {
    const r = await exec("git", ["-C", resolved.repoRoot, "worktree", "list", "--porcelain", "-z"], { on: resolved.machine });
    if (r?.code === 0) worktrees = parseWorktrees(r.stdout);
  } catch {
  }
  if (!worktrees?.length || worktrees[0].path !== resolved.repoRoot) return freeze2({ state: "error", spaceId: resolved.spaceId, machine: resolved.machine, reason: "The repository worktree list is unavailable on its host.", ...named });
  return freeze2({ ...resolved, ...named, worktrees });
}
function journalCheckouts(raw) {
  const result = /* @__PURE__ */ new Map();
  if (typeof raw !== "string" || raw.length > 18e4) return result;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return result;
  }
  if (value?.v !== 1 || !value.requests || typeof value.requests !== "object" || Array.isArray(value.requests)) return result;
  for (const record of Object.values(value.requests).slice(0, 2e3)) try {
    if (!record?.sessionProposal || !record.ack) continue;
    const session2 = sessionIdentity(record.sessionProposal), machine2 = machineIdentity(record.request.machine);
    if (session2.machine !== machine2) continue;
    const entry = { machine: machine2, repoRoot: canonicalRepoPath(record.request.repoRoot), checkoutRoot: canonicalRepoPath(record.folder ?? record.request.checkoutRoot ?? record.request.repoRoot), at: Number.isFinite(record.updatedAt) ? record.updatedAt : 0 }, key3 = sessionKey(session2), old = result.get(key3);
    if (!old || entry.at >= old.at) result.set(key3, freeze2(entry));
  } catch {
  }
  return result;
}
function membershipIndex(repos) {
  const roots = /* @__PURE__ */ new Map(), byRepo = /* @__PURE__ */ new Map();
  for (const repo of repos) {
    if (repo?.state !== "resolved" || !Array.isArray(repo.worktrees)) continue;
    const key3 = repoKey(repo.machine, repo.repoRoot);
    let entry = byRepo.get(key3);
    if (!entry) {
      entry = { key: key3, machine: repo.machine, repoRoot: repo.repoRoot, spaces: [] };
      byRepo.set(key3, entry);
      for (const worktree of repo.worktrees) if (!worktree.bare && !roots.has(at(repo.machine, worktree.path))) roots.set(at(repo.machine, worktree.path), { repoKey: key3, worktree });
    }
    if (!entry.spaces.some((s) => s.spaceId === repo.spaceId)) entry.spaces.push({ spaceId: repo.spaceId, spaceName: repo.spaceName, worktreeRoot: repo.worktreeRoot });
  }
  return { roots, byRepo };
}
function nearest(index2, machine2, cwd) {
  let path = cwd, hit = null;
  while (path && !(hit = index2.roots.get(at(machine2, path)))) path = parent(path);
  return hit;
}
function locateSession(index2, record, { journal: journal2, folders } = {}) {
  const machine2 = record.identity.machine;
  if (record.cwd) {
    const hit = nearest(index2, machine2, record.cwd);
    if (hit && hit.worktree.path === record.cwd) return { ...hit, missing: hit.worktree.missing, via: "checkout" };
    const folder = hit ? folders?.get(at(machine2, record.cwd)) : null;
    if (folder?.state === "present") {
      const own = folder.toplevel === hit.worktree.path ? hit : index2.roots.get(at(machine2, folder.toplevel));
      return own ? { ...own, missing: own.worktree.missing, via: "folder" } : null;
    }
  }
  const saved = journal2?.get(record.key), repo = saved && saved.machine === machine2 ? index2.byRepo.get(repoKey(machine2, saved.repoRoot)) : null;
  if (!repo) return null;
  const checkout = index2.roots.get(at(machine2, saved.checkoutRoot));
  return checkout?.repoKey === repo.key ? { ...checkout, missing: checkout.worktree.missing, via: "journal" } : { repoKey: repo.key, worktree: freeze2({ path: saved.checkoutRoot, head: null, branch: null, detached: false, bare: false, missing: true }), missing: true, via: "journal" };
}
function pendingFolders(index2, records, { repoKey: only } = {}) {
  const out = /* @__PURE__ */ new Map();
  for (const record of [...records].sort(byActivity)) {
    if (!record.cwd) continue;
    const machine2 = record.identity.machine, hit = nearest(index2, machine2, record.cwd);
    if (hit && hit.worktree.path !== record.cwd && (!only || hit.repoKey === only)) out.set(at(machine2, record.cwd), [machine2, record.cwd]);
  }
  return [...out.values()];
}
async function verifyFolders(exec, pending, cache, { limit = 64, isCurrent = () => true, clock = () => Date.now() } = {}) {
  const work = pending.filter(([machine2, path]) => {
    const c = cache.get(at(machine2, path));
    return !c || clock() - c.at > 3e5;
  }).slice(0, limit);
  for (let i = 0; i < work.length && isCurrent(); i += 4) await Promise.all(work.slice(i, i + 4).map(async ([machine2, path]) => {
    let r;
    try {
      r = await exec("git", ["-C", path, "rev-parse", "--path-format=absolute", "--show-toplevel"], { on: machine2 });
    } catch {
      return;
    }
    let value = { state: "missing", at: clock() };
    if (r?.code === 0) try {
      value = { state: "present", toplevel: canonicalRepoPath(r.stdout.trim()), at: clock() };
    } catch {
    }
    cache.delete(at(machine2, path));
    cache.set(at(machine2, path), freeze2(value));
    while (cache.size > 2e3) cache.delete(cache.keys().next().value);
  }));
  return cache;
}
async function runningSessions(io, { ready = () => true, isCurrent = () => true } = {}) {
  const { value } = await new BindingStore(io).read(), byHost = /* @__PURE__ */ new Map(), result = /* @__PURE__ */ new Map();
  for (const [requestId, r] of Object.entries(value.proposals)) {
    if (r.state !== "committed" || !r.session || !r.ack?.terminal) continue;
    const on = r.ack.terminal.machine;
    if (r.session.machine !== on || !ready(on)) continue;
    if (!byHost.has(hostKey(on))) byHost.set(hostKey(on), { machine: on, list: [] });
    byHost.get(hostKey(on)).list.push({ requestId, record: r });
  }
  for (const { machine: machine2, list } of byHost.values()) {
    if (!isCurrent()) break;
    let live = null;
    try {
      const r = await io.exec("hc", ["ls", "--json"], { on: machine2 });
      if (r.code === 0) live = JSON.parse(r.stdout).terminals;
    } catch {
    }
    if (!Array.isArray(live)) continue;
    const summaries = /* @__PURE__ */ new Map();
    for (const t of live.slice(0, 1e3)) try {
      if (t.state === void 0 || t.state === "live") summaries.set(localTerminalAddress(t.address, machine2), t);
    } catch {
    }
    for (const { requestId, record } of list.slice(0, 200)) {
      if (!isCurrent()) break;
      try {
        const local = localTerminalAddress(record.ack.terminal.address, machine2), summary = summaries.get(local);
        if (!summary) continue;
        let raw = summary;
        if (!Number.isSafeInteger(summary.created_ms) || summary.foreground === void 0) {
          const r = await io.exec("hc", ["get", local, "--json"], { on: machine2 });
          if (r.code !== 0) continue;
          raw = JSON.parse(r.stdout);
          if (localTerminalAddress(raw.address, machine2) !== local) continue;
        }
        const identity = terminalIdentity(raw, machine2);
        if (terminalKey(identity) === terminalKey(record.ack.terminal)) result.set(sessionKey(record.session), freeze2({ terminal: identity.address, tabId: record.ack.tabId, requestId }));
      } catch {
      }
    }
  }
  return result;
}
function sessionNames(value) {
  const names = /* @__PURE__ */ new Map();
  for (const r of Object.values(value?.origins || {})) try {
    if (r.session && r.mode === "manual" && typeof r.manualName === "string" && r.manualName) names.set(sessionKey(r.session), r.manualName.slice(0, 200));
  } catch {
  }
  return names;
}
function pickSpace(repo, checkout, active) {
  return repo.spaces.find((s) => s.worktreeRoot === checkout) || repo.spaces.find((s) => s.spaceId === active) || repo.spaces[0] || null;
}
function sessionRow(record, hit, { index: index2, scope, running, names, support, ready }) {
  const s = record.identity, machine2 = s.machine, host = hostLabel(machine2), repo = hit ? index2.byRepo.get(hit.repoKey) : null, checkout = hit?.worktree || null, provider = s.provider, providerName = providerNames[provider] || provider;
  const space = !repo ? null : scope.all ? pickSpace(repo, checkout?.path, scope.activeSpaceId) : { spaceId: scope.spaceId, spaceName: scope.spaceName }, live = running?.get(record.key) || null, manual = names?.get(record.key) || null, help = support?.get(JSON.stringify([machine2, provider]));
  let state = "ready", reason = null;
  if (!ready(machine2)) {
    state = "offline";
    reason = `${host} is offline or still connecting. Retry when it is ready.`;
  } else if (live) state = "running";
  else if (!space) {
    state = "unassigned";
    reason = `No open space on ${host} contains this folder. Open its repository in a space to resume.`;
  } else if (hit.missing) {
    state = "missing";
    reason = `This ${checkout.path === repo.repoRoot ? "checkout" : "worktree"} is missing on ${host}. Locate or restore it, then retry.`;
  } else if (!exactId.test(s.sessionId)) {
    state = "unsupported";
    reason = "This history has no exact resumable session ID.";
  } else if (help?.supported === false) {
    state = "unsupported";
    reason = help.reason;
  }
  const folder = (checkout?.path || record.cwd || "").split("/").filter(Boolean).at(-1) || null, branch = checkout?.branch ?? (checkout?.detached ? "detached" : null), title = manual || record.title || "Untitled · " + s.sessionId.slice(0, 8);
  return {
    key: record.key,
    id: "session-" + rowDigest(record.key),
    identity: s,
    provider,
    providerName,
    machine: machine2,
    host,
    title,
    titleKind: manual ? "manual" : record.title ? "reported" : "untitled",
    reportedTitle: record.title,
    activityAt: record.activityAt,
    cwd: record.cwd,
    checkoutRoot: checkout?.path ?? null,
    repoRoot: repo?.repoRoot ?? null,
    branch,
    linked: Boolean(checkout && repo && checkout.path !== repo.repoRoot),
    folder,
    spaceId: space?.spaceId ?? null,
    spaceName: space?.spaceName ?? null,
    state,
    reason,
    running: live,
    search: [title, record.title, providerName, branch, folder, record.cwd, host, space?.spaceName, s.sessionId].filter(Boolean).join(" ").toLowerCase()
  };
}
async function deriveSessions({ records, index: index2, scope, journal: journal2, folders, running, names, support, ready = () => true }, { pause = async () => {
} } = {}) {
  const rows = [];
  let n = 0;
  for (const record of records) {
    if (++n % 250 === 0) await pause();
    const hit = locateSession(index2, record, { journal: journal2, folders });
    if (!scope.all && (!scope.repoKey || hit?.repoKey !== scope.repoKey)) continue;
    rows.push(sessionRow(record, hit, { index: index2, scope, running, names, support, ready }));
  }
  rows.sort(byActivity);
  await pause();
  return freeze2({ rows: rows.slice(0, HISTORY_LIMIT), total: rows.length, truncated: rows.length > HISTORY_LIMIT });
}
function filterSessions(view, { query = "", tool = "all", session: session2 = null } = {}) {
  const needle = query.trim().toLowerCase(), searched = view.rows.filter((r) => (!session2 || r.key === session2) && (!needle || r.search.includes(needle))), counts = { all: searched.length };
  for (const r of searched) counts[r.provider] = (counts[r.provider] || 0) + 1;
  return { rows: tool === "all" ? searched : searched.filter((r) => r.provider === tool), counts };
}
var SessionHistory = class {
  constructor(createBridge, { clock = () => Date.now() } = {}) {
    if (typeof createBridge !== "function") fail11("INVALID_TRANSPORT", "The shared telemetry transport is required.");
    Object.assign(this, { createBridge, clock, bridge: createBridge(), entries: /* @__PURE__ */ new Map(), closed: false, revision: 0 });
  }
  async refreshSources() {
    const bridge = this.bridge, enabled = await bridge.sources.refresh();
    if (!this.closed && bridge === this.bridge) this.reconcile(enabled);
    return this.list();
  }
  /** Disabled or changed sources clear their rows immediately; nothing old-scope stays visible. */
  reconcile(enabled) {
    const next = /* @__PURE__ */ new Map();
    for (const source of enabled) try {
      next.set(source.id, { source, fingerprint: usageSourceFingerprint(source) });
    } catch {
    }
    for (const [id, entry] of this.entries) if (next.get(id)?.fingerprint !== entry.fingerprint) {
      this.entries.delete(id);
      this.revision++;
    }
    for (const [id, { source, fingerprint: fingerprint2 }] of next) if (!this.entries.has(id)) {
      this.entries.set(id, { id, source: freeze2({ ...source }), fingerprint: fingerprint2, records: /* @__PURE__ */ new Map(), unreadable: /* @__PURE__ */ new Set(), malformed: 0, cursor: null, pages: 0, done: false, capped: false, indexTruncated: false, error: null, fetchedAt: null, pending: null, pendingAt: 0 });
      this.revision++;
    }
  }
  list() {
    return [...this.entries.values()];
  }
  on(machines2) {
    const keys2 = new Set(machines2.map(hostKey));
    return this.list().filter((e) => keys2.has(hostKey(e.source.machine))).map((e) => e.id);
  }
  records(ids) {
    const out = [];
    for (const id of ids) {
      const e = this.entries.get(id);
      if (e) for (const r of e.records.values()) out.push(r);
    }
    return out;
  }
  stale(entry) {
    return Boolean(entry.pending) && this.clock() - entry.pendingAt >= STALE_LOAD_MS;
  }
  hasAbandonedLoad() {
    return !this.closed && this.list().some((e) => this.stale(e));
  }
  /** A task the host ended can leave the old transport's host queue waiting forever. */
  recover() {
    if (this.closed) return;
    for (const e of this.entries.values()) e.pending = null;
    try {
      this.bridge.close();
    } catch {
    }
    this.bridge = this.createBridge();
    this.revision++;
  }
  status(ids) {
    const entries = ids.map((id) => this.entries.get(id)).filter(Boolean), times = entries.map((e) => e.fetchedAt).filter(Number.isFinite);
    return freeze2({
      sources: entries.length,
      loading: entries.some((e) => e.pending && !this.stale(e)),
      fetchedAt: times.length ? Math.min(...times) : null,
      more: entries.some((e) => !e.done && !e.capped),
      truncated: entries.some((e) => e.capped || e.indexTruncated),
      unreadable: entries.reduce((n, e) => n + e.unreadable.size + e.malformed, 0),
      errors: entries.filter((e) => e.error).map((e) => ({ sourceId: e.id, provider: e.source.provider, machine: e.source.machine, code: e.error.code, message: e.error.message, at: e.error.at }))
    });
  }
  /** One in-flight read per source; pages stop once the scope has enough rows or the source is exhausted. */
  async scan(ids, { more = false, pages = 6, want = Infinity, isMember = () => true, isCurrent = () => true, pause = async () => {
  } } = {}) {
    const entries = ids.map((id) => this.entries.get(id)).filter(Boolean), state = { members: 0 };
    for (const e of entries) for (const r of e.records.values()) if (isMember(r)) state.members++;
    await Promise.all(entries.map((entry) => this.scanEntry(entry, { more, pages, want, isMember, isCurrent, pause, state })));
    return this.status(ids);
  }
  async scanEntry(entry, options) {
    const previous = entry.pending && !this.stale(entry) ? entry.pending : null;
    if (previous) {
      await previous;
      if (!options.more) return;
    }
    if (this.closed || this.entries.get(entry.id) !== entry) return;
    const pending = this.readPages(entry, options);
    entry.pending = pending;
    entry.pendingAt = this.clock();
    try {
      await pending;
    } finally {
      if (entry.pending === pending) entry.pending = null;
    }
  }
  async readPages(entry, { more, pages, want, isMember, isCurrent, pause, state }) {
    const bridge = this.bridge, current = () => !this.closed && bridge === this.bridge && this.entries.get(entry.id) === entry && isCurrent();
    if (more && (entry.done || entry.capped)) return;
    let cursor = more ? entry.cursor : null, read = more ? entry.pages : 0, budget = pages, restarted = false;
    for (let page = 0; page < budget; page++) {
      if (!current()) return;
      let response;
      try {
        response = await bridge.historyPage(entry.id, cursor ? { cursor } : {});
      } catch (error2) {
        if (!current()) return;
        if (cursor && !restarted) {
          restarted = true;
          budget = read + pages;
          read = 0;
          cursor = null;
          page = -1;
          continue;
        }
        entry.error = freeze2({ code: typeof error2?.code === "string" ? error2.code : "HISTORY_UNAVAILABLE", message: publicMessage(error2), at: this.clock() });
        this.revision++;
        return;
      }
      if (!current()) return;
      read++;
      this.accept(entry, response, { isMember, state });
      cursor = response.cursor;
      if (more || restarted || read >= entry.pages) {
        entry.cursor = cursor;
        entry.pages = read;
        entry.done = !cursor;
      }
      entry.indexTruncated = Boolean(response.scan?.indexLimitReached);
      entry.error = null;
      entry.fetchedAt = this.clock();
      this.revision++;
      if (!cursor || entry.capped || state.members >= want) return;
      await pause();
    }
  }
  accept(entry, response, { isMember, state }) {
    for (const value of response.data) {
      let checked;
      try {
        checked = historyRecord(value, entry.source);
      } catch {
        checked = { ok: false, code: "MALFORMED" };
      }
      if (!checked.ok) {
        if (checked.code === "UNREADABLE") {
          if (entry.unreadable.size < HISTORY_LIMIT) entry.unreadable.add(value.provenance.sourceDigest);
        } else entry.malformed++;
        continue;
      }
      const record = checked.record, old = entry.records.get(record.key);
      if (!old && entry.records.size >= HISTORY_LIMIT) {
        entry.capped = true;
        let oldest = null;
        for (const r of entry.records.values()) if (!oldest || byActivity(r, oldest) > 0) oldest = r;
        if (byActivity(record, oldest) >= 0) continue;
        entry.records.delete(oldest.key);
      }
      entry.records.set(record.key, mergeRecord(old, record));
      if (!old && isMember(record)) state.members++;
    }
  }
  close() {
    this.closed = true;
    try {
      this.bridge.close();
    } catch {
    }
    this.entries.clear();
  }
};

// src/shared/ui.js
import { div, svg, image } from "gpui-kit";
import { h_flex, v_flex, Input, InputState } from "gpui-base";
import { theme } from "herdr";
var palette = { chrome: "#101114", surface: "#17191d", border: "#2a2d33", foreground: "#e5e7eb", muted: "#91969f", dim: "#6b7079", accent: "#89b4fa", selected: "#253044" };
var colors = () => ({ ...palette, ...theme() });
var key2 = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function asset(mod, name2) {
  if (!key2.test(mod) || !key2.test(name2)) throw Error("Invalid local artwork identity");
  return `mods/${mod}/assets/${name2}.svg`;
}
var icon = (mod, name2, size = 15) => svg(asset(mod, name2)).size(size).flex_none();
function safeArtworkPath(value) {
  return typeof value === "string" && /^(icons|mods)\/[A-Za-z0-9_./-]+$/.test(value) && !value.split("/").some((v) => v === "." || v === "..") && !value.includes("//") ? value : null;
}
function toolIcon(mod, program, size = 16) {
  const path = safeArtworkPath(program?.icon);
  const el = path ? program.tint ? svg(path) : image(path) : icon(mod, "agent", size);
  return div().id("tool-icon-" + (program?.key || "agent")).size(size).flex_none().text_color(program?.color || colors().muted).tooltip(program?.name || "Agent").accessibility_label(program?.name || "Agent").child(el.size(size).flex_none());
}
function iconButton(mod, id, name2, label2, action, { active = false, disabled = false, size = 28 } = {}) {
  const t = colors();
  let el = div().id(id).size(size).flex_none().flex().items_center().justify_center().rounded(5).text_color(disabled ? t.dim : active ? t.accent : t.muted).bg(active ? t.selected : "#00000000").tooltip(label2).accessibility_label(label2).role("button").on_mouse_down("left", (_e, cx) => cx.stop_propagation());
  if (!disabled) el = el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((e, cx) => {
    cx.stop_propagation();
    return action(e, cx);
  });
  return el.child(icon(mod, name2, 15));
}
var label = (value, { muted = false, size = 12 } = {}) => div().text_size(size).text_color(muted ? colors().muted : colors().foreground).truncate().child(value);
function createSearch(placeholder, onChange) {
  const state = InputState.new({ placeholder });
  state.on("change", (_e, cx) => {
    onChange(state.value(), cx);
    cx.notify();
  });
  return state;
}
function searchInput(mod, id, state) {
  const t = colors();
  return h_flex().id(id).h(30).gap(6).px(8).rounded(5).border(1).border_color(t.border).bg(t.chrome).items_center().child(icon(mod, "search", 13).text_color(t.dim)).child(Input.new(state).flex_1().text_size(12).text_color(t.foreground));
}

// src/mods/mission-control-sessions/main.js
var MOD = "mission-control-sessions";
var STATE = "mission-control-sessions-ui-v1";
var PROVIDERS = ["claude", "codex", "grok"];
var copy4 = (value) => JSON.parse(JSON.stringify(value));
var hostKey2 = (machine2) => JSON.stringify(machine2 ?? null);
var freeze3 = (v) => {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    for (const c of Object.values(v)) freeze3(c);
    Object.freeze(v);
  }
  return v;
};
var retained = (result) => Boolean(result.recovery?.tabId) || ["TAB_CREATE_UNCERTAIN", "MALFORMED_ACK", "RECOVERY_REQUIRED", "BINDING_NOT_READY", "UNPROVEN_SESSION"].includes(result.code);
function uiState() {
  const s = herdr2.shared(STATE);
  return { all: s?.v === 1 && s.all === true, query: typeof s?.query === "string" && s.query.length <= 200 ? s.query : "", tool: PROVIDERS.includes(s?.tool) ? s.tool : "all" };
}
function sessionAge(at2, now3, { suffix = false } = {}) {
  if (!Number.isFinite(at2)) return "";
  const m = Math.max(0, Math.floor((now3 - at2) / 6e4)), value = m < 1 ? "" : m < 60 ? m + "m" : m < 1440 ? Math.floor(m / 60) + "h" : m < 10080 ? Math.floor(m / 1440) + "d" : null;
  return value === null ? new Date(at2).toISOString().slice(0, 10) : value === "" ? "just now" : value + (suffix ? " ago" : "");
}
function pill(id, content, action, { active = false, disabled = false, hint = typeof content === "string" ? content : "" } = {}) {
  const t = colors();
  let el = h_flex2().id(id).h(24).px(7).gap(5).flex_none().items_center().rounded(4).text_size(11).text_color(disabled ? t.dim : active ? t.accent : t.muted).bg(active ? t.selected : "#00000000").tooltip(hint).accessibility_label(hint).role("button");
  if (!disabled) el = el.cursor_pointer().hover((s) => s.bg(t.hover)).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => {
    cx.stop_propagation();
    return action(cx);
  });
  for (const part of Array.isArray(content) ? content : [content]) el = el.child(part);
  return el;
}
var MissionControlSessions = class extends View {
  init(_props, cx) {
    this.props = herdr2.props() || {};
    this.closed = false;
    this.jobs = [];
    this.timers = [];
    this.inputs = [];
    this.instance = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    this.io = createLaunchIO(herdr2);
    this.history = new SessionHistory(() => new TelemetryBridge(MOD, herdr2));
    this.names = new NameOwnership(this.io, { owner: MOD + "-" + this.instance });
    Object.assign(this, { originPanes: /* @__PURE__ */ new Map(), repoCache: /* @__PURE__ */ new Map(), folders: /* @__PURE__ */ new Map(), support: /* @__PURE__ */ new Map(), programs: /* @__PURE__ */ new Map(), resuming: /* @__PURE__ */ new Map(), intents: /* @__PURE__ */ new Map(), outcomes: /* @__PURE__ */ new Map(), epoch: 0, page: 0, view: null, scope: null, status: null, basis: null, error: null, info: null, loading: null, memo: null, showSources: false, leased: false, observedKey: null, observing: 0, observeRetryAt: 0, runningAt: 0 });
    let pinned = null;
    try {
      if (this.props.session) pinned = sessionKey(this.props.session);
    } catch {
    }
    this.pinned = pinned;
    const saved = uiState(), explicit = Boolean(this.props.target?.spaceId || this.props.spaceId);
    this.all = this.props.scope === "all" || this.props.scope !== "space" && !explicit && saved.all;
    this.query = saved.query;
    this.tool = saved.tool;
    this.search = createSearch("Search sessions", (value) => {
      this.query = value.slice(0, 200);
      this.page = 0;
      this.saveUI();
    });
    this.search.set_value(this.query);
    this.inputs.push(this.search);
    this.sync(cx, { force: true });
    this.spawn(cx, async (taskCx) => {
      await this.history.bridge.initializeSources();
      if (!this.closed) this.sync(taskCx, { force: true });
    });
    this.timers.push(cx.timer.every(6e4, (eventCx) => this.sync(eventCx, { force: true })));
    this.timers.push(cx.timer.every(5e3, (eventCx) => this.recover(eventCx)));
    this.timers.push(cx.timer.every(2e3, (eventCx) => this.observeNames(eventCx)));
    this.commandTask = cx.spawn(async (eventCx) => {
      while (!this.closed) {
        const command = await herdr2.nextCommand();
        if (this.closed) return;
        if (command === "refresh") this.refresh(eventCx);
        else if (command === "all-spaces") this.setScope(true, eventCx);
        else if (command === "this-space") this.setScope(false, eventCx);
        else if (command === "older") this.older(eventCx);
        eventCx.notify();
      }
    });
  }
  spawn(cx, work) {
    this.jobs = this.jobs.filter((job2) => !job2?.is_done?.());
    const job = cx.spawn(async (taskCx) => {
      try {
        await work(taskCx);
      } catch (error2) {
        if (!this.closed) this.error = typeof error2?.code === "string" && typeof error2.message === "string" && error2.message.length <= 300 ? error2.message : "Session history could not be loaded. Retry.";
      }
      if (!this.closed) taskCx.notify();
    });
    this.jobs.push(job);
    return job;
  }
  ready(machine2) {
    return herdr2.machines().some((m) => (m.name ?? null) === (machine2 ?? null) && m.layout === "ready");
  }
  /** One host snapshot per pass; per-record native reads would grow with history size. */
  readiness() {
    const hosts = new Map(herdr2.machines().map((m) => [m.name ?? null, m.layout === "ready"]));
    return (machine2) => hosts.get(machine2 ?? null) === true;
  }
  isLoading() {
    return Boolean(this.loading) && Date.now() - this.loading.at < STALE_LOAD_MS;
  }
  busy(key3) {
    const held = this.resuming.get(key3);
    return Boolean(held) && Date.now() - held.at < STALE_LOAD_MS;
  }
  saveUI() {
    herdr2.setShared(STATE, { v: 1, all: this.all, query: this.query, tool: this.tool });
  }
  remember(map, key3, value, limit) {
    map.delete(key3);
    map.set(key3, value);
    while (map.size > limit) map.delete(map.keys().next().value);
  }
  world() {
    const spaces2 = herdr2.spaces(), focused2 = herdr2.focused(), panes2 = herdr2.panes(), owners = /* @__PURE__ */ new Map();
    for (const space of spaces2) for (const tab of space.tabs || []) owners.set(tab.id, space.id);
    for (const pane of panes2) if (pane.terminal && (pane.focused || pane.pane === focused2?.pane) && owners.has(pane.tab)) this.originPanes.set(owners.get(pane.tab), pane.pane);
    const target = this.props.target || {}, wanted = target.spaceId || this.props.spaceId || focused2?.space, expected = Object.hasOwn(target, "machine") ? target.machine : Object.hasOwn(this.props, "machine") ? this.props.machine : void 0;
    return { spaces: spaces2, panes: panes2, space: spaces2.find((s) => s.id === wanted && (expected === void 0 || (s.machine ?? null) === (expected ?? null))) || null };
  }
  /** Capture scope and panes before any await; later focus never redirects a running load. */
  sync(cx, { force = false, more = false } = {}) {
    if (this.closed) return;
    const world = this.world(), space = world.space, scopeId = this.all ? "all" : JSON.stringify([space?.id ?? null, space?.machine ?? null]);
    const origin = space ? this.originPanes.get(space.id) : null, eligible = space ? world.panes.filter((p) => p.terminal && p.cwd && space.tabs.some((t) => t.id === p.tab)) : [], chosen = eligible.some((p) => p.pane === origin) ? eligible.filter((p) => p.pane === origin) : eligible;
    const key3 = JSON.stringify([scopeId, space?.name ?? null, this.all ? world.spaces.map((s) => [s.id, s.machine ?? null, s.name]) : chosen.map((p) => [p.pane, p.cwd]), herdr2.machines().map((m) => [m.name, m.layout])]);
    if (!force && !more && key3 === this.contextKey) return;
    if (scopeId !== this.scopeId) {
      this.scopeId = scopeId;
      this.view = null;
      this.status = null;
      this.basis = null;
      this.memo = null;
      this.page = 0;
      this.loadedScope = null;
    }
    this.contextKey = key3;
    this.scopeName = this.all ? null : space?.name ?? null;
    const epoch = ++this.epoch, mode = more ? "more" : this.loadedScope === scopeId ? "refresh" : "initial", snapshot = copy4({ spaces: world.spaces, panes: world.panes, space, chosen });
    this.loading = { epoch, at: Date.now() };
    if (force) this.error = null;
    return this.spawn(cx, async (taskCx) => {
      try {
        await this.load(taskCx, { epoch, mode, scopeId, all: this.all, ...snapshot });
      } finally {
        if (this.loading?.epoch === epoch) this.loading = null;
      }
    });
  }
  async load(taskCx, { epoch, mode, scopeId, all, spaces: spaces2, panes: panes2, space, chosen }) {
    const current = () => !this.closed && epoch === this.epoch, ready = (machine2) => this.ready(machine2);
    await this.history.refreshSources();
    if (!current()) return;
    let repos = [], scope;
    if (all) {
      repos = await this.resolveAll(spaces2, panes2, current);
      scope = { all: true, activeSpaceId: herdr2.focused()?.space ?? null };
    } else if (space) {
      const repo = await this.resolveSpace(space, chosen);
      repos = [repo];
      scope = { all: false, spaceId: space.id, spaceName: space.name, machine: space.machine ?? null, repo, repoKey: repo.state === "resolved" ? repoKey(repo.machine, repo.repoRoot) : null };
    } else scope = { all: false, spaceId: null, spaceName: null, machine: null, repo: null, repoKey: null };
    if (!current()) return;
    const index2 = membershipIndex(repos), machines2 = all ? herdr2.machines().map((m) => m.name ?? null) : space ? [space.machine ?? null] : [], ids = this.history.on(machines2);
    let journal2 = /* @__PURE__ */ new Map();
    try {
      journal2 = journalCheckouts(await this.io.readTextFile(this.io.appHome().replace(/\/$/, "") + "/mission-control/launches.json"));
    } catch {
    }
    if (!current()) return;
    const folders = this.folders, isMember = all ? () => true : (record) => locateSession(index2, record, { journal: journal2, folders })?.repoKey === scope.repoKey;
    if (all || scope.repoKey) {
      const pages = mode === "refresh" || all && mode === "initial" ? 1 : 6, want = mode === "more" ? this.filtered().rows.length + HISTORY_PAGE : HISTORY_PAGE * (this.page + 1);
      await this.history.scan(this.history.on(machines2.filter(ready)), { more: mode === "more", pages, want, isMember, isCurrent: current, pause: () => taskCx.sleep(0) });
      if (!current()) return;
    }
    const records = this.history.records(ids);
    await verifyFolders(this.io.exec, pendingFolders(index2, records, { repoKey: all ? void 0 : scope.repoKey }), folders, { isCurrent: current });
    if (!current()) return;
    let running = /* @__PURE__ */ new Map();
    try {
      running = await runningSessions(this.io, { ready, isCurrent: current });
    } catch {
    }
    if (!current()) return;
    await this.probeSupport(records, current);
    if (!current()) return;
    this.basis = { scope, index: index2, records, journal: journal2, running, ids };
    await this.derive(taskCx);
    if (current() && mode !== "more") this.loadedScope = scopeId;
  }
  async derive(taskCx) {
    const basis = this.basis;
    if (!basis) return;
    let names = /* @__PURE__ */ new Map();
    try {
      names = sessionNames((await this.names.read()).value);
    } catch {
    }
    if (this.closed || this.basis !== basis) return;
    const view = await deriveSessions({ records: basis.records, index: basis.index, scope: basis.scope, journal: basis.journal, folders: this.folders, running: basis.running, names, support: this.support, ready: this.readiness() }, { pause: () => taskCx.sleep(0) });
    if (this.closed || this.basis !== basis) return;
    this.view = view;
    this.scope = basis.scope;
    this.status = this.history.status(basis.ids);
    this.memo = null;
  }
  async resolveSpace(space, panes2) {
    const key3 = JSON.stringify([space.id, space.machine ?? null]), cached = this.repoCache.get(key3);
    if (!this.ready(space.machine)) return cached?.repo || freeze3({ state: "offline", spaceId: space.id, machine: space.machine ?? null, spaceName: space.name, reason: hostLabel(space.machine ?? null) + " is offline or still connecting." });
    const repo = await resolveRepoCheckouts(space, panes2, this.io.exec);
    this.remember(this.repoCache, key3, { repo, stamp: null, at: Date.now() }, 500);
    return repo;
  }
  /** Bounded to four spaces at a time; each space's repository comes from its own focused or first terminal.
   *  Unchanged terminals reuse their resolution for five minutes; Refresh resolves every space again. */
  async resolveAll(spaces2, panes2, current) {
    const work = spaces2.map((space) => async () => {
      const eligible = panes2.filter((p) => p.terminal && p.cwd && space.tabs.some((t) => t.id === p.tab)), pane = eligible.find((p) => p.pane === this.originPanes.get(space.id)) || eligible[0] || null;
      const key3 = JSON.stringify([space.id, space.machine ?? null]), stamp = JSON.stringify([pane?.pane ?? null, pane?.cwd ?? null]), cached = this.repoCache.get(key3);
      if (cached && (!this.ready(space.machine) || cached.stamp === stamp && Date.now() - cached.at < 3e5)) return { ...cached.repo, spaceName: space.name };
      if (!this.ready(space.machine)) return null;
      const repo = await resolveRepoCheckouts({ ...space, active: false }, pane ? [pane] : [], this.io.exec);
      this.remember(this.repoCache, key3, { repo, stamp, at: Date.now() }, 500);
      return repo;
    }), out = [];
    for (let i = 0; i < work.length && current(); i += 4) out.push(...await Promise.all(work.slice(i, i + 4).map((run2) => run2())));
    return out.filter(Boolean);
  }
  /** Labels rows before any click: only a verified exact resume on the owning host is offered. */
  async probeSupport(records, current) {
    const pairs = /* @__PURE__ */ new Map(), lists = /* @__PURE__ */ new Map(), ready = this.readiness();
    for (const r of records) {
      const machine2 = r.identity.machine;
      if (ready(machine2)) pairs.set(JSON.stringify([machine2, r.identity.provider]), [machine2, r.identity.provider]);
    }
    for (const [key3, [machine2, provider]] of pairs) {
      if (!current()) return;
      const saved = this.support.get(key3);
      if (saved && Date.now() - saved.at < 6e4) continue;
      if (!lists.has(hostKey2(machine2))) {
        let list2 = null;
        try {
          list2 = await this.io.knownAgents({ on: machine2 });
        } catch {
        }
        lists.set(hostKey2(machine2), Array.isArray(list2) ? list2 : null);
        if (Array.isArray(list2)) this.programs.set(hostKey2(machine2), new Map(list2.filter((p) => typeof p?.key === "string").map((p) => [p.key, p])));
      }
      const list = lists.get(hostKey2(machine2));
      if (!list) continue;
      const tool = installedTools(list).find((t) => t.key === provider);
      if (!tool) {
        this.support.set(key3, freeze3({ supported: false, kind: null, reason: `${providerNames[provider] || provider} is not installed on ${hostLabel(machine2)}.`, at: Date.now() }));
        continue;
      }
      try {
        const caps = await this.io.capabilities.get(tool, machine2);
        this.support.set(key3, freeze3({ ...resumeSupport(caps, { provider, machine: machine2 }), at: Date.now() }));
      } catch {
      }
    }
  }
  program(provider, machine2) {
    const own = this.programs.get(hostKey2(machine2))?.get(provider);
    if (own) return own;
    for (const programs of this.programs.values()) if (programs.has(provider)) return programs.get(provider);
    return { key: provider, name: providerNames[provider] || provider, icon: null };
  }
  filtered() {
    const m = this.memo;
    if (m && m.view === this.view && m.query === this.query && m.tool === this.tool && m.pinned === this.pinned) return m.value;
    const value = this.view ? filterSessions(this.view, { query: this.query, tool: this.tool, session: this.pinned }) : { rows: [], counts: { all: 0 } };
    this.memo = { view: this.view, query: this.query, tool: this.tool, pinned: this.pinned, value };
    return value;
  }
  refresh(cx) {
    this.repoCache.clear();
    return this.sync(cx, { force: true });
  }
  setScope(all, cx) {
    if (this.all === all) return;
    this.all = all;
    this.pinned = null;
    this.saveUI();
    this.sync(cx, { force: true });
  }
  setTool(tool, cx) {
    if (this.tool !== tool) {
      this.tool = tool;
      this.page = 0;
      this.saveUI();
    }
    cx.notify();
  }
  older(cx, page = this.page) {
    const end = (page + 1) * HISTORY_PAGE;
    this.page = page + 1;
    if (end < this.filtered().rows.length) {
      cx.notify();
      return;
    }
    if (this.status?.more && !this.isLoading()) return this.sync(cx, { more: true });
    cx.notify();
  }
  /** One exact resume or focus per click; a second click during it is ignored and the journal dedupes retries. */
  open(row, cx, { cwd } = {}) {
    if (this.closed || this.busy(row.key)) return;
    if (row.state === "running" && !row.spaceId) {
      herdr2.run("agent.focus", { terminal: row.running.terminal });
      return;
    }
    if (!row.spaceId || !row.repoRoot || !(cwd || row.checkoutRoot)) {
      this.outcomes.set(row.key, freeze3({ ok: false, code: "SPACE_UNAVAILABLE", message: row.reason || "Open this repository in a space to resume.", recovery: { actions: [] } }));
      cx.notify();
      return;
    }
    let intent = this.intents.get(row.key);
    if (!intent) {
      intent = newIntent();
      this.remember(this.intents, row.key, intent, 1e3);
    }
    const input = { requestId: intent.requestId, spaceId: row.spaceId, session: copy4(row.identity), repoRoot: row.repoRoot, cwd: cwd || row.checkoutRoot, ...row.reportedTitle ? { title: row.reportedTitle } : {} }, held = { at: Date.now(), task: null };
    this.resuming.set(row.key, held);
    this.outcomes.delete(row.key);
    this.info = null;
    cx.notify();
    held.task = this.spawn(cx, async (taskCx) => {
      const result = await resume(input, this.io);
      if (this.closed) return;
      if (this.resuming.get(row.key) === held) this.resuming.delete(row.key);
      if (result.ok) {
        this.intents.delete(row.key);
        this.info = result.action === "focus" ? "Focused the running session." : "Resumed " + row.title + " in its original checkout.";
        this.sync(taskCx, { force: true });
        return;
      }
      if (!retained(result)) this.intents.delete(row.key);
      this.remember(this.outcomes, row.key, result, 200);
    });
    return held.task;
  }
  locate(row, cx) {
    if (row.machine !== null || this.busy(row.key)) return;
    return this.spawn(cx, async (taskCx) => {
      const folder = await herdr2.pickFolder({ prompt: "Use this checkout" });
      if (this.closed || !folder) return;
      let cwd;
      try {
        cwd = canonicalRepoPath(folder);
      } catch {
        this.remember(this.outcomes, row.key, freeze3({ ok: false, code: "INVALID_RESUME", message: "Choose the absolute checkout folder of this session.", recovery: { actions: ["locate"] } }), 200);
        return;
      }
      await this.open(row, taskCx, { cwd });
    });
  }
  show(target) {
    const spaces2 = herdr2.spaces(), space = spaces2.find((s) => s.id === target.spaceId) || spaces2.find((s) => (s.tabs || []).some((t) => t.id === target.tabId)), terminal = target.terminal && target.machine && !target.terminal.startsWith(target.machine + "/") ? target.machine + "/" + target.terminal : target.terminal;
    if (space) herdr2.run("space.select", { id: space.id });
    if (target.tabId) herdr2.run("tab.select", { id: target.tabId });
    if (terminal) herdr2.run("pane.focus", { terminal });
  }
  recover(cx) {
    if (this.closed) return;
    const now3 = Date.now();
    let changed = false;
    for (const [key3, held] of this.resuming) if (held.task?.is_done?.() || now3 - held.at >= STALE_LOAD_MS) {
      this.resuming.delete(key3);
      changed = true;
    }
    if (this.history.hasAbandonedLoad()) {
      this.history.recover();
      this.loading = null;
      return this.sync(cx, { force: true });
    }
    if (this.loading && now3 - this.loading.at >= STALE_LOAD_MS) {
      this.loading = null;
      return this.sync(cx, { force: true });
    }
    if (changed) cx.notify();
  }
  /** Shared name observer while this View lives: records manual renames under one CAS lease. */
  observeNames(cx) {
    const now3 = Date.now();
    if (this.closed || this.observing && now3 - this.observing < 1e4 || now3 < this.observeRetryAt) return;
    const tabs = [];
    for (const space of herdr2.spaces()) for (const tab of space.tabs || []) tabs.push({ id: tab.id, machine: space.machine ?? null, name: typeof tab.name === "string" ? tab.name : "", named: tab.named === true });
    const key3 = JSON.stringify(tabs.map((t) => [t.machine, t.id, t.name, t.named]));
    if (key3 === this.observedKey) return;
    this.observing = now3;
    return this.spawn(cx, async (taskCx) => {
      try {
        const result = await this.names.observeNames(tabs, { leaseMs: 1e4 });
        if (this.closed) return;
        if (!result.owned) {
          this.observeRetryAt = Date.now() + 1e4;
          return;
        }
        this.leased = true;
        this.observedKey = key3;
        if (result.changed.length) await this.derive(taskCx);
      } catch {
        this.observeRetryAt = Date.now() + 1e4;
      } finally {
        this.observing = 0;
      }
    });
  }
  /** Live terminal changes refresh exact running state only; history is not rescanned. */
  watchTerminals(cx) {
    if (!this.basis) return;
    const key3 = herdr2.terminals().map((t) => t?.address).join(" ");
    if (key3 === this.terminalKey) return;
    const first = this.terminalKey === void 0;
    this.terminalKey = key3;
    if (first) return;
    if (this.runningAt && Date.now() - this.runningAt < STALE_LOAD_MS) {
      this.terminalKey = null;
      return;
    }
    this.runningAt = Date.now();
    return this.spawn(cx, async (taskCx) => {
      try {
        const basis = this.basis, running = await runningSessions(this.io, { ready: (m) => this.ready(m), isCurrent: () => !this.closed && this.basis === basis });
        if (this.closed || this.basis !== basis) return;
        this.basis = { ...basis, running };
        await this.derive(taskCx);
      } finally {
        this.runningAt = 0;
      }
    });
  }
  header() {
    const t = colors();
    return h_flex2().h(38).px(12).gap(8).items_center().border_b(1).border_color(t.border).child(icon(MOD, "sessions", 16).text_color(t.muted)).child(div2().font_semibold().text_size(12).text_color(t.foreground).child("Sessions")).child(div2().flex_1().min_w(0).truncate().text_size(10).text_color(t.dim).child(this.all ? "All spaces" : this.scopeName || "")).when(Boolean(this.props.overlay), (row) => row.child(iconButton(MOD, "sessions-close", "close", "Close", () => herdr2.closeOverlay(this.props.overlay))));
  }
  toolbar() {
    return h_flex2().px(10).pt(9).pb(6).gap(6).items_center().min_w(0).child(h_flex2().gap(2).flex_none().child(pill("sessions-scope-this", "This space", (cx) => this.setScope(false, cx), { active: !this.all })).child(pill("sessions-scope-all", "All spaces", (cx) => this.setScope(true, cx), { active: this.all }))).child(searchInput(MOD, "sessions-search", this.search).flex_1().min_w(0)).child(iconButton(MOD, "sessions-refresh", "refresh", "Refresh sessions", (_e, cx) => this.refresh(cx), { size: 26, disabled: this.isLoading() })).child(iconButton(MOD, "sessions-sources", "settings", "History sources and paths", (_e, cx) => {
      this.showSources = !this.showSources;
      cx.notify();
    }, { size: 26, active: this.showSources }));
  }
  toolFilters(counts) {
    const t = colors(), count = (n) => div2().text_size(10).text_color(t.dim).child(String(n)), chips = [pill("sessions-tool-all", ["All", count(counts.all)], (cx) => this.setTool("all", cx), { active: this.tool === "all", hint: "All tools" })];
    for (const provider of PROVIDERS) if (counts[provider] || this.tool === provider) chips.push(pill("sessions-tool-" + provider, [toolIcon(MOD, this.program(provider, null), 13), count(counts[provider] || 0)], (cx) => this.setTool(provider, cx), { active: this.tool === provider, hint: providerNames[provider] }));
    const row = h_flex2().px(10).pb(6).gap(2).items_center().min_w(0).children(chips);
    return this.pinned ? row.child(div2().flex_1()).child(pill("sessions-show-all", "Show all", (cx) => {
      this.pinned = null;
      this.page = 0;
      cx.notify();
    }, { hint: "Show every session in this scope" })) : row;
  }
  sourcesPanel() {
    const t = colors(), entries = this.history.list();
    return v_flex2().id("sessions-source-list").mx(10).mb(6).p(8).gap(5).rounded(5).border(1).border_color(t.border).bg(t.chrome).child(div2().text_size(10).text_color(t.muted).child("Read-only provider metadata on each machine. History is never modified or deleted.")).children(entries.map((e) => v_flex2().id("sessions-source-" + e.id).gap(1).child(label(`${providerNames[e.source.provider] || e.source.provider} · ${hostLabel(e.source.machine)} · ${e.source.credentialScope}`, { size: 11 })).children(e.source.roots.map((root) => div2().text_size(10).text_color(t.dim).truncate().tooltip(root).child(root))))).when(!entries.length, (el) => el.child(div2().text_size(10).text_color(t.dim).child("No history sources are enabled.")));
  }
  banner() {
    const t = colors(), errors = this.status?.errors || [], lines = errors.map((e) => `${providerNames[e.provider] || e.provider} on ${hostLabel(e.machine)}: ${e.message}`), message = this.error || lines[0];
    if (!message) return null;
    return h_flex2().id("sessions-error").mx(10).mb(6).px(8).py(4).gap(6).items_center().rounded(5).border(1).border_color(t.border).child(div2().flex_1().min_w(0).truncate().text_size(11).text_color(t.blocked).tooltip([this.error, ...lines].filter(Boolean).join("\n")).accessibility_label(message).child(message)).when(lines.length > 1, (el) => el.child(label("+" + (lines.length - 1), { muted: true, size: 10 }))).child(iconButton(MOD, "sessions-error-retry", "refresh", "Retry", (_e, cx) => this.sync(cx, { force: true }), { size: 22, disabled: this.isLoading() }));
  }
  empty() {
    const scope = this.scope, text9 = !this.view ? this.isLoading() ? "Loading sessions…" : "Sessions are unavailable. Retry." : !this.all && !scope?.spaceId ? "Select a repository space to see its sessions." : !this.all && scope.repo?.state !== "resolved" ? scope.repo?.reason || "Open or focus a terminal in this space’s repository." : !this.status?.sources ? `No session history sources are enabled${this.all ? "" : " on " + hostLabel(scope.machine)}.` : this.query || this.tool !== "all" || this.pinned ? "No matching sessions." : this.all ? "No previous sessions." : "No previous sessions in this repository yet.";
    return div2().id("sessions-empty").p(16).text_size(11).text_color(colors().dim).child(text9);
  }
  recovery(row, outcome) {
    const buttons = [], actions2 = outcome?.recovery?.actions || [], candidate2 = outcome?.recovery?.candidates?.[0], tabId = outcome?.recovery?.tabId;
    if (candidate2 || tabId) buttons.push(iconButton(MOD, row.id + "-show", "agent", candidate2 ? "Show the running terminal" : "Show its tab", () => this.show(candidate2 || { tabId, terminal: outcome.recovery.terminalId }), { size: 20 }));
    if ((row.state === "missing" || ["WORKTREE_MISSING", "CHECKOUT_MISMATCH"].includes(outcome?.code)) && row.machine === null && row.spaceId) buttons.push(iconButton(MOD, row.id + "-locate", "folder", "Locate this checkout", (_e, cx) => this.locate(row, cx), { size: 20 }));
    if (row.state === "offline") buttons.push(iconButton(MOD, row.id + "-retry", "refresh", "Retry", (_e, cx) => this.sync(cx, { force: true }), { size: 20, disabled: this.isLoading() }));
    else if (outcome ? actions2.some((a) => a.startsWith("retry")) : row.state === "missing") buttons.push(iconButton(MOD, row.id + "-retry", "refresh", actions2.includes("retry-binding") ? "Retry its binding" : "Retry", (_e, cx) => this.open(row, cx), { size: 20 }));
    if (outcome) buttons.push(iconButton(MOD, row.id + "-dismiss", "close", "Dismiss", (_e, cx) => {
      this.outcomes.delete(row.key);
      cx.notify();
    }, { size: 20 }));
    return buttons;
  }
  row(row, now3) {
    const t = colors(), busy = this.busy(row.key), outcome = this.outcomes.get(row.key), usable = ["ready", "running"].includes(row.state), clickable = usable && !busy;
    const meta = [...new Set([row.branch, row.linked || !row.branch ? row.folder : null, this.all ? row.spaceName : null, row.host].filter(Boolean))].join(" · "), hint = clickable ? (row.state === "running" ? "Focus " : "Resume ") + row.title : row.title + (row.reason ? " · " + row.reason : "");
    let el = v_flex2().id(row.id).px(7).py(6).gap(3).rounded(5).min_w(0).bg(this.pinned === row.key ? t.selected : "#00000000").tooltip([row.title, row.cwd || row.checkoutRoot, row.providerName + " · " + row.host].filter(Boolean).join("\n")).accessibility_label(hint).role("button");
    if (clickable) el = el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, eventCx) => this.open(row, eventCx));
    const status = busy ? div2().flex_none().text_size(10).text_color(t.accent).child(row.state === "running" ? "Focusing…" : "Opening…") : row.state === "running" ? h_flex2().flex_none().gap(4).items_center().child(div2().size(5).rounded_full().bg(t.working)).child(div2().text_size(10).text_color(t.working).child("Running")) : div2().flex_none().text_size(10).text_color(t.dim).child(sessionAge(row.activityAt, now3));
    el = el.child(h_flex2().h(17).gap(7).items_center().min_w(0).child(toolIcon(MOD, this.program(row.provider, row.machine), 15)).child(div2().flex_1().min_w(0).truncate().text_color(usable ? t.foreground : t.muted).child(row.title)).child(status)).child(h_flex2().h(13).gap(5).items_center().min_w(0).child(div2().w(15).flex_none()).when(Boolean(row.branch), (r) => r.child(icon(MOD, "branch", 10).text_color(t.dim))).child(div2().flex_1().min_w(0).truncate().text_size(10).text_color(t.dim).child(meta)));
    const message = outcome?.message || row.reason;
    return message ? el.child(h_flex2().gap(4).items_center().min_w(0).child(div2().w(15).flex_none()).child(div2().flex_1().min_w(0).truncate().text_size(10).text_color(outcome ? t.blocked : t.muted).tooltip(message).accessibility_label(message).child(message)).children(this.recovery(row, outcome))) : el;
  }
  footer({ page, total, shown, now: now3 }) {
    const t = colors(), s = this.status, end = page * HISTORY_PAGE + shown, loading = this.isLoading(), more = end < total || Boolean(s?.more) && !this.view?.truncated;
    const text9 = !this.view ? "" : (total ? `${page * HISTORY_PAGE + 1}–${end} of ${total}` : "0 sessions") + (s?.fetchedAt ? " · Updated " + sessionAge(s.fetchedAt, now3, { suffix: true }) : "") + (loading ? " · Updating" : "") + (s?.unreadable ? ` · ${s.unreadable} unreadable` : "");
    return v_flex2().id("sessions-footer").px(10).py(6).gap(4).border_t(1).border_color(t.border).when(Boolean(this.info), (el) => el.child(h_flex2().id("sessions-info").gap(6).items_center().child(div2().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).tooltip(this.info).child(this.info)).child(iconButton(MOD, "sessions-dismiss-info", "close", "Dismiss", (_e, cx) => {
      this.info = null;
      cx.notify();
    }, { size: 20 })))).child(h_flex2().h(24).gap(4).items_center().child(div2().flex_1().min_w(0).truncate().text_size(10).text_color(t.dim).child(text9)).when(Boolean(this.view?.truncated || s?.truncated), (el) => el.child(div2().flex_none().text_size(10).text_color(t.dim).tooltip("Only the most recent 1000 sessions per scope are listed. Provider history is never deleted.").child("Most recent 1000"))).child(pill("sessions-newer", "Newer", (cx) => {
      this.page = Math.max(0, page - 1);
      cx.notify();
    }, { disabled: page === 0, hint: "Newer sessions" })).child(pill("sessions-older", "Older", (cx) => this.older(cx, page), { disabled: !more || loading && end >= total, hint: "Older sessions" })));
  }
  render(cx) {
    this.sync(cx);
    this.watchTerminals(cx);
    const t = colors(), now3 = Date.now(), filtered = this.filtered(), total = filtered.rows.length, page = Math.min(this.page, Math.max(0, Math.ceil(total / HISTORY_PAGE) - 1)), rows = filtered.rows.slice(page * HISTORY_PAGE, (page + 1) * HISTORY_PAGE);
    const root = v_flex2().id("sessions-panel").relative().size_full().min_w(0).min_h(0).bg(t.surface).text_size(12);
    if (!this.props.hideHeader) root.child(this.header());
    root.child(this.toolbar()).child(this.toolFilters(filtered.counts));
    if (this.showSources) root.child(this.sourcesPanel());
    const banner = this.banner();
    if (banner) root.child(banner);
    root.child(v_flex2().id("sessions-list").flex_1().min_h(0).overflow_y_scrollbar().px(6).pb(4).gap(1).children(rows.map((row) => this.row(row, now3))).when(!rows.length, (el) => el.child(this.empty())));
    return root.child(this.footer({ page, total, shown: rows.length, now: now3 }));
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.epoch++;
    for (const timer of this.timers) timer?.cancel?.();
    for (const job of this.jobs) job?.cancel?.();
    this.commandTask?.cancel?.();
    this.history.close();
    for (const input of this.inputs) input.release();
    if (this.leased) try {
      await this.names.releaseLease();
    } catch {
    }
  }
};
export {
  MissionControlSessions as default,
  sessionAge
};
