<!-- Generated from templates/events/beneficiary_added.json by pnpm docs:events. Edit that file, not this page. -->

# Beneficiary Added

A payee, a beneficiary or a withdrawal address was added. "Added recently" is one of the most useful signals, and it needs this date.

Event type: `beneficiary_added`

## Fields

| Field | Type | Required | Meaning |
|---|---|---|---|
| `userId` | entity `user` | yes | Who added it. |
| `beneficiaryId` | entity `beneficiary` | yes | What was added. Use the entity type you use in payments: beneficiary, payee, destination. |
| `deviceId` | entity `device` | no | The device it was added from. |
| `label` | string | no | The name the customer gave it. |

A field that ends in `Id` names an entity: the event joins that entity's history, and two subjects that name the same one become linked. Every other field is stored as given. You may add fields of your own.

## Example

```ts
kairos.track("beneficiary_added", {
  userId: "user_123",
  beneficiaryId: "ben_77",
  deviceId: "dev_9",
  label: "landlord",
});
```

---

A template is a recommendation. Kairos accepts any event type and any fields, and checks no event against a template. [All templates](../overview.md)
