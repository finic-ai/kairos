# Events

An event is something that happened in your product: a login, a payment, a new payee, a support message. Events are what Kairos reads when it decides. The more of the ordinary life of a customer Kairos has, the better it can tell what is not ordinary.

Kairos has no list of event types and no schema to register. Send what happens, with the [entities](entities/README.md) it involves.

## The shape of an event

```json
{
  "id": "evt_01",
  "type": "bank_transfer",
  "ts": "2026-10-06T13:58:00Z",
  "entities": { "user": "user_42", "device": "dev_9", "payee": "payee_new" },
  "properties": { "amount": 2400, "currency": "GBP", "note": "rent for October" }
}
```

| Field | | |
|---|---|---|
| `id` | required | Your own id. The same id sent twice is stored once, so a retry makes no duplicate. The SDKs make one when you give none. |
| `type` | required | What happened. Any text up to 128 characters. Yours to choose. |
| `ts` | required | When it happened, which need not be now. The SDKs use now when you give none. |
| `entities` | required | Who and what was involved: entity type → id. At least one. The event joins the history of each one. |
| `properties` | | Anything about the event, stored as given. |
| `universal_id`, `status` | | The event is one stage of a [record that changes](#records-that-change). |
| `session` | | The visit it happened in. See [Sessions](#sessions). |
| `set`, `set_once` | | Properties to put on an entity. See [Entities](entities/README.md#from-an-event). |

## Send events

The SDKs queue events and send them in batches in the background, so a call is safe on a request path. It never fails because Kairos cannot be reached.

```ts
kairos.track("bank_transfer", {
  userId: "user_42",
  deviceId: "dev_9",
  payeeId: "payee_new",
  amount: 2400,
  currency: "GBP",
});
```

```python
kairos.track("bank_transfer", {"user_id": "user_42", "device_id": "dev_9", "payee_id": "payee_new", "amount": 2400, "currency": "GBP"})
```

In the SDKs, a property that ends in `Id` or `_id` names an entity: `userId` is the entity `user`, `payee_id` is `payee`. Everything else is a property of the event. Special fields, such as the time and your own id:

| TypeScript | Python | |
|---|---|---|
| `timestamp` | `timestamp=` | When it happened. |
| `eventId` | `event_id=` | Your own id, for retries. |
| `universalId`, `status` | `universal_id=`, `status=` | A stage of a record. |
| `$session` | `session=` | The visit. |
| `entities` | `entities=` | Entities whose names do not end in `Id`, such as `{ ip: "203.0.113.7" }`. |
| `$set`, `$set_once` | `set=`, `set_once=` | Properties for an entity. |

Other ways in:

- **The API:** [`POST /v1/events`](../reference/api.md#post-v1events) takes 1 to 500 events in a batch.
- **A browser or a mobile app:** use a public key (`kpk_…`). It can send events and nothing else, and it cannot set entity properties. See [Authentication](../platform/authentication.md#public-keys).
- **A provider's webhooks**, such as Stripe or Shopify: [Inbound webhooks](../platform/webhooks/inbound.md) turn them into events, with no code.
- **History you already have:** [Import your history](../getting-started/import-history.md), from a CSV or JSON-lines file.

To get a decision from an event as it arrives, make the event the trigger of an action: see [Decide from an event](../reference/clients/typescript.md#decide-from-an-event).

## What to send

**Send more than the transactions.** The events that decide a case are often a password reset, a new beneficiary, a changed phone number or a support message. Free text is the strongest single signal Kairos has seen in testing, so send messages and notes as they are:

```ts
kairos.track("support_message", {
  userId: "user_42",
  text: "My account manager says I must send funds to their wallet to unlock my profit.",
});
```

**Send from your server** what a decision depends on. Events from a public key can be written by anyone who reads the key from your page: use them as context, not as the only evidence.

**Use any names.** The model reads differently named events without trouble. The [event templates](../templates/events/README.md) are recommended shapes for common events, such as `login`, `transaction` and `fraud_claim`, if you want a starting point.

## Records that change

Some things change state: a transaction is pending, then completed, then perhaps disputed. Send each stage as an event with the same `universal_id` (`universalId` in TypeScript) and its `status`:

```ts
kairos.track("transaction", { userId, universalId: "txn_8812", status: "pending", usd: 500 });
kairos.track("transaction", { userId, universalId: "txn_8812", status: "completed", settled_usd: 498 });
kairos.track("transaction", { userId, universalId: "txn_8812", status: "disputed", reason: "not recognised" });
```

Every stage is stored. A decision sees **one record in its latest state**, with the latest value of each property and the statuses it went through, and a total counts it once. Without a `universal_id`, the three events are three transactions of 500.

- A later stage needs only what changed.
- Use your own identifier for the record, such as the transaction id. Do not send it as a property that ends in `Id`: that makes it an entity.
- The stages may have different event types. What joins them is the `universal_id`.
- An action can start on chosen statuses only: decide on a transaction when it is `pending`, not again when it is `completed`. See [Start an action on a status](../reference/clients/typescript.md#start-an-action-on-a-status).

`GET /v1/records/:id` returns every stage of one record.

## Sessions

A session is one visit of a person, from the sign-in to the last thing they did. Send the id of your own login session with each event and each decision, as `$session` (`session` in Python and the API). A decision with a session sees which recent events are the current visit, how long ago it started, and its steps in order: a takeover is often one short visit, and this is where it shows.

- A session is not an entity, and a visit ends after 30 minutes with no event.
- Set it on your server. A request with no session is decided as before.
- If another customer's events carry the same session id, the decision is told: that can be a stolen session.

The console lists sessions under **Sessions**, and plays each one back step by step.

## What a decision reads

When Kairos decides about a subject, it reads that subject's most recent 2,000 events:

- **The most recent 30 in full**, or another number for each action.
- **Older events as a summary:** a count for each event type, and a profile of each property. Rare event types and events with long text are kept in full however old they are.
- **The current session**, when the request names one.

You do not summarise anything yourself. Older history also reaches a decision through an action's [totals](core-concepts.md#totals).

## Order, time and duplicates

- **Events can arrive in any order.** Each is placed at its `ts`, and a decision made as of a past moment sees only the events up to that moment.
- **History can be imported** with its own times, at any time.
- **A repeated `id` is a duplicate.** It is counted in the answer (`{ "accepted": 1, "duplicates": 1 }`) and changes nothing. Set your own id when a call can be retried.

## See your events

- **Entities › a type › an entity** shows its event history. An event in one of the entity's [lists](entities/lists.md) opens in a window, with its properties, its entities and the decision it started.
- **Sessions** shows each visit with its events and decisions.
- With the API: [`GET /v1/events/:id`](../reference/api.md#get-v1eventsid) for one event, and [`GET /v1/entities/:type/:id`](../reference/api.md#get-v1entitiestypeid) for an entity's recent events.

## Limits

| | |
|---|---|
| Events in one request | 1 to 500. The SDKs batch for you. |
| `type` | 1 to 128 characters |
| `status` | 1 to 64 characters |
| Ids of events, entities, records and sessions | 1 to 256 characters |
| Events read by one decision | the subject's most recent 2,000 |
