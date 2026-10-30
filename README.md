# Kairos

Event intelligence and decisioning for financial behavior.

You send Kairos what happens in your product. You say in plain language what you want decided. At the moment of action you ask, and it answers with approve, step up, review or block, and with the signals behind the answer. There are no static rules to write and no features to engineer.

```ts
import { Kairos } from "@finic-ai/kairos";

const kairos = new Kairos({ apiKey: process.env.KAIROS_API_KEY!, baseUrl: "http://localhost:8787" });

await kairos.defineAction("withdrawal", {
  subject: "user",
  hold: "Should this withdrawal be held because the account shows signs of fraud or takeover?",
});

kairos.track("login", { userId: "user_42", deviceId: "dev_9", ipCountry: "GB" });

const decision = await kairos.decide({ type: "withdrawal", userId: "user_42", usd: 900 });
// { decision: "approve" | "step_up" | "review" | "block", riskScore, reasons, … }
```

## How it fits together

Nothing in Kairos knows about a particular product. You supply four things:

- **Entities**: the things in your business (`user`, `device`, `payee`, `merchant`). They come into being when an event names them.
- **Events**: anything that happened, of any type, naming the entities involved.
- **Labels**: verdicts on an entity, such as `fraud_confirmed`.
- **Actions**: the decisions to make, each a yes/no question in plain language, optional signals and typologies, and a policy.

At `decide` call, Kairos reads the subject's history, summarises the older events, looks one step out for other subjects that share an entity, adds the totals and the session you asked for, asks the model your questions, and applies your policy. Every decision is stored with exactly what the model was shown.

### Operations

A decision answers one request. Two things act on what comes after it:

- **Workflows**: work that Kairos does after something happens. A workflow has one trigger (an event from your system, a change in Kairos, a schedule, a call to its own URL, a manual start, or a `decide` call for its action) and a list of steps. Kairos runs it in the background and keeps a log of each run. You can use it to act on a decision, to label the payees of a user who gets a chargeback, to decide again 24 hours later, or to make a decision with rules and steps around the model.

- **Queues**: work for people. A queue takes the decisions of the actions you choose, and opens a case when one of its rules matches, such as every `review` decision or a high risk score. Decisions with the same key, such as the user, go into one open case. People assign, work and resolve cases in the console.

## Quick start

You need Node.js 22, pnpm 10 and a Grayson API key from [portal.finic.ai/keys](https://portal.finic.ai/keys). You do not need a database: the server starts its own Postgres.

```bash
pnpm install
cp .env.example .env     # set GRAYSON_API_KEY
pnpm api                 # the API on http://localhost:8787
pnpm console             # the console on http://localhost:5273, in a second terminal
```

Create an account in the console, make a secret key in **Settings › API keys**, put it in `.env` as `KAIROS_API_KEY`, and run `pnpm example`. The [local setup page](docs/development/local-setup.md) has every step.

### The CLI

`kairos` does three things: it starts Kairos, it connects to a Kairos server (local or production), and it does the work of the console from the terminal.

```bash
# 1. Start Kairos: the API and the console together.
pnpm kairos dev

# 2. Connect to a server. Each connection is a profile; the last one you sign in to is the one in use.
pnpm kairos signup                                                     # the local server, a new account
pnpm kairos login --profile prod --url https://kairos.example.com --email you@example.com
pnpm kairos profiles use default                                       # back to the local server

# 3. Do the work.
pnpm kairos keys create "My server"                                    # a secret key for your code
pnpm kairos actions define withdrawal --data @withdrawal.json
pnpm kairos import events transactions.csv --type transaction --ts created_at --entity user=customer
pnpm kairos track login -e user=user_42 -e device=dev_9
pnpm kairos decide withdrawal -e user=user_42 -p usd=900
pnpm kairos workflows run review_payout -i user=user_42 --wait
pnpm kairos cases list "Onboarding review" --status open --assignee me
pnpm kairos --profile prod decisions --outcome block                   # one command against another server
pnpm kairos --help                                                     # every command
```

To have `kairos` on your path, run `pnpm link --global` in `apps/cli`.

To run it for other people: `docker compose up --build`. See [Deployment](docs/deployment/self-hosting.md).

## Documentation

Everything is in [`docs/`](docs/README.md).

|                                                                             |                                                                                  |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [Overview](docs/getting-started/overview.md)                                | What Kairos does, how a decision is made, and what it does not do                |
| [Local setup](docs/development/local-setup.md)                        | Run it locally and get a first decision                                          |
| [Import your history](docs/getting-started/import-history.md)               | Load existing events, customers and outcomes from files                          |
| [Concepts](docs/concepts/core-concepts.md)                                       | Entities, events, records, sessions, labels, links, actions, policies, decisions |
| [TypeScript SDK](docs/reference/clients/typescript.md) · [Python SDK](docs/reference/clients/python.md) | The two clients                                                                  |
| [API reference](docs/reference/api.md)                                      | Every HTTP endpoint                                                              |
| [Workflows](docs/platform/workflows.md)                                    | Triggers, steps, expressions and runs                                            |
| [Inbound webhooks](docs/platform/webhooks/inbound.md)                                | Take the events of a provider such as Stripe                                     |
| [The console](docs/platform/console.md)                                      | The web interface, dashboards and metrics                                        |
| [Queues and cases](docs/case-management/queues.md)                                  | Work for people: rules, cases, assignment and resolution                         |
| [Deployment](docs/deployment/self-hosting.md)                               | Self-hosting: Docker, Postgres, migrations, configuration, security              |
| [Working on Kairos](docs/development/development.md)                        | The repository, the server, the tests and the evaluation suite                   |

## The repository

| Path                  | What it is                                                                 |
| --------------------- | -------------------------------------------------------------------------- |
| `apps/server`         | The HTTP API. Hono on Node.js, Postgres through Drizzle.                   |
| `apps/console`        | The web console. React and Vite.                                           |
| `apps/cli`            | `kairos`, the CLI: starts Kairos, connects to a server, and calls its API. |
| `packages/core`       | The decision path as a library.                                            |
| `packages/sdk`        | `@finic-ai/kairos`, the TypeScript client.                                      |
| `packages/sdk-python` | `kairos-sdk`, the Python client.                                           |
| `packages/eval`       | The evaluation suite and the experiments.                                  |
| `templates/`          | Action definitions and event shapes to copy.                               |
| `examples/`           | Runnable scenarios, end to end.                                            |
| `docs/`               | The documentation.                                                         |

```bash
pnpm test         # all tests; no network
pnpm test:python  # the tests of the Python SDK
pnpm typecheck
pnpm eval         # the evaluation suite against the accepted baseline
```
