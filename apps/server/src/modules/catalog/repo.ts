import type { EntityFilters, FactSource, ListSource } from "@kairos/core";
import { sql, type SQL } from "drizzle-orm";
import type { Executor } from "../../platform/database";
import type {
  EntitiesRepository,
  EntityFilter,
  EntityRef,
  EntityShape,
  EntitySummary,
  EntityTypeSummary,
  FactQuery,
  HistoryQuery,
  LabelCounts,
  LinkQuery,
  LinkSummary,
} from "../../types";
import { at, containing, first, hasValue, iso, list, rows } from "../../platform/sql";
import { EntitiesService } from "../../services/entities.service";
import { FOLDED, ObjectsService } from "../../services/object.service";
import type { Erased } from "./types";

const NUMBER = "^-?[0-9]+([.][0-9]+)?([eE][-+]?[0-9]+)?$";

const eventTypes = (f: EntityFilters) =>
  f.event_type === undefined ? [] : Array.isArray(f.event_type) ? f.event_type : [f.event_type];
const period = (column: SQL, from: string | null, to: string) =>
  sql`${column} < ${at(to)} ${from ? sql`AND ${column} >= ${at(from)}` : sql``}`;
const ASSIGNEE = sql`COALESCE(NULLIF(u.display_name, ''), NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''), split_part(u.email, '@', 1))`;

function about(
  workspaceId: string,
  environmentId: string,
  entity: EntityRef,
  source: Exclude<FactSource | ListSource, "linked">,
  filters: EntityFilters,
  range: { from: string | null; to: string },
  queues: string[],
): { from: SQL; where: SQL; ts: SQL } {
  const f = filters;
  if (source === "events") {
    const types = eventTypes(f);
    return {
      ts: sql`x.ts`,
      from: sql`event_entities x JOIN events e ON e.id = x.event_id`,
      where: sql`x.workspace_id = ${workspaceId} AND x.environment_id = ${environmentId} AND x.entity_type = ${entity.type} AND x.entity_id = ${entity.id}
        AND ${period(sql`x.ts`, range.from, range.to)}
        ${types.length ? sql`AND e.type IN (${list(types)})` : sql``}
        ${f.property ? sql`AND ${hasValue(sql`(e.properties::jsonb)`, f.property.name, f.property.value)}` : sql``}`,
    };
  }
  if (source === "decisions")
    return {
      ts: sql`d.ts`,
      from: sql`decisions d`,
      where: sql`d.workspace_id = ${workspaceId} AND d.environment_id = ${environmentId} AND d.subject_type = ${entity.type} AND d.subject_id = ${entity.id}
        AND ${period(sql`d.ts`, range.from, range.to)}
        ${f.action ? sql`AND split_part(d.action, '@', 1) = ${f.action}` : sql``}
        ${f.outcome?.length ? sql`AND d.decision ->> 'decision' IN (${list(f.outcome)})` : sql``}`,
    };
  if (source === "labels")
    return {
      ts: sql`l.ts`,
      from: sql`labels l`,
      where: sql`l.workspace_id = ${workspaceId} AND l.environment_id = ${environmentId} AND l.entity_type = ${entity.type} AND l.entity_id = ${entity.id}
        AND ${period(sql`l.ts`, range.from, range.to)} ${f.label ? sql`AND l.label = ${f.label}` : sql``}`,
    };
  return {
    ts: sql`c.created`,
    from: sql`cases c`,
    where: queues.length
      ? sql`c.workspace_id = ${workspaceId} AND c.environment_id = ${environmentId} AND c.queue_id IN (${list(queues)})
          AND ((c.target_type = ${entity.type} AND c.target_id = ${entity.id})
            OR EXISTS (SELECT 1 FROM case_items i WHERE i.case_id = c.id AND i.kind = 'entity' AND i.ref_type = ${entity.type} AND i.ref_id = ${entity.id}))
          AND ${period(sql`c.created`, range.from, range.to)}
          ${f.queue ? sql`AND c.queue_id = ${f.queue}` : sql``}
          ${f.status?.length ? sql`AND c.status IN (${list(f.status)})` : sql``}`
      : sql`FALSE`,
  };
}

