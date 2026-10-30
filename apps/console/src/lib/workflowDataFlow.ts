import type { WorkflowStep } from "../types/interfaces";

/** What one step reads from the trigger or from an earlier step, drawn as a dashed line beside the run order. */
export interface DataFlow {
  id: string;
  source: string;
  target: string;
  /** The inputs that come this way: a score step's feature names, or an ask step's data keys. */
  fields: string[];
  label: string;
}

const CHILDREN = ["then", "else", "steps"];
const READERS = new Set(["score", "ask"]);

function texts(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) value.forEach((v) => texts(v, into));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => texts(v, into));
  return into;
}

/** The step a value reads from, or the trigger. Null for a constant. */
function sourceOf(value: unknown, earlier: Set<string>): string | null {
  const all = texts(value).join(" ");
  for (const match of all.matchAll(/\bsteps\.([A-Za-z_][A-Za-z0-9_]*)\b/g))
    if (earlier.has(match[1]!)) return match[1]!;
  return /\b(trigger|event|entity|decision)\b/.test(all) ? "trigger" : null;
}

/** Each input of a step that reads data, by name: a score step's features, an ask step's data. */
function inputsOf(step: WorkflowStep): Record<string, unknown> {
  if (step.type === "score") return (step.features as Record<string, unknown>) ?? {};
  const data = (step.data as Record<string, unknown>) ?? {};
  return step.entity ? { ...data, entity: step.entity } : data;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function dataFlows(steps: WorkflowStep[]): DataFlow[] {
  const flows: DataFlow[] = [];
  const kinds = new Map<string, string>();
  const earlier = new Set<string>();
  const visit = (list: WorkflowStep[]) => {
    for (const step of list) {
      if (READERS.has(step.type)) {
        const bySource = new Map<string, string[]>();
        for (const [name, value] of Object.entries(inputsOf(step))) {
          const source = sourceOf(value, earlier);
          if (source) bySource.set(source, [...(bySource.get(source) ?? []), name]);
        }
        for (const [source, fields] of bySource) {
          const from = source === "trigger" ? null : kinds.get(source);
          flows.push({
            id: `data:${source}->${step.id}`,
            source,
            target: step.id,
            fields,
            label:
              source === "trigger"
                ? plural(fields.length, "field from the trigger", "fields from the trigger")
                : from === "ask"
                  ? plural(fields.length, "answer", "answers")
                  : plural(fields.length, "value", "values"),
          });
        }
      }
      earlier.add(step.id);
      kinds.set(step.id, step.type);
      for (const key of CHILDREN) if (Array.isArray(step[key])) visit(step[key] as WorkflowStep[]);
    }
  };
  visit(steps);
  return flows;
}
