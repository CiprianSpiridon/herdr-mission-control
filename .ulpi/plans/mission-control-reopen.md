# Plan: Mission Control reopen

## Overview

Include distinct Reopen last tab and Reopen last agent actions, preserving repo/host/task/manual-name identity and using exact session resume where available. Do not promise split geometry, mod-pane restoration or last shell cd without evidence.

Mode: **EXPANSION**. Review default: **codex**. Status: **draft**. Tasks: **5**.

Canonical source: [mission-control-reopen.json](mission-control-reopen.json).

## Scope Challenge

The approved feature scope is frozen. The implementation is greenfield native GPUI, so EXPANSION accurately describes the repository work; it does not add features beyond DESIGN-NOTES.md. Codex remains the review default. Atomic three-file scopes explain the task count.

## Prerequisites

- Herdr app 0.1.9 / hc 0.1.14 were observed; re-read installed declarations before execution and stop on incompatible contracts.
- All plans must pass founder review at their current hashes before implementation.
- Source, mounted native UI, authenticated provider checks, install and public publishing are separate gates.

Cross-plan prerequisites:

- TASK-050: [mission-control-sessions](mission-control-sessions.md) — Resume exact provider sessions on their original host
- TASK-003: [mission-control](mission-control.md) — Define private repo/connection settings with CAS persistence
- TASK-004: [mission-control](mission-control.md) — Create shared GPUI styling and local icon artwork
- TASK-002: [mission-control](mission-control.md) — Build self-contained native packages
- TASK-078: [mission-control](mission-control.md) — Provide a strict Node test seam for native GPUI modules
- TASK-005: [mission-control](mission-control.md) — Prove an isolated app AND core for native verification

## Non-Goals

- No modification of shipped mods/layouts, generated Herdr type files, AGENTS.md, existing user sessions or credential stores.
- No Jira/GitHub workflow mutation, autonomous issue assignment or paid agent calls for fetching boards.
- No claim that the HTML mockup or load-only native check proves live behavior.

## Contracts

