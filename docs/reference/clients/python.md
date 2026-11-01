# Using the Kairos Python SDK

Each API key belongs to one workspace and environment. Use the appropriate key for Production or a sandbox; the SDK needs no additional scope parameters. Separate clients with different keys can target different environments.

The Python client, `finic-kairos`. It does what the [TypeScript SDK](typescript.md) does, with Python names.

This page covers every call. For the ideas behind them (how to write a hold question, where a label belongs, how links work, how to get good decisions) read the [TypeScript guide](typescript.md): the advice there is about Kairos, not about a language. For the HTTP API underneath, see the [API reference](../api.md).

- [Install](#install)
- [Create the client](#create-the-client)
- [Track events](#track-events)
- [Entities and their properties](#entities-and-their-properties)
- [Records that change](#records-that-change)
- [Sessions](#sessions)
- [Define an action](#define-an-action)
- [Ask for a decision](#ask-for-a-decision)
- [Decide from an event](#decide-from-an-event)
- [Labels](#labels)
- [Delivery, failure and shutdown](#delivery-failure-and-shutdown)
- [In a web framework](#in-a-web-framework)
- [Backtesting](#backtesting)
- [Import from files](#import-from-files)
- [Reference](#reference)
- [Differences from the TypeScript SDK](#differences-from-the-typescript-sdk)

## Install

Python 3.9 or later. The client has no dependencies: it uses the standard library only.

Install it from PyPI:

```bash
pip install finic-kairos
```

## Create the client

One client for the process. It is safe to use from several threads.

```python
import os
from kairos import Kairos

kairos = Kairos(os.environ["KAIROS_API_KEY"])
```

Use a secret key (`ksk_…`) on a server. Make one in the console, under **Settings › API keys**.

## Track events

```python
kairos.track("login", {"user_id": "user_42", "device_id": "dev_9", "ip_country": "GB"})
```

`track` returns at once. Events are sent in batches, in the background.

**A key that ends in `_id` names an entity.** `user_id` is the entity `user`, `bank_account_id` is `bank_account`. Everything else is a property of the event. An event needs at least one entity. For a reference that does not follow the naming, pass `entities`:

```python
kairos.track("payment", {"user_id": "user_42", "amount": 40}, entities={"ip": "203.0.113.7"})
```

What is about the event itself is a keyword argument:

```python
from datetime import datetime, timezone

kairos.track(
    "deposit",
    {"user_id": "user_42", "usd": 500},
    timestamp=datetime(2026, 10, 6, 13, 58, tzinfo=timezone.utc),  # when it happened; default now
    event_id="dep_881",                                            # your own id: makes a retry idempotent
)
```

A `datetime` with no time zone is read as UTC. An ISO 8601 string works too.

Values that are common in a Python backend are sent as you would expect: a `Decimal` as a number, a `date` or `datetime` as ISO text, a `UUID` as text, a `set` or `tuple` as a list. A value that cannot be sent raises `KairosError` at the call, not later in the background.

## Entities and their properties

An entity exists as soon as an event names it. To record what is known about it, set properties from the event that carries the fact:

```python
kairos.track("kyc_completed", {"user_id": "user_42"}, set={"kyc_level": "full"}, set_once={"first_verified": "2026-10-06"})
```

`set` replaces a value unless a later event already set it, so events can arrive in any order. `set_once` fills a property only when it has no value. When the event names more than one entity, say which:

```python
kairos.track("login", {"user_id": "user_42", "device_id": "dev_9"}, set={"user": {"last_country": "GB"}, "device": {"os": "ios"}})
```

Or write to an entity directly, for customers you already have:

```python
kairos.entity("user", "user_42", {"kyc_country": "GB", "plan": "pro"})
```

To describe an entity type, and to say whether sharing one links two subjects:

```python
kairos.define_entity("merchant", {"kind": "business", "description": "A shop that takes card payments", "link": False})
```

## Records that change

A transaction is pending, then completed. Send each stage with the same `universal_id` and a `status`. A decision sees one record in its latest state.

```python
kairos.track("transaction", {"user_id": "user_42", "usd": 500}, universal_id="txn_881", status="pending")
kairos.track("transaction", {"user_id": "user_42"}, universal_id="txn_881", status="completed")
```

## Sessions

Send the id of your own login session with every event and every decision of a visit. A decision then sees what happened in its visit before it, and how fast.

```python
kairos.track("login", {"user_id": "user_42", "device_id": "dev_9"}, session="sess_7f3a")
kairos.track("password_changed", {"user_id": "user_42"}, session="sess_7f3a")
decision = kairos.decide("withdrawal", {"user_id": "user_42", "usd": 2400}, session="sess_7f3a")
```

`session` is not an entity. A key named `session_id` is still an entity of your own called "session".

## Define an action

An action is a decision you want made, in plain language. Define it once, at startup: sending the same definition again changes nothing.

```python
kairos.define_action("withdrawal", {
    "displayName": "Withdrawal",
    "subject": "user",
    "hold": "Should this withdrawal be held because the account shows signs of fraud or takeover?",
    "reasons": {
        "new_device": "The request comes from a device the user has not used before",
        "credentials_changed": "The password or the email address was changed shortly before the request",
    },
    "policy": {"block": 0.9, "review": 0.5},
    "context": {"totals": [{"name": "money_out", "event": "withdrawal", "sum": "usd", "window": "session"}]},
})
```

The definition is the same JSON as in the [API reference](../api.md#put-v1actionsname), with the same keys. It returns the stored definition with its `name` and `version`.

## Ask for a decision

```python
decision = kairos.decide(
    "withdrawal",
    {"user_id": "user_42", "device_id": "dev_9", "usd": 900},
    fallback="review",
)

if decision.decision == "block":
    raise WithdrawalHeld(decision.reasons)
```

`decide` sends the queued events first, so the decision sees everything you tracked before the call. Then it waits for the answer.

| Field of `Decision` | |
|---|---|
| `decision` | `"approve"`, `"step_up"`, `"review"` or `"block"` |
| `risk_score` | 0 to 100 |
| `probability` | The probability that the action should be held, 0 to 1 |
| `reasons` | The signals judged present |
| `typology` | The most likely explanation, or `None` |
| `rules` | The policy rules that fired |
| `action` | The action and version: `"withdrawal@2"` |
| `decision_id` | The id of the stored decision |
| `event_id` | The event that started it, from `track_and_decide` |
| `fallback` | `True` when this is your `fallback`, not an answer |
| `error` | With `fallback`: why Kairos could not answer |

**Always decide what happens when Kairos cannot answer.** With `fallback`, a timeout, an outage or an error from the API returns that outcome, with `fallback=True`. Without it, `decide` raises. Choose for each decision: `"approve"` fails open, `"review"` fails closed.

`timeout` is the limit for the whole call in seconds, with its retries. The default is 3 seconds.

## Decide from an event

When the request is itself an event (a withdrawal was requested, an application was submitted), give an action that event as its `trigger`, and make one call. The event is stored, and it is the pending action of the decision.

```python
kairos.define_action("withdrawal", {…, "trigger": "withdrawal_requested"})

decision = kairos.track_and_decide(
    "withdrawal_requested",
    {"user_id": "user_42", "usd": 900},
    session="sess_7f3a",
    fallback="review",
)
```

It takes the arguments of `track`, and `fallback`, `timeout` and `flush`. If Kairos cannot be reached, the event is queued, so the history keeps it.

## Labels

When you learn the truth, say so. A label is what lets one confirmed fraud show up in the decisions about everyone linked to it.

```python
kairos.label({"type": "user", "id": "user_42"}, "fraud_confirmed", {"source": "chargeback"})
```

`timestamp=` is when the outcome became known. The default is now.

## Delivery, failure and shutdown

- **`track` never raises for a delivery failure.** It raises `KairosError` only for an invalid call. A failed upload goes to `on_error`, and the events stay queued for the next send. A batch that the API refused with a status that is not tried again is dropped.
- **Retries.** A network failure, 408, 429, 500, 502, 503 or 504 is tried again, up to `max_retries` times, with a growing wait. Another status is not: the API said no.
- **The queue has a limit.** Past `max_queue_size` (10,000) the oldest events are dropped, and `on_error` is told.
- **Order is kept.** One upload at a time, so events arrive in the order you tracked them.
- **Call `shutdown()` before the process exits**, or use the client as a context manager. The client also flushes when the interpreter ends, for a process that forgets, but a process that is killed loses what was queued.

```python
kairos = Kairos(api_key, on_error=lambda error: logger.warning("kairos: %s", error))

with Kairos(api_key) as kairos:      # a script
    kairos.track("import_started", {"user_id": "user_42"})
```

| Exception | When |
|---|---|
| `KairosError` | The base of the others. Raised directly for an invalid call and for a network failure. |
| `KairosApiError` | The API answered with an error. It has `status`, `body` and `request_id`. |
| `KairosTimeoutError` | No answer arrived inside the time limit. |
| `KairosWebhookError` | `verify_webhook` refused a delivery. |

## In a web framework

- **Create one client for each process, after the process starts.** With a server that forks workers (gunicorn, uWSGI), create the client in the worker, not before the fork: a thread and a queue made before a fork do not survive it.
- **Django and Flask:** call the client from your views. `track` costs microseconds. `decide` blocks for the decision, which is what you want before you release the action.
- **FastAPI and other async code:** the client is synchronous. `track` is safe to call as it is. Run `decide` in a thread, so that it does not block the event loop:

```python
import asyncio

decision = await asyncio.to_thread(kairos.decide, "withdrawal", {"user_id": user_id, "usd": amount}, fallback="review")
```

### The context of a request

In a web application, every call needs the same things: the user, the device, the IP address and the session. `KairosASGI` takes them from the request, so that a call gives only what is particular to it. It is for FastAPI, Starlette and any other ASGI framework. It is optional, and it does not replace `track`.

```python
from kairos.middleware import KairosASGI

app.add_middleware(
    KairosASGI,
    client=kairos,
    entities=lambda scope: {"user": scope["state"].get("user_id"), "ip": scope["client"][0]},
    session=lambda scope: scope["state"].get("session_id"),
)

# Anywhere in the request: no user_id, no ip_id, no session.
kairos.track("transaction", {"amount": 900, "currency": "GBP", "direction": "out"})
decision = await asyncio.to_thread(kairos.decide, "withdrawal", {"usd": 900}, fallback="review")
```

The functions receive the ASGI scope. `scope["state"]` is what Starlette and FastAPI show as `request.state`, so a dependency that sets `request.state.user_id` is enough. They run when a call is made, not when the request arrives, so they see what your sign-in put there.

The rules are those of the TypeScript SDK; the [TypeScript guide](typescript.md#how-a-call-gets-its-context) gives the reasons.

- **What the call names wins.** `session=""` is no session; leave it out for the session of the request.
- **A call about someone else takes nothing from the request.** `kairos.track("contact_changed", {"user_id": customer_id})` in a request of a support agent does not get the agent's device or session. The rule is on the entity type of `subject`, which is `"user"` by default.
- **A function that raises does not fail the request.** The error goes to `on_error`.
- **The context follows the request** into a thread (`asyncio.to_thread`, a sync FastAPI endpoint) and into the tasks it starts.

When the code knows more than the request:

```python
# A sign-in handler learns the user and makes the session itself.
kairos.set_context({"user": user.id}, session=session.id)

# Work with no request: a queue worker, a scheduled job, a test.
with kairos.context({"user": job.user_id, "device": job.device_id}, session=job.session_id):
    settle(job)

# Work inside a request that is about other people.
with kairos.without_context():
    notify_payees(batch)
```

**Flask and Django** have no middleware yet. Open the context yourself, after your sign-in has run: `with kairos.context({"user": request.user.id}, session=request.session.session_key):` around the view.

### Events for routes

Name the routes that are worth knowing for the fact alone, and the middleware sends an event when the response finishes:

```python
app.add_middleware(
    KairosASGI,
    client=kairos,
    entities=lambda scope: {"user": scope["state"].get("user_id")},
    session=lambda scope: scope["state"].get("session_id"),
    routes={
        "PUT /account/password": {"type": "password_changed", "failed": "password_change_failed"},
        "POST /api/payees": "beneficiary_added",
        "POST /api/payees/{payee_id}/verify": {"type": "beneficiary_verified", "properties": lambda scope: {"payee_id": scope["path_params"]["payee_id"]}},
    },
)
```

The key is the method and the route as you registered it, with its prefix: `/api/payees/{payee_id}`, not `/api/payees/p_7`. The event has `source: "auto"`, `http_method`, `http_route` and `http_status`, and the entities and the session of the request.

- A status below 400 sends `type`. A 4xx sends `failed`, if the route has one. A 5xx sends nothing.
- A request with no entity sends nothing, and nothing is raised.
- If the handler tracked the same event type, the route's event is left out.
- `routes` do not read the request body. `properties` is the only way data gets onto the event.
- The route comes from `scope["route"]`, which Starlette and FastAPI set. With a framework that does not, no event is sent.
- In a serverless function, pass `flush=True`: the queue is sent before the request ends.

See [Events for routes](typescript.md#events-for-routes) in the TypeScript guide for what a decision sees and when to use `track`.

### Routes from the console

The routes can also come from **Settings › Integrations › Client settings**, where a person changes them with no deployment:

```python
app.add_middleware(
    KairosASGI,
    client=kairos,
    entities=lambda scope: {"user": scope["state"].get("user_id")},
    client_settings=True,
    hash_key=os.environ["KAIROS_HASH_KEY"],
)
```

It works as in the TypeScript middleware: see [Routes from the console](typescript.md#routes-from-the-console). In Python:

- The settings are read in a thread when the middleware starts, and again each minute. A request never waits for them.
- A route matches the path of the request, such as `POST /api/payees/:id`: the console's form, not FastAPI's `{payee_id}`.
- **Decide on request** asks for a decision before your app runs, in a thread, and puts it on `scope["state"]["kairos_decision"]`, which FastAPI shows as `request.state.kairos_decision`. With the route mode **Active** and the route's **Enforce** on, a `block` answers with the route's block response, and a `step_up` with a step-up page redirects.
- The `kairos_device` cookie of the [JavaScript tag](browser.md#the-device) gives the `device` entity when `entities` gives none, and its `kairos_visit` cookie gives the session when `session` and the settings' session cookie give none.
- Behind the [Kairos edge](edge.md#with-the-middleware-on-your-servers), the middleware sends the events of a route, and takes the edge's decision for a route that decides on the request. Give both the same hash key.
- A route with body fields reads the body before your app, and gives your app the same body. It reads only JSON, so a file upload is never read, and stops at 128 KB: past it, your app gets the rest as it comes, and the body fields are left out.

## Backtesting

`timestamp` on `decide` decides as of a past moment: the decision sees only the events and labels up to it. Send your history with its real timestamps, then ask what Kairos would have said.

```python
then = kairos.decide("withdrawal", {"user_id": "user_42", "usd": 900}, timestamp="2026-09-01T12:00:00Z")
```

## Import from files

The SDK also loads history from CSV and JSON-lines files: `python -m kairos import events transactions.csv --type transaction --ts created_at`. See [Import your history](../../getting-started/import-history.md).

## Train a scoring model

`python -m kairos train` trains an XGBoost model on the runs of a workflow and the labels that came after them, and uploads it as the next version of a model. XGBoost is an optional extra, so the client itself still needs nothing but the standard library:

```bash
pip install "finic-kairos[train]"
python -m kairos train model.json            # train, and upload
python -m kairos train model.json --out ./m  # also write model.json and upload.json
python -m kairos train model.json --out ./m --no-upload
```

The key comes from `--api-key` or `KAIROS_API_KEY`. The server is `https://kairos.finic.ai`, or `--url` (or `KAIROS_URL`) for a self-hosted one. It exits with 0 when it trained (and uploaded); 1 when the config, the training or Kairos refused, with the reason; and 2 for a wrong command, no key, or a config file that is not there or is not JSON. The config file and each step are in [Models](../../platform/models.md#4-train).

In code, `kairos.training` has the same parts: `TrainingConfig.from_dict`, `fetch_rows`, `train`, `upload_body`, `upload` and `run`.

## Reference

### `Kairos(api_key, **options)`

| Option | Default | |
|---|---|---|
| `api_key` | required | A secret key (`ksk_…`, server side only) or a public key (`kpk_…`, sends events only). |
| `base_url` | `https://kairos.finic.ai` | The address of Kairos. Set it only for a self-hosted server. |
| `flush_at` | 20 | The queue size that starts a send. |
| `flush_interval` | 2.0 | Send at least this often, in seconds. 0 turns the timer off. |
| `max_queue_size` | 10000 | Events kept while the API cannot be reached. |
| `timeout` | 10.0 | Seconds for one event upload, and for the calls that define, label and resolve, and `run_workflow` without `wait`. |
| `decide_timeout` | 3.0 | Seconds for one decision, including retries. |
| `max_retries` | 3 | Retries after a network failure, 408, 429, 500, 502, 503 or 504. |
| `on_error` | none | Called with the error for a delivery failure and for dropped events. |
| `transport` | the standard library | Sends one request. Supply your own for a proxy or for tests. |

### Methods

| Method | Returns | Notes |
|---|---|---|
| `track(type, properties=None, *, timestamp, event_id, universal_id, status, session, set, set_once, entities)` | `None` | Queued. |
| `decide(action, properties=None, *, session, entities, fallback, timeout, timestamp, flush=True)` | `Decision` | Sends the queue first. |
| `track_and_decide(type, properties=None, *, fallback, timeout, flush=True, …the arguments of track)` | `Decision` | Stores the event and runs the action it starts. |
| `define_action(name, definition)` | `dict` | Idempotent. A change makes a new version. |
| `define_entity(type, definition=None)` | `dict` | Optional. |
| `entity(type, id, properties=None)` | `None` | Creates or updates one entity. Properties are merged. |
| `set_object(type, id, properties)` | `None` | What `entity()` uses underneath. |
| `label(entity, label, properties=None, *, timestamp)` | `None` | |
| `resolve(decision_id, outcome, *, note, by)` | `dict` | A person's decision on a decision: `outcome` is `"approve"` or `"block"`. Returns the decision with its new `revision`, `resolution` and `final_outcome`. |
| `run_workflow(name, input=None, *, wait=False, timeout_seconds, idempotency_key)` | `dict` | Starts a run of a workflow, and returns it. With `wait`, its `output` too. See [Run and wait](../../platform/workflows.md#run-and-wait). |
| `client_settings()` | `dict` | The client settings of the key's environment. See [Client settings](../api.md#client-settings). |
| `flush()` | `None` | Sends the queue and waits. |
| `shutdown()` | `None` | Flushes and closes the client. |
| `context(entities=None, *, session, subject="user")` | a context manager | Says who is acting, for the calls in the block. |
| `set_context(entities=None, *, session)` | `None` | The same, from inside a request. Wins over the middleware. |
| `without_context()` | a context manager | The block has no context. |

### `KairosASGI(app, *, client, **options)`

| Option | Default | |
|---|---|---|
| `client` | required | The Kairos client. |
| `entities` | none | `lambda scope: {"user": …, "device": …}`. Entity type → id. An empty value is left out. |
| `session` | none | `lambda scope: id`. The login session in your own system. |
| `subject` | `"user"` | The entity type of the person who makes the request. |
| `routes` | none | `"METHOD /pattern"` → an event type, or `{"type", "failed", "properties"}`. |
| `flush` | `False` | Send the queue before the request ends, when a route sent an event. |
| `client_settings` | `False` | `True` also runs the routes of the client settings. See [Routes from the console](#routes-from-the-console). |
| `hash_key` | none | The secret for hashed fields and cookies. |

### `verify_webhook(body, headers, secret, *, tolerance_seconds=300, now=None)`

Checks a delivery from an outbound webhook and returns the message as a `dict`. Pass the body exactly as it arrived, before any JSON parsing. `secret` is the endpoint's `whsec_…` secret; during a rotation, pass a list of the old and the new one. A delivery with no matching signature, or with a `webhook-timestamp` more than `tolerance_seconds` from now, raises `KairosWebhookError`.

Limits are those of the API: see the [TypeScript guide](typescript.md#limits).

## Differences from the TypeScript SDK

| | TypeScript | Python |
|---|---|---|
| Names | `trackAndDecide`, `riskScore`, `userId` | `track_and_decide`, `risk_score`, `user_id` |
| Entity keys | End in `Id` or `_id` | The same. `userId` works too. |
| Special fields | Keys of the properties: `$session`, `$set`, `eventId`, … | Keyword arguments: `session=`, `set=`, `event_id=`, … The keys work too. |
| `decide` | `decide({ type: "withdrawal", … })` | `decide("withdrawal", {…})`. The dict form works too. |
| Waiting | `await` | The calls block. `track` does not. |
| Times | Milliseconds | Seconds |
| At exit | Call `shutdown()` | Call `shutdown()`. The client also flushes when the interpreter ends. |
| Request context | `@finic-ai/kairos/middleware`: Express and Hono, `setContext`, `runWithContext` | `kairos.middleware.KairosASGI`, and the methods `set_context`, `context`, `without_context` |
| No session for one call | `$session: null` | `session=""` |
| A client on the request | `req.kairos`, `c.get("kairos")` | None. A context variable is not lost between the middleware and the handler. |
