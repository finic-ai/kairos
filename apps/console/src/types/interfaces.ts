import type {
  CaseCategory,
  CasePriority,
  CaseStatus,
  CaseView,
  ColumnFormat,
  EntityDisplay,
  EntityFact,
  EntityList as ListDefinition,
  FactFormat,
  FactMeasure,
  ViewBlock,
  IntakeCondition,
  ModelVersionDefinition,
  QueueDefinition,
  WebhookMapping,
} from "@kairos/core";

export type Outcome = "approve" | "step_up" | "review" | "block";

export interface Decision {
  decision: Outcome;
  probability: number;
  risk_score: number;
  reasons: string[];
  typology?: string;
  rules: string[];
  action: string;
}

export interface EntityRef {
  type: string;
  id: string;
}

export interface DecisionSummary {
  id: string;
  ts: string;
  action: string;
  subject: EntityRef;
  decision: Decision;
  session?: string;
  /** 1, and one more for each change of the resolution. */
  revision?: number;
  /** A person's decision on it. The model's `decision` never changes. */
  resolution?: Resolution | null;
  /** What should happen now: the resolution's outcome when there is one, else the model's. */
  final_outcome?: Outcome;
  /** Made in the background from a tracked event, with nobody waiting. */
  automatic?: boolean;
  /** Where it came from. A decision workflow's decision has `decision_workflow` ("name@version") and `decision_run_id`. */
  metadata?: Record<string, unknown>;
  request?: { entities: Record<string, string>; properties: Record<string, unknown> };
}

export interface Resolution {
  outcome: "approve" | "block";
  note?: string;
  by: string;
  at: string;
}

export interface KairosEvent {
  ts: string;
  type: string;
  [property: string]: unknown;
}

export interface DecisionRecord extends DecisionSummary {
  event_id?: string;
  context: {
    subject: Record<string, unknown>;
    /** What happened in the session of the request, before the request. */
    this_session?: { started: string; started_before_this_action: string; events: number; steps: string[] } & Record<
      string,
      unknown
    >;
    totals?: Record<string, unknown>;
    baseline_of_older_events: {
      period: [string, string];
      events: number;
      activity_by_hour_band: Record<string, number>;
      event_types: Record<string, { count: number; last: string; fields?: Record<string, any> }>;
      rare_events: KairosEvent[];
    } | null;
    linked_entities?: Record<string, Record<string, any>>;
    recent_events: KairosEvent[];
    pending_action: Record<string, unknown>;
  };
  /** The model's answer. A decision workflow that did not ask the model has none. */
  raw: {
    id: string;
    answers: {
      hold: { probability: number };
      typology?: { value: string; probabilities: Record<string, number> };
      reasons?: { probabilities: Record<string, number> };
    };
    usage: { input_tokens: number };
  };
}

export interface TotalCondition {
  total: string;
  is?: "sum" | "events" | "times_usual" | "share_covered";
  op: ">" | ">=" | "<" | "<=";
  value: number;
}

export interface PolicyRule {
  id: string;
  allOf: string[];
  /** Exact comparisons on the action's totals that must all hold. */
  when?: TotalCondition[];
  outcome: Outcome;
}

export interface ActionDefinition {
  /** The key: what the code passes to decide(). */
  name: string;
  /** The name people see. Without it, the key in title case. */
  displayName?: string;
  version?: number;
  description?: string;
  subject: string;
  trigger?: string | { event: string; status?: string | string[] };
  /** Decide each matching event that a server or a webhook sends, in the background. Needs a trigger. */
  automatic?: boolean;
  /** Set by the server: when `automatic` was turned on. */
  automaticSince?: string;
  hold: string;
  typologies?: Record<string, string>;
  reasons?: Record<string, string>;
  policy?: { block?: number; review?: number; rules?: PolicyRule[] };
  context?: { recentEvents?: number; reasonThreshold?: number; linkTypes?: string[]; totals?: TotalDefinition[] };
}

export interface TotalDefinition {
  name: string;
  event: string;
  sum: string;
  where?: Record<string, string | number | boolean | (string | number | boolean)[]>;
  window?: string;
  usual?: string;
  covers?: string;
  by?: string;
}

