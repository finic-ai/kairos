import type { ActionDefinition } from "@kairos/core";
import { Hono, type Context } from "hono";
import { error, type Env } from "../../platform/http";
import type { Repositories } from "../../repositories";
import { ActionsService } from "../../services/action.service";
import type { AutomaticRunner } from "../decisions/libs";
import { putAction } from "./service";

export type ActionsDeps = Pick<Repositories, "db"> & {
  now: () => Date;
  templates: ActionDefinition[];
  automatic?: AutomaticRunner;
};

export function actionRoutes({ db, now, templates, automatic }: ActionsDeps) {
  const app = new Hono<Env>();
  const actionsOf = (c: Context<Env>) =>
    new ActionsService(db, { workspaceId: c.get("workspaceId"), environmentId: c.get("environmentId") });

  app.put("/actions/:name", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Partial<ActionDefinition> | null;
    const existed = await actionsOf(c).findLatest(c.req.param("name"));
    const saved = await putAction(
      db,
      c.get("workspaceId"),
      c.get("environmentId"),
      c.req.param("name"),
      body,
      now(),
      c.get("userId") ?? null,
    );
    await c.var.logActivity({
      action: existed ? "action.updated" : "action.created",
      resource: { type: "action", id: saved.name },
      details: { version: saved.version, ...(existed ? { from_version: existed.version } : {}) },
    });
    return c.json(saved);
  });

  app.get("/actions", async (c) => c.json({ actions: await actionsOf(c).listLatest() }));

  app.get("/actions/:name", async (c) => {
    const asked = c.req.query("version");
    const version = asked === undefined ? undefined : Number(asked);
    if (version !== undefined && (!Number.isInteger(version) || version < 1))
      return error(c, 404, "not_found", `No version "${asked}" of action "${c.req.param("name")}"`);
    const action =
      version === undefined
        ? await actionsOf(c).findLatest(c.req.param("name"))
        : await actionsOf(c).findVersion(c.req.param("name"), version);
    return action ? c.json(action) : error(c, 404, "not_found", `No action "${c.req.param("name")}"`);
  });

  app.get("/actions/:name/versions", async (c) => {
    const action = await actionsOf(c).findLatest(c.req.param("name"));
    if (!action) return error(c, 404, "not_found", `No action "${c.req.param("name")}"`);
    return c.json({ versions: await actionsOf(c).listVersions(c.req.param("name")) });
  });

  app.get("/actions/:name/automatic", async (c) => {
    const action = await actionsOf(c).findLatest(c.req.param("name"));
    if (!action) return error(c, 404, "not_found", `No action "${c.req.param("name")}"`);
    if (!automatic) return c.json({ available: false, per_day: 0, missed_last_day: 0, window_minutes: 60 });
    return c.json({
      available: true,
      ...(await automatic.estimate(c.get("workspaceId"), c.get("environmentId"), action)),
    });
  });

  app.get("/templates", (c) => c.json({ templates }));

  return app;
}
