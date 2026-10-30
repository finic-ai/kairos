import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { displayName, displayOf } from "@kairos/core";
import { api } from "../../api/index";
import type { EntityFilters, PropertyCondition } from "../../types/interfaces";
import { Pill } from "../../components/decisions/Outcome";
import { AddEntityModal } from "../../components/entities/AddEntityModal";
import { EntityCell } from "../../components/entities/EntityCell";
import { ImportEntitiesModal } from "../../components/entities/ImportEntitiesModal";
import { LabelChips } from "../../components/entities/LabelChips";
import { FilterSelect } from "../../components/ui/FilterSelect";
import { PAGE_SIZES, Pager } from "../../components/ui/Pager";
import { Empty, Failure, Loading } from "../../components/ui/states";
import { dayOf, entityName, entityNames, stamp } from "../../lib/format";
import { useApi } from "../../hooks/useApi";
import { go, hashQuery, href } from "../../lib/route";

const NO_FILTERS: EntityFilters = {
  q: "",
  label: "",
  outcome: "",
  risk_min: "",
  active: "",
  sort: "",
  props: [],
  page: 1,
  size: 50,
};

const OPS: [PropertyCondition["op"], string][] = [
  ["eq", "is"],
  ["ne", "is not"],
  ["contains", "contains"],
  ["gt", "is more than"],
  ["lt", "is less than"],
  ["exists", "is set"],
  ["missing", "is not set"],
];

const needsValue = (op: PropertyCondition["op"]) => op !== "exists" && op !== "missing";

function filtersFromAddress(): EntityFilters {
  const query = hashQuery();
  const text = (key: string) => query.get(key) ?? "";
  return {
    q: text("q"),
    label: text("label"),
    outcome: text("outcome"),
    risk_min: text("risk_min"),
    active: text("active"),
    sort: text("sort"),
    page: Math.max(1, Math.floor(Number(query.get("page"))) || 1),
    size: PAGE_SIZES.includes(Number(query.get("size"))) ? Number(query.get("size")) : 50,
    props: query.getAll("prop").map((raw) => {
      const [name = "", op = "eq", ...rest] = raw.split(":");
      return { name, op: op as PropertyCondition["op"], value: rest.join(":") };
    }),
  };
}

function filtersToQuery(filters: EntityFilters) {
  const query = new URLSearchParams();
  for (const key of ["q", "label", "outcome", "risk_min", "active", "sort"] as const)
    if (filters[key]) query.set(key, filters[key]);
  for (const p of filters.props) if (p.name) query.append("prop", `${p.name}:${p.op}:${p.value}`);
  if (filters.page > 1) query.set("page", String(filters.page));
  if (filters.size !== 50) query.set("size", String(filters.size));
  return query;
}

