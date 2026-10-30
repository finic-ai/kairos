import { sql } from "drizzle-orm";
import { boolean, foreignKey, index, integer, json, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { time, created, updated, environment } from "./columns";
import { workspace, environments } from "./accounts";
import { events } from "./events";

export const decisions = pgTable(
  "decisions",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    environmentId: environment(),
    ts: time("ts").notNull(),
    action: text("action").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    decision: jsonb("decision").notNull(),
    context: json("context").notNull(),
    raw: json("raw").notNull(),
    /** The Kairos id of the event that started the decision, when one did. The API shows the event's `external_id`. */
    eventId: text("event_id").references(() => events.id, { onDelete: "set null" }),
    sessionId: text("session_id"),
    request: json("request").$type<{ entities: Record<string, string>; properties: Record<string, unknown> }>(),
    /** 1, and one more for each change of the resolution. A receiver keeps the highest it has seen. */
    revision: integer("revision").notNull().default(1),
    /** A person's decision on it, the latest one: { outcome, note, by, at }. The model's `decision` never changes. */
    resolution: jsonb("resolution").$type<Resolution>(),
    finalOutcome: text("final_outcome").generatedAlwaysAs(
      sql`COALESCE(resolution ->> 'outcome', decision ->> 'decision')`,
    ),
    automatic: boolean("automatic").notNull().default(false),
    /**
     * Provenance and other facts about the row that are not fields of the decision itself.
     * For a decision a workflow made: `{ workflow_run_id, workflow_step_key }`, where the step
     * key is "<run id>:<step path>". A retry of the step finds its decision by the step key
     * and does not decide again; the unique index below keeps one decision for one step.
     */
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    created: created(),
    updated: updated(),
  },
  (t) => [
    foreignKey({
      name: "decisions_environment_fk",
      columns: [t.workspaceId, t.environmentId],
      foreignColumns: [environments.workspaceId, environments.id],
    }).onDelete("cascade"),
    // Per environment: a copy to a sandbox keeps the metadata of the decisions it copies.
    uniqueIndex("decisions_workflow_step")
      .on(t.workspaceId, t.environmentId, sql`(metadata ->> 'workflow_step_key')`)
      .where(sql`metadata ->> 'workflow_step_key' IS NOT NULL`),
    index("decisions_by_final_outcome").on(t.workspaceId, t.environmentId, t.finalOutcome, t.ts),
    // One event, one decision: an automatic decision and a call to /events/decide cannot both make one.
    uniqueIndex("decisions_one_per_event")
      .on(t.eventId)
      .where(sql`event_id IS NOT NULL`),
    index("decisions_by_time").on(t.workspaceId, t.environmentId, t.ts),
    index("decisions_by_subject").on(t.workspaceId, t.environmentId, t.subjectType, t.subjectId, t.ts),
    index("decisions_by_session").on(t.workspaceId, t.environmentId, t.sessionId, t.ts),
  ],
);

export interface Resolution {
  outcome: "approve" | "block";
  note?: string;
  by: string;
  at: string;
}

export type DecisionRow = typeof decisions.$inferSelect;
