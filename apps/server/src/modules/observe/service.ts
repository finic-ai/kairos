import type { Decision } from "@kairos/core";
import type { DashboardRow } from "../../db/schema";
import type { Repositories } from "../../repositories";
import { DecisionsService } from "../../services/decision.service";
import type { DecisionSummary } from "../../types";
import type { Dashboard, MetricQuery, MetricRequest, MetricResult, MetricRow } from "./schema";

export const toDashboard = (r: DashboardRow): Dashboard => {
  const { tiles = [], visibility = "workspace", ...rest } = r.definition as any;
  // A tile stored before widths were numbers has a size.
  const width = (t: any) => t.w ?? ({ s: 3, m: 6, l: 12 } as Record<string, number>)[t.size ?? "m"];
  return {
    ...rest,
    visibility,
    tiles: tiles.map(({ size, ...t }: any) => ({ ...t, w: width({ ...t, size }) })),
    id: r.id,
    owner: r.owner ?? null,
    created: r.created.toISOString(),
    updated: r.updated.toISOString(),
  };
};

/** A private dashboard exists only for its owner. One made with an API key has no owner and is for everyone. */
export const canSee = (d: Dashboard, viewer: string | undefined) =>
  d.visibility === "workspace" || (d.owner !== null && d.owner === viewer);

/** Only the owner renames a dashboard, changes who sees it, or deletes it. Anyone who sees it can change its tiles. */
export const canManage = (d: Dashboard, viewer: string | undefined) => d.owner === null || d.owner === viewer;

export const asSeenBy = (d: Dashboard, viewer: string | undefined) => ({
  ...d,
  mine: d.owner !== null && d.owner === viewer,
  can_manage: canManage(d, viewer),
});

const GROUP_LIMIT = 8;
const STEP = { hour: 3_600_000, day: 86_400_000, week: 7 * 86_400_000 };

/** The start of the bucket that holds `ms`, in UTC. Weeks start on Monday. */
export function bucketStart(ms: number, interval: keyof typeof STEP): number {
  if (interval === "week") {
    const day = Math.floor(ms / STEP.day);
    return (day - ((day + 3) % 7)) * STEP.day; // 1 January 1970 was a Thursday
  }
  return Math.floor(ms / STEP[interval]) * STEP[interval];
}

const actionName = (action: string | undefined) => action?.split("@")[0];

function matches(row: MetricRow, q: MetricQuery, labelled: Map<string, Set<string>>): boolean {
  const f = q.filters;
  if (q.source === "decisions") {
    if (f.action && actionName(row.action) !== f.action) return false;
    if (f.outcome && !f.outcome.split(",").includes(row.outcome ?? "")) return false;
    if (f.final_outcome && !f.final_outcome.split(",").includes(row.final_outcome ?? "")) return false;
    if (f.typology && row.typology !== f.typology) return false;
    if (f.signal && !row.signals?.includes(f.signal)) return false;
    if (f.subject_label) {
      const labels = labelled.get(row.subject ?? "");
      if (
        f.subject_label === "!"
          ? labels !== undefined
          : f.subject_label === "*"
            ? labels === undefined
            : !labels?.has(f.subject_label)
      )
        return false;
    }
  } else if (q.source === "events") {
    if (f.event_type && row.type !== f.event_type) return false;
    if (f.property && String(row.properties?.[f.property.name] ?? "") !== f.property.value) return false;
    if (f.entity_type && !(f.entity_type in (row.entities ?? {}))) return false;
  } else {
    if (f.label && row.label !== f.label) return false;
    if (f.entity_type && row.entity_type !== f.entity_type) return false;
  }
  return true;
}