export function entitiesRepository(db: Executor): EntitiesRepository {
  const entityRows = (workspaceId: string, environmentId: string, filter: Omit<EntityFilter, "limit" | "offset">) => {
    const type = filter.type;
    const mine = sql`x.workspace_id = ${workspaceId} AND x.environment_id = ${environmentId} AND x.entity_type = ${type} AND x.entity_id = ids.id`;

    const where: SQL[] = [];
    if (filter.labelled || filter.label === "*") where.push(sql`labels IS NOT NULL`);
    else if (filter.label === "!") where.push(sql`labels IS NULL`);
    else if (filter.label) where.push(sql`${filter.label} = ANY(string_to_array(labels, ' '))`);
    if (filter.outcome === "none") where.push(sql`decision IS NULL`);
    else if (filter.outcome) where.push(sql`decision ->> 'decision' = ${filter.outcome}`);
    if (filter.risk_min !== undefined) where.push(sql`(decision ->> 'risk_score')::float8 >= ${filter.risk_min}`);
    if (filter.active_since) where.push(sql`last_seen >= ${at(filter.active_since)}`);
    // A condition that needs a value is asked of the objects table itself, where the GIN index on
    // the properties answers "has this value" and "has this property". A condition that an entity
    // with no properties also meets ("is not", "has no") is asked of each entity afterwards.
    const having: SQL[] = [];
    for (const condition of filter.properties ?? []) {
      // The name goes in as a value, never into the SQL text.
      const name = condition.name;
      const text = condition.value ?? "";
      const own = sql`(o.properties ->> ${name}::text)`;
      const row = sql`(properties ->> ${name}::text)`;
      // "Is" does not look at upper and lower case. The index holds the properties in lower case
      // and finds the candidates; the comparison after it is the exact rule.
      const is = (value: SQL) => sql`lower(${value}) = lower(${text})`;
      if (condition.op === "exists") having.push(sql`(${FOLDED} ? ${name.toLowerCase()}::text AND ${own} IS NOT NULL)`);
      else if (condition.op === "eq")
        having.push(sql`(${hasValue(FOLDED, name.toLowerCase(), text.toLowerCase())} AND ${is(own)})`);
      else if (condition.op === "contains") having.push(sql`${own} ILIKE ${containing(text)}`);
      else if (condition.op === "gt" || condition.op === "lt") {
        const number = Number.isFinite(Number(text)) ? Number(text) : 0;
        const numeric = sql`(CASE WHEN ${own} ~ ${NUMBER} THEN ${own}::float8 END)`;
        having.push(condition.op === "gt" ? sql`${numeric} > ${number}` : sql`${numeric} < ${number}`);
      } else if (condition.op === "missing") where.push(sql`${row} IS NULL`);
      else where.push(sql`(${row} IS NULL OR NOT ${is(row)})`);
    }
    const ids: SQL[] = [];
    if (filter.q) ids.push(sql`ids.id ILIKE ${containing(filter.q)}`);
    if (having.length)
      ids.push(
        sql`ids.id IN (SELECT o.external_id FROM objects o WHERE o.workspace_id = ${workspaceId} AND o.environment_id = ${environmentId} AND o.type = ${type} AND ${sql.join(having, sql` AND `)})`,
      );

    const found = sql`WITH ids AS (
           SELECT entity_id AS id FROM event_entities WHERE workspace_id = ${workspaceId} AND environment_id = ${environmentId} AND entity_type = ${type}
           UNION SELECT external_id FROM objects WHERE workspace_id = ${workspaceId} AND environment_id = ${environmentId} AND type = ${type}
           UNION SELECT entity_id FROM labels WHERE workspace_id = ${workspaceId} AND environment_id = ${environmentId} AND entity_type = ${type}
         ),
         found AS (
           SELECT ids.id AS id,
                  (SELECT COUNT(*)::int FROM event_entities x WHERE ${mine}) AS events,
                  (SELECT MIN(x.ts) FROM event_entities x WHERE ${mine}) AS first_event,
                  (SELECT MAX(x.ts) FROM event_entities x WHERE ${mine}) AS last_seen,
                  (SELECT o.first_seen FROM objects o WHERE o.workspace_id = ${workspaceId} AND o.environment_id = ${environmentId} AND o.type = ${type} AND o.external_id = ids.id) AS created,
                  (SELECT o.properties FROM objects o WHERE o.workspace_id = ${workspaceId} AND o.environment_id = ${environmentId} AND o.type = ${type} AND o.external_id = ids.id) AS properties,
                  (SELECT string_agg(l.label, ' ' ORDER BY l.ts, l.label) FROM labels l WHERE l.workspace_id = ${workspaceId} AND l.environment_id = ${environmentId} AND l.entity_type = ${type} AND l.entity_id = ids.id) AS labels,
                  (SELECT d.decision FROM decisions d WHERE d.workspace_id = ${workspaceId} AND d.environment_id = ${environmentId} AND d.subject_type = ${type} AND d.subject_id = ids.id ORDER BY d.ts DESC LIMIT 1) AS decision
             FROM ids ${ids.length ? sql`WHERE ${sql.join(ids, sql` AND `)}` : sql``}
         )`;
    return { found, where: where.length ? sql`WHERE ${sql.join(where, sql` AND `)}` : sql`` };
  };

  return {
    async entityOfRecord(
      workspaceId: string,
      environmentId: string,
      universalId: string,
      type: string,
    ): Promise<string | null> {
      const [found] = await rows<{ id: string }>(
        db,
        sql`SELECT entities ->> ${type} AS id FROM events WHERE workspace_id = ${workspaceId} AND environment_id = ${environmentId} AND universal_id = ${universalId} AND entities ->> ${type} IS NOT NULL ORDER BY ts LIMIT 1`,
      );
      return found?.id ?? null;
    },

    async linkSummary(
      workspaceId: string,
      environmentId: string,
      subject: EntityRef,
      via: EntityRef,
      q: LinkQuery,
    ): Promise<LinkSummary> {
      const seen = await first<{ ts: Date | null }>(
        db,
        sql`SELECT MIN(ts) AS ts FROM event_entities WHERE workspace_id = ${workspaceId} AND environment_id = ${environmentId} AND entity_type = ${via.type} AND entity_id = ${via.id}`,
      );
      const others = async (from: string | null, cap: number) =>
        (
          await rows<{ id: string }>(
            db,
            sql`SELECT DISTINCT s.entity_id AS id
                  FROM event_entities x JOIN event_entities s ON s.event_id = x.event_id
                 WHERE x.workspace_id = ${workspaceId} AND x.environment_id = ${environmentId} AND x.entity_type = ${via.type} AND x.entity_id = ${via.id} AND x.ts <= ${at(q.until)} ${from ? sql`AND x.ts >= ${at(from)}` : sql``}
                   AND s.entity_type = ${subject.type} AND s.entity_id <> ${subject.id}
                 LIMIT ${cap + 1}`,
          )
        ).map((r) => r.id);
      const labelsOf = async (ids: string[]): Promise<LabelCounts> => {
        const out: LabelCounts = {};
        for (let i = 0; i < ids.length; i += 500) {
          const chunk = ids.slice(i, i + 500);
          for (const r of await rows<{ label: string; n: number }>(
            db,
            sql`SELECT label, COUNT(*)::int AS n FROM labels WHERE workspace_id = ${workspaceId} AND environment_id = ${environmentId} AND entity_type = ${subject.type} AND ts <= ${at(q.until)} AND entity_id IN (${list(chunk)}) GROUP BY label`,
          ))
            out[r.label] = (out[r.label] ?? 0) + r.n;
        }
        return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
      };

      const all = await others(null, q.limit);
      const recent = await others(q.since, q.recentLimit);
      const fresh = new Set<string>();
      for (let i = 0; i < recent.length; i += 500) {
        const chunk = recent.slice(i, i + 500);
        for (const r of await rows<{ id: string }>(
          db,
          sql`SELECT entity_id AS id FROM event_entities WHERE workspace_id = ${workspaceId} AND environment_id = ${environmentId} AND entity_type = ${subject.type} AND entity_id IN (${list(chunk)})
               GROUP BY entity_id HAVING MIN(ts) >= ${at(q.since)}`,
        ))
          fresh.add(r.id);
      }
      const lastDay = recent.length ? await others(q.day, q.recentLimit) : [];
      const near = recent.length ? await others(q.near, q.recentLimit) : [];
      const newIn = (ids: string[]) => ids.filter((id) => fresh.has(id)).length;
      return {
        first_seen: iso(seen?.ts),
        others: all.length,
        // Past the limit this is a very common entity: the all-time picture says nothing, the recent window still can.
        labels: all.length > q.limit ? {} : await labelsOf(all),
        recent: {
          others: recent.length,
          new: fresh.size,
          last_day: lastDay.length,
          last_day_new: newIn(lastDay),
          near: near.length,
          near_new: newIn(near),
          labels: await labelsOf(recent),
        },
      };
    },

    async labelRates(workspaceId: string, environmentId: string, type: string, until?: string) {
      const before = until ? sql` AND ts <= ${at(until)}` : sql``;
      const total = (await first<{ n: number }>(
        db,
        sql`SELECT COUNT(DISTINCT entity_id)::int AS n FROM event_entities WHERE workspace_id = ${workspaceId} AND environment_id = ${environmentId} AND entity_type = ${type}${before}`,
      ))!.n;
      const counts: LabelCounts = {};
      for (const r of await rows<{ label: string; n: number }>(
        db,
        sql`SELECT label, COUNT(*)::int AS n FROM labels WHERE workspace_id = ${workspaceId} AND environment_id = ${environmentId} AND entity_type = ${type}${before} GROUP BY label`,
      ))
        counts[r.label] = r.n;
      return { total, labels: counts };
    },

    async entityTypes(workspaceId: string, environmentId: string): Promise<EntityTypeSummary[]> {
      const counts = await rows<{ type: string; count: number }>(
        db,
        sql`SELECT type, COUNT(*)::int AS count FROM (
              SELECT entity_type AS type, entity_id AS id FROM event_entities WHERE workspace_id = ${workspaceId} AND environment_id = ${environmentId}
              UNION SELECT type, external_id FROM objects WHERE workspace_id = ${workspaceId} AND environment_id = ${environmentId}
              UNION SELECT entity_type, entity_id FROM labels WHERE workspace_id = ${workspaceId} AND environment_id = ${environmentId}
            ) known GROUP BY type`,
      );
      const events = new Map(
        (
          await rows<{ type: string; events: number; last_seen: Date }>(
            db,
            sql`SELECT entity_type AS type, COUNT(*)::int AS events, MAX(ts) AS last_seen FROM event_entities WHERE workspace_id = ${workspaceId} AND environment_id = ${environmentId} GROUP BY entity_type`,
          )
        ).map((r) => [r.type, r]),
      );
      const labelled = new Map(
        (
          await rows<{ type: string; n: number }>(
            db,
            sql`SELECT entity_type AS type, COUNT(DISTINCT entity_id)::int AS n FROM labels WHERE workspace_id = ${workspaceId} AND environment_id = ${environmentId} GROUP BY entity_type`,
          )
        ).map((r) => [r.type, r.n]),
      );
      const defined = new Map(
        (
          await new EntitiesService(db, { workspaceId, environmentId }).findMany({
            columns: { type: true, definition: true },
          })
        ).map((r) => [r.type, r.definition]),
      );
      const byType = new Map(counts.map((r) => [r.type, r.count]));
      for (const type of defined.keys()) if (!byType.has(type)) byType.set(type, 0); // defined, nothing recorded yet
      return [...byType]
        .map(([type, count]) => ({
          type,
          count,
          events: events.get(type)?.events ?? 0,
          labelled: labelled.get(type) ?? 0,
          last_seen: iso(events.get(type)?.last_seen),
          ...(defined.has(type) ? { definition: defined.get(type)! } : {}),
        }))
        .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
    },

    async entityShape(workspaceId: string, environmentId: string, type: string): Promise<EntityShape> {
      const SAMPLE = 500;
      const sample = await rows<{ properties: Record<string, unknown> }>(
        db,
        sql`SELECT properties FROM objects WHERE workspace_id = ${workspaceId} AND environment_id = ${environmentId} AND type = ${type} ORDER BY updated DESC LIMIT ${SAMPLE}`,
      );
      const seen = new Map<string, { seen: number; types: Set<string>; example: unknown }>();
      for (const row of sample) {
        for (const [name, value] of Object.entries(row.properties)) {
          const entry = seen.get(name) ?? { seen: 0, types: new Set<string>(), example: value };
          entry.seen += 1;
          entry.types.add(value === null ? "null" : Array.isArray(value) ? "array" : typeof value);
          seen.set(name, entry);
        }
      }
      return {
        type,
        with_properties: (await first<{ n: number }>(
          db,
          sql`SELECT COUNT(*)::int AS n FROM objects WHERE workspace_id = ${workspaceId} AND environment_id = ${environmentId} AND type = ${type}`,
        ))!.n,
        sampled: sample.length,
        properties: [...seen]
          .map(([name, entry]) => ({ name, seen: entry.seen, types: [...entry.types].sort(), example: entry.example }))
          .sort((a, b) => b.seen - a.seen || a.name.localeCompare(b.name)),
        events: await rows<{ type: string; count: number }>(
          db,
          sql`SELECT e.type AS type, COUNT(*)::int AS count FROM event_entities ee
                JOIN events e ON e.id = ee.event_id
               WHERE ee.workspace_id = ${workspaceId} AND ee.environment_id = ${environmentId} AND ee.entity_type = ${type} GROUP BY e.type ORDER BY count DESC, e.type COLLATE "C" LIMIT 30`,
        ),
        labels: await rows<{ label: string; count: number }>(
          db,
          sql`SELECT label, COUNT(*)::int AS count FROM labels WHERE workspace_id = ${workspaceId} AND environment_id = ${environmentId} AND entity_type = ${type} GROUP BY label ORDER BY count DESC, label COLLATE "C" LIMIT 30`,
        ),
      };
    },

    async countEntities(
      workspaceId: string,
      environmentId: string,
      filter: Omit<EntityFilter, "limit" | "offset">,
    ): Promise<number> {
      const q = entityRows(workspaceId, environmentId, filter);
      return (await first<{ n: number }>(db, sql`${q.found} SELECT COUNT(*)::int AS n FROM found ${q.where}`))!.n;
    },

    async fact(workspaceId: string, environmentId: string, entity: EntityRef, query: FactQuery) {
      const { from, where, ts } = about(
        workspaceId,
        environmentId,
        entity,
        query.source,
        query.filters ?? {},
        query,
        query.queues,
      );
      const value =
        query.source === "decisions"
          ? sql`(d.decision ->> 'risk_score')::float8`
          : sql`CASE WHEN (e.properties::jsonb ->> ${query.field ?? ""}) ~ ${NUMBER} THEN (e.properties::jsonb ->> ${query.field ?? ""})::float8 END`;
      const measure = {
        count: sql`COUNT(*)::int`,
        sum: sql`COALESCE(SUM(${value}), 0)::float8`,
        avg: sql`AVG(${value})::float8`,
        unique: sql`COUNT(DISTINCT e.entities::jsonb ->> ${query.field ?? ""})::int`,
        first: sql`MIN(${ts})`,
        last: sql`MAX(${ts})`,
      }[query.measure];
      const found = await first<{ v: number | string | Date | null }>(
        db,
        sql`SELECT ${measure} AS v FROM ${from} WHERE ${where}`,
      );
      const v = found?.v ?? null;
      if (v === null) return null;
      return query.measure === "first" || query.measure === "last" ? iso(v as string | Date) : Number(v);
    },

    async history(workspaceId: string, environmentId: string, entity: EntityRef, query: HistoryQuery) {
      const f = query.filters ?? {};
      const page = sql`LIMIT ${query.limit} OFFSET ${query.offset}`;
      const like = query.q ? containing(query.q) : null;
      if (query.source === "linked") {
        const types = eventTypes(f);
        const other = query.entityType ?? "";
        const linked = sql`WITH found AS (
            SELECT y.entity_id AS id, MIN(y.ts) AS first_seen, MAX(y.ts) AS last_seen, COUNT(DISTINCT y.event_id)::int AS events
              FROM event_entities x
              JOIN event_entities y ON y.workspace_id = x.workspace_id AND y.environment_id = x.environment_id AND y.event_id = x.event_id
              ${types.length ? sql`JOIN events e ON e.id = x.event_id` : sql``}
             WHERE x.workspace_id = ${workspaceId} AND x.environment_id = ${environmentId} AND x.entity_type = ${entity.type} AND x.entity_id = ${entity.id}
               AND y.entity_type = ${other} AND NOT (y.entity_type = ${entity.type} AND y.entity_id = ${entity.id})
               AND ${period(sql`x.ts`, query.from, query.to)}
               ${types.length ? sql`AND e.type IN (${list(types)})` : sql``}
               ${like ? sql`AND y.entity_id ILIKE ${like}` : sql``}
             GROUP BY y.entity_id)`;
        const order = query.sort === "oldest" ? sql`f.first_seen ASC` : sql`f.last_seen DESC`;
        const [found, counted] = await Promise.all([
          rows<{ id: string; first_seen: Date; last_seen: Date; events: number; properties: Record<string, unknown> }>(
            db,
            sql`${linked} SELECT f.*, COALESCE(o.properties, '{}'::json) AS properties FROM found f
                  LEFT JOIN objects o ON o.workspace_id = ${workspaceId} AND o.environment_id = ${environmentId} AND o.type = ${other} AND o.external_id = f.id
                 ORDER BY ${order}, f.id COLLATE "C" ${page}`,
          ),
          first<{ n: number }>(db, sql`${linked} SELECT COUNT(*)::int AS n FROM found`),
        ]);
        return {
          total: counted!.n,
          rows: found.map((r) => ({
            source: "linked" as const,
            id: r.id,
            type: other,
            first_seen: iso(r.first_seen),
            last_seen: iso(r.last_seen),
            events: r.events,
            properties: r.properties,
          })),
        };
      }
      const { from, where, ts } = about(workspaceId, environmentId, entity, query.source, f, query, query.queues);
      const direction = query.sort === "oldest" ? sql`ASC` : sql`DESC`;
      const total = async (search: SQL) =>
        (await first<{ n: number }>(db, sql`SELECT COUNT(*)::int AS n FROM ${from} WHERE ${where} ${search}`))!.n;
      if (query.source === "events") {
        const search = like
          ? sql`AND (e.external_id ILIKE ${like} OR e.type ILIKE ${like} OR e.properties::text ILIKE ${like})`
          : sql``;
        const [found, n] = await Promise.all([
          rows<{
            id: string;
            type: string;
            ts: Date;
            properties: Record<string, unknown>;
            decision_id: string | null;
            outcome: string | null;
            risk: number | null;
          }>(
            db,
            sql`SELECT e.external_id AS id, e.type, ${ts} AS ts, e.properties, d.id AS decision_id,
                       d.decision ->> 'decision' AS outcome, (d.decision ->> 'risk_score')::float8 AS risk
                  FROM ${from}
                  LEFT JOIN decisions d ON d.workspace_id = e.workspace_id AND d.environment_id = e.environment_id AND d.event_id = e.id
                 WHERE ${where} ${search}
                 ORDER BY ${ts} ${direction}, e.external_id COLLATE "C" ${direction} ${page}`,
          ),
          total(search),
        ]);
        return { total: n, rows: found.map((r) => ({ source: "events" as const, ...r, ts: iso(r.ts) })) };
      }
      if (query.source === "decisions") {
        const search = like ? sql`AND d.id ILIKE ${like}` : sql``;
        const [found, n] = await Promise.all([
          rows<{
            id: string;
            ts: Date;
            action: string;
            outcome: string;
            risk: number;
            final_outcome: string;
            properties: Record<string, unknown> | null;
          }>(
            db,
            sql`SELECT d.id, d.ts, split_part(d.action, '@', 1) AS action, d.decision ->> 'decision' AS outcome,
                       (d.decision ->> 'risk_score')::float8 AS risk, d.final_outcome, d.request -> 'properties' AS properties
                  FROM ${from} WHERE ${where} ${search}
                 ORDER BY d.ts ${direction}, d.id ${direction} ${page}`,
          ),
          total(search),
        ]);
        return {
          total: n,
          rows: found.map((r) => ({
            source: "decisions" as const,
            ...r,
            ts: iso(r.ts),
            properties: r.properties ?? {},
          })),
        };
      }
      const search = like ? sql`AND c.id ILIKE ${like}` : sql``;
      const [found, n] = await Promise.all([
        rows<{
          id: string;
          ts: Date;
          status: string;
          priority: string;
          queue_id: string;
          assignee: string | null;
          resolution: string | null;
        }>(
          db,
          sql`SELECT c.id, c.created AS ts, c.status, c.priority, c.queue_id, CASE WHEN u.id IS NULL THEN NULL ELSE ${ASSIGNEE} END AS assignee,
                     c.resolution ->> 'category' AS resolution
                FROM ${from} LEFT JOIN users u ON u.id = c.assignee_id
               WHERE ${where} ${search}
               ORDER BY c.created ${direction}, c.id ${direction} ${page}`,
        ),
        total(search),
      ]);
      return { total: n, rows: found.map((r) => ({ source: "cases" as const, ...r, ts: iso(r.ts) })) };
    },

    async listEntities(workspaceId: string, environmentId: string, filter: EntityFilter): Promise<EntitySummary[]> {
      const q = entityRows(workspaceId, environmentId, filter);
      // An entity with no value for the order goes where it has least to say: last, or first for the oldest.
      const order = {
        active: sql`COALESCE(last_seen, created) DESC NULLS LAST`,
        events: sql`events DESC`,
        risk: sql`(decision ->> 'risk_score')::float8 DESC NULLS LAST`,
        first_seen: sql`COALESCE(first_event, created) ASC NULLS FIRST`,
      }[filter.sort ?? "active"];
      const found = await rows(
        db,
        sql`${q.found} SELECT * FROM found ${q.where} ORDER BY ${order}, id COLLATE "C" LIMIT ${filter.limit} OFFSET ${filter.offset}`,
      );
      return found.map((r) => ({
        id: r.id,
        events: r.events,
        first_seen: iso(r.first_event ?? r.created),
        last_seen: iso(r.last_seen),
        labels: r.labels ? String(r.labels).split(" ") : [],
        decision: r.decision ?? null,
        properties: r.properties ?? {},
      }));
    },
  };
}

