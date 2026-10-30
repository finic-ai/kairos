import type { Decision, WebhookMapping } from "@kairos/core";
import type { WebhookDeliveryRow, WebhookRow } from "../../db/schema";
import type { EntityRef } from "../catalog/types";
import type { DecisionRecord } from "../decisions/types";

/**
 * Webhooks as data: the messages Kairos sends, the filters of an endpoint, and how an inbound
 * delivery is verified. Plain types and pure functions, so that a repository can use them
 * without depending on a service.
 */

/**
 * How an inbound delivery proves where it came from. A provider cannot send our API key, so a
 * delivery is accepted on the token in its URL and on the provider's own signature over the raw
 * body. See internal/designs/inbound-webhooks.md, section 6.
 */
export type Verification =
  /** An HMAC of the raw body in one header: Fingerprint, Onfido, Sumsub, Unit, Checkout.com, Intercom, Marqeta, Shopify. */
  | { scheme: "hmac"; header: string; algorithm?: Algorithm; encoding?: Encoding; prefix?: string }
  /**
   * An HMAC of a time and the raw body, with the time checked. The time is inside the signature
   * header ("t=…,v1=…": Stripe, Persona) or in its own header (Zendesk).
   */
  | {
      scheme: "timestamped";
      header: string;
      /** The header with the time. Unset: the time is the `timestampKey` part of `header`. */
      timestampHeader?: string;
      /** In "t=…,v1=…": the key of the time, and the key of each signature. Default "t" and "v1". */
      timestampKey?: string;
      signatureKey?: string;
      /** What joins the time and the body in the signed text. Default ".". */
      join?: string;
      algorithm?: Algorithm;
      encoding?: Encoding;
      /** Seconds a signed time may be from now. Default 300. */
      tolerance?: number;
    }
  /** Stripe's signature: the timestamped scheme as Stripe sends it. Kept as a name for sources made before. */
  | { scheme: "stripe"; tolerance?: number }
  /** Standard Webhooks (https://www.standardwebhooks.com), as sent through Svix: Lithic, Sardine. */
  | { scheme: "standard"; tolerance?: number }
  | { scheme: "header"; header: string }
  | { scheme: "none" };

type Algorithm = "sha256" | "sha1" | "sha512";
type Encoding = "hex" | "base64";

export interface OutboxRepository {
  /** Call it in the transaction that saves the thing the event is about, so the two exist together or not at all. Returns how many. */
  enqueue(workspaceId: string, environmentId: string, event: OutboundEvent, now: Date): Promise<number>;
}

