#!/usr/bin/env node
import { createRequire as __mcCreateRequire } from "node:module"; const require = __mcCreateRequire(import.meta.url);

// src/mods/mission-control-control-panel/backend.mjs
import fs7 from "node:fs/promises";
import path7 from "node:path";

// src/mods/mission-control-control-panel/source.mjs
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
var CATALOG_URLS = Object.freeze({
  mods: "https://assets.herdr.dev/mods/index.json",
  layouts: "https://assets.herdr.dev/layouts/index.json"
});
var CATALOG_TTL_MS = 60 * 60 * 1e3;
var CALL_BUDGET_MS = 2e4;
var MAX_FETCH_PASSES = 3;
var GITHUB = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/;
var SourceError = class extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SourceError";
    this.code = code;
  }
};
var fail = (code, message) => {
  throw new SourceError(code, message);
};
var recordsRoot = (appHome) => path.join(appHome, "mission-control", "control-panel");
function createSource({ appHome, env = process.env, fetchImpl = globalThis.fetch, now = () => Date.now(), git = "git" } = {}) {
  if (typeof appHome !== "string" || !path.isAbsolute(appHome)) fail("INVALID_APP_HOME", "An absolute Herdr app home is required.");
  const fixture = env.QA_MODS_FIXTURE === "1";
  const root = recordsRoot(appHome), cache = path.join(root, "cache");
  const gitEnv = { ...env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo", SSH_ASKPASS: "echo", GCM_INTERACTIVE: "never", LC_ALL: "C" };
  function remote(url) {
    if (typeof url !== "string") fail("INVALID_SOURCE", "A source repository URL is required.");
    const clean = url.replace(/\.git$/, "").replace(/\/$/, "");
    const m = GITHUB.exec(clean);
    if (m) return { url: clean + ".git", key: `${m[1]}__${m[2]}`.toLowerCase(), fullName: `${m[1]}/${m[2]}` };
    if (fixture && /^file:\/\/\//.test(url)) {
      const base = path.basename(url.replace(/^file:\/\//, "")).replace(/\.git$/, "");
      return { url, key: "fixture__" + base.toLowerCase().replace(/[^a-z0-9._-]/g, "_"), fullName: "fixture/" + base };
    }
    fail("UNSUPPORTED_SOURCE", "Only public github.com repositories are supported.");
  }
  function run2(args, { cwd, timeout = CALL_BUDGET_MS, maxBuffer = 16 * 1024 * 1024, encoding = "utf8" } = {}) {
    return new Promise((resolve) => {
      execFile(git, args, { cwd, env: gitEnv, timeout, maxBuffer, encoding, windowsHide: true }, (error, stdout, stderr) => {
        resolve({ code: error ? error.killed ? "TIMEOUT" : error.code ?? 1 : 0, stdout, stderr: String(stderr || "").slice(0, 2e3) });
      });
    });
  }
  async function readJson3(file) {
    try {
      return JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      return null;
    }
  }
  async function writeJson(file, value) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${now()}.tmp`);
    await fs.writeFile(tmp, JSON.stringify(value));
    await fs.rename(tmp, file);
  }
  async function catalog(kind, { force = false } = {}) {
    if (!["mods", "layouts"].includes(kind)) fail("INVALID_REQUEST", "Catalog kind must be mods or layouts.");
    const file = path.join(cache, `catalog-${kind}.json`), cached = await readJson3(file);
    if (kind === "layouts" && cached?.entries) for (const entry of cached.entries) entry.names = entry.names.map((n) => path.posix.basename(n).replace(/\.json$/, ""));
    if (!force && cached && now() - cached.fetchedAt < CATALOG_TTL_MS) return { ...cached, fresh: true };
    const url = fixture && env.QA_MODS_CATALOG_URL ? env.QA_MODS_CATALOG_URL.replace("{kind}", kind) : CATALOG_URLS[kind];
    try {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15e3);
      let response;
      try {
        response = fixture && url.startsWith("file:///") ? await fixtureFile(url) : await fetchImpl(url, { signal: controller.signal, headers: { accept: "application/json" } });
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) fail("CATALOG_UNAVAILABLE", `The herdr.dev catalog answered ${response.status}.`);
      const body = await response.json(), list = body?.[kind];
      if (!Array.isArray(list)) fail("CATALOG_INVALID", "The herdr.dev catalog has an unexpected shape.");
      const entries = list.map((entry) => normalize(kind, entry)).filter(Boolean);
      const value = { kind, fetchedAt: now(), generatedAt: body.generatedAt ?? null, entries };
      await writeJson(file, value);
      return { ...value, fresh: true };
    } catch (error) {
      if (cached) return { ...cached, fresh: false, reason: error.message || "The catalog could not be refreshed." };
      if (error instanceof SourceError) throw error;
      fail("CATALOG_UNAVAILABLE", "The herdr.dev catalog is unreachable.");
    }
  }
  async function fixtureFile(url) {
    try {
      const text = await fs.readFile(new URL(url), "utf8");
      return { ok: true, status: 200, json: async () => JSON.parse(text) };
    } catch {
      return { ok: false, status: 404, json: async () => null };
    }
  }
  function normalize(kind, e) {
    if (!e || typeof e !== "object" || typeof e.url !== "string" || typeof e.fullName !== "string") return null;
    const names = kind === "mods" ? e.modNames : e.layoutFiles;
    if (!Array.isArray(names)) return null;
    return {
      kind,
      owner: String(e.owner || ""),
      repo: String(e.repo || ""),
      fullName: e.fullName,
      url: e.url,
      defaultBranch: typeof e.defaultBranch === "string" && e.defaultBranch ? e.defaultBranch : "main",
      headCommit: typeof e.headCommit === "string" ? e.headCommit : null,
      path: typeof e.path === "string" ? e.path.replace(/^\/+|\/+$/g, "") : "",
      name: String(e.name || ""),
      stars: Number(e.stars) || 0,
      pushedAt: e.pushedAt ?? null,
      previewUrl: typeof e.previewUrl === "string" && (/^https:\/\/assets\.herdr\.dev\//.test(e.previewUrl) || fixture && /^file:\/\/\//.test(e.previewUrl)) ? e.previewUrl : null,
      names: names.filter((n) => typeof n === "string").map((n) => kind === "layouts" ? path.posix.basename(n).replace(/\.json$/, "") : n)
    };
  }
  const repoDir = (source) => path.join(cache, "repos", remote(source).key + ".git");
  const statusFile = (source) => repoDir(source) + ".status.json";
  async function ensure(source, { budgetMs = CALL_BUDGET_MS } = {}) {
    const { url } = remote(source), dir = repoDir(source), statusPath = statusFile(source);
    const status = await readJson3(statusPath) || { passes: 0 };
    if (status.state === "too-large") return { state: "too-large", reason: "The repository is too large or slow to fetch." };
    if (status.pid && alive(status.pid)) return { state: "pending", reason: "Still fetching this repository." };
    const exists = fsSync.existsSync(path.join(dir, "HEAD"));
    const args = exists ? ["--git-dir", dir, "fetch", "--quiet", "--filter=blob:none", "--prune", url, "+refs/heads/*:refs/heads/*"] : ["clone", "--quiet", "--bare", "--filter=blob:none", url, dir];
    await fs.mkdir(path.dirname(dir), { recursive: true });
    const result = await run2(args, { timeout: budgetMs });
    if (result.code === 0) {
      await writeJson(statusPath, { state: "ready", passes: 0, at: now() });
      return { state: "ready" };
    }
    if (result.code !== "TIMEOUT") {
      await writeJson(statusPath, { state: "unreachable", passes: status.passes || 0, at: now(), reason: summarize(result.stderr) });
      return { state: "unreachable", reason: summarize(result.stderr) };
    }
    const passes = (status.passes || 0) + 1;
    if (passes >= MAX_FETCH_PASSES) {
      await writeJson(statusPath, { state: "too-large", passes, at: now() });
      return { state: "too-large", reason: "The repository is too large or slow to fetch." };
    }
    if (!exists) await fs.rm(dir, { recursive: true, force: true });
    const child = spawn(git, args, { env: gitEnv, detached: true, stdio: "ignore" });
    child.unref();
    await writeJson(statusPath, { state: "pending", passes, pid: child.pid, at: now() });
    return { state: "pending", reason: "Still fetching this repository." };
  }
  async function log(source, { ref, paths: paths2, max = 40, since = null } = {}) {
    const dir = repoDir(source), args = ["--git-dir", dir, "log", "--format=%H%x09%ct%x09%s", `-n${Math.max(1, Math.min(max, 200))}`];
    if (since) args.push(`${since}..${ref}`);
    else args.push(ref);
    args.push("--", ...paths2?.length ? paths2 : ["."]);
    const r = await run2(args);
    if (r.code !== 0) fail("GIT_FAILED", "Reading the repository history failed: " + summarize(r.stderr));
    return r.stdout.split("\n").filter(Boolean).map((line) => {
      const [commit2, time, ...subject] = line.split("	");
      return { commit: commit2, time: Number(time) * 1e3, subject: subject.join("	") };
    });
  }
  async function tree(source, commit2, paths2 = []) {
    const r = await run2(["--git-dir", repoDir(source), "ls-tree", "-r", "--full-tree", commit2, "--", ...paths2]);
    if (r.code !== 0) fail("GIT_FAILED", "Reading the repository tree failed: " + summarize(r.stderr));
    return r.stdout.split("\n").filter(Boolean).map((line) => {
      const [meta, file] = line.split("	"), [mode, type, sha] = meta.split(" ");
      return { path: file, sha, mode, type };
    }).filter((e) => e.type === "blob");
  }
  async function blob(source, sha) {
    if (!/^[0-9a-f]{40}$/.test(sha)) fail("INVALID_REQUEST", "A full blob SHA is required.");
    const r = await run2(["--git-dir", repoDir(source), "cat-file", "blob", sha], { encoding: "buffer" });
    if (r.code !== 0) fail("GIT_FAILED", "Reading a file from the repository failed.");
    return r.stdout;
  }
  async function lsRemote(source, ref = "HEAD") {
    const r = await run2(["ls-remote", remote(source).url, ref]);
    if (r.code !== 0) return null;
    return r.stdout.split("\n").map((l) => l.split("	")[0]).find((s) => /^[0-9a-f]{40}$/.test(s)) || null;
  }
  return { catalog, ensure, log, tree, blob, lsRemote, remote, repoDir, root, fixture };
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function summarize(stderr) {
  return String(stderr || "").split("\n").map((s) => s.trim()).filter(Boolean).slice(-1)[0]?.replace(/https?:\/\/[^@\s]*@/g, "https://") || "unknown error";
}

// src/mods/mission-control-control-panel/store.mjs
import fs2 from "node:fs/promises";
import fsSync2 from "node:fs";
import path2 from "node:path";
import crypto from "node:crypto";
var LOCK_STALE_MS = 6e4;
var StoreError = class extends Error {
  constructor(code, message) {
    super(message);
    this.name = "StoreError";
    this.code = code;
  }
};
var fail2 = (code, message) => {
  throw new StoreError(code, message);
};
function createStore({ appHome, now = () => Date.now(), staleMs = LOCK_STALE_MS, lockWaitMs = 8e3 } = {}) {
  if (typeof appHome !== "string" || !path2.isAbsolute(appHome)) fail2("INVALID_APP_HOME", "An absolute Herdr app home is required.");
  const root = recordsRoot(appHome), tmpDir = path2.join(root, "tmp");
  const files = { packages: path2.join(root, "packages.json"), journal: path2.join(root, "journal.json"), log: path2.join(root, "log.jsonl"), lock: path2.join(root, "lock.json") };
  const inside = (target) => {
    const resolved = path2.resolve(target);
    if (resolved !== appHome && !resolved.startsWith(appHome + path2.sep)) fail2("OUTSIDE_APP_HOME", "Refusing to touch a path outside the Herdr app home.");
    return resolved;
  };
  const tempName = () => path2.join(tmpDir, `.${process.pid}-${crypto.randomBytes(6).toString("hex")}.tmp`);
  async function writeAtomic(target, data) {
    inside(target);
    await fs2.mkdir(tmpDir, { recursive: true });
    await fs2.mkdir(path2.dirname(target), { recursive: true });
    const tmp = tempName();
    await fs2.writeFile(tmp, data);
    const handle2 = await fs2.open(tmp, "r");
    try {
      await handle2.sync();
    } finally {
      await handle2.close();
    }
    await fs2.rename(tmp, target);
  }
  async function readJson3(file, fallback) {
    try {
      return JSON.parse(await fs2.readFile(file, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return fallback;
      fail2("INVALID_RECORD", `${path2.basename(file)} is unreadable.`);
    }
  }
  const writeJson = (file, value) => writeAtomic(file, JSON.stringify(value, null, 2) + "\n");
  const alive2 = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error.code === "EPERM";
    }
  };
  async function reclaim(judged) {
    const aside = `${files.lock}.${crypto.randomBytes(4).toString("hex")}.stale`;
    try {
      await fs2.rename(files.lock, aside);
    } catch {
      return;
    }
    const moved = await fs2.readFile(aside, "utf8").catch(() => null);
    if (moved !== judged) await fs2.link(aside, files.lock).catch(() => {
    });
    await fs2.rm(aside, { force: true });
  }
  async function withLock(fn) {
    await fs2.mkdir(root, { recursive: true });
    const deadline = Date.now() + lockWaitMs, token = `${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
    const mine = path2.join(root, `.lock-${token}`);
    await fs2.writeFile(mine, JSON.stringify({ pid: process.pid, at: now(), token }));
    try {
      for (; ; ) {
        try {
          await fs2.link(mine, files.lock);
          break;
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
        }
        let raw;
        try {
          raw = await fs2.readFile(files.lock, "utf8");
        } catch (error) {
          if (error.code === "ENOENT") continue;
          throw error;
        }
        let held = null;
        try {
          held = JSON.parse(raw);
        } catch {
        }
        if (!held || now() - held.at > staleMs || !alive2(held.pid)) {
          await reclaim(raw);
          continue;
        }
        if (Date.now() > deadline) fail2("LOCKED", "Another Mods manager operation is still running.");
        await new Promise((r) => setTimeout(r, 40));
      }
    } finally {
      await fs2.rm(mine, { force: true });
    }
    try {
      return await fn();
    } finally {
      const held = await readJson3(files.lock, null).catch(() => null);
      if (held?.token === token) await fs2.rm(files.lock, { force: true });
    }
  }
  const emptyPackages = () => ({ v: 1, packages: {} });
  async function readPackages() {
    return readJson3(files.packages, emptyPackages());
  }
  function updatePackages(mutate) {
    return withLock(async () => {
      const value = await readPackages();
      const next = await mutate(value) ?? value;
      await writeJson(files.packages, next);
      return next;
    });
  }
  async function log(entry) {
    await fs2.mkdir(root, { recursive: true });
    await fs2.appendFile(files.log, JSON.stringify({ at: now(), ...entry }) + "\n");
  }
  function commit2(ops, { label = "change", afterOp = null } = {}) {
    return withLock(async () => {
      if (fsSync2.existsSync(files.journal)) await rollback(await readJson3(files.journal, null));
      const id = `${now()}-${crypto.randomBytes(4).toString("hex")}`, backupDir = path2.join(root, "journal-backup", id);
      await fs2.mkdir(backupDir, { recursive: true });
      await fs2.mkdir(tmpDir, { recursive: true });
      const planned = [];
      for (const [index, op] of ops.entries()) {
        if (op.type === "write") {
          inside(op.target);
          const staged = path2.join(backupDir, `new-${index}`);
          await fs2.writeFile(staged, op.data);
          planned.push({ type: "write", target: op.target, staged, ...await snapshot(op.target, backupDir, index) });
        } else if (op.type === "delete") {
          inside(op.target);
          planned.push({ type: "delete", target: op.target, ...await snapshot(op.target, backupDir, index) });
        } else if (op.type === "move") {
          inside(op.from);
          inside(op.to);
          if (fsSync2.existsSync(op.to)) fail2("TARGET_EXISTS", `${path2.basename(op.to)} already exists.`);
          planned.push({ type: "move", from: op.from, to: op.to });
        } else fail2("INVALID_REQUEST", "Unknown file operation.");
      }
      const journal = { v: 1, id, label, state: "applying", backupDir, ops: planned };
      await writeJson(files.journal, journal);
      try {
        for (const [index, op] of planned.entries()) {
          if (op.type === "write") await writeAtomic(op.target, await fs2.readFile(op.staged));
          else if (op.type === "delete") await fs2.rm(op.target, { recursive: true, force: true });
          else {
            await fs2.mkdir(path2.dirname(op.to), { recursive: true });
            await fs2.rename(op.from, op.to);
          }
          if (afterOp) await afterOp(index);
        }
      } catch (error) {
        await rollback(journal);
        throw error;
      }
      await writeJson(files.journal, { ...journal, state: "complete" });
      await fs2.rm(files.journal, { force: true });
      await fs2.rm(backupDir, { recursive: true, force: true });
      await log({ event: "commit", label, ops: planned.length });
      return { id, ops: planned.length };
    });
  }
  async function snapshot(target, backupDir, index) {
    try {
      const info = await fs2.lstat(target);
      if (info.isDirectory()) {
        const backup3 = path2.join(backupDir, `old-${index}`);
        await fs2.cp(target, backup3, { recursive: true });
        return { backup: backup3, existed: "dir" };
      }
      const backup2 = path2.join(backupDir, `old-${index}`);
      await fs2.copyFile(target, backup2);
      return { backup: backup2, existed: "file" };
    } catch (error) {
      if (error.code === "ENOENT") return { backup: null, existed: false };
      throw error;
    }
  }
  async function rollback(journal) {
    if (!journal || !Array.isArray(journal.ops)) {
      await fs2.rm(files.journal, { force: true });
      return;
    }
    for (const op of [...journal.ops].reverse()) {
      if (op.type === "move") {
        if (!fsSync2.existsSync(op.from) && fsSync2.existsSync(op.to)) {
          await fs2.mkdir(path2.dirname(op.from), { recursive: true });
          await fs2.rename(op.to, op.from);
        }
        continue;
      }
      if (op.existed === "file") await writeAtomic(op.target, await fs2.readFile(op.backup));
      else if (op.existed === "dir") {
        await fs2.rm(op.target, { recursive: true, force: true });
        await fs2.cp(op.backup, op.target, { recursive: true });
      } else await fs2.rm(op.target, { recursive: true, force: true });
    }
    await fs2.rm(files.journal, { force: true });
    if (journal.backupDir) await fs2.rm(journal.backupDir, { recursive: true, force: true });
    await log({ event: "rollback", label: journal.label, ops: journal.ops.length });
  }
  function recover() {
    return withLock(async () => {
      const journal = await readJson3(files.journal, null);
      if (!journal) {
        await fs2.rm(tmpDir, { recursive: true, force: true });
        return { recovered: false };
      }
      if (journal.state === "complete") {
        await fs2.rm(files.journal, { force: true });
        if (journal.backupDir) await fs2.rm(journal.backupDir, { recursive: true, force: true });
        return { recovered: true, outcome: "completed", label: journal.label };
      }
      await rollback(journal);
      await fs2.rm(tmpDir, { recursive: true, force: true });
      return { recovered: true, outcome: "rolled-back", label: journal.label };
    });
  }
  return { root, files, withLock, readPackages, updatePackages, writeAtomic, writeJson, readJson: readJson3, commit: commit2, recover, log };
}

// src/mods/mission-control-control-panel/inventory.mjs
import fs3 from "node:fs/promises";
import path3 from "node:path";
import crypto2 from "node:crypto";
var SELF = "mission-control-control-panel";
var GENERATED = /(^|\/)(gpui-kit\.d\.ts|herdr\.d\.ts|jsconfig\.json|runtime\.json|\.DS_Store)$/;
var MAX_FILES = 500;
var MAX_FILE_BYTES = 8 * 1024 * 1024;
var gitBlobSha = (data) => crypto2.createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
async function readJson(file) {
  try {
    return JSON.parse(await fs3.readFile(file, "utf8"));
  } catch {
    return null;
  }
}
async function hashTree(dir) {
  const out = {};
  async function walk(current, rel) {
    let entries;
    try {
      entries = await fs3.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = rel ? `${rel}/${entry.name}` : entry.name, full = path3.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(full, relative);
        continue;
      }
      if (!entry.isFile() || GENERATED.test(relative)) continue;
      if (Object.keys(out).length >= MAX_FILES) return;
      const info = await fs3.stat(full);
      if (info.size > MAX_FILE_BYTES) continue;
      out[relative] = gitBlobSha(await fs3.readFile(full));
    }
  }
  await walk(dir, "");
  return out;
}
async function scan(appHome) {
  const records = recordsRoot(appHome);
  const shipped = new Set(Object.keys(await readJson(path3.join(appHome, "installed.json")) || {}));
  const manifest = (await readJson(path3.join(appHome, "mission-control", "installed-packages.json")))?.packages || {};
  const installer = /* @__PURE__ */ new Map();
  for (const [pkg, entry] of Object.entries(manifest)) {
    for (const name of entry?.mods || []) installer.set("mod:" + name, pkg);
    for (const name of entry?.layouts || []) installer.set("layout:" + String(name).replace(/\.json$/, ""), pkg);
  }
  const items = [];
  const classify = (kind, name, extra = {}) => {
    const key = `${kind}:${name}`;
    const shippedKey = kind === "mod" ? name : key;
    const origin = shipped.has(shippedKey) ? "builtin" : name === SELF && kind === "mod" ? "self" : installer.has(key) ? "installer" : extra.clonedFrom ? "clone" : "user";
    return { key, kind, name, origin, ...installer.has(key) ? { installerPackage: installer.get(key) } : {}, ...extra };
  };
  for (const [base, disabled] of [[path3.join(appHome, "mods"), false], [path3.join(records, "disabled", "mods"), true]]) {
    let names = [];
    try {
      names = (await fs3.readdir(base, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
    } catch {
    }
    for (const name of names.sort()) {
      const dir = path3.join(base, name), manifestJson = await readJson(path3.join(dir, "mod.json"));
      items.push(classify("mod", name, { dir, disabled, files: await hashTree(dir), clonedFrom: manifestJson?.cloned_from ?? null, title: typeof manifestJson?.title === "string" ? manifestJson.title : null }));
    }
  }
  for (const [base, disabled] of [[path3.join(appHome, "layouts"), false], [path3.join(records, "disabled", "layouts"), true]]) {
    let names = [];
    try {
      names = (await fs3.readdir(base)).filter((n) => n.endsWith(".json") && !n.startsWith("."));
    } catch {
    }
    for (const file of names.sort()) {
      const name = file.replace(/\.json$/, ""), full = path3.join(base, file), layout = await readJson(full);
      const files = { [file]: gitBlobSha(await fs3.readFile(full)) };
      try {
        files[name + ".svg"] = gitBlobSha(await fs3.readFile(path3.join(base, name + ".svg")));
      } catch {
      }
      items.push(classify("layout", name, { file: full, disabled, files, clonedFrom: layout?.cloned_from ?? null, mods: layoutMods(layout) }));
    }
  }
  return { items, shipped, installer };
}
function layoutMods(tree) {
  const found = /* @__PURE__ */ new Set();
  let seen = 0;
  (function walk(node) {
    if (!node || typeof node !== "object" || ++seen > 5e3) return;
    if (typeof node.content?.mod === "string") found.add(node.content.mod);
    if (typeof node.terminal_menu === "string") found.add(node.terminal_menu);
    if (typeof node.mod === "string") found.add(node.mod);
    for (const value of Object.values(node)) if (value && typeof value === "object") walk(value);
  })(tree);
  return [...found].sort();
}
function subtree(entry, item) {
  const base = entry.path ? entry.path + "/" : "";
  return item.kind === "mod" ? { prefix: `${base}mods/${item.name}/`, paths: [`${base}mods/${item.name}`], strip: `${base}mods/${item.name}/` } : { prefix: `${base}layouts/`, paths: [`${base}layouts/${item.name}.json`, `${base}layouts/${item.name}.svg`], strip: `${base}layouts/` };
}
function candidates(catalogs, item, { layoutsUsing: layoutsUsing2 = [] } = {}) {
  if (item.kind === "layout") return (catalogs.layouts?.entries || []).filter((entry) => entry.names.includes(item.name));
  return [
    ...(catalogs.mods?.entries || []).filter((entry) => entry.names.includes(item.name)),
    ...(catalogs.layouts?.entries || []).filter((entry) => entry.names.some((name) => layoutsUsing2.includes(name)))
  ];
}
async function adopt(source, catalogs, item, { previous = null, maxCommits = 40, layoutsUsing: layoutsUsing2 = [] } = {}) {
  const pool = candidates(catalogs, item, { layoutsUsing: layoutsUsing2 });
  if (!pool.length) return { state: "untracked", reason: "No herdr.dev entry publishes this name." };
  const results = [];
  for (const entry of pool) {
    const ready = await source.ensure(entry.url);
    if (ready.state !== "ready") {
      results.push({ entry, state: ready.state, reason: ready.reason });
      continue;
    }
    const scope = subtree(entry, item);
    let history;
    try {
      history = await source.log(entry.url, { ref: entry.defaultBranch, paths: scope.paths, max: maxCommits });
    } catch {
      continue;
    }
    if (!history.length) continue;
    let best = null;
    for (const commit2 of history) {
      const files = Object.fromEntries((await source.tree(entry.url, commit2.commit, scope.paths)).filter((f) => f.path.startsWith(scope.strip) && !GENERATED.test(f.path)).map((f) => [f.path.slice(scope.strip.length), f.sha]));
      if (!Object.keys(files).length) continue;
      const names = /* @__PURE__ */ new Set([...Object.keys(files), ...Object.keys(item.files)]);
      const equal = [...names].filter((n) => files[n] === item.files[n]).length;
      const candidate = { entry, commit: commit2.commit, time: commit2.time, subject: commit2.subject, files, equal, total: names.size, exact: equal === names.size };
      if (candidate.exact) {
        best = candidate;
        break;
      }
      if (!best || equal > best.equal) best = candidate;
    }
    if (best) results.push({ ...best, state: "found" });
  }
  const found = results.filter((r) => r.state === "found");
  if (!found.length) {
    const pending2 = results.find((r) => r.state === "pending" || r.state === "too-large" || r.state === "unreachable");
    return pending2 ? { state: pending2.state, reason: pending2.reason } : { state: "untracked", reason: "No published version matches this item." };
  }
  const exact = found.filter((r) => r.exact);
  const preferred = (matches) => {
    const recorded = matches.filter((r) => r.entry.fullName === previous?.source?.fullName && (previous.source.path === void 0 || r.entry.path === previous.source.path));
    if (recorded.length === 1) return recorded[0];
    const installed = matches.filter((r) => r.entry.path === item.installerPackage);
    return installed.length === 1 ? installed[0] : null;
  };
  let chosen = null;
  if (exact.length === 1) chosen = exact[0];
  else if (exact.length > 1) chosen = preferred(exact);
  else if (found.length === 1) chosen = found[0];
  else chosen = preferred(found);
  if (!chosen) return { state: "ambiguous", candidates: (exact.length ? exact : found).map((r) => ({ fullName: r.entry.fullName, path: r.entry.path, url: r.entry.url, defaultBranch: r.entry.defaultBranch, exact: r.exact })) };
  const edited = [.../* @__PURE__ */ new Set([...Object.keys(chosen.files), ...Object.keys(item.files)])].filter((n) => chosen.files[n] !== item.files[n]).sort();
  return {
    state: edited.length ? "edited" : "current",
    source: { url: chosen.entry.url, fullName: chosen.entry.fullName, path: chosen.entry.path, defaultBranch: chosen.entry.defaultBranch, previewUrl: chosen.entry.previewUrl ?? null },
    commit: chosen.commit,
    commitTime: chosen.time,
    subject: chosen.subject,
    base: chosen.files,
    edited
  };
}

// src/mods/mission-control-control-panel/updates.mjs
import crypto3 from "node:crypto";
function itemKeys(snippet, { kind, name }, { single = false } = {}) {
  const out = {};
  if (!snippet || typeof snippet !== "object" || Array.isArray(snippet)) return out;
  for (const [section, map] of Object.entries(snippet)) {
    if (!map || typeof map !== "object" || Array.isArray(map)) continue;
    const own = single || section === `${kind}:${name}`;
    for (const [key, action] of Object.entries(map)) {
      if (typeof action !== "string") continue;
      if (own || kind === "mod" && (action.startsWith(name + ".") || action.startsWith(name + ":"))) (out[section] ??= {})[key] = action;
    }
  }
  return out;
}
function keysDigest(keys) {
  const flat = Object.entries(keys || {}).flatMap(([section, map]) => Object.entries(map).map(([key, action]) => `${section}\0${key}\0${action}`)).sort();
  return flat.length ? crypto3.createHash("sha256").update(flat.join("\n")).digest("hex") : null;
}
async function checkItem(source, catalogs, record) {
  const entry = record.linked ? null : findEntry(catalogs, record);
  let head = entry?.headCommit ?? null, remoteHead = record.remoteHead ?? null;
  if (record.linked) {
    remoteHead = await source.lsRemote(record.source.url, `refs/heads/${record.source.defaultBranch}`);
    if (!remoteHead) return { state: "unreachable", reason: "The linked repository could not be reached.", remoteHead: record.remoteHead ?? null };
    if (remoteHead === record.remoteHead && record.lastResult) return { ...record.lastResult, remoteHead };
  } else if (head && head === record.headCommit && record.lastResult) {
    return { ...record.lastResult, headCommit: head };
  }
  const ready = await source.ensure(record.source.url);
  if (ready.state !== "ready") return { state: ready.state, reason: ready.reason, headCommit: record.headCommit ?? null, remoteHead: record.remoteHead ?? null };
  const scope = subtree({ path: record.source.path }, { kind: record.kind, name: record.name });
  const keysPath = (record.source.path ? record.source.path + "/" : "") + "keys.json";
  const [newest] = await source.log(record.source.url, { ref: record.source.defaultBranch, paths: [...scope.paths, keysPath], max: 1 });
  if (!newest || newest.commit === record.commit) return { state: "current", headCommit: head, remoteHead };
  const files = Object.fromEntries((await source.tree(record.source.url, newest.commit, scope.paths)).filter((f) => f.path.startsWith(scope.strip) && !GENERATED.test(f.path)).map((f) => [f.path.slice(scope.strip.length), f.sha]));
  const single = !entry || (entry.names?.length ?? 1) <= 1;
  const keysAt = async (commit2) => {
    const sha = (await source.tree(record.source.url, commit2, [keysPath])).find((f) => f.path === keysPath)?.sha ?? null;
    if (!sha) return {};
    try {
      return itemKeys(JSON.parse((await source.blob(record.source.url, sha)).toString("utf8")), record, { single });
    } catch {
      return {};
    }
  };
  const keys = await keysAt(newest.commit), digest = keysDigest(keys);
  const baseDigest = "keysDigest" in record ? record.keysDigest : keysDigest(await keysAt(record.commit));
  const base = record.base || {};
  const added = Object.keys(files).filter((f) => !(f in base)).sort();
  const removed = Object.keys(base).filter((f) => !(f in files)).sort();
  const changed = Object.keys(files).filter((f) => f in base && base[f] !== files[f]).sort();
  const keysChanged = digest !== baseDigest;
  if (!added.length && !removed.length && !changed.length && !keysChanged) return { state: "current", headCommit: head, remoteHead };
  return { state: "update", headCommit: head, remoteHead, update: { commit: newest.commit, time: newest.time, subject: newest.subject, files, keys, keysDigest: digest, keysChanged, added, changed, removed } };
}
function findEntry(catalogs, record) {
  const pool = [...catalogs.mods?.entries || [], ...catalogs.layouts?.entries || []];
  return pool.find((e) => e.fullName === record.source?.fullName && e.path === record.source?.path) || null;
}

// src/mods/mission-control-control-panel/apply.mjs
import fs4 from "node:fs/promises";
import path4 from "node:path";
import os from "node:os";
import crypto4 from "node:crypto";
import { execFile as execFile2 } from "node:child_process";
var BACKUPS_KEPT = 3;
var ApplyError = class extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = "ApplyError";
    this.code = code;
    if (detail) this.detail = detail;
  }
};
var fail3 = (code, message, detail) => {
  throw new ApplyError(code, message, detail);
};
var run = (file, args, opts = {}) => new Promise((resolve) => execFile2(file, args, { timeout: 2e4, maxBuffer: 8 * 1024 * 1024, ...opts }, (error, stdout, stderr) => resolve({ code: error ? error.killed ? "TIMEOUT" : error.code ?? 1 : 0, stdout: String(stdout || ""), stderr: String(stderr || "") })));
var isBinary = (buffer) => buffer.subarray(0, 8e3).includes(0);
var installedDir = (appHome, record) => record.kind === "mod" ? path4.join(appHome, "mods", record.name) : path4.join(appHome, "layouts");
function disclose(texts) {
  const hosts = /* @__PURE__ */ new Set(), programs = /* @__PURE__ */ new Set();
  let files = false;
  for (const text of texts) {
    for (const m of text.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) hosts.add(m[1].toLowerCase());
    for (const m of text.matchAll(/\bexec(?:Sync|File)?\s*\(\s*['"`]([A-Za-z0-9_./-]{1,80})['"`]/g)) programs.add(m[1]);
    for (const m of text.matchAll(/\bspawn(?:Sync)?\s*\(\s*['"`]([A-Za-z0-9_./-]{1,80})['"`]/g)) programs.add(m[1]);
    if (/\b(readTextFile|writeTextFile|appHome\s*\(|homedir\s*\(|fs\.(read|write|rm|unlink|rename))/.test(text)) files = true;
  }
  return { hosts: [...hosts].sort(), programs: [...programs].sort(), files };
}
function newAccess(before, after) {
  return { hosts: after.hosts.filter((h) => !before.hosts.includes(h)), programs: after.programs.filter((p) => !before.programs.includes(p)), files: after.files && !before.files };
}
function planKeys(userKeys, snippet, owned = []) {
  const user = JSON.parse(JSON.stringify(userKeys || {})), add = [], clash = [], remove = [], keep = [];
  const want = [];
  for (const [section, map] of Object.entries(snippet || {})) for (const [key, action] of Object.entries(map || {})) if (typeof action === "string") want.push({ section, key, action });
  for (const w of want) {
    const current = user[w.section]?.[w.key];
    if (current === void 0) {
      add.push(w);
      (user[w.section] ??= {})[w.key] = w.action;
    } else if (current === w.action) keep.push(w);
    else if (owned.some((o) => o.section === w.section && o.key === w.key && o.action === current)) {
      add.push(w);
      user[w.section][w.key] = w.action;
    } else clash.push({ ...w, current });
  }
  for (const o of owned) {
    if (want.some((w) => w.section === o.section && w.key === o.key)) continue;
    if (user[o.section]?.[o.key] === o.action) {
      remove.push(o);
      delete user[o.section][o.key];
      if (!Object.keys(user[o.section]).length) delete user[o.section];
    }
  }
  const nowOwned = [...owned.filter((o) => !remove.some((r) => r.section === o.section && r.key === o.key) && !add.some((a) => a.section === o.section && a.key === o.key)), ...add];
  return { add, clash, remove, keep, keys: user, owned: nowOwned, changed: add.length > 0 || remove.length > 0 };
}
async function prepare({ appHome, source, record, update, resolutions = {}, herdrApp = "herdr-app", env = process.env, currentKeys }) {
  const records = recordsRoot(appHome), stageRoot = path4.join(records, "stage", `${record.kind}-${record.name}`);
  const base = record.base || {}, upstream = update.files || {}, dir = installedDir(appHome, record);
  const localFiles = record.kind === "mod" ? await listFiles(dir) : Object.keys(base).concat(Object.keys(upstream)).filter((v, i, a) => a.indexOf(v) === i);
  const local = {};
  for (const rel of localFiles) {
    try {
      local[rel] = await fs4.readFile(path4.join(dir, rel));
    } catch {
    }
  }
  const localSha = Object.fromEntries(Object.entries(local).map(([rel, data]) => [rel, gitBlobSha(data)]));
  const blob = (sha) => source.blob(record.source.url, sha);
  const writes = {}, deletes = [], conflicts = [], keptEdited = [];
  await fs4.rm(stageRoot, { recursive: true, force: true });
  await fs4.mkdir(stageRoot, { recursive: true });
  for (const rel of [.../* @__PURE__ */ new Set([...Object.keys(upstream), ...Object.keys(base)])].sort()) {
    if (GENERATED.test(rel)) continue;
    const b = base[rel], u = upstream[rel], l = localSha[rel];
    if (u && l === u) continue;
    if (!u) {
      if (l === void 0) continue;
      if (l === b) deletes.push(rel);
      else keptEdited.push(rel);
      continue;
    }
    if (l === void 0 || l === b) {
      writes[rel] = await blob(u);
      continue;
    }
    if (u === b) continue;
    const choice = resolutions[rel];
    if (choice === "mine") continue;
    if (choice === "theirs") {
      writes[rel] = await blob(u);
      continue;
    }
    const theirs = await blob(u), baseData = b ? await blob(b) : Buffer.alloc(0);
    if (isBinary(local[rel]) || isBinary(theirs) || isBinary(baseData)) {
      conflicts.push({ file: rel, binary: true });
      continue;
    }
    const merged = await merge(stageRoot, rel, local[rel], baseData, theirs);
    if (merged.conflict) conflicts.push({ file: rel, binary: false, merged: merged.path });
    else writes[rel] = merged.data;
  }
  let keys = null;
  if (Object.keys(update.keys || {}).length || record.keys?.length) {
    const snippet = update.keys || {};
    let userKeys = currentKeys;
    if (userKeys === void 0) {
      userKeys = {};
      try {
        userKeys = JSON.parse(await fs4.readFile(path4.join(appHome, "keys.json"), "utf8"));
      } catch {
      }
    }
    keys = planKeys(userKeys, snippet, record.keys || []);
  }
  const before = disclose(Object.values(local).filter((d) => !isBinary(d)).map((d) => d.toString("utf8")));
  const afterTexts = { ...Object.fromEntries(Object.entries(local).map(([rel, d]) => [rel, d])), ...writes };
  for (const rel of deletes) delete afterTexts[rel];
  const after = disclose(Object.values(afterTexts).filter((d) => !isBinary(d)).map((d) => d.toString("utf8")));
  const review = {
    commit: update.commit,
    subject: update.subject,
    time: update.time,
    changed: Object.keys(writes).sort(),
    removed: deletes.sort(),
    keptEdited,
    conflicts,
    access: newAccess(before, after),
    keys: keys ? { add: keys.add, remove: keys.remove, clash: keys.clash } : null
  };
  if (conflicts.length) {
    const conflictDir = path4.join(records, "conflicts", `${record.kind}-${record.name}`);
    await fs4.rm(conflictDir, { recursive: true, force: true });
    for (const c of conflicts.filter((c2) => c2.merged)) {
      await fs4.mkdir(path4.dirname(path4.join(conflictDir, c.file)), { recursive: true });
      await fs4.copyFile(c.merged, path4.join(conflictDir, c.file));
    }
    return { ok: false, state: "conflict", conflicts: conflicts.map((c) => ({ file: c.file, binary: c.binary })), conflictDir, review };
  }
  if (record.kind === "mod") {
    const staged = path4.join(stageRoot, record.name);
    await fs4.mkdir(staged, { recursive: true });
    for (const [rel, data] of Object.entries(local)) if (!deletes.includes(rel)) {
      await fs4.mkdir(path4.dirname(path4.join(staged, rel)), { recursive: true });
      await fs4.writeFile(path4.join(staged, rel), data);
    }
    for (const [rel, data] of Object.entries(writes)) {
      await fs4.mkdir(path4.dirname(path4.join(staged, rel)), { recursive: true });
      await fs4.writeFile(path4.join(staged, rel), data);
    }
    const check = await run(herdrApp, ["check", staged], { env });
    if (check.code !== 0) fail3("CHECK_FAILED", `herdr-app check refused the new version: ${(check.stderr || check.stdout).trim().slice(0, 600)}`);
  } else {
    for (const [rel, data] of Object.entries(writes)) if (rel.endsWith(".json")) {
      try {
        JSON.parse(data.toString("utf8"));
      } catch {
        fail3("CHECK_FAILED", `${rel} is not valid JSON.`);
      }
    }
  }
  const plan = { v: 1, kind: record.kind, name: record.name, commit: update.commit, files: upstream, keysDigest: update.keysDigest ?? null, writes: Object.keys(writes), deletes, keys: keys ? { changed: keys.changed, owned: keys.owned } : null };
  await fs4.mkdir(path4.join(stageRoot, "files"), { recursive: true });
  for (const [rel, data] of Object.entries(writes)) {
    await fs4.mkdir(path4.dirname(path4.join(stageRoot, "files", rel)), { recursive: true });
    await fs4.writeFile(path4.join(stageRoot, "files", rel), data);
  }
  if (keys?.changed) await fs4.writeFile(path4.join(stageRoot, "keys.json"), JSON.stringify(keys.keys, null, 2) + "\n");
  await fs4.writeFile(path4.join(stageRoot, "plan.json"), JSON.stringify(plan));
  return { ok: true, state: "ready", review };
}
async function commit({ appHome, store, record, now = () => Date.now() }) {
  return commitMany({ appHome, store, records: [record], now, label: `update ${record.kind}:${record.name}` });
}
async function readPrepared(appHome, record) {
  const stageRoot = path4.join(recordsRoot(appHome), "stage", `${record.kind}-${record.name}`);
  let bytes;
  try {
    bytes = await fs4.readFile(path4.join(stageRoot, "plan.json"));
  } catch {
    fail3("NOT_PREPARED", "Prepare the update first.");
  }
  const plan = JSON.parse(bytes.toString("utf8")), writes = /* @__PURE__ */ new Map(), hash = crypto4.createHash("sha256").update(bytes);
  if (plan.kind !== record.kind || plan.name !== record.name) fail3("STALE_PREPARE", "The prepared update does not match this item.");
  for (const rel of plan.writes) {
    const data = await fs4.readFile(path4.join(stageRoot, "files", rel));
    writes.set(rel, data);
    hash.update("\0" + rel + "\0").update(data);
  }
  const keysData = plan.keys?.changed ? await fs4.readFile(path4.join(stageRoot, "keys.json")) : null;
  if (keysData) hash.update("\0keys\0").update(keysData);
  return { stageRoot, plan, writes, keysData, digest: hash.digest("hex") };
}
async function commitMany({ appHome, store, records, now = () => Date.now(), label = "update layout bundle", expectedPlans = {} }) {
  const stages = [], ops = [];
  let keysData = null, written = 0, deleted = 0;
  for (const record of records) {
    const key = `${record.kind}:${record.name}`, staged = await readPrepared(appHome, record), { stageRoot, plan } = staged, dir = installedDir(appHome, record);
    if (expectedPlans[key] && staged.digest !== expectedPlans[key]) fail3("STALE_PREPARE", "The prepared update changed; review it again.");
    for (const [rel, data] of staged.writes) ops.push({ type: "write", target: path4.join(dir, rel), data });
    for (const rel of plan.deletes) ops.push({ type: "delete", target: path4.join(dir, rel) });
    if (staged.keysData) keysData = staged.keysData;
    written += plan.writes.length;
    deleted += plan.deletes.length;
    stages.push({ record, key, plan, stageRoot });
  }
  for (const { record } of stages) await backup(appHome, record, now);
  if (keysData) ops.push({ type: "write", target: path4.join(appHome, "keys.json"), data: keysData });
  await store.commit(ops, { label });
  await store.updatePackages((value) => {
    for (const { key, record, plan } of stages) {
      const current = value.packages[key] || record;
      value.packages[key] = { ...current, commit: plan.commit, base: plan.files, keysDigest: plan.keysDigest ?? null, keys: plan.keys ? plan.keys.owned : current.keys, state: "current", lastResult: null, updatedAt: now() };
    }
  });
  for (const { stageRoot } of stages) await fs4.rm(stageRoot, { recursive: true, force: true });
  return { ok: true, commit: stages.at(-1)?.plan.commit, written, deleted };
}
async function backup(appHome, record, now) {
  const root = path4.join(recordsRoot(appHome), "backup", `${record.kind}-${record.name}`), target = path4.join(root, String(now()));
  await fs4.mkdir(target, { recursive: true });
  if (record.kind === "mod") await fs4.cp(installedDir(appHome, record), target, { recursive: true });
  else for (const ext of [".json", ".svg"]) {
    try {
      await fs4.copyFile(path4.join(appHome, "layouts", record.name + ext), path4.join(target, record.name + ext));
    } catch {
    }
  }
  try {
    await fs4.copyFile(path4.join(appHome, "keys.json"), path4.join(target, ".keys.json"));
  } catch {
  }
  const all = (await fs4.readdir(root)).sort((a, b) => Number(b) - Number(a));
  for (const old of all.slice(BACKUPS_KEPT)) await fs4.rm(path4.join(root, old), { recursive: true, force: true });
}
async function listFiles(dir) {
  const out = [];
  async function walk(current, rel) {
    let entries;
    try {
      entries = await fs4.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) await walk(path4.join(current, e.name), r);
      else if (e.isFile() && !GENERATED.test(r)) out.push(r);
    }
  }
  await walk(dir, "");
  return out.sort();
}
async function merge(stageRoot, rel, mine, base, theirs) {
  const dir = await fs4.mkdtemp(path4.join(os.tmpdir(), "mc-mods-merge-"));
  try {
    const [m, b, t] = ["mine", "base", "theirs"].map((n) => path4.join(dir, n));
    await fs4.writeFile(m, mine);
    await fs4.writeFile(b, base);
    await fs4.writeFile(t, theirs);
    const r = await run("git", ["merge-file", "-p", "-L", "yours", "-L", "installed", "-L", "upstream", m, b, t], { encoding: "buffer" });
    const data = Buffer.from(r.stdout);
    if (r.code === 0) return { conflict: false, data };
    if (typeof r.code === "number" && r.code > 0 && r.code < 128) {
      const out = path4.join(stageRoot, "merged", rel);
      await fs4.mkdir(path4.dirname(out), { recursive: true });
      const full = await new Promise((resolve) => execFile2("git", ["merge-file", "-p", "-L", "yours", "-L", "installed", "-L", "upstream", m, b, t], { encoding: "buffer", maxBuffer: 8 * 1024 * 1024 }, (_e, stdout) => resolve(stdout)));
      await fs4.writeFile(out, full);
      return { conflict: true, path: out };
    }
    fail3("MERGE_FAILED", `Merging ${rel} failed.`);
  } finally {
    await fs4.rm(dir, { recursive: true, force: true });
  }
}

// src/mods/mission-control-control-panel/bundles.mjs
import fs5 from "node:fs/promises";
import path5 from "node:path";
import crypto5 from "node:crypto";
var fail4 = (code, message) => {
  throw Object.assign(new Error(message), { code });
};
var stageFor = (home, r) => path5.join(recordsRoot(home), "stage", `${r.kind}-${r.name}`);
var bundleStage = (home, layout) => path5.join(recordsRoot(home), "stage", `bundle-${layout.name}`);
var prefix = (r) => r.kind === "mod" ? `mods/${r.name}/` : "layouts/";
var pending = (r) => r?.lastResult?.state === "update" && r.lastResult.update;
function layoutUpdateKeys(layout, items, packages) {
  if (layout.kind !== "layout" || layout.disabled || ["builtin", "clone"].includes(layout.origin)) return [];
  const source = packages[layout.key]?.source;
  const members = items.filter((i) => i.key === layout.key || i.kind === "mod" && !i.disabled && !["builtin", "clone"].includes(i.origin) && (layout.installerPackage ? i.installerPackage === layout.installerPackage : layout.mods?.includes(i.name) && packages[i.key]?.source?.path === source?.path) && source?.url && packages[i.key]?.source?.url === source.url && packages[i.key]?.source?.defaultBranch === source.defaultBranch);
  return members.filter((i) => pending(packages[i.key])).sort((a, b) => Number(a.name === SELF) - Number(b.name === SELF) || Number(a.kind === "layout") - Number(b.kind === "layout") || a.key.localeCompare(b.key)).map((i) => i.key);
}
async function prepareLayout({ appHome, layout, items, packages, source, resolutions = {}, continuation, herdrApp, env }) {
  const keys = layoutUpdateKeys(layout, items, packages);
  if (!keys.length) fail4("NO_UPDATE", "There is no update to apply; check again.");
  const root = bundleStage(appHome, layout), file = path5.join(root, "bundle.json");
  const signature = JSON.stringify([keys.map((key2) => [key2, packages[key2].commit, packages[key2].lastResult.update.commit]), resolutions]);
  let batch;
  if (continuation) {
    try {
      batch = JSON.parse(await fs5.readFile(file, "utf8"));
    } catch {
      fail4("NOT_PREPARED", "Start preparing the layout update again.");
    }
    if (batch.token !== continuation || batch.signature !== signature || batch.state !== "preparing") fail4("STALE_PREPARE", "The layout update changed; review it again.");
  } else {
    await fs5.rm(root, { recursive: true, force: true });
    await fs5.mkdir(root, { recursive: true });
    let currentKeys = {};
    try {
      currentKeys = JSON.parse(await fs5.readFile(path5.join(appHome, "keys.json"), "utf8"));
    } catch {
    }
    batch = { token: crypto5.randomUUID(), signature, state: "preparing", targets: keys.map((key2) => ({ key: key2, base: packages[key2].commit })), results: [], currentKeys };
  }
  const key = keys[batch.results.length], record = packages[key], scope = prefix(record);
  const choices = Object.fromEntries(Object.entries(resolutions).filter(([file2]) => file2.startsWith(scope)).map(([file2, choice]) => [file2.slice(scope.length), choice]));
  const result = await prepare({ appHome, source, record, update: record.lastResult.update, resolutions: choices, herdrApp, env, currentKeys: batch.currentKeys });
  let planSha = null;
  if (result.ok) {
    planSha = (await readPrepared(appHome, record)).digest;
    try {
      batch.currentKeys = JSON.parse(await fs5.readFile(path5.join(stageFor(appHome, record), "keys.json"), "utf8"));
    } catch {
    }
  }
  batch.results.push({ key, record: { kind: record.kind, name: record.name }, result, planSha });
  const done = batch.results.length === keys.length;
  if (done) batch.state = batch.results.every((r) => r.result.ok) ? "ready" : "conflict";
  await fs5.writeFile(file, JSON.stringify(batch));
  if (!done) return { pending: true, continuation: batch.token, message: `Preparing layout update (${batch.results.length}/${keys.length})…` };
  const review = { subject: `Layout files and bundled mods for ${layout.name}`, time: Math.max(...keys.map((k) => packages[k].lastResult.update.time || 0)), changed: [], removed: [], keptEdited: [], access: { hosts: [], programs: [], files: false }, keys: { add: [], remove: [], clash: [] } };
  const conflicts = [], conflictDir = path5.join(root, "conflicts");
  for (const { record: record2, result: result2 } of batch.results) {
    const scope2 = prefix(record2), r = result2.review;
    for (const field of ["changed", "removed", "keptEdited"]) review[field].push(...(r[field] || []).map((file2) => scope2 + file2));
    for (const field of ["hosts", "programs"]) review.access[field] = [.../* @__PURE__ */ new Set([...review.access[field], ...r.access?.[field] || []])];
    review.access.files ||= Boolean(r.access?.files);
    for (const field of ["add", "remove", "clash"]) review.keys[field].push(...r.keys?.[field] || []);
    for (const c of result2.conflicts || []) {
      const file2 = scope2 + c.file;
      conflicts.push({ ...c, file: file2 });
      if (!c.binary && result2.conflictDir) {
        const target = path5.join(conflictDir, file2);
        await fs5.mkdir(path5.dirname(target), { recursive: true });
        await fs5.copyFile(path5.join(result2.conflictDir, c.file), target);
      }
    }
  }
  return { ok: batch.state === "ready", state: batch.state, review, conflicts, ...conflicts.length ? { conflictDir } : {} };
}
async function commitLayout({ appHome, store, layout, packages, now }) {
  const root = bundleStage(appHome, layout);
  let batch;
  try {
    batch = JSON.parse(await fs5.readFile(path5.join(root, "bundle.json"), "utf8"));
  } catch {
    fail4("NOT_PREPARED", "Prepare the layout update first.");
  }
  if (batch.state !== "ready") fail4("NOT_PREPARED", "Resolve and review the layout update before applying it.");
  const records = batch.targets.map((t) => {
    const r = packages[t.key];
    if (!r || r.commit !== t.base) fail4("STALE_PREPARE", "An item changed since this review; prepare the layout update again.");
    return r;
  });
  const result = await commitMany({ appHome, store, records, now, label: `update layout bundle ${layout.name}`, expectedPlans: Object.fromEntries(batch.results.map((r) => [r.key, r.planSha])) });
  await fs5.rm(root, { recursive: true, force: true });
  return result;
}

// src/mods/mission-control-control-panel/lifecycle.mjs
import fs6 from "node:fs/promises";
import fsSync3 from "node:fs";
import path6 from "node:path";
var REMOVED_KEEP_MS = 30 * 24 * 60 * 60 * 1e3;
var LifecycleError = class extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = "LifecycleError";
    this.code = code;
    if (detail) this.detail = detail;
  }
};
var refuse = (code, message, detail) => {
  throw new LifecycleError(code, message, detail);
};
async function readJson2(file) {
  try {
    return JSON.parse(await fs6.readFile(file, "utf8"));
  } catch {
    return null;
  }
}
async function layoutsUsing(appHome, modName) {
  const dir = path6.join(appHome, "layouts"), out = [];
  let files = [];
  try {
    files = (await fs6.readdir(dir)).filter((f) => f.endsWith(".json") && !f.startsWith("."));
  } catch {
  }
  for (const file of files.sort()) if (layoutMods(await readJson2(path6.join(dir, file))).includes(modName)) out.push(file.replace(/\.json$/, ""));
  return out;
}
function guard(item, { activeLayout }) {
  if (item.origin === "builtin") refuse("BUILT_IN", `${item.name} is built into Herdr; Herdr restores and updates it itself.`);
  if (item.origin === "installer") refuse("INSTALLER_MANAGED", `${item.name} was installed with Mission Control; remove it with the installer.`);
  if (item.origin === "self") refuse("SELF", "The Mods manager cannot disable or remove itself.");
  if (item.kind === "layout" && item.name === activeLayout) refuse("ACTIVE_LAYOUT", `${item.name} is the layout on screen; switch to another layout first.`);
}
function paths(appHome, item) {
  const records = recordsRoot(appHome);
  return item.kind === "mod" ? { live: [path6.join(appHome, "mods", item.name)], disabled: [path6.join(records, "disabled", "mods", item.name)] } : { live: [".json", ".svg"].map((ext) => path6.join(appHome, "layouts", item.name + ext)), disabled: [".json", ".svg"].map((ext) => path6.join(records, "disabled", "layouts", item.name + ext)) };
}
async function references(appHome, item, { activeLayout, confirm }) {
  if (item.kind !== "mod") return null;
  const users = await layoutsUsing(appHome, item.name);
  if (activeLayout && users.includes(activeLayout)) refuse("USED_BY_ACTIVE_LAYOUT", `${item.name} is used by the layout on screen (${activeLayout}).`, { layouts: users });
  if (users.length && !confirm) return { needsConfirm: true, layouts: users };
  return null;
}
async function disable({ appHome, store, item, activeLayout = null, confirm = false }) {
  guard(item, { activeLayout });
  const pending2 = await references(appHome, item, { activeLayout, confirm });
  if (pending2) return pending2;
  const { live, disabled } = paths(appHome, item);
  const ops = live.map((from, i) => ({ from, to: disabled[i] })).filter((m) => fsSync3.existsSync(m.from)).map((m) => ({ type: "move", ...m }));
  if (!ops.length) refuse("NOT_INSTALLED", `${item.name} is not installed.`);
  await store.commit(ops, { label: `disable ${item.kind}:${item.name}` });
  await store.updatePackages((v) => {
    v.packages[`${item.kind}:${item.name}`] = { ...v.packages[`${item.kind}:${item.name}`] || { kind: item.kind, name: item.name }, disabled: true };
  });
  return { ok: true, state: "disabled" };
}
async function enable({ appHome, store, item }) {
  const { live, disabled } = paths(appHome, item);
  const ops = disabled.map((from, i) => ({ from, to: live[i] })).filter((m) => fsSync3.existsSync(m.from));
  if (!ops.length) refuse("NOT_DISABLED", `${item.name} is not disabled.`);
  if (ops.some((m) => fsSync3.existsSync(m.to))) refuse("NAME_TAKEN", `Another ${item.kind} named ${item.name} is installed now.`);
  await store.commit(ops.map((m) => ({ type: "move", ...m })), { label: `enable ${item.kind}:${item.name}` });
  await store.updatePackages((v) => {
    const r = v.packages[`${item.kind}:${item.name}`];
    if (r) r.disabled = false;
  });
  return { ok: true, state: "enabled" };
}
async function uninstall({ appHome, store, item, activeLayout = null, confirm = false, now = () => Date.now() }) {
  guard(item, { activeLayout });
  const pending2 = await references(appHome, item, { activeLayout, confirm });
  if (pending2) return pending2;
  const key = `${item.kind}:${item.name}`, records = recordsRoot(appHome), stamp = String(now());
  const target = path6.join(records, "removed", `${item.kind}-${item.name}`, stamp);
  const from = item.disabled ? paths(appHome, item).disabled : paths(appHome, item).live;
  const ops = from.filter((p) => fsSync3.existsSync(p)).map((p) => ({ type: "move", from: p, to: path6.join(target, path6.basename(p)) }));
  if (!ops.length) refuse("NOT_INSTALLED", `${item.name} is not installed.`);
  const record = (await store.readPackages()).packages[key] || {};
  let removedKeys = [];
  if (record.keys?.length) {
    let userKeys = {};
    try {
      userKeys = JSON.parse(await fs6.readFile(path6.join(appHome, "keys.json"), "utf8"));
    } catch {
    }
    const plan = planKeys(userKeys, {}, record.keys);
    if (plan.remove.length) {
      removedKeys = plan.remove;
      ops.push({ type: "write", target: path6.join(appHome, "keys.json"), data: JSON.stringify(plan.keys, null, 2) + "\n" });
    }
  }
  await store.commit(ops, { label: `uninstall ${key}` });
  await store.updatePackages((v) => {
    v.removed ??= {};
    v.removed[`${key}@${stamp}`] = { kind: item.kind, name: item.name, at: Number(stamp), dir: target, wasDisabled: Boolean(item.disabled), keys: removedKeys, record };
    delete v.packages[key];
  });
  return { ok: true, state: "removed", restoreUntil: Number(stamp) + REMOVED_KEEP_MS, removedKeys };
}
async function restore({ appHome, store, id }) {
  const removed = (await store.readPackages()).removed?.[id];
  if (!removed) refuse("NOT_FOUND", "That removed item no longer exists.");
  const item = { kind: removed.kind, name: removed.name }, places = removed.wasDisabled ? paths(appHome, item).disabled : paths(appHome, item).live;
  const ops = places.map((to) => ({ from: path6.join(removed.dir, path6.basename(to)), to })).filter((m) => fsSync3.existsSync(m.from));
  if (ops.some((m) => fsSync3.existsSync(m.to))) refuse("NAME_TAKEN", `Another ${item.kind} named ${item.name} is installed now.`);
  const all = ops.map((m) => ({ type: "move", ...m }));
  if (removed.keys?.length) {
    let userKeys = {};
    try {
      userKeys = JSON.parse(await fs6.readFile(path6.join(appHome, "keys.json"), "utf8"));
    } catch {
    }
    const snippet = {};
    for (const k of removed.keys) (snippet[k.section] ??= {})[k.key] = k.action;
    const plan = planKeys(userKeys, snippet, []);
    if (plan.add.length) all.push({ type: "write", target: path6.join(appHome, "keys.json"), data: JSON.stringify(plan.keys, null, 2) + "\n" });
  }
  await store.commit(all, { label: `restore ${removed.kind}:${removed.name}` });
  await store.updatePackages((v) => {
    delete v.removed[id];
    v.packages[`${removed.kind}:${removed.name}`] = { ...removed.record || {}, kind: removed.kind, name: removed.name, disabled: removed.wasDisabled };
  });
  await fs6.rm(removed.dir, { recursive: true, force: true });
  return { ok: true, state: removed.wasDisabled ? "disabled" : "enabled" };
}
async function pruneRemoved({ store, now = () => Date.now() }) {
  const removed = (await store.readPackages()).removed || {}, gone = [];
  for (const [id, r] of Object.entries(removed)) if (now() - r.at > REMOVED_KEEP_MS) {
    await fs6.rm(r.dir, { recursive: true, force: true });
    gone.push(id);
  }
  if (gone.length) await store.updatePackages((v) => {
    for (const id of gone) delete v.removed[id];
  });
  return gone;
}
async function restoreEverything({ appHome, store }) {
  const records = recordsRoot(appHome), done = [];
  for (const [kind, sub] of [["mod", "mods"], ["layout", "layouts"]]) {
    let names = [];
    try {
      names = await fs6.readdir(path6.join(records, "disabled", sub));
    } catch {
    }
    for (const n of new Set(names.filter((x) => !x.startsWith(".")).map((x) => kind === "layout" ? x.replace(/\.(json|svg)$/, "") : x))) {
      try {
        await enable({ appHome, store, item: { kind, name: n } });
        done.push(`${kind}:${n}`);
      } catch {
      }
    }
  }
  for (const id of Object.keys((await store.readPackages()).removed || {})) {
    try {
      await restore({ appHome, store, id });
      done.push(id);
    } catch {
    }
  }
  return done;
}

// src/mods/mission-control-control-panel/backend.mjs
var BUDGET_MS = 24e3;
async function handle(request, { env = process.env, now = () => Date.now(), herdrApp = env.QA_MODS_HERDR_APP || "herdr-app" } = {}) {
  const started = Date.now(), timeLeft = () => BUDGET_MS - (Date.now() - started);
  const appHome = request?.appHome;
  if (typeof appHome !== "string" || !path7.isAbsolute(appHome)) return { v: 1, ok: false, code: "INVALID_REQUEST", message: "An absolute app home is required." };
  const source = createSource({ appHome, env, now }), store = createStore({ appHome, now });
  const ensured = /* @__PURE__ */ new Map(), ensure = source.ensure;
  source.ensure = (url) => {
    if (!ensured.has(url)) ensured.set(url, ensure(url, { budgetMs: Math.max(1, Math.min(2e4, timeLeft() - 2e3)) }));
    return ensured.get(url);
  };
  const recovered = await store.recover();
  const items = async () => (await scan(appHome)).items;
  const find = async (key) => (await items()).find((i) => i.key === key) || failWith("NOT_FOUND", "That item is no longer installed.");
  const record = async (key) => (await store.readPackages()).packages[key] || null;
  switch (request.op) {
    case "inventory":
      return { v: 1, ok: true, recovered, ...await inventory() };
    case "check":
      return { v: 1, ok: true, recovered, ...await check() };
    case "prepare": {
      const all = await items(), item = all.find((i) => i.key === request.key);
      if (item?.kind === "layout" && !request.itemOnly) return { v: 1, ok: true, recovered, prepared: await prepareLayout({
        appHome,
        layout: item,
        items: all,
        packages: (await store.readPackages()).packages,
        source,
        resolutions: request.resolutions || {},
        continuation: request.continuation,
        herdrApp,
        env
      }) };
      const r = await record(request.key);
      if (!r?.lastResult?.update) failWith("NO_UPDATE", "There is no update to apply; check again.");
      return { v: 1, ok: true, recovered, prepared: await prepare({ appHome, source, record: r, update: r.lastResult.update, resolutions: request.resolutions || {}, herdrApp, env }) };
    }
    case "commit": {
      const item = await find(request.key);
      if (item.kind === "layout" && !request.itemOnly) return { v: 1, ok: true, recovered, committed: await commitLayout({ appHome, store, layout: item, packages: (await store.readPackages()).packages, now }) };
      const r = await record(request.key);
      if (!r) failWith("NOT_FOUND", "That item has no record.");
      return { v: 1, ok: true, recovered, committed: await commit({ appHome, store, record: r, now }) };
    }
    case "disable":
      return { v: 1, ok: true, recovered, result: await disable({ appHome, store, item: await find(request.key), activeLayout: request.activeLayout ?? null, confirm: Boolean(request.confirm) }) };
    case "enable":
      return { v: 1, ok: true, recovered, result: await enable({ appHome, store, item: await find(request.key) }) };
    case "uninstall":
      return { v: 1, ok: true, recovered, result: await uninstall({ appHome, store, item: await find(request.key), activeLayout: request.activeLayout ?? null, confirm: Boolean(request.confirm), now }) };
    case "restore":
      return { v: 1, ok: true, recovered, result: await restore({ appHome, store, id: request.id }) };
    case "restore-all":
      return { v: 1, ok: true, recovered, restored: await restoreEverything({ appHome, store }) };
    case "link":
      return { v: 1, ok: true, recovered, result: await link() };
    case "recover":
      return { v: 1, ok: true, recovered };
    default:
      return { v: 1, ok: false, code: "INVALID_REQUEST", message: "Unknown operation." };
  }
  async function inventory({ retry = false, previews = true } = {}) {
    const all = await items(), pkgs = (await store.readPackages()).packages;
    let catalogs = null, partial = false;
    const fresh = all.filter((i) => ["user", "installer", "self"].includes(i.origin) && !i.disabled && (!pkgs[i.key] || ["pending", "unreachable"].includes(pkgs[i.key].state) || retry && pkgs[i.key].state === "untracked"));
    if (fresh.length) {
      catalogs = { mods: await source.catalog("mods").catch(() => null), layouts: await source.catalog("layouts").catch(() => null) };
      for (const item of fresh) {
        if (timeLeft() < 6e3) {
          partial = true;
          break;
        }
        const result = await adopt(source, catalogs, item, { layoutsUsing: item.kind === "mod" ? await layoutsUsing(appHome, item.name) : [] }).catch((error) => ({ state: "unreachable", reason: error.message }));
        partial ||= result.state === "pending";
        await store.updatePackages((v) => {
          v.packages[item.key] = { kind: item.kind, name: item.name, ...result, adoptedAt: now() };
        });
      }
    }
    await pruneRemoved({ store, now });
    if (previews) await cachePreviews();
    return { ...await describe(), partial };
  }
  async function cachePreviews() {
    const dir = path7.join(recordsRoot(appHome), "cache", "previews"), pkgs = (await store.readPackages()).packages;
    let fetched = 0;
    for (const [key, r] of Object.entries(pkgs)) {
      const url = r.source?.previewUrl, file = path7.join(dir, key.replace(":", "-") + ".png");
      if (!url || fetched >= 6 || timeLeft() < 4e3) continue;
      if (await fs7.access(file).then(() => true, () => false)) continue;
      try {
        let data;
        if (url.startsWith("file:///")) {
          if (!source.fixture) continue;
          data = await fs7.readFile(new URL(url));
        } else {
          const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 4e3);
          const response = await fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
          if (!response.ok) continue;
          data = Buffer.from(await response.arrayBuffer());
        }
        if (data.length > 3 * 1024 * 1024 || data.subarray(0, 4).toString("hex") !== "89504e47") continue;
        await fs7.mkdir(dir, { recursive: true });
        await store.writeAtomic(file, data);
        fetched++;
      } catch {
      }
    }
  }
  async function check() {
    const adopted = await inventory({ retry: true, previews: false });
    const catalogs = { mods: await source.catalog("mods").catch(() => null), layouts: await source.catalog("layouts").catch(() => null) };
    const pkgs = (await store.readPackages()).packages;
    let partial = adopted.partial;
    const eligible = new Set((await items()).filter((i) => ["user", "installer", "self"].includes(i.origin) && !i.disabled).map((i) => i.key));
    for (const [key, r] of Object.entries(pkgs)) {
      if (!r.source || r.disabled || !eligible.has(key)) continue;
      if (timeLeft() < 6e3) {
        partial = true;
        break;
      }
      const result = await checkItem(source, catalogs, r).catch((error) => ({ state: "unreachable", reason: error.message }));
      await store.updatePackages((v) => {
        const cur = v.packages[key];
        if (!cur) return;
        cur.lastResult = result;
        cur.headCommit = result.headCommit ?? cur.headCommit;
        cur.remoteHead = result.remoteHead ?? cur.remoteHead;
        cur.checkedAt = now();
      });
    }
    return { ...await describe(), partial, checkedAt: now(), catalogAge: catalogs.mods?.fetchedAt ? now() - catalogs.mods.fetchedAt : null };
  }
  async function link() {
    const item = await find(request.key), m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/tree\/([^/]+)(?:\/(.*))?)?\/?$/.exec(String(request.url || "").trim());
    if (!m) failWith("INVALID_LINK", "Paste a github.com repository or folder link.");
    let folder = (m[4] || "").replace(/\/+$/, "");
    for (const tail of [`mods/${item.name}`, `layouts`]) if (folder.endsWith(tail)) folder = folder.slice(0, -tail.length).replace(/\/+$/, "");
    const entry = { kind: item.kind === "mod" ? "mods" : "layouts", fullName: `${m[1]}/${m[2]}`, url: `https://github.com/${m[1]}/${m[2]}`, defaultBranch: m[3] || "main", path: folder, names: [item.name], previewUrl: null };
    const result = await adopt(source, item.kind === "mod" ? { mods: { entries: [entry] }, layouts: { entries: [] } } : { mods: { entries: [] }, layouts: { entries: [entry] } }, item);
    if (!["current", "edited"].includes(result.state)) failWith("NO_MATCH", result.reason || "That folder does not hold this item.");
    await store.updatePackages((v) => {
      v.packages[item.key] = { kind: item.kind, name: item.name, ...result, linked: true, adoptedAt: now() };
    });
    return { state: result.state };
  }
  async function describe() {
    const all = await items(), value = await store.readPackages(), records = recordsRoot(appHome);
    const out = [];
    for (const i of all) {
      const r = value.packages[i.key] || {}, last = r.lastResult || {};
      const protectedOrigin = ["builtin", "clone"].includes(i.origin);
      const state = protectedOrigin ? i.origin : i.disabled ? "disabled" : last.state && last.state !== "current" ? last.state : r.state || "unknown";
      const preview = path7.join(records, "cache", "previews", `${i.kind}-${i.name}.png`), previewRel = path7.relative(appHome, preview);
      out.push({
        key: i.key,
        kind: i.kind,
        name: i.name,
        title: i.title || null,
        origin: i.origin,
        disabled: Boolean(i.disabled),
        state,
        reason: last.reason || r.reason || null,
        source: r.source ? { fullName: r.source.fullName, path: r.source.path, url: r.source.url } : null,
        commit: r.commit || null,
        subject: r.subject || null,
        edited: r.edited || [],
        candidates: r.candidates || [],
        update: last.update ? { subject: last.update.subject, time: last.update.time, changed: last.update.changed.length, added: last.update.added.length, removed: last.update.removed.length } : null,
        usedBy: i.kind === "mod" ? await layoutsUsing(appHome, i.name) : [],
        installerPackage: i.installerPackage || null,
        preview: await fs7.access(preview).then(() => previewRel, () => null)
      });
    }
    for (const row of out.filter((i) => i.kind === "layout")) {
      const keys = layoutUpdateKeys(all.find((i) => i.key === row.key), all, value.packages);
      if (!keys.length) continue;
      row.state = "update";
      row.updateKeys = keys;
      const changes = keys.map((key) => value.packages[key].lastResult.update);
      row.update = {
        subject: `Updates to ${keys.map((key) => value.packages[key].name).join(", ")}`,
        time: Math.max(...changes.map((u) => u.time || 0)),
        changed: changes.reduce((n, u) => n + u.changed.length, 0),
        added: changes.reduce((n, u) => n + u.added.length, 0),
        removed: changes.reduce((n, u) => n + u.removed.length, 0)
      };
    }
    const removed = Object.entries(value.removed || {}).map(([id, r]) => ({ id, kind: r.kind, name: r.name, at: r.at, restoreUntil: r.at + REMOVED_KEEP_MS }));
    return { list: out, removed };
  }
}
function failWith(code, message) {
  throw Object.assign(new Error(message), { code });
}
if (import.meta.url === `file://${process.argv[1]}`) {
  let request;
  try {
    request = JSON.parse(process.argv[2] || "{}");
  } catch {
    request = {};
  }
  handle(request).then(
    (result) => process.stdout.write(JSON.stringify(result)),
    (error) => process.stdout.write(JSON.stringify({ v: 1, ok: false, code: error.code || "FAILED", message: String(error.message || "The Mods helper failed.").slice(0, 600), ...error.detail ? { detail: error.detail } : {} }))
  );
}
export {
  handle
};
