import type { ActionDefinition } from "@kairos/core";
import { and, eq, sql, type SQL } from "drizzle-orm";
import type { Executor } from "../../platform/database";
import { actions, environments, type EnvironmentRow } from "../../db/schema";
import { newId } from "../../platform/crypto";
import { DashboardsService } from "../../services/dashboard.service";
import { QueuesService } from "../../services/queue.service";
import { EntitiesService } from "../../services/entities.service";
import { EnvironmentsService } from "../../services/environment.service";
import type { Environment } from "../../types";
import { iso, rows } from "../../platform/sql";
import type { CopyOptionsQuery, EnvironmentCopyOptions } from "./schema";

type Reader = Pick<Executor, "execute">;
type Category = CopyOptionsQuery["category"];
export class InvalidCopySelection extends Error {}

/** Identities can exist through history without a stored profile. */
export function copyEntityIds(workspace: string, environment: string): SQL {
  const scope = sql`workspace_id = ${workspace} AND environment_id = ${environment}`;
  return sql`SELECT type, external_id AS id FROM objects WHERE ${scope}
    UNION SELECT entity_type, entity_id FROM event_entities WHERE ${scope}
    UNION SELECT entity_type, entity_id FROM labels WHERE ${scope}
    UNION SELECT subject_type, subject_id FROM decisions WHERE ${scope}`;
}

function copyFromOptions(workspace: string, environment: string, user: string, category: Category): SQL {
  const scope = sql`workspace_id = ${workspace} AND environment_id = ${environment}`;
  switch (category) {
    case "actions":
      return sql`SELECT DISTINCT ON (name) name AS id, COALESCE(display_name, name) AS label,
      name || ' · Version ' || version AS detail, NULL::text AS type, name AS sort FROM actions WHERE ${scope} ORDER BY name, version DESC`;
    case "dashboards":
      return sql`SELECT id, COALESCE(definition->>'name', id) AS label, COALESCE(definition->>'visibility', 'workspace') AS detail,
      NULL::text AS type, id AS sort FROM dashboards WHERE ${scope} AND (definition->>'visibility' IS DISTINCT FROM 'private' OR owner = ${user})`;
    case "queues":
      return sql`SELECT id, COALESCE(definition->>'name', id) AS label,
      COALESCE(definition->>'description', definition->>'visibility') AS detail,
      NULL::text AS type, id AS sort FROM queues WHERE ${scope} AND (definition->>'visibility' IS DISTINCT FROM 'private' OR owner = ${user})`;
    case "entity_types":
      return sql`WITH identities AS (${copyEntityIds(workspace, environment)}), counts AS (
        SELECT type, count(*)::int AS n FROM identities GROUP BY type
      ), all_types AS (SELECT type FROM counts UNION SELECT type FROM entities WHERE ${scope})
      SELECT t.type AS id, t.type AS label, COALESCE(c.n, 0)::text || ' entities' AS detail, NULL::text AS type, t.type AS sort
      FROM all_types t LEFT JOIN counts c ON c.type = t.type`;
    case "entities":
      return sql`WITH identities AS (${copyEntityIds(workspace, environment)})
      SELECT i.id, COALESCE(o.properties->>'name', o.properties->>'display_name', i.id) AS label,
        i.type || ' · ' || i.id AS detail, i.type, i.type || '/' || i.id AS sort
      FROM identities i LEFT JOIN objects o ON o.workspace_id = ${workspace} AND o.environment_id = ${environment} AND o.type = i.type AND o.external_id = i.id`;
    case "event_types":
      return sql`SELECT type AS id, type AS label, count(*)::text || ' events' AS detail,
      NULL::text AS type, type AS sort FROM events WHERE ${scope} GROUP BY type`;
    case "events":
      return sql`SELECT external_id AS id, type AS label, external_id || ' · ' || ts::text AS detail, type, ts::text AS sort FROM events WHERE ${scope}`;
    case "decisions":
      return sql`SELECT id, action AS label, subject_type || '/' || subject_id || ' · ' || final_outcome || ' · ' || ts::text || ' · ' || id AS detail,
      NULL::text AS type, ts::text AS sort FROM decisions WHERE ${scope}`;
    case "models":
      return sql`SELECT slug AS id, name AS label, slug || ' · Version ' || version AS detail,
      NULL::text AS type, slug AS sort FROM models WHERE ${scope} AND status = 'active'`;
  }
}

