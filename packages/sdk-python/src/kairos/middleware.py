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
import re
from collections.abc import Awaitable, Mapping, MutableMapping
from typing import Any, Callable, Union

from . import context as _context
from .client import Kairos
from .context import Scope
from .errors import KairosError

#: The ASGI scope of a request: what the resolvers receive.
Request = MutableMapping[str, Any]
#: ``"beneficiary_added"``, or ``{"type": …, "failed": …, "properties": lambda scope: {…}}``.
RouteEvent = Union[str, Mapping[str, Any]]

_Receive = Callable[[], Awaitable[MutableMapping[str, Any]]]
_Send = Callable[[MutableMapping[str, Any]], Awaitable[None]]
_App = Callable[[Request, _Receive, _Send], Awaitable[None]]

_ROUTE = re.compile(r"^([A-Za-z]+)\s+(/.*)$")


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
        request sends nothing), and ``properties``, a function of the scope. The middleware
        does not read the request body.
    :param flush: Send the queue before the request ends, when a route sent an event. For a
        serverless function, which can stop as soon as it has answered.
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
    ) -> None:
        self.app = app
        self._client = client
        self._entities = entities
        self._session = session
        self._subject = subject
        self._routes = _routes(routes)
        self._flush = flush

    async def __call__(self, scope: Request, receive: _Receive, send: _Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        context = Scope(self._subject, lambda: (self._entities(scope) if self._entities else None, self._session(scope) if self._session else None))
        mounted_at = scope.get("root_path", "")
        status: list[int] = []

        async def sending(message: MutableMapping[str, Any]) -> None:
            if message["type"] == "http.response.start":
                status.append(message["status"])
            await send(message)

        token = self._client._enter(context)
        try:
            await self.app(scope, receive, sending)
        finally:
            _context.leave(token)
        # Only a response that was started: a request that failed before it has no status.
        if status and self._routes and self._finished(scope, context, mounted_at, status[0]) and self._flush:
            await asyncio.get_running_loop().run_in_executor(None, self._client.flush)

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
