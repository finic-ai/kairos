import { randomBytes } from "node:crypto";
import type { Decider } from "@kairos/core";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Webhooks } from "../src/context";
import { webhookDeliveries } from "../src/db/schema";
import { secretBox } from "../src/platform/secrets";
import { tenancyRepository, createRepositories, environmentsRepository } from "../src/repositories";
import { createAutomatic, type AutomaticRunner } from "../src/modules/decisions/libs";
import { createJobs, type Jobs } from "../src/platform/jobs/worker";
import { runDecision } from "../src/modules/decisions/service";
import { ActionsService } from "../src/services/action.service";
import { testDatabase } from "./helpers/database";

const database = await testDatabase();
const NOW = new Date("2026-10-18T12:00:00Z");
const repos = createRepositories(database.db);
const actionsIn = (workspaceId: string, environmentId: string) =>
  new ActionsService(database.db, { workspaceId, environmentId });
const environments = environmentsRepository(database.db);

let clock: Date;
let app: ReturnType<typeof createApp>;
let automatic: AutomaticRunner;
let runner: Jobs;
/** The model is down: each call fails. */
let down: boolean;
/** The process stopped after it stored the events: nothing starts the worker. */
let stopped: boolean;
let hooks: Webhooks;
/** The background work the runner started: a test waits for it, as waitUntil would keep a function alive for it. */
let pending: Promise<unknown>[];
let calls: number;
let cookie: string;
let workspace: string;
let environment: string;

const decider: Decider = async () => {
  calls++;
  if (down) throw new Error("the model is down");
  return {
    id: "d",
    model: "grayson-1",
    answers: { hold: { type: "noul", value: true, probability: 0.7 } },
    usage: { input_tokens: 1 },
  };
};

function build() {
  pending = [];
  hooks = {
    db: database.db,
    secretBox: secretBox(randomBytes(32)),
    allowPrivate: true,
    worker: { wake: () => {} } as never,
  };
  automatic = createAutomatic({
    repos,
    decider,
    now: () => clock,
    webhooks: hooks,
    wake: () => void (stopped || runner.wake()),
  });
  runner = createJobs({
    repo: repos.jobs,
    kinds: [automatic.kind],
    now: () => clock,
    random: () => 0.5,
    defer: (work) => pending.push(work),
    log: () => {},
  });
  app = createApp({
    repos,
    accounts: tenancyRepository(database.db),
    environments,
    decider,
    now: () => clock,
    webhooks: hooks,
    automatic,
  });
}
const settle = async () => {
  while (pending.length) await Promise.all(pending.splice(0));
};

const call = async (
  method: string,
  path: string,
  body?: unknown,
  auth: { key?: string; cookie?: string } = { cookie },
) => {
  const response = await app.request(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(auth.key ? { Authorization: `Bearer ${auth.key}` } : {}),
      ...(auth.cookie
        ? { Cookie: auth.cookie, ...(path.startsWith("/v1") ? { "X-Kairos-Workspace": workspace } : {}) }
        : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as any };
};

let secret: string;
let publicKey: string;

beforeEach(async () => {
  await database.reset();
  clock = NOW;
  calls = 0;
  down = false;
  stopped = false;
  build();
  const signup = await app.request("/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "owner@example.com", password: "correct horse", name: "Owner" }),
  });
  cookie = (signup.headers.get("set-cookie") ?? "").split(";")[0]!;
  const profile = (await signup.json()) as any;
  workspace = profile.workspaces[0].id;
  environment = profile.workspaces[0].environments[0].id;
  secret = (await call("POST", `/app/workspaces/${workspace}/keys`, { name: "server", kind: "secret" })).body.secret;
  publicKey = (await call("POST", `/app/workspaces/${workspace}/keys`, { name: "web", kind: "public" })).body.secret;
  expect(
    (
      await call("PUT", "/v1/actions/payout", {
        subject: "user",
        hold: "Should this payout be held?",
        trigger: { event: "payout", status: "requested" },
        automatic: true,
      })
    ).status,
  ).toBe(200);
});

const payout = (id: string, minutesAgo = 1, extra: Record<string, unknown> = {}) => ({
  id,
  type: "payout",
  ts: new Date(clock.getTime() - minutesAgo * 60_000).toISOString(),
  entities: { user: "u1" },
  properties: { usd: 500 },
  status: "requested",
  ...extra,
});
const track = async (events: unknown[], auth: { key?: string; cookie?: string } = { key: secret }) => {
  const r = await call("POST", "/v1/events", { batch: events }, auth);
  await settle();
  return r;
};
const decisions = async () => (await call("GET", "/v1/decisions")).body.decisions as any[];