export async function listCopyOptions(
  db: Reader,
  workspace: string,
  environment: string,
  user: string,
  query: CopyOptionsQuery,
) {
  const source = copyFromOptions(workspace, environment, user, query.category);
  const search = query.q.trim()
    ? sql`WHERE strpos(lower(label || ' ' || detail), lower(${query.q.trim()})) > 0`
    : sql``;
  const descending = query.category === "events" || query.category === "decisions";
  const result = await rows<{ id: string; label: string; detail: string; type: string | null; total: number }>(
    db,
    sql`WITH choices AS (${source}) SELECT id, label, detail, type, count(*) OVER()::int AS total FROM choices ${search}
      ORDER BY sort COLLATE "C" ${descending ? sql`DESC` : sql`ASC`}, id COLLATE "C" LIMIT ${query.limit} OFFSET ${query.offset}`,
  );
  const total =
    result[0]?.total ??
    (
      await rows<{ n: number }>(db, sql`WITH choices AS (${source}) SELECT count(*)::int AS n FROM choices ${search}`)
    )[0]!.n;
  return { items: result.map(({ total: _total, ...item }) => item), total };
}

/** Reject stale, foreign, or inaccessible selections instead of silently making a partial copy. */
export async function validateCopySelection(
  db: Reader,
  workspace: string,
  environment: string,
  user: string,
  copy: EnvironmentCopyOptions,
) {
  const check = async (category: Category, ids: string[] | undefined) => {
    if (!ids?.length) return;
    const unique = [...new Set(ids)];
    const found = await rows<{ n: number }>(
      db,
      sql`WITH choices AS (${copyFromOptions(workspace, environment, user, category)})
      SELECT count(*)::int AS n FROM choices WHERE id = ANY(${sql.param(unique)}::text[])`,
    );
    if (found[0]!.n !== unique.length)
      throw new InvalidCopySelection(
        `Some selected ${category.replaceAll("_", " ")} are no longer available in the source environment. Refresh the selection and try again.`,
      );
  };
  for (const category of ["actions", "dashboards", "queues", "decisions", "events", "models"] as const) {
    const selection = copy[category];
    if (typeof selection === "object") await check(category, selection.ids);
  }
  if (typeof copy.events === "object") await check("event_types", copy.events.types);
  if (typeof copy.entities === "object") {
    await check("entity_types", copy.entities.types);
    const selected = [
      ...new Map((copy.entities.records ?? []).map((r) => [JSON.stringify([r.type, r.id]), r])).values(),
    ];
    if (selected.length) {
      const found = await rows<{ n: number }>(
        db,
        sql`WITH choices AS (${copyEntityIds(workspace, environment)})
        SELECT count(*)::int AS n FROM choices c JOIN jsonb_to_recordset(${JSON.stringify(selected)}::jsonb) AS chosen(type text, id text) ON c.type = chosen.type AND c.id = chosen.id`,
      );
      if (found[0]!.n !== selected.length)
        throw new InvalidCopySelection(
          "Some selected entities are no longer available in the source environment. Refresh the selection and try again.",
        );
    }
  }
}

export const toEnvironment = (r: EnvironmentRow): Environment => ({
  id: r.id,
  workspace_id: r.workspaceId,
  name: r.name,
  kind: r.kind,
  created: iso(r.created),
});

const idsMatch = (choice: boolean | { ids?: string[] } | undefined, column: SQL): SQL =>
  choice === true
    ? sql`TRUE`
    : typeof choice === "object" && choice.ids?.length
      ? sql`${column} = ANY(${sql.param(choice.ids)}::text[])`
      : sql`FALSE`;
const chosen = (choice: boolean | { ids?: string[] } | undefined) =>
  choice === true ? {} : typeof choice === "object" && choice.ids?.length ? { id: { in: choice.ids } } : null;
const entityMatch = (choice: EnvironmentCopyOptions["entities"], type: SQL, id: SQL): SQL =>
  choice === true
    ? sql`TRUE`
    : typeof choice === "object"
      ? sql`(${type} = ANY(${sql.param(choice.types ?? [])}::text[]) OR EXISTS (
      SELECT 1 FROM jsonb_to_recordset(${JSON.stringify(choice.records ?? [])}::jsonb) AS chosen(type text, id text) WHERE chosen.type = ${type} AND chosen.id = ${id}))`
      : sql`FALSE`;

