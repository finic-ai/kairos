import { answerPaths, type AnswerFinding } from "@kairos/core";
import type { WorkflowDefinition, WorkflowInput, WorkflowStep } from "../types/interfaces";

export type StepIcon =
  | "condition"
  | "filter"
  | "loop"
  | "delay"
  | "return"
  | "answer"
  | "http"
  | "search"
  | "get"
  | "create"
  | "update"
  | "decide"
  | "assess"
  | "ask"
  | "score"
  | "case"
  | "ruleset"
  | "list";

export interface StepKind {
  type: string;
  label: string;
  /** What the step does, in the list of steps to add. */
  about: string;
  group: "Flow" | "Records" | "Decisions" | "Rules" | "Models" | "Cases" | "Integrations";
  icon: StepIcon;
  defaults: Record<string, unknown>;
}

export const STEP_KINDS: StepKind[] = [
  {
    type: "condition",
    label: "If / else",
    about: "Go one way or the other",
    group: "Flow",
    icon: "condition",
    defaults: { when: "", then: [], else: [] },
  },
  {
    type: "filter",
    label: "Filter",
    about: "Stop the run unless it passes",
    group: "Flow",
    icon: "filter",
    defaults: { when: "" },
  },
  {
    type: "loop",
    label: "Loop",
    about: "Run steps for each item of a list",
    group: "Flow",
    icon: "loop",
    defaults: { over: "", steps: [] },
  },
  { type: "delay", label: "Delay", about: "Wait, then go on", group: "Flow", icon: "delay", defaults: { for: "1h" } },
  {
    type: "return",
    label: "Return",
    about: "End the run, with its output",
    group: "Flow",
    icon: "return",
    defaults: { value: {} },
  },
  {
    type: "answer",
    label: "Answer",
    about: "Give the answer, and go on",
    group: "Flow",
    icon: "answer",
    defaults: { value: {} },
  },
  {
    type: "record.search",
    label: "Search records",
    about: "Find events, entities or decisions",
    group: "Records",
    icon: "search",
    defaults: { record: "object" },
  },
  {
    type: "record.get",
    label: "Get a record",
    about: "Read one record by its id",
    group: "Records",
    icon: "get",
    defaults: { record: "object" },
  },
  {
    type: "record.create",
    label: "Create a record",
    about: "Add an event, an entity or an entity type",
    group: "Records",
    icon: "create",
    defaults: { record: "object" },
  },
  {
    type: "record.update",
    label: "Update a record",
    about: "Change an entity, label it, or resolve a decision",
    group: "Records",
    icon: "update",
    defaults: { record: "object" },
  },
  {
    type: "decide",
    label: "Decide",
    about: "Ask an action for a decision",
    group: "Decisions",
    icon: "decide",
    defaults: { action: "", entities: {} },
  },
  {
    type: "ruleset",
    label: "Run a ruleset",
    about: "Approve or reject with your rules, with nothing saved",
    group: "Rules",
    icon: "ruleset",
    defaults: { ruleset: "", input: {} },
  },
  {
    type: "list.add",
    label: "Add to a list",
    about: "Put an item on a list that rules read",
    group: "Rules",
    icon: "list",
    defaults: { list: "", value: "" },
  },
  {
    type: "list.remove",
    label: "Remove from a list",
    about: "Take an item off a list",
    group: "Rules",
    icon: "list",
    defaults: { list: "", value: "" },
  },
  {
    type: "assess",
    label: "Get the model's decision",
    about: "What an action's model and thresholds say, with nothing saved",
    group: "Models",
    icon: "assess",
    defaults: {},
  },
  {
    type: "ask",
    label: "Ask a question",
    about: "Your own questions to the model: yes or no, one of a list, or a score",
    group: "Models",
    icon: "ask",
    defaults: {
      entity: { type: "user", id: "{{ trigger.entities.user }}" },
      questions: { question_1: { type: "yes_no", question: "" } },
    },
  },
  {
    type: "score",
    label: "Score with a model",
    about: "Turn values from the run, such as the model's answers, into one score",
    group: "Models",
    icon: "score",
    defaults: { model: "", features: {} },
  },
  {
    type: "case.create",
    label: "Create a case",
    about: "Put a case in a queue for a person",
    group: "Cases",
    icon: "case",
    defaults: {
      queue: "",
      entity: { type: "user", id: "{{ trigger.entities.user }}" },
      reason: "",
      priority: "normal",
    },
  },
  {
    type: "case.resolve",
    label: "Resolve a case",
    about: "Close a case with an outcome",
    group: "Cases",
    icon: "case",
    defaults: { case_id: "", category: "no_action" },
  },
  {
    type: "http",
    label: "HTTP request",
    about: "Call another service",
    group: "Integrations",
    icon: "http",
    defaults: { method: "POST", url: "" },
  },
];

