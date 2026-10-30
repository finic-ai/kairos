# Queues

A **queue** is a list of work for people, such as "Onboarding review". A **[case](cases.md)** is one item in it: one request to review, with the decisions, events and entities that belong to it. A case can hold one decision or many. This page is about the queue: which decisions open cases, how they are grouped, and how a case is due. To work a case, see [Cases](cases.md).

The decisions list shows everything Kairos decided. A queue shows only what needs a person, grouped by request.

## How a case is made

1. A decision is made by an action that a queue takes (its **sources**).
2. A few seconds later, Kairos tests the decision against the queue's **rules**.
3. No rule matches: nothing happens. The decision stays in the decisions list.
4. A rule matches: Kairos works out the case's **key**, for example the user. It adds the decision to the open case with that key, or opens a new case.

A workflow can also make a case, with a [`case.create` step](../platform/workflows.md#cases).

A decision made as of a past moment (`ts` in `/v1/decide`, or an event more than a minute old in `/v1/events/decide`) is a test of the past: it makes no case, as it starts no workflow.

## Rules

A rule opens a case when **all** or **any** of its conditions hold. A queue has at most 10 rules, and a rule at most 20 conditions.

| Field | Values |
|---|---|
| `decision.outcome` | `approve`, `step_up`, `review`, `block` |
| `decision.risk_score` | 0 to 100 |
| `signal.<code>` | The probability of one signal of the action, 0 to 1 |
| `decision.typology` | A typology code of the action |
| `request.<property>` | A property the decision was asked with, such as `request.amount` |
| `event.type`, `event.<property>` | The event that started the decision |

- A signal is read from the model's answer, so a rule can test a signal below the action's reason threshold.
- A rule can open a case for an `approve` decision, for example when one signal is high.
- A field that is not there satisfies nothing. A number is compared only with a number.
- A rule opens work. It does not change the decision or what the caller was told. To hold a payment, the action's policy must return `review` or `step_up`.

Each rule has a priority: `low`, `normal`, `high` or `urgent`. A later trigger can raise a case's priority, never lower it. When two rules match one decision, the case gets one trigger for each rule.

## Grouping

| One case for each | The key |
|---|---|
| Subject | The decision's subject, such as the user |
| Entity | An entity the decision names, such as `application`: decisions about different subjects meet in one case |
| Request property | A value of the request, such as `application_id` |
| Session | The decision's session |
| Event | The event that started the decision |

- For a subject, an entity or a request property, a later trigger joins the open case while the case was active within the window: 30 days by default, 1 to 90.
- A later trigger after the case is resolved opens a new case. With **Reopens the case** (`reopen_days`, 1 to 90), a trigger within that many days of the resolution reopens the resolved case instead.
- A case takes at most 200 triggers. The next one opens a new case, linked from the old one.
- A decision with no key makes a case of its own, or none if the queue says **Opens no case**.

## Due times

A queue can set how long a case can wait, in hours, for each priority. A case gets its due time when it opens, from its priority. A later trigger that raises the priority can make the due time sooner, never later. A reopened case gets a new due time.

A case past its due time is **overdue**. The queue's page shows how many are, the **Overdue** filter lists them, the **Due** column shows "in 3 hours" or "2 hours late", and the **Soonest due first** order puts them first. A priority with no hours gives no due time.

## Setting up a queue

**Queues › New queue**, or **Make a queue** on an action's page. The editor has these parts:

| Part | What it decides |
|---|---|
| Queue | Its name, a description for the people who work it (at most 500 characters), its status (enabled or disabled) and who sees it. |
| Decisions to watch | The actions whose decisions the queue looks at: its sources. |
| When to open a case | The rules. A decision that matches one opens a case, or joins the open case it belongs to. |
| Case grouping | Which decisions belong to the same case: a decision that matches a rule opens a new case, or joins the open case of its group. Also whether a trigger after the case is resolved reopens it. |
| Due times | How many hours a case of each priority can wait before it is overdue. |
| Case list columns | The columns of the queue's list, from left to right: drag a column or use its arrows to move it, × to remove it, and add a fixed column or a `request.` or `subject.` property. At most 12. Also how the cases are sorted. |
| Display | The queue's icon and colour, chosen as for an entity type. |

A change to the sources, the rules or the grouping is a new version of the queue. It applies to new decisions only; cases that exist do not change.

**Settings › Environments** copies queues to a sandbox: their definitions, not their cases. Other people's private queues are not copied.

A **disabled** queue takes no new cases, from rules or from workflows. Its cases stay. The switch beside the queue's name, and the one in the editor, enable or disable it. A queue with cases cannot be deleted: disable it instead.

The API is in [the API reference](../reference/api.md#queues-and-cases).
