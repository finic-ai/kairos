<!-- Generated from templates/events/password_reset.json by pnpm docs:events. Edit that file, not this page. -->

# Password Reset

A password was reset. Send one event type per kind of credential change; they are rare, so they are kept in full however old they are.

Event type: `password_reset`

## Fields

| Field | Type | Required | Meaning |
|---|---|---|---|
| `userId` | entity `user` | yes | Whose password. |
| `deviceId` | entity `device` | no | The device the reset came from. |
| `ipId` | entity `ip` | no | The IP address the reset came from. |
| `ip_country` | string | no | Country of the IP address. |
| `channel` | string | no | How the reset was confirmed. One of `email`, `sms`, `support`. |

A field that ends in `Id` names an entity: the event joins that entity's history, and two subjects that name the same one become linked. Every other field is stored as given. You may add fields of your own.

## Example

```ts
kairos.track("password_reset", {
  userId: "user_123",
  deviceId: "dev_41",
  ipId: "198.51.100.20",
  ip_country: "RO",
  channel: "email",
});
```

---

A template is a recommendation. Kairos accepts any event type and any fields, and checks no event against a template. [All templates](../overview.md)
