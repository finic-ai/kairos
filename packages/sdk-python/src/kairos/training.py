"""Train an XGBoost scoring model on a Kairos workflow's runs, and upload it as a version of a model.

    python -m kairos train model.json [--out DIR] [--no-upload]

Needs ``pip install "finic-kairos[train]"``.
"""

from __future__ import annotations

import csv
import gzip
import io
import json
import math
import random
import re
import tempfile
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote

from .client import _http
from .errors import KairosApiError, KairosError
from .types import Transport

_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
_SLUG = re.compile(r"^(?=.{1,64}$)[a-z0-9]+(-[a-z0-9]+)*$")
_COUNTS = ("rows", "positives", "already-labeled", "outcome-unknown", "no-subject")
DEFAULT_PARAMS: dict[str, Any] = {"objective": "binary:logistic", "eval_metric": "auc", "max_depth": 4, "eta": 0.05, "seed": 7}
MIN_SAMPLES = 100


@dataclass
class TrainingConfig:
    model: str
    workflow: str
    labels: list[str]
    window: str
    features: dict[str, Any]
    name: str | None = None
    description: str | None = None
    subject: dict[str, str] | None = None
    start: str | None = None
    end: str | None = None
    train: float = 0.7
    valid: float = 0.15
    params: dict[str, Any] = field(default_factory=dict)
    rounds: int = 2000
    early_stopping_rounds: int = 50
    compare_without: list[str] = field(default_factory=list)
    samples: int = 1000

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> TrainingConfig:
        known = {"model", "workflow", "labels", "window", "features", "name", "description", "subject", "from", "to", "split", "params", "rounds", "early_stopping_rounds", "compare_without", "samples"}
        unknown = sorted(set(data) - known)
        if unknown:
            raise KairosError(f"The config has keys that train does not know: {', '.join(unknown)}")
        for key in ("model", "workflow", "labels", "window", "features"):
            if key not in data:
                raise KairosError(f'The config needs "{key}"')
        split = data.get("split", {})
        config = cls(
            model=str(data["model"]), workflow=str(data["workflow"]), labels=list(data["labels"]), window=str(data["window"]),
            features=dict(data["features"]), name=data.get("name"), description=data.get("description"), subject=data.get("subject"),
            start=data.get("from"), end=data.get("to"), train=float(split.get("train", cls.train)), valid=float(split.get("valid", cls.valid)),
            params=dict(data.get("params", {})), rounds=int(data.get("rounds", cls.rounds)), early_stopping_rounds=int(data.get("early_stopping_rounds", cls.early_stopping_rounds)),
            compare_without=list(data.get("compare_without", [])), samples=int(data.get("samples", cls.samples)),
        )
        config.check()
        return config

    def check(self) -> None:
        if not _SLUG.match(self.model):
            raise KairosError(f'model: "{self.model}" must be lowercase letters and digits, in groups joined by one "-"')
        bad = [name for name in self.features if not _NAME.match(name)]
        if bad:
            raise KairosError(f"features: a name must be letters, digits and _: {', '.join(bad)}")
        missing = [name for name in self.compare_without if name not in self.features]
        if missing:
            raise KairosError(f"compare_without: not features of the model: {', '.join(missing)}")
        if not (0 < self.train < 1 and 0 < self.valid < 1 and self.train + self.valid < 1):
            raise KairosError("split: train and valid are shares of the rows, and some must be left to test")
        objective = self.params.get("objective", "binary:logistic")
        if objective != "binary:logistic":
            raise KairosError(f'params.objective: Kairos scores binary:logistic models, not "{objective}"')
        if not MIN_SAMPLES <= self.samples <= 1000:
            raise KairosError(f"samples: {MIN_SAMPLES} to 1000")


@dataclass
class Rows:
    features: list[str]
    run_ids: list[str]
    times: list[str]
    labels: list[int]
    values: list[list[float]]
    counts: dict[str, int]

    def __len__(self) -> int:
        return len(self.labels)


def _url(base: str, path: str) -> str:
    return base.rstrip("/") + path


def _fail(status: int, body: bytes) -> KairosApiError:
    try:
        return KairosApiError(status, str(json.loads(body)["error"]["message"]))
    except (ValueError, KeyError, TypeError):
        return KairosApiError(status, body.decode("utf-8", "replace")[:500])