- Native GPUI JavaScript only: gpui-kit / gpui-base / herdr are runtime externals. No DOM, Node, CSS or setTimeout in GPUI. Helpers run out of process through exec; cx is not retained across awaits.
- Source paths are observed under src/, scripts/, tests/ and evidence/. Existing completed foundation and mod outputs are recorded in .ulpi/execution.json; new targets remain explicit task-owned creates. A changed completed contract reopens its owner task, marks its current files Modify and removes the old scheduling completion until replacement evidence passes. Prototypes and external examples remain references, not native reuse.
- All TASK IDs are globally unique. dependsOn can refer to another plan; externalDependencies records the owning JSON and its provided capability. The generated index resolves and validates the union DAG. There is no master execution plan.
- Canonical JSON is the source of truth. Markdown, dependency maps, execution layers and critical paths are derived. A change invalidates the reviewed SHA256 of that plan and all materially affected consumers.
- Build compilation may produce multiple artifacts. generatedArtifacts are compiler / capture outputs, never hand-edited source. Each task has at most three authored files. The package builder owns compilation and materialization; output manifests enumerate hashes and source provenance.
- Every standalone package is <name>/mods/<name>/ plus RECIPE.md, actual preview.png, optional keys.json and notices; no layouts/. It must work after copying only that mod directory. Shared source is bundled inside main.js / backend.mjs or copied as collector.py inside that same mod, with no runtime cross-mod code imports.
- Layout package mission-control/ contains both layouts and byte-equivalent copies of required standalone mods. One public GitHub repository may hold all complete package folders and both topics herdr-mod and herdr-layout, as the installed sharing rules explicitly allow.
- IDs and caches qualify machine, canonical repo root, source, account/connection, site and issue/session ID. A null machine means local. Never select a different repo or account as fallback. Remote paths are not local paths.
- Herdr exec(command,args,{cwd,on}) has no stdin or env option, rejects unreachable hosts and bounds requests to 30 s / 8 MiB. Use argv arrays, not interpolated shell. run returns null, not created IDs. Acknowledged creation uses exec("herdr-app",["do","tab.new",JSON.stringify(args)]) and validates its actual result shape before recording success.
- Settings persist in appHome()/mission-control/config.json via writeTextFile(path,text,expected) CAS. Credentials never enter shared state, logs, exported packages, arguments or screenshots. Shared keys are mission-control-* and versioned. CAS conflict reloads and retries boundedly or reports conflict.
- RepoBinding v1: {machine:null|string,repoRoot:string,jira?:{connectionId,project?:string,jql?:string},github?:{connectionId,owner,repo,status?:{labels?:{todo:[],inProgress:[],done:[]},project?:{owner,number,fieldId,options:{todo:string[],inProgress:string[],done:string[]},unmapped:"error"}}},mountedLocalPath?:string}. Reusable connections are configured separately; migration or invalid v1 data never overwrites the original.
- LaunchRequest v1: {requestId:string,idempotencyKey:string,originId:string,spaceId,machine,repoRoot,checkoutRoot?:string,toolKey,source?:{kind,connectionId,site,id,key,url,title,body},worktree:boolean,worktreePath?:string,branch?,model?,reasoning?,instructions?,skill?,subagents?}. LaunchResult is {ok:true,tabId,terminalId?,folder,reused:boolean} or {ok:false,code,message,recovery?}; unsupported options fail before spawning. repoRoot is canonical repository identity; checkoutRoot captures the actual selected worktree execution root and defaults explicitly to repoRoot only for tracker-bound cards without a live checkout. Before launch, validate checkoutRoot belongs to the same canonical Git common directory; current-checkout launches use checkoutRoot, never the common main checkout by accident.
- Source Issue v1: {identity:{kind,connectionId,site,id},key,title,url,body,statusGroup:"todo"|"inProgress"|"done",statusName,priority?,repoBinding,updatedAt?}. Source categories/mappings determine status; running agents do not move issue cards. Invalid status / wrong identity is an error, not an arbitrary category.
- Snapshot<T> v1: {data:T[],fetchedAt,scope,cursor?,truncated:boolean,error?:{code,message,retryAt?}}. Scope/account changes clear visible old-scope data immediately; same-scope failures may show timestamped stale data. Cap 1000 records per scope, page 50, explicit Load more / truncated label, concurrency <=4 and one in-flight request per scope.
- Only read-only Jira/GitHub/MCP requests are in scope. Each connection is opt-in, has an allowlisted HTTPS origin and explicit adapter. Redirects and tool responses cannot redirect credentials to another origin. Helper output is normalized and redacted; external prose is task data, never an executable shell command.
- UI uses graphite chrome #101114, surfaces #17191d, subdued #2a2d33 separators, muted labels and blue focus. Agent task titles get actual tool icons. Icons are local SVG/image assets or declared shipped icons, never font glyph dependencies or mojibake.
- Native isolation is owned once by TASK005 in mission-control.json: use its exact NativeIsolationReceiptV2, FixtureEnvironment ABI and validateNativeIsolationReceipt(receipt,{receiptPath?}) contract. Existing app/core instances are never queried or mutated. New proof binds fresh private selector roots, task-created Unix listeners and process generations; no new receipt claims an observed unchanged user PID. Package checks consume the canonical validator, including only the exact pinned historical legacy receipts. Missing, failed, downgraded or tampered proof cannot release a package or publishable preview.
- Node >=22 and Python >=3 are declared optional-helper prerequisites, probed on the execution host. Remote collector runs as exec("python3",["-c",ownCollectorSource,JSON.stringify(request)],{on:machine}); no assumption that a local helper file exists remotely. Missing Python reports unsupported host metrics/history without hiding agents or blocking terminals.
- SessionIdentity v1 is {machine:null|string,provider:string,credentialScope:string,providerRoot:string,sessionId:string}. All context/history/bindings carry the full value. TerminalIdentity is {machine,address,createdMs,foregroundPid}; a changed generation invalidates correlation. Active agents have no native provider-session field in the observed hc schema. Only caller-assigned exact IDs, explicit resume argv or a verified provider-native/PID-file handshake bind them; cwd/title/recency never do.
- TabNameOwnership v1 is owned upstream by TASK-070, keyed by stable originId with optional exact SessionIdentity and current tab instance. launch/resume/reopen transfer ownership only after acknowledgment; observers bundled into standalone tabs/sessions/reopen record manual edits under one CAS lease. Unknown imported histories use reported-title fallback and have no invented manual name.
- Generic launch idempotencyKey identifies one UI intent, not every new-agent request in a repo. Separate generic intents mint distinct keys; retries retain the same key. Issue/PR quick-start dedup uses qualified host/repo/source/connection/site/item plus tool policy. Origin IDs remain distinct from source item keys and from ephemeral tab IDs.
- knownAgents().installed/run is authority for base generic launch, including shell functions/wrappers. Help probes only grant advanced/model/reasoning/caller-session/resume capabilities. A failed probe disables those options; it does not block a supported base run. An explicitly requested unsupported advanced option fails before side effects.
- JiraConnection v1 is discriminated: api {id,kind:"api",site:httpsOrigin,cloudId?:uuid,auth:{kind:"basic",usernameEnv,tokenEnv}|{kind:"bearer",tokenEnv}}; cli {id,kind:"cli",site,execution:{machine:null,command,argsTemplate:string[]},mapping:{issuesPath,nextCursorPath?,fields,statusGroups}}; mcp-stdio {id,kind:"mcp-stdio",site,execution:{machine:null,command,args:string[],envRefs:Record<string,string>},search:{tool,argsTemplate,resultMapping}}; mcp-http {id,kind:"mcp-http",site,url:httpsURL,auth?:{kind:"basic",usernameEnv,tokenEnv}|{kind:"bearer",tokenEnv},search:{tool,argsTemplate,resultMapping}}. Basic username/token are resolved only in helper memory. credentialEnv/envRefs contain environment variable names, never credentials. In this entire union, site means the canonical Jira serverInfo.baseUrl HTTPS origin, not a custom displayUrl; issue links deliberately use that canonical site.
- Jira API routing is explicit: Basic without cloudId uses the configured tenant site (unscoped token); an explicit cloudId routes Basic/Bearer through https://api.atlassian.com/ex/jira/{cloudId}, and serverInfo.baseUrl must match the configured canonical tenant origin before fetching issues. Setup labels site as canonical Jira base URL; if a custom displayUrl differs, show canonical-base-URL guidance and publish no mismatched cards, without silently rewriting the saved site. Bearer without cloudId discovers https://api.atlassian.com/oauth/token/accessible-resources, selects the unique Jira-scoped resource matching the exact tenant URL, then uses that gateway route. Never infer token type or select the first accessible site. OAuth access tokens are existing env references; this release does not implement OAuth login/refresh. Credential origins are only the configured tenant or the fixed official gateway for the selected route; issue links always retain the tenant site. cloudId/auth/profile/query changes invalidate cursors and cached scope.
- Jira CLI and stdio MCP execute locally in the panel helper in this release; execution.machine must be null and a remote value is a setup error, never local fallback. Repo execution machine is independent and can be remote. A remote integration may expose explicitly configured HTTPS MCP; no local backend path is assumed present on a server. Existing agent MCP configuration requires explicit server/tool/profile selection, not automatic process sharing.
- GitHub Projects mapping uses stable fieldId and option IDs grouped into todo/inProgress/done; setup fetches field/options and saves explicit selection. Unknown/unmapped or multiply mapped option is an actionable configuration error. Without any status mapping, closed is Done and open is To do with an explicit unmapped-progress explanation.
- GitHub PullRequest v1 and PRActionRequest v1 are defined once by TASK044 in .ulpi/plans/mission-control-github.json, including author, explicit ref availability, independent discussion access and action-specific task mapping. That owning contract is canonical; this plan does not duplicate or redefine the PR schema. The layout consumes the GitHub mod views; unrelated mods do not acquire a runtime dependency on its model.
- All Node tests that import GPUI modules use node --import ./tests/support/native-loader.mjs --test <owned test>. TASK-078 supplies a strict recording tree/action seam, not a real renderer. Actual UI proof requires TASK-077 PID-bound native input plus before/after status/frame assertions; structural commands alone never prove a click.
- Usage/history source access implements the already-requested features: read-only documented standard provider session roots on their own host, with source settings and exact path disclosures, no extra permission prompt. Extra roots/legacy cache paths are explicitly configured. Disable/change cancels publication, clears related bindings/caches and stops subsequent reads. No auth files, credential copying or automatic hook rewrites.
- Launch source.id is stable provider identity; source.key is the visible naming snapshot. Issue mappings copy identity.id separately from key. GitHub PR canonical owner/repo#number identity, immutable captured checkout and action task mapping are owned by TASK044 in .ulpi/plans/mission-control-github.json. Existing source/path/ref snapshots stay immutable for acknowledged requests; unsafe or occupied fresh worktree targets remain errors.

