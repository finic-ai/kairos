import type { ClaimedJob, JobsService } from "../../services/job.service";

/**
 * The one worker for all background work (internal/designs/jobs.md). Each kind of job gives a
 * handler, a concurrency and a retry policy; the worker claims due jobs from the `jobs` table,
 * runs them and retries them. It runs every second in a server that keeps running, and in a
 * function after its answer (`wake`, under waitUntil) and from a scheduler (`drain`).
 */

/** Thrown by a handler: the job is `dead` at once, with no retry. */
export class PermanentError extends Error {}

export interface JobRun {
  id: string;
  key: string;
  /** With this run: 1 on the first. */
  attempts: number;
  workspaceId: string | null;
  environmentId: string | null;
  group: string | null;
  /** When the job runs again if this run throws. Unset on the last attempt. */
  retryAt?: Date;
}

export interface JobKind<P = Record<string, unknown>> {
  kind: string;
  concurrency: number;
  /** Jobs of one group running at once in one process, so that one slow group does not hold the rest. */
  perGroup?: number;
  /** The wait before each retry, spread by ±10%. Its length + 1 is the number of attempts. */
  retryDelaysMs: number[];
  /** How long one run can take. A drain does not start a batch that would end after its deadline. Default 10 s. */
  timeoutMs?: number;
  /** How long a claim lasts. Longer than a run. Default 2 minutes. */
  leaseMs?: number;
  /** Throws to retry; throws a PermanentError to stop. */
  run(payload: P, job: JobRun): Promise<void>;
}

/** A job of one kind for each period: the key holds the start of the period, so two processes make one. */
export interface Schedule {
  kind: string;
  everyMs: number;
}

/** The background work of one module: its kinds of jobs, and the schedules that make jobs of them. */
export interface ModuleJobs {
  kinds: JobKind<any>[];
  schedules?: Schedule[];
}

export interface Jobs {
  drain(options?: { budgetMs?: number }): Promise<number>;
  wake(): void;
  start(): void;
  stop(): Promise<void>;
}

export interface JobsOptions {
  repo: JobsService;
  kinds: JobKind<any>[];
  schedules?: Schedule[];
  now: () => Date;
  /**
   * Where no process keeps running (a Vercel function), `wake` cannot leave a drain behind: it
   * hands the drain to this, which keeps the function alive until it ends.
   */
  defer?: (work: Promise<unknown>) => void;
  random?: () => number;
  log?: (message: string) => void;
  tickMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_LEASE_MS = 2 * 60_000;
/** How long a function stays alive after its answer for the first run of what it enqueued. */
const WAKE_BUDGET_MS = 20_000;

export function createJobs(options: JobsOptions): Jobs {
  const { repo, now } = options;
  const random = options.random ?? Math.random;
  const log = options.log ?? ((message: string) => console.error(message));
  const kinds = options.kinds;
  const scheduled = new Map<string, number>();

  async function schedule() {
    const at = now();
    for (const { kind, everyMs } of options.schedules ?? []) {
      const period = Math.floor(at.getTime() / everyMs) * everyMs;
      if (scheduled.get(kind) === period) continue;
      await repo.enqueue(
        { kind, key: `${kind}:${new Date(period).toISOString()}`, payload: {}, runAt: new Date(period) },
        at,
      );
      scheduled.set(kind, period);
    }
  }

  async function run(kind: JobKind<any>, job: ClaimedJob) {
    const delay = kind.retryDelaysMs[job.attempts - 1];
    const retryAt = delay === undefined ? undefined : new Date(now().getTime() + delay * (0.9 + 0.2 * random()));
    const context: JobRun = {
      id: job.id,
      key: job.key,
      attempts: job.attempts,
      workspaceId: job.workspace_id,
      environmentId: job.environment_id,
      group: job.group_key,
      retryAt,
    };
    try {
      await kind.run(job.payload, context);
      await repo.complete(job.id, now());
    } catch (cause) {
      const message = (cause as Error)?.message ?? String(cause);
      await repo.fail(job.id, message, now(), cause instanceof PermanentError ? undefined : retryAt);
    }
  }

  async function runAll(kind: JobKind<any>, claimed: ClaimedJob[]) {
    const byGroup = new Map<string, ClaimedJob[]>();
    for (const job of claimed) {
      const group = job.group_key ?? job.id;
      byGroup.set(group, [...(byGroup.get(group) ?? []), job]);
    }
    await Promise.all(
      [...byGroup.values()].map(async (queue) => {
        const lanes = Array.from({ length: Math.min(kind.perGroup ?? queue.length, queue.length) }, async () => {
          for (let job = queue.shift(); job; job = queue.shift()) {
            await run(kind, job).catch((cause) => log(`job ${job!.kind} ${job!.id}: ${(cause as Error).message}`));
          }
        });
        await Promise.all(lanes);
      }),
    );
  }

  async function drainOnce(deadline: number): Promise<number> {
    await schedule();
    let total = 0;
    for (;;) {
      let full = false;
      const batches = await Promise.all(
        kinds.map(async (kind) => {
          // A batch can take up to the run timeout; do not start one that would end past the deadline.
          if (Date.now() + (kind.timeoutMs ?? DEFAULT_TIMEOUT_MS) > deadline) return [kind, []] as const;
          const claimed = await repo.claim(kind.kind, now(), kind.concurrency, kind.leaseMs ?? DEFAULT_LEASE_MS);
          if (claimed.length === kind.concurrency) full = true;
          return [kind, claimed] as const;
        }),
      );
      const count = batches.reduce((n, [, claimed]) => n + claimed.length, 0);
      if (count === 0) return total;
      total += count;
      await Promise.all(batches.map(([kind, claimed]) => runAll(kind, [...claimed])));
      if (!full) return total;
    }
  }

  let running: Promise<number> | null = null;
  let again = false;
  const drain = (o: { budgetMs?: number } = {}): Promise<number> => {
    if (running) {
      again = true;
      return running;
    }
    const deadline = o.budgetMs ? Date.now() + o.budgetMs : Infinity;
    running = (async () => {
      let total = 0;
      do {
        again = false;
        total += await drainOnce(deadline);
      } while (again && Date.now() < deadline);
      return total;
    })().finally(() => (running = null));
    return running;
  };

  let ticker: NodeJS.Timeout | undefined;
  const runDueJobsLogged = () => drain().catch((cause) => log(`jobs: ${(cause as Error).message}`));

  return {
    drain,
    // In a function, the first run happens after the answer, kept alive by `defer`; the rest come from the scheduler's drain.
    wake: () => (options.defer ? options.defer(drain({ budgetMs: WAKE_BUDGET_MS })) : void runDueJobsLogged()),
    start() {
      if (ticker) return;
      ticker = setInterval(runDueJobsLogged, options.tickMs ?? 1_000);
      ticker.unref();
      void runDueJobsLogged();
    },
    async stop() {
      clearInterval(ticker);
      ticker = undefined;
      await running?.catch(() => {});
    },
  };
}
