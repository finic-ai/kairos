import { sql } from "drizzle-orm";
import type { Executor } from "../../platform/database";
import { eventEntities, events } from "../../db/schema";
import type {
  EntityRef,
  EventsRepository,
  EventVia,
  SessionFilter,
  SessionRow,
  SessionSummary,
  StoredEvent,
} from "../../types";
import { at, containing, iso, list, rows } from "../../platform/sql";
import { newId } from "../../platform/crypto";

type EventRow = {
  id: string;
  type: string;
  ts: Date;
  entities: Record<string, string>;
  properties: Record<string, unknown>;
  universal_id: string | null;
  status: string | null;
  session_id: string | null;
  metadata: Record<string, unknown>;
};

const toEvent = (r: EventRow): StoredEvent => ({
  id: r.id,
  type: r.type,
  ts: iso(r.ts),
  entities: r.entities,
  properties: r.properties,
  ...(r.universal_id ? { universal_id: r.universal_id } : {}),
  ...(r.status ? { status: r.status } : {}),
  ...(r.session_id ? { session: r.session_id } : {}),
  ...(r.metadata && Object.keys(r.metadata).length ? { metadata: r.metadata } : {}),
});

// The API calls the customer's id `id`.
const COLUMNS = sql`e.external_id AS id, e.type, e.ts, e.entities, e.properties, e.universal_id, e.status, e.session_id, e.metadata`;

