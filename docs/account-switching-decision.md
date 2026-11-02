# Account Switching Decision

**Decision: DEFER.** Recorded on 2026-11-01 for the optional `mission-control-accounts` mod. No account mod is built or published, and no empty account package ships.

This plan allows GO only when credential isolation and launch-identity isolation have both passed. Launch identity has now passed for local new launches. Credential isolation has not been proven, so the verdict is DEFER.

## Evidence

The launch gate is TASK-067's native receipt, `evidence/native/account-profile.json`.

| Field | Value |
| --- | --- |
| SHA-256 | `7865f624df1cf13e4f7e96039f124bd7413d0628a02faadac5ed38d9c97ae412` |
| Completed | 2026-11-01T15:24:55Z |
| Host | Herdr 0.1.11, hc 0.1.16, macOS |
| Harness | `7be8b4073f5a08b52bde177d18f6cd4c64175b23351553d5a991c2067bafd851` |
| Result | `ok: true`, 82 checks, verified private cleanup, zero app errors |
| Canonical validator | Accepts it |

The probe launched toy `codex` and `claude` executables only. No provider CLI ran, no one signed in, and no paid turn was made. The profile roots held no auth, credential, token or session files. The private app and core environments never carried a profile variable, so global authentication was not touched.

Credential isolation comes from TASK-066's record, [Account Profile Capabilities](account-profile-capabilities.md). Codex's explicit `file` store and Claude's `CLAUDE_CONFIG_DIR` are candidates only, because feasibility work may not sign in. Codex `keyring` or `auto` storage and Claude Console sign-in without an API key are unsupported.

## Launch paths tested

| Path | Result | What the receipt shows |
| --- | --- | --- |
| `tab.new` with an environment-wrapper argv | Supported locally | Separate `CODEX_HOME` and `CLAUDE_CONFIG_DIR` roots per process, each classified as the right agent, with the task delivered as Herdr's first message |
| `programs.json` run with an environment wrapper (native click) | Supported locally | Same separation through a real click on the probe mod |
| `hc run` with a `/usr/bin/env VAR=root tool` argv | Supported locally | Same separation in the core, with the task sent through `hc send` |
| Control: no profile selected | Held | Both toys started with their profile variable unset |
| Remote `tab.new` with an environment-wrapper argv on the second host | Unproven | Herdr keeps its `sh -c` wrapper in the foreground on a remote host, and the probe looks for the toy itself there. This is unproven, not disproven |
| `tab.new` `env` argument | Refused | `tab.new: unknown argument(s): env` |
| `tab.new` with `VAR=value tool` argv | Refused | The foreground shell never became the tool; the task reached no toy |
| `hc run --env` | Refused | The flag is absent in hc 0.1.16; no terminal was created |
| `hc exec --env` | Not a launch path | It sets environment for one-shot commands only, with no terminal, agent classification or task routing |

Herdr 0.1.11 passes `tab.new`'s task to the program as its last argument. Any implementation must expect that argument after the tool's own arguments.

One more observation: `knownAgents()` reports an environment wrapper as installed even when the wrapped tool is missing. Any future implementation must verify the wrapped executable itself.

## Limits that hold regardless

- **New launches only.** Existing terminals kept their original profile root and foreground PID through every later launch. Mission Control makes no hot-switch or seamless running-session guarantee.
- **No account quota guarantee.** Quota views never depend on this decision.
- **No cross-account resume.** Provider-specific resume needs its own credential-safe evidence and reviewed implementation tasks. The toy-process result proves nothing about it.
- **Independent of the required work.** Both layouts and every required mod ship without this feature.

## What would reopen it

1. Prove credential isolation with real, separately authenticated profiles for each supported storage mode, without exposing or persisting credentials in evidence.
2. Prove remote routing on a second host, accounting for the remote `sh -c` foreground wrapper.
3. Expand this plan with bounded implementation, QA and packaging tasks, and get another founder review before any build.
