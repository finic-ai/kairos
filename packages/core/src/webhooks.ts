/**
 * Inbound webhooks: how a provider's JSON payload becomes Kairos events and labels.
 *
 * A mapping is data, not code: a list of rules, each with paths into the payload, constants and
 * a few fixed transforms. The engine is a pure function, so the server and the console's live
 * preview run the same code and cannot differ. See internal/designs/inbound-webhooks.md, section 7.
 */

export interface PathValue {
  path: string;
  /**
   * For a time: iso (default; a time with no zone is UTC), unix_seconds, unix_ms. number: a decimal that the
   * provider sends as text.
   */
  format?: "iso" | "unix_seconds" | "unix_ms" | "number";
  /** The value found → the value stored. A value not in the table is kept, unless `default` is set. */
  values?: Record<string, string | number | boolean>;
  /** When the path finds nothing, or finds a value that is not in `values`. */
  default?: string | number | boolean;
  /** Read the path in the request headers (lower-case names), not in the body. */
  headers?: boolean;
}

/** Values joined as text, for a provider with no single id. A part with no value gives no value. */
export interface JoinValue {
  join: (string | number | boolean | PathValue)[];
  /** Default ":". */
  with?: string;
}

/** A value: a path ("$.data.id", or "$$.id" inside `items`), a constant, a path with a transform, or a join. */
export type MappingValue = string | number | boolean | PathValue | JoinValue;

/**
 * An entity found from what Kairos already knows, for a provider that does not send your id.
 * `lookup`: the entity of this type whose property equals a value, such as the user whose
 * stripe_customer_id is the payment's customer. `record`: the entity of this type on the earlier
 * events of a record, such as the user of the payment that a dispute is about.
 */
export type EntityValue =
  MappingValue | { lookup: { property: string; value: MappingValue } } | { record: MappingValue };

/** A lookup that the engine cannot do (it has no data), for the server to do. */
export type Lookup = { by: "property"; property: string; value: string } | { by: "record"; record: string };

export interface MappingEvent {
  /** The provider's id for this event. With the source's id, it makes a retry safe. */
  id: MappingValue;
  type: MappingValue;
  /** Default: when the delivery arrived. */
  ts?: MappingValue;
  /** Entity type → value, or a lookup. An entity with no value is left out. */
  entities: Record<string, EntityValue>;
  /** Name → value, or every scalar field of one object, except some. */
  properties?: Record<string, MappingValue> | { all: string; except?: string[] };
  universal_id?: MappingValue;
  status?: MappingValue;
  session?: MappingValue;
  /** Entity type → (property → value). Only for a source whose sender is proven. */
  set?: Record<string, Record<string, MappingValue>>;
  set_once?: Record<string, Record<string, MappingValue>>;
}

export interface MappingLabel {
  /** An entity type of the rule's event, or, for a rule with no event, a type with `id`. */
  entity: string;
  /** The entity's id, when the rule has no event or the label is on another entity. A lookup too. */
  id?: EntityValue;
  label: MappingValue;
  properties?: Record<string, MappingValue>;
  /** When the outcome became known. Default: the event's time, or when the delivery arrived. */
  ts?: MappingValue;
}

export interface MappingRule {
  /** For people: "Payment", "Dispute". */
  name?: string;
  /** Path (without "$.") → a value or a list of values. All must hold. No `match`: every delivery. */
  match?: Record<string, string | number | boolean | (string | number | boolean)[]>;
  /** Header name → a value or a list of values, as `match`. For a provider that sends the event type in a header. */
  match_headers?: Record<string, string | number | boolean | (string | number | boolean)[]>;
  /** A path to an array: the rule runs once for each element, which is "$$". */
  items?: string;
  event?: MappingEvent;
  label?: MappingLabel;
}

export interface WebhookMapping {
  rules: MappingRule[];
  /** When no rule matches. "ignore" (default): the delivery is recorded as ignored. "fail": as failed. */
  unmatched?: "ignore" | "fail";
}

/** An event in the shape of POST /v1/events, before the server checks it. */
export interface MappedEvent {
  id: string;
  type: string;
  ts: string;
  entities: Record<string, string>;
  properties: Record<string, unknown>;
  universal_id?: string;
  status?: string;
  session?: string;
  set?: Record<string, Record<string, unknown>>;
  set_once?: Record<string, Record<string, unknown>>;
  /** Entities still to find: type → how. The server finds them before it stores the event. */
  lookups?: Record<string, Lookup>;
}

