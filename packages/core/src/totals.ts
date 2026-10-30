import type { KairosEvent } from "./types";

/**
 * A sum over the subject's events that an action asks for: the money in during the last
 * seven days, for example. The server calculates it over the stored events and gives the
 * model the result, with the comparison already made.
 *
 * Tested in section 5.9 of the technical design. A model reads one number well and compares
 * two numbers badly, so a total that matters as a comparison is declared with `usual` or
 * `covers`, and the comparison is done here.
 */
export interface TotalDefinition {
  /** The name of the total in the context. The model reads it: "money_in", not "t1". */
  name: string;
  event: string;
  /** The numeric property to add up. An event without it, or with a value that is not a number, is not counted. */
  sum: string;
  /** Conditions on the event's properties, and on its `status`. A list matches any of its values. */
  where?: Record<string, Scalar | Scalar[]>;
  /**
   * How far back from the decision: "30m", "24h", "7d". Without it, all history. "session" is
   * the session of the request: the events sent with the same `$session`. A request with no
   * session has no such total, and a policy rule on it does not fire.
   */
  window?: string;
  /**
   * A longer period, for example "90d". The total is compared with what a window of the same
   * length usually held in that period before it: "34.2 times". Needs `window`.
   */
  usual?: string;
  /**
   * A property of the action being decided, for example "amount". The context says what share
   * of that amount the total covers, from 0 to 1.
   */
  covers?: string;
  /** A property to split the sum by, for example "currency". The eight largest are reported. */
  by?: string;
}
type Scalar = string | number | boolean;

export const MAX_TOTALS = 8;
const MAX_GROUPS = 8;
const MAX_WINDOW = 400 * 86_400_000;
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const UNIT = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** The window of a total that reads the events of the request's session, however long it is. */
export const SESSION_WINDOW = "session";

/** "30m", "24h", "7d" in milliseconds, or null. */
export function parseWindow(text: unknown): number | null {
  const match = typeof text === "string" ? /^(\d{1,4})([mhd])$/.exec(text) : null;
  if (!match) return null;
  const ms = Number(match[1]) * UNIT[match[2] as keyof typeof UNIT];
  return ms > 0 && ms <= MAX_WINDOW ? ms : null;
}

export function validateTotals(totals: unknown): string[] {
  if (totals === undefined) return [];
  if (!Array.isArray(totals)) return ["context.totals must be a list"];
  const problems: string[] = [];
  if (totals.length > MAX_TOTALS) problems.push(`context.totals: at most ${MAX_TOTALS} totals`);
  const names = new Set<string>();
  for (const [i, t] of (totals as Partial<TotalDefinition>[]).entries()) {
    const at = `context.totals[${i}]`;
    if (!t || typeof t !== "object") {
      problems.push(`${at} must be an object`);
      continue;
    }
    if (!NAME.test(t.name ?? "")) problems.push(`${at}.name must be a name such as "money_in"`);
    else if (names.has(t.name!)) problems.push(`${at}.name: "${t.name}" is used twice`);
    names.add(t.name ?? "");
    if (typeof t.event !== "string" || !t.event.trim() || t.event.length > 128)
      problems.push(`${at}.event must be an event type`);
    if (typeof t.sum !== "string" || !t.sum.trim() || t.sum.length > 128)
      problems.push(`${at}.sum must be the name of a numeric property`);
    if (t.window !== undefined && t.window !== SESSION_WINDOW && parseWindow(t.window) === null)
      problems.push(`${at}.window must be like "30m", "24h" or "7d", and at most 400 days, or "session"`);
    if (t.usual !== undefined) {
      const usual = parseWindow(t.usual);
      const window = parseWindow(t.window);
      if (t.window === SESSION_WINDOW)
        problems.push(`${at}.usual cannot be used with the session window: sessions have no usual length`);
      else if (usual === null) problems.push(`${at}.usual must be like "90d"`);
      else if (window === null) problems.push(`${at}.usual needs a window to compare`);
      else if (usual < window * 2) problems.push(`${at}.usual must be at least two times the window`);
    }
    if (t.covers !== undefined && (typeof t.covers !== "string" || !t.covers.trim()))
      problems.push(`${at}.covers must be the name of a property of the action`);
    if (t.by !== undefined && (typeof t.by !== "string" || !t.by.trim()))
      problems.push(`${at}.by must be the name of a property`);
    if (t.by !== undefined && (t.usual !== undefined || t.covers !== undefined))
      problems.push(`${at}: by cannot be used with usual or covers`);
    if (t.where !== undefined) {
      if (!t.where || typeof t.where !== "object" || Array.isArray(t.where))
        problems.push(`${at}.where must be an object of property conditions`);
      else {
        for (const [key, value] of Object.entries(t.where)) {
          const values = Array.isArray(value) ? value : [value];
          if (values.length === 0 || values.some((v) => !["string", "number", "boolean"].includes(typeof v)))
            problems.push(`${at}.where.${key} must be a value or a list of values`);
        }
      }
    }
  }
  return problems;
}

