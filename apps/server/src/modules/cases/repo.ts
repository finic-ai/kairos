import type { CasePriority, CaseStatus, Outcome, QueueSort } from "@kairos/core";
import { asc, sql, type SQL } from "drizzle-orm";
import {
  caseItems,
  queues,
  type CaseItemKind,
  type CaseResolution,
  type QueueRow,
  type Resolution,
} from "../../db/schema";
import { newId } from "../../platform/crypto";
import type { Executor } from "../../platform/database";
import { containing, first, iso, list, lock, rows } from "../../platform/sql";
import type { StoredEvent } from "../ingest/types";
import type { CaseFilter, CaseSummary } from "./types";

type Scope = { workspaceId: string; environmentId: string };
const inScope = (scope: Scope, alias?: string) => {
  const of = sql.raw(alias ? `${alias}.` : "");
  return sql`${of}workspace_id = ${scope.workspaceId} AND ${of}environment_id = ${scope.environmentId}`;
};

/** Hold a lock on a name until the transaction ends: a read and the write after it are one step. */
export const lockName = lock;

/** The enabled queues of the scope that take decisions of `action`, its name without a version. */
const takes = (scope: Scope, action: string) =>
  sql`${inScope(scope)}
      AND COALESCE((definition ->> 'enabled')::boolean, true)
      AND definition -> 'sources' -> 'actions' @> jsonb_build_array(${action}::text)`;

export function queuesForAction(db: Executor, scope: Scope, action: string): Promise<QueueRow[]> {
  return db.select().from(queues).where(takes(scope, action)).orderBy(asc(queues.created), asc(queues.seq));
}

/** Whether an enabled queue with at least one rule takes decisions of `action`. Asked on every decision, so cheap. */
export async function hasIntakeFor(db: Executor, scope: Scope, action: string): Promise<boolean> {
  return Boolean(
    await first(
      db,
      sql`SELECT 1 FROM queues
           WHERE ${takes(scope, action)} AND jsonb_array_length(COALESCE(definition -> 'intake', '[]'::jsonb)) > 0
           LIMIT 1`,
    ),
  );
}

/** A decision of the case that no one resolved and that is not an approval: work the case's resolution left. */
const hasOpenDecision = sql`EXISTS (
  SELECT 1 FROM case_items i JOIN decisions d ON d.id = i.ref_id
   WHERE i.case_id = c.id AND i.kind = 'decision' AND d.resolution IS NULL AND d.decision ->> 'decision' <> 'approve')`;

export interface QueueCounts {
  open: number;
  in_review: number;
  unassigned: number;
  overdue: number;
  open_decisions: number;
  /** Not resolved, and assigned to the person who asks. */
  mine: number;
}

export async function queueCounts(
  db: Executor,
  scope: Scope,
  now: Date,
  viewer: string | undefined,
): Promise<Map<string, QueueCounts>> {
  const found = await rows<QueueCounts & { queue_id: string }>(
    db,
    sql`SELECT c.queue_id,
               COUNT(*) FILTER (WHERE c.status = 'open')::int AS open,
               COUNT(*) FILTER (WHERE c.status = 'in_review')::int AS in_review,
               COUNT(*) FILTER (WHERE c.status <> 'resolved' AND c.assignee_id IS NULL)::int AS unassigned,
               COUNT(*) FILTER (WHERE c.status <> 'resolved' AND c.due_at < ${now})::int AS overdue,
               COUNT(*) FILTER (WHERE c.status = 'resolved' AND ${hasOpenDecision})::int AS open_decisions,
               COUNT(*) FILTER (WHERE c.status <> 'resolved' AND c.assignee_id = ${viewer ?? null})::int AS mine
          FROM cases c WHERE ${inScope(scope, "c")} GROUP BY c.queue_id`,
  );
  return new Map(found.map(({ queue_id, ...counts }) => [queue_id, counts]));
}

type CaseRowSql = {
  id: string;
  queue_id: string;
  status: CaseStatus;
  priority: CasePriority;
  assignee_id: string | null;
  assignee_email: string | null;
  assignee_name: string | null;
  target_type: string;
  target_id: string;
  correlation_key: string | null;
  reason: string;
  worst_outcome: Outcome | null;
  max_risk: number | null;
  evidence_count: number;
  last_evidence_at: Date;
  last_activity: Date;
  resolution: CaseResolution | null;
  due_at: Date | null;
  created: Date;
};

