import type {
  ColumnFormat,
  EntityDefinition,
  EntityFilters,
  FactFormat,
  FactMeasure,
  FactSource,
  ListSource,
} from "@kairos/core";

export interface EntityRef {
  type: string;
  id: string;
}

export interface StoredObject extends EntityRef {
  properties: Record<string, unknown>;
  /** Provenance about the row: who or what wrote it, and how. Not a property of the entity. */
  metadata: Record<string, unknown>;
  first_seen: string;
  updated: string;
}

export interface StoredLabel {
  label: string;
  ts: string;
  properties: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export type LabelCounts = Record<string, number>;

export interface LinkSummary {
  first_seen: string | null;
  /** All time. Capped at `limit + 1`, so a value above the limit means "more than". */
  others: number;
  /** All time, among `others`. Empty when `others` is above the limit. */
  labels: LabelCounts;
  recent: {
    /** Capped at `recentLimit + 1`. Above the cap, the other numbers describe a sample of that size. */
    others: number;
    new: number;
    last_day: number;
    last_day_new: number;
    near: number;
    near_new: number;
    labels: LabelCounts;
  };
}

export interface LinkQuery {
  /** The decision time: nothing after it is counted. */
  until: string;
  since: string;
  day: string;
  near: string;
  limit: number;
  recentLimit: number;
}

export interface EntityShape {
  type: string;
  with_properties: number;
  sampled: number;
  properties: { name: string; seen: number; types: string[]; example: unknown }[];
  events: { type: string; count: number }[];
  labels: { label: string; count: number }[];
}

export interface EntityTypeSummary {
  type: string;
  count: number;
  events: number;
  labelled: number;
  last_seen: string | null;
  definition?: EntityDefinition;
}

export interface EntitySummary {
  id: string;
  events: number;
  first_seen: string | null;
  last_seen: string | null;
  labels: string[];
  decision: unknown | null;
  properties: Record<string, unknown>;
}

export interface EntityFilter {
  type: string;
  q?: string;
  labelled?: boolean;
  label?: string;
  outcome?: string;
  risk_min?: number;
  active_since?: string;
  properties?: PropertyCondition[];
  sort?: "active" | "events" | "risk" | "first_seen";
  limit: number;
  offset: number;
}

export interface PropertyCondition {
  name: string;
  op: "eq" | "ne" | "contains" | "gt" | "lt" | "exists" | "missing";
  value?: string;
}

/** One fact of one entity, over [from, to). `queues`: for cases, the queues the reader can see. */
export interface FactQuery {
  source: FactSource;
  measure: FactMeasure;
  field?: string;
  filters?: EntityFilters;
  from: string | null;
  to: string;
  queues: string[];
}

export interface HistoryQuery {
  source: ListSource;
  entityType?: string;
  filters?: EntityFilters;
  from: string | null;
  to: string;
  sort: "newest" | "oldest";
  q?: string;
  limit: number;
  offset: number;
  queues: string[];
}

export type HistoryRow =
  | {
      source: "events";
      id: string;
      type: string;
      ts: string;
      properties: Record<string, unknown>;
      decision_id: string | null;
      outcome: string | null;
      risk: number | null;
    }
  | {
      source: "decisions";
      id: string;
      ts: string;
      action: string;
      outcome: string;
      risk: number;
      final_outcome: string;
      properties: Record<string, unknown>;
    }
  | {
      source: "linked";
      id: string;
      type: string;
      first_seen: string;
      last_seen: string;
      events: number;
      properties: Record<string, unknown>;
    }
  | {
      source: "cases";
      id: string;
      ts: string;
      status: string;
      priority: string;
      queue_id: string;
      assignee: string | null;
      resolution: string | null;
    };

export interface FactValue {
  name: string;
  label: string;
  measure: FactMeasure;
  window: string;
  /** A number, or a time for `first` and `last`; null when no record counts. */
  value: number | string | null;
  format?: FactFormat;
  currency?: string;
  /** With `usual`: what one window usually held, and how many times that the value is (null when it usually held nothing). */
  usual?: number;
  times_usual?: number | null;
}

export type RowLink =
  { kind: "event" | "decision" | "case"; id: string } | { kind: "entity"; type: string; id: string };

export interface ListPage {
  name: string;
  label: string;
  columns: { field: string; label: string; format?: ColumnFormat; currency?: string }[];
  /** `values` has each column's field, and the field a column reads its currency from. */
  rows: { id: string; ts: string; link: RowLink; values: Record<string, unknown> }[];
  total: number;
}

export interface EntitiesRepository {
  entityOfRecord(workspaceId: string, environmentId: string, universalId: string, type: string): Promise<string | null>;
  linkSummary(
    workspaceId: string,
    environmentId: string,
    subject: EntityRef,
    via: EntityRef,
    query: LinkQuery,
  ): Promise<LinkSummary>;
  labelRates(
    workspaceId: string,
    environmentId: string,
    type: string,
    until?: string,
  ): Promise<{ total: number; labels: LabelCounts }>;

  entityTypes(workspaceId: string, environmentId: string): Promise<EntityTypeSummary[]>;
  entityShape(workspaceId: string, environmentId: string, type: string): Promise<EntityShape>;
  listEntities(workspaceId: string, environmentId: string, filter: EntityFilter): Promise<EntitySummary[]>;
  countEntities(
    workspaceId: string,
    environmentId: string,
    filter: Omit<EntityFilter, "limit" | "offset">,
  ): Promise<number>;
  /** A number for `count`, `sum`, `avg` and `unique`; a time for `first` and `last`, or null when there is none. */
  fact(
    workspaceId: string,
    environmentId: string,
    entity: EntityRef,
    query: FactQuery,
  ): Promise<number | string | null>;
  history(
    workspaceId: string,
    environmentId: string,
    entity: EntityRef,
    query: HistoryQuery,
  ): Promise<{ rows: HistoryRow[]; total: number }>;
}

/** What an erasure removed, or would remove with a dry run. */
export interface Erased {
  entity: number;
  labels: number;
  events: number;
  /** Events that also name other entities: kept for them, without this entity and without properties. */
  events_redacted: number;
  decisions: number;
  /** Decisions about someone else whose request or context named this entity: kept, with what the model saw removed. */
  decisions_redacted: number;
  cases: number;
  case_items: number;
  case_evidence: number;
  /** The finished runs of its decisions. */
  workflow_runs: number;
  /** Other finished runs whose trigger named it, or that its events started: kept, without trigger, steps and output. */
  workflow_runs_redacted: number;
  webhook_deliveries: number;
  /** Inbound deliveries that stored its events: kept, with the payload and headers removed. */
  webhook_payloads_redacted: number;
}
