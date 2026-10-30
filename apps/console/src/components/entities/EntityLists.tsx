import { useEffect, useState, type ReactNode } from "react";
import { api } from "../../api/index";
import { useApi } from "../../hooks/useApi";
import { cellText } from "../../lib/facts";
import { STATUS_LABEL } from "../../lib/queues";
import type { EntityRef, ListPage, Outcome, RowLink } from "../../types/interfaces";

export type ListLoader = (name: string, page: { q?: string; limit: number; offset: number }) => Promise<ListPage>;
import { Pill } from "../decisions/Outcome";
import { Tab, TabStrip } from "../ui/TabStrip";
import { RecordModal } from "./RecordModal";
import { Failure, Loading } from "../ui/states";

const MONO = new Set(["id", "ts", "first_seen", "last_seen"]);
const RIGHT = new Set(["number", "money"]);

function Cell({ column, values }: { column: ListPage["columns"][number]; values: Record<string, unknown> }) {
  const value = values[column.field];
  if (column.field === "decision.outcome" || column.field === "final_outcome")
    return <td>{value ? <Pill outcome={value as Outcome} /> : <span className="muted">—</span>}</td>;
  if (column.field === "status" && typeof value === "string" && value in STATUS_LABEL)
    return (
      <td>
        <span className={`chip ${value === "resolved" ? "ok" : value === "in_review" ? "accent" : ""}`}>
          {STATUS_LABEL[value as keyof typeof STATUS_LABEL]}
        </span>
      </td>
    );
  const right = RIGHT.has(column.format ?? "") || typeof value === "number";
  return (
    <td
      className={MONO.has(column.field) ? "mono muted" : undefined}
      style={right ? { textAlign: "right" } : undefined}
    >
      {cellText(column, values)}
    </td>
  );
}

function ListTable({
  entity,
  list,
  rows,
  marked,
  head,
  load,
  source,
}: {
  entity: EntityRef;
  list: { name: string; label: string };
  rows: number;
  marked?: Set<string>;
  head: (total: number | undefined) => ReactNode;
  load: ListLoader;
  source: string;
}) {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => search.trim() !== q && (setQ(search.trim()), setPage(1)), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const { data, error } = useApi(["entity-list", source, entity.type, entity.id, list.name, q, page, rows], () =>
    load(list.name, { q, limit: rows, offset: (page - 1) * rows }),
  );
  const [opened, setOpened] = useState<RowLink | null>(null);
  const from = (page - 1) * rows + 1;
  const isMarked = (r: ListPage["rows"][number]) => !!marked && (marked.has(r.id) || marked.has(r.link.id));

  return (
    <>
      <div className="table-head">
        {head(data?.total)}
        <input
          className="input compact"
          style={{ width: 180 }}
          placeholder="Search"
          aria-label={`Search ${list.label}`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {error && <Failure message={error.message} />}
      {!data ? (
        !error && <Loading />
      ) : data.rows.length === 0 ? (
        <div className="empty muted">{q ? "Nothing matches." : "None yet."}</div>
      ) : (
        <table>
          <thead>
            <tr>
              {data.columns.map((c) => (
                <th key={c.field} style={RIGHT.has(c.format ?? "") ? { textAlign: "right" } : undefined}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.id} className={`link ${isMarked(r) ? "marked" : ""}`} onClick={() => setOpened(r.link)}>
                {data.columns.map((c) => (
                  <Cell key={c.field} column={c} values={r.values} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data && data.total > rows && (
        <div className="table-foot">
          <span>
            {from.toLocaleString()}–{Math.min(from + rows - 1, data.total).toLocaleString()} of{" "}
            {data.total.toLocaleString()}
          </span>
          <div className="row">
            <button className="btn" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              Previous
            </button>
            <button className="btn" disabled={from + rows > data.total} onClick={() => setPage(page + 1)}>
              Next
            </button>
          </div>
        </div>
      )}
      {opened && <RecordModal link={opened} onClose={() => setOpened(null)} />}
    </>
  );
}

/** `marked`: the ids of a case's own records, set apart from the rest of the history. */
export function EntityLists({
  entity,
  lists,
  rows = 10,
  marked,
  title,
  load = (name, page) => api.entityList(entity, name, page),
  cacheKey = "type",
}: {
  entity: EntityRef;
  lists: { name: string; label: string }[];
  rows?: number;
  marked?: Set<string>;
  title?: string;
  load?: ListLoader;
  /** Where the lists come from, so a case view's list and the type's list of one name are kept apart. */
  cacheKey?: string;
}) {
  const [active, setActive] = useState(lists[0]?.name);
  const list = lists.find((l) => l.name === active) ?? lists[0];
  if (!list) return null;
  const count = (total: number | undefined) =>
    total !== undefined && <span className="count">{total.toLocaleString()}</span>;
  return (
    <div className="card table-wrap entity-list">
      <ListTable
        key={`${entity.type} ${entity.id} ${list.name}`}
        entity={entity}
        list={list}
        rows={rows}
        marked={marked}
        load={load}
        source={cacheKey}
        head={(total) =>
          lists.length === 1 ? (
            <span>
              {title && <span className="muted">{title} · </span>}
              {list.label}
              {total !== undefined && <span className="muted"> · {total.toLocaleString()}</span>}
            </span>
          ) : (
            <TabStrip label={`Lists of this ${entity.type}`} className="tight">
              {title && <span className="tab-title muted">{title}</span>}
              {lists.map((l) => (
                <Tab key={l.name} on={l.name === list.name} onSelect={() => setActive(l.name)}>
                  {l.label}
                  {l.name === list.name && count(total)}
                </Tab>
              ))}
            </TabStrip>
          )
        }
      />
    </div>
  );
}
