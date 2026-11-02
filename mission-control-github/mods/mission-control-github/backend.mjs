import { createRequire as __mcCreateRequire } from "node:module"; const require = __mcCreateRequire(import.meta.url);

// src/mods/mission-control-github/backend.mjs
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { createHash as createHash3 } from "node:crypto";

// src/shared/tracker-transport.mjs
import https from "node:https";

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
  for (const [key, item] of Object.entries(value)) {
    if (forbiddenKeys.has(key)) fail("Configuration contains a reserved object key.");
    const compact = key.toLowerCase().replaceAll("_", "").replaceAll("-", "");
    if (!envMap && secretFields.has(compact)) fail("Store a credential environment reference, not a credential value.");
    if ((key.endsWith("Env") || envMap) && (typeof item !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(item))) fail("Credential environment references must be environment variable names.");
    validateJson(item, depth + 1, key === "envRefs");
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
  if (!Object.hasOwn(value, "connectionId") || !Object.hasOwn(value, "projectPath") || Object.keys(value).some((key) => !["connectionId", "projectPath", "status"].includes(key))) fail("A GitLab binding needs its connection and project path.");
  gitlabProjectPath(value.projectPath);
  if (value.status === void 0) return;
  const status = value.status, groups = ["todo", "inProgress", "done"];
  if (!object(status) || Object.keys(status).length !== 1 || !Object.hasOwn(status, "labels") || !object(status.labels) || Object.keys(status.labels).length !== groups.length || groups.some((group) => !Object.hasOwn(status.labels, group))) fail("GitLab workflow mapping needs To do, In progress and Done label groups.");
  const used = /* @__PURE__ */ new Set();
  for (const group of groups) {
    const labels = status.labels[group];
    if (!Array.isArray(labels) || labels.length > 100) fail("GitLab workflow label groups must be bounded lists.");
    for (const label of labels) {
      if (typeof label !== "string" || !label.trim() || label.length > 200 || /[\u0000-\u001f\u007f]/.test(label) || used.has(label.toLowerCase())) fail("GitLab workflow labels must be valid and disjoint, ignoring case.");
      used.add(label.toLowerCase());
    }
  }
}
function validateBinding(binding, key, connections) {
  if (!object(binding)) fail("Repository bindings must be objects.");
  if (bindingKey(binding.machine, binding.repoRoot) !== key) fail("A repository binding does not match its machine/root key.");
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
  for (const [id5, connection] of Object.entries(normalized.connections)) {
    if (!/^[a-z][a-z0-9-]{0,95}$/.test(id5) || !object(connection) || connection.id !== id5 || typeof connection.kind !== "string") fail("Connections require a matching stable id and adapter kind.");
    if (connection.site !== void 0 && (typeof connection.site !== "string" || !/^https:\/\/[^\s/@?#]+\/?$/.test(connection.site))) fail("A tracker site must be an HTTPS origin without credentials or query parameters.");
  }
  for (const [key, binding] of Object.entries(normalized.bindings)) validateBinding(binding, key, normalized.connections);
  if (JSON.stringify(normalized).length > MAX_CONFIG_CHARACTERS) fail("Configuration exceeds the supported file size.");
  return normalized;
}

// src/shared/tracker-transport.mjs
var messages = {
  INVALID_REQUEST: "The tracker request is invalid. Reload its repository settings.",
  INVALID_CONNECTION: "The integration profile is invalid. Check its adapter and credential references.",
  INVALID_SCOPE: "The tracker result or cursor belongs to a different repository or connection. Reload this scope.",
  CANONICAL_SITE_REQUIRED: "Use the canonical Jira API base URL from serverInfo.baseUrl, rather than a custom display URL. Check the selected site and cloud ID.",
  INCOMPLETE_RESULTS: "The tracker could not confirm a complete result set. Narrow the selected scope and refresh.",
  STATUS_MAPPING_REQUIRED: "Configure the source status mapping before using this board.",
  CLI_UNAVAILABLE: "The configured tracker CLI is not installed locally. Select an installed command or another adapter.",
  ADAPTER_FAILED: "The configured tracker program failed. Check its profile and read-only JSON bridge.",
  MCP_UNAVAILABLE: "The selected MCP server is unavailable. Check its transport and credential references, then reconnect.",
  MCP_TOOL_UNAVAILABLE: "The configured MCP search tool is missing or changed. Reconnect and select its current tool mapping.",
  MCP_TOOL_NOT_READ_ONLY: "Select a read-only MCP issue-search tool before loading this board.",
  ACCOUNT_SELECTION_UNSUPPORTED: "The installed CLI cannot select this account explicitly. Use a credential environment reference or a supported CLI version.",
  INVALID_URL: "Use an explicit HTTPS URL without embedded credentials or fragments.",
  UNSUPPORTED_INTEGRATION_HOST: "CLI and stdio MCP integrations must run locally. Use a local bridge or configured HTTPS MCP endpoint for a server.",
  AUTH_REQUIRED: "Tracker authentication is unavailable. Check the selected profile and its credential environment references.",
  PERMISSION_DENIED: "The selected account cannot read this tracker resource.",
  NOT_FOUND: "The selected tracker resource was not found.",
  RATE_LIMITED: "The tracker rate limit was reached. Retry after the reported delay.",
  UPSTREAM_UNAVAILABLE: "The tracker is temporarily unavailable. Retry this connection.",
  HTTP_ERROR: "The tracker rejected the read request. Check its connection settings.",
  UNTRUSTED_ORIGIN: "The tracker response tried to leave the configured HTTPS origin. Check the endpoint.",
  REQUEST_FAILED: "The tracker could not be reached. Check its HTTPS endpoint and retry.",
  REQUEST_TIMEOUT: "The tracker read timed out. Retry this connection.",
  REQUEST_CANCELLED: "This tracker read was cancelled.",
  RESPONSE_TOO_LARGE: "The tracker response exceeds the bounded page size. Narrow its project or query.",
  INVALID_RESPONSE: "The tracker did not return valid UTF-8 JSON."
};
var object2 = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
var text = (v, max = 8192) => typeof v === "string" && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
var exact = (value, required, optional = []) => object2(value) && required.every((k) => Object.hasOwn(value, k)) && Object.keys(value).every((k) => required.includes(k) || optional.includes(k));
var id = (v) => text(v, 96) && /^[a-z][a-z0-9-]*$/.test(v) && !["constructor", "prototype"].includes(v);
var envName = (v) => typeof v === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(v);
var strings = (v, max = 96) => Array.isArray(v) && v.length <= max && v.every((s) => typeof s === "string" && s.length <= 8192 && !s.includes("\0"));
var clone = (v) => JSON.parse(JSON.stringify(v));
var TrackerError = class extends Error {
  constructor(code, details = {}) {
    const safe = Object.hasOwn(messages, code) ? code : "REQUEST_FAILED";
    super(messages[safe]);
    this.name = "TrackerError";
    this.code = safe;
    if (Number.isInteger(details.status) && details.status >= 100 && details.status <= 599) this.status = details.status;
    if (Number.isFinite(details.retryAfterMs) && details.retryAfterMs >= 0) this.retryAfterMs = Math.min(details.retryAfterMs, 864e5);
  }
};
var fail2 = (code) => {
  throw new TrackerError(code);
};
function publicTrackerError(error) {
  const e = error instanceof TrackerError ? error : new TrackerError("REQUEST_FAILED");
  return { code: e.code, message: messages[e.code] || messages.REQUEST_FAILED, ...e.status !== void 0 ? { status: e.status } : {}, ...e.retryAfterMs !== void 0 ? { retryAfterMs: e.retryAfterMs } : {} };
}
function jsonData(value, code) {
  try {
    validateConfig({ v: 1, preferences: { tracker: value } });
  } catch {
    fail2(code);
  }
}
function httpsUrl(value, { originOnly = false } = {}) {
  if (!text(value, 8192)) fail2("INVALID_URL");
  let url;
  try {
    url = new URL(value);
  } catch {
    fail2("INVALID_URL");
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash || originOnly && (url.pathname !== "/" || url.search)) fail2("INVALID_URL");
  return url;
}
var origin = (value) => httpsUrl(value, { originOnly: true }).origin;
function auth(value, { optional = false, basic = true } = {}) {
  if (value === void 0 && optional) return;
  if (!object2(value) || !["bearer", ...basic ? ["basic"] : []].includes(value.kind) || !exact(value, value.kind === "basic" ? ["kind", "usernameEnv", "tokenEnv"] : ["kind", "tokenEnv"]) || !envName(value.tokenEnv) || value.kind === "basic" && !envName(value.usernameEnv)) fail2("INVALID_CONNECTION");
}
function execution(value, { stdio = false } = {}) {
  if (!exact(value, ["machine", "command", stdio ? "args" : "argsTemplate"], stdio ? ["envRefs"] : []) || value.machine !== null) {
    if (value?.machine !== void 0 && value.machine !== null) fail2("UNSUPPORTED_INTEGRATION_HOST");
    fail2("INVALID_CONNECTION");
  }
  if (!text(value.command, 4096) || !strings(value[stdio ? "args" : "argsTemplate"])) fail2("INVALID_CONNECTION");
  if (stdio && (!object2(value.envRefs) || Object.entries(value.envRefs).some(([key, ref]) => !envName(key) || !envName(ref)))) fail2("INVALID_CONNECTION");
}
function mapping(value) {
  if (!exact(value, ["issuesPath", "fields", "statusGroups"], ["nextCursorPath"]) || typeof value.issuesPath !== "string" || value.issuesPath.length > 512 || value.nextCursorPath !== void 0 && (typeof value.nextCursorPath !== "string" || value.nextCursorPath.length > 512) || !object2(value.fields) || !Object.keys(value.fields).length || Object.values(value.fields).some((v) => typeof v !== "string" || v.length > 512) || !exact(value.statusGroups, ["todo", "inProgress", "done"]) || Object.values(value.statusGroups).some((v) => !strings(v, 100))) fail2("INVALID_CONNECTION");
}
function search(value) {
  if (!exact(value, ["tool", "argsTemplate", "resultMapping"]) || !text(value.tool, 128) || !object2(value.argsTemplate)) fail2("INVALID_CONNECTION");
  mapping(value.resultMapping);
}
function validateJiraConnection(input) {
  jsonData(input, "INVALID_CONNECTION");
  if (!id(input?.id)) fail2("INVALID_CONNECTION");
  const c = clone(input);
  c.site = origin(c.site);
  switch (c.kind) {
    case "api":
      if (!exact(c, ["id", "kind", "site", "auth"], ["cloudId"]) || c.cloudId !== void 0 && !(typeof c.cloudId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(c.cloudId))) fail2("INVALID_CONNECTION");
      auth(c.auth);
      break;
    case "cli":
      if (!exact(c, ["id", "kind", "site", "execution", "mapping"])) fail2("INVALID_CONNECTION");
      execution(c.execution);
      mapping(c.mapping);
      break;
    case "mcp-stdio":
      if (!exact(c, ["id", "kind", "site", "execution", "search"])) fail2("INVALID_CONNECTION");
      execution(c.execution, { stdio: true });
      search(c.search);
      break;
    case "mcp-http": {
      if (!exact(c, ["id", "kind", "site", "url", "search"], ["auth"])) fail2("INVALID_CONNECTION");
      const endpoint = httpsUrl(c.url);
      if ([...endpoint.searchParams.keys()].some((key) => /^(?:access[-_]?token|api[-_]?(?:key|token)|token|auth|authorization|password|secret|x-api-key)$/i.test(key))) fail2("INVALID_CONNECTION");
      c.url = endpoint.href;
      auth(c.auth, { optional: true });
      search(c.search);
      break;
    }
    default:
      fail2("INVALID_CONNECTION");
  }
  return c;
}
function validateTrackerRequest(input, { connectionValidator = validateJiraConnection, source = "jira" } = {}) {
  const operations = { jira: ["issues", "probe"], github: ["issues", "pulls", "probe"], gitlab: ["issues", "merges", "probe"] };
  jsonData(input, "INVALID_REQUEST");
  if (!exact(input, ["v", "operation", "connection", "binding"], ["cursor"]) || input.v !== 1 || !Object.hasOwn(operations, source) || !operations[source].includes(input.operation) || Buffer.byteLength(JSON.stringify(input)) > 65536 || input.cursor !== void 0 && input.cursor !== null && !text(input.cursor, 8192)) fail2("INVALID_REQUEST");
  const connection = connectionValidator(input.connection), binding = clone(input.binding);
  if (!object2(binding) || !Object.hasOwn(binding, "machine") || !(binding.machine === null || text(binding.machine, 128))) fail2("INVALID_REQUEST");
  try {
    if (canonicalRepoPath(binding.repoRoot) !== binding.repoRoot) fail2("INVALID_REQUEST");
  } catch {
    fail2("INVALID_REQUEST");
  }
  const selected = binding[source];
  if (selected !== void 0 && (selected?.connectionId !== connection.id || source === "jira" && (!text(selected.project, 256) && !text(selected.jql, 8192)) || source === "github" && (!text(selected.owner, 128) || !text(selected.repo, 128)))) fail2("INVALID_REQUEST");
  if (source === "gitlab" && selected !== void 0) {
    try {
      gitlabProjectPath(selected.projectPath);
    } catch {
      fail2("INVALID_REQUEST");
    }
  }
  if (input.operation !== "probe" && !selected) fail2("INVALID_REQUEST");
  return { ...clone(input), connection, binding };
}
function retryAfter(value, now) {
  if (typeof value !== "string") return void 0;
  const seconds = /^\d+$/.test(value) ? Number(value) : NaN, date2 = Number.isFinite(seconds) ? now + seconds * 1e3 : Date.parse(value);
  return Number.isFinite(date2) ? Math.min(864e5, Math.max(0, date2 - now)) : void 0;
}
function httpError(status, headers) {
  const limited2 = status === 429 || status === 403 && headers["x-ratelimit-remaining"] === "0", now = Date.now(), retry = retryAfter(headers["retry-after"], now), reset = limited2 && /^\d+$/.test(headers["x-ratelimit-reset"] || "") ? Math.min(864e5, Math.max(0, Number(headers["x-ratelimit-reset"]) * 1e3 - now)) : void 0;
  return new TrackerError(limited2 ? "RATE_LIMITED" : status === 401 ? "AUTH_REQUIRED" : status === 403 ? "PERMISSION_DENIED" : status === 404 ? "NOT_FOUND" : status >= 500 ? "UPSTREAM_UNAVAILABLE" : "HTTP_ERROR", { status, retryAfterMs: retry ?? reset });
}
async function requestJson(input, { allowedOrigin, headers = {}, method = "GET", body, timeoutMs = 12e3, maxBytes = 1048576, ca, signal, metadata = false, maxRedirects = 3 } = {}) {
  const expected = origin(allowedOrigin);
  let url = httpsUrl(input);
  if (!object2(headers) || !["GET", "POST"].includes(method) || method === "GET" && body !== void 0 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3e4 || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 4194304 || typeof metadata !== "boolean" || !Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 3) fail2("INVALID_REQUEST");
  const requestHeaders = { accept: "application/json", "accept-encoding": "identity", "user-agent": "herdr-mission-control/0.1" };
  for (const [key, value] of Object.entries(headers)) {
    const name3 = key.toLowerCase();
    if (!["authorization", "accept", "content-type", "x-github-api-version", "user-agent"].includes(name3) || !text(value, 32768)) fail2("INVALID_REQUEST");
    requestHeaders[name3] = value;
  }
  let payload;
  if (body !== void 0) {
    try {
      payload = Buffer.from(JSON.stringify(body), "utf8");
    } catch {
      fail2("INVALID_REQUEST");
    }
    if (payload.length > 65536) fail2("INVALID_REQUEST");
    requestHeaders["content-type"] = "application/json";
    requestHeaders["content-length"] = String(payload.length);
  }
  const deadline = Date.now() + timeoutMs;
  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    if (url.origin !== expected) fail2("UNTRUSTED_ORIGIN");
    if (signal?.aborted) fail2("REQUEST_CANCELLED");
    const remaining = deadline - Date.now();
    if (remaining <= 0) fail2("REQUEST_TIMEOUT");
    const result = await new Promise((resolve, reject) => {
      let settled = false, request;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        error ? reject(error) : resolve(value);
      };
      const cancel = () => {
        finish(new TrackerError("REQUEST_CANCELLED"));
        request?.destroy();
      };
      const timer = setTimeout(() => {
        finish(new TrackerError("REQUEST_TIMEOUT"));
        request?.destroy();
      }, remaining);
      try {
        request = https.request(url, { method, headers: requestHeaders, ca, rejectUnauthorized: true }, (response) => {
          const status = response.statusCode || 0;
          if ([301, 302, 303, 307, 308].includes(status)) {
            const location = response.headers.location;
            response.destroy();
            finish(null, { redirect: location, status });
            return;
          }
          if (status < 200 || status >= 300) {
            const error = httpError(status, response.headers);
            response.destroy();
            finish(error);
            return;
          }
          if (Number(response.headers["content-length"]) > maxBytes) {
            response.destroy();
            finish(new TrackerError("RESPONSE_TOO_LARGE"));
            return;
          }
          const responseHeaders = {};
          if (metadata) for (const name3 of ["link", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset", "x-ratelimit-resource", "x-next-page"]) {
            const value = response.headers[name3];
            if (value !== void 0) {
              if (!(name3 === "x-next-page" && value === "") && !text(value, name3 === "link" ? 8192 : 128)) {
                response.destroy();
                finish(new TrackerError("RESPONSE_TOO_LARGE"));
                return;
              }
              responseHeaders[name3] = value;
            }
          }
          let length = 0;
          const chunks = [];
          response.on("data", (chunk) => {
            if (settled) return;
            length += chunk.length;
            if (length > maxBytes) {
              response.destroy();
              finish(new TrackerError("RESPONSE_TOO_LARGE"));
            } else chunks.push(chunk);
          });
          response.on("error", () => finish(new TrackerError("REQUEST_FAILED")));
          response.on("end", () => {
            if (settled) return;
            try {
              const data = status === 204 ? null : JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
              finish(null, { value: metadata ? { data, status, headers: responseHeaders, url: url.href } : data });
            } catch {
              finish(new TrackerError("INVALID_RESPONSE"));
            }
          });
        });
        request.on("error", () => finish(new TrackerError("REQUEST_FAILED")));
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) {
          cancel();
          return;
        }
        request.end(payload);
      } catch {
        finish(new TrackerError("REQUEST_FAILED"));
      }
    });
    if (!Object.hasOwn(result, "redirect")) return result.value;
    if (redirects === maxRedirects || typeof result.redirect !== "string" || method === "POST" && ![307, 308].includes(result.status)) fail2("UNTRUSTED_ORIGIN");
    try {
      url = httpsUrl(new URL(result.redirect, url).href);
    } catch {
      fail2("UNTRUSTED_ORIGIN");
    }
  }
  fail2("UNTRUSTED_ORIGIN");
}

// src/shared/tracker-model.js
var TRACKER_GROUPS = ["todo", "inProgress", "done"];
var messages2 = { INVALID_FILTER: "Choose an available board status filter.", INVALID_SCOPE: "Select a configured repository and tracker connection.", INVALID_BINDING: "The repository tracker binding is invalid.", INVALID_ISSUE: "The tracker returned an invalid issue; reload its source mapping.", INVALID_SNAPSHOT: "The tracker response does not match the requested scope.", STATUS_MAPPING_REQUIRED: "Choose an unambiguous source status mapping.", UNSUPPORTED_INTEGRATION_HOST: "CLI and stdio MCP integrations must run locally. Configure a local bridge or HTTPS MCP endpoint.", CONNECTION_CONFLICT: "This connection is already used elsewhere. Choose a new profile ID before changing it here." };
var TrackerModelError = class extends Error {
  constructor(code) {
    super(messages2[code] || messages2.INVALID_SNAPSHOT);
    this.code = Object.hasOwn(messages2, code) ? code : "INVALID_SNAPSHOT";
  }
};
var fail3 = (code) => {
  throw new TrackerModelError(code);
};
var object3 = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
var exact2 = (v, required, optional = []) => object3(v) && required.every((k) => Object.hasOwn(v, k)) && Object.keys(v).every((k) => required.includes(k) || optional.includes(k));
var text2 = (v, max = 512) => typeof v === "string" && v.trim().length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
var id2 = (v) => text2(v, 96) && /^[a-z][a-z0-9-]*$/.test(v) && !["constructor", "prototype"].includes(v);
var machine2 = (v) => v === null || text2(v, 128);
var date = (v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 864e13;
var clone2 = (v) => JSON.parse(JSON.stringify(v));
var trackerSources = ["jira", "github", "github-pr", "gitlab", "gitlab-mr"];
function sourceKind(source) {
  if (!trackerSources.includes(source)) fail3("INVALID_SCOPE");
  return source === "github-pr" ? "github" : source === "gitlab-mr" ? "gitlab" : source;
}
var utf8Bytes = (value) => {
  let n = 0;
  for (const c of value) {
    const code = c.codePointAt(0);
    n += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4;
  }
  return n;
};
function json(value, code = "INVALID_SCOPE") {
  try {
    validateConfig({ v: 1, preferences: { tracker: value } });
  } catch {
    fail3(code);
  }
}
function stable(value) {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (object3(value)) return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + stable(value[k])).join(",") + "}";
  return JSON.stringify(value);
}
function trackerOrigin(value) {
  if (!text2(value, 2048)) fail3("INVALID_SCOPE");
  const match = value.match(/^https:\/\/(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)(?::([0-9]{1,5}))?\/?$/);
  if (!match || match[2] && (Number(match[2]) < 1 || Number(match[2]) > 65535)) fail3("INVALID_SCOPE");
  const host = match[1].toLowerCase();
  if (!host.startsWith("[") && host.split(".").some((part) => part.length > 63 || !part || part.startsWith("-") || part.endsWith("-"))) fail3("INVALID_SCOPE");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) && host.split(".").some((n) => Number(n) > 255)) fail3("INVALID_SCOPE");
  return "https://" + host + (match[2] && Number(match[2]) !== 443 ? ":" + Number(match[2]) : "");
}
function repoName(value) {
  return text2(value, 128) && /^[A-Za-z0-9_.-]+$/.test(value) && ![".", ".."].includes(value);
}
function list(value, { caseFold = false } = {}) {
  if (!Array.isArray(value) || value.length > 100 || value.some((v) => !text2(v, 200))) fail3("STATUS_MAPPING_REQUIRED");
  const keys = value.map((v) => caseFold ? v.toLowerCase() : v);
  if (new Set(keys).size !== keys.length) fail3("STATUS_MAPPING_REQUIRED");
  return [...value];
}
function validateStatusMapping(value) {
  if (value === void 0) return void 0;
  if (!object3(value) || Object.keys(value).length !== 1) fail3("STATUS_MAPPING_REQUIRED");
  let groups, result, caseFold = false;
  if (Object.hasOwn(value, "labels")) {
    if (!exact2(value.labels, TRACKER_GROUPS)) fail3("STATUS_MAPPING_REQUIRED");
    caseFold = true;
    groups = Object.fromEntries(TRACKER_GROUPS.map((k) => [k, list(value.labels[k], { caseFold })]));
    result = { labels: groups };
  } else if (Object.hasOwn(value, "project")) {
    const p = value.project;
    if (!exact2(p, ["owner", "number", "fieldId", "options", "unmapped"]) || !repoName(p.owner) || !Number.isSafeInteger(p.number) || p.number < 1 || !text2(p.fieldId, 200) || p.unmapped !== "error" || !exact2(p.options, TRACKER_GROUPS)) fail3("STATUS_MAPPING_REQUIRED");
    groups = Object.fromEntries(TRACKER_GROUPS.map((k) => [k, list(p.options[k])]));
    result = { project: { ...clone2(p), options: groups } };
  } else fail3("STATUS_MAPPING_REQUIRED");
  const used = /* @__PURE__ */ new Set();
  for (const values of Object.values(groups)) for (const value2 of values) {
    const key = caseFold ? value2.toLowerCase() : value2;
    if (used.has(key)) fail3("STATUS_MAPPING_REQUIRED");
    used.add(key);
  }
  return result;
}
function selection(value, source) {
  if (!object3(value) || !id2(value.connectionId)) fail3("INVALID_BINDING");
  if (source === "jira") {
    if (!exact2(value, ["connectionId"], ["project", "jql"]) || !value.project && !value.jql || value.project !== void 0 && !text2(value.project, 256) || value.jql !== void 0 && !text2(value.jql, 8192)) fail3("INVALID_BINDING");
    return { connectionId: value.connectionId, ...value.project !== void 0 ? { project: value.project.trim() } : {}, ...value.jql !== void 0 ? { jql: value.jql.trim() } : {} };
  }
  if (source === "gitlab") {
    if (!exact2(value, ["connectionId", "projectPath"], ["status"])) fail3("INVALID_BINDING");
    let projectPath;
    try {
      projectPath = gitlabProjectPath(value.projectPath);
    } catch {
      fail3("INVALID_BINDING");
    }
    const status = validateStatusMapping(value.status);
    if (status && !Object.hasOwn(status, "labels")) fail3("STATUS_MAPPING_REQUIRED");
    return { connectionId: value.connectionId, projectPath, ...status ? { status } : {} };
  }
  if (!exact2(value, ["connectionId", "owner", "repo"], ["status"]) || !repoName(value.owner) || !repoName(value.repo)) fail3("INVALID_BINDING");
  return { connectionId: value.connectionId, owner: value.owner, repo: value.repo, ...value.status !== void 0 ? { status: validateStatusMapping(value.status) } : {} };
}
function validateRepoBinding(value) {
  if (!exact2(value, ["machine", "repoRoot"], ["jira", "github", "gitlab", "mountedLocalPath"]) || !machine2(value.machine)) fail3("INVALID_BINDING");
  try {
    if (canonicalRepoPath(value.repoRoot) !== value.repoRoot || value.mountedLocalPath !== void 0 && canonicalRepoPath(value.mountedLocalPath) !== value.mountedLocalPath) fail3("INVALID_BINDING");
  } catch {
    fail3("INVALID_BINDING");
  }
  return { machine: value.machine, repoRoot: value.repoRoot, ...value.jira !== void 0 ? { jira: selection(value.jira, "jira") } : {}, ...value.github !== void 0 ? { github: selection(value.github, "github") } : {}, ...value.gitlab !== void 0 ? { gitlab: selection(value.gitlab, "gitlab") } : {}, ...value.mountedLocalPath !== void 0 ? { mountedLocalPath: value.mountedLocalPath } : {} };
}
function connectionHeader(value, source) {
  json(value);
  if (!object3(value) || !id2(value.id) || !text2(value.kind, 80)) fail3("INVALID_SCOPE");
  const site = trackerOrigin(value.site);
  if (source === "jira" && !["api", "cli", "mcp-stdio", "mcp-http"].includes(value.kind)) fail3("INVALID_SCOPE");
  if (["cli", "mcp-stdio"].includes(value.kind) && value.execution?.machine !== null) fail3("UNSUPPORTED_INTEGRATION_HOST");
  return { ...clone2(value), site };
}
function trackerScope(source, connection, binding) {
  const kind = sourceKind(source), b = validateRepoBinding(binding), selected = b[kind], c = connectionHeader(connection, kind);
  if (!selected || selected.connectionId !== c.id) fail3("INVALID_SCOPE");
  const fingerprint = stable(c);
  if (fingerprint.length > 32e3) fail3("INVALID_SCOPE");
  return { v: 1, source, machine: b.machine, repoRoot: b.repoRoot, connectionId: c.id, site: c.site, selection: clone2(selected), fingerprint };
}
function validateTrackerScope(value) {
  if (!exact2(value, ["v", "source", "machine", "repoRoot", "connectionId", "site", "selection", "fingerprint"]) || value.v !== 1 || !trackerSources.includes(value.source) || !machine2(value.machine) || !id2(value.connectionId) || !text2(value.fingerprint, 32e3)) fail3("INVALID_SCOPE");
  try {
    if (canonicalRepoPath(value.repoRoot) !== value.repoRoot || trackerOrigin(value.site) !== value.site) fail3("INVALID_SCOPE");
  } catch {
    fail3("INVALID_SCOPE");
  }
  const selected = selection(value.selection, sourceKind(value.source));
  if (selected.connectionId !== value.connectionId || stable(selected) !== stable(value.selection)) fail3("INVALID_SCOPE");
  return clone2(value);
}
var trackerScopeKey = (scope) => stable(validateTrackerScope(scope));
function validateIssue(value, { scope } = {}) {
  if (!exact2(value, ["identity", "key", "title", "url", "body", "statusGroup", "statusName", "repoBinding"], ["priority", "updatedAt"])) fail3("INVALID_ISSUE");
  const i = value.identity;
  if (!exact2(i, ["kind", "connectionId", "site", "id"]) || !["jira", "github", "gitlab"].includes(i.kind) || !id2(i.connectionId) || !text2(i.id, 200) || !text2(value.key, 200) || !text2(value.title, 512) || !text2(value.statusName, 200) || !TRACKER_GROUPS.includes(value.statusGroup) || typeof value.body !== "string" || utf8Bytes(value.body) > 64e3 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.body) || value.priority !== void 0 && !text2(value.priority, 128)) fail3("INVALID_ISSUE");
  let binding, site;
  try {
    binding = validateRepoBinding(value.repoBinding);
    site = trackerOrigin(i.site);
  } catch {
    fail3("INVALID_ISSUE");
  }
  if (site !== i.site || binding[i.kind]?.connectionId !== i.connectionId || !text2(value.url, 4096)) fail3("INVALID_ISSUE");
  if (i.kind === "jira") {
    if (!/^[A-Za-z][A-Za-z0-9_]*-[1-9][0-9]*$/.test(value.key) || value.url !== site + "/browse/" + value.key) fail3("INVALID_ISSUE");
  } else if (i.kind === "gitlab") {
    const number2 = value.key.match(/^GL-([1-9][0-9]*)$/);
    if (!/^[1-9][0-9]*$/.test(i.id) || !number2 || value.url !== site + "/" + binding.gitlab.projectPath + "/-/issues/" + number2[1]) fail3("INVALID_ISSUE");
  } else {
    const prefix = site + "/" + binding.github.owner + "/" + binding.github.repo + "/issues/", parts = value.url.match(/^(https:\/\/[^/]+\/[^/]+\/[^/]+\/issues\/)([1-9][0-9]*)$/);
    if (!parts || parts[1].toLowerCase() !== prefix.toLowerCase()) fail3("INVALID_ISSUE");
  }
  if (value.updatedAt !== void 0 && !date(value.updatedAt)) fail3("INVALID_ISSUE");
  if (scope) {
    const s = validateTrackerScope(scope);
    if (s.source !== i.kind || s.connectionId !== i.connectionId || s.site !== site || s.machine !== binding.machine || s.repoRoot !== binding.repoRoot || stable(s.selection) !== stable(binding[i.kind])) fail3("INVALID_SNAPSHOT");
  }
  return { ...clone2(value), repoBinding: binding };
}
function issueIdentityKey(issue) {
  const i = issue.identity, b = issue.repoBinding;
  return stable([i.kind, i.connectionId, i.site, i.id, b.machine, b.repoRoot]);
}
function mappedStatus(value, groups) {
  if (!text2(value, 200) || !exact2(groups, TRACKER_GROUPS)) fail3("STATUS_MAPPING_REQUIRED");
  const all = TRACKER_GROUPS.flatMap((group) => list(groups[group]));
  if (new Set(all).size !== all.length) fail3("STATUS_MAPPING_REQUIRED");
  const matches = TRACKER_GROUPS.filter((group) => groups[group].includes(value));
  if (matches.length !== 1) fail3("STATUS_MAPPING_REQUIRED");
  return matches[0];
}
function validateSnapshot(value, expectedScope, { validateItem = validateIssue, itemKey = issueIdentityKey, now = Date.now() } = {}) {
  const scope = validateTrackerScope(expectedScope);
  if (!exact2(value, ["data", "fetchedAt", "scope", "truncated"], ["cursor", "error"]) || !Array.isArray(value.data) || value.data.length > 1e3 || !date(value.fetchedAt) || value.fetchedAt < 0 || value.fetchedAt > now + 5e3 || typeof value.truncated !== "boolean" || value.cursor !== void 0 && value.cursor !== null && !text2(value.cursor, 8192) || trackerScopeKey(value.scope) !== trackerScopeKey(scope)) fail3("INVALID_SNAPSHOT");
  if (value.cursor && !value.truncated) fail3("INVALID_SNAPSHOT");
  if (value.error !== void 0 && (!exact2(value.error, ["code", "message"], ["retryAt"]) || !text2(value.error.code, 80) || !text2(value.error.message, 512) || value.error.retryAt !== void 0 && (!date(value.error.retryAt) || value.error.retryAt < 0))) fail3("INVALID_SNAPSHOT");
  const seen = /* @__PURE__ */ new Set(), data = value.data.map((item) => {
    const checked2 = validateItem(item, { scope }), key = itemKey(checked2);
    if (seen.has(key)) fail3("INVALID_SNAPSHOT");
    seen.add(key);
    return checked2;
  });
  const result = { ...clone2(value), data, scope };
  if (utf8Bytes(JSON.stringify(result)) > 8 * 1024 * 1024) fail3("INVALID_SNAPSHOT");
  return result;
}

