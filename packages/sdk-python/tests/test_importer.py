"""Tests for the importer. Standard library only: python3 -m unittest discover -s packages/sdk-python/tests"""

from __future__ import annotations

import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from typing import Any, Callable, ClassVar
from unittest import mock
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from kairos import Kairos, KairosError
from kairos import __main__ as cli
from kairos.importer import EntityMapping, EventMapping, LabelMapping, RejectsFile, import_entities, import_events, import_labels, read_rows


class Server:
    """A fake Kairos: stores event ids as the real one does, and refuses what the test says."""

    def __init__(self, refuse: Callable[[dict[str, Any]], bool] = lambda item: False, down: bool = False) -> None:
        self.calls: list[dict[str, Any]] = []
        self.ids: set[str] = set()
        self.refuse = refuse
        self.down = down

    def __call__(self, method: str, url: str, headers: dict[str, str], body: bytes, timeout: float) -> tuple[int, bytes, dict[str, str]]:
        payload = json.loads(body)
        path = urlparse(url).path
        self.calls.append({"method": method, "path": path, "batch": payload["batch"]})
        if self.down:
            return 503, b"{}", {}
        if any(self.refuse(item) for item in payload["batch"]):
            return 400, json.dumps({"error": {"type": "invalid_request", "message": "batch.0: refused by the test"}}).encode(), {}
        if path == "/v1/events":
            fresh = [item for item in payload["batch"] if item["id"] not in self.ids]
            self.ids.update(item["id"] for item in fresh)
            return 202, json.dumps({"accepted": len(fresh), "duplicates": len(payload["batch"]) - len(fresh)}).encode(), {}
        return 200, json.dumps({"accepted": len(payload["batch"])}).encode(), {}

    def sent(self, path: str = "/v1/events") -> list[dict[str, Any]]:
        return [item for call in self.calls if call["path"] == path for item in call["batch"]]


def client(server: Server) -> Kairos:
    return Kairos("ksk_test", base_url="https://k.test", transport=server, flush_interval=0, max_retries=0)


def write(directory: str, name: str, text: str) -> Path:
    path = Path(directory) / name
    path.write_text(text, encoding="utf-8")
    return path


