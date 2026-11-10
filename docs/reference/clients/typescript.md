# Using the Kairos SDK

Each API key belongs to one workspace and environment. Use the appropriate key for Production or a sandbox; the SDK needs no additional scope parameters. Separate clients with different keys can target different environments.

This guide takes you from nothing to a working decision: record what happens in your product, say what you want decided, and ask at the moment of action.

It covers the TypeScript SDK, `@finic-ai/kairos`. For the HTTP API underneath it, see the [API reference](../api.md). For the ideas behind it, see [Concepts](../../concepts/core-concepts.md). For action definitions and event shapes you can copy, see [Templates](../../templates/overview.md).

- [Before you start](#before-you-start)
- [The five ideas](#the-five-ideas)
- [Quickstart](#quickstart)
- [Track events](#track-events)
- [Entities](#entities)
- [Define an entity](#define-an-entity)
- [Records that change](#records-that-change)
- [Sessions](#sessions)
- [In a web framework](#in-a-web-framework)
- [Define an action](#define-an-action)
- [Ask for a decision](#ask-for-a-decision)
- [Decide from an event](#decide-from-an-event)
- [Labels](#labels)
- [Delivery, failure and shutdown](#delivery-failure-and-shutdown)
- [Backtesting](#backtesting)
- [Getting good decisions](#getting-good-decisions)
- [Reference](#reference)



## Before you start

**Keep the secret key on your server.** A secret key can request decisions for any user. Do not ship it in a browser or a mobile app. For client code, use a public key (see Keys below).

**Runtime.** Node 18 or later, or any runtime with a global `fetch`.

**Install.**

```bash
npm install @finic-ai/kairos
```

**A key.** In the console at [kairos.finic.ai](https://kairos.finic.ai), create a **secret key** in **Settings › API keys**. The key is shown one time.

```ts
import { Kairos } from "@finic-ai/kairos";

const kairos = new Kairos({
  apiKey: process.env.KAIROS_API_KEY!, // the secret key, "ksk_…"
});
```

Create one client for the process and reuse it. It holds the event queue.

**Keys.** There are two types, both made in the console.


| Key             | Use it                         | Can                                                                     |
| --------------- | ------------------------------ | ----------------------------------------------------------------------- |
| Secret, `ksk_…` | On your server, with this SDK. | Everything.                                                             |
| Public, `kpk_…` | In a browser or a mobile app.  | Send events only (`track`). `decide`, `label` and all reads return 403. |


With a public key, the SDK is safe to use in client code to send events:

```ts
const kairos = new Kairos({ apiKey: "kpk_…" });
kairos.track("page_viewed", { userId: "user_42", path: "/pricing" });
```

Events from a public key can be written by anyone who reads the key from your page. Use them as behaviour context. Send the events that a decision depends on (a transfer request, a password reset) from your server with the secret key.

A public key can be limited to the websites it is used on (for example `https://www.example.com` or `https://*.example.com`). A request from a different website fails with 403 `origin_not_allowed`.

A key can also be limited to a list of IP addresses. A request from a different address fails with 403 `ip_not_allowed`.

## The five ideas


| Idea            | What it is                                                      | Example                                                   |
| --------------- | --------------------------------------------------------------- | --------------------------------------------------------- |
| **Event**       | Something that happened. Any type, any properties.              | `login`, `card_payment`, `application_submitted`          |
| **Entity**      | A thing in your business, as a type and an id, with properties. | `user user_123`, `device dev_9`, `ip 203.0.113.7`         |
| **Entity type** | What a kind of entity means. Optional.                          | "A merchant is a business that takes payments through us" |
| **Label**       | An outcome or a verdict on one entity.                          | `fraud_confirmed` on a user                               |
| **Action**      | A decision you want made, defined in plain language.            | `bank_transfer`, `merchant_onboarding`                    |


Nothing in Kairos is specific to a product. You choose the event types, the entity types and the actions.

At decision time Kairos reads the subject's event history, summarises the older part, looks for other subjects that share an entity with it, asks the model the questions your action defines, and applies your action's policy.

## Quickstart

```ts
import { Kairos } from "@finic-ai/kairos";

const kairos = new Kairos({ apiKey: process.env.KAIROS_API_KEY! });

// 1. Once, at startup: say what you want decided.
await kairos.defineAction("bank_transfer", {
  subject: "user",
  hold: "Should the pending bank transfer be held for manual review because the account shows signs of fraud or of account takeover?",
  reasons: {
    new_device: "The current session uses a device that the account did not use before",
    new_beneficiary: "The transfer goes to a beneficiary that was added recently",
  },
});

// 2. Everywhere: record what happens.
kairos.track("login", { userId: "user_123", deviceId: "dev_9", ipCountry: "GB" });
kairos.track("beneficiary_added", { userId: "user_123", beneficiaryId: "ben_77" });

// 3. At the moment of action: ask.
const decision = await kairos.decide(
  { type: "bank_transfer", userId: "user_123", beneficiaryId: "ben_77", deviceId: "dev_9", amount: 9500, currency: "USD" },
  { fallback: "review" },
);

if (decision.decision === "approve") {
  // release the transfer
} else {
  // hold it: decision.riskScore, decision.reasons
}

// 4. Before the process exits.
await kairos.shutdown();
```


## Track events

```ts
kairos.track(type, properties);
```

`track` returns at once. Events are queued in memory and sent in batches in the background, so it is safe to call on a request path.

```ts
kairos.track("card_payment", {
  userId: "user_123",          // an entity: see below
  merchantId: "greenleaf_grocery",
  usd: 84.2,                   // any property, stored as given
  channel: "card_present",
  city: "Austin",
});
```

These property names are special:


| Property                | Meaning                                                                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `timestamp`             | When the event happened, as a `Date` or an ISO string. Defaults to now. Set it when you import history.                                            |
| `eventId`               | Your own id for the event. The server ignores an id it has already stored, so a retried call does not create a duplicate. Defaults to a random id. |
| `universalId`, `status` | Mark the event as one stage of a record that changes. See [Records that change](#records-that-change).                                             |
| `entities`              | Entity references that do not follow the `Id` naming. See [Entities](#entities).                                                                   |
| `$set`, `$set_once`     | Properties to put on the entity the event is about. See [Set properties from an event](#set-properties-from-an-event).                             |


**Track more than you think you need.** The events that decide a case are often not transactions: a password reset, a new beneficiary, a support message, a changed phone number. Free text is the strongest single signal Kairos has seen in testing, so send messages and notes as they are:

```ts
kairos.track("support_message", {
  userId: "user_123",
  text: "My account manager says I must send funds to their wallet to unlock my profit. How do I raise my limit?",
});
```

**What happens to old events.** A decision sees the most recent 30 events of the subject in full (configurable per action). Older events are summarised: a count per event type and a profile of each field. Rare event types and events with long text are kept in full. You do not need to summarise anything yourself.

`track` throws only for an invalid call: no event type, or no entity. It never throws because the API is unreachable; see [Delivery, failure and shutdown](#delivery-failure-and-shutdown).

## Entities

Every event must name at least one entity. Entities are how Kairos builds a timeline and how it finds links.

A property whose name ends in `Id` or `_id` is read as an entity:


| You write               | Kairos stores                  |
| ----------------------- | ------------------------------ |
| `userId: "user_123"`    | entity `user` → `user_123`     |
| `deviceId: "dev_9"`     | entity `device` → `dev_9`      |
| `bankAccountId: "ba_4"` | entity `bank_account` → `ba_4` |
| `recipient_id: "r_1"`   | entity `recipient` → `r_1`     |


For anything that does not fit that naming, pass `entities`:

```ts
kairos.track("application_started", {
  merchantId: "mer_0155",
  entities: { ip: "185.220.219.66", email_domain: "quickinbox.io" },
});
```

Two rules of thumb:

- **An event belongs to every entity it names.** The event above appears in the history of the merchant, of the IP address and of the email domain.
- **A per-event id is not an entity.** `transactionId` or `sessionId` would become an entity with one event each. Send those under another name, such as `reference`, so that they are stored as plain properties.

**Choose entity types by asking what could connect two subjects.** A device, a bank account, a payee, an owner, an IP address, an ATM. If two users naming the same value would tell you something, make it an entity.

## Define an entity

There are two things you can define: a **type** of entity, and **one entity**. Both are optional. An event that names a type or an id nobody defined still creates it, so you can start by only tracking events.

### Define an entity type

```ts
await kairos.defineEntity("merchant", {
  kind: "business",
  description: "A business that takes payments through us",
  properties: {
    country: "Where the business is registered",
    category: "What it sells",
  },
  link: true,
});
```


| Field         | Meaning                                                                                                                                                                     |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`        | What sort of thing the type is: `person`, `business`, `account`, `device`, `contact`, `document`, `network`, `place` or `other`. Optional, and any name is accepted.        |
| `description` | What this kind of entity is. Shown in the console.                                                                                                                          |
| `properties`  | The properties an entity of this type carries, as name → what it means. This documents the type; other properties are still accepted.                                       |
| `link`        | Whether two subjects that share one count as linked. Default `true`. Set it to `false` for a type that should never connect subjects. An action's `linkTypes` overrides it. |


**About** `kind`**.** Your type names are your own: one company says `seller`, another says `merchant`, and both are a business. The kind says so in a vocabulary Kairos shares across customers. Today it classifies the type in the console and in the API, and the console suggests one from the type name. It does not change a decision: the kind is not shown to the model. That is deliberate. A place can be a link: an ATM where the recent users are mostly confirmed mules is a strong one. The link summary already shows that concentration in numbers. In a test with money mules at a shared ATM, the model held 6 of 6 mules with no kind; told only that the ATM is a "place", it held 1; told that a place is a link when its use is concentrated, it held 4. Words about the kind made it more cautious than the numbers alone.

`defineEntity` is safe to call every time your service starts. A defined type appears in the console at once, before any entity of that type exists.

### Create or update one entity

```ts
await kairos.entity("merchant", "mer_0155", { country: "ES", category: "general retail" });

// The natural home for data from a vendor.
await kairos.entity("ip", "185.220.219.66", { country: "NL", network: "datacenter" });
```

Use this when you know something about an entity before, or apart from, any event: a customer on the day the account opens, a branch, an IP address you looked up.

- Properties are merged into what is already stored.
- The entity exists from this call on. It appears in the console and can be the subject of a decision, with or without events.
- Its properties are shown to the model whenever the entity is the subject of a decision or is linked to one.

Use an entity property for a fact that is true now. Use an event for something that happened at a moment.

### Set properties from an event

Most facts about an entity change because something happened. Send the fact with the event, and you do not need a second call:

```ts
kairos.track("kyc_completed", {
  userId: "user_42",
  level: "full",
  $set: { kyc_level: "full", kyc_country: "GB" },
  $set_once: { opened: "2021-03-04" },
});
```

- `$set` puts the properties on the entity the event names, and replaces a value that is there.
- `$set_once` fills a property only if it has no value. Use it for a fact that does not change, such as the day an account opened.
- `$set` and `$set_once` are not stored as properties of the event. They go to the entity.

**When an event names more than one entity**, say which entity the properties are for:

```ts
kairos.track("login", {
  userId: "user_42",
  deviceId: "dev_9",
  $set: { user: { last_country: "GB" }, device: { os: "ios", app_version: "4.2" } },
});
```

With one entity, the short form is enough. With two or more, the short form throws, because Kairos will not guess.

**The newest event wins.** Each property remembers the time of the event that set it. An older event that arrives later does not undo a newer value, so a history import in any order ends with the right properties. A direct `kairos.entity()` call is a fact as of now.

**The entity's first-seen date** is the time of the earliest event that set a property on it, so an imported customer does not look new.

**A secret key is required.** A request with a public key that carries `$set` or `$set_once` is refused with 403: anyone can read a public key out of a page, and it must not change facts about a user.

`trackAndDecide` takes them too, and the decision sees the new properties.

`kairos.entity()` stores through `kairos.setObject()`, which takes the same arguments and remains available: an entity's properties are kept as an object, keyed by its type and id.

## Records that change

Some things are not one event. A transaction is pending, then completed, then perhaps disputed. A claim is filed, then closed with an outcome. Send each stage as an event with the same `universalId` and its `status`:

```ts
kairos.track("transaction", { userId, universalId: "txn_8812", status: "pending", usd: 500, merchantId: "greenleaf_grocery" });
// minutes later
kairos.track("transaction", { userId, universalId: "txn_8812", status: "completed", settled_usd: 498 });
// days later
kairos.track("transaction", { userId, universalId: "txn_8812", status: "disputed", reason: "not recognised" });
```

Every stage is stored. A decision sees **one record in its latest state**:

```json
{
  "type": "transaction", "ts": "2026-10-01T10:00:00",
  "usd": 500, "merchant": "greenleaf_grocery", "settled_usd": 498, "reason": "not recognised",
  "status": "disputed",
  "status_history": ["pending 2026-10-01T10:00:00", "completed 2026-10-01T10:05:00", "disputed 2026-10-04T09:00:00"]
}
```

- The record keeps the time and the event type of its first stage, the latest value of each property, and the latest status.
- Without a `universalId`, the three events above are three transactions of 500, and the summary of older events counts them three times.
- A later stage needs only what changed. Properties from earlier stages are kept.
- A decision as of a past moment sees the record in the state it had then.
- Use your own identifier for the record: the transaction id, the claim number. Send it as `universalId`, not as a property ending in `Id`, which would make it an entity.

The stages may use different event types (`fraud_claim_filed`, `fraud_claim_closed`). What joins them is the `universalId`.

### Start an action on a status

A [trigger](#decide-from-an-event) can name the statuses it starts on, so that a record is decided at the right stage and not at every stage:

```ts
await kairos.defineAction("card_payment", {
  subject: "user",
  trigger: { event: "transaction", status: "pending" },
  hold: "Should the pending card payment be held because …?",
});

await kairos.defineAction("dispute", {
  subject: "user",
  trigger: { event: "transaction", status: ["disputed", "returned"] },
  hold: "Should the dispute be held for manual review because …?",
});

// Decided by "card_payment":
await kairos.trackAndDecide("transaction", { userId, universalId: "txn_8812", status: "pending", usd: 500 });
// Stored only: no action starts on "completed".
kairos.track("transaction", { userId, universalId: "txn_8812", status: "completed" });
// Decided by "dispute", which sees the record's earlier statuses:
await kairos.trackAndDecide("transaction", { userId, universalId: "txn_8812", status: "disputed", reason: "not recognised" });
```

Two actions may share an event type when their statuses differ. Two actions that could both start on the same event are refused. When a later stage starts a decision, the record is the pending action, with its `earlier_statuses`, and it does not also appear in the history.

## Sessions

A session is one visit of a person: from the sign-in to the last thing they did. Send the id of the session with every event and every decision in it, as `$session`. Use the id of the login session in your own system.

```ts
kairos.track("login", { userId: "user_42", deviceId: "dev_9", $session: "sess_7f3a" });
kairos.track("password_changed", { userId: "user_42", $session: "sess_7f3a" });
kairos.track("payee_added", { userId: "user_42", payeeId: "payee_new", $session: "sess_7f3a" });

const decision = await kairos.decide({ type: "withdrawal", userId: "user_42", usd: 2400, $session: "sess_7f3a" });
```

Without it, a decision sees the user's recent events as one list. With it, the decision also sees which of them are the current visit, how long ago the visit started, and its steps in order with the time after the start:

```json
"this_session": {
  "started": "2026-10-06T13:56:00",
  "started_before_this_action": "4 minutes",
  "events": 3,
  "steps": ["+0:00 login", "+0:30 password_changed", "+2:00 payee_added"]
}
```

A takeover is often one short visit, and this is where it shows. On the 100 evaluation cases, with the session taken as the events from the last login to the request, the block raised the catch rate from 93.3% to 98.3% and lowered the false-action rate from 27.5% to 17.5%. The hard takeover cases went from 6 of 10 held to 10 of 10. It costs about 60 input tokens for a decision.

What to know:

- `$session` **is not an entity.** A property named `sessionId` is still an entity of your own called "session", like every property that ends in `Id`. The two can be on the same event and mean different things.
- **Set it on your server**, from the session your server made at sign-in. An id that a browser chose can be changed by whoever holds the browser. A request with no `$session` is decided as before: nothing says that it is safer.
- **A visit ends after 30 minutes with no event.** If the same id comes back later, the decision sees the events after the gap as the current visit, and is told that the id was used before.
- **One session, two users.** If events of another user carry the same `$session`, the decision is told how many (`other_users_in_this_session`). That can be a stolen session.
- **A total can be for the session.** `window: "session"` adds up the subject's events in the current visit, whatever its length: `{ name: "money_out", event: "withdrawal", sum: "usd", window: "session" }`. A request with no `$session` has no such total, and a policy rule on it does not fire.
- `trackAndDecide` takes `$session` like `track`. The event that asks for the decision is the pending action, so it is not one of the steps.

### Traces

For an AI agent or another service that is traced, send the span that each event records as `$trace`. The console then shows the session as a trace: each span as a bar under the span that started it, and each decision on the span that asked for it.

```ts
await kairos.trackAndDecide("tool_call_requested", {
  agentId: "agent_support_1",
  tool: "issue_refund",
  usd: 30,
  $session: "run_8812",
  timestamp: started,
  $trace: {
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "00f067aa0ba902b7",
    parentSpanId: "53995c3f42cd8ad8",
    name: "execute_tool issue_refund",
  },
});
```

- **One span is one event.** A trace is the events that share a `traceId`, and `parentSpanId` puts each under the unit of work that started it.
- `traceId` and `spanId` are required. Use the ids of your tracer, for example OpenTelemetry's.
- `timestamp` is when the span started. For a unit of work that has ended when you send it, such as a model call, add `end` and `status` (`"ok"` or `"error"`). A tool call that asks for a decision has not run yet, so it has no `end` and shows as a point. Send what the tool returned as its own event, with the call's `spanId` as its `parentSpanId`.
- **A decision does not read it.** The ids mean nothing to the model. Put what matters for the decision, such as the tool and its arguments, in the properties.
- `$trace` **is not an entity.** Do not send the ids as `traceId` or `spanId` properties: like every property that ends in `Id`, they would become entities.

You can also send a trace after it ended, for example from a job that reads your tracer's export. Send it as its spans, with one event for each span, in the same way as above. `track` queues the events and sends them in batches.

```ts
for (const span of finishedSpans) {
  kairos.track(span.type, {
    ...span.properties,
    $session: span.conversationId,
    timestamp: span.start,
    eventId: `span_${span.spanId}`,
    $trace: {
      traceId: span.traceId,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      name: span.name,
      end: span.end,
      status: span.status,
    },
  });
}
```

- **Use the span id in the `eventId`.** If you send the same trace again, the server ignores the spans it has already stored. With random ids, each send stores copies, and the copies are counted in the history and the totals.
- **The order does not matter.** The console builds the tree when it shows the session, so a span can arrive before its parent.
- **A trace sent after it ended is history.** It cannot stop a tool call that has already run. Later decisions see it in the history. To judge the finished run, send one more event, such as `agent_run_finished`, and decide on it.
- You can mix the two: decide on the risky tool calls while the agent runs, then send the rest of the trace when it ends. If you use the same `eventId` for a span in both, it is stored once.
- **Do not send a whole trace as one event**, for example as a list of spans in a property. A decision reads the properties, so the full trace goes into every later decision that has this event in its history. The console shows it as one event with no trace, and the ids in it do not become entities.

`GET /v1/sessions/:id` returns a session: its events in order, every entity they name, and the decisions made in it. The console shows the same on a session's page, which you reach from an entity or from a decision. This is a replay of what was done, as events. It is not a recording of the screen.

The loan, insurance, medical and scam payment templates send a visit for every kind of fraud they contain; see [Visits and sessions](../../templates/overview.md#visits-and-sessions).

## In a web framework

In a web application, every call needs the same four things: the user, the device, the IP address and the session. The middleware takes them from the request, so that a call gives only what is particular to it. It can also send an event for a route that has no `track` call. It is optional, and it does not replace `track`.

```ts
import express, { type Request } from "express";
import { Kairos } from "@finic-ai/kairos";
import { express as kairosExpress } from "@finic-ai/kairos/middleware";

const kairos = new Kairos({ apiKey: process.env.KAIROS_API_KEY! });
const app = express();
app.use(express.json());

app.use(
  kairosExpress<Request>(kairos, {
    entities: (req) => ({ user: req.user?.id, device: req.get("x-kairos-device"), ip: req.ip }),
    session: (req) => req.session?.id,
  }),
);
```

Now a call anywhere in the request, in a handler or in the code a handler calls, needs no `userId`, `deviceId`, `ipId` or `$session`:

```ts
kairos.track("transaction", { amount: 900, currency: "GBP", direction: "out" });
const decision = await kairos.decide({ type: "withdrawal", usd: 900 });
```

With Hono, the functions receive the Hono context:

```ts
import { Hono, type Context } from "hono";
import { hono as kairosHono, type KairosVariables } from "@finic-ai/kairos/middleware";

type Env = { Variables: KairosVariables & { userId?: string; sessionId?: string } };
const app = new Hono<Env>();

app.use(
  kairosHono<Context<Env>>(kairos, {
    entities: (c) => ({ user: c.get("userId"), device: c.req.header("x-kairos-device") }),
    session: (c) => c.get("sessionId"),
  }),
);
```

`@finic-ai/kairos/middleware` needs `node:async_hooks`, which Node.js, Bun and Deno have, and Cloudflare Workers with `nodejs_compat`. The rest of the SDK does not.

### How a call gets its context

- **The functions run when a call is made, not when the request arrives.** Install the middleware before your sign-in: by the time a handler calls `track`, the request has its user.
- **What the call names wins.** `kairos.track("login", { deviceId: "other" })` keeps the user of the request and uses the device of the call. `$session: null` is no session; leave `$session` out for the session of the request.
- **A call about someone else takes nothing from the request.** When a support agent changes a customer's account, the request is the agent's and the event is the customer's: `kairos.track("contact_changed", { userId: customer.id })`. Kairos does not add the agent's device, IP address or session, because that would link the two people. The rule is on the entity type of `subject`, which is `"user"` unless you say otherwise: `subject: "merchant"`.
- **A request with no user yet** is a sign-in. `kairos.track("login", { userId })` gets the device, the IP address and the session of the request.
- **`$set` in its short form is about the entity the call names**, not one the request added. `kairos.track("kyc_completed", { $set: { kyc_level: "full" } })` sets it on the user of the request.
- **A function that throws does not fail the request.** The error goes to `onError`, and the call goes on with what it names.

The device id comes from the browser, so whoever holds the browser can choose it. That is acceptable for a `device`. Take `user` and `session` from your own server only. With `kairosjs`, send the visitor identifier in a header of your own:

```ts
const { visitorId } = await (await KairosJS.load()).get();
fetch("/api/payees", { method: "POST", headers: { "x-kairos-device": visitorId }, body });
```

### When the code knows more than the request

```ts
import { setContext, runWithContext, withoutContext } from "@finic-ai/kairos/middleware";

// A sign-in handler learns the user and makes the session itself.
setContext(kairos, { entities: { user: user.id }, session: session.id });

// Work with no request: a queue worker, a scheduled job, a test.
await runWithContext(kairos, { entities: { user: job.userId } }, () => settle(job));

// Work inside a request that is about other people.
withoutContext(kairos, () => notifyPayees(batch));
```

The middleware also puts a client on the request: `req.kairos` in Express, `c.get("kairos")` in Hono. It has `track`, `trackAndDecide` and `decide`, and it holds the context of the request directly:

```ts
req.kairos.track("transaction", { amount: 900 });
```

Use it if a call says that it names no entity when the request has a user. Some older middleware loses the context of the request between the Kairos middleware and your handler; installing the Kairos middleware after the body parsers usually cures it, and `req.kairos` does not depend on it.

### Events for routes

Some things are worth knowing for the fact alone: a password was changed, a payee was added. Name the routes, and the middleware sends the event when the response finishes:

```ts
kairosExpress<Request>(kairos, {
  entities: (req) => ({ user: req.user?.id, device: req.get("x-kairos-device") }),
  session: (req) => req.session?.id,
  routes: {
    "PUT /account/password": { type: "password_changed", failed: "password_change_failed" },
    "POST /api/payees": "beneficiary_added",
    "POST /api/payees/:id/verify": { type: "beneficiary_verified", properties: (req) => ({ payeeId: req.params.id }) },
  },
});
```

The key is the method and the route **as you registered it**, with the path of its router: `/api/payees/:id`, not `/api/payees/p_7`. The event of the first route, for user_42:

```json
{
  "type": "password_changed",
  "entities": { "user": "user_42", "device": "f775935c4510895567ef965a811df36e" },
  "session": "sess_7f3a",
  "properties": { "source": "auto", "http_method": "PUT", "http_route": "/account/password", "http_status": "204" }
}
```

A later decision in the same session then sees the visit step by step, with no `track` call in those handlers:

```json
"steps": ["+0:00 login", "+0:42 password_changed", "+1:10 beneficiary_added"]
```

| The response | The event |
|---|---|
| A status below 400 | `type` |
| 4xx | `failed`, if the route has one. A refused attempt is a signal of its own, and a payee that was refused was not added. |
| 5xx | None. That is a fault of the server, not something the person did. |
| The request has no entity | None. Nothing is thrown. |
| The handler tracked the same event type | None. The handler's event has the data. |
| The client went away before the response | None |

What to know:

- **`routes` do not read the request body.** Bodies hold passwords and card numbers. `properties` is the only way data gets onto the event, and you choose each field. A key that ends in `Id` names an entity, as in `track`.
- **Use it for routes where the fact is enough.** A transfer needs its amount and its payee: call `track` there.
- **The event is sent after the response**, so a `decide` in the same request does not see it. The next one does.
- **In a serverless function**, the function can stop before the event is sent. Hand the upload to the platform:

  ```ts
  waitUntil: (c, work) => c.executionCtx.waitUntil(work),
  ```

- **There is no event for every request.** A decision reads the type of each step of a session, and forty steps called "request" say nothing.

What it is worth, on the 100 evaluation cases, 80 of which have an account change such as a password reset or a new withdrawal address:

| The account changes are | Catch rate | False-action rate | Hard takeovers held |
|---|---|---|---|
| Not tracked | 93.3% | 17.5% | 7 of 10 |
| Sent by the middleware, with no `properties` | 96.7% | 20.0% | 10 of 10 |
| Tracked by hand, with their data | 98.3% | 17.5% | 10 of 10 |

An event for the route brings back the takeovers that were missed. It is not as good as an event with its data: the two differences from the last row are one case each and within what the model varies by itself, but two held cases dropped from `block` to `review`, and the typology was right less often (77% against 83%). So give `properties`, or call `track`, where a route has data that matters.

### Routes from the console

The routes can also come from **Settings › Integrations › Client settings**, where a person changes them with no deployment. Turn it on in the middleware:

```ts
app.use(
  kairosExpress<Request>(kairos, {
    entities: (req) => ({ user: req.user?.id, device: req.get("x-kairos-device") }),
    clientSettings: true,
    hashKey: process.env.KAIROS_HASH_KEY,
  }),
);
```

- **The middleware reads the settings of the key's environment** when it starts and again each minute, in the background. A request never waits for them. If they cannot be read, the middleware keeps the last ones and tells `onError`. It needs a secret key.
- **A route matches the path of the request**, such as `POST /api/payees/:id`, with the path of its router. The routes in `routes` stay as they are; when both send the same event type for a request, it is sent once.
- **Track** sends the route's event when the response finishes, as `routes` does.
- **Decide on request** asks for a decision before your handler runs, with the route's fields, and puts it on `req.kairosDecision` (Hono: `c.get("kairosDecision")`). With the route mode **Active** and the route's **Enforce** on, a `block` answers with the route's block response, and a `step_up` with a step-up page redirects; your handler does not run. In **Monitor**, the handler always runs.
- **Decide on response** is for the [edge](edge.md). The middleware skips such a route, because a handler has already started the response. Call `decide` in the handler instead, after the password check.
- **Behind the Kairos edge**, the middleware sends the events of a route and the edge does not, and a route that decides on the request is decided once, by the edge. Give both the same hash key: see [With the middleware on your servers](edge.md#with-the-middleware-on-your-servers).
- **Fields** are read from the parsed body, the query, the headers, the cookies and the route's parameters. Nothing else from the request is sent. A body is read only when it is JSON of at most 128 KB, so a file upload is never read; in Hono, only when the request has a `Content-Length`. A field of the kind **Hashed**, a cookie and the session cookie are sent only as an HMAC with `hashKey`: without it, they are left out, and `onError` says so once. Keep `hashKey` secret and the same on every server, or links break.
- **The session** is what `session` gives, else the hash of the settings' session cookie, else the [visit](browser.md#the-visit) of the JavaScript tag, from its `kairos_visit` cookie.
- **The `kairos_device` cookie** of the [JavaScript tag](browser.md#the-device) gives the `device` entity when `entities` gives none, so your server's events and the browser's name the same device.


## Define an action

An action is a decision type. You define it once and refer to it by name in `decide`.

```ts
await kairos.defineAction("merchant_onboarding", {
  description: "Approve a merchant application",
  subject: "merchant",
  hold: "Should the pending merchant application be held for manual review because it shows signs of a fraudulent merchant, of a stolen business identity, or of a business that hides what it really sells?",
  typologies: {
    merchant_farm: "Merchant farm: one operator opens many merchant accounts from the same network, device or details",
    stolen_identity: "Stolen business identity: a real business's details are used by someone who does not control it",
    legit: "Legitimate business applying for itself",
  },
  reasons: {
    linked_to_bad_merchant: "The IP address, device, owner or bank account is shared with a merchant that was rejected or terminated",
    datacenter_or_vpn_ip: "The application comes from a datacenter, VPN or proxy network and not from a business or home connection",
    rushed_application: "The form was completed unusually fast or with most fields pasted",
  },
  policy: {
    block: 0.9,
    review: 0.5,
    rules: [{ id: "linked_to_bad_merchant", allOf: ["linked_to_bad_merchant"], outcome: "review" }],
  },
});
```

`defineAction` is safe to call every time your service starts. Sending the same definition again changes nothing. Sending a changed definition stores a new version, and every decision records the version it used.

### The fields


| Field         | Required | What it does                                                                                                                                                                                                                            |
| ------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `displayName` | no       | The name people see in the console, for example "Bank Transfer". The first argument of `defineAction` is the key (`bank_transfer`), which your code passes to `decide`. Without a display name the console shows the key in title case. |
| `subject`     | yes      | The entity type the decision is about. Its history is what the model reads.                                                                                                                                                             |
| `trigger`     | no       | An event type that starts this action, or `{ event, status }` to start only on some statuses. See [Decide from an event](#decide-from-an-event).                                                                                        |
| `hold`        | yes      | A yes/no question. The probability of "yes" is the risk score.                                                                                                                                                                          |
| `typologies`  | no       | Mutually exclusive explanations, as code → description. The most likely one is returned.                                                                                                                                                |
| `reasons`     | no       | Signals to look for, as code → description. Each one found is returned in `reasons`.                                                                                                                                                    |
| `policy`      | no       | How the answers become an outcome.                                                                                                                                                                                                      |
| `context`     | no       | `recentEvents`, `reasonThreshold`, `linkTypes`, `totals`.                                                                                                                                                                               |
| `description` | no       | A note for people. The model does not see it.                                                                                                                                                                                           |




### Writing the hold question

- **Yes must mean "hold".** "Should this transfer be held because …?", not "Is this transfer safe?".
- **Name what you are afraid of.** "…because the account shows signs of account takeover, of money mule activity, or of the customer being a scam victim" works better than "…because it is risky".
- **Name the action.** "the pending bank transfer", so that it is not confused with earlier transfers in the history.



### Writing reasons and typologies

The model never sees the codes, only the descriptions. `new_device` tells it nothing; "The current session uses a device that the account did not use before" tells it everything.

- Write each description so that it stands on its own.
- One fact per reason. Each reason is judged independently, and several can be true at once.
- Typologies are the opposite: exactly one is chosen, so make them exclusive and **include one for "nothing wrong"**. Without it the model must pick a bad explanation for a good customer.
- Give each list at least two entries.



### Policy

```ts
policy: {
  block: 0.9,   // probability at or above which the outcome is "block"
  review: 0.5,  // probability at or above which the outcome is "review"
  rules: [
    { id: "pass_through", allOf: ["deposit_spike", "pass_through", "new_destination"], outcome: "step_up" },
  ],
}
```

The outcome is `approve`, `step_up`, `review` or `block`. The thresholds turn the probability into `approve`, `review` or `block`. A rule fires when every reason code in `allOf` is present, and can only raise the outcome, never lower it.

A rule can also compare one of the action's [totals](#totals) with a number, in `when`:

```ts
rules: [
  // Exact: more than 5,000 out in 24 hours goes to review, whatever the model says.
  { id: "daily_out_limit", allOf: [], when: [{ total: "money_out", op: ">", value: 5000 }], outcome: "review" },
  // A signal and a number together.
  { id: "spike_then_out", allOf: ["pass_through"], when: [{ total: "money_in", is: "times_usual", op: ">=", value: 10 }], outcome: "review" },
],
```


| `is`            | Compares                                                                          |
| --------------- | --------------------------------------------------------------------------------- |
| `sum` (default) | The sum of the total                                                              |
| `events`        | The number of events in it                                                        |
| `times_usual`   | How many times the usual amount. Needs `usual` on the total.                      |
| `share_covered` | The share of the request's amount it covers, 0 to 1. Needs `covers` on the total. |


`op` is `>`, `>=`, `<` or `<=`. Every comparison in `when` and every code in `allOf` must hold. A rule needs one or the other. The server makes these comparisons, so they are exact every time; the model is not asked. A total that could not be calculated (for example `share_covered` when the request has no amount) satisfies no comparison.

Rules matter more than they look. See [Getting good decisions](#getting-good-decisions).

### Context options


| Option            | Default   | Meaning                                                                                                                                   |
| ----------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `recentEvents`    | 30        | How many of the subject's most recent events the model sees in full. Raise it when the pattern you care about is spread over many events. |
| `reasonThreshold` | 0.5       | A reason is returned when its probability is at or above this.                                                                            |
| `linkTypes`       | all types | The entity types that count as links between subjects. See [How links work](#how-links-work).                                             |




### Totals

A decision sees the last 30 events in full and a summary of the older ones. The summary has a count, a median and a maximum for each number, and no sum. When a signal depends on amounts over more events than that, declare a total:

```ts
await kairos.defineAction("withdrawal", {
  subject: "user",
  hold: "Should this withdrawal be held because the account shows signs of fraud?",
  reasons: {
    deposit_spike: "Recent deposits are much larger than the usual deposits of the account",
    pass_through: "Recently deposited funds are sent out again shortly after they arrive",
  },
  context: {
    totals: [
      { name: "money_in", event: "deposit", sum: "amount", where: { status: "completed" }, window: "7d", usual: "90d", covers: "amount" },
    ],
  },
});

const decision = await kairos.decide({ type: "withdrawal", userId: "user_42", amount: 47000 });
```

The model is then shown, beside the events:

```json
"totals": {
  "money_in_last_7d": { "sum": 47183, "events": 6 },
  "money_in_last_7d_against_a_usual_7d": "256.2 times",
  "share_of_this_action_that_money_in_last_7d_covers": 1
}
```


| Field          |                                                                                               |
| -------------- | --------------------------------------------------------------------------------------------- |
| `name`         | The name in the context. The model reads it, so say what it is.                               |
| `event`, `sum` | The event type, and the numeric property to add up.                                           |
| `where`        | Conditions on the event's properties and its `status`. A list matches any of its values.      |
| `window`       | `30m`, `24h`, `7d`. Without it, all history.                                                  |
| `usual`        | A longer period, such as `90d`. The total is compared with a usual window of the same length. |
| `covers`       | A property of the request, such as `amount`. The share of it that the total covers.           |
| `by`           | A property to split the sum by, such as `currency`.                                           |


**Use** `usual` **and** `covers`**.** In testing, the model read one number well and compared two numbers badly. A total that matters as a comparison must carry the comparison.

**Pair a total with a rule.** In testing, totals made the model report `deposit_spike` and `pass_through` correctly, and the risk score barely moved. The outcome changes when a policy rule acts: on the signals, or on the number itself with `when` (see [Policy](#policy)). Do not make a rule from money signals alone: an honest customer who moves a deposit on also shows them. A comparison such as `times_usual >= 10` beside the signal separates the two.

**Totals are not a balance check.** They are facts for a judgement, read at one moment. Check that there is enough money, and that a payment is not sent twice, in your ledger.

A record counts once, in its latest status. The action being decided is not counted. At most eight totals for an action, and a change to them is a new version.

## Ask for a decision

```ts
const decision = await kairos.decide(input, options);
```

The input names the action and describes what is about to happen. Entities are read from it exactly as for an event.

```ts
const decision = await kairos.decide({
  type: "bank_transfer",        // the action name
  userId: "user_123",           // the subject: required, because the action decides about a user
  beneficiaryId: "ben_77",      // other entities involved in this action
  deviceId: "dev_9",
  amount: 9500,                 // anything else describes the action
  currency: "USD",
});
```

**Name every entity the action involves.** They are what Kairos checks for links: the beneficiary this transfer goes to, the device it comes from, the IP address of the session.

### What you get back

```ts
{
  decision: "review",              // "approve" | "step_up" | "review" | "block"
  riskScore: 87,                   // the hold probability × 100
  probability: 0.871,
  reasons: ["new_device", "new_beneficiary"],
  typology: "ato",                 // when the action defines typologies
  rules: [],                       // policy rules that fired
  action: "bank_transfer@1",       // the action version that decided
  decisionId: "kdec_…",            // look this up in the console or at GET /v1/decisions/:id
  fallback: false
}
```

Two things to keep straight:

- `reasons` **is not an explanation of** `riskScore`**.** Each reason is a separate judgement of whether a signal is present. A decision can have a low score and several reasons, which is exactly when a policy rule is useful.
- `decisionId` **is your audit trail.** The decision log keeps the outcome, the exact context the model was shown and its raw answer. Store the id with your transaction.



### `decide` sends your events first

Events you tracked just before the call are still in the queue. `decide` flushes the queue before asking, so the decision sees them. Pass `{ flush: false }` only if you know nothing relevant is pending.

### When Kairos cannot answer

`decide` has a time limit: 3 seconds by default, covering retries. You must choose what happens when it runs out, per decision type.

```ts
// Fail closed: a human looks at it.
await kairos.decide(input, { fallback: "review" });

// Fail open: let it through.
await kairos.decide(input, { fallback: "approve" });
```

With a `fallback`, `decide` always resolves. The result has `fallback: true` and the `error` that caused it; log both.

Without a `fallback`, `decide` throws `KairosTimeoutError` or `KairosApiError`, or a `KairosError` when the network fails on every try.

Use `{ timeoutMs }` to change the limit for one call.

## Decide from an event

Often the thing you want decided is itself an event: a withdrawal was requested, an application was submitted. Give the action a `trigger`, and one call does both:

```ts
await kairos.defineAction("bank_transfer", {
  subject: "user",
  trigger: "bank_transfer_requested",
  hold: "Should the pending bank transfer be held for manual review because …?",
});

const decision = await kairos.trackAndDecide(
  "bank_transfer_requested",
  { userId: "user_123", beneficiaryId: "ben_77", deviceId: "dev_9", amount: 9500, currency: "USD" },
  { fallback: "review" },
);
```

`trackAndDecide` stores the event and returns the decision that it starts. It takes the same properties as `track` and the same options as `decide`, and unlike `track` it waits for the answer.

Prefer it to a `track` followed by a `decide` whenever the request is an event of its own:

- **The request is always in the history.** A later decision can see it. A burst of withdrawals at one ATM is only visible if every request was recorded, and here it cannot be forgotten.
- **The event and the decision cannot disagree.** The event is the pending action: its entities and its properties are what the model is asked about.
- **Each decision records the event that started it**, as `eventId`.

Things to know:

- One event starts one action. A second action that the same event could start is refused. Two actions can share an event type if they name different statuses; see [Records that change](#records-that-change).
- Only `trackAndDecide` waits for a decision. The same event type sent with `track`, or imported in a batch, is only stored, unless the action is [`automatic`](../../concepts/core-concepts.md#action): then Kairos decides each such event from the last hour in the background and sends the decision to your webhooks. Loading older history never triggers decisions.
- Sending the same `eventId` again returns the decision already made. It does not decide twice, so a retry is safe.
- If Kairos cannot be reached, the event is kept in the queue and delivered later, so the history still has it. With a `fallback` you get that outcome; without one, the call throws.
- `decide` remains. Use it when there is no event of its own for the request, and for backtests, which need a `timestamp`.



## Labels

A label is an outcome or a verdict on an entity: what you found out, usually later.

```ts
await kairos.label({ type: "user", id: "user_999" }, "fraud_confirmed");
await kairos.label({ type: "merchant", id: "mer_0142" }, "terminated_chargebacks", { case: "C-2291" });
```

Labels are what make links meaningful. "This device is used by 7 other users" says little; "3 of those 7 carry `fraud_confirmed`, against 2% of all users" says a lot. **Send a label whenever a case is closed, in either direction.** A decision that turned out wrong is as useful as one that turned out right.

### Put the label on the thing the outcome is about


| Outcome                                            | Label                                         |
| -------------------------------------------------- | --------------------------------------------- |
| A customer abused the claims process               | the customer: `account_abuse`                 |
| A customer's card was used by a criminal at a shop | the shop: `fraud_reported`. Not the customer. |
| Money was sent to a scammer's account              | the payee: `scam_reported`                    |
| A merchant was terminated for fraud                | the merchant: `terminated_fraud`              |


A label on a victim spreads through everything the victim shares with honest people. A label on the shop or the payee stays where the problem is.

### When the outcome was known

```ts
await kairos.label(entity, "fraud_confirmed", {}, { timestamp: "2026-09-12T10:00:00Z" });
```

A decision made as of an earlier moment does not see a label from after that moment. Set `timestamp` when you import past outcomes, or a backtest will know things it could not have known.

### How links work

Two subjects are linked when their events name the same entity: the same device, the same bank account, the same ATM. There is nothing to configure.

Sharing alone proves little, because honest customers and fraudsters use the same shops. So for each entity involved in a decision, Kairos tells the model about concentration:

- how many other subjects share it, and how many of those in the last 30 days, 24 hours and 30 minutes
- what share of them carry each label, against the share among all subjects
- how many of the recent ones are themselves new accounts

To leave an entity type out of this for one action, list the types that should count:

```ts
context: { linkTypes: ["device", "payee"] }
```



## Delivery, failure and shutdown

**Batching.** Events are sent when 20 are waiting or every 2 seconds, whichever comes first, in batches of up to 500.

**Retries.** A network failure, a 408, a 429, a 500, a 502, a 503 or a 504 is retried up to 3 times with backoff.

**When the API is down.** Events stay in the queue and are sent on the next attempt. `track` does not throw. You find out through `onError`:

```ts
const kairos = new Kairos({
  apiKey,
  onError: (error) => logger.warn({ error }, "kairos delivery failed"),
});
```

**When the queue is full.** The queue holds 10,000 events by default. Beyond that the oldest are dropped, and `onError` is called. If you import history in bulk, raise `maxQueueSize` or call `flush()` as you go.

**Rejected events.** A batch the API rejects with a status that is not retried (a 4xx other than 408 and 429) is dropped, not retried, and reported to `onError`.

**Flush and shutdown.**

```ts
await kairos.flush();     // send everything queued, and wait
await kairos.shutdown();  // flush, then refuse further events
```

Call `shutdown()` before the process exits, or the last events are lost. In a serverless function, call `flush()` before you return.

**Errors you can catch.**


| Error                | When                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| `KairosError`        | An invalid call: no event type, no entity, `track` after `shutdown`. A network failure on every try. Also the base class of the others. |
| `KairosApiError`     | The API answered with an error. Has `status`, `body` and `requestId`.                                   |
| `KairosTimeoutError` | No answer inside the time limit.                                                                        |
| `KairosWebhookError` | `verifyWebhook`: the delivery is not from Kairos, is too old, or is not JSON.                           |




## Backtesting

To see what Kairos would have decided on past data, load the history with its real timestamps and decide as of a past moment:

```ts
// 1. History, with the times things happened.
for (const e of pastEvents) {
  kairos.track(e.type, { userId: e.userId, ...e.properties, timestamp: e.occurredAt, eventId: e.id });
}
await kairos.flush();

// 2. Outcomes, with the times they became known.
for (const o of pastOutcomes) {
  await kairos.label({ type: "user", id: o.userId }, o.label, {}, { timestamp: o.knownAt });
}

// 3. Decide as of the moment the action was requested.
const decision = await kairos.decide(
  { type: "withdrawal", userId, destinationId, usd },
  { timestamp: requestedAt },
);
```

A decision with a `timestamp` sees only the events and the labels up to that moment. Passing `eventId` makes the import safe to run twice.

Compare the decisions with what actually happened to choose your thresholds.

## Getting good decisions

These come from testing on synthetic data in four domains. They are the things that changed results the most.

**Do not rely on the 0.5 threshold.** Hard cases often score between 0.1 and 0.4 while still ranking above every normal case. The model orders cases well and is cautious with its probabilities. Set `review` from your own outcomes, using a backtest.

**Use rules on reasons for the cases the score misses.** A coached scam victim scored 7 out of 100, but the reasons `deposit_spike`, `pass_through` and `new_destination` were all found with high confidence. A rule on that combination caught what the score did not. Read the reasons of your missed cases; the pattern is usually there.

**Keep rules narrow.** A rule on one common reason will catch honest customers. A rule that held every claim "linked to abusers" also held five real takeover victims; adding "from the customer's own usual device" fixed it. Prefer two or three reasons together.

**Track text.** Support messages, memos, notes from a review. In every domain tested, the clearest cases were decided by a sentence the customer wrote.

**Track the boring events.** A history of ordinary behaviour is what makes unusual behaviour visible. "175 logins, all from one device" is why the 176th from a new device stands out.

**Send labels both ways.** Confirmed fraud and cleared cases. A link is only as good as the labels behind it.

**Name the entities in** `decide`**.** A decision can only check links for the entities it is told about.

**Keep the wording fixed once you tune.** Changing the hold question or a reason description can change the answers, which invalidates thresholds you chose. A change creates a new action version for exactly this reason: compare versions before you switch.

**Look at the decision log.** Open a decision in the console, or fetch `GET /v1/decisions/:id`, and read the context the model was shown. Most surprising decisions are explained by what was, or was not, in it.

## Reference



### `new Kairos(options)`


| Option            | Default                       |                                                                                               |
| ----------------- | ----------------------------- | --------------------------------------------------------------------------------------------- |
| `apiKey`          | required                      | A secret key (`ksk_…`, server side only) or a public key (`kpk_…`, sends events only).        |
| `baseUrl` | `https://kairos.finic.ai` | The address of Kairos. Set it only for a self-hosted server. |
| `flushAt`         | 20                            | Queue size that triggers a send.                                                              |
| `flushIntervalMs` | 2000                          | Send at least this often. 0 turns the timer off.                                              |
| `maxQueueSize`    | 10000                         | Events kept while the API is unreachable.                                                     |
| `timeoutMs`       | 10000                         | Time limit for one event upload and for `defineAction`, `defineEntity`, `entity`, `setObject`, `label`, `resolve` and `runWorkflow` without `wait`, including retries. |
| `decideTimeoutMs` | 3000                          | Time limit for one decision (`decide` or `trackAndDecide`), including retries.                |
| `maxRetries`      | 3                             | Retries after a network failure, 408, 429, 500, 502, 503 or 504.                              |
| `onError`         | no-op                         | Called for delivery failures, dropped events and errors in the functions of the middleware.  |
| `fetch`           | global `fetch`                | Supply your own for a proxy or for tests.                                                     |




### Methods


| Method                                        | Returns                                   | Notes                                                                                                         |
| --------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `track(type, properties?)`                    | `void`                                    | Queued. Special properties: `timestamp`, `eventId`, `entities`, `universalId`, `status`, `$session`, `$set`, `$set_once`. |
| `decide(input, options?)`                     | `Promise<Decision>`                       | Options: `fallback`, `timeoutMs`, `timestamp`, `flush`.                                                       |
| `trackAndDecide(type, properties?, options?)` | `Promise<Decision>`                       | Stores the event and runs the action it triggers. Options: `fallback`, `timeoutMs`, `flush`.                  |
| `defineAction(name, definition)`              | `Promise<definition & { name, version }>` | Idempotent. A change creates a new version.                                                                   |
| `defineEntity(type, definition?)`             | `Promise<definition & { type }>`          | Optional. Describes an entity type and sets whether it links.                                                 |
| `entity(type, id, properties?)`               | `Promise<void>`                           | Creates or updates one entity. Properties are merged.                                                         |
| `setObject(type, id, properties)`             | `Promise<void>`                           | What `entity()` uses underneath. Same arguments.                                                              |
| `label(entity, label, properties?, options?)` | `Promise<void>`                           | Option: `timestamp`.                                                                                          |
| `resolve(decisionId, outcome, options?)`      | `Promise<{ id, revision, final_outcome, resolution }>` | A person's verdict on a decision, after a review: `"approve"` or `"block"`. Options: `note`, `by`. |
| `runWorkflow(name, input?, options?)`         | `Promise<WorkflowRun>`                    | Starts a run. Options: `wait`, `timeoutSeconds`, `idempotencyKey`. With `wait`, the time limit is `timeoutSeconds` (default 10) plus 5 seconds. See [Run and wait](../../platform/workflows.md#run-and-wait). |
| `clientSettings()`                            | `Promise<ClientSettings>`                 | The client settings of the key's environment. See [Client settings](../api.md#client-settings).              |
| `flush()`                                     | `Promise<void>`                           | Sends the queue and waits.                                                                                    |
| `shutdown()`                                  | `Promise<void>`                           | Flushes and closes the client.                                                                                |

### `@finic-ai/kairos/middleware`

| Function | Notes |
|---|---|
| `express(kairos, options?)` | Express middleware. Sets `req.kairos`. |
| `hono(kairos, options?)` | Hono middleware. Sets `c.get("kairos")`. |
| `setContext(kairos, { entities?, session? })` | Says who is acting, from inside a request. Wins over the functions of the middleware. |
| `runWithContext(kairos, { entities?, session?, subject? }, fn)` | Runs `fn` with a context and no request. Returns what `fn` returns. |
| `withoutContext(kairos, fn)` | Runs `fn` with no context. |

| Option | Default | |
|---|---|---|
| `entities` | none | `(req) => ({ user, device, ip, … })`. Entity type → id. An empty value is left out. |
| `session` | none | `(req) => id`. The login session in your own system. |
| `subject` | `"user"` | The entity type of the person who makes the request. |
| `routes` | none | `"METHOD /pattern"` → an event type, or `{ type, failed?, properties? }`. |
| `waitUntil` | none | `(req, work) => void`. Receives the upload of a route's event. |
| `clientSettings` | `false` | `true` also runs the routes of the client settings. See [Routes from the console](#routes-from-the-console). |
| `hashKey` | none | The secret for hashed fields and cookies. |

### `verifyWebhook`

| Function | Notes |
|---|---|
| `verifyWebhook(body, headers, secret, options?)` | Checks a webhook from Kairos (the [Standard Webhooks](https://www.standardwebhooks.com) signature) and returns the message: `Promise<WebhookMessage>`, with `id`, `type`, `version`, `workspace_id`, `environment_id`, `created_at` and `data`. Pass the body as it arrived, before JSON parsing. `secret` is the endpoint's `whsec_…` secret, or a list of secrets during a rotation. Option: `toleranceSeconds`, default 300. Throws `KairosWebhookError`. Import it from `@finic-ai/kairos`. |




### Names

Action names, entity types, label names, reason codes and typology codes must start with a letter or an underscore and contain only letters, digits and underscores, up to 64 characters.

### Limits


|                                         |                                        |
| --------------------------------------- | -------------------------------------- |
| Events per request                      | 500 (the SDK batches for you)          |
| Reasons or typologies per action        | 2 to 255                               |
| Recent events per decision              | 1 to 500, default 30                   |
| History read per decision               | the subject's most recent 2,000 events |
| Entities checked for links per decision | 8, the ones named in `decide` first    |
