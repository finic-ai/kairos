import { useEffect, useRef, useState, CSSProperties, FormEvent } from "react";
import { api } from "../api/index";
import { InTopbar } from "../components/shell/InTopbar";
import type {
  Dashboard,
  DecisionSummary,
  DashboardRange,
  Interval,
  MetricMeasure,
  MetricOptions,
  MetricQuery,
  MetricSource,
  Tile,
  TileView,
} from "../types/interfaces";
import { BigNumber, DataTable, HBars, TimeChart } from "../components/charts/charts";
import { ActionRef } from "../components/actions/ActionRef";
import { Modal } from "../components/ui/Modal";
import { Pill } from "../components/decisions/Outcome";
import { Empty, Failure } from "../components/ui/states";
import { stamp } from "../lib/format";
import { go, href } from "../lib/route";
import { useApi, useDashboards } from "../hooks/useApi";
import { ChartSkeleton, DashSkeleton, NumberSkeleton, RowsSkeleton } from "../components/ui/Skeleton";
import { useDismiss } from "../hooks/useDismiss";
import { useActionNames } from "../hooks/useActionNames";

const RANGES: { id: DashboardRange; label: string; period: string; hours: number; interval: Interval }[] = [
  { id: "24h", label: "24 hours", period: "24 hours", hours: 24, interval: "hour" },
  { id: "7d", label: "7 days", period: "7 days", hours: 7 * 24, interval: "day" },
  { id: "30d", label: "30 days", period: "30 days", hours: 30 * 24, interval: "day" },
  { id: "90d", label: "90 days", period: "90 days", hours: 90 * 24, interval: "week" },
];

const VIEWS: { id: TileView; label: string; note: string }[] = [
  { id: "number", label: "Number", note: "One value, with the change from the period before." },
  { id: "line", label: "Line", note: "The value over time." },
  { id: "area", label: "Area", note: "Over time, with the groups stacked." },
  { id: "bar", label: "Bars", note: "Over time, with the groups side by side." },
  { id: "stacked", label: "Stacked bars", note: "Over time, with the groups stacked." },
  { id: "hbar", label: "Ranked bars", note: "The groups compared, largest first. Needs a group." },
  { id: "table", label: "Table", note: "The numbers: by group, or by period when there is no group." },
  { id: "list", label: "List", note: "The most recent decisions that match the filters. Decisions only." },
];
const OVER_TIME: TileView[] = ["line", "area", "bar", "stacked"];

const SOURCE_LABEL: Record<MetricSource, string> = { decisions: "Decisions", events: "Events", labels: "Labels" };
const OUTCOMES: [string, string][] = [
  ["approve", "approve"],
  ["step_up", "step up"],
  ["review", "review"],
  ["block", "block"],
  ["review,block", "review or block"],
];

const newId = () => `t_${Math.random().toString(36).slice(2, 10)}`;
const decisions = (query: Partial<MetricQuery>): MetricQuery => ({
  source: "decisions",
  measure: "count",
  filters: {},
  ...query,
});

const TEMPLATES: Omit<Tile, "id">[] = [
  { title: "Decisions", view: "number", w: 3, query: decisions({}) },
  {
    title: "Held for review or blocked",
    view: "number",
    w: 3,
    query: decisions({ measure: "share", field: "review,block" }),
  },
  {
    title: "Approved without intervention",
    view: "number",
    w: 3,
    query: decisions({ measure: "share", field: "approve" }),
  },
  { title: "Events tracked", view: "number", w: 3, query: { source: "events", measure: "count", filters: {} } },
  { title: "Decisions over time", view: "stacked", w: 7, query: decisions({ group_by: "outcome" }) },
  { title: "Risk scores", view: "hbar", w: 5, query: decisions({ group_by: "risk_band" }) },
  { title: "Decisions by action", view: "hbar", w: 6, query: decisions({ group_by: "action" }) },
  { title: "Top signals", view: "hbar", w: 6, query: decisions({ group_by: "signal" }) },
  {
    title: "Needs attention",
    view: "list",
    w: 12,
    link: "decisions",
    query: decisions({ filters: { outcome: "review,block" } }),
  },
  { title: "Block rate", view: "number", w: 3, query: decisions({ measure: "share", field: "block" }) },
  { title: "Block rate over time", view: "line", w: 6, query: decisions({ measure: "share", field: "block" }) },
  {
    title: "Approved, subject later labelled",
    view: "number",
    w: 3,
    query: decisions({ filters: { outcome: "approve", subject_label: "*" } }),
  },
  {
    title: "Blocked, subject has no label",
    view: "number",
    w: 3,
    query: decisions({ filters: { outcome: "block", subject_label: "!" } }),
  },
  { title: "Average risk score", view: "line", w: 6, query: decisions({ measure: "avg", field: "risk_score" }) },
  {
    title: "Events by type",
    view: "stacked",
    w: 12,
    query: { source: "events", measure: "count", filters: {}, group_by: "event_type" },
  },
  {
    title: "Labels added",
    view: "bar",
    w: 6,
    query: { source: "labels", measure: "count", filters: {}, group_by: "label" },
  },
];
const OVERVIEW = [0, 1, 2, 3, 4, 5, 6, 7, 8];

