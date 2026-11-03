import { request } from "./client";
import type {
  ListDetail,
  ListMatch,
  ListSummary,
  RulesetDefinition,
  RulesetResult,
  RulesetSummary,
  RulesetTemplate,
  RulesetTestRun,
} from "../types/interfaces";

const enc = encodeURIComponent;
const params = (query: Record<string, string | number | boolean | undefined>) =>
  new URLSearchParams(
    Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== "" && v !== false)
      .map(([k, v]) => [k, String(v)]),
  );

export const rulesets = {
  list: (query: { archived?: boolean; q?: string; limit?: number; offset?: number } = {}) =>
    request<{ rulesets: RulesetSummary[]; total: number }>("GET", `/v1/rulesets?${params(query)}`),
  get: (ref: string) => request<RulesetSummary>("GET", `/v1/rulesets/${enc(ref)}`),
  templates: () => request<{ templates: RulesetTemplate[] }>("GET", "/v1/ruleset-templates"),
  saveDraft: (ref: string, body: { name?: string; description?: string | null; definition: RulesetDefinition }) =>
    request<RulesetSummary>("PUT", `/v1/rulesets/${enc(ref)}/draft`, body),
  discardDraft: (ref: string) => request<RulesetSummary>("DELETE", `/v1/rulesets/${enc(ref)}/draft`),
  publish: (ref: string) => request<RulesetSummary>("POST", `/v1/rulesets/${enc(ref)}/publish`),
  update: (ref: string, change: { name?: string; description?: string | null; settings?: Record<string, unknown> }) =>
    request<RulesetSummary>("PATCH", `/v1/rulesets/${enc(ref)}`, change),
  archive: (ref: string) => request<RulesetSummary>("POST", `/v1/rulesets/${enc(ref)}/archive`),
  restore: (ref: string) => request<RulesetSummary>("POST", `/v1/rulesets/${enc(ref)}/restore`),
  test: (definition: RulesetDefinition, input?: Record<string, unknown>) =>
    request<RulesetTestRun>("POST", "/v1/rulesets/test", { definition, input }, { changes: false }),
  evaluate: (ref: string, input: Record<string, unknown>) =>
    request<RulesetResult>("POST", `/v1/rulesets/${enc(ref)}/evaluate`, { input }, { changes: false }),
};

type ItemInput = { value: string; note?: string; match?: ListMatch | null; case_sensitive?: boolean | null };

export const lists = {
  list: (query: { q?: string; limit?: number; offset?: number } = {}) =>
    request<{ lists: ListSummary[]; total: number }>("GET", `/v1/lists?${params(query)}`),
  get: (ref: string) => request<ListDetail>("GET", `/v1/lists/${enc(ref)}`),
  readers: (ref: string) =>
    request<{
      rulesets: { slug: string; name: string }[];
      workflows: { name: string; display_name?: string }[];
    }>("GET", `/v1/lists/${enc(ref)}/readers`),
  save: (
    ref: string,
    body: { name?: string; description?: string | null; match?: ListMatch; case_sensitive?: boolean },
  ) => request<ListDetail>("PUT", `/v1/lists/${enc(ref)}`, body),
  addItems: (ref: string, items: ItemInput[]) =>
    request<{ added: number; updated: number; list: ListDetail }>("POST", `/v1/lists/${enc(ref)}/items`, { items }),
  removeItems: (ref: string, values: (string | number)[]) =>
    request<{ removed: number; list: ListDetail }>("DELETE", `/v1/lists/${enc(ref)}/items`, { values }),
  remove: (ref: string) => request<ListDetail>("DELETE", `/v1/lists/${enc(ref)}`),
};
