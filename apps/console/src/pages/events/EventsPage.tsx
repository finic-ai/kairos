import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { api } from "../../api/index";
import { RecordModal } from "../../components/entities/RecordModal";
import { PAGE_SIZES, Pager } from "../../components/ui/Pager";
import { Skeleton, type SkeletonColumn, TableRowsSkeleton } from "../../components/ui/Skeleton";
import { Empty, Failure } from "../../components/ui/states";
import { useApi } from "../../hooks/useApi";
import { stamp } from "../../lib/format";
import { hashQuery, href } from "../../lib/route";
import type { StoredEvent } from "../../types/interfaces";

const head = (
  <thead>
    <tr>
      <th>Type</th>
      <th>Status</th>
      <th>Entities</th>
      <th className="hide-md">Properties</th>
      <th style={{ textAlign: "right" }}>Date</th>
    </tr>
  </thead>
);

const COLUMNS: SkeletonColumn[] = [
  { width: 110 },
  { width: 70 },
  { width: 180 },
  { width: 220, className: "hide-md" },
  { width: 90, align: "right" },
];

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
    <span className="note">
      {entries.slice(0, SHOWN_PROPERTIES).map(([k, v], i) => (
        <span key={k}>
          {i > 0 && " · "}
          <span className="mono">{k}</span> {value(v).slice(0, 40)}
        </span>
      ))}
      {entries.length > SHOWN_PROPERTIES && ` · +${entries.length - SHOWN_PROPERTIES}`}
    </span>
  );
}

/** `/events`: every event the workspace has, newest first, imported history included. */
export function EventsPage() {
  const [, setSearchParams] = useSearchParams();
  const asked = hashQuery();
  const [type, setType] = useState(asked.get("type") ?? "");
  const [status, setStatus] = useState(asked.get("status") ?? "");
  const [entityType, setEntityType] = useState(asked.get("entity_type") ?? "");
  const [entityId, setEntityId] = useState(asked.get("entity_id") ?? "");
  const [size, setSize] = useState(() =>
    PAGE_SIZES.includes(Number(asked.get("size"))) ? Number(asked.get("size")) : 50,
  );
  const [page, setPage] = useState(() => Math.max(1, Math.floor(Number(asked.get("page"))) || 1));
  const [open, setOpen] = useState<string | null>(null);
  const filter = (change: () => void) => (change(), setPage(1));

  const options = useApi(["metric-options"], () => api.metricOptions());
  const entity = entityType && entityId.trim() ? { type: entityType, id: entityId.trim() } : undefined;
  const query = { type, status: status.trim(), entity };
  const filtered = !!(type || query.status || entity);
  const list = useApi(["events", { ...query, size, page }], () =>
    api.events({ ...query, limit: size, offset: (page - 1) * size }),
  );
  const shown = list.data?.events.length ?? 0;
  const matching = list.data?.total ?? 0;
  const capped = list.data?.total_capped ?? false;

  useEffect(() => {
    const q = new URLSearchParams();
    if (type) q.set("type", type);
    if (query.status) q.set("status", query.status);
    if (entity) {
      q.set("entity_type", entity.type);
      q.set("entity_id", entity.id);
    }
    if (page > 1) q.set("page", String(page));
    if (size !== 50) q.set("size", String(size));
    setSearchParams(q, { replace: true });
  }, [type, query.status, entity?.type, entity?.id, page, size]);

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Events</h1>
          <p className="lede">
            Everything your systems sent to Kairos, newest first, with the history you imported. Select a row for its
            properties, its entities and the decision it started.
          </p>
        </div>
        <button className="btn" onClick={() => void list.refetch()}>
          Refresh
        </button>
      </header>

      {list.error && <Failure message={list.error.message} />}

      <div className="filters">
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
      </div>

      <div className="card table-wrap">
        <div className="table-head">
          {!list.data ? (
            <Skeleton width={110} height={12} />
          ) : (
            `${matching.toLocaleString()}${capped ? "+" : ""} ${matching === 1 ? "event" : "events"}${filtered ? " matching" : ""}`
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
            {filtered
              ? "Change the filters."
              : "Send events from the SDK, or import your history, and they appear here."}
          </Empty>
        ) : (
          <table>
            {head}
            <tbody>
              {list.data.events.map((e) => (
                <tr key={e.id} className="link" onClick={() => setOpen(e.id)}>
                  <td className="mono">{e.type}</td>
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
                  <td className="mono muted" style={{ textAlign: "right" }}>
                    {stamp(e.ts)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
      </div>
      {open && <RecordModal link={{ kind: "event", id: open }} onClose={() => setOpen(null)} />}
    </>
  );
}
