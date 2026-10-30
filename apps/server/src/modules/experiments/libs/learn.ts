import { logit } from "@kairos/core";

export function rocAuc(labels: ArrayLike<number>, scores: ArrayLike<number>): number | null {
  const n = labels.length;
  let positives = 0;
  for (let i = 0; i < n; i++) positives += labels[i]!;
  const negatives = n - positives;
  if (positives === 0 || negatives === 0) return null;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => scores[a]! - scores[b]!);
  let rankSum = 0;
  for (let i = 0; i < n;) {
    let j = i;
    while (j + 1 < n && scores[order[j + 1]!] === scores[order[i]!]) j++;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (labels[order[k]!] === 1) rankSum += rank;
    i = j + 1;
  }
  return (rankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
}

/**
 * The area under the precision-recall curve, as a step for each distinct score: rows with the same
 * score are one threshold, so their order in the data does not change the result.
 */
export function averagePrecision(labels: ArrayLike<number>, scores: ArrayLike<number>): number | null {
  const n = labels.length;
  let positives = 0;
  for (let i = 0; i < n; i++) positives += labels[i]!;
  if (positives === 0) return null;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => scores[b]! - scores[a]!);
  let hits = 0;
  let total = 0;
  for (let i = 0; i < n;) {
    let j = i;
    let found = 0;
    while (j < n && scores[order[j]!] === scores[order[i]!]) found += labels[order[j++]!]!;
    hits += found;
    total += (found / positives) * (hits / j);
    i = j;
  }
  return total;
}

/** The score above which a share `rate` of the rows are. */
export function thresholdFor(scores: ArrayLike<number>, rate: number): number {
  const sorted = Float64Array.from(scores).sort();
  if (sorted.length === 0) return 1;
  const at = Math.min(sorted.length - 1, Math.max(0, Math.floor((1 - rate) * sorted.length)));
  return sorted[at]!;
}

export function rates(labels: ArrayLike<number>, scores: ArrayLike<number>, threshold: number) {
  let flagged = 0;
  let caught = 0;
  let positives = 0;
  for (let i = 0; i < labels.length; i++) {
    positives += labels[i]!;
    if (scores[i]! >= threshold) {
      flagged++;
      caught += labels[i]!;
    }
  }
  return {
    flagged,
    precision: flagged ? caught / flagged : null,
    recall: positives ? caught / positives : null,
  };
}

/** Seeded, so that an experiment run twice reports the same interval. */
export function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** ROC-AUC with a weight for each row, over rows sorted by score: a bootstrap sample is weights over the same rows. */
function weightedAuc(order: Int32Array, labels: ArrayLike<number>, scores: ArrayLike<number>, weight: Uint32Array) {
  let positives = 0;
  let negatives = 0;
  let sum = 0;
  for (let i = 0; i < order.length;) {
    let pos = 0;
    let neg = 0;
    let j = i;
    while (j < order.length && scores[order[j]!] === scores[order[i]!]) {
      const k = order[j++]!;
      if (labels[k] === 1) pos += weight[k]!;
      else neg += weight[k]!;
    }
    sum += pos * (negatives + neg / 2);
    positives += pos;
    negatives += neg;
    i = j;
  }
  return positives && negatives ? sum / (positives * negatives) : null;
}

export function bootstrapGain(
  labels: ArrayLike<number>,
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  rounds = 1000,
  seed = 7,
): [number | null, number | null] {
  const random = rng(seed);
  const n = labels.length;
  const sorted = (s: ArrayLike<number>) => Int32Array.from({ length: n }, (_, i) => i).sort((p, q) => s[p]! - s[q]!);
  const byA = sorted(a);
  const byB = sorted(b);
  const weight = new Uint32Array(n);
  const gains: number[] = [];
  for (let r = 0; r < rounds; r++) {
    weight.fill(0);
    for (let i = 0; i < n; i++) weight[Math.floor(random() * n)]!++;
    const left = weightedAuc(byA, labels, a, weight);
    const right = weightedAuc(byB, labels, b, weight);
    if (left !== null && right !== null) gains.push(left - right);
  }
  if (!gains.length) return [null, null];
  gains.sort((p, q) => p - q);
  return [gains[Math.floor(0.025 * (gains.length - 1))]!, gains[Math.floor(0.975 * (gains.length - 1))]!];
}

/** Newton's method on the L2-penalised log loss. `columns` are the inputs after their transforms. */
export function fitLogistic(columns: Float64Array[], labels: ArrayLike<number>, l2 = 1e-3, iterations = 50) {
  const n = labels.length;
  const k = columns.length + 1;
  const w = new Float64Array(k);
  let mean = 0;
  for (let i = 0; i < n; i++) mean += labels[i]!;
  mean = Math.min(1 - 1e-6, Math.max(1e-6, mean / Math.max(1, n)));
  w[0] = Math.log(mean / (1 - mean));
  const x = (i: number, j: number) => (j === 0 ? 1 : columns[j - 1]![i]!);
  for (let step = 0; step < iterations; step++) {
    const g = new Float64Array(k);
    const h = Array.from({ length: k }, () => new Float64Array(k));
    for (let i = 0; i < n; i++) {
      let z = 0;
      for (let j = 0; j < k; j++) z += w[j]! * x(i, j);
      const p = 1 / (1 + Math.exp(-z));
      const r = p - labels[i]!;
      const s = Math.max(p * (1 - p), 1e-9);
      for (let a = 0; a < k; a++) {
        const xa = x(i, a);
        g[a] = g[a]! + r * xa;
        const row = h[a]!;
        for (let b = a; b < k; b++) row[b] = row[b]! + s * xa * x(i, b);
      }
    }
    for (let a = 0; a < k; a++) {
      const row = h[a]!;
      for (let b = 0; b < a; b++) row[b] = h[b]![a]!;
      if (a > 0) {
        g[a] = g[a]! + l2 * n * w[a]!;
        row[a] = row[a]! + l2 * n;
      }
      row[a] = row[a]! + 1e-9;
    }
    const delta = solve(h, g);
    let moved = 0;
    for (let j = 0; j < k; j++) {
      w[j] = w[j]! - delta[j]!;
      moved = Math.max(moved, Math.abs(delta[j]!));
    }
    if (moved < 1e-8) break;
  }
  return { intercept: w[0]!, coefficients: Array.from(w.subarray(1)) };
}

function solve(a: Float64Array[], b: Float64Array): Float64Array {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    [m[col], m[pivot]] = [m[pivot]!, m[col]!];
    const p = m[col]![col]!;
    if (Math.abs(p) < 1e-15) continue;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r]![col]! / p;
      if (f === 0) continue;
      const target = m[r]!;
      for (let c = col; c <= n; c++) target[c] = target[c]! - f * m[col]![c]!;
    }
  }
  return Float64Array.from({ length: n }, (_, i) => (Math.abs(m[i]![i]!) < 1e-15 ? 0 : m[i]![n]! / m[i]![i]!));
}

export const transform = (kind: "identity" | "logit", v: number) => (kind === "logit" ? logit(v) : v);
