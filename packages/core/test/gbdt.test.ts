import { describe, expect, it } from "vitest";
import { checkParity, loadXgboost, PARITY_SAMPLES, trainGbdt, type GbdtData, type XgboostModel } from "../src";

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

function auc(scores: ArrayLike<number>, labels: ArrayLike<number>): number {
  const order = Array.from(scores, (s, i) => [s, labels[i]!] as const).sort((a, b) => a[0] - b[0]);
  let rankSum = 0;
  let positives = 0;
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j < order.length && order[j]![0] === order[i]![0]) j++;
    for (let k = i; k < j; k++)
      if (order[k]![1]) {
        rankSum += (i + j + 1) / 2;
        positives++;
      }
    i = j;
  }
  const negatives = order.length - positives;
  return (rankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
}

const FEATURES = ["x0", "x1", "x2", "x3", "x4", "noise"];

/** Nonlinear in x0..x3; x4 is missing for a fifth of rows, which have a higher base rate. */
function synthetic(n: number, seed: number): GbdtData {
  const random = mulberry32(seed);
  const rows: number[][] = [];
  const labels: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = Array.from({ length: 6 }, () => random() * 4 - 2);
    const missing = random() < 0.2;
    const logit =
      2 * Math.sin(x[0]! * 1.5) + 1.5 * x[1]! * x[2]! + (x[3]! > 0.5 ? 1 : -1) + (missing ? 1.5 : 0.5 * x[4]!);
    if (missing) x[4] = NaN;
    rows.push(x);
    labels.push(random() < sigmoid(logit) ? 1 : 0);
  }
  return { rows, labels };
}

const load = (file: unknown): XgboostModel => {
  const loaded = loadXgboost(file);
  if (!loaded.model) throw new Error(loaded.problems.join("; "));
  return loaded.model;
};

