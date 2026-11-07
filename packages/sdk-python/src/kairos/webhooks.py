"""Check a webhook from Kairos.

Kairos signs as Standard Webhooks does (https://www.standardwebhooks.com): the
``webhook-signature`` header holds one or more ``v1,<base64 HMAC-SHA256>`` of
``{webhook-id}.{webhook-timestamp}.{body}``.

    from kairos import verify_webhook

    message = verify_webhook(request.body, request.headers, os.environ["KAIROS_WEBHOOK_SECRET"])
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import time
from collections.abc import Mapping, Sequence
from typing import Any, Union

from .errors import KairosError

Headers = Mapping[str, Union[str, Sequence[str]]]


class KairosWebhookError(KairosError):
    """The delivery is not from Kairos, is too old, or is not what Kairos sends. Answer 400 or 401."""


def _header(headers: Headers, name: str) -> str | None:
    value: Any = headers.get(name)
    if value is None:
        value = next((v for k, v in headers.items() if k.lower() == name), None)
    if isinstance(value, (list, tuple)):
        value = value[0] if value else None
    return value if isinstance(value, str) else None


def verify_webhook(
    body: str | bytes,
    headers: Headers,
    secret: str | Sequence[str],
    *,
    tolerance_seconds: int = 300,
    now: float | None = None,
) -> dict[str, Any]:
    """Verify a delivery and return the message as a dict.

    Pass the body exactly as it arrived, before any JSON parsing: a parsed and re-written body
    does not match its signature. ``secret`` is the endpoint's ``whsec_…`` secret; during a
    rotation, pass the old and the new one. The message ``id`` is the same on every retry: keep
    the ids you processed and skip a repeat.
    """
    msg_id = _header(headers, "webhook-id")
    timestamp = _header(headers, "webhook-timestamp")
    signatures = _header(headers, "webhook-signature")
    if not msg_id or not timestamp or not signatures:
        raise KairosWebhookError("Missing webhook-id, webhook-timestamp or webhook-signature header")
    try:
        seconds = int(timestamp)
    except ValueError:
        raise KairosWebhookError("The webhook timestamp is not a number") from None
    current = int(time.time() if now is None else now)
    if abs(current - seconds) > tolerance_seconds:
        raise KairosWebhookError("The webhook timestamp is too old or too far in the future")

    text = body.decode("utf-8") if isinstance(body, bytes) else body
    signed = f"{msg_id}.{timestamp}.{text}".encode()
    candidates = [s[3:] for s in signatures.split(" ") if s.startswith("v1,")]
    for value in [secret] if isinstance(secret, str) else list(secret):
        try:
            key = base64.b64decode(value.removeprefix("whsec_"), validate=True)
        except (binascii.Error, ValueError):
            continue
        expected = base64.b64encode(hmac.new(key, signed, hashlib.sha256).digest()).decode()
        # Bytes: compare_digest raises TypeError on a str with non-ASCII characters.
        if any(hmac.compare_digest(expected.encode(), c.encode()) for c in candidates):
            try:
                message: dict[str, Any] = json.loads(text)
            except ValueError:
                raise KairosWebhookError("The webhook body is not JSON") from None
            return message
    raise KairosWebhookError("No webhook signature matches the secret")