const REDACTED = JSON.stringify({ erased: true });

/**
 * Finds an entity named anywhere in a document, as `{ "<type>": "<id>" }`: a request's or a
 * trigger's entities, or an event as the model read it. A context lists linked entities as "<type> <id>".
 */
const NAMED = '$.** ? (@.type() == "object").keyvalue() ? (@.key == $type && @.value == $id)';
const LINKED = "$.linked_entities.keyvalue() ? (@.key == $linked)";

const count = async (tx: Executor, query: ReturnType<typeof sql>) =>
  Number((await tx.execute<Record<string, unknown>>(query)).rows[0]?.n ?? 0);

/**
 * Erases what Kairos holds about one entity in one environment: the entity and its properties,
 * its labels, its own events, the decisions and cases about it, and the copies of these in
 * cases, workflow runs and webhook deliveries. One transaction. Null when Kairos holds nothing
 * about it.
 *
 * What is someone else's stays, without this entity: an event that also names another entity
 * (a transfer's other side, a shared device) loses its link to it and its properties, and a
 * decision or a run about someone else that saw it loses what it saw.
 */
export async function eraseEntity(
  db: Executor,
  scope: { workspaceId: string; environmentId: string },
  entity: { type: string; id: string },
  options: { dryRun?: boolean } = {},
): Promise<Erased | null> {
  const { workspaceId: ws, environmentId: env } = scope;
  const { type, id } = entity;
  const keys = [`subject:${type}:${id}`, `entity:${type}:${id}`];
  const vars = sql`jsonb_build_object('type', ${type}::text, 'id', ${id}::text, 'linked', ${`${type} ${id}`}::text)`;
  const names = (column: ReturnType<typeof sql>) =>
    sql`(jsonb_path_exists(${column}, ${NAMED}::jsonpath, ${vars}) OR jsonb_path_exists(${column}, ${LINKED}::jsonpath, ${vars}))`;

  return db.transaction(async (tx) => {
    // An event about the entity that arrives now waits, and is not half kept.
    await new ObjectsService(tx, { workspaceId: ws, environmentId: env }).lockEntity(entity);

    // Dropped at commit; dropped first too, for a second erasure in one outer transaction.
    await tx.execute(sql`DROP TABLE IF EXISTS erase_events, erase_decisions, erase_cases, erase_runs`);
    await tx.execute(sql`CREATE TEMP TABLE erase_events ON COMMIT DROP AS
      SELECT DISTINCT e.id, e.external_id, EXISTS (SELECT 1 FROM event_entities o WHERE o.event_id = e.id
          AND (o.entity_type <> ${type} OR o.entity_id <> ${id})) AS shared
        FROM event_entities x JOIN events e ON e.id = x.event_id
       WHERE x.workspace_id = ${ws} AND x.environment_id = ${env} AND x.entity_type = ${type} AND x.entity_id = ${id}`);
    await tx.execute(sql`CREATE TEMP TABLE erase_decisions ON COMMIT DROP AS
      SELECT id, metadata ->> 'workflow_run_id' AS run_id FROM decisions
       WHERE workspace_id = ${ws} AND environment_id = ${env} AND subject_type = ${type} AND subject_id = ${id}`);
    await tx.execute(sql`CREATE TEMP TABLE erase_cases ON COMMIT DROP AS
      SELECT id FROM cases
       WHERE workspace_id = ${ws} AND environment_id = ${env}
         AND ((target_type = ${type} AND target_id = ${id}) OR correlation_key = ANY(${sql.param(keys)}::text[]))`);
    // A run still going keeps its trigger: it needs it to finish.
    await tx.execute(sql`CREATE TEMP TABLE erase_runs ON COMMIT DROP AS
      SELECT id, id IN (SELECT run_id FROM erase_decisions WHERE run_id IS NOT NULL) AS own FROM workflow_runs
       WHERE workspace_id = ${ws} AND environment_id = ${env} AND status NOT IN ('queued', 'running', 'waiting')
         AND (id IN (SELECT run_id FROM erase_decisions WHERE run_id IS NOT NULL)
           OR key IN (SELECT 'event:' || external_id FROM erase_events) OR ${names(sql`trigger`)})`);

    const where = sql`workspace_id = ${ws} AND environment_id = ${env}`;
    const objectWhere = sql`${where} AND type = ${type} AND external_id = ${id}`;
    const labelWhere = sql`${where} AND entity_type = ${type} AND entity_id = ${id}`;
    // Someone else's decision that showed the model this entity: started by one of its events, or
    // naming it in the request or in an event the model read.
    const redactWhere = sql`${where} AND id NOT IN (SELECT id FROM erase_decisions) AND (
      event_id IN (SELECT id FROM erase_events) OR ${names(sql`request::jsonb`)} OR ${names(sql`context::jsonb`)})`;
    const itemWhere = sql`${where} AND case_id NOT IN (SELECT id FROM erase_cases) AND (
      (kind = 'entity' AND ref_type = ${type} AND ref_id = ${id})
      OR (kind = 'decision' AND ref_id IN (SELECT id FROM erase_decisions))
      OR (kind = 'event' AND ref_id IN (SELECT external_id FROM erase_events WHERE NOT shared)))`;
    const evidenceWhere = sql`${where} AND case_id NOT IN (SELECT id FROM erase_cases) AND (
      (source_type = 'decision' AND source_id IN (SELECT id FROM erase_decisions))
      OR (source_type = 'event' AND source_id IN (SELECT external_id FROM erase_events)))`;
    const outboundWhere = sql`${where} AND direction = 'out' AND (subject_ref = ${`entity:${type}:${id}`}
      OR subject_ref IN (SELECT 'decision:' || id FROM erase_decisions)
      OR subject_ref IN (SELECT 'case:' || id FROM erase_cases))`;
    const inboundWhere = sql`${where} AND direction = 'in' AND payload IS NOT NULL
      AND result -> 'event_ids' ?| ARRAY(SELECT external_id FROM erase_events)`;

    const erased: Erased = {
      entity: await count(tx, sql`SELECT count(*) AS n FROM objects WHERE ${objectWhere}`),
      labels: await count(tx, sql`SELECT count(*) AS n FROM labels WHERE ${labelWhere}`),
      events: await count(tx, sql`SELECT count(*) AS n FROM erase_events WHERE NOT shared`),
      events_redacted: await count(tx, sql`SELECT count(*) AS n FROM erase_events WHERE shared`),
      decisions: await count(tx, sql`SELECT count(*) AS n FROM erase_decisions`),
      decisions_redacted: await count(tx, sql`SELECT count(*) AS n FROM decisions WHERE ${redactWhere}`),
      cases: await count(tx, sql`SELECT count(*) AS n FROM erase_cases`),
      case_items: await count(tx, sql`SELECT count(*) AS n FROM case_items WHERE ${itemWhere}`),
      case_evidence: await count(tx, sql`SELECT count(*) AS n FROM case_evidence WHERE ${evidenceWhere}`),
      workflow_runs: await count(tx, sql`SELECT count(*) AS n FROM erase_runs WHERE own`),
      workflow_runs_redacted: await count(tx, sql`SELECT count(*) AS n FROM erase_runs WHERE NOT own`),
      webhook_deliveries: await count(tx, sql`SELECT count(*) AS n FROM webhook_deliveries WHERE ${outboundWhere}`),
      webhook_payloads_redacted: await count(
        tx,
        sql`SELECT count(*) AS n FROM webhook_deliveries WHERE ${inboundWhere}`,
      ),
    };
    if (Object.values(erased).every((n) => n === 0)) return null;
    if (options.dryRun) return erased;

    // Copies first, then what they copy. Case evidence, items and activity go with their case.
    await tx.execute(sql`DELETE FROM webhook_deliveries WHERE ${outboundWhere}`);
    await tx.execute(sql`UPDATE webhook_deliveries SET payload = NULL, headers = NULL WHERE ${inboundWhere}`);
    await tx.execute(sql`DELETE FROM case_items WHERE ${itemWhere}`);
    await tx.execute(sql`DELETE FROM case_evidence WHERE ${evidenceWhere}`);
    await tx.execute(sql`DELETE FROM cases WHERE id IN (SELECT id FROM erase_cases)`);
    await tx.execute(sql`DELETE FROM workflow_runs WHERE id IN (SELECT id FROM erase_runs WHERE own)`);
    await tx.execute(sql`UPDATE workflow_runs SET trigger = ${REDACTED}::jsonb, steps = NULL, output = NULL, error = NULL
      WHERE id IN (SELECT id FROM erase_runs WHERE NOT own)`);
    await tx.execute(sql`UPDATE decisions SET context = ${REDACTED}::json, raw = ${REDACTED}::json, request = NULL,
      metadata = metadata || jsonb_build_object('erased_at', now()) WHERE ${redactWhere}`);
    await tx.execute(sql`DELETE FROM decisions WHERE id IN (SELECT id FROM erase_decisions)`);
    // A shared event's properties may be about this entity, and nothing tells whose they are.
    await tx.execute(sql`UPDATE events SET entities = (entities::jsonb - ${type})::json, properties = '{}'::json,
      metadata = metadata || jsonb_build_object('erased_at', now())
      WHERE id IN (SELECT id FROM erase_events WHERE shared)`);
    await tx.execute(sql`DELETE FROM event_entities WHERE ${labelWhere} AND event_id IN (SELECT id FROM erase_events)`);
    // event_entities go with their events.
    await tx.execute(sql`DELETE FROM events WHERE id IN (SELECT id FROM erase_events WHERE NOT shared)`);
    await tx.execute(sql`DELETE FROM labels WHERE ${labelWhere}`);
    await tx.execute(sql`DELETE FROM objects WHERE ${objectWhere}`);
    return erased;
  });
}
