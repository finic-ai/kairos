import { Hono } from "hono";
import { requireSession } from "../../platform/auth";
import { parse, type Env } from "../../platform/http";
import type { SessionsService } from "../../services/session.service";
import type { Role } from "../../types";
import type { Environments } from "../environments/service";
import { deployBody, zonesBody } from "./schema";
import type { Cloudflare } from "./service";

export interface CloudflareDeps {
  cloudflare: Cloudflare;
  environments: Environments;
  sessions: SessionsService;
  requireRole: (workspaceId: string, userId: string, needed: Role) => Promise<Role>;
  now: () => Date;
}

export function cloudflareRoutes({ cloudflare, environments, sessions, requireRole, now }: CloudflareDeps) {
  const app = new Hono<Env>();
  app.use("/workspaces/:workspace/cloudflare/*", requireSession(sessions, now));

  app.post("/workspaces/:workspace/cloudflare/zones", async (c) => {
    await requireRole(c.req.param("workspace"), c.get("user").id, "admin");
    const body = await parse(c, zonesBody);
    if ("response" in body) return body.response;
    const zones = await cloudflare.zones(body.data.token);
    return c.json({ zones: zones.map((zone) => ({ id: zone.id, name: zone.name, account: zone.account.name })) });
  });

  app.post("/workspaces/:workspace/cloudflare/deploy", async (c) => {
    const workspace = c.req.param("workspace");
    await requireRole(workspace, c.get("user").id, "admin");
    const body = await parse(c, deployBody);
    if ("response" in body) return body.response;
    const environment = await environments.environment(workspace, c.req.header("x-kairos-environment"));
    const deployed = await cloudflare.deploy(workspace, c.get("user").id, environment, body.data);
    await c.var.logActivity({
      environmentId: environment.id,
      action: "integration.cloudflare_deployed",
      resource: { type: "environment", id: environment.id },
      details: { zone: deployed.zone, pattern: deployed.pattern, script: deployed.script, key: deployed.key.id },
    });
    return c.json(deployed);
  });

  return app;
}
