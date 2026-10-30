import { z } from "zod";

export const trainingDataBody = z
  .object({
    features: z
      .record(z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]))
      .refine((f) => Object.keys(f).length >= 1 && Object.keys(f).length <= 500, "1 to 500 features"),
    labels: z.array(z.string().min(1).max(128)).min(1).max(20),
    window: z.string().regex(/^\d+(\.\d+)?(s|m|h|d)$/, 'a time such as "180d"'),
    /** Needed unless the workflow makes an action's decisions, whose subject it then is. */
    subject: z
      .object({ type: z.string().min(1).max(64), id: z.string().min(1).max(2000) })
      .strict()
      .optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    limit: z.number().int().min(1).max(200_000).optional(),
  })
  .strict();
export type TrainingDataBody = z.infer<typeof trainingDataBody>;
