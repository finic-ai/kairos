"""Tests for verify_webhook. Standard library only: python3 -m unittest discover -s packages/sdk-python/tests"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from kairos import KairosError, KairosWebhookError, verify_webhook

# The test vector of the Standard Webhooks specification.
SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"
OTHER = "whsec_" + base64.b64encode(b"another secret of thirty-two bytes!").decode()
NOW = 1614265330
BODY = json.dumps({"id": "msg_1", "type": "decision.created", "version": 1, "data": {"decision": "block"}})


def sign(secret: str, msg_id: str, ts: int, body: str) -> str:
    key = base64.b64decode(secret[len("whsec_"):])
    return "v1," + base64.b64encode(hmac.new(key, f"{msg_id}.{ts}.{body}".encode(), hashlib.sha256).digest()).decode()


def headers(signature: str | None = None, ts: str = str(NOW)) -> dict[str, str]:
    return {"webhook-id": "msg_1", "webhook-timestamp": ts, "webhook-signature": signature or sign(SECRET, "msg_1", NOW, BODY)}


class VerifyWebhookTest(unittest.TestCase):
    def test_reference_signature(self) -> None:
        self.assertEqual(sign(SECRET, "msg_p5jXN8AQM9LWM0D4loKWxJek", NOW, '{"test": 2432232314}'), "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=")
        reference = {"webhook-id": "msg_p5jXN8AQM9LWM0D4loKWxJek", "webhook-timestamp": str(NOW), "webhook-signature": "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE="}
        self.assertEqual(verify_webhook('{"test": 2432232314}', reference, SECRET, now=NOW), {"test": 2432232314})

    def test_returns_the_message(self) -> None:
        self.assertEqual(verify_webhook(BODY, headers(), SECRET, now=NOW)["data"], {"decision": "block"})
        self.assertEqual(verify_webhook(BODY.encode(), {k.upper(): [v] for k, v in headers().items()}, SECRET, now=NOW)["id"], "msg_1")

    def test_rotation(self) -> None:
        both = f"{sign(OTHER, 'msg_1', NOW, BODY)} {sign(SECRET, 'msg_1', NOW, BODY)}"
        self.assertEqual(verify_webhook(BODY, headers(both), SECRET, now=NOW)["id"], "msg_1")
        self.assertEqual(verify_webhook(BODY, headers(), [OTHER, SECRET], now=NOW)["id"], "msg_1")

    def test_refusals(self) -> None:
        cases = [
            (BODY.replace("block", "approve"), headers(), SECRET, NOW),
            (BODY, headers(), OTHER, NOW),
            (BODY, headers(), SECRET, NOW + 301),
            (BODY, {"webhook-id": "msg_1"}, SECRET, NOW),
            (BODY, headers("v1,not base64!"), SECRET, NOW),
            (BODY, headers(ts=str(NOW + 1)), SECRET, NOW),
            (BODY, headers(ts="soon"), SECRET, NOW),
            (BODY, headers("v1,é"), SECRET, NOW),
        ]
        for body, given, secret, now in cases:
            with self.assertRaises(KairosWebhookError):
                verify_webhook(body, given, secret, now=now)
        self.assertTrue(issubclass(KairosWebhookError, KairosError))


if __name__ == "__main__":
    unittest.main()
