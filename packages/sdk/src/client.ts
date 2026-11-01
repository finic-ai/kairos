import { scopeEntities, type Scope } from "./context.js";
import { KairosApiError, KairosError, KairosTimeoutError } from "./errors.js";
import type {
  Action,
  ActionDefinition,
  ClientSettings,
  EntityDefinition,
  DecideInput,
  DecideOptions,
  Decision,
  EventProperties,
  KairosOptions,
  RunWorkflowOptions,
  WireEvent,
  WorkflowRun,
} from "./types.js";

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
const MAX_BATCH = 500;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** `$session` as the API takes it. An empty value is no session. */
function session(value: unknown): { session?: string } {
  if (value === undefined || value === null || value === "") return {};
  if (typeof value !== "string" && typeof value !== "number")
    throw new KairosError("$session must be the id of a session, as text");
  return { session: String(value) };
}

/** userId → user, bankAccountId → bank_account, recipient_id → recipient. */
function entityType(key: string): string | undefined {
  const match = /^(.+?)(?:Id|_id)$/.exec(key);
  return match ? match[1]!.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase() : undefined;
}

/** Split properties into entity references and everything else. */
function split(input: Record<string, unknown>): {
  entities: Record<string, string>;
  properties: Record<string, unknown>;
} {
  const entities: Record<string, string> = {};
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const type = entityType(key);
    if (key === "entities" && value && typeof value === "object") Object.assign(entities, value);
    else if (type && (typeof value === "string" || typeof value === "number") && value !== "")
      entities[type] = String(value);
    else if (value !== undefined) properties[key] = value;
  }
  return { entities, properties };
}

const optional = <K extends string, V>(key: K, value: V | undefined) =>
  value === undefined ? {} : ({ [key]: value } as Record<K, V>);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * `$set` in the form the API takes: entity type → properties. `{ user: { … } }` is that form
 * already. `{ kyc_level: "full" }` is about the one entity the event is about: `about` is the
 * entity types that can be, which are the ones the call named and not the ones a request added.
 */
function bySubject(
  field: string,
  value: unknown,
  entities: Record<string, string>,
  about: string[],
  event: string,
): Record<string, Record<string, unknown>> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new KairosError(`${field} on "${event}" must be an object of properties`);
  const keys = Object.keys(value);
  if (keys.length === 0) return undefined;
  if (keys.every((key) => key in entities && isRecord(value[key])))
    return value as Record<string, Record<string, unknown>>;
  if (about.length !== 1) {
    throw new KairosError(
      `${field} on "${event}": the event names ${about.join(", ")}. Say which entity the properties are for: ${field}: { ${about[0]}: { … } }`,
    );
  }
  return { [about[0]!]: value };
}

/** Thrown when a call names no entity. An automatic event with no one to be about is left out. */
class NoEntityError extends KairosError {}

/** The calls a request can make with its own context: `req.kairos` in Express, `c.get("kairos")` in Hono. */
export type RequestClient = Pick<Kairos, "track" | "trackAndDecide" | "decide">;

export class Kairos {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly flushAt: number;
  private readonly flushIntervalMs: number;
  private readonly maxQueueSize: number;
  private readonly timeoutMs: number;
  private readonly decideTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly onError: (error: Error) => void;
  private readonly doFetch: typeof fetch;

  /**
   * Where the context of the current request comes from. `@finic-ai/kairos/middleware` sets it;
   * your code does not.
   */
  scopeSource?: () => Scope | undefined;

  private queue: WireEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flushing: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(options: KairosOptions) {
    if (!options.apiKey) throw new KairosError("apiKey is required");
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "https://kairos.finic.ai").replace(/\/+$/, "");
    this.flushAt = options.flushAt ?? 20;
    this.flushIntervalMs = options.flushIntervalMs ?? 2000;
    this.maxQueueSize = options.maxQueueSize ?? 10_000;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.decideTimeoutMs = options.decideTimeoutMs ?? 3000;
    this.maxRetries = options.maxRetries ?? 3;
    this.onError = options.onError ?? (() => {});
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * Record an event. Returns at once; events are sent in batches in the background.
   * Throws only for an invalid call, never for a delivery failure (see `onError`).
   */
  track(type: string, properties: EventProperties = {}): void {
    this.enqueue(this.event(type, properties, this.scopeSource?.()));
  }

