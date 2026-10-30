import type { Outcome } from "./types";

export const TOTAL_MEASURES = ["sum", "events", "times_usual", "share_covered"] as const;
export const COMPARISONS = [">", ">=", "<", "<="] as const;

/** A comparison of one of the action's totals with a number: money_out, sum, >, 5000. */
export interface TotalCondition {
  /** The name of a total in the action's `context.totals`. */
  total: string;
  /** Which number of the total. Default "sum". */
  is?: (typeof TOTAL_MEASURES)[number];
  op: (typeof COMPARISONS)[number];
  value: number;
}

export interface PolicyRule {
  id: string;
  /** Reason codes that must all be present. May be empty when the rule has `when`. */
  allOf: string[];
  /**
   * Comparisons on the action's totals that must all hold. These are exact: the server
   * compares the numbers, the model does not.
   */
  when?: TotalCondition[];
  outcome: Outcome;
}

export interface Policy {
  /** Hold probability at or above which the action is blocked. */
  block: number;
  /** Hold probability at or above which the action goes to review. */
  review: number;
  rules: PolicyRule[];
}

/**
 * Placeholder thresholds. In testing, hard cases scored well below 0.5 while still
 * ranking above normal ones, so thresholds must be tuned on the customer's own outcomes.
 */
export const DEFAULT_POLICY: Policy = { block: 0.9, review: 0.5, rules: [] };

export const OUTCOME_SEVERITY: Readonly<Record<Outcome, number>> = { approve: 0, step_up: 1, review: 2, block: 3 };

const holds = (
  condition: TotalCondition,
  totals: Record<string, { sum: number; events: number; times_usual?: number; share_covered?: number | null }>,
): boolean => {
  const actual = totals[condition.total]?.[condition.is ?? "sum"];
  // A total that could not be calculated satisfies nothing.
  if (typeof actual !== "number" || Number.isNaN(actual)) return false;
  return condition.op === ">"
    ? actual > condition.value
    : condition.op === ">="
      ? actual >= condition.value
      : condition.op === "<"
        ? actual < condition.value
        : actual <= condition.value;
};

export function applyPolicy(
  policy: Policy,
  probability: number,
  reasons: readonly string[],
  totals: Record<string, { sum: number; events: number; times_usual?: number; share_covered?: number | null }> = {},
): { decision: Outcome; rules: string[] } {
  let decision: Outcome = probability >= policy.block ? "block" : probability >= policy.review ? "review" : "approve";
  const present = new Set(reasons);
  const fired: string[] = [];
  for (const rule of policy.rules) {
    if (!(rule.allOf ?? []).every((code) => present.has(code))) continue;
    if (!(rule.when ?? []).every((condition) => holds(condition, totals))) continue;
    fired.push(rule.id);
    if (OUTCOME_SEVERITY[rule.outcome] > OUTCOME_SEVERITY[decision]) decision = rule.outcome;
  }
  return { decision, rules: fired };
}
