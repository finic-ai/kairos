import bcrypt from "bcryptjs";
import { createHash, randomBytes } from "node:crypto";
import { monotonicFactory } from "ulid";

/** A random token for a session, an invite or an API key. Only its hash is stored. Never a ULID: a ULID shows its time. */
export const newToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

const monotonic = monotonicFactory();

/**
 * A ULID in lower case: 10 characters of time in milliseconds, then 16 random ones, so that ids
 * sort in the order they were made. Two ids made in the same millisecond, or after the clock went
 * back, still sort in order. Crockford base32 reads upper and lower case as the same.
 */
export const ulid = (time?: number): string => monotonic(time).toLowerCase();

/** Every id Kairos makes: a prefix and a ULID, such as `usr_01jb8xk3m4n5p6q7r8s9t0v1w2`. Code reads the prefix, never the time. */
export const newId = (prefix: string) => `${prefix}_${ulid()}`;
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** bcrypt reads only the first 72 bytes of a password, so a longer one is refused at sign-up. */
export const MAX_PASSWORD_BYTES = 72;
const BCRYPT_COST = 10;

export const hashPassword = (password: string): Promise<string> => bcrypt.hash(password, BCRYPT_COST);

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored || !password) return false;
  return bcrypt.compare(password, stored);
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase();