// src/mods/mission-control-github/auth.mjs
import { spawn } from "node:child_process";
var object4 = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
var exact3 = (value, required, optional = []) => object4(value) && required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
var envName2 = (value) => typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value);
var fail4 = (code) => {
  throw new TrackerError(code);
};
var credential = (value) => {
  if (typeof value !== "string" || !value.length || value.length > 16384 || /[^\x21-\x7e]/.test(value)) fail4("AUTH_REQUIRED");
  return value;
};
function githubEndpoints(site) {
  const url = httpsUrl(site, { originOnly: true }), canonical = url.origin;
  if (url.hostname === "github.com") {
    if (url.port) fail4("INVALID_CONNECTION");
    return { site: canonical, apiBase: "https://api.github.com", graphqlUrl: "https://api.github.com/graphql", host: url.host };
  }
  const cloud = url.hostname.match(/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.ghe\.com$/);
  if (cloud) {
    if (url.port) fail4("INVALID_CONNECTION");
    const api = "https://api." + url.hostname;
    return { site: canonical, apiBase: api, graphqlUrl: api + "/graphql", host: url.host };
  }
  if (url.hostname === "ghe.com" || url.hostname.endsWith(".ghe.com") || url.hostname.endsWith(".github.com")) fail4("INVALID_CONNECTION");
  return { site: canonical, apiBase: canonical + "/api/v3", graphqlUrl: canonical + "/api/graphql", host: url.host };
}
function validateGithubConnection(input) {
  try {
    validateConfig({ v: 1, preferences: { githubConnection: input } });
  } catch {
    fail4("INVALID_CONNECTION");
  }
  if (!exact3(input, ["id", "kind", "site", "apiBase"], ["credentialEnv", "gh"]) || input.kind !== "github" || typeof input.id !== "string" || !/^[a-z][a-z0-9-]{0,95}$/.test(input.id) || ["constructor", "prototype"].includes(input.id)) fail4("INVALID_CONNECTION");
  const endpoints = githubEndpoints(input.site), api = httpsUrl(input.apiBase);
  if (api.search || api.href.replace(/\/$/, "") !== endpoints.apiBase) fail4("INVALID_CONNECTION");
  const hasEnv = Object.hasOwn(input, "credentialEnv"), hasGh = Object.hasOwn(input, "gh");
  if (hasEnv === hasGh || hasEnv && !envName2(input.credentialEnv)) fail4("INVALID_CONNECTION");
  if (hasGh && (!exact3(input.gh, ["host", "account"]) || typeof input.gh.host !== "string" || input.gh.host.toLowerCase() !== endpoints.host || typeof input.gh.account !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(input.gh.account))) fail4("INVALID_CONNECTION");
  return { id: input.id, kind: "github", site: endpoints.site, apiBase: endpoints.apiBase, ...hasEnv ? { credentialEnv: input.credentialEnv } : { gh: { host: endpoints.host, account: input.gh.account } } };
}
function selectedEnvironment(env, host) {
  const selected = { ...env };
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_DEBUG", "DEBUG", "GH_REPO"]) delete selected[key];
  return { ...selected, GH_HOST: host, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_PAGER: "cat", PAGER: "cat", NO_COLOR: "1" };
}
function runGh(command, args, { env, signal, deadline, failureCode }) {
  if (signal?.aborted) return Promise.reject(new TrackerError("REQUEST_CANCELLED"));
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new TrackerError("REQUEST_TIMEOUT"));
  return new Promise((resolve, reject) => {
    let child, reason, killTimer, timer, bytes = 0;
    const chunks = [];
    const stop = (code) => {
      if (reason) return;
      reason = new TrackerError(code);
      if (child?.pid) {
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 250);
      }
    };
    const cancel = () => stop("REQUEST_CANCELLED");
    try {
      child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true });
    } catch {
      reject(new TrackerError("CLI_UNAVAILABLE"));
      return;
    }
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    timer = setTimeout(() => stop("REQUEST_TIMEOUT"), remaining);
    const collect = (chunk, stdout) => {
      bytes += chunk.length;
      if (bytes > 65536) stop("RESPONSE_TOO_LARGE");
      else if (stdout && !reason) chunks.push(chunk);
    };
    child.stdout.on("data", (chunk) => collect(chunk, true));
    child.stderr.on("data", (chunk) => collect(chunk, false));
    child.once("error", (error) => {
      reason ||= new TrackerError(["ENOENT", "EACCES"].includes(error.code) ? "CLI_UNAVAILABLE" : failureCode);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", cancel);
      if (reason) return reject(reason);
      if (code !== 0) return reject(new TrackerError(failureCode));
      try {
        resolve(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
      } catch {
        reject(new TrackerError(failureCode));
      }
    });
  });
}
var flag = (help, name3) => new RegExp("^\\s*(?:-\\w,\\s*)?--" + name3 + "(?:[ =<]|$)", "m").test(help);
async function resolveGithubAuth(input, { env = process.env, signal, timeoutMs = 8e3, ghCommand = "gh" } = {}) {
  const connection = validateGithubConnection(input), endpoints = githubEndpoints(connection.site);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 25e3 || typeof ghCommand !== "string" || !ghCommand || ghCommand.includes("\0")) fail4("INVALID_REQUEST");
  if (signal?.aborted) fail4("REQUEST_CANCELLED");
  let token;
  if (connection.credentialEnv) token = credential(env[connection.credentialEnv]);
  else {
    const selected = selectedEnvironment(env, connection.gh.host), deadline = Date.now() + timeoutMs, options = { env: selected, signal, deadline };
    const help = await runGh(ghCommand, ["auth", "token", "--help"], { ...options, failureCode: "ACCOUNT_SELECTION_UNSUPPORTED" });
    if (!flag(help, "hostname") || !flag(help, "user")) fail4("ACCOUNT_SELECTION_UNSUPPORTED");
    const noRefresh = flag(help, "no-refresh");
    if (!noRefresh && /\brefresh(?:ed|ing)?\b/i.test(help)) fail4("ACCOUNT_SELECTION_UNSUPPORTED");
    const args = ["auth", "token", "--hostname", connection.gh.host, "--user", connection.gh.account, ...noRefresh ? ["--no-refresh"] : []];
    const output = await runGh(ghCommand, args, { ...options, failureCode: "AUTH_REQUIRED" });
    token = credential(output.replace(/\r?\n$/, ""));
  }
  const result = { connection, allowedOrigin: new URL(connection.apiBase).origin, graphqlUrl: endpoints.graphqlUrl };
  Object.defineProperty(result, "headers", { value: Object.freeze({ accept: "application/vnd.github+json", authorization: "Bearer " + token, "x-github-api-version": "2022-11-28", "user-agent": "herdr-mission-control" }), enumerable: false });
  return Object.freeze(result);
}

