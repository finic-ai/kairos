import { z } from "zod";

const day = z.string().datetime({ offset: true }).or(z.string().date());

export const activityQuery = z.object({
  user: z.string().min(1).optional(),
  resource: z.string().min(1).optional(),
  q: z.string().max(200).optional(),
  /** From the start of this moment or day, inclusive. */
  from: day.optional(),
  /** To this moment, or to the end of this day. */
  to: day.optional(),
  after: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type ActivityQuery = z.infer<typeof activityQuery>;
