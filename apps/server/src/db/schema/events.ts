import { sql } from "drizzle-orm";
import { foreignKey, index, json, jsonb, pgTable, primaryKey, text, uniqueIndex } from "drizzle-orm/pg-core";
import { time, created, updated, environment } from "./columns";
import { workspace, environments } from "./accounts";

/**
 * Where an event sits in a trace: the span it records, as in OpenTelemetry. The event's `ts` is
 * when the span started. For the console only: a decision does not read it.
 */
export interface EventTrace {
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  name?: string;
  /** When the span ended. */
  end?: string;
  status?: "ok" | "error";
}

export const events = pgTable(
  "events",
  {
    /** "evt_…": Kairos's id. Not in the API, which shows `external_id` as the event's id. */
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    environmentId: environment(),
    /** The id the customer sent. An event with an id that was sent before is a duplicate. */
    externalId: text("external_id").notNull(),
    type: text("type").notNull(),
    ts: time("ts").notNull(),
    entities: json("entities").$type<Record<string, string>>().notNull(),
    properties: json("properties").$type<Record<string, unknown>>().notNull(),
    universalId: text("universal_id"),
    status: text("status"),
    sessionId: text("session_id"),
    /**
     * How it came: "key" (a secret key), "public" (a public key), "webhook" (an inbound webhook)
     * or "console". An automatic decision starts only from one that a server sent: not "public",
     * whose key is in a web page. Null on events from before it was kept.
     */
    via: text("via"),
    /**
     * Provenance and other facts about the row that are not fields of the record itself: for an
     * event a workflow made, `{ workflow_run_id }`; for an event sent with a span, `{ trace }`.
     */
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** When the server got the event, which is not when it happened (`ts`). Usage counts by it. */
    created: created(),
  },
  (t) => [
    foreignKey({
      name: "events_environment_fk",
      columns: [t.workspaceId, t.environmentId],
      foreignColumns: [environments.workspaceId, environments.id],
    }).onDelete("cascade"),
    uniqueIndex("events_external_id").on(t.workspaceId, t.environmentId, t.externalId),
    index("events_by_time").on(t.workspaceId, t.environmentId, t.ts),
    index("events_by_type").on(t.workspaceId, t.environmentId, t.type, t.ts),
    index("events_by_universal_id").on(t.workspaceId, t.environmentId, t.universalId, t.ts),
    index("events_by_created").on(t.workspaceId, t.environmentId, t.created),
    index("events_by_session").on(t.workspaceId, t.environmentId, t.sessionId, t.ts),
    index("events_properties_gin").using("gin", sql`(${t.properties}::jsonb)`),
  ],
);

export const eventEntities = pgTable(
  "event_entities",
  {
    workspaceId: workspace(),
    environmentId: environment(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    ts: time("ts").notNull(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    created: created(),
  },
  (t) => [
    foreignKey({
      name: "event_entities_environment_fk",
      columns: [t.workspaceId, t.environmentId],
      foreignColumns: [environments.workspaceId, environments.id],
    }).onDelete("cascade"),
    primaryKey({
      name: "event_entities_scope_pk",
      columns: [t.workspaceId, t.environmentId, t.entityType, t.entityId, t.ts, t.eventId],
    }),
    index("event_entities_by_event").on(t.eventId),
  ],
);

export const objects = pgTable(
  "objects",
  {
    /** "obj_…": Kairos's id. Not in the API, which shows `external_id` as the entity's id. */
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    environmentId: environment(),
    type: text("type").notNull(),
    externalId: text("external_id").notNull(),
    properties: json("properties").$type<Record<string, unknown>>().notNull(),
    /** Property → the time of the event that set it, so an older event does not undo a newer one. */
    setAt: jsonb("set_at")
      .$type<Record<string, string>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** The time of the oldest event about it, which can be before `created`. */
    firstSeen: time("first_seen").notNull(),
    /** Provenance and other facts about the row that are not properties of the entity. */
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    created: created(),
    updated: updated(),
  },
  (t) => [
    foreignKey({
      name: "objects_environment_fk",
      columns: [t.workspaceId, t.environmentId],
      foreignColumns: [environments.workspaceId, environments.id],
    }).onDelete("cascade"),
    uniqueIndex("objects_external_id").on(t.workspaceId, t.environmentId, t.type, t.externalId),
    // For "entities where a property is this value" and "entities that have this property". In lower
    // case, because "is" does not look at upper and lower case.
    index("objects_properties_gin").using("gin", sql`(lower(${t.properties}::text)::jsonb)`),
  ],
);

export const labels = pgTable(
  "labels",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    environmentId: environment(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    label: text("label").notNull(),
    ts: time("ts").notNull(),
    properties: jsonb("properties").$type<Record<string, unknown>>().notNull(),
    /** Provenance and other facts about the row that are not properties of the label. */
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    created: created(),
    updated: updated(),
  },
  (t) => [
    foreignKey({
      name: "labels_environment_fk",
      columns: [t.workspaceId, t.environmentId],
      foreignColumns: [environments.workspaceId, environments.id],
    }).onDelete("cascade"),
    uniqueIndex("labels_by_entity").on(t.workspaceId, t.environmentId, t.entityType, t.entityId, t.label),
    index("labels_by_time").on(t.workspaceId, t.environmentId, t.ts),
  ],
);
