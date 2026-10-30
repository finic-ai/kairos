import type { CaseCategory, CaseView, QueueDefinition } from "@kairos/core";
import { request, requestBlob } from "./client";
import type {
  CaseActivity,
  CaseDetail,
  CaseStep,
  CaseSummary,
  CaseViewData,
  CheckState,
  EntityRef,
  ListPage,
  Queue,
  ViewTemplate,
} from "../types/interfaces";

export interface ResolveBody {
  category: CaseCategory;
  note?: string;
  apply_to_decisions?: boolean;
  label_target?: boolean;
}

const enc = encodeURIComponent;

export interface CaseQuery {
  status?: string;
  priority?: string;
  assignee?: string;
  /** "overdue": only cases past their due time. */
  due?: string;
  q?: string;
  limit: number;
  offset: number;
}

export const queues = {
  list: () => request<{ queues: Queue[] }>("GET", "/v1/queues"),
  get: (id: string) => request<Queue>("GET", `/v1/queues/${enc(id)}`),
  create: (definition: QueueDefinition) => request<Queue>("POST", "/v1/queues", definition),
  save: (id: string, definition: QueueDefinition) => request<Queue>("PUT", `/v1/queues/${enc(id)}`, definition),
  remove: (id: string) => request<unknown>("DELETE", `/v1/queues/${enc(id)}`),
  cases: (id: string, query: CaseQuery) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") params.set(k, String(v));
    return request<{ cases: CaseSummary[]; total: number }>("GET", `/v1/queues/${enc(id)}/cases?${params}`);
  },
  case: (id: string) => request<CaseDetail>("GET", `/v1/cases/${enc(id)}`),
  media: (id: string, block: string, index: number) =>
    requestBlob(`/v1/cases/${enc(id)}/view/media/${enc(block)}/${index}`),
  viewed: (id: string, block: string) => request<unknown>("POST", `/v1/cases/${enc(id)}/view/viewed`, { block }),
  check: (id: string, block: string, point: number, checked: boolean) =>
    request<{ checks: CheckState[] }>("POST", `/v1/cases/${enc(id)}/checks`, { block, point, checked }),
  previewView: (id: string, view: CaseView) =>
    request<CaseViewData>("POST", `/v1/cases/${enc(id)}/view/preview`, { view }, { changes: false }),
  previewList: (
    id: string,
    view: CaseView,
    block: string,
    entity: EntityRef,
    list: string,
    page: { q?: string; limit: number; offset: number },
  ) => {
    const query = new URLSearchParams({
      type: entity.type,
      entity: entity.id,
      list,
      limit: String(page.limit),
      offset: String(page.offset),
    });
    if (page.q) query.set("q", page.q);
    return request<ListPage>(
      "POST",
      `/v1/cases/${enc(id)}/view/preview/lists/${enc(block)}?${query}`,
      { view },
      { changes: false },
    );
  },
  viewTemplates: () => request<{ templates: ViewTemplate[] }>("GET", "/v1/case-view-templates"),
  view: (id: string) => request<CaseViewData>("GET", `/v1/cases/${enc(id)}/view`),
  viewList: (
    id: string,
    block: string,
    entity: EntityRef,
    list: string,
    page: { q?: string; limit: number; offset: number },
  ) => {
    const query = new URLSearchParams({
      type: entity.type,
      entity: entity.id,
      list,
      limit: String(page.limit),
      offset: String(page.offset),
    });
    if (page.q) query.set("q", page.q);
    return request<ListPage>("GET", `/v1/cases/${enc(id)}/view/lists/${enc(block)}?${query}`);
  },
  timeline: (id: string, itemsOnly: boolean) =>
    request<{ steps: CaseStep[] }>("GET", `/v1/cases/${enc(id)}/timeline${itemsOnly ? "?items_only=true" : ""}`),
  take: (id: string) => request<CaseSummary>("POST", `/v1/cases/${enc(id)}/take`),
  assign: (id: string, assignee: string | null) =>
    request<CaseSummary>("POST", `/v1/cases/${enc(id)}/assign`, { assignee }),
  note: (id: string, text: string) => request<CaseActivity>("POST", `/v1/cases/${enc(id)}/notes`, { text }),
  resolve: (id: string, body: ResolveBody) =>
    request<CaseSummary & { decisions_resolved: number; labelled: boolean }>(
      "POST",
      `/v1/cases/${enc(id)}/resolve`,
      body,
    ),
  reopen: (id: string) => request<CaseSummary>("POST", `/v1/cases/${enc(id)}/reopen`),
  /** One change to many cases of a queue. Each case succeeds or fails on its own. */
  bulk: (queueId: string, body: { ids: string[] } & ({ assign: string | null } | { resolve: ResolveBody })) =>
    request<{ results: { id: string; ok: boolean; error?: string }[] }>(
      "POST",
      `/v1/queues/${enc(queueId)}/cases/bulk`,
      body,
    ),
};
