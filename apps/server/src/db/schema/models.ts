import type { ModelVersionDefinition } from "@kairos/core";
import { bytea, foreignKey, index, integer, json, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { created, updated, environment, time } from "./columns";
import { workspace, environments } from "./accounts";

/** Built-in models, such as grayson-1, have no row: the server lists them from code. */
export const models = pgTable(
  "models",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    environmentId: environment(),
    /** Never changes: steps refer to a model by it, in every environment. */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    /** Also in the definition: a column so that the builder can list the models of one kind. */
    kind: text("kind").$type<"scoring">().notNull(),
    version: integer("version").notNull(),
    /** The latest version's definition, so that a list needs no join to `definition_versions`. */
    definition: json("definition").$type<ModelVersionDefinition>().notNull(),
    status: text("status").$type<"active" | "archived">().notNull().default("active"),
    archivedAt: time("archived_at"),
    created: created(),
    updated: updated(),
  },
  (t) => [
    foreignKey({
      name: "models_environment_fk",
      columns: [t.workspaceId, t.environmentId],
      foreignColumns: [environments.workspaceId, environments.id],
    }).onDelete("cascade"),
    uniqueIndex("models_slug").on(t.workspaceId, t.environmentId, t.slug),
    index("models_by_kind").on(t.workspaceId, t.environmentId, t.kind, t.status),
  ],
);

/**
 * By the SHA-256 of the model's JSON before gzip, which is the same for the same model in any
 * environment. A list must not select `file` or `samples`.
 */
export const modelArtifacts = pgTable(
  "model_artifacts",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    environmentId: environment(),
    sha256: text("sha256").notNull(),
    format: text("format").$type<"xgboost-json" | "logistic-json">().notNull(),
    file: bytea("file").notNull(),
    size: integer("size").notNull(),
    storedSize: integer("stored_size").notNull(),
    /** The samples of the first upload of this file: a later upload of it keeps them. */
    samples: bytea("samples").notNull(),
    sampleCount: integer("sample_count").notNull(),
    created: created(),
  },
  (t) => [
    foreignKey({
      name: "model_artifacts_environment_fk",
      columns: [t.workspaceId, t.environmentId],
      foreignColumns: [environments.workspaceId, environments.id],
    }).onDelete("cascade"),
    uniqueIndex("model_artifacts_sha256").on(t.workspaceId, t.environmentId, t.sha256),
  ],
);

export type ModelRow = typeof models.$inferSelect;
export type ModelArtifactRow = typeof modelArtifacts.$inferSelect;

/**
 * An experiment on a decision workflow: variants that an agent or a person defines, trained,
 * validated and tested on the workflow's labeled runs by the server, then one of them applied.
 */
export const workflowExperiments = pgTable(
  "workflow_experiments",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    environmentId: environment(),
    workflow: text("workflow").notNull(),
    baseVersion: integer("base_version"),
    status: text("status").$type<"queued" | "running" | "done" | "failed">().notNull(),
    error: text("error"),
    /** The request: features, variants, labels, split and the rest. */
    config: json("config").$type<Record<string, unknown>>().notNull(),
    dataset: json("dataset").$type<Record<string, unknown>>(),
    results: json("results").$type<Record<string, unknown>[]>(),
    best: text("best"),
    selected: json("selected").$type<{ variant: string; reason: string | null; by: string | null; at: string }>(),
    applied: json("applied").$type<{ variant: string; version: number | null; published: boolean; at: string }>(),
    createdBy: text("created_by"),
    started: time("started"),
    finished: time("finished"),
    created: created(),
    updated: updated(),
  },
  (t) => [
    foreignKey({
      name: "workflow_experiments_environment_fk",
      columns: [t.workspaceId, t.environmentId],
      foreignColumns: [environments.workspaceId, environments.id],
    }).onDelete("cascade"),
    index("workflow_experiments_by_workflow").on(t.workspaceId, t.environmentId, t.workflow, t.created),
  ],
);

export type WorkflowExperimentRow = typeof workflowExperiments.$inferSelect;
