/**
 * Read-only facts from a terminal's own machine, for resume after restart. One Python string run with
 * exec("python3",["-c",HOST_HELPER,request],{on}). It reads only process tables, the open-file list of
 * named PIDs, Claude Code PID records and its own claim folder; never transcripts or session contents.
 */
import {machineIdentity} from './session-identity.js';
import {START_TIME_PY} from './codex-session-hook.js';

export const HOST_LIMITS=Object.freeze({terminals:64,children:8,output:1048576,request:65536});
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ADDRESS=/^t[0-9a-z]{1,63}$/,KEY=/^[A-Za-z0-9._-]{1,200}$/;

export const HOST_HELPER=START_TIME_PY+String.raw`
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

const unavailable=(on,code='UNAVAILABLE')=>Object.freeze({ok:false,code,machine:on});
async function call(io,on,request){
  const text=JSON.stringify(request);if(text.length>HOST_LIMITS.request)return unavailable(on,'REQUEST_TOO_LARGE');
  let result;try{result=await io.exec('python3',['-c',HOST_HELPER,text],{on});}catch{return unavailable(on,'HOST_UNAVAILABLE');}
  if(result?.code!==0||typeof result.stdout!=='string'||result.stdout.length>HOST_LIMITS.output)return unavailable(on,'HOST_UNAVAILABLE');
  try{const value=JSON.parse(result.stdout);if(value?.v===1&&typeof value.ok==='boolean')return value;}catch{}
  return unavailable(on,'INVALID_RESPONSE');
}
const pid=v=>Number.isSafeInteger(v)&&v>1?v:null;
const proc=v=>v&&pid(v.pid)?Object.freeze({pid:v.pid,ppid:Number.isSafeInteger(v.ppid)?v.ppid:null,name:typeof v.name==='string'?v.name.slice(0,64):null,startMs:Number.isSafeInteger(v.startMs)?v.startMs:null,ageMs:Number.isSafeInteger(v.ageMs)?v.ageMs:null}):null;
const found=v=>v&&typeof v.sessionId==='string'&&UUID.test(v.sessionId)?Object.freeze({sessionId:v.sessionId.toLowerCase(),via:v.via==='open-file'?'open-file':'pid-record'}):Object.freeze({code:typeof v?.code==='string'?v.code.slice(0,40):'UNAVAILABLE'});

/**
 * Process facts for terminals on one machine: {address, shellPid, foregroundPid}[] → Map(address → facts).
 * Claude and Grok lookups run only for the roots given. Never throws.
 */
export async function hostFacts(io,{machine=null,terminals=[],claudeRoot=null,grokRoot=null}={}){
  const on=machineIdentity(machine),asked=terminals.filter(t=>ADDRESS.test(t?.address??'')).slice(0,HOST_LIMITS.terminals).map(t=>({address:t.address,shellPid:pid(t.shellPid),foregroundPid:pid(t.foregroundPid)}));
  if(!asked.length)return Object.freeze({ok:true,machine:on,terminals:new Map()});
  const value=await call(io,on,{v:1,op:'facts',terminals:asked,claudeRoot:typeof claudeRoot==='string'?claudeRoot:null,grokRoot:typeof grokRoot==='string'?grokRoot:null});
  if(!value.ok||!Array.isArray(value.terminals))return unavailable(on,value.code||'INVALID_RESPONSE');
  const map=new Map(),known=new Set(asked.map(t=>t.address));
  for(const t of value.terminals){
    if(!known.has(t?.address))continue;
    const sessions=new Map();for(const s of Array.isArray(t.sessions)?t.sessions:[])if(pid(s?.pid))sessions.set(s.pid,Object.freeze({...(s.claude?{claude:found(s.claude)}:{}),...(s.grok?{grok:found(s.grok)}:{})}));
    map.set(t.address,Object.freeze({shell:proc(t.shell),foreground:proc(t.foreground),children:Object.freeze((Array.isArray(t.children)?t.children:[]).map(proc).filter(Boolean).slice(0,HOST_LIMITS.children)),sessions}));
  }
  return Object.freeze({ok:true,machine:on,terminals:map});
}

/** O_EXCL claim of one key on that machine: {ok, claimed}. A failed call is never a claim. */
export async function hostClaim(io,{machine=null,key,owner=''}={}){
  const on=machineIdentity(machine);if(typeof key!=='string'||!KEY.test(key))return unavailable(on,'INVALID_KEY');
  const value=await call(io,on,{v:1,op:'claim',key,owner:String(owner).slice(0,120)});
  return value.ok?Object.freeze({ok:true,claimed:value.claimed===true,machine:on}):unavailable(on,value.code);
}