export interface Stats {
  events: number;
  decisions: number;
  outcomes: Partial<Record<Outcome, number>>;
  actions: number;
}

export interface Label {
  label: string;
  ts: string;
  properties: Record<string, unknown>;
}

export interface Entity extends EntityRef {
  properties: Record<string, unknown>;
  first_seen: string | null;
  labels: Label[];
  events: StoredEvent[];
  decisions: DecisionSummary[];
  /** The sessions it was in, most recent first. */
  sessions: SessionSummary[];
}

export interface StoredEvent {
  id: string;
  type: string;
  ts: string;
  entities: Record<string, string>;
  properties: Record<string, unknown>;
  universal_id?: string;
  status?: string;
  session?: string;
}

export interface EventDetail extends StoredEvent {
  decision: { id: string; outcome: Outcome; risk_score: number } | null;
}

export interface SessionSummary {
  id: string;
  started: string;
  last_seen: string;
  events: number;
}

export interface SessionRow extends SessionSummary {
  decisions: number;
  /** The most severe outcome among its decisions, and the highest risk score. */
  outcome: Outcome | null;
  risk_score: number | null;
  /** Entity type → the ids its events name, a few of each. */
  entities: Record<string, string[]>;
}

/** One session: the events sent with the same `$session`, and the decisions made in it. */
export interface SessionDetail {
  id: string;
  started: string;
  last_seen: string;
  /** Entity type → the ids its events name. */
  entities: Record<string, string[]>;
  events: StoredEvent[];
  decisions: DecisionSummary[];
}

export interface EntitySummary {
  id: string;
  events: number;
  first_seen: string | null;
  last_seen: string | null;
  labels: string[];
  decision: Decision | null;
  properties: Record<string, unknown>;
}

export interface PropertyCondition {
  name: string;
  op: "eq" | "ne" | "contains" | "gt" | "lt" | "exists" | "missing";
  value: string;
}

export interface EntityFilters {
  q: string;
  /** A label name, "*" for any label, "!" for none. */
  label: string;
  /** An outcome, or "none". */
  outcome: string;
  risk_min: string;
  /** "24h", "7d", "30d". */
  active: string;
  sort: string;
  props: PropertyCondition[];
  page: number;
  size: number;
}

export interface EntityDefinition {
  type: string;
  kind?: string;
  description?: string;
  properties?: Record<string, string>;
  link?: boolean;
  display?: EntityDisplay;
  facts?: EntityFact[];
  lists?: ListDefinition[];
}

export interface FactValue {
  name: string;
  label: string;
  measure: FactMeasure;
  window: string;
  /** A number, or a time for `first` and `last`; null when no record counts. */
  value: number | string | null;
  format?: FactFormat;
  currency?: string;
  /** With `usual`: what one window usually held, and how many times that the value is. */
  usual?: number;
  times_usual?: number | null;
}

export type RowLink =
  { kind: "event" | "decision" | "case"; id: string } | { kind: "entity"; type: string; id: string };

export interface ListPage {
  name: string;
  label: string;
  columns: { field: string; label: string; format?: ColumnFormat; currency?: string }[];
  rows: { id: string; ts: string; link: RowLink; values: Record<string, unknown> }[];
  total: number;
}

export interface EntityShape {
  type: string;
  with_properties: number;
  sampled: number;
  properties: { name: string; seen: number; types: string[]; example: unknown }[];
  events: { type: string; count: number }[];
  labels: { label: string; count: number }[];
}

export interface EntityType {
  type: string;
  count: number;
  events: number;
  labelled: number;
  last_seen: string | null;
  definition?: EntityDefinition;
}

export interface EntityList {
  types: EntityType[];
  type: string | null;
  entities: EntitySummary[];
  /** Every entity that matches the filter. Absent when no type was asked for. */
  total?: number;
  next_offset: number | null;
}

export type MetricSource = "decisions" | "events" | "labels";

export type MetricMeasure = "count" | "unique" | "share" | "avg" | "sum";

export type TileView = "number" | "line" | "area" | "bar" | "stacked" | "hbar" | "table" | "list";

