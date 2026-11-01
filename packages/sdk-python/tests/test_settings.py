"""Tests for the routes of the client settings: matching, and the properties of an event.

    python3 -m unittest discover -s packages/sdk-python/tests
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from kairos.settings import (
    MAX_BODY_BYTES,
    RequestParts,
    is_card_number,
    match_path,
    match_route,
    normalize_phone,
    read_path,
    readable_body,
    route_properties,
)


def settings(routes: list[dict[str, Any]], **patch: Any) -> dict[str, Any]:
    return {
        "version": 1,
        "consent": "not_required",
        "defaults": {"off": [], "country": "GB"},
        "routing": {"mode": "monitor", "other": "ignore"},
        "pages": [],
        "screens": [],
        "routes": [{"route": "POST /", "mode": "track", "type": "t", "fields": {}, "enforce": False, **r} for r in routes],
        **patch,
    }


def parts(**patch: Any) -> RequestParts:
    return RequestParts(**{"query": lambda name: None, "header": lambda name: None, "cookie": lambda name: None, **patch})


class RoutesTest(unittest.TestCase):
    def test_match_a_path_with_parameters_and_a_wildcard(self) -> None:
        self.assertEqual(match_path("/payees/:id/verify", "/payees/p%207/verify/"), {"id": "p 7"})
        self.assertIsNone(match_path("/payees/:id", "/payees"))
        self.assertIsNone(match_path("/payees/:id", "/payees/p7/verify"))
        self.assertEqual(match_path("/account/*", "/account/security/keys"), {})
        self.assertEqual(match_path("/", "/"), {})

    def test_match_the_first_route_with_the_method_and_none_when_routing_is_off(self) -> None:
        s = settings([{"route": "GET /payees/:id", "type": "viewed"}, {"route": "POST /payees/:id", "type": "first"}, {"route": "POST /payees/*", "type": "second"}])
        route, params = match_route(s, "post", "/payees/p7") or ({}, {})
        self.assertEqual((route.get("type"), params), ("first", {"id": "p7"}))
        self.assertIsNone(match_route(s, "DELETE", "/payees/p7"))
        self.assertIsNone(match_route({**s, "routing": {"mode": "off", "other": "ignore"}}, "POST", "/payees/p7"))


class FieldsTest(unittest.TestCase):
    def test_read_the_jsonpath_that_names_one_value(self) -> None:
        body = {"payee": {"id": "p7"}, "items": [{"sku": "A"}], "first name": "Ada", "count": 0}
        self.assertEqual(read_path(body, "$.payee.id"), "p7")
        self.assertEqual(read_path(body, "$.items[0].sku"), "A")
        self.assertEqual(read_path(body, "$['first name']"), "Ada")
        self.assertEqual(read_path(body, "$.count"), 0)
        self.assertIsNone(read_path(body, "$.items[3].sku"))
        self.assertIsNone(read_path(body, "payee.id"))

    def test_read_a_body_only_when_it_is_json_of_a_size_that_can_be_read(self) -> None:
        self.assertTrue(readable_body("application/json; charset=utf-8", None))
        self.assertTrue(readable_body("application/vnd.api+json", str(MAX_BODY_BYTES)))
        self.assertFalse(readable_body("application/json", str(MAX_BODY_BYTES + 1)))
        self.assertFalse(readable_body("multipart/form-data; boundary=x", "10"))
        self.assertFalse(readable_body("image/png", "10"))
        self.assertFalse(readable_body(None, "10"))

    def test_know_a_card_number_by_its_length_and_the_luhn_check(self) -> None:
        self.assertTrue(is_card_number("4111 1111 1111 1111"))
        self.assertFalse(is_card_number("4111-1111-1111-1112"))
        self.assertFalse(is_card_number("123456"))

    def test_write_a_phone_number_in_e164_where_they_can(self) -> None:
        self.assertEqual(normalize_phone("07700 900123", "GB"), "+447700900123")
        self.assertEqual(normalize_phone("+44 7700 900123"), "+447700900123")
        self.assertEqual(normalize_phone("0044 7700 900123"), "+447700900123")
        self.assertEqual(normalize_phone("06 1234 5678", "IT"), "+390612345678")
        self.assertEqual(normalize_phone("(555) 010-0199"), "5550100199")

    def test_make_the_properties_of_an_event_and_leave_out_what_must_not_be_sent(self) -> None:
        s = settings([], defaults={"off": ["address"], "country": "GB"})
        route = settings(
            [
                {
                    "fields": {
                        "email": {"from": "request.body", "path": "$.email", "kind": "email"},
                        "phone": {"from": "request.body", "path": "$.phone", "kind": "phone"},
                        "address": {"from": "request.body", "path": "$.address", "kind": "address"},
                        "card": {"from": "request.body", "path": "$.card"},
                        "payeeId": {"from": "request.param", "path": "id"},
                        "plan": {"from": "request.query", "path": "plan"},
                        "method": {"value": "password"},
                        "missing": {"from": "request.header", "path": "x-missing"},
                        "account": {"from": "request.body", "path": "$.account", "kind": "hmac"},
                        "sid": {"from": "request.cookie", "path": "sid"},
                    }
                }
            ]
        )["routes"][0]
        request = parts(
            body={"email": " Ada@Example.COM ", "phone": "07700 900123", "address": "1 High St", "card": "4111111111111111", "account": "12345678"},
            params={"id": "p7"},
            query=lambda name: "gold" if name == "plan" else None,
            cookie=lambda name: "secret-session" if name == "sid" else None,
        )
        self.assertEqual(
            route_properties(route, request, s),
            (
                {"email": "ada@example.com", "phone": "+447700900123", "payeeId": "p7", "plan": "gold", "method": "password"},
                [
                    'POST /: the field "account" is sent only as a hash, and there is no hash key.',
                    'POST /: the field "sid" is sent only as a hash, and there is no hash key.',
                ],
            ),
        )
        hashed, problems = route_properties(route, request, s, lambda value: f"h({value})")
        self.assertEqual((hashed["account"], hashed["sid"], problems), ("h(12345678)", "h(secret-session)", []))


if __name__ == "__main__":
    unittest.main()
