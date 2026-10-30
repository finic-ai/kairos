import type { WorkflowStep } from "../types/interfaces";

/** The step lists a step holds: a condition has two, a loop has one. */
export type Branch = "steps" | "then" | "else";

/** A place in the tree where a step can go: a list, and a position in it. `parent` null is the top list. */
export interface Slot {
  parent: string | null;
  branch: Branch;
  index: number;
}

export const MAX_DEPTH = 3;
export const MAX_STEPS = 50;

export const branchesOf = (step: WorkflowStep): Branch[] =>
  step.type === "condition" ? ["then", "else"] : step.type === "loop" ? ["steps"] : [];

export const listOf = (step: WorkflowStep, branch: Branch): WorkflowStep[] =>
  Array.isArray(step[branch]) ? (step[branch] as WorkflowStep[]) : [];

export const slotKey = (slot: Slot) => `${slot.parent ?? "root"}:${slot.branch}:${slot.index}`;

/** Every step, depth first, with its depth: 0 for the top list. */
export function walk(steps: WorkflowStep[], depth = 0): { step: WorkflowStep; depth: number }[] {
  return steps.flatMap((step) => [
    { step, depth },
    ...branchesOf(step).flatMap((b) => walk(listOf(step, b), depth + 1)),
  ]);
}

export const findStep = (steps: WorkflowStep[], id: string) => walk(steps).find((e) => e.step.id === id)?.step;

/** How many levels of lists a step holds below it: 0 for a step with no lists. */
export function heightOf(step: WorkflowStep): number {
  const lists = branchesOf(step);
  if (lists.length === 0) return 0;
  return 1 + Math.max(0, ...lists.flatMap((b) => listOf(step, b).map(heightOf)));
}

export function slotDepth(steps: WorkflowStep[], slot: Slot): number {
  if (slot.parent === null) return 0;
  const found = walk(steps).find((e) => e.step.id === slot.parent);
  return found ? found.depth + 1 : 0;
}

/** Change the list that a slot names. The tree is copied along the path; the rest is shared. */
function editList(
  steps: WorkflowStep[],
  parent: string | null,
  branch: Branch,
  edit: (list: WorkflowStep[]) => WorkflowStep[],
): WorkflowStep[] {
  if (parent === null) return edit(steps);
  return steps.map((step) => {
    if (step.id === parent) return { ...step, [branch]: edit(listOf(step, branch)) };
    const lists = branchesOf(step);
    if (lists.length === 0) return step;
    const next = { ...step };
    for (const b of lists) next[b] = editList(listOf(step, b), parent, branch, edit);
    return next;
  });
}

export const insertStep = (steps: WorkflowStep[], slot: Slot, step: WorkflowStep) =>
  editList(steps, slot.parent, slot.branch, (list) => [...list.slice(0, slot.index), step, ...list.slice(slot.index)]);

export function removeStep(steps: WorkflowStep[], id: string): WorkflowStep[] {
  return steps
    .filter((s) => s.id !== id)
    .map((step) => {
      const lists = branchesOf(step);
      if (lists.length === 0) return step;
      const next = { ...step };
      for (const b of lists) next[b] = removeStep(listOf(step, b), id);
      return next;
    });
}

export const updateStep = (steps: WorkflowStep[], id: string, change: (step: WorkflowStep) => WorkflowStep) =>
  walk(steps).some((e) => e.step.id === id) ? mapSteps(steps, (s) => (s.id === id ? change(s) : s)) : steps;

function mapSteps(steps: WorkflowStep[], change: (step: WorkflowStep) => WorkflowStep): WorkflowStep[] {
  return steps.map((step) => {
    const lists = branchesOf(step);
    const mapped = change(step);
    if (lists.length === 0) return mapped;
    const next = { ...mapped };
    for (const b of branchesOf(mapped)) next[b] = mapSteps(listOf(mapped, b), change);
    return next;
  });
}

