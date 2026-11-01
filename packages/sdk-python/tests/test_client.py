"""Tests for the Kairos Python client. Standard library only:

    python3 -m unittest discover -s packages/sdk-python/tests
"""

from __future__ import annotations

import json
import sys
import threading
import time
import unittest
from collections.abc import Mapping
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from kairos import Decision, Kairos, KairosApiError, KairosError, KairosTimeoutError

DECISION = {"decision": "review", "risk_score": 87, "probability": 0.87, "reasons": ["new_device"], "rules": [], "action": "bank_transfer@1", "decision_id": "kdec_1"}
Answer = Callable[[dict[str, Any]], tuple[int, Any]]


class Server:
    """A transport that records what it is sent and answers as the test says."""

    def __init__(self, answer: Answer | None = None) -> None:
        self.calls: list[dict[str, Any]] = []
        self.answer: Answer = answer or (lambda call: (202, {"accepted": 1, "duplicates": 0}) if call["path"] == "/v1/events" else (200, DECISION))
        self.lock = threading.Lock()

    def __call__(self, method: str, url: str, headers: dict[str, str], body: bytes, timeout: float) -> tuple[int, bytes, Mapping[str, str]]:
        call = {"method": method, "path": url.replace("https://k.test", ""), "headers": headers, "body": json.loads(body) if body else None, "timeout": timeout}
        with self.lock:
            self.calls.append(call)
        status, answer = self.answer(call)
        return status, json.dumps(answer).encode(), {"x-request-id": "req_1"}

    def to(self, path: str) -> list[dict[str, Any]]:
        return [c for c in self.calls if c["path"] == path]

    def events(self) -> list[dict[str, Any]]:
        return [event for call in self.to("/v1/events") for event in call["body"]["batch"]]


def client(server: Server, **options: Any) -> Kairos:
    options.setdefault("flush_interval", 0)
    options.setdefault("max_retries", 0)
    return Kairos("ksk_test", base_url="https://k.test/", transport=server, **options)


