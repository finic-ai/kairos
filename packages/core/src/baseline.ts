import type { Baseline, EventTypeProfile, FieldProfile, KairosEvent } from "./types";

export interface BaselineOptions {
  /** An event type with this many events or fewer is kept in full, not summarised. Default 3. */
  rareTypeMaxCount?: number;
  /** Most recent rare and free-text events to keep in full. Default 10. */
  maxVerbatim?: number;
  /** A text field with more distinct values than this is reported as a count. Default 8. */
  maxDistinctValues?: number;
  /** A string longer than this is free text: its events are kept in full. Default 80. */
  freeTextLength?: number;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const m = s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  return Math.round(m * 100) / 100;
}

function tally(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

/** Returns "text" for free text, null for nothing useful. */
function profileField(values: unknown[], o: Required<BaselineOptions>): FieldProfile | "text" | null {
  const present = values.filter((v) => v !== undefined && v !== null);
  if (present.length === 0) return null;
  if (present.every((v) => typeof v === "number")) {
    const numbers = present as number[];
    return { median: median(numbers), max: Math.max(...numbers) };
  }
  if (!present.every((v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")) return null;
  const strings = present.map(String);
  if (strings.some((s) => s.length > o.freeTextLength)) return "text";
  const counts = tally(strings);
  const distinct = Object.keys(counts).length;
  if (distinct <= o.maxDistinctValues) return { values: counts };
  const common = Object.entries(counts)
    .filter(([, n]) => n > 1)
    .slice(0, 3);
  return common.length ? { distinct, most_common: Object.fromEntries(common) } : { distinct };
}

/**
 * Summarise older events as statistics, for any event types and fields.
 *
 * Frequent event types become a count plus a profile of each field: median and max for
 * numbers, value counts for text. Rare event types and events with free text are kept in
 * full, because they carry most of the signal. Returns null when there are no events.
 */
export function buildBaseline(events: KairosEvent[], options: BaselineOptions = {}): Baseline | null {
  if (events.length === 0) return null;
  const o: Required<BaselineOptions> = {
    rareTypeMaxCount: options.rareTypeMaxCount ?? 3,
    maxVerbatim: options.maxVerbatim ?? 10,
    maxDistinctValues: options.maxDistinctValues ?? 8,
    freeTextLength: options.freeTextLength ?? 80,
  };

  const byType = new Map<string, KairosEvent[]>();
  for (const e of events) byType.set(e.type, [...(byType.get(e.type) ?? []), e]);

  const eventTypes: Record<string, EventTypeProfile> = {};
  const verbatimTypes = new Set<string>();
  for (const [type, list] of [...byType].sort((a, b) => b[1].length - a[1].length)) {
    const profile: EventTypeProfile = { count: list.length, last: list[list.length - 1]!.ts };
    if (list.length <= o.rareTypeMaxCount) {
      verbatimTypes.add(type);
    } else {
      const fields: Record<string, FieldProfile> = {};
      const keys = new Set(list.flatMap((e) => Object.keys(e)).filter((k) => k !== "ts" && k !== "type"));
      for (const key of keys) {
        const p = profileField(
          list.map((e) => e[key]),
          o,
        );
        if (p === "text") verbatimTypes.add(type);
        else if (p) fields[key] = p;
      }
      if (Object.keys(fields).length) profile.fields = fields;
    }
    eventTypes[type] = profile;
  }

  const hourBands: Record<string, number> = {};
  for (const e of events) {
    const hour = Number(e.ts.slice(11, 13));
    if (e.ts.length < 13 || Number.isNaN(hour)) continue;
    const band = Math.floor(hour / 6) * 6;
    const key = `${String(band).padStart(2, "0")}-${String(band + 6).padStart(2, "0")}h`;
    hourBands[key] = (hourBands[key] ?? 0) + 1;
  }

  return {
    period: [events[0]!.ts, events[events.length - 1]!.ts],
    events: events.length,
    activity_by_hour_band: Object.fromEntries(Object.entries(hourBands).sort()),
    event_types: eventTypes,
    rare_events: events.filter((e) => verbatimTypes.has(e.type)).slice(-o.maxVerbatim),
  };
}
