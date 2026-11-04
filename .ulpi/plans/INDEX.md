# Mission Control plan index

One canonical plan per mod and one for the two-layout bundle. This is navigation and a derived dependency summary, not a master plan. Every plan requires founder review at its current JSON and Markdown SHA256 before implementation. Cross-plan references resolve globally unique TASK IDs through the JSON files listed here.

| Plan | Tasks | Scope / gate |
| --- | --- | --- |
| [Mission Control accounts feasibility gate](mission-control-accounts.md) · [JSON](mission-control-accounts.json) | 3 | Optional feasibility only; no shipped placeholder |
| [Mission Control agent menu](mission-control-agent-menu.md) · [JSON](mission-control-agent-menu.json) | 8 | Standalone mod, native check, recipe and actual preview |
| [Mission Control agents](mission-control-agents.md) · [JSON](mission-control-agents.json) | 14 | Standalone mod, native check, recipe and actual preview |
| [Mission Control GitHub](mission-control-github.md) · [JSON](mission-control-github.json) | 8 | Standalone mod, native check, recipe and actual preview |
| [Mission Control GitLab](mission-control-gitlab.md) · [JSON](mission-control-gitlab.json) | 14 | Standalone mod, native check, recipe and actual preview |
| [Mission Control Jira](mission-control-jira.md) · [JSON](mission-control-jira.json) | 10 | Standalone mod, native check, recipe and actual preview |
| [Mission Control mods](mission-control-mods.md) · [JSON](mission-control-mods.json) | 19 | Standalone mod, native check, recipe and actual preview |
| [Mission Control reopen](mission-control-reopen.md) · [JSON](mission-control-reopen.json) | 5 | Standalone mod, native check, recipe and actual preview |
| [Mission Control sessions](mission-control-sessions.md) · [JSON](mission-control-sessions.json) | 5 | Standalone mod, native check, recipe and actual preview |
| [Mission Control spaces](mission-control-spaces.md) · [JSON](mission-control-spaces.json) | 4 | Standalone mod, native check, recipe and actual preview |
| [Mission Control tabs](mission-control-tabs.md) · [JSON](mission-control-tabs.json) | 6 | Standalone mod, native check, recipe and actual preview |
| [Mission Control layout bundle](mission-control.md) · [JSON](mission-control.json) | 16 | Both layouts, shared foundations, native integration, installation and release |

Total: 12 plans; 112 tasks; 109 required / active-scope tasks. The optional account gate is not a dependency of any required plan.

## Dependency resolution

All dependsOn entries are globally unique TASK-NNN IDs. Each plan includes an externalDependencies map naming the owning companion JSON and capability for every direct cross-plan edge. The renderer validates the union for missing IDs, cycles, authored-file scope, observed create parents, previous creators, writer ordering and scoped-test ownership. JSON remains canonical; rerun `node .ulpi/plans/render.mjs --check` after edits.

## Package rules

- Standalone: `<name>/mods/<name>/`, `RECIPE.md`, native `preview.png`, optional `keys.json`; no `layouts/`. Public topic `herdr-mod`.
- Layout: `mission-control/layouts/` with both layouts, required `mods/`, `RECIPE.md`, native `preview.png`. Public topic `herdr-layout`.
- A single public repository may contain these complete folders and both topics. Runtime shared helpers are compiled inside each mod; no other mod code is read at runtime.

## Current evidence boundary

Implementation progress and exact validation receipts are recorded in `.ulpi/execution.json`. Existing source, standalone native packages and fixture evidence do not prove integrated layout behavior, live authenticated provider readings, installation or publication. A reopened task has no scheduling completion until replacement validation passes. Review reports live under evidence/reviews/ and must include hashes of both plan artifacts. Never treat task count or plan approval as implementation proof.