describe("the setting", () => {
  it("needs a trigger, and is not a new version", async () => {
    expect(
      (await call("PUT", "/v1/actions/review", { subject: "user", hold: "Hold?", automatic: true })).body.error.message,
    ).toContain("automatic needs a trigger");
    const off = (
      await call("PUT", "/v1/actions/payout", {
        subject: "user",
        hold: "Should this payout be held?",
        trigger: { event: "payout", status: "requested" },
        automatic: false,
      })
    ).body;
    expect(off).toMatchObject({ version: 1 });
    expect(off.automatic).toBeUndefined();
    const on = (
      await call("PUT", "/v1/actions/payout", {
        subject: "user",
        hold: "Should this payout be held?",
        trigger: { event: "payout", status: "requested" },
        automatic: true,
      })
    ).body;
    expect(on).toMatchObject({ version: 1, automatic: true });
  });
});

describe("deciding a tracked event", () => {
  it("decides a matching event from a server, in the background, once", async () => {
    const response = await track([payout("p1")]);
    // The answer is the usual one: it does not wait for the decision.
    expect(response.body).toEqual({ accepted: 1, duplicates: 0 });
    const [d] = await decisions();
    expect(d).toMatchObject({ automatic: true, decision: { decision: "review" }, subject: { type: "user", id: "u1" } });
    const record = (await call("GET", `/v1/decisions/${d.id}`)).body;
    expect(record).toMatchObject({ event_id: "p1", automatic: true, ts: payout("p1").ts });

    await track([payout("p1")]);
    expect(await decisions()).toHaveLength(1);
    expect(calls).toBe(1);
  });

  it("decides an event sent from the console, never one from a public key", async () => {
    await track([payout("from-web")], { key: publicKey });
    expect(await decisions()).toHaveLength(0);
    await track([payout("from-console")], { cookie });
    expect((await decisions()).map((d) => d.subject.id)).toEqual(["u1"]);
  });

  it("decides only current, matching events that name the subject", async () => {
    await track([
      payout("old", 61),
      payout("ahead", -10),
      payout("done", 1, { status: "completed" }),
      payout("nobody", 1, { entities: { device: "d1" } }),
      { ...payout("other"), type: "login" },
    ]);
    expect(await decisions()).toHaveLength(0);
    expect(calls).toBe(0);
  });

  it("does nothing when the action is not automatic", async () => {
    await call("PUT", "/v1/actions/payout", {
      subject: "user",
      hold: "Should this payout be held?",
      trigger: { event: "payout", status: "requested" },
    });
    await track([payout("p1")]);
    expect(await decisions()).toHaveLength(0);
  });

  it("gives /events/decide the decision already made, and makes no second one", async () => {
    await track([payout("p1")]);
    const [first] = await decisions();
    const again = await call("POST", "/v1/events/decide", payout("p1"), { key: secret });
    expect(again.body.decision_id).toBe(first.id);
    expect(calls).toBe(1);
  });

  it("keeps one decision when two paths decide the same event at once", async () => {
    await call("PUT", "/v1/actions/payout", {
      subject: "user",
      hold: "Should this payout be held?",
      trigger: { event: "payout", status: "requested" },
    });
    await track([payout("p1")]);
    const action = (await actionsIn(workspace, environment).findLatest("payout"))!;
    const request = { action, entities: { user: "u1" }, properties: {}, eventId: "p1" };
    const [a, b] = await Promise.all([
      runDecision(repos, decider, workspace, environment, { ...request, automatic: true }, clock, clock),
      runDecision(repos, decider, workspace, environment, request, clock, clock),
    ]);
    expect(a.decision_id).toBe(b.decision_id);
    const rows = (
      await database.db.execute<Record<string, any>>(
        sql`SELECT COUNT(*)::int AS n FROM decisions d JOIN events e ON e.id = d.event_id WHERE e.external_id = 'p1'`,
      )
    ).rows[0];
    expect(rows).toEqual({ n: 1 });
  });

  it("sends decision.created, marked automatic", async () => {
    const created = await call("POST", `/app/workspaces/${workspace}/webhooks`, {
      direction: "out",
      name: "Queue",
      url: "http://127.0.0.1:9/hook",
      events: ["decision.created"],
    });
    expect(created.status).toBe(200);
    await track([payout("p1")]);
    const [delivery] = await database.db.select().from(webhookDeliveries);
    expect((delivery!.payload as any).data).toMatchObject({ automatic: true, event_id: "p1", decision: "review" });
  });
});

