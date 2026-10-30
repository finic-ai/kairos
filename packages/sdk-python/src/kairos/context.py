"""The context of a request: who is acting, for the calls that do not say."""

from __future__ import annotations

import contextvars
from collections.abc import Mapping
from typing import Any, Callable

from .errors import KairosError

#: What a resolver gives: entity type → id, and the session. An empty value is no value.
Resolver = Callable[[], "tuple[Mapping[str, Any] | None, Any]"]


class Scope:
    """The context of one request, or of one ``with kairos.context(...)`` block."""

    __slots__ = ("_resolve", "entities", "session", "subject", "tracked")

    def __init__(self, subject: str, resolve: Resolver) -> None:
        #: The entity type of the person who makes the request, for example "user".
        self.subject = subject
        #: The event types tracked in this request, so that an automatic event does not repeat one.
        self.tracked: set[str] = set()
        #: What ``set_context`` gave. It wins over the resolver.
        self.entities: dict[str, Any] = {}
        self.session: Any = None
        self._resolve = resolve

    def resolve(self) -> tuple[dict[str, str], Any]:
        """Who is acting, as known at this moment. Called late, because sign-in runs after the middleware."""
        found, session = self._resolve()
        entities: dict[str, str] = {}
        for kind, value in {**(found or {}), **self.entities}.items():
            if value is None or value == "":
                continue
            if isinstance(value, bool) or not isinstance(value, (str, int)):
                raise KairosError(f'The context gave a {type(value).__name__} as the id of "{kind}". An id is text or a number.')
            entities[str(kind)] = str(value)
        return entities, session if self.session is None else self.session


# The scopes that are open, the innermost last, each with the client it is for. A client reads
# only its own, so two clients in a process do not read each other's requests. None is a
# block that left the context.
_open: contextvars.ContextVar[tuple[tuple[object, Scope | None], ...]] = contextvars.ContextVar("kairos_context", default=())


def current(client: object) -> Scope | None:
    for owner, scope in reversed(_open.get()):
        if owner is client:
            return scope
    return None


def enter(client: object, scope: Scope | None) -> contextvars.Token[tuple[tuple[object, Scope | None], ...]]:
    return _open.set((*_open.get(), (client, scope)))


def leave(token: contextvars.Token[tuple[tuple[object, Scope | None], ...]]) -> None:
    _open.reset(token)
