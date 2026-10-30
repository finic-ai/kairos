import { sql } from "drizzle-orm";
import { boolean, foreignKey, index, integer, json, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { time, created, updated, environment } from "./columns";
import { workspace, environments } from "./accounts";
import type { InboundConfig, OutboundConfig } from "../../modules/webhooks/types";

/**
 * A webhook in either direction. `in`: a URL that Kairos gives to a provider, which sends events
 * to it. `out`: a URL that Kairos calls when something happens. A column used by one direction
 * only is null for the other.
 */
export const webhooks = pgTable(
  "webhooks",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    environmentId: environment(),
    direction: text("direction").$type<"in" | "out">().notNull(),
    name: text("name").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    disabledReason: text("disabled_reason"),
    /** in: the provider's secrets, to verify. out: ours, to sign. Encrypted, never returned. */
    secrets: jsonb("secrets").$type<StoredSecret[]>().notNull(),
    tokenHash: text("token_hash"),
    tokenHint: text("token_hint"),
    url: text("url"),
    /** in: the preset, the verification and the mapping. out: the event types and the filters. `json`: a mapping is in an order. */
    config: json("config").$type<InboundConfig | OutboundConfig>().notNull(),
    failingSince: time("failing_since"),
    lastDelivery: time("last_delivery"),
    createdBy: text("created_by"),
    created: created(),
    updated: updated(),
  },
  (t) => [
    foreignKey({
      name: "webhooks_environment_fk",
      columns: [t.workspaceId, t.environmentId],
      foreignColumns: [environments.workspaceId, environments.id],
    }).onDelete("cascade"),
    index("webhooks_by_workspace").on(t.workspaceId, t.environmentId, t.direction),
    uniqueIndex("webhooks_token").on(t.tokenHash),
  ],
);

export interface StoredSecret {
  ciphertext: string;
  iv: string;
  tag: string;
  hint: string;
  added: string;
  expires?: string;
}

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    environmentId: environment(),
    webhookId: text("webhook_id")
      .notNull()
      .references(() => webhooks.id, { onDelete: "cascade" }),
    direction: text("direction").$type<"in" | "out">().notNull(),
    status: text("status").notNull(),
    type: text("type"),
    externalId: text("external_id"),
    subjectRef: text("subject_ref"),
    /** As received, or as sent. `json`: shown exactly as it was. */
    payload: json("payload"),
    headers: jsonb("headers").$type<Record<string, string>>(),
    problem: text("problem"),
    result: jsonb("result"),
    attempts: integer("attempts").notNull().default(0),
    nextAttempt: time("next_attempt"),
    responseStatus: integer("response_status"),
    responseBody: text("response_body"),
    responseMs: integer("response_ms"),
    created: created(),
    updated: updated(),
    finished: time("finished"),
  },
  (t) => [
    foreignKey({
      name: "webhook_deliveries_environment_fk",
      columns: [t.workspaceId, t.environmentId],
      foreignColumns: [environments.workspaceId, environments.id],
    }).onDelete("cascade"),
    index("webhook_deliveries_log").on(t.workspaceId, t.environmentId, t.webhookId, t.created),
    index("webhook_deliveries_by_status").on(t.workspaceId, t.environmentId, t.webhookId, t.status, t.created),
    index("webhook_deliveries_due")
      .on(t.nextAttempt)
      .where(sql`status = 'pending'`),
    index("webhook_deliveries_by_subject")
      .on(t.workspaceId, t.environmentId, t.subjectRef)
      .where(sql`subject_ref IS NOT NULL`),
    index("webhook_deliveries_by_age").on(t.created),
  ],
);

export type WebhookRow = typeof webhooks.$inferSelect;
export type NewWebhookRow = typeof webhooks.$inferInsert;
export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect;
