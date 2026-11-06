<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/readme/kairos-logo-dark.svg">
  <img src="docs/images/readme/kairos-logo.svg" alt="Kairos" width="270">
</picture>

<br/><br/>

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/@finic-ai/kairos?label=npm%20%40finic-ai%2Fkairos)](https://www.npmjs.com/package/@finic-ai/kairos)
[![PyPI](https://img.shields.io/pypi/v/finic-kairos?label=pypi%20finic-kairos)](https://pypi.org/project/finic-kairos/)
[![Discord](https://img.shields.io/badge/Discord-join%20us-5865F2?logo=discord&logoColor=white)](https://discord.gg/4zRwRCK6Mx)
[![Kairos Cloud](https://img.shields.io/badge/cloud-kairos.finic.ai-0f8a8a)](https://kairos.finic.ai)
[![Hacker News](https://hackergit.org/badge/finic-ai/kairos.svg)](https://news.ycombinator.com/item?id=50358314)

[**Kairos Cloud**](https://kairos.finic.ai) · [**Docs**](https://kairos.finic.ai/docs) · [**Discord**](https://discord.gg/4zRwRCK6Mx) · [**Finic**](https://finic.ai)

<img src="docs/images/readme/kairos-experiments.gif" alt="An agent's experiment in Kairos: the workflow with its data flow, the experiments on it, and the variant that won" width="100%"/>

</div>

## Kairos is open-source, real-time fraud and risk decisioning

[Kairos](https://kairos.finic.ai) decides every sign-up, login, order, payment and payout as it happens, and keeps each decision with the signals behind it. It is an open-source alternative to Sardine, Sift, Riskified and SEON, with two things they don't have: **your coding agent tunes it**, and **decision models** catch fraud before you have the labels to train on.

#### Decisioning

- [Real-time decisions](docs/concepts/decisions.md): one call returns approve, step up, review or block, with a risk score and the reasons, from the subject's history, the devices, cards and addresses it shares with others, and the session.
- [Workflows](docs/platform/workflows.md): ask a decision model, score with a model, branch, call webhooks, open cases, and decide again later.
- [Queues and cases](docs/case-management/queues.md): review work for people, whose resolutions become labels.

#### Agent-first

- [MCP server](docs/reference/mcp.md): Claude Code, Cursor or Codex read your decisions and build workflows, with every action recorded under its key.
- [Experiments](docs/platform/models.md): your agent proposes model variants, Kairos trains and tests them on your data, and the agent ships the winner.

#### Decision models and traditional ML

- [Grayson](https://finic.ai): Finic's decision model answers questions about each request in plain language. It works with few labels and reads unstructured data.
- [Models](docs/platform/models.md): logistic regression and gradient-boosted trees (XGBoost-compatible) on your numbers and Grayson's answers, trained in Kairos or uploaded.

#### For developers

- [SDKs](docs/reference/clients/typescript.md) for TypeScript (`@finic-ai/kairos`) and Python (`finic-kairos`), a [CLI](docs/reference/clients/cli.md), an [HTTP API](docs/reference/api.md), and [self-hosting](docs/deployment/self-hosting.md) with Docker.

## An AI fraud ML engineer, always tuning on your data

You send Kairos what happens in your product: sign-ups, logins, orders, payouts, chargebacks. It decides each request (approve, step up, review or block) and keeps every decision with the signals behind it.

What makes Kairos different is who tunes it. Connect Claude Code, Cursor, Codex or any agent over **MCP**, and the agent can do the work of a fraud ML engineer:

1. **Build the workflow.** It defines what to decide, which questions to ask a decision model, and which fields to score.
2. **Design experiments.** It proposes variants: a decision model alone, logistic regression on your numbers, gradient-boosted trees, a stack of them, or the decision model's answers combined with your numbers in one model.
3. **Let Kairos run them.** The server trains each variant on your oldest labeled data, chooses on the next, and tests on the newest, then reports ROC-AUC, PR-AUC, the gain over a baseline with its 95% interval, and precision and recall at your thresholds.
4. **Pick the winner and ship it.** The agent explains its choice, applies the variant as the workflow's next version, and comes back when new labels arrive.

```text
You:     "Our chargebacks went up. Find a better model for shopify_order and publish it if it wins."
Agent:   designs six variants → create_workflow_experiment → reads the results →
         "Logistic regression on the order's numbers plus Grayson's answers wins: ROC-AUC 0.949 on validation,
          0.930 on test. Publishing it as v6."
```

## Decision models and traditional ML, together

Kairos is built around [**Grayson**](https://finic.ai), Finic's decision model. You ask it questions in plain language ("Does the shipping address look like a reshipper?", "Is this email throwaway?") and it answers with calibrated probabilities. Decision models are strong where traditional ML is weak:

- **Few labels.** Grayson works on day one, before you have the thousands of chargebacks a model needs to learn from.
- **Unstructured data.** It reads descriptions, emails, names, addresses, notes and item titles, which a gradient-boosted tree can't.
- **Explanations.** Every answer is a question you wrote, so every decision says why.

Traditional models are strong where decision models are weak: they learn your own outcomes precisely, from your own numbers, and they cost nothing per decision. Kairos lets you combine both: Grayson's answers become features next to your fields in a **logistic regression** or **gradient-boosted trees** (XGBoost-compatible, trained in Kairos itself), and experiments tell you which combination wins on your data.

<img src="docs/images/readme/kairos-decision.jpg" alt="A decision in Kairos: the risk score, the outcome, and the signals Grayson found, each with its probability" width="100%"/>

## Get started

### Kairos Cloud

Sign up at [**kairos.finic.ai**](https://kairos.finic.ai). Create a sandbox environment, a secret key, and you're ready to send events.

### Connect your agent

In the console, open **Settings › MCP**, turn on the tool groups your agent needs, and create a key. Then, in Claude Code:

```bash
claude mcp add --transport http kairos https://kairos.finic.ai/mcp --header "Authorization: Bearer ksk_…"
```

Cursor, Codex and VS Code work the same way: see [MCP for agents](https://kairos.finic.ai/docs/reference/mcp). Then ask your agent to look at your decisions, build a workflow, or run an experiment.

### Send events and decide

```bash
npm install @finic-ai/kairos      # or: pip install finic-kairos
```

```ts
import { Kairos } from "@finic-ai/kairos";

const kairos = new Kairos({ apiKey: process.env.KAIROS_API_KEY!, baseUrl: "https://kairos.finic.ai" });

await kairos.defineAction("withdrawal", {
  subject: "user",
  hold: "Should this withdrawal be held because the account shows signs of fraud or takeover?",
});

kairos.track("login", { userId: "user_42", deviceId: "dev_9", ipCountry: "GB" });

const decision = await kairos.decide({ type: "withdrawal", userId: "user_42", usd: 900 });
// { decision: "approve" | "step_up" | "review" | "block", riskScore, reasons, … }
```

### Self-host

You need Node.js 22, pnpm 10 and a Grayson API key from [portal.finic.ai](https://portal.finic.ai/keys). No database to set up: the server starts its own Postgres.

```bash
pnpm install
cp .env.example .env     # set GRAYSON_API_KEY
pnpm kairos dev          # the API on http://localhost:8787 and the console on http://localhost:5273
```

For your team, `docker compose up --build`. See [Self-hosting](docs/deployment/self-hosting.md) and [Local setup](docs/development/local-setup.md).

<details>
<summary><b>The CLI</b></summary>

```bash
pnpm kairos signup                                                     # the local server, a new account
pnpm kairos login --profile prod --url https://kairos.finic.ai --email you@example.com
pnpm kairos keys create "My server"                                    # a secret key for your code
pnpm kairos actions define withdrawal --data @withdrawal.json
pnpm kairos import events transactions.csv --type transaction --ts created_at --entity user=customer
pnpm kairos decide withdrawal -e user=user_42 -p usd=900
pnpm kairos workflows run review_payout -i user=user_42 --wait
pnpm kairos --help                                                     # every command
```

To have `kairos` on your path, run `pnpm link --global` in `apps/cli`.

</details>

## Integrations

- **Shopify:** decide every order, hold risky ones for review, and learn from chargebacks. To get the Kairos app for your store, reach the Finic team on [Discord](https://discord.gg/4zRwRCK6Mx) or at [support@finic.ai](mailto:support@finic.ai).
- **Inbound webhooks:** take events from providers such as Stripe. See [Inbound webhooks](docs/platform/webhooks/inbound.md).

## Documentation

The docs are at [kairos.finic.ai/docs](https://kairos.finic.ai/docs), and in [`docs/`](docs/README.md).

|                                                                                                         |                                                                  |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| [Overview](docs/getting-started/overview.md)                                                            | What Kairos does, how a decision is made, and what it does not do |
| [Quickstart](docs/getting-started/quickstart.md)                                                        | A first decision in a few minutes                                |
| [MCP for agents](docs/reference/mcp.md)                                                                 | Connect Claude Code, Cursor, Codex or VS Code                    |
| [Models and experiments](docs/platform/models.md)                                                       | Scoring models, and experiments that compare them               |
| [Workflows](docs/platform/workflows.md)                                                                 | Triggers, steps, expressions and runs                            |
| [Concepts](docs/concepts/core-concepts.md)                                                              | Entities, events, labels, links, actions, policies, decisions    |
| [Import your history](docs/getting-started/import-history.md)                                           | Load existing events, customers and outcomes from files          |
| [TypeScript SDK](docs/reference/clients/typescript.md) · [Python SDK](docs/reference/clients/python.md) | The two clients                                                  |
| [API reference](docs/reference/api.md)                                                                  | Every HTTP endpoint                                              |
| [Queues and cases](docs/case-management/queues.md)                                                      | Review work for people                                           |
| [Self-hosting](docs/deployment/self-hosting.md)                                                         | Docker, Postgres, migrations, configuration, security            |
| [Working on Kairos](docs/development/development.md)                                                    | The repository, the server, the tests and the evaluation suite  |

## The repository

| Path                  | What it is                                                                 |
| --------------------- | -------------------------------------------------------------------------- |
| `apps/server`         | The HTTP API and MCP server. Hono on Node.js, Postgres through Drizzle.    |
| `apps/console`        | The web console. React and Vite.                                           |
| `apps/cli`            | `kairos`, the CLI: starts Kairos, connects to a server, and calls its API. |
| `packages/core`       | The decision path, the model scorers and the tree trainer.                 |
| `packages/sdk`        | `@finic-ai/kairos`, the TypeScript client.                                 |
| `packages/sdk-python` | `finic-kairos`, the Python client.                                         |
| `packages/eval`       | The evaluation suite and the experiments.                                  |
| `templates/`          | Action definitions and event shapes to copy.                               |
| `examples/`           | Runnable scenarios, end to end.                                            |
| `docs/`               | The documentation.                                                         |

```bash
pnpm test         # all tests; no network
pnpm test:python  # the tests of the Python SDK
pnpm typecheck
```

## Community

- **Discord:** questions, ideas and show-and-tell, at [discord.gg/4zRwRCK6Mx](https://discord.gg/4zRwRCK6Mx)
- **Email:** [support@finic.ai](mailto:support@finic.ai)
- **Contributing:** issues and pull requests are welcome. Read [Working on Kairos](docs/development/development.md) first.

## License

Kairos is licensed under the [Apache License 2.0](LICENSE).
