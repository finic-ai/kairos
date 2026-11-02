import type { Decider } from "@kairos/core";
import { sql } from "drizzle-orm";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { webhookDeliveries, webhooks, workspaces } from "../src/db/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { fileURLToPath } from "node:url";
import { caseJobs, evaluateDecision, loadViewTemplates } from "../src/modules/cases/service";
import { createWorkflowRunner } from "../src/modules/workflows/libs";
import { createJobs, type Jobs } from "../src/platform/jobs/worker";
import { createRepositories, environmentsRepository, tenancyRepository } from "../src/repositories";
import { testDatabase } from "./helpers/database";
import { mcpClient, resultOf } from "./helpers/mcp";

const database = await testDatabase();
const repos = createRepositories(database.db);
const NOW = new Date("2026-10-20T12:00:00Z");
const DAY = 86_400_000;

let clock: Date;
let app: ReturnType<typeof createApp>;
let runner: Jobs;
let cookie: string;
let workspace: string;
/** What the model answers next: the hold probability and each signal's probability. */
let answer: { hold: number; reasons: Record<string, number> };

const decider: Decider = async () => ({
  id: "d",
  model: "grayson-1",
  answers: {
    hold: { type: "noul", value: answer.hold >= 0.5, probability: answer.hold },
    reasons: {
      type: "multi_choice",
      values: Object.keys(answer.reasons).filter((k) => answer.reasons[k]! >= 0.5),
      probabilities: answer.reasons,
    },
  },
  usage: { input_tokens: 1 },
});

const call = async (method: string, path: string, body?: unknown, as = cookie) => {
  const response = await app.request(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Cookie: as,
      ...(path.startsWith("/v1") ? { "X-Kairos-Workspace": workspace } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as any };
};

const signup = async (email: string) => {
  const response = await app.request("/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "correct horse", name: email.split("@")[0] }),
  });
  return { cookie: (response.headers.get("set-cookie") ?? "").split(";")[0]!, profile: (await response.json()) as any };
};

const decide = async (entities: Record<string, string>, properties: Record<string, unknown> = {}, extra = {}) => {
  const made = await call("POST", "/v1/decide", { action: "onboard_user", entities, properties, ...extra });
  expect(made.status).toBe(200);
  await runner.drain();
  return made.body.decision_id as string;
};

const rule = {
  id: "held_or_risky",
  name: "Held or risky",
  priority: "normal",
  conditions: {
    any: [
      { field: "decision.outcome", op: "in", value: ["review", "block"] },
      { field: "signal.identity_mismatch", op: ">=", value: 0.9 },
    ],
  },
};

const queue = (patch: Record<string, unknown> = {}) => ({
  name: "Onboarding review",
  visibility: "workspace",
  sources: { actions: ["onboard_user"] },
  intake: [rule],
  correlation: { by: "subject", window_days: 30 },
  ...patch,
});

const makeQueue = async (patch: Record<string, unknown> = {}) => {
  const made = await call("POST", "/v1/queues", queue(patch));
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  return made.body.id as string;
};

