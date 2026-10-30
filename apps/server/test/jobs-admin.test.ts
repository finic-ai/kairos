import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { memberships } from "../src/db/schema";
import { createRepositories, environmentsRepository, tenancyRepository } from "../src/repositories";
import { JobsService } from "../src/services/job.service";
import { testDatabase } from "./helpers/database";

const database = await testDatabase();
const NOW = new Date("2026-10-26T12:00:00Z");
const app = createApp({
  repos: createRepositories(database.db),
  environments: environmentsRepository(database.db),
  accounts: tenancyRepository(database.db),
  decider: async () => {
    throw new Error("no decisions here");
  },
  now: () => NOW,
});
const store = new JobsService(database.db);

let cookie: string;
let workspace: string;
let production: string;
let sandbox: string;

async function signup(email: string) {
  const response = await app.request("/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "correct horse", name: "Test" }),
  });
  const data = (await response.json()) as any;
  const ws = data.workspaces[0];
  return {
    cookie: (response.headers.get("set-cookie") ?? "").split(";")[0]!,
    workspace: ws.id as string,
    user: data.user.id as string,
    environments: ws.environments as { id: string; kind: string }[],
  };
}

const call = async (method: string, path: string, { as = cookie, environment = production } = {}) => {
  const response = await app.request(`/app/workspaces/${workspace}${path}`, {
    method,
    headers: { Cookie: as, "X-Kairos-Environment": environment },
  });
  return { status: response.status, body: (await response.json()) as any };
};

async function job(key: string, status: "pending" | "dead" | "done", environmentId = production) {
  await store.enqueue(
    { kind: "webhook.deliver", key, payload: { delivery_id: key }, workspaceId: workspace, environmentId },
    NOW,
  );
  const found = (await store.findByKey("webhook.deliver", key))!;
  if (status === "dead") await store.fail(found.id, "connect ECONNREFUSED", NOW);
  if (status === "done") await store.complete(found.id, NOW);
  return found.id;
}

beforeEach(async () => {
  await database.reset();
  const owner = await signup("owner@example.com");
  ({ cookie, workspace } = owner);
  production = owner.environments.find((e) => e.kind === "production")!.id;
  const made = await app.request(`/app/workspaces/${workspace}/environments`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Staging" }),
  });
  sandbox = ((await made.json()) as any).id;
});

describe("the jobs of an environment", () => {
  it("lists them newest first, with filters and counts, and hides other environments and global jobs", async () => {
    await job("a", "pending");
    await job("b", "dead");
    await job("c", "done");
    await job("s", "dead", sandbox);
    await store.enqueue({ kind: "cleanup", key: "period:1", payload: {} }, NOW);

    const all = await call("GET", "/jobs");
    expect(all.status).toBe(200);
    expect(all.body.jobs.map((j: any) => j.key).sort()).toEqual(["a", "b", "c"]);
    expect(all.body.jobs[0].payload).toBeUndefined();
    const dead = await call("GET", "/jobs?status=dead");
    expect(dead.body.jobs).toMatchObject([{ key: "b", status: "dead", last_error: "connect ECONNREFUSED" }]);
    expect((await call("GET", "/jobs?kind=cleanup")).body.jobs).toEqual([]);
    expect((await call("GET", "/jobs?status=broken")).status).toBe(400);
    expect((await call("GET", "/jobs?limit=2")).body.next_offset).toBe(2);

    const summary = (await call("GET", "/jobs/summary")).body;
    expect(summary.statuses).toEqual({ pending: 1, paused: 0, done: 1, dead: 1 });
    expect(summary.kinds).toEqual([{ kind: "webhook.deliver", pending: 1, paused: 0, done: 1, dead: 1 }]);
  });

  it("shows one job with its payload, and runs a dead one again from no attempts", async () => {
    const dead = await job("b", "dead");
    const pending = await job("a", "pending");
    expect((await call("GET", `/jobs/${dead}`)).body).toMatchObject({ payload: { delivery_id: "b" }, status: "dead" });

    const retried = await call("POST", `/jobs/${dead}/retry`);
    expect(retried.body).toMatchObject({ status: "pending", attempts: 0, last_error: null, finished: null });
    expect(retried.body.run_at).toBe(NOW.toISOString());
    expect((await call("POST", `/jobs/${pending}/retry`)).status).toBe(409);
    expect((await call("POST", "/jobs/job_nothing/retry")).status).toBe(404);
    if (sandbox !== production) expect((await call("GET", `/jobs/${dead}`, { environment: sandbox })).status).toBe(404);
  });

  it("needs the admin role", async () => {
    const other = await signup("member@example.com");
    expect((await call("GET", "/jobs", { as: other.cookie })).status).toBe(404);
    await database.db.insert(memberships).values({
      id: `mem_${other.user}`,
      workspaceId: workspace,
      userId: other.user,
      role: "member",
      created: NOW,
      updated: NOW,
    });
    expect((await call("GET", "/jobs", { as: other.cookie })).status).toBe(403);
  });
});
