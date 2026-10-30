# CLI

`kairos` works with Kairos from a terminal: send events, import history, ask for decisions, work cases, and manage models and keys.

## Install

```bash
npm install -g @kairos/cli
kairos --help
```

It needs Node.js 22 or later.

## Sign in

```bash
kairos login --url https://kairos.finic.ai --key ksk_…
kairos whoami
```

A sign-in with a secret key works in the key's workspace and environment, for the data commands. On a server that offers password sign-in, `kairos login --url … --email you@example.com` signs you in as a person: that also opens the workspace commands, such as `keys` and `environments`, and `models promote`.

Each sign-in is kept as a **profile** in `~/.kairos/config.json`. Keep one for each server or environment:

```bash
kairos login --profile prod --url https://kairos.finic.ai --key ksk_…
kairos profiles list
kairos profiles use prod
kairos use --environment Staging     # for a profile that is signed in with an email address
kairos logout
```

When `KAIROS_API_KEY` is set, it is used in place of the profile's credentials, for example in CI.

## Send and decide

```bash
kairos track login -e user=user_42 -e device=dev_9 -p ip_country=GB
kairos track --file events.jsonl
kairos decide withdrawal -e user=user_42 -p usd=900
kairos label user:user_42 fraud_confirmed -p source=chargeback
```

`-e` names an entity (`type=id`), and `-p` sets a property. To load history from CSV or JSON lines, see [Import your history](../../getting-started/import-history.md).

## Commands

| Command | |
|---|---|
| `track`, `decide`, `label` | Send an event, ask for a decision, add a label. |
| `import events`, `import entities`, `import labels` | Load history from a file. `kairos import --help` lists every option. |
| `decisions` | `list`, `get <id>`, `resolve <id> approve\|block [--note text]`. |
| `entities`, `entity-types` | List, read and set entities; read and define entity types. |
| `actions` | `list`, `get`, `define <name> --data @action.json`, and `templates`. |
| `sessions` | `list`, `get <id>`. |
| `workflows` | `list`, `get`, `define`, `publish`, `pause`, `activate`, `run`, `runs`, `status`, `cancel`. |
| `models` | `list`, `get`, `upload`, `score`, and `promote <slug>@<version> --to <environment>`. |
| `queues`, `cases` | List queues and cases; `take`, `assign`, `note`, `resolve` and `reopen` a case. |
| `stats`, `usage` | Counts, and use for each day. |
| `workspaces`, `environments`, `keys`, `jobs` | The workspace, for a person who is signed in with an email address. |
| `api <METHOD> <path>` | Any endpoint of the [API](../api.md), with `--data` and `--query`. |

## Options for every command

| Option | |
|---|---|
| `--json` | Print the JSON of the API, for scripts. |
| `--profile <name>` | Use another saved profile (or `KAIROS_PROFILE`). |
| `--url <url>` | Use another server (or `KAIROS_URL`). |
| `-h`, `--help` | Show the help of a command. |
