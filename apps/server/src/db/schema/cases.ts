import type { CaseCategory, CasePriority, CaseStatus, Outcome, QueueDefinition } from "@kairos/core";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  foreignKey,
  index,
  integer,
  json,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { time, created, updated, environment } from "./columns";
import { workspace, environments } from "./accounts";

/**
 * Queues and the cases in them. A queue's intake rules, or a workflow's `case.create` step, add
 * a trigger to a case; the case service is the only writer of these tables.
 */
export const queues = pgTable(
  "queues",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    environmentId: environment(),
    definition: jsonb("definition").$type<QueueDefinition>().notNull(),
    /** One more on each save that changes `sources`, `intake` or `correlation`: what decides which cases exist. */
    version: integer("version").notNull().default(1),
    owner: text("owner"),
    created: created(),
    updated: updated(),
    /** The order they were made in, for two made at the same moment. */
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
  },
  (t) => [
    foreignKey({
      name: "queues_environment_fk",
      columns: [t.workspaceId, t.environmentId],
      foreignColumns: [environments.workspaceId, environments.id],
    }).onDelete("cascade"),
    index("queues_by_environment").on(t.workspaceId, t.environmentId),
  ],
);

export interface CaseResolution {
  category: CaseCategory;
  note?: string;
  by: string;
  at: string;
  /** "<run id>:<step path>" when a workflow's step resolved it: a retry of the step finds its own resolution. */
  workflow_step_key?: string;
}

export const cases = pgTable(
  "cases",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    environmentId: environment(),
    /**
     * A queue with cases cannot be deleted. "no action" is checked at the end of the statement, so
     * deleting an environment, which cascades to both tables, still works.
     */
    queueId: text("queue_id")
      .notNull()
      .references(() => queues.id, { onDelete: "no action" }),
    status: text("status").$type<CaseStatus>().notNull(),
    priority: text("priority").$type<CasePriority>().notNull(),
    assigneeId: text("assignee_id"),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    /** "subject:user:user_42", "entity:application:app_7": null when the trigger had none, and then nothing joins it. */
    correlationKey: text("correlation_key"),
    /**
     * A new trigger with the key can join it. False once it is resolved, once it was quiet for
     * longer than the window, or once it is full: the next trigger with the key starts a new case.
     */
    joinable: boolean("joinable").notNull().default(true),
    /** The name of the rule, or the reason of the workflow step, that made the case. */
    reason: text("reason").notNull(),
    /** Kept with each trigger, so that a list of cases is one read of this table. */
    worstOutcome: text("worst_outcome").$type<Outcome>(),
    maxRisk: integer("max_risk"),
    evidenceCount: integer("evidence_count").notNull().default(0),
    /** The time of the latest trigger itself, not of its arrival: the correlation window counts from it. */
    lastEvidenceAt: time("last_evidence_at").notNull(),
    /** The latest trigger or activity: a note, an assignment. */
    lastActivity: time("last_activity").notNull(),
    resolution: jsonb("resolution").$type<CaseResolution>(),
    resolvedAt: time("resolved_at"),
    /** From the queue's due hours for the case's priority, counted from its start. Null when the queue gives none. */
    dueAt: time("due_at"),
    created: created(),
    updated: updated(),
  },
  (t) => [
    foreignKey({
      name: "cases_environment_fk",
      columns: [t.workspaceId, t.environmentId],
      foreignColumns: [environments.workspaceId, environments.id],
    }).onDelete("cascade"),
    index("cases_by_queue").on(t.workspaceId, t.environmentId, t.queueId, t.status, t.created),
    index("cases_by_target").on(t.workspaceId, t.environmentId, t.targetType, t.targetId),
    index("cases_by_due")
      .on(t.workspaceId, t.environmentId, t.queueId, t.dueAt)
      .where(sql`status <> 'resolved' AND due_at IS NOT NULL`),
    // One case a key can join in one queue: two triggers at the same moment cannot both make one.
    uniqueIndex("cases_one_joinable_per_key")
      .on(t.workspaceId, t.environmentId, t.queueId, t.correlationKey)
      .where(sql`joinable AND correlation_key IS NOT NULL`),
  ],
);

