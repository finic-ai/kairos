import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadDatabaseConfig } from "./platform/config";
import { migrate, openDatabase, pendingMigrations } from "./platform/database";

const beside = fileURLToPath(new URL("./drizzle", import.meta.url));
// In a built server the migrations are next to this file.
const folder = process.env.KAIROS_MIGRATIONS || (existsSync(beside) ? beside : undefined);

// On a build machine there is no data to keep, so an embedded Postgres there would be migrated and thrown away.
if (process.env.VERCEL && !process.env.DATABASE_URL) {
  console.error(
    "DATABASE_URL is not set. On Vercel, set it for the build as well as for the function: the build applies the migrations.",
  );
  process.exit(1);
}

let failed = false;
const database = await openDatabase(loadDatabaseConfig());
try {
  const pending = await pendingMigrations(database.db, folder);
  // Asked again under the lock inside `migrate`, so two runs at the same moment are safe.
  await migrate(database.db, folder);
  console.log(pending.length ? `Applied ${pending.length}: ${pending.join(", ")}` : "The database is up to date.");
} catch (cause) {
  failed = true;
  console.error("The migration failed, and nothing was changed.");
  console.error(cause);
} finally {
  await database.close();
}
process.exit(failed ? 1 : 0);
