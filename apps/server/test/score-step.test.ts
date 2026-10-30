import { readFileSync } from "node:fs";
import type { GraysonRequest, GraysonResponse } from "@kairos/core";
import { loadXgboost, featureRow } from "@kairos/core";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { createWorkflowRunner, modelProblems } from "../src/modules/workflows/libs";
import { createJobs } from "../src/platform/jobs/worker";
import { createRepositories, environmentsRepository, tenancyRepository } from "../src/repositories";
import { JobsService } from "../src/services/job.service";
import { testDatabase } from "./helpers/database";

const database = await testDatabase();
const repos = createRepositories(database.db);
let asked: GraysonRequest[] = [];
const HOLD = 0.34;
const decider = async (request: GraysonRequest): Promise<GraysonResponse> => {
  asked.push(request);
  const answers: GraysonResponse["answers"] = {};
  for (const key of Object.keys(request.questions))
    answers[key] =
      key === "hold"
        ? { type: "noul", value: false, probability: HOLD }
        : { type: "noul", value: true, probability: 0.82 };
  return { id: "dec", model: request.model, answers, usage: { input_tokens: 3 } };
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

/** Made by packages/core/test/fixtures/xgboost/make_fixtures.py. */
const fixture = JSON.parse(
  readFileSync(new URL("../../../packages/core/test/fixtures/xgboost/binary-3.0.2.json", import.meta.url), "utf8"),
) as { model: Record<string, unknown>; samples: unknown[] };
const xgb = loadXgboost(fixture.model).model!;
const FEATURES = ["hardship", "income_plausible", "grayson_hold", "amount", "dti", "country_gb"];

beforeEach(async () => {
  await database.reset({ key_a: "workspace_a", key_b: "workspace_b" });
  asked = [];
});

const call = async (method: string, path: string, body?: unknown, key = "key_a") => {
  const response = await app.request(path, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as any };
};
const uploadModel = (slug = "loan-default") =>
  call("POST", `/v1/models/${slug}/versions`, {
    name: "Loan default",
    format: "xgboost-json",
    model: fixture.model,
    samples: fixture.samples.slice(0, 100),
  });
const save = (name: string, steps: unknown[], trigger: unknown = { type: "manual" }) =>
  call("PUT", `/v1/workflows/${name}`, { trigger, steps });

const features = {
  hardship: "{{ steps.ask.output.hardship.probability }}",
  income_plausible: "{{ steps.ask.output.income_plausible.probability }}",
  grayson_hold: "{{ steps.assess.output.probability }}",
  amount: "{{ trigger.properties.amount }}",
  dti: "{{ trigger.properties.dti }}",
  country_gb: "{{ trigger.properties.country == 'GB' ? 1 : 0 }}",
};
const ask = {
  id: "ask",
  name: "Read the application",
  type: "ask",
  data: { purpose: "{{ trigger.properties.purpose }}" },
  questions: {
    hardship: { type: "yes_no", question: "Does the borrower describe current financial hardship?" },
    income_plausible: { type: "yes_no", question: "Is the stated income plausible for the job title?" },
  },
};
const assess = { id: "assess", name: "Ask Grayson", type: "assess" };
const score = { id: "xgb", name: "Score default risk", type: "score", model: "loan-default@1", features };
const answer = {
  id: "high",
  name: "High risk",
  type: "condition",
  when: "steps.xgb.output.score >= 0.5",
  then: [
    {
      id: "hold",
      name: "Hold",
      type: "return",
      value: { outcome: "review", probability: "{{ steps.xgb.output.score }}" },
    },
  ],
  else: [
    {
      id: "ok",
      name: "Approve",
      type: "return",
      value: { outcome: "approve", probability: "{{ steps.xgb.output.score }}" },
    },
  ],
};

describe("saving a score step", () => {
  beforeEach(async () => {
    expect((await uploadModel()).status).toBe(201);
  });

  it("needs a model and its features", async () => {
    const saved = await save("x", [{ id: "s", name: "S", type: "score" }]);
    expect(saved.status).toBe(400);
    expect(saved.body.error.message).toBe(
      'steps.s.model: a model\'s slug, or a slug and a version such as "loan-default@2"; steps.s.features: an object with a value or a template for each feature of the model',
    );
    const bad = await save("x", [{ id: "s", name: "S", type: "score", model: "loan-default", features: { a: [1] } }]);
    expect(bad.body.error.message).toContain("steps.s.features: a: a number, true or false, null, or a template");
  });

  it("refuses a model that is not there, a version that is not there, and a question model", async () => {
    const message = async (model: string) => (await save("x", [{ ...score, model }])).body.error.message as string;
    expect(await message("nothing")).toContain('steps.xgb.model: there is no model "nothing"');
    expect(await message("loan-default@9")).toContain(
      'steps.xgb.model: there is no version 9 of the model "loan-default"',
    );
    expect(await message("grayson-1")).toContain(
      'steps.xgb.model: "grayson-1" is a question model; a score step needs a scoring model',
    );
    const assessing = await save("x", [{ ...assess, action: "payout", model: "loan-default" }]);
    expect(assessing.body.error.message).toBe(
      'steps.assess.model: "loan-default" is a scoring model; this step needs a question model, such as grayson-1',
    );
  });

  it("needs exactly the model's features, read from steps that come before", async () => {
    const { dti: _dti, ...withoutDti } = features;
    const steps = [ask, assess, { ...score, features: { ...withoutDti, age: 40 } }, answer];
    const saved = await save("x", steps, { type: "decision", action: "payout" });
    expect(saved.body.error.message).toContain("steps.xgb.features: the model also needs dti");
    expect(saved.body.error.message).toContain("steps.xgb.features: the model has no feature age");

    const later = await save("x", [score, ask, assess, answer], { type: "decision", action: "payout" });
    expect(later.body.error.message).toContain(
      "steps.xgb.features.hardship: reads steps.ask, which does not run before this step",
    );
  });

  it("refuses an archived model", async () => {
    await call("POST", "/v1/models/loan-default/archive");
    const saved = await save("x", [score]);
    expect(saved.body.error.message).toContain('steps.xgb.model: the model "loan-default" is archived');
  });

  it("checks the models of a test run too", async () => {
    const tested = await call("POST", "/v1/workflows/test", {
      definition: { name: "x", trigger: { type: "manual" }, steps: [{ ...score, model: "nothing" }] },
    });
    expect(tested.status).toBe(400);
    expect(tested.body.error.message).toContain('there is no model "nothing"');
  });
});

describe("the checks of the models of a workflow", () => {
  const lookup = async (ref: string) =>
    ref === "m" ? { kind: "scoring" as const, features: ["a"] } : `there is no model "${ref}"`;

  it("accepts a feature read from a step in an earlier branch or a loop, and a condition before it", async () => {
    const steps = [
      { id: "c", type: "condition", then: [{ id: "inner", type: "http" }], else: [] },
      { id: "s", type: "score", model: "m", features: { a: "{{ steps.inner.output.body.x + steps.c.output.x }}" } },
    ];
    expect(await modelProblems(steps, lookup)).toEqual([]);
  });

  it("refuses a score step that reads itself", async () => {
    const steps = [{ id: "s", type: "score", model: "m", features: { a: "{{ steps.s.output.score }}" } }];
    expect(await modelProblems(steps, lookup)).toEqual([
      "steps.s.features.a: reads steps.s, which does not run before this step",
    ]);
  });

  it("finds the models of steps at any depth", async () => {
    const steps = [{ id: "l", type: "loop", steps: [{ id: "s", type: "score", model: "x", features: { a: 1 } }] }];
    expect(await modelProblems(steps, lookup)).toEqual(['steps.l.steps.s.model: there is no model "x"']);
  });
});

describe("a decision workflow with Grayson and XGBoost", () => {
  beforeEach(async () => {
    expect((await uploadModel()).status).toBe(201);
    await call("PUT", "/v1/actions/payout", { subject: "user", hold: "Should this loan be held?" });
    const saved = await save("loan_review", [ask, assess, score, answer], { type: "decision", action: "payout" });
    expect(saved.status).toBe(200);
  });
  const decide = (properties: Record<string, unknown>) =>
    call("POST", "/v1/decide", { action: "payout", entities: { user: "u1" }, properties });

  it("scores Grayson's answers with the model, and the score is the decision's probability", async () => {
    const made = await decide({ amount: 12000, dti: 31.4, country: "GB", purpose: "I lost my job" });
    expect(made.status).toBe(200);
    const expected = xgb.score(
      featureRow(FEATURES, {
        hardship: 0.82,
        income_plausible: 0.82,
        grayson_hold: HOLD,
        amount: 12000,
        dti: 31.4,
        country_gb: 1,
      }),
    );
    expect(made.body.probability).toBe(expected);
    expect(made.body.risk_score).toBe(Math.round(expected * 100));
    expect(made.body.decision).toBe(expected >= 0.5 ? "review" : "approve");

    const saved = (await call("GET", `/v1/decisions/${made.body.decision_id}`)).body;
    expect(saved.metadata.scores).toEqual([
      {
        step: "xgb",
        score: expected,
        risk_score: Math.round(expected * 100),
        model: "loan-default@1",
        features: {
          hardship: 0.82,
          income_plausible: 0.82,
          grayson_hold: HOLD,
          amount: 12000,
          dti: 31.4,
          country_gb: 1,
        },
        missing: [],
        invalid: [],
      },
    ]);
    expect(saved.raw.answers.hold.probability).toBe(HOLD);
    expect(asked.map((r) => r.model)).toEqual(["grayson-1", "grayson-1"]);
  });

  it("records the version that scored, when the step follows the latest version", async () => {
    const latest = { ...score, model: "loan-default" };
    expect(
      (await save("loan_review", [ask, assess, latest, answer], { type: "decision", action: "payout" })).status,
    ).toBe(200);
    const versionOf = async (decision: { body: { decision_id: string } }) =>
      (await call("GET", `/v1/decisions/${decision.body.decision_id}`)).body.metadata.scores[0].model;
    const first = await decide({ amount: 1000, purpose: "A car" });
    expect(await versionOf(first)).toBe("loan-default@1");

    const second = await call("POST", "/v1/models/loan-default/versions", {
      format: "xgboost-json",
      model: fixture.model,
      samples: fixture.samples.slice(0, 100),
      description: "Version 2",
    });
    expect(second.body.version).toBe(2);
    expect(await versionOf(await decide({ amount: 1000, purpose: "A car" }))).toBe("loan-default@2");
    expect(await versionOf(first)).toBe("loan-default@1");
  });

  it("scores a feature that is not there as missing, and says so", async () => {
    const made = await decide({ amount: "12000", country: "FR", purpose: "A car" });
    const saved = (await call("GET", `/v1/decisions/${made.body.decision_id}`)).body;
    const [scored] = saved.metadata.scores;
    expect(scored.features).toMatchObject({ amount: 12000, dti: null, country_gb: 0 });
    expect(scored.missing).toEqual(["dti"]);
    expect(made.body.probability).toBe(
      xgb.score(
        featureRow(FEATURES, {
          hardship: 0.82,
          income_plausible: 0.82,
          grayson_hold: HOLD,
          amount: 12000,
          country_gb: 0,
        }),
      ),
    );
  });

  it("fails the decision when the model's file is not there", async () => {
    // Another file, which no test here has scored: it is not in the cache.
    const other = JSON.parse(
      readFileSync(new URL("../../../packages/core/test/fixtures/xgboost/binary-2.1.4.json", import.meta.url), "utf8"),
    );
    const uploaded = await call("POST", "/v1/models/broken/versions", {
      name: "Broken",
      format: "xgboost-json",
      model: other.model,
      samples: other.samples.slice(0, 100),
    });
    await database.db.execute(
      sql`DELETE FROM model_artifacts WHERE sha256 = ${uploaded.body.model.definition.artifact.slice(7)}`,
    );
    await call("PUT", "/v1/actions/refund", { subject: "user", hold: "Should this refund be held?" });
    const constant = Object.fromEntries(FEATURES.map((f) => [f, 0.5]));
    await save(
      "refund_review",
      [
        { ...score, model: "broken@1", features: constant },
        { id: "ok", name: "Ok", type: "return", value: { outcome: "approve" } },
      ],
      { type: "decision", action: "refund" },
    );
    const failed = await call("POST", "/v1/decide", { action: "refund", entities: { user: "u1" } });
    expect(failed.status).toBe(502);
    expect(failed.body.error.type).toBe("workflow_failed");
    expect(failed.body.error.message).toContain("The file of broken@1 is not stored");
  });

  it("will not archive the model while the workflow uses it", async () => {
    const archived = await call("POST", "/v1/models/loan-default/archive");
    expect(archived.status).toBe(409);
    expect(archived.body.error.message).toBe(
      'The model "loan-default" is used by the published workflow "loan_review": change or archive it first',
    );
    await call("POST", "/v1/workflows/loan_review/archive");
    expect((await call("POST", "/v1/models/loan-default/archive")).status).toBe(200);
  });
});

describe("a score step in other runs", () => {
  beforeEach(async () => {
    expect((await uploadModel()).status).toBe(201);
  });

  it("scores in a test run, and uses a sample output when one is given", async () => {
    const steps = [{ ...score, features: { ...Object.fromEntries(FEATURES.map((f) => [f, 0.5])) } }];
    const definition = { name: "x", trigger: { type: "manual" }, steps };
    const testRun = async (body: Record<string, unknown>) => {
      const started = (await call("POST", "/v1/workflows/test", body)).body;
      await jobs.drain();
      return (await call("GET", `/v1/workflow-runs/${started.id}`)).body;
    };
    const real = await testRun({ definition });
    expect(real.status).toBe("done");
    expect(real.steps[0].output.score).toBe(xgb.score(Array(6).fill(0.5)));

    const mocked = await testRun({ definition, mock_outputs: { xgb: { score: 0.9 } } });
    expect(mocked.steps[0].output).toEqual({ score: 0.9 });
  });

  it("asks the question model that the step names", async () => {
    await save("asking", [{ ...ask, data: { purpose: "x" }, model: "grayson-1" }]);
    const started = (await call("POST", "/v1/workflows/asking/runs", { input: {}, wait: true })).body;
    expect(started.status).toBe("done");
    expect(asked.map((r) => r.model)).toEqual(["grayson-1"]);
  });
});
