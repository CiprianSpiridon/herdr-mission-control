# Mission Control — Design Notes

Status: implementation planning authorized. Mission Control is the working name. The accepted two-view prototype guides the native build; it is not the implementation.

## Confirmed requirements

- Extend Herdr for a power user managing **100+ spaces** and **dozens of agents** across multiple machines and servers.
- Treat each workspace/space as a **repository**. Its issue-tracking configuration belongs to that repo's space; different spaces can use different Jira accounts, sites, and projects.
- Keep a **classic view**: navigation in the left column and the selected work in the main area.
- Provide **two complete layouts**, **Mission Control** and **Classic (normal)**, with **one button to swap between them**. Mission Control includes all the planned default mods; Classic emphasizes the active repo's terminals and exposes the same features as side panels. Interpret the user's "normal five" as "normal view".
- Show **Spaces** and **Agents** as separate sections in the left column. Each section must collapse and expand independently.
- Show **two separate indicators beneath each agent**: **the session's remaining context before compaction** and **account quota remaining**. Context is session-specific; quota belongs to the provider/account and may be shared across several agents. Identify that scope and show unavailable or stale readings honestly. Quota display is required independently of the optional account-switching mod.
- Show each agent's **actual tool icon**, such as Claude Code or Codex, beside the **agent/task name**. Do not repeat the tool name as the primary row title. Icons must render in ordinary Chrome without depending on the conversation renderer.
- Put quick action buttons in the **Agents** section to toggle easily between **Priority** (agents ordered by priority) and **Spaces** (agents grouped by their space).
- Publish the custom Spaces and Agents mods as **standalone packages**, as well as bundling them with the complete Mission Control layout. Each standalone mod needs its own recipe and preview.
- Add an **Atlassian Jira integration**, using [dantech99/herdr-linear](https://github.com/dantech99/herdr-linear) as the reference workflow. Publish the Jira integration as a standalone package and bundle it with Mission Control.
- Use the user's **installed local coding agents to fix Jira tasks**, with an explicit choice of **Claude Code, Codex, or another installed tool** before starting work. Discover the installed choices through Herdr and show their tool icons. The selection determines which coding tool actually runs.
- Let users define the **Jira project or filter for each space**, selecting an existing Jira connection/integration where available, including an MCP server or CLI. The integration requires provider adapters; automatic access to an agent's existing MCP configuration must be verified.
- Jira and GitHub issues must use **compact workflow views** with **To do**, **In progress**, and **Done** clearly separated. Replace the long, widely spaced issue rows. Issue keys and titles are direct links to the issue in its tracker.
- Each issue exposes **one-click launch icons for up to three pinned installed agents**. Initial defaults are **Claude Code, Codex, and Grok** when installed; users can choose and order different tools in **Settings → Agent shortcuts**. Additional installed tools stay available from a compact menu. This limit applies to quick-launch buttons, not the running Agents list.
- Issue quick-launch uses saved defaults without opening a setup dialog each time. Default issue worktree names concatenate the workspace and issue identifier, for example **`client-portal-WEB-142`**. An options menu provides overrides; generic **New agent…** still asks about worktrees and tool choice.
- The repo-based interaction mockup is accepted as a starting point: space selection, per-space Jira connection/project, combined **All spaces** view, and selecting an installed tool to work on an issue.
- Include **GitHub issues and pull requests alongside Jira issues**, available in Mission Control and as dockable side panels. A repo space can use both Jira and GitHub issue tracking.
- Include **GitLab issues and merge requests** through a separate `mission-control-gitlab` mod. It must work standalone without either custom layout installed, and expose its source views alongside Jira/GitHub in Mission Control and Classic side panels when the layout bundle is installed. Use the prepared `.ulpi/plans/mission-control-gitlab.{md,json}` pair, founder-review it before execution, and integrate its dependencies into the layout plan. Queue it after the existing GitHub work.
- Add a **cleaner configurable agent menu**, using [amster93/herdr-agent-menu](https://github.com/amster93/herdr-agent-menu) as a reference.
- Include **Reopen last tab** and **Reopen last agent** by default in the layout, using [mustafaTokmak/herdr-reopen-tab](https://github.com/mustafaTokmak/herdr-reopen-tab) as a reference. These are separate actions; reopening an agent skips shell-only tabs.
- Include **automatic tab naming by default in both layouts**, inspired by [longwave/herdr-auto-tabs](https://github.com/longwave/herdr-auto-tabs). It applies to every eligible tab shown by our tab bar, including generic agent/terminal launches, Jira/GitHub issue work, PR actions, reopened tabs, and resumed sessions. Preserve manual user names.
- Provide an easily accessible **previous agent sessions list for each workspace**, so users can find and resume saved sessions later.
- Each space has a **right-click context menu** with **Open in Finder** and **New agent…**.
- Keep space-row actions as a **compact icon-only button** with an accessible label; the visible word "Actions" wastes sidebar space. Fix encoding and icon rendering at their source.
- Preserve **Settings** and **Add machine** at the **bottom-most left of the sidebar in both layouts**, matching vanilla Herdr. Production actions should use Herdr's native settings/machine management.
- **New agent…** opens a dialog that asks whether to use a **new worktree** and which **installed coding agent** to run. The selected space supplies the repository and execution machine.
- Desired but **optional if difficult**: a separate **Claude Code / Codex account-switching mod**, to reduce repeated login/logout when account usage is exhausted. Skip this feature if it requires a fragile implementation; it must not block the main layouts and other mods.
- Use **`mission-control-` as the prefix** for standalone package and runtime mod names to reduce conflicts with shipped and third-party mods.

### Package and mod naming

- Complete layout package: `mission-control/`, containing `layouts/mission-control.json`, `layouts/mission-control-classic.json`, and their bundled mods.
- Spaces package: `mission-control-spaces/`, containing `mods/mission-control-spaces/`.
- Agents package: `mission-control-agents/`, containing `mods/mission-control-agents/`.
- Jira package: `mission-control-jira/`, containing a **single runtime mod**, `mods/mission-control-jira/`. That mod includes both the issue panel and the dialog for choosing and starting an installed coding tool on a Jira task. Internal JavaScript files can separate the views and helpers within that one mod folder.
- Planned GitHub package: `mission-control-github/`, containing GitHub issues, PR views, and their local-agent actions. Its views should also work as side panels.
- Planned GitLab package: `mission-control-gitlab/`, containing `mods/mission-control-gitlab/`, its own recipe and actual preview. One mod supplies distinct issues and merge-request views with local-agent actions; standalone distribution has no `layouts/` folder.
- Planned agent menu package: `mission-control-agent-menu/`.
- Planned shared tab-bar package: `mission-control-tabs/`, combining the native topmost tab bar with automatic naming and integration with our agent menu and reopening actions. Both layouts use the same mod.
- Planned reopening package: `mission-control-reopen/`, covering both tab and agent reopening.
- Planned session-history package: `mission-control-sessions/`, showing previous agent sessions for a repo space and resuming the selected session.
- Optional account-switching package: `mission-control-accounts/`, separate from the agent list and from issue-tracking mods.
- Use these same mod names in layout references, overlay targets, asset paths, commands, and shared-state keys; for example, `mission-control-jira.refresh`.
- Visible interface labels can simply read **Spaces**, **Agents**, and **Jira**.

### Jira workflow to carry over from the Linear example

Reference reviewed: the repository's [README](https://github.com/dantech99/herdr-linear/blob/main/README.md), [RECIPE](https://github.com/dantech99/herdr-linear/blob/main/RECIPE.md), file tree, and MIT license.

- Show configured Jira work grouped into **To do**, **In progress**, and **Done**, with key/title links, priority, and concise metadata. Include completed issues rather than limiting the view to open assigned issues.
- Provide status filters, text search by key or title, manual refresh, and periodic refresh.
- Open an issue in the browser when its row is clicked.
- Put up to **three pinned agent-icon quick-launch actions** on each issue. These start work with saved defaults in one click; keep the configurable launch dialog behind the issue's options menu, inside the same mod.
- Offer a tool picker populated from the user's installed local coding agents, such as Claude Code and Codex. Let the user choose the tool, then a model and reasoning level where supported; add optional instructions, a skill prefix, and a request to use subagents.
- Configure each repo's space with its Jira connection/account and project or filter; the space identifies the repository and execution machine for work on its issues.
- Start the chosen installed coding tool with the issue details as its task in the associated repo's space, using the saved launch defaults and a default worktree named `<workspace>-<issue-id>`.
- Remember launch preferences between uses.
- Make the issue panel usable independently of the complete layout, following the example's popup/docked-panel approach.
- Show agents started from Jira in Mission Control's normal Agents section and preserve the issue identity for navigation.

Implement issue browsing and agent launching as two views within the single Jira mod. The dialog can open the same mod with props identifying the launch view and selected issue. The reference's MIT attribution must be retained if its code is reused.

### Space context menu and new-agent flow

- Right-click targets the space clicked, even when a different space is currently selected.
- **Open in Finder** opens that space's repository folder for local spaces. Remote-folder access through Finder still needs a mounted-folder design.
- **New agent…** opens an agent-launch dialog for that space, showing its repo and machine.
- Ask whether to use the current checkout or create a new worktree; when a new worktree is chosen, collect the branch/worktree details.
- Show the tools installed on the execution machine, with tool icons, and let the user choose Claude Code, Codex, or another available agent.
- The exact dialog arrangement and defaults remain open. Model/reasoning controls can follow the chosen tool's capabilities.

### Default reopening and per-workspace session history

- **Reopen last tab:** restore the most recently closed tab in its original space and machine.
- **Reopen last agent:** restore the most recently closed agent session, skipping shell-only tabs, in its original repo space and machine.
- Each repo space exposes **Sessions** history with an easy route back into a previous session.
- History should resume the selected tool's exact saved session. An already-running session should be navigated to rather than duplicated.
- The reference was reviewed through its README, recipe, metadata, and file tree. It reconstructs closed terminal tabs and uses `claude --continue` or `codex resume --last` for eligible commands. It documents limits: split geometry, changed working directories, and mod panes are not fully restored; its published validation is on Linux, so macOS needs verification.

### Automatic tab naming

Reference reviewed: [Auto tabs README](https://github.com/longwave/herdr-auto-tabs/blob/main/README.md) and [recipe](https://github.com/longwave/herdr-auto-tabs/blob/main/RECIPE.md). It extends the shipped tab bar, derives Claude conversation names from terminal titles, derives terminal names from the running program or folder, preserves manual renames through tracked auto-generated names, and allows labels up to 280px. The reference only supplies conversation-aware naming for Claude Code; broader tool support is our requirement and needs validation.

- Use an agent's meaningful reported conversation/task title when available. For issue/PR launches, retain the issue/PR identity alongside the task title.
- Support Claude Code, Codex, Grok, and other installed tools through available Herdr/provider metadata. Fall back to the known task, program display name, or folder when a tool does not expose a conversation title; do not fabricate a title.
- A shell tab shows the running program's display name, then returns to the folder name when idle at the prompt.
- A manual rename wins and persists across layout switches, close/reopen, and session resume. Offer an explicit route back to automatic naming.
- Track which names are ours so automatic renaming does not mistake its own `tab.rename` writes for user-authored names. Qualify ownership with the machine/tab identity.
- Keep names bounded and readable, with full-title access when truncated, native tab selection/reordering/status controls, and the tab bar in the topmost window bar in both layouts.
- Integrate auto-name ownership with all launch/reopen/resume paths; avoid competing copies rewriting titles or generating repeated rename commands when nothing changed.
- Use the installed Herdr data/command API and validate live naming behavior. A load-only `herdr-app check` with empty live data cannot prove renaming works.

## Open planning items — proposals, not agreed requirements

### Spaces and navigation

- Grouping across machines and servers, including collapsible machine groups.
- Search across spaces, machine names, folders, and branches.
- Favorites, recent spaces, sorting, and keyboard switching.
- Whether selecting a space restores its last active tab and terminal.

### Agents and attention

- Exact Priority ordering. Suggested starting point: needs input, finished awaiting review, working, idle.
- Scope of the Priority and Spaces views across machines; placement of machine labels.
- Agent row identity: task or terminal title, status, tool icon, and space/machine.
- Whether selecting an agent opens its space and tab and focuses its terminal.
- Quick actions for starting an agent and jumping to the next one needing attention.

### Session context

- Where each tool exposes session context and its compaction threshold.
- Percentage, token count, progress bar, or a combination beneath each agent.
- Presentation of unavailable, stale, or estimated data.
- Behavior when a session compacts or reconnects.
- Account quota remaining is an additional required agent-row indicator. Define the provider/account identity, quota windows and reset labels where available, refresh behavior, and shared-account accounting. Do not present an account-wide quota as a separate allowance for every session.

### Layout and interaction

- Two full mockups are requested before implementation: Mission Control with the mods available, and the normal/classic terminal view with dockable panels. Both must show the single-button layout swap.
- Switching views should preserve the selected repo/space and running work. Reuse the same data and source-aware actions in expanded and side-panel presentations.
- User rejected the initial Classic mockup as cluttered and the mixed Mission Control cards as poorly separated. Classic must be terminal-first, with work panels closed by default and secondary actions in a menu. Mission Control needs distinct Jira, GitHub issues, pull requests, and previous-session views.
- Visual reference is the user's vanilla Herdr screenshot: graphite `#101114` chrome and `#17191d` terminal surfaces, subtle gray borders, muted labels, restrained blue focus accents, and compact native typography. Keep the UI clean and consistent with that reference.
- **Tabs remain in the topmost window bar in both layouts**, matching the user's vanilla Herdr screenshot. Do not introduce a second tab bar inside the terminal area.
- In source/history views, the selected navigation tab supplies the title. **Do not repeat Jira, GitHub issues, Pull requests, or Previous sessions as a second content heading.** Keep only useful account/repo metadata above the list.
- Add Jira and GitHub brand icons beside their navigation tabs, with matching source icons in the docked panel. Pull-request and session-history glyphs should be similarly compact and self-contained.
- Use self-contained actual tool icons; the first mockup's renderer-dependent glyphs did not render in the user's Chrome. Agent row hierarchy is tool icon plus task/name, then repo/status, then separate context and shared-account quota indicators.
- Sidebar width, adjustable Spaces/Agents divider, and independent scrolling.
- Counts and status summaries when sections are collapsed.
- Density, colors, typography, and visual style.
- Remembered collapse states, widths, grouping mode, and filters.
- Keyboard shortcuts and how they coexist with existing bindings.

### Optional account switching

- Separate Claude Code and Codex tabs with named account profiles, a visible selected profile, and convenient sign-in/profile selection.
- Keep provider account limits separate from the session context-before-compaction indicator under each agent. Show usage/reset data only where a provider exposes it reliably.
- Target provider/machine scope explicitly and verify whether a change applies to new launches, a resumed session, or an already-running process. Do not promise seamless live account switching.
- Treat this as optional: defer or omit it if robust switching is hard. A separate mod should not become a dependency of the other features.
- Preliminary official sources: [Claude Code multiple-account configuration directories](https://code.claude.com/docs/en/authentication#log-in-with-multiple-accounts) and [Codex authentication/credential storage](https://learn.chatgpt.com/docs/auth#credential-storage). Claude documents account-specific configuration directories. Codex documents local credential caching and storage under its configured home or OS store. These sources do not establish a safe live-switching mechanism for every existing session; provider-specific behavior still needs validation. No credentials or logins were changed during planning.

### Agent menu refinement

Reference reviewed: [Agent Menu README](https://github.com/amster93/herdr-agent-menu/blob/main/README.md) and [recipe](https://github.com/amster93/herdr-agent-menu/blob/main/RECIPE.md). It provides installed-tool discovery on the active space's machine, icons, pinning, hiding, popup-scoped numbered shortcuts, persistent preferences, and a separate edit mode. Its code is Apache-2.0 and its Lucide icons are ISC; preserve applicable attribution if reused.

Proposed improvements: searchable installed tools; clearly labeled repo/machine destination; a compact normal menu with customization in a separate view; shared favorites across generic, issue, and PR launch flows; and optional model/reasoning details revealed after tool selection. Keep Terminal, New space, and worktree actions distinct. Exact visual design and keyboard shortcuts remain open.

### Session history and recovery details

- Entry-point proposal: a visible history action on each space plus a **Sessions** view in the workspace; consider a **Sessions…** context-menu item too.
- Suggested history fields: tool, session title/task, last activity, branch/worktree, machine, and running/closed state, with search and tool filters.
- Read tool-native saved session history as needed, in addition to Herdr's recently closed terminal records. History needs to cover previous resumable sessions, not only tabs closed during the current app run.
- Store/identify exact provider session IDs and resume in the associated repo/worktree on the correct machine. `--last` alone may pick the wrong conversation when many sessions share a repo.
- Decide the global versus current-space scope of reopening actions and show the destination clearly.
- Preserve tool identity during resume; selecting a different tool belongs to starting a new session.
- Retention, missing worktrees, offline machines, tools without supported resume/history, and migrated repo paths need defined behavior.
- Shortcut proposals must be checked against existing bindings. The reference's macOS action is Cmd+Shift+T; the second action's shortcut is still undecided.

### Machines and servers

- Connection and availability indicators.
- Behavior when a machine disconnects or its layout is unavailable.

### Jira integration

- Jira Cloud, Jira Data Center, or both; authentication and support for multiple sites/accounts.
- Panel placement in the classic view: another collapsible sidebar section, a separate docked panel, or a popup opened on demand.
- Issue scopes and filters can include assigned/project work, boards, sprints, and saved/custom JQL. Both issue sources must display **To do / In progress / Done**; completed work is part of the requested view.
- Per-space Jira connection/account selection and project/filter settings, plus branch naming and base-branch preferences.
- Provider adapters for existing Jira MCP servers, Jira CLIs, and direct APIs. Connection profiles should be reusable across spaces, with authentication stored outside the public package. An agent's MCP access and the panel's ability to fetch issues need separate verification.
- Which issue details go into the agent task, and whether the panel also offers a full issue detail view.
- Whether launching or finishing work changes Jira status, adds comments, or links pull requests; these write actions are not yet agreed.
- Refresh cadence, pagination, and clear loading, empty, connection, and authentication states.
- Reopening an issue that already has an agent/worktree versus starting additional work.
- Whether the issue action can also assign a task to an already-running local agent session, in addition to launching a fresh session of the chosen tool.
- How issue identity appears alongside agents and spaces, and how to open the related issue from them.
- Map Jira workflow categories and configured statuses into the three columns. GitHub progress must come from a configured Projects Status field or explicit label mapping; do not invent an In progress state from the presence of an agent. Preserve unrecognized/canceled states explicitly rather than silently marking work complete.
- Reuse or focus an existing issue session/worktree safely on repeat starts. Concurrent launches of different tools into the same issue worktree need an explicit policy; never overwrite an existing branch/worktree.

Workflow references: [Jira status categories](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-workflow-status-categories/) and [GitHub Projects single-select fields](https://docs.github.com/en/issues/planning-and-tracking-with-projects/understanding-fields/about-single-select-fields).

#### Proposed Jira, GitHub issues, and pull requests views

- Present **Jira**, **GitHub issues**, and **Pull requests** as peer views, each supporting **This space** and **All spaces** scopes. Keep Jira's panel and its launch dialog inside its one mod; GitHub issues and PRs need their own source-aware views.
- Embed the same work-tracking views in the Mission Control main area or dock them beside the terminals as a side panel. Panel mode and expanded mode should share state and actions, and the mods should be usable in other Herdr layouts too.
- Configure Jira connection/project separately from the repo's GitHub connection/account. A space can have both trackers, either tracker, or neither; preserve native source identities and cross-links.
- GitHub issues view: compact To do / In progress / Done groups, linked issue keys/titles, and the same three pinned one-click agent actions as Jira.
- Jira issues view: compact To do / In progress / Done groups, linked issue keys/titles, and saved-default one-click agent starts for the associated repo space. Show supporting metadata without turning each issue into a long, tall row.
- Pull requests view: open/draft PRs for the repo, linked Jira issues, author, review state, and CI/check status where the code-host adapter exposes them.
- Proposed PR filters: all open, mine, review requested, and changes requested.
- Proposed PR actions: open in browser, review with an installed agent, address review comments, and fix failing checks. Exact actions and write behavior still need agreement.
- Obtain PR data through the repository's code-host integration (GitHub, Bitbucket, GitLab, etc.), using supported MCP/CLI/API adapters. Jira-linked development information can supplement issue associations; availability depends on the configured integration and permissions.
- Scope Jira identity by site/account and issue identifier, and PR identity by host/repository and PR identifier, so multiple accounts and identical issue keys or PR numbers stay distinct.
- In **All spaces**, preserve repo, machine, Jira connection, and code-host identity; actions target the row's associated space.
- Decide whether the PR view shows all repo PRs or only those linked to Jira, and how PRs without a Jira association are presented.

Reference: Atlassian documents [development-tool links on Jira issues](https://support.atlassian.com/jira-software-cloud/docs/view-development-information-for-an-issue/) and [issue-key references in development work](https://support.atlassian.com/jira-software-cloud/docs/reference-issues-in-your-development-work/). Use documented provider APIs; the Jira development-information API is not a universal cross-provider PR inbox.

#### Proposed repo-based issue navigation

- Selecting a repo's space shows the Jira issues from that space's configured connection and project/filter.
- Offer an **All spaces** scope that combines the configured per-space issue lists, grouped by repo and labeled with Jira account/site and project. Each issue retains its source-space association.
- On **Work on issue**, show the associated repo, space, execution machine, and Jira connection; choose the installed coding tool before starting.
- Start a new agent tab inside the repo's existing space for each task, with the issue worktree supplying its working folder by default. Use `<workspace>-<issue-id>` naming; saved preferences and the options dialog can override defaults.
- In the combined view, starting work on a row targets that row's associated space. When an issue is associated with several repos, the user needs a destination choice.
- Populate the tool picker from coding agents installed on the execution machine.
- Associate the Jira issue with its agent session and repo space. Show linked work in the issue list, offer a jump to its agent/space, and expose the issue link from the agent row.
- Herdr agent execution status and Jira issue workflow status need distinct presentation; Jira write-back behavior is still undecided.

Interaction sketch: `work/repo-jira-flow.html`, using example data to explore repo selection, per-space connections, **Issues** and **Pull requests** views, **This space / All spaces** scopes, issue/PR filters, linked-issue navigation, and choosing a local tool for issue work, PR reviews, comments, or failing checks. The sidebar also illustrates Priority/Spaces grouping and per-session context remaining. It is a planning illustration rather than a working Herdr mod; all issue, PR, agent, and context values are illustrative.

Current full mockups: `work/mission-control-two-views.html`. This supersedes the earlier single-panel sketch. It contains both complete layouts, vanilla Herdr's dark palette, topmost window tabs, compact action icons, bottom-left Settings/Add machine controls, dedicated source/history tabs, and context plus quota beneath task-named agents. Classic work panels start closed. Account switching remains optional.

Latest issue-view revision: both Jira and GitHub use compact **To do / In progress / Done** boards. Card keys and summaries are links, and each card shows up to three pinned one-click tool buttons. Default examples are Claude Code, Codex, and Grok; **Settings → Agent shortcuts** changes their selection/order and the workspace's automatic-worktree preference. Preview starts use `<workspace>-<issue-id>` names and focus an existing same-tool issue session on a repeat click. The mockup's Jira links use reserved example domains; native integration must use the actual configured issue URLs. Preview launches remain simulated.

Browser verification: the self-contained file was opened directly without the conversation renderer. UTF-8, embedded tool/tab icons, layout switching, source separation, worktree/tool selection, saved-session resume, reopening actions, and 128-space search passed. No horizontal overflow was observed at 1024, 736, or 375 pixels, and no browser runtime errors were reported. These are prototype checks; they do not validate native mods or live provider integration. Screenshots are retained under `.browse/sessions/mission-control-design/`.

Additional browser checks passed for all three Jira/GitHub workflow groups, key/title links, direct Grok launch without a setup dialog, deterministic worktree naming, repeated-start session focus, changing the third pinned shortcut to OpenCode in Settings, persistence of the shortcut order, and embedded Grok icon loading. The broader layout/session/context-menu checks also passed after this revision. Updated screenshots: `mission-control-board.png` and `classic-board.png` in the same evidence folder.

Verified Cloud implementation references for later: [enhanced JQL search and token pagination](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/), [REST v3 description format](https://developer.atlassian.com/cloud/jira/platform/rest/v3/), and [authentication guidance](https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/). Jira's data model and API need their own adapter; the Linear API calls cannot simply be renamed.

### Packaging

- Final repository folder structure and bundling details.
- Planned package folders: `mission-control/`, `mission-control-spaces/`, `mission-control-agents/`, `mission-control-jira/`, `mission-control-github/`, `mission-control-agent-menu/`, `mission-control-tabs/`, `mission-control-reopen/`, and `mission-control-sessions/`; optionally `mission-control-accounts/`. Each distributable package has its own `RECIPE.md` and `preview.png`.
- Exact PR adapter/package decomposition across GitHub and other code hosts remains open; avoid making generic PR browsing require a Jira connection.
- How standalone mod sources are bundled into the complete layout without maintaining divergent copies.
- Installation and validation workflow for each package.

## Delivery target

The user has activated the goal to create the DAG, run founder reviews until findings are resolved, and then build under Herdr's rules. Proceed with the previously recommended HOLD scope and Codex review defaults. The new build instruction supersedes the earlier brainstorming-only stage; optional account switching may still be omitted if robust support is difficult.

Packaging requirements apply separately:

- Maintain **one canonical DAG plan per mod** and **one plan for the layout bundle**. Founder-review **every plan**, correct actionable findings, and repeat review before implementation. Cross-plan dependencies must be explicit; an index is navigation, not a replacement master plan.

- **Standalone mod:** one package folder containing `mods/<name>/`, optional `keys.json`, `RECIPE.md`, and a real `preview.png`; **no `layouts/` folder**. Publish to a public GitHub repository with topic **`herdr-mod`**.
- **Layout bundle:** one package folder containing its layout files, required mods, `RECIPE.md`, and a real `preview.png`. Publish to a public GitHub repository with topic **`herdr-layout`**.
- When using one public repository for multiple packages, keep each complete package in its own folder and add both discovery topics. All standalone packages must remain self-contained after copying only their `mods/` contents; generated common helpers belong inside each mod folder.

Once the design is agreed, build the layout according to `~/.config/herdr-app/AGENTS.md`. Package `layouts/<name>.json`, its custom `mods/`, a reconstruction brief named `RECIPE.md`, and an actual screenshot named `preview.png` together in this repository. Publish it to a public GitHub repository with the topic `herdr-layout`.

The recipe must describe the finished implementation: what the person sees, how it behaves, what it is built from, pitfalls, and checks proving it works. Run `herdr-app check` for every custom mod and verify the rendered layout before publishing.

Native routing clarification from founder review: canonical `repoRoot` identifies a repository for bindings and deduplication; captured `checkoutRoot` selects the actual linked-worktree execution directory. Generic launches must supply it from the live resolver. Jira/GitHub/PR actions retain captured checkout, repo, account and host through async work and later space changes. A tracker card without a captured live checkout may explicitly use its canonical repository root.
