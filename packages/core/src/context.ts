import { buildBaseline, type BaselineOptions } from "./baseline";
import type { DecisionContext, DecisionInput } from "./types";

export interface ContextOptions extends BaselineOptions {
  /** Most recent events sent in full. Older events are summarised. */
  recentEvents?: number;
}

export const DEFAULT_RECENT_EVENTS = 30;

/**
 * A compressed context was more accurate, about 12× faster and about 6% of the tokens
 * of a raw 700-event history in testing; see section 5.1 of the technical design.
 */
export function buildContext(input: DecisionInput, options: ContextOptions = {}): DecisionContext {
  const recent = options.recentEvents ?? DEFAULT_RECENT_EVENTS;
  const events = [...input.events].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const split = Math.max(0, events.length - recent);
  return {
    subject: input.subject,
    baseline_of_older_events: buildBaseline(events.slice(0, split), options),
    ...(input.totals && Object.keys(input.totals).length ? { totals: input.totals } : {}),
    ...(input.linkedEntities && Object.keys(input.linkedEntities).length
      ? { linked_entities: input.linkedEntities }
      : {}),
    ...(input.session ? { this_session: input.session } : {}),
    recent_events: events.slice(split),
    pending_action: input.pendingAction,
  };
}
