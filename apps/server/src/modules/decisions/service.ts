import {
  buildContext,
  decide,
  fromModelAnswers,
  toModelQuestions,
  type ActionDefinition,
  type AskAnswer,
  type AskQuestion,
  type Decider,
  type Decision,
  type DecisionInput,
  type KairosEvent,
  type LinkedEntities,
  evaluateTotals,
  summariseSession,
  totalsReach,
} from "@kairos/core";
import { foldRecords, type Folded } from "../ingest/libs";
import type { Resolution } from "../../db/schema";
import { newId } from "../../platform/crypto";
import { decisionCreated, decisionUpdated } from "../webhooks/types";
import { decideByWorkflow, startRecordRuns } from "../workflows/service";
import { WorkflowsService } from "../../services/workflow.service";
import { enqueueCaseIntake } from "../cases/libs";
import type { Repositories } from "../../repositories";
import type { DecisionRecord, EntitiesRepository, EntityRef, StoredEvent } from "../../types";
import { DecisionsService } from "../../services/decision.service";
import { EntitiesService } from "../../services/entities.service";
import { EventsService } from "../../services/event.service";
import { LabelsService } from "../../services/label.service";
import { ObjectsService } from "../../services/object.service";

export type DecisionRepositories = Pick<Repositories, "db" | "events" | "entities" | "transaction">;

const HISTORY_LIMIT = 2000;
/** Events read for the totals of one decision. Past this, the totals cover the most recent ones. */
const TOTALS_LIMIT = 20_000;
const MAX_LINKED = 8;
const SESSION_LIMIT = 500;
/** Above this many linked subjects, all time, an entity's all-time labels are not reported. */
const LINK_LIMIT = 500;
/** The recent window. Concentration inside it is what makes a shared place a link. */
const RECENT_DAYS = 30;
/** Subjects counted inside the recent window. Above this, the numbers describe a sample. */
const RECENT_LIMIT = 2000;
const NEAR_MINUTES = 30;
const DAY = 86_400_000;

const seconds = (ts: string) => ts.slice(0, 19);
const plural = (type: string) => (type.endsWith("s") ? type : `${type}s`);

function flatten(event: Folded, subject: EntityRef): KairosEvent {
  const { [subject.type]: _self, ...others } = event.entities;
  return {
    ...event.properties,
    ...others,
    ...(event.status ? { status: event.status } : {}),
    ...(event.status_history
      ? { status_history: event.status_history.map((h) => `${h.status} ${seconds(h.ts)}`) }
      : {}),
    ts: seconds(event.ts),
    type: event.type,
  };
}

const share = (count: number, of: number) => (of > 0 ? Math.round((1000 * count) / of) / 1000 : 0);

/**
 * For each label: how many of the linked subjects carry it, what share that is, and the
 * share among all subjects. A link matters when its share is far above the normal one,
 * which is what separates a mule ATM from a busy supermarket.
 */
function labelShares(
  counts: Record<string, number>,
  of: number,
  rates: { total: number; labels: Record<string, number> },
  noun: string,
) {
  return Object.fromEntries(
    Object.entries(counts).map(([label, count]) => [
      label,
      { [noun]: count, share: share(count, of), normal_share: share(rates.labels[label] ?? 0, rates.total) },
    ]),
  );
}

interface Stores {
  entityTypes: EntitiesService;
  objects: ObjectsService;
  labels: LabelsService;
}

