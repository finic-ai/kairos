"""Tests for the context of a request and for the ASGI middleware. Standard library only:

    python3 -m unittest discover -s packages/sdk-python/tests
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import sys
import threading
import time
import unittest
from pathlib import Path
from typing import Any, Callable

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_client import DECISION, Server, client

from kairos import Kairos, KairosApiError, KairosError
from kairos import middleware as kairos_middleware
from kairos import settings as kairos_settings
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


def with_settings(routes: list[dict[str, Any]], mode: str = "monitor", decision: str = "approve") -> Server:
    """A server that answers the client settings with these routes, and every decision with ``decision``."""
    settings = {
        "version": 1,
        "consent": "not_required",
        "defaults": {"off": [], "sessionCookie": "sid"},
        "routing": {"mode": mode, "other": "ignore"},
        "pages": [],
        "screens": [],
        "routes": [{"fields": {}, "enforce": False, **route} for route in routes],
    }

    def answer(call: dict[str, Any]) -> tuple[int, Any]:
        if call["path"] == "/v1/client-settings":
            return 200, settings
        if call["path"] == "/v1/events":
            return 202, {"accepted": 1, "duplicates": 0}
        return 200, {**DECISION, "decision": decision}

    return Server(answer)


def settled(kairos: Kairos) -> None:
    """Wait for the client settings, which the middleware reads in a thread."""
    for _ in range(200):
        state = kairos_middleware._loaded.get(kairos)
        if state is not None and not state.loading and state.at > float("-inf"):
            return
        time.sleep(0.005)


def reader(seen: list[dict[str, Any]], status: int = 201) -> Any:
    """An ASGI app that reads the body, and says what it read and which decision it was given."""

    async def app(scope: dict[str, Any], receive: Any, send: Any) -> None:
        message = await receive()
        while message.get("more_body"):
            more = await receive()
            message = {**more, "body": message["body"] + more.get("body", b"")}
        scope["route"] = Route(scope["path"])
        decision = scope.get("state", {}).get("kairos_decision")
        seen.append({"body": message.get("body"), "decision": decision.decision if decision else None})
        code = int(dict(scope["headers"]).get(b"x-status", str(status).encode()))
        await send({"type": "http.response.start", "status": code, "headers": [(b"x-kairos-user", b"u9")]})
        await send({"type": "http.response.body", "body": b""})

    return app


async def ask(app: Any, method: str, path: str, body: Any = None, headers: dict[str, str] | None = None) -> tuple[int, dict[str, str], bytes]:
    raw = body if isinstance(body, bytes) else json.dumps(body).encode() if body is not None else b""
    headers = {**({"content-type": "application/json"} if body is not None and not isinstance(body, bytes) else {}), **(headers or {})}
    path, _, query = path.partition("?")
    scope = {
        "type": "http",
        "method": method,
        "path": path,
        "query_string": query.encode(),
        "root_path": "",
        "headers": [(b"x-user", b"u1"), (b"cookie", headers.pop("cookie", "theme=dark; sid=abc").encode())] + [(k.encode(), v.encode()) for k, v in headers.items()],
        "state": {},
        "client": ("203.0.113.7", 1),
    }
    sent: list[dict[str, Any]] = []
    chunks = [{"type": "http.request", "body": raw[:3], "more_body": True}, {"type": "http.request", "body": raw[3:]}]

    async def receive() -> dict[str, Any]:
        return chunks.pop(0) if chunks else {"type": "http.disconnect"}

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    await app(scope, receive, send)
    start = sent[0]
    return int(start["status"]), {k.decode(): v.decode() for k, v in start.get("headers", [])}, b"".join(m.get("body", b"") for m in sent[1:])


def user(scope: Any) -> dict[str, Any]:
    return {"user": dict(scope["headers"]).get(b"x-user", b"").decode() or None}


def facts(method: str, route: str, status: str | None = None) -> dict[str, str]:
    return {"source": "auto", "http_method": method, "http_route": route, **({"http_status": status} if status else {})}


class ClientSettingsTest(unittest.TestCase):
    def test_send_the_events_of_the_routes_that_track_with_their_fields_once_each(self) -> None:
        server = with_settings(
            [
                {
                    "route": "POST /api/payees/:id",
                    "mode": "track",
                    "type": "beneficiary_added",
                    "failed": "beneficiary_add_failed",
                    "fields": {
                        "payee_id": {"from": "request.param", "path": "id"},
                        "email": {"from": "request.body", "path": "$.email", "kind": "email"},
                        "plan": {"from": "request.query", "path": "plan"},
                        "who": {"from": "response.header", "path": "x-kairos-user"},
                    },
                },
                {"route": "PUT /api/password", "mode": "track", "type": "password_changed"},
                {"route": "POST /api/login", "mode": "decide_response", "type": "login", "failed": "login_failed", "fallback": "approve"},
                {"route": "GET /api/broken", "mode": "track", "type": "never"},
            ]
        )
        kairos = client(server)
        seen: list[dict[str, Any]] = []
        app = KairosASGI(reader(seen), client=kairos, entities=user, routes={"PUT /api/password": "password_changed"}, client_settings=True, hash_key="hash-key")
        settled(kairos)

        async def run() -> None:
            await ask(app, "POST", "/api/payees/p7?plan=gold", {"email": " Ada@Example.COM "}, {"cookie": "sid=abc; kairos_device=browser_1"})
            await ask(app, "POST", "/api/payees/p8", {}, {"x-status": "400"})
            await ask(app, "PUT", "/api/password", headers={"x-status": "204"})
            await ask(app, "POST", "/api/login", headers={"x-status": "401"})
            await ask(app, "GET", "/api/broken", headers={"x-status": "500"})

        asyncio.run(run())
        self.assertEqual(seen[0]["body"], json.dumps({"email": " Ada@Example.COM "}).encode())
        session = hmac.new(b"hash-key", b"abc", hashlib.sha256).hexdigest()
        self.assertEqual(
            events(server, kairos),
            [
                {
                    "type": "beneficiary_added",
                    "entities": {"user": "u1", "device": "browser_1", "payee": "p7"},
                    "session": session,
                    "properties": {"email": "ada@example.com", "plan": "gold", "who": "u9", **facts("POST", "/api/payees/:id", "201")},
                },
                {"type": "beneficiary_add_failed", "entities": {"user": "u1", "payee": "p8"}, "session": session, "properties": {"who": "u9", **facts("POST", "/api/payees/:id", "400")}},
                {"type": "password_changed", "entities": {"user": "u1"}, "session": session, "properties": facts("PUT", "/api/password", "204")},
            ],
        )

    def test_take_the_visit_of_the_website_script_as_the_session_when_nothing_else_gives_one(self) -> None:
        server = with_settings([{"route": "POST /payees", "mode": "track", "type": "beneficiary_added"}])
        kairos = client(server)

        def session(scope: Any) -> str | None:
            return dict(scope["headers"]).get(b"x-session", b"").decode() or None

        app = KairosASGI(reader([]), client=kairos, entities=user, session=session, client_settings=True)
        settled(kairos)

        async def run() -> None:
            await ask(app, "POST", "/payees", headers={"cookie": "kairos_visit=visit_1"})
            await ask(app, "POST", "/payees", headers={"cookie": "kairos_visit=visit_1", "x-session": "login_9"})

        asyncio.run(run())
        self.assertEqual([e.get("session") for e in events(server, kairos)], ["visit_1", "login_9"])

    def test_decide_a_route_before_the_app_and_act_only_when_enforced_in_active_mode(self) -> None:
        routes = [
            {
                "route": "POST /api/transfers",
                "mode": "decide_request",
                "type": "transfer_requested",
                "failed": "transfer_refused",
                "fallback": "review",
                "enforce": True,
                "block": {"status": 409, "body": {"error": "held"}},
                "fields": {"amount": {"from": "request.body", "path": "$.amount"}},
            },
            {"route": "POST /api/withdrawals", "mode": "decide_request", "type": "withdrawal_requested", "fallback": "review", "enforce": True, "stepUp": {"redirect": "/verify"}},
        ]

        def attempt(decision: str, mode: str, path: str) -> tuple[tuple[int, dict[str, str], bytes], list[dict[str, Any]], Server, Kairos]:
            server = with_settings(routes, mode, decision)
            kairos = client(server)
            seen: list[dict[str, Any]] = []
            app = KairosASGI(reader(seen), client=kairos, entities=user, client_settings=True)
            settled(kairos)
            return asyncio.run(ask(app, "POST", path, {"amount": 900})), seen, server, kairos

        (status, _, _), seen, server, kairos = attempt("block", "monitor", "/api/transfers")
        self.assertEqual((status, seen), (201, [{"body": b'{"amount": 900}', "decision": "block"}]))
        asked = server.to("/v1/events/decide")[0]["body"]
        self.assertEqual((asked["type"], asked["entities"], asked["properties"]), ("transfer_requested", {"user": "u1"}, {"amount": 900, **facts("POST", "/api/transfers")}))

        (status, headers, body), seen, server, kairos = attempt("block", "active", "/api/transfers")
        self.assertEqual((status, headers["content-type"], json.loads(body), seen), (409, "application/json", {"error": "held"}, []))
        self.assertEqual(events(server, kairos), [])

        (status, headers, _), _, _, _ = attempt("step_up", "active", "/api/withdrawals")
        self.assertEqual((status, headers["location"]), (302, "/verify"))

        (status, _, _), seen, _, _ = attempt("approve", "active", "/api/transfers")
        self.assertEqual((status, seen[0]["decision"]), (201, "approve"))

    def test_take_the_edges_decision_and_tell_the_edge_that_the_middleware_sends_the_events(self) -> None:
        def edge(path: str, decision: dict[str, Any] | None = None) -> str:
            claim = {"t": time.time() * 1000, "m": "POST", "p": path, **({"d": decision} if decision else {})}
            payload = base64.urlsafe_b64encode(json.dumps(claim).encode()).decode().rstrip("=")
            return f"{payload}.{hmac.new(b'hash-key', f'kairos-edge.{payload}'.encode(), hashlib.sha256).hexdigest()}"

        routes = [
            {"route": "POST /payees", "mode": "track", "type": "beneficiary_added"},
            {"route": "POST /transfers", "mode": "decide_request", "type": "transfer_requested", "enforce": True},
        ]
        server = with_settings(routes, "active", "block")
        kairos = client(server)
        seen: list[dict[str, Any]] = []
        app = KairosASGI(reader(seen), client=kairos, entities=user, client_settings=True, hash_key="hash-key")
        settled(kairos)
        review = {"decision": "review", "risk_score": 61, "probability": 0.61, "event_id": "evt_1"}

        async def run() -> list[tuple[int, str | None]]:
            answers = [
                await ask(app, "POST", "/payees", headers={"x-kairos-edge": edge("/payees")}),
                await ask(app, "POST", "/payees", headers={"x-kairos-edge": "forged.0000"}),
                await ask(app, "POST", "/transfers", headers={"x-kairos-edge": edge("/transfers", review)}),
                await ask(app, "POST", "/transfers", headers={"x-kairos-edge": edge("/payees", review)}),
            ]
            return [(status, headers.get("x-kairos-tracked")) for status, headers, _ in answers]

        self.assertEqual(asyncio.run(run()), [(201, "1"), (201, None), (201, "1"), (403, None)])
        self.assertEqual([s["decision"] for s in seen], [None, None, "review"])
        self.assertEqual(len(server.to("/v1/events/decide")), 1)
        self.assertEqual([e["type"] for e in events(server, kairos)], ["beneficiary_added", "beneficiary_added"])

    def test_read_a_header_that_the_typescript_edge_signed(self) -> None:
        header = (
            "eyJ0IjoxNzAwMDAwMDAwMDAwLCJtIjoiUE9TVCIsInAiOiIvdHJhbnNmZXJzIiwiZCI6eyJkZWNpc2lvbiI6InJldmlldyIsInJpc2tfc2NvcmUiOjYxLCJwcm9iYWJpbGl0eSI6MC42MSwiZGVjaXNpb25faWQiOiJkZWNfw6kifX0"
            ".b5540595e9b7f2571e4240fd481585bb724bb4cb925230d8ea9258f2447d0717"
        )

        def sign(value: str) -> str:
            return hmac.new(b"hash-key", value.encode(), hashlib.sha256).hexdigest()

        self.assertEqual(
            kairos_settings.verify_edge(sign, header, "post", "/transfers", now=1_700_000_060),
            {"decision": {"decision": "review", "risk_score": 61, "probability": 0.61, "decision_id": "dec_é"}},
        )
        self.assertIsNone(kairos_settings.verify_edge(sign, header, "POST", "/transfers", now=1_700_000_301))
        self.assertIsNone(kairos_settings.verify_edge(sign, header, "POST", "/payees", now=1_700_000_060))

    def test_do_nothing_when_routing_is_off_or_the_settings_cannot_be_read_and_fail_no_request(self) -> None:
        errors: list[Exception] = []
        off = with_settings([{"route": "POST /payees", "mode": "track", "type": "beneficiary_added"}], mode="off")
        unread = Server(lambda call: (403, {"error": {"message": "forbidden"}}) if call["path"] == "/v1/client-settings" else (202, {"accepted": 1}))
        for server, on_error in ((off, None), (unread, errors.append)):
            kairos = client(server, on_error=on_error)
            app = KairosASGI(reader([]), client=kairos, entities=user, client_settings=True)
            settled(kairos)
            self.assertEqual(asyncio.run(ask(app, "POST", "/payees"))[0], 201)
            self.assertEqual(events(server, kairos), [])
        self.assertEqual([type(e) for e in errors], [KairosApiError])

    def test_say_once_that_a_field_needs_a_hash_key(self) -> None:
        errors: list[Exception] = []
        server = with_settings([{"route": "POST /payees", "mode": "track", "type": "beneficiary_added", "fields": {"account_id": {"from": "request.header", "path": "x-account", "kind": "hmac"}}}])
        kairos = client(server, on_error=errors.append)
        app = KairosASGI(reader([]), client=kairos, entities=user, client_settings=True)
        settled(kairos)

        async def run() -> None:
            for _ in range(2):
                await ask(app, "POST", "/payees", headers={"x-account": "12345678"})

        asyncio.run(run())
        self.assertEqual([e["entities"] for e in events(server, kairos)], [{"user": "u1"}, {"user": "u1"}])
        self.assertEqual([str(e) for e in errors], ['POST /payees: the field "account_id" is sent only as a hash, and there is no hash key.'])


    def test_read_no_body_that_is_not_json_or_is_too_large_and_give_the_app_all_of_it(self) -> None:
        server = with_settings([{"route": "POST /files", "mode": "track", "type": "file_added", "fields": {"name": {"from": "request.body", "path": "$.name"}}}])
        kairos = client(server)
        seen: list[dict[str, Any]] = []
        app = KairosASGI(reader(seen), client=kairos, entities=user, client_settings=True)
        settled(kairos)
        large = json.dumps({"name": "big", "padding": "x" * (kairos_settings.MAX_BODY_BYTES + 1)}).encode()

        async def run() -> None:
            await ask(app, "POST", "/files", b'{"name": "photo"}', {"content-type": "multipart/form-data; boundary=x"})
            await ask(app, "POST", "/files", b'{"name": "photo"}', {"content-type": "application/json", "content-length": str(kairos_settings.MAX_BODY_BYTES + 1)})
            await ask(app, "POST", "/files", large, {"content-type": "application/json"})
            await ask(app, "POST", "/files", {"name": "small"})

        asyncio.run(run())
        self.assertEqual([len(s["body"]) for s in seen], [17, 17, len(large), 17])
        self.assertEqual([e["properties"].get("name") for e in events(server, kairos)], [None, None, None, "small"])


if __name__ == "__main__":
    unittest.main()
