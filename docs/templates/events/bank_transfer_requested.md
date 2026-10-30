<!-- Generated from templates/events/bank_transfer_requested.json by pnpm docs:events. Edit that file, not this page. -->

# Bank Transfer Requested

A request that needs a decision. Send it with trackAndDecide: the event is stored and decided in one call, by the action that has this event as its trigger.

Event type: `bank_transfer_requested`

**Starts a decision.** Send it with `trackAndDecide`, and give an action this event as its `trigger`. See [Decide from an event](../../reference/clients/typescript.md#decide-from-an-event).

## Fields

| Field | Type | Required | Meaning |
|---|---|---|---|
| `userId` | entity `user` | yes | Who asked. |
| `beneficiaryId` | entity `beneficiary` | no | Where the money goes. |
| `deviceId` | entity `device` | no | The device the request came from. |
| `amount` | number | no | The amount. |
| `currency` | string | no | Three-letter currency code. |

A field that ends in `Id` names an entity: the event joins that entity's history, and two subjects that name the same one become linked. Every other field is stored as given. You may add fields of your own.

## Example

```ts
const decision = await kairos.trackAndDecide("bank_transfer_requested", {
  userId: "user_123",
  beneficiaryId: "ben_77",
  deviceId: "dev_9",
  amount: 9500,
  currency: "USD",
});
```

---

A template is a recommendation. Kairos accepts any event type and any fields, and checks no event against a template. [All templates](../overview.md)
