import { isIP } from "node:net";
import { sql } from "drizzle-orm";
import type { Executor } from "../platform/database";

/** The window starts at the first hit. */
export interface Limit {
  key: string;
  resource: string;
  ip?: string;
  max: number;
  windowMs: number;
}

// A client can send any text in X-Forwarded-For, and inet refuses what is not an address.
const inetOrNull = (ip: string | undefined) => (ip && isIP(ip) ? ip : null);

export class RateLimitsService {
  constructor(private readonly db: Executor) {}

  /** Seconds to wait, or 0. Each count is one atomic upsert, so parallel requests cannot all pass. */
  async hit(limits: Limit[], now: Date): Promise<number> {
    let wait = 0;
    for (const { key, resource, ip, max, windowMs } of limits) {
      const ends = new Date(now.getTime() + windowMs);
      const row = (
        await this.db.execute<{ hits: number | string; expires: Date | string }>(sql`
          INSERT INTO rate_limits (key, resource, ip, hits, expires) VALUES (${key}, ${resource}, ${inetOrNull(ip)}, 1, ${ends})
          ON CONFLICT (key) DO UPDATE SET
            hits = CASE WHEN rate_limits.expires <= ${now} THEN 1 ELSE rate_limits.hits + 1 END,
            expires = CASE WHEN rate_limits.expires <= ${now} THEN ${ends} ELSE rate_limits.expires END
          RETURNING hits, expires`)
      ).rows[0]!;
      if (Number(row.hits) > max)
        wait = Math.max(wait, Math.ceil((new Date(row.expires).getTime() - now.getTime()) / 1000));
    }
    return wait;
  }

  async undo(key: string): Promise<void> {
    await this.db.execute(sql`UPDATE rate_limits SET hits = GREATEST(hits - 1, 0) WHERE key = ${key}`);
  }

  async reset(key: string): Promise<void> {
    await this.db.execute(sql`DELETE FROM rate_limits WHERE key = ${key}`);
  }

  static async purgeExpired(db: Executor, now: Date): Promise<void> {
    await db.execute(sql`DELETE FROM rate_limits WHERE expires <= ${now}`);
  }
}

const MINUTE = 60_000;

/** Each key starts with its own prefix, so that two limits never share a row. */
export const LIMITS = {
  /** The email alone has a loose limit, so that a stranger cannot easily lock its owner out. The pair is first. */
  login: (email: string, ip: string | undefined): Limit[] => [
    { key: `login:email_ip:${email}|${ip ?? ""}`, resource: "login", ip, max: 10, windowMs: 15 * MINUTE },
    { key: `login:email:${email}`, resource: "login", max: 100, windowMs: 15 * MINUTE },
    ...(ip ? [{ key: `login:ip:${ip}`, resource: "login", ip, max: 100, windowMs: 15 * MINUTE }] : []),
  ],
  signup: (ip: string | undefined): Limit[] =>
    ip ? [{ key: `signup:ip:${ip}`, resource: "signup", ip, max: 20, windowMs: 60 * MINUTE }] : [],
  password: (userId: string): Limit[] => [
    { key: `password:user:${userId}`, resource: "password", max: 10, windowMs: 15 * MINUTE },
  ],
  publicKey: (keyId: string, ip: string | undefined): Limit[] => [
    { key: `public:${keyId}|${ip ?? ""}`, resource: "public_key", ip, max: 600, windowMs: MINUTE },
    { key: `public:${keyId}`, resource: "public_key", max: 30_000, windowMs: MINUTE },
  ],
};
