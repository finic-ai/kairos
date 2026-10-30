import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { GraysonAnswer, GraysonRequest, GraysonResponse, Question } from "@kairos/core";
import { createApp } from "../src/app";
import { createWorkflowRunner } from "../src/modules/workflows/libs";
import { startScheduledRuns } from "../src/modules/workflows/service";
import { createJobs } from "../src/platform/jobs/worker";
import { createRepositories, environmentsRepository, tenancyRepository } from "../src/repositories";
import { DecisionsService } from "../src/services/decision.service";
import { JobsService } from "../src/services/job.service";
import { testDatabase } from "./helpers/database";

const database = await testDatabase();
const repos = createRepositories(database.db);
let decided = 0;
/** What the model was asked, newest last. */
let asked: GraysonRequest[] = [];
/** Answers each question by its kind: an action's hold question with 0.1, a yes or no with true, the first option, the middle level. */
const decider = async (request: GraysonRequest): Promise<GraysonResponse> => {
  decided++;
  asked.push(request);
  const answer = (key: string, q: Question): GraysonAnswer => {
    if (q.type === "noul") return { type: "noul", value: key !== "hold", probability: key === "hold" ? 0.1 : 0.8 };
    if (q.type === "score") {
      const at = Math.floor(q.levels.length / 2);
      return {
        type: "score",
        value: at,
        level: q.levels[at]!,
        probabilities: q.levels.map((_, i) => (i === at ? 0.6 : 0.2)),
      };
    }
    const first = Object.keys(q.options)[0]!;
    const probabilities = Object.fromEntries(Object.keys(q.options).map((o) => [o, o === first ? 0.7 : 0.1]));
    return q.type === "choice"
      ? { type: "choice", value: first, probabilities }
      : { type: "multi_choice", values: [first], probabilities };
  };
  return {
    id: "dec",
    model: "grayson-1",
    answers: Object.fromEntries(Object.entries(request.questions).map(([k, q]) => [k, answer(k, q)])),
    usage: { input_tokens: 7 },
  };
};
const now = () => new Date();
const app = createApp({
  repos,
  environments: environmentsRepository(database.db),
  accounts: tenancyRepository(database.db),
  decider,
  now,
});
const jobs = createJobs({
  repo: new JobsService(database.db),
  kinds: [createWorkflowRunner({ repos, decider, now, allowPrivate: true })],
  now,
  log: () => {},
});