async function linkedEntities(
  entities: EntitiesRepository,
  stores: Stores,
  workspaceId: string,
  environmentId: string,
  subject: EntityRef,
  pending: Record<string, string>,
  recent: StoredEvent[],
  now: Date,
  linkTypes?: string[],
): Promise<LinkedEntities> {
  const candidates = new Map<string, EntityRef & { pending: boolean }>();
  const add = (type: string, id: string, isPending: boolean) => {
    if (type !== subject.type && !candidates.has(`${type} ${id}`))
      candidates.set(`${type} ${id}`, { type, id, pending: isPending });
  };
  for (const [type, id] of Object.entries(pending)) add(type, id, true);
  for (const event of [...recent].reverse())
    for (const [type, id] of Object.entries(event.entities)) add(type, id, false);

  const before = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const query = {
    until: now.toISOString(),
    since: before(RECENT_DAYS * DAY),
    day: before(DAY),
    near: before(NEAR_MINUTES * 60_000),
    limit: LINK_LIMIT,
    recentLimit: RECENT_LIMIT,
  };
  const noun = plural(subject.type);
  const others = `other_${noun}`;
  const capped = (n: number, cap: number) => (n > cap ? `more than ${cap}` : n);
  let rates: Awaited<ReturnType<EntitiesRepository["labelRates"]>> | undefined;

  const out: LinkedEntities = {};
  for (const [key, entity] of [...candidates].slice(0, MAX_LINKED)) {
    const definition = await stores.entityTypes.findByType(entity.type);
    // A type that is not a link still shows what is known about the entity itself. The action's
    // `linkTypes` decides; without it, the entity type's own definition does.
    const includeLinks = linkTypes ? linkTypes.includes(entity.type) : definition?.link !== false;
    const [summary, labels, object] = await Promise.all([
      includeLinks ? entities.linkSummary(workspaceId, environmentId, subject, entity, query) : null,
      stores.labels.listFor(entity, query.until),
      stores.objects.findByEntity(entity),
    ]);
    const known = Object.keys(object?.properties ?? {}).length > 0;
    // An entity only this subject uses says nothing, unless it is what the action is about.
    if ((summary?.others ?? 0) === 0 && labels.length === 0 && !known && !(entity.pending && includeLinks)) continue;
    const own = {
      // The entity type's kind is deliberately not passed on. Tested on the mule ATM scenario,
      // 6 mules at an ATM with confirmed mules, two runs each: no kind held 6 and 6; the kind
      // "place" alone held 1; the kind with a note that a place is a link when its use is
      // concentrated held 4 and 4. The numbers in the link summary already show concentration,
      // and extra words about the kind only made the model more cautious.
      // What the customer recorded about the entity itself, for example an IP's network type.
      ...(known ? { about: object!.properties } : {}),
      ...(labels.length ? { labels: labels.map((l) => l.label) } : {}),
    };
    if (!summary) {
      out[key] = own;
      continue;
    }
    rates ??= await entities.labelRates(workspaceId, environmentId, subject.type, query.until);
    const window = Math.min(summary.recent.others, RECENT_LIMIT);
    out[key] = {
      ...own,
      first_seen: summary.first_seen ? seconds(summary.first_seen) : "never",
      [others]: capped(summary.others, LINK_LIMIT),
      ...(Object.keys(summary.labels).length
        ? { [`${others}_by_label`]: labelShares(summary.labels, summary.others, rates, noun) }
        : {}),
      ...(summary.recent.others > 0
        ? {
            [`last_${RECENT_DAYS}_days`]: {
              [others]: capped(summary.recent.others, RECENT_LIMIT),
              // "New" means the account itself was first seen inside the window. A burst of new
              // accounts at one place is a signal that needs no label.
              [`of_them_new_accounts`]: summary.recent.new,
              in_last_24_hours: {
                [others]: Math.min(summary.recent.last_day, RECENT_LIMIT),
                of_them_new_accounts: summary.recent.last_day_new,
              },
              [`in_last_${NEAR_MINUTES}_minutes`]: {
                [others]: Math.min(summary.recent.near, RECENT_LIMIT),
                of_them_new_accounts: summary.recent.near_new,
              },
              ...(Object.keys(summary.recent.labels).length
                ? { by_label: labelShares(summary.recent.labels, window, rates, noun) }
                : {}),
            },
          }
        : {}),
    };
  }
  return out;
}

export interface DecideRequest {
  action: ActionDefinition;
  entities: Record<string, string>;
  properties: Record<string, unknown>;
  /** The stored event that started this decision. It is the pending action, so it is left out of the history. */
  eventId?: string;
  session?: string;
  automatic?: boolean;
  /** Provenance written with the decision, such as the workflow step that asked for it. */
  metadata?: Record<string, unknown>;
}

/** The database refused a second decision for one event (the unique index decisions_one_per_event). */
const isSecondDecision = (cause: unknown) => {
  // Drizzle puts the database's error on `cause`.
  const e = ((cause as { cause?: { code?: string; constraint?: string } })?.cause ?? cause) as {
    code?: string;
    constraint?: string;
  };
  return e?.code === "23505" && (!e.constraint || e.constraint === "decisions_one_per_event");
};

/** What the model and the action's policy say about a request, with what the model was shown. */
export interface Assessment {
  decision: Decision;
  context: unknown;
  raw: unknown;
}

