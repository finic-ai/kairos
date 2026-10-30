import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, index, jsonb, pgTable, text, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { time, created, updated } from "./columns";

export const workspace = () =>
  text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" });
export const user = () =>
  text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" });

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    firstName: text("first_name"),
    lastName: text("last_name"),
    displayName: text("display_name"),
    status: text("status").$type<"active" | "disabled">().notNull().default("active"),
    auth: jsonb("auth")
      .$type<{ provider: "native" | "supabase" | "cognito"; strategy?: "email_password" | "google" }>()
      .notNull(),
    settings: jsonb("settings")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    passwordHash: text("password_hash"),
    subjectId: text("subject_id"),
    created: created(),
    updated: updated(),
    lastLogin: time("last_login"),
  },
  (t) => [uniqueIndex("users_email").on(t.email), uniqueIndex("users_subject_id").on(t.subjectId)],
);

export const workspaces = pgTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    status: text("status").$type<"active" | "suspended">().notNull().default("active"),
    settings: jsonb("settings")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    created: created(),
    updated: updated(),
  },
  (t) => [uniqueIndex("workspaces_slug").on(t.slug)],
);

export const environments = pgTable(
  "environments",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    name: text("name").notNull(),
    kind: text("kind").$type<"production" | "sandbox">().notNull(),
    created: created(),
    updated: updated(),
  },
  (t) => [
    check("environments_kind", sql`${t.kind} IN ('production', 'sandbox')`),
    uniqueIndex("environments_production")
      .on(t.workspaceId)
      .where(sql`kind = 'production'`),
    uniqueIndex("environments_name").on(t.workspaceId, sql`lower(${t.name})`),
    unique("environments_workspace_id").on(t.workspaceId, t.id),
  ],
);

export const memberships = pgTable(
  "memberships",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    userId: user(),
    role: text("role").$type<"owner" | "admin" | "member">().notNull(),
    status: text("status").$type<"active" | "suspended">().notNull().default("active"),
    permissions: jsonb("permissions")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`),
    created: created(),
    updated: updated(),
    /** The order people joined in, for two who joined at the same moment. */
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
  },
  (t) => [uniqueIndex("memberships_user").on(t.workspaceId, t.userId), index("memberships_by_user").on(t.userId)],
);

export const invites = pgTable(
  "invites",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    email: text("email").notNull(),
    role: text("role").$type<"owner" | "admin" | "member">().notNull(),
    tokenHash: text("token_hash").notNull(),
    invitedBy: text("invited_by").notNull(),
    created: created(),
    expires: time("expires").notNull(),
    accepted: time("accepted"),
    revoked: time("revoked"),
  },
  (t) => [uniqueIndex("invites_token").on(t.tokenHash), index("invites_by_workspace").on(t.workspaceId)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    userId: user(),
    created: created(),
    expires: time("expires").notNull(),
  },
  (t) => [uniqueIndex("sessions_token").on(t.tokenHash), index("sessions_by_user").on(t.userId)],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    environmentId: text("environment_id").notNull(),
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    name: text("name").notNull(),
    kind: text("kind").$type<"secret" | "public">().notNull(),
    keyHash: text("key_hash").notNull(),
    hint: text("hint").notNull(),
    allowedIps: jsonb("allowed_ips").$type<string[]>().notNull(),
    allowedOrigins: jsonb("allowed_origins").$type<string[]>().notNull(),
    createdBy: text("created_by"),
    created: created(),
    updated: updated(),
    lastUsed: time("last_used"),
    revoked: time("revoked"),
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
  },
  (t) => [
    uniqueIndex("api_keys_hash").on(t.keyHash),
    index("api_keys_by_workspace").on(t.workspaceId),
    index("api_keys_by_environment").on(t.environmentId),
    foreignKey({
      columns: [t.workspaceId, t.environmentId],
      foreignColumns: [environments.workspaceId, environments.id],
    }).onDelete("cascade"),
  ],
);

export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type EnvironmentRow = typeof environments.$inferSelect;
export type InviteRow = typeof invites.$inferSelect;
export type MembershipRow = typeof memberships.$inferSelect;
export type NewApiKeyRow = typeof apiKeys.$inferInsert;
