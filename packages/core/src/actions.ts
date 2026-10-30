import { validateTotals, type TotalDefinition } from "./totals";
import { DEFAULT_POLICY, type Policy, COMPARISONS, TOTAL_MEASURES } from "./policy";
import type { Question } from "./questions";

/**
 * A decision type that a customer defines: what is being decided, in plain language,
 * and how the answers map to an outcome. Nothing in the decision path is specific to
 * one action; everything specific lives in a definition like this.
 */
export interface ActionDefinition {
  /** The key of the action, used in `decide({ action })`: for example "bank_transfer". */
  name: string;
  /**
   * The name people see, for example "Bank Transfer". Optional: without it the key is shown
   * in title case. It is not shown to the model, so changing it is not a new version.
   */
  displayName?: string;
  /** Set by the store. A change to any wording is a new version, because it can change the answers. */
  version?: number;
  description?: string;
  /** Entity type whose history the decision reads, for example "user". */
  subject: string;
  /**
   * An event type that starts this action. When an event of this type is sent for a
   * decision, it is stored and decided in one step, with the event as the pending action.
   * Optional: without it, the action runs only when `decide` names it.
   *
   * With `{ event, status }` the action starts only for an event in one of those statuses:
   * decide on a transaction when it is "pending", not again when it is "completed".
   */
  trigger?: string | { event: string; status?: string | string[] };
  /**
   * Decide in the background on each tracked event that matches the trigger, with nobody
   * waiting: from `track()` with a secret key, and from inbound webhooks, never from a public
   * key. Only events that happened in the last hour; the decision goes out by webhook. Needs a
   * trigger. Not shown to the model, so a change is not a new version.
   */
  automatic?: boolean;
  /**
   * Set by the server: when `automatic` was turned on. Only events from then on are decided
   * automatically; the ones before were history when they came. A value sent with the action is ignored.
   */
  automaticSince?: string;
  /** The yes/no question. Yes must mean "hold this action". */
  hold: string;
  /** Optional: mutually exclusive explanations, code → description. Include one for "nothing wrong". */
  typologies?: Record<string, string>;
  /** Optional: signals to report, code → description. Each is judged independently. */
  reasons?: Record<string, string>;
  policy?: Partial<Policy>;
  context?: {
    /** Most recent events sent in full. Default 30. */
    recentEvents?: number;
    /** Reason codes at or above this probability are returned. Default 0.5. */
    reasonThreshold?: number;
    /**
     * Entity types that count as links between subjects, for example ["device", "payee"].
     * Default: every type. Leave out types that many unrelated subjects share, such as a
     * popular merchant, or a label on one subject will make all of them look connected.
     */
    linkTypes?: string[];
    /**
     * Sums over the subject's events to calculate for each decision, for example the money in
     * during the last seven days against a usual week. At most eight. See `TotalDefinition`.
     */
    totals?: TotalDefinition[];
  };
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const OUTCOMES = new Set(["approve", "step_up", "review", "block"]);

/** The action's trigger in one shape. `statuses` undefined means every status. */
export function triggerOf(action: ActionDefinition): { event: string; statuses?: string[] } | undefined {
  const t = action.trigger;
  if (typeof t === "string") return { event: t };
  if (!t || typeof t !== "object" || typeof t.event !== "string") return undefined;
  if (t.status === undefined) return { event: t.event };
  return { event: t.event, statuses: Array.isArray(t.status) ? t.status : [t.status] };
}

export function isTriggeredBy(action: ActionDefinition, eventType: string, status?: string): boolean {
  const t = triggerOf(action);
  if (!t || t.event !== eventType) return false;
  return !t.statuses || (status !== undefined && t.statuses.includes(status));
}

export function triggersOverlap(a: ActionDefinition, b: ActionDefinition): boolean {
  const x = triggerOf(a);
  const y = triggerOf(b);
  if (!x || !y || x.event !== y.event) return false;
  return !x.statuses || !y.statuses || x.statuses.some((s) => y.statuses!.includes(s));
}

export const actionRef = (action: ActionDefinition) => `${action.name}@${action.version ?? 0}`;

export function actionPolicy(action: ActionDefinition): Policy {
  return { ...DEFAULT_POLICY, ...action.policy, rules: action.policy?.rules ?? [] };
}

export function buildQuestions(action: ActionDefinition): Record<string, Question> {
  const questions: Record<string, Question> = { hold: { type: "noul", instructions: action.hold } };
  if (action.typologies) {
    questions.typology = {
      type: "choice",
      instructions: `What is the most likely explanation of the pending ${action.name.replaceAll("_", " ")}?`,
      options: action.typologies,
    };
  }
  if (action.reasons) {
    questions.reasons = {
      type: "multi_choice",
      instructions: `Which of these risk signals are present for the pending ${action.name.replaceAll("_", " ")}?`,
      options: action.reasons,
    };
  }
  return questions;
}

/** Returns a list of problems; empty when the definition is usable. */
export function validateAction(action: ActionDefinition): string[] {
  const problems: string[] = [];
  if (!NAME.test(action.name ?? "")) problems.push("name must match ^[A-Za-z_][A-Za-z0-9_]{0,63}$");
  if (!NAME.test(action.subject ?? "")) problems.push('subject must be an entity type such as "user"');
  if (!action.hold?.trim()) problems.push("hold must be a non-empty question");
  if (
    action.displayName !== undefined &&
    (typeof action.displayName !== "string" || !action.displayName.trim() || action.displayName.length > 80)
  ) {
    problems.push("displayName must be text of at most 80 characters");
  }
  if (action.automatic !== undefined && typeof action.automatic !== "boolean")
    problems.push("automatic must be true or false");
  if (action.automatic && action.trigger === undefined)
    problems.push("automatic needs a trigger: the event type that starts the action");
  if (action.trigger !== undefined) {
    const t = triggerOf(action);
    if (!t || !t.event.trim() || t.event.length > 128)
      problems.push("trigger must be an event type, or { event, status }");
    else if (t.statuses?.some((s) => typeof s !== "string" || !s.trim()))
      problems.push("trigger.status must be a status or a list of statuses");
  }

  for (const field of ["typologies", "reasons"] as const) {
    const options = action[field];
    if (options === undefined) continue;
    const entries = Object.entries(options);
    if (entries.length < 2 || entries.length > 255) problems.push(`${field} needs 2 to 255 options`);
    for (const [code, text] of entries) {
      if (!NAME.test(code)) problems.push(`${field}.${code}: code must match ^[A-Za-z_][A-Za-z0-9_]{0,63}$`);
      if (typeof text !== "string" || !text.trim()) problems.push(`${field}.${code}: description must not be blank`);
    }
    const seen = new Set(entries.map(([, text]) => String(text).toLowerCase().replace(/\s+/g, " ").trim()));
    if (seen.size !== entries.length) problems.push(`${field}: descriptions must be unique`);
  }

  problems.push(...validateTotals(action.context?.totals));

  const policy = actionPolicy(action);
  for (const key of ["block", "review"] as const) {
    if (typeof policy[key] !== "number" || policy[key] < 0 || policy[key] > 1)
      problems.push(`policy.${key} must be between 0 and 1`);
  }
  if (policy.block < policy.review) problems.push("policy.block must not be below policy.review");
  const ids = new Set<string>();
  for (const rule of policy.rules) {
    if (!rule.id || ids.has(rule.id)) problems.push(`policy.rules: "${rule.id}" needs a unique id`);
    ids.add(rule.id);
    if (!OUTCOMES.has(rule.outcome))
      problems.push(`policy.rules.${rule.id}: outcome must be approve, step_up, review or block`);
    if (!rule.allOf?.length && !rule.when?.length)
      problems.push(`policy.rules.${rule.id}: needs a reason code in allOf, or a condition on a total in when`);
    if (rule.when !== undefined && !Array.isArray(rule.when))
      problems.push(`policy.rules.${rule.id}: when must be a list of conditions`);
    for (const condition of Array.isArray(rule.when) ? rule.when : []) {
      const declared = (action.context?.totals ?? []).find((t) => t.name === condition?.total);
      const measure = condition?.is ?? "sum";
      const where = `policy.rules.${rule.id}`;
      if (!declared) problems.push(`${where}: "${condition?.total}" is not in context.totals`);
      else if (!(TOTAL_MEASURES as readonly string[]).includes(measure))
        problems.push(`${where}: is must be sum, events, times_usual or share_covered`);
      else if (measure === "times_usual" && !declared.usual)
        problems.push(`${where}: times_usual needs "usual" on the total "${declared.name}"`);
      else if (measure === "share_covered" && !declared.covers)
        problems.push(`${where}: share_covered needs "covers" on the total "${declared.name}"`);
      if (!(COMPARISONS as readonly string[]).includes(condition?.op))
        problems.push(`${where}: op must be >, >=, < or <=`);
      if (typeof condition?.value !== "number" || !Number.isFinite(condition.value))
        problems.push(`${where}: value must be a number`);
    }
    for (const code of rule.allOf ?? []) {
      if (!action.reasons || !(code in action.reasons))
        problems.push(`policy.rules.${rule.id}: "${code}" is not in reasons`);
    }
  }
  const threshold = action.context?.reasonThreshold;
  if (threshold !== undefined && (threshold < 0 || threshold > 1))
    problems.push("context.reasonThreshold must be between 0 and 1");
  const linkTypes = action.context?.linkTypes;
  if (linkTypes !== undefined && (!Array.isArray(linkTypes) || linkTypes.some((t) => !NAME.test(t)))) {
    problems.push("context.linkTypes must be a list of entity types");
  }
  const recent = action.context?.recentEvents;
  if (recent !== undefined && (!Number.isInteger(recent) || recent < 1 || recent > 500))
    problems.push("context.recentEvents must be 1 to 500");
  return problems;
}
