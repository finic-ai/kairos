import type { MiddlewareHandler } from "hono";
import { error, type Env } from "../http";
import { clientIp, ipAllowed, originAllowed } from "../network";
import type { Executor } from "../database";
import { ApiKeysService } from "../../services/api_key.service";
import { EnvironmentsService } from "../../services/environment.service";
import { MembershipsService } from "../../services/membership.service";
import { SessionsService } from "../../services/session.service";
import { sessionUser } from "./session";

interface Options {
  db: Executor;
  trustProxy?: boolean;
  now: () => Date;
}

/**
 * Two ways in to the data API: an API key, or a signed-in person with a workspace chosen.
 * Each one confines the request to a single workspace.
 */
export function apiAuth(options: Options): MiddlewareHandler<Env> {
  const { db, now } = options;
  const sessions = new SessionsService(db);

  return async (c, next) => {
    const bearer = c.req.header("authorization")?.match(/^Bearer (.+)$/)?.[1];
    if (bearer) {
      const key = await ApiKeysService.findBySecret(db, bearer);
      if (!key) return error(c, 401, "authentication_error", "Unknown or revoked API key");
      if (!key.workspaceActive) return error(c, 403, "workspace_suspended", "This workspace is suspended");
      if (!ipAllowed(clientIp(c, options.trustProxy), key.allowedIps))
        return error(c, 403, "ip_not_allowed", "This API key cannot be used from this IP address");
      // A public key can be read out of a web page by anyone, so it can only add events, and read
      // the part of the client settings that the website script needs.
      const allowed =
        (c.req.method === "POST" && c.req.path === "/v1/events") ||
        (c.req.method === "GET" && c.req.path === "/v1/client-settings");
      if (key.kind === "public" && !allowed) {
        return error(
          c,
          403,
          "public_key_scope",
          "A public key can only send events. Use a secret key from your server for this request.",
        );
      }
      if (!originAllowed(c.req.header("origin"), key.allowedOrigins))
        return error(c, 403, "origin_not_allowed", "This API key cannot be used from this website");
      await new ApiKeysService(db, { workspaceId: key.workspaceId }).updateLastUsed(key, now());
      c.set("workspaceId", key.workspaceId);
      c.set("environmentId", key.environmentId);
      c.set("publicKey", key.kind === "public");
      c.set("apiKey", { id: key.id, name: key.name });
      return next();
    }
    const user = await sessionUser(c, sessions, now());
    if (!user) return error(c, 401, "authentication_error", "Missing API key");
    const workspace = c.req.header("x-kairos-workspace");
    if (!workspace) return error(c, 400, "invalid_request", "X-Kairos-Workspace: choose a workspace");
    const membership = await new MembershipsService(db, { workspaceId: workspace }).findByUser(user.id);
    if (!membership) return error(c, 403, "forbidden", "You are not a member of this workspace");
    if (!membership.active) return error(c, 403, "forbidden", "This workspace, or your membership of it, is suspended");
    const environment = await new EnvironmentsService(db, { workspaceId: workspace }).findByIdOrProduction(
      c.req.header("x-kairos-environment"),
    );
    if (!environment) return error(c, 404, "not_found", "No such environment");
    c.set("environmentId", environment.id);
    c.set("workspaceId", workspace);
    c.set("userId", user.id);
    c.set("role", membership.role);
    c.set("user", user);
    await next();
  };
}
