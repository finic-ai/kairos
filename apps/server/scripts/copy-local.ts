/**
 * Copy the embedded database from before the migrations restarted (.data/postgres) into the
 * new one (.data/postgres2). Each developer runs it once:
 *
 *   pnpm --filter @kairos/server db:copy-local [--from <data folder>]
 *
 * The old database is only read. When its Postgres is running, the script reads from it there;
 * when it is not, the script starts it read-only on port 54330 and stops it at the end. The new
 * database must be empty. It gets the baseline migration, and then everything is copied in one
 * transaction: if anything fails, the new database stays empty.
 *
 * The new database reads the old one through postgres_fdw, so the rows go from one Postgres to
 * the other without passing through this process, and `json` values keep their text exactly.
 * See internal/designs/server-structure.md, section 4.7.5.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { ALL_TABLES, jobs } from "../src/db/schema";
import { loadDatabaseConfig } from "../src/platform/config";
import { EMBEDDED, migrate, openDatabase, type Database } from "../src/platform/database";
import { jobRow } from "../src/services/job.service";
import { deliverJob } from "../src/modules/webhooks/repo";
import { slugOf } from "../src/services/workspace.service";

/** Where the old database is: its Postgres, which this script does not start or stop. */
export interface Source {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export interface CopyResult {
  /** The rows of each table: in the old database (null: it has no such table) and in the new one. */
  tables: { table: string; old: number | null; new: number }[];
  /** The users who had both a password and Supabase. They are Supabase users now. */
  linked: string[];
  /** Jobs made for the deliveries that were still waiting, when the old database had no jobs. */
  jobsMade: number;
  /** Old columns that nothing reads: data that was not copied. Empty, unless the old schema is not the one expected. */
  dropped: string[];
}

/** The order of the foreign keys: a table comes after the tables it references. */
const ORDER = [
  "workspaces",
  "environments",
  "users",
  "memberships",
  "invites",
  "sessions",
  "api_keys",
  "events",
  "event_entities",
  "objects",
  "labels",
  "entities",
  "actions",
  "definition_versions",
  "workflows",
  "workflow_runs",
  "dashboards",
  "decisions",
  "queues",
  "cases",
  "case_evidence",
  "case_items",
  "case_activity",
  "models",
  "model_artifacts",
  "workflow_experiments",
  "rulesets",
  "lists",
  "webhooks",
  "webhook_deliveries",
  "jobs",
  "activities",
] as const;
const OLD = "kairos_old";

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

interface Column {
  name: string;
  nullable: boolean;
  /** A default or an identity gives it a value when the copy gives none. */
  defaulted: boolean;
}

/** How the new columns of a table are filled from the old row `o`, where the column is new or its value changes. */
interface Rule {
  join?: string;
  /** A condition on the old row `o`, for a copy that takes only some of the old rows. */
  where?: string;
  columns: Record<string, string>;
}

function rules(
  has: (table: string, column: string) => boolean,
  slugs: { id: string; slug: string }[],
): Record<string, Rule> {
  const received = has("events", "received") ? "COALESCE(o.received, o.ts)" : "o.ts";
  // The new event of an old event id: the links of a row point to it.
  const copiedEvent = (alias: string, column: string) =>
    `${alias} ON ${alias}.workspace_id = o.workspace_id AND ${alias}.environment_id = o.environment_id AND ${alias}.external_id = o.${column}`;
  // An old sandbox copy gave its rows the ids of the source. The production row keeps the id; the others get new ones.
  const ownId = (prefix: string, at: string) =>
    `CASE WHEN row_number() OVER (PARTITION BY o.id ORDER BY (env.kind = 'production') DESC, env.created, env.id) = 1 THEN o.id ELSE kairos_id('${prefix}', ${at}) END`;
  const environment = `JOIN ${OLD}.environments env ON env.id = o.environment_id`;
  return {
    // The customer's id moves to external_id, and the row gets an id of its own, with the time it was received.
    events: { columns: { id: `kairos_id('evt', ${received})`, external_id: "o.id", created: received } },
    event_entities: {
      join: `JOIN public.events ${copiedEvent("e", "event_id")}`,
      columns: { event_id: "e.id", created: "e.created" },
    },
    objects: { columns: { id: "kairos_id('obj', o.first_seen)", external_id: "o.id", created: "o.first_seen" } },
    labels: { columns: { id: "kairos_id('lbl', o.ts)", created: "o.ts", updated: "o.ts" } },
    entities: { columns: { id: "kairos_id('ent', o.created)" } },
    // Before definition_versions, an action was one row for each version, with the display
    // name and the automatic switch inside the definition. Only the latest row stays an
    // action; the versions are made from all the rows where definition_versions is copied.
    actions: has("actions", "display_name")
      ? { columns: { id: "kairos_id('act', o.created)" } }
      : {
          columns: {
            id: "kairos_id('act', o.created)",
            display_name: "o.definition ->> 'displayName'",
            automatic: "COALESCE((o.definition ->> 'automatic')::boolean, false)",
            automatic_since: "(o.definition ->> 'automaticSince')::timestamp with time zone",
            definition: "(o.definition::jsonb - 'displayName' - 'automatic' - 'automaticSince')::json",
          },
          where: `NOT EXISTS (SELECT 1 FROM ${OLD}.actions newer WHERE newer.workspace_id = o.workspace_id AND newer.environment_id = o.environment_id AND newer.name = o.name AND newer.version > o.version)`,
        },
    dashboards: { join: environment, columns: { id: ownId("dash", "o.created") } },
    decisions: {
      join: `${environment} LEFT JOIN public.events ${copiedEvent("e", "event_id")}`,
      columns: {
        id: ownId("kdec", "o.ts"),
        event_id: "e.id",
        created: "o.ts",
        updated: has("decisions", "resolution") ? "COALESCE((o.resolution ->> 'at')::timestamptz, o.ts)" : "o.ts",
      },
    },
    webhook_deliveries: { columns: { updated: "COALESCE(o.finished, o.created)" } },
    memberships: { columns: { id: "kairos_id('mem', o.created)" } },
    sessions: { columns: { id: "kairos_id('ses', o.created)" } },
    users: {
      join: `LEFT JOIN (SELECT user_id, max(created) AS at FROM ${OLD}.sessions GROUP BY user_id) l ON l.user_id = o.id`,
      columns: {
        display_name: "o.name",
        // A user with both was joined to Supabase by email: a Supabase user now, without the password.
        auth: `(CASE WHEN o.supabase_id IS NULL THEN '{"provider":"native","strategy":"email_password"}' ELSE '{"provider":"supabase"}' END)::jsonb`,
        password_hash: "CASE WHEN o.supabase_id IS NULL THEN o.password_hash END",
        subject_id: "o.supabase_id",
        last_login: "l.at",
      },
    },
    workspaces: {
      join: `JOIN json_to_recordset(${literal(JSON.stringify(slugs))}::json) AS s(id text, slug text) ON s.id = o.id`,
      columns: { slug: "s.slug" },
    },
  };
}

/** Give each workspace the slug of its name, and -2, -3 and so on to the later ones with the same slug. */
export function slugsOf(workspaces: { id: string; name: string }[]): { id: string; slug: string }[] {
  const taken = new Set<string>();
  return workspaces.map(({ id, name }) => {
    const base = slugOf(name);
    let slug = base;
    for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
    taken.add(slug);
    return { id, slug };
  });
}

/** Copy the old database into `db`, which has the baseline migration and no rows. */
export async function copyLocal(db: Database, source: Source, now = new Date()): Promise<CopyResult> {
  const rowsOf = async <T>(query: string, on: Pick<Database, "execute"> = db) =>
    (await on.execute<Record<string, any>>(sql.raw(query))).rows as T[];
  const count = async (table: string, on: Pick<Database, "execute"> = db) =>
    Number((await rowsOf<{ n: string }>(`SELECT count(*) AS n FROM ${table}`, on))[0]!.n);

  for (const table of ALL_TABLES) {
    if (!ORDER.includes(table))
      throw new Error(`The copy does not know the table ${table}. Add it to ORDER, after the tables it references.`);
    if (await count(table)) throw new Error(`The new database is not empty: ${table} has rows. Nothing was copied.`);
  }

  await db.execute<Record<string, any>>(sql.raw(`DROP SCHEMA IF EXISTS ${OLD} CASCADE`));
  await db.execute<Record<string, any>>(sql.raw(`DROP SERVER IF EXISTS ${OLD} CASCADE`));
  await db.execute<Record<string, any>>(sql.raw("CREATE EXTENSION IF NOT EXISTS postgres_fdw"));
  await db.execute<Record<string, any>>(
    sql.raw(
      `CREATE SERVER ${OLD} FOREIGN DATA WRAPPER postgres_fdw OPTIONS (host ${literal(source.host)}, port ${literal(String(source.port))}, dbname ${literal(source.database)}, fetch_size '1000', options '-c default_transaction_read_only=on')`,
    ),
  );
  await db.execute<Record<string, any>>(
    sql.raw(
      `CREATE USER MAPPING FOR CURRENT_USER SERVER ${OLD} OPTIONS (user ${literal(source.user)}, password ${literal(source.password)})`,
    ),
  );
  await db.execute<Record<string, any>>(sql.raw(`CREATE SCHEMA ${OLD}`));
  await db.execute<Record<string, any>>(sql.raw(`IMPORT FOREIGN SCHEMA public FROM SERVER ${OLD} INTO ${OLD}`));

  try {
    // One transaction here is also one transaction there, at REPEATABLE READ: every table is read from the same moment.
    return await db.transaction(async (tx) => {
      const columns = await rowsOf<{
        schema: string;
        table: string;
        name: string;
        nullable: string;
        defaulted: boolean;
        identity: boolean;
      }>(
        `SELECT table_schema AS schema, table_name AS table, column_name AS name, is_nullable AS nullable,
                (column_default IS NOT NULL OR is_identity = 'YES') AS defaulted, is_identity = 'YES' AS identity
           FROM information_schema.columns
          WHERE table_schema IN ('public', '${OLD}') AND is_generated = 'NEVER'
          ORDER BY ordinal_position`,
        tx,
      );
      const byTable = (schema: string) => {
        const map = new Map<string, Column[]>();
        for (const c of columns.filter((c) => c.schema === schema))
          map.set(c.table, [
            ...(map.get(c.table) ?? []),
            { name: c.name, nullable: c.nullable === "YES", defaulted: c.defaulted },
          ]);
        return map;
      };
      const fresh = byTable("public");
      const old = byTable(OLD);
      const has = (table: string, column: string) => old.get(table)?.some((c) => c.name === column) ?? false;
      if (!has("events", "environment_id")) {
        throw new Error(
          "The old database is from before migration 0007_environment_scopes. Start the server once at commit e81a10d~1 to bring it up to date, then run this again.",
        );
      }

      const slugs = slugsOf(
        await rowsOf<{ id: string; name: string }>(`SELECT id, name FROM ${OLD}.workspaces ORDER BY created, id`, tx),
      );
      const rule = rules(has, slugs);
      const tables: CopyResult["tables"] = [];
      const dropped: string[] = [];

      for (const table of ORDER) {
        const target = fresh.get(table)!;
        const source = old.get(table);
        if (!source) {
          // A table the old database does not have starts empty, except definition_versions:
          // the old actions hold every version, so the versions are made from them.
          if (table === "definition_versions" && old.has("actions")) {
            await tx.execute<Record<string, any>>(
              sql.raw(
                `INSERT INTO public.definition_versions (workspace_id, environment_id, kind, name, version, definition, created, created_by)
                 SELECT workspace_id, environment_id, 'action', name, version, (definition::jsonb - 'displayName' - 'automatic' - 'automaticSince')::json, created, NULL FROM ${OLD}.actions`,
              ),
            );
            tables.push({ table, old: null, new: await count(`public.${table}`, tx) });
            continue;
          }
          tables.push({ table, old: null, new: 0 });
          continue;
        }
        const { join = "", where = "", columns: given = {} } = rule[table] ?? {};
        const names: string[] = [];
        const values: string[] = [];
        for (const column of target) {
          const value =
            given[column.name] ??
            (has(table, column.name)
              ? `o.${column.name}`
              : column.name === "updated" && has(table, "created")
                ? "o.created"
                : undefined);
          if (value === undefined) {
            if (!column.nullable && !column.defaulted)
              throw new Error(`The copy has no value for ${table}.${column.name}. Add one to the rules.`);
            continue;
          }
          names.push(column.name);
          values.push(value);
        }
        const read = new Set([...[...values, join, where].join(" ").matchAll(/\bo\.(\w+)/g)].map((m) => m[1]));
        dropped.push(...source.filter((c) => !read.has(c.name)).map((c) => `${table}.${c.name}`));

        await tx.execute<Record<string, any>>(
          sql.raw(
            `INSERT INTO public.${table} (${names.join(", ")}) OVERRIDING SYSTEM VALUE SELECT ${values.join(", ")} FROM ${OLD}.${table} o ${join}${where ? ` WHERE ${where}` : ""}`,
          ),
        );
        tables.push({ table, old: await count(`${OLD}.${table}`, tx), new: await count(`public.${table}`, tx) });
      }

      // The identities go on from the highest copied value.
      for (const { table, name } of columns.filter((c) => c.schema === "public" && c.identity)) {
        await tx.execute<Record<string, any>>(
          sql.raw(
            `SELECT setval(pg_get_serial_sequence('public.${table}', '${name}'), COALESCE(max(${name}), 1), max(${name}) IS NOT NULL) FROM public.${table}`,
          ),
        );
      }

      // Before the jobs table, the worker found waiting deliveries by their next attempt. Each one gets its job, as migration 0009 did.
      let jobsMade = 0;
      if (!old.has("jobs")) {
        const waiting = await rowsOf<{
          id: string;
          workspace_id: string;
          environment_id: string;
          webhook_id: string;
          attempts: number;
          next_attempt: Date;
          created: Date;
          enabled: boolean;
        }>(
          `SELECT d.id, d.workspace_id, d.environment_id, d.webhook_id, d.attempts, d.next_attempt, d.created, w.enabled
             FROM public.webhook_deliveries d JOIN public.webhooks w ON w.id = d.webhook_id
            WHERE d.direction = 'out' AND d.status = 'pending' AND d.next_attempt IS NOT NULL`,
          tx,
        );
        for (const d of waiting) {
          const job = jobRow(
            {
              ...deliverJob({
                id: d.id,
                workspaceId: d.workspace_id,
                environmentId: d.environment_id,
                webhookId: d.webhook_id,
              }),
              runAt: new Date(d.next_attempt),
            },
            now,
          );
          await tx
            .insert(jobs)
            .values({
              ...job,
              status: d.enabled ? "pending" : "paused",
              attempts: d.attempts,
              created: new Date(d.created),
            })
            .onConflictDoNothing();
        }
        jobsMade = waiting.length;
        tables[tables.findIndex((t) => t.table === "jobs")]!.new = await count("public.jobs", tx);
      }

      const linked = (
        await rowsOf<{ email: string }>(
          `SELECT email FROM ${OLD}.users WHERE supabase_id IS NOT NULL AND password_hash IS NOT NULL ORDER BY email`,
          tx,
        )
      ).map((r) => r.email);
      return { tables, linked, jobsMade, dropped };
    });
  } finally {
    await db.execute<Record<string, any>>(sql.raw(`DROP SCHEMA IF EXISTS ${OLD} CASCADE`));
    await db.execute<Record<string, any>>(sql.raw(`DROP SERVER IF EXISTS ${OLD} CASCADE`));
    await db.execute<Record<string, any>>(sql.raw("DROP EXTENSION IF EXISTS postgres_fdw"));
  }
}

/** The port of the Postgres that is running on a data folder, from its postmaster.pid. */
function runningPort(dataDir: string): number | undefined {
  const file = join(dataDir, "postmaster.pid");
  if (!existsSync(file)) return undefined;
  const [pid, , , port] = readFileSync(file, "utf8").split("\n");
  try {
    process.kill(Number(pid), 0);
  } catch (cause) {
    // EPERM: it runs, as another user. Anything else: a file left behind.
    if ((cause as NodeJS.ErrnoException).code !== "EPERM") return undefined;
  }
  return Number(port);
}

async function main() {
  const config = loadDatabaseConfig();
  if (config.url) throw new Error("db:copy-local copies into the embedded Postgres. Unset DATABASE_URL.");
  const flag = process.argv.indexOf("--from");
  const from = flag > 0 ? process.argv[flag + 1]! : join(dirname(config.dataDir), "postgres");
  if (!existsSync(join(from, "PG_VERSION"))) throw new Error(`There is no database in ${from}.`);
  if (existsSync(config.dataDir) && realpathSync(from) === realpathSync(config.dataDir))
    throw new Error("The old and the new data folder are the same.");

  let oldPort = runningPort(from);
  let oldServer: { stop(): Promise<void> } | undefined;
  if (oldPort === undefined) {
    const { default: EmbeddedPostgres } = await import("embedded-postgres");
    oldPort = 54330;
    const server = new EmbeddedPostgres({
      databaseDir: from,
      user: EMBEDDED.user,
      password: EMBEDDED.password,
      port: oldPort,
      persistent: true,
      postgresFlags: ["-c", "default_transaction_read_only=on"],
      onLog: () => {},
      onError: () => {},
    });
    await server.start();
    oldServer = server;
  }
  try {
    const newPort = runningPort(config.dataDir) ?? (config.port === oldPort ? 54331 : config.port);
    const target = await openDatabase({ dataDir: config.dataDir, port: newPort });
    try {
      await migrate(target.db);
      const result = await copyLocal(target.db, { host: "localhost", port: oldPort, ...EMBEDDED });
      console.log(`Copied ${from}\n    to ${config.dataDir}\n`);
      console.log(`${"table".padEnd(20)}${"old".padStart(10)}${"new".padStart(10)}`);
      for (const t of result.tables)
        console.log(`${t.table.padEnd(20)}${(t.old ?? "-").toString().padStart(10)}${t.new.toString().padStart(10)}`);
      if (result.jobsMade)
        console.log(`\nMade ${result.jobsMade} jobs for the webhook deliveries that were still waiting.`);
      if (result.linked.length)
        console.log(
          `\nThese users had a password and Supabase. They sign in with Supabase now, and their password was not copied:\n${result.linked.map((e) => `  ${e}`).join("\n")}`,
        );
      if (result.dropped.length)
        console.log(`\nThese old columns were not copied:\n${result.dropped.map((c) => `  ${c}`).join("\n")}`);
      if (oldPort === config.port)
        console.log(
          `\nThe old Postgres still runs on port ${oldPort}, which the server uses. Stop it before you start the server.`,
        );
    } finally {
      await target.close();
    }
  } finally {
    await oldServer?.stop();
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    () => process.exit(0),
    (cause) => {
      console.error(cause instanceof Error ? cause.message : cause);
      process.exit(1);
    },
  );
}