export function slotOf(
  steps: WorkflowStep[],
  id: string,
  parent: string | null = null,
  branch: Branch = "steps",
): Slot | null {
  for (const [index, step] of steps.entries()) {
    if (step.id === id) return { parent, branch, index };
    for (const b of branchesOf(step)) {
      const found = slotOf(listOf(step, b), id, step.id, b);
      if (found) return found;
    }
  }
  return null;
}

/** Why a step cannot go to a slot, or null when it can. */
export function moveProblem(steps: WorkflowStep[], id: string, slot: Slot): string | null {
  const step = findStep(steps, id);
  if (!step) return "That step is not in the workflow.";
  if (
    slot.parent !== null &&
    (slot.parent === id ||
      walk(branchesOf(step).flatMap((b) => listOf(step, b))).some((e) => e.step.id === slot.parent))
  )
    return "A step cannot go inside itself.";
  if (slotDepth(steps, slot) + heightOf(step) > MAX_DEPTH)
    return `Conditions and loops nest at most ${MAX_DEPTH} levels.`;
  return null;
}

/** Move a step and the steps it holds to a slot. The slot is read before the step leaves its place. */
export function moveStep(steps: WorkflowStep[], id: string, slot: Slot): WorkflowStep[] {
  const from = slotOf(steps, id);
  const step = findStep(steps, id);
  if (!from || !step || moveProblem(steps, id, slot)) return steps;
  const sameList = from.parent === slot.parent && from.branch === slot.branch;
  if (sameList && (slot.index === from.index || slot.index === from.index + 1)) return steps;
  const index = sameList && slot.index > from.index ? slot.index - 1 : slot.index;
  return insertStep(removeStep(steps, id), { ...slot, index }, step);
}

export function slugId(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return /^[a-z_]/.test(base) ? base : `step_${base}`.replace(/_+$/, "");
}

/** An id made from the name that no step has yet. */
export function freshId(name: string, taken: Set<string>): string {
  const base = slugId(name) || "step";
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
  return id;
}

/** A name that no step has yet: "Condition", then "Condition 2". */
export function freshName(base: string, taken: Set<string>): string {
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base} ${n}`;
  return name;
}

/** Copy a step and the steps it holds, with new ids and names. */
export function duplicate(step: WorkflowStep, ids: Set<string>, names: Set<string>): WorkflowStep {
  const name = freshName(`${step.name} copy`, names);
  names.add(name);
  const id = freshId(name, ids);
  ids.add(id);
  const copy: WorkflowStep = { ...step, id, name };
  for (const b of branchesOf(step)) copy[b] = listOf(step, b).map((s) => duplicate(s, ids, names));
  return copy;
}

const REFERENCE = (id: string) => new RegExp(`\\bsteps\\.${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");

function renameIn(value: unknown, pattern: RegExp, to: string): unknown {
  if (typeof value === "string") return value.replace(pattern, `steps.${to}`);
  if (Array.isArray(value)) return value.map((v) => renameIn(v, pattern, to));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renameIn(v, pattern, to)]));
  return value;
}

/** Change a step's id, and every `steps.<id>` that reads it, so a reference does not break. */
export function renameId(steps: WorkflowStep[], from: string, to: string): WorkflowStep[] {
  const pattern = REFERENCE(from);
  return mapSteps(steps, (step) => {
    const next: WorkflowStep = { ...step, id: step.id === from ? to : step.id };
    for (const [k, v] of Object.entries(step))
      if (!["id", "name", "type", ...branchesOf(step)].includes(k)) next[k] = renameIn(v, pattern, to);
    return next;
  });
}

/** The steps that hold a step, from the top list down. */
export function ancestorsOf(steps: WorkflowStep[], id: string): WorkflowStep[] {
  for (const step of steps) {
    if (step.id === id) return [];
    for (const b of branchesOf(step)) {
      const below = ancestorsOf(listOf(step, b), id);
      if (below.length || listOf(step, b).some((s) => s.id === id)) return [step, ...below];
    }
  }
  return [];
}

