#!/usr/bin/env node
// J.A.R.V.I.S. iMessage relay.
//
//   relay.mjs run              watch agents, text alerts, read replies (launchd runs this)
//   relay.mjs send "<text>"    queue a text to you (used by the jarvis session, briefings, routines)
//   relay.mjs test             send one test message now
//   relay.mjs call             FaceTime ring (only when facetime.enabled is true)
//
// Config:  <appHome>/mission-control/jarvis/relay.json
// State:   <appHome>/mission-control/jarvis/relay-state.json, outbox/, relay.log
// Nothing here is written inside mods/, so the HUD never hot-reloads because of it.

import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_HOME = process.env.HERDR_APP_HOME || path.join(os.homedir(), ".config/herdr-app");
const DIR = path.join(APP_HOME, "mission-control/jarvis");
const CONFIG = path.join(DIR, "relay.json");
const STATE = path.join(DIR, "relay-state.json");
const OUTBOX = path.join(DIR, "outbox");
const LOG = path.join(DIR, "relay.log");
const ORCH_DIR = path.join(DIR, "orchestrator");
const CHAT_DB = path.join(os.homedir(), "Library/Messages/chat.db");
const SELF = fileURLToPath(import.meta.url);
const PATHS = ["/opt/homebrew/bin", "/usr/local/bin", path.join(os.homedir(), ".local/bin"), "/usr/bin", "/bin"];
const ENV = { ...process.env, PATH: [...PATHS, process.env.PATH || ""].join(":") };

const DEFAULTS = {
  enabled: true,
  to: "",                       // your phone number (+15551234567) or Apple ID email
  // self: true when this Mac's Messages uses YOUR Apple ID, so JARVIS writes in your
  // "note to self" thread. Its texts start with MARK; everything else there is you.
  self: true,
  mode: "work",                 // work | focus | night | off
  alerts: { blocked: true, done: true, error: true },
  repeat: { everyMinutes: 2, times: 3 },   // re-send an unanswered blocked alert
  pollSeconds: 4,
  maxPromptChars: 180,
  orchestrator: { name: "jarvis", agent: "claude" },
  facetime: { enabled: false, to: "" },
};

// ---------- small helpers ----------
fs.mkdirSync(OUTBOX, { recursive: true });
const log = (...a) => {
  const line = `${new Date().toISOString()} ${a.join(" ")}\n`;
  try { fs.appendFileSync(LOG, line); } catch {}
  if (process.stdout.isTTY) process.stdout.write(line);
};
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const writeJSON = (f, v) => { const t = f + ".tmp"; fs.writeFileSync(t, JSON.stringify(v, null, 2)); fs.renameSync(t, f); };
const merge = (a, b) => {
  const o = { ...a };
  for (const [k, v] of Object.entries(b || {})) o[k] = v && typeof v === "object" && !Array.isArray(v) ? merge(a[k] || {}, v) : v;
  return o;
};
const config = () => merge(DEFAULTS, readJSON(CONFIG, {}));
const run = (cmd, args, opts = {}) => new Promise((res) => {
  execFile(cmd, args, { env: ENV, maxBuffer: 16 << 20, timeout: opts.timeout ?? 20000, ...opts }, (err, stdout, stderr) =>
    res({ ok: !err, code: err?.code ?? 0, out: String(stdout || ""), err: String(stderr || err?.message || "") }));
});
const norm = (h) => {
  h = String(h || "").trim().toLowerCase();
  if (h.includes("@")) return h;
  const d = h.replace(/[^\d]/g, "");
  return d.length > 9 ? d.slice(-9) : d;   // compare the last 9 digits: +1 555… == 555…
};
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// ---------- two-user mode ----------
// transport "messages": this user's Messages app sends and receives (your own Apple ID → self-thread).
// transport "shared":   a separate macOS user signed into a JARVIS Apple ID runs `relay.mjs helper`.
//                       This relay drops texts in SHARED/out and picks your replies up from SHARED/in.
const SHARED = "/Users/Shared/jarvis";
const SH_OUT = path.join(SHARED, "out");
const SH_IN = path.join(SHARED, "in");
const newName = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}.json`;
const takeAll = (dir) => {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort(); } catch {}
  return files.map((f) => { const p = path.join(dir, f); const v = readJSON(p, null); try { fs.unlinkSync(p); } catch {} return v; }).filter(Boolean);
};
const dropShared = (dir, v) => {
  const f = path.join(dir, newName()), t = path.join(dir, "." + newName());
  fs.writeFileSync(t, JSON.stringify(v)); fs.chmodSync(t, 0o666); fs.renameSync(t, f);
};

// ---------- sending ----------
const SEND_SCRIPT = `on run argv
  set theText to item 1 of argv
  set theTo to item 2 of argv
  tell application "Messages"
    set svc to 1st account whose service type = iMessage
    send theText to participant theTo of svc
  end tell
