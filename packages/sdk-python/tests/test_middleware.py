"""Tests for the context of a request and for the ASGI middleware. Standard library only:

    python3 -m unittest discover -s packages/sdk-python/tests
"""

from __future__ import annotations

import asyncio
import sys
import threading
import unittest
from pathlib import Path
from typing import Any, Callable

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_client import Server, client

from kairos import Kairos, KairosError
from kairos.middleware import KairosASGI


def events(server: Server, kairos: Kairos) -> list[dict[str, Any]]:
    """The events sent, without the fields that differ on every run."""
    kairos.flush()
    return [{key: value for key, value in event.items() if key not in ("id", "ts")} for event in server.events()]


class ContextTest(unittest.TestCase):
    def test_gives_a_call_the_entities_and_the_session_it_does_not_name(self) -> None:
        server = Server()
        kairos = client(server)
        with kairos.context({"user": "u1", "device": "d1", "ip": "203.0.113.7", "empty": "", "none": None}, session="s1"):
            kairos.track("transaction", {"amount": 900})
            kairos.decide("withdrawal", {"usd": 900})
            kairos.track_and_decide("withdrawal_requested", {"usd": 900})
        who = {"entities": {"user": "u1", "device": "d1", "ip": "203.0.113.7"}, "session": "s1"}
        self.assertEqual(events(server, kairos), [{"type": "transaction", "properties": {"amount": 900}, **who}])
        self.assertEqual(server.to("/v1/decide")[0]["body"], {"action": "withdrawal", "properties": {"usd": 900}, **who})
        decided = server.to("/v1/events/decide")[0]["body"]
        self.assertEqual({key: decided[key] for key in ("type", "entities", "session")}, {"type": "withdrawal_requested", **who})

    def test_lets_the_call_win_and_takes_an_empty_session_as_none(self) -> None:
        server = Server()
        kairos = client(server)
        with kairos.context({"user": "u1", "device": "d1"}, session="s1"):
            kairos.track("login", {"device_id": "d2"}, session="s2")
            kairos.track("login", {"$session": ""})
            kairos.track("login")
        self.assertEqual(
            events(server, kairos),
            [
                {"type": "login", "entities": {"user": "u1", "device": "d2"}, "properties": {}, "session": "s2"},
                {"type": "login", "entities": {"user": "u1", "device": "d1"}, "properties": {}},
                {"type": "login", "entities": {"user": "u1", "device": "d1"}, "properties": {}, "session": "s1"},
            ],
        )

    def test_adds_nothing_to_a_call_about_someone_else(self) -> None:
        server = Server()
        kairos = client(server)
        with kairos.context({"user": "agent_7", "device": "agent_laptop"}, session="agent_session"):
            kairos.track("contact_changed", {"user_id": "customer_1", "field": "email"})
            kairos.decide("withdrawal", {"user_id": "customer_1"})
            # The same person, named in the call: the request still says where from.
            kairos.track("login", {"user_id": "agent_7"})
        with kairos.context({"merchant": "m1", "device": "d1"}, subject="merchant"):
            kairos.track("payout_requested", {"merchant_id": "m2"})
        # A sign-in: the request has no user yet, so the device and the session are added.
        with kairos.context({"device": "d1"}, session="s1"):
            kairos.track("login", {"user_id": "u1"})
        self.assertEqual(
            events(server, kairos),
            [
                {"type": "contact_changed", "entities": {"user": "customer_1"}, "properties": {"field": "email"}},
                {"type": "login", "entities": {"user": "agent_7", "device": "agent_laptop"}, "properties": {}, "session": "agent_session"},
                {"type": "payout_requested", "entities": {"merchant": "m2"}, "properties": {}},
                {"type": "login", "entities": {"device": "d1", "user": "u1"}, "properties": {}, "session": "s1"},
            ],
        )
        self.assertEqual(server.to("/v1/decide")[0]["body"], {"action": "withdrawal", "entities": {"user": "customer_1"}, "properties": {}})

    def test_puts_set_on_the_entity_the_call_is_about(self) -> None:
        server = Server()
        kairos = client(server)
        with kairos.context({"user": "u1", "device": "d1", "ip": "203.0.113.7"}):
            kairos.track("kyc_completed", set={"kyc_level": "full"})
            kairos.track("device_seen", {"device_id": "d1"}, set={"os": "ios"})
            kairos.track("login", set={"user": {"country": "GB"}, "device": {"os": "ios"}})
            with self.assertRaisesRegex(KairosError, "Say which entity"):
                kairos.track("login", {"user_id": "u1", "device_id": "d1"}, set={"os": "ios"})
        with kairos.context({"device": "d1", "ip": "203.0.113.7"}), self.assertRaisesRegex(KairosError, "the event names device, ip"):
            kairos.track("seen", set={"os": "ios"})
        self.assertEqual([e["set"] for e in events(server, kairos)], [{"user": {"kyc_level": "full"}}, {"device": {"os": "ios"}}, {"user": {"country": "GB"}, "device": {"os": "ios"}}])

    def test_keeps_threads_and_tasks_apart(self) -> None:
        server = Server()
        kairos = client(server)
        ready = threading.Barrier(3)

        def work(user: str) -> None:
            with kairos.context({"user": user}):
                ready.wait(timeout=5)
                kairos.track("login", {"n": user})

        threads = [threading.Thread(target=work, args=(user,)) for user in ("a", "b", "c")]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        async def task(user: str, wait: float) -> None:
            with kairos.context({"user": user}):
                await asyncio.sleep(wait)
                # In a thread, as the guide says to call `decide` from async code.
                await asyncio.to_thread(kairos.track, "login", {"n": user})

        async def tasks() -> None:
            await asyncio.gather(task("x", 0.02), task("y", 0.01), task("z", 0))

        asyncio.run(tasks())
        sent = events(server, kairos)
        self.assertEqual(len(sent), 6)
        for event in sent:
            self.assertEqual(event["entities"], {"user": event["properties"]["n"]})

    def test_goes_on_with_what_the_call_names_when_the_context_cannot_be_read(self) -> None:
        server = Server()
        errors: list[Exception] = []
        kairos = client(server, on_error=errors.append)
        with kairos.context({"user": {"id": 1}}):
            kairos.track("login", {"user_id": "u1"})
            with self.assertRaisesRegex(KairosError, "names no entity"):
                kairos.track("login")
        self.assertEqual(events(server, kairos), [{"type": "login", "entities": {"user": "u1"}, "properties": {}}])
        self.assertEqual([str(e) for e in errors], ['The context gave a dict as the id of "user". An id is text or a number.'] * 2)

    def test_is_the_context_of_one_client_only_and_can_be_left(self) -> None:
        one, two = Server(), Server()
        first, second = client(one), client(two)
        with second.context({"user": "other"}), first.context({"user": "u1"}):
            first.track("login")
            second.track("login")
            with first.without_context():
                with self.assertRaisesRegex(KairosError, "did not run inside it"):
                    first.track("login")
                second.track("login")
        self.assertEqual([e["entities"] for e in events(one, first)], [{"user": "u1"}])
        self.assertEqual([e["entities"] for e in events(two, second)], [{"user": "other"}, {"user": "other"}])
        # A client that never had a context says nothing about one.
        with self.assertRaisesRegex(KairosError, r"entities\.$"):
            client(Server()).track("login")

    def test_takes_what_set_context_gives_and_only_inside_a_context(self) -> None:
        server = Server()
        kairos = client(server)
        with self.assertRaises(KairosError):
            kairos.set_context(session="s")
        with kairos.context({"device": "d1"}, session="old"):
            kairos.set_context({"user": "u1"}, session="new")
            kairos.track("login")
        self.assertEqual(events(server, kairos), [{"type": "login", "entities": {"device": "d1", "user": "u1"}, "properties": {}, "session": "new"}])


