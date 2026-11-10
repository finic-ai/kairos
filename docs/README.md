# Kairos documentation

Kairos is a decision engine. You send it what happens in your product, you say in plain language what you want decided, and at the moment of action you ask. It answers with approve, step up, review or block, and with the signals behind the answer.

## Start here

| | Page | What it is for |
|---|---|---|
| 1 | [Overview](getting-started/overview.md) | What Kairos does, how a decision is made, and what it does not do. |
| 2 | [Quickstart](getting-started/quickstart.md) | Make an account and an API key at kairos.finic.ai, and get a first decision. About ten minutes. |
| 3 | [Import your history](getting-started/import-history.md) | Load your existing transactions, customers and chargebacks, so the first decisions have something to read. |
| 4 | [Concepts](concepts/core-concepts.md) | The model: workspaces, entities, events, records, sessions, labels, links, actions, policies, models and decisions. |

## Use Kairos

| Section | Pages |
|---|---|
| **Concepts** | [Core concepts](concepts/core-concepts.md) · [Events](concepts/events.md) · [Entities](concepts/entities/README.md) · [Actions](concepts/actions.md) · [Decisions](concepts/decisions.md) · [Facts](concepts/entities/facts.md) · [Lists](concepts/entities/lists.md) · [How links are reported](concepts/links.md) · [Workspaces](platform/workspaces.md) · [Environments](platform/environments.md) · [Authentication](platform/authentication.md) |
| **SDK** | [TypeScript SDK guide](reference/clients/typescript.md) · [Python SDK guide](reference/clients/python.md) · [Flutter](reference/clients/dart.md) |
| **API** | [API reference](reference/api.md) · [MCP](reference/mcp.md): Cursor, Claude Code and other agents read and act through the Model Context Protocol |
| **Webhooks** | [Inbound webhooks](platform/webhooks/inbound.md): a provider such as Stripe sends its events to Kairos · [Outbound webhooks](platform/webhooks/outbound.md): Kairos tells your system what it decided |
| **Workflows** | [Workflows](platform/workflows.md): work that Kairos does after an event, a change, a schedule or a call, such as a review or a call to your case tool |
| **Models** | [Models](platform/models.md): Grayson, and scoring models such as XGBoost that you train on your own outcomes and use in a workflow |
| **Console** | [The console](platform/console.md) · [Dashboards and metrics](platform/dashboards.md) · [Queues](case-management/queues.md) · [Cases](case-management/cases.md) · [Case layouts](case-management/layouts.md) |
| **Reference** | [Templates](templates/overview.md) · [Event shapes](templates/events/README.md) |

## Run Kairos

| Section | Pages |
|---|---|
| **Deployment** | [Self-hosting](deployment/self-hosting.md): Docker, Postgres, migrations, upgrades, backups and security · [Configuration](deployment/configuration.md) · [Sign-in and access](deployment/sign-in.md) |

## Work on Kairos

| Section | Pages |
|---|---|
| **Development** | [Local setup](development/local-setup.md) · [Working on Kairos](development/development.md): layout, commands, the server · [The evaluation suite](development/evaluation.md) |

## How the folder is arranged

```
docs/
  README.md            this page
  getting-started/     overview, quickstart, importing history
  platform/            authentication, environments, workspaces, webhooks, dashboards, workflows, models, the console
  concepts/            core concepts, events, entities (with facts and lists), actions, decisions, links
  case-management/     queues, cases, layouts
  templates/           the templates overview, and one page for each event template (generated)
  reference/           the HTTP API, MCP, and the clients: TypeScript, Python, CLI
  deployment/          self-hosting, configuration, sign-in and access
  development/         for people who change Kairos (not published)
  images/              screenshots
```

The console build publishes these pages at `/docs`. [`apps/console/docs/pages.ts`](../apps/console/docs/pages.ts) lists the published pages in the order of the sidebar; a page that is not in it, such as those in `development/`, is not published. Links to files outside `docs/` show as plain text there.

## The shortest possible example

```ts
import { Kairos } from "@finic-ai/kairos";

const kairos = new Kairos({ apiKey: process.env.KAIROS_API_KEY!, baseUrl: "http://localhost:8787" });

// 1. Say what you want decided. Once, at startup.
await kairos.defineAction("withdrawal", {
  subject: "user",
  hold: "Should this withdrawal be held because the account shows signs of fraud or takeover?",
});

// 2. Record what happens, as it happens.
kairos.track("login", { userId: "user_42", deviceId: "dev_9", ipCountry: "GB" });

// 3. Ask, at the moment of action.
const decision = await kairos.decide({ type: "withdrawal", userId: "user_42", usd: 900 });
if (decision.decision === "block") throw new Error("Withdrawal held");
```
