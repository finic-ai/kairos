import { readFileSync } from "node:fs";
import type { GraysonRequest, GraysonResponse } from "@kairos/core";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { createRepositories, environmentsRepository, tenancyRepository } from "../src/repositories";
import { testDatabase } from "./helpers/database";

const NOW = new Date("2026-10-28T12:00:00Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
const database = await testDatabase();
const app = createApp({
  repos: createRepositories(database.db),
  environments: environmentsRepository(database.db),
  accounts: tenancyRepository(database.db),
  decider: async (request: GraysonRequest): Promise<GraysonResponse> => {
    const answers: GraysonResponse["answers"] = {};
    for (const key of Object.keys(request.questions))
      answers[key] = { type: "noul", value: false, probability: key === "hold" ? 0.3 : 0.6 };
    return { id: "dec", model: request.model, answers, usage: { input_tokens: 1 } };
  },
  now: () => NOW,
});

const fixture = JSON.parse(
  readFileSync(new URL("../../../packages/core/test/fixtures/xgboost/binary-3.0.2.json", import.meta.url), "utf8"),
) as { model: Record<string, unknown>; samples: unknown[] };

const call = async (method: string, path: string, body?: unknown) => {
  const response = await app.request(path, {
    method,
    headers: { Authorization: "Bearer key_a", "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return response;
};
const json = async (method: string, path: string, body?: unknown) =>
  (await (await call(method, path, body)).json()) as any;

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
    income_plausible: { type: "yes_no", question: "Is the stated income plausible?" },
  },
};
const steps = [
  ask,
  { id: "assess", name: "Ask Grayson", type: "assess" },
  { id: "xgb", name: "Score", type: "score", model: "loan-default@1", features },
  {
    id: "ok",
    name: "Answer",
    type: "return",
    value: { outcome: "approve", probability: "{{ steps.xgb.output.score }}" },
  },
];

const exportRows = async (body: Record<string, unknown>) => {
  const response = await call("POST", "/v1/workflows/loan_review/training-data", body);
  const text = await response.text();
  const [header, ...lines] = text.trim().split("\n");
  return {
    status: response.status,
    text,
    header: header!.split(","),
    rows: lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [header!.split(",")[i]!, v]))),
    counts: Object.fromEntries(
      ["Rows", "Positives", "Already-Labeled", "Outcome-Unknown", "No-Subject"].map((h) => [
        h,
        Number(response.headers.get(`x-kairos-${h.toLowerCase()}`)),
      ]),
    ),
  };
};

beforeEach(async () => {
  await database.reset({ key_a: "workspace_a" });
  await json("POST", "/v1/models/loan-default/versions", {
    name: "Loan default",
    format: "xgboost-json",
    model: fixture.model,
    samples: fixture.samples.slice(0, 100),
  });
  await json("PUT", "/v1/actions/loan", { subject: "user", hold: "Should this loan be held?" });
  await json("PUT", "/v1/workflows/loan_review", { trigger: { type: "decision", action: "loan" }, steps });
});

const decide = (user: string, daysAgo: number, properties: Record<string, unknown> = {}) =>
  json("POST", "/v1/decide", {
    action: "loan",
    entities: { user },
    properties: { amount: 5000, dti: 20, country: "GB", purpose: "A car", ...properties },
    ts: ago(daysAgo),
  });
const label = (user: string, daysAgo: number, name = "charged_off") =>
  json("POST", "/v1/labels", { batch: [{ entity: { type: "user", id: user }, label: name, ts: ago(daysAgo) }] });

describe("the training export", () => {
  it("labels each run by what its subject got within the window after it", async () => {
    await decide("charged", 300);
    await label("charged", 290);
    await decide("repaid", 300);
    await decide("known", 300);
    await label("known", 310);
    await decide("late", 400);
    await label("late", 100);
    await decide("recent", 20);
    await decide("other_label", 300);
    await label("other_label", 290, "verified");

    const out = await exportRows({ features, labels: ["charged_off"], window: "180d" });
    expect(out.status).toBe(200);
    expect(out.header).toEqual(["run_id", "ts", "subject_type", "subject_id", "label", ...Object.keys(features)]);
    const byUser = Object.fromEntries(out.rows.map((r) => [r.subject_id, r.label]));
    expect(byUser).toEqual({ charged: "1", repaid: "0", late: "0", other_label: "0" });
    expect(out.counts).toEqual({
      Rows: 4,
      Positives: 1,
      "Already-Labeled": 1,
      "Outcome-Unknown": 1,
      "No-Subject": 0,
    });
    expect(out.rows.find((r) => r.subject_id === "charged")!.ts).toBe(ago(300));
  });

  it("gives the values that the score step gave for the same run", async () => {
    const made = await decide("u1", 300, { amount: "12000", dti: undefined, country: "FR" });
    const scored = (await json("GET", `/v1/decisions/${made.decision_id}`)).metadata.scores[0];
    const out = await exportRows({ features, labels: ["charged_off"], window: "180d" });
    const row = out.rows[0]!;
    for (const name of Object.keys(features))
      expect(row[name], name).toBe(scored.features[name] === null ? "" : String(scored.features[name]));
    expect(row.dti).toBe("");
  });

  it("takes a period and a limit", async () => {
    for (const [user, days] of [
      ["a", 400],
      ["b", 300],
      ["c", 250],
    ] as const)
      await decide(user, days);
    const period = await exportRows({ features, labels: ["x"], window: "30d", from: ago(350), to: ago(260) });
    expect(period.rows.map((r) => r.subject_id)).toEqual(["b"]);
    const limited = await exportRows({ features, labels: ["x"], window: "30d", limit: 2 });
    expect(limited.rows).toHaveLength(2);
  });

  it("needs a subject when the workflow makes no decisions", async () => {
    await json("PUT", "/v1/workflows/manual_review", {
      trigger: { type: "manual" },
      steps: [{ id: "wait", name: "Wait", type: "delay", for: "1h" }],
    });
    const response = await call("POST", "/v1/workflows/manual_review/training-data", {
      features: { a: 1 },
      labels: ["x"],
      window: "30d",
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toContain("subject: the entity each run is about");
  });

  it("refuses a body it cannot use", async () => {
    const bad = async (body: unknown) =>
      (await (await call("POST", "/v1/workflows/loan_review/training-data", body)).json()).error.message;
    expect(await bad({ features, labels: ["x"], window: "six months" })).toBe('window: a time such as "180d"');
    expect(await bad({ features: { a: "{{ 1 + }}" }, labels: ["x"], window: "30d" })).toMatch(/^features\.a: /);
    expect(await bad({ features, labels: [], window: "30d" })).toMatch(/^labels: /);
    expect(
      (await call("POST", "/v1/workflows/nothing/training-data", { features, labels: ["x"], window: "30d" })).status,
    ).toBe(404);
  });
});
