# Jira authentication contract revision

Verified against primary Atlassian documentation on 2026-10-31. This is documentation and fixture-design evidence; no authenticated user account was accessed.

| Source | Required behavior |
| --- | --- |
| [Personal API tokens](https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/) | Unscoped Basic tokens use the tenant; scoped tokens require the official gateway and cloud ID. Do not classify a token by its length or contents. |
| [Service-account tokens](https://support.atlassian.com/user-management/docs/manage-api-tokens-for-service-accounts/) | Support explicit cloud-ID gateway routing with Basic or Bearer credentials. |
| [OAuth resources](https://developer.atlassian.com/cloud/jira/software/oauth-2-3lo-apps/) | Discover resources with the existing access token. Match the exact configured tenant URL and Jira scopes; a container ID can appear more than once. Never pick the first resource. |
| [Server info](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-server-info/) | Compare the explicit cloud-ID route's `baseUrl` with the configured tenant before publishing its issues. A failed or mismatched verification produces a setup error. |
| [MCP token authentication](https://developer.atlassian.com/cloud/rovo-mcp/guides/configuring-authentication-via-api-token/) | Personal tokens use Basic auth; service-account keys use Bearer. API-token MCP tool calls may need an explicit cloud ID argument. Organization enablement and scopes remain upstream requirements. |

The revised `JiraConnection` contract therefore allows optional API `cloudId` and both HTTP MCP auth types. Credential values stay in helper memory, resolved from environment references. The selected tenant or fixed official gateway is the credential destination; direct issue links retain the tenant origin. OAuth login, refresh and another agent's active MCP session are not inferred or copied.

TASK-032 owns the schema and shared credential-header resolver; TASK-034 owns API routing and tenant verification; TASK-036 owns MCP endpoint isolation; TASK-037/039 own setup fields and saved routing; TASK-033 fingerprints cloud ID and credential references. Tests for gateway URLs route through an explicitly injected transport into an owned local TLS fixture. They must not send fixture credentials to live Atlassian endpoints.

The earlier approvals are archived under `pre-auth-route-snapshots/`. Renewed reviews must name the current plan hashes; an old approval is not a gate for this revision.