export const STEP_GROUPS = ["Flow", "Records", "Decisions", "Rules", "Models", "Cases", "Integrations"] as const;

export const kindOf = (type: string): StepKind =>
  STEP_KINDS.find((k) => k.type === type) ?? {
    type,
    label: type,
    about: "",
    group: "Integrations",
    icon: "http",
    defaults: {},
  };

export const stepTypeLabel = (type: string) => kindOf(type).label;

export type FieldKind =
  | "text"
  | "expression"
  | "condition"
  | "template"
  | "json"
  | "list"
  | "number"
  | "select"
  | "entity"
  | "event"
  | "action"
  | "queue"
  | "boolean"
  | "questions"
  | "model"
  | "features"
  | "ruleset"
  | "listref";

export interface FieldDef {
  field: string;
  label: string;
  kind: FieldKind;
  hint?: string;
  options?: { value: string; label: string }[];
  placeholder?: string;
  modelKind?: "question" | "scoring";
}

export const RECORDS = [
  { value: "object", label: "Entity" },
  { value: "event", label: "Event" },
  { value: "decision", label: "Decision" },
  { value: "entity_type", label: "Entity type" },
  { value: "case", label: "Case" },
];

/** A case is read and searched as a record, and written only by the case steps. */
const RECORD: FieldDef = { field: "record", label: "Record", kind: "select", options: RECORDS };
const WRITABLE: FieldDef = { ...RECORD, options: RECORDS.filter((r) => r.value !== "case") };
const CASE_PRIORITY: FieldDef = {
  field: "priority",
  label: "Priority",
  kind: "select",
  options: [
    { value: "normal", label: "Normal" },
    { value: "low", label: "Low" },
    { value: "high", label: "High" },
    { value: "urgent", label: "Urgent" },
  ],
};
const ENTITY: FieldDef = { field: "entity", label: "Entity type", kind: "entity" };
const RECORD_ID: FieldDef = {
  field: "record_id",
  label: "Id",
  kind: "template",
  placeholder: "{{ trigger.entities.user }}",
};
const PROPERTIES: FieldDef = {
  field: "properties",
  label: "Properties",
  kind: "json",
  placeholder: '{ "tier": "gold" }',
};

const QUESTION_MODEL: FieldDef = {
  field: "model",
  label: "Model",
  kind: "model",
  modelKind: "question",
};

