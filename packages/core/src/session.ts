import type { KairosEvent } from "./types";

/** A session with no event for this long has ended. What comes after is a new visit with the same id. */
export const SESSION_IDLE_MS = 30 * 60_000;
/** The most recent steps of a session that the model is shown. */
const MAX_STEPS = 40;

/** An event time with no zone is UTC. */
const toMs = (ts: string) =>
  Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? ts : ts.length === 16 ? `${ts}:00Z` : `${ts}Z`);

const span = (ms: number) => {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return "less than a minute";
  if (minutes < 120) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} hours` : `${Math.round(hours / 24)} days`;
};

export interface SessionSummary {
  /** The events of the current visit, oldest first: the part of `events` a total for the session reads. */
  events: KairosEvent[];
  /** What the model reads. */
  context: Record<string, unknown>;
}

/**
 * What happened in the session of a request, before the request: when it started, how long
 * ago, and its steps in order. The recent events of a subject are a list with no boundaries;
 * this says which of them are one visit, and a takeover is often one short visit: a login,
 * a change of password, a new payee, a withdrawal.
 *
 * `events` are every event sent with the session id, as the model sees events, with the
 * action being decided left out. A gap longer than `idleMs` ends a visit, so only the events
 * after the last such gap are the current one. Returns null when the session has no events.
 */
export function summariseSession(
  events: KairosEvent[],
  now: number,
  options: { idleMs?: number; others?: { noun: string; count: number } } = {},
): SessionSummary | null {
  const idle = options.idleMs ?? SESSION_IDLE_MS;
  const sorted = events
    .map((event) => ({ event, at: toMs(event.ts) }))
    .filter((e) => Number.isFinite(e.at) && e.at <= now)
    .sort((a, b) => a.at - b.at);
  if (sorted.length === 0) return null;
  let first = sorted.length - 1;
  while (first > 0 && sorted[first]!.at - sorted[first - 1]!.at <= idle) first--;
  const visit = sorted.slice(first);
  const started = visit[0]!.at;
  const last = visit[visit.length - 1]!.at;
  const steps = visit.slice(-MAX_STEPS).map(({ event, at }) => {
    const after = at - started;
    const clock = `+${Math.floor(after / 60_000)}:${String(Math.floor((after % 60_000) / 1000)).padStart(2, "0")}`;
    return `${clock} ${event.type}${typeof event.status === "string" ? ` (${event.status})` : ""}`;
  });
  return {
    events: visit.map((e) => e.event),
    context: {
      started: visit[0]!.event.ts,
      started_before_this_action: span(now - started),
      events: visit.length,
      // Minutes and seconds after the start, then the event type.
      steps,
      ...(visit.length > MAX_STEPS ? { earlier_steps_not_shown: visit.length - MAX_STEPS } : {}),
      ...(now - last > idle ? { no_activity_before_this_action_for: span(now - last) } : {}),
      ...(first > 0 ? { earlier_visits_with_this_session_id: true } : {}),
      // One session id used by more than one subject can be a stolen session.
      ...(options.others && options.others.count > 0
        ? { [`other_${options.others.noun}_in_this_session`]: options.others.count }
        : {}),
    },
  };
}
