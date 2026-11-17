// J.A.R.V.I.S. data backend: one JSON snapshot of everything you're working on.
// Reads Mission Control's own config (connections + per-repo bindings), never writes it.
// Usage: node backend.mjs <appHome>
import { readFileSync, writeFileSync, mkdirSync, statSync, openSync, readSync, closeSync, readdirSync, renameSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

const appHome = process.argv[2] || join(homedir(), ".config/herdr-app");
const mcDir = join(appHome, "mission-control");
const cacheDir = join(mcDir, "jarvis");

const run = (cmd, args, timeout = 30000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
    resolve({ ok: !err, stdout: String(stdout || ""), stderr: String(stderr || err?.message || "") }));
});

function readConfig() {
  try { return JSON.parse(readFileSync(join(mcDir, "config.json"), "utf8")); } catch { return { connections: {}, bindings: {} }; }
}

async function jira(config) {
  const bindings = Object.values(config.bindings || {}).filter((b) => b.jira?.connectionId);
  if (!bindings.length) return { ok: false, error: "No Jira bindings", issues: [] };
  const conn = config.connections?.[bindings[0].jira.connectionId];
  if (!conn?.site) return { ok: false, error: "Jira connection missing", issues: [] };
  const user = process.env[conn.auth?.usernameEnv || ""], token = process.env[conn.auth?.tokenEnv || ""];
  if (!token) return { ok: false, error: "Jira token not available", issues: [] };
  const projects = [...new Set(bindings.map((b) => b.jira.project).filter(Boolean))];
  const jql = `assignee = currentUser() AND project in (${projects.map((p) => `"${p}"`).join(",")}) AND (statusCategory != Done OR updated >= -7d) ORDER BY updated DESC`;
  const headers = { Accept: "application/json", "Content-Type": "application/json",
    Authorization: conn.auth?.kind === "bearer" ? `Bearer ${token}` : `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}` };
  const issues = [];
  let nextPageToken;
  try {
    for (let page = 0; page < 3; page++) {
      const res = await fetch(new URL("/rest/api/3/search/jql", conn.site), { method: "POST", headers,
        body: JSON.stringify({ jql, maxResults: 100, nextPageToken, fields: ["summary", "status", "project", "priority", "updated", "issuetype"] }),
        signal: AbortSignal.timeout(20000) });
      if (!res.ok) return { ok: false, error: `Jira HTTP ${res.status}`, issues };
      const body = await res.json();
      for (const i of body.issues || []) {
        const f = i.fields || {};
        issues.push({ key: i.key, summary: f.summary || "", status: f.status?.name || "", cat: f.status?.statusCategory?.key || "new",
          project: f.project?.key || "", priority: f.priority?.name || "", type: f.issuetype?.name || "",
          updated: f.updated || null, url: `${conn.site.replace(/\/$/, "")}/browse/${i.key}` });
      }
      if (!body.nextPageToken || body.isLast) break;
      nextPageToken = body.nextPageToken;
    }
  } catch (e) { return { ok: false, error: `Jira: ${e.message}`, issues }; }
  return { ok: true, projects, issues };
}

const PR_FIELDS = `... on PullRequest { number title url body isDraft updatedAt reviewDecision repository { nameWithOwner }
  headRefName headRefOid baseRefName baseRefOid headRepository { nameWithOwner }
  reviewThreads(first: 100) { nodes { isResolved } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } }`;

async function github() {
  const q = (search) => `search(query: "${search}", type: ISSUE, first: 40) { nodes { ${PR_FIELDS} } }`;
  const query = `query { mine: ${q("is:pr is:open author:@me archived:false")} reviews: ${q("is:pr is:open review-requested:@me archived:false")} }`;
  const r = await run("gh", ["api", "graphql", "-f", `query=${query}`], 30000);
  if (!r.ok) return { ok: false, error: `GitHub: ${r.stderr.trim().split("\n")[0]}`, mine: [], reviews: [] };
  let data;
  try { data = JSON.parse(r.stdout).data; } catch { return { ok: false, error: "GitHub: bad response", mine: [], reviews: [] }; }
  const map = (n) => ({ repo: n.repository?.nameWithOwner || "", number: n.number, title: n.title, url: n.url, draft: !!n.isDraft,
    updated: n.updatedAt, review: n.reviewDecision || null, ci: n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state || null,
    body: String(n.body || "").slice(0, 6000), headRef: n.headRefName || null, headSha: n.headRefOid || null,
    baseRef: n.baseRefName || null, baseSha: n.baseRefOid || null, headRepo: n.headRepository?.nameWithOwner || null,
    unresolved: (n.reviewThreads?.nodes || []).filter((t) => t && !t.isResolved).length });
  return { ok: true, mine: (data?.mine?.nodes || []).filter((n) => n?.number).map(map), reviews: (data?.reviews?.nodes || []).filter((n) => n?.number).map(map) };
}

// Claude Code activity per day and per project, read incrementally from ~/.claude/projects.
const DAY = 86400000;
const localDay = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

