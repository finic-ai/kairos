import {
  ALL_TIME,
  asColumn,
  columnTitle,
  displayName,
  displayOf,
  parseWindow,
  timesUsual,
  validateEntity,
  type EntityDefinition,
  type EntityFact,
  type EntityList,
} from "@kairos/core";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Executor } from "../../platform/database";
import type { Repositories } from "../../repositories";
import { DecisionsService } from "../../services/decision.service";
import { EntitiesService } from "../../services/entities.service";
import { LabelsService } from "../../services/label.service";
import { ObjectsService } from "../../services/object.service";
import { QueuesService, canSee, type Viewer } from "../../services/queue.service";
import { labelCreated } from "../webhooks/types";
import { startRecordRuns } from "../workflows/service";
import type { EntityRef, FactValue, HistoryRow, ListPage, RowLink, StoredLabel, StoredObject } from "../../types";

/** A label dated further back than this is history being imported: it sends no webhook. */
const LABEL_NOTIFY_MS = 86_400_000;
const LABEL_LOOKBACK_MS = 90 * 86_400_000;
const LABEL_RECENT = 10;

/**
 * Set properties on an entity from an event that happened at `ts`. `set` replaces a value
 * unless a later event set it already; `setOnce` fills a property only if it has no value;
 * `unset` removes one, unless a later event set it. Events can arrive in any order, and the
 * newest fact still wins.
 */
export async function setProperties(
  db: Executor,
  workspaceId: string,
  environmentId: string,
  entity: EntityRef,
  changes: { set?: Record<string, unknown>; setOnce?: Record<string, unknown>; unset?: string[] },
  ts: string,
  now: string,
  /** The workflow run that makes the change, for the chain rules of record triggers. */
  madeBy?: string,
): Promise<StoredObject> {
  return db.transaction(async (tx) => {
    const stored = new ObjectsService(tx, { workspaceId, environmentId });
    // Two events about one entity can arrive together. Each must see what the other wrote.
    await stored.lockEntity(entity);
    const row = await stored.findFirst({ where: { type: entity.type, externalId: entity.id } });
    const properties: Record<string, unknown> = row ? { ...row.properties } : {};
    const setAt: Record<string, string> = row ? { ...row.setAt } : {};
    for (const [name, value] of Object.entries(changes.setOnce ?? {})) {
      if (name in properties) continue;
      properties[name] = value;
      setAt[name] = ts;
    }
    for (const [name, value] of Object.entries(changes.set ?? {})) {
      // A property with no recorded time was written before times were kept: anything replaces it.
      if (setAt[name] !== undefined && ts < setAt[name]) continue;
      properties[name] = value;
      setAt[name] = ts;
    }
    for (const name of changes.unset ?? []) {
      if (setAt[name] !== undefined && ts < setAt[name]) continue;
      delete properties[name];
      // The time stays, so that an older event that arrives later does not bring the value back.
      setAt[name] = ts;
    }
    // An entity that an old event describes existed at the time of that event.
    const was = row?.firstSeen ? row.firstSeen.toISOString() : null;
    const firstSeen = was ? (ts < was ? ts : was) : ts < now ? ts : now;
    const values = { properties, setAt, firstSeen: new Date(firstSeen) };
    await stored.upsert(
      { type: entity.type, externalId: entity.id, ...values },
      new Date(now),
      ["type", "externalId"],
      values,
    );
    const saved = { ...entity, properties, metadata: row?.metadata ?? {}, first_seen: firstSeen, updated: now };
    // A write that changes no property is no update: it starts no run.
    const before = row?.properties ?? {};
    if (!row || JSON.stringify(before) !== JSON.stringify(properties))
      await startRecordRuns(
        tx,
        { workspaceId, environmentId },
        {
          record: "entity",
          on: row ? "updated" : "created",
          key: `${entity.type}/${entity.id}@${now}`,
          input: { entity: saved, ...(row ? { before } : {}) },
          kind: entity.type,
          ts,
          ...(madeBy ? { madeBy } : {}),
        },
        new Date(now),
      );
    return saved;
  });
}

