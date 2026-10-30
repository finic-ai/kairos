import type { ActionDefinition, EntityDefinition } from "@kairos/core";
import {
  bigint,
  boolean,
  foreignKey,
  index,
  integer,
  json,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { created, updated, environment, time } from "./columns";
import { workspace, environments } from "./accounts";

export const entities = pgTable(
  "entities",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    environmentId: environment(),
    type: text("type").notNull(),
    definition: json("definition").$type<EntityDefinition>().notNull(),
    created: created(),
    updated: updated(),
  },
  (t) => [
    foreignKey({
      name: "entities_environment_fk",
      columns: [t.workspaceId, t.environmentId],
      foreignColumns: [environments.workspaceId, environments.id],
    }).onDelete("cascade"),
    uniqueIndex("entities_type").on(t.workspaceId, t.environmentId, t.type),
  ],
);

/**
 * One row for each action: its live version. Every version, this one included, is also in
 * `definition_versions`, and a row there never changes. The fields that change no answer of
 * the model (the display name, the automatic switch) are columns here, not part of the
 * versioned definition.
 */
export const actions = pgTable(
  "actions",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    environmentId: environment(),
    name: text("name").notNull(),
    version: integer("version").notNull(),
    definition: json("definition")
      .$type<Omit<ActionDefinition, "version" | "displayName" | "automatic" | "automaticSince">>()
      .notNull(),
    displayName: text("display_name"),
    automatic: boolean("automatic").notNull().default(false),
    automaticSince: time("automatic_since"),
    created: created(),
    updated: updated(),
  },
  (t) => [
    foreignKey({
      name: "actions_environment_fk",
      columns: [t.workspaceId, t.environmentId],
      foreignColumns: [environments.workspaceId, environments.id],
    }).onDelete("cascade"),
    uniqueIndex("actions_name").on(t.workspaceId, t.environmentId, t.name),
  ],
);

/**
 * Every version of every versioned definition: actions now, workflows later. One helper,
 * `saveVersion`, is the only writer. See internal/designs/workflows.md, section 8.1.
 */
export const definitionVersions = pgTable(
  "definition_versions",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    environmentId: environment(),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    version: integer("version").notNull(),
    definition: json("definition").$type<Record<string, unknown>>().notNull(),
    created: created(),
    createdBy: text("created_by"),
  },
  (t) => [
    uniqueIndex("definition_versions_version").on(t.workspaceId, t.environmentId, t.kind, t.name, t.version),
    foreignKey({
      name: "definition_versions_environment_fk",
      columns: [t.workspaceId, t.environmentId],
      foreignColumns: [environments.workspaceId, environments.id],
    }).onDelete("cascade"),
  ],
);

/**
 * One row for each workflow: its live version, as for actions. The definition (the trigger
 * and the steps) is versioned in `definition_versions`. See internal/designs/workflows.md.
 */
export const workflows = pgTable(
  "workflows",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    environmentId: environment(),
    /** The key: what the API, the runs ("name@2") and the versions use. Made from the first name. */
    name: text("name").notNull(),
    /** The live version. 0 until the first publish: the workflow has a draft and no live version yet. */
    version: integer("version").notNull(),
    definition: json("definition").$type<Record<string, unknown>>().notNull(),
    triggerType: text("trigger_type").notNull(),
    /** The name people see ("Review payouts"). It can change; the key cannot. Not part of a version. */
    displayName: text("display_name"),
    /** Paused when false: the trigger starts no new runs. Not part of a version. */
    enabled: boolean("enabled").notNull().default(true),
    /** "draft" until the first publish, then "published", or "archived": an archived workflow starts no runs. */
    status: text("status").$type<"draft" | "published" | "archived">().notNull().default("draft"),
    publishedAt: time("published_at"),
    /** When the workflow's runs started to fail: set by the first failed run, cleared by a run that is done. */
    failingSince: time("failing_since"),
    /** Changes that are saved and not published: `{ trigger, steps }`. Runs never read it. */
    draft: json("draft").$type<Record<string, unknown>>(),
    /** For a webhook trigger: the hash of the token in its URL. The URL is shown once, when it is made. */
    hookTokenHash: text("hook_token_hash"),
    /** The token's last characters, to tell one URL from another. */
    hookTokenHint: text("hook_token_hint"),
    created: created(),
    updated: updated(),
  },
  (t) => [
    uniqueIndex("workflows_name").on(t.workspaceId, t.environmentId, t.name),
    uniqueIndex("workflows_hook_token").on(t.hookTokenHash),
    // One published decision workflow for each action: it makes the action's decisions.
    uniqueIndex("workflows_one_per_action")
      .on(t.workspaceId, t.environmentId, sql`(${t.definition} -> 'trigger' ->> 'action')`)
      .where(sql`trigger_type = 'decision' AND status = 'published'`),
    foreignKey({
      name: "workflows_environment_fk",
      columns: [t.workspaceId, t.environmentId],
      foreignColumns: [environments.workspaceId, environments.id],
    }).onDelete("cascade"),
    index("workflows_by_trigger").on(t.workspaceId, t.environmentId, t.triggerType),
  ],
);

