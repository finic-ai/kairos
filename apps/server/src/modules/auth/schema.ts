import { z } from "zod";
import { MAX_PASSWORD_BYTES } from "../../platform/crypto";

export const email = z.string().trim().toLowerCase().email().max(254);
export const password = z
  .string()
  .min(8, "must be at least 8 characters")
  .refine((value) => Buffer.byteLength(value) <= MAX_PASSWORD_BYTES, `must be at most ${MAX_PASSWORD_BYTES} bytes`);

/** A password to check. No stored password is empty or longer, and bcrypt reads only the first 72 bytes. */
const givenPassword = z
  .string()
  .min(1, "is needed")
  .refine((value) => Buffer.byteLength(value) <= MAX_PASSWORD_BYTES, `must be at most ${MAX_PASSWORD_BYTES} bytes`);

export const signupBody = z.object({
  email,
  password,
  name: z.string().trim().max(120).default(""),
  invite: z.string().optional(),
});
export const loginBody = z.object({ email, password: givenPassword });
export const supabaseBody = z.object({ access_token: z.string().min(1), invite: z.string().optional() });
export const mfaCodeBody = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "must be the 6 digits from your app"),
});
export const profileBody = z.object({ name: z.string().trim().min(1).max(120) });
export const passwordBody = z.object({ current: givenPassword.optional(), password });
export const deleteAccountBody = z.object({
  password: z.string().max(200).default(""),
  confirm: z.string().default(""),
});
