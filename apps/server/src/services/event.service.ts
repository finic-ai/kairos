import { sql } from "drizzle-orm";
import type { events } from "../db/schema";
import type { Executor } from "../platform/database";
import { DatabaseService } from "../platform/orm";
import { at, iso, rows } from "../platform/sql";
import type { EventTrace } from "../db/schema";
import type { StoredEvent } from "../types";

/** The span of an event is kept in its metadata: the API shows it as `trace`, apart from the rest. */
export function withTrace(metadata: Record<string, unknown> | null): Pick<StoredEvent, "trace" | "metadata"> {
  const { trace, ...rest } = metadata ?? {};
  return {
    ...(trace ? { trace: trace as EventTrace } : {}),
    ...(Object.keys(rest).length ? { metadata: rest } : {}),
  };
}

export const storedMetadata = (e: StoredEvent): Record<string, unknown> => ({
  ...e.metadata,
  ...(e.trace ? { trace: e.trace } : {}),
});

type EventRow = typeof events.$inferSelect;

export interface EventFilter {
  type?: string;
  status?: string;
  /** Events that name this entity. */
  entity?: { type: string; id: string };
  /** Events that happened at or after `from` and before `to`. */
  from?: string;
  to?: string;
}

/**
 * A request commits after its events get their `created`, so a poll looks this far back from
 * the last arrival it saw. The reader drops the events it already has.
 */
const ARRIVAL_OVERLAP_MS = 3_000;

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
  ...withTrace(r.metadata),
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

  /** The events that match, newest first: the console's list of events. */
  async listMatching(filter: EventFilter, limit: number, offset: number): Promise<StoredEvent[]> {
    const found = await this.findMany({
      where: this.matching(filter),
      orderBy: (t, { desc }) => [desc(t.ts), desc(t.id)],
      limit,
      offset,
    });
    return found.map(toEvent);
  }

  /** How many events match, counted up to `cap`: a list of millions does not need the exact number. */
  async countMatching(filter: EventFilter, cap: number): Promise<number> {
    const found = await this.findMany({ where: this.matching(filter), columns: { id: true }, limit: cap });
    return found.length;
  }

  /** When the oldest matching event happened. */
  async firstTs(filter: EventFilter): Promise<string | null> {
    const r = await this.findFirst({
      where: this.matching(filter),
      columns: { ts: true },
      orderBy: (t, { asc }) => [asc(t.ts)],
    });
    return r ? iso(r.ts) : null;
  }

  /** How many events match in each step of time from `from` to `to`, by type. Step 0 starts at the epoch. */
  countOverTime(
    filter: EventFilter & { from: string; to: string },
    stepSeconds: number,
  ): Promise<{ step: number; type: string; n: number }[]> {
    return rows(
      this.db,
      sql`SELECT floor(extract(epoch FROM ts) / ${stepSeconds}::int)::int AS step, type, COUNT(*)::int AS n FROM events
          WHERE workspace_id = ${this.scope.workspaceId} AND environment_id = ${this.scope.environmentId}
          AND ts >= ${at(filter.from)} AND ts < ${at(filter.to)}
          ${filter.type ? sql`AND type = ${filter.type}` : sql``}
          ${filter.status ? sql`AND status = ${filter.status}` : sql``}
          ${
            filter.entity
              ? sql`AND id IN (SELECT event_id FROM event_entities WHERE workspace_id = ${this.scope.workspaceId} AND environment_id = ${this.scope.environmentId} AND entity_type = ${filter.entity.type} AND entity_id = ${filter.entity.id})`
              : sql``
          }
          GROUP BY 1, 2`,
    );
  }

  /**
   * The matching events the server got after `after`, newest arrival first: what a live view
   * polls for. `cursor` is the `after` of the next poll. An event can be in two answers.
   */
  async listArrivals(
    filter: EventFilter,
    after: string,
    limit: number,
  ): Promise<{ events: StoredEvent[]; cursor: string }> {
    const found = await this.findMany({
      where: { ...this.matching(filter), created: { gt: new Date(new Date(after).getTime() - ARRIVAL_OVERLAP_MS) } },
      orderBy: (t, { desc }) => [desc(t.created), desc(t.id)],
      limit,
    });
    const latest = found[0] ? iso(found[0].created) : after;
    return { events: found.map(toEvent), cursor: latest > after ? latest : after };
  }

  private matching(filter: EventFilter) {
    return {
      ...(filter.type ? { type: filter.type } : {}),
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.from || filter.to
        ? {
            ts: {
              ...(filter.from ? { gte: new Date(filter.from) } : {}),
              ...(filter.to ? { lt: new Date(filter.to) } : {}),
            },
          }
        : {}),
      ...(filter.entity
        ? {
            RAW: (t: typeof events) =>
              sql`${t.id} IN (SELECT event_id FROM event_entities WHERE workspace_id = ${this.scope.workspaceId} AND environment_id = ${this.scope.environmentId} AND entity_type = ${filter.entity!.type} AND entity_id = ${filter.entity!.id})`,
          }
        : {}),
    };
  }

  async countForBacktest(type: string, statuses: string[] | undefined, period: { from?: string; to?: string }) {
    const [r] = await rows<{ n: number }>(
      this.db,
      sql`SELECT COUNT(*)::int AS n FROM events WHERE workspace_id = ${this.scope.workspaceId} AND environment_id = ${this.scope.environmentId} AND type = ${type}
          ${
            statuses
              ? sql`AND status IN (${sql.join(
                  statuses.map((s) => sql`${s}`),
                  sql`, `,
                )})`
              : sql``
          }
          AND (via IS NULL OR via IN ('key', 'webhook', 'console'))
          ${period.from ? sql`AND ts >= ${at(period.from)}` : sql``} ${period.to ? sql`AND ts < ${at(period.to)}` : sql``}`,
    );
    return r?.n ?? 0;
  }

  /**
   * Events of one type in a period, oldest first, after `after`: the past requests a backtest
   * replays. Only events a server sent, as for an automatic decision.
   */
  async listForBacktest(
    type: string,
    statuses: string[] | undefined,
    period: { from?: string; to?: string },
    after: { ts: string; id: string } | null,
    limit: number,
  ): Promise<(StoredEvent & { key: string })[]> {
    const found = await this.findMany({
      where: {
        type,
        ...(statuses ? { status: { in: statuses } } : {}),
        RAW: (t) =>
          sql.join(
            [
              sql`(${t.via} IS NULL OR ${t.via} IN ('key', 'webhook', 'console'))`,
              ...(period.from ? [sql`${t.ts} >= ${at(period.from)}`] : []),
              ...(period.to ? [sql`${t.ts} < ${at(period.to)}`] : []),
              ...(after ? [sql`(${t.ts}, ${t.id}) > (${at(after.ts)}, ${after.id})`] : []),
            ],
            sql` AND `,
          ),
      },
      orderBy: (t, { asc }) => [asc(t.ts), asc(t.id)],
      limit,
    });
    return found.map((r) => ({ ...toEvent(r), key: r.id }));
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
