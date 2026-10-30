<!-- Generated from templates/events/account_opened.json by pnpm docs:events. Edit that file, not this page. -->

# Account Opened

A new account was opened.

Event type: `account_opened`

## Fields

| Field | Type | Required | Meaning |
|---|---|---|---|
| `userId` | entity `user` | yes | The new customer. |
| `deviceId` | entity `device` | no | The device used to sign up. |
| `ipId` | entity `ip` | no | The IP address used to sign up. |
| `channel` | string | no | Where the customer signed up. One of `mobile_app`, `web`, `branch`, `partner`. |
| `product` | string | no | What was opened. |

A field that ends in `Id` names an entity: the event joins that entity's history, and two subjects that name the same one become linked. Every other field is stored as given. You may add fields of your own.

## Example

```ts
kairos.track("account_opened", {
  userId: "user_123",
  deviceId: "dev_9",
  ipId: "203.0.113.7",
  channel: "mobile_app",
  product: "checking",
});
```

---

A template is a recommendation. Kairos accepts any event type and any fields, and checks no event against a template. [All templates](../overview.md)
