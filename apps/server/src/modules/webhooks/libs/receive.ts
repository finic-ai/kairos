import { applyMapping, type Lookup } from "@kairos/core";
import type { Webhooks } from "../../../context";
import { hashToken } from "../../../platform/crypto";
import type { WebhookRow } from "../../../db/schema";
import { WebhooksService } from "../../../services/webhook.service";
import { WebhookDeliveriesService } from "../../../services/webhook_delivery.service";
import { ObjectsService } from "../../../services/object.service";
import type { InboundConfig } from "../types";
import { eventBody, labelsBody } from "../../ingest/schema";
import type { Repositories } from "../../../repositories";
import { ingest, type IngestRepositories } from "../../ingest/service";
import { addLabel } from "../../catalog/service";

export type InboundRepositories = IngestRepositories & Pick<Repositories, "db" | "entities">;
import { needsSecret, secretHeaders, signs, verify } from "./verify";

export const MAX_BODY = 1024 * 1024;
/** The largest payload kept in the log. A larger delivery is still processed. */
const MAX_STORED = 256 * 1024;
const label = labelsBody.shape.batch.element;

type Source = WebhookRow;

interface Outcome {
  status: "stored" | "duplicate" | "ignored" | "failed" | "no_entity";
  type: string | null;
  externalId: string | null;
  problem: string | null;
  result: { events: number; duplicates: number; labels: number; event_ids: string[]; unresolved?: string[] } | null;
}

async function find(
  { db, entities }: Pick<InboundRepositories, "db" | "entities">,
  workspaceId: string,
  environmentId: string,
  type: string,
  lookup: Lookup,
): Promise<{ id: string } | { problem: string }> {
  if (lookup.by === "record") {
    const id = await entities.entityOfRecord(workspaceId, environmentId, lookup.record, type);
    return id ? { id } : { problem: `no earlier event of record ${lookup.record} names a ${type}` };
  }
  const ids = await new ObjectsService(db, { workspaceId, environmentId }).listIdsWithProperty(
    type,
    lookup.property,
    lookup.value,
  );
  if (ids.length === 1) return { id: ids[0]! };
  return {
    problem: ids.length
      ? `more than one ${type} has ${lookup.property} = ${lookup.value}`
      : `no ${type} has ${lookup.property} = ${lookup.value}`,
  };
}

const text = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v).slice(0, 256) : null);

/**
 * Run a delivery through the source's mapping and store what it gives. The event id is
 * "<source id>:<provider id>", so the same delivery again stores nothing: that is a retry, or a
 * replay after the mapping was corrected. `now` is the time of the run: for a replay, later
 * than `receivedAt`. `onQueued` starts the worker when the events call for automatic decisions.
 */
export async function runDelivery(
  repos: InboundRepositories,
  hooks: Webhooks,
  source: Source,
  body: unknown,
  headers: Record<string, string>,
  receivedAt: Date,
  now: Date,
  onQueued?: () => void,
): Promise<Outcome> {
  const config = source.config as InboundConfig;
  const known = {
    type: text((body as Record<string, unknown>)?.type),
    externalId: text((body as Record<string, unknown>)?.id),
  };
  const mapped = applyMapping(config.mapping, { body, headers }, receivedAt.toISOString());
  if (mapped.outcome !== "mapped")
    return { ...known, status: mapped.outcome, problem: mapped.problems.join("; ") || null, result: null };

  // Entities the payload does not name: found now, from what Kairos knows. An event keeps the
  // entities that were found; with none at all, the delivery waits as no_entity, for a replay.
  const unresolved: string[] = [];
  const cache = new Map<string, { id: string } | { problem: string }>();
  const lookup = async (type: string, how: Lookup) => {
    const key = JSON.stringify([type, how]);
    if (!cache.has(key)) cache.set(key, await find(repos, source.workspaceId, source.environmentId, type, how));
    return cache.get(key)!;
  };
  for (const e of mapped.events) {
    for (const [type, how] of Object.entries(e.lookups ?? {})) {
      const found = await lookup(type, how);
      if ("id" in found) e.entities[type] = found.id;
      else unresolved.push(found.problem);
    }
    delete e.lookups;
    if (Object.keys(e.entities).length === 0)
      return { ...known, status: "no_entity", problem: `Event ${e.id}: ${unresolved.join("; ")}`, result: null };
    // Properties for an entity that was not found have nowhere to go.
    for (const field of ["set", "set_once"] as const) {
      if (e[field]) e[field] = Object.fromEntries(Object.entries(e[field]!).filter(([type]) => type in e.entities));
    }
  }
  for (const l of mapped.labels) {
    if (l.entity.id || !l.lookup) continue;
    const found = await lookup(l.entity.type, l.lookup);
    if (!("id" in found))
      return { ...known, status: "no_entity", problem: `Label ${l.label}: ${found.problem}`, result: null };
    l.entity.id = found.id;
    delete l.lookup;
  }

  // A source whose sender is not proven by a signature cannot change facts about an entity.
  const proven = signs(config.verification);
  const events = [];
  for (const e of mapped.events) {
    const checked = eventBody.safeParse({
      ...e,
      id: `${source.id}:${e.id}`,
      ...(proven ? {} : { set: undefined, set_once: undefined }),
    });
    if (!checked.success) {
      const issue = checked.error.issues[0]!;
      return {
        ...known,
        status: "failed",
        problem: `Event ${e.id}: ${issue.path.join(".")} ${issue.message}`,
        result: null,
      };
    }
    events.push(checked.data);
  }
  const labels = [];
  for (const l of mapped.labels) {
    const checked = label.safeParse(l);
    if (!checked.success) {
      const issue = checked.error.issues[0]!;
      return {
        ...known,
        status: "failed",
        problem: `Label ${l.label}: ${issue.path.join(".")} ${issue.message}`,
        result: null,
      };
    }
    labels.push(checked.data);
  }

  const stored = events.length
    ? await ingest(repos, source.workspaceId, source.environmentId, events, now.toISOString(), "webhook")
    : { accepted: 0, duplicates: 0, ids: [] as string[], queued: 0 };
  if (stored.queued > 0) onQueued?.();
  let queued = 0;
  for (const l of labels)
    queued += await addLabel(
      repos,
      source.workspaceId,
      source.environmentId,
      l.entity,
      { label: l.label, ts: l.ts ?? receivedAt.toISOString(), properties: l.properties },
      now,
      true,
    );
  if (queued > 0) hooks.worker?.wake();
  // Every event was there already: the same delivery again. Its labels were there too, as a label is kept once.
  const duplicate = events.length > 0 && stored.accepted === 0;
  return {
    ...known,
    status: duplicate ? "duplicate" : "stored",
    problem: null,
    result: {
      events: stored.accepted,
      duplicates: stored.duplicates,
      labels: labels.length,
      event_ids: events.map((e) => e.id),
      ...(unresolved.length ? { unresolved } : {}),
    },
  };
}

