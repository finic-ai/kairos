import { FEATURE_NAME, loadXgboost, XGBOOST_LIMITS } from "./xgboost";

export interface GbdtParams {
  max_depth?: number;
  eta?: number;
  rounds?: number;
  /** Minimum hessian sum in a child. */
  min_child_weight?: number;
  lambda?: number;
  gamma?: number;
  subsample?: number;
  colsample?: number;
  bins?: number;
  early_stopping_rounds?: number;
  seed?: number;
}

export interface GbdtTrainResult {
  /** XGBoost JSON that loadXgboost accepts, cut to the best iteration. */
  model: Record<string, unknown>;
  trees: number;
  /** 0-based. */
  best_iteration: number;
  eval_logloss: number[];
  /** Scores of the returned model, equal to what loadXgboost's scorer gives. */
  train_scores: Float64Array;
  eval_scores: Float64Array;
}

export interface GbdtData {
  rows: ArrayLike<number>[];
  labels: ArrayLike<number>;
}

export const GBDT_DEFAULTS: Required<GbdtParams> = {
  max_depth: 4,
  eta: 0.1,
  rounds: 300,
  min_child_weight: 1,
  lambda: 1,
  gamma: 0,
  subsample: 1,
  colsample: 1,
  bins: 64,
  early_stopping_rounds: 30,
  seed: 7,
};

type Range = { min: number; max: number; whole?: boolean; openMin?: boolean; text: string };
const RANGES: Record<keyof GbdtParams, Range> = {
  max_depth: { min: 1, max: 10, whole: true, text: "a whole number from 1 to 10" },
  eta: { min: 0, max: 1, openMin: true, text: "more than 0 and at most 1" },
  rounds: { min: 1, max: 2000, whole: true, text: "a whole number from 1 to 2000" },
  min_child_weight: { min: 0, max: Infinity, text: "0 or more" },
  lambda: { min: 0, max: Infinity, text: "0 or more" },
  gamma: { min: 0, max: Infinity, text: "0 or more" },
  subsample: { min: 0, max: 1, openMin: true, text: "more than 0 and at most 1" },
  colsample: { min: 0, max: 1, openMin: true, text: "more than 0 and at most 1" },
  bins: { min: 8, max: 256, whole: true, text: "a whole number from 8 to 256" },
  early_stopping_rounds: { min: 1, max: 2000, whole: true, text: "a whole number from 1 to 2000" },
  seed: { min: 0, max: 2 ** 32 - 1, whole: true, text: "a whole number from 0 to 4294967295" },
};

function resolveParams(params: GbdtParams): Required<GbdtParams> {
  const out = { ...GBDT_DEFAULTS };
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    const range = RANGES[key as keyof GbdtParams];
    if (!range) throw new Error(`${key} is not a training parameter`);
    const ok =
      typeof value === "number" &&
      Number.isFinite(value) &&
      (!range.whole || Number.isInteger(value)) &&
      (range.openMin ? value > range.min : value >= range.min) &&
      value <= range.max;
    if (!ok) throw new Error(`${key} must be ${range.text}; it is ${JSON.stringify(value)}`);
    out[key as keyof GbdtParams] = value;
  }
  return out;
}

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

const f32 = Math.fround;
// XGBoost's kRtEps: a split must reduce the loss by more than this.
const MIN_GAIN = 1e-6;

// XGBoost writes floats as the shortest float32 text, e.g. "5E-1".
function xgboostFloat(x: number): string {
  const v = f32(x);
  for (let digits = 1; digits <= 9; digits++) {
    const text = v.toExponential(digits - 1);
    if (f32(Number(text)) === v) return text.toUpperCase().replace("E+", "E");
  }
  return String(v);
}

function checkData(name: string, data: GbdtData, featureCount: number): void {
  if (!data || !Array.isArray(data.rows) || data.rows.length === 0) throw new Error(`the ${name} set has no rows`);
  if (!data.labels || data.labels.length !== data.rows.length)
    throw new Error(`the ${name} set has ${data.rows.length} rows and ${data.labels?.length ?? 0} labels`);
  for (let r = 0; r < data.rows.length; r++) {
    const row = data.rows[r]!;
    if (row.length !== featureCount)
      throw new Error(`${name} row ${r} has ${row.length} values; there are ${featureCount} features`);
    for (let f = 0; f < featureCount; f++) {
      const v = row[f]!;
      if (typeof v !== "number" || (v === v && !Number.isFinite(f32(v))))
        throw new Error(
          `${name} row ${r} has a value for feature ${f} that is not a number, NaN or within float32 range`,
        );
    }
    const y = data.labels[r];
    if (y !== 0 && y !== 1) throw new Error(`${name} label ${r} is ${y}; labels must be 0 or 1`);
  }
}

