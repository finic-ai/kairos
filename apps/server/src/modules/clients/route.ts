import { Hono, type Context } from "hono";
import { requireSession } from "../../platform/auth";
import { parse, type Env } from "../../platform/http";
import type { SessionsService } from "../../services/session.service";
import type { Role } from "../../types";
import type { Environments } from "../environments/service";
import { clientSettingsBody } from "./schema";
import type { Clients } from "./service";

export interface ClientsDeps {
  clients: Clients;
  environments: Environments;
  sessions: SessionsService;
  requireRole: (workspaceId: string, userId: string, needed: Role) => Promise<Role>;
  now: () => Date;
}

export function clientsAdminRoutes({ clients, environments, sessions, requireRole, now }: ClientsDeps) {
  const app = new Hono<Env>();
  const path = "/workspaces/:workspace/client-settings";
  app.use(path, requireSession(sessions, now));

  /** The workspace, and the environment that the console names, Production without one. */
  const access = async (c: Context<Env>, needed: Role) => {
    const workspace = c.req.param("workspace")!;
    await requireRole(workspace, c.get("user").id, needed);
    const environment = await environments.environment(workspace, c.req.header("x-kairos-environment"));
    return { workspace, environment: environment.id };
  };

  app.get(path, async (c) => {
    const a = await access(c, "member");
    return c.json(await clients.settings(a.workspace, a.environment));
  });

  app.put(path, async (c) => {
    const a = await access(c, "admin");
    const body = await parse(c, clientSettingsBody);
    if ("response" in body) return body.response;
    const saved = await clients.save(a.workspace, a.environment, body.data);
    await c.var.logActivity({
      environmentId: a.environment,
      action: "environment.client_settings_updated",
      resource: { type: "environment", id: a.environment },
      details: { version: saved.version },
    });
    return c.json(saved);
  });

  return app;
}

/** The same settings for an API key, in the key's environment. A public key is refused before it gets here. */
export function clientsRoutes({ clients }: Pick<ClientsDeps, "clients">) {
  const app = new Hono<Env>();

  app.get("/client-settings", async (c) =>
    c.json(await clients.settings(c.get("workspaceId"), c.get("environmentId"))),
  );

  app.put("/client-settings", async (c) => {
    const body = await parse(c, clientSettingsBody);
    if ("response" in body) return body.response;
    const saved = await clients.save(c.get("workspaceId"), c.get("environmentId"), body.data);
    await c.var.logActivity({
      action: "environment.client_settings_updated",
      resource: { type: "environment", id: c.get("environmentId") },
      details: { version: saved.version },
    });
    return c.json(saved);
  });

  return app;
}