describe("a decision that waits", () => {
  const job = (event: string) => repos.jobs.findByKey("decision.automatic", `${environment}:payout:${event}`);
  const later = (ms: number) => (clock = new Date(clock.getTime() + ms));

  it("is tried again when the model is down, and made when it is back", async () => {
    down = true;
    await track([payout("p1")]);
    expect(await decisions()).toHaveLength(0);
    expect(await job("p1")).toMatchObject({ status: "pending", attempts: 1, last_error: "the model is down" });
    down = false;
    expect(await runner.drain()).toBe(0);
    later(30_000);
    expect(await runner.drain()).toBe(1);
    const [d] = await decisions();
    expect(d).toMatchObject({ automatic: true });
    expect((await call("GET", `/v1/decisions/${d.id}`)).body.event_id).toBe("p1");
  });

  it("is made after a stop, by the next worker that runs", async () => {
    stopped = true;
    await track([payout("p1")]);
    expect(await decisions()).toHaveLength(0);
    // The job was written with the event.
    expect(await job("p1")).toMatchObject({ status: "pending", attempts: 0 });
    expect(await runner.drain()).toBe(1);
    expect(await decisions()).toHaveLength(1);
  });

  it("gives up after the last retry, and keeps the error", async () => {
    down = true;
    await track([payout("p1")]);
    for (const wait of [30_000, 2 * 60_000, 10 * 60_000, 3_600_000, 6 * 3_600_000]) {
      later(wait);
      await runner.drain();
    }
    expect(await job("p1")).toMatchObject({ status: "dead", attempts: 6, last_error: "the model is down" });
    expect(calls).toBe(6);
  });

  it("is not made when the action stops being automatic before it runs", async () => {
    stopped = true;
    await track([payout("p1")]);
    await call("PUT", "/v1/actions/payout", {
      subject: "user",
      hold: "Should this payout be held?",
      trigger: { event: "payout", status: "requested" },
    });
    await runner.drain();
    expect(await decisions()).toHaveLength(0);
    expect(await job("p1")).toMatchObject({ status: "done" });
  });
});

describe("the switch", () => {
  /** An event stored with no decision: what the estimate counts as missed. */
  const missed = (id: string, minutesAgo: number, via: "key" | "public" = "key") =>
    repos.events.insertEvents(workspace, environment, [{ ...payout(id, minutesAgo) }], clock.toISOString(), via);

  it("does not decide what came before the switch was turned on", async () => {
    await call("PUT", "/v1/actions/payout", {
      subject: "user",
      hold: "Should this payout be held?",
      trigger: { event: "payout", status: "requested" },
    });
    await track([payout("before", 10)]);
    clock = new Date(clock.getTime() + 60_000);
    const on = (
      await call("PUT", "/v1/actions/payout", {
        subject: "user",
        hold: "Should this payout be held?",
        trigger: { event: "payout", status: "requested" },
        automatic: true,
      })
    ).body;
    expect(on.automaticSince).toBe(clock.toISOString());
    clock = new Date(clock.getTime() + 5 * 60_000);
    expect(await runner.drain()).toBe(0);
    // Sent again with the switch on, an event from before it is still history.
    await track([payout("before-again", 30)]);
    expect(await decisions()).toHaveLength(0);
  });

  it("keeps the moment it was turned on while it stays on, and ignores one that is sent", async () => {
    const first = (await actionsIn(workspace, environment).findLatest("payout"))!.automaticSince;
    clock = new Date(clock.getTime() + 3_600_000);
    const again = (
      await call("PUT", "/v1/actions/payout", {
        subject: "user",
        hold: "Should this payout be held?",
        trigger: { event: "payout", status: "requested" },
        automatic: true,
        automaticSince: "2020-01-01T00:00:00.000Z",
      })
    ).body;
    expect(again.automaticSince).toBe(first);
  });

  it("estimates decisions a day, and counts what was not decided in time since it was on", async () => {
    await call("PUT", "/v1/actions/payout", {
      subject: "user",
      hold: "Should this payout be held?",
      trigger: { event: "payout", status: "requested" },
    });
    await track([
      payout("a", 60 * 24 * 2),
      payout("b", 60 * 3),
      payout("c", 90),
      payout("d", 30, { status: "completed" }),
    ]);
    await track([payout("web", 90)], { key: publicKey });
    expect((await call("GET", "/v1/actions/payout/automatic")).body).toEqual({
      available: true,
      per_day: 0,
      missed_last_day: 0,
      window_minutes: 60,
    });
    await call("PUT", "/v1/actions/payout", {
      subject: "user",
      hold: "Should this payout be held?",
      trigger: { event: "payout", status: "requested" },
      automatic: true,
    });
    // Events from before it was on are not missed: they were never to be decided.
    expect((await call("GET", "/v1/actions/payout/automatic")).body).toEqual({
      available: true,
      per_day: 0,
      missed_last_day: 0,
      window_minutes: 60,
    });
    clock = new Date(clock.getTime() + 2 * 3_600_000);
    await missed("lost", 70);
    expect((await call("GET", "/v1/actions/payout/automatic")).body).toMatchObject({ missed_last_day: 1 });
  });
});

describe("from an inbound webhook", () => {
  it("decides a provider's event that matches an automatic action", async () => {
    const mapping = {
      rules: [{ event: { id: "$.id", type: "payout", status: "requested", ts: "$.at", entities: { user: "$.user" } } }],
    };
    const source = (
      await call("POST", `/app/workspaces/${workspace}/webhooks`, {
        direction: "in",
        name: "Bank",
        verification: { scheme: "none" },
        mapping,
      })
    ).body;
    const response = await app.request(source.path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "bank-1", user: "u1", at: payout("x").ts }),
    });
    expect(response.status).toBe(200);
    await settle();
    const [d] = await decisions();
    expect(d).toMatchObject({ automatic: true });
    expect((await call("GET", `/v1/decisions/${d.id}`)).body.event_id).toBe(`${source.webhook.id}:bank-1`);
  });
});
