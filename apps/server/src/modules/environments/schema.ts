import { z } from "zod";

const ids = z.array(z.string().min(1).max(500)).max(1000);
const items = z.object({ ids: ids.default([]) }).strict();
export const environmentCopyBody = z
  .object({
    actions: z.union([z.boolean(), items]).optional(),
    dashboards: z.union([z.boolean(), items]).optional(),
    queues: z.union([z.boolean(), items]).optional(),
    decisions: z.union([z.boolean(), items]).optional(),
    models: z.union([z.boolean(), items]).optional(),
    events: z.union([z.boolean(), z.object({ ids: ids.default([]), types: ids.default([]) }).strict()]).optional(),
    entities: z
      .union([
        z.boolean(),
        z
          .object({
            types: ids.default([]),
            records: z
              .array(z.object({ type: z.string().min(1).max(500), id: z.string().min(1).max(500) }).strict())
              .max(1000)
              .default([]),
          })
          .strict(),
      ])
      .optional(),
  })
  .strict();
export type EnvironmentCopyOptions = z.input<typeof environmentCopyBody>;
export const copyOptionsQuery = z.object({
  category: z.enum([
    "actions",
    "entity_types",
    "entities",
    "event_types",
    "events",
    "dashboards",
    "queues",
    "decisions",
    "models",
  ]),
  q: z.string().max(200).default(""),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type CopyOptionsQuery = z.infer<typeof copyOptionsQuery>;

export const sandboxBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    copy_from: z.string().min(1).optional(),
    copy: environmentCopyBody.optional(),
    // Compatibility with the original settings-only copy request.
    copy_dashboards: z.boolean().optional(),
  })
  .strict()
  .refine((input) => input.copy_from || !(input.copy_dashboards || Object.values(input.copy ?? {}).some(Boolean)), {
    message: "Choose a source environment to copy from",
    path: ["copy_from"],
  })
  .refine((input) => input.copy === undefined || input.copy_dashboards === undefined, {
    message: "Use copy or copy_dashboards, not both",
    path: ["copy"],
  });
