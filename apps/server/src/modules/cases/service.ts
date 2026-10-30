import {
  CASE_CATEGORIES,
  DEFAULT_VIEW,
  OUTCOME_SEVERITY,
  asColumn,
  caseTarget,
  correlationKey,
  definitionsFor,
  dueAt,
  hostApproved,
  displayName,
  displayOf,
  evaluateRule,
  highestPriority,
  readIntakeField,
  ruleSentence,
  validateQueue,
  validateView,
  viewFieldTitle,
  windowDays,
  type CasePriority,
  type CorrelationInput,
  type Decision,
  type IntakeInput,
  type Outcome,
  type QueueDefinition,
  type CaseView,
  type ViewBlock,
  type ViewField,
} from "@kairos/core";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CaseItemKind, CaseRow, QueueRow } from "../../db/schema";
import { AppError, invalid, notFound } from "../../platform/error";
import type { ModuleJobs } from "../../platform/jobs/worker";
import type { Repositories } from "../../repositories";
import { ActionsService } from "../../services/action.service";
import { CaseActivityService, CaseEvidenceService, CaseItemsService, CasesService } from "../../services/case.service";
import { DecisionsService } from "../../services/decision.service";
import { EntitiesService } from "../../services/entities.service";
import { EventsService } from "../../services/event.service";
import { MembershipsService } from "../../services/membership.service";
import { QueuesService, SYSTEM, canSee, type Viewer } from "../../services/queue.service";
import { WorkspacesService } from "../../services/workspace.service";
import { isDataAddress, readMedia } from "./libs";
import { addLabel, entityFacts, entityList } from "../catalog/service";
import { caseEvent, type CaseEventType } from "../webhooks/types";
import type { EntityRef } from "../catalog/types";
import { resolveDecisionIn } from "../decisions/service";
import type { StoredEvent } from "../ingest/types";
import {
  addItems,
  caseValues,
  decisionsByIds,
  decisionsForEvents,
  decisionsForTest,
  eventsByIds,
  findCaseSummary,
  listCases,
  lockName,
  propertiesOf,
  queueCounts,
  queuesForAction,
  type CaseDecisionRow,
  type QueueCounts,
} from "./repo";
import {
  CASE_EVALUATE_KIND,
  MAX_EVIDENCE,
  type CaseDetail,
  type CaseFilter,
  type CaseViewData,
  type CheckState,
  type MediaItem,
  type ViewTemplate,
  type ResolvedBlock,
  type ViewValue,
  type CaseSummary,
  type EvidenceSnapshot,
  type QueueView,
  type ResolveInput,
} from "./types";

type Scope = { workspaceId: string; environmentId: string };
const DAY = 86_400_000;

export { SYSTEM, canSee, type Viewer };

/** Only the owner renames a queue, changes who sees it, or deletes it. Anyone who sees it can change its setup. */
export const canManage = (q: { owner: string | null }, viewer: string | undefined) =>
  q.owner === null || q.owner === viewer;

export const toQueueView = (r: QueueRow, viewer: string | undefined, counts?: QueueView["counts"]): QueueView => ({
  ...r.definition,
  id: r.id,
  version: r.version,
  owner: r.owner,
  mine: r.owner !== null && r.owner === viewer,
  can_manage: canManage(r, viewer),
  ...(counts ? { counts } : {}),
  created: r.created.toISOString(),
  updated: r.updated.toISOString(),
});

/** The definition as it is stored: only its own fields, with the defaults filled in. */
const normalise = (d: QueueDefinition): QueueDefinition => ({
  name: d.name.trim(),
  ...(d.description?.trim() ? { description: d.description.trim() } : {}),
  visibility: d.visibility,
  enabled: d.enabled ?? true,
  sources: {
    actions: d.sources?.actions ?? [],
    ...(d.sources?.event_types ? { event_types: d.sources.event_types } : {}),
  },
  intake: d.intake.map((r) => ({
    ...r,
    name: r.name.trim(),
    enabled: r.enabled ?? true,
    priority: r.priority ?? "normal",
  })),
  correlation: d.correlation,
  columns: d.columns ?? ["target", "priority", "status", "assignee", "outcome", "risk", "age"],
  sort: d.sort ?? "oldest",
  ...(d.display ? { display: d.display } : {}),
  ...(d.due_hours && Object.keys(d.due_hours).length ? { due_hours: d.due_hours } : {}),
});

/** Check a definition, and that its actions exist. Throws with every problem. */
export async function checkQueue(db: Repositories["db"], scope: Scope, definition: QueueDefinition) {
  const problems = validateQueue(definition);
  if (problems.length === 0) {
    const defined = new Set((await new ActionsService(db, scope).listLatest()).map((a) => a.name));
    for (const name of definition.sources?.actions ?? [])
      if (!defined.has(name)) problems.push(`sources.actions: there is no action "${name}"`);
  }
  if (problems.length) throw invalid(problems.join("; "));
  return normalise(definition);
}

