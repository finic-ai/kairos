import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { api } from "../../api/index";
import { colorOf, formatValue, TimeChart } from "../../components/charts/charts";
import { RecordModal } from "../../components/entities/RecordModal";
import { PAGE_SIZES, Pager } from "../../components/ui/Pager";
import { ChartSkeleton, Skeleton, type SkeletonColumn, TableRowsSkeleton } from "../../components/ui/Skeleton";
import { Empty, Failure } from "../../components/ui/states";
import { useApi } from "../../hooks/useApi";
import { useLiveEvents } from "../../hooks/useLiveEvents";
import { preciseStamp } from "../../lib/format";
import { hashQuery, href } from "../../lib/route";
import type { StoredEvent } from "../../types/interfaces";

const head = (
  <thead>
    <tr>
      <th>
        Time <span className="unit">UTC</span>
      </th>
      <th>Type</th>
      <th>Status</th>
      <th>Entities</th>
      <th className="hide-md">Properties</th>
    </tr>
  </thead>
);

const COLUMNS: SkeletonColumn[] = [
  { width: 170 },
  { width: 110 },
  { width: 70 },
  { width: 180 },
  { width: 220, className: "hide-md" },
];

const RANGES: [string, string, number][] = [
  ["1h", "Last hour", 3600_000],
  ["24h", "Last 24 hours", 24 * 3600_000],
  ["7d", "Last 7 days", 7 * 24 * 3600_000],
  ["30d", "Last 30 days", 30 * 24 * 3600_000],
];

const ICONS = {
  play: "M6 4.5v11l9-5.5z",
  pause: "M5.5 4.5h3v11h-3zM11.5 4.5h3v11h-3z",
  stop: "M5 5h10v10H5z",
};

const Icon = ({ name }: { name: keyof typeof ICONS }) => (
  <svg className="btn-icon" viewBox="0 0 20 20" aria-hidden="true">
    <path d={ICONS[name]} />
  </svg>
);

const SHOWN_PROPERTIES = 3;

function value(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "object") return Array.isArray(v) ? v.map(value).join(", ") : JSON.stringify(v);
  return String(v);
}

function Properties({ event }: { event: StoredEvent }) {
  const entries = Object.entries(event.properties ?? {});
  if (!entries.length) return <span className="muted">—</span>;
  return (
    <span className="event-props">
      {entries.slice(0, SHOWN_PROPERTIES).map(([k, v]) => (
        <span key={k}>
          <span className="mono">{k}</span> {value(v).slice(0, 40)}
        </span>
      ))}
      {entries.length > SHOWN_PROPERTIES && <span className="more">+{entries.length - SHOWN_PROPERTIES}</span>}
    </span>
  );
}

