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
            accounts = raw.get("session_accounts") if isinstance(raw.get("session_accounts"), dict) else {}
            digest = accounts.get(session)
            proven = isinstance(digest, str) and len(digest) == 64 and all(c in "0123456789abcdef" for c in digest)
            if not windows and proven:
                # Quota belongs to the account. An idle session whose own windows were dropped takes the
                # newest windows another session of the same proven account reported.
                best = None
                for other, other_digest in accounts.items():
                    if other == session or other_digest != digest:
                        continue
                    other_rows = raw.get("session_windows", {}).get(other, []) if isinstance(raw.get("session_windows"), dict) else []
                    other_obs = raw.get("session_quota_observations", {}).get(other, []) if isinstance(raw.get("session_quota_observations"), dict) else []
                    candidate = collector_legacy_windows(other_rows, other_obs)
                    newest = max([w["observedAt"] or 0 for w in candidate], default=0)
                    if candidate and (best is None or newest > best[0]):
                        best = (newest, candidate)
                if best:
                    windows = best[1]
            if windows:
                quota = {"proof": {"kind": "session-account-digest" if proven else "session-report", "machine": readers.source.get("machine"), "credentialScope": readers.source["credentialScope"], "accountId": digest if proven else None, "poolId": None}, "windows": windows}
        # Quota is the tool account's: its current tool-level windows win over a session's older copy.
        quota = collector_harness_quota(raw, readers.source) or quota
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