/** A local service for HTTP steps. `answer` decides each reply; the requests are kept. */
let hits: { url: string; body: string }[] = [];
let answer: (req: IncomingMessage, res: ServerResponse, body: string) => void;
let server: Server;
let base = "";
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ url: req.url ?? "", body });
      answer(req, res, body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(async () => {
  await database.reset({ key_a: "workspace_a", key_b: "workspace_b" });
  hits = [];
  decided = 0;
  asked = [];
  answer = (_req, res) => (res.writeHead(200, { "Content-Type": "application/json" }), res.end('{"ok":true}'));
});

const call = async (method: string, path: string, body?: unknown, key = "key_a") => {
  const response = await app.request(path, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as any };
};
const save = (name: string, steps: unknown[], trigger: unknown = { type: "manual" }) =>
  call("PUT", `/v1/workflows/${name}`, { trigger, steps });
const start = async (name: string, input: unknown = {}) =>
  (await call("POST", `/v1/workflows/${name}/runs`, { input })).body.id as string;
const run = async (id: string) => (await call("GET", `/v1/workflow-runs/${id}`)).body;
const runs = async (name: string) => (await call("GET", `/v1/workflows/${name}/runs`)).body.runs as any[];

describe("the runner", () => {
  it("finishes a run whose segment stopped in the middle", async () => {
    await save("hook", [{ id: "tell", name: "Tell", type: "http", method: "POST", url: `${base}/hook` }]);
    const id = await start("hook");
    // A crash after the claim: the run is running, and its job is due again after the lease.
    await database.db.execute(sql`UPDATE workflow_runs SET status = 'running' WHERE id = ${id}`);
    await jobs.drain();
    expect((await run(id)).status).toBe("done");
    expect(hits).toHaveLength(1);
  });

  it("starts a run that waits for a place when one frees, and test runs do not wait", async () => {
    await save("slow", [{ id: "wait", name: "Wait", type: "delay", for: "1h" }]);
    const ids: string[] = [];
    for (let i = 0; i < 23; i++) ids.push(await start("slow"));
    await jobs.drain();
    const statuses = async () => (await runs("slow")).map((r) => r.status).sort();
    expect((await statuses()).filter((s) => s === "waiting")).toHaveLength(20);
    expect((await statuses()).filter((s) => s === "queued")).toHaveLength(3);

    const test = await call("POST", "/v1/workflows/test", {
      definition: {
        name: "slow",
        trigger: { type: "manual" },
        steps: [{ id: "only", name: "Only", type: "filter", when: "true" }],
      },
    });
    await jobs.drain();
    expect((await run(test.body.id)).status).toBe("done");

    await call("POST", `/v1/workflow-runs/${ids[0]}/cancel`);
    await call("POST", `/v1/workflow-runs/${ids[1]}/cancel`);
    await jobs.drain();
    const after = await statuses();
    expect(after.filter((s) => s === "waiting")).toHaveLength(20);
    expect(after.filter((s) => s === "queued")).toHaveLength(1);
  });

  it("stops a running segment that is cancelled, at its next step", async () => {
    let release = () => {};
    let arrived = () => {};
    const first = new Promise<void>((r) => (arrived = r));
    answer = (req, res) => {
      if (req.url === "/first") {
        arrived();
        release = () => (res.writeHead(200), res.end("{}"));
      } else (res.writeHead(200), res.end("{}"));
    };
    await save("two", [
      { id: "one", name: "One", type: "http", method: "POST", url: `${base}/first` },
      { id: "two", name: "Two", type: "http", method: "POST", url: `${base}/second` },
    ]);
    const id = await start("two");
    const draining = jobs.drain();
    await first;
    await call("POST", `/v1/workflow-runs/${id}/cancel`);
    release();
    await draining;
    const after = await run(id);
    expect(after.status).toBe("cancelled");
    expect(hits.map((h) => h.url)).toEqual(["/first"]);
  });
});

describe("steps", () => {
  it("fails an HTTP step on a 4xx answer, without retries, and marks the workflow failing until a run is done", async () => {
    answer = (_req, res) => (res.writeHead(404), res.end("no"));
    await save("missing", [{ id: "call", name: "Call", type: "http", method: "GET", url: `${base}/gone` }]);
    const id = await start("missing");
    await jobs.drain();
    const after = await run(id);
    expect(after.status).toBe("failed");
    expect(after.error).toBe("Step 'Call' failed: answered 404");
    expect(after.steps[0].attempt).toBe(1);
    const failing = (await call("GET", "/v1/workflows/missing")).body.failing_since;
    expect(failing).toEqual(expect.any(String));

    // A second failure keeps the first time; a run that is done clears it.
    await start("missing");
    await jobs.drain();
    expect((await call("GET", "/v1/workflows/missing")).body.failing_since).toBe(failing);
    answer = (_req, res) => (res.writeHead(200), res.end("{}"));
    await start("missing");
    await jobs.drain();
    expect((await call("GET", "/v1/workflows/missing")).body.failing_since).toBeUndefined();
  });

  it("keeps secrets out of the run log", async () => {
    process.env.KAIROS_SECRET_OPS_TOKEN = "s3cret-token-value";
    try {
      answer = (_req, res, body) => (res.writeHead(200, { "Content-Type": "application/json" }), res.end(body));
      await save("secret", [
        {
          id: "call",
          name: "Call",
          type: "http",
          method: "POST",
          url: `${base}/echo`,
          body: { token: "{{ secrets.OPS_TOKEN }}" },
        },
      ]);
      const id = await start("secret");
      await jobs.drain();
      const after = await run(id);
      expect(hits[0]!.body).toContain("s3cret-token-value");
      expect(JSON.stringify(after)).not.toContain("s3cret-token-value");
      expect(after.steps[0].output.body).toEqual({ token: "…" });
    } finally {
      delete process.env.KAIROS_SECRET_OPS_TOKEN;
    }
  });

  it("sends an object body as JSON, unless the step sets its own Content-Type", async () => {
    const types: (string | undefined)[] = [];
    answer = (req, res) => (types.push(req.headers["content-type"]), res.writeHead(200), res.end("{}"));
    await save("json", [
      { id: "object", name: "Object", type: "http", method: "POST", url: `${base}/object`, body: { a: 1 } },
      { id: "text", name: "Text", type: "http", method: "POST", url: `${base}/text`, body: "a=1" },
      {
        id: "own",
        name: "Own",
        type: "http",
        method: "POST",
        url: `${base}/own`,
        headers: { "content-type": "application/vnd.api+json" },
        body: { a: 1 },
      },
    ]);
    await start("json");
    await jobs.drain();
    expect(types).toEqual(["application/json", undefined, "application/vnd.api+json"]);
  });

  it("writes a decide step's key with its decision, and does not decide again on a retry", async () => {
    await call("PUT", "/v1/actions/payout", { subject: "user", hold: "Should this payout be held?" });
    await save("check", [
      { id: "check", name: "Check", type: "decide", action: "payout", entities: "{{ trigger.entities }}" },
    ]);
    const id = await start("check", { entities: { user: "u1" } });
    await jobs.drain();
    const after = await run(id);
    expect(after.status).toBe("done");
    const decision = await new DecisionsService(database.db, {
      workspaceId: "workspace_a",
      environmentId: "workspace_a",
    }).findRecord(after.steps[0].output.decision_id);
    expect(decision!.metadata).toEqual({ workflow_run_id: id, workflow_step_key: `${id}:check` });
    // The step runs again with no log, as after a crash before its checkpoint.
    await database.db.execute(sql`UPDATE workflow_runs SET status = 'running', steps = '[]'::jsonb WHERE id = ${id}`);
    await database.db.execute(
      sql`UPDATE jobs SET status = 'pending', run_at = now() - interval '1 minute' WHERE key LIKE ${`${id}:%`}`,
    );
    await jobs.drain();
    expect((await run(id)).steps[0].output.decision_id).toBe(after.steps[0].output.decision_id);
    expect(decided).toBe(1);
  });

  it("gives an event run the event as trigger, and makes a live test step in a loop", async () => {
    await save(
      "on_payout",
      [
        {
          id: "make",
          name: "Make",
          type: "record.create",
          record: "object",
          entity: "user",
          record_id: "{{ trigger.entities.user }}",
        },
      ],
      { type: "event", event: "payout" },
    );
    await call("POST", "/v1/events", {
      batch: [{ id: "p1", type: "payout", ts: new Date().toISOString(), entities: { user: "u7" } }],
    });
    await jobs.drain();
    expect((await runs("on_payout"))[0].status).toBe("done");
    expect((await call("GET", "/v1/entities/user/u7")).status).toBe(200);

    const test = await call("POST", "/v1/workflows/test", {
      definition: {
        name: "loop_test",
        trigger: { type: "manual" },
        steps: [
          {
            id: "each",
            name: "Each",
            type: "loop",
            over: "trigger.users",
            steps: [
              {
                id: "make",
                name: "Make",
                type: "record.create",
                record: "object",
                entity: "user",
                record_id: "{{ item }}",
              },
            ],
          },
        ],
      },
      input: { users: ["t1", "t2"] },
      live_steps: ["make"],
    });
    await jobs.drain();
    expect((await run(test.body.id)).status).toBe("done");
    expect((await call("GET", "/v1/entities/user/t1")).status).toBe(200);
    expect((await call("GET", "/v1/entities/user/t2")).status).toBe(200);
  });
});

describe("drafts, publishing, pausing and archiving", () => {
  const tell = (path: string) => [{ id: "tell", name: "Tell", type: "http", method: "POST", url: `${base}${path}` }];
  const get = async (name: string) => (await call("GET", `/v1/workflows/${name}`)).body;

  it("keeps changes in a draft that runs do not read until it is published", async () => {
    const first = await call("PUT", "/v1/workflows/flow/draft", { trigger: { type: "manual" }, steps: tell("/one") });
    expect(first.status).toBe(200);
    expect([first.body.version, first.body.status, first.body.draft.steps[0].url]).toEqual([0, "draft", `${base}/one`]);
    expect((await call("POST", "/v1/workflows/flow/runs", { input: {} })).body.error.message).toMatch(/not published/);

    expect((await call("POST", "/v1/workflows/flow/publish")).body).toMatchObject({
      version: 1,
      status: "published",
      published_at: expect.any(String),
      steps: tell("/one"),
    });
    expect((await get("flow")).draft).toBeUndefined();

    // A change is a draft: the live version and its runs do not change.
    await call("PUT", "/v1/workflows/flow/draft", { trigger: { type: "manual" }, steps: tell("/two") });
    expect(await get("flow")).toMatchObject({ version: 1, steps: tell("/one"), draft: { steps: tell("/two") } });
    await start("flow");
    await jobs.drain();
    expect(hits.map((h) => h.url)).toEqual(["/one"]);

    // A draft that has problems is saved, and is not published.
    await call("PUT", "/v1/workflows/flow/draft", {
      trigger: { type: "manual" },
      steps: [{ id: "x", name: "X", type: "http" }],
    });
    expect((await call("POST", "/v1/workflows/flow/publish")).status).toBe(400);
    expect((await call("DELETE", "/v1/workflows/flow/draft")).body.draft).toBeUndefined();
    expect((await call("POST", "/v1/workflows/flow/publish")).body.error.message).toMatch(/no changes/);

    await call("PUT", "/v1/workflows/flow/draft", { trigger: { type: "manual" }, steps: tell("/two") });
    expect((await call("POST", "/v1/workflows/flow/publish")).body.version).toBe(2);
    // A draft equal to the live version is no draft.
    expect(
      (await call("PUT", "/v1/workflows/flow/draft", { trigger: { type: "manual" }, steps: tell("/two") })).body.draft,
    ).toBeUndefined();
  });

  it("pauses, archives and restores a workflow, which then starts no runs", async () => {
    await save("watch", tell("/seen"), { type: "event", event: "payout" });
    const send = (id: string) =>
      call("POST", "/v1/events", {
        batch: [{ id, type: "payout", ts: new Date().toISOString(), entities: { user: "u" } }],
      });

    expect((await call("PATCH", "/v1/workflows/watch", { enabled: false })).body.enabled).toBe(false);
    await send("e1");
    expect((await call("POST", "/v1/workflows/watch/runs", { input: {} })).body.error.message).toMatch(/paused/);
    await call("PATCH", "/v1/workflows/watch", { enabled: true });

    expect((await call("POST", "/v1/workflows/watch/archive")).body.status).toBe("archived");
    await send("e2");
    expect((await call("GET", "/v1/workflows")).body.workflows).toEqual([]);
    expect((await call("GET", "/v1/workflows?archived=true")).body.workflows.map((w: any) => w.name)).toEqual([
      "watch",
    ]);
    expect((await call("PUT", "/v1/workflows/watch/draft", { trigger: { type: "manual" }, steps: [] })).status).toBe(
      400,
    );

    expect((await call("POST", "/v1/workflows/watch/restore")).body.status).toBe("published");
    await send("e3");
    await jobs.drain();
    expect((await runs("watch")).map((r) => r.trigger.event.id)).toEqual(["e3"]);
  });
});

describe("test runs and searches", () => {
  const testRun = async (body: Record<string, unknown>) => {
    const started = await call("POST", "/v1/workflows/test", body);
    await jobs.drain();
    return run(started.body.id);
  };

  it("gives a step that only shows itself the sample output, for the steps after it", async () => {
    await call("PUT", "/v1/actions/payout", { subject: "user", hold: "Should this payout be held?" });
    const after = await testRun({
      definition: {
        name: "sampled",
        trigger: { type: "manual" },
        steps: [
          { id: "check", name: "Check", type: "decide", action: "payout", entities: { user: "u1" } },
          { id: "blocked", name: "Blocked", type: "filter", when: "steps.check.output.decision == 'block'" },
        ],
      },
      mock_outputs: { check: { decision: "block" } },
    });
    expect(after.status).toBe("done");
    expect(after.steps[0].output).toMatchObject({ test: true, decision: "block" });
    expect(after.steps[1].output).toEqual({ passed: true });
    expect(decided).toBe(0);
    expect((await call("POST", "/v1/workflows/test", { definition: { name: "x" }, mock_outputs: [] })).status).toBe(
      400,
    );
  });

  it("finds the events and the decisions about one entity", async () => {
    await call("PUT", "/v1/actions/payout", { subject: "user", hold: "Should this payout be held?" });
    const ts = new Date().toISOString();
    await call("POST", "/v1/events", {
      batch: [
        { id: "p1", type: "payee_added", ts, entities: { user: "u1", payee: "pay_1" } },
        { id: "p2", type: "payee_added", ts, entities: { user: "u2", payee: "pay_2" } },
        { id: "t1", type: "transfer", ts, entities: { user: "u1", payee: "pay_1" } },
      ],
    });
    await call("POST", "/v1/decide", { action: "payout", entities: { user: "u1" } });
    await call("POST", "/v1/decide", { action: "payout", entities: { user: "u2" } });
    const after = await testRun({
      definition: {
        name: "searches",
        trigger: { type: "manual" },
        steps: [
          {
            id: "added",
            name: "Added",
            type: "record.search",
            record: "event",
            entity: "payee",
            record_id: "pay_1",
            types: ["payee_added"],
          },
          { id: "about", name: "About", type: "record.search", record: "decision", entity: "user", record_id: "u1" },
        ],
      },
    });
    expect(after.steps[0].output.map((e: any) => e.id)).toEqual(["p1"]);
    expect(after.steps[1].output.map((d: any) => d.subject.id)).toEqual(["u1"]);
  });

  it("does not try an expression that cannot run again, and names a secret that is not set", async () => {
    const after = await testRun({
      definition: {
        name: "broken",
        trigger: { type: "manual" },
        steps: [
          {
            id: "bad",
            name: "Bad",
            type: "record.get",
            record: "object",
            entity: "user",
            record_id: "{{ trigger.nothing.here }}",
          },
        ],
      },
    });
    expect(after.status).toBe("failed");
    expect(after.steps[0].attempt).toBe(1);
    const secret = await testRun({
      definition: {
        name: "secret",
        trigger: { type: "manual" },
        steps: [{ id: "call", name: "Call", type: "http", method: "POST", url: "{{ secrets.NOT_SET_ANYWHERE }}" }],
      },
    });
    expect(secret.error).toBe(
      "Step 'Call' failed: the secret NOT_SET_ANYWHERE is not set: set KAIROS_SECRET_NOT_SET_ANYWHERE on the server",
    );
  });
});

describe("record triggers", () => {
  const filter = [{ id: "seen", name: "Seen", type: "filter", when: "true" }];
  const triggered = async (name: string) => (await runs(name)).map((r) => `${r.trigger.record}.${r.trigger.on}`).sort();

  it("starts on entities that are created, updated and labelled, for the entity type asked", async () => {
    await save("users_created", filter, { type: "record", record: "entity", on: "created", entity: "user" });
    await save("users_updated", filter, {
      type: "record",
      record: "entity",
      on: "updated",
      when: "trigger.entity.properties.tier == 'gold'",
    });
    await save("fraud_label", filter, { type: "record", record: "entity", on: "labelled", label: "fraud" });

    await call("PUT", "/v1/objects", { batch: [{ type: "user", id: "u1", properties: { tier: "silver" } }] });
    await call("PUT", "/v1/objects", { batch: [{ type: "merchant", id: "m1", properties: {} }] });
    // The same values again change nothing, so it is no update.
    await call("PUT", "/v1/objects", { batch: [{ type: "user", id: "u1", properties: { tier: "silver" } }] });
    await call("PUT", "/v1/objects", { batch: [{ type: "user", id: "u1", properties: { tier: "gold" } }] });
    await call("POST", "/v1/labels", { batch: [{ entity: { type: "user", id: "u1" }, label: "fraud" }] });
    await call("POST", "/v1/labels", { batch: [{ entity: { type: "user", id: "u1" }, label: "vip" }] });
    await jobs.drain();

    expect(await triggered("users_created")).toEqual(["entity.created"]);
    expect(await triggered("users_updated")).toEqual(["entity.updated"]);
    const updated = (await runs("users_updated"))[0];
    expect([updated.trigger.entity.properties.tier, updated.trigger.before.tier]).toEqual(["gold", "silver"]);
    expect(await triggered("fraud_label")).toEqual(["entity.labelled"]);
    expect((await runs("fraud_label"))[0].status).toBe("done");
  });

  it("starts on decisions that are made and resolved, and on any stored event", async () => {
    await call("PUT", "/v1/actions/payout", { subject: "user", hold: "Should this payout be held?" });
    await save("made", filter, { type: "record", record: "decision", on: "created", action: "payout" });
    await save("resolved", filter, { type: "record", record: "decision", on: "updated" });
    await save("stored", [{ id: "read", name: "Read", type: "filter", when: "event.type == trigger.event.type" }], {
      type: "record",
      record: "event",
      on: "created",
    });
    const decided = (await call("POST", "/v1/decide", { action: "payout", entities: { user: "u1" } })).body;
    await call("POST", `/v1/decisions/${decided.decision_id}/resolution`, { outcome: "approve" });
    await call("POST", "/v1/events", {
      batch: [{ id: "a1", type: "anything", ts: new Date().toISOString(), entities: { user: "u1" } }],
    });
    await jobs.drain();

    expect(await triggered("made")).toEqual(["decision.created"]);
    expect((await runs("made"))[0].trigger.decision.id).toBe(decided.decision_id);
    expect(await triggered("resolved")).toEqual(["decision.updated"]);
    expect((await runs("stored")).map((r) => [r.trigger.record, r.trigger.event.id, r.status])).toEqual([
      ["event", "a1", "done"],
    ]);
  });

  it("does not start a workflow on a change that its own run made", async () => {
    await save(
      "promote",
      [
        {
          id: "gold",
          name: "Make gold",
          type: "record.update",
          record: "object",
          entity: "user",
          record_id: "{{ trigger.entity.id }}",
          properties: { tier: "gold" },
        },
      ],
      { type: "record", record: "entity", on: "updated", entity: "user" },
    );
    await call("PUT", "/v1/objects", { batch: [{ type: "user", id: "u9", properties: { tier: "none" } }] });
    await call("PUT", "/v1/objects", { batch: [{ type: "user", id: "u9", properties: { tier: "silver" } }] });
    await jobs.drain();
    await jobs.drain();
    const all = await runs("promote");
    expect(all.map((r) => r.status)).toEqual(["done"]);
    expect((await call("GET", "/v1/entities/user/u9")).body.properties.tier).toBe("gold");
  });

  it("refuses a record trigger without a record and a change it knows", async () => {
    const bad = await save("bad_record", filter, { type: "record", record: "entity", on: "deleted" });
    expect(bad.body.error.message).toMatch(/trigger\.on: for entity, created or updated or labelled/);
  });
});

describe("inputs, and runs that the caller waits for", () => {
  /** As `app`, but its HTTP steps may call this machine, as the background runner's may. */
  const local = createApp({
    repos,
    environments: environmentsRepository(database.db),
    accounts: tenancyRepository(database.db),
    decider,
    now,
    webhooks: { db: database.db, allowPrivate: true },
  });
  const wait = async (name: string, body: Record<string, unknown>, through = app) => {
    const response = await through.request(`/v1/workflows/${name}/runs`, {
      method: "POST",
      headers: { Authorization: "Bearer key_a", "Content-Type": "application/json" },
      body: JSON.stringify({ wait: true, ...body }),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  const inputs = [
    { name: "user", type: "entity", entity: "user", required: true },
    { name: "amount", type: "number", default: 0 },
  ];

  it("checks the inputs of a manual trigger, and adds their defaults", async () => {
    expect(
      (await save("bad_inputs", [], { type: "manual", inputs: [{ name: "when", type: "date" }] })).body.error.message,
    ).toMatch(/trigger\.inputs\.when\.type/);
    await save("check", [{ id: "pass", name: "Pass", type: "filter", when: "true" }], { type: "manual", inputs });
    const missing = await call("POST", "/v1/workflows/check/runs", { input: {} });
    expect(missing.status).toBe(400);
    expect(missing.body.error.message).toBe("input.user: is required");
    expect(
      (await call("POST", "/v1/workflows/check/runs", { input: { user: "u1", amount: "5" } })).body.error.message,
    ).toBe("input.amount: must be a number");
    const started = await call("POST", "/v1/workflows/check/runs", { input: { user: "u1", note: "kept" } });
    expect(started.status).toBe(202);
    expect(started.body.trigger).toEqual({ user: "u1", amount: 0, note: "kept" });
  });

  it("runs in the request and answers with the output of its Return step", async () => {
    await save(
      "review",
      [
        {
          id: "big",
          name: "Big",
          type: "condition",
          when: "trigger.amount >= 1000",
          then: [
            { id: "hold", name: "Hold", type: "return", value: { outcome: "review", user: "{{ trigger.user }}" } },
          ],
        },
        { id: "fine", name: "Fine", type: "return", value: { outcome: "approve" } },
        { id: "never", name: "Never", type: "filter", when: "false" },
      ],
      { type: "manual", inputs },
    );
    const big = await wait("review", { input: { user: "u1", amount: 5000 } });
    expect(big.status).toBe(200);
    expect(big.body).toMatchObject({ status: "done", output: { outcome: "review", user: "u1" } });
    expect((await wait("review", { input: { user: "u2", amount: 10 } })).body.output).toEqual({ outcome: "approve" });
    // Its first job was only there in case this process stopped: it is gone.
    expect((await database.db.execute<Record<string, any>>(sql`SELECT count(*)::int AS n FROM jobs`)).rows[0]).toEqual({
      n: 0,
    });
  });

  it("gives the output of the last step without a Return step, and the same run for the same key", async () => {
    await save("look", [
      { id: "pass", name: "Pass", type: "filter", when: "true" },
      { id: "find", name: "Find", type: "record.search", record: "event", limit: 5 },
    ]);
    const first = await wait("look", { idempotency_key: "k1" });
    expect(first.body).toMatchObject({ status: "done", output: [] });
    const again = await wait("look", { idempotency_key: "k1" });
    expect(again.body.id).toBe(first.body.id);
  });

  it("refuses to wait for a run with a delay, before it starts", async () => {
    await save("later", [
      { id: "first", name: "First", type: "filter", when: "true" },
      {
        id: "nap",
        name: "Wait a day",
        type: "condition",
        when: "true",
        then: [{ id: "d", name: "Nap", type: "delay", for: "24h" }],
      },
    ]);
    const refused = await wait("later", {});
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toMatch(/the delay "Nap" comes before the answer/);
    expect(await runs("later")).toEqual([]);
    expect((await wait("later", { timeout_seconds: 99 })).status).toBe(400);
  });

  it("answers 202 when the time is up or a step must retry, and the run goes on in the background", async () => {
    answer = (_req, res) => setTimeout(() => (res.writeHead(200), res.end("{}")), 1200);
    await save("slow", [
      { id: "one", name: "One", type: "http", method: "POST", url: `${base}/one` },
      { id: "two", name: "Two", type: "http", method: "POST", url: `${base}/two` },
    ]);
    const slow = await wait("slow", { timeout_seconds: 1 }, local);
    expect(slow.status).toBe(202);
    expect(slow.body.status).toBe("queued");
    expect(hits.map((h) => h.url)).toEqual(["/one"]);
    await jobs.drain();
    expect((await run(slow.body.id)).status).toBe("done");
    expect(hits.map((h) => h.url)).toEqual(["/one", "/two"]);

    answer = (_req, res) => (res.writeHead(503), res.end("busy"));
    await save("flaky", [{ id: "call", name: "Call", type: "http", method: "POST", url: `${base}/flaky` }]);
    const flaky = await wait("flaky", {}, local);
    expect(flaky.status).toBe(202);
    expect(flaky.body.steps[0]).toMatchObject({ status: "failed", attempt: 1 });
    const keys = (
      await database.db.execute<Record<string, any>>(
        sql`SELECT key FROM jobs WHERE kind = 'workflow.run' AND status = 'pending'`,
      )
    ).rows;
    expect(keys).toEqual([{ key: `${flaky.body.id}:2` }]);
  });
});

describe("asking the model a question", () => {
  const questions = {
    takeover: { type: "yes_no", question: "Is someone other than the owner using this account?" },
    topic: {
      type: "one_of",
      question: "What is the message about?",
      options: { refund: "A refund", fraud: "Fraud or a stolen card" },
    },
    signals: {
      type: "any_of",
      question: "Which signals are present?",
      options: { vpn: "A VPN", new_device: "A new device" },
    },
    urgency: { type: "score", question: "How urgent is a review?", levels: ["low", "medium", "high"] },
  };
  const triage = (more: Record<string, unknown> = {}) => ({
    id: "triage",
    name: "Triage",
    type: "ask",
    entity: { type: "user", id: "{{ trigger.user }}" },
    data: { message: "{{ trigger.message }}" },
    questions,
    ...more,
  });

  it("asks its own questions about an entity and data, and the next steps read the answers", async () => {
    await save("triage_messages", [
      triage(),
      {
        id: "route",
        name: "Route",
        type: "condition",
        when: "steps.triage.output.takeover.value && steps.triage.output.topic.value == 'refund'",
        then: [{ id: "takeover", name: "Takeover", type: "return", value: { path: "takeover" } }],
        else: [{ id: "other", name: "Other", type: "return", value: { path: "other" } }],
      },
    ]);
    const done = await call("POST", "/v1/workflows/triage_messages/runs", {
      wait: true,
      input: { user: "u1", message: "I did not ask for this refund" },
    });
    expect(done.body).toMatchObject({ status: "done", output: { path: "takeover" } });
    expect(done.body.steps[0].output).toMatchObject({
      takeover: { value: true, probability: 0.8 },
      topic: { value: "refund" },
      signals: { values: ["vpn"] },
      urgency: { level: "medium", value: 1 },
      input_tokens: 7,
    });
    const request = asked.at(-1)!;
    expect(Object.fromEntries(Object.entries(request.questions).map(([k, q]) => [k, q.type]))).toEqual({
      takeover: "noul",
      topic: "choice",
      signals: "multi_choice",
      urgency: "score",
    });
    const context = request.context as { subject: { id: string }; pending_action: { message: string } };
    expect(context.subject.id).toBe("u1");
    expect(context.pending_action.message).toBe("I did not ask for this refund");
  });

  it("asks about data alone, and a test run with a sample answer asks nothing", async () => {
    await save("triage_text", [triage({ entity: undefined })]);
    await call("POST", "/v1/workflows/triage_text/runs", { wait: true, input: { message: "Card stolen" } });
    expect(asked.at(-1)!.context).toEqual({ data: { message: "Card stolen" } });

    const before = decided;
    const test = await call("POST", "/v1/workflows/test", {
      definition: { name: "triage_text", trigger: { type: "manual" }, steps: [triage({ entity: undefined })] },
      input: { message: "x" },
      mock_outputs: { triage: { takeover: { value: false, probability: 0.1 } } },
    });
    await jobs.drain();
    expect((await run(test.body.id)).steps[0].output).toEqual({ takeover: { value: false, probability: 0.1 } });
    expect(decided).toBe(before);
  });

  it("checks the questions when it is saved, and the data's size when it runs", async () => {
    const problem = async (step: unknown) => (await save("bad_ask", [step])).body.error?.message ?? "";
    expect(await problem(triage({ questions: {} }))).toMatch(/at least one question/);
    expect(await problem(triage({ questions: { a: { type: "essay", question: "Why?" } } }))).toMatch(
      /questions\.a\.type: yes_no, one_of, any_of, score/,
    );
    expect(await problem(triage({ questions: { input_tokens: { type: "yes_no", question: "?" } } }))).toMatch(
      /questions\.input_tokens: a key/,
    );
    expect(
      await problem(triage({ questions: { a: { type: "one_of", question: "?", options: { only: "One" } } } })),
    ).toMatch(/at least two options/);
    expect(await problem(triage({ entity: undefined, data: undefined }))).toMatch(/give the model something to read/);
    const questions = (n: number) =>
      Object.fromEntries(
        Array.from({ length: n }, (_, i) => [`q${i}`, { type: "yes_no", question: `Question ${i}?` }]),
      );
    expect(await problem(triage({ questions: questions(75) }))).toBe("");
    expect(await problem(triage({ questions: questions(76) }))).toMatch(/at most 75 questions/);

    await save("big_ask", [triage({ entity: undefined })]);
    const big = await call("POST", "/v1/workflows/big_ask/runs", {
      wait: true,
      input: { message: "x".repeat(40_000) },
    });
    expect(big.body.error).toMatch(/the model reads at most 32 KB/);
  });
});

describe("decision workflows", () => {
  const trigger = { type: "decision", action: "payout" };
  const defineAction = () =>
    call("PUT", "/v1/actions/payout", { subject: "user", hold: "Should this payout be held?" });
  const decide = (properties: Record<string, unknown> = {}) =>
    call("POST", "/v1/decide", { action: "payout", entities: { user: "u1" }, properties });
  const approve = [{ id: "ok", name: "Fine", type: "return", value: { outcome: "approve" } }];

  it("makes the action's decisions with rules, without the model", async () => {
    await defineAction();
    await save(
      "payout_rules",
      [
        {
          id: "big",
          name: "Big",
          type: "condition",
          when: "trigger.properties.amount >= 1000",
          then: [
            {
              id: "hold",
              name: "Hold",
              type: "return",
              value: { outcome: "block", reasons: ["big_amount"], rules: ["amount_over_1000"] },
            },
          ],
        },
        ...approve,
      ],
      trigger,
    );
    const big = await decide({ amount: 5000 });
    expect(big.status).toBe(200);
    expect(big.body).toMatchObject({
      decision: "block",
      reasons: ["big_amount"],
      rules: ["amount_over_1000"],
      risk_score: 0,
    });
    expect((await decide({ amount: 5 })).body.decision).toBe("approve");
    expect(decided).toBe(0);
    const saved = (await call("GET", `/v1/decisions/${big.body.decision_id}`)).body;
    expect(saved.metadata).toMatchObject({
      decision_workflow: "payout_rules@1",
      decision_run_id: big.body.workflow_run_id,
    });
    expect((await run(big.body.workflow_run_id)).trigger).toMatchObject({
      action: "payout",
      entities: { user: "u1" },
      decision_id: big.body.decision_id,
    });
  });

  it("asks a question about the history before the moment that it decides as of", async () => {
    await defineAction();
    const login = (id: string, ts: string) => ({ id, type: "login", ts, entities: { user: "u1" }, properties: {} });
    await call("POST", "/v1/events", {
      batch: [login("before", "2026-01-01T00:00:00Z"), login("after", "2026-03-01T00:00:00Z")],
    });
    await save(
      "payout_ask",
      [
        {
          id: "ask",
          name: "Ask",
          type: "ask",
          entity: { type: "user", id: "{{ trigger.entities.user }}" },
          questions: { odd: { type: "yes_no", question: "Is anything odd?" } },
        },
        ...approve,
      ],
      trigger,
    );
    await call("POST", "/v1/decide", { action: "payout", entities: { user: "u1" }, ts: "2026-02-01T00:00:00Z" });
    const context = asked.at(-1)!.context as { recent_events: { ts: string }[] };
    expect(context.recent_events.map((e) => e.ts)).toEqual(["2026-01-01T00:00:00"]);
  });

  it("asks the model in a step, and keeps what the model said with the decision", async () => {
    await defineAction();
    await save(
      "payout_model",
      [
        { id: "ask", name: "Ask", type: "assess" },
        {
          id: "answer",
          name: "Answer",
          type: "return",
          value: { outcome: "{{ steps.ask.output.probability > 0.5 ? 'block' : 'review' }}" },
        },
      ],
      trigger,
    );
    const made = await decide({ amount: 10 });
    expect(made.body).toMatchObject({ decision: "review", risk_score: 10, probability: 0.1 });
    expect(decided).toBe(1);
    const saved = (await call("GET", `/v1/decisions/${made.body.decision_id}`)).body;
    expect(saved.raw.answers.hold.probability).toBe(0.1);
  });

  it("answers, then runs the steps after the answer once the decision is saved", async () => {
    await defineAction();
    await save(
      "payout_follow",
      [
        { id: "answer", name: "Answer", type: "answer", value: { outcome: "review" } },
        {
          id: "label",
          name: "Label",
          type: "record.update",
          record: "object",
          entity: "user",
          record_id: "{{ trigger.entities.user }}",
          add_label: "under_review",
        },
      ],
      trigger,
    );
    const made = await decide();
    expect(made.body.decision).toBe("review");
    expect((await run(made.body.workflow_run_id)).status).toBe("waiting");
    await jobs.drain();
    const after = await run(made.body.workflow_run_id);
    expect(after).toMatchObject({ status: "done", output: { outcome: "review" } });
    expect(after.trigger.decision_id).toBe(made.body.decision_id);
    expect(after.steps.map((s: any) => `${s.id}:${s.status}`)).toEqual(["answer:done", "label:done"]);
  });

  it("goes on after the answer only for a live decision, and is the parent of the runs its decision starts", async () => {
    await defineAction();
    await save(
      "payout_follow",
      [
        { id: "answer", name: "Answer", type: "answer", value: { outcome: "review" } },
        { id: "later", name: "Later", type: "filter", when: "true" },
      ],
      trigger,
    );
    await save("on_decision", [{ id: "seen", name: "Seen", type: "filter", when: "true" }], {
      type: "record",
      record: "decision",
      on: "created",
      action: "payout",
    });
    const past = await call("POST", "/v1/decide", {
      action: "payout",
      entities: { user: "u1" },
      ts: new Date(Date.now() - 86_400_000).toISOString(),
    });
    expect((await run(past.body.workflow_run_id)).status).toBe("cancelled");

    const live = await decide();
    const [after] = (
      await database.db.execute<Record<string, any>>(
        sql`SELECT parent_run_id, depth FROM workflow_runs WHERE key = ${`decision.created:${live.body.decision_id}`}`,
      )
    ).rows;
    expect(after).toEqual({ parent_run_id: live.body.workflow_run_id, depth: 1 });
  });

  it("fails the decision when the workflow fails before its answer", async () => {
    await defineAction();
    await save(
      "payout_broken",
      [{ id: "get", name: "Get", type: "record.get", record: "decision", record_id: "kdec_nothing" }, ...approve],
      trigger,
    );
    const failed = await decide();
    expect(failed.status).toBe(502);
    expect(failed.body.error).toMatchObject({ type: "workflow_failed" });
    expect(failed.body.error.message).toMatch(/No decision "kdec_nothing"/);
    const count = await database.db.execute<Record<string, any>>(sql`SELECT count(*)::int AS n FROM decisions`);
    expect(count.rows[0]).toEqual({ n: 0 });
  });

  it("has one per action, and while it is paused the model decides", async () => {
    await defineAction();
    expect((await save("first", approve, trigger)).status).toBe(200);
    const second = await save("second", approve, trigger);
    expect(second.status).toBe(400);
    expect(second.body.error.message).toMatch(/"first" makes the decisions of "payout"/);
    expect((await call("PUT", "/v1/workflows/second/draft", { trigger, steps: approve })).status).toBe(200);

    await call("PATCH", "/v1/workflows/first", { enabled: false });
    expect((await decide()).body.workflow_run_id).toBeUndefined();
    expect(decided).toBe(1);

    await call("POST", "/v1/workflows/first/archive");
    expect((await save("second", approve, trigger)).status).toBe(200);
    expect((await call("POST", "/v1/workflows/first/restore")).status).toBe(400);
    expect((await call("POST", "/v1/workflows/second/runs", {})).body.error.message).toMatch(/call POST \/v1\/decide/);
  });

  it("checks the answers, path by path", async () => {
    const problem = async (steps: unknown[]) => (await save("check", steps, trigger)).body.error?.message ?? "";
    expect(await problem([{ id: "nap", name: "Nap", type: "delay", for: "1h" }, ...approve])).toMatch(
      /the delay "Nap" comes before the answer/,
    );
    expect(
      await problem([
        {
          id: "c",
          name: "C",
          type: "condition",
          when: "true",
          then: [{ id: "a", name: "A", type: "answer", value: { outcome: "block" } }],
        },
      ]),
    ).toMatch(/on some paths the workflow does not answer/);
    expect(await problem([{ id: "a", name: "A", type: "answer", value: { outcome: "maybe" } }])).toMatch(
      /steps\.a\.value\.outcome/,
    );
    expect(
      await problem([
        {
          id: "l",
          name: "L",
          type: "loop",
          over: "[1]",
          steps: [{ id: "a", name: "A", type: "answer", value: { outcome: "block" } }],
        },
        ...approve,
      ]),
    ).toMatch(/cannot be in a loop/);
    // A delay after the answer is fine: nobody waits for it.
    const later = await save(
      "later",
      [
        { id: "a", name: "A", type: "answer", value: { outcome: "review" } },
        { id: "nap", name: "Nap", type: "delay", for: "1h" },
      ],
      trigger,
    );
    expect(later.status).toBe(200);
  });

  it("answers a caller that waits for a manual run, and the run goes on after", async () => {
    await save("ack", [
      { id: "a", name: "Ack", type: "answer", value: { ok: true } },
      { id: "nap", name: "Nap", type: "delay", for: "1h" },
    ]);
    const answered = await call("POST", "/v1/workflows/ack/runs", { wait: true });
    expect(answered.status).toBe(200);
    expect(answered.body).toMatchObject({ status: "queued", output: { ok: true } });
    await jobs.drain();
    expect((await run(answered.body.id)).status).toBe("waiting");
  });
});

describe("scheduled and webhook triggers", () => {
  it("starts a scheduled workflow once for its due minute, and not for times before it was published", async () => {
    await save("every_minute", [{ id: "tick", name: "Tick", type: "filter", when: "true" }], {
      type: "scheduled",
      cron: "* * * * *",
      timezone: "Europe/London",
    });
    // Nothing is due before it was published.
    expect(await startScheduledRuns(repos, new Date(Date.now() - 120_000))).toBe(0);
    // Published five minutes ago: the latest due minute runs, once, and the ones before it do not.
    await database.db.execute(sql`UPDATE workflows SET published_at = now() - interval '5 minutes'`);
    expect(await startScheduledRuns(repos, new Date())).toBe(1);
    await startScheduledRuns(repos, new Date());
    await jobs.drain();
    const all = await runs("every_minute");
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ status: "done", trigger: { timezone: "Europe/London" } });
    expect(new Date(all[0].trigger.scheduled_at).getUTCSeconds()).toBe(0);

    await call("PATCH", "/v1/workflows/every_minute", { enabled: false });
    expect(await startScheduledRuns(repos, new Date())).toBe(0);
    expect((await save("bad_cron", [], { type: "scheduled", cron: "61 * * * *" })).body.error.message).toMatch(
      /trigger\.cron: minute/,
    );
  });

  it("starts a run from a delivery to the workflow's URL, without a key", async () => {
    await save("on_hook", [{ id: "seen", name: "Seen", type: "filter", when: "trigger.body.amount > 10" }], {
      type: "webhook",
      method: "POST",
      idempotency_header: "X-Delivery-Id",
    });
    const made = (await call("POST", "/v1/workflows/on_hook/hook")).body;
    expect(made.path).toMatch(/^\/v1\/workflow-hooks\/wfh_/);
    expect((await call("GET", "/v1/workflows/on_hook")).body.hook).toEqual({ hint: made.hint });
    const send = (path: string, init: RequestInit = {}) =>
      app.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Delivery-Id": "d1", Authorization: "Bearer theirs" },
        body: JSON.stringify({ amount: 50 }),
        ...init,
      });
    const first = await send(made.path);
    expect(first.status).toBe(202);
    const { run_id } = await first.json();
    expect((await (await send(made.path)).json()).run_id).toBe(run_id);
    await jobs.drain();
    const after = await run(run_id);
    expect(after).toMatchObject({ status: "done", trigger: { method: "POST", body: { amount: 50 } } });
    expect(after.trigger.headers.authorization).toBeUndefined();
    expect(after.trigger.headers["x-delivery-id"]).toBe("d1");

    expect((await send(made.path, { method: "GET", body: undefined })).status).toBe(405);
    expect((await send("/v1/workflow-hooks/wfh_nothing")).status).toBe(404);
    await call("PATCH", "/v1/workflows/on_hook", { enabled: false });
    expect((await send(made.path)).status).toBe(409);
    const remade = (await call("POST", "/v1/workflows/on_hook/hook")).body;
    expect((await send(made.path)).status).toBe(404);
    expect(remade.path).not.toBe(made.path);
  });
});

