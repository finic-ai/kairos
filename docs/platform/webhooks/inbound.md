# Inbound webhooks

A provider that you use (a payment processor, an identity provider, a bank) reports what happens by webhook. An inbound webhook lets that provider send its webhooks **directly to Kairos**. Kairos checks each delivery, turns the payload into events and labels, and stores them. You write no code for it.

```
Provider ──POST──▶ /v1/webhooks/whk_…  ──▶ verify ──▶ mapping ──▶ events, labels
                                              │          │
                                              └──────────┴──▶ delivery log
```

- [When to use it](#when-to-use-it)
- [Your user id: the most important part](#your-user-id-the-most-important-part)
- [Templates](#templates)
- [Connect Stripe](#connect-stripe)
- [Connect another provider](#connect-another-provider)
- [The mapping](#the-mapping)
- [Verification](#verification)
- [What Kairos answers, and the delivery log](#what-kairos-answers-and-the-delivery-log)
- [Limits and security](#limits-and-security)
- [The API](#the-api)

## When to use it

| Use | Value |
|---|---|
| **Outcomes from a provider.** A dispute is decided days after the payment, and your code does nothing at that moment. With Stripe connected, a dispute becomes a `chargeback` label on the user who paid. | High. Labels make linked entities meaningful, and they are what thresholds are tuned on. |
| **Events your code does not handle.** A card decline, a finished identity check, a returned transfer. | Medium. You could also forward them with the SDK. |
| **No engineering time.** Your product runs on one provider. | High: it is the only way in. You get history and labels. |

A webhook arrives **after** the fact. It adds history and outcomes; it does not make a decision before an action. For that, your server still calls `decide`.

## Your user id: the most important part

Decisions are about **your** ids (`user_42`). A provider knows **its** ids (`cus_Nf3…`). If the provider's events are stored on `cus_Nf3…`, a decision about `user_42` does not see them. A mapping finds your id in one of three ways, from the best to the last resort:

1. **Your id is in the payload.** Most providers have a metadata field that you fill when you create an object. Put your user id there, and the mapping reads it: `"user": "$.data.object.metadata.user_id"`.
2. **Kairos finds it.** The payload does not name your user, but Kairos already knows the connection:
   - **From a record**: `"user": { "record": "$.data.object.payment_intent" }` is the user on the earlier events of that record. A Stripe refund or dispute names its PaymentIntent, and the payment event of that PaymentIntent named the user.
   - **From a property**: `"user": { "lookup": { "property": "stripe_customer_id", "value": "$.data.object.customer" } }` is the user whose property `stripe_customer_id` is the customer id. You store it on the user once, with `$set` or `PUT /v1/entities/user/:id`. The comparison ignores case. Two users with the same value is ambiguous, and neither is used.
3. **The provider's id as its own entity**: `"stripe_customer": "$.data.object.customer"`. The event is stored and can be found, but no decision about your user reads it.

When a delivery's event has no entity at all, nothing from it is stored, and it waits in the log as **No entity**. Once the connection exists (the payment arrived, the property was set), **Run failed again** stores it.

## Templates

A template is a provider that Kairos already knows: its signature scheme, the steps at the provider, and a mapping written for its payloads. In the console, open **Settings › Webhooks › Inbound webhooks**, choose **Add source › Start from a template**, and pick one. The list is grouped by what the provider does:

| Group | Template | What it sends | Your user id comes from | Verification |
|---|---|---|---|---|
| Device Intelligence | Fingerprint | Each identification as a `device_identified` event on the `user`, `device` and `ip`: confidence, bot, VPN, proxy, Tor, tampering, incognito, virtual machine, emulator, jailbreak, developer tools, IP country and ASN type, and the 24-hour velocity counts. | The `linkedId` you pass to each identification request. Add `tag: { action: "login" }` to say what the person was doing. | `hmac`: `FPJS-Event-Signature`, `v1=` + HMAC-SHA256 hex |
| Identity | Sumsub | An `identity_check` event for each stage of an applicant's check (started, pending, on hold, prechecked, awaiting the user or a service, reset) and for its result (`approved`, `resubmission_requested`, `rejected`), on the `user` and the `sumsub_applicant`. The applicant is the record. Results have the reject type and the reject labels (such as `FORGERY`). Each event sets `kyc_status` and `kyc_level` on the user, so a decision can read them. A final rejection adds the label `kyc_rejected`. Sumsub sends no event id, so the template joins the applicant id, the type and the time (`createdAtMs`) into one. | The `externalUserId` that you give Sumsub when you create the applicant or the SDK access token. | `hmac`: `X-Payload-Digest`, HMAC-SHA256 hex, with the webhook's secret key. Choose SHA256 in the Webhook manager. |
| Payments | Checkout.com | `payment` events (approved, declined, pending, then captured, voided, canceled, expired), `refund`, `dispute_opened` and `dispute_closed`, all stages of the payment's record. Disputes add `chargeback`, then `dispute_won` or `chargeback_lost`, to the user. | `metadata.user_id` on each payment request. Refunds and disputes find the user from the payment. | `hmac`: `Cko-Signature`, HMAC-SHA256 hex |
| Payments | Stripe | See [Connect Stripe](#connect-stripe). | `metadata.user_id` on each PaymentIntent. | `stripe` |
| Commerce | Shopify | An `order` event when an order is created, paid and canceled, on the `user` and the `ip`: amounts, discount code, gateway, billing and shipping country and zip, the customer's account age and email check, the browser, and the cancel reason (such as `fraud`). A `refund`, and `dispute_opened` and `dispute_closed` for Shopify Payments disputes. All are stages of the order's record. A chargeback adds `chargeback`, then `dispute_won` or `chargeback_lost`, to the user. Amounts are in major units, as Shopify sends them: the text `"404.95"` is stored as the number `404.95`. The topic is in a header (`X-Shopify-Topic`), so the rules use `match_headers`. An event's id is made of the topic and Shopify's own id (`orders/paid:5690451296477`), so a retry, and an [import of past orders](#import-past-shopify-orders), store nothing twice. | The Shopify customer id (`customer.id`). Refunds and disputes find the user from the order. A guest checkout has no customer: its order is stored on the IP address, and a dispute of it waits as **No entity**. | `hmac`: `X-Shopify-Hmac-Sha256`, HMAC-SHA256 base64, with the key from **Settings › Notifications › Webhooks** or the app's client secret |
| Customer Support | Intercom | A `support_message` event for each new conversation and each reply from the user, with the text. The conversation is the record. | The `user_id` you give the Intercom Messenger, which Intercom calls the contact's `external_id`. | `hmac`: `X-Hub-Signature`, `sha1=` + HMAC-SHA1 hex, with the app's client secret |
| Customer Support | Zendesk | A `support_ticket` event when a ticket is created and when its status changes, and a `support_message` for each message from the requester (not from agents), with the text. The ticket is the record. A `support_user_linked` event when a Zendesk user is created or their external id changes. | The Zendesk user's `external_id`. When a Zendesk user event arrives, Kairos stores their Zendesk id on your user as `zendesk_user_id`, and later tickets find the user from it. | `timestamped`: `X-Zendesk-Webhook-Signature` (base64) and `X-Zendesk-Webhook-Signature-Timestamp` |
| Transaction Intelligence | Lithic | A `card_transaction` event for each change to a card transaction: status, result, amounts, merchant, MCC, country, how the card was used (present, contactless, e-commerce, wallet), 3-D Secure result and the network's risk score. The transaction is the record. | A lookup: the user whose `lithic_account_token` property is the transaction's `account_token`. Store it on each user once. | `standard` |
| Transaction Intelligence | Marqeta | A `card_transaction` event for each authorization, clearing and reversal, a `refund`, and a `card_dispute` for cardholder chargebacks (with the labels `cardholder_dispute`, then `cardholder_dispute_won` or `cardholder_dispute_lost`). Clearings, reversals and refunds are stages of the authorization's record. Amounts are in major units, as Marqeta sends them. Marqeta sends up to 10 transactions in one delivery; each becomes its own event. | A lookup: the user whose `marqeta_user_token` property is the transaction's `user_token`. | `hmac`: `X-Marqeta-Signature`, HMAC-SHA256 hex (set `signature_algorithm` to `HMAC_SHA256`). Marqeta also sends Basic Auth, which Kairos does not need. |

Each template shows its setup steps when you choose it. The URL to give the provider is shown once, after you add the source.

**A template is a starting point.** The templates are written from each provider's documentation and its example payloads. Until a real delivery from the provider has gone through one, the console says, when you choose it, that it has not yet been checked with a real delivery. After the first deliveries arrive, open them in the delivery log, and change the mapping if a field you need is missing or named differently in your account (providers change payloads by API version).

The template is a copy: you can change the source's mapping, and a newer version of the template does not change your source.

## Connect Stripe

In the console, open **Settings › Webhooks › Inbound webhooks** and choose **Add source › Start from a template › Stripe**.

1. Paste the endpoint's signing secret (`whsec_…`) and add the source. Kairos shows the source's URL **once**. Copy it.
2. In Stripe, open **Developers › Webhooks** and add an endpoint with that URL. Select these events: `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.processing`, `payment_intent.canceled`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.closed`.
3. Put your user id in the metadata of each PaymentIntent you create: `metadata: { user_id: "user_42" }`.

What each Stripe event becomes:

| Stripe event | Kairos event | Record status | Label |
|---|---|---|---|
| `payment_intent.succeeded` | `payment` on the user and `stripe_customer` | `completed` | |
| `payment_intent.payment_failed` | `payment`, with `decline_code` and `failure_code` | `failed` | |
| `payment_intent.processing` / `.canceled` | `payment` | `pending` / `canceled` | |
| `charge.refunded` | `refund`, with `amount_refunded_minor` | `refunded` | |
| `charge.dispute.created` | `dispute_opened`, with `reason` | `disputed` | `chargeback` |
| `charge.dispute.closed` | `dispute_closed` | `dispute_won` / `dispute_lost`, else `dispute_closed` | `dispute_won` / `chargeback_lost`, else `dispute_closed` |

All of them are stages of one record: the PaymentIntent (`GET /v1/records/pi_…`). Refunds and disputes find their user from it (way 2 above). Amounts are in minor units, as Stripe sends them: `amount_minor: 9500` is $95.00. Kairos does not divide by 100, because that is wrong for a currency with no minor unit, such as JPY.

## Import past Shopify orders

A webhook sends only what happens after it is connected. A Shopify source can also import the shop's past orders, refunds and Shopify Payments disputes, so that the first decisions have history to read.

1. In the Shopify Dev Dashboard, make an app in the same organization as the shop, with the scopes `read_orders`, `read_all_orders`, `read_customers` and `read_shopify_payments_disputes`. Install it on the shop. Without `read_all_orders`, Shopify gives only the last 60 days of orders.
2. On the source's page, under **Past orders**, choose **Connect shop**, and paste the shop's domain (`example-store.myshopify.com`), the app's client ID and its client secret. Kairos checks them with Shopify, and says which scope is missing. A custom app made in the Shopify admin, before Shopify stopped them, works too: paste its Admin API access token.
3. Choose how far back, from 1 to 24 months, and **Import**. The import runs in the background; the page shows how many orders and disputes it has read.

Each order becomes the webhooks that Shopify would have sent, at the times they happened: created, paid, canceled, and one for each refund. Each dispute becomes opened, and closed when it is over. They go through the source's mapping, as a delivery does, so the events and labels are the same as the webhook's. Because an event's id is made from Shopify's ids, an order that the webhook sent already is not stored twice, and you can run the import again at any time.

Some things are different from a webhook:

- **The status is the order's status now.** An imported order's `financial_status` and `fulfillment_status` are what they are today, not what they were at each step.
- **No browser.** Shopify's API does not give the user agent or the language of the browser, so `user_agent` and `accept_language` are empty. The IP address is there.
- **A dispute of an older order** waits as **No entity**, as from a webhook, when its order is from before the import. Import from further back and choose **Run failed again**.
- **No decisions.** An import makes no decision, as with [an import of your history](../../getting-started/import-history.md).
- Kairos only reads the shop. **Disconnect** forgets the credentials.

## Connect another provider

Choose **Add source › Start from scratch**. Give the source a name, choose how deliveries are signed ([Verification](#verification)), and paste the signing secret. The source starts with a simple mapping. On its page:

1. Paste a sample payload from the provider's documentation, or take one from a recent delivery. A delivery from the log comes with its headers (without the signature). For a mapping that reads or matches a header, put the headers in **Request headers**.
2. Change the rules. Click a value in the sample to put its path in the field you used last.
3. The **Result on the sample** shows what the server would store, exactly: the same engine runs in the browser and on the server.
4. **Save mapping.** Deliveries that failed before can then run again.

**Edit as JSON** shows the whole mapping, for what the form does not show (a lookup table on a value, `set`, `properties.all`), or to copy a mapping between sources.

## The mapping

A mapping is a list of rules. Every delivery is tried against every rule, in order. **Each rule that matches runs**, so one delivery can make several events.

```json
{
  "rules": [
    {
      "name": "Payment",
      "match": { "type": ["payment.succeeded", "payment.failed"] },
      "event": {
        "id": "$.id",
        "type": "payment",
        "ts": { "path": "$.created", "format": "unix_seconds" },
        "entities": { "user": "$.data.metadata.user_id" },
        "universal_id": "$.data.id",
        "status": { "path": "$.type", "values": { "payment.succeeded": "completed", "payment.failed": "failed" } },
        "properties": { "amount_minor": "$.data.amount", "currency": "$.data.currency" }
      }
    },
    {
      "name": "Dispute",
      "match": { "type": "dispute.created" },
      "event": { "id": "$.id", "type": "dispute_opened", "entities": { "user": { "record": "$.data.payment_id" } } },
      "label": { "entity": "user", "label": "chargeback" }
    }
  ],
  "unmatched": "ignore"
}
```

### Values

A value in a mapping is one of these:

| Form | Meaning |
|---|---|
| `"$.data.id"` | A path into the payload. A text that starts with `$.` or `$[` is always a path. |
| `"payment"`, `5`, `true` | A constant. |
| `{ "path": "$.created", "format": "unix_seconds" }` | A path with a transform (below). |
| `{ "join": ["$.applicantId", "$.type", "$.createdAtMs"] }` | Values joined as text, with `:` between them (`"with"` changes it). For a provider that sends no single id. A part with no value gives no value. |

**Paths:** `$` is the payload; `.name`, `["a name"]` and `[0]` go into it, and `[-1]` is the last element of a list. Inside `items`, `$$` is the element. There are no wildcards and no filters. A path that finds nothing gives no value.

**Transforms**, on `{ "path": … }`:

| Key | Does |
|---|---|
| `format` | For a time: `iso` (default), `unix_seconds`, `unix_ms`. An `iso` time with no zone, such as `2026-04-30 08:04:23.379`, is UTC. `number`: a decimal that the provider sends as text (`"404.95"` → `404.95`), so that a condition can compare it. A value that is not a decimal gives no value. |
| `values` | A lookup table: the value found → the value stored. A value not in the table is kept, unless `default` is set. |
| `default` | The value when the path finds nothing (or a value not in `values`). |
| `headers` | `true` reads the path in the request headers: `{ "path": "$.x-event-type", "headers": true }`. |

### A rule

| Field | | |
|---|---|---|
| `name` | | For people, and in the log. |
| `match` | | Field (without `$.`, or a path such as `$$.type` inside `items`) → a value or a list of values. All must hold. No `match`: every delivery. |
| `match_headers` | | Header name → a value or a list of values, as `match`. The case of the name does not matter. For a provider that sends the event type in a header: `{ "x-shopify-topic": ["orders/create", "orders/paid"] }`. With `match`, both must hold. |
| `items` | | A path to a list. The rule runs once for each element (at most 500), which is `$$`. For providers that send a batch. |
| `event.id` | necessary | The provider's id. Stored as `<source id>:<id>`, so a retry stores nothing twice. |
| `event.type` | necessary | A name such as `payment`, or a path. |
| `event.ts` | | Default: when the delivery arrived. |
| `event.entities` | necessary | Type → value, or a lookup (`{ "record": … }`, `{ "lookup": { "property": …, "value": … } }`). An entity with no value is left out. |
| `event.properties` | | Name → value. Or `{ "all": "$.data", "except": ["secret"] }`: every simple field of an object. |
| `event.universal_id`, `event.status`, `event.session` | | As on an event from the SDK. A provider object that changes state is a record. |
| `event.set`, `event.set_once` | | Type → properties to put on that entity. Only for a source that verifies a signature (`hmac`, `timestamped`, `standard`, `stripe`). |
| `label` | | `{ entity, label, id?, ts?, properties? }`. `entity` is one of the event's types; with `id` (a value or a lookup), it can be any entity, and the rule needs no event. |
| `unmatched` | | On the mapping: `"ignore"` (default) or `"fail"` when no rule matches. |

**When a rule that matched fails** (no id, a time that cannot be read, no entity), nothing from that delivery is stored. Correct the mapping and run it again: the whole delivery then goes in at once.

## Verification

A provider cannot send your API key. A delivery is accepted on two things: the secret token in its URL, and the provider's signature over the body.

| Scheme | How | For |
|---|---|---|
| `hmac` | An HMAC of the raw body in a header. You choose the header, the algorithm (`sha256`, `sha1`, `sha512`), the encoding (`hex`, `base64`) and an optional prefix (`sha256=`). A header with a list (`v1=…,v1=…`) is accepted when one of them matches. | Fingerprint, Checkout.com, Shopify, Intercom, Marqeta, Unit, Onfido, Sumsub, and most others |
| `timestamped` | An HMAC of a time and the raw body, and the time must be within 5 minutes (`tolerance`, in seconds, changes it). The time is either inside the signature header, as `t=<time>,v1=<signature>` (you can change the keys with `timestampKey` and `signatureKey`), or in a header of its own (`timestampHeader`). The signed text is `<time><join><body>`, where `join` is `.` by default. The time may be Unix seconds or ISO 8601. | Persona (`Persona-Signature`), Zendesk (`timestampHeader: X-Zendesk-Webhook-Signature-Timestamp`, `join: ""`, `encoding: base64`) |
| `standard` | [Standard Webhooks](https://www.standardwebhooks.com): the `webhook-id`, `webhook-timestamp` and `webhook-signature` headers (or the same with `svix-`), and a `whsec_…` secret. | Lithic, Sardine, and any provider that sends through Svix |
| `stripe` | The `timestamped` scheme as Stripe sends it: the `Stripe-Signature` header, HMAC-SHA256 of `<t>.<body>`. | Stripe |
| `header` | A fixed secret value in a header. | Providers that send a static token |
| `none` | The URL token only. Anyone with the URL can send events, and the source cannot set entity properties. | A provider that signs nothing |

- The signature is checked on the **raw bytes** of the body, in constant time.
- A source can hold **two secrets** while a provider rotates: **Add second**, then **Replace** when the provider uses only the new one.
- The secret is stored encrypted, because Kairos must use it to compute the signature.
- **New URL** makes a new token and stops the old URL at once, for a URL that leaked.

## What Kairos answers, and the delivery log

Kairos answers after the events are stored. Once a delivery is verified and read, it answers 200, even when the mapping fails:

| Situation | Answer | In the log |
|---|---|---|
| Stored | 200 | Stored |
| The same delivery again | 200 | Duplicate |
| No rule matched | 200 | Ignored |
| A rule matched and failed | 200 | Failed, with the reason |
| An event has no entity | 200 | No entity, with what was not found |
| The signature is wrong or missing | 401 | Rejected |
| The body is not JSON / is larger than 1 MB | 400 / 413 | Rejected |
| The URL is unknown, or the source is disabled | 404 | not recorded |
| The server cannot read the secret (key missing or changed) | 503 | Failed |

A mapping problem answers 200 on purpose: the provider's retry would send the same payload to the same mapping, and many providers turn off an endpoint that fails too often. Correct the mapping and use **Run failed again** (failed and no-entity deliveries) or **Run again** on one delivery. A replay uses the same event ids, so what was stored already is not stored twice.

The log keeps each delivery, without the signature headers. The **payload is kept 7 days** and then removed; the row stays. A rejected delivery keeps no payload: it did not prove where it came from.

A new label from a webhook, such as a chargeback, also goes to your [outbound webhooks](outbound.md) as `label.created`.

## Limits and security

| | |
|---|---|
| Body | 1 MB |
| Rules in a mapping | 50 |
| Elements of `items` | 500 |
| Events from one delivery | 500 |
| Sources in an environment | 50 |
| Payload kept | 256 KB, 7 days |

- **A source can write events and labels, and nothing else.** It cannot read, decide, or change a definition.
- **The URL token is a secret.** It appears in the access logs of proxies, which is why a signature scheme is better than `none`.
- Only owners and admins can see and change sources. The token is shown once; secrets are never shown again, only a hint.

## The API

The console does all of this. The same calls, for a script (a session cookie and the admin role, under `/app/workspaces/:workspace`):

```bash
# The presets (a secret key or a session)
curl -s https://kairos.finic.ai/v1/webhook-presets -H "Authorization: Bearer $KAIROS_API_KEY"
```

| | |
|---|---|
| `POST /v1/webhooks/:token` | A delivery from the provider. No API key. |
| `GET /v1/webhook-presets` | The templates: the providers that Kairos knows, with their `category`, `checked` (whether a real delivery has gone through it), mapping, setup steps and sample payloads. |
| `POST …/webhooks` | `{ "direction": "in", name, verification, secret?, mapping, preset? }`. Returns `{ webhook, token, path }`. The only time the token is returned. |
| `GET …/webhooks?direction=in` | The sources, with deliveries and failures in the last 24 hours. |
| `PATCH …/webhooks/:id` | `name`, `verification`, `mapping`, `enabled`, `secret` (replaces), `add_secret` (adds a second). For a Shopify source, `shopify`: `{ shop, client_id, client_secret }` or `{ shop, token }` to connect the shop, `null` to disconnect it. |
| `POST …/webhooks/:id/backfill` | A Shopify source: `{ "since": "2026-05-09" }` imports the shop's orders and disputes since then. |
| `GET …/webhooks/:id/backfill` | The last import: `status` (`running`, `paused`, `done`, `failed`), the orders and disputes read, and how many were stored, there already, or failed. |
| `POST …/webhooks/:id/token` | A new URL. The old one stops at once. |
| `GET …/webhooks/:id/deliveries` | The log, newest first; `?status=failed` and the others. |
| `GET …/webhooks/:id/deliveries/:delivery` | One delivery, with its payload and what it stored. |
| `POST …/webhooks/:id/replay` | `{ "delivery": "whd_…" }` or `{ "status": "failed" }`. |
| `POST …/webhooks/preview` | `{ mapping, body, headers? }` → what the mapping gives. Stores nothing. |
| `DELETE …/webhooks/:id` | Delete the source and its log. The events it stored stay. |

The engine is also in `@kairos/core`: `applyMapping(mapping, { body, headers }, receivedAt)` and `validateMapping(mapping)`, for a test of your own mapping.
