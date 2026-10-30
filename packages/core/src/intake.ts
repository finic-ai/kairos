/**
 * Queues and the rules that make their cases: the definition, its checks, and the test of one
 * rule. Pure, so the server, the queue test and the console run the same code.
 */
import { ENTITY_COLORS, ENTITY_ICONS, type EntityColor, type EntityIcon } from "./entities";
import type { Outcome } from "./types";
import { validateView, type CaseView } from "./views";

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const OUTCOMES: readonly Outcome[] = ["approve", "step_up", "review", "block"];

export const CASE_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type CasePriority = (typeof CASE_PRIORITIES)[number];

export const CASE_STATUSES = ["open", "in_review", "resolved"] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export const CASE_CATEGORIES = ["approved", "blocked", "confirmed_fraud", "false_positive", "no_action"] as const;
export type CaseCategory = (typeof CASE_CATEGORIES)[number];

export const CORRELATIONS = ["subject", "entity", "session", "event", "request"] as const;
export type CorrelationBy = (typeof CORRELATIONS)[number];

export const QUEUE_SORTS = ["oldest", "newest", "priority", "risk", "due"] as const;
export type QueueSort = (typeof QUEUE_SORTS)[number];

export const QUEUE_COLUMNS = [
  "target",
  "priority",
  "status",
  "assignee",
  "age",
  "due",
  "last_activity",
  "outcome",
  "risk",
  "evidence",
  "reason",
] as const;

export const INTAKE_OPERATORS = ["=", "in", ">", ">=", "<", "<=", "between"] as const;
export type IntakeOperator = (typeof INTAKE_OPERATORS)[number];

export const MAX_INTAKE_RULES = 10;
export const MAX_CONDITIONS = 20;
export const MAX_COLUMNS = 12;
export const MAX_WINDOW_DAYS = 90;
export const DEFAULT_WINDOW_DAYS = 30;
/** At most a year from a case's start to when it is due. */
export const MAX_DUE_HOURS = 8760;

/** One test of one field. `in` takes a list, `between` two numbers, the others one value. */
export interface IntakeCondition {
  field: string;
  op: IntakeOperator;
  value: unknown;
}

/** All or any of a list. A group can hold conditions and groups of conditions: two levels at most. */
export type IntakeGroup = { all: IntakeNode[] } | { any: IntakeNode[] };
export type IntakeNode = IntakeCondition | IntakeGroup;

export interface IntakeRule {
  /** Stable across edits: the evidence names it. */
  id: string;
  name: string;
  enabled?: boolean;
  priority?: CasePriority;
  conditions: IntakeGroup;
}

export interface QueueCorrelation {
  by: CorrelationBy;
  /** For `entity`: the entity type the key is, for example "application". */
  type?: string;
  /** For `request`: the property of the request or the event the key is. */
  property?: string;
  /** For `subject`, `entity` and `request`: how long a quiet case can still be joined. */
  window_days?: number;
  /** With no key: make a case that cannot be joined, or make none. */
  when_missing?: "create" | "skip";
  /** A trigger with the key of a case resolved in the last this many days reopens it, rather than opening a new case. */
  reopen_days?: number;
}

export interface QueueDisplay {
  icon?: EntityIcon;
  color?: EntityColor;
  /** The case layout of this queue. Without it, the standard layout. */
  view?: CaseView;
}

export interface QueueDefinition {
  name: string;
  description?: string;
  /** "private": only its owner sees it. "workspace": every member does. */
  visibility: "private" | "workspace";
  /** Disabled: no new cases, from rules or workflows. */
  enabled?: boolean;
  sources: { actions?: string[]; event_types?: string[] };
  intake: IntakeRule[];
  correlation: QueueCorrelation;
  columns?: string[];
  sort?: QueueSort;
  display?: QueueDisplay;
  /** For each priority, the hours from a case's start to when it is due. A priority with none has no due time. */
  due_hours?: Partial<Record<CasePriority, number>>;
}

