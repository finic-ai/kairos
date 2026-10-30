import { request } from "./client";
import type { Experiment, WorkflowDefinition } from "../types/interfaces";

const enc = encodeURIComponent;

export const experiments = {
  list: (workflow: string) =>
    request<{ experiments: Experiment[] }>("GET", `/v1/workflows/${enc(workflow)}/experiments`),
  get: (id: string) => request<Experiment>("GET", `/v1/workflow-experiments/${enc(id)}`),
  /** Records the choice, and writes the variant's steps as the workflow's draft, or publishes them. */
  apply: (id: string, choice: { variant: string; reason?: string; publish: boolean }) =>
    request<{ experiment: Experiment; workflow: WorkflowDefinition }>(
      "POST",
      `/v1/workflow-experiments/${enc(id)}/apply`,
      choice,
    ),
};
