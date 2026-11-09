"""Synthetic metadata fixtures, not a live-provider proof."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

BASE = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("claude_collector", BASE / "src/shared/collector.py")
C = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(C)
N = dict(C.__dict__)
exec((BASE / "src/shared/provider_claude.py").read_text(), N)
ID, OTHER = "claude-session-a", "claude-session-b"


class ClaudeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="mc-claude-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve() / ".claude"
        self.sessions = self.root / "projects"
        self.sessions.mkdir(parents=True)
        self.source = {"v": 1, "enabled": True, "machine": None, "provider": "claude", "credentialScope": "profile-a", "providerRoot": str(self.root), "roots": [str(self.sessions)]}

    def write(self, records):
        (self.sessions / "session.jsonl").write_text("\n".join(json.dumps(r) for r in records) + "\n")

    def collect(self, **request):
        return C.run_collector(dict({"v": 1, "operation": "list", "source": self.source}, **request), {"claude": N["collect_claude"]})

    def identity(self, session=ID):
        return dict(C.collector_scope(self.source), sessionId=session)

    def assistant(self, **overrides):
        return dict({"type": "assistant", "sessionId": ID, "cwd": "/fixture/worktree", "timestamp": "2026-10-30T12:00:00Z", "version": "synthetic-unit", "message": {"content": "PRIVATE_ASSISTANT_TEXT", "usage": {"input_tokens": 10, "cache_read_input_tokens": 20, "cache_creation_input_tokens": 30, "output_tokens": 5}}}, **overrides)

    def cache(self, **overrides):
        directory = self.root / "explicit-cache"
        directory.mkdir(exist_ok=True)
        file = directory / "claude-statusline.json"
        raw = dict({"provider": "claude", "source": "claude-statusline", "fetched_at_unix": 9999, "session_quota_only": True, "session_contexts": {ID: {"used_percent": 20}, OTHER: {"used_percent": 80}}, "session_windows": {ID: [{"kind": "five_hour", "used_percent": 35, "remaining_percent": 65, "resets_at": 12345}], OTHER: [{"kind": "weekly", "used_percent": 70, "remaining_percent": 30, "resets_at": None}]}, "session_quota_observations": {ID: [{"kind": "five_hour", "observed_at_unix": 1200}]}, "session_accounts": {ID: "a" * 64, OTHER: "b" * 64}, "quota_scope_windows": {"do-not-trust": [{"remaining_percent": 100}]}, "context": {"used_percent": 99}}, **overrides)
        file.write_text(json.dumps(raw))
        self.source["cacheRoots"] = [str(directory)]
        return file

    def test_usage_keeps_cache_tokens_without_guessing_capacity_or_exporting_messages(self):
        self.write([self.assistant(), {"type": "ai-title", "sessionId": ID, "aiTitle": "Fix login redirect"}, {"type": "user", "sessionId": ID, "message": {"content": "PRIVATE_USER_PROMPT"}}])
        value = self.collect()["data"][0]
        self.assertEqual(value["identity"], self.identity())
        self.assertEqual(value["context"]["usedTokens"], 65)
        self.assertIsNone(value["context"]["windowTokens"])
        self.assertIsNone(value["context"]["compactionLimitTokens"])
        self.assertEqual(value["title"], "Fix login redirect")
        self.assertEqual(value["cwd"], "/fixture/worktree")
        self.assertIsNone(value["quota"])
        self.assertNotIn("PRIVATE_", json.dumps(value))

    def test_current_observation_snapshot_is_read_beside_an_older_legacy_cache(self):
        legacy = self.cache(session_contexts={ID: {"used_percent": 90, "cache": {"session_id": ID, "last_activity_unix": 100}}})
        snapshot = json.loads(legacy.read_text())
        snapshot["fetched_at_unix"] = 12000
        snapshot["session_contexts"] = {ID: {"used_percent": 30, "cache": {"session_id": ID, "last_activity_unix": 12000}}}
        current = legacy.with_name("claude-statusline.observation.json")
        current.write_text(json.dumps({"snapshot": snapshot, "payload": {"session_id": OTHER, "prompt": "PRIVATE_PAYLOAD_MUST_NOT_ESCAPE"}}))
        result = self.collect(operation="observe", identities=[self.identity()])
        contexts = [r for r in result["data"] if r.get("context")]
        self.assertTrue(any(r["context"]["reportedUsedPercent"] == 30 and r["provenance"]["observedAt"] == 12000000 for r in contexts))
        self.assertTrue(all(r["identity"] == self.identity() for r in contexts))
        self.assertNotIn("PRIVATE_", json.dumps(result))
        current.write_text(json.dumps({"snapshot": {"provider": "codex"}, "payload": {"context_window": {"used_percentage": 50}}}))
        rejected = self.collect(operation="observe", identities=[self.identity()])
        self.assertTrue(any(r.get("code") == "INVALID_CACHE" for r in rejected["data"]))

    def test_two_sessions_do_not_mix_and_malformed_or_missing_ids_are_unavailable(self):
        self.write([self.assistant(), self.assistant(sessionId=OTHER)])
        self.assertEqual(self.collect()["data"][0]["code"], "AMBIGUOUS_SESSION")
        self.write([{"type": "assistant", "message": {"content": "PRIVATE_PROMPT"}}])
        self.assertEqual(self.collect()["data"][0]["code"], "MISSING_SESSION_ID")
        self.write([self.assistant()])
        self.assertEqual(self.collect(operation="observe", identities=[self.identity(OTHER)])["data"], [])

    def test_unknown_usage_is_unavailable_instead_of_reusing_previous_request(self):
        self.write([self.assistant(), self.assistant(message={"usage": {"input_tokens": -1}, "content": "PRIVATE"})])
        self.assertIsNone(self.collect()["data"][0]["context"])

    def test_exact_statusline_context_quota_account_and_per_window_dates(self):
        self.cache()
        value = self.collect(operation="observe", identities=[self.identity()])["data"][0]
        self.assertEqual(value["context"]["reportedUsedPercent"], 20)
        self.assertIsNone(value["provenance"]["observedAt"], "A merged cache fetch time cannot freshen each context")
        self.assertEqual(value["quota"]["proof"]["accountId"], "a" * 64)
        self.assertEqual(value["quota"]["proof"]["kind"], "session-account-digest")
        self.assertEqual(value["quota"]["windows"][0]["remainingPercent"], 65)
        self.assertEqual(value["quota"]["windows"][0]["observedAt"], 1200000)
        other = self.collect(operation="observe", identities=[self.identity(OTHER)])["data"][0]
        self.assertEqual(other["quota"]["proof"]["accountId"], "b" * 64)
        self.assertIsNone(other["quota"]["windows"][0]["observedAt"])
        self.assertEqual(self.collect(operation="observe", identities=[self.identity("not-present")])["data"], [])

    def test_unknown_account_and_old_global_scope_never_produce_shared_proof(self):
        self.cache(session_accounts={}, session_quota_scopes={ID: "OLD_PROFILE_SCOPE"})
        value = self.collect(operation="observe", identities=[self.identity()])["data"][0]
        self.assertEqual(value["quota"]["proof"]["kind"], "session-report")
        self.assertIsNone(value["quota"]["proof"]["accountId"])
        self.cache(session_quota_only=False)
        self.assertIsNone(self.collect(operation="observe", identities=[self.identity()])["data"][0]["quota"])
        self.cache(session_contexts={}, session_windows={}, session_quota_observations={})
        self.assertEqual(self.collect(operation="observe", identities=[self.identity()])["data"], [])

    def test_wrong_source_inconsistent_percent_and_unknown_freshness_do_not_claim_current_usage(self):
        self.cache(source="codex-app-server")
        self.assertEqual(self.collect()["data"][0]["code"], "INVALID_CACHE")
        self.cache(session_windows={ID: [{"kind": "five_hour", "used_percent": 70, "remaining_percent": 70}]})
        value = self.collect(operation="observe", identities=[self.identity()])["data"][0]
        self.assertIsNone(value["quota"])


if __name__ == "__main__":
    unittest.main()
