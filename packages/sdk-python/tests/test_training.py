"""Tests for ``python -m kairos train``. The training itself needs XGBoost and is skipped without it:

    python3 -m unittest discover -s packages/sdk-python/tests
    uv run --no-project --with xgboost python -m unittest discover -s packages/sdk-python/tests
"""

from __future__ import annotations

import gzip
import json
import math
import random
import sys
import unittest
from collections.abc import Mapping
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from kairos import KairosError
from kairos.training import TrainingConfig, average_precision, fetch_rows, roc_auc, run, split_by_time

try:
    import xgboost  # noqa: F401

    HAS_XGBOOST = True
except ImportError:
    HAS_XGBOOST = False

FEATURES = {"hardship": "{{ steps.ask.output.hardship.probability }}", "amount": "{{ trigger.properties.amount }}", "flag": 1}
CONFIG = {"model": "loan-default", "name": "Loan default", "workflow": "loan_review", "labels": ["charged_off"], "window": "180d", "features": FEATURES}


def export(rows: int, seed: int = 1) -> str:
    rng = random.Random(seed)
    lines = ["run_id,ts,subject_type,subject_id,label,hardship,amount,flag"]
    for n in range(rows):
        hardship = rng.random()
        amount = "" if rng.random() < 0.1 else f"{rng.uniform(1000, 30000):.2f}"
        label = 1 if rng.random() < 0.15 + 0.5 * hardship else 0
        lines.append(f"wfr_{n:05d},2026-{1 + n * 9 // rows:02d}-01T00:00:00.000Z,user,u{n},{label},{hardship},{amount},1")
    return "\n".join(lines) + "\n"


class Server:
    def __init__(self, csv: str) -> None:
        self.csv = csv
        self.calls: list[dict[str, Any]] = []

    def __call__(self, method: str, url: str, headers: dict[str, str], body: bytes, timeout: float) -> tuple[int, bytes, Mapping[str, str]]:
        decoded = gzip.decompress(body) if headers.get("Content-Encoding") == "gzip" else body
        self.calls.append({"method": method, "url": url, "headers": headers, "body": json.loads(decoded)})
        if url.endswith("/training-data"):
            return 200, self.csv.encode(), {"X-Kairos-Rows": "3", "X-Kairos-Already-Labeled": "2", "X-Kairos-Outcome-Unknown": "1"}
        return 201, json.dumps({"version": 1, "created": True}).encode(), {}


class ConfigTest(unittest.TestCase):
    def test_reads_a_config(self) -> None:
        config = TrainingConfig.from_dict({**CONFIG, "split": {"train": 0.6, "valid": 0.2}, "compare_without": ["hardship"]})
        self.assertEqual((config.train, config.valid, config.compare_without), (0.6, 0.2, ["hardship"]))

    def test_refuses_a_config_it_cannot_use(self) -> None:
        cases = [
            ({**CONFIG, "model": "Loan_Default"}, "lowercase letters and digits"),
            ({**CONFIG, "features": {"bad name": 1}}, "letters, digits and _"),
            ({**CONFIG, "compare_without": ["age"]}, "not features of the model: age"),
            ({**CONFIG, "split": {"train": 0.9, "valid": 0.1}}, "some must be left to test"),
            ({**CONFIG, "params": {"objective": "multi:softprob"}}, "binary:logistic"),
            ({**CONFIG, "extra": 1}, "does not know: extra"),
            ({k: v for k, v in CONFIG.items() if k != "window"}, 'needs "window"'),
        ]
        for data, message in cases:
            with self.subTest(message), self.assertRaises(KairosError) as caught:
                TrainingConfig.from_dict(data)
            self.assertIn(message, str(caught.exception))