  private enqueue(event: WireEvent): void {
    this.queue.push(event);
    this.trim();

    if (this.queue.length >= this.flushAt) void this.flush();
    else this.schedule();
  }

  /**
   * The same calls, with the context of one request held directly and not looked up. Used by
   * `@finic-ai/kairos/middleware`. `auto` sends the event of a route, and says whether it did: the
   * event is left out when the request has no one to be about, or when the handler tracked
   * that type itself. `autoDecide` does the same for a route that decides, and gives no
   * decision for a request with no one to be about.
   */
  bind(scope: Scope): RequestClient & {
    auto(type: string, properties: () => EventProperties): boolean;
    autoDecide(
      type: string,
      properties: () => EventProperties,
      options: Omit<DecideOptions, "timestamp"> & { fallback: Action },
    ): Promise<Decision | undefined>;
  } {
    const eventOf = (type: string, properties: () => EventProperties): WireEvent | undefined => {
      try {
        return this.event(type, properties(), scope);
      } catch (cause) {
        if (!(cause instanceof NoEntityError)) this.report(cause);
        return undefined;
      }
    };
    return {
      track: (type, properties = {}) => this.enqueue(this.event(type, properties, scope)),
      trackAndDecide: async (type, properties = {}, options = {}) =>
        this.eventDecision(this.event(type, properties, scope), options),
      decide: (input, options = {}) => this.decision(input, options, scope),
      auto: (type, properties) => {
        if (scope.tracked.has(type)) return false;
        const event = eventOf(type, properties);
        if (event) this.enqueue(event);
        return !!event;
      },
      autoDecide: async (type, properties, options) => {
        const event = eventOf(type, properties);
        return event && this.eventDecision(event, options);
      },
    };
  }

  /**
   * Who a call is about: the entities it names, and what the request adds. What the call
   * names wins. `$session: null` is no session; left out, it is the session of the request.
   */
  private acting(
    scope: Scope | undefined,
    named: Record<string, string>,
    $session: unknown,
  ): { entities: Record<string, string>; session: { session?: string }; about: string[] } {
    const own = { entities: named, session: session($session), about: Object.keys(named) };
    if (!scope) return own;
    let entities: Record<string, string>;
    let visit: { session?: string };
    try {
      const values = scope.resolve();
      entities = scopeEntities(values);
      visit = session(values.session);
    } catch (cause) {
      // A resolver that fails must not fail the request. The call goes on with what it names.
      this.report(cause);
      return own;
    }
    // A call about someone else, such as a support agent changing a customer's account, takes
    // nothing from the request: the agent's device is not the customer's.
    const who = entities[scope.subject];
    if (who !== undefined && named[scope.subject] !== undefined && named[scope.subject] !== who) return own;
    const merged = { ...entities, ...named };
    return {
      entities: merged,
      session: $session === undefined ? visit : own.session,
      about: own.about.length > 0 ? own.about : scope.subject in merged ? [scope.subject] : Object.keys(merged),
    };
  }

  private noEntity(what: string): NoEntityError {
    const outside = this.scopeSource
      ? " The Kairos middleware is installed, but this call did not run inside one of its requests, or the request has no identity yet."
      : "";
    return new NoEntityError(`${what} names no entity. Add a property such as userId, or pass entities.${outside}`);
  }

