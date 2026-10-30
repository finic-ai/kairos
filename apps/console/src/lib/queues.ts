import type {
  CaseCategory,
  CasePriority,
  CaseStatus,
  EntityColor,
  EntityIcon,
  IntakeOperator,
  QueueCorrelation,
  QueueDefinition,
} from "@kairos/core";
import type { Queue } from "../types/interfaces";
import { durationText, entityName } from "./format";

export const STATUS_LABEL: Record<CaseStatus, string> = {
  open: "Open",
  in_review: "In review",
  resolved: "Resolved",
};

export const PRIORITY_LABEL: Record<CasePriority, string> = {
  urgent: "Urgent",
  high: "High",
  normal: "Normal",
  low: "Low",
};

export const PRIORITY_TONE: Record<CasePriority, string> = { urgent: "warn", high: "warn", normal: "", low: "" };

export const CATEGORY_LABEL: Record<CaseCategory, string> = {
  approved: "Approved",
  blocked: "Blocked",
  confirmed_fraud: "Confirmed fraud",
  false_positive: "False positive",
  no_action: "No action needed",
};

export const COLUMN_LABEL: Record<string, string> = {
  target: "Case about",
  priority: "Priority",
  status: "Status",
  assignee: "Assignee",
  age: "Waiting",
  due: "Due",
  last_activity: "Last activity",
  outcome: "Worst outcome",
  risk: "Highest risk",
  evidence: "Triggers",
  reason: "Reason",
};

export const columnLabel = (column: string) =>
  COLUMN_LABEL[column] ?? column.split(".").slice(1).join(".").replaceAll("_", " ");

export const QUEUE_DISPLAY = (q: Pick<QueueDefinition, "display">): { icon: EntityIcon; color: EntityColor } => ({
  icon: q.display?.icon ?? "flag",
  color: q.display?.color ?? "blue",
});

/** "One case for each user, joined for 30 days": the correlation rule in words. */
export function correlationSentence(c: QueueCorrelation): string {
  const days = c.window_days ?? 30;
  const reopen = c.reopen_days
    ? ` A trigger within ${c.reopen_days} ${c.reopen_days === 1 ? "day" : "days"} after it is resolved reopens it.`
    : "";
  const join = ` Later triggers join it while it is open and was active in the last ${days} ${days === 1 ? "day" : "days"}.${reopen}`;
  switch (c.by) {
    case "subject":
      return `One case for each subject of a decision.${join}`;
    case "entity":
      return `One case for each ${c.type ? entityName(c.type) : "entity"} the decisions name.${join}`;
    case "request":
      return `One case for each value of the request's ${c.property ?? "property"}.${join}`;
    case "session":
      return "One case for each session.";
    case "event":
      return "One case for each event that starts a decision.";
  }
}

/** How long a case has waited, in words: "3 h", "2 d". */
export const ageText = (created: string, now = Date.now()) => durationText(Math.max(0, now - Date.parse(created)));

/** "in 3 h", or "2 h late" with `late` set. */
export function dueText(due: string, now = Date.now()): { text: string; late: boolean } {
  const ms = Date.parse(due) - now;
  return ms < 0 ? { text: `${durationText(-ms)} late`, late: true } : { text: `in ${durationText(ms)}`, late: false };
}

export interface FieldChoice {
  /** The kind of value the field takes, for the operators and the input. */
  kind: "outcome" | "score" | "signal" | "text" | "value";
  label: string;
}

/** The fields of a condition, as the form offers them. `signal.` and `request.` take a name after them. */
export const CONDITION_FIELDS: { value: string; label: string; kind: FieldChoice["kind"]; named?: boolean }[] = [
  { value: "decision.outcome", label: "Outcome", kind: "outcome" },
  { value: "decision.risk_score", label: "Risk score (0 to 100)", kind: "score" },
  { value: "signal.", label: "Signal score (0 to 1)", kind: "signal", named: true },
  { value: "decision.typology", label: "Typology", kind: "text" },
  { value: "request.", label: "Request property", kind: "value", named: true },
  { value: "event.type", label: "Event type", kind: "text" },
  { value: "event.", label: "Event property", kind: "value", named: true },
];

export const fieldChoice = (field: string) =>
  CONDITION_FIELDS.find((f) => (f.named ? field.startsWith(f.value) && field !== "event.type" : field === f.value)) ??
  CONDITION_FIELDS[0]!;

export const OPERATORS: Record<FieldChoice["kind"], [IntakeOperator, string][]> = {
  outcome: [["in", "is one of"]],
  text: [
    ["=", "is"],
    ["in", "is one of"],
  ],
  score: [
    [">=", "is at least"],
    [">", "is more than"],
    ["<=", "is at most"],
    ["<", "is less than"],
    ["between", "is between"],
  ],
  signal: [
    [">=", "is at least"],
    [">", "is more than"],
    ["<=", "is at most"],
    ["<", "is less than"],
    ["between", "is between"],
  ],
  value: [
    ["=", "is"],
    ["in", "is one of"],
    [">=", "is at least"],
    [">", "is more than"],
    ["<=", "is at most"],
    ["<", "is less than"],
    ["between", "is between"],
  ],
};

/** A queue as the API gives it, back to the definition a save takes. */
export function definitionOf(queue: Queue): QueueDefinition {
  const {
    id: _id,
    version: _version,
    owner: _owner,
    mine: _mine,
    can_manage: _manage,
    counts: _counts,
    ...rest
  } = queue;
  const { created: _created, updated: _updated, ...definition } = rest;
  return definition;
}

export const BLANK_QUEUE: QueueDefinition = {
  name: "",
  visibility: "workspace",
  enabled: true,
  sources: { actions: [] },
  intake: [
    {
      id: "needs_review",
      name: "Needs review",
      priority: "normal",
      conditions: { any: [{ field: "decision.outcome", op: "in", value: ["review", "step_up"] }] },
    },
  ],
  correlation: { by: "subject", window_days: 30, when_missing: "create" },
  columns: ["target", "priority", "status", "assignee", "outcome", "risk", "age"],
  sort: "oldest",
};

/** A rule id from its name: "Large payments" → "large_payments". */
export const ruleId = (name: string, taken: string[]) => {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/^(\d)/, "_$1")
      .slice(0, 48) || "rule";
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}_${n}`;
  return id;
};
