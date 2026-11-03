import { z } from "zod";

const name = z.string().trim().min(1).max(80);
const description = z.string().trim().max(500).nullable();

export const draftBody = z
  .object({
    /** Needed when the draft makes a new ruleset. */
    name: name.optional(),
    description: description.optional(),
    definition: z.record(z.unknown()),
  })
  .strict();
export type DraftBody = z.infer<typeof draftBody>;

export const updateBody = z
  .object({ name: name.optional(), description: description.optional(), settings: z.record(z.unknown()).optional() })
  .strict();
export type UpdateBody = z.infer<typeof updateBody>;

export const evaluateBody = z.object({ input: z.record(z.unknown()) }).strict();

export const testBody = z
  .object({ definition: z.record(z.unknown()), input: z.record(z.unknown()).optional() })
  .strict();

export const listQuery = z.object({
  archived: z.enum(["true", "false"]).default("false"),
  q: z.string().trim().max(200).default(""),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export const versionQuery = z.object({ version: z.coerce.number().int().min(1).optional() });
