import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono, type Context } from "hono";
import { requireSession } from "../../platform/auth";
import { error, parse, type Env } from "../../platform/http";
import type { SessionsService } from "../../services/session.service";
import type { Role } from "../../types";
import { callRoute, type FetchApp } from "./libs";
import { settingsBody } from "./schema";
import type { Mcp } from "./service";

export interface McpDeps {
  mcp: Mcp;
  /** The app the tools call into. It is made after this module, so it is read when a request comes. */
  app: () => FetchApp;
  sessions: SessionsService;
  requireRole: (workspaceId: string, userId: string, needed: Role) => Promise<Role>;
  trustProxy?: boolean;
  now: () => Date;
}

/** POST only: the transport is stateless, so there is no stream to open with GET and no session to end with DELETE. */
const notAllowed = (c: Context<Env>) =>
  c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }, 405, { Allow: "POST" });

export function mcpRoutes({ mcp, app: target, trustProxy = false }: McpDeps) {
  const app = new Hono<Env>();

  app.post("/", async (c) => {
    const key = c.get("apiKey");
    if (!key)
      return error(c, 401, "authentication_error", "MCP needs a secret API key: send Authorization: Bearer ksk_…");
    const workspaceId = c.get("workspaceId");
    const settings = await mcp.settings(workspaceId);
    if (!settings.enabled)
      return error(c, 403, "mcp_disabled", "MCP is off for this workspace. An admin can turn it on in Settings › MCP.");
    const server = await mcp.server(
      {
        workspaceId,
        environmentId: c.get("environmentId"),
        actor: `mcp:${key.name}`,
        run: (request) => callRoute(target(), c, request, trustProxy),
      },
      settings,
    );
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      await server.close();
    }
  });
  app.get("/", notAllowed);
  app.delete("/", notAllowed);

  return app;
}

export function mcpAdminRoutes({ mcp, sessions, requireRole, now }: McpDeps) {
  const app = new Hono<Env>();
  app.use("/workspaces/:workspace/mcp", requireSession(sessions, now));

  const access = async (c: Context<Env>, needed: Role) => {
    const workspace = c.req.param("workspace")!;
    await requireRole(workspace, c.get("user").id, needed);
    return workspace;
  };

  app.get("/workspaces/:workspace/mcp", async (c) => c.json(await mcp.settingsView(await access(c, "member"))));

  app.put("/workspaces/:workspace/mcp", async (c) => {
    const workspace = await access(c, "admin");
    const body = await parse(c, settingsBody);
    if ("response" in body) return body.response;
    const settings = await mcp.saveSettings(workspace, body.data);
    await c.var.logActivity({
      environmentId: null,
      action: "mcp.settings_updated",
      resource: { type: "workspace", id: workspace },
      details: body.data,
    });
    return c.json(settings);
  });

  return app;
}
