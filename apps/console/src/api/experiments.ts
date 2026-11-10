import { request } from "./client";
import type { Experiment, WorkflowDefinition } from "../types/interfaces";

const enc = encodeURIComponent;

export const experiments = {
  list: (workflow: string) =>
    request<{ experiments: Experiment[] }>("GET", `/v1/workflows/${enc(workflow)}/experiments`),
  /** A backtest alone: what the workflow would have decided over the action's past requests. */
  backtest: (
    workflow: string,
    body: { name?: string; labels: string[]; window: string; backtest: { from?: string } },
  ) => request<Experiment>("POST", `/v1/workflows/${enc(workflow)}/experiments`, body),
  get: (id: string) => request<Experiment>("GET", `/v1/workflow-experiments/${enc(id)}`),
  rename: (id: string, change: { name?: string; variants?: Record<string, string> }) =>
    request<Experiment>("PATCH", `/v1/workflow-experiments/${enc(id)}`, change),
  /** Records the choice, and writes the variant's steps as the workflow's draft, or publishes them. */
  apply: (id: string, choice: { variant: string; reason?: string; publish: boolean }) =>
    request<{ experiment: Experiment; workflow: WorkflowDefinition }>(
      "POST",
      `/v1/workflow-experiments/${enc(id)}/apply`,
      choice,
    ),
};
