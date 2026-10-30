# finic-kairos

Python client for Kairos. Track financial events, then ask for a decision at the moment of action.

- Python 3.9 or later
- No dependencies: the standard library only
- Typed (`py.typed`), and safe to use from several threads

This page is the short version. The full [Python SDK guide](https://kairos.finic.ai/docs/reference/clients/python) covers every call, and the [TypeScript guide](https://kairos.finic.ai/docs/reference/clients/typescript) explains actions, labels, links and how to get good decisions in depth.

## Install

Install it from PyPI:

```bash
pip install finic-kairos
```

## Use

```python
import os
from kairos import Kairos

kairos = Kairos(os.environ["KAIROS_API_KEY"])

# Once, at startup: say what you want decided, in plain language.
kairos.define_action("bank_transfer", {
    "subject": "user",
    "hold": "Should the pending bank transfer be held because the account shows signs of fraud or account takeover?",
    "reasons": {
        "new_device": "The current session uses a device that the account did not use before",
        "new_beneficiary": "The transfer goes to a beneficiary that was added recently",
    },
})

# Anywhere: record what happens. Any event type, any properties.
# A key that ends in _id names an entity: user_id is the entity "user".
kairos.track("transaction", {
    "user_id": "user_123",
    "account_id": "account_456",
    "recipient_id": "recipient_789",
    "amount": 9500,
    "currency": "USD",
})

# At the moment of action: ask.
decision = kairos.decide(
    "bank_transfer",
    {"user_id": "user_123", "recipient_id": "recipient_789", "amount": 9500},
    fallback="review",
)

if decision.decision == "approve":
    ...  # release the transfer
```

`track` returns at once and sends in the background. `decide` waits for the answer, sends what is queued first, and returns the `fallback` when Kairos cannot answer.

## In a web framework

`KairosASGI` takes the user and the session from the request, for FastAPI, Starlette and any other ASGI framework. It can also send an event for a route that has no `track` call.

```python
from kairos.middleware import KairosASGI

app.add_middleware(
    KairosASGI,
    client=kairos,
    entities=lambda scope: {"user": scope["state"].get("user_id")},
    session=lambda scope: scope["state"].get("session_id"),
    routes={"PUT /account/password": "password_changed"},
)

kairos.track("transaction", {"amount": 900})  # the user and the session come from the request
```

See [In a web framework](https://kairos.finic.ai/docs/reference/clients/python#in-a-web-framework).

## Import history from files

```bash
python -m kairos import events transactions.csv --type transaction --ts created_at --id txn_id --dry-run
```

See [Import your history](https://kairos.finic.ai/docs/getting-started/import-history).

## Test

```bash
python3 -m unittest discover -s packages/sdk-python/tests     # no network
python3 packages/sdk-python/examples/live_check.py            # against a running server
```
