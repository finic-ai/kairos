import type { MiddlewareHandler } from "hono";
import { ActivitiesService } from "../services/activity.service";
import type { Executor } from "./database";
import type { Env } from "./http";
import { clientIp } from "./network";

export interface Activity {
  /** "<resource>.<verb>": "api_key.created", "workflow.published". */
  action: string;
  resource: { type: string; id?: string | null };
  details?: Record<string, unknown>;
  /** The request's by default: the workspace of the data API, or the `:workspace` of the path. */
  workspaceId?: string;
  /** The request's by default. Null for a change to the workspace itself. */
  environmentId?: string | null;
  /** The person signed in, by default. */
  userId?: string;
}

export type LogActivity = (activity: Activity) => Promise<void>;

/** Gives each request `c.var.logActivity`. Only a person's activity is recorded: an API key's is not, yet. */
export function activityLog({
  db,
  now,
  trustProxy = false,
}: {
  db: Executor;
  now: () => Date;
  trustProxy?: boolean;
}): MiddlewareHandler<Env> {
  return async (c, next) => {
    c.set("logActivity", async (activity) => {
      const userId = activity.userId ?? c.get("user")?.id;
      if (!userId || c.get("apiKey")) return;
      const workspaceId = activity.workspaceId ?? c.get("workspaceId") ?? c.req.param("workspace");
      if (!workspaceId) throw new Error(`logActivity(${activity.action}): the request has no workspace`);
      await new ActivitiesService(db, { workspaceId }).record(
        {
          environmentId:
            activity.environmentId === undefined ? (c.get("environmentId") ?? null) : activity.environmentId,
          source: "dashboard",
          userId,
          action: activity.action,
          resourceType: activity.resource.type,
          resourceId: activity.resource.id ?? null,
          details: activity.details ?? {},
          ip: clientIp(c, trustProxy) ?? null,
          userAgent: c.req.header("user-agent") ?? null,
        },
        now(),
      );
    });
    await next();
  };
}
