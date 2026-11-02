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