/** Candidate thresholds per feature: a value goes left when f32(value) < threshold. */
function thresholds(rows: ArrayLike<number>[], f: number, bins: number): Float32Array {
  const values = new Float32Array(rows.length);
  let n = 0;
  for (const row of rows) {
    const v = row[f]!;
    if (v === v) values[n++] = v;
  }
  if (n === 0) return new Float32Array(0);
  const sorted = values.subarray(0, n).sort();
  const distinct: number[] = [sorted[0]!];
  for (let i = 1; i < n && distinct.length <= bins; i++) if (sorted[i]! !== sorted[i - 1]!) distinct.push(sorted[i]!);
  if (distinct.length <= bins) return Float32Array.from(distinct);
  // The minimum is kept as a threshold so that a split can separate missing from present values.
  const cuts = [sorted[0]!];
  for (let q = 1; q < bins; q++) {
    const v = sorted[Math.floor((q * n) / bins)]!;
    if (v > cuts[cuts.length - 1]!) cuts.push(v);
  }
  return Float32Array.from(cuts);
}

/** The bin of a value is the number of thresholds at or below it, so left at threshold j is bin <= j. */
function binRows(rows: ArrayLike<number>[], cuts: Float32Array[], missing: number): Uint16Array {
  const F = cuts.length;
  const out = new Uint16Array(rows.length * F);
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]!;
    for (let f = 0; f < F; f++) {
      const v = row[f]!;
      if (v !== v) {
        out[r * F + f] = missing;
        continue;
      }
      const x = f32(v);
      const t = cuts[f]!;
      let lo = 0;
      let hi = t.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (t[mid]! <= x) lo = mid + 1;
        else hi = mid;
      }
      out[r * F + f] = lo;
    }
  }
  return out;
}

interface Tree {
  left: number[];
  right: number[];
  feature: number[];
  bin: number[];
  value: number[];
  defaultLeft: number[];
  parent: number[];
  weight: number[];
  hessian: number[];
  gain: number[];
}

function scoreRows(tree: Tree, bins: Uint16Array, F: number, missing: number, margins: Float32Array): void {
  const { left, right, feature, bin, value, defaultLeft } = tree;
  for (let r = 0; r < margins.length; r++) {
    let i = 0;
    while (left[i]! !== -1) {
      const b = bins[r * F + feature[i]!]!;
      i = b === missing ? (defaultLeft[i] ? left[i]! : right[i]!) : b <= bin[i]! ? left[i]! : right[i]!;
    }
    margins[r] = f32(margins[r]! + value[i]!);
  }
}

const probability = (margin: number) => f32(1 / f32(1 + f32(Math.exp(-margin))));

