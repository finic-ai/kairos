import { loadLogistic, logit } from "@kairos/core";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { runExperiment } from "../src/modules/experiments";
import { createRepositories, environmentsRepository, tenancyRepository } from "../src/repositories";
import { testDatabase } from "./helpers/database";

const NOW = new Date("2026-10-06T14:00:00Z");
const database = await testDatabase();
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  await database.reset({ key_a: "workspace_a", key_b: "workspace_b" });
  app = createApp({
    repos: createRepositories(database.db),
    environments: environmentsRepository(database.db),
    accounts: tenancyRepository(database.db),
    decider: async () => {
      throw new Error("no model call in these tests");
    },
    now: () => NOW,
  });
});

const call = async (method: string, path: string, body?: unknown, key = "key_a") => {
  const response = await app.request(path, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as any };
};

const scopeOf = async () => {
  const { rows } = await database.db.execute<{ workspace_id: string; environment_id: string }>(
    "SELECT workspace_id, environment_id FROM workflows LIMIT 1" as never,
  );
  return { workspaceId: rows[0]!.workspace_id, environmentId: rows[0]!.environment_id };
};

describe("a logistic model", () => {
  const stacker = {
    features: ["base", "hardship"],
    transforms: { base: "logit", hardship: "logit" },
    coefficients: [1.1, 0.6],
    intercept: -0.3,
    fill: { hardship: 0.5 },
  };
  const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

  it("scores the log-odds of its inputs, and fills a missing one", () => {
    const { model } = loadLogistic(stacker);
    expect(model!.score([0.2, NaN])).toBeCloseTo(sigmoid(-0.3 + 1.1 * logit(0.2) + 0.6 * logit(0.5)), 12);
  });

  it("refuses a file it cannot score", () => {
    expect(loadLogistic({ ...stacker, coefficients: [1] }).problems).toEqual([
      "coefficients must be a finite number for each feature",
    ]);
    expect(loadLogistic({ ...stacker, transforms: { base: "sqrt" } }).problems).toEqual([
      "transforms.base: identity or logit",
    ]);
  });
});

/** Loans as of past days: the default depends on the score and, more, on a "hardship" probability. */
async function history(count: number) {
  await call("PUT", "/v1/actions/loan", { subject: "applicant", hold: "Should this loan be held?" });
  await call("PUT", "/v1/workflows/loan_review", {
    trigger: { type: "decision", action: "loan" },
    steps: [{ id: "done", name: "Approve", type: "answer", value: { outcome: "approve" } }],
  });
  let seed = 11;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const labels: unknown[] = [];
  for (let i = 0; i < count; i++) {
    const ts = new Date(Date.parse("2025-01-01T00:00:00Z") + i * 3_600_000 * 20);
    const score = 580 + Math.floor(random() * 240);
    const hardship = random() < 0.25 ? 0.9 : 0.1;
    const z = -1.6 - 0.01 * (score - 700) + (hardship > 0.5 ? 1.8 : 0);
    const decided = await call("POST", "/v1/decide", {
      action: "loan",
      entities: { applicant: `a${i}` },
      properties: { credit_score: score, hardship, amount: 1000 + Math.floor(random() * 9000) },
      ts: ts.toISOString(),
    });
    expect(decided.status).toBe(200);
    if (random() < 1 / (1 + Math.exp(-z)))
      labels.push({
        entity: { type: "applicant", id: `a${i}` },
        label: "charged_off",
        ts: new Date(ts.getTime() + 30 * 86_400_000).toISOString(),
      });
  }
  for (let i = 0; i < labels.length; i += 400) await call("POST", "/v1/labels", { batch: labels.slice(i, i + 400) });
}

const experiment = {
  name: "Does hardship add to the score?",
  labels: ["charged_off"],
  window: "90d",
  features: {
    credit_score: "{{ trigger.properties.credit_score }}",
    amount: "{{ trigger.properties.amount }}",
    hardship: "{{ trigger.properties.hardship }}",
  },
  baseline: "score",
  variants: [
    { key: "score", name: "Trees on the score", model: { type: "gbdt", features: ["credit_score", "amount"] } },
    {
      key: "with-hardship",
      name: "Trees on the score and hardship",
      model: { type: "gbdt", features: ["credit_score", "amount", "hardship"], params: { rounds: 50 } },
    },
    {
      key: "stacked",
      name: "Hardship stacked on the trees",
      model: {
        type: "stacked",
        base: { type: "gbdt", features: ["credit_score", "amount"] },
        features: ["hardship"],
        transforms: { hardship: "logit" },
      },
    },
    { key: "hardship", name: "Hardship as it is", model: { type: "probability", feature: "hardship" } },
  ],
};

