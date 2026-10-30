import { isTriggeredBy, triggerOf, type ActionDefinition, type Decider } from "@kairos/core";
import type { Webhooks } from "../../../context";
import type { Repositories } from "../../../repositories";
import { ActionsService } from "../../../services/action.service";
import { DecisionsService } from "../../../services/decision.service";
import { EventsService } from "../../../services/event.service";
import type { EventVia, StoredEvent } from "../../../types";
import { runDecision } from "../service";
import type { JobKind, ModuleJobs } from "../../../platform/jobs/worker";

/**
 * Automatic decisions: an action with `automatic` decides each tracked event that matches its
 * trigger, in the background, with nobody waiting. The decision is saved with `automatic` and
 * goes out by webhook as decision.created. See internal/designs/outbound-webhooks.md, section 10,
 * and internal/designs/jobs.md, section 6.2.
 *
 * Each event to decide is a job of kind `decision.automatic`, written in the transaction that
 * stores the event (`enqueueAutomatic`). A stopped process loses nothing, and a model that is
 * down is tried again for about 7 hours.
 */

export const AUTOMATIC_KIND = "decision.automatic";
/** Only an event that happened this recently is a request; an older one is history being loaded. */
export const AUTOMATIC_WINDOW_MS = 3_600_000;
/** An event dated this far ahead is a wrong clock, not a request. */
const FUTURE_MS = 5 * 60_000;
/** Automatic decisions at once in one process. Live decisions do not wait for these. */
const AT_ONCE = 2;
/** The model can be down for a while. A decision that is hours late is still useful for review. */
const RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000, 3_600_000, 6 * 3_600_000];

/** When automatic decisions were turned on for an action; 0 for one saved before this was kept. */
const sinceOf = (action: ActionDefinition) => (action.automaticSince ? Date.parse(action.automaticSince) : 0);

export const canStartAutomatic = (via: EventVia | undefined) => via === "key" || via === "webhook" || via === "console";

export interface AutomaticPayload {
  action: string;
  event_id: string;
}

/**
 * Enqueue the automatic decisions that events which were just stored call for. Call it in the
 * transaction that stores them, so that a stored event always has its job. Returns how many.
 */
export async function enqueueAutomatic(
  tx: Pick<Repositories, "db" | "jobs">,
  workspaceId: string,
  environmentId: string,
  stored: StoredEvent[],
  via: EventVia | undefined,
  now: Date,
): Promise<number> {
  if (!canStartAutomatic(via) || stored.length === 0) return 0;
  const at = now.getTime();
  const current = stored.filter((e) => {
    const ts = Date.parse(e.ts);
    return ts >= at - AUTOMATIC_WINDOW_MS && ts <= at + FUTURE_MS;
  });
  if (current.length === 0) return 0;
  const automatic = (await new ActionsService(tx.db, { workspaceId, environmentId }).listLatest()).filter(
    (a) => a.automatic,
  );
  if (automatic.length === 0) return 0;
  let queued = 0;
  // In the order they happened, so that a later event's decision can see the earlier one's.
  const ordered = [...current].sort((a, b) => a.ts.localeCompare(b.ts));
  for (const [i, event] of ordered.entries()) {
    const action = automatic.find((a) => isTriggeredBy(a, event.type, event.status));
    // An event that happened before the switch was turned on was history when it came.
    if (!action || Date.parse(event.ts) < sinceOf(action) - FUTURE_MS) continue;
    const subject = event.entities[action.subject];
    if (!subject) continue;
    const payload: AutomaticPayload = { action: action.name, event_id: event.id };
    await tx.jobs.enqueue(
      {
        kind: AUTOMATIC_KIND,
        key: `${environmentId}:${action.name}:${event.id}`,
        payload: { ...payload },
        // One subject's decisions run one at a time, in the order of their events.
        group: `${environmentId}:${action.subject}:${subject}`,
        runAt: new Date(at + i),
        workspaceId,
        environmentId,
      },
      now,
    );
    queued++;
  }
  return queued;
}

