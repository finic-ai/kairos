import type { Webhooks } from "../../../context";
import type { WebhookRow } from "../../../db/schema";
import type { SecretBox } from "../../../platform/secrets";
import { PermanentError, type JobKind, type JobRun } from "../../../platform/jobs/worker";
import { JobsService, type NewJob } from "../../../services/job.service";
import { WebhooksService } from "../../../services/webhook.service";
import { WebhookDeliveriesService } from "../../../services/webhook_delivery.service";
import type { InboundConfig } from "../types";
import { runDelivery, type InboundRepositories } from "./receive";
import {
  DISPUTES_PAGE,
  DISPUTES_QUERY,
  ORDERS_PAGE,
  ORDERS_QUERY,
  ShopifyError,
  accessToken,
  disputeDeliveries,
  orderDeliveries,
  shopifyClient,
  type Page,
  type PastDelivery,
  type ShopifyCredentials,
  type ShopifyDispute,
  type ShopifyOrder,
} from "./shopify";

/**
 * Each job imports one page and enqueues the job of the next page, so that a page fits in the
 * time a function has after its answer. The last job of a run, with phase `done`, keeps the totals.
 */
export const BACKFILL_KIND = "webhook.shopify_backfill";

export interface BackfillCounts {
  orders: number;
  disputes: number;
  stored: number;
  duplicate: number;
  failed: number;
}

export interface BackfillPayload {
  source: string;
  run: string;
  step: number;
  since: string;
  started: string;
  phase: "orders" | "disputes" | "done";
  cursor: string | null;
  counts: BackfillCounts;
}

export function shopifyCredentials(shopify: NonNullable<InboundConfig["shopify"]>, box: SecretBox): ShopifyCredentials {
  return shopify.token
    ? { token: box.decrypt(shopify.token) }
    : { clientId: shopify.client_id!, clientSecret: box.decrypt(shopify.client_secret!) };
}

export const backfillPrefix = (source: string) => `${source}:`;

export function backfillJob(scope: { workspaceId: string; environmentId: string }, payload: BackfillPayload): NewJob {
  return {
    kind: BACKFILL_KIND,
    key: `${backfillPrefix(payload.source)}${payload.run}:${payload.step}`,
    payload: payload as unknown as Record<string, unknown>,
    // Disabling the source pauses its import, and deleting it deletes the import.
    group: payload.source,
    ...scope,
  };
}

export interface BackfillOptions {
  repos: InboundRepositories;
  hooks: Webhooks;
  jobs: JobsService;
  now: () => Date;
  fetch?: typeof fetch;
}

export function shopifyBackfillKind({
  repos,
  hooks,
  jobs,
  now,
  fetch: fetchFn,
}: BackfillOptions): JobKind<BackfillPayload> {
  async function store(source: WebhookRow, delivery: PastDelivery, counts: BackfillCounts) {
    const config = source.config as InboundConfig;
    const headers = {
      "x-shopify-topic": delivery.topic,
      "x-shopify-shop-domain": config.shopify!.shop,
    };
    const at = new Date(delivery.at);
    const outcome = await runDelivery(repos, hooks, source, delivery.body, headers, at, now());
    if (outcome.status === "stored") counts.stored++;
    else if (outcome.status === "duplicate") counts.duplicate++;
    else if (outcome.status !== "ignored") {
      counts.failed++;
      // Kept with its payload, so that "Run failed again" can store it after the mapping is corrected.
      const scope = { workspaceId: source.workspaceId, environmentId: source.environmentId };
      await new WebhookDeliveriesService(hooks.db, scope).create(
        {
          webhookId: source.id,
          direction: "in",
          status: outcome.status,
          type: delivery.topic,
          externalId: String(delivery.body.id ?? ""),
          payload: delivery.body,
          headers,
          problem: outcome.problem,
          result: outcome.result,
          attempts: 1,
          finished: now(),
        },
        now(),
      );
    }
  }

  return {
    kind: BACKFILL_KIND,
    concurrency: 1,
    perGroup: 1,
    retryDelaysMs: [10_000, 60_000, 5 * 60_000, 30 * 60_000],
    timeoutMs: 15_000,
    async run(payload: BackfillPayload, job: JobRun) {
      if (payload.phase === "done") return;
      const scope = { workspaceId: job.workspaceId!, environmentId: job.environmentId! };
      const source = await new WebhooksService(hooks.db, scope).findById(payload.source);
      if (!source) return;
      const config = source.config as InboundConfig;
      if (!config.shopify) throw new PermanentError("The shop is not connected to the source any more.");
      if (!hooks.secretBox)
        throw new Error("KAIROS_ENCRYPTION_KEY is not set, so the shop's credentials cannot be read.");
      const { shop } = config.shopify;
      const credentials = shopifyCredentials(config.shopify, hooks.secretBox);

      const counts = { ...payload.counts };
      const variables = { after: payload.cursor };
      let page: Page<unknown>;
      try {
        const client = shopifyClient(shop, await accessToken(shop, credentials, fetchFn), fetchFn);
        if (payload.phase === "orders") {
          const { orders } = await client<{ orders: Page<ShopifyOrder> }>(ORDERS_QUERY, {
            ...variables,
            first: ORDERS_PAGE,
            query: `created_at:>='${payload.since}'`,
          });
          page = orders;
          // In time order, so that a refund finds the order it is about.
          const deliveries = orders.nodes.flatMap(orderDeliveries).sort((a, b) => a.at.localeCompare(b.at));
          for (const d of deliveries) await store(source, d, counts);
          counts.orders += orders.nodes.length;
        } else {
          const { disputes } = await client<{ disputes: Page<ShopifyDispute> }>(DISPUTES_QUERY, {
            ...variables,
            first: DISPUTES_PAGE,
            query: `initiated_at:>='${payload.since}'`,
          });
          page = disputes;
          const deliveries = disputes.nodes.flatMap(disputeDeliveries).sort((a, b) => a.at.localeCompare(b.at));
          for (const d of deliveries) await store(source, d, counts);
          counts.disputes += disputes.nodes.length;
        }
      } catch (cause) {
        if (cause instanceof ShopifyError && cause.permanent) throw new PermanentError(cause.message);
        throw cause;
      }

      const more = page.pageInfo.hasNextPage && page.pageInfo.endCursor;
      const next: BackfillPayload = {
        ...payload,
        step: payload.step + 1,
        counts,
        ...(more
          ? { cursor: page.pageInfo.endCursor }
          : payload.phase === "orders"
            ? { phase: "disputes", cursor: null }
            : { phase: "done", cursor: null }),
      };
      await jobs.enqueue(backfillJob(scope, next), now());
    },
  };
}