/** The groups a row belongs to. Only "signal" can put one row in several. */
function groupsOf(row: MetricRow, groupBy: string | undefined): string[] {
  if (!groupBy) return ["all"];
  if (groupBy === "signal") return row.signals?.length ? row.signals : [];
  if (groupBy === "risk_band") {
    const low = Math.min(Math.floor((row.risk_score ?? 0) / 10), 9) * 10;
    return [`${low}–${low === 90 ? 100 : low + 9}`];
  }
  if (groupBy.startsWith("property:")) {
    const value = row.properties?.[groupBy.slice(9)];
    return [
      value === undefined || value === null || value === ""
        ? "(none)"
        : typeof value === "object"
          ? JSON.stringify(value)
          : String(value),
    ];
  }
  const value = {
    outcome: row.outcome,
    final_outcome: row.final_outcome,
    action: actionName(row.action),
    typology: row.typology,
    subject_type: row.subject_type,
    event_type: row.type,
    label: row.label,
    entity_type: row.entity_type,
  }[groupBy];
  return [value ?? "(none)"];
}

function numberOf(row: MetricRow, q: MetricQuery): number | undefined {
  if (q.source === "decisions") return q.field === "probability" ? row.probability : row.risk_score;
  const value = row.properties?.[q.field ?? ""];
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function identityOf(row: MetricRow, q: MetricQuery): string | undefined {
  if (q.source === "decisions") return row.subject;
  if (q.source === "labels") return row.entity;
  const type = q.field ?? Object.keys(row.entities ?? {})[0];
  const id = type ? row.entities?.[type] : undefined;
  return id === undefined ? undefined : `${type}/${id}`;
}

class Cell {
  rows = 0;
  hits = 0; // share: rows with the outcome
  sum = 0;
  numbers = 0;
  ids = new Set<string>();

  add(row: MetricRow, q: MetricQuery) {
    this.rows += 1;
    if (q.measure === "share" && (q.field ?? "block").split(",").includes(row.outcome ?? "")) this.hits += 1;
    if (q.measure === "avg" || q.measure === "sum") {
      const n = numberOf(row, q);
      if (n !== undefined) ((this.sum += n), (this.numbers += 1));
    }
    if (q.measure === "unique") {
      const id = identityOf(row, q);
      if (id !== undefined) this.ids.add(id);
    }
  }

  value(q: MetricQuery): number {
    const round = (n: number) => Math.round(n * 100) / 100;
    if (q.measure === "share") return this.rows ? round((this.hits / this.rows) * 100) : 0;
    if (q.measure === "avg") return this.numbers ? round(this.sum / this.numbers) : 0;
    if (q.measure === "sum") return round(this.sum);
    if (q.measure === "unique") return this.ids.size;
    return this.rows;
  }
}

export function computeMetric(
  rows: MetricRow[],
  request: MetricRequest,
  labelled: Map<string, Set<string>> = new Map(),
): Omit<MetricResult, "previous_total" | "truncated"> {
  const from = Date.parse(request.from);
  const to = Date.parse(request.to);
  const buckets: number[] = [];
  if (request.interval) {
    for (let t = bucketStart(from, request.interval); t < to && buckets.length < 2000; t += STEP[request.interval])
      buckets.push(t);
  }
  const index = new Map(buckets.map((t, i) => [t, i]));

  const overall = new Cell();
  const totals = new Map<string, Cell>();
  const cells = new Map<string, Cell[]>();
  for (const row of rows) {
    const ms = Date.parse(row.ts);
    if (ms < from || ms >= to || !matches(row, request, labelled)) continue;
    overall.add(row, request);
    const at = request.interval ? index.get(bucketStart(ms, request.interval)) : undefined;
    for (const group of groupsOf(row, request.group_by)) {
      if (!totals.has(group))
        (totals.set(group, new Cell()),
          cells.set(
            group,
            buckets.map(() => new Cell()),
          ));
      totals.get(group)!.add(row, request);
      if (at !== undefined) cells.get(group)![at]!.add(row, request);
    }
  }
  if (!request.group_by && !totals.has("all"))
    (totals.set("all", new Cell()),
      cells.set(
        "all",
        buckets.map(() => new Cell()),
      ));

  const ranked = [...totals]
    .map(([key, cell]) => ({ key, cell, rows: cell.rows }))
    // Bands of a score have their own order. Everything else is largest first.
    .sort((a, b) =>
      request.group_by === "risk_band"
        ? parseInt(a.key) - parseInt(b.key)
        : b.cell.value(request) - a.cell.value(request) || b.rows - a.rows || a.key.localeCompare(b.key),
    );
  const MAX_GROUPS = request.group_by === "risk_band" ? 10 : GROUP_LIMIT;
  const series = ranked.slice(0, MAX_GROUPS).map(({ key, cell }) => ({
    key,
    total: cell.value(request),
    values: cells.get(key)!.map((c) => c.value(request)),
  }));
  // A ninth group is never a ninth colour: the rest are counted together. Only a count can be added up this way.
  const rest = ranked.slice(MAX_GROUPS);
  if (rest.length > 0 && request.measure === "count") {
    series.push({
      key: `Other (${rest.length})`,
      total: rest.reduce((n, r) => n + r.cell.rows, 0),
      values: buckets.map((_, i) => rest.reduce((n, r) => n + cells.get(r.key)![i]!.rows, 0)),
    });
  }
  return {
    buckets: buckets.map((t) => new Date(t).toISOString()),
    series,
    total: overall.value(request),
    unit:
      request.measure === "share"
        ? "percent"
        : request.measure === "avg" || request.measure === "sum"
          ? "number"
          : "count",
  };
}

const OUTCOMES = ["approve", "step_up", "review", "block"] as const;
type Counts = Record<(typeof OUTCOMES)[number], number>;
const zero = (): Counts => ({ approve: 0, step_up: 0, review: 0, block: 0 });
const HOUR = 3_600_000;
/** Decisions read for the overview. Beyond this the charts describe the most recent ones. */
const SAMPLE = 5000;

export async function overview(
  repos: Pick<Repositories, "db" | "analytics" | "entities">,
  workspaceId: string,
  environmentId: string,
) {
  const [stats, types, decisions] = await Promise.all([
    repos.analytics.stats(workspaceId, environmentId),
    repos.entities.entityTypes(workspaceId, environmentId),
    new DecisionsService(repos.db, { workspaceId, environmentId }).listSummaries({ limit: SAMPLE }),
  ]);
  const decisionOf = (d: DecisionSummary) => d.decision as Decision;

  // Hourly buckets for a short span, daily for a long one, with the empty ones filled in.
  const times = decisions.map((d) => Date.parse(d.ts));
  const first = Math.min(...times);
  const last = Math.max(...times);
  const size = last - first <= 4 * 24 * HOUR ? HOUR : 24 * HOUR;
  const buckets = new Map<number, Counts>();
  if (decisions.length) for (let t = Math.floor(first / size) * size; t <= last; t += size) buckets.set(t, zero());
  const byAction = new Map<string, Counts>();
  const reasons = new Map<string, { count: number; held: number }>();
  const histogram = Array.from({ length: 10 }, () => 0);

  for (const d of decisions) {
    const { decision, risk_score, reasons: present } = decisionOf(d);
    buckets.get(Math.floor(Date.parse(d.ts) / size) * size)![decision]++;
    const action = d.action.split("@")[0]!;
    if (!byAction.has(action)) byAction.set(action, zero());
    byAction.get(action)![decision]++;
    histogram[Math.min(Math.floor(risk_score / 10), 9)]!++;
    for (const code of present) {
      const r = reasons.get(code) ?? { count: 0, held: 0 };
      r.count++;
      if (decision !== "approve") r.held++;
      reasons.set(code, r);
    }
  }

  const total = (c: Counts) => c.approve + c.step_up + c.review + c.block;
  return {
    events: stats.events,
    decisions: stats.decisions,
    outcomes: { ...zero(), ...stats.outcomes },
    actions: stats.actions,
    entities: types.reduce((a, t) => a + t.count, 0),
    entity_types: types.length,
    labelled: types.reduce((a, t) => a + t.labelled, 0),
    sampled: decisions.length,
    series: {
      bucket: size === HOUR ? "hour" : "day",
      points: [...buckets].map(([t, c]) => ({ t: new Date(t).toISOString(), ...c })),
    },
    by_action: [...byAction]
      .map(([action, c]) => ({ action, total: total(c), ...c }))
      .sort((a, b) => b.total - a.total),
    reasons: [...reasons]
      .map(([code, r]) => ({ code, ...r }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
    histogram,
    attention: decisions
      .filter((d) => decisionOf(d).decision === "block" || decisionOf(d).decision === "review")
      .slice(0, 8),
  };
}
