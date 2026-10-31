import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { apiKeys } from "../src/db/schema";
import { hashToken } from "../src/platform/crypto";
import { createRepositories, environmentsRepository, tenancyRepository } from "../src/repositories";
import { WorkspacesService } from "../src/services/workspace.service";
import { testDatabase } from "./helpers/database";
import { mcpClient, resultOf } from "./helpers/mcp";

const NOW = new Date("2026-10-31T12:00:00Z");
const database = await testDatabase();
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  await database.reset({ key_a: "workspace_a" });
  app = createApp({
    repos: createRepositories(database.db),
    environments: environmentsRepository(database.db),
    accounts: tenancyRepository(database.db),
    decider: async () => ({ id: "dec_1", model: "grayson-1", answers: {}, usage: { input_tokens: 1 } }),
    now: () => NOW,
  });
});

const signup = async (email = "owner@example.com", invite?: string) => {
  const response = await app.request("/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "correct horse", name: "Person", ...(invite ? { invite } : {}) }),
  });
  const profile = (await response.json()) as any;
  return { cookie: (response.headers.get("set-cookie") ?? "").split(";")[0]!, workspace: profile.workspaces[0].id };
};

const settings = {
  consent: "required",
  defaults: { country: "gb", off: ["address"], sessionCookie: "sid" },
  pages: [{ path: "/checkout", type: "checkout_viewed" }],
  screens: [{ name: "Transfer", type: "transfer_screen_viewed" }],
  routes: [
    {
      route: "post  /login/",
      mode: "decide_response",
      type: "login",
      failed: "login_failed",
      fields: {
        userId: { from: "response.header", path: "x-kairos-user" },
        email: { from: "request.body", path: "$.email", kind: "email" },
        sign_in_method: { value: "password" },
      },
      fallback: "approve",
      timeoutMs: 1500,
      enforce: true,
    },
    { route: "PUT /account/password", mode: "track", type: "password_changed" },
  ],
};

