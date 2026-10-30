import { sql, type SQL } from "drizzle-orm";
import type { Executor } from "../../platform/database";
import { rows } from "../../platform/sql";
import type { Purged } from "./types";

/** Rows deleted in one statement: short enough not to hold a lock on a busy table for long. */
export const BATCH = 1000;

/** The workspaces that keep their data for a while only, with how long. */
export async function workspacesWithRetention(db: Executor): Promise<{ id: string; days: number }[]> {
  return rows<{ id: string; days: number }>(
    db,
    sql`SELECT id, (settings->>'data_retention_days')::int AS days FROM workspaces
        WHERE jsonb_typeof(settings->'data_retention_days') = 'number' AND status = 'active'
        ORDER BY id`,
  );
}

/** Deletes up to BATCH rows of `table` matching `where`, by id. */
async function batch(db: Executor, table: string, where: SQL): Promise<number> {
  const t = sql.raw(table);
  const deleted = await rows<{ id: string }>(
    db,
    sql`DELETE FROM ${t} WHERE id IN (SELECT id FROM ${t} WHERE ${where} LIMIT ${BATCH}) RETURNING id`,
  );
  return deleted.length;
}

/**
 * Deletes, in every environment of one workspace, the history from before `cutoff`, in batches,
 * until done or until `deadline`. Safe to run again: a run that stops at the deadline is finished
 * by the next one. The order matters: cases and decisions before events (decisions keep no
 * foreign key that would block it), and entities last, once nothing names them any more.
 */
export async function purgeWorkspace(
  db: Executor,
  workspaceId: string,
  cutoff: Date,
  deadline: number,
): Promise<Purged> {
  const ws = sql`workspace_id = ${workspaceId}`;
  const purged: Purged = {
    cases: 0,
    decisions: 0,
    events: 0,
    labels: 0,
    webhook_deliveries: 0,
    workflow_runs: 0,
    case_items: 0,
    entities: 0,
    complete: false,
  };

  const steps: [keyof Omit<Purged, "complete">, string, SQL][] = [
    // A resolved case nobody has touched since the cutoff goes whole, with its evidence, items and activity.
    ["cases", "cases", sql`${ws} AND status = 'resolved' AND last_activity < ${cutoff}`],
    ["decisions", "decisions", sql`${ws} AND ts < ${cutoff}`],
    // An event's entity links go with it (event_entities cascades); records and sessions are its stages.
    ["events", "events", sql`${ws} AND ts < ${cutoff}`],
    // A label such as fraud_confirmed stays while its entity is active: workflows still read it.
    [
      "labels",
      "labels",
      sql`${ws} AND ts < ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM event_entities x WHERE x.workspace_id = labels.workspace_id
          AND x.environment_id = labels.environment_id AND x.entity_type = labels.entity_type
          AND x.entity_id = labels.entity_id AND x.ts >= ${cutoff})
        AND NOT EXISTS (SELECT 1 FROM objects x WHERE x.workspace_id = labels.workspace_id
          AND x.environment_id = labels.environment_id AND x.type = labels.entity_type
          AND x.external_id = labels.entity_id AND x.updated >= ${cutoff})`,
    ],
    // Inbound and outbound logs; an outbound delivery still waiting to be sent stays.
    [
      "webhook_deliveries",
      "webhook_deliveries",
      sql`${ws} AND created < ${cutoff} AND (direction = 'in' OR status <> 'pending')`,
    ],
    ["workflow_runs", "workflow_runs", sql`${ws} AND created < ${cutoff} AND finished IS NOT NULL`],
    // In the cases that stay: what pointed at a decision or an event that is gone.
    [
      "case_items",
      "case_items",
      sql`${ws} AND (
        (kind = 'decision' AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.id = case_items.ref_id))
        OR (kind = 'event' AND NOT EXISTS (SELECT 1 FROM events e WHERE e.workspace_id = case_items.workspace_id
          AND e.environment_id = case_items.environment_id AND e.external_id = case_items.ref_id))
      )`,
    ],
    // An entity unchanged since the cutoff that no event, label, decision or case names any more.
    [
      "entities",
      "objects",
      sql`${ws} AND updated < ${cutoff} AND first_seen < ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM event_entities x WHERE x.workspace_id = objects.workspace_id
          AND x.environment_id = objects.environment_id AND x.entity_type = objects.type AND x.entity_id = objects.external_id)
        AND NOT EXISTS (SELECT 1 FROM labels x WHERE x.workspace_id = objects.workspace_id
          AND x.environment_id = objects.environment_id AND x.entity_type = objects.type AND x.entity_id = objects.external_id)
        AND NOT EXISTS (SELECT 1 FROM decisions x WHERE x.workspace_id = objects.workspace_id
          AND x.environment_id = objects.environment_id AND x.subject_type = objects.type AND x.subject_id = objects.external_id)
        AND NOT EXISTS (SELECT 1 FROM cases x WHERE x.workspace_id = objects.workspace_id
          AND x.environment_id = objects.environment_id AND x.target_type = objects.type AND x.target_id = objects.external_id)`,
    ],
  ];

  for (const [name, table, where] of steps) {
    for (;;) {
      if (Date.now() > deadline) return purged;
      const n = await batch(db, table, where);
      purged[name] += n;
      if (n < BATCH) break;
    }
  }
  purged.complete = true;
  return purged;
}
