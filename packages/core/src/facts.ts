import type { CaseStatus } from "./intake";
import { parseWindow } from "./totals";
import type { Outcome } from "./types";

export const FACT_SOURCES = ["events", "decisions", "labels", "cases"] as const;
export const FACT_MEASURES = ["count", "sum", "avg", "unique", "first", "last"] as const;
export const FACT_FORMATS = ["number", "money", "percent"] as const;
export const LIST_SOURCES = ["events", "decisions", "linked", "cases"] as const;
export const COLUMN_FORMATS = ["text", "number", "money", "datetime", "date", "boolean", "country"] as const;
export const LIST_SORTS = ["newest", "oldest"] as const;

export const MAX_FACTS = 12;
export const MAX_LISTS = 6;
export const MAX_LIST_COLUMNS = 12;
export const ALL_TIME = "all";

export type FactSource = (typeof FACT_SOURCES)[number];
export type FactMeasure = (typeof FACT_MEASURES)[number];
export type FactFormat = (typeof FACT_FORMATS)[number];
export type ListSource = (typeof LIST_SOURCES)[number];
export type ColumnFormat = (typeof COLUMN_FORMATS)[number];

/** Which records count. Each source takes its own keys: see `FILTER_KEYS`. */
export interface EntityFilters {
  /** Events: one event type, or any of several. Linked entities: met in events of these types only. */
  event_type?: string | string[];
  property?: { name: string; value: string };
  action?: string;
  outcome?: Outcome[];
  label?: string;
  queue?: string;
  status?: CaseStatus[];
}

export interface EntityFact {
  /** How case views name it. Unique on its type. */
  name: string;
  label: string;
  source: FactSource;
  measure: FactMeasure;
  /** `sum` and `avg`: a numeric event property, or `risk_score` for decisions. `unique`: an entity type the events name. */
  field?: string;
  filters?: EntityFilters;
  /** "24h", "7d", "30d", up to 400 days, or "all" (the default). */
  window?: string;
  /** A longer period: the fact is also compared with what a window of the same length usually held in it. */
  usual?: string;
  format?: FactFormat;
  /** With the money format: a currency code such as "GBP". */
  currency?: string;
}

export interface ListColumn {
  /** A field path of the list's source: see `columnProblem`. */
  field: string;
  label?: string;
  format?: ColumnFormat;
  /** With the money format: a currency code, or a field of the row that holds one ("event.currency"). */
  currency?: string;
}

