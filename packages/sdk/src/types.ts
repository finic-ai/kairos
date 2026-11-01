export type Action = "approve" | "step_up" | "review" | "block";

export interface KairosOptions {
  /** Secret API key. Use this SDK on a server only: the key can request decisions for any user. */
  apiKey: string;
  baseUrl?: string;
  /** Send the queue when it holds this many events. Default 20. */
  flushAt?: number;
  /** Send the queue at least this often, in milliseconds. Default 2000. 0 turns the timer off. */
  flushIntervalMs?: number;
  /** Events kept while the API is unreachable. The oldest are dropped beyond this. Default 10000. */
  maxQueueSize?: number;
  /** Time limit for one event upload, in milliseconds. Default 10000. */
  timeoutMs?: number;
  /** Time limit for one decision, with its retries, in milliseconds. Default 3000. */
  decideTimeoutMs?: number;
  /** Retries after a network failure, or a 408, 429, 500, 502, 503 or 504. Default 3. */
  maxRetries?: number;
  /** Called when events cannot be delivered. `track` never throws for delivery failures. */
  onError?: (error: Error) => void;
  fetch?: typeof fetch;
}

/**
 * Properties of an event. A property whose name ends in `Id` (or `_id`) names an entity:
 * `userId` → user, `deviceId` → device, `bankAccountId` → bank_account. Entities are how
 * Kairos builds timelines and finds links, so an event needs at least one. Everything
 * else is stored as given.
 */
export interface EventProperties {
  /** Entity type → id, for references that do not follow the `Id` naming. */
  entities?: Record<string, string>;
  /** When the event happened. Defaults to now. */
  timestamp?: Date | string;
  /** Supply your own id to make a retried `track` call idempotent. */
  eventId?: string;
  /**
   * Events with the same universal id are stages of one record: a transaction that is
   * pending, then completed, then disputed. A decision sees one record in its latest state.
   */
  universalId?: string;
  /** The state of the record at this stage, for example "pending". */
  status?: string;
  /**
   * Properties to set on the entity the event is about: `$set: { kyc_level: "full" }`.
   * When the event names more than one entity, say which: `$set: { user: { … }, device: { … } }`.
   * The newest event wins, in whatever order events arrive. Needs a secret key.
   */
  $set?: Record<string, unknown>;
  /** Like `$set`, but only for a property that has no value yet: `$set_once: { opened: "2021-03-04" }`. */
  $set_once?: Record<string, unknown>;
  /**
   * The visit this happens in: the id of the session in your own system, for example the id of
   * the login session. Kairos reads events with the same `$session` as one session, and a
   * decision sees what happened in its session before it. Set it on your server. It is not an
   * entity: `sessionId` still names an entity of your own called "session". `null` is no session.
   */
  $session?: string | null;
  [property: string]: unknown;
}

/** The pending action. Entities are read from the properties as for an event. */
export interface DecideInput {
  /** Name of an action defined with `defineAction`, for example "bank_transfer". */
  type: string;
  entities?: Record<string, string>;
  /**
   * The visit this happens in: the id of the session in your own system, for example the id of
   * the login session. Kairos reads events with the same `$session` as one session, and a
   * decision sees what happened in its session before it. Set it on your server. It is not an
   * entity: `sessionId` still names an entity of your own called "session". `null` is no session.
   */
  $session?: string | null;
  [property: string]: unknown;
}

/** A decision type: what to decide, in plain language, and how answers map to an outcome. */
export interface ActionDefinition {
  /** The name people see in the console, for example "Bank Transfer". The key is the first argument of `defineAction`. */
  displayName?: string;
  description?: string;
  /** Entity type whose history the decision reads, for example "user". */
  subject: string;
  /**
   * An event type that starts this action. `trackAndDecide` with an event of this type
   * stores the event and returns the decision, in one call. With `{ event, status }` the
   * action starts only for an event in one of those statuses.
   */
  trigger?: string | { event: string; status?: string | string[] };
  /**
   * Decide in the background on each tracked event that matches the trigger, with nobody
   * waiting: from `track()` with a secret key, and from inbound webhooks, never from a public
   * key. Only events that happened in the last hour; the decision goes out by webhook. Needs a
   * trigger. Not shown to the model, so a change is not a new version.
   */
  automatic?: boolean;
  /** The yes/no question. Yes must mean "hold this action". */
  hold: string;
  /** Mutually exclusive explanations, code → description. */
  typologies?: Record<string, string>;
  /** Signals to report, code → description. */
  reasons?: Record<string, string>;
  policy?: {
    /** Hold probability at or above which the outcome is "block". Default 0.9. */
    block?: number;
    /** Hold probability at or above which the outcome is "review". Default 0.5. */
    review?: number;
    /**
     * A rule fires when every reason code in `allOf` is present and every comparison in `when`
     * holds. `when` compares one of the action's totals with a number, and is exact.
     */
    rules?: { id: string; allOf: string[]; when?: TotalCondition[]; outcome: Action }[];
  };
  /** `linkTypes`: the entity types that count as links between subjects. Default: all. */
  context?: { recentEvents?: number; reasonThreshold?: number; linkTypes?: string[]; totals?: TotalDefinition[] };
}

/** A comparison of a total with a number, in a policy rule: { total: "money_out", op: ">", value: 5000 }. */
export interface TotalCondition {
  /** The name of a total in `context.totals`. */
  total: string;
  /** Which number of the total. Default "sum". "times_usual" needs `usual` on the total, "share_covered" needs `covers`. */
  is?: "sum" | "events" | "times_usual" | "share_covered";
  op: ">" | ">=" | "<" | "<=";
  value: number;
}