end run`;

const MARK = "🤖 ";
function sendViaMessages(text, to) {
  return new Promise((res) => {
    const p = spawn("osascript", ["-", text, to], { env: ENV });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => res({ ok: code === 0, err }));
    p.stdin.end(SEND_SCRIPT);
  });
}

async function imessage(text) {
  const cfg = config();
  if (!cfg.to) { log("send skipped: relay.json has no \"to\""); return false; }
  if (cfg.self && cfg.transport !== "shared") text = MARK + text;
  if (cfg.transport === "shared") {
    try { dropShared(SH_OUT, { text, to: cfg.to }); log(`queued for JARVIS user: ${clip(text.replace(/\n/g, " ⏎ "), 120)}`); return true; }
    catch (e) { log(`shared send failed: ${e.message}`); return false; }
  }
  const r = await sendViaMessages(text, cfg.to);
  log(r.ok ? `sent: ${clip(text.replace(/\n/g, " ⏎ "), 120)}` : `send failed: ${r.err.trim()}`);
  return r.ok;
}

function queue(text, extra = {}) {
  const f = path.join(OUTBOX, `${Date.now()}-${Math.random().toString(36).slice(2, 7)}.json`);
  writeJSON(f, { text, ...extra });
  return f;
}

async function drainOutbox() {
  let files = [];
  try { files = fs.readdirSync(OUTBOX).filter((f) => f.endsWith(".json")).sort(); } catch {}
  for (const f of files) {
    const p = path.join(OUTBOX, f);
    const msg = readJSON(p, null);
    try { fs.unlinkSync(p); } catch {}
    if (!msg?.text) continue;
    const mode = config().mode;
    if (mode === "off") continue;
    if ((mode === "night" || mode === "focus") && !msg.urgent && !msg.reply) continue;
    await imessage(msg.text);
  }
}

// ---------- FaceTime (built, switched off) ----------
// Rings your phone from this Mac's FaceTime account, then the details follow by iMessage.
// FaceTime calls don't connect in the UAE, so this stays off until facetime.enabled is true.
// A real two-way voice conversation would also need call audio routed to a virtual device
// (e.g. BlackHole) plus speech-to-text; that part is not built yet.
async function facetimeCall(reason) {
  const cfg = config();
  if (!cfg.facetime?.enabled) { log("facetime: disabled in relay.json"); return false; }
  const to = cfg.facetime.to || cfg.to;
  if (!to) return false;
  await run("open", [`facetime-audio://${to}`]);
  // macOS asks "Call?" before dialling; press its Call button.
  await new Promise((r) => setTimeout(r, 2500));
  const r = await run("osascript", ["-e", `tell application "System Events" to tell process "FaceTime"
    try
      click button "Call" of window 1
    end try
  end tell`]);
  log(`facetime: rang ${to} (${reason || "manual"})${r.ok ? "" : " — click failed: " + r.err.trim()}`);
  return r.ok;
}

// ---------- reading replies from Messages ----------
function decodeAttributed(hex) {
  if (!hex) return "";
  const b = Buffer.from(hex, "hex");
  const at = b.indexOf("NSString");
  if (at < 0) return "";
  let i = b.indexOf(0x2b, at);          // '+' precedes the length-prefixed UTF-8 text
  if (i < 0) return "";
  i += 1;
  let len = b[i];
  if (len === 0x81) { len = b.readUInt16LE(i + 1); i += 3; }
  else if (len === 0x82) { len = b.readUInt32LE(i + 1); i += 5; }
  else i += 1;
  return b.slice(i, i + len).toString("utf8");
}

async function sql(q) {
  const r = await run("/usr/bin/sqlite3", ["-readonly", "-json", CHAT_DB, q]);
  if (!r.ok) throw new Error(r.err.trim());
  return r.out.trim() ? JSON.parse(r.out) : [];
}

