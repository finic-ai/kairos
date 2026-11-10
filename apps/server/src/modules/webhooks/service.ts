import { applyMapping, validateMapping, type WebhookMapping } from "@kairos/core";
import { ulid } from "ulid";
import type { Webhooks } from "../../context";
import type { StoredSecret, WebhookRow } from "../../db/schema";
import { hashToken, newId, newToken } from "../../platform/crypto";
import { invalid, notFound, AppError } from "../../platform/error";
import type { Changes } from "../../platform/orm";
import { WebhooksService } from "../../services/webhook.service";
import { WebhookDeliveriesService } from "../../services/webhook_delivery.service";
import { JobsService } from "../../services/job.service";
import { webhooksRepository } from "./repo";
import {
  envelope,
  testEvent,
  toDeliveryDetail,
  toDeliveryView,
  toWebhookView,
  type InboundConfig,
  type OutboundConfig,
  type Verification,
} from "./types";
import type { Tenancy } from "../tenancy/service";
import type { Environments } from "../environments/service";
import {
  runDelivery,
  type InboundRepositories,
  urlProblem,
  newSigningSecret,
  secretHint,
  needsSecret,
  signs,
  verificationProblem,
  BACKFILL_KIND,
  backfillJob,
  backfillPrefix,
  missingScopes,
  accessToken,
  shopifyClient,
  shopifyCredentials,
  shopProblem,
  ShopifyError,
  type BackfillPayload,
  type ShopifyCredentials,
} from "./libs";

const MAX_OUTBOUND = 20;
const MAX_INBOUND = 50;
/** How long the old secret keeps signing after a rotation. */
const OVERLAP_MS = 24 * 3_600_000;
const DAY = 86_400_000;

function urlToken() {
  const token = `whk_${newToken(24)}`;
  return {
    token,
    hash: hashToken(token),
    hint: `${token.slice(0, 8)}…${token.slice(-4)}`,
    path: `/v1/webhooks/${token}`,
  };
}

function sourceProblems(verification: unknown, mapping: unknown): string[] {
  const wrong = verificationProblem(verification);
  if (wrong) return [wrong];
  return validateMapping(mapping, { allowSet: signs(verification as Verification) });
}

const unavailable = (message: string) => new AppError("unavailable", "webhooks_unavailable", message);
const providerSecretHint = (secret: string) => `${secret.slice(0, 6)}…${secret.slice(-4)}`;

export function missing(hooks: Webhooks): string | undefined {
  if (!hooks.secretBox)
    return "Set KAIROS_ENCRYPTION_KEY on the server to use webhooks: it encrypts their signing secrets. Make one with: openssl rand -base64 32";
  if (!hooks.worker) return "This server does not run the delivery worker, so it cannot send webhooks.";
  return undefined;
}

type Row = WebhookRow;

export interface NewSource {
  direction: "in";
  name: string;
  preset?: string | null;
  verification: unknown;
  mapping: unknown;
  secret?: string;
}
export interface NewEndpoint {
  direction: "out";
  name: string;
  url: string;
  events: OutboundConfig["events"];
  filter?: OutboundConfig["filter"];
  include_properties: boolean;
}
export interface SourceChanges {
  name?: string;
  verification?: unknown;
  mapping?: unknown;
  enabled?: boolean;
  secret?: string;
  add_secret?: string;
  shopify?: { shop: string; token: string } | { shop: string; client_id: string; client_secret: string } | null;
}
export interface EndpointChanges {
  name?: string;
  url?: string;
  events?: OutboundConfig["events"];
  filter?: OutboundConfig["filter"];
  include_properties?: boolean;
  enabled?: boolean;
}

