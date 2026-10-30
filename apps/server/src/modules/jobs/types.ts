/**
 * How this process takes part in the background jobs:
 * - "loop": it runs them, on a tick each second (`jobs.start()`) and at once after an enqueue.
 * - "on-request": a Vercel function. It runs them after its answer, and when the scheduler calls the drain route.
 * - "enqueue": it only enqueues them, and a worker process runs them. The drain route still works.
 * Without one, it has no jobs: webhooks and automatic decisions are off.
 */
export type WorkerMode = "loop" | "on-request" | "enqueue";

/** `pending` waits to run, or to run again after a failure. `paused` waits for its group, `dead` failed for good. */
export const JOB_STATUSES = ["pending", "paused", "done", "dead"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface JobScope {
  workspaceId: string;
  environmentId: string;
}

export interface JobFilter {
  status?: JobStatus;
  kind?: string;
  limit: number;
  offset: number;
}

export interface JobRow {
  id: string;
  kind: string;
  key: string;
  status: JobStatus;
  run_at: Date | string;
  attempts: number;
  last_error: string | null;
  created: Date | string;
  updated: Date | string;
  finished: Date | string | null;
  payload?: Record<string, unknown>;
}

export interface JobView {
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
  /** Only on one job. Ids, not copies of rows. */
  payload?: Record<string, unknown>;
}

export interface JobSummary {
  statuses: Record<JobStatus, number>;
  kinds: ({ kind: string } & Record<JobStatus, number>)[];
}

/** A query written by hand can give a time as text. */
const iso = (moment: Date | string) => new Date(moment).toISOString();

export const toJobView = (r: JobRow): JobView => ({
  id: r.id,
  kind: r.kind,
  key: r.key,
  status: r.status,
  run_at: iso(r.run_at),
  attempts: r.attempts,
  last_error: r.last_error,
  created: iso(r.created),
  updated: iso(r.updated),
  finished: r.finished ? iso(r.finished) : null,
  ...(r.payload ? { payload: r.payload } : {}),
});
