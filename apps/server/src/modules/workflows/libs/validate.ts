import {
  DECISION_OUTCOMES,
  MAX_DEPTH,
  MAX_RUN_DAYS,
  MAX_STEPS,
  MAX_WAIT_SECONDS,
  type WorkflowDefinitionDef,
  type WorkflowStepDef,
} from "../types";
import { answerProblems } from "./answers";
import { askQuestionProblems, CASE_CATEGORIES, CASE_PRIORITIES, cronProblem, isTimeZone } from "@kairos/core";
import { parseDuration, parseExpression } from "./expressions";
import { parseModelRef } from "../../models";
import { parseRulesetRef } from "../../rulesets";
import { inputsProblems } from "./inputs";

export const NO_SECRETS = "`secrets` is not available in a workflow: write the value in the step";
export const usesSecrets = (step: Record<string, unknown>) =>
  /\{\{\s*secrets\b/.test(JSON.stringify([step.url, step.headers, step.query, step.body]));

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const STEP_TYPES = new Set([
  "condition",
  "filter",
  "loop",
  "delay",
  "http",
  "record.search",
  "record.get",
  "record.create",
  "record.update",
  "decide",
  "assess",
  "ask",
  "score",
  "return",
  "answer",
  "case.create",
  "case.resolve",
  "ruleset",
  "list.add",
  "list.remove",
]);
const LIST_SLUG = /^[a-z][a-z0-9_]{0,63}$/;
const ITEM_MATCHES = ["exact", "prefix", "suffix", "contains", "word"];
const ACTION_REF = /^[A-Za-z_][A-Za-z0-9_]{0,63}(@[1-9][0-9]*)?$/;
const MAX_FEATURES = 500;
const RECORDS = new Set(["event", "object", "entity_type", "decision", "case"]);
/** One template, such as "{{ steps.open.output.case_id }}": its value is known only when the run reads it. */
const isTemplate = (value: unknown) => typeof value === "string" && /^\s*\{\{[\s\S]+\}\}\s*$/.test(value);
const RECORD_CHANGES: Record<string, string[]> = {
  entity: ["created", "updated", "labelled"],
  event: ["created"],
  decision: ["created", "updated"],
};

/** The problems with a definition, in the order a person meets them. Empty when it can be saved. */
export function validateWorkflow(definition: WorkflowDefinitionDef): string[] {
  const problems: string[] = [];
  if (!NAME.test(definition.name ?? "")) problems.push('name: must be a name such as "review_withdrawals"');
  const trigger = definition.trigger;
  if (!trigger || typeof trigger !== "object") problems.push("trigger: a workflow has one trigger");
  else if (!["manual", "event", "record", "scheduled", "webhook", "decision"].includes(trigger.type))
    problems.push(`trigger.type: unknown trigger "${String(trigger.type)}"`);
  else if (trigger.type === "manual") problems.push(...inputsProblems(trigger.inputs));
  else if (trigger.type === "decision") {
    if (typeof trigger.action !== "string" || !NAME.test(trigger.action))
      problems.push("trigger.action: the action whose decisions this workflow makes");
    const t = trigger.timeout_seconds;
    if (t !== undefined && !(typeof t === "number" && t >= 1 && t <= MAX_WAIT_SECONDS))
      problems.push(`trigger.timeout_seconds: from 1 to ${MAX_WAIT_SECONDS}`);
  } else if (trigger.type === "record") {
    const changes = RECORD_CHANGES[String(trigger.record)];
    if (!changes) problems.push("trigger.record: entity, event or decision");
    else if (!changes.includes(String(trigger.on)))
      problems.push(`trigger.on: for ${String(trigger.record)}, ${changes.join(" or ")}`);
  } else if (trigger.type === "event" && (typeof trigger.event !== "string" || !trigger.event))
    problems.push("trigger.event: the event type that starts the workflow");
  else if (trigger.type === "scheduled") {
    if (typeof trigger.cron !== "string" || !trigger.cron)
      problems.push("trigger.cron: the cron expression that starts the workflow");
    else {
      const problem = cronProblem(trigger.cron);
      if (problem) problems.push(`trigger.cron: ${problem}`);
    }
    if (trigger.timezone !== undefined && (typeof trigger.timezone !== "string" || !isTimeZone(trigger.timezone)))
      problems.push('trigger.timezone: a time zone such as "Europe/London"; empty is UTC');
  } else if (trigger.type === "webhook") {
    if (trigger.method !== undefined && !["GET", "POST", "PUT"].includes(String(trigger.method)))
      problems.push("trigger.method: GET, POST or PUT");
    if (
      trigger.idempotency_header !== undefined &&
      (typeof trigger.idempotency_header !== "string" || !trigger.idempotency_header)
    )
      problems.push("trigger.idempotency_header: the name of the header that holds the delivery's id");
  }
  // A `when` that cannot be read would start no run, and say nothing: it is refused here.
  if (trigger && typeof trigger === "object" && trigger.when !== undefined) {
    const problem =
      typeof trigger.when === "string" && trigger.when ? parseExpression(trigger.when) : "an expression is needed";
    if (problem) problems.push(`trigger.when: ${problem}`);
  }

  const deciding = trigger?.type === "decision";
  const ids = new Set<string>();
  const names = new Set<string>();
  let count = 0;
  const walk = (steps: unknown, depth: number, where: string) => {
    if (!Array.isArray(steps)) return problems.push(`${where}: must be a list of steps`);
    for (const raw of steps as WorkflowStepDef[]) {
      count++;
      const at = `${where}.${raw?.id ?? "?"}`;
      if (!raw || typeof raw !== "object") {
        problems.push(`${at}: a step is an object`);
        continue;
      }
      if (typeof raw.id !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw.id))
        problems.push(`${at}: id must be letters, digits and _`);
      else if (ids.has(raw.id)) problems.push(`${at}: the id "${raw.id}" is used by another step`);
      else ids.add(raw.id);
      if (typeof raw.name !== "string" || !raw.name || raw.name.length > 80)
        problems.push(`${at}: every step has a name of at most 80 characters`);
      else if (names.has(raw.name)) problems.push(`${at}: the name "${raw.name}" is used by another step`);
      else names.add(raw.name);
      if (!STEP_TYPES.has(raw.type)) {
        problems.push(`${at}: unknown step type "${String(raw.type)}"`);
        continue;
      }
      const modelRef = (required: boolean) => {
        if (raw.model === undefined && !required) return;
        if (typeof raw.model !== "string" || !parseModelRef(raw.model))
          problems.push(`${at}.model: a model's slug, or a slug and a version such as "loan-default@2"`);
      };
      const expression = (field: string) => {
        const value = raw[field];
        if (typeof value !== "string" || !value) problems.push(`${at}.${field}: an expression is needed`);
        else {
          const problem = parseExpression(value);
          if (problem) problems.push(`${at}.${field}: ${problem}`);
        }
      };
      if (raw.type === "condition") {
        expression("when");
        if (depth >= MAX_DEPTH) problems.push(`${at}: conditions and loops nest at most ${MAX_DEPTH} levels`);
        else (walk(raw.then, depth + 1, `${at}.then`), walk(raw.else ?? [], depth + 1, `${at}.else`));
      } else if (raw.type === "filter") expression("when");
      else if (raw.type === "loop") {
        expression("over");
        if (depth >= MAX_DEPTH) problems.push(`${at}: conditions and loops nest at most ${MAX_DEPTH} levels`);
        else walk(raw.steps, depth + 1, `${at}.steps`);
      } else if (raw.type === "delay") {
        const has = (f: string) => typeof raw[f] === "string" && raw[f];
        if (has("for") === has("until"))
          problems.push(`${at}: a delay has "for" (a time such as "24h") or "until" (a time)`);
        else if (has("for")) {
          const ms = parseDuration(String(raw.for));
          if (ms === null) problems.push(`${at}.for: a time such as 30s, 15m, 24h or 7d`);
          else if (ms > MAX_RUN_DAYS * 86_400_000) problems.push(`${at}.for: a run lasts at most ${MAX_RUN_DAYS} days`);
        }
      } else if (raw.type === "http") {
        if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(String(raw.method ?? "GET").toUpperCase()))
          problems.push(`${at}.method: GET, POST, PUT, PATCH or DELETE`);
        if (typeof raw.url !== "string" || !raw.url) problems.push(`${at}.url: the address to call`);
        if (usesSecrets(raw)) problems.push(`${at}: ${NO_SECRETS}`);
      } else if (raw.type.startsWith("record.")) {
        if (!RECORDS.has(String(raw.record)))
          problems.push(`${at}.record: event, object, entity_type, decision or case`);
        if (raw.type === "record.get" && typeof raw.record_id !== "string")
          problems.push(`${at}.record_id: the record to read`);
        if (raw.type === "record.create" && raw.record === "decision")
          problems.push(`${at}: a decision is made by a decide step, not created as a record`);
        if (raw.type === "record.update" && raw.record === "event") problems.push(`${at}: events do not change`);
        // The case steps are the only writers of a case, so its evidence, items and activity are written with it.
        if (raw.type === "record.create" && raw.record === "case")
          problems.push(`${at}: a case is made by a case.create step, not created as a record`);
        if (raw.type === "record.update" && raw.record === "case")
          problems.push(`${at}: a case is resolved by a case.resolve step, not updated as a record`);
      } else if (raw.type === "case.create") {
        if (typeof raw.queue !== "string" || !raw.queue) problems.push(`${at}.queue: the id of the queue`);
        const entity = raw.entity as { type?: unknown; id?: unknown } | undefined;
        if (
          !isTemplate(raw.entity) &&
          (!entity || typeof entity !== "object" || typeof entity.type !== "string" || entity.id === undefined)
        )
          problems.push(`${at}.entity: the entity the case is about, as { "type": "user", "id": "{{ … }}" }`);
        if (typeof raw.reason !== "string" || !raw.reason.trim() || raw.reason.length > 500)
          problems.push(`${at}.reason: what the reviewer reads, at most 500 characters`);
        if (
          raw.priority !== undefined &&
          !(CASE_PRIORITIES as readonly string[]).includes(String(raw.priority)) &&
          !isTemplate(raw.priority)
        )
          problems.push(`${at}.priority: ${CASE_PRIORITIES.join(", ")}`);
        if (raw.mode !== undefined && raw.mode !== "add_or_create" && raw.mode !== "create")
          problems.push(`${at}.mode: add_or_create or create`);
      } else if (raw.type === "case.resolve") {
        if (typeof raw.case_id !== "string" || !raw.case_id) problems.push(`${at}.case_id: the case to resolve`);
        const category = String(raw.category);
        if (!(CASE_CATEGORIES as readonly string[]).includes(category) && !isTemplate(raw.category))
          problems.push(`${at}.category: ${CASE_CATEGORIES.join(", ")}`);
        if (raw.apply_to_decisions === true && !["approved", "blocked"].includes(category))
          problems.push(`${at}.apply_to_decisions: only with approved or blocked`);
        if (raw.label_target === true && !["confirmed_fraud", "false_positive"].includes(category))
          problems.push(`${at}.label_target: only with confirmed_fraud or false_positive`);
      } else if (raw.type === "score") {
        modelRef(true);
        const features = raw.features;
        if (!features || typeof features !== "object" || Array.isArray(features))
          problems.push(`${at}.features: an object with a value or a template for each feature of the model`);
        else {
          const entries = Object.entries(features);
          if (entries.length === 0) problems.push(`${at}.features: the model has at least one feature`);
          if (entries.length > MAX_FEATURES) problems.push(`${at}.features: at most ${MAX_FEATURES}`);
          const bad = entries.filter(([, v]) => v !== null && !["number", "boolean", "string"].includes(typeof v));
          if (bad.length)
            problems.push(
              `${at}.features: ${bad.map(([k]) => k).join(", ")}: a number, true or false, null, or a template`,
            );
          for (const [name, value] of entries) {
            if (!isTemplate(value)) continue;
            const problem = parseExpression(String(value).trim().slice(2, -2));
            if (problem) problems.push(`${at}.features.${name}: ${problem}`);
          }
        }
      } else if (raw.type === "assess") {
        modelRef(false);
        if (raw.action) {
          if (typeof raw.action !== "string" || !ACTION_REF.test(raw.action))
            problems.push(`${at}.action: an action name, or a name and a version such as "withdrawal@3"`);
        } else if (!deciding) problems.push(`${at}.action: the action whose model to ask`);
      } else if (raw.type === "ask") {
        modelRef(false);
        problems.push(...askQuestionProblems(raw.questions, `${at}.questions`));
        if (raw.entity === undefined && raw.data === undefined)
          problems.push(`${at}: give the model something to read: an entity, data, or both`);
        const entity = raw.entity as { type?: unknown; id?: unknown } | undefined;
        if (
          entity !== undefined &&
          !isTemplate(entity) &&
          (typeof entity !== "object" || entity === null || typeof entity.type !== "string" || entity.id === undefined)
        )
          problems.push(`${at}.entity: { "type": "user", "id": "{{ … }}" }`);
        if (
          raw.data !== undefined &&
          !isTemplate(raw.data) &&
          (typeof raw.data !== "object" || Array.isArray(raw.data))
        )
          problems.push(`${at}.data: an object, or a template that gives one`);
      } else if (raw.type === "answer" || raw.type === "return") {
        // A value made by a template is checked when the run gives it.
        const value = raw.value as { outcome?: unknown } | undefined;
        if (deciding && value !== undefined && typeof value === "object" && value !== null && !Array.isArray(value)) {
          const outcome = value.outcome;
          if (outcome === undefined) problems.push(`${at}.value.outcome: ${DECISION_OUTCOMES.join(", ")}`);
          else if (
            typeof outcome !== "string" ||
            (!outcome.includes("{{") && !(DECISION_OUTCOMES as readonly string[]).includes(outcome))
          )
            problems.push(`${at}.value.outcome: ${DECISION_OUTCOMES.join(", ")}, or a template that gives one`);
        } else if (deciding && value === undefined)
          problems.push(`${at}.value: the answer, with its outcome: ${DECISION_OUTCOMES.join(", ")}`);
      } else if (raw.type === "ruleset") {
        if (typeof raw.ruleset !== "string" || !parseRulesetRef(raw.ruleset))
          problems.push(`${at}.ruleset: a ruleset's slug, or a slug and a version such as "high_risk_payout@2"`);
        if (
          raw.input !== undefined &&
          !isTemplate(raw.input) &&
          (!raw.input || typeof raw.input !== "object" || Array.isArray(raw.input))
        )
          problems.push(`${at}.input: an object with a value or a template for each input, or one template`);
        else if (raw.input && typeof raw.input === "object")
          for (const [name, value] of Object.entries(raw.input as Record<string, unknown>)) {
            if (!isTemplate(value)) continue;
            const problem = parseExpression(String(value).trim().slice(2, -2));
            if (problem) problems.push(`${at}.input.${name}: ${problem}`);
          }
      } else if (raw.type === "list.add" || raw.type === "list.remove") {
        if (typeof raw.list !== "string" || !LIST_SLUG.test(raw.list)) problems.push(`${at}.list: the slug of a list`);
        if (raw.value === undefined || raw.value === null || raw.value === "")
          problems.push(`${at}.value: the item, or a template that gives it`);
        if (raw.match !== undefined && !ITEM_MATCHES.includes(String(raw.match)))
          problems.push(`${at}.match: ${ITEM_MATCHES.join(", ")}`);
        if (raw.case_sensitive !== undefined && typeof raw.case_sensitive !== "boolean")
          problems.push(`${at}.case_sensitive: true or false`);
      } else if (raw.type === "decide") {
        if (deciding && String(raw.action ?? "").split("@")[0] === trigger.action)
          problems.push(
            `${at}: a Decide step for "${String(trigger.action)}" would start this workflow again: use a Get the model's decision step`,
          );
        if (typeof raw.action !== "string" || !ACTION_REF.test(raw.action))
          problems.push(`${at}.action: an action name, or a name and a version such as "withdrawal@3"`);
        // An object, or one template that gives one, such as "{{ event.entities }}".
        const template = typeof raw.entities === "string" && /^\s*\{\{[\s\S]+\}\}\s*$/.test(raw.entities);
        if (!template && (!raw.entities || typeof raw.entities !== "object" || Array.isArray(raw.entities)))
          problems.push(`${at}.entities: the entities to decide about, or a template such as "{{ event.entities }}"`);
      }
      const retry = raw.retry as { attempts?: unknown } | undefined;
      if (
        retry !== undefined &&
        (typeof retry !== "object" || retry === null || !(Number(retry.attempts) >= 1 && Number(retry.attempts) <= 5))
      )
        problems.push(`${at}.retry.attempts: between 1 and 5`);
      if (raw.on_fail !== undefined && raw.on_fail !== "fail" && raw.on_fail !== "continue")
        problems.push(`${at}.on_fail: "fail" or "continue"`);
    }
  };
  walk(definition.steps, 0, "steps");
  if (!Array.isArray(definition.steps) || definition.steps.length === 0)
    problems.push("steps: a workflow has at least one step");
  if (count > MAX_STEPS) problems.push(`steps: at most ${MAX_STEPS} steps in one workflow`);
  if (Array.isArray(definition.steps))
    problems.push(...answerProblems(definition.steps, { waits: deciding, mustAnswer: deciding }));
  return problems;
}
