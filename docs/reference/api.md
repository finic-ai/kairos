# API reference

The HTTP API of Kairos. The [SDK](clients/typescript.md) calls it for you; use it directly from any language.

- [Conventions](#conventions)
- [Authentication](#authentication)
- [Errors](#errors)
- [Events](#events) · [Records](#records) · [Sessions](#sessions)
- [Entities](#entities) · [Entity types](#entity-types) · [Labels](#labels)
- [Actions](#actions) · [Decisions](#decisions)
- [Metrics and dashboards](#metrics-and-dashboards) · [Counts and usage](#counts-and-usage)
- [Inbound webhooks](#inbound-webhooks) · [Workflows](#workflows) · [Models](#models) · [Queues and cases](#queues-and-cases)
- [Accounts and workspaces](#accounts-and-workspaces) · [Environments](#environments)

## Conventions

- **Base URL.** `https://kairos.finic.ai`. A self-hosted server has its own address.
- **JSON** in and out. Send `Content-Type: application/json` with a body.
- **Times** are ISO 8601. Kairos stores and returns UTC: `2026-10-06T13:58:00.000Z`.
- **Names** of entity types, actions, labels, reason codes and typology codes start with a letter or an underscore and contain only letters, digits and underscores, up to 64 characters.
- **Ids** of entities, events, records and sessions are any text of 1 to 256 characters.
- **Three groups of paths:** `/v1` is the data API, `/auth` is sign-in, `/app` is workspaces and API keys. `GET /health` returns `{ "ok": true }` and needs no key. `POST /mcp` is the [MCP server](mcp.md) for agents.

## Authentication

How keys and sign-in work, how to limit and rotate a key, and every error: [Authentication](../platform/authentication.md).

### The data API (`/v1`)

Send an API key as a bearer token:

```http
Authorization: Bearer ksk_…
```

A key belongs to one workspace and one of its [environments](#environments), and the request is confined to them. Keys are made in the console (**Settings › API keys**) or with [`POST /app/workspaces/:workspace/keys`](#api-keys).

| Kind | Prefix | Allowed |
|---|---|---|
| Secret | `ksk_` | Every `/v1` endpoint |
| Public | `kpk_` | `POST /v1/events`, without `set` or `set_once`, and `GET /v1/client-settings`, which answers only `version`, `consent`, `pages` and `screens` |

A key can be limited to IP addresses or IPv4 ranges. A public key can be limited to websites; the server compares the list with the `Origin` header of the request. `POST /v1/events` answers CORS requests from any origin, so that a browser can send events.

The console uses the same API with a session cookie instead of a key, and names the workspace in a header: `X-Kairos-Workspace: <workspace id>`. `X-Kairos-Environment` names the environment; without it, Production.

### Sign-in and workspaces (`/auth`, `/app`)

These need a person who is signed in: the console, or the CLI after `kairos login --email`. An API key cannot use them.

## Errors

Every error has the same shape:

```json
{ "error": { "type": "invalid_request", "message": "batch.0.ts: must be an ISO 8601 timestamp" } }
```

| Status | `type` | When |
|---|---|---|
| 400 | `invalid_request` | The body or a parameter is not valid. The message names the field. |
| 401 | `authentication_error` | No key, or a key that is unknown or revoked. |
| 401 | `not_signed_in`, `invalid_credentials` | `/auth` and `/app`: no session, or a wrong email address or password. |
| 403 | `public_key_scope` | A public key was used for something other than sending events. |
| 403 | `ip_not_allowed`, `origin_not_allowed` | The key cannot be used from this address or this website. |
| 403 | `workspace_suspended` | The key's workspace is suspended. |
| 403 | `forbidden` | The signed-in person does not have the role for this, or (on `/v1`) is not a member of the workspace in `X-Kairos-Workspace`. |
| 404 | `not_found` | No such thing in this workspace. |
| 404 | `unknown_action` | `decide` named an action that is not defined. |
| 404 | `no_trigger` | `events/decide` got an event that starts no action. |
| 409 | `email_taken`, `already_member`, `last_owner`, `sole_owner`, `queue_has_cases`, `case_resolved`, `case_not_resolved`, `not_dead`, `name_taken`, `production_protected` | The change conflicts with what exists. |
| 413 | `too_large` | The body is larger than 10 MB, or 2 MB with a public key. Some endpoints have a lower limit, which they name. |
| 429 | `rate_limited` | Too many requests. `Retry-After` says when to try again. A public key: 600 requests a minute from one IP address, and 30,000 a minute in all. The [sign-in endpoints](../development/auth-api.md) have their own limits. |
| 500 | `internal_error` | A fault in the server. |
| 502 | `model_unavailable` | The model could not be reached or did not answer in time. |
| 502 | `workflow_failed` | The action's decision workflow failed, or did not answer in time. The message names the step and the run. |

A decision that cannot be made is an error, not a default. Decide in your own code what to do then; the SDK's `fallback` option does this for you.

---

## Events

### `POST /v1/events`

Store a batch of events. Answers `202`.

```json
{
  "batch": [
    {
      "id": "evt_01",
      "type": "bank_transfer",
      "ts": "2026-10-06T13:58:00Z",
      "entities": { "user": "user_42", "payee": "payee_new" },
      "properties": { "amount": 2400, "currency": "GBP" },
      "universal_id": "txn_881",
      "status": "pending",
      "session": "sess_7f3a",
      "set": { "user": { "kyc_level": "full" } },
      "set_once": { "user": { "first_transfer": "2026-10-06" } }
    }
  ]
}
```

| Field | | |
|---|---|---|
| `batch` | required | 1 to 500 events. |
| `id` | required | The idempotency key. An id that was stored before is counted as a duplicate and changes nothing. |
| `type` | required | Any text up to 128 characters. |
| `ts` | required | When it happened. |
| `entities` | required | Entity type → id. At least one. |
| `properties` | | Any JSON object, up to 512 KB as JSON. Default `{}`. |
| `universal_id` | | Events with the same value are stages of one [record](#records). |
| `status` | | The state of the record at this stage, up to 64 characters. |
| `session` | | Events with the same value are one [session](#sessions). |
| `trace` | | The span this event records: `trace_id` and `span_id` (required), `parent_span_id`, `name`, `end` and `status` (`ok` or `error`). `ts` is when the span started. The console shows the spans of a session as a trace. A decision does not read it. |
| `set` | | Entity type → properties to set on that entity. The type must be in `entities`. A value replaces the stored one unless a later event set it. Secret key only. |
| `set_once` | | The same, but only for a property that has no value yet. Secret key only. |

```json
{ "accepted": 1, "duplicates": 0 }
```

### `POST /v1/events/decide`

Store one event and get the decision it starts. The body is one event, as above (not a batch). The event must be the `trigger` of an action, and its `entities` must name that action's subject.

The event is the pending action of the decision. Sending the same `id` again returns the same decision and does not decide again.

The response is a [decision](#post-v1decide) with `event_id` added.

### `GET /v1/events/:id`

One event by its id: `{ id, type, ts, entities, properties, universal_id?, status?, session?, decision }`. `decision` is `{ id, outcome, risk_score }` of the decision it started, or null. 404 when there is no such event.

## Records

### `GET /v1/records/:id`

One record: every event with that `universal_id`, oldest first.

```json
{ "universal_id": "txn_881", "status": "completed", "stages": [ { "id": "evt_01", "status": "pending", … }, { "id": "evt_02", "status": "completed", … } ] }
```

## Sessions

### `GET /v1/sessions`

Sessions, most recently active first. A session is listed when it has at least one event.

| Query | |
|---|---|
| `q` | Part of a session id. |
| `outcome` | `any` for sessions with a decision, or `approve`, `step_up`, `review`, `block` for sessions with a decision of that outcome. |
| `limit`, `offset` | Default 50, at most 200. |

```json
{
  "sessions": [
    {
      "id": "sess_7f3a",
      "started": "2026-10-06T13:54:00.000Z",
      "last_seen": "2026-10-06T13:58:00.000Z",
      "events": 6,
      "decisions": 1,
      "outcome": "block",
      "risk_score": 99,
      "entities": { "user": ["user_42"], "device": ["dev_unknown"] }
    }
  ],
  "total": 54,
  "next_offset": 50
}
```

`outcome` is the most severe outcome among the session's decisions and `risk_score` the highest. `entities` holds up to five ids of each type.

### `GET /v1/sessions/:id`

One session: its events oldest first, every entity they name, and the decisions made in it. An event sent with `trace` has it here. A decision that an event started has that event's id as `event_id`.

```json
{ "id": "sess_7f3a", "started": "…", "last_seen": "…", "entities": { "user": ["user_42"] }, "events": [ … ], "decisions": [ … ] }
```

`?limit=` sets how many of the most recent events are returned: default 500, at most 2,000.

---

## Entities

### `PUT /v1/entities/:type/:id`

Create or update one entity. Properties are merged into what is stored; `unset` removes properties.

```json
{ "properties": { "kyc_country": "GB", "plan": "pro" }, "unset": ["trial_ends"] }
```

```json
{ "type": "user", "id": "user_42", "properties": { "kyc_country": "GB", "plan": "pro" }, "metadata": {}, "first_seen": "…", "updated": "…" }
```

### `PUT /v1/objects`

The same for a batch of 1 to 500: `{ "batch": [{ "type": "user", "id": "user_42", "properties": { … } }] }`. Answers `{ "accepted": 2 }`.

### `GET /v1/objects/:type/:id`

The properties and labels of one entity: `{ type, id, properties, first_seen, labels }`.

### `GET /v1/entities`

Without `type`: the entity types in use, in `types` (see [`GET /v1/entity-types`](#get-v1entity-types)).

With `?type=user`: the entities of that type.

| Query | |
|---|---|
| `type` | The entity type. |
| `q` | Part of an id. |
| `label` | A label name, `*` for any label, `!` for none. |
| `outcome` | The outcome of the most recent decision about the entity, or `none`. |
| `risk_min` | The most recent decision has at least this risk score. |
| `active` | Named by an event in the last `24h`, `7d` or `30d` (any number of `h` or `d`). |
| `prop` | A condition on a property, `name:op:value`. Repeat it for more; all must hold. `op` is `eq`, `ne`, `contains`, `gt`, `lt`, `exists` or `missing`. `eq`, `ne` and `contains` ignore upper and lower case. `gt` and `lt` compare numbers. |
| `sort` | `active` (default), `events`, `risk` or `first_seen`. |
| `limit`, `offset` | Default 50, at most 200. |

```http
GET /v1/entities?type=user&prop=kyc_country:eq:GB&prop=age:gt:40&label=*&sort=risk
```

```json
{
  "types": [ … ],
  "type": "user",
  "entities": [
    { "id": "user_42", "events": 169, "first_seen": "…", "last_seen": "…", "labels": ["fraud_confirmed"], "decision": { "decision": "block", "risk_score": 98, … }, "properties": { "kyc_country": "GB" } }
  ],
  "total": 12,
  "next_offset": null
}
```

### `GET /v1/entities/:type/:id`

Everything about one entity: `{ type, id, properties, first_seen, labels, events, decisions, sessions }`. `events` are the most recent, newest first (`?limit=`, default 100, at most 500). `decisions` are the 20 most recent about it, and `sessions` the 20 most recent it was in.

### Facts and lists of an entity

| | |
|---|---|
| `GET /v1/entities/:type/:id/facts` | `{ facts: [{ name, label, measure, window, value, format?, currency?, usual?, times_usual? }] }`: each fact of the type, worked out now. `value` is a number, or a time for `first` and `last`, or null when no record counts. With `usual`: `usual` is what one window usually held, and `times_usual` how many times that the value is (null when it usually held nothing). |
| `GET /v1/entities/:type/:id/lists/:name` | `{ name, label, columns, rows, total }`, one page: `limit` (default 25, at most 100), `offset`, `q` (a search). Each row is `{ id, ts, link, values }`: `values` has each column's field; `link` is `{ kind: "event" \| "decision" \| "case", id }` or `{ kind: "entity", type, id }`: an event row links to the event, which names the decision it started. 404 when the type has no such list. |
| `GET /v1/entities/:type/:id/media/:property` | The file a property holds, read as on a case layout: from an approved host, or from its data address. A property whose format is `image` must be a PNG, JPEG, GIF, WebP, AVIF or BMP image (415). The errors are those of `GET /v1/cases/:id/view/media/:block/:index`. |

Facts and lists of cases count only the queues the caller can see.

### `DELETE /v1/entities/:type/:id`

Erases a person's data, for a privacy request such as a GDPR erasure or Shopify's `customers/redact`. A secret key, or a signed-in admin or owner (a member gets 403 `forbidden`, a public key 403 `public_key_scope`), in the key's environment only. One transaction.

```json
{
  "entity": { "type": "user", "id": "user_42" },
  "dry_run": false,
  "erased": {
    "entity": 1, "labels": 2, "events": 118, "events_redacted": 3, "decisions": 4, "decisions_redacted": 1,
    "cases": 1, "case_items": 3, "case_evidence": 2, "workflow_runs": 4, "workflow_runs_redacted": 2,
    "webhook_deliveries": 4, "webhook_payloads_redacted": 6
  }
}
```

`?dry_run=true` answers the same counts and deletes nothing. 404 `not_found` when Kairos holds nothing about the entity, not even a copy in someone else's decision, so a second erasure answers 404: a client can treat 404 as done.

**Erasing a person's data.** What goes:

- The entity: its properties and labels.
- Its own events: those that name no other entity. A record or a session loses those stages.
- The decisions about it, and the finished workflow runs of those decisions.
- The cases about it (with their evidence, items and activity), and in other cases the items and evidence that name it, its events or its decisions.
- Outbound webhook deliveries about it, its decisions or its cases.

What stays, changed:

- Events that also name another entity, such as the other side of a transfer or a shared device: they stay for that entity, without the link to this one and without their properties, because nothing tells whose the properties are.
- Decisions about someone else that one of its events started, or whose request or context named it (as `{ "<type>": "<id>" }`, or as a linked entity): the outcome, risk score and resolution stay; `context` and `raw` become `{ "erased": true }` and `request` becomes `null`.
- Other finished workflow runs that its events started, or whose trigger named it: they stay, with `trigger` `{ "erased": true }` and no steps or output.
- Inbound webhook deliveries that stored its events: the row stays in the log, without its payload and headers.

What stays:

- Entities that were only linked to it, such as a shared device. A decision about a linked subject shows counts of other users, never who they are.
- Workflow runs that are still going: they need their trigger to finish. Erase again once they end.
- Background jobs. They hold ids.
- Other ids of the same person: erase each one (for example `user`, `email` and `phone`).

## Entity types

### `PUT /v1/entity-types/:type`

Define what a kind of entity means. Optional: an event that names an undefined type still creates the entity.

```json
{
  "kind": "person",
  "description": "A customer with an account",
  "properties": { "kyc_country": "The country the identity document is from" },
  "link": true
}
```

`link: false` says that two subjects who share an entity of this type are not connected by it. `properties` documents the fields; it does not constrain them.

`display.formats` maps a property to how it shows: `text`, `number`, `money`, `datetime`, `date`, `boolean`, `country`, `link`, `image` or `document`. At most 100.

`facts` (at most 12) and `lists` (at most 6) are what the entity's page and the case pages about it show. The guides are [Facts](../concepts/entities/facts.md) and [Lists](../concepts/entities/lists.md).

```json
{
  "facts": [
    { "name": "money_out_7d", "label": "Money out this week", "source": "events", "measure": "sum", "field": "amount",
      "filters": { "event_type": "transaction", "property": { "name": "direction", "value": "out" } },
      "window": "7d", "usual": "90d", "format": "money", "currency": "GBP" }
  ],
  "lists": [
    { "name": "transactions", "label": "Transactions", "source": "events", "filters": { "event_type": ["transaction"] },
      "columns": ["ts", { "field": "event.amount", "label": "Amount", "format": "money", "currency": "event.currency" }, "decision.outcome"],
      "sort": "newest", "window": "all" }
  ]
}
```

- A fact's `source` is `events`, `decisions`, `labels` or `cases`. `measure` is `count`, `sum`, `avg`, `unique` (how many different entities of the type `field` the events name), `first` or `last`; labels and cases take `count`, `first` and `last`. `sum` and `avg` read a number property of events, or `risk_score` of decisions.
- `filters`: `event_type` (one or a list of up to 10) and `property: { name, value }` for events; `action` and `outcome` (a list) for decisions; `label`; `queue` and `status` (a list) for cases. A list of `linked` entities takes `event_type`.
- `window` is like `24h`, `7d` or `30d`, at most 400 days, or `all` (the default). `usual`, for `count` and `sum` with a window, is at least two times the window. `format` is `number`, `money` (with a `currency` code) or `percent`.
- A list's `source` is `events`, `decisions`, `linked` (with `entity_type`) or `cases`. Its columns: for events `ts`, `id`, `type`, `decision.outcome`, `decision.risk_score` and `event.<property>`; for decisions `ts`, `id`, `action`, `decision.outcome`, `decision.risk_score`, `final_outcome` and `request.<property>`; for linked entities `id`, `name`, `first_seen`, `last_seen`, `events` and `entity.<property>`; for cases `ts`, `id`, `status`, `priority`, `queue`, `assignee` and `resolution`. A column `format` is `text`, `number`, `money`, `datetime`, `date`, `boolean` or `country`; money takes a currency code or a field of the row.

### `GET /v1/entity-templates`

`{ templates }`: entity type definitions to start from, with their facts and lists. The server reads them from `templates/entities/`.

### `GET /v1/entity-types`

Every type that is defined or in use: `{ "types": [{ type, count, events, labelled, last_seen, definition? }] }`.

### `GET /v1/entity-types/:type`

One definition, or `404` when the type was never defined.

### `GET /v1/entity-types/:type/shape`

What entities of the type look like in the stored data, from the 500 most recently updated: each property with its value types, an example and how many entities carry it; the event types that name the type; and the labels in use. Works for a type that no one defined.

## Labels

### `POST /v1/labels`

```json
{ "batch": [{ "entity": { "type": "user", "id": "user_42" }, "label": "fraud_confirmed", "ts": "2026-10-09T10:00:00Z", "properties": { "source": "chargeback" } }] }
```

`batch` holds 1 to 500 labels. `ts` is when the outcome became known; without it, now. A decision made as of an earlier moment does not see the label. Adding the same label again replaces its time and properties. Answers `{ "accepted": 1 }`.

---

## Actions

### `PUT /v1/actions/:name`

Define or change an action. `:name` is its key.

```json
{
  "displayName": "Bank Transfer",
  "description": "Outgoing transfers to a payee",
  "subject": "user",
  "hold": "Should this transfer be held because the account shows signs of fraud or takeover?",
  "reasons": {
    "new_device": "The request comes from a device the user has not used before",
    "new_payee": "The money goes to a payee added shortly before the request"
  },
  "typologies": {
    "legit": "An ordinary payment by the owner of the account",
    "account_takeover": "Someone who is not the owner is using the account"
  },
  "trigger": { "event": "transaction", "status": "pending" },
  "policy": {
    "block": 0.9,
    "review": 0.5,
    "rules": [
      { "id": "both", "allOf": ["new_device", "new_payee"], "outcome": "step_up" },
      { "id": "drained", "when": [{ "total": "money_out", "is": "sum", "op": ">=", "value": 5000 }], "outcome": "review" }
    ]
  },
  "context": {
    "recentEvents": 30,
    "reasonThreshold": 0.5,
    "linkTypes": ["device", "payee"],
    "totals": [{ "name": "money_out", "event": "transfer", "sum": "usd", "where": { "status": "completed" }, "window": "24h", "usual": "90d", "covers": "usd" }]
  }
}
```

| Field | | |
|---|---|---|
| `subject` | required | The entity type the decision is about. |
| `hold` | required | The yes/no question. Yes must mean "hold". |
| `displayName`, `description` | | For people. Not shown to the model. |
| `reasons` | | Code → description, 2 to 255, each description different. Each is judged on its own. |
| `typologies` | | Code → description, 2 to 255, each description different. Exactly one is returned. |
| `trigger` | | An event type, or `{ event, status }` where `status` is one status or a list. One event starts at most one action. |
| `automatic` | | `true`: decide each matching event in the background, with nobody waiting, and send the decision to your webhooks. Only events that a server sends (a secret key, the console, an inbound webhook), never from a public key; only events that happened in the last hour; only events from when it was turned on (`automaticSince`, set by the server). Needs `trigger`. A change of it is not a new version. |
| `policy.block`, `policy.review` | | Thresholds on the hold probability. Default 0.9 and 0.5. |
| `policy.rules` | | Each has an `id`, an `outcome`, and `allOf` (reason codes that must all be present), `when` (comparisons on totals that must all hold), or both. A rule can only make the outcome more severe. |
| `context.recentEvents` | | Events shown in full, 1 to 500. Default 30. |
| `context.reasonThreshold` | | Reasons at or above this probability are returned. Default 0.5. |
| `context.linkTypes` | | The entity types that link subjects. Default: every type whose definition does not say `link: false`. |
| `context.totals` | | At most 8. See below. |

A total:

| Field | | |
|---|---|---|
| `name` | required | The model reads it. Say what it is: `money_in`. |
| `event` | required | The event type to read. |
| `sum` | required | The numeric property to add up. |
| `where` | | Property → a value or a list of values. `status` is the status of the record. |
| `window` | | `30m`, `24h`, `7d` (at most 400 days), or `session`. Without it, all history. |
| `usual` | | A longer period, at least two times the window. The total is compared with what a window usually held in it. Not with `session`. |
| `covers` | | A property of the request. The context says what share of it the total covers. |
| `by` | | A property to split the sum by. Not with `usual` or `covers`. |

A rule's `when` compares a number of a total: `is` is `sum` (default), `events`, `times_usual` (needs `usual`) or `share_covered` (needs `covers`); `op` is `>`, `>=`, `<` or `<=`.

The response is the definition with `name` and `version`. A change to anything the model reads is a new version. Sending the same definition again changes nothing, so this is safe to call at every startup.

### `GET /v1/actions`

`{ "actions": [ … ] }`: the latest version of each.

### `GET /v1/actions/:name`

One action, latest version. `?version=2` reads an earlier version.

### `GET /v1/actions/:name/versions`

`{ "versions": [{ version, created, created_by }] }`, newest first.

### `GET /v1/actions/:name/automatic`

What deciding automatically means for the action: `{ available, per_day, missed_last_day, window_minutes }`. `per_day` is the matching events a day over the last 7 days (each would be one model call); `missed_last_day` is how many since it was turned on were not decided within the hour (the model was down, for example). `available` is false on a server that does not run automatic decisions.

An automatic decision has `"automatic": true` in `GET /v1/decisions`, `GET /v1/decisions/:id` and the `decision.created` webhook. One event has at most one decision: `POST /v1/events/decide` for an event that was already decided returns that decision.

### `GET /v1/templates`

`{ "templates": [ … ] }`: action definitions offered as starting points. Nothing is defined until one is sent to `PUT /v1/actions/:name`.

## Decisions

### `POST /v1/decide`

Ask for a decision on a pending action.

```json
{
  "action": "bank_transfer",
  "entities": { "user": "user_42", "device": "dev_9", "payee": "payee_new" },
  "properties": { "amount": 2400, "currency": "GBP" },
  "session": "sess_7f3a",
  "ts": "2026-10-06T14:00:00Z"
}
```

| Field | | |
|---|---|---|
| `action` | required | The key of a defined action, for its latest version, or `key@version` for a saved version. |
| `entities` | required | Must name the action's subject. The other entities are checked for links. |
| `properties` | | The details of the pending action. |
| `session` | | The session of the request. |
| `ts` | | Decide as of this moment, seeing only events up to it. For backtests. Default: now. |

```json
{
  "decision": "block",
  "probability": 0.977,
  "risk_score": 98,
  "reasons": ["new_device", "new_payee"],
  "typology": "account_takeover",
  "rules": [],
  "action": "bank_transfer@2",
  "decision_id": "kdec_8cd38292942f4c4084d42bc960404c8f"
}
```

The pending action is not stored as an event. To store it too, use [`POST /v1/events/decide`](#post-v1eventsdecide).

When the action has a published, active [decision workflow](../platform/workflows.md#decision-request), that workflow makes the decision: the answer has the same fields, and also `workflow_run_id`. When the workflow fails, or does not answer in its time, the answer is 502 with the type `workflow_failed`, and no decision is saved.

### `GET /v1/decisions`

The decision log, newest first, without the context and the raw answer.

| Query | |
|---|---|
| `outcome` | One outcome. |
| `final_outcome` | One outcome: a person's [resolution](#post-v1decisionsidresolution), or the model's outcome when there is none. |
| `action` | An action key (every version) or `key@version`. |
| `subject_type`, `subject_id` | Decisions about one entity. Both are needed. |
| `session` | Decisions made in one session. |
| `decided_by` | `workflow`: decisions that a [decision workflow](../platform/workflows.md#decision-request) made. `policy`: decisions where a policy rule of the action fired. |
| `workflow` | Decisions that one decision workflow made: its key (every version) or `key@version`. |
| `rule` | Decisions where one policy rule of the action fired. With `action`, the rule of that action only. Only rules in the policy of the action version that decided count: a rule that only a workflow's answer names is not one. |
| `limit`, `offset` | Default 50, at most 200. |
| `before` | Only decisions before this time, for paging by time. |

```json
{ "decisions": [{ "id": "kdec_…", "ts": "…", "action": "bank_transfer@2", "subject": { "type": "user", "id": "user_42" }, "decision": { … }, "session": "sess_7f3a" }], "total": 298, "next_before": "…" }
```

A decision that a workflow made also has `"metadata": { "decision_workflow": "review_transfers@3" }`.

### `GET /v1/decisions/:id`

One decision in full: the fields above, plus `context` (exactly what the model was shown), `raw` (what the model answered, with token usage), and `event_id` when an event started it.

### `POST /v1/decisions/:id/resolution`

A person's decision on a decision: `{ "outcome": "approve" | "block", "note"?, "by"? }`. `note` is up to 2,000 characters. `by` says who; with the console's session it is the person's email address, and without `by` it is `API`. The model's decision stays; `resolution`, `final_outcome` and `revision` change, and `decision.updated` is sent. A new resolution replaces the last one. The answer is the decision without `context` and `raw`.

---

## Metrics and dashboards

### `POST /v1/metrics/query`

One metric, for a dashboard tile or for your own reporting.

```json
{
  "source": "decisions",
  "measure": "share",
  "field": "review,block",
  "filters": { "action": "bank_transfer" },
  "group_by": "action",
  "from": "2026-09-06T00:00:00Z",
  "to": "2026-10-06T00:00:00Z",
  "interval": "day",
  "compare": true
}
```

| Field | |
|---|---|
| `source` | `decisions`, `events` or `labels`. |
| `measure` | `count` (default), `unique`, `share`, `avg` or `sum`. |
| `field` | What the measure is taken of. `avg` and `sum`: `risk_score` or `probability` for decisions, a numeric property for events. `unique`: an entity type, for events. `share`: an outcome, or several separated by commas. |
| `filters` | `action`, `outcome`, `final_outcome`, `typology`, `signal`, `subject_label` (a label, `*` or `!`) for decisions; `event_type`, `property: { name, value }`, `entity_type` for events; `label`, `entity_type` for labels. |
| `group_by` | `outcome`, `final_outcome`, `action`, `typology`, `signal`, `subject_type`, `risk_band`, `event_type`, `label`, `entity_type`, or `property:<name>`. |
| `from`, `to` | The period. `to` must be after `from`. |
| `interval` | `hour`, `day` or `week`. Without it, one total. Weeks start on Monday, UTC. |
| `compare` | Also return the total of the period of the same length before `from`. |

```json
{ "buckets": ["2026-09-06T00:00:00.000Z", …], "series": [{ "key": "bank_transfer", "total": 46.3, "values": [ … ] }], "total": 46.3, "previous_total": 41.0, "unit": "percent", "truncated": false }
```

One request reads at most 250,000 rows of its period. Past that, `truncated` is true and the numbers are a lower bound. More than eight groups come back as eight and "Other" for a count. `risk_band` has ten bands.

### `GET /v1/metrics/options`

What a metric can be filtered and grouped by in this workspace: `{ actions, signals, typologies, event_types, labels, entity_types, event_properties }`. `?event_type=` fills `event_properties` with the properties of that event type and whether each is numeric.

### Dashboards

| | |
|---|---|
| `GET /v1/dashboards` | `{ "dashboards": [ … ] }`, in the order they were made. |
| `POST /v1/dashboards` | Create one. |
| `GET /v1/dashboards/:id` | One dashboard. |
| `PUT /v1/dashboards/:id` | Replace it. |
| `DELETE /v1/dashboards/:id` | Delete it. |

```json
{
  "name": "Payouts",
  "range": "30d",
  "visibility": "workspace",
  "tiles": [{ "id": "t1", "title": "Held", "view": "number", "w": 3, "link": "decisions", "query": { "source": "decisions", "measure": "share", "field": "review,block" } }]
}
```

`range` is `24h`, `7d`, `30d` or `90d`. `view` is `number`, `line`, `area`, `bar`, `stacked`, `hbar`, `table` or `list`. `w` is the width, 2 to 12 columns. `query` is a metric without its period. At most 40 tiles.

`visibility` is `workspace` or `private`. A private dashboard exists only for the person who made it. One made with an API key has no owner and cannot be private. Anyone who can see a dashboard can change its tiles; only its owner renames it, changes who sees it, or deletes it.

## Counts and usage

| | |
|---|---|
| `GET /v1/stats` | `{ events, decisions, outcomes: { approve, … }, actions }` for the workspace. |
| `GET /v1/usage?days=30` | What the workspace used in the last days (1 to 366): `{ days_asked, since, days: [{ day, events, decisions, input_tokens }], by_action, by_event_type, stored: { events, decisions, entities } }`. Events are counted by the day the server received them. |
| `GET /v1/overview` | What the console's overview page shows, in one request. Its shape follows the console and can change. |

## Client settings

What the JavaScript tag, the mobile SDKs, the edge and the SDK middleware collect, for the environment of the key. The console shows them in **Settings › Integrations › Client settings**. A secret key only.

| | |
|---|---|
| `GET /v1/client-settings` | `{ version, consent, defaults, routing, pages, screens, routes }`. `version` is 0 until the first save. |
| `PUT /v1/client-settings` | Replaces all of them, and answers them with the next `version`. A secret key, or a signed-in admin. |

```json
{
  "consent": "required",
  "defaults": { "country": "GB", "off": ["address"], "sessionCookie": "sid" },
  "routing": { "mode": "monitor", "other": "ignore" },
  "pages": [{ "path": "/checkout", "type": "checkout_viewed" }],
  "screens": [{ "name": "Transfer", "type": "transfer_screen_viewed" }],
  "routes": [
    {
      "route": "POST /login",
      "mode": "decide_response",
      "type": "login",
      "failed": "login_failed",
      "fields": { "userId": { "from": "response.header", "path": "x-kairos-user" } },
      "fallback": "approve",
      "enforce": false
    }
  ]
}
```

| Field | |
|---|---|
| `consent` | `required` or `not_required`. |
| `defaults.country` | Two letters, for a phone number with no country code. |
| `defaults.off` | Kinds of personal data never sent: `email`, `phone`, `address`, `username`. |
| `defaults.sessionCookie` | The name of the login session cookie. Only its hash is sent. |
| `routing.mode` | For the edge and the SDK middleware. `off`: nothing is sent for routes. `monitor`, the default: the routes track and decide, but never block. `active`: routes with `enforce` can block, redirect or step up. |
| `routing.other` | What is done with a request that matches no route: `ignore`, the default, or `discover`, which sends the shape of a sample of bodies (key names and value types, never values). |
| `pages`, `screens` | A path or a screen name, and the event type it sends. At most 200 of each. |
| `routes` | Run by the edge, and by the SDK middleware when it opts in. A method and a path, a `mode` (`track`, `decide_request`, or `decide_response`, which only the [edge](clients/edge.md) runs), the event `type`, an optional `failed` type for a 4xx, and `fields`. A route that decides needs a `fallback`, and can have `timeoutMs`, `block`, `stepUp` and `enforce`. At most 100. |

## Inbound webhooks

A provider sends its webhooks to Kairos, which stores them as events and labels. The guide is [Inbound webhooks](../platform/webhooks/inbound.md).

| | |
|---|---|
| `POST /v1/webhooks/:token` | A delivery. **No API key**: the token in the URL and the provider's signature stand for one. Answers `{ "status": "stored" \| "duplicate" \| "ignored" \| "failed" \| "no_entity" }` with 200, or 401 (signature), 400 (not JSON), 413 (over 1 MB), 404 (unknown or disabled, or the workspace is suspended), 503 (the server cannot read the secret). |
| `GET /v1/webhook-presets` | `{ presets }`: the providers Kairos knows (Fingerprint, Sumsub, Checkout.com, Stripe, Shopify, Intercom, Zendesk, Lithic, Marqeta), with their `category`, `checked`, verification, mapping, setup steps and sample payloads (and `sampleHeaders`, the request headers of each sample, for a provider that sends the topic in a header). |

Sources are managed under `/app/workspaces/:workspace/webhooks` with a session and the admin role: see [Accounts and workspaces](#webhooks) below.

## Workflows

A workflow has one trigger and a list of steps, and Kairos runs it in the background. The guide, with each trigger, each step and the expressions, is [Workflows](../platform/workflows.md). A workflow belongs to the environment of the key.

| | |
|---|---|
| `GET /v1/workflows` | `{ workflows: [{ id, name, displayName?, enabled, version, status, trigger, steps, published_at?, failing_since?, draft?, hook? }] }`. `status` is `draft`, `published` or `archived`. `?archived=true` lists the archived ones. |
| `PUT /v1/workflows/:name` | `{ displayName?, enabled?, trigger, steps }`. Saves and publishes the next version. A definition that is not valid is refused with 400, and the message lists each problem by its path, such as `steps.notify.url: the address to call`. |
| `PUT /v1/workflows/:name/draft` | `{ displayName?, trigger, steps }`. Saves the draft; runs do not read it. A new name makes a workflow at version 0. At most 512 KB. |
| `DELETE /v1/workflows/:name/draft` | Drops the draft. 400 for a workflow that was never published. |
| `POST /v1/workflows/:name/publish` | Makes the draft the next version, after the same checks as `PUT`. 400 when there is nothing to publish. |
| `PATCH /v1/workflows/:name` | `{ enabled?, displayName? }`. Pause, activate or rename. Makes no version. |
| `POST /v1/workflows/:name/archive` | No new runs start. Open runs finish. Runs stay. |
| `POST /v1/workflows/:name/restore` | Back to `published`, or to `draft` if it was never published. |
| `DELETE /v1/workflows/:name` | Deletes the workflow and its runs. |
| `GET /v1/workflows/:name` | The live version, with `draft` when there is one. `?version=2` reads an earlier version. |
| `GET /v1/workflows/:name/versions` | `{ versions: [{ version, created, created_by }] }`, newest first. |
| `POST /v1/workflows/:name/hook` | A URL for the webhook trigger: `{ path: "/v1/workflow-hooks/wfh_…", hint }`. The only time the token is returned. A new one stops the old one. |
| `POST /v1/workflows/:name/runs` | `{ input?, idempotency_key?, wait?, timeout_seconds? }`. Starts a run of the live version, and answers 202 with the run. 400 when the workflow is a draft, paused or archived, when it has a decision trigger (call `POST /v1/decide`), or when the input does not match the manual trigger's `inputs` (`input.user: is required`). The same `idempotency_key` gives the same run. With `"wait": true`, the run happens in the request: 200 when it ended or gave its answer with an Answer step, 202 when `timeout_seconds` (1 to 30, default 10) was used up or a step waits for a retry; 400 at once when a delay can come before the answer. See [Run and wait](../platform/workflows.md#run-and-wait). |
| `GET /v1/workflows/:name/runs` | `{ runs }`, newest first. 50, or up to 500 with `?limit`. |
| `GET /v1/workflow-runs/:id` | `{ id, workflow_id, workflow, status, trigger, steps, output, error, test, created, started, finished }`. `output` is the value of an Answer or a Return step, else the output of the last step that acted (not a condition, a filter or a delay); null until it has one. `workflow` is `name@version` (`name@draft` for a test run). `steps` is the log: `{ path, id, name, status, attempt, output?, error?, started?, finished?, wake? }` for each step. |
| `POST /v1/workflow-runs/:id/cancel` | Cancels a run that is `queued`, `running` or `waiting`. A finished run does not change. |
| `POST /v1/workflows/test` | `{ definition, input?, live_steps?, mock_outputs? }`. Runs a definition once, without saving it. Only the steps in `live_steps` act. 202, with the run. |
| `POST /v1/workflows/:name/training-data` | `{ features, labels, window, subject?, from?, to?, limit? }`. The rows to train a scoring model on, as CSV: `run_id, ts, subject_type, subject_id, label`, then each feature. `features` is read over each run as a [score step](../platform/workflows.md#score-with-a-model) reads it; an empty cell is a missing value. `label` is 1 when the subject got one of `labels` after the run and within `window` (`"180d"`). Runs whose subject had a label before, and runs whose window has not ended, are left out. `subject`, `{ type, id }` with a template for the id, is needed unless the workflow makes an action's decisions. The headers `X-Kairos-Rows`, `X-Kairos-Positives`, `X-Kairos-Already-Labeled`, `X-Kairos-Outcome-Unknown` and `X-Kairos-No-Subject` give the counts. At most 200,000 rows. `python -m kairos train` reads it: see [Models](../platform/models.md). |
| `POST /v1/workflows/:name/experiments` | `{ features, variants, labels, window, subject?, from?, to?, split?, metric?, baseline?, review_rate?, block_rate?, model_prefix?, name?, hypothesis? }`. 202 with the experiment, `queued`; the server trains, validates and tests each variant in the background. See [Experiments](../platform/models.md#experiments). |
| `GET /v1/workflows/:name/experiments` | `{ experiments }`, newest first, at most 100, each without its variants' steps. |
| `GET /v1/workflow-experiments/:id` | `{ id: "wfx_…", workflow, base_version, status, error, config, dataset, results, best, selected, applied, created_by, created_at, started_at, finished_at }`. Each result has `key`, `name`, `model`, `models`, `metrics: { valid, test, gain, thresholds, at_review, at_block }`, `steps` and `problems`. |
| `PATCH /v1/workflow-experiments/:id` | `{ name?, variants? }`, where `variants` maps a variant's key to its new name. Renames the experiment or its variants; the keys, models, steps and results stay. The experiment. 400 for a key it does not have. |
| `POST /v1/workflow-experiments/:id/apply` | `{ variant, reason?, publish? }`. Writes the variant's steps, with the workflow's trigger, as its draft, or with `publish: true` as its next version. Records `selected: { variant, reason, by, at }` and `applied: { variant, version, published, at }`. `{ experiment, workflow }`. 400 while the experiment is not done, or when the steps cannot be saved. 409 when a variant was applied already, when the workflow has a newer version than the one the experiment ran on, or, without `publish`, when the workflow has a draft. |
| `GET` / `POST` / `PUT /v1/workflow-hooks/:token` | A call to a webhook trigger. **No API key.** 202 `{ run_id }`, or 404 (unknown URL, or the workspace is suspended), 405 (wrong method), 409 (paused, archived or not published), 413 (over 1 MB). |

A run's `status` is `queued`, `running`, `waiting`, `filtered`, `done`, `failed` or `cancelled`. See [Runs](../platform/workflows.md#runs).

## Models

The models that workflow steps use: the built-in question model `grayson-1`, and the scoring models you upload. The guide is [Models](../platform/models.md). An uploaded model belongs to the environment of the key.

| | |
|---|---|
| `GET /v1/models` | `{ models, total }`. A built-in model is `{ slug, name, kind: "question", runtime: "builtin", status }`. An uploaded one is `{ slug, name, kind: "scoring", runtime: "in_process", status, version, definition, created, updated, archived_at? }`, where `status` is `active` or `archived` and `definition` is the latest version's. `?kind=question` or `?kind=scoring` filters. `q` finds a part of the slug or the name, in any case. One page: `limit` (default 100, at most 500) and `offset`, with `total`, the number that match. The built-in models come first, then the uploaded ones by slug. |
| `GET /v1/models/:slug` | One model, with `versions: [{ version, created, created_by }]`, newest first. |
| `POST /v1/models/:slug/versions` | `{ name?, format: "xgboost-json" or "logistic-json", model, samples, description?, metrics?, training?, suggested_features? }`, as JSON, with `Content-Encoding: gzip` or without. Uploads the next version, and makes the model the first time; `name` is needed then. `model` is the JSON of XGBoost's `save_model`, or a [logistic model](../platform/models.md#logistic-models). `samples` is 100 to 1,000 rows, `{ features: { name: number or null }, score }`, with the score that XGBoost gave each. 201 `{ model, version, created: true, load_ms }`; 200 with `created: false` when it is the same as the latest version. 400 when Kairos cannot score the model, or scores a sample differently from XGBoost by more than 1e-6, with the problems; 409 for an archived model or a built-in slug; 413 over 4 MB, or over 64 MB without gzip. |
| `GET /v1/models/:slug/versions/:version` | `{ slug, version, definition }`. `definition` has `features`, `trees`, `depth`, `artifact`, `parity: { samples, max_difference }`, and what the upload gave. |
| `GET /v1/models/:slug/versions/:version/file` | The model's JSON, which `Booster.load_model` reads. |
| `POST /v1/models/:slug/versions/:version/score` | `{ features }`. Scores one row: `{ score, risk_score, model, features, missing, invalid }`, as a score step gives. 400 for a name that is not a feature of the model. |
| `POST /v1/models/:slug/versions/:version/promote` | `{ to }`, the id of another environment of the workspace. Uploads the same file and samples there as the next version of the slug, with every check of an upload, and records `promoted_from: { environment, version, sha256 }` in its definition. 201 `{ model, version, created: true, load_ms, environment, reference }`, where `reference` is `slug@version` in the target; 200 with `created: false` when the target's latest version is the same. **A console session only:** 403 with an API key. 400 for the same environment, 404 for an unknown environment or version, 409 for an archived model in the target or a built-in slug. |
| `PATCH /v1/models/:slug` | `{ name }`. The slug does not change. |
| `POST /v1/models/:slug/archive` | No workflow saved after this can use it; the ones that use it still score. 409 while a published workflow scores with it, with the workflow's name. |

A slug is lowercase letters and digits, in groups joined by one `-`, at most 64 characters. A step names a version as `slug@2`, or the latest as `slug`.

## Queues and cases

A queue's rules open cases for the decisions that need a person. The guides are [Queues](../case-management/queues.md) and [Cases](../case-management/cases.md).

| | |
|---|---|
| `GET /v1/queues` | `{ queues }`, each with `counts: { open, in_review, unassigned, overdue, open_decisions, mine }`. `open_decisions`: resolved cases with a decision that has no resolution and is not `approve`. `mine`: cases not resolved and assigned to the signed-in person. |
| `POST /v1/queues` | Create one (below). A private queue needs a signed-in person. |
| `GET /v1/queues/:id` | One queue, with its counts. |
| `PUT /v1/queues/:id` | Replace it. Only its owner renames it or changes who sees it. A change to `sources`, `intake` or `correlation` adds one to `version`. |
| `DELETE /v1/queues/:id` | 409 `queue_has_cases` when it has cases: disable it with `enabled: false` instead. |
| `POST /v1/queues/test` | A definition, not saved. `{ days, tested, matched, cases, skipped, truncated, samples }`: what it would have made over the last 30 days. Makes nothing. |
| `GET /v1/queues/:id/cases` | `{ cases, total }`. `status` (`open`, `in_review`, `resolved`, `unresolved`, `open_decisions`), `priority`, `assignee` (a user id, `me` or `none`), `due=overdue`, `q` (an id), `limit` (up to 200), `offset`. In the queue's order. |
| `POST /v1/queues/:id/cases/bulk` | `{ ids, assign }` (a user id or null) or `{ ids, resolve }` (the body of `resolve` below). At most 200 ids. `{ results: [{ id, ok, error? }] }`: each case changes or fails on its own. |
| `GET /v1/cases/:id` | `{ …case, queue, evidence, items, activity, decisions }`. |
| `GET /v1/cases/:id/timeline` | `{ steps: [{ kind: "event" \| "decision", ts, item, event \| decision }] }`, oldest first. `item` is false for what happened around the case's entity. `?items_only=true` leaves those out. |
| `POST /v1/cases/:id/assign` | `{ assignee, by? }`: an active member's user id, or null. `by` is as for a note. An open case that gets an assignee is in review; with null, the case is open. 409 `case_resolved` for a resolved case. |
| `POST /v1/cases/:id/take` | Assign to the signed-in person. |
| `POST /v1/cases/:id/notes` | `{ text, by? }`, at most 5,000 characters. `by` names who wrote it when an API key calls; without it, `API`. A signed-in person is always named by their email address. |
| `POST /v1/cases/:id/resolve` | `{ category, note?, apply_to_decisions?, label_target?, by? }`. `by` is as for a note. `category` is `approved`, `blocked`, `confirmed_fraud`, `false_positive` or `no_action`. `apply_to_decisions` only with `approved` or `blocked`; `label_target` only with `confirmed_fraud` or `false_positive`. `note` is at most 2,000 characters. Answers the case, with `decisions_resolved` and `labelled`. 409 `case_resolved` when the case is resolved already. |
| `POST /v1/cases/:id/reopen` | `{ by? }`, optional. Opens a resolved case again: in review with an assignee, else open. `by` is as for a note. 409 `case_not_resolved`. |

```json
{
  "name": "Onboarding review",
  "description": "New accounts held for an identity check",
  "visibility": "workspace",
  "enabled": true,
  "sources": { "actions": ["onboard_user"] },
  "intake": [
    {
      "id": "held_or_risky",
      "name": "Held or risky",
      "priority": "high",
      "conditions": {
        "any": [
          { "field": "decision.outcome", "op": "in", "value": ["review", "step_up", "block"] },
          { "field": "decision.risk_score", "op": ">=", "value": 80 },
          { "field": "signal.identity_mismatch", "op": ">=", "value": 0.9 }
        ]
      }
    }
  ],
  "correlation": { "by": "subject", "window_days": 30, "reopen_days": 7, "when_missing": "create" },
  "due_hours": { "urgent": 1, "high": 4, "normal": 24 },
  "columns": ["target", "priority", "status", "assignee", "risk", "request.country", "age"],
  "sort": "oldest",
  "display": { "icon": "person", "color": "purple" }
}
```

- `op` is `=`, `in` (a list), `>`, `>=`, `<`, `<=` or `between` (two numbers). Outcomes and typologies take `=` or `in`; scores take the comparisons.
- `correlation.by` is `subject`, `entity` (with `type`), `request` (with `property`), `session` or `event`. `window_days` (1 to 90, default 30) is only for the first three. `reopen_days` (1 to 90): a trigger within that many days after a case is resolved reopens it. `when_missing` is for a trigger with no key: `create` (default) makes a case that cannot be joined, `skip` makes none.
- `due_hours` sets, for each priority, the hours a case can wait (more than 0, at most 8,760). A case gets `due_at` when it opens; a raised priority can make it sooner.
- `columns` are `target`, `priority`, `status`, `assignee`, `age`, `due`, `last_activity`, `outcome`, `risk`, `evidence`, `reason`, and `request.<property>` or `subject.<property>`. At most 12.
- `sort` is `oldest`, `newest`, `priority`, `risk` or `due` (soonest first; cases with no due time last).

A case:

```json
{
  "id": "case_…", "queue_id": "que_…", "status": "open", "priority": "high",
  "assignee": null, "target": { "type": "user", "id": "user_42" }, "correlation_key": "subject:user:user_42",
  "reason": "Held or risky", "outcome": "review", "risk": 84, "evidence_count": 2,
  "last_evidence_at": "…", "last_activity": "…", "resolution": null, "due_at": "…", "created": "…",
  "values": { "request.country": "BR" }
}
```

Outbound webhooks can send `case.created`, `case.assigned`, `case.resolved` and `case.reopened`. `data` is the case as above, with `case_id` and `queue_id`. `filter.queues` (queue ids) limits them to some queues.

### Case layouts

A queue's case layout is `display.view` of its definition. The guide is [Case layouts](../case-management/layouts.md). A change to it does not add one to the queue's `version`.

```json
"display": {
  "icon": "person",
  "view": {
    "template": "onboarding_identity",
    "header": ["subject.country", "decision.risk_score", "case.due"],
    "blocks": [
      { "id": "why", "type": "evidence", "region": "main" },
      { "id": "check", "type": "checklist", "region": "main", "w": 6, "points": ["The ID matches the selfie"] },
      { "id": "applicant", "type": "fields", "region": "main", "w": 6, "fields": ["subject.first_name", { "field": "request.amount", "format": "money", "currency": "request.currency" }] },
      { "id": "photos", "type": "images", "region": "side", "fields": ["subject.id_front_url", "subject.selfie_url"] },
      { "id": "device", "type": "facts", "region": "side", "of": "item.device" },
      { "id": "logins", "type": "list", "region": "main", "lists": ["logins"], "rows": 5 }
    ],
    "facts": [{ "for": "user", "name": "devices", "label": "Devices used", "source": "events", "measure": "unique", "field": "device" }],
    "lists": [{ "for": "user", "name": "logins", "label": "Logins", "source": "events", "filters": { "event_type": "login" }, "columns": ["ts", "event.ip_country"] }]
  }
}
```

- A block's `type` is `evidence` (required), `decisions`, `timeline`, `details`, `fields`, `facts`, `list`, `objects`, `activity`, `text`, `images`, `documents` or `checklist`; `region` is `main` or `side`; `w` (main only) is 3 to 12, default 12. At most 24 blocks and 6 header fields.
- A field is a path, or `{ field, label, format, currency }`: `case.<status|priority|assignee|queue|opened|age|due|reason>`, `decision.<outcome|risk_score|action|typology>`, `signal.<code>`, `request.<property>`, `event.<property>` (of the latest decision), `subject.<property>` and `item.<type>.<property>`. A fields block has at most 16; an images or documents block 1 to 8, each holding an address.
- `of` (facts and list) is `case.target` (the default) or `item.<type>`: up to 5 objects of that type. `facts` and `lists` name what the block shows: the view's own (with `for`, an entity type) first, then the type's. Without them, the view's own for the type, or the type's.
- `sensitive` (images and documents, default true): hidden until opened, and each opening recorded. `points` (checklist): 1 to 12 different points. `rows` (list): 3 to 25. `text` (text): up to 2,000 characters.

| | |
|---|---|
| `GET /v1/cases/:id/view` | `{ custom, template?, header, blocks }`: the queue's layout, or the standard layout with `custom: false`. `header` and a fields block's `values` are `[{ field, label, format?, currency?, value }]`. A facts or list block has `entities: [{ type, id, name, facts? , lists? }]`. An images or documents block has `media: [{ index, label, state, host? }]`, `state` being `ready`, `missing`, `not_a_link` or `host_not_approved`; never the address. A field that holds a data address (`data:<type>;base64,…`) is `ready` with no host. A checklist has `checks: [{ point, checked, by?, at? }]`. |
| `POST /v1/cases/:id/view/preview` | `{ view }`: the case drawn with a layout that is not saved, as `GET /v1/cases/:id/view` gives it. 400 when the layout is not valid. Saves nothing. `POST /v1/cases/:id/view/preview/lists/:block` reads a list block of that layout, with the query of the route below. |
| `GET /v1/cases/:id/view/lists/:block` | One page of a list block: `type`, `entity` and `list`, with `limit`, `offset` and `q`. As `GET /v1/entities/:type/:id/lists/:name`. |
| `GET /v1/cases/:id/view/media/:block/:index` | The image or document, read by the server from an approved host, or from the data address the field holds: its bytes, with its content type. `Content-Disposition` is `attachment` unless it is a PDF, plain text or an image. 403 `host_not_approved`; 410 `link_expired` (the address answered 401, 403 or 410); 413 over 15 MB; 415 an images block's file that is not a PNG, JPEG, GIF, WebP, AVIF or BMP image; 502 when the host cannot be read. |
| `POST /v1/cases/:id/view/viewed` | `{ block }`: records in the activity that a person opened a sensitive block. |
| `POST /v1/cases/:id/checks` | `{ block, point, checked }`: ticks or clears a point (by its index). `{ checks }`. 409 when the case is resolved. |
| `GET /v1/case-view-templates` | `{ templates: [{ name, label, description, view }] }`, from `templates/case-views/`. |

---

## Accounts and workspaces

These need a person who is signed in, in the console or with `kairos login --email`. An API key cannot use them.

### Workspaces and members

The role needed is in the last column. A workspace you are not in answers `404`.

| | | |
|---|---|---|
| `POST /app/workspaces` | `{ name }`. You become its owner. | signed in |
| `PATCH /app/workspaces/:workspace` | `{ name }` | admin |
| `GET /app/workspaces/:workspace/media-hosts` | `{ hosts }`: the hosts case layouts read images and documents from. | member |
| `PUT /app/workspaces/:workspace/media-hosts` | `{ hosts }`: at most 20 names such as `files.example.com`, or `*.example.com` for every subdomain. | admin |
| `GET /app/workspaces/:workspace/data-retention` | `{ retention_days }`: how many days the workspace keeps its history; `null` (the default) keeps it forever. See [Data retention](../platform/workspaces.md#data-retention). | member |
| `PUT /app/workspaces/:workspace/data-retention` | `{ retention_days }`: a whole number of days from 7 to 3650, or `null` for forever. Kept in the workspace's `settings` as `data_retention_days`. | admin |
| `GET /app/workspaces/:workspace/mcp` | `{ enabled, groups, tools }`: whether agents can connect through [MCP](mcp.md), and the tool groups that are on. | member |
| `PUT /app/workspaces/:workspace/mcp` | `{ enabled, groups }`. `groups` holds `read`, `write` and `decide`. | admin |
| `DELETE /app/workspaces/:workspace` | `{ confirm: <the workspace's name> }`. Deletes the workspace and all its data. This cannot be undone. | owner |
| `GET /app/workspaces/:workspace/members` | `{ members, invites }`. Invites are listed for admins. | member |
| `PATCH /app/workspaces/:workspace/members/:user` | `{ role }`. Only an owner makes or unmakes an owner. A workspace keeps at least one owner. | admin |
| `DELETE /app/workspaces/:workspace/members/:user` | Remove a member, or leave. | admin, or yourself |
| `POST /app/workspaces/:workspace/invites` | `{ email, role? }`. Returns `{ invite, token }`. No email is sent: pass the link on yourself. An invite lasts 7 days, and a new one for the same address replaces the old. | admin |
| `DELETE /app/workspaces/:workspace/invites/:invite` | Revoke an invite. | admin |

### API keys

| | | |
|---|---|---|
| `GET /app/workspaces/:workspace/keys` | `{ keys }`, with a hint of each key, never the key. | admin |
| `POST /app/workspaces/:workspace/keys` | `{ name, kind, allowed_ips?, allowed_origins?, environment_id? }`. Returns `{ key, secret }`. This is the only time the key itself is returned. Without `environment_id`, the key is for the selected environment. | admin |
| `PATCH /app/workspaces/:workspace/keys/:key` | `{ name?, allowed_ips?, allowed_origins? }`: only the fields given change, and the new limits apply to the next request. The key, its kind and its environment never change. A revoked key cannot be changed (409). Returns `{ key }`. | admin |
| `DELETE /app/workspaces/:workspace/keys/:key` | Revoke a key. It stops working at once. | admin |

`kind` is `secret` or `public`. `allowed_ips` is a list of IP addresses and IPv4 ranges such as `203.0.113.0/24`. `allowed_origins` is for a public key only: websites such as `https://app.example.com` or `https://*.example.com`.

### Webhooks

Inbound sources and outbound endpoints share these routes; `direction` is `in` or `out`. All need the admin role.

| | |
|---|---|
| `GET /app/workspaces/:workspace/webhooks?direction=in` | `{ webhooks }`, each with `deliveries_24h` and `failures_24h`. Never a secret or a token, only hints. |
| `POST /app/workspaces/:workspace/webhooks` | Inbound: `{ "direction": "in", name, verification, secret?, mapping, preset? }` → `{ webhook, token, path }`, the only time the token is returned. |
| `GET` / `PATCH` / `DELETE /app/workspaces/:workspace/webhooks/:id` | One webhook. An inbound `PATCH` takes `name`, `verification`, `mapping`, `enabled`, `secret` (replaces every secret) and `add_secret` (adds a second). |
| `POST /app/workspaces/:workspace/webhooks/:id/token` | A new URL token. The old URL stops at once. |
| `GET /app/workspaces/:workspace/webhooks/:id/deliveries` | The delivery log, newest first, with `status`, `limit` and `offset`. |
| `GET /app/workspaces/:workspace/webhooks/:id/deliveries/:delivery` | One delivery, with `payload` (null after 7 days), `headers` (without secrets) and `result` (`{ events, duplicates, labels, event_ids, unresolved? }`). |
| `POST /app/workspaces/:workspace/webhooks/:id/replay` | `{ "delivery": "whd_…" }` or `{ "status": "failed" }`: run stored deliveries through the current mapping. Returns `{ replayed, statuses }`. |
| `POST /app/workspaces/:workspace/webhooks/preview` | `{ mapping, body, headers? }` → what the mapping gives (`outcome`, `events`, `labels`, `problems`, `matched`). Stores nothing. |

`verification` is `{ "scheme": "hmac", "header", "algorithm"?, "encoding"?, "prefix"? }`, `{ "scheme": "timestamped", "header", "timestampHeader"?, "timestampKey"?, "signatureKey"?, "join"?, "algorithm"?, "encoding"?, "tolerance"? }`, `{ "scheme": "standard", "tolerance"? }`, `{ "scheme": "stripe", "tolerance"? }`, `{ "scheme": "header", "header" }` or `{ "scheme": "none" }`. See [Verification](../platform/webhooks/inbound.md#verification). A wrong mapping is refused with 400 and the problems in words.


### Jobs

The background work of one environment: webhook deliveries, workflow runs, automatic decisions and the queue rules' test of new decisions. Send the environment in `X-Kairos-Environment`; without it, production. All need the admin role. Jobs of no workspace, such as the cleanup, are not listed.

| | |
|---|---|
| `GET /app/workspaces/:workspace/jobs` | `{ jobs: [{ id, kind, key, status, run_at, attempts, last_error, created, updated, finished }], next_offset }`, newest first. Filters: `status`, `kind`, `limit` (default 50, at most 200), `offset`. |
| `GET /app/workspaces/:workspace/jobs/summary` | `{ statuses: { pending, paused, done, dead }, kinds: [{ kind, pending, paused, done, dead }] }`. |
| `GET /app/workspaces/:workspace/jobs/:job` | One job, with its `payload`: the ids it works on, not copies of rows. |
| `POST /app/workspaces/:workspace/jobs/:job/retry` | Runs a `dead` job again, from no attempts. 409 for a job that is not dead. |

`status` is `pending` (waits to run, or to run again after a failure: then `last_error` is set and `run_at` is the retry), `paused` (its webhook endpoint is disabled), `done` or `dead` (it failed on each attempt). Done jobs are kept 7 days, dead ones 30. `kind` is `webhook.deliver`, `workflow.run`, `decision.automatic` or `case.evaluate`.

## Environments

What an environment holds, and how to work in a sandbox: [Environments](../platform/environments.md). Environment management uses a signed-in session under `/app/workspaces/:workspace`.

| Method | Path | Access | Body / result |
|---|---|---|---|
| GET | `/environments` | Member | `{ environments: [{ id, workspace_id, name, kind, created }] }` |
| GET | `/environments/:environment/copy-options` | Admin | Searchable source items; `category`, `q?`, `offset?`, `limit?` → `{ items: [{ id, label, detail, type }], total }` |
| POST | `/environments` | Admin | `{ name, copy_from?, copy? }`; creates a sandbox and returns it with status 201 |
| PATCH | `/environments/:environment` | Admin | `{ name }`; renames a sandbox |
| DELETE | `/environments/:environment` | Admin | `{ confirm: "Sandbox name" }`; deletes the sandbox and its data |

Each workspace creates Production automatically. Its kind cannot be changed, and it cannot be renamed or deleted independently. Names are unique within a workspace, ignoring case.

Each `copy` category accepts `true` for all, `false` or omission for none, or a selection object. Any enabled category requires `copy_from`, an environment in the same workspace. Empty selection lists copy nothing. Select action names, dashboard IDs, queue IDs, decision IDs, model slugs, individual `{ type, id }` entities, or entity/event types:

```json
{
  "name": "Payment experiment",
  "copy_from": "env_…",
  "copy": {
    "actions": { "ids": ["payment", "withdrawal"] },
    "entities": { "types": ["merchant"], "records": [{ "type": "user", "id": "user_42" }] },
    "events": { "types": ["payment_requested"], "ids": ["event_42"] },
    "dashboards": { "ids": ["dashboard_42"] },
    "decisions": { "ids": ["kdec_42"] },
    "models": { "ids": ["loan-default"] }
  }
}
```

Selections are unions: selected types include all records of those types, plus any individually selected records. Each list is limited to 1,000 entries; use `true` for an entire category. Unknown, stale, foreign, or inaccessible selections return `400 invalid_copy_selection` without creating a sandbox. The options endpoint accepts `category=actions|entity_types|entities|event_types|events|dashboards|queues|decisions|models`, an optional literal text search `q`, and pagination (`offset=0`, `limit=30`, maximum 100). It lists only items in that source environment and hides other people's private dashboards and queues.

Entities includes selected definitions, profiles and properties, labels, and identities discovered from history. Events preserves the selected records' entity, session, and record links. Selected Decisions automatically include only their triggering events and required action versions, preserving context, raw answers, resolutions, and timestamps. Other actions and events follow their explicit selections. Without decision history, selected Actions start at version 1 from their latest definition; with history, their source versions are preserved. Dashboards copies only shared dashboards and the caller's own private dashboards. Queues copies the same way, the setup only: not the cases. Models copies the active models with all their versions, the same version numbers and their files; it is never in the default copy, and archived models are not offered. `{ "copy": {} }` starts empty. For compatibility, omitting `copy` when using `copy_from` copies action and entity definitions only; the older `copy_dashboards` flag can add accessible dashboards in that mode. It cannot be combined with `copy`.

The selected data is copied atomically from one consistent snapshot. Copies are independent; automatic decisions start disabled, and copying history does not execute actions or send webhooks. Keys, webhook endpoints, credentials, and delivery logs are never copied.

API keys select both workspace and environment. For session requests to `/v1`, supply `X-Kairos-Workspace` and `X-Kairos-Environment`. Omit the environment only to select Production for compatibility. A provided environment must belong to the workspace. Keys ignore these headers and always use their own scope.

Session requests to `/app/workspaces/:workspace/keys`, `/webhooks`, `/webhook-deliveries`, and `/jobs` endpoints use `X-Kairos-Environment` with the same Production default. Key creation also accepts `environment_id` in its body, which takes precedence over the header; returned key metadata includes `workspace_id` and `environment_id`. Outgoing webhook messages include `environment_id` beside `workspace_id`.
