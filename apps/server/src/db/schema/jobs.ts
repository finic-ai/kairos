import { sql } from "drizzle-orm";
import { foreignKey, index, integer, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { time, created, updated } from "./columns";
import { environments, workspaces } from "./accounts";

/**
 * One piece of background work: a webhook delivery, an automatic decision, a cleanup. One worker
 * claims and runs them all. See internal/designs/jobs.md.
 *
 * There is no `running` status. A claim moves `run_at` forward by a lease and adds one to
 * `attempts`, so a job whose process stopped is claimed again when the lease ends.
 */
export const jobs = pgTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    key: text("key").notNull(),
    workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    environmentId: text("environment_id"),
    groupKey: text("group_key"),
    /** What the handler needs: ids, not copies of rows. */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status").$type<"pending" | "paused" | "done" | "dead">().notNull(),
    runAt: time("run_at").notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    created: created(),
    updated: updated(),
    finished: time("finished"),
  },
  (t) => [
    foreignKey({
      name: "jobs_environment_fk",
      columns: [t.workspaceId, t.environmentId],
      foreignColumns: [environments.workspaceId, environments.id],
    }).onDelete("cascade"),
    uniqueIndex("jobs_kind_key").on(t.kind, t.key),
    index("jobs_due")
      .on(t.kind, t.runAt)
      .where(sql`status = 'pending'`),
    index("jobs_by_scope").on(t.workspaceId, t.environmentId, t.kind, t.status, t.created),
    index("jobs_by_group")
      .on(t.groupKey)
      .where(sql`status IN ('pending', 'paused')`),
    index("jobs_by_age")
      .on(t.finished)
      .where(sql`status IN ('done', 'dead')`),
  ],
);
