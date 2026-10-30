<!-- Generated from templates/events/support_message.json by pnpm docs:events. Edit that file, not this page. -->

# Support Message

Something the customer wrote. Send the text as it is: do not summarise it or reduce it to a category.

Event type: `support_message`

## Fields

| Field | Type | Required | Meaning |
|---|---|---|---|
| `userId` | entity `user` | yes | Who wrote it. |
| `text` | string | no | The message. |
| `channel` | string | no | Where it was written. One of `chat`, `email`, `phone_note`. |

A field that ends in `Id` names an entity: the event joins that entity's history, and two subjects that name the same one become linked. Every other field is stored as given. You may add fields of your own.

## Example

```ts
kairos.track("support_message", {
  userId: "user_123",
  text: "I am flying to Lisbon on Friday for two weeks. Will my card work there?",
  channel: "chat",
});
```

---

A template is a recommendation. Kairos accepts any event type and any fields, and checks no event against a template. [All templates](../overview.md)
