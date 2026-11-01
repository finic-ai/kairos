import type { KairosEvent, WorkflowRun, WorkflowRunStep, WorkflowStep } from "../types/interfaces";
import { walk } from "./workflowTree";

export type TraceItem =
  | {
      kind: "ran";
      step: WorkflowStep;
      /** More than one for a step inside a loop. */
      entries: WorkflowRunStep[];
      depth: number;
      /** The condition or loop that holds the step. */
      parent: string | null;
      afterAnswer: boolean;
    }
  | {
      kind: "not_run";
      steps: WorkflowStep[];
      depth: number;
      parent: string | null;
      /** Set for the branch of a condition that the run did not take. */
      branch?: "then" | "else";
      why: string;
    };

const ANSWERS = new Set(["answer", "return"]);

/** The steps of a run in the order of the workflow, with the branches it took and the ones it did not. */
export function traceOf(steps: WorkflowStep[], run: Pick<WorkflowRun, "steps">): TraceItem[] {
  const byId = new Map<string, WorkflowRunStep[]>();
  for (const entry of run.steps) byId.set(entry.id, [...(byId.get(entry.id) ?? []), entry]);
  const types = new Map(walk(steps).map((e) => [e.step.id, e.step.type]));
  const order = new Map(run.steps.map((e, i) => [e, i]));
  const answered = run.steps.findIndex((e) => e.status === "done" && ANSWERS.has(types.get(e.id) ?? ""));

  const items: TraceItem[] = [];
  const skip = (list: WorkflowStep[], depth: number, parent: string | null, why: string, branch?: "then" | "else") => {
    if (list.length) items.push({ kind: "not_run", steps: list, depth, parent, why, ...(branch ? { branch } : {}) });
  };
  const ranInside = (list: unknown) =>
    walk((list as WorkflowStep[] | undefined) ?? []).some((e) => byId.has(e.step.id));
  // The runner logs a condition after its branch, so a decision's answer comes first, and a run
  // that stops at its answer never logs it. The branch is known from the steps that ran in it.
  const branchOf = (step: WorkflowStep, entries: WorkflowRunStep[]): "then" | "else" | null => {
    const logged = (entries[0]?.output as { branch?: string } | undefined)?.branch;
    if (logged === "then" || logged === "else") return logged;
    return ranInside(step.then) ? "then" : ranInside(step.else) ? "else" : null;
  };
  const firstIndex = (step: WorkflowStep) =>
    Math.min(...walk([step]).flatMap((e) => (byId.get(e.step.id) ?? []).map((entry) => order.get(entry)!)));
  const visit = (list: WorkflowStep[], depth: number, parent: string | null) => {
    for (const [i, step] of list.entries()) {
      let entries = byId.get(step.id) ?? [];
      const branch = step.type === "condition" ? branchOf(step, entries) : null;
      if (entries.length === 0 && branch)
        entries = [{ id: step.id, name: step.name, path: step.id, status: "done", output: { branch } }];
      if (entries.length === 0) {
        skip(list.slice(i), depth, parent, i === 0 ? "Not reached" : `Not run after "${list[i - 1]!.name}"`);
        return;
      }
      const after = answered >= 0 && firstIndex(step) > answered;
      items.push({ kind: "ran", step, entries, depth, parent, afterAnswer: after });
      if (step.type === "condition") {
        const taken = branch ?? "else";
        const other = taken === "then" ? "else" : "then";
        visit((step[taken] as WorkflowStep[] | undefined) ?? [], depth + 1, step.id);
        skip(
          (step[other] as WorkflowStep[] | undefined) ?? [],
          depth + 1,
          step.id,
          `The ${other} branch, not taken`,
          other,
        );
      } else if (step.type === "loop") visit((step.steps as WorkflowStep[] | undefined) ?? [], depth + 1, step.id);
    }
  };
  visit(steps, 0, null);
  return items;
}

const REFERENCE = /\b(?:steps\.[A-Za-z_]\w*\.output|trigger|event|item)(?:\.[A-Za-z_]\w*)*/g;

/** The fields that an expression reads, with their values in the run: what a condition decided on. */
export function readsOf(expression: string, run: Pick<WorkflowRun, "steps" | "trigger">): [string, unknown][] {
  const { live_steps: _live, mock_outputs: _mocks, ...trigger } = run.trigger;
  const outputs = Object.fromEntries(
    run.steps.filter((e) => e.status === "done").map((e) => [e.id, { output: e.output }]),
  );
  const vars: Record<string, unknown> = { trigger, steps: outputs, event: trigger.event };
  const seen = new Map<string, unknown>();
  for (const [path] of expression.matchAll(REFERENCE)) {
    if (seen.has(path)) continue;
    let value: unknown = vars;
    for (const part of path.split("."))
      value = value && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined;
    seen.set(path, value);
  }
  return [...seen];
}

/** The events that a model step read, oldest first, and what it was asked about. */
export function eventsRead(
  entry: WorkflowRunStep,
): { events: KairosEvent[]; pending?: Record<string, unknown> } | null {
  const context = entry.read?.context;
  if (!context || !Array.isArray(context.recent_events)) return null;
  return {
    events: context.recent_events as KairosEvent[],
    ...(context.pending_action && typeof context.pending_action === "object"
      ? { pending: context.pending_action as Record<string, unknown> }
      : {}),
  };
}
