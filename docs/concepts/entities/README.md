# Entities

An entity is anything you want a history for: a user, a device, a payee, a merchant, an IP address. It has a **type** and an **id**, such as `user/user_42` or `device/dev_9`. You choose the types.

An entity exists as soon as an [event](../events.md) names it. You do not create entities first, and you do not need to define their types: start by sending events, and add definitions when you want them.

Entities do three things in a decision:

- **The subject** is the entity a decision is about. Its history is what the model reads.
- **Its properties** are what is known about it now, such as `kyc_country` or `plan`.
- **Shared entities make [links](../links.md).** Two users who use the same device or pay the same payee are linked, and a decision is told how concentrated and how risky that sharing is.

## Choose the types

Ask what could connect two customers. A device, a bank account, a payee, an owner, an IP address, an ATM. If two users naming the same value would tell you something, make it an entity.

- **A per-event id is not an entity.** A transaction id or a request id would become an entity with one event. Send it under a name that does not end in `Id`, such as `reference`, or as the [`universal_id`](../events.md#records-that-change) of a record.
- **Some types should never link**, such as a popular merchant or a country. Set `link: false` on the type.
- **Use one type for one kind of thing** across your products, with the same ids, so that their histories meet.

## Name entities in events

In the SDKs, a property whose name ends in `Id` or `_id` names an entity:

| You write | Kairos stores |
|---|---|
| `userId: "user_123"` | entity `user` → `user_123` |
| `deviceId: "dev_9"` | entity `device` → `dev_9` |
| `bankAccountId: "ba_4"` | entity `bank_account` → `ba_4` |
| `recipient_id: "r_1"` | entity `recipient` → `r_1` |

For anything else, pass `entities`:

```ts
kairos.track("application_started", {
  merchantId: "mer_0155",
  entities: { ip: "185.220.219.66", email_domain: "quickinbox.io" },
});
```

An event belongs to every entity it names: the event above is in the history of the merchant, the IP address and the email domain.

## Properties

Properties are facts about an entity that are true now. There are three ways to set them.

### From an event

Most facts change because something happened. Send the fact with the event:

```ts
kairos.track("kyc_completed", {
  userId: "user_42",
  $set: { kyc_level: "full", kyc_country: "GB" },
  $set_once: { opened: "2021-03-04" },
});
```

```python
kairos.track("kyc_completed", {"user_id": "user_42"}, set={"kyc_level": "full", "kyc_country": "GB"}, set_once={"opened": "2021-03-04"})
```

- `$set` replaces a value. `$set_once` fills a property only when it has no value, for a fact that does not change.
- When the event names more than one entity, say which one: `$set: { user: { last_country: "GB" }, device: { os: "ios" } }`.
- **The newest event wins.** Each property keeps the time of the event that set it, so an older event that arrives later does not undo a newer value. A history import in any order ends with the right properties.
- Only a secret key can set properties. A public key that sends `$set` gets 403.

### Directly

When you know something apart from any event, such as a customer on the day the account opens, or an IP address you looked up:

```ts
await kairos.entity("ip", "185.220.219.66", { country: "NL", network: "datacenter" });
```

```python
kairos.entity("ip", "185.220.219.66", {"country": "NL", "network": "datacenter"})
```

Properties are merged into what is stored. With the API, [`PUT /v1/entities/:type/:id`](../../reference/api.md#put-v1entitiestypeid) also takes `unset`, a list of properties to remove.

### In bulk

For customers you already have: [`PUT /v1/objects`](../../reference/api.md#put-v1objects) takes 500 entities at a time, `kairos import entities` reads a file, and **Entities › a type › Import** uploads a CSV or JSON-lines file in the console. See [Import your history](../../getting-started/import-history.md).

**First seen** is the time of the earliest event that set a property on the entity, so an imported customer does not look new.

## Define a type

A definition says what a type means, for people and for the model. It is optional, and an entity of a type with no definition works the same way.

```ts
await kairos.defineEntity("merchant", {
  kind: "business",
  description: "A business that takes payments through us",
  properties: {
    country: "Where the business is registered",
    category: "What it sells",
  },
  link: true,
});
```

| Field | |
|---|---|
| `kind` | What sort of thing it is: `person`, `business`, `account`, `device`, `contact`, `document`, `network`, `place` or `other`. It sets the icon and the colour in the console. It is not shown to the model. |
| `description` | What this kind of entity is. |
| `properties` | What each property means. This documents them; other properties are still accepted. |
| `link` | Whether two subjects that share one are linked. Default `true`. |
| `display` | How entities of the type show in the console: an `icon`, a `color`, the properties that make up the **display name** (`fields`, such as first and last name), and how each property shows (`formats`: `money`, `date`, `country`, `image`, `document` and others). |
| `facts`, `lists` | The numbers and the tables that an entity's page and its cases show. See [Facts](facts.md) and [Lists](lists.md). |

In the console, **Entities › a type › Edit definition** has the same parts. A new type can **start from a template**: `user`, `device`, `merchant` and `beneficiary`, each with its facts and lists.

### How properties show

**How properties show**, in the same editor, gives a property a format: text, a number, money, a date, yes or no, a country, a link, an image or a document. The entity's page shows it that way. The editor offers "image" or "document" for a property whose example looks like one.

- An image opens in a window when a person clicks **View image**, and a document opens with **Open**. Both are read through Kairos, as on a [case layout](../../case-management/layouts.md#images-and-documents): from the hosts approved in Settings › Workspace, or from a data address (`data:image/jpeg;base64,…`) that holds the file itself.
- A data address with no format shows as its kind and size, such as "JPEG image · 251 KB", never as its base64 text.

### See the shape of your data

To see what entities of a type look like in your data before you define it, **[`GET /v1/entity-types/:type/shape`](../../reference/api.md#get-v1entity-typestypeshape)** lists each property with its value types, an example and how many entities carry it, the event types that name the type, and the labels in use.

## Labels

A label is an outcome on an entity, such as `fraud_confirmed` or `chargeback`, added when you learn the truth. A decision about a labelled subject sees the label, and a decision about anyone linked to it sees how many of the linked subjects carry it. Put the label on the entity the outcome is about: the user who committed the fraud, not the device. See [Labels](../core-concepts.md#label).

## Find entities

**Entities** in the console lists the types, then the entities of one type, then one entity. The list has filters, kept in the address so that a filtered list can be shared:

- the id, a label (or any label, or none);
- the outcome and the risk score of the latest decision;
- the last activity, such as in the last 7 days;
- conditions on the entity's own properties, such as `kyc_country` is `GB`.

One entity's page shows its [facts](facts.md) and [lists](lists.md), its properties, its labels, its decisions and its event history, with each property in the format of its type.

With the API: [`GET /v1/entities`](../../reference/api.md#get-v1entities) takes the same filters, and [`GET /v1/entities/:type/:id`](../../reference/api.md#get-v1entitiestypeid) returns one entity with its recent events, decisions and sessions.

## Limits

| | |
|---|---|
| Entity type names | Start with a letter or an underscore, then letters, digits and underscores, up to 64 characters |
| Entity ids | 1 to 256 characters |
| Entities in one `PUT /v1/objects` | 1 to 500 |
| Facts and lists of one type | 12 facts, 6 lists |