/** What one rule can read: a decision with the request it was asked with, and the event that started it. */
export interface IntakeInput {
  decision?: {
    outcome: Outcome;
    risk_score: number;
    typology?: string;
    /** Every signal's probability from the model's answer, not only those over the threshold. */
    signals: Record<string, number>;
  };
  request?: Record<string, unknown>;
  event?: { type: string; properties: Record<string, unknown> };
}

export interface ConditionResult extends IntakeCondition {
  /** The value the condition read; undefined when the field is not there. */
  read: unknown;
  held: boolean;
}

export interface RuleResult {
  matched: boolean;
  conditions: ConditionResult[];
}

const isGroup = (node: IntakeNode): node is IntakeGroup =>
  typeof node === "object" && node !== null && ("all" in node || "any" in node);
const children = (group: IntakeGroup): IntakeNode[] => ("all" in group ? group.all : group.any);
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Every condition of a rule, in the order the form shows them. */
export function conditionsOf(group: IntakeGroup): IntakeCondition[] {
  return children(group).flatMap((node) => (isGroup(node) ? conditionsOf(node) : [node]));
}

/** Null for a path that is not a field. */
function fieldKind(
  field: string,
): { kind: "outcome" | "risk" | "signal" | "text" | "value"; source: "decision" | "event" } | null {
  if (field === "decision.outcome") return { kind: "outcome", source: "decision" };
  if (field === "decision.risk_score") return { kind: "risk", source: "decision" };
  if (field === "decision.typology") return { kind: "text", source: "decision" };
  if (field === "event.type") return { kind: "text", source: "event" };
  const [head, name, ...rest] = field.split(".");
  if (rest.length || !name || !NAME.test(name)) return null;
  if (head === "signal") return { kind: "signal", source: "decision" };
  if (head === "request") return { kind: "value", source: "decision" };
  if (head === "event") return { kind: "value", source: "event" };
  return null;
}

/** True when a rule reads a decision field, and so is tested only against decisions. */
export function needsDecision(rule: IntakeRule): boolean {
  return conditionsOf(rule.conditions).some((c) => fieldKind(c.field)?.source === "decision");
}

/** The value a rule, or a field of a case view, reads at a path: undefined when it is not there. */
export function readIntakeField(field: string, input: IntakeInput): unknown {
  if (field === "decision.outcome") return input.decision?.outcome;
  if (field === "decision.risk_score") return input.decision?.risk_score;
  if (field === "decision.typology") return input.decision?.typology;
  if (field === "event.type") return input.event?.type;
  const [head, name] = field.split(".") as [string, string];
  if (head === "signal") return input.decision?.signals[name];
  if (head === "request") return input.request?.[name];
  if (head === "event") return input.event?.properties[name];
  return undefined;
}

/** A missing value satisfies nothing; a numeric test of a value that is not a number is false. */
function holds(op: IntakeOperator, actual: unknown, expected: unknown): boolean {
  if (actual === undefined || actual === null) return false;
  switch (op) {
    case "=":
      return actual === expected;
    case "in":
      return Array.isArray(expected) && expected.includes(actual);
    case "between": {
      const [low, high] = Array.isArray(expected) ? expected : [];
      return isNumber(actual) && isNumber(low) && isNumber(high) && actual >= low && actual <= high;
    }
    default: {
      if (!isNumber(actual) || !isNumber(expected)) return false;
      return op === ">"
        ? actual > expected
        : op === ">="
          ? actual >= expected
          : op === "<"
            ? actual < expected
            : actual <= expected;
    }
  }
}

function test(group: IntakeGroup, input: IntakeInput, out: ConditionResult[]): boolean {
  // Every condition is tested, also after the answer is known, so the evidence shows each one.
  const results = children(group).map((node) => {
    if (isGroup(node)) return test(node, input, out);
    const value = readIntakeField(node.field, input);
    const held = holds(node.op, value, node.value);
    out.push({ ...node, read: value, held });
    return held;
  });
  return "all" in group ? results.length > 0 && results.every(Boolean) : results.some(Boolean);
}

