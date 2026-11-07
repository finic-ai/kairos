import { Hono, type Context } from "hono";
import type { Webhooks } from "../../context";
import { bounded, parse, readCapped, type Env } from "../../platform/http";
import { requireSession } from "../../platform/auth";
import type { SessionsService } from "../../services/session.service";
import {
  createWebhookBody,
  previewBody,
  replayBody,
  resendBody,
  rotateBody,
  updateSourceBody,
  updateWebhookBody,
} from "./schema";
import type { NewEndpoint, NewSource, WebhookAdmin } from "./service";
import { toWebhookView } from "./types";
import { MAX_BODY, receive, type InboundRepositories, type WebhookPreset } from "./libs";

export function webhookRoutes({
  sessions,
  admin,
  now,
}: {
  sessions: SessionsService;
  admin: WebhookAdmin;
  now: () => Date;
}) {
  const app = new Hono<Env>();
  const base = "/workspaces/:workspace/webhooks";
  app.use(base, requireSession(sessions, now));
  app.use(`${base}/*`, requireSession(sessions, now));
  app.use("/workspaces/:workspace/webhook-deliveries", requireSession(sessions, now));

  const requireAdmin = (c: Context<Env>) =>
    admin.requireAdmin(c.req.param("workspace")!, c.get("user").id, c.req.header("x-kairos-environment"));
  const findWebhook = async (c: Context<Env>) => admin.findWebhook(await requireAdmin(c), c.req.param("webhook")!);
  const logWebhook = (
    c: Context<Env>,
    scope: { workspace: string; environment: string },
    verb: string,
    webhook: { id: string; name: string },
    details: Record<string, unknown> = {},
  ) =>
    c.var.logActivity({
      workspaceId: scope.workspace,
      environmentId: scope.environment,
      action: `webhook.${verb}`,
      resource: { type: "webhook", id: webhook.id },
      details: { name: webhook.name, ...details },
    });

  app.get(base, async (c) => c.json(await admin.list(await requireAdmin(c), c.req.query("direction"))));

  app.get("/workspaces/:workspace/webhook-deliveries", async (c) =>
    c.json({ deliveries: await admin.deliveriesAbout(await requireAdmin(c), c.req.query("subject")) }),
  );

  app.post(base, async (c) => {
    const scope = await requireAdmin(c);
    const input = await parse(c, createWebhookBody);
    if ("response" in input) return input.response;
    const body = input.data;
    const created =
      body.direction === "in"
        ? await admin.createSource(scope, c.get("user").id, body as NewSource)
        : await admin.createEndpoint(scope, c.get("user").id, body as NewEndpoint);
    await logWebhook(c, scope, "created", created.webhook, { direction: body.direction });
    // The only time the token, or the secret, is returned. A provider is given `path` on this server's address.
    return c.json(created);
  });

  app.get(`${base}/:webhook`, async (c) => {
    const t = await findWebhook(c);
    return c.json(toWebhookView(t.row));
  });

  app.patch(`${base}/:webhook`, async (c) => {
    const t = await findWebhook(c);
    // The names of the changed fields only: a change can hold a secret.
    if (t.row.direction === "in") {
      const input = await parse(c, updateSourceBody);
      if ("response" in input) return input.response;
      const updated = await admin.updateSource(t, input.data);
      await logWebhook(c, t, "updated", t.row, { fields: Object.keys(input.data) });
      return c.json(updated);
    }
    const input = await parse(c, updateWebhookBody);
    if ("response" in input) return input.response;
    const updated = await admin.updateEndpoint(t, input.data);
    await logWebhook(c, t, "updated", t.row, { fields: Object.keys(input.data) });
    return c.json(updated);
  });

  app.delete(`${base}/:webhook`, async (c) => {
    const t = await findWebhook(c);
    await admin.remove(t);
    await logWebhook(c, t, "deleted", t.row);
    return c.json({ ok: true });
  });

  // A new URL for a source. The old one stops at once: for a token that leaked.
  app.post(`${base}/:webhook/token`, async (c) => {
    const t = await findWebhook(c);
    const made = await admin.newToken(t);
    await logWebhook(c, t, "token_rotated", t.row);
    return c.json(made);
  });

  app.post(`${base}/:webhook/replay`, async (c) => {
    const t = await findWebhook(c);
    admin.assertReplayable(t);
    const input = await parse(c, replayBody);
    if ("response" in input) return input.response;
    const which = "delivery" in input.data ? { delivery: input.data.delivery } : { failed: true as const };
    const replayed = await admin.replay(t, which);
    await logWebhook(c, t, "replayed", t.row, which);
    return c.json(replayed);
  });

  app.post(`${base}/preview`, async (c) => {
    await requireAdmin(c);
    const input = await parse(c, previewBody);
    if ("response" in input) return input.response;
    return c.json(admin.preview(input.data.mapping, input.data.body, input.data.headers));
  });

  app.post(`${base}/:webhook/rotate`, async (c) => {
    const t = await findWebhook(c);
    const input = await parse(c, rotateBody);
    if ("response" in input) return input.response;
    const rotated = await admin.rotate(t, input.data.end_overlap ?? false);
    await logWebhook(c, t, "secret_rotated", t.row, { end_overlap: input.data.end_overlap ?? false });
    return c.json(rotated);
  });

  app.post(`${base}/:webhook/test`, async (c) => {
    const t = await findWebhook(c);
    const tested = await admin.test(t);
    await logWebhook(c, t, "tested", t.row);
    return c.json(tested);
  });

  app.get(`${base}/:webhook/deliveries`, async (c) => {
    const t = await findWebhook(c);
    const q = c.req.query();
    const limit = bounded(q.limit, 50, 1, 200);
    const offset = Math.max(Math.floor(Number(q.offset)) || 0, 0);
    const deliveries = await admin.listDeliveries(t, {
      status: q.status || undefined,
      type: q.type || undefined,
      limit,
      offset,
    });
    return c.json({ deliveries, next_offset: deliveries.length === limit ? offset + limit : null });
  });

  app.get(`${base}/:webhook/deliveries/:delivery`, async (c) =>
    c.json(await admin.delivery(await findWebhook(c), c.req.param("delivery"))),
  );

  app.post(`${base}/:webhook/resend`, async (c) => {
    const t = await findWebhook(c);
    const input = await parse(c, resendBody);
    if ("response" in input) return input.response;
    const which = "delivery" in input.data ? { delivery: input.data.delivery } : { since: input.data.since };
    const queued = await admin.resend(t, which);
    await logWebhook(c, t, "resent", t.row, { ...which, queued });
    return c.json({ queued });
  });

  return app;
}

/**
 * An inbound webhook: a provider cannot send a Kairos key, so the token in the URL and the
 * provider's signature over the body stand for one. Mount it before the key check, which it skips.
 */
export function inboundRoutes({
  webhooks,
  repos,
  now,
  onQueued,
}: {
  webhooks?: Webhooks;
  repos: InboundRepositories;
  now: () => Date;
  onQueued?: () => void;
}) {
  const app = new Hono<Env>();
  app.post("/webhooks/:token", async (c) => {
    if (!webhooks) return c.json({ error: { type: "not_found", message: "No such webhook" } }, 404);
    // Not a 413 here: receive() still records the rejected delivery.
    const raw = await readCapped(c.req.raw, MAX_BODY);
    const answer = await receive(
      repos,
      webhooks,
      c.req.param("token"),
      raw,
      c.req.header(),
      now(),
      webhooks.payloadDays ?? 7,
      onQueued,
    );
    return c.json(answer.body, answer.status);
  });
  return app;
}

export function presetRoutes(presets: WebhookPreset[]) {
  const app = new Hono<Env>();
  app.get("/webhook-presets", (c) => c.json({ presets }));
  return app;
}
