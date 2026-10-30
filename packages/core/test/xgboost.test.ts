import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkParity, featureRow, loadXgboost, PARITY_SAMPLES, XGBOOST_LIMITS, type XgboostModel } from "../src";

/** Made by test/fixtures/xgboost/make_fixtures.py with each version of XGBoost. */
const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/xgboost/${name}.json`, import.meta.url), "utf8")) as {
    xgboost: string;
    model: Record<string, unknown>;
    samples?: { features: Record<string, number | null>; score: number }[];
  };

const load = (file: unknown): XgboostModel => {
  const loaded = loadXgboost(file);
  if (!loaded.model) throw new Error(loaded.problems.join("; "));
  return loaded.model;
};
const problemsOf = (file: unknown) => loadXgboost(file).problems.join("; ");

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const THRESHOLD = Math.fround(0.1);

/** One split on `a` at 0.1: a leaf of +1 on the left, -1 on the right. */
function stump(tree: Record<string, unknown> = {}, learner: Record<string, unknown> = {}) {
  return {
    learner: {
      feature_names: ["a", "b"],
      feature_types: [],
      objective: { name: "binary:logistic" },
      learner_model_param: { base_score: "5E-1", num_class: "0", num_target: "1" },
      attributes: {},
      gradient_booster: {
        name: "gbtree",
        model: {
          gbtree_model_param: { num_parallel_tree: "1" },
          trees: [
            {
              left_children: [1, -1, -1],
              right_children: [2, -1, -1],
              split_indices: [0, 0, 0],
              split_conditions: [THRESHOLD, 1, -1],
              default_left: [1, 0, 0],
              split_type: [0, 0, 0],
              ...tree,
            },
          ],
        },
      },
      ...learner,
    },
  };
}

describe("XGBoost parity", () => {
  for (const version of ["1.7.6", "2.1.4", "3.0.2"]) {
    it(`scores as XGBoost ${version} does`, () => {
      const { model: file, samples } = fixture(`binary-${version}`);
      const model = load(file);
      expect(model.features).toEqual(["hardship", "income_plausible", "grayson_hold", "amount", "dti", "country_gb"]);
      expect(model.depth).toBe(4);

      // The samples hold missing values, values on a threshold, and values that are below a
      // threshold in float64 but equal to it in float32.
      const result = checkParity(model, samples!.slice(0, PARITY_SAMPLES.max));
      expect(result.problems).toEqual([]);
      expect(result.mismatches).toEqual([]);
      expect(result.max_difference).toBeLessThan(2e-7);
    });
  }
});

describe("scoring", () => {
  const model = load(stump());

  it("goes left below the threshold and right at it", () => {
    expect(model.score([0.05, 0])).toBeCloseTo(sigmoid(1), 6);
    expect(model.score([THRESHOLD, 0])).toBeCloseTo(sigmoid(-1), 6);
  });

  it("compares in float32, as XGBoost does", () => {
    // Below the threshold as a float64, equal to it as a float32: XGBoost goes right.
    const below = THRESHOLD - 1e-12;
    expect(below < THRESHOLD && Math.fround(below) === THRESHOLD).toBe(true);
    expect(model.score([below, 0])).toBeCloseTo(sigmoid(-1), 6);
  });

  it("sends a missing value down the default branch", () => {
    expect(model.score([NaN, 0])).toBeCloseTo(sigmoid(1), 6);
    const right = load(stump({ default_left: [0, 0, 0] }));
    expect(right.score([NaN, 0])).toBeCloseTo(sigmoid(-1), 6);
  });

  it("starts from base_score, in either form", () => {
    const base = (value: string) =>
      load(stump({}, { learner_model_param: { base_score: value, num_class: "0", num_target: "1" } }));
    const logit = Math.log(0.8 / 0.2);
    expect(base("8E-1").score([0.05, 0])).toBeCloseTo(sigmoid(logit + 1), 6);
    expect(base("[8E-1]").score([0.05, 0])).toBeCloseTo(sigmoid(logit + 1), 6);
  });

  it("refuses a row of the wrong length", () => {
    expect(() => model.score([0.05])).toThrow("the model has 2 features; the row has 1 values");
  });

  it("makes a row from named values, with null and absent values missing", () => {
    expect([...featureRow(["a", "b", "c"], { a: 1, b: null })]).toEqual([1, NaN, NaN]);
  });
});

describe("what it refuses", () => {
  it.each([
    ["refuse-gblinear", 'the booster is "gblinear"; only gbtree is accepted'],
    ["refuse-dart", 'the booster is "dart"; only gbtree is accepted'],
    ["refuse-regression", 'the objective is "reg:squarederror"; only binary:logistic is accepted'],
    ["refuse-multiclass", "the model has more than one output; only one is accepted"],
    ["refuse-categorical", 'a feature has the type "c"; only numeric features are accepted'],
    ["refuse-unnamed", "the model has no feature names"],
  ])("%s", (name, problem) => {
    expect(problemsOf(fixture(name).model)).toContain(problem);
  });

  it("a file that is not a model", () => {
    expect(problemsOf({})).toBe("the file is not an XGBoost JSON model: it has no learner");
    expect(problemsOf(null)).toBe("the file is not an XGBoost JSON model: it has no learner");
  });

  it("a model with more trees than its best iteration", () => {
    const { model } = fixture("binary-3.0.2");
    const learner = model.learner as Record<string, unknown>;
    expect(problemsOf({ ...model, learner: { ...learner, attributes: { best_iteration: "9" } } })).toBe(
      "the model has 33 trees and its best iteration uses 10: cut it with booster[: booster.best_iteration + 1] before you save it",
    );
  });

  it("bad feature names", () => {
    expect(problemsOf(stump({}, { feature_names: ["a", "a"] }))).toContain("two features have the same name");
    expect(problemsOf(stump({}, { feature_names: ["a", "b c"] }))).toContain("each feature name must match");
  });

  it("a base_score that is not a probability", () => {
    const file = stump({}, { learner_model_param: { base_score: "1.5", num_class: "0", num_target: "1" } });
    expect(problemsOf(file)).toBe("base_score must be a probability between 0 and 1");
  });

  it("too many trees", () => {
    const file = stump();
    const model = file.learner.gradient_booster.model;
    model.trees = Array.from({ length: XGBOOST_LIMITS.trees + 1 }, () => model.trees[0]!);
    expect(problemsOf(file)).toBe(`the model has ${XGBOOST_LIMITS.trees + 1} trees; at most ${XGBOOST_LIMITS.trees}`);
  });
});

describe("the structure of a tree", () => {
  it.each([
    [
      "a child before its parent",
      { left_children: [1, 0, -1], right_children: [2, 2, -1] },
      "node 1 has a child that is out of range",
    ],
    ["a child that points to itself", { left_children: [0, -1, -1] }, "out of range"],
    ["a child past the last node", { right_children: [3, -1, -1] }, "out of range"],
    ["one child", { left_children: [1, -1, -1], right_children: [-1, -1, -1] }, "node 0 has one child"],
    ["an unknown feature", { split_indices: [2, 0, 0] }, "node 0 splits on an unknown feature"],
    ["lists of different lengths", { default_left: [1, 0] }, "its node lists have different lengths"],
    ["a value that is not a number", { split_conditions: [THRESHOLD, null, -1] }, "must be lists of numbers"],
    ["a value that is not finite", { split_conditions: [THRESHOLD, 1e309, -1] }, "not a finite number"],
    ["a bad default_left", { default_left: [2, 0, 0] }, "default_left that is not 0 or 1"],
    ["a categorical split", { split_type: [1, 0, 0] }, "has a categorical split"],
  ])("refuses %s", (_, tree, problem) => {
    expect(problemsOf(stump(tree))).toContain(`tree 0: `);
    expect(problemsOf(stump(tree))).toContain(problem);
  });

  it(`refuses a tree deeper than ${XGBOOST_LIMITS.depth}`, () => {
    // A chain: node i splits into a leaf (i + 1) and the next split (i + 2).
    const splits = XGBOOST_LIMITS.depth + 1;
    const nodes = 2 * splits + 1;
    const left = Array.from({ length: nodes }, (_, i) => (i % 2 === 0 && i < nodes - 1 ? i + 1 : -1));
    const right = Array.from({ length: nodes }, (_, i) => (i % 2 === 0 && i < nodes - 1 ? i + 2 : -1));
    const tree = {
      left_children: left,
      right_children: right,
      split_indices: Array(nodes).fill(0),
      split_conditions: Array(nodes).fill(0.5),
      default_left: Array(nodes).fill(0),
      split_type: Array(nodes).fill(0),
    };
    expect(problemsOf(stump(tree))).toBe(`tree 0: is ${splits} deep; at most ${XGBOOST_LIMITS.depth}`);
  });
});

describe("the parity check", () => {
  const { model: file, samples } = fixture("binary-3.0.2");
  const model = load(file);
  const some = samples!.slice(0, 120);

  it("needs 100 to 1,000 samples", () => {
    expect(checkParity(model, some.slice(0, 99)).problems).toEqual(["samples must be a list of 100 to 1000 rows"]);
    expect(checkParity(model, "rows").problems).toEqual(["samples must be a list of 100 to 1000 rows"]);
  });

  it("reports the samples whose scores differ", () => {
    const changed = some.map((s, n) => (n === 3 ? { ...s, score: s.score + 0.01 } : s));
    const result = checkParity(model, changed);
    expect(result.problems).toEqual([]);
    expect(result.mismatches).toEqual([{ sample: 3, expected: some[3]!.score + 0.01, actual: some[3]!.score }]);
    expect(result.max_difference).toBeCloseTo(0.01, 6);
  });

  it("reports samples with the wrong features", () => {
    const { dti: _dti, ...withoutDti } = some[1]!.features;
    const bad = [
      { features: { ...some[0]!.features, extra: 1 }, score: some[0]!.score },
      { features: withoutDti, score: some[1]!.score },
      { features: { ...some[2]!.features, dti: "31" }, score: some[2]!.score },
      { features: some[3]!.features, score: 2 },
      { score: 0.5 },
      ...some.slice(5),
    ];
    expect(checkParity(model, bad).problems).toEqual([
      "samples[0]: features the model does not have: extra",
      "samples[1]: no value or null for dti",
      "samples[2]: not a number or null: dti",
      "samples[3]: score must be between 0 and 1",
      "samples[4]: needs features and a score",
    ]);
  });
});
