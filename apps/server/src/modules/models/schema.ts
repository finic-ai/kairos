import { z } from "zod";

export const uploadBody = z
  .object({
    /** Needed for the first version of a model. On a later version, it changes the name. */
    name: z.string().trim().min(1).max(80).optional(),
    format: z.enum(["xgboost-json", "logistic-json"]).default("xgboost-json"),
    model: z.record(z.unknown()),
    samples: z.array(z.unknown()),
    description: z.string().trim().max(500).optional(),
    metrics: z.record(z.unknown()).optional(),
    training: z.record(z.unknown()).optional(),
    suggested_features: z.record(z.string().max(2000)).optional(),
  })
  .strict();
export type UploadBody = z.infer<typeof uploadBody>;

export const renameBody = z.object({ name: z.string().trim().min(1).max(80) }).strict();

export const promoteBody = z.object({ to: z.string().min(1).max(100) }).strict();

export const scoreBody = z.object({ features: z.record(z.unknown()) }).strict();

export const listQuery = z.object({
  kind: z.enum(["question", "scoring"]).optional(),
  q: z.string().trim().max(200).default(""),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListQuery = z.infer<typeof listQuery>;
