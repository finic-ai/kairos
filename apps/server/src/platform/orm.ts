import {
  and,
  eq,
  getTableColumns,
  relationsFilterToSQL,
  SQL,
  sql,
  type BuildQueryResult,
  type DBQueryConfig,
  type RelationsFilter,
  type Table,
  type TableFilter,
} from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import * as schema from "../db/schema";
import { relations } from "../db/relations";
import { newId } from "./crypto";
import type { Executor } from "./database";

/**
 * Typed reads and writes of one table, through Drizzle's relational queries: the base of the table
 * services. The scope is an environment for data, a workspace for accounts, and none for a global table.
 *
 * - Every query is scoped. The scope is given once, to the constructor, and is added to every
 *   filter and every write: a caller cannot read, change or delete a row of another scope.
 * - Filters are Drizzle's: `{ ts: { gte }, OR: [...], labels: { label: "fraud" } }`, with types, and
 *   through the relations of `db/relations.ts`. A filter of a write names columns of the table only.
 * - A write takes the `now` of the service. `create` makes the id and sets `created` and `updated`;
 *   `update` sets `updated`; `updateActivity` writes activity and leaves `updated`. The id, the scope and
 *   `created` cannot be changed.
 * - Built on a transaction (`new DatabaseService(tx, …)`), it reads and writes in that transaction.
 * - A global table (users, sessions, workspaces, jobs) has no scope. A write to it needs a filter:
 *   one that is empty would change every row, and throws.
 *
 * Writes here skip the rules of the module services: an event written here is not ingested (no links, no
 * automatic decision, no webhook).
 */
const SCOPES = {
  events: "environment",
  objects: "environment",
  labels: "environment",
  entities: "environment",
  actions: "environment",
  definitionVersions: "environment",
  workflows: "environment",
  workflowRuns: "environment",
  dashboards: "environment",
  decisions: "environment",
  queues: "environment",
  cases: "environment",
  caseEvidence: "environment",
  caseItems: "environment",
  caseActivity: "environment",
  models: "environment",
  modelArtifacts: "environment",
  workflowExperiments: "environment",
  webhooks: "environment",
  webhookDeliveries: "environment",
  // Keys are listed for the workspace, or for one environment: the environment is a value of the key.
  apiKeys: "workspace",
  environments: "workspace",
  memberships: "workspace",
  invites: "workspace",
  // A change to the workspace itself has no environment: the environment is a value of the activity.
  activities: "workspace",
  users: "global",
  sessions: "global",
  workspaces: "global",
  jobs: "global",
} as const;

const PREFIXES: Record<TableKey, string> = {
  events: "evt",
  objects: "obj",
  labels: "lbl",
  entities: "ent",
  actions: "act",
  definitionVersions: "def",
  workflows: "wfl",
  workflowRuns: "wfr",
  dashboards: "dash",
  decisions: "kdec",
  queues: "que",
  cases: "case",
  caseEvidence: "cev",
  caseItems: "cit",
  caseActivity: "cac",
  models: "mdl",
  modelArtifacts: "art",
  workflowExperiments: "wfx",
  webhooks: "wh",
  webhookDeliveries: "whd",
  apiKeys: "key",
  environments: "env",
  memberships: "mem",
  invites: "inv",
  activities: "actv",
  users: "usr",
  sessions: "ses",
  workspaces: "ws",
  jobs: "job",
};

export type TableKey = keyof typeof SCOPES;
type Tables = typeof relations;
type TableConfig<K extends TableKey> = Tables[K];
type TableOf<K extends TableKey> = (typeof schema)[K];

export type Scope<K extends TableKey> = (typeof SCOPES)[K] extends "environment"
  ? { workspaceId: string; environmentId: string }
  : (typeof SCOPES)[K] extends "workspace"
    ? { workspaceId: string }
    : Record<never, never>;
