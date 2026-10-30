import type {
  CaseCategory,
  CasePriority,
  CaseStatus,
  CaseView,
  ColumnFormat,
  ConditionResult,
  Outcome,
  QueueDefinition,
  ViewBlock,
} from "@kairos/core";
import type { CaseActivityType, CaseItemKind, CaseResolution } from "../../db/schema";
import type { EntityRef, FactValue } from "../catalog/types";

/** The job kind that tests one decision against the intake rules of the queues. */
export const CASE_EVALUATE_KIND = "case.evaluate";

/** A case takes at most this many evidence records; past it, a new case starts and is linked. */
export const MAX_EVIDENCE = 200;

export interface QueueView extends QueueDefinition {
  id: string;
  version: number;
  owner: string | null;
  mine: boolean;
  /** This person can rename it, change who sees it, and delete it. */
  can_manage: boolean;
  counts?: {
    open: number;
    in_review: number;
    unassigned: number;
    overdue: number;
    open_decisions: number;
    mine: number;
  };
  created: string;
  updated: string;
}

export interface Assignee {
  id: string;
  email: string;
  name: string;
}

export interface CaseSummary {
  id: string;
  queue_id: string;
  status: CaseStatus;
  priority: CasePriority;
  assignee: Assignee | null;
  target: EntityRef;
  /** The target's display name, from the display fields of its type: in a queue's list and on a case. */
  target_name?: string | null;
  correlation_key: string | null;
  reason: string;
  outcome: Outcome | null;
  risk: number | null;
  evidence_count: number;
  last_evidence_at: string;
  last_activity: string;
  resolution: CaseResolution | null;
  due_at: string | null;
  created: string;
  /** The `request.<property>` and `subject.<property>` columns of the queue. */
  values?: Record<string, unknown>;
}

export interface EvidenceView {
  id: string;
  source: { type: "decision" | "event" | "workflow"; id: string };
  rule: { id: string; name: string; version: number } | null;
  snapshot: EvidenceSnapshot;
  correlation_key: string | null;
  ts: string;
  created: string;
}

/** What a trigger read when it made or joined a case. */
export interface EvidenceSnapshot {
  /** The sentence of the rule, as it was then. */
  rule?: string;
  conditions?: ConditionResult[];
  decision?: { id: string; action: string; outcome: Outcome; risk_score: number; signals: string[] };
  event?: { id: string; type: string };
  /** For a workflow: the step's reason, and where it ran. */
  reason?: string;
  workflow?: { name: string; run_id: string; step: string };
  request?: Record<string, unknown>;
}

export interface CaseItemView {
  kind: CaseItemKind;
  type: string | null;
  id: string;
  evidence_id: string;
  added: string;
}

export interface CaseActivityView {
  id: string;
  type: CaseActivityType;
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
  /** With the money format: the currency code, read from the field the view names when it names one. */
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
  /** "missing": the field has no value; "host_not_approved": the workspace did not approve its host. */
  state: "ready" | "missing" | "not_a_link" | "host_not_approved";
  /** The host of an address; none for a data address, which holds the file itself. */
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
  /** False: the queue has no layout of its own, and this is the standard layout. */
  custom: boolean;
  template?: string;
  header: ViewValue[];
  blocks: ResolvedBlock[];
}

export interface CaseDetail extends CaseSummary {
  queue: { id: string; name: string };
  /** "<type> <id>" → the display name of each entity of the case that has one. */
  names: Record<string, string>;
  evidence: EvidenceView[];
  items: CaseItemView[];
  activity: CaseActivityView[];
}

export interface CaseFilter {
  /** `unresolved`: open or in review. `open_decisions`: resolved, with a decision no one resolved that is not an approval. */
  status?: CaseStatus | "unresolved" | "open_decisions";
  /** Only the cases not resolved that were due before this time: the overdue ones. */
  overdueAt?: Date;
  priority?: CasePriority;
  /** A user id, or "none". */
  assignee?: string;
  q?: string;
  limit: number;
  offset: number;
}

export interface ResolveInput {
  category: CaseCategory;
  note?: string;
  /** Also resolve each decision of the case that has no resolution. Only with approved or blocked. */
  apply_to_decisions?: boolean;
  /** Also label the target: fraud_confirmed or cleared. Only with confirmed_fraud or false_positive. */
  label_target?: boolean;
}
