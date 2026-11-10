from __future__ import annotations

import atexit
import contextlib
import json
import random
import re
import socket
import threading
import time
import urllib.error
import urllib.request
import uuid
import weakref
from collections.abc import Iterator, Mapping
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any, Callable
from urllib.parse import quote

from . import context as _context
from .context import Scope
from .errors import KairosApiError, KairosError, KairosTimeoutError
from .types import Decision, Moment, Outcome, Properties, Transport

RETRYABLE = frozenset({408, 429, 500, 502, 503, 504})
MAX_BATCH = 500
#: Under the server's body limit, which is 2 MB for a public key.
MAX_BATCH_BYTES = 1800 * 1024

_ENTITY_KEY = re.compile(r"^(.+?)(?:Id|_id)$")
_CAMEL = re.compile(r"([a-z0-9])([A-Z])")
# Names that end in "id" and are about the event, not an entity.
_EVENT_ID = ("event_id", "eventId")
_UNIVERSAL_ID = ("universal_id", "universalId")


def _entity_type(key: str) -> str | None:
    """user_id → user, bank_account_id → bank_account, bankAccountId → bank_account."""
    match = _ENTITY_KEY.match(key)
    return _CAMEL.sub(r"\1_\2", match.group(1)).lower() if match else None


def _split(properties: Mapping[str, Any]) -> tuple[dict[str, str], dict[str, Any]]:
    """Split properties into entity references and everything else."""
    entities: dict[str, str] = {}
    rest: dict[str, Any] = {}
    for key, value in properties.items():
        kind = _entity_type(key)
        if key == "entities" and isinstance(value, Mapping):
            entities.update({str(k): str(v) for k, v in value.items()})
        elif kind and isinstance(value, (str, int)) and not isinstance(value, bool) and value != "":
            entities[kind] = str(value)
        elif value is not None:
            rest[key] = value
    return entities, rest


def _iso(moment: Moment | None) -> str:
    """A moment as the API takes it: UTC, with milliseconds."""
    if moment is None:
        when = datetime.now(timezone.utc)
    elif isinstance(moment, datetime):
        when = moment
    elif isinstance(moment, str):
        try:
            when = datetime.fromisoformat(moment.replace("Z", "+00:00") if moment.endswith(("Z", "z")) else moment)
        except ValueError:
            raise KairosError(f'"{moment}" is not an ISO 8601 timestamp') from None
    else:
        raise KairosError("A timestamp must be a datetime or an ISO 8601 string")
    # A datetime with no time zone is read as UTC, so that the same code gives the same event on every machine.
    when = when.replace(tzinfo=timezone.utc) if when.tzinfo is None else when.astimezone(timezone.utc)
    return when.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _json_default(value: Any) -> Any:
    """Values that are common in a Python backend and that JSON does not have."""
    if isinstance(value, datetime):
        return _iso(value)
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Decimal):
        # Kairos adds amounts up as numbers. A value that is not a finite number stays text.
        return float(value) if value.is_finite() else str(value)
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, (set, frozenset, tuple)):
        return list(value)
    raise TypeError(f"{type(value).__name__} is not JSON serializable")


def _encode(body: Any) -> bytes:
    return json.dumps(body, default=_json_default, separators=(",", ":"), allow_nan=False).encode("utf-8")


def _span(value: Any) -> dict[str, str]:
    """``$trace`` as the API takes it: the span this event records."""
    if not isinstance(value, Mapping) or not all(isinstance(value.get(k), str) and value.get(k) for k in ("trace_id", "span_id")):
        raise KairosError("$trace needs a trace_id and a span_id, as text")
    span = {"trace_id": value["trace_id"], "span_id": value["span_id"]}
    for key in ("parent_span_id", "name", "status"):
        if value.get(key):
            span[key] = str(value[key])
    if value.get("end"):
        span["end"] = _iso(value["end"])
    return span