describe("an experiment", { timeout: 60_000 }, () => {
  it("refuses variants that read features it does not have", async () => {
    await history(0);
    const bad = await call("POST", "/v1/workflows/loan_review/experiments", {
      ...experiment,
      baseline: "x",
      variants: [{ key: "x", name: "X", model: { type: "gbdt", features: ["nope"] } }],
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toContain("not in features: nope");
  });

  it("trains, validates and tests each variant on the server, and applies the chosen one", async () => {
    await history(700);
    const made = await call("POST", "/v1/workflows/loan_review/experiments", { ...experiment, by: "mcp:Tester" });
    expect(made.status).toBe(202);
    expect(made.body).toMatchObject({ status: "queued", created_by: "mcp:Tester" });

    const everyWorkflow = await call("GET", "/v1/experiments");
    expect(everyWorkflow.body.experiments.map((e: any) => e.id)).toContain(made.body.id);
    await runExperiment(database.db, await scopeOf(), made.body.id, () => NOW);
    const done = (await call("GET", `/v1/workflow-experiments/${made.body.id}`)).body;
    expect(done.error).toBeNull();
    expect(done.status).toBe("done");
    // The newest runs are still in their window, so their outcome is not known yet.
    expect(done.dataset).toMatchObject({ baseline: "score", export: { outcome_unknown: 700 - done.dataset.rows } });
    expect(done.dataset.rows).toBeGreaterThan(600);
    const byKey = Object.fromEntries(done.results.map((r: any) => [r.key, r]));
    for (const r of done.results) expect(r.problems).toEqual([]);
    expect(byKey["with-hardship"].metrics.test.roc_auc).toBeGreaterThan(byKey.score.metrics.test.roc_auc);
    expect(byKey.stacked.metrics.gain.roc_auc).toBeGreaterThan(0);
    expect(byKey.score.metrics.gain).toBeNull();
    const tail = made.body.id
      .replace(/[^A-Za-z0-9]/g, "")
      .slice(-8)
      .toLowerCase();
    expect(byKey.stacked.models).toEqual({
      base: `loan-review-stacked-base-${tail}@1`,
      model: `loan-review-stacked-${tail}@1`,
    });
    expect(byKey.hardship.models).toEqual({});
    expect(["with-hardship", "stacked", "hardship"]).toContain(done.best);

    const steps = byKey.stacked.steps;
    expect(steps.map((s: any) => s.type)).toEqual(["score", "score", "condition"]);
    expect(steps[1].features.base).toBe("{{ steps.base_score.output.score }}");

    const applied = await call("POST", `/v1/workflow-experiments/${made.body.id}/apply`, {
      variant: "stacked",
      reason: "Best on the test rows, with a gain whose interval is above zero",
      publish: true,
      by: "mcp:Tester",
    });
    expect(applied.status).toBe(200);
    expect(applied.body.workflow.version).toBe(2);
    expect(applied.body.experiment.selected).toMatchObject({ variant: "stacked", by: "mcp:Tester" });

    const live = await call("POST", "/v1/decide", {
      action: "loan",
      entities: { applicant: "new" },
      properties: { credit_score: 600, hardship: 0.95, amount: 5000 },
    });
    expect(live.status).toBe(200);
    expect(["review", "block"]).toContain(live.body.decision);
  });

  it("never adds a version to a model that workflows already use", async () => {
    await history(700);
    const made = await call("POST", "/v1/workflows/loan_review/experiments", {
      ...experiment,
      model_prefix: "loan",
      variants: [{ key: "default", name: "Trees", model: { type: "gbdt", features: ["credit_score", "amount"] } }],
      baseline: "default",
    });
    await runExperiment(database.db, await scopeOf(), made.body.id, () => NOW);
    const done = (await call("GET", `/v1/workflow-experiments/${made.body.id}`)).body;
    expect(done.results[0].models.model).toMatch(/^loan-default-[a-z0-9]{8}@1$/);
    expect((await call("GET", "/v1/models/loan-default")).status).toBe(404);
  });

  it("applies a variant once, and only to the version it ran on", async () => {
    await history(700);
    const made = await call("POST", "/v1/workflows/loan_review/experiments", experiment);
    await runExperiment(database.db, await scopeOf(), made.body.id, () => NOW);
    // Someone publishes a new version after the experiment ran.
    await call("PUT", "/v1/workflows/loan_review", {
      trigger: { type: "decision", action: "loan" },
      steps: [{ id: "done", name: "Review", type: "answer", value: { outcome: "review" } }],
    });
    const stale = await call("POST", `/v1/workflow-experiments/${made.body.id}/apply`, {
      variant: "score",
      publish: true,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.message).toContain("ran on version 1");

    const again = await call("POST", "/v1/workflows/loan_review/experiments", experiment);
    await runExperiment(database.db, await scopeOf(), again.body.id, () => NOW);
    const first = await call("POST", `/v1/workflow-experiments/${again.body.id}/apply`, {
      variant: "score",
      publish: true,
    });
    expect(first.status).toBe(200);
    const second = await call("POST", `/v1/workflow-experiments/${again.body.id}/apply`, {
      variant: "stacked",
      publish: true,
    });
    expect(second.status).toBe(409);
    expect((await call("GET", "/v1/workflows/loan_review")).body.version).toBe(3);
  });

  it("runs once when its job is claimed twice, and waits queued for a retry after an error", async () => {
    await history(700);
    const made = await call("POST", "/v1/workflows/loan_review/experiments", experiment);
    const scope = await scopeOf();
    await Promise.all([1, 2].map(() => runExperiment(database.db, scope, made.body.id, () => NOW)));
    const done = (await call("GET", `/v1/workflow-experiments/${made.body.id}`)).body;
    expect(done.status).toBe("done");
    const { rows } = await database.db.execute<{ n: number }>(
      "SELECT count(*)::int AS n FROM models WHERE slug LIKE 'loan-review-score-%'" as never,
    );
    expect(rows[0]!.n).toBe(1);

    const broken = (await call("POST", "/v1/workflows/loan_review/experiments", experiment)).body.id;
    // The clock fails once, after the claim: an error that a retry can get past.
    let calls = 0;
    const flaky = () => {
      if (++calls === 3) throw new Error("the clock went away");
      return NOW;
    };
    await expect(runExperiment(database.db, scope, broken, flaky, { last: false })).rejects.toThrow(
      "the clock went away",
    );
    expect((await call("GET", `/v1/workflow-experiments/${broken}`)).body).toMatchObject({
      status: "queued",
      error: "the clock went away",
    });
    await runExperiment(database.db, scope, broken, () => NOW, { last: true });
    expect((await call("GET", `/v1/workflow-experiments/${broken}`)).body).toMatchObject({
      status: "done",
      error: null,
    });
  });

  it("measures PR-AUC the same whatever the order of rows with the same score", async () => {
    const { averagePrecision } = await import("../src/modules/experiments/libs");
    // One positive and one negative at the same score: the order in the data must not matter.
    expect(averagePrecision([1, 0, 0], [0.5, 0.5, 0.1])).toBeCloseTo(0.5, 12);
    expect(averagePrecision([0, 1, 0], [0.5, 0.5, 0.1])).toBeCloseTo(0.5, 12);
  });

  it("gives the same bootstrap interval as resampling the rows", async () => {
    const { bootstrapGain, rocAuc, rng } = await import("../src/modules/experiments/libs");
    const random = rng(3);
    const labels = Array.from({ length: 300 }, () => (random() < 0.3 ? 1 : 0));
    const a = labels.map((y) => Math.round((y * 0.3 + random()) * 20) / 20);
    const b = labels.map((y) => Math.round((y * 0.1 + random()) * 20) / 20);
    const draw = rng(7);
    const gains: number[] = [];
    for (let r = 0; r < 200; r++) {
      const k = labels.map(() => Math.floor(draw() * labels.length));
      gains.push(
        rocAuc(
          k.map((i) => labels[i]!),
          k.map((i) => a[i]!),
        )! -
          rocAuc(
            k.map((i) => labels[i]!),
            k.map((i) => b[i]!),
          )!,
      );
    }
    gains.sort((p, q) => p - q);
    const [low, high] = bootstrapGain(labels, a, b, 200, 7);
    expect(low).toBeCloseTo(gains[Math.floor(0.025 * 199)]!, 12);
    expect(high).toBeCloseTo(gains[Math.floor(0.975 * 199)]!, 12);
  });

  it("trains on the newest labeled runs when there are more than it takes", async () => {
    await history(700);
    const { collectTrainingRows } = await import("../src/modules/workflows");
    const body = { features: experiment.features, labels: experiment.labels, window: experiment.window };
    const all = await collectTrainingRows(database.db, await scopeOf(), "loan_review", body, NOW);
    const newest = await collectTrainingRows(
      database.db,
      await scopeOf(),
      "loan_review",
      { ...body, limit: 100, newest: true },
      NOW,
    );
    const latest = all.rows
      .map((r) => r.at.getTime())
      .sort((p, q) => q - p)
      .slice(0, 100);
    expect(newest.rows.map((r) => r.at.getTime()).sort((p, q) => q - p)).toEqual(latest);
  });

  it("writes the measured thresholds exactly", async () => {
    const { variantSteps } = await import("../src/modules/experiments/libs");
    const steps = variantSteps(
      [],
      { key: "t", name: "T", description: "", drop_steps: [], model: { type: "gbdt", features: ["a"] } },
      { a: "{{ trigger.properties.a }}" },
      { model: "m@1" },
      { review: 0.1234567891, block: 1 },
    );
    const condition = steps.at(-1) as any;
    expect(condition.when).toBe("steps.score.output.score >= 1.0");
    expect(condition.else[0].when).toBe("steps.score.output.score >= 0.1234567891");
  });

  it("replaces the score steps of a variant applied before", async () => {
    const { variantSteps } = await import("../src/modules/experiments/libs");
    const applied = [
      { id: "ask", name: "Read the order", type: "ask", questions: {} },
      { id: "score", name: "Score: Numbers and answers", type: "score", model: "old@1", features: {} },
      {
        id: "blocked",
        name: "Block when very risky",
        type: "condition",
        when: "steps.score.output.score >= 0.9",
        then: [{ id: "block", name: "Block", type: "answer", value: { outcome: "block" } }],
        else: [],
      },
    ];
    const steps = variantSteps(
      applied,
      {
        key: "t",
        name: "Numbers and answers",
        description: "",
        drop_steps: [],
        model: { type: "gbdt", features: ["a"] },
      },
      { a: "{{ trigger.properties.a }}" },
      { model: "new@1" },
      { review: 0.5, block: 0.9 },
    );
    expect(steps.map((s: any) => [s.id, s.type, s.model ?? null])).toEqual([
      ["ask", "ask", null],
      ["score", "score", "new@1"],
      ["blocked", "condition", null],
    ]);
  });

  it("flags a variant whose features read a step it removes", async () => {
    const { readsRemoved, removedSteps } = await import("../src/modules/experiments/libs");
    const base = [
      { id: "ask", type: "ask", questions: [] },
      { id: "rule", type: "condition", when: "true", then: [{ id: "stop", type: "answer", value: {} }] },
    ];
    const variant = {
      key: "v",
      name: "V",
      description: "",
      drop_steps: ["ask"],
      model: { type: "gbdt" as const, features: ["hardship", "score"] },
    };
    const removed = removedSteps(base, variant);
    expect(removed.sort()).toEqual(["ask", "rule", "stop"]);
    expect(
      readsRemoved(
        { hardship: "{{ steps.ask.output.answers.hardship.probability }}", score: "{{ trigger.properties.score }}" },
        ["hardship", "score"],
        removed,
      ),
    ).toEqual(["hardship"]);
  });

  it("fails with a reason when there are too few labeled runs", async () => {
    await history(50);
    const made = await call("POST", "/v1/workflows/loan_review/experiments", experiment);
    await runExperiment(database.db, await scopeOf(), made.body.id, () => NOW);
    const failed = (await call("GET", `/v1/workflow-experiments/${made.body.id}`)).body;
    expect(failed).toMatchObject({ status: "failed", error: "50 labeled runs: an experiment needs at least 100" });
    const apply = await call("POST", `/v1/workflow-experiments/${made.body.id}/apply`, { variant: "score" });
    expect(apply.status).toBe(400);
  });
});
