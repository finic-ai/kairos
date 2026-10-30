<!-- Generated from templates/events/login.json by pnpm docs:events. Edit that file, not this page. -->

# Login

A user signed in.

Event type: `login`

## Fields

| Field | Type | Required | Meaning |
|---|---|---|---|
| `userId` | entity `user` | yes | Who signed in. |
| `deviceId` | entity `device` | no | The device used. A new device is visible only against a history that names the usual one. |
| `ipId` | entity `ip` | no | The IP address of the session. |
| `ip_country` | string | no | Country of the IP address, as a two-letter code. |
| `ip_city` | string | no | City of the IP address. |
| `method` | string | no | How the user signed in. One of `password`, `passkey`, `sso`, `magic_link`. |

A field that ends in `Id` names an entity: the event joins that entity's history, and two subjects that name the same one become linked. Every other field is stored as given. You may add fields of your own.

## Example

```ts
kairos.track("login", {
  userId: "user_123",
  deviceId: "dev_9",
  ipId: "203.0.113.7",
  ip_country: "GB",
  ip_city: "Leeds",
  method: "password",
});
```

---

A template is a recommendation. Kairos accepts any event type and any fields, and checks no event against a template. [All templates](../overview.md)