/** A direct write is a fact as of `now`: it replaces a value that a past event set. */
export const upsertObject = (
  db: Executor,
  workspaceId: string,
  environmentId: string,
  entity: EntityRef,
  properties: Record<string, unknown>,
  now: string,
  unset: string[] = [],
  madeBy?: string,
) => setProperties(db, workspaceId, environmentId, entity, { set: properties, unset }, now, now, madeBy);

/**
 * Add a label to an entity. With `notify`, a label that is new and recent sends label.created to
 * the webhooks that want it, in the same transaction. Returns how many deliveries were queued.
 */
export async function addLabel(
  { transaction }: Pick<Repositories, "transaction">,
  workspaceId: string,
  environmentId: string,
  entity: EntityRef,
  label: StoredLabel,
  now: Date,
  notify: boolean,
): Promise<number> {
  return transaction(async (tx) => {
    const scope = { workspaceId, environmentId };
    const inserted = await new LabelsService(tx.db, scope).save(entity, label, now);
    if (inserted) {
      const madeBy = label.metadata?.workflow_run_id;
      await startRecordRuns(
        tx.db,
        scope,
        {
          record: "entity",
          on: "labelled",
          key: `${entity.type}/${entity.id}:${label.label}@${label.ts}`,
          input: { entity, label: { label: label.label, ts: label.ts, properties: label.properties ?? {} } },
          kind: entity.type,
          label: label.label,
          ts: label.ts,
          ...(typeof madeBy === "string" ? { madeBy } : {}),
        },
        now,
      );
    }
    const ts = new Date(label.ts);
    if (!notify || !inserted || ts.getTime() < now.getTime() - LABEL_NOTIFY_MS) return 0;
    const recent = await new DecisionsService(tx.db, scope).listAbout(
      entity,
      new Date(ts.getTime() - LABEL_LOOKBACK_MS),
      ts,
      LABEL_RECENT,
    );
    const event = labelCreated(
      entity,
      label,
      recent.map((r) => ({
        decision_id: r.id,
        action: r.action,
        decision: r.outcome,
        final_outcome: r.final_outcome,
        decided_at: r.ts,
      })),
    );
    return tx.outbox.enqueue(workspaceId, environmentId, event, now);
  });
}

type Scope = { workspaceId: string; environmentId: string };
const CURRENCY = /^[A-Z]{3}$/;
const round = (n: number) => Math.round(n * 100) / 100;
const isoAt = (ms: number) => new Date(ms).toISOString();

const visibleQueues = async (db: Executor, scope: Scope, viewer: Viewer) =>
  (await new QueuesService(db, scope).list()).filter((q) => canSee(q, viewer));

export async function entityFacts(
  repos: Pick<Repositories, "db" | "entities">,
  scope: Scope,
  entity: EntityRef,
  facts: EntityFact[],
  viewer: Viewer,
  now: Date,
): Promise<FactValue[]> {
  const queues = facts.some((f) => f.source === "cases")
    ? (await visibleQueues(repos.db, scope, viewer)).map((q) => q.id)
    : [];
  const to = now.getTime();
  return Promise.all(
    facts.map(async (f) => {
      const window = parseWindow(f.window);
      const read = async (from: number | null, until: number) => {
        const v = await repos.entities.fact(scope.workspaceId, scope.environmentId, entity, {
          source: f.source,
          measure: f.measure,
          field: f.field,
          filters: f.filters,
          from: from === null ? null : isoAt(from),
          to: isoAt(until),
          queues,
        });
        return typeof v === "number" ? round(v) : v;
      };
      const value = await read(window === null ? null : to - window, to);
      const out: FactValue = {
        name: f.name,
        label: f.label,
        measure: f.measure,
        window: f.window ?? ALL_TIME,
        value,
        ...(f.format ? { format: f.format } : {}),
        ...(f.currency ? { currency: f.currency } : {}),
      };
      const usual = parseWindow(f.usual);
      if (usual !== null && window !== null) {
        const before = Number((await read(to - usual, to - window)) ?? 0);
        const times = timesUsual(Number(value ?? 0), before, window, usual);
        out.usual = round(before / ((usual - window) / window));
        out.times_usual = times === Infinity ? null : times;
      }
      return out;
    }),
  );
}

