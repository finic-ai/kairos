"""Run the Python SDK against a running Kairos server, end to end, with the real network.

    python3 packages/sdk-python/examples/live_check.py            # http://localhost:8787
    KAIROS_URL=https://kairos.example.com python3 …/live_check.py

It signs up a throwaway account, works in that account's workspace through the SDK, checks
what the server stored, and deletes the account at the end. Two calls are real decisions.
"""

from __future__ import annotations

import json
import os
import secrets
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from kairos import Kairos, KairosApiError, KairosError, KairosTimeoutError

BASE = os.environ.get("KAIROS_URL", "http://localhost:8787")
run = secrets.token_hex(4)
passed = 0
failed: list[str] = []


def http(method: str, path: str, body: Any = None, cookie: str = "", key: str = "") -> tuple[int, Any, str]:
    headers = {"Content-Type": "application/json", **({"Cookie": cookie} if cookie else {}), **({"Authorization": f"Bearer {key}"} if key else {})}
    request = urllib.request.Request(BASE + path, data=None if body is None else json.dumps(body).encode(), method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, json.loads(response.read() or b"null"), (response.headers.get("set-cookie") or "").split(";")[0]
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read() or b"null"), ""


def check(name: str, ok: bool, detail: Any = "") -> None:
    global passed
    if ok:
        passed += 1
    else:
        failed.append(name)
    print(f"{' ok ' if ok else 'FAIL'}  {name}{'' if ok else f' — {detail}'}")


email, password = f"py-{run}@example.test", secrets.token_urlsafe(12)
status, me, cookie = http("POST", "/auth/signup", {"email": email, "password": password, "name": "Python check"})
if status != 200:
    sys.exit(f"Sign-up failed ({status}). Is the server running, and is sign-up open?")