export interface Received {
  status: 200 | 400 | 401 | 404 | 413 | 503;
  body: Record<string, unknown>;
}

/** A delivery to POST /v1/webhooks/:token. The answer is sent after the events are stored. */
export async function receive(
  repos: InboundRepositories,
  hooks: Webhooks,
  token: string,
  raw: Buffer,
  rawHeaders: Record<string, string>,
  receivedAt: Date,
  payloadDays: number,
  onQueued?: () => void,
): Promise<Received> {
  const source = await WebhooksService.findSourceByToken(hooks.db, hashToken(token));
  // An unknown token and a disabled source look the same, and leave no trace.
  if (!source || !source.enabled)
    return { status: 404, body: { error: { type: "not_found", message: "No such webhook" } } };
  const config = source.config as InboundConfig;
  const headers = Object.fromEntries(Object.entries(rawHeaders).map(([k, v]) => [k.toLowerCase(), v]));
  const hidden = new Set(secretHeaders(config.verification));
  const kept = Object.fromEntries(
    Object.entries(headers)
      .filter(([k]) => !hidden.has(k))
      .slice(0, 50),
  );
  const scope = { workspaceId: source.workspaceId, environmentId: source.environmentId };
  const log = async (
    status: string,
    extra: { problem?: string; payload?: unknown; type?: string | null; externalId?: string | null; result?: unknown },
  ) => {
    await new WebhookDeliveriesService(hooks.db, scope).create(
      {
        webhookId: source.id,
        direction: "in",
        status,
        type: extra.type ?? null,
        externalId: extra.externalId ?? null,
        payload: extra.payload ?? null,
        headers: kept,
        problem: extra.problem ?? null,
        result: extra.result ?? null,
        attempts: 1,
        finished: receivedAt,
      },
      receivedAt,
    );
    await new WebhooksService(hooks.db, scope).updateActivity(source.id, { lastDelivery: receivedAt });
  };

  if (raw.length > MAX_BODY) {
    await log("rejected", { problem: `The body is larger than ${MAX_BODY / 1024 / 1024} MB` });
    return { status: 413, body: { error: { type: "too_large", message: "The body is larger than 1 MB" } } };
  }

  let secrets: string[] = [];
  if (needsSecret(config.verification)) {
    if (!hooks.secretBox) {
      // The server lost its key: a retry after it is set again can succeed, so the answer asks for one.
      await log("failed", {
        problem: "KAIROS_ENCRYPTION_KEY is not set on the server, so the signing secret cannot be read",
      });
      return {
        status: 503,
        body: { error: { type: "unavailable", message: "The server cannot check signatures now" } },
      };
    }
    try {
      secrets = source.secrets.map((s) => hooks.secretBox!.decrypt(s));
    } catch {
      await log("failed", {
        problem: "The signing secret cannot be read: KAIROS_ENCRYPTION_KEY is not the key it was saved with",
      });
      return {
        status: 503,
        body: { error: { type: "unavailable", message: "The server cannot check signatures now" } },
      };
    }
  }
  const wrong = verify(config.verification, raw, headers, secrets, receivedAt);
  if (wrong) {
    // Not proven: nothing of it is kept but the fact that it came.
    await log("rejected", { problem: `Verification failed: ${wrong}` });
    return {
      status: 401,
      body: { error: { type: "invalid_signature", message: "The signature could not be verified" } },
    };
  }

  let body: unknown;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    await log("rejected", { problem: "The body is not JSON" });
    return { status: 400, body: { error: { type: "invalid_request", message: "The body must be JSON" } } };
  }

  const outcome = await runDelivery(repos, hooks, source, body, headers, receivedAt, receivedAt, onQueued);
  const payload = payloadDays > 0 && raw.length <= MAX_STORED ? body : undefined;
  await log(outcome.status, {
    problem: outcome.problem ?? undefined,
    payload,
    type: outcome.type,
    externalId: outcome.externalId,
    result: outcome.result,
  });
  // A mapping that fails answers 200 too: the provider's retry would send the same payload to the same mapping.
  return { status: 200, body: { status: outcome.status } };
}