export function trainGbdt(
  features: string[],
  train: GbdtData,
  evalSet: GbdtData,
  params: GbdtParams = {},
): GbdtTrainResult {
  const p = resolveParams(params);
  if (!Array.isArray(features) || features.length === 0) throw new Error("there are no features");
  if (features.length > XGBOOST_LIMITS.features)
    throw new Error(`there are ${features.length} features; at most ${XGBOOST_LIMITS.features}`);
  const bad = features.find((name) => typeof name !== "string" || !FEATURE_NAME.test(name));
  if (bad !== undefined) throw new Error(`the feature name ${JSON.stringify(bad)} must match ${FEATURE_NAME.source}`);
  if (new Set(features).size !== features.length) throw new Error("two features have the same name");
  const F = features.length;
  checkData("train", train, F);
  checkData("eval", evalSet, F);

  const n = train.rows.length;
  const m = evalSet.rows.length;
  const cuts = Array.from({ length: F }, (_, f) => thresholds(train.rows, f, p.bins));
  const stride = Math.max(...cuts.map((c) => c.length)) + 2;
  const MISSING = stride - 1;
  const trainBins = binRows(train.rows, cuts, MISSING);
  const evalBins = binRows(evalSet.rows, cuts, MISSING);
  const y = Float64Array.from(train.labels);
  const yEval = Float64Array.from(evalSet.labels);

  let positives = 0;
  for (let r = 0; r < n; r++) positives += y[r]!;
  const baseText = xgboostFloat(Math.min(Math.max(positives / n, 1e-6), 1 - 1e-6));
  const baseP = f32(Number(baseText));
  // The same float32 steps as loadXgboost, so that both start from the same margin.
  const baseMargin = f32(-f32(Math.log(f32(f32(1 / baseP) - 1))));

  const margins = new Float32Array(n).fill(baseMargin);
  const evalMargins = new Float32Array(m).fill(baseMargin);
  const grad = new Float64Array(n);
  const hess = new Float64Array(n);
  const rows = new Int32Array(n);
  const random = mulberry32(p.seed);
  const { lambda, gamma, min_child_weight: minChild, eta } = p;
  const histSize = F * stride * 2;

  const trees: Tree[] = [];
  const evalLogloss: number[] = [];
  let best = -1;
  let bestLoss = Infinity;
  let bestTrain = new Float64Array(n);
  let bestEval = new Float64Array(m);

  for (let round = 0; round < p.rounds; round++) {
    for (let r = 0; r < n; r++) {
      const q = probability(margins[r]!);
      grad[r] = q - y[r]!;
      hess[r] = Math.max(q * (1 - q), 1e-16);
    }

    let sampled = 0;
    if (p.subsample < 1) for (let r = 0; r < n; r++) if (random() < p.subsample) rows[sampled++] = r;
    if (sampled === 0) {
      for (let r = 0; r < n; r++) rows[r] = r;
      sampled = n;
    }
    let cols: Int32Array;
    if (p.colsample < 1) {
      const all = Int32Array.from({ length: F }, (_, f) => f);
      const k = Math.max(1, Math.round(p.colsample * F));
      for (let i = 0; i < k; i++) {
        const j = i + Math.floor(random() * (F - i));
        [all[i], all[j]] = [all[j]!, all[i]!];
      }
      cols = all.slice(0, k).sort();
    } else cols = Int32Array.from({ length: F }, (_, f) => f);

    const buildHist = (start: number, end: number): Float64Array => {
      const hist = new Float64Array(histSize);
      for (let i = start; i < end; i++) {
        const r = rows[i]!;
        const g = grad[r]!;
        const h = hess[r]!;
        const base = r * F;
        for (let c = 0; c < cols.length; c++) {
          const f = cols[c]!;
          const o = (f * stride + trainBins[base + f]!) * 2;
          hist[o]! += g;
          hist[o + 1]! += h;
        }
      }
      return hist;
    };

    const tree: Tree = {
      left: [],
      right: [],
      feature: [],
      bin: [],
      value: [],
      defaultLeft: [],
      parent: [],
      weight: [],
      hessian: [],
      gain: [],
    };
    const addNode = (parent: number, G: number, H: number): number => {
      const id = tree.left.length;
      const w = f32((-G / (H + lambda)) * eta);
      tree.left.push(-1);
      tree.right.push(-1);
      tree.feature.push(0);
      tree.bin.push(0);
      tree.value.push(w);
      tree.defaultLeft.push(0);
      tree.parent.push(parent);
      tree.weight.push(w);
      tree.hessian.push(H);
      tree.gain.push(0);
      return id;
    };

    type Pending = { id: number; start: number; end: number; G: number; H: number; hist: Float64Array };
    let G0 = 0;
    let H0 = 0;
    for (let i = 0; i < sampled; i++) {
      G0 += grad[rows[i]!]!;
      H0 += hess[rows[i]!]!;
    }
    let level: Pending[] = [
      { id: addNode(2147483647, G0, H0), start: 0, end: sampled, G: G0, H: H0, hist: buildHist(0, sampled) },
    ];

    for (let depth = 0; depth < p.max_depth && level.length; depth++) {
      const next: Pending[] = [];
      for (const node of level) {
        const { G, H, hist } = node;
        const parentScore = (G * G) / (H + lambda);
        let bestGain = MIN_GAIN;
        let bestFeature = -1;
        let bestBin = 0;
        let bestDefaultLeft = 0;
        let GLbest = 0;
        let HLbest = 0;
        for (let c = 0; c < cols.length; c++) {
          const f = cols[c]!;
          const k = cuts[f]!.length;
          if (k === 0) continue;
          const o = f * stride;
          const GM = hist[(o + MISSING) * 2]!;
          const HM = hist[(o + MISSING) * 2 + 1]!;
          let GL = 0;
          let HL = 0;
          for (let j = 0; j < k; j++) {
            GL += hist[(o + j) * 2]!;
            HL += hist[(o + j) * 2 + 1]!;
            for (let side = 0; side < 2; side++) {
              const gl = side ? GL + GM : GL;
              const hl = side ? HL + HM : HL;
              const gr = G - gl;
              const hr = H - hl;
              if (hl < minChild || hr < minChild || hl <= 0 || hr <= 0) continue;
              const gain = 0.5 * ((gl * gl) / (hl + lambda) + (gr * gr) / (hr + lambda) - parentScore) - gamma;
              if (gain > bestGain) {
                bestGain = gain;
                bestFeature = f;
                bestBin = j;
                bestDefaultLeft = side;
                GLbest = gl;
                HLbest = hl;
              }
            }
          }
        }
        if (bestFeature < 0) continue;

        let lo = node.start;
        let hi = node.end;
        while (lo < hi) {
          const b = trainBins[rows[lo]! * F + bestFeature]!;
          if (b === MISSING ? bestDefaultLeft === 1 : b <= bestBin) lo++;
          else {
            hi--;
            const t = rows[lo]!;
            rows[lo] = rows[hi]!;
            rows[hi] = t;
          }
        }
        const id = node.id;
        tree.feature[id] = bestFeature;
        tree.bin[id] = bestBin;
        tree.value[id] = cuts[bestFeature]![bestBin]!;
        tree.defaultLeft[id] = bestDefaultLeft;
        tree.gain[id] = bestGain;
        const l = addNode(id, GLbest, HLbest);
        const r = addNode(id, G - GLbest, H - HLbest);
        tree.left[id] = l;
        tree.right[id] = r;

        if (depth + 1 < p.max_depth) {
          const leftSmaller = lo - node.start <= node.end - lo;
          const small = leftSmaller ? buildHist(node.start, lo) : buildHist(lo, node.end);
          for (let c = 0; c < cols.length; c++) {
            const o = cols[c]! * stride * 2;
            for (let b = o; b < o + stride * 2; b++) hist[b]! -= small[b]!;
          }
          next.push(
            { id: l, start: node.start, end: lo, G: GLbest, H: HLbest, hist: leftSmaller ? small : hist },
            { id: r, start: lo, end: node.end, G: G - GLbest, H: H - HLbest, hist: leftSmaller ? hist : small },
          );
        }
      }
      level = next;
    }

    trees.push(tree);
    scoreRows(tree, trainBins, F, MISSING, margins);
    scoreRows(tree, evalBins, F, MISSING, evalMargins);

    let loss = 0;
    const evalScores = new Float64Array(m);
    for (let r = 0; r < m; r++) {
      const q = probability(evalMargins[r]!);
      evalScores[r] = q;
      const c = Math.min(Math.max(q, 1e-15), 1 - 1e-15);
      loss -= yEval[r]! ? Math.log(c) : Math.log(1 - c);
    }
    loss /= m;
    evalLogloss.push(loss);
    if (loss < bestLoss) {
      bestLoss = loss;
      best = round;
      bestEval = evalScores;
      bestTrain = Float64Array.from(margins, probability);
    }
    if (round - best >= p.early_stopping_rounds) break;
  }

  const kept = trees.slice(0, best + 1);
  const numFeature = String(F);
  const model = {
    learner: {
      attributes: { best_iteration: String(best), best_score: String(bestLoss) },
      feature_names: [...features],
      feature_types: features.map(() => "float"),
      gradient_booster: {
        model: {
          gbtree_model_param: { num_parallel_tree: "1", num_trees: String(kept.length) },
          iteration_indptr: Array.from({ length: kept.length + 1 }, (_, i) => i),
          tree_info: kept.map(() => 0),
          trees: kept.map((t, id) => ({
            base_weights: t.weight,
            categories: [],
            categories_nodes: [],
            categories_segments: [],
            categories_sizes: [],
            default_left: t.defaultLeft,
            id,
            left_children: t.left,
            loss_changes: t.gain,
            parents: t.parent,
            right_children: t.right,
            split_conditions: t.value,
            split_indices: t.feature,
            split_type: t.left.map(() => 0),
            sum_hessian: t.hessian,
            tree_param: {
              num_deleted: "0",
              num_feature: numFeature,
              num_nodes: String(t.left.length),
              size_leaf_vector: "1",
            },
          })),
        },
        name: "gbtree",
      },
      learner_model_param: {
        base_score: baseText,
        boost_from_average: "1",
        num_class: "0",
        num_feature: numFeature,
        num_target: "1",
      },
      objective: { name: "binary:logistic", reg_loss_param: { scale_pos_weight: "1" } },
    },
    version: [2, 1, 0],
  };
  const loaded = loadXgboost(model);
  if (!loaded.model) throw new Error(`the trained model does not load: ${loaded.problems.join("; ")}`);

  return {
    model,
    trees: kept.length,
    best_iteration: best,
    eval_logloss: evalLogloss,
    train_scores: bestTrain,
    eval_scores: bestEval,
  };
}