/** A record step's fields depend on the kind of record. */
export function fieldsOf(step: WorkflowStep): FieldDef[] {
  const record = String(step.record ?? "object");
  switch (step.type) {
    case "condition":
      return [{ field: "when", label: "If", kind: "condition", placeholder: "trigger.amount >= 1000" }];
    case "filter":
      return [
        {
          field: "when",
          label: "Go on only when",
          kind: "condition",
          placeholder: "steps.check.output.decision == 'block'",
          hint: "When it is false, the run ends here as filtered out.",
        },
      ];
    case "loop":
      return [
        {
          field: "over",
          label: "For each item of",
          kind: "expression",
          placeholder: "trigger.users",
          hint: "The steps inside read the item as item, and its place in the list as index. At most 1,000 items.",
        },
      ];
    case "delay":
      return [
        {
          field: "for",
          label: "Wait for",
          kind: "text",
          placeholder: "24h",
          hint: "A time such as 30s, 15m, 24h or 7d.",
        },
        {
          field: "until",
          label: "Or wait until",
          kind: "template",
          placeholder: "2026-11-01T09:00:00Z",
          hint: "Give one of the two.",
        },
      ];
    case "return":
    case "answer":
      return [
        {
          field: "value",
          label: step.type === "answer" ? "Answer" : "Output",
          kind: "json",
          placeholder: '{ "outcome": "{{ steps.ask.output.decision }}", "reasons": "{{ steps.ask.output.reasons }}" }',
          hint:
            (step.type === "answer"
              ? "The caller that waits gets this now, and the steps after it go on in the background. "
              : "What the run gives. A caller that waits gets it. The steps after this one do not run. ") +
            "In a decision workflow: an outcome (approve, step_up, review or block), with reasons, rules, risk_score or probability if you want.",
        },
      ];
    case "assess":
      return [
        {
          field: "action",
          label: "Action",
          kind: "action",
          hint: "Empty, in a decision workflow: the action it decides. Nothing is saved: the step gives what the model and the action's thresholds say.",
        },
        {
          field: "entities",
          label: "Entities",
          kind: "json",
          placeholder: '"{{ trigger.entities }}"',
          hint: "Empty: the decision request's.",
        },
        { field: "properties", label: "Properties", kind: "json", placeholder: '"{{ trigger.properties }}"' },
        QUESTION_MODEL,
      ];
    case "ask":
      return [
        {
          field: "entity",
          label: "About an entity",
          kind: "json",
          placeholder: '{ "type": "user", "id": "{{ trigger.entities.user }}" }',
          hint: "The model reads its history, links and labels, as for a decision. Empty: only the data.",
        },
        {
          field: "data",
          label: "Data",
          kind: "json",
          placeholder: '{ "message": "{{ trigger.body.text }}" }',
          hint: "Values from the run for the model to read, at most 32 KB.",
        },
        { field: "questions", label: "Questions", kind: "questions" },
        QUESTION_MODEL,
      ];
    case "ruleset":
      return [
        {
          field: "ruleset",
          label: "Ruleset",
          kind: "ruleset",
          hint: "A pinned version answers the same until you change it. The latest version changes when the ruleset is published.",
        },
        {
          field: "input",
          label: "Input",
          kind: "json",
          placeholder: '{ "amount": "{{ trigger.amount }}" }',
          hint: "A value or a template for each input of the ruleset.",
        },
      ];
    case "list.add":
      return [
        { field: "list", label: "List", kind: "listref" },
        { field: "value", label: "Item", kind: "template", placeholder: "{{ trigger.entities.payee }}" },
        { field: "note", label: "Note", kind: "template", placeholder: "Chargeback on {{ trigger.entity.id }}" },
        {
          field: "match",
          label: "Match",
          kind: "select",
          options: [
            { value: "", label: "The list's" },
            { value: "exact", label: "Is the item" },
            { value: "prefix", label: "Starts with" },
            { value: "suffix", label: "Ends with" },
            { value: "contains", label: "Contains" },
            { value: "word", label: "Contains as a word" },
          ],
        },
      ];
    case "list.remove":
      return [
        { field: "list", label: "List", kind: "listref" },
        { field: "value", label: "Item", kind: "template", placeholder: "{{ trigger.payee }}" },
      ];
    case "score":
      return [
        {
          field: "model",
          label: "Model",
          kind: "model",
          modelKind: "scoring",
          hint: "A pinned version gives the same scores until you change it. The latest version changes when a new one is uploaded.",
        },
        { field: "features", label: "Features", kind: "features" },
      ];
    case "http":
      return [
        {
          field: "method",
          label: "Method",
          kind: "select",
          options: ["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => ({ value: m, label: m })),
        },
        { field: "url", label: "URL", kind: "template", placeholder: "https://ops.example.com/hooks/kairos" },
        {
          field: "headers",
          label: "Headers",
          kind: "json",
          placeholder: '{ "Authorization": "Bearer {{ secrets.OPS_TOKEN }}" }',
        },
        { field: "query", label: "Query", kind: "json" },
        { field: "body", label: "Body", kind: "json", placeholder: '{ "user": "{{ trigger.entities.user }}" }' },
      ];
    case "decide":
      return [
        {
          field: "action",
          label: "Action",
          kind: "action",
        },
        { field: "entities", label: "Entities", kind: "json", placeholder: '"{{ event.entities }}"' },
        { field: "properties", label: "Properties", kind: "json", placeholder: '"{{ event.properties }}"' },
        { field: "session", label: "Session", kind: "template" },
      ];
    case "record.get":
      return record === "object"
        ? [RECORD, ENTITY, RECORD_ID]
        : record === "entity_type"
          ? [RECORD, { ...RECORD_ID, label: "Entity type", placeholder: "user" }]
          : record === "case"
            ? [RECORD, { ...RECORD_ID, label: "Case id", placeholder: "{{ steps.open.output.case_id }}" }]
            : [RECORD, RECORD_ID];
    case "record.search":
      if (record === "case")
        return [
          RECORD,
          { field: "queue", label: "In the queue", kind: "queue", hint: "Empty searches every queue." },
          {
            field: "status",
            label: "Status",
            kind: "select",
            options: [
              { value: "", label: "Any" },
              { value: "unresolved", label: "Not resolved" },
              { value: "open", label: "Open" },
              { value: "in_review", label: "In review" },
              { value: "resolved", label: "Resolved" },
            ],
          },
          {
            ...ENTITY,
            field: "item_type",
            label: "Holding an entity type",
            hint: "With the id: the cases that hold that entity.",
          },
          { ...RECORD_ID, field: "item_id", label: "Holding the id" },
          { field: "limit", label: "At most", kind: "number", placeholder: "50" },
        ];
      if (record === "event")
        return [
          RECORD,
          { ...ENTITY, label: "About an entity type", hint: "With the id: only the events about that entity." },
          { ...RECORD_ID, label: "About the id" },
          { field: "types", label: "Event types", kind: "list", hint: "Empty finds every type." },
          { field: "limit", label: "At most", kind: "number", placeholder: "50" },
        ];
      if (record === "decision")
        return [
          RECORD,
          { ...ENTITY, label: "About an entity type", hint: "With the id: only the decisions about that entity." },
          { ...RECORD_ID, label: "About the id" },
          { field: "action", label: "Action", kind: "action" },
          { field: "outcome", label: "Outcome", kind: "text", placeholder: "block" },
          { field: "limit", label: "At most", kind: "number", placeholder: "50" },
        ];
      if (record === "entity_type") return [RECORD];
      return [
        RECORD,
        ENTITY,
        { field: "q", label: "Search", kind: "template" },
        { field: "label", label: "With the label", kind: "text" },
        { field: "outcome", label: "Last outcome", kind: "text", placeholder: "block" },
        { field: "limit", label: "At most", kind: "number", placeholder: "50" },
      ];
    case "record.create":
      if (record === "event")
        return [
          WRITABLE,
          { field: "event_type", label: "Event type", kind: "event" },
          { ...RECORD_ID, hint: "Empty makes one from the run and the step, so a retry does not add it twice." },
          { field: "entities", label: "Entities", kind: "json", placeholder: '{ "user": "{{ trigger.user }}" }' },
          PROPERTIES,
          { field: "status", label: "Status", kind: "text" },
        ];
      if (record === "entity_type")
        return [WRITABLE, ENTITY, { field: "definition", label: "Definition", kind: "json" }];
      return [WRITABLE, ENTITY, RECORD_ID, PROPERTIES];
    case "record.update":
      if (record === "decision")
        return [
          WRITABLE,
          RECORD_ID,
          {
            field: "resolution",
            label: "Resolution",
            kind: "json",
            placeholder: '{ "outcome": "approve", "note": "Checked" }',
          },
        ];
      if (record === "entity_type")
        return [WRITABLE, ENTITY, { field: "definition", label: "Definition", kind: "json" }];
      return [
        WRITABLE,
        ENTITY,
        RECORD_ID,
        PROPERTIES,
        { field: "unset", label: "Remove properties", kind: "list" },
        { field: "add_label", label: "Add the label", kind: "text", placeholder: "needs_review" },
      ];
    case "case.create":
      return [
        { field: "queue", label: "Queue", kind: "queue" },
        {
          field: "entity",
          label: "About",
          kind: "json",
          placeholder: '{ "type": "user", "id": "{{ trigger.entities.user }}" }',
          hint: "The entity the case is about.",
        },
        { field: "reason", label: "Reason", kind: "template", placeholder: "Large first payment to a new payee" },
        CASE_PRIORITY,
        {
          field: "correlation",
          label: "Key",
          kind: "template",
          hint: "The value of the queue's key, such as an application id. Empty takes it from the entity, the run's event and the run's decisions.",
        },
        {
          field: "mode",
          label: "When an open case has the key",
          kind: "select",
          options: [
            { value: "add_or_create", label: "Add to it" },
            { value: "create", label: "Start a new case" },
          ],
        },
        {
          field: "links",
          label: "Also link",
          kind: "json",
          placeholder: '{ "decisions": [], "events": [], "entities": [] }',
          hint: "The run's decisions and its event are linked without being named.",
        },
      ];
    case "case.resolve":
      return [
        { field: "case_id", label: "Case id", kind: "template", placeholder: "{{ steps.open.output.case_id }}" },
        {
          field: "category",
          label: "Outcome",
          kind: "select",
          options: [
            { value: "no_action", label: "No action needed" },
            { value: "approved", label: "Approved" },
            { value: "blocked", label: "Blocked" },
            { value: "confirmed_fraud", label: "Confirmed fraud" },
            { value: "false_positive", label: "False positive" },
          ],
        },
        { field: "note", label: "Note", kind: "template" },
        {
          field: "apply_to_decisions",
          label: "Also resolve the case's open decisions",
          kind: "boolean",
          hint: "Only with approved or blocked. Each one sends decision.updated.",
        },
        {
          field: "label_target",
          label: "Also label the entity",
          kind: "boolean",
          hint: "Only with confirmed fraud (fraud_confirmed) or false positive (cleared).",
        },
      ];
    default:
      return [];
  }
}

export function stepSummary(step: WorkflowStep): string {
  const text = (field: string) => (typeof step[field] === "string" ? (step[field] as string) : "");
  const record = RECORDS.find((r) => r.value === step.record)?.label ?? "";
  switch (step.type) {
    case "condition":
    case "filter":
      return text("when");
    case "loop":
      return text("over") && `each of ${text("over")}`;
    case "delay":
      return text("for") ? `for ${text("for")}` : text("until") && `until ${text("until")}`;
    case "http":
      return text("url") && `${text("method") || "GET"} ${text("url")}`;
    case "decide":
      return text("action");
    case "return":
      return "End the run";
    case "answer":
      return "Answer, and go on";
    case "assess":
      return text("action") || "The action's model";
    case "score":
      return text("model");
    case "ruleset":
      return text("ruleset");
    case "list.add":
      return text("list") && `${text("value")} to ${text("list")}`;
    case "list.remove":
      return text("list") && `${text("value")} from ${text("list")}`;
    case "ask": {
      const asked = Object.values((step.questions ?? {}) as Record<string, { question?: string }>);
      return asked.length === 1 ? (asked[0]!.question ?? "") : `${asked.length} questions`;
    }
    case "case.create":
      return text("reason");
    case "case.resolve":
      return text("category").replaceAll("_", " ");
    default:
      return [record, text("event_type") || text("entity"), text("record_id")].filter(Boolean).join(" · ");
  }
}

export interface TriggerKind {
  type: string;
  label: string;
  about: string;
  group: "Events" | "Others";
}

export const TRIGGER_KINDS: TriggerKind[] = [
  {
    type: "record",
    label: "Record event",
    about: "An entity, an event or a decision changes in Kairos",
    group: "Events",
  },
  {
    type: "event",
    label: "App event",
    about: "An event of a type that your system sends",
    group: "Events",
  },
  { type: "manual", label: "Launch manually", about: "From the console or the API", group: "Others" },
  {
    type: "decision",
    label: "Decision request",
    about: "Makes an action's decisions: decide() runs this workflow",
    group: "Others",
  },
  { type: "scheduled", label: "On a schedule", about: "At set times", group: "Others" },
  { type: "webhook", label: "Webhook", about: "A call to the workflow's own URL", group: "Others" },
];

export const TRIGGER_GROUPS = ["Events", "Others"] as const;

/** The records a record trigger watches, and the changes of each, in the words the builder shows. */
export const RECORD_TRIGGERS: Record<string, { label: string; changes: [string, string][] }> = {
  entity: {
    label: "Entity",
    changes: [
      ["created", "is created"],
      ["updated", "is updated"],
      ["labelled", "gets a label"],
    ],
  },
  event: { label: "Event", changes: [["created", "is stored"]] },
  decision: {
    label: "Decision",
    changes: [
      ["created", "is made"],
      ["updated", "is resolved"],
    ],
  },
};

export function triggerSummary(workflow: Pick<WorkflowDefinition, "trigger">): string {
  const trigger = workflow.trigger;
  switch (trigger.type) {
    case "record": {
      const kind = RECORD_TRIGGERS[String(trigger.record)];
      const change = kind?.changes.find(([on]) => on === trigger.on)?.[1] ?? String(trigger.on ?? "");
      // "an" before a, e, i and o; "u" is often said "you", as in "a user".
      const a = (word: string) => `${/^[aeio]/i.test(word) ? "an" : "a"} ${word}`;
      if (trigger.record === "entity") return `When ${a(trigger.entity ? String(trigger.entity) : "entity")} ${change}`;
      if (trigger.record === "decision")
        return `When ${trigger.action ? `${a(String(trigger.action))} decision` : "a decision"} ${change}`;
      return `When an event ${change}`;
    }
    case "event":
      return trigger.event ? `On ${String(trigger.event)} events` : "On an app event";
    case "scheduled":
      return trigger.cron ? `On a schedule (${String(trigger.cron)})` : "On a schedule";
    case "webhook":
      return "On a webhook call";
    case "decision":
      return trigger.action ? `Decides ${String(trigger.action)}` : "Makes an action's decisions";
    default:
      return "Launched manually";
  }
}

export const countSteps = (steps: WorkflowStep[]): number =>
  steps.reduce(
    (n, s) =>
      n +
      1 +
      (["then", "else", "steps"] as const).reduce(
        (m, b) => m + (Array.isArray(s[b]) ? countSteps(s[b] as WorkflowStep[]) : 0),
        0,
      ),
    0,
  );

/** Run statuses in which a run can still change. */
export const RUN_OPEN = ["queued", "running", "waiting"];

export const RUN_STATUS_LABEL: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  waiting: "Waiting",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
  filtered: "Filtered out",
};

