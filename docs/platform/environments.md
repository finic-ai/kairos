# Environments

An environment is a separate set of data inside a workspace. Each workspace has one **Production** environment and any number of named **sandboxes**, such as Development, Staging or an experiment. Use a sandbox to build and test an action, a workflow or a model on real history, without a change to production.

## What is separate

Each environment has its own:

- events, entities, entity types, labels and sessions
- actions, policies and decisions
- workflows and their runs, and models
- queues, cases and dashboards
- API keys, inbound and outbound webhooks, background jobs and usage

The same customer or event id in two environments is two separate records. Products that share customer history send to the same environment, with the same entity ids.

Members, roles and invites belong to the workspace, not to an environment. A member can work in every environment; there are no environment roles.

## Choose an environment

| Where | How |
|---|---|
| An API key | The key chooses it. Make a key in each environment, and give each deployment the key of its environment. |
| The console | The environment selector, at the top right and in the workspace menu. The choice is kept for each workspace. API keys, webhooks, jobs and usage show the selected environment only. |
| The CLI | `kairos login --environment Staging`, or `kairos use --environment Staging` for a profile that is signed in. `kairos environments` lists them. |
| A signed-in request | The `X-Kairos-Environment` header. Without it, Production. See [Authentication](authentication.md#signed-in-people). |

Results from [MCP](../reference/mcp.md) name their environment, so that an agent does not mix production data with sandbox data.

## Make a sandbox

An owner or an admin opens **Settings › Environments**, chooses a name, and starts empty or copies from another environment of the workspace. Each kind of data can be copied in full, or item by item with a search:

| Copy | What comes with it |
|---|---|
| Entities | Definitions, profiles, properties and labels. Can be chosen by type. |
| Actions | Definitions and policies. |
| Events | History, with its links to entities, sessions and records. Can be chosen by type. |
| Dashboards | Shared dashboards, and your own private ones. |
| Queues | Their setup, not their cases. |
| Decisions | History, with its context, answers and resolutions. A decision brings its triggering events and the action versions it needs. |
| Models | Active models with all their versions and files. Never in the default copy. |

Actions copied without their decisions start at version 1, from the latest definition.

The copy is made from one consistent snapshot, and it is independent of its source. **Automatic decisions are off** in every copy, and copying history runs no action and sends no webhook. API keys, webhook endpoints, credentials and delivery logs are **never copied**: make new ones in the sandbox.

## Rename and delete

A sandbox can be renamed. To delete one, type its name: this deletes its data and its keys, and cannot be undone. Production cannot be renamed, and it is deleted only with its workspace. Names are unique in a workspace, without regard to case.

## From a sandbox to production

Nothing moves from a sandbox to production by itself. Make the same change in production when it is ready:

- **Actions and workflows:** define them again in production, with the console, the CLI or the API.
- **Models:** promote a version from its page in the sandbox, or with `kairos models promote loan-default@3 --to production`. A promotion needs a person who is signed in, because a key works in one environment only. See [Models](models.md#7-into-production).
- **Backtests:** copy history into a sandbox, change the action there, and ask for decisions with a past `ts`. See [Models](models.md).

The endpoints are in the [API reference](../reference/api.md#environments).