function activity(config) {
  const root = join(homedir(), ".claude/projects");
  const cachePath = join(cacheDir, "activity-cache.json");
  let cache = { v: 2, files: {} };
  try { cache = JSON.parse(readFileSync(cachePath, "utf8")); if (cache.v !== 2) cache = { v: 2, files: {} }; } catch {}
  const since = Date.now() - 8 * DAY;
  const seen = new Set();
  let dirs = [];
  try { dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch {}
  const buf = Buffer.alloc(4 * 1024 * 1024);
  for (const dir of dirs) {
    let files = [];
    try { files = readdirSync(join(root, dir)).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
    for (const f of files) {
      const path = join(root, dir, f);
      let st; try { st = statSync(path); } catch { continue; }
      if (st.mtimeMs < since) continue;
      seen.add(path);
      let entry = cache.files[path];
      if (!entry || st.size < entry.offset) entry = { dir, offset: 0, days: {} };
      if (st.size > entry.offset) {
        const fd = openSync(path, "r");
        let pos = entry.offset, carry = "";
        try {
          while (pos < st.size) {
            const n = readSync(fd, buf, 0, Math.min(buf.length, st.size - pos), pos);
            if (n <= 0) break;
            pos += n;
            const text = carry + buf.toString("utf8", 0, n);
            const lines = text.split("\n");
            carry = lines.pop();
            const ids = new Set();
            for (const line of lines) {
              if (!entry.cwd) entry.cwd = /"cwd":"([^"]+)"/.exec(line)?.[1] || null;
              if (!line.includes('"type":"assistant"')) continue;
              const ts = /"timestamp":"([^"]+)"/.exec(line); if (!ts) continue;
              const id = /"message":\{[^]*?"id":"([^"]+)"/.exec(line)?.[1];
              if (id) { if (ids.has(id)) continue; ids.add(id); }
              const t = Date.parse(ts[1]); if (!(t >= since)) continue;
              const out = Number(/"output_tokens":(\d+)/.exec(line)?.[1] || 0);
              const day = entry.days[localDay(t)] ||= { m: 0, t: 0 };
              day.m++; day.t += out;
            }
          }
        } finally { closeSync(fd); }
        entry.offset = pos - Buffer.byteLength(carry, "utf8");
      }
      cache.files[path] = entry;
    }
  }
  for (const p of Object.keys(cache.files)) if (!seen.has(p)) delete cache.files[p];
  try { mkdirSync(cacheDir, { recursive: true }); writeFileSync(cachePath + ".tmp", JSON.stringify(cache)); renameSync(cachePath + ".tmp", cachePath); } catch {}

  // Map each session's working folder to its repository (worktrees resolve to their main repo).
  const repoOf = (cwd) => {
    for (let dir = cwd; dir && dir !== "/"; dir = dir.slice(0, dir.lastIndexOf("/")) || "/") {
      let st; try { st = statSync(join(dir, ".git")); } catch { continue; }
      if (st.isDirectory()) return dir;
      try {
        const gitdir = /gitdir:\s*(.+)/.exec(readFileSync(join(dir, ".git"), "utf8"))?.[1]?.trim();
        const i = gitdir?.indexOf("/.git/worktrees/") ?? -1;
        return i > 0 ? gitdir.slice(0, i) : dir;
      } catch { return dir; }
    }
    return cwd;
  };
  const days = [];
  for (let i = 6; i >= 0; i--) days.push({ date: localDay(Date.now() - i * DAY), messages: 0, tokens: 0 });
  const byDate = Object.fromEntries(days.map((d) => [d.date, d]));
  const projects = {};
  for (const e of Object.values(cache.files)) {
    const root = e.cwd ? repoOf(e.cwd) : null;
    const name = root ? root.split("/").pop() : e.dir.split("-").filter(Boolean).pop() || e.dir;
    for (const [date, v] of Object.entries(e.days)) {
      const d = byDate[date]; if (!d) continue;
      d.messages += v.m; d.tokens += v.t;
      const p = projects[name] ||= { name, root, messages: 0, tokens: 0 };
      p.messages += v.m; p.tokens += v.t;
    }
  }
  return { ok: true, days, projects: Object.values(projects).sort((a, b) => b.messages - a.messages) };
}

const config = readConfig();
const [j, g] = await Promise.all([jira(config), github()]);
let a;
try { a = activity(config); } catch (e) { a = { ok: false, error: e.message, days: [], projects: [] }; }
const bindings = Object.values(config.bindings || {}).filter((b) => b.machine == null && b.repoRoot).map((b) => ({
  root: b.repoRoot,
  jira: b.jira?.project ? { project: b.jira.project } : null,
  github: b.github?.owner && b.github?.repo ? { repo: `${b.github.owner}/${b.github.repo}` } : null,
}));
process.stdout.write(JSON.stringify({ v: 1, at: Date.now(), bindings, jira: j, github: g, activity: a }) + "\n");