function windowOf(range: DashboardRange) {
  const spec = RANGES.find((r) => r.id === range)!;
  const to = Math.ceil(Date.now() / 3_600_000) * 3_600_000;
  return {
    from: new Date(to - spec.hours * 3_600_000).toISOString(),
    to: new Date(to).toISOString(),
    interval: spec.interval,
    period: spec.period,
  };
}

function requestFor(tile: Pick<Tile, "view" | "query">, range: DashboardRange) {
  const { from, to, interval } = windowOf(range);
  const { view, query } = tile;
  if (view === "number") return { ...query, group_by: undefined, from, to, compare: true };
  if (OVER_TIME.includes(view) || (view === "table" && !query.group_by)) return { ...query, from, to, interval };
  return { ...query, from, to };
}

function DecisionList({ query }: { query: MetricQuery }) {
  const names = useActionNames();
  const { data, error } = useApi(
    ["decisions", { action: query.filters.action, limit: 200 }],
    () => api.decisions({ action: query.filters.action, limit: 200 }),
    { refetchInterval: 60_000 },
  );
  if (error)
    return (
      <p className="note" style={{ margin: 0 }}>
        {error.message}
      </p>
    );
  if (!data) return <RowsSkeleton rows={5} />;
  const outcomes = query.filters.outcome?.split(",");
  const rows = data.decisions
    .filter(
      (d: DecisionSummary) =>
        (!outcomes || outcomes.includes(d.decision.decision)) &&
        (!query.filters.signal || d.decision.reasons.includes(query.filters.signal)),
    )
    .slice(0, 8);
  if (rows.length === 0) return <div className="tile-wait muted">No decisions match.</div>;
  return (
    <div className="data-table">
      <table>
        <thead>
          <tr>
            <th>Outcome</th>
            <th style={{ textAlign: "right" }}>Risk</th>
            <th>Subject</th>
            <th className="hide-md">Action</th>
            <th className="hide-md">Signals</th>
            <th style={{ textAlign: "right" }}>Decided</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.id} className="link" onClick={() => go("decisions", d.id)}>
              <td>
                <Pill outcome={d.decision.decision} />
              </td>
              <td className="num">{d.decision.risk_score}</td>
              <td className="mono">{d.subject.id}</td>
              <td className="hide-md">
                <ActionRef action={d.action} names={names} />
              </td>
              <td className="hide-md muted">{d.decision.reasons.slice(0, 2).join(", ").replaceAll("_", " ") || "—"}</td>
              <td className="mono muted" style={{ textAlign: "right" }}>
                {stamp(d.ts)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TileBody({ tile, range }: { tile: Pick<Tile, "view" | "query">; range: DashboardRange }) {
  if (tile.view === "list") return <DecisionList query={tile.query} />;
  return <MetricBody tile={tile} range={range} />;
}

function MetricBody({ tile, range }: { tile: Pick<Tile, "view" | "query">; range: DashboardRange }) {
  const { interval, period } = windowOf(range);
  const key = JSON.stringify([tile.view, tile.query, range]);
  const { data, error } = useApi(["metric", key], () => api.metric(requestFor(tile, range)), {
    refetchInterval: 60_000,
  });
  if (error)
    return (
      <p className="note" style={{ margin: 0 }}>
        {error.message}
      </p>
    );
  if (!data) return tile.view === "number" ? <NumberSkeleton /> : <ChartSkeleton />;
  const empty = data.series.every((s) => s.total === 0);
  if (tile.view !== "number" && empty) return <div className="tile-wait muted">No data in the last {period}.</div>;
  return (
    <>
      {tile.view === "number" && <BigNumber data={data} period={period} />}
      {OVER_TIME.includes(tile.view) && <TimeChart data={data} kind={tile.view as "line"} interval={interval} />}
      {tile.view === "hbar" && <HBars data={data} />}
      {tile.view === "table" && <DataTable data={data} interval={interval} />}
      {data.truncated && (
        <p className="note" style={{ margin: "10px 0 0" }}>
          This period holds more rows than one tile reads. The numbers are a lower bound.
        </p>
      )}
    </>
  );
}

function describe(q: MetricQuery): string {
  const noun =
    q.source === "decisions"
      ? "decisions"
      : q.source === "events"
        ? q.filters.event_type
          ? `${q.filters.event_type} events`
          : "events"
        : "labels";
  const what =
    q.measure === "count"
      ? `Count of ${noun}`
      : q.measure === "share"
        ? `Share of ${noun} with outcome ${(q.field ?? "block").replace(",", " or ")}`
        : q.measure === "unique"
          ? `Unique ${q.source === "events" ? (q.field ?? "entities") : q.source === "decisions" ? "subjects" : "entities"} in ${noun}`
          : `${q.measure === "avg" ? "Average" : "Sum of"} ${(q.field ?? "risk_score").replaceAll("_", " ")}`;
  const f = q.filters;
  const where = [
    f.action && `action ${f.action}`,
    f.outcome && `outcome ${f.outcome.replace(",", " or ")}`,
    f.final_outcome && `final outcome ${f.final_outcome.replace(",", " or ")}`,
    f.signal && `signal ${f.signal}`,
    f.typology && `typology ${f.typology}`,
    f.subject_label &&
      (f.subject_label === "*"
        ? "subject has a label"
        : f.subject_label === "!"
          ? "subject has no label"
          : `subject labelled ${f.subject_label}`),
    f.property && `${f.property.name} = ${f.property.value}`,
    f.label && `label ${f.label}`,
    f.entity_type && `entity type ${f.entity_type}`,
  ].filter(Boolean);
  return `${what}${where.length ? ` · ${where.join(", ")}` : ""}${q.group_by ? ` · by ${q.group_by.replace("property:", "").replaceAll("_", " ")}` : ""}`;
}

const describeTile = (tile: Pick<Tile, "view" | "query">) =>
  tile.view === "list"
    ? `Latest decisions${tile.query.filters.outcome ? ` · outcome ${tile.query.filters.outcome.replace(",", " or ")}` : ""}${tile.query.filters.action ? ` · action ${tile.query.filters.action}` : ""}`
    : describe(tile.query);

function linkOf(tile: Pick<Tile, "link" | "query">): { label: string; href: string } | null {
  const { filters } = tile.query;
  const target = tile.link;
  if (!target || target === "none") return null;
  if (target === "decisions") {
    const params = new URLSearchParams();
    if (filters.outcome && !filters.outcome.includes(",")) params.set("outcome", filters.outcome);
    if (filters.action) params.set("action", filters.action);
    return { label: "Decisions", href: `${href("decisions")}${params.size ? `?${params}` : ""}` };
  }
  if (target === "actions")
    return { label: "Actions", href: filters.action ? href("actions", filters.action) : href("actions") };
  return { label: "Entities", href: filters.entity_type ? href("entities", filters.entity_type) : href("entities") };
}

const Select = ({
  label,
  value,
  onChange,
  options,
  none,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: (string | [string, string])[];
  none?: string;
}) => (
  <label className="field">
    <span>{label}</span>
    <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
      {none !== undefined && <option value="">{none}</option>}
      {options.map((o) => {
        const [id, text] = typeof o === "string" ? [o, o.replaceAll("_", " ")] : o;
        return (
          <option key={id} value={id}>
            {text}
          </option>
        );
      })}
    </select>
  </label>
);

function TileEditor({
  initial,
  range,
  onSave,
  onClose,
}: {
  initial: Tile | null;
  range: DashboardRange;
  onSave: (tile: Tile) => void;
  onClose: () => void;
}) {
  const [tile, setTile] = useState<Tile>(initial ?? { id: newId(), ...TEMPLATES[0]!, w: 4, title: "" });
  const [template, setTemplate] = useState("");
  const q = tile.query;
  const eventType = q.source === "events" ? q.filters.event_type : undefined;
  const { data: options } = useApi<MetricOptions>(["metric-options", eventType], () => api.metricOptions(eventType));
  const setQuery = (patch: Partial<MetricQuery>) => setTile((t) => ({ ...t, query: { ...t.query, ...patch } }));
  const setFilter = (patch: Partial<MetricQuery["filters"]>) =>
    setTile((t) => ({
      ...t,
      query: {
        ...t.query,
        filters: Object.fromEntries(
          Object.entries({ ...t.query.filters, ...patch }).filter(([, v]) => v !== undefined && v !== ""),
        ),
      },
    }));

  const useTemplate = (index: string) => {
    setTemplate(index);
    if (index !== "") setTile((t) => ({ ...t, ...structuredClone(TEMPLATES[Number(index)]!) }));
  };
  // A source has its own measures, filters and groups: changing it starts the query again.
  const setSource = (source: MetricSource) =>
    setTile((t) => ({ ...t, query: { source, measure: "count", filters: {} } }));
  const setMeasure = (measure: MetricMeasure) =>
    setQuery({
      measure,
      field:
        measure === "share"
          ? "block"
          : measure === "avg" || measure === "sum"
            ? q.source === "decisions"
              ? "risk_score"
              : numeric[0]
            : measure === "unique" && q.source === "events"
              ? "user"
              : undefined,
    });

  const numeric = (options?.event_properties ?? []).filter((p) => p.numeric).map((p) => p.name);
  const properties = (options?.event_properties ?? []).map((p) => p.name);
  const measures: [MetricMeasure, string][] =
    q.source === "decisions"
      ? [
          ["count", "Count"],
          ["share", "Share with an outcome"],
          ["avg", "Average"],
          ["unique", "Unique subjects"],
        ]
      : q.source === "events"
        ? [
            ["count", "Count"],
            ["unique", "Unique entities"],
            ["sum", "Sum of a property"],
            ["avg", "Average of a property"],
          ]
        : [
            ["count", "Count"],
            ["unique", "Unique entities"],
          ];
  const groups: (string | [string, string])[] =
    q.source === "decisions"
      ? [
          "outcome",
          ["final_outcome", "final outcome"],
          "action",
          "signal",
          "typology",
          ["risk_band", "risk score band"],
          ["subject_type", "subject type"],
        ]
      : q.source === "events"
        ? [
            ["event_type", "event type"],
            ...properties.map((p) => [`property:${p}`, `property: ${p}`] as [string, string]),
          ]
        : ["label", ["entity_type", "entity type"]];

  const view = VIEWS.find((v) => v.id === tile.view)!;
  const problem = !tile.title.trim()
    ? "Give the tile a title."
    : tile.view === "list" && q.source !== "decisions"
      ? "A list shows decisions only."
      : tile.view === "hbar" && !q.group_by
        ? "Ranked bars need a group."
        : (q.measure === "sum" || q.measure === "avg") && !q.field
          ? "Choose what to measure."
          : null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!problem) onSave({ ...tile, title: tile.title.trim() });
  };

  return (
    <Modal title={initial ? "Edit tile" : "Add tile"} onClose={onClose} wide>
      <form className="tile-editor" onSubmit={submit}>
        <div className="stack" style={{ gap: 14 }}>
          {!initial && (
            <Select
              label="Start from"
              value={template}
              onChange={useTemplate}
              none="A blank tile"
              options={TEMPLATES.map((t, i) => [String(i), t.title] as [string, string])}
            />
          )}
          <label className="field">
            <span>Title</span>
            <input
              className="input"
              value={tile.title}
              onChange={(e) => setTile({ ...tile, title: e.target.value })}
              maxLength={80}
              placeholder="Block rate"
              autoFocus
            />
          </label>

          <div className="field">
            <span>Data</span>
            <div className="seg">
              {(Object.keys(SOURCE_LABEL) as MetricSource[]).map((source) => (
                <button
                  key={source}
                  type="button"
                  className={q.source === source ? "on" : ""}
                  onClick={() => setSource(source)}
                >
                  {SOURCE_LABEL[source]}
                </button>
              ))}
            </div>
          </div>

          <div className="pair-fields">
            <Select
              label="Measure"
              value={q.measure}
              onChange={(v) => setMeasure(v as MetricMeasure)}
              options={measures}
            />
            {q.measure === "share" && (
              <Select
                label="Outcome"
                value={q.field ?? "block"}
                onChange={(field) => setQuery({ field })}
                options={OUTCOMES}
              />
            )}
            {q.measure === "avg" && q.source === "decisions" && (
              <Select
                label="Of"
                value={q.field ?? "risk_score"}
                onChange={(field) => setQuery({ field })}
                options={[
                  ["risk_score", "risk score"],
                  ["probability", "probability"],
                ]}
              />
            )}
            {(q.measure === "sum" || q.measure === "avg") && q.source === "events" && (
              <Select
                label="Property"
                value={q.field ?? ""}
                onChange={(field) => setQuery({ field: field || undefined })}
                options={numeric}
                none={q.filters.event_type ? "Choose a property" : "Choose an event type first"}
              />
            )}
            {q.measure === "unique" && q.source === "events" && (
              <Select
                label="Entity type"
                value={q.field ?? "user"}
                onChange={(field) => setQuery({ field })}
                options={options?.entity_types ?? ["user"]}
              />
            )}
          </div>

          <div className="field">
            <span>Filters</span>
            <div className="pair-fields">
              {q.source === "decisions" && (
                <>
                  <Select
                    label="Action"
                    value={q.filters.action ?? ""}
                    onChange={(action) => setFilter({ action })}
                    options={options?.actions ?? []}
                    none="Any action"
                  />
                  <Select
                    label="Outcome"
                    value={q.filters.outcome ?? ""}
                    onChange={(outcome) => setFilter({ outcome })}
                    options={OUTCOMES}
                    none="Any outcome"
                  />
                  <Select
                    label="Final outcome"
                    value={q.filters.final_outcome ?? ""}
                    onChange={(final_outcome) => setFilter({ final_outcome })}
                    options={OUTCOMES}
                    none="Any"
                  />
                  <Select
                    label="Signal"
                    value={q.filters.signal ?? ""}
                    onChange={(signal) => setFilter({ signal })}
                    options={options?.signals ?? []}
                    none="Any signal"
                  />
                  <Select
                    label="Subject label"
                    value={q.filters.subject_label ?? ""}
                    onChange={(subject_label) => setFilter({ subject_label })}
                    options={[
                      ["*", "Has a label"],
                      ["!", "Has no label"],
                      ...(options?.labels ?? []).map((l) => [l, l.replaceAll("_", " ")] as [string, string]),
                    ]}
                    none="Any"
                  />
                </>
              )}
              {q.source === "events" && (
                <>
                  <Select
                    label="Event type"
                    value={q.filters.event_type ?? ""}
                    onChange={(event_type) =>
                      setTile((t) => ({
                        ...t,
                        query: {
                          ...t.query,
                          filters: event_type ? { event_type } : {},
                          field: t.query.measure === "unique" ? t.query.field : undefined,
                          group_by: t.query.group_by === "event_type" ? "event_type" : undefined,
                        },
                      }))
                    }
                    options={options?.event_types ?? []}
                    none="Any event type"
                  />
                  <Select
                    label="Names an entity of type"
                    value={q.filters.entity_type ?? ""}
                    onChange={(entity_type) => setFilter({ entity_type })}
                    options={options?.entity_types ?? []}
                    none="Any"
                  />
                  {q.filters.event_type && (
                    <>
                      <Select
                        label="Property"
                        value={q.filters.property?.name ?? ""}
                        onChange={(name) =>
                          setFilter({ property: name ? { name, value: q.filters.property?.value ?? "" } : undefined })
                        }
                        options={properties}
                        none="No property filter"
                      />
                      {q.filters.property && (
                        <label className="field">
                          <span>Equals</span>
                          <input
                            className="input mono"
                            value={q.filters.property.value}
                            onChange={(e) =>
                              setFilter({ property: { name: q.filters.property!.name, value: e.target.value } })
                            }
                          />
                        </label>
                      )}
                    </>
                  )}
                </>
              )}
              {q.source === "labels" && (
                <>
                  <Select
                    label="Label"
                    value={q.filters.label ?? ""}
                    onChange={(label) => setFilter({ label })}
                    options={options?.labels ?? []}
                    none="Any label"
                  />
                  <Select
                    label="Entity type"
                    value={q.filters.entity_type ?? ""}
                    onChange={(entity_type) => setFilter({ entity_type })}
                    options={options?.entity_types ?? []}
                    none="Any"
                  />
                </>
              )}
            </div>
          </div>

          <div className="pair-fields">
            <Select
              label="Group by"
              value={q.group_by ?? ""}
              onChange={(group_by) => setQuery({ group_by: group_by || undefined })}
              options={groups}
              none="No grouping"
            />
            <Select
              label="Link to a page"
              value={tile.link && tile.link !== "none" ? tile.link : ""}
              onChange={(link) => setTile({ ...tile, link: (link || undefined) as Tile["link"] })}
              options={[
                ["decisions", "Decisions"],
                ["entities", "Entities"],
                ["actions", "Actions"],
              ]}
              none="No link"
            />
            <Select
              label="Width"
              value={String(tile.w)}
              onChange={(w) => setTile({ ...tile, w: Number(w) })}
              options={[2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(
                (n) => [String(n), `${n} of 12 columns`] as [string, string],
              )}
            />
          </div>
        </div>

        <div className="stack" style={{ gap: 14 }}>
          <div className="field">
            <span>Show as</span>
            <div className="view-picker">
              {VIEWS.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  className={tile.view === v.id ? "on" : ""}
                  onClick={() => setTile({ ...tile, view: v.id })}
                >
                  {v.label}
                </button>
              ))}
            </div>
            <small>
              {view.note}
              {tile.view === "number" && q.group_by ? " The group is not used." : ""}
            </small>
          </div>
          <div className="card panel preview">
            <div className="panel-head">
              <h3>{tile.title.trim() || "Preview"}</h3>
            </div>
            <p className="tile-note">{describeTile(tile)}</p>
            {tile.view === "hbar" && !q.group_by ? (
              <div className="tile-wait muted">Choose a group to rank.</div>
            ) : (
              <TileBody tile={tile} range={range} />
            )}
          </div>
          <div className="modal-foot">
            {problem && (
              <span className="muted" style={{ marginRight: "auto", alignSelf: "center" }}>
                {problem}
              </span>
            )}
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" disabled={!!problem}>
              {initial ? "Save tile" : "Add tile"}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

type Shown = Dashboard["visibility"];
const VISIBILITY: Record<Shown, string> = { private: "Private", workspace: "Visible to others" };

function DashboardModal({
  title,
  action,
  initial,
  onSubmit,
  onClose,
}: {
  title: string;
  action: string;
  initial?: { name: string; visibility: Shown };
  onSubmit: (name: string, visibility: Shown, overview: boolean) => Promise<unknown>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [visibility, setVisibility] = useState<Shown>(initial?.visibility ?? "private");
  const [overview, setOverview] = useState(true);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={title} onClose={onClose}>
      <form
        className="modal-body"
        onSubmit={(e) => (
          e.preventDefault(),
          onSubmit(name, visibility, overview).catch((x: Error) => setError(x.message))
        )}
      >
        {error && (
          <div className="banner" style={{ margin: 0 }}>
            {error}
          </div>
        )}
        <label className="field">
          <span>Name</span>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            placeholder="Fraud overview"
            required
            autoFocus
          />
        </label>
        <div className="field">
          <span>Who can see it</span>
          <div className="key-kinds">
            <button
              type="button"
              className={`template ${visibility === "private" ? "on" : ""}`}
              onClick={() => setVisibility("private")}
            >
              <b>Private</b>
              <span>Only you.</span>
            </button>
            <button
              type="button"
              className={`template ${visibility === "workspace" ? "on" : ""}`}
              onClick={() => setVisibility("workspace")}
            >
              <b>Visible to others</b>
              <span>Everyone in the workspace. They can change its tiles.</span>
            </button>
          </div>
        </div>
        {!initial && (
          <label className={`check ${overview ? "on" : ""}`}>
            <input type="checkbox" checked={overview} onChange={(e) => setOverview(e.target.checked)} />
            Start with the Overview tiles
          </label>
        )}
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary">{action}</button>
        </div>
      </form>
    </Modal>
  );
}

const GRID_ICON = (
  <svg viewBox="0 0 20 20" className="dash-icon">
    <rect x="3" y="3" width="6" height="8" rx="1.2" />
    <rect x="11" y="3" width="6" height="5" rx="1.2" />
    <rect x="3" y="13" width="6" height="4" rx="1.2" />
    <rect x="11" y="10" width="6" height="7" rx="1.2" />
  </svg>
);

const LOCK = <path d="M6 9V7a4 4 0 0 1 8 0v2M5 9h10v7.5H5z" />;
const PEOPLE = (
  <>
    <circle cx="7.5" cy="7" r="2.8" />
    <path d="M2.5 16.5c.4-2.8 2.4-4.300 5-4.300s4.600 1.5 5 4.300M13.5 4.600a2.600 2.600 0 0 1 0 4.900M15 12.600c1.4.5 2.300 1.8 2.5 3.900" />
  </>
);
const Visibility = ({ of }: { of: Shown }) => (
  <span className="visibility">
    <svg viewBox="0 0 20 20">{of === "private" ? LOCK : PEOPLE}</svg>
    {VISIBILITY[of]}
  </span>
);

function DashboardPicker({ all, current, onNew }: { all: Dashboard[]; current: Dashboard | null; onNew: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const groups: [string, Dashboard[]][] = [
    ["Mine", all.filter((d) => d.mine)],
    ["Shared with the workspace", all.filter((d) => !d.mine)],
  ];
  return (
    <div className="menu-anchor" ref={ref}>
      <button className="dash-picker" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open}>
        <b>{current?.name ?? "Choose a dashboard"}</b>
        <svg className="caret" viewBox="0 0 20 20">
          <path d="m6 8 4 4 4-4" />
        </svg>
      </button>
      {current && <Visibility of={current.visibility} />}
      {open && (
        <div className="menu dash-menu" role="menu">
          {groups.flatMap(([label, list]) =>
            list.length === 0
              ? []
              : [
                  <div className="menu-label" key={label}>
                    {label}
                  </div>,
                  ...list.map((d) => (
                    <button
                      key={d.id}
                      role="menuitem"
                      className={d.id === current?.id ? "on" : ""}
                      onClick={() => (setOpen(false), go("dashboards", d.id))}
                    >
                      {GRID_ICON}
                      <span className="grow">
                        {d.name}
                        <small>
                          {d.tiles.length} {d.tiles.length === 1 ? "tile" : "tiles"} ·{" "}
                          {VISIBILITY[d.visibility].toLowerCase()}
                        </small>
                      </span>
                      {d.id === current?.id && (
                        <svg className="dash-icon" viewBox="0 0 20 20">
                          <path d="m5 10.5 3.5 3.5L15 6.5" />
                        </svg>
                      )}
                    </button>
                  )),
                ],
          )}
          {all.length > 0 && <hr />}
          <button role="menuitem" onClick={() => (setOpen(false), onNew())}>
            <svg className="dash-icon" viewBox="0 0 20 20">
              <path d="M10 4.5v11M4.5 10h11" />
            </svg>
            <span className="grow">New dashboard</span>
          </button>
        </div>
      )}
    </div>
  );
}

const LAST = "kairos.dashboard";
const recall = () => {
  try {
    return localStorage.getItem(LAST);
  } catch {
    return null;
  }
};
const overviewTiles = () => OVERVIEW.map((i) => ({ id: newId(), ...structuredClone(TEMPLATES[i]!) }));
const clampWidth = (w: number) => Math.min(12, Math.max(2, Math.round(w)));

export function Dashboards({ id }: { id?: string }) {
  const list = useDashboards();
  const all = list.data?.dashboards ?? [];
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [missing, setMissing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [tileEditor, setTileEditor] = useState<Tile | "new" | null>(null);
  const [modal, setModal] = useState<"new" | "settings" | null>(null);
  const [menu, setMenu] = useState(false);
  const menuRef = useDismiss(menu, () => setMenu(false));
  const [problem, setProblem] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const latest = useRef<Dashboard | null>(null);
  latest.current = dashboard;
  const stored = useRef<Dashboard | null>(null);

  useEffect(() => {
    if (id || !list.data) return;
    const known = all.find((d) => d.id === recall()) ?? all[0];
    if (known) go("dashboards", known.id);
  }, [id, list.data]);

  useEffect(() => {
    setDashboard(null);
    setMissing(false);
    setEditing(false);
    if (!id) return;
    let current = true;
    api.dashboard(id).then(
      (d) => {
        if (!current) return;
        stored.current = d;
        setDashboard(d);
        try {
          localStorage.setItem(LAST, d.id);
        } catch {}
      },
      () => current && setMissing(true),
    );
    return () => {
      current = false;
    };
  }, [id]);

  const save = (next: Dashboard) => {
    setDashboard(next);
    return api.saveDashboard(next).then(
      (saved) => {
        stored.current = saved;
        setProblem(null);
        setDashboard((now) => (now && now.id === saved.id ? { ...saved, tiles: now.tiles } : now));
        if (
          saved.name !== all.find((d) => d.id === saved.id)?.name ||
          saved.visibility !== all.find((d) => d.id === saved.id)?.visibility
        )
          list.refetch();
      },
      (e: Error) => (setProblem(e.message), setDashboard(stored.current)),
    );
  };
  const create = (name: string, visibility: Shown, overview: boolean) =>
    api
      .createDashboard({ name, visibility, range: "30d", tiles: overview ? overviewTiles() : [] })
      .then((d) => (setModal(null), list.refetch(), go("dashboards", d.id)));
  const remove = () =>
    dashboard &&
    window.confirm(`Delete "${dashboard.name}"? This can't be undone.`) &&
    api.deleteDashboard(dashboard.id).then(
      () => (list.refetch(), go("dashboards")),
      (e: Error) => setProblem(e.message),
    );

  const tiles = dashboard?.tiles ?? [];
  const setTiles = (next: Tile[]) => setDashboard((d) => (d ? { ...d, tiles: next } : d));
  const resize = (tile: Tile, w: number) =>
    save({ ...dashboard!, tiles: tiles.map((t) => (t.id === tile.id ? { ...t, w: clampWidth(w) } : t)) });

  const dragOver = (event: React.DragEvent, over: Tile) => {
    if (!dragging) return;
    event.preventDefault();
    if (dragging === over.id) return;
    const from = tiles.findIndex((t) => t.id === dragging);
    const to = tiles.findIndex((t) => t.id === over.id);
    const next = [...tiles];
    next.splice(to, 0, next.splice(from, 1)[0]!);
    setTiles(next);
  };
  const dragEnd = () => {
    setDragging(null);
    if (
      dashboard &&
      JSON.stringify(dashboard.tiles.map((t) => t.id)) !== JSON.stringify(stored.current?.tiles.map((t) => t.id))
    )
      save(dashboard);
  };

  const startResize = (event: React.PointerEvent, tile: Tile) => {
    event.preventDefault();
    event.stopPropagation();
    const box = (event.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    const column = grid.current!.getBoundingClientRect().width / 12;
    let width = tile.w;
    const onMove = (move: PointerEvent) => {
      width = clampWidth((move.clientX - box.left) / column);
      setDashboard((d) => (d ? { ...d, tiles: d.tiles.map((t) => (t.id === tile.id ? { ...t, w: width } : t)) } : d));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (width !== tile.w && latest.current) save(latest.current);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <>
      <InTopbar slot="trail-slot">
        <DashboardPicker all={all} current={dashboard} onNew={() => setModal("new")} />
      </InTopbar>
      {dashboard && (
        <InTopbar slot="topbar-slot">
          <div className="seg tight">
            {RANGES.map((r) => (
              <button
                key={r.id}
                className={dashboard.range === r.id ? "on" : ""}
                onClick={() => save({ ...dashboard, range: r.id })}
              >
                {r.id}
              </button>
            ))}
          </div>
          {editing && (
            <button className="btn solid" onClick={() => setEditing(false)}>
              ✓ Done
            </button>
          )}
          <button className="btn primary" onClick={() => setTileEditor("new")}>
            + Add tile
          </button>
          <div className="menu-anchor" ref={menuRef}>
            <button
              className="btn"
              aria-label="More"
              aria-haspopup="menu"
              aria-expanded={menu}
              onClick={() => setMenu(!menu)}
            >
              ⋯
            </button>
            {menu && (
              <div className="menu end" role="menu">
                <button role="menuitem" onClick={() => (setMenu(false), setEditing(!editing))}>
                  {editing ? "Finish editing the layout" : "Edit layout"}
                </button>
                <hr />
                {dashboard.can_manage ? (
                  <>
                    <button role="menuitem" onClick={() => (setMenu(false), setModal("settings"))}>
                      Rename or change who sees it
                    </button>
                    <hr />
                    <button role="menuitem" className="danger" onClick={() => (setMenu(false), remove())}>
                      Delete dashboard
                    </button>
                  </>
                ) : (
                  <div className="menu-who">
                    <small>Only the person who made this dashboard can rename or delete it.</small>
                  </div>
                )}
              </div>
            )}
          </div>
        </InTopbar>
      )}

      {problem && <Failure message={problem} />}
      {list.error && <Failure message={list.error.message} />}
      {missing ? (
        <div className="card">
          <Empty title="Dashboard not found">It was deleted, or it is private. Choose another one at the top.</Empty>
        </div>
      ) : !id && list.data && all.length === 0 ? (
        <div className="card">
          <Empty title="No dashboards yet">
            Build your own view of decisions, events and labels.
            <div style={{ marginTop: 14 }}>
              <button className="btn primary" onClick={() => setModal("new")}>
                New dashboard
              </button>
            </div>
          </Empty>
        </div>
      ) : !dashboard ? (
        <DashSkeleton numbers={4} panels={[8, 4, 6, 6]} />
      ) : tiles.length === 0 ? (
        <div className="card">
          <Empty title="No tiles yet">
            Add a tile, or start with the same numbers as the Overview page.
            <div className="row" style={{ marginTop: 14, justifyContent: "center" }}>
              <button className="btn" onClick={() => save({ ...dashboard, tiles: overviewTiles() })}>
                Add the Overview tiles
              </button>
              <button className="btn primary" onClick={() => setTileEditor("new")}>
                Add tile
              </button>
            </div>
          </Empty>
        </div>
      ) : (
        <div className={`dash tiles ${editing ? "editing" : ""}`} ref={grid}>
          {tiles.map((tile) => (
            <section
              key={tile.id}
              className={`card panel dtile ${dragging === tile.id ? "dragging" : ""}`}
              style={{ "--w": tile.w, "--w-medium": Math.min(12, tile.w * 2) } as CSSProperties}
              draggable={editing}
              onDragStart={(e) => (
                e.dataTransfer.setData("text/plain", tile.id),
                (e.dataTransfer.effectAllowed = "move"),
                setDragging(tile.id)
              )}
              onDragOver={(e) => dragOver(e, tile)}
              onDrop={(e) => e.preventDefault()}
              onDragEnd={dragEnd}
            >
              <div className="panel-head">
                <h3>{tile.title}</h3>
                {!editing && linkOf(tile) && (
                  <a className="tile-link" href={linkOf(tile)!.href} title={`Open ${linkOf(tile)!.label}`}>
                    {linkOf(tile)!.label}
                    <svg viewBox="0 0 20 20">
                      <path d="M7 5h8v8M15 5 5 15" />
                    </svg>
                  </a>
                )}
                {editing && (
                  <div className="tile-tools">
                    <button
                      className="step"
                      title="Narrower"
                      disabled={tile.w <= 2}
                      onClick={() => resize(tile, tile.w - 1)}
                    >
                      −
                    </button>
                    <span className="width" title="Columns of 12">
                      {tile.w}
                    </span>
                    <button
                      className="step"
                      title="Wider"
                      disabled={tile.w >= 12}
                      onClick={() => resize(tile, tile.w + 1)}
                    >
                      +
                    </button>
                    <button className="step" title="Edit tile" onClick={() => setTileEditor(tile)}>
                      ✎
                    </button>
                    <button
                      className="step"
                      title="Remove tile"
                      onClick={() => save({ ...dashboard, tiles: tiles.filter((t) => t.id !== tile.id) })}
                    >
                      ×
                    </button>
                  </div>
                )}
              </div>
              <p className="tile-note">{describeTile(tile)}</p>
              <TileBody tile={tile} range={dashboard.range} />
              {editing && (
                <div className="resize-handle" title="Drag to resize" onPointerDown={(e) => startResize(e, tile)} />
              )}
            </section>
          ))}
        </div>
      )}
      {editing && tiles.length > 0 && (
        <p className="note" style={{ marginTop: 14 }}>
          Drag a tile to move it. Drag its right edge, or use − and +, to change its width.
        </p>
      )}

      {tileEditor && dashboard && (
        <TileEditor
          initial={tileEditor === "new" ? null : tileEditor}
          range={dashboard.range}
          onClose={() => setTileEditor(null)}
          onSave={(tile) => (
            setTileEditor(null),
            save({
              ...dashboard,
              tiles: tiles.some((t) => t.id === tile.id)
                ? tiles.map((t) => (t.id === tile.id ? tile : t))
                : [...tiles, tile],
            })
          )}
        />
      )}
      {modal === "new" && (
        <DashboardModal
          title="New dashboard"
          action="Create dashboard"
          onSubmit={create}
          onClose={() => setModal(null)}
        />
      )}
      {modal === "settings" && dashboard && (
        <DashboardModal
          title="Dashboard settings"
          action="Save"
          initial={dashboard}
          onSubmit={(name, visibility) => save({ ...dashboard, name, visibility }).then(() => setModal(null))}
          onClose={() => setModal(null)}
        />
      )}
    </>
  );
}