// ---------- agents ----------
const agents = new Map();   // address -> { status, where, app, since }
const refs = new Map();     // n -> { address, sent, repeats }
let nextRef = 1;
const refFor = (address) => {
  for (const [n, r] of refs) if (r.address === address) return n;
  const n = nextRef++; if (nextRef > 99) nextRef = 1;
  refs.set(n, { address, sent: 0, repeats: 0 });
  return n;
};

async function promptLine(address) {
  const r = await run("hc", ["read", address]);
  if (!r.ok) return "";
  const lines = r.out.split("\n").map((l) => l.replace(/[│╭╮╰╯─┃━┏┓┗┛]/g, "").trim()).filter(Boolean).slice(-14);
  const q = [...lines].reverse().find((l) => /\?\s*$/.test(l)) || lines.slice(-2).join(" · ");
  return clip(q, config().maxPromptChars);
}

async function onStatus(t, before) {
  const cfg = config();
  const st = t.status?.state;
  const name = t.where || t.title || t.address;
  const app = t.status?.app || t.agent || "agent";
  if (cfg.mode === "off") return;
  if (st === "blocked" && cfg.alerts.blocked) {
    const n = refFor(t.address);
    const q = await promptLine(t.address);
    const text = `🔴 ${n} · ${name} (${app}) needs you${q ? `:\n${q}` : "."}\nReply "${n} yes", "${n} no" or "${n} <message>".`;
    refs.get(n).sent = Date.now(); refs.get(n).text = text;
    await imessage(text);
  } else if (st === "done" && before === "working" && cfg.alerts.done && cfg.mode === "work") {
    await imessage(`✅ ${name} (${app}) finished.`);
  } else if (st === "error" && cfg.alerts.error && cfg.mode !== "night") {
    await imessage(`⚠️ ${name} (${app}) hit an error.`);
  }
  if (st !== "blocked") for (const [n, r] of refs) if (r.address === t.address) r.sent = 0;
}

function watchEvents() {
  const p = spawn("hc", ["events", "--json"], { env: ENV });
  let buf = "", first = true;
  p.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      for (const t of ev.terminals || []) {
        if (!t.status?.app) continue;
        const prev = agents.get(t.address);
        const st = t.status.state;
        agents.set(t.address, { status: st, where: t.labels?.where || t.title || t.address, app: t.status.app, name: t.name });
        if (!first && prev?.status !== st) onStatus({ ...t, where: t.labels?.where || t.title }, prev?.status).catch((e) => log("alert:", e.message));
      }
      first = false;
    }
  });
  p.on("close", (code) => { log(`hc events ended (${code}); restarting in 5s`); setTimeout(watchEvents, 5000); });
}

async function repeatUnanswered() {
  const { everyMinutes, times } = config().repeat;
  for (const r of refs.values()) {
    if (!r.sent || agents.get(r.address)?.status !== "blocked") continue;
    if (r.repeats >= times || Date.now() - r.sent < everyMinutes * 60e3) continue;
    r.repeats += 1; r.sent = Date.now();
    await imessage(`⏰ ${r.text}`);
  }
}

// ---------- your replies ----------
const YES = /^(y|yes|ok|okay|approve|go|1)$/i;
const NO = /^(n|no|deny|stop|cancel|esc)$/i;

async function answerAgent(n, body) {
  const r = refs.get(n);
  if (!r) return imessage(`I don't have an alert ${n} open. Text "status" to see what's running.`);
  const a = agents.get(r.address);
  if (YES.test(body)) {
    // Claude Code and Codex both default to the "yes" option on their approval prompts.
    await run("hc", ["keys", r.address, ...(r.yesKeys || ["enter"])]);
    r.yesKeys = undefined; r.sent = 0; r.repeats = 0;
    return imessage(`👍 Approved ${n} · ${a?.where || r.address}.`);
  }
  if (NO.test(body)) {
    await run("hc", ["keys", r.address, "esc"]);
    r.sent = 0; r.repeats = 0;
    return imessage(`✋ Denied ${n} · ${a?.where || r.address}.`);
  }
  await run("hc", ["keys", r.address, "esc"]);
  await run("hc", ["send", r.address, body]);
  r.sent = 0; r.repeats = 0;
  return imessage(`➡️ Sent to ${n} · ${a?.where || r.address}.`);
}