export interface AutomaticRunner {
  kind: JobKind<AutomaticPayload>;
  wake(): void;
  estimate(
    workspaceId: string,
    environmentId: string,
    action: ActionDefinition,
  ): Promise<{ per_day: number; missed_last_day: number; window_minutes: number }>;
}

export interface AutomaticOptions {
  repos: Pick<Repositories, "db" | "events" | "entities" | "transaction">;
  decider: Decider;
  now: () => Date;
  webhooks?: Webhooks;
  wake: () => void;
}

export function decisionJobs(options: AutomaticOptions): ModuleJobs & { automatic: AutomaticRunner } {
  const automatic = createAutomatic(options);
  return { kinds: [automatic.kind], automatic };
}

export function createAutomatic({ repos, decider, now, webhooks, wake }: AutomaticOptions): AutomaticRunner {
  const { db, events } = repos;

  return {
    wake,

    kind: {
      kind: AUTOMATIC_KIND,
      concurrency: AT_ONCE,
      perGroup: 1,
      retryDelaysMs: RETRY_DELAYS_MS,
      // Short enough that the drain a function runs after its answer (20 seconds) starts it. The
      // lease covers a model that is slow: it has 10 seconds and two retries.
      timeoutMs: 15_000,
      leaseMs: 5 * 60_000,
      async run({ action: name, event_id }, job) {
        const workspaceId = job.workspaceId!;
        const environmentId = job.environmentId!;
        if (await new DecisionsService(db, { workspaceId, environmentId }).findByEvent(event_id)) return;
        // The action as it is now: turned off since, or no longer triggered by the event, it decides nothing.
        const action = await new ActionsService(db, { workspaceId, environmentId }).findLatest(name);
        const event = await new EventsService(db, { workspaceId, environmentId }).findByExternalId(event_id);
        if (
          !action?.automatic ||
          !event ||
          !isTriggeredBy(action, event.type, event.status) ||
          !event.entities[action.subject]
        )
          return;
        const outbound = webhooks ? { wake: () => webhooks.worker?.wake(), now: now() } : undefined;
        // A model that is down throws, and the job is tried again later.
        await runDecision(
          repos,
          decider,
          workspaceId,
          environmentId,
          {
            action,
            entities: event.entities,
            properties: event.properties,
            eventId: event.id,
            session: event.session,
            automatic: true,
          },
          new Date(event.ts),
          now(),
          outbound,
          { allowPrivate: webhooks?.allowPrivate ?? false, wake },
        );
      },
    },

    async estimate(workspaceId, environmentId, action) {
      const trigger = triggerOf(action);
      if (!trigger) return { per_day: 0, missed_last_day: 0, window_minutes: AUTOMATIC_WINDOW_MS / 60_000 };
      const at = now().getTime();
      const iso = (ms: number) => new Date(ms).toISOString();
      const counted = (rows: { status: string | null; n: number }[]) =>
        rows
          .filter((r) => isTriggeredBy(action, trigger.event, r.status ?? undefined))
          .reduce((sum, r) => sum + r.n, 0);
      const week = counted(
        await new EventsService(db, { workspaceId, environmentId }).countByStatus(
          trigger.event,
          iso(at - 7 * 86_400_000),
          iso(at),
        ),
      );
      const missFrom = Math.max(at - 86_400_000, sinceOf(action));
      const missTo = at - AUTOMATIC_WINDOW_MS;
      const missed =
        action.automatic && missFrom < missTo
          ? (
              await events.undecidedEvents(workspaceId, environmentId, trigger.event, iso(missFrom), iso(missTo), 1000)
            ).filter((e) => isTriggeredBy(action, e.type, e.status)).length
          : 0;
      return { per_day: Math.round(week / 7), missed_last_day: missed, window_minutes: AUTOMATIC_WINDOW_MS / 60_000 };
    },
  };
}
