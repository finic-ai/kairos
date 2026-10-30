# Case layouts

Each queue can have its own case layout, for its work: the amount and the payee first for a payment that waits for a person, the identity documents and a checklist for an onboarding review. A queue with no layout of its own shows the standard layout.

**Queues › a queue › Edit queue › Edit Case Layout** opens the editor. For a queue with no layout of its own, the editor opens with a choice: **Start from scratch**, from the standard layout, or **Start from a template**, each template with a small drawing of its blocks. Nothing changes on the cases until you save. A change to the layout is not a new version of the queue: it changes how cases look, not which cases exist. Cases that are open show the new layout at once.

## The layout

| Area | |
|---|---|
| Header | At most 6 values under the case's title, such as the amount, the risk and the due time. |
| Main | Blocks in 12 columns. Each block has a width, from 3 to 12 columns. |
| Sidebar | Blocks one under the other. |

The editor shows the layout on a real case of the queue (**Preview**, the latest case; choose another in **Preview with**), as its reviewers will see it, with the changes that are not saved yet. In the preview, images stay closed, a checklist cannot be ticked, and nothing is recorded on the case. **Outline** shows each block as a short description, for a queue with no cases yet.

Point at a block to see its tools. Drag it to move it, in its area or to the other one. Drag its right edge, or use − and +, to change its width. ✎ changes its title and what it shows; × removes it.

## Blocks

| Block | Shows |
|---|---|
| Why this case exists | Each trigger, with the rule and the values it read. Every page has it: it can move, not go. |
| Decisions | The case's decisions, with their outcome, risk and resolution. |
| What happened | The events and decisions in time order. |
| Details | Status, priority, assignee, queue, when it opened, and when it is due. |
| Fields | Values you choose (below). |
| Facts | Numbers about the case's entity, or about one of its objects, such as its device. See [Facts and lists](#facts-and-lists). |
| Lists | Tables of the records about the case's entity, or about one of its objects, a tab each. See [Facts and lists](#facts-and-lists). |
| Objects | The entities, sessions and records of the case. |
| Activity and notes | Assignments, notes, views, checks and the resolution. |
| Instructions | Fixed text for the reviewer. |
| Images | Photos from fields that hold an image address, such as an identity document and a selfie. |
| Documents | Files from fields that hold an address, such as a bank statement. |
| Checklist | Points a reviewer confirms. Each tick is in the activity: who, and when. |

## Fields

The header, a fields block, and the images and documents blocks read values by path, the same paths as the queue's rules:

| Path | The value |
|---|---|
| `case.status`, `case.priority`, `case.assignee`, `case.queue`, `case.opened`, `case.age`, `case.due`, `case.reason` | Of the case. |
| `decision.outcome`, `decision.risk_score`, `decision.action`, `decision.typology`, `signal.<code>` | Of the case's latest decision. |
| `request.<property>`, `event.<property>` | Of the request of the latest decision, and of the event that started it. |
| `subject.<property>` | Of the case's entity. |
| `item.<type>.<property>` | Of the case's first object of that type, such as `item.device.os`. |

Each field can have a label and a format: text, number, money (in a fixed currency, or the currency of another field such as `event.currency`), a date, yes or no, or a country.

## Facts and lists

A reviewer often needs the same numbers and tables about the case's entity that its own page shows: how much money went out this week, against the usual; the devices the customer used; their recent logins. These are the entity type's **facts** and **lists**, and a layout shows them in two blocks:

- A **Facts** block shows numbers about the case's entity, or about one of its objects, such as its device. See [Facts](../concepts/entities/facts.md).
- A **Lists** block shows tables of the records about it, a tab each, 5 rows to a page. The rows that belong to the case are marked: the transaction that opened it, the device it named. See [Lists](../concepts/entities/lists.md).

Set them up on the entity type, in **Entities › a type › Edit definition**, and every layout that shows that type can use them.

### The layout's own facts and lists

A facts or list block shows the facts and lists of the entity's type. The layout can also have facts and lists of its own, for what this queue needs and the others do not. A name in the layout replaces the same name of the type, in this layout only. A block that names no facts or lists shows the layout's own for that type, or the type's when the layout has none.

## Images and documents

Identity documents are the most sensitive data a case shows. So:

- Kairos reads an image or a document only from a host that the workspace approved, in **Settings › Workspace › Case layouts**: names such as `files.example.com`, or `*.example.com` for every subdomain. The server reads it, by https, and the browser gets it from Kairos: it never loads your storage, and a property cannot make it load another address. A redirect is not followed.
- A field can also hold the file itself, as a data address with base64 content: `data:image/jpeg;base64,/9j/4AAQ…`. It needs no approved host. It makes the event or the entity that holds it larger, so keep it on the entity (`set` in `/v1/events`, or `/v1/objects`), not on each event.
- An images block shows PNG, JPEG, GIF, WebP, AVIF and BMP images; not SVG, which can hold script. A document opens in a new tab when it is a PDF, plain text or one of those images; any other file is downloaded.
- An images or documents block is hidden until a person chooses to see it, and each opening is in the case's activity ("Opened identity documents"). Turn this off for a block that is not sensitive.
- A link that answers 401, 403 or 410 shows "The link has expired". A host that is not approved, a field with no value, or a file over 15 MB says so too.

### Signed links

Private storage (Amazon S3, Google Cloud Storage, Azure Blob Storage) shares a file by a signed link: an address with a signature and an end time. Kairos reads the link when a reviewer opens the case, which can be hours or days after the event. So make the links you send last at least as long as a case can wait in the queue, such as 7 days, or send the file itself as a data address. Kairos does not ask your server for a new link.

## Templates

A template fills the layout; **Use a template** does so for a queue that has one. A template's facts and lists for users become the queue's own type, the subject of its first source action. Change anything after; a later change to a template does not change a layout made from it.

| Template | For |
|---|---|
| Pre-transaction approval | A payment that waits for a person. |
| Onboarding (identity) | A new account held for an identity check. |
| Transaction monitoring | A pattern over many transactions. |
| Lending | A loan application. |
| Account takeover | A login or a change that may not be the account holder. |
| Business onboarding | A business that applies to take payments. |

The API is in [the API reference](../reference/api.md#case-layouts).
