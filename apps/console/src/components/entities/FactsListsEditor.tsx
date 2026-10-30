import {
  COLUMN_FORMATS,
  COLUMN_PREFIXES,
  FACT_FORMATS,
  FACT_MEASURES_OF,
  FACT_SOURCES,
  LIST_COLUMNS,
  LIST_SOURCES,
  MAX_FACTS,
  MAX_LISTS,
  MAX_LIST_COLUMNS,
  asColumn,
  columnTitle,
  parseWindow,
  type CaseStatus,
  type ColumnFormat,
  type EntityFact,
  type EntityFilters,
  type EntityList,
  type FactMeasure,
  type FactSource,
  type ListColumn,
  type ListSource,
} from "@kairos/core";
import { useState } from "react";
import { api } from "../../api/index";
import { useApi } from "../../hooks/useApi";
import {
  COLUMN_FORMAT_LABEL,
  FACT_FORMAT_LABEL,
  measureLabel,
  SOURCE_LABEL,
  USUALS,
  WINDOWS,
  factSentence,
  listSentence,
} from "../../lib/facts";
import { OUTCOME_LABEL, OUTCOMES } from "../../lib/outcomes";
import { entityName } from "../../lib/format";
import { STATUS_LABEL, ruleId } from "../../lib/queues";
import type { EntityDefinition, Outcome } from "../../types/interfaces";
import { Card } from "../ui/Card";
import { ChoiceSelect } from "../ui/ChoiceSelect";
import { ColumnPicker } from "../ui/ColumnPicker";
import { MultiSelect } from "../ui/MultiSelect";
import { TemplateModal, type TemplateOption } from "../ui/TemplateModal";

const STARTING_COLUMNS: Record<ListSource, string[]> = {
  events: ["ts", "type", "decision.outcome"],
  decisions: ["ts", "action", "decision.outcome", "decision.risk_score"],
  linked: ["id", "name", "events", "last_seen"],
  cases: ["ts", "queue", "status", "resolution"],
};
const STATUSES = Object.keys(STATUS_LABEL) as CaseStatus[];

const eventTypesOf = (f: EntityFilters | undefined) =>
  f?.event_type === undefined ? [] : Array.isArray(f.event_type) ? f.event_type : [f.event_type];

function Filters({
  source,
  filters,
  onChange,
}: {
  source: FactSource | ListSource;
  filters: EntityFilters | undefined;
  onChange: (filters: EntityFilters | undefined) => void;
}) {
  const { data: options } = useApi(["metric-options", undefined], () => api.metricOptions());
  const f = filters ?? {};
  const set = (patch: EntityFilters) => {
    const next = Object.fromEntries(
      Object.entries({ ...f, ...patch }).filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0)),
    ) as EntityFilters;
    onChange(Object.keys(next).length ? next : undefined);
  };
  if (source === "events" || source === "linked")
    return (
      <>
        <label className="field">
          <span>{source === "linked" ? "Met in events of these types (optional)" : "Event types (optional)"}</span>
          <MultiSelect
            mono
            custom
            label="Event types"
            value={eventTypesOf(f)}
            options={(options?.event_types ?? []).map((t) => ({ value: t, label: t }))}
            onChange={(types) => set({ event_type: types.length ? types : undefined })}
            placeholder="Every event type"
          />
        </label>
        {source === "events" && (
          <div className="field-pair">
            <label className="field">
              <span>Only where the property (optional)</span>
              <input
                className="input mono"
                placeholder="direction"
                value={f.property?.name ?? ""}
                onChange={(e) =>
                  set({
                    property: e.target.value.trim()
                      ? { name: e.target.value.trim(), value: f.property?.value ?? "" }
                      : undefined,
                  })
                }
              />
            </label>
            {f.property && (
              <label className="field">
                <span>Is</span>
                <input
                  className="input mono"
                  placeholder="out"
                  value={f.property.value}
                  onChange={(e) => set({ property: { name: f.property!.name, value: e.target.value } })}
                />
              </label>
            )}
          </div>
        )}
      </>
    );
  if (source === "decisions")
    return (
      <div className="field-pair">
        <label className="field">
          <span>Action (optional)</span>
          <ChoiceSelect
            mono
            value={f.action ?? ""}
            options={options?.actions ?? []}
            placeholder="Every action"
            other="Another action…"
            onChange={(action) => set({ action: action || undefined })}
          />
        </label>
        <label className="field">
          <span>Outcomes (optional)</span>
          <MultiSelect
            label="Outcomes"
            value={f.outcome ?? []}
            options={OUTCOMES.map((o) => ({ value: o, label: OUTCOME_LABEL[o] }))}
            onChange={(outcome) => set({ outcome: outcome.length ? (outcome as Outcome[]) : undefined })}
            placeholder="Every outcome"
          />
        </label>
      </div>
    );
  if (source === "labels")
    return (
      <label className="field">
        <span>Label (optional)</span>
        <ChoiceSelect
          mono
          value={f.label ?? ""}
          options={options?.labels ?? []}
          placeholder="Every label"
          other="Another label…"
          onChange={(label) => set({ label: label || undefined })}
        />
      </label>
    );
  return (
    <label className="field">
      <span>Statuses (optional)</span>
      <MultiSelect
        label="Statuses"
        value={f.status ?? []}
        options={STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))}
        onChange={(status) => set({ status: status.length ? (status as CaseStatus[]) : undefined })}
        placeholder="Every status"
      />
    </label>
  );
}

