import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { inject } from "vitest";
import { migrate, openDatabase, type Database } from "../../src/platform/database";
import { ALL_TABLES, apiKeys, environments, workspaces } from "../../src/db/schema";
import { hashToken } from "../../src/platform/crypto";

/**
 * A database of its own for one test file, with the tables in place. `reset` empties them and,
 * given `keys` as key → workspace, makes those workspaces with a secret API key for each.
 */
export async function testDatabase(
  migrationsFolder?: string,
): Promise<{ db: Database; reset(keys?: Record<string, string>): Promise<void> }> {
  const server = new URL(inject("postgresUrl"));
  const name = `kairos_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: server.href });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  server.pathname = `/${name}`;
  const { db } = await openDatabase({ url: server.href, dataDir: "", port: 0 });
  await migrate(db, migrationsFolder);
  const empty = sql.raw(`TRUNCATE ${[...ALL_TABLES, "rate_limits"].join(", ")} RESTART IDENTITY`);
  const reset = async (keys: Record<string, string> = {}) => {
    await db.execute(empty);
    const created = new Date("2026-01-01T00:00:00Z");
    for (const [secret, workspaceId] of Object.entries(keys)) {
      await db
        .insert(workspaces)
        .values({ id: workspaceId, name: workspaceId, slug: workspaceId.toLowerCase(), created, updated: created })
        .onConflictDoNothing();
      await db
        .insert(environments)
        .values({ id: workspaceId, workspaceId, name: "Production", kind: "production", created, updated: created })
        .onConflictDoNothing();
      await db.insert(apiKeys).values({
        id: `key_${secret}`,
        workspaceId,
        environmentId: workspaceId,
        name: secret,
        kind: "secret",
        keyHash: hashToken(secret),
        hint: secret,
        allowedIps: [],
        allowedOrigins: [],
        created,
        updated: created,
      });
    }
  };
  return { db, reset };
}