const CASE_COLUMNS = sql`c.id, c.queue_id, c.status, c.priority, c.assignee_id, u.email AS assignee_email,
  COALESCE(NULLIF(u.display_name, ''), NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''), split_part(u.email, '@', 1)) AS assignee_name,
  c.target_type, c.target_id, c.correlation_key, c.reason, c.worst_outcome, c.max_risk, c.evidence_count,
  c.last_evidence_at, c.last_activity, c.resolution, c.due_at, c.created`;

const toSummary = (r: CaseRowSql): CaseSummary => ({
  id: r.id,
  queue_id: r.queue_id,
  status: r.status,
  priority: r.priority,
  assignee: r.assignee_id ? { id: r.assignee_id, email: r.assignee_email ?? "", name: r.assignee_name ?? "" } : null,
  target: { type: r.target_type, id: r.target_id },
  correlation_key: r.correlation_key,
  reason: r.reason,
  outcome: r.worst_outcome,
  risk: r.max_risk,
  evidence_count: r.evidence_count,
  last_evidence_at: iso(r.last_evidence_at),
  last_activity: iso(r.last_activity),
  resolution: r.resolution,
  due_at: iso(r.due_at),
  created: iso(r.created),
});

const ORDER: Record<QueueSort, SQL> = {
  oldest: sql`c.created ASC, c.id COLLATE "C" ASC`,
  newest: sql`c.created DESC, c.id COLLATE "C" DESC`,
  priority: sql`array_position(ARRAY['urgent','high','normal','low'], c.priority), c.created ASC, c.id COLLATE "C" ASC`,
  risk: sql`c.max_risk DESC NULLS LAST, c.created ASC, c.id COLLATE "C" ASC`,
  due: sql`c.due_at ASC NULLS LAST, c.created ASC, c.id COLLATE "C" ASC`,
};

/** The filters of a queue's list, and those a workflow's search adds. */
export interface CaseSearch extends Omit<CaseFilter, "limit" | "offset"> {
  queueId?: string;
  target?: { type: string; id: string };
  /** The cases that hold this entity: "which cases is this device in?" */
  item?: { type: string; id: string };
  createdAfter?: Date;
}

function caseWhere(scope: Scope, f: CaseSearch): SQL {
  const where: SQL[] = [inScope(scope, "c")];
  if (f.queueId) where.push(sql`c.queue_id = ${f.queueId}`);
  if (f.status === "unresolved") where.push(sql`c.status <> 'resolved'`);
  else if (f.status === "open_decisions") where.push(sql`c.status = 'resolved' AND ${hasOpenDecision}`);
  else if (f.status) where.push(sql`c.status = ${f.status}`);
  if (f.overdueAt) where.push(sql`c.status <> 'resolved' AND c.due_at < ${f.overdueAt}`);
  if (f.priority) where.push(sql`c.priority = ${f.priority}`);
  if (f.assignee === "none") where.push(sql`c.assignee_id IS NULL`);
  else if (f.assignee) where.push(sql`c.assignee_id = ${f.assignee}`);
  if (f.q) where.push(sql`(c.target_id ILIKE ${containing(f.q)} OR c.id = ${f.q})`);
  if (f.target) where.push(sql`c.target_type = ${f.target.type} AND c.target_id = ${f.target.id}`);
  if (f.item)
    where.push(
      sql`EXISTS (SELECT 1 FROM case_items i WHERE i.case_id = c.id AND i.kind = 'entity' AND i.ref_type = ${f.item.type} AND i.ref_id = ${f.item.id})`,
    );
  if (f.createdAfter) where.push(sql`c.created > ${f.createdAfter}`);
  return sql.join(where, sql` AND `);
}

const selectCases = (where: SQL, order: SQL, limit: number, offset = 0) =>
  sql`SELECT ${CASE_COLUMNS} FROM cases c LEFT JOIN users u ON u.id = c.assignee_id
       WHERE ${where} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`;

