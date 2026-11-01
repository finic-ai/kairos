"""Kairos client: track financial events, then ask for a decision at the moment of action.

    from kairos import Kairos

    kairos = Kairos(api_key="ksk_…")
    kairos.track("login", {"user_id": "user_42", "device_id": "dev_9"})
    decision = kairos.decide("withdrawal", {"user_id": "user_42", "usd": 900}, fallback="review")
"""

from .client import Kairos
from .errors import KairosApiError, KairosError, KairosTimeoutError
from .types import Decision, Moment, Outcome, Properties, Transport
from .webhooks import KairosWebhookError, verify_webhook

__all__ = ["Decision", "Kairos", "KairosApiError", "KairosError", "KairosTimeoutError", "KairosWebhookError", "Moment", "Outcome", "Properties", "Transport", "verify_webhook"]
__version__ = "0.2.0"