export type Interval = "hour" | "day" | "week";

export interface MetricQuery {
  source: MetricSource;
  measure: MetricMeasure;
  field?: string;
  filters: {
    action?: string;
    outcome?: string;
    final_outcome?: string;
    typology?: string;
    signal?: string;
    subject_label?: string;
    event_type?: string;
    property?: { name: string; value: string };
    label?: string;
    entity_type?: string;
  };
  group_by?: string;
}

export interface MetricResult {
  buckets: string[];
  series: { key: string; total: number; values: number[] }[];
  total: number;
  previous_total?: number;
  unit: "count" | "percent" | "number";
  truncated: boolean;
}

export interface MetricOptions {
  actions: string[];
  signals: string[];
  typologies: string[];
  event_types: string[];
  labels: string[];
  entity_types: string[];
  event_properties: { name: string; numeric: boolean }[];
}

export interface Tile {
  id: string;
  title: string;
  view: TileView;
  /** How many of the page's twelve columns the tile takes. */
  w: number;
  link?: "decisions" | "entities" | "actions" | "none";
  query: MetricQuery;
}

export type DashboardRange = "24h" | "7d" | "30d" | "90d";

export interface Dashboard {
  id: string;
  name: string;
  range: DashboardRange;
  /** "private": only its owner sees it. "workspace": every member does. */
  visibility: "private" | "workspace";
  mine: boolean;
  /** This person can rename it, change who sees it, and delete it. */
  can_manage: boolean;
  tiles: Tile[];
  created: string;
  updated: string;
}

export interface Usage {
  days_asked: number;
  since: string;
  days: { day: string; events: number; decisions: number; input_tokens: number }[];
  by_action: { action: string; decisions: number; input_tokens: number }[];
  by_event_type: { type: string; events: number }[];
  stored: { events: number; decisions: number; entities: number };
}

export type Role = "owner" | "admin" | "member";

export interface User {
  id: string;
  email: string;
  /** The display name, else the first and last name, else the start of the email address. */
  name: string;
  first_name: string | null;
  last_name: string | null;
  display_name: string | null;
  created: string;
}

export interface Environment {
  id: string;
  workspace_id: string;
  name: string;
  kind: "production" | "sandbox";
  created: string;
}

export interface Workspace {
  environments: Environment[];
  id: string;
  name: string;
  slug: string;
  status: "active" | "suspended";
  created: string;
  role: Role;
}

export interface Session {
  /** has_password is false for an account that signs in through Supabase or Cognito only. */
  user: User & { has_password: boolean };
  workspaces: Workspace[];
}

export interface AuthConfig {
  /** False with Cognito: Cognito keeps the passwords, and Kairos has no password form. */
  password: boolean;
  /** False when a new account needs an invite. */
  signup: boolean;
  supabase: { url: string; anon_key: string; providers: string[] } | null;
  /** Identity providers of the Cognito user pool that get a button, such as Google. */
  cognito: { providers: string[] } | null;
}

/** Two-factor authentication of a Cognito account. `enabled` is null until the person signs in again. */
export type MfaStatus =
  | { available: false; reason: "google" | "not_cognito" }
  | { available: true; enabled: boolean | null; reauth_required: boolean };

export interface Member extends User {
  role: Role;
  status: "active" | "suspended";
  joined: string;
}

export interface Invite {
  id: string;
  email: string;
  role: Role;
  created: string;
  expires: string;
}

/** One thing a person did in the workspace. */
export interface Activity {
  id: string;
  /** "<resource>.<verb>": "api_key.created". */
  action: string;
  resource_type: string;
  resource_id: string | null;
  details: Record<string, unknown>;
  environment_id: string | null;
  source: "dashboard" | "api_key" | "mcp";
  /** Null once the person deleted their account. */
  user: { id: string; name: string; email: string } | null;
  created: string;
}

export interface ActivityFilter {
  user?: string;
  resource?: string;
  q?: string;
  /** Days, as "2026-10-30". */
  from?: string;
  to?: string;
  after?: string;
  limit?: number;
}