export function EntityListPage({ type }: { type: string }) {
  const [, setSearchParams] = useSearchParams();
  const [filters, setFilters] = useState<EntityFilters>(filtersFromAddress);
  const [search, setSearch] = useState(filters.q);
  const set = (patch: Partial<EntityFilters>) => setFilters((f) => ({ ...f, page: 1, ...patch }));
  useEffect(() => {
    const timer = setTimeout(
      () => setFilters((f) => (f.q === search.trim() ? f : { ...f, q: search.trim(), page: 1 })),
      250,
    );
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    setSearchParams(filtersToQuery(filters), { replace: true });
  }, [filters]);

  // Only complete conditions are sent, so typing a value does not ask the server on each key.
  const sent = JSON.stringify({
    ...filters,
    props: filters.props.filter((p) => p.name && (p.value !== "" || !needsValue(p.op))),
  });
  const {
    data,
    error,
    refetch: reload,
  } = useApi(["entities", type, sent], () =>
    api.entities({
      type,
      ...(JSON.parse(sent) as EntityFilters),
      limit: filters.size,
      offset: (filters.page - 1) * filters.size,
    }),
  );
  const { data: shape, refetch: reloadShape } = useApi(["entity-shape", type], () =>
    api.entityShape(type).catch(() => null),
  );
  const [importing, setImporting] = useState(false);
  const summary = data?.types.find((t) => t.type === type);
  const display = displayOf(type, summary?.definition);
  const matching = data?.total ?? 0;
  // The last page can go away while you are on it.
  useEffect(() => {
    const pages = Math.max(1, Math.ceil(matching / filters.size));
    if (data && filters.page > pages) setFilters((f) => ({ ...f, page: pages }));
  }, [data, matching, filters.page, filters.size]);
  const subjects =
    (data?.entities.some((e) => e.decision) ?? false) || filters.outcome !== "" || filters.risk_min !== "";
  const [adding, setAdding] = useState(false);

  const properties = [
    ...new Set([
      ...(shape?.properties.map((p) => p.name) ?? []),
      ...Object.keys(summary?.definition?.properties ?? {}),
    ]),
  ];
  const setProp = (index: number, patch: Partial<PropertyCondition>) =>
    set({ props: filters.props.map((p, i) => (i === index ? { ...p, ...patch } : p)) });
  const active =
    [filters.q, filters.label, filters.outcome, filters.risk_min, filters.active].filter(Boolean).length +
    filters.props.length;
  // A property that is filtered on is shown, so the reason for each row is visible.
  const shown = [...new Set(filters.props.map((p) => p.name).filter(Boolean))];

  return (
    <>
      <a className="crumb" href={href("entities")}>
        ← Entities
      </a>
      <header className="page-head">
        <div>
          <h1>{entityNames(type)}</h1>
          <p className="lede">
            {summary?.definition?.description ? `${summary.definition.description.replace(/\.$/, "")}. ` : ""}
            {summary
              ? `${summary.count.toLocaleString()} in total, named by ${(summary.events ?? 0).toLocaleString()} events.`
              : ""}
          </p>
          <div className="row wrap" style={{ marginTop: 12 }}>
            <button className="btn" onClick={() => setAdding(true)}>
              Add {entityName(type)}
            </button>
            <button className="btn" onClick={() => setImporting(true)}>
              Import
            </button>
            <a className="btn ghost" href={href("entity-types", type)}>
              {summary?.definition ? "Edit definition" : "Define this entity"}
            </a>
          </div>
        </div>
      </header>

      {importing && (
        <ImportEntitiesModal type={type} onClose={() => setImporting(false)} onDone={() => (reload(), reloadShape())} />
      )}

      <div className="filter-bar">
        <input
          className="input search"
          placeholder="Search by id"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <FilterSelect
          label="Label"
          value={filters.label}
          onChange={(label) => set({ label })}
          options={[
            ["*", "Has a label"],
            ["!", "Has no label"],
            ...(shape?.labels ?? []).map((l) => [l.label, l.label.replaceAll("_", " ")] as [string, string]),
          ]}
        />
        <FilterSelect
          label="Last decision"
          value={filters.outcome}
          onChange={(outcome) => set({ outcome })}
          options={[
            ["approve", "Approved"],
            ["step_up", "Step-up"],
            ["review", "Review"],
            ["block", "Blocked"],
            ["none", "No decision"],
          ]}
        />
        <FilterSelect
          label="Risk score"
          value={filters.risk_min}
          onChange={(risk_min) => set({ risk_min })}
          options={[
            ["25", "25 or more"],
            ["50", "50 or more"],
            ["75", "75 or more"],
            ["90", "90 or more"],
          ]}
        />
        <FilterSelect
          label="Last active"
          value={filters.active}
          onChange={(active) => set({ active })}
          options={[
            ["24h", "In the last 24 hours"],
            ["7d", "In the last 7 days"],
            ["30d", "In the last 30 days"],
          ]}
        />
        <button
          className="btn"
          onClick={() => set({ props: [...filters.props, { name: properties[0] ?? "", op: "eq", value: "" }] })}
        >
          + Property
        </button>
        {active > 0 && (
          <button
            className="btn ghost"
            onClick={() => (setSearch(""), setFilters({ ...NO_FILTERS, sort: filters.sort, size: filters.size }))}
          >
            Clear {active === 1 ? "filter" : `${active} filters`}
          </button>
        )}
      </div>
      {filters.props.map((p, i) => (
        <div className="filter-row" key={i}>
          <span className="muted">Property</span>
          {properties.length > 0 ? (
            <select className="input mono" value={p.name} onChange={(e) => setProp(i, { name: e.target.value })}>
              {!properties.includes(p.name) && <option value={p.name}>{p.name || "Choose"}</option>}
              {properties.map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          ) : (
            <input
              className="input mono"
              placeholder="country"
              value={p.name}
              onChange={(e) => setProp(i, { name: e.target.value })}
            />
          )}
          <select
            className="input"
            value={p.op}
            onChange={(e) => setProp(i, { op: e.target.value as PropertyCondition["op"] })}
          >
            {OPS.map(([op, text]) => (
              <option key={op} value={op}>
                {text}
              </option>
            ))}
          </select>
          {needsValue(p.op) && (
            <input
              className="input mono"
              placeholder="value"
              value={p.value}
              onChange={(e) => setProp(i, { value: e.target.value })}
              autoFocus={p.value === ""}
            />
          )}
          <button
            className="icon-btn"
            aria-label="Remove this filter"
            onClick={() => set({ props: filters.props.filter((_, at) => at !== i) })}
          >
            ×
          </button>
        </div>
      ))}

      {error && <Failure message={error.message} />}
      {adding && (
        <AddEntityModal
          type={type}
          known={Object.keys(summary?.definition?.properties ?? {})}
          onClose={() => setAdding(false)}
        />
      )}

      <div className="card table-wrap">
        <div className="table-head with-sort">
          <span>
            {data
              ? `${matching.toLocaleString()} ${matching === 1 ? entityName(type) : entityNames(type)}${active > 0 ? " matching" : ""}`
              : "Loading…"}
          </span>
          <select
            className="input sort"
            aria-label="Sort"
            value={filters.sort}
            onChange={(e) => set({ sort: e.target.value })}
          >
            <option value="">Last active first</option>
            <option value="events">Most events first</option>
            <option value="risk">Highest risk first</option>
            <option value="first_seen">Oldest first</option>
          </select>
        </div>
        {!data ? (
          <Loading />
        ) : data.entities.length === 0 ? (
          <Empty title="Nothing matches">
            {active > 0 ? "Change or clear the filters." : `No ${entityNames(type)} yet.`}
          </Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{entityName(type)}</th>
                {shown.map((name) => (
                  <th key={name}>{name}</th>
                ))}
                <th>Labels</th>
                {subjects && <th>Last decision</th>}
                <th style={{ textAlign: "right" }}>Events</th>
                <th className="hide-md" style={{ textAlign: "right" }}>
                  First seen
                </th>
                <th style={{ textAlign: "right" }}>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {data.entities.map((e) => (
                <tr key={e.id} className="link" onClick={() => go("entities", type, e.id)}>
                  <td>
                    <EntityCell id={e.id} name={displayName(display.fields, e.properties)} display={display} />
                  </td>
                  {shown.map((name) => (
                    <td key={name} className="mono muted">
                      {e.properties[name] === undefined
                        ? "—"
                        : typeof e.properties[name] === "object"
                          ? JSON.stringify(e.properties[name])
                          : String(e.properties[name])}
                    </td>
                  ))}
                  <td>{e.labels.length ? <LabelChips labels={e.labels} /> : <span className="muted">—</span>}</td>
                  {subjects && (
                    <td>
                      {e.decision ? (
                        <div className="row">
                          <Pill outcome={e.decision.decision} />
                          <span className="mono muted">{e.decision.risk_score}</span>
                        </div>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  )}
                  <td className="mono" style={{ textAlign: "right" }}>
                    {e.events.toLocaleString()}
                  </td>
                  <td className="mono muted hide-md" style={{ textAlign: "right" }}>
                    {e.first_seen ? dayOf(e.first_seen) : "—"}
                  </td>
                  <td className="mono muted" style={{ textAlign: "right" }}>
                    {e.last_seen ? stamp(e.last_seen) : "no events"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {matching > 0 && (
          <Pager
            page={filters.page}
            size={filters.size}
            total={matching}
            shown={data?.entities.length ?? 0}
            onPage={(page) => setFilters((f) => ({ ...f, page }))}
            onSize={(size) => set({ size })}
          />
        )}
      </div>
    </>
  );
}