describe("the client settings", () => {
  it("are kept for each environment, with a new version on each save, and are normalized", async () => {
    const { cookie, workspace } = await signup();
    const path = `/app/workspaces/${workspace}/client-settings`;
    const sandbox = (await (
      await app.request(`/app/workspaces/${workspace}/environments`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Staging" }),
      })
    ).json()) as any;
    const headers = (environment?: string) => ({
      Cookie: cookie,
      "Content-Type": "application/json",
      ...(environment ? { "X-Kairos-Environment": environment } : {}),
    });
    const put = async (body: object, environment?: string) =>
      (await (
        await app.request(path, { method: "PUT", headers: headers(environment), body: JSON.stringify(body) })
      ).json()) as any;
    const get = async (environment?: string) =>
      (await (await app.request(path, { headers: headers(environment) })).json()) as any;

    expect(await get()).toEqual({
      version: 0,
      consent: "not_required",
      defaults: { off: [] },
      routing: { mode: "monitor", other: "ignore" },
      pages: [],
      screens: [],
      routes: [],
    });

    const first = await put(settings);
    expect(first.version).toBe(1);
    expect(first.defaults.country).toBe("GB");
    expect(first.routes[0].route).toBe("POST /login");
    expect(first.routes[1]).toMatchObject({ fields: {}, enforce: false });
    expect(first.routing).toEqual({ mode: "monitor", other: "ignore" });
    expect((await put({ ...settings, routing: { mode: "active", other: "discover" } })).routing).toEqual({
      mode: "active",
      other: "discover",
    });
    expect((await put(settings)).version).toBe(3);

    // A sandbox has its own settings and its own versions, and saving them keeps Production's.
    expect((await get(sandbox.id)).version).toBe(0);
    expect((await put({ ...settings, pages: [] }, sandbox.id)).version).toBe(1);
    expect(await get()).toMatchObject({ version: 3, pages: settings.pages });
    expect(await get(sandbox.id)).toMatchObject({ version: 1, pages: [] });

    const removed = await app.request(`/app/workspaces/${workspace}/environments/${sandbox.id}`, {
      method: "DELETE",
      headers: headers(),
      body: JSON.stringify({ confirm: "Staging" }),
    });
    expect(removed.status).toBe(200);
    expect(await new WorkspacesService(database.db).setting(workspace, "clients")).not.toHaveProperty(sandbox.id);
    expect((await app.request(path, { headers: headers(sandbox.id) })).status).toBe(404);
  });

  it("refuse what no client could use", async () => {
    const { cookie, workspace } = await signup();
    const headers = { Cookie: cookie, "Content-Type": "application/json" };
    const path = `/app/workspaces/${workspace}/client-settings`;
    const save = async (patch: object) => {
      const response = await app.request(path, {
        method: "PUT",
        headers,
        body: JSON.stringify({ ...settings, ...patch }),
      });
      return { status: response.status, message: ((await response.json()) as any).error?.message as string };
    };
    const route = settings.routes[0]!;

    expect(await save({ routes: [{ ...route, route: "FETCH /login" }] })).toMatchObject({ status: 400 });
    expect(await save({ routes: [{ ...route, fallback: undefined }] })).toMatchObject({
      status: 400,
      message: /needs a fallback/,
    });
    expect(await save({ routes: [{ route: "PUT /a", mode: "track", type: "a", fallback: "approve" }] })).toMatchObject({
      status: 400,
      message: /only a route that decides/,
    });
    expect(await save({ routes: [route, { ...route, route: "POST /login/" }] })).toMatchObject({
      status: 400,
      message: /twice/,
    });
    expect(
      await save({ routes: [{ ...route, fields: { email: { from: "request.body", path: "$.email", value: "x" } } }] }),
    ).toMatchObject({ status: 400, message: /not both/ });
    expect(await save({ defaults: { country: "GBR" } })).toMatchObject({ status: 400 });
    expect(await save({ pages: [{ path: "checkout", type: "x" }] })).toMatchObject({ status: 400 });
    expect(await save({ sources: "edge" })).toMatchObject({ status: 400 });
    expect(await save({ routing: { mode: "pass_through", other: "ignore" } })).toMatchObject({ status: 400 });
    expect(await save({ routes: [{ route: "PUT /a", mode: "collect", type: "a" }] })).toMatchObject({ status: 400 });
  });

  it("are read and saved with a secret key in the key's environment, and never with a public key", async () => {
    const call = (method: string, key: string, body?: object) =>
      app.request("/v1/client-settings", {
        method,
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    expect(((await (await call("PUT", "key_a", settings)).json()) as any).version).toBe(1);
    expect(await (await call("GET", "key_a")).json()).toMatchObject({ version: 1, pages: settings.pages });
    expect(
      await new WorkspacesService(database.db).environmentSetting("workspace_a", "clients", "workspace_a"),
    ).toMatchObject({ version: 1 });

    await database.db.insert(apiKeys).values({
      id: "key_public",
      workspaceId: "workspace_a",
      environmentId: "workspace_a",
      name: "Website",
      kind: "public",
      keyHash: hashToken("kpk_site"),
      hint: "kpk_site",
      allowedIps: [],
      allowedOrigins: [],
      created: NOW,
      updated: NOW,
    });
    expect((await call("GET", "kpk_site")).status).toBe(403);
    expect((await call("PUT", "kpk_site", settings)).status).toBe(403);
  });

  it("are read and saved through MCP when the build tools are on", async () => {
    await new WorkspacesService(database.db).saveSetting(
      "workspace_a",
      "mcp",
      { enabled: true, groups: ["read", "build"] },
      NOW,
    );
    const client = await mcpClient(app, "key_a");
    const saved = resultOf(
      await client.callTool({ name: "save_client_settings", arguments: { settings: { ...settings, routes: [] } } }),
    );
    expect(saved).toMatchObject({ version: 1, consent: "required", routes: [] });
    expect(resultOf(await client.callTool({ name: "get_client_settings", arguments: {} }))).toEqual(saved);

    const refused = await client.callTool({
      name: "save_client_settings",
      arguments: { settings: { ...settings, routes: [{ route: "POST /pay", mode: "decide_request", type: "pay" }] } },
    });
    expect(refused.isError).toBe(true);
  });

  it("are read by a member and changed only by an admin", async () => {
    const owner = await signup();
    const path = `/app/workspaces/${owner.workspace}/client-settings`;
    const invited = (await (
      await app.request(`/app/workspaces/${owner.workspace}/invites`, {
        method: "POST",
        headers: { Cookie: owner.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ email: "member@example.com", role: "member" }),
      })
    ).json()) as any;
    const member = await signup("member@example.com", invited.token);
    const headers = { Cookie: member.cookie, "Content-Type": "application/json" };

    expect((await app.request(path, { headers })).status).toBe(200);
    expect((await app.request(path, { method: "PUT", headers, body: JSON.stringify(settings) })).status).toBe(403);
    expect((await app.request(path)).status).toBe(401);
  });
});
