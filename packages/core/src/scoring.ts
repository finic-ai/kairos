export interface ModelVersionDefinition {
  kind: "scoring";
  format: "xgboost-json" | "logistic-json";
  objective: "binary:logistic";
  features: { name: string; type: string }[];
  trees: number;
  depth: number;
  /** "sha256:<hex>" of a row in model_artifacts. */
  artifact: string;
  parity: { samples: number; max_difference: number };
  description?: string;
  metrics?: Record<string, unknown>;
  training?: Record<string, unknown>;
  /** Feature name → template, for the builder to offer in a score step. */
  suggested_features?: Record<string, string>;
  promoted_from?: { environment: string; version: number; sha256: string };
}

export interface FeatureValues {
  /** NaN is a missing value. */
  row: Float64Array;
  values: Record<string, number | null>;
  missing: string[];
  /** Values that are not numbers. They are in `missing` too. */
  invalid: string[];
  unknown: string[];
}

const DECIMAL = /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/;

export function featureValue(value: unknown): number | undefined | "invalid" {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === null || value === undefined) return undefined;
  // Imported CSV values are often numbers as text.
  if (typeof value === "string" && DECIMAL.test(value)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return "invalid";
}

export function featureValues(features: readonly string[], input: Record<string, unknown>): FeatureValues {
  const known = new Set(features);
  const out: FeatureValues = {
    row: new Float64Array(features.length),
    values: {},
    missing: [],
    invalid: [],
    unknown: Object.keys(input).filter((name) => !known.has(name)),
  };
  for (const [i, name] of features.entries()) {
    const value = featureValue(input[name]);
    if (typeof value === "number") {
      out.row[i] = value;
      out.values[name] = value;
    } else {
      out.row[i] = NaN;
      out.values[name] = null;
      out.missing.push(name);
      if (value === "invalid") out.invalid.push(name);
    }
  }
  return out;
}
