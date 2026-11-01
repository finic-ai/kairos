"""ASGI middleware: the context of each request, and the events of the routes you name.

    from kairos.middleware import KairosASGI

    app.add_middleware(
        KairosASGI,
        client=kairos,
        entities=lambda scope: {"user": scope["state"].get("user_id"), "ip": scope["client"][0]},
        session=lambda scope: scope["state"].get("session_id"),
        routes={"POST /payees": "beneficiary_added"},
    )

Inside a request, ``kairos.track`` and ``kairos.decide`` take the entities and the session from
it. For FastAPI, Starlette and any other ASGI framework. The standard library only.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import re
import threading
import time
import weakref
from collections.abc import Awaitable, Mapping, MutableMapping
from typing import Any, Callable, Union
from urllib.parse import parse_qs, unquote

from . import context as _context
from .client import Kairos
from .context import Scope
from .errors import KairosError
from .settings import MAX_BODY_BYTES, RequestParts, match_route, readable_body, route_properties
from .types import Decision

#: The ASGI scope of a request: what the resolvers receive.
Request = MutableMapping[str, Any]
#: ``"beneficiary_added"``, or ``{"type": …, "failed": …, "properties": lambda scope: {…}}``.
RouteEvent = Union[str, Mapping[str, Any]]

_Receive = Callable[[], Awaitable[MutableMapping[str, Any]]]
_Send = Callable[[MutableMapping[str, Any]], Awaitable[None]]
_App = Callable[[Request, _Receive, _Send], Awaitable[None]]

_ROUTE = re.compile(r"^([A-Za-z]+)\s+(/.*)$")
_REFRESH = 60.0
#: The cookie of the website script that holds the id of the browser.
DEVICE_COOKIE = "kairos_device"
#: The cookie of the website script that holds the id of the visit: the session when nothing else gives one.
VISIT_COOKIE = "kairos_visit"


def _trimmed(path: str) -> str:
    return (path.rstrip("/") if len(path) > 1 else path) or "/"


def _routes(routes: Mapping[str, RouteEvent] | None) -> dict[str, Mapping[str, Any]]:
    out: dict[str, Mapping[str, Any]] = {}
    for key, value in (routes or {}).items():
        match = _ROUTE.match(key.strip())
        if not match:
            raise KairosError(f'routes: "{key}" must be a method and a route pattern, such as "POST /payees/{{payee_id}}"')
        event = {"type": value} if isinstance(value, str) else value
        if not event.get("type"):
            raise KairosError(f'routes: "{key}" needs an event type')
        out[f"{match.group(1).upper()} {_trimmed(match.group(2))}"] = event
    return out


class _Loaded:
    """The client settings of one client as last read."""

    def __init__(self) -> None:
        self.settings: Mapping[str, Any] | None = None
        self.at = float("-inf")
        self.loading = False
        self.lock = threading.Lock()


_loaded: weakref.WeakKeyDictionary[Kairos, _Loaded] = weakref.WeakKeyDictionary()


def _current_settings(client: Kairos) -> Mapping[str, Any] | None:
    """The client settings as last read. When they are a minute old, they are read again in a thread."""
    state = _loaded.setdefault(client, _Loaded())
    with state.lock:
        start = not state.loading and time.monotonic() - state.at >= _REFRESH
        if start:
            state.loading = True
    if start:
        threading.Thread(target=_load, args=(client, state), name="kairos-settings", daemon=True).start()
    return state.settings


def _load(client: Kairos, state: _Loaded) -> None:
    try:
        state.settings = client.client_settings()
    except Exception as error:  # noqa: BLE001 - the last settings stay, and the error is reported
        client._report(error)
    finally:
        with state.lock:
            state.at = time.monotonic()
            state.loading = False


def _cookie(header: str | None, name: str) -> str | None:
    for part in (header or "").split(";"):
        key, found, value = part.partition("=")
        if found and key.strip() == name:
            return unquote(value.strip())
    return None


async def _answer(send: _Send, answer: Mapping[str, Any]) -> None:
    """What the middleware answers instead of the app: the route's block response, or its step-up page."""
    if "redirect" in answer:
        await send({"type": "http.response.start", "status": 302, "headers": [(b"location", answer["redirect"].encode())]})
        await send({"type": "http.response.body", "body": b""})
        return
    body = json.dumps(answer["body"]).encode()
    headers = [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]
    await send({"type": "http.response.start", "status": answer["status"], "headers": headers})
    await send({"type": "http.response.body", "body": body})


async def _body(receive: _Receive) -> tuple[bytes, _Receive]:
    """The body, and a ``receive`` that gives the app the same messages, then the rest of the stream.

    Empty when the body is larger than ``MAX_BODY_BYTES``: the reading stops there.
    """
    messages: list[MutableMapping[str, Any]] = []
    size = 0
    whole = False
    while size <= MAX_BODY_BYTES:
        message = await receive()
        messages.append(message)
        if message["type"] != "http.request":
            break
        size += len(message.get("body", b""))
        if not message.get("more_body"):
            whole = size <= MAX_BODY_BYTES
            break
    body = b"".join(m.get("body", b"") for m in messages) if whole else b""

    async def again() -> MutableMapping[str, Any]:
        return messages.pop(0) if messages else await receive()

    return body, again