const casesOf = async (queueId: string, query = "") => (await call("GET", `/v1/queues/${queueId}/cases${query}`)).body;
const caseJobCount = async () =>
  (await database.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM jobs WHERE kind = 'case.evaluate'`))
    .rows[0]!.n;

beforeEach(async () => {
  await database.reset();
  clock = NOW;
  answer = { hold: 0.7, reasons: { identity_mismatch: 0.2 } };
  runner = createJobs({
    repo: repos.jobs,
    kinds: [
      ...caseJobs({ repos, now: () => clock }).kinds,
      createWorkflowRunner({ repos, decider, now: () => clock, allowPrivate: true }),
    ],
    now: () => clock,
    random: () => 0.5,
    log: () => {},
  });
  app = createApp({
    repos,
    accounts: tenancyRepository(database.db),
    environments: environmentsRepository(database.db),
    decider,
    now: () => clock,
  });
  const owner = await signup("owner@example.com");
  cookie = owner.cookie;
  workspace = owner.profile.workspaces[0].id;
  const action = await call("PUT", "/v1/actions/onboard_user", {
    subject: "user",
    hold: "Should this signup be held for review?",
    reasons: {
      identity_mismatch: "The identity does not match the documents",
      new_device: "The device was never seen before",
    },
    trigger: { event: "signup" },
  });
  expect(action.status, JSON.stringify(action.body)).toBe(200);
});

describe("queues", () => {
  it("makes, lists, saves and versions a queue", async () => {
    const id = await makeQueue();
    const listed = (await call("GET", "/v1/queues")).body.queues;
    expect(listed).toMatchObject([
      { id, name: "Onboarding review", version: 1, mine: true, counts: { open: 0, in_review: 0, unassigned: 0 } },
    ]);
    // A change to the columns is not a new version; a change to the rules is.
    expect((await call("PUT", `/v1/queues/${id}`, queue({ columns: ["target", "risk"] }))).body.version).toBe(1);
    const changed = { ...rule, conditions: { all: [{ field: "decision.risk_score", op: ">=", value: 90 }] } };
    expect((await call("PUT", `/v1/queues/${id}`, queue({ intake: [changed] }))).body.version).toBe(2);
  });

  it("refuses a rule on the wrong scale, an outcome Kairos does not have, and an unknown action", async () => {
    const wrong = { ...rule, conditions: { all: [{ field: "signal.identity_mismatch", op: ">=", value: 90 }] } };
    const made = await call("POST", "/v1/queues", queue({ intake: [wrong] }));
    expect(made.status).toBe(400);
    expect(made.body.error.message).toMatch(/a signal score is a probability from 0 to 1/);
    const refer = { ...rule, conditions: { all: [{ field: "decision.outcome", op: "in", value: ["refer"] }] } };
    expect((await call("POST", "/v1/queues", queue({ intake: [refer] }))).body.error.message).toMatch(/"refer"/);
    expect((await call("POST", "/v1/queues", queue({ sources: { actions: ["nope"] } }))).body.error.message).toMatch(
      /there is no action "nope"/,
    );
  });

  it("enqueues nothing for a decision that no queue takes", async () => {
    await decide({ user: "u1" });
    expect(await caseJobCount()).toBe(0);
    await makeQueue();
    await decide({ user: "u1" });
    expect(await caseJobCount()).toBe(1);
  });

  it("refuses to delete a queue with cases", async () => {
    const id = await makeQueue();
    await decide({ user: "u1" });
    expect((await call("DELETE", `/v1/queues/${id}`)).status).toBe(409);
  });
});

describe("intake", () => {
  it("makes a case when a rule matches, and none when it does not", async () => {
    const id = await makeQueue();
    answer = { hold: 0.2, reasons: { identity_mismatch: 0.1 } };
    await decide({ user: "calm" });
    expect((await casesOf(id)).total).toBe(0);

    answer = { hold: 0.7, reasons: { identity_mismatch: 0.2 } };
    const decision = await decide({ user: "u1", device: "dev_9" }, { country: "GB" }, { session: "sess_1" });
    const { cases, total } = await casesOf(id);
    expect(total).toBe(1);
    expect(cases[0]).toMatchObject({
      status: "open",
      priority: "normal",
      target: { type: "user", id: "u1" },
      correlation_key: "subject:user:u1",
      reason: "Held or risky",
      outcome: "review",
      risk: 70,
      evidence_count: 1,
    });

    const detail = (await call("GET", `/v1/cases/${cases[0].id}`)).body;
    expect(detail.evidence).toHaveLength(1);
    expect(detail.evidence[0].snapshot.rule).toBe(
      "Outcome is review or block, or the identity mismatch signal is at least 0.90",
    );
    expect(detail.evidence[0].snapshot.conditions.map((c: any) => [c.read, c.held])).toEqual([
      ["review", true],
      [0.2, false],
    ]);
    expect(detail.items.map((i: any) => [i.kind, i.type, i.id])).toEqual(
      expect.arrayContaining([
        ["decision", null, decision],
        ["entity", "user", "u1"],
        ["entity", "device", "dev_9"],
        ["session", null, "sess_1"],
      ]),
    );
    expect(detail.decisions.map((d: any) => d.id)).toEqual([decision]);
  });

  it("names the case's entities by the display fields of their types", async () => {
    const id = await makeQueue();
    await call("PUT", "/v1/entity-types/user", { display: { fields: ["first_name", "last_name"] } });
    await call("PUT", "/v1/entities/user/u1", { properties: { first_name: "Ana", last_name: "Silva" } });
    await decide({ user: "u1", device: "dev_9" });
    const listed = (await casesOf(id)).cases[0];
    expect(listed.target_name).toBe("Ana Silva");
    const detail = (await call("GET", `/v1/cases/${listed.id}`)).body;
    expect(detail.target_name).toBe("Ana Silva");
    // A device has no display fields, so it has no name.
    expect(detail.names).toEqual({ "user u1": "Ana Silva" });
  });

  it("opens work on an approved decision when one signal is high", async () => {
    const id = await makeQueue();
    answer = { hold: 0.1, reasons: { identity_mismatch: 0.95 } };
    await decide({ user: "u1" });
    expect((await casesOf(id)).cases[0]).toMatchObject({ outcome: "approve", risk: 10 });
  });

  it("joins a later decision inside the window, and starts a new case after it", async () => {
    const id = await makeQueue({
      intake: [{ ...rule, priority: "low" }],
      correlation: { by: "subject", window_days: 3 },
    });
    await decide({ user: "u1" });
    clock = new Date(NOW.getTime() + 2 * DAY);
    answer = { hold: 0.95, reasons: {} };
    await decide({ user: "u1" });
    let { cases } = await casesOf(id);
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ evidence_count: 2, outcome: "block", risk: 95 });

    // The window counts from the last evidence: 2 days after the first trigger and 4 after the second is outside it.
    clock = new Date(clock.getTime() + 4 * DAY);
    await decide({ user: "u1" });
    ({ cases } = await casesOf(id));
    expect(cases).toHaveLength(2);
    const [first, second] = cases;
    const firstDetail = (await call("GET", `/v1/cases/${first.id}`)).body;
    expect(firstDetail.activity.at(-1)).toMatchObject({ type: "status_changed", payload: { next_case: second.id } });
  });

  it("writes one case and two evidence records when two rules match", async () => {
    const risky = {
      id: "risky",
      name: "Risky",
      priority: "high",
      conditions: { all: [{ field: "decision.risk_score", op: ">=", value: 60 }] },
    };
    const id = await makeQueue({ intake: [rule, risky] });
    await decide({ user: "u1" });
    const { cases } = await casesOf(id);
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ evidence_count: 2, priority: "high" });
  });

  it("writes nothing twice when the job runs again", async () => {
    const id = await makeQueue();
    await decide({ user: "u1" });
    await database.db.execute(sql`UPDATE jobs SET status = 'pending', run_at = ${clock}, attempts = 0`);
    await runner.drain();
    expect((await casesOf(id)).cases[0].evidence_count).toBe(1);
  });

  it("makes one case when two triggers with one key arrive at the same moment", async () => {
    const id = await makeQueue();
    const made = await Promise.all(
      [1, 2].map(() =>
        call("POST", "/v1/decide", { action: "onboard_user", entities: { user: "u1" }, properties: {} }),
      ),
    );
    const environmentId = (
      await database.db.execute<{ environment_id: string }>(sql`SELECT environment_id FROM queues LIMIT 1`)
    ).rows[0]!.environment_id;
    await Promise.all(
      made.map((m) => evaluateDecision(repos, { workspaceId: workspace, environmentId }, m.body.decision_id, clock)),
    );
    const { cases } = await casesOf(id);
    expect(cases).toHaveLength(1);
    expect(cases[0].evidence_count).toBe(2);
  });

  it("puts decisions about different subjects in one case by a named entity", async () => {
    const id = await makeQueue({ correlation: { by: "entity", type: "application", window_days: 90 } });
    await decide({ user: "u1", application: "app_7" });
    await decide({ user: "u2", application: "app_7" });
    const { cases } = await casesOf(id);
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ target: { type: "application", id: "app_7" }, evidence_count: 2 });
  });

  it("skips a trigger with no key when the queue says so", async () => {
    const id = await makeQueue({ correlation: { by: "entity", type: "application", when_missing: "skip" } });
    await decide({ user: "u1" });
    expect((await casesOf(id)).total).toBe(0);
  });

  it("makes no case for a decision as of a past moment", async () => {
    const id = await makeQueue();
    await decide({ user: "u1" }, {}, { ts: new Date(NOW.getTime() - 10 * DAY).toISOString() });
    expect((await casesOf(id)).total).toBe(0);
    expect(await caseJobCount()).toBe(0);
  });

  it("takes no new cases while the queue is off", async () => {
    const id = await makeQueue({ enabled: false });
    await decide({ user: "u1" });
    expect((await casesOf(id)).total).toBe(0);
  });
});

describe("work on a case", () => {
  it("is taken, noted, and resolved with its decisions and a label", async () => {
    const id = await makeQueue();
    const decision = await decide({ user: "u1" });
    const caseId = (await casesOf(id)).cases[0].id;

    const taken = await call("POST", `/v1/cases/${caseId}/take`);
    expect(taken.body).toMatchObject({ status: "in_review", assignee: { email: "owner@example.com" } });
    expect((await call("POST", `/v1/cases/${caseId}/notes`, { text: "Called the customer" })).status).toBe(200);

    expect(
      (await call("POST", `/v1/cases/${caseId}/resolve`, { category: "approved", label_target: true })).status,
    ).toBe(400);
    const resolved = await call("POST", `/v1/cases/${caseId}/resolve`, {
      category: "approved",
      note: "Documents checked",
      apply_to_decisions: true,
    });
    expect(resolved.body).toMatchObject({
      status: "resolved",
      resolution: { category: "approved", note: "Documents checked", by: "owner@example.com" },
      decisions_resolved: 1,
    });
    const after = (await call("GET", `/v1/decisions/${decision}`)).body;
    expect(after).toMatchObject({
      final_outcome: "approve",
      resolution: { outcome: "approve", note: "Documents checked" },
    });
    expect((await call("POST", `/v1/cases/${caseId}/resolve`, { category: "approved" })).status).toBe(409);

    const types = (await call("GET", `/v1/cases/${caseId}`)).body.activity.map((a: any) => a.type);
    expect(types).toEqual(["created", "assigned", "status_changed", "note", "resolved"]);

    // A resolved case is final: the next trigger with the key starts a new one.
    await decide({ user: "u1" });
    expect((await casesOf(id)).total).toBe(2);
  });

  it("is read, noted and resolved by an agent through MCP, under its key's name", async () => {
    const id = await makeQueue();
    await decide({ user: "u1" });
    const caseId = (await casesOf(id)).cases[0].id;
    const made = await call("POST", `/app/workspaces/${workspace}/keys`, { name: "Investigator", kind: "secret" });
    expect(made.status).toBe(200);
    const mcp = `/app/workspaces/${workspace}/mcp`;
    expect((await call("PUT", mcp, { enabled: true, groups: ["read", "write", "decide"] })).status).toBe(200);
    const agent = await mcpClient(app, made.body.secret);

    const queues = resultOf(await agent.callTool({ name: "list_queues", arguments: {} }));
    expect(queues.queues.map((q: any) => q.id)).toEqual([id]);
    const listed = resultOf(await agent.callTool({ name: "list_queue_cases", arguments: { queue_id: id } }));
    expect(listed.cases.map((c: any) => c.id)).toEqual([caseId]);
    expect(resultOf(await agent.callTool({ name: "get_case", arguments: { id: caseId } }))).toMatchObject({
      id: caseId,
      status: "open",
    });

    const noted = await agent.callTool({ name: "add_case_note", arguments: { id: caseId, text: "Same device as u7" } });
    expect(noted.isError).toBeFalsy();
    const resolved = resultOf(
      await agent.callTool({ name: "resolve_case", arguments: { id: caseId, category: "false_positive" } }),
    );
    expect(resolved).toMatchObject({ status: "resolved", resolution: { by: "mcp:Investigator" } });
    const activity = (await call("GET", `/v1/cases/${caseId}`)).body.activity;
    expect(activity.filter((a: any) => a.type === "note" || a.type === "resolved").map((a: any) => a.actor)).toEqual([
      "mcp:Investigator",
      "mcp:Investigator",
    ]);
    const timeline = resultOf(await agent.callTool({ name: "get_case_timeline", arguments: { id: caseId } }));
    expect(timeline.environment).toBe("Production");
  });

  it("is set up and worked by an agent through MCP, under its key's name", async () => {
    const made = await call("POST", `/app/workspaces/${workspace}/keys`, { name: "Builder", kind: "secret" });
    const mcp = `/app/workspaces/${workspace}/mcp`;
    expect((await call("PUT", mcp, { enabled: true, groups: ["read", "write", "decide", "build"] })).status).toBe(200);
    const agent = await mcpClient(app, made.body.secret);
    const tool = async (name: string, args: Record<string, unknown>) => {
      const result = await agent.callTool({ name, arguments: args });
      return { error: result.isError ? resultOf(result).error : null, body: resultOf(result) };
    };

    const tried = await tool("test_queue", { definition: queue() });
    expect(tried.error).toBeNull();
    expect(tried.body).toMatchObject({ tested: 0, matched: 0 });
    const created = await tool("create_queue", { definition: queue() });
    const id = created.body.id as string;
    expect(id).toMatch(/^que_/);
    const read = (await tool("get_queue", { id })).body;
    expect(read).toMatchObject({ id, name: "Onboarding review" });
    expect(Array.isArray((await tool("list_case_view_templates", {})).body.templates)).toBe(true);

    await decide({ user: "u1" });
    const caseId = (await casesOf(id)).cases[0].id;
    const me = (await call("GET", "/auth/me")).body.user.id as string;
    expect((await tool("assign_case", { id: caseId, assignee: me })).body).toMatchObject({
      status: "in_review",
      assignee: { id: me },
    });
    await tool("resolve_case", { id: caseId, category: "no_action" });
    expect((await tool("reopen_case", { id: caseId })).body.status).toBe("in_review");
    const actors = (await call("GET", `/v1/cases/${caseId}`)).body.activity
      .filter((a: any) => ["assigned", "reopened"].includes(a.type))
      .map((a: any) => a.actor);
    expect(actors).toEqual(["mcp:Builder", "mcp:Builder"]);

    // A queue with cases is kept: it can only be disabled.
    expect((await tool("delete_queue", { id })).error).toMatchObject({ type: "queue_has_cases" });
    const saved = await tool("save_queue", { id, definition: { ...queue(), enabled: false } });
    expect(saved.body).toMatchObject({ id, enabled: false });
    const empty = (await tool("create_queue", { definition: queue({ name: "Spare" }) })).body.id;
    expect((await tool("delete_queue", { id: empty })).error).toBeNull();
    expect((await call("GET", "/v1/queues")).body.queues.map((q: any) => q.id)).toEqual([id]);
  });

  it("labels the target of a case resolved as confirmed fraud", async () => {
    const id = await makeQueue();
    await decide({ user: "u1" });
    const caseId = (await casesOf(id)).cases[0].id;
    const resolved = await call("POST", `/v1/cases/${caseId}/resolve`, {
      category: "confirmed_fraud",
      label_target: true,
    });
    expect(resolved.body.labelled).toBe(true);
    const entity = (await call("GET", "/v1/entities/user/u1")).body;
    expect(entity.labels.map((l: any) => l.label)).toContain("fraud_confirmed");
  });

  it("assigns only a member of the workspace", async () => {
    const id = await makeQueue();
    await decide({ user: "u1" });
    const caseId = (await casesOf(id)).cases[0].id;
    expect((await call("POST", `/v1/cases/${caseId}/assign`, { assignee: "usr_nobody" })).status).toBe(400);
    const unassigned = await casesOf(id, "?assignee=none");
    expect(unassigned.total).toBe(1);
    expect((await call("POST", `/v1/cases/${caseId}/take`)).body.status).toBe("in_review");
    expect((await call("POST", `/v1/cases/${caseId}/assign`, { assignee: null })).body).toMatchObject({
      status: "open",
      assignee: null,
    });
  });

  it("shows an event before the decision it started, and marks what is an item", async () => {
    const id = await makeQueue();
    await call("POST", "/v1/events", {
      batch: [
        {
          id: "e_login",
          type: "login",
          ts: new Date(NOW.getTime() - 60_000).toISOString(),
          entities: { user: "u1" },
          properties: {},
        },
      ],
    });
    const started = await call("POST", "/v1/events/decide", {
      id: "e_signup",
      type: "signup",
      ts: NOW.toISOString(),
      entities: { user: "u1" },
      properties: { country: "GB" },
    });
    expect(started.status).toBe(200);
    await runner.drain();
    const caseId = (await casesOf(id)).cases[0].id;
    const { steps } = (await call("GET", `/v1/cases/${caseId}/timeline`)).body;
    expect(steps.map((s: any) => [s.kind, s.kind === "event" ? s.event.id : "decision", s.item])).toEqual([
      ["event", "e_login", false],
      ["event", "e_signup", true],
      ["decision", "decision", true],
    ]);
    const items = (await call("GET", `/v1/cases/${caseId}/timeline?items_only=true`)).body.steps;
    expect(items.every((s: any) => s.item)).toBe(true);
  });
});

describe("cases from workflows", () => {
  const save = (name: string, steps: unknown[]) =>
    call("PUT", `/v1/workflows/${name}`, { trigger: { type: "manual" }, steps });
  const start = async (name: string, input: unknown) => {
    const id = (await call("POST", `/v1/workflows/${name}/runs`, { input })).body.id as string;
    await runner.drain();
    await runner.drain();
    return (await call("GET", `/v1/workflow-runs/${id}`)).body;
  };

  it("makes a case with a case.create step, joined by the intake of the decision it made, and reads it", async () => {
    const id = await makeQueue();
    const saved = await save("screen", [
      { id: "check", name: "Check", type: "decide", action: "onboard_user", entities: { user: "{{ trigger.user }}" } },
      {
        id: "open",
        name: "Open a case",
        type: "case.create",
        queue: id,
        entity: { type: "user", id: "{{ trigger.user }}" },
        reason: "The outside check failed",
        priority: "high",
      },
      { id: "read", name: "Read it", type: "record.get", record: "case", record_id: "{{ steps.open.output.case_id }}" },
      {
        id: "find",
        name: "Find it",
        type: "record.search",
        record: "case",
        item_type: "user",
        item_id: "{{ trigger.user }}",
      },
    ]);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const run = await start("screen", { user: "u1" });
    expect(run.status, JSON.stringify(run)).toBe("done");
    const [, open, read, find] = run.steps;
    expect(open.output).toMatchObject({ created: true });
    expect(read.output).toMatchObject({
      id: open.output.case_id,
      priority: "high",
      reason: "The outside check failed",
    });
    expect(read.output.decisions.map((d: any) => d.id)).toEqual([run.steps[0].output.decision_id]);
    expect(find.output.map((c: any) => c.id)).toEqual([open.output.case_id]);
    // The intake of that decision runs after the step, and joins the same case: one key, one case.
    await runner.drain();
    const detail = (await call("GET", `/v1/cases/${open.output.case_id}`)).body;
    expect(detail.evidence.map((e: any) => e.source.type)).toEqual(["workflow", "decision"]);
    expect((await casesOf(id)).total).toBe(1);
  });

  it("resolves a case with a case.resolve step, and leaves one a person resolved first", async () => {
    const id = await makeQueue();
    await decide({ user: "u1" });
    const caseId = (await casesOf(id)).cases[0].id;
    await save("close", [
      {
        id: "close",
        name: "Close",
        type: "case.resolve",
        case_id: "{{ trigger.case }}",
        category: "false_positive",
        label_target: true,
      },
    ]);
    const run = await start("close", { case: caseId });
    expect(run.status, JSON.stringify(run)).toBe("done");
    expect(run.steps[0].output).toMatchObject({
      resolved: true,
      labelled: true,
      resolution: { category: "false_positive" },
    });
    const detail = (await call("GET", `/v1/cases/${caseId}`)).body;
    expect(detail.resolution.by).toBe("workflow:close@1");

    const again = await start("close", { case: caseId });
    expect(again.steps[0].output).toMatchObject({ resolved: false, resolution: { category: "false_positive" } });
  });

  it("refuses to write a case as a record, and fails a step whose queue is off", async () => {
    const refused = await save("bad", [
      { id: "make", name: "Make", type: "record.create", record: "case" },
      { id: "open", name: "Open", type: "case.create", queue: "que_x", entity: { type: "user", id: "u1" } },
    ]);
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toMatch(/a case is made by a case.create step/);
    expect(refused.body.error.message).toMatch(/open.reason/);

    const id = await makeQueue({ enabled: false });
    await save("off", [
      { id: "open", name: "Open", type: "case.create", queue: id, entity: { type: "user", id: "u1" }, reason: "Check" },
    ]);
    const run = await start("off", {});
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/is disabled/);
  });
});

describe("case management", () => {
  const HOUR = 3_600_000;
  const environmentOf = async () =>
    (await database.db.execute<{ environment_id: string }>(sql`SELECT environment_id FROM queues LIMIT 1`)).rows[0]!
      .environment_id;

  it("gives a case a due time from its priority, and counts and lists the overdue ones", async () => {
    const id = await makeQueue({ due_hours: { normal: 2 }, sort: "due" });
    await decide({ user: "u1" });
    const [opened] = (await casesOf(id)).cases;
    expect(opened.due_at).toBe(new Date(NOW.getTime() + 2 * HOUR).toISOString());
    expect((await casesOf(id, "?due=overdue")).total).toBe(0);
    clock = new Date(NOW.getTime() + 3 * HOUR);
    expect((await casesOf(id, "?due=overdue")).total).toBe(1);
    expect((await call("GET", `/v1/queues/${id}`)).body.counts).toMatchObject({ open: 1, overdue: 1 });
  });

  it("reopens a recently resolved case for a trigger with its key, when the queue says so", async () => {
    const id = await makeQueue({ correlation: { by: "subject", window_days: 30, reopen_days: 7 } });
    await decide({ user: "u1" });
    const caseId = (await casesOf(id)).cases[0].id;
    await call("POST", `/v1/cases/${caseId}/resolve`, { category: "no_action" });
    clock = new Date(NOW.getTime() + 2 * 86_400_000);
    await decide({ user: "u1" });
    const { cases, total } = await casesOf(id, "?status=all");
    expect(total).toBe(1);
    expect(cases[0]).toMatchObject({ id: caseId, status: "open", resolution: null, evidence_count: 2 });
    const types = (await call("GET", `/v1/cases/${caseId}`)).body.activity.map((a: any) => a.type);
    expect(types).toContain("reopened");
  });

  it("reopens a resolved case by hand, and refuses one that is not resolved", async () => {
    const id = await makeQueue();
    await decide({ user: "u1" });
    const caseId = (await casesOf(id)).cases[0].id;
    expect((await call("POST", `/v1/cases/${caseId}/reopen`)).status).toBe(409);
    await call("POST", `/v1/cases/${caseId}/resolve`, { category: "no_action" });
    expect((await call("POST", `/v1/cases/${caseId}/reopen`)).body).toMatchObject({ status: "open", resolution: null });
  });

  it("finds the resolved cases whose decisions are still open", async () => {
    const id = await makeQueue();
    await decide({ user: "u1" });
    await decide({ user: "u2" });
    const [first, second] = (await casesOf(id)).cases;
    await call("POST", `/v1/cases/${first.id}/resolve`, { category: "approved" });
    await call("POST", `/v1/cases/${second.id}/resolve`, { category: "approved", apply_to_decisions: true });
    const open = await casesOf(id, "?status=open_decisions");
    expect(open.cases.map((c: any) => c.id)).toEqual([first.id]);
    expect((await call("GET", `/v1/queues/${id}`)).body.counts.open_decisions).toBe(1);
  });

  it("assigns and resolves many cases at once, and says which could not change", async () => {
    const id = await makeQueue();
    await decide({ user: "u1" });
    await decide({ user: "u2" });
    const ids = (await casesOf(id)).cases.map((c: any) => c.id);
    const me = (await call("GET", "/auth/me")).body.user.id;
    const assigned = await call("POST", `/v1/queues/${id}/cases/bulk`, { ids, assign: me });
    expect(assigned.body.results.every((r: any) => r.ok)).toBe(true);
    expect((await casesOf(id, "?status=in_review")).total).toBe(2);
    expect((await call("GET", `/v1/queues/${id}`)).body.counts.mine).toBe(2);
    const resolved = await call("POST", `/v1/queues/${id}/cases/bulk`, {
      ids: [...ids, "case_nope"],
      resolve: { category: "false_positive" },
    });
    expect(resolved.body.results).toEqual([
      { id: ids[0], ok: true },
      { id: ids[1], ok: true },
      { id: "case_nope", ok: false, error: 'No case "case_nope" in this queue' },
    ]);
    expect((await casesOf(id, "?status=resolved")).total).toBe(2);
    expect((await call("GET", `/v1/queues/${id}`)).body.counts.mine).toBe(0);
  });

  it("tells a webhook when a case is created, assigned, resolved and reopened", async () => {
    const id = await makeQueue();
    await database.db.insert(webhooks).values({
      id: "wh_cases",
      workspaceId: workspace,
      environmentId: await environmentOf(),
      direction: "out",
      name: "Cases",
      url: "https://example.com/cases",
      secrets: [],
      config: {
        events: ["case.created", "case.assigned", "case.resolved", "case.reopened"],
        filter: { queues: [id] },
        include_properties: true,
        version: 1,
      },
      created: clock,
      updated: clock,
    });
    await decide({ user: "u1" });
    const caseId = (await casesOf(id)).cases[0].id;
    await call("POST", `/v1/cases/${caseId}/take`);
    await call("POST", `/v1/cases/${caseId}/resolve`, { category: "no_action" });
    await call("POST", `/v1/cases/${caseId}/reopen`);
    const sent = await database.db.select().from(webhookDeliveries);
    expect(sent.map((d) => d.type)).toEqual(["case.created", "case.assigned", "case.resolved", "case.reopened"]);
    expect((sent[1]!.payload as any).data).toMatchObject({
      case_id: caseId,
      queue_id: id,
      status: "in_review",
      assignee: { email: "owner@example.com" },
    });
  });
});

describe("case views", () => {
  const view = {
    header: ["case.priority", { field: "request.amount", label: "Amount", format: "money" }],
    blocks: [
      { id: "why", type: "evidence", region: "main" },
      {
        id: "money",
        type: "fields",
        region: "side",
        fields: ["decision.outcome", "signal.identity_mismatch", "subject.country", "item.device.os"],
      },
      { id: "user_facts", type: "facts", region: "side", facts: ["logins_7d", "first_seen"] },
      { id: "device_facts", type: "facts", region: "side", of: "item.device" },
      { id: "history", type: "list", region: "main", lists: ["logins"] },
    ],
    facts: [
      {
        for: "user",
        name: "logins_7d",
        label: "Logins this week",
        source: "events",
        measure: "count",
        filters: { event_type: "login" },
        window: "7d",
      },
    ],
    lists: [
      {
        for: "user",
        name: "logins",
        label: "Logins",
        source: "events",
        filters: { event_type: "login" },
        columns: ["ts", "event.country"],
      },
    ],
  };

  it("gives a queue's view with the values, facts and lists of its blocks", async () => {
    await call("PUT", "/v1/entity-types/user", {
      facts: [{ name: "first_seen", label: "First seen", source: "events", measure: "first" }],
    });
    await call("PUT", "/v1/entity-types/device", {
      facts: [{ name: "users", label: "Users", source: "events", measure: "unique", field: "user" }],
    });
    await call("PUT", "/v1/objects", {
      batch: [
        { type: "user", id: "u1", properties: { country: "GB" } },
        { type: "device", id: "d1", properties: { os: "iOS 18" } },
      ],
    });
    await call("POST", "/v1/events", {
      batch: [
        {
          id: "l1",
          type: "login",
          ts: new Date(NOW.getTime() - DAY).toISOString(),
          entities: { user: "u1", device: "d1" },
          properties: { country: "GB" },
        },
        {
          id: "l2",
          type: "login",
          ts: new Date(NOW.getTime() - 9 * DAY).toISOString(),
          entities: { user: "u1" },
          properties: { country: "FR" },
        },
        {
          id: "l3",
          type: "login",
          ts: new Date(NOW.getTime() - DAY).toISOString(),
          entities: { user: "u2", device: "d1" },
          properties: {},
        },
      ],
    });
    const id = await makeQueue({ display: { icon: "person", view } });
    answer = { hold: 0.7, reasons: { identity_mismatch: 0.93 } };
    await decide({ user: "u1", device: "d1" }, { amount: 1200 });
    const [made] = (await casesOf(id)).cases;
    const page = await call("GET", `/v1/cases/${made.id}/view`);
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    expect(page.body.custom).toBe(true);
    expect(page.body.header).toEqual([
      { field: "case.priority", label: "Priority", value: "normal" },
      { field: "request.amount", label: "Amount", format: "money", value: 1200 },
    ]);
    const block = (id: string) => page.body.blocks.find((b: any) => b.id === id);
    expect(block("money").values.map((v: any) => [v.label, v.value])).toEqual([
      ["Outcome", "review"],
      ["Identity mismatch signal", 0.93],
      ["Country", "GB"],
      ["Device os", "iOS 18"],
    ]);
    expect(block("user_facts").entities).toMatchObject([
      {
        type: "user",
        id: "u1",
        facts: [
          { name: "logins_7d", value: 1 },
          { name: "first_seen", value: new Date(NOW.getTime() - 9 * DAY).toISOString() },
        ],
      },
    ]);
    expect(block("device_facts").entities).toMatchObject([
      { type: "device", id: "d1", facts: [{ name: "users", value: 2 }] },
    ]);
    expect(block("history").entities).toEqual([
      { type: "user", id: "u1", name: null, lists: [{ name: "logins", label: "Logins" }] },
    ]);

    const list = await call("GET", `/v1/cases/${made.id}/view/lists/history?type=user&entity=u1&list=logins`);
    expect(list.body.rows.map((r: any) => [r.id, r.values["event.country"]])).toEqual([
      ["l1", "GB"],
      ["l2", "FR"],
    ]);
    expect((await call("GET", `/v1/cases/${made.id}/view/lists/history?type=user&entity=u2&list=logins`)).status).toBe(
      404,
    );
  });

  it("reads images through Kairos from approved hosts only, and records views and checks", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const server = createServer((req, res) => {
      if (req.url === "/id.png") return res.writeHead(200, { "Content-Type": "image/png" }).end(png);
      if (req.url === "/expired") return res.writeHead(403).end();
      res.writeHead(200, { "Content-Type": "text/html" }).end("<p>hi</p>");
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const base = `http://localhost:${(server.address() as AddressInfo).port}`;
    try {
      app = createApp({
        repos,
        accounts: tenancyRepository(database.db),
        environments: environmentsRepository(database.db),
        decider,
        now: () => clock,
        webhooks: { db: database.db, allowPrivate: true },
      });
      expect((await call("PUT", `/app/workspaces/${workspace}/media-hosts`, { hosts: ["https://x.com"] })).status).toBe(
        400,
      );
      expect(
        (await call("PUT", `/app/workspaces/${workspace}/media-hosts`, { hosts: ["Files.Example.com"] })).body,
      ).toEqual({
        hosts: ["files.example.com"],
      });
      // The test server is on localhost, which a person cannot approve.
      await database.db
        .update(workspaces)
        .set({ settings: { media_hosts: ["localhost"] } })
        .where(eq(workspaces.id, workspace));
      await call("PUT", "/v1/objects", {
        batch: [
          {
            type: "user",
            id: "u1",
            properties: {
              id_url: `${base}/id.png`,
              selfie_url: `${base}/expired`,
              page_url: `${base}/page`,
              other_url: "https://other.example.com/a.png",
              data_url: `data:image/png;base64,${png.toString("base64")}`,
              svg_url: `data:image/svg+xml;base64,${Buffer.from("<svg onload='alert(1)'/>").toString("base64")}`,
            },
          },
        ],
      });
      const id = await makeQueue({
        display: {
          view: {
            blocks: [
              { id: "why", type: "evidence", region: "main" },
              {
                id: "photos",
                type: "images",
                region: "side",
                title: "Identity",
                fields: [
                  "subject.id_url",
                  "subject.selfie_url",
                  "subject.page_url",
                  "subject.other_url",
                  "subject.none",
                  "subject.data_url",
                  "subject.svg_url",
                ],
              },
              { id: "files", type: "documents", region: "side", fields: ["subject.page_url"] },
              {
                id: "check",
                type: "checklist",
                region: "main",
                points: ["The ID matches the selfie", "The address matches"],
              },
            ],
          },
        },
      });
      await decide({ user: "u1" });
      const [made] = (await casesOf(id)).cases;
      const page = (await call("GET", `/v1/cases/${made.id}/view`)).body;
      expect(page.blocks.find((b: any) => b.id === "photos").media.map((m: any) => m.state)).toEqual([
        "ready",
        "ready",
        "ready",
        "host_not_approved",
        "missing",
        "ready",
        "ready",
      ]);
      const media = (index: number) =>
        app.request(`/v1/cases/${made.id}/view/media/photos/${index}`, {
          headers: { Cookie: cookie, "X-Kairos-Workspace": workspace },
        });
      const image = await media(0);
      expect([image.status, image.headers.get("content-type")]).toEqual([200, "image/png"]);
      expect(Buffer.from(await image.arrayBuffer())).toEqual(png);
      expect((await media(1)).status).toBe(410);
      expect((await media(2)).status).toBe(415);
      expect((await media(3)).status).toBe(403);
      const inline = await media(5);
      expect([inline.status, inline.headers.get("content-type")]).toEqual([200, "image/png"]);
      expect(Buffer.from(await inline.arrayBuffer())).toEqual(png);
      expect((await media(6)).status).toBe(415);
      const download = await app.request(`/v1/cases/${made.id}/view/media/files/0`, {
        headers: { Cookie: cookie, "X-Kairos-Workspace": workspace },
      });
      expect([download.status, download.headers.get("content-disposition")]).toEqual([200, "attachment"]);

      await call("POST", `/v1/cases/${made.id}/view/viewed`, { block: "photos" });
      const checked = await call("POST", `/v1/cases/${made.id}/checks`, { block: "check", point: 0, checked: true });
      expect(checked.body.checks).toMatchObject([
        { point: "The ID matches the selfie", checked: true, by: "owner@example.com" },
        { point: "The address matches", checked: false },
      ]);
      const activity = (await call("GET", `/v1/cases/${made.id}`)).body.activity.map((a: any) => [a.type, a.payload]);
      expect(activity).toContainEqual(["viewed", { block: "photos", title: "Identity" }]);
      expect(activity).toContainEqual([
        "checked",
        { block: "check", point: "The ID matches the selfie", checked: true },
      ]);
      expect(
        (await call("POST", `/v1/cases/${made.id}/checks`, { block: "check", point: 9, checked: true })).status,
      ).toBe(404);
    } finally {
      server.close();
    }
  });

  it("previews a case with a layout that is not saved, and saves nothing", async () => {
    await call("POST", "/v1/events", {
      batch: [
        {
          id: "p1",
          type: "login",
          ts: new Date(NOW.getTime() - DAY).toISOString(),
          entities: { user: "u1" },
          properties: { country: "GB" },
        },
      ],
    });
    const id = await makeQueue();
    await decide({ user: "u1" });
    const [made] = (await casesOf(id)).cases;
    const draft = {
      header: ["case.priority"],
      blocks: [
        { id: "why", type: "evidence", region: "main" },
        { id: "logins", type: "list", region: "main", lists: ["logins"] },
      ],
      lists: [
        {
          for: "user",
          name: "logins",
          label: "Logins",
          source: "events",
          filters: { event_type: "login" },
          columns: ["ts", "event.country"],
        },
      ],
    };
    const preview = await call("POST", `/v1/cases/${made.id}/view/preview`, { view: draft });
    expect(preview.body).toMatchObject({ custom: true, header: [{ field: "case.priority", value: "normal" }] });
    expect(preview.body.blocks.map((b: any) => b.id)).toEqual(["why", "logins"]);
    const rows = await call("POST", `/v1/cases/${made.id}/view/preview/lists/logins?type=user&entity=u1&list=logins`, {
      view: draft,
    });
    expect(rows.body.rows.map((r: any) => [r.id, r.values["event.country"]])).toEqual([["p1", "GB"]]);
    expect((await call("GET", `/v1/cases/${made.id}/view`)).body.custom).toBe(false);
    expect((await call("POST", `/v1/cases/${made.id}/view/preview`, { view: { blocks: [] } })).status).toBe(400);
  });

  it("loads the case view templates, each one valid", () => {
    const templates = loadViewTemplates(fileURLToPath(new URL("../../../templates", import.meta.url)));
    expect(templates.map((t) => t.name)).toEqual([
      "account_takeover",
      "business_onboarding",
      "lending",
      "onboarding_identity",
      "pre_transaction",
      "transaction_monitoring",
    ]);
  });

  it("gives the fixed page as a view when the queue has none, and refuses a view with no evidence", async () => {
    const id = await makeQueue();
    await decide({ user: "u1" });
    const [made] = (await casesOf(id)).cases;
    const page = (await call("GET", `/v1/cases/${made.id}/view`)).body;
    expect(page.custom).toBe(false);
    expect(page.blocks.map((b: any) => b.type)).toEqual([
      "evidence",
      "decisions",
      "list",
      "timeline",
      "facts",
      "details",
      "objects",
      "activity",
    ]);
    const wrong = await call(
      "POST",
      "/v1/queues",
      queue({ display: { view: { blocks: [{ id: "a", type: "text", region: "main", text: "Hi" }] } } }),
    );
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.message).toContain("display.view.blocks must have the evidence block");
  });
});

describe("the queue test", () => {
  it("says what a definition would do over past decisions, and makes nothing", async () => {
    await decide({ user: "u1" });
    await decide({ user: "u1" });
    answer = { hold: 0.1, reasons: {} };
    await decide({ user: "u2" });
    const tested = (await call("POST", "/v1/queues/test", queue())).body;
    expect(tested).toMatchObject({ tested: 3, matched: 2, cases: 1, skipped: 0 });
    expect(tested.samples[0]).toMatchObject({ subject: { id: "u2" }, matched: false });
    expect((await call("GET", "/v1/queues")).body.queues).toEqual([]);
  });
});
