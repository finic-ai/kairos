<!-- Generated from templates/events/fraud_claim.json by pnpm docs:events. Edit that file, not this page. -->

# Fraud Claim

A customer says a transaction was not theirs. A claim is one record: filed, then closed with an outcome.

Event type: `fraud_claim`

**A record with stages.** Send every stage with the same `universalId` and its `status`. See [Records that change](../../reference/clients/typescript.md#records-that-change).

## Fields

| Field | Type | Required | Meaning |
|---|---|---|---|
| `userId` | entity `user` | yes | Who filed the claim. |
| `merchantId` | entity `merchant` | no | The merchant or the payee the claim is about. |
| `universalId` | record id | yes | The same id for every stage of this record. Use your own identifier. |
| `status` | string | yes | The stage: `PENDING`, `CONFIRMED`, `ACCOUNT_ABUSE`, `DENIED`. |
| `category` | string | no | What kind of claim. One of `UNAUTHORIZED_CARD`, `ACCOUNT_TAKEOVER`, `SCAM`. |
| `initial_amount_usd` | number | no | The amount claimed. |
| `description` | string | no | The customer's own words. |

A field that ends in `Id` names an entity: the event joins that entity's history, and two subjects that name the same one become linked. Every other field is stored as given. You may add fields of your own.

## Example

```ts
kairos.track("fraud_claim", {
  userId: "user_123",
  universalId: "claim_0300",
  status: "PENDING",
  merchantId: "lumatech_outlet",
  category: "UNAUTHORIZED_CARD",
  initial_amount_usd: 1262.5,
  description: "I still have my card with me. I do not recognise these online purchases.",
});
```

## Stages

When it closes, also put a label on whatever the outcome is about: the customer for account abuse, the merchant for confirmed fraud.

A later stage of the same record:

```ts
kairos.track("fraud_claim", {
  userId: "user_123",
  universalId: "claim_0300",
  status: "CONFIRMED",
});
```

Every stage is stored. A decision sees one record in its latest state, with the statuses it went through.

---

A template is a recommendation. Kairos accepts any event type and any fields, and checks no event against a template. [All templates](../overview.md)
