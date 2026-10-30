# Local setup

For people who work on Kairos: from a clone of the repository to a first decision on your own machine. Customers start at the [Quickstart](../getting-started/quickstart.md); a server for other people is in [Self-hosting](../deployment/self-hosting.md).

## Requirements

- Node.js 22 or later
- pnpm 10 (`npm install -g pnpm`)
- A Grayson API key from [portal.finic.ai/keys](https://portal.finic.ai/keys)

You do not need a database. With no `DATABASE_URL`, the server starts its own Postgres and keeps the files in `apps/server/.data/postgres2`.

## 1. Install

```bash
git clone <the repository> kairos
cd kairos
pnpm install
```

## 2. Configure

```bash
cp .env.example .env
```

Open `.env` and set the one value that is necessary:

```bash
GRAYSON_API_KEY=your_key
```

`.env` is ignored by git. The server, the examples and the evaluation scripts read it when you start them through `pnpm`. A value set in the shell wins over the file.

## 3. Start the server and the console

In one terminal:

```bash
pnpm api
```

```
Kairos API on http://localhost:8787 · embedded Postgres in …/apps/server/.data/postgres2
```

The first start takes a few seconds: it creates the database and applies the migrations.

In a second terminal:

```bash
pnpm console
```

Open [http://localhost:5273](http://localhost:5273).

## 4. Create an account and an API key

1. In the console, choose **Create account**. The first account on a server becomes the owner of its first workspace.
2. Go to **Settings › API keys** and choose **Create key**. Pick **Secret**.
3. Copy the key. It starts with `ksk_`, and it is shown once.
4. Put it in `.env`:

```bash
KAIROS_API_KEY=ksk_…
```

The console also has a **Get started** page that walks through these steps and gives you a prompt for a coding agent.

## 5. Get a first decision

The quickest way is an example. It defines an action, sends two years of history for one customer and a fraud ring for another, and asks for two decisions:

```bash
pnpm example
```

```
established customer, usual rent  (203 ms)
{ "decision": "approve", "riskScore": 1, … }

two-day-old account, new beneficiary  (203 ms)
{ "decision": "block", "riskScore": 98, "reasons": ["new_account", "new_beneficiary", "high_velocity", "device_linked_to_risky_accounts"], "typology": "mule", … }
```

Open the console again. **Decisions** shows both, and each one opens to what the model was shown.

To do the same from your own code, install the SDK in your project and follow the [SDK guide](../reference/clients/typescript.md):

```ts
import { Kairos } from "@finic-ai/kairos";

const kairos = new Kairos({ apiKey: process.env.KAIROS_API_KEY!, baseUrl: "http://localhost:8787" });
```

In Python, `pip install ./packages/sdk-python` and follow the [Python SDK guide](../reference/clients/python.md):

```python
import os

from kairos import Kairos

kairos = Kairos(os.environ["KAIROS_API_KEY"], base_url="http://localhost:8787")
```

Or call the API with nothing installed:

```bash
curl -X PUT http://localhost:8787/v1/actions/withdrawal \
  -H "Authorization: Bearer $KAIROS_API_KEY" -H "Content-Type: application/json" \
  -d '{ "subject": "user", "hold": "Should this withdrawal be held because the account shows signs of fraud or takeover?" }'

curl -X POST http://localhost:8787/v1/decide \
  -H "Authorization: Bearer $KAIROS_API_KEY" -H "Content-Type: application/json" \
  -d '{ "action": "withdrawal", "entities": { "user": "user_42" }, "properties": { "usd": 900 } }'
```

## More examples

Each one writes to the workspace of `KAIROS_API_KEY`.

| Command | What it shows |
|---|---|
| `pnpm example` | Bank transfers: an established customer and a ring on one device |
| `pnpm example:merchants` | Merchant onboarding with IP, device, bank account and owner links |
| `pnpm example:claims` | A bank's fraud claims and red flags |
| `pnpm example:loans` | Loan applications: synthetic identities, stolen identities and loan stacking |
| `pnpm example:insurance` | Motor insurance claims: a staged-accident ring, inflated claims and cover bought after the loss |
| `pnpm example:medical` | Health claims from providers: phantom billing, upcoding, a kickback ring and an excluded provider that returns |
| `pnpm example:scams` | Authorised push payment scams with the visit of each payment: pig butchering, romance, impersonation, purchase and invoice redirection |
| `pnpm example:ticketing` | Event tickets: returning fans, shared devices, fast checkout, automated hoarding, purchase-limit evasion and takeover |
| `pnpm example:ecommerce` | Checkout: returning customers, gifts, households, card testing, linked payment fraud and takeover |
| `pnpm example:atm` | Money mules and honest customers at the same ATM |
| `pnpm example:overspend` | Totals: spending against the money that came in |
| `pnpm example:session` | One customer, two visits: a usual one and a takeover in four minutes |
| `pnpm example:sessions` | Six visits with several decisions in each |

## Commands

```bash
pnpm api             # the API on http://localhost:8787
pnpm console         # the console on http://localhost:5273
pnpm test            # all tests; the server tests start a throwaway Postgres
pnpm typecheck
pnpm db:migrate      # apply the migrations (the embedded Postgres does this itself at start)
pnpm eval            # the evaluation suite against the accepted baseline; cached, no model calls
pnpm --filter @kairos/server smoke   # call every endpoint of a running server, end to end
```

## Troubleshooting

| What you see | What to do |
|---|---|
| `GRAYSON_API_KEY is not set` | Set it in `.env`, or in the shell. |
| `The embedded Postgres could not start on port 54329` | Another program has the port. Set `KAIROS_PG_PORT` to a free one. |
| `KAIROS_API_KEY is not set` from an example | Make a secret key in the console and put it in `.env`. |
| `401 Unknown or revoked API key` | The key is from another server or was revoked. Make a new one. |
| `502 model_unavailable` from `decide` | The model could not be reached. Check `GRAYSON_API_KEY` and the network. |
| You want to start again from nothing | Stop the server and delete `apps/server/.data`. This deletes all local data. |

Next: [Import your history](../getting-started/import-history.md), then [Concepts](../concepts/core-concepts.md).
