# Evidence

Every mod ships only after its scenario passes in a private, task-owned Herdr window driven by real mouse and keyboard input. This page is generated from the receipts under `evidence/native/` and the task ledger `.ulpi/execution.json`.

<!-- evidence-status:begin -->
Derived from `.ulpi/execution.json` and the receipts under `evidence/native/` on 2026-11-02. The ledger records 90 of 90 required tasks and 3 of 3 optional account-feasibility tasks complete. A gate counts as passed only when its receipt passes `validateNativeIsolationReceipt` at the current harness and its package test matches the current manifest, artifact, source and preview bytes.

Every native gate below ran on herdr-app 0.1.11 with hc 0.1.16, in a private, task-owned Herdr app and core with PID-bound native input; the user's own Herdr was never queried or changed.

### Shared foundations

| Gate | Task | Evidence | Status |
| --- | --- | --- | --- |
| Private native isolation probe | TASK-005 | `evidence/native/isolation.json` | Passed (ownership-v2 receipt at the current harness, 2026-11-01) |
| PID-bound native input probe | TASK-077 | `evidence/native/input-probe.json` | Passed: AXPress, keyboard and pointer |
| Installed provider metadata formats | TASK-076 | `evidence/native/provider-compatibility.json` | Passed for the installed provider session-file formats; not an authenticated quota or account check |
| Layout trees and Settings previews | TASK-006, TASK-079 | `tests/layouts.test.mjs`, `tests/layout-previews.test.mjs` | Passed (source and tree checks) |

### Mounted native gates

| Mod | Task | Evidence | Status |
| --- | --- | --- | --- |
| Agent menu | TASK-018 | `evidence/native/agent-menu.json` | Passed (30 assertions, 21 native inputs, 2026-11-02) |
| Spaces | TASK-022 | `evidence/native/spaces.json` | Passed (28 assertions, 133 native inputs, 2026-11-02) |
| Agents | TASK-030 | `evidence/native/agents.json` | Passed (110 assertions, 61 native inputs, 2026-11-02) |
| Jira | TASK-040 | `evidence/native/jira.json` | Passed (36 assertions, 76 native inputs, 2026-11-02) |
| GitHub | TASK-048 | `evidence/native/github.json` | Passed (46 assertions, 220 native inputs, 2026-11-02) |
| GitLab | TASK-091 | `evidence/native/gitlab.json` | Passed (42 assertions, 297 native inputs, 2026-11-02) |
| Sessions | TASK-053 | `evidence/native/sessions.json` | Passed (41 assertions, 52 native inputs, 2026-11-02) |
| Reopen | TASK-058 | `evidence/native/reopen.json` | Passed (34 assertions, 76 native inputs, 2026-11-02) |
| Tabs | TASK-064 | `evidence/native/tabs.json` | Passed (55 assertions, 178 native inputs, 2026-11-02) |
| Both layouts integrated | TASK-007 | `evidence/native/layout.json` | Passed (52 assertions, 179 native inputs, 2026-11-02) |

### Packages, installation and release

| Package or step | Task | Status |
| --- | --- | --- |
| Revalidation of the five earlier packages after GitLab's shared changes | TASK-093 | Passed: all five reconcile at current hashes (`evidence/native/gitlab-compatibility.json`) |
| Agent menu, Spaces, Agents, Jira, GitHub packages | TASK-019, 023, 031, 041, 049 | Passed |
| GitLab package | TASK-092 | Passed |
| Sessions package | TASK-054 | Passed |
| Reopen package | TASK-059 | Passed |
| Tabs package | TASK-065 | Passed |
| Layout bundle | TASK-009 | Passed |
| Installation | TASK-010 | Passed: installed and verified in a real Herdr 0.1.11 window (receipt kept private) |
| Public release | TASK-011 | Passed |
| Optional accounts | TASK-066 / 067 / 068 | Feasibility complete; launch-routing gate passed for local new launches; decision **DEFER** (`docs/account-switching-decision.md`); mod not built |
<!-- evidence-status:end -->