export interface InviteInfo {
  email: string;
  role: Role;
  workspace_name: string;
  has_account: boolean;
}

export interface ApiKey {
  environment_id: string;
  id: string;
  name: string;
  kind: "secret" | "public";
  hint: string;
  allowed_ips: string[];
  /** Websites a public key may be used on. Empty means any. */
  allowed_origins: string[];
  created: string;
  last_used: string | null;
  revoked: string | null;
}

export type McpGroup = "read" | "write" | "decide" | "build";

export interface McpTool {
  name: string;
  title: string;
  group: McpGroup;
  description: string;
  read_only: boolean;
  destructive: boolean;
}

export interface McpSettings {
  enabled: boolean;
  groups: McpGroup[];
  tools: McpTool[];
}

export type WebhookEvent =
  | "decision.created"
  | "decision.updated"
  | "label.created"
  | "case.created"
  | "case.assigned"
  | "case.resolved"
  | "case.reopened";

/** An outgoing webhook: a URL that Kairos calls. Its secret is shown once and never again. */
export interface Webhook {
  id: string;
  direction: "in" | "out";
  name: string;
  url: string | null;
  events?: WebhookEvent[];
  filter?: { actions?: string[]; outcomes?: Outcome[]; min_risk_score?: number; labels?: string[]; queues?: string[] };
  include_properties?: boolean;
  /** Inbound: the preset it started from ("stripe@1"), how deliveries are verified, and the mapping. */
  preset?: string | null;
  verification?: Verification;
  mapping?: WebhookMapping;
  /** Inbound: the start and end of the URL token. */
  token_hint?: string | null;
  enabled: boolean;
  disabled_reason: string | null;
  failing_since: string | null;
  last_delivery: string | null;
  secret_hints: { hint: string; added: string; expires?: string }[];
  created: string;
  created_by: string | null;
  deliveries_24h?: number;
  failures_24h?: number;
}

export type Verification =
  | {
      scheme: "hmac";
      header: string;
      algorithm?: "sha256" | "sha1" | "sha512";
      encoding?: "hex" | "base64";
      prefix?: string;
    }
  | {
      scheme: "timestamped";
      header: string;
      timestampHeader?: string;
      timestampKey?: string;
      signatureKey?: string;
      join?: string;
      algorithm?: "sha256" | "sha1" | "sha512";
      encoding?: "hex" | "base64";
      tolerance?: number;
    }
  | { scheme: "stripe"; tolerance?: number }
  | { scheme: "standard"; tolerance?: number }
  | { scheme: "header"; header: string }
  | { scheme: "none" };

export interface WebhookPreset {
  provider: string;
  version: number;
  displayName: string;
  category:
    | "device_intelligence"
    | "identity_verification"
    | "payments"
    | "customer_support"
    | "transaction_intelligence"
    | "commerce";
  /** Whether a real delivery from the provider has gone through it. */
  checked: boolean;
  description: string;
  verification: Verification;
  secretHint?: string;
  setup: string[];
  identity?: string;
  events: string[];
  mapping: WebhookMapping;
  samples: unknown[];
  /** The request headers of each sample, in the same order. */
  sampleHeaders?: Record<string, string>[];
}

export interface SourceInput {
  name: string;
  verification: Verification;
  secret?: string;
  mapping: WebhookMapping;
  preset?: string;
}

export interface WebhookInput {
  name: string;
  url: string;
  events: WebhookEvent[];
  filter: { actions?: string[]; outcomes?: Outcome[]; min_risk_score?: number; labels?: string[]; queues?: string[] };
  include_properties: boolean;
}

export interface WebhookDelivery {
  id: string;
  webhook_id: string;
  status: "pending" | "delivered" | "failed" | (string & {});
  type: string | null;
  external_id: string | null;
  subject_ref: string | null;
  attempts: number;
  next_attempt: string | null;
  response_status: number | null;
  response_ms: number | null;
  problem: string | null;
  created: string;
  finished: string | null;
}

export interface WebhookDeliveryDetail extends WebhookDelivery {
  payload: unknown;
  headers: Record<string, string> | null;
  response_body: string | null;
  result: { events: number; duplicates: number; labels: number; event_ids: string[]; unresolved?: string[] } | null;
}

