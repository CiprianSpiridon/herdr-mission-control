# Founder Review: mission-control-agents

Round 1. Mode: FULL. Reviewer: founder_menu_spaces_agents. Verdict: **REJECT**.

This records the returned read-only forked audit. Detailed findings below preserve its required changes; original plan artifacts are retained in round-1-snapshots/.

JSON SHA256: `4a780704dab7bf8f856ec50f0f7b4921b8fe465773295e1a7e6dea70f837ee02`  
Markdown SHA256: `979a0593c92fb7a99ed17a5cdbaf108ddffd175aab347a6b3ec93c012c89645d`

| Section | Status |
| --- | --- |
| Codebase Reality | WARN |
| Scope & Strategy | PASS |
| Architecture & Integration | FAIL |
| Risk & Recovery | FAIL |
| Test Coverage | PASS |
| Execution Feasibility | PASS |

## Findings and required changes

- **BLOCK — R1-mission-control-agents-1:** ContextReading lacks machine/provider/root/credential-qualified SessionIdentity.
- **BLOCK — R1-mission-control-agents-2:** QuotaReading lacks machine/credential/pool identity and explicit available/stale/unavailable state.
- **BLOCK — R1-mission-control-agents-3:** No producer binds current Herdr terminal to exact provider session; current AgentInfo and hc Status have no provider session ID. Never infer from cwd/title/recency.
- **BLOCK — R1-mission-control-agents-4:** Promised opt-in root reading lacks owned settings, enable/revoke and allowed-root behavior.
- **CONCERN — R1-mission-control-agents-5:** Credit inspected shipped agents behavior.
- **CONCERN — R1-mission-control-agents-6:** Pin supported legacy snapshot filenames/fields and account/session scope instead of vague compatibility.
- **CONCERN — R1-mission-control-agents-7:** Split collector security/protocol from three provider parsers.
- **CONCERN — R1-mission-control-agents-8:** Add real local-provider compatibility evidence before shipping, distinct from fixture rendering.
- **CONCERN — R1-mission-control-agents-9:** Define ambiguous-correlation, source disable/revocation and rotating-file containment.

## Evidence boundary

All create parents exist, planned paths are explicitly new, Markdown/JSON parity and the union structural DAG check passed. No native implementation was claimed. Open concerns, including those allowed under APPROVE, must be fixed and re-reviewed per the user instruction.