function statusText() {
  const list = [...agents.values()];
  const by = (s) => list.filter((a) => a.status === s);
  const rows = [...by("blocked").map((a) => `🔴 ${a.where}`), ...by("working").map((a) => `🟡 ${a.where}`)].slice(0, 10);
  return `${by("working").length} working · ${by("blocked").length} need you · ${by("done").length} done · mode ${config().mode}` +
    (rows.length ? `\n${rows.join("\n")}` : "");
}

async function toOrchestrator(body) {
  const { name, agent } = config().orchestrator;
  const msg = `[iMessage] ${body}`;
  const live = await run("hc", ["get", name, "--json"]);
  let alive = false;
  try { alive = live.ok && JSON.parse(live.out).state === "live"; } catch {}
  if (alive) {
    await run("hc", ["send", name, msg]);
  } else {
    fs.mkdirSync(ORCH_DIR, { recursive: true });
    const r = await run("hc", ["run", "--bg", "--name", name, "--cwd", ORCH_DIR, agent, msg]);
    if (!r.ok) return imessage(`Couldn't start the jarvis session: ${clip(r.err.trim(), 140)}`);
    // Startup screens (folder trust, login, updates) come before the agent reports itself,
    // so they'd never raise a blocked alert. Look once the session has had time to start.
    setTimeout(async () => {
      const s = await run("hc", ["read", name]);
      if (/Enter to confirm|trust this folder|Select login method|Press Enter to continue/i.test(s.out)) {
        const n = refFor(name);
        if (/trust this folder/i.test(s.out)) refs.get(n).yesKeys = ["down", "enter"];   // default there is "No, exit"
        const text = `🔴 ${n} · the jarvis session is stuck on a startup prompt:\n${await promptLine(name)}\nReply "${n} yes", "${n} no", or open it with: hc attach ${name}`;
        refs.get(n).sent = Date.now(); refs.get(n).text = text;
        await imessage(text);
      }
    }, 20000);
  }
}

