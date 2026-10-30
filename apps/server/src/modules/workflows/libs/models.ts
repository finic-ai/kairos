import type { WorkflowStepDef } from "../types";
import { ExpressionError, resolveValue, type Variables } from "./expressions";

/** The score step and the training export both read features here, so that training sees what scoring sees. */
export function readFeatures(features: Record<string, unknown>, vars: Variables): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(features)) {
    try {
      values[name] = resolveValue(value, vars);
    } catch (cause) {
      if (!(cause instanceof ExpressionError)) throw cause;
      // Such as a feature of a step that did not run on this path: a missing value, not a failure.
      values[name] = undefined;
    }
  }
  return values;
}

/** A text when the step cannot use the model. */
export type ModelLookup = (
  ref: string,
) => Promise<{ kind: "question" | "scoring"; features?: readonly string[] } | string>;

const MODEL_STEPS: Record<string, "question" | "scoring"> = { assess: "question", ask: "question", score: "scoring" };
const READS = /\bsteps\.([A-Za-z_][A-Za-z0-9_]*)/g;

export async function modelProblems(steps: unknown, lookup: ModelLookup): Promise<string[]> {
  const problems: string[] = [];
  const before = new Set<string>();
  const visit = async (list: unknown, where: string) => {
    if (!Array.isArray(list)) return;
    for (const step of list as WorkflowStepDef[]) {
      if (!step || typeof step !== "object") continue;
      const at = `${where}.${step.id}`;
      const wants = MODEL_STEPS[step.type];
      const features =
        step.features && typeof step.features === "object" && !Array.isArray(step.features)
          ? (step.features as Record<string, unknown>)
          : undefined;
      if (wants && typeof step.model === "string") {
        const found = await lookup(step.model);
        if (typeof found === "string") problems.push(`${at}.model: ${found}`);
        else if (found.kind !== wants)
          problems.push(
            `${at}.model: "${step.model}" is a ${found.kind} model; ${wants === "scoring" ? "a score step needs a scoring model" : "this step needs a question model, such as grayson-1"}`,
          );
        else if (wants === "scoring" && features && found.features) {
          const given = Object.keys(features);
          const absent = found.features.filter((name) => !given.includes(name));
          const extra = given.filter((name) => !found.features!.includes(name));
          if (absent.length) problems.push(`${at}.features: the model also needs ${absent.join(", ")}`);
          if (extra.length) problems.push(`${at}.features: the model has no feature ${extra.join(", ")}`);
        }
      }
      if (step.type === "score" && features) {
        for (const [name, value] of Object.entries(features)) {
          if (typeof value !== "string") continue;
          for (const [, id] of value.matchAll(READS))
            if (!before.has(id!))
              problems.push(`${at}.features.${name}: reads steps.${id}, which does not run before this step`);
        }
      }
      before.add(step.id);
      if (step.type === "condition") {
        await visit(step.then, `${at}.then`);
        await visit(step.else, `${at}.else`);
      } else if (step.type === "loop") await visit(step.steps, `${at}.steps`);
    }
  };
  await visit(steps, "steps");
  return problems;
}