/** What the condition builder offers as fields: the paths a condition can read, where it is. */
export interface FieldContext {
  trigger: WorkflowDefinition["trigger"];
  /** The steps that run before the condition, whose output it can read. */
  earlier: WorkflowStep[];
  /** True inside a loop: `item` and `index` can be read. */
  inLoop: boolean;
  eventProperties: string[];
  entityTypes: string[];
}

const OUTPUTS: Record<string, string[]> = {
  decide: ["decision", "risk_score", "decision_id", "reasons"],
  assess: ["decision", "risk_score", "probability", "reasons", "typology"],
  score: ["score", "risk_score", "model", "missing", "invalid"],
  ruleset: ["outcome", "matched", "rule", "response"],
  "list.add": ["added"],
  "list.remove": ["removed"],
  http: ["status", "body"],
  "record.get": ["id", "type", "properties"],
  "record.search": [],
  "case.create": ["case_id", "created"],
  "case.resolve": ["case_id", "resolved", "resolution.category"],
  filter: ["passed"],
  condition: ["branch"],
};

/** The fields of the trigger, as `prefix` reads them (`event` in a trigger's condition, `trigger` in a step). */
function triggerFields(context: FieldContext, prefix: "event" | "trigger"): string[] {
  const { trigger, eventProperties, entityTypes } = context;
  const event = (base: string) => [
    `${base}.type`,
    `${base}.status`,
    ...eventProperties.map((p) => `${base}.properties.${p}`),
    ...entityTypes.map((t) => `${base}.entities.${t}`),
  ];
  if (trigger.type === "event") return event(prefix === "event" ? "event" : "trigger");
  if (trigger.type === "manual") return inputsOf(trigger).map((input) => `trigger.${input.name}`);
  if (trigger.type === "decision")
    return [
      ...entityTypes.map((t) => `trigger.entities.${t}`),
      ...eventProperties.map((p) => `trigger.properties.${p}`),
      "trigger.session",
      "trigger.event_id",
      "trigger.decision_id",
    ];
  if (trigger.type === "record") {
    if (trigger.record === "event") return event("trigger.event");
    if (trigger.record === "decision")
      return [
        "trigger.decision.action",
        "trigger.decision.decision.decision",
        "trigger.decision.decision.risk_score",
        "trigger.decision.final_outcome",
        "trigger.decision.resolution.outcome",
        "trigger.decision.subject.type",
        "trigger.decision.subject.id",
        "trigger.decision.automatic",
      ];
    return [
      "trigger.entity.type",
      "trigger.entity.id",
      ...(trigger.on === "labelled" ? ["trigger.label.label"] : []),
      ...(trigger.on === "updated" ? ["trigger.before"] : []),
    ];
  }
  return [];
}

