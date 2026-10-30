<!-- Generated from templates/events/login_failed.json by pnpm docs:events. Edit that file, not this page. -->

# Login Failed

A sign-in attempt that did not succeed.

Event type: `login_failed`

## Fields

| Field | Type | Required | Meaning |
|---|---|---|---|
| `userId` | entity `user` | yes | The account that was tried. |
| `deviceId` | entity `device` | no | The device used. |
| `ipId` | entity `ip` | no | The IP address of the attempt. |
| `ip_country` | string | no | Country of the IP address. |
| `reason` | string | no | Why it failed. One of `wrong_password`, `wrong_code`, `locked`. |

A field that ends in `Id` names an entity: the event joins that entity's history, and two subjects that name the same one become linked. Every other field is stored as given. You may add fields of your own.

## Example

```ts
kairos.track("login_failed", {
  userId: "user_123",
  deviceId: "dev_41",
  ipId: "198.51.100.20",
  ip_country: "RO",
  reason: "wrong_password",
});
```

---

A template is a recommendation. Kairos accepts any event type and any fields, and checks no event against a template. [All templates](../overview.md)