```mermaid
flowchart TD
  TASK_050["TASK-050: Resume exact provider sessions on their original host"]
  TASK_003["TASK-003: Define private repo/connection settings with CAS persistence"]
  TASK_004["TASK-004: Create shared GPUI styling and local icon artwork"]
  TASK_002["TASK-002: Build self-contained native packages"]
  TASK_078["TASK-078: Provide a strict Node test seam for native GPUI modules"]
  TASK_005["TASK-005: Prove an isolated app AND core for native verification"]
  TASK_055["TASK-055: Track recently closed tabs and agent identity durably"]
  TASK_050 --> TASK_055
  TASK_003 --> TASK_055
  TASK_056["TASK-056: Restore original-space work without unsafe replay"]
  TASK_055 --> TASK_056
  TASK_057["TASK-057: Register the standalone reopen controls and watcher"]
  TASK_056 --> TASK_057
  TASK_004 --> TASK_057
  TASK_002 --> TASK_057
  TASK_078 --> TASK_057
  TASK_058["TASK-058: Prove reopen in an isolated native window"]
  TASK_057 --> TASK_058
  TASK_005 --> TASK_058
  TASK_059["TASK-059: Package reopen as a standalone Herdr mod"]
  TASK_058 --> TASK_059
```

## Existing Code Leverage

