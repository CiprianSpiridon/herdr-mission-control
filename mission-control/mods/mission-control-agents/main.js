// src/mods/mission-control-agents/main.js
import { View, div as div2 } from "gpui-kit";
import { v_flex as v_flex2, h_flex as h_flex2, InputState as InputState2, Input as Input2 } from "gpui-base";
import * as herdr2 from "herdr";

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
  for (const [key2, item] of Object.entries(value)) {
    if (forbiddenKeys.has(key2)) fail("Configuration contains a reserved object key.");
    const compact = key2.toLowerCase().replaceAll("_", "").replaceAll("-", "");
    if (!envMap && secretFields.has(compact)) fail("Store a credential environment reference, not a credential value.");
    if ((key2.endsWith("Env") || envMap) && (typeof item !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(item))) fail("Credential environment references must be environment variable names.");
    validateJson(item, depth + 1, key2 === "envRefs");
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
  if (!Object.hasOwn(value, "connectionId") || !Object.hasOwn(value, "projectPath") || Object.keys(value).some((key2) => !["connectionId", "projectPath", "status"].includes(key2))) fail("A GitLab binding needs its connection and project path.");
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
function validateBinding(binding, key2, connections) {
  if (!object(binding)) fail("Repository bindings must be objects.");
  if (bindingKey(binding.machine, binding.repoRoot) !== key2) fail("A repository binding does not match its machine/root key.");
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
  const normalized2 = { ...newConfig(), ...copy(value) };
  if (!Number.isSafeInteger(normalized2.revision) || normalized2.revision < 0) fail("Configuration revision must be a non-negative safe integer.");
  for (const field of ["connections", "bindings", "preferences", "usageSources"]) if (!object(normalized2[field])) fail(`Configuration ${field} must be an object.`);
  for (const [id, connection] of Object.entries(normalized2.connections)) {
    if (!/^[a-z][a-z0-9-]{0,95}$/.test(id) || !object(connection) || connection.id !== id || typeof connection.kind !== "string") fail("Connections require a matching stable id and adapter kind.");
    if (connection.site !== void 0 && (typeof connection.site !== "string" || !/^https:\/\/[^\s/@?#]+\/?$/.test(connection.site))) fail("A tracker site must be an HTTPS origin without credentials or query parameters.");
  }
  for (const [key2, binding] of Object.entries(normalized2.bindings)) validateBinding(binding, key2, normalized2.connections);
  if (JSON.stringify(normalized2).length > MAX_CONFIG_CHARACTERS) fail("Configuration exceeds the supported file size.");
  return normalized2;
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
async function updateConfig(io, edit2, { attempts = 4 } = {}) {
  if (typeof edit2 !== "function" || !Number.isInteger(attempts) || attempts < 1 || attempts > 8) throw new ConfigError("INVALID_EDIT", "Settings need a synchronous edit and one to eight CAS attempts.");
  for (let attempt = 0; attempt < attempts; attempt++) {
    const snapshot = await readConfig(io);
    const draft = copy(snapshot.value);
    const returned = edit2(draft);
    if (returned?.then) throw new ConfigError("INVALID_EDIT", "Settings edits must be synchronous.");
    const next = validateConfig(returned === void 0 ? draft : returned);
    if (next.revision !== snapshot.value.revision) throw new ConfigError("INVALID_EDIT", "Settings edits cannot replace the CAS revision.");
    if (next.revision === Number.MAX_SAFE_INTEGER) throw new ConfigError("REVISION_LIMIT", "Settings revision reached its supported limit; the original file has been preserved.");
    next.revision++;
    const text6 = JSON.stringify(next, null, 2) + "\n";
    if (text6.length > MAX_CONFIG_CHARACTERS) fail("Configuration exceeds the supported file size.");
    await io.ensureDirectory?.(snapshot.path.slice(0, snapshot.path.lastIndexOf("/")));
    try {
      await io.writeTextFile(snapshot.path, text6, snapshot.raw);
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
  const pid3 = raw.foreground?.pid ?? null;
  if (pid3 !== null && (!Number.isSafeInteger(pid3) || pid3 <= 0)) fail2("Invalid foreground PID");
  return { machine: machine2, address: machine2 ? machine2 + "/" + local : local, createdMs: raw.created_ms, foregroundPid: pid3 };
}
function terminalKey(identity) {
  if (!identity || !Number.isSafeInteger(identity.createdMs) || identity.createdMs < 0) fail2("Missing terminal generation");
  const on = machineIdentity(identity.machine), local = localTerminalAddress(identity.address, on), pid3 = identity.foregroundPid ?? null;
  if (pid3 !== null && (!Number.isSafeInteger(pid3) || pid3 <= 0)) fail2("Invalid foreground PID");
  return JSON.stringify([on, local, identity.createdMs, pid3]);
}

// src/mods/mission-control-agents/model.js
var rank = { blocked: 0, done: 1, working: 2, idle: 3 };
var headings = { blocked: "Needs you", done: "Done", working: "Working", idle: "Idle" };
var normalized = (status, { child = false, listed = false } = {}) => status === "error" ? "blocked" : child && !listed && status === "done" ? "idle" : Object.hasOwn(rank, status) ? status : "idle";
var clean = (value) => typeof value === "string" ? value.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 200) : "";
var tabKey = (machine2, tab) => JSON.stringify([machine2, tab]);
var meaningful = (value, program) => {
  const name2 = clean(value);
  return name2 && !/^\d+$/.test(name2) && !/^[/~]|^[A-Za-z]:[\\/]/.test(name2) && ![program?.name, program?.key, "Terminal", "Agent"].some((v) => v && name2.toLowerCase() === v.toLowerCase()) && !/^(claude(?: code)?|codex|grok)(?:\s+v?[\d.]+)?$/i.test(name2) ? name2 : null;
};
function agentTitle(agent, { tab, ownership, taskTitle } = {}) {
  if (ownership?.mode === "manual" && clean(ownership.manualName)) return clean(ownership.manualName);
  return meaningful(taskTitle, agent.program) || meaningful(tab?.named ? tab.name : null, agent.program) || meaningful(agent.title, agent.program) || meaningful(ownership?.lastAutoName, agent.program) || meaningful(agent.tab_name, agent.program) || "Agent";
}
function metrics(reading) {
  const c = reading?.context, q = reading?.quota, windows = Array.isArray(q?.windows) ? q.windows : [], percent = windows.length ? Math.min(...windows.map((w) => w.remainingPercent)) : null;
  const quotaScope = q?.scope === "shared-account" ? `Shared account · ${q.identity.credentialScope} · ${q.identity.accountId?.slice(0, 8)}` : q?.scope === "session-observation" ? "Session observation; account allowance is not independently proven." : "Account quota unavailable.";
  return { context: { state: c?.state || "unavailable", percent: c?.remainingPercent ?? null, estimated: c?.basis === "estimate", scope: c?.reason || "No exact session context observation.", reason: c?.reason || "No exact session context observation." }, quota: { state: q?.state || "unavailable", percent, scope: [quotaScope, q?.reason, ...windows.map((w) => `${w.name}: ${Math.round(w.remainingPercent)}%${w.resetsAt ? " · resets " + new Date(w.resetsAt).toISOString() : ""}`)].filter(Boolean).join("\n"), reason: q?.reason || "No exact account quota observation." } };
}
function buildAgentModel({ agents: agents2 = [], terminals: terminals2 = [], spaces: spaces2 = [], mode = "priority", query = "", folded = /* @__PURE__ */ new Set(), readings = /* @__PURE__ */ new Map(), names = null, taskTitles = /* @__PURE__ */ new Map() } = {}) {
  const native = /* @__PURE__ */ new Map(), raw = new Map(terminals2.map((t) => [t.address, t])), rowsByAddress = /* @__PURE__ */ new Map(), needle = clean(query).toLowerCase();
  for (const [order, agent] of agents2.entries()) {
    const space = spaces2.find((s) => s.id === agent.space), machine2 = space ? machineIdentity(space.machine) : null;
    let address = agent.address, focus = null;
    try {
      if (space) {
        const local = localTerminalAddress(address, machine2);
        address = machine2 ? machine2 + "/" + local : local;
        focus = { command: "agent.focus", args: { terminal: address } };
      }
    } catch {
    }
    const tab = space?.tabs?.find((t) => t.id === agent.tab), origin = names?.tabs?.[tabKey(machine2, agent.tab)], ownership = origin ? names.origins?.[origin] : null;
    native.set(address, { ...agent, address, machine: machine2, spaceInfo: space, order, title: agentTitle(agent, { tab, ownership, taskTitle: taskTitles.get(tabKey(machine2, agent.tab)) }), status: normalized(agent.status), focus, native: true });
  }
  const children = /* @__PURE__ */ new Map();
  for (const terminal of terminals2) if (terminal.parent && terminal.state === "live") {
    if (!children.has(terminal.parent)) children.set(terminal.parent, []);
    children.get(terminal.parent).push(terminal);
  }
  const seen = /* @__PURE__ */ new Set(), forests = [];
  function forest(root) {
    const members = [], stack = [{ node: root, depth: 0, parent: null }];
    while (stack.length) {
      const { node, depth, parent } = stack.pop();
      if (seen.has(node.address)) continue;
      seen.add(node.address);
      const listed = native.get(node.address), base2 = listed || { ...node, machine: root.machine, space: root.space, spaceInfo: root.spaceInfo, title: agentTitle({ ...node, title: node.name || node.title, tab_name: null }), status: normalized(node.status, { child: true }), focus: { command: "terminal.peek", args: { terminal: node.address } }, native: false };
      const row = { ...base2, depth, parent, root: root.address, spaceName: base2.spaceInfo?.name || base2.space_name || "Unavailable space", ...metrics(readings.get(node.address)) };
      row.matches = !needle || `${row.title} ${row.spaceName} ${row.machine || "This Mac"} ${row.status}`.toLowerCase().includes(needle);
      members.push(row);
      rowsByAddress.set(row.address, row);
      const kids = (children.get(node.address) || []).filter((t) => {
        if (root.machine ? !t.address.startsWith(root.machine + "/") : t.address.includes("/")) return false;
        try {
          localTerminalAddress(t.address, root.machine);
          return true;
        } catch {
          return false;
        }
      });
      for (let i = kids.length - 1; i >= 0; i--) stack.push({ node: kids[i], depth: depth + 1, parent: node.address });
    }
    const effective = members.reduce((status, row) => rank[row.status] < rank[status] ? row.status : status, root.status);
    const include = /* @__PURE__ */ new Set();
    for (const row of members) if (row.matches) {
      let current = row;
      while (current) {
        include.add(current.address);
        current = rowsByAddress.get(current.parent);
      }
      if (row.address === root.address) for (const child of members) include.add(child.address);
    }
    const visible = members.filter((row) => include.has(row.address) && (needle || !folded.has(root.address) || row.depth === 0));
    if (visible.length) forests.push({ root, effective, rows: visible, descendantCount: members.length - 1 });
  }
  const ancestorListed = (address) => {
    const visited = /* @__PURE__ */ new Set([address]);
    let parent = raw.get(address)?.parent;
    while (parent && !visited.has(parent)) {
      if (native.has(parent)) return true;
      visited.add(parent);
      parent = raw.get(parent)?.parent;
    }
    return false;
  };
  for (const root of native.values()) if (!ancestorListed(root.address) && !seen.has(root.address)) forest(root);
  for (const root of native.values()) if (!seen.has(root.address)) forest(root);
  const groups = [];
  if (mode === "spaces") {
    const order = new Map(spaces2.map((s, i) => [s.id, i])), sorted = [...forests].sort((a, b) => (order.get(a.root.space) ?? Infinity) - (order.get(b.root.space) ?? Infinity) || a.root.order - b.root.order), map = /* @__PURE__ */ new Map();
    for (const tree of sorted) {
      const key2 = tabKey(tree.root.machine, tree.root.space);
      if (!map.has(key2)) {
        const group = { key: key2, label: tree.root.spaceInfo?.name || "Unavailable space", machine: tree.root.machine, rows: [] };
        map.set(key2, group);
        groups.push(group);
      }
      map.get(key2).rows.push(...tree.rows);
    }
  } else for (const status of ["blocked", "done", "working", "idle"]) {
    const trees = forests.filter((t) => t.effective === status).sort((a, b) => a.root.order - b.root.order);
    if (trees.length) groups.push({ key: status, label: headings[status], status, rows: trees.flatMap((t) => t.rows) });
  }
  const rows = groups.flatMap((group) => group.rows), navigation = rows.filter((row) => row.native).map((row) => row.address);
  for (const address of native.keys()) if (!navigation.includes(address)) navigation.push(address);
  return { groups, rows, navigation, count: native.size, visibleCount: rows.length };
}

// src/shared/telemetry.js
import * as herdr from "herdr";

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
    const key2 = terminalKey(r.ack.terminal);
    if (result[key2]) fail3("BINDING_CONFLICT", "A terminal generation cannot belong to two work origins");
    result[key2] = id;
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
function pruneBindings(draft, now, { recoveryRecorded = [] } = {}) {
  const recovered = new Set(recoveryRecorded);
  for (const [id, r] of Object.entries(draft.proposals)) if (["proposed", "commit-pending"].includes(r.state) && r.expiresAt <= now && recovered.has(id)) delete draft.proposals[id];
  const invalid = Object.entries(draft.proposals).filter(([, r]) => r.state === "invalidated").sort(([a, x], [b, y]) => x.invalidatedAt - y.invalidatedAt || (a < b ? -1 : a > b ? 1 : 0));
  for (const [id] of invalid.slice(0, Math.max(0, invalid.length - 100))) delete draft.proposals[id];
  return indexes(draft);
}
function capacity(d) {
  if (Object.keys(d.proposals).length > 500 || bytes(JSON.stringify(d)) > 768 * 1024) fail3("BINDING_CAPACITY", "Session binding storage is full. Reconcile closed terminals or archive recovered requests; active mappings were preserved.");
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
  async edit(edit2, { recoveryRecorded = [] } = {}) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const { raw, value } = await this.read(), draft = clone(value), now = this.now();
      pruneBindings(draft, now, { recoveryRecorded });
      const result = edit2(draft, now);
      pruneBindings(draft, now, { recoveryRecorded });
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
    return (await this.edit((d, now) => {
      const old = d.proposals[requestId];
      if (old) {
        if (old.originId !== originId || JSON.stringify(old.session) !== JSON.stringify(exact)) fail3("BINDING_CONFLICT", "A request cannot change its origin or exact session");
        if (old.state === "invalidated" || ["proposed", "commit-pending"].includes(old.state) && old.expiresAt <= now) fail3("RECOVERY_REQUIRED", "The interrupted request needs recovery; do not launch it again");
        return clone(old);
      }
      const record = { originId, session: exact, state: "proposed", createdAt: now, updatedAt: now, invalidatedAt: null, expiresAt: now + 3e5 };
      d.proposals[requestId] = record;
      return clone(record);
    }, { recoveryRecorded })).result;
  }
  async transition(requestId, ack, proof, { pending = false, session: session2 } = {}) {
    validateAck(ack);
    const exact = session2 ? sessionIdentity(session2) : null;
    return (await this.edit((d, now) => {
      const r = d.proposals[requestId];
      if (!r || r.state === "invalidated") fail3("RECOVERY_REQUIRED", "No active proposal exists for this acknowledged launch");
      if (r.state !== "committed" && r.expiresAt <= now) fail3("RECOVERY_REQUIRED", "Acknowledged launch proposal expired; retain it for explicit recovery");
      if (now < r.updatedAt) fail3("INVALID_CLOCK", "The binding clock moved backwards");
      const selected = r.session || exact;
      if (r.session && exact && sessionKey(r.session) !== sessionKey(exact)) fail3("BINDING_CONFLICT", "A committed request cannot change provider sessions");
      if (selected) validateProof(proof, selected, ack.terminal);
      if (r.ack && (r.ack.tabId !== ack.tabId || terminalKey(r.ack.terminal) !== terminalKey(ack.terminal))) fail3("BINDING_CONFLICT", "Acknowledgment belongs to a different tab/terminal generation");
      if (r.state === "committed" && r.session && selected && sessionKey(r.session) === sessionKey(selected)) return clone(r);
      if (r.state === "committed" && pending) return clone(r);
      r.session = selected || null;
      r.state = pending ? "commit-pending" : "committed";
      r.updatedAt = now;
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
    return (await this.edit((d, now) => {
      const r = d.proposals[requestId];
      if (!r) return null;
      if (now < r.updatedAt) fail3("INVALID_CLOCK", "The binding clock moved backwards");
      r.invalidatedAt = r.invalidatedAt ?? now;
      r.updatedAt = now;
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
    return (await this.edit((d, now) => {
      const invalidated = [];
      for (const [id, r] of Object.entries(d.proposals)) {
        if (r.state !== "committed" || r.ack.terminal.machine !== on) continue;
        const actual = generations.get(r.ack.terminal.address), changed = actual && terminalKey(actual) !== terminalKey(r.ack.terminal), missing = !actual && authoritative;
        const disabled = r.session && enabledSources && !enabledSources.some((s) => s.machine === r.session.machine && s.provider === r.session.provider && s.credentialScope === r.session.credentialScope && s.providerRoot === r.session.providerRoot);
        if (changed || missing || disabled) {
          if (now < r.updatedAt) fail3("INVALID_CLOCK", "The binding clock moved backwards");
          r.state = "invalidated";
          r.invalidatedAt = r.invalidatedAt ?? now;
          r.updatedAt = now;
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
    return (await this.edit((d, now) => {
      const invalidated = [];
      for (const [id, r] of Object.entries(d.proposals)) {
        if (r.state === "invalidated" || !r.session || enabledSources.some((s) => s.machine === r.session.machine && s.provider === r.session.provider && s.credentialScope === r.session.credentialScope && s.providerRoot === r.session.providerRoot)) continue;
        if (now < r.updatedAt) fail3("INVALID_CLOCK", "The binding clock moved backwards");
        r.state = "invalidated";
        r.invalidatedAt = r.invalidatedAt ?? now;
        r.updatedAt = now;
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
  const base2 = canonical(home), on = machineIdentity(machine2), keys2 = new Set(installed.filter((t) => t.installed === true).map((t) => t.key)), result = {};
  for (const provider of providers) {
    if (!keys2.has(provider)) continue;
    const root = base2 + "/." + provider, roots = provider === "claude" ? [root + "/projects"] : provider === "codex" ? [root + "/sessions", root + "/archived_sessions"] : [root + "/sessions"];
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
        const key2 = usageSourceKey(source);
        if (seen.has(key2)) fail4("Duplicate provider/profile/root sources must be merged explicitly.");
        seen.add(key2);
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
  const fail6 = (code, reason) => ({ ok: false, code, reason });
  if (!object2(value) || !["available", "unavailable"].includes(value.state)) return fail6("INVALID_OBSERVATION", "Provider observation envelope is invalid.");
  if (value.identity !== null && !session(value.identity)) return fail6("INVALID_OBSERVATION", "Provider session identity is invalid.");
  if (value.state === "available" && value.identity === null) return fail6("INVALID_OBSERVATION", "Measured observations require an exact session identity.");
  const p = value.provenance;
  if (!keys(p, ["provider", "format", "formatVersion", "sourceDigest", "observedAt"]) || !providers2.has(p.provider) || !text4(p.format, 80) || !(p.formatVersion === null || text4(p.formatVersion, 80)) || typeof p.sourceDigest !== "string" || !/^[a-f0-9]{64}$/.test(p.sourceDigest) || !timestamp(p.observedAt) || value.identity && p.provider !== value.identity.provider) return fail6("INVALID_OBSERVATION", "Provider provenance is invalid.");
  if (identity) {
    if (!session(identity)) return fail6("INVALID_IDENTITY", "The requested session identity is invalid.");
    if (p.provider !== identity.provider || value.identity && sessionKey(value.identity) !== sessionKey(identity)) return fail6("SCOPE_MISMATCH", "Observation belongs to a different exact provider session.");
  }
  if (value.state === "unavailable") return keys(value, ["state", "identity", "provenance", "code", "reason"]) && text4(value.code, 80) && text4(value.reason, 300) ? { ok: true, value } : fail6("INVALID_OBSERVATION", "Unavailable observation is invalid.");
  if (!keys(value, ["state", "identity", "provenance", "context", "quota"], ["title", "cwd"])) return fail6("INVALID_OBSERVATION", "Unexpected provider observation fields.");
  if (Object.hasOwn(value, "title") && !text4(value.title)) return fail6("INVALID_OBSERVATION", "Reported session title is invalid.");
  if (Object.hasOwn(value, "cwd")) {
    try {
      if (canonicalRepoPath(value.cwd) !== value.cwd) return fail6("INVALID_OBSERVATION", "Reported working directory is not canonical.");
    } catch {
      return fail6("INVALID_OBSERVATION", "Reported working directory is invalid.");
    }
  }
  const c = value.context;
  if (c !== null && (!keys(c, ["usedTokens", "windowTokens", "compactionLimitTokens", "reportedUsedPercent"]) || Object.values(c).some((v) => !nullableNumber(v)) || c.reportedUsedPercent !== null && c.reportedUsedPercent > 100)) return fail6("INVALID_OBSERVATION", "Provider context fields are invalid.");
  const q = value.quota;
  if (q !== null) {
    if (!keys(q, ["proof", "windows"])) return fail6("INVALID_OBSERVATION", "Provider quota envelope is invalid.");
    const proof = q.proof;
    if (!keys(proof, ["kind", "machine", "credentialScope", "accountId", "poolId"]) || !["provider-account", "session-account-digest", "session-report", "none"].includes(proof.kind) || proof.machine !== value.identity.machine || proof.credentialScope !== value.identity.credentialScope || ![proof.accountId, proof.poolId].every((v) => v === null || text4(v))) return fail6("INVALID_OBSERVATION", "Provider quota identity is invalid.");
    if (!Array.isArray(q.windows) || q.windows.length > 16 || q.windows.some((w) => !keys(w, ["name", "remainingPercent", "observedAt", "resetsAt"]) || !text4(w.name, 80) || !number(w.remainingPercent) || w.remainingPercent > 100 || !timestamp(w.observedAt) || !timestamp(w.resetsAt))) return fail6("INVALID_OBSERVATION", "Provider quota windows are invalid.");
  }
  return { ok: true, value };
}

// src/shared/context.js
var CONTEXT_STALE_MS = 12e4;
var clamp = (value) => Math.max(0, Math.min(100, value));
function normalizeContext(observation, identity, { now = Date.now(), staleAfter = CONTEXT_STALE_MS } = {}) {
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
  const at = observation.provenance.observedAt;
  if (at === null) return missing("The context observation has no session-specific timestamp.");
  if (at > now + 5e3) return missing("The context observation is dated in the future.");
  const stale = now - at > staleAfter;
  return { identity: target, state: stale ? "stale" : "available", remainingPercent: remaining, basis, observedAt: at, reason: stale ? "The last exact context observation is older than two minutes. " + reason : reason };
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
function candidate(observation, identity, { now = Date.now(), staleAfter = QUOTA_STALE_MS } = {}) {
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
  if (q.windows.some((w) => w.observedAt !== null && w.observedAt > now + 5e3)) return missing("The quota observation is dated in the future.");
  const p = q.proof;
  const noPool = target.provider === "claude" && observation.provenance.format === "legacy-claude-statusline" && p.kind === "session-account-digest" && /^[a-f0-9]{64}$/.test(p.accountId || "") && p.poolId === null;
  const shared2 = ["provider-account", "session-account-digest"].includes(p.kind) && p.accountId !== null && (p.poolId !== null || noPool);
  const quotaIdentity = { machine: target.machine, provider: target.provider, credentialScope: target.credentialScope, accountId: shared2 ? p.accountId : null, poolId: shared2 ? p.poolId : null, ...!shared2 ? { session: target } : {} };
  const unknownAge = q.windows.some((w) => w.observedAt === null), old = q.windows.some((w) => w.observedAt !== null && now - w.observedAt > staleAfter), reset = q.windows.some((w) => w.resetsAt !== null && w.resetsAt <= now);
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
  const key2 = quotaKey(anchor.reading.identity), windows = new Map(anchor.sourceWindows.map((w) => [w.name, w]));
  for (const observation of values) {
    const other = candidate(observation, observation?.identity, options);
    if (other.reading.state === "unavailable" || other.reading.scope !== "shared-account" || quotaKey(other.reading.identity) !== key2) continue;
    for (const window of other.sourceWindows) {
      const current = windows.get(window.name);
      if (window.observedAt !== null && (!current || window.observedAt > (current.observedAt ?? -1))) windows.set(window.name, window);
    }
  }
  return normalizeQuota({ ...anchor.observation, quota: { ...anchor.observation.quota, windows: [...windows.values()] } }, identity, options);
}

// src/shared/codex-session-hook.js
var CODEX_LABEL = "mission-control.codex-session";
var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
var START_TIME_PY = String.raw`
def mc_start_ms(pid):
    import calendar, os, subprocess, time
    proc = os.environ.get("MC_RESTART_TEST_PROC", "/proc")
    try:
        pid = int(pid)
        if pid <= 0:
            return None
        if os.path.isdir(os.path.join(proc, str(pid))):
            with open(os.path.join(proc, str(pid), "stat")) as handle:
                fields = handle.read().rsplit(")", 1)[1].split()
            ticks = int(fields[19])
            with open(os.path.join(proc, "stat")) as handle:
                btime = next(int(line.split()[1]) for line in handle if line.startswith("btime "))
            return (btime + ticks // os.sysconf("SC_CLK_TCK")) * 1000
        if os.path.isdir(proc) and proc != "/proc":
            return None
        env = dict(os.environ)
        env.update({"TZ": "UTC", "LC_ALL": "C"})
        out = subprocess.run(["ps", "-o", "lstart=", "-p", str(pid)], capture_output=True, timeout=1.5, env=env)
        text = out.stdout.decode("ascii", "replace").strip() if out.returncode == 0 else ""
        if not text:
            return None
        return calendar.timegm(time.strptime(" ".join(text.split()), "%a %b %d %H:%M:%S %Y")) * 1000
    except Exception:
        return None
`;
var HOOK_BODY = String.raw`
import json, os, re, subprocess, sys, time

UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)
ADDRESS = re.compile(r"^t[0-9a-z]{1,63}$")
# Herdr's launch wrappers (local login shell, remote sh -c); split so no template ever interpolates.
WRAPPERS = {"-lic": '"$@"; exec "$0" -li', "-c": '"$@"; exec "$' + '{SHELL:-sh}" -i'}
SHELLS = {"sh", "bash", "zsh", "dash", "ksh"}
LABEL = "mission-control.codex-session"
END = time.monotonic() + 3.5


def run(args):
    try:
        p = subprocess.run(args, capture_output=True, timeout=max(0.1, END - time.monotonic()))
        return p.stdout.decode("utf-8", "replace") if p.returncode == 0 else None
    except Exception:
        return None


def hc():
    for folder in os.environ.get("PATH", "").split(os.pathsep):
        if folder and os.access(os.path.join(folder, "hc"), os.X_OK):
            return os.path.join(folder, "hc")
    local = os.path.expanduser("~/.local/bin/hc")
    return local if os.access(local, os.X_OK) else None


def parent(pid):
    out = run(["ps", "-o", "ppid=", "-p", str(pid)])
    try:
        return int(out.strip())
    except Exception:
        return None


def argv_of(pid):
    out = run(["ps", "-o", "args=", "-p", str(pid)])
    return out.split() if out else []


def children(pid):
    found = []
    for line in (run(["ps", "-A", "-o", "pid=,ppid="]) or "").splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1] == str(pid):
            found.append(int(parts[0]))
    return found


def top_level(path, session):
    if not isinstance(path, str) or not path.startswith("/"):
        return False
    with open(path, "rb") as handle:
        head = handle.read(262145)
    cut = head.find(b"\n")
    if cut < 0 or cut > 262144:
        return False
    first = json.loads(head[:cut].decode("utf-8"))
    meta = first.get("payload") if isinstance(first, dict) else None
    return first.get("type") == "session_meta" and isinstance(meta, dict) and meta.get("id") == session and meta.get("parent_thread_id") is None


def agent_of(raw):
    foreground = raw.get("foreground") if isinstance(raw, dict) else None
    pid = foreground.get("pid") if isinstance(foreground, dict) else None
    argv = foreground.get("argv") if isinstance(foreground, dict) else None
    if type(pid) is not int or pid <= 1:
        return None
    if isinstance(argv, list) and len(argv) >= 3 and WRAPPERS.get(argv[1]) == argv[2]:
        kids = children(pid)
        return kids[0] if len(kids) == 1 else None
    return pid


def main():
    raw = sys.stdin.buffer.read(65537)
    if len(raw) > 65536:
        return
    event = json.loads(raw.decode("utf-8"))
    session, terminal = event.get("session_id"), os.environ.get("HC_TERMINAL_ID", "")
    if event.get("hook_event_name") != "SessionStart" or not isinstance(session, str) or not UUID.match(session) or not ADDRESS.match(terminal):
        return
    if not top_level(event.get("transcript_path"), session):
        return
    tool = hc()
    listing = run([tool, "get", terminal, "--json"]) if tool else None
    if listing is None:
        return
    agent = agent_of(json.loads(listing))
    if agent is None:
        return
    chain, pid = [], os.getppid()
    while pid and pid > 1 and len(chain) < 3:
        chain.append(pid)
        if pid == agent:
            break
        pid = parent(pid)
    if not chain or chain[-1] != agent:
        return
    for step in chain:
        argv = argv_of(step)
        if "app-server" in argv:
            return
        if step != agent and (not argv or os.path.basename(argv[0]).lstrip("-") not in SHELLS):
            return
    started = mc_start_ms(agent)
    if started is None:
        return
    run([tool, "label", terminal, "%s=%d:%d:%s" % (LABEL, agent, started, session)])


try:
    main()
except Exception:
    pass
sys.exit(0)
`;
var HOOK_SCRIPT = "#!/usr/bin/env python3\n# Mission Control: labels this Herdr terminal with the exact Codex session it runs.\n# Installed by Mission Control; remove it from Mission Control (Set up Codex resume).\n" + START_TIME_PY + HOOK_BODY;
var HOOK_HELPER = String.raw`
import json, os, stat, sys, time

MARK = "mission-control-session-hook.py"
request = json.loads(sys.argv[1])


def out(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")))
    sys.exit(0)


class Spans:
    def __init__(self, text):
        self.t, self.i, self.d = text, 0, json.JSONDecoder()

    def ws(self):
        while self.i < len(self.t) and self.t[self.i] in " \t\r\n":
            self.i += 1

    def value(self):
        self.ws()
        start, c = self.i, self.t[self.i]
        if c in "{[":
            close, items = ("}" if c == "{" else "]"), []
            self.i += 1
            self.ws()
            if self.t[self.i] == close:
                self.i += 1
                return {"kind": "object" if c == "{" else "array", "start": start, "end": self.i, "items": items}
            while True:
                self.ws()
                if c == "{":
                    key_start = self.i
                    key, self.i = self.d.raw_decode(self.t, self.i)
                    if not isinstance(key, str):
                        raise ValueError("key")
                    self.ws()
                    if self.t[self.i] != ":":
                        raise ValueError("colon")
                    self.i += 1
                    v = self.value()
                    items.append({"key": key, "start": key_start, "end": v["end"], "value": v})
                else:
                    items.append(self.value())
                self.ws()
                if self.t[self.i] == ",":
                    self.i += 1
                    continue
                if self.t[self.i] != close:
                    raise ValueError("close")
                self.i += 1
                return {"kind": "object" if c == "{" else "array", "start": start, "end": self.i, "items": items}
        _, self.i = self.d.raw_decode(self.t, self.i)
        return {"kind": "scalar", "start": start, "end": self.i}


def member(obj, key):
    found = [m for m in obj["items"] if m["key"] == key]
    return found[-1] if found else None


def ours(group):
    return isinstance(group, dict) and isinstance(group.get("hooks"), list) and any(isinstance(h, dict) and MARK in str(h.get("command", "")) for h in group["hooks"])


def groups(value):
    hooks = value.get("hooks") if isinstance(value, dict) else None
    start = hooks.get("SessionStart") if isinstance(hooks, dict) else None
    return start if isinstance(start, list) else []


def splice(text, group):
    root = Spans(text).value()
    if root["kind"] != "object":
        raise ValueError("hooks.json is not an object")
    def add(obj, member_text):
        if obj["items"]:
            end = obj["items"][-1]["end"]
            return text[:end] + ", " + member_text + text[end:]
        return text[: obj["start"] + 1] + member_text + text[obj["start"] + 1 :]
    hooks = member(root, "hooks")
    if hooks is None:
        return add(root, '"hooks": {"SessionStart": [' + group + "]}")
    if hooks["value"]["kind"] != "object":
        raise ValueError("hooks is not an object")
    start = member(hooks["value"], "SessionStart")
    if start is None:
        return add(hooks["value"], '"SessionStart": [' + group + "]")
    array = start["value"]
    if array["kind"] != "array":
        raise ValueError("SessionStart is not an array")
    if not array["items"]:
        return text[: array["start"] + 1] + group + text[array["end"] - 1 :]
    last = array["items"][-1]["end"]
    return text[:last] + ", " + group + text[last:]


def cut(text, index):
    root = Spans(text).value()
    items = member(member(root, "hooks")["value"], "SessionStart")["value"]["items"]
    item = items[index]
    if index > 0:
        return text[: items[index - 1]["end"]] + text[item["end"] :]
    if len(items) > 1:
        return text[: item["start"]] + text[items[1]["start"] :]
    return text[: item["start"]] + text[item["end"] :]


def spans_of(text):
    root = Spans(text).value()
    hooks = member(root, "hooks")
    start = member(hooks["value"], "SessionStart") if hooks and hooks["value"]["kind"] == "object" else None
    return [text[i["start"] : i["end"]] for i in start["value"]["items"]] if start and start["value"]["kind"] == "array" else []


def write_atomic(path, data, mode):
    tmp = path + ".mission-control-tmp-%d" % os.getpid()
    with open(tmp, "w", encoding="utf-8") as handle:
        handle.write(data)
    os.chmod(tmp, mode)
    os.replace(tmp, path)


home = os.environ.get("CODEX_HOME") or os.path.expanduser("~/.codex")
home = os.path.realpath(home)
op, script = request.get("op"), request.get("script")
if request.get("v") != 1 or op not in ("install", "status", "remove") or (op == "install" and not isinstance(script, str)):
    out({"ok": False, "code": "INVALID_REQUEST", "message": "Unsupported hook request."})
if not os.path.isdir(home):
    out({"ok": False, "code": "NO_CODEX", "message": "Codex has no home folder on this machine.", "codexHome": home})
hooks_path, script_path = os.path.join(home, "hooks.json"), os.path.join(home, MARK)
if "'" in script_path:
    out({"ok": False, "code": "UNSAFE_PATH", "message": "The Codex folder path contains a quote.", "codexHome": home})
if os.path.islink(hooks_path) or os.path.islink(script_path):
    out({"ok": False, "code": "SYMLINK", "message": "hooks.json or the hook script is a symbolic link; nothing was changed.", "codexHome": home})
original = None
if os.path.exists(hooks_path):
    if os.path.getsize(hooks_path) > 1048576:
        out({"ok": False, "code": "TOO_LARGE", "message": "hooks.json is larger than 1 MiB; nothing was changed.", "codexHome": home})
    with open(hooks_path, encoding="utf-8") as handle:
        original = handle.read()
    try:
        parsed = json.loads(original)
        if not isinstance(parsed, dict):
            raise ValueError("object")
        Spans(original).value()
    except Exception:
        out({"ok": False, "code": "INVALID_HOOKS", "message": "hooks.json is not a valid JSON object; nothing was changed.", "codexHome": home})
else:
    parsed = {}
existing = groups(parsed)
mine = [i for i, g in enumerate(existing) if ours(g)]
has_script = os.path.isfile(script_path)
if op == "status":
    current = None
    if has_script:
        with open(script_path, encoding="utf-8", errors="replace") as handle:
            current = handle.read()
    out({"ok": True, "codexHome": home, "installed": bool(mine), "index": mine[0] if mine else None, "script": has_script, "current": current == script if isinstance(script, str) else None})
mode = stat.S_IMODE(os.stat(hooks_path).st_mode) if original is not None else 0o644
stamp = time.strftime("%Y%m%dT%H%M%S", time.gmtime())


def commit(text):
    if original is not None:
        backup = hooks_path + ".mission-control-" + stamp + ".bak"
        with open(backup, "w", encoding="utf-8") as handle:
            handle.write(original)
        os.chmod(backup, mode)
        with open(hooks_path, encoding="utf-8") as handle:
            if handle.read() != original:
                out({"ok": False, "code": "CONFLICT", "message": "hooks.json changed while it was being updated; nothing was changed.", "codexHome": home})
    else:
        backup = None
        if os.path.exists(hooks_path):
            out({"ok": False, "code": "CONFLICT", "message": "hooks.json appeared while it was being created; nothing was changed.", "codexHome": home})
    write_atomic(hooks_path, text, mode)
    return backup


if op == "install":
    if not has_script or open(script_path, encoding="utf-8", errors="replace").read() != script:
        write_atomic(script_path, script, 0o644)
    if mine:
        out({"ok": True, "codexHome": home, "installed": True, "changed": False, "index": mine[0]})
    group = json.dumps({"hooks": [{"type": "command", "command": "python3 '" + script_path + "'", "timeout": int(request.get("timeout", 5))}]})
    base = original if original is not None else "{}\n"
    text = splice(base, group)
    after = json.loads(text)
    before_spans, after_spans = spans_of(base), spans_of(text)
    keep = dict(after)
    if not (groups(after)[: len(existing)] == existing and after_spans[: len(before_spans)] == before_spans and len(groups(after)) == len(existing) + 1 and ours(groups(after)[-1])):
        out({"ok": False, "code": "SPLICE_FAILED", "message": "The new hook could not be added without changing existing hooks; nothing was changed.", "codexHome": home})
    other = {k: v for k, v in after.items() if k != "hooks"} == {k: v for k, v in parsed.items() if k != "hooks"}
    other_hooks = {k: v for k, v in after["hooks"].items() if k != "SessionStart"} == {k: v for k, v in (parsed.get("hooks") or {}).items() if k != "SessionStart"}
    if not (other and other_hooks):
        out({"ok": False, "code": "SPLICE_FAILED", "message": "The new hook could not be added without changing existing hooks; nothing was changed.", "codexHome": home})
    backup = commit(text)
    out({"ok": True, "codexHome": home, "installed": True, "changed": True, "index": len(existing), "backup": backup})

# remove
if not mine:
    if has_script:
        os.remove(script_path)
    out({"ok": True, "codexHome": home, "installed": False, "changed": False, "laterGroups": 0})
index = mine[0]
text = cut(original, index)
after = json.loads(text)
expected = [g for i, g in enumerate(existing) if i != index]
if groups(after) != expected:
    out({"ok": False, "code": "SPLICE_FAILED", "message": "The hook could not be removed without changing other hooks; nothing was changed.", "codexHome": home})
backup = commit(text)
if has_script:
    os.remove(script_path)
out({"ok": True, "codexHome": home, "installed": False, "changed": True, "laterGroups": len(existing) - index - 1, "backup": backup})
`;
function parseCodexLabel(value) {
  if (typeof value !== "string" || value.length > 120) return null;
  const m = /^([1-9]\d{0,9}):(\d{1,15}):([0-9a-f-]{36})$/i.exec(value);
  if (!m || !UUID.test(m[3])) return null;
  const pid3 = Number(m[1]), startMs = Number(m[2]);
  return Number.isSafeInteger(pid3) && Number.isSafeInteger(startMs) ? Object.freeze({ pid: pid3, startMs, sessionId: m[3].toLowerCase() }) : null;
}

// src/shared/restart-host.js
var HOST_LIMITS = Object.freeze({ terminals: 64, children: 8, output: 1048576, request: 65536 });
var UUID2 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
var ADDRESS = /^t[0-9a-z]{1,63}$/;
var HOST_HELPER = START_TIME_PY + String.raw`
import calendar, json, os, re, subprocess, sys, time

END = time.monotonic() + 2.0
request = json.loads(sys.argv[1])
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)
PROC = os.environ.get("MC_RESTART_TEST_PROC", "/proc")
LSOF = os.environ.get("MC_RESTART_TEST_LSOF", "lsof")
CLAIMS = os.environ.get("MC_RESTART_TEST_CLAIMS") or os.path.expanduser("~/.local/state/mission-control/restart-claims")


def out(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")))
    sys.exit(0)


def left():
    return max(0.05, END - time.monotonic())


def proc_mode():
    return os.path.isdir(PROC) and (PROC != "/proc" or os.path.isdir("/proc/self"))


def table():
    """pid -> (ppid, name) for every process, from /proc or one ps call."""
    rows = {}
    if proc_mode():
        for entry in os.listdir(PROC)[:65536]:
            if not entry.isdigit():
                continue
            try:
                with open(os.path.join(PROC, entry, "stat")) as handle:
                    head, rest = handle.read().rsplit(")", 1)
                name = head.split("(", 1)[1]
                rows[int(entry)] = (int(rest.split()[1]), name)
            except Exception:
                continue
        return rows
    env = dict(os.environ)
    env.update({"LC_ALL": "C"})
    p = subprocess.run(["ps", "-A", "-o", "pid=,ppid=,comm="], capture_output=True, timeout=left(), env=env)
    if p.returncode != 0:
        raise OSError("ps")
    for line in p.stdout.decode("utf-8", "replace").splitlines():
        parts = line.split(None, 2)
        if len(parts) == 3 and parts[0].isdigit() and parts[1].isdigit():
            rows[int(parts[0])] = (int(parts[1]), parts[2].strip())
    return rows


def short(name):
    return os.path.basename(name or "").lstrip("-") or None


def info(pid, rows):
    if type(pid) is not int or pid not in rows:
        return None
    start = mc_start_ms(pid)
    return {"pid": pid, "ppid": rows[pid][0], "name": short(rows[pid][1]), "startMs": start, "ageMs": None if start is None else max(0, int(time.time() * 1000) - start)}


def lstart_ms(text):
    try:
        return calendar.timegm(time.strptime(" ".join(str(text).split()), "%a %b %d %H:%M:%S %Y")) * 1000
    except Exception:
        return None


def claude(root, pid, start):
    path = os.path.join(root, "sessions", "%d.json" % pid)
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except OSError:
        return {"code": "NO_RECORD"}
    try:
        if os.fstat(fd).st_size > 65536:
            return {"code": "INVALID_RECORD"}
        record = json.loads(os.read(fd, 65537).decode("utf-8"))
    except Exception:
        return {"code": "INVALID_RECORD"}
    finally:
        os.close(fd)
    session = record.get("sessionId") if isinstance(record, dict) else None
    if record.get("pid") != pid or record.get("kind") != "interactive" or not isinstance(session, str) or not UUID.match(session):
        return {"code": "INVALID_RECORD"}
    if start is None:
        return {"code": "PROCESS_UNKNOWN"}
    recorded = lstart_ms(record.get("procStart")) if record.get("procStart") is not None else None
    if recorded is not None:
        ok = recorded // 1000 == start // 1000
    else:
        began = record.get("startedAt")
        ok = type(began) in (int, float) and abs(began - start) <= 5000
    return {"sessionId": session.lower(), "via": "pid-record"} if ok else {"code": "PROCESS_MISMATCH"}


def open_files(pid):
    if proc_mode():
        folder = os.path.join(PROC, str(pid), "fd")
        names = []
        for fd in os.listdir(folder)[:4096]:
            try:
                names.append(os.readlink(os.path.join(folder, fd)))
            except OSError:
                continue
        return names
    p = subprocess.run([LSOF, "-a", "-n", "-P", "-p", str(pid), "-Fn"], capture_output=True, timeout=left())
    if p.returncode not in (0, 1) or len(p.stdout) > 1048576:
        raise OSError("lsof")
    return [line[1:] for line in p.stdout.decode("utf-8", "replace").splitlines() if line.startswith("n")]


def grok(root, pid):
    base = os.path.realpath(root).rstrip("/")
    pattern = re.compile("^" + re.escape(base) + r"/sessions/[^/]+/([0-9a-f-]{36})/events\.jsonl$", re.I)
    try:
        names = open_files(pid)
    except Exception:
        return {"code": "UNAVAILABLE"}
    found = {m.group(1).lower() for m in (pattern.match(n) for n in names) if m and UUID.match(m.group(1))}
    if len(found) == 1:
        return {"sessionId": found.pop(), "via": "open-file"}
    return {"code": "AMBIGUOUS" if found else "NO_SESSION"}


def facts():
    rows = table()
    result = []
    for t in request.get("terminals", [])[:64]:
        shell, fg = info(t.get("shellPid"), rows), info(t.get("foregroundPid"), rows)
        kids = []
        if fg:
            kids = [info(pid, rows) for pid, row in sorted(rows.items()) if row[0] == fg["pid"]][:8]
        sessions = []
        for proc in ([fg] if fg else []) + kids[:4]:
            s = {"pid": proc["pid"]}
            if request.get("claudeRoot"):
                s["claude"] = claude(os.path.expanduser(request["claudeRoot"]), proc["pid"], proc["startMs"])
            if request.get("grokRoot"):
                s["grok"] = grok(os.path.expanduser(request["grokRoot"]), proc["pid"])
            sessions.append(s)
        result.append({"address": t.get("address"), "shell": shell, "foreground": fg, "children": kids, "sessions": sessions})
    out({"v": 1, "ok": True, "terminals": result})


def claim():
    key = request.get("key")
    if not isinstance(key, str) or not re.match(r"^[A-Za-z0-9._-]{1,200}$", key):
        out({"v": 1, "ok": False, "code": "INVALID_KEY"})
    os.makedirs(CLAIMS, mode=0o700, exist_ok=True)
    cutoff = time.time() - 7 * 86400
    for name in os.listdir(CLAIMS)[:200]:
        try:
            if os.lstat(os.path.join(CLAIMS, name)).st_mtime < cutoff:
                os.remove(os.path.join(CLAIMS, name))
        except OSError:
            pass
    try:
        fd = os.open(os.path.join(CLAIMS, key), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.write(fd, json.dumps({"at": int(time.time() * 1000), "owner": str(request.get("owner", ""))[:120]}).encode())
        os.close(fd)
        out({"v": 1, "ok": True, "claimed": True})
    except FileExistsError:
        out({"v": 1, "ok": True, "claimed": False})


try:
    if request.get("v") != 1:
        out({"v": 1, "ok": False, "code": "INVALID_REQUEST"})
    if request.get("op") == "facts":
        facts()
    if request.get("op") == "claim":
        claim()
    out({"v": 1, "ok": False, "code": "INVALID_REQUEST"})
except SystemExit:
    raise
except Exception:
    out({"v": 1, "ok": False, "code": "UNAVAILABLE"})
`;
var unavailable = (on, code = "UNAVAILABLE") => Object.freeze({ ok: false, code, machine: on });
async function call(io, on, request) {
  const text6 = JSON.stringify(request);
  if (text6.length > HOST_LIMITS.request) return unavailable(on, "REQUEST_TOO_LARGE");
  let result;
  try {
    result = await io.exec("python3", ["-c", HOST_HELPER, text6], { on });
  } catch {
    return unavailable(on, "HOST_UNAVAILABLE");
  }
  if (result?.code !== 0 || typeof result.stdout !== "string" || result.stdout.length > HOST_LIMITS.output) return unavailable(on, "HOST_UNAVAILABLE");
  try {
    const value = JSON.parse(result.stdout);
    if (value?.v === 1 && typeof value.ok === "boolean") return value;
  } catch {
  }
  return unavailable(on, "INVALID_RESPONSE");
}
var pid = (v) => Number.isSafeInteger(v) && v > 1 ? v : null;
var proc = (v) => v && pid(v.pid) ? Object.freeze({ pid: v.pid, ppid: Number.isSafeInteger(v.ppid) ? v.ppid : null, name: typeof v.name === "string" ? v.name.slice(0, 64) : null, startMs: Number.isSafeInteger(v.startMs) ? v.startMs : null, ageMs: Number.isSafeInteger(v.ageMs) ? v.ageMs : null }) : null;
var found = (v) => v && typeof v.sessionId === "string" && UUID2.test(v.sessionId) ? Object.freeze({ sessionId: v.sessionId.toLowerCase(), via: v.via === "open-file" ? "open-file" : "pid-record" }) : Object.freeze({ code: typeof v?.code === "string" ? v.code.slice(0, 40) : "UNAVAILABLE" });
async function hostFacts(io, { machine: machine2 = null, terminals: terminals2 = [], claudeRoot = null, grokRoot = null } = {}) {
  const on = machineIdentity(machine2), asked = terminals2.filter((t) => ADDRESS.test(t?.address ?? "")).slice(0, HOST_LIMITS.terminals).map((t) => ({ address: t.address, shellPid: pid(t.shellPid), foregroundPid: pid(t.foregroundPid) }));
  if (!asked.length) return Object.freeze({ ok: true, machine: on, terminals: /* @__PURE__ */ new Map() });
  const value = await call(io, on, { v: 1, op: "facts", terminals: asked, claudeRoot: typeof claudeRoot === "string" ? claudeRoot : null, grokRoot: typeof grokRoot === "string" ? grokRoot : null });
  if (!value.ok || !Array.isArray(value.terminals)) return unavailable(on, value.code || "INVALID_RESPONSE");
  const map = /* @__PURE__ */ new Map(), known = new Set(asked.map((t) => t.address));
  for (const t of value.terminals) {
    if (!known.has(t?.address)) continue;
    const sessions = /* @__PURE__ */ new Map();
    for (const s of Array.isArray(t.sessions) ? t.sessions : []) if (pid(s?.pid)) sessions.set(s.pid, Object.freeze({ ...s.claude ? { claude: found(s.claude) } : {}, ...s.grok ? { grok: found(s.grok) } : {} }));
    map.set(t.address, Object.freeze({ shell: proc(t.shell), foreground: proc(t.foreground), children: Object.freeze((Array.isArray(t.children) ? t.children : []).map(proc).filter(Boolean).slice(0, HOST_LIMITS.children)), sessions }));
  }
  return Object.freeze({ ok: true, machine: on, terminals: map });
}

// src/shared/restart-resume.js
var RESTART = Object.freeze({ version: 1, entriesPerMachine: 500, bytes: 900 * 1024, machines: 32, typeWindowMs: 15 * 6e4, sendingStaleMs: 6e4, graceMs: 6e4, offerMs: 24 * 36e5, leaseMs: 15e3, seenRefreshMs: 6e4, maxSends: 4 });
var STATES = Object.freeze(["tracking", "lost", "sending", "sent", "offered", "skipped"]);
var VIAS = Object.freeze(["pid-record", "codex-hook", "open-file", "argv", "binding"]);
var PROVIDERS = Object.freeze(["claude", "codex", "grok"]);
var POSIX_SHELLS = /* @__PURE__ */ new Set(["sh", "bash", "zsh", "dash", "ksh"]);
var UUID3 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
var WRAPPERS = Object.freeze({ "-lic": '"$@"; exec "$0" -li', "-c": '"$@"; exec "${SHELL:-sh}" -i' });
var pid2 = (v) => Number.isSafeInteger(v) && v > 1;
var freeze = (v) => {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    for (const c of Object.values(v)) freeze(c);
    Object.freeze(v);
  }
  return v;
};
var base = (v) => typeof v === "string" ? v.slice(v.lastIndexOf("/") + 1).replace(/^-+/, "") : "";
function argvSession(argv) {
  if (!Array.isArray(argv)) return null;
  const words = argv.slice(0, 32).map(String), names = words.slice(0, 3).map(base);
  const provider = names.some((n) => n === "claude") || words.slice(0, 3).some((w) => w.includes("/@anthropic-ai/claude-code/")) ? "claude" : names.some((n) => n === "codex") ? "codex" : names.some((n) => /^grok(?:$|-)/.test(n)) ? "grok" : null;
  if (!provider) return null;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    let id = null;
    if (provider !== "codex" && (w === "--resume" || w === "-r")) id = words[i + 1];
    else if (provider !== "codex" && w.startsWith("--resume=")) id = w.slice(9);
    else if (provider === "codex" && w === "resume") id = words[i + 1];
    if (typeof id === "string" && UUID3.test(id)) return freeze({ provider, sessionId: id.toLowerCase(), via: "argv" });
  }
  return null;
}
function providerOf({ programKey, app, argv, name: name2 } = {}) {
  const k = String(programKey || "").toLowerCase();
  if (PROVIDERS.includes(k)) return k;
  const a = String(app || "").toLowerCase();
  if (a === "claude-code" || a === "claude") return "claude";
  if (a === "codex") return "codex";
  if (a === "grok-build" || a === "grok") return "grok";
  const words = Array.isArray(argv) ? argv.slice(0, 3).map(String) : [], names = [...words.map(base), base(name2)];
  if (names.includes("claude") || words.some((w) => w.includes("/@anthropic-ai/claude-code/"))) return "claude";
  if (names.includes("codex")) return "codex";
  if (names.some((n) => /^grok(?:$|-)/.test(n))) return "grok";
  return null;
}
function isWrapper(argv) {
  return Array.isArray(argv) && argv.length >= 3 && WRAPPERS[argv[1]] === argv[2] && POSIX_SHELLS.has(base(argv[0]));
}
function agentProcess(foreground, children = []) {
  if (isWrapper(foreground?.argv)) return children.length === 1 ? children[0] : null;
  return foreground && pid2(foreground.pid) ? foreground : null;
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
      for (const state2 of this.agentStates.values()) if (state2.sourceId === id) {
        this.measurements.delete(state2.terminal?.address);
        state2.session = null;
        state2.reason = "Usage source changed or was disabled.";
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
    const key2 = JSON.stringify(machineIdentity(machine2)), previous = this.hostQueues.get(key2);
    let release, acquired = false;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    this.hostQueues.set(key2, current);
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
      if (this.hostQueues.get(key2) === current) this.hostQueues.delete(key2);
    }
  }
  async initializeSources() {
    const machines = this.io.machines?.() || [{ name: null, layout: "ready" }];
    await Promise.all(machines.filter((m) => m.layout === "ready").map(async (m) => {
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
    const previous = this.observations.get(source.id) || { live: [], cache: [] }, times = this.lastScan.get(source.id) || {}, sessions = JSON.stringify(identities.map(sessionKey).sort());
    for (const [kind, roots, interval] of [["live", source.roots, 3e4], ["cache", source.cacheRoots || [], 6e4]]) {
      if (!roots.length || !identities.length || !force && times[kind + "Sessions"] === sessions && times[kind] !== void 0 && this.clock() - times[kind] < interval) continue;
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
          times[kind + "Sessions"] = sessions;
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
    const found2 = /* @__PURE__ */ new Map(), UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const row of response.adopt) if (row && asked.has(row.pid) && typeof row.sessionId === "string" && UUID4.test(row.sessionId)) found2.set(row.pid, row.sessionId);
    return found2;
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
  async hostRefresh(machine2, agents2, { force }) {
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
      for (const agent of agents2) {
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
        const state2 = { ...actual, session: bound?.session || null, requestId: bound?.requestId || null, sourceId: source?.id || null, unbound: !bound, reason: !bound ? "No committed exact provider session binding." : !source ? "This session usage source is disabled or unavailable." : null };
        if (!source) state2.session = null;
        this.agentStates.set(agent.address, state2);
        for (const [id, record] of Object.entries(snapshot.proposals)) if (record.state === "committed" && record.ack.terminal.machine === machine2 && record.ack.terminal.address === actual.terminal.address && terminalKey(record.ack.terminal) !== terminalKey(actual.terminal)) await this.bindings.invalidate(id, "Terminal generation or foreground PID changed");
      }
      const candidates = agents2.map((agent) => [agent, this.agentStates.get(agent.address)]).filter(([, state2]) => Number.isSafeInteger(state2?.terminal?.foregroundPid) && Number.isSafeInteger(state2.terminal?.createdMs));
      const adopt = async (state2, source, sessionId) => {
        const session2 = { machine: machine2, provider: source.provider, credentialScope: source.credentialScope, providerRoot: source.providerRoot, sessionId };
        if (state2.requestId && state2.session && sessionKey(state2.session) !== sessionKey(session2)) {
          await this.bindings.invalidate(state2.requestId, "The running agent changed conversations");
          state2.requestId = null;
        }
        state2.session = session2;
        state2.sourceId = source.id;
        state2.adopted = true;
        state2.reason = null;
      };
      for (const [, state2] of candidates.filter(([, state3]) => state3.unbound)) {
        const argv = state2.raw.foreground?.argv;
        if (argv?.some((a) => a === "--last" || a === "--continue")) continue;
        const hit = argvSession(argv);
        if (!hit || !["codex", "grok"].includes(hit.provider)) continue;
        const matches = sources.filter((s) => s.provider === hit.provider);
        if (matches.length === 1) await adopt(state2, matches[0], hit.sessionId);
        else if (matches.length) state2.reason = `Several ${hit.provider} profiles are enabled on this machine; no session is chosen.`;
      }
      for (const provider of ["codex", "grok"]) {
        const entries = candidates.filter(([agent, state2]) => providerOf({ programKey: agent.program?.key, app: agent.app, argv: state2.raw.foreground?.argv, name: state2.raw.foreground?.name }) === provider);
        if (!entries.length) continue;
        const matches = sources.filter((s) => s.provider === provider);
        if (matches.length !== 1) {
          for (const [, state2] of entries) if (!state2.session) state2.reason = matches.length ? `Several ${provider} profiles are enabled on this machine; no session is chosen.` : `The ${provider} usage source is disabled or unavailable.`;
          continue;
        }
        const source = matches[0], inspect = provider === "codex" ? entries.filter(([, state2]) => parseCodexLabel(state2.raw.labels?.[CODEX_LABEL])) : entries;
        for (const [, state2] of entries) if (!state2.session && !inspect.some(([, s]) => s === state2)) state2.reason = "Codex has not reported its exact conversation. Use Set up Codex resume in Sources and trust the hook in Codex.";
        if (!inspect.length) continue;
        const facts = await hostFacts(this.io, { machine: machine2, terminals: inspect.map(([, state2]) => ({ address: localTerminalAddress(state2.raw.address, machine2), shellPid: state2.raw.pid, foregroundPid: state2.raw.foreground?.pid })), grokRoot: provider === "grok" ? source.providerRoot : null });
        if (this.closed) return;
        for (const [, state2] of inspect) {
          const f = facts.ok ? facts.terminals.get(localTerminalAddress(state2.raw.address, machine2)) : null, picked = f ? agentProcess(state2.raw.foreground, f.children) : null;
          const process = picked ? picked.pid === state2.raw.foreground?.pid ? f.foreground : f.children.find((c) => c.pid === picked.pid) : null;
          if (!process || !Number.isSafeInteger(process.startMs)) continue;
          const label2 = provider === "codex" ? parseCodexLabel(state2.raw.labels?.[CODEX_LABEL]) : null;
          const sessionId = provider === "codex" ? label2?.pid === process.pid && label2.startMs === process.startMs ? label2.sessionId : null : f.sessions.get(process.pid)?.grok?.sessionId;
          if (sessionId) await adopt(state2, source, sessionId);
        }
      }
      const claudeCandidates = candidates.filter(([, state2]) => claudeForeground(state2.raw));
      if (claudeCandidates.length) {
        const hits = /* @__PURE__ */ new Map();
        for (const source of sources.filter((s) => s.provider === "claude")) {
          if (this.closed) return;
          let found2;
          try {
            found2 = await this.adopt(source, claudeCandidates.map(([, state2]) => ({ pid: state2.terminal.foregroundPid, notBefore: state2.terminal.createdMs })));
          } catch {
            continue;
          }
          for (const [pid3, sessionId] of found2) {
            if (!hits.has(pid3)) hits.set(pid3, []);
            hits.get(pid3).push({ source, sessionId });
          }
        }
        for (const [, state2] of claudeCandidates) {
          const found2 = hits.get(state2.terminal.foregroundPid) || [];
          if (found2.length !== 1) {
            if (found2.length) state2.reason = "Several Claude Code profiles claim this process; no session is chosen.";
            continue;
          }
          await adopt(state2, found2[0].source, found2[0].sessionId);
        }
      }
      for (const [, state2] of candidates) {
        const source = sources.find((s) => s.id === state2.sourceId);
        if (!state2.session || !source) continue;
        if (!groups.has(source.id)) groups.set(source.id, { source, identities: /* @__PURE__ */ new Map() });
        groups.get(source.id).identities.set(sessionKey(state2.session), state2.session);
      }
      for (const group of groups.values()) try {
        await this.scanSource(group.source, [...group.identities.values()], { force });
      } catch (error2) {
        for (const state2 of this.agentStates.values()) if (state2.sourceId === group.source.id) {
          state2.session = null;
          state2.reason = "This provider metadata source or Python helper is unavailable.";
        }
      }
      for (const agent of agents2) {
        if (this.closed) return;
        const state2 = this.agentStates.get(agent.address);
        if (!state2?.session) continue;
        let actual;
        try {
          actual = await this.full(agent.address, machine2);
        } catch {
          this.agentStates.set(agent.address, { session: null, reason: "This agent’s terminal is no longer available." });
          continue;
        }
        const bound = await this.bindings.readCommitted(actual.terminal);
        if (this.closed) return;
        if (terminalKey(actual.terminal) !== terminalKey(state2.terminal) || !state2.adopted && (!bound || sessionKey(bound.session) !== sessionKey(state2.session))) {
          if (state2.requestId) await this.bindings.invalidate(state2.requestId, "Terminal identity changed during usage collection");
          state2.session = null;
          state2.reason = "Terminal identity changed while collecting usage.";
        }
      }
    } catch (error2) {
      if (this.closed) return;
      const tag = [error2?.code, error2?.name].find((v) => typeof v === "string" && /^[A-Za-z_]{2,40}$/.test(v)), code = tag ? " (" + tag + ")" : "";
      for (const agent of agents2) this.agentStates.set(agent.address, { session: null, reason: "Host, Python helper, source or exact terminal identity is unavailable" + code + "." });
    }
  }
  refresh(agents2 = this.io.agents(), { force = false } = {}) {
    if (this.closed) return Promise.resolve(/* @__PURE__ */ new Map());
    if (this.refreshing && this.clock() - this.refreshingAt < REFRESH_STALE_MS) return this.refreshing;
    this.refreshingAt = this.clock();
    const work = (async () => {
      await this.sources.refresh();
      const spaces2 = this.io.spaces(), groups = /* @__PURE__ */ new Map(), seen = /* @__PURE__ */ new Set();
      for (const source of this.sources.enabled()) if (!groups.has(JSON.stringify(source.machine))) groups.set(JSON.stringify(source.machine), { machine: source.machine, agents: [] });
      for (const agent of agents2) {
        seen.add(agent.address);
        const space = spaces2.find((s) => s.id === agent.space);
        if (!space) {
          this.agentStates.set(agent.address, { session: null, reason: "The agent space/machine is unavailable." });
          continue;
        }
        const machine2 = machineIdentity(space.machine), key2 = JSON.stringify(machine2);
        if (!groups.has(key2)) groups.set(key2, { machine: machine2, agents: [] });
        groups.get(key2).agents.push({ ...agent });
      }
      for (const address of this.agentStates.keys()) if (!seen.has(address)) this.agentStates.delete(address);
      await Promise.all([...groups.values()].map((group) => this.onHost(group.machine, () => this.hostRefresh(group.machine, group.agents, { force })).then(() => {
        if (!this.closed) this.publishReadings(agents2);
      })));
      return this.publishReadings(agents2);
    })();
    this.refreshing = work;
    work.finally(() => {
      if (this.refreshing === work) this.refreshing = null;
    }).catch(() => {
    });
    return work;
  }
  publishReadings(agents2) {
    const now = this.clock(), options = { now }, bySession = /* @__PURE__ */ new Map(), byAccount = /* @__PURE__ */ new Map(), shared2 = /* @__PURE__ */ new Map(), enabled = new Set(this.sources.enabled().map((s) => s.id));
    for (const value of this.observations.values()) for (const row of [...value.live, ...value.cache]) {
      if (!row.identity || !validateProviderObservation(row).ok) continue;
      const key2 = sessionKey(row.identity);
      if (!bySession.has(key2)) bySession.set(key2, []);
      bySession.get(key2).push(row);
      const quota = normalizeQuota(row, row.identity, options);
      if (quota.scope === "shared-account" && quota.state !== "unavailable") {
        const key3 = quotaKey(quota.identity);
        if (!byAccount.has(key3)) byAccount.set(key3, []);
        byAccount.get(key3).push(row);
      }
    }
    this.measurements.clear();
    for (const agent of agents2) {
      const state2 = this.agentStates.get(agent.address), identity = state2?.session;
      if (!identity || !enabled.has(state2.sourceId)) continue;
      const rows = bySession.get(sessionKey(identity)) || [], context = selectContext(rows, identity, options), own = selectQuota(rows, identity, options);
      let quota = own;
      if (own.scope === "shared-account" && own.state === "available") {
        const key2 = quotaKey(own.identity);
        if (!shared2.has(key2)) shared2.set(key2, selectQuota(byAccount.get(key2) || rows, identity, options));
        quota = shared2.get(key2);
      }
      this.measurements.set(agent.address, { context, quota, proofObservedAt: own.observedAt });
    }
    return this.readings(agents2);
  }
  reading(agent) {
    const state2 = this.agentStates.get(agent.address), value = this.measurements.get(agent.address), now = this.clock();
    if (!state2?.session || !value) {
      const reason = state2?.reason || "Exact session usage is not available yet.";
      return { context: { ...normalizeContext(null, null), reason }, quota: { ...normalizeQuota(null, null), reason } };
    }
    let { context, quota } = value;
    if (context.state === "available" && now - context.observedAt > CONTEXT_STALE_MS) context = { ...context, state: "stale", reason: "The exact context observation is older than two minutes." };
    if (quota.state === "available" && (now - quota.observedAt > QUOTA_STALE_MS || quota.windows.some((w) => w.resetsAt !== void 0 && w.resetsAt <= now) || quota.scope === "shared-account" && (value.proofObservedAt === null || now - value.proofObservedAt > QUOTA_STALE_MS))) quota = { ...quota, state: "stale", reason: "The quota observation or exact session account proof needs refreshing." };
    return { context, quota };
  }
  readings(agents2) {
    return new Map(agents2.map((agent) => [agent.address, this.reading(agent)]));
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
var tabKey2 = (tab) => JSON.stringify([machineIdentity(tab.machine), text5(tab.tabId, "tab ID")]);
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
      const t = tabKey2(r.currentTab);
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
    if (r.currentTab) draft.tabs[tabKey2(r.currentTab)] = id;
  }
  return draft;
}
var isConflict = (e) => ["STALE", "CONFLICT", "EAGAIN"].includes(e?.code) || /stale|contents?.*changed|expected.*match|compare.and.set/i.test(e?.message || "");
var NameOwnership = class {
  constructor(io, { clock = () => Date.now(), owner = "observer-" + Math.random().toString(36).slice(2) } = {}) {
    this.io = io;
    this.clock = clock;
    this.owner = owner;
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
    tabKey2({ machine: machine2, tabId });
    name(initialName);
    const exact = session2 ? sessionIdentity(session2) : null;
    const { result } = await this.edit((d) => {
      const old = d.origins[originId];
      if (exact && d.sessions[sessionKey(exact)] && d.sessions[sessionKey(exact)] !== originId) error("NAME_CONFLICT", "This exact session belongs to a different work origin");
      if (old?.session && exact && sessionKey(old.session) !== sessionKey(exact)) error("NAME_CONFLICT", "An origin cannot change its provider session");
      const owner = d.tabs[tabKey2({ machine: machine2, tabId })];
      if (owner && owner !== originId) error("NAME_CONFLICT", "The acknowledged tab belongs to another work origin");
      const sameTab = old?.currentTab && tabKey2(old.currentTab) === tabKey2({ machine: machine2, tabId });
      const record = { originId, ...old?.session || exact ? { session: old?.session || exact } : {}, currentTab: { machine: machineIdentity(machine2), tabId }, mode: old?.mode || "auto", manualName: old?.manualName ?? null, lastAutoName: sameTab ? old.lastAutoName : initialName, revision: (old?.revision ?? -1) + 1 };
      d.origins[originId] = record;
      return clone2(record);
    });
    return result;
  }
  async observeNames(tabs, { leaseMs = 5e3 } = {}) {
    if (!Number.isInteger(leaseMs) || leaseMs < 100 || leaseMs > 3e4) error("INVALID_NAMES", "Invalid observer lease duration");
    const snapshot = new Map(tabs.map((t) => [tabKey2({ machine: t.machine, tabId: t.id ?? t.tabId }), t]));
    const { result } = await this.edit((d) => {
      const now = this.clock();
      if (d.lease && d.lease.owner !== this.owner && d.lease.expiresAt > now) return { owned: false, changed: [] };
      d.lease = { owner: this.owner, expiresAt: now + leaseMs };
      const changed = [];
      for (const r of Object.values(d.origins)) {
        if (!r.currentTab) continue;
        const live = snapshot.get(tabKey2(r.currentTab));
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
    const find = () => getTabs().find((t) => tabKey2({ machine: t.machine, tabId: t.id ?? t.tabId }) === tabKey2(before.currentTab));
    const live = find();
    if (!live) return { applied: false, reason: "closed" };
    if (live.named && live.name !== before.lastAutoName && live.name !== before.manualName) return { applied: false, reason: "user-renamed" };
    const expectedName = live.name;
    const { result } = await this.edit((d) => {
      const r = d.origins[originId];
      if (!r || r.revision !== before.revision || tabKey2(r.currentTab) !== tabKey2(before.currentTab)) return false;
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

// src/shared/ui.js
import { div, svg, image } from "gpui-kit";
import { h_flex, v_flex, Input, InputState } from "gpui-base";
import { theme } from "herdr";
var palette = { chrome: "#101114", surface: "#17191d", border: "#2a2d33", foreground: "#e5e7eb", muted: "#91969f", dim: "#6b7079", accent: "#89b4fa", selected: "#253044" };
var colors = () => ({ ...palette, ...theme() });
var key = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function asset(mod, name2) {
  if (!key.test(mod) || !key.test(name2)) throw Error("Invalid local artwork identity");
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
function textButton(id, label2, action, { primary = false, disabled = false } = {}) {
  const t = colors();
  let el = h_flex().id(id).h(30).px(10).gap(6).items_center().justify_center().rounded(5).text_size(12).bg(primary ? t.selected : t.surface).border(1).border_color(t.border).text_color(disabled ? t.dim : primary ? t.accent : t.foreground).accessibility_label(label2).role("button");
  if (!disabled) el = el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(action);
  return el.child(label2);
}
var label = (value, { muted = false, size = 12 } = {}) => div().text_size(size).text_color(muted ? colors().muted : colors().foreground).truncate().child(value);
function statusDot(status, size = 5) {
  const t = colors();
  return div().size(size).rounded_full().flex_none().bg(t[status] || t.dim).tooltip(status || "Unknown");
}
function sectionHeader(mod, id, title, count, { collapsed = false, toggle, actions = [] } = {}) {
  return h_flex().h(32).gap(4).px(8).items_center().child(iconButton(mod, id + "-toggle", collapsed ? "chevron-right" : "chevron-down", `${collapsed ? "Expand" : "Collapse"} ${title}`, toggle)).child(label(title, { muted: true, size: 11 })).child(label(String(count ?? ""), { muted: true, size: 10 })).child(div().flex_1()).children(actions);
}
function createSearch(placeholder, onChange) {
  const state2 = InputState.new({ placeholder });
  state2.on("change", (_e, cx) => {
    onChange(state2.value(), cx);
    cx.notify();
  });
  return state2;
}
function searchInput(mod, id, state2) {
  const t = colors();
  return h_flex().id(id).h(30).gap(6).px(8).rounded(5).border(1).border_color(t.border).bg(t.chrome).items_center().child(icon(mod, "search", 13).text_color(t.dim)).child(Input.new(state2).flex_1().text_size(12).text_color(t.foreground));
}

// src/mods/mission-control-agents/main.js
var MOD = "mission-control-agents";
var STATE = "mission-control-agents-v1";
var clone3 = (value) => JSON.parse(JSON.stringify(value));
var state = () => {
  const value = herdr2.shared(STATE) || {};
  return { v: 1, collapsed: Boolean(value.collapsed), mode: value.mode === "spaces" ? "spaces" : "priority", query: typeof value.query === "string" ? value.query : "" };
};
var edit = (fn) => {
  const next = state();
  fn(next);
  herdr2.setShared(STATE, next);
};
var providerName = (key2) => ({ claude: "Claude Code", codex: "Codex", grok: "Grok" })[key2] || key2;
var MissionControlAgents = class extends View {
  init(_props, cx) {
    this.props = herdr2.props() || {};
    this.role = this.props.view || "list";
    this.closed = false;
    this.busy = false;
    this.error = null;
    this.timers = [];
    this.jobs = [];
    this.names = null;
    this.telemetry = new TelemetryBridge(MOD, herdr2);
    this.ownership = new NameOwnership(this.telemetry.io);
    this.inputs = [];
    if (this.role === "source-form") {
      try {
        this.form = validateUsageSource(this.props.source);
      } catch {
        this.role = "unavailable";
        this.error = "This usage source is unavailable. Reopen source settings.";
        return;
      }
      this.formId = this.props.sourceId;
      this.expected = this.props.fresh ? null : usageSourceFingerprint(this.form);
      this.profile = this.input(this.props.fresh ? "" : this.form.credentialScope, "Profile name");
      this.providerRoot = this.input(this.form.providerRoot, "Absolute provider root");
      this.rootInputs = this.form.roots.map((value) => this.input(value, "Absolute session metadata root"));
      this.cacheInputs = (this.form.cacheRoots || []).map((value) => this.input(value, "Explicit sanitized cache root"));
      this.spawn(cx, async () => this.telemetry.sources.refresh());
      return;
    }
    if (this.role === "sources") {
      this.loading = true;
      this.spawn(cx, async () => {
        try {
          await this.telemetry.sources.refresh();
        } finally {
          this.loading = false;
        }
      });
      this.spawn(cx, async () => this.telemetry.initializeSources());
      this.timers.push(cx.timer.every(2e3, (cx2) => this.pollSources(cx2)));
      return;
    }
    this.search = createSearch("Find an agent", (value) => edit((s) => {
      s.query = value;
    }));
    this.search.set_value(state().query);
    this.inputs.push(this.search);
    this.busy = true;
    this.spawn(cx, async () => {
      try {
        await this.telemetry.sources.refresh();
        await this.refreshData();
      } finally {
        this.busy = false;
      }
    });
    this.spawn(cx, async () => {
      await this.telemetry.initializeSources();
      if (!this.closed) await this.refreshData();
    });
    this.timers.push(cx.timer.every(3e4, (cx2) => this.refresh(cx2)));
    this.timers.push(cx.timer.every(2e3, (cx2) => this.pollSources(cx2)));
  }
  input(value, placeholder) {
    const input = InputState2.new({ placeholder });
    input.set_value(value);
    input.on("change", (_e, cx) => cx.notify());
    this.inputs.push(input);
    return input;
  }
  spawn(cx, work) {
    this.jobs = this.jobs.filter((job) => !job?.is_done?.());
    const task = cx.spawn(async (cx2) => {
      try {
        await work();
      } catch {
        this.error = "Usage sources or session readings are unavailable. Open source settings to inspect the configured paths.";
      }
      if (!this.closed) cx2.notify();
    });
    this.jobs.push(task);
    return task;
  }
  pollSources(cx) {
    if (this.closed || this.polling) return;
    this.polling = true;
    return this.spawn(cx, async () => {
      try {
        await this.telemetry.sources.refresh();
      } finally {
        this.polling = false;
      }
    });
  }
  async refreshData() {
    if (this.closed) return;
    try {
      this.names = (await this.ownership.read()).value;
    } catch {
      this.names = null;
    }
    const all = this.model({ query: "" });
    await this.telemetry.refresh(all.rows.map((row) => ({ ...row, address: row.address, space: row.space })));
  }
  refresh(cx) {
    if (this.closed || this.busy) return;
    this.busy = true;
    return this.spawn(cx, async () => {
      try {
        await this.refreshData();
      } finally {
        this.busy = false;
      }
    });
  }
  model(overrides = {}) {
    const s = { ...state(), ...overrides }, agents2 = herdr2.agents();
    return buildAgentModel({ agents: agents2, terminals: herdr2.terminals(), spaces: herdr2.spaces(), mode: s.mode, query: s.query, names: this.names, readings: this.telemetry.readings([...agents2, ...this.extraAgents()]) });
  }
  extraAgents() {
    return buildAgentModel({ agents: herdr2.agents(), terminals: herdr2.terminals(), spaces: herdr2.spaces() }).rows.filter((r) => !r.native);
  }
  openSources() {
    herdr2.openOverlay({ mod: MOD, kind: "dialog", width: 720, height: 660, props: { view: "sources" } });
  }
  openForm(id, source, { fresh = false } = {}) {
    herdr2.openOverlay({ mod: MOD, kind: "dialog", width: 720, height: 660, props: { view: "source-form", sourceId: fresh ? "custom-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2) : id, source: clone3(source), fresh } });
  }
  closeOverlay() {
    if (this.props.overlay) herdr2.closeOverlay(this.props.overlay);
  }
  field(id, title, input) {
    const t = colors();
    return v_flex2().gap(5).child(label(title, { muted: true, size: 11 })).child(Input2.new(input).id(id).h(31).px(8).bg(t.chrome).border(1).border_color(t.border).rounded(5).text_size(12).text_color(t.foreground));
  }
  sourceHeader(title) {
    return h_flex2().gap(8).items_center().child(label(title, { size: 15 })).child(div2().flex_1()).child(iconButton(MOD, "close-source-settings", "close", "Close", () => this.closeOverlay()));
  }
  toggleSource(id, source, cx) {
    if (this.busy) return;
    this.busy = true;
    this.error = null;
    return this.spawn(cx, async () => {
      try {
        await this.telemetry.sources.save(id, { ...source, enabled: !source.enabled }, { expectedFingerprint: usageSourceFingerprint(source) });
      } catch (error2) {
        this.error = error2.code === "SOURCE_CONFLICT" ? error2.message : "This usage source could not be saved. The original settings were preserved.";
      } finally {
        this.busy = false;
      }
    });
  }
  sourceList() {
    const t = colors(), sources = [...this.telemetry.sources.sources].map(([id, source]) => ({ id, ...source }));
    return v_flex2().id("usage-sources").size_full().p(18).gap(12).bg(t.surface).text_size(12).child(this.sourceHeader("Usage sources")).child(div2().text_size(11).text_color(t.muted).child("Read-only session metadata on each machine. Paths are shown below.")).child(v_flex2().flex_1().min_h(0).overflow_y_scrollbar().gap(8).children(sources.map((source) => v_flex2().id("source-" + source.id).p(10).gap(6).border(1).border_color(t.border).rounded(6).child(h_flex2().gap(8).items_center().child(label(providerName(source.provider))).child(label(source.machine || "This Mac", { muted: true, size: 10 })).child(div2().flex_1()).child(textButton("source-toggle-" + source.id, source.enabled ? "Enabled" : "Disabled", (_e, cx) => this.toggleSource(source.id, source, cx), { disabled: this.busy })).child(iconButton(MOD, "source-edit-" + source.id, "settings", "Edit source", () => this.openForm(source.id, source))).child(iconButton(MOD, "source-copy-" + source.id, "plus", "Add profile on this machine", () => this.openForm(source.id, source, { fresh: true })))).child(label("Profile: " + source.credentialScope, { muted: true, size: 10 })).children([...source.roots, ...source.cacheRoots || []].map((root) => div2().text_size(10).text_color(t.dim).truncate().tooltip(root).child(root))))).when(!sources.length, (e) => e.child(div2().p(12).text_color(t.muted).child(this.loading ? "Discovering metadata sources…" : "No supported metadata sources were found on the connected machines."))).children([...this.telemetry.sourceErrors].map(([machine2, message]) => div2().text_color(t.muted).child((JSON.parse(machine2) || "This Mac") + ": " + message)))).when(Boolean(this.error), (e) => e.child(div2().text_size(11).text_color(t.blocked).child(this.error))).child(div2().text_size(10).text_color(t.dim).child("Changing or disabling a source clears its readings until that session is identified again."));
  }
  pathRows(title, kind, inputs) {
    const t = colors();
    return v_flex2().gap(6).child(h_flex2().gap(8).items_center().child(label(title, { muted: true, size: 11 })).child(div2().flex_1()).child(iconButton(MOD, "add-" + kind, "plus", "Add " + title.toLowerCase(), (_e, cx) => {
      if (inputs.length >= (kind === "cache" ? 4 : 8)) return;
      inputs.push(this.input("", "Absolute metadata directory"));
      cx.notify();
    }))).children(inputs.map((input, index2) => h_flex2().gap(6).items_center().child(div2().flex_1().child(Input2.new(input).id(kind + "-" + index2).h(31).px(8).border(1).border_color(t.border).rounded(5).bg(t.chrome).text_size(11).text_color(t.foreground))).child(iconButton(MOD, "remove-" + kind + "-" + index2, "close", "Remove path", (_e, cx) => {
      inputs.splice(index2, 1);
      this.inputs = this.inputs.filter((value) => value !== input);
      input.release();
      cx.notify();
    }, { disabled: kind === "roots" && inputs.length === 1 }))));
  }
  saveSource(cx) {
    if (this.busy) return;
    this.busy = true;
    this.error = null;
    const next = { ...this.form, credentialScope: this.profile.value().trim(), providerRoot: this.providerRoot.value(), roots: this.rootInputs.map((v) => v.value()), cacheRoots: this.cacheInputs.map((v) => v.value()) };
    return this.spawn(cx, async () => {
      try {
        await this.telemetry.sources.save(this.formId, next, { expectedFingerprint: this.expected });
        this.closeOverlay();
      } catch (error2) {
        this.error = error2.code ? error2.message : "The source could not be saved. The original settings were preserved.";
      } finally {
        this.busy = false;
      }
    });
  }
  sourceForm() {
    const t = colors();
    return v_flex2().id("usage-source-form").size_full().p(18).gap(12).bg(t.surface).text_size(12).child(this.sourceHeader(this.props.fresh ? "Add metadata profile" : "Edit usage source")).child(label(providerName(this.form.provider) + " · " + (this.form.machine || "This Mac"), { muted: true, size: 11 })).child(v_flex2().flex_1().min_h(0).overflow_y_scrollbar().gap(13).child(this.field("source-profile", "Profile name", this.profile)).child(this.field("source-provider-root", "Provider root", this.providerRoot)).child(this.pathRows("Session roots", "roots", this.rootInputs)).child(this.pathRows("Sanitized cache roots (optional)", "cache", this.cacheInputs))).when(Boolean(this.error), (e) => e.child(div2().text_size(11).text_color(t.blocked).child(this.error))).child(textButton("save-usage-source", this.busy ? "Saving…" : "Save source", (_e, cx) => this.saveSource(cx), { primary: true, disabled: this.busy }));
  }
  reading(labelText, value) {
    const t = colors(), known = (value.state === "available" || value.state === "stale") && Number.isFinite(value.percent), stale = value.state === "stale", text6 = known ? (value.estimated ? "~" : "") + Math.round(value.percent) + "%" : stale ? "Stale" : "Unavailable";
    return h_flex2().flex_1().min_w(0).gap(4).items_center().text_size(9).tooltip(value.scope || value.reason).child(div2().text_color(t.dim).child(labelText)).child(div2().truncate().text_color(known && !stale && value.percent < 15 ? t.blocked : known && stale ? t.dim : t.muted).child(text6));
  }
  row(row) {
    const t = colors(), active = row.focused || herdr2.focused()?.agent === row.address;
    let element = v_flex2().id("agent-" + row.address).pl(7 + Math.min(row.depth, 4) * 10).pr(7).py(6).gap(3).rounded(5).bg(active ? t.selected : "#00000000").tooltip(row.title + " · " + row.spaceName + " · " + (row.machine || "This Mac")).role("button").accessibility_label(row.title);
    if (row.focus) element = element.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => herdr2.run(row.focus.command, row.focus.args));
    return element.child(h_flex2().h(17).gap(7).items_center().child(toolIcon(MOD, row.program, 15)).child(div2().flex_1().min_w(0).truncate().text_color(t.foreground).child(row.title)).child(statusDot(row.status))).child(h_flex2().h(13).gap(7).items_center().child(div2().w(15)).child(div2().flex_1().min_w(0).text_size(9).text_color(t.dim).truncate().child(row.spaceName + (row.machine ? " · " + row.machine : "")))).child(h_flex2().h(14).gap(8).items_center().child(this.reading(row.depth ? "Ctx" : "Context", row.context)).child(this.reading("Quota", row.quota)));
  }
  render(cx) {
    if (this.role === "unavailable") return v_flex2().size_full().p(18).gap(12).bg(colors().surface).child(this.sourceHeader("Usage source unavailable")).child(label(this.error, { muted: true }));
    if (this.role === "sources") return this.sourceList();
    if (this.role === "source-form") return this.sourceForm();
    const t = colors(), s = state(), model = this.model();
    herdr2.setAgentOrder(model.navigation);
    return v_flex2().id("agents-list").size_full().min_h(0).bg(t.chrome).text_size(12).child(sectionHeader(MOD, "agents", "Agents", model.count, { collapsed: s.collapsed, toggle: () => edit((s2) => {
      s2.collapsed = !s2.collapsed;
    }), actions: [iconButton(MOD, "agents-priority", "priority", "Priority", () => edit((s2) => {
      s2.mode = "priority";
    }), { active: s.mode === "priority", size: 24 }), iconButton(MOD, "agents-spaces", "spaces", "Group by space", () => edit((s2) => {
      s2.mode = "spaces";
    }), { active: s.mode === "spaces", size: 24 }), iconButton(MOD, "agents-sources", "settings", "Usage sources", () => this.openSources(), { size: 24 })] })).when(!s.collapsed, (e) => e.child(div2().px(10).pb(6).child(searchInput(MOD, "agent-search", this.search))).child(v_flex2().id("agent-groups").flex_1().min_h(0).px(7).pb(7).gap(5).overflow_y_scrollbar().children(model.groups.map((group) => v_flex2().gap(1).child(h_flex2().h(23).px(4).gap(6).items_center().child(label(group.label, { muted: true, size: 10 })).when(Boolean(group.machine), (e2) => e2.child(label(group.machine, { muted: true, size: 9 })))).children(group.rows.map((row) => this.row(row)))))).when(!model.rows.length, (e2) => e2.child(div2().p(12).text_size(11).text_color(t.dim).child(model.count ? "No matching agents." : "No agents running."))));
  }
  close() {
    this.closed = true;
    for (const timer of this.timers) timer?.cancel?.();
    for (const job of this.jobs) job?.cancel?.();
    this.telemetry.close();
    for (const input of this.inputs) input.release();
  }
};
export {
  MissionControlAgents as default
};