export interface WebhookTestResult {
  delivery: string;
  delivered: boolean;
  status: number | null;
  ms: number;
  problem: string | null;
  body: string | null;
}

export type CopyCategory = "entities" | "actions" | "events" | "dashboards" | "queues" | "decisions" | "models";

export interface CopySelection {
  ids?: string[];
  types?: string[];
  records?: EntityRef[];
}

export type EnvironmentCopyOptions = Record<CopyCategory, boolean | CopySelection>;

export interface CopyOption {
  id: string;
  label: string;
  detail: string;
  type: string | null;
}

export type CopyOptionCategory = CopyCategory | "entity_types" | "event_types";

/** One step of a workflow. The fields beyond `id`, `name` and `type` depend on the type. */
export interface WorkflowStep {
  id: string;
  name: string;
  type: string;
  [field: string]: unknown;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  displayName?: string;
  enabled: boolean;
  version: number;
  trigger: { type: string; [field: string]: unknown };
  steps: WorkflowStep[];
  /** Saved changes that are not published. Runs read the live version. */
  draft?: Pick<WorkflowDefinition, "trigger" | "steps">;
  /** "draft" until the first publish, then "published", or "archived". */
  status: "draft" | "published" | "archived";
  published_at?: string;
  /** When its runs started to fail. Absent while they do not fail. */
  failing_since?: string;
  /** The start and end of the token in the URL of its webhook trigger, once one is made. */
  hook?: { hint: string };
}

/** A workflow definition as it is saved: the server gives it the next version number. */
export type WorkflowDraft = Omit<
  WorkflowDefinition,
  "id" | "version" | "draft" | "status" | "published_at" | "failing_since" | "hook"
>;

export interface WorkflowVersionInfo {
  version: number;
  created: string;
  created_by: string | null;
}

export interface ExperimentRates {
  flagged: number;
  precision: number | null;
  recall: number | null;
}

export interface ExperimentSplitMetrics {
  rows: number;
  positives: number;
  roc_auc: number | null;
  pr_auc: number | null;
}

export type ExperimentMetric = "roc_auc" | "pr_auc";
export type FeatureTransform = "identity" | "logit";

export interface GbdtModel {
  type: "gbdt";
  features: string[];
  params?: Record<string, number>;
}

export type VariantModel =
  | GbdtModel
  | { type: "logistic"; features: string[]; transforms?: Record<string, FeatureTransform>; l2?: number }
  | {
      type: "stacked";
      base: GbdtModel;
      features: string[];
      transforms?: Record<string, FeatureTransform>;
      l2?: number;
    }
  | { type: "probability"; feature: string };

export interface ExperimentVariantConfig {
  key: string;
  name: string;
  description?: string;
  model: VariantModel;
  drop_steps?: string[];
}

export interface ExperimentResult {
  key: string;
  name: string;
  description: string;
  model: VariantModel;
  drop_steps: string[];
  /** Model references, such as "loan-review-stacked@1". */
  models: { model?: string; base?: string };
  metrics: {
    valid: ExperimentSplitMetrics;
    test: ExperimentSplitMetrics;
    gain: { vs: string; roc_auc: number | null; ci95: [number | null, number | null] } | null;
    thresholds: { review: number; block: number };
    at_review: ExperimentRates;
    at_block: ExperimentRates;
  };
  notes: Record<string, unknown>;
  /** Only in the full experiment, not in the list. */
  steps?: unknown[];
  problems: string[];
}