| Observed path / reference | Classification | Use |
| --- | --- | --- |
| AGENTS.md | inspected reference | Existing repository guidance; preserve this file unchanged. |
| DESIGN-NOTES.md | inspected reference | Accepted requirements and explicit packaging / planning instructions. |
| work/mission-control-two-views.html | inspected reference | Visual / interaction reference only; no HTML is used by the native runtime. |
| /Users/ciprian/.config/herdr-app/AGENTS.md | inspected reference | Installed Herdr rules, read on 2026-10-30, including sharing / recipe requirements at lines 403-457. |
| /Users/ciprian/.config/herdr-app/herdr.d.ts | inspected reference | Installed API truth: exec, knownAgents, readTextFile, writeTextFile, spaces, agents, layout and overlay commands. |
| /Users/ciprian/.config/herdr-app/mods/tabs/main.js | inspected reference | External installed implementation inspected for tab semantics; do not import or read another mod at runtime. |

## Tasks

### TASK-055: Track recently closed tabs and agent identity durably

Own the last-100 closed-record CAS journal appHome()/mission-control/closed.json, qualifying machine/address/tab plus createdMs generation, stable origin and exact session identity. Primary capture observes live spaces/panes/terminals every 2s while the shared watcher is active, snapshots before this mod's close actions and treats missing host snapshots as unavailable, not closure. Only accept disappearance as closed when the same ready host has valid follow-up data or an explicit confirmed close. Optional historical bootstrap/manual import uses exec("python3",["-c",boundedOwnWrapper,request],{on:machine}) per ready host; the wrapper runs hc ls --all --json locally on THAT host, stops reading/kills only its hc client after 4 MiB or 5s, emits <=100 relevant high-water records and no raw argv. A capped/malformed/failed import reports older-history-unavailable and retains the existing journal; no frequent all-history polling. After restart/reconnect, reconcile against bounded snapshots without inventing past closures. Store safe program/resume identity and title only, not task/auth-bearing argv. CLI shape is explicit: hc ls --all --json returns a summary envelope and lacks argv/labels/created_ms/finished_ms. The bounded wrapper validates that envelope, then hydrates a bounded cursor batch through hc get <localAddress> --json on that same host to obtain full Terminal data. Total wrapper bytes/time stay within 4MiB/5s; unhydrated history is marked incomplete and never claimed to be globally newest. Reopen-last uses proven observed journal ordering; partial imported history is separately labeled until the complete candidate scan establishes ordering. Raw argv is never returned/persisted.