function Rows({
  events,
  tone,
  arriving,
  onOpen,
}: {
  events: StoredEvent[];
  tone: (type: string) => string;
  arriving?: boolean;
  onOpen: (id: string) => void;
}) {
  return (
    <table>
      {head}
      <tbody>
        {events.map((e) => {
          const at = preciseStamp(e.ts);
          return (
            <tr
              key={e.id}
              className={`link ${arriving ? "arrive" : ""}`}
              style={{ "--tone": tone(e.type) } as CSSProperties}
              onClick={() => onOpen(e.id)}
            >
              <td className="mono event-time">
                {at.slice(0, 19)}
                <span className="muted">{at.slice(19)}</span>
              </td>
              <td className="mono event-type">{e.type}</td>
              <td>{e.status ? <span className="chip">{e.status}</span> : <span className="muted">—</span>}</td>
              <td className="wrap">
                {Object.entries(e.entities).map(([t, id]) => (
                  <a
                    key={t}
                    className="chip mono"
                    href={href("entities", t, id)}
                    onClick={(ev) => ev.stopPropagation()}
                    title={`${t} ${id}`}
                  >
                    {t}: {id.length > 18 ? `${id.slice(0, 18)}…` : id}
                  </a>
                ))}
              </td>
              <td className="hide-md">
                <Properties event={e} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** `/events`: the events of a period, newest first, with a chart of them; or the events as they arrive. */
export function EventsPage() {
  const [, setSearchParams] = useSearchParams();
  const asked = hashQuery();
  const [type, setType] = useState(asked.get("type") ?? "");
  const [status, setStatus] = useState(asked.get("status") ?? "");
  const [entityType, setEntityType] = useState(asked.get("entity_type") ?? "");
  const [entityId, setEntityId] = useState(asked.get("entity_id") ?? "");
  const [range, setRange] = useState(() =>
    RANGES.some(([id]) => id === asked.get("range")) ? asked.get("range")! : "",
  );
  // The period ends at the moment it was chosen or refreshed, so that the list and the chart agree.
  const [until, setUntil] = useState(() => Date.now());
  const [live, setLive] = useState(asked.get("live") === "1");
  const [paused, setPaused] = useState(false);
  const [size, setSize] = useState(() =>
    PAGE_SIZES.includes(Number(asked.get("size"))) ? Number(asked.get("size")) : 50,
  );
  const [page, setPage] = useState(() => Math.max(1, Math.floor(Number(asked.get("page"))) || 1));
  const [open, setOpen] = useState<string | null>(null);
  const filter = (change: () => void) => (change(), setPage(1));

  const options = useApi(["metric-options"], () => api.metricOptions());
  const entity = entityType && entityId.trim() ? { type: entityType, id: entityId.trim() } : undefined;
  const query = { type, status: status.trim(), entity };
  const span = RANGES.find(([id]) => id === range)?.[2];
  const period = span
    ? { from: new Date(until - span).toISOString(), to: new Date(until).toISOString() }
    : { to: new Date(until).toISOString() };
  const filtered = !!(type || query.status || entity);
  const list = useApi(
    ["events", { ...query, ...period, size, page }],
    () => api.events({ ...query, ...period, limit: size, offset: (page - 1) * size }),
    { enabled: !live },
  );
  const counts = useApi(["event-counts", { ...query, ...period }], () => api.eventCounts({ ...query, ...period }));
  const arrivals = useLiveEvents(query, live, paused);
  const shown = list.data?.events.length ?? 0;
  const matching = list.data?.total ?? 0;
  const capped = list.data?.total_capped ?? false;

  const tones = useMemo(
    () => new Map((counts.data?.series ?? []).map((s, i) => [s.key, colorOf(s.key, i)])),
    [counts.data],
  );
  const tone = (t: string) => tones.get(t) ?? "var(--ink-3)";
  const refresh = () => (setUntil(Date.now()), setPage(1));

  useEffect(() => {
    const q = new URLSearchParams();
    if (type) q.set("type", type);
    if (query.status) q.set("status", query.status);
    if (entity) {
      q.set("entity_type", entity.type);
      q.set("entity_id", entity.id);
    }
    if (live) q.set("live", "1");
    if (range) q.set("range", range);
    if (page > 1) q.set("page", String(page));
    if (size !== 50) q.set("size", String(size));
    setSearchParams(q, { replace: true });
  }, [type, query.status, entity?.type, entity?.id, live, range, page, size]);

  const error = live ? arrivals.error : list.error?.message;

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Events</h1>
          <p className="lede">
            Everything your systems sent to Kairos, newest first, with the history you imported. Select a row for its
            properties, its entities and the decision it started. Select Live to see events as they arrive.
          </p>
        </div>
      </header>

      {error && <Failure message={error} />}

      <div className="filters events-bar">
        <select
          className="input"
          aria-label="Event type"
          value={type}
          onChange={(e) => filter(() => setType(e.target.value))}
        >
          <option value="">All types</option>
          {(options.data?.event_types ?? []).map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <input
          className="input mono"
          aria-label="Status"
          placeholder="Status, such as created"
          value={status}
          onChange={(e) => filter(() => setStatus(e.target.value))}
        />
        <select
          className="input"
          aria-label="Entity type"
          value={entityType}
          onChange={(e) => filter(() => setEntityType(e.target.value))}
        >
          <option value="">Any entity</option>
          {(options.data?.entity_types ?? []).map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        {entityType && (
          <input
            className="input mono"
            aria-label="Entity id"
            placeholder={`The ${entityType}'s id`}
            value={entityId}
            onChange={(e) => filter(() => setEntityId(e.target.value))}
          />
        )}
        <span className="spacer" />
        {live ? (
          <>
            <button className="btn" onClick={() => setPaused(!paused)}>
              <Icon name={paused ? "play" : "pause"} />
              {paused ? "Resume" : "Pause"}
            </button>
            <button className="btn" onClick={() => (setLive(false), setPaused(false), refresh())}>
              <Icon name="stop" />
              Stop
            </button>
          </>
        ) : (
          <>
            <button className="btn" onClick={() => (setLive(true), setPaused(false))}>
              <Icon name="play" />
              Live
            </button>
            <select
              className="input"
              aria-label="Period"
              value={range}
              onChange={(e) => (setRange(e.target.value), refresh())}
            >
              <option value="">All time</option>
              {RANGES.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
            <button className="btn" onClick={refresh}>
              Refresh
            </button>
          </>
        )}
      </div>

      {!live && (!counts.data || counts.data.buckets.length > 0) && (
        <div className="card events-chart">
          <div className="events-chart-head">
            <b>Events over time</b>
            {counts.data && (
              <span className="muted">
                {formatValue(counts.data.total, "count")} {counts.data.total === 1 ? "event" : "events"}
              </span>
            )}
          </div>
          {counts.data ? (
            <TimeChart
              data={{ ...counts.data, unit: "count", truncated: false }}
              kind="stacked"
              interval={counts.data.step_seconds >= 86_400 ? "day" : "hour"}
              height={150}
            />
          ) : (
            <ChartSkeleton height={150} />
          )}
        </div>
      )}

      <div className="card table-wrap events-table">
        {live ? (
          <>
            <div className="table-head live-head">
              <i className={`live-dot ${paused ? "off" : ""}`} />
              <b>{paused ? "Paused" : "Live"}</b>
              <span className="muted">
                {arrivals.arrived.toLocaleString()} {arrivals.arrived === 1 ? "event" : "events"}
                {filtered ? " matching" : ""}
                {arrivals.arrived > arrivals.events.length
                  ? `, the newest ${arrivals.events.length.toLocaleString()} shown`
                  : ""}
              </span>
            </div>
            {arrivals.events.length === 0 ? (
              <div className="empty live-waiting">
                {!paused && <span className="spinner" />}
                <b>{paused ? "Paused" : "Waiting for events…"}</b>
                {paused ? "Select Resume to continue." : "Events appear here as they arrive."}
              </div>
            ) : (
              <Rows events={arrivals.events} tone={tone} arriving onOpen={setOpen} />
            )}
          </>
        ) : (
          <>
            <div className="table-head">
              {!list.data ? (
                <Skeleton width={110} height={12} />
              ) : (
                `${matching.toLocaleString()}${capped ? "+" : ""} ${matching === 1 ? "event" : "events"}${filtered || range ? " matching" : ""}`
              )}
            </div>
            {!list.data ? (
              <table>
                {head}
                <tbody>
                  <TableRowsSkeleton columns={COLUMNS} />
                </tbody>
              </table>
            ) : shown === 0 ? (
              <Empty title="No events match">
                {filtered || range
                  ? "Change the filters or the period."
                  : "Send events from the SDK, or import your history, and they appear here."}
              </Empty>
            ) : (
              <Rows events={list.data.events} tone={tone} onOpen={setOpen} />
            )}
            {matching > 0 && (
              <Pager
                page={page}
                size={size}
                total={matching}
                shown={shown}
                note={capped ? "newest first; counted up to 10,000" : "newest first"}
                onPage={setPage}
                onSize={(n) => (setSize(n), setPage(1))}
              />
            )}
          </>
        )}
      </div>
      {open && <RecordModal link={{ kind: "event", id: open }} onClose={() => setOpen(null)} />}
    </>
  );
}
