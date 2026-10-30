import { sql, type SQL } from "drizzle-orm";
import type { DecisionRow, Resolution } from "../db/schema";
import type { Executor } from "../platform/database";
import { DatabaseService } from "../platform/orm";
import { at, first, iso, rows } from "../platform/sql";
import type { DecisionFilter, DecisionRecord, DecisionSummary, EntityRef } from "../types";

/** A decision row, with its event: `event_id` holds the Kairos id, and the API shows the customer's. */
type WithEvent = DecisionRow & { event: { externalId: string } | null };
const withEventId = { with: { event: { columns: { externalId: true } } } } as const;

const toRecord = (r: WithEvent | null): DecisionRecord | null =>
  r
    ? {
        id: r.id,
        ts: iso(r.ts),
        action: r.action,
        subject: { type: r.subjectType, id: r.subjectId },
        decision: r.decision,
        context: r.context,
        raw: r.raw,
        ...(r.event ? { event_id: r.event.externalId } : {}),
        ...(r.sessionId ? { session: r.sessionId } : {}),
        ...(r.request ? { request: r.request } : {}),
        ...(r.automatic ? { automatic: true } : {}),
        ...(r.metadata && Object.keys(r.metadata).length ? { metadata: r.metadata } : {}),
        revision: r.revision,
        resolution: r.resolution ?? null,
        final_outcome: r.finalOutcome ?? undefined,
      }
    : null;

export class DecisionsService extends DatabaseService<"decisions"> {
  constructor(db: Executor, scope: { workspaceId: string; environmentId: string }) {
    super(db, "decisions", scope);
  }

  /** `eventId`: Kairos's id of the event that started the decision. The record has the customer's. */
  async createRecord(d: DecisionRecord, eventId: string | null, now: Date): Promise<void> {
    await this.create(
      {
        ts: new Date(d.ts),
        action: d.action,
        subjectType: d.subject.type,
        subjectId: d.subject.id,
        decision: d.decision,
        context: d.context,
        raw: d.raw,
        eventId,
        sessionId: d.session ?? null,
        request: d.request ?? null,
        automatic: d.automatic ?? false,
        metadata: d.metadata ?? {},
      },
      now,
      { id: d.id },
    );
  }

  async findRecord(id: string): Promise<DecisionRecord | null> {
    return toRecord(await this.findById(id, withEventId));
  }

  /** The decision a workflow step made, if it made one: a replayed step must not decide again. */
  async findByWorkflowStep(stepKey: string): Promise<DecisionRecord | null> {
    return toRecord(
      await this.findFirst({
        where: { RAW: (t) => sql`${t.metadata} ->> 'workflow_step_key' = ${stepKey}` },
        ...withEventId,
      }),
    );
  }

  /** The decision an event started, if it started one: sending the event again must not decide again. */
  async findByEvent(eventId: string): Promise<DecisionRecord | null> {
    return toRecord(
      await this.findFirst({ where: { event: { externalId: eventId } }, orderBy: { ts: "desc" }, ...withEventId }),
    );
  }

  async listSummaries(filter: DecisionFilter): Promise<DecisionSummary[]> {
    const found = await rows<{
      id: string;
      ts: Date;
      action: string;
      subject_type: string;
      subject_id: string;
      decision: unknown;
      session_id: string | null;
      revision: number;
      resolution: Resolution | null;
      final_outcome: string;
      automatic: boolean;
    }>(
      this.db,
      sql`SELECT id, ts, action, subject_type, subject_id, decision, session_id, revision, resolution, final_outcome, automatic FROM decisions WHERE ${this.matching(filter)}
           ORDER BY ts DESC, id COLLATE "C" DESC LIMIT ${filter.limit} OFFSET ${filter.offset ?? 0}`,
    );
    return found.map((r) => ({
      id: r.id,
      ts: iso(r.ts),
      action: r.action,
      subject: { type: r.subject_type, id: r.subject_id },
      decision: r.decision,
      ...(r.session_id ? { session: r.session_id } : {}),
      revision: r.revision,
      resolution: r.resolution,
      final_outcome: r.final_outcome,
      ...(r.automatic ? { automatic: true } : {}),
    }));
  }

  async countMatching(filter: Omit<DecisionFilter, "limit" | "offset">): Promise<number> {
    return (await first<{ n: number }>(
      this.db,
      sql`SELECT COUNT(*)::int AS n FROM decisions WHERE ${this.matching(filter)}`,
    ))!.n;
  }

  /** A new revision with the resolution. Run it in a transaction: the row is locked until it ends, so two resolutions get two revisions, in order. */
  async resolve(id: string, resolution: Resolution, now: Date): Promise<DecisionRecord | null> {
    const changed = await this.update(id, { resolution, revision: sql`revision + 1` }, now);
    return changed ? this.findRecord(id) : null;
  }

  async listAbout(subject: EntityRef, since: Date, until: Date, limit: number) {
    const found = await this.findMany({
      where: { subjectType: subject.type, subjectId: subject.id, ts: { lte: until, gt: since } },
      columns: { id: true, action: true, finalOutcome: true, ts: true },
      extras: { outcome: (t) => sql<string>`${t.decision} ->> 'decision'` },
      orderBy: { ts: "desc" },
      limit,
    });
    return found.map((r) => ({
      id: r.id,
      action: r.action,
      outcome: r.outcome,
      final_outcome: r.finalOutcome!,
      ts: iso(r.ts),
    }));
  }

  private matching(filter: Omit<DecisionFilter, "limit" | "offset">): SQL {
    const where: SQL[] = [
      sql`workspace_id = ${this.scope.workspaceId} AND environment_id = ${this.scope.environmentId}`,
    ];
    if (filter.before) where.push(sql`ts < ${at(filter.before)}`);
    if (filter.outcome) where.push(sql`decision ->> 'decision' = ${filter.outcome}`);
    if (filter.final_outcome) where.push(sql`final_outcome = ${filter.final_outcome}`);
    // "withdrawal" is every version of the action; "withdrawal@2" is one.
    if (filter.action) where.push(sql`(action = ${filter.action} OR starts_with(action, ${`${filter.action}@`}))`);
    if (filter.session) where.push(sql`session_id = ${filter.session}`);
    if (filter.subject) where.push(sql`subject_type = ${filter.subject.type} AND subject_id = ${filter.subject.id}`);
    return sql.join(where, sql` AND `);
  }
}
