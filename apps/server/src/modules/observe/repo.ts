import { sql } from "drizzle-orm";
import type { Executor } from "../../platform/database";
import type { MetricRow } from "./schema";
import type { AnalyticsRepository, Usage, WorkspaceStats } from "../../types";
import { at, first, hasValue, iso, rows } from "../../platform/sql";

export function analyticsRepository(db: Executor): AnalyticsRepository {
  const stats = async (workspaceId: string, environmentId: string): Promise<WorkspaceStats> => {
    const outcomes: Record<string, number> = {};
    for (const r of await rows<{ outcome: string; n: number }>(
      db,
      sql`SELECT decision ->> 'decision' AS outcome, COUNT(*)::int AS n FROM decisions WHERE workspace_id = ${workspaceId} AND environment_id = ${environmentId} GROUP BY 1`,
    )) {
      outcomes[r.outcome] = r.n;
    }
    return {
      events: (await first<{ n: number }>(
        db,
        sql`SELECT COUNT(*)::int AS n FROM events WHERE workspace_id = ${workspaceId} AND environment_id = ${environmentId}`,
      ))!.n,
      decisions: Object.values(outcomes).reduce((a, b) => a + b, 0),
      outcomes,
      actions: (await first<{ n: number }>(
        db,
        sql`SELECT COUNT(DISTINCT name)::int AS n FROM actions WHERE workspace_id = ${workspaceId} AND environment_id = ${environmentId}`,
      ))!.n,
    };
  };

  return {
    stats,

    async usage(workspaceId: string, environmentId: string, since: string): Promise<Usage> {
      const days = new Map<string, Usage["days"][number]>();
      const day = (key: string) =>
        days.get(key) ?? days.set(key, { day: key, events: 0, decisions: 0, input_tokens: 0 }).get(key)!;
      // Events count by when the server got them, not by when they happened.
      const arrived = sql`created`;
      const utcDay = (moment: unknown) => sql`to_char(${moment} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
      const tokens = sql`COALESCE(SUM(CASE WHEN raw #>> '{usage,input_tokens}' ~ '^[0-9]+$' THEN (raw #>> '{usage,input_tokens}')::bigint ELSE 0 END), 0)::float8`;

      for (const r of await rows<{ day: string; n: number }>(
        db,
        sql`SELECT ${utcDay(arrived)} AS day, COUNT(*)::int AS n FROM events WHERE workspace_id = ${workspaceId} AND environment_id = ${environmentId} AND ${arrived} >= ${at(since)} GROUP BY 1`,
      )) {
        day(r.day).events = r.n;
      }
      for (const r of await rows<{ day: string; n: number; tokens: number }>(
        db,
        sql`SELECT ${utcDay(sql`ts`)} AS day, COUNT(*)::int AS n, ${tokens} AS tokens FROM decisions WHERE workspace_id = ${workspaceId} AND environment_id = ${environmentId} AND ts >= ${at(since)} GROUP BY 1`,
      )) {
        Object.assign(day(r.day), { decisions: r.n, input_tokens: r.tokens });
      }
      // "withdrawal@2" and "withdrawal@3" are one action.
      const actions = new Map<string, Usage["by_action"][number]>();
      for (const r of await rows<{ action: string; n: number; tokens: number }>(
        db,
        sql`SELECT action, COUNT(*)::int AS n, ${tokens} AS tokens FROM decisions WHERE workspace_id = ${workspaceId} AND environment_id = ${environmentId} AND ts >= ${at(since)} GROUP BY action`,
      )) {
        const name = r.action.split("@")[0]!;
        const entry =
          actions.get(name) ?? actions.set(name, { action: name, decisions: 0, input_tokens: 0 }).get(name)!;
        entry.decisions += r.n;
        entry.input_tokens += r.tokens;
      }
      const totals = await stats(workspaceId, environmentId);
      return {
        days: [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1)),
        by_action: [...actions.values()].sort((a, b) => b.decisions - a.decisions),
        by_event_type: await rows<{ type: string; events: number }>(
          db,
          sql`SELECT type, COUNT(*)::int AS events FROM events WHERE workspace_id = ${workspaceId} AND environment_id = ${environmentId} AND ${arrived} >= ${at(since)} GROUP BY type ORDER BY events DESC, type COLLATE "C" LIMIT 200`,
        ),
        stored: {
          events: totals.events,
          decisions: totals.decisions,
          entities: (await first<{ n: number }>(
            db,
            sql`SELECT COUNT(*)::int AS n FROM (
                  SELECT entity_type, entity_id FROM event_entities WHERE workspace_id = ${workspaceId} AND environment_id = ${environmentId}
                  UNION SELECT type, external_id FROM objects WHERE workspace_id = ${workspaceId} AND environment_id = ${environmentId}
                  UNION SELECT entity_type, entity_id FROM labels WHERE workspace_id = ${workspaceId} AND environment_id = ${environmentId}) known`,
          ))!.n,
        },
      };
    },

    async metricRows(
      workspaceId: string,
      environmentId: string,
      source: "decisions" | "events" | "labels",
      from: string,
      to: string,
      limit: number,
      eventType?: string,
      property?: { name: string; value: string },
    ): Promise<MetricRow[]> {
      const period = sql`workspace_id = ${workspaceId} AND environment_id = ${environmentId} AND ts >= ${at(from)} AND ts < ${at(to)}`;
      if (source === "decisions") {
        return (
          await rows(
            db,
            sql`SELECT ts, action, subject_type, subject_id, decision, final_outcome FROM decisions WHERE ${period} ORDER BY ts LIMIT ${limit}`,
          )
        ).map((r) => {
          const d = r.decision;
          return {
            ts: iso(r.ts),
            action: r.action,
            outcome: d.decision,
            final_outcome: r.final_outcome,
            typology: d.typology,
            signals: d.reasons ?? [],
            risk_score: d.risk_score,
            probability: d.probability,
            subject: `${r.subject_type}/${r.subject_id}`,
            subject_type: r.subject_type,
          };
        });
      }
      if (source === "labels") {
        return (
          await rows(
            db,
            sql`SELECT ts, label, entity_type, entity_id FROM labels WHERE ${period} ORDER BY ts LIMIT ${limit}`,
          )
        ).map((r) => ({
          ts: iso(r.ts),
          label: r.label,
          entity_type: r.entity_type,
          entity: `${r.entity_type}/${r.entity_id}`,
        }));
      }
      return (
        await rows(
          db,
          sql`SELECT ts, type, entities, properties FROM events WHERE ${period} ${eventType ? sql`AND type = ${eventType}` : sql``} ${property && property.value !== "" ? sql`AND ${hasValue(sql`(properties::jsonb)`, property.name, property.value)}` : sql``} ORDER BY ts LIMIT ${limit}`,
        )
      ).map((r) => ({ ts: iso(r.ts), type: r.type, entities: r.entities, properties: r.properties }));
    },

    async metricOptions(workspaceId: string, environmentId: string, eventType?: string) {
      const properties = new Map<string, boolean>();
      if (eventType) {
        for (const r of await rows<{ properties: Record<string, unknown> }>(
          db,
          sql`SELECT properties FROM events WHERE workspace_id = ${workspaceId} AND environment_id = ${environmentId} AND type = ${eventType} ORDER BY ts DESC LIMIT 200`,
        )) {
          for (const [name, value] of Object.entries(r.properties))
            properties.set(name, (properties.get(name) ?? true) && typeof value === "number");
        }
      }
      const names = async (query: ReturnType<typeof sql>) =>
        (await rows<{ name: string }>(db, query)).map((r) => r.name);
      return {
        event_types: await names(
          sql`SELECT type AS name FROM events WHERE workspace_id = ${workspaceId} AND environment_id = ${environmentId} GROUP BY type ORDER BY COUNT(*) DESC, type COLLATE "C" LIMIT 200`,
        ),
        labels: await names(
          sql`SELECT label AS name FROM labels WHERE workspace_id = ${workspaceId} AND environment_id = ${environmentId} GROUP BY label ORDER BY COUNT(*) DESC, label COLLATE "C" LIMIT 200`,
        ),
        entity_types: await names(
          sql`SELECT entity_type AS name FROM event_entities WHERE workspace_id = ${workspaceId} AND environment_id = ${environmentId} GROUP BY entity_type ORDER BY entity_type COLLATE "C" LIMIT 200`,
        ),
        event_properties: [...properties]
          .map(([name, numeric]) => ({ name, numeric }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
    },
  };
}
