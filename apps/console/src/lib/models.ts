import type { ModelSummary, UploadedModel, WorkflowDefinition, WorkflowStep } from "../types/interfaces";
import { walk } from "./workflowTree";

export const TRAIN_SNIPPET = `pip install "finic-kairos[train]"
python -m kairos train model.json`;

export const KIND_LABEL = { question: "Question model", scoring: "Scoring model" } as const;

export const runtimeLabel = (model: ModelSummary) => (model.runtime === "builtin" ? "Built in" : "XGBoost");

export const isUploaded = (model: ModelSummary): model is UploadedModel => model.runtime === "in_process";

export const slugOfRef = (ref: string) => ref.split("@")[0]!;

export const metric = (value: unknown, digits = 3) =>
  typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "—";

export const signed = (value: unknown, digits = 3) =>
  typeof value === "number" && Number.isFinite(value) ? `${value >= 0 ? "+" : ""}${value.toFixed(digits)}` : "—";

export function workflowsUsing(workflows: WorkflowDefinition[], slug: string): WorkflowDefinition[] {
  return workflows.filter(
    (w) =>
      w.status === "published" &&
      walk(w.steps).some(
        (e) => e.step.type === "score" && typeof e.step.model === "string" && slugOfRef(e.step.model) === slug,
      ),
  );
}

/** The server's checks of a score step, made in the builder too, with the same rule for which steps come before. */
export function scoreStepProblems(steps: WorkflowStep[], models: ModelSummary[]): { step: string; message: string }[] {
  const problems: { step: string; message: string }[] = [];
  const order = walk(steps).map((e) => e.step.id);
  for (const { step } of walk(steps)) {
    if (step.type !== "score") continue;
    const before = new Set(order.slice(0, order.indexOf(step.id)));
    for (const [name, value] of Object.entries((step.features ?? {}) as Record<string, unknown>)) {
      if (typeof value !== "string") continue;
      const late = [...value.matchAll(/\bsteps\.([A-Za-z_][A-Za-z0-9_]*)/g)]
        .map((m) => m[1]!)
        .filter((id) => !before.has(id));
      for (const id of new Set(late))
        problems.push({ step: step.id, message: `${name} reads steps.${id}, which does not run before this step.` });
    }
    if (typeof step.model !== "string" || !step.model) continue;
    const model = modelOfStep(step, models);
    const add = (message: string) => problems.push({ step: step.id, message });
    if (!model) {
      add(`There is no model "${slugOfRef(step.model)}".`);
      continue;
    }
    if (!isUploaded(model)) {
      add(`"${model.slug}" is a question model: a score needs a scoring model.`);
      continue;
    }
    if (model.status === "archived") add(`The model "${model.slug}" is archived.`);
    const features = (step.features ?? {}) as Record<string, unknown>;
    const empty = model.definition.features
      .map((f) => f.name)
      .filter((name) => features[name] === undefined || String(features[name]).trim() === "");
    const extra = Object.keys(features).filter((name) => !model.definition.features.some((f) => f.name === name));
    if (empty.length) add(`The model also needs ${empty.join(", ")}.`);
    if (extra.length) add(`The model has no feature ${extra.join(", ")}.`);
  }
  return problems;
}

export const modelOfStep = (step: WorkflowStep, models: ModelSummary[]) =>
  typeof step.model === "string" ? models.find((m) => m.slug === slugOfRef(step.model as string)) : undefined;