/**
 * Ask the model about a request, and apply the action's policy: what a decision says, with
 * nothing saved. Each decision asks it, unless the action has a decision workflow; that
 * workflow's "Get the model's decision" steps ask it.
 */
export async function assessDecision(
  repos: Pick<DecisionRepositories, "db" | "events" | "entities">,
  decider: Decider,
  workspaceId: string,
  environmentId: string,
  request: Pick<DecideRequest, "action" | "entities" | "properties" | "eventId" | "session">,
  /** The moment the decision is made as of: in the past for a backtest. */
  now: Date,
  /** Default grayson-1. */
  model?: string,
): Promise<Assessment> {
  const input = await decisionInput(repos, workspaceId, environmentId, request, now);
  const result = await decide(input, { decider, action: request.action, ...(model ? { model } : {}) });
  return { decision: result.decision, context: result.context, raw: result.raw };
}

/** What the model reads about a request: the subject's history, links, session and totals. */
async function decisionInput(
  { db, events: eventStore, entities }: Pick<DecisionRepositories, "db" | "events" | "entities">,
  workspaceId: string,
  environmentId: string,
  request: Pick<DecideRequest, "action" | "entities" | "properties" | "eventId" | "session">,
  now: Date,
): Promise<DecisionInput> {
  const { action } = request;
  const subject: EntityRef = { type: action.subject, id: request.entities[action.subject]! };
  const scope = { workspaceId, environmentId };
  const stores: Stores = {
    entityTypes: new EntitiesService(db, scope),
    objects: new ObjectsService(db, scope),
    labels: new LabelsService(db, scope),
  };

  const [raw, object, labels] = await Promise.all([
    eventStore.timeline(workspaceId, environmentId, subject, HISTORY_LIMIT, now.toISOString()),
    stores.objects.findByEntity(subject),
    // Only outcomes known at the moment of the decision: a backtest must not see the future.
    stores.labels.listFor(subject, now.toISOString()),
  ]);
  // The event that started the decision is the pending action, so it leaves the history. If it
  // is a stage of a record, the record's earlier stages leave with it and are shown with it.
  const trigger = request.eventId ? raw.find((e) => e.id === request.eventId) : undefined;
  const mine = (e: StoredEvent) =>
    e.id === request.eventId || (trigger?.universal_id !== undefined && e.universal_id === trigger.universal_id);
  const earlier = raw.filter((e) => mine(e) && e.id !== request.eventId && e.status);
  const events = foldRecords(raw.filter((e) => !mine(e)));
  const recent = events.slice(-(action.context?.recentEvents ?? 30));
  const { [subject.type]: _self, ...otherEntities } = request.entities;
  const pendingAction = {
    ...request.properties,
    ...otherEntities,
    ...(trigger?.status ? { status: trigger.status } : {}),
    ...(earlier.length ? { earlier_statuses: earlier.map((e) => `${e.status} ${seconds(e.ts)}`) } : {}),
    type: action.name,
    requested_at: seconds(now.toISOString()),
  };

  // The session of the request: which events are this visit, whoever they name. A request with no
  // session, or a session with no events yet, has no such block, and that must not read as "safe".
  let visit: ReturnType<typeof summariseSession> = null;
  let visitOfSubject: KairosEvent[] | undefined;
  if (request.session) {
    const inSession = foldRecords(
      (await new EventsService(db, scope).listInSession(request.session, now.toISOString(), SESSION_LIMIT)).filter(
        (e) => !mine(e),
      ),
    );
    const others = new Set(
      inSession.map((e) => e.entities[subject.type]).filter((id) => id !== undefined && id !== subject.id),
    );
    visit = summariseSession(
      inSession.map((e) => flatten(e, subject)),
      now.getTime(),
      { others: { noun: plural(subject.type), count: others.size } },
    );
    // A total for the session counts the subject's own events in the current visit.
    const started = visit?.events[0]?.ts;
    visitOfSubject = inSession
      .filter((e) => e.entities[subject.type] === subject.id && started !== undefined && seconds(e.ts) >= started)
      .map((e) => flatten(e, subject));
  }

  // Totals read their own events: the full window, not the most recent events of the history.
  let totals: ReturnType<typeof evaluateTotals> | undefined;
  const wanted = action.context?.totals ?? [];
  if (wanted.length > 0) {
    const reach = totalsReach(wanted);
    const since = reach === null ? null : new Date(now.getTime() - reach).toISOString();
    const forTotals = await eventStore.eventsOfTypes(
      workspaceId,
      environmentId,
      subject,
      [...new Set(wanted.map((t) => t.event))],
      since,
      now.toISOString(),
      TOTALS_LIMIT,
    );
    // A record counts once, in its latest status, and the action being decided is not counted.
    totals = evaluateTotals(
      wanted,
      foldRecords(forTotals.filter((e) => !mine(e))).map((e) => flatten(e, subject)),
      pendingAction,
      now.getTime(),
      visitOfSubject,
    );
  }

  return {
    subject: {
      ...object?.properties,
      type: subject.type,
      id: subject.id,
      first_seen: events[0] ? seconds(events[0].ts) : object ? seconds(object.first_seen) : "never",
      ...(labels.length ? { labels: labels.map((l) => l.label) } : {}),
    },
    events: events.map((e) => flatten(e, subject)),
    pendingAction,
    ...(totals ? { totals: totals.context, totalValues: totals.values } : {}),
    ...(visit ? { session: visit.context } : {}),
    linkedEntities: await linkedEntities(
      entities,
      stores,
      workspaceId,
      environmentId,
      subject,
      otherEntities,
      recent,
      now,
      action.context?.linkTypes,
    ),
  };
}