// src/mods/mission-control-github/issues.mjs
import { createHash } from "node:crypto";
var MAX_AGE = 7 * 864e5;
var MAX_PAGES = 100;
var PAGE_SIZE = 50;
var object5 = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
var text3 = (value, max = 4096) => typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
var number = (value) => Number.isSafeInteger(value) && value > 0;
var id3 = (value) => number(value) ? String(value) : typeof value === "string" && /^[1-9][0-9]{0,199}$/.test(value) ? value : null;
var fail5 = (code) => {
  throw new TrackerError(code);
};
var hash = (value) => createHash("sha256").update(value).digest("base64url");
var lower = (value) => typeof value === "string" ? value.toLowerCase() : null;
var limits = () => ({ code: "RESPONSE_TOO_LARGE", message: new TrackerError("RESPONSE_TOO_LARGE").message });
function bindingOf(value) {
  try {
    return validateRepoBinding(value);
  } catch (e) {
    fail5(e.code === "STATUS_MAPPING_REQUIRED" ? "STATUS_MAPPING_REQUIRED" : "INVALID_REQUEST");
  }
}
function githubProgressHint(binding) {
  const b = bindingOf(binding);
  if (!b.github) fail5("INVALID_REQUEST");
  const progress = b.github.status?.labels?.inProgress || b.github.status?.project?.options.inProgress;
  if (progress?.length) return "";
  return b.github.status?.project ? "Configure an In progress option for the selected Projects status field. Unmapped options are unavailable." : "Open issues without a mapped label appear in To do. Configure label or Projects status mapping to show In progress.";
}
function plainBody(value) {
  if (value === void 0 || value === null) return "";
  if (typeof value !== "string") fail5("INVALID_RESPONSE");
  const clean = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  if (Buffer.byteLength(clean) <= 48e3) return clean;
  let result = "", bytes = 0;
  for (const c of clean) {
    const n = Buffer.byteLength(c);
    if (bytes + n > 48e3) break;
    bytes += n;
    result += c;
  }
  return result + "\n[GitHub description truncated; open the issue for the full text.]";
}
function sameUrl(actual, expected) {
  let a, b;
  try {
    a = httpsUrl(actual);
    b = httpsUrl(expected);
  } catch {
    fail5("INVALID_SCOPE");
  }
  if (a.search || a.origin !== b.origin || lower(a.pathname) !== lower(b.pathname)) fail5("INVALID_SCOPE");
}
function repoPath(c, b) {
  return c.apiBase + "/repos/" + encodeURIComponent(b.github.owner) + "/" + encodeURIComponent(b.github.repo);
}
function parseIssue(raw, c, b) {
  if (!object5(raw) || !id3(raw.id) || !number(raw.number) || !text3(raw.node_id, 200) || !text3(raw.title, 512) || !["open", "closed"].includes(raw.state) || !Array.isArray(raw.labels) || raw.labels.length > 100) fail5("INVALID_RESPONSE");
  const base = repoPath(c, b), url = c.site + "/" + b.github.owner + "/" + b.github.repo + "/issues/" + raw.number;
  sameUrl(raw.html_url, url);
  sameUrl(raw.url, base + "/issues/" + raw.number);
  sameUrl(raw.repository_url, base);
  const labels = raw.labels.map((label) => {
    const name3 = typeof label === "string" ? label : label?.name;
    if (!text3(name3, 200)) fail5("INVALID_RESPONSE");
    return name3;
  });
  const updatedAt = typeof raw.updated_at === "string" ? Date.parse(raw.updated_at) : NaN;
  if (!Number.isFinite(updatedAt) || updatedAt < 0) fail5("INVALID_RESPONSE");
  return { number: raw.number, nodeId: raw.node_id, state: raw.state, labels, row: { identity: { kind: "github", connectionId: c.id, site: c.site, id: id3(raw.id) }, key: "GH-" + raw.number, title: raw.title, url: raw.html_url, body: plainBody(raw.body), repoBinding: b, updatedAt } };
}
function statusOf(issue, b, projectStatuses2) {
  if (issue.state === "closed") return { statusGroup: "done", statusName: "Closed" };
  const status = b.github.status;
  if (status?.project) {
    const mapped = projectStatuses2.get(issue.nodeId);
    if (!mapped) fail5("STATUS_MAPPING_REQUIRED");
    return mapped;
  }
  if (status?.labels) {
    const labels = new Map(issue.labels.map((label) => [lower(label), label])), matches = Object.entries(status.labels).filter(([, names]) => names.some((name3) => labels.has(lower(name3))));
    if (matches.length > 1) fail5("STATUS_MAPPING_REQUIRED");
    if (matches.length) {
      const [group, names] = matches[0];
      return { statusGroup: group, statusName: labels.get(lower(names.find((name3) => labels.has(lower(name3))))) };
    }
  }
  return { statusGroup: "todo", statusName: "Open" };
}
function cursorRead(value, scope, now) {
  if (!value) return null;
  let c;
  try {
    if (!/^[-\w]+$/.test(value)) fail5("INVALID_SCOPE");
    c = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    fail5("INVALID_SCOPE");
  }
  if (!object5(c) || Object.keys(c).sort().join(",") !== "count,issuedAt,page,repositoryId,scanned,scope,seen,v" || c.v !== 1 || c.scope !== hash(trackerScopeKey(scope)) || typeof c.repositoryId !== "string" || !id3(c.repositoryId) || !Number.isInteger(c.page) || c.page < 2 || c.page > MAX_PAGES || !Number.isInteger(c.scanned) || c.scanned < 0 || c.scanned > (c.page - 1) * PAGE_SIZE || !Number.isInteger(c.count) || c.count < 0 || c.count >= 1e3 || c.count > c.scanned || !Number.isFinite(c.issuedAt) || c.issuedAt > now + 5e3 || now - c.issuedAt >= MAX_AGE || !Array.isArray(c.seen) || c.seen.length > c.page - 1 || c.seen.some((v) => !/^[-\w]{43}$/.test(v)) || new Set(c.seen).size !== c.seen.length) fail5("INVALID_SCOPE");
  return c;
}
function cursorWrite(value) {
  const result = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return result.length <= 8192 ? result : null;
}
function nextPage(header, current, repositoryId) {
  if (header === void 0) return null;
  if (!text3(header, 8192)) fail5("INVALID_RESPONSE");
  const links = header.split(/,(?=\s*<)/);
  if (links.length > 16) fail5("INVALID_RESPONSE");
  let next = null;
  for (const entry of links) {
    const match = entry.match(/^\s*<([^<>]+)>\s*;\s*rel\s*=\s*"([A-Za-z -]+)"\s*$/i);
    if (!match) fail5("INVALID_RESPONSE");
    if (!match[2].toLowerCase().split(/\s+/).includes("next")) continue;
    if (next !== null) fail5("INVALID_SCOPE");
    let target;
    try {
      target = httpsUrl(new URL(match[1], current).href);
    } catch {
      fail5("INVALID_SCOPE");
    }
    const alternate = current.pathname.replace(/\/repos\/[^/]+\/[^/]+\/issues$/, "/repositories/" + repositoryId + "/issues");
    if (target.origin !== current.origin || ![lower(current.pathname), lower(alternate)].includes(lower(target.pathname))) fail5("INVALID_SCOPE");
    for (const key of target.searchParams.keys()) {
      if (!["page", "state", "per_page", "sort", "direction"].includes(key) || target.searchParams.getAll(key).length !== 1 || key !== "page" && target.searchParams.get(key) !== current.searchParams.get(key)) fail5("INVALID_SCOPE");
    }
    const page = target.searchParams.get("page");
    if (!/^[1-9][0-9]*$/.test(page || "") || !number(Number(page)) || Number(page) !== Number(current.searchParams.get("page")) + 1) fail5("INVALID_SCOPE");
    next = Number(page);
  }
  return next;
}
function context(options) {
  const { request = requestJson, env = process.env, ca, signal, timeoutMs = 18e3, clock = () => Date.now(), ghCommand, concurrency = 4 } = options;
  if (typeof request !== "function" || typeof clock !== "function" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 25e3 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) fail5("INVALID_REQUEST");
  const deadline = Date.now() + timeoutMs, controller = new AbortController(), combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const remaining = () => {
    const left = deadline - Date.now();
    if (left <= 0) fail5("REQUEST_TIMEOUT");
    return left;
  };
  return { clock, concurrency, cancel: () => controller.abort(), async auth(connection) {
    return resolveGithubAuth(connection, { env, ghCommand, signal: combined, timeoutMs: Math.min(8e3, remaining()) });
  }, async call(auth2, url, body) {
    const u = httpsUrl(url);
    if (u.origin !== auth2.allowedOrigin) fail5("UNTRUSTED_ORIGIN");
    try {
      const response = await request(u.href, { allowedOrigin: auth2.allowedOrigin, headers: auth2.headers, method: body ? "POST" : "GET", ...body ? { body } : {}, metadata: true, maxRedirects: 0, timeoutMs: remaining(), maxBytes: 4194304, ca, signal: combined });
      if (!object5(response) || !object5(response.headers) || response.url !== u.href || !Number.isInteger(response.status) || response.status < 200 || response.status >= 300) fail5("INVALID_RESPONSE");
      return response;
    } catch (e) {
      if (e instanceof TrackerError && e.status === 403 && e.retryAfterMs !== void 0) throw new TrackerError("RATE_LIMITED", { status: 403, retryAfterMs: e.retryAfterMs });
      throw e;
    }
  } };
}
async function repository(auth2, b, ctx) {
  const raw = (await ctx.call(auth2, repoPath(auth2.connection, b))).data, c = auth2.connection;
  if (!object5(raw) || !id3(raw.id) || !text3(raw.full_name, 256) || lower(raw.full_name) !== lower(b.github.owner + "/" + b.github.repo) || lower(raw.name) !== lower(b.github.repo) || lower(raw.owner?.login) !== lower(b.github.owner) || typeof raw.has_issues !== "boolean") fail5("INVALID_SCOPE");
  sameUrl(raw.html_url, c.site + "/" + b.github.owner + "/" + b.github.repo);
  return { id: id3(raw.id), issuesEnabled: raw.has_issues };
}
var PROJECT_QUERY = `query MissionControlIssueStatus($ids: [ID!]!) {
  nodes(ids: $ids) {
    __typename
    ... on Issue {
      id number state repository { name owner { login } }
      projectItems(first: 100, includeArchived: true) {
        nodes {
          id project { id number owner { ... on Organization { login } ... on User { login } } }
          fieldValues(first: 100) {
            nodes { __typename ... on ProjectV2ItemFieldSingleSelectValue { id name optionId field { ... on ProjectV2SingleSelectField { id } } } }
            pageInfo { hasNextPage }
          }
        }
        pageInfo { hasNextPage }
      }
    }
  }
}`;
function graphData(response) {
  if (!object5(response)) fail5("INVALID_RESPONSE");
  if (response.errors !== void 0) {
    if (!Array.isArray(response.errors)) fail5("INVALID_RESPONSE");
    if (response.errors.length > 100) fail5("RESPONSE_TOO_LARGE");
    if (response.errors.length) {
      const types = response.errors.map((e) => e?.type || e?.extensions?.type || e?.extensions?.code);
      fail5(types.some((type) => ["FORBIDDEN", "NOT_FOUND", "INSUFFICIENT_SCOPES", "UNAUTHORIZED"].includes(type)) ? "PERMISSION_DENIED" : types.includes("RATE_LIMITED") ? "RATE_LIMITED" : types.includes("GRAPHQL_VALIDATION_FAILED") ? "STATUS_MAPPING_REQUIRED" : "UPSTREAM_UNAVAILABLE");
    }
  }
  if (!object5(response.data) || !Array.isArray(response.data.nodes)) fail5("INVALID_RESPONSE");
  return response.data.nodes;
}
function projectStatus(node, issue, b) {
  if (node === null) fail5("PERMISSION_DENIED");
  if (!object5(node) || node.__typename !== "Issue" || node.id !== issue.nodeId || node.number !== issue.number || lower(node.repository?.name) !== lower(b.github.repo) || lower(node.repository?.owner?.login) !== lower(b.github.owner) || !["OPEN", "CLOSED"].includes(node.state)) fail5("INVALID_SCOPE");
  if (node.state === "CLOSED") return { statusGroup: "done", statusName: "Closed" };
  const items = node.projectItems, p = b.github.status.project;
  if (items === null) fail5("PERMISSION_DENIED");
  if (!object5(items) || !Array.isArray(items.nodes) || items.nodes.length > 100 || typeof items.pageInfo?.hasNextPage !== "boolean") fail5("INVALID_RESPONSE");
  if (items.pageInfo.hasNextPage) fail5("INCOMPLETE_RESULTS");
  const matching = items.nodes.filter((item) => item?.project?.number === p.number && lower(item.project.owner?.login) === lower(p.owner));
  if (!matching.length && items.nodes.some((item) => !object5(item) || !object5(item.project) || !text3(item.project.owner?.login, 128))) fail5("PERMISSION_DENIED");
  if (matching.length !== 1) fail5("STATUS_MAPPING_REQUIRED");
  const values = matching[0].fieldValues;
  if (!object5(values) || !Array.isArray(values.nodes) || values.nodes.length > 100 || typeof values.pageInfo?.hasNextPage !== "boolean") fail5("INVALID_RESPONSE");
  if (values.pageInfo.hasNextPage) fail5("INCOMPLETE_RESULTS");
  const fields = values.nodes.filter((value) => value?.__typename === "ProjectV2ItemFieldSingleSelectValue" && value.field?.id === p.fieldId);
  if (fields.length !== 1 || !text3(fields[0].optionId, 200) || !text3(fields[0].name, 200)) fail5("STATUS_MAPPING_REQUIRED");
  try {
    return { statusGroup: mappedStatus(fields[0].optionId, p.options), statusName: fields[0].name };
  } catch {
    fail5("STATUS_MAPPING_REQUIRED");
  }
}
async function projectStatuses(issues, auth2, b, ctx) {
  const result = /* @__PURE__ */ new Map();
  if (!b.github.status?.project) return result;
  const unique = /* @__PURE__ */ new Map();
  for (const issue of issues.filter((issue2) => issue2.state === "open")) {
    const old = unique.get(issue.nodeId);
    if (old && old.number !== issue.number) fail5("INVALID_RESPONSE");
    unique.set(issue.nodeId, issue);
  }
  const rows = [...unique.values()], chunks = [];
  for (let i = 0; i < rows.length; i += 10) chunks.push(rows.slice(i, i + 10));
  let offset = 0, failure;
  await Promise.all(Array.from({ length: Math.min(ctx.concurrency, chunks.length) }, async () => {
    try {
      while (offset < chunks.length && !failure) {
        const batch = chunks[offset++], response = (await ctx.call(auth2, auth2.graphqlUrl, { query: PROJECT_QUERY, variables: { ids: batch.map((issue) => issue.nodeId) } })).data, nodes = graphData(response);
        if (nodes.length !== batch.length) fail5("INVALID_RESPONSE");
        const byId = /* @__PURE__ */ new Map();
        for (const node of nodes) {
          if (node === null) fail5("PERMISSION_DENIED");
          if (!text3(node?.id, 200) || byId.has(node.id)) fail5("INVALID_RESPONSE");
          byId.set(node.id, node);
        }
        for (const issue of batch) {
          if (!byId.has(issue.nodeId)) fail5("INVALID_SCOPE");
          result.set(issue.nodeId, projectStatus(byId.get(issue.nodeId), issue, b));
        }
      }
    } catch (e) {
      failure ||= e;
      ctx.cancel();
      throw failure;
    }
  }));
  return result;
}
async function probeGithubApi(input, options = {}) {
  const r = validateTrackerRequest(input, { connectionValidator: validateGithubConnection, source: "github" });
  if (r.operation !== "probe") fail5("INVALID_REQUEST");
  const b = bindingOf(r.binding);
  if (!b.github) fail5("INVALID_REQUEST");
  const ctx = context(options);
  try {
    const auth2 = await ctx.auth(r.connection), repo = await repository(auth2, b, ctx);
    return { site: auth2.connection.site, owner: b.github.owner, repo: b.github.repo, repositoryId: repo.id, issuesEnabled: repo.issuesEnabled };
  } finally {
    ctx.cancel();
  }
}
async function fetchGithubIssues(input, options = {}) {
  const r = validateTrackerRequest(input, { connectionValidator: validateGithubConnection, source: "github" });
  if (r.operation !== "issues") fail5("INVALID_REQUEST");
  const b = bindingOf(r.binding), scope = trackerScope("github", r.connection, b), ctx = context(options), now = ctx.clock(), previous = cursorRead(r.cursor, scope, now), maxPages = options.maxPages ?? 4;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 20) fail5("INVALID_REQUEST");
  try {
    const auth2 = await ctx.auth(r.connection), repo = await repository(auth2, b, ctx);
    if (!repo.issuesEnabled) fail5("NOT_FOUND");
    if (previous && previous.repositoryId !== repo.id) fail5("INVALID_SCOPE");
    const seen = new Set(previous?.seen || []), identities = /* @__PURE__ */ new Map(), data = [], ids = /* @__PURE__ */ new Set();
    let page = previous?.page || 1, count = previous?.count || 0, scanned = previous?.scanned || 0, bytes = 0, truncated = false, cursor, error;
    for (let n = 0; n < maxPages; n++, page++) {
      const url = new URL(repoPath(auth2.connection, b) + "/issues");
      for (const [key, value] of Object.entries({ state: "all", per_page: PAGE_SIZE, sort: "updated", direction: "desc", page })) url.searchParams.set(key, String(value));
      const response = await ctx.call(auth2, url.href), rows = response.status === 204 && response.data === null ? [] : response.data;
      if (!Array.isArray(rows)) fail5("INVALID_RESPONSE");
      if (rows.length > PAGE_SIZE) fail5("RESPONSE_TOO_LARGE");
      for (const raw of rows) if (!object5(raw) || !id3(raw.id) || !number(raw.number)) fail5("INVALID_RESPONSE");
      if (rows.length) {
        const signature = hash(JSON.stringify(rows.map((raw) => [id3(raw.id), raw.number, Object.hasOwn(raw, "pull_request")])));
        if (seen.has(signature)) fail5("INVALID_SCOPE");
        seen.add(signature);
      }
      scanned += rows.length;
      const next = nextPage(response.headers.link, url, repo.id), issues = rows.filter((raw) => !Object.hasOwn(raw, "pull_request")).map((raw) => parseIssue(raw, auth2.connection, b));
      const statuses = await projectStatuses(issues, auth2, b, ctx);
      let stopped = false;
      for (const issue of issues) {
        if (count >= 1e3) {
          truncated = true;
          stopped = true;
          break;
        }
        count++;
        let checked2;
        try {
          checked2 = validateIssue({ ...issue.row, ...statusOf(issue, b, statuses) }, { scope });
        } catch (e) {
          if (e instanceof TrackerError) throw e;
          fail5("INVALID_RESPONSE");
        }
        const key = issueIdentityKey(checked2), identity = JSON.stringify([issue.number, issue.nodeId]);
        if (identities.has(key) && identities.get(key) !== identity) fail5("INVALID_SCOPE");
        identities.set(key, identity);
        if (ids.has(key)) continue;
        const size = Buffer.byteLength(JSON.stringify(checked2));
        if (bytes + size > 7 * 1024 * 1024) {
          truncated = true;
          error = limits();
          stopped = true;
          break;
        }
        bytes += size;
        ids.add(key);
        data.push(checked2);
      }
      if (stopped) break;
      if (next === null && rows.length < PAGE_SIZE) break;
      if (page >= MAX_PAGES || count >= 1e3) {
        truncated = true;
        error = limits();
        break;
      }
      if (n === maxPages - 1) {
        truncated = true;
        cursor = cursorWrite({ v: 1, scope: hash(trackerScopeKey(scope)), repositoryId: repo.id, page: page + 1, count, scanned, seen: [...seen], issuedAt: previous?.issuedAt ?? now });
        if (!cursor) error = limits();
      }
    }
    return validateSnapshot({ data, fetchedAt: ctx.clock(), scope, truncated, ...cursor ? { cursor } : {}, ...error ? { error } : {} }, scope, { now: ctx.clock() });
  } finally {
    ctx.cancel();
  }
}

