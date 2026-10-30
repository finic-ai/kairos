/**
 * The tables of Kairos. Workspaces own environments and members. Each table of data has both
 * `workspace_id` and `environment_id`, and nothing is read across environments.
 *
 * Three choices that hold for every table:
 * - A row that belongs to a workspace or a person is deleted with it (ON DELETE CASCADE).
 * - Times are `timestamptz`. The code speaks ISO strings, and the table services and repositories convert.
 * - A value that the model reads, or that a person wrote in an order, is `json`: the text is
 *   kept as it was written. `jsonb` sorts the keys of an object, and the order changes the
 *   answers of the model (measured in packages/eval/src/experiments/key-order.ts). Where such
 *   a value is searched, a GIN index on the value cast to `jsonb` makes the search fast.
 *   Every other free-form value is `jsonb`.
 */
export * from "./accounts";
export * from "./events";
export * from "./definitions";
export * from "./decisions";
export * from "./webhooks";
export * from "./jobs";
export * from "./cases";
export * from "./models";
export * from "./activities";

export const ALL_TABLES = [
  "events",
  "event_entities",
  "objects",
  "labels",
  "entities",
  "actions",
  "definition_versions",
  "workflows",
  "workflow_runs",
  "dashboards",
  "decisions",
  "queues",
  "cases",
  "case_evidence",
  "case_items",
  "case_activity",
  "models",
  "model_artifacts",
  "workflow_experiments",
  "users",
  "workspaces",
  "environments",
  "memberships",
  "invites",
  "sessions",
  "api_keys",
  "webhooks",
  "webhook_deliveries",
  "jobs",
  "activities",
] as const;
