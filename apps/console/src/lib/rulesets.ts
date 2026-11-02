import type {
  RulesetDefinition,
  RulesetOutcome,
  RulesetRule,
  RulesetSummary,
  WorkflowInput,
} from "../types/interfaces";
import { fromCel, OPS, type Group } from "./conditions";
import { freshId, freshName } from "./workflowTree";

export const BLANK_RULESET: RulesetDefinition = { inputs: [], rules: [], default: { outcome: "approve" }, tests: [] };

export const OUTCOME_LABEL: Record<RulesetOutcome, string> = { approve: "Approve", reject: "Reject" };

export const RULESET_INPUT_TYPES: { value: WorkflowInput["type"]; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "boolean", label: "True or false" },
  { value: "list", label: "List" },
  { value: "object", label: "Object (JSON)" },
];

/** The definition the builder edits: the draft when there is one, else the live version. */
export const editableOf = (r: RulesetSummary): RulesetDefinition => structuredClone(r.draft ?? r.definition);

export function newRule(rules: RulesetRule[]): RulesetRule {
  const name = freshName("Rule", new Set(rules.map((r) => r.name)));
  return { id: freshId(name, new Set(rules.map((r) => r.id))), name, when: "", outcome: "reject" };
}

export function copyRule(rule: RulesetRule, rules: RulesetRule[]): RulesetRule {
  const name = freshName(`${rule.name} copy`, new Set(rules.map((r) => r.name)));
  return { ...structuredClone(rule), id: freshId(name, new Set(rules.map((r) => r.id))), name };
}

const opLabel = (op: string) => OPS.find((o) => o.op === op)?.label ?? op;
const fieldLabel = (field: string) => field.replace(/^input\./, "");
const IN_LIST = /^inList\(\s*([A-Za-z_][\w.]*)\s*,\s*['"]([^'"]+)['"]\s*\)$/;

export function conditionChips(when: string): { join: "And" | "Or"; chips: string[] } {
  const text = when.trim();
  if (!text) return { join: "And", chips: [] };
  const listed = IN_LIST.exec(text);
  if (listed) return { join: "And", chips: [`${fieldLabel(listed[1]!)} is in the list ${listed[2]}`] };
  const group: Group | null = fromCel(text);
  if (!group) return { join: "And", chips: [text] };
  const chips = group.items.map((item) =>
    item.kind === "rule"
      ? `${fieldLabel(item.field)} ${opLabel(item.op)}${item.value ? ` ${item.value}` : ""}`
      : `${item.items.length} conditions, ${item.join === "all" ? "all" : "any"} of them`,
  );
  return { join: group.join === "all" ? "And" : "Or", chips };
}

/** A problem from the core checks or the server, by where the builder shows it: a rule id, or a part. */
export function problemPlace(problem: string): string {
  const rule = /^rules\.([A-Za-z_][A-Za-z0-9_]*)[.:]/.exec(problem);
  if (rule) return `rule:${rule[1]}`;
  if (problem.startsWith("inputs")) return "start";
  if (problem.startsWith("default")) return "default";
  if (problem.startsWith("tests")) return "tests";
  return "ruleset";
}

const PART: Record<string, string> = { when: "If", outcome: "Then", response: "Response", name: "Name", id: "Id" };

/** A problem as its card shows it: the rule's place is the card, so only the part of the rule is named. */
export function problemText(problem: string): string {
  const rule = /^rules\.[A-Za-z_][A-Za-z0-9_]*\.([a-z]+): (.*)$/s.exec(problem);
  if (rule) return `${PART[rule[1]!] ?? rule[1]}: ${rule[2]}`;
  return problem.replace(/^default\.outcome: /, "Then: ").replace(/^default\.response: /, "Response: ");
}

export function sampleInput(definition: RulesetDefinition): Record<string, unknown> {
  const sample: Record<string, unknown> = {};
  for (const input of definition.inputs) {
    if (input.default !== undefined) sample[input.name] = input.default;
    else if (input.type === "number") sample[input.name] = 0;
    else if (input.type === "boolean") sample[input.name] = false;
    else if (input.type === "list") sample[input.name] = [];
    else if (input.type === "object") sample[input.name] = {};
    else sample[input.name] = "";
  }
  return sample;
}

export const rulesetStatus = (r: Pick<RulesetSummary, "status" | "version" | "draft">) =>
  r.status === "archived" ? "Archived" : r.version === 0 ? "Draft" : r.draft ? "Draft changes" : "Published";