// src/mods/mission-control-github/pulls.mjs
import { createHash as createHash2 } from "node:crypto";

// src/mods/mission-control-github/pull-model.js
var object6 = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
var exact4 = (value, required, optional = []) => object6(value) && required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
var text4 = (value, max = 512) => typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
var name = (value) => text4(value, 128) && /^[A-Za-z0-9_.-]+$/.test(value) && ![".", ".."].includes(value);
var sha = (value) => typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
var lower2 = (value) => typeof value === "string" ? value.toLowerCase() : value;
var copy2 = (value) => JSON.parse(JSON.stringify(value));
function stable2(value) {
  if (Array.isArray(value)) return "[" + value.map(stable2).join(",") + "]";
  if (object6(value)) return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + stable2(value[key])).join(",") + "}";
  return JSON.stringify(value);
}
var PullModelError = class extends Error {
  constructor(code = "INVALID_PR", reason) {
    super(code === "PR_ACTION_UNAVAILABLE" ? prReasonText(reason) : "The pull request changed or has invalid metadata. Reload this repository.");
    this.name = "PullModelError";
    this.code = code;
    if (reason) this.reason = reason;
  }
};
var fail6 = (code) => {
  throw new PullModelError(code);
};
var reasons = {
  NOT_LOADED: "Load current pull request details before starting.",
  REFS_UNAVAILABLE: "The source head or base ref is unavailable. Open the pull request and reload.",
  REVIEW_UNAVAILABLE: "Review information is unavailable for this account.",
  NO_REVIEW_DECISION: "GitHub has not reported an aggregate review decision.",
  DISCUSSIONS_UNAVAILABLE: "Review threads are unavailable for this account.",
  DISCUSSIONS_PARTIAL: "The complete review thread list is unavailable. Open the pull request.",
  NO_ACTIONABLE_COMMENTS: "There are no current unresolved review threads to address.",
  CHECKS_UNAVAILABLE: "Checks are unavailable for this account.",
  NO_CHECKS: "No checks have been reported for this commit.",
  CHECKS_PARTIAL: "The complete check results are unavailable. Open the pull request.",
  PR_CLOSED: "This pull request is closed. Open it to inspect its current state.",
  FORK_READ_ONLY: "This head belongs to another repository. Review is available; code-fix actions require the bound repository."
};
var prReasonText = (code) => Object.hasOwn(reasons, code) ? reasons[code] : "This pull request action is unavailable. Reload its details.";
function sourceUrl(value, site) {
  return text4(value, 4096) && value.startsWith(site + "/") && !/[\\?#]/.test(value);
}
function reference(value, head) {
  if (!exact4(value, head ? ["ref", "sha", "repoFullName", "available"] : ["ref", "sha", "available"]) || !text4(value.ref, 512) || !sha(value.sha) || ![null, true, false].includes(value.available)) fail6();
  if (/[\s~^:?*\[\\]/.test(value.ref) || value.ref.includes("..") || value.ref.includes("@{") || value.ref.startsWith("/") || value.ref.endsWith("/") || value.ref.split("/").some((p) => !p || p.startsWith(".") || p.endsWith(".") || p.endsWith(".lock"))) fail6();
  if (head && value.repoFullName !== null && (!text4(value.repoFullName, 257) || value.repoFullName.split("/").length !== 2 || !value.repoFullName.split("/").every(name))) fail6();
  if (head && value.available === true && value.repoFullName === null) fail6();
}
function aggregate(value, states, unavailableReasons) {
  if (!exact4(value, ["state"], ["reason"]) || !states.includes(value.state)) fail6();
  if (value.state === "unavailable") {
    if (!unavailableReasons.includes(value.reason)) fail6();
  } else if (Object.hasOwn(value, "reason")) fail6();
}
function discussions(value) {
  if (value?.state === "actionable") {
    if (!exact4(value, ["state", "count"]) || !Number.isInteger(value.count) || value.count < 1 || value.count > 100) fail6();
  } else if (value?.state === "none") {
    if (!exact4(value, ["state", "count", "reason"]) || value.count !== 0 || value.reason !== "NO_ACTIONABLE_COMMENTS") fail6();
  } else if (!exact4(value, ["state", "reason"]) || value.state !== "unavailable" || !["NOT_LOADED", "DISCUSSIONS_UNAVAILABLE", "DISCUSSIONS_PARTIAL"].includes(value.reason)) fail6();
}
function validatePullRequest(value, { scope } = {}) {
  if (!exact4(value, ["identity", "key", "title", "url", "body", "author", "repoBinding", "state", "draft", "head", "base", "review", "discussions", "checks", "linkedIssues", "updatedAt"])) fail6();
  const i = value.identity;
  if (!exact4(i, ["kind", "connectionId", "site", "owner", "repo", "number"]) || i.kind !== "github-pr" || !text4(i.connectionId, 96) || !/^[a-z][a-z0-9-]*$/.test(i.connectionId) || !name(i.owner) || !name(i.repo) || !Number.isSafeInteger(i.number) || i.number < 1) fail6();
  let binding, site;
  try {
    binding = validateRepoBinding(value.repoBinding);
    site = trackerOrigin(i.site);
  } catch {
    fail6();
  }
  if (site !== i.site || binding.github?.connectionId !== i.connectionId || lower2(binding.github.owner) !== lower2(i.owner) || lower2(binding.github.repo) !== lower2(i.repo) || value.key !== "GH-PR-" + i.number || lower2(value.url) !== lower2(site + "/" + i.owner + "/" + i.repo + "/pull/" + i.number)) fail6();
  if (!text4(value.title, 512) || typeof value.body !== "string" || utf8Bytes(value.body) > 64e3 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value.body) || !["open", "closed", "merged"].includes(value.state) || typeof value.draft !== "boolean" || !Number.isFinite(value.updatedAt) || value.updatedAt < 0 || value.updatedAt > 864e13) fail6();
  const a = value.author;
  if (!exact4(a, ["login", "url"]) || a.login === null && a.url !== null || a.login !== null && (!text4(a.login, 100) || a.url === null || !sourceUrl(a.url, site))) fail6();
  reference(value.head, true);
  reference(value.base, false);
  aggregate(value.review, ["approved", "changesRequested", "reviewRequired", "unavailable"], ["NOT_LOADED", "REVIEW_UNAVAILABLE", "NO_REVIEW_DECISION"]);
  aggregate(value.checks, ["pending", "success", "failure", "unavailable"], ["NOT_LOADED", "CHECKS_UNAVAILABLE", "NO_CHECKS", "CHECKS_PARTIAL"]);
  discussions(value.discussions);
  if (!Array.isArray(value.linkedIssues) || value.linkedIssues.length > 100) fail6();
  const seen = /* @__PURE__ */ new Set();
  for (const link of value.linkedIssues) {
    if (!exact4(link, ["kind", "id", "url"]) || !["github", "jira"].includes(link.kind) || !text4(link.id, 200) || !text4(link.url, 4096)) fail6();
    if (link.kind === "github") {
      const path = link.url.slice(site.length);
      if (!link.url.startsWith(site + "/") || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/[1-9][0-9]*$/.test(path)) fail6();
    } else {
      const match = link.url.match(/^(https:\/\/[^/]+)\/browse\/([A-Za-z][A-Za-z0-9_]*-[1-9][0-9]*)$/);
      try {
        if (!match || trackerOrigin(match[1]) !== match[1] || link.id !== match[2]) fail6();
      } catch {
        fail6();
      }
    }
    const key = stable2([link.kind, link.url]);
    if (seen.has(key)) fail6();
    seen.add(key);
  }
  if (scope) {
    let s;
    try {
      s = validateTrackerScope(scope);
    } catch {
      fail6();
    }
    if (s.source !== "github-pr" || s.connectionId !== i.connectionId || s.site !== site || s.machine !== binding.machine || s.repoRoot !== binding.repoRoot || stable2(s.selection) !== stable2(binding.github)) fail6();
  }
  return { ...copy2(value), repoBinding: binding };
}
function pullIdentityKey(value) {
  const p = validatePullRequest(value), i = p.identity;
  return stable2([i.kind, i.connectionId, i.site, lower2(i.owner), lower2(i.repo), i.number, p.repoBinding.machine, p.repoBinding.repoRoot]);
}
function prDetailCursor(value) {
  const p = validatePullRequest(value);
  return JSON.stringify({ v: 1, kind: "pr-detail", identity: p.identity, headSha: p.head.sha, baseSha: p.base.sha });
}

// src/mods/mission-control-github/pulls.mjs
var PAGE_SIZE2 = 50;
var MAX_PAGES2 = 100;
var MAX_AGE2 = 7 * 864e5;
var object7 = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
var exact5 = (value, keys) => object7(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
var text5 = (value, max = 4096) => typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
var positive = (value) => Number.isSafeInteger(value) && value > 0;
var id4 = (value) => positive(value) ? String(value) : typeof value === "string" && /^[1-9][0-9]{0,199}$/.test(value) ? value : null;
var sha2 = (value) => typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
var lower3 = (value) => typeof value === "string" ? value.toLowerCase() : value;
var hash2 = (value) => createHash2("sha256").update(value).digest("base64url");
var fail7 = (code) => {
  throw new TrackerError(code);
};
var unavailable = (reason) => ({ state: "unavailable", reason });
var limited = () => ({ code: "RESPONSE_TOO_LARGE", message: new TrackerError("RESPONSE_TOO_LARGE").message });
function checked(value, scope) {
  try {
    return validatePullRequest(value, { scope });
  } catch {
    fail7("INVALID_RESPONSE");
  }
}
function sameUrl2(actual, expected) {
  let a, b;
  try {
    a = httpsUrl(actual);
    b = httpsUrl(expected);
  } catch {
    fail7("INVALID_SCOPE");
  }
  if (a.search || a.origin !== b.origin || lower3(a.pathname) !== lower3(b.pathname)) fail7("INVALID_SCOPE");
}
var apiRepo = (c, b) => c.apiBase + "/repos/" + encodeURIComponent(b.github.owner) + "/" + encodeURIComponent(b.github.repo);
function bodyText(value) {
  if (value === null) return "";
  if (typeof value !== "string") fail7("INVALID_RESPONSE");
  const clean = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  if (Buffer.byteLength(clean) <= 48e3) return clean;
  let result = "", bytes = 0;
  for (const c of clean) {
    const n = Buffer.byteLength(c);
    if (bytes + n > 48e3) break;
    bytes += n;
    result += c;
  }
  return result + "\n[GitHub description truncated; open the pull request for the full text.]";
}
function jiraLinks(body) {
  const links = [], seen = /* @__PURE__ */ new Set(), pattern = /https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?\/browse\/[A-Za-z][A-Za-z0-9_]*-[1-9][0-9]*(?![A-Za-z0-9_/?#=%-])/g;
  for (const match of body.matchAll(pattern)) {
    const url = match[0];
    if (url.length > 4096 || seen.has(url)) continue;
    try {
      const parsed = httpsUrl(url), key = parsed.pathname.slice("/browse/".length);
      if (trackerOrigin(parsed.origin) !== parsed.origin || parsed.origin + parsed.pathname !== url) continue;
      seen.add(url);
      links.push({ kind: "jira", id: key, url });
    } catch {
    }
    if (links.length === 50) break;
  }
  return links;
}
function repositoryName(raw, c) {
  if (!object7(raw) || !text5(raw.full_name, 257) || raw.full_name.split("/").length !== 2 || lower3(raw.full_name) !== lower3(raw.owner?.login + "/" + raw.name)) fail7("INVALID_RESPONSE");
  sameUrl2(raw.html_url, c.site + "/" + raw.full_name);
  return raw.full_name;
}
function parsePull(raw, c, b, scope) {
  if (!object7(raw) || !id4(raw.id) || !text5(raw.node_id, 200) || !positive(raw.number) || !text5(raw.title, 512) || !["open", "closed"].includes(raw.state) || typeof raw.draft !== "boolean" || !Object.hasOwn(raw, "merged_at") || raw.merged_at !== null && (!text5(raw.merged_at, 80) || !Number.isFinite(Date.parse(raw.merged_at))) || raw.state === "open" && raw.merged_at !== null) fail7("INVALID_RESPONSE");
  const base = apiRepo(c, b);
  sameUrl2(raw.url, base + "/pulls/" + raw.number);
  sameUrl2(raw.html_url, c.site + "/" + b.github.owner + "/" + b.github.repo + "/pull/" + raw.number);
  if (!object7(raw.head) || !object7(raw.base) || !sha2(raw.head.sha) || !sha2(raw.base.sha)) fail7("INVALID_RESPONSE");
  if (lower3(repositoryName(raw.base.repo, c)) !== lower3(b.github.owner + "/" + b.github.repo)) fail7("INVALID_SCOPE");
  const headRepo = raw.head.repo === null ? null : repositoryName(raw.head.repo, c);
  let author;
  if (raw.user === null) author = { login: null, url: null };
  else {
    if (!object7(raw.user) || !text5(raw.user.login, 100)) fail7("INVALID_RESPONSE");
    author = { login: raw.user.login, url: raw.user.html_url };
  }
  const updatedAt = typeof raw.updated_at === "string" ? Date.parse(raw.updated_at) : NaN, body = bodyText(raw.body);
  const pull = checked({
    identity: { kind: "github-pr", connectionId: c.id, site: c.site, owner: b.github.owner, repo: b.github.repo, number: raw.number },
    key: "GH-PR-" + raw.number,
    title: raw.title,
    url: raw.html_url,
    body,
    author,
    repoBinding: b,
    state: raw.merged_at !== null ? "merged" : raw.state,
    draft: raw.draft,
    head: { ref: raw.head.ref, sha: raw.head.sha, repoFullName: headRepo, available: null },
    base: { ref: raw.base.ref, sha: raw.base.sha, available: null },
    review: unavailable("NOT_LOADED"),
    discussions: unavailable("NOT_LOADED"),
    checks: unavailable("NOT_LOADED"),
    linkedIssues: jiraLinks(body),
    updatedAt
  }, scope);
  return { pull, nodeId: raw.node_id };
}
function context2(options) {
  const { request = requestJson, env = process.env, ca, signal, timeoutMs = 18e3, clock = () => Date.now(), ghCommand, concurrency = 4 } = options;
  if (typeof request !== "function" || typeof clock !== "function" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 25e3 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) fail7("INVALID_REQUEST");
  const deadline = Date.now() + timeoutMs, controller = new AbortController(), combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const remaining = () => {
    const left = deadline - Date.now();
    if (left <= 0) fail7("REQUEST_TIMEOUT");
    return left;
  };
  return { clock, cancel: () => controller.abort(), auth: (connection) => resolveGithubAuth(connection, { env, ghCommand, signal: combined, timeoutMs: Math.min(8e3, remaining()) }), async call(auth2, url, body) {
    const u = httpsUrl(url);
    if (u.origin !== auth2.allowedOrigin) fail7("UNTRUSTED_ORIGIN");
    try {
      const response = await request(u.href, { allowedOrigin: auth2.allowedOrigin, headers: auth2.headers, method: body ? "POST" : "GET", ...body ? { body } : {}, metadata: true, maxRedirects: 0, timeoutMs: remaining(), maxBytes: 4194304, ca, signal: combined });
      if (!object7(response) || !object7(response.headers) || response.url !== u.href || !Number.isInteger(response.status) || response.status < 200 || response.status >= 300) fail7("INVALID_RESPONSE");
      return response;
    } catch (e) {
      if (e instanceof TrackerError && e.status === 403 && e.retryAfterMs !== void 0) throw new TrackerError("RATE_LIMITED", { status: 403, retryAfterMs: e.retryAfterMs });
      throw e;
    }
  } };
}
async function repository2(auth2, b, ctx) {
  const raw = (await ctx.call(auth2, apiRepo(auth2.connection, b))).data;
  if (!id4(raw?.id) || lower3(repositoryName(raw, auth2.connection)) !== lower3(b.github.owner + "/" + b.github.repo)) fail7("INVALID_SCOPE");
  return id4(raw.id);
}
function readCursor(value, scope, now) {
  if (!value) return null;
  let c;
  if (value.startsWith("{")) {
    try {
      c = JSON.parse(value);
    } catch {
      fail7("INVALID_SCOPE");
    }
    const i = c?.identity;
    if (!exact5(c, ["v", "kind", "identity", "headSha", "baseSha"]) || c.v !== 1 || c.kind !== "pr-detail" || !exact5(i, ["kind", "connectionId", "site", "owner", "repo", "number"]) || i.kind !== "github-pr" || i.connectionId !== scope.connectionId || i.site !== scope.site || lower3(i.owner) !== lower3(scope.selection.owner) || lower3(i.repo) !== lower3(scope.selection.repo) || !positive(i.number) || !sha2(c.headSha) || !sha2(c.baseSha)) fail7("INVALID_SCOPE");
    return c;
  }
  try {
    if (!/^[-\w]+$/.test(value)) fail7("INVALID_SCOPE");
    c = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    fail7("INVALID_SCOPE");
  }
  if (!exact5(c, ["v", "kind", "scope", "repositoryId", "page", "count", "seen", "issuedAt"]) || c.v !== 1 || c.kind !== "pr-list" || c.scope !== hash2(trackerScopeKey(scope)) || typeof c.repositoryId !== "string" || !id4(c.repositoryId) || !Number.isInteger(c.page) || c.page < 2 || c.page > MAX_PAGES2 || !Number.isInteger(c.count) || c.count < 0 || c.count >= 1e3 || c.count > (c.page - 1) * PAGE_SIZE2 || !Number.isFinite(c.issuedAt) || c.issuedAt > now + 5e3 || now - c.issuedAt >= MAX_AGE2 || !Array.isArray(c.seen) || c.seen.length > c.page - 1 || c.seen.some((v) => !/^[-\w]{43}$/.test(v)) || new Set(c.seen).size !== c.seen.length) fail7("INVALID_SCOPE");
  return c;
}
function writeCursor(value) {
  const encoded = Buffer.from(JSON.stringify(value)).toString("base64url");
  return encoded.length <= 8192 ? encoded : null;
}
function nextPage2(header, current, repositoryId) {
  if (header === void 0) return null;
  if (!text5(header, 8192)) fail7("INVALID_RESPONSE");
  const entries = header.split(/,(?=\s*<)/);
  if (entries.length > 16) fail7("INVALID_RESPONSE");
  let next = null;
  for (const entry of entries) {
    const match = entry.match(/^\s*<([^<>]+)>\s*;\s*rel\s*=\s*"([A-Za-z -]+)"\s*$/i);
    if (!match) fail7("INVALID_RESPONSE");
    if (!match[2].toLowerCase().split(/\s+/).includes("next")) continue;
    if (next !== null) fail7("INVALID_SCOPE");
    let target;
    try {
      target = httpsUrl(new URL(match[1], current).href);
    } catch {
      fail7("INVALID_SCOPE");
    }
    const alternate = current.pathname.replace(/\/repos\/[^/]+\/[^/]+\/pulls$/, "/repositories/" + repositoryId + "/pulls");
    if (target.origin !== current.origin || ![lower3(current.pathname), lower3(alternate)].includes(lower3(target.pathname))) fail7("INVALID_SCOPE");
    for (const key of target.searchParams.keys()) if (!["page", "state", "per_page", "sort", "direction"].includes(key) || target.searchParams.getAll(key).length !== 1 || key !== "page" && target.searchParams.get(key) !== current.searchParams.get(key)) fail7("INVALID_SCOPE");
    const page = target.searchParams.get("page");
    if (!/^[1-9][0-9]*$/.test(page || "") || !positive(Number(page)) || Number(page) !== Number(current.searchParams.get("page")) + 1) fail7("INVALID_SCOPE");
    next = Number(page);
  }
  return next;
}
var DETAIL_QUERY = `query MissionControlPullDetail($id: ID!) {
  node(id: $id) {
    __typename
    ... on PullRequest {
      id number url state isDraft updatedAt repository { nameWithOwner url }
      headRefName headRefOid baseRefName baseRefOid headRepository { nameWithOwner url }
      headRef { name target { oid } } baseRef { name target { oid } }
      reviewDecision
      reviewThreads(first: 100) { totalCount nodes { id isResolved isOutdated } pageInfo { hasNextPage } }
      statusCheckRollup {
        commit { oid } state
        contexts(first: 100) {
          totalCount pageInfo { hasNextPage }
          nodes {
            __typename
            ... on CheckRun { id status conclusion checkSuite { commit { oid } } }
            ... on StatusContext { id state commit { oid } }
          }
        }
      }
      closingIssuesReferences(first: 50) { nodes { id number url repository { nameWithOwner } } pageInfo { hasNextPage } }
    }
  }
}`;
function graphErrors(response) {
  if (!object7(response)) fail7("INVALID_RESPONSE");
  const errors = response.errors ?? [];
  if (!Array.isArray(errors) || errors.length > 100) fail7("INVALID_RESPONSE");
  const denied = /* @__PURE__ */ new Set();
  for (const e of errors) {
    if (!object7(e)) fail7("INVALID_RESPONSE");
    const type = e.type || e.extensions?.type || e.extensions?.code;
    if (type === "RATE_LIMITED") fail7("RATE_LIMITED");
    if (Array.isArray(e.path) && e.path[0] === "node" && typeof e.path[1] === "string") denied.add(e.path[1]);
    else denied.add("*");
  }
  return denied;
}
function complete(connection, max) {
  return object7(connection) && Array.isArray(connection.nodes) && connection.nodes.length <= max && connection.pageInfo?.hasNextPage === false && Number.isSafeInteger(connection.totalCount) && connection.totalCount === connection.nodes.length;
}
function discussionState(connection) {
  if (connection === null || connection === void 0) return unavailable("DISCUSSIONS_UNAVAILABLE");
  if (!complete(connection, 100)) return unavailable("DISCUSSIONS_PARTIAL");
  let count = 0;
  const seen = /* @__PURE__ */ new Set();
  for (const thread of connection.nodes) {
    if (!text5(thread?.id, 200) || seen.has(thread.id) || typeof thread.isResolved !== "boolean" || typeof thread.isOutdated !== "boolean") return unavailable("DISCUSSIONS_PARTIAL");
    seen.add(thread.id);
    if (!thread.isResolved && !thread.isOutdated) count++;
  }
  return count ? { state: "actionable", count } : { state: "none", count: 0, reason: "NO_ACTIONABLE_COMMENTS" };
}
function checkState(rollup, headSha) {
  if (rollup === null || rollup === void 0) return unavailable("NO_CHECKS");
  if (!object7(rollup)) return unavailable("CHECKS_PARTIAL");
  if (rollup.commit === null || rollup.commit === void 0) return unavailable("CHECKS_UNAVAILABLE");
  if (!sha2(rollup.commit.oid)) return unavailable("CHECKS_PARTIAL");
  if (lower3(rollup.commit.oid) !== lower3(headSha)) fail7("INVALID_SCOPE");
  if (!complete(rollup.contexts, 100)) return unavailable("CHECKS_PARTIAL");
  if (!rollup.contexts.nodes.length) return unavailable("NO_CHECKS");
  const states = [], seen = /* @__PURE__ */ new Set();
  for (const row of rollup.contexts.nodes) {
    if (!text5(row?.id, 200) || seen.has(row.id)) return unavailable("CHECKS_PARTIAL");
    seen.add(row.id);
    if (row.__typename === "CheckRun") {
      if (!sha2(row.checkSuite?.commit?.oid)) return unavailable("CHECKS_PARTIAL");
      if (lower3(row.checkSuite.commit.oid) !== lower3(headSha)) fail7("INVALID_SCOPE");
      if (["QUEUED", "IN_PROGRESS", "PENDING", "WAITING", "REQUESTED"].includes(row.status)) {
        states.push("pending");
        continue;
      }
      if (row.status !== "COMPLETED") return unavailable("CHECKS_PARTIAL");
      if (["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(row.conclusion)) states.push("failure");
      else if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(row.conclusion)) states.push("success");
      else return unavailable("CHECKS_PARTIAL");
    } else if (row.__typename === "StatusContext") {
      if (!sha2(row.commit?.oid)) return unavailable("CHECKS_PARTIAL");
      if (lower3(row.commit.oid) !== lower3(headSha)) fail7("INVALID_SCOPE");
      if (["ERROR", "FAILURE"].includes(row.state)) states.push("failure");
      else if (["EXPECTED", "PENDING"].includes(row.state)) states.push("pending");
      else if (row.state === "SUCCESS") states.push("success");
      else return unavailable("CHECKS_PARTIAL");
    } else return unavailable("CHECKS_PARTIAL");
  }
  if (!["ERROR", "FAILURE", "EXPECTED", "PENDING", "SUCCESS"].includes(rollup.state)) return unavailable("CHECKS_PARTIAL");
  if (states.includes("failure")) return { state: "failure" };
  if (["ERROR", "FAILURE"].includes(rollup.state)) return unavailable("CHECKS_PARTIAL");
  return { state: states.includes("pending") || rollup.state !== "SUCCESS" ? "pending" : "success" };
}
function verifiedRef(raw, expected, denied, key) {
  if (denied.has("*") || denied.has(key)) return null;
  if (raw === null) return false;
  if (!object7(raw) || raw.name !== expected.ref || !sha2(raw.target?.oid) || lower3(raw.target.oid) !== lower3(expected.sha)) fail7("INVALID_SCOPE");
  return true;
}
function linkedIssues(pull, connection, c) {
  const result = [...pull.linkedIssues], seen = new Set(result.map((x) => x.kind + "\0" + x.url));
  if (connection === null || connection === void 0) return result;
  if (!object7(connection) || !Array.isArray(connection.nodes) || connection.nodes.length > 50 || typeof connection.pageInfo?.hasNextPage !== "boolean") fail7("INVALID_RESPONSE");
  for (const row of connection.nodes) {
    if (!text5(row?.id, 200) || !positive(row.number) || !text5(row.repository?.nameWithOwner, 257)) fail7("INVALID_RESPONSE");
    sameUrl2(row.url, c.site + "/" + row.repository.nameWithOwner + "/issues/" + row.number);
    const key = "github\0" + row.url;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ kind: "github", id: row.id, url: row.url });
  }
  return result;
}
async function enrich(parsed, auth2, b, scope, ctx) {
  const p = parsed.pull, unknown = { ...p, review: unavailable("REVIEW_UNAVAILABLE"), discussions: unavailable("DISCUSSIONS_UNAVAILABLE"), checks: unavailable("CHECKS_UNAVAILABLE") };
  let response;
  try {
    response = (await ctx.call(auth2, auth2.graphqlUrl, { query: DETAIL_QUERY, variables: { id: parsed.nodeId } })).data;
  } catch (e) {
    if (["PERMISSION_DENIED", "NOT_FOUND"].includes(e.code)) return { pull: unknown };
    throw e;
  }
  const denied = graphErrors(response);
  if (!object7(response.data) || !Object.hasOwn(response.data, "node")) {
    if (denied.size) return { pull: unknown };
    fail7("INVALID_RESPONSE");
  }
  const node = response.data.node;
  if (node === null || node === void 0 || denied.has("*")) return { pull: unknown };
  if (!object7(node) || node.__typename !== "PullRequest" || node.id !== parsed.nodeId || node.number !== p.identity.number || lower3(node.repository?.nameWithOwner) !== lower3(b.github.owner + "/" + b.github.repo)) fail7("INVALID_SCOPE");
  sameUrl2(node.url, p.url);
  sameUrl2(node.repository.url, auth2.connection.site + "/" + b.github.owner + "/" + b.github.repo);
  for (const [key, wanted] of [["headRefName", p.head.ref], ["baseRefName", p.base.ref], ["headRefOid", p.head.sha], ["baseRefOid", p.base.sha]]) {
    if (denied.has(key)) return { pull: unknown };
    if (key.endsWith("Oid") ? lower3(node[key]) !== lower3(wanted) : node[key] !== wanted) fail7("INVALID_SCOPE");
  }
  const headName = node.headRepository === null ? null : node.headRepository?.nameWithOwner;
  if (!denied.has("headRepository")) {
    if (lower3(headName) !== lower3(p.head.repoFullName)) fail7("INVALID_SCOPE");
    if (headName !== null) sameUrl2(node.headRepository.url, auth2.connection.site + "/" + headName);
  }
  if (!["OPEN", "CLOSED", "MERGED"].includes(node.state) || typeof node.isDraft !== "boolean" || !text5(node.updatedAt, 80) || !Number.isFinite(Date.parse(node.updatedAt))) fail7("INVALID_RESPONSE");
  const review = denied.has("reviewDecision") ? unavailable("REVIEW_UNAVAILABLE") : node.reviewDecision === null ? unavailable("NO_REVIEW_DECISION") : { APPROVED: { state: "approved" }, CHANGES_REQUESTED: { state: "changesRequested" }, REVIEW_REQUIRED: { state: "reviewRequired" } }[node.reviewDecision] || unavailable("REVIEW_UNAVAILABLE");
  const pull = {
    ...p,
    state: node.state.toLowerCase(),
    draft: node.isDraft,
    updatedAt: Date.parse(node.updatedAt),
    head: { ...p.head, available: denied.has("headRepository") ? null : headName === null ? false : verifiedRef(node.headRef, p.head, denied, "headRef") },
    base: { ...p.base, available: verifiedRef(node.baseRef, p.base, denied, "baseRef") },
    review,
    discussions: denied.has("reviewThreads") ? unavailable("DISCUSSIONS_UNAVAILABLE") : discussionState(node.reviewThreads),
    checks: denied.has("statusCheckRollup") ? unavailable("CHECKS_UNAVAILABLE") : checkState(node.statusCheckRollup, p.head.sha),
    linkedIssues: denied.has("closingIssuesReferences") ? p.linkedIssues : linkedIssues(p, node.closingIssuesReferences, auth2.connection)
  };
  const partial = denied.has("closingIssuesReferences") || node.closingIssuesReferences?.pageInfo?.hasNextPage;
  return { pull: checked(pull, scope), ...partial ? { error: { code: "INCOMPLETE_RESULTS", message: new TrackerError("INCOMPLETE_RESULTS").message } } : {} };
}
async function fetchGithubPulls(input, options = {}) {
  const r = validateTrackerRequest(input, { connectionValidator: validateGithubConnection, source: "github" });
  if (r.operation !== "pulls") fail7("INVALID_REQUEST");
  let b;
  try {
    b = validateRepoBinding(r.binding);
  } catch {
    fail7("INVALID_REQUEST");
  }
  const scope = trackerScope("github-pr", r.connection, b), ctx = context2(options), previous = readCursor(r.cursor, scope, ctx.clock()), maxPages = options.maxPages ?? 4;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 20) fail7("INVALID_REQUEST");
  const snapshot = (data, extras = {}) => validateSnapshot({ data, fetchedAt: ctx.clock(), scope, truncated: false, ...extras }, scope, { now: ctx.clock(), validateItem: validatePullRequest, itemKey: pullIdentityKey });
  try {
    const auth2 = await ctx.auth(r.connection), repositoryId = await repository2(auth2, b, ctx);
    if (previous?.kind === "pr-detail") {
      const parsed = parsePull((await ctx.call(auth2, apiRepo(auth2.connection, b) + "/pulls/" + previous.identity.number)).data, auth2.connection, b, scope);
      if (lower3(parsed.pull.head.sha) !== lower3(previous.headSha) || lower3(parsed.pull.base.sha) !== lower3(previous.baseSha) || parsed.pull.identity.number !== previous.identity.number) fail7("INVALID_SCOPE");
      const result = await enrich(parsed, auth2, b, scope, ctx);
      return snapshot([result.pull], result.error ? { error: result.error } : {});
    }
    if (previous && previous.repositoryId !== repositoryId) fail7("INVALID_SCOPE");
    const seen = new Set(previous?.seen || []), keys = /* @__PURE__ */ new Map(), data = [];
    let page = previous?.page || 1, count = previous?.count || 0, bytes = 0, truncated = false, cursor, error;
    for (let n = 0; n < maxPages; n++, page++) {
      const url = new URL(apiRepo(auth2.connection, b) + "/pulls");
      for (const [key, value] of Object.entries({ state: "all", per_page: PAGE_SIZE2, sort: "updated", direction: "desc", page })) url.searchParams.set(key, String(value));
      const response = await ctx.call(auth2, url.href), rows = response.status === 204 && response.data === null ? [] : response.data;
      if (!Array.isArray(rows)) fail7("INVALID_RESPONSE");
      if (rows.length > PAGE_SIZE2) fail7("RESPONSE_TOO_LARGE");
      for (const row of rows) if (!id4(row?.id) || !positive(row.number)) fail7("INVALID_RESPONSE");
      if (rows.length) {
        const signature = hash2(JSON.stringify(rows.map((row) => [id4(row.id), row.number])));
        if (seen.has(signature)) fail7("INVALID_SCOPE");
        seen.add(signature);
      }
      const next = nextPage2(response.headers.link, url, repositoryId);
      let stopped = false;
      for (const raw of rows) {
        if (count >= 1e3) {
          truncated = true;
          stopped = true;
          break;
        }
        count++;
        const parsed = parsePull(raw, auth2.connection, b, scope), pull = parsed.pull, key = pullIdentityKey(pull), identity = JSON.stringify([id4(raw.id), parsed.nodeId]);
        if (keys.has(key)) {
          if (keys.get(key) !== identity) fail7("INVALID_SCOPE");
          continue;
        }
        const size = Buffer.byteLength(JSON.stringify(pull));
        if (bytes + size > 7 * 1024 * 1024) {
          truncated = true;
          error = limited();
          stopped = true;
          break;
        }
        bytes += size;
        keys.set(key, identity);
        data.push(pull);
      }
      if (stopped) break;
      if (next === null && rows.length < PAGE_SIZE2) break;
      if (page >= MAX_PAGES2 || count >= 1e3) {
        truncated = true;
        error = limited();
        break;
      }
      if (n === maxPages - 1) {
        truncated = true;
        cursor = writeCursor({ v: 1, kind: "pr-list", scope: hash2(trackerScopeKey(scope)), repositoryId, page: page + 1, count, seen: [...seen], issuedAt: previous?.issuedAt ?? ctx.clock() });
        if (!cursor) error = limited();
      }
    }
    return snapshot(data, { truncated, ...cursor ? { cursor } : {}, ...error ? { error } : {} });
  } finally {
    ctx.cancel();
  }
}

// src/mods/mission-control-github/data.js
var copy3 = (value) => JSON.parse(JSON.stringify(value));
var object8 = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
var exact6 = (value, required, optional = []) => object8(value) && required.every((k) => Object.hasOwn(value, k)) && Object.keys(value).every((k) => required.includes(k) || optional.includes(k));
var text6 = (value, max = 512) => typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
var name2 = (value) => text6(value, 128) && /^[A-Za-z0-9_.-]+$/.test(value) && ![".", ".."].includes(value);
function stable3(value) {
  if (Array.isArray(value)) return "[" + value.map(stable3).join(",") + "]";
  if (object8(value)) return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + stable3(value[k])).join(",") + "}";
  return JSON.stringify(value);
}
var messages3 = { INVALID_REQUEST: "Check the GitHub connection and repository fields.", INVALID_CONNECTION: "Check the GitHub site, API URL and selected credential reference.", INVALID_SCOPE: "This repository or account changed. Reload its GitHub view.", INVALID_RESPONSE: "The GitHub helper returned an invalid or mismatched response.", INVALID_CONFIG: "Mission Control settings could not be read. The original file was preserved.", AUTH_REQUIRED: "The selected GitHub credentials are unavailable. Check this profile.", PERMISSION_DENIED: "The selected account cannot read this GitHub resource.", NOT_FOUND: "The selected GitHub resource was not found.", RATE_LIMITED: "GitHub reached its read limit. Retry after the reported delay.", STATUS_MAPPING_REQUIRED: "Choose one available Projects field and its stable status options, or configure label mapping.", ACCOUNT_SELECTION_UNSUPPORTED: "The installed gh cannot safely select this account. Use an environment reference or a supported version.", CLI_UNAVAILABLE: "The selected local GitHub program is unavailable.", CONNECTION_CONFLICT: "This profile is already used. Choose a new profile ID to change its connection.", REQUEST_TIMEOUT: "The GitHub read timed out. Retry this scope.", REQUEST_CANCELLED: "This GitHub operation was cancelled.", RESPONSE_TOO_LARGE: "The GitHub result exceeds its bounded size. Narrow the selected scope.", INCOMPLETE_RESULTS: "GitHub could not confirm a complete result. Narrow the selected scope and refresh.", UNTRUSTED_ORIGIN: "GitHub tried to leave the selected HTTPS origin.", HELPER_UNAVAILABLE: "The local GitHub helper could not run. Check that Node.js 22 or later is installed.", UPSTREAM_UNAVAILABLE: "GitHub is temporarily unavailable. Retry this connection.", HTTP_ERROR: "GitHub rejected this read request. Check the selected profile.", REQUEST_FAILED: "GitHub could not be reached. Check the selected profile and retry." };
var GithubDataError = class extends Error {
  constructor(code, details = {}) {
    const safe = Object.hasOwn(messages3, code) ? code : "REQUEST_FAILED";
    super(messages3[safe]);
    this.name = "GithubDataError";
    this.code = safe;
    if (Number.isFinite(details.retryAfterMs) && details.retryAfterMs >= 0) this.retryAfterMs = Math.min(details.retryAfterMs, 864e5);
  }
};
var fail8 = (code) => {
  throw new GithubDataError(code);
};
var safeError = (e) => e instanceof GithubDataError ? e : new GithubDataError(["INVALID_PR", "INVALID_PR_ACTION", "INVALID_SNAPSHOT", "INVALID_ISSUE"].includes(e?.code) ? "INVALID_RESPONSE" : e?.code === "INVALID_BINDING" ? "INVALID_SCOPE" : ["INVALID_JSON", "UNSUPPORTED_VERSION", "CONFIG_PATH", "CONFIG_DIRECTORY"].includes(e?.code) ? "INVALID_CONFIG" : e?.code);
function profile(value) {
  if (!exact6(value, ["id", "kind", "site", "apiBase"], ["credentialEnv", "gh"]) || value.kind !== "github" || !text6(value.id, 96) || !/^[a-z][a-z0-9-]*$/.test(value.id) || ["constructor", "prototype"].includes(value.id) || !text6(value.apiBase, 2048) || !/^https:\/\/[^\s/@?#]+(?:\/[^\s?#]*)?$/.test(value.apiBase)) fail8("INVALID_CONNECTION");
  try {
    validateConfig({ v: 1, preferences: { githubProfile: value } });
  } catch {
    fail8("INVALID_CONNECTION");
  }
  const env = Object.hasOwn(value, "credentialEnv"), gh = Object.hasOwn(value, "gh");
  if (env === gh || env && !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value.credentialEnv) || gh && (!exact6(value.gh, ["host", "account"]) || !text6(value.gh.host, 256) || !text6(value.gh.account, 100))) fail8("INVALID_CONNECTION");
  return { ...copy3(value), site: trackerOrigin(value.site) };
}
function githubProjectFieldsCursor({ owner, number: number2 }) {
  if (!name2(owner) || !Number.isInteger(number2) || number2 < 1 || number2 > 2147483647) fail8("INVALID_REQUEST");
  return JSON.stringify({ v: 1, kind: "github-project-fields", owner, number: number2 });
}
function readGithubProjectFieldsCursor(value) {
  let c;
  try {
    c = JSON.parse(value);
  } catch {
    fail8("INVALID_REQUEST");
  }
  if (!exact6(c, ["v", "kind", "owner", "number"]) || c.v !== 1 || c.kind !== "github-project-fields") fail8("INVALID_REQUEST");
  githubProjectFieldsCursor(c);
  return c;
}
function inputShape(input) {
  if (!exact6(input, ["v", "operation", "connection", "binding"], ["cursor"]) || input.v !== 1 || !["issues", "pulls", "probe"].includes(input.operation) || input.cursor !== void 0 && input.cursor !== null && !text6(input.cursor, 8192)) fail8("INVALID_REQUEST");
  const connection = profile(input.connection), binding = validateRepoBinding(input.binding);
  if (binding.github?.connectionId !== connection.id) fail8("INVALID_SCOPE");
  if (input.operation === "probe" && input.cursor) readGithubProjectFieldsCursor(input.cursor);
  if (input.operation !== "probe" && input.cursor?.startsWith("{")) {
    if (input.operation !== "pulls") fail8("INVALID_SCOPE");
    let c;
    try {
      c = JSON.parse(input.cursor);
    } catch {
      fail8("INVALID_SCOPE");
    }
    if (c?.kind !== "pr-detail") fail8("INVALID_SCOPE");
  }
  return { ...copy3(input), connection, binding };
}
function validateProbe(value, input) {
  const c = input.connection, b = input.binding.github;
  if (input.cursor) {
    const selected = readGithubProjectFieldsCursor(input.cursor);
    if (!exact6(value, ["kind", "site", "owner", "number", "projectId", "fields", "complete"]) || value.kind !== "project-fields" || value.site !== c.site || value.owner?.toLowerCase() !== selected.owner.toLowerCase() || value.number !== selected.number || !text6(value.projectId, 200) || value.complete !== true || !Array.isArray(value.fields) || value.fields.length > 300) fail8("INVALID_RESPONSE");
    const seen = /* @__PURE__ */ new Set();
    for (const field of value.fields) {
      if (!exact6(field, ["id", "name", "options"]) || !text6(field.id, 200) || !text6(field.name, 200) || seen.has(field.id) || !Array.isArray(field.options) || field.options.length > 250) fail8("INVALID_RESPONSE");
      seen.add(field.id);
      const ids = /* @__PURE__ */ new Set();
      for (const option of field.options) {
        if (!exact6(option, ["id", "name"]) || !text6(option.id, 200) || !text6(option.name, 200) || ids.has(option.id)) fail8("INVALID_RESPONSE");
        ids.add(option.id);
      }
    }
  } else if (!exact6(value, ["kind", "site", "owner", "repo", "repositoryId", "issuesEnabled"]) || value.kind !== "repository" || value.site !== c.site || value.owner?.toLowerCase() !== b.owner.toLowerCase() || value.repo?.toLowerCase() !== b.repo.toLowerCase() || typeof value.repositoryId !== "string" || !/^[1-9][0-9]{0,199}$/.test(value.repositoryId) || typeof value.issuesEnabled !== "boolean") fail8("INVALID_RESPONSE");
  return copy3(value);
}
function validateGithubReply(value, request, { now = Date.now() } = {}) {
  const input = inputShape(request);
  if (!object8(value) || value.v !== 1 || typeof value.ok !== "boolean") fail8("INVALID_RESPONSE");
  if (!value.ok) {
    const e = value.error;
    if (!exact6(value, ["v", "ok", "error"]) || !exact6(e, ["code", "message"], ["status", "retryAfterMs"]) || !text6(e.code, 80) || !text6(e.message, 512) || e.status !== void 0 && (!Number.isInteger(e.status) || e.status < 100 || e.status > 599) || e.retryAfterMs !== void 0 && (!Number.isFinite(e.retryAfterMs) || e.retryAfterMs < 0 || e.retryAfterMs > 864e5)) fail8("INVALID_RESPONSE");
    return copy3(value);
  }
  if (value.operation !== input.operation) fail8("INVALID_RESPONSE");
  if (input.operation === "probe") {
    if (!exact6(value, ["v", "ok", "operation", "connection", "probe"]) || stable3(profile(value.connection)) !== stable3(input.connection)) fail8("INVALID_RESPONSE");
    return { ...copy3(value), probe: validateProbe(value.probe, input) };
  }
  if (!exact6(value, input.operation === "issues" ? ["v", "ok", "operation", "snapshot", "progressHint"] : ["v", "ok", "operation", "snapshot"]) || input.operation === "issues" && (typeof value.progressHint !== "string" || utf8Bytes(value.progressHint) > 1024 || /[\u0000-\u001f\u007f]/.test(value.progressHint))) fail8("INVALID_RESPONSE");
  const source = input.operation === "issues" ? "github" : "github-pr", scope = trackerScope(source, input.connection, input.binding), validators = input.operation === "pulls" ? { validateItem: validatePullRequest, itemKey: pullIdentityKey } : {};
  let snapshot;
  try {
    snapshot = validateSnapshot(value.snapshot, scope, { ...validators, now });
  } catch {
    fail8("INVALID_RESPONSE");
  }
  if (input.operation === "pulls" && input.cursor?.startsWith("{")) {
    let cursor;
    try {
      cursor = JSON.parse(input.cursor);
    } catch {
      fail8("INVALID_RESPONSE");
    }
    if (snapshot.data.length !== 1 || snapshot.cursor || stable3(JSON.parse(prDetailCursor(snapshot.data[0]))) !== stable3(cursor)) fail8("INVALID_RESPONSE");
  }
  if (snapshot.error) {
    const safe = safeError(snapshot.error);
    snapshot.error = { ...snapshot.error, code: safe.code, message: safe.message };
  }
  return { ...copy3(value), snapshot };
}
var STALE_LOAD_MS = 9e4;
var HelperQueue = class {
  constructor({ clock = () => Date.now() } = {}) {
    this.clock = clock;
    this.holders = /* @__PURE__ */ new Set();
    this.waiters = [];
    this.tails = /* @__PURE__ */ new Map();
  }
  // An abandoned holder can never release, so its slot expires instead.
  active() {
    const now = this.clock();
    let total = 0;
    for (const holder of this.holders) if (now - holder.at >= STALE_LOAD_MS) this.holders.delete(holder);
    else total++;
    return total;
  }
  hold() {
    const holder = { at: this.clock() };
    this.holders.add(holder);
    return holder;
  }
  drain() {
    while (this.waiters.length && this.active() < 4) this.waiters.shift()(this.hold());
  }
  async acquire() {
    if (!this.waiters.length && this.active() < 4) return this.hold();
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      this.drain();
    });
  }
  release(holder) {
    if (this.holders.delete(holder)) this.drain();
  }
  run(key, current, work) {
    const tail = this.tails.get(key), previous = tail && this.clock() - tail.at < STALE_LOAD_MS ? tail.promise : null, promise = (async () => {
      if (previous) try {
        await previous;
      } catch {
      }
      if (!current()) fail8("REQUEST_CANCELLED");
      const holder = await this.acquire();
      try {
        if (!current()) fail8("REQUEST_CANCELLED");
        return await work();
      } finally {
        this.release(holder);
      }
    })();
    const record = { promise, at: this.clock() };
    this.tails.set(key, record);
    const cleanup = () => {
      if (this.tails.get(key) === record) this.tails.delete(key);
    };
    promise.then(cleanup, cleanup);
    return promise;
  }
};
var helperQueue = new HelperQueue();

