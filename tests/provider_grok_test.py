"""Observed Grok field names with synthetic values only."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

BASE = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("grok_collector", BASE / "src/shared/collector.py")
C = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(C)
N = dict(C.__dict__)
exec((BASE / "src/shared/provider_grok.py").read_text(), N)
ID = "11111111-1111-4111-8111-111111111111"


class GrokTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="mc-grok-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve() / ".grok"
        self.sessions = self.root / "sessions"
        self.sessions.mkdir(parents=True)
        self.source = {"v": 1, "enabled": True, "machine": "server", "provider": "grok", "credentialScope": "profile", "providerRoot": str(self.root), "roots": [str(self.sessions)]}

    def collect(self, **request):
        return C.run_collector(dict({"v": 1, "operation": "list", "source": self.source}, **request), {"grok": N["collect_grok"]})

    def identity(self, session=ID):
        return dict(C.collector_scope(self.source), sessionId=session)

    def test_summary_uses_explicit_info_id_not_directory_or_agent_id(self):
        (self.sessions / "summary.json").write_text(json.dumps({"info": {"id": ID, "cwd": "/fixture/repo"}, "agent_id": "NOT_SESSION_PROOF", "chat_format_version": 1, "generated_title": "Fix settings", "session_summary": "DO_NOT_EXPORT_SUMMARY", "last_active_at": "2026-10-30T12:00:00Z"}))
        value = self.collect()["data"][0]
        self.assertEqual(value["identity"], self.identity())
        self.assertEqual(value["title"], "Fix settings")
        self.assertEqual(value["cwd"], "/fixture/repo")
        self.assertIsNone(value["context"])
        self.assertIsNone(value["quota"])
        self.assertNotIn("DO_NOT_EXPORT", json.dumps(value))
        self.assertNotIn("NOT_SESSION_PROOF", json.dumps(value))
        self.assertEqual(self.collect(operation="observe", identities=[self.identity("other")])["data"], [])

    def test_turn_cost_and_cumulative_tokens_never_turn_into_context_or_quota(self):
        (self.sessions / "updates.jsonl").write_text(json.dumps({"method": "session/update", "timestamp": 1793376000000, "params": {"sessionId": ID, "_meta": {"totalTokens": 999999}, "update": {"sessionUpdate": "turn_completed", "usage": {"totalTokens": 100000, "inputTokens": 90000, "costUsdTicks": 1234}, "content": "PRIVATE_AGENT_MESSAGE"}}}) + "\n")
        value = self.collect()["data"][0]
        self.assertEqual(value["identity"], self.identity())
        self.assertIsNone(value["context"])
        self.assertIsNone(value["quota"])
        self.assertNotIn("PRIVATE_AGENT_MESSAGE", json.dumps(value))

    def test_unknown_and_malformed_formats_have_explicit_unavailable_states(self):
        (self.sessions / "summary.json").write_text('{"agent_id":"NOT_SESSION_PROOF"}')
        self.assertEqual(self.collect()["data"][0]["code"], "MISSING_SESSION_ID")
        (self.sessions / "summary.json").unlink()
        (self.sessions / "unknown.json").write_text('{"secret":"PRIVATE"}')
        value = self.collect()["data"][0]
        self.assertEqual(value["code"], "UNSUPPORTED_FORMAT")
        self.assertNotIn("PRIVATE", json.dumps(value))
        (self.sessions / "unknown.json").unlink()
        (self.sessions / "summary.json").write_text('{"unfinished":')
        self.assertEqual(self.collect()["data"][0]["code"], "MALFORMED_FILE")

    def test_explicit_legacy_cache_never_assigns_profile_billing_to_an_unproven_session(self):
        cache = self.root / "explicit-cache"
        cache.mkdir()
        file = cache / "grok-cli-billing.json"
        raw = {"provider": "grok", "source": "grok-cli-billing", "fetched_at_unix": 1000, "account_id": "GLOBAL_ACCOUNT", "windows": [{"kind": "monthly", "remaining_percent": 70}], "session_contexts": {ID: {"used_percent": 30}}}
        file.write_text(json.dumps(raw))
        self.source["cacheRoots"] = [str(cache)]
        value = self.collect(operation="observe", identities=[self.identity()])["data"][0]
        self.assertEqual(value["context"]["reportedUsedPercent"], 30)
        self.assertIsNone(value["provenance"]["observedAt"])
        self.assertIsNone(value["quota"])
        raw["provider"] = "claude"
        file.write_text(json.dumps(raw))
        self.assertEqual(self.collect()["data"][0]["code"], "INVALID_CACHE")


if __name__ == "__main__":
    unittest.main()
