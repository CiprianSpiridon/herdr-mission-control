# Founder review: Jira auth revision, round 1

Reviewer: founder_trackers. FULL. **REJECT**: two blocks, one concern. Reviewed artifacts are preserved in `auth-route-round-1-snapshots/`.

| Section | Status |
| --- | --- |
| Codebase Reality | FAIL |
| Scope & Strategy | PASS |
| Architecture & Integration | PASS, one concern |
| Risk & Recovery | PASS |
| Test Coverage | PASS |
| Execution Feasibility | FAIL |

- **JIRA-B1:** Existing `src/shared/tracker-transport.mjs`, `tests/tracker-transport.test.mjs`, `src/shared/tracker-model.js` and `tests/tracker-model.test.mjs` were incorrectly classified Create; the old source still rejected API cloudId and MCP Basic. Modify and supplement them.
- **JIRA-B2:** TASK-032/033 remained completed in the scheduling ledger. Explicitly reopen/reset them, preserve their old receipts, and require fresh completion before TASK-034.
- **JIRA-C1:** Define site as canonical `serverInfo.baseUrl`, explain custom `displayUrl`, and test a pre-save mismatch without overwriting the prior config.

All three findings have proposed fixes in the next plan revision; only a fresh review at its new hashes can close them. The other nine pairs received APPROVE at the archived round-1 hashes. See [round ledger](auth-route-round-1.json) and [primary authentication evidence](jira-auth-grounding.md).
