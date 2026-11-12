/**
 * Codex reports its exact session to a SessionStart hook (verified against Codex 0.167.0:
 * evidence/codex-session-probe.json). This hook labels the Herdr terminal that runs that Codex
 * with mission-control.codex-session=<pid>:<startMs>:<sessionId>, so Mission Control can type
 * `codex resume <id>` after the terminal's process is lost. Mission Control never writes Codex's
 * trust state: Codex asks the person to trust the hook once.
 */
import {machineIdentity} from './session-identity.js';

export const HOOK_FILE='mission-control-session-hook.py';
export const CODEX_LABEL='mission-control.codex-session';
export const HOOK_TIMEOUT_S=5;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_OUTPUT=65536;

/**
 * The one start-time routine the hook and the host helper both embed: whole seconds as epoch ms,
 * from /proc on Linux (stat field 22 plus btime) or `ps -o lstart=` with LC_ALL=C and TZ=UTC on macOS.
 * MC_RESTART_TEST_PROC points tests at a fixture /proc tree.
 */
export const START_TIME_PY=String.raw`
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

const HOOK_BODY=String.raw`
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

/** The script installed as <CODEX_HOME>/mission-control-session-hook.py. It prints nothing and always exits 0. */
export const HOOK_SCRIPT='#!/usr/bin/env python3\n# Mission Control: labels this Herdr terminal with the exact Codex session it runs.\n# Installed by Mission Control; remove it from Mission Control (Set up Codex resume).\n'+START_TIME_PY+HOOK_BODY;

/**
 * Install, status and remove on the machine itself. hooks.json is changed only by a text splice at the
 * end of hooks.SessionStart (or by creating the key, array or file), so every existing group keeps its
 * bytes and its index, and therefore its Codex trust key <path>:session_start:<group>:<handler>.
 */
export const HOOK_HELPER=String.raw`
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

/** mission-control.codex-session=<pid>:<startMs>:<uuid> → {pid, startMs, sessionId}, or null. */
export function parseCodexLabel(value){
  if(typeof value!=='string'||value.length>120)return null;
  const m=/^([1-9]\d{0,9}):(\d{1,15}):([0-9a-f-]{36})$/i.exec(value);
  if(!m||!UUID.test(m[3]))return null;
  const pid=Number(m[1]),startMs=Number(m[2]);
  return Number.isSafeInteger(pid)&&Number.isSafeInteger(startMs)?Object.freeze({pid,startMs,sessionId:m[3].toLowerCase()}):null;
}

/** Runs install, status or remove on that machine. Never throws; failures come back as {ok:false, code, message}. */
export async function codexHook(io,op,{machine=null,timeout=HOOK_TIMEOUT_S}={}){
  if(!['install','status','remove'].includes(op))return Object.freeze({ok:false,code:'INVALID_REQUEST',message:'Unsupported Codex hook action.'});
  const on=machineIdentity(machine),request=JSON.stringify({v:1,op,timeout,...(op==='remove'?{}:{script:HOOK_SCRIPT})});
  let result;try{result=await io.exec('python3',['-c',HOOK_HELPER,request],{on});}catch{return Object.freeze({ok:false,code:'HOST_UNAVAILABLE',message:`${on??'This computer'} could not run its Codex hook helper.`});}
  if(result?.code!==0||typeof result.stdout!=='string'||result.stdout.length>MAX_OUTPUT)return Object.freeze({ok:false,code:'HOST_UNAVAILABLE',message:`${on??'This computer'} could not run its Codex hook helper (python3 is required).`});
  try{const value=JSON.parse(result.stdout);if(value&&typeof value==='object'&&typeof value.ok==='boolean')return Object.freeze({...value,machine:on});}catch{}
  return Object.freeze({ok:false,code:'INVALID_RESPONSE',message:'The Codex hook helper returned an invalid answer.'});
}
