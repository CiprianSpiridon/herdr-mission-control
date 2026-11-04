"""Synthetic Codex records; live compatibility is a separate gate."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

BASE = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("codex_collector", BASE / "src/shared/collector.py")
C = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(C)
NAMESPACE = dict(C.__dict__)
exec((BASE / "src/shared/provider_codex.py").read_text(), NAMESPACE)
ID = "11111111-1111-4111-8111-111111111111"
OTHER = "22222222-2222-4222-8222-222222222222"
AT = "2026-10-30T12:00:00Z"


class CodexTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="mc-codex-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve() / ".codex"
        self.sessions = self.root / "sessions"
        self.sessions.mkdir(parents=True)
        self.source = {"v": 1, "enabled": True, "machine": "qa-host", "provider": "codex", "credentialScope": "profile-a", "providerRoot": str(self.root), "roots": [str(self.sessions)]}

    def header(self, **overrides):
        return {"type": "session_meta", "timestamp": AT, "payload": dict({"id": ID, "session_id": OTHER, "cwd": "/fixture/repo", "timestamp": AT, "cli_version": "synthetic-unit", "creator_account_id": "CREATION_ACCOUNT_NOT_SERVING", "base_instructions": "NEVER_EXPORT_INSTRUCTIONS"}, **overrides)}

    def usage(self, **overrides):
        return {"type": "event_msg", "timestamp": AT, "payload": dict({"type": "token_count", "thread_id": ID, "info": {"last_token_usage": {"input_tokens": 30, "output_tokens": 10, "total_tokens": 40}, "total_token_usage": {"total_tokens": 999999}, "model_context_window": 100}, "rate_limits": {"limit_id": "reported-pool", "primary": {"window_minutes": 300, "used_percent": 25, "resets_at": 1793376000}}}, **overrides)}

    def write(self, records):
        (self.sessions / "rollout-fixture.jsonl").write_text("\n".join(json.dumps(r) for r in records) + "\n")

    def collect(self, **request):
        return C.run_collector(dict({"v": 1, "operation": "list", "source": self.source}, **request), {"codex": NAMESPACE["collect_codex"]})

    def identity(self, session=ID):
        return dict(C.collector_scope(self.source), sessionId=session)

    def test_thread_identity_latest_window_and_session_local_quota(self):
        self.write([self.header(), self.usage(), {"type": "response_item", "payload": {"content": "NEVER_EXPORT_TRANSCRIPT"}}])
        value = self.collect()["data"][0]
        self.assertEqual(value["identity"], self.identity())
        self.assertNotEqual(value["identity"]["sessionId"], OTHER)
        self.assertEqual(value["context"], {"usedTokens": 40, "windowTokens": 100, "compactionLimitTokens": None, "reportedUsedPercent": None})
        self.assertEqual(value["quota"]["windows"][0]["remainingPercent"], 75)
        self.assertEqual(value["quota"]["windows"][0]["name"], "300m")
        self.assertEqual(value["quota"]["proof"]["kind"], "session-report")
        self.assertIsNone(value["quota"]["proof"]["accountId"])
        output = json.dumps(value)
        for private in ("NEVER_EXPORT_INSTRUCTIONS", "NEVER_EXPORT_TRANSCRIPT", "CREATION_ACCOUNT_NOT_SERVING"):
            self.assertNotIn(private, output)

    def test_root_runtime_id_or_another_host_cannot_claim_child_context(self):
        self.write([self.header(), self.usage()])
        result = self.collect(operation="observe", identities=[self.identity(OTHER)])
        self.assertEqual(result["data"], [])
        result = self.collect(operation="observe", identities=[dict(self.identity(), machine=None)])
        self.assertEqual(result["code"], "INVALID_IDENTITY")

    def test_canonical_first_header_survives_copied_parent_and_rejects_parent_usage(self):
        self.write([self.header(forked_from_id=OTHER), self.header(id=OTHER), self.usage(thread_id=OTHER), self.usage(thread_id=ID, info={"last_token_usage": {"total_tokens": 12}, "model_context_window": 120})])
        value = self.collect()["data"][0]
        self.assertEqual(value["identity"]["sessionId"], ID)
        self.assertEqual(value["context"]["usedTokens"], 12)
        self.write([self.header(forked_from_id=OTHER), self.header(id=OTHER), self.usage(thread_id=None)])
        self.assertIsNone(self.collect()["data"][0]["context"])

    def test_unknown_or_missing_usage_never_reuses_a_lifetime_total(self):
        self.write([self.header(), self.usage(info={"last_token_usage": {"total_tokens": 8}, "total_token_usage": {"total_tokens": 10000}})])
        value = self.collect()["data"][0]
        self.assertEqual(value["context"]["usedTokens"], 8)
        self.assertIsNone(value["context"]["windowTokens"])
        self.write([self.header(), self.usage(), self.usage(info=None, rate_limits=None)])
        self.assertIsNone(self.collect()["data"][0]["context"])

    def test_bounded_head_is_required_and_rotated_or_corrupt_data_is_unavailable(self):
        self.write([self.usage()])
        self.assertEqual(self.collect()["data"][0]["code"], "MISSING_SESSION_ID")
        self.write([{"type": "response_item", "payload": "x" * 400000}, self.header(), self.usage()])
        self.assertEqual(self.collect()["data"][0]["code"], "MISSING_SESSION_ID")
        self.write([self.header(), self.usage(info={"last_token_usage": {"total_tokens": "not numeric"}, "model_context_window": "unknown"}, rate_limits={"primary": {"used_percent": 120}})])
        value = self.collect()["data"][0]
        self.assertIsNone(value["context"])
        self.assertIsNone(value["quota"])

    def test_explicit_cache_gives_exact_session_context_and_the_tool_accounts_quota(self):
        cache = self.root / "explicit-cache"
        cache.mkdir()
        file = cache / "codex-app-server.json"
        raw = {"provider": "codex", "source": "codex-app-server", "fetched_at_unix": 1234, "account_id": "NOT_EXACT_SESSION_PROOF", "windows": [{"kind": "weekly", "remaining_percent": 99}], "context": {"used_percent": 99}, "session_contexts": {ID: {"used_percent": 30}, OTHER: {"used_percent": 80}}}
        file.write_text(json.dumps(raw))
        self.source["cacheRoots"] = [str(cache)]
        value = self.collect(operation="observe", identities=[self.identity()])["data"][0]
        self.assertEqual(value["context"]["reportedUsedPercent"], 30)
        # Quota belongs to the tool's account: every session shows the snapshot's tool-level windows.
        self.assertEqual(value["quota"]["proof"]["kind"], "provider-account")
        self.assertEqual(value["quota"]["windows"], [{"name": "weekly", "remainingPercent": 99, "observedAt": 1234000, "resetsAt": None}])
        other = self.collect(operation="observe", identities=[self.identity("not-present")])["data"]
        self.assertEqual(len(other), 1)
        self.assertIsNone(other[0]["context"], "context stays per conversation")
        self.assertEqual(other[0]["quota"]["windows"][0]["remainingPercent"], 99)
        raw["source"] = "wrong-provider"
        file.write_text(json.dumps(raw))
        self.assertEqual(self.collect()["data"][0]["code"], "INVALID_CACHE")


if __name__ == "__main__":
    unittest.main()
