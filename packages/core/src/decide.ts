import { actionPolicy, actionRef, buildQuestions, type ActionDefinition } from "./actions";
import { buildContext, type ContextOptions } from "./context";
import type { Decider, GraysonResponse } from "./grayson";
import { applyPolicy } from "./policy";
import type { Decision, DecisionContext, DecisionInput } from "./types";

export interface DecideOptions {
  decider: Decider;
  action: ActionDefinition;
  context?: ContextOptions;
  model?: string;
}

export interface DecideResult {
  decision: Decision;
  /** What the model was shown and what it answered, for the decision log and for threshold tuning. */
  context: DecisionContext;
  raw: GraysonResponse;
}

export async function decide(input: DecisionInput, options: DecideOptions): Promise<DecideResult> {
  const { action } = options;
  const context = buildContext(input, { recentEvents: action.context?.recentEvents, ...options.context });
  const raw = await options.decider({
    model: options.model ?? "grayson-1",
    context,
    questions: buildQuestions(action),
  });

  const { hold, typology, reasons } = raw.answers;
  if (hold?.type !== "noul") throw new Error(`No yes/no answer from ${raw.model} for ${actionRef(action)}`);

  const threshold = action.context?.reasonThreshold ?? 0.5;
  const present =
    reasons?.type === "multi_choice"
      ? Object.entries(reasons.probabilities)
          .filter(([, p]) => p >= threshold)
          .map(([code]) => code)
      : [];
  const outcome = applyPolicy(actionPolicy(action), hold.probability, present, input.totalValues);

  return {
    decision: {
      decision: outcome.decision,
      probability: hold.probability,
      risk_score: Math.round(hold.probability * 100),
      reasons: present,
      ...(typology?.type === "choice" ? { typology: typology.value } : {}),
      rules: outcome.rules,
      action: actionRef(action),
    },
    context,
    raw,
  };
}