export interface Experiment {
  id: string;
  workflow: string;
  base_version: number | null;
  status: "queued" | "running" | "done" | "failed";
  error: string | null;
  config: {
    name?: string;
    hypothesis?: string;
    labels: string[];
    window: string;
    features: Record<string, unknown>;
    variants: ExperimentVariantConfig[];
    split: { train: number; valid: number };
    metric: ExperimentMetric;
    baseline?: string;
    review_rate: number;
    block_rate: number;
    model_prefix?: string;
    by?: string;
  };
  dataset: {
    rows: number;
    positives: number;
    from: string;
    to: string;
    labels: string[];
    window: string;
    split: { train: number; valid: number; test: number };
    export: Record<string, unknown>;
    metric: ExperimentMetric;
    baseline: string;
  } | null;
  results: ExperimentResult[] | null;
  /** The variant with the best validation metric. */
  best: string | null;
  selected: { variant: string; reason: string | null; by: string | null; at: string } | null;
  applied: { variant: string; version: number | null; published: boolean; at: string } | null;
  created_by: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

/** One entry of a run's step log. The log is the state of the run. */
export interface WorkflowRunStep {
  id: string;
  name: string;
  path: string;
  status: string;
  attempt?: number;
  output?: unknown;
  /** The step's fields with their templates filled in; an expression's step also has `reads`. */
  input?: Record<string, unknown> & { reads?: Record<string, unknown>; truncated?: boolean };
  /** What an ask or assess step showed the model: `{ model, context, questions? }`. */
  read?: { model?: string; context?: Record<string, unknown>; questions?: Record<string, { question?: string }> };
  error?: string;
  started?: string;
  finished?: string;
  /** A waiting delay: when it ends. */
  wake?: string;
}

/** One input of a manual trigger. The steps read it as `trigger.<name>`. */
export interface WorkflowInput {
  name: string;
  type: "text" | "number" | "boolean" | "entity" | "list" | "object";
  required?: boolean;
  label?: string;
  description?: string;
  /** For an `entity` input: the entity type. */
  entity?: string;
  default?: unknown;
}

export interface WorkflowRun {
  id: string;
  /** Null only for a test run of a workflow that was never saved. */
  workflow_id: string | null;
  /** The workflow and its version, as `name@version`. A test run is `name@0`. */
  workflow: string;
  status: string;
  trigger: Record<string, unknown>;
  steps: WorkflowRunStep[];
  /** What the run gave, once it is done: a Return step's value, else the output of the last step. */
  output?: unknown;
  error: string | null;
  test: boolean;
  /** The unsaved definition a test run ran. */
  definition?: Pick<WorkflowDefinition, "trigger" | "steps">;
  created: string;
  started: string | null;
  finished: string | null;
}

/** `pending` waits to run, or to run again after a failure. `paused` waits for its group, `dead` failed for good. */
export type JobStatus = "pending" | "paused" | "done" | "dead";

/** A unit of background work: a webhook delivery, a step of a workflow run, an automatic decision. */
export interface Job {
  id: string;
  kind: string;
  key: string;
  status: JobStatus;
  /** When it runs next: for a pending job that failed, the time of its retry. */
  run_at: string;
  attempts: number;
  last_error: string | null;
  created: string;
  updated: string;
  finished: string | null;
  /** Only on one job. */
  payload?: Record<string, unknown>;
}

export interface JobSummary {
  statuses: Record<JobStatus, number>;
  kinds: ({ kind: string } & Record<JobStatus, number>)[];
}

/** A list of work, with the rules that make its cases. See internal/designs/queues-and-cases.md. */
export interface Queue extends QueueDefinition {
  id: string;
  version: number;
  owner: string | null;
  mine: boolean;
  can_manage: boolean;
  counts?: {
    open: number;
    in_review: number;
    unassigned: number;
    overdue: number;
    /** Resolved cases with a decision that nobody resolved yet. */
    open_decisions: number;
    /** Not resolved, and assigned to you. */
    mine: number;
  };
  created: string;
  updated: string;
}

export interface CaseResolution {
  category: CaseCategory;
  note?: string;
  by: string;
  at: string;
}

export interface CaseSummary {
  id: string;
  queue_id: string;
  status: CaseStatus;
  priority: CasePriority;
  assignee: { id: string; email: string; name: string } | null;
  target: EntityRef;
  /** The target's display name, when its type has display fields and it has values for them. */
  target_name?: string | null;
  correlation_key: string | null;
  reason: string;
  outcome: Outcome | null;
  risk: number | null;
  evidence_count: number;
  last_evidence_at: string;
  last_activity: string;
  resolution: CaseResolution | null;
  /** From the queue's due times. Null when the queue sets none for the case's priority. */
  due_at: string | null;
  created: string;
  values?: Record<string, unknown>;
}

export interface CaseEvidence {
  id: string;
  source: { type: "decision" | "event" | "workflow"; id: string };
  rule: { id: string; name: string; version: number } | null;
  snapshot: {
    rule?: string;
    conditions?: (IntakeCondition & { read: unknown; held: boolean })[];
    decision?: { id: string; action: string; outcome: Outcome; risk_score: number; signals: string[] };
    event?: { id: string; type: string };
    reason?: string;
    workflow?: { name: string; run_id: string; step: string };
  };
  correlation_key: string | null;
  ts: string;
  created: string;
}

export interface CaseDecision {
  id: string;
  ts: string;
  action: string;
  subject: EntityRef;
  decision: { decision: Outcome; risk_score: number; reasons: string[]; typology?: string };
  event_id: string | null;
  session: string | null;
  resolution: Resolution | null;
  final_outcome: string;
}

export interface CaseItem {
  kind: "decision" | "event" | "entity" | "session" | "record";
  type: string | null;
  id: string;
  evidence_id: string;
  added: string;
}

export interface CaseActivity {
  id: string;
  type:
    | "created"
    | "evidence_added"
    | "assigned"
    | "status_changed"
    | "note"
    | "resolved"
    | "reopened"
    | "viewed"
    | "checked";
  actor: string;
  payload: Record<string, unknown>;
  created: string;
}

export interface ViewTemplate {
  name: string;
  label: string;
  description: string;
  view: CaseView;
}

export interface ViewValue {
  field: string;
  label: string;
  format?: ColumnFormat;
  currency?: string;
  value: unknown;
}

export interface ViewEntity {
  type: string;
  id: string;
  name: string | null;
  facts?: FactValue[];
  lists?: { name: string; label: string }[];
}

/** One image or document of a block, without its address: the page reads it through Kairos. */
export interface MediaItem {
  index: number;
  label: string;
  state: "ready" | "missing" | "not_a_link" | "host_not_approved";
  host?: string;
}

export interface CheckState {
  point: string;
  checked: boolean;
  by?: string;
  at?: string;
}

export type ResolvedBlock = ViewBlock & {
  values?: ViewValue[];
  entities?: ViewEntity[];
  media?: MediaItem[];
  checks?: CheckState[];
};

export interface CaseViewData {
  custom: boolean;
  template?: CaseView["template"];
  header: ViewValue[];
  blocks: ResolvedBlock[];
}

export interface CaseDetail extends CaseSummary {
  queue: { id: string; name: string };
  /** "<type> <id>" → the display name of each entity of the case that has one. */
  names: Record<string, string>;
  evidence: CaseEvidence[];
  items: CaseItem[];
  activity: CaseActivity[];
  decisions: CaseDecision[];
}

export type CaseStep =
  | { kind: "event"; ts: string; item: boolean; event: StoredEvent }
  | { kind: "decision"; ts: string; item: boolean; decision: CaseDecision };

export type { ModelVersionDefinition };

export interface BuiltinModel {
  slug: string;
  name: string;
  kind: "question";
  runtime: "builtin";
  status: "active";
}

export interface UploadedModel {
  slug: string;
  name: string;
  kind: "scoring";
  runtime: "in_process";
  status: "active" | "archived";
  version: number;
  definition: ModelVersionDefinition;
  created: string;
  updated: string;
  archived_at?: string;
}

export type ModelSummary = BuiltinModel | UploadedModel;

export interface ModelVersionInfo {
  version: number;
  created: string;
  created_by: string | null;
}

export type ModelDetail = BuiltinModel | (UploadedModel & { versions: ModelVersionInfo[] });

export interface ModelPromotion {
  model: UploadedModel;
  version: number;
  created: boolean;
  environment: string;
  reference: string;
}

export interface ModelScore {
  score: number;
  risk_score: number;
  model: string;
  features: Record<string, number | null>;
  missing: string[];
  invalid: string[];
}

export interface DecisionModelScore extends ModelScore {
  step: string;
}
