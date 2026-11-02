import { LIST_MATCHES, MAX_LIST_NOTE_LENGTH } from "@kairos/core";
import { z } from "zod";

export const putBody = z
  .object({
    /** Needed when the call makes a new list. */
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    match: z.enum(LIST_MATCHES).optional(),
    case_sensitive: z.boolean().optional(),
  })
  .strict();
export type PutBody = z.infer<typeof putBody>;

const item = z
  .object({
    value: z.union([z.string(), z.number()]),
    note: z.string().trim().max(MAX_LIST_NOTE_LENGTH).optional(),
    /** Null: the item uses the list's. */
    match: z.enum(LIST_MATCHES).nullable().optional(),
    case_sensitive: z.boolean().nullable().optional(),
  })
  .strict();

export const itemsBody = z.object({ items: z.array(item).max(1000) }).strict();
export const replaceBody = z.object({ items: z.array(item) }).strict();
export const removeBody = z.object({ values: z.array(z.union([z.string(), z.number()])).max(1000) }).strict();

export const listQuery = z.object({
  q: z.string().trim().max(200).default(""),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListQuery = z.infer<typeof listQuery>;