/** What an "Ask a question" step asks about: an entity's history, data from the run, or both. */
export interface ModelQuestion {
  entity?: EntityRef;
  data?: Record<string, unknown>;
  questions: Record<string, AskQuestion>;
  model?: string;
}

/**
 * Ask the model the questions of a workflow step, about an entity and its history, or about the
 * step's data alone. Nothing is saved, and no action's policy applies.
 */
export async function askModel(
  repos: Pick<DecisionRepositories, "db" | "events" | "entities">,
  decider: Decider,
  workspaceId: string,
  environmentId: string,
  ask: ModelQuestion,
  now: Date,
): Promise<{ answers: Record<string, AskAnswer>; input_tokens: number; context: unknown; model: string }> {
  // The entity is read as a decision's subject is; the data is what the question is about now.
  const asking: ActionDefinition = { name: "question", subject: ask.entity?.type ?? "entity", hold: "-" };
  const context = ask.entity
    ? buildContext(
        await decisionInput(
          repos,
          workspaceId,
          environmentId,
          { action: asking, entities: { [ask.entity.type]: ask.entity.id }, properties: ask.data ?? {} },
          now,
        ),
      )
    : { data: ask.data ?? {} };
  const raw = await decider({ model: ask.model ?? "grayson-1", context, questions: toModelQuestions(ask.questions) });
  return {
    answers: fromModelAnswers(ask.questions, raw),
    input_tokens: raw.usage.input_tokens,
    context,
    model: raw.model,
  };
}

/** What a decision workflow's runs need from the caller: the address rules of HTTP steps, and the worker to tell. */
export interface DecisionFlowOptions {
  allowPrivate: boolean;
  wake?: () => void;
}

