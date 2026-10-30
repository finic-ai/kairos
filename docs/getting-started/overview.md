# Overview

## What Kairos is

Kairos makes decisions about actions in your product: should this withdrawal go through, should this sign-up be reviewed, should this merchant be paid out. It is built for fraud and risk, but nothing in it is specific to one kind of decision.

It has three jobs:

1. **Record.** You send events: anything that happens, with the entities it involves. Kairos keeps a timeline for every user, device, account, payee or whatever your entities are.
2. **Decide.** You define an *action* in plain language: a yes/no question, optional signals to look for, and a policy. When you ask, Kairos reads the history of the subject, builds a compact summary, asks the model your question, and applies your policy.
3. **Show.** The console shows every decision with what the model was shown and what it answered, every entity with its history, every session, and dashboards that you build yourself.

There are no static rules to write and no features to engineer. You describe the decision in words. The policy on top is yours, and it is exact.

## How a decision is made

When you call `decide`, Kairos does this, typically in a few hundred milliseconds:

1. **Reads the subject's history**: its most recent 2,000 events, its properties and its labels.
2. **Folds records.** A transaction that was pending and then completed is one transaction, not two.
3. **Builds the context**: the most recent 30 events in full, and a statistical summary of everything older. A compressed context was more accurate, about 12 times faster and about 6% of the tokens of a raw 700-event history in testing.
4. **Looks one step out.** For each other entity in the request (the device, the payee), it counts the other subjects that share it, how many of them are new, and how many carry a label such as `fraud_confirmed`, against the normal rate. This is what catches rings.
5. **Adds what you asked for**: totals over the subject's events (money in during the last seven days against a usual week), and the session of the request (what happened in this visit, and how fast).
6. **Asks the model** your hold question, and each of your signals and typologies. The model is [Grayson](https://finic.ai), called through the Finic API.
7. **Applies your policy**: thresholds on the hold probability, and rules on signals and totals.
8. **Stores the decision** with the exact context and the model's raw answer, so that you can see why.

The answer:

```json
{
  "decision": "block",
  "probability": 0.977,
  "risk_score": 98,
  "reasons": ["new_account", "new_beneficiary", "high_velocity"],
  "typology": "mule",
  "rules": [],
  "action": "bank_transfer@2",
  "decision_id": "kdec_8cd38292942f4c4084d42bc960404c8f"
}
```

## What you need

- **An account** at [kairos.finic.ai](https://kairos.finic.ai). The console is there, and so is the API.
- **A secret API key** for your server, from **Settings › API keys**.
- **Your app**, sending events with the [TypeScript SDK](../reference/clients/typescript.md), the [Python SDK](../reference/clients/python.md) or any HTTP client.

## What Kairos does not do

Be clear about these before you rely on it.

- **It is not an accounting system.** Totals are read at one moment, with no lock. A rule on a total is exact arithmetic on what was stored, but it is not a balance check.
- **The model is not perfectly repeatable.** The same request sent twice can give a slightly different probability: in a test of 100 requests, 25 changed, by at most 0.06. A decision close to a threshold can fall on either side.
- **Thresholds are placeholders.** The default policy blocks at 0.9 and reviews at 0.5. Tune them on your own outcomes.
- **Links are one hop.** Kairos sees who shares a device with the subject, not who shares a device with those people.
- **A decision reads the most recent 2,000 events** of the subject. Older history reaches it only through totals.
- **No step-up flow and no email.** Kairos returns `step_up` or `review`; what happens next is yours, or a case in a [queue](../case-management/queues.md). Invite links are passed on by hand, and there is no password reset and no email verification.
- **No threshold tuning and no shadow mode.** The decision log stores what tuning will need; the tuning is yours to do.
- **No rate limit on sign-in**, and the IP ranges of an API key are IPv4 only (a single IPv6 address works).
- **Session replay is a replay of events**, not a recording of a screen.

Next: [Quickstart](quickstart.md).
