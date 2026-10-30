import { GraysonError, isTriggeredBy, type Decider } from "@kairos/core";
import { invalid, notFound, AppError } from "../../platform/error";
import type { Repositories } from "../../repositories";
import type { IncomingEvent } from "./schema";
import type { Executor } from "../../platform/database";
import type { EventVia, StoredEvent } from "../../types";
import { setProperties } from "../catalog/service";
import { enqueueAutomatic } from "../decisions/libs";
import { startEventRuns } from "../workflows/service";
import { runDecision, type DecisionFlowOptions, type DecisionRepositories } from "../decisions/service";
import { ActionsService } from "../../services/action.service";
import { DecisionsService } from "../../services/decision.service";
import { EventsService } from "../../services/event.service";

/** The event as it is stored: the properties for its entities go to the entities, not into the event. */
export const storedEvent = ({ set: _set, set_once: _once, ...event }: IncomingEvent): StoredEvent => event;

export async function applySets(
  db: Executor,
  workspaceId: string,
  environmentId: string,
  events: IncomingEvent[],
  now: string,
): Promise<void> {
  for (const event of events) {
    for (const type of new Set([...Object.keys(event.set ?? {}), ...Object.keys(event.set_once ?? {})])) {
      await setProperties(
        db,
        workspaceId,
        environmentId,
        { type, id: event.entities[type]! },
        { set: event.set?.[type], setOnce: event.set_once?.[type] },
        event.ts,
        now,
      );
    }
  }
}

export type IngestRepositories = Pick<Repositories, "transaction">;

export async function ingest(
  { transaction }: IngestRepositories,
  workspaceId: string,
  environmentId: string,
  batch: IncomingEvent[],
  now: string,
  via?: EventVia,
) {
  return transaction(async (tx) => {
    const result = await tx.events.insertEvents(workspaceId, environmentId, batch.map(storedEvent), now, via);
    await applySets(tx.db, workspaceId, environmentId, batch, now);
    // The first event with an id is the one that was stored.
    const fresh = new Set(result.ids);
    const stored = batch.filter((e) => fresh.delete(e.id)).map(storedEvent);
    const queued = await enqueueAutomatic(tx, workspaceId, environmentId, stored, via, new Date(now));
    // Event-triggered workflows start in the same transaction, so a stored event loses none.
    await startEventRuns(tx, { workspaceId, environmentId }, stored, via, new Date(now));
    return { ...result, queued };
  });
}

/**
 * Store events that an API key or the console sent. Anyone can read a public key out of a page,
 * so an event sent with one must not change facts about an entity.
 */
export async function track(
  repos: IngestRepositories,
  workspaceId: string,
  environmentId: string,
  batch: IncomingEvent[],
  now: string,
  via: EventVia,
) {
  if (via === "public" && batch.some((e) => e.set || e.set_once)) {
    throw new AppError(
      "forbidden",
      "public_key_scope",
      "A public key cannot set entity properties. Send $set and $set_once from your server with a secret key.",
    );
  }
  return ingest(repos, workspaceId, environmentId, batch, now, via);
}

export async function decideEvent(
  repos: DecisionRepositories,
  decider: Decider,
  workspaceId: string,
  environmentId: string,
  event: IncomingEvent,
  via: EventVia,
  now: Date,
  outbound?: { wake(): void; now: Date },
  flow?: DecisionFlowOptions,
) {
  const earlier = await new DecisionsService(repos.db, { workspaceId, environmentId }).findByEvent(event.id);
  if (earlier) return { ...(earlier.decision as object), decision_id: earlier.id, event_id: event.id };

  const action = (await new ActionsService(repos.db, { workspaceId, environmentId }).listLatest()).find((a) =>
    isTriggeredBy(a, event.type, event.status),
  );
  if (!action) {
    const what = event.status ? `"${event.type}" with status "${event.status}"` : `"${event.type}"`;
    throw new AppError(
      "not_found",
      "no_trigger",
      `No action is triggered by ${what}. Set a trigger on an action, or call POST /v1/decide.`,
    );
  }
  if (!event.entities[action.subject])
    throw invalid(`entities.${action.subject}: action "${action.name}" decides about a ${action.subject}`);
  await repos.events.insertEvents(workspaceId, environmentId, [storedEvent(event)], now.toISOString(), via);
  // Before the decision, so that it sees the properties the event carries.
  await applySets(repos.db, workspaceId, environmentId, [event], now.toISOString());
  try {
    const decision = await runDecision(
      repos,
      decider,
      workspaceId,
      environmentId,
      { action, entities: event.entities, properties: event.properties, eventId: event.id, session: event.session },
      new Date(event.ts),
      now,
      outbound,
      flow,
    );
    return { ...decision, event_id: event.id };
  } catch (cause) {
    if (cause instanceof GraysonError) throw new AppError("bad_gateway", "model_unavailable", cause.message);
    throw cause;
  }
}

export async function record(
  { db }: Pick<Repositories, "db">,
  workspaceId: string,
  environmentId: string,
  universalId: string,
  now: Date,
) {
  const stages = await new EventsService(db, { workspaceId, environmentId }).listStages(universalId, now.toISOString());
  if (stages.length === 0) throw notFound(`No record "${universalId}"`);
  return { universal_id: universalId, status: [...stages].reverse().find((s) => s.status)?.status ?? null, stages };
}

export async function session(
  { db, events }: Pick<Repositories, "db" | "events">,
  workspaceId: string,
  environmentId: string,
  id: string,
  now: Date,
  limit: number,
) {
  const [inSession, decided] = await Promise.all([
    new EventsService(db, { workspaceId, environmentId }).listInSession(id, now.toISOString(), limit),
    new DecisionsService(db, { workspaceId, environmentId }).listSummaries({ limit: 200, session: id }),
  ]);
  if (inSession.length === 0 && decided.length === 0) throw notFound(`No session "${id}"`);
  const named: Record<string, string[]> = {};
  for (const event of inSession) {
    for (const [type, entityId] of Object.entries(event.entities))
      if (!(named[type] ??= []).includes(entityId)) named[type]!.push(entityId);
  }
  const times = [...inSession.map((e) => e.ts), ...decided.map((d) => d.ts)].sort();
  return {
    id,
    started: times[0],
    last_seen: times[times.length - 1],
    entities: named,
    events: inSession,
    decisions: decided.reverse(),
  };
}