workspace = me["workspaces"][0]["id"]
try:
    _, made, _ = http("POST", f"/app/workspaces/{workspace}/keys", {"name": "python", "kind": "secret"}, cookie)
    _, public, _ = http("POST", f"/app/workspaces/{workspace}/keys", {"name": "python web", "kind": "public"}, cookie)
    secret = made["secret"]
    errors: list[Exception] = []
    now = datetime.now(timezone.utc)
    ago = lambda minutes: now - timedelta(minutes=minutes)
    user, session = f"user_{run}", f"sess_{run}"

    with Kairos(secret, base_url=BASE, decide_timeout=20, on_error=errors.append) as kairos:
        action = kairos.define_action(
            "py_withdrawal",
            {
                "displayName": "Withdrawal (Python)",
                "subject": "user",
                "hold": "Should this withdrawal be held because the account shows signs of having been taken over?",
                "reasons": {"new_device": "The request comes from a device the user has not used before", "credentials_changed": "The password was changed shortly before the request"},
                "trigger": "withdrawal_requested",
                "context": {"totals": [{"name": "money_out", "event": "withdrawal", "sum": "usd", "window": "session"}]},
            },
        )
        check("define_action returns the stored version", action.get("version") == 1 and action.get("name") == "py_withdrawal", action)
        check("define_action again changes nothing", kairos.define_action("py_withdrawal", {k: v for k, v in action.items() if k not in ("name", "version")}).get("version") == 1)
        check("define_entity", kairos.define_entity("device", {"kind": "device", "link": True}).get("type") == "device")
        kairos.entity("user", user, {"kyc_country": "GB", "opened": datetime(2024, 3, 2).date()})

        for week in range(8, 0, -1):
            kairos.track("login", {"user_id": user, "device_id": f"dev_phone_{run}", "ip_country": "GB"}, session=f"{session}_w{week}", timestamp=ago(week * 7 * 24 * 60))
        kairos.track("login", {"user_id": user, "device_id": f"dev_unknown_{run}", "ip_country": "RO"}, session=session, timestamp=ago(4))
        kairos.track("password_changed", {"user_id": user}, session=session, timestamp=ago(3.5), set={"password_changed_at": ago(3.5)})
        kairos.track("withdrawal", {"user_id": user, "usd": Decimal("450.00"), "payee_id": f"payee_{run}"}, session=session, timestamp=ago(1), universal_id=f"txn_{run}", status="completed")

        decision = kairos.decide("py_withdrawal", {"user_id": user, "device_id": f"dev_unknown_{run}", "usd": 2400}, session=session)
        check("decide answers with a decision", decision.decision in ("approve", "step_up", "review", "block") and not decision.fallback and bool(decision.decision_id), decision)
        check("decide sent the queued events first", errors == [] and http("GET", "/v1/stats", key=secret)[1]["events"] == 11, errors)
        print(f"      {decision.decision}  risk {decision.risk_score}  {', '.join(decision.reasons)}")

        _, stored, _ = http("GET", f"/v1/decisions/{decision.decision_id}", key=secret)
        steps = stored["context"].get("this_session", {}).get("steps", [])
        check("the decision saw its session", stored.get("session") == session and steps == ["+0:00 login", "+0:30 password_changed", "+3:00 withdrawal (completed)"], steps)
        check("the decision saw the session total", stored["context"].get("totals", {}).get("money_out_this_session") == {"sum": 450, "events": 1}, stored["context"].get("totals"))

        by_event = kairos.track_and_decide("withdrawal_requested", {"user_id": user, "device_id": f"dev_unknown_{run}", "usd": 2400}, session=session, event_id=f"w_{run}")
        check("track_and_decide answers, and names its event", by_event.event_id == f"w_{run}" and bool(by_event.decision_id), by_event)
        again = kairos.track_and_decide("withdrawal_requested", {"user_id": user, "usd": 2400}, session=session, event_id=f"w_{run}")
        check("the same event id gives the same decision", again.decision_id == by_event.decision_id, again)

        kairos.label({"type": "user", "id": user}, "fraud_confirmed", {"source": "python check"})
        _, entity, _ = http("GET", f"/v1/entities/user/{user}", key=secret)
        check("entity, set and label reached the server", entity["properties"].get("kyc_country") == "GB" and entity["properties"].get("opened") == "2024-03-02" and "password_changed_at" in entity["properties"] and [x["label"] for x in entity["labels"]] == ["fraud_confirmed"], entity["properties"])
        check("the entity lists its sessions", entity["sessions"][0]["id"] == session and len(entity["sessions"]) == 9, [x["id"] for x in entity["sessions"]][:2])
        _, record, _ = http("GET", f"/v1/records/txn_{run}", key=secret)
        check("a Decimal amount arrived as a number", record["stages"][0]["properties"]["usd"] == 450, record["stages"][0]["properties"])

        try:
            kairos.decide("no_such_action", {"user_id": user})
            check("an unknown action raises", False)
        except KairosApiError as error:
            check("an unknown action raises KairosApiError 404", error.status == 404 and "unknown_action" in error.body, error)
        try:
            kairos.define_action("broken", {"subject": "user"})
            check("an invalid action raises", False)
        except KairosApiError as error:
            check("an invalid action raises KairosApiError 400", error.status == 400, error)

    with Kairos(public["secret"], base_url=BASE, on_error=errors.append) as web:
        web.track("page_view", {"user_id": user, "path": "/pricing"})
    check("a public key sends events", errors == [], errors)
    with Kairos(public["secret"], base_url=BASE, on_error=errors.append) as web:
        web.track("page_view", {"user_id": user}, set={"plan": "hacked"})
    check("a public key cannot set properties: the error goes to on_error", len(errors) == 1 and getattr(errors[0], "status", 0) == 403, errors)
    try:
        Kairos(public["secret"], base_url=BASE).decide("py_withdrawal", {"user_id": user})
        check("a public key cannot decide", False)
    except KairosApiError as error:
        check("a public key cannot decide: 403", error.status == 403, error)
    try:
        Kairos("ksk_not_a_key", base_url=BASE).decide("py_withdrawal", {"user_id": user})
        check("an unknown key raises", False)
    except KairosApiError as error:
        check("an unknown key raises 401", error.status == 401, error)

    # A server that is not there: a refused connection, then an address that does not answer.
    fallback = Kairos(secret, base_url="http://127.0.0.1:9", max_retries=1).decide("py_withdrawal", {"user_id": user}, fallback="review", timeout=2)
    check("a refused connection gives the fallback", fallback.fallback and fallback.decision == "review" and isinstance(fallback.error, KairosError), fallback.error)
    try:
        Kairos(secret, base_url="http://10.255.255.1", max_retries=0).decide("py_withdrawal", {"user_id": user}, timeout=0.5)
        check("no answer raises", False)
    except KairosTimeoutError:
        check("no answer in time raises KairosTimeoutError", True)
    except KairosError as error:
        check("no answer in time raises KairosTimeoutError", False, repr(error))
finally:
    status, _, _ = http("DELETE", "/auth/me", {"password": password}, cookie)
    check("the throwaway account is deleted", status == 200)

print(f"\n{passed} passed, {len(failed)} failed")
sys.exit(1 if failed else 0)
