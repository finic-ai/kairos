import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { expect, inject, it } from "vitest";
import { migrate, openDatabase, pendingMigrations } from "../src/platform/database";
import { loadConfig } from "../src/platform/config";
import { testDatabase } from "./helpers/database";

const database = await testDatabase();

it("knows which migrations a database does not have yet", async () => {
  expect(await pendingMigrations(database.db)).toEqual([]);
  // A database from before the newest migration.
  await database.db.execute(
    sql`DELETE FROM drizzle.__drizzle_migrations WHERE created_at = (SELECT max(created_at) FROM drizzle.__drizzle_migrations)`,
  );
  const pending = await pendingMigrations(database.db);
  expect(pending).toHaveLength(1);
  // A database that was never migrated has all of them to come.
  await database.db.execute(sql`DROP SCHEMA drizzle CASCADE`);
  const all = await pendingMigrations(database.db);
  expect(all.length).toBeGreaterThanOrEqual(1);
  expect(all.at(-1)).toBe(pending[0]);
});

it("applies migrations at start only for the embedded Postgres, unless told to", () => {
  const env = { GRAYSON_API_KEY: "k" };
  expect(loadConfig(env).migrateOnStart).toBe(true);
  expect(loadConfig({ ...env, DATABASE_URL: "postgres://x/y" }).migrateOnStart).toBe(false);
  expect(loadConfig({ ...env, DATABASE_URL: "postgres://x/y", KAIROS_MIGRATE_ON_START: "1" }).migrateOnStart).toBe(
    true,
  );
  expect(loadConfig({ ...env, KAIROS_MIGRATE_ON_START: "0" }).migrateOnStart).toBe(false);
});

it("runs jobs in the API process unless KAIROS_WORKER is separate", () => {
  const env = { GRAYSON_API_KEY: "k" };
  expect(loadConfig(env).worker).toBe("inline");
  expect(loadConfig({ ...env, KAIROS_WORKER: "separate" }).worker).toBe("separate");
  expect(() => loadConfig({ ...env, KAIROS_WORKER: "elsewhere" })).toThrow(/KAIROS_WORKER/);
});

it("does nothing when it is run again", async () => {
  const fresh = await testDatabase();
  await migrate(fresh.db);
  expect(await pendingMigrations(fresh.db)).toEqual([]);
});

// Only with the embedded Postgres of the tests: it is one of another data folder, on a known port.
it.skipIf(!!process.env.KAIROS_TEST_DATABASE_URL)(
  "does not use the Postgres of another data folder that has its port",
  async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kairos-other-pg-"));
    try {
      const port = Number(new URL(inject("postgresUrl")).port);
      await expect(openDatabase({ dataDir, port })).rejects.toThrow(`Port ${port} is used by the Postgres of`);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  },
  60_000,
);
