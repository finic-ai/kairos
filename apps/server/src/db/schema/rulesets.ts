import type { ListItem, ListMatch, RulesetDefinition } from "@kairos/core";
import { boolean, foreignKey, integer, json, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { created, updated, environment, time } from "./columns";
import { workspace, environments } from "./accounts";

/** One row for each ruleset: its live version, as for workflows. Every version is in `definition_versions`. */
export const rulesets = pgTable(
  "rulesets",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    environmentId: environment(),
    /** Never changes: workflow steps refer to a ruleset by it, in every environment. */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /** The evaluator never reads it, so a change makes no version. */
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    /** 0 until the first publish. */
    version: integer("version").notNull(),
    definition: json("definition").$type<RulesetDefinition>().notNull(),
    draft: json("draft").$type<RulesetDefinition>(),
    status: text("status").$type<"draft" | "published" | "archived">().notNull().default("draft"),
    publishedAt: time("published_at"),
    createdBy: text("created_by"),
    updatedBy: text("updated_by"),
    created: created(),
    updated: updated(),
  },
  (t) => [
    foreignKey({
      name: "rulesets_environment_fk",
      columns: [t.workspaceId, t.environmentId],
      foreignColumns: [environments.workspaceId, environments.id],
    }).onDelete("cascade"),
    uniqueIndex("rulesets_slug").on(t.workspaceId, t.environmentId, t.slug),
  ],
);

/** A named set of terms that rulesets read with `inList`. It is live data: a change makes no version. */
export const lists = pgTable(
  "lists",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    environmentId: environment(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /** The default of each item that has no match or case of its own. */
    match: text("match").$type<ListMatch>().notNull().default("exact"),
    caseSensitive: boolean("case_sensitive").notNull().default(false),
    items: jsonb("items").$type<ListItem[]>().notNull().default([]),
    createdBy: text("created_by"),
    updatedBy: text("updated_by"),
    created: created(),
    updated: updated(),
  },
  (t) => [
    foreignKey({
      name: "lists_environment_fk",
      columns: [t.workspaceId, t.environmentId],
      foreignColumns: [environments.workspaceId, environments.id],
    }).onDelete("cascade"),
    uniqueIndex("lists_slug").on(t.workspaceId, t.environmentId, t.slug),
  ],
);

export type RulesetRow = typeof rulesets.$inferSelect;
export type ListRow = typeof lists.$inferSelect;