/**
 * A sum over the subject's events, calculated for each decision and shown to the model with
 * the comparison already made. See "Totals" in the SDK guide.
 */
export interface TotalDefinition {
  /** The name of the total in the context. The model reads it: "money_in", not "t1". */
  name: string;
  /** The event type to read. */
  event: string;
  /** The numeric property to add up. */
  sum: string;
  /** Conditions on the event's properties and its status. A list matches any of its values. */
  where?: Record<string, string | number | boolean | (string | number | boolean)[]>;
  /** How far back from the decision: "30m", "24h", "7d". Without it, all history. "session": the events sent with the `$session` of the request. */
  window?: string;
  /** A longer period, for example "90d", to compare the window with what is usual. */
  usual?: string;
  /** A property of the action being decided, for example "amount": the share of it the total covers. */
  covers?: string;
  /** A property to split the sum by, for example "currency". */
  by?: string;
}

/** What an entity type is. Optional: an event that names an undefined type still creates it. */
export interface EntityDefinition {
  /**
   * What sort of thing this type is: "person", "business", "account", "device", "contact",
   * "document", "network", "place" or "other". Optional, and any name is accepted. It
   * classifies the type; it does not change a decision.
   */
  kind?: string;
  description?: string;
  /** Properties an entity of this type carries, as name → what it means. Documentation, not a constraint. */
  properties?: Record<string, string>;
  /**
   * Whether two subjects that share an entity of this type count as linked. Default true.
   * An action's `linkTypes` overrides it.
   */
  link?: boolean;
}

export interface DecideOptions {
  /**
   * Action to return when Kairos cannot answer in time. Without it, `decide` throws.
   * Choose per decision type: "approve" fails open, "review" fails closed.
   */
  fallback?: Action;
  timeoutMs?: number;
  /** Decide as of a past moment, seeing only events up to it. For backtests and replays. */
  timestamp?: Date | string;
  /** Send queued events first, so the decision sees them. Default true. */
  flush?: boolean;
}

export interface Decision {
  decision: Action;
  /** 0 to 100. The hold probability × 100. */
  riskScore: number;
  /** Probability that the action should be held, 0 to 1. */
  probability: number;
  /** Signals judged present. Not a causal explanation of `riskScore`. */
  reasons: string[];
  typology?: string;
  /** Policy rules that fired. */
  rules: string[];
  /** The action definition that produced this decision, as "name@version". */
  action?: string;
  decisionId?: string;
  /** The event that started this decision, when `trackAndDecide` did. */
  eventId?: string;
  /** True when this is the `fallback` action and not an answer from Kairos. */
  fallback: boolean;
  /** Set with `fallback`: why Kairos could not answer. */
  error?: Error;
}

/** A run of a workflow, as `runWorkflow` gives it. */
export interface WorkflowRun {
  id: string;
  workflow: string;
  /** "queued", "running", "waiting", "filtered", "done", "failed" or "cancelled". */
  status: string;
  trigger: Record<string, unknown>;
  /** What the run gave, once it is done: a Return step's value, else the output of the last step. */
  output: unknown;
  error: string | null;
  steps: Record<string, unknown>[];
  created: string;
  started: string | null;
  finished: string | null;
}

export interface RunWorkflowOptions {
  /** Wait for the run to end, and get its output. The workflow must have no delay. */
  wait?: boolean;
  /** With `wait`: how long the server runs it before it answers with the run as it is. 1 to 30. Default 10. */
  timeoutSeconds?: number;
  /** The same key gives the same run. Default: a new key, which a retry of this call keeps. */
  idempotencyKey?: string;
}

export type RouteMode = "track" | "decide_request" | "decide_response";
export type FieldSource =
  | "request.body"
  | "request.query"
  | "request.header"
  | "request.cookie"
  | "request.param"
  | "response.header"
  | "response.body";
export type FieldKind = "email" | "phone" | "address" | "username" | "hmac" | "token";

/** Where one property of a route's event comes from: a `from` and a `path`, or a constant `value`. */
export interface RouteField {
  from?: FieldSource;
  /** A JSONPath such as `$.payee.id` for a body; the name of a header, a query parameter, a cookie or a route parameter. */
  path?: string;
  value?: string | number | boolean;
  kind?: FieldKind;
}

export interface ClientRoute {
  /** A method and a path: "POST /payees/:id". */
  route: string;
  mode: RouteMode;
  type: string;
  failed?: string;
  fields: Record<string, RouteField>;
  fallback?: Action;
  timeoutMs?: number;
  block?: { status: number; body?: unknown };
  stepUp?: "forward" | { redirect: string };
  enforce: boolean;
}

/** What the clients collect in one environment, as set in Settings › Integrations › Client settings. */
export interface ClientSettings {
  version: number;
  consent: "required" | "not_required";
  defaults: { country?: string; off: ("email" | "phone" | "address" | "username")[]; sessionCookie?: string };
  routing: { mode: "off" | "monitor" | "active"; other: "ignore" | "discover" };
  pages: { path: string; type: string }[];
  screens: { name: string; type: string }[];
  routes: ClientRoute[];
}

/** Wire format of one event in `POST /v1/events`. */
export interface WireEvent {
  id: string;
  type: string;
  ts: string;
  entities: Record<string, string>;
  properties: Record<string, unknown>;
  universal_id?: string;
  status?: string;
  session?: string;
  /** Entity type → properties to set on that entity. */
  set?: Record<string, Record<string, unknown>>;
  set_once?: Record<string, Record<string, unknown>>;
}
