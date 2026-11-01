import { z } from "zod";

const token = z.string().trim().min(1, "token: a Cloudflare API token").max(200);

export const zonesBody = z.object({ token });

export const deployBody = z.object({
  token,
  zone_id: z
    .string()
    .trim()
    .regex(/^[a-f0-9]{32}$/, "zone_id: the id of a Cloudflare zone"),
  pattern: z.string().trim().min(3).max(200),
  /** The hash key of the customer's servers. Without one, Kairos makes one and gives it back once. */
  hash_key: z.string().trim().min(16).max(200).optional(),
  javascript: z.boolean().default(false),
  /** Where the Worker sends to: the address that the console is open on. */
  url: z.string().url().optional(),
});
