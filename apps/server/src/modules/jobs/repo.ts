import { sql } from "drizzle-orm";
import type { Executor } from "../../platform/database";
import { first, rows } from "../../platform/sql";
import type { JobFilter, JobRow, JobScope, JobStatus } from "./types";

const COLUMNS = sql`id, kind, key, status, run_at, attempts, last_error, created, updated, finished`;
/** A job of no workspace, such as the cleanup, is not shown in any. */
const inScope = (scope: JobScope) =>
  sql`workspace_id = ${scope.workspaceId} AND environment_id = ${scope.environmentId}`;

/** The newest first. */
export function listJobs(db: Executor, scope: JobScope, filter: JobFilter): Promise<JobRow[]> {
  return rows<JobRow>(
    db,
    sql`SELECT ${COLUMNS} FROM jobs
        WHERE ${inScope(scope)}
          ${filter.status ? sql`AND status = ${filter.status}` : sql``}
          ${filter.kind ? sql`AND kind = ${filter.kind}` : sql``}
        ORDER BY created DESC, id DESC
        LIMIT ${filter.limit} OFFSET ${filter.offset}`,
  );
}

export function countJobs(db: Executor, scope: JobScope) {
  return rows<{ kind: string; status: JobStatus; n: number }>(
    db,
    sql`SELECT kind, status, count(*)::int AS n FROM jobs WHERE ${inScope(scope)} GROUP BY kind, status ORDER BY kind`,
  );
}

export function findJob(db: Executor, scope: JobScope, id: string): Promise<JobRow | undefined> {
  return first<JobRow>(db, sql`SELECT ${COLUMNS}, payload FROM jobs WHERE id = ${id} AND ${inScope(scope)}`);
}

/** Start a dead job again, from no attempts. Undefined when it is not dead, or not in the scope. */
export function retryDeadJob(db: Executor, scope: JobScope, id: string, now: Date): Promise<JobRow | undefined> {
  return first<JobRow>(
    db,
    sql`UPDATE jobs SET status = 'pending', run_at = ${now}, attempts = 0, last_error = NULL, finished = NULL, updated = ${now}
        WHERE id = ${id} AND ${inScope(scope)} AND status = 'dead'
        RETURNING ${COLUMNS}, payload`,
  );
}
