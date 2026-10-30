from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable, Union

#: The four outcomes of a decision, from the least to the most severe.
Outcome = str  # "approve" | "step_up" | "review" | "block"

#: A moment: a datetime (one with no time zone is read as UTC), or an ISO 8601 string.
Moment = Union[datetime, str]

#: Properties of an event or of a pending action. A key that ends in ``_id`` (or ``Id``) names
#: an entity: ``user_id`` is the entity ``user``, ``bank_account_id`` is ``bank_account``.
Properties = Mapping[str, Any]

#: Sends one request and returns ``(status, body, headers)``. Raise ``TimeoutError`` for a
#: timeout and ``OSError`` for a network failure. Supply your own for a proxy or for tests.
Transport = Callable[[str, str, dict[str, str], bytes, float], tuple[int, bytes, Mapping[str, str]]]


@dataclass(frozen=True)
class Decision:
    """The answer to ``decide``."""

    #: "approve", "step_up", "review" or "block".
    decision: Outcome
    #: 0 to 100. The hold probability times 100.
    risk_score: int
    #: The probability that the action should be held, 0 to 1.
    probability: float
    #: Signals judged present. Not a causal explanation of ``risk_score``.
    reasons: list[str] = field(default_factory=list)
    #: The most likely explanation, when the action has typologies.
    typology: str | None = None
    #: Policy rules that fired.
    rules: list[str] = field(default_factory=list)
    #: The action definition that produced this decision, as "name@version".
    action: str | None = None
    decision_id: str | None = None
    #: The event that started this decision, when ``track_and_decide`` did.
    event_id: str | None = None
    #: True when this is the ``fallback`` outcome and not an answer from Kairos.
    fallback: bool = False
    #: Set with ``fallback``: why Kairos could not answer.
    error: Exception | None = None