/** JSON with the keys of each object sorted: a definition read back from `jsonb` has its keys in another order. */
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
          .join(",")}}`
      : JSON.stringify(value);

/** The fields that decide which cases exist. A change to one of them is a new version of the queue. */
const intakeOf = (d: QueueDefinition) => canonical([d.sources, d.intake, d.correlation]);

const NO_CASES: QueueCounts = { open: 0, in_review: 0, unassigned: 0, overdue: 0, open_decisions: 0, mine: 0 };

export async function listQueues(db: Repositories["db"], scope: Scope, viewer: string | undefined, now: Date) {
  const [all, counts] = await Promise.all([new QueuesService(db, scope).list(), queueCounts(db, scope, now, viewer)]);
  return all.filter((q) => canSee(q, viewer)).map((q) => toQueueView(q, viewer, counts.get(q.id) ?? NO_CASES));
}

export async function findQueue(db: Repositories["db"], scope: Scope, id: string, viewer: string | undefined) {
  const found = await new QueuesService(db, scope).findById(id);
  if (!found || !canSee(found, viewer)) throw notFound(`No queue "${id}"`);
  return found;
}

export async function queueView(
  db: Repositories["db"],
  scope: Scope,
  id: string,
  viewer: string | undefined,
  now: Date,
) {
  const [queue, counts] = await Promise.all([findQueue(db, scope, id, viewer), queueCounts(db, scope, now, viewer)]);
  return toQueueView(queue, viewer, counts.get(queue.id) ?? NO_CASES);
}

export async function createQueue(
  db: Repositories["db"],
  scope: Scope,
  body: QueueDefinition,
  viewer: string | undefined,
  now: Date,
) {
  if (!viewer && body.visibility === "private")
    throw invalid("visibility: a queue made with an API key has no owner, so it cannot be private");
  const definition = await checkQueue(db, scope, body);
  const row = await new QueuesService(db, scope).create({ definition, owner: viewer ?? null, version: 1 }, now);
  return toQueueView(row, viewer);
}

export async function saveQueue(
  db: Repositories["db"],
  scope: Scope,
  id: string,
  body: QueueDefinition,
  viewer: string | undefined,
  now: Date,
) {
  const existing = await findQueue(db, scope, id, viewer);
  const definition = await checkQueue(db, scope, body);
  const before = existing.definition;
  if (!canManage(existing, viewer) && (definition.name !== before.name || definition.visibility !== before.visibility))
    throw new AppError(
      "forbidden",
      "forbidden",
      "Only the person who made this queue can rename it or change who sees it",
    );
  if (existing.owner === null && definition.visibility === "private")
    throw invalid("visibility: this queue has no owner, so it cannot be private");
  const version = intakeOf(definition) === intakeOf(before) ? existing.version : existing.version + 1;
  const saved = await new QueuesService(db, scope).update(id, { definition, version }, now);
  return toQueueView(saved!, viewer);
}

export async function deleteQueue(db: Repositories["db"], scope: Scope, id: string, viewer: string | undefined) {
  const existing = await findQueue(db, scope, id, viewer);
  if (!canManage(existing, viewer))
    throw new AppError("forbidden", "forbidden", "Only the person who made this queue can delete it");
  if (await new CasesService(db, scope).hasAny(id))
    throw new AppError(
      "conflict",
      "queue_has_cases",
      "This queue has cases. Disable it instead: it then takes no new cases.",
    );
  await new QueuesService(db, scope).delete(id);
}

interface DecisionFacts {
  id: string;
  ts: string;
  action: string;
  subject: EntityRef;
  decision: Decision;
  probabilities: Record<string, number>;
  request: { entities: Record<string, string>; properties: Record<string, unknown> };
  event: Pick<StoredEvent, "id" | "type" | "entities" | "properties" | "universal_id" | "session"> | null;
  session?: string;
}

const intakeInput = (f: DecisionFacts): IntakeInput => ({
  decision: {
    outcome: f.decision.decision,
    risk_score: f.decision.risk_score,
    ...(f.decision.typology ? { typology: f.decision.typology } : {}),
    signals: f.probabilities,
  },
  request: f.request.properties,
  ...(f.event ? { event: { type: f.event.type, properties: f.event.properties } } : {}),
});

const correlationInput = (f: DecisionFacts): CorrelationInput => ({
  subject: f.subject,
  // The request's entities win over the event's: they are what was asked about.
  entities: { ...f.event?.entities, ...f.request.entities },
  properties: { ...f.event?.properties, ...f.request.properties },
  ...((f.session ?? f.event?.session) ? { session: f.session ?? f.event?.session } : {}),
  ...(f.event ? { event_id: f.event.id } : {}),
});

export interface ItemRef {
  kind: CaseItemKind;
  type?: string | null;
  id: string;
}

/** The objects a decision names, and the event that started it: what becomes the items of a case. */
export function itemsOf(f: Pick<DecisionFacts, "id" | "subject" | "request" | "event" | "session">): ItemRef[] {
  const items: ItemRef[] = [{ kind: "decision", id: f.id }];
  if (f.event) items.push({ kind: "event", id: f.event.id });
  const entities = new Map<string, ItemRef>();
  const add = (type: string, id: string) => entities.set(`${type} ${id}`, { kind: "entity", type, id });
  add(f.subject.type, f.subject.id);
  for (const [type, id] of Object.entries(f.request.entities)) add(type, id);
  for (const [type, id] of Object.entries(f.event?.entities ?? {})) add(type, id);
  items.push(...entities.values());
  const session = f.session ?? f.event?.session;
  if (session) items.push({ kind: "session", id: session });
  if (f.event?.universal_id) items.push({ kind: "record", id: f.event.universal_id });
  return items;
}

async function decisionFacts(db: Repositories["db"], scope: Scope, id: string): Promise<DecisionFacts | null> {
  const record = await new DecisionsService(db, scope).findRecord(id);
  if (!record) return null;
  const event = record.event_id ? await new EventsService(db, scope).findByExternalId(record.event_id) : null;
  const raw = record.raw as { answers?: { reasons?: { probabilities?: Record<string, number> } } } | null;
  return {
    id: record.id,
    ts: record.ts,
    action: record.action,
    subject: record.subject,
    decision: record.decision as Decision,
    probabilities: raw?.answers?.reasons?.probabilities ?? {},
    request: record.request ?? { entities: { [record.subject.type]: record.subject.id }, properties: {} },
    event,
    ...(record.session ? { session: record.session } : {}),
  };
}

/** Send a case.* event with the case as it is now, in the caller's transaction. Returns how many deliveries. */
async function notify(
  tx: Pick<Repositories, "db" | "outbox">,
  scope: Scope,
  type: CaseEventType,
  id: string,
  now: Date,
) {
  const c = await findCaseSummary(tx.db, scope, id);
  if (!c) return 0;
  const { id: caseId, queue_id, ...rest } = c;
  return tx.outbox.enqueue(
    scope.workspaceId,
    scope.environmentId,
    caseEvent(type, { case_id: caseId, queue_id, ...rest }),
    now,
  );
}

export interface Trigger {
  source: { type: "decision" | "event" | "workflow"; id: string };
  /** When the trigger happened: the window counts from it. */
  ts: Date;
  key: string | null;
  target: EntityRef;
  /** `create` always starts a new case, which takes the key from the one that had it. */
  mode: "add_or_create" | "create";
  /** One for each rule that matched, or one for a workflow step. */
  evidence: {
    ruleId: string | null;
    ruleVersion: number | null;
    idempotencyKey: string;
    snapshot: EvidenceSnapshot;
    priority: CasePriority;
    reason: string;
  }[];
  outcome?: Outcome;
  risk?: number;
  items: ItemRef[];
  actor: string;
  /** Null for a correlation with no window. */
  windowMs: number | null;
}

const worse = (a: Outcome | null, b: Outcome | undefined): Outcome | null =>
  b === undefined ? a : a === null || OUTCOME_SEVERITY[b] > OUTCOME_SEVERITY[a] ? b : a;

/**
 * Add a trigger to the case of its key, or to a new case. Run it in a transaction. The case, the
 * evidence, the items, the activity and the case's summary are written here and nowhere else.
 */
export async function addTrigger(
  tx: Pick<Repositories, "db" | "outbox">,
  scope: Scope,
  queue: Pick<QueueRow, "id" | "definition">,
  t: Trigger,
  now: Date,
): Promise<{ case_id: string; created: boolean; reopened: boolean; queued: number }> {
  const evidence = new CaseEvidenceService(tx.db, scope);
  for (const e of t.evidence) await lockName(tx.db, "case-evidence", scope.environmentId, e.idempotencyKey);
  const fresh = [];
  let earlier: string | null = null;
  for (const e of t.evidence) {
    const found = await evidence.findByKey(e.idempotencyKey);
    if (found) earlier ??= found.caseId;
    else fresh.push(e);
  }
  if (fresh.length === 0) return { case_id: earlier!, created: false, reopened: false, queued: 0 };

  const cases = new CasesService(tx.db, scope);
  const activity = new CaseActivityService(tx.db, scope);
  if (t.key) await lockName(tx.db, "case-key", scope.environmentId, queue.id, t.key);

  let target: CaseRow | null = null;
  let previous: string | null = null;
  if (t.key) {
    const joinable = await cases.findJoinable(queue.id, t.key);
    if (joinable) {
      const quiet = t.windowMs !== null && t.ts.getTime() - joinable.lastEvidenceAt.getTime() > t.windowMs;
      const full = joinable.evidenceCount + fresh.length > MAX_EVIDENCE;
      if (t.mode === "create" || quiet || full) {
        await cases.update(joinable.id, { joinable: false }, now);
        previous = joinable.id;
      } else target = joinable;
    }
  }

  const dueHours = queue.definition.due_hours;
  let reopened = false;
  const reopenDays = queue.definition.correlation.reopen_days;
  if (!target && !previous && t.key && t.mode === "add_or_create" && reopenDays) {
    const resolved = await cases.findReopenable(queue.id, t.key, new Date(t.ts.getTime() - reopenDays * DAY));
    if (resolved) {
      target = (await cases.update(
        resolved.id,
        {
          status: resolved.assigneeId ? "in_review" : "open",
          joinable: true,
          resolution: null,
          resolvedAt: null,
          dueAt: dueAt(dueHours, resolved.priority, now),
        },
        now,
      ))!;
      reopened = true;
      await activity.create(
        {
          caseId: resolved.id,
          type: "reopened",
          actor: t.actor,
          payload: { source: t.source, resolution: resolved.resolution },
        },
        now,
      );
    }
  }

  let created = false;
  if (!target) {
    target = await cases.create(
      {
        queueId: queue.id,
        status: "open",
        priority: highestPriority(fresh.map((e) => e.priority)),
        assigneeId: null,
        targetType: t.target.type,
        targetId: t.target.id,
        correlationKey: t.key,
        joinable: true,
        reason: fresh[0]!.reason,
        worstOutcome: t.outcome ?? null,
        maxRisk: t.risk ?? null,
        evidenceCount: 0,
        lastEvidenceAt: t.ts,
        lastActivity: now,
        resolution: null,
        resolvedAt: null,
        dueAt: dueAt(dueHours, highestPriority(fresh.map((e) => e.priority)), t.ts),
      },
      now,
    );
    created = true;
    await activity.create(
      {
        caseId: target.id,
        type: "created",
        actor: t.actor,
        payload: { source: t.source, ...(previous ? { previous_case: previous } : {}) },
      },
      now,
    );
    if (previous)
      await activity.create(
        {
          caseId: previous,
          type: "status_changed",
          actor: "system",
          payload: { joinable: false, next_case: target.id },
        },
        now,
      );
  }

  const written: string[] = [];
  for (const e of fresh) {
    const row = await evidence.create(
      {
        caseId: target.id,
        sourceType: t.source.type,
        sourceId: t.source.id,
        ruleId: e.ruleId,
        ruleVersion: e.ruleVersion,
        snapshot: e.snapshot as Record<string, unknown>,
        correlationKey: t.key,
        idempotencyKey: e.idempotencyKey,
        ts: t.ts,
      },
      now,
    );
    written.push(row.id);
  }
  await addItems(tx.db, scope, target.id, written[0]!, t.items, now);
  if (!created)
    await activity.create(
      {
        caseId: target.id,
        type: "evidence_added",
        actor: t.actor,
        payload: { source: t.source, evidence: written, rules: fresh.map((e) => e.ruleId).filter(Boolean) },
      },
      now,
    );

  // A trigger can raise a case's priority, never lower it; a higher priority can only bring its due time closer.
  const priority = highestPriority([target.priority, ...fresh.map((e) => e.priority)]);
  const sooner = dueAt(dueHours, priority, target.created);
  await cases.update(
    target.id,
    {
      evidenceCount: target.evidenceCount + fresh.length,
      worstOutcome: worse(target.worstOutcome, t.outcome),
      maxRisk: t.risk === undefined ? target.maxRisk : Math.max(target.maxRisk ?? 0, t.risk),
      priority,
      dueAt: target.dueAt && sooner && sooner > target.dueAt ? target.dueAt : (sooner ?? target.dueAt),
      lastEvidenceAt: t.ts > target.lastEvidenceAt ? t.ts : target.lastEvidenceAt,
      lastActivity: now,
    },
    now,
  );
  const queued =
    created || reopened ? await notify(tx, scope, created ? "case.created" : "case.reopened", target.id, now) : 0;
  return { case_id: target.id, created, reopened, queued };
}

/** The test of one decision against the rules of one queue: the trigger to add, or null when no rule matched. */
export function triggerFor(queue: Pick<QueueRow, "id" | "version" | "definition">, f: DecisionFacts): Trigger | null {
  const definition = queue.definition;
  const input = intakeInput(f);
  const matches = definition.intake
    .filter((rule) => rule.enabled !== false)
    .map((rule) => ({ rule, result: evaluateRule(rule, input) }))
    .filter((m) => m.result.matched);
  if (matches.length === 0) return null;
  const correlation = correlationInput(f);
  const key = correlationKey(definition.correlation, correlation);
  if (!key && definition.correlation.when_missing === "skip") return null;
  const window = windowDays(definition.correlation);
  return {
    source: { type: "decision", id: f.id },
    ts: new Date(f.ts),
    key,
    target: caseTarget(definition.correlation, correlation) ?? f.subject,
    mode: "add_or_create",
    evidence: matches.map(({ rule, result }) => ({
      ruleId: rule.id,
      ruleVersion: queue.version,
      idempotencyKey: `intake:${queue.id}:${f.id}:${rule.id}`,
      priority: rule.priority ?? "normal",
      reason: rule.name,
      snapshot: {
        rule: ruleSentence(rule.conditions),
        conditions: result.conditions,
        decision: {
          id: f.id,
          action: f.action,
          outcome: f.decision.decision,
          risk_score: f.decision.risk_score,
          signals: f.decision.reasons ?? [],
        },
        ...(f.event ? { event: { id: f.event.id, type: f.event.type } } : {}),
      },
    })),
    outcome: f.decision.decision,
    risk: f.decision.risk_score,
    items: itemsOf(f),
    actor: "system",
    windowMs: window === null ? null : window * DAY,
  };
}

/** Test a saved decision against every queue that takes its action. Each queue is its own transaction. */
export async function evaluateDecision(repos: Repositories, scope: Scope, decisionId: string, now: Date) {
  const facts = await decisionFacts(repos.db, scope, decisionId);
  if (!facts) return [];
  const queues = await queuesForAction(repos.db, scope, facts.action.split("@")[0]!);
  const out: Awaited<ReturnType<typeof addTrigger>>[] = [];
  for (const queue of queues) {
    const trigger = triggerFor(queue, facts);
    if (!trigger) continue;
    const added = await repos.transaction((tx) => addTrigger(tx, scope, queue, trigger, now));
    out.push(added);
  }
  return out;
}

export function caseJobs({
  repos,
  now,
  wake,
}: {
  repos: Repositories;
  now: () => Date;
  wake?: () => void;
}): ModuleJobs {
  return {
    kinds: [
      {
        kind: CASE_EVALUATE_KIND,
        concurrency: 4,
        retryDelaysMs: [5_000, 30_000, 120_000, 600_000],
        timeoutMs: 15_000,
        async run({ decision_id }: { decision_id: string }, job) {
          const added = await evaluateDecision(
            repos,
            { workspaceId: job.workspaceId!, environmentId: job.environmentId! },
            decision_id,
            now(),
          );
          if (added.some((a) => a.queued > 0)) wake?.();
        },
      },
    ],
  };
}

const TEST_DAYS = 30;
const TEST_LIMIT = 2000;
const SAMPLES = 20;

/** What an unsaved definition would do over the last 30 days of its sources. It makes nothing. */
export async function testQueue(db: Repositories["db"], scope: Scope, body: QueueDefinition, now: Date) {
  const definition = await checkQueue(db, scope, body);
  const found = await decisionsForTest(
    db,
    scope,
    definition.sources.actions ?? [],
    new Date(now.getTime() - TEST_DAYS * DAY),
    TEST_LIMIT,
  );
  const queue = { id: "test", version: 0, definition };
  const tested = found.map((r) => {
    const facts: DecisionFacts = {
      id: r.id,
      ts: new Date(r.ts).toISOString(),
      action: r.action,
      subject: { type: r.subject_type, id: r.subject_id },
      decision: r.decision as Decision,
      probabilities: r.probabilities ?? {},
      request: r.request ?? { entities: { [r.subject_type]: r.subject_id }, properties: {} },
      event: r.event_id
        ? {
            id: r.event_id,
            type: r.event_type!,
            entities: r.event_entities ?? {},
            properties: r.event_properties ?? {},
          }
        : null,
      ...(r.session_id ? { session: r.session_id } : {}),
    };
    const input = intakeInput(facts);
    const rules = definition.intake
      .filter((rule) => rule.enabled !== false)
      .map((rule) => ({ id: rule.id, name: rule.name, ...evaluateRule(rule, input) }));
    return { facts, rules, trigger: triggerFor(queue, facts) };
  });

  // Cases as correlation would make them, oldest trigger first, with the window.
  const window = windowDays(definition.correlation);
  const last = new Map<string, number>();
  let cases = 0;
  let skipped = 0;
  for (const { trigger, rules } of [...tested].reverse()) {
    if (!trigger) {
      if (rules.some((r) => r.matched)) skipped++;
      continue;
    }
    const at = trigger.ts.getTime();
    const before = trigger.key ? last.get(trigger.key) : undefined;
    if (before === undefined || (window !== null && at - before > window * DAY)) cases++;
    if (trigger.key) last.set(trigger.key, at);
  }
  return {
    days: TEST_DAYS,
    tested: tested.length,
    truncated: found.length === TEST_LIMIT,
    matched: tested.filter((t) => t.trigger).length,
    skipped,
    cases,
    samples: tested.slice(0, SAMPLES).map(({ facts, rules, trigger }) => ({
      decision_id: facts.id,
      ts: facts.ts,
      action: facts.action,
      subject: facts.subject,
      outcome: facts.decision.decision,
      risk_score: facts.decision.risk_score,
      key: trigger?.key ?? null,
      matched: trigger !== null,
      rules,
    })),
  };
}

const nameKey = (e: EntityRef) => `${e.type} ${e.id}`;

/** The display names of some entities, from the display fields of their types. One with no name is left out. */
async function entityNames(db: Repositories["db"], scope: Scope, refs: EntityRef[]): Promise<Record<string, string>> {
  const unique = [...new Map(refs.map((r) => [nameKey(r), r])).values()];
  const [definitions, objects] = await Promise.all([
    new EntitiesService(db, scope).listByTypes([...new Set(unique.map((r) => r.type))]),
    propertiesOf(db, scope, unique),
  ]);
  const fields = new Map(definitions.map((d) => [d.type, displayOf(d.type, d).fields]));
  const names: Record<string, string> = {};
  for (const o of objects) {
    const name = displayName(fields.get(o.type), o.properties);
    if (name) names[nameKey(o)] = name;
  }
  return names;
}

const valuePaths = (columns: string[] | undefined) =>
  (columns ?? []).filter((c) => c.startsWith("request.") || c.startsWith("subject."));

export async function queueCases(
  db: Repositories["db"],
  scope: Scope,
  queue: QueueRow,
  filter: CaseFilter,
): Promise<{ cases: CaseSummary[]; total: number }> {
  const found = await listCases(db, scope, queue.id, filter, queue.definition.sort ?? "oldest");
  if (found.cases.length === 0) return found;
  const paths = valuePaths(queue.definition.columns);
  const [names, values] = await Promise.all([
    entityNames(
      db,
      scope,
      found.cases.map((c) => c.target),
    ),
    paths.length
      ? caseValues(
          db,
          scope,
          found.cases.map((c) => c.id),
        )
      : null,
  ]);
  return {
    ...found,
    cases: found.cases.map((c) => {
      const of = values?.get(c.id);
      return {
        ...c,
        target_name: names[nameKey(c.target)] ?? null,
        ...(values
          ? {
              values: Object.fromEntries(
                paths.map((p) => {
                  const [head, name] = p.split(".") as [string, string];
                  return [p, (head === "request" ? of?.request : of?.subject)?.[name] ?? null];
                }),
              ),
            }
          : {}),
      };
    }),
  };
}

async function requireCase(db: Repositories["db"], scope: Scope, id: string, viewer: Viewer) {
  const summary = await findCaseSummary(db, scope, id);
  if (!summary) throw notFound(`No case "${id}"`);
  const queue = await new QueuesService(db, scope).findById(summary.queue_id);
  if (!queue || !canSee(queue, viewer)) throw notFound(`No case "${id}"`);
  return { summary, queue };
}

export async function caseDetail(
  db: Repositories["db"],
  scope: Scope,
  id: string,
  viewer: Viewer,
): Promise<CaseDetail & { decisions: CaseDecisionRow[] }> {
  const { summary, queue } = await requireCase(db, scope, id, viewer);
  const [evidence, items, activity] = await Promise.all([
    new CaseEvidenceService(db, scope).listFor(id),
    new CaseItemsService(db, scope).listFor(id),
    new CaseActivityService(db, scope).listFor(id),
  ]);
  const rules = new Map(queue.definition.intake.map((r) => [r.id, r.name]));
  const [decisions, names] = await Promise.all([
    decisionsByIds(
      db,
      scope,
      items.filter((i) => i.kind === "decision").map((i) => i.refId),
    ),
    entityNames(db, scope, [
      summary.target,
      ...items.filter((i) => i.kind === "entity").map((i) => ({ type: i.refType!, id: i.refId })),
    ]),
  ]);
  return {
    ...summary,
    target_name: names[nameKey(summary.target)] ?? null,
    names,
    queue: { id: queue.id, name: queue.definition.name },
    evidence: evidence.map((e) => ({
      id: e.id,
      source: { type: e.sourceType, id: e.sourceId },
      rule: e.ruleId ? { id: e.ruleId, name: rules.get(e.ruleId) ?? e.ruleId, version: e.ruleVersion ?? 0 } : null,
      snapshot: e.snapshot as EvidenceSnapshot,
      correlation_key: e.correlationKey,
      ts: e.ts.toISOString(),
      created: e.created.toISOString(),
    })),
    items: items.map((i) => ({
      kind: i.kind,
      type: i.refType,
      id: i.refId,
      evidence_id: i.evidenceId,
      added: i.created.toISOString(),
    })),
    activity: activity.map((a) => ({
      id: a.id,
      type: a.type,
      actor: a.actor,
      payload: a.payload,
      created: a.created.toISOString(),
    })),
    decisions,
  };
}

const TIMELINE_LIMIT = 200;

/**
 * Events and decisions in time order: the case's items, and what happened around its target, to
 * read. An event comes before the decision it started. Each step says whether it is an item.
 */
export async function caseTimeline(
  repos: Pick<Repositories, "db" | "events">,
  scope: Scope,
  id: string,
  viewer: string | undefined,
  itemsOnly: boolean,
) {
  const { summary } = await requireCase(repos.db, scope, id, viewer);
  const items = await new CaseItemsService(repos.db, scope).listFor(id);
  const itemEvents = new Set(items.filter((i) => i.kind === "event").map((i) => i.refId));
  const itemDecisions = new Set(items.filter((i) => i.kind === "decision").map((i) => i.refId));

  const own = await eventsByIds(repos.db, scope, [...itemEvents]);
  let around: StoredEvent[] = [];
  if (!itemsOnly) {
    const since = new Date(summary.created).getTime() - DAY;
    const until = new Date(Math.max(Date.parse(summary.last_activity), Date.parse(summary.last_evidence_at)) + DAY);
    const session = items.find((i) => i.kind === "session")?.refId;
    around =
      summary.correlation_key?.startsWith("session:") && session
        ? await new EventsService(repos.db, scope).listInSession(session, until.toISOString(), TIMELINE_LIMIT)
        : (
            await repos.events.timeline(
              scope.workspaceId,
              scope.environmentId,
              summary.target,
              TIMELINE_LIMIT,
              until.toISOString(),
            )
          ).filter((e) => Date.parse(e.ts) >= since);
  }
  const events = new Map<string, StoredEvent>();
  for (const e of [...own, ...around]) events.set(e.id, e);
  const decisions = new Map<string, CaseDecisionRow>();
  for (const d of [
    ...(await decisionsByIds(repos.db, scope, [...itemDecisions])),
    ...(itemsOnly ? [] : await decisionsForEvents(repos.db, scope, [...events.keys()])),
  ])
    decisions.set(d.id, d);

  const steps = [
    ...[...events.values()].map((event) => ({
      kind: "event" as const,
      ts: event.ts,
      item: itemEvents.has(event.id),
      event,
    })),
    ...[...decisions.values()].map((decision) => ({
      kind: "decision" as const,
      ts: decision.ts,
      item: itemDecisions.has(decision.id),
      decision,
    })),
  ].sort((a, b) => a.ts.localeCompare(b.ts) || (a.kind === b.kind ? 0 : a.kind === "event" ? -1 : 1));
  return { steps };
}

/** Set or clear the assignee. An assignee starts the review of an open case; with none, the case is open again. */
export async function assignCase(
  repos: Pick<Repositories, "transaction">,
  scope: Scope,
  id: string,
  assignee: string | null,
  actor: string,
  viewer: string | undefined,
  now: Date,
): Promise<{ case: CaseSummary; queued: number }> {
  return repos.transaction(async (tx) => {
    const { summary } = await requireCase(tx.db, scope, id, viewer);
    if (summary.status === "resolved") throw new AppError("conflict", "case_resolved", "This case is resolved");
    if (assignee) {
      const member = await new MembershipsService(tx.db, { workspaceId: scope.workspaceId }).findByUser(assignee);
      if (!member?.active) throw invalid("assignee: not an active member of this workspace");
    }
    const status = assignee ? (summary.status === "open" ? "in_review" : summary.status) : "open";
    await new CasesService(tx.db, scope).update(id, { assigneeId: assignee, status, lastActivity: now }, now);
    const activity = new CaseActivityService(tx.db, scope);
    await activity.create({ caseId: id, type: "assigned", actor, payload: { assignee } }, now);
    if (status !== summary.status)
      await activity.create(
        { caseId: id, type: "status_changed", actor, payload: { from: summary.status, to: status } },
        now,
      );
    const queued = await notify(tx, scope, "case.assigned", id, now);
    return { case: (await findCaseSummary(tx.db, scope, id))!, queued };
  });
}

/** Open a resolved case again. It takes new triggers unless another case of its queue has its key now. */
export async function reopenCase(
  repos: Pick<Repositories, "transaction">,
  scope: Scope,
  id: string,
  actor: string,
  viewer: string | undefined,
  now: Date,
): Promise<{ case: CaseSummary; queued: number }> {
  return repos.transaction(async (tx) => {
    await lockName(tx.db, "case", scope.environmentId, id);
    const { summary, queue } = await requireCase(tx.db, scope, id, viewer);
    if (summary.status !== "resolved") throw new AppError("conflict", "case_not_resolved", "This case is not resolved");
    const cases = new CasesService(tx.db, scope);
    if (summary.correlation_key)
      await lockName(tx.db, "case-key", scope.environmentId, queue.id, summary.correlation_key);
    const taken = summary.correlation_key ? await cases.findJoinable(queue.id, summary.correlation_key) : null;
    await cases.update(
      id,
      {
        status: summary.assignee ? "in_review" : "open",
        joinable: !taken,
        resolution: null,
        resolvedAt: null,
        dueAt: dueAt(queue.definition.due_hours, summary.priority, now),
        lastActivity: now,
      },
      now,
    );
    await new CaseActivityService(tx.db, scope).create(
      { caseId: id, type: "reopened", actor, payload: { resolution: summary.resolution } },
      now,
    );
    const queued = await notify(tx, scope, "case.reopened", id, now);
    return { case: (await findCaseSummary(tx.db, scope, id))!, queued };
  });
}

export const MAX_BULK = 200;

export type BulkAction = { assign: string | null } | { resolve: ResolveInput };

/**
 * One action on many cases of a queue. Each case is its own transaction, so one that cannot be
 * changed (resolved already, not in the queue) does not stop the others; its error is in the answer.
 */
export async function bulkCases(
  repos: Pick<Repositories, "transaction" | "db">,
  scope: Scope,
  queue: QueueRow,
  ids: string[],
  action: BulkAction,
  actor: string,
  viewer: string | undefined,
  now: Date,
) {
  if (ids.length === 0 || ids.length > MAX_BULK) throw invalid(`ids: from 1 to ${MAX_BULK} cases`);
  if ("resolve" in action) {
    const problems = resolveProblems(action.resolve);
    if (problems.length) throw invalid(problems.join("; "));
  }
  const results: { id: string; ok: boolean; error?: string }[] = [];
  let queued = 0;
  for (const id of [...new Set(ids)]) {
    try {
      const found = await findCaseSummary(repos.db, scope, id);
      if (!found || found.queue_id !== queue.id) throw notFound(`No case "${id}" in this queue`);
      const done =
        "assign" in action
          ? await assignCase(repos, scope, id, action.assign, actor, viewer, now)
          : await resolveCase(repos, scope, id, action.resolve, actor, viewer, now);
      queued += done.queued;
      results.push({ id, ok: true });
    } catch (cause) {
      if (!(cause instanceof AppError)) throw cause;
      results.push({ id, ok: false, error: cause.message });
    }
  }
  return { results, queued };
}

export async function addNote(
  repos: Pick<Repositories, "db" | "transaction">,
  scope: Scope,
  id: string,
  text: string,
  actor: string,
  viewer: string | undefined,
  now: Date,
) {
  return repos.transaction(async (tx) => {
    await requireCase(tx.db, scope, id, viewer);
    const note = await new CaseActivityService(tx.db, scope).create(
      { caseId: id, type: "note", actor, payload: { text } },
      now,
    );
    await new CasesService(tx.db, scope).update(id, { lastActivity: now }, now);
    return { id: note.id, type: note.type, actor, payload: note.payload, created: note.created.toISOString() };
  });
}

const DECISION_OUTCOME: Partial<Record<ResolveInput["category"], "approve" | "block">> = {
  approved: "approve",
  blocked: "block",
};
const TARGET_LABEL: Partial<Record<ResolveInput["category"], string>> = {
  confirmed_fraud: "fraud_confirmed",
  false_positive: "cleared",
};

export function resolveProblems(input: ResolveInput): string[] {
  const problems: string[] = [];
  if (!CASE_CATEGORIES.includes(input.category)) problems.push(`category must be one of ${CASE_CATEGORIES.join(", ")}`);
  if (input.apply_to_decisions && !DECISION_OUTCOME[input.category])
    problems.push("apply_to_decisions: only with approved or blocked");
  if (input.label_target && !TARGET_LABEL[input.category])
    problems.push("label_target: only with confirmed_fraud or false_positive");
  return problems;
}

/**
 * Resolve a case. With `apply_to_decisions`, each decision of the case with no resolution, whose
 * outcome differs from the case's, is resolved too; with `label_target`, the target gets the
 * label. All of it is one transaction. Returns the case and how many webhook deliveries it queued.
 */
export async function resolveCase(
  repos: Pick<Repositories, "transaction">,
  scope: Scope,
  id: string,
  input: ResolveInput,
  actor: string,
  viewer: Viewer,
  now: Date,
  /** For a workflow's step: its run, for the chain rules, and its key, so a retry does nothing twice. */
  workflow?: { runId: string; stepKey: string },
): Promise<{ case: CaseSummary; queued: number; decisions_resolved: number; labelled: boolean }> {
  const problems = resolveProblems(input);
  if (problems.length) throw invalid(problems.join("; "));
  const madeBy = workflow?.runId;
  return repos.transaction(async (tx) => {
    await lockName(tx.db, "case", scope.environmentId, id);
    const { summary } = await requireCase(tx.db, scope, id, viewer);
    if (summary.status === "resolved") throw new AppError("conflict", "case_resolved", "This case is resolved already");
    const resolution = {
      category: input.category,
      ...(input.note?.trim() ? { note: input.note.trim() } : {}),
      by: actor,
      at: now.toISOString(),
      ...(workflow ? { workflow_step_key: workflow.stepKey } : {}),
    };
    await new CasesService(tx.db, scope).update(
      id,
      { status: "resolved", joinable: false, resolution, resolvedAt: now, lastActivity: now },
      now,
    );
    await new CaseActivityService(tx.db, scope).create(
      {
        caseId: id,
        type: "resolved",
        actor,
        payload: { ...resolution, ...(madeBy ? { workflow_run_id: madeBy } : {}) },
      },
      now,
    );
    const { workflow_step_key: _key, ...shown } = resolution;

    let queued = 0;
    let decisionsResolved = 0;
    const outcome = DECISION_OUTCOME[input.category];
    if (input.apply_to_decisions && outcome) {
      const items = await new CaseItemsService(tx.db, scope).listFor(id);
      const decisions = await decisionsByIds(
        tx.db,
        scope,
        items.filter((i) => i.kind === "decision").map((i) => i.refId),
      );
      for (const d of decisions) {
        if (d.resolution || d.decision.decision === outcome) continue;
        const done = await resolveDecisionIn(
          tx,
          scope.workspaceId,
          scope.environmentId,
          d.id,
          { outcome, ...(shown.note ? { note: shown.note } : {}), by: actor, at: shown.at },
          now,
          madeBy,
        );
        if (done) ((queued += done.queued), decisionsResolved++);
      }
    }
    const label = TARGET_LABEL[input.category];
    let labelled = false;
    if (input.label_target && label) {
      queued += await addLabel(
        tx,
        scope.workspaceId,
        scope.environmentId,
        summary.target,
        {
          label,
          ts: now.toISOString(),
          properties: { case_id: id },
          ...(madeBy ? { metadata: { workflow_run_id: madeBy } } : {}),
        },
        now,
        true,
      );
      labelled = true;
    }
    queued += await notify(tx, scope, "case.resolved", id, now);
    return {
      case: (await findCaseSummary(tx.db, scope, id))!,
      queued,
      decisions_resolved: decisionsResolved,
      labelled,
    };
  });
}

export interface WorkflowCaseInput {
  queue: string;
  entity: EntityRef;
  /** The value of the queue's key: an entity's id, a request property's value, a session, an event. */
  correlation?: string;
  reason: string;
  priority: CasePriority;
  mode: "add_or_create" | "create";
  links: { decisions: string[]; events: string[]; entities: EntityRef[] };
  run: { id: string; path: string; workflow: string };
  /** The event that started the run, when one did. */
  event?: { id: string; session?: string };
}

const MAX_LINKS = 20;

/** A case.create step: add the step's trigger to the case of its key, or a new case, in the step's transaction. */
export async function createCaseFromWorkflow(
  tx: Pick<Repositories, "db" | "outbox">,
  scope: Scope,
  input: WorkflowCaseInput,
  now: Date,
): ReturnType<typeof addTrigger> {
  const queue = await new QueuesService(tx.db, scope).findById(input.queue);
  if (!queue) throw invalid(`queue: there is no queue "${input.queue}"`);
  if (queue.definition.enabled === false)
    throw new AppError(
      "conflict",
      "queue_disabled",
      `The queue "${queue.definition.name}" is disabled: it takes no new cases`,
    );
  const correlation = queue.definition.correlation;

  const decisions = (
    await Promise.all(input.links.decisions.slice(0, MAX_LINKS).map((id) => decisionFacts(tx.db, scope, id)))
  ).filter((d): d is DecisionFacts => d !== null);
  const events = await eventsByIds(tx.db, scope, input.links.events.slice(0, MAX_LINKS));

  const items = new Map<string, ItemRef>();
  const add = (item: ItemRef) => items.set(`${item.kind} ${item.type ?? ""} ${item.id}`, item);
  add({ kind: "entity", type: input.entity.type, id: input.entity.id });
  for (const e of input.links.entities) add({ kind: "entity", type: e.type, id: e.id });
  for (const d of decisions) itemsOf(d).forEach(add);
  for (const e of events) {
    add({ kind: "event", id: e.id });
    for (const [type, id] of Object.entries(e.entities)) add({ kind: "entity", type, id });
    if (e.session) add({ kind: "session", id: e.session });
    if (e.universal_id) add({ kind: "record", id: e.universal_id });
  }

  // The key as an intake rule of the queue would make it, from what the step names.
  const entities: Record<string, string> = { [input.entity.type]: input.entity.id };
  for (const item of items.values()) if (item.kind === "entity" && item.type) entities[item.type] ??= item.id;
  const key = correlationKey(correlation, {
    subject: input.entity,
    entities:
      correlation.by === "entity" && correlation.type && input.correlation
        ? { ...entities, [correlation.type]: input.correlation }
        : entities,
    properties:
      correlation.by === "request" && correlation.property && input.correlation
        ? { [correlation.property]: input.correlation }
        : {},
    ...(correlation.by === "session" ? { session: input.correlation ?? input.event?.session } : {}),
    ...(correlation.by === "event" ? { event_id: input.correlation ?? input.event?.id } : {}),
  });
  if (!key && correlation.when_missing === "skip" && input.mode === "add_or_create")
    throw invalid("correlation: the step names no key, and the queue makes no case without one");

  const worst = decisions.reduce<Outcome | null>((w, d) => worse(w, d.decision.decision), null);
  const risk = decisions.length ? Math.max(...decisions.map((d) => d.decision.risk_score)) : undefined;
  const first = decisions[0];
  const window = windowDays(correlation);
  return addTrigger(
    tx,
    scope,
    queue,
    {
      source: { type: "workflow", id: `${input.run.id}:${input.run.path}` },
      ts: now,
      key,
      target: input.entity,
      mode: input.mode,
      evidence: [
        {
          ruleId: null,
          ruleVersion: null,
          idempotencyKey: `workflow:${input.run.id}:${input.run.path}`,
          priority: input.priority,
          reason: input.reason,
          snapshot: {
            reason: input.reason,
            workflow: { name: input.run.workflow, run_id: input.run.id, step: input.run.path },
            ...(first
              ? {
                  decision: {
                    id: first.id,
                    action: first.action,
                    outcome: first.decision.decision,
                    risk_score: first.decision.risk_score,
                    signals: first.decision.reasons ?? [],
                  },
                }
              : {}),
          },
        },
      ],
      ...(worst ? { outcome: worst } : {}),
      ...(risk !== undefined ? { risk } : {}),
      items: [...items.values()],
      actor: `workflow:${input.run.workflow}`,
      windowMs: window === null ? null : window * DAY,
    },
    now,
  );
}

/**
 * A case.resolve step. A case a person resolved first is left as it is: the step says so, and a
 * later step can test it. A retry of the step finds its own resolution and gives the same answer.
 */
export async function resolveCaseFromWorkflow(
  repos: Pick<Repositories, "transaction" | "db">,
  scope: Scope,
  id: string,
  input: ResolveInput,
  run: { id: string; path: string; workflow: string },
  now: Date,
) {
  const stepKey = `${run.id}:${run.path}`;
  const resolvedBefore = async () => {
    const found = await findCaseSummary(repos.db, scope, id);
    if (!found) throw notFound(`No case "${id}"`);
    const resolution = found.status === "resolved" ? found.resolution : null;
    return resolution
      ? {
          case_id: id,
          resolved: resolution.workflow_step_key === stepKey,
          resolution,
          decisions_resolved: 0,
          labelled: false,
          queued: 0,
        }
      : null;
  };
  const before = await resolvedBefore();
  if (before) return before;
  try {
    const done = await resolveCase(repos, scope, id, input, `workflow:${run.workflow}`, SYSTEM, now, {
      runId: run.id,
      stepKey,
    });
    return {
      case_id: id,
      resolved: true,
      resolution: done.case.resolution,
      decisions_resolved: done.decisions_resolved,
      labelled: done.labelled,
      queued: done.queued,
    };
  } catch (cause) {
    if (cause instanceof AppError && cause.type === "case_resolved") return (await resolvedBefore())!;
    throw cause;
  }
}

/** A case as `record.get` reads it: no activity, which can be long. */
export async function caseRecord(db: Repositories["db"], scope: Scope, id: string) {
  const { activity: _activity, ...detail } = await caseDetail(db, scope, id, SYSTEM);
  return detail;
}

export { searchCases, type CaseSearch } from "./repo";

function blockEntities(
  of: string | undefined,
  target: EntityRef,
  items: { kind: CaseItemKind; refType: string | null; refId: string }[],
): EntityRef[] {
  if (!of || of === "case.target") return [target];
  const type = of.slice("item.".length);
  return items
    .filter((i) => i.kind === "entity" && i.refType === type)
    .slice(0, 5)
    .map((i) => ({ type, id: i.refId }));
}

async function fieldReader(
  db: Repositories["db"],
  scope: Scope,
  summary: CaseSummary,
  queueName: string,
  items: { kind: CaseItemKind; refType: string | null; refId: string }[],
  paths: string[],
  now: Date,
): Promise<(path: string) => unknown> {
  const readsDecision = paths.some((p) => /^(decision|signal|request|event)\./.test(p));
  const decisionIds = items.filter((i) => i.kind === "decision").map((i) => i.refId);
  const latest = readsDecision
    ? (await decisionsByIds(db, scope, decisionIds)).sort((a, b) => b.ts.localeCompare(a.ts))[0]
    : undefined;
  const facts = latest ? await decisionFacts(db, scope, latest.id) : null;
  const input = facts ? intakeInput(facts) : {};
  const firstOf = (type: string) => blockEntities(`item.${type}`, summary.target, items)[0];
  const itemTypes = [...new Set(paths.filter((p) => p.startsWith("item.")).map((p) => p.split(".")[1]!))];
  const objects = new Map(
    (
      await propertiesOf(db, scope, [
        summary.target,
        ...itemTypes.map(firstOf).filter((r): r is EntityRef => r !== undefined),
      ])
    ).map((o) => [nameKey(o), o.properties]),
  );
  return (path) => {
    const [head, name, property] = path.split(".") as [string, string, string | undefined];
    if (head === "case")
      return {
        status: summary.status,
        priority: summary.priority,
        assignee: summary.assignee?.name ?? null,
        queue: queueName,
        opened: summary.created,
        age: summary.status === "resolved" ? null : now.getTime() - Date.parse(summary.created),
        due: summary.due_at,
        reason: summary.reason,
      }[name];
    if (head === "decision" && name === "action") return facts?.action.split("@")[0] ?? null;
    if (head === "subject") return objects.get(nameKey(summary.target))?.[name] ?? null;
    if (head === "item") {
      const ref = firstOf(name);
      return ref && property ? (objects.get(nameKey(ref))?.[property] ?? null) : null;
    }
    return readIntakeField(path, input) ?? null;
  };
}

function mediaItems(block: ViewBlock, read: (path: string) => unknown, hosts: string[]): MediaItem[] {
  return (block.fields ?? []).map(asColumn).map((f, index) => {
    const label = viewFieldTitle(f);
    const value = read(f.field);
    if (value === null || value === undefined || value === "") return { index, label, state: "missing" as const };
    if (isDataAddress(String(value))) return { index, label, state: "ready" as const };
    let url: URL;
    try {
      url = new URL(String(value));
    } catch {
      return { index, label, state: "not_a_link" as const };
    }
    return {
      index,
      label,
      host: url.hostname,
      state: hostApproved(url.hostname, hosts) ? ("ready" as const) : ("host_not_approved" as const),
    };
  });
}

function checksOf(
  block: ViewBlock,
  activity: { type: string; actor: string; payload: Record<string, unknown>; created: Date }[],
): CheckState[] {
  return (block.points ?? []).map((point) => {
    const last = activity
      .filter((a) => a.type === "checked" && a.payload.block === block.id && a.payload.point === point)
      .at(-1);
    return last
      ? { point, checked: last.payload.checked === true, by: last.actor, at: last.created.toISOString() }
      : { point, checked: false };
  });
}

export async function caseView(
  repos: Pick<Repositories, "db" | "entities">,
  scope: Scope,
  id: string,
  viewer: Viewer,
  now: Date,
  draft?: CaseView,
): Promise<CaseViewData> {
  const { db } = repos;
  const { summary, queue } = await requireCase(db, scope, id, viewer);
  const own = draft ?? queue.definition.display?.view;
  const view = own ?? DEFAULT_VIEW;
  const items = await new CaseItemsService(db, scope).listFor(id);
  const fields = [
    ...(view.header ?? []),
    ...view.blocks.flatMap((b) =>
      b.type === "fields" || b.type === "images" || b.type === "documents" ? (b.fields ?? []) : [],
    ),
  ].map(asColumn);
  const paths = fields.flatMap((f) => [f.field, ...(f.currency && !/^[A-Z]{3}$/.test(f.currency) ? [f.currency] : [])]);
  const read = await fieldReader(db, scope, summary, queue.definition.name, items, paths, now);
  const resolve = (field: ViewField): ViewValue => {
    const f = asColumn(field);
    const currency = f.currency && !/^[A-Z]{3}$/.test(f.currency) ? read(f.currency) : f.currency;
    return {
      field: f.field,
      label: viewFieldTitle(f),
      ...(f.format ? { format: f.format } : {}),
      ...(typeof currency === "string" ? { currency } : {}),
      value: read(f.field),
    };
  };
  const hasMedia = view.blocks.some((b) => b.type === "images" || b.type === "documents");
  const hasChecks = view.blocks.some((b) => b.type === "checklist");
  const [hosts, activity] = await Promise.all([
    hasMedia ? new WorkspacesService(db).mediaHosts(scope.workspaceId) : [],
    hasChecks ? new CaseActivityService(db, scope).listFor(id) : [],
  ]);

  const about = view.blocks
    .filter((b) => b.type === "facts" || b.type === "list")
    .flatMap((b) => blockEntities(b.of, summary.target, items));
  const [definitions, names] = await Promise.all([
    new EntitiesService(db, scope).listByTypes([...new Set(about.map((e) => e.type))]),
    entityNames(db, scope, about),
  ]);
  const ofType = new Map(definitions.map((d) => [d.type, d]));
  const blocks = await Promise.all(
    view.blocks.map(async (b): Promise<ResolvedBlock> => {
      if (b.type === "fields") return { ...b, values: (b.fields ?? []).map(resolve) };
      if (b.type === "images" || b.type === "documents") return { ...b, media: mediaItems(b, read, hosts) };
      if (b.type === "checklist") return { ...b, checks: checksOf(b, activity) };
      if (b.type !== "facts" && b.type !== "list") return b;
      const entities = await Promise.all(
        blockEntities(b.of, summary.target, items).map(async (ref) => {
          const base = { ...ref, name: names[nameKey(ref)] ?? null };
          if (b.type === "list")
            return {
              ...base,
              lists: definitionsFor(view.lists, ref.type, ofType.get(ref.type)?.lists, b.lists).map((l) => ({
                name: l.name,
                label: l.label,
              })),
            };
          const wanted = definitionsFor(view.facts, ref.type, ofType.get(ref.type)?.facts, b.facts);
          return { ...base, facts: wanted.length ? await entityFacts(repos, scope, ref, wanted, viewer, now) : [] };
        }),
      );
      return { ...b, entities };
    }),
  );
  return {
    custom: own !== undefined,
    ...(own?.template ? { template: own.template } : {}),
    header: (view.header ?? []).map(resolve),
    blocks,
  };
}

async function blockOf(
  db: Repositories["db"],
  scope: Scope,
  id: string,
  blockId: string,
  types: ViewBlock["type"][],
  viewer: Viewer,
) {
  const { summary, queue } = await requireCase(db, scope, id, viewer);
  const block = (queue.definition.display?.view ?? DEFAULT_VIEW).blocks.find(
    (b) => b.id === blockId && types.includes(b.type),
  );
  if (!block) throw notFound(`No ${types.join(" or ")} block "${blockId}" on this case's page`);
  return { summary, queue, block };
}