class ExportTest(unittest.TestCase):
    def test_reads_the_rows_and_the_counts(self) -> None:
        server = Server("run_id,ts,subject_type,subject_id,label,hardship,amount\nwfr_1,2026-01-01T00:00:00.000Z,user,u1,1,0.8,\nwfr_2,2026-02-01T00:00:00.000Z,user,\"u,2\",0,0.1,500\n")
        config = TrainingConfig.from_dict({**CONFIG, "features": {"hardship": "x", "amount": "y"}, "from": "2026-01-01T00:00:00Z"})
        rows = fetch_rows("http://k.test/", "ksk_1", config, server)
        self.assertEqual(server.calls[0]["url"], "http://k.test/v1/workflows/loan_review/training-data")
        self.assertEqual(server.calls[0]["body"]["from"], "2026-01-01T00:00:00Z")
        self.assertEqual(rows.features, ["hardship", "amount"])
        self.assertEqual(rows.labels, [1, 0])
        self.assertTrue(math.isnan(rows.values[0][1]))
        self.assertEqual(rows.values[1], [0.1, 500.0])
        self.assertEqual(rows.counts["already-labeled"], 2)

    def test_says_what_the_server_refused(self) -> None:
        def refuse(*_: Any) -> tuple[int, bytes, Mapping[str, str]]:
            return 404, json.dumps({"error": {"type": "not_found", "message": 'No workflow "loan_review"'}}).encode(), {}

        with self.assertRaises(KairosError) as caught:
            fetch_rows("http://k.test", "ksk_1", TrainingConfig.from_dict(CONFIG), refuse)
        self.assertIn('No workflow "loan_review"', str(caught.exception))


class MetricsTest(unittest.TestCase):
    def test_roc_auc(self) -> None:
        self.assertEqual(roc_auc([0, 0, 1, 1], [0.1, 0.4, 0.35, 0.8]), 0.75)
        self.assertEqual(roc_auc([0, 1], [0.5, 0.5]), 0.5)
        self.assertTrue(math.isnan(roc_auc([1, 1], [0.1, 0.2])))

    def test_average_precision(self) -> None:
        self.assertAlmostEqual(average_precision([1, 0, 1], [0.9, 0.8, 0.1]), (1 + 2 / 3) / 2)

    def test_splits_by_time_with_the_newest_rows_to_test(self) -> None:
        rows = fetch_rows("http://k.test", "k", TrainingConfig.from_dict(CONFIG), Server(export(100)))
        train, valid, test = split_by_time(rows, 0.7, 0.15)
        self.assertEqual((len(train), len(valid), len(test)), (70, 15, 15))
        self.assertLessEqual(max(rows.times[i] for i in train), min(rows.times[i] for i in test))


@unittest.skipUnless(HAS_XGBOOST, "needs XGBoost")
class TrainTest(unittest.TestCase):
    def test_trains_compares_and_uploads(self) -> None:
        server = Server(export(3000))
        config = TrainingConfig.from_dict({**CONFIG, "compare_without": ["hardship"], "rounds": 200, "samples": 150})
        logged: list[str] = []
        answer = run(config, "http://k.test", "ksk_1", transport=server, log=logged.append)
        self.assertEqual(answer, {"version": 1, "created": True})

        sent = server.calls[1]
        self.assertEqual(sent["url"], "http://k.test/v1/models/loan-default/versions")
        body = sent["body"]
        self.assertEqual(body["name"], "Loan default")
        self.assertEqual(body["model"]["learner"]["feature_names"], ["hardship", "amount", "flag"])
        self.assertEqual(len(body["samples"]), 150)
        self.assertIsNone(next(s for s in body["samples"] if s["features"]["amount"] is None)["features"]["amount"])
        self.assertGreater(body["metrics"]["test"]["roc_auc"], 0.6)
        self.assertGreater(body["metrics"]["comparison"]["gain"], 0)
        self.assertEqual(body["suggested_features"]["flag"], "1")
        self.assertEqual(body["training"]["split"], {"train": 2100, "valid": 450, "test": 450})
        self.assertTrue(any(line.startswith("Uploaded loan-default@1") for line in logged))

    def test_needs_both_labels_in_each_part(self) -> None:
        server = Server(export(200).replace(",1,", ",0,"))
        with self.assertRaises(KairosError) as caught:
            run(TrainingConfig.from_dict(CONFIG), "http://k.test", "k", transport=server, log=lambda _: None)
        self.assertIn("need both labels", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