function cellOf(row: HistoryRow, field: string, queueNames: Map<string, string>, other: EntityDefinition | null) {
  const pick = (values: Record<string, unknown>) => (field in values ? values[field] : null);
  switch (row.source) {
    case "events":
      if (field.startsWith("event.")) return row.properties[field.slice(6)] ?? null;
      return pick({
        ts: row.ts,
        id: row.id,
        type: row.type,
        "decision.outcome": row.outcome,
        "decision.risk_score": row.risk,
      });
    case "decisions":
      if (field.startsWith("request.")) return row.properties[field.slice(8)] ?? null;
      return pick({
        ts: row.ts,
        id: row.id,
        action: row.action,
        "decision.outcome": row.outcome,
        "decision.risk_score": row.risk,
        final_outcome: row.final_outcome,
      });
    case "linked":
      if (field.startsWith("entity.")) return row.properties[field.slice(7)] ?? null;
      if (field === "name") return displayName(displayOf(row.type, other).fields, row.properties) ?? null;
      return pick({ id: row.id, first_seen: row.first_seen, last_seen: row.last_seen, events: row.events });
    case "cases":
      return pick({
        ts: row.ts,
        id: row.id,
        status: row.status,
        priority: row.priority,
        queue: queueNames.get(row.queue_id) ?? row.queue_id,
        assignee: row.assignee,
        resolution: row.resolution,
      });
  }
}

function linkOf(row: HistoryRow): RowLink {
  if (row.source === "events") return { kind: "event", id: row.id };
  if (row.source === "linked") return { kind: "entity", type: row.type, id: row.id };
  return { kind: row.source === "cases" ? "case" : "decision", id: row.id };
}

export async function entityList(
  repos: Pick<Repositories, "db" | "entities">,
  scope: Scope,
  entity: EntityRef,
  list: EntityList,
  page: { q?: string; limit: number; offset: number },
  viewer: Viewer,
  now: Date,
): Promise<ListPage> {
  const [queues, other] = await Promise.all([
    list.source === "cases" ? visibleQueues(repos.db, scope, viewer) : [],
    list.source === "linked" ? new EntitiesService(repos.db, scope).findByType(list.entity_type ?? "") : null,
  ]);
  const window = parseWindow(list.window);
  const { rows, total } = await repos.entities.history(scope.workspaceId, scope.environmentId, entity, {
    source: list.source,
    entityType: list.entity_type,
    filters: list.filters,
    from: window === null ? null : isoAt(now.getTime() - window),
    to: now.toISOString(),
    sort: list.sort ?? "newest",
    q: page.q,
    limit: page.limit,
    offset: page.offset,
    queues: queues.map((q) => q.id),
  });
  const queueNames = new Map(queues.map((q) => [q.id, q.definition.name]));
  const columns = list.columns.map(asColumn).map((c) => ({ ...c, label: columnTitle(c) }));
  const fields = new Set(
    columns.flatMap((c) => [c.field, ...(c.currency && !CURRENCY.test(c.currency) ? [c.currency] : [])]),
  );
  return {
    name: list.name,
    label: list.label,
    columns,
    total,
    rows: rows.map((row) => ({
      id: row.id,
      ts: row.source === "linked" ? row.last_seen : row.ts,
      link: linkOf(row),
      values: Object.fromEntries([...fields].map((field) => [field, cellOf(row, field, queueNames, other)])),
    })),
  };
}

export function loadEntityTemplates(dir: string): EntityDefinition[] {
  const folder = join(dir, "entities");
  try {
    return readdirSync(folder)
      .filter((file) => file.endsWith(".json"))
      .sort()
      .map((file) => JSON.parse(readFileSync(join(folder, file), "utf8")) as EntityDefinition)
      .filter((t) => validateEntity(t).length === 0);
  } catch {
    return [];
  }
}