/** One run of a workflow. The step log in `steps` is also the state that expressions read. */
export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    environmentId: environment(),
    /** The workflow it runs. Null only for a test run of a workflow that was never saved. */
    workflowId: text("workflow_id").references(() => workflows.id, { onDelete: "cascade" }),
    /** The workflow and the version the run started with, as "name@2"; "name@draft" for a test run. */
    workflow: text("workflow").notNull(),
    /** One run for one event, one scheduled time, one delivery: unique for the workflow. */
    key: text("key").notNull(),
    status: text("status")
      .$type<"queued" | "running" | "waiting" | "filtered" | "done" | "failed" | "cancelled">()
      .notNull(),
    trigger: jsonb("trigger").$type<Record<string, unknown>>().notNull(),
    /** A test run only: the unsaved definition it ran, which is in no version. */
    definition: jsonb("definition").$type<Record<string, unknown>>(),
    /** The step path of the next step to run. Null when no step is next. */
    cursor: text("cursor"),
    /** How many jobs the run has had: the number of its next job, whose key is "<run id>:<segment>". */
    segment: integer("segment").notNull().default(0),
    steps: jsonb("steps").$type<Record<string, unknown>[]>(),
    /** What the run gives: a Return step's value, else the output of the last step. Set when it ends. */
    output: jsonb("output"),
    error: text("error"),
    test: boolean("test").notNull().default(false),
    parentRunId: text("parent_run_id"),
    depth: integer("depth").notNull().default(0),
    created: created(),
    started: time("started"),
    finished: time("finished"),
  },
  (t) => [
    foreignKey({
      name: "workflow_runs_environment_fk",
      columns: [t.workspaceId, t.environmentId],
      foreignColumns: [environments.workspaceId, environments.id],
    }).onDelete("cascade"),
    uniqueIndex("workflow_runs_key").on(t.workspaceId, t.environmentId, t.workflowId, t.key),
    index("workflow_runs_by_workflow").on(t.workspaceId, t.environmentId, t.workflowId, t.created),
    index("workflow_runs_open")
      .on(t.workspaceId, t.environmentId, t.status)
      .where(sql`status IN ('queued', 'running', 'waiting')`),
  ],
);

export const dashboards = pgTable(
  "dashboards",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    environmentId: environment(),
    definition: jsonb("definition").$type<Record<string, unknown>>().notNull(),
    owner: text("owner"),
    created: created(),
    updated: updated(),
    /** The order they were made in, for two made at the same moment. */
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
  },
  (t) => [
    foreignKey({
      name: "dashboards_environment_fk",
      columns: [t.workspaceId, t.environmentId],
      foreignColumns: [environments.workspaceId, environments.id],
    }).onDelete("cascade"),
    index("dashboards_by_environment").on(t.workspaceId, t.environmentId),
  ],
);

export type EntityTypeRow = typeof entities.$inferSelect;
export type ActionRow = typeof actions.$inferSelect;
export type DefinitionVersionRow = typeof definitionVersions.$inferSelect;
export type WorkflowRow = typeof workflows.$inferSelect;
export type WorkflowRunRow = typeof workflowRuns.$inferSelect;
export type DashboardRow = typeof dashboards.$inferSelect;
