import { Hono, type Context } from "hono";
import { parse, type Env } from "../../platform/http";
import { requireSession } from "../../platform/auth";
import { dataRetentionBody, deleteWorkspaceBody, inviteBody, keyBody, memberBody, workspaceBody } from "./schema";
import type { SessionsService } from "../../services/session.service";
import type { Tenancy } from "./service";
import type { Role } from "../../types";

export function workspaceRoutes({
  sessions,
  tenancy,
  now,
}: {
  sessions: SessionsService;
  tenancy: Tenancy;
  now: () => Date;
}) {
  const app = new Hono<Env>();
  app.use("*", requireSession(sessions, now));

  const access = async (c: Context<Env>, needed: Role) => {
    const workspace = c.req.param("workspace")!;
    return { workspace, role: await tenancy.requireRole(workspace, c.get("user").id, needed) };
  };

  app.post("/workspaces", async (c) => {
    const input = await parse(c, workspaceBody);
    if ("response" in input) return input.response;
    const workspace = await tenancy.createWorkspace(input.data.name, c.get("user").id);
    await c.var.logActivity({
      workspaceId: workspace.id,
      environmentId: null,
      action: "workspace.created",
      resource: { type: "workspace", id: workspace.id },
      details: { name: workspace.name },
    });
    return c.json(workspace);
  });

  app.patch("/workspaces/:workspace", async (c) => {
    const a = await access(c, "admin");
    const input = await parse(c, workspaceBody);
    if ("response" in input) return input.response;
    const workspace = await tenancy.renameWorkspace(a.workspace, input.data.name);
    await c.var.logActivity({
      environmentId: null,
      action: "workspace.renamed",
      resource: { type: "workspace", id: a.workspace },
      details: { name: input.data.name },
    });
    return c.json(workspace);
  });

  // How long the workspace keeps its history (every environment). Members read it; admins change it.
  app.get("/workspaces/:workspace/data-retention", async (c) => {
    const a = await access(c, "member");
    return c.json(await tenancy.dataRetention(a.workspace));
  });

  app.put("/workspaces/:workspace/data-retention", async (c) => {
    const a = await access(c, "admin");
    const input = await parse(c, dataRetentionBody);
    if ("response" in input) return input.response;
    return c.json(await tenancy.setDataRetention(a.workspace, input.data.retention_days));
  });

  app.get("/workspaces/:workspace/media-hosts", async (c) => {
    const a = await access(c, "member");
    return c.json(await tenancy.mediaHosts(a.workspace));
  });

  app.put("/workspaces/:workspace/media-hosts", async (c) => {
    const a = await access(c, "admin");
    const body = (await c.req.json().catch(() => null)) as { hosts?: unknown } | null;
    const saved = await tenancy.setMediaHosts(a.workspace, body?.hosts);
    await c.var.logActivity({
      environmentId: null,
      action: "workspace.media_hosts_updated",
      resource: { type: "workspace", id: a.workspace },
      details: { hosts: saved.hosts },
    });
    return c.json(saved);
  });

  app.delete("/workspaces/:workspace", async (c) => {
    const a = await access(c, "owner");
    const input = await parse(c, deleteWorkspaceBody);
    if ("response" in input) return input.response;
    await tenancy.deleteWorkspace(a.workspace, input.data.confirm);
    return c.json({ ok: true });
  });

  app.get("/workspaces/:workspace/members", async (c) => {
    const a = await access(c, "member");
    return c.json(await tenancy.members(a.workspace, a.role));
  });

  app.patch("/workspaces/:workspace/members/:user", async (c) => {
    const a = await access(c, "admin");
    const input = await parse(c, memberBody);
    if ("response" in input) return input.response;
    const members = await tenancy.setRole(a.workspace, a.role, c.req.param("user"), input.data.role);
    await c.var.logActivity({
      environmentId: null,
      action: "member.role_changed",
      resource: { type: "member", id: c.req.param("user") },
      details: { role: input.data.role },
    });
    return c.json({ members });
  });

  app.delete("/workspaces/:workspace/members/:user", async (c) => {
    const a = await access(c, tenancy.removalNeeds(c.get("user").id, c.req.param("user")));
    await tenancy.removeMember(a.workspace, a.role, c.req.param("user"));
    await c.var.logActivity({
      environmentId: null,
      action: c.req.param("user") === c.get("user").id ? "member.left" : "member.removed",
      resource: { type: "member", id: c.req.param("user") },
    });
    return c.json({ ok: true });
  });

  app.post("/workspaces/:workspace/invites", async (c) => {
    const a = await access(c, "admin");
    const input = await parse(c, inviteBody);
    if ("response" in input) return input.response;
    const { invite, token } = await tenancy.invite(
      a.workspace,
      a.role,
      c.get("user").id,
      input.data.email,
      input.data.role,
    );
    await c.var.logActivity({
      environmentId: null,
      action: "invite.created",
      resource: { type: "invite", id: invite.id },
      details: { email: invite.email, role: invite.role },
    });
    return c.json({ invite, token });
  });

  app.delete("/workspaces/:workspace/invites/:invite", async (c) => {
    const a = await access(c, "admin");
    await tenancy.revokeInvite(a.workspace, c.req.param("invite"));
    await c.var.logActivity({
      environmentId: null,
      action: "invite.revoked",
      resource: { type: "invite", id: c.req.param("invite") },
    });
    return c.json({ ok: true });
  });

  app.get("/workspaces/:workspace/keys", async (c) => {
    const a = await access(c, "admin");
    return c.json({ keys: await tenancy.keys(a.workspace, c.req.header("x-kairos-environment")) });
  });

  app.post("/workspaces/:workspace/keys", async (c) => {
    const a = await access(c, "admin");
    const input = await parse(c, keyBody);
    if ("response" in input) return input.response;
    const { key, secret } = await tenancy.createKey(a.workspace, c.get("user").id, {
      ...input.data,
      environment_id: input.data.environment_id ?? c.req.header("x-kairos-environment"),
    });
    await c.var.logActivity({
      environmentId: key.environment_id,
      action: "api_key.created",
      resource: { type: "api_key", id: key.id },
      details: { name: key.name, kind: key.kind, allowed_ips: key.allowed_ips, allowed_origins: key.allowed_origins },
    });
    // The only time the key itself is returned.
    return c.json({ key, secret });
  });

  app.delete("/workspaces/:workspace/keys/:key", async (c) => {
    const a = await access(c, "admin");
    const keys = await tenancy.revokeKey(a.workspace, c.req.header("x-kairos-environment"), c.req.param("key"));
    const revoked = keys.find((k) => k.id === c.req.param("key") && k.revoked);
    if (revoked)
      await c.var.logActivity({
        environmentId: revoked.environment_id,
        action: "api_key.revoked",
        resource: { type: "api_key", id: revoked.id },
        details: { name: revoked.name },
      });
    return c.json({ keys });
  });

  return app;
}