export async function listCases(
  db: Executor,
  scope: Scope,
  queueId: string,
  filter: CaseFilter,
  sort: QueueSort,
): Promise<{ cases: CaseSummary[]; total: number }> {
  const where = caseWhere(scope, { ...filter, queueId });
  const [found, total] = await Promise.all([
    rows<CaseRowSql>(db, selectCases(where, ORDER[sort], filter.limit, filter.offset)),
    first<{ n: number }>(db, sql`SELECT COUNT(*)::int AS n FROM cases c WHERE ${where}`),
  ]);
  return { cases: found.map(toSummary), total: total!.n };
}

/** Cases across the queues of an environment, newest first: for a workflow's search. */
export async function searchCases(
  db: Executor,
  scope: Scope,
  filter: CaseSearch & { limit: number },
): Promise<CaseSummary[]> {
  return (await rows<CaseRowSql>(db, selectCases(caseWhere(scope, filter), ORDER.newest, filter.limit))).map(toSummary);
}

export async function findCaseSummary(db: Executor, scope: Scope, id: string): Promise<CaseSummary | null> {
  const found = await first<CaseRowSql>(
    db,
    sql`SELECT ${CASE_COLUMNS} FROM cases c LEFT JOIN users u ON u.id = c.assignee_id
         WHERE ${inScope(scope, "c")} AND c.id = ${id}`,
  );
  return found ? toSummary(found) : null;
}

/** For the queue's `request.` and `subject.` columns: the request of each case's first decision, and its target's properties. */
export async function caseValues(
  db: Executor,
  scope: Scope,
  ids: string[],
): Promise<Map<string, { request: Record<string, unknown>; subject: Record<string, unknown> }>> {
  if (ids.length === 0) return new Map();
  const found = await rows<{
    id: string;
    request: Record<string, unknown> | null;
    subject: Record<string, unknown> | null;
  }>(
    db,
    sql`SELECT c.id,
               (SELECT (d.request -> 'properties')::jsonb FROM case_evidence ev JOIN decisions d ON d.id = ev.source_id
                 WHERE ev.case_id = c.id AND ev.source_type = 'decision' ORDER BY ev.ts, ev.created LIMIT 1) AS request,
               (SELECT o.properties::jsonb FROM objects o
                 WHERE o.workspace_id = c.workspace_id AND o.environment_id = c.environment_id
                   AND o.type = c.target_type AND o.external_id = c.target_id) AS subject
          FROM cases c WHERE ${inScope(scope, "c")} AND c.id IN (${list(ids)})`,
  );
  return new Map(found.map((r) => [r.id, { request: r.request ?? {}, subject: r.subject ?? {} }]));
}

/** The stored properties of some entities. An entity with none has no row. */
export async function propertiesOf(
  db: Executor,
  scope: Scope,
  refs: { type: string; id: string }[],
): Promise<{ type: string; id: string; properties: Record<string, unknown> }[]> {
  if (refs.length === 0) return [];
  const pairs = sql.join(
    refs.map((r) => sql`(${r.type}, ${r.id})`),
    sql`, `,
  );
  return rows(
    db,
    sql`SELECT type, external_id AS id, properties FROM objects
         WHERE ${inScope(scope)} AND (type, external_id) IN (${pairs})`,
  );
}

/** Write the items a trigger named. One already in the case is left as it is. */
export async function addItems(
  db: Executor,
  scope: Scope,
  caseId: string,
  evidenceId: string,
  items: { kind: CaseItemKind; type?: string | null; id: string }[],
  now: Date,
): Promise<void> {
  if (items.length === 0) return;
  await db
    .insert(caseItems)
    .values(
      items.map((item) => ({
        id: newId("cit"),
        workspaceId: scope.workspaceId,
        environmentId: scope.environmentId,
        caseId,
        kind: item.kind,
        refType: item.type ?? null,
        refId: item.id,
        evidenceId,
        created: now,
      })),
    )
    .onConflictDoNothing();
}

export interface CaseDecisionRow {
  id: string;
  ts: string;
  action: string;
  subject: { type: string; id: string };
  decision: { decision: Outcome; risk_score: number; reasons: string[]; typology?: string };
  event_id: string | null;
  session: string | null;
  resolution: Resolution | null;
  final_outcome: string;
}

/** Decisions by Kairos id, with the customer's id of the event that started each. */
export async function decisionsByIds(db: Executor, scope: Scope, ids: string[]): Promise<CaseDecisionRow[]> {
  if (ids.length === 0) return [];
  return decisionRows(db, sql`${inScope(scope, "d")} AND d.id IN (${list(ids)})`);
}