class Route:
    """What Starlette and FastAPI put in the scope for the route that matched."""

    def __init__(self, path: str) -> None:
        self.path = path


Handler = Callable[[dict[str, Any]], int]


def application(handlers: dict[tuple[str, str], Handler], mount: str = "") -> Any:
    """A small ASGI application: a sign-in that runs after the middleware, then the route that matches."""

    async def app(scope: dict[str, Any], receive: Any, send: Any) -> None:
        headers = {key.decode(): value.decode() for key, value in scope["headers"]}
        if "x-user" in headers:
            scope["state"]["user"] = headers["x-user"]
            scope["state"]["session"] = f"session_of_{headers['x-user']}"
        path = scope["path"][len(mount) :]
        status = 404
        for (method, pattern), handler in handlers.items():
            names = pattern.strip("/").split("/")
            parts = path.strip("/").split("/")
            if method == scope["method"] and len(names) == len(parts) and all(n.startswith("{") or n == p for n, p in zip(names, parts)):
                scope["route"] = Route(pattern)
                scope["root_path"] = scope.get("root_path", "") + mount
                scope["path_params"] = {n[1:-1]: p for n, p in zip(names, parts) if n.startswith("{")}
                await asyncio.sleep(0)
                status = handler(scope)
        await send({"type": "http.response.start", "status": status, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    return app


async def call(app: Any, method: str, path: str, user: str | None = "u1") -> int:
    headers = [(b"x-kairos-device", b"d1")] + ([(b"x-user", user.encode())] if user else [])
    scope = {"type": "http", "method": method, "path": path, "root_path": "", "headers": headers, "state": {}, "client": ("203.0.113.7", 1)}
    sent: list[dict[str, Any]] = []

    async def receive() -> dict[str, Any]:
        return {"type": "http.request", "body": b""}

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    await app(scope, receive, send)
    return int(sent[0]["status"])


def device(scope: Any) -> str | None:
    return dict(scope["headers"]).get(b"x-kairos-device", b"").decode() or None


def auto(method: str, route: str, status: str) -> dict[str, str]:
    return {"source": "auto", "http_method": method, "http_route": route, "http_status": status}


WHO = {"entities": {"user": "u1", "device": "d1"}, "session": "session_of_u1"}


class MiddlewareTest(unittest.TestCase):
    def wrapped(self, kairos: Kairos, handlers: dict[tuple[str, str], Handler], **options: Any) -> KairosASGI:
        options.setdefault("entities", lambda scope: {"user": scope["state"].get("user"), "device": device(scope)})
        options.setdefault("session", lambda scope: scope["state"].get("session"))
        return KairosASGI(application(handlers, options.pop("mount", "")), client=kairos, **options)

    def test_reads_the_request_when_the_call_is_made_after_the_sign_in(self) -> None:
        server = Server()
        kairos = client(server)

        def transfer(scope: dict[str, Any]) -> int:
            kairos.track("transaction", {"amount": 5})
            kairos.decide("withdrawal", {"amount": 5})
            return 200

        app = self.wrapped(kairos, {("POST", "/transfers"): transfer})

        async def run() -> list[int]:
            return list(await asyncio.gather(*(call(app, "POST", "/transfers", user) for user in ("u1", "u2", "u3"))))

        self.assertEqual(asyncio.run(run()), [200, 200, 200])
        sent = events(server, kairos)
        self.assertEqual(sorted(e["entities"]["user"] for e in sent), ["u1", "u2", "u3"])
        for body in sent + [c["body"] for c in server.to("/v1/decide")]:
            self.assertEqual(body["session"], f"session_of_{body['entities']['user']}")
            self.assertEqual(body["entities"]["device"], "d1")
        # After the request, the context is gone.
        with self.assertRaisesRegex(KairosError, "names no entity"):
            kairos.track("login")

    def test_sends_the_event_of_a_route_when_the_response_finishes(self) -> None:
        server = Server()
        errors: list[Exception] = []
        kairos = client(server, on_error=errors.append)

        def login(scope: dict[str, Any]) -> int:
            if scope["query"] != "ok":
                return 401
            # The handler learns who it is and makes the session.
            kairos.set_context({"user": "u9"}, session="fresh")
            return 200

        def transfer(scope: dict[str, Any]) -> int:
            # The handler's own event has the amount, so the route's event is left out.
            kairos.track("transaction", {"amount": 5})
            return 201

        def broken(scope: dict[str, Any]) -> int:
            raise ZeroDivisionError

        handlers: dict[tuple[str, str], Handler] = {
            ("POST", "/payees/{payee_id}"): lambda scope: 201,
            ("DELETE", "/payees/{payee_id}"): lambda scope: 204,
            ("PUT", "/password"): lambda scope: 204 if scope["query"] == "ok" else 403,
            ("POST", "/login"): login,
            ("GET", "/broken"): lambda scope: 500,
            ("GET", "/raises"): broken,
            ("GET", "/balance"): lambda scope: 200,
            ("POST", "/transfers"): transfer,
        }
        app = self.wrapped(
            kairos,
            handlers,
            mount="/api",
            routes={
                "post /api/payees/{payee_id}/": {"type": "beneficiary_added", "properties": lambda scope: {"payee_id": scope["path_params"]["payee_id"], "http_status": "mine"}},
                "DELETE /api/payees/{payee_id}": {"type": "beneficiary_removed", "properties": lambda scope: 1 / 0},
                "PUT /api/password": {"type": "password_changed", "failed": "password_change_failed"},
                "POST /api/login": {"type": "login", "failed": "login_failed"},
                "GET /api/broken": "never",
                "GET /api/raises": "never",
                "POST /api/transfers": "transaction",
            },
        )

        async def one(method: str, path: str, query: str = "", user: str | None = "u1") -> int:
            inner = app.app

            async def with_query(scope: Any, receive: Any, send: Any) -> None:
                scope["query"] = query
                await inner(scope, receive, send)

            app.app = with_query
            try:
                return await call(app, method, path, user)
            finally:
                app.app = inner

        async def run() -> None:
            self.assertEqual(await one("POST", "/api/payees/p7"), 201)
            await one("PUT", "/api/password", "ok")
            await one("PUT", "/api/password")
            await one("POST", "/api/login", user=None)
            await one("POST", "/api/login", "ok", user=None)
            await one("GET", "/api/broken")
            with self.assertRaises(ZeroDivisionError):
                await one("GET", "/api/raises")
            await one("GET", "/api/balance")
            self.assertEqual(await one("GET", "/api/nothing"), 404)
            await one("POST", "/api/transfers")
            await one("DELETE", "/api/payees/p7")

        asyncio.run(run())
        self.assertEqual(
            events(server, kairos),
            [
                {"type": "beneficiary_added", "entities": {**WHO["entities"], "payee": "p7"}, "session": WHO["session"], "properties": auto("POST", "/api/payees/{payee_id}", "201")},
                {"type": "password_changed", **WHO, "properties": auto("PUT", "/api/password", "204")},
                {"type": "password_change_failed", **WHO, "properties": auto("PUT", "/api/password", "403")},
                {"type": "login_failed", "entities": {"device": "d1"}, "properties": auto("POST", "/api/login", "401")},
                {"type": "login", "entities": {"device": "d1", "user": "u9"}, "session": "fresh", "properties": auto("POST", "/api/login", "200")},
                {"type": "transaction", **WHO, "properties": {"amount": 5}},
            ],
        )
        self.assertEqual([type(e) for e in errors], [ZeroDivisionError])

    def test_sends_nothing_for_a_request_with_no_one_to_be_about(self) -> None:
        server = Server()
        errors: list[Exception] = []
        kairos = client(server, on_error=errors.append)
        app = self.wrapped(kairos, {("POST", "/payees"): lambda scope: 201}, entities=lambda scope: {"user": scope["state"].get("user")}, routes={"POST /payees": "beneficiary_added"})
        self.assertEqual(asyncio.run(call(app, "POST", "/payees", user=None)), 201)
        self.assertEqual(events(server, kairos), [])
        self.assertEqual(errors, [])

    def test_sends_the_queue_before_the_request_ends_when_asked(self) -> None:
        server = Server()
        kairos = client(server)
        app = self.wrapped(kairos, {("POST", "/payees"): lambda scope: 201}, routes={"POST /payees": "beneficiary_added"}, flush=True)
        asyncio.run(call(app, "POST", "/payees"))
        self.assertEqual([e["type"] for e in server.events()], ["beneficiary_added"])

    def test_passes_what_is_not_http_and_rejects_a_route_that_is_not_a_method_and_a_pattern(self) -> None:
        kairos = client(Server())
        seen: list[str] = []

        async def app(scope: Any, receive: Any, send: Any) -> None:
            seen.append(scope["type"])

        asyncio.run(KairosASGI(app, client=kairos)({"type": "lifespan"}, None, None))  # type: ignore[arg-type]
        self.assertEqual(seen, ["lifespan"])
        with self.assertRaisesRegex(KairosError, "must be a method and a route pattern"):
            KairosASGI(app, client=kairos, routes={"/payees": "beneficiary_added"})
        with self.assertRaisesRegex(KairosError, "needs an event type"):
            KairosASGI(app, client=kairos, routes={"POST /payees": {"type": ""}})


if __name__ == "__main__":
    unittest.main()
