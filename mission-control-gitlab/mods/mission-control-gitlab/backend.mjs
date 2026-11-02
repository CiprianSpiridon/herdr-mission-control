import { createRequire as __mcCreateRequire } from "node:module"; const require = __mcCreateRequire(import.meta.url);

// src/mods/mission-control-gitlab/backend.mjs
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { createHash as createHash3 } from "node:crypto";

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
import https from "node:https";
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
var exact = (value, required, optional2 = []) => object2(value) && required.every((k) => Object.hasOwn(value, k)) && Object.keys(value).every((k) => required.includes(k) || optional2.includes(k));
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
function auth(value, { optional: optional2 = false, basic = true } = {}) {
  if (value === void 0 && optional2) return;
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
function credential(env, ref) {
  const value = env[ref];
  if (!text(value, 16384)) fail2("AUTH_REQUIRED");
  return value;
}
function credentialHeaders(spec, env = process.env) {
  jsonData(spec, "INVALID_CONNECTION");
  auth(spec);
  const token = credential(env, spec.tokenEnv);
  if (spec.kind === "bearer") return { authorization: "Bearer " + token };
  const username = credential(env, spec.usernameEnv);
  if (username.includes(":")) fail2("AUTH_REQUIRED");
  return { authorization: "Basic " + Buffer.from(username + ":" + token, "utf8").toString("base64") };
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
async function requestJson(input, { allowedOrigin, headers = {}, method = "GET", body: body2, timeoutMs = 12e3, maxBytes = 1048576, ca, signal, metadata = false, maxRedirects = 3 } = {}) {
  const expected = origin(allowedOrigin);
  let url = httpsUrl(input);
  if (!object2(headers) || !["GET", "POST"].includes(method) || method === "GET" && body2 !== void 0 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3e4 || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 4194304 || typeof metadata !== "boolean" || !Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 3) fail2("INVALID_REQUEST");
  const requestHeaders = { accept: "application/json", "accept-encoding": "identity", "user-agent": "herdr-mission-control/0.1" };
  for (const [key, value] of Object.entries(headers)) {
    const name = key.toLowerCase();
    if (!["authorization", "accept", "content-type", "x-github-api-version", "user-agent"].includes(name) || !text(value, 32768)) fail2("INVALID_REQUEST");
    requestHeaders[name] = value;
  }
  let payload;
  if (body2 !== void 0) {
    try {
      payload = Buffer.from(JSON.stringify(body2), "utf8");
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
          if (metadata) for (const name of ["link", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset", "x-ratelimit-resource", "x-next-page"]) {
            const value = response.headers[name];
            if (value !== void 0) {
              if (!(name === "x-next-page" && value === "") && !text(value, name === "link" ? 8192 : 128)) {
                response.destroy();
                finish(new TrackerError("RESPONSE_TOO_LARGE"));
                return;
              }
              responseHeaders[name] = value;
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
var pageNumber = (value) => typeof value === "string" && /^[1-9][0-9]{0,5}$/.test(value) ? Number(value) : null;
function pageQuery(url, code) {
  const query = /* @__PURE__ */ new Map();
  for (const [key, value] of url.searchParams) {
    if (query.has(key)) fail2(code);
    query.set(key, value);
  }
  if (query.has("page") && pageNumber(query.get("page")) === null) fail2(code);
  return query;
}
function pageLinks(header, original, query) {
  if (!text(header, 8192)) fail2("INVALID_RESPONSE");
  const entry = /<([^<>\s]+)>((?:\s*;\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+\s*=\s*(?:"(?:[^"\\\r\n]|\\[\x20-\x7e])*"|[!#$%&'*+.^_`|~0-9A-Za-z-]+))*)\s*(,|$)/y;
  const parameter = /\s*;\s*([!#$%&'*+.^_`|~0-9A-Za-z-]+)\s*=\s*("(?:[^"\\\r\n]|\\[\x20-\x7e])*"|[!#$%&'*+.^_`|~0-9A-Za-z-]+)/gy;
  let position2 = 0, count = 0, next = null, hasNext = false;
  while (position2 < header.length) {
    while (header[position2] === " " || header[position2] === "	") position2++;
    entry.lastIndex = position2;
    const match = entry.exec(header);
    if (!match || ++count > 32) fail2("INVALID_RESPONSE");
    position2 = entry.lastIndex;
    if (match[3] === "," && position2 === header.length) fail2("INVALID_RESPONSE");
    const params = /* @__PURE__ */ new Map();
    parameter.lastIndex = 0;
    let param;
    while (param = parameter.exec(match[2])) {
      const name = param[1].toLowerCase(), value = param[2].startsWith('"') ? param[2].slice(1, -1).replace(/\\([\x20-\x7e])/g, "$1") : param[2];
      if (params.has(name) || name === "anchor") fail2("INVALID_RESPONSE");
      params.set(name, value);
    }
    const relations = params.get("rel")?.toLowerCase().split(/\s+/);
    if (!relations?.length || new Set(relations).size !== relations.length || relations.some((rel) => !["next", "prev", "first", "last"].includes(rel))) fail2("INVALID_RESPONSE");
    let target;
    try {
      target = httpsUrl(new URL(match[1], original).href);
    } catch {
      fail2("INVALID_RESPONSE");
    }
    if (target.origin !== original.origin || target.pathname !== original.pathname) fail2("INVALID_RESPONSE");
    const candidate = pageQuery(target, "INVALID_RESPONSE");
    if (!candidate.has("page") || candidate.size !== query.size + (query.has("page") ? 0 : 1)) fail2("INVALID_RESPONSE");
    for (const [key, value] of query) if (key !== "page" && candidate.get(key) !== value) fail2("INVALID_RESPONSE");
    const page = pageNumber(candidate.get("page"));
    if (relations.includes("next")) {
      if (hasNext || page <= (pageNumber(query.get("page")) ?? 1)) fail2("INVALID_RESPONSE");
      hasNext = true;
      next = page;
    }
  }
  if (!count) fail2("INVALID_RESPONSE");
  return next;
}
async function requestJsonPage(input, { requirePageHeader = false, ...options } = {}) {
  if (typeof requirePageHeader !== "boolean" || requirePageHeader && options.method !== void 0 && options.method !== "GET") fail2("INVALID_REQUEST");
  const original = httpsUrl(input), query = pageQuery(original, "INVALID_REQUEST"), current = pageNumber(query.get("page")) ?? 1;
  const result = await requestJson(original.href, { ...options, metadata: true, maxRedirects: 0 });
  if (requirePageHeader && (!Array.isArray(result.data) || result.data.length > 50)) fail2("INVALID_RESPONSE");
  const hasPage = Object.hasOwn(result.headers, "x-next-page"), hasLink = Object.hasOwn(result.headers, "link");
  let nextPage = null;
  if (hasPage) {
    const value = result.headers["x-next-page"];
    nextPage = value === "" ? null : pageNumber(value);
    if (value !== "" && (nextPage === null || nextPage <= current)) fail2("INVALID_RESPONSE");
  }
  if (hasLink) {
    const linked = pageLinks(result.headers.link, original, query);
    if (hasPage && linked !== nextPage) fail2("INVALID_RESPONSE");
    nextPage = linked;
  }
  if (!hasPage && !hasLink && requirePageHeader && result.data.length >= 50) fail2("INCOMPLETE_RESULTS");
  return { value: result.data, nextPage };
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
var exact2 = (v, required, optional2 = []) => object3(v) && required.every((k) => Object.hasOwn(v, k)) && Object.keys(v).every((k) => required.includes(k) || optional2.includes(k));
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
    const number = value.key.match(/^GL-([1-9][0-9]*)$/);
    if (!/^[1-9][0-9]*$/.test(i.id) || !number || value.url !== site + "/" + binding.gitlab.projectPath + "/-/issues/" + number[1]) fail3("INVALID_ISSUE");
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

// src/mods/mission-control-gitlab/auth.mjs
var object4 = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
var exact3 = (value, keys) => object4(value) && keys.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => keys.includes(key));
var fail4 = (code) => {
  throw new TrackerError(code);
};
var grants = /* @__PURE__ */ new WeakMap();
function gitlabEndpoints(site) {
  if (typeof site !== "string" || !/^https:\/\/[^/?#\\]+\/?$/i.test(site)) fail4("INVALID_URL");
  const url = httpsUrl(site, { originOnly: true });
  return { site: url.origin, apiBase: url.origin + "/api/v4" };
}
function validateGitlabConnection(input) {
  try {
    validateConfig({ v: 1, preferences: { gitlabConnection: input } });
  } catch {
    fail4("INVALID_CONNECTION");
  }
  if (!exact3(input, ["id", "kind", "site", "auth"]) || input.kind !== "api" || typeof input.id !== "string" || !/^[a-z][a-z0-9-]{0,95}$/.test(input.id) || ["constructor", "prototype"].includes(input.id) || !exact3(input.auth, ["kind", "tokenEnv"]) || input.auth.kind !== "bearer" || typeof input.auth.tokenEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(input.auth.tokenEnv)) fail4("INVALID_CONNECTION");
  return { id: input.id, kind: "api", site: gitlabEndpoints(input.site).site, auth: { kind: "bearer", tokenEnv: input.auth.tokenEnv } };
}
function resolveGitlabAuth(input, { env = process.env } = {}) {
  const connection = validateGitlabConnection(input), headers = credentialHeaders(connection.auth, env);
  if (!/^[\x21-\x7e]+$/.test(headers.authorization.slice(7))) fail4("AUTH_REQUIRED");
  const apiBase = connection.site + "/api/v4", descriptor = { connection, apiBase };
  grants.set(descriptor, { site: connection.site, apiBase, headers });
  return descriptor;
}
async function gitlabRequest(auth2, input, { requirePageHeader = false, timeoutMs = 12e3, maxBytes = 1048576, ca, signal } = {}) {
  const grant = grants.get(auth2);
  if (!grant) fail4("INVALID_CONNECTION");
  const url = httpsUrl(input);
  if (url.origin !== grant.site) fail4("UNTRUSTED_ORIGIN");
  if (url.pathname !== "/api/v4" && !url.pathname.startsWith("/api/v4/")) fail4("INVALID_URL");
  if ([...url.searchParams.keys()].some((key) => /^(?:access[-_]?token|private[-_]?token|api[-_]?(?:key|token)|token|auth|authorization|password|secret)$/i.test(key))) fail4("INVALID_URL");
  return requestJsonPage(url.href, { allowedOrigin: grant.site, headers: grant.headers, requirePageHeader, timeoutMs, maxBytes, ca, signal });
}

// src/mods/mission-control-gitlab/issues.mjs
import { createHash } from "node:crypto";
var PAGE_SIZE = 50;
var MAX_RECORDS = 1e3;
var MAX_OUTPUT = 7 * 1024 * 1024;
var MAX_AGE = 7 * 864e5;
var object5 = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
var text3 = (value, max = 512) => typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
var id3 = (value) => Number.isSafeInteger(value) && value > 0 ? String(value) : typeof value === "string" && /^[1-9][0-9]{0,199}$/.test(value) ? value : null;
var digest = (value) => createHash("sha256").update(value).digest("base64url");
var fail5 = (code) => {
  throw new TrackerError(code);
};
var safeError = (error) => {
  const { code, message, retryAfterMs } = publicTrackerError(error);
  return { code, message, ...retryAfterMs === void 0 ? {} : { retryAt: Date.now() + retryAfterMs } };
};
function bindingOf(value) {
  try {
    return validateRepoBinding(value);
  } catch (error) {
    fail5(error.code === "STATUS_MAPPING_REQUIRED" ? "STATUS_MAPPING_REQUIRED" : "INVALID_REQUEST");
  }
}
function gitlabReadContext({ env = process.env, ca, signal, timeoutMs = 25e3, clock = () => Date.now() } = {}) {
  if (typeof clock !== "function" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 25e3) fail5("INVALID_REQUEST");
  const started = clock();
  if (!Number.isFinite(started) || started < 0) fail5("INVALID_REQUEST");
  const wallDeadline = Date.now() + timeoutMs, deadline = started + timeoutMs, controller = new AbortController(), combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let active = 0;
  const waiting = [];
  const remaining = () => Math.floor(Math.min(wallDeadline - Date.now(), deadline - clock()));
  const check = () => {
    if (combined.aborted) fail5("REQUEST_CANCELLED");
    const left = remaining();
    if (left <= 0) fail5("REQUEST_TIMEOUT");
    return left;
  };
  return { clock, remaining, cancel: () => controller.abort(), auth: (connection) => resolveGitlabAuth(connection, { env }), async call(auth2, url, { list: list2 = false } = {}) {
    let acquired = false;
    try {
      check();
      while (active >= 4) {
        await new Promise((resolve) => waiting.push(resolve));
        check();
      }
      active++;
      acquired = true;
      return await gitlabRequest(auth2, url, { ca, signal: combined, requirePageHeader: list2, timeoutMs: check(), maxBytes: 4194304 });
    } finally {
      if (acquired) active--;
      waiting.shift()?.();
    }
  } };
}
function gitlabProjectUrl(auth2, binding) {
  return auth2.apiBase + "/projects/" + encodeURIComponent(binding.gitlab.projectPath);
}
async function readGitlabProject(auth2, binding, ctx) {
  const raw = (await ctx.call(auth2, gitlabProjectUrl(auth2, binding))).value;
  if (!object5(raw) || !id3(raw.id)) fail5("INVALID_RESPONSE");
  if (raw.path_with_namespace !== binding.gitlab.projectPath || raw.web_url !== auth2.connection.site + "/" + binding.gitlab.projectPath) fail5("INVALID_SCOPE");
  if (raw.issues_enabled !== void 0 && typeof raw.issues_enabled !== "boolean") fail5("INVALID_RESPONSE");
  return { projectId: id3(raw.id), projectPath: binding.gitlab.projectPath, issuesEnabled: raw.issues_enabled ?? null };
}
function gitlabProgressHint(binding) {
  const selected = bindingOf(binding).gitlab;
  if (!selected) fail5("INVALID_REQUEST");
  return selected.status?.labels.inProgress.length ? "" : "Open issues appear in To do. Configure In progress labels to show work underway.";
}
function bodyText(value) {
  if (value === void 0 || value === null) return "";
  if (typeof value !== "string") fail5("INVALID_RESPONSE");
  const clean = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, (char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"));
  if (Buffer.byteLength(clean) <= 48e3) return clean;
  let result = "", bytes = 0;
  for (const char of clean) {
    const size = Buffer.byteLength(char);
    if (bytes + size > 48e3) break;
    result += char;
    bytes += size;
  }
  return result + "\n[GitLab description truncated; open the issue for the full text.]";
}
function statusOf(raw, binding) {
  if (raw.state === "closed") return { statusGroup: "done", statusName: "Closed" };
  const mapping2 = binding.gitlab.status?.labels;
  if (mapping2) {
    const labels = new Map(raw.labels.map((label) => [label.toLowerCase(), label]));
    const matches = Object.entries(mapping2).filter(([, names]) => names.some((name) => labels.has(name.toLowerCase())));
    if (matches.length > 1) fail5("STATUS_MAPPING_REQUIRED");
    if (matches.length) {
      const [group, names] = matches[0];
      return { statusGroup: group, statusName: labels.get(names.find((name) => labels.has(name.toLowerCase())).toLowerCase()) };
    }
  }
  return { statusGroup: "todo", statusName: "Open" };
}
function issueRow(raw, connection, binding, projectId) {
  const iid = id3(raw?.iid);
  if (!object5(raw) || !id3(raw.id) || !iid || !Number.isSafeInteger(Number(iid)) || !text3(raw.title) || !["opened", "closed"].includes(raw.state) || raw.issue_type !== "issue" || !Array.isArray(raw.labels) || raw.labels.length > 100 || raw.labels.some((label) => !text3(label, 200))) fail5("INVALID_RESPONSE");
  const url = connection.site + "/" + binding.gitlab.projectPath + "/-/issues/" + iid;
  if (id3(raw.project_id) !== projectId || raw.web_url !== url) fail5("INVALID_SCOPE");
  const updatedAt = typeof raw.updated_at === "string" ? Date.parse(raw.updated_at) : NaN;
  if (!Number.isFinite(updatedAt) || updatedAt < 0) fail5("INVALID_RESPONSE");
  return { identity: { kind: "gitlab", connectionId: connection.id, site: connection.site, id: id3(raw.id) }, key: "GL-" + iid, title: raw.title, url, body: bodyText(raw.description), repoBinding: binding, updatedAt };
}
function cursorRead(value, scope, now) {
  if (!value) return null;
  let cursor;
  try {
    if (!/^[-\w]+$/.test(value)) fail5("INVALID_SCOPE");
    cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    fail5("INVALID_SCOPE");
  }
  if (!object5(cursor) || Object.keys(cursor).sort().join(",") !== "count,issuedAt,page,projectId,scope,seen,v" || cursor.v !== 1 || cursor.scope !== digest(trackerScopeKey(scope)) || !id3(cursor.projectId) || typeof cursor.projectId !== "string" || !Number.isInteger(cursor.page) || cursor.page < 1 || cursor.page > 999999 || !Number.isInteger(cursor.count) || cursor.count < 0 || cursor.count >= MAX_RECORDS || !Number.isFinite(cursor.issuedAt) || cursor.issuedAt < 0 || cursor.issuedAt > now + 5e3 || now - cursor.issuedAt >= MAX_AGE || !Array.isArray(cursor.seen) || cursor.seen.length > 64 || cursor.seen.some((value2) => typeof value2 !== "string" || !/^[-\w]{43}$/.test(value2)) || new Set(cursor.seen).size !== cursor.seen.length) fail5("INVALID_SCOPE");
  return cursor;
}
var cursorWrite = (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
async function fetchGitlabIssues(input, options = {}) {
  const request = validateTrackerRequest(input, { source: "gitlab", connectionValidator: validateGitlabConnection });
  if (request.operation !== "issues") fail5("INVALID_REQUEST");
  const binding = bindingOf(request.binding), scope = trackerScope("gitlab", request.connection, binding), ctx = gitlabReadContext(options), started = ctx.clock(), previous = cursorRead(request.cursor, scope, started);
  try {
    const auth2 = ctx.auth(request.connection), project = await readGitlabProject(auth2, binding, ctx);
    if (project.issuesEnabled === false) fail5("NOT_FOUND");
    if (previous && previous.projectId !== project.projectId) fail5("INVALID_SCOPE");
    const data = [], identities = /* @__PURE__ */ new Map(), numbers = /* @__PURE__ */ new Map(), seen = [...previous?.seen || []];
    let page = previous?.page || 1, count = previous?.count || 0, bytes = 0, truncated = false, cursor, error;
    const continuation = () => {
      truncated = true;
      cursor = cursorWrite({ v: 1, scope: digest(trackerScopeKey(scope)), projectId: project.projectId, page, count, seen, issuedAt: previous?.issuedAt ?? started });
    };
    while (true) {
      if (ctx.remaining() < 2e3) {
        continuation();
        break;
      }
      const url = new URL(gitlabProjectUrl(auth2, binding) + "/issues");
      for (const [key, value] of Object.entries({ state: "all", issue_type: "issue", per_page: PAGE_SIZE, order_by: "updated_at", sort: "desc", page })) url.searchParams.set(key, String(value));
      const response = await ctx.call(auth2, url.href, { list: true }), rows = response.value;
      const signature = rows.length ? digest(JSON.stringify(rows.map((row) => [id3(row?.id), id3(row?.iid)]))) : null;
      if (signature && seen.includes(signature)) fail5("INVALID_SCOPE");
      const additions = [], overLimit = rows.length > MAX_RECORDS - count;
      let pageBytes = 0, pageError;
      for (const raw of rows.slice(0, MAX_RECORDS - count)) {
        const base = issueRow(raw, auth2.connection, binding, project.projectId), identity = issueIdentityKey(base), iid = base.key;
        if (identities.has(identity) && identities.get(identity) !== iid || numbers.has(iid) && numbers.get(iid) !== identity) fail5("INVALID_SCOPE");
        const duplicate = identities.has(identity);
        identities.set(identity, iid);
        numbers.set(iid, identity);
        let row;
        try {
          row = validateIssue({ ...base, ...statusOf(raw, binding) }, { scope });
        } catch (cause) {
          if (cause instanceof TrackerError && cause.code === "STATUS_MAPPING_REQUIRED") {
            pageError = safeError(cause);
            continue;
          }
          if (cause instanceof TrackerError) throw cause;
          fail5("INVALID_RESPONSE");
        }
        if (!duplicate) {
          pageBytes += Buffer.byteLength(JSON.stringify(row));
          additions.push(row);
        }
      }
      if (bytes + pageBytes > MAX_OUTPUT) {
        error = safeError(new TrackerError("RESPONSE_TOO_LARGE"));
        continuation();
        break;
      }
      data.push(...additions);
      bytes += pageBytes;
      count += Math.min(rows.length, MAX_RECORDS - count);
      if (pageError) error = pageError;
      if (signature) {
        seen.push(signature);
        if (seen.length > 64) seen.shift();
      }
      if (response.nextPage === null) {
        if (overLimit) {
          truncated = true;
          error ??= safeError(new TrackerError("RESPONSE_TOO_LARGE"));
        }
        break;
      }
      if (count >= MAX_RECORDS) {
        truncated = true;
        error ??= safeError(new TrackerError("RESPONSE_TOO_LARGE"));
        break;
      }
      page = response.nextPage;
    }
    return validateSnapshot({ data, fetchedAt: ctx.clock(), scope, truncated, ...cursor ? { cursor } : {}, ...error ? { error } : {} }, scope, { now: ctx.clock() });
  } finally {
    ctx.cancel();
  }
}

// src/mods/mission-control-gitlab/merges.mjs
import { createHash as createHash2 } from "node:crypto";

// src/mods/mission-control-gitlab/merge-model.js
var object6 = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
var exact4 = (value, required, optional2 = []) => object6(value) && required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional2.includes(key));
var text4 = (value, max = 512) => typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
var decimal = (value) => typeof value === "string" && /^[1-9][0-9]{0,199}$/.test(value);
var positive = (value) => Number.isSafeInteger(value) && value > 0;
var sha = (value) => typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
var copy2 = (value) => JSON.parse(JSON.stringify(value));
var stable2 = (value) => Array.isArray(value) ? "[" + value.map(stable2).join(",") + "]" : object6(value) ? "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + stable2(value[key])).join(",") + "}" : JSON.stringify(value);
var plainBody = (value, max) => typeof value === "string" && utf8Bytes(value) <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value);
var reasons = {
  MR_LOCKED: "This merge request is locked.",
  FORK_READ_ONLY: "Review this fork in the bound checkout. Code-fix actions require the bound project.",
  NOT_LOADED: "Load merge-request details before starting this action.",
  BUDGET_EXHAUSTED: "Some details were deferred within the read budget. Reload this merge request.",
  APPROVALS_UNAVAILABLE: "Approval information is unavailable for this account.",
  REVIEW_UNAVAILABLE: "Review information is unavailable.",
  DISCUSSIONS_UNAVAILABLE: "Review discussions are unavailable for this account.",
  DISCUSSIONS_PARTIAL: "The complete discussion list is unavailable and no unresolved note was captured.",
  NO_ACTIONABLE_COMMENTS: "There are no captured unresolved review comments to address.",
  NO_PIPELINE: "No head pipeline has been reported.",
  PIPELINE_UNAVAILABLE: "The head pipeline is unavailable for this account.",
  PIPELINE_NOT_FAILED: "The reported head pipeline is not failing.",
  PIPELINE_CONTEXT_UNAVAILABLE: "Failed-pipeline identity is unavailable. Open the merge request and reload."
};
var mrReasonText = (reason) => Object.hasOwn(reasons, reason) ? reasons[reason] : "Reload this merge request before starting the action.";
var MergeModelError = class extends Error {
  constructor(code = "INVALID_MR", reason) {
    super(code === "MR_ACTION_UNAVAILABLE" ? mrReasonText(reason) : "The merge request or captured action changed. Reload its source.");
    this.name = "MergeModelError";
    this.code = code;
    if (reason) this.reason = reason;
  }
};
var fail6 = (code = "INVALID_MR") => {
  throw new MergeModelError(code);
};
function reference(value, head) {
  if (!exact4(value, head ? ["ref", "sha", "repoFullName"] : ["ref", "sha"]) || !text4(value.ref) || !(sha(value.sha) || !head && value.sha === null)) fail6();
  if (/[\s~^:?*\[\\]/.test(value.ref) || value.ref.includes("..") || value.ref.includes("@{") || value.ref.startsWith("/") || value.ref.endsWith("/") || value.ref.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"))) fail6();
  if (head && value.repoFullName !== null) {
    try {
      gitlabProjectPath(value.repoFullName);
    } catch {
      fail6();
    }
  }
}
function aggregate(value, states, allowed) {
  if (!exact4(value, ["state"], ["reason"]) || !states.includes(value.state)) fail6();
  if (value.state === "unavailable") {
    if (!allowed.includes(value.reason)) fail6();
  } else if (Object.hasOwn(value, "reason")) fail6();
}
function position(value) {
  if (value === null) return;
  if (!exact4(value, ["oldPath", "newPath", "oldLine", "newLine"])) fail6();
  for (const key of ["oldPath", "newPath"]) if (value[key] !== null && (!text4(value[key], 1024) || value[key].startsWith("/") || /^[A-Za-z]:/.test(value[key]) || value[key].includes("\\") || value[key].split("/").some((part) => !part || part === "." || part === ".."))) fail6();
  for (const key of ["oldLine", "newLine"]) if (value[key] !== null && !positive(value[key])) fail6();
}
function actionContext(value, merge) {
  if (!exact4(value, ["comments", "pipeline"]) || !exact4(value.comments, ["notes", "truncated"]) || typeof value.comments.truncated !== "boolean" || !Array.isArray(value.comments.notes) || value.comments.notes.length > 50 || utf8Bytes(JSON.stringify(value.comments.notes)) > 24e3) fail6();
  const seen = /* @__PURE__ */ new Set();
  for (const note of value.comments.notes) {
    if (!exact4(note, ["id", "body", "position"]) || !decimal(note.id) || !plainBody(note.body, 4e3) || !note.body.trim() || seen.has(note.id)) fail6();
    seen.add(note.id);
    position(note.position);
  }
  const d = merge.discussions;
  if (d.state === "unavailable" && (value.comments.notes.length || !value.comments.truncated) || d.state === "readable" && (value.comments.notes.length > d.unresolvedCount || !d.complete && !value.comments.truncated || !value.comments.truncated && value.comments.notes.length !== d.unresolvedCount)) fail6();
  const pipeline2 = value.pipeline;
  if (pipeline2 === null) return;
  const base = merge.identity.site + "/" + merge.identity.projectPath;
  if (!exact4(pipeline2, ["id", "url", "sha", "ref", "status", "jobs", "jobsUnavailable", "jobsTruncated"]) || !decimal(pipeline2.id) || pipeline2.url !== base + "/-/pipelines/" + pipeline2.id || !sha(pipeline2.sha) || !text4(pipeline2.ref) || pipeline2.status !== "failed" || merge.checks.state !== "failure" || !Array.isArray(pipeline2.jobs) || pipeline2.jobs.length > 50 || utf8Bytes(JSON.stringify(pipeline2.jobs)) > 12e3 || typeof pipeline2.jobsUnavailable !== "boolean" || typeof pipeline2.jobsTruncated !== "boolean" || pipeline2.jobsUnavailable && pipeline2.jobs.length) fail6();
  const jobs2 = /* @__PURE__ */ new Set();
  for (const job of pipeline2.jobs) {
    if (!exact4(job, ["id", "name", "stage", "url", "failureReason"]) || !decimal(job.id) || !text4(job.name, 256) || !text4(job.stage, 256) || job.url !== base + "/-/jobs/" + job.id || job.failureReason !== null && !text4(job.failureReason, 512) || jobs2.has(job.id)) fail6();
    jobs2.add(job.id);
  }
}
function validateMergeRequest(value, { scope } = {}) {
  if (!exact4(value, ["identity", "key", "title", "url", "body", "repoBinding", "state", "draft", "head", "base", "review", "discussions", "checks", "actionContext", "linkedIssues", "updatedAt"])) fail6();
  const i = value.identity;
  if (!exact4(i, ["kind", "connectionId", "site", "projectPath", "id", "number"]) || i.kind !== "gitlab-mr" || !text4(i.connectionId, 96) || !/^[a-z][a-z0-9-]*$/.test(i.connectionId) || !decimal(i.id) || !positive(i.number)) fail6();
  let binding, site;
  try {
    binding = validateRepoBinding(value.repoBinding);
    site = trackerOrigin(i.site);
    gitlabProjectPath(i.projectPath);
  } catch {
    fail6();
  }
  if (site !== i.site || binding.gitlab?.connectionId !== i.connectionId || binding.gitlab.projectPath !== i.projectPath || value.key !== "GL-MR-" + i.number || value.url !== site + "/" + i.projectPath + "/-/merge_requests/" + i.number || !text4(value.title) || !plainBody(value.body, 64e3) || !["open", "closed", "merged", "locked"].includes(value.state) || typeof value.draft !== "boolean" || !Number.isFinite(value.updatedAt) || value.updatedAt < 0 || value.updatedAt > 864e13) fail6();
  reference(value.head, true);
  reference(value.base, false);
  if (value.head.repoFullName !== null && value.head.repoFullName !== i.projectPath) fail6();
  aggregate(value.review, ["approved", "changesRequested", "reviewRequired", "unavailable"], ["NOT_LOADED", "BUDGET_EXHAUSTED", "APPROVALS_UNAVAILABLE", "REVIEW_UNAVAILABLE", "DISCUSSIONS_UNAVAILABLE", "DISCUSSIONS_PARTIAL"]);
  aggregate(value.checks, ["pending", "success", "failure", "unavailable"], ["NOT_LOADED", "BUDGET_EXHAUSTED", "NO_PIPELINE", "PIPELINE_UNAVAILABLE"]);
  const d = value.discussions;
  if (d?.state === "readable") {
    if (!exact4(d, ["state", "unresolvedCount", "complete"]) || !Number.isInteger(d.unresolvedCount) || d.unresolvedCount < 0 || d.unresolvedCount > 1e4 || typeof d.complete !== "boolean") fail6();
  } else if (!exact4(d, ["state", "reason"]) || d.state !== "unavailable" || !["NOT_LOADED", "BUDGET_EXHAUSTED", "DISCUSSIONS_UNAVAILABLE"].includes(d.reason)) fail6();
  if (["approved", "reviewRequired"].includes(value.review.state) && (d.state !== "readable" || !d.complete || d.unresolvedCount !== 0) || value.review.state === "changesRequested" && (d.state !== "readable" || d.unresolvedCount === 0)) fail6();
  actionContext(value.actionContext, value);
  if (!Array.isArray(value.linkedIssues) || value.linkedIssues.length > 50) fail6();
  const links = /* @__PURE__ */ new Set();
  for (const link of value.linkedIssues) {
    if (!exact4(link, ["kind", "id", "url"]) || link.kind !== "gitlab" || !decimal(link.id) || !text4(link.url, 4096) || !link.url.startsWith(site + "/")) fail6();
    const match = link.url.slice(site.length + 1).match(/^(.+)\/-\/issues\/([1-9][0-9]*)$/);
    try {
      if (!match) fail6();
      gitlabProjectPath(match[1]);
    } catch {
      fail6();
    }
    if (links.has(link.url)) fail6();
    links.add(link.url);
  }
  if (scope) {
    let s;
    try {
      s = validateTrackerScope(scope);
    } catch {
      fail6();
    }
    if (s.source !== "gitlab-mr" || s.connectionId !== i.connectionId || s.site !== site || s.machine !== binding.machine || s.repoRoot !== binding.repoRoot || stable2(s.selection) !== stable2(binding.gitlab)) fail6();
  }
  return { ...copy2(value), repoBinding: binding };
}
function mergeIdentityKey(value) {
  const m = validateMergeRequest(value), i = m.identity;
  return stable2([i.kind, i.connectionId, i.site, i.projectPath, i.id, i.number, m.repoBinding.machine, m.repoBinding.repoRoot]);
}

// src/mods/mission-control-gitlab/merges.mjs
var object7 = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
var exact5 = (value, keys) => object7(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
var text5 = (value, max = 512) => typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
var positive2 = (value) => Number.isSafeInteger(value) && value > 0;
var id4 = (value) => positive2(value) ? String(value) : typeof value === "string" && /^[1-9][0-9]{0,199}$/.test(value) ? value : null;
var sha2 = (value) => typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
var hash = (value) => createHash2("sha256").update(value).digest("base64url");
var fail7 = (code) => {
  throw new TrackerError(code);
};
var unavailable = (reason) => ({ state: "unavailable", reason });
var incomplete = () => ({ code: "INCOMPLETE_RESULTS", message: new TrackerError("INCOMPLETE_RESULTS").message });
var limited = () => ({ code: "RESPONSE_TOO_LARGE", message: new TrackerError("RESPONSE_TOO_LARGE").message });
var lower = (value) => typeof value === "string" ? value.toLowerCase() : value;
function plain(value) {
  if (value === null || value === void 0) return "";
  if (typeof value !== "string") fail7("INVALID_RESPONSE");
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, (char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"));
}
function clip(value, max) {
  let result = "", bytes = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char);
    if (bytes + size > max) break;
    result += char;
    bytes += size;
  }
  return result;
}
function body(value) {
  const clean = plain(value), marker = "\n[GitLab description truncated; open the merge request for the full text.]";
  return Buffer.byteLength(clean) > 48e3 ? clip(clean, 48e3 - Buffer.byteLength(marker)) + marker : clean;
}
function checked(value, scope) {
  try {
    return validateMergeRequest(value, { scope });
  } catch {
    fail7("INVALID_RESPONSE");
  }
}
function parse(raw, c, b, projectId, scope) {
  if (!object7(raw) || !id4(raw.id) || !positive2(raw.iid) || !text5(raw.title) || !["opened", "closed", "merged", "locked"].includes(raw.state) || !sha2(raw.sha) || raw.source_project_id !== null && !id4(raw.source_project_id)) fail7("INVALID_RESPONSE");
  if (id4(raw.project_id) !== projectId || raw.target_project_id !== void 0 && id4(raw.target_project_id) !== projectId || raw.web_url !== c.site + "/" + b.gitlab.projectPath + "/-/merge_requests/" + raw.iid) fail7("INVALID_SCOPE");
  const draft = Object.hasOwn(raw, "draft") ? raw.draft : raw.work_in_progress;
  if (typeof draft !== "boolean") fail7("INVALID_RESPONSE");
  const base = raw.diff_refs?.start_sha ?? raw.diff_refs?.base_sha ?? null;
  if (base !== null && !sha2(base)) fail7("INVALID_RESPONSE");
  if (raw.diff_refs?.head_sha !== void 0 && lower(raw.diff_refs.head_sha) !== lower(raw.sha)) fail7("INVALID_SCOPE");
  const updatedAt = typeof raw.updated_at === "string" ? Date.parse(raw.updated_at) : NaN;
  return checked({
    identity: { kind: "gitlab-mr", connectionId: c.id, site: c.site, projectPath: b.gitlab.projectPath, id: id4(raw.id), number: raw.iid },
    key: "GL-MR-" + raw.iid,
    title: raw.title,
    url: raw.web_url,
    body: body(raw.description),
    repoBinding: b,
    state: raw.state === "opened" ? "open" : raw.state,
    draft,
    head: { ref: raw.source_branch, sha: raw.sha, repoFullName: id4(raw.source_project_id) === projectId ? b.gitlab.projectPath : null },
    base: { ref: raw.target_branch, sha: base },
    review: unavailable("NOT_LOADED"),
    discussions: unavailable("NOT_LOADED"),
    checks: unavailable("NOT_LOADED"),
    actionContext: { comments: { notes: [], truncated: true }, pipeline: null },
    linkedIssues: [],
    updatedAt
  }, scope);
}
function cursorRead2(value, scope, now) {
  if (!value) return null;
  let c;
  try {
    c = value.startsWith("{") ? JSON.parse(value) : /^[-\w]+$/.test(value) ? JSON.parse(Buffer.from(value, "base64url").toString("utf8")) : null;
  } catch {
    fail7("INVALID_SCOPE");
  }
  if (c?.kind === "mr-detail") {
    const i = c.identity;
    if (!exact5(c, ["v", "kind", "identity", "machine", "repoRoot", "headSha", "baseSha"]) || c.v !== 1 || !exact5(i, ["kind", "connectionId", "site", "projectPath", "id", "number"]) || i.kind !== "gitlab-mr" || i.connectionId !== scope.connectionId || i.site !== scope.site || i.projectPath !== scope.selection.projectPath || typeof i.id !== "string" || !id4(i.id) || !positive2(i.number) || c.machine !== scope.machine || c.repoRoot !== scope.repoRoot || !sha2(c.headSha) || c.baseSha !== null && !sha2(c.baseSha)) fail7("INVALID_SCOPE");
    return c;
  }
  if (!exact5(c, ["v", "kind", "scope", "projectId", "page", "count", "seen", "issuedAt"]) || c.v !== 1 || c.kind !== "mr-list" || c.scope !== hash(trackerScopeKey(scope)) || typeof c.projectId !== "string" || !id4(c.projectId) || !positive2(c.page) || c.page > 999999 || !Number.isInteger(c.count) || c.count < 0 || c.count >= 1e3 || !Number.isFinite(c.issuedAt) || c.issuedAt < 0 || c.issuedAt > now + 5e3 || now - c.issuedAt >= 7 * 864e5 || !Array.isArray(c.seen) || c.seen.length > 64 || c.seen.some((value2) => typeof value2 !== "string" || !/^[-\w]{43}$/.test(value2)) || new Set(c.seen).size !== c.seen.length) fail7("INVALID_SCOPE");
  return c;
}
var cursorWrite2 = (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
async function optional(ctx, auth2, url, options) {
  if (ctx.remaining() < 2e3) return { unavailable: "BUDGET_EXHAUSTED" };
  try {
    return await ctx.call(auth2, url, options);
  } catch (error) {
    if (["AUTH_REQUIRED", "PERMISSION_DENIED", "NOT_FOUND", "INVALID_RESPONSE", "RESPONSE_TOO_LARGE"].includes(error.code)) return { unavailable: "UNAVAILABLE" };
    throw error;
  }
}
function notePosition(raw) {
  if (!object7(raw)) return null;
  const result = { oldPath: raw.old_path ?? null, newPath: raw.new_path ?? null, oldLine: raw.old_line ?? null, newLine: raw.new_line ?? null };
  for (const key of ["oldPath", "newPath"]) if (result[key] !== null && (!text5(result[key], 1024) || result[key].startsWith("/") || /^[A-Za-z]:/.test(result[key]) || result[key].includes("\\") || result[key].split("/").some((part) => !part || part === "." || part === ".."))) return null;
  for (const key of ["oldLine", "newLine"]) if (result[key] !== null && !positive2(result[key])) return null;
  return result;
}
function discussions(response) {
  const unknown = (reason) => ({ metadata: unavailable(reason), comments: { notes: [], truncated: true } });
  if (response.unavailable) return unknown(response.unavailable === "BUDGET_EXHAUSTED" ? "BUDGET_EXHAUSTED" : "DISCUSSIONS_UNAVAILABLE");
  const rows = response.value;
  if (!Array.isArray(rows) || rows.length > 100) return unknown("DISCUSSIONS_UNAVAILABLE");
  const notes = [], threads = /* @__PURE__ */ new Set(), seen = /* @__PURE__ */ new Set();
  let count = 0, truncated = rows.length === 100 || response.nextPage !== null;
  for (const thread of rows) {
    if (!text5(thread?.id, 200) || threads.has(thread.id) || !Array.isArray(thread.notes) || thread.notes.length > 100) return unknown("DISCUSSIONS_UNAVAILABLE");
    threads.add(thread.id);
    for (const raw of thread.notes) {
      if (!id4(raw?.id) || seen.has(id4(raw.id)) || typeof raw.resolvable !== "boolean" || raw.resolvable && typeof raw.resolved !== "boolean") return unknown("DISCUSSIONS_UNAVAILABLE");
      seen.add(id4(raw.id));
      if (!raw.resolvable || raw.resolved) continue;
      count++;
      if (typeof raw.body !== "string" || !raw.body.trim()) return unknown("DISCUSSIONS_UNAVAILABLE");
      const clean = plain(raw.body), marker = "\n[Comment text truncated.]", clipped = Buffer.byteLength(clean) > 4e3 ? clip(clean, 4e3 - Buffer.byteLength(marker)) + marker : clean;
      const note = { id: id4(raw.id), body: clipped, position: notePosition(raw.position) };
      if (notes.length >= 50 || Buffer.byteLength(JSON.stringify([...notes, note])) > 24e3) {
        truncated = true;
        continue;
      }
      if (clipped !== clean) truncated = true;
      notes.push(note);
    }
  }
  return { metadata: { state: "readable", unresolvedCount: count, complete: rows.length < 100 && response.nextPage === null }, comments: { notes, truncated } };
}
function pipeline(raw, m, projectId) {
  const value = raw.head_pipeline;
  if (value === null || value === void 0) return { checks: unavailable("NO_PIPELINE"), evidence: null };
  if (!object7(value)) return { checks: unavailable("PIPELINE_UNAVAILABLE"), evidence: null };
  const state = { success: "success", failed: "failure", running: "pending", pending: "pending" }[value.status];
  if (!state) return { checks: unavailable("PIPELINE_UNAVAILABLE"), evidence: null };
  const checks = { state };
  if (state !== "failure" || m.head.repoFullName === null) return { checks, evidence: null };
  if (value.project_id !== void 0 && id4(value.project_id) !== projectId) fail7("INVALID_SCOPE");
  const base = m.identity.site + "/" + m.identity.projectPath;
  if (!id4(value.id) || value.web_url !== base + "/-/pipelines/" + id4(value.id) || !sha2(value.sha) || !text5(value.ref)) return { checks, evidence: null };
  return { checks, evidence: { id: id4(value.id), url: value.web_url, sha: value.sha, ref: value.ref, status: "failed", jobs: [], jobsUnavailable: true, jobsTruncated: false } };
}
function jobs(response, evidence, m, projectId) {
  if (response.unavailable) return evidence;
  const rows = response.value;
  if (!Array.isArray(rows) || rows.length > 50) return evidence;
  const result = [], seen = /* @__PURE__ */ new Set();
  let truncated = rows.length === 50 || response.nextPage !== null;
  for (const raw of rows) {
    if (!id4(raw?.id) || raw.status !== "failed" || !text5(raw.name, 256) || !text5(raw.stage, 256) || raw.failure_reason !== void 0 && raw.failure_reason !== null && !text5(raw.failure_reason, 512)) return evidence;
    if (raw.pipeline !== void 0 && (!object7(raw.pipeline) || id4(raw.pipeline.id) !== evidence.id || raw.pipeline.project_id !== void 0 && id4(raw.pipeline.project_id) !== projectId || raw.pipeline.sha !== void 0 && lower(raw.pipeline.sha) !== lower(evidence.sha)) || raw.commit !== void 0 && lower(raw.commit?.id) !== lower(evidence.sha) || raw.web_url !== m.identity.site + "/" + m.identity.projectPath + "/-/jobs/" + id4(raw.id)) fail7("INVALID_SCOPE");
    if (seen.has(id4(raw.id))) return evidence;
    seen.add(id4(raw.id));
    const job = { id: id4(raw.id), name: raw.name, stage: raw.stage, url: raw.web_url, failureReason: raw.failure_reason ?? null };
    if (Buffer.byteLength(JSON.stringify([...result, job])) > 12e3) {
      truncated = true;
      continue;
    }
    result.push(job);
  }
  return { ...evidence, jobs: result, jobsUnavailable: false, jobsTruncated: truncated };
}
function review(approval, discussion, m, projectId) {
  if (approval.unavailable) return unavailable(approval.unavailable === "BUDGET_EXHAUSTED" ? "BUDGET_EXHAUSTED" : "APPROVALS_UNAVAILABLE");
  const raw = approval.value;
  if (!object7(raw) || typeof raw.approved !== "boolean") return unavailable("APPROVALS_UNAVAILABLE");
  for (const [key, wanted] of [["id", m.identity.id], ["iid", String(m.identity.number)], ["project_id", projectId]]) if (raw[key] !== void 0 && id4(raw[key]) !== wanted) fail7("INVALID_SCOPE");
  if (discussion.state === "unavailable") return unavailable(discussion.reason);
  if (discussion.unresolvedCount) return { state: "changesRequested" };
  if (!discussion.complete) return unavailable("DISCUSSIONS_PARTIAL");
  return { state: raw.approved ? "approved" : "reviewRequired" };
}
function closing(response, m) {
  if (response.unavailable) return { links: [], partial: true };
  const rows = response.value;
  if (!Array.isArray(rows) || rows.length > 50) return { links: [], partial: true };
  const links = [], seen = /* @__PURE__ */ new Set();
  let partial = rows.length === 50 || response.nextPage !== null;
  for (const raw of rows) {
    if (raw?.web_url === void 0) {
      partial = true;
      continue;
    }
    if (!id4(raw.id) || !positive2(raw.iid) || typeof raw.web_url !== "string" || !raw.web_url.startsWith(m.identity.site + "/") || !raw.web_url.endsWith("/-/issues/" + raw.iid)) fail7("INVALID_SCOPE");
    if (seen.has(raw.web_url)) continue;
    seen.add(raw.web_url);
    links.push({ kind: "gitlab", id: id4(raw.id), url: raw.web_url });
  }
  return { links, partial };
}
async function detail(selector, auth2, b, project, scope, ctx) {
  const base = gitlabProjectUrl(auth2, b) + "/merge_requests/" + selector.identity.number, raw = (await ctx.call(auth2, base)).value, m = parse(raw, auth2.connection, b, project.projectId, scope);
  if (m.identity.id !== selector.identity.id || m.identity.number !== selector.identity.number || lower(m.head.sha) !== lower(selector.headSha) || selector.baseSha !== null && lower(m.base.sha) !== lower(selector.baseSha)) fail7("INVALID_SCOPE");
  const p = pipeline(raw, m, project.projectId), [approval, discussion, issues] = await Promise.all([
    optional(ctx, auth2, base + "/approvals"),
    optional(ctx, auth2, base + "/discussions?per_page=100&page=1", { list: false }),
    optional(ctx, auth2, base + "/closes_issues?per_page=50&page=1", { list: false })
  ]);
  const d = discussions(discussion), linked = closing(issues, m);
  let evidence = p.evidence;
  if (evidence) {
    const url = new URL(gitlabProjectUrl(auth2, b) + "/pipelines/" + evidence.id + "/jobs");
    url.searchParams.set("scope[]", "failed");
    url.searchParams.set("per_page", "50");
    url.searchParams.set("page", "1");
    evidence = jobs(await optional(ctx, auth2, url.href, { list: false }), evidence, m, project.projectId);
  }
  return { merge: checked({ ...m, review: review(approval, d.metadata, m, project.projectId), discussions: d.metadata, checks: p.checks, actionContext: { comments: d.comments, pipeline: evidence }, linkedIssues: linked.links }, scope), ...linked.partial ? { error: incomplete() } : {} };
}
async function fetchGitlabMerges(input, options = {}) {
  const r = validateTrackerRequest(input, { source: "gitlab", connectionValidator: validateGitlabConnection });
  if (r.operation !== "merges") fail7("INVALID_REQUEST");
  let b;
  try {
    b = validateRepoBinding(r.binding);
  } catch {
    fail7("INVALID_REQUEST");
  }
  const scope = trackerScope("gitlab-mr", r.connection, b), ctx = gitlabReadContext(options), now = ctx.clock(), previous = cursorRead2(r.cursor, scope, now);
  const snapshot = (data, extras = {}) => validateSnapshot({ data, fetchedAt: ctx.clock(), scope, truncated: false, ...extras }, scope, { now: ctx.clock(), validateItem: validateMergeRequest, itemKey: mergeIdentityKey });
  try {
    const auth2 = ctx.auth(r.connection), project = await readGitlabProject(auth2, b, ctx);
    if (previous?.kind === "mr-detail") {
      const enriched = await detail(previous, auth2, b, project, scope, ctx);
      return snapshot([enriched.merge], enriched.error ? { error: enriched.error } : {});
    }
    if (previous && previous.projectId !== project.projectId) fail7("INVALID_SCOPE");
    const data = [], ids = /* @__PURE__ */ new Map(), numbers = /* @__PURE__ */ new Map(), seen = [...previous?.seen || []];
    let page = previous?.page || 1, count = previous?.count || 0, bytes = 0, truncated = false, cursor, error;
    const continuation = () => {
      truncated = true;
      cursor = cursorWrite2({ v: 1, kind: "mr-list", scope: hash(trackerScopeKey(scope)), projectId: project.projectId, page, count, seen, issuedAt: previous?.issuedAt ?? now });
    };
    while (true) {
      if (ctx.remaining() < 2e3) {
        continuation();
        break;
      }
      const url = new URL(gitlabProjectUrl(auth2, b) + "/merge_requests");
      for (const [key, value] of Object.entries({ state: "all", per_page: 50, page, order_by: "updated_at", sort: "desc" })) url.searchParams.set(key, String(value));
      const response = await ctx.call(auth2, url.href, { list: true }), rows = response.value, signature = rows.length ? hash(JSON.stringify(rows.map((row) => [id4(row?.id), row?.iid]))) : null;
      if (signature && seen.includes(signature)) fail7("INVALID_SCOPE");
      const additions = [], overLimit = rows.length > 1e3 - count;
      let pageBytes = 0;
      for (const raw of rows.slice(0, 1e3 - count)) {
        const m = parse(raw, auth2.connection, b, project.projectId, scope), old = ids.get(m.identity.id);
        if (old && old !== m.identity.number || numbers.has(m.identity.number) && numbers.get(m.identity.number) !== m.identity.id) fail7("INVALID_SCOPE");
        if (!old) {
          ids.set(m.identity.id, m.identity.number);
          numbers.set(m.identity.number, m.identity.id);
          pageBytes += Buffer.byteLength(JSON.stringify(m));
          additions.push(m);
        }
      }
      if (bytes + pageBytes > 7 * 1024 * 1024) {
        error = limited();
        continuation();
        break;
      }
      bytes += pageBytes;
      data.push(...additions);
      count += Math.min(rows.length, 1e3 - count);
      if (signature) {
        seen.push(signature);
        if (seen.length > 64) seen.shift();
      }
      if (response.nextPage === null) {
        if (overLimit) {
          truncated = true;
          error = limited();
        }
        break;
      }
      if (count >= 1e3) {
        truncated = true;
        error = limited();
        break;
      }
      page = response.nextPage;
    }
    return snapshot(data, { truncated, ...cursor ? { cursor } : {}, ...error ? { error } : {} });
  } finally {
    ctx.cancel();
  }
}

// src/mods/mission-control-gitlab/data.js
var copy3 = (value) => JSON.parse(JSON.stringify(value));
var object8 = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
var exact6 = (value, required, optional2 = []) => object8(value) && required.every((k) => Object.hasOwn(value, k)) && Object.keys(value).every((k) => required.includes(k) || optional2.includes(k));
var text6 = (value, max = 512) => typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
function stable3(value) {
  if (Array.isArray(value)) return "[" + value.map(stable3).join(",") + "]";
  if (object8(value)) return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + stable3(value[k])).join(",") + "}";
  return JSON.stringify(value);
}
var messages3 = { INVALID_REQUEST: "Check the GitLab profile and project fields.", INVALID_CONNECTION: "Check the HTTPS GitLab site and bearer credential reference.", INVALID_SCOPE: "This GitLab project or account changed. Reload its view.", INVALID_RESPONSE: "The GitLab helper returned an invalid or mismatched response.", INVALID_CONFIG: "Mission Control settings could not be read. The original file was preserved.", AUTH_REQUIRED: "The selected GitLab credentials are unavailable.", PERMISSION_DENIED: "The selected account cannot read this GitLab resource.", NOT_FOUND: "The selected GitLab resource was not found.", RATE_LIMITED: "GitLab reached its read limit. Retry after the reported delay.", STATUS_MAPPING_REQUIRED: "Choose unambiguous To do, In progress and Done labels.", CONNECTION_CONFLICT: "This profile is already used. Choose a new profile ID to change it.", CANONICAL_PROJECT_REQUIRED: "Use the canonical project path shown in setup, then save again.", REQUEST_TIMEOUT: "The GitLab read timed out. Retry this scope.", REQUEST_CANCELLED: "This GitLab operation was cancelled.", RESPONSE_TOO_LARGE: "The GitLab result exceeds its bounded size.", INCOMPLETE_RESULTS: "GitLab could not confirm a complete result. Narrow this scope and refresh.", UNTRUSTED_ORIGIN: "GitLab tried to leave the selected HTTPS origin.", INVALID_URL: "Use the selected HTTPS API origin without credentials or fragments.", HELPER_UNAVAILABLE: "The local GitLab helper could not run. Check that Node.js 22 or later is installed.", UPSTREAM_UNAVAILABLE: "GitLab is temporarily unavailable.", HTTP_ERROR: "GitLab rejected this read request.", REQUEST_FAILED: "GitLab could not be reached. Check this profile." };
var GitlabDataError = class extends Error {
  constructor(code, details = {}) {
    const safe = Object.hasOwn(messages3, code) ? code : "REQUEST_FAILED";
    super(messages3[safe]);
    this.name = "GitlabDataError";
    this.code = safe;
    if (Number.isFinite(details.retryAfterMs) && details.retryAfterMs >= 0) this.retryAfterMs = Math.min(details.retryAfterMs, 864e5);
  }
};
var fail8 = (code) => {
  throw new GitlabDataError(code);
};
var safeError2 = (e) => e instanceof GitlabDataError ? e : new GitlabDataError(["INVALID_MR", "INVALID_MR_ACTION", "INVALID_SNAPSHOT", "INVALID_ISSUE"].includes(e?.code) ? "INVALID_RESPONSE" : e?.code === "INVALID_BINDING" ? "INVALID_SCOPE" : ["INVALID_JSON", "UNSUPPORTED_VERSION", "CONFIG_PATH", "CONFIG_DIRECTORY"].includes(e?.code) ? "INVALID_CONFIG" : e?.code);
function profile(value) {
  if (!exact6(value, ["id", "kind", "site", "auth"]) || value.kind !== "api" || !text6(value.id, 96) || !/^[a-z][a-z0-9-]*$/.test(value.id) || ["constructor", "prototype"].includes(value.id) || !exact6(value.auth, ["kind", "tokenEnv"]) || value.auth.kind !== "bearer" || typeof value.auth.tokenEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value.auth.tokenEnv)) fail8("INVALID_CONNECTION");
  try {
    validateConfig({ v: 1, preferences: { gitlabProfile: value } });
    return { ...copy3(value), site: trackerOrigin(value.site) };
  } catch {
    fail8("INVALID_CONNECTION");
  }
}
function inputShape(input) {
  if (!exact6(input, ["v", "operation", "connection", "binding"], ["cursor"]) || input.v !== 1 || !["issues", "merges", "probe"].includes(input.operation) || input.cursor !== void 0 && input.cursor !== null && !text6(input.cursor, 8192)) fail8("INVALID_REQUEST");
  const connection = profile(input.connection), binding = validateRepoBinding(input.binding);
  if (binding.gitlab?.connectionId !== connection.id) fail8("INVALID_SCOPE");
  if (input.operation === "probe" && input.cursor) fail8("INVALID_REQUEST");
  if (input.cursor?.startsWith("{")) {
    if (input.operation !== "merges") fail8("INVALID_SCOPE");
    let c;
    try {
      c = JSON.parse(input.cursor);
    } catch {
      fail8("INVALID_SCOPE");
    }
    const i = c?.identity, sha3 = (value) => typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
    if (!exact6(c, ["v", "kind", "identity", "machine", "repoRoot", "headSha", "baseSha"]) || c.v !== 1 || c.kind !== "mr-detail" || !exact6(i, ["kind", "connectionId", "site", "projectPath", "id", "number"]) || i.kind !== "gitlab-mr" || i.connectionId !== connection.id || i.site !== connection.site || i.projectPath !== binding.gitlab.projectPath || typeof i.id !== "string" || !/^[1-9][0-9]{0,199}$/.test(i.id) || !Number.isSafeInteger(i.number) || i.number < 1 || c.machine !== binding.machine || c.repoRoot !== binding.repoRoot || !sha3(c.headSha) || c.baseSha !== null && !sha3(c.baseSha)) fail8("INVALID_SCOPE");
  }
  return { ...copy3(input), connection, binding };
}
function validateProbe(value, input) {
  if (!exact6(value, ["kind", "site", "projectPath", "projectId", "issuesEnabled", "canonical"]) || value.kind !== "project" || value.site !== input.connection.site || typeof value.projectId !== "string" || !/^[1-9][0-9]{0,199}$/.test(value.projectId) || ![true, false, null].includes(value.issuesEnabled) || typeof value.canonical !== "boolean") fail8("INVALID_RESPONSE");
  try {
    gitlabProjectPath(value.projectPath);
  } catch {
    fail8("INVALID_RESPONSE");
  }
  if (value.canonical !== (value.projectPath === input.binding.gitlab.projectPath)) fail8("INVALID_RESPONSE");
  return copy3(value);
}
function validateGitlabReply(value, request, { now = Date.now() } = {}) {
  const input = inputShape(request);
  if (!object8(value) || value.v !== 1 || typeof value.ok !== "boolean") fail8("INVALID_RESPONSE");
  if (!value.ok) {
    const e = value.error;
    if (!exact6(value, ["v", "ok", "error"]) || !exact6(e, ["code", "message"], ["status", "retryAfterMs"]) || !text6(e.code, 80) || !text6(e.message, 512) || e.status !== void 0 && (!Number.isInteger(e.status) || e.status < 100 || e.status > 599) || e.retryAfterMs !== void 0 && (!Number.isFinite(e.retryAfterMs) || e.retryAfterMs < 0 || e.retryAfterMs > 864e5)) fail8("INVALID_RESPONSE");
    const safe = new GitlabDataError(e.code, e);
    return { v: 1, ok: false, error: { code: safe.code, message: safe.message, ...e.status !== void 0 ? { status: e.status } : {}, ...safe.retryAfterMs !== void 0 ? { retryAfterMs: safe.retryAfterMs } : {} } };
  }
  if (value.operation !== input.operation) fail8("INVALID_RESPONSE");
  if (input.operation === "probe") {
    if (!exact6(value, ["v", "ok", "operation", "connection", "probe"]) || stable3(profile(value.connection)) !== stable3(input.connection)) fail8("INVALID_RESPONSE");
    return { ...copy3(value), probe: validateProbe(value.probe, input) };
  }
  if (!exact6(value, input.operation === "issues" ? ["v", "ok", "operation", "snapshot", "progressHint"] : ["v", "ok", "operation", "snapshot"]) || input.operation === "issues" && (typeof value.progressHint !== "string" || utf8Bytes(value.progressHint) > 1024 || /[\u0000-\u001f\u007f]/.test(value.progressHint))) fail8("INVALID_RESPONSE");
  const source = input.operation === "issues" ? "gitlab" : "gitlab-mr", scope = trackerScope(source, input.connection, input.binding), validators = input.operation === "merges" ? { validateItem: validateMergeRequest, itemKey: mergeIdentityKey } : {};
  let snapshot;
  try {
    snapshot = validateSnapshot(value.snapshot, scope, { ...validators, now });
  } catch {
    fail8("INVALID_RESPONSE");
  }
  if (input.operation === "merges" && input.cursor?.startsWith("{")) {
    let cursor;
    try {
      cursor = JSON.parse(input.cursor);
    } catch {
      fail8("INVALID_RESPONSE");
    }
    const item = snapshot.data[0];
    if (snapshot.data.length !== 1 || snapshot.cursor || cursor.v !== 1 || cursor.kind !== "mr-detail" || stable3(item.identity) !== stable3(cursor.identity) || item.repoBinding.machine !== cursor.machine || item.repoBinding.repoRoot !== cursor.repoRoot || item.head.sha.toLowerCase() !== String(cursor.headSha).toLowerCase() || cursor.baseSha !== null && item.base.sha?.toLowerCase() !== String(cursor.baseSha).toLowerCase()) fail8("INVALID_RESPONSE");
  }
  if (snapshot.error) {
    const safe = safeError2(snapshot.error);
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
    else total += holder.weight;
    return total;
  }
  hold(weight) {
    const holder = { weight, at: this.clock() };
    this.holders.add(holder);
    return holder;
  }
  drain() {
    while (this.waiters.length && this.active() + this.waiters[0].weight <= 4) {
      const next = this.waiters.shift();
      next.resolve(this.hold(next.weight));
    }
  }
  async acquire(weight) {
    if (!this.waiters.length && this.active() + weight <= 4) return this.hold(weight);
    return new Promise((resolve) => {
      this.waiters.push({ weight, resolve });
      this.drain();
    });
  }
  release(holder) {
    if (this.holders.delete(holder)) this.drain();
  }
  run(key, current, work, weight = 1) {
    const tail = this.tails.get(key), previous = tail && this.clock() - tail.at < STALE_LOAD_MS ? tail.promise : null, promise = (async () => {
      if (previous) try {
        await previous;
      } catch {
      }
      if (!current()) fail8("REQUEST_CANCELLED");
      const holder = await this.acquire(weight);
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

// src/mods/mission-control-gitlab/backend.mjs
var hash2 = (value) => createHash3("sha256").update(value).digest("base64url");
var object9 = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
var fail9 = (code) => {
  throw new TrackerError(code);
};
function readCursor(value, scope, operation) {
  if (!value) return void 0;
  if (operation === "merges" && value.startsWith("{")) {
    let selector;
    try {
      selector = JSON.parse(value);
    } catch {
      fail9("INVALID_SCOPE");
    }
    if (selector?.kind !== "mr-detail") fail9("INVALID_SCOPE");
    return value;
  }
  let cursor;
  try {
    if (!/^[-\w]+$/.test(value)) fail9("INVALID_SCOPE");
    cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    fail9("INVALID_SCOPE");
  }
  if (!object9(cursor) || Object.keys(cursor).sort().join(",") !== "cursor,kind,operation,scope,v" || cursor.v !== 1 || cursor.kind !== "gitlab-list" || cursor.operation !== operation || cursor.scope !== hash2(trackerScopeKey(scope)) || typeof cursor.cursor !== "string" || !cursor.cursor.length || cursor.cursor.length > 8192) fail9("INVALID_SCOPE");
  return cursor.cursor;
}
function writeCursor(value, scope, operation) {
  const cursor = Buffer.from(JSON.stringify({ v: 1, kind: "gitlab-list", operation, scope: hash2(trackerScopeKey(scope)), cursor: value }), "utf8").toString("base64url");
  return cursor.length <= 8192 ? cursor : null;
}
async function probeProject(request, options) {
  const ctx = gitlabReadContext(options);
  try {
    const auth2 = ctx.auth(request.connection), raw = (await ctx.call(auth2, gitlabProjectUrl(auth2, request.binding))).value;
    if (!object9(raw) || !(Number.isSafeInteger(raw.id) && raw.id > 0 || typeof raw.id === "string" && /^[1-9][0-9]{0,199}$/.test(raw.id))) fail9("INVALID_RESPONSE");
    let projectPath;
    try {
      projectPath = gitlabProjectPath(raw.path_with_namespace);
    } catch {
      fail9("INVALID_RESPONSE");
    }
    if (raw.web_url !== auth2.connection.site + "/" + projectPath) fail9("INVALID_SCOPE");
    if (raw.issues_enabled !== void 0 && typeof raw.issues_enabled !== "boolean") fail9("INVALID_RESPONSE");
    return { kind: "project", site: auth2.connection.site, projectPath, projectId: String(raw.id), issuesEnabled: raw.issues_enabled ?? null, canonical: projectPath === request.binding.gitlab.projectPath };
  } finally {
    ctx.cancel();
  }
}
async function dispatchGitlab(input, options = {}) {
  try {
    const request = validateTrackerRequest(input, { source: "gitlab", connectionValidator: validateGitlabConnection });
    request.binding = validateRepoBinding(request.binding);
    if (!request.binding.gitlab) fail9("INVALID_REQUEST");
    const operation = request.operation, clock = options.clock ?? (() => Date.now());
    if (typeof clock !== "function") fail9("INVALID_REQUEST");
    const adapterOptions = { ...options.api || {}, ...options.env ? { env: options.env } : {}, clock };
    if (operation === "probe") {
      if (request.cursor !== void 0 && request.cursor !== null) fail9("INVALID_REQUEST");
      return validateGitlabReply({ v: 1, ok: true, operation, connection: request.connection, probe: await probeProject(request, adapterOptions) }, input, { now: clock() });
    }
    const source = operation === "issues" ? "gitlab" : "gitlab-mr", requestedScope = trackerScope(source, input.connection, request.binding), canonicalScope = trackerScope(source, request.connection, request.binding), cursor = readCursor(input.cursor, requestedScope, operation);
    const adapterRequest = { ...request };
    delete adapterRequest.cursor;
    if (cursor) adapterRequest.cursor = cursor;
    const validators = operation === "merges" ? { validateItem: validateMergeRequest, itemKey: mergeIdentityKey } : {};
    const chunk = validateSnapshot(await (operation === "issues" ? fetchGitlabIssues : fetchGitlabMerges)(adapterRequest, adapterOptions), canonicalScope, { ...validators, now: clock() });
    const snapshot = { ...chunk, scope: requestedScope };
    delete snapshot.cursor;
    if (chunk.cursor) {
      const external = writeCursor(chunk.cursor, requestedScope, operation);
      if (external) snapshot.cursor = external;
      else snapshot.error = { code: "RESPONSE_TOO_LARGE", message: new TrackerError("RESPONSE_TOO_LARGE").message };
    }
    return validateGitlabReply({ v: 1, ok: true, operation, snapshot, ...operation === "issues" ? { progressHint: gitlabProgressHint(request.binding) } : {} }, input, { now: clock() });
  } catch (error) {
    const code = error instanceof TrackerModelError ? ["INVALID_SNAPSHOT", "INVALID_ISSUE"].includes(error.code) ? "INVALID_RESPONSE" : error.code === "INVALID_BINDING" ? "INVALID_SCOPE" : error.code : error?.name === "GitlabDataError" ? error.code : error?.name === "MergeModelError" ? "INVALID_RESPONSE" : null;
    return { v: 1, ok: false, error: publicTrackerError(code ? new TrackerError(code) : error) };
  }
}
async function main(argv = process.argv.slice(2)) {
  let reply;
  try {
    if (argv.length !== 1 || Buffer.byteLength(argv[0]) > 65536) fail9("INVALID_REQUEST");
    reply = await dispatchGitlab(JSON.parse(argv[0]));
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
  dispatchGitlab,
  main
};
