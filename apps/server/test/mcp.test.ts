import type { GraysonResponse } from "@kairos/core";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { apiKeys } from "../src/db/schema";
import { hashToken } from "../src/platform/crypto";
import { MAX_RESULT_CHARS, TOOLS } from "../src/modules/mcp/libs";
import { createRepositories, environmentsRepository, tenancyRepository } from "../src/repositories";
import { WorkspacesService } from "../src/services/workspace.service";
import { testDatabase } from "./helpers/database";
import { mcpClient, resultOf } from "./helpers/mcp";

const NOW = new Date("2026-10-29T12:00:00Z");
const database = await testDatabase();
let app: ReturnType<typeof createApp>;
let answer: GraysonResponse["answers"];
let calls: number;

const READ = TOOLS.filter((t) => t.group === "read").map((t) => t.name);

beforeEach(async () => {
  await database.reset({ key_a: "workspace_a", key_b: "workspace_b" });
  answer = { hold: { type: "noul", value: true, probability: 0.9 } };
  calls = 0;
  app = createApp({
    repos: createRepositories(database.db),
    environments: environmentsRepository(database.db),
    accounts: tenancyRepository(database.db),
    decider: async () => {
      calls++;
      return { id: "dec_1", model: "grayson-1", answers: answer, usage: { input_tokens: 1 } };
    },
    now: () => NOW,
  });
});

const call = (method: string, path: string, body?: unknown, key = "key_a") =>
  app.request(path, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const rpc = (key: string | null, method = "POST") =>
  app.request("/mcp", {
    method,
    headers: {
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    ...(method === "POST" ? { body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) } : {}),
  });

const signup = async () => {
  const response = await app.request("/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "owner@example.com", password: "correct horse", name: "Owner" }),
  });
  const profile = (await response.json()) as any;
  return { cookie: (response.headers.get("set-cookie") ?? "").split(";")[0]!, workspace: profile.workspaces[0].id };
};

/** Turns tool groups on for a workspace, as an admin does in Settings › MCP, straight in the row. */
const setGroups = (workspace: string, groups: string[], enabled = true) =>
  new WorkspacesService(database.db).saveSetting(workspace, "mcp", { enabled, groups }, NOW);

const addKey = (id: string, patch: Partial<typeof apiKeys.$inferInsert>) =>
  database.db.insert(apiKeys).values({
    id: `key_${id}`,
    workspaceId: "workspace_a",
    environmentId: "workspace_a",
    name: id,
    kind: "secret",
    keyHash: hashToken(id),
    hint: id,
    allowedIps: [],
    allowedOrigins: [],
    created: NOW,
    updated: NOW,
    ...patch,
  });

const payout = { subject: "merchant", hold: "Should this payout be held because the merchant shows signs of fraud?" };