def fetch_rows(url: str, api_key: str, config: TrainingConfig, transport: Transport = _http, timeout: float = 600) -> Rows:
    body: dict[str, Any] = {"features": config.features, "labels": config.labels, "window": config.window}
    if config.subject:
        body["subject"] = config.subject
    if config.start:
        body["from"] = config.start
    if config.end:
        body["to"] = config.end
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    status, answer, response_headers = transport("POST", _url(url, f"/v1/workflows/{quote(config.workflow)}/training-data"), headers, json.dumps(body).encode(), timeout)
    if status != 200:
        raise _fail(status, answer)
    lower = {k.lower(): v for k, v in response_headers.items()}
    counts = {name: int(lower.get(f"x-kairos-{name}", 0)) for name in _COUNTS}
    reader = csv.reader(io.StringIO(answer.decode("utf-8")))
    header = next(reader)
    names = header[5:]
    rows = Rows(names, [], [], [], [], counts)
    for line in reader:
        rows.run_ids.append(line[0])
        rows.times.append(line[1])
        rows.labels.append(int(line[4]))
        rows.values.append([float(v) if v != "" else math.nan for v in line[5:]])
    return rows


def split_by_time(rows: Rows, train: float, valid: float) -> tuple[list[int], list[int], list[int]]:
    """The oldest rows train and the newest test, as the model will meet new rows: a random split looks better than it is."""
    order = sorted(range(len(rows)), key=lambda i: (rows.times[i], rows.run_ids[i]))
    a = int(len(order) * train)
    b = int(len(order) * (train + valid))
    return order[:a], order[a:b], order[b:]


def roc_auc(labels: Sequence[int], scores: Sequence[float]) -> float:
    positives = sum(labels)
    negatives = len(labels) - positives
    if positives == 0 or negatives == 0:
        return math.nan
    order = sorted(range(len(scores)), key=lambda i: scores[i])
    ranks = [0.0] * len(scores)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and scores[order[j + 1]] == scores[order[i]]:
            j += 1
        for k in range(i, j + 1):
            ranks[order[k]] = (i + j) / 2 + 1
        i = j + 1
    rank_sum = sum(r for r, y in zip(ranks, labels) if y == 1)
    return (rank_sum - positives * (positives + 1) / 2) / (positives * negatives)


def average_precision(labels: Sequence[int], scores: Sequence[float]) -> float:
    positives = sum(labels)
    if positives == 0:
        return math.nan
    hits = 0
    total = 0.0
    for n, i in enumerate(sorted(range(len(scores)), key=lambda i: -scores[i]), start=1):
        if labels[i] == 1:
            hits += 1
            total += hits / n
    return total / positives


def bootstrap_gain(labels: Sequence[int], with_: Sequence[float], without: Sequence[float], rounds: int = 1000, seed: int = 7) -> tuple[float, float]:
    rng = random.Random(seed)
    n = len(labels)
    gains = []
    for _ in range(rounds):
        pick = [rng.randrange(n) for _ in range(n)]
        y = [labels[i] for i in pick]
        a = roc_auc(y, [with_[i] for i in pick])
        b = roc_auc(y, [without[i] for i in pick])
        if not (math.isnan(a) or math.isnan(b)):
            gains.append(a - b)
    gains.sort()
    if not gains:
        return math.nan, math.nan
    return gains[int(0.025 * (len(gains) - 1))], gains[int(0.975 * (len(gains) - 1))]


@dataclass
class TrainResult:
    model: dict[str, Any]
    samples: list[dict[str, Any]]
    metrics: dict[str, Any]
    training: dict[str, Any]


def _xgboost() -> Any:
    try:
        import xgboost  # type: ignore[import-not-found]
    except ImportError:
        raise KairosError('train needs XGBoost: pip install "finic-kairos[train]"') from None
    return xgboost


