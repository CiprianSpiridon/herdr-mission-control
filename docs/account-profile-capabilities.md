# Account Profile Capabilities

Verified on **2026-10-31**, macOS, with **Codex CLI 0.166.0** and **Claude Code 2.1.314**. This is TASK-066’s feasibility record for the separate `mission-control-accounts` mod. The account panel remains an open deliverable; native launch routing is TASK-067.

## Capability matrix

| Provider and credential mode | Profile state | Credential boundary | Current result |
| --- | --- | --- | --- |
| Codex, explicitly selected `file` store | `CODEX_HOME` selected independent A/B configurations in the installed CLI | Official storage contract places the cache under that root; probes contained no credentials | Candidate for new launches; authenticated separation and logout effects remain untested |
| Codex, `keyring` or `auto` | Directory routing alone does not establish the effective credential backend | OS-store isolation was deliberately unavailable during the probes | Unsupported by this gate until backend scope and enforced policy are established |
| Codex, `ephemeral` | Documented process-local credentials | No persistent account was created or tested | No account-panel support established |
| Claude, claude.ai or API credentials | `CLAUDE_CONFIG_DIR` A/B appeared separately in real `auth status` results | Official contract scopes both Keychain entries and credential-file fallback by directory | Candidate for new launches; authenticated Keychain/file separation remains untested |
| Claude, Console sign-in without an API key | Separate directories do not isolate this sign-in type | Official documentation places its profile outside the configuration directory | Unsupported for independent account switching |
| Any already-running agent | Neither provider was started interactively or reauthenticated | Token refresh, logout revocation and switching an existing session were not exercised | No hot-switch or cross-account resume guarantee |

The Codex storage modes and administrator-enforced restrictions are documented in [OpenAI Authentication](https://learn.chatgpt.com/docs/auth#credential-storage). Managed restrictions can prevent the requested storage mode; a production implementation must honor that outcome.

Claude documents directory-scoped credentials and the keyless Console exception in [Authentication](https://code.claude.com/docs/en/authentication#log-in-with-multiple-accounts). Its [environment-variable reference](https://code.claude.com/docs/en/env-vars#precedence) describes startup environment selection. Apply a selected profile to a new process; keep the originating profile attached to existing session/history identities.

## Executed evidence

Run:

```sh
node --test tests/account-profile-probe.test.mjs
```

The four tests passed with **14 installed-CLI subprocess probes**:

- Version, authentication help and logout help for both providers. No logout ran.
- `codex login status` returned anonymous status for A and B. An invalid backend value in B was rejected, while A’s valid configuration still worked. This proves actual configuration selection beyond a successful help command.
- `claude auth status` returned `loggedIn: false`, `authMethod: "none"` and the requested A/B `configDirectory`. Both roots remained without a credential cache. The output fields are also described in the [Claude CLI reference](https://code.claude.com/docs/en/cli-reference#cli-commands).

Diagnostics are regenerated under `.harness/account-profile-probes.json` and `.harness/account-profile-probes-tests.log`. They contain versions, classifications, exit codes and output hashes, with no raw status payloads. These ignored files are local evidence, not package contents.

## Probe containment

Each probe uses fresh directories and an environment allowlist. Provider credentials, proxy settings, injected Node options and Herdr selectors are absent. A child macOS sandbox denies networking, Mach lookup, `/usr/bin/security`, existing-home reads, managed provider configuration and writes outside the task directory. The installed Claude executable has an explicit read exception.

Kernel checks independently demonstrated denied access to an owned credential canary, denied writes outside the temporary root and denied credential-helper execution. The canary stayed unchanged. No existing auth/configuration file was read or hashed; no login, credential copying, paid turn or Herdr-instance request occurred. Temporary probe directories were removed.

## Implementation gate

TASK-066 establishes anonymous profile routing and documents backend limits. TASK-067 must prove profile selection preserves tool identity, task delivery and machine routing in a real isolated Herdr launch. Production account controls need bounded implementation, authenticated capability evidence, native QA and packaging tasks added to the account plan, followed by founder review. Show unsupported modes explicitly; never use a shared global logout as a profile switch.
