import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { readsOf, stepInput } from "../src/modules/workflows/libs";
import { createRepositories, environmentsRepository, tenancyRepository } from "../src/repositories";
import { testDatabase } from "./helpers/database";

const database = await testDatabase();
const app = createApp({
  repos: createRepositories(database.db),
  environments: environmentsRepository(database.db),
  accounts: tenancyRepository(database.db),
  decider: async (request) => ({
    id: "d",
    model: request.model,
    answers: Object.fromEntries(
      Object.keys(request.questions).map((key) => [key, { type: "noul" as const, value: false, probability: 0.2 }]),
    ),
    usage: { input_tokens: 1 },
  }),
  now: () => new Date(),
});

beforeEach(async () => {
  await database.reset({ key_a: "workspace_a" });
});

const json = async (method: string, path: string, body?: unknown) =>
  (await (
    await app.request(path, {
      method,
      headers: { Authorization: "Bearer key_a", "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  ).json()) as any;

describe("a step's input", () => {
  const vars = { trigger: { user: "u1", amount: 7200 }, steps: { xgb: { output: { score: 0.46 } } } };

  it("fills in the templates, and keeps a secret as its template", () => {
    const step = {
      id: "notify",
      name: "Notify",
      type: "http",
      method: "POST",
      headers: { Authorization: "Bearer {{ secrets.OPS_TOKEN }}" },
      body: { user: "{{ trigger.user }}", amount: "{{ trigger.amount }}" },
      retry: { attempts: 2 },
    };
    expect(stepInput(step, vars)).toEqual({
      method: "POST",
      headers: { Authorization: "Bearer {{ secrets.OPS_TOKEN }}" },
      body: { user: "u1", amount: 7200 },
    });
  });

  it("gives an expression with the value of each field it reads", () => {
    expect(readsOf("steps.xgb.output.score >= 0.6 && trigger.amount > 100 && trigger.country == 'GB'", vars)).toEqual({
      "steps.xgb.output.score": 0.46,
      "trigger.amount": 7200,
    });
    expect(
      stepInput({ id: "c", name: "C", type: "condition", when: "trigger.amount >= 5000", then: [] }, vars),
    ).toEqual({ when: "trigger.amount >= 5000", reads: { "trigger.amount": 7200 } });
  });

  it("is left out when it is too large", () => {
    const big = { id: "a", name: "A", type: "ask", data: { text: "x".repeat(40_000) } };
    expect(stepInput(big, vars)).toEqual({ truncated: true, bytes: expect.any(Number) });
  });
});

describe("the log of a decision run", () => {
  beforeEach(async () => {
    await json("PUT", "/v1/actions/payout", { subject: "user", hold: "Should this payout be held?" });
    await json("PUT", "/v1/workflows/payout_rules", {
      trigger: { type: "decision", action: "payout" },
      steps: [
        { id: "ask", name: "Ask", type: "assess" },
        {
          id: "big",
          name: "Large amount",
          type: "condition",
          when: "trigger.properties.amount >= 5000",
          then: [{ id: "hold", name: "Hold", type: "answer", value: { outcome: "review" } }],
          else: [{ id: "ok", name: "Approve", type: "answer", value: { outcome: "approve" } }],
        },
      ],
    });
  });

  it("logs a condition before its branch, with what it read", async () => {
    // As of a past moment, the run stops at its answer and never goes on.
    const made = await json("POST", "/v1/decide", {
      action: "payout",
      entities: { user: "u1" },
      properties: { amount: 7200 },
      ts: "2026-01-01T00:00:00Z",
    });
    const run = await json("GET", `/v1/workflow-runs/${made.workflow_run_id}`);
    expect(run.steps.map((s: { path: string }) => s.path)).toEqual(["ask", "big", "big.hold"]);
    const big = run.steps[1];
    expect(big.input).toEqual({
      when: "trigger.properties.amount >= 5000",
      reads: { "trigger.properties.amount": 7200 },
    });
    expect(big.output).toEqual({ branch: "then" });
    expect(run.steps[0].read.context.pending_action).toMatchObject({ amount: 7200 });
  });

  it("keeps what each model step read, beside its output", async () => {
    const login = (id: string, ts: string) => ({ id, type: "login", ts, entities: { user: "u1" }, properties: {} });
    await json("POST", "/v1/events", {
      batch: [login("before", "2025-12-01T00:00:00Z"), login("after", "2026-02-01T00:00:00Z")],
    });
    const questions = { odd: { type: "yes_no", question: "Is anything odd?" } };
    await json("PUT", "/v1/workflows/payout_rules", {
      trigger: { type: "decision", action: "payout" },
      steps: [
        {
          id: "about",
          name: "About the user",
          type: "ask",
          entity: { type: "user", id: "{{ trigger.entities.user }}" },
          questions,
        },
        {
          id: "data",
          name: "About the data",
          type: "ask",
          data: { amount: "{{ trigger.properties.amount }}" },
          questions,
        },
        { id: "ok", name: "Approve", type: "answer", value: { outcome: "approve" } },
      ],
    });
    const made = await json("POST", "/v1/decide", {
      action: "payout",
      entities: { user: "u1" },
      properties: { amount: 50 },
      ts: "2026-01-01T00:00:00Z",
    });
    const run = await json("GET", `/v1/workflow-runs/${made.workflow_run_id}`);
    const [about, data] = run.steps;
    expect(about.read.model).toBe("grayson-1");
    expect(about.read.questions).toEqual(questions);
    expect(about.read.context.recent_events.map((e: { ts: string }) => e.ts)).toEqual(["2025-12-01T00:00:00"]);
    expect(about.input).toEqual({ entity: { type: "user", id: "u1" }, questions });
    expect(data.read.context).toEqual({ data: { amount: 50 } });
    expect(about.output).not.toHaveProperty("context");
  });
});
