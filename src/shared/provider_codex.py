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
