import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { createWorkflowRunner } from "../src/modules/workflows/libs";
import { createJobs } from "../src/platform/jobs/worker";
import { createRepositories, environmentsRepository, tenancyRepository } from "../src/repositories";
import { JobsService } from "../src/services/job.service";
import { testDatabase } from "./helpers/database";

const database = await testDatabase();
const repos = createRepositories(database.db);
const decider = async () => {
  throw new Error("no model call in these tests");
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

const call = async (method: string, path: string, body?: unknown) => {
  const response = await app.request(path, {
    method,
    headers: { Authorization: "Bearer key_a", "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as any };
};
const save = (name: string, steps: unknown[], trigger: unknown = { type: "manual" }) =>
  call("PUT", `/v1/workflows/${name}`, { trigger, steps });
const run = async (name: string, input: Record<string, unknown>) =>
  (await call("POST", `/v1/workflows/${name}/runs`, { input, wait: true })).body;

const payout = {
  inputs: [
    { name: "amount", type: "number", required: true },
    { name: "payee", type: "text" },
  ],
  rules: [
    {
      id: "blocked_payee",
      name: "Blocked payee",
      when: "inList(input.payee, 'blocked_payees')",
      outcome: "reject",
      response: { reason: "blocked_payee" },
    },
    { id: "large", name: "Large", when: "input.amount >= 5000", outcome: "reject", response: { reason: "large" } },
  ],
  default: { outcome: "approve" },
};

beforeEach(async () => {
  await database.reset({ key_a: "workspace_a" });
  await call("PUT", "/v1/lists/blocked_payees", { name: "Blocked payees" });
  await call("PUT", "/v1/rulesets/payout_rules/draft", { name: "Payout rules", definition: payout });
  await call("POST", "/v1/rulesets/payout_rules/publish");
});

describe("a ruleset step", () => {
  it("gives the ruleset's result as its output, with the input from the run", async () => {
    const saved = await save("check", [
      {
        id: "rules",
        name: "Payout rules",
        type: "ruleset",
        ruleset: "payout_rules@1",
        input: { amount: "{{ trigger.amount }}", payee: "{{ trigger.payee }}" },
      },
    ]);
    expect(saved.status).toBe(200);
    expect((await run("check", { amount: 9000, payee: "p1" })).output).toEqual({
      ruleset: "payout_rules@1",
      outcome: "reject",
      matched: true,
      rule: "large",
      response: { reason: "large" },
      terms: [],
      missing: [],
    });
    expect((await run("check", { amount: 10, payee: "p1" })).output).toMatchObject({ outcome: "approve", rule: null });
  });

  it("fails the run when the input is not what the ruleset needs", async () => {
    await save("check", [
      { id: "rules", name: "Payout rules", type: "ruleset", ruleset: "payout_rules", input: { amount: "a lot" } },
    ]);
    const done = await run("check", {});
    expect(done.status).toBe("failed");
    expect(done.error).toBe("Step 'Payout rules' failed: input.amount: must be a number");
  });

  it("is refused at save for a ruleset that is not there, or an input that it needs and is not given", async () => {
    const missing = await save("check", [{ id: "rules", name: "Rules", type: "ruleset", ruleset: "nope" }]);
    expect(missing.body.error.message).toBe('steps.rules.ruleset: there is no ruleset "nope"');
    const absent = await save("check", [
      { id: "rules", name: "Rules", type: "ruleset", ruleset: "payout_rules", input: { payee: "x" } },
    ]);
    expect(absent.body.error.message).toBe("steps.rules.input: the ruleset needs amount");
  });
});

describe("list steps", () => {
  it("add an item once, with the workflow that added it, and remove it", async () => {
    await save("block", [
      {
        id: "add",
        name: "Block the payee",
        type: "list.add",
        list: "blocked_payees",
        value: "{{ trigger.payee }}",
        note: "Chargeback on {{ trigger.user }}",
      },
    ]);
    expect((await run("block", { payee: "p9", user: "u1" })).output).toEqual({
      list: "blocked_payees",
      value: "p9",
      added: true,
    });
    expect((await run("block", { payee: "P9", user: "u2" })).output).toMatchObject({ added: false });
    const list = (await call("GET", "/v1/lists/blocked_payees")).body;
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ value: "P9", note: "Chargeback on u2", added_by: "workflow:block@1" });

    await save("unblock", [
      { id: "remove", name: "Unblock", type: "list.remove", list: "blocked_payees", value: "{{ trigger.payee }}" },
    ]);
    expect((await run("unblock", { payee: "p9" })).output).toEqual({
      list: "blocked_payees",
      value: "p9",
      removed: true,
    });
    expect((await call("GET", "/v1/lists/blocked_payees")).body.item_count).toBe(0);
  });

  it("change nothing in a test run, unless the step is live", async () => {
    const definition = {
      name: "block",
      trigger: { type: "manual" },
      steps: [{ id: "add", name: "Add", type: "list.add", list: "blocked_payees", value: "p1" }],
    };
    const started = await call("POST", "/v1/workflows/test", { definition, input: {} });
    await jobs.drain();
    const tested = (await call("GET", `/v1/workflow-runs/${started.body.id}`)).body;
    expect(tested.steps[0].output).toEqual({ test: true, would: { list: "blocked_payees", value: "p1" } });
    expect((await call("GET", "/v1/lists/blocked_payees")).body.item_count).toBe(0);
  });

  it("are refused at save for a list that is not there", async () => {
    const refused = await save("block", [{ id: "add", name: "Add", type: "list.add", list: "nope", value: "x" }]);
    expect(refused.body.error.message).toBe('steps: there is no list "nope"');
  });
});

describe("inList in a workflow", () => {
  it("reads a list in a condition, with the list's match", async () => {
    await call("POST", "/v1/lists/blocked_payees/items", { items: [{ value: "p1" }] });
    await save("gate", [
      { id: "known", name: "Not blocked", type: "filter", when: "!inList(trigger.payee, 'blocked_payees')" },
      { id: "done", name: "Done", type: "return", value: { ok: true } },
    ]);
    const filtered = await run("gate", { payee: "P1" });
    expect(filtered.status).toBe("filtered");
    expect(filtered.steps[0]).toMatchObject({
      output: { passed: false },
      terms: [{ list: "blocked_payees", item: "p1" }],
    });
    const passed = await run("gate", { payee: "p2" });
    expect(passed.output).toEqual({ ok: true });
    expect(passed.steps[0].terms).toBeUndefined();
  });

  it("records the items that a template's inList matched, once each", async () => {
    await call("POST", "/v1/lists/blocked_payees/items", { items: [{ value: "p1" }] });
    await save("tag", [
      {
        id: "done",
        name: "Done",
        type: "return",
        value: { tag: "{{ inList(trigger.payee, 'blocked_payees') ? 'blocked' : 'ok' }}" },
      },
    ]);
    const tagged = await run("tag", { payee: "p1" });
    expect(tagged.output).toEqual({ tag: "blocked" });
    expect(tagged.steps[0].terms).toEqual([{ list: "blocked_payees", item: "p1" }]);
  });

  it("reads a list in the trigger's condition", async () => {
    await call("POST", "/v1/lists/blocked_payees/items", { items: [{ value: "p1" }] });
    await save(
      "watch",
      [{ id: "done", name: "Done", type: "return", value: { payee: "{{ event.entities.payee }}" } }],
      {
        type: "event",
        event: "payout",
        when: "inList(event.entities.payee, 'blocked_payees')",
      },
    );
    const ts = new Date().toISOString();
    await call("POST", "/v1/events", {
      batch: [
        { id: "e1", type: "payout", ts, entities: { user: "u1", payee: "p1" } },
        { id: "e2", type: "payout", ts, entities: { user: "u1", payee: "p2" } },
      ],
    });
    await jobs.drain();
    const runs = (await call("GET", "/v1/workflows/watch/runs")).body.runs;
    expect(runs.map((r: any) => r.output)).toEqual([{ payee: "p1" }]);
    const started = (await call("GET", `/v1/workflow-runs/${runs[0].id}`)).body;
    expect(started.trigger_terms).toEqual([{ list: "blocked_payees", item: "p1" }]);
    expect(started.trigger.trigger_terms).toBeUndefined();
  });

  it("is refused at save for a list that is not there", async () => {
    const refused = await save("gate", [
      { id: "known", name: "Known", type: "filter", when: "inList(trigger.payee, 'nope')" },
    ]);
    expect(refused.body.error.message).toBe('steps: there is no list "nope"');
  });
});
