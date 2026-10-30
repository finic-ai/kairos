import type { Decider } from "@kairos/core";
import type { Webhooks } from "../../context";
import type { Config } from "../../platform/config";
import type { Executor } from "../../platform/database";
import { createJobs, type Jobs, type ModuleJobs } from "../../platform/jobs/worker";
import { localEncryptionKey, secretBox } from "../../platform/secrets";
import { waitUntil } from "../../platform/wait-until";
import type { Repositories } from "../../repositories";
import { JobsService } from "../../services/job.service";
import { decisionJobs, type AutomaticRunner } from "../decisions/libs";
import { webhookJobs } from "../webhooks/libs";
import { workflowJobs } from "../workflows/service";
import { caseJobs } from "../cases/service";
import { retentionJobs } from "../retention";
import { experimentJobs } from "../experiments";
import { AppError, notFound } from "../../platform/error";
import type { Tenancy } from "../tenancy/service";
import type { Environments } from "../environments/service";
import { countJobs, findJob, listJobs, retryDeadJob } from "./repo";
import { JOB_STATUSES, toJobView, type JobFilter, type JobScope, type JobSummary, type WorkerMode } from "./types";

/** Finished jobs are kept this long: `done` ones for a week, `dead` ones for a month, to read why. */
const DONE_DAYS = 7;
const DEAD_DAYS = 30;

/** Each hour, delete the finished jobs that are older than that. The kind keeps the name it had. */
function jobsCleanup(jobs: JobsService, now: () => Date): ModuleJobs {
  return {
    kinds: [
      {
        kind: "cleanup",
        concurrency: 1,
        retryDelaysMs: [5 * 60_000],
        timeoutMs: 30_000,
        async run() {
          await jobs.cleanup(now(), DONE_DAYS, DEAD_DAYS);
        },
      },
    ],
    schedules: [{ kind: "cleanup", everyMs: 3_600_000 }],
  };
}

export interface BackgroundOptions {
  db: Executor;
  repos: Repositories;
  decider: Decider;
  now: () => Date;
  webhooks: Config["webhooks"];
  /** Without one, it runs no jobs. */
  worker?: WorkerMode;
}

export interface Background {
  /** Unset in a process that runs no jobs. */
  jobs?: Jobs;
  webhooks: Webhooks;
  /** Unset in a process that runs no jobs. */
  automatic?: AutomaticRunner;
}

/**
 * Make the background work of every module, and the worker that runs it in this process. Each
 * module gives its own kinds of jobs and schedules; the worker claims and runs them.
 */
export function createBackground({
  db,
  repos,
  decider,
  now,
  webhooks: settings,
  worker,
}: BackgroundOptions): Background {
  const key = settings.encryptionKey ?? (settings.localKeyFile ? localEncryptionKey(settings.localKeyFile) : undefined);
  const store = new JobsService(db);
  let jobs: Jobs | undefined;
  // The worker process finds the job on its next tick.
  const wake = worker === "enqueue" ? () => {} : () => jobs?.wake();
  const drain = (options?: { budgetMs?: number }) => jobs!.drain(options);

  const webhookWork = webhookJobs({
    db,
    jobs: store,
    now,
    secretBox: key ? secretBox(key) : undefined,
    allowPrivate: settings.allowPrivate,
    cronSecret: settings.cronSecret,
    payloadDays: settings.payloadDays,
    worker,
    wake,
    drain,
  });
  const { webhooks } = webhookWork;
  if (!worker) return { webhooks };

  const decisionWork = decisionJobs({ repos, decider, now, webhooks, wake });
  const work: ModuleJobs[] = [
    jobsCleanup(store, now),
    webhookWork,
    decisionWork,
    workflowJobs({ repos, decider, now, allowPrivate: settings.allowPrivate, wake }),
    caseJobs({ repos, now, wake }),
    retentionJobs({ db, now }),
    experimentJobs({ db, now }),
  ];
  jobs = createJobs({
    repo: store,
    kinds: work.flatMap((w) => w.kinds),
    schedules: work.flatMap((w) => w.schedules ?? []),
    now,
    defer: worker === "on-request" ? waitUntil : undefined,
  });
  return { jobs, webhooks, automatic: decisionWork.automatic };
}

export interface JobsAdminDeps {
  db: Executor;
  tenancy: Tenancy;
  environments: Environments;
  now: () => Date;
  /** Wakes the worker after a retry. */
  onQueued?: () => void;
}

export function createJobsAdmin({ db, tenancy, environments, now, onQueued }: JobsAdminDeps) {
  const zero = () => Object.fromEntries(JOB_STATUSES.map((s) => [s, 0])) as JobSummary["statuses"];

  return {
    async requireAdmin(workspaceId: string, userId: string, environmentId: string | undefined): Promise<JobScope> {
      await tenancy.requireRole(workspaceId, userId, "admin");
      const environment = await environments.environment(workspaceId, environmentId);
      return { workspaceId, environmentId: environment.id };
    },

    async list(scope: JobScope, filter: JobFilter) {
      return (await listJobs(db, scope, filter)).map(toJobView);
    },

    async summary(scope: JobScope): Promise<JobSummary> {
      const statuses = zero();
      const kinds = new Map<string, JobSummary["kinds"][number]>();
      for (const { kind, status, n } of await countJobs(db, scope)) {
        statuses[status] += n;
        const counts = kinds.get(kind) ?? { kind, ...zero() };
        counts[status] += n;
        kinds.set(kind, counts);
      }
      return { statuses, kinds: [...kinds.values()] };
    },

    async job(scope: JobScope, id: string) {
      const found = await findJob(db, scope, id);
      if (!found) throw notFound("No such job");
      return toJobView(found);
    },

    /** Run a dead job again, from no attempts. Its handler finds that the work is done, if it is. */
    async retry(scope: JobScope, id: string) {
      const retried = await retryDeadJob(db, scope, id, now());
      if (!retried) {
        if (!(await findJob(db, scope, id))) throw notFound("No such job");
        throw new AppError("conflict", "not_dead", "Only a dead job can be retried");
      }
      onQueued?.();
      return toJobView(retried);
    },
  };
}

export type JobsAdmin = ReturnType<typeof createJobsAdmin>;