/** The decisions that the events with these customer ids started. */
export async function decisionsForEvents(db: Executor, scope: Scope, eventIds: string[]): Promise<CaseDecisionRow[]> {
  if (eventIds.length === 0) return [];
  return decisionRows(db, sql`${inScope(scope, "d")} AND e.external_id IN (${list(eventIds)})`);
}

async function decisionRows(db: Executor, where: SQL): Promise<CaseDecisionRow[]> {
  const found = await rows<{
    id: string;
    ts: Date;
    action: string;
    subject_type: string;
    subject_id: string;
    decision: CaseDecisionRow["decision"];
    event_id: string | null;
    session_id: string | null;
    resolution: Resolution | null;
    final_outcome: string;
  }>(
    db,
    sql`SELECT d.id, d.ts, d.action, d.subject_type, d.subject_id, d.decision, e.external_id AS event_id, d.session_id,
               d.resolution, d.final_outcome
          FROM decisions d LEFT JOIN events e ON e.id = d.event_id
         WHERE ${where} ORDER BY d.ts, d.id COLLATE "C" LIMIT 500`,
  );
  return found.map((r) => ({
    id: r.id,
    ts: iso(r.ts),
    action: r.action,
    subject: { type: r.subject_type, id: r.subject_id },
    decision: r.decision,
    event_id: r.event_id,
    session: r.session_id,
    resolution: r.resolution,
    final_outcome: r.final_outcome,
  }));
}

/** Events by the customer's ids, oldest first. */
export async function eventsByIds(db: Executor, scope: Scope, ids: string[]): Promise<StoredEvent[]> {
  if (ids.length === 0) return [];
  const found = await rows<{
    id: string;
    type: string;
    ts: Date;
    entities: Record<string, string>;
    properties: Record<string, unknown>;
    universal_id: string | null;
    status: string | null;
    session_id: string | null;
  }>(
    db,
    sql`SELECT external_id AS id, type, ts, entities, properties, universal_id, status, session_id FROM events
         WHERE ${inScope(scope)} AND external_id IN (${list(ids)}) ORDER BY ts, external_id COLLATE "C"`,
  );
  return found.map((r) => ({
    id: r.id,
    type: r.type,
    ts: iso(r.ts),
    entities: r.entities,
    properties: r.properties,
    ...(r.universal_id ? { universal_id: r.universal_id } : {}),
    ...(r.status ? { status: r.status } : {}),
    ...(r.session_id ? { session: r.session_id } : {}),
  }));
}

export interface TestDecisionRow {
  id: string;
  ts: Date;
  action: string;
  subject_type: string;
  subject_id: string;
  decision: { decision: Outcome; risk_score: number; reasons: string[]; typology?: string };
  probabilities: Record<string, number> | null;
  request: { entities: Record<string, string>; properties: Record<string, unknown> } | null;
  event_id: string | null;
  event_type: string | null;
  event_properties: Record<string, unknown> | null;
  event_entities: Record<string, string> | null;
  session_id: string | null;
}

/** The latest decisions of some actions in a period, with what an intake rule reads: for the queue test. */
export function decisionsForTest(
  db: Executor,
  scope: Scope,
  actions: string[],
  since: Date,
  limit: number,
): Promise<TestDecisionRow[]> {
  if (actions.length === 0) return Promise.resolve([]);
  const named = sql.join(
    actions.map((a) => sql`(d.action = ${a} OR starts_with(d.action, ${`${a}@`}))`),
    sql` OR `,
  );
  return rows<TestDecisionRow>(
    db,
    sql`SELECT d.id, d.ts, d.action, d.subject_type, d.subject_id, d.decision,
               (d.raw::jsonb -> 'answers' -> 'reasons' -> 'probabilities') AS probabilities,
               d.request, e.external_id AS event_id, e.type AS event_type, e.properties AS event_properties,
               e.entities AS event_entities, d.session_id
          FROM decisions d LEFT JOIN events e ON e.id = d.event_id
         WHERE ${inScope(scope, "d")} AND d.ts >= ${since} AND (${named})
         ORDER BY d.ts DESC, d.id COLLATE "C" DESC LIMIT ${limit}`,
  );
}