export type Filter<K extends TableKey> = RelationsFilter<TableConfig<K>, Tables>;
export type WriteFilter<K extends TableKey> = TableFilter<TableOf<K>>;
export type FindMany<K extends TableKey> = DBQueryConfig<"many", Tables, TableConfig<K>>;
export type FindFirst<K extends TableKey> = Omit<DBQueryConfig<"one", Tables, TableConfig<K>>, "where"> & {
  where?: Filter<K>;
};
export type Row<K extends TableKey, C = true> = BuildQueryResult<
  Tables,
  TableConfig<K>,
  C extends Record<string, unknown> ? C : true
>;
type Own<K extends TableKey> = "id" | "created" | "updated" | keyof Scope<K>;
export type Values<K extends TableKey> = Omit<TableOf<K>["$inferInsert"], Own<K>>;
/** A change: a value, or SQL computed from the row, such as `sql\`${t.revision} + 1\``. */
export type Changes<K extends TableKey> = { [C in keyof Values<K>]?: Values<K>[C] | SQL };
type Column<K extends TableKey> = Exclude<keyof TableOf<K>["$inferSelect"], Own<K>> & string;

const idFilter = <K extends TableKey>(id: string) => ({ id }) as unknown as WriteFilter<K>;

export class DatabaseService<K extends TableKey> {
  private readonly table: PgTable;
  private readonly columns: Record<string, PgColumn>;
  /** Columns the service writes itself. A value for one of them in a write is dropped. */
  private readonly serviceColumns: string[];

  constructor(
    protected readonly db: Executor,
    private readonly key: K,
    protected readonly scope: Scope<K>,
  ) {
    this.table = schema[key] as unknown as PgTable;
    this.columns = getTableColumns(schema[key] as unknown as Table) as unknown as Record<string, PgColumn>;
    this.serviceColumns = ["id", "created", "updated", ...Object.keys(scope)];
    for (const [column, value] of Object.entries(scope)) {
      if (typeof value !== "string" || !value) throw new Error(`DatabaseService(${key}) needs ${column}.`);
    }
  }

  async findMany<C extends FindMany<K>>(config?: C): Promise<Row<K, C>[]> {
    return this.query().findMany({ ...config, where: this.inScope(config?.where) }) as Promise<Row<K, C>[]>;
  }

  async findFirst<C extends FindFirst<K>>(config?: C): Promise<Row<K, C> | null> {
    return ((await this.query().findFirst({ ...config, where: this.inScope(config?.where) })) ?? null) as Row<
      K,
      C
    > | null;
  }

  async findById<C extends Omit<FindFirst<K>, "where">>(id: string, config?: C): Promise<Row<K, C> | null> {
    return this.findFirst({ ...config, where: { id } as unknown as Filter<K> } as C & FindFirst<K>);
  }

  async count(where?: Filter<K>): Promise<number> {
    const [row] = (await this.query().findMany({
      columns: {},
      extras: { n: sql<number>`count(*)::int` },
      where: this.inScope(where),
    })) as { n: number }[];
    return row?.n ?? 0;
  }

  /** `id`: one the caller made with `newId`, when it needs the id before the write. */
  async create(values: Values<K>, now: Date, options: { id?: string } = {}): Promise<Row<K>> {
    const [row] = await this.db
      .insert(this.table)
      .values(this.newRow(values, now, options.id) as never)
      .returning();
    return row as Row<K>;
  }

  async createMany(values: Values<K>[], now: Date): Promise<Row<K>[]> {
    if (values.length === 0) return [];
    return (await this.db
      .insert(this.table)
      .values(values.map((v) => this.newRow(v, now)) as never)
      .returning()) as Row<K>[];
  }

  /**
   * Write a row, or change the one with the same `conflict` columns in the scope: `change` is
   * what changes then. `inserted` says which. The columns must be a unique index with the scope.
   */
  async upsert(
    values: Values<K>,
    now: Date,
    conflict: Column<K>[],
    change: Changes<K>,
  ): Promise<{ row: Row<K>; inserted: boolean }> {
    const [written] = (await this.db
      .insert(this.table)
      .values(this.newRow(values, now) as never)
      .onConflictDoUpdate({
        target: this.conflictColumns(conflict),
        set: { ...this.writableValues(change), ...this.timestamps(now, false) } as never,
        setWhere: this.scopeSQL(),
      })
      // xmax is 0 on a row that was inserted, and set on one that was updated.
      .returning({ ...this.columns, inserted: sql<boolean>`(xmax = 0)` } as never)) as (Row<K> & {
      inserted: boolean;
    })[];
    const { inserted, ...row } = written!;
    return { row: row as unknown as Row<K>, inserted };
  }

