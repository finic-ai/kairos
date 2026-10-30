export const XGBOOST_LIMITS = { trees: 5000, depth: 32, features: 500 } as const;

const NUMERIC_TYPES = new Set(["float", "int", "i", "q"]);
export const FEATURE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export interface XgboostModel {
  features: readonly string[];
  trees: number;
  nodes: number;
  depth: number;
  /** NaN is a missing value. */
  score(values: ArrayLike<number>): number;
}

export type XgboostLoad = { model: XgboostModel; problems: [] } | { model?: undefined; problems: string[] };

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const numbers = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every((v) => typeof v === "number");

// Most XGBoost versions write "5E-1"; some write "[5E-1]".
function baseScore(value: unknown): number {
  const text = typeof value === "string" ? value.trim().replace(/^\[(.*)\]$/, "$1") : value;
  return typeof text === "string" && text !== "" ? Number(text) : typeof text === "number" ? text : NaN;
}

function addTree(
  tree: Json,
  at: string,
  featureCount: number,
  offset: number,
  out: { feature: Int32Array; value: Float32Array; left: Int32Array; right: Int32Array; defaultLeft: Uint8Array },
): number | string {
  const { left_children: left, right_children: right, split_indices: split, split_conditions: value } = tree;
  const defaultLeft = tree.default_left;
  if (!numbers(left) || !numbers(right) || !numbers(split) || !numbers(value) || !numbers(defaultLeft))
    return `${at}: left_children, right_children, split_indices, split_conditions and default_left must be lists of numbers`;
  const n = left.length;
  if (n === 0) return `${at}: has no nodes`;
  if (right.length !== n || split.length !== n || value.length !== n || defaultLeft.length !== n)
    return `${at}: its node lists have different lengths`;
  if (Array.isArray(tree.split_type) && tree.split_type.some((t) => t !== 0))
    return `${at}: has a categorical split; only numeric features are accepted`;

  const depth = new Int32Array(n);
  let deepest = 0;
  for (let i = 0; i < n; i++) {
    const l = left[i]!;
    const r = right[i]!;
    if (!Number.isFinite(value[i]!)) return `${at}: node ${i} has a value that is not a finite number`;
    if (l === -1 || r === -1) {
      if (l !== r) return `${at}: node ${i} has one child`;
    } else {
      // The file is untrusted: a child that comes after its parent makes a cycle impossible.
      if (!Number.isInteger(l) || !Number.isInteger(r) || l <= i || r <= i || l >= n || r >= n)
        return `${at}: node ${i} has a child that is out of range`;
      const f = split[i]!;
      if (!Number.isInteger(f) || f < 0 || f >= featureCount) return `${at}: node ${i} splits on an unknown feature`;
      if (defaultLeft[i] !== 0 && defaultLeft[i] !== 1) return `${at}: node ${i} has a default_left that is not 0 or 1`;
      depth[l] = depth[r] = depth[i]! + 1;
      deepest = Math.max(deepest, depth[i]! + 1);
    }
    out.feature[offset + i] = split[i]!;
    out.value[offset + i] = value[i]!;
    out.left[offset + i] = l === -1 ? -1 : offset + l;
    out.right[offset + i] = r === -1 ? -1 : offset + r;
    out.defaultLeft[offset + i] = defaultLeft[i]!;
  }
  if (deepest > XGBOOST_LIMITS.depth) return `${at}: is ${deepest} deep; at most ${XGBOOST_LIMITS.depth}`;
  return deepest;
}

