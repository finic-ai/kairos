<!-- Generated from templates/events/contact_changed.json by pnpm docs:events. Edit that file, not this page. -->

# Contact Changed

A phone number or an email address on the account was changed.

Event type: `contact_changed`

## Fields

| Field | Type | Required | Meaning |
|---|---|---|---|
| `userId` | entity `user` | yes | Whose contact details. |
| `deviceId` | entity `device` | no | The device the change came from. |
| `what` | string | no | Which detail changed. One of `phone`, `email`. |

A field that ends in `Id` names an entity: the event joins that entity's history, and two subjects that name the same one become linked. Every other field is stored as given. You may add fields of your own.

## Example

```ts
kairos.track("contact_changed", {
  userId: "user_123",
  deviceId: "dev_41",
  what: "phone",
});
```

---

A template is a recommendation. Kairos accepts any event type and any fields, and checks no event against a template. [All templates](../overview.md)
