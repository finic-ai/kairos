import type { StoredSecret } from "../../../db/schema";
import type { Executor } from "../../../platform/database";
import type { SecretBox } from "../../../platform/secrets";
import type { JobsService } from "../../../services/job.service";
import { WebhooksService } from "../../../services/webhook.service";
import { WebhookDeliveriesService, type DeliveryToSend } from "../../../services/webhook_delivery.service";
import { DELIVER_KIND, webhooksRepository } from "../repo";
import { createJobs, PermanentError, type JobKind } from "../../../platform/jobs/worker";
import { send as sendHttp, type SendResult } from "./send";
import { signedHeaders } from "./signing";

/** The wait before each attempt after the first: about 27 hours in all, with ±10% spread. */
export const RETRY_DELAYS_MS = [
  5_000,
  5 * 60_000,
  30 * 60_000,
  2 * 3_600_000,
  5 * 3_600_000,
  10 * 3_600_000,
  10 * 3_600_000,
];
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
export const DISABLE_AFTER_MS = 5 * 86_400_000;
export const LOG_DAYS = 30;

const SEND_TIMEOUT_MS = 10_000;
const BATCH = 50;
const PER_ENDPOINT = 5;

export interface DeliveryOptions {
  db: Executor;
  jobs: JobsService;
  secretBox: SecretBox;
  now: () => Date;
  allowPrivate: boolean;
  send?: typeof sendHttp;
}

export interface WebhookWorker {
  drain(options?: { budgetMs?: number }): Promise<number>;
  sendNow(deliveryId: string): Promise<SendResult & { delivered: boolean }>;
  wake(): void;
}

/** The secrets that sign now: the current one, and the old one while a rotation overlaps. */
export function signingSecrets(secretBox: SecretBox, stored: StoredSecret[], now: Date): string[] {
  return stored.filter((s) => !s.expires || new Date(s.expires) > now).map((s) => secretBox.decrypt(s));
}

export function webhookDeliveries(options: DeliveryOptions): {
  kind: JobKind<{ delivery_id: string }>;
  sendNow: WebhookWorker["sendNow"];
} {
  const { db, jobs, secretBox, now } = options;
  const send = options.send ?? sendHttp;

  async function attempt(delivery: DeliveryToSend, attempts: number, next?: Date) {
    const at = now();
    const body = JSON.stringify(delivery.payload);
    let headers: Record<string, string> = {};
    let result: SendResult;
    try {
      headers = signedHeaders(
        signingSecrets(secretBox, delivery.secrets, at),
        delivery.external_id,
        Math.floor(at.getTime() / 1000),
        body,
      );
      result = await send(delivery.url, headers, body, { allowPrivate: options.allowPrivate });
    } catch {
      // A secret that cannot be decrypted: KAIROS_ENCRYPTION_KEY is not the key it was encrypted with.
      result = {
        body: "",
        ms: 0,
        problem: "the signing secret cannot be read: KAIROS_ENCRYPTION_KEY is not the key it was made with",
      };
    }
    const delivered = result.status !== undefined && result.status >= 200 && result.status < 300;
    const finished = now();
    const shown = headers["webhook-signature"]
      ? { ...headers, "webhook-signature": headers["webhook-signature"].replace(/v1,[^ ]+/g, "v1,…") }
      : headers;
    const scope = { workspaceId: delivery.workspace_id, environmentId: delivery.environment_id };
    const deliveries = new WebhookDeliveriesService(db, scope);
    const endpoints = new WebhooksService(db, scope);
    const disable = (reason: string) =>
      webhooksRepository(db).update(
        scope.workspaceId,
        scope.environmentId,
        delivery.webhook_id,
        { enabled: false, disabledReason: reason },
        finished,
      );
    if (delivered) {
      await deliveries.recordAttempt(delivery.id, attempts, { ...result, delivered, headers: shown }, finished);
      await endpoints.markHealthy(delivery.webhook_id, finished);
      return { ...result, delivered, gone: false };
    }
    // 410 Gone: the receiver says the endpoint no longer exists.
    const gone = result.status === 410;
    await deliveries.recordAttempt(
      delivery.id,
      attempts,
      { ...result, delivered, headers: shown },
      finished,
      gone ? undefined : next,
    );
    const since = await endpoints.markFailing(delivery.webhook_id, finished);
    if (gone) await disable("The endpoint answered 410 Gone.");
    else if (finished.getTime() - since.getTime() >= DISABLE_AFTER_MS)
      await disable("Every delivery failed for 5 days.");
    return { ...result, delivered, gone };
  }

  return {
    kind: {
      kind: DELIVER_KIND,
      concurrency: BATCH,
      // At most a few requests in flight to one endpoint, so one slow receiver does not hold the rest.
      perGroup: PER_ENDPOINT,
      retryDelaysMs: RETRY_DELAYS_MS,
      timeoutMs: SEND_TIMEOUT_MS,
      async run({ delivery_id }, job) {
        const delivery = await WebhookDeliveriesService.findToSend(db, delivery_id);
        // Deleted with its endpoint, or finished: a job that runs again has nothing left to do.
        if (!delivery || delivery.status !== "pending") return;
        // Disabled since it was enqueued: it waits, with the other deliveries of the endpoint, until it is enabled again.
        if (!delivery.enabled) return jobs.pauseGroup(delivery.webhook_id, now());
        const result = await attempt(delivery, job.attempts, job.retryAt);
        if (result.delivered) return;
        const problem = result.problem ?? `answered ${result.status}`;
        throw result.gone ? new PermanentError(problem) : new Error(problem);
      },
    },
    async sendNow(deliveryId) {
      const delivery = await WebhookDeliveriesService.findToSend(db, deliveryId);
      if (!delivery) throw new Error(`No delivery ${deliveryId}`);
      const { gone: _gone, ...result } = await attempt(delivery, delivery.attempts + 1);
      return result;
    },
  };
}

export interface WorkerOptions extends DeliveryOptions {
  random?: () => number;
  log?: (message: string) => void;
  defer?: (work: Promise<unknown>) => void;
}

export function createWebhookWorker(options: WorkerOptions): WebhookWorker & { start(): void; stop(): Promise<void> } {
  const deliveries = webhookDeliveries(options);
  const runner = createJobs({
    repo: options.jobs,
    kinds: [deliveries.kind],
    now: options.now,
    random: options.random,
    log: options.log,
    defer: options.defer,
  });
  return {
    drain: runner.drain,
    wake: runner.wake,
    start: runner.start,
    stop: runner.stop,
    sendNow: deliveries.sendNow,
  };
}