**Type:** feature  
**Priority:** P1  
**Effort:** L  
**Agent:** general-purpose  
**Review:** codex  
**Depends on:** TASK-050, TASK-003

**Acceptance Criteria:**

- Actual observed closes produce at most 100 correctly ordered machine-qualified records; explicit local/remote wrappers use their own host and imported results are bounded below the 8 MiB boundary.
- Local and remote identical tb1/t1 through disconnect/reconnect plus one actual close yield one correct record; huge hc history/import failure cannot lose current journal or invent a closure.

**Write scope:**

| File | Action | Role |
| --- | --- | --- |
| src/shared/closed-tabs.js | Create | Closed-record schema, hc snapshot/diff normalization, persistence and consumption state. |
| tests/closed-tabs.test.mjs | Create | Real journal CAS with closed shells/agents, disconnected host, record bounds and sensitive argv redaction. |

**Validate:**

```sh
node --test tests/closed-tabs.test.mjs
```

### TASK-056: Restore original-space work without unsafe replay

Own reopen(kind,io) and exports consumed by the tabs mod. Recreate a closed space only from verified saved root/host, restore shell in starting cwd, and exact agent through shared resume. Already-live exact work focuses; consume records only after acknowledged success. Preserve manual titles and auto-name ownership metadata; do not replay arbitrary old commands or lose records on failure. Transfer TASK-070 origin/manual-name ownership to acknowledged replacements; unsupported unrecorded old split geometry/history remains explicitly unavailable.

**Type:** feature  
**Priority:** P1  
**Effort:** L  
**Agent:** general-purpose  
**Review:** codex  
**Depends on:** TASK-055

**Acceptance Criteria:**

- Reopen last tab and Reopen last agent produce distinct correct results and restore/focus the original host/space.
- Failed/offline/unsupported restore leaves the record available with reason; unsafe command replay, duplicate tabs or guessing --last are rejected.

**Write scope:**

| File | Action | Role |
| --- | --- | --- |
| src/shared/reopen.js | Create | Reopen orchestration, correct-space restoration, exact resume and acknowledged consume/focus. |
| tests/reopen.test.mjs | Create | Shell-vs-agent selection, deleted space/cwd, concurrent clicks, failed ack and preserved names. |

**Validate:**

```sh
node --test tests/reopen.test.mjs
```

### TASK-057: Register the standalone reopen controls and watcher

