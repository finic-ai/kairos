<!-- Generated from templates/events/transaction.json by pnpm docs:events. Edit that file, not this page. -->

# Transaction

Money moved, or is about to. One transaction is one record: send every stage with the same universalId.

Event type: `transaction`

**A record with stages.** Send every stage with the same `universalId` and its `status`. See [Records that change](../../reference/clients/typescript.md#records-that-change).

## Fields

| Field | Type | Required | Meaning |
|---|---|---|---|
| `userId` | entity `user` | yes | Whose money. |
| `payeeId` | entity `payee` | no | The other side, as an entity: a payee, a merchant, a destination address. This is what links two customers who pay the same account. |
| `deviceId` | entity `device` | no | The device the transaction was made from. |
| `universalId` | record id | yes | The same id for every stage of this record. Use your own identifier. |
| `status` | string | yes | The stage: `pending`, `completed`, `returned`, `disputed`. |
| `direction` | string | no | Whether money came in or went out. One of `in`, `out`. |
| `amount` | number | no | The amount, in one unit throughout. Do not mix cents and whole units. |
| `currency` | string | no | Three-letter currency code. |
| `channel` | string | no | How it was made. One of `card_present`, `online`, `bank_transfer`, `p2p`, `atm`, `wire`. |
| `memo` | string | no | Free text from the customer. Send it as written. |

A field that ends in `Id` names an entity: the event joins that entity's history, and two subjects that name the same one become linked. Every other field is stored as given. You may add fields of your own.

## Example

```ts
kairos.track("transaction", {
  userId: "user_123",
  universalId: "txn_8812",
  status: "pending",
  direction: "out",
  amount: 500,
  currency: "USD",
  payeeId: "payee_31",
  channel: "p2p",
  memo: "rent",
});
```

## Stages

A later stage needs only what changed.

A later stage of the same record:

```ts
kairos.track("transaction", {
  userId: "user_123",
  universalId: "txn_8812",
  status: "completed",
});
```

Every stage is stored. A decision sees one record in its latest state, with the statuses it went through.

---

A template is a recommendation. Kairos accepts any event type and any fields, and checks no event against a template. [All templates](../overview.md)
