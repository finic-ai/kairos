import { sql } from "drizzle-orm";
import { webhooks, type WebhookRow } from "../db/schema";
import type { Executor } from "../platform/database";
import { DatabaseService } from "../platform/orm";

export class WebhooksService extends DatabaseService<"webhooks"> {
  constructor(db: Executor, scope: { workspaceId: string; environmentId: string }) {
    super(db, "webhooks", scope);
  }

  /** The URL token selects the source, in any active workspace. */
  static async findSourceByToken(db: Executor, tokenHash: string): Promise<WebhookRow | null> {
    const found = await db.query.webhooks.findFirst({
      where: { tokenHash, direction: "in" },
      with: { workspace: { columns: { status: true } } },
    });
    if (!found || found.workspace.status !== "active") return null;
    const { workspace: _, ...row } = found;
    return row;
  }

  list(direction?: "in" | "out"): Promise<WebhookRow[]> {
    return this.findMany({ where: direction ? { direction } : {}, orderBy: { created: "asc", id: "asc" } });
  }

  listEnabledEndpoints(): Promise<WebhookRow[]> {
    return this.findMany({ where: { direction: "out", enabled: true } });
  }

  async markHealthy(id: string, now: Date): Promise<void> {
    await this.updateActivity(id, { failingSince: null, lastDelivery: now });
  }

  /** When the endpoint started failing: `now`, or the earlier moment it has failed since. */
  async markFailing(id: string, now: Date): Promise<Date> {
    const r = await this.updateActivity(id, {
      failingSince: sql`COALESCE(${webhooks.failingSince}, ${now})`,
      lastDelivery: now,
    });
    return r?.failingSince ?? now;
  }
}
