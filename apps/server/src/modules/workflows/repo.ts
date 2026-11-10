import { sql } from "drizzle-orm";
import type { Executor } from "../../platform/database";

interface Scope {
  workspaceId: string;
  environmentId: string;
}

/**
 * Claim a run for the job of one segment. A queued or waiting run is claimed once. A running
 * run is claimed again only by its current segment's job: that job stopped in the middle (a
 * crash, a timeout) and is tried again. True when this call claimed it.
 */
export async function claimRun(
  db: Executor,
  scope: Scope,
  runId: string,
  segment: number,
  now: Date,
): Promise<boolean> {
  const again = Number.isInteger(segment) ? sql`OR (status = 'running' AND segment = ${segment})` : sql``;
  const claimed = (
    await db.execute<{ id: string }>(
      sql`UPDATE workflow_runs SET status = 'running', started = COALESCE(started, ${now})
          WHERE id = ${runId} AND workspace_id = ${scope.workspaceId} AND environment_id = ${scope.environmentId}
            AND (status IN ('queued', 'waiting') ${again}) RETURNING id`,
    )
  ).rows;
  return claimed.length > 0;
}

/**
 * The oldest run of a workflow that waits for a place, locked for this transaction. A run that
 * another transaction is starting is skipped. Call it in the transaction that writes its job.
 */
export async function takeNextQueued(db: Executor, scope: Scope, workflowId: string): Promise<string | null> {
  const found = (
    await db.execute<{ id: string }>(
      sql`SELECT id FROM workflow_runs
          WHERE workspace_id = ${scope.workspaceId} AND environment_id = ${scope.environmentId}
            AND workflow_id = ${workflowId} AND status = 'queued' AND segment = 0
          ORDER BY created, id LIMIT 1 FOR UPDATE SKIP LOCKED`,
    )
  ).rows;
  return found[0]?.id ?? null;
}

/** A published, active workflow with a schedule, in any workspace: what the scheduler checks each minute. */
export interface ScheduledWorkflow {
  id: string;
  workspace_id: string;
  environment_id: string;
  name: string;
  version: number;
  trigger: { cron?: string; timezone?: string };
  published_at: Date | null;
}

export async function scheduledWorkflows(db: Executor): Promise<ScheduledWorkflow[]> {
  return (
    await db.execute<ScheduledWorkflow>(
      sql`SELECT id, workspace_id, environment_id, name, version, definition -> 'trigger' AS trigger, published_at
            FROM workflows
           WHERE trigger_type = 'scheduled' AND status = 'published' AND enabled`,
    )
  ).rows;
}

/** The workflow whose webhook URL has this token's hash, in any workspace. */
export async function workflowByHook(
  db: Executor,
  hash: string,
): Promise<{ workspace_id: string; environment_id: string; name: string } | null> {
  const found = (
    await db.execute<{ workspace_id: string; environment_id: string; name: string }>(
      sql`SELECT w.workspace_id, w.environment_id, w.name FROM workflows w
        JOIN workspaces ws ON ws.id = w.workspace_id
        WHERE w.hook_token_hash = ${hash} AND ws.status = 'active'`,
    )
  ).rows;
  return found[0] ?? null;
}