function Summary({
  label,
  sentence,
  name,
  onOpen,
  onRemove,
}: {
  label: string;
  sentence: string;
  name: string;
  onOpen: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="fact-row closed">
      <button type="button" className="fact-summary" onClick={onOpen}>
        <span className="fact-summary-label">{label || "Untitled"}</span>
        <span className="muted">{sentence}</span>
      </button>
      <span className="mono muted" title="The name a case view uses">
        {name}
      </span>
      <button type="button" className="icon-btn" aria-label={`Remove ${label || "this one"}`} onClick={onRemove}>
        ×
      </button>
    </div>
  );
}

const nameFor = (label: string, taken: string[]) => ruleId(label, taken);

/** Entity templates as they offer facts or lists: the one for this type first. */
function templateOptions(templates: EntityDefinition[], of: "facts" | "lists", type: string): TemplateOption[] {
  return templates
    .filter((t) => t[of]?.length)
    .sort((a, b) => Number(b.type === type) - Number(a.type === type))
    .map((t) => {
      const labels = t[of]!.map((d) => d.label);
      return {
        id: t.type,
        title: entityName(t.type),
        note: t.description,
        meta: `${labels.length} ${of} · ${labels.slice(0, 3).join(", ")}${labels.length > 3 ? ", …" : ""}`,
        suggested: t.type === type,
      };
    });
}

function TemplatePreview<T extends { name: string; label: string }>({
  items,
  taken,
  sentence,
  extra,
}: {
  items: T[];
  taken: string[];
  sentence: (item: T) => string;
  extra?: (item: T) => string;
}) {
  return (
    <div>
      {items.map((d) => (
        <div key={d.name} className="fact-row closed">
          <div className="fact-summary">
            <span className="fact-summary-label">{d.label}</span>
            <span className="muted">{sentence(d)}</span>
            {extra && <span className="muted">{extra(d)}</span>}
          </div>
          {taken.includes(d.name) ? (
            <span className="chip" title="Adding the template keeps the one this type has">
              Already added
            </span>
          ) : (
            <span className="mono muted">{d.name}</span>
          )}
        </div>
      ))}
    </div>
  );
}

/** Adds what the current items do not have by name, up to `max`. */
const merge = <T extends { name: string }>(items: T[], from: T[] | undefined, max: number) => {
  const taken = new Set(items.map((d) => d.name));
  return [...items, ...(from ?? []).filter((d) => !taken.has(d.name))].slice(0, max);
};

