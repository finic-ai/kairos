# Workflows

A workflow is work that Kairos does for you after something happens: review a large withdrawal, label an account when a chargeback arrives, call your case tool when a decision is blocked. It has **one trigger** and a list of **steps**. Kairos runs it in the background, step by step, and keeps a log of each run.

```
Trigger ──▶ run ──▶ step ──▶ step ──▶ step ──▶ done
 (an event,          │
  a change,          └── each step's output is in the run log,
  a schedule,            and the steps after it can read it
  a call)
```

- [When to use it](#when-to-use-it)
- [Build one in the console](#build-one-in-the-console)
- [Drafts, versions and the switch](#drafts-versions-and-the-switch)
- [Triggers](#triggers)
- [Steps](#steps)
- [Run and wait](#run-and-wait)
- [Expressions and templates](#expressions-and-templates)
- [Runs](#runs)
- [Test a workflow](#test-a-workflow)
- [Limits](#limits)
- [Security](#security)
- [The API](#the-api)
- [A complete example](#a-complete-example)

## When to use it

| Use | Example |
|---|---|
| **Act on a decision.** A decision alone does not tell anyone. | When a `withdrawal` decision is `block`, call your case tool with the decision and its reasons. |
| **Act on an outcome.** A label arrives days after the fact. | When a user gets the `chargeback` label, label the payees they paid, and hold their open payouts. |
| **Decide later, or again.** | When a new payee is added, wait 24 hours, then decide `payout` about the user with what Kairos knows then. |
| **Work at set times.** | Each weekday at 09:00, search the decisions that wait for review and post a summary to your team. |
| **Take work from another system.** | Your back office calls the workflow's URL; the workflow decides and writes the answer back with an HTTP step. |
| **Answer a request with more than one decision.** | Your server calls the workflow and waits: it reads the user, checks two rules, asks `payout`, and returns the outcome. See [Run and wait](#run-and-wait). |

A workflow runs in the background, unless your server [waits for it](#run-and-wait). For one decision, call [`decide`](../reference/api.md#decisions); for rules and steps around it, run a workflow and wait.

## Build one in the console

Open **Workflows** and choose **New workflow**.

1. **Name it.** The name becomes its key, such as `review_withdrawals`. The key does not change; the display name can.
2. **Choose the trigger.** The panel on the right shows the trigger types, in two groups: **Events** (a record event, an app event) and **Others** (manual, a decision request, a schedule, a webhook). The trigger's settings open in the same panel.
3. **Add steps.** Drag a step from the list onto the canvas, or click **+** on a line. Click a step to open its settings. Drag a step to move it; a condition and a loop hold steps of their own.
4. **Save, then publish.** **Save** keeps a draft. **Publish** makes the draft the live version. The badge at the top left of the canvas shows unsaved changes and problems; a workflow with problems cannot be published.

Beside the workflow's name are its tabs: **Builder**, **Runs** and **Experiments**. **Runs** opens the table of the workflow's runs, and shows how many are in progress; click a run to see each step, its input and its output. **Experiments** lists the [experiments](models.md#experiments) on the workflow. The **⋯** menu has **See runs** and **Experiments** too, with **Pause** or **Activate**, and **Archive**.

The condition fields (**Only when** on a trigger, **If** on a condition, **Go on only when** on a filter) have a builder: choose a field, an operator and a value, and group conditions with **all** or **any**. **Write an expression** shows the same condition as text, for the cases the builder does not cover.

## Drafts, versions and the switch

| State | What runs |
|---|---|
| **Draft**, never published | Nothing. A new workflow starts here, at version 0. |
| **Published** | The live version. Each publish makes the next version: 1, 2, 3. |
| **Published, with a draft** | The live version. The draft is your changes; runs do not read it until you publish. |
| **Paused** (`enabled: false`) | Nothing new starts. Runs that are open finish. |
| **Archived** | Nothing new starts. Runs that are open finish, and the runs stay. **Restore**, in the builder's header, brings it back as it was. |

A run keeps the version it started with. A publish during a run does not change that run. Every version is kept: `GET /v1/workflows/:name/versions` lists them, and `GET /v1/workflows/:name?version=2` reads one.

Workflows belong to an **environment**, as actions do. A workflow in a sandbox does not see the events of production.

## Triggers

Each trigger can have **Only when** (`when`): an [expression](#expressions-and-templates) that must be true for a run to start. A `when` that cannot be read is refused when you publish.

| Trigger | `type` | Starts a run when |
|---|---|---|
| Record event | `record` | An entity, an event or a decision changes in Kairos. |
| App event | `event` | Your system sends an event of one type. |
| Launch manually | `manual` | You start it, in the console or with the API. |
| On a schedule | `scheduled` | A cron expression is due. |
| Webhook | `webhook` | A call arrives at the workflow's own URL. |
| Decision request | `decision` | `decide()` is called for its action: the workflow makes the decision. |

### Record event

```json
{ "type": "record", "record": "entity", "on": "labelled", "entity": "user", "label": "chargeback" }
```

| `record` | `on` | Filters | The run reads |
|---|---|---|---|
| `entity` | `created`, `updated`, `labelled` | `entity` (the entity type), `label` (for `labelled`) | `trigger.entity` (its type, id and properties). For `updated`, also `trigger.before`: the properties before the change. For `labelled`, `trigger.label`. |
| `event` | `created` | | `trigger.event`, and `event` |
| `decision` | `created`, `updated` | `action` | `trigger.decision`: its action, subject, decision and resolution. A decision is `updated` when a person or a step resolves it. |

`trigger.record` and `trigger.on` say what happened, so one workflow can read them the same way for each change.

### App event

```json
{ "type": "event", "event": "withdrawal", "status": ["pending", "completed"], "when": "event.properties.amount >= 1000" }
```

`event` is the event type. `status` (one value or a list) keeps only events with that status. The run reads the event as `trigger` and as `event`: `event.id`, `event.type`, `event.ts`, `event.entities`, `event.properties`, `event.status`, `event.session`.

**Events from the history start no run.** An event or a change whose time is more than **one hour** in the past is history, such as an [import](../getting-started/import-history.md). Set `"backfill": true` on the trigger to start runs for history too.

**Events sent with a public key start no run**, because anyone who reads your web page has that key. Set `"allowPublic": true` only when the steps are safe for that.

### Launch manually

```json
{
  "type": "manual",
  "inputs": [
    { "name": "user", "type": "entity", "entity": "user", "required": true, "label": "User" },
    { "name": "amount", "type": "number", "default": 0 }
  ]
}
```

Start a run in the console with **Run**, or with `POST /v1/workflows/:name/runs` and `{ "input": { … }, "idempotency_key"?: "…", "wait"?: true }`. The run reads the input as `trigger`: here `trigger.user` and `trigger.amount`. Two calls with the same `idempotency_key` start one run.

`inputs` is optional. Each input has a `name` (letters, digits and `_`) and a `type`:

| `type` | The value |
|---|---|
| `text` | Text |
| `number` | A number |
| `boolean` | `true` or `false` |
| `entity` | The id of an entity. `entity` names its type, such as `user`. |
| `list` | A list |
| `object` | A JSON object |

- `required: true`: a run without the input is refused with 400, and the message names it: `input.user: is required`. A value of the wrong type is refused the same way.
- `default`: the value when the input is not given.
- `label` and `description`: what the console's run form shows.
- An input that the trigger does not name is kept, and the steps can read it too.

In the console, **Run** opens a form with a field for each input. Without inputs, it asks for a JSON object.

### On a schedule

```json
{ "type": "scheduled", "cron": "0 9 * * 1-5", "timezone": "Europe/London" }
```

`cron` has five fields: minute, hour, day of month, month and day of week (0 or 7 is Sunday). It takes `*`, lists (`1,15`), ranges (`1-5`), steps (`*/15`) and names (`MON-FRI`, `JAN`). As in cron, when both the day of month and the day of week are set, a day that matches either one is due. `timezone` is an IANA time zone; without one, it is UTC. The console shows the next three times.

- Kairos looks for due schedules **each minute**, and starts one run for each due minute. The run reads `trigger.scheduled_at` (the due minute, in UTC) and `trigger.timezone`.
- **A missed time starts one run, for the latest time only.** When the server was down at 09:00 and 10:00, it starts one run, for 10:00, when it is back. It looks back at most one day. It does not start runs for times before the workflow was published.
- On a self-hosted server, schedules need the background worker: see [Self-hosting](../deployment/self-hosting.md).

### Webhook

```json
{ "type": "webhook", "method": "POST", "idempotency_header": "X-Request-Id" }
```

1. Save the workflow, then open the trigger and choose **Make URL**. Kairos shows the full URL **once**. Copy it and give it to the sender. After that, the console shows only its last characters.
2. **New URL** makes another one. The old URL stops at once.
3. Publish the workflow. The URL starts runs only while a version with this trigger is published and active.

A call to `/v1/workflow-hooks/wfh_…` needs **no API key**: the token in the URL stands for one. Kairos answers:

| Status | When |
|---|---|
| 202 `{ "run_id": "wfr_…" }` | The run is started. |
| 404 | No workflow has this URL, or its live version has no webhook trigger. |
| 405 | The method is not the trigger's `method` (`GET`, `POST` or `PUT`; default `POST`). |
| 409 | The workflow is paused, archived, or not published. |
| 413 | The body is larger than 1 MB. |

The run reads `trigger.method`, `trigger.headers` (names in lower case), `trigger.query`, `trigger.body` (parsed when it is JSON, else the text) and `trigger.received_at`. Kairos keeps no `Authorization`, `Proxy-Authorization` or `Cookie` header.

With `idempotency_header`, calls with the same value in that header start **one** run, and each answers with its run id. Without it, each call starts a run. Most senders retry; set it when yours sends a delivery id.

### Decision request

```json
{ "type": "decision", "action": "payout", "timeout_seconds": 5 }
```

The workflow makes the decisions of `payout`. Each `decide()` for it runs the workflow, and the workflow's answer is the decision. This covers `POST /v1/decide`, `POST /v1/events/decide`, automatic decisions, and Decide steps of other workflows. An action with no decision workflow decides as it always did, with its model and its thresholds.

- **One for each action.** Only one published workflow can make an action's decisions. Kairos refuses to publish a second, and to restore an archived one, and names the workflow that has the action. Drafts do not count.
- **Paused or archived:** the action decides as it does with no workflow.
- **The request** is the trigger: `trigger.action`, `trigger.entities`, `trigger.properties`, `trigger.session`, `trigger.event_id` and `trigger.ts`, the moment it decides as of.
- **The model** is not asked unless a step asks it. Use [Get the model's decision](#get-the-models-decision) for the action's view, once, more than once, or not at all, [Ask a question](#ask-a-question) for questions of your own, and [Score with a model](#score-with-a-model) for a scoring model of your own.
- **The answer** comes from an [Answer or a Return step](#return-and-answer). It has an `outcome`: `approve`, `step_up`, `review` or `block`. It can also give `reasons`, `rules`, `typology`, `risk_score` (0 to 100) and `probability` (0 to 1). Give `probability` for a model's score: a `risk_score` alone makes a probability of two digits, 0.73 for 0.734. What it does not give, apart from `rules`, comes from the last Get the model's decision step; without one, the risk score is 0 and there are no reasons.
- Kairos saves **one** decision, as for any decision. Its `metadata` names the workflow (`decision_workflow`) and the run (`decision_run_id`), and has `scores`: what each Score with a model step before the answer gave, with the values it read. Its webhooks, its record triggers and the decisions list see it as any other. The answer to `decide()` also has `workflow_run_id`.
- **Every path answers.** Kairos checks it when you publish: a path that can end with no answer is refused.
- **No delay before the answer**: the caller waits. A delay after an Answer step is fine.
- **The time until the answer** is `timeout_seconds`: 5 by default, at most 30, apart from the model. A step does not wait for a retry before the answer: its first failure counts.
- **A failure before the answer fails the decision.** `decide()` gets a 502 with the type `workflow_failed`, and the message names the step and the run. The SDKs' `fallback` option handles it, as it handles a model that cannot answer. No decision is saved.
- **Writes before the answer stay** when the decision then fails. The builder marks each one. Put writes after an Answer step, or in workflows that start on a [decision that is created](#record-event), when they must only happen for a decision that is saved.
- Steps after an Answer run in the background, once the decision is saved. They read its id as `trigger.decision_id`. A decision as of a past moment (`ts`, for a backtest) stops at its answer: as it sends no webhook, it does not go on.

A decision workflow cannot be started with `POST /v1/workflows/:name/runs`: call `decide()`.

## Steps

Each step has an `id` (letters, digits and `_`, unique in the workflow), a `name` (unique, at most 80 characters) and a `type`. The other fields depend on the type. A field can hold a [template](#expressions-and-templates).

| Type | Console | What it does | Its output |
|---|---|---|---|
| `condition` | If / else | Runs `then` or `else`, from `when`. | `{ branch }` |
| `filter` | Filter | Ends the run, as **filtered**, when `when` is false. | `{ passed }` |
| `loop` | Loop | Runs `steps` once for each item of the list `over`. Inside, `item` is the item and `index` its place. | The output of the last step, for each item |
| `delay` | Delay | Waits `for` a time (`30s`, `15m`, `24h`, `7d`), or `until` a time. | |
| `return` | Return | Ends the run. Its `value` is the run's output. | The value |
| `answer` | Answer | Gives the run's answer, and the run goes on. | The value |
| `http` | HTTP request | Calls a URL. | `{ status, headers, body }` |
| `decide` | Decide | Makes a decision with an action. | The decision |
| `assess` | Get the model's decision | Asks an action's model, and applies its thresholds. Saves nothing. | What the decision would be |
| `ask` | Ask a question | Asks the model questions of your own, about an entity, data, or both. Saves nothing. | Each answer, by its key |
| `score` | Score with a model | Scores values from the run with a scoring model. Saves nothing. | `{ score, risk_score, model, features, missing, invalid }` |
| `record.search` | Search records | Finds events, entities or decisions. | A list |
| `record.get` | Get a record | Reads one. | The record |
| `record.create` | Create a record | Writes an event, an entity or an entity type. | What it wrote |
| `record.update` | Update a record | Changes an entity (properties, a label), resolves a decision, or changes an entity type. | What it changed |
| `case.create` | Create a case | Puts a case in a queue, or adds to the open case with its key. | `{ case_id, created }` |
| `case.resolve` | Resolve a case | Resolves a case. | `{ case_id, resolved, resolution, decisions_resolved, labelled }` |

### Condition, filter, loop and delay

```json
{ "id": "big", "name": "Big amount", "type": "condition", "when": "event.properties.amount >= 1000",
  "then": [ … ], "else": [ … ] }
{ "id": "each_payee", "name": "Each payee", "type": "loop", "over": "steps.payees.output", "steps": [ … ] }
{ "id": "wait", "name": "Wait a day", "type": "delay", "for": "24h" }
{ "id": "until_due", "name": "Until due", "type": "delay", "until": "{{ trigger.due_at }}" }
```

A delay does not hold a process: the run waits, with the status **waiting**, and continues at the time. A run lasts at most 30 days, delays included.

### Return and Answer

```json
{ "id": "done", "name": "Done", "type": "return",
  "value": { "outcome": "{{ steps.ask.output.decision }}", "reasons": "{{ steps.ask.output.reasons }}" } }
{ "id": "reply", "name": "Reply", "type": "answer", "value": { "outcome": "review" } }
```

Both give the run its answer: the `value`, which can hold templates. Choose one by what comes next:

- **Return** ends the run, also inside a condition or a loop. No step after it runs, and the builder marks a step that comes after one.
- **Answer** gives the answer, and the run goes on. A caller that waits gets the answer at once, and the steps after it run in the background, delays included. One Answer on each path: a second one, or one in a loop, is refused. A Return after an Answer ends the run, and does not change its answer.

**The output of a run** is the value of its Answer or Return step. Without one, it is the output of the last step that acted (an HTTP, decide, assess, ask, score, record or case step), or of the last loop. A filtered or failed run has no output. The run's `output` field has it, and the console shows it on the run's page.

### HTTP request

```json
{
  "id": "open_case", "name": "Open a case", "type": "http",
  "method": "POST",
  "url": "https://cases.example.com/api/cases",
  "headers": { "Authorization": "Bearer {{ secrets.CASES_TOKEN }}" },
  "body": { "user": "{{ trigger.decision.subject.id }}", "reasons": "{{ trigger.decision.decision.reasons }}" },
  "timeout_seconds": 10
}
```

| Field | |
|---|---|
| `method` | `GET` (default), `POST`, `PUT`, `PATCH` or `DELETE` |
| `url`, `headers`, `query`, `body` | Each can hold templates. A `body` object is sent as JSON. |
| `timeout_seconds` | Default 10, at most 15. |
| `success_status` | A list of statuses that are a success, such as `[200, 404]`. Default: 2xx and 3xx. |

- Each call has the header `Idempotency-Key: <run id>:<step path>`. A retry of the step sends the same key, so a receiver that reads it does the work once.
- Kairos does not follow redirects, and reads at most 256 KB of the answer.
- **Secrets.** `{{ secrets.NAME }}` reads a secret that is kept on the server, not in the workflow. Only an HTTP step can read secrets. Kairos replaces each secret value with `…` in the run log. A step that names a secret that does not exist fails, and the run log names it. On kairos.finic.ai, ask Finic to add a secret; on a self-hosted server, see [Configuration](../deployment/configuration.md#webhooks-and-workflows).
- The URL is checked as for outbound webhooks: HTTPS only, and no private or local address.

### Decide

```json
{ "id": "decide", "name": "Decide payout", "type": "decide", "action": "payout",
  "entities": "{{ event.entities }}", "properties": { "amount": "{{ event.properties.amount }}" } }
```

`action` is an action name, or a name and a version such as `payout@3`. `entities` is an object, or one template that gives one. `properties`, `ts` and `session` are optional. The decision keeps the trigger's event, unless that event has a decision already; set `"event_id": false` to keep none.

A decide step makes **one** decision, even when the step is tried again: the run and the step are saved with the decision. The decision's webhooks and record triggers see it as any other decision.

### Get the model's decision

```json
{ "id": "ask", "name": "Ask", "type": "assess" }
{ "id": "ato", "name": "Takeover?", "type": "assess", "action": "account_takeover", "entities": { "user": "{{ trigger.entities.user }}" } }
```

Asks an action's model about a request, and applies the action's thresholds and rules, as a decision does. It saves nothing, so it makes no decision, no webhook and no record trigger. Its output is what the decision would be: `decision`, `probability`, `risk_score`, `reasons`, `typology` and `rules`.

In a decision workflow, `action`, `entities` and `properties` are the request's unless the step gives others; elsewhere, `action` and `entities` are needed. `model` names the question model to ask; the default is `grayson-1`. Each of these steps is a call to the model: it costs as one. When a decision workflow asks the model, the decision keeps what the last such step showed the model and what it answered, and the console shows it as for any decision. In the console this step was called "Ask the model" before; its `type` is still `assess`.

### Ask a question

```json
{
  "id": "triage", "name": "Triage the message", "type": "ask",
  "entity": { "type": "user", "id": "{{ trigger.user }}" },
  "data": { "message": "{{ trigger.message }}" },
  "questions": {
    "fraud": { "type": "yes_no", "question": "Is the customer reporting a payment they did not make?" },
    "topic": { "type": "one_of", "question": "What is the message about?",
               "options": { "refund": "Asking for a refund", "fraud": "A payment they did not make", "other": "Something else" } },
    "signals": { "type": "any_of", "question": "Which of these are present?",
                 "options": { "new_device": "A new device", "new_country": "A new country" } },
    "urgency": { "type": "score", "question": "How urgent is a reply?", "levels": ["low", "medium", "high"] }
  }
}
```

Asks the model questions of your own: not a decision, and with no action and no thresholds. It saves nothing.

- **What the model reads:** with `entity`, that entity's history, links and labels, as for a decision; with `data`, the values you give it, at most 32 KB as JSON. Give one, or both: with both, the data is what the question is about now.
- **Questions:** 1 to 75, each by a key of letters, digits and `_`. The question text can hold templates.
- **`model`** names the question model to ask. The default is `grayson-1`.

| `type` | Also needs | The answer |
|---|---|---|
| `yes_no` | | `{ value: true or false, probability }` |
| `one_of` | `options`: at least two, as `{ "key": "what it means" }` | `{ value: the option's key, probabilities }` |
| `any_of` | `options`, as for `one_of` | `{ values: the keys that apply, probabilities }` |
| `score` | `levels`: at least two, from the lowest | `{ level, value: a number from 0 (the first level) up, probabilities }` |

- **The output** has each answer by its key, and `input_tokens`, what the call read. The next steps read `steps.triage.output.fraud.value` or `steps.triage.output.urgency.level`; the condition builder offers them by name.
- **The model does not write text.** It cannot summarise, explain or draft a reply: each answer is a value.
- Each run of the step is one call to the model. A test run with `mock_outputs` for the step uses that output, and asks nothing.
- It can come before the answer of a decision workflow: it writes nothing.

### Score with a model

```json
{
  "id": "xgb", "name": "Score default risk", "type": "score",
  "model": "loan-default@1",
  "features": {
    "hardship": "{{ steps.ask.output.hardship.probability }}",
    "grayson_hold": "{{ steps.assess.output.probability }}",
    "amount": "{{ trigger.properties.amount }}",
    "country_gb": "{{ trigger.properties.country == 'GB' ? 1 : 0 }}"
  }
}
```

Scores values from the run with a [scoring model](models.md), such as an XGBoost model trained on your own outcomes. The model runs in the Kairos server: the step makes no call and saves nothing.

- **`model`** is a scoring model's slug and version, `loan-default@1`, or its slug alone for the latest version. The latest version changes when someone uploads a new one, and the scores with it.
- **`features`** has a value for each feature of the model, and no others: a number, `true` or `false`, or a template.
- **A value becomes a number:** a number stays, `true` is 1 and `false` 0, and text that is a number, such as `"31.4"`, is that number. `null`, a value that is not there, and a template that cannot be read, such as one that reads a step that did not run on this path, are **missing**. Other text, a list and an object are missing and **invalid**. A missing value is not an error: the model takes its default branch for it.
- **The output:** `score`, the probability from 0 to 1; `risk_score`, the score times 100; `model`, the version that scored, such as `loan-default@1`; `features`, what each value became, with `null` for a missing one; and `missing` and `invalid`, lists of feature names. Read `steps.xgb.output.score` in a condition, and give it to the answer as `probability`.
- **When you save,** Kairos refuses a model that is not there or is archived, a question model, features that are not exactly the model's, and a feature that reads a step that does not come before this one. The builder shows the same problems as you edit, and fills each feature with the value the model was trained with when you choose the model.
- In a decision workflow, the decision keeps each score, with its values, in `metadata.scores`, and its page shows them.
- A test run scores for real. With `mock_outputs` for the step, it uses that output.
- If the model or its version is not there, the step fails, and is not tried again. After a database error, it is tried again.

### Records

| Step | `record` | Fields |
|---|---|---|
| `record.get` | `event` | `record_id`: the event's id |
| | `object` | `entity` (the type), `record_id` (the id) |
| | `entity_type` | `record_id`: the type |
| | `decision` | `record_id`: the decision's id |
| `record.search` | `event` | `types`, `limit`. With `entity` and `record_id`: the events of that entity. |
| | `object` | `entity`, and `q`, `label`, `outcome`, `limit` |
| | `decision` | `action`, `outcome`, `limit`. With `entity` and `record_id`: the decisions about that entity. |
| | `entity_type` | |
| `record.create` | `event` | `event_type`, `entities`, `properties`, and `record_id`, `ts`, `status`, `session` |
| | `object` | `entity`, `record_id`, `properties` |
| | `entity_type` | `entity`, `definition` |
| `record.update` | `object` | `entity`, `record_id`, and `properties`, `unset` (a list of names), `add_label` |
| | `decision` | `record_id`, `resolution: { outcome: "approve" \| "block", note? }`, `by` (default `workflow`) |
| | `entity_type` | `entity`, `definition` |

`limit` is 50 by default, at most 200. A search gives the newest first. A record step writes once: its write and its line in the run log are one transaction.

`record.get` and `record.search` also read **cases**: `record: "case"`. `record.get` takes the case's id, and gives the case with its evidence, items and decisions. `record.search` takes `queue`, `status`, `priority`, `assignee`, `entity` and `record_id` (the cases about that entity), `item_type` and `item_id` (the cases that hold that entity, such as a device), `created_after` and `limit`. A case is not created or updated as a record: use the case steps.

### Cases

```json
{ "id": "open", "name": "Open a case", "type": "case.create", "queue": "que_…",
  "entity": { "type": "user", "id": "{{ trigger.entities.user }}" },
  "reason": "The outside check failed", "priority": "high" }
{ "id": "close", "name": "Close the case", "type": "case.resolve",
  "case_id": "{{ steps.open.output.case_id }}", "category": "false_positive", "label_target": true }
```

- **`case.create`** needs `queue` (its id), `entity` (what the case is about) and `reason` (what the reviewer reads, at most 500 characters). `priority` is `low`, `normal` (default), `high` or `urgent`. `correlation` is the value of the queue's key, such as an application id; without it, the key comes from the entity, the run's event and the run's decisions, as for the queue's rules. `mode` is `add_or_create` (default: add to the open case with the key) or `create` (always a new case). `links: { decisions, events, entities }` adds more to the case; the decisions of the run's decide steps and the run's event are added without being named. The step fails when the queue is disabled.
- **`case.resolve`** needs `case_id` and `category` (`approved`, `blocked`, `confirmed_fraud`, `false_positive` or `no_action`). `note`, `apply_to_decisions` (with approved or blocked) and `label_target` (with confirmed fraud or false positive) are as in [Cases](../case-management/cases.md#working-a-case); both are off unless the step sets them. A case a person resolved first is left as it is: the output has `resolved: false` and that resolution, so a later step can test it. Resolved by a workflow, the case shows `workflow:<name>@<version>` as who resolved it.
- Both write once, as record steps do. A step that waits for a person can `delay`, then `record.get` the case and test its `status`.

### Retries and failures

Each step that acts (HTTP, decide, records) can fail.

| | |
|---|---|
| `retry: { "attempts": 3 }` | 1 to 5 attempts. Default 3. The waits between them are 10 seconds, 1 minute, 10 minutes and 1 hour. |
| `on_fail: "continue"` | After the last attempt, the run goes on. The step's output is `{ "error": "…" }`. Default `fail`: the run ends as **failed**. |

Only a failure that another attempt can fix is tried again: no answer, a network error, a 5xx or a 429, a decision the model could not make. A 4xx, a missing record or an expression error fails at once.

## Run and wait

Your server can start a run and wait for its answer, as it does for a decision:

```bash
curl -s -X POST https://kairos.finic.ai/v1/workflows/payout_check/runs \
  -H "Authorization: Bearer $KAIROS_API_KEY" -H "Content-Type: application/json" \
  -d '{ "input": { "user": "user_42", "amount": 5000 }, "wait": true, "timeout_seconds": 10 }'
```

```ts
const run = await kairos.runWorkflow("payout_check", { user: "user_42", amount: 5000 }, { wait: true });
if (run.status === "done" && (run.output as { outcome: string }).outcome === "block") throw new Error("Held");
```

- The run happens **in the request**. The answer is the run, with its `status` and its [`output`](#return-and-answer).
- **200** when the run ended (`done`, `filtered`, `failed` or `cancelled`), or gave its answer with an Answer step and goes on. **202** when it did not end in the time: `timeout_seconds` was used up (default 10, at most 30), or a step failed and waits for its retry. The run then goes on in the background, as any run does; read it later with `GET /v1/workflow-runs/:id`.
- The time is checked between steps. A step that runs when the time is up finishes first, so the answer can come up to one step later: at most 15 seconds for an HTTP step.
- **No delay before the answer.** When a delay can come before the run's answer, the call is refused with 400 at once, before a run starts: `wait: steps.nap: the delay "Wait a day" comes before the answer, and the caller cannot wait for it`. The builder says it on the manual trigger, and the console's **Run and wait** is off. A delay after an [Answer step](#return-and-answer) is fine: the caller gets the answer, with 200, and the run goes on.
- A run that is waited for does not wait for a place among the [20 open runs](#runs) of its workflow.
- Send an `idempotency_key`. A retry of the same call then gives the same run, and does not run it again. The SDKs send one for you.
- If the server stops during the run, the run is not lost: it goes on in the background, 75 seconds after its time limit.

Any workflow can be waited for, whatever its trigger, when you start it with this call. In the console, the run form has **Run**, which opens the run, and **Run and wait**, which shows the output in the form.

## Expressions and templates

Conditions (`when`, `over`) are [CEL](https://cel.dev) expressions. CEL reads only what the run gives it, cannot loop for ever, and cannot change anything.

```
event.properties.amount >= 1000 && event.properties.country in ["GB", "FR"]
trigger.entity.properties.tier == "gold" || has(trigger.label)
size(steps.payees.output) > 3
trigger.decision.decision.decision == "block"
event.properties.email.endsWith("@example.com")
```

Other fields take **templates**: `{{ expression }}`. A field that is only one template keeps the type of its value, so `"{{ event.entities }}"` is an object and `"{{ event.properties.amount }}"` a number. A template inside text becomes text: `"User {{ trigger.entity.id }} was labelled"`.

| Name | What it is |
|---|---|
| `trigger` | What started the run. Its shape is in [Triggers](#triggers). |
| `event` | The event, for an app event trigger and a record trigger on events. |
| `entity`, `decision` | For a record trigger: the record, by its name, as in `trigger`. |
| `steps.<id>.output` | The output of a step that is done. |
| `item`, `index` | Inside a loop. |
| `run` | `{ id, started, workflow, version }` |
| `secrets.<NAME>` | HTTP steps only. See [HTTP request](#http-request). |

A condition must give `true` or `false`. A field that does not exist is an error in CEL; test it first with `has(…)`. An expression that fails ends the run: the same expression fails again, so it is not tried again.

## Runs

| Status | |
|---|---|
| `queued` | Waits for its job (also before the retry of a step), or for a place: a workflow has at most 20 runs open at a time. The others wait in order. |
| `running` | Runs steps now. |
| `waiting` | In a delay. |
| `done` | Each step is done. |
| `filtered` | A filter step ended it. This is not a failure. |
| `failed` | A step failed after its attempts. `error` says which, and why. |
| `cancelled` | Stopped with **Cancel the run** on the run's page, or `POST /v1/workflow-runs/:id/cancel`. No step starts after it. What a step already did stays done: an HTTP call that was sent is not taken back. |

- **One change starts one run.** Each trigger gives the run a key: the event's id, the change, the schedule's minute, the delivery id. A second start with the same key gives the same run.
- **A run continues after a crash.** It runs in segments of about 20 seconds. Each step that is done is saved, with its output, before the next starts. When the process stops, the next one continues at the first step that is not done.
- **A workflow does not start itself.** A change that one of its own runs makes does not start it again. A change that a run makes can start **other** workflows, to a depth of 3: a fourth level is a failed run that says so.
- When a workflow's runs start to fail, the workflow shows **Failing** in the list, until a run is done again.

The background work of runs is also on **Settings › Jobs**, with the jobs of webhooks and automatic decisions. A job that failed for good shows its error there, and **Run again** tries it again.

## Test a workflow

`POST /v1/workflows/test` runs a definition once, without saving it:

```json
{
  "definition": { "name": "review_withdrawals", "trigger": { … }, "steps": [ … ] },
  "input": { "event": { "type": "withdrawal", "entities": { "user": "u1" }, "properties": { "amount": 5000 } } },
  "live_steps": ["notify"],
  "mock_outputs": { "decide": { "decision": "block", "reasons": ["new_device"] } }
}
```

- **Steps that act do not act**, except the steps named in `live_steps`. An HTTP step does not call, a decide step does not decide, a record step does not write. Each shows what it **would** do, in its output, as `{ "test": true, "would": { … } }`.
- `mock_outputs` gives, by step id, the output of a step that does not act, so that the steps after it can read it.
- Conditions, filters, loops and delays run as in a real run.
- The answer is the run, with 202. Read it with `GET /v1/workflow-runs/:id`. A test run is marked `test: true`, does not wait for a place, and does not mark the workflow as failing.

## Limits

| | |
|---|---|
| Steps in a workflow | 50, inside conditions and loops too |
| Levels of conditions and loops | 3 |
| Items in one loop | 1,000 |
| One run | 30 days, delays included |
| A run that is waited for | 30 seconds (`timeout_seconds`, default 10) |
| Inputs of a manual trigger | 30 |
| Open runs of one workflow | 20; more wait in order |
| A chain of workflows | depth 3 |
| HTTP step | 15 seconds; 256 KB of the answer |
| Webhook trigger body | 1 MB |
| A draft | 512 KB of JSON |
| Retries of a step | 5 attempts |

**Not yet:** an event that a `record.create` step writes does not start other workflows. A change to an entity, a new label or a resolved decision does.

## Security

- **A workflow can do what a secret key can do** in its environment, and call the URLs in its steps. Only give the API key, or the console, to people who may do that.
- **A webhook trigger's URL is a secret.** It appears in the access logs of proxies. Make a new one when it is exposed: the old one stops at once.
- **Secrets stay on the server.** Read them with `{{ secrets.NAME }}`, and never write them in the definition. A definition is data that every version keeps, and that anyone with access can read.
- **Public-key events start nothing** unless the trigger says `allowPublic`.

## The API

All need a secret key, or the console's session, and work in the key's environment. The reference is in [API reference › Workflows](../reference/api.md#workflows).

| | |
|---|---|
| `GET /v1/workflows` | `{ workflows }`. `?archived=true` lists the archived ones. |
| `PUT /v1/workflows/:name` | `{ displayName?, enabled?, trigger, steps }`. Saves **and publishes** the next version. Refused with 400 and each problem when the definition is not valid. |
| `PUT /v1/workflows/:name/draft` | `{ displayName?, trigger, steps }`. Saves the draft. A new name makes a workflow, as a draft. |
| `DELETE /v1/workflows/:name/draft` | Drops the draft. |
| `POST /v1/workflows/:name/publish` | Makes the draft the next version. |
| `PATCH /v1/workflows/:name` | `{ enabled?, displayName? }`. Pause, activate or rename. No new version. |
| `POST /v1/workflows/:name/archive`, `/restore` | Archive or restore. |
| `DELETE /v1/workflows/:name` | Deletes it and its runs, for good. Archive keeps them. |
| `GET /v1/workflows/:name` | The live version, with `draft` when there is one. `?version=2` reads a version. |
| `GET /v1/workflows/:name/versions` | Every version. |
| `POST /v1/workflows/:name/hook` | A new URL for the webhook trigger: `{ path, hint }`. The only time the token is returned. |
| `POST /v1/workflows/:name/runs` | `{ input?, idempotency_key?, wait?, timeout_seconds? }`. Starts a run of the live version: 202, with the run. With `wait`, see [Run and wait](#run-and-wait). |
| `GET /v1/workflows/:name/runs` | The runs, newest first. 50, or up to 500 with `?limit`. |
| `GET /v1/workflow-runs/:id` | One run, with each step's output. |
| `POST /v1/workflow-runs/:id/cancel` | Cancels an open run. |
| `POST /v1/workflows/test` | Runs a definition once, without saving it. See [Test a workflow](#test-a-workflow). |
| `GET` / `POST` / `PUT /v1/workflow-hooks/:token` | A call to a webhook trigger. **No API key.** |

## A complete example

When a user gets the `chargeback` label, find the payees they paid in the last withdrawals, label each one, and tell your case tool.

```bash
curl -s -X PUT https://kairos.finic.ai/v1/workflows/chargeback_payees \
  -H "Authorization: Bearer $KAIROS_API_KEY" -H "Content-Type: application/json" \
  -d @- <<'JSON'
{
  "displayName": "Label the payees of a chargeback",
  "trigger": { "type": "record", "record": "entity", "on": "labelled", "entity": "user", "label": "chargeback" },
  "steps": [
    {
      "id": "withdrawals", "name": "Their withdrawals", "type": "record.search",
      "record": "event", "entity": "user", "record_id": "{{ trigger.entity.id }}",
      "types": ["withdrawal"], "limit": 20
    },
    {
      "id": "any", "name": "Any withdrawals", "type": "filter",
      "when": "size(steps.withdrawals.output) > 0"
    },
    {
      "id": "each", "name": "Each withdrawal", "type": "loop", "over": "steps.withdrawals.output",
      "steps": [
        {
          "id": "label_payee", "name": "Label the payee", "type": "record.update",
          "record": "object", "entity": "payee", "record_id": "{{ item.entities.payee }}",
          "add_label": "chargeback_payee", "on_fail": "continue"
        }
      ]
    },
    {
      "id": "tell", "name": "Tell the case tool", "type": "http", "method": "POST",
      "url": "https://cases.example.com/api/alerts",
      "headers": { "Authorization": "Bearer {{ secrets.CASES_TOKEN }}" },
      "body": { "user": "{{ trigger.entity.id }}", "payees": "{{ size(steps.withdrawals.output) }}" }
    }
  ]
}
JSON
```

Then label a user, and read the run:

```bash
curl -s -X POST https://kairos.finic.ai/v1/labels \
  -H "Authorization: Bearer $KAIROS_API_KEY" -H "Content-Type: application/json" \
  -d '{ "batch": [{ "entity": { "type": "user", "id": "user_42" }, "label": "chargeback" }] }'

curl -s "https://kairos.finic.ai/v1/workflows/chargeback_payees/runs?limit=1" \
  -H "Authorization: Bearer $KAIROS_API_KEY"
```

Each payee's label is a change too: a workflow with a record trigger on `labelled` payees can go on from there.