export interface MappedLabel {
  /** `id` is absent while `lookup` is still to be done. */
  entity: { type: string; id?: string };
  lookup?: Lookup;
  label: string;
  ts: string;
  properties: Record<string, unknown>;
}

export interface MappingResult {
  /**
   * mapped: at least one rule matched and every one that matched worked. ignored: no rule
   * matched. failed: a rule that matched could not produce what it must. no_entity: a rule
   * matched, and its event names no entity with a value.
   */
  outcome: "mapped" | "ignored" | "failed" | "no_entity";
  events: MappedEvent[];
  labels: MappedLabel[];
  /** Why it failed, for the delivery log. Empty when it did not. */
  problems: string[];
  /** The names (or numbers) of the rules that matched. */
  matched: string[];
}

export const MAPPING_LIMITS = { rules: 50, items: 500, events: 500 } as const;

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const HEADER = /^[A-Za-z0-9-]{1,64}$/;
const FORMATS = new Set(["iso", "unix_seconds", "unix_ms", "number"]);
const DECIMAL = /^-?\d+(\.\d+)?$/;
/** "2026-04-30 08:04:23.379": a date and a time with no zone, which JavaScript would read in the local zone. */
const ZONELESS = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

type Step = string | number;

/**
 * "$.data.object['a name'][0]" → { root: "$", steps: ["data", "object", "a name", 0] }. Only
 * names, quoted names and array positions ([-1] is the last): no wildcards, no filters, nothing
 * that can be slow.
 */
