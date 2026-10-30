# Outbound webhooks

An outbound webhook tells your system what Kairos did, as it happens: a decision was made or changed, a label was added, a case was opened or closed. Kairos sends each message as a signed `POST` to a URL of yours, and sends it again until your endpoint accepts it.

For messages that a provider sends **to** Kairos, see [Inbound webhooks](inbound.md).

## Add an endpoint

An owner or an admin opens **Settings › Webhooks › Outbound webhooks** and chooses **Add endpoint**:

| Field | |
|---|---|
| Name | For you. |
| URL | `https://` and an address on the internet. A private or local address is refused. |
| Events | One or more of the types below. |
| Filters | Optional. Only the messages that match are sent. |
| Include the request's properties | Whether `data.properties` is in a decision message. On by default. Turn it off when the request has data that the receiver must not get. |

Kairos then shows the endpoint's **signing secret**, `whsec_…`. Keep it with the receiver. **Test**, on the endpoint's page, sends a `webhook.test` message now, so that you can check the receiver before real traffic. A test is not retried.

An endpoint belongs to one [environment](../environments.md). A sandbox has no endpoints until you add them: copying an environment never copies them.

## Events

| Type | When | `data` |
|---|---|---|
| `decision.created` | Kairos made a decision, from `decide` or an automatic decision. | The decision |
| `decision.updated` | A person resolved the decision, or a case resolved it. | The decision, as it is now |
| `label.created` | A label was added to an entity, from the API, a case or an inbound webhook. | The entity, the label, and its recent decisions |
| `case.created` | A queue opened a case. | The case |
| `case.assigned` | A case was assigned, reassigned or unassigned. | The case |
| `case.resolved` | A case was resolved. | The case |
| `case.reopened` | A resolved case was opened again. | The case |

### Filters

| Filter | For | Sends only |
|---|---|---|
| `actions` | `decision.*` | Decisions of these actions, in every version |
| `outcomes` | `decision.*` | These outcomes: `approve`, `step_up`, `review`, `block`. After a resolution, the person's outcome counts. |
| `min_risk_score` | `decision.*` | A risk score of at least this, 0 to 100 |
| `labels` | `label.created` | These labels, such as `chargeback` |
| `queues` | `case.*` | Cases of these queues |

## The message

```json
{
  "id": "msg_01JD…",
  "type": "decision.created",
  "version": 1,
  "workspace_id": "ws_…",
  "environment_id": "env_…",
  "created_at": "2026-10-29T14:00:00.000Z",
  "data": {
    "decision_id": "kdec_8cd38292942f4c4084d42bc960404c8f",
    "revision": 1,
    "decided_at": "2026-10-29T14:00:00.000Z",
    "action": "bank_transfer@2",
    "subject": { "type": "user", "id": "user_42" },
    "entities": { "user": "user_42", "payee": "payee_new" },
    "properties": { "amount": 2400, "currency": "GBP" },
    "decision": "block",
    "risk_score": 98,
    "probability": 0.977,
    "reasons": ["new_account", "new_beneficiary"],
    "typology": "mule",
    "rules": [],
    "resolution": null,
    "final_outcome": "block",
    "automatic": false
  }
}
```

A decision message holds the whole decision as it is now, so the latest message alone is enough. `final_outcome` is the person's resolution when there is one, otherwise the model's outcome. Messages can arrive out of order: keep the one with the highest `revision` for each `decision_id`.

A `label.created` message has `entity`, `label`, `labelled_at`, `properties` and `recent_decisions`. A `case.*` message has the case as [`GET /v1/queues/:id/cases`](../../reference/api.md#queues-and-cases) lists it, with `case_id` and `queue_id`.

## Check the signature

Each request has the headers of [Standard Webhooks](https://www.standardwebhooks.com), so any library for that scheme can check it:

| Header | |
|---|---|
| `webhook-id` | The id of the message. The same in each attempt of one message. |
| `webhook-timestamp` | When this attempt was sent, in seconds since 1970. |
| `webhook-signature` | `v1,` and a base64 HMAC-SHA256 of `{id}.{timestamp}.{body}`. Two, separated by a space, during a rotation. |

The SDKs check it for you. Pass the body exactly as it arrived, before any JSON parsing:

```ts
import { verifyWebhook } from "@finic-ai/kairos";

app.post("/kairos/webhooks", express.raw({ type: "application/json" }), async (req, res) => {
  const message = await verifyWebhook(req.body.toString("utf8"), req.headers, process.env.KAIROS_WEBHOOK_SECRET!);
  if (message.type === "decision.updated") await applyResolution(message.data);
  res.sendStatus(204);
});
```

```python
from kairos import verify_webhook

message = verify_webhook(body, headers, os.environ["KAIROS_WEBHOOK_SECRET"])
```

A delivery with no matching signature, or with a `webhook-timestamp` more than 5 minutes from now, is refused with `KairosWebhookError`.

## Delivery and retries

Your endpoint must answer with a `2xx` status within 10 seconds. Any other answer, a redirect, a time-out or a refused connection is a failure.

After a failure, Kairos tries again after 5 seconds, 5 minutes, 30 minutes, 2 hours, 5 hours, 10 hours and 10 hours: eight attempts in about 27 hours, each wait with ±10% spread. The same message can arrive more than once: use `webhook-id` to drop a repeat.

- An endpoint that answers `410 Gone` is disabled at once.
- An endpoint whose every delivery failed for 5 days is disabled.
- A disabled endpoint keeps its waiting messages. Enable it again, and they are sent.

The endpoint's page has the **delivery log**: each message with its attempts, the status and the time of each answer, and the first 4 KB of the answer body. **Resend**, on a delivery, sends that message again, and **Resend all failed** sends every failed one. A resent message keeps its `webhook-id`. The log is kept 30 days, and the message bodies 7 days.

## Rotate the secret

**Rotate secret** makes a new secret. For 24 hours, Kairos signs with both the old and the new one, so the receiver can change over with no failed delivery: pass both to `verifyWebhook` in that time. **Stop old secret now** ends the overlap at once: when the receiver uses the new secret, or at once when the old one leaked.

The endpoints are in the [API reference](../../reference/api.md#webhooks).
