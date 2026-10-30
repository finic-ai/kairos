import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate as runMigrations } from "drizzle-orm/node-postgres/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { getMigrationsToRun } from "drizzle-orm/migrator.utils";
import pg from "pg";
import { relations } from "../db/relations";

export type Database = NodePgDatabase<typeof relations>;
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
/** What a query runs on: the database, or a transaction of it. Repositories and table services take either. */
export type Executor = Database | Transaction;

export interface DatabaseHandle {
  db: Database;
  embedded: boolean;
  close(): Promise<void>;
}

export interface DatabaseOptions {
  /** A Postgres to connect to. Without it, Kairos starts its own. */
  url?: string;
  dataDir: string;
  port: number;
}

export const EMBEDDED = { user: "kairos", password: "kairos", database: "kairos" };
const MIGRATIONS = fileURLToPath(new URL("../../drizzle", import.meta.url));
/** Any number that nothing else in the database locks on. */
const MIGRATION_LOCK = 5247_1105;

/** Bring the tables up to the current schema. Safe to run again: what is applied is left alone. */
export async function migrate(db: Database, folder = MIGRATIONS): Promise<void> {
  // Two servers can start at the same moment: two containers, or two instances of a function.
  // The lock makes the second one wait, and it is released when the transaction ends.
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK})`);
    await runMigrations(tx as unknown as Database, { migrationsFolder: folder });
  });
}

/**
 * The migrations that the database does not have yet, oldest first. The server asks this when
 * it starts and does not change anything: applying them is a step of the deployment.
 */
export async function pendingMigrations(db: Database, folder = MIGRATIONS): Promise<string[]> {
  type Applied = { id: number; hash: string; created_at: string; name: string | null };
  let applied: Applied[] = [];
  try {
    // The table the migrator keeps: one row for each migration it applied, by name.
    applied = (await db.execute<Applied>(sql`SELECT id, hash, created_at, name FROM drizzle.__drizzle_migrations`))
      .rows;
  } catch (cause) {
    // 3F000 and 42P01: no such schema, no such table. The database was never migrated.
    const code = ((cause as { cause?: { code?: string } }).cause ?? (cause as { code?: string })).code;
    if (code !== "3F000" && code !== "42P01") throw cause;
  }
  return getMigrationsToRun({
    localMigrations: readMigrationFiles({ migrationsFolder: folder }),
    dbMigrations: applied,
  }).map((m) => m.name ?? String(m.folderMillis));
}

function connect(url: string): { db: Database; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  // A dropped idle connection must not take the process down.
  pool.on("error", (error) => console.error("Postgres connection error:", error.message));
  return { db: drizzle({ client: pool, relations }), pool };
}

export async function openDatabase(options: DatabaseOptions): Promise<DatabaseHandle> {
  if (options.url) {
    const { db, pool } = connect(options.url);
    return { db, embedded: false, close: () => pool.end() };
  }

  // Loaded only when it is used: a deployment with DATABASE_URL does not need the binaries.
  // A built server (Docker, Vercel) does not carry them at all.
  const { default: EmbeddedPostgres } = await import("embedded-postgres").catch(() => {
    throw new Error("DATABASE_URL is not set, and this build of Kairos has no embedded Postgres. Set DATABASE_URL.");
  });
  mkdirSync(options.dataDir, { recursive: true });
  const server = new EmbeddedPostgres({
    databaseDir: options.dataDir,
    user: EMBEDDED.user,
    password: EMBEDDED.password,
    port: options.port,
    persistent: true,
    onLog: () => {},
    onError: () => {},
  });
  const urlOf = (database: string) =>
    `postgres://${EMBEDDED.user}:${EMBEDDED.password}@localhost:${options.port}/${database}`;

  // The directory is initialised once. PG_VERSION is the file Postgres writes when it has been.
  if (!existsSync(join(options.dataDir, "PG_VERSION"))) await server.initialise();
  let started = false;
  try {
    await server.start();
    started = true;
  } catch (cause) {
    // The Postgres of this directory may be running already: another Kairos on this machine
    // has it, or one that was killed left it behind. If it answers, use it, and leave it running.
    const probe = new pg.Client({ connectionString: urlOf("postgres") });
    let dataDir: string;
    try {
      await probe.connect();
      dataDir = (await probe.query<{ dir: string }>("SELECT current_setting('data_directory') AS dir")).rows[0]!.dir;
    } catch {
      const why = cause instanceof Error ? ` (${cause.message})` : "";
      throw new Error(
        `The embedded Postgres could not start on port ${options.port}${why}. Set KAIROS_PG_PORT to a free port, or set DATABASE_URL to use your own Postgres.`,
      );
    } finally {
      await probe.end().catch(() => {});
    }
    // The Postgres on the port can be one of another directory, such as .data/postgres from before the migrations restarted.
    if (realpathSync(dataDir) !== realpathSync(options.dataDir)) {
      throw new Error(
        `Port ${options.port} is used by the Postgres of ${dataDir}, not of ${options.dataDir}. Stop that Postgres, or set KAIROS_PG_PORT to a free port.`,
      );
    }
  }
  if (started) {
    try {
      await server.createDatabase(EMBEDDED.database);
    } catch {
      // It exists already.
    }
  }
  const { db, pool } = connect(urlOf(EMBEDDED.database));
  return {
    db,
    embedded: true,
    close: async () => {
      await pool.end();
      if (started) await server.stop();
    },
  };
}