async function handleIncoming(text) {
  const body = text.trim();
  if (!body) return;
  log(`received: ${clip(body, 120)}`);
  const m = body.match(/^#?(\d{1,2})\s+([\s\S]+)$/);
  if (m) return answerAgent(Number(m[1]), m[2].trim());
  const cmd = body.toLowerCase();
  if (cmd === "status") return imessage(statusText());
  if (/^mode (work|focus|night|off)$/.test(cmd)) {
    const cfg = readJSON(CONFIG, {}); cfg.mode = cmd.split(" ")[1]; writeJSON(CONFIG, cfg);
    return imessage(`Mode set to ${cfg.mode}.`);
  }
  if (cmd === "help") return imessage(`Text me:\n• "status"\n• "<n> yes" / "<n> no" / "<n> <message>" for an alert\n• "mode work|focus|night|off"\n• anything else goes to the jarvis session`);
  return toOrchestrator(body);
}

const seen = new Map();
async function pollMessages(state) {
  const cfg = config();
  if (!cfg.to) return;
  if (cfg.transport === "shared") {
    for (const m of takeAll(SH_IN)) if (m.text) await handleIncoming(String(m.text));
    return;
  }
  // First successful read (e.g. right after Full Disk Access is granted): start from now,
  // so old messages in the thread are never treated as orders.
  if (!state.lastRow) {
    state.lastRow = (await sql("SELECT IFNULL(MAX(ROWID),0) AS id FROM message"))[0].id || 1;
    writeJSON(STATE, state);
    log(`reading Messages from row ${state.lastRow}`);
    return;
  }
  // Separate JARVIS Apple ID: your replies arrive as received messages from your handle.
  // Your own Apple ID (self): JARVIS and you both write in your self-thread, as "sent" and/or
  // "received" copies, so take both, skip anything carrying MARK, and drop echo duplicates.
  const fromMe = cfg.self ? "" : "AND m.is_from_me = 0";
  const rows = await sql(`SELECT m.ROWID AS id, m.text AS text, hex(m.attributedBody) AS ab, h.id AS handle
    FROM message m JOIN handle h ON m.handle_id = h.ROWID
    WHERE m.ROWID > ${Number(state.lastRow) || 0} ${fromMe} AND m.item_type = 0
    ORDER BY m.ROWID LIMIT 50`);
  const me = norm(cfg.to);
  for (const r of rows) {
    state.lastRow = r.id;
    if (norm(r.handle) !== me) continue;          // only your thread
    const text = (r.text || decodeAttributed(r.ab) || "").trim();
    if (!text || text.startsWith(MARK.trim())) continue;   // JARVIS's own texts
    const key = text.toLowerCase();
    if (seen.get(key) > Date.now() - 15000) continue;      // self-thread echo
    seen.set(key, Date.now());
    await handleIncoming(text);
  }
  writeJSON(STATE, state);
}

// ---------- helper (runs in the JARVIS macOS user) ----------
// Sends whatever the main relay drops in SHARED/out, and drops your replies in SHARED/in.
// It only ever reads the JARVIS account's own Messages, and only messages from `to`.
async function helper() {
  const HCFG = path.join(SHARED, "helper.json");
  const HSTATE = path.join(os.homedir(), ".jarvis-helper-state.json");
  const state = readJSON(HSTATE, {});
  let warned = false;
  log(`helper up as ${os.userInfo().username} · ${SHARED}`);
  const tick = async () => {
    const to = readJSON(HCFG, {}).to;
    for (const m of takeAll(SH_OUT)) {
      const r = await sendViaMessages(m.text, m.to || to);
      log(r.ok ? `sent: ${clip(m.text.replace(/\n/g, " ⏎ "), 120)}` : `send failed: ${r.err.trim()}`);
    }
    try {
      if (!state.lastRow) {
        state.lastRow = (await sql("SELECT IFNULL(MAX(ROWID),0) AS id FROM message"))[0].id || 1;
        writeJSON(HSTATE, state); log(`reading Messages from row ${state.lastRow}`);
      } else if (to) {
        const rows = await sql(`SELECT m.ROWID AS id, m.text AS text, hex(m.attributedBody) AS ab, h.id AS handle
          FROM message m JOIN handle h ON m.handle_id = h.ROWID
          WHERE m.ROWID > ${Number(state.lastRow)} AND m.is_from_me = 0 AND m.item_type = 0
          ORDER BY m.ROWID LIMIT 50`);
        for (const r of rows) {
          state.lastRow = r.id;
          if (norm(r.handle) !== norm(to)) continue;
          const text = (r.text || decodeAttributed(r.ab) || "").trim();
          if (text) { dropShared(SH_IN, { text, at: Date.now() }); log(`received: ${clip(text, 120)}`); }
        }
        if (rows.length) writeJSON(HSTATE, state);
      }
      warned = false;
    } catch (e) {
      if (!warned) { log(`can't read Messages (${e.message}). Give Full Disk Access to ${process.execPath}`); warned = true; }
    }
    setTimeout(tick, 3000);
  };
  tick();
}

// ---------- main ----------
async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "helper") return helper();
  if (cmd === "send") { queue(rest.join(" "), { reply: true }); return; }
  if (cmd === "test") { process.exit((await imessage("J.A.R.V.I.S. online. Text \"help\" to see what I can do.")) ? 0 : 1); }
  if (cmd === "call") { process.exit((await facetimeCall(rest.join(" "))) ? 0 : 1); }
  if (cmd !== "run") { console.log("usage: relay.mjs run | send <text> | test | call"); process.exit(2); }

  const cfg = config();
  if (!cfg.enabled) { log("relay disabled in relay.json"); return; }
  const state = readJSON(STATE, {});
  if (cfg.transport !== "shared") try {
    if (!state.lastRow) { state.lastRow = (await sql("SELECT IFNULL(MAX(ROWID),0) AS id FROM message"))[0].id; writeJSON(STATE, state); }
  } catch (e) {
    log(`can't read Messages yet (${e.message}). Give Full Disk Access to ${process.execPath}`);
  }
  log(`relay up · to ${cfg.to || "(not set)"} · mode ${cfg.mode} · ${SELF}`);
  watchEvents();
  const tick = async () => {
    try { await drainOutbox(); } catch (e) { log("outbox:", e.message); }
    try { await pollMessages(state); } catch (e) { if (!state.warned) { log("messages:", e.message); state.warned = true; } }
    try { await repeatUnanswered(); } catch (e) { log("repeat:", e.message); }
    setTimeout(tick, config().pollSeconds * 1000);
  };
  tick();
}

main().catch((e) => { log("fatal:", e.stack || e.message); process.exit(1); });