  /** Check an event and put it in the form the API takes. */
  private event(type: string, properties: EventProperties, scope: Scope | undefined): WireEvent {
    if (this.closed) throw new KairosError("An event was sent after shutdown()");
    if (!type) throw new KairosError("An event needs a type");
    const { timestamp, eventId, universalId, status, $set, $set_once, $session, ...rest } = properties;
    // A status that is not text is an ordinary property.
    const body = split(typeof status === "string" || status === undefined ? rest : { ...rest, status });
    const who = this.acting(scope, body.entities, $session);
    if (Object.keys(who.entities).length === 0) throw this.noEntity(`Event "${type}"`);
    const event = {
      id: eventId ?? newId(),
      type,
      ts: (timestamp instanceof Date ? timestamp : new Date(timestamp ?? Date.now())).toISOString(),
      entities: who.entities,
      properties: body.properties,
      ...(universalId ? { universal_id: String(universalId) } : {}),
      ...(typeof status === "string" && status ? { status } : {}),
      ...who.session,
      ...optional("set", bySubject("$set", $set, who.entities, who.about, type)),
      ...optional("set_once", bySubject("$set_once", $set_once, who.entities, who.about, type)),
    };
    scope?.tracked.add(type);
    return event;
  }

  /**
   * Record an event and get the decision it starts, in one call. The event type must be the
   * `trigger` of an action. Unlike `track`, this waits for the answer.
   *
   * Use it for the event that is the request itself: "withdrawal_requested",
   * "application_submitted". The event is stored, so later decisions see it, and it is the
   * pending action of this decision, so the two cannot disagree.
   */
  async trackAndDecide(
    type: string,
    properties: EventProperties = {},
    options: Omit<DecideOptions, "timestamp"> = {},
  ): Promise<Decision> {
    return this.eventDecision(this.event(type, properties, this.scopeSource?.()), options);
  }

