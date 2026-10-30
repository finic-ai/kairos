import { request, workspacePath as ws } from "./client";
import type { Job, JobStatus, JobSummary } from "../types/interfaces";

const job = (id: string, jobId: string) => `${ws(id)}/jobs/${encodeURIComponent(jobId)}`;

export const jobs = {
  list: (id: string, filter: { status?: JobStatus; kind?: string; limit?: number; offset?: number } = {}) => {
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(filter)) if (v) query.set(k, String(v));
    return request<{ jobs: Job[]; next_offset: number | null }>("GET", `${ws(id)}/jobs?${query}`);
  },
  summary: (id: string) => request<JobSummary>("GET", `${ws(id)}/jobs/summary`),
  get: (id: string, jobId: string) => request<Job>("GET", job(id, jobId)),
  /** Run a dead job again, from no attempts. */
  retry: (id: string, jobId: string) => request<Job>("POST", `${job(id, jobId)}/retry`),
};
