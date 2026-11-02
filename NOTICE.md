# Notices

This file records what this repository copies from other people and under which terms. Everything not listed here is original Mission Control work under the MIT license in [LICENSE](LICENSE). Reference projects that only inspired behaviour are listed at the end; nothing from them is included or licensed here.

## Original work

The MIT license covers the code and documents authored in this repository:

- native mod, layout and helper source under `src/` (including the Python collectors in `src/shared/`);
- build, QA, install and release tooling under `scripts/` and tests under `tests/`;
- the 25 control icons in `src/assets/icons.json`, each recorded there as `Original Mission Control artwork` with license `MIT`;
- the two Settings layout previews `src/layouts/mission-control.svg` and `src/layouts/mission-control-classic.svg`;
- recipes, design notes, plans and documentation.

Generated package folders (`mission-control*/`) contain compiled copies of this work. Each mod folder carries its own generated `NOTICE.md` listing exactly the artwork and third-party code compiled into it.

## How bundled third-party code is identified

`scripts/project.mjs` compiles each mod with esbuild and records every compiled input in that package's `build-manifest.json` (`sources`). For every input that comes from `node_modules`, `dependencyNotices` copies the package's own license file into the mod's `NOTICE.md`. A build fails when a bundled dependency has no license text. The native GPUI entry points may import only the Herdr runtime modules (`gpui-kit`, `gpui-base`, `herdr`) and repository source, so third-party packages can appear only in the out-of-process Node helpers (`backend.mjs`).

This notice was reconciled on 2026-11-01 against a full rebuild of every package from the current source in an isolated scratch copy of the repository, and against the committed package folders. Both give the same third-party set.

## Third-party code included in distributed packages

Only the Jira helper includes third-party code. `mission-control-jira/mods/mission-control-jira/backend.mjs` (and its byte-identical copy under `mission-control/mods/mission-control-jira/` in the layout bundle) bundles the official MCP TypeScript SDK and its runtime dependencies, used for the read-only Jira MCP adapter:

| Package | Version | License |
| --- | --- | --- |
| `@modelcontextprotocol/sdk` | 1.32.2 | MIT |
| `ajv` | 8.20.0 | MIT |
| `ajv-formats` | 3.0.1 | MIT |
| `content-type` | 1.0.5 | MIT |
| `cross-spawn` | 7.0.6 | MIT |
| `eventsource-parser` | 3.1.1 | MIT |
| `fast-deep-equal` | 3.1.3 | MIT |
| `fast-uri` | 3.1.9 | BSD-3-Clause |
| `isexe` | 2.0.0 | ISC |
| `json-schema-traverse` | 1.0.0 | MIT |
| `path-key` | 3.1.1 | MIT |
| `pkce-challenge` | 5.0.1 | MIT |
| `shebang-command` | 2.0.0 | MIT |
| `shebang-regex` | 3.0.0 | MIT |
| `which` | 2.0.2 | ISC |
| `zod` | 4.6.7 | MIT |
| `zod-to-json-schema` | 3.25.2 | ISC |

The complete copyright and license text of each package, copied from the installed package, is in `mission-control-jira/mods/mission-control-jira/NOTICE.md`. That file travels with the mod in both distributions; keep it whenever the mod is copied.

The same helper contains esbuild's generated CommonJS interop wrappers (`__commonJS`, `__toESM` and similar). esbuild 0.28.2 is a build-time development dependency and is not shipped; it is MIT licensed, Copyright (c) 2020 Evan Wallace.

No other package compiles third-party code. The build manifests of `mission-control-agent-menu`, `mission-control-agents`, `mission-control-github`, `mission-control-gitlab`, `mission-control-reopen`, `mission-control-sessions`, `mission-control-spaces` and `mission-control-tabs` record no `node_modules` input, and their `NOTICE.md` files list only original artwork. The `collector.py` copied into Agents and Sessions is original and imports only the Python standard library.

## Artwork and names

- Every SVG under a mod's `assets/` comes from `src/assets/icons.json` and is original Mission Control artwork (MIT).
- Coding-agent icons are not shipped. Mods draw each tool with the icon path Herdr reports for that installed program at run time.
- Jira, Atlassian, GitHub, GitLab, Claude Code, Codex, Grok and other product names are trademarks of their owners. They are used only to identify the services and tools a user connects. No endorsement is implied.

## Prototype files outside every package

`work/mission-control-two-views.html` is a browser mockup, not part of any package. It embeds third-party icon artwork as base64 SVG data: LobeHub agent marks (MIT) for Claude Code, Codex, opencode and Grok, Simple Icons marks (CC0 1.0) for GitHub and Jira, and Lucide glyphs (ISC). Their provenance, the comparison evidence and the full upstream license texts are in [work/THIRD-PARTY-NOTICES.md](work/THIRD-PARTY-NOTICES.md); this repository's MIT license does not cover them. `work/repo-jira-flow.html` only names Lucide icons and embeds no icon artwork.

## Reference projects (inspiration only)

These projects were reviewed as behaviour references. No code, artwork or text from them is included, so their licenses do not apply to this repository and this repository grants no license to them:

- [dantech99/herdr-linear](https://github.com/dantech99/herdr-linear): issue-board and launch workflow for the Jira mod.
- [amster93/herdr-agent-menu](https://github.com/amster93/herdr-agent-menu): installed-tool menu, pins and shortcuts.
- [mustafaTokmak/herdr-reopen-tab](https://github.com/mustafaTokmak/herdr-reopen-tab): reopening the last closed tab.
- [longwave/herdr-auto-tabs](https://github.com/longwave/herdr-auto-tabs): automatic tab naming that keeps manual renames.

`DESIGN-NOTES.md` records the licenses seen during review (MIT for herdr-linear; Apache-2.0 code with ISC Lucide icons for herdr-agent-menu). If any of their code or artwork is ever copied, add it here with its license and attribution first.
