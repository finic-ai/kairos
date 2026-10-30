import { request, workspacePath as ws } from "./client";
import type { CopyOption, CopyOptionCategory, Environment, EnvironmentCopyOptions } from "../types/interfaces";

export const environments = {
  list: (workspace: string) => request<{ environments: Environment[] }>("GET", `${ws(workspace)}/environments`),
  options: (
    workspace: string,
    source: string,
    query: { category: CopyOptionCategory; q: string; offset: number; limit: number },
  ) =>
    request<{ items: CopyOption[]; total: number }>(
      "GET",
      `${ws(workspace)}/environments/${encodeURIComponent(source)}/copy-options?${new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]))}`,
    ),
  create: (workspace: string, input: { name: string; copy_from?: string; copy?: EnvironmentCopyOptions }) =>
    request<Environment>("POST", `${ws(workspace)}/environments`, input),
  rename: (workspace: string, id: string, name: string) =>
    request<Environment>("PATCH", `${ws(workspace)}/environments/${encodeURIComponent(id)}`, { name }),
  remove: (workspace: string, id: string, confirm: string) =>
    request<{ ok: boolean }>("DELETE", `${ws(workspace)}/environments/${encodeURIComponent(id)}`, { confirm }),
};
