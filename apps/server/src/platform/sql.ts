import { sql, type SQL } from "drizzle-orm";
import type { Executor } from "./database";

export function iso(value: Date | string): string;
export function iso(value: Date | string | null | undefined): string | null;
export function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

export const at = (value: string) => sql`${value}::timestamptz`;

export const list = (values: readonly unknown[]) =>
  sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );

/** Text is ordered byte by byte, whatever the locale of the database, so the order is the same everywhere. */
export const bytewise = (column: SQL) => sql`${column} COLLATE "C"`;

/** The pattern that finds `text` anywhere inside a value, with the wildcards of LIKE taken literally. */
export const containing = (text: string) => `%${text.replace(/[\\%_]/g, "\\$&")}%`;

type Row = Record<string, any>;

/** Run a query written by hand. Counts are cast to int in the query: Postgres returns a bigint as text. */
export async function rows<T = Row>(db: Pick<Executor, "execute">, query: SQL): Promise<T[]> {
  return (await db.execute<Row>(query)).rows as T[];
}

export async function first<T = Row>(db: Pick<Executor, "execute">, query: SQL): Promise<T | undefined> {
  return (await rows<T>(db, query))[0];
}

/** Holds a lock on one name until the transaction ends, so that a read and the write after it are one step. */
export const lock = (tx: Pick<Executor, "execute">, ...name: string[]) =>
  tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(name)}, 0))`);

/**
 * "The JSON object has `name` with this value", in the form a GIN index answers. `document`
 * is the indexed expression. The value comes from a query string, so "5" is the text "5" or
 * the number 5, and "true" is the text or the boolean.
 */
export function hasValue(document: SQL, name: string, text: string): SQL {
  const values: unknown[] = [text];
  if (text.trim() !== "" && Number.isFinite(Number(text))) values.push(Number(text));
  if (text === "true" || text === "false") values.push(text === "true");
  return sql`(${sql.join(
    values.map((value) => sql`${document} @> ${JSON.stringify({ [name]: value })}::jsonb`),
    sql` OR `,
  )})`;
}
