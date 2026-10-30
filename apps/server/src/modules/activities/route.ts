import { Hono } from "hono";
import { requireSession } from "../../platform/auth";
import { checked, type Env } from "../../platform/http";
import type { SessionsService } from "../../services/session.service";
import { activityQuery } from "./schema";
import type { Activities } from "./service";

export function activityRoutes({
  sessions,
  activities,
  now,
}: {
  sessions: SessionsService;
  activities: Activities;
  now: () => Date;
}) {
  const app = new Hono<Env>();
  app.use("/workspaces/:workspace/activities", requireSession(sessions, now));

  app.get("/workspaces/:workspace/activities", async (c) =>
    c.json(await activities.list(c.req.param("workspace"), c.get("user").id, checked(activityQuery, c.req.query()))),
  );

  return app;
}