export function parsePath(path: string): { root: "$" | "$$"; steps: Step[] } | null {
  const root = path.startsWith("$$") ? "$$" : path.startsWith("$") ? "$" : null;
  if (!root) return null;
  const steps: Step[] = [];
  let rest = path.slice(root.length);
  while (rest.length) {
    let m: RegExpExecArray | null;
    if ((m = /^\.([^.[\]]+)/.exec(rest))) steps.push(m[1]!);
    else if ((m = /^\[(-?\d+)\]/.exec(rest))) steps.push(Number(m[1]));
    else if ((m = /^\[(["'])((?:(?!\1).)*)\1\]/.exec(rest))) steps.push(m[2]!);
    else return null;
    rest = rest.slice(m[0].length);
  }
  return { root, steps };
}

export function readPath(root: unknown, steps: Step[]): unknown {
  let at = root;
  for (const step of steps) {
    if (at === null || typeof at !== "object") return undefined;
    if (typeof step === "number") {
      if (!Array.isArray(at)) return undefined;
      at = at[step < 0 ? at.length + step : step];
    } else {
      if (Array.isArray(at)) return undefined;
      at = (at as Record<string, unknown>)[step];
    }
  }
  return at;
}

const isPath = (value: unknown): value is string =>
  typeof value === "string" &&
  (value === "$" ||
    value === "$$" ||
    value.startsWith("$.") ||
    value.startsWith("$[") ||
    value.startsWith("$$.") ||
    value.startsWith("$$["));

interface Scope {
  body: unknown;
  headers: Record<string, string>;
  /** The element of `items`, when the rule has it. */
  item?: unknown;
}

function resolve(value: MappingValue | undefined, scope: Scope): unknown {
  if (value === undefined) return undefined;
  if (typeof value !== "object") {
    if (!isPath(value)) return value;
    const parsed = parsePath(value)!;
    return readPath(parsed.root === "$$" ? scope.item : scope.body, parsed.steps);
  }
  if ("join" in value) {
    const parts = value.join.map((part) => toText(resolve(part, scope)));
    return parts.every((p) => p !== undefined) ? parts.join(value.with ?? ":") : undefined;
  }
  const parsed = parsePath(value.path);
  if (!parsed) return undefined;
  const source = value.headers ? scope.headers : parsed.root === "$$" ? scope.item : scope.body;
  let found = readPath(
    source,
    value.headers ? parsed.steps.map((s) => (typeof s === "string" ? s.toLowerCase() : s)) : parsed.steps,
  );
  if (found !== undefined && found !== null && value.values) {
    const key = String(found);
    found = Object.prototype.hasOwnProperty.call(value.values, key) ? value.values[key] : (value.default ?? found);
  }
  if (found === undefined || found === null) found = value.default;
  if (value.format === "number") return toNumber(found);
  if (found !== undefined && value.format) return new Timed(value.format, found);
  return found;
}

/** "404.95" → 404.95. A value that is not a decimal gives no value. */
function toNumber(found: unknown): number | undefined {
  if (typeof found === "number") return Number.isFinite(found) ? found : undefined;
  return typeof found === "string" && DECIMAL.test(found.trim()) ? Number(found) : undefined;
}

/** A value with a time format still to apply. */
class Timed {
  constructor(
    readonly format: string,
    readonly value: unknown,
  ) {}
}

/** A time, as ISO 8601, or null when it cannot be read. */
function toTime(found: unknown): string | null {
  const format = found instanceof Timed ? found.format : "iso";
  const value = found instanceof Timed ? found.value : found;
  let ms: number;
  if (format === "unix_seconds" || format === "unix_ms") {
    const n =
      typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
    ms = format === "unix_seconds" ? n * 1000 : n;
  } else {
    ms = typeof value === "string" ? Date.parse(ZONELESS.test(value) ? `${value.replace(" ", "T")}Z` : value) : NaN;
  }
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** A value as text, for an id, a type or a status. Objects and arrays are not text. */
function toText(found: unknown): string | undefined {
  if (found instanceof Timed) found = found.value;
  if (typeof found === "string") return found.length ? found : undefined;
  if (typeof found === "number" || typeof found === "boolean") return String(found);
  return undefined;
}

/** A value to store as a property: a scalar, an array or an object, but never a time wrapper. */
function toValue(found: unknown): unknown {
  if (found instanceof Timed) return toTime(found) ?? undefined;
  return found;
}

const isLookup = (v: unknown): v is { lookup: { property: string; value: MappingValue } } | { record: MappingValue } =>
  !!v && typeof v === "object" && !Array.isArray(v) && ("lookup" in v || "record" in v);

/** An entity value: its id now, or a lookup for the server, or nothing. */
function entityOf(value: EntityValue | undefined, scope: Scope): { id?: string; lookup?: Lookup } {
  if (!isLookup(value)) return { id: toText(resolve(value, scope)) };
  if ("record" in value) {
    const record = toText(resolve(value.record, scope));
    return record ? { lookup: { by: "record", record } } : {};
  }
  const found = toText(resolve(value.lookup.value, scope));
  return found ? { lookup: { by: "property", property: value.lookup.property, value: found } } : {};
}

const isScalar = (v: unknown) => v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";

const isOneOf = (found: unknown, wanted: string | number | boolean | (string | number | boolean)[]) =>
  found !== undefined &&
  found !== null &&
  typeof found !== "object" &&
  (Array.isArray(wanted) ? wanted : [wanted]).some((w) => String(w) === String(found));

function matches(rule: MappingRule, scope: Scope): boolean {
  for (const [key, wanted] of Object.entries(rule.match ?? {})) {
    const path = isPath(key) ? key : `$.${key}`;
    const parsed = parsePath(path);
    if (!parsed) return false;
    if (!isOneOf(readPath(parsed.root === "$$" ? scope.item : scope.body, parsed.steps), wanted)) return false;
  }
  for (const [name, wanted] of Object.entries(rule.match_headers ?? {}))
    if (!isOneOf(scope.headers[name.toLowerCase()], wanted)) return false;
  return true;
}

function record(spec: Record<string, MappingValue> | undefined, scope: Scope): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(spec ?? {})) {
    const found = toValue(resolve(value, scope));
    if (found !== undefined) out[name] = found;
  }
  return out;
}

function properties(spec: MappingEvent["properties"], scope: Scope): Record<string, unknown> {
  if (!spec) return {};
  if ("all" in spec && typeof spec.all === "string" && (spec.except === undefined || Array.isArray(spec.except))) {
    const parsed = parsePath(spec.all);
    const found = parsed ? readPath(parsed.root === "$$" ? scope.item : scope.body, parsed.steps) : undefined;
    if (!found || typeof found !== "object" || Array.isArray(found)) return {};
    const except = new Set((spec.except as string[] | undefined) ?? []);
    return Object.fromEntries(
      Object.entries(found as Record<string, unknown>).filter(([k, v]) => !except.has(k) && isScalar(v)),
    );
  }
  return record(spec as Record<string, MappingValue>, scope);
}

class RuleFailure extends Error {
  constructor(
    message: string,
    readonly noEntity = false,
  ) {
    super(message);
  }
}

function runRule(
  rule: MappingRule,
  label: string,
  scope: Scope,
  receivedAt: string,
): { event?: MappedEvent; label?: MappedLabel } {
  let event: MappedEvent | undefined;
  if (rule.event) {
    const e = rule.event;
    const id = toText(resolve(e.id, scope));
    if (!id) throw new RuleFailure(`${label}: event.id found no value`);
    const type = toText(resolve(e.type, scope));
    if (!type) throw new RuleFailure(`${label}: event.type found no value`);
    let ts = receivedAt;
    if (e.ts !== undefined) {
      const found = resolve(e.ts, scope);
      if (found !== undefined) {
        const time = toTime(found);
        if (!time)
          throw new RuleFailure(
            `${label}: event.ts is not a time it can read (${JSON.stringify(found instanceof Timed ? found.value : found)})`,
          );
        ts = time;
      }
    }
    const entities: Record<string, string> = {};
    const lookups: Record<string, Lookup> = {};
    for (const [type, value] of Object.entries(e.entities)) {
      const found = entityOf(value, scope);
      if (found.id) entities[type] = found.id;
      else if (found.lookup) lookups[type] = found.lookup;
    }
    if (Object.keys(entities).length === 0 && Object.keys(lookups).length === 0)
      throw new RuleFailure(
        `${label}: the event names no entity with a value (${Object.keys(e.entities).join(", ")})`,
        true,
      );
    event = {
      id,
      type,
      ts,
      entities,
      properties: properties(e.properties, scope),
      ...(Object.keys(lookups).length ? { lookups } : {}),
    };
    for (const field of ["universal_id", "status", "session"] as const) {
      const found = toText(resolve(e[field], scope));
      if (found) event[field] = found;
    }
    for (const field of ["set", "set_once"] as const) {
      if (!e[field]) continue;
      // Properties go only on entities that the event names, as with the SDK.
      const sets = Object.fromEntries(
        Object.entries(e[field]!)
          .filter(([type]) => type in entities || type in lookups)
          .map(([type, spec]) => [type, record(spec, scope)])
          .filter(([, values]) => Object.keys(values as object).length),
      );
      if (Object.keys(sets).length) event[field] = sets;
    }
  }

  let made: MappedLabel | undefined;
  if (rule.label) {
    const l = rule.label;
    const own =
      l.id !== undefined
        ? entityOf(l.id, scope)
        : { id: event?.entities[l.entity], lookup: event?.lookups?.[l.entity] };
    if (!own.id && !own.lookup) throw new RuleFailure(`${label}: the label's ${l.entity} has no id`, true);
    const name = toText(resolve(l.label, scope));
    if (!name || !NAME.test(name))
      throw new RuleFailure(`${label}: label must be a name such as "chargeback", not ${JSON.stringify(name ?? null)}`);
    let ts = event?.ts ?? receivedAt;
    if (l.ts !== undefined) {
      const found = resolve(l.ts, scope);
      if (found !== undefined) {
        const time = toTime(found);
        if (!time) throw new RuleFailure(`${label}: label.ts is not a time it can read`);
        ts = time;
      }
    }
    made = {
      entity: { type: l.entity, ...(own.id ? { id: own.id } : {}) },
      ...(own.id ? {} : { lookup: own.lookup }),
      label: name,
      ts,
      properties: record(l.properties, scope),
    };
  }
  return { event, label: made };
}

/**
 * Turn one delivery into events and labels. Pure: no I/O, and the same result in the server
 * and in the browser. A rule that matches and fails stops the whole delivery: nothing from it
 * is stored, so that a corrected mapping can run it again in full.
 */
export function applyMapping(
  mapping: WebhookMapping,
  delivery: { body: unknown; headers?: Record<string, string> },
  receivedAt: string,
): MappingResult {
  const headers = Object.fromEntries(Object.entries(delivery.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const result: MappingResult = { outcome: "ignored", events: [], labels: [], problems: [], matched: [] };
  let noEntity = false;
  mapping.rules.forEach((rule, index) => {
    if (result.problems.length) return;
    const label = rule.name ? `Rule "${rule.name}"` : `Rule ${index + 1}`;
    const base: Scope = { body: delivery.body, headers };
    let scopes: Scope[] = [base];
    if (rule.items) {
      const parsed = parsePath(rule.items);
      const found = parsed ? readPath(delivery.body, parsed.steps) : undefined;
      if (!Array.isArray(found)) {
        if (matches(rule, base)) result.problems.push(`${label}: items "${rule.items}" is not a list`);
        return;
      }
      if (found.length > MAPPING_LIMITS.items) {
        result.problems.push(`${label}: items has ${found.length} elements; at most ${MAPPING_LIMITS.items}`);
        return;
      }
      scopes = found.map((item) => ({ ...base, item }));
    }
    for (const scope of scopes) {
      if (!matches(rule, scope)) continue;
      if (!result.matched.includes(rule.name ?? String(index + 1))) result.matched.push(rule.name ?? String(index + 1));
      try {
        const made = runRule(rule, label, scope, receivedAt);
        if (made.event) result.events.push(made.event);
        if (made.label) result.labels.push(made.label);
      } catch (cause) {
        if (!(cause instanceof RuleFailure)) throw cause;
        result.problems.push(cause.message);
        noEntity = cause.noEntity;
        return;
      }
    }
  });

  if (result.problems.length) return { ...result, outcome: noEntity ? "no_entity" : "failed", events: [], labels: [] };
  if (result.events.length > MAPPING_LIMITS.events)
    return {
      ...result,
      outcome: "failed",
      events: [],
      labels: [],
      problems: [`The delivery gives ${result.events.length} events; at most ${MAPPING_LIMITS.events}`],
    };
  if (result.matched.length === 0) {
    return mapping.unmatched === "fail"
      ? { ...result, outcome: "failed", problems: ["No rule matched, and the mapping says unmatched: fail"] }
      : result;
  }
  return { ...result, outcome: "mapped" };
}

function valueProblems(value: unknown, where: string): string[] {
  if (value === undefined) return [];
  if (typeof value === "string")
    return value.startsWith("$") && !parsePath(value)
      ? [`${where}: "${value}" is not a path this engine reads. Use $.name, $["a name"] or $.list[0]`]
      : [];
  if (typeof value === "number" || typeof value === "boolean") return [];
  if (!value || typeof value !== "object" || Array.isArray(value))
    return [`${where}: must be a path, a constant, { path, … } or { join: […] }`];
  const v = value as Record<string, unknown>;
  const problems: string[] = [];
  if ("join" in v) {
    if (!Array.isArray(v.join) || v.join.length < 1 || v.join.length > 10)
      return [`${where}.join: a list of 1 to 10 values`];
    v.join.forEach((part, i) =>
      problems.push(
        ...(part && typeof part === "object" && "join" in part
          ? [`${where}.join[${i}]: a join cannot hold a join`]
          : valueProblems(part, `${where}.join[${i}]`)),
      ),
    );
    if (v.with !== undefined && (typeof v.with !== "string" || v.with.length > 4))
      problems.push(`${where}.with: text of at most 4 characters, such as :`);
    for (const key of Object.keys(v))
      if (key !== "join" && key !== "with") problems.push(`${where}: unknown key "${key}"`);
    return problems;
  }
  if (typeof v.path !== "string" || !parsePath(v.path))
    problems.push(`${where}.path: must be a path such as $.data.id`);
  if (v.format !== undefined && !FORMATS.has(v.format as string))
    problems.push(`${where}.format: must be iso, unix_seconds, unix_ms or number`);
  if (v.format === "number" && where.endsWith(".ts")) problems.push(`${where}.format: a time cannot be a number`);
  if (v.values !== undefined && (typeof v.values !== "object" || v.values === null || Array.isArray(v.values)))
    problems.push(`${where}.values: must be an object`);
  for (const key of Object.keys(v))
    if (!["path", "format", "values", "default", "headers"].includes(key))
      problems.push(`${where}: unknown key "${key}"`);
  return problems;
}

function entityProblems(value: unknown, where: string): string[] {
  if (!isLookup(value)) return valueProblems(value, where);
  if ("record" in value)
    return Object.keys(value).length === 1
      ? valueProblems(value.record, `${where}.record`)
      : [`${where}: a record lookup has only "record"`];
  const l = (value as { lookup: unknown }).lookup;
  if (!l || typeof l !== "object") return [`${where}.lookup: must be { property, value }`];
  const { property, value: found } = l as { property?: unknown; value?: unknown };
  const problems =
    typeof property === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(property)
      ? []
      : [`${where}.lookup.property: the name of a property, such as stripe_customer_id`];
  return found === undefined
    ? [...problems, `${where}.lookup.value: necessary`]
    : [...problems, ...valueProblems(found, `${where}.lookup.value`)];
}

/** What is wrong with a mapping, in words for a person. Empty: nothing. */
export function validateMapping(mapping: unknown, options: { allowSet?: boolean } = {}): string[] {
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping))
    return ["mapping: must be an object with rules"];
  const m = mapping as Partial<WebhookMapping>;
  if (!Array.isArray(m.rules) || m.rules.length === 0) return ["mapping.rules: must be a list with at least one rule"];
  const problems: string[] = [];
  if (m.rules.length > MAPPING_LIMITS.rules) problems.push(`mapping.rules: at most ${MAPPING_LIMITS.rules} rules`);
  if (m.unmatched !== undefined && m.unmatched !== "ignore" && m.unmatched !== "fail")
    problems.push(`mapping.unmatched: must be "ignore" or "fail"`);
  m.rules.forEach((rule, i) => {
    const at = `rules[${i}]`;
    if (!rule || typeof rule !== "object") return problems.push(`${at}: must be an object`);
    if (!rule.event && !rule.label) problems.push(`${at}: needs an event, a label, or both`);
    if (
      rule.items !== undefined &&
      (typeof rule.items !== "string" || !parsePath(rule.items) || rule.items.startsWith("$$"))
    )
      problems.push(`${at}.items: must be a path such as $.data.list`);
    for (const key of Object.keys(rule.match ?? {}))
      if (!parsePath(isPath(key) ? key : `$.${key}`)) problems.push(`${at}.match: "${key}" is not a path`);
    if (
      rule.match_headers !== undefined &&
      (typeof rule.match_headers !== "object" || Array.isArray(rule.match_headers))
    )
      problems.push(`${at}.match_headers: must be an object of header names`);
    else
      for (const name of Object.keys(rule.match_headers ?? {}))
        if (!HEADER.test(name)) problems.push(`${at}.match_headers: "${name}" is not a header name`);
    if (rule.event) {
      const e = rule.event;
      if (e.id === undefined) problems.push(`${at}.event.id: necessary, so that a retry stores nothing twice`);
      if (e.type === undefined) problems.push(`${at}.event.type: necessary`);
      if (!e.entities || typeof e.entities !== "object" || Object.keys(e.entities).length === 0)
        problems.push(`${at}.event.entities: name at least one entity`);
      for (const type of Object.keys(e.entities ?? {}))
        if (!NAME.test(type)) problems.push(`${at}.event.entities: "${type}" is not an entity type name`);
      for (const [key, value] of Object.entries({
        id: e.id,
        type: e.type,
        ts: e.ts,
        universal_id: e.universal_id,
        status: e.status,
        session: e.session,
      }))
        problems.push(...valueProblems(value, `${at}.event.${key}`));
      for (const [type, value] of Object.entries(e.entities ?? {}))
        problems.push(...entityProblems(value, `${at}.event.entities.${type}`));
      if (e.properties && "all" in e.properties) {
        if (typeof e.properties.all !== "string" || !parsePath(e.properties.all))
          problems.push(`${at}.event.properties.all: must be a path to an object`);
      } else
        for (const [name, value] of Object.entries(e.properties ?? {}))
          problems.push(...valueProblems(value, `${at}.event.properties.${name}`));
      for (const field of ["set", "set_once"] as const) {
        if (!e[field]) continue;
        if (!options.allowSet)
          problems.push(
            `${at}.event.${field}: only a source that verifies a signature (hmac, timestamped, stripe or standard) can set entity properties`,
          );
        for (const type of Object.keys(e[field]!))
          if (!(type in (e.entities ?? {})))
            problems.push(`${at}.event.${field}.${type}: the event names no "${type}" entity`);
      }
    }
    if (rule.label) {
      const l = rule.label;
      if (typeof l.entity !== "string" || !NAME.test(l.entity))
        problems.push(`${at}.label.entity: must be an entity type`);
      else if (l.id === undefined && !(rule.event && l.entity in (rule.event.entities ?? {})))
        problems.push(`${at}.label: the rule's event names no "${l.entity}"; give the label an id`);
      if (l.label === undefined) problems.push(`${at}.label.label: necessary`);
      else if (typeof l.label === "string" && !isPath(l.label) && !NAME.test(l.label))
        problems.push(`${at}.label.label: "${l.label}" must be a name such as chargeback`);
      problems.push(...entityProblems(l.id, `${at}.label.id`));
      for (const [key, value] of Object.entries({ label: l.label, ts: l.ts }))
        problems.push(...valueProblems(value, `${at}.label.${key}`));
      for (const [name, value] of Object.entries(l.properties ?? {}))
        problems.push(...valueProblems(value, `${at}.label.properties.${name}`));
    }
  });
  return problems;
}
