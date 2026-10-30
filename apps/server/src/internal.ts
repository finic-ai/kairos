import { timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import type { Webhooks } from "./context";
import { error, type Env } from "./platform/http";
import type { Jobs } from "./platform/jobs/worker";
import { LOG_DAYS } from "./modules/webhooks/libs";
import { WebhookDeliveriesService } from "./services/webhook_delivery.service";

/** Within the 60 seconds a Vercel function may run, with time left to answer. */
const DRAIN_BUDGET_MS = 45_000;

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function internalRoutes(webhooks: Webhooks | undefined, now: () => Date, jobs?: Jobs) {
  const app = new Hono<Env>();

  const runDueJobs = async (c: Context<Env>) => {
    const runner = jobs ?? webhooks?.worker;
    // Closed unless a secret is set: an open route would let anyone make the server work.
    if (!webhooks?.cronSecret || !runner) return error(c, 404, "not_found", "Not found");
    if (!same(c.req.header("authorization") ?? "", `Bearer ${webhooks.cronSecret}`))
      return error(c, 401, "authentication_error", "Wrong or missing CRON_SECRET");
    const attempted = await runner.drain({ budgetMs: DRAIN_BUDGET_MS });
    const deleted = await WebhookDeliveriesService.cleanup(webhooks.db, now(), LOG_DAYS, webhooks.payloadDays);
    return c.json({ attempted, deleted });
  };
  app.get("/jobs/drain", runDueJobs);
  app.get("/webhooks/drain", runDueJobs);

  return app;
}
