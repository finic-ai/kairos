export interface BuiltinModel {
  slug: string;
  name: string;
  kind: "question";
  runtime: "builtin";
  status: "active";
}

export interface Scorer {
  ref: string;
  features: readonly string[];
  /** NaN is a missing value. */
  score(row: ArrayLike<number>): number;
}

export interface ScoreResult {
  score: number;
  risk_score: number;
  model: string;
  features: Record<string, number | null>;
  missing: string[];
  invalid: string[];
}

export type StepScore = ScoreResult & { step: string };