Expose two clearly labeled actions through command dispatch and compact native popup; no conflicting default keys. A single bounded collector/watcher per app home records closures across views using a CAS lease; bundle the same controller into tabs for default layout availability without requiring a visible reopen panel. Document limitations visibly in help.

**Type:** feature  
**Priority:** P1  
**Effort:** L  
**Agent:** general-purpose  
**Review:** codex  
**Depends on:** TASK-056, TASK-004, TASK-002, TASK-078

**Acceptance Criteria:**

- Both actions work when this mod alone is installed; the layout tabs can also call compiled helpers without a visible extra panel.
- A second mounted copy cannot double-record or double-consume a closure; no history shows a clear empty state.

**Write scope:**

| File | Action | Role |
| --- | --- | --- |
| src/mods/mission-control-reopen/main.js | Create | Native actions, event/refresh lifecycle, same-mod status/recovery popup. |
| src/mods/mission-control-reopen/mod.json | Create | Standalone manifest and reopen-tab / reopen-agent commands. |
| tests/reopen-mod.test.mjs | Create | Command routing, one-watcher lease, missing records and no-sibling-mod runtime tests. |

**Validate:**

```sh
node --import ./tests/support/native-loader.mjs --test tests/reopen-mod.test.mjs && node scripts/project.mjs check mission-control-reopen
```

**Generated outputs (not authored source):**

