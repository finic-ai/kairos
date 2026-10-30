import { sql } from "drizzle-orm";
import { webhookDeliveries, type StoredSecret, type WebhookDeliveryRow } from "../db/schema";
import type { Executor } from "../platform/database";
import { DatabaseService } from "../platform/orm";
import { rows } from "../platform/sql";

const DAY = 86_400_000;
/** How long an inbound payload is kept. It is personal data; the row stays. KAIROS_WEBHOOK_PAYLOAD_DAYS changes it. */
export const INBOUND_PAYLOAD_DAYS = 7;

export interface DeliveryToSend {
  id: string;
  workspace_id: string;
  environment_id: string;
  webhook_id: string;
  external_id: string;
  payload: unknown;
  status: string;
  /** Before the attempt that is about to be made. */
  attempts: number;
  url: string;
  secrets: StoredSecret[];
  enabled: boolean;
}

export interface AttemptResult {
  delivered: boolean;
  status?: number;
  body: string;
  ms: number;
  problem?: string;
  headers: Record<string, string>;
}

export interface ReplayOutcome {
  status: string;
  type?: string | null;
  externalId?: string | null;
  problem?: string | null;
  result?: unknown;
}

export class WebhookDeliveriesService extends DatabaseService<"webhookDeliveries"> {
  constructor(db: Executor, scope: { workspaceId: string; environmentId: string }) {
    super(db, "webhookDeliveries", scope);
  }

  /** The worker has the id of the delivery, from its job: the id selects it, in any workspace. */
  static async findToSend(db: Executor, id: string): Promise<DeliveryToSend | null> {
    const r = await db.query.webhookDeliveries.findFirst({
      where: { id, direction: "out" },
      with: { webhook: { columns: { url: true, secrets: true, enabled: true } } },
    });
    return r
      ? {
          id: r.id,
          workspace_id: r.workspaceId,
          environment_id: r.environmentId,
          webhook_id: r.webhookId,
          external_id: r.externalId!,
          payload: r.payload,
          status: r.status,
          attempts: r.attempts,
          url: r.webhook.url!,
          secrets: r.webhook.secrets,
          enabled: r.webhook.enabled,
        }
      : null;
  }

  /**
   * In every workspace: delete outbound deliveries older than `days`, and drop the payload (personal
   * data) of inbound ones older than `inboundPayloadDays`. An inbound row stays: it is the record that a delivery came.
   */
  static async cleanup(
    db: Executor,
    now: Date,
    days: number,
    inboundPayloadDays = INBOUND_PAYLOAD_DAYS,
  ): Promise<number> {
    const found = await rows<{ id: string }>(
      db,
      sql`DELETE FROM webhook_deliveries WHERE direction = 'out' AND created < ${new Date(now.getTime() - days * DAY)} AND status <> 'pending' RETURNING id`,
    );
    await db.execute(
      sql`UPDATE webhook_deliveries SET payload = NULL, headers = NULL, updated = ${now}
          WHERE direction = 'in' AND payload IS NOT NULL AND created < ${new Date(now.getTime() - inboundPayloadDays * DAY)}`,
    );
    return found.length;
  }

  list(
    webhookId: string,
    filter: { status?: string; type?: string; limit: number; offset: number },
  ): Promise<WebhookDeliveryRow[]> {
    return this.findMany({
      where: {
        webhookId,
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.type ? { type: filter.type } : {}),
      },
      orderBy: { created: "desc", id: "desc" },
      limit: filter.limit,
      offset: filter.offset,
    });
  }

  /** The latest 100 about one subject, such as `decision:kdec_…`, with the webhook each went to. */
  listAbout(subjectRef: string) {
    return this.findMany({
      where: { subjectRef },
      with: { webhook: { columns: { name: true, url: true } } },
      orderBy: { created: "desc" },
      limit: 100,
    });
  }

  findInWebhook(webhookId: string, id: string): Promise<WebhookDeliveryRow | null> {
    return this.findFirst({ where: { webhookId, id } });
  }

  /** For each webhook: its deliveries since `since`, and how many of them failed or are being retried. */
  async countsSince(since: Date): Promise<Map<string, { total: number; failed: number }>> {
    const counts = await rows<{ webhook_id: string; total: number; failed: number }>(
      this.db,
      sql`SELECT webhook_id, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status IN ('failed', 'rejected', 'no_entity') OR (status = 'pending' AND attempts > 0))::int AS failed
          FROM webhook_deliveries WHERE workspace_id = ${this.scope.workspaceId} AND environment_id = ${this.scope.environmentId} AND created > ${since} GROUP BY webhook_id`,
    );
    return new Map(counts.map((c) => [c.webhook_id, { total: c.total, failed: c.failed }]));
  }

  /** `next`: when to try again. Without it, a failed attempt is the last one. */
  async recordAttempt(id: string, attempts: number, result: AttemptResult, now: Date, next?: Date): Promise<void> {
    await this.update(
      id,
      {
        attempts,
        status: result.delivered ? "delivered" : next ? "pending" : "failed",
        nextAttempt: result.delivered ? null : (next ?? null),
        responseStatus: result.status ?? null,
        responseBody: result.body || null,
        responseMs: result.ms,
        problem: result.delivered ? null : (result.problem ?? null),
        headers: result.headers,
        finished: result.delivered || !next ? now : null,
      },
      now,
    );
  }

  async recordReplay(id: string, outcome: ReplayOutcome, now: Date): Promise<void> {
    await this.update(
      id,
      {
        status: outcome.status,
        type: outcome.type ?? null,
        externalId: outcome.externalId ?? null,
        problem: outcome.problem ?? null,
        result: outcome.result ?? null,
        attempts: sql`${webhookDeliveries.attempts} + 1`,
        finished: now,
      },
      now,
    );
  }

  /** Inbound deliveries whose payload is still kept: one, or the oldest 500 that failed or found no entity. */
  listReplayable(webhookId: string, which: { delivery: string } | { failed: true }) {
    return this.findMany({
      where: {
        webhookId,
        direction: "in",
        payload: { isNotNull: true },
        ...("delivery" in which ? { id: which.delivery } : { status: { in: ["failed", "no_entity"] } }),
      },
      columns: { id: true, payload: true, headers: true, created: true },
      orderBy: { created: "asc" },
      limit: 500,
    });
  }

  /** Make outbound deliveries pending again, from no attempts: one, or every failed one since a moment. Returns their ids. */
  async resetForResend(
    webhookId: string,
    which: { delivery: string } | { since?: string },
    now: Date,
  ): Promise<string[]> {
    const reset = await this.updateMany(
      {
        webhookId,
        direction: "out",
        ...("delivery" in which
          ? { id: which.delivery, status: { ne: "pending" } }
          : { status: "failed", ...(which.since ? { created: { gte: new Date(which.since) } } : {}) }),
      },
      { status: "pending", attempts: 0, nextAttempt: now, finished: null },
      now,
    );
    return reset.map((r) => r.id);
  }
}
