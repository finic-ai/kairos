import { sql } from "drizzle-orm";
import { jobs } from "../db/schema";
import type { Executor } from "../platform/database";
import { newId } from "../platform/crypto";
import { DatabaseService } from "../platform/orm";
import { iso, rows } from "../platform/sql";

export interface ClaimedJob {
  id: string;
  kind: string;
  key: string;
  workspace_id: string | null;
  environment_id: string | null;
  group_key: string | null;
  payload: Record<string, unknown>;
  /** Including this claim. */
  attempts: number;
}

export interface NewJob {
  kind: string;
  key: string;
  payload: Record<string, unknown>;
  /** Default: now. */
  runAt?: Date;
  group?: string;
  workspaceId?: string;
  environmentId?: string;
}

export interface JobView {
  id: string;
  kind: string;
  key: string;
  status: "pending" | "paused" | "done" | "dead";
  run_at: string;
  attempts: number;
  last_error: string | null;
  created: string;
  finished: string | null;
}

const newJob = (job: NewJob, now: Date) => ({
  kind: job.kind,
  key: job.key,
  payload: job.payload,
  status: "pending" as const,
  runAt: job.runAt ?? now,
  attempts: 0,
  groupKey: job.group ?? null,
  workspaceId: job.workspaceId ?? null,
  environmentId: job.environmentId ?? null,
});

/** The row of a new job, for a repository that writes jobs with its own rows, in one statement. */
export const jobRow = (job: NewJob, now: Date) => ({
  id: newId("job"),
  ...newJob(job, now),
  created: now,
  updated: now,
});

export const resetJob = (now: Date, runAt = now) => ({
  status: "pending" as const,
  runAt,
  attempts: 0,
  lastError: null,
  finished: null,
  updated: now,
});

/** Built on a transaction, `enqueue` writes a job with the change that needs it. */
export class JobsService extends DatabaseService<"jobs"> {
  constructor(db: Executor) {
    super(db, "jobs", {});
  }

  /** A second job with the same kind and key does nothing. True when this one was written. */
  enqueue(job: NewJob, now: Date): Promise<boolean> {
    return this.createIfMissing(newJob(job, now), now, ["kind", "key"]);
  }

  /** Write the job, or start the existing one with the same kind and key again, from no attempts. */
  async requeue(job: NewJob, now: Date): Promise<void> {
    const { updated: _updated, ...reset } = resetJob(now, job.runAt);
    await this.upsert(newJob(job, now), now, ["kind", "key"], { payload: job.payload, ...reset });
  }

  /** Write many jobs in one statement. One with the kind and key of a job that exists is not written. */
  async enqueueMany(jobsToWrite: NewJob[], now: Date): Promise<void> {
    if (jobsToWrite.length === 0) return;
    await this.db
      .insert(jobs)
      .values(jobsToWrite.map((job) => jobRow(job, now)))
      .onConflictDoNothing({ target: [jobs.kind, jobs.key] });
  }

  /** `requeue` for many jobs, in one statement. */
  async requeueMany(jobsToWrite: NewJob[], now: Date): Promise<void> {
    if (jobsToWrite.length === 0) return;
    await this.db
      .insert(jobs)
      .values(jobsToWrite.map((job) => jobRow(job, now)))
      .onConflictDoUpdate({ target: [jobs.kind, jobs.key], set: resetJob(now) });
  }

  /**
   * Delete the pending jobs of a kind whose key starts with `prefix`, such as the jobs of one
   * workflow run. A job that runs now is claimed, not done: it is deleted too, and its run ends
   * as it ends. Returns how many went.
   */
  async cancelPending(kind: string, prefix: string): Promise<number> {
    const gone = await this.deleteMany({ kind, status: "pending", RAW: (t) => sql`starts_with(${t.key}, ${prefix})` });
    return gone.length;
  }

  /**
   * Take up to `limit` due jobs of one kind, oldest first. Taking one moves its `run_at` forward
   * by the lease, so that another process skips it while it runs; the result sets the real time.
   */
  async claim(kind: string, now: Date, limit: number, leaseMs: number): Promise<ClaimedJob[]> {
    if (limit <= 0) return [];
    return rows<ClaimedJob>(
      this.db,
      sql`WITH due AS (
            SELECT id FROM jobs WHERE kind = ${kind} AND status = 'pending' AND run_at <= ${now}
            ORDER BY run_at LIMIT ${limit} FOR UPDATE SKIP LOCKED
          )
          UPDATE jobs j SET run_at = ${new Date(now.getTime() + leaseMs)}, attempts = j.attempts + 1, updated = ${now}
          FROM due WHERE j.id = due.id
          RETURNING j.id, j.kind, j.key, j.workspace_id, j.environment_id, j.group_key, j.payload, j.attempts`,
    );
  }

  /** A job that its handler paused while it ran keeps its pause: the result of the run does not change it. */
  async complete(id: string, now: Date): Promise<void> {
    await this.updateMany({ id, status: "pending" }, { status: "done", lastError: null, finished: now }, now);
  }

  async fail(id: string, error: string, now: Date, retryAt?: Date): Promise<void> {
    await this.updateMany(
      { id, status: "pending" },
      retryAt
        ? { status: "pending", runAt: retryAt, lastError: error }
        : { status: "dead", lastError: error, finished: now },
      now,
    );
  }

  async deletePending(kind: string, key: string): Promise<void> {
    await this.deleteMany({ kind, key, status: "pending" });
  }

  async pauseGroup(group: string, now: Date): Promise<void> {
    await this.updateMany({ groupKey: group, status: "pending" }, { status: "paused" }, now);
  }

  /** Delete the jobs of a group that have not run, such as those of a webhook that is deleted. */
  async deleteGroup(group: string): Promise<void> {
    await this.deleteMany({ groupKey: group, status: { in: ["pending", "paused"] } });
  }

  async resumeGroup(group: string, now: Date): Promise<void> {
    await this.updateMany({ groupKey: group, status: "paused" }, { status: "pending", runAt: now }, now);
  }

  async findByKey(kind: string, key: string): Promise<JobView | null> {
    const r = await this.findFirst({ where: { kind, key } });
    return r
      ? {
          id: r.id,
          kind: r.kind,
          key: r.key,
          status: r.status,
          run_at: iso(r.runAt),
          attempts: r.attempts,
          last_error: r.lastError,
          created: iso(r.created),
          finished: iso(r.finished),
        }
      : null;
  }

  /** In every workspace: delete `done` jobs older than `doneDays` and `dead` ones older than `deadDays`, in batches, within the budget. */
  async cleanup(now: Date, doneDays: number, deadDays: number, budgetMs = 10_000): Promise<number> {
    const started = Date.now();
    const before = (days: number) => new Date(now.getTime() - days * 86_400_000);
    let deleted = 0;
    for (;;) {
      const batch = await rows<{ id: string }>(
        this.db,
        sql`DELETE FROM jobs WHERE id IN (
              SELECT id FROM jobs WHERE (status = 'done' AND finished < ${before(doneDays)}) OR (status = 'dead' AND finished < ${before(deadDays)}) LIMIT 1000
            ) RETURNING id`,
      );
      deleted += batch.length;
      if (batch.length < 1000 || Date.now() - started > budgetMs) return deleted;
    }
  }
}
