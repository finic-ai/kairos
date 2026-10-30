import { sql } from "drizzle-orm";
import type { events } from "../db/schema";
import type { Executor } from "../platform/database";
import { DatabaseService } from "../platform/orm";
import { at, iso, rows } from "../platform/sql";
import type { StoredEvent } from "../types";

type EventRow = typeof events.$inferSelect;

/** The API calls the customer's id `id`. */
const toEvent = (r: EventRow): StoredEvent => ({
  id: r.externalId,
  type: r.type,
  ts: iso(r.ts),
  entities: r.entities,
  properties: r.properties,
  ...(r.universalId ? { universal_id: r.universalId } : {}),
  ...(r.status ? { status: r.status } : {}),
  ...(r.sessionId ? { session: r.sessionId } : {}),
  ...(r.metadata && Object.keys(r.metadata).length ? { metadata: r.metadata } : {}),
});

export class EventsService extends DatabaseService<"events"> {
  constructor(db: Executor, scope: { workspaceId: string; environmentId: string }) {
    super(db, "events", scope);
  }

  async findByExternalId(externalId: string): Promise<StoredEvent | null> {
    const r = await this.findFirst({ where: { externalId } });
    return r ? toEvent(r) : null;
  }

  async findIdByExternalId(externalId: string): Promise<string | null> {
    return (await this.findFirst({ where: { externalId }, columns: { id: true } }))?.id ?? null;
  }

  /** Events of one type in a period that a server sent (not through a public key), by status. */
  countByStatus(type: string, from: string, to: string): Promise<{ status: string | null; n: number }[]> {
    return rows(
      this.db,
      sql`SELECT status, COUNT(*)::int AS n FROM events WHERE workspace_id = ${this.scope.workspaceId} AND environment_id = ${this.scope.environmentId} AND type = ${type} AND ts >= ${at(from)} AND ts < ${at(to)} AND via IN ('key', 'webhook', 'console') GROUP BY status`,
    );
  }

  async listStages(universalId: string, until: string): Promise<StoredEvent[]> {
    const found = await this.findMany({
      where: { universalId, ts: { lte: new Date(until) } },
      orderBy: (t, { asc }) => [asc(t.ts), asc(sql`${t.externalId} COLLATE "C"`)],
    });
    return found.map(toEvent);
  }

  /** The latest `limit` events of a session up to `until`, oldest first. */
  async listInSession(session: string, until: string, limit: number): Promise<StoredEvent[]> {
    const found = await this.findMany({
      where: { sessionId: session, ts: { lte: new Date(until) } },
      orderBy: (t, { desc }) => [desc(t.ts), desc(sql`${t.externalId} COLLATE "C"`)],
      limit,
    });
    return found.reverse().map(toEvent);
  }
}
