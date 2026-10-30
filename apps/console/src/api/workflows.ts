import { request } from "./client";
import type { WorkflowDefinition, WorkflowDraft, WorkflowRun, WorkflowVersionInfo } from "../types/interfaces";

const enc = encodeURIComponent;

export const workflows = {
  list: (archived = false) =>
    request<{ workflows: WorkflowDefinition[] }>("GET", `/v1/workflows${archived ? "?archived=true" : ""}`),
  get: (name: string, version?: number) =>
    request<WorkflowDefinition>(
      "GET",
      `/v1/workflows/${enc(name)}${version === undefined ? "" : `?version=${version}`}`,
    ),
  versions: (name: string) =>
    request<{ versions: WorkflowVersionInfo[] }>("GET", `/v1/workflows/${enc(name)}/versions`),
  save: (definition: WorkflowDraft) =>
    request<WorkflowDefinition>("PUT", `/v1/workflows/${enc(definition.name)}`, definition),
  /** Save changes as the draft: runs keep the live version until a publish. */
  saveDraft: ({ name, displayName, trigger, steps }: WorkflowDraft) =>
    request<WorkflowDefinition>("PUT", `/v1/workflows/${enc(name)}/draft`, { displayName, trigger, steps }),
  discardDraft: (name: string) => request<WorkflowDefinition>("DELETE", `/v1/workflows/${enc(name)}/draft`),
  publish: (name: string) => request<WorkflowDefinition>("POST", `/v1/workflows/${enc(name)}/publish`),
  /** Pause or activate, or rename. Neither makes a version. */
  update: (name: string, change: { enabled?: boolean; displayName?: string }) =>
    request<WorkflowDefinition>("PATCH", `/v1/workflows/${enc(name)}`, change),
  /** A new URL for the webhook trigger: the old one stops. The path has the token and is shown only once. */
  newHook: (name: string) => request<{ path: string; hint: string }>("POST", `/v1/workflows/${enc(name)}/hook`),
  archive: (name: string) => request<WorkflowDefinition>("POST", `/v1/workflows/${enc(name)}/archive`),
  restore: (name: string) => request<WorkflowDefinition>("POST", `/v1/workflows/${enc(name)}/restore`),
  /** Run an unsaved definition once. Writes are simulated, except the steps named in `liveSteps`. */
  test: (definition: WorkflowDraft, input: Record<string, unknown>, liveSteps: string[]) =>
    request<WorkflowRun>("POST", "/v1/workflows/test", { definition, input, live_steps: liveSteps }),
  /** Start a run of the live version. With `wait`, the answer comes when it ends or answers, or when the time is up. */
  start: (name: string, input: Record<string, unknown>, options: { wait?: boolean } = {}) =>
    request<WorkflowRun>("POST", `/v1/workflows/${enc(name)}/runs`, { input, ...(options.wait ? { wait: true } : {}) }),
  runs: (name: string, limit = 50) =>
    request<{ runs: WorkflowRun[] }>("GET", `/v1/workflows/${enc(name)}/runs?limit=${limit}`),
  run: (id: string) => request<WorkflowRun>("GET", `/v1/workflow-runs/${enc(id)}`),
  cancel: (id: string) => request<WorkflowRun>("POST", `/v1/workflow-runs/${enc(id)}/cancel`),
};