export const EVENT_TYPES = [
  "decision.created",
  "decision.updated",
  "label.created",
  "case.created",
  "case.assigned",
  "case.resolved",
  "case.reopened",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export const OUTCOMES = ["approve", "step_up", "review", "block"] as const;

export interface InboundConfig {
  preset?: string | null;
  verification: Verification;
  mapping: WebhookMapping;
}

export interface OutboundConfig {
  events: EventType[];
  /** `actions`, `outcomes` and `min_risk_score` apply to decision.*; `labels` to label.created; `queues` to case.*. */
  filter?: {
    actions?: string[];
    outcomes?: (typeof OUTCOMES)[number][];
    min_risk_score?: number;
    labels?: string[];
    queues?: string[];
  };
  include_properties: boolean;
  version: 1;
}

export interface OutboundEvent {
  type: EventType | "webhook.test";
  subjectRef?: string;
  data: Record<string, unknown>;
  match?: { action: string; outcome: string; riskScore: number } | { label: string } | { queue: string };
}

export function matches(config: OutboundConfig, event: OutboundEvent): boolean {
  if (!config.events.includes(event.type as EventType)) return false;
  const filter = config.filter ?? {};
  const m = event.match;
  if (!m) return true;
  if ("label" in m) return !filter.labels?.length || filter.labels.includes(m.label);
  if ("queue" in m) return !filter.queues?.length || filter.queues.includes(m.queue);
  // "withdrawal" in a filter is every version of the action.
  if (filter.actions?.length && !filter.actions.includes(m.action.split("@")[0]!)) return false;
  if (filter.outcomes?.length && !filter.outcomes.includes(m.outcome as never)) return false;
  if (filter.min_risk_score !== undefined && m.riskScore < filter.min_risk_score) return false;
  return true;
}

export function envelope(
  id: string,
  workspaceId: string,
  createdAt: string,
  event: OutboundEvent,
  config?: OutboundConfig,
  environmentId?: string,
) {
  const data = { ...event.data };
  if (config && !config.include_properties) delete data.properties;
  return {
    id,
    type: event.type,
    version: 1,
    workspace_id: workspaceId,
    ...(environmentId ? { environment_id: environmentId } : {}),
    created_at: createdAt,
    data,
  };
}

/**
 * The data of decision.created and decision.updated: the decision as it is now, complete, so
 * that the latest message alone is enough. A receiver keeps the highest `revision`.
 */
function decisionData(record: DecisionRecord): Record<string, unknown> {
  const d = record.decision as Decision;
  const final = record.resolution?.outcome ?? d.decision;
  return {
    decision_id: record.id,
    revision: record.revision ?? 1,
    decided_at: record.ts,
    action: d.action,
    subject: record.subject,
    // A decision from before the request was kept knows only its subject.
    entities: record.request?.entities ?? { [record.subject.type]: record.subject.id },
    ...(record.event_id ? { event_id: record.event_id } : {}),
    ...(record.session ? { session: record.session } : {}),
    ...(record.request ? { properties: record.request.properties } : {}),
    decision: d.decision,
    risk_score: d.risk_score,
    probability: d.probability,
    reasons: d.reasons,
    ...(d.typology ? { typology: d.typology } : {}),
    rules: d.rules,
    resolution: record.resolution ?? null,
    final_outcome: final,
    automatic: record.automatic ?? false,
  };
}

/** A filter on outcomes reads what should happen now: after a resolution, the person's outcome. */
const decisionMatch = (record: DecisionRecord) => {
  const d = record.decision as Decision;
  return { action: d.action, outcome: record.resolution?.outcome ?? d.decision, riskScore: d.risk_score };
};

export const decisionCreated = (record: DecisionRecord): OutboundEvent => ({
  type: "decision.created",
  subjectRef: `decision:${record.id}`,
  data: decisionData(record),
  match: decisionMatch(record),
});

export const decisionUpdated = (record: DecisionRecord): OutboundEvent => ({
  type: "decision.updated",
  subjectRef: `decision:${record.id}`,
  data: decisionData(record),
  match: decisionMatch(record),
});

export const labelCreated = (
  entity: EntityRef,
  label: { label: string; ts: string; properties: Record<string, unknown> },
  recent: { decision_id: string; action: string; decision: string; final_outcome: string; decided_at: string }[],
): OutboundEvent => ({
  type: "label.created",
  subjectRef: `entity:${entity.type}:${entity.id}`,
  data: { entity, label: label.label, labelled_at: label.ts, properties: label.properties, recent_decisions: recent },
  match: { label: label.label },
});

export type CaseEventType = "case.created" | "case.assigned" | "case.resolved" | "case.reopened";

/** A case.* event: the case as it is now, complete, as for decisions. */
export const caseEvent = (
  type: CaseEventType,
  data: { case_id: string; queue_id: string } & Record<string, unknown>,
) => ({
  type,
  subjectRef: `case:${data.case_id}`,
  data,
  match: { queue: data.queue_id },
});

export const testEvent = (webhookId: string): OutboundEvent => ({
  type: "webhook.test",
  data: { webhook_id: webhookId, message: "A test message from Kairos. Your endpoint received it." },
});

/** A webhook as the API shows it: never a secret, only hints. */
export interface WebhookView {
  id: string;
  direction: "in" | "out";
  name: string;
  url: string | null;
  events?: string[];
  filter?: OutboundConfig["filter"];
  include_properties?: boolean;
  preset?: string | null;
  verification?: Verification;
  mapping?: WebhookMapping;
  /** Inbound: the start and end of the URL token. The token itself is shown once. */
  token_hint?: string | null;
  enabled: boolean;
  disabled_reason: string | null;
  failing_since: string | null;
  last_delivery: string | null;
  secret_hints: { hint: string; added: string; expires?: string }[];
  created: string;
  created_by: string | null;
}

export interface DeliveryView {
  id: string;
  webhook_id: string;
  direction: "in" | "out";
  status: string;
  type: string | null;
  external_id: string | null;
  subject_ref: string | null;
  attempts: number;
  next_attempt: string | null;
  response_status: number | null;
  response_ms: number | null;
  problem: string | null;
  created: string;
  finished: string | null;
}

export interface DeliveryDetail extends DeliveryView {
  payload: unknown;
  headers: Record<string, string> | null;
  response_body: string | null;
  result: unknown;
}

const iso = (moment: Date | null) => moment?.toISOString() ?? null;

export const toWebhookView = (r: WebhookRow): WebhookView => {
  const config = r.config as Partial<OutboundConfig>;
  const inbound = r.config as InboundConfig;
  return {
    id: r.id,
    direction: r.direction,
    name: r.name,
    url: r.url,
    ...(r.direction === "out"
      ? {
          events: config.events ?? [],
          filter: config.filter ?? {},
          include_properties: config.include_properties ?? true,
        }
      : {}),
    ...(r.direction === "in"
      ? {
          preset: inbound.preset ?? null,
          verification: inbound.verification,
          mapping: inbound.mapping,
          token_hint: r.tokenHint,
        }
      : {}),
    enabled: r.enabled,
    disabled_reason: r.disabledReason,
    failing_since: iso(r.failingSince),
    last_delivery: iso(r.lastDelivery),
    secret_hints: r.secrets.map((s) => ({
      hint: s.hint,
      added: s.added,
      ...(s.expires ? { expires: s.expires } : {}),
    })),
    created: r.created.toISOString(),
    created_by: r.createdBy,
  };
};

export const toDeliveryView = (r: WebhookDeliveryRow): DeliveryView => ({
  id: r.id,
  webhook_id: r.webhookId,
  direction: r.direction,
  status: r.status,
  type: r.type,
  external_id: r.externalId,
  subject_ref: r.subjectRef,
  attempts: r.attempts,
  next_attempt: iso(r.nextAttempt),
  response_status: r.responseStatus,
  response_ms: r.responseMs,
  problem: r.problem,
  created: r.created.toISOString(),
  finished: iso(r.finished),
});

export const toDeliveryDetail = (r: WebhookDeliveryRow): DeliveryDetail => ({
  ...toDeliveryView(r),
  payload: r.payload,
  headers: r.headers,
  response_body: r.responseBody,
  result: r.result,
});
