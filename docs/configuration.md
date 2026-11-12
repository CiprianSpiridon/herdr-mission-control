# Configuration

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
- Other private files in the same folder: `launches.json`, `session-bindings.json`, `names.json`, `tab-names.json`, `closed.json` and `running-agents.json`. They are excluded from packages and from Git.

## Resume after restart

When Herdr brings an agent's terminal back as a plain shell because the terminal's own process was lost (a reboot, a logout, a Herdr core crash, or that process killed), Mission Control types the agent's own resume command with its exact session ID into that shell. It is on by default. To turn it off, set it under `preferences`:

```json
"preferences": { "resumeAfterRestart": false }
```

Anything other than `true` or `false` also turns it off and says so. With it off, Mission Control keeps recording but never types and never offers.

- **Typed by itself** only when the restored shell is an idle sh, bash, zsh, dash or ksh, is in the folder the agent ran in, is less than 15 minutes old, and the tool's own help still verifies its exact resume on that machine. Time powered off does not expire a recorded running agent: after battery loss it can resume even if the laptop stays off overnight. The 15-minute limit starts when the restored shell starts.
- **Offered otherwise**, as **Resume N** next to the Reopen buttons (Tabs) or **Resume N agents** in the Reopen bar, with the exact command for each. Resume types it once; Dismiss forgets it. An offer also goes away once that shell runs anything else, or after 24 hours.
- **Never resumed:** agents you quit, and agents that crash inside a tab (Herdr's wrapper turns back into the tab's shell, which looks exactly like quitting).
- **Codex** needs **Set up Codex resume** once per machine, in the Sources gear (Tabs) or the Reopen bar. It installs `mission-control-session-hook.py` into Codex's home (`$CODEX_HOME` or `~/.codex`) and adds one SessionStart hook at the end of `hooks.json`, after a dated backup. The next time Codex starts it asks you to trust the hook (`/hooks`); until then Codex agents are not recorded. Start Codex with `--no-daemon`, so the hook runs inside your terminal. A Herdr integration update that rewrites `hooks.json` can drop the hook; the setup action then appears again.
- **Files:** `running-agents.json` in this folder holds `{terminal, tool, session ID}` per running agent; nothing else about the conversation. It is excluded from packages and from Git like the other journals.

## Context and quota sources

`usageSources` lists where each coding tool keeps its session history on each machine. Mission Control fills in the standard locations on first run. Each source has:

- `roots`: folders of session files it reads, for example `~/.claude/projects` or `~/.codex/sessions`;
- `cacheRoots` (optional): folders holding a status-line snapshot. Claude Code reports its context percentage and plan quota only through its status line, so point the Claude source at the folder where your status line writes `claude-statusline.json`. The same folder can hold `codex-app-server.json` and `grok-cli-billing.json`.

```json
"usageSources": {
  "[null,\"claude\",\"/Users/me/.claude\",\"standard\"]": {
    "v": 1, "enabled": true, "machine": null, "provider": "claude",
    "providerRoot": "/Users/me/.claude", "credentialScope": "standard",
    "roots": ["/Users/me/.claude/projects"],
    "cacheRoots": ["/Users/me/.local/state/herdr/plugins/herdr-agent-usage"]
  }
}
```

## Work sources

The gear next to the view swap turns individual work sources (Jira, GitHub issues, Pull requests, GitLab issues, Merge requests, Previous sessions) on or off. The choice is kept in Herdr's shared state, `mission-control-tabs-sources-v1`, not in this file.