export async function caseMedia(
  db: Repositories["db"],
  scope: Scope,
  id: string,
  query: { block: string; index: number },
  viewer: Viewer,
  now: Date,
  allowPrivate: boolean,
) {
  const { summary, queue, block } = await blockOf(db, scope, id, query.block, ["images", "documents"], viewer);
  const field = (block.fields ?? []).map(asColumn)[query.index];
  if (!field) throw notFound(`The block "${query.block}" has no field ${query.index}`);
  const items = await new CaseItemsService(db, scope).listFor(id);
  const read = await fieldReader(db, scope, summary, queue.definition.name, items, [field.field], now);
  const hosts = await new WorkspacesService(db).mediaHosts(scope.workspaceId);
  return readMedia(read(field.field), hosts, { image: block.type === "images", allowPrivate });
}

export async function recordViewed(
  repos: Pick<Repositories, "db" | "transaction">,
  scope: Scope,
  id: string,
  blockId: string,
  actor: string,
  viewer: Viewer,
  now: Date,
) {
  const { block } = await blockOf(repos.db, scope, id, blockId, ["images", "documents"], viewer);
  await new CaseActivityService(repos.db, scope).create(
    {
      caseId: id,
      type: "viewed",
      actor,
      payload: { block: block.id, title: block.title ?? (block.type === "images" ? "the images" : "the documents") },
    },
    now,
  );
  return { ok: true };
}