  async createIfMissing(values: Values<K>, now: Date, conflict: Column<K>[]): Promise<boolean> {
    const written = await this.db
      .insert(this.table)
      .values(this.newRow(values, now) as never)
      .onConflictDoNothing({ target: this.conflictColumns(conflict) })
      .returning();
    return (written as unknown[]).length > 0;
  }

  /** Null when it is not in the scope. */
  async update(id: string, values: Changes<K>, now: Date): Promise<Row<K> | null> {
    return (await this.updateMany(idFilter(id), values, now))[0] ?? null;
  }

  async updateMany(where: WriteFilter<K>, values: Changes<K>, now: Date): Promise<Row<K>[]> {
    return this.write(where, { ...this.writableValues(values), ...this.timestamps(now, false) });
  }

  /** Record activity on one row, such as `last_used`: `updated` stays as it is. */
  async updateActivity(id: string, values: Changes<K>): Promise<Row<K> | null> {
    return (await this.write(idFilter(id), this.writableValues(values)))[0] ?? null;
  }

  /** False when it is not in the scope. */
  async delete(id: string): Promise<boolean> {
    return (await this.deleteMany(idFilter(id))).length > 0;
  }

  async deleteMany(where: WriteFilter<K>): Promise<Row<K>[]> {
    return (await this.db.delete(this.table).where(this.whereInScope(where)).returning()) as Row<K>[];
  }

  // The relational query builder of this table. Its type depends on K, which TypeScript cannot follow
  // inside the class; the public methods give the types.
  private query(): { findMany(config: object): Promise<unknown[]>; findFirst(config: object): Promise<unknown> } {
    return (this.db.query as unknown as Record<TableKey, ReturnType<DatabaseService<K>["query"]>>)[this.key];
  }

  private inScope(where: unknown): never {
    return (where ? { AND: [this.scope, where] } : this.scope) as never;
  }

  private scopeSQL(): SQL | undefined {
    return and(...Object.entries(this.scope).map(([column, value]) => eq(this.columns[column]!, value)));
  }

  private whereInScope(where: WriteFilter<K>): SQL {
    const built = relationsFilterToSQL(this.table, where as never);
    const scoped = and(this.scopeSQL(), built.sql ? new SQL(built.sql) : undefined);
    if (!scoped) throw new Error(`DatabaseService(${this.key}): a write to a global table needs a filter.`);
    return scoped;
  }

  private async write(where: WriteFilter<K>, set: Record<string, unknown>): Promise<Row<K>[]> {
    if (Object.keys(set).length === 0) throw new Error(`DatabaseService(${this.key}): nothing to write.`);
    return (await this.db
      .update(this.table)
      .set(set as never)
      .where(this.whereInScope(where))
      .returning()) as Row<K>[];
  }

  private newRow(values: Values<K>, now: Date, id = newId(PREFIXES[this.key])): Record<string, unknown> {
    // A table with no `id` column (definition_versions) gets no id.
    return {
      ...this.writableValues(values),
      ...this.timestamps(now, true),
      ...this.scope,
      ...("id" in this.columns ? { id } : {}),
    };
  }

  private conflictColumns(conflict: string[]): PgColumn[] {
    return [...Object.keys(this.scope), ...conflict].map((column) => this.columns[column]!);
  }

  private writableValues(values: object): Record<string, unknown> {
    return Object.fromEntries(Object.entries(values).filter(([column]) => !this.serviceColumns.includes(column)));
  }

  /** `created` for a new row, and `updated` where the table has it. */
  private timestamps(now: Date, isNew: boolean): Record<string, Date> {
    return {
      ...(isNew && "created" in this.columns ? { created: now } : {}),
      ...("updated" in this.columns ? { updated: now } : {}),
    };
  }
}