/** The ids of the steps that run before a step and can be read by it as `steps.<id>.output`. */
export function readableBefore(steps: WorkflowStep[], id: string): WorkflowStep[] {
  const found: WorkflowStep[] = [];
  const search = (list: WorkflowStep[], before: WorkflowStep[]): boolean => {
    for (const [i, step] of list.entries()) {
      const earlier = [...before, ...list.slice(0, i)];
      if (step.id === id) return (found.push(...earlier), true);
      for (const b of branchesOf(step)) if (search(listOf(step, b), [...earlier, step])) return true;
    }
    return false;
  };
  search(steps, []);
  return found;
}

const REQUIRED: Record<string, string[]> = {
  condition: ["when"],
  filter: ["when"],
  loop: ["over"],
  http: ["url"],
  "record.get": ["record", "record_id"],
  "record.search": ["record"],
  "record.create": ["record"],
  "record.update": ["record"],
  decide: ["action", "entities"],
  ask: ["questions"],
  score: ["model"],
  "case.create": ["queue", "entity", "reason"],
  "case.resolve": ["case_id", "category"],
};

/** What the builder checks as the person edits: each problem belongs to a step, or to the workflow. */
export function problemsOf(steps: WorkflowStep[]): { step: string | null; message: string }[] {
  const problems: { step: string | null; message: string }[] = [];
  const all = walk(steps);
  if (all.length === 0) problems.push({ step: null, message: "A workflow has at least one step." });
  if (all.length > MAX_STEPS) problems.push({ step: null, message: `At most ${MAX_STEPS} steps in one workflow.` });
  const ids = new Map<string, number>();
  const names = new Map<string, number>();
  for (const { step } of all) {
    ids.set(step.id, (ids.get(step.id) ?? 0) + 1);
    names.set(step.name, (names.get(step.name) ?? 0) + 1);
  }
  for (const { step, depth } of all) {
    const add = (message: string) => problems.push({ step: step.id, message });
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(step.id)) add("The id must be letters, digits and _.");
    else if (ids.get(step.id)! > 1) add(`Another step has the id "${step.id}".`);
    if (!step.name?.trim()) add("The step needs a name.");
    else if (step.name.length > 80) add("The name is longer than 80 characters.");
    else if (names.get(step.name)! > 1) add(`Another step has the name "${step.name}".`);
    if (branchesOf(step).length && depth >= MAX_DEPTH) add(`Conditions and loops nest at most ${MAX_DEPTH} levels.`);
    for (const field of REQUIRED[step.type] ?? []) {
      const value = step[field];
      if (value === undefined || value === "" || value === null) add(`"${field}" is needed.`);
    }
    if (step.type === "delay" && !step.for === !step.until) add('A delay has "for" or "until", not both.');
    if (step.type === "record.create" && step.record === "decision") add("A decide step makes a decision.");
    if (step.type === "record.update" && step.record === "event") add("Events do not change.");
    if (step.type === "record.create" && step.record === "case") add("A case.create step makes a case.");
    if (step.type === "record.update" && step.record === "case") add("A case.resolve step resolves a case.");
  }
  // A Return ends the run: a step after it in the same list never runs.
  const afterReturn = (list: WorkflowStep[]) => {
    const at = list.findIndex((s) => s.type === "return");
    if (at >= 0 && at < list.length - 1)
      problems.push({ step: list[at + 1]!.id, message: "This step comes after a Return, so it never runs." });
    for (const s of list) for (const branch of branchesOf(s)) afterReturn((s[branch] as WorkflowStep[]) ?? []);
  };
  afterReturn(steps);
  return problems;
}

/** Find the step that a server problem names, such as "steps.big.then.flag.when: …". */
export function stepOfServerProblem(steps: WorkflowStep[], message: string): string | null {
  const path = message.split(":")[0] ?? "";
  if (!path.startsWith("steps")) return null;
  const ids = new Set(walk(steps).map((e) => e.step.id));
  const named = path.split(".").filter((part) => ids.has(part));
  return named.at(-1) ?? null;
}