/** How far back the totals of an action read, in milliseconds. Null means all history. */
export function totalsReach(totals: TotalDefinition[]): number | null {
  let reach = 0;
  for (const t of totals) {
    // The events of a session are read by its id, not by a period.
    if (t.window === SESSION_WINDOW) continue;
    const window = parseWindow(t.window);
    if (window === null) return null;
    reach = Math.max(reach, parseWindow(t.usual) ?? window);
  }
  return reach;
}

/** An event time with no zone is UTC. */
const toMs = (ts: string) =>
  Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? ts : ts.length === 16 ? `${ts}:00Z` : `${ts}Z`);
const round = (n: number) => Math.round(n * 100) / 100;
const numberOf = (value: unknown) => {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
};

function matches(event: KairosEvent, t: TotalDefinition): boolean {
  if (event.type !== t.event) return false;
  for (const [key, value] of Object.entries(t.where ?? {})) {
    const wanted = (Array.isArray(value) ? value : [value]).map(String);
    if (!wanted.includes(String(event[key]))) return false;
  }
  return true;
}

/** A total as numbers, for a policy rule to compare. */
export interface TotalValue {
  sum: number;
  events: number;
  /** How many times the usual amount. Infinity when there was money now and none before. Only with `usual`. */
  times_usual?: number;
  /** The share of the action's amount the total covers, 0 to 1. Null when the request has no such amount. Only with `covers`. */
  share_covered?: number | null;
}
export type TotalValues = Record<string, TotalValue>;

/** The context block the model reads. See `evaluateTotals`. */
export function computeTotals(
  definitions: TotalDefinition[],
  events: KairosEvent[],
  pendingAction: Record<string, unknown>,
  now: number,
  sessionEvents?: KairosEvent[],
): Record<string, unknown> {
  return evaluateTotals(definitions, events, pendingAction, now, sessionEvents).context;
}

/**
 * Calculate the totals of an action: the block the model reads, and the same facts as
 * numbers for the policy rules. `events` are the subject's events as the model would see
 * them: records folded to their latest status, and the action being decided left out.
 * `sessionEvents` are the events of the request's session, in the same form, for the totals
 * with the window "session". Without them, those totals are not calculated.
 */
export function evaluateTotals(
  definitions: TotalDefinition[],
  events: KairosEvent[],
  pendingAction: Record<string, unknown>,
  now: number,
  sessionEvents?: KairosEvent[],
): { context: Record<string, unknown>; values: TotalValues } {
  const out: Record<string, unknown> = {};
  const values: TotalValues = {};
  for (const t of definitions) {
    const inSession = t.window === SESSION_WINDOW;
    if (inSession && !sessionEvents) continue;
    const source = inSession ? sessionEvents! : events;
    const window = inSession ? null : parseWindow(t.window);
    const from = window === null ? -Infinity : now - window;
    const sumBetween = (start: number, end: number) => {
      let sum = 0;
      let count = 0;
      const groups = new Map<string, number>();
      for (const e of source) {
        if (!matches(e, t)) continue;
        const at = toMs(e.ts);
        const amount = numberOf(e[t.sum]);
        if (amount === null || !(at > start && at <= end)) continue;
        sum += amount;
        count += 1;
        if (t.by) groups.set(String(e[t.by] ?? "(none)"), (groups.get(String(e[t.by] ?? "(none)")) ?? 0) + amount);
      }
      return { sum, count, groups };
    };

    const label = inSession ? `${t.name}_this_session` : t.window ? `${t.name}_last_${t.window}` : `${t.name}_all_time`;
    const current = sumBetween(from, now);
    const entry: Record<string, unknown> = { sum: round(current.sum), events: current.count };
    if (t.by) {
      const ranked = [...current.groups].sort((a, b) => b[1] - a[1]);
      entry[`by_${t.by}`] = Object.fromEntries(ranked.slice(0, MAX_GROUPS).map(([key, sum]) => [key, round(sum)]));
      if (ranked.length > MAX_GROUPS) entry.other_values = ranked.length - MAX_GROUPS;
    }
    out[label] = entry;
    const value: TotalValue = { sum: round(current.sum), events: current.count };
    values[t.name] = value;

    const usual = parseWindow(t.usual);
    if (usual !== null && window !== null) {
      // What one window usually held, over the period before this window.
      const before = sumBetween(now - usual, from);
      const perWindow = before.sum / ((usual - window) / window);
      out[`${label}_against_a_usual_${t.window}`] =
        perWindow > 0
          ? `${Math.round((10 * current.sum) / perWindow) / 10} times`
          : current.sum > 0
            ? `no earlier ${t.name}`
            : "none";
      value.times_usual =
        perWindow > 0 ? Math.round((10 * current.sum) / perWindow) / 10 : current.sum > 0 ? Infinity : 0;
    }
    if (t.covers) {
      const amount = numberOf(pendingAction[t.covers]);
      out[`share_of_this_action_that_${label}_covers`] =
        amount !== null && amount > 0 ? Math.min(1, Math.round((100 * current.sum) / amount) / 100) : null;
      value.share_covered =
        amount !== null && amount > 0 ? Math.min(1, Math.round((100 * current.sum) / amount) / 100) : null;
    }
  }
  return { context: out, values };
}