def _session(value: Any) -> dict[str, str]:
    """``$session`` as the API takes it. An empty value is no session."""
    if value is None or value == "":
        return {}
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        raise KairosError("$session must be the id of a session, as text")
    return {"session": str(value)}


class _NoEntity(KairosError):
    """A call names no entity. An automatic event with no one to be about is left out."""


def _by_subject(name: str, value: Any, entities: Mapping[str, str], about: list[str], event: str) -> dict[str, dict[str, Any]] | None:
    """``$set`` in the form the API takes: entity type → properties.

    ``{"user": {…}}`` is that form already. ``{"kyc_level": "full"}`` is about the one entity the event is
    about: ``about`` is the entity types that can be, which are the ones the call named and not the
    ones a request added.
    """
    if value is None:
        return None
    if not isinstance(value, Mapping):
        raise KairosError(f'{name} on "{event}" must be a dict of properties')
    if len(value) == 0:
        return None
    if all(key in entities and isinstance(inner, Mapping) for key, inner in value.items()):
        return {str(key): dict(inner) for key, inner in value.items()}
    if len(about) != 1:
        raise KairosError(f'{name} on "{event}": the event names {", ".join(about)}. Say which entity the properties are for: {name}: {{"{about[0]}": {{…}}}}')
    return {about[0]: dict(value)}