function FactRow({
  fact,
  others,
  onChange,
  onRemove,
  onClose,
}: {
  fact: EntityFact;
  /** The names of the other facts; null when this fact was saved, and keeps its name. */
  others: string[] | null;
  onChange: (fact: EntityFact) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const firstType = eventTypesOf(fact.filters)[0];
  const { data: options } = useApi(["metric-options", firstType], () => api.metricOptions(firstType));
  const window = parseWindow(fact.window);
  const set = (patch: Partial<EntityFact>) => {
    const next = { ...fact, ...patch } as EntityFact & Record<string, unknown>;
    for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
    onChange(next);
  };
  const needsField = fact.measure === "sum" || fact.measure === "avg" || fact.measure === "unique";
  const comparable = (fact.measure === "count" || fact.measure === "sum") && window !== null;
  return (
    <div className="fact-row">
      <div className="fact-row-head">
        <input
          className="input grow"
          aria-label="Label"
          placeholder="Payments in 30 days"
          value={fact.label}
          onChange={(e) =>
            set({ label: e.target.value, ...(others ? { name: nameFor(e.target.value || "fact", others) } : {}) })
          }
        />
        <span className="mono muted" title="The name a case view uses">
          {fact.name}
        </span>
        <button type="button" className="btn ghost" onClick={onClose}>
          Done
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label={`Remove ${fact.label || "this fact"}`}
          onClick={onRemove}
        >
          ×
        </button>
      </div>
      <div className="field-pair">
        <label className="field">
          <span>Count from</span>
          <select
            className="input"
            value={fact.source}
            onChange={(e) => {
              const source = e.target.value as FactSource;
              set({ source, measure: "count", field: undefined, filters: undefined, usual: undefined });
            }}
          >
            {FACT_SOURCES.map((s) => (
              <option key={s} value={s}>
                {SOURCE_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>What</span>
          <select
            className="input"
            value={fact.measure}
            onChange={(e) => {
              const measure = e.target.value as FactMeasure;
              set({
                measure,
                field:
                  measure === "sum" || measure === "avg"
                    ? fact.source === "decisions"
                      ? "risk_score"
                      : ""
                    : measure === "unique"
                      ? ""
                      : undefined,
                ...(measure === "count" || measure === "sum" ? {} : { usual: undefined }),
              });
            }}
          >
            {FACT_MEASURES_OF[fact.source].map((m) => (
              <option key={m} value={m}>
                {measureLabel(fact.source, m)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {needsField && fact.source === "events" && (
        <label className="field">
          <span>{fact.measure === "unique" ? "Entity type" : "Property"}</span>
          <ChoiceSelect
            mono
            value={fact.field ?? ""}
            options={
              fact.measure === "unique"
                ? (options?.entity_types ?? [])
                : (options?.event_properties ?? []).filter((p) => p.numeric).map((p) => p.name)
            }
            placeholder={fact.measure === "unique" ? "Choose an entity type" : "Choose a number property"}
            other={fact.measure === "unique" ? "Another entity type…" : "Another property…"}
            onChange={(field) => set({ field })}
          />
        </label>
      )}
      <Filters source={fact.source} filters={fact.filters} onChange={(filters) => set({ filters })} />
      <div className="field-pair">
        <label className="field">
          <span>Over</span>
          <select
            className="input"
            value={fact.window ?? "all"}
            onChange={(e) => {
              const next = e.target.value === "all" ? undefined : e.target.value;
              const ms = parseWindow(next);
              const usual = parseWindow(fact.usual);
              set({ window: next, ...(ms === null || (usual !== null && usual < ms * 2) ? { usual: undefined } : {}) });
            }}
          >
            {WINDOWS.map(([value, text]) => (
              <option key={value} value={value}>
                {value === "all" ? text : `The last ${text}`}
              </option>
            ))}
          </select>
        </label>
        {comparable && (
          <label className="field">
            <span>Compare with the usual over</span>
            <select
              className="input"
              value={fact.usual ?? ""}
              onChange={(e) => set({ usual: e.target.value || undefined })}
            >
              <option value="">No comparison</option>
              {USUALS.filter(([u]) => (parseWindow(u) ?? 0) >= window * 2).map(([value, text]) => (
                <option key={value} value={value}>
                  {text}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {fact.measure !== "first" && fact.measure !== "last" && (
        <div className="field-pair">
          <label className="field">
            <span>Show as</span>
            <select
              className="input"
              value={fact.format ?? "number"}
              onChange={(e) => {
                const format = e.target.value as EntityFact["format"];
                set({
                  format: format === "number" ? undefined : format,
                  ...(format === "money" ? {} : { currency: undefined }),
                });
              }}
            >
              {FACT_FORMATS.map((f) => (
                <option key={f} value={f}>
                  {FACT_FORMAT_LABEL[f]}
                </option>
              ))}
            </select>
          </label>
          {fact.format === "money" && (
            <label className="field">
              <span>Currency</span>
              <input
                className="input mono"
                placeholder="GBP"
                maxLength={3}
                value={fact.currency ?? ""}
                onChange={(e) => set({ currency: e.target.value.toUpperCase() || undefined })}
              />
            </label>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * `saved`: the names already saved. A saved fact keeps its name, as case views use it; a new one takes its label's.
 * With `templates`, the facts of an entity template can be added.
 */
export function FactsEditor({
  facts,
  saved,
  onChange,
  templates,
  type = "",
}: {
  facts: EntityFact[];
  saved: string[];
  onChange: (facts: EntityFact[]) => void;
  templates?: EntityDefinition[];
  type?: string;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const [picking, setPicking] = useState(false);
  const options = templateOptions(templates ?? [], "facts", type);
  const remove = (i: number) => (onChange(facts.filter((_, at) => at !== i)), setOpen(null));
  const add = () => {
    setOpen(facts.length);
    const label = `Fact ${facts.length + 1}`;
    onChange([
      ...facts,
      {
        name: nameFor(
          label,
          facts.map((f) => f.name),
        ),
        label,
        source: "events",
        measure: "count",
        window: "30d",
      },
    ]);
  };
  return (
    <Card title="Facts">
      <p className="section-note">
        Numbers about each entity of this type, from its history: how many payments in 30 days, the money in this week
        against the usual. Its page and the case pages about it show them.
      </p>
      {facts.map((fact, i) =>
        open === i ? (
          <FactRow
            key={i}
            fact={fact}
            others={saved.includes(fact.name) ? null : facts.filter((_, at) => at !== i).map((f) => f.name)}
            onChange={(next) => onChange(facts.map((f, at) => (at === i ? next : f)))}
            onRemove={() => remove(i)}
            onClose={() => setOpen(null)}
          />
        ) : (
          <Summary
            key={i}
            label={fact.label}
            sentence={factSentence(fact)}
            name={fact.name}
            onOpen={() => setOpen(i)}
            onRemove={() => remove(i)}
          />
        ),
      )}
      <div className="row">
        <button type="button" className="btn" disabled={facts.length >= MAX_FACTS} onClick={add}>
          {facts.length >= MAX_FACTS ? `At most ${MAX_FACTS} facts` : "+ Add a fact"}
        </button>
        {options.length > 0 && (
          <button type="button" className="btn" disabled={facts.length >= MAX_FACTS} onClick={() => setPicking(true)}>
            Select from templates
          </button>
        )}
      </div>
      {picking && (
        <TemplateModal
          title="Facts"
          options={options}
          apply="Add facts"
          details={(id) => (
            <TemplatePreview
              items={templates!.find((t) => t.type === id)!.facts ?? []}
              taken={facts.map((f) => f.name)}
              sentence={factSentence}
            />
          )}
          onPick={(id) => (
            onChange(merge(facts, templates!.find((t) => t.type === id)!.facts, MAX_FACTS)),
            setOpen(null),
            setPicking(false)
          )}
          onClose={() => setPicking(false)}
        />
      )}
    </Card>
  );
}

/** The format of one column or field, and its currency when it is money. `prefix`: the hint for a currency field. */
export function ColumnFormatControls({
  column,
  prefix,
  onChange,
}: {
  column: ListColumn;
  prefix?: string;
  onChange: (column: ListColumn) => void;
}) {
  const set = (patch: Partial<ListColumn>) => {
    const next = { ...column, ...patch } as ListColumn & Record<string, unknown>;
    for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
    onChange(next);
  };
  return (
    <>
      <select
        className="input compact"
        aria-label={`Format of ${columnTitle(column)}`}
        value={column.format ?? ""}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          const format = (e.target.value || undefined) as ColumnFormat | undefined;
          set({ format, ...(format === "money" ? {} : { currency: undefined }) });
        }}
      >
        <option value="">Auto</option>
        {COLUMN_FORMATS.map((f) => (
          <option key={f} value={f}>
            {COLUMN_FORMAT_LABEL[f]}
          </option>
        ))}
      </select>
      {column.format === "money" && (
        <input
          className="input compact mono"
          style={{ width: 130 }}
          aria-label={`Currency of ${columnTitle(column)}`}
          placeholder={prefix ? `GBP or ${prefix}currency` : "GBP"}
          value={column.currency ?? ""}
          onChange={(e) => set({ currency: e.target.value.trim() || undefined })}
        />
      )}
    </>
  );
}

function ListRow({
  list,
  others,
  onChange,
  onRemove,
  onClose,
}: {
  list: EntityList;
  /** The names of the other lists; null when this list was saved, and keeps its name. */
  others: string[] | null;
  onChange: (list: EntityList) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const { data: options } = useApi(["metric-options", undefined], () => api.metricOptions());
  const set = (patch: Partial<EntityList>) => {
    const next = { ...list, ...patch } as EntityList & Record<string, unknown>;
    for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
    onChange(next);
  };
  const columns = list.columns.map(asColumn);
  const prefix = COLUMN_PREFIXES[list.source];
  const setColumns = (fields: string[]) =>
    set({
      columns: fields.map((field) => {
        const kept = columns.find((c) => c.field === field);
        return kept && Object.keys(kept).length > 1 ? kept : field;
      }),
    });
  return (
    <div className="fact-row">
      <div className="fact-row-head">
        <input
          className="input grow"
          aria-label="Label"
          placeholder="Payments"
          value={list.label}
          onChange={(e) =>
            set({ label: e.target.value, ...(others ? { name: nameFor(e.target.value || "list", others) } : {}) })
          }
        />
        <span className="mono muted" title="The name a case view uses">
          {list.name}
        </span>
        <button type="button" className="btn ghost" onClick={onClose}>
          Done
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label={`Remove ${list.label || "this list"}`}
          onClick={onRemove}
        >
          ×
        </button>
      </div>
      <div className="field-pair">
        <label className="field">
          <span>Show</span>
          <select
            className="input"
            value={list.source}
            onChange={(e) => {
              const source = e.target.value as ListSource;
              set({
                source,
                entity_type: source === "linked" ? "" : undefined,
                filters: undefined,
                columns: STARTING_COLUMNS[source],
              });
            }}
          >
            {LIST_SOURCES.map((s) => (
              <option key={s} value={s}>
                {SOURCE_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        {list.source === "linked" ? (
          <label className="field">
            <span>Of type</span>
            <ChoiceSelect
              mono
              value={list.entity_type ?? ""}
              options={options?.entity_types ?? []}
              placeholder="Choose an entity type"
              other="Another entity type…"
              onChange={(entity_type) => set({ entity_type })}
            />
          </label>
        ) : (
          <label className="field">
            <span>Order</span>
            <select
              className="input"
              value={list.sort ?? "newest"}
              onChange={(e) => set({ sort: e.target.value === "newest" ? undefined : "oldest" })}
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
            </select>
          </label>
        )}
      </div>
      <Filters source={list.source} filters={list.filters} onChange={(filters) => set({ filters })} />
      <label className="field">
        <span>Over</span>
        <select
          className="input"
          value={list.window ?? "all"}
          onChange={(e) => set({ window: e.target.value === "all" ? undefined : e.target.value })}
        >
          {WINDOWS.map(([value, text]) => (
            <option key={value} value={value}>
              {value === "all" ? text : `The last ${text}`}
            </option>
          ))}
        </select>
      </label>
      <div className="field">
        <span>Columns</span>
        <ColumnPicker
          columns={columns.map((c) => c.field)}
          onChange={setColumns}
          options={LIST_COLUMNS[list.source]}
          labelOf={(field) => columnTitle(columns.find((c) => c.field === field) ?? field)}
          max={MAX_LIST_COLUMNS}
          custom={
            prefix
              ? {
                  prefixes: [prefix],
                  option: list.source === "linked" ? "A property of the entity…" : "A property…",
                  placeholder: `${prefix}amount`,
                  note:
                    list.source === "events"
                      ? "event. is a property of the event."
                      : list.source === "decisions"
                        ? "request. is a property the decision was asked with."
                        : "entity. is a property of the linked entity.",
                }
              : undefined
          }
          extra={(field) => (
            <ColumnFormatControls
              column={columns.find((c) => c.field === field)!}
              prefix={COLUMN_PREFIXES[list.source]}
              onChange={(column) => set({ columns: columns.map((c) => (c.field === field ? column : c)) })}
            />
          )}
        />
      </div>
    </div>
  );
}

export function ListsEditor({
  lists,
  saved,
  onChange,
  templates,
  type = "",
}: {
  lists: EntityList[];
  saved: string[];
  onChange: (lists: EntityList[]) => void;
  templates?: EntityDefinition[];
  type?: string;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const [picking, setPicking] = useState(false);
  const options = templateOptions(templates ?? [], "lists", type);
  const remove = (i: number) => (onChange(lists.filter((_, at) => at !== i)), setOpen(null));
  const add = () => {
    setOpen(lists.length);
    const label = `List ${lists.length + 1}`;
    onChange([
      ...lists,
      {
        name: nameFor(
          label,
          lists.map((l) => l.name),
        ),
        label,
        source: "events",
        columns: STARTING_COLUMNS.events,
      },
    ]);
  };
  return (
    <Card title="Lists">
      <p className="section-note">
        Tables of the records about each entity of this type, page by page: all its payments, its logins, the devices it
        used, its cases.
      </p>
      {lists.map((list, i) =>
        open === i ? (
          <ListRow
            key={i}
            list={list}
            others={saved.includes(list.name) ? null : lists.filter((_, at) => at !== i).map((l) => l.name)}
            onChange={(next) => onChange(lists.map((l, at) => (at === i ? next : l)))}
            onRemove={() => remove(i)}
            onClose={() => setOpen(null)}
          />
        ) : (
          <Summary
            key={i}
            label={list.label}
            sentence={listSentence(list)}
            name={list.name}
            onOpen={() => setOpen(i)}
            onRemove={() => remove(i)}
          />
        ),
      )}
      <div className="row">
        <button type="button" className="btn" disabled={lists.length >= MAX_LISTS} onClick={add}>
          {lists.length >= MAX_LISTS ? `At most ${MAX_LISTS} lists` : "+ Add a list"}
        </button>
        {options.length > 0 && (
          <button type="button" className="btn" disabled={lists.length >= MAX_LISTS} onClick={() => setPicking(true)}>
            Select from templates
          </button>
        )}
      </div>
      {picking && (
        <TemplateModal
          title="Lists"
          options={options}
          apply="Add lists"
          details={(id) => (
            <TemplatePreview
              items={templates!.find((t) => t.type === id)!.lists ?? []}
              taken={lists.map((l) => l.name)}
              sentence={listSentence}
              extra={(l) => `Columns: ${l.columns.map((c) => columnTitle(asColumn(c))).join(", ")}`}
            />
          )}
          onPick={(id) => (
            onChange(merge(lists, templates!.find((t) => t.type === id)!.lists, MAX_LISTS)),
            setOpen(null),
            setPicking(false)
          )}
          onClose={() => setPicking(false)}
        />
      )}
    </Card>
  );
}
