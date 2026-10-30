import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { created } from "./columns";
import { workspace } from "./accounts";

/** Where an activity came from. Only "dashboard", a person signed in to the console, is recorded today. */
export type ActivitySource = "dashboard" | "api_key" | "mcp";

/**
 * What a person did in a workspace: one row for each change, such as "api_key.created" or
 * "workflow.published". A row never changes.
 *
 * The log outlives what it names. `environment_id`, `user_id` and `resource_id` are not foreign
 * keys, so a deleted sandbox, account or workflow keeps its history; only the workspace takes its
 * log with it. `environment_id` is null for a change to the workspace itself: its members, its
 * invites, its environments.
 */
export const activities = pgTable(
  "activities",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    environmentId: text("environment_id"),
    source: text("source").$type<ActivitySource>().notNull(),
    userId: text("user_id"),
    apiKeyId: text("api_key_id"),
    /** "<resource>.<verb>": "api_key.created", "case.resolved". */
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id"),
    details: jsonb("details")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    ip: text("ip"),
    userAgent: text("user_agent"),
    created: created(),
  },
  (t) => [
    index("activities_by_workspace").on(t.workspaceId, t.created),
    index("activities_by_environment").on(t.workspaceId, t.environmentId, t.created),
    index("activities_by_user").on(t.workspaceId, t.userId, t.created),
    index("activities_by_resource").on(t.workspaceId, t.resourceType, t.resourceId, t.created),
  ],
);

export type ActivityRow = typeof activities.$inferSelect;