class TrackTest(unittest.TestCase):
    def test_lifts_identifiers_and_sends_the_rest_as_properties(self) -> None:
        server = Server()
        kairos = client(server)
        kairos.track("transaction", {"user_id": "u1", "bankAccountId": "acct_9", "recipient_id": 77, "amount": 9500, "note": None, "weird_id": {"x": 1}, "entities": {"ip": "1.2.3.4"}}, event_id="e1", timestamp="2026-10-01T10:00:00Z")
        kairos.flush()
        self.assertEqual(
            server.to("/v1/events")[0]["body"],
            {"batch": [{"id": "e1", "type": "transaction", "ts": "2026-10-01T10:00:00.000Z", "entities": {"ip": "1.2.3.4", "user": "u1", "bank_account": "acct_9", "recipient": "77"}, "properties": {"amount": 9500, "weird_id": {"x": 1}}}]},
        )
        self.assertEqual(server.calls[0]["headers"]["Authorization"], "Bearer ksk_test")
        self.assertEqual(server.calls[0]["method"], "POST")

    def test_takes_the_special_fields_as_arguments_or_as_keys_of_the_properties(self) -> None:
        server = Server()
        kairos = client(server)
        kairos.track("transaction", {"user_id": "u", "usd": 5}, event_id="a", universal_id="txn_1", status="pending", session="s_9", timestamp="2026-10-01T10:00:00Z")
        kairos.track("transaction", {"user_id": "u", "usd": 5, "eventId": "b", "universalId": "txn_1", "status": "completed", "$session": "s_9", "timestamp": "2026-10-01T10:05:00+01:00"})
        # A status that is not text is an ordinary property, and an argument wins over a key.
        kairos.track("check", {"user_id": "u", "status": 404, "event_id": "from_properties"}, event_id="c", timestamp="2026-10-01T10:06:00Z")
        kairos.flush()
        self.assertEqual(
            server.events(),
            [
                {"id": "a", "type": "transaction", "ts": "2026-10-01T10:00:00.000Z", "entities": {"user": "u"}, "properties": {"usd": 5}, "universal_id": "txn_1", "status": "pending", "session": "s_9"},
                {"id": "b", "type": "transaction", "ts": "2026-10-01T09:05:00.000Z", "entities": {"user": "u"}, "properties": {"usd": 5}, "universal_id": "txn_1", "status": "completed", "session": "s_9"},
                {"id": "c", "type": "check", "ts": "2026-10-01T10:06:00.000Z", "entities": {"user": "u"}, "properties": {"status": 404}},
            ],
        )

    def test_sends_set_and_set_once_for_the_entity_an_event_is_about(self) -> None:
        server = Server()
        kairos = client(server)
        kairos.track("kyc_completed", {"user_id": "u"}, set={"kyc_level": "full"}, set_once={"opened": "2021-03-04"}, event_id="e1", timestamp="2026-10-01T10:00:00Z")
        kairos.track("login", {"user_id": "u", "device_id": "d", "$set": {"user": {"last_country": "GB"}, "device": {"os": "ios"}}}, event_id="e2", timestamp="2026-10-01T10:05:00Z")
        kairos.track("login", {"user_id": "u", "$set": {}}, event_id="e3", timestamp="2026-10-01T10:06:00Z")
        kairos.flush()
        events = server.events()
        self.assertEqual(events[0]["set"], {"user": {"kyc_level": "full"}})
        self.assertEqual(events[0]["set_once"], {"user": {"opened": "2021-03-04"}})
        self.assertEqual(events[1]["set"], {"user": {"last_country": "GB"}, "device": {"os": "ios"}})
        self.assertNotIn("set", events[2])
        # With two entities, the properties must say which one they are for.
        with self.assertRaisesRegex(KairosError, "Say which entity"):
            kairos.track("login", {"user_id": "u", "device_id": "d"}, set={"os": "ios"})
        with self.assertRaisesRegex(KairosError, "must be a dict"):
            kairos.track("login", {"user_id": "u"}, set="full")  # type: ignore[arg-type]

    def test_leaves_session_id_an_entity_and_checks_the_session(self) -> None:
        server = Server()
        kairos = client(server)
        kairos.track("login", {"user_id": "u", "session_id": "own_1"}, session="s_9", event_id="e1")
        kairos.track("login", {"user_id": "u", "$session": ""}, event_id="e2")
        kairos.flush()
        self.assertEqual(server.events()[0]["entities"], {"user": "u", "session": "own_1"})
        self.assertEqual(server.events()[0]["session"], "s_9")
        self.assertNotIn("session", server.events()[1])
        with self.assertRaisesRegex(KairosError, r"\$session"):
            kairos.track("login", {"user_id": "u"}, session={"id": 1})  # type: ignore[arg-type]

    def test_sends_python_values_that_json_does_not_have(self) -> None:
        server = Server()
        kairos = client(server)
        naive = datetime(2026, 10, 1, 10, 0, 0)
        aware = datetime(2026, 10, 1, 12, 0, 0, 500000, tzinfo=timezone(timedelta(hours=2)))
        kairos.track("payment", {"user_id": "u", "amount": Decimal("12.50"), "due": date(2026, 11, 1), "seen": aware, "tags": {"a"}, "pair": (1, 2)}, timestamp=naive)
        kairos.flush()
        event = server.events()[0]
        # A datetime with no time zone is read as UTC.
        self.assertEqual(event["ts"], "2026-10-01T10:00:00.000Z")
        self.assertEqual(event["properties"], {"amount": 12.5, "due": "2026-11-01", "seen": "2026-10-01T10:00:00.500Z", "tags": ["a"], "pair": [1, 2]})

    def test_rejects_an_invalid_call_where_it_is_made(self) -> None:
        kairos = client(Server())
        with self.assertRaisesRegex(KairosError, "names no entity"):
            kairos.track("login", {"ip_country": "GB"})
        with self.assertRaisesRegex(KairosError, "needs a type"):
            kairos.track("", {"user_id": "u"})
        with self.assertRaisesRegex(KairosError, "cannot be sent as JSON"):
            kairos.track("login", {"user_id": "u", "thing": object()})
        with self.assertRaisesRegex(KairosError, "cannot be sent as JSON"):
            kairos.track("login", {"user_id": "u", "amount": float("nan")})
        with self.assertRaisesRegex(KairosError, "ISO 8601"):
            kairos.track("login", {"user_id": "u"}, timestamp="yesterday")
        with self.assertRaisesRegex(KairosError, "api_key"):
            Kairos("")
        kairos.shutdown()
        with self.assertRaisesRegex(KairosError, "after shutdown"):
            kairos.track("login", {"user_id": "u"})


