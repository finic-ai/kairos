import type { XgboostModel } from "./xgboost";

export const LOGISTIC_LIMITS = { features: 500 } as const;
export const LOGISTIC_TRANSFORMS = ["identity", "logit"] as const;
export type LogisticTransform = (typeof LOGISTIC_TRANSFORMS)[number];

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const EPSILON = 1e-6;

export interface LogisticModel extends XgboostModel {
  transforms: readonly LogisticTransform[];
}

export type LogisticLoad = { model: LogisticModel; problems: [] } | { model?: undefined; problems: string[] };

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export const logit = (p: number) => {
  const q = Math.min(1 - EPSILON, Math.max(EPSILON, p));
  return Math.log(q / (1 - q));
};

/**
 * A logistic layer over other scores: `{ features, transforms, coefficients, intercept, fill }`.
 * It stacks a model's score with a question model's answers, each as log-odds.
 */
export function loadLogistic(json: unknown): LogisticLoad {
  if (!isObject(json)) return { problems: ["must be an object"] };
  const { features, transforms = {}, coefficients, intercept, fill = {} } = json;
  const problems: string[] = [];
  if (!Array.isArray(features) || features.length === 0 || features.some((f) => typeof f !== "string"))
    return { problems: ["features must be a list of names"] };
  if (features.length > LOGISTIC_LIMITS.features) problems.push(`at most ${LOGISTIC_LIMITS.features} features`);
  const names = features as string[];
  const bad = names.filter((n) => !NAME.test(n));
  if (bad.length) problems.push(`feature names must be letters, digits and _: ${bad.join(", ")}`);
  if (new Set(names).size !== names.length) problems.push("features has a name twice");
  if (!Array.isArray(coefficients) || coefficients.length !== names.length || !coefficients.every(finite))
    problems.push("coefficients must be a finite number for each feature");
  if (!finite(intercept)) problems.push("intercept must be a finite number");
  if (!isObject(transforms)) problems.push("transforms must be an object of feature name → identity or logit");
  if (!isObject(fill)) problems.push("fill must be an object of feature name → a number");
  if (problems.length) return { problems };

  const t = transforms as Json;
  const f = fill as Json;
  for (const name of Object.keys(t))
    if (!names.includes(name)) problems.push(`transforms: no feature ${name}`);
    else if (!LOGISTIC_TRANSFORMS.includes(t[name] as LogisticTransform))
      problems.push(`transforms.${name}: identity or logit`);
  for (const name of Object.keys(f))
    if (!names.includes(name)) problems.push(`fill: no feature ${name}`);
    else if (!finite(f[name])) problems.push(`fill.${name}: a finite number`);
  if (problems.length) return { problems };

  const kinds = names.map((n) => (t[n] ?? "identity") as LogisticTransform);
  const weights = Float64Array.from(coefficients as number[]);
  const fills = names.map((n) => (finite(f[n]) ? (f[n] as number) : NaN));
  const b = intercept as number;
  return {
    problems: [],
    model: {
      features: names,
      transforms: kinds,
      trees: 0,
      nodes: names.length,
      depth: 0,
      score(values) {
        let z = b;
        for (let i = 0; i < weights.length; i++) {
          let v = values[i]!;
          // With no fill, a missing value adds nothing.
          if (Number.isNaN(v)) v = fills[i]!;
          if (Number.isNaN(v)) continue;
          z += weights[i]! * (kinds[i] === "logit" ? logit(v) : v);
        }
        return 1 / (1 + Math.exp(-z));
      },
    },
  };
}
