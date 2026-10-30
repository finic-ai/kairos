import type { Executor } from "../../platform/database";
import type { WebhookRow } from "../../db/schema";
import { JobsService } from "../../services/job.service";
import { newId } from "../../platform/crypto";
import type { Changes } from "../../platform/orm";
import { WebhooksService } from "../../services/webhook.service";
import { WebhookDeliveriesService } from "../../services/webhook_delivery.service";
import { envelope, matches, type OutboundConfig, type OutboundEvent, type OutboxRepository } from "./types";

/** The job that sends one outbound delivery. Its key is the delivery id, its group the endpoint. */
export const DELIVER_KIND = "webhook.deliver";
export const deliverJob = (d: { id: string; workspaceId: string; environmentId: string; webhookId: string }) => ({
  kind: DELIVER_KIND,
  key: d.id,
  payload: { delivery_id: d.id },
  group: d.webhookId,
  workspaceId: d.workspaceId,
  environmentId: d.environmentId,
});

/**
 * Write the deliveries of an outbound event: one for each enabled endpoint that wants it.
 * Called inside the transaction that saves the thing the event is about, so the two exist
 * together or not at all.
 */
export async function enqueueOutbound(
  tx: Executor,
  workspaceId: string,
  environmentId: string,
  event: OutboundEvent,
  now: Date,
): Promise<number> {
  const scope = { workspaceId, environmentId };
  const endpoints = await new WebhooksService(tx, scope).listEnabledEndpoints();
  const wanted = endpoints.filter((w) => matches(w.config as OutboundConfig, event));
  if (wanted.length === 0) return 0;
  // One message id for the event: the same at every endpoint and on every attempt.
  const messageId = newId("msg");
  const deliveries = await new WebhookDeliveriesService(tx, scope).createMany(
    wanted.map((w) => ({
      webhookId: w.id,
      direction: "out" as const,
      status: "pending",
      type: event.type,
      externalId: messageId,
      subjectRef: event.subjectRef ?? null,
      payload: envelope(messageId, workspaceId, now.toISOString(), event, w.config as OutboundConfig, environmentId),
      attempts: 0,
      nextAttempt: now,
    })),
    now,
  );
  await new JobsService(tx).enqueueMany(deliveries.map(deliverJob), now);
  return wanted.length;
}

export function outboxRepository(db: Executor): OutboxRepository {
  return {
    enqueue: (workspaceId, environmentId, event, now) => enqueueOutbound(db, workspaceId, environmentId, event, now),
  };
}

/** The writes of a webhook that change the jobs of its deliveries too, in one transaction. */
export function webhooksRepository(db: Executor) {
  return {
    /** With `enabled`, the waiting deliveries of the endpoint stop, or start again at `now`. */
    async update(
      workspaceId: string,
      environmentId: string,
      id: string,
      changes: Changes<"webhooks">,
      now: Date,
    ): Promise<WebhookRow | null> {
      return db.transaction(async (tx) => {
        const r = await new WebhooksService(tx, { workspaceId, environmentId }).update(id, changes, now);
        if (r && changes.enabled === false) await new JobsService(tx).pauseGroup(id, now);
        if (r && changes.enabled === true) await new JobsService(tx).resumeGroup(id, now);
        return r;
      });
    },

    async delete(workspaceId: string, environmentId: string, id: string): Promise<boolean> {
      return db.transaction(async (tx) => {
        const deleted = await new WebhooksService(tx, { workspaceId, environmentId }).delete(id);
        // Its deliveries go with it, so the jobs that would send them have nothing to do.
        if (deleted) await new JobsService(tx).deleteGroup(id);
        return deleted;
      });
    },

    /** Send again: one delivery, or every failed delivery of a webhook since a moment. A resend keeps the message id. */
    async resend(
      workspaceId: string,
      environmentId: string,
      webhookId: string,
      which: { delivery: string } | { since?: string },
      now: Date,
    ): Promise<string[]> {
      return db.transaction(async (tx) => {
        const ids = await new WebhookDeliveriesService(tx, { workspaceId, environmentId }).resetForResend(
          webhookId,
          which,
          now,
        );
        await new JobsService(tx).requeueMany(
          ids.map((id) => deliverJob({ id, workspaceId, environmentId, webhookId })),
          now,
        );
        return ids;
      });
    },
  };
}

export type WebhooksRepository = ReturnType<typeof webhooksRepository>;