export interface EntityList {
  name: string;
  label: string;
  source: ListSource;
  /** Linked: the type of the other entities. */
  entity_type?: string;
  filters?: EntityFilters;
  /** A bare field path is a column with the default label and format. */
  columns: (string | ListColumn)[];
  sort?: (typeof LIST_SORTS)[number];
  window?: string;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const CURRENCY = /^[A-Z]{3}$/;
const OUTCOMES: Outcome[] = ["approve", "step_up", "review", "block"];
/** As `CASE_STATUSES` of intake.ts, which imports entities.ts, which imports this file. */
const STATUSES: CaseStatus[] = ["open", "in_review", "resolved"];

const FILTER_KEYS: Record<FactSource | ListSource, (keyof EntityFilters)[]> = {
  events: ["event_type", "property"],
  decisions: ["action", "outcome"],
  labels: ["label"],
  cases: ["queue", "status"],
  linked: ["event_type"],
};

export const FACT_MEASURES_OF: Record<FactSource, FactMeasure[]> = {
  events: ["count", "sum", "avg", "unique", "first", "last"],
  decisions: ["count", "sum", "avg", "first", "last"],
  labels: ["count", "first", "last"],
  cases: ["count", "first", "last"],
};

/** The fixed columns of each list source. `<prefix>.<name>` columns are in `COLUMN_PREFIXES`. */
export const LIST_COLUMNS: Record<ListSource, string[]> = {
  events: ["ts", "id", "type", "decision.outcome", "decision.risk_score"],
  decisions: ["ts", "id", "action", "decision.outcome", "decision.risk_score", "final_outcome"],
  linked: ["id", "name", "first_seen", "last_seen", "events"],
  cases: ["ts", "id", "status", "priority", "queue", "assignee", "resolution"],
};
export const COLUMN_PREFIXES: Partial<Record<ListSource, string>> = {
  events: "event.",
  decisions: "request.",
  linked: "entity.",
};

const COLUMN_LABEL: Record<string, string> = {
  ts: "When",
  id: "Id",
  type: "Event",
  action: "Action",
  "decision.outcome": "Decision",
  "decision.risk_score": "Risk",
  final_outcome: "Final outcome",
  name: "Name",
  first_seen: "First seen",
  last_seen: "Last seen",
  events: "Events",
  status: "Status",
  priority: "Priority",
  queue: "Queue",
  assignee: "Assignee",
  resolution: "Resolution",
};

export const columnTitle = (column: string | ListColumn) => {
  const c = typeof column === "string" ? { field: column } : column;
  return c.label?.trim() || COLUMN_LABEL[c.field] || c.field.split(".").slice(1).join(".").replaceAll("_", " ");
};

export const asColumn = (column: string | ListColumn): ListColumn =>
  typeof column === "string" ? { field: column } : column;

function columnProblem(source: ListSource, field: string): string | null {
  if (LIST_COLUMNS[source].includes(field)) return null;
  const prefix = COLUMN_PREFIXES[source];
  if (prefix && field.startsWith(prefix) && NAME.test(field.slice(prefix.length))) return null;
  return `is not a column of ${source}: use ${[...LIST_COLUMNS[source], ...(prefix ? [`${prefix}<property>`] : [])].join(", ")}`;
}

const isWindow = (w: unknown) => w === ALL_TIME || parseWindow(w) !== null;

function filterProblems(at: string, source: FactSource | ListSource, filters: unknown): string[] {
  if (filters === undefined) return [];
  if (!filters || typeof filters !== "object" || Array.isArray(filters)) return [`${at}.filters must be an object`];
  const problems: string[] = [];
  const f = filters as Record<string, unknown>;
  for (const key of Object.keys(f)) {
    if (!FILTER_KEYS[source].includes(key as keyof EntityFilters)) {
      problems.push(
        `${at}.filters.${key} is not a filter of ${source}: use ${FILTER_KEYS[source].join(", ") || "none"}`,
      );
      continue;
    }
    const value = f[key];
    const text = (v: unknown) => typeof v === "string" && v.trim() !== "" && v.length <= 128;
    if (key === "event_type") {
      const types = Array.isArray(value) ? value : [value];
      if (types.length === 0 || types.length > 10 || !types.every(text))
        problems.push(`${at}.filters.event_type must be an event type, or a list of up to 10`);
    } else if (key === "property") {
      const p = value as { name?: unknown; value?: unknown } | null;
      if (!p || typeof p !== "object" || !text(p.name) || typeof p.value !== "string")
        problems.push(`${at}.filters.property must be { name, value }`);
    } else if (key === "outcome") {
      if (!Array.isArray(value) || value.length === 0 || !value.every((o) => OUTCOMES.includes(o as Outcome)))
        problems.push(`${at}.filters.outcome must be a list of ${OUTCOMES.join(", ")}`);
    } else if (key === "status") {
      if (!Array.isArray(value) || value.length === 0 || !value.every((s) => STATUSES.includes(s as CaseStatus)))
        problems.push(`${at}.filters.status must be a list of ${STATUSES.join(", ")}`);
    } else if (!text(value)) problems.push(`${at}.filters.${key} must be a name`);
  }
  return problems;
}

function labelProblems(at: string, item: { name?: unknown; label?: unknown }, names: Set<string>): string[] {
  const problems: string[] = [];
  if (typeof item.name !== "string" || !NAME.test(item.name))
    problems.push(`${at}.name must be a name such as "transactions_30d"`);
  else if (names.has(item.name)) problems.push(`${at}.name: "${item.name}" is used twice`);
  else names.add(item.name);
  if (typeof item.label !== "string" || !item.label.trim() || item.label.length > 80)
    problems.push(`${at}.label must be text of at most 80 characters`);
  return problems;
}

export function validateFacts(facts: unknown, at = "facts"): string[] {
  if (facts === undefined) return [];
  if (!Array.isArray(facts)) return [`${at} must be a list`];
  const problems: string[] = [];
  if (facts.length > MAX_FACTS) problems.push(`${at}: at most ${MAX_FACTS} facts`);
  const names = new Set<string>();
  for (const [i, raw] of facts.entries()) {
    const here = `${at}[${i}]`;
    if (!raw || typeof raw !== "object") {
      problems.push(`${here} must be an object`);
      continue;
    }
    const f = raw as Partial<EntityFact>;
    problems.push(...labelProblems(here, f, names));
    if (!FACT_SOURCES.includes(f.source as FactSource)) {
      problems.push(`${here}.source must be one of ${FACT_SOURCES.join(", ")}`);
      continue;
    }
    const source = f.source as FactSource;
    if (!FACT_MEASURES_OF[source].includes(f.measure as FactMeasure))
      problems.push(`${here}.measure must be one of ${FACT_MEASURES_OF[source].join(", ")} for ${source}`);
    const needsField = f.measure === "sum" || f.measure === "avg" || f.measure === "unique";
    if (needsField && (typeof f.field !== "string" || !NAME.test(f.field)))
      problems.push(
        `${here}.field must be ${f.measure === "unique" ? "an entity type" : source === "decisions" ? "risk_score" : "a numeric property"}`,
      );
    else if (needsField && source === "decisions" && f.field !== "risk_score")
      problems.push(`${here}.field must be risk_score for decisions`);
    else if (!needsField && f.field !== undefined) problems.push(`${here}.field is only for sum, avg and unique`);
    problems.push(...filterProblems(here, source, f.filters));
    if (f.window !== undefined && !isWindow(f.window))
      problems.push(`${here}.window must be like "24h", "7d" or "30d", at most 400 days, or "all"`);
    if (f.usual !== undefined) {
      const usual = parseWindow(f.usual);
      const window = parseWindow(f.window);
      if (f.measure !== "count" && f.measure !== "sum") problems.push(`${here}.usual is only for count and sum`);
      else if (usual === null) problems.push(`${here}.usual must be like "90d"`);
      else if (window === null) problems.push(`${here}.usual needs a window to compare`);
      else if (usual < window * 2) problems.push(`${here}.usual must be at least two times the window`);
    }
    if (f.format !== undefined && !FACT_FORMATS.includes(f.format as FactFormat))
      problems.push(`${here}.format must be one of ${FACT_FORMATS.join(", ")}`);
    if (
      f.currency !== undefined &&
      (f.format !== "money" || typeof f.currency !== "string" || !CURRENCY.test(f.currency))
    )
      problems.push(`${here}.currency must be a code such as "GBP", with the money format`);
  }
  return problems;
}

export function validateLists(lists: unknown, at = "lists"): string[] {
  if (lists === undefined) return [];
  if (!Array.isArray(lists)) return [`${at} must be a list`];
  const problems: string[] = [];
  if (lists.length > MAX_LISTS) problems.push(`${at}: at most ${MAX_LISTS} lists`);
  const names = new Set<string>();
  for (const [i, raw] of lists.entries()) {
    const here = `${at}[${i}]`;
    if (!raw || typeof raw !== "object") {
      problems.push(`${here} must be an object`);
      continue;
    }
    const l = raw as Partial<EntityList>;
    problems.push(...labelProblems(here, l, names));
    if (!LIST_SOURCES.includes(l.source as ListSource)) {
      problems.push(`${here}.source must be one of ${LIST_SOURCES.join(", ")}`);
      continue;
    }
    const source = l.source as ListSource;
    if (
      source === "linked" ? typeof l.entity_type !== "string" || !NAME.test(l.entity_type) : l.entity_type !== undefined
    )
      problems.push(
        source === "linked" ? `${here}.entity_type must be an entity type` : `${here}.entity_type is only for linked`,
      );
    problems.push(...filterProblems(here, source, l.filters));
    if (!Array.isArray(l.columns) || l.columns.length === 0 || l.columns.length > MAX_LIST_COLUMNS) {
      problems.push(`${here}.columns must be a list of 1 to ${MAX_LIST_COLUMNS} columns`);
    } else {
      for (const [j, column] of l.columns.entries()) {
        const c = asColumn(column as string | ListColumn);
        const where = `${here}.columns[${j}]`;
        if (!c || typeof c.field !== "string") {
          problems.push(`${where} must be a field path, or { field, label, format }`);
          continue;
        }
        const wrong = columnProblem(source, c.field);
        if (wrong) problems.push(`${where}: "${c.field}" ${wrong}`);
        if (c.label !== undefined && (typeof c.label !== "string" || c.label.length > 80))
          problems.push(`${where}.label must be text of at most 80 characters`);
        if (c.format !== undefined && !COLUMN_FORMATS.includes(c.format))
          problems.push(`${where}.format must be one of ${COLUMN_FORMATS.join(", ")}`);
        if (
          c.currency !== undefined &&
          (c.format !== "money" ||
            typeof c.currency !== "string" ||
            !(CURRENCY.test(c.currency) || columnProblem(source, c.currency) === null))
        )
          problems.push(`${where}.currency must be a code such as "GBP" or a field of the row, with the money format`);
      }
    }
    if (l.sort !== undefined && !LIST_SORTS.includes(l.sort)) problems.push(`${here}.sort must be newest or oldest`);
    if (l.window !== undefined && !isWindow(l.window))
      problems.push(`${here}.window must be like "24h", "7d" or "30d", at most 400 days, or "all"`);
  }
  return problems;
}

export function windowStart(window: string | undefined, now: number): number | null {
  const ms = parseWindow(window);
  return ms === null ? null : now - ms;
}

/** As an action total compares (`totals.ts`). Infinity when there is a value and nothing before; null when both are 0. */
export function timesUsual(value: number, before: number, window: number, usual: number): number | null {
  const perWindow = before / ((usual - window) / window);
  if (perWindow === 0) return value === 0 ? null : Infinity;
  return Math.round((value / perWindow) * 10) / 10;
}