def _http(method: str, url: str, headers: dict[str, str], body: bytes, timeout: float) -> tuple[int, bytes, Mapping[str, str]]:
    """The default transport: the standard library, one request, no retries."""
    request = urllib.request.Request(url, data=body or None, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read(), dict(response.headers.items())
    except urllib.error.HTTPError as error:
        # An error status is an answer, not a failure of the network.
        with error:
            return error.code, error.read(), dict(error.headers.items())
    except socket.timeout as error:
        # Before Python 3.10 this is not a TimeoutError.
        raise TimeoutError(str(error)) from error
    except urllib.error.URLError as error:
        if isinstance(error.reason, (TimeoutError, socket.timeout)):
            raise TimeoutError(str(error.reason)) from error
        raise OSError(str(error.reason)) from error


# Clients that still hold events when the process ends. Weak, so that a client can be collected.
_live: weakref.WeakSet[Kairos] = weakref.WeakSet()


@atexit.register
def _flush_at_exit() -> None:
    for client in list(_live):
        # The process is ending; there is no one to tell.
        with contextlib.suppress(Exception):
            client.shutdown()


class Kairos:
    """A Kairos client. One for the process; it is safe to use from several threads.

    :param api_key: A secret key (``ksk_…``, server side only) or a public key (``kpk_…``, sends events only).
    :param base_url: Where the API is. Default ``https://kairos.finic.ai``; a self-hosted server has its own address.
    :param flush_at: The queue size that starts a send.
    :param flush_interval: Send at least this often, in seconds. 0 turns the timer off.
    :param max_queue_size: Events kept while the API cannot be reached. Past it, the oldest are dropped.
    :param timeout: The time limit, in seconds, for one event upload and for the calls that define and label.
    :param decide_timeout: The time limit, in seconds, for one decision, including retries.
    :param max_retries: Retries after a network failure, 408, 429 or 5xx.
    :param on_error: Called with the error for a delivery failure and for dropped events. It must not raise.
    :param transport: Sends one request. Supply your own for a proxy or for tests.
    """

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = "https://kairos.finic.ai",
        flush_at: int = 20,
        flush_interval: float = 2.0,
        max_queue_size: int = 10_000,
        timeout: float = 10.0,
        decide_timeout: float = 3.0,
        max_retries: int = 3,
        on_error: Callable[[Exception], None] | None = None,
        transport: Transport | None = None,
    ) -> None:
        if not api_key:
            raise KairosError("api_key is required")
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._flush_at = flush_at
        self._flush_interval = flush_interval
        self._max_queue_size = max_queue_size
        self._timeout = timeout
        self._decide_timeout = decide_timeout
        self._max_retries = max_retries
        self._on_error = on_error
        self._transport: Transport = transport or _http

        self._queue: list[dict[str, Any]] = []
        self._lock = threading.Lock()  # the queue and the timer
        self._sending = threading.Lock()  # one upload at a time, so that events arrive in the order they were tracked
        self._timer: threading.Timer | None = None
        self._kicked = False  # a background send was started and has not begun yet
        self._closed = False
        self._contextual = False  # a context was opened for this client at some time
        _live.add(self)

    def __enter__(self) -> Kairos:  # noqa: PYI034 - Self needs Python 3.11 or a dependency
        return self

    def __exit__(self, *_: object) -> None:
        self.shutdown()

    @contextlib.contextmanager
    def context(self, entities: Mapping[str, Any] | None = None, *, session: Any = None, subject: str = "user") -> Iterator[None]:
        """Say who is acting, for every call in the block that does not say.

            with kairos.context({"user": "user_42", "device": "dev_9"}, session="sess_1"):
                kairos.track("transaction", {"amount": 900})

        For work with no HTTP request: a queue worker, a scheduled job, a test. In a web
        application, ``kairos.middleware.KairosASGI`` opens one for each request.

        :param entities: Entity type → id. An empty value is left out.
        :param session: The visit this happens in.
        :param subject: The entity type of the person who acts. A call that names someone else
            of this type takes nothing from the context.
        """
        token = self._enter(Scope(subject, lambda: (entities, session)))
        try:
            yield
        finally:
            _context.leave(token)

    @contextlib.contextmanager
    def without_context(self) -> Iterator[None]:
        """Run the block with no context, for work inside a request that is about other people."""
        token = self._enter(None)
        try:
            yield
        finally:
            _context.leave(token)

    def set_context(self, entities: Mapping[str, Any] | None = None, *, session: Any = None) -> None:
        """Say who is acting, from inside a request.

        For a sign-in handler, which learns the user and makes the session itself. The values win
        over the resolvers of the middleware for the rest of the request.
        """
        scope = _context.current(self)
        if scope is None:
            raise KairosError("set_context was called outside a request. Use `with kairos.context(...)` for work that has no request.")
        scope.entities.update(entities or {})
        if session is not None:
            scope.session = session

    def _enter(self, scope: Scope | None) -> Any:
        self._contextual = True
        return _context.enter(self, scope)

    def _acting(self, scope: Scope | None, named: dict[str, str], session: Any) -> tuple[dict[str, str], dict[str, str], list[str]]:
        """Who a call is about: the entities it names, and what the request adds. What the call names wins.

        A session of ``""`` is no session. Left out, it is the session of the request.
        Returns the entities, the session as the API takes it, and what ``$set`` can be about.
        """
        own = (named, _session(session), list(named))
        if scope is None:
            return own
        try:
            entities, found = scope.resolve()
            visit = _session(found)
        except Exception as error:  # noqa: BLE001 - any failure of a resolver is reported, not raised
            # A resolver that fails must not fail the request. The call goes on with what it names.
            self._report(error)
            return own
        # A call about someone else, such as a support agent changing a customer's account, takes
        # nothing from the request: the agent's device is not the customer's.
        who = entities.get(scope.subject)
        if who is not None and named.get(scope.subject, who) != who:
            return own
        merged = {**entities, **named}
        about = list(named) or ([scope.subject] if scope.subject in merged else list(merged))
        return merged, visit if session is None else own[1], about

    def _no_entity(self, what: str) -> _NoEntity:
        outside = " A context is in use for this client, but this call did not run inside it, or the request has no identity yet." if self._contextual else ""
        return _NoEntity(f"{what} names no entity. Add a property such as user_id, or pass entities.{outside}")

    def _auto(self, scope: Scope, type: str, properties: Callable[[], Properties]) -> bool:
        """Send the event of a route, and say whether it did.

        The event is left out when the request has no one to be about, or when the handler
        tracked that type itself.
        """
        if type in scope.tracked:
            return False
        try:
            self._put(self._event(type, properties(), None, None, None, None, None, None, None, None, scope))
        except _NoEntity:
            return False
        except Exception as error:  # noqa: BLE001 - any failure of a resolver is reported, not raised
            self._report(error)
            return False
        return True

    def track(
        self,
        type: str,
        properties: Properties | None = None,
        *,
        timestamp: Moment | None = None,
        event_id: str | None = None,
        universal_id: str | None = None,
        status: str | None = None,
        session: str | None = None,
        set: Mapping[str, Any] | None = None,
        set_once: Mapping[str, Any] | None = None,
        entities: Mapping[str, str] | None = None,
    ) -> None:
        """Record an event. Returns at once; events are sent in batches in the background.

        Raises only for an invalid call, never for a delivery failure (see ``on_error``).

        :param properties: Anything about the event. A key that ends in ``_id`` names an entity.
        :param timestamp: When it happened. Default: now.
        :param event_id: Your own id, to make a retried call idempotent.
        :param universal_id: Events with the same value are stages of one record.
        :param status: The state of the record at this stage, for example "pending".
        :param session: The visit this happens in: the id of the login session in your own system.
            Inside a request with a context, ``""`` is no session and leaving it out is the session of the request.
        :param set: Properties to set on the entity the event is about. The newest event wins.
        :param set_once: The same, but only for a property that has no value yet.
        :param entities: Entity type → id, for references that do not follow the ``_id`` naming.

        Each of these can also be a key of ``properties``, as ``$session``, ``$set``, ``$set_once``,
        ``timestamp``, ``event_id``, ``universal_id``, ``status`` and ``entities``.

        ``$trace`` in ``properties`` is the span the event records, for the console's trace view:
        ``{"trace_id", "span_id", "parent_span_id", "name", "end", "status"}``. A decision does not read it.
        """
        self._put(self._event(type, properties, timestamp, event_id, universal_id, status, session, set, set_once, entities, _context.current(self)))

    def _put(self, event: dict[str, Any]) -> None:
        with self._lock:
            self._queue.append(event)
            dropped = self._trim()
            kick = len(self._queue) >= self._flush_at and not self._kicked
            if kick:
                self._kicked = True
            else:
                self._schedule()
        self._report_dropped(dropped)
        if kick:
            # Not in the caller's thread: track must not wait for the network.
            threading.Thread(target=self.flush, name="kairos-flush", daemon=True).start()

    def track_and_decide(
        self,
        type: str,
        properties: Properties | None = None,
        *,
        fallback: Outcome | None = None,
        timeout: float | None = None,
        flush: bool = True,
        timestamp: Moment | None = None,
        event_id: str | None = None,
        universal_id: str | None = None,
        status: str | None = None,
        session: str | None = None,
        set: Mapping[str, Any] | None = None,
        set_once: Mapping[str, Any] | None = None,
        entities: Mapping[str, str] | None = None,
    ) -> Decision:
        """Record an event and get the decision it starts, in one call.

        The event type must be the ``trigger`` of an action. Unlike ``track``, this waits for the answer.
        Use it for the event that is the request itself: "withdrawal_requested", "application_submitted".
        The event is stored, so later decisions see it, and it is the pending action of this decision.

        :param fallback: The outcome to return when Kairos cannot answer in time. Without it, this raises.
        :param timeout: The time limit in seconds. Default: ``decide_timeout``.
        :param flush: Send queued events first, so the decision sees them. Default true.
        """
        event = self._event(type, properties, timestamp, event_id, universal_id, status, session, set, set_once, entities, _context.current(self))
        return self._event_decision(event, fallback, timeout, flush)

    def _auto_decide(self, scope: Scope, type: str, properties: Properties, *, fallback: Outcome, timeout: float | None) -> Decision | None:
        """``track_and_decide`` for the route of a middleware. No decision for a request with no one to be about."""
        try:
            event = self._event(type, properties, None, None, None, None, None, None, None, None, scope)
        except _NoEntity:
            return None
        except Exception as error:  # noqa: BLE001 - any failure of a resolver is reported, not raised
            self._report(error)
            return None
        return self._event_decision(event, fallback, timeout, True)

    def _event_decision(self, event: dict[str, Any], fallback: Outcome | None, timeout: float | None, flush: bool) -> Decision:
        limit = self._decide_timeout if timeout is None else timeout
        deadline = time.monotonic() + limit
        try:
            if flush:
                self._drain(deadline, limit)
            return self._decision(self._request("POST", "/v1/events/decide", event, deadline, limit))
        except KairosError as error:
            # The request may not have arrived. Queue the event so the history keeps it; the id
            # makes that safe if it did arrive. A rejected event is not sent again.
            if not isinstance(error, KairosApiError) or error.status in RETRYABLE:
                with self._lock:
                    self._queue.append(event)
                    dropped = self._trim()
                    self._schedule()
                self._report_dropped(dropped)
            if fallback is None:
                raise
            return Decision(decision=fallback, risk_score=0, probability=0.0, event_id=event["id"], fallback=True, error=error)

    def flush(self) -> None:
        """Send every queued event and wait for the result. Delivery failures go to ``on_error``."""
        with self._lock:
            self._cancel_timer()
            self._kicked = False
        try:
            self._drain(None, self._timeout)
        except KairosError as error:
            self._report(error)

    def client_settings(self) -> dict[str, Any]:
        """The client settings of the key's environment, as set in Settings › Integrations. Needs a secret key."""
        return self._request("GET", "/v1/client-settings", None, time.monotonic() + self._timeout, self._timeout)

    def shutdown(self) -> None:
        """Send what is queued and stop the timer. Call before the process exits.

        The client also does this itself when the interpreter ends, for a process that forgets.
        """
        self._closed = True
        self.flush()
        _live.discard(self)

    def decide(
        self,
        action: Any,
        properties: Properties | None = None,
        *,
        session: str | None = None,
        entities: Mapping[str, str] | None = None,
        fallback: Outcome | None = None,
        timeout: float | None = None,
        timestamp: Moment | None = None,
        flush: bool = True,
    ) -> Decision:
        """Ask for a decision on a pending action.

        Queued events are sent first, so the decision sees everything tracked before this call.

            decision = kairos.decide("withdrawal", {"user_id": "user_42", "usd": 900}, fallback="review")

        :param action: The key of a defined action, for example "bank_transfer".
        :param properties: The pending action. Entities are read from the keys as for an event.
        :param session: The visit this happens in.
        :param fallback: The outcome to return when Kairos cannot answer in time. Without it, this raises.
            Choose for each decision: "approve" fails open, "review" fails closed.
        :param timeout: The time limit in seconds, including retries. Default: ``decide_timeout``.
        :param timestamp: Decide as of a past moment, seeing only events up to it. For backtests.
        :param flush: Send queued events first. Default true.

        ``decide({"type": "withdrawal", "user_id": …})`` is the same call, in the form of the TypeScript SDK.
        """
        given: dict[str, Any] = dict(properties or {})
        if isinstance(action, Mapping):
            given = {**action, **given}
            action = given.pop("type", None)
        if not action or not isinstance(action, str):
            raise KairosError("A decision needs an action: the key of a defined action")
        in_properties = given.pop("$session", None)
        in_session = in_properties if session is None else session
        if entities is not None:
            given["entities"] = {**(given.get("entities") or {}), **entities}
        named, rest = _split(given)
        named, visit, _ = self._acting(_context.current(self), named, in_session)
        if not named:
            raise self._no_entity(f'Decision "{action}"')
        request: dict[str, Any] = {"action": action, "entities": named, "properties": rest, **visit}
        if timestamp is not None:
            request["ts"] = _iso(timestamp)
        self._check(request, f'Decision "{action}"')

        limit = self._decide_timeout if timeout is None else timeout
        deadline = time.monotonic() + limit
        try:
            if flush:
                self._drain(deadline, limit)
            return self._decision(self._request("POST", "/v1/decide", request, deadline, limit))
        except KairosError as error:
            if fallback is None:
                raise
            return Decision(decision=fallback, risk_score=0, probability=0.0, fallback=True, error=error)

    def define_action(self, name: str, definition: Mapping[str, Any]) -> dict[str, Any]:
        """Define or change an action.

        A change to the definition is stored as a new version. Sending the same definition again
        changes nothing, so this is safe to call at startup. Returns the definition with ``name`` and ``version``.
        """
        return self._call("PUT", f"/v1/actions/{quote(name, safe='')}", definition)

    def run_workflow(
        self,
        name: str,
        input: Mapping[str, Any] | None = None,
        *,
        wait: bool = False,
        timeout_seconds: float | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        """Start a run of a workflow, with the inputs of its manual trigger. Returns the run.

        :param wait: Wait for the run to end, and get its ``output``. The workflow must have no
            delay. When the server's time is up first, the run goes on in the background, and its
            ``status`` says so.
        :param timeout_seconds: With ``wait``: how long the server runs it before it answers. 1 to 30. Default 10.
        :param idempotency_key: The same key gives the same run. Default: a new key, which a retry keeps.
        """
        body: dict[str, Any] = {"input": dict(input or {}), "idempotency_key": idempotency_key or str(uuid.uuid4())}
        if wait:
            body["wait"] = True
            if timeout_seconds is not None:
                body["timeout_seconds"] = timeout_seconds
        path = f"/v1/workflows/{quote(name, safe='')}/runs"
        self._check(body, f"POST {path}")
        # The server answers once its own time is up: wait for that, and a margin.
        limit = (timeout_seconds or 10) + 5 if wait else self._timeout
        return self._request("POST", path, body, time.monotonic() + limit, limit)

    def define_entity(self, type: str, definition: Mapping[str, Any] | None = None) -> dict[str, Any]:
        """Define or change an entity type: what it means, which properties it carries, and whether sharing one links two subjects."""
        return self._call("PUT", f"/v1/entity-types/{quote(type, safe='')}", definition or {})

    def entity(self, type: str, id: str, properties: Mapping[str, Any] | None = None) -> None:
        """Create an entity, or update what is known about it. Properties are merged into what is stored.

        An entity also comes into being when an event names it. Use this when you know something
        about it before, or apart from, any event.
        """
        self.set_object(type, id, properties or {})

    def set_object(self, type: str, id: str, properties: Mapping[str, Any]) -> None:
        """Store properties on an entity: what ``entity()`` uses underneath."""
        self._call("PUT", "/v1/objects", {"batch": [{"type": type, "id": str(id), "properties": dict(properties)}]})

    def label(
        self,
        entity: Mapping[str, str],
        label: str,
        properties: Mapping[str, Any] | None = None,
        *,
        timestamp: Moment | None = None,
    ) -> None:
        """Record an outcome or a verdict on an entity, for example "fraud_confirmed".

        :param entity: ``{"type": "user", "id": "user_42"}``.
        :param timestamp: When the outcome became known. Default: now. A decision made as of an
            earlier moment does not see a label from after that moment.
        """
        item: dict[str, Any] = {"entity": {"type": entity["type"], "id": str(entity["id"])}, "label": label, "properties": dict(properties or {})}
        if timestamp is not None:
            item["ts"] = _iso(timestamp)
        self._call("POST", "/v1/labels", {"batch": [item]})

    def resolve(self, decision_id: str, outcome: str, *, note: str | None = None, by: str | None = None) -> dict[str, Any]:
        """Record a person's decision on a decision, for example after a manual review.

        :param outcome: ``"approve"`` or ``"block"``.
        :param by: Who decided, for example ``"case-tool:alice"``.
        :returns: The decision with its new ``revision``, ``resolution`` and ``final_outcome``.

        The model's decision stays on record. Webhooks that want ``decision.updated`` are told.
        """
        if outcome not in ("approve", "block"):
            raise KairosError(f'outcome must be "approve" or "block", not {outcome!r}')
        body: dict[str, Any] = {"outcome": outcome}
        if note:
            body["note"] = note
        if by:
            body["by"] = by
        return self._call("POST", f"/v1/decisions/{quote(decision_id, safe='')}/resolution", body)

    def _event(
        self,
        type: str,
        properties: Properties | None,
        timestamp: Moment | None,
        event_id: str | None,
        universal_id: str | None,
        status: str | None,
        session: str | None,
        set: Mapping[str, Any] | None,
        set_once: Mapping[str, Any] | None,
        entities: Mapping[str, str] | None,
        scope: Scope | None,
    ) -> dict[str, Any]:
        """Check an event and put it in the form the API takes."""
        if self._closed:
            raise KairosError("An event was sent after shutdown()")
        if not type or not isinstance(type, str):
            raise KairosError("An event needs a type")
        given: dict[str, Any] = dict(properties or {})

        def take(argument: Any, *keys: str) -> Any:
            """The keyword argument, or else the same thing as a key of the properties."""
            found = None
            for key in keys:
                value = given.pop(key, None)
                found = value if found is None else found
            return found if argument is None else argument

        timestamp = take(timestamp, "timestamp")
        event_id = take(event_id, *_EVENT_ID)
        universal_id = take(universal_id, *_UNIVERSAL_ID)
        session = take(session, "$session")
        trace = given.pop("$trace", None)
        set = take(set, "$set")
        set_once = take(set_once, "$set_once")
        # A status that is not text is an ordinary property.
        if status is None and isinstance(given.get("status"), str):
            status = given.pop("status")
        if entities is not None:
            given["entities"] = {**(given.get("entities") or {}), **entities}

        named, rest = _split(given)
        named, visit, about = self._acting(scope, named, session)
        if not named:
            raise self._no_entity(f'Event "{type}"')
        event: dict[str, Any] = {"id": str(event_id) if event_id else str(uuid.uuid4()), "type": type, "ts": _iso(timestamp), "entities": named, "properties": rest}
        if universal_id:
            event["universal_id"] = str(universal_id)
        if status:
            event["status"] = status
        event.update(visit)
        if trace is not None:
            event["trace"] = _span(trace)
        for field, value in (("set", _by_subject("$set", set, named, about, type)), ("set_once", _by_subject("$set_once", set_once, named, about, type))):
            if value is not None:
                event[field] = value
        self._check(event, f'Event "{type}"')
        if scope is not None:
            scope.tracked.add(type)
        return event

    @staticmethod
    def _check(body: Any, what: str) -> None:
        """A value that cannot be sent is an invalid call, so it fails where it was made and not later in the background."""
        try:
            _encode(body)
        except (TypeError, ValueError) as error:
            raise KairosError(f"{what} has a property that cannot be sent as JSON: {error}") from None

    @staticmethod
    def _decision(body: Mapping[str, Any]) -> Decision:
        risk = body.get("risk_score", 0)
        return Decision(
            decision=body["decision"],
            risk_score=risk,
            probability=body.get("probability", risk / 100),
            reasons=list(body.get("reasons") or []),
            typology=body.get("typology") or None,
            rules=list(body.get("rules") or []),
            action=body.get("action") or None,
            decision_id=body.get("decision_id") or None,
            event_id=body.get("event_id") or None,
        )

    def _schedule(self) -> None:
        """The caller holds the lock."""
        if self._timer is not None or self._flush_interval <= 0:
            return
        self._timer = threading.Timer(self._flush_interval, self._on_timer)
        # Do not keep the process alive only for the timer.
        self._timer.daemon = True
        self._timer.name = "kairos-timer"
        self._timer.start()

    def _on_timer(self) -> None:
        with self._lock:
            self._timer = None
        self.flush()

    def _cancel_timer(self) -> None:
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None

    def _trim(self) -> int:
        """Drop the oldest events beyond the limit. The caller holds the lock. Returns how many."""
        overflow = len(self._queue) - self._max_queue_size
        if overflow <= 0:
            return 0
        del self._queue[:overflow]
        return overflow

    def _report_dropped(self, dropped: int) -> None:
        if dropped:
            self._report(KairosError(f"Event queue is full; dropped the {dropped} oldest events"))

    def _report(self, error: Exception) -> None:
        if self._on_error is None:
            return
        # A handler that fails must not break tracking.
        with contextlib.suppress(Exception):
            self._on_error(error)

    def _batch_size(self) -> int:
        """Call with the lock held."""
        total = 0
        n = 0
        while n < len(self._queue) and n < MAX_BATCH:
            total += len(json.dumps(self._queue[n], default=_json_default, separators=(",", ":")).encode()) + 1
            if n > 0 and total > MAX_BATCH_BYTES:
                break
            n += 1
        return n

    def _drain(self, deadline: float | None, limit: float) -> None:
        """Send the queue, a batch at a time. With a deadline, raise when it passes; without, report failures."""
        if deadline is None:
            self._sending.acquire()
        elif not self._sending.acquire(timeout=max(0.0, deadline - time.monotonic())):
            raise KairosTimeoutError(limit)
        try:
            while True:
                with self._lock:
                    size = self._batch_size()
                    batch = self._queue[:size]
                    del self._queue[:size]
                if not batch:
                    return
                try:
                    self._request("POST", "/v1/events", {"batch": batch}, deadline, limit if deadline is not None else self._timeout)
                except KairosError as error:
                    # A rejected batch will be rejected again, so drop it. Keep the rest for the next send.
                    dropped = 0
                    if not isinstance(error, KairosApiError) or error.status in RETRYABLE:
                        with self._lock:
                            self._queue[:0] = batch
                            dropped = self._trim()
                    self._report_dropped(dropped)
                    if deadline is not None and isinstance(error, KairosTimeoutError):
                        raise
                    self._report(error)
                    return
        finally:
            self._sending.release()

    def _call(self, method: str, path: str, body: Any) -> dict[str, Any]:
        self._check(body, f"{method} {path}")
        return self._request(method, path, body, time.monotonic() + self._timeout, self._timeout)

    def _request(self, method: str, path: str, body: Any, deadline: float | None, limit: float) -> dict[str, Any]:
        """One request with retries. ``deadline`` is for the whole of it; without one, each attempt has ``limit``."""
        data = b"" if method == "GET" else _encode(body)
        headers = {"Authorization": f"Bearer {self._api_key}", "User-Agent": "kairos-python/0.2.0"}
        if method != "GET":
            headers["Content-Type"] = "application/json"
        last: KairosError = KairosError("Request failed")
        for attempt in range(self._max_retries + 1):
            if attempt > 0:
                wait = min(0.2 * 2 ** (attempt - 1), 5.0) * (0.5 + random.random() / 2)
                if deadline is not None:
                    wait = min(wait, max(0.0, deadline - time.monotonic()))
                time.sleep(wait)
            remaining = limit if deadline is None else deadline - time.monotonic()
            if remaining <= 0:
                raise KairosTimeoutError(limit)
            try:
                status, raw, response_headers = self._transport(method, self._base_url + path, headers, data, remaining)
            except TimeoutError:
                if deadline is not None:
                    raise KairosTimeoutError(limit) from None
                last = KairosTimeoutError(limit)
                continue
            except OSError as error:
                last = KairosError(f"Network request failed: {error}")
                last.__cause__ = error
                continue
            if 200 <= status < 300:
                if status == 204 or not raw:
                    return {}
                try:
                    parsed = json.loads(raw)
                except ValueError:
                    raise KairosError("The API answered with something that is not JSON") from None
                return parsed if isinstance(parsed, dict) else {"data": parsed}
            request_id = next((value for key, value in response_headers.items() if key.lower() == "x-request-id"), None)
            last = KairosApiError(status, raw.decode("utf-8", "replace")[:500], request_id)
            if status not in RETRYABLE:
                raise last
        raise last
