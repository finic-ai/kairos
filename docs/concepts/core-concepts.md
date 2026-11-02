# Concepts

Kairos has a small model. Ten ideas cover all of it. Everything lives in a workspace and an environment, and nothing is read across either boundary: see [Workspaces](../platform/workspaces.md) and [Environments](../platform/environments.md).

| Idea | In one line |
|---|---|
| [Entity](#entity) | A thing you track: a user, a device, a payee. See [Entities](entities/README.md). |
| [Event](#event) | Something that happened, naming the entities it involved. See [Events](events.md). |
| [Record](#record) | Events that are stages of one thing, such as a transaction. |
| [Session](#session) | Events that are one visit of a person. |
| [Label](#label) | A verdict or an outcome on an entity: `fraud_confirmed`. |
| [Link](#link) | Two subjects that share an entity. Kairos finds these itself. |
| [Action](#action) | A decision you want made, defined in plain language. See [Actions](actions.md). |
| [Policy](#policy) | How the model's answers become approve, step up, review or block. |
| [Model](#model) | What answers: Grayson, or a scoring model trained on your own outcomes. |
| [Decision](#decision) | One answer, stored with everything that led to it. See [Decisions](decisions.md). |

## Entity

An entity is anything you want a history for. It has a **type** and an **id**: `user/user_42`, `device/dev_9`, `payee/payee_new`. You choose the types.

An entity exists as soon as an event names it. You do not create entities first.

An entity has **properties**: what is known about it, such as `kyc_country` or `plan`. Set them in one of three ways:

- from an event, with `$set` and `$set_once` (the usual way: the fact arrives with what happened);
- directly, with `kairos.entity(type, id, properties)`;
- in bulk, with `PUT /v1/objects`, for customers you already have.

`$set` replaces a value unless a later event already set it, so events can arrive in any order and the newest fact wins. `$set_once` fills a property only when it has no value.

An **entity type** can have a definition: a description, the meaning of its properties, and whether it is a link (see [Link](#link)). The definition is optional.

One entity type is special in each decision: the **subject**. It is the entity the decision is about, and its history is what the model reads.

More: [Entities](entities/README.md).

## Event

An event is something that happened:

```json
{
  "id": "evt_01",
  "type": "bank_transfer",
  "ts": "2026-10-06T13:58:00Z",
  "entities": { "user": "user_42", "device": "dev_9", "payee": "payee_new" },
  "properties": { "amount": 2400, "currency": "GBP" }
}
```

- **`type`** is yours. Kairos has no list of event types.
- **`entities`** says who and what was involved. An event belongs to the timeline of every entity it names. It needs at least one.
- **`properties`** are yours too. Kairos profiles whatever fields an event type has.
- **`id`** is an idempotency key. The same id sent twice is stored once.
- **`ts`** is when it happened, which need not be now. History can be imported.

In the SDK, a property that ends in `Id` or `_id` names an entity: `userId` is the entity `user`.

Send events as they happen, from your server. The more of the ordinary life of a subject Kairos has, the better it can tell what is not ordinary.

More: [Events](events.md), with records and sessions.

## Record

Some things change state: a transaction is pending, then completed, then disputed. Send each stage as an event with the same **`universal_id`** and a **`status`**. Kairos stores every stage, and a decision sees one record in its latest state, with its status history. A total counts it once.

An action can start on chosen statuses only: decide on a transaction when it is `pending`, not again when it is `completed`.

## Session

A session is one visit of a person, from the sign-in to the last thing they did. Send the id of your own login session with each event and each decision, as **`$session`** (`session` in the API).

A decision with a session sees which of the recent events are the current visit, how long ago it started, and its steps in order with the time after the start. A takeover is often one short visit, and this is where it shows: on the evaluation cases the session block raised the catch rate from 93.3% to 98.3% and lowered the false-action rate from 27.5% to 17.5%.

- A session is **not an entity**. A property named `sessionId` is still an entity of your own.
- A visit **ends after 30 minutes** with no event.
- **Set it on your server.** A request with no session is decided as before; nothing says it is safer.
- If another subject's events carry the same session id, the decision is told. That can be a stolen session.

The console lists sessions and can play one back, step by step.

## Label

A label is a verdict or an outcome on an entity: `fraud_confirmed`, `chargeback`, `verified_by_agent`. You add labels when you learn the truth, often days after the decision.

Labels do two things. A decision about a labelled subject sees the label. And a decision about anyone *linked* to a labelled entity sees how many of the linked subjects carry it, against the normal rate. This is how one confirmed fraud makes the rest of a ring visible.

Put the label on the thing the outcome is about: the user who committed the fraud, not the device.

## Link

Two subjects are linked when they share an entity: the same device, the same payee, the same bank account. You do not declare links. Kairos reads them from the entities that events name.

For each other entity in a request or in the subject's recent events, at most eight, a decision is told:

- how many other subjects used it, in all and in the last 30 days;
- how many of those are themselves new;
- how many used it at about the same time;
- how many carry each label, as a share, **against the normal share** among all subjects.

The comparison matters. A supermarket's terminal is shared by thousands of honest people; an ATM used by six accounts that are all three days old is not the same thing. A link is a signal when it is concentrated, not when it merely exists.

Some entity types should never link: a popular merchant, a country. Set `link: false` on the entity type, or list the types that do link in an action's `context.linkTypes`.

Links are one hop. For an entity shared by more than 500 subjects, the count is "more than 500" and its all-time labels are left out; the last 30 days are still reported.

## Action

An action is a decision you want made. It is a definition in plain language:

```json
{
  "displayName": "Bank Transfer",
  "subject": "user",
  "hold": "Should this transfer be held because the account shows signs of fraud, takeover or being used to pass on other people's money?",
  "reasons": {
    "new_device": "The request comes from a device the user has not used before",
    "new_payee": "The money goes to a payee added shortly before the request"
  },
  "typologies": {
    "legit": "An ordinary payment by the owner of the account",
    "account_takeover": "Someone who is not the owner is using the account",
    "mule": "The account receives money from other people and passes it on"
  },
  "trigger": "bank_transfer_requested"
}
```

- **`subject`**: the entity type the decision is about.
- **`hold`**: one yes/no question. Yes must mean "hold this action". The model's probability of yes is the risk.
- **`reasons`**: signals to report. Each is judged on its own, and the ones the model finds present come back with the decision.
- **`typologies`**: explanations that exclude each other. The most likely one comes back. Include one for "nothing wrong".
- **`trigger`**: an event type that starts the action. Then one call stores the event and decides.
- **`automatic`**: with a trigger, Kairos also decides each matching event that your server tracks or an inbound webhook brings, in the background, and sends the decision to your webhooks. Events from a public key, events more than an hour old, and events from before it was turned on are never decided.
- **`policy`** and **`context`**: see below.

More: [Actions](actions.md).

An action has a **key** (`bank_transfer`, used in code) and a display name (shown to people). A change to any wording is a new **version**, because it can change the answers. Each decision records the version that made it. A change to the display name alone is not a new version.

### Totals

A model reads one number well and adds up fifty badly. So an action can ask the server to calculate **totals** over the subject's events and to make the comparison:

```json
"context": {
  "totals": [
    { "name": "money_in", "event": "deposit", "sum": "usd", "window": "7d", "usual": "90d", "covers": "usd" }
  ]
}
```

The model then reads "money in during the last 7 days: 9,000 from 2 events, 34.2 times a usual week, and it covers all of this withdrawal". A total has a period (`"30m"`, `"24h"`, `"7d"`, `"session"`, or all history), optional conditions, an optional comparison with what is usual, and an optional comparison with the amount of the request.

Totals read their own events over the whole period, not only the recent ones, so they are also how old history reaches a decision.

## Policy

The model answers with probabilities. The policy turns them into an outcome. It is yours, and it is exact.

```json
"policy": {
  "block": 0.9,
  "review": 0.5,
  "rules": [
    { "id": "new_device_and_payee", "allOf": ["new_device", "new_payee"], "outcome": "step_up" },
    { "id": "drained", "when": [{ "total": "money_out", "op": ">=", "value": 5000 }], "outcome": "review" }
  ]
}
```

1. The hold probability is compared with the thresholds: at or above `block` is **block**, at or above `review` is **review**, otherwise **approve**.
2. Each rule that holds is applied. `allOf` needs every listed signal to be present. `when` compares a total with a number. A rule can only make the outcome **more severe**, never less.

The four outcomes, in order of severity: `approve`, `step_up`, `review`, `block`. `step_up` comes only from a rule.

The default thresholds, 0.9 and 0.5, are placeholders. Tune them on your own outcomes: in testing, hard cases scored well below 0.5 while still ranking above normal ones.

## Model

A model is what answers. There are two kinds:

- A **question model** reads a case and answers questions in plain language with probabilities. `grayson-1` is built in, and each action asks it. It needs no labels of yours.
- A **scoring model** reads numbers and gives one probability. You train it on your own outcomes, for example as an XGBoost model whose features include Grayson's answers, and upload it. A workflow's [Score with a model](../platform/workflows.md#score-with-a-model) step uses it.

A model has a slug, such as `loan-default`, and versions that never change: `loan-default@2`. See [Models](../platform/models.md).

## Decision

A decision is one answer:

| Field | |
|---|---|
| `decision` | `approve`, `step_up`, `review` or `block` |
| `probability` | The probability that the action should be held, 0 to 1 |
| `risk_score` | The probability times 100, rounded |
| `reasons` | The signals judged present |
| `typology` | The most likely explanation, when the action has typologies |
| `rules` | The policy rules that fired |
| `action` | The action and version: `bank_transfer@2` |
| `decision_id` | The id of the stored decision |

Every decision is stored with the **context** (exactly what the model was shown) and the **raw answer** of the model. A decision that a workflow scored with a scoring model also keeps each score and the values it read. The console shows all of them. When a decision surprises you, this is where you look.

`reasons` are the signals the model judged present. They are not a causal explanation of the score.

A decision can be made **as of a past moment**: it then sees only the events up to that moment. This is how you backtest a change to an action against history.

More: [Decisions](decisions.md).

## API Keys

| Kind | Starts with | Can do | Where it lives |
|---|---|---|---|
| Secret | `ksk_` | Everything in its environment | Your server only |
| Public | `kpk_` | Send events, and nothing else. It cannot set entity properties or read anything. | A browser or an app |

A key can be limited to IP addresses, and a public key to websites. A key is shown once, when it is made; Kairos stores only its hash. See [Authentication](../platform/authentication.md).

Next: [How links are reported](links.md), then the [SDK guide](../reference/clients/typescript.md) or the [API reference](../reference/api.md).
