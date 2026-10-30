import { apiHeaders, ApiError, request } from "./client";
import type {
  ModelDetail,
  ModelPromotion,
  ModelScore,
  ModelSummary,
  ModelVersionDefinition,
} from "../types/interfaces";

const enc = encodeURIComponent;

export const models = {
  list: (query: { kind?: "question" | "scoring"; q?: string; limit?: number; offset?: number } = {}) => {
    const params = new URLSearchParams(
      Object.entries(query)
        .filter(([, v]) => v !== undefined && v !== "")
        .map(([k, v]) => [k, String(v)]),
    );
    return request<{ models: ModelSummary[]; total: number }>("GET", `/v1/models?${params}`);
  },
  get: (slug: string) => request<ModelDetail>("GET", `/v1/models/${enc(slug)}`),
  version: (slug: string, version: number) =>
    request<{ slug: string; version: number; definition: ModelVersionDefinition }>(
      "GET",
      `/v1/models/${enc(slug)}/versions/${version}`,
    ),
  score: (slug: string, version: number, features: Record<string, unknown>) =>
    request<ModelScore>("POST", `/v1/models/${enc(slug)}/versions/${version}/score`, { features }, { changes: false }),
  rename: (slug: string, name: string) => request<ModelSummary>("PATCH", `/v1/models/${enc(slug)}`, { name }),
  archive: (slug: string) => request<ModelSummary>("POST", `/v1/models/${enc(slug)}/archive`),
  promote: (slug: string, version: number, to: string) =>
    request<ModelPromotion>("POST", `/v1/models/${enc(slug)}/versions/${version}/promote`, { to }),
  /** The file needs the workspace and environment headers, so a plain link cannot fetch it. */
  download: async (slug: string, version: number) => {
    const response = await fetch(`/v1/models/${enc(slug)}/versions/${version}/file`, { headers: apiHeaders() });
    if (!response.ok) throw new ApiError(response.status, `The file could not be read (${response.status})`);
    const link = document.createElement("a");
    link.href = URL.createObjectURL(await response.blob());
    link.download = `${slug}-${version}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  },
};
