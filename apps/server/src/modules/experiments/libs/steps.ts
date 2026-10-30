import type { ExperimentVariant } from "../schema";

type Step = Record<string, unknown>;

export interface TrainedModels {
  /** The reference of the variant's model, such as "loan-stacked@3". Absent for a probability. */
  model?: string;
  /** For a stacked variant: its base model. */
  base?: string;
}

function ids(steps: unknown, into = new Set<string>()): Set<string> {
  if (!Array.isArray(steps)) return into;
  for (const step of steps as Step[]) {
    if (typeof step?.id === "string") into.add(step.id);
    ids(step?.then, into);
    ids(step?.else, into);
    ids(step?.steps, into);
  }
  return into;
}

function answers(step: Step): boolean {
  if (step.type === "answer" || step.type === "return") return true;
  return ["then", "else", "steps"].some((k) => Array.isArray(step[k]) && (step[k] as Step[]).some(answers));
}

// A workflow that a variant was applied to scores with that variant's models: the new variant replaces them.
const replaced = (step: Step) => answers(step) || step.type === "score";

// A score step says what the model is; the experiment keeps the variant's own name.
const MODEL_NAMES = { gbdt: "Gradient-boosted trees", logistic: "Logistic regression" } as const;

const inner = (template: string) => {
  const match = /^\s*\{\{([\s\S]+)\}\}\s*$/.exec(template);
  return match ? match[1]!.trim() : null;
};

/**
 * The workflow's steps with the variant deciding: its own steps lose those that answer (a variant
 * applied before answers in a condition) and the steps it drops, then score with its models, then
 * answer block, review or approve by the score.
 */
export function variantSteps(
  base: Step[],
  variant: ExperimentVariant,
  features: Record<string, unknown>,
  models: TrainedModels,
  thresholds: { review: number; block: number },
): Step[] {
  const dropped = new Set(variant.drop_steps);
  const kept = base.filter((s) => !replaced(s) && !dropped.has(String(s.id)));
  const taken = ids(kept);
  const fresh = (want: string) => {
    let id = want;
    for (let n = 2; taken.has(id); n++) id = `${want}_${n}`;
    taken.add(id);
    return id;
  };
  const pick = (names: string[]) => Object.fromEntries(names.map((n) => [n, features[n] ?? null]));
  const m = variant.model;
  const steps: Step[] = [...kept];
  let score: string;

  if (m.type === "probability") {
    const value = features[m.feature];
    const expression = typeof value === "string" ? inner(value) : null;
    score = expression ?? String(value ?? 0);
  } else if (m.type === "stacked") {
    const baseId = fresh("base_score");
    const id = fresh("score");
    steps.push(
      {
        id: baseId,
        name: "Score: Gradient-boosted trees",
        type: "score",
        model: models.base,
        features: pick(m.base.features),
      },
      {
        id,
        name: "Score: Logistic regression (stacked)",
        type: "score",
        model: models.model,
        features: { base: `{{ steps.${baseId}.output.score }}`, ...pick(m.features) },
      },
    );
    score = `steps.${id}.output.score`;
  } else {
    const id = fresh("score");
    steps.push({
      id,
      name: `Score: ${MODEL_NAMES[m.type]}`,
      type: "score",
      model: models.model,
      features: pick(m.features),
    });
    score = `steps.${id}.output.score`;
  }

  const probability = `{{ ${score} }}`;
  const answer = (outcome: string, name: string) => ({
    id: fresh(outcome),
    name,
    type: "answer",
    value: { outcome, probability },
  });
  steps.push({
    id: fresh("blocked"),
    name: "Block when very risky",
    type: "condition",
    when: `${score} >= ${literal(thresholds.block)}`,
    then: [answer("block", "Block")],
    else: [
      {
        id: fresh("risky"),
        name: "Review when risky",
        type: "condition",
        when: `${score} >= ${literal(thresholds.review)}`,
        then: [answer("review", "Review")],
        else: [answer("approve", "Approve")],
      },
    ],
  });
  return steps;
}

/** The exact threshold that was measured, as a CEL double: a rounded one moves the rows at it to another outcome. */
const literal = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : String(v));

/** The steps of the workflow that a variant's steps leave out: those that answer, and those it drops. */
export function removedSteps(base: Step[], variant: ExperimentVariant): string[] {
  const dropped = new Set(variant.drop_steps);
  const kept = ids(base.filter((s) => !replaced(s) && !dropped.has(String(s.id))));
  return [...ids(base)].filter((id) => !kept.has(id));
}

/** The variant's features that read a step it leaves out: in production they would have no value. */
export function readsRemoved(features: Record<string, unknown>, used: string[], removed: string[]): string[] {
  const gone = new Set(removed);
  return used.filter((name) => {
    const template = features[name];
    if (typeof template !== "string") return false;
    return [...template.matchAll(/\bsteps\.([A-Za-z_][A-Za-z0-9_]*)/g)].some((m) => gone.has(m[1]!));
  });
}
