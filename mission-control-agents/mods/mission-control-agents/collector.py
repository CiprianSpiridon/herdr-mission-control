"""Bounded read-only protocol. Provider parsers are composed by the builder."""
import base64
import datetime
import hashlib
import heapq
import json
import os
import stat
import time

COLLECTOR_VERSION = 1
COLLECTOR_MAX_BYTES = 4 * 1024 * 1024
COLLECTOR_MAX_FILE = 320 * 1024
COLLECTOR_MAX_REQUEST = 65536
COLLECTOR_PROVIDERS = ("codex", "claude", "grok")
COLLECTOR_CACHE_FILES = {"codex": "codex-app-server.json", "claude": "claude-statusline.json", "grok": "grok-cli-billing.json"}


class CollectorError(Exception):
    def __init__(self, code, reason):
        self.code, self.reason = code, reason
        super().__init__(reason)


def collector_fail(code, reason):
    raise CollectorError(code, reason)


def collector_digest(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def collector_text(value, maximum=512):
    return isinstance(value, str) and 0 < len(value) <= maximum and not any(ord(c) < 32 for c in value)


def collector_number(value, nullable=True):
    return (value is None and nullable) or (type(value) in (int, float) and 0 <= value < float("inf"))


def collector_time(value):
    return collector_number(value) and (value is None or value <= 8640000000000000)


def collector_timestamp(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
        return int(parsed.timestamp() * 1000) if parsed.tzinfo is not None else None
    except (ValueError, OverflowError):
        return None


def collector_legacy_windows(rows, observations):
    """Strict sanitized UsageWindow DTO conversion; no account inference."""
    if not isinstance(rows, list) or len(rows) > 16 or not isinstance(observations, list):
        return []
    result = []
    for row in rows:
        if not isinstance(row, dict) or row.get("kind") not in ("five_hour", "weekly", "monthly"):
            continue
        used, remaining = row.get("used_percent"), row.get("remaining_percent")
        if not collector_number(used, False) or not collector_number(remaining, False) or used > 100 or remaining > 100 or abs(used + remaining - 100) > 0.01:
            continue
        dates = [o.get("observed_at_unix") for o in observations if isinstance(o, dict) and o.get("kind") == row["kind"] and collector_number(o.get("observed_at_unix"), False)]
        reset = row.get("resets_at")
        result.append({"name": row["kind"], "remainingPercent": remaining, "observedAt": max(dates) * 1000 if dates else None, "resetsAt": reset * 1000 if collector_number(reset, False) else collector_timestamp(reset)})
    return result


def collector_path(value):
    if not collector_text(value, 4096) or not os.path.isabs(value) or os.path.normpath(value) != value or value == "/":
        collector_fail("INVALID_ROOT", "An explicit canonical absolute metadata root is required.")
    return value


def collector_forbidden(value):
    for part in value.lower().split(os.sep):
        if part in (".ssh", ".aws", ".azure", "keychains", "auth", "credentials", "secrets"):
            return True
        if part in ("auth.json", ".credentials.json", "credentials.json", "config.json", "settings.json", "keys.json") or part.endswith((".pem", ".key", ".p12")):
            return True
    return False


def collector_open_directory(path):
    """Walk from / with openat: no ancestor symlink can redirect a read."""
    fd = os.open(os.sep, os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.split(os.sep)[1:]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except BaseException:
        os.close(fd)
        raise


def collector_scope(source):
    return {k: source.get(k) for k in ("machine", "provider", "credentialScope", "providerRoot")}


def collector_identity(value, source):
    return isinstance(value, dict) and set(value) == {"machine", "provider", "credentialScope", "providerRoot", "sessionId"} and all(value.get(k) == source.get(k) for k in ("machine", "provider", "credentialScope", "providerRoot")) and collector_text(value.get("sessionId"), 200)


def collector_request(request):
    if not isinstance(request, dict) or request.get("v") != 1 or request.get("operation") not in ("list", "observe", "adopt"):
        collector_fail("INVALID_REQUEST", "Unsupported collector version or operation.")
    source = request.get("source")
    if not isinstance(source, dict) or source.get("v") != 1 or source.get("provider") not in COLLECTOR_PROVIDERS:
        collector_fail("INVALID_SOURCE", "A supported versioned provider source is required.")
    if source.get("enabled") is not True:
        collector_fail("SOURCE_DISABLED", "This metadata source is disabled.")
    if source.get("machine") is not None and not collector_text(source["machine"], 128):
        collector_fail("INVALID_SOURCE", "Invalid source machine identity.")
    if not collector_text(source.get("credentialScope"), 200):
        collector_fail("INVALID_SOURCE", "An explicit credential profile identity is required.")
    provider_root = collector_path(source.get("providerRoot"))
    home = os.path.realpath(os.path.expanduser("~"))
    roots = source.get("roots")
    cache_roots = source.get("cacheRoots", [])
    if not isinstance(roots, list) or not 1 <= len(roots) <= 8 or not isinstance(cache_roots, list) or len(cache_roots) > 4:
        collector_fail("INVALID_ROOT", "Configure one to eight session roots and at most four cache roots.")
    for root in roots + cache_roots:
        collector_path(root)
        if root in (home, provider_root, "/Users", "/home", "/tmp", "/private/tmp") or collector_forbidden(root) or os.path.commonpath([provider_root, root]) == root:
            collector_fail("INVALID_ROOT", "Broad, profile, credential or ancestor roots cannot be scanned.")
        if os.path.lexists(root) and (os.path.realpath(root) != root or not os.path.isdir(root)):
            collector_fail("UNSAFE_ROOT", "Metadata roots must be canonical directories without symlink components.")
    selected = request.get("roots", roots + cache_roots)
    if not isinstance(selected, list) or not selected or any(root not in roots + cache_roots for root in selected):
        collector_fail("UNKNOWN_ROOT", "The requested root is outside the configured source allowlist.")
    limit = request.get("limit", 50)
    if type(limit) is not int or not 1 <= limit <= 50:
        collector_fail("INVALID_LIMIT", "A collector page contains one to fifty observations.")
    identities = request.get("identities", [])
    if not isinstance(identities, list) or len(identities) > 50 or any(not collector_identity(v, source) for v in identities):
        collector_fail("INVALID_IDENTITY", "Requested sessions must match the full source identity.")
    if request["operation"] == "observe" and not identities:
        collector_fail("INVALID_IDENTITY", "Observe requires explicit exact session identities.")
    return source, list(dict.fromkeys(selected)), limit


def collector_validate_observation(value, source):
    if not isinstance(value, dict) or value.get("state") not in ("available", "unavailable"):
        collector_fail("INVALID_OBSERVATION", "The provider returned an invalid observation envelope.")
    identity, provenance = value.get("identity"), value.get("provenance")
    if (identity is not None and not collector_identity(identity, source)) or (value["state"] == "available" and identity is None):
        collector_fail("INVALID_OBSERVATION", "The provider observation has a different session scope.")
    if not isinstance(provenance, dict) or set(provenance) != {"provider", "format", "formatVersion", "sourceDigest", "observedAt"} or provenance["provider"] != source["provider"] or not collector_text(provenance["format"], 80) or not (provenance["formatVersion"] is None or collector_text(provenance["formatVersion"], 80)) or not isinstance(provenance["sourceDigest"], str) or len(provenance["sourceDigest"]) != 64 or any(c not in "0123456789abcdef" for c in provenance["sourceDigest"]) or not collector_time(provenance["observedAt"]):
        collector_fail("INVALID_OBSERVATION", "The provider observation lacks valid provenance.")
    common = {"state", "identity", "provenance"}
    if value["state"] == "unavailable":
        if set(value) != common | {"code", "reason"} or not collector_text(value["code"], 80) or not collector_text(value["reason"], 300):
            collector_fail("INVALID_OBSERVATION", "An unavailable observation needs a bounded code and reason.")
        return value
    if not common | {"context", "quota"} <= set(value) or set(value) - common - {"context", "quota", "title", "cwd"}:
        collector_fail("INVALID_OBSERVATION", "Unexpected provider fields cannot be published.")
    if "title" in value and not collector_text(value["title"], 200):
        collector_fail("INVALID_OBSERVATION", "Reported session titles must be bounded metadata.")
    if "cwd" in value:
        collector_path(value["cwd"])
    context = value["context"]
    fields = {"usedTokens", "windowTokens", "compactionLimitTokens", "reportedUsedPercent"}
    if context is not None and (not isinstance(context, dict) or set(context) != fields or any(not collector_number(context[k]) for k in fields) or (context["reportedUsedPercent"] is not None and context["reportedUsedPercent"] > 100)):
        collector_fail("INVALID_OBSERVATION", "The provider context fields are invalid.")
    quota = value["quota"]
    if quota is not None:
        if not isinstance(quota, dict) or set(quota) != {"proof", "windows"}:
            collector_fail("INVALID_OBSERVATION", "The provider quota envelope is invalid.")
        proof = quota["proof"]
        if not isinstance(proof, dict) or set(proof) != {"kind", "machine", "credentialScope", "accountId", "poolId"} or proof["kind"] not in ("provider-account", "session-account-digest", "session-report", "none") or proof["machine"] != source.get("machine") or proof["credentialScope"] != source["credentialScope"] or any(proof[k] is not None and not collector_text(proof[k], 200) for k in ("accountId", "poolId")):
            collector_fail("INVALID_OBSERVATION", "The provider quota identity is invalid.")
        if not isinstance(quota["windows"], list) or len(quota["windows"]) > 16:
            collector_fail("INVALID_OBSERVATION", "The provider quota windows are invalid.")
        for window in quota["windows"]:
            if not isinstance(window, dict) or set(window) != {"name", "remainingPercent", "observedAt", "resetsAt"} or not collector_text(window["name"], 80) or not collector_number(window["remainingPercent"], False) or window["remainingPercent"] > 100 or any(not collector_time(window[k]) for k in ("observedAt", "resetsAt")):
                collector_fail("INVALID_OBSERVATION", "The provider quota window is invalid.")
    return value


class CollectorReaders:
    """Only this capability opens files; parsers receive no arbitrary-file IO."""
    def __init__(self, request, source, roots, limit, clock=time.monotonic):
        self.request, self.source, self.roots, self.limit = request, source, roots, limit
        self.clock, self.deadline, self.bytes_read = clock, clock() + 10, 0
        self.errors, self.entries, self.index_truncated = [], [], False
        self.offset, self.consumed, self.stop_reason, self.item_offset = 0, 0, None, 0
        self.scope_digest = collector_digest(json.dumps({"source": source, "roots": roots}, sort_keys=True))

    def check_time(self):
        if self.clock() >= self.deadline:
            collector_fail("DEADLINE", "The metadata scan reached its ten-second deadline.")

    def enumerate(self):
        visited = 0
        indexed = []
        requested = [identity["sessionId"] for identity in self.request.get("identities", [])]
        for root in self.roots:
            if not os.path.exists(root):
                self.errors.append({"state": "error", "code": "SOURCE_MISSING", "reason": "A configured metadata directory is missing.", "scope": collector_scope(self.source)})
                continue
            pending = [(root, 0)]
            while pending:
                self.check_time()
                directory, depth = pending.pop()
                if depth > 16 or visited >= 10000:
                    self.index_truncated = True
                    continue
                visited += 1
                directory_fd = None
                try:
                    directory_fd = collector_open_directory(directory)
                    children = []
                    with os.scandir(directory_fd) as scan:
                        for child in scan:
                            self.check_time()
                            if visited >= 10000:
                                self.index_truncated = True
                                break
                            visited += 1
                            children.append(child)
                    children.sort(key=lambda child: child.name)
                    for child in reversed(children):
                        self.check_time()
                        child_path = os.path.join(directory, child.name)
                        if child.is_symlink() or collector_forbidden(child_path):
                            continue
                        if child.is_dir(follow_symlinks=False):
                            if not child.name.startswith("."):
                                pending.append((child_path, depth + 1))
                            continue
                        cache = root in self.source.get("cacheRoots", [])
                        allowed = child.name == COLLECTOR_CACHE_FILES[self.source["provider"]] if cache else child.name.endswith((".jsonl", ".jsonl.zst")) or (self.source["provider"] == "grok" and child.name.endswith(".json"))
                        if not allowed or not child.is_file(follow_symlinks=False):
                            continue
                        info = child.stat(follow_symlinks=False)
                        relative = str(self.roots.index(root)) + "/" + os.path.relpath(child_path, root)
                        entry = {"path": child_path, "root": root, "relative": relative, "cache": cache, "size": info.st_size, "mtimeMs": info.st_mtime_ns // 1000000, "mtimeNs": info.st_mtime_ns, "device": info.st_dev, "inode": info.st_ino, "sourceDigest": collector_digest(relative + ":" + str(info.st_ino) + ":" + str(info.st_mtime_ns) + ":" + str(info.st_size))}
                        # Filename matching only prioritizes IO. A parser still
                        # has to prove the exact ID from metadata before binding.
                        priority = (2 if cache else 1 if any(session in relative for session in requested) else 0, info.st_mtime_ns, relative)
                        if len(indexed) < 1000:
                            heapq.heappush(indexed, (priority, entry))
                        else:
                            self.index_truncated = True
                            if priority > indexed[0][0]:
                                heapq.heapreplace(indexed, (priority, entry))
                except OSError:
                    self.errors.append({"state": "error", "code": "DIRECTORY_UNAVAILABLE", "reason": "A metadata directory changed or is unreadable.", "scope": collector_scope(self.source)})
                finally:
                    if directory_fd is not None:
                        os.close(directory_fd)
        self.entries = [entry for _, entry in sorted(indexed, key=lambda item: item[0], reverse=True)]
        self.snapshot_digest = collector_digest(json.dumps([(e["relative"], e["device"], e["inode"], e["mtimeNs"] if e["cache"] else None) for e in self.entries]))
        cursor = self.request.get("cursor")
        if cursor is not None:
            try:
                if not isinstance(cursor, str) or len(cursor) > 512:
                    raise ValueError()
                parsed = json.loads(base64.urlsafe_b64decode(cursor.encode("ascii")))
                if parsed.get("v") != 1 or parsed.get("scope") != self.scope_digest or parsed.get("snapshot") != self.snapshot_digest or type(parsed.get("offset")) is not int or not 0 <= parsed["offset"] <= len(self.entries):
                    raise ValueError()
                self.offset = parsed["offset"]
                self.item_offset = parsed.get("item", 0)
                if type(self.item_offset) is not int or not 0 <= self.item_offset < 1000:
                    raise ValueError()
            except (ValueError, TypeError, UnicodeError):
                collector_fail("STALE_CURSOR", "The scan cursor belongs to a different source or file snapshot; restart this scope.")
        self.selected = self.entries[self.offset:self.offset + self.limit]

    def _open(self, entry):
        self.check_time()
        if entry not in self.selected or collector_forbidden(entry["path"]):
            collector_fail("UNKNOWN_FILE", "Parsers may read only the selected metadata page.")
        root = entry["root"]
        if os.path.realpath(root) != root:
            collector_fail("UNSAFE_PATH", "The metadata root changed after validation.")
        parts = os.path.relpath(entry["path"], root).split(os.sep)
        if any(part in ("", ".", "..") for part in parts):
            collector_fail("UNSAFE_PATH", "The metadata path escaped its configured root.")
        directory = collector_open_directory(root)
        try:
            for part in parts[:-1]:
                next_directory = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                os.close(directory)
                directory = next_directory
            fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
        finally:
            os.close(directory)
        current = os.fstat(fd)
        if not stat.S_ISREG(current.st_mode) or current.st_ino != entry["inode"] or current.st_dev != entry["device"] or current.st_size != entry["size"] or current.st_mtime_ns != entry["mtimeNs"]:
            os.close(fd)
            collector_fail("FILE_ROTATED", "The selected metadata file was replaced; retry its scope.")
        return fd, current

    def slices(self, entry):
        """At most 64KiB head + 256KiB tail; no unbounded transcript reads."""
        if entry["path"].endswith(".zst"):
            collector_fail("UNSUPPORTED_COMPRESSION", "Compressed metadata is unavailable without a verified bounded decoder.")
        expected = min(entry["size"], COLLECTOR_MAX_FILE)
        if self.bytes_read + expected > COLLECTOR_MAX_BYTES:
            collector_fail("BYTE_LIMIT", "The scan reached its four-MiB content budget; continue its cursor.")
        fd, before = self._open(entry)
        try:
            head = os.read(fd, min(before.st_size, 64 * 1024))
            self.bytes_read += len(head)
            tail = b""
            tail_offset = len(head)
            if before.st_size > len(head):
                tail_offset = max(len(head), before.st_size - 256 * 1024)
                os.lseek(fd, tail_offset, os.SEEK_SET)
                tail = os.read(fd, min(256 * 1024, before.st_size - tail_offset))
                self.bytes_read += len(tail)
            self.check_time()
            after = os.fstat(fd)
            if (before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns):
                collector_fail("FILE_ROTATED", "The metadata file changed while reading; retry its scope.")
            return head, tail, tail_offset, before.st_size
        finally:
            os.close(fd)

    def jsonl(self, entry):
        head, tail, tail_offset, size = self.slices(entry)
        records, malformed = [], False
        pieces = [head]
        if tail:
            pieces.append(tail if tail_offset == len(head) else tail.partition(b"\n")[2])
        if len(pieces) == 2 and tail_offset == len(head):
            pieces = [head + tail]
        for number, piece in enumerate(pieces):
            lines = piece.splitlines()
            if number == 0 and tail_offset > len(head) and not piece.endswith(b"\n"):
                lines = lines[:-1]
            for line in lines:
                self.check_time()
                if not line.strip():
                    continue
                try:
                    value = json.loads(line)
                    if isinstance(value, dict):
                        records.append(value)
                    else:
                        malformed = True
                except (ValueError, UnicodeError, RecursionError):
                    malformed = True
        head_records = []
        head_lines = head.splitlines()
        if size > len(head) and not head.endswith(b"\n"):
            head_lines = head_lines[:-1]
        for line in head_lines:
            try:
                value = json.loads(line)
                if isinstance(value, dict):
                    head_records.append(value)
            except (ValueError, UnicodeError, RecursionError):
                pass
        return {"records": records, "headRecords": head_records, "partial": size > len(head) + len(tail), "malformed": malformed}

    def json_object(self, entry):
        if entry["size"] > COLLECTOR_MAX_FILE:
            collector_fail("FILE_TOO_LARGE", "The sanitized observation exceeds the bounded file size.")
        head, tail, _, _ = self.slices(entry)
        try:
            value = json.loads(head + tail)
            if not isinstance(value, dict):
                raise ValueError()
            return value
        except (ValueError, UnicodeError, RecursionError):
            collector_fail("MALFORMED_FILE", "The sanitized observation is not a valid JSON object.")

    def provenance(self, entry, format_name, observed_at=None, version=None):
        return {"provider": self.source["provider"], "format": format_name, "formatVersion": version, "sourceDigest": entry["sourceDigest"], "observedAt": observed_at}

    def unavailable(self, entry, code, reason):
        return {"state": "unavailable", "identity": None, "provenance": self.provenance(entry, "unavailable"), "code": code, "reason": reason}

    def available(self, entry, session_id, format_name, observed_at=None, context=None, quota=None, title=None, cwd=None, version=None):
        identity = dict(collector_scope(self.source), sessionId=session_id)
        result = {"state": "available", "identity": identity, "provenance": self.provenance(entry, format_name, observed_at, version), "context": context, "quota": quota}
        if title is not None:
            result["title"] = title
        if cwd is not None:
            result["cwd"] = cwd
        return result

    def collect(self, parse_one):
        observations = []
        for entry in self.selected:
            if len(observations) >= self.limit:
                break
            try:
                self.check_time()
                value = parse_one(entry, self)
                values = value if isinstance(value, list) else [] if value is None else [value]
                if len(values) > 1000:
                    collector_fail("INVALID_OBSERVATION", "One metadata file exceeds the bounded observation index.")
                for value in values:
                    collector_validate_observation(value, self.source)
                if self.request["operation"] == "observe":
                    values = [v for v in values if v["identity"] in self.request["identities"] or v["identity"] is None]
                values = values[self.item_offset:]
                room = self.limit - len(observations)
                observations.extend(values[:room])
                if len(values) > room:
                    self.item_offset += room
                    self.stop_reason = "PAGE_LIMIT"
                    break
                self.item_offset = 0
                self.consumed += 1
                if len(observations) == self.limit:
                    break
            except CollectorError as error:
                if error.code in ("BYTE_LIMIT", "DEADLINE"):
                    self.stop_reason = error.code
                    break
                observations.append(self.unavailable(entry, error.code, error.reason))
                self.item_offset = 0
                self.consumed += 1
            except (OSError, ValueError, UnicodeError, RecursionError):
                observations.append(self.unavailable(entry, "FILE_UNAVAILABLE", "The metadata file is missing, rotated, malformed or unreadable."))
                self.item_offset = 0
                self.consumed += 1
        return observations

    def cursor(self):
        offset = self.offset + self.consumed
        if offset >= len(self.entries):
            return None
        return base64.urlsafe_b64encode(json.dumps({"v": 1, "scope": self.scope_digest, "snapshot": self.snapshot_digest, "offset": offset, "item": self.item_offset}, separators=(",", ":")).encode()).decode()


COLLECTOR_UUID = "0123456789abcdef-"


def collector_session_id(value):
    """A provider-written conversation UUID, never a guessed or partial one."""
    return isinstance(value, str) and len(value) == 36 and all(c in COLLECTOR_UUID for c in value.lower()) and [len(p) for p in value.split("-")] == [8, 4, 4, 4, 12]


def collector_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except OSError:
        return False


def collector_adopt(request, source):
    """Map running Claude Code processes to their exact conversations from Claude Code's own PID records.

    Reads only <providerRoot>/sessions/<pid>.json (never key, auth or job-state files) and runs nothing.
    Claude Code rewrites its record whenever a process starts, so a record is accepted only when it names
    this PID and its recorded start falls inside the terminal's life (notBefore is the terminal's creation).
    A client attached to a background job follows parkedJobId to exactly one record of that job."""
    import sys
    if source["provider"] != "claude":
        collector_fail("UNSUPPORTED_ADOPTION", "Only Claude Code writes exact process-to-session records.")
    asked = request.get("pids")
    if not isinstance(asked, list) or not 1 <= len(asked) <= 64 or any(not isinstance(a, dict) or type(a.get("pid")) is not int or not 1 < a["pid"] < 2 ** 31 or type(a.get("notBefore")) is not int or a["notBefore"] < 0 for a in asked):
        collector_fail("INVALID_REQUEST", "Pass one to 64 foreground processes with their terminal creation times.")
    pids = [a["pid"] for a in asked]
    if len(set(pids)) != len(pids):
        collector_fail("INVALID_REQUEST", "Each foreground process is asked about once.")
    not_before = {a["pid"]: a["notBefore"] for a in asked}
    domain = {"darwin": "darwin"}.get(sys.platform, "linux" if sys.platform.startswith("linux") else None)
    now = int(time.time() * 1000)
    results = {pid: {"pid": pid, "code": "NO_RECORD"} for pid in pids}
    try:
        root_fd = collector_open_directory(source["providerRoot"])
    except OSError:
        return [results[p] for p in pids]
    records = {}
    try:
        try:
            dir_fd = os.open("sessions", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
        except OSError:
            return [results[p] for p in pids]
        try:
            names = [n for n in os.listdir(dir_fd) if n.endswith(".json") and n[:-5].isdigit()][:1024]
            for name in names:
                try:
                    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=dir_fd)
                except OSError:
                    continue
                try:
                    info = os.fstat(fd)
                    if not stat.S_ISREG(info.st_mode) or info.st_size > 65536:
                        continue
                    raw = os.read(fd, 65537)
                finally:
                    os.close(fd)
                try:
                    record = json.loads(raw.decode("utf-8"))
                except (ValueError, UnicodeError):
                    continue
                if isinstance(record, dict) and record.get("pid") == int(name[:-5]) and record.get("pidDomain") == domain:
                    records[record["pid"]] = record
        finally:
            os.close(dir_fd)
    finally:
        os.close(root_fd)
    for pid in pids:
        record = records.get(pid)
        if record is None:
            continue
        started = record.get("startedAt")
        if record.get("kind") != "interactive" or type(started) not in (int, float) or not not_before[pid] - 5000 <= started <= now + 60000:
            results[pid] = {"pid": pid, "code": "PROCESS_MISMATCH"}
            continue
        parked = record.get("parkedJobId")
        if parked is None:
            results[pid] = {"pid": pid, "sessionId": record["sessionId"], "via": "pid-record"} if collector_session_id(record.get("sessionId")) else {"pid": pid, "code": "INVALID_RECORD"}
            continue
        if not isinstance(parked, str) or not 4 <= len(parked) <= 64 or not all(c in COLLECTOR_UUID for c in parked.lower()):
            results[pid] = {"pid": pid, "code": "INVALID_RECORD"}
            continue
        jobs = [r for r in records.values() if r.get("kind") == "bg" and collector_session_id(r.get("sessionId")) and (r["sessionId"] == parked or r["sessionId"].startswith(parked + "-"))]
        live = [r for r in jobs if collector_alive(r["pid"])]
        chosen = live if len(live) == 1 else jobs if len(jobs) == 1 else []
        results[pid] = {"pid": pid, "sessionId": chosen[0]["sessionId"], "via": "parked-job"} if chosen else {"pid": pid, "code": "AMBIGUOUS_JOB" if jobs else "JOB_UNAVAILABLE"}
    return [results[p] for p in pids]


def run_collector(request, registry, clock=time.monotonic):
    source = {}
    try:
        source, roots, limit = collector_request(request)
        if request["operation"] == "adopt":
            return {"v": 1, "scope": collector_scope(source), "adopt": collector_adopt(request, source)}
        if source["provider"] not in registry:
            collector_fail("UNSUPPORTED_PARSER", "No verified parser is installed for this provider.")
        readers = CollectorReaders(request, source, roots, limit, clock)
        readers.enumerate()
        observations = registry[source["provider"]](request, readers)
        if not isinstance(observations, list) or len(observations) > 50:
            collector_fail("INVALID_OBSERVATION", "Provider output exceeds the observation page boundary.")
        for observation in observations:
            collector_validate_observation(observation, source)
        cursor = readers.cursor()
        return {"v": 1, "scope": collector_scope(source), "data": observations, "errors": readers.errors, "cursor": cursor, "truncated": bool(cursor or readers.index_truncated or readers.stop_reason), "scan": {"indexed": len(readers.entries), "consumed": readers.consumed, "bytes": readers.bytes_read, "indexLimitReached": readers.index_truncated, "stopReason": readers.stop_reason}}
    except CollectorError as error:
        return {"v": 1, "state": "error", "code": error.code, "reason": error.reason, "scope": collector_scope(source)}
    except (OSError, ValueError, TypeError, UnicodeError, RecursionError):
        return {"v": 1, "state": "error", "code": "SOURCE_UNAVAILABLE", "reason": "The configured metadata scope is unavailable or malformed.", "scope": collector_scope(source)}


def collector_main(registry):
    import sys
    try:
        if len(sys.argv) != 2 or len(sys.argv[1].encode("utf-8")) > COLLECTOR_MAX_REQUEST:
            collector_fail("REQUEST_TOO_LARGE", "Pass one collector request of at most 64 KiB.")
        request = json.loads(sys.argv[1])
        result = run_collector(request, registry)
    except (CollectorError, ValueError, UnicodeError) as error:
        result = {"v": 1, "state": "error", "code": getattr(error, "code", "INVALID_JSON"), "reason": getattr(error, "reason", "The collector request is not valid JSON."), "scope": None}
    print(json.dumps(result, separators=(",", ":"), allow_nan=False))


"""Observed Codex rollout schema; no auth or transcript fields are published."""


def codex_number(value):
    return value if collector_number(value, False) else None


def codex_quota(limits, source, observed_at):
    if not isinstance(limits, dict):
        return None
    windows = []
    for name in ("primary", "secondary"):
        window = limits.get(name)
        if not isinstance(window, dict):
            continue
        used = codex_number(window.get("used_percent"))
        if used is None or used > 100:
            continue
        minutes = codex_number(window.get("window_minutes"))
        resets = codex_number(window.get("resets_at"))
        windows.append({"name": str(int(minutes)) + "m" if minutes is not None and minutes > 0 else name, "remainingPercent": 100 - used, "observedAt": observed_at, "resetsAt": resets * 1000 if resets is not None else None})
    if not windows:
        return None
    pool = limits.get("limit_id")
    # session_meta.creator_account_id is creation-time evidence, not the
    # serving account after a resume. This report remains session-local.
    return {"proof": {"kind": "session-report", "machine": source.get("machine"), "credentialScope": source["credentialScope"], "accountId": None, "poolId": pool if collector_text(pool, 200) else None}, "windows": windows}


def codex_cache(entry, readers):
    raw = readers.json_object(entry)
    if raw.get("provider") != "codex" or raw.get("source") != "codex-app-server" or codex_number(raw.get("fetched_at_unix")) is None:
        return readers.unavailable(entry, "INVALID_CACHE", "The configured cache has a different provider/source or missing fetch time.")
    # A profile-wide account_id does not establish the serving account for
    # an exact thread. Only exact session context is accepted from this cache.
    contexts = raw.get("session_contexts", {})
    if not isinstance(contexts, dict) or readers.request["operation"] != "observe":
        return []
    result = []
    for identity in readers.request["identities"]:
        context = contexts.get(identity["sessionId"])
        percent = codex_number(context.get("used_percent")) if isinstance(context, dict) else None
        if percent is not None and percent <= 100:
            # A merged cache's fetch time does not date each saved context.
            result.append(readers.available(entry, identity["sessionId"], "legacy-codex-app-server", None, {"usedTokens": None, "windowTokens": None, "compactionLimitTokens": None, "reportedUsedPercent": percent}))
    return result


def codex_rollout(entry, readers):
    if entry["cache"]:
        return codex_cache(entry, readers)
    parsed = readers.jsonl(entry)
    # The first header is canonical. Forked logs may contain copied parent
    # headers later: github.com/openai/codex/.../thread-store/src/types.rs.
    header = next((r.get("payload") for r in parsed["headRecords"] if r.get("type") == "session_meta" and isinstance(r.get("payload"), dict)), None)
    if not header or not collector_text(header.get("id"), 200):
        return readers.unavailable(entry, "MISSING_SESSION_ID", "The bounded header has no supported canonical Codex thread ID.")
    session_id = header["id"]
    context, quota, observed_at = None, None, collector_timestamp(header.get("timestamp"))
    inherited = False
    forked = header.get("forked_from_id") is not None or header.get("history_base") is not None
    for record in parsed["records"]:
        payload = record.get("payload")
        if not isinstance(payload, dict):
            continue
        if record.get("type") == "session_meta":
            inherited = payload.get("id") != session_id
            forked = forked or inherited
            continue
        if record.get("type") != "event_msg" or payload.get("type") != "token_count":
            continue
        thread = payload.get("thread_id")
        if thread is not None and thread != session_id:
            continue
        if thread is None and (inherited or (forked and parsed["partial"])):
            continue
        at = collector_timestamp(record.get("timestamp"))
        info = payload.get("info")
        # A token_count with explicit unknown usage invalidates old context.
        context = None
        observed_at = at
        if isinstance(info, dict):
            usage = info.get("last_token_usage")
            used = codex_number(usage.get("total_tokens")) if isinstance(usage, dict) else None
            window = codex_number(info.get("model_context_window", payload.get("model_context_window")))
            if used is not None or window is not None:
                context = {"usedTokens": used, "windowTokens": window if window and window > 0 else None, "compactionLimitTokens": None, "reportedUsedPercent": None}
        if isinstance(payload.get("rate_limits"), dict):
            quota = codex_quota(payload["rate_limits"], readers.source, at)
    cwd = header.get("cwd")
    version = header.get("cli_version")
    return readers.available(entry, session_id, "codex-rollout-jsonl", observed_at, context, quota, cwd=cwd if isinstance(cwd, str) and os.path.isabs(cwd) else None, version=version if collector_text(version, 80) else None)


def collect_codex(request, readers):
    return readers.collect(codex_rollout)


"""Claude metadata and explicitly configured sanitized statusline snapshots."""


def claude_number(value):
    return value if collector_number(value, False) else None


def claude_cache(entry, readers):
    raw = readers.json_object(entry)
    if raw.get("provider") != "claude" or raw.get("source") != "claude-statusline" or claude_number(raw.get("fetched_at_unix")) is None:
        return readers.unavailable(entry, "INVALID_CACHE", "The configured statusline cache has an invalid provider/source or fetch time.")
    if readers.request["operation"] != "observe":
        return []
    result = []
    for identity in readers.request["identities"]:
        session = identity["sessionId"]
        context = raw.get("session_contexts", {}).get(session) if isinstance(raw.get("session_contexts"), dict) else None
        percent = claude_number(context.get("used_percent")) if isinstance(context, dict) else None
        # Newer snapshots date each session's reading by that session's own last activity, which is
        # when its status line last reported the percentage. A global fetch time never dates it.
        activity = context.get("cache") if isinstance(context, dict) else None
        context_at = int(activity["last_activity_unix"] * 1000) if isinstance(activity, dict) and activity.get("session_id") == session and claude_number(activity.get("last_activity_unix")) is not None else None
        context = {"usedTokens": None, "windowTokens": None, "compactionLimitTokens": None, "reportedUsedPercent": percent} if percent is not None and percent <= 100 else None
        quota = None
        # Legacy profile/credential scopes and global windows never establish
        # the account of this conversation. Only the exact session map does.
        if raw.get("session_quota_only") is True:
            rows = raw.get("session_windows", {}).get(session, []) if isinstance(raw.get("session_windows"), dict) else []
            observations = raw.get("session_quota_observations", {}).get(session, []) if isinstance(raw.get("session_quota_observations"), dict) else []
            windows = collector_legacy_windows(rows, observations)
            if windows:
                digest = raw.get("session_accounts", {}).get(session) if isinstance(raw.get("session_accounts"), dict) else None
                proven = isinstance(digest, str) and len(digest) == 64 and all(c in "0123456789abcdef" for c in digest)
                quota = {"proof": {"kind": "session-account-digest" if proven else "session-report", "machine": readers.source.get("machine"), "credentialScope": readers.source["credentialScope"], "accountId": digest if proven else None, "poolId": None}, "windows": windows}
        if context is not None or quota is not None:
            # Quota windows carry their own dates; context is dated only by its own session's activity.
            result.append(readers.available(entry, session, "legacy-claude-statusline", context_at if context is not None else None, context, quota))
    return result


def claude_session(entry, readers):
    if entry["cache"]:
        return claude_cache(entry, readers)
    parsed = readers.jsonl(entry)
    records = parsed["records"]
    ids = {r["sessionId"] for r in records if collector_text(r.get("sessionId"), 200)}
    if len(ids) != 1:
        return readers.unavailable(entry, "AMBIGUOUS_SESSION" if ids else "MISSING_SESSION_ID", "The bounded Claude records do not establish one exact conversation.")
    session = next(iter(ids))
    context, title, cwd, version, observed_at = None, None, None, None, None
    for record in records:
        if record.get("sessionId") != session:
            continue
        if collector_text(record.get("cwd"), 4096) and os.path.isabs(record["cwd"]):
            cwd = record["cwd"]
        if collector_text(record.get("version"), 80):
            version = record["version"]
        if record.get("type") in ("ai-title", "custom-title"):
            value = record.get("aiTitle") if record["type"] == "ai-title" else record.get("customTitle")
            if collector_text(value, 200):
                title = value
        message = record.get("message")
        usage = message.get("usage") if isinstance(message, dict) else None
        if record.get("type") != "assistant" or not isinstance(usage, dict):
            continue
        observed_at = collector_timestamp(record.get("timestamp"))
        values = [claude_number(usage.get(k)) for k in ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens")]
        # These are reported token counts. No model-name capacity or guessed
        # autocompaction percentage is introduced to turn them into a ratio.
        used = sum(values) if all(v is not None for v in values) else None
        context = {"usedTokens": used, "windowTokens": None, "compactionLimitTokens": None, "reportedUsedPercent": None} if used is not None else None
    return readers.available(entry, session, "claude-project-jsonl", observed_at, context, title=title, cwd=cwd, version=version)


def collect_claude(request, readers):
    return readers.collect(claude_session)


"""Observed Grok Build summary/update metadata; costs are never quota ratios."""


def grok_cache(entry, readers):
    raw = readers.json_object(entry)
    if raw.get("provider") != "grok" or raw.get("source") != "grok-cli-billing" or not collector_number(raw.get("fetched_at_unix"), False):
        return readers.unavailable(entry, "INVALID_CACHE", "The configured billing cache has an invalid provider/source or fetch time.")
    # Global billing/account values are not evidence of which account served
    # a particular session. Exact legacy context can be retained with unknown age.
    contexts = raw.get("session_contexts", {})
    if readers.request["operation"] != "observe" or not isinstance(contexts, dict):
        return []
    values = []
    for identity in readers.request["identities"]:
        context = contexts.get(identity["sessionId"])
        percent = context.get("used_percent") if isinstance(context, dict) else None
        if collector_number(percent, False) and percent <= 100:
            values.append(readers.available(entry, identity["sessionId"], "legacy-grok-cli-billing", None, {"usedTokens": None, "windowTokens": None, "compactionLimitTokens": None, "reportedUsedPercent": percent}))
    return values


def grok_session(entry, readers):
    if entry["cache"]:
        return grok_cache(entry, readers)
    name = os.path.basename(entry["path"])
    if name == "summary.json":
        raw = readers.json_object(entry)
        info = raw.get("info")
        if not isinstance(info, dict) or not collector_text(info.get("id"), 200):
            return readers.unavailable(entry, "MISSING_SESSION_ID", "Grok summary metadata has no supported explicit session ID.")
        session, cwd = info["id"], info.get("cwd")
        title = raw.get("generated_title")
        return readers.available(entry, session, "grok-build-summary", collector_timestamp(raw.get("last_active_at", raw.get("updated_at"))), title=title if collector_text(title, 200) else None, cwd=cwd if isinstance(cwd, str) and os.path.isabs(cwd) else None, version=str(raw["chat_format_version"]) if type(raw.get("chat_format_version")) in (int, str) else None)
    if name == "updates.jsonl":
        records = readers.jsonl(entry)["records"]
        ids = {r["params"]["sessionId"] for r in records if isinstance(r.get("params"), dict) and collector_text(r["params"].get("sessionId"), 200)}
        if len(ids) != 1:
            return readers.unavailable(entry, "AMBIGUOUS_SESSION" if ids else "MISSING_SESSION_ID", "Grok updates do not establish one exact session ID.")
        # turn_completed.usage is cumulative cost/token accounting. Neither it
        # nor _meta.totalTokens reports a compaction threshold/account quota.
        return readers.available(entry, next(iter(ids)), "grok-build-updates")
    return readers.unavailable(entry, "UNSUPPORTED_FORMAT", "This Grok session file is not a verified summary or update format.")


def collect_grok(request, readers):
    return readers.collect(grok_session)


if __name__ == "__main__":
    collector_main({"codex": collect_codex, "claude": collect_claude, "grok": collect_grok})
