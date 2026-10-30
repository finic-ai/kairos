import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { createRepositories, environmentsRepository, tenancyRepository } from "../src/repositories";
import { ActivitiesService } from "../src/services/activity.service";
import { testDatabase } from "./helpers/database";

const database = await testDatabase();
const NOW = new Date("2026-10-10T12:00:00Z");

const app = createApp({
  repos: createRepositories(database.db),
  accounts: tenancyRepository(database.db),
  environments: environmentsRepository(database.db),
  decider: async () => ({
    id: "d",
    model: "grayson-1",
    answers: { hold: { type: "noul", value: false, probability: 0.1 } },
    usage: { input_tokens: 1 },
  }),
  now: () => NOW,
  trustProxy: true,
});

let cookie = "";
let workspace = "";
let userId = "";

const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const response = await app.request(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "kairos-test",
      "X-Forwarded-For": "203.0.113.7",
      ...(cookie ? { Cookie: cookie } : {}),
      ...(path.startsWith("/v1") ? { "X-Kairos-Workspace": workspace } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as any, response };
};

const activities = () => new ActivitiesService(database.db, { workspaceId: workspace }).list({ limit: 100 });
const actions = async () => (await activities()).map((a) => a.action).reverse();

beforeEach(async () => {
  await database.reset();
  cookie = "";
  const signup = await call("POST", "/auth/signup", {
    email: "owner@example.com",
    password: "correct horse",
    name: "O",
  });
  cookie = (signup.response.headers.get("set-cookie") ?? "").split(";")[0]!;
  workspace = signup.body.workspaces[0].id;
  userId = signup.body.user.id;
});

