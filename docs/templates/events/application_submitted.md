<!-- Generated from templates/events/application_submitted.json by pnpm docs:events. Edit that file, not this page. -->

# Application Submitted

An application was completed: for an account, a loan, a merchant account.

Event type: `application_submitted`

## Fields

| Field | Type | Required | Meaning |
|---|---|---|---|
| `merchantId` | entity `merchant` | yes | The applicant. Use your own subject type: merchant, user, business. |
| `deviceId` | entity `device` | no | The device the form was filled in on. |
| `ipId` | entity `ip` | no | The IP address it came from. |
| `minutes_to_complete` | number | no | How long the form took. |
| `pasted_fields` | number | no | How many fields were pasted and not typed. |

A field that ends in `Id` names an entity: the event joins that entity's history, and two subjects that name the same one become linked. Every other field is stored as given. You may add fields of your own.

## Example

```ts
kairos.track("application_submitted", {
  merchantId: "mer_0155",
  deviceId: "dev_0121",
  ipId: "185.220.219.66",
  minutes_to_complete: 4,
  pasted_fields: 11,
});
```

---

A template is a recommendation. Kairos accepts any event type and any fields, and checks no event against a template. [All templates](../overview.md)
