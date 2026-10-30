"""
Make the XGBoost fixtures for packages/core/test/xgboost.test.ts.

Run it once for each XGBoost version, in a temporary environment:

    uv run --no-project --python 3.11 --with xgboost==1.7.6 --with "numpy<2" make_fixtures.py
    uv run --no-project --python 3.12 --with xgboost==2.1.4 make_fixtures.py
    uv run --no-project --python 3.12 --with xgboost==3.0.2 --with pandas make_fixtures.py --refusals

Each run writes binary-<version>.json: a model and sample rows with the scores that XGBoost
gives them. With --refusals it also writes the models that Kairos must refuse.
"""

import json
import sys
from pathlib import Path

import numpy as np
import xgboost as xgb

HERE = Path(__file__).parent
FEATURES = ["hardship", "income_plausible", "grayson_hold", "amount", "dti", "country_gb"]
VERSION = xgb.__version__


def data(rows: int, seed: int) -> tuple[np.ndarray, np.ndarray]:
    rng = np.random.default_rng(seed)
    x = np.column_stack(
        [
            rng.random(rows),
            rng.random(rows),
            rng.beta(2, 5, rows),
            rng.lognormal(9, 1, rows),
            rng.normal(25, 10, rows),
            (rng.random(rows) < 0.3).astype(float),
        ]
    )
    margin = 2.5 * x[:, 0] - 1.5 * x[:, 1] + 3 * x[:, 2] + 0.0001 * x[:, 3] + 0.03 * x[:, 4] - 0.5 * x[:, 5] - 3
    y = (rng.random(rows) < 1 / (1 + np.exp(-margin))).astype(int)
    # Missing values, so the trees learn a default direction.
    x[rng.random(x.shape) < 0.1] = np.nan
    return x, y


def thresholds(model: dict) -> list[tuple[int, float]]:
    """Each split of the model: the feature and the threshold, as float32 values."""
    out = []
    for tree in model["learner"]["gradient_booster"]["model"]["trees"]:
        for i, left in enumerate(tree["left_children"]):
            if left != -1:
                out.append((tree["split_indices"][i], float(np.float32(tree["split_conditions"][i]))))
    return out


def edge_rows(model: dict, base: np.ndarray, count: int, seed: int) -> np.ndarray:
    """
    Rows with one value on a threshold. Half are exactly on it. The other half are a float64
    that is below the threshold but rounds to it in float32: XGBoost sends these right, and an
    evaluator that compares in float64 sends them left.
    """
    rng = np.random.default_rng(seed)
    splits = thresholds(model)
    rows = []
    for n in range(count):
        feature, threshold = splits[rng.integers(len(splits))]
        row = base[rng.integers(len(base))].copy()
        if n % 2 == 0:
            row[feature] = threshold
        else:
            below = float(np.nextafter(np.float32(threshold), np.float32(-np.inf)))
            row[feature] = threshold - (threshold - below) * 0.25
            assert row[feature] < threshold and np.float32(row[feature]) == np.float32(threshold)
        rows.append(row)
    return np.array(rows)


def samples(booster: xgb.Booster, x: np.ndarray, names: list[str]) -> list[dict]:
    scores = booster.predict(xgb.DMatrix(x, missing=np.nan, feature_names=names))
    return [
        {
            "features": {name: (None if np.isnan(v) else float(v)) for name, v in zip(names, row)},
            "score": float(score),
        }
        for row, score in zip(x, scores)
    ]


def save(name: str, booster: xgb.Booster, rows: list[dict] | None = None) -> None:
    path = HERE / f"{name}.json"
    booster.save_model(str(HERE / "tmp.json"))
    model = json.loads((HERE / "tmp.json").read_text())
    (HERE / "tmp.json").unlink()
    body = {"xgboost": VERSION, "model": model}
    if rows is not None:
        body["samples"] = rows
    path.write_text(json.dumps(body, separators=(",", ":")))
    print(f"wrote {path.name}: {len(rows or [])} samples")


def binary() -> None:
    x, y = data(4000, 1)
    train = xgb.DMatrix(x[:3000], label=y[:3000], missing=np.nan, feature_names=FEATURES)
    valid = xgb.DMatrix(x[3000:], label=y[3000:], missing=np.nan, feature_names=FEATURES)
    params = {"objective": "binary:logistic", "max_depth": 4, "eta": 0.1, "eval_metric": "auc", "seed": 7}
    booster = xgb.train(params, train, 300, evals=[(valid, "valid")], early_stopping_rounds=20, verbose_eval=False)
    # Kairos uses every tree in the file, so the file is cut to the best iteration first.
    booster = booster[: booster.best_iteration + 1]
    booster.save_model(str(HERE / "tmp.json"))
    model = json.loads((HERE / "tmp.json").read_text())
    (HERE / "tmp.json").unlink()

    test, _ = data(400, 2)
    test[0, :] = np.nan
    rows = np.vstack([test, edge_rows(model, test, 200, 3)])
    save(f"binary-{VERSION}", booster, samples(booster, rows, FEATURES))


def refusals() -> None:
    x, y = data(1000, 4)
    names = FEATURES
    plain = xgb.DMatrix(x, label=y, missing=np.nan, feature_names=names)

    save("refuse-gblinear", xgb.train({"objective": "binary:logistic", "booster": "gblinear"}, plain, 5))
    save("refuse-dart", xgb.train({"objective": "binary:logistic", "booster": "dart", "max_depth": 2}, plain, 5))
    save("refuse-regression", xgb.train({"objective": "reg:squarederror", "max_depth": 2}, plain, 5))

    classes = np.random.default_rng(5).integers(0, 3, len(y))
    multi = xgb.DMatrix(x, label=classes, missing=np.nan, feature_names=names)
    save("refuse-multiclass", xgb.train({"objective": "multi:softprob", "num_class": 3, "max_depth": 2}, multi, 5))

    import pandas as pd

    frame = pd.DataFrame(x, columns=names)
    frame["country"] = pd.Categorical(np.random.default_rng(6).choice(["GB", "FR", "US"], len(y)))
    categorical = xgb.DMatrix(frame, label=y, enable_categorical=True)
    save(
        "refuse-categorical",
        xgb.train({"objective": "binary:logistic", "max_depth": 3, "tree_method": "hist"}, categorical, 5),
    )

    unnamed = xgb.DMatrix(x, label=y, missing=np.nan)
    save("refuse-unnamed", xgb.train({"objective": "binary:logistic", "max_depth": 2}, unnamed, 5))


if __name__ == "__main__":
    binary()
    if "--refusals" in sys.argv:
        refusals()