- mission-control-reopen/mods/mission-control-reopen/main.js
- mission-control-reopen/mods/mission-control-reopen/mod.json
- mission-control-reopen/mods/mission-control-reopen/assets/*.svg

### TASK-058: Prove reopen in an isolated native window

Close shell then an exact-ID agent, test each reopening action and repeated click; verify original host/repo/name, shell skip, deleted/offline target and no forced split-geometry claim. Include identical local/remote tb1/t1 IDs, a transient remote disconnect/reconnect, one actual close and bounded historical-import overflow; assert exactly one correctly qualified restored record.

**Type:** test  
**Priority:** P1  
**Effort:** L  
**Agent:** general-purpose  
**Review:** codex  
**Depends on:** TASK-057, TASK-005

**Acceptance Criteria:**

- A standalone install containing only this mod passes herdr-app check and the mounted scenario; capture its actual rendered preview with zero app errors.
- A missing capability / empty-state scenario is exercised; no generated success receipt or screenshot is accepted when an assertion or isolation proof fails.

**Write scope:**

| File | Action | Role |
| --- | --- | --- |
| tests/native/reopen.mjs | Create | Native scenario, uses the shared harness and asserts actual UI / command outcomes. |
| evidence/native/reopen.json | Create | Machine-readable commands, outcomes, isolation identities, errors and screenshot hashes; generated evidence, no private content. |

**Validate:**

```sh
node scripts/native-harness.mjs run reopen
```

**Generated outputs (not authored source):**

- mission-control-reopen/preview.png

### TASK-059: Package reopen as a standalone Herdr mod

Write the six-part reconstruction brief from the finished files. Validate the package in a fresh folder with no other custom mod installed; include access / program / network disclosures and applicable attribution.

**Type:** docs  
**Priority:** P1  
**Effort:** L  
**Agent:** general-purpose  
**Review:** codex  
**Depends on:** TASK-058

**Acceptance Criteria:**

- Copying only mods/mission-control-reopen/ is sufficient; no sibling mod code or repository path is read at runtime.
- The exact preview hash matches the passed native receipt; missing recipe, fake/absent preview or any layouts/ folder fails package validation.

**Write scope:**

| File | Action | Role |
| --- | --- | --- |
| mission-control-reopen/RECIPE.md | Create | Recipe in Herdr order: summary + preview, What you see, How it behaves, Built from, Watch out, Done when. |
| tests/package-reopen.test.mjs | Create | Asserts self-contained runtime imports, own assets/helpers, recipe sections and absence of layouts/. |
| mission-control-reopen/preview.png | Create | Actual native frame from the preceding scenario, not a browser mock or generated illustration. |

**Validate:**

```sh
node scripts/project.mjs build mission-control-reopen && node --test tests/package-reopen.test.mjs
```

**Generated outputs (not authored source):**

- mission-control-reopen/mods/mission-control-reopen/main.js
- mission-control-reopen/mods/mission-control-reopen/mod.json
- mission-control-reopen/mods/mission-control-reopen/assets/*.svg

## Failure Modes

| Failure | Containment / recovery |
| --- | --- |
| Invalid / outdated config | Keep the original bytes, display the validation error and edit/retry; never reset silently. |
| Offline host / missing executable / timeout | Keep correctly scoped timestamped data, disable only the affected action, show host and retry; never execute locally as fallback. |
| Partial install / package collision | Refuse overwrites, retain the previous layout and owned-file receipt; rollback removes only newly installed matching-hash files. |
| Wrong account or malformed provider output | Reject the response, redact error details and clear wrong-scope data. Authentication never switches global CLI state. |
| Task-local assertion / native check failure | Do not advance dependent tasks, install or publish. Fix within the task scope, rerun its scoped validation and refresh any invalidated consumer evidence. |

## Ship Cut

Do not publish or install a partially working package. A checked, self-contained standalone mod may ship after its own native evidence, recipe and real preview; the layout waits for all mandatory mod plans.

## Test Coverage Map

| Task | Paths | Gate |
| --- | --- | --- |
| TASK-055 | src/shared/closed-tabs.js, tests/closed-tabs.test.mjs | unit / contract plus native gate: node --test tests/closed-tabs.test.mjs |
| TASK-056 | src/shared/reopen.js, tests/reopen.test.mjs | unit / contract plus native gate: node --test tests/reopen.test.mjs |
| TASK-057 | src/mods/mission-control-reopen/main.js, src/mods/mission-control-reopen/mod.json, tests/reopen-mod.test.mjs | unit / contract plus native gate: node --import ./tests/support/native-loader.mjs --test tests/reopen-mod.test.mjs && node scripts/project.mjs check mission-control-reopen |
| TASK-058 | tests/native/reopen.mjs, evidence/native/reopen.json | mounted native integration: node scripts/native-harness.mjs run reopen |
| TASK-059 | mission-control-reopen/RECIPE.md, tests/package-reopen.test.mjs, mission-control-reopen/preview.png | artifact / package validation: node scripts/project.mjs build mission-control-reopen && node --test tests/package-reopen.test.mjs |

## Execution Summary

| Metric | Derived value |
| --- | --- |
| Tasks | 5 |
| Local roots | TASK-055 |
| Union DAG layers reached | 21, 22, 23, 24, 25 |
| Critical path including prerequisite plans | TASK-001 → TASK-003 → TASK-012 → TASK-013 → TASK-071 → TASK-015 → TASK-016 → TASK-038 → TASK-046 → TASK-047 → TASK-048 → TASK-049 → TASK-080 → TASK-084 → TASK-085 → TASK-086 → TASK-088 → TASK-089 → TASK-090 → TASK-050 → TASK-055 → TASK-056 → TASK-057 → TASK-058 → TASK-059 |
| Cross-plan task dependencies | 6 |

Layers (global prerequisite depth, not arbitrary serial order):

- Layer 21: TASK-055
- Layer 22: TASK-056
- Layer 23: TASK-057
- Layer 24: TASK-058
- Layer 25: TASK-059

## Task Dependencies

```json
{
  "TASK-055": [
    "TASK-050",
    "TASK-003"
  ],
  "TASK-056": [
    "TASK-055"
  ],
  "TASK-057": [
    "TASK-056",
    "TASK-004",
    "TASK-002",
    "TASK-078"
  ],
  "TASK-058": [
    "TASK-057",
    "TASK-005"
  ],
  "TASK-059": [
    "TASK-058"
  ]
}
```