class ReadTest(unittest.TestCase):
    def test_reads_csv_with_line_numbers_and_a_byte_order_mark(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            path = write(d, "t.csv", "﻿id,user_id\n1,u1\n\n2,u2\n3,u3,extra\n")
            rows = list(read_rows(path))
        self.assertEqual(rows[0], (2, {"id": "1", "user_id": "u1"}))
        self.assertEqual(rows[1][0], 4)
        self.assertIn("__extra__", rows[2][1])

    def test_reads_json_lines_and_marks_a_bad_line(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            path = write(d, "t.jsonl", '{"user_id": "u1", "usd": 5}\n\nnot json\n[1, 2]\n')
            rows = list(read_rows(path))
        self.assertEqual(rows[0], (1, {"user_id": "u1", "usd": 5}))
        self.assertEqual([r[0] for r in rows], [1, 3, 4])
        self.assertIn("__invalid__", rows[1][1])
        self.assertIn("__invalid__", rows[2][1])


class EventMappingTest(unittest.TestCase):
    mapping = EventMapping(type="transaction", ts="created_at", id="txn_id", entities={"user": "customer"})

    def test_maps_a_row_to_an_event(self) -> None:
        row = {"txn_id": "t1", "created_at": "2026-10-01 10:00:00", "customer": "c1", "payee_id": "p9", "amount": "95.50", "count": "3", "zip": "02139", "card": "4242424242424242", "flag": "TRUE", "note": "", "ref": "  abc "}
        self.assertEqual(
            self.mapping.event(row),
            {
                "id": "t1",
                "type": "transaction",
                "ts": "2026-10-01T10:00:00.000Z",
                "entities": {"user": "c1", "payee": "p9"},
                # A number, but not a code with a leading zero, and not a long identifier.
                "properties": {"amount": 95.5, "count": 3, "zip": "02139", "card": "4242424242424242", "flag": True, "ref": "abc"},
            },
        )

    def test_reads_each_time_format(self) -> None:
        def ts(value: Any, form: str = "iso") -> str:
            return EventMapping(type="t", ts="ts", ts_format=form).event({"ts": value, "user_id": "u"})["ts"]

        self.assertEqual(ts("2026-10-01"), "2026-10-01T00:00:00.000Z")
        self.assertEqual(ts("2026-10-01T12:00:00+02:00"), "2026-10-01T10:00:00.000Z")
        self.assertEqual(ts("2026-10-01T10:00:00Z"), "2026-10-01T10:00:00.000Z")
        self.assertEqual(ts("1790000000", "unix"), "2026-09-21T14:13:20.000Z")
        self.assertEqual(ts(1790000000123, "unix_ms"), "2026-09-21T14:13:20.123Z")
        self.assertEqual(ts("01/10/2026 10:00", "%d/%m/%Y %H:%M"), "2026-10-01T10:00:00.000Z")

    def test_gives_a_row_with_no_id_the_same_id_each_time(self) -> None:
        mapping = EventMapping(type="login", ts="ts")
        row = {"ts": "2026-10-01T10:00:00Z", "user_id": "u1"}
        self.assertEqual(mapping.event(row)["id"], mapping.event(dict(row))["id"])
        self.assertNotEqual(mapping.event(row)["id"], mapping.event({**row, "user_id": "u2"})["id"])
        self.assertRegex(mapping.event(row)["id"], r"^imp_[0-9a-f]{32}$")

    def test_takes_the_type_records_and_sessions_from_columns(self) -> None:
        mapping = EventMapping(type_column="kind", ts="ts", universal_id="ref", status="state", session="sid", exclude=["secret"], text=["code"])
        event = mapping.event({"kind": "payment", "ts": "2026-10-01", "user_id": "u", "ref": "r1", "state": "pending", "sid": "s1", "secret": "x", "code": "12"})
        self.assertEqual((event["type"], event["universal_id"], event["status"], event["session"]), ("payment", "r1", "pending", "s1"))
        self.assertEqual(event["properties"], {"code": "12"})

    def test_keeps_values_as_they_are_when_asked_and_in_json(self) -> None:
        strings = EventMapping(type="t", ts="ts", typed=False).event({"ts": "2026-10-01", "user_id": "u", "usd": "5"})
        self.assertEqual(strings["properties"], {"usd": "5"})
        from_json = EventMapping(type="t", ts="ts").event({"ts": "2026-10-01", "user_id": "u", "usd": "5", "nested": {"a": 1}, "n": 7})
        self.assertEqual(from_json["properties"], {"usd": 5, "nested": {"a": 1}, "n": 7})

    def test_includes_only_the_columns_asked_for_and_can_ignore_id_columns(self) -> None:
        mapping = EventMapping(type="t", ts="ts", include=["usd"], auto_entities=False, entities={"user": "user_id"})
        event = mapping.event({"ts": "2026-10-01", "user_id": "u", "payee_id": "p", "usd": "5", "note": "x"})
        self.assertEqual((event["entities"], event["properties"]), ({"user": "u"}, {"usd": 5}))

    def test_refuses_a_row_it_cannot_use_with_the_reason(self) -> None:
        cases = [
            ({"txn_id": "t", "created_at": "2026-10-01"}, "names no entity"),
            ({"txn_id": "t", "customer": "c"}, "no time"),
            ({"txn_id": "t", "customer": "c", "created_at": "yesterday"}, "is not a time"),
            ({"customer": "c", "created_at": "2026-10-01"}, "no id"),
            ({"txn_id": "x" * 300, "customer": "c", "created_at": "2026-10-01"}, "longer than 256"),
            ({"__extra__": ["x"], "txn_id": "t", "customer": "c", "created_at": "2026-10-01"}, "more cells"),
        ]
        for row, reason in cases:
            with self.assertRaisesRegex(ValueError, reason):
                self.mapping.event(row)

    def test_checks_the_mapping_before_reading_a_row(self) -> None:
        for mapping, reason in [
            (EventMapping(ts="ts"), "event type"),
            (EventMapping(type="a", type_column="b", ts="ts"), "event type"),
            (EventMapping(type="t"), "time of each event"),
            (EventMapping(type="t", ts="ts", entities={"bad type": "c"}), "not an entity type"),
        ]:
            with self.assertRaisesRegex(KairosError, reason):
                mapping.check()


class SharedRulesTest(unittest.TestCase):
    def test_types_values_as_the_console_does(self) -> None:
        # The same cases as packages/core/test/importing.test.ts: one file is stored the same way however it is imported.
        from kairos.importer import _value

        cases: list[tuple[Any, Any]] = [
            ("95.50", 95.5), ("3", 3), ("-12", -12), ("0", 0), ("0.5", 0.5),
            ("02139", "02139"), ("4242424242424242", "4242424242424242"), ("1e5", "1e5"), ("12.", "12."),
            ("TRUE", True), ("false", False), ("", None), ("   ", None), ("  abc ", "abc"),
            (7, 7), ({"a": 1}, {"a": 1}), (None, None),
        ]
        for raw, stored in cases:
            self.assertEqual(_value(raw, True), stored, raw)
        self.assertEqual(_value("5", False), "5")


class OtherMappingsTest(unittest.TestCase):
    def test_maps_an_entity_row(self) -> None:
        mapping = EntityMapping(type="user", id="customer_id", exclude=["password"])
        self.assertEqual(mapping.entity({"customer_id": "c1", "country": "GB", "age": "41", "password": "x", "empty": ""}), {"type": "user", "id": "c1", "properties": {"country": "GB", "age": 41}})
        with self.assertRaisesRegex(ValueError, "no id"):
            mapping.entity({"country": "GB"})

    def test_maps_a_label_row(self) -> None:
        mapping = LabelMapping(entity_type="user", entity="customer_id", label="fraud_confirmed", ts="reported")
        self.assertEqual(
            mapping.item({"customer_id": "c1", "reported": "2026-10-05", "amount": "120"}),
            {"entity": {"type": "user", "id": "c1"}, "label": "fraud_confirmed", "properties": {"amount": 120}, "ts": "2026-10-05T00:00:00.000Z"},
        )
        by_column = LabelMapping(entity_type="user", entity="customer_id", label_column="outcome")
        self.assertEqual(by_column.item({"customer_id": "c1", "outcome": "chargeback"})["label"], "chargeback")
        with self.assertRaisesRegex(ValueError, "is not a label"):
            by_column.item({"customer_id": "c1", "outcome": "two words"})
        with self.assertRaisesRegex(KairosError, "label"):
            LabelMapping(entity_type="user", entity="c").check()


class ImportTest(unittest.TestCase):
    rows: ClassVar[list[tuple[int, dict[str, Any]]]] = [(i + 2, {"txn_id": f"t{i}", "ts": "2026-10-01T10:00:00Z", "user_id": f"u{i}", "usd": str(i)}) for i in range(1203)]
    mapping = EventMapping(type="transaction", ts="ts", id="txn_id")

    def test_sends_batches_of_500_and_counts(self) -> None:
        server = Server()
        result = import_events(client(server), self.rows, self.mapping)
        self.assertEqual([len(c["batch"]) for c in server.calls], [500, 500, 203])
        self.assertEqual((result.read, result.stored, result.duplicates, result.rejected), (1203, 1203, 0, 0))

    def test_stores_nothing_twice_when_it_is_run_again(self) -> None:
        server = Server()
        import_events(client(server), self.rows[:700], self.mapping)
        result = import_events(client(server), self.rows, self.mapping)
        self.assertEqual((result.stored, result.duplicates), (503, 700))

    def test_finds_the_row_the_server_refuses_and_keeps_the_rest(self) -> None:
        server = Server(refuse=lambda item: item["id"] == "t7")
        rejected: list[tuple[int, str]] = []
        result = import_events(client(server), self.rows[:20], self.mapping, on_reject=lambda line, reason, row: rejected.append((line, reason)))
        self.assertEqual((result.stored, result.rejected), (19, 1))
        self.assertEqual(rejected, [(9, "the server refused it: batch.0: refused by the test")])
        self.assertNotIn("t7", server.ids)

    def test_rejects_bad_rows_without_sending_them_and_continues(self) -> None:
        server = Server()
        rows = [(2, {"txn_id": "a", "ts": "2026-10-01", "user_id": "u"}), (3, {"txn_id": "b", "ts": "nope", "user_id": "u"}), (4, {"txn_id": "c", "ts": "2026-10-01", "user_id": "u"})]
        with tempfile.TemporaryDirectory() as d:
            with RejectsFile(Path(d) / "r.jsonl") as rejects:
                result = import_events(client(server), rows, self.mapping, on_reject=rejects)
            written = [json.loads(line) for line in (Path(d) / "r.jsonl").read_text().splitlines()]
        self.assertEqual((result.stored, result.rejected), (2, 1))
        self.assertEqual(written, [{"line": 3, "reason": '"nope" is not a time', "row": {"txn_id": "b", "ts": "nope", "user_id": "u"}}])

    def test_writes_no_rejects_file_when_nothing_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            with RejectsFile(Path(d) / "r.jsonl") as rejects:
                import_events(client(Server()), self.rows[:3], self.mapping, on_reject=rejects)
            self.assertFalse((Path(d) / "r.jsonl").exists())

    def test_a_dry_run_sends_nothing_and_shows_the_first_rows(self) -> None:
        server = Server()
        result = import_events(client(server), self.rows, self.mapping, dry_run=True)
        self.assertEqual(server.calls, [])
        self.assertEqual((result.read, result.stored, len(result.sample)), (1203, 0, 5))
        self.assertEqual(result.sample[0]["id"], "t0")

    def test_stops_at_the_limit(self) -> None:
        server = Server()
        result = import_events(client(server), self.rows, self.mapping, limit=10, batch_size=4)
        self.assertEqual((result.read, [len(c["batch"]) for c in server.calls]), (10, [4, 4, 2]))

    def test_stops_with_an_error_when_the_server_cannot_be_reached(self) -> None:
        with self.assertRaises(KairosError):
            import_events(client(Server(down=True)), self.rows, self.mapping)

    def test_sends_entities_and_labels_to_their_endpoints(self) -> None:
        server = Server()
        import_entities(client(server), [(2, {"customer_id": "c1", "plan": "pro"})], EntityMapping(type="user", id="customer_id"))
        import_labels(client(server), [(2, {"customer_id": "c1"})], LabelMapping(entity_type="user", entity="customer_id", label="chargeback"))
        self.assertEqual([(c["method"], c["path"]) for c in server.calls], [("PUT", "/v1/objects"), ("POST", "/v1/labels")])


class CommandTest(unittest.TestCase):
    def run_cli(self, argv: list[str], server: Server | None = None) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()

        def made(api_key: str, **options: Any) -> Kairos:
            return Kairos(api_key, **{**options, "transport": server or Server(), "max_retries": 0})

        with mock.patch.object(cli, "Kairos", made), redirect_stdout(out), redirect_stderr(err):
            code = cli.main(argv)
        return code, out.getvalue(), err.getvalue()

    def test_imports_events_from_a_csv_file_and_reports(self) -> None:
        server = Server()
        with tempfile.TemporaryDirectory() as d:
            path = write(d, "tx.csv", "txn_id,created_at,customer,usd\nt1,2026-10-01,c1,5\nt2,bad,c2,6\n")
            code, out, _ = self.run_cli(["import", "events", str(path), "--type", "transaction", "--ts", "created_at", "--id", "txn_id", "--entity", "user=customer", "--api-key", "ksk_x"], server)
            rejects = (Path(d) / "tx.csv.rejects.jsonl").read_text()
        self.assertEqual(code, 0)
        self.assertIn("2 rows read: 1 stored, 1 rejected", out)
        self.assertIn("tx.csv.rejects.jsonl", out)
        self.assertIn('"line": 3', rejects)
        self.assertEqual(server.sent()[0]["entities"], {"user": "c1"})

    def test_a_second_run_stores_nothing_and_still_succeeds(self) -> None:
        server = Server()
        with tempfile.TemporaryDirectory() as d:
            path = write(d, "tx.csv", "txn_id,created_at,user_id\nt1,2026-10-01,u1\nt2,bad,u2\n")
            argv = ["import", "events", str(path), "--type", "login", "--ts", "created_at", "--id", "txn_id", "--api-key", "k"]
            self.run_cli(argv, server)
            code, out, _ = self.run_cli(argv, server)
        self.assertEqual(code, 0)
        self.assertIn("0 stored, 1 were there already, 1 rejected", out)

    def test_a_dry_run_needs_no_key(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            path = write(d, "tx.jsonl", '{"created_at": "2026-10-01", "user_id": "u1"}\n')
            with mock.patch.dict("os.environ", {}, clear=True):
                code, out, _ = self.run_cli(["import", "events", str(path), "--type", "login", "--ts", "created_at", "--dry-run"])
        self.assertEqual(code, 0)
        self.assertIn("Dry run: 1 rows read, 1 would be sent", out)
        self.assertIn("'type': 'login'", out)

    def test_refuses_to_send_without_a_key_and_explains_a_stop(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            path = write(d, "tx.csv", "created_at,user_id\n2026-10-01,u1\n")
            with mock.patch.dict("os.environ", {}, clear=True):
                code, _, err = self.run_cli(["import", "events", str(path), "--type", "login", "--ts", "created_at"])
            self.assertEqual(code, 2)
            self.assertIn("KAIROS_API_KEY", err)
            code, _, err = self.run_cli(["import", "events", str(path), "--type", "login", "--ts", "created_at", "--api-key", "k"], Server(down=True))
            self.assertEqual(code, 1)
            self.assertIn("run the same command again", err)
            code, _, err = self.run_cli(["import", "events", str(Path(d) / "missing.csv"), "--type", "login", "--ts", "t", "--api-key", "k"])
            self.assertEqual(code, 2)
            self.assertIn("No file", err)

    def test_imports_entities_and_labels(self) -> None:
        server = Server()
        with tempfile.TemporaryDirectory() as d:
            customers = write(d, "c.csv", "customer_id,country\nc1,GB\n")
            chargebacks = write(d, "cb.csv", "customer_id,reported_at\nc1,2026-10-05\n")
            self.assertEqual(self.run_cli(["import", "entities", str(customers), "--type", "user", "--id", "customer_id", "--api-key", "k"], server)[0], 0)
            self.assertEqual(self.run_cli(["import", "labels", str(chargebacks), "--entity", "user=customer_id", "--label", "chargeback", "--ts", "reported_at", "--api-key", "k"], server)[0], 0)
        self.assertEqual(server.sent("/v1/objects"), [{"type": "user", "id": "c1", "properties": {"country": "GB"}}])
        self.assertEqual(server.sent("/v1/labels")[0]["ts"], "2026-10-05T00:00:00.000Z")


if __name__ == "__main__":
    unittest.main()