/** A rule that reads a decision field never matches an input with no decision. */
export function evaluateRule(rule: IntakeRule, input: IntakeInput): RuleResult {
  const conditions: ConditionResult[] = [];
  const matched = test(rule.conditions, input, conditions);
  return { matched: matched && (!needsDecision(rule) || input.decision !== undefined), conditions };
}

/** The highest of the priorities, with `normal` for one that is not set, and for an empty list. */
export function highestPriority(priorities: (CasePriority | undefined)[]): CasePriority {
  const ranks = priorities.map((p) => CASE_PRIORITIES.indexOf(p ?? "normal"));
  return ranks.length ? CASE_PRIORITIES[Math.max(...ranks)]! : "normal";
}

export interface CorrelationInput {
  subject?: { type: string; id: string };
  /** Entity type → id: what the decision's request names, and what the event names. */
  entities: Record<string, string>;
  /** The properties of the request, then of the event. */
  properties: Record<string, unknown>;
  session?: string;
  /** The customer's id of the event the trigger is, or that started the decision. */
  event_id?: string;
}

/** The key a trigger carries for the queue's correlation rule, or null when the trigger has none. */
export function correlationKey(correlation: QueueCorrelation, input: CorrelationInput): string | null {
  switch (correlation.by) {
    case "subject":
      return input.subject ? `subject:${input.subject.type}:${input.subject.id}` : null;
    case "entity": {
      const id = correlation.type ? input.entities[correlation.type] : undefined;
      return id ? `entity:${correlation.type}:${id}` : null;
    }
    case "session":
      return input.session ? `session:${input.session}` : null;
    case "event":
      return input.event_id ? `event:${input.event_id}` : null;
    case "request": {
      const value = correlation.property ? input.properties[correlation.property] : undefined;
      return typeof value === "string" || isNumber(value) ? `request:${correlation.property}:${value}` : null;
    }
  }
}

/** The entity a case is about: the key's entity for `entity`, else the subject. */
export function caseTarget(
  correlation: QueueCorrelation,
  input: CorrelationInput,
): { type: string; id: string } | null {
  if (correlation.by === "entity" && correlation.type && input.entities[correlation.type])
    return { type: correlation.type, id: input.entities[correlation.type]! };
  return input.subject ?? null;
}

/** For `subject`, `entity` and `request`, the days a quiet case can be joined; none for the others. */
export function windowDays(correlation: QueueCorrelation): number | null {
  return correlation.by === "session" || correlation.by === "event"
    ? null
    : (correlation.window_days ?? DEFAULT_WINDOW_DAYS);
}

const words = (s: string) => s.replaceAll("_", " ");
const OUTCOME_WORDS: Record<Outcome, string> = {
  approve: "approve",
  step_up: "step-up",
  review: "review",
  block: "block",
};

function fieldWords(field: string): string {
  if (field === "decision.outcome") return "outcome";
  if (field === "decision.risk_score") return "risk score";
  if (field === "decision.typology") return "typology";
  if (field === "event.type") return "event type";
  const [head, name = ""] = field.split(".");
  if (head === "signal") return `the ${words(name)} signal`;
  if (head === "request") return `the request's ${words(name)}`;
  return `the event's ${words(name)}`;
}

const valueWords = (field: string, v: unknown) =>
  field === "decision.outcome" && typeof v === "string" && v in OUTCOME_WORDS
    ? OUTCOME_WORDS[v as Outcome]
    : typeof v === "string"
      ? words(v)
      : isNumber(v) && field.startsWith("signal.")
        ? v.toFixed(2)
        : String(v);

const orList = (items: string[]) =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;

