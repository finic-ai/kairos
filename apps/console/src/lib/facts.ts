import type {
  ColumnFormat,
  EntityFact,
  EntityFilters,
  EntityList,
  FactFormat,
  FactMeasure,
  FactSource,
  ListSource,
} from "@kairos/core";
import type { FactValue, ListPage } from "../types/interfaces";
import { dayOf, durationText, stamp, valueText } from "./format";

export const WINDOWS: [string, string][] = [
  ["24h", "24 hours"],
  ["7d", "7 days"],
  ["30d", "30 days"],
  ["90d", "90 days"],
  ["365d", "a year"],
  ["all", "All time"],
];
export const USUALS: [string, string][] = [
  ["30d", "The last 30 days"],
  ["90d", "The last 90 days"],
  ["180d", "The last 180 days"],
  ["365d", "The last year"],
];
export const windowText = (window: string) => WINDOWS.find(([w]) => w === window)?.[1] ?? window;
const periodText = (window: string | undefined) =>
  !window || window === "all" ? "all time" : `the last ${windowText(window)}`;

function recordsText(source: FactSource | ListSource, f: EntityFilters | undefined, entityType?: string): string {
  const types = f?.event_type === undefined ? [] : [f.event_type].flat();
  const where = f?.property ? ` where ${f.property.name} is ${f.property.value}` : "";
  if (source === "events") return `${types.length ? `${types.join(" or ")} events` : "events"}${where}`;
  if (source === "decisions") return f?.action ? `${f.action} decisions` : "decisions";
  if (source === "labels") return f?.label ? `${f.label} labels` : "labels";
  if (source === "linked")
    return `${entityType || "entities"} met in ${types.length ? `${types.join(" or ")} events` : "its events"}`;
  return f?.status?.length ? `${f.status.join(" or ").replaceAll("_", " ")} cases` : "cases";
}

export function factSentence(f: EntityFact): string {
  const records = recordsText(f.source, f.filters);
  const what = {
    count: `Count of ${records}`,
    sum: `Total ${f.field || "…"} of ${records}`,
    avg: `Average ${f.field || "…"} of ${records}`,
    unique: `Different ${f.field || "…"} entities in ${records}`,
    first: `The first of the ${records}`,
    last: `The last of the ${records}`,
  }[f.measure];
  const usual = f.usual ? `, against the usual over ${periodText(f.usual).replace("the last ", "")}` : "";
  return `${what}, ${periodText(f.window)}${usual}`;
}

export function listSentence(l: EntityList): string {
  const columns = `${l.columns.length} ${l.columns.length === 1 ? "column" : "columns"}`;
  const text = `${recordsText(l.source, l.filters, l.entity_type)}, ${columns}, ${periodText(l.window)}${l.sort === "oldest" ? ", oldest first" : ""}`;
  return text[0]!.toUpperCase() + text.slice(1);
}

export const SOURCE_LABEL: Record<FactSource | ListSource, string> = {
  events: "Events",
  decisions: "Decisions",
  labels: "Labels",
  cases: "Cases",
  linked: "Linked entities",
};

const MEASURE_LABEL: Record<FactMeasure, string> = {
  count: "How many",
  sum: "The total of a property",
  avg: "The average of a property",
  unique: "How many different entities",
  first: "When the first one was",
  last: "When the last one was",
};
export const measureLabel = (source: FactSource, measure: FactMeasure) =>
  source !== "decisions"
    ? MEASURE_LABEL[measure]
    : measure === "sum"
      ? "The total of the risk scores"
      : measure === "avg"
        ? "The average risk score"
        : MEASURE_LABEL[measure];

export const FACT_FORMAT_LABEL: Record<FactFormat, string> = { number: "Number", money: "Money", percent: "Percent" };

export const COLUMN_FORMAT_LABEL: Record<ColumnFormat, string> = {
  text: "Text",
  number: "Number",
  money: "Money",
  datetime: "Date and time",
  date: "Date",
  boolean: "Yes or no",
  country: "Country",
};

const CURRENCY = /^[A-Z]{3}$/;
const TIMES = new Set(["ts", "first_seen", "last_seen"]);

export function money(value: number, currency?: string): string {
  try {
    return currency && CURRENCY.test(currency)
      ? value.toLocaleString("en-GB", { style: "currency", currency })
      : value.toLocaleString("en-GB", { maximumFractionDigits: 2 });
  } catch {
    return `${value.toLocaleString("en-GB", { maximumFractionDigits: 2 })} ${currency}`;
  }
}

const asNumber = (value: unknown) => {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
};

export function factText(f: FactValue, now = Date.now()): string {
  if (f.value === null) return f.measure === "first" || f.measure === "last" ? "Never" : "—";
  if (typeof f.value === "string") return `${durationText(now - Date.parse(f.value))} ago`;
  if (f.format === "money") return money(f.value, f.currency);
  if (f.format === "percent") return `${f.value.toLocaleString("en-GB", { maximumFractionDigits: 1 })}%`;
  return f.value.toLocaleString("en-GB", { maximumFractionDigits: 2 });
}

export function usualText(f: FactValue): string | null {
  if (f.usual === undefined) return null;
  if (f.times_usual === null || f.times_usual === undefined) return f.value ? "None usually" : null;
  return `${f.times_usual.toLocaleString("en-GB")} times the usual`;
}

export function cellText(column: ListPage["columns"][number], values: Record<string, unknown>): string {
  const value = values[column.field];
  if (value === null || value === undefined || value === "") return "—";
  switch (column.format ?? (TIMES.has(column.field) ? "datetime" : undefined)) {
    case "money": {
      const n = asNumber(value);
      const currency = column.currency && !CURRENCY.test(column.currency) ? values[column.currency] : column.currency;
      return n === null ? valueText(value) : money(n, typeof currency === "string" ? currency : undefined);
    }
    case "number": {
      const n = asNumber(value);
      return n === null ? valueText(value) : n.toLocaleString("en-GB", { maximumFractionDigits: 2 });
    }
    case "datetime":
      return typeof value === "string" ? stamp(value) : valueText(value);
    case "date":
      return typeof value === "string" ? dayOf(value) : valueText(value);
    case "boolean":
      return value === true || value === "true"
        ? "Yes"
        : value === false || value === "false"
          ? "No"
          : valueText(value);
    case "country":
      return String(value).toUpperCase();
    default:
      return valueText(value);
  }
}
