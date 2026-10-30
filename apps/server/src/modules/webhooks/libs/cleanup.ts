import type { Executor } from "../../../platform/database";
import type { JobKind, Schedule } from "../../../platform/jobs/worker";
import { WebhookDeliveriesService } from "../../../services/webhook_delivery.service";
import { LOG_DAYS } from "./worker";

/** Each hour: the delivery log older than LOG_DAYS goes, and payloads after `payloadDays`. */
export const WEBHOOK_CLEANUP_SCHEDULE: Schedule = { kind: "webhook.cleanup", everyMs: 3_600_000 };

export function webhookCleanupKind({
  db,
  payloadDays,
  now,
}: {
  db: Executor;
  payloadDays?: number;
  now: () => Date;
}): JobKind {
  return {
    kind: WEBHOOK_CLEANUP_SCHEDULE.kind,
    concurrency: 1,
    retryDelaysMs: [5 * 60_000],
    timeoutMs: 30_000,
    async run() {
      await WebhookDeliveriesService.cleanup(db, now(), LOG_DAYS, payloadDays);
    },
  };
}