describe("activities", () => {
  it("records a person's change, with who, where and from what address", async () => {
    const ws = `/app/workspaces/${workspace}`;
    const { body } = await call("POST", `${ws}/keys`, { name: "server", kind: "secret" });
    const [created] = await activities();
    expect(created).toMatchObject({
      workspaceId: workspace,
      environmentId: body.key.environment_id,
      source: "dashboard",
      userId,
      apiKeyId: null,
      action: "api_key.created",
      resourceType: "api_key",
      resourceId: body.key.id,
      details: { name: "server", kind: "secret" },
      ip: "203.0.113.7",
      userAgent: "kairos-test",
      created: NOW,
    });
    expect(created!.id).toMatch(/^actv_/);

    await call("DELETE", `${ws}/keys/${body.key.id}`);
    expect(await actions()).toEqual(["api_key.created", "api_key.revoked"]);
  });

  it("tells a new action and workflow from a changed one", async () => {
    const action = { subject: "user", hold: "Should this payout be held?", trigger: { event: "payout" } };
    await call("PUT", "/v1/actions/payout", action);
    await call("PUT", "/v1/actions/payout", { ...action, hold: "Hold this payout?" });
    const workflow = {
      trigger: { type: "manual" },
      steps: [{ id: "wait", name: "Wait an hour", type: "delay", for: "1h" }],
    };
    await call("PUT", "/v1/workflows/payout_check", workflow);
    await call("PATCH", "/v1/workflows/payout_check", { enabled: false });
    await call("POST", "/v1/workflows/payout_check/archive");

    expect(await actions()).toEqual([
      "action.created",
      "action.updated",
      "workflow.created",
      "workflow.updated",
      "workflow.archived",
    ]);
    const [archived] = await activities();
    expect(archived).toMatchObject({ resourceType: "workflow", details: { name: "payout_check", version: 1 } });
  });

  it("has no environment for a change to the workspace itself", async () => {
    await call("POST", `/app/workspaces/${workspace}/invites`, { email: "member@example.com" });
    const [invite] = await activities();
    expect(invite).toMatchObject({ action: "invite.created", environmentId: null, details: { role: "member" } });
  });

  it("records nothing for a read, a failed change, or an API key", async () => {
    await call("GET", "/v1/actions");
    expect((await call("POST", "/v1/workflows/nothing/publish")).status).toBe(404);
    const { body } = await call("POST", `/app/workspaces/${workspace}/keys`, { name: "server", kind: "secret" });
    const before = await actions();

    const viaKey = await call(
      "PUT",
      "/v1/actions/payout",
      { subject: "user", hold: "Hold?", trigger: { event: "payout" } },
      { Authorization: `Bearer ${body.secret}`, Cookie: "" },
    );
    expect(viaKey.status).toBe(200);
    expect(await actions()).toEqual(before);
    expect(before).toEqual(["api_key.created"]);
  });

  describe("the list", () => {
    let owner = "";
    let member = { cookie: "", id: "" };
    const list = async (query: Record<string, string> = {}, as = owner) => {
      cookie = as;
      const { status, body } = await call(
        "GET",
        `/app/workspaces/${workspace}/activities?${new URLSearchParams(query)}`,
      );
      cookie = owner;
      expect(status).toBe(200);
      return body as { activities: any[]; next: string | null };
    };
    const action = { subject: "user", hold: "Hold?", trigger: { event: "payout" } };

    beforeEach(async () => {
      owner = cookie;
      const invite = await call("POST", `/app/workspaces/${workspace}/invites`, { email: "member@example.com" });
      cookie = "";
      const signup = await call("POST", "/auth/signup", {
        email: "member@example.com",
        password: "correct horse",
        name: "Mia Member",
        invite: invite.body.token,
      });
      member = { cookie: (signup.response.headers.get("set-cookie") ?? "").split(";")[0]!, id: signup.body.user.id };
      cookie = member.cookie;
      await call("PUT", "/v1/actions/payout", action);
      cookie = owner;
      expect((await call("PUT", "/v1/actions/refund", { ...action, trigger: { event: "refund" } })).status).toBe(200);
    });

    it("shows a member only their own activity, whoever they ask for", async () => {
      const mine = await list({}, member.cookie);
      expect(mine.activities.map((a) => [a.action, a.user.name])).toEqual([
        ["action.created", "Mia Member"],
        ["member.joined", "Mia Member"],
      ]);
      expect(await list({ user: userId }, member.cookie)).toEqual(mine);
    });

    it("shows an admin everyone's, and one person's when asked", async () => {
      const all = await list();
      expect(all.activities.map((a) => a.action)).toEqual([
        "action.created",
        "action.created",
        "member.joined",
        "invite.created",
      ]);
      expect(all.activities[0]).toMatchObject({
        resource_type: "action",
        resource_id: "refund",
        user: { id: userId, name: "O", email: "owner@example.com" },
      });
      const theirs = await list({ user: member.id });
      expect(theirs.activities.map((a) => a.resource_id)).toEqual(["payout", member.id]);
    });

    it("filters by resource, by words, and by day, a page at a time", async () => {
      expect((await list({ resource: "invite" })).activities.map((a) => a.action)).toEqual(["invite.created"]);
      // The words of the action, a resource id, and the person's name.
      expect((await list({ q: "action created" })).activities).toHaveLength(2);
      expect((await list({ q: "refund" })).activities.map((a) => a.resource_id)).toEqual(["refund"]);
      expect((await list({ q: "mia" })).activities.map((a) => a.action)).toEqual(["action.created", "member.joined"]);
      expect((await list({ from: "2026-10-10", to: "2026-10-10" })).activities).toHaveLength(4);
      expect((await list({ from: "2026-10-11" })).activities).toHaveLength(0);
      expect((await list({ to: "2026-10-09" })).activities).toHaveLength(0);

      const first = await list({ limit: "3" });
      expect(first.next).toBe(first.activities[2].id);
      const second = await list({ limit: "3", after: first.next! });
      expect(second).toEqual({ activities: [expect.objectContaining({ action: "invite.created" })], next: null });
    });

    it("is only for the members of the workspace", async () => {
      cookie = "";
      const stranger = await call("POST", "/auth/signup", {
        email: "stranger@example.com",
        password: "correct horse",
        name: "S",
      });
      cookie = (stranger.response.headers.get("set-cookie") ?? "").split(";")[0]!;
      expect((await call("GET", `/app/workspaces/${workspace}/activities`)).status).toBe(404);
      cookie = "";
      expect((await call("GET", `/app/workspaces/${workspace}/activities`)).status).toBe(401);
    });
  });

  it("keeps the history of a person who deletes their account", async () => {
    await call("PUT", "/v1/actions/payout", { subject: "user", hold: "Hold?", trigger: { event: "payout" } });
    const invite = await call("POST", `/app/workspaces/${workspace}/invites`, { email: "member@example.com" });
    const owner = cookie;
    cookie = "";
    const member = await call("POST", "/auth/signup", {
      email: "member@example.com",
      password: "correct horse",
      name: "M",
      invite: invite.body.token,
    });
    cookie = (member.response.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect((await call("DELETE", "/auth/me", { password: "correct horse" })).status).toBe(200);
    cookie = owner;

    expect(await actions()).toEqual(["action.created", "invite.created", "member.joined"]);
    const [joined] = await activities();
    expect(joined).toMatchObject({ userId: member.body.user.id, resourceId: member.body.user.id });
  });
});
