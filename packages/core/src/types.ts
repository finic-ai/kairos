/** One recorded event. `ts` and `type` are required; all other fields pass through to the model unchanged. */
export interface KairosEvent {
  ts: string;
  type: string;
  [property: string]: unknown;
}

/** The entity a decision is about, with whatever is known about it. */
export interface Subject {
  type: string;
  id?: string;
  [trait: string]: unknown;
}

/** The action the customer is about to take a decision on. */
export interface PendingAction {
  type: string;
  [property: string]: unknown;
}

/** One-hop summary of entities that share an identifier, keyed by "<entity type> <id>". */
export type LinkedEntities = Record<string, Record<string, unknown>>;

export interface DecisionInput {
  subject: Subject;
  events: KairosEvent[];
  pendingAction: PendingAction;
  linkedEntities?: LinkedEntities;
  /** Sums over the subject's events that the action asked for, already calculated. */
  totals?: Record<string, unknown>;
  /** What happened in the session of the request, before the request. See `summariseSession`. */
  session?: Record<string, unknown>;
  /** The same totals as numbers, for the policy rules. Not shown to the model. */
  totalValues?: Record<string, { sum: number; events: number; times_usual?: number; share_covered?: number | null }>;
}

export interface DecisionContext {
  subject: Subject;
  baseline_of_older_events: Baseline | null;
  /** After the summary of older events, because that is what they complete. */
  totals?: Record<string, unknown>;
  linked_entities?: LinkedEntities;
  /** The current visit: which of the recent events are one session, and how fast it went. */
  this_session?: Record<string, unknown>;
  recent_events: KairosEvent[];
  pending_action: PendingAction;
}

export type FieldProfile =
  | { median: number; max: number }
  | { values: Record<string, number> }
  | { distinct: number; most_common?: Record<string, number> };

export interface EventTypeProfile {
  count: number;
  last: string;
  fields?: Record<string, FieldProfile>;
}

export interface Baseline {
  period: [string, string];
  events: number;
  activity_by_hour_band: Record<string, number>;
  event_types: Record<string, EventTypeProfile>;
  /** Events of rare types, and events that carry free text, kept in full. */
  rare_events: KairosEvent[];
}

export type Outcome = "approve" | "step_up" | "review" | "block";

export interface Decision {
  decision: Outcome;
  /** Probability that the action should be held, 0 to 1. */
  probability: number;
  /** `probability` × 100, rounded. */
  risk_score: number;
  /** Signals the model judged present. Not a causal explanation of `risk_score`. */
  reasons: string[];
  typology?: string;
  /** Policy rules that fired, if any. */
  rules: string[];
  /** The action definition that produced this decision, as "name@version". */
  action: string;
}