describe("runs and their workflow", () => {
  it("points each run to its workflow by id, and a delete takes the runs with it", async () => {
    await save("linked", [{ id: "only", name: "Only", type: "filter", when: "true" }]);
    const workflow = (await call("GET", "/v1/workflows/linked")).body;
    expect(workflow.id).toMatch(/^wfl_/);
    const id = await start("linked");
    const test = await call("POST", "/v1/workflows/test", {
      definition: {
        name: "linked",
        trigger: { type: "manual" },
        steps: [{ id: "t", name: "T", type: "filter", when: "true" }],
      },
    });
    const unsaved = await call("POST", "/v1/workflows/test", {
      definition: {
        name: "never_saved",
        trigger: { type: "manual" },
        steps: [{ id: "t", name: "T", type: "filter", when: "true" }],
      },
    });
    await jobs.drain();
    expect((await run(id)).workflow_id).toBe(workflow.id);
    expect((await run(test.body.id)).workflow_id).toBe(workflow.id);
    expect(await run(unsaved.body.id)).toMatchObject({
      workflow_id: null,
      status: "done",
      workflow: "never_saved@draft",
    });

    expect((await call("DELETE", "/v1/workflows/linked")).status).toBe(200);
    expect((await call("GET", `/v1/workflow-runs/${id}`)).status).toBe(404);
    expect((await call("GET", `/v1/workflow-runs/${unsaved.body.id}`)).status).toBe(200);
  });
});

describe("saving a workflow", () => {
  it("checks the trigger's condition and the delays when it is saved", async () => {
    const bad = await save("bad", [{ id: "wait", name: "Wait", type: "delay", for: "45d" }], {
      type: "event",
      event: "payout",
      when: "event.properties.amount >=",
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/trigger\.when/);
    expect(bad.body.error.message).toMatch(/at most 30 days/);
    expect((await save("soon", [{ id: "wait", name: "Wait", type: "delay", for: "soon" }])).body.error.message).toMatch(
      /30s, 15m, 24h or 7d/,
    );
  });

  it("keeps one decision for one step in each environment, so a copy of decisions works", async () => {
    const write = (workspace: string) =>
      new DecisionsService(database.db, { workspaceId: workspace, environmentId: workspace }).createRecord(
        {
          id: `kdec_${workspace}`,
          ts: new Date().toISOString(),
          action: "payout@1",
          subject: { type: "user", id: "u1" },
          decision: {},
          context: {},
          raw: {},
          metadata: { workflow_step_key: "wfr_1:check" },
        },
        null,
        new Date(),
      );
    await write("workspace_a");
    await expect(write("workspace_b")).resolves.toBeUndefined();
  });
});
