"""Synthetic protocol tests; these do not establish provider compatibility."""
import copy
import importlib.util
import json
import os
import sqlite3
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("mc_collector", Path(__file__).resolve().parents[1] / "src/shared/collector.py")
C = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(C)


class CollectorTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="mc-collector-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve() / ".codex"
        self.sessions = self.root / "sessions"
        self.sessions.mkdir(parents=True)
        self.source = {"v": 1, "enabled": True, "machine": None, "provider": "codex", "credentialScope": "synthetic-test", "providerRoot": str(self.root), "roots": [str(self.sessions)]}
        self.request = {"v": 1, "operation": "list", "source": self.source}

    def write(self, name="session.jsonl", records=None, directory=None):
        file = (directory or self.sessions) / name
        file.write_text("\n".join(json.dumps(v) for v in (records or [{"sessionId": name, "at": 1234}])) + "\n")
        return file

    def identity(self, session):
        return dict(C.collector_scope(self.source), sessionId=session)

    def parser(self, request, readers):
        def parse(entry, capability):
            records = capability.jsonl(entry)["records"]
            record = next((r for r in records if isinstance(r.get("sessionId"), str)), None)
            if record is None:
                return capability.unavailable(entry, "MISSING_ID", "Synthetic fixture has no identity.")
            return {"state": "available", "identity": dict(C.collector_scope(capability.source), sessionId=record["sessionId"]), "provenance": capability.provenance(entry, "synthetic-unit-jsonl", record.get("at")), "context": None, "quota": None}
        return readers.collect(parse)

    def run_request(self, request=None, parser=None, **kwargs):
        return C.run_collector(request or self.request, {"codex": parser or self.parser}, **kwargs)

    def readers(self):
        source, roots, limit = C.collector_request(self.request)
        result = C.CollectorReaders(self.request, source, roots, limit)
        result.enumerate()
        return result

    def test_real_files_page_fifty_and_exact_scope_cursor(self):
        for n in range(63):
            self.write(f"session-{n:03}.jsonl")
        first = self.run_request()
        self.assertEqual(len(first["data"]), 50)
        self.assertEqual(first["scan"]["indexed"], 63)
        self.assertTrue(first["truncated"])
        second = self.run_request(dict(self.request, cursor=first["cursor"]))
        self.assertEqual(len(second["data"]), 13)
        self.assertFalse(second["truncated"])
        self.assertIsNone(second["cursor"])
        changed = copy.deepcopy(self.request)
        changed["source"]["machine"] = "another-host"
        changed["cursor"] = first["cursor"]
        self.assertEqual(self.run_request(changed)["code"], "STALE_CURSOR")
        changed = dict(self.request, cursor="../../credentials")
        self.assertEqual(self.run_request(changed)["code"], "STALE_CURSOR")

    def test_observe_never_borrows_a_different_exact_session(self):
        self.write(records=[{"sessionId": "actual-session"}])
        result = self.run_request(dict(self.request, operation="observe", identities=[self.identity("requested-session")]))
        self.assertEqual(result["data"], [])
        self.assertIsNone(result["cursor"])
        wrong_host = dict(self.identity("actual-session"), machine="other")
        self.assertEqual(self.run_request(dict(self.request, operation="observe", identities=[wrong_host]))["code"], "INVALID_IDENTITY")

    def test_codex_index_locates_exact_rollout_before_the_history_walk(self):
        session = "11111111-1111-4111-8111-111111111111"
        directory = self.sessions / "2026" / "11" / "12"
        directory.mkdir(parents=True)
        rollout = self.write("rollout.jsonl", [{"sessionId": session, "at": 1234}], directory)
        with sqlite3.connect(self.root / "state_5.sqlite") as db:
            db.execute("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)")
            db.execute("INSERT INTO threads VALUES (?, ?)", (session, str(rollout)))
        request = dict(self.request, operation="observe", identities=[self.identity(session)])
        with patch.object(C.os, "scandir", side_effect=AssertionError("exact indexed sessions need no history walk")):
            result = self.run_request(request)
        self.assertEqual([v["identity"]["sessionId"] for v in result["data"]], [session])
        self.assertEqual(result["scan"]["indexed"], 1)
        self.assertFalse(result["truncated"])

    def test_codex_index_cannot_override_the_file_identity_or_configured_roots(self):
        session = "11111111-1111-4111-8111-111111111111"
        other = self.write("other.jsonl", [{"sessionId": "another-session", "at": 1234}])
        with sqlite3.connect(self.root / "state_5.sqlite") as db:
            db.execute("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)")
            db.execute("INSERT INTO threads VALUES (?, ?)", (session, str(other)))
        request = dict(self.request, operation="observe", identities=[self.identity(session)])
        self.assertEqual(self.run_request(request)["data"], [])
        outside = self.root / "outside.jsonl"
        outside.write_text(json.dumps({"sessionId": session, "at": 1234}) + "\n")
        with sqlite3.connect(self.root / "state_5.sqlite") as db:
            db.execute("UPDATE threads SET rollout_path = ? WHERE id = ?", (str(outside), session))
        self.assertEqual(self.run_request(request)["data"], [])

    def test_no_parser_disabled_source_unknown_operation_or_root_read_nothing(self):
        self.write()
        with patch.object(C.os, "scandir", side_effect=AssertionError("must not enumerate")):
            self.assertEqual(C.run_collector(self.request, {})["code"], "UNSUPPORTED_PARSER")
            disabled = copy.deepcopy(self.request)
            disabled["source"]["enabled"] = False
            self.assertEqual(self.run_request(disabled)["code"], "SOURCE_DISABLED")
            self.assertEqual(self.run_request(dict(self.request, operation="read-auth"))["code"], "INVALID_REQUEST")
            self.assertEqual(self.run_request(dict(self.request, roots=[str(self.root / "auth.json")]))["code"], "UNKNOWN_ROOT")
        for root in (str(self.root), "/", str(self.sessions / ".."), str(self.root / ".ssh")):
            bad = copy.deepcopy(self.request)
            bad["source"]["roots"] = [root]
            self.assertEqual(self.run_request(bad)["code"], "INVALID_ROOT")

    def test_symlink_escape_is_never_opened_and_parent_swap_fails(self):
        private = Path(self.temp.name) / "private.jsonl"
        private.write_text('{"secret":"NEVER_PUBLISH"}')
        (self.sessions / "escape.jsonl").symlink_to(private)
        self.assertEqual(self.run_request()["data"], [])
        folder = self.sessions / "project"
        folder.mkdir()
        self.write(directory=folder)
        readers = self.readers()
        folder.rename(self.sessions / "original")
        folder.symlink_to(Path(self.temp.name), target_is_directory=True)
        result = readers.collect(lambda entry, r: r.jsonl(entry))
        self.assertEqual(result[0]["state"], "unavailable")
        self.assertNotIn("NEVER_PUBLISH", json.dumps(result))
        alias = self.root / "alias"
        alias.symlink_to(self.sessions, target_is_directory=True)
        bad = copy.deepcopy(self.request)
        bad["source"]["roots"] = [str(alias)]
        self.assertEqual(self.run_request(bad)["code"], "UNSAFE_ROOT")

    def test_missing_replaced_growing_and_compressed_files_are_explicit(self):
        file = self.write()
        readers = self.readers()
        file.unlink()
        file.write_text('{"secret":"DIFFERENT_INODE"}')
        result = readers.collect(lambda entry, r: r.jsonl(entry))
        self.assertEqual(result[0]["code"], "FILE_ROTATED")
        self.assertNotIn("DIFFERENT_INODE", json.dumps(result))
        file.unlink()
        self.write("rollout.jsonl.zst").write_bytes(b"not-a-valid-zstd-stream")
        result = self.run_request()
        self.assertEqual(result["data"][0]["code"], "UNSUPPORTED_COMPRESSION")
        self.source["roots"] = [str(self.root / "missing")]
        result = self.run_request()
        self.assertEqual(result["errors"][0]["code"], "SOURCE_MISSING")
        self.assertEqual(result["data"], [])

    def test_read_race_discards_observations_and_keeps_content_out_of_error(self):
        file = self.write()
        readers, original = self.readers(), C.os.read
        def append_after_read(fd, count):
            result = original(fd, count)
            with file.open("a") as out:
                out.write('{"secret":"RACE_PRIVATE_TEXT"}\n')
            return result
        with patch.object(C.os, "read", side_effect=append_after_read):
            result = readers.collect(lambda entry, r: r.jsonl(entry))
        self.assertEqual(result[0]["code"], "FILE_ROTATED")
        self.assertNotIn("RACE_PRIVATE_TEXT", json.dumps(result))

    def test_tail_and_aggregate_content_budgets_continue_by_cursor(self):
        for n in range(20):
            file = self.write(f"session-{n:02}.jsonl", [{"sessionId": str(n)}])
            with file.open("ab") as out:
                out.write(b'{"transcript":"' + b"x" * 600000 + b'"}\n')
                out.write(b'{"kind":"latest-metadata"}\n')
        result = self.run_request()
        self.assertLessEqual(result["scan"]["bytes"], 4 * 1024 * 1024)
        self.assertEqual(result["scan"]["consumed"], 12)
        self.assertEqual(result["scan"]["stopReason"], "BYTE_LIMIT")
        self.assertTrue(result["cursor"])
        self.assertNotIn("transcript", json.dumps(result))
        second = self.run_request(dict(self.request, cursor=result["cursor"]))
        self.assertEqual(second["scan"]["consumed"], 8)
        self.assertFalse(second["truncated"])
        readers = self.readers()
        parsed = readers.jsonl(readers.selected[0])
        self.assertTrue(parsed["partial"])
        self.assertEqual(parsed["records"][-1]["kind"], "latest-metadata")

    def test_index_cap_and_deadline_are_visible(self):
        for n in range(1005):
            self.write(f"session-{n:04}.jsonl")
        result = self.run_request()
        self.assertEqual(result["scan"]["indexed"], 1000)
        self.assertTrue(result["scan"]["indexLimitReached"])
        self.assertTrue(result["truncated"])
        self.assertEqual(result["data"][0]["identity"]["sessionId"], "session-1004.jsonl")
        # Exact requests are prioritized even when the requested file is old.
        old = self.sessions / "session-0000.jsonl"
        os.utime(old, (1, 1))
        exact = self.run_request(dict(self.request, operation="observe", identities=[self.identity(old.name)], limit=1))
        self.assertEqual(exact["data"][0]["identity"]["sessionId"], old.name)
        ticks = iter(range(100000))
        result = self.run_request(clock=lambda: next(ticks))
        self.assertEqual(result["code"], "DEADLINE")

    def test_shape_validation_never_publishes_raw_extra_fields(self):
        self.write(records=[{"sessionId": "fixture", "secret": "PRIVATE_TRANSCRIPT"}])
        def parser(request, readers):
            return readers.collect(lambda entry, r: {"state": "available", "identity": self.identity("fixture"), "provenance": r.provenance(entry, "unit"), "context": None, "quota": None, "transcript": "PRIVATE_TRANSCRIPT"})
        result = self.run_request(parser=parser)
        self.assertEqual(result["data"][0]["code"], "INVALID_OBSERVATION")
        self.assertNotIn("PRIVATE_TRANSCRIPT", json.dumps(result))
        def wrong_scope(request, readers):
            return [{"state": "available", "identity": dict(self.identity("s"), credentialScope="different"), "provenance": readers.provenance(readers.selected[0], "unit"), "context": None, "quota": None}]
        self.assertEqual(self.run_request(parser=wrong_scope)["code"], "INVALID_OBSERVATION")

    def test_malformed_partial_jsonl_and_legacy_cache_filename_allowlist(self):
        file = self.write(records=[{"sessionId": "retained-valid"}])
        with file.open("ab") as out:
            out.write(b'{"unfinished":')
        readers = self.readers()
        parsed = readers.jsonl(readers.selected[0])
        self.assertTrue(parsed["malformed"])
        self.assertEqual(parsed["records"][0]["sessionId"], "retained-valid")
        cache = self.root / "explicit-cache"
        cache.mkdir()
        (cache / "codex-app-server.json").write_text('{"reported":true}')
        (cache / "auth.json").write_text('{"secret":"IGNORE_AUTH"}')
        (cache / "other.json").write_text('{"secret":"IGNORE_OTHER"}')
        self.source["cacheRoots"] = [str(cache)]
        readers = self.readers()
        self.assertEqual(sum(e["cache"] for e in readers.selected), 1)
        entry = next(e for e in readers.selected if e["cache"])
        self.assertEqual(readers.json_object(entry), {"reported": True})

    def test_oversized_cli_request_and_invalid_json_are_scoped_not_tracebacks(self):
        source = Path(SPEC.origin).read_text() + "\ncollector_main({})\n"
        for argument, code in (("x" * 65537, "REQUEST_TOO_LARGE"), ("not JSON PRIVATE_CONTENT", "INVALID_JSON")):
            result = subprocess.run([os.sys.executable, "-c", source, argument], text=True, capture_output=True, check=True)
            self.assertEqual(json.loads(result.stdout)["code"], code)
            self.assertEqual(result.stderr, "")
            self.assertNotIn("PRIVATE_CONTENT", result.stdout)

    def test_one_sanitized_cache_file_pages_without_omitting_session_records(self):
        self.write()
        def parser(request, readers):
            return readers.collect(lambda entry, r: [r.available(entry, "synthetic-" + str(n), "unit-cache", 1234) for n in range(120)])
        first = self.run_request(parser=parser)
        self.assertEqual(len(first["data"]), 50)
        self.assertEqual(first["scan"]["consumed"], 0)
        second = self.run_request(dict(self.request, cursor=first["cursor"]), parser=parser)
        self.assertEqual(second["data"][0]["identity"]["sessionId"], "synthetic-50")
        third = self.run_request(dict(self.request, cursor=second["cursor"]), parser=parser)
        self.assertEqual(len(third["data"]), 20)
        self.assertFalse(third["truncated"])

    def test_actual_python_observations_pass_the_shared_javascript_boundary(self):
        self.write()
        value = self.run_request()["data"][0]
        script = """import assert from 'node:assert/strict';
import {validateProviderObservation} from './src/shared/provider-observation.js';
const value=JSON.parse(process.argv[1]);
assert.equal(validateProviderObservation(value,{identity:value.identity}).ok,true);
for(const mutate of [v=>v.quota={proof:{}},v=>v.context={usedTokens:1},v=>v.transcript='PRIVATE_TEXT',v=>v.provenance.observedAt='unknown']){
 const altered=structuredClone(value);mutate(altered);assert.equal(validateProviderObservation(altered).ok,false);
}
assert.equal(validateProviderObservation(value,{identity:{...value.identity,machine:'other'}}).code,'SCOPE_MISMATCH');
"""
        result = subprocess.run(["node", "--input-type=module", "-e", script, json.dumps(value)], cwd=Path(SPEC.origin).parents[2], capture_output=True, text=True, check=True)
        self.assertEqual(result.stdout, "")

    def test_out_of_range_dates_are_rejected_on_both_sides_before_native_date_formatting(self):
        self.write()
        base = self.run_request()["data"][0]
        base["quota"] = {"proof": {"kind": "session-report", "machine": None, "credentialScope": self.source["credentialScope"], "accountId": None, "poolId": None}, "windows": [{"name": "primary", "remainingPercent": 50, "observedAt": 1234, "resetsAt": 5000}]}
        invalid = []
        for field in ("provenance", "observedAt", "resetsAt"):
            value = copy.deepcopy(base)
            if field == "provenance":
                value["provenance"]["observedAt"] = 9000000000000000
            else:
                value["quota"]["windows"][0][field] = 9000000000000000
            with self.assertRaises(C.CollectorError) as caught:
                C.collector_validate_observation(value, self.source)
            self.assertEqual(caught.exception.code, "INVALID_OBSERVATION")
            invalid.append(value)
        script = "import assert from 'node:assert/strict';import {validateProviderObservation} from './src/shared/provider-observation.js';for(const value of JSON.parse(process.argv[1]))assert.equal(validateProviderObservation(value).ok,false);"
        subprocess.run(["node", "--input-type=module", "-e", script, json.dumps(invalid)], cwd=Path(SPEC.origin).parents[2], capture_output=True, text=True, check=True)


if __name__ == "__main__":
    unittest.main()
