# @finic-ai/kairos

TypeScript client for Kairos. Track financial events, then ask for a decision at the moment of action.

The client talks to the Kairos API at `https://kairos.finic.ai`. This page is the short version; the full [SDK guide](https://kairos.finic.ai/docs/reference/clients/typescript) covers actions, labels, links, backtesting and how to get good decisions.

## Use

```ts
import { Kairos } from "@finic-ai/kairos";

const kairos = new Kairos({ apiKey: process.env.KAIROS_API_KEY! });

// Once, at startup: say what you want decided, in plain language.
await kairos.defineAction("bank_transfer", {
  subject: "user",
  hold: "Should the pending bank transfer be held for manual review because the account shows signs of fraud or account takeover?",
  reasons: {
    new_device: "The current session uses a device that the account did not use before",
    new_beneficiary: "The transfer goes to a beneficiary that was added recently",
  },
});

// Anywhere: record what happens. Any event type, any properties.
kairos.track("transaction", {
  userId: "user_123",
  accountId: "account_456",
  recipientId: "recipient_789",
  amount: 9500,
  currency: "USD",
});

// At the moment of action: ask.
const decision = await kairos.decide(
  { type: "bank_transfer", userId: "user_123", recipientId: "recipient_789", amount: 9500 },
  { fallback: "review" },
);

if (decision.decision === "approve") {
  // release the transfer
}

await kairos.shutdown(); // before the process exits
```

```ts
{
  decision: "review",          // "approve" | "step_up" | "review" | "block"
  riskScore: 87,               // hold probability × 100
  probability: 0.871,
  reasons: ["new_device", "new_beneficiary"],
  typology: "ato",             // when the action defines typologies
  rules: [],                   // policy rules that fired
  action: "bank_transfer@1",
  decisionId: "kdec_…",
  fallback: false
}
```

`reasons` lists the signals judged present. It is not a causal explanation of `riskScore`.

## Entities

A property whose name ends in `Id` or `_id` names an entity: `userId` → `user`, `deviceId` → `device`, `bankAccountId` → `bank_account`. For anything that does not follow that naming, pass `entities: { device: "dev_1" }`. Every event and every decision needs at least one.

Entities do the work. An event joins the timeline of each entity it names, and two users who name the same device, beneficiary or bank account become linked. Because of that, a per-event identifier such as `transactionId` is better sent under another name (`reference`, `txn`) so that it is stored as a plain property.

## In a web framework

`@finic-ai/kairos/middleware` takes the user, the device and the session from the request, so that a call gives only what is particular to it. It can also send an event for a route that has no `track` call.

```ts
import { express as kairosExpress } from "@finic-ai/kairos/middleware";

app.use(
  kairosExpress<Request>(kairos, {
    entities: (req) => ({ user: req.user?.id, device: req.get("x-kairos-device") }),
    session: (req) => req.session?.id,
    routes: { "PUT /account/password": "password_changed" },
  }),
);

kairos.track("transaction", { amount: 900 }); // the user and the session come from the request
```

There is one for Hono too. See [In a web framework](https://kairos.finic.ai/docs/reference/clients/typescript#in-a-web-framework).

With `clientSettings: true`, the middleware also runs the routes set in **Settings › Integrations › Client settings**: it tracks them, or asks for a decision before your handler runs. See [Routes from the console](https://kairos.finic.ai/docs/reference/clients/typescript#routes-from-the-console).

## Objects and labels

```ts
await kairos.setObject("user", "user_123", { kyc_country: "GB", plan: "standard" });
await kairos.label({ type: "user", id: "user_999" }, "fraud_confirmed");
```

Object properties appear in the decision context of that entity. Labels are outcomes and verdicts; they are what makes a link meaningful ("this device is shared with two users labelled fraud_confirmed"), so send them whenever a case is closed.

## Behavior

**`track(type, properties)`** returns at once. Events are queued and sent in batches: when 20 are waiting, or every 2 seconds, whichever comes first. `timestamp` defaults to now, and `eventId` makes a retried call idempotent. `track` throws for an invalid call and never for a delivery failure. Delivery failures go to `onError`, and the events stay queued for the next attempt unless the API rejected them as invalid.

**`decide(input, options)`** sends queued events first, so the decision sees everything tracked before the call. It has a 3-second limit by default, covering retries.

**Decide what happens when Kairos cannot answer.** Without `fallback`, `decide` throws `KairosTimeoutError` or `KairosApiError`, or a `KairosError` when the network fails on every try. With `fallback`, it resolves with that action, `fallback: true` and the `error`. Choose per decision type: `"approve"` fails open, `"review"` fails closed.

**`flush()`** sends what is queued and waits. **`shutdown()`** flushes and refuses further events.

## Options

| Option            | Default                   |                                                                                 |
| ----------------- | ------------------------- | ------------------------------------------------------------------------------- |
| `apiKey`          | required                  |                                                                                 |
| `baseUrl`         | `https://kairos.finic.ai` | The address of a self-hosted server, such as `http://localhost:8787`            |
| `flushAt`         | 20                        | Queue size that triggers a send                                                 |
| `flushIntervalMs` | 2000                      | 0 turns the timer off                                                           |
| `maxQueueSize`    | 10000                     | Oldest events are dropped beyond this                                           |
| `timeoutMs`       | 10000                     | One event upload, and each other call that is not a decision                    |
| `decideTimeoutMs` | 3000                      | One decision, including retries                                                 |
| `maxRetries`      | 3                         | Network failures, 408, 429, 500, 502, 503 and 504                               |
| `onError`         | no-op                     | Delivery failures, dropped events and errors in the functions of the middleware |
| `fetch`           | global `fetch`            |                                                                                 |

## Wire contract

See the [API reference](https://kairos.finic.ai/docs/reference/api). Events are sent to `POST /v1/events` as `{ batch: [{ id, type, ts, entities, properties }] }`, decisions to `POST /v1/decide` as `{ action, entities, properties }`.
