import type { ActionDefinition } from "@kairos/core";
import { Hono, type Context } from "hono";
import { bounded, error, parse, type Env } from "../../platform/http";
import type { Repositories } from "../../repositories";
import { ActionsService } from "../../services/action.service";
import { DashboardsService } from "../../services/dashboard.service";
import { LabelsService } from "../../services/label.service";
import { dashboardBody, metricRequest, type MetricResult } from "./schema";
import { canSee, computeMetric, overview, canManage, asSeenBy, toDashboard } from "./service";

/** One request reads at most this many rows. Past it, the result says it is a lower bound. */
const METRIC_ROWS = 250_000;
const DAY = 86_400_000;

export type ObserveDeps = Pick<Repositories, "db" | "analytics" | "entities"> & {
  now: () => Date;
};

export function dashboardRoutes({ db, analytics, entities, now }: ObserveDeps) {
  const app = new Hono<Env>();
  const scopeOf = (c: Context<Env>) => ({ workspaceId: c.get("workspaceId"), environmentId: c.get("environmentId") });
  const dashboardsOf = (c: Context<Env>) => new DashboardsService(db, scopeOf(c));
  const findDashboard = async (c: Context<Env>) => {
    const r = await dashboardsOf(c).findById(c.req.param("id")!);
    return r ? toDashboard(r) : null;
  };

  app.get("/stats", async (c) => c.json(await analytics.stats(c.get("workspaceId"), c.get("environmentId"))));

  app.get("/usage", async (c) => {
    const days = bounded(c.req.query("days"), 30, 1, 366);
    const start = new Date(Math.floor(now().getTime() / DAY) * DAY - (days - 1) * DAY);
    return c.json({
      days_asked: days,
      since: start.toISOString(),
      ...(await analytics.usage(c.get("workspaceId"), c.get("environmentId"), start.toISOString())),
    });
  });

  app.get("/overview", async (c) =>
    c.json(await overview({ db, analytics, entities }, c.get("workspaceId"), c.get("environmentId"))),
  );

  app.post("/metrics/query", async (c) => {
    const body = await parse(c, metricRequest);
    if ("response" in body) return body.response;
    const request = body.data;
    const workspaceId = c.get("workspaceId");
    const environmentId = c.get("environmentId");
    if (Date.parse(request.to) <= Date.parse(request.from))
      return error(c, 400, "invalid_request", "to: must be after from");
    const labelled = request.filters.subject_label
      ? await new LabelsService(db, { workspaceId, environmentId }).indexByEntity()
      : new Map<string, Set<string>>();
    const read = (from: string, to: string) => {
      // The database narrows events to the type and the property value, so the row limit is spent on rows that count.
      const events = request.source === "events" ? request.filters : undefined;
      return analytics.metricRows(
        workspaceId,
        environmentId,
        request.source,
        from,
        to,
        METRIC_ROWS + 1,
        events?.event_type,
        events?.property,
      );
    };

    const rows = await read(request.from, request.to);
    const result: MetricResult = {
      ...computeMetric(rows.slice(0, METRIC_ROWS), request, labelled),
      truncated: rows.length > METRIC_ROWS,
    };
    if (request.compare) {
      const span = Date.parse(request.to) - Date.parse(request.from);
      const before = {
        ...request,
        from: new Date(Date.parse(request.from) - span).toISOString(),
        to: request.from,
        interval: undefined,
      };
      result.previous_total = computeMetric(
        (await read(before.from, before.to)).slice(0, METRIC_ROWS),
        before,
        labelled,
      ).total;
    }
    return c.json(result);
  });

  app.get("/metrics/options", async (c) => {
    const defined = await new ActionsService(db, scopeOf(c)).listLatest();
    const keys = (pick: (a: ActionDefinition) => Record<string, string> | undefined) =>
      [...new Set(defined.flatMap((a) => Object.keys(pick(a) ?? {})))].sort();
    return c.json({
      actions: defined.map((a) => a.name),
      signals: keys((a) => a.reasons),
      typologies: keys((a) => a.typologies),
      ...(await analytics.metricOptions(
        c.get("workspaceId"),
        c.get("environmentId"),
        c.req.query("event_type") || undefined,
      )),
    });
  });

  app.get("/dashboards", async (c) => {
    const viewer = c.get("userId");
    return c.json({
      dashboards: (await dashboardsOf(c).list())
        .map(toDashboard)
        .filter((d) => canSee(d, viewer))
        .map((d) => asSeenBy(d, viewer)),
    });
  });

  app.post("/dashboards", async (c) => {
    const body = await parse(c, dashboardBody);
    if ("response" in body) return body.response;
    const viewer = c.get("userId");
    if (!viewer && body.data.visibility === "private")
      return error(
        c,
        400,
        "invalid_request",
        "visibility: a dashboard made with an API key has no owner, so it cannot be private",
      );
    const created = await dashboardsOf(c).create({ definition: body.data, owner: viewer ?? null }, now());
    await c.var.logActivity({
      action: "dashboard.created",
      resource: { type: "dashboard", id: created.id },
      details: { name: body.data.name, visibility: body.data.visibility },
    });
    return c.json(asSeenBy(toDashboard(created), viewer));
  });

  app.get("/dashboards/:id", async (c) => {
    const dashboard = await findDashboard(c);
    return dashboard && canSee(dashboard, c.get("userId"))
      ? c.json(asSeenBy(dashboard, c.get("userId")))
      : error(c, 404, "not_found", "No such dashboard");
  });

  app.put("/dashboards/:id", async (c) => {
    const viewer = c.get("userId");
    const existing = await findDashboard(c);
    if (!existing || !canSee(existing, viewer)) return error(c, 404, "not_found", "No such dashboard");
    const body = await parse(c, dashboardBody);
    if ("response" in body) return body.response;
    if (
      !canManage(existing, viewer) &&
      (body.data.name !== existing.name || body.data.visibility !== existing.visibility)
    ) {
      return error(c, 403, "forbidden", "Only the person who made this dashboard can rename it or change who sees it");
    }
    if (existing.owner === null && body.data.visibility === "private")
      return error(c, 400, "invalid_request", "visibility: this dashboard has no owner, so it cannot be private");
    const saved = await dashboardsOf(c).update(existing.id, { definition: body.data }, now());
    if (!saved) return error(c, 404, "not_found", "No such dashboard");
    await c.var.logActivity({
      action: "dashboard.updated",
      resource: { type: "dashboard", id: saved.id },
      details: { name: body.data.name, visibility: body.data.visibility },
    });
    return c.json(asSeenBy(toDashboard(saved), viewer));
  });

  app.delete("/dashboards/:id", async (c) => {
    const existing = await findDashboard(c);
    if (!existing || !canSee(existing, c.get("userId"))) return error(c, 404, "not_found", "No such dashboard");
    if (!canManage(existing, c.get("userId")))
      return error(c, 403, "forbidden", "Only the person who made this dashboard can delete it");
    await dashboardsOf(c).delete(existing.id);
    await c.var.logActivity({
      action: "dashboard.deleted",
      resource: { type: "dashboard", id: existing.id },
      details: { name: existing.name },
    });
    return c.json({ ok: true });
  });

  return app;
}
