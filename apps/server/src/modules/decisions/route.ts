import { GraysonError, type Decider } from "@kairos/core";
import { Hono } from "hono";
import type { Webhooks } from "../../context";
import { bounded, error, parse, type Env } from "../../platform/http";
import type { Repositories } from "../../repositories";
import { ActionsService } from "../../services/action.service";
import { DecisionsService } from "../../services/decision.service";
import { decideBody, eventBody, resolutionBody } from "../ingest/schema";
import { resolveDecision, runDecision } from "./service";
import { decideEvent } from "../ingest/service";
import { sourceOf } from "../ingest/route";

export type DecisionsDeps = Pick<Repositories, "db" | "events" | "entities" | "transaction"> & {
  decider: Decider;
  now: () => Date;
  webhooks?: Webhooks;
};

export function decisionRoutes({ db, events, entities, transaction, decider, now, webhooks }: DecisionsDeps) {
  const app = new Hono<Env>();

  app.post("/decide", async (c) => {
    const body = await parse(c, decideBody);
    if ("response" in body) return body.response;
    // "withdrawal" decides with the live version; "withdrawal@3" with that saved version.
    const pinned = /^(.*)@(\d+)$/.exec(body.data.action);
    const actions = new ActionsService(db, {
      workspaceId: c.get("workspaceId"),
      environmentId: c.get("environmentId"),
    });
    const action = pinned
      ? await actions.findVersion(pinned[1]!, Number(pinned[2]))
      : await actions.findLatest(body.data.action);
    if (!action)
      return error(
        c,
        404,
        "unknown_action",
        `No action "${body.data.action}". Define it with PUT /v1/actions/${body.data.action}`,
      );
    if (!body.data.entities[action.subject]) {
      return error(
        c,
        400,
        "invalid_request",
        `entities.${action.subject}: action "${action.name}" decides about a ${action.subject}`,
      );
    }
    try {
      // `ts` decides as of a past moment, seeing only events up to it: for backtests and replays.
      const asOf = body.data.ts ? new Date(body.data.ts) : now();
      // A decision as of a past moment tests the past: it sends no webhook.
      const outbound = webhooks && !body.data.ts ? { wake: () => webhooks.worker?.wake(), now: now() } : undefined;
      const decided = await runDecision(
        { db, events, entities, transaction },
        decider,
        c.get("workspaceId"),
        c.get("environmentId"),
        { ...body.data, action },
        asOf,
        now(),
        outbound,
        { allowPrivate: webhooks?.allowPrivate ?? false, wake: () => webhooks?.worker?.wake(), live: !body.data.ts },
      );
      await c.var.logActivity({
        action: "decision.requested",
        resource: { type: "action", id: action.name },
        details: {
          version: action.version,
          entities: body.data.entities,
          ...(body.data.ts ? { ts: body.data.ts } : {}),
        },
      });
      return c.json(decided);
    } catch (cause) {
      if (!(cause instanceof GraysonError)) throw cause;
      return error(c, 502, "model_unavailable", cause.message);
    }
  });

  app.post("/events/decide", async (c) => {
    const body = await parse(c, eventBody);
    if ("response" in body) return body.response;
    const event = { ...body.data, ts: new Date(body.data.ts).toISOString() };
    const outbound = webhooks ? { wake: () => webhooks.worker?.wake(), now: now() } : undefined;
    const decided = await decideEvent(
      { db, events, entities, transaction },
      decider,
      c.get("workspaceId"),
      c.get("environmentId"),
      event,
      sourceOf(c),
      now(),
      outbound,
      { allowPrivate: webhooks?.allowPrivate ?? false, wake: () => webhooks?.worker?.wake(), live: true },
    );
    await c.var.logActivity({
      action: "event.sent",
      resource: { type: "event", id: event.id },
      details: { type: event.type, decide: true },
    });
    return c.json(decided);
  });

  app.get("/decisions", async (c) => {
    const q = c.req.query();
    const limit = bounded(q.limit, 50, 1, 200);
    const offset = Math.max(Math.floor(Number(q.offset)) || 0, 0);
    const filter = {
      before: q.before && !Number.isNaN(Date.parse(q.before)) ? q.before : undefined,
      outcome: q.outcome || undefined,
      final_outcome: q.final_outcome || undefined,
      action: q.action || undefined,
      session: q.session || undefined,
      subject: q.subject_type && q.subject_id ? { type: q.subject_type, id: q.subject_id } : undefined,
      decided_by: q.decided_by === "workflow" || q.decided_by === "policy" ? q.decided_by : undefined,
      workflow: q.workflow || undefined,
      rule: q.rule || undefined,
    } as const;
    const decisions = new DecisionsService(db, {
      workspaceId: c.get("workspaceId"),
      environmentId: c.get("environmentId"),
    });
    const [found, total] = await Promise.all([
      decisions.listSummaries({ ...filter, limit, offset }),
      decisions.countMatching(filter),
    ]);
    return c.json({
      decisions: found,
      total,
      next_before: found.length === limit ? found[found.length - 1]!.ts : null,
    });
  });

  app.get("/decisions/:id", async (c) => {
    const record = await new DecisionsService(db, {
      workspaceId: c.get("workspaceId"),
      environmentId: c.get("environmentId"),
    }).findRecord(c.req.param("id"));
    return record ? c.json(record) : error(c, 404, "not_found", `No decision "${c.req.param("id")}"`);
  });

  app.post("/decisions/:id/resolution", async (c) => {
    const body = await parse(c, resolutionBody);
    if ("response" in body) return body.response;
    const person = c.get("userId") ? c.get("user") : undefined;
    const by = person ? person.email : (body.data.by ?? "API");
    const resolution = {
      outcome: body.data.outcome,
      ...(body.data.note ? { note: body.data.note } : {}),
      by,
      at: now().toISOString(),
    };
    const done = await resolveDecision(
      { transaction },
      c.get("workspaceId"),
      c.get("environmentId"),
      c.req.param("id"),
      resolution,
      now(),
    );
    if (!done) return error(c, 404, "not_found", `No decision "${c.req.param("id")}"`);
    if (done.queued > 0) webhooks?.worker?.wake();
    await c.var.logActivity({
      action: "decision.resolved",
      resource: { type: "decision", id: c.req.param("id") },
      details: { outcome: body.data.outcome },
    });
    const { context: _context, raw: _raw, ...summary } = done.record;
    return c.json(summary);
  });

  return app;
}