  private async eventDecision(event: WireEvent, options: Omit<DecideOptions, "timestamp">): Promise<Decision> {
    const timeoutMs = options.timeoutMs ?? this.decideTimeoutMs;
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      if (options.flush !== false) await this.raceAbort(this.flush(), signal, timeoutMs);
      return this.toDecision(await this.request("POST", "/v1/events/decide", event, signal, timeoutMs));
    } catch (cause) {
      const error = cause instanceof Error ? cause : new KairosError(String(cause));
      // The request may not have arrived. Queue the event so the history keeps it; the id
      // makes that safe if it did arrive. A rejected event is not sent again.
      if (!(error instanceof KairosApiError) || RETRYABLE.has(error.status)) {
        this.queue.push(event);
        this.trim();
        this.schedule();
      }
      if (!options.fallback) throw error;
      return {
        decision: options.fallback,
        riskScore: 0,
        probability: 0,
        reasons: [],
        rules: [],
        eventId: event.id,
        fallback: true,
        error,
      };
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toDecision(body: any): Decision {
    return {
      decision: body.decision,
      riskScore: body.risk_score,
      probability: body.probability ?? body.risk_score / 100,
      reasons: body.reasons ?? [],
      ...(body.typology ? { typology: body.typology } : {}),
      rules: body.rules ?? [],
      ...(body.action ? { action: body.action } : {}),
      ...(body.decision_id ? { decisionId: body.decision_id } : {}),
      ...(body.event_id ? { eventId: body.event_id } : {}),
      fallback: false,
    };
  }

  /** Send every queued event and wait for the result. Delivery failures go to `onError`. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    // One upload at a time, so that events arrive in the order they were tracked.
    this.flushing = this.flushing.then(() => this.drain());
    return this.flushing;
  }

  /**
   * Ask for a decision on a pending action. Queued events are sent first, so the
   * decision sees everything tracked before this call.
   */
  async decide(input: DecideInput, options: DecideOptions = {}): Promise<Decision> {
    return this.decision(input, options, this.scopeSource?.());
  }

  private async decision(input: DecideInput, options: DecideOptions, scope: Scope | undefined): Promise<Decision> {
    const { type, $session, ...rest } = input;
    if (!type) throw new KairosError("A decision needs a type: the name of a defined action");
    const body = split(rest);
    const who = this.acting(scope, body.entities, $session);
    if (Object.keys(who.entities).length === 0) throw this.noEntity(`Decision "${type}"`);
    const request = {
      action: type,
      entities: who.entities,
      properties: body.properties,
      ...who.session,
      ...(options.timestamp ? { ts: new Date(options.timestamp).toISOString() } : {}),
    };
    const timeoutMs = options.timeoutMs ?? this.decideTimeoutMs;
    const signal = AbortSignal.timeout(timeoutMs);

    try {
      if (options.flush !== false) await this.raceAbort(this.flush(), signal, timeoutMs);
      return this.toDecision(await this.request("POST", "/v1/decide", request, signal, timeoutMs));
    } catch (cause) {
      const error = cause instanceof Error ? cause : new KairosError(String(cause));
      if (!options.fallback) throw error;
      return {
        decision: options.fallback,
        riskScore: 0,
        probability: 0,
        reasons: [],
        rules: [],
        fallback: true,
        error,
      };
    }
  }

  /**
   * Define or change an action. A change to the definition is stored as a new version;
   * sending the same definition again changes nothing, so this is safe to call at startup.
   */
  async defineAction(
    name: string,
    definition: ActionDefinition,
  ): Promise<ActionDefinition & { name: string; version: number }> {
    return this.request(
      "PUT",
      `/v1/actions/${encodeURIComponent(name)}`,
      definition,
      AbortSignal.timeout(this.timeoutMs),
      this.timeoutMs,
    );
  }

  /**
   * Define or change an entity type: what it means, which properties it carries, and
   * whether sharing one links two subjects. Optional, and safe to call at startup.
   */
  async defineEntity(type: string, definition: EntityDefinition = {}): Promise<EntityDefinition & { type: string }> {
    return this.request(
      "PUT",
      `/v1/entity-types/${encodeURIComponent(type)}`,
      definition,
      AbortSignal.timeout(this.timeoutMs),
      this.timeoutMs,
    );
  }

  /**
   * Create an entity, or update what is known about it. Properties are merged into what
   * is stored. An entity also comes into being when an event names it; use this when you
   * know something about it before, or apart from, any event.
   */
  async entity(type: string, id: string, properties: Record<string, unknown> = {}): Promise<void> {
    await this.setObject(type, id, properties);
  }

  /**
   * Store properties on an entity: the mechanism behind `entity()`. An entity's
   * properties are kept as an object, keyed by its type and id.
   */
  async setObject(type: string, id: string, properties: Record<string, unknown>): Promise<void> {
    await this.request(
      "PUT",
      "/v1/objects",
      { batch: [{ type, id, properties }] },
      AbortSignal.timeout(this.timeoutMs),
      this.timeoutMs,
    );
  }

  /**
   * Start a run of a workflow, with the inputs of its manual trigger. With `wait`, the answer
   * comes when the run ends, with its `output`; when the time is up first, the run goes on in the
   * background, and its `status` says so.
   */
  async runWorkflow(
    name: string,
    input: Record<string, unknown> = {},
    options: RunWorkflowOptions = {},
  ): Promise<WorkflowRun> {
    const body = {
      input,
      idempotency_key: options.idempotencyKey ?? newId(),
      ...(options.wait
        ? { wait: true, ...(options.timeoutSeconds !== undefined ? { timeout_seconds: options.timeoutSeconds } : {}) }
        : {}),
    };
    // The server answers once its own time is up: wait for that, and a margin.
    const timeoutMs = options.wait ? (options.timeoutSeconds ?? 10) * 1000 + 5_000 : this.timeoutMs;
    return this.request(
      "POST",
      `/v1/workflows/${encodeURIComponent(name)}/runs`,
      body,
      AbortSignal.timeout(timeoutMs),
      timeoutMs,
    );
  }

  /**
   * Record an outcome or a verdict on an entity, for example "fraud_confirmed".
   * `timestamp` is when the outcome became known; it defaults to now. A decision made
   * as of an earlier moment does not see a label from after that moment.
   */
  async label(
    entity: { type: string; id: string },
    label: string,
    properties: Record<string, unknown> = {},
    options: { timestamp?: Date | string } = {},
  ): Promise<void> {
    const ts = options.timestamp ? { ts: new Date(options.timestamp).toISOString() } : {};
    await this.request(
      "POST",
      "/v1/labels",
      { batch: [{ entity, label, properties, ...ts }] },
      AbortSignal.timeout(this.timeoutMs),
      this.timeoutMs,
    );
  }

  /**
   * A person's decision on a decision, for example after a manual review: approve or block.
   * The model's decision stays on record; `final_outcome` and the revision change, and
   * webhooks that want `decision.updated` are told. `by` says who decided.
   */
  async resolve(
    decisionId: string,
    outcome: "approve" | "block",
    options: { note?: string; by?: string } = {},
  ): Promise<{
    id: string;
    revision: number;
    final_outcome: string;
    resolution: { outcome: "approve" | "block"; note?: string; by: string; at: string };
  }> {
    return this.request(
      "POST",
      `/v1/decisions/${encodeURIComponent(decisionId)}/resolution`,
      { outcome, ...options },
      AbortSignal.timeout(this.timeoutMs),
      this.timeoutMs,
    );
  }

  /**
   * The client settings of the key's environment: the pages, screens and routes that the clients
   * collect, as set in Settings › Integrations. Needs a secret key.
   */
  async clientSettings(): Promise<ClientSettings> {
    return this.request("GET", "/v1/client-settings", undefined, AbortSignal.timeout(this.timeoutMs), this.timeoutMs);
  }

  /** Give an error to `onError`. Used by `@finic-ai/kairos/middleware`. */
  report(cause: unknown): void {
    this.onError(cause instanceof Error ? cause : new KairosError(String(cause)));
  }

  /** Send what is queued and stop the timer. Call before the process exits. */
  async shutdown(): Promise<void> {
    this.closed = true;
    await this.flush();
  }

  private schedule(): void {
    if (this.timer || this.flushIntervalMs <= 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.flushIntervalMs);
    // Do not keep a Node process alive only for the flush timer.
    (this.timer as { unref?: () => void }).unref?.();
  }

  private trim(): void {
    const overflow = this.queue.length - this.maxQueueSize;
    if (overflow <= 0) return;
    this.queue.splice(0, overflow);
    this.onError(new KairosError(`Event queue is full; dropped the ${overflow} oldest events`));
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, MAX_BATCH);
      try {
        await this.request("POST", "/v1/events", { batch }, AbortSignal.timeout(this.timeoutMs), this.timeoutMs);
      } catch (cause) {
        const error = cause instanceof Error ? cause : new KairosError(String(cause));
        // A rejected batch will be rejected again, so drop it. Keep the rest for the next flush.
        if (!(error instanceof KairosApiError) || RETRYABLE.has(error.status)) {
          this.queue.unshift(...batch);
          this.trim();
        }
        this.onError(error);
        return;
      }
    }
  }

  private async raceAbort<T>(work: Promise<T>, signal: AbortSignal, timeoutMs: number): Promise<T> {
    let onAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new KairosTimeoutError(timeoutMs));
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([work, aborted]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async request(
    method: "GET" | "POST" | "PUT",
    path: string,
    body: unknown,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<any> {
    let last: Error = new KairosError("Request failed");
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await sleep(Math.min(200 * 2 ** (attempt - 1), 5000) * (0.5 + Math.random() / 2), signal);
      if (signal.aborted) throw new KairosTimeoutError(timeoutMs);
      try {
        const response = await this.doFetch(this.baseUrl + path, {
          method,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            ...(method === "GET" ? {} : { "Content-Type": "application/json" }),
          },
          ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
          signal,
        });
        if (response.ok) return response.status === 204 ? {} : await response.json();
        last = new KairosApiError(
          response.status,
          (await response.text().catch(() => "")).slice(0, 500),
          response.headers.get("x-request-id") ?? undefined,
        );
        if (!RETRYABLE.has(response.status)) throw last;
      } catch (cause) {
        if (cause instanceof KairosApiError && !RETRYABLE.has(cause.status)) throw cause;
        if (signal.aborted) throw new KairosTimeoutError(timeoutMs);
        last = cause instanceof KairosError ? cause : new KairosError("Network request failed", { cause });
      }
    }
    throw last;
  }
}