def _json(raw: bytes) -> Any:
    try:
        return json.loads(raw) if raw else None
    except ValueError:
        return None


def _live(settings: Mapping[str, Any] | None, method: str, path: str) -> tuple[Mapping[str, Any], Mapping[str, Any], dict[str, str]] | None:
    """The settings, the route and its parameters, for a request that a route of the settings is for.

    A route that decides on the response is the edge's: the app has written the response by then.
    """
    matched = match_route(settings, method, path) if settings else None
    if not settings or not matched or matched[0].get("mode") == "decide_response":
        return None
    return settings, matched[0], matched[1]


class KairosASGI:
    """The context of each request, and the events of the routes in ``routes``.

    :param client: The Kairos client.
    :param entities: Who makes the request, as entity type → id. Called with the ASGI scope when
        an event or a decision needs it, not when the request arrives, so it sees what your
        sign-in put on the request.
    :param session: The id of the login session in your own system. Take it from your server,
        not from the browser.
    :param subject: The entity type of the person who makes the request. A call that names
        someone else of this type takes nothing from the request.
    :param routes: ``"METHOD /pattern"`` → the event to send when the response finishes. The
        pattern is the route as you registered it (``/payees/{payee_id}``), with its prefix.
        As a dict: ``type`` for a status below 400, ``failed`` for a 4xx (without it, a refused
        request sends nothing), and ``properties``, a function of the scope. A route here does
        not read the request body.
    :param flush: Send the queue before the request ends, when a route sent an event. For a
        serverless function, which can stop as soon as it has answered.
    :param client_settings: Also run the routes of the client settings of the key's environment
        (Settings › Integrations). They are read in a thread, and again each minute; a request
        never waits for them. A route that decides on the request is decided before the app
        runs, and the decision is ``scope["state"]["kairos_decision"]``. Needs a secret key.
    :param hash_key: The secret for fields and session cookies that are sent only as a hash. The
        same on every server.
    """

    def __init__(
        self,
        app: _App,
        *,
        client: Kairos,
        entities: Callable[[Request], Mapping[str, Any] | None] | None = None,
        session: Callable[[Request], Any] | None = None,
        subject: str = "user",
        routes: Mapping[str, RouteEvent] | None = None,
        flush: bool = False,
        client_settings: bool = False,
        hash_key: str | None = None,
    ) -> None:
        self.app = app
        self._client = client
        self._entities = entities
        self._session = session
        self._subject = subject
        self._routes = _routes(routes)
        self._flush = flush
        self._client_settings = client_settings
        self._hash: Callable[[str], str] | None = None
        if hash_key:
            key = hash_key.encode()
            self._hash = lambda value: hmac.new(key, value.encode(), hashlib.sha256).hexdigest()
        self._reported: set[str] = set()
        if client_settings:
            _current_settings(client)

    async def __call__(self, scope: Request, receive: _Receive, send: _Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        settings = _current_settings(self._client) if self._client_settings else None
        method = str(scope.get("method", "")).upper()
        headers = {key.decode("latin-1").lower(): value.decode("latin-1") for key, value in reversed(scope.get("headers", []))}
        context = Scope(self._subject, lambda: (self._acting(scope, headers), self._who(scope, settings, headers)))
        mounted_at = scope.get("root_path", "")
        status: list[int] = []
        response_headers: dict[str, str] = {}

        live = _live(settings, method, str(scope.get("path", "/")))
        parts: RequestParts | None = None
        if live:
            current, route, params = live
            reads = any(spec.get("from") == "request.body" for spec in route.get("fields", {}).values())
            if reads and readable_body(headers.get("content-type"), headers.get("content-length")):
                raw, receive = await _body(receive)
            else:
                raw = b""
            query = parse_qs(scope.get("query_string", b"").decode("latin-1"))
            parts = RequestParts(
                query=lambda name: (query.get(name) or [None])[0],
                header=lambda name: headers.get(name.lower()),
                cookie=lambda name: _cookie(headers.get("cookie"), name),
                params=params,
                body=_json(raw),
                response_header=lambda name: response_headers.get(name.lower()),
            )
            if route.get("mode") == "decide_request":
                answer = await self._decide(scope, context, current, route, parts, method)
                if answer is not None:
                    await _answer(send, answer)
                    return

        async def sending(message: MutableMapping[str, Any]) -> None:
            if message["type"] == "http.response.start":
                status.append(message["status"])
                response_headers.update({key.decode("latin-1").lower(): value.decode("latin-1") for key, value in message.get("headers", [])})
            await send(message)

        token = self._client._enter(context)
        try:
            await self.app(scope, receive, sending)
        finally:
            _context.leave(token)
        # Only a response that was started: a request that failed before it has no status.
        if not status:
            return
        queued = bool(self._routes) and self._finished(scope, context, mounted_at, status[0])
        if live and parts:
            queued = self._track_after(context, live[0], live[1], parts, method, status[0]) or queued
        if queued and self._flush:
            await asyncio.get_running_loop().run_in_executor(None, self._client.flush)

    def _acting(self, scope: Request, headers: Mapping[str, str]) -> Mapping[str, Any] | None:
        """Who ``entities`` says is acting, with the website script's device when it names none."""
        found = self._entities(scope) if self._entities else None
        if not self._client_settings or (found and found.get("device")):
            return found
        device = _cookie(headers.get("cookie"), DEVICE_COOKIE)
        return {**(found or {}), "device": device} if device else found

    def _who(self, scope: Request, settings: Mapping[str, Any] | None, headers: Mapping[str, str]) -> Any:
        """The session of the request: what ``session`` gives, else the hash of the settings' session cookie, else the visit."""
        found = self._session(scope) if self._session else None
        if found is not None or not self._client_settings:
            return found
        cookies = headers.get("cookie")
        name = (settings or {}).get("defaults", {}).get("sessionCookie")
        value = _cookie(cookies, name) if name and self._hash else None
        if value and self._hash:
            return self._hash(value)
        return _cookie(cookies, VISIT_COOKIE)

    def _properties(self, settings: Mapping[str, Any], route: Mapping[str, Any], parts: RequestParts, method: str) -> dict[str, Any]:
        properties, problems = route_properties(route, parts, settings, self._hash)
        for problem in problems:
            if problem not in self._reported:
                self._reported.add(problem)
                self._client._report(KairosError(problem))
        return {**properties, "source": "auto", "http_method": method, "http_route": str(route["route"]).partition(" ")[2]}

    async def _decide(self, scope: Request, context: Scope, settings: Mapping[str, Any], route: Mapping[str, Any], parts: RequestParts, method: str) -> Mapping[str, Any] | None:
        """The decision of a route that decides on the request, and what to answer instead of the app.

        It answers only when the route is enforced and the route mode is active.
        """
        properties = self._properties(settings, route, parts, method)
        timeout = route["timeoutMs"] / 1000 if route.get("timeoutMs") else None
        decision: Decision | None = await asyncio.get_running_loop().run_in_executor(
            None,
            lambda: self._client._auto_decide(context, route["type"], properties, fallback=route.get("fallback") or "approve", timeout=timeout),
        )
        if decision is None:
            return None
        scope.setdefault("state", {})["kairos_decision"] = decision
        if not route.get("enforce") or settings.get("routing", {}).get("mode") != "active":
            return None
        if decision.decision == "block":
            block = route.get("block") or {}
            return {"status": block.get("status", 403), "body": block.get("body", {"error": "blocked"})}
        step_up = route.get("stepUp")
        if decision.decision == "step_up" and isinstance(step_up, Mapping):
            return {"redirect": step_up["redirect"]}
        return None

    def _track_after(self, context: Scope, settings: Mapping[str, Any], route: Mapping[str, Any], parts: RequestParts, method: str, status: int) -> bool:
        """The event of a route of the client settings when the response finishes.

        The route's own for a route that tracks, and the ``failed`` one for a 4xx. A 5xx sends nothing.
        """
        if status >= 500:
            return False
        if status >= 400:
            kind = route.get("failed")
        else:
            kind = route["type"] if route.get("mode") == "track" else None
        if not kind:
            return False
        properties = self._properties(settings, route, parts, method)
        return self._client._auto(context, kind, lambda: {**properties, "http_status": str(status)})

    def _finished(self, scope: Request, context: Scope, mounted_at: str, status: int) -> bool:
        """Send the event of the route, if the route has one for this status."""
        # Starlette and FastAPI put the matched route in the scope. A mounted route has the
        # path under its mount, and the mount adds its own path to root_path.
        path = getattr(scope.get("route"), "path", None)
        if not isinstance(path, str):
            return False
        method = str(scope.get("method", "")).upper()
        route = _trimmed(str(scope.get("root_path", ""))[len(mounted_at) :] + path)
        event = self._routes.get(f"{method} {route}")
        if event is None:
            return False
        # A 5xx is a fault of the server, not something the person did.
        kind = event["type"] if status < 400 else event.get("failed") if status < 500 else None
        if not kind:
            return False
        properties = event.get("properties")
        # Not `method`, `status` or a name that ends in `id`: those mean other things on an event.
        return self._client._auto(
            context,
            kind,
            lambda: {**(properties(scope) if properties else {}), "source": "auto", "http_method": method, "http_route": route, "http_status": str(status)},
        )