export function eventsRepository(db: Executor): EventsRepository {
  return {
    async findEvent(workspaceId: string, environmentId: string, id: string) {
      const found = await rows<EventRow & { decision_id: string | null; outcome: string | null; risk: number | null }>(
        db,
        sql`SELECT ${COLUMNS}, d.id AS decision_id, d.decision ->> 'decision' AS outcome, (d.decision ->> 'risk_score')::float8 AS risk
              FROM events e
              LEFT JOIN decisions d ON d.workspace_id = e.workspace_id AND d.environment_id = e.environment_id AND d.event_id = e.id
             WHERE e.workspace_id = ${workspaceId} AND e.environment_id = ${environmentId} AND e.external_id = ${id}
             LIMIT 1`,
      );
      const r = found[0];
      if (!r) return null;
      return {
        ...toEvent(r),
        decision: r.decision_id ? { id: r.decision_id, outcome: r.outcome!, risk_score: r.risk ?? 0 } : null,
      };
    },

    async insertEvents(workspaceId: string, environmentId: string, batch: StoredEvent[], now: string, via?: EventVia) {
      if (batch.length === 0) return { accepted: 0, duplicates: 0, ids: [] as string[] };
      const accepted = await db.transaction(async (tx) => {
        // An id that was sent before is left as it is.
        const inserted = await tx
          .insert(events)
          .values(
            batch.map((e) => ({
              id: newId("evt"),
              workspaceId,
              environmentId,
              externalId: e.id,
              type: e.type,
              ts: new Date(e.ts),
              entities: e.entities,
              properties: e.properties,
              universalId: e.universal_id ?? null,
              status: e.status ?? null,
              sessionId: e.session ?? null,
              via: via ?? null,
              metadata: e.metadata ?? {},
              created: new Date(now),
            })),
          )
          .onConflictDoNothing()
          .returning({ id: events.id, externalId: events.externalId });
        const fresh = new Map(inserted.map((r) => [r.externalId, r.id]));
        const links: (typeof eventEntities.$inferInsert)[] = [];
        for (const e of batch) {
          // The first event with an id is the one that was stored.
          const eventId = fresh.get(e.id);
          if (!eventId) continue;
          fresh.delete(e.id);
          for (const [entityType, entityId] of Object.entries(e.entities))
            links.push({
              workspaceId,
              environmentId,
              entityType,
              entityId,
              ts: new Date(e.ts),
              eventId,
              created: new Date(now),
            });
        }
        for (let i = 0; i < links.length; i += 1000)
          await tx
            .insert(eventEntities)
            .values(links.slice(i, i + 1000))
            .onConflictDoNothing();
        return inserted.map((r) => r.externalId);
      });
      return { accepted: accepted.length, duplicates: batch.length - accepted.length, ids: accepted };
    },

    /**
     * Events of one type in a period that a server sent (not through a public key) and that no
     * decision names yet: what was not decided automatically in time.
     */
    async undecidedEvents(
      workspaceId: string,
      environmentId: string,
      type: string,
      from: string,
      to: string,
      limit: number,
    ): Promise<StoredEvent[]> {
      return (
        await rows<EventRow>(
          db,
          sql`SELECT ${COLUMNS} FROM events e
              WHERE e.workspace_id = ${workspaceId} AND e.environment_id = ${environmentId} AND e.type = ${type} AND e.ts >= ${at(from)} AND e.ts < ${at(to)}
                AND e.via IN ('key', 'webhook', 'console')
                AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.workspace_id = e.workspace_id AND d.environment_id = e.environment_id AND d.event_id = e.id)
              ORDER BY e.ts LIMIT ${limit}`,
        )
      ).map(toEvent);
    },

    async timeline(
      workspaceId: string,
      environmentId: string,
      entity: EntityRef,
      limit: number,
      until: string,
    ): Promise<StoredEvent[]> {
      const found = await rows<EventRow>(
        db,
        sql`SELECT ${COLUMNS}
              FROM event_entities x JOIN events e ON e.id = x.event_id
             WHERE x.workspace_id = ${workspaceId} AND x.environment_id = ${environmentId} AND x.entity_type = ${entity.type} AND x.entity_id = ${entity.id} AND x.ts <= ${at(until)}
             ORDER BY x.ts DESC, e.external_id COLLATE "C" DESC LIMIT ${limit}`,
      );
      return found.reverse().map(toEvent);
    },

    async listSessions(
      workspaceId: string,
      environmentId: string,
      filter: SessionFilter,
    ): Promise<{ sessions: SessionRow[]; total: number }> {
      const decided = filter.outcome
        ? sql`HAVING EXISTS (SELECT 1 FROM decisions d WHERE d.workspace_id = ${workspaceId} AND d.environment_id = ${environmentId} AND d.session_id = e.session_id ${filter.outcome === "any" ? sql`` : sql`AND d.decision ->> 'decision' = ${filter.outcome}`})`
        : sql``;
      const matching = sql`WITH s AS (
          SELECT e.session_id AS id, MIN(e.ts) AS started, MAX(e.ts) AS last_seen, COUNT(*)::int AS events
            FROM events e
           WHERE e.workspace_id = ${workspaceId} AND e.environment_id = ${environmentId} AND e.session_id IS NOT NULL ${filter.q ? sql`AND e.session_id ILIKE ${containing(filter.q)}` : sql``}
           GROUP BY e.session_id ${decided})`;
      const [page, counted] = await Promise.all([
        rows<{ id: string; started: Date; last_seen: Date; events: number }>(
          db,
          sql`${matching} SELECT * FROM s ORDER BY last_seen DESC, id COLLATE "C" LIMIT ${filter.limit} OFFSET ${filter.offset}`,
        ),
        rows<{ n: number }>(db, sql`${matching} SELECT COUNT(*)::int AS n FROM s`),
      ]);
      if (page.length === 0) return { sessions: [], total: counted[0]!.n };

      const ids = page.map((s) => s.id);
      const [made, named] = await Promise.all([
        rows<{ session_id: string; outcome: string; risk: number | null }>(
          db,
          sql`SELECT session_id, decision ->> 'decision' AS outcome, (decision ->> 'risk_score')::float8 AS risk FROM decisions WHERE workspace_id = ${workspaceId} AND environment_id = ${environmentId} AND session_id IN (${list(ids)})`,
        ),
        rows<{ session_id: string; type: string; id: string }>(
          db,
          sql`SELECT DISTINCT e.session_id, x.entity_type AS type, x.entity_id AS id
                FROM events e JOIN event_entities x ON x.event_id = e.id
               WHERE e.workspace_id = ${workspaceId} AND e.environment_id = ${environmentId} AND e.session_id IN (${list(ids)}) LIMIT 5000`,
        ),
      ]);
      const SEVERITY = ["approve", "step_up", "review", "block"];
      return {
        total: counted[0]!.n,
        sessions: page.map((s) => {
          const decisions = made.filter((d) => d.session_id === s.id);
          const entities: Record<string, string[]> = {};
          for (const n of named)
            if (n.session_id === s.id && (entities[n.type] ??= []).length < 5) entities[n.type]!.push(n.id);
          return {
            id: s.id,
            started: iso(s.started),
            last_seen: iso(s.last_seen),
            events: s.events,
            decisions: decisions.length,
            outcome: decisions.length
              ? decisions.map((d) => d.outcome).sort((a, b) => SEVERITY.indexOf(b) - SEVERITY.indexOf(a))[0]!
              : null,
            risk_score: decisions.length ? Math.max(...decisions.map((d) => d.risk ?? 0)) : null,
            entities,
          };
        }),
      };
    },

    async sessionsOf(
      workspaceId: string,
      environmentId: string,
      entity: EntityRef,
      limit: number,
    ): Promise<SessionSummary[]> {
      const found = await rows<{ id: string; started: Date; last_seen: Date; events: number }>(
        db,
        sql`SELECT e.session_id AS id, MIN(e.ts) AS started, MAX(e.ts) AS last_seen, COUNT(*)::int AS events
              FROM event_entities x JOIN events e ON e.id = x.event_id
             WHERE x.workspace_id = ${workspaceId} AND x.environment_id = ${environmentId} AND x.entity_type = ${entity.type} AND x.entity_id = ${entity.id} AND e.session_id IS NOT NULL
             GROUP BY e.session_id ORDER BY MAX(e.ts) DESC, e.session_id COLLATE "C" LIMIT ${limit}`,
      );
      return found.map((r) => ({ id: r.id, started: iso(r.started), last_seen: iso(r.last_seen), events: r.events }));
    },

    async eventsOfTypes(
      workspaceId: string,
      environmentId: string,
      entity: EntityRef,
      types: string[],
      since: string | null,
      until: string,
      limit: number,
    ): Promise<StoredEvent[]> {
      if (types.length === 0) return [];
      const found = await rows<EventRow>(
        db,
        sql`SELECT ${COLUMNS}
              FROM event_entities x JOIN events e ON e.id = x.event_id
             WHERE x.workspace_id = ${workspaceId} AND x.environment_id = ${environmentId} AND x.entity_type = ${entity.type} AND x.entity_id = ${entity.id} AND x.ts <= ${at(until)}
               ${since ? sql`AND x.ts > ${at(since)}` : sql``}
               AND e.type IN (${list(types)})
             ORDER BY x.ts DESC, e.external_id COLLATE "C" DESC LIMIT ${limit}`,
      );
      return found.reverse().map(toEvent);
    },
  };
}