export async function checkPoint(
  repos: Pick<Repositories, "db" | "transaction">,
  scope: Scope,
  id: string,
  input: { block: string; point: number; checked: boolean },
  actor: string,
  viewer: Viewer,
  now: Date,
) {
  return repos.transaction(async (tx) => {
    const { summary, block } = await blockOf(tx.db, scope, id, input.block, ["checklist"], viewer);
    if (summary.status === "resolved") throw new AppError("conflict", "case_resolved", "This case is resolved");
    const point = block.points?.[input.point];
    if (point === undefined) throw notFound(`The checklist "${input.block}" has no point ${input.point}`);
    const activity = new CaseActivityService(tx.db, scope);
    await activity.create(
      { caseId: id, type: "checked", actor, payload: { block: block.id, point, checked: input.checked } },
      now,
    );
    await new CasesService(tx.db, scope).update(id, { lastActivity: now }, now);
    return { checks: checksOf(block, await activity.listFor(id)) };
  });
}

export async function caseViewList(
  repos: Pick<Repositories, "db" | "entities">,
  scope: Scope,
  id: string,
  query: { block: string; entity: EntityRef; list: string; q?: string; limit: number; offset: number },
  viewer: Viewer,
  now: Date,
  draft?: CaseView,
) {
  const { db } = repos;
  const { summary, queue } = await requireCase(db, scope, id, viewer);
  const view = draft ?? queue.definition.display?.view ?? DEFAULT_VIEW;
  const block: ViewBlock | undefined = view.blocks.find((b) => b.id === query.block && b.type === "list");
  if (!block) throw notFound(`No list block "${query.block}" on this case's page`);
  const items = await new CaseItemsService(db, scope).listFor(id);
  if (!blockEntities(block.of, summary.target, items).some((e) => nameKey(e) === nameKey(query.entity)))
    throw notFound(`The block "${query.block}" is not about ${query.entity.type} "${query.entity.id}"`);
  const type = await new EntitiesService(db, scope).findByType(query.entity.type);
  const list = definitionsFor(view.lists, query.entity.type, type?.lists, block.lists).find(
    (l) => l.name === query.list,
  );
  if (!list) throw notFound(`The block "${query.block}" has no list "${query.list}"`);
  return entityList(repos, scope, query.entity, list, query, viewer, now);
}

export function loadViewTemplates(dir: string): ViewTemplate[] {
  const folder = join(dir, "case-views");
  try {
    return readdirSync(folder)
      .filter((file) => file.endsWith(".json"))
      .sort()
      .map((file) => JSON.parse(readFileSync(join(folder, file), "utf8")) as ViewTemplate)
      .filter((t) => typeof t.name === "string" && typeof t.label === "string" && validateView(t.view).length === 0);
  } catch {
    return [];
  }
}