/** "risk score is at least 80": one condition as people read it. */
export function conditionSentence(c: IntakeCondition): string {
  const name = fieldWords(c.field);
  const v = (x: unknown) => valueWords(c.field, x);
  switch (c.op) {
    case "=":
      return `${name} is ${v(c.value)}`;
    case "in":
      return `${name} is ${orList((Array.isArray(c.value) ? c.value : []).map(v))}`;
    case ">":
      return `${name} is more than ${v(c.value)}`;
    case ">=":
      return `${name} is at least ${v(c.value)}`;
    case "<":
      return `${name} is less than ${v(c.value)}`;
    case "<=":
      return `${name} is at most ${v(c.value)}`;
    case "between": {
      const [low, high] = Array.isArray(c.value) ? c.value : [];
      return `${name} is between ${v(low)} and ${v(high)}`;
    }
  }
}

/** A whole rule as one sentence: "outcome is review, or risk score is at least 80". */
export function ruleSentence(group: IntakeGroup): string {
  const join = "all" in group ? " and " : ", or ";
  const parts = children(group).map((node) => (isGroup(node) ? `(${ruleSentence(node)})` : conditionSentence(node)));
  const text = parts.join(join);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function conditionProblems(c: IntakeCondition, at: string): string[] {
  if (typeof c !== "object" || c === null) return [`${at}: a condition is an object of field, op and value`];
  const kind = fieldKind(String(c.field ?? ""));
  if (!kind)
    return [
      `${at}.field: "${String(c.field)}" is not a field. Use decision.outcome, decision.risk_score, decision.typology, signal.<code>, request.<property>, event.type or event.<property>`,
    ];
  if (!INTAKE_OPERATORS.includes(c.op)) return [`${at}.op must be one of ${INTAKE_OPERATORS.join(", ")}`];
  const numeric = c.op === ">" || c.op === ">=" || c.op === "<" || c.op === "<=" || c.op === "between";
  if ((kind.kind === "outcome" || kind.kind === "text") && numeric)
    return [`${at}.op: ${c.field} is compared with = or in, not ${c.op}`];
  if ((kind.kind === "risk" || kind.kind === "signal") && (c.op === "=" || c.op === "in"))
    return [`${at}.op: ${c.field} is a score; compare it with >, >=, <, <= or between`];

  const values = c.op === "in" || c.op === "between" ? c.value : [c.value];
  if (!Array.isArray(values) || values.length === 0)
    return [`${at}.value: ${c.op === "in" ? "a list of values" : "two numbers, low and high"} is needed`];
  if (
    c.op === "between" &&
    (values.length !== 2 || !isNumber(values[0]) || !isNumber(values[1]) || values[0] > values[1])
  )
    return [`${at}.value: between takes two numbers, the low one first`];
  if (c.op === "in" && values.length > 50) return [`${at}.value: at most 50 values`];
  const problems: string[] = [];
  for (const value of values) {
    if (kind.kind === "outcome" && !OUTCOMES.includes(value as Outcome))
      problems.push(`${at}.value: "${String(value)}" is not an outcome. Use ${OUTCOMES.join(", ")}`);
    else if (kind.kind === "risk" && !(isNumber(value) && value >= 0 && value <= 100))
      problems.push(`${at}.value: a risk score is a number from 0 to 100`);
    else if (kind.kind === "signal" && !(isNumber(value) && value >= 0 && value <= 1))
      problems.push(`${at}.value: a signal score is a probability from 0 to 1`);
    else if (kind.kind === "text" && typeof value !== "string") problems.push(`${at}.value: text is needed`);
    else if (kind.kind === "value" && numeric && !isNumber(value)) problems.push(`${at}.value: a number is needed`);
    else if (kind.kind === "value" && !["string", "number", "boolean"].includes(typeof value))
      problems.push(`${at}.value: text, a number, or true or false`);
  }
  return problems;
}

function groupProblems(group: IntakeGroup, at: string, depth: number, count: { n: number }): string[] {
  if (!isGroup(group) || ("all" in group && "any" in group))
    return [`${at}: a group has "all" or "any", with a list of conditions`];
  const list = children(group);
  if (!Array.isArray(list) || list.length === 0) return [`${at}: a group needs at least one condition`];
  const key = "all" in group ? "all" : "any";
  return list.flatMap((node, i) => {
    const here = `${at}.${key}[${i}]`;
    if (isGroup(node)) {
      if (depth >= 2) return [`${here}: groups go two levels deep at most`];
      return groupProblems(node, here, depth + 1, count);
    }
    count.n++;
    return conditionProblems(node, here);
  });
}

/** Returns a list of problems; empty when the definition is usable. */
export function validateQueue(q: QueueDefinition): string[] {
  const problems: string[] = [];
  if (typeof q !== "object" || q === null) return ["a queue definition is an object"];
  if (typeof q.name !== "string" || !q.name.trim() || q.name.length > 80) problems.push("name: 1 to 80 characters");
  if (q.description !== undefined && (typeof q.description !== "string" || q.description.length > 500))
    problems.push("description: text of at most 500 characters");
  if (q.visibility !== "private" && q.visibility !== "workspace")
    problems.push('visibility must be "private" or "workspace"');
  if (q.enabled !== undefined && typeof q.enabled !== "boolean") problems.push("enabled must be true or false");

  const sources = q.sources ?? {};
  for (const key of ["actions", "event_types"] as const) {
    const list = sources[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.some((n) => typeof n !== "string" || !NAME.test(n)))
      problems.push(`sources.${key} must be a list of names`);
    else if (new Set(list).size !== list.length) problems.push(`sources.${key}: a name is listed twice`);
  }
  if (sources.event_types?.length)
    problems.push("sources.event_types: intake on events with no decision is not built yet");

  if (!Array.isArray(q.intake)) problems.push("intake must be a list of rules");
  else {
    if (q.intake.length > MAX_INTAKE_RULES) problems.push(`intake: at most ${MAX_INTAKE_RULES} rules`);
    if (q.intake.length > 0 && !sources.actions?.length)
      problems.push("intake: a rule needs a source. Add the actions whose decisions it tests to sources.actions");
    const ids = new Set<string>();
    const names = new Set<string>();
    q.intake.forEach((rule, i) => {
      const at = `intake[${i}]`;
      if (!NAME.test(rule?.id ?? "")) problems.push(`${at}.id must match ^[A-Za-z_][A-Za-z0-9_]{0,63}$`);
      else if (ids.has(rule.id)) problems.push(`${at}.id: "${rule.id}" is used twice`);
      else ids.add(rule.id);
      if (typeof rule?.name !== "string" || !rule.name.trim() || rule.name.length > 80)
        problems.push(`${at}.name: 1 to 80 characters`);
      else if (names.has(rule.name.trim())) problems.push(`${at}.name: "${rule.name}" is used twice`);
      else names.add(rule.name.trim());
      if (rule?.enabled !== undefined && typeof rule.enabled !== "boolean")
        problems.push(`${at}.enabled must be true or false`);
      if (rule?.priority !== undefined && !CASE_PRIORITIES.includes(rule.priority))
        problems.push(`${at}.priority must be one of ${CASE_PRIORITIES.join(", ")}`);
      const count = { n: 0 };
      problems.push(...groupProblems(rule?.conditions, `${at}.conditions`, 1, count));
      if (count.n > MAX_CONDITIONS) problems.push(`${at}.conditions: at most ${MAX_CONDITIONS} conditions`);
    });
  }

  const c = q.correlation;
  if (typeof c !== "object" || c === null || !CORRELATIONS.includes(c.by))
    problems.push(`correlation.by must be one of ${CORRELATIONS.join(", ")}`);
  else {
    if (c.by === "entity" && !NAME.test(c.type ?? "")) problems.push("correlation.type: the entity type the key is");
    if (c.by !== "entity" && c.type !== undefined) problems.push(`correlation.type is only for "entity"`);
    if (c.by === "request" && !NAME.test(c.property ?? ""))
      problems.push("correlation.property: the request property the key is");
    if (c.by !== "request" && c.property !== undefined) problems.push(`correlation.property is only for "request"`);
    if (c.window_days !== undefined) {
      if (c.by === "session" || c.by === "event")
        problems.push(`correlation.window_days: a case by ${c.by} has no window`);
      else if (!Number.isInteger(c.window_days) || c.window_days < 1 || c.window_days > MAX_WINDOW_DAYS)
        problems.push(`correlation.window_days: a whole number from 1 to ${MAX_WINDOW_DAYS}`);
    }
    if (c.when_missing !== undefined && c.when_missing !== "create" && c.when_missing !== "skip")
      problems.push('correlation.when_missing must be "create" or "skip"');
    if (
      c.reopen_days !== undefined &&
      (!Number.isInteger(c.reopen_days) || c.reopen_days < 1 || c.reopen_days > MAX_WINDOW_DAYS)
    )
      problems.push(`correlation.reopen_days: a whole number from 1 to ${MAX_WINDOW_DAYS}`);
  }

  if (q.columns !== undefined) {
    if (!Array.isArray(q.columns)) problems.push("columns must be a list");
    else {
      if (q.columns.length > MAX_COLUMNS) problems.push(`columns: at most ${MAX_COLUMNS}`);
      for (const column of q.columns) {
        const [head, name, ...rest] = String(column).split(".");
        const path = (head === "request" || head === "subject") && name && NAME.test(name) && rest.length === 0;
        if (!(QUEUE_COLUMNS as readonly string[]).includes(column) && !path)
          problems.push(
            `columns: "${String(column)}" is not a column. Use ${QUEUE_COLUMNS.join(", ")}, request.<property> or subject.<property>`,
          );
      }
    }
  }
  if (q.due_hours !== undefined) {
    if (typeof q.due_hours !== "object" || q.due_hours === null || Array.isArray(q.due_hours))
      problems.push("due_hours must map a priority to a number of hours");
    else
      for (const [priority, hours] of Object.entries(q.due_hours)) {
        if (!CASE_PRIORITIES.includes(priority as CasePriority))
          problems.push(`due_hours.${priority}: not a priority. Use ${CASE_PRIORITIES.join(", ")}`);
        else if (!(isNumber(hours) && hours > 0 && hours <= MAX_DUE_HOURS))
          problems.push(`due_hours.${priority}: hours from more than 0 to ${MAX_DUE_HOURS}`);
      }
  }
  if (q.sort !== undefined && !QUEUE_SORTS.includes(q.sort))
    problems.push(`sort must be one of ${QUEUE_SORTS.join(", ")}`);

  const d = q.display;
  if (d !== undefined) {
    if (typeof d !== "object" || d === null || Array.isArray(d))
      problems.push("display must be an object of icon, color and view");
    else {
      if (d.icon !== undefined && !ENTITY_ICONS.includes(d.icon))
        problems.push(`display.icon must be one of ${ENTITY_ICONS.join(", ")}`);
      if (d.color !== undefined && !ENTITY_COLORS.includes(d.color))
        problems.push(`display.color must be one of ${ENTITY_COLORS.join(", ")}`);
      if (d.view !== undefined) problems.push(...validateView(d.view, "display.view"));
      const extra = Object.keys(d).filter((k) => k !== "icon" && k !== "color" && k !== "view");
      if (extra.length) problems.push(`display: only icon, color and view, not ${extra.join(", ")}`);
    }
  }
  return problems;
}

/** When a case of this priority, started at `start`, is due; null when the queue gives it no due time. */
export function dueAt(dueHours: QueueDefinition["due_hours"], priority: CasePriority, start: Date): Date | null {
  const hours = dueHours?.[priority];
  return hours ? new Date(start.getTime() + hours * 3_600_000) : null;
}