export function conditionFields(context: FieldContext, where: "trigger" | "step"): string[] {
  const fields = triggerFields(context, where === "trigger" ? "event" : "trigger");
  if (where === "step") {
    for (const step of context.earlier) {
      for (const out of OUTPUTS[step.type] ?? []) fields.push(`steps.${step.id}.output.${out}`);
      if (step.type === "ask") fields.push(...askFields(step));
      if (step.type === "score" && step.features && typeof step.features === "object")
        fields.push(...Object.keys(step.features).map((name) => `steps.${step.id}.output.features.${name}`));
    }
    if (context.inLoop) fields.push("item", "index");
  }
  return [...new Set(fields)];
}

export const INPUT_TYPES: { value: WorkflowInput["type"]; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "boolean", label: "True or false" },
  { value: "entity", label: "Entity id" },
  { value: "list", label: "List" },
  { value: "object", label: "Object (JSON)" },
];

export const inputsOf = (trigger: WorkflowDefinition["trigger"]): WorkflowInput[] =>
  trigger.type === "manual" && Array.isArray(trigger.inputs) ? (trigger.inputs as WorkflowInput[]) : [];

export function inputProblems(trigger: WorkflowDefinition["trigger"]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const input of inputsOf(trigger)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(input.name ?? ""))
      problems.push(`The input "${input.name}" needs a name of letters, digits and _, starting with a letter.`);
    else if (seen.has(input.name)) problems.push(`Two inputs have the name "${input.name}".`);
    else seen.add(input.name);
  }
  return problems;
}

