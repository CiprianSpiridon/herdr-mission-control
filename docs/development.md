# Development

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

## Standalone packages and the layout bundle

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

## Installer reference

```sh
node scripts/install.mjs --dry-run [--source mission-control] [--layout mission-control]
node scripts/install.mjs --app-home ~/.config/herdr-app [--layout mission-control]
node scripts/install.mjs --rollback --receipt <receipt> --app-home ~/.config/herdr-app
node scripts/install.mjs --verify-receipt evidence/native/install.json
```

The installer reads every package file and prints a capability disclosure before copying. It refuses any existing or shipped mod or layout name instead of overwriting or renaming, never writes `keys.json`, checks each new mod with `herdr-app check`, switches to the chosen layout and writes an owned-file hash receipt for rollback (by default `evidence/native/install.json` in the clone). Rollback removes only files whose hashes still match. Use Control panel to review and apply published updates, including the layouts, bundled mods and Control panel itself. The installer receipt continues to identify the original install; rollback removes only files whose hashes still match it.
