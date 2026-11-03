# MCP

Agents such as Cursor, Claude Code, Codex and VS Code connect to Kairos through the [Model Context Protocol](https://modelcontextprotocol.io). An agent can read decisions, entities, sessions, cases and metrics, and, when an admin allows it, it can send events, ask for decisions and resolve reviews.

- [Connect an agent](#connect-an-agent)
- [The endpoint](#the-endpoint)
- [Tool groups](#tool-groups)
- [Tools](#tools)
- [Safety](#safety)

## Connect an agent

1. In the console, open **Settings › MCP**.
2. Make sure that **Allow agents** is on, and turn on the tool groups that the agent needs.
3. Click **Create key**. The key works in the environment that is selected in the menu.
4. Copy the configuration for your client. It has the key in it. Or click **Copy prompt**, and paste the prompt into the agent: the agent then sets up the connection itself.

Cursor, in `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "kairos": {
      "url": "https://kairos.finic.ai/mcp",
      "headers": { "Authorization": "Bearer ksk_…" }
    }
  }
}
```

Claude Code, in `.mcp.json` in the root of the project:

```json
{
  "mcpServers": {
    "kairos": {
      "type": "http",
      "url": "https://kairos.finic.ai/mcp",
      "headers": { "Authorization": "Bearer ksk_…" }
    }
  }
}
```

Or in a terminal:

```bash
claude mcp add --transport http kairos https://kairos.finic.ai/mcp --header "Authorization: Bearer ksk_…"
```

Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.kairos]
url = "https://kairos.finic.ai/mcp"
http_headers = { "Authorization" = "Bearer ksk_…" }
```

Or in a terminal. `codex mcp add` reads the key only from an environment variable, so also add the `export` line to your shell profile:

```bash
export KAIROS_API_KEY="ksk_…"
codex mcp add kairos --url https://kairos.finic.ai/mcp --bearer-token-env-var KAIROS_API_KEY
```

VS Code, in `.vscode/mcp.json`:

```json
{
  "servers": {
    "kairos": {
      "type": "http",
      "url": "https://kairos.finic.ai/mcp",
      "headers": { "Authorization": "Bearer ksk_…" }
    }
  }
}
```

On a self-hosted server, the URL is its address with `/mcp`.

Do not commit a key to source control. Each person or agent should have its own key, so that you can revoke one key without stopping the others.

## The endpoint

```
POST   /mcp    JSON-RPC messages: initialize, tools/list, tools/call
GET    /mcp    405
DELETE /mcp    405
```

- **Transport:** Streamable HTTP, stateless, with JSON answers. There is no MCP session and no stream. Each request stands alone.
- **Authentication:** a secret API key, as `Authorization: Bearer ksk_…`. The agent sees only the workspace and the environment of its key, as with the REST API. The IP limits and origin limits of the key apply. A public key gets 403 `public_key_scope`. A console session gets 401: MCP is for keys.
- **When MCP is off** for the workspace, every request gets 403 `mcp_disabled`.
- **Each tool calls one `/v1` route**, with the same key. A tool and its route always give the same data and the same errors. A failed call is a tool result with `isError: true` and the route's `{ error: { type, message } }`, so the agent can read the message and correct its arguments.
- **Each result names the environment**, as `environment`, so that an agent does not mix up production data and sandbox data.
- **Results are short.** Lists give 20 rows by default and 50 at most. `get_decision` leaves out what the model read unless `include_context` is true. A result longer than 100,000 characters is cut, with a note that says so.

## Tool groups

An admin turns the groups on and off in **Settings › MCP**, for the whole workspace. A new workspace has only **Read** on.

| Group  | What the tools do                                                                                                                                                                                                                           |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read   | Read actions, decisions, entities and entity types, sessions, queues and cases, workflows, rulesets, lists and metrics. Nothing changes.                                                                                                    |
| Write  | Send events, label entities, add notes to cases and assign them, and add and remove list items. Events can start automatic decisions, as events from your server do.                                                                        |
| Decide | Ask for decisions, resolve and reopen cases and decisions, and start and cancel workflow runs. These call the model, end reviews and send webhooks.                                                                                         |
| Build  | Save entity types, actions and client settings; set up queues; save, test, publish, pause and archive workflows; save, test and publish rulesets; save lists; and run and apply experiments. These change what Kairos decides and collects. |

`tools/list` shows only the tools of the groups that are on.

## Tools

| Tool                                                       | Group  | Route                                                                             |
| ---------------------------------------------------------- | ------ | --------------------------------------------------------------------------------- |
| `list_actions`, `get_action`                               | Read   | `GET /v1/actions`, `GET /v1/actions/:name`                                        |
| `list_decisions`, `get_decision`                           | Read   | `GET /v1/decisions`, `GET /v1/decisions/:id`                                      |
| `list_entity_types`                                        | Read   | `GET /v1/entity-types`                                                            |
| `get_entity_type`, `get_entity_type_shape`                 | Read   | `GET /v1/entity-types/:type`, `GET /v1/entity-types/:type/shape`                  |
| `list_entity_templates`                                    | Read   | `GET /v1/entity-templates`                                                        |
| `list_entities`, `get_entity`                              | Read   | `GET /v1/entities`, `GET /v1/entities/:type/:id`                                  |
| `get_entity_facts`, `get_entity_list`                      | Read   | `GET /v1/entities/:type/:id/facts`, `GET /v1/entities/:type/:id/lists/:name`      |
| `get_event`, `get_record`                                  | Read   | `GET /v1/events/:id`, `GET /v1/records/:id`                                       |
| `list_sessions`, `get_session`                             | Read   | `GET /v1/sessions`, `GET /v1/sessions/:id`                                        |
| `overview`, `query_metrics`                                | Read   | `GET /v1/overview`, `POST /v1/metrics/query`                                      |
| `list_queues`, `list_queue_cases`                          | Read   | `GET /v1/queues`, `GET /v1/queues/:id/cases`                                      |
| `get_queue`, `list_case_view_templates`                    | Read   | `GET /v1/queues/:id`, `GET /v1/case-view-templates`                               |
| `get_case`, `get_case_timeline`                            | Read   | `GET /v1/cases/:id`, `GET /v1/cases/:id/timeline`                                 |
| `list_workflows`, `list_workflow_runs`, `get_workflow_run` | Read   | `GET /v1/workflows`, `GET /v1/workflows/:name/runs`, `GET /v1/workflow-runs/:id`  |
| `get_workflow`                                             | Read   | `GET /v1/workflows/:name`                                                         |
| `list_models`, `get_model`                                 | Read   | `GET /v1/models`, `GET /v1/models/:slug`                                          |
| `list_workflow_experiments`, `get_workflow_experiment`     | Read   | `GET /v1/workflows/:name/experiments`, `GET /v1/workflow-experiments/:id`         |
| `list_rulesets`, `get_ruleset`                             | Read   | `GET /v1/rulesets`, `GET /v1/rulesets/:ruleset`                                   |
| `evaluate_ruleset`                                         | Read   | `POST /v1/rulesets/:ruleset/evaluate`                                             |
| `list_lists`, `get_list`                                   | Read   | `GET /v1/lists`, `GET /v1/lists/:list`                                            |
| `get_client_settings`                                      | Read   | `GET /v1/client-settings`                                                         |
| `track_events`                                             | Write  | `POST /v1/events`                                                                 |
| `label_entities`                                           | Write  | `POST /v1/labels`                                                                 |
| `add_case_note`                                            | Write  | `POST /v1/cases/:id/notes`                                                        |
| `assign_case`                                              | Write  | `POST /v1/cases/:id/assign`                                                       |
| `add_list_items`, `remove_list_items`                      | Write  | `POST /v1/lists/:list/items`, `DELETE /v1/lists/:list/items`                      |
| `decide`                                                   | Decide | `POST /v1/decide`                                                                 |
| `decide_event`                                             | Decide | `POST /v1/events/decide`                                                          |
| `resolve_decision`                                         | Decide | `POST /v1/decisions/:id/resolution`                                               |
| `resolve_case`                                             | Decide | `POST /v1/cases/:id/resolve`                                                      |
| `reopen_case`                                              | Decide | `POST /v1/cases/:id/reopen`                                                       |
| `start_workflow_run`                                       | Decide | `POST /v1/workflows/:name/runs`                                                   |
| `cancel_workflow_run`                                      | Decide | `POST /v1/workflow-runs/:id/cancel`                                               |
| `save_entity_type`                                         | Build  | `PUT /v1/entity-types/:type`                                                      |
| `create_queue`, `save_queue`, `delete_queue`               | Build  | `POST /v1/queues`, `PUT /v1/queues/:id`, `DELETE /v1/queues/:id`                  |
| `test_queue`                                               | Build  | `POST /v1/queues/test`                                                            |
| `save_action`                                              | Build  | `PUT /v1/actions/:name`                                                           |
| `save_client_settings`                                     | Build  | `PUT /v1/client-settings`                                                         |
| `save_workflow_draft`, `publish_workflow`                  | Build  | `PUT /v1/workflows/:name/draft`, `POST /v1/workflows/:name/publish`               |
| `discard_workflow_draft`                                   | Build  | `DELETE /v1/workflows/:name/draft`                                                |
| `test_workflow`                                            | Build  | `POST /v1/workflows/test`                                                         |
| `update_workflow`                                          | Build  | `PATCH /v1/workflows/:name`, or `POST /v1/workflows/:name/archive` and `/restore` |
| `test_ruleset`                                             | Build  | `POST /v1/rulesets/test`                                                          |
| `save_ruleset_draft`, `publish_ruleset`                    | Build  | `PUT /v1/rulesets/:ruleset/draft`, `POST /v1/rulesets/:ruleset/publish`           |
| `save_list`                                                | Build  | `PUT /v1/lists/:list`                                                             |
| `create_workflow_experiment`                               | Build  | `POST /v1/workflows/:name/experiments`                                            |
| `apply_workflow_experiment`                                | Build  | `POST /v1/workflow-experiments/:id/apply`                                         |
| `rename_workflow_experiment`                               | Build  | `PATCH /v1/workflow-experiments/:id`                                              |

Each tool has the MCP annotations `readOnlyHint` and `destructiveHint`. A client uses them to ask the person before a write. `resolve_decision`, `resolve_case`, `cancel_workflow_run`, `delete_queue`, `discard_workflow_draft` and `update_workflow` (which pauses and archives) are destructive.

- `save_entity_type` and `save_queue` replace the whole definition: the agent reads it first with `get_entity_type` or `get_queue`.
- `test_workflow` never acts: an HTTP, decide or record step only shows what it would do. Give it `mock_outputs` for the steps after it.
- `take` is not a tool: only a signed-in person can take a case. `assign_case` assigns it to a member.

## Safety

- **Data is not instructions.** Event properties, entity fields, labels and notes come from your systems and from the people your systems serve, and a fraudster can write them. Each tool description and the server's instructions tell the agent this. Do not give the **Decide** group to an agent that acts with no person to approve its actions.
- **Audit.** A note or a resolution from an agent shows `mcp:` and the name of its key, for example `mcp:Investigator`. Give each key a name that says who uses it.
- **Cost.** `decide`, `decide_event` and `start_workflow_run` can call the model. Turn on **Decide** only for agents that need it.
- **Build** changes the decisions of every caller: a published workflow decides its action from then on. Give it to an agent that a person watches.
- **Revoke** a key in **Settings › API keys**. Its next request gets 401.