export interface AnswerCheck {
  problems: { step: string | null; message: string }[];
  /** The first delay that a caller would wait for: one before the answer. */
  delay: WorkflowStep | null;
  /** The steps that write, and run before the answer: a decision that fails keeps what they wrote. */
  writesBefore: Set<string>;
}

const ANSWER_PROBLEM: Record<AnswerFinding["kind"], string> = {
  delay_before_answer: "This delay comes before the answer, and the caller cannot wait for it.",
  answer_in_loop: "An Answer cannot be in a loop, which runs more than once.",
  second_answer: "The run already gave its answer on this path.",
};

/** The server's checks of a workflow's answers, for the builder: `waits` when a caller waits, `mustAnswer` for a decision workflow. */
export function checkAnswers(steps: WorkflowStep[], { waits = false, mustAnswer = false } = {}): AnswerCheck {
  const paths = answerPaths(steps);
  const problems: AnswerCheck["problems"] = paths.findings
    .filter((f) => waits || f.kind !== "delay_before_answer")
    .map((f) => ({ step: f.step.id, message: ANSWER_PROBLEM[f.kind] }));
  if (mustAnswer && steps.length > 0 && paths.answered !== "yes")
    problems.push({
      step: null,
      message:
        paths.answered === "no"
          ? "A decision workflow answers: add an Answer or a Return step."
          : "On some paths the workflow does not answer: end each path with an Answer or a Return step.",
    });
  const delay = paths.findings.find((f) => f.kind === "delay_before_answer");
  return {
    problems,
    delay: (delay?.step as WorkflowStep | undefined) ?? null,
    writesBefore: new Set(paths.writesBefore),
  };
}

/** What the next steps read of an "Ask a question" step: each answer, by its question's key. */
function askFields(step: WorkflowStep): string[] {
  const reads: Record<string, string[]> = {
    yes_no: ["value", "probability"],
    one_of: ["value"],
    any_of: ["values"],
    score: ["level", "value"],
  };
  return Object.entries((step.questions ?? {}) as Record<string, { type?: string }>).flatMap(([key, q]) =>
    (reads[q.type ?? ""] ?? []).map((part) => `steps.${step.id}.output.${key}.${part}`),
  );
}
