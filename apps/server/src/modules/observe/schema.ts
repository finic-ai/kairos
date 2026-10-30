import { z } from "zod";

/**
 * A metric for a dashboard tile: one number, a series over time, or a breakdown.
 * The choices are fixed lists, not a query language, so every combination is valid.
 */
export const SOURCES = ["decisions", "events", "labels"] as const;
export const MEASURES = ["count", "unique", "share", "avg", "sum"] as const;
export const INTERVALS = ["hour", "day", "week"] as const;
export const VIEWS = ["number", "line", "area", "bar", "stacked", "hbar", "table", "list"] as const;

const text = z.string().min(1).max(128);
const moment = z.string().refine((v) => !Number.isNaN(Date.parse(v)), "must be an ISO 8601 timestamp");

export const metricQuery = z.object({
  source: z.enum(SOURCES),
  measure: z.enum(MEASURES).default("count"),
  /**
   * What the measure is taken of. avg and sum: "risk_score" or "probability" for decisions, a
   * numeric property for events. unique: an entity type for events. share: an outcome.
   */
  field: text.optional(),
  filters: z
    .object({
      action: text.optional(),
      outcome: text.optional(),
      final_outcome: text.optional(),
      typology: text.optional(),
      signal: text.optional(),
      subject_label: text.optional(),
      event_type: text.optional(),
      property: z.object({ name: text, value: z.string().max(256) }).optional(),
      label: text.optional(),
      entity_type: text.optional(),
    })
    .default({}),
  group_by: text.optional(),
});
export type MetricQuery = z.infer<typeof metricQuery>;

export const metricRequest = metricQuery.extend({
  from: moment,
  to: moment,
  interval: z.enum(INTERVALS).optional(),
  compare: z.boolean().default(false),
});
export type MetricRequest = z.infer<typeof metricRequest>;

const WIDTH = { s: 3, m: 6, l: 12 } as const;
export const tile = z
  .object({
    id: z.string().min(1).max(64),
    title: z.string().trim().min(1).max(80),
    view: z.enum(VIEWS),
    w: z.number().int().min(2).max(12).optional(),
    size: z.enum(["s", "m", "l"]).optional(),
    link: z.enum(["decisions", "entities", "actions", "none"]).optional(),
    query: metricQuery,
  })
  .transform(({ size, w, ...rest }) => ({ ...rest, w: w ?? WIDTH[size ?? "m"] }));
export const dashboardBody = z.object({
  name: z.string().trim().min(1).max(80),
  range: z.enum(["24h", "7d", "30d", "90d"]).default("30d"),
  visibility: z.enum(["private", "workspace"]).default("workspace"),
  tiles: z.array(tile).max(40).default([]),
});
export type DashboardBody = z.infer<typeof dashboardBody>;
export interface Dashboard extends DashboardBody {
  id: string;
  owner: string | null;
  created: string;
  updated: string;
}

export interface MetricRow {
  ts: string;
  action?: string;
  outcome?: string;
  final_outcome?: string;
  typology?: string;
  signals?: string[];
  risk_score?: number;
  probability?: number;
  subject?: string; // "user/user_42"
  subject_type?: string;
  type?: string;
  entities?: Record<string, string>;
  properties?: Record<string, unknown>;
  label?: string;
  entity?: string;
  entity_type?: string;
}

export interface MetricResult {
  buckets: string[];
  series: { key: string; total: number; values: number[] }[];
  total: number;
  previous_total?: number;
  unit: "count" | "percent" | "number";
  truncated: boolean;
}
