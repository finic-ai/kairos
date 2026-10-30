import { Hono, type Context } from "hono";
import { requireSession } from "../../platform/auth";
import { bounded, error, type Env } from "../../platform/http";
import type { SessionsService } from "../../services/session.service";
import type { JobsAdmin } from "./service";
import { JOB_STATUSES, type JobStatus } from "./types";

export function jobRoutes({ sessions, admin, now }: { sessions: SessionsService; admin: JobsAdmin; now: () => Date }) {
  const app = new Hono<Env>();
  const base = "/workspaces/:workspace/jobs";
  app.use(base, requireSession(sessions, now));
  app.use(`${base}/*`, requireSession(sessions, now));

  const requireAdmin = (c: Context<Env>) =>
    admin.requireAdmin(c.req.param("workspace")!, c.get("user").id, c.req.header("x-kairos-environment"));

  app.get(base, async (c) => {
    const scope = await requireAdmin(c);
    const q = c.req.query();
    if (q.status && !JOB_STATUSES.includes(q.status as JobStatus))
      return error(c, 400, "invalid_request", `status: one of ${JOB_STATUSES.join(", ")}`);
    const limit = bounded(q.limit, 50, 1, 200);
    const offset = Math.max(Math.floor(Number(q.offset)) || 0, 0);
    const jobs = await admin.list(scope, {
      status: (q.status || undefined) as JobStatus | undefined,
      kind: q.kind || undefined,
      limit,
      offset,
    });
    return c.json({ jobs, next_offset: jobs.length === limit ? offset + limit : null });
  });

  app.get(`${base}/summary`, async (c) => c.json(await admin.summary(await requireAdmin(c))));

  app.get(`${base}/:job`, async (c) => c.json(await admin.job(await requireAdmin(c), c.req.param("job"))));

  app.post(`${base}/:job/retry`, async (c) => {
    const scope = await requireAdmin(c);
    const job = await admin.retry(scope, c.req.param("job"));
    await c.var.logActivity({ ...scope, action: "job.retried", resource: { type: "job", id: c.req.param("job") } });
    return c.json(job);
  });

  return app;
}