export function environmentsRepository(db: Executor) {
  return {
    copyOptions: (workspaceId: string, environmentId: string, userId: string, query: CopyOptionsQuery) =>
      listCopyOptions(db, workspaceId, environmentId, userId, query),
    async createSandbox(
      workspaceId: string,
      input: { name: string; copy_from?: string; copy?: EnvironmentCopyOptions; copy_dashboards?: boolean },
      userId: string,
      now: Date,
    ): Promise<Environment | null> {
      return db.transaction(
        async (tx) => {
          if (input.copy_from) {
            const [source] = await tx
              .select()
              .from(environments)
              .where(and(eq(environments.workspaceId, workspaceId), eq(environments.id, input.copy_from)))
              .for("share");
            if (!source) return null;
          }
          const created = await new EnvironmentsService(tx, { workspaceId }).create(
            { name: input.name.trim(), kind: "sandbox" },
            now,
          );
          if (input.copy_from) {
            const source = input.copy_from;
            const target = created.id;
            const [inSource, inTarget] = [
              { workspaceId, environmentId: source },
              { workspaceId, environmentId: target },
            ];
            const copy = input.copy ?? { actions: true, dashboards: input.copy_dashboards };
            await validateCopySelection(tx, workspaceId, source, userId, copy);
            const history =
              copy.decisions === true || (typeof copy.decisions === "object" && !!copy.decisions.ids?.length);
            // A copy is a new row in another environment, so it gets a new id; the customer's ids stay. kairos_id makes
            // them inside Postgres, from the row's own time. The links of the copy point to the copied events.
            if (copy.events || history) {
              const eventTypes = typeof copy.events === "object" ? (copy.events.types ?? []) : [];
              // Usage counts events by `created`: a copy must not count as new events.
              await tx.execute(sql`INSERT INTO events (id, workspace_id, environment_id, external_id, type, ts, entities, properties, universal_id, status, session_id, via, metadata, created)
              SELECT kairos_id('evt', created), workspace_id, ${target}, external_id, type, ts, entities, properties, universal_id, status, session_id, via, metadata, created FROM events
              WHERE workspace_id = ${workspaceId} AND environment_id = ${source} AND (
                ${idsMatch(copy.events, sql`events.external_id`)} OR type = ANY(${sql.param(eventTypes)}::text[])
                OR ${history ? sql`EXISTS (SELECT 1 FROM decisions d WHERE d.workspace_id = ${workspaceId} AND d.environment_id = ${source} AND ${idsMatch(copy.decisions, sql`d.id`)} AND d.event_id = events.id)` : sql`FALSE`}
              )`);
              await tx.execute(sql`INSERT INTO event_entities (workspace_id, environment_id, entity_type, entity_id, ts, event_id, created)
              SELECT x.workspace_id, ${target}, x.entity_type, x.entity_id, x.ts, copied.id, x.created
                FROM event_entities x JOIN events e ON e.id = x.event_id
                JOIN events copied ON copied.workspace_id = ${workspaceId} AND copied.environment_id = ${target} AND copied.external_id = e.external_id
               WHERE x.workspace_id = ${workspaceId} AND x.environment_id = ${source}`);
            }
            if (history) {
              // Copied history keeps its times: a copy is the same fact, not a new one.
              await tx.execute(sql`INSERT INTO decisions (id, workspace_id, environment_id, ts, action, subject_type, subject_id, decision, context, raw, event_id, session_id, request, revision, resolution, automatic, metadata, created, updated)
              SELECT kairos_id('kdec', d.created), d.workspace_id, ${target}, d.ts, d.action, d.subject_type, d.subject_id, d.decision, d.context, d.raw, copied.id, d.session_id, d.request, d.revision, d.resolution, d.automatic, d.metadata, d.created, d.updated
                FROM decisions d LEFT JOIN events e ON e.id = d.event_id
                LEFT JOIN events copied ON copied.workspace_id = ${workspaceId} AND copied.environment_id = ${target} AND copied.external_id = e.external_id
               WHERE d.workspace_id = ${workspaceId} AND d.environment_id = ${source} AND ${idsMatch(copy.decisions, sql`d.id`)}`);
            }
            if (copy.actions || history) {
              // The live row comes from `actions`; the versions come from
              // `definition_versions`. An action the user selected keeps all its
              // versions with history, or starts from its latest at version 1. An
              // action that only copied decisions refer to keeps only the versions
              // those decisions used, and its live row is the newest of them.
              const referenced = new Map<string, Set<number>>();
              if (history) {
                const refs = await rows<{ action: string }>(
                  tx,
                  sql`SELECT DISTINCT action FROM decisions WHERE workspace_id = ${workspaceId} AND environment_id = ${target}`,
                );
                for (const { action: ref } of refs) {
                  const pinned = /^(.*)@(\d+)$/.exec(ref);
                  const name = pinned ? pinned[1]! : ref;
                  const versions = referenced.get(name) ?? new Set<number>();
                  if (pinned) versions.add(Number(pinned[2]));
                  referenced.set(name, versions);
                }
              }
              const selected = (name: string) =>
                copy.actions === true || (typeof copy.actions === "object" && !!copy.actions?.ids?.includes(name));
              const definitions = await rows<{
                name: string;
                version: number;
                definition: Omit<ActionDefinition, "version" | "displayName" | "automatic" | "automaticSince">;
                display_name: string | null;
                created: Date | string;
                updated: Date | string;
              }>(
                tx,
                sql`SELECT name, version, definition, display_name, created, updated FROM actions a
                  WHERE workspace_id = ${workspaceId} AND environment_id = ${source} AND (
                    ${idsMatch(copy.actions, sql`a.name`)} OR EXISTS (SELECT 1 FROM decisions d WHERE d.workspace_id = ${workspaceId} AND d.environment_id = ${target}
                      AND (d.action = a.name OR LEFT(d.action, LENGTH(a.name) + 1) = a.name || '@'))
                  ) ORDER BY name`,
              );
              for (const action of definitions) {
                const isSelected = selected(action.name);
                if (!isSelected && !referenced.has(action.name)) continue;
                // A copy does not decide on its own: the automatic switch starts off.
                let live = { version: history ? action.version : 1, definition: action.definition };
                if (history && !isSelected) {
                  const wanted = referenced.get(action.name)!;
                  // A bare action name in a decision refers to the live version.
                  if (!wanted.size) wanted.add(action.version);
                  await tx.execute(sql`INSERT INTO definition_versions (id, workspace_id, environment_id, kind, name, version, definition, created, created_by)
                    SELECT kairos_id('def', created), workspace_id, ${target}, kind, name, version, definition, created, created_by FROM definition_versions
                    WHERE workspace_id = ${workspaceId} AND environment_id = ${source} AND kind = 'action' AND name = ${action.name} AND version = ANY(${sql.param([...wanted])}::int[])`);
                  const newest = Math.max(...wanted);
                  if (newest !== action.version) {
                    const [row] = await rows<{ definition: typeof action.definition }>(
                      tx,
                      sql`SELECT definition FROM definition_versions WHERE workspace_id = ${workspaceId} AND environment_id = ${source} AND kind = 'action' AND name = ${action.name} AND version = ${newest}`,
                    );
                    if (row) live = { version: newest, definition: row.definition };
                  } else {
                    live = { version: newest, definition: action.definition };
                  }
                }
                await tx.insert(actions).values({
                  id: newId("act"),
                  workspaceId,
                  environmentId: target,
                  name: action.name,
                  version: live.version,
                  definition: live.definition,
                  displayName: action.display_name,
                  automatic: false,
                  automaticSince: null,
                  created: history ? new Date(action.created) : now,
                  updated: history ? new Date(action.updated) : now,
                });
                if (history && isSelected) {
                  await tx.execute(sql`INSERT INTO definition_versions (id, workspace_id, environment_id, kind, name, version, definition, created, created_by)
                    SELECT kairos_id('def', created), workspace_id, ${target}, kind, name, version, definition, created, created_by FROM definition_versions
                    WHERE workspace_id = ${workspaceId} AND environment_id = ${source} AND kind = 'action' AND name = ${action.name}`);
                } else if (!history) {
                  await tx.execute(sql`INSERT INTO definition_versions (id, workspace_id, environment_id, kind, name, version, definition, created, created_by)
                    VALUES (${newId("def")}, ${workspaceId}, ${target}, 'action', ${action.name}, 1, ${JSON.stringify(action.definition)}::json, ${now}, NULL)`);
                }
              }
            }
            if (copy.entities || input.copy === undefined) {
              const selectedTypes =
                typeof copy.entities === "object"
                  ? [...new Set([...(copy.entities.types ?? []), ...(copy.entities.records ?? []).map((r) => r.type)])]
                  : undefined;
              const types = await new EntitiesService(tx, inSource).findMany({
                where: selectedTypes ? { type: { in: selectedTypes } } : {},
                columns: { type: true, definition: true },
              });
              await new EntitiesService(tx, inTarget).createMany(types, now);
            }
            // Copy large datasets inside Postgres, without loading them into application memory
            // or going through ingestion (which would execute actions and send webhooks).
            if (copy.entities) {
              await tx.execute(sql`INSERT INTO objects (id, workspace_id, environment_id, type, external_id, properties, set_at, first_seen, metadata, created, updated)
              SELECT kairos_id('obj', created), workspace_id, ${target}, type, external_id, properties, set_at, first_seen, metadata, created, updated FROM objects
              WHERE workspace_id = ${workspaceId} AND environment_id = ${source} AND ${entityMatch(copy.entities, sql`objects.type`, sql`objects.external_id`)}`);
              await tx.execute(sql`INSERT INTO labels (id, workspace_id, environment_id, entity_type, entity_id, label, ts, properties, metadata, created, updated)
              SELECT kairos_id('lbl', created), workspace_id, ${target}, entity_type, entity_id, label, ts, properties, metadata, created, updated FROM labels
              WHERE workspace_id = ${workspaceId} AND environment_id = ${source} AND ${entityMatch(copy.entities, sql`labels.entity_type`, sql`labels.entity_id`)}`);
              // Entities discovered through events may have no stored profile. Retain their
              // identity even when the user chooses Entities without Events.
              await tx.execute(sql`INSERT INTO objects (id, workspace_id, environment_id, type, external_id, properties, first_seen, metadata, created, updated)
              SELECT kairos_id('obj', ${now}), ${workspaceId}, ${target}, type, id, '{}'::json, min(ts), '{}'::jsonb, ${now}, max(ts) FROM (
                SELECT entity_type AS type, entity_id AS id, ts FROM event_entities WHERE workspace_id = ${workspaceId} AND environment_id = ${source}
                UNION ALL SELECT entity_type, entity_id, ts FROM labels WHERE workspace_id = ${workspaceId} AND environment_id = ${source}
                UNION ALL SELECT subject_type, subject_id, ts FROM decisions WHERE workspace_id = ${workspaceId} AND environment_id = ${source}
              ) refs WHERE ${entityMatch(copy.entities, sql`refs.type`, sql`refs.id`)} GROUP BY type, id ON CONFLICT (workspace_id, environment_id, type, external_id) DO NOTHING`);
            }
            if (copy.dashboards) {
              const which = chosen(copy.dashboards);
              const boards = which
                ? await new DashboardsService(tx, inSource).findMany({
                    where: which,
                    columns: { definition: true, owner: true },
                  })
                : [];
              await new DashboardsService(tx, inTarget).createMany(
                boards.filter((r) => r.definition.visibility !== "private" || r.owner === userId),
                now,
              );
            }
            // A queue's setup, not its cases: those belong to the decisions of the source.
            if (copy.queues) {
              const which = chosen(copy.queues);
              const found = which
                ? await new QueuesService(tx, inSource).findMany({
                    where: which,
                    columns: { definition: true, owner: true, version: true },
                  })
                : [];
              await new QueuesService(tx, inTarget).createMany(
                found.filter((r) => r.definition.visibility !== "private" || r.owner === userId),
                now,
              );
            }
            if (copy.models) {
              const sourceModels = sql`SELECT slug FROM models WHERE workspace_id = ${workspaceId} AND environment_id = ${source}
                AND status = 'active' AND ${idsMatch(copy.models, sql`slug`)}`;
              await tx.execute(sql`INSERT INTO models (id, workspace_id, environment_id, slug, name, kind, version, definition, status, created, updated)
              SELECT kairos_id('mdl', ${now}), workspace_id, ${target}, slug, name, kind, version, definition, status, ${now}, ${now} FROM models
              WHERE workspace_id = ${workspaceId} AND environment_id = ${source} AND slug IN (${sourceModels})`);
              // Every version keeps its number: a step's `slug@2` must find the same file in the copy.
              await tx.execute(sql`INSERT INTO definition_versions (id, workspace_id, environment_id, kind, name, version, definition, created, created_by)
              SELECT kairos_id('def', created), workspace_id, ${target}, kind, name, version, definition, created, created_by FROM definition_versions
              WHERE workspace_id = ${workspaceId} AND environment_id = ${source} AND kind = 'model' AND name IN (${sourceModels})`);
              await tx.execute(sql`INSERT INTO model_artifacts (id, workspace_id, environment_id, sha256, format, file, size, stored_size, samples, sample_count, created)
              SELECT kairos_id('art', created), workspace_id, ${target}, sha256, format, file, size, stored_size, samples, sample_count, created FROM model_artifacts
              WHERE workspace_id = ${workspaceId} AND environment_id = ${source} AND sha256 IN (
                SELECT replace(definition->>'artifact', 'sha256:', '') FROM definition_versions
                WHERE workspace_id = ${workspaceId} AND environment_id = ${target} AND kind = 'model')`);
            }
          }
          return toEnvironment(created!);
        },
        { isolationLevel: "repeatable read" },
      );
    },
  };
}

export type EnvironmentsRepository = ReturnType<typeof environmentsRepository>;
