import { request, requestBlob } from "./client";
import type {
  ActionDefinition,
  Dashboard,
  DecisionRecord,
  DecisionSummary,
  Entity,
  EntityDefinition,
  IssuedCommand,
  EntityFilters,
  EntityList,
  EntityRef,
  EntityShape,
  EventDetail,
  FactValue,
  Interval,
  ListPage,
  MetricOptions,
  MetricQuery,
  MetricResult,
  Resolution,
  SessionDetail,
  SessionRow,
  Stats,
  Usage,
} from "../types/interfaces";

export const api = {
  stats: () => request<Stats>("GET", "/v1/stats"),
  decisions: (filter: {
    outcome?: string;
    action?: string;
    decided_by?: "workflow" | "policy";
    workflow?: string;
    rule?: string;
    limit?: number;
    offset?: number;
  }) => {
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(filter)) if (v) query.set(k, String(v));
    return request<{ decisions: DecisionSummary[]; total: number }>("GET", `/v1/decisions?${query}`);
  },
  decision: (id: string) => request<DecisionRecord>("GET", `/v1/decisions/${encodeURIComponent(id)}`),
  actions: () => request<{ actions: ActionDefinition[] }>("GET", "/v1/actions"),
  templates: () => request<{ templates: ActionDefinition[] }>("GET", "/v1/templates"),
  action: (name: string) => request<ActionDefinition>("GET", `/v1/actions/${encodeURIComponent(name)}`),
  saveAction: ({ name, version: _v, ...definition }: ActionDefinition) =>
    request<ActionDefinition>("PUT", `/v1/actions/${encodeURIComponent(name)}`, definition),
  entities: (
    filter: { type?: string; labelled?: boolean; limit?: number; offset?: number } & Partial<EntityFilters>,
  ) => {
    const query = new URLSearchParams();
    if (filter.type) query.set("type", filter.type);
    if (filter.labelled) query.set("labelled", "1");
    for (const key of ["q", "label", "outcome", "risk_min", "active", "sort"] as const)
      if (filter[key]) query.set(key, filter[key]!);
    // A condition with no value yet is not sent, except for the two that need none.
    for (const p of filter.props ?? [])
      if (p.name && (p.value !== "" || p.op === "exists" || p.op === "missing"))
        query.append("prop", `${p.name}:${p.op}:${p.value}`);
    query.set("limit", String(filter.limit ?? 100));
    if (filter.offset) query.set("offset", String(filter.offset));
    return request<EntityList>("GET", `/v1/entities?${query}`);
  },
  usage: (days: number) => request<Usage>("GET", `/v1/usage?days=${days}`),
  metric: (query: MetricQuery & { from: string; to: string; interval?: Interval; compare?: boolean }) =>
    request<MetricResult>("POST", "/v1/metrics/query", query, { changes: false }),
  metricOptions: (eventType?: string) =>
    request<MetricOptions>(
      "GET",
      `/v1/metrics/options${eventType ? `?event_type=${encodeURIComponent(eventType)}` : ""}`,
    ),
  dashboards: () => request<{ dashboards: Dashboard[] }>("GET", "/v1/dashboards"),
  dashboard: (id: string) => request<Dashboard>("GET", `/v1/dashboards/${encodeURIComponent(id)}`),
  createDashboard: (body: Pick<Dashboard, "name" | "range" | "tiles" | "visibility">) =>
    request<Dashboard>("POST", "/v1/dashboards", body),
  saveDashboard: ({ id, name, range, visibility, tiles }: Dashboard) =>
    request<Dashboard>("PUT", `/v1/dashboards/${encodeURIComponent(id)}`, { name, range, visibility, tiles }),
  deleteDashboard: (id: string) => request<unknown>("DELETE", `/v1/dashboards/${encodeURIComponent(id)}`),
  entityShape: (type: string) => request<EntityShape>("GET", `/v1/entity-types/${encodeURIComponent(type)}/shape`),
  entityType: (type: string) => request<EntityDefinition>("GET", `/v1/entity-types/${encodeURIComponent(type)}`),
  entityCommands: (ref: EntityRef) =>
    request<{ commands: IssuedCommand[] }>(
      "GET",
      `/v1/entities/${encodeURIComponent(ref.type)}/${encodeURIComponent(ref.id)}/commands`,
    ),
  issueCommand: (ref: EntityRef, name: string, body: { inputs?: Record<string, unknown>; case_id?: string }) =>
    request<{ id: string; command: string; label: string; queued: number }>(
      "POST",
      `/v1/entities/${encodeURIComponent(ref.type)}/${encodeURIComponent(ref.id)}/commands/${encodeURIComponent(name)}`,
      body,
    ),
  entityTemplates: () => request<{ templates: EntityDefinition[] }>("GET", "/v1/entity-templates"),
  saveEntityType: ({ type, ...definition }: EntityDefinition) =>
    request<EntityDefinition>("PUT", `/v1/entity-types/${encodeURIComponent(type)}`, definition),
  /** What is known about many entities at once: up to 500. Properties are merged into what is stored. */
  saveEntities: (batch: { type: string; id: string; properties: Record<string, unknown> }[]) =>
    request<{ accepted: number }>("PUT", "/v1/objects", { batch }),
  /** `properties` are merged into what is stored; `unset` removes properties. */
  saveEntity: (ref: EntityRef, properties: Record<string, unknown>, unset: string[] = []) =>
    request<unknown>("PUT", `/v1/entities/${encodeURIComponent(ref.type)}/${encodeURIComponent(ref.id)}`, {
      properties,
      unset,
    }),
  sessions: (filter: { q?: string; outcome?: string; limit: number; offset: number }) => {
    const query = new URLSearchParams({ limit: String(filter.limit), offset: String(filter.offset) });
    if (filter.q) query.set("q", filter.q);
    if (filter.outcome) query.set("outcome", filter.outcome);
    return request<{ sessions: SessionRow[]; total: number }>("GET", `/v1/sessions?${query}`);
  },
  session: (id: string) => request<SessionDetail>("GET", `/v1/sessions/${encodeURIComponent(id)}`),
  event: (id: string) => request<EventDetail>("GET", `/v1/events/${encodeURIComponent(id)}`),
  entity: (ref: EntityRef) =>
    request<Entity>("GET", `/v1/entities/${encodeURIComponent(ref.type)}/${encodeURIComponent(ref.id)}`),
  entityMedia: (ref: EntityRef, property: string) =>
    requestBlob(
      `/v1/entities/${encodeURIComponent(ref.type)}/${encodeURIComponent(ref.id)}/media/${encodeURIComponent(property)}`,
    ),
  entityFacts: (ref: EntityRef) =>
    request<{ facts: FactValue[] }>(
      "GET",
      `/v1/entities/${encodeURIComponent(ref.type)}/${encodeURIComponent(ref.id)}/facts`,
    ),
  entityList: (ref: EntityRef, name: string, page: { q?: string; limit: number; offset: number }) => {
    const query = new URLSearchParams({ limit: String(page.limit), offset: String(page.offset) });
    if (page.q) query.set("q", page.q);
    return request<ListPage>(
      "GET",
      `/v1/entities/${encodeURIComponent(ref.type)}/${encodeURIComponent(ref.id)}/lists/${encodeURIComponent(name)}?${query}`,
    );
  },
  label: (entity: EntityRef, label: string, properties: Record<string, unknown> = {}) =>
    request<unknown>("POST", "/v1/labels", { batch: [{ entity, label, properties }] }),
  automaticEstimate: (name: string) =>
    request<{ available: boolean; per_day: number; missed_last_day: number; window_minutes: number }>(
      "GET",
      `/v1/actions/${encodeURIComponent(name)}/automatic`,
    ),
  /** A person's decision on a decision. The console sends the signed-in person as `by`. */
  resolve: (id: string, outcome: Resolution["outcome"], note?: string) =>
    request<DecisionSummary>("POST", `/v1/decisions/${encodeURIComponent(id)}/resolution`, {
      outcome,
      ...(note?.trim() ? { note: note.trim() } : {}),
    }),
};
