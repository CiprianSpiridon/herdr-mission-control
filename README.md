# Herdr Mission Control

Mission Control adds two native layouts and a set of self-contained mods to the Herdr desktop app for people who run many repository spaces and coding agents across several machines.

[![Mission Control overview: Spaces and Agents rail, six work sources with a Jira board, and the active tab's terminal below](mission-control/preview.png)](mission-control/preview.png)

*The Mission Control overview, captured from the native layout gate with synthetic spaces, agents and tracker data.*

- **Mission Control** (`mission-control`) is an overview: a Spaces/Agents rail on the left, six work sources (Jira, GitHub issues, Pull requests, GitLab issues, Merge requests, Previous sessions) in the main area, and the active tab's terminals below.
- **Classic** (`mission-control-classic`) is terminal-first: the same rail and terminals, with the same six sources in a side panel that starts closed.

Both layouts share one topmost tab bar with automatic tab naming, an agent menu, Reopen last tab / Reopen last agent, and one button that swaps between the two views. Every mod is also published on its own and works without either layout.

> **Status: published.** Every standalone and integrated native gate and all packaging checks have passed against synthetic fixtures, and the layout bundle has been installed and verified in a real Herdr 0.1.11 window. Read [Evidence status](#evidence-status) before relying on any behaviour; nothing here proves authenticated access to a live Jira, GitHub or GitLab account.

## Packages

Each package is a complete folder in this repository with its own `RECIPE.md` and native `preview.png`, as Herdr's sharing rules ask. Click a screenshot for full size.

| Folder | Screenshot | Kind | Contents | In the layout bundle |
| --- | --- | --- | --- | --- |
| [`mission-control/`](mission-control/RECIPE.md) | <a href="mission-control/preview.png"><img src="mission-control/preview.png" width="240" alt="mission-control screenshot"></a> | Layout bundle | Both layouts, their Settings previews and the mods they reference | — |
| [`mission-control-tabs/`](mission-control-tabs/RECIPE.md) | <a href="mission-control-tabs/preview.png"><img src="mission-control-tabs/preview.png" width="240" alt="mission-control-tabs screenshot"></a> | Standalone mod | Topmost tab bar, automatic names, own agent menu, Reopen buttons, view swap, six-source navigation | Yes |
| [`mission-control-spaces/`](mission-control-spaces/RECIPE.md) | <a href="mission-control-spaces/preview.png"><img src="mission-control-spaces/preview.png" width="240" alt="mission-control-spaces screenshot"></a> | Standalone mod | Spaces sidebar, space context menu, Settings / Add machine footer | Yes |
| [`mission-control-agents/`](mission-control-agents/RECIPE.md) | <a href="mission-control-agents/preview.png"><img src="mission-control-agents/preview.png" width="240" alt="mission-control-agents screenshot"></a> | Standalone mod | Agents list with tool icons, context and quota readings, Priority / Spaces grouping | Yes |
| [`mission-control-jira/`](mission-control-jira/RECIPE.md) | <a href="mission-control-jira/preview.png"><img src="mission-control-jira/preview.png" width="240" alt="mission-control-jira screenshot"></a> | Standalone mod | Jira board, setup and launch dialogs (one runtime mod) | Yes |
| [`mission-control-github/`](mission-control-github/RECIPE.md) | <a href="mission-control-github/preview.png"><img src="mission-control-github/preview.png" width="240" alt="mission-control-github screenshot"></a> | Standalone mod | GitHub issues and pull requests views, setup and launch dialogs | Yes |
| [`mission-control-gitlab/`](mission-control-gitlab/RECIPE.md) | <a href="mission-control-gitlab/preview.png"><img src="mission-control-gitlab/preview.png" width="240" alt="mission-control-gitlab screenshot"></a> | Standalone mod | GitLab issues and merge-request views, setup and launch dialogs | Yes |
| [`mission-control-sessions/`](mission-control-sessions/RECIPE.md) | <a href="mission-control-sessions/preview.png"><img src="mission-control-sessions/preview.png" width="240" alt="mission-control-sessions screenshot"></a> | Standalone mod | Previous agent sessions per space, exact resume | Yes |
| [`mission-control-agent-menu/`](mission-control-agent-menu/RECIPE.md) | <a href="mission-control-agent-menu/preview.png"><img src="mission-control-agent-menu/preview.png" width="240" alt="mission-control-agent-menu screenshot"></a> | Standalone mod | The agent menu on its own | No: the tabs mod compiles in the same menu |
| [`mission-control-reopen/`](mission-control-reopen/RECIPE.md) | <a href="mission-control-reopen/preview.png"><img src="mission-control-reopen/preview.png" width="240" alt="mission-control-reopen screenshot"></a> | Standalone mod | A bottom Reopen bar and popup | No: the tab bar has its own Reopen buttons |

The optional `mission-control-accounts` mod (Claude Code / Codex account profiles) is **not built**. Only its feasibility probe exists ([docs/account-profile-capabilities.md](docs/account-profile-capabilities.md)); neither layout depends on it.

Each package's `RECIPE.md` describes what it looks like, how it behaves, what it is built from, its access disclosure, pitfalls and done checks.

## Standalone and bundle structure

A **standalone package** is `<name>/mods/<name>/` plus `RECIPE.md`, a real native `preview.png` and the builder's `build-manifest.json`; no package ships a `keys.json`. It has no `layouts/` folder. The mod folder is self-contained: `main.js` is one native GPUI bundle, and shared repository code is compiled into it, into a Node helper `backend.mjs` (Jira, GitHub, GitLab) or into a Python `collector.py` (Agents, Sessions). A mod never imports another mod at run time. Copying only `mods/<name>/` into a Herdr app home is enough.

The **layout bundle** is:

```text
mission-control/
  layouts/mission-control.json          overview layout tree
  layouts/mission-control.svg           its Settings preview
  layouts/mission-control-classic.json  Classic layout tree
  layouts/mission-control-classic.svg   its Settings preview
  mods/mission-control-{agents,github,gitlab,jira,sessions,spaces,tabs}/
  RECIPE.md  preview.png  build-manifest.json
```

`node scripts/project.mjs bundle` rebuilds every mod the two layouts reference and copies each standalone `mods/<name>/` folder byte for byte, so a bundled mod and its standalone package are the same files. They share a name: install one copy, not both. The Settings SVGs are authored artwork for Herdr's layout picker; `preview.png` is a separate native screenshot.

## Requirements

| Tool | Needed for |
| --- | --- |
| Herdr desktop app (`herdr-app`) and `hc` | Running the mods; `herdr-app check` validates a mod folder. Development observed herdr-app 0.1.9–0.1.11 and hc 0.1.14–0.1.16; every native gate passed on herdr-app 0.1.11 with hc 0.1.16. Re-read the installed `~/.config/herdr-app/AGENTS.md` and type declarations before changing Herdr API use. |
| Node.js 22 or newer | Building (`npm ci`, esbuild) and, at run time, the local Jira, GitHub and GitLab helpers. |
| Python 3 | Agents and Sessions collectors, worktree and mount helpers, Reopen helpers, on every machine whose agents or history are read. Without it that host's metrics and history show as unavailable; terminals keep working. |
| `git` | Repository identity, linked checkouts and new worktrees. |
| Coding-agent CLIs (optional) | Whatever Herdr reports installed on the target machine, for example Claude Code, Codex or Grok. |
| `gh` (optional) | A GitHub connection may name an existing `gh` host and account; the helper reads its token with `gh auth token` and never logs in or switches accounts. |
| Jira CLI or Jira MCP server (optional) | A Jira connection may use a JSON-printing CLI, a local stdio MCP server or an HTTPS MCP endpoint instead of the REST API. |

No `glab` is used. macOS Accessibility and event-posting permission is needed only by the native QA harness, not by users.

## Build and test

```sh
npm ci                                   # exact esbuild and MCP SDK versions from package-lock.json
npm test                                 # all JavaScript tests (GPUI modules load through tests/support/native-loader.mjs)
npm run test:python                      # collector and provider parser tests
npm run plan:check                       # validate the plan DAG under .ulpi/plans/
node scripts/project.mjs build <mod>     # rebuild <mod>/mods/<mod>/ and <mod>/build-manifest.json
node scripts/project.mjs check <mod>     # build, then run herdr-app check on the built folder
node scripts/project.mjs bundle          # rebuild every referenced mod, then materialize mission-control/
node scripts/project.mjs inspect-docs README.md LICENSE NOTICE.md
```

`build`, `check` and `bundle` rewrite package folders in place. Package tests compare every byte with the build that a native receipt tested, so rebuilding after a gate passed requires a fresh native run.

Native QA runs in a task-owned private Herdr app and core; it never queries or changes an existing Herdr window or core:

```sh
node scripts/native-driver.mjs probe             # PID-bound native input probe (needs Accessibility permission)
node scripts/native-harness.mjs probe            # private app/core isolation probe
node scripts/native-harness.mjs run <scenario>   # a scenario file in tests/native/, for example jira or layout
node scripts/verify-gitlab-compatibility.mjs     # re-prove the five pre-GitLab packages at current source
```

Browser mockups in `work/` are illustrations with example data; they do not prove native behaviour.

## Install

The installer has been run against a real Herdr 0.1.11 app home: no collisions, every mod passed `herdr-app check`, the layout switched with no new app errors and every running terminal kept running. Its receipt stays out of the repository because it holds local paths. There are three ways in, easiest first.

**1. From Herdr.** The repository carries the `herdr-layout` and `herdr-mod` topics, so the layout and the mods are listed at herdr.dev/layouts and herdr.dev/mods. Ask the agent in your Herdr to add one. Herdr's own add-a-layout steps read the recipe, tell you what the mods access, copy the files, run `herdr-app check` and switch layouts. Each package folder already has the shape those steps expect: `layouts/`, `mods/`, `RECIPE.md` and `preview.png`.

**2. With the installer.** It needs Node.js 22+ and `git`, nothing from npm, and is the only path that writes a rollback receipt:

```sh
git clone https://github.com/CiprianSpiridon/herdr-mission-control
cd herdr-mission-control
node scripts/install.mjs --dry-run                                            # disclosure and collision check; writes nothing
node scripts/install.mjs --app-home ~/.config/herdr-app --layout mission-control
```

Other forms:

```sh
node scripts/install.mjs --dry-run [--source mission-control] [--layout mission-control]
node scripts/install.mjs --app-home ~/.config/herdr-app [--layout mission-control]
node scripts/install.mjs --rollback --receipt <receipt> --app-home ~/.config/herdr-app
node scripts/install.mjs --verify-receipt evidence/native/install.json
```

It reads every package file and prints a capability disclosure before copying. It refuses any existing or shipped mod/layout name rather than overwriting or renaming, never writes `keys.json`, checks each new mod with `herdr-app check`, switches to the chosen layout and writes an owned-file hash receipt for rollback (by default `evidence/native/install.json` in the clone). Rollback removes only files whose hashes still match; to update, roll back with the old receipt and install the new version. `ctrl-shift-l` switches back to your previous layout at any time.

**3. By hand, one mod.** Copy `<name>/mods/<name>/` to `~/.config/herdr-app/mods/<name>/`, run `herdr-app check ~/.config/herdr-app/mods/<name>`, then open it with `herdr-app do mod.open '{"name":"<name>"}'` or mount it in your own layout.

## Configuration

All private settings live in `appHome()/mission-control/config.json` (normally `~/.config/herdr-app/mission-control/config.json`). Each mod's own setup dialog edits it; hand-editing is optional. Writes are compare-and-set against the previous text, conflicts retry a bounded number of times, and invalid or newer-version files are reported and left untouched.

```json
{
  "v": 1,
  "revision": 3,
  "connections": {
    "jira-work": { "id": "jira-work", "kind": "api", "site": "https://example.atlassian.net",
      "auth": { "kind": "basic", "usernameEnv": "JIRA_WORK_EMAIL", "tokenEnv": "JIRA_WORK_TOKEN" } },
    "github-work": { "id": "github-work", "kind": "github", "site": "https://github.com",
      "apiBase": "https://api.github.com", "credentialEnv": "GITHUB_WORK_TOKEN" },
    "gitlab-work": { "id": "gitlab-work", "kind": "api", "site": "https://gitlab.example.com",
      "auth": { "kind": "bearer", "tokenEnv": "GITLAB_WORK_TOKEN" } }
  },
  "bindings": {
    "[null,\"/Users/me/src/client-portal\"]": {
      "machine": null,
      "repoRoot": "/Users/me/src/client-portal",
      "jira": { "connectionId": "jira-work", "project": "WEB" },
      "github": { "connectionId": "github-work", "owner": "example", "repo": "client-portal" },
      "gitlab": { "connectionId": "gitlab-work", "projectPath": "example/client-portal",
        "status": { "labels": { "todo": ["To Do"], "inProgress": ["Doing"], "done": ["Done"] } } }
    }
  },
  "preferences": {},
  "usageSources": {}
}
```

- **Per space.** A repository space is identified by its machine (`null` for this computer) and canonical repository root, taken from the space's live terminal and Git common directory. Its binding may use Jira, GitHub and GitLab together, any one of them, or none. Different spaces can use different accounts, sites and projects. Nothing ever falls back to another repository, account or machine.
- **Connections** hold an ID, an HTTPS origin and the names of environment variables. Validation rejects credential-like fields such as `token`, `password` or `apiKey`; credential values never enter the file, shared state, logs, packages or screenshots.
- **Jira** connections are `api` (Basic or Bearer, optional `cloudId` routed through the Atlassian gateway), `cli`, `mcp-stdio` or `mcp-http`. CLI and stdio MCP run on this computer only.
- **GitHub** connections name either `credentialEnv` or an existing `gh` `{host, account}`. In progress needs an explicit label or Projects status mapping; otherwise open issues are To do and closed issues Done.
- **GitLab** connections name a bearer `tokenEnv`. In progress needs the optional label mapping shown above.
- Other private files in the same folder: `launches.json`, `session-bindings.json`, `names.json`, `tab-names.json` and `closed.json`. They are excluded from packages and from Git.

## What each mod may access

| Mod | Files outside its folder (under `appHome()/mission-control/`) | Programs | Network |
| --- | --- | --- | --- |
| Tabs | `config.json`, `tab-names.json`, `names.json`, `closed.json`, `launches.json`, `session-bindings.json` | `hc`, `herdr-app do/ls`, `git`, `python3`, `test`, `mkdir`, `sleep`, agent help/version probes and the chosen agent | None of its own |
| Spaces | `config.json`, launch journal, session bindings, names | `git`, `python3`, `hc`, `herdr-app`, agent probes, `mkdir`, `sleep`, local `open` (Finder) | None of its own |
| Agents | `config.json`, session bindings, names; provider session metadata under configured roots (defaults `~/.codex/sessions`, `~/.codex/archived_sessions`, `~/.claude/projects`, `~/.grok/sessions`), read-only; Claude Code's own process records `<claude root>/sessions/<pid>.json` (read-only, only the foreground PID's record and its job's record; never the `.key` files beside them) | `hc`, `python3`, tool discovery, `mkdir` | None |
| Jira | `config.json`, launch/session/name journals | local Node.js 22+, configured Jira CLI or stdio MCP, `git`, `python3`, the chosen agent | The configured Jira HTTPS origin, the Atlassian gateway when a `cloudId` routes there, or the configured HTTPS MCP endpoint |
| GitHub | `config.json`, launch/session/name journals | local Node.js 22+, optional `gh auth token`, `git`, `python3`, the chosen agent | The selected GitHub API origin only |
| GitLab | `config.json`, launch/session/name journals | local Node.js 22+, `git`, `python3`, the chosen agent | The configured GitLab origin only |
| Sessions | `config.json`, `launches.json`, `session-bindings.json`, `names.json`; provider history under the same default roots, read-only; Claude Code's own process records `<claude root>/sessions/<pid>.json` (read-only, only the foreground PID's record and its job's record; never the `.key` files beside them) | `python3`, `git`, `hc`, `herdr-app`, `mkdir`, `sleep`, agent probes and exact resume | None |
| Agent menu | `config.json`, launch journal, session bindings, names | `git`, `python3`, `hc get`, `herdr-app do/ls`, agent probes, `mkdir`, `sleep` | None of its own |
| Reopen | `closed.json`, `session-bindings.json`, `names.json`, `launches.json`; reads `config.json` | `hc`, `python3`, `git`, `test`, `herdr-app do/ls`, `mkdir`, `sleep`, agent probes and exact resume | None |

Remote machines are reached only through Herdr's configured machine transport. Agents that a mod starts keep their own login and network access. Source links open in the system browser. Mods never read auth files, copy credentials, log in or out, or change global tool configuration. Each recipe has the full disclosure.

## Capability limits

- **Fixture-only provider proof.** Jira, GitHub and GitLab behaviour has been tested against synthetic local TLS servers, fixture accounts and disposable tool actors. No authenticated live Jira, GitHub or GitLab tenant has been accessed or proven.
- **Read-only trackers.** No mod changes issue status, comments, reviews, approvals, threads, checks or pipelines. PR and MR actions only send a task to a local agent.
- **No account switching.** There is no seamless switching of a running agent's account. The optional accounts mod is deferred. Resume never switches accounts; with several enabled profiles for one tool on a host it cannot tell which login the CLI will use.
- **Exact-ID resume only.** Resume and Reopen last agent use an exact session ID with a flag the installed tool's own help verified: Claude Code `--resume <id>`, Codex `resume <id>`, Grok only when its help lists `--resume`. `--last` and `--continue` are never used. Anything else is shown as unsupported and starts nothing.
- **No split-pane restore.** Reopen brings back the main terminal only; split geometry, extra panes and mod panes are not restored. A shell returns in the folder it started in, and its old command is never replayed.
- **Honest readings.** Context remaining and quota appear only when a provider reports them for an exactly bound session; otherwise they read Unavailable or Stale. Quota is shared between agents only with evidence of the same account and host. Agents started from Mission Control (its agent menu, a card's tool button or a resume) are bound as they start. A Claude Code agent started any other way is adopted from Claude Code's own process record (`~/.claude/sessions/<pid>.json`) when that record names the terminal's foreground process and started during the terminal's life; a client attached to a background job reads that job's conversation. Codex and Grok agents started outside Mission Control stay Unavailable: those tools leave no exact process-to-session link. Claude Code reports context only through its status line, so its percentage comes from a status-line snapshot (`claude-statusline.json`, for example the one herdr-agent-usage writes) listed in the Claude source's `cacheRoots`. An idle agent keeps its last value, dimmed, with its age in the tooltip.
- **No OAuth login or refresh.** Tokens come from existing environment variables, or from existing `gh` storage for GitHub.
- **Bounds.** Boards keep at most 1,000 records or 7 MiB per scope, read 50 records per page and run at most four helper jobs at once.
- **Local helpers.** Jira CLI and stdio MCP adapters run on this computer even for a remote repository; a remote integration needs an HTTPS MCP endpoint.
- **Herdr 0.1.11 launch shape.** Herdr wraps a new tab's command in a `/bin/sh` login shell (`sh -c` on a remote host, where the shell stays in the foreground) and passes the task to the program as its last argument. Exact-session proof accepts exactly these forms and the earlier zsh/bash wrapper; any other extra argument is refused.

## GitLab runtime provenance

- `mission-control-gitlab` compiles only repository code: its build manifest lists sources under `src/mods/mission-control-gitlab/` and `src/shared/` plus `src/assets/icons.json`, with no `node_modules` input, and its `NOTICE.md` lists only original artwork.
- Its helper `backend.mjs` runs locally under Node.js 22+. It sends GitLab REST v4 reads (projects, issues, merge requests, approvals, discussions, closing issues and head-pipeline jobs, in 50-record pages) only to the configured HTTPS `site` origin at `<site>/api/v4`, and refuses off-origin redirects.
- It authenticates with the bearer token held in the environment variable named by the connection's `auth.tokenEnv`. The value stays in the helper's memory: no `glab` login, token persistence or OAuth refresh.
- Its mounted native gate (TASK-091) passed in a private Herdr 0.1.11 window; see below.

## Evidence status

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
| Both layouts integrated | TASK-007 | `evidence/native/layout.json` | Passed (51 assertions, 172 native inputs, 2026-11-02) |

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

## Repository layout

| Path | Purpose |
| --- | --- |
| `src/mods/<name>/` | Native mod sources (`main.js`, `mod.json`, helpers) |
| `src/shared/` | Shared source compiled into each mod (launch, config, tracker transport, collectors) |
| `src/layouts/` | Layout trees and Settings preview SVGs |
| `src/assets/icons.json` | Original control icons with provenance |
| `scripts/` | Builder, native harness and driver, installer, release, compatibility verifier |
| `tests/` | Node and Python tests; `tests/native/` holds the mounted native scenarios |
| `evidence/` | Native receipts and review records |
| `.ulpi/plans/`, `.ulpi/execution.json` | Canonical plans and the evidence ledger |
| `DESIGN-NOTES.md` | Confirmed requirements and open decisions |
| `work/` | Browser mockups with illustrative data |

## Reference workflows

These projects shaped the behaviour of individual mods. They are inspiration only: no code or artwork is incorporated, and this repository does not license them.

- [dantech99/herdr-linear](https://github.com/dantech99/herdr-linear): issue board and agent launch (Jira, GitHub, GitLab boards)
- [amster93/herdr-agent-menu](https://github.com/amster93/herdr-agent-menu): installed-tool agent menu
- [mustafaTokmak/herdr-reopen-tab](https://github.com/mustafaTokmak/herdr-reopen-tab): reopening closed tabs
- [longwave/herdr-auto-tabs](https://github.com/longwave/herdr-auto-tabs): automatic tab names

## License

Original work is under the MIT license in [LICENSE](LICENSE). [NOTICE.md](NOTICE.md) lists the third-party code compiled into the Jira helper and the provenance of all artwork.
