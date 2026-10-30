import { Hono, type Context } from "hono";
import { error, parse, type Env } from "../../platform/http";
import { requireSession } from "../../platform/auth";
import { deleteWorkspaceBody, workspaceBody } from "../tenancy/schema";
import { copyOptionsQuery, sandboxBody } from "./schema";
import type { SessionsService } from "../../services/session.service";
import type { Environments } from "./service";
import type { Role } from "../../types";

export interface EnvironmentsDeps {
  sessions: SessionsService;
  environments: Environments;
  requireRole: (workspaceId: string, userId: string, needed: Role) => Promise<Role>;
  now: () => Date;
}

export function environmentRoutes({ sessions, environments, requireRole, now }: EnvironmentsDeps) {
  const app = new Hono<Env>();
  app.use("/workspaces/:workspace/environments/*", requireSession(sessions, now));
  app.use("/workspaces/:workspace/environments", requireSession(sessions, now));

  const access = async (c: Context<Env>, needed: Role) => {
    const workspace = c.req.param("workspace")!;
    await requireRole(workspace, c.get("user").id, needed);
    return workspace;
  };

  app.get("/workspaces/:workspace/environments", async (c) => {
    const workspace = await access(c, "member");
    return c.json({ environments: await environments.list(workspace) });
  });

  app.get("/workspaces/:workspace/environments/:environment/copy-options", async (c) => {
    const workspace = await access(c, "admin");
    const source = await environments.environment(workspace, c.req.param("environment"), "No such source environment");
    const query = copyOptionsQuery.safeParse(c.req.query());
    if (!query.success) return error(c, 400, "invalid_request", "Choose a valid copy category, search, and page");
    return c.json(await environments.copyOptions(workspace, source.id, c.get("user").id, query.data));
  });

  app.post("/workspaces/:workspace/environments", async (c) => {
    const workspace = await access(c, "admin");
    const input = await parse(c, sandboxBody);
    if ("response" in input) return input.response;
    const sandbox = await environments.createSandbox(workspace, input.data, c.get("user").id);
    await c.var.logActivity({
      environmentId: null,
      action: "environment.created",
      resource: { type: "environment", id: sandbox.id },
      details: { name: sandbox.name },
    });
    return c.json(sandbox, 201);
  });

  app.patch("/workspaces/:workspace/environments/:environment", async (c) => {
    const workspace = await access(c, "admin");
    const target = await environments.sandbox(workspace, c.req.param("environment"), "Production cannot be renamed");
    const input = await parse(c, workspaceBody);
    if ("response" in input) return input.response;
    const renamed = await environments.renameSandbox(workspace, target.id, input.data.name);
    await c.var.logActivity({
      environmentId: null,
      action: "environment.renamed",
      resource: { type: "environment", id: target.id },
      details: { from: target.name, to: input.data.name },
    });
    return c.json(renamed);
  });

  app.delete("/workspaces/:workspace/environments/:environment", async (c) => {
    const workspace = await access(c, "admin");
    const target = await environments.sandbox(
      workspace,
      c.req.param("environment"),
      "Production is deleted only with its workspace",
    );
    const input = await parse(c, deleteWorkspaceBody);
    if ("response" in input) return input.response;
    await environments.deleteSandbox(workspace, target, input.data.confirm);
    await c.var.logActivity({
      environmentId: null,
      action: "environment.deleted",
      resource: { type: "environment", id: target.id },
      details: { name: target.name },
    });
    return c.json({ ok: true });
  });

  return app;
}
