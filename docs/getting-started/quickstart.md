# Quickstart

This page takes you from a new account to a first decision, in about ten minutes.

## 1. Create an account and a key

1. Sign up at [kairos.finic.ai](https://kairos.finic.ai).
2. Go to **Settings › API keys** and choose **Create key**. Pick **Secret**.
3. Copy the key. It starts with `ksk_`, and it is shown once. Keep it on your server, for example as `KAIROS_API_KEY`.

The console also has a **Get started** page that walks through these steps and gives you a prompt for a coding agent.

## 2. Install the SDK

```bash
npm install @finic-ai/kairos
```

```bash
pip install kairos-sdk
```

Or use any HTTP client: the [API reference](../reference/api.md) has every endpoint.

## 3. Say what you want decided

An **action** is a decision in plain language: what it is about (its subject) and a yes-or-no question. Define it once, at startup or from a script.

```ts
import { Kairos } from "@finic-ai/kairos";

const kairos = new Kairos({ apiKey: process.env.KAIROS_API_KEY! });

await kairos.defineAction("withdrawal", {
  subject: "user",
  hold: "Should this withdrawal be held because the account shows signs of fraud or takeover?",
});
```

```python
import os
from kairos import Kairos

kairos = Kairos(os.environ["KAIROS_API_KEY"])

kairos.define_action("withdrawal", {
    "subject": "user",
    "hold": "Should this withdrawal be held because the account shows signs of fraud or takeover?",
})
```

## 4. Record what happens

Send events as they happen. A field that ends in `Id` (`user_id` in Python) names an entity: here, the user and their device.

```ts
kairos.track("login", { userId: "user_42", deviceId: "dev_9", ipCountry: "GB" });
```

```python
kairos.track("login", {"user_id": "user_42", "device_id": "dev_9", "ip_country": "GB"})
```

`track` returns at once and sends in the background. To load the history you already have, see [Import your history](import-history.md).

## 5. Ask at the moment of action

```ts
const decision = await kairos.decide({ type: "withdrawal", userId: "user_42", usd: 900 }, { fallback: "review" });
if (decision.decision !== "approve") {
  // hold it: decision.riskScore, decision.reasons
}
```

```python
decision = kairos.decide("withdrawal", {"user_id": "user_42", "usd": 900}, fallback="review")
if decision.decision != "approve":
    ...  # hold it: decision.risk_score, decision.reasons
```

The answer is `approve`, `step_up`, `review` or `block`, with a risk score and the signals behind it. With a `fallback`, `decide` always answers: when Kairos cannot be reached or fails, you get the fallback outcome, marked `fallback: true`.

With curl:

```bash
curl -X PUT https://kairos.finic.ai/v1/actions/withdrawal \
  -H "Authorization: Bearer $KAIROS_API_KEY" -H "Content-Type: application/json" \
  -d '{ "subject": "user", "hold": "Should this withdrawal be held because the account shows signs of fraud or takeover?" }'

curl -X POST https://kairos.finic.ai/v1/decide \
  -H "Authorization: Bearer $KAIROS_API_KEY" -H "Content-Type: application/json" \
  -d '{ "action": "withdrawal", "entities": { "user": "user_42" }, "properties": { "usd": 900 } }'
```

## 6. See why

Open **Decisions** in the console. Each decision opens to what the model was shown, what it answered, and the policy that made the outcome.

## Next

- [Core concepts](../concepts/core-concepts.md): entities, events, labels, actions and policies.
- [TypeScript SDK](../reference/clients/typescript.md) or [Python SDK](../reference/clients/python.md): every call.
- [Environments](../platform/environments.md): try a change in a sandbox before production.
- [Templates](../templates/overview.md): actions and event shapes to copy.