/** Why a case exists: one row for each trigger that made it or joined it. A row never changes. */
export const caseEvidence = pgTable(
  "case_evidence",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    environmentId: environment(),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    sourceType: text("source_type").$type<"decision" | "event" | "workflow">().notNull(),
    /** The decision id, the event's id, or "<run id>:<step path>". */
    sourceId: text("source_id").notNull(),
    /** The intake rule, and the queue version it ran under. Null for a workflow. */
    ruleId: text("rule_id"),
    ruleVersion: integer("rule_version"),
    /** What the trigger read, in the order the rule has it: `json`, as values a person wrote in an order are. */
    snapshot: json("snapshot").$type<Record<string, unknown>>().notNull(),
    correlationKey: text("correlation_key"),
    /** "intake:<queue>:<decision>:<rule>" or "workflow:<run>:<step path>": a retry writes nothing twice. */
    idempotencyKey: text("idempotency_key").notNull(),
    ts: time("ts").notNull(),
    created: created(),
  },
  (t) => [
    foreignKey({
      name: "case_evidence_environment_fk",
      columns: [t.workspaceId, t.environmentId],
      foreignColumns: [environments.workspaceId, environments.id],
    }).onDelete("cascade"),
    uniqueIndex("case_evidence_once").on(t.workspaceId, t.environmentId, t.idempotencyKey),
    index("case_evidence_by_case").on(t.caseId, t.ts),
    index("case_evidence_by_source").on(t.workspaceId, t.environmentId, t.sourceType, t.sourceId),
  ],
);

export type CaseItemKind = "decision" | "event" | "entity" | "session" | "record";

/** What a case holds: the decisions, events, entities, sessions and records its triggers named. */
export const caseItems = pgTable(
  "case_items",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    environmentId: environment(),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    kind: text("kind").$type<CaseItemKind>().notNull(),
    /** The entity type for an entity; null for the other kinds. */
    refType: text("ref_type"),
    /** A decision id, an event's id, an entity's id, a session id or a record's universal id. */
    refId: text("ref_id").notNull(),
    /** The evidence that brought it in first. */
    evidenceId: text("evidence_id").notNull(),
    created: created(),
  },
  (t) => [
    foreignKey({
      name: "case_items_environment_fk",
      columns: [t.workspaceId, t.environmentId],
      foreignColumns: [environments.workspaceId, environments.id],
    }).onDelete("cascade"),
    // A null ref_type is a value here, so an item is written once.
    unique("case_items_once").on(t.caseId, t.kind, t.refType, t.refId).nullsNotDistinct(),
    // "Which cases is this device in?"
    index("case_items_by_ref").on(t.workspaceId, t.environmentId, t.kind, t.refType, t.refId),
  ],
);

export type CaseActivityType =
  | "created"
  | "evidence_added"
  | "assigned"
  | "status_changed"
  | "note"
  | "resolved"
  | "reopened"
  | "viewed"
  | "checked";

/** What happened to a case after it was made. A row never changes. */
export const caseActivity = pgTable(
  "case_activity",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    environmentId: environment(),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    type: text("type").$type<CaseActivityType>().notNull(),
    /** A user id, an API key's name, "system", or "workflow:<name>@<version>". */
    actor: text("actor").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    created: created(),
  },
  (t) => [
    foreignKey({
      name: "case_activity_environment_fk",
      columns: [t.workspaceId, t.environmentId],
      foreignColumns: [environments.workspaceId, environments.id],
    }).onDelete("cascade"),
    index("case_activity_by_case").on(t.caseId, t.created),
  ],
);

export type QueueRow = typeof queues.$inferSelect;
export type CaseRow = typeof cases.$inferSelect;
export type CaseEvidenceRow = typeof caseEvidence.$inferSelect;
export type CaseItemRow = typeof caseItems.$inferSelect;
export type CaseActivityRow = typeof caseActivity.$inferSelect;
