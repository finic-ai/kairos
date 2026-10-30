import { request, workspacePath as ws } from "./client";
import type {
  SourceInput,
  Webhook,
  WebhookDelivery,
  WebhookDeliveryDetail,
  WebhookEvent,
  WebhookInput,
  WebhookPreset,
  WebhookTestResult,
} from "../types/interfaces";

export const WEBHOOK_EVENTS: { id: WebhookEvent; note: string }[] = [
  { id: "decision.created", note: "A decision was made." },
  { id: "decision.updated", note: "A person approved or blocked a decision, or changed that." },
  { id: "label.created", note: "An entity got a new label, such as chargeback." },
  { id: "case.created", note: "A queue's rule or a workflow opened a case." },
  { id: "case.assigned", note: "A case got an assignee, or lost one." },
  { id: "case.resolved", note: "A person or a workflow resolved a case." },
  { id: "case.reopened", note: "A resolved case was opened again." },
];

const hook = (id: string, webhook: string) => `${ws(id)}/webhooks/${encodeURIComponent(webhook)}`;

export const webhooks = {
  list: (id: string) =>
    request<{ webhooks: Webhook[]; unavailable?: string; warning?: string }>("GET", `${ws(id)}/webhooks?direction=out`),
  get: (id: string, webhook: string) => request<Webhook>("GET", hook(id, webhook)),
  create: (id: string, input: WebhookInput) =>
    request<{ webhook: Webhook; secret: string }>("POST", `${ws(id)}/webhooks`, { direction: "out", ...input }),
  update: (id: string, webhook: string, changes: Partial<WebhookInput> & { enabled?: boolean }) =>
    request<Webhook>("PATCH", hook(id, webhook), changes),
  remove: (id: string, webhook: string) => request<unknown>("DELETE", hook(id, webhook)),
  rotate: (id: string, webhook: string) =>
    request<{ webhook: Webhook; secret: string }>("POST", `${hook(id, webhook)}/rotate`, {}),
  endOverlap: (id: string, webhook: string) =>
    request<{ webhook: Webhook; secret: null }>("POST", `${hook(id, webhook)}/rotate`, { end_overlap: true }),
  test: (id: string, webhook: string) => request<WebhookTestResult>("POST", `${hook(id, webhook)}/test`),
  deliveries: (id: string, webhook: string, filter: { status?: string; limit?: number; offset?: number } = {}) => {
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(filter)) if (v) query.set(k, String(v));
    return request<{ deliveries: WebhookDelivery[]; next_offset: number | null }>(
      "GET",
      `${hook(id, webhook)}/deliveries?${query}`,
    );
  },
  delivery: (id: string, webhook: string, delivery: string) =>
    request<WebhookDeliveryDetail>("GET", `${hook(id, webhook)}/deliveries/${encodeURIComponent(delivery)}`),
  resend: (id: string, webhook: string, which: { delivery: string } | { status: "failed" }) =>
    request<{ queued: number }>("POST", `${hook(id, webhook)}/resend`, which),
  presets: () => request<{ presets: WebhookPreset[] }>("GET", "/v1/webhook-presets"),
  sources: (id: string) =>
    request<{ webhooks: Webhook[]; unavailable?: string }>("GET", `${ws(id)}/webhooks?direction=in`),
  createSource: (id: string, input: SourceInput) =>
    request<{ webhook: Webhook; token: string; path: string }>("POST", `${ws(id)}/webhooks`, {
      direction: "in",
      ...input,
    }),
  updateSource: (
    id: string,
    webhook: string,
    changes: Partial<Omit<SourceInput, "preset">> & { enabled?: boolean; add_secret?: string },
  ) => request<Webhook>("PATCH", hook(id, webhook), changes),
  newToken: (id: string, webhook: string) =>
    request<{ webhook: Webhook; token: string; path: string }>("POST", `${hook(id, webhook)}/token`),
  replay: (id: string, webhook: string, which: { delivery: string } | { status: "failed" }) =>
    request<{ replayed: number; statuses: Record<string, number> }>("POST", `${hook(id, webhook)}/replay`, which),
  about: (id: string, subject: string) =>
    request<{ deliveries: (WebhookDelivery & { webhook_name: string; webhook_url: string | null })[] }>(
      "GET",
      `${ws(id)}/webhook-deliveries?subject=${encodeURIComponent(subject)}`,
    ),
};