describe("trainGbdt", () => {
  const train = synthetic(6000, 1);
  const evalSet = synthetic(2000, 2);
  const result = trainGbdt(FEATURES, train, evalSet, { rounds: 200 });
  const model = load(result.model);

  it("learns a nonlinear signal", () => {
    const score = auc(result.eval_scores, evalSet.labels);
    console.log(`eval AUC ${score.toFixed(4)}, ${result.trees} trees`);
    expect(score).toBeGreaterThan(0.8);
    const constant = auc(new Float64Array(evalSet.rows.length).fill(0.5), evalSet.labels);
    expect(constant).toBe(0.5);
    const best = result.eval_logloss[result.best_iteration]!;
    expect(best).toBeLessThan(result.eval_logloss[0]!);
    expect(Math.min(...result.eval_logloss)).toBe(best);
  });

  it("scores in loadXgboost as it did in training", () => {
    expect(model.trees).toBe(result.trees);
    expect(model.features).toEqual(FEATURES);
    let worst = 0;
    for (const [data, scores] of [
      [train, result.train_scores],
      [evalSet, result.eval_scores],
    ] as const)
      data.rows.forEach((row, i) => (worst = Math.max(worst, Math.abs(model.score(row) - scores[i]!))));
    expect(worst).toBeLessThan(1e-6);

    const samples = evalSet.rows.slice(0, PARITY_SAMPLES.min).map((row, i) => ({
      features: Object.fromEntries(FEATURES.map((name, f) => [name, Number.isNaN(row[f]) ? null : row[f]!])),
      score: result.eval_scores[i]!,
    }));
    const parity = checkParity(model, samples);
    expect(parity.problems).toEqual([]);
    expect(parity.mismatches).toEqual([]);
  });

  it("writes what XGBoost writes", () => {
    const learner = result.model.learner as Record<string, any>;
    expect(learner.objective.name).toBe("binary:logistic");
    expect(learner.gradient_booster.name).toBe("gbtree");
    expect(learner.feature_types).toEqual(FEATURES.map(() => "float"));
    expect(learner.learner_model_param.base_score).toMatch(/^\d(\.\d+)?E-?\d+$/);
    expect(learner.attributes.best_iteration).toBe(String(result.best_iteration));
    expect(learner.gradient_booster.model.trees).toHaveLength(result.best_iteration + 1);
  });

  it("stops early when the eval loss rises", () => {
    const small = synthetic(400, 3);
    const held = synthetic(400, 4);
    const r = trainGbdt(FEATURES, small, held, { rounds: 500, max_depth: 8, eta: 0.5, early_stopping_rounds: 10 });
    expect(r.eval_logloss.length).toBeLessThan(500);
    expect(r.eval_logloss.length).toBe(r.best_iteration + 1 + 10);
    expect(r.trees).toBe(r.best_iteration + 1);
    expect(load(r.model).trees).toBe(r.trees);
  });

  it("learns the direction for missing values", () => {
    for (const missingRate of [0.9, 0.05]) {
      const make = (n: number, seed: number): GbdtData => {
        const random = mulberry32(seed);
        const rows: number[][] = [];
        const labels: number[] = [];
        for (let i = 0; i < n; i++) {
          const a = random() * 2 - 1;
          const missing = random() < 0.3;
          rows.push([missing ? NaN : a, random()]);
          labels.push(random() < (missing ? missingRate : a > 0 ? 0.7 : 0.3) ? 1 : 0);
        }
        return { rows, labels };
      };
      const r = trainGbdt(["a", "b"], make(5000, 5), make(2000, 6), { max_depth: 2 });
      const m = load(r.model);
      const missingScore = (m.score([NaN, 0.2]) + m.score([NaN, 0.8])) / 2;
      expect(Math.abs(missingScore - missingRate)).toBeLessThan(0.06);
      expect(m.score([0.5, 0.5])).toBeCloseTo(0.7, 1);
      expect(m.score([-0.5, 0.5])).toBeCloseTo(0.3, 1);
    }
  });

  it("gives the same model for the same seed", () => {
    const params = { rounds: 30, subsample: 0.7, colsample: 0.5, seed: 11 };
    const a = trainGbdt(FEATURES, train, evalSet, params);
    const b = trainGbdt(FEATURES, train, evalSet, params);
    expect(JSON.stringify(a.model)).toBe(JSON.stringify(b.model));
    const c = trainGbdt(FEATURES, train, evalSet, { ...params, seed: 12 });
    expect(JSON.stringify(c.model)).not.toBe(JSON.stringify(a.model));
  });

  it.each([
    [{ max_depth: 0 }, "max_depth must be a whole number from 1 to 10"],
    [{ max_depth: 2.5 }, "max_depth must be a whole number from 1 to 10"],
    [{ eta: 0 }, "eta must be more than 0 and at most 1"],
    [{ rounds: 2001 }, "rounds must be a whole number from 1 to 2000"],
    [{ lambda: -1 }, "lambda must be 0 or more"],
    [{ subsample: 1.5 }, "subsample must be more than 0 and at most 1"],
    [{ bins: 4 }, "bins must be a whole number from 8 to 256"],
    [{ min_child_weight: NaN }, "min_child_weight must be 0 or more"],
    [{ depth: 3 } as never, "depth is not a training parameter"],
  ])("refuses %j", (params, message) => {
    expect(() => trainGbdt(FEATURES, train, evalSet, params)).toThrow(message);
  });

  it("refuses bad data", () => {
    expect(() => trainGbdt(["bad name"], train, evalSet)).toThrow('the feature name "bad name" must match');
    expect(() => trainGbdt(["a"], { rows: [[1]], labels: [2] }, { rows: [[1]], labels: [1] })).toThrow(
      "train label 0 is 2; labels must be 0 or 1",
    );
    expect(() => trainGbdt(["a", "b"], { rows: [[1]], labels: [1] }, { rows: [[1]], labels: [1] })).toThrow(
      "train row 0 has 1 values; there are 2 features",
    );
    expect(() => trainGbdt(["a"], { rows: [[1]], labels: [1] }, { rows: [], labels: [] })).toThrow(
      "the eval set has no rows",
    );
  });

  it("trains 20k rows by 10 features for 100 rounds quickly", () => {
    const random = mulberry32(9);
    const make = (n: number): GbdtData => {
      const rows = Array.from({ length: n }, () => Float64Array.from({ length: 10 }, () => random()));
      const labels = rows.map((x) => (random() < sigmoid(4 * (x[0]! - 0.5) + 3 * x[1]! * x[2]! - 1) ? 1 : 0));
      return { rows, labels };
    };
    const big = make(20_000);
    const held = make(5_000);
    const started = performance.now();
    const r = trainGbdt(
      Array.from({ length: 10 }, (_, i) => `f${i}`),
      big,
      held,
      { rounds: 100, early_stopping_rounds: 100 },
    );
    const seconds = (performance.now() - started) / 1000;
    console.log(`20k x 10, ${r.eval_logloss.length} rounds: ${seconds.toFixed(2)} s`);
    expect(r.eval_logloss).toHaveLength(100);
    expect(seconds).toBeLessThan(10);
  });
});
