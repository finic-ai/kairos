import { sql } from "drizzle-orm";
import { decodeTime } from "ulid";
import { describe, expect, it } from "vitest";
import { newId, newToken, ulid } from "../src/platform/crypto";
import { testDatabase } from "./helpers/database";

describe("ids", () => {
  it("is a lower-case prefix, then a ULID in lower-case Crockford base32", () => {
    expect(newId("usr")).toMatch(/^usr_[0-9a-hjkmnp-tv-z]{26}$/);
  });

  it("starts with the time, so that ids sort in the order they were made", () => {
    // Times after any id made so far: an earlier time would be moved up to keep the order.
    const earlier = ulid(Date.parse("2030-01-01T10:00:00Z"));
    const later = ulid(Date.parse("2030-01-01T10:00:00.001Z"));
    expect(earlier < later).toBe(true);
    // The first 10 characters are the time in milliseconds.
    expect(decodeTime(later.toUpperCase())).toBe(Date.parse("2030-01-01T10:00:00.001Z"));
  });

  it("keeps the order of ids made in the same millisecond, and after the clock goes back", () => {
    const at = Date.parse("2026-10-25T11:00:00Z");
    const made = Array.from({ length: 1000 }, () => ulid(at));
    made.push(ulid(at - 5_000));
    expect([...made].sort()).toEqual(made);
    expect(new Set(made).size).toBe(made.length);
  });

  it("keeps secrets random: a token is not a ULID", () => {
    expect(newToken()).not.toMatch(/^[0-9a-z]{26}$/);
    expect(newToken().length).toBeGreaterThan(26);
  });

  it("is made in the same format by kairos_id, for copies inside Postgres", async () => {
    const { db } = await testDatabase();
    const at = "2026-03-01T10:00:00.123Z";
    const { rows } = await db.execute<Record<string, any>>(
      sql`SELECT kairos_id('evt', ${at}::timestamptz) AS a, kairos_id('evt', ${at}::timestamptz) AS b, kairos_id('obj') AS now`,
    );
    const { a, b, now } = rows[0] as { a: string; b: string; now: string };
    expect(a).toMatch(/^evt_[0-9a-hjkmnp-tv-z]{26}$/);
    expect(now).toMatch(/^obj_[0-9a-hjkmnp-tv-z]{26}$/);
    expect(decodeTime(a.slice(4).toUpperCase())).toBe(Date.parse(at));
    expect(a).not.toBe(b);
  });
});