class DeliveryTest(unittest.TestCase):
    def wait_for(self, condition: Callable[[], bool], seconds: float = 2.0) -> None:
        end = time.monotonic() + seconds
        while not condition() and time.monotonic() < end:
            time.sleep(0.01)
        self.assertTrue(condition())

    def test_sends_a_batch_in_the_background_when_the_queue_reaches_flush_at_in_order(self) -> None:
        server = Server()
        kairos = client(server, flush_at=3)
        for i in range(3):
            kairos.track("login", {"user_id": f"u{i}"})
        self.wait_for(lambda: len(server.events()) == 3)
        self.assertEqual([e["entities"]["user"] for e in server.events()], ["u0", "u1", "u2"])
        self.assertEqual(len(server.to("/v1/events")), 1)

    def test_sends_on_the_timer(self) -> None:
        server = Server()
        kairos = client(server, flush_interval=0.03)
        kairos.track("login", {"user_id": "u"})
        self.assertEqual(server.calls, [])
        self.wait_for(lambda: len(server.events()) == 1)

    def test_sends_more_than_500_events_in_batches(self) -> None:
        server = Server()
        kairos = client(server, flush_at=10_000)
        for i in range(1203):
            kairos.track("login", {"user_id": f"u{i}"})
        kairos.flush()
        self.assertEqual([len(c["body"]["batch"]) for c in server.to("/v1/events")], [500, 500, 203])

    def test_retries_a_server_error_and_delivers_once(self) -> None:
        answers = iter([(503, {}), (202, {"accepted": 1})])
        server = Server(lambda call: next(answers))
        kairos = client(server, max_retries=2)
        kairos.track("login", {"user_id": "u"})
        kairos.flush()
        self.assertEqual(len(server.calls), 2)
        self.assertEqual(server.calls[0]["body"], server.calls[1]["body"])

    def test_keeps_events_when_the_api_is_down_reports_the_error_and_delivers_on_the_next_flush(self) -> None:
        up = {"now": False}
        errors: list[Exception] = []
        server = Server(lambda call: (202, {}) if up["now"] else (503, {"error": "down"}))
        kairos = client(server, on_error=errors.append)
        kairos.track("login", {"user_id": "u"}, event_id="e1")
        kairos.flush()
        self.assertEqual(len(errors), 1)
        self.assertIsInstance(errors[0], KairosApiError)
        self.assertEqual((errors[0].status, errors[0].request_id), (503, "req_1"))  # type: ignore[attr-defined]
        up["now"] = True
        kairos.flush()
        self.assertEqual(server.calls[-1]["body"]["batch"][0]["id"], "e1")
        kairos.flush()
        self.assertEqual(len(server.calls), 2)

    def test_keeps_events_through_a_network_failure_and_a_timeout(self) -> None:
        errors: list[Exception] = []
        fail: dict[str, Exception | None] = {"with": OSError("connection refused")}

        def transport(method: str, url: str, headers: dict[str, str], body: bytes, timeout: float) -> tuple[int, bytes, Mapping[str, str]]:
            if fail["with"]:
                raise fail["with"]
            return 202, b"{}", {}

        kairos = Kairos("ksk_test", base_url="https://k.test", transport=transport, flush_interval=0, max_retries=0, on_error=errors.append)
        kairos.track("login", {"user_id": "u"})
        kairos.flush()
        self.assertRegex(str(errors[0]), "Network request failed: connection refused")
        fail["with"] = TimeoutError("timed out")
        kairos.flush()
        self.assertIsInstance(errors[1], KairosTimeoutError)
        fail["with"] = None
        kairos.flush()
        self.assertEqual(len(errors), 2)

    def test_drops_a_batch_the_api_rejects_as_invalid(self) -> None:
        errors: list[Exception] = []
        server = Server(lambda call: (400, {"error": {"type": "invalid_request"}}))
        kairos = client(server, on_error=errors.append)
        kairos.track("login", {"user_id": "u"})
        kairos.flush()
        kairos.flush()
        self.assertEqual(len(server.calls), 1)
        self.assertEqual(errors[0].status, 400)  # type: ignore[attr-defined]

    def test_drops_the_oldest_events_beyond_max_queue_size(self) -> None:
        errors: list[Exception] = []
        server = Server()
        kairos = client(server, flush_at=100, max_queue_size=2, on_error=errors.append)
        for i in range(4):
            kairos.track("login", {"user_id": f"u{i}"})
        kairos.flush()
        self.assertEqual([e["entities"]["user"] for e in server.events()], ["u2", "u3"])
        self.assertRegex(str(errors[0]), "dropped the 1 oldest")

    def test_a_handler_that_raises_does_not_break_tracking(self) -> None:
        def broken(error: Exception) -> None:
            raise RuntimeError("handler")

        kairos = client(Server(lambda call: (503, {})), on_error=broken)
        kairos.track("login", {"user_id": "u"})
        kairos.flush()

    def test_is_a_context_manager_that_sends_what_is_queued(self) -> None:
        server = Server()
        with client(server) as kairos:
            kairos.track("login", {"user_id": "u"})
        self.assertEqual(len(server.events()), 1)

    def test_tracks_from_many_threads_without_losing_an_event(self) -> None:
        server = Server()
        kairos = client(server, flush_at=7)
        threads = [threading.Thread(target=lambda n=n: [kairos.track("login", {"user_id": f"u{n}_{i}"}) for i in range(50)]) for n in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        kairos.shutdown()
        users = [e["entities"]["user"] for e in server.events()]
        self.assertEqual(len(users), 400)
        self.assertEqual(len(set(users)), 400)


class DecideTest(unittest.TestCase):
    def test_sends_queued_events_first_then_returns_the_decision(self) -> None:
        server = Server()
        kairos = client(server)
        kairos.track("login", {"user_id": "u", "device_id": "d"})
        decision = kairos.decide("bank_transfer", {"user_id": "u", "recipient_id": "r", "amount": 9500}, session="s_1", timestamp="2026-10-06T14:00:00Z")
        self.assertEqual([c["path"] for c in server.calls], ["/v1/events", "/v1/decide"])
        self.assertEqual(server.calls[1]["body"], {"action": "bank_transfer", "entities": {"user": "u", "recipient": "r"}, "properties": {"amount": 9500}, "session": "s_1", "ts": "2026-10-06T14:00:00.000Z"})
        self.assertEqual(decision, Decision(decision="review", risk_score=87, probability=0.87, reasons=["new_device"], rules=[], action="bank_transfer@1", decision_id="kdec_1"))
        self.assertFalse(decision.fallback)

    def test_takes_the_form_of_the_typescript_sdk_too(self) -> None:
        server = Server()
        kairos = client(server)
        kairos.decide({"type": "bank_transfer", "userId": "u", "amount": 1, "$session": "s_2"}, flush=False)
        kairos.decide("bank_transfer", {"amount": 1}, entities={"user": "u"})
        self.assertEqual(server.calls[0]["body"], {"action": "bank_transfer", "entities": {"user": "u"}, "properties": {"amount": 1}, "session": "s_2"})
        self.assertEqual(server.calls[1]["body"], {"action": "bank_transfer", "entities": {"user": "u"}, "properties": {"amount": 1}})

    def test_raises_an_api_error_without_retrying_a_client_error(self) -> None:
        server = Server(lambda call: (404, {"error": {"type": "unknown_action"}}))
        kairos = client(server, max_retries=3)
        with self.assertRaises(KairosApiError) as raised:
            kairos.decide("nothing", {"user_id": "u"})
        self.assertEqual(raised.exception.status, 404)
        self.assertIn("unknown_action", raised.exception.body)
        self.assertEqual(len(server.calls), 1)

    def test_raises_on_a_timeout_when_there_is_no_fallback_and_returns_the_fallback_when_there_is(self) -> None:
        def slow(method: str, url: str, headers: dict[str, str], body: bytes, timeout: float) -> tuple[int, bytes, Mapping[str, str]]:
            time.sleep(timeout)
            raise TimeoutError("timed out")

        kairos = Kairos("ksk_test", base_url="https://k.test", transport=slow, flush_interval=0)
        started = time.monotonic()
        with self.assertRaises(KairosTimeoutError):
            kairos.decide("bank_transfer", {"user_id": "u"}, timeout=0.05)
        self.assertLess(time.monotonic() - started, 0.5)
        decision = kairos.decide("bank_transfer", {"user_id": "u"}, timeout=0.05, fallback="review")
        self.assertEqual((decision.decision, decision.risk_score, decision.fallback), ("review", 0, True))
        self.assertIsInstance(decision.error, KairosTimeoutError)

    def test_keeps_the_whole_decision_inside_its_time_limit_with_retries(self) -> None:
        server = Server(lambda call: (503, {}))
        kairos = client(server, max_retries=50)
        started = time.monotonic()
        decision = kairos.decide("bank_transfer", {"user_id": "u"}, timeout=0.3, fallback="approve")
        self.assertLess(time.monotonic() - started, 1.0)
        self.assertTrue(decision.fallback)
        self.assertGreater(len(server.calls), 1)

    def test_returns_the_fallback_when_the_api_stays_down(self) -> None:
        kairos = client(Server(lambda call: (503, {})))
        decision = kairos.decide("bank_transfer", {"user_id": "u"}, fallback="approve")
        self.assertEqual(decision.decision, "approve")
        self.assertEqual(decision.error.status, 503)  # type: ignore[union-attr]

    def test_rejects_a_decision_with_no_identifier_or_no_action(self) -> None:
        kairos = client(Server())
        with self.assertRaisesRegex(KairosError, "names no entity"):
            kairos.decide("bank_transfer", {"amount": 5})
        with self.assertRaisesRegex(KairosError, "needs an action"):
            kairos.decide("", {"user_id": "u"})
        # An invalid call is not an outage: the fallback is not for it.
        with self.assertRaises(KairosError):
            kairos.decide("bank_transfer", {"amount": 5}, fallback="approve")


class TrackAndDecideTest(unittest.TestCase):
    def test_sends_queued_events_first_then_one_event_that_returns_its_decision(self) -> None:
        server = Server(lambda call: (202, {}) if call["path"] == "/v1/events" else (200, {**DECISION, "event_id": call["body"]["id"]}))
        kairos = client(server)
        kairos.track("login", {"user_id": "u"})
        decision = kairos.track_and_decide("withdrawal_requested", {"user_id": "u", "usd": 900}, event_id="w1", session="s_1", timestamp="2026-10-06T14:00:00Z")
        self.assertEqual([c["path"] for c in server.calls], ["/v1/events", "/v1/events/decide"])
        self.assertEqual(server.calls[1]["body"], {"id": "w1", "type": "withdrawal_requested", "ts": "2026-10-06T14:00:00.000Z", "entities": {"user": "u"}, "properties": {"usd": 900}, "session": "s_1"})
        self.assertEqual((decision.decision, decision.event_id, decision.decision_id), ("review", "w1", "kdec_1"))

    def test_keeps_the_event_for_the_history_when_the_decision_cannot_be_reached(self) -> None:
        up = {"now": False}
        server = Server(lambda call: (202, {}) if up["now"] else (503, {}))
        kairos = client(server)
        decision = kairos.track_and_decide("withdrawal_requested", {"user_id": "u"}, event_id="w1", fallback="review")
        self.assertEqual((decision.decision, decision.fallback, decision.event_id), ("review", True, "w1"))
        up["now"] = True
        kairos.flush()
        self.assertEqual(server.calls[-1]["path"], "/v1/events")
        self.assertEqual(server.calls[-1]["body"]["batch"][0]["id"], "w1")

    def test_does_not_send_again_an_event_the_api_rejected(self) -> None:
        server = Server(lambda call: (404, {"error": {"type": "no_trigger"}}))
        kairos = client(server)
        with self.assertRaises(KairosApiError):
            kairos.track_and_decide("nothing_happens", {"user_id": "u"})
        kairos.flush()
        self.assertEqual(len(server.calls), 1)


class ResolveTest(unittest.TestCase):
    def test_sends_the_resolution(self) -> None:
        server = Server(lambda call: (200, {"id": "kdec_1", "revision": 2, "final_outcome": "approve"}))
        kairos = client(server)
        self.assertEqual(kairos.resolve("kdec_1", "approve", note="Called the customer.", by="case-tool:alice")["revision"], 2)
        kairos.resolve("kdec 2", "block")
        self.assertEqual(
            [(c["path"], c["body"]) for c in server.calls],
            [
                ("/v1/decisions/kdec_1/resolution", {"outcome": "approve", "note": "Called the customer.", "by": "case-tool:alice"}),
                ("/v1/decisions/kdec%202/resolution", {"outcome": "block"}),
            ],
        )
        with self.assertRaises(KairosError):
            kairos.resolve("kdec_1", "review")


class DefinitionsTest(unittest.TestCase):
    def test_sends_each_to_its_endpoint(self) -> None:
        server = Server(lambda call: (200, {**call["body"], "name": "bank transfer", "version": 1}) if "/actions/" in call["path"] else (200, {"accepted": 1}))
        kairos = client(server)
        action = kairos.define_action("bank transfer", {"subject": "user", "hold": "Hold it?"})
        kairos.define_entity("device", {"kind": "device", "link": True})
        kairos.entity("user", "u1", {"plan": "pro"})
        kairos.set_object("user", "u2", {"plan": "free"})
        kairos.label({"type": "user", "id": "u1"}, "fraud_confirmed", {"source": "chargeback"}, timestamp=datetime(2026, 10, 9, 10, tzinfo=timezone.utc))
        kairos.label({"type": "user", "id": "u1"}, "reviewed")
        self.assertEqual(action["version"], 1)
        self.assertEqual(
            [(c["method"], c["path"], c["body"]) for c in server.calls],
            [
                ("PUT", "/v1/actions/bank%20transfer", {"subject": "user", "hold": "Hold it?"}),
                ("PUT", "/v1/entity-types/device", {"kind": "device", "link": True}),
                ("PUT", "/v1/objects", {"batch": [{"type": "user", "id": "u1", "properties": {"plan": "pro"}}]}),
                ("PUT", "/v1/objects", {"batch": [{"type": "user", "id": "u2", "properties": {"plan": "free"}}]}),
                ("POST", "/v1/labels", {"batch": [{"entity": {"type": "user", "id": "u1"}, "label": "fraud_confirmed", "properties": {"source": "chargeback"}, "ts": "2026-10-09T10:00:00.000Z"}]}),
                ("POST", "/v1/labels", {"batch": [{"entity": {"type": "user", "id": "u1"}, "label": "reviewed", "properties": {}}]}),
            ],
        )

    def test_raises_what_the_api_answers(self) -> None:
        kairos = client(Server(lambda call: (400, {"error": {"type": "invalid_request", "message": "hold: is required"}})))
        with self.assertRaisesRegex(KairosApiError, "hold: is required"):
            kairos.define_action("x", {"subject": "user"})


class WorkflowsTest(unittest.TestCase):
    def test_waits_for_the_run_and_keeps_one_key_across_a_retry(self) -> None:
        answers = [(503, {}), (200, {"id": "wfr_1", "status": "done", "output": {"outcome": "review"}})]
        server = Server(lambda call: answers.pop(0))
        kairos = client(server, max_retries=1)
        run = kairos.run_workflow("payout_check", {"user": "u1"}, wait=True, timeout_seconds=2)
        self.assertEqual(run["output"], {"outcome": "review"})
        first, second = server.calls
        self.assertEqual(first["body"]["input"], {"user": "u1"})
        self.assertEqual((first["body"]["wait"], first["body"]["timeout_seconds"]), (True, 2))
        self.assertEqual(second["body"]["idempotency_key"], first["body"]["idempotency_key"])
        self.assertGreater(first["timeout"], 2)

    def test_starts_a_run_in_the_background(self) -> None:
        server = Server(lambda call: (202, {"id": "wfr_2", "status": "queued"}))
        client(server).run_workflow("nightly", idempotency_key="2026-10-27")
        self.assertEqual(server.calls[0]["body"], {"input": {}, "idempotency_key": "2026-10-27"})


if __name__ == "__main__":
    unittest.main()
