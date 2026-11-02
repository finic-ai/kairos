import { CASE_CATEGORIES } from "@kairos/core";
import { z } from "zod";

/**
 * The shape of a queue definition. The rules of it (fields, operators, scales, the correlation)
 * are checked by `validateQueue` in core, which the console's form also runs.
 */
export const queueBody = z.object({
  name: z.string(),
  description: z.string().optional(),
  visibility: z.enum(["private", "workspace"]).default("workspace"),
  enabled: z.boolean().optional(),
  sources: z
    .object({ actions: z.array(z.string()).optional(), event_types: z.array(z.string()).optional() })
    .default({}),
  intake: z.array(z.any()).default([]),
  correlation: z.object({ by: z.string() }).passthrough(),
  columns: z.array(z.string()).optional(),
  sort: z.string().optional(),
  display: z.record(z.unknown()).optional(),
  due_hours: z.record(z.unknown()).optional(),
});

/** Who did it, when an API key calls for someone. A signed-in person is always named by their email address. */
const by = z.string().trim().min(1).max(200).optional();

export const assignBody = z
  .object({
    /** A user id, or null to clear it. */
    assignee: z.string().min(1).max(200).nullable(),
    by,
  })
  .strict();

export const reopenBody = z.object({ by }).strict();

export const noteBody = z.object({ text: z.string().trim().min(1).max(5000), by }).strict();

const resolution = z.object({
  category: z.enum(CASE_CATEGORIES),
  note: z.string().trim().max(2000).optional(),
  apply_to_decisions: z.boolean().optional(),
  label_target: z.boolean().optional(),
});

export const resolveBody = resolution.extend({ by }).strict();

/** One action on many cases: assign them (to a user id, or to nobody), or resolve them. */
export const bulkBody = z.union([
  z.object({ ids: z.array(z.string().min(1)).min(1).max(200), assign: z.string().min(1).max(200).nullable() }).strict(),
  z.object({ ids: z.array(z.string().min(1)).min(1).max(200), resolve: resolution.strict() }).strict(),
]);