export function loadXgboost(file: unknown): XgboostLoad {
  const fail = (...problems: string[]): XgboostLoad => ({ problems });
  const learner = isObject(file) ? file.learner : undefined;
  if (!isObject(learner)) return fail("the file is not an XGBoost JSON model: it has no learner");

  const problems: string[] = [];
  const booster = isObject(learner.gradient_booster) ? learner.gradient_booster : {};
  if (booster.name !== "gbtree")
    problems.push(`the booster is ${JSON.stringify(booster.name ?? null)}; only gbtree is accepted`);
  const objective = isObject(learner.objective) ? learner.objective.name : undefined;
  if (objective !== "binary:logistic")
    problems.push(`the objective is ${JSON.stringify(objective ?? null)}; only binary:logistic is accepted`);
  const params = isObject(learner.learner_model_param) ? learner.learner_model_param : {};
  if (Number(params.num_class ?? 0) > 1 || Number(params.num_target ?? 1) !== 1)
    problems.push("the model has more than one output; only one is accepted");

  const names = learner.feature_names;
  if (!Array.isArray(names) || names.length === 0)
    problems.push("the model has no feature names: train it on a DMatrix or a DataFrame with named columns");
  else {
    if (names.some((n) => typeof n !== "string" || !FEATURE_NAME.test(n)))
      problems.push("each feature name must match ^[A-Za-z_][A-Za-z0-9_]{0,63}$");
    if (new Set(names).size !== names.length) problems.push("two features have the same name");
    if (names.length > XGBOOST_LIMITS.features)
      problems.push(`the model has ${names.length} features; at most ${XGBOOST_LIMITS.features}`);
  }
  const types = learner.feature_types;
  if (Array.isArray(types) && types.length > 0) {
    const other = types.find((t) => !NUMERIC_TYPES.has(t as string));
    if (other !== undefined)
      problems.push(`a feature has the type ${JSON.stringify(other)}; only numeric features are accepted`);
  }

  const base = baseScore(params.base_score);
  if (!(base > 0 && base < 1)) problems.push("base_score must be a probability between 0 and 1");
  if (problems.length) return fail(...problems);

  const model = isObject(booster.model) ? booster.model : {};
  const trees = model.trees;
  if (!Array.isArray(trees) || trees.length === 0) return fail("the model has no trees");
  if (trees.length > XGBOOST_LIMITS.trees)
    return fail(`the model has ${trees.length} trees; at most ${XGBOOST_LIMITS.trees}`);
  const attributes = isObject(learner.attributes) ? learner.attributes : {};
  const parallel = Number((isObject(model.gbtree_model_param) && model.gbtree_model_param.num_parallel_tree) || 1);
  const best =
    attributes.best_iteration !== undefined
      ? (Number(attributes.best_iteration) + 1) * parallel
      : attributes.best_ntree_limit !== undefined
        ? Number(attributes.best_ntree_limit)
        : undefined;
  if (best !== undefined && trees.length > best)
    return fail(
      `the model has ${trees.length} trees and its best iteration uses ${best}: cut it with booster[: booster.best_iteration + 1] before you save it`,
    );

  const featureCount = (names as string[]).length;
  const sizes: number[] = [];
  for (const [t, tree] of trees.entries()) {
    if (!isObject(tree) || !Array.isArray(tree.left_children)) return fail(`tree ${t}: is not a tree`);
    sizes.push(tree.left_children.length);
  }
  const size = sizes.reduce((a, b) => a + b, 0);
  const flat = {
    feature: new Int32Array(size),
    value: new Float32Array(size),
    left: new Int32Array(size),
    right: new Int32Array(size),
    defaultLeft: new Uint8Array(size),
  };
  const roots = new Int32Array(trees.length);
  let offset = 0;
  let depth = 0;
  for (const [t, tree] of trees.entries()) {
    const added = addTree(tree as Json, `tree ${t}`, featureCount, offset, flat);
    if (typeof added === "string") return fail(added);
    roots[t] = offset;
    offset += sizes[t]!;
    depth = Math.max(depth, added);
  }

  // Each step is float32, as in XGBoost. In float64, about one score in six differs in its last bit.
  const f32 = Math.fround;
  const p = f32(base);
  const baseMargin = f32(-f32(Math.log(f32(f32(1 / p) - 1))));
  const { feature, value, left, right, defaultLeft } = flat;
  return {
    problems: [],
    model: {
      features: Object.freeze([...(names as string[])]),
      trees: trees.length,
      nodes: size,
      depth,
      score(values) {
        if (values.length !== featureCount)
          throw new RangeError(`the model has ${featureCount} features; the row has ${values.length} values`);
        let margin = baseMargin;
        for (let t = 0; t < roots.length; t++) {
          let i = roots[t]!;
          while (left[i]! !== -1) {
            const x = values[feature[i]!]!;
            i = x !== x ? (defaultLeft[i] ? left[i]! : right[i]!) : f32(x) < value[i]! ? left[i]! : right[i]!;
          }
          margin = f32(margin + value[i]!);
        }
        // C's expf and Math.exp can round differently: a score can still differ by about 1e-7.
        return f32(1 / f32(1 + f32(Math.exp(-margin))));
      },
    },
  };
}

export function featureRow(
  features: readonly string[],
  values: Record<string, number | null | undefined>,
): Float64Array {
  return Float64Array.from(features, (name) => values[name] ?? NaN);
}

export interface ParitySample {
  features: Record<string, number | null>;
  score: number;
}

export const PARITY_SAMPLES = { min: 100, max: 1000, tolerance: 1e-6 } as const;

export interface ParityResult {
  samples: number;
  max_difference: number;
  mismatches: { sample: number; expected: number; actual: number }[];
  problems: string[];
}

export function checkParity(
  model: Pick<XgboostModel, "features" | "score">,
  samples: unknown,
  tolerance: number = PARITY_SAMPLES.tolerance,
): ParityResult {
  const result: ParityResult = { samples: 0, max_difference: 0, mismatches: [], problems: [] };
  if (!Array.isArray(samples) || samples.length < PARITY_SAMPLES.min || samples.length > PARITY_SAMPLES.max) {
    result.problems.push(`samples must be a list of ${PARITY_SAMPLES.min} to ${PARITY_SAMPLES.max} rows`);
    return result;
  }
  const expected = new Set(model.features);
  for (const [n, sample] of samples.entries()) {
    const at = `samples[${n}]`;
    if (!isObject(sample) || !isObject(sample.features) || typeof sample.score !== "number") {
      result.problems.push(`${at}: needs features and a score`);
    } else if (!(sample.score >= 0 && sample.score <= 1)) {
      result.problems.push(`${at}: score must be between 0 and 1`);
    } else {
      const features = sample.features;
      const given = Object.keys(features);
      const extra = given.filter((name) => !expected.has(name));
      const absent = model.features.filter((name) => !(name in features));
      const wrong = given.filter((name) => {
        const v = features[name];
        return v !== null && (typeof v !== "number" || !Number.isFinite(v));
      });
      if (extra.length) result.problems.push(`${at}: features the model does not have: ${extra.join(", ")}`);
      if (absent.length) result.problems.push(`${at}: no value or null for ${absent.join(", ")}`);
      if (wrong.length) result.problems.push(`${at}: not a number or null: ${wrong.join(", ")}`);
      if (!extra.length && !absent.length && !wrong.length) {
        const actual = model.score(featureRow(model.features, features as ParitySample["features"]));
        const difference = Math.abs(actual - sample.score);
        result.max_difference = Math.max(result.max_difference, difference);
        if (difference > tolerance && result.mismatches.length < 5)
          result.mismatches.push({ sample: n, expected: sample.score, actual });
      }
    }
    if (result.problems.length >= 5) break;
  }
  result.samples = samples.length;
  return result;
}
