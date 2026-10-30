# Cases

A **case** is one item of work in a [queue](queues.md): one request to review, with the decisions, events and entities that belong to it. A case can hold one decision or many. A queue's rules open cases, and its grouping decides which decisions share one.

## What a case holds

A case holds what its triggers name: the decision, the event that started it, the subject, every entity in the request and the event, the session, and the record. Nothing is set up by hand: a payment decision that names a payment, an account, a customer and a device brings all four. Later triggers add to the case; nothing is taken away. Other entities linked to these are not in the case.

The case page shows:

- **Why this case exists**: each trigger, with the rule and the values it read.
- **Decisions**: each one, and whether it is resolved.
- **What happened**: the events and decisions in time order, an event before the decision it started. Events around the case's entity that are not part of the case are shown lighter.
- **Objects** and **Activity**: who was assigned, notes, and the resolution.

A case shows its entity, and each of its objects, by its display name when the entity type has display fields (as on the entity pages), with the id beside the name.

When the case's entity type has [facts](../concepts/entities/facts.md) and [lists](../concepts/entities/lists.md), the case page shows them: the facts beside the details, and the lists under the decisions, with the case's own rows marked.

A queue can have its own case layout: see [Layouts](layouts.md).

## Working a case

A case is **open**, **in review** (it has an assignee) or **resolved**. **Assign** opens a list with you first and then the other members of the workspace; choosing one starts the review. **Reassign** changes the assignee, and **Unassign** removes it and makes the case open again. The number beside **Queues** in the sidebar is the cases assigned to you that are not resolved.

The queue's list has these tabs: **To do** (open and in review), **Open**, **In review**, **Resolved**, **Resolved, decisions open** and **All**. **Resolved, decisions open** shows the resolved cases that still have a decision with no resolution and an outcome other than approve: your system was not told an outcome for them. The filters narrow the list by priority, assignee and due time.

To change many cases at once, tick them in the list (the box in the heading ticks the page). **Assign** gives them one assignee, or none, and **Resolve** resolves them with one outcome. Each case changes on its own: the list says which could not change, such as a case that was resolved already, and keeps those ticked.

**Reopen**, on a resolved case, makes it open again (in review when it has an assignee). Its resolution goes to the activity.

Each decision of a case shows whether it is resolved. To resolve decisions, resolve the case (below), or open the decision.

To resolve a case, choose an outcome: approved, blocked, confirmed fraud, false positive, or no action needed.

- With **approved** or **blocked**, the case can also resolve its decisions that have no resolution and a different outcome. Each one sends `decision.updated`. Without this, your system is not told: the decisions stay as the model left them.
- With **confirmed fraud** or **false positive**, the case can also label its entity `fraud_confirmed` or `cleared`. Later decisions read the label.

A case past its [due time](queues.md#due-times) is **overdue**.

## Webhooks

Choose `case.created`, `case.assigned`, `case.resolved` and `case.reopened` for an endpoint in **Settings › Webhooks**, optionally for some queues only. Each message has the case as `GET /v1/queues/:id/cases` lists it, with `case_id` and `queue_id`. See [Outbound webhooks](../platform/webhooks/outbound.md).

The API is in [the API reference](../reference/api.md#queues-and-cases).