export function createWebhookAdmin({
  webhooks,
  tenancy,
  environments,
  repos,
  now,
  onQueued,
  fetch: fetchFn = fetch,
}: {
  webhooks?: Webhooks;
  tenancy: Tenancy;
  environments: Environments;
  repos: InboundRepositories;
  now: () => Date;
  onQueued?: () => void;
  fetch?: typeof fetch;
}) {
  async function requireAdmin(workspaceId: string, userId: string, environmentId: string | undefined) {
    await tenancy.requireRole(workspaceId, userId, "admin");
    if (!webhooks) throw unavailable("Webhooks are not set up on this server.");
    const environment = await environments.environment(workspaceId, environmentId);
    return { workspace: workspaceId, environment: environment.id, hooks: webhooks };
  }
  type Scope = Awaited<ReturnType<typeof requireAdmin>>;
  const webhooksIn = ({ workspace, environment, hooks }: Scope) =>
    new WebhooksService(hooks.db, { workspaceId: workspace, environmentId: environment });
  const deliveriesIn = ({ workspace, environment, hooks }: Scope) =>
    new WebhookDeliveriesService(hooks.db, { workspaceId: workspace, environmentId: environment });
  const updateWebhook = async (
    { workspace, environment, hooks }: Scope,
    id: string,
    changes: Changes<"webhooks">,
    at: Date,
  ) => {
    const r = await webhooksRepository(hooks.db).update(workspace, environment, id, changes, at);
    return r ? toWebhookView(r) : null;
  };

  async function findWebhook(scope: Scope, id: string): Promise<Scope & { row: Row }> {
    const row = await webhooksIn(scope).findById(id);
    if (!row) throw notFound("No such webhook");
    return { ...scope, row };
  }

  function requireConfigured(hooks: Webhooks) {
    const why = missing(hooks);
    if (why) throw unavailable(why);
  }

  function assertSource(row: Row, message: string) {
    if (row.direction !== "in") throw invalid(message);
  }
  const NOT_REPLAYABLE = "Only an incoming webhook can be replayed; an outgoing one is resent";

  const isShopify = (row: Row) => (row.config as InboundConfig).preset?.split("@")[0] === "shopify";

  /** Throws with what the person must change: the credentials are refused, or the app lacks a scope. */
  async function checkShopify(shop: string, credentials: ShopifyCredentials) {
    let missingScope: string[];
    try {
      missingScope = await missingScopes(shopifyClient(shop, await accessToken(shop, credentials, fetchFn), fetchFn));
    } catch (cause) {
      if (cause instanceof ShopifyError) throw invalid(`shopify: ${cause.message}`);
      throw cause;
    }
    if (missingScope.length)
      throw invalid(
        `shopify: the app lacks ${missingScope.join(", ")}. Add the scopes to the app and install it on the shop again.`,
      );
  }

  function backfillView(job: Awaited<ReturnType<JobsService["latest"]>>) {
    if (!job) return null;
    const p = job.payload as unknown as BackfillPayload;
    const status =
      job.status === "dead"
        ? "failed"
        : job.status === "paused"
          ? "paused"
          : job.status === "done" && p.phase === "done"
            ? "done"
            : "running";
    return {
      status,
      since: p.since,
      started: p.started,
      finished: status === "done" ? job.finished : null,
      phase: p.phase,
      ...p.counts,
      error: status === "failed" ? job.last_error : null,
    };
  }

  return {
    requireAdmin,
    findWebhook,
    assertReplayable: ({ row }: { row: Row }) => assertSource(row, NOT_REPLAYABLE),

    async list(scope: Scope, direction?: string) {
      const { hooks } = scope;
      const found = await webhooksIn(scope).list(direction === "in" || direction === "out" ? direction : undefined);
      const counts = await deliveriesIn(scope).countsSince(new Date(now().getTime() - DAY));
      return {
        webhooks: found.map((w) => ({
          ...toWebhookView(w),
          deliveries_24h: counts.get(w.id)?.total ?? 0,
          failures_24h: counts.get(w.id)?.failed ?? 0,
        })),
        ...(missing(hooks) ? { unavailable: missing(hooks) } : {}),
        ...(hooks.warning ? { warning: hooks.warning } : {}),
      };
    },

    async deliveriesAbout(scope: Scope, subject: string | undefined) {
      if (!subject) throw invalid("subject: say what the deliveries are about, for example decision:kdec_…");
      return (await deliveriesIn(scope).listAbout(subject)).map(({ webhook, ...d }) => ({
        ...toDeliveryView(d),
        webhook_name: webhook.name,
        webhook_url: webhook.url,
      }));
    },

    /** A new source. Its URL token is returned once, with the path a provider is given. */
    async createSource(scope: Scope, userId: string, body: NewSource) {
      const { hooks } = scope;
      const problems = sourceProblems(body.verification, body.mapping);
      if (problems.length) throw invalid(problems.join("; "));
      const verification = body.verification as Verification;
      if (needsSecret(verification) && !body.secret)
        throw invalid(`secret: the ${verification.scheme} scheme checks deliveries with the provider's signing secret`);
      if (needsSecret(verification) && !hooks.secretBox) throw unavailable(missing(hooks)!);
      if ((await webhooksIn(scope).count({ direction: "in" })) >= MAX_INBOUND)
        throw new AppError("conflict", "limit_reached", `An environment can have ${MAX_INBOUND} incoming webhooks.`);
      const at = now();
      const token = urlToken();
      const config: InboundConfig = {
        preset: body.preset ?? null,
        verification,
        mapping: body.mapping as WebhookMapping,
      };
      const created = await webhooksIn(scope).create(
        {
          direction: "in",
          name: body.name,
          enabled: true,
          tokenHash: token.hash,
          tokenHint: token.hint,
          secrets:
            body.secret && needsSecret(verification)
              ? [hooks.secretBox!.encrypt(body.secret, providerSecretHint(body.secret), at.toISOString())]
              : [],
          config,
          createdBy: userId,
        },
        at,
      );
      return { webhook: toWebhookView(created), token: token.token, path: token.path };
    },

    /** A new endpoint. Its signing secret is returned once. */
    async createEndpoint(scope: Scope, userId: string, body: NewEndpoint) {
      const { hooks } = scope;
      requireConfigured(hooks);
      const problem = urlProblem(body.url, hooks.allowPrivate);
      if (problem) throw invalid(`url: ${problem}`);
      if ((await webhooksIn(scope).count({ direction: "out" })) >= MAX_OUTBOUND)
        throw new AppError("conflict", "limit_reached", `An environment can have ${MAX_OUTBOUND} outgoing webhooks.`);
      const at = now();
      const secret = newSigningSecret();
      const config: OutboundConfig = {
        events: body.events,
        filter: body.filter,
        include_properties: body.include_properties,
        version: 1,
      };
      const created = await webhooksIn(scope).create(
        {
          direction: "out",
          name: body.name,
          url: body.url,
          enabled: true,
          secrets: [hooks.secretBox!.encrypt(secret, secretHint(secret), at.toISOString())],
          config,
          createdBy: userId,
        },
        at,
      );
      return { webhook: toWebhookView(created), secret };
    },

    async updateSource({ row, ...scope }: Scope & { row: Row }, changes: SourceChanges) {
      const { hooks } = scope;
      const { name, verification, mapping, enabled, secret, add_secret, shopify } = changes;
      const old = row.config as InboundConfig;
      const config: InboundConfig = {
        ...old,
        ...(verification ? { verification: verification as Verification } : {}),
        ...(mapping !== undefined ? { mapping: mapping as WebhookMapping } : {}),
      };
      if (shopify === null) delete config.shopify;
      if (shopify) {
        if (!isShopify(row)) throw invalid("shopify: only a source made from the Shopify preset imports past orders");
        const problem = shopProblem(shopify.shop);
        if (problem) throw invalid(`shopify.shop: ${problem}`);
        if (!hooks.secretBox) throw unavailable(missing(hooks)!);
        const credentials: ShopifyCredentials =
          "token" in shopify
            ? { token: shopify.token }
            : { clientId: shopify.client_id, clientSecret: shopify.client_secret };
        await checkShopify(shopify.shop, credentials);
        const seal = (secret: string) =>
          hooks.secretBox!.encrypt(secret, providerSecretHint(secret), now().toISOString());
        config.shopify =
          "token" in shopify
            ? { shop: shopify.shop, token: seal(shopify.token) }
            : { shop: shopify.shop, client_id: shopify.client_id, client_secret: seal(shopify.client_secret) };
      }
      const problems = sourceProblems(config.verification, config.mapping);
      if (problems.length) throw invalid(problems.join("; "));
      const newSecret = secret ?? add_secret;
      if (newSecret && !hooks.secretBox) throw unavailable(missing(hooks)!);
      const at = now().toISOString();
      const sealed = newSecret ? hooks.secretBox!.encrypt(newSecret, providerSecretHint(newSecret), at) : undefined;
      const secrets = secret ? [sealed!] : add_secret ? [...row.secrets, sealed!].slice(-2) : row.secrets;
      if (needsSecret(config.verification) && secrets.length === 0)
        throw invalid(`secret: the ${config.verification.scheme} scheme needs the provider's signing secret`);
      return updateWebhook(
        scope,
        row.id,
        {
          ...(name !== undefined ? { name } : {}),
          ...(enabled !== undefined ? { enabled } : {}),
          config,
          secrets: needsSecret(config.verification) ? secrets : [],
        },
        now(),
      );
    },

    async updateEndpoint({ row, ...scope }: Scope & { row: Row }, changes: EndpointChanges) {
      const { hooks } = scope;
      const { name, url, events, filter, include_properties, enabled } = changes;
      if (url !== undefined) {
        const problem = urlProblem(url, hooks.allowPrivate);
        if (problem) throw invalid(`url: ${problem}`);
      }
      const old = row.config as OutboundConfig;
      const config: OutboundConfig = {
        ...old,
        ...(events ? { events } : {}),
        ...(filter ? { filter } : {}),
        ...(include_properties !== undefined ? { include_properties } : {}),
      };
      const webhook = await updateWebhook(
        scope,
        row.id,
        {
          ...(name !== undefined ? { name } : {}),
          ...(url !== undefined ? { url } : {}),
          config,
          // Enabling again starts over: the reason and the count of failing days are cleared.
          ...(enabled !== undefined
            ? { enabled, ...(enabled ? { disabledReason: null, failingSince: null } : {}) }
            : {}),
        },
        now(),
      );
      if (enabled) hooks.worker?.wake();
      return webhook;
    },

    async remove({ workspace, environment, hooks, row }: Scope & { row: Row }) {
      await webhooksRepository(hooks.db).delete(workspace, environment, row.id);
    },

    async newToken({ row, ...scope }: Scope & { row: Row }) {
      assertSource(row, "Only an incoming webhook has a URL token");
      const token = urlToken();
      const webhook = await updateWebhook(scope, row.id, { tokenHash: token.hash, tokenHint: token.hint }, now());
      return { webhook, token: token.token, path: token.path };
    },

    /**
     * Run stored deliveries through the current mapping again: after the mapping was corrected.
     * The event ids are the same, so what was stored already is not stored twice.
     */
    async replay({ row, ...scope }: Scope & { row: Row }, which: { delivery: string } | { failed: true }) {
      assertSource(row, NOT_REPLAYABLE);
      const { hooks } = scope;
      const deliveries = deliveriesIn(scope);
      const found = await deliveries.listReplayable(row.id, which);
      if ("delivery" in which && found.length === 0)
        throw notFound("No such delivery, or its payload is no longer kept");
      const statuses: Record<string, number> = {};
      for (const d of found) {
        const outcome = await runDelivery(
          repos,
          hooks,
          row,
          d.payload,
          d.headers ?? {},
          new Date(d.created),
          now(),
          onQueued,
        );
        await deliveries.recordReplay(d.id, outcome, now());
        statuses[outcome.status] = (statuses[outcome.status] ?? 0) + 1;
      }
      return { replayed: found.length, statuses };
    },

    async backfill({ row, ...scope }: Scope & { row: Row }) {
      assertSource(row, "Only an incoming webhook imports past events");
      return backfillView(await new JobsService(scope.hooks.db).latest(BACKFILL_KIND, backfillPrefix(row.id)));
    },

    /** Import the shop's orders and disputes since `since`, through the source's mapping, in the background. */
    async startBackfill({ row, ...scope }: Scope & { row: Row }, since: Date) {
      assertSource(row, "Only an incoming webhook imports past events");
      const { hooks } = scope;
      if (!isShopify(row)) throw invalid("Only a source made from the Shopify preset imports past orders");
      const shopify = (row.config as InboundConfig).shopify;
      if (!shopify) throw invalid("Connect the shop first: paste the app's credentials");
      requireConfigured(hooks);
      const at = now();
      if (since >= at) throw invalid("since: must be in the past");
      const jobs = new JobsService(hooks.db);
      const running = await jobs.latest(BACKFILL_KIND, backfillPrefix(row.id));
      if (running?.status === "pending" || running?.status === "paused")
        throw new AppError("conflict", "backfill_running", "An import of this source is running already.");
      await checkShopify(shopify.shop, shopifyCredentials(shopify, hooks.secretBox!));
      const payload: BackfillPayload = {
        source: row.id,
        run: ulid(),
        step: 0,
        since: since.toISOString(),
        started: at.toISOString(),
        phase: "orders",
        cursor: null,
        counts: { orders: 0, disputes: 0, stored: 0, duplicate: 0, failed: 0 },
      };
      await jobs.enqueue(backfillJob({ workspaceId: scope.workspace, environmentId: scope.environment }, payload), at);
      hooks.worker?.wake();
      return backfillView(await jobs.latest(BACKFILL_KIND, backfillPrefix(row.id)));
    },

    preview(mapping: unknown, body: unknown, headers: Record<string, string> | undefined) {
      const problems = validateMapping(mapping, { allowSet: true });
      if (problems.length) return { outcome: "invalid", problems, events: [], labels: [], matched: [] };
      return applyMapping(mapping as WebhookMapping, { body, headers }, now().toISOString());
    },

    /**
     * A new signing secret. The old one keeps signing for 24 hours, so that the receiver can change over.
     * `endOverlap`: make no new secret, and stop the old one now, after the receiver changed over or because it leaked.
     */
    async rotate({ row, ...scope }: Scope & { row: Row }, endOverlap: boolean) {
      const { hooks } = scope;
      requireConfigured(hooks);
      const at = now();
      if (endOverlap) {
        const kept = row.secrets.filter((s) => !s.expires);
        if (kept.length === row.secrets.length)
          throw new AppError("conflict", "no_overlap", "There is no old secret to stop.");
        return {
          webhook: await updateWebhook(scope, row.id, { secrets: kept }, at),
          secret: null,
        };
      }
      const ends = new Date(at.getTime() + OVERLAP_MS).toISOString();
      const current = row.secrets
        .filter((s) => !s.expires || new Date(s.expires) > at)
        .map((s): StoredSecret => ({ ...s, expires: s.expires ?? ends }));
      const secret = newSigningSecret();
      const webhook = await updateWebhook(
        scope,
        row.id,
        { secrets: [...current, hooks.secretBox!.encrypt(secret, secretHint(secret), at.toISOString())] },
        at,
      );
      return { webhook, secret };
    },

    async test({ row, ...scope }: Scope & { row: Row }) {
      const { hooks } = scope;
      requireConfigured(hooks);
      const at = now();
      const event = testEvent(row.id);
      const messageId = newId("msg");
      const { id } = await deliveriesIn(scope).create(
        {
          webhookId: row.id,
          direction: "out",
          status: "pending",
          type: event.type,
          externalId: messageId,
          subjectRef: event.subjectRef ?? null,
          payload: envelope(messageId, row.workspaceId, at.toISOString(), event, undefined, row.environmentId),
          attempts: 0,
          nextAttempt: null,
        },
        at,
      );
      const result = await hooks.worker!.sendNow(id);
      return {
        delivery: id,
        delivered: result.delivered,
        status: result.status ?? null,
        ms: result.ms,
        problem: result.problem ?? null,
        body: result.body || null,
      };
    },

    listDeliveries: async (
      { row, ...scope }: Scope & { row: Row },
      filter: { status?: string; type?: string; limit: number; offset: number },
    ) => (await deliveriesIn(scope).list(row.id, filter)).map(toDeliveryView),

    async delivery({ row, ...scope }: Scope & { row: Row }, id: string) {
      const found = await deliveriesIn(scope).findInWebhook(row.id, id);
      if (!found) throw notFound("No such delivery");
      return toDeliveryDetail(found);
    },

    async resend(
      { workspace, environment, hooks, row }: Scope & { row: Row },
      which: { delivery: string } | { since?: string },
    ) {
      const queued = await webhooksRepository(hooks.db).resend(workspace, environment, row.id, which, now());
      if ("delivery" in which && queued.length === 0)
        throw notFound("No such delivery, or it is waiting to be sent already");
      if (queued.length) hooks.worker?.wake();
      return queued.length;
    },
  };
}

export type WebhookAdmin = ReturnType<typeof createWebhookAdmin>;