export async function runDecision(
  repos: DecisionRepositories,
  decider: Decider,
  workspaceId: string,
  environmentId: string,
  request: DecideRequest,
  /** The moment the decision is made as of: in the past for a backtest. */
  now: Date,
  /** The server's clock: when the decision is saved. */
  savedAt: Date,
  /**
   * Set for a live decision: the webhooks that want it get a delivery, and the worker is told.
   * Not set for a decision as of a past moment, which is a test of the past and sends nothing.
   */
  outbound?: { wake(): void; now: Date },
  flow: DecisionFlowOptions = { allowPrivate: false },
): Promise<Decision & { decision_id: string; workflow_run_id?: string }> {
  const { db, transaction } = repos;
  const { action } = request;
  const subject: EntityRef = { type: action.subject, id: request.entities[action.subject]! };
  const scope = { workspaceId, environmentId };
  const workflow = await new WorkflowsService(db, scope).decisionWorkflow(action.name);
  const byWorkflow = workflow ? await decideByWorkflow(db, decider, scope, workflow, request, now, flow) : null;
  const result = byWorkflow ?? (await assessDecision(repos, decider, workspaceId, environmentId, request, now));
  const metadata = {
    ...request.metadata,
    ...(byWorkflow ? { decision_workflow: byWorkflow.workflow, decision_run_id: byWorkflow.runId } : {}),
    ...(byWorkflow?.scores.length ? { scores: byWorkflow.scores } : {}),
  };

  const id = newId("kdec");
  const record = {
    id,
    ts: now.toISOString(),
    action: result.decision.action,
    subject,
    decision: result.decision,
    context: result.context,
    raw: result.raw,
    ...(request.eventId ? { event_id: request.eventId } : {}),
    ...(request.session ? { session: request.session } : {}),
    request: { entities: request.entities, properties: request.properties ?? {} },
    ...(request.automatic ? { automatic: true } : {}),
    ...(Object.keys(metadata).length ? { metadata } : {}),
  };
  let queued: number;
  try {
    // The webhook deliveries are written with the decision, in one transaction: a saved decision always has them.
    queued = await transaction(async (tx) => {
      const eventId = record.event_id
        ? await new EventsService(tx.db, scope).findIdByExternalId(record.event_id)
        : null;
      await new DecisionsService(tx.db, scope).createRecord(record, eventId, savedAt);
      // A decision as of a past moment is a test of the past: it starts no workflow and makes no case,
      // as it sends no webhook.
      const live = now.getTime() >= savedAt.getTime() - 60_000;
      if (byWorkflow) await byWorkflow.saved(tx, id, savedAt, live);
      let intake = false;
      if (live) {
        const madeBy = byWorkflow?.runId ?? request.metadata?.workflow_run_id;
        await startRecordRuns(tx.db, scope, decisionChange("created", record, id, madeBy, record.ts), savedAt);
        intake = await enqueueCaseIntake(tx, scope, { id, action: record.action }, savedAt);
      }
      const deliveries = outbound
        ? await tx.outbox.enqueue(workspaceId, environmentId, decisionCreated(record), outbound.now)
        : 0;
      return deliveries + (intake ? 1 : 0);
    });
  } catch (cause) {
    // Another path decided this event first (an automatic decision and /events/decide at the same
    // moment). One event has one decision: the first one stands, and this one is dropped.
    const first =
      request.eventId && isSecondDecision(cause)
        ? await new DecisionsService(db, scope).findByEvent(request.eventId)
        : null;
    if (!first) throw cause;
    if (byWorkflow) await byWorkflow.dropped(savedAt);
    return { ...(first.decision as Decision), decision_id: first.id };
  }
  if (queued > 0) outbound?.wake();
  return { ...result.decision, decision_id: id, ...(byWorkflow ? { workflow_run_id: byWorkflow.runId } : {}) };
}

/** A decision as a record trigger's run reads it: the record without the model's context and answer. */
function decisionChange(
  on: "created" | "updated",
  record: DecisionRecord,
  key: string,
  madeBy: unknown,
  ts: string,
): Parameters<typeof startRecordRuns>[2] {
  const { context: _context, raw: _raw, ...decision } = record;
  return {
    record: "decision",
    on,
    key,
    input: { decision },
    kind: record.action.split("@")[0]!,
    ts,
    ...(typeof madeBy === "string" ? { madeBy } : {}),
  };
}

export async function resolveDecision(
  { transaction }: Pick<Repositories, "transaction">,
  workspaceId: string,
  environmentId: string,
  id: string,
  resolution: Resolution,
  now: Date,
  /** The workflow run that resolves it, for the chain rules of record triggers. */
  madeBy?: string,
): Promise<{ record: DecisionRecord; queued: number } | null> {
  return transaction((tx) => resolveDecisionIn(tx, workspaceId, environmentId, id, resolution, now, madeBy));
}

/** `resolveDecision` in the caller's transaction, for a change that resolves decisions with other writes: a case's resolution. */
export async function resolveDecisionIn(
  tx: Pick<Repositories, "db" | "outbox">,
  workspaceId: string,
  environmentId: string,
  id: string,
  resolution: Resolution,
  now: Date,
  madeBy?: string,
): Promise<{ record: DecisionRecord; queued: number } | null> {
  const record = await new DecisionsService(tx.db, { workspaceId, environmentId }).resolve(id, resolution, now);
  if (!record) return null;
  await startRecordRuns(
    tx.db,
    { workspaceId, environmentId },
    decisionChange("updated", record, `${id}@${record.revision ?? 0}`, madeBy, now.toISOString()),
    now,
  );
  return { record, queued: await tx.outbox.enqueue(workspaceId, environmentId, decisionUpdated(record), now) };
}
