import type { Webhooks } from "../../../context";
import type { Executor } from "../../../platform/database";
import type { ModuleJobs } from "../../../platform/jobs/worker";
import type { SecretBox } from "../../../platform/secrets";
import type { JobsService } from "../../../services/job.service";
import { shopifyBackfillKind } from "./backfill";
import { WEBHOOK_CLEANUP_SCHEDULE, webhookCleanupKind } from "./cleanup";
import type { InboundRepositories } from "./receive";
import { webhookDeliveries, type WebhookWorker } from "./worker";

export interface WebhookJobsOptions {
  db: Executor;
  jobs: JobsService;
  now: () => Date;
  /** Without one, signing secrets cannot be read: no delivery is sent, and webhooks are off. */
  secretBox?: SecretBox;
  allowPrivate: boolean;
  cronSecret?: string;
  payloadDays?: number;
  /** Whether this process runs jobs, and how; see WorkerMode. Without one, nothing is sent. */
  worker?: "loop" | "on-request" | "enqueue";
  /** Run due jobs soon, after an enqueue. */
  wake: () => void;
  drain: (options?: { budgetMs?: number }) => Promise<number>;
  /** To store what an import of past webhooks gives. Without it, nothing is imported. */
  repos?: InboundRepositories;
  fetch?: typeof fetch;
}

export function webhookJobs(options: WebhookJobsOptions): ModuleJobs & { webhooks: Webhooks } {
  const { db, jobs, now, secretBox, allowPrivate, worker } = options;
  const deliveries = worker && secretBox ? webhookDeliveries({ db, jobs, secretBox, now, allowPrivate }) : undefined;
  const sender: WebhookWorker | undefined = deliveries
    ? { drain: options.drain, wake: options.wake, sendNow: deliveries.sendNow }
    : undefined;
  const webhooks: Webhooks = {
    db,
    secretBox,
    worker: sender,
    allowPrivate,
    cronSecret: options.cronSecret,
    payloadDays: options.payloadDays,
    // A function sends only the first attempt itself. Without a scheduler, nothing would be retried.
    ...(worker === "on-request" && !options.cronSecret
      ? {
          warning:
            "Retries need a scheduler: set CRON_SECRET in the Vercel project and redeploy, so that Vercel Cron calls /internal/jobs/drain each minute. Until then, a failed delivery is not tried again.",
        }
      : {}),
  };
  return {
    kinds: [
      webhookCleanupKind({ db, payloadDays: options.payloadDays, now }),
      ...(deliveries ? [deliveries.kind] : []),
      ...(deliveries && options.repos
        ? [shopifyBackfillKind({ repos: options.repos, hooks: webhooks, jobs, now, fetch: options.fetch })]
        : []),
    ],
    schedules: [WEBHOOK_CLEANUP_SCHEDULE],
    webhooks,
  };
}