// src/mods/mission-control-github/backend.mjs
var hash3 = (value) => createHash3("sha256").update(value).digest("base64url");
var object9 = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
var text7 = (value, max = 200) => typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
var fail9 = (code) => {
  throw new TrackerError(code);
};
function readListCursor(value, scope, operation) {
  if (!value) return void 0;
  if (operation === "pulls" && value.startsWith("{")) {
    let c2;
    try {
      c2 = JSON.parse(value);
    } catch {
      fail9("INVALID_SCOPE");
    }
    if (c2?.kind !== "pr-detail") fail9("INVALID_SCOPE");
    return value;
  }
  let c;
  try {
    if (!/^[-\w]+$/.test(value)) fail9("INVALID_SCOPE");
    c = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    fail9("INVALID_SCOPE");
  }
  if (!object9(c) || Object.keys(c).sort().join(",") !== "cursor,kind,operation,scope,v" || c.v !== 1 || c.kind !== "github-list" || c.operation !== operation || c.scope !== hash3(trackerScopeKey(scope)) || !text7(c.cursor, 8192)) fail9("INVALID_SCOPE");
  return c.cursor;
}
function writeListCursor(cursor, scope, operation) {
  const value = Buffer.from(JSON.stringify({ v: 1, kind: "github-list", operation, scope: hash3(trackerScopeKey(scope)), cursor })).toString("base64url");
  return value.length <= 8192 ? value : null;
}
var PROJECT_QUERY2 = `query MissionControlProjectFields($owner: String!, $number: Int!, $after: String) {
  repositoryOwner(login: $owner) {
    __typename login
    ... on User { projectV2(number: $number) { ...MissionControlProject } }
    ... on Organization { projectV2(number: $number) { ...MissionControlProject } }
  }
}
fragment MissionControlProject on ProjectV2 {
  id number owner { ... on User { login } ... on Organization { login } }
  fields(first: 100, after: $after) {
    totalCount pageInfo { hasNextPage endCursor }
    nodes {
      __typename
      ... on ProjectV2Field { id }
      ... on ProjectV2IterationField { id }
      ... on ProjectV2SingleSelectField { id name options { id name } }
    }
  }
}`;
async function projectFields(request, options) {
  let selected;
  try {
    selected = readGithubProjectFieldsCursor(request.cursor);
  } catch {
    fail9("INVALID_REQUEST");
  }
  const { env = process.env, ca, signal, ghCommand, request: transport = requestJson, timeoutMs = 18e3 } = options;
  if (typeof transport !== "function" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 25e3) fail9("INVALID_REQUEST");
  const deadline = Date.now() + timeoutMs, controller = new AbortController(), combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let calls = 0;
  const remaining = () => {
    const left = deadline - Date.now();
    if (left <= 0) fail9("REQUEST_TIMEOUT");
    return left;
  };
  const bounded = async (url, opts) => {
    if (++calls > 4) fail9("INCOMPLETE_RESULTS");
    try {
      return await transport(url, { ...opts, timeoutMs: Math.min(opts.timeoutMs ?? remaining(), remaining()), signal: combined, maxRedirects: 0, maxBytes: 4194304 });
    } catch (error) {
      if (error instanceof TrackerError && error.status === 403 && error.retryAfterMs !== void 0) throw new TrackerError("RATE_LIMITED", { status: 403, retryAfterMs: error.retryAfterMs });
      throw error;
    }
  };
  try {
    const repoRequest = { ...request };
    delete repoRequest.cursor;
    await probeGithubApi(repoRequest, { env, ca, signal: combined, ghCommand, request: bounded, timeoutMs: remaining(), concurrency: 1 });
    const auth2 = await resolveGithubAuth(request.connection, { env, ghCommand, signal: combined, timeoutMs: Math.min(8e3, remaining()) });
    const fields = [], ids = /* @__PURE__ */ new Set(), cursors = /* @__PURE__ */ new Set();
    let after = null, projectId, total;
    for (let page = 0; page < 3; page++) {
      const result = await bounded(auth2.graphqlUrl, { method: "POST", body: { query: PROJECT_QUERY2, variables: { owner: selected.owner, number: selected.number, after } }, headers: auth2.headers, allowedOrigin: auth2.allowedOrigin, metadata: true, ca, timeoutMs: remaining() });
      if (!object9(result) || result.url !== auth2.graphqlUrl || !object9(result.headers) || !Number.isInteger(result.status) || result.status < 200 || result.status >= 300) fail9("INVALID_RESPONSE");
      const response = result.data;
      if (!object9(response)) fail9("INVALID_RESPONSE");
      if (response.errors !== void 0) {
        if (!Array.isArray(response.errors) || response.errors.length > 100) fail9("INVALID_RESPONSE");
        if (response.errors.length) {
          const types = response.errors.map((e) => e?.type || e?.extensions?.type || e?.extensions?.code);
          fail9(types.includes("RATE_LIMITED") ? "RATE_LIMITED" : types.some((t) => ["FORBIDDEN", "NOT_FOUND", "UNAUTHORIZED", "INSUFFICIENT_SCOPES"].includes(t)) ? "PERMISSION_DENIED" : "INCOMPLETE_RESULTS");
        }
      }
      const owner = response.data?.repositoryOwner, project = owner?.projectV2;
      if (owner === null || project === null) fail9("PERMISSION_DENIED");
      if (!["User", "Organization"].includes(owner?.__typename) || owner.login?.toLowerCase() !== selected.owner.toLowerCase() || !text7(project?.id) || project.number !== selected.number || project.owner?.login?.toLowerCase() !== selected.owner.toLowerCase() || projectId && projectId !== project.id) fail9("INVALID_SCOPE");
      projectId = project.id;
      const values = project.fields;
      if (!object9(values) || !Array.isArray(values.nodes) || values.nodes.length > 100 || typeof values.pageInfo?.hasNextPage !== "boolean" || !Number.isSafeInteger(values.totalCount) || values.totalCount < 0) fail9("INVALID_RESPONSE");
      if (values.totalCount > 300 || total !== void 0 && total !== values.totalCount) fail9("INCOMPLETE_RESULTS");
      total = values.totalCount;
      for (const field of values.nodes) {
        if (field === null) fail9("PERMISSION_DENIED");
        if (!["ProjectV2Field", "ProjectV2IterationField", "ProjectV2SingleSelectField"].includes(field?.__typename) || !text7(field.id) || ids.has(field.id)) fail9("INCOMPLETE_RESULTS");
        ids.add(field.id);
        if (field.__typename !== "ProjectV2SingleSelectField") continue;
        if (!text7(field.name) || !Array.isArray(field.options)) fail9("INVALID_RESPONSE");
        if (field.options.length > 250) fail9("INCOMPLETE_RESULTS");
        const options2 = [], optionIds = /* @__PURE__ */ new Set();
        for (const option of field.options) {
          if (!text7(option?.id) || !text7(option.name) || optionIds.has(option.id)) fail9("INVALID_RESPONSE");
          optionIds.add(option.id);
          options2.push({ id: option.id, name: option.name });
        }
        fields.push({ id: field.id, name: field.name, options: options2 });
      }
      if (!values.pageInfo.hasNextPage) {
        if (ids.size !== total) fail9("INCOMPLETE_RESULTS");
        return { kind: "project-fields", site: request.connection.site, owner: selected.owner, number: selected.number, projectId, fields, complete: true };
      }
      if (!text7(values.pageInfo.endCursor, 8192) || cursors.has(values.pageInfo.endCursor) || ids.size >= total) fail9("INCOMPLETE_RESULTS");
      after = values.pageInfo.endCursor;
      cursors.add(after);
    }
    fail9("INCOMPLETE_RESULTS");
  } finally {
    controller.abort();
  }
}
async function dispatchGithub(input, options = {}) {
  try {
    const request = validateTrackerRequest(input, { connectionValidator: validateGithubConnection, source: "github" });
    request.binding = validateRepoBinding(request.binding);
    if (!request.binding.github) fail9("INVALID_REQUEST");
    const operation = request.operation, clock = options.clock || (() => Date.now());
    if (typeof clock !== "function") fail9("INVALID_REQUEST");
    const adapterOptions = { ...options.api || {}, ...options.env ? { env: options.env } : {}, clock, concurrency: 1 };
    const publicConnection = { ...input.connection, site: request.connection.site };
    if (operation === "probe") {
      const probe = request.cursor ? await projectFields(request, adapterOptions) : { kind: "repository", ...await probeGithubApi(request, adapterOptions) };
      return validateGithubReply({ v: 1, ok: true, operation, connection: publicConnection, probe }, { ...input, binding: request.binding }, { now: clock() });
    }
    const source = operation === "issues" ? "github" : "github-pr", requestedScope = trackerScope(source, input.connection, request.binding), canonicalScope = trackerScope(source, request.connection, request.binding);
    const cursor = readListCursor(input.cursor, requestedScope, operation), adapterRequest = { ...request };
    delete adapterRequest.cursor;
    if (cursor) adapterRequest.cursor = cursor;
    const validators = operation === "pulls" ? { validateItem: validatePullRequest, itemKey: pullIdentityKey } : {};
    const chunk = validateSnapshot(await (operation === "issues" ? fetchGithubIssues : fetchGithubPulls)(adapterRequest, adapterOptions), canonicalScope, { ...validators, now: clock() });
    const snapshot = { ...chunk, scope: requestedScope };
    delete snapshot.cursor;
    if (chunk.cursor) {
      const publicCursor = writeListCursor(chunk.cursor, requestedScope, operation);
      if (publicCursor) snapshot.cursor = publicCursor;
      else snapshot.error = { code: "RESPONSE_TOO_LARGE", message: new TrackerError("RESPONSE_TOO_LARGE").message };
    }
    return validateGithubReply({ v: 1, ok: true, operation, snapshot, ...operation === "issues" ? { progressHint: githubProgressHint(request.binding) } : {} }, { ...input, binding: request.binding }, { now: clock() });
  } catch (error) {
    const code = error instanceof TrackerModelError ? ["INVALID_SNAPSHOT", "INVALID_ISSUE"].includes(error.code) ? "INVALID_RESPONSE" : error.code === "INVALID_BINDING" ? "INVALID_SCOPE" : error.code : error?.name === "GithubDataError" ? ["INVALID_REQUEST", "INVALID_CONNECTION", "INVALID_SCOPE", "STATUS_MAPPING_REQUIRED"].includes(error.code) ? error.code : "INVALID_RESPONSE" : error?.name === "PullModelError" ? "INVALID_RESPONSE" : null;
    return { v: 1, ok: false, error: publicTrackerError(code ? new TrackerError(code) : error) };
  }
}
async function main(argv = process.argv.slice(2)) {
  let reply;
  try {
    if (argv.length !== 1 || Buffer.byteLength(argv[0]) > 65536) fail9("INVALID_REQUEST");
    reply = await dispatchGithub(JSON.parse(argv[0]));
  } catch {
    reply = { v: 1, ok: false, error: publicTrackerError(new TrackerError("INVALID_REQUEST")) };
  }
  let output = JSON.stringify(reply);
  if (Buffer.byteLength(output) > 8 * 1024 * 1024) output = JSON.stringify({ v: 1, ok: false, error: publicTrackerError(new TrackerError("RESPONSE_TOO_LARGE")) });
  process.stdout.write(output + "\n");
}
var executable = false;
try {
  executable = Boolean(process.argv[1]) && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
} catch {
}
if (executable) await main();
export {
  dispatchGithub,
  main
};