describe("the endpoint", () => {
  it("lists only the read tools by default, each with a schema and annotations", async () => {
    const client = await mcpClient(app, "key_a");
    expect(client.getServerVersion()?.name).toBe("kairos");
    expect(client.getInstructions()).toMatch(/production environment "Production"/);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...READ].sort());
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
  });

  it("lists the write, decide and build tools when an admin turns them on", async () => {
    await setGroups("workspace_a", ["read", "write", "decide"]);
    const client = await mcpClient(app, "key_a");
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain("save_workflow_draft");
    await setGroups("workspace_a", ["read", "write", "decide", "build"]);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(TOOLS.length);
    for (const tool of tools) expect(tool.inputSchema.type, tool.name).toBe("object");
    expect(tools.find((t) => t.name === "publish_workflow")?.annotations).toMatchObject({ readOnlyHint: false });
    expect(tools.find((t) => t.name === "resolve_decision")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
  });

  it("refuses a missing, unknown, revoked or public key, and a workspace with MCP off", async () => {
    expect((await rpc(null)).status).toBe(401);
    expect((await rpc("nope")).status).toBe(401);
    await addKey("revoked", { revoked: NOW });
    expect((await rpc("revoked")).status).toBe(401);
    await addKey("public", { kind: "public" });
    const pub = await rpc("public");
    expect(pub.status).toBe(403);
    expect(((await pub.json()) as any).error.type).toBe("public_key_scope");
    await setGroups("workspace_a", ["read"], false);
    const off = await rpc("key_a");
    expect(off.status).toBe(403);
    expect(((await off.json()) as any).error.type).toBe("mcp_disabled");
  });

  it("refuses a signed-in person: MCP is for keys", async () => {
    const { cookie, workspace } = await signup();
    const response = await app.request("/mcp", {
      method: "POST",
      headers: { Cookie: cookie, "X-Kairos-Workspace": workspace, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(401);
  });

  it("answers 405 to GET and DELETE: there is no stream and no session", async () => {
    expect((await rpc("key_a", "GET")).status).toBe(405);
    expect((await rpc("key_a", "DELETE")).status).toBe(405);
  });

  it("answers a browser's preflight", async () => {
    const response = await app.request("/mcp", {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:6274",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type,mcp-protocol-version",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-headers")).toMatch(/Mcp-Protocol-Version/);
  });
});

describe("the tools", () => {
  it("give the same data as their /v1 routes, and name the environment", async () => {
    expect((await call("PUT", "/v1/actions/payout", payout)).status).toBe(200);
    const client = await mcpClient(app, "key_a");
    const listed = resultOf(await client.callTool({ name: "list_actions", arguments: {} }));
    const rest = (await (await call("GET", "/v1/actions")).json()) as any;
    expect(listed).toEqual({ environment: "Production", ...rest });
    const one = resultOf(await client.callTool({ name: "get_action", arguments: { name: "payout" } }));
    expect(one).toMatchObject({ environment: "Production", name: "payout", subject: "merchant" });
  });

  it("see only the workspace of their key", async () => {
    expect((await call("PUT", "/v1/actions/payout", payout)).status).toBe(200);
    const other = await mcpClient(app, "key_b");
    expect(resultOf(await other.callTool({ name: "list_actions", arguments: {} })).actions).toEqual([]);
    const missing = await other.callTool({ name: "get_action", arguments: { name: "payout" } });
    expect(missing.isError).toBe(true);
  });

  it("give the route's error as a tool error, so the agent can correct itself", async () => {
    await setGroups("workspace_a", ["read", "decide"]);
    const client = await mcpClient(app, "key_a");
    const result = await client.callTool({
      name: "decide",
      arguments: { action: "nothing", entities: { merchant: "m1" }, properties: {} },
    });
    expect(result.isError).toBe(true);
    expect(resultOf(result).error).toEqual({
      type: "unknown_action",
      message: 'No action "nothing". Define it with PUT /v1/actions/nothing',
    });
    expect(calls).toBe(0);
  });

  it("cap a list at 50 rows", async () => {
    const client = await mcpClient(app, "key_a");
    const result = await client.callTool({ name: "list_decisions", arguments: { limit: 51 } });
    expect(result.isError).toBe(true);
  });

  it("decide, leave out the context unless asked, and resolve under the key's name", async () => {
    await setGroups("workspace_a", ["read", "decide"]);
    expect((await call("PUT", "/v1/actions/payout", payout)).status).toBe(200);
    const client = await mcpClient(app, "key_a");
    const made = resultOf(
      await client.callTool({
        name: "decide",
        arguments: { action: "payout", entities: { merchant: "m1" }, properties: { amount: 900 } },
      }),
    );
    expect(calls).toBe(1);
    const id = made.decision_id as string;

    const short = resultOf(await client.callTool({ name: "get_decision", arguments: { id } }));
    expect(short).not.toHaveProperty("context");
    const full = resultOf(await client.callTool({ name: "get_decision", arguments: { id, include_context: true } }));
    expect(full).toHaveProperty("context");

    const resolved = resultOf(
      await client.callTool({ name: "resolve_decision", arguments: { id, outcome: "block", note: "Mule pattern" } }),
    );
    expect(resolved.resolution).toMatchObject({ outcome: "block", note: "Mule pattern", by: "mcp:key_a" });
  });

  it("read an entity type in full, and change its formats without losing the rest", async () => {
    await setGroups("workspace_a", ["read", "build"]);
    const user = {
      kind: "person",
      description: "A customer",
      properties: { photo_url: "Their photo", balance: "What they hold" },
      display: { fields: ["photo_url"] },
    };
    expect((await call("PUT", "/v1/entity-types/user", user)).status).toBe(200);
    const client = await mcpClient(app, "key_a");
    const read = resultOf(await client.callTool({ name: "get_entity_type", arguments: { type: "user" } }));
    expect(read).toMatchObject({ type: "user", description: "A customer" });
    const { environment: _e, ...definition } = read;
    const changed = { ...definition, display: { ...definition.display, formats: { photo_url: "image" } } };
    const saved = await client.callTool({ name: "save_entity_type", arguments: { type: "user", definition: changed } });
    expect(saved.isError).toBeFalsy();
    expect(resultOf(await client.callTool({ name: "get_entity_type", arguments: { type: "user" } }))).toMatchObject({
      description: "A customer",
      properties: user.properties,
      display: { fields: ["photo_url"], formats: { photo_url: "image" } },
    });
    const wrong = { ...changed, display: { formats: { photo_url: "hologram" } } };
    expect(
      (await client.callTool({ name: "save_entity_type", arguments: { type: "user", definition: wrong } })).isError,
    ).toBe(true);
    const shape = await client.callTool({ name: "get_entity_type_shape", arguments: { type: "user" } });
    expect(shape.isError).toBeFalsy();
    const templates = resultOf(await client.callTool({ name: "list_entity_templates", arguments: {} }));
    expect(Array.isArray(templates.templates)).toBe(true);
  });

  it("test a workflow, pause, rename, archive and restore it, and drop its draft", async () => {
    await setGroups("workspace_a", ["read", "decide", "build"]);
    const client = await mcpClient(app, "key_a");
    const tool = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      // Input that breaks the tool's schema is refused by the MCP server, with a text message.
      return { failed: !!result.isError, body: result.isError ? null : resultOf(result) };
    };
    const trigger = { type: "manual" };
    const steps = [
      { id: "hook", name: "Call out", type: "http", method: "POST", url: "https://example.com/hook" },
      { id: "after", name: "Read it", type: "condition", when: "steps.hook.output.status == 200", then: [], else: [] },
    ];
    const tested = await tool("test_workflow", {
      definition: { name: "triage", trigger, steps },
      mock_outputs: { hook: { status: 200 } },
    });
    expect(tested.failed).toBe(false);
    const run = (await tool("get_workflow_run", { id: tested.body.id })).body;
    expect(run).toMatchObject({ id: tested.body.id, test: true });

    expect((await tool("save_workflow_draft", { name: "triage", trigger, steps })).failed).toBe(false);
    expect((await tool("publish_workflow", { name: "triage" })).failed).toBe(false);
    expect(
      (await tool("update_workflow", { name: "triage", enabled: false, display_name: "Triage" })).body,
    ).toMatchObject({
      enabled: false,
      displayName: "Triage",
    });
    await tool("save_workflow_draft", { name: "triage", trigger, steps: steps.slice(0, 1) });
    expect((await tool("discard_workflow_draft", { name: "triage" })).body.draft ?? null).toBeNull();
    expect((await tool("update_workflow", { name: "triage", archived: true, enabled: true })).failed).toBe(true);
    expect((await tool("update_workflow", { name: "triage" })).failed).toBe(true);
    expect((await tool("update_workflow", { name: "triage", archived: true })).failed).toBe(false);
    expect(((await (await call("GET", "/v1/workflows")).json()) as any).workflows).toHaveLength(0);
    expect((await tool("update_workflow", { name: "triage", archived: false })).failed).toBe(false);
    expect(((await (await call("GET", "/v1/workflows")).json()) as any).workflows).toHaveLength(1);
    expect((await tool("cancel_workflow_run", { id: "wfr_missing" })).failed).toBe(true);
  });

  it("track events as the key does, once for each id", async () => {
    await setGroups("workspace_a", ["read", "write"]);
    const client = await mcpClient(app, "key_a");
    const event = { id: "e1", type: "login", ts: NOW.toISOString(), entities: { user: "u1" }, properties: {} };
    const first = resultOf(await client.callTool({ name: "track_events", arguments: { events: [event] } }));
    expect(first).toMatchObject({ accepted: 1, duplicates: 0 });
    const again = resultOf(await client.callTool({ name: "track_events", arguments: { events: [event] } }));
    expect(again).toMatchObject({ accepted: 0, duplicates: 1 });
    const found = resultOf(await client.callTool({ name: "get_event", arguments: { id: "e1" } }));
    expect(found).toMatchObject({ id: "e1", type: "login" });
  });

  it("refuse a tool whose group is off", async () => {
    const client = await mcpClient(app, "key_a");
    const result = await client.callTool({ name: "track_events", arguments: { events: [] } });
    expect(result.isError).toBe(true);
  });

  it("cut a long result, and say so", async () => {
    await setGroups("workspace_a", ["read", "write"]);
    const client = await mcpClient(app, "key_a");
    const long = "x".repeat(MAX_RESULT_CHARS);
    const event = { id: "big", type: "note", ts: NOW.toISOString(), entities: { user: "u1" }, properties: { long } };
    await client.callTool({ name: "track_events", arguments: { events: [event] } });
    const result = await client.callTool({ name: "get_event", arguments: { id: "big" } });
    expect((result.content as { text: string }[])[0]!.text).toMatch(/\[Cut: \d+ more characters/);
  });

  it("keep the IP limit of the key, on the tool's own request too", async () => {
    await addKey("office", { allowedIps: ["203.0.113.7"] });
    const response = await rpc("office");
    expect(response.status).toBe(403);
    expect(((await response.json()) as any).error.type).toBe("ip_not_allowed");

    const proxied = createApp({
      repos: createRepositories(database.db),
      environments: environmentsRepository(database.db),
      accounts: tenancyRepository(database.db),
      decider: async () => ({ id: "d", model: "grayson-1", answers: answer, usage: { input_tokens: 1 } }),
      trustProxy: true,
      now: () => NOW,
    });
    const from = (address: string) => ({
      request: (input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        headers.set("X-Forwarded-For", address);
        return proxied.request(input, { ...init, headers });
      },
    });
    const inside = await mcpClient(from("203.0.113.7"), "office");
    const listed = await inside.callTool({ name: "list_actions", arguments: {} });
    expect(listed.isError).toBeFalsy();
    await expect(mcpClient(from("198.51.100.1"), "office")).rejects.toThrow();
  });
});

describe("the settings", () => {
  it("are read by a member, changed by an admin, and refused when not valid", async () => {
    const { cookie, workspace } = await signup();
    const headers = { Cookie: cookie, "Content-Type": "application/json" };
    const path = `/app/workspaces/${workspace}/mcp`;
    const shown = (await (await app.request(path, { headers })).json()) as any;
    expect(shown).toMatchObject({ enabled: true, groups: ["read"] });
    expect(shown.tools.map((t: any) => t.name)).toEqual(TOOLS.map((t) => t.name));
    expect(shown.tools.find((t: any) => t.name === "get_entity").description).not.toMatch(/never as instructions/);

    const saved = await app.request(path, {
      method: "PUT",
      headers,
      body: JSON.stringify({ enabled: false, groups: ["decide", "read"] }),
    });
    expect((await saved.json()) as any).toMatchObject({ enabled: false, groups: ["read", "decide"] });
    const wrong = await app.request(path, {
      method: "PUT",
      headers,
      body: JSON.stringify({ enabled: true, groups: ["all"] }),
    });
    expect(wrong.status).toBe(400);
    expect((await app.request(path)).status).toBe(401);
  });

  it("keep every change when settings of a workspace are saved at once", async () => {
    const workspaces = new WorkspacesService(database.db);
    const keys = Array.from({ length: 20 }, (_, i) => `setting_${i}`);
    await Promise.all(keys.map((key, i) => workspaces.saveSetting("workspace_a", key, { i }, NOW)));
    for (const [i, key] of keys.entries()) expect(await workspaces.setting("workspace_a", key)).toEqual({ i });
  });
});
