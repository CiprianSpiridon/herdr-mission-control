// src/mods/mission-control-reopen/main.js
import { View, div as div2 } from "gpui-kit";
import { v_flex as v_flex2, h_flex as h_flex2 } from "gpui-base";
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
function createConfigIO(herdr2) {
  return {
    ...herdr2,
    async ensureDirectory(directory) {
      const result = await herdr2.exec("mkdir", ["-p", directory]);
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

// src/shared/launch-preferences.js
var key = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/;
var fail3 = (message) => {
  throw new ConfigError("INVALID_LAUNCH_PREFERENCES", message);
};
var object2 = (v) => v && typeof v === "object" && !Array.isArray(v);
var bounded = (v, name2, max = 512) => {
  if (typeof v !== "string" || !v.trim() || v.length > max || /[\u0000-\u001f]/.test(v)) fail3(`Invalid ${name2}`);
  return v;
};
function validateToolOptions(value = {}) {
  if (!object2(value)) fail3("Tool options must be an object");
  for (const name2 of Object.keys(value)) if (!["model", "reasoning", "instructions", "skill", "subagents"].includes(name2)) fail3(`Unsupported tool option: ${name2}`);
  const result = {};
  if (value.model !== void 0) result.model = bounded(value.model, "model", 256);
  if (value.reasoning !== void 0) result.reasoning = bounded(value.reasoning, "reasoning", 32);
  if (value.instructions !== void 0) {
    if (typeof value.instructions !== "string" || value.instructions.length > 16e3 || value.instructions.includes("\0")) fail3("Invalid instructions");
    result.instructions = value.instructions;
  }
  if (value.skill !== void 0) result.skill = bounded(value.skill, "skill", 128);
  if (value.subagents !== void 0) {
    if (typeof value.subagents !== "boolean") fail3("Subagent preference must be boolean");
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
var fail4 = (code, message) => {
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
  if (!installedTools([tool]).length) fail4("TOOL_UNAVAILABLE", "The selected tool is not installed on this machine");
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
  if (!installedTools([tool]).length) fail4("TOOL_UNAVAILABLE", "The selected tool is not installed on this machine");
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
  if (!capabilities?.base || !Array.isArray(capabilities.run) || !capabilities.run.length) fail4("TOOL_UNAVAILABLE", "No installed launch command");
  const requested = validateToolOptions(options), argv = [...capabilities.run];
  if (resumeSessionId && newSessionId) fail4("INVALID_OPTIONS", "Resume and new session ID are mutually exclusive");
  const requireOption = (enabled, name2) => {
    if (!enabled) fail4("UNSUPPORTED_OPTION", `${name2} is unavailable for this installed tool/version`);
  };
  if (capabilities.foregroundFlag) argv.push(capabilities.foregroundFlag);
  if (resumeSessionId) {
    requireOption(capabilities.resume, "Exact session resume");
    if (!uuid.test(resumeSessionId)) fail4("INVALID_SESSION", "Resume requires an exact provider session UUID");
    if (capabilities.resume.kind === "command") argv.push(capabilities.resume.command, resumeSessionId);
    else argv.push(capabilities.resume.flag, resumeSessionId);
  }
  if (newSessionId) {
    requireOption(capabilities.callerSession, "Caller-assigned session ID");
    if (!uuid.test(newSessionId)) fail4("INVALID_SESSION", "A valid provider session UUID is required");
    argv.push(capabilities.callerSession, newSessionId);
  }
  if (requested.model) {
    requireOption(capabilities.model, "Model selection");
    argv.push(capabilities.model, requested.model);
  }
  if (requested.reasoning) {
    requireOption(capabilities.reasoning, "Reasoning selection");
    const r = capabilities.reasoning;
    if (r.values && !r.values.includes(requested.reasoning)) fail4("UNSUPPORTED_OPTION", "Unsupported reasoning value");
    argv.push(r.flag, requested.reasoning);
  }
  if (requested.instructions) {
    requireOption(capabilities.instructions, "Custom instructions");
    argv.push(capabilities.instructions, requested.instructions);
  }
  if (requested.skill) fail4("UNSUPPORTED_OPTION", "This tool has no verified command-line skill selector");
  if (requested.subagents !== void 0) {
    requireOption(capabilities.subagents, "Subagent selection");
    if (!requested.subagents) argv.push(capabilities.subagents.disable);
  }
  if (prompt !== void 0) {
    requireOption(capabilities.prompt, "Initial prompt");
    if (typeof prompt !== "string" || prompt.includes("\0") || prompt.length > 64e3) fail4("INVALID_OPTIONS", "Invalid task text");
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
    if (!installedTools([tool]).length) fail4("TOOL_UNAVAILABLE", "The selected tool is no longer installed");
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
var fail5 = (code, message) => {
  throw new WorktreeError(code, message);
};
var copy2 = (v) => JSON.parse(JSON.stringify(v));
var text2 = (v, label2, max = 512) => {
  if (typeof v !== "string" || !v || v.length > max || /[\u0000-\u001f]/.test(v)) fail5("INVALID_WORKTREE", `Invalid ${label2}`);
  return v;
};
function requestDigest(value) {
  text2(value, "request ID", 256);
  let a = 2166136261, b = 2654435769;
  for (let i = 0; i < value.length; i++) {
    a = Math.imul(a ^ value.charCodeAt(i), 16777619);
    b = Math.imul(b ^ value.charCodeAt(i), 2246822519);
  }
  return [a >>> 0, b >>> 0].map((n) => n.toString(16).padStart(8, "0")).join("").slice(0, 12);
}
function slug(value, max = 64) {
  text2(value, "worktree name");
  const v = value.normalize("NFKD").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/, "");
  if (!v || v === "." || v === "..") fail5("INVALID_WORKTREE", "Worktree name has no safe characters");
  return v;
}
function sourceIdentity(source) {
  if (!source) return null;
  for (const field of ["kind", "connectionId", "site", "id", "key"]) text2(source[field], `source ${field}`, field === "site" ? 2048 : 512);
  if (!["jira", "github", "github-pr", "gitlab", "gitlab-mr"].includes(source.kind) || !/^https:\/\/[^\s/@?#]+\/?$/.test(source.site)) fail5("INVALID_WORKTREE", "Unsupported tracker source identity");
  if (source.url !== void 0 || ["gitlab", "gitlab-mr"].includes(source.kind)) {
    text2(source.url, "source URL", 2048);
    if (!/^https:\/\/[^\s@]+$/.test(source.url)) fail5("INVALID_WORKTREE", "Unsupported tracker source URL");
  }
  return JSON.stringify([source.kind, source.connectionId, source.site, source.id]);
}
function requestShape(request) {
  if (!request || typeof request.worktree !== "boolean") fail5("INVALID_WORKTREE", "A boolean worktree choice is required");
  text2(request.requestId, "request ID", 256);
  text2(request.originId, "origin ID", 256);
  if (!request.source && request.checkoutRoot === void 0) fail5("INVALID_WORKTREE", "Generic launches require the captured checkoutRoot");
  const machine2 = machineIdentity(request.machine), repoRoot = canonicalRepoPath(request.repoRoot), checkoutRoot = canonicalRepoPath(request.checkoutRoot ?? request.repoRoot), sourceKey = sourceIdentity(request.source);
  if (!request.worktree && (request.worktreePath !== void 0 || request.branch !== void 0)) fail5("INVALID_WORKTREE", "Worktree path/branch overrides require a new worktree");
  if (request.worktreePath !== void 0) canonicalRepoPath(request.worktreePath);
  if (request.branch !== void 0) {
    text2(request.branch, "branch", 200);
    if (request.branch.startsWith("-")) fail5("INVALID_WORKTREE", "Invalid branch");
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
  if (typeof exec !== "function") fail5("UNSUPPORTED_HOST", "Target-host execution is unavailable");
  let r;
  try {
    r = await exec("python3", ["-c", HELPER, JSON.stringify(query)], { on: machine2 });
  } catch {
    fail5("UNSUPPORTED_HOST", "Python/Git could not run on the selected machine");
  }
  if (r.code !== 0) fail5("WORKTREE_ERROR", "The target-host worktree helper failed");
  let result;
  try {
    result = JSON.parse(r.stdout);
  } catch {
    fail5("WORKTREE_ERROR", "Invalid target-host worktree response");
  }
  if (!result.ok) fail5(result.code || "WORKTREE_ERROR", result.message || "Worktree operation failed");
  return result;
}
async function prepareWorktree(request, { spaceName, exec } = {}) {
  const shape = requestShape(request);
  if (!request.worktree) {
    await validateCheckout(shape, exec);
    return { v: 1, requestId: request.requestId, originId: request.originId, ...shape, path: shape.checkoutRoot, worktree: false };
  }
  const leaf = slug(spaceName || request.spaceId || "space", 48) + "-" + (request.source ? slug(request.source.key, 64) : "task-" + requestDigest(request.requestId));
  const parent = shape.repoRoot.slice(0, shape.repoRoot.lastIndexOf("/")) || "/";
  const target = request.worktreePath ? canonicalRepoPath(request.worktreePath) : `${parent === "/" ? "" : parent}/.herdr-worktrees/${leaf}`;
  const branch = request.branch || `mission-control/${leaf}`;
  const result = await execute(exec, shape.machine, { action: "prepare", requestId: request.requestId, originId: request.originId, ...shape, path: target, branch, leaf });
  return { ...result.spec, worktree: true };
}
async function ensureWorktree(request, captured, { exec } = {}) {
  const shape = requestShape(request), spec = copy2(captured);
  if (spec?.v !== 1 || spec.requestId !== request.requestId || spec.originId !== request.originId || spec.machine !== shape.machine || spec.repoRoot !== shape.repoRoot || spec.checkoutRoot !== shape.checkoutRoot || spec.sourceKey !== shape.sourceKey || spec.worktree !== request.worktree) fail5("RETRY_CHANGED", "The request differs from its immutable captured worktree");
  if (request.worktreePath !== void 0 && canonicalRepoPath(request.worktreePath) !== spec.path || request.branch !== void 0 && request.branch !== spec.branch) fail5("RETRY_CHANGED", "Captured worktree path/ref cannot change on retry");
  if (!spec.worktree) {
    await validateCheckout(shape, exec);
    return { ok: true, folder: shape.checkoutRoot, reused: true, spec };
  }
  if (typeof spec.base !== "string" || !/^[a-f0-9]{40,64}$/.test(spec.base) || typeof spec.branch !== "string") fail5("INVALID_WORKTREE", "Invalid captured worktree");
  const payload = { ...spec };
  delete payload.worktree;
  return execute(exec, shape.machine, { action: "create", repoRoot: shape.repoRoot, spec: payload });
}
async function validateCheckout(shape, exec) {
  const read = async (cwd, args) => {
    const r = await exec("git", args, { cwd, on: shape.machine });
    if (r.code !== 0) fail5("CHECKOUT_MISMATCH", "The captured checkout is unavailable");
    return canonicalRepoPath(r.stdout.trim());
  };
  const main = await read(shape.repoRoot, ["rev-parse", "--show-toplevel"]), checkout = await read(shape.checkoutRoot, ["rev-parse", "--show-toplevel"]);
  if (main !== shape.repoRoot || checkout !== shape.checkoutRoot) fail5("CHECKOUT_MISMATCH", "The captured checkout root changed");
  const a = await read(main, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), b = await read(checkout, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (a !== b) fail5("CHECKOUT_MISMATCH", "The selected checkout belongs to a different canonical repository");
}

// src/shared/session-bindings.js
var clone = (v) => JSON.parse(JSON.stringify(v));
var fail6 = (code, message) => {
  throw new ConfigError(code, message);
};
var text3 = (v, label2, max = 256) => {
  if (typeof v !== "string" || !v || v.length > max || ["__proto__", "prototype", "constructor"].includes(v) || /[\u0000-\u001f]/.test(v)) fail6("INVALID_BINDING", `Invalid ${label2}`);
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
var conflict = (e) => ["STALE", "CONFLICT", "EAGAIN"].includes(e?.code) || /stale|contents?.*changed|expected.*match|compare.and.set/i.test(e?.message || "");
function validateAck(ack2) {
  text3(ack2?.tabId, "acknowledged tab ID");
  terminalKey(ack2?.terminal);
  return clone(ack2);
}
function validateProof(proof, session, terminal3) {
  if (!proof || !proofKinds.has(proof.kind) || !time(proof.observedAt) || typeof proof.sourceDigest !== "string" || !proof.sourceDigest || proof.sourceDigest.length > 512) fail6("UNPROVEN_SESSION", "Exact provider-session evidence is required");
  if (!proof.session || sessionKey(proof.session) !== sessionKey(session) || terminalKey(proof.terminal) !== terminalKey(terminal3) || session.machine !== terminal3.machine) fail6("UNPROVEN_SESSION", "Session proof does not match the exact host/session/terminal generation");
  return clone(proof);
}
function indexes(d) {
  const result = {};
  for (const [id, r] of Object.entries(d.proposals)) if (r.state === "committed") {
    const key3 = terminalKey(r.ack.terminal);
    if (result[key3]) fail6("BINDING_CONFLICT", "A terminal generation cannot belong to two work origins");
    result[key3] = id;
  }
  d.terminals = result;
  return d;
}
function validateBindingStore(value) {
  if (!value || value.v !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 || !value.proposals || !value.terminals || Array.isArray(value.proposals) || Array.isArray(value.terminals)) fail6("INVALID_BINDING", "Invalid binding store; original preserved");
  const d = clone(value);
  for (const [id, r] of Object.entries(d.proposals)) {
    text3(id, "request ID");
    text3(r.originId, "origin ID");
    if (!["proposed", "commit-pending", "committed", "invalidated"].includes(r.state) || !time(r.createdAt) || !time(r.updatedAt) || r.updatedAt < r.createdAt) fail6("INVALID_BINDING", "Invalid binding state/timestamps");
    if (r.session !== null) r.session = sessionIdentity(r.session);
    if (r.state === "proposed" || r.state === "commit-pending") {
      if (!time(r.expiresAt) || r.expiresAt < r.createdAt || r.invalidatedAt !== null) fail6("INVALID_BINDING", "Uncommitted proposal needs its own TTL");
    } else if (r.expiresAt !== null) fail6("INVALID_BINDING", "Committed/invalidated records do not expire by age");
    if (r.state === "invalidated") {
      if (!time(r.invalidatedAt) || r.invalidatedAt < r.createdAt || r.invalidatedAt > r.updatedAt) fail6("INVALID_BINDING", "Invalid first-invalidation timestamp");
    } else if (r.invalidatedAt !== null) fail6("INVALID_BINDING", "Unexpected invalidation timestamp");
    if (r.state === "committed" || r.state === "commit-pending") {
      validateAck(r.ack);
      if (r.session) validateProof(r.proof, r.session, r.ack.terminal);
    } else if (r.ack) validateAck(r.ack);
  }
  const expected = indexes(clone(d)).terminals;
  if (Object.keys(expected).length !== Object.keys(d.terminals).length || Object.entries(expected).some(([k, id]) => d.terminals[k] !== id)) fail6("INVALID_BINDING", "Terminal index does not match retained committed records");
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
  if (Object.keys(d.proposals).length > 500 || bytes(JSON.stringify(d)) > 768 * 1024) fail6("BINDING_CAPACITY", "Session binding storage is full. Reconcile closed terminals or archive recovered requests; active mappings were preserved.");
}
function argvSessionProof({ capabilities, session, terminal: terminal3, argv, kind, observedAt, sourceDigest }) {
  const s = sessionIdentity(session);
  terminalKey(terminal3);
  if (capabilities?.machine !== s.machine || capabilities.provider !== s.provider || !Array.isArray(argv) || !Array.isArray(capabilities.run) || !capabilities.run.every((v, i) => argv[i] === v)) fail6("UNPROVEN_SESSION", "Launch command/provider/host does not match session evidence");
  let marker;
  if (kind === "caller-session-id") marker = capabilities.callerSession;
  else if (kind === "resume-argv") marker = capabilities.resume?.kind === "command" ? capabilities.resume.command : capabilities.resume?.flag;
  else fail6("UNPROVEN_SESSION", "This proof requires caller-assigned or exact resume argv");
  const at = marker ? argv.indexOf(marker, capabilities.run.length) : -1;
  if (at < 0 || argv[at + 1] !== s.sessionId || argv.includes("--last") || argv.includes("--continue")) fail6("UNPROVEN_SESSION", "The exact session ID is absent from verified launch argv");
  return validateProof({ kind, session: s, terminal: clone(terminal3), observedAt, sourceDigest }, s, terminal3);
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
    if (!time(n)) fail6("INVALID_CLOCK", "The binding clock is unavailable");
    return n;
  }
  async read() {
    const raw = await this.io.readTextFile(this.path);
    if (raw === null) return { raw, value: empty() };
    if (typeof raw !== "string" || bytes(raw) > 768 * 1024) fail6("BINDING_CAPACITY", "Binding file exceeds its supported size");
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      fail6("INVALID_BINDING", "Binding JSON is invalid; original preserved");
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
      if (!Number.isSafeInteger(draft.revision)) fail6("BINDING_CAPACITY", "Binding revision exhausted");
      const next = validateBindingStore(indexes(draft));
      capacity(next);
      await this.io.ensureDirectory?.(this.path.slice(0, this.path.lastIndexOf("/")));
      try {
        await this.io.writeTextFile(this.path, JSON.stringify(next) + "\n", raw);
        return { value: next, result };
      } catch (e) {
        if (!conflict(e)) throw e;
      }
    }
    fail6("CONFLICT", "Binding state changed repeatedly; retry the acknowledged commit without launching again");
  }
  async propose({ requestId, originId, session = null }, { recoveryRecorded = [] } = {}) {
    text3(requestId, "request ID");
    text3(originId, "origin ID");
    const exact = session ? sessionIdentity(session) : null;
    return (await this.edit((d, now3) => {
      const old = d.proposals[requestId];
      if (old) {
        if (old.originId !== originId || JSON.stringify(old.session) !== JSON.stringify(exact)) fail6("BINDING_CONFLICT", "A request cannot change its origin or exact session");
        if (old.state === "invalidated" || ["proposed", "commit-pending"].includes(old.state) && old.expiresAt <= now3) fail6("RECOVERY_REQUIRED", "The interrupted request needs recovery; do not launch it again");
        return clone(old);
      }
      const record2 = { originId, session: exact, state: "proposed", createdAt: now3, updatedAt: now3, invalidatedAt: null, expiresAt: now3 + 3e5 };
      d.proposals[requestId] = record2;
      return clone(record2);
    }, { recoveryRecorded })).result;
  }
  async transition(requestId, ack2, proof, { pending = false, session } = {}) {
    validateAck(ack2);
    const exact = session ? sessionIdentity(session) : null;
    return (await this.edit((d, now3) => {
      const r = d.proposals[requestId];
      if (!r || r.state === "invalidated") fail6("RECOVERY_REQUIRED", "No active proposal exists for this acknowledged launch");
      if (r.state !== "committed" && r.expiresAt <= now3) fail6("RECOVERY_REQUIRED", "Acknowledged launch proposal expired; retain it for explicit recovery");
      if (now3 < r.updatedAt) fail6("INVALID_CLOCK", "The binding clock moved backwards");
      const selected = r.session || exact;
      if (r.session && exact && sessionKey(r.session) !== sessionKey(exact)) fail6("BINDING_CONFLICT", "A committed request cannot change provider sessions");
      if (selected) validateProof(proof, selected, ack2.terminal);
      if (r.ack && (r.ack.tabId !== ack2.tabId || terminalKey(r.ack.terminal) !== terminalKey(ack2.terminal))) fail6("BINDING_CONFLICT", "Acknowledgment belongs to a different tab/terminal generation");
      if (r.state === "committed" && r.session && selected && sessionKey(r.session) === sessionKey(selected)) return clone(r);
      if (r.state === "committed" && pending) return clone(r);
      r.session = selected || null;
      r.state = pending ? "commit-pending" : "committed";
      r.updatedAt = now3;
      r.expiresAt = pending ? r.expiresAt : null;
      r.ack = clone(ack2);
      if (selected) r.proof = clone(proof);
      return clone(r);
    })).result;
  }
  commitAcknowledged(requestId, ack2, proof, options) {
    return this.transition(requestId, ack2, proof, options);
  }
  markCommitPending(requestId, ack2, proof, options = {}) {
    return this.transition(requestId, ack2, proof, { ...options, pending: true });
  }
  async readCommitted(terminal3) {
    const { value } = await this.read(), id = value.terminals[terminalKey(terminal3)], r = id ? value.proposals[id] : null;
    return r?.state === "committed" && r.session ? { requestId: id, ...clone(r) } : null;
  }
  async requestState(requestId) {
    const { value } = await this.read(), r = value.proposals[requestId];
    return r ? { ...clone(r), recoveryRequired: ["proposed", "commit-pending"].includes(r.state) && r.expiresAt <= this.now() } : null;
  }
  async invalidate(requestId, reason = "Exact generation/source no longer valid") {
    text3(reason, "invalidation reason", 512);
    return (await this.edit((d, now3) => {
      const r = d.proposals[requestId];
      if (!r) return null;
      if (now3 < r.updatedAt) fail6("INVALID_CLOCK", "The binding clock moved backwards");
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
    const generations2 = /* @__PURE__ */ new Map();
    for (const raw of raws) {
      const identity = terminalIdentity(raw, on);
      generations2.set(identity.address, identity);
    }
    return (await this.edit((d, now3) => {
      const invalidated = [];
      for (const [id, r] of Object.entries(d.proposals)) {
        if (r.state !== "committed" || r.ack.terminal.machine !== on) continue;
        const actual = generations2.get(r.ack.terminal.address), changed = actual && terminalKey(actual) !== terminalKey(r.ack.terminal), missing = !actual && authoritative;
        const disabled = r.session && enabledSources && !enabledSources.some((s) => s.machine === r.session.machine && s.provider === r.session.provider && s.credentialScope === r.session.credentialScope && s.providerRoot === r.session.providerRoot);
        if (changed || missing || disabled) {
          if (now3 < r.updatedAt) fail6("INVALID_CLOCK", "The binding clock moved backwards");
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
        if (now3 < r.updatedAt) fail6("INVALID_CLOCK", "The binding clock moved backwards");
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

// src/shared/name-ownership.js
var clone2 = (v) => JSON.parse(JSON.stringify(v));
var error = (code, message) => {
  throw new ConfigError(code, message);
};
var text4 = (v, label2, max = 256) => {
  if (typeof v !== "string" || !v || v.length > max || ["__proto__", "prototype", "constructor"].includes(v) || /[\u0000-\u001f]/.test(v)) error("INVALID_NAMES", `Invalid ${label2}`);
  return v;
};
var tabKey = (tab) => JSON.stringify([machineIdentity(tab.machine), text4(tab.tabId, "tab ID")]);
var name = (v) => v === null ? null : text4(v, "tab name", 512);
var empty2 = () => ({ v: 1, revision: 0, origins: {}, sessions: {}, tabs: {}, lease: null });
function validate(value) {
  if (!value || value.v !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 || !value.origins || !value.sessions || !value.tabs) error("INVALID_NAMES", "Invalid name ownership file; original preserved");
  const next = clone2(value), sessions = {}, tabs = {};
  if (Object.keys(next.origins).length > 5e3) error("NAME_CAPACITY", "Too many retained names; archive old origins before adding more");
  for (const [id, r] of Object.entries(next.origins)) {
    if (id !== r.originId || !["auto", "manual"].includes(r.mode) || !Number.isSafeInteger(r.revision) || r.revision < 0) error("INVALID_NAMES", "Invalid name ownership record");
    text4(id, "origin ID");
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
  async find({ originId, session } = {}) {
    const { value } = await this.read();
    const id = originId || (session ? value.sessions[sessionKey(session)] : null);
    return id && value.origins[id] ? clone2(value.origins[id]) : null;
  }
  async transferToAcknowledgedTab({ originId, session }, { machine: machine2 = null, tabId, name: initialName = null }) {
    text4(originId, "origin ID");
    tabKey({ machine: machine2, tabId });
    name(initialName);
    const exact = session ? sessionIdentity(session) : null;
    const { result } = await this.edit((d) => {
      const old = d.origins[originId];
      if (exact && d.sessions[sessionKey(exact)] && d.sessions[sessionKey(exact)] !== originId) error("NAME_CONFLICT", "This exact session belongs to a different work origin");
      if (old?.session && exact && sessionKey(old.session) !== sessionKey(exact)) error("NAME_CONFLICT", "An origin cannot change its provider session");
      const owner2 = d.tabs[tabKey({ machine: machine2, tabId })];
      if (owner2 && owner2 !== originId) error("NAME_CONFLICT", "The acknowledged tab belongs to another work origin");
      const sameTab = old?.currentTab && tabKey(old.currentTab) === tabKey({ machine: machine2, tabId });
      const record2 = { originId, ...old?.session || exact ? { session: old?.session || exact } : {}, currentTab: { machine: machineIdentity(machine2), tabId }, mode: old?.mode || "auto", manualName: old?.manualName ?? null, lastAutoName: sameTab ? old.lastAutoName : initialName, revision: (old?.revision ?? -1) + 1 };
      d.origins[originId] = record2;
      return clone2(record2);
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

// src/shared/launch.js
var clone3 = (v) => JSON.parse(JSON.stringify(v));
var LaunchError = class extends Error {
  constructor(code, message, recovery) {
    super(message);
    this.code = code;
    this.recovery = recovery;
  }
};
var fail7 = (code, message, recovery) => {
  throw new LaunchError(code, message, recovery);
};
var text5 = (v, name2, max = 256) => {
  if (typeof v !== "string" || !v || v.length > max || ["__proto__", "constructor", "prototype"].includes(v) || /[\u0000-\u001f]/.test(v)) fail7("INVALID_LAUNCH", `Invalid ${name2}`);
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
  if (!value || typeof value !== "object") fail7("INVALID_LAUNCH", "Missing launch request");
  const r = clone3(value);
  for (const f of ["requestId", "idempotencyKey", "originId", "spaceId", "toolKey"]) text5(r[f], f);
  if (!r.source && r.checkoutRoot === void 0) fail7("INVALID_LAUNCH", "Generic launches require the captured checkoutRoot");
  r.machine = machineIdentity(r.machine);
  r.repoRoot = canonicalRepoPath(r.repoRoot);
  r.checkoutRoot = canonicalRepoPath(r.checkoutRoot ?? r.repoRoot);
  if (typeof r.worktree !== "boolean") fail7("INVALID_LAUNCH", "Choose the current checkout or a new worktree");
  if (!r.worktree && (r.worktreePath !== void 0 || r.branch !== void 0)) fail7("INVALID_LAUNCH", "Path/branch overrides require a new worktree");
  if (r.worktreePath !== void 0) r.worktreePath = canonicalRepoPath(r.worktreePath);
  if (r.branch !== void 0) text5(r.branch, "branch", 200);
  if (r.source) {
    for (const f of ["kind", "connectionId", "site", "id", "key", "title", "url"]) text5(r.source[f], `source ${f}`, f === "title" ? 512 : 2048);
    if (!["jira", "github", "github-pr", "gitlab", "gitlab-mr"].includes(r.source.kind) || !/^https:\/\/[^\s/@?#]+\/?$/.test(r.source.site) || !/^https:\/\/[^\s@]+$/.test(r.source.url)) fail7("INVALID_LAUNCH", "Invalid source identity/URL/site");
    if (r.source.body !== void 0 && (typeof r.source.body !== "string" || r.source.body.length > 64e3)) fail7("INVALID_LAUNCH", "Source body exceeds the supported limit");
  }
  r.options = validateToolOptions(Object.fromEntries(["model", "reasoning", "instructions", "skill", "subagents"].filter((k) => r[k] !== void 0).map((k) => [k, r[k]])));
  return r;
}
var operationKey = (r) => JSON.stringify([r.machine, r.repoRoot, r.source ? "source" : "intent", ...r.source ? [sourceIdentity2(r.source), r.toolKey] : [r.idempotencyKey]]);
var sameIntent = (a, b) => ["requestId", "originId", "idempotencyKey", "spaceId", "machine", "repoRoot", "checkoutRoot", "toolKey", "worktree", "worktreePath", "branch"].every((k) => a[k] === b[k]) && sourceIdentity2(a.source) === sourceIdentity2(b.source) && JSON.stringify(a.options) === JSON.stringify(b.options);
var strip = (id, machine2) => machine2 && id.startsWith(machine2 + "/") ? id.slice(machine2.length + 1) : id;
var isConflict2 = (e) => ["STALE", "CONFLICT", "EAGAIN"].includes(e?.code) || /stale|contents?.*changed|expected.*match|compare.and.set/i.test(e?.message || "");
function validateJournal(d) {
  if (!d || d.v !== 1 || !Number.isSafeInteger(d.revision) || d.revision < 0 || !d.requests || Array.isArray(d.requests)) fail7("INVALID_JOURNAL", "Launch journal is invalid; original preserved");
  for (const [id, r] of Object.entries(d.requests)) {
    text5(id, "journal request ID");
    if (r.request.requestId !== id || !["creating", "worktree-ready", "tab-created", "binding-commit-pending", "complete", "failed", "recovery-required"].includes(r.state) || !Number.isFinite(r.createdAt) || !Number.isFinite(r.updatedAt) || !Number.isFinite(r.leaseUntil) || typeof r.owner !== "string") fail7("INVALID_JOURNAL", "Invalid launch journal entry");
    validateLaunchRequest(r.request);
    if (r.key !== operationKey(r.request)) fail7("INVALID_JOURNAL", "Launch journal key mismatch");
    if (r.ack) {
      for (const f of ["space", "tab", "terminal"]) text5(r.ack[f], `acknowledged ${f}`);
      if (r.ack.space !== r.request.spaceId) fail7("INVALID_JOURNAL", "Acknowledged space mismatch");
    }
  }
  if (Object.keys(d.requests).length > 2e3 || JSON.stringify(d).length > 18e4) fail7("LAUNCH_CAPACITY", "The launch journal is full; archive completed closed requests before adding more");
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
    if (typeof raw !== "string" || raw.length > 18e4) fail7("LAUNCH_CAPACITY", "Launch journal exceeds its supported size");
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      fail7("INVALID_JOURNAL", "Launch journal JSON is invalid; original preserved");
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
    fail7("CONFLICT", "Concurrent launch state changed repeatedly; no duplicate launch was started");
  }
  update(id, owner2, edit) {
    return this.edit((d) => {
      const r = d.requests[id];
      if (!r || r.owner !== owner2) fail7("LAUNCH_BUSY", "Another worker owns this launch");
      edit(r);
      r.updatedAt = now(this.io);
      return r;
    });
  }
};
function captureRequest(r) {
  const copy3 = clone3(r);
  if (copy3.source) delete copy3.source.body;
  return copy3;
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
  if (!value || typeof value !== "object" || Array.isArray(value) || value.space !== request.spaceId) fail7("MALFORMED_ACK", "tab.new did not acknowledge the requested space");
  for (const f of ["space", "tab", "terminal"]) text5(value[f], `acknowledged ${f}`);
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
async function inspect(io, r, ack2) {
  const listing = await io.exec("herdr-app", ["ls"]);
  if (listing.code !== 0) fail7("ACK_UNVERIFIED", "Cannot inspect the acknowledged tab");
  let world;
  try {
    world = JSON.parse(listing.stdout);
  } catch {
    fail7("ACK_UNVERIFIED", "Invalid app-world response");
  }
  const space = world.spaces?.find((s) => s.id === r.spaceId && machineIdentity(s.machine) === r.machine), tab = space?.tabs?.find((t) => t.id === ack2.tab);
  if (!tab) return { exists: false };
  if (!tab.terminals?.some((t) => t.terminal === ack2.terminal)) fail7("ACK_UNVERIFIED", "The acknowledged terminal does not belong to that tab");
  const address = localTerminalAddress(ack2.terminal, r.machine), result = await io.exec("hc", ["get", address, "--json"], { on: r.machine });
  if (result.code !== 0) fail7("ACK_UNVERIFIED", "Cannot read the acknowledged full terminal");
  let raw;
  try {
    raw = JSON.parse(result.stdout);
  } catch {
    fail7("ACK_UNVERIFIED", "Invalid full terminal response");
  }
  const identity = terminalIdentity(raw, r.machine);
  if (identity.address !== (r.machine ? r.machine + "/" + address : address) || raw.labels?.["herdr.space"] !== strip(r.spaceId, r.machine) || raw.labels?.["herdr.tab"] !== strip(ack2.tab, r.machine)) fail7("ACK_UNVERIFIED", "Terminal generation/space/tab ownership does not match");
  return { exists: true, raw, identity, tab };
}
async function focus(io, r, ack2) {
  io.run("space.select", { id: r.spaceId });
  io.run("tab.select", { id: ack2.tab });
  io.run("pane.focus", { terminal: ack2.terminal });
}
function createLaunchIO(herdr2) {
  const io = createConfigIO(herdr2);
  io.capabilities = new CapabilityRegistry(herdr2.exec);
  io.sessionSource = async (provider, machine2) => {
    const config = (await readConfig(io)).value;
    const sources = Object.values(config.usageSources).filter((s) => s?.v === 1 && s.enabled === true && s.provider === provider && machineIdentity(s.machine) === machineIdentity(machine2));
    if (sources.length !== 1) return null;
    const source = sources[0];
    text5(source.credentialScope, "credential scope");
    const providerRoot = canonicalRepoPath(source.providerRoot);
    if (providerRoot === "/" || !Array.isArray(source.roots) || !source.roots.length) return null;
    return { providerRoot, credentialScope: source.credentialScope };
  };
  return io;
}
async function launch(input, io) {
  let request, journal2, record2, owned = false, owner2 = "op-" + uuid2();
  try {
    request = validateLaunchRequest(input);
    journal2 = new Journal(io);
    const space = io.spaces().find((s) => s.id === request.spaceId && machineIdentity(s.machine) === request.machine);
    if (!space) fail7("SPACE_UNAVAILABLE", "The captured destination space is no longer available on that machine");
    const tools = installedTools(await io.knownAgents({ on: request.machine })), tool = tools.find((t) => t.key === request.toolKey);
    if (!tool) fail7("TOOL_UNAVAILABLE", "The selected tool is not installed on the destination machine");
    const caps = io.capabilities ? await io.capabilities.get(tool, request.machine) : await new CapabilityRegistry(io.exec).get(tool, request.machine);
    buildArguments(caps, { options: request.options });
    const key3 = operationKey(request), clock = now(io);
    record2 = await journal2.edit((d) => {
      const byId = d.requests[request.requestId];
      if (byId && !sameIntent(byId.request, captureRequest(request))) fail7("RETRY_CHANGED", "A launch intent cannot change its captured options/destination");
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
        fail7(old.leaseUntil > clock ? "LAUNCH_BUSY" : "RECOVERY_REQUIRED", old.leaseUntil > clock ? "This launch is already being created" : "An interrupted launch has uncertain side effects; inspect it before retrying");
      }
      const other = request.source && Object.values(d.requests).find((r2) => sourceIdentity2(r2.request.source) === sourceIdentity2(request.source) && r2.request.machine === request.machine && r2.request.repoRoot === request.repoRoot && r2.request.toolKey !== request.toolKey && r2.state !== "failed");
      if (other && !(request.worktree && request.worktreePath && request.branch)) fail7("ISSUE_TOOL_CONFLICT", "This issue already has work under another tool. Focus it or explicitly choose a separate worktree.", other.ack ? { tabId: other.ack.tab, terminalId: other.ack.terminal } : void 0);
      const created = { request: captureRequest(request), key: key3, owner: owner2, state: "creating", createdAt: clock, updatedAt: clock, leaseUntil: clock + 3e4, tabAttempted: false, sessionProposal: null };
      d.requests[request.requestId] = created;
      return created;
    });
    owned = true;
    const reused = Boolean(record2.ack), r = record2.request, id = r.requestId, bindings = new BindingStore(io, { clock: () => now(io) }), names = new NameOwnership(io, { clock: () => now(io), owner: owner2 });
    const destinationSpace = io.spaces().find((s) => s.id === r.spaceId && machineIdentity(s.machine) === r.machine);
    if (!destinationSpace) fail7("SPACE_UNAVAILABLE", "The original captured destination is unavailable");
    if (!record2.ack) {
      let proposal = record2.sessionProposal;
      if (!proposal && io.exactResumeSession) {
        proposal = sessionIdentity(io.exactResumeSession);
        if (proposal.provider !== caps.provider || proposal.machine !== r.machine) fail7("UNPROVEN_SESSION", "Resume identity does not match the installed provider and machine");
      }
      if (!proposal && caps.callerSession && io.sessionSource) {
        const source = await io.sessionSource(caps.provider, r.machine);
        if (source) proposal = sessionIdentity({ machine: r.machine, provider: caps.provider, credentialScope: source.credentialScope, providerRoot: source.providerRoot, sessionId: uuid2() });
      }
      const mode = io.exactResumeSession ? "resume-argv" : "caller-session-id";
      const argv = buildArguments(caps, { options: request.options, ...proposal ? mode === "resume-argv" ? { resumeSessionId: proposal.sessionId } : { newSessionId: proposal.sessionId } : {} });
      record2 = await journal2.update(id, owner2, (d) => {
        d.sessionProposal = proposal;
        d.proofKind = proposal ? mode : null;
      });
      await bindings.propose({ requestId: id, originId: r.originId, session: proposal });
      const spec = record2.worktreeSpec || await prepareWorktree(r, { spaceName: destinationSpace.name, exec: io.exec });
      record2 = await journal2.update(id, owner2, (d) => {
        d.worktreeSpec = spec;
        d.state = "worktree-ready";
      });
      const tree = await ensureWorktree(r, spec, { exec: io.exec });
      record2 = await journal2.update(id, owner2, (d) => {
        d.folder = tree.folder;
        d.tabAttempted = true;
        d.initialName = r.source ? `${r.source.key} ${r.source.title}`.slice(0, 200) : tool.name || r.toolKey;
      });
      const args = { space: r.spaceId, folder: tree.folder, argv, name: record2.initialName };
      const task = taskText(request);
      if (task) args.task = task;
      const response = await io.exec("herdr-app", ["do", "tab.new", JSON.stringify(args)]);
      if (response.code !== 0) fail7("TAB_CREATE_UNCERTAIN", "Herdr did not acknowledge tab creation; inspect the request before retrying");
      let rawAck;
      try {
        rawAck = JSON.parse(response.stdout);
      } catch {
        fail7("MALFORMED_ACK", "Herdr returned an invalid tab acknowledgment; no second launch will be attempted");
      }
      const ack2 = verifyTabAcknowledgement(rawAck, r);
      record2 = await journal2.update(id, owner2, (d) => {
        d.ack = ack2;
        d.state = "tab-created";
      });
    }
    let actual = await inspect(io, r, record2.ack);
    if (!actual.exists) fail7("PREVIOUS_SESSION_CLOSED", "The acknowledged tab is closed. Resume its exact session from history instead of launching a duplicate.");
    if (reused && record2.state === "complete") {
      if (!record2.terminal || record2.terminal.createdMs !== actual.identity.createdMs || record2.terminal.address !== actual.identity.address || record2.terminal.machine !== actual.identity.machine) fail7("ACK_GENERATION_CHANGED", "The acknowledged terminal was replaced; inspect its saved session before retrying");
      await bindings.reconcile([actual.raw], { machine: r.machine });
      const committed = await bindings.readCommitted(actual.identity);
      await journal2.update(id, owner2, (d) => {
        d.leaseUntil = 0;
      });
      await focus(io, r, record2.ack);
      return { ok: true, tabId: record2.ack.tab, terminalId: record2.ack.terminal, folder: record2.folder, reused: true, originId: r.originId, session: committed?.session ?? null };
    }
    let proof = null;
    if (record2.sessionProposal) {
      for (let attempt = 0; !actual.identity.foregroundPid && attempt < 10; attempt++) {
        if (io.delay) await io.delay(150);
        else await io.exec("sleep", ["0.15"]);
        actual = await inspect(io, r, record2.ack);
        if (!actual.exists) break;
      }
      for (let attempt = 0; actual.exists && shellHoldsForeground(actual.raw) && attempt < 40; attempt++) {
        if (io.delay) await io.delay(150);
        else await io.exec("sleep", ["0.15"]);
        actual = await inspect(io, r, record2.ack);
      }
      if (!actual.exists || !actual.identity.foregroundPid) fail7("BINDING_NOT_READY", "Agent started; exact foreground identity is still unavailable. Retry only its binding commit.", { tabId: record2.ack.tab, terminalId: record2.ack.terminal });
      const expected = buildArguments(caps, { options: r.options, ...record2.proofKind === "resume-argv" ? { resumeSessionId: record2.sessionProposal.sessionId } : { newSessionId: record2.sessionProposal.sessionId } });
      if (!observedArgv(actual.raw, expected, taskText(request))) fail7("UNPROVEN_SESSION", "The acknowledged terminal does not have the captured exact launch command", { tabId: record2.ack.tab, terminalId: record2.ack.terminal });
      proof = argvSessionProof({ capabilities: caps, session: record2.sessionProposal, terminal: actual.identity, argv: expected, kind: record2.proofKind, observedAt: now(io), sourceDigest: requestDigest(JSON.stringify(expected)) });
    }
    record2 = await journal2.update(id, owner2, (d) => {
      d.terminal = actual.identity;
      d.state = "binding-commit-pending";
    });
    await bindings.commitAcknowledged(id, { tabId: record2.ack.tab, terminal: actual.identity }, proof);
    const ownership = await names.transferToAcknowledgedTab({ originId: r.originId, ...record2.sessionProposal ? { session: record2.sessionProposal } : {} }, { machine: r.machine, tabId: record2.ack.tab, name: record2.initialName });
    if (ownership.mode === "manual") await names.applyName(r.originId, ownership.manualName, { manualTransfer: true, getTabs: () => io.spaces().flatMap((s) => s.tabs.map((t) => ({ ...t, machine: s.machine }))), rename: (args) => io.run("tab.rename", args) });
    record2 = await journal2.update(id, owner2, (d) => {
      d.state = "complete";
      d.leaseUntil = 0;
    });
    await focus(io, r, record2.ack);
    return { ok: true, tabId: record2.ack.tab, terminalId: record2.ack.terminal, folder: record2.folder, reused, originId: r.originId, session: record2.sessionProposal };
  } catch (error2) {
    const code = error2.code || "LAUNCH_FAILED", message = error2 instanceof LaunchError || error2 instanceof ConfigError || error2.name === "WorktreeError" || error2.name === "CapabilityError" ? error2.message : "Launch could not complete; existing work was preserved.";
    if (owned && record2 && journal2) {
      try {
        await journal2.update(record2.request.requestId, owner2, (d) => {
          d.state = d.ack ? "binding-commit-pending" : d.tabAttempted ? "recovery-required" : "failed";
          d.error = { code, message };
          if (!d.tabAttempted) d.leaseUntil = 0;
        });
      } catch {
      }
    }
    return { ok: false, code, message, ...error2.recovery ? { recovery: error2.recovery } : record2?.ack ? { recovery: { tabId: record2.ack.tab, terminalId: record2.ack.terminal } } : {} };
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
var fail8 = (code, message, recovery) => {
  throw new ResumeError(code, message, recovery);
};
var freeze = (v) => {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    for (const c of Object.values(v)) freeze(c);
    Object.freeze(v);
  }
  return v;
};
var text6 = (v, name2, max = 256) => {
  if (typeof v !== "string" || !v || v.length > max || ["__proto__", "constructor", "prototype"].includes(v) || /[\u0000-\u001f]/.test(v)) fail8("INVALID_RESUME", `Invalid ${name2}`);
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
var prefix = (session) => "resume-" + digest(sessionKey(session)) + "-";
var base = (v) => typeof v === "string" ? v.slice(v.lastIndexOf("/") + 1).toLowerCase() : null;
var within = (path, root) => path === root || path.startsWith(root.replace(/\/$/, "") + "/");
var strip2 = (id, on) => on && id.startsWith(on + "/") ? id.slice(on.length + 1) : id;
var qualify = (id, on) => typeof id === "string" && id ? on ? on + "/" + id : id : null;
var aliases = { claude: ["claude", "claude-code"], codex: ["codex"], grok: ["grok"] };
var UNCERTAIN_MS = 6e4;
var inFlight = (record2, clock) => record2.ack ? !["complete", "failed"].includes(record2.state) && record2.leaseUntil > clock : record2.tabAttempted ? clock < record2.updatedAt + UNCERTAIN_MS : record2.state !== "failed" && record2.leaseUntil > clock;
var actions = { HOST_UNAVAILABLE: ["retry"], SPACE_UNAVAILABLE: ["retry"], TOOL_UNAVAILABLE: ["retry"], TERMINAL_UNAVAILABLE: ["retry"], RESUME_IN_PROGRESS: ["retry"], PREVIOUS_SESSION_CLOSED: ["retry"], WORKTREE_MISSING: ["locate", "retry"], CHECKOUT_MISMATCH: ["locate", "retry"], AMBIGUOUS_RUNNING_SESSION: ["locate", "retry-binding", "close-existing-and-retry"], RECOVERY_REQUIRED: ["locate", "close-existing-and-retry"], MALFORMED_ACK: ["locate", "close-existing-and-retry"], TAB_CREATE_UNCERTAIN: ["locate", "close-existing-and-retry"] };
var known = (e) => e instanceof ResumeError || e instanceof LaunchError || e instanceof IdentityError || ["ConfigError", "WorktreeError", "CapabilityError"].includes(e?.name);
function failure(code, message, recovery) {
  const extra = recovery && typeof recovery === "object" ? recovery : {};
  return freeze({ ok: false, code, message, recovery: { actions: extra.tabId ? ["locate", "retry-binding"] : actions[code] || [], ...extra } });
}
function validateResumeRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail8("INVALID_RESUME", "Missing resume request");
  let session, repoRoot, cwd;
  try {
    session = sessionIdentity(value.session);
    repoRoot = canonicalRepoPath(value.repoRoot);
    cwd = canonicalRepoPath(value.cwd);
  } catch (e) {
    fail8("INVALID_RESUME", e.message);
  }
  const r = { requestId: text6(value.requestId, "request ID"), spaceId: text6(value.spaceId, "space ID"), session, machine: session.machine, repoRoot, cwd, toolKey: text6(value.toolKey ?? session.provider, "tool key", 96) };
  if (value.originId !== void 0) r.originId = text6(value.originId, "origin ID");
  if (value.title !== void 0) r.title = text6(value.title, "reported title", 200);
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
  if (value?.v !== 1 || !value.requests || typeof value.requests !== "object" || Array.isArray(value.requests)) fail8("INVALID_JOURNAL", "Launch journal is invalid; original preserved and nothing was started");
  return value.requests;
}
function attempts(requests, session) {
  const p = prefix(session), key3 = sessionKey(session), found = [];
  for (const record2 of Object.values(requests)) {
    const id = record2?.request?.idempotencyKey;
    if (typeof id !== "string" || !id.startsWith(p) || !/^(0|[1-9]\d{0,8})$/.test(id.slice(p.length))) continue;
    if (record2.sessionProposal && sessionKey(record2.sessionProposal) !== key3) fail8("RESUME_CONFLICT", "Saved resume state belongs to a different exact session; nothing was started");
    found.push({ epoch: Number(id.slice(p.length)), record: record2 });
  }
  return found.sort((a, b) => b.epoch - a.epoch);
}
async function full(io, address, on) {
  const local = localTerminalAddress(address, on);
  let result;
  try {
    result = await io.exec("hc", ["get", local, "--json"], { on });
  } catch {
    fail8("HOST_UNAVAILABLE", "The original host became unreachable while checking live terminals; nothing was started");
  }
  if (result?.code !== 0) return null;
  try {
    const raw = JSON.parse(result.stdout);
    if (localTerminalAddress(raw.address, on) !== local) throw Error("address");
    return { raw, identity: terminalIdentity(raw, on) };
  } catch {
    fail8("TERMINAL_UNAVAILABLE", "A live terminal returned invalid identity data; nothing was started");
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
async function inspectHost(io, r, { tool, bindings, found, terminals }) {
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
  for (const { record: record2 } of found) if (record2.ack && !["complete", "failed"].includes(record2.state)) try {
    pending.set(localTerminalAddress(record2.ack.terminal, on), record2);
  } catch {
  }
  for (const summary of terminals) {
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
    fail8("WORKTREE_MISSING", "The original repository or working directory is missing on its host. Locate it, then retry; the saved session is unchanged.");
  }
}
function choose(r, found, own, requests, clock) {
  const p = prefix(r.session), byId = requests[r.requestId], busy = () => fail8("RESUME_IN_PROGRESS", "This exact session is already being resumed; wait for its acknowledgment.");
  if (byId) {
    if (typeof byId.request?.idempotencyKey !== "string" || !byId.request.idempotencyKey.startsWith(p)) fail8("RETRY_CHANGED", "This resume request ID already belongs to different work");
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
    if (typeof io.machines === "function" && io.machines().find((m) => machineIdentity(m.name) === on)?.layout !== "ready") fail8("HOST_UNAVAILABLE", `${on ?? "This computer"} is offline or still loading; nothing was started.`);
    const space = io.spaces().find((s) => s.id === r.spaceId);
    if (!space) fail8("SPACE_UNAVAILABLE", "The destination space is no longer open; nothing was started.");
    if (machineIdentity(space.machine) !== on) fail8("WRONG_HOST", "This session belongs to another host and is only resumed on its original host.");
    let tools, requests, found, live;
    try {
      tools = installedTools(await io.knownAgents({ on }));
    } catch {
      fail8("HOST_UNAVAILABLE", "The original host could not report its installed tools; nothing was started.");
    }
    const tool = tools.find((t) => t.key === r.toolKey) || null;
    for (let pass = 0; pass < 2 && !live?.exact && (!live || live.candidates.length); pass++) {
      requests = await journal(io);
      found = attempts(requests, r.session);
      const bindings = (await new BindingStore(io, { clock: () => now2(io) }).read()).value;
      let listing = null, terminals = null;
      try {
        listing = await io.exec("hc", ["ls", "--json"], { on });
      } catch {
      }
      try {
        if (listing?.code === 0) terminals = JSON.parse(listing.stdout).terminals;
      } catch {
      }
      if (!Array.isArray(terminals)) fail8("HOST_UNAVAILABLE", "The original host could not list its live terminals; nothing was started.");
      if (terminals.length > 1e3) fail8("HOST_UNAVAILABLE", "The original host has too many live terminals to verify safely; nothing was started.");
      live = await inspectHost(io, r, { tool, bindings, found, terminals });
    }
    if (live.exact) {
      io.run("agent.focus", { terminal: live.exact.terminal.address });
      return freeze({ ok: true, action: "focus", tabId: live.exact.tabId, terminalId: live.exact.terminal.address, reused: true, originId: live.exact.originId, session: r.session });
    }
    if (live.candidates.length) {
      if (found.some(({ record: record2 }) => inFlight(record2, clock))) fail8("RESUME_IN_PROGRESS", "This exact session is already being resumed; wait for its acknowledgment.");
      fail8("AMBIGUOUS_RUNNING_SESSION", `A running ${r.session.provider} terminal in this repository has no exact session binding. Locate it, retry its binding, or close it and retry; nothing was resumed.`, { candidates: live.candidates });
    }
    if (!tool) fail8("TOOL_UNAVAILABLE", "The session tool is not installed on its original host.");
    const caps = io.capabilities ? await io.capabilities.get(tool, on) : await new CapabilityRegistry(io.exec).get(tool, on), support = resumeSupport(caps, { provider: r.session.provider, machine: on });
    if (!support.supported) fail8("UNSUPPORTED_RESUME", support.reason);
    buildArguments(caps, { resumeSessionId: r.session.sessionId });
    if (typeof io.sessionSource === "function") {
      const source = await io.sessionSource(r.session.provider, on);
      if (source && (source.providerRoot !== r.session.providerRoot || source.credentialScope !== r.session.credentialScope)) fail8("ACCOUNT_MISMATCH", "This session belongs to a different provider profile than the one enabled on its host; nothing was started.");
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
async function resolveSpaceRepo(space, panes, exec, { mountedLocalPath = null } = {}) {
  if (!space?.id || typeof exec !== "function") return { state: "error", spaceId: space?.id ?? null, machine: space?.machine ?? null, reason: "Space or target-host execution is unavailable." };
  const tabs = new Set((space.tabs || []).map((t) => t.id));
  const eligible2 = panes.filter((p) => p.terminal && p.cwd && tabs.has(p.tab));
  if (!eligible2.length) return { ...base2(space), state: "unbound", reason: "This space has no live terminal folder. Open or focus a terminal first." };
  const focused = space.active === false ? [] : eligible2.filter((p) => p.focused), chosen = focused.length ? focused : eligible2;
  const results = [];
  for (let start = 0; start < chosen.length; start += 4) results.push(...await Promise.all(chosen.slice(start, start + 4).map((p) => resolvePane(space, p, exec))));
  if (results.some((r) => r.state === "error")) return { ...base2(space), state: "error", reason: results.find((r) => r.state === "error").reason };
  const resolved = results.filter((r) => r.state === "resolved");
  if (!resolved.length) return { ...base2(space), state: "unbound", reason: "No live terminal in this space has a Git repository." };
  if (resolved.length !== results.length || new Set(resolved.map((r) => r.gitCommonDir)).size !== 1) return { ...base2(space), state: "ambiguous", candidates: results.map((r) => ({ paneId: r.paneId, cwd: r.cwd, repoRoot: r.repoRoot ?? null })), reason: "Focus a terminal to choose the repository for this space." };
  return withMount(resolved[0], mountedLocalPath, exec);
}

// src/shared/closed-tabs.js
var ClosedTabsError = class extends Error {
  constructor(code, message, recovery) {
    super(message);
    this.name = "ClosedTabsError";
    this.code = code;
    if (recovery) this.recovery = recovery;
  }
};
var fail9 = (code, message, recovery) => {
  throw new ClosedTabsError(code, message, recovery);
};
var LIMITS = Object.freeze({ records: 100, hosts: 32, tabs: 400, terminals: 8, suppress: 64, bytes: 900 * 1024, observeMs: 2e3, leaseMs: 1e4, continuityMs: 25e3, parkedMs: 6e3, claimMs: 6e4, tickStaleMs: 15e3, hydratePerTick: 4, hydrateTries: 3, historyBytes: 4194304, historyMs: 5e3, historyBatch: 80, historyOutput: 1048576 });
var KNOWN_AGENTS = /* @__PURE__ */ new Set(["claude", "claude-code", "codex", "grok", "gemini", "aider", "opencode", "cursor-agent", "pi", "amp", "goose", "qwen", "kiro", "kiro-cli", "copilot", "crush", "droid"]);
var clone4 = (v) => JSON.parse(JSON.stringify(v));
var freeze2 = (v) => {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    for (const c of Object.values(v)) freeze2(c);
    Object.freeze(v);
  }
  return v;
};
var clockOf = (io) => io.clock ? io.clock() : Date.now();
var plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
var time2 = (v) => Number.isSafeInteger(v) && v >= 0;
var utf8 = (value) => {
  let n = 0;
  for (const c of value) {
    const p = c.codePointAt(0);
    n += p < 128 ? 1 : p < 2048 ? 2 : p < 65536 ? 3 : 4;
  }
  return n;
};
var reserved = /* @__PURE__ */ new Set(["__proto__", "prototype", "constructor"]);
var text7 = (v, label2, max = 256) => {
  if (typeof v !== "string" || !v || v.length > max || reserved.has(v) || /[\u0000-\u001f\u007f]/.test(v)) fail9("INVALID_CLOSED", `Invalid ${label2}`);
  return v;
};
var displayText = (v, max = 160) => {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
  return s || null;
};
var folder = (v) => {
  if (typeof v !== "string" || !v || v.length > 1024) return null;
  try {
    return canonicalRepoPath(v);
  } catch {
    return null;
  }
};
var strictFolder = (v) => {
  const path = canonicalRepoPath(v);
  if (path.length > 1024) fail9("INVALID_CLOSED", "Folder path exceeds its supported length");
  return path;
};
var hostKey = (machine2) => JSON.stringify(machineIdentity(machine2));
var localId = (id, machine2) => machine2 && id.startsWith(machine2 + "/") ? id.slice(machine2.length + 1) : id;
var qualified = (id, machine2) => machine2 ? machine2 + "/" + localId(id, machine2) : id;
var safeMachine = (v) => {
  try {
    return machineIdentity(v);
  } catch {
    return void 0;
  }
};
function digest2(value) {
  let a = 2166136261, b = 2654435769;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    a = Math.imul(a ^ c, 16777619);
    b = Math.imul(b ^ c, 2246822519);
  }
  return [a >>> 0, b >>> 0].map((n) => n.toString(16).padStart(8, "0")).join("");
}
var isConflict3 = (e) => ["STALE", "CONFLICT", "EAGAIN"].includes(e?.code) || /stale|contents?.*changed|expected.*match|compare.and.set/i.test(e?.message || "");
var randomId = (prefix2) => prefix2 + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
var safeProgram = (p) => p && typeof p.key === "string" && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(p.key) ? { key: p.key, name: displayText(p.name, 128) || p.key } : null;
function program(v) {
  if (v === null) return null;
  if (!plain(v)) fail9("INVALID_CLOSED", "Invalid program identity");
  const p = safeProgram(v);
  if (!p) fail9("INVALID_CLOSED", "Invalid program identity");
  return p;
}
function terminal(t, machine2, { snapshot = false } = {}) {
  if (!plain(t) || typeof t.agent !== "boolean" || t.createdMs !== null && !time2(t.createdMs)) fail9("INVALID_CLOSED", "Invalid closed terminal");
  const address = text7(t.address, "terminal address");
  let local;
  try {
    local = localTerminalAddress(address, machine2);
  } catch {
    fail9("INVALID_CLOSED", "A terminal address does not belong to its machine");
  }
  if (qualified(local, machine2) !== address) fail9("INVALID_CLOSED", "A terminal address is not machine-qualified");
  const r = { address, createdMs: t.createdMs, startCwd: t.startCwd === null ? null : strictFolder(t.startCwd), program: program(t.program), agent: t.agent, title: t.title === null ? null : displayText(t.title) };
  if (snapshot) {
    if (!Number.isSafeInteger(t.tries) || t.tries < 0 || t.tries > 9) fail9("INVALID_CLOSED", "Invalid hydration state");
    r.tries = t.tries;
    return r;
  }
  if (t.session !== void 0) {
    const s = sessionIdentity(t.session);
    if (s.machine !== machine2) fail9("INVALID_CLOSED", "A closed session belongs to another machine");
    r.session = s;
  }
  for (const f of ["requestId", "originId"]) if (t[f] !== void 0) r[f] = text7(t[f], f);
  if (t.toolKey !== void 0) r.toolKey = text7(t.toolKey, "tool key", 96);
  for (const f of ["repoRoot", "checkoutRoot"]) if (t[f] !== void 0) r[f] = strictFolder(t[f]);
  return r;
}
var nullable = (v, fn) => v === null ? null : fn(v);
function spaceInfo(s) {
  if (!plain(s) || typeof s.named !== "boolean") fail9("INVALID_CLOSED", "Invalid space");
  return { id: text7(s.id, "space ID"), name: nullable(s.name, (v) => displayText(v)), named: s.named, folder: nullable(s.folder, strictFolder) };
}
function index2(v) {
  if (v !== null && !(Number.isSafeInteger(v) && v > 0 && v < 1e5)) fail9("INVALID_CLOSED", "Invalid tab position");
  return v;
}
var ack = (v) => ({ space: text7(v?.space, "acknowledged space"), tab: text7(v?.tab, "acknowledged tab"), terminal: text7(v?.terminal, "acknowledged terminal") });
var SOURCES = ["observed", "confirmed", "imported"];
var PHASES = ["claimed", "attempting", "acknowledged"];
function record(r) {
  if (!plain(r) || typeof r.id !== "string" || !/^c-[0-9a-f]{16}$/.test(r.id) || !time2(r.seq) || !SOURCES.includes(r.source) || typeof r.ordered !== "boolean" || !time2(r.closedAt) || !["shell", "agent"].includes(r.kind)) fail9("INVALID_CLOSED", "Invalid closed record");
  const machine2 = machineIdentity(r.machine), space = spaceInfo(r.space);
  if (r.space.replacement !== void 0) space.replacement = text7(r.space.replacement, "replacement space");
  if (!plain(r.tab) || typeof r.tab.named !== "boolean") fail9("INVALID_CLOSED", "Invalid closed tab");
  const tab = { id: text7(r.tab.id, "tab ID"), name: nullable(r.tab.name, (v) => displayText(v, 200)), named: r.tab.named, index: index2(r.tab.index) };
  if (!Array.isArray(r.terminals) || !r.terminals.length || r.terminals.length > LIMITS.terminals) fail9("INVALID_CLOSED", "A closed tab needs one to eight terminals");
  const terminals = r.terminals.map((t) => terminal(t, machine2));
  if (!Number.isSafeInteger(r.panes) || r.panes < terminals.length || r.panes > 64) fail9("INVALID_CLOSED", "Invalid pane count");
  let origin = null;
  if (r.origin !== null) {
    if (!plain(r.origin) || !["auto", "manual"].includes(r.origin.mode)) fail9("INVALID_CLOSED", "Invalid name ownership");
    origin = { originId: text7(r.origin.originId, "origin ID"), mode: r.origin.mode, manualName: nullable(r.origin.manualName, (v) => text7(v, "manual name", 512)) };
    if (origin.mode === "manual" && !origin.manualName) fail9("INVALID_CLOSED", "A manual name is required");
  }
  let claim = null;
  if (r.claim !== null) {
    if (!plain(r.claim) || !PHASES.includes(r.claim.phase) || !time2(r.claim.until) || !time2(r.claim.at)) fail9("INVALID_CLOSED", "Invalid reopen claim");
    claim = { owner: text7(r.claim.owner, "claim owner"), until: r.claim.until, requestId: text7(r.claim.requestId, "request ID"), phase: r.claim.phase, at: r.claim.at };
    if (r.claim.ack !== void 0) claim.ack = ack(r.claim.ack);
    if (r.claim.scaffold !== void 0) claim.scaffold = ack(r.claim.scaffold);
  }
  let error2 = null;
  if (r.error !== null) {
    if (!plain(r.error) || !time2(r.error.at)) fail9("INVALID_CLOSED", "Invalid reopen error");
    error2 = { code: text7(r.error.code, "error code", 64), message: displayText(r.error.message, 512) || "Reopen failed.", at: r.error.at };
  }
  return { id: r.id, seq: r.seq, source: r.source, ordered: r.ordered, closedAt: r.closedAt, machine: machine2, kind: r.kind, space, tab, terminals, panes: r.panes, origin, claim, error: error2 };
}
function host(key3, h) {
  if (!plain(h) || !["ready", "unavailable"].includes(h.state) || !time2(h.observedAt) || !Number.isSafeInteger(h.limit) || h.limit < 0 || h.limit > LIMITS.tabs || typeof h.truncated !== "boolean" || !plain(h.spaces) || !plain(h.tabs)) fail9("INVALID_CLOSED", "Invalid host snapshot");
  const machine2 = machineIdentity(h.machine);
  if (hostKey(machine2) !== key3) fail9("INVALID_CLOSED", "A host snapshot does not match its key");
  if (Object.keys(h.tabs).length > LIMITS.tabs || Object.keys(h.spaces).length > LIMITS.tabs) fail9("INVALID_CLOSED", "A host snapshot exceeds its bounds");
  const spaces = {}, tabs = {};
  for (const [id, s] of Object.entries(h.spaces)) spaces[text7(id, "space ID")] = spaceInfo(s);
  for (const [id, t] of Object.entries(h.tabs)) {
    if (!plain(t) || typeof t.named !== "boolean" || !Number.isSafeInteger(t.panes) || t.panes < 0 || t.panes > 64 || !Array.isArray(t.terms) || t.terms.length > LIMITS.terminals) fail9("INVALID_CLOSED", "Invalid tab snapshot");
    const x = { id: text7(t.id, "tab ID"), space: text7(t.space, "space ID"), index: index2(t.index), name: nullable(t.name, (v) => displayText(v, 200)), named: t.named, panes: t.panes, terms: t.terms.map((v) => terminal(v, machine2, { snapshot: true })) };
    if (t.parkedSince !== void 0) {
      if (!time2(t.parkedSince)) fail9("INVALID_CLOSED", "Invalid parked time");
      x.parkedSince = t.parkedSince;
    }
    tabs[text7(id, "tab ID")] = x;
  }
  return { machine: machine2, state: h.state, observedAt: h.observedAt, limit: h.limit, truncated: h.truncated, spaces, tabs };
}
var emptyJournal = () => ({ v: 1, revision: 0, seq: 0, lease: null, hosts: {}, records: [], suppress: [], imports: {} });
function validateClosedJournal(value) {
  try {
    if (!plain(value) || value.v !== 1 || !time2(value.revision) || !time2(value.seq) || !plain(value.hosts) || !Array.isArray(value.records) || !Array.isArray(value.suppress) || !plain(value.imports)) fail9("INVALID_CLOSED", "Invalid journal");
    if (value.records.length > LIMITS.records || Object.keys(value.hosts).length > LIMITS.hosts || value.suppress.length > LIMITS.suppress || Object.keys(value.imports).length > LIMITS.hosts) fail9("INVALID_CLOSED", "Journal bounds exceeded");
    let lease = null;
    if (value.lease !== null) {
      if (!plain(value.lease) || !time2(value.lease.expiresAt)) fail9("INVALID_CLOSED", "Invalid watcher lease");
      lease = { owner: text7(value.lease.owner, "lease owner"), expiresAt: value.lease.expiresAt };
    }
    const records = value.records.map(record);
    if (new Set(records.map((r) => r.id)).size !== records.length) fail9("INVALID_CLOSED", "Duplicate closed record");
    const hosts = {};
    for (const [key3, h] of Object.entries(value.hosts)) hosts[key3] = host(key3, h);
    const suppress = value.suppress.map((s) => {
      if (!plain(s) || !time2(s.until)) fail9("INVALID_CLOSED", "Invalid suppression");
      return { machine: machineIdentity(s.machine), tab: text7(s.tab, "tab ID"), until: s.until };
    });
    const imports = {};
    for (const [key3, i] of Object.entries(value.imports)) {
      if (!plain(i) || !time2(i.at) || !["complete", "partial", "unavailable"].includes(i.state) || i.cursor !== null && !/^t[0-9a-z]{1,63}$/.test(i.cursor)) fail9("INVALID_CLOSED", "Invalid import state");
      hostKey(JSON.parse(key3));
      imports[key3] = { at: i.at, state: i.state, reason: nullable(i.reason, (v) => displayText(v, 300)), cursor: i.cursor };
    }
    return { v: 1, revision: value.revision, seq: value.seq, lease, hosts, records, suppress, imports };
  } catch {
    throw new ClosedTabsError("INVALID_CLOSED", "Closed-tab history is invalid; the original file was kept unchanged.");
  }
}
function sortRecords(records) {
  return records.sort((a, b) => (a.source === "imported") - (b.source === "imported") || (a.source === "imported" ? b.closedAt - a.closedAt : b.seq - a.seq) || (a.id < b.id ? -1 : 1));
}
function boundRecords(d, now3) {
  sortRecords(d.records);
  while (d.records.length > LIMITS.records) {
    const pool = d.records.filter((r) => !(r.claim && r.claim.until > now3)), victim = [...pool].reverse().find((r) => r.source === "imported") || pool.at(-1);
    if (!victim) break;
    d.records.splice(d.records.indexOf(victim), 1);
  }
}
function fit(next) {
  let body = JSON.stringify(next) + "\n";
  while (utf8(body) > LIMITS.bytes) {
    const hosts = Object.values(next.hosts).filter((h) => Object.keys(h.tabs).length).sort((a, b) => Object.keys(b.tabs).length - Object.keys(a.tabs).length);
    if (hosts.length) {
      const h = hosts[0], ids = Object.keys(h.tabs);
      h.limit = Math.floor(ids.length / 2);
      for (const id of ids.slice(h.limit)) delete h.tabs[id];
      h.truncated = true;
    } else if (next.records.length) next.records.pop();
    else fail9("CLOSED_CAPACITY", "Closed-tab history cannot fit its size limit.");
    body = JSON.stringify(next) + "\n";
  }
  return body;
}
var generations = (r) => new Set((r.terminals || r.terms).filter((t) => t.createdMs !== null && t.createdMs !== void 0).map((t) => JSON.stringify([t.address, t.createdMs])));
function sameClosure(a, b) {
  if (a.machine !== b.machine || localId(a.tab.id, a.machine) !== localId(b.tab.id, b.machine)) return false;
  const x = generations(a), y = generations(b);
  return !x.size || !y.size || [...x].some((g) => y.has(g));
}
var ClosedJournal = class {
  constructor(io, { clock } = {}) {
    this.io = io;
    this.clock = clock || (() => clockOf(io));
    const home = typeof io.appHome === "function" ? io.appHome() : io.appHome;
    if (typeof home !== "string" || !home || /[\u0000-\u001f]/.test(home)) fail9("CLOSED_PATH", "The Herdr app home is unavailable.");
    this.path = home.replace(/[/\\]+$/, "") + "/mission-control/closed.json";
  }
  async read() {
    const raw = await this.io.readTextFile(this.path);
    if (raw === null) return { raw, value: emptyJournal() };
    if (typeof raw !== "string" || utf8(raw) > LIMITS.bytes + 65536) fail9("INVALID_CLOSED", "Closed-tab history exceeds its supported size; the original file was kept unchanged.");
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      fail9("INVALID_CLOSED", "Closed-tab history is not valid JSON; the original file was kept unchanged.");
    }
    return { raw, value: validateClosedJournal(data) };
  }
  /** fn(draft,now) is synchronous; {write:false} skips the write. Conflicts re-read and re-apply. */
  async edit(fn, { snapshot } = {}) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const { raw, value } = attempt === 0 && snapshot ? snapshot : await this.read(), draft = clone4(value), result = fn(draft, this.clock()) || {};
      if (result.write === false) return { value, result };
      draft.revision++;
      if (!Number.isSafeInteger(draft.revision)) fail9("CLOSED_CAPACITY", "Closed-tab history revision exhausted.");
      const next = validateClosedJournal(draft), body = fit(next);
      await this.io.ensureDirectory?.(this.path.slice(0, this.path.lastIndexOf("/")));
      try {
        await this.io.writeTextFile(this.path, body, raw);
        return { value: next, result };
      } catch (e) {
        if (!isConflict3(e)) throw e;
      }
    }
    fail9("CONFLICT", "Closed-tab history changed repeatedly; nothing stale was written.");
  }
  async claim(id, owner2, { confirmUncertain = false } = {}) {
    text7(owner2, "claim owner");
    return (await this.edit((d, now3) => {
      const r = d.records.find((x) => x.id === id);
      if (!r) fail9("RECORD_GONE", "This closed tab was already reopened or forgotten.");
      const c = r.claim;
      if (c && c.owner !== owner2 && c.until > now3) fail9("REOPEN_IN_PROGRESS", "This closed tab is already being reopened; wait for it to appear.", { recordId: id });
      if (c?.phase === "attempting" && !confirmUncertain) fail9("TAB_CREATE_UNCERTAIN", "An earlier reopen of this tab was interrupted after Herdr was asked to create it. Check its space first; open it again only if it is missing.", { recordId: id });
      r.claim = { owner: owner2, until: now3 + LIMITS.claimMs, requestId: c?.requestId || "reopen-" + r.id.slice(2), phase: c?.phase === "acknowledged" ? "acknowledged" : "claimed", at: now3, ...c?.ack ? { ack: c.ack } : {}, ...c?.scaffold ? { scaffold: c.scaffold } : {} };
      r.error = null;
      return clone4(r);
    })).result;
  }
  async updateClaim(id, owner2, patch, { replacement } = {}) {
    return (await this.edit((d, now3) => {
      const r = d.records.find((x) => x.id === id);
      if (!r || r.claim?.owner !== owner2) fail9("CLAIM_LOST", "Another reopen took over this closed tab; nothing more was done.");
      Object.assign(r.claim, clone4(patch), { until: now3 + LIMITS.claimMs });
      if (replacement) r.space.replacement = text7(replacement, "replacement space");
      return clone4(r);
    })).result;
  }
  /** Removes a record only for the claim that acknowledged its replacement. */
  async consume(id, owner2) {
    return (await this.edit((d) => {
      const i = d.records.findIndex((x) => x.id === id);
      if (i < 0) return { write: false, consumed: false };
      if (d.records[i].claim?.owner !== owner2) fail9("CLAIM_LOST", "Another reopen took over this closed tab.");
      d.records.splice(i, 1);
      return { consumed: true };
    })).result;
  }
  /** A definite failure frees the record; uncertain creation and acknowledged/scaffold state stay for explicit recovery. */
  async release(id, owner2, error2) {
    return (await this.edit((d, now3) => {
      const r = d.records.find((x) => x.id === id);
      if (!r || r.claim?.owner !== owner2) return { write: false };
      if (r.claim.phase === "attempting" && error2?.definite) r.claim.phase = "claimed";
      if (r.claim.phase !== "claimed" || r.claim.scaffold) r.claim.until = now3;
      else r.claim = null;
      r.error = error2 ? { code: text7(error2.code, "error code", 64), message: displayText(error2.message, 512) || "Reopen failed.", at: now3 } : null;
      return {};
    })).result;
  }
  async dismiss(id, { owner: owner2 } = {}) {
    return (await this.edit((d, now3) => {
      const i = d.records.findIndex((x) => x.id === id);
      if (i < 0) return { write: false, dismissed: false };
      const c = d.records[i].claim;
      if (c && c.until > now3 && c.owner !== owner2) fail9("REOPEN_IN_PROGRESS", "This closed tab is being reopened; wait for it before forgetting it.");
      d.records.splice(i, 1);
      return { dismissed: true };
    })).result;
  }
  /** Before this mod (or a bundling tab bar) closes its own transient tab, so the close is not recorded. */
  async expectClose(machine2, tabId, { ms = 3e4 } = {}) {
    const m = machineIdentity(machine2);
    text7(tabId, "tab ID");
    return (await this.edit((d, now3) => {
      d.suppress = d.suppress.filter((s) => s.until > now3 && !(s.machine === m && s.tab === tabId));
      d.suppress.push({ machine: m, tab: tabId, until: now3 + Math.min(Math.max(ms, 1e3), 12e4) });
      d.suppress = d.suppress.slice(-LIMITS.suppress);
    })).value;
  }
  /** Snapshot a live tab before an owned tab.close; recordConfirmedClose stores it once the close is visible. */
  async captureTab(tabId, world = snapshotWorld(this.io)) {
    text7(tabId, "tab ID");
    for (const [key3, live] of world.hosts) {
      if (!live.ready) continue;
      const tid = localId(tabId, live.machine), tab = live.tabs[tid];
      if (!tab || tab.id !== tabId) continue;
      let prev = null;
      try {
        prev = (await this.read()).value.hosts[key3];
      } catch {
      }
      const old = continuity(prev, world.at) ? prev.tabs[tid] : null, terms = [];
      for (const t of tab.terms) {
        let x = carry(t, old?.terms.find((o) => o.address === t.address));
        if (x.createdMs === null) x = carry(t, null, await hydrate(this.io, { machine: live.machine, address: t.address }));
        terms.push(x);
      }
      return freeze2({ machine: live.machine, tab: { ...clone4(tab), terms }, space: live.spaces[tab.space] ? clone4(live.spaces[tab.space]) : null, capturedAt: world.at });
    }
    fail9("TAB_UNAVAILABLE", "That tab is not open on a ready machine; nothing was captured.");
  }
  async recordConfirmedClose(capture, world = snapshotWorld(this.io)) {
    if (!capture?.tab?.id || !Array.isArray(capture.tab.terms)) fail9("INVALID_CLOSED", "A captured tab is required.");
    const machine2 = machineIdentity(capture.machine), key3 = hostKey(machine2), live = world.hosts.get(key3), tid = localId(capture.tab.id, machine2);
    if (!live?.ready) fail9("HOST_UNAVAILABLE", "The tab’s machine is unavailable, so its close cannot be confirmed yet.");
    if (live.tabs[tid]) fail9("NOT_CLOSED", "The tab is still open; nothing was recorded.");
    if (!capture.tab.terms.length) return freeze2({ id: null, duplicate: false, recorded: false });
    const enrichment = await enrichmentFor(this.io, [{ machine: machine2, tab: capture.tab }]);
    return freeze2((await this.edit((d, now3) => {
      const extra = enrichment.get(JSON.stringify([machine2, capture.tab.id])), closed = closedRecord({ machine: machine2, tab: capture.tab, space: capture.space }, { source: "confirmed", closedAt: now3, seq: d.seq + 1, extra });
      if (d.hosts[key3]?.tabs[tid]) delete d.hosts[key3].tabs[tid];
      const existing = d.records.find((r) => sameClosure(r, closed));
      if (existing) return { id: existing.id, duplicate: true, recorded: false };
      d.seq++;
      d.records.push(closed);
      boundRecords(d, now3);
      return { id: closed.id, duplicate: false, recorded: true };
    })).result);
  }
};
function snapshotWorld(api, at = clockOf(api)) {
  const hosts = /* @__PURE__ */ new Map(), list = typeof api.machines === "function" ? api.machines() || [] : [{ name: null, layout: "ready" }];
  for (const m of list) {
    if (!m || m.temporary) continue;
    const machine2 = safeMachine(m.name);
    if (machine2 === void 0) continue;
    hosts.set(hostKey(machine2), { machine: machine2, ready: m.layout === "ready", spaces: {}, tabs: {} });
  }
  const spaces = api.spaces() || [], machineOf = /* @__PURE__ */ new Map(), byTab = /* @__PURE__ */ new Map(), agents = /* @__PURE__ */ new Set();
  for (const s of spaces) {
    const m = safeMachine(s?.machine);
    if (m !== void 0 && typeof s.id === "string") machineOf.set(s.id, m);
  }
  for (const a of (typeof api.agents === "function" ? api.agents() : []) || []) {
    const m = machineOf.get(a?.space);
    if (m === void 0) continue;
    try {
      agents.add(qualified(localTerminalAddress(a.address, m), m));
    } catch {
    }
  }
  for (const p of (typeof api.panes === "function" ? api.panes() : []) || []) {
    if (!p || typeof p.tab !== "string") continue;
    if (!byTab.has(p.tab)) byTab.set(p.tab, []);
    byTab.get(p.tab).push(p);
  }
  for (const s of spaces) {
    const machine2 = machineOf.get(s?.id);
    if (machine2 === void 0) continue;
    const h = hosts.get(hostKey(machine2));
    if (!h?.ready) continue;
    let sid;
    try {
      sid = text7(localId(text7(s.id, "space ID"), machine2), "space ID");
    } catch {
      continue;
    }
    h.spaces[sid] = { id: s.id, name: displayText(s.name), named: s.named === true, folder: folder(s.folder) };
    for (const t of s.tabs || []) {
      let tid;
      try {
        tid = text7(localId(text7(t?.id, "tab ID"), machine2), "tab ID");
      } catch {
        continue;
      }
      const panes = byTab.get(t.id) || [], terms = [];
      for (const p of panes) {
        if (!p.terminal || terms.length >= LIMITS.terminals) continue;
        let address;
        try {
          address = qualified(localTerminalAddress(p.terminal, machine2), machine2);
        } catch {
          continue;
        }
        terms.push({ address, program: safeProgram(p.program), agent: p.program?.agent === true || agents.has(address) || Boolean(p.status) || Boolean(p.app), title: displayText(p.title) });
      }
      h.tabs[tid] = { id: t.id, space: sid, index: Number.isSafeInteger(t.index) && t.index > 0 && t.index < 1e5 ? t.index : null, name: displayText(t.name, 200), named: t.named === true, panes: Math.min(Math.max(Number.isSafeInteger(t.panes) ? t.panes : 0, panes.length), 64), terms };
    }
  }
  const live = /* @__PURE__ */ new Set();
  for (const t of (typeof api.terminals === "function" ? api.terminals() : []) || []) if (t && t.state === "live" && typeof t.address === "string") live.add(t.address);
  return { at, hosts, live };
}
function continuity(prev, now3) {
  return Boolean(prev && prev.state === "ready" && now3 >= prev.observedAt && now3 - prev.observedAt <= LIMITS.continuityMs);
}
function carry(t, old, h) {
  const x = { address: t.address, createdMs: old?.createdMs ?? null, startCwd: old?.startCwd ?? null, program: t.program ?? old?.program ?? null, agent: Boolean(t.agent || old?.agent), title: t.title ?? old?.title ?? null, tries: old?.tries ?? 0 };
  if (h && x.createdMs === null) {
    if (h.failed) x.tries = Math.min(x.tries + 1, 9);
    else {
      x.createdMs = h.createdMs;
      x.startCwd = h.startCwd;
    }
  }
  return x;
}
async function hydrate(io, { machine: machine2, address }) {
  try {
    const local = localTerminalAddress(address, machine2), r = await io.exec("hc", ["get", local, "--json"], { on: machine2 });
    if (r?.code !== 0 || typeof r.stdout !== "string" || r.stdout.length > LIMITS.historyOutput) return { failed: true };
    const raw = JSON.parse(r.stdout);
    if (localTerminalAddress(raw?.address, machine2) !== local || !time2(raw.created_ms)) return { failed: true };
    return { createdMs: raw.created_ms, startCwd: folder(raw.cwd) };
  } catch {
    return { failed: true };
  }
}
function hydrationNeeds(value, world) {
  const needs = [];
  for (const [key3, live] of world.hosts) {
    if (!live.ready) continue;
    const prev = value.hosts[key3], keep = continuity(prev, world.at), limit = prev?.limit ?? LIMITS.tabs;
    for (const [tid, tab] of Object.entries(live.tabs).slice(0, limit)) for (const t of tab.terms) {
      const old = keep ? prev.tabs[tid]?.terms.find((o) => o.address === t.address) : null;
      if (old?.createdMs != null || (old?.tries ?? 0) >= LIMITS.hydrateTries) continue;
      needs.push({ machine: live.machine, address: t.address });
      if (needs.length >= LIMITS.hydratePerTick) return needs;
    }
  }
  return needs;
}
function closures(value, world) {
  const found = [];
  for (const [key3, live] of world.hosts) {
    const prev = value.hosts[key3];
    if (!live.ready || !continuity(prev, world.at)) continue;
    for (const [tid, old] of Object.entries(prev.tabs)) {
      if (live.tabs[tid] || !old.terms.length || value.suppress.some((s) => s.machine === live.machine && s.tab === old.id && s.until > world.at) || old.terms.some((t) => world.live.has(t.address))) continue;
      found.push({ machine: live.machine, tab: old });
    }
  }
  return found;
}
async function launchRequests(io) {
  const home = (typeof io.appHome === "function" ? io.appHome() : io.appHome).replace(/[/\\]+$/, ""), raw = await io.readTextFile(home + "/mission-control/launches.json");
  if (typeof raw !== "string") return {};
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return {};
  }
  if (value?.v !== 1 || !plain(value.requests)) return {};
  const out = {};
  for (const [id, r] of Object.entries(value.requests)) try {
    const q = r.request;
    out[id] = { machine: machineIdentity(q.machine), repoRoot: strictFolder(q.repoRoot), checkoutRoot: strictFolder(r.folder ?? q.checkoutRoot ?? q.repoRoot), toolKey: text7(q.toolKey, "tool key", 96) };
  } catch {
  }
  return out;
}
async function enrichmentFor(io, candidates) {
  const out = /* @__PURE__ */ new Map();
  if (!candidates.length) return out;
  let proposals = {}, names = null, requests = {};
  try {
    proposals = (await new BindingStore(io, { clock: () => clockOf(io) }).read()).value.proposals;
  } catch {
  }
  try {
    names = (await new NameOwnership(io).read()).value;
  } catch {
  }
  try {
    requests = await launchRequests(io);
  } catch {
  }
  for (const c of candidates) {
    const terminals = /* @__PURE__ */ new Map();
    for (const t of c.tab.terms) {
      let best = null;
      for (const [requestId, b] of Object.entries(proposals)) {
        if (!["committed", "invalidated"].includes(b.state) || !b.session || !b.ack || b.ack.tabId !== c.tab.id) continue;
        const term = b.ack.terminal;
        if (term.machine !== c.machine || term.address !== t.address || t.createdMs != null && term.createdMs !== t.createdMs) continue;
        if (!best || b.updatedAt > best.b.updatedAt) best = { requestId, b };
      }
      if (!best) continue;
      const x = { session: clone4(best.b.session), requestId: best.requestId, originId: best.b.originId }, launch2 = requests[best.requestId];
      if (launch2 && launch2.machine === c.machine) {
        x.repoRoot = launch2.repoRoot;
        x.checkoutRoot = launch2.checkoutRoot;
        x.toolKey = launch2.toolKey;
      }
      terminals.set(t.address, x);
    }
    const originId = names?.tabs?.[JSON.stringify([c.machine, c.tab.id])], o = originId ? names.origins[originId] : null;
    out.set(JSON.stringify([c.machine, c.tab.id]), { terminals, origin: o ? { originId: o.originId, mode: o.mode, manualName: o.mode === "manual" ? o.manualName : null } : null });
  }
  return out;
}
function closedRecord({ machine: machine2, tab, space }, { source, closedAt, seq, extra, ordered = true }) {
  const terminals = tab.terms.slice(0, LIMITS.terminals).map((t) => {
    const x = { address: t.address, createdMs: t.createdMs ?? null, startCwd: t.startCwd ?? null, program: t.program ?? null, agent: Boolean(t.agent), title: t.title ?? null }, b = extra?.terminals?.get(t.address);
    if (b) {
      Object.assign(x, clone4(b));
      x.agent = true;
    }
    return x;
  });
  const id = "c-" + digest2(JSON.stringify([machine2, tab.id, source, closedAt, seq, terminals.map((t) => [t.address, t.createdMs])]));
  return {
    id,
    seq: source === "imported" ? 0 : seq,
    source,
    ordered,
    closedAt,
    machine: machine2,
    kind: terminals.some((t) => t.agent) ? "agent" : "shell",
    space: { id: space?.id || qualified(tab.space, machine2), name: space?.name ?? null, named: space?.named === true, folder: space?.folder ?? null },
    tab: { id: tab.id, name: tab.name ?? null, named: tab.named === true, index: tab.index ?? null },
    terminals,
    panes: Math.min(Math.max(tab.panes ?? 0, terminals.length), 64),
    origin: extra?.origin ? clone4(extra.origin) : null,
    claim: null,
    error: null
  };
}
var structure = (d) => JSON.stringify([Object.entries(d.hosts).map(([k, h]) => [k, h.state, h.limit, h.truncated, h.spaces, Object.entries(h.tabs).map(([id, t]) => [id, t.space, t.index, t.name, t.named, t.panes, t.parkedSince, t.terms.map((x) => [x.address, x.createdMs, x.startCwd, x.program, x.agent, x.tries])])]), d.records.map((r) => r.id), d.suppress]);
function observeDraft(draft, world, { owner: owner2, hydrated, enrichment }) {
  const now3 = world.at, lease = draft.lease;
  if (lease && lease.owner !== owner2 && lease.expiresAt > now3) return { write: false, owned: false, changed: false, recorded: [] };
  const before = structure(draft), recorded = [];
  draft.suppress = draft.suppress.filter((s) => s.until > now3);
  for (const [key3, live] of world.hosts) {
    const prev = draft.hosts[key3];
    if (!live.ready) {
      if (prev?.state !== "unavailable") draft.hosts[key3] = { machine: live.machine, state: "unavailable", observedAt: now3, limit: prev?.limit ?? LIMITS.tabs, truncated: false, spaces: {}, tabs: {} };
      continue;
    }
    const keep = continuity(prev, now3), limit = prev?.limit ?? LIMITS.tabs, entries = Object.entries(live.tabs), tabs = {};
    for (const [tid, tab] of entries.slice(0, limit)) {
      const old = keep ? prev.tabs[tid] : null;
      tabs[tid] = { ...tab, terms: tab.terms.map((t) => carry(t, old?.terms.find((o) => o.address === t.address), hydrated.get(t.address))) };
    }
    if (keep) for (const [tid, old] of Object.entries(prev.tabs)) {
      if (live.tabs[tid] || !old.terms.length) continue;
      const s = draft.suppress.findIndex((x) => x.machine === live.machine && x.tab === old.id);
      if (s >= 0) {
        draft.suppress.splice(s, 1);
        continue;
      }
      if (old.terms.some((t) => world.live.has(t.address))) {
        const since = old.parkedSince ?? now3;
        if (now3 - since < LIMITS.parkedMs) tabs[tid] = { ...old, parkedSince: since };
        continue;
      }
      const extra = enrichment.get(JSON.stringify([live.machine, old.id]));
      if (!extra) {
        tabs[tid] = old;
        continue;
      }
      const closed = closedRecord({ machine: live.machine, tab: old, space: live.spaces[old.space] || prev.spaces[old.space] || null }, { source: "observed", closedAt: now3, seq: draft.seq + 1, extra });
      if (draft.records.some((r) => sameClosure(r, closed))) continue;
      draft.seq++;
      draft.records.push(closed);
      recorded.push(closed.id);
    }
    const spaces = {};
    for (const t of Object.values(tabs)) {
      const info = live.spaces[t.space] || prev?.spaces[t.space];
      if (info) spaces[t.space] = info;
    }
    draft.hosts[key3] = { machine: live.machine, state: "ready", observedAt: prev?.observedAt ?? now3, limit, truncated: entries.length > limit, spaces, tabs };
  }
  for (const [key3, h] of Object.entries(draft.hosts)) if (!world.hosts.has(key3) && h.state !== "unavailable") draft.hosts[key3] = { ...h, state: "unavailable", observedAt: now3, spaces: {}, tabs: {} };
  const stale = Object.entries(draft.hosts).filter(([, h]) => h.state === "unavailable").sort(([, a], [, b]) => a.observedAt - b.observedAt);
  while (Object.keys(draft.hosts).length > LIMITS.hosts && stale.length) delete draft.hosts[stale.shift()[0]];
  boundRecords(draft, now3);
  const changed = structure(draft) !== before, renew = !lease || lease.owner !== owner2 || lease.expiresAt - now3 < LIMITS.leaseMs / 2;
  if (!changed && !renew) return { write: false, owned: true, changed: false, recorded };
  draft.lease = { owner: owner2, expiresAt: now3 + LIMITS.leaseMs };
  for (const h of Object.values(draft.hosts)) if (h.state === "ready") h.observedAt = now3;
  return { write: true, owned: true, changed, recorded };
}
var ClosedWatcher = class {
  constructor(io, { owner: owner2 = randomId("watch"), clock } = {}) {
    this.io = io;
    this.owner = text7(owner2, "watcher owner");
    this.journal = new ClosedJournal(io, { clock });
    this.clock = this.journal.clock;
    this.started = 0;
    this.owned = false;
  }
  async tick() {
    const at = this.clock();
    if (this.started && at - this.started < LIMITS.tickStaleMs) return Object.freeze({ owned: this.owned, skipped: true, recorded: [] });
    this.started = at;
    try {
      const result = await this.observe();
      this.started = 0;
      return result;
    } catch (error2) {
      this.started = 0;
      this.owned = false;
      return Object.freeze({ owned: false, recorded: [], error: Object.freeze({ code: error2?.code || "OBSERVE_FAILED", message: error2 instanceof ClosedTabsError ? error2.message : "Closed tabs could not be observed; the saved history was kept." }) });
    }
  }
  async observe() {
    const snapshot = await this.journal.read(), value = snapshot.value, lease = value.lease, world = snapshotWorld(this.io, this.clock());
    if (lease && lease.owner !== this.owner && lease.expiresAt > world.at) {
      this.owned = false;
      return Object.freeze({ owned: false, changed: false, recorded: [], value });
    }
    const hydrated = /* @__PURE__ */ new Map();
    for (const need of hydrationNeeds(value, world)) hydrated.set(need.address, await hydrate(this.io, need));
    const enrichment = await enrichmentFor(this.io, closures(value, world));
    const { value: next, result } = await this.journal.edit((d) => observeDraft(d, world, { owner: this.owner, hydrated, enrichment }), { snapshot });
    this.owned = result.owned;
    return Object.freeze({ owned: result.owned, changed: Boolean(result.changed), recorded: Object.freeze([...result.recorded]), value: next });
  }
  async release() {
    return this.journal.edit((d) => {
      if (d.lease?.owner !== this.owner) return { write: false };
      d.lease = null;
      return {};
    });
  }
};
var HISTORY_WRAPPER = String.raw`
import json,os,re,select,subprocess,sys,time
q=json.loads(sys.argv[1])
CAP=max(1,min(int(q.get("maxBytes",4194304)),4194304))
END=time.monotonic()+max(100,min(int(q.get("timeoutMs",5000)),5000))/1000.0
LIMIT=max(1,min(int(q.get("limit",100)),100))
BATCH=max(1,min(int(q.get("batch",80)),200))
ADDR=re.compile(r"t[0-9a-z]{1,63}")
ID=re.compile(r"[^\x00-\x1f\x7f]{1,256}")
NAME=re.compile(r"[a-z0-9][a-z0-9._+-]{0,63}")
# Herdr login wrappers: local "-lic" and the remote "-c" form (split so the JS template never interpolates).
WRAPS={"-lic":'"$@"; exec "$0" -li',"-c":'"$@"; exec "$' '{SHELL:-sh}" -i'}
used=0
class Stop(Exception):
 pass
def emit(value):
 sys.stdout.write(json.dumps(value,separators=(",",":")))
 sys.stdout.flush()
 sys.exit(0)
def call(args):
 global used
 try:
  p=subprocess.Popen(["hc"]+args,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
 except OSError:
  raise Stop("HC_UNAVAILABLE")
 done=False
 try:
  fd=p.stdout.fileno();chunks=[]
  while True:
   left=END-time.monotonic()
   if left<=0 or not select.select([fd],[],[],left)[0]:
    raise Stop("TIME_LIMIT")
   data=os.read(fd,65536)
   if not data:
    break
   used+=len(data)
   if used>CAP:
    raise Stop("BYTE_LIMIT")
   chunks.append(data)
  try:
   code=p.wait(timeout=max(0.01,END-time.monotonic()))
  except subprocess.TimeoutExpired:
   raise Stop("TIME_LIMIT")
  done=True
  return code,b"".join(chunks)
 finally:
  if not done:
   try:
    p.kill();p.wait(timeout=1)
   except Exception:
    pass
  p.stdout.close()
def clean(v,n):
 if not isinstance(v,str):
  return None
 v=" ".join("".join(" " if ord(c)<32 or ord(c)==127 else c for c in v).split())[:n].strip()
 return v or None
def path(v):
 return v if isinstance(v,str) and 0<len(v)<=1024 and ID.fullmatch(v[:256]) and not any(ord(c)<32 or ord(c)==127 for c in v) else None
def program(argv):
 if not isinstance(argv,list) or not argv or not all(isinstance(a,str) for a in argv):
  return None
 if len(argv)>4 and WRAPS.get(argv[1])==argv[2] and argv[3]==argv[0]:
  argv=argv[4:]
 name=os.path.basename(argv[0]).lower()
 return name if NAME.fullmatch(name) else None
def natural(a):
 return (len(a),a)
try:
 code,raw=call(["ls","--all","--json"])
except Stop as e:
 emit({"ok":False,"code":e.args[0]})
if code!=0:
 emit({"ok":False,"code":"HC_FAILED"})
try:
 envelope=json.loads(raw.decode("utf-8"))
except Exception:
 emit({"ok":False,"code":"MALFORMED"})
if not isinstance(envelope,dict) or not isinstance(envelope.get("terminals"),list):
 emit({"ok":False,"code":"MALFORMED"})
found=set()
for row in envelope["terminals"]:
 if isinstance(row,dict) and isinstance(row.get("address"),str) and ADDR.fullmatch(row["address"]) and isinstance(row.get("state"),str) and row["state"]!="live" and not row.get("parent"):
  found.add(row["address"])
pending=sorted(found,key=natural,reverse=True)
cursor=q.get("cursor")
if isinstance(cursor,str) and ADDR.fullmatch(cursor):
 pending=[a for a in pending if natural(a)<natural(cursor)]
rows=[];scanned=0;stopped=None;last=None
for address in pending[:BATCH]:
 try:
  code,raw=call(["get",address,"--json"])
 except Stop as e:
  stopped=e.args[0]
  break
 scanned+=1;last=address
 if code!=0:
  continue
 try:
  t=json.loads(raw.decode("utf-8"))
 except Exception:
  continue
 if not isinstance(t,dict) or t.get("address")!=address or t.get("state")=="live" or t.get("parent"):
  continue
 labels=t.get("labels") if isinstance(t.get("labels"),dict) else {}
 space,tab,created,finished=labels.get("herdr.space"),labels.get("herdr.tab"),t.get("created_ms"),t.get("finished_ms")
 if not (isinstance(space,str) and ID.fullmatch(space) and isinstance(tab,str) and ID.fullmatch(tab)) or type(created) is not int or created<0:
  continue
 rows.append({"address":address,"createdMs":created,"finishedMs":finished if type(finished) is int and finished>=0 else None,"space":space,"tab":tab,"cwd":path(t.get("cwd")),"title":clean(t.get("title") or t.get("name"),160),"program":program(t.get("argv"))})
hidden=envelope.get("hidden_finished")
remaining=len(pending)-scanned
complete=stopped is None and remaining==0 and not (type(hidden) is int and hidden>0)
rows.sort(key=lambda r:(r["finishedMs"] is None,-(r["finishedMs"] or 0)))
emit({"ok":True,"complete":complete,"stopped":stopped,"cursor":last if remaining>0 else None,"scanned":scanned,"candidates":len(pending),"records":rows[:LIMIT]})
`;
var historyReasons = { BYTE_LIMIT: "herdr-core history exceeded the 4 MiB import limit.", TIME_LIMIT: "herdr-core did not answer within 5 seconds.", HC_UNAVAILABLE: "hc is not available there.", HC_FAILED: "hc could not list finished terminals.", MALFORMED: "hc returned an unexpected history format." };
function historyRows(out, machine2) {
  if (!Array.isArray(out.records) || out.records.length > LIMITS.records) return null;
  const rows = [];
  for (const r of out.records) try {
    if (!time2(r.createdMs) || r.finishedMs !== null && !time2(r.finishedMs)) continue;
    rows.push({ address: qualified(localTerminalAddress(r.address, machine2), machine2), createdMs: r.createdMs, finishedMs: r.finishedMs, space: text7(r.space, "space"), tab: text7(r.tab, "tab"), startCwd: folder(r.cwd), title: displayText(r.title), program: typeof r.program === "string" && /^[a-z0-9][a-z0-9._+-]{0,63}$/.test(r.program) ? r.program : null });
  } catch {
  }
  return rows;
}
async function importClosedHistory(machine2, io, { timeoutMs = LIMITS.historyMs, maxBytes = LIMITS.historyBytes, batch = LIMITS.historyBatch } = {}) {
  const on = machineIdentity(machine2), journal2 = new ClosedJournal(io), key3 = hostKey(on), where2 = on ?? "this computer";
  const unavailable = async (reason) => {
    try {
      await journal2.edit((d, now3) => {
        d.imports[key3] = { at: now3, state: "unavailable", reason, cursor: d.imports[key3]?.cursor ?? null };
      });
    } catch {
    }
    return freeze2({ ok: false, code: "OLDER_HISTORY_UNAVAILABLE", machine: on, message: `Older closed-tab history is unavailable on ${where2}: ${reason} Current history was kept.` });
  };
  if (typeof io.machines === "function" && io.machines().find((m) => safeMachine(m?.name) === on)?.layout !== "ready") return unavailable("the machine is offline or still loading.");
  let before;
  try {
    before = (await journal2.read()).value;
  } catch (error2) {
    return freeze2({ ok: false, code: error2.code || "INVALID_CLOSED", machine: on, message: error2.message });
  }
  const previous = before.imports[key3], request = JSON.stringify({ v: 1, cursor: previous?.state === "partial" ? previous.cursor : null, maxBytes: Math.min(maxBytes, LIMITS.historyBytes), timeoutMs: Math.min(timeoutMs, LIMITS.historyMs), limit: LIMITS.records, batch: Math.min(batch, 200) });
  let result;
  try {
    result = await io.exec("python3", ["-c", HISTORY_WRAPPER, request], { on });
  } catch {
    return unavailable("Python 3 could not be started there.");
  }
  if (result?.code !== 0 || typeof result.stdout !== "string" || result.stdout.length > LIMITS.historyOutput) return unavailable("the history helper failed.");
  let out;
  try {
    out = JSON.parse(result.stdout);
  } catch {
    return unavailable("the history helper returned invalid data.");
  }
  if (out?.ok !== true) return unavailable(historyReasons[out?.code] || "the history helper failed.");
  const rows = historyRows(out, on), cursor = typeof out.cursor === "string" && /^t[0-9a-z]{1,63}$/.test(out.cursor) ? out.cursor : null, complete = out.complete === true && !cursor;
  if (!rows) return unavailable("the history helper returned invalid data.");
  const world = snapshotWorld(io), live = world.hosts.get(key3), groups = /* @__PURE__ */ new Map();
  for (const r of rows) {
    const k = JSON.stringify([r.space, r.tab]);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const candidates = [];
  for (const g of groups.values()) {
    const tabId = qualified(g[0].tab, on);
    if (!live?.ready || live.tabs[localId(tabId, on)]) continue;
    const space = live.spaces[g[0].space] || { id: qualified(g[0].space, on), name: null, named: false, folder: null };
    candidates.push({
      machine: on,
      space,
      closedAt: Math.max(...g.map((r) => r.finishedMs ?? r.createdMs)),
      ordered: complete && g.every((r) => r.finishedMs !== null),
      tab: { id: tabId, space: g[0].space, index: null, name: null, named: false, panes: g.length, terms: g.slice(0, LIMITS.terminals).map((r) => ({ address: r.address, createdMs: r.createdMs, startCwd: r.startCwd, program: r.program ? { key: r.program, name: r.program } : null, agent: KNOWN_AGENTS.has(r.program), title: r.title })) }
    });
  }
  const enrichment = await enrichmentFor(io, candidates);
  try {
    const { result: summary } = await journal2.edit((d, now3) => {
      let added = 0;
      for (const c of candidates) {
        const closed = closedRecord(c, { source: "imported", closedAt: c.closedAt, seq: 0, extra: enrichment.get(JSON.stringify([on, c.tab.id])), ordered: c.ordered });
        if (d.records.some((r) => sameClosure(r, closed))) continue;
        d.records.push(closed);
        added++;
      }
      d.imports[key3] = { at: now3, state: complete ? "complete" : "partial", reason: null, cursor };
      boundRecords(d, now3);
      return { added };
    });
    return freeze2({ ok: true, machine: on, added: summary.added, complete, scanned: Number.isSafeInteger(out.scanned) ? out.scanned : 0, message: `Imported ${summary.added} older closed tab${summary.added === 1 ? "" : "s"} from ${where2}${complete ? "." : "; history is partial, so its order is unverified."}` });
  } catch (error2) {
    return freeze2({ ok: false, code: error2.code || "IMPORT_FAILED", machine: on, message: error2 instanceof ClosedTabsError ? error2.message : "Imported history could not be saved; current history was kept." });
  }
}

// src/shared/reopen.js
var ReopenError = class extends Error {
  constructor(code, message, recovery, { uncertain = false } = {}) {
    super(message);
    this.name = "ReopenError";
    this.code = code;
    if (recovery) this.recovery = recovery;
    this.uncertain = uncertain;
  }
};
var fail10 = (code, message, recovery, options) => {
  throw new ReopenError(code, message, recovery, options);
};
var clone5 = (v) => JSON.parse(JSON.stringify(v));
var freeze3 = (v) => {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    for (const c of Object.values(v)) freeze3(c);
    Object.freeze(v);
  }
  return v;
};
var clockOf2 = (io) => io.clock ? io.clock() : Date.now();
var safeMachine2 = (v) => {
  try {
    return machineIdentity(v);
  } catch {
    return void 0;
  }
};
var where = (on) => on ?? "this computer";
var REOPEN_KINDS = Object.freeze(["tab", "agent"]);
var REOPEN_COMMANDS = Object.freeze({ "reopen-tab": "tab", "reopen-agent": "agent" });
var REOPEN_LIMITATIONS = Object.freeze([
  "Reopen last tab restores the most recently closed tab in its original space on its original machine. Reopen last agent does the same for the most recently closed agent and skips shell-only tabs.",
  "A shell reopens in the folder it started in, not its last cd. Its old command is never run again.",
  "An agent reopens only through its exact saved session ID on the same machine and provider profile (for example claude --resume <id>). --last and --continue are never guessed. An agent without an exact session cannot be resumed; Reopen last tab opens a shell in its folder instead.",
  "If the closed tab was the last one in its space, the space is recreated from its saved folder on the same machine, only after that folder is verified there.",
  "Split layout, extra panes and mod panes are not recorded; only the main terminal comes back.",
  "Closes are recorded every 2 seconds while this bar or the Mission Control tab bar is running. Closes while a machine is offline, or while Herdr is closed, are not recorded. Older history can be imported from herdr-core; partial imports are labelled and their order is unverified.",
  "The last 100 closed tabs are kept in mission-control/closed.json in the Herdr app folder: names, titles, folders and program names only, never command arguments.",
  "A manual tab name returns with its tab; automatic names stay automatic.",
  "Commands: mission-control-reopen.reopen-tab, mission-control-reopen.reopen-agent and mission-control-reopen.open. No keys are bound by default; add your own in keys.json. Commands reach a shown copy of this mod only."
]);
var actions2 = { NOTHING_TO_REOPEN: ["import-history"], HISTORY_PARTIAL: ["choose", "import-history"], REOPEN_IN_PROGRESS: ["retry"], RECORD_GONE: [], HOST_UNAVAILABLE: ["retry"], SPACE_UNAVAILABLE: ["retry"], FOLDER_MISSING: ["retry"], WORKTREE_MISSING: ["locate", "retry"], FOLDER_UNKNOWN: [], NO_EXACT_SESSION: [], TAB_CREATE_UNCERTAIN: ["locate", "retry-uncertain"], MALFORMED_ACK: ["locate", "retry-uncertain"], REOPEN_FAILED: ["retry"], CLAIM_LOST: ["retry"], CONFLICT: ["retry"], PREVIOUS_RESTORE_CLOSED: [], INVALID_CLOSED: [], INVALID_REOPEN: [] };
var terminal2 = /* @__PURE__ */ new Set(["RECORD_GONE", "REOPEN_IN_PROGRESS", "PREVIOUS_RESTORE_CLOSED", "INVALID_CLOSED"]);
var known2 = (e) => e instanceof ReopenError || e instanceof ClosedTabsError || e instanceof ResumeError || e instanceof LaunchError || e instanceof IdentityError || ["ConfigError", "WorktreeError", "CapabilityError"].includes(e?.name);
function failure2(code, message, recovery) {
  const extra = recovery && typeof recovery === "object" ? clone5(recovery) : {}, list = [...extra.actions || actions2[code] || []];
  if (extra.recordId && !terminal2.has(code) && !list.includes("dismiss")) list.push("dismiss");
  return freeze3({ ok: false, code, message, recovery: { ...extra, actions: list } });
}
var meaningful = (v) => {
  const s = displayText(v, 120);
  return s && !/^\d+$/.test(s) && !/^[/~]/.test(s) ? s : null;
};
function recordTitle(r) {
  const t = r.terminals.find((x) => x.session) || r.terminals.find((x) => x.agent) || r.terminals[0];
  return displayText(r.origin?.mode === "manual" ? r.origin.manualName : null, 120) || (r.tab.named ? displayText(r.tab.name, 120) : null) || meaningful(t?.title) || t?.program?.name || (r.kind === "agent" ? "Agent" : "Shell");
}
var recordDestination = (r) => [r.space.name || "Closed space", r.machine || "This Mac"].join(" · ");
var eligible = (r, kind) => kind === "tab" || r.kind === "agent";
var empty3 = { tab: "No closed tab has been recorded yet. Tabs closed while this bar or the Mission Control tab bar is running appear here.", agent: "No closed agent has been recorded yet. Shell-only tabs are skipped." };
function selectRecord(value, kind, { now: now3 = Date.now() } = {}) {
  if (!REOPEN_KINDS.includes(kind)) return { error: ["INVALID_REOPEN", "Choose Reopen last tab or Reopen last agent."] };
  const records = (value?.records || []).filter((r) => eligible(r, kind));
  let record2 = records.filter((r) => r.source !== "imported").sort((a, b) => b.seq - a.seq)[0];
  if (!record2) {
    const imported = records.filter((r) => r.source === "imported");
    if (!imported.length) return { error: ["NOTHING_TO_REOPEN", empty3[kind]] };
    if (imported.some((r) => !r.ordered)) return { error: ["HISTORY_PARTIAL", "Only partial older history was imported, so the most recently closed tab is not known. Choose one from the list."] };
    record2 = [...imported].sort((a, b) => b.closedAt - a.closedAt)[0];
  }
  if (record2.claim && record2.claim.until > now3) return { record: record2, error: ["REOPEN_IN_PROGRESS", "This closed tab is already being reopened; wait for it to appear."] };
  return { record: record2 };
}
function restorePlan(record2, kind = "tab") {
  const exact = record2.terminals.find((t) => t.session), notices = record2.panes > 1 ? ["panes-not-restored"] : [];
  if (kind === "agent") {
    if (record2.kind !== "agent") fail10("NOT_AN_AGENT", "This closed tab ran no agent. Use Reopen last tab.");
    if (!exact) fail10("NO_EXACT_SESSION", "This agent was not started with an exact session ID, so it cannot be resumed without guessing. Reopen last tab opens a shell in its folder instead, or forget it.");
  }
  if (exact) return { mode: "agent", terminal: exact, notices };
  return { mode: "shell", terminal: record2.terminals[0], notices: [...record2.kind === "agent" ? ["agent-not-resumed"] : [], ...notices] };
}
function reopenPreview(value, kind, { now: now3 = Date.now() } = {}) {
  const base3 = { kind, label: kind === "agent" ? "Reopen last agent" : "Reopen last tab", recordId: null, title: null, detail: null, imported: false, reason: null, lastError: null };
  if (!value) return freeze3({ ...base3, state: "loading", reason: "Reading closed tabs…" });
  const choice = selectRecord(value, kind, { now: now3 });
  if (choice.error && !choice.record) return freeze3({ ...base3, state: choice.error[0] === "HISTORY_PARTIAL" ? "partial" : "empty", reason: choice.error[1] });
  const r = choice.record, preview = { ...base3, state: "ready", recordId: r.id, title: recordTitle(r), detail: recordDestination(r), imported: r.source === "imported", lastError: r.error?.message ?? null };
  if (choice.error) return freeze3({ ...preview, state: "busy", reason: choice.error[1] });
  try {
    const p = restorePlan(r, kind);
    if (p.notices.includes("agent-not-resumed")) preview.reason = "Opens a shell in its folder: this agent has no exact session to resume.";
  } catch (error2) {
    preview.state = "unsupported";
    preview.reason = error2.message;
  }
  return freeze3(preview);
}
var opId = () => "reopen-op-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
var hostReady = (io, on) => typeof io.machines !== "function" || io.machines().find((m) => safeMachine2(m?.name) === on)?.layout === "ready";
function findSpace(io, record2) {
  const all = io.spaces() || [];
  for (const id of [record2.space.replacement, record2.space.id].filter(Boolean)) {
    const s = all.find((x) => x.id === id && safeMachine2(x.machine) === record2.machine);
    if (s) return s;
  }
  return null;
}
var pause = async (io, ms) => {
  if (io.delay) await io.delay(ms);
  else await io.exec("sleep", [String(ms / 1e3)]);
};
async function appear(io, match, message) {
  for (let i = 0; i < 10; i++) {
    if ((io.spaces() || []).some(match)) return true;
    await pause(io, 150);
  }
  if (message) fail10("SPACE_UNAVAILABLE", message);
  return false;
}
async function folderExists(io, path, on) {
  try {
    return (await io.exec("test", ["-d", path], { on }))?.code === 0;
  } catch {
    fail10("HOST_UNAVAILABLE", `${where(on)} became unreachable while its folder was checked; nothing was opened.`);
  }
}
async function create(io, command, args, { machine: machine2, spaceId }) {
  let response;
  try {
    response = await io.exec("herdr-app", ["do", command, JSON.stringify(args)]);
  } catch {
    fail10("REOPEN_FAILED", "Herdr’s command line could not be started; nothing was opened.");
  }
  let parsed = null;
  try {
    parsed = JSON.parse(response?.stdout);
  } catch {
  }
  if (response?.code !== 0) {
    if (parsed && typeof parsed === "object" && typeof parsed.error === "string" && Object.keys(parsed).length === 1) fail10("REOPEN_FAILED", `Herdr refused to ${command === "space.new" ? "recreate the space" : "open the tab"}: ${displayText(parsed.error, 300) || "unknown error"}`);
    fail10("TAB_CREATE_UNCERTAIN", "Herdr did not acknowledge the new tab; it may still have been created. Check the space before opening it again.", void 0, { uncertain: true });
  }
  try {
    if (command === "tab.new") return verifyTabAcknowledgement(parsed, { spaceId, machine: machine2 });
    const value = { space: parsed?.space, tab: parsed?.tab, terminal: parsed?.terminal };
    for (const f of ["space", "tab", "terminal"]) if (typeof value[f] !== "string" || !value[f] || value[f].length > 256 || /[\u0000-\u001f]/.test(value[f])) throw Error(f);
    if (machine2 && (!value.space.startsWith(machine2 + "/") || !value.tab.startsWith(machine2 + "/"))) throw Error("host");
    localTerminalAddress(value.terminal, machine2);
    return value;
  } catch {
    fail10("MALFORMED_ACK", "Herdr returned an invalid acknowledgment; no second tab will be opened automatically.", void 0, { uncertain: true });
  }
}
function focus2(io, ack2) {
  io.run("space.select", { id: ack2.space });
  io.run("tab.select", { id: ack2.tab });
  io.run("pane.focus", { terminal: ack2.terminal });
}
async function transferNames(io, record2, { tabId, name: name2 }) {
  const names = new NameOwnership(io, { clock: () => clockOf2(io) }), originId = record2.origin.originId;
  const owned = await names.transferToAcknowledgedTab({ originId }, { machine: record2.machine, tabId, name: name2 ?? null });
  if (owned.mode === "manual" && owned.manualName && owned.manualName !== name2) await names.applyName(originId, owned.manualName, { manualTransfer: true, getTabs: () => (io.spaces() || []).flatMap((s) => s.tabs.map((t) => ({ ...t, machine: s.machine }))), rename: (args) => io.run("tab.rename", args) });
}
function success(record2, fields) {
  return freeze3({ ok: true, recordId: record2.id, machine: record2.machine, kind: record2.kind, title: recordTitle(record2), destination: recordDestination(record2), notices: [], ...fields });
}
async function finish(io, journal2, record2, owner2, ack2, { action, name: name2, recreatedSpace, notices }) {
  const extra = [...notices];
  if (record2.origin?.originId) try {
    await transferNames(io, record2, { tabId: ack2.tab, name: name2 });
  } catch {
    extra.push("names-not-transferred");
  }
  await journal2.consume(record2.id, owner2);
  focus2(io, ack2);
  return success(record2, { action, spaceId: ack2.space, tabId: ack2.tab, terminalId: ack2.terminal, recreatedSpace, notices: extra });
}
var manualName = (record2) => record2.origin?.mode === "manual" ? record2.origin.manualName : record2.tab.named ? record2.tab.name : null;
async function restoreShell(io, journal2, record2, owner2, space, plan) {
  const on = record2.machine, cwd = plan.terminal.startCwd ?? record2.space.folder;
  if (!cwd) fail10("FOLDER_UNKNOWN", "This tab’s starting folder was not recorded, so it cannot be reopened safely.");
  if (!await folderExists(io, cwd, on)) fail10("FOLDER_MISSING", `${cwd} no longer exists on ${where(on)}. Recreate it and retry, or forget this tab.`);
  const name2 = manualName(record2);
  const [command, args] = space ? ["tab.new", { space: space.id, folder: cwd, ...name2 ? { name: name2 } : {} }] : ["space.new", { folder: cwd, ...on ? { machine: on } : {}, ...record2.space.named && record2.space.name ? { name: record2.space.name } : {}, ...name2 ? { tab: name2 } : {} }];
  await journal2.updateClaim(record2.id, owner2, { phase: "attempting" });
  const ack2 = await create(io, command, args, { machine: on, spaceId: space?.id });
  await journal2.updateClaim(record2.id, owner2, { phase: "acknowledged", ack: ack2 }, space ? {} : { replacement: ack2.space });
  return finish(io, journal2, record2, owner2, ack2, { action: "shell", name: name2, recreatedSpace: !space, notices: plan.notices });
}
async function finishAcknowledged(io, journal2, record2, owner2) {
  const ack2 = record2.claim.ack;
  if (!(io.spaces() || []).some((s) => s.tabs?.some((t) => t.id === ack2.tab))) {
    await journal2.consume(record2.id, owner2);
    fail10("PREVIOUS_RESTORE_CLOSED", "This tab was already reopened and that tab has since been closed; reopen its newer record instead.");
  }
  return finish(io, journal2, record2, owner2, ack2, { action: "focus", name: manualName(record2), recreatedSpace: Boolean(record2.space.replacement), notices: [] });
}
async function closeScaffold(io, journal2, scaffold, agentTab, on) {
  try {
    for (let i = 0; i < 10; i++) {
      const all = io.spaces() || [], space = all.find((s) => s.id === scaffold.space);
      if (!space || !space.tabs?.some((t) => t.id === scaffold.tab)) return true;
      if (space.tabs.some((t) => t.id === agentTab)) {
        await journal2.expectClose(on, scaffold.tab);
        io.run("tab.close", { id: scaffold.tab, confirmed: true });
        return true;
      }
      if (space.tabs.length === 1 && all.some((s) => s.id !== scaffold.space && s.tabs?.some((t) => t.id === agentTab))) {
        await journal2.expectClose(on, scaffold.tab);
        io.run("space.close", { id: scaffold.space, confirmed: true });
        return true;
      }
      await pause(io, 150);
    }
  } catch {
  }
  return false;
}
async function retireClosedBinding(io, on, t) {
  if (!t.requestId) return;
  let raw = null;
  try {
    const r = await io.exec("hc", ["get", localTerminalAddress(t.address, on), "--json"], { on });
    if (r?.code === 0) raw = JSON.parse(r.stdout);
  } catch (error2) {
    if (error2 instanceof SyntaxError) raw = null;
    else fail10("HOST_UNAVAILABLE", `${where(on)} became unreachable while its terminals were checked; nothing was resumed.`);
  }
  if (raw?.state === "live" && (t.createdMs === null || raw.created_ms === t.createdMs)) return;
  const store = new BindingStore(io, { clock: () => clockOf2(io) }), state = await store.requestState(t.requestId), term = state?.ack?.terminal;
  if (state?.state === "committed" && term?.machine === on && term.address === t.address && (t.createdMs === null || term.createdMs === t.createdMs)) await store.invalidate(t.requestId, "Terminal closed; recorded by reopen");
}
async function restoreAgent(io, journal2, record2, owner2, space, plan) {
  const on = record2.machine, t = plan.terminal, session = t.session;
  let cwd = t.checkoutRoot ?? t.startCwd, repoRoot = t.repoRoot ?? null;
  if (!cwd) fail10("FOLDER_UNKNOWN", "This agent’s checkout folder was not recorded, so it cannot be resumed safely.");
  if (!repoRoot) {
    const resolved = await resolveSpaceRepo({ id: "reopen-probe", machine: on, active: false, tabs: [{ id: "reopen-probe" }] }, [{ pane: "reopen-probe", tab: "reopen-probe", terminal: "t0", cwd }], io.exec);
    if (resolved.state !== "resolved") fail10("WORKTREE_MISSING", "The agent’s repository folder is missing or is no longer a Git checkout on its machine. Locate it and retry, or forget this agent.");
    repoRoot = resolved.repoRoot;
    cwd = resolved.worktreeRoot;
  }
  let scaffold = record2.claim.scaffold && space?.id === record2.claim.scaffold.space ? record2.claim.scaffold : null, spaceId = space?.id ?? null;
  if (!space) {
    if (!await folderExists(io, cwd, on)) fail10("WORKTREE_MISSING", `${cwd} no longer exists on ${where(on)}. Locate it and retry, or forget this agent.`);
    await journal2.updateClaim(record2.id, owner2, { phase: "attempting" });
    scaffold = await create(io, "space.new", { folder: cwd, ...on ? { machine: on } : {}, ...record2.space.named && record2.space.name ? { name: record2.space.name } : {} }, { machine: on });
    await journal2.updateClaim(record2.id, owner2, { phase: "claimed", scaffold }, { replacement: scaffold.space });
    spaceId = scaffold.space;
    await appear(io, (s) => s.id === spaceId && safeMachine2(s.machine) === on, "The recreated space has not appeared yet; retry in a moment.");
  }
  await retireClosedBinding(io, on, t);
  await journal2.updateClaim(record2.id, owner2, {});
  const originId = record2.origin?.originId ?? t.originId, title = record2.origin?.mode === "manual" ? null : record2.tab.named ? displayText(record2.tab.name, 200) : meaningful(t.title);
  const result = await resume({ requestId: record2.claim.requestId, spaceId, session, repoRoot, cwd, toolKey: t.toolKey ?? session.provider, ...originId ? { originId } : {}, ...title ? { title } : {} }, io);
  if (!result.ok) fail10(result.code, result.message, result.recovery);
  const notices = [...plan.notices];
  if (scaffold && result.tabId && result.tabId !== scaffold.tab && !await closeScaffold(io, journal2, scaffold, result.tabId, on)) notices.push("scaffold-tab-kept");
  await journal2.consume(record2.id, owner2);
  return success(record2, { action: result.action === "focus" ? "focus" : "resume", spaceId, tabId: result.tabId, terminalId: result.terminalId, recreatedSpace: Boolean(scaffold), originId: result.originId, session: result.session, notices });
}
async function reopenRecord(id, io, { owner: owner2 = opId(), kind = "tab", confirmUncertain = false } = {}) {
  let journal2, claimed = false;
  try {
    if (!REOPEN_KINDS.includes(kind)) fail10("INVALID_REOPEN", "Choose Reopen last tab or Reopen last agent.");
    journal2 = new ClosedJournal(io, { clock: () => clockOf2(io) });
    const record2 = await journal2.claim(id, owner2, { confirmUncertain });
    claimed = true;
    if (record2.claim.phase === "acknowledged" && record2.claim.ack) return await finishAcknowledged(io, journal2, record2, owner2);
    const plan = restorePlan(record2, kind);
    if (!hostReady(io, record2.machine)) fail10("HOST_UNAVAILABLE", `${where(record2.machine)} is offline or still loading; the closed tab was kept.`);
    const space = findSpace(io, record2);
    return plan.mode === "agent" ? await restoreAgent(io, journal2, record2, owner2, space, plan) : await restoreShell(io, journal2, record2, owner2, space, plan);
  } catch (error2) {
    const code = error2?.code || "REOPEN_FAILED", message = known2(error2) ? error2.message : "Reopen could not complete; the closed tab was kept.";
    if (claimed) try {
      await journal2.release(id, owner2, { code, message, definite: !error2?.uncertain });
    } catch {
    }
    return failure2(code, message, { ...error2?.recovery || {}, recordId: id });
  }
}
async function reopen(kind, io, options = {}) {
  try {
    if (!REOPEN_KINDS.includes(kind)) fail10("INVALID_REOPEN", "Choose Reopen last tab or Reopen last agent.");
    const { value } = await new ClosedJournal(io).read(), choice = selectRecord(value, kind, { now: clockOf2(io) });
    if (choice.error) return failure2(choice.error[0], choice.error[1], choice.record ? { recordId: choice.record.id } : void 0);
    return await reopenRecord(choice.record.id, io, { ...options, kind });
  } catch (error2) {
    return failure2(error2?.code || "REOPEN_FAILED", known2(error2) ? error2.message : "Closed tabs could not be read; nothing was opened.");
  }
}
async function dismissRecord(id, io, { owner: owner2 } = {}) {
  try {
    const result = await new ClosedJournal(io).dismiss(id, { owner: owner2 });
    return freeze3({ ok: true, dismissed: result.dismissed });
  } catch (error2) {
    return failure2(error2?.code || "DISMISS_FAILED", known2(error2) ? error2.message : "This closed tab could not be forgotten.");
  }
}
var BUSY_MS = 9e4;
var ReopenController = class {
  constructor(io, { owner: owner2 = "reopen-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10) } = {}) {
    this.io = io;
    this.owner = owner2;
    this.journal = new ClosedJournal(io, { clock: () => clockOf2(io) });
    this.watcher = new ClosedWatcher(io, { owner: owner2 + "-watch" });
    this.value = null;
    this.error = null;
    this.busy = /* @__PURE__ */ new Map();
    this.sequence = 0;
    this.importing = 0;
    this.lastImport = null;
  }
  async refresh() {
    try {
      this.value = (await this.journal.read()).value;
      this.error = null;
    } catch (error2) {
      this.error = Object.freeze({ code: error2?.code || "INVALID_CLOSED", message: known2(error2) ? error2.message : "Closed tabs could not be read." });
    }
    return this.value;
  }
  // A copy that does not hold the recording lease is skipped by the watcher, but must still read the journal
  // another copy records into; otherwise its Reopen preview stays on a stale "last" record.
  async tick() {
    const result = await this.watcher.tick();
    if (result.value) {
      this.value = result.value;
      this.error = null;
    } else if (result.error) this.error = result.error;
    else await this.refresh();
    return result;
  }
  get revision() {
    return this.value?.revision ?? null;
  }
  running() {
    const now3 = clockOf2(this.io);
    for (const [key3, at] of this.busy) if (now3 - at >= BUSY_MS) this.busy.delete(key3);
    return this.busy.size > 0;
  }
  preview(kind) {
    const p = reopenPreview(this.value, kind, { now: clockOf2(this.io) });
    return this.running() && p.state === "ready" ? freeze3({ ...p, state: "busy", reason: "Reopening…" }) : p;
  }
  recent(limit = 6) {
    const now3 = clockOf2(this.io);
    return (this.value?.records || []).slice(0, limit).map((r) => freeze3({ id: r.id, kind: r.kind, title: recordTitle(r), destination: recordDestination(r), closedAt: r.closedAt, imported: r.source === "imported", ordered: r.ordered, error: r.error?.message ?? null, busy: Boolean(r.claim && r.claim.until > now3), exact: r.terminals.some((t) => t.session) }));
  }
  async run(kind, { recordId, confirmUncertain = false } = {}) {
    if (this.running()) return failure2("REOPEN_IN_PROGRESS", "A reopen is already running; wait for it to appear.");
    const key3 = ++this.sequence;
    this.busy.set(key3, clockOf2(this.io));
    let result;
    try {
      const owner2 = this.owner + "-" + key3;
      result = recordId ? await reopenRecord(recordId, this.io, { owner: owner2, kind, confirmUncertain }) : await reopen(kind, this.io, { owner: owner2, confirmUncertain });
    } catch {
      result = failure2("REOPEN_FAILED", "Reopen could not complete; the closed tab was kept.");
    }
    this.busy.delete(key3);
    await this.refresh();
    return result;
  }
  async dismiss(id) {
    const result = await dismissRecord(id, this.io);
    await this.refresh();
    return result;
  }
  async importHistory() {
    const now3 = clockOf2(this.io);
    if (this.importing && now3 - this.importing < LIMITS.historyMs * LIMITS.hosts) return [failure2("IMPORT_IN_PROGRESS", "Older history is already being imported.")];
    this.importing = now3;
    const results = [];
    const hosts = (typeof this.io.machines === "function" ? this.io.machines() || [] : [{ name: null, layout: "ready" }]).filter((m) => m && !m.temporary && safeMachine2(m.name) !== void 0).slice(0, LIMITS.hosts);
    for (const m of hosts) results.push(await importClosedHistory(m.name ?? null, this.io));
    this.importing = 0;
    this.lastImport = freeze3({ at: clockOf2(this.io), results });
    await this.refresh();
    return results;
  }
  release() {
    return this.watcher.release();
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

// src/mods/mission-control-reopen/main.js
var MOD = "mission-control-reopen";
var COMMAND_EVENT = "mission-control-reopen-command-v1";
var COMMANDS = /* @__PURE__ */ new Set([...Object.keys(REOPEN_COMMANDS), "open", "help", "import"]);
var RECOVERY = { retry: "Retry", "retry-binding": "Retry", "retry-uncertain": "Open it anyway", dismiss: "Forget it", locate: "Show its space", "close-existing-and-retry": "Show running agent", "import-history": "Import older history" };
var NOTICES = { "agent-not-resumed": "Opened as a shell: the agent had no exact session.", "panes-not-restored": "Only its main pane came back.", "names-not-transferred": "Its saved name could not be restored.", "scaffold-tab-kept": "A helper shell tab stayed open." };
var ago = (at, now3) => {
  const s = Math.max(0, Math.round((now3 - at) / 1e3));
  return s < 60 ? "just now" : s < 3600 ? Math.floor(s / 60) + " min ago" : s < 86400 ? Math.floor(s / 3600) + " h ago" : Math.floor(s / 86400) + " d ago";
};
var kindLabel = (kind) => kind === "agent" ? "Reopen last agent" : "Reopen last tab";
var IMPORT_STALE_MS = LIMITS.historyMs * LIMITS.hosts + 3e4;
var MissionControlReopen = class extends View {
  init(_props, cx) {
    this.props = herdr.props() || {};
    this.role = this.props.view === "help" ? "help" : this.props.view === "popup" || this.props.overlay ? "popup" : "bar";
    this.closed = false;
    this.jobs = [];
    this.timers = [];
    this.status = null;
    this.polling = 0;
    this.importing = 0;
    this.importStatus = null;
    this.instance = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    if (this.role === "help") return;
    this.io = createLaunchIO(herdr);
    this.controller = new ReopenController(this.io, { owner: MOD + "-" + this.instance });
    this.poll(cx, { force: true });
    this.timers.push(cx.timer.every(LIMITS.observeMs, (eventCx) => this.poll(eventCx)));
    this.commandTask = cx.spawn(async (taskCx) => {
      while (!this.closed) {
        const command = await herdr.nextCommand();
        if (this.closed) return;
        this.command(command, taskCx);
      }
    });
  }
  spawn(cx, work) {
    this.jobs = this.jobs.filter((job2) => !job2?.is_done?.());
    const job = cx.spawn(async (taskCx) => {
      let changed = true;
      try {
        changed = await work(taskCx) !== false;
      } catch {
        this.status = { kind: null, result: { ok: false, code: "REOPEN_FAILED", message: "Reopen could not complete; closed tabs were kept.", recovery: { actions: [] } }, at: Date.now() };
      }
      if (!this.closed && changed) taskCx.notify();
    });
    this.jobs.push(job);
    return job;
  }
  // Lease renewals rewrite the journal every few seconds; only record changes redraw the window.
  fingerprint() {
    const v = this.controller.value;
    return JSON.stringify([v ? v.records.map((r) => [r.id, r.claim?.until ?? 0, r.error?.code ?? null]) : null, this.controller.error?.code ?? null]);
  }
  poll(cx, { force = false } = {}) {
    if (this.closed) return;
    const now3 = Date.now();
    if (this.polling && now3 - this.polling < LIMITS.tickStaleMs) return;
    this.polling = now3;
    const before = this.fingerprint();
    return this.spawn(cx, async () => {
      if (this.role === "bar") await this.controller.tick();
      else await this.controller.refresh();
      this.polling = 0;
      return force || this.fingerprint() !== before;
    });
  }
  command(command, cx) {
    if (!COMMANDS.has(command)) return;
    const now3 = Date.now(), seen = herdr.shared(COMMAND_EVENT);
    if (seen?.command === command && seen.owner !== this.instance && now3 - seen.at >= 0 && now3 - seen.at < 750) return;
    herdr.setShared(COMMAND_EVENT, { v: 1, command, owner: this.instance, at: now3 });
    if (REOPEN_COMMANDS[command]) return this.act(REOPEN_COMMANDS[command], cx, { fromKey: true });
    if (command === "open") return this.openPopup();
    if (command === "help") return this.openHelp();
    return this.importHistory(cx);
  }
  act(kind, cx, { recordId, confirmUncertain = false, fromKey = false } = {}) {
    if (this.closed || !this.controller || this.controller.running()) return;
    this.status = { kind, recordId: recordId ?? null, pending: true, at: Date.now() };
    cx.notify();
    return this.spawn(cx, async () => {
      const result = await this.controller.run(kind, { recordId, confirmUncertain });
      if (this.closed) return false;
      this.status = { kind, recordId: recordId ?? result.recordId ?? result.recovery?.recordId ?? null, result, at: Date.now() };
      if (!result.ok && fromKey && result.code !== "REOPEN_IN_PROGRESS") herdr.notify({ title: kindLabel(kind), body: result.message, level: "warning" });
      if (result.ok && this.role === "popup" && this.props.overlay) herdr.closeOverlay(this.props.overlay);
    });
  }
  record(id) {
    return this.controller.value?.records.find((r) => r.id === id) || null;
  }
  recover(action, cx) {
    const s = this.status, r = s?.result, id = s?.recordId;
    if (!r || r.ok) return;
    if (action === "retry" || action === "retry-binding") return this.act(s.kind || "tab", cx, { recordId: id || void 0 });
    if (action === "retry-uncertain" && id) return this.act(s.kind || "tab", cx, { recordId: id, confirmUncertain: true });
    if (action === "dismiss" && id) return this.dismiss(id, cx);
    if (action === "import-history") return this.importHistory(cx);
    if (action === "locate" || action === "close-existing-and-retry") {
      const tab = r.recovery?.tabId || r.recovery?.candidates?.[0]?.tabId, rec = this.record(id);
      if (tab) herdr.run("tab.select", { id: tab });
      else if (rec) herdr.run("space.select", { id: rec.space.replacement || rec.space.id });
    }
  }
  dismiss(id, cx) {
    if (this.closed) return;
    return this.spawn(cx, async () => {
      const result = await this.controller.dismiss(id);
      if (this.closed) return false;
      this.status = result.ok ? null : { kind: null, recordId: id, result, at: Date.now() };
    });
  }
  importHistory(cx) {
    const now3 = Date.now();
    if (this.closed || !this.controller || this.importing && now3 - this.importing < IMPORT_STALE_MS) return;
    this.importing = now3;
    this.importStatus = "Importing older history…";
    cx.notify();
    return this.spawn(cx, async () => {
      const results = await this.controller.importHistory();
      this.importing = 0;
      if (this.closed) return false;
      this.importStatus = results.map((r) => r.message).join(" ") || "No machines to import from.";
    });
  }
  openPopup() {
    herdr.openOverlay({ mod: MOD, kind: "popup", width: 340, height: 440, props: { view: "popup" } });
  }
  openHelp() {
    herdr.openOverlay({ mod: MOD, kind: "dialog", width: 520, height: 460, props: { view: "help" } });
  }
  tooltip(p) {
    return [p.label + (p.title ? ": " + p.title : ""), p.detail, p.imported ? "Imported history" : null, p.reason, p.lastError ? "Last attempt: " + p.lastError : null].filter(Boolean).join("\n");
  }
  link(id, text8, action, { disabled = false } = {}) {
    const t = colors();
    let el = div2().id(id).text_size(11).text_color(disabled ? t.dim : t.accent).role("button").accessibility_label(text8).on_mouse_down("left", (_e, cx) => cx.stop_propagation());
    if (!disabled) el = el.cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click((e, cx) => {
      cx.stop_propagation();
      return action(e, cx);
    });
    return el.child(text8);
  }
  pill(id, text8, preview, action) {
    const t = colors(), enabled = preview.state === "ready" && !this.controller.running();
    let el = h_flex2().id(id).h(20).px(8).items_center().rounded(5).border(1).border_color(t.border).bg(enabled ? t.surface : "#00000000").text_color(enabled ? t.foreground : t.dim).role("button").accessibility_label(text8).tooltip(this.tooltip(preview)).on_mouse_down("left", (_e, cx) => cx.stop_propagation());
    if (enabled) el = el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(action);
    return el.child(text8);
  }
  statusLine(tab) {
    const s = this.status;
    if (s?.pending) return s.kind === "agent" ? "Reopening last agent…" : "Reopening last tab…";
    if (s?.result) return s.result.ok ? `Reopened ${s.result.title} · ${s.result.destination}` : s.result.message;
    if (this.controller.error) return this.controller.error.message;
    if (tab.state === "ready") return `Last closed: ${tab.title} · ${tab.detail}`;
    if (tab.state === "loading") return "Reading closed tabs…";
    if (tab.state === "partial") return "Older history is partial: choose a tab in More.";
    return "Nothing closed yet";
  }
  bar() {
    const t = colors(), tab = this.controller.preview("tab"), agent = this.controller.preview("agent"), failed = this.status?.result && !this.status.result.ok;
    return h_flex2().id("reopen-bar").size_full().px(8).gap(6).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11).child(icon(MOD, "sessions", 13).text_color(t.dim)).child(this.pill("reopen-tab", "Reopen tab", tab, (_e, cx) => this.act("tab", cx))).child(this.pill("reopen-agent", "Reopen agent", agent, (_e, cx) => this.act("agent", cx))).child(div2().id("reopen-status").flex_1().min_w(0).truncate().text_color(failed ? t.blocked : t.muted).child(this.statusLine(tab))).child(iconButton(MOD, "reopen-more", "more", "Closed tabs and recovery", () => this.openPopup(), { size: 22 })).child(this.link("reopen-help", "Help", () => this.openHelp()));
  }
  action(id, name2, preview, handler) {
    const t = colors(), enabled = preview.state === "ready" && !this.controller.running(), detail = ["ready", "busy"].includes(preview.state) ? [preview.title, preview.detail, preview.imported ? "imported" : null].filter(Boolean).join(" · ") : preview.reason;
    let el = h_flex2().id(id).p(8).gap(9).items_center().rounded(6).border(1).border_color(t.border).role("button").accessibility_label(preview.label).tooltip(this.tooltip(preview)).text_color(enabled ? t.foreground : t.dim);
    if (enabled) el = el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(handler);
    return el.child(icon(MOD, name2, 16).text_color(enabled ? t.accent : t.dim)).child(v_flex2().flex_1().min_w(0).gap(2).child(div2().text_size(12).child(preview.label)).child(div2().text_size(10).text_color(t.muted).truncate().child(detail || "")).when(Boolean(preview.reason) && ["ready", "unsupported"].includes(preview.state) && detail !== preview.reason, (e) => e.child(div2().text_size(10).text_color(preview.state === "ready" ? t.dim : t.blocked).child(preview.reason))));
  }
  statusBlock() {
    const t = colors(), s = this.status;
    if (s.pending) return div2().id("reopen-progress").text_size(11).text_color(t.muted).child(s.kind === "agent" ? "Reopening last agent…" : "Reopening last tab…");
    const r = s.result, notes = r.ok ? (r.notices || []).map((n) => NOTICES[n]).filter(Boolean) : [];
    return v_flex2().id("reopen-result").p(8).gap(6).rounded(6).border(1).border_color(r.ok ? t.border : t.blocked).child(h_flex2().gap(6).items_center().child(icon(MOD, r.ok ? "check" : "close", 13).text_color(r.ok ? t.done : t.blocked)).child(div2().flex_1().min_w(0).text_size(11).text_color(t.foreground).child(r.ok ? `Reopened ${r.title} · ${r.destination}` : r.message))).children(notes.map((note, i) => div2().id("reopen-notice-" + i).text_size(10).text_color(t.muted).child(note))).when(!r.ok && Boolean(r.recovery?.actions?.some((a) => RECOVERY[a])), (e) => e.child(h_flex2().gap(12).children(r.recovery.actions.filter((a) => RECOVERY[a] && (a !== "dismiss" || s.recordId)).map((a) => this.link("recover-" + a, RECOVERY[a], (_e, cx) => this.recover(a, cx))))));
  }
  row(r, now3) {
    const t = colors(), busy = r.busy || this.controller.running(), note = r.kind === "agent" && !r.exact ? "No exact session: opens a shell in its folder" : null;
    let el = h_flex2().id("recent-" + r.id).h(34).px(6).gap(8).items_center().rounded(5).role("button").accessibility_label("Reopen " + r.title).tooltip([r.title, r.destination, r.imported ? r.ordered ? "Imported history" : "Imported history · order unverified" : null, note, r.error ? "Last attempt: " + r.error : null].filter(Boolean).join("\n"));
    if (!busy) el = el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.act("tab", cx, { recordId: r.id }));
    return el.child(icon(MOD, r.kind === "agent" ? "agent" : "folder", 14).text_color(t.dim)).child(v_flex2().flex_1().min_w(0).child(div2().truncate().text_color(t.foreground).child(r.title)).child(div2().truncate().text_size(10).text_color(r.error ? t.blocked : t.dim).child([r.destination, r.imported ? r.ordered ? "imported" : "imported · order unverified" : ago(r.closedAt, now3), r.error].filter(Boolean).join(" · ")))).child(iconButton(MOD, "forget-" + r.id, "close", "Forget this closed tab", (_e, cx) => this.dismiss(r.id, cx), { size: 22, disabled: r.busy }));
  }
  popup() {
    const t = colors(), tab = this.controller.preview("tab"), agent = this.controller.preview("agent"), rows = this.controller.recent(6), now3 = Date.now();
    return v_flex2().id("reopen-popup").size_full().overflow_y_scrollbar().p(10).gap(8).bg(t.surface).text_size(12).child(h_flex2().h(24).gap(6).items_center().child(icon(MOD, "sessions", 15).text_color(t.muted)).child(label("Reopen", { size: 13 })).child(div2().flex_1()).child(this.link("popup-help", "Help", () => this.openHelp())).when(Boolean(this.props.overlay), (e) => e.child(iconButton(MOD, "popup-close", "close", "Close", () => herdr.closeOverlay(this.props.overlay), { size: 22 })))).child(this.action("popup-reopen-tab", "sessions", tab, (_e, cx) => this.act("tab", cx))).child(this.action("popup-reopen-agent", "agent", agent, (_e, cx) => this.act("agent", cx))).when(Boolean(this.status), (e) => e.child(this.statusBlock())).when(Boolean(this.controller.error), (e) => e.child(div2().id("reopen-error").text_size(11).text_color(t.blocked).child(this.controller.error.message))).child(label("Recently closed", { muted: true, size: 10 })).child(rows.length ? v_flex2().id("reopen-recent").flex_none().gap(2).children(rows.map((r) => this.row(r, now3))) : v_flex2().id("reopen-empty").flex_none().p(12).gap(6).items_center().child(label("Nothing to reopen yet")).child(div2().text_size(11).text_color(t.muted).child("Tabs you close while this bar or the Mission Control tab bar runs appear here. Import older history to look further back."))).child(h_flex2().gap(8).items_center().child(this.link("reopen-import", this.importing ? "Importing…" : "Import older history", (_e, cx) => this.importHistory(cx), { disabled: Boolean(this.importing) })).child(div2().flex_1().min_w(0).truncate().text_size(10).text_color(t.dim).child(this.importStatus || "")));
  }
  help() {
    const t = colors();
    return v_flex2().id("reopen-help-view").size_full().p(18).gap(10).bg(t.surface).text_size(12).child(h_flex2().gap(8).items_center().child(icon(MOD, "sessions", 16).text_color(t.muted)).child(label("Reopen: what comes back", { size: 14 })).child(div2().flex_1()).when(Boolean(this.props.overlay), (e) => e.child(iconButton(MOD, "help-close", "close", "Close", () => herdr.closeOverlay(this.props.overlay))))).child(v_flex2().id("reopen-limitations").flex_1().min_h(0).overflow_y_scrollbar().gap(8).children(REOPEN_LIMITATIONS.map((line2, i) => h_flex2().id("limitation-" + i).gap(8).items_start().child(div2().mt(6).size(4).rounded_full().flex_none().bg(t.dim)).child(div2().flex_1().min_w(0).text_color(t.muted).child(line2)))));
  }
  render() {
    if (this.role === "help") return this.help();
    return this.role === "popup" ? this.popup() : this.bar();
  }
  close() {
    this.closed = true;
    for (const timer of this.timers) timer?.cancel?.();
    for (const job of this.jobs) job?.cancel?.();
    this.commandTask?.cancel?.();
    if (this.role === "bar" && this.controller) return this.controller.release().catch(() => {
    });
  }
};
export {
  MissionControlReopen as default
};