def train(config: TrainingConfig, rows: Rows) -> TrainResult:
    xgb = _xgboost()
    tr, va, te = split_by_time(rows, config.train, config.valid)
    for part, idx in (("train", tr), ("valid", va), ("test", te)):
        classes = {rows.labels[i] for i in idx}
        if classes != {0, 1}:
            raise KairosError(f"The {part} rows need both labels, 0 and 1: there are {len(rows)} rows and {sum(rows.labels)} positives. Export a longer period.")

    def fit(names: list[str]) -> tuple[Any, list[float]]:
        cols = [rows.features.index(n) for n in names]

        def matrix(idx: list[int]) -> Any:
            return xgb.DMatrix([[rows.values[i][c] for c in cols] for i in idx], label=[rows.labels[i] for i in idx], missing=math.nan, feature_names=names)

        params = {**DEFAULT_PARAMS, **config.params}
        valid = matrix(va)
        booster = xgb.train(params, matrix(tr), config.rounds, evals=[(valid, "valid")], early_stopping_rounds=config.early_stopping_rounds, verbose_eval=False)
        # Kairos scores with every tree in the file.
        booster = booster[: booster.best_iteration + 1]
        return booster, [float(p) for p in booster.predict(matrix(te))]

    booster, scores = fit(rows.features)
    test_labels = [rows.labels[i] for i in te]
    metrics: dict[str, Any] = {
        "test": {"rows": len(te), "positives": sum(test_labels), "roc_auc": roc_auc(test_labels, scores), "pr_auc": average_precision(test_labels, scores)}
    }
    if config.compare_without:
        kept = [n for n in rows.features if n not in config.compare_without]
        _, base = fit(kept)
        low, high = bootstrap_gain(test_labels, scores, base)
        base_auc = roc_auc(test_labels, base)
        metrics["comparison"] = {"without": config.compare_without, "roc_auc_without": base_auc, "gain": metrics["test"]["roc_auc"] - base_auc, "gain_95": [low, high]}

    picked = (te + va + tr)[: config.samples]
    predicted = booster.predict(xgb.DMatrix([rows.values[i] for i in picked], missing=math.nan, feature_names=rows.features))
    samples = [
        {"features": {n: (None if math.isnan(v) else v) for n, v in zip(rows.features, rows.values[i])}, "score": float(p)}
        for i, p in zip(picked, predicted)
    ]
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / "model.json"
        booster.save_model(str(path))
        model = json.loads(path.read_text())
    times = sorted(rows.times)
    training = {
        "rows": len(rows), "positives": sum(rows.labels), "from": times[0], "to": times[-1], "labels": config.labels, "window": config.window,
        "split": {"train": len(tr), "valid": len(va), "test": len(te)}, "trees": booster.num_boosted_rounds(), "params": {**DEFAULT_PARAMS, **config.params},
        "xgboost": xgb.__version__, "export": rows.counts,
    }
    return TrainResult(model, samples, metrics, training)


def upload_body(config: TrainingConfig, result: TrainResult) -> dict[str, Any]:
    body: dict[str, Any] = {
        "format": "xgboost-json",
        "model": result.model,
        "samples": result.samples,
        "metrics": result.metrics,
        "training": result.training,
        "suggested_features": {n: v if isinstance(v, str) else json.dumps(v) for n, v in config.features.items()},
    }
    if config.name:
        body["name"] = config.name
    if config.description:
        body["description"] = config.description
    return body


def upload(url: str, api_key: str, config: TrainingConfig, body: Mapping[str, Any], transport: Transport = _http, timeout: float = 120) -> dict[str, Any]:
    payload = gzip.compress(json.dumps(body, separators=(",", ":"), allow_nan=False).encode())
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json", "Content-Encoding": "gzip"}
    status, answer, _ = transport("POST", _url(url, f"/v1/models/{config.model}/versions"), headers, payload, timeout)
    if status not in (200, 201):
        raise _fail(status, answer)
    result: dict[str, Any] = json.loads(answer)
    return result


def _clean(value: Any) -> Any:
    """JSON has no NaN: a metric that could not be calculated is null."""
    if isinstance(value, float) and math.isnan(value):
        return None
    if isinstance(value, dict):
        return {k: _clean(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_clean(v) for v in value]
    return value


def run(config: TrainingConfig, url: str, api_key: str, *, out: Path | None = None, send: bool = True, transport: Transport = _http, log: Callable[[str], None] = print) -> dict[str, Any] | None:
    rows = fetch_rows(url, api_key, config, transport)
    c = rows.counts
    log(f"{len(rows):,} rows, {sum(rows.labels):,} positive. Left out: {c['already-labeled']:,} already labeled, {c['outcome-unknown']:,} with no outcome yet, {c['no-subject']:,} with no subject.")
    result = train(config, rows)
    test = result.metrics["test"]
    log(f"Test: {test['rows']:,} rows, ROC-AUC {test['roc_auc']:.4f}, PR-AUC {test['pr_auc']:.4f}, {result.training['trees']} trees.")
    if "comparison" in result.metrics:
        cmp = result.metrics["comparison"]
        log(f"Without {', '.join(cmp['without'])}: ROC-AUC {cmp['roc_auc_without']:.4f}. Gain {cmp['gain']:+.4f}, 95% [{cmp['gain_95'][0]:+.4f}, {cmp['gain_95'][1]:+.4f}].")
    body = _clean(upload_body(config, result))
    if out:
        out.mkdir(parents=True, exist_ok=True)
        (out / "model.json").write_text(json.dumps(result.model))
        (out / "upload.json").write_text(json.dumps(body))
        log(f"Wrote {out / 'model.json'} and {out / 'upload.json'}.")
    if not send:
        return None
    answer = upload(url, api_key, config, body, transport)
    made = "a new version" if answer.get("created") else "the same as the latest version, so no new version"
    log(f"Uploaded {config.model}@{answer['version']}: {made}.")
    return answer
